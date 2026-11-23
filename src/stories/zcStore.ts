import { ErgoAddress } from "@fleet-sdk/core";
import { blake2b256, hex } from "@fleet-sdk/crypto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, reactive, ref, watch } from "vue";
import { useChainStore } from "./chainStore";
import { useWalletStore } from "./walletStore";
import { ERG_TOKEN_ID } from "@/constants";
import { VERIFIED_ASSETS } from "@/maps/verifiedAssets";
import { buildMockDataset, ZcDemoDataset } from "@/services/zc/mockData";
import {
  adaptPortfolio,
  getDefaultZcExplorerUrl,
  getDefaultZcGraphqlUrl,
  getZcBaseUrl,
  getZcDataSource,
  getZcExplorerUrl,
  getZcGraphqlUrl,
  resetZcEngine,
  setZcBaseUrl,
  setZcDataSource,
  setZcDemoProvider,
  setZcExplorerUrl,
  setZcGraphqlUrl,
  setZcWalletProvider,
  zcApi,
  ZcDataSource,
  ZcTokenMeta
} from "@/services/zcApi";
import {
  ZcAuctionLotSummary,
  ZcAuctionVaultSummary,
  ZcDurationUnit,
  ZcInfoResponse,
  ZcMarket,
  ZcMarketSnapshot,
  ZcPortfolioState,
  ZcWalletToken
} from "@/types/zc";
import {
  bestAskOverall,
  bestBidOverall,
  DEFAULT_COVER,
  fromRaw,
  isHex64,
  setChainNowAnchor,
  SIGUSD_TOKEN_ID
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
  const chain = useChainStore();

  const VERIFIED_MAP = new Map(VERIFIED_ASSETS.map((a) => [a.tokenId.toLowerCase(), a.metadata]));

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
  const explorerUrl = ref(getZcExplorerUrl());
  const defaultExplorerUrl = getDefaultZcExplorerUrl();
  const graphqlUrl = ref(getZcGraphqlUrl());
  const defaultGraphqlUrl = getDefaultZcGraphqlUrl();
  const baseUrl = ref(getZcBaseUrl());
  const searchQuery = ref("");
  const pendingSelect = ref<{ seq: number; type: "ask" | "bid"; id: string } | null>(null);
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

  const DEMO_STORAGE_KEY = "sigmafi.zc.demoMode";
  // Starts disabled while the UI Demo toggle is commented out; restore sessionStorage read when re-enabling
  const demoMode = ref<boolean>(false);

  const demoData = computed<ZcDemoDataset | null>(() =>
    demoMode.value ? buildMockDataset(height.value, oracle.price) : null
  );

  setZcDemoProvider(() => demoData.value);

  function setDemoMode(val: boolean) {
    demoMode.value = val;
    try {
      sessionStorage.setItem(DEMO_STORAGE_KEY, val ? "1" : "0");
    } catch {
      // ignore
    }
    if (val) {
      applyDemoData();
    } else {
      lots.value = [];
      vaults.value = [];
      void poll(true);
      void refreshPortfolio();
    }
  }

  function toggleDemoMode() {
    setDemoMode(!demoMode.value);
  }

  const portfolio = reactive<ZcPortfolioState>({
    loaded: false,
    loading: false,
    walletErg: 0,
    walletSigUsd: 0,
    walletTokens: [],
    positions: [],
    openOrders: [],
    openAsks: [],
    openOffers: [],
    openLots: [],
    mintRequests: [],
    wraps: [],
    attentionCount: 0
  });

  function applyDemoData() {
    const d = demoData.value;
    if (!d) return;
    lots.value = d.lots;
    vaults.value = d.vaults;
    portfolio.loaded = true;
    portfolio.loading = false;
    portfolio.walletErg = d.portfolio.walletErg;
    portfolio.walletSigUsd = d.portfolio.walletSigUsd;
    portfolio.walletTokens = d.portfolio.walletTokens;
    portfolio.positions = d.portfolio.positions;
    portfolio.openOrders = d.portfolio.openOrders;
    portfolio.openAsks = d.portfolio.openAsks;
    portfolio.openOffers = d.portfolio.openOffers;
    portfolio.openLots = d.portfolio.openLots;
    portfolio.mintRequests = d.portfolio.mintRequests;
    portfolio.wraps = d.portfolio.wraps;
    portfolio.attentionCount = d.portfolio.attentionCount;
  }

  async function refreshPortfolio() {
    if (demoMode.value) {
      applyDemoData();
      return;
    }
    if (!wallet.connected || !connected.value) {
      portfolio.loaded = false;
      portfolio.loading = false;
      portfolio.walletErg = 0;
      portfolio.walletSigUsd = 0;
      portfolio.walletTokens = [];
      portfolio.positions = [];
      portfolio.openOrders = [];
      portfolio.openAsks = [];
      portfolio.openOffers = [];
      portfolio.openLots = [];
      portfolio.mintRequests = [];
      portfolio.wraps = [];
      portfolio.attentionCount = 0;
      return;
    }
    portfolio.loading = true;
    try {
      const raw = await zcApi.getPortfolio();
      const tokenIds = new Set<string>();
      for (const asset of wallet.balance) {
        if (asset.tokenId !== ERG_TOKEN_ID && isHex64(asset.tokenId)) {
          tokenIds.add(asset.tokenId.toLowerCase());
        }
      }
      const tokenMap: Record<string, ZcTokenMeta> = {};
      if (tokenIds.size > 0) {
        try {
          Object.assign(tokenMap, await zcApi.lookupAssets(Array.from(tokenIds).slice(0, 50)));
        } catch {
          // fail-soft
        }
      }
      for (const asset of wallet.balance) {
        if (asset.tokenId === ERG_TOKEN_ID) continue;
        const low = asset.tokenId.toLowerCase();
        const meta = asset.metadata || VERIFIED_MAP.get(low);
        if (meta) {
          tokenMap[low] = {
            ...tokenMap[low],
            id: low,
            name: tokenMap[low]?.name || meta.name,
            ticker: tokenMap[low]?.ticker || meta.name,
            decimals: tokenMap[low]?.decimals ?? meta.decimals,
            verified: tokenMap[low]?.verified || VERIFIED_MAP.has(low)
          };
        }
      }

      const adapted = adaptPortfolio(raw, tokenMap);
      // Enrich wallet tokens with live Nautilus USD rates from chainStore when available
      const enrichedTokens: ZcWalletToken[] = adapted.walletTokens.map((t) => {
        const rate = chain.priceRates[t.id]?.fiat;
        const meta = chain.tokensMetadata[t.id] || VERIFIED_MAP.get(t.id);
        const decimals = t.kind === "receipt" ? 0 : meta?.decimals ?? t.decimals;
        const amount =
          t.kind === "receipt" ? t.amount : fromRaw(t.rawAmount, decimals) ?? t.amount;
        return {
          ...t,
          decimals,
          amount,
          ticker: t.ticker.endsWith("…") && meta?.name ? meta.name : t.ticker,
          name: t.name || meta?.name || null,
          usd: rate && rate > 0 ? rate : t.usd ?? null
        };
      });

      // Fallback SigUSD / ERG balance directly from Nautilus if engine hasn't hydrated yet
      const ergAsset = wallet.balance.find((x) => x.tokenId === ERG_TOKEN_ID);
      const sigAsset = wallet.balance.find((x) => x.tokenId.toLowerCase() === SIGUSD_TOKEN_ID);

      portfolio.walletErg = ergAsset ? Number(ergAsset.amount) / 1e9 : adapted.walletErg;
      portfolio.walletSigUsd = sigAsset ? Number(sigAsset.amount) / 100 : adapted.walletSigUsd;
      portfolio.walletTokens = enrichedTokens;
      portfolio.positions = adapted.positions;
      portfolio.openOrders = adapted.openOrders;
      portfolio.openAsks = adapted.openAsks;
      portfolio.openOffers = adapted.openOffers;
      portfolio.openLots = lots.value.filter(
        (l) => l.owner || adapted.openLotIds.includes(l.boxId)
      );
      portfolio.mintRequests = adapted.mintRequests;
      portfolio.wraps = adapted.wraps;
      portfolio.attentionCount = adapted.attentionCount;
      portfolio.loaded = true;
    } catch {
      // fail-soft
    } finally {
      portfolio.loading = false;
    }
  }

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

  function updateExplorerUrl(url: string) {
    setZcExplorerUrl(url);
    explorerUrl.value = getZcExplorerUrl();
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

  function requestSelect(type: "ask" | "bid", id: string) {
    pendingSelect.value = { seq: Date.now(), type, id };
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
          demoMode.value
            ? Promise.resolve({ lots: demoData.value?.lots || [], vaults: demoData.value?.vaults || [] })
            : zcApi.listAuctions().catch(() => ({ lots: [], vaults: [] }))
        ]);
        if (demoMode.value) {
          applyDemoData();
        } else {
          // Resolve auction item metadata for unknown tokens
          const auctionTokenIds = new Set<string>();
          for (const l of auctions.lots) {
            for (const it of l.items) if (isHex64(it.id)) auctionTokenIds.add(it.id);
          }
          for (const v of auctions.vaults) {
            for (const it of v.items) if (isHex64(it.id)) auctionTokenIds.add(it.id);
          }
          if (auctionTokenIds.size > 0) {
            try {
              const tMap = await zcApi.lookupAssets(Array.from(auctionTokenIds).slice(0, 50));
              if (Object.keys(tMap).length > 0) {
                const enriched = await zcApi.listAuctions(tMap);
                lots.value = enriched.lots;
                vaults.value = enriched.vaults;
              } else {
                lots.value = auctions.lots;
                vaults.value = auctions.vaults;
              }
            } catch {
              lots.value = auctions.lots;
              vaults.value = auctions.vaults;
            }
          } else {
            lots.value = auctions.lots;
            vaults.value = auctions.vaults;
          }
          if (wallet.connected) {
            void refreshPortfolio();
          }
        }

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
        dataSource.value === "explorer"
          ? "Ergo Explorer API unreachable"
          : dataSource.value === "graphql"
            ? "Ergo GraphQL unreachable"
            : "Lithos client unreachable";
      error.value = err instanceof Error ? err.message : fallbackMsg;
    } finally {
      inFlight = false;
    }
  }

  // Re-evaluate `mine` / `borrowedByMe` ownership flags & portfolio when Nautilus connects/disconnects.
  watch(
    [
      () => wallet.connected,
      () => wallet.changeAddress,
      () => wallet.usedAddresses.length,
      () => wallet.balance.length
    ],
    () => {
      if (connected.value && dataSource.value !== "lithos") {
        refreshSeq.value += 1;
        void Promise.all([fetchMarket("ERG"), fetchMarket("SigUSD")]).catch(() => undefined);
      }
      void refreshPortfolio();
    }
  );

  function start() {
    subscribers += 1;
    if (subscribers === 1) {
      if (demoMode.value) applyDemoData();
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
    explorerUrl,
    defaultExplorerUrl,
    graphqlUrl,
    defaultGraphqlUrl,
    baseUrl,
    searchQuery,
    pendingSelect,
    defaults,
    oracle,
    activeMarket,
    durationUnit,
    markets,
    activeSnapshot,
    lots,
    vaults,
    portfolio,
    demoMode,
    auctionsCount,
    totalOpenOffersUsd,
    totalOpenAsksUsd,
    totalLiquidityUsd,
    totalOrdersCount,
    setActiveMarket,
    setDurationUnit,
    setDemoMode,
    toggleDemoMode,
    updateDataSource,
    updateExplorerUrl,
    updateGraphqlUrl,
    updateBaseUrl,
    requestSelect,
    refreshPortfolio,
    refresh: () => poll(true),
    start,
    stop
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useZcStore, import.meta.hot));
}
