import { AddressBalance } from "@ergo-graphql/types";
import { first, isEmpty, NonMandatoryRegisters } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import { utf8 } from "@fleet-sdk/crypto";
import { parse } from "@fleet-sdk/serializer";
import type { AssetType as HergmesAssetType } from "@hergmes/sdk";
import BigNumber from "bignumber.js";
import { uniq } from "lodash-es";
import { defineStore } from "pinia";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AssetPriceRates, assetPricingService } from "../services/assetPricingService";
import { ERG_DECIMALS, ERG_TOKEN_ID } from "@/constants";
import { VERIFIED_ASSETS } from "@/maps/verifiedAssets";
import { buildBondContract, buildOrderContract } from "@/offchain/plugins";
import { graphQLService } from "@/services/graphqlService";
import { zcGraphqlEngine } from "@/services/zcApi";
import { AssetMetadata, AssetType } from "@/types";
import { decimalizeBigNumber, getNetworkType, toDict } from "@/utils";

export type StateTokenMetadata = { [tokenId: string]: AssetMetadata };

const CONTRACT_ADDRESSES = [
  ...VERIFIED_ASSETS.map((a) => buildOrderContract(a.tokenId, "on-close")),
  ...VERIFIED_ASSETS.map((a) => buildBondContract(a.tokenId))
].map((contract) => ErgoAddress.fromErgoTree(contract).encode(getNetworkType()));

function mapHergmesAssetType(type?: HergmesAssetType): AssetType | undefined {
  switch (type) {
    case "nft-picture":
      return AssetType.PictureArtwork;
    case "nft-audio":
      return AssetType.AudioArtwork;
    case "nft-video":
      return AssetType.VideoArtwork;
    case "membership-threshold-signature":
      return AssetType.ThresholdSignature;
    default:
      return undefined;
  }
}

export const useChainStore = defineStore("chain", () => {
  // private
  let _timer: number | undefined;
  let _tvlRequested = false;

  // private state
  const _loading = ref(true);
  const _height = ref<number>(0);
  const _priceRates = ref<AssetPriceRates>({});
  const _tvl = ref<AddressBalance[]>([]);

  const _metadata = ref<StateTokenMetadata>(
    toDict(VERIFIED_ASSETS, (a) => ({ [a.tokenId]: a.metadata }))
  );

  // computed
  const tokensMetadata = computed(() => _metadata.value);
  const priceRates = computed(() => _priceRates.value);
  const loading = computed(() => _loading.value);
  const height = computed(() => _height.value);
  const tvl = computed(() => {
    if (!_tvlRequested) {
      _tvlRequested = true;
      void loadTVL();
    }

    if (!_tvl.value || isEmpty(_tvl.value)) {
      return;
    }

    const rates = _priceRates.value;
    let acc = BigNumber(0);
    for (const balance of _tvl.value) {
      acc = acc.plus(decimalizeBigNumber(BigNumber(balance.nanoErgs), ERG_DECIMALS));
      for (const token of balance.assets) {
        const amount = decimalizeBigNumber(BigNumber(token.amount.toString()), token.decimals || 0);
        acc = acc.plus(amount.times(rates[token.tokenId]?.erg || 0));
      }
    }

    return acc.times(rates[ERG_TOKEN_ID].fiat);
  });

  function isHergmesLive(): boolean {
    const hc = zcGraphqlEngine.getHergmesClient();
    return hc !== null && hc.getStreamPhase() === "live";
  }

  function syncExternalHeight(nextHeight: number) {
    if (Number.isInteger(nextHeight) && nextHeight > 0 && _height.value !== nextHeight) {
      _height.value = nextHeight;
    }
  }

  // watchers
  watch(
    height,
    (newVal, oldVal) => {
      if (newVal > 0 && !oldVal && !isEmpty(_metadata.value)) {
        return;
      }

      loadPriceRates();
      if (_tvlRequested) {
        loadTVL();
      }
    },
    { immediate: true }
  );

  // hooks
  onMounted(async () => {
    const pricesStr = localStorage.getItem("prices");
    if (pricesStr) {
      _priceRates.value = JSON.parse(pricesStr);
    }

    // When Hergmes WS is active, let live tip events drive height instead of polling GraphQL.
    const hc = zcGraphqlEngine.getHergmesClient();
    const hergmesTip = hc?.getTip()?.height;
    if (hergmesTip && hergmesTip > 0) {
      _height.value = hergmesTip;
    } else if (zcGraphqlEngine.getTransport() !== "hergmes") {
      _height.value = (await graphQLService.getCurrentHeight()) || 0;
    }

    _timer = window.setInterval(async () => {
      const liveHc = zcGraphqlEngine.getHergmesClient();
      if (liveHc && liveHc.getStreamPhase() === "live") {
        const tipHeight = liveHc.getTip()?.height;
        if (tipHeight && tipHeight > 0 && _height.value !== tipHeight) {
          _height.value = tipHeight;
        }
        return;
      }

      const nextHeight = await graphQLService.getCurrentHeight();
      if (nextHeight && _height.value !== nextHeight) {
        _height.value = nextHeight;
      }
    }, 5000);
  });

  onBeforeUnmount(() => {
    if (_timer !== undefined) {
      window.clearInterval(_timer);
      _timer = undefined;
    }
  });

  // actions
  async function loadTokensMetadata(tokenIds: string[]) {
    const metadataTokenIds = Object.keys(_metadata.value);
    tokenIds = tokenIds.filter((id) => !metadataTokenIds.includes(id));

    if (isEmpty(tokenIds)) {
      return;
    }

    tokenIds = uniq(tokenIds);
    let remaining = tokenIds;

    // Fast path: 100-per-batch Hergmes REST token metadata when Hergmes is live
    if (isHergmesLive()) {
      const relay = zcGraphqlEngine.getHergmesClient()?.getRelay();
      if (relay) {
        try {
          const { items } = await relay.rest.tokens(tokenIds);
          const resolved = new Set<string>();
          for (const item of items) {
            const low = item.tokenId.toLowerCase();
            resolved.add(low);
            _metadata.value[low] = {
              name: item.name || undefined,
              decimals: item.decimals != null ? item.decimals : undefined,
              type: mapHergmesAssetType(item.type),
              url: item.artworkUrl || undefined
            };
          }
          remaining = tokenIds.filter((id) => !resolved.has(id.toLowerCase()));
        } catch {
          // Fall back to GraphQL metadata stream below
        }
      }
    }

    if (remaining.length > 0) {
      for await (const tokensMetadata of graphQLService.streamTokenMetadata(remaining)) {
        for (const metadata of tokensMetadata) {
          const registers = metadata.box.additionalRegisters as NonMandatoryRegisters;

          const parsedMetadata: AssetMetadata = {
            name: metadata?.name || undefined,
            decimals: metadata.decimals || undefined,
            type:
              registers?.R7 && registers.R7.startsWith("0e02") && registers.R7.length === 8
                ? (registers.R7?.substring(4) as AssetType)
                : undefined
          };

          if (parsedMetadata.type === AssetType.PictureArtwork && registers.R9) {
            let r9 = parse<Uint8Array | Uint8Array[]>(registers.R9, "safe");
            if (r9 instanceof Array) {
              r9 = first(r9);
            }

            if (r9) {
              parsedMetadata.url = utf8.encode(r9);
            }
          }

          _metadata.value[metadata.tokenId] = parsedMetadata;
        }
      }
    }

    if (_loading.value) {
      _loading.value = false;
    }
  }

  async function loadPriceRates() {
    const oracleFallback = zcGraphqlEngine.getOracleUsdPrice() ?? undefined;
    const tokens = await assetPricingService.getTokenRates(oracleFallback);
    _priceRates.value = tokens;

    localStorage.setItem("prices", JSON.stringify(tokens));
  }

  async function loadTVL() {
    _tvl.value = await graphQLService.getBalance(CONTRACT_ADDRESSES);
  }

  return {
    loadTokensMetadata,
    syncExternalHeight,
    tokensMetadata,
    priceRates,
    loading,
    height,
    tvl
  };
});
