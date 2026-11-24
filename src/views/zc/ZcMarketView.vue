<script setup lang="ts">
import { FilterIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import AskInspector from "./components/AskInspector.vue";
import ExecutionPreviewModal, {
  ExecutionPreviewPayload
} from "./components/ExecutionPreviewModal.vue";
import OfferInspector from "./components/OfferInspector.vue";
import OrderLadderPanel from "./components/OrderLadderPanel.vue";
import OrderLedgerTable from "./components/OrderLedgerTable.vue";
import OrderTicketPanel from "./components/OrderTicketPanel.vue";
import RateBookCanvas from "./components/RateBookCanvas.vue";
import ZcSelect, { ZcSelectOption } from "./components/ZcSelect.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { zcApi, ZcTokenMeta } from "@/services/zcApi";
import { useZcStore } from "@/stories/zcStore";
import {
  ZcAskSummary,
  ZcCurves,
  ZcFillSummary,
  ZcOfferSummary,
  ZcOrderbook,
  ZcRateBookFilters,
  ZcSortKey,
  ZcSourceKind
} from "@/types/zc";
import { shortenString } from "@/utils";
import {
  bandFor,
  dateAtHeight,
  DAY_BLOCKS,
  DEFAULT_COVER,
  formatApr,
  formatBlocksCompact,
  formatBp,
  formatCompact,
  formatDur,
  formatDurCell,
  formatMarketAmount,
  formatNumber,
  isBookRowRefreshingOnly,
  isHex64,
  isOracleRefreshingOnly,
  kindLabel,
  lineAt,
  MIN_COVER,
  MIN_MATURITY_BLOCKS,
  pricingName,
  resolvedAskQuote,
  YEAR_BLOCKS
} from "@/utils/zcMath";

const TENORS = [7, 30, 60, 90, 180, 365] as const;
const COVERS = [125, 150, 175, 200, 250] as const;

const COVER_OPTIONS: readonly ZcSelectOption[] = COVERS.map((c) => ({
  value: c,
  label: `≥ ${c}% cover`,
  shortLabel: `≥${c}%`
}));

const SOURCE_OPTIONS: readonly ZcSelectOption[] = [
  { value: "all", label: "All sources" },
  { value: "new", label: "New loans" },
  { value: "resale", label: "Resale" },
  { value: "shares", label: "Shares" }
];

const EMPTY_BOOK: ZcOrderbook = {
  asks: [],
  bids: [],
  bestAsk: null,
  bestBid: null,
  anchorBlocks: null,
  anchorBid: null,
  spread: null,
  spreadD: null,
  spreadBid: null,
  spreadAsk: null,
  lo: MIN_MATURITY_BLOCKS,
  hi: YEAR_BLOCKS,
  band: null,
  range: true
};

const zc = useZcStore();
const route = useRoute();

/* ============================================================
   Rate Book Filter & View State
   ============================================================ */
const coverage = ref<number>(DEFAULT_COVER);
const kind = ref<ZcSourceKind>("all");
const matchable = ref<boolean>(true);
const grid = ref<boolean>(false);
const maturityMode = ref<"upto" | "near">("upto");
const targetBlocks = ref<number>(90 * DAY_BLOCKS);
const showFills = ref<boolean>(true);
const showOffers = ref<boolean>(false);
const follow = ref<boolean>(false);
const filtersOpen = ref<boolean>(false);
const filterMenuRef = ref<HTMLElement | null>(null);

const ledgerTab = ref<"asks" | "bids" | "fills">("asks");
const sort = ref<ZcSortKey>("apr");

const selected = ref<{ type: "ask" | "bid"; id: string } | null>(null);
const lookupAsk = ref<ZcAskSummary | null>(null);
const lookupOffer = ref<ZcOfferSummary | null>(null);

const previewPayload = ref<ExecutionPreviewPayload | null>(null);

const ticketPrefill = ref<{
  seq: number;
  side?: "lend" | "borrow" | "sell";
  amount?: string;
  days?: number;
  apr?: number | null;
} | null>(null);

// Sync deep-link query params (e.g. from Landing Page CTAs)
watch(
  () => route.query,
  (q) => {
    if (route.name !== "zc-market") return;
    if (q.market === "ERG" || q.market === "SigUSD") {
      zc.setActiveMarket(q.market);
    }
    const qDays = typeof q.days === "string" ? Number(q.days) : NaN;
    if (Number.isFinite(qDays) && qDays >= 1 && qDays <= 730) {
      targetBlocks.value = Math.round(qDays) * DAY_BLOCKS;
    }
    const qCover = typeof q.cover === "string" ? Number(q.cover) : NaN;
    if (Number.isFinite(qCover) && qCover >= MIN_COVER && qCover <= 300) {
      coverage.value = Math.round(qCover);
    }
    if (q.side === "lend" || q.side === "borrow" || q.side === "sell" || q.amount || q.apr) {
      const qApr = typeof q.apr === "string" && q.apr !== "" ? Number(q.apr) : null;
      ticketPrefill.value = {
        seq: Date.now(),
        side:
          q.side === "borrow" || q.side === "lend" || q.side === "sell" ? q.side : undefined,
        amount: typeof q.amount === "string" ? q.amount : undefined,
        days: Number.isFinite(qDays) ? Math.round(qDays) : undefined,
        apr: qApr != null && Number.isFinite(qApr) ? qApr : null
      };
    }
  },
  { immediate: true }
);

// React to global header search selection
watch(
  () => zc.pendingSelect?.seq,
  () => {
    const req = zc.pendingSelect;
    if (!req) return;
    selected.value = { type: req.type, id: req.id };
  }
);

// Clear selection on market switch
watch(
  () => zc.activeMarket,
  () => {
    selected.value = null;
    lookupAsk.value = null;
    lookupOffer.value = null;
  }
);

const upto = computed(() => maturityMode.value === "upto");
const bandBlocks = computed(() => bandFor(targetBlocks.value));
const refreshing = computed(() => !!zc.oracle.refreshPending);

const activeFilters = computed<ZcRateBookFilters>(() => ({
  coverage: Math.max(MIN_COVER, coverage.value),
  kind: kind.value,
  matchable: matchable.value,
  grid: grid.value
}));

const extraFilterCount = computed(
  () =>
    Number(grid.value) +
    Number(follow.value) +
    Number(showOffers.value) +
    Number(!showFills.value)
);

/* ============================================================
   Live Rate Book Data Queries
   ============================================================ */
const curves = ref<ZcCurves | null>(null);
const rawOrderbook = ref<ZcOrderbook | null>(null);
const bookLoading = ref(false);

const asksState = reactive({
  items: [] as ZcAskSummary[],
  total: 0,
  next: null as string | null,
  pendingHidden: 0,
  loading: false
});

const offersState = reactive({
  items: [] as ZcOfferSummary[],
  total: 0,
  next: null as string | null,
  pendingHidden: 0,
  loading: false
});

const fillsState = reactive({
  items: [] as ZcFillSummary[],
  status: "ready" as string
});

const tokenMap = reactive<Record<string, ZcTokenMeta>>({});
const fetchedTokenIds = new Set<string>();

async function resolveCollateralTokens(asks: ZcAskSummary[]) {
  const needed: string[] = [];
  for (const a of asks) {
    for (const t of a.collateral.tokens) {
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
        for (const t of a.collateral.tokens) {
          const m = tokenMap[t.id];
          if (m) {
            t.ticker = m.ticker || m.name || t.ticker;
            t.name = m.name || t.name;
            t.verified = m.verified;
          }
        }
      }
    }
  } catch {
    // fail-soft
  }
}

let fetchAc: AbortController | null = null;

async function fetchRateBook() {
  if (fetchAc) fetchAc.abort();

  if (!zc.connected) {
    curves.value = null;
    rawOrderbook.value = null;
    asksState.items = [];
    asksState.total = 0;
    offersState.items = [];
    offersState.total = 0;
    fillsState.items = [];
    return;
  }

  const ac = new AbortController();
  fetchAc = ac;
  const m = zc.activeMarket;
  const covBps = Math.round(activeFilters.value.coverage * 100);
  const queryMatchable = activeFilters.value.matchable && !refreshing.value;
  const k = activeFilters.value.kind;
  const g = activeFilters.value.grid;

  const obRange = upto.value
    ? { to: Math.max(DAY_BLOCKS, Math.round(targetBlocks.value)) }
    : { around: Math.max(1, Math.round(targetBlocks.value)), band: bandBlocks.value };

  const tableRange = follow.value
    ? upto.value
      ? { from: MIN_MATURITY_BLOCKS, to: targetBlocks.value }
      : {
          from: Math.max(1, targetBlocks.value - bandBlocks.value),
          to: targetBlocks.value + bandBlocks.value
        }
    : {};

  const fromHeight = zc.height > 0 ? Math.max(0, zc.height - 7200) : 0;
  const apiFillKind = k === "new" || k === "shares" ? k : undefined;

  bookLoading.value = true;
  asksState.loading = true;
  offersState.loading = true;

  try {
    const [curvesRes, obRes, asksPage, offersPage, fillsRes] = await Promise.all([
      zcApi.getCurves(
        m,
        { coverage: covBps, kind: k, matchable: queryMatchable, grid: g },
        ac.signal
      ),
      zcApi.getOrderbook(
        m,
        { coverage: covBps, kind: k, matchable: queryMatchable, grid: g, ...obRange },
        ac.signal
      ),
      zcApi.listAsksPage(
        m,
        {
          coverage: covBps,
          kind: k,
          matchable: queryMatchable,
          grid: g,
          ...tableRange,
          sort: sort.value,
          limit: 100
        },
        tokenMap,
        ac.signal
      ),
      zcApi.listOffersPage(
        m,
        {
          coverage: covBps,
          kind: k,
          matchable: queryMatchable,
          grid: g,
          ...tableRange,
          sort: sort.value,
          limit: 100
        },
        ac.signal
      ),
      zcApi
        .listFillsResult(m, { fromHeight, kind: apiFillKind, limit: 200 }, ac.signal)
        .catch(() => ({
          items: [] as ZcFillSummary[],
          status: "not-configured",
          indexedTo: null
        }))
    ]);

    if (ac.signal.aborted) return;

    curves.value = curvesRes;
    rawOrderbook.value = obRes;

    const filteredAsks =
      activeFilters.value.matchable && refreshing.value
        ? asksPage.items.filter((a) => a.ok || isOracleRefreshingOnly(a))
        : asksPage.items;
    asksState.items = filteredAsks;
    asksState.total =
      activeFilters.value.matchable && refreshing.value ? filteredAsks.length : asksPage.total;
    asksState.next = asksPage.next;
    asksState.pendingHidden = asksPage.pendingLeftOut;

    const filteredOffers =
      activeFilters.value.matchable && refreshing.value
        ? offersPage.items.filter((o) => o.ok || isOracleRefreshingOnly(o))
        : offersPage.items;
    offersState.items = filteredOffers;
    offersState.total =
      activeFilters.value.matchable && refreshing.value ? filteredOffers.length : offersPage.total;
    offersState.next = offersPage.next;
    offersState.pendingHidden = offersPage.pendingLeftOut;

    fillsState.items =
      k === "resale" ? fillsRes.items.filter((x) => x.kind !== "new") : fillsRes.items;
    fillsState.status = fillsRes.status;

    void resolveCollateralTokens(filteredAsks);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
  } finally {
    if (!ac.signal.aborted) {
      bookLoading.value = false;
      asksState.loading = false;
      offersState.loading = false;
    }
  }
}

watch(
  [
    () => zc.connected,
    () => zc.revision,
    () => zc.refreshSeq,
    () => zc.activeMarket,
    coverage,
    kind,
    matchable,
    grid,
    maturityMode,
    targetBlocks,
    follow,
    sort
  ],
  () => {
    void fetchRateBook();
  },
  { immediate: true }
);

async function loadMoreAsks() {
  if (!asksState.next || asksState.loading) return;
  asksState.loading = true;
  try {
    const covBps = Math.round(activeFilters.value.coverage * 100);
    const page = await zcApi.listAsksPage(
      zc.activeMarket,
      {
        coverage: covBps,
        kind: activeFilters.value.kind,
        matchable: activeFilters.value.matchable && !refreshing.value,
        grid: activeFilters.value.grid,
        sort: sort.value,
        cursor: asksState.next,
        limit: 100
      },
      tokenMap
    );
    asksState.items = [...asksState.items, ...page.items];
    asksState.next = page.next;
    void resolveCollateralTokens(page.items);
  } finally {
    asksState.loading = false;
  }
}

async function loadMoreOffers() {
  if (!offersState.next || offersState.loading) return;
  offersState.loading = true;
  try {
    const covBps = Math.round(activeFilters.value.coverage * 100);
    const page = await zcApi.listOffersPage(zc.activeMarket, {
      coverage: covBps,
      kind: activeFilters.value.kind,
      matchable: activeFilters.value.matchable && !refreshing.value,
      grid: activeFilters.value.grid,
      sort: sort.value,
      cursor: offersState.next,
      limit: 100
    });
    offersState.items = [...offersState.items, ...page.items];
    offersState.next = page.next;
  } finally {
    offersState.loading = false;
  }
}

// Effective Orderbook (with transient oracle refresh handling)
const orderbook = computed<ZcOrderbook>(() => {
  const base = rawOrderbook.value || { ...EMPTY_BOOK, band: upto.value ? null : bandBlocks.value };
  if (!(activeFilters.value.matchable && refreshing.value)) return base;
  return {
    ...base,
    asks: base.asks.filter((r) => r.ok || isBookRowRefreshingOnly(r)),
    bids: base.bids.filter((r) => r.ok || isBookRowRefreshingOnly(r))
  };
});

// Lookup fallback when selected ID isn't in loaded asks/offers page
const pageAsk = computed(() =>
  selected.value?.type === "ask"
    ? asksState.items.find((a) => a.id === selected.value?.id) || null
    : null
);
const pageOffer = computed(() =>
  selected.value?.type === "bid"
    ? offersState.items.find((o) => o.id === selected.value?.id) || null
    : null
);

let lookupAc: AbortController | null = null;
watch([selected, pageAsk, pageOffer, () => zc.connected, () => zc.revision], async () => {
  if (lookupAc) lookupAc.abort();
  const sel = selected.value;
  if (!sel || pageAsk.value || pageOffer.value || !zc.connected || !isHex64(sel.id)) {
    lookupAsk.value = null;
    lookupOffer.value = null;
    return;
  }
  const ac = new AbortController();
  lookupAc = ac;
  try {
    const res = await zcApi.lookup(sel.id, tokenMap, ac.signal);
    if (ac.signal.aborted) return;
    if (!res) {
      selected.value = null;
      return;
    }
    lookupAsk.value = res.ask || null;
    lookupOffer.value = res.offer || null;
  } catch {
    // ignore
  }
});

const selectedAsk = computed(
  () => pageAsk.value || (selected.value?.type === "ask" ? lookupAsk.value : null)
);
const selectedOffer = computed(
  () => pageOffer.value || (selected.value?.type === "bid" ? lookupOffer.value : null)
);

function onDocClick(e: MouseEvent) {
  if (!filtersOpen.value) return;
  if (filterMenuRef.value && !filterMenuRef.value.contains(e.target as Node)) {
    filtersOpen.value = false;
  }
}

function onEscKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (filtersOpen.value) {
    filtersOpen.value = false;
    return;
  }
  if (previewPayload.value) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (selected.value) selected.value = null;
}

onMounted(() => {
  document.addEventListener("mousedown", onDocClick);
  document.addEventListener("keydown", onEscKey);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocClick);
  document.removeEventListener("keydown", onEscKey);
  fetchAc?.abort();
  lookupAc?.abort();
});

function selectAsk(id: string) {
  selected.value =
    selected.value?.type === "ask" && selected.value.id === id ? null : { type: "ask", id };
}

function selectBid(id: string) {
  selected.value =
    selected.value?.type === "bid" && selected.value.id === id ? null : { type: "bid", id };
}

function handleQuickFund(ask: ZcAskSummary) {
  const q = resolvedAskQuote(ask, zc.height);
  if (!q) {
    selected.value = { type: "ask", id: ask.id };
    return;
  }
  const m = ask.market;
  const buyback = !!ask.borrowedByMe && ask.kind !== "order" && !ask.owner;
  const rule = ask.bond?.rule || ask.rule;
  const ratio = ask.bond?.ratio ?? ask.ratio;
  previewPayload.value = {
    title:
      ask.kind === "order"
        ? `Fund ${m} Borrow Order`
        : buyback
          ? `Buy Back Your ${ask.kind === "shares" ? "Shares" : "Bond"}`
          : `Buy ${kindLabel(ask.kind)} (${m})`,
    subtitle: `${pricingName(ask)} · ${shortenString(ask.id, 14)}`,
    badge: ask.kind === "order" ? "Direct Lend" : buyback ? "Loan Buyback" : "Secondary Buy",
    tone: "bid",
    heroLabel: ask.kind === "order" ? "You fund now" : "You pay now",
    heroValue: formatMarketAmount(q.cost, m),
    heroSub: `${formatApr(q.yieldBps)} APR · ${q.pct.toFixed(2)}% of face`,
    rows: [
      { label: "Claim at maturity", value: formatMarketAmount(q.face, m) },
      { label: "Gross interest", value: `+${formatMarketAmount(q.face - q.cost, m)}`, tone: "bid" },
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
      ...(ask.kind === "order"
        ? [{ label: "Fee reserve", value: "0.05 ERG (returned)" }]
        : [])
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

function handleBorrowAgainstOffer(params: { aprPct: number; days: number }) {
  selected.value = null;
  targetBlocks.value = params.days * DAY_BLOCKS;
  ticketPrefill.value = {
    seq: Date.now(),
    side: "borrow",
    days: params.days,
    apr: params.aprPct
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

function handleSellAgainstOffer(params: { aprPct: number; days: number }) {
  selected.value = null;
  targetBlocks.value = params.days * DAY_BLOCKS;
  ticketPrefill.value = {
    seq: Date.now(),
    side: "sell",
    days: params.days,
    apr: params.aprPct
  };
}

function resetAllFilters() {
  coverage.value = DEFAULT_COVER;
  kind.value = "all";
  matchable.value = true;
  grid.value = false;
  follow.value = false;
  showFills.value = true;
  showOffers.value = false;
}

function chipLabel(days: number): string {
  const prefix = upto.value ? "≤" : "";
  if (zc.durationUnit === "blocks") return `${prefix}${formatBlocksCompact(days * DAY_BLOCKS)}`;
  return `${prefix}${days === 365 ? "1y" : `${days}d`}`;
}

// Live Market Telemetry KPIs — always curve-consistent (same-maturity spread, never cross-maturity)
const pulse = computed(() => {
  const c = curves.value;
  const ob = orderbook.value;
  const hasMatchedSpread =
    ob.spread != null && ob.spreadBid != null && ob.spreadAsk != null;
  const bidAtCursor = ob.anchorBid ?? (c ? lineAt(c.bidLine, targetBlocks.value) : null);
  const bestBid = hasMatchedSpread ? ob.spreadBid : bidAtCursor ?? ob.bestBid;
  const bestAsk = hasMatchedSpread ? ob.spreadAsk : ob.bestAsk;
  const spread = hasMatchedSpread ? ob.spread : null;
  const spreadD = hasMatchedSpread ? ob.spreadD : null;
  const refTenorBlocks = spreadD ?? (bestBid != null ? targetBlocks.value : null);
  const offerCap = c?.totals.offers.capital ?? 0;
  const askCost = c?.totals.asks.cost ?? 0;
  const totalDepth = offerCap + askCost;
  const bidSharePct = totalDepth > 0 ? Math.round((offerCap / totalDepth) * 100) : 50;
  const mult = zc.activeMarket === "ERG" ? zc.oracle.price : 1;
  return {
    bestBid,
    bestAsk,
    spread,
    spreadD,
    refTenorBlocks,
    crossed: spread != null && spread <= 0,
    offerCap,
    offerCount: c?.totals.offers.matchable ?? 0,
    offerUsd: mult > 0 ? offerCap * mult : null,
    askCost,
    askCount: c?.totals.asks.matchable ?? 0,
    askUsd: mult > 0 ? askCost * mult : null,
    bidSharePct
  };
});
</script>

<template>
  <!-- ========================================================
       RATE BOOK TRADING WORKSPACE (/app) — Single-Screen Desktop
       ======================================================== -->
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <!-- Unified Market Telemetry + Precision Control Ribbon -->
    <section
      class="sf-terminal-plate flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[16px] rounded-tl-[5px] px-3 py-2 sm:px-3.5"
      role="toolbar"
      aria-label="Yield Curve telemetry and filters"
    >
      <!-- LEFT: High-Contrast Market Telemetry Strip -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div class="flex items-center gap-2.5">
          <market-coin :market="zc.activeMarket" :size="30" bare />
          <h1 class="sf-display text-[19px] font-bold leading-none tracking-[-0.03em] text-[color:var(--sf-ink)]">
            {{ zc.activeMarket }}
          </h1>
        </div>

        <span class="hidden h-5 w-px bg-[color:var(--sf-line)] sm:block" aria-hidden="true" />

        <!-- Bid / Ask / Spread Telemetry -->
        <dl class="sf-mono flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
          <div class="flex items-baseline gap-1.5">
            <dt class="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              Bid
            </dt>
            <dd class="text-[14px] font-bold text-[color:var(--sf-bid)]">
              {{ zc.connected ? formatApr(pulse.bestBid) : "—" }}
            </dd>
          </div>

          <div class="flex items-baseline gap-1.5">
            <dt class="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              Ask
            </dt>
            <dd class="text-[14px] font-bold text-[color:var(--sf-ask)]">
              {{ zc.connected ? formatApr(pulse.bestAsk) : "—" }}
            </dd>
          </div>

          <div class="flex items-center gap-1.5">
            <dt class="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              Spd
            </dt>
            <dd
              class="text-[13px] font-semibold"
              :class="pulse.crossed ? 'text-[color:var(--sf-ask)]' : 'text-[color:var(--sf-ink)]'"
              :title="
                pulse.spreadD != null
                  ? `Tightest same-maturity spread in slice (evaluated at ${formatDur(pulse.spreadD, zc.durationUnit)})`
                  : 'Same-maturity spread (requires overlapping bid and ask)'
              "
            >
              {{ zc.connected ? formatBp(pulse.spread) : "—" }}
            </dd>
            <span
              v-if="zc.connected && pulse.refTenorBlocks != null"
              class="sf-mono text-[10px] font-medium text-[color:var(--sf-dim)]"
              :title="
                pulse.spreadD != null
                  ? `Bid, Ask, and Spread matched at ${formatDur(pulse.spreadD, zc.durationUnit)}`
                  : `Bid curve evaluated at ${formatDur(pulse.refTenorBlocks, zc.durationUnit)}`
              "
            >
              @{{ formatDurCell(pulse.refTenorBlocks, zc.durationUnit) }}
            </span>
            <span
              v-if="zc.connected && pulse.crossed"
              class="rounded-[4px] border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] px-1.5 py-[1px] text-[9px] font-bold uppercase text-[color:var(--sf-ask)]"
            >
              Cross
            </span>
          </div>

          <!-- Depth Balance Micro-Bar (visible on wide screens) -->
          <div
            class="hidden items-center gap-2 2xl:flex"
            :title="`Offers: ${formatCompact(pulse.offerCap)} ${zc.activeMarket} (${pulse.offerCount}) · Asks: ${formatCompact(pulse.askCost)} ${zc.activeMarket} (${pulse.askCount})`"
          >
            <span class="h-4 w-px bg-[color:var(--sf-line)]" aria-hidden="true" />
            <span class="text-[11px] font-semibold text-[color:var(--sf-bid)]">
              {{ zc.connected ? formatCompact(pulse.offerCap) : "—" }}
            </span>
            <span class="flex h-1.5 w-14 overflow-hidden rounded-full bg-[color:var(--sf-line)]">
              <span
                class="h-full bg-[color:var(--sf-bid)] transition-all duration-300"
                :style="{ width: `${pulse.bidSharePct}%` }"
              />
              <span
                class="h-full bg-[color:var(--sf-ask)] transition-all duration-300"
                :style="{ width: `${100 - pulse.bidSharePct}%` }"
              />
            </span>
            <span class="text-[11px] font-semibold text-[color:var(--sf-ask)]">
              {{ zc.connected ? formatCompact(pulse.askCost) : "—" }}
            </span>
          </div>
        </dl>
      </div>

      <!-- RIGHT: Precision Filter Controls -->
      <div class="flex flex-wrap items-center gap-2">
        <!-- Maturity Mode + Tenor Preset Tray -->
        <div class="flex items-center gap-1.5">
          <div class="sf-seg" role="group" aria-label="Maturity range mode">
            <button
              type="button"
              :aria-pressed="maturityMode === 'upto'"
              title="All maturities from 1 day up to selected tenor"
              class="sf-seg-btn px-2 py-1 text-[10.5px]"
              :class="maturityMode === 'upto' ? 'is-active' : ''"
              @click="maturityMode = 'upto'"
            >
              Up to
            </button>
            <button
              type="button"
              :aria-pressed="maturityMode === 'near'"
              title="Orders within ±22% of selected tenor"
              class="sf-seg-btn px-2 py-1 text-[10.5px]"
              :class="maturityMode === 'near' ? 'is-active' : ''"
              @click="maturityMode = 'near'"
            >
              Around
            </button>
          </div>

          <div class="sf-seg" role="group" aria-label="Tenor presets">
            <button
              v-for="d in TENORS"
              :key="d"
              type="button"
              :aria-pressed="targetBlocks === d * DAY_BLOCKS"
              class="sf-seg-btn sf-mono px-2 py-1 text-[10.5px]"
              :class="targetBlocks === d * DAY_BLOCKS ? 'is-active tone-cobalt' : ''"
              @click="targetBlocks = d * DAY_BLOCKS"
            >
              {{ chipLabel(d) }}
            </button>
          </div>
        </div>

        <!-- Cover Filter -->
        <zc-select
          :model-value="coverage"
          :options="COVER_OPTIONS"
          prefix="Cov"
          aria-label="Minimum cover ratio"
          mono
          align="right"
          @update:model-value="coverage = Number($event)"
        />

        <!-- Source Filter -->
        <zc-select
          :model-value="kind"
          :options="SOURCE_OPTIONS"
          aria-label="Order source filter"
          align="right"
          @update:model-value="kind = $event as ZcSourceKind"
        />

        <!-- Matchable Animated Toggle Pill -->
        <button
          type="button"
          role="switch"
          :aria-checked="matchable"
          title="Hide paused guards, stale oracle orders, and under-ratio bonds"
          class="inline-flex h-8 items-center gap-2 rounded-[10px] border px-2.5 text-[11px] font-semibold transition-all active:scale-95"
          :class="
            matchable
              ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-ink)]'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-seg-bg)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="matchable = !matchable"
        >
          <span class="sf-switch-track" :class="{ 'is-on': matchable }">
            <span class="sf-switch-thumb" />
          </span>
          <span>Matchable</span>
        </button>

        <!-- More Filters Popover -->
        <div ref="filterMenuRef" class="relative" @keydown.esc="filtersOpen = false">
          <button
            type="button"
            :aria-expanded="filtersOpen"
            class="inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-semibold transition-all active:scale-95"
            :class="
              extraFilterCount > 0 || filtersOpen
                ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-ink-2)] hover:border-[color:var(--sf-line-strong)]'
            "
            @click="filtersOpen = !filtersOpen"
          >
            <filter-icon class="h-3.5 w-3.5" />
            <span class="hidden sm:inline">More</span>
            <span
              v-if="extraFilterCount > 0"
              class="sf-mono rounded-[4px] bg-[color:var(--sf-cobalt)] px-1.5 py-[1px] text-[9.5px] font-bold text-white"
            >
              {{ extraFilterCount }}
            </span>
          </button>

          <transition name="sf-pop">
            <div
              v-if="filtersOpen"
              class="sf-popover absolute right-0 top-[calc(100%+8px)] z-40 w-72 space-y-3 rounded-2xl p-4"
              role="dialog"
              aria-label="Additional Yield Curve filters"
            >
              <label class="flex cursor-pointer items-start gap-2.5 text-[12px]">
                <input
                  v-model="grid"
                  type="checkbox"
                  class="mt-0.5 h-3.5 w-3.5 rounded accent-cobalt-600"
                />
                <span>
                  <strong class="block font-semibold text-[color:var(--sf-ink)]">
                    Grid maturities only
                  </strong>
                  <span class="text-[11px] text-[color:var(--sf-muted)]">
                    30-day zcs1 grid heights and matching windows.
                  </span>
                </span>
              </label>

              <label class="flex cursor-pointer items-start gap-2.5 text-[12px]">
                <input
                  v-model="follow"
                  type="checkbox"
                  class="mt-0.5 h-3.5 w-3.5 rounded accent-cobalt-600"
                />
                <span>
                  <strong class="block font-semibold text-[color:var(--sf-ink)]">
                    Tables follow maturity
                  </strong>
                  <span class="text-[11px] text-[color:var(--sf-muted)]">
                    Filter ledger to active maturity slice.
                  </span>
                </span>
              </label>

              <label class="flex cursor-pointer items-start gap-2.5 text-[12px]">
                <input
                  v-model="showFills"
                  type="checkbox"
                  class="mt-0.5 h-3.5 w-3.5 rounded accent-cobalt-600"
                />
                <span>
                  <strong class="block font-semibold text-[color:var(--sf-ink)]">
                    Fills on curve
                  </strong>
                  <span class="text-[11px] text-[color:var(--sf-muted)]">
                    10-day executions fading with age.
                  </span>
                </span>
              </label>

              <label class="flex cursor-pointer items-start gap-2.5 text-[12px]">
                <input
                  v-model="showOffers"
                  type="checkbox"
                  class="mt-0.5 h-3.5 w-3.5 rounded accent-cobalt-600"
                />
                <span>
                  <strong class="block font-semibold text-[color:var(--sf-ink)]">
                    Every bid curve
                  </strong>
                  <span class="text-[11px] text-[color:var(--sf-muted)]">
                    Draw each individual lend offer curve.
                  </span>
                </span>
              </label>

              <div
                class="flex items-center justify-between border-t border-[color:var(--sf-line)] pt-2.5"
              >
                <button
                  type="button"
                  class="text-[11.5px] font-medium text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]"
                  @click="resetAllFilters"
                >
                  Reset all
                </button>
                <button
                  type="button"
                  class="sf-btn-outline rounded-full px-3.5 py-1 text-[11.5px]"
                  @click="filtersOpen = false"
                >
                  Done
                </button>
              </div>
            </div>
          </transition>
        </div>
      </div>
    </section>

    <!-- ========================================================
         MAIN 3-COLUMN SINGLE-SCREEN TRADING WORKBENCH
         ======================================================== -->
    <div
      class="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-12 xl:grid-cols-[minmax(0,1fr)_280px_332px] 2xl:grid-cols-[minmax(0,1fr)_304px_348px]"
    >
      <!-- COLUMN 1 (Left): Analytical Stage (Top) + Live Depth Ledger (Bottom) -->
      <div class="flex min-h-0 min-w-0 flex-col gap-3 lg:col-span-12 xl:col-span-1">
        <div class="min-h-[300px] xl:min-h-0 xl:flex-[55_1_0%]">
          <rate-book-canvas
            :market="zc.activeMarket"
            :curves="curves"
            :orderbook="orderbook"
            :asks="asksState.items"
            :offers="offersState.items"
            :fills="fillsState.items"
            :fills-status="fillsState.status"
            :height="zc.height"
            :connected="zc.connected"
            :oracle-refreshing="refreshing"
            :unit="zc.durationUnit"
            :target-blocks="targetBlocks"
            :upto="upto"
            :coverage="activeFilters.coverage"
            :show-fills="showFills"
            :show-offers="showOffers"
            :selected-id="selected?.id ?? null"
            @update:target-blocks="targetBlocks = $event"
            @update:show-fills="showFills = $event"
            @update:show-offers="showOffers = $event"
            @select-ask="selectAsk"
            @select-bid="selectBid"
          />
        </div>

        <div class="min-h-[260px] xl:min-h-0 xl:flex-[45_1_0%]">
          <order-ledger-table
            :tab="ledgerTab"
            :sort="sort"
            :market="zc.activeMarket"
            :unit="zc.durationUnit"
            :height="zc.height"
            :follow="follow"
            :asks="asksState.items"
            :asks-total="asksState.total"
            :asks-next="asksState.next"
            :asks-pending-hidden="asksState.pendingHidden"
            :asks-loading="asksState.loading"
            :offers="offersState.items"
            :offers-total="offersState.total"
            :offers-next="offersState.next"
            :offers-pending-hidden="offersState.pendingHidden"
            :offers-loading="offersState.loading"
            :fills="fillsState.items"
            :fills-status="fillsState.status"
            :selected-id="selected?.id ?? null"
            :search-query="zc.searchQuery"
            @update:tab="ledgerTab = $event"
            @update:sort="sort = $event"
            @select-ask="selectAsk"
            @select-bid="selectBid"
            @quick-fund="handleQuickFund"
            @quick-cancel-ask="handleQuickCancelAsk"
            @quick-cancel-offer="handleQuickCancelOffer"
            @load-more-asks="loadMoreAsks"
            @load-more-offers="loadMoreOffers"
          />
        </div>
      </div>

      <!-- COLUMN 2 (Center): Full-Height Synchronized Order Ladder + Tape -->
      <div class="min-h-0 lg:col-span-6 xl:col-span-1">
        <order-ladder-panel
          :book="orderbook"
          :fills="fillsState.items"
          :fills-status="fillsState.status"
          :height="zc.height"
          :market="zc.activeMarket"
          :unit="zc.durationUnit"
          :upto="upto"
          :target-blocks="targetBlocks"
          :band-blocks="bandBlocks"
          :selected-id="selected?.id ?? null"
          :loading="bookLoading"
          @select-ask="selectAsk"
          @select-bid="selectBid"
        />
      </div>

      <!-- COLUMN 3 (Right): Full-Height Elevated Action & Inspector Dock -->
      <div class="min-h-0 lg:col-span-6 xl:col-span-1">
        <transition name="sf-swap" mode="out-in">
          <ask-inspector
            v-if="selectedAsk"
            :key="`ask-${selectedAsk.id}`"
            :ask="selectedAsk"
            :curves="curves"
            :height="zc.height"
            :oracle-price="zc.oracle.price"
            :oracle-age="zc.oracle.age"
            :unit="zc.durationUnit"
            @close="selected = null"
            @preview="previewPayload = $event"
          />
          <offer-inspector
            v-else-if="selectedOffer"
            :key="`offer-${selectedOffer.id}`"
            :offer="selectedOffer"
            :height="zc.height"
            :target-blocks="targetBlocks"
            :upto="upto"
            :unit="zc.durationUnit"
            :connected="zc.connected"
            :revision="zc.revision"
            @close="selected = null"
            @borrow-against="handleBorrowAgainstOffer"
            @sell-against="handleSellAgainstOffer"
            @preview="previewPayload = $event"
          />
          <order-ticket-panel
            v-else
            key="ticket"
            :market="zc.activeMarket"
            :curves="curves"
            :filters="activeFilters"
            :height="zc.height"
            :oracle-price="zc.oracle.price"
            :oracle-refreshing="refreshing"
            :connected="zc.connected"
            :revision="zc.revision"
            :unit="zc.durationUnit"
            :prefill="ticketPrefill"
            @preview="previewPayload = $event"
          />
        </transition>
      </div>
    </div>

    <!-- Structured Execution Preview Modal -->
    <transition name="sf-modal">
      <execution-preview-modal
        v-if="previewPayload"
        :payload="previewPayload"
        @close="previewPayload = null"
        @submitted="
          selected = null;
          void fetchRateBook();
        "
      />
    </transition>
  </div>
</template>
