import { first, isEmpty, some } from "@fleet-sdk/common";
import { parse } from "@fleet-sdk/serializer";
import BigNumber from "bignumber.js";
import { graphQLService } from "./graphqlService";
import {
  SPECTRUM_ERG_TOKEN_ID,
  SpectrumPool,
  SpectrumPoolStat,
  spectrumService
} from "./spectrumService";
import { ERG_TOKEN_ID } from "@/constants";
import { VERIFIED_ASSETS } from "@/maps/verifiedAssets";
import { get } from "@/utils/fetchUtils";

const _1 = BigNumber(1);
const MIN_USD_LIQUIDITY = 10_000;
const COINGECKO_BASE_URI = "https://api.coingecko.com/api/";
const ERG_FIAT_RATE_CACHE_KEY = "ergFiatRate";
const ERG_FIAT_RATE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

const HODLERG3_TOKEN_ID = "cbd75cfe1a4f37f9a22eaee516300e36ea82017073036f07a09c1d2e10277cda";
const HODLERG3_NFT_ID = "6e9c85c4be018b1308ddf034baf1406490e2a9dd406c01591bd6df41e98b6057";
const HODLERG_CONTRACT =
  "100a040204000402040004000502050005d00f04040e2002a195c991b685f1bbf6c84cb192f698ecccc3c707b7293c21d27655ade8d56ed812d601db6308a7d602b27201730000d6038c720202d604b2a5730100d605db63087204d606b27205730200d6078c720602d6089972037207d609c17204d60a7ec1a706d60be4c6a70505d60c7e720b06d60de4c6a70405d60e9d9c720a720c7e99720d720306d60fe4c6a70605d610e4c6a70705d611e4c6a70805d61296830401927209720f93c27204c2a79683030193b27205730300b27201730400938c7206018c72020192720773059683050193e4c672040405720d93e4c672040505720b93e4c672040605720f93e4c672040705721093e4c6720408057211959172087306d1968302017212927e7209069a720a9d9c7e720806720e720cd803d6139d9c7e997207720306720e720cd6147307d615b2a5730800d1968303017212937e7209069a99720a72139d9c72137e7211067e72140696830201937ec17215069d9c72137e7210067e72140693cbc272157309";

const VERIFIED_TOKEN_IDS = new Set(VERIFIED_ASSETS.map((x) => x.tokenId.toLowerCase()));

type AssetRate = { erg: number; fiat: number };
export type AssetPriceRates = {
  [tokenId: string]: AssetRate;
};

type CachedRate = { rate: number; timestamp: number };

function getCachedErgFiatRate(): number | undefined {
  try {
    const cached: CachedRate | null = JSON.parse(
      localStorage.getItem(ERG_FIAT_RATE_CACHE_KEY) || "null"
    );
    if (!cached || Date.now() - cached.timestamp > ERG_FIAT_RATE_MAX_AGE_MS) return;

    return cached.rate;
  } catch {
    return;
  }
}

function cacheErgFiatRate(rate: number) {
  const cached: CachedRate = { rate, timestamp: Date.now() };
  localStorage.setItem(ERG_FIAT_RATE_CACHE_KEY, JSON.stringify(cached));
}

async function getErgRateFromCoingGecko(): Promise<number | undefined> {
  try {
    const data = await get(new URL("v3/simple/price", COINGECKO_BASE_URI), {
      ids: "ergo",
      // eslint-disable-next-line @typescript-eslint/naming-convention
      vs_currencies: "usd"
    });

    const rate: number = data.ergo.usd;
    cacheErgFiatRate(rate);

    return rate;
  } catch {
    // CoinGecko's public API rate-limits and blocks browsers aggressively, and
    // these error responses carry no CORS headers. Let callers fall back.
    return;
  }
}

/**
 * Pure selector computing ERG-denominated token prices from Spectrum pools and pool TVL stats.
 *
 * Security properties:
 * 1. Requires `baseId === SPECTRUM_ERG_TOKEN_ID` for EVERY pool (including verified tokens).
 * 2. Requires finite positive `lastPrice > 0`.
 * 3. For non-verified tokens, requires the specific pool's TVL >= MIN_USD_LIQUIDITY.
 * 4. Selects the deepest pool per `quoteId` by highest TVL, breaking ties by highest `baseVolume`.
 */
export function selectSpectrumTokenRates(
  markets: readonly SpectrumPool[],
  stats: readonly SpectrumPoolStat[]
): Map<string, BigNumber> {
  const ergPoolTvl = new Map<string, number>();
  for (const s of stats) {
    if (s.lockedX?.id?.toLowerCase() !== SPECTRUM_ERG_TOKEN_ID) continue;
    const tvl = s.tvl?.value;
    if (typeof tvl === "number" && Number.isFinite(tvl) && tvl > 0) {
      ergPoolTvl.set(s.id, tvl);
    }
  }

  const best = new Map<string, { rate: BigNumber; tvl: number; volume: number }>();
  for (const p of markets) {
    if (p.baseId?.toLowerCase() !== SPECTRUM_ERG_TOKEN_ID) continue;
    if (typeof p.lastPrice !== "number" || !Number.isFinite(p.lastPrice) || p.lastPrice <= 0) {
      continue;
    }

    const quoteId = p.quoteId.toLowerCase();
    const isVerified = VERIFIED_TOKEN_IDS.has(quoteId);
    const tvl = ergPoolTvl.get(p.id) ?? 0;
    if (!isVerified && tvl < MIN_USD_LIQUIDITY) continue;

    const volume =
      typeof p.baseVolume?.value === "number" && Number.isFinite(p.baseVolume.value)
        ? p.baseVolume.value
        : 0;
    const prev = best.get(quoteId);
    if (!prev || tvl > prev.tvl || (tvl === prev.tvl && volume > prev.volume)) {
      best.set(quoteId, {
        rate: _1.div(p.lastPrice),
        tvl,
        volume
      });
    }
  }

  const map = new Map<string, BigNumber>();
  for (const [tokenId, entry] of best) {
    map.set(tokenId, entry.rate);
  }
  return map;
}

async function getTokenRatesFromSpectrum(): Promise<Map<string, BigNumber>> {
  const [markets, stats] = await Promise.all([
    spectrumService.getActivePools(),
    assetPricingService.getPoolsStats()
  ]);

  return selectSpectrumTokenRates(markets, stats);
}

async function getHodlErg3TokenRate(): Promise<BigNumber | undefined> {
  let boxes = await graphQLService.getBoxes({
    from: "blockchain",
    where: { ergoTrees: [HODLERG_CONTRACT] }
  });

  boxes = boxes.filter((b) => some(b.assets) && b.assets[0].tokenId === HODLERG3_NFT_ID);

  if (isEmpty(boxes)) {
    return;
  }

  const box = first(boxes);
  const token = box.assets[1];
  if (!token || !box.additionalRegisters.R4) {
    return;
  }

  const reserve = BigInt(box.value);
  const supply = parse<bigint>(box.additionalRegisters.R4);
  const tokens = BigInt(token.amount);
  const circ = supply - tokens;

  return BigNumber(String(reserve)).div(String(circ));
}

class AssetPricingService {
  #poolsStats?: SpectrumPoolStat[];
  #highLiquidityTokenIds?: Set<string>;

  public async getPoolsStats(): Promise<SpectrumPoolStat[]> {
    if (!this.#poolsStats) {
      this.#poolsStats = await spectrumService.getPoolsStats();
    }

    return this.#poolsStats;
  }

  public async getHighLiquidityTokenIds(): Promise<Set<string>> {
    if (!this.#highLiquidityTokenIds) {
      const stats = await this.getPoolsStats();

      this.#highLiquidityTokenIds = new Set(
        stats
          .filter(
            (x) =>
              x.lockedX.id.toLowerCase() === SPECTRUM_ERG_TOKEN_ID &&
              x.tvl.value >= MIN_USD_LIQUIDITY
          )
          .map((x) => x.lockedY.id.toLowerCase())
      );
    }

    return this.#highLiquidityTokenIds;
  }

  public async getTokenRates(fallbackErgFiatRate?: number): Promise<AssetPriceRates> {
    const [coingeckoRate, tokenRates, hodlergRate] = await Promise.all([
      getErgRateFromCoingGecko(),
      getTokenRatesFromSpectrum(),
      getHodlErg3TokenRate()
    ]);

    const oracleFallback =
      typeof fallbackErgFiatRate === "number" &&
      Number.isFinite(fallbackErgFiatRate) &&
      fallbackErgFiatRate > 0
        ? fallbackErgFiatRate
        : undefined;
    const ergFiatRate = coingeckoRate ?? oracleFallback ?? getCachedErgFiatRate() ?? 0;

    const map: AssetPriceRates = { [ERG_TOKEN_ID]: { erg: 1, fiat: ergFiatRate } };

    if (hodlergRate) {
      map[HODLERG3_TOKEN_ID] = {
        erg: hodlergRate.toNumber(),
        fiat: hodlergRate.times(ergFiatRate).toNumber()
      };
    }

    for (const [key, value] of tokenRates) {
      map[key] = {
        erg: value.toNumber(),
        fiat: value.times(ergFiatRate).toNumber()
      };
    }

    return map;
  }
}

export const assetPricingService = new AssetPricingService();
