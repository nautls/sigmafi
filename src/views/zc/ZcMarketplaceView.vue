<script setup lang="ts">
import {
  ArrowRightIcon,
  LayersIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import ExecutionPreviewModal, { ExecutionPreviewPayload } from "./components/ExecutionPreviewModal.vue";
import MarketAskCard from "./components/MarketAskCard.vue";
import MarketOfferCard from "./components/MarketOfferCard.vue";
import MarketQuickFillModal from "./components/MarketQuickFillModal.vue";
import MarketSimpleSidebar, { SimpleSidebarPrefill } from "./components/MarketSimpleSidebar.vue";
import ZcSelect, { ZcSelectOption } from "./components/ZcSelect.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { zcApi, ZcTokenMeta } from "@/services/zcApi";
import { useZcStore } from "@/stories";
import {
  ZcAskSummary,
  ZcOfferSummary,
  ZcSortKey,
  ZcSourceKind
} from "@/types/zc";
import { shortenString } from "@/utils";
import {
  dateAtHeight,
  DAY_BLOCKS,
  formatApr,
  formatCompact,
  formatDur,
  formatMarketAmount,
  formatNumber,
  isHex64,
  isOracleRefreshingOnly,
  kindLabel,
  MIN_MATURITY_BLOCKS,
  offerYieldAt,
  pricingName,
  resolvedAskQuote
} from "@/utils/zcMath";

type ListingTab = "borrows" | "offers";
type AskBoardSort = ZcSortKey | "cover" | "newest";

const route = useRoute();
const zc = useZcStore();

const listingTab = ref<ListingTab>(route.query.tab === "offers" ? "offers" : "borrows");

watch(
  () => route.query.tab,
  (t) => {
    if (t === "offers" || t === "borrows") listingTab.value = t;
  }
);

// ── Filters for Borrows & Resales ────────────────────────────────────────────
const askKind = ref<ZcSourceKind>("all");
const askMinCover = ref<number>(0);
const askMaxDays = ref<number>(0);
const askSort = ref<AskBoardSort>("apr");
const askTradableOnly = ref<boolean>(true);
const askGridOnly = ref<boolean>(false);

// ── Filters for Lend Offers ──────────────────────────────────────────────────
const offerMaxFloor = ref<number>(0);
const offerTargetDays = ref<number>(0);
const offerSort = ref<ZcSortKey>("apr");
const offerActiveOnly = ref<boolean>(true);
const offerSharesOnly = ref<boolean>(false);

const ASK_COVER_OPTIONS: readonly ZcSelectOption[] = [
  { value: 0, label: "Any cover", shortLabel: "Any cover" },
  { value: 125, label: "≥ 125% cover", shortLabel: "≥ 125%" },
  { value: 150, label: "≥ 150% cover", shortLabel: "≥ 150%" },
  { value: 175, label: "≥ 175% cover", shortLabel: "≥ 175%" },
  { value: 200, label: "≥ 200% cover", shortLabel: "≥ 200%" },
  { value: 250, label: "≥ 250% cover", shortLabel: "≥ 250%" }
];

const OFFER_FLOOR_OPTIONS: readonly ZcSelectOption[] = [
  { value: 0, label: "Any cover floor", shortLabel: "Any floor" },
  { value: 125, label: "Floor ≤ 125%", shortLabel: "≤ 125%" },
  { value: 150, label: "Floor ≤ 150%", shortLabel: "≤ 150%" },
  { value: 175, label: "Floor ≤ 175%", shortLabel: "≤ 175%" },
  { value: 200, label: "Floor ≤ 200%", shortLabel: "≤ 200%" },
  { value: 250, label: "Floor ≤ 250%", shortLabel: "≤ 250%" }
];

const ASK_SORT_OPTIONS: readonly ZcSelectOption[] = [
  { value: "apr", label: "Highest APR", shortLabel: "Top APR" },
  { value: "maturity", label: "Soonest maturity", shortLabel: "Soonest" },
  { value: "size", label: "Largest size", shortLabel: "Size" },
  { value: "cover", label: "Highest cover", shortLabel: "Cover" },
  { value: "newest", label: "Newest first", shortLabel: "Newest" }
];

const OFFER_SORT_OPTIONS: readonly ZcSelectOption[] = [
  { value: "apr", label: "Lowest APR", shortLabel: "Best APR" },
  { value: "size", label: "Largest capital", shortLabel: "Capital" },
  { value: "maturity", label: "Shortest min term", shortLabel: "Min term" }
];

const TENOR_CHOICES = [0, 7, 30, 60, 90, 180, 365] as const;

const askMaturityOptions = computed<ZcSelectOption[]>(() =>
  TENOR_CHOICES.map((d) => ({
    value: d,
    label: d === 0 ? "Any maturity" : `≤ ${formatDur(d * DAY_BLOCKS, zc.durationUnit)}`,
    shortLabel: d === 0 ? "Any term" : `≤ ${formatDur(d * DAY_BLOCKS, zc.durationUnit)}`
  }))
);

const offerMaturityOptions = computed<ZcSelectOption[]>(() =>
  TENOR_CHOICES.map((d) => ({
    value: d,
    label: d === 0 ? "Any maturity" : `Covers ${formatDur(d * DAY_BLOCKS, zc.durationUnit)}`,
    shortLabel: d === 0 ? "Any term" : formatDur(d * DAY_BLOCKS, zc.durationUnit)
  }))
);

const ASK_SOURCE_PILLS: readonly { value: ZcSourceKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "Borrows" },
  { value: "resale", label: "Resales" },
  { value: "shares", label: "Shares" }
];

// ── Live Market Data State ───────────────────────────────────────────────────
const asksState = reactive({
  items: [] as ZcAskSummary[],
  total: 0,
  next: null as string | null,
  pendingHidden: 0,
  loading: true,
  loadingMore: false
});

const offersState = reactive({
  items: [] as ZcOfferSummary[],
  total: 0,
  next: null as string | null,
  pendingHidden: 0,
  loading: true,
  loadingMore: false
});

const tokenMap = reactive<Record<string, ZcTokenMeta>>({});
const fetchedTokenIds = new Set<string>();

const previewPayload = ref<ExecutionPreviewPayload | null>(null);
const quickFillAsk = ref<ZcAskSummary | null>(null);
const sidebarPrefill = ref<SimpleSidebarPrefill | null>(null);
const sidebarRef = ref<HTMLElement | null>(null);

const refreshing = computed(() => !!zc.oracle.refreshPending);
const offerTargetBlocks = computed(() =>
  offerTargetDays.value > 0 ? offerTargetDays.value * DAY_BLOCKS : null
);

async function resolveCollateralTokens(asks: ZcAskSummary[]) {
  const needed: string[] = [];
  for (const a of asks) {
    const col = a.bond?.collateral || a.collateral;
    for (const t of col.tokens) {
      if (isHex64(t.id) && !fetchedTokenIds.has(t.id)) {
        fetchedTokenIds.add(t.id);
        needed.push(t.id);
      }
    }
  }
  if (!needed.length) return;
  try {
    const res = await zcApi.lookupAssets(needed.slice(0, 50));
    let updated = false;
    for (const [id, meta] of Object.entries(res)) {
      tokenMap[id.toLowerCase()] = { ...meta, id: id.toLowerCase() };
      updated = true;
    }
    if (updated) {
      for (const a of asksState.items) {
        const lists = [a.collateral.tokens, ...(a.bond ? [a.bond.collateral.tokens] : [])];
        for (const list of lists) {
          for (const t of list) {
            const m = tokenMap[t.id];
            if (m) {
              t.ticker = m.ticker || m.name || t.ticker;
              t.name = m.name || t.name;
              t.verified = m.verified;
            }
          }
        }
      }
    }
  } catch {
    // fail-soft
  }
}

let fetchAc: AbortController | null = null;

async function fetchListings() {
  if (fetchAc) fetchAc.abort();

  if (!zc.connected) {
    asksState.items = [];
    asksState.total = 0;
    asksState.next = null;
    asksState.loading = zc.loading;
    offersState.items = [];
    offersState.total = 0;
    offersState.next = null;
    offersState.loading = zc.loading;
    return;
  }

  const ac = new AbortController();
  fetchAc = ac;

  const m = zc.activeMarket;
  const apiAskSort: ZcSortKey =
    askSort.value === "maturity" || askSort.value === "size" ? askSort.value : "apr";
  const askQueryMatchable = askTradableOnly.value && !refreshing.value;
  const offerQueryMatchable = offerActiveOnly.value && !refreshing.value;

  const askRange =
    askMaxDays.value > 0
      ? { from: MIN_MATURITY_BLOCKS, to: askMaxDays.value * DAY_BLOCKS }
      : {};
  const offerRange =
    offerTargetBlocks.value != null
      ? { from: offerTargetBlocks.value, to: offerTargetBlocks.value }
      : {};

  asksState.loading = asksState.items.length === 0;
  offersState.loading = offersState.items.length === 0;

  try {
    const [asksPage, offersPage] = await Promise.all([
      zcApi.listAsksPage(
        m,
        {
          coverage: Math.round(askMinCover.value * 100),
          kind: askKind.value,
          matchable: askQueryMatchable,
          grid: askGridOnly.value,
          ...askRange,
          sort: apiAskSort,
          limit: 100
        },
        tokenMap,
        ac.signal
      ),
      zcApi.listOffersPage(
        m,
        {
          coverage: offerMaxFloor.value > 0 ? Math.round(offerMaxFloor.value * 100) : 100_000,
          kind: offerSharesOnly.value ? "shares" : "all",
          matchable: offerQueryMatchable,
          ...offerRange,
          sort: offerSort.value,
          limit: 100
        },
        ac.signal
      )
    ]);

    if (ac.signal.aborted) return;

    const filteredAsks =
      askTradableOnly.value && refreshing.value
        ? asksPage.items.filter((a) => a.ok || isOracleRefreshingOnly(a))
        : asksPage.items;
    asksState.items = filteredAsks;
    asksState.total =
      askTradableOnly.value && refreshing.value ? filteredAsks.length : asksPage.total;
    asksState.next = asksPage.next;
    asksState.pendingHidden = asksPage.pendingLeftOut;

    const filteredOffers =
      offerActiveOnly.value && refreshing.value
        ? offersPage.items.filter((o) => o.ok || isOracleRefreshingOnly(o))
        : offersPage.items;
    offersState.items = filteredOffers;
    offersState.total =
      offerActiveOnly.value && refreshing.value ? filteredOffers.length : offersPage.total;
    offersState.next = offersPage.next;
    offersState.pendingHidden = offersPage.pendingLeftOut;

    void resolveCollateralTokens(filteredAsks);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
  } finally {
    if (!ac.signal.aborted) {
      asksState.loading = false;
      offersState.loading = false;
    }
  }
}

watch(
  () => zc.activeMarket,
  () => {
    asksState.items = [];
    asksState.total = 0;
    asksState.next = null;
    offersState.items = [];
    offersState.total = 0;
    offersState.next = null;
    quickFillAsk.value = null;
  }
);

watch(
  [
    () => zc.connected,
    () => zc.revision,
    () => zc.refreshSeq,
    () => zc.activeMarket,
    askKind,
    askMinCover,
    askMaxDays,
    askSort,
    askTradableOnly,
    askGridOnly,
    offerMaxFloor,
    offerTargetDays,
    offerSort,
    offerActiveOnly,
    offerSharesOnly
  ],
  () => {
    void fetchListings();
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  fetchAc?.abort();
});

async function loadMoreAsks() {
  if (!asksState.next || asksState.loadingMore) return;
  asksState.loadingMore = true;
  try {
    const apiAskSort: ZcSortKey =
      askSort.value === "maturity" || askSort.value === "size" ? askSort.value : "apr";
    const page = await zcApi.listAsksPage(
      zc.activeMarket,
      {
        coverage: Math.round(askMinCover.value * 100),
        kind: askKind.value,
        matchable: askTradableOnly.value && !refreshing.value,
        grid: askGridOnly.value,
        ...(askMaxDays.value > 0
          ? { from: MIN_MATURITY_BLOCKS, to: askMaxDays.value * DAY_BLOCKS }
          : {}),
        sort: apiAskSort,
        cursor: asksState.next,
        limit: 100
      },
      tokenMap
    );
    asksState.items = [...asksState.items, ...page.items];
    asksState.next = page.next;
    void resolveCollateralTokens(page.items);
  } finally {
    asksState.loadingMore = false;
  }
}

async function loadMoreOffers() {
  if (!offersState.next || offersState.loadingMore) return;
  offersState.loadingMore = true;
  try {
    const page = await zcApi.listOffersPage(zc.activeMarket, {
      coverage: offerMaxFloor.value > 0 ? Math.round(offerMaxFloor.value * 100) : 100_000,
      kind: offerSharesOnly.value ? "shares" : "all",
      matchable: offerActiveOnly.value && !refreshing.value,
      ...(offerTargetBlocks.value != null
        ? { from: offerTargetBlocks.value, to: offerTargetBlocks.value }
        : {}),
      sort: offerSort.value,
      cursor: offersState.next,
      limit: 100
    });
    offersState.items = [...offersState.items, ...page.items];
    offersState.next = page.next;
  } finally {
    offersState.loadingMore = false;
  }
}

// ── Search & Client-side Sorting ─────────────────────────────────────────────
const qLower = computed(() => zc.searchQuery.trim().toLowerCase());

const displayedAsks = computed(() => {
  let list = asksState.items;
  if (qLower.value) {
    const q = qLower.value;
    list = list.filter((a) => {
      if (
        a.id.toLowerCase().includes(q) ||
        a.chainId.toLowerCase().includes(q) ||
        kindLabel(a.kind).toLowerCase().includes(q) ||
        pricingName(a).toLowerCase().includes(q)
      ) {
        return true;
      }
      const col = a.bond?.collateral || a.collateral;
      return col.tokens.some(
        (t) =>
          t.ticker.toLowerCase().includes(q) ||
          (t.name || "").toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q)
      );
    });
  }

  if (askSort.value === "cover") {
    return [...list].sort((a, b) => (b.cov ?? -1) - (a.cov ?? -1));
  }
  if (askSort.value === "newest") {
    return [...list].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  }
  return list;
});

const displayedOffers = computed(() => {
  let list = offersState.items;
  if (qLower.value) {
    const q = qLower.value;
    list = list.filter(
      (o) =>
        o.id.toLowerCase().includes(q) ||
        o.chainId.toLowerCase().includes(q) ||
        o.delivery.toLowerCase().includes(q)
    );
  }
  if (offerSort.value === "apr" && offerTargetBlocks.value != null) {
    const tb = offerTargetBlocks.value;
    return [...list].sort(
      (a, b) => (offerYieldAt(a, tb) ?? 1e9) - (offerYieldAt(b, tb) ?? 1e9)
    );
  }
  return list;
});

const hasActiveAskFilters = computed(
  () =>
    askKind.value !== "all" ||
    askMinCover.value !== 0 ||
    askMaxDays.value !== 0 ||
    askSort.value !== "apr" ||
    !askTradableOnly.value ||
    askGridOnly.value
);

const hasActiveOfferFilters = computed(
  () =>
    offerMaxFloor.value !== 0 ||
    offerTargetDays.value !== 0 ||
    offerSort.value !== "apr" ||
    !offerActiveOnly.value ||
    offerSharesOnly.value
);

function resetAskFilters() {
  askKind.value = "all";
  askMinCover.value = 0;
  askMaxDays.value = 0;
  askSort.value = "apr";
  askTradableOnly.value = true;
  askGridOnly.value = false;
}

function resetOfferFilters() {
  offerMaxFloor.value = 0;
  offerTargetDays.value = 0;
  offerSort.value = "apr";
  offerActiveOnly.value = true;
  offerSharesOnly.value = false;
}

// ── Live Market Header Metrics ───────────────────────────────────────────────
const marketTelemetry = computed(() => {
  const snap = zc.activeSnapshot;
  const totals = snap.curves?.totals;
  return {
    bestLendApr: zc.connected ? snap.bestAskBps : null,
    bestBorrowApr: zc.connected ? snap.bestBidBps : null,
    offerCap: totals?.offers.capital ?? 0,
    offerCount: totals?.offers.count ?? offersState.total,
    askCap: totals?.asks.cost ?? 0,
    askCount: totals?.asks.count ?? asksState.total
  };
});

// ── Quick Actions (Fill, Cancel, Borrow Against Offer) ───────────────────────
function handleQuickFill(ask: ZcAskSummary) {
  const isWindow = ask.pricing === "window" && !!ask.window;
  const isPartialShares = ask.kind === "shares" && ask.units > (ask.minFill || 1);
  if (isWindow || isPartialShares) {
    quickFillAsk.value = ask;
    return;
  }

  const q = resolvedAskQuote(ask, zc.height);
  if (!q) return;

  const m = ask.market;
  const isBuyback = !!ask.borrowedByMe && ask.kind !== "order" && !ask.owner;
  const rule = ask.bond?.rule || ask.rule;
  const ratio = ask.bond?.ratio ?? ask.ratio;

  previewPayload.value = {
    title:
      ask.kind === "order"
        ? `Fund ${m} Borrow Request`
        : isBuyback
          ? `Buy Back Your ${ask.kind === "shares" ? "Shares" : "Bond"}`
          : `Buy ${kindLabel(ask.kind)} (${m})`,
    subtitle: `${pricingName(ask)} · ${shortenString(ask.id, 14)}`,
    badge: ask.kind === "order" ? "Direct Lend" : isBuyback ? "Loan Buyback" : "Secondary Buy",
    tone: "bid",
    heroLabel: ask.kind === "order" ? "You fund now" : "You pay now",
    heroValue: formatMarketAmount(q.cost, m),
    heroSub: `${formatApr(q.yieldBps)} APR · ${q.pct.toFixed(2)}% of face`,
    rows: [
      { label: "Claim at maturity", value: formatMarketAmount(q.face, m) },
      {
        label: "Gross interest",
        value: `+${formatMarketAmount(q.face - q.cost, m)}`,
        tone: "bid"
      },
      {
        label: "Maturity",
        value: `${dateAtHeight(zc.height + q.d, zc.height)} · ${formatDur(q.d, zc.durationUnit)}`
      },
      {
        label: "Collateral cover",
        value:
          rule === "oracle"
            ? `${ask.cov != null ? Math.round(ask.cov) : "—"}% (liq. < ${ratio ?? "—"}%)`
            : "Maturity rule"
      },
      ...(ask.kind === "order" ? [{ label: "Fee reserve", value: "0.05 ERG (returned)" }] : [])
    ],
    rawSummary: {
      action: ask.kind === "order" ? "fillOrder" : "buyAsk",
      boxId: ask.id,
      market: m,
      cost: q.cost,
      face: q.face,
      yieldBps: Math.round(q.yieldBps),
      blocksLeft: q.d,
      maturity: q.maturity
    },
    txAction:
      ask.kind === "order"
        ? { type: "fillOrder", boxId: ask.id }
        : {
            type: "buyAsk",
            boxId: ask.id,
            units: ask.kind === "shares" ? BigInt(ask.units) : null
          }
  };
}

function handleQuickCancelAsk(ask: ZcAskSummary) {
  const label =
    ask.kind === "order"
      ? "Borrow Order"
      : ask.kind === "shares"
        ? "Share Resale Ask"
        : "Bond Resale Ask";
  previewPayload.value = {
    title: `Cancel & Refund ${label}`,
    subtitle: "Returns everything locked in this open listing to your Nautilus wallet",
    badge: `Cancel · ${ask.market}`,
    tone: "ask",
    heroLabel: "Box ID",
    heroValue: shortenString(ask.boxId, 14),
    heroSub: `${ask.market} · ${pricingName(ask)}`,
    rows: [
      { label: "Listing", value: label },
      { label: "Action", value: "Cancel and refund to wallet" }
    ],
    rawSummary: { action: "cancelBox", boxId: ask.boxId },
    txAction: { type: "cancel", boxId: ask.boxId }
  };
}

function handleQuickCancelOffer(offer: ZcOfferSummary) {
  previewPayload.value = {
    title: "Cancel & Refund Lend Offer",
    subtitle: `Returns remaining unspent ${offer.market} capital & ERG reserve to Nautilus`,
    badge: `Cancel Offer · ${offer.market}`,
    tone: "ask",
    heroLabel: "Capital returned",
    heroValue: formatMarketAmount(offer.capital, offer.market),
    heroSub: `Offer ${shortenString(offer.id, 14)}`,
    rows: [
      { label: "Market", value: offer.market },
      { label: "Reserve ERG", value: `${formatNumber(offer.reserve, 3, 0)} ERG` },
      { label: "Delivery mode", value: offer.delivery }
    ],
    rawSummary: { action: "cancelOffer", offerId: offer.id, boxId: offer.boxId },
    txAction: { type: "cancel", boxId: offer.boxId }
  };
}

function prefillFromOffer(offer: ZcOfferSummary, side: "borrow" | "sell") {
  const targetD =
    offerTargetBlocks.value != null
      ? Math.min(offer.maxBlocks, Math.max(offer.minBlocks, offerTargetBlocks.value))
      : Math.min(offer.maxBlocks, Math.max(offer.minBlocks, 90 * DAY_BLOCKS));
  const reqBps = (offerYieldAt(offer, targetD) ?? offer.minYieldBps) + 1;

  sidebarPrefill.value = {
    seq: Date.now(),
    side,
    days: Math.max(7, Math.round(targetD / DAY_BLOCKS)),
    cover: offer.floor,
    aprPct: Number((reqBps / 100).toFixed(2)),
    matchOfferId: offer.id
  };

  if (typeof window !== "undefined" && window.innerWidth < 1024 && sidebarRef.value) {
    sidebarRef.value.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function handleQuickFillProceed(payload: ExecutionPreviewPayload) {
  quickFillAsk.value = null;
  previewPayload.value = payload;
}

function onBannerPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}
</script>

<template>
  <div class="relative flex flex-1 flex-col gap-5 pb-8">
    <!-- ================================================================
         HERO HEADER PLATE — Landing-Styled Ambient Lights & Mode Toggle
         ================================================================ -->
    <section
      class="sf-bento market-hero relative overflow-hidden rounded-[26px] rounded-tl-[8px] px-5 py-5 sm:px-6"
      @mousemove="onBannerPointerMove"
    >
      <!-- Ambient Gradient Light Orbs + Subtle Top Rim -->
      <div class="hero-orb-left" aria-hidden="true" />
      <div class="hero-orb-right" aria-hidden="true" />
      <div class="hero-beam-top" aria-hidden="true" />

      <div class="relative z-10 flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
        <!-- Left: Market Coin + Space Grotesk Title & Subtitle -->
        <div class="flex items-start gap-3.5 sm:items-center">
          <div class="market-coin-halo relative shrink-0">
            <market-coin :market="zc.activeMarket" :size="44" />
          </div>
          <div>
            <h1
              class="sf-display text-[26px] font-bold leading-[1.08] tracking-[-0.032em] text-[color:var(--sf-ink)] sm:text-[31px]"
            >
              {{ zc.activeMarket }} Market
            </h1>
            <p class="mt-1 max-w-[48ch] text-[13px] leading-relaxed text-[color:var(--sf-ink-2)]">
              Browse live borrow requests, bond resales, and lend offers. Fill in one click or
              create orders from the sidebar.
            </p>
          </div>
        </div>

        <!-- Right: Elevated Luminous Stat Bento Tiles -->
        <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div
            class="hero-stat sf-bento rounded-[16px] rounded-tl-[6px] px-3.5 py-2.5"
            data-tone="bid"
            @mousemove="onBannerPointerMove"
          >
            <span class="hero-stat-beam" aria-hidden="true" />
            <span class="hero-stat-glow" aria-hidden="true" />
            <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              Top Lend APR
            </div>
            <div class="sf-serif mt-1 text-[24px] font-semibold leading-none tracking-[-0.025em] text-[color:var(--sf-bid)]">
              {{ formatApr(marketTelemetry.bestLendApr) }}
            </div>
            <div class="sf-mono mt-1.5 text-[10px] text-[color:var(--sf-dim)]">
              Best ask yield
            </div>
          </div>

          <div
            class="hero-stat sf-bento rounded-[16px] px-3.5 py-2.5"
            data-tone="ask"
            @mousemove="onBannerPointerMove"
          >
            <span class="hero-stat-beam" aria-hidden="true" />
            <span class="hero-stat-glow" aria-hidden="true" />
            <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              Best Borrow
            </div>
            <div class="sf-serif mt-1 text-[24px] font-semibold leading-none tracking-[-0.025em] text-[color:var(--sf-ask)]">
              {{ formatApr(marketTelemetry.bestBorrowApr) }}
            </div>
            <div class="sf-mono mt-1.5 text-[10px] text-[color:var(--sf-dim)]">
              Best bid curve
            </div>
          </div>

          <button
            type="button"
            class="hero-stat sf-bento rounded-[16px] px-3.5 py-2.5 text-left"
            data-tone="cobalt"
            title="View open borrows and resales"
            @mousemove="onBannerPointerMove"
            @click="listingTab = 'borrows'"
          >
            <span class="hero-stat-beam" aria-hidden="true" />
            <span class="hero-stat-glow" aria-hidden="true" />
            <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              Asks Open
            </div>
            <div class="mt-1 flex items-baseline gap-1">
              <span class="sf-display text-[21px] font-bold leading-none tracking-[-0.03em] text-[color:var(--sf-ink)]">
                {{ zc.connected ? formatCompact(marketTelemetry.askCap) : "—" }}
              </span>
              <span v-if="zc.connected" class="sf-mono text-[10.5px] font-semibold text-[color:var(--sf-muted)]">
                {{ zc.activeMarket }}
              </span>
            </div>
            <div class="sf-mono mt-1.5 text-[10px] text-[color:var(--sf-dim)]">
              {{ marketTelemetry.askCount }} {{ marketTelemetry.askCount === 1 ? "listing" : "listings" }}
            </div>
          </button>

          <button
            type="button"
            class="hero-stat sf-bento rounded-[16px] rounded-br-[6px] px-3.5 py-2.5 text-left"
            data-tone="bid"
            title="View open lend offers"
            @mousemove="onBannerPointerMove"
            @click="listingTab = 'offers'"
          >
            <span class="hero-stat-beam" aria-hidden="true" />
            <span class="hero-stat-glow" aria-hidden="true" />
            <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              Offers Open
            </div>
            <div class="mt-1 flex items-baseline gap-1">
              <span class="sf-display text-[21px] font-bold leading-none tracking-[-0.03em] text-[color:var(--sf-ink)]">
                {{ zc.connected ? formatCompact(marketTelemetry.offerCap) : "—" }}
              </span>
              <span v-if="zc.connected" class="sf-mono text-[10.5px] font-semibold text-[color:var(--sf-muted)]">
                {{ zc.activeMarket }}
              </span>
            </div>
            <div class="sf-mono mt-1.5 text-[10px] text-[color:var(--sf-dim)]">
              {{ marketTelemetry.offerCount }} {{ marketTelemetry.offerCount === 1 ? "offer" : "offers" }}
            </div>
          </button>
        </div>
      </div>
    </section>

    <!-- ================================================================
         MARKET BOARD — V1-Inspired Card Grid + Quick Action Sidebar
         ================================================================ -->
    <div
      class="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_364px] xl:grid-cols-[minmax(0,1fr)_384px]"
    >
      <!-- LEFT COLUMN: Switcher, Filters & Listing Boxes -->
      <div class="flex min-w-0 flex-col gap-4">
        <!-- Primary Listing Switcher + Filter Toolbar -->
        <section
          class="sf-terminal-plate flex flex-col gap-3 rounded-[20px] rounded-tl-[6px] p-3.5 sm:p-4"
          aria-label="Market listings switcher and filters"
        >
          <!-- Row 1: Borrows & Resales vs Lend Offers + Sync -->
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div
              class="sf-seg text-[12.5px]"
              role="tablist"
              aria-label="Listing side"
            >
              <button
                type="button"
                role="tab"
                :aria-selected="listingTab === 'borrows'"
                class="sf-seg-btn px-3.5 py-1.5"
                :class="listingTab === 'borrows' ? 'is-active tone-ask' : ''"
                @click="listingTab = 'borrows'"
              >
                <span>Borrows &amp; Resales</span>
                <span
                  class="sf-mono rounded-md px-1.5 py-[1px] text-[10.5px] font-bold"
                  :class="
                    listingTab === 'borrows'
                      ? 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                      : 'bg-[color:var(--sf-well)] text-[color:var(--sf-muted)]'
                  "
                >
                  {{ asksState.total }}
                </span>
              </button>

              <button
                type="button"
                role="tab"
                :aria-selected="listingTab === 'offers'"
                class="sf-seg-btn px-3.5 py-1.5"
                :class="listingTab === 'offers' ? 'is-active tone-bid' : ''"
                @click="listingTab = 'offers'"
              >
                <span>Lend Offers</span>
                <span
                  class="sf-mono rounded-md px-1.5 py-[1px] text-[10.5px] font-bold"
                  :class="
                    listingTab === 'offers'
                      ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                      : 'bg-[color:var(--sf-well)] text-[color:var(--sf-muted)]'
                  "
                >
                  {{ offersState.total }}
                </span>
              </button>
            </div>

            <div class="flex items-center gap-2">
              <button
                v-if="
                  (listingTab === 'borrows' && hasActiveAskFilters) ||
                  (listingTab === 'offers' && hasActiveOfferFilters)
                "
                type="button"
                class="sf-mono inline-flex h-8 items-center gap-1 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-2.5 text-[11px] font-semibold text-[color:var(--sf-muted)] transition-colors hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-cobalt)]"
                @click="listingTab === 'borrows' ? resetAskFilters() : resetOfferFilters()"
              >
                <rotate-ccw-icon class="h-3 w-3" />
                <span>Reset</span>
              </button>

              <button
                type="button"
                class="sf-btn-outline inline-flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[11.5px]"
                title="Refresh live listings"
                @click="zc.refresh()"
              >
                <refresh-cw-icon
                  class="h-3.5 w-3.5"
                  :class="asksState.loading || offersState.loading ? 'animate-spin text-[color:var(--sf-cobalt)]' : ''"
                />
                <span class="hidden sm:inline">Refresh</span>
              </button>
            </div>
          </div>

          <!-- Row 2: Context-Aware Filters -->
          <div
            v-if="listingTab === 'borrows'"
            class="flex flex-wrap items-center gap-2 border-t border-[color:var(--sf-line)] pt-3"
          >
            <!-- Kind Sub-Pills (All / Borrows / Resales / Shares) -->
            <div class="sf-seg text-[11px]" role="group" aria-label="Filter by listing type">
              <button
                v-for="pill in ASK_SOURCE_PILLS"
                :key="pill.value"
                type="button"
                :aria-pressed="askKind === pill.value"
                class="sf-seg-btn px-2.5 py-1"
                :class="askKind === pill.value ? 'is-active tone-cobalt' : ''"
                @click="askKind = pill.value"
              >
                {{ pill.label }}
              </button>
            </div>

            <zc-select
              v-model="askMinCover"
              :options="ASK_COVER_OPTIONS"
              prefix="Cover"
              mono
              aria-label="Minimum collateral cover"
            />

            <zc-select
              v-model="askMaxDays"
              :options="askMaturityOptions"
              prefix="Term"
              mono
              aria-label="Maximum maturity"
            />

            <zc-select
              v-model="askSort"
              :options="ASK_SORT_OPTIONS"
              prefix="Sort"
              aria-label="Sort borrows and resales"
            />

            <button
              type="button"
              :aria-pressed="askTradableOnly"
              class="inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-semibold transition-all"
              :class="
                askTradableOnly
                  ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-seg-bg)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="askTradableOnly = !askTradableOnly"
            >
              <span class="sf-switch-track scale-[0.82]" :class="askTradableOnly ? 'is-on' : ''">
                <span class="sf-switch-thumb" />
              </span>
              <span>Tradable</span>
            </button>

            <button
              type="button"
              :aria-pressed="askGridOnly"
              class="sf-mono inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-semibold transition-all"
              :class="
                askGridOnly
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-seg-bg)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              title="Only show bonds maturing on the 30-day grid"
              @click="askGridOnly = !askGridOnly"
            >
              <span>30d Grid</span>
            </button>
          </div>

          <div
            v-else
            class="flex flex-wrap items-center gap-2 border-t border-[color:var(--sf-line)] pt-3"
          >
            <zc-select
              v-model="offerMaxFloor"
              :options="OFFER_FLOOR_OPTIONS"
              prefix="Cover"
              mono
              aria-label="Maximum cover floor"
            />

            <zc-select
              v-model="offerTargetDays"
              :options="offerMaturityOptions"
              prefix="Term"
              mono
              aria-label="Target maturity"
            />

            <zc-select
              v-model="offerSort"
              :options="OFFER_SORT_OPTIONS"
              prefix="Sort"
              aria-label="Sort lend offers"
            />

            <button
              type="button"
              :aria-pressed="offerActiveOnly"
              class="inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-semibold transition-all"
              :class="
                offerActiveOnly
                  ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-seg-bg)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="offerActiveOnly = !offerActiveOnly"
            >
              <span class="sf-switch-track scale-[0.82]" :class="offerActiveOnly ? 'is-on' : ''">
                <span class="sf-switch-thumb" />
              </span>
              <span>Active</span>
            </button>

            <button
              type="button"
              :aria-pressed="offerSharesOnly"
              class="inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-semibold transition-all"
              :class="
                offerSharesOnly
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-seg-bg)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="offerSharesOnly = !offerSharesOnly"
            >
              <layers-icon class="h-3.5 w-3.5" />
              <span>Buys Shares</span>
            </button>
          </div>

          <!-- Active Header Search Filter Banner -->
          <div
            v-if="qLower"
            class="flex items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/50 px-3 py-1.5 text-[11.5px]"
          >
            <span class="sf-mono text-[color:var(--sf-ink-2)]">
              Filtering by <strong class="text-[color:var(--sf-cobalt)]">"{{ zc.searchQuery }}"</strong>
            </span>
            <button
              type="button"
              class="sf-mono text-[11px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
              @click="zc.searchQuery = ''"
            >
              Clear search
            </button>
          </div>
        </section>

        <!-- ============================================================
             CARDS FEED — BORROWS & RESALES
             ============================================================ -->
        <template v-if="listingTab === 'borrows'">
          <!-- Loading Skeletons -->
          <div
            v-if="asksState.loading"
            class="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3"
          >
            <div
              v-for="n in 6"
              :key="n"
              class="sf-plate flex h-[340px] flex-col justify-between rounded-[22px] rounded-tl-[6px] p-4"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2.5">
                  <div class="h-9 w-9 animate-pulse rounded-full bg-[color:var(--sf-well)]" />
                  <div class="space-y-1.5">
                    <div class="h-3.5 w-24 animate-pulse rounded bg-[color:var(--sf-well)]" />
                    <div class="h-3 w-32 animate-pulse rounded bg-[color:var(--sf-well)]" />
                  </div>
                </div>
                <div class="h-5 w-14 animate-pulse rounded-full bg-[color:var(--sf-well)]" />
              </div>
              <div class="h-28 w-full animate-pulse rounded-2xl bg-[color:var(--sf-well-inset)]" />
              <div class="space-y-2">
                <div class="h-3.5 w-full animate-pulse rounded bg-[color:var(--sf-well)]" />
                <div class="flex gap-2">
                  <div class="h-6 w-20 animate-pulse rounded-lg bg-[color:var(--sf-well)]" />
                  <div class="h-6 w-24 animate-pulse rounded-lg bg-[color:var(--sf-well)]" />
                </div>
              </div>
              <div class="flex gap-2 border-t border-[color:var(--sf-line)] pt-3">
                <div class="h-9 flex-1 animate-pulse rounded-xl bg-[color:var(--sf-well)]" />
                <div class="h-9 w-24 animate-pulse rounded-xl bg-[color:var(--sf-well)]" />
              </div>
            </div>
          </div>

          <!-- Empty State -->
          <div
            v-else-if="displayedAsks.length === 0"
            class="sf-bento flex flex-col items-center justify-center rounded-[24px] px-6 py-14 text-center"
          >
            <span
              class="grid h-12 w-12 place-items-center rounded-2xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]"
            >
              <search-icon class="h-5 w-5" />
            </span>
            <h3 class="sf-serif mt-4 text-[22px] font-medium text-[color:var(--sf-ink)]">
              {{
                zc.connected
                  ? "No borrows or resales match these filters"
                  : "Syncing with the Ergo blockchain"
              }}
            </h3>
            <p class="mt-1.5 max-w-[44ch] text-[13px] leading-relaxed text-[color:var(--sf-muted)]">
              {{
                zc.connected
                  ? "Widen your filters, check paused listings, or post your own lend offer or borrow order in the sidebar."
                  : zc.error || "Waiting for the Ergo chain feed to connect."
              }}
            </p>
            <div class="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              <button
                v-if="hasActiveAskFilters"
                type="button"
                class="sf-btn-cobalt inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px]"
                @click="resetAskFilters"
              >
                <rotate-ccw-icon class="h-3.5 w-3.5" />
                <span>Reset filters</span>
              </button>
              <button
                v-if="askTradableOnly && zc.connected"
                type="button"
                class="sf-btn-outline inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px]"
                @click="askTradableOnly = false"
              >
                <span>Include paused listings</span>
              </button>
              <button
                type="button"
                class="sf-btn-outline inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px]"
                @click="listingTab = 'offers'"
              >
                <span>View Lend Offers ({{ offersState.total }})</span>
                <arrow-right-icon class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <!-- Populated Ask Cards Grid -->
          <template v-else>
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              <market-ask-card
                v-for="(ask, idx) in displayedAsks"
                :key="ask.id"
                :ask="ask"
                :height="zc.height"
                :oracle-price="zc.oracle.price"
                :unit="zc.durationUnit"
                :index="idx"
                @quick-fill="handleQuickFill"
                @quick-cancel="handleQuickCancelAsk"
              />
            </div>

            <div
              v-if="asksState.next || asksState.pendingHidden > 0"
              class="flex flex-wrap items-center justify-between gap-3 pt-1"
            >
              <span
                v-if="asksState.pendingHidden > 0"
                class="sf-mono text-[11px] text-[color:var(--sf-muted)]"
              >
                {{ asksState.pendingHidden }} additional mempool listing{{
                  asksState.pendingHidden === 1 ? "" : "s"
                }}
                not shown
              </span>
              <span v-else />
              <button
                v-if="asksState.next"
                type="button"
                :disabled="asksState.loadingMore"
                class="sf-btn-outline inline-flex h-9 items-center gap-2 rounded-full px-5 text-[12px] font-semibold"
                @click="loadMoreAsks"
              >
                <refresh-cw-icon
                  v-if="asksState.loadingMore"
                  class="h-3.5 w-3.5 animate-spin"
                />
                <span>{{ asksState.loadingMore ? "Loading…" : "Load more listings" }}</span>
              </button>
            </div>
          </template>
        </template>

        <!-- ============================================================
             CARDS FEED — LEND OFFERS
             ============================================================ -->
        <template v-else>
          <!-- Loading Skeletons -->
          <div
            v-if="offersState.loading"
            class="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3"
          >
            <div
              v-for="n in 6"
              :key="n"
              class="sf-plate flex h-[330px] flex-col justify-between rounded-[22px] rounded-tl-[6px] p-4"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2.5">
                  <div class="h-9 w-9 animate-pulse rounded-full bg-[color:var(--sf-well)]" />
                  <div class="space-y-1.5">
                    <div class="h-3.5 w-24 animate-pulse rounded bg-[color:var(--sf-well)]" />
                    <div class="h-3 w-32 animate-pulse rounded bg-[color:var(--sf-well)]" />
                  </div>
                </div>
                <div class="h-5 w-16 animate-pulse rounded-full bg-[color:var(--sf-well)]" />
              </div>
              <div class="h-28 w-full animate-pulse rounded-2xl bg-[color:var(--sf-well-inset)]" />
              <div class="grid grid-cols-2 gap-2">
                <div class="h-12 animate-pulse rounded-xl bg-[color:var(--sf-well)]" />
                <div class="h-12 animate-pulse rounded-xl bg-[color:var(--sf-well)]" />
              </div>
              <div class="flex gap-2 border-t border-[color:var(--sf-line)] pt-3">
                <div class="h-9 flex-1 animate-pulse rounded-xl bg-[color:var(--sf-well)]" />
                <div class="h-9 w-24 animate-pulse rounded-xl bg-[color:var(--sf-well)]" />
              </div>
            </div>
          </div>

          <!-- Empty State -->
          <div
            v-else-if="displayedOffers.length === 0"
            class="sf-bento flex flex-col items-center justify-center rounded-[24px] px-6 py-14 text-center"
          >
            <span
              class="grid h-12 w-12 place-items-center rounded-2xl border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]"
            >
              <search-icon class="h-5 w-5" />
            </span>
            <h3 class="sf-serif mt-4 text-[22px] font-medium text-[color:var(--sf-ink)]">
              {{
                zc.connected
                  ? "No lend offers match these filters"
                  : "Syncing with the Ergo blockchain"
              }}
            </h3>
            <p class="mt-1.5 max-w-[44ch] text-[13px] leading-relaxed text-[color:var(--sf-muted)]">
              {{
                zc.connected
                  ? "Adjust the maturity or cover floor filter, or post the first lend offer from the sidebar."
                  : zc.error || "Waiting for the Ergo chain feed to connect."
              }}
            </p>
            <div class="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              <button
                v-if="hasActiveOfferFilters"
                type="button"
                class="sf-btn-cobalt inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px]"
                @click="resetOfferFilters"
              >
                <rotate-ccw-icon class="h-3.5 w-3.5" />
                <span>Reset filters</span>
              </button>
              <button
                v-if="offerActiveOnly && zc.connected"
                type="button"
                class="sf-btn-outline inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px]"
                @click="offerActiveOnly = false"
              >
                <span>Include paused offers</span>
              </button>
              <button
                type="button"
                class="sf-btn-outline inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px]"
                @click="listingTab = 'borrows'"
              >
                <span>View Borrows &amp; Resales ({{ asksState.total }})</span>
                <arrow-right-icon class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <!-- Populated Offer Cards Grid -->
          <template v-else>
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              <market-offer-card
                v-for="(offer, idx) in displayedOffers"
                :key="offer.id"
                :offer="offer"
                :height="zc.height"
                :unit="zc.durationUnit"
                :target-blocks="offerTargetBlocks"
                :index="idx"
                @quick-borrow="prefillFromOffer($event, 'borrow')"
                @quick-sell="prefillFromOffer($event, 'sell')"
                @quick-cancel="handleQuickCancelOffer"
              />
            </div>

            <div
              v-if="offersState.next || offersState.pendingHidden > 0"
              class="flex flex-wrap items-center justify-between gap-3 pt-1"
            >
              <span
                v-if="offersState.pendingHidden > 0"
                class="sf-mono text-[11px] text-[color:var(--sf-muted)]"
              >
                {{ offersState.pendingHidden }} additional mempool offer{{
                  offersState.pendingHidden === 1 ? "" : "s"
                }}
                not shown
              </span>
              <span v-else />
              <button
                v-if="offersState.next"
                type="button"
                :disabled="offersState.loadingMore"
                class="sf-btn-outline inline-flex h-9 items-center gap-2 rounded-full px-5 text-[12px] font-semibold"
                @click="loadMoreOffers"
              >
                <refresh-cw-icon
                  v-if="offersState.loadingMore"
                  class="h-3.5 w-3.5 animate-spin"
                />
                <span>{{ offersState.loadingMore ? "Loading…" : "Load more offers" }}</span>
              </button>
            </div>
          </template>
        </template>

        <!-- Protocol Risk Footer Bar (Matches Simple.js) -->
        <div
          class="flex items-start gap-2.5 rounded-2xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card-glass)] px-4 py-3 text-[11.5px] leading-relaxed text-[color:var(--sf-muted)]"
        >
          <shield-icon class="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--sf-cobalt)]" />
          <p>
            Each loan has its own collateral basket, liquidation rule, and recovery path. Repayment,
            funding, and resale liquidity are not guaranteed. Open
            <strong class="font-semibold text-[color:var(--sf-ink-2)]">Terms</strong> on any card to
            verify its full contract script and collateral before signing.
          </p>
        </div>
      </div>

      <!-- RIGHT COLUMN: Sticky Simple Action Sidebar -->
      <div ref="sidebarRef" class="market-sticky-sidebar lg:z-20 lg:self-start">
        <market-simple-sidebar
          :market="zc.activeMarket"
          :height="zc.height"
          :oracle-price="zc.oracle.price"
          :oracle-refreshing="refreshing"
          :connected="zc.connected"
          :revision="zc.revision"
          :refresh-seq="zc.refreshSeq"
          :unit="zc.durationUnit"
          :prefill="sidebarPrefill"
          @preview="previewPayload = $event"
        />
      </div>
    </div>

    <!-- Quick Fill Customization Modal (Window Orders / Partial Shares) -->
    <transition name="sf-modal">
      <market-quick-fill-modal
        v-if="quickFillAsk"
        :ask="quickFillAsk"
        :height="zc.height"
        :unit="zc.durationUnit"
        @close="quickFillAsk = null"
        @proceed="handleQuickFillProceed"
      />
    </transition>

    <!-- Shared Nautilus v3 Execution Preview & Signing Modal -->
    <transition name="sf-modal">
      <execution-preview-modal
        v-if="previewPayload"
        :payload="previewPayload"
        @close="previewPayload = null"
      />
    </transition>
  </div>
</template>

<style scoped>
.market-hero {
  background: var(--sf-card-glass);
  backdrop-filter: blur(14px);
}

.hero-beam-top {
  position: absolute;
  top: 0;
  left: 8%;
  right: 8%;
  height: 2px;
  border-radius: 0 0 999px 999px;
  pointer-events: none;
  z-index: 4;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(var(--sf-cobalt-rgb), 0.72) 32%,
    rgba(var(--sf-bid-rgb), 0.65) 68%,
    transparent
  );
}

.hero-orb-left {
  position: absolute;
  top: -90px;
  left: -60px;
  width: 320px;
  height: 240px;
  border-radius: 9999px;
  pointer-events: none;
  z-index: 0;
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-cobalt-rgb), 0.18),
    transparent 74%
  );
  filter: blur(26px);
  animation: sfOrbFloat 11s ease-in-out infinite alternate;
}

.hero-orb-right {
  position: absolute;
  bottom: -100px;
  right: -50px;
  width: 340px;
  height: 240px;
  border-radius: 9999px;
  pointer-events: none;
  z-index: 0;
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-bid-rgb), 0.16),
    transparent 74%
  );
  filter: blur(28px);
  animation: sfOrbFloat 13s ease-in-out infinite alternate-reverse;
}

.market-coin-halo::before {
  content: "";
  position: absolute;
  inset: -6px;
  border-radius: 9999px;
  background: radial-gradient(
    circle,
    rgba(var(--sf-cobalt-rgb), 0.28),
    rgba(var(--sf-bid-rgb), 0.12) 55%,
    transparent 74%
  );
  filter: blur(6px);
  pointer-events: none;
}

.hero-stat {
  min-width: 128px;
  background: var(--sf-card);
  border-color: var(--sf-line-strong);
  box-shadow: var(--sf-rim-top), var(--sf-shadow-card);
  transition:
    transform 0.26s var(--sf-ease),
    border-color 0.24s var(--sf-ease),
    box-shadow 0.28s var(--sf-ease);
}

@media (min-width: 1024px) {
  .market-sticky-sidebar {
    position: sticky;
    top: calc(var(--sf-header-h, 62px) + 14px);
  }
}

.hero-stat:hover {
  transform: translateY(-2px);
}

.hero-stat[data-tone="bid"]:hover {
  border-color: var(--sf-line-bid);
}

.hero-stat[data-tone="ask"]:hover {
  border-color: var(--sf-line-ask);
}

.hero-stat[data-tone="cobalt"]:hover {
  border-color: var(--sf-line-cobalt);
}

.hero-stat-beam {
  position: absolute;
  top: 0;
  left: 14%;
  right: 14%;
  height: 2px;
  border-radius: 0 0 999px 999px;
  pointer-events: none;
  z-index: 3;
  opacity: 0.78;
  transition:
    opacity 0.24s var(--sf-ease),
    left 0.3s var(--sf-ease),
    right 0.3s var(--sf-ease);
  background: linear-gradient(
    90deg,
    transparent,
    rgba(var(--sf-cobalt-rgb), 0.8),
    transparent
  );
}

.hero-stat[data-tone="bid"] .hero-stat-beam {
  background: linear-gradient(
    90deg,
    transparent,
    rgba(var(--sf-bid-rgb), 0.85),
    transparent
  );
}

.hero-stat[data-tone="ask"] .hero-stat-beam {
  background: linear-gradient(
    90deg,
    transparent,
    rgba(var(--sf-ask-rgb), 0.85),
    transparent
  );
}

.hero-stat:hover .hero-stat-beam {
  opacity: 1;
  left: 6%;
  right: 6%;
}

.hero-stat-glow {
  position: absolute;
  top: -32px;
  right: -28px;
  width: 96px;
  height: 96px;
  border-radius: 9999px;
  pointer-events: none;
  z-index: 0;
  opacity: 0.52;
  filter: blur(18px);
  transition: opacity 0.28s var(--sf-ease);
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-cobalt-rgb), 0.26),
    transparent 74%
  );
}

.hero-stat[data-tone="bid"] .hero-stat-glow {
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-bid-rgb), 0.24),
    transparent 74%
  );
}

.hero-stat[data-tone="ask"] .hero-stat-glow {
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-ask-rgb), 0.24),
    transparent 74%
  );
}

.hero-stat:hover .hero-stat-glow {
  opacity: 0.9;
}

@keyframes sfOrbFloat {
  0% {
    transform: translate3d(0, 0, 0) scale(1);
    opacity: 0.72;
  }
  100% {
    transform: translate3d(16px, -8px, 0) scale(1.08);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-orb-left,
  .hero-orb-right {
    animation: none !important;
  }
  .hero-stat:hover {
    transform: none !important;
  }
}
</style>
