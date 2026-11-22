import { ErgoAddress } from "@fleet-sdk/core";
import { blake2b256, hex } from "@fleet-sdk/crypto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, reactive, ref, watch } from "vue";
import { useWalletStore } from "./walletStore";
import { ERG_TOKEN_ID } from "@/constants";
import {
  getDefaultZcGraphqlUrl,
  getZcBaseUrl,
  getZcDataSource,
  getZcGraphqlUrl,
  resetZcEngine,
  setZcBaseUrl,
  setZcDataSource,
  setZcGraphqlUrl,
  setZcWalletProvider,
  zcApi,
  ZcDataSource
} from "@/services/zcApi";
import {
  ZcAuctionLotSummary,
  ZcAuctionVaultSummary,
  ZcDurationUnit,
  ZcInfoResponse,
  ZcMarket,
  ZcMarketSnapshot
} from "@/types/zc";
import {
  bestAskOverall,
  bestBidOverall,
  DEFAULT_COVER,
  setChainNowAnchor
} from "@/utils/zcMath";

const MARKET_STORAGE_KEY = "sigmafi.zc.market";
const UNIT_STORAGE_KEY = "sigmafi.zc.unit";
const POLL_MS = 20_000;

const ADDRESS_HASH_CACHE = new Map<string, string>();

function hashAddress(base58: string): string | null {
  const cached = ADDRESS_HASH_CACHE.get(base58);
  if (cached) return cached;
  try {
    const treeHex = ErgoAddress.fromBase58(base58).ergoTree;
    const hashed = hex.encode(blake2b256(hex.decode(treeHex)));
    ADDRESS_HASH_CACHE.set(base58, hashed);
    return hashed;
  } catch {
    return null;
  }
}

function emptySnapshot(market: ZcMarket): ZcMarketSnapshot {
  return {
    market,
    curves: null,
    asks: [],
    offers: [],
    fills: [],
    weightedFillAprBps: null,
    bestBidBps: null,
    bestAskBps: null
  };
}

export const useZcStore = defineStore("zc", () => {
  const wallet = useWalletStore();

  const connected = ref(false);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const deployed = ref(false);
  const network = ref("mainnet");
  const profile = ref("zcs1");
  const height = ref(0);
  const revision = ref(0);
  const refreshSeq = ref(0);
  const dataSource = ref<ZcDataSource>(getZcDataSource());
  const graphqlUrl = ref(getZcGraphqlUrl());
  const defaultGraphqlUrl = getDefaultZcGraphqlUrl();
  const baseUrl = ref(getZcBaseUrl());
  const defaults = ref<Record<string, string | number>>({});

  // Wire Nautilus wallet addresses & balances into the client-side GraphQL ZC engine
  // so `mine`, `borrowedByMe`, and `getPortfolio()` reflect the connected wallet.
  setZcWalletProvider(() => {
    const hashes = new Set<string>();
    const addrs = [
      ...wallet.usedAddresses,
      ...(wallet.changeAddress ? [wallet.changeAddress] : [])
    ];
    for (const addr of addrs) {
      const h = hashAddress(addr);
      if (h) hashes.add(h);
    }

    let nanoErg = 0n;
    const tokens: { tokenId: string; amount: bigint }[] = [];
    for (const asset of wallet.balance) {
      if (asset.tokenId === ERG_TOKEN_ID) {
        nanoErg += asset.amount;
      } else if (asset.amount > 0n) {
        tokens.push({ tokenId: asset.tokenId.toLowerCase(), amount: asset.amount });
      }
    }

    return { hashes, nanoErg, tokens };
  });

  const oracle = reactive({
    price: 0,
    age: 0,
    updatedHeight: 0,
    refreshPending: false,
    missing: true
  });

  const savedMarket = (() => {
    try {
      const m = localStorage.getItem(MARKET_STORAGE_KEY);
      if (m === "ERG" || m === "SigUSD") return m;
    } catch {
      // ignore
    }
    return null;
  })();

  const userPickedMarket = ref(savedMarket !== null);
  const activeMarket = ref<ZcMarket>(savedMarket || "ERG");

  const durationUnit = ref<ZcDurationUnit>(
    (() => {
      try {
        return localStorage.getItem(UNIT_STORAGE_KEY) === "blocks" ? "blocks" : "days";
      } catch {
        return "days";
      }
    })()
  );

  const markets = reactive<Record<ZcMarket, ZcMarketSnapshot>>({
    ERG: emptySnapshot("ERG"),
    SigUSD: emptySnapshot("SigUSD")
  });

  const lots = ref<ZcAuctionLotSummary[]>([]);
  const vaults = ref<ZcAuctionVaultSummary[]>([]);

  let pollTimer: number | null = null;
  let inFlight = false;
  let subscribers = 0;

  const activeSnapshot = computed(() => markets[activeMarket.value]);
  const auctionsCount = computed(() => lots.value.length + vaults.value.length);

  const totalOpenOffersUsd = computed(() => {
    const usdCap = markets.SigUSD.curves?.totals.offers.capital ?? 0;
    const ergCap = markets.ERG.curves?.totals.offers.capital ?? 0;
    return usdCap + ergCap * oracle.price;
  });

  const totalOpenAsksUsd = computed(() => {
    const usdCost = markets.SigUSD.curves?.totals.asks.cost ?? 0;
    const ergCost = markets.ERG.curves?.totals.asks.cost ?? 0;
    return usdCost + ergCost * oracle.price;
  });

  const totalLiquidityUsd = computed(() => totalOpenOffersUsd.value + totalOpenAsksUsd.value);

  const totalOrdersCount = computed(() => {
    const e = markets.ERG.curves?.totals;
    const s = markets.SigUSD.curves?.totals;
    return (
      (e?.offers.count ?? 0) +
      (e?.asks.count ?? 0) +
      (s?.offers.count ?? 0) +
      (s?.asks.count ?? 0)
    );
  });

  function setActiveMarket(m: ZcMarket) {
    activeMarket.value = m;
    userPickedMarket.value = true;
    try {
      localStorage.setItem(MARKET_STORAGE_KEY, m);
    } catch {
      // ignore
    }
  }

  function setDurationUnit(u: ZcDurationUnit) {
    durationUnit.value = u;
    try {
      localStorage.setItem(UNIT_STORAGE_KEY, u);
    } catch {
      // ignore
    }
  }

  function updateDataSource(source: ZcDataSource) {
    setZcDataSource(source);
    dataSource.value = getZcDataSource();
    resetZcEngine();
    revision.value = 0;
    void poll(true);
  }

  function updateGraphqlUrl(url: string) {
    setZcGraphqlUrl(url);
    graphqlUrl.value = getZcGraphqlUrl();
    revision.value = 0;
    void poll(true);
  }

  function updateBaseUrl(url: string) {
    setZcBaseUrl(url);
    baseUrl.value = getZcBaseUrl();
    revision.value = 0;
    void poll(true);
  }

  async function fetchMarket(market: ZcMarket) {
    const covBps = DEFAULT_COVER * 100;
    const fromHeight = height.value > 0 ? Math.max(0, height.value - 5040) : 0;

    const [curves, asks, offers, fills] = await Promise.all([
      zcApi.getCurves(market, {
        coverage: covBps,
        kind: "all",
        matchable: !oracle.refreshPending,
        grid: false
      }),
      zcApi.listAsks(market, {
        coverage: covBps,
        matchable: !oracle.refreshPending,
        sort: "apr",
        limit: 40
      }),
      zcApi.listOffers(market, {
        coverage: covBps,
        matchable: !oracle.refreshPending,
        sort: "apr",
        limit: 40
      }),
      zcApi.listFills(market, { fromHeight, limit: 100 }).catch(() => [])
    ]);

    let weightedFillAprBps: number | null = null;
    if (fills.length > 0) {
      const vol = fills.reduce((acc, f) => acc + f.cost, 0);
      if (vol > 0) {
        weightedFillAprBps = fills.reduce((acc, f) => acc + f.cost * f.yieldBps, 0) / vol;
      }
    }

    markets[market] = {
      market,
      curves,
      asks,
      offers,
      fills,
      weightedFillAprBps,
      bestBidBps: bestBidOverall(curves),
      bestAskBps: bestAskOverall(curves)
    };
  }

  async function poll(force = false) {
    if (inFlight) return;
    inFlight = true;
    try {
      const ifRev = !force && connected.value && revision.value > 0 ? revision.value : undefined;
      const res = await zcApi.getInfo(ifRev);
      if ("notModified" in res && res.notModified) {
        return;
      }

      const info = res as ZcInfoResponse;
      const prevRev = revision.value;

      connected.value = true;
      loading.value = false;
      error.value = null;
      deployed.value = !!info.deployed;
      network.value = info.network || "mainnet";
      profile.value = info.profile || "zcs1";
      height.value = info.at?.height ?? 0;
      revision.value = info.at?.revision ?? 0;
      if (info.defaults) defaults.value = info.defaults;
      setChainNowAnchor(height.value);
      if (force) refreshSeq.value += 1;

      if (info.oracle) {
        oracle.price = Number(info.oracle.usdPerErg) || 0;
        oracle.age = info.oracle.age ?? 0;
        oracle.updatedHeight = info.oracle.updatedHeight ?? 0;
        oracle.refreshPending = !!info.oracle.refreshPending;
        oracle.missing = false;
      } else {
        oracle.price = 0;
        oracle.age = 0;
        oracle.updatedHeight = 0;
        oracle.refreshPending = false;
        oracle.missing = true;
      }

      if (force || revision.value !== prevRev || !markets.ERG.curves) {
        const [, , auctions] = await Promise.all([
          fetchMarket("ERG"),
          fetchMarket("SigUSD"),
          zcApi.listAuctions().catch(() => ({ lots: [], vaults: [] }))
        ]);
        lots.value = auctions.lots;
        vaults.value = auctions.vaults;

        // If the user hasn't chosen a market yet, highlight whichever market has live activity.
        if (!userPickedMarket.value) {
          const sigCount =
            (markets.SigUSD.curves?.totals.offers.count ?? 0) +
            (markets.SigUSD.curves?.totals.asks.count ?? 0);
          const ergCount =
            (markets.ERG.curves?.totals.offers.count ?? 0) +
            (markets.ERG.curves?.totals.asks.count ?? 0);
          if (sigCount > 0 && ergCount === 0) activeMarket.value = "SigUSD";
          else if (ergCount > 0) activeMarket.value = "ERG";
        }
      }
    } catch (err) {
      connected.value = false;
      loading.value = false;
      const fallbackMsg =
        dataSource.value === "graphql" ? "Ergo GraphQL unreachable" : "Lithos client unreachable";
      error.value = err instanceof Error ? err.message : fallbackMsg;
    } finally {
      inFlight = false;
    }
  }

  // Re-evaluate `mine` / `borrowedByMe` ownership flags when Nautilus connects/disconnects.
  watch(
    [() => wallet.connected, () => wallet.changeAddress, () => wallet.usedAddresses.length],
    () => {
      if (connected.value && dataSource.value === "graphql") {
        refreshSeq.value += 1;
        void Promise.all([fetchMarket("ERG"), fetchMarket("SigUSD")]).catch(() => undefined);
      }
    }
  );

  function start() {
    subscribers += 1;
    if (subscribers === 1) {
      void poll(false);
      pollTimer = window.setInterval(() => {
        void poll(false);
      }, POLL_MS);
    }
  }

  function stop() {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0 && pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    connected,
    loading,
    error,
    deployed,
    network,
    profile,
    height,
    revision,
    refreshSeq,
    dataSource,
    graphqlUrl,
    defaultGraphqlUrl,
    baseUrl,
    defaults,
    oracle,
    activeMarket,
    durationUnit,
    markets,
    activeSnapshot,
    lots,
    vaults,
    auctionsCount,
    totalOpenOffersUsd,
    totalOpenAsksUsd,
    totalLiquidityUsd,
    totalOrdersCount,
    setActiveMarket,
    setDurationUnit,
    updateDataSource,
    updateGraphqlUrl,
    updateBaseUrl,
    refresh: () => poll(true),
    start,
    stop
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useZcStore, import.meta.hot));
}
