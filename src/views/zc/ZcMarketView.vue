<script setup lang="ts">
import { FilterIcon, SearchIcon, XIcon } from "@zhuowenli/vue-feather-icons";
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
  ZcSearchHit,
  ZcSortKey,
  ZcSourceKind
} from "@/types/zc";
import { shortenString } from "@/utils";
import {
  bandFor,
  bestAskOverall,
  bestBidOverall,
  DAY_BLOCKS,
  DEFAULT_COVER,
  formatApr,
  formatBlocksCompact,
  formatBp,
  formatCompact,
  formatDur,
  formatMarketAmount,
  isBookRowRefreshingOnly,
  isHex64,
  isOracleRefreshingOnly,
  MIN_COVER,
  MIN_MATURITY_BLOCKS,
  YEAR_BLOCKS
} from "@/utils/zcMath";

const TENORS = [7, 30, 60, 90, 180, 365] as const;
const COVERS = [125, 150, 175, 200, 250] as const;

const EMPTY_BOOK: ZcOrderbook = {
  asks: [],
  bids: [],
  bestAsk: null,
  bestBid: null,
  spread: null,
  lo: MIN_MATURITY_BLOCKS,
  hi: YEAR_BLOCKS,
  band: null,
  range: true
};

const zc = useZcStore();
const route = useRoute();

const section = computed(() => {
  if (route.name === "zc-auctions") return "auctions";
  if (route.name === "zc-portfolio") return "portfolio";
  return "market";
});

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
const searchQuery = ref<string>("");
const searchHits = ref<ZcSearchHit[]>([]);
const searchFocused = ref<boolean>(false);

const selected = ref<{ type: "ask" | "bid"; id: string } | null>(null);
const lookupAsk = ref<ZcAskSummary | null>(null);
const lookupOffer = ref<ZcOfferSummary | null>(null);

const previewPayload = ref<ExecutionPreviewPayload | null>(null);

const ticketPrefill = ref<{
  seq: number;
  side?: "lend" | "borrow";
  amount?: string;
  days?: number;
  apr?: number | null;
} | null>(null);

// Sync deep-link query params (e.g. from Landing Page SimpleQuoteCard!)
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
    if (q.side === "lend" || q.side === "borrow" || q.amount || q.apr) {
      const qApr = typeof q.apr === "string" && q.apr !== "" ? Number(q.apr) : null;
      ticketPrefill.value = {
        seq: Date.now(),
        side: q.side === "borrow" ? "borrow" : q.side === "lend" ? "lend" : undefined,
        amount: typeof q.amount === "string" ? q.amount : undefined,
        days: Number.isFinite(qDays) ? Math.round(qDays) : undefined,
        apr: qApr != null && Number.isFinite(qApr) ? qApr : null
      };
    }
  },
  { immediate: true }
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
  () => Number(grid.value) + Number(follow.value) + Number(showOffers.value) + Number(!showFills.value)
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
  if (section.value !== "market") return;
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
      : { from: Math.max(1, targetBlocks.value - bandBlocks.value), to: targetBlocks.value + bandBlocks.value }
    : {};

  const fromHeight = zc.height > 0 ? Math.max(0, zc.height - 7200) : 0;
  const apiFillKind = k === "new" || k === "shares" ? k : undefined;

  bookLoading.value = true;
  asksState.loading = true;
  offersState.loading = true;

  try {
    const [curvesRes, obRes, asksPage, offersPage, fillsRes] = await Promise.all([
      zcApi.getCurves(m, { coverage: covBps, kind: k, matchable: queryMatchable, grid: g }, ac.signal),
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
        .catch(() => ({ items: [] as ZcFillSummary[], status: "not-configured", indexedTo: null }))
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
    section,
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

// Lookup fallback when selected ID isn't in the loaded asks/offers page
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

const selectedAsk = computed(() => pageAsk.value || (selected.value?.type === "ask" ? lookupAsk.value : null));
const selectedOffer = computed(() => pageOffer.value || (selected.value?.type === "bid" ? lookupOffer.value : null));

// Remote hex search (when >= 6 hex chars entered)
let searchTimer: number | null = null;
let searchAc: AbortController | null = null;
watch(searchQuery, (val) => {
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  if (searchAc) searchAc.abort();
  const clean = val.trim().toLowerCase();
  if (!zc.connected || clean.length < 6 || !/^[0-9a-f]+$/.test(clean)) {
    searchHits.value = [];
    return;
  }
  searchTimer = window.setTimeout(async () => {
    const ac = new AbortController();
    searchAc = ac;
    try {
      const hits = await zcApi.search(clean, ac.signal);
      if (!ac.signal.aborted) searchHits.value = hits.slice(0, 6);
    } catch {
      if (!ac.signal.aborted) searchHits.value = [];
    }
  }, 240);
});

function pickSearchHit(hit: ZcSearchHit) {
  if (hit.market && (hit.market === "ERG" || hit.market === "SigUSD")) {
    zc.setActiveMarket(hit.market);
  }
  if (hit.type === "offer") {
    selected.value = { type: "bid", id: hit.id };
  } else {
    selected.value = { type: "ask", id: hit.id };
  }
  searchFocused.value = false;
}

// Click-outside for More Filters popover
function onDocClick(e: MouseEvent) {
  if (!filtersOpen.value) return;
  if (filterMenuRef.value && !filterMenuRef.value.contains(e.target as Node)) {
    filtersOpen.value = false;
  }
}

onMounted(() => document.addEventListener("mousedown", onDocClick));
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocClick);
  fetchAc?.abort();
  lookupAc?.abort();
  searchAc?.abort();
  if (searchTimer !== null) window.clearTimeout(searchTimer);
});

function selectAsk(id: string) {
  selected.value = selected.value?.type === "ask" && selected.value.id === id ? null : { type: "ask", id };
}

function selectBid(id: string) {
  selected.value = selected.value?.type === "bid" && selected.value.id === id ? null : { type: "bid", id };
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

// Market Pulse Telemetry KPIs
const pulse = computed(() => {
  const c = curves.value;
  const bestBid = orderbook.value.bestBid ?? bestBidOverall(c);
  const bestAsk = orderbook.value.bestAsk ?? bestAskOverall(c);
  const spread = orderbook.value.spread ?? (bestBid != null && bestAsk != null ? bestBid - bestAsk : null);
  const offerCap = c?.totals.offers.capital ?? 0;
  const askCost = c?.totals.asks.cost ?? 0;
  const mult = zc.activeMarket === "ERG" ? zc.oracle.price : 1;
  return {
    bestBid,
    bestAsk,
    spread,
    crossed: spread != null && spread <= 0,
    offerCap,
    offerCount: c?.totals.offers.matchable ?? 0,
    offerUsd: mult > 0 ? offerCap * mult : null,
    askCost,
    askCount: c?.totals.asks.matchable ?? 0,
    askUsd: mult > 0 ? askCost * mult : null
  };
});
</script>

<template>
  <!-- ========================================================
       RATE BOOK WORKSPACE (/app)
       ======================================================== -->
  <div v-if="section === 'market'" class="space-y-5">
    <!-- Title + Quick Search + Market Pulse Ribbon -->
    <header class="space-y-4">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div class="flex items-center gap-3.5">
          <market-coin :market="zc.activeMarket" :size="38" />
          <div>
            <div class="flex flex-wrap items-center gap-2.5">
              <h1 class="sf-serif text-[30px] font-semibold leading-none text-[color:var(--sf-ink)] sm:text-[34px]">
                {{ zc.activeMarket }} Rate Book
              </h1>
              <span
                class="sf-mono rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] px-2 py-0.5 text-[10.5px] font-medium text-[color:var(--sf-muted)]"
              >
                zcs1 · simple APR
              </span>
            </div>
            <p class="mt-1 text-[13px] text-[color:var(--sf-muted)]">
              Peer-to-peer zero-coupon term structure, maturity ladder, and collateral risk map.
            </p>
          </div>
        </div>

        <!-- Quick ID / Box Search -->
        <div class="relative w-full sm:w-72">
          <div
            class="flex items-center gap-2 rounded-xl border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-card)] px-3 py-2 focus-within:border-cobalt-600"
          >
            <search-icon class="h-3.5 w-3.5 shrink-0 text-[color:var(--sf-muted)]" />
            <input
              v-model="searchQuery"
              type="text"
              placeholder="Filter or lookup box ID…"
              aria-label="Filter or lookup order by box ID"
              class="sf-mono w-full min-w-0 bg-transparent text-[12px] text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
              @focus="searchFocused = true"
              @blur="searchFocused = false"
            />
            <button
              v-if="searchQuery"
              type="button"
              class="text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]"
              aria-label="Clear search"
              @click="searchQuery = ''"
            >
              <x-icon class="h-3.5 w-3.5" />
            </button>
          </div>

          <div
            v-if="searchFocused && searchHits.length"
            class="sf-plate absolute inset-x-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-xl py-1"
          >
            <button
              v-for="hit in searchHits"
              :key="hit.id"
              type="button"
              class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11.5px] hover:bg-[color:var(--sf-well)]"
              @mousedown.prevent="pickSearchHit(hit)"
            >
              <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
                {{ shortenString(hit.id, 14) }}
              </span>
              <span class="sf-mono text-[10.5px] uppercase text-[color:var(--sf-muted)]">
                {{ hit.type }} {{ hit.market || "" }}
              </span>
            </button>
          </div>
        </div>
      </div>

      <!-- Editorial Market Pulse Ribbon -->
      <dl
        class="sf-plate grid grid-cols-2 divide-y divide-[color:var(--sf-line)] overflow-hidden rounded-2xl sm:grid-cols-5 sm:divide-x sm:divide-y-0"
      >
        <div class="px-4 py-3">
          <dt class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Best Bid
          </dt>
          <dd class="sf-mono mt-1 text-[19px] font-semibold text-[color:var(--sf-bid)]">
            {{ zc.connected ? formatApr(pulse.bestBid) : "—" }}
          </dd>
          <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
            {{ upto ? `≤ ${formatDur(targetBlocks, zc.durationUnit)}` : `near ${formatDur(targetBlocks, zc.durationUnit)}` }}
          </div>
        </div>

        <div class="px-4 py-3">
          <dt class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Best Ask
          </dt>
          <dd class="sf-mono mt-1 text-[19px] font-semibold text-[color:var(--sf-ask)]">
            {{ zc.connected ? formatApr(pulse.bestAsk) : "—" }}
          </dd>
          <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
            cover ≥ {{ activeFilters.coverage }}%
          </div>
        </div>

        <div class="px-4 py-3">
          <dt class="sf-mono flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            <span>Spread</span>
            <span
              v-if="zc.connected && pulse.crossed"
              class="rounded bg-[color:var(--sf-ask-soft)] px-1 py-0.5 text-[9px] font-semibold text-[color:var(--sf-ask)]"
            >
              Crossed
            </span>
          </dt>
          <dd
            class="sf-mono mt-1 text-[19px] font-semibold"
            :class="pulse.crossed ? 'text-[color:var(--sf-ask)]' : 'text-[color:var(--sf-ink)]'"
          >
            {{ zc.connected ? formatBp(pulse.spread) : "—" }}
          </dd>
          <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
            {{ pulse.crossed ? "immediate match" : "bid − ask" }}
          </div>
        </div>

        <div class="px-4 py-3">
          <dt class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Offer Depth
          </dt>
          <dd class="sf-mono mt-1 text-[19px] font-semibold text-[color:var(--sf-ink)]">
            {{ zc.connected ? `${formatCompact(pulse.offerCap)} ${zc.activeMarket}` : "—" }}
          </dd>
          <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
            {{ pulse.offerCount }} offers<template v-if="pulse.offerUsd != null && pulse.offerUsd > 0">
              · ${{ formatCompact(pulse.offerUsd) }}</template
            >
          </div>
        </div>

        <div class="col-span-2 px-4 py-3 sm:col-span-1">
          <dt class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Ask Demand
          </dt>
          <dd class="sf-mono mt-1 text-[19px] font-semibold text-[color:var(--sf-ink)]">
            {{ zc.connected ? `${formatCompact(pulse.askCost)} ${zc.activeMarket}` : "—" }}
          </dd>
          <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
            {{ pulse.askCount }} asks<template v-if="pulse.askUsd != null && pulse.askUsd > 0">
              · ${{ formatCompact(pulse.askUsd) }}</template
            >
          </div>
        </div>
      </dl>
    </header>

    <!-- Unified Precision Control Bar -->
    <div
      class="sf-plate flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-2xl px-4 py-2.5 sm:px-5"
      role="toolbar"
      aria-label="Rate Book filters"
    >
      <!-- Maturity Mode + Tenor Pills -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
          Maturity
        </span>
        <div
          class="inline-flex rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5 text-[11px]"
          role="group"
          aria-label="Maturity range mode"
        >
          <button
            type="button"
            :aria-pressed="maturityMode === 'upto'"
            class="rounded-md px-2 py-1 font-semibold transition-all"
            :class="
              maturityMode === 'upto'
                ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
                : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
            "
            @click="maturityMode = 'upto'"
          >
            Up to
          </button>
          <button
            type="button"
            :aria-pressed="maturityMode === 'near'"
            class="rounded-md px-2 py-1 font-semibold transition-all"
            :class="
              maturityMode === 'near'
                ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
                : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
            "
            @click="maturityMode = 'near'"
          >
            Around
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Tenor presets">
          <button
            v-for="d in TENORS"
            :key="d"
            type="button"
            :aria-pressed="targetBlocks === d * DAY_BLOCKS"
            class="sf-mono rounded-md border px-2 py-1 text-[11px] font-medium transition-all"
            :class="
              targetBlocks === d * DAY_BLOCKS
                ? 'border-cobalt-600 bg-cobalt-50 text-cobalt-700'
                : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)]'
            "
            @click="targetBlocks = d * DAY_BLOCKS"
          >
            {{ chipLabel(d) }}
          </button>
        </div>
      </div>

      <span class="hidden h-5 w-px bg-[color:var(--sf-line)] lg:block" aria-hidden="true" />

      <!-- Cover Filter -->
      <label class="inline-flex items-center gap-2 text-[12px] text-[color:var(--sf-muted)]">
        <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.09em]">Cover ≥</span>
        <select
          v-model.number="coverage"
          aria-label="Minimum cover ratio"
          class="sf-mono rounded-lg border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-paper)] px-2 py-1 text-[11.5px] font-semibold text-[color:var(--sf-ink)] outline-none focus:border-cobalt-600"
        >
          <option v-for="c in COVERS" :key="c" :value="c">{{ c }}%</option>
        </select>
      </label>

      <!-- Source Filter -->
      <label class="inline-flex items-center gap-2 text-[12px] text-[color:var(--sf-muted)]">
        <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.09em]">Source</span>
        <select
          v-model="kind"
          aria-label="Order source filter"
          class="rounded-lg border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-paper)] px-2.5 py-1 text-[12px] font-medium text-[color:var(--sf-ink)] outline-none focus:border-cobalt-600"
        >
          <option value="all">New loans + resale</option>
          <option value="new">New loans</option>
          <option value="resale">Resale</option>
          <option value="shares">Shares only</option>
        </select>
      </label>

      <!-- Matchable Only -->
      <label class="inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-medium text-[color:var(--sf-ink-2)]">
        <input v-model="matchable" type="checkbox" class="h-3.5 w-3.5 rounded accent-cobalt-600" />
        <span>Matchable only</span>
      </label>

      <!-- More Filters Popover -->
      <div ref="filterMenuRef" class="relative ml-auto" @keydown.esc="filtersOpen = false">
        <button
          type="button"
          :aria-expanded="filtersOpen"
          class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors"
          :class="
            extraFilterCount > 0 || filtersOpen
              ? 'border-cobalt-600/40 bg-cobalt-50 text-cobalt-700'
              : 'border-[color:var(--sf-line-strong)] bg-[color:var(--sf-card)] text-[color:var(--sf-ink-2)] hover:bg-[color:var(--sf-well)]'
          "
          @click="filtersOpen = !filtersOpen"
        >
          <filter-icon class="h-3.5 w-3.5" />
          <span>Filters</span>
          <span
            v-if="extraFilterCount > 0"
            class="sf-mono rounded bg-cobalt-600 px-1.5 py-0.2 text-[10px] font-semibold text-white"
          >
            {{ extraFilterCount }}
          </span>
        </button>

        <div
          v-if="filtersOpen"
          class="sf-plate absolute right-0 top-[calc(100%+8px)] z-30 w-72 space-y-3 rounded-xl p-4"
          role="dialog"
          aria-label="Additional Rate Book filters"
        >
          <label class="flex cursor-pointer items-start gap-2.5 text-[12px]">
            <input v-model="grid" type="checkbox" class="mt-0.5 h-3.5 w-3.5 rounded accent-cobalt-600" />
            <span>
              <strong class="block font-semibold text-[color:var(--sf-ink)]">Grid maturities only</strong>
              <span class="text-[11px] text-[color:var(--sf-muted)]">
                Fixed maturities on the 30-day zcs1 grid and matching windows.
              </span>
            </span>
          </label>

          <label class="flex cursor-pointer items-start gap-2.5 text-[12px]">
            <input v-model="follow" type="checkbox" class="mt-0.5 h-3.5 w-3.5 rounded accent-cobalt-600" />
            <span>
              <strong class="block font-semibold text-[color:var(--sf-ink)]">Tables follow maturity</strong>
              <span class="text-[11px] text-[color:var(--sf-muted)]">
                Limit ledger tables to the active maturity slice.
              </span>
            </span>
          </label>

          <label class="flex cursor-pointer items-start gap-2.5 text-[12px]">
            <input v-model="showFills" type="checkbox" class="mt-0.5 h-3.5 w-3.5 rounded accent-cobalt-600" />
            <span>
              <strong class="block font-semibold text-[color:var(--sf-ink)]">Fills on curve</strong>
              <span class="text-[11px] text-[color:var(--sf-muted)]">
                Overlay last 10 days of fills fading with block age.
              </span>
            </span>
          </label>

          <label class="flex cursor-pointer items-start gap-2.5 text-[12px]">
            <input v-model="showOffers" type="checkbox" class="mt-0.5 h-3.5 w-3.5 rounded accent-cobalt-600" />
            <span>
              <strong class="block font-semibold text-[color:var(--sf-ink)]">Every bid curve</strong>
              <span class="text-[11px] text-[color:var(--sf-muted)]">
                Draw each individual lend offer curve on the yield plot.
              </span>
            </span>
          </label>

          <div class="flex items-center justify-between border-t border-[color:var(--sf-line)] pt-2.5">
            <button
              type="button"
              class="text-[11.5px] font-medium text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]"
              @click="resetAllFilters"
            >
              Reset all
            </button>
            <button
              type="button"
              class="sf-btn-outline rounded-lg px-3 py-1 text-[11.5px]"
              @click="filtersOpen = false"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Primary 12-Column Quantitative Workbench -->
    <div class="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <!-- Centerpiece 4-Lens Visual Stage -->
      <div class="lg:col-span-12 xl:col-span-6">
        <rate-book-canvas
          :market="zc.activeMarket"
          :curves="curves"
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

      <!-- Synchronized Spread Ladder -->
      <div class="lg:col-span-6 xl:col-span-3">
        <order-ladder-panel
          :book="orderbook"
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

      <!-- Contextual Inspector / Order Ticket -->
      <div class="lg:col-span-6 xl:col-span-3">
        <ask-inspector
          v-if="selectedAsk"
          :key="selectedAsk.id"
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
          :key="selectedOffer.id"
          :offer="selectedOffer"
          :height="zc.height"
          :target-blocks="targetBlocks"
          :upto="upto"
          :unit="zc.durationUnit"
          :connected="zc.connected"
          :revision="zc.revision"
          @close="selected = null"
          @borrow-against="handleBorrowAgainstOffer"
        />
        <order-ticket-panel
          v-else
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
      </div>
    </div>

    <!-- Full Depth Order Ledger -->
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
      :search-query="searchQuery"
      @update:tab="ledgerTab = $event"
      @update:sort="sort = $event"
      @select-ask="selectAsk"
      @select-bid="selectBid"
      @load-more-asks="loadMoreAsks"
      @load-more-offers="loadMoreOffers"
    />

    <!-- Structured Execution Preview Modal -->
    <execution-preview-modal
      v-if="previewPayload"
      :payload="previewPayload"
      @close="previewPayload = null"
    />
  </div>

  <!-- ========================================================
       AUCTIONS WORKSPACE (/app/auctions)
       ======================================================== -->
  <div v-else-if="section === 'auctions'" class="space-y-6">
    <div>
      <h1 class="sf-serif text-[32px] font-semibold text-[color:var(--sf-ink)]">Auctions</h1>
      <p class="mt-1 text-[13px] text-[color:var(--sf-muted)]">
        Linear falling-price Dutch sale lots and post-liquidation share vault auctions.
      </p>
    </div>

    <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
      <section class="sf-plate rounded-2xl p-6">
        <div class="flex items-center justify-between border-b border-[color:var(--sf-line)] pb-3.5">
          <h2 class="sf-serif text-[19px] font-semibold">Sale Auctions</h2>
          <span class="sf-mono text-[12px] font-semibold text-[color:var(--sf-ask)]">{{
            zc.lots.length
          }}</span>
        </div>
        <div v-if="zc.lots.length" class="divide-y divide-[color:var(--sf-line)]">
          <div
            v-for="lot in zc.lots"
            :key="lot.boxId"
            class="flex items-center justify-between py-3 text-[13px]"
          >
            <div>
              <span class="sf-mono font-medium text-[color:var(--sf-ink)]">
                {{ shortenString(lot.boxId, 12) }}
              </span>
              <span class="sf-mono ml-2 text-[11px] text-[color:var(--sf-muted)]">
                {{ lot.itemCount }} items · {{ lot.phase }}
              </span>
            </div>
            <span class="sf-mono font-semibold text-[color:var(--sf-ask)]">
              {{ formatMarketAmount(lot.priceNow, lot.market) }}
            </span>
          </div>
        </div>
        <div v-else class="py-10 text-center text-[13px] text-[color:var(--sf-muted)]">
          No active sale auctions.
        </div>
      </section>

      <section class="sf-plate rounded-2xl p-6">
        <div class="flex items-center justify-between border-b border-[color:var(--sf-line)] pb-3.5">
          <h2 class="sf-serif text-[19px] font-semibold">Liquidation Auctions</h2>
          <span class="sf-mono text-[12px] font-semibold text-[color:var(--sf-ask)]">{{
            zc.vaults.length
          }}</span>
        </div>
        <div v-if="zc.vaults.length" class="divide-y divide-[color:var(--sf-line)]">
          <div
            v-for="v in zc.vaults"
            :key="v.boxId"
            class="flex items-center justify-between py-3 text-[13px]"
          >
            <div>
              <span class="sf-mono font-medium text-[color:var(--sf-ink)]">
                {{ shortenString(v.bondId, 12) }}
              </span>
              <span class="sf-mono ml-2 text-[11px] text-[color:var(--sf-muted)]">
                {{ v.vaultType }} vault
              </span>
            </div>
            <span class="sf-mono font-semibold text-[color:var(--sf-ask)]">
              {{ formatMarketAmount(v.payNow, v.market) }}
            </span>
          </div>
        </div>
        <div v-else class="py-10 text-center text-[13px] text-[color:var(--sf-muted)]">
          No active liquidation auctions.
        </div>
      </section>
    </div>
  </div>

  <!-- ========================================================
       PORTFOLIO WORKSPACE (/app/portfolio)
       ======================================================== -->
  <div v-else class="space-y-6">
    <div>
      <h1 class="sf-serif text-[32px] font-semibold text-[color:var(--sf-ink)]">Portfolio</h1>
      <p class="mt-1 text-[13px] text-[color:var(--sf-muted)]">
        Track active ZC lending positions, collateralized loans, open orders, and custody wraps.
      </p>
    </div>
    <div class="sf-plate rounded-2xl p-8 text-[14px] text-[color:var(--sf-muted)]">
      Connect Nautilus to view ZC positions and open orders once v2→v3 wallet indexing is enabled.
    </div>
  </div>
</template>
