<script setup lang="ts">
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  ShieldIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import ZcOfferView from "./ZcOfferView.vue";
import CoverMeter from "./components/CoverMeter.vue";
import ExecutionPreviewModal, { ExecutionPreviewPayload } from "./components/ExecutionPreviewModal.vue";
import ZcAssetChip from "./components/ZcAssetChip.vue";
import ZcCurveEditor, { CurveMarketOverlay } from "./components/ZcCurveEditor.vue";
import ZcFixedChart from "./components/ZcFixedChart.vue";
import ZcInteractiveChart, { ChartLayer, ChartReadout } from "./components/ZcInteractiveChart.vue";
import ZcOrderMark from "./components/ZcOrderMark.vue";
import ZcTimeEditor from "./components/ZcTimeEditor.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { zcApi } from "@/services/zcApi";
import { useZcStore } from "@/stories";
import {
  ZcAskSummary,
  ZcBondSummary,
  ZcChartMetric,
  ZcCollateralToken,
  ZcCurves,
  ZcLookupResult,
  ZcMarket,
  ZcMatchesResponse
} from "@/types/zc";
import { shortenString } from "@/utils";
import {
  combinedAskLine,
  coverage,
  dateAtHeight,
  DAY_BLOCKS,
  fixedAskDots,
  formatApr,
  formatAxisFromNow,
  formatDur,
  formatMarketAmount,
  formatNumber,
  GRID_BLOCKS,
  isHex64,
  isOracleRefreshingOnly,
  kindLabel,
  lineAt,
  liquidationPrice,
  metricMarginLeft,
  niceDomain,
  pnlTone,
  positionPnl,
  priceForYield,
  pricingName,
  resolvedAskQuote,
  SHARES_UNITS,
  signedFormat,
  SIGUSD_TOKEN_ID,
  snapMaturity,
  toChartMetric,
  windowAskLine
} from "@/utils/zcMath";

const route = useRoute();
const zc = useZcStore();

const targetId = computed(() => {
  const p = route.params.id;
  if (typeof p === "string" && p.trim()) return p.trim();
  const q = route.query.id;
  return typeof q === "string" && q.trim() ? q.trim() : "";
});

const loading = ref(true);
const error = ref<string | null>(null);
const lookup = ref<ZcLookupResult | null>(null);
const matches = ref<ZcMatchesResponse | null>(null);
const marketCurves = ref<ZcCurves | null>(null);
const marketAsks = ref<ZcAskSummary[]>([]);

const metric = ref<ZcChartMetric>("yield");
const shockPct = ref(0);
const windowPickBlocks = ref<number | null>(null);
const sharesPct = ref<number>(100);
const copied = ref(false);
const checksOpen = ref(false);
const previewPayload = ref<ExecutionPreviewPayload | null>(null);

let loadAc: AbortController | null = null;

async function loadRecord() {
  if (loadAc) loadAc.abort();
  const id = targetId.value;
  if (!id || !isHex64(id)) {
    loading.value = false;
    error.value = id ? "Invalid 64-character hex ID." : "No bond or order ID specified.";
    lookup.value = null;
    return;
  }

  const ac = new AbortController();
  loadAc = ac;
  loading.value = true;
  error.value = null;

  try {
    const res = await zcApi.lookup(id, undefined, ac.signal);
    if (ac.signal.aborted) return;
    lookup.value = res;
    if (!res || (!res.ask && !res.bond && res.type !== "offer")) {
      error.value = res?.note || "Record not found on chain.";
      loading.value = false;
      return;
    }
    if (res.type === "offer") {
      loading.value = false;
      return;
    }

    const askObj = res.ask || null;
    const bondObj = res.bond || askObj?.bond || null;
    const m: ZcMarket = askObj?.market || bondObj?.market || "ERG";

    // Resolve extra collateral token metadata if present
    const col = bondObj?.collateral || askObj?.collateral;
    const tokenIds = (col?.tokens || []).map((t) => t.id).filter(isHex64);
    if (tokenIds.length > 0) {
      const meta = await zcApi.lookupAssets(tokenIds, ac.signal).catch(() => ({}));
      if (!ac.signal.aborted && Object.keys(meta).length > 0) {
        const refreshed = await zcApi.lookup(id, meta, ac.signal).catch(() => res);
        if (!ac.signal.aborted && refreshed) lookup.value = refreshed;
      }
    }

    if (askObj?.kind === "shares") {
      sharesPct.value = (askObj.units / SHARES_UNITS) * 100;
    }
    windowPickBlocks.value = null;
    shockPct.value = 0;

    const covParam = askObj?.cov ?? bondObj?.cov ?? undefined;
    const [mRes, cRes, aRes] = await Promise.all([
      askObj ? zcApi.getMatches(askObj.id, ac.signal).catch(() => null) : Promise.resolve(null),
      zcApi
        .getCurves(
          m,
          covParam != null ? { coverage: Math.round(covParam * 100) } : undefined,
          ac.signal
        )
        .catch(() => null),
      zcApi
        .listAsksPage(m, { matchable: true, limit: 120 }, undefined, ac.signal)
        .catch(() => ({ items: [] as ZcAskSummary[], total: 0, next: null, pendingLeftOut: 0 }))
    ]);
    if (ac.signal.aborted) return;
    matches.value = mRes;
    marketCurves.value = cRes;
    marketAsks.value = aRes.items;
  } catch (err) {
    if (!ac.signal.aborted) {
      error.value = err instanceof Error ? err.message : "Failed to load record.";
      lookup.value = null;
    }
  } finally {
    if (!ac.signal.aborted) loading.value = false;
  }
}

watch(
  [targetId, () => zc.connected, () => zc.revision, () => zc.demoMode],
  () => {
    if (zc.connected || zc.demoMode) void loadRecord();
  },
  { immediate: true }
);

onBeforeUnmount(() => loadAc?.abort());

const height = computed(() =>
  zc.height > 100_000 ? zc.height : zc.demoMode ? 1_650_000 : zc.height
);
const oraclePrice = computed(() =>
  zc.oracle.price > 0.05 ? zc.oracle.price : zc.demoMode ? 1.42 : zc.oracle.price
);
const unit = computed(() => zc.durationUnit);

const isOfferRedirect = computed(() => lookup.value?.type === "offer");
const ask = computed<ZcAskSummary | null>(() => lookup.value?.ask || null);
const bond = computed<ZcBondSummary | null>(() => lookup.value?.bond || ask.value?.bond || null);
const market = computed<ZcMarket>(() => ask.value?.market || bond.value?.market || "ERG");
const recordId = computed(() => ask.value?.id || bond.value?.id || targetId.value);

const myLendPosition = computed(() => {
  const bid = bond.value?.id;
  if (!bid) return null;
  return (
    zc.portfolio.positions.find(
      (p) => p.side === "lend" && (p.bond.id === bid || p.tokenId === targetId.value)
    ) || null
  );
});

const myBorrowPosition = computed(() => {
  const bid = bond.value?.id;
  if (!bid) return null;
  return zc.portfolio.positions.find((p) => p.side === "borrow" && p.bond.id === bid) || null;
});

const isWindow = computed(() => ask.value?.pricing === "window" && !!ask.value.window);
const isSharesAsk = computed(() => ask.value?.kind === "shares");

const maxSharesPct = computed(() =>
  isSharesAsk.value && ask.value ? Math.max(0.01, (ask.value.units / SHARES_UNITS) * 100) : 100
);
const minSharesPct = computed(() =>
  isSharesAsk.value && ask.value
    ? Math.max(0.01, ((ask.value.minFill || 1) / SHARES_UNITS) * 100)
    : 100
);
const selectedShareUnits = computed(() => {
  if (!isSharesAsk.value || !ask.value) return 1;
  return Math.round(
    Math.min(
      ask.value.units,
      Math.max(ask.value.minFill || 1, (sharesPct.value / 100) * SHARES_UNITS)
    )
  );
});
const shareFrac = computed(() =>
  isSharesAsk.value && ask.value && ask.value.units > 0
    ? selectedShareUnits.value / ask.value.units
    : 1
);

const baseQuote = computed(() =>
  ask.value
    ? resolvedAskQuote(ask.value, height.value, isWindow.value ? windowPickBlocks.value : null)
    : null
);

const activeQuote = computed(() => {
  const q = baseQuote.value;
  if (!q) return null;
  if (!isSharesAsk.value || shareFrac.value === 1) return q;
  return { ...q, cost: q.cost * shareFrac.value, face: q.face * shareFrac.value };
});

const currentWindowBlocks = computed(() => {
  if (!ask.value?.window) return 0;
  return windowPickBlocks.value ?? baseQuote.value?.d ?? ask.value.window.min;
});

function snapWindowToGrid() {
  if (!ask.value?.window || !height.value) return;
  const targetH = snapMaturity(height.value + currentWindowBlocks.value, height.value);
  const d = Math.max(ask.value.window.min, Math.min(ask.value.window.max, targetH - height.value));
  windowPickBlocks.value = d;
}

const collateral = computed(() => bond.value?.collateral || ask.value?.collateral || { erg: 0, usd: 0, tokens: [] });
const repayment = computed(
  () => bond.value?.repayment ?? ask.value?.repayment ?? baseQuote.value?.face ?? 0
);
const principal = computed(
  () => activeQuote.value?.cost ?? bond.value?.principal ?? ask.value?.principal ?? null
);
const rule = computed(() => bond.value?.rule || ask.value?.rule || "maturity");
const ratio = computed(() => bond.value?.ratio ?? ask.value?.ratio ?? null);
const maxOracleAge = computed(() => bond.value?.oracleAge ?? ask.value?.oracleAge ?? 60);

const covNow = computed(() => {
  if (ask.value?.cov != null) return ask.value.cov;
  if (bond.value?.cov != null) return bond.value.cov;
  if (rule.value === "oracle" && oraclePrice.value > 0 && repayment.value > 0) {
    return coverage(collateral.value, repayment.value, market.value, oraclePrice.value);
  }
  return null;
});

const shockedPrice = computed(() => oraclePrice.value * (1 + shockPct.value / 100));
const shockedCover = computed(() => {
  if (rule.value !== "oracle" || !(shockedPrice.value > 0) || !(repayment.value > 0)) return null;
  return coverage(collateral.value, repayment.value, market.value, shockedPrice.value);
});

const liqInfo = computed(() =>
  rule.value === "oracle" && ratio.value != null && repayment.value > 0
    ? liquidationPrice(collateral.value, repayment.value, market.value, ratio.value)
    : null
);

const liqDistancePct = computed(() => {
  if (!liqInfo.value?.price || !oraclePrice.value) return null;
  return Math.abs(oraclePrice.value / liqInfo.value.price - 1) * 100;
});

// Liquidation track scaling
const trackScale = computed(() => {
  if (!liqInfo.value?.price || !(oraclePrice.value > 0)) return null;
  const lo = Math.min(liqInfo.value.price, oraclePrice.value, shockedPrice.value) * 0.65;
  const hi = Math.max(liqInfo.value.price, oraclePrice.value, shockedPrice.value) * 1.35;
  const span = Math.max(0.001, hi - lo);
  const pos = (p: number) => Math.max(0, Math.min(100, ((p - lo) / span) * 100));
  return {
    lo,
    hi,
    liqPos: pos(liqInfo.value.price),
    nowPos: pos(oraclePrice.value),
    shockPos: pos(shockedPrice.value),
    dir: liqInfo.value.dir
  };
});

// Lifecycle progress for live bonds
const lifecycle = computed(() => {
  const b = bond.value;
  if (!b || !b.maturity) return null;
  const start = b.start || b.created || height.value;
  const total = Math.max(1, b.maturity - start);
  const elapsed = Math.max(0, Math.min(total, height.value - start));
  const rem = Math.max(0, b.maturity - height.value);
  return {
    pct: (elapsed / total) * 100,
    rem,
    matured: rem === 0
  };
});

// Bid / Ask lines for charts
const askById = computed(() => new Map(marketAsks.value.map((a) => [a.id, a])));
const bidLine = computed(() => marketCurves.value?.bidLine || []);
const askLine = computed(() => windowAskLine(marketCurves.value, askById.value, height.value));

const curveMarketOverlay = computed<CurveMarketOverlay>(() => ({
  bidLine: bidLine.value,
  askLine: askLine.value,
  askFit: combinedAskLine(marketCurves.value, askById.value, height.value),
  dots: fixedAskDots(marketCurves.value)
}));

function askDAt(at: number): number {
  const a = ask.value;
  if (!a) return 0;
  if (a.kind === "order" && a.mode === "term") return a.duration || DAY_BLOCKS;
  const mat = a.maturity ?? a.bond?.maturity ?? a.quote?.maturity ?? 0;
  return Math.max(0, mat - at);
}

function askBidAt(at: number): number | null {
  const d = askDAt(at);
  return d > 0 ? lineAt(bidLine.value, d) : null;
}

const askExpiryEnd = computed(() => {
  const a = ask.value;
  if (!a) return height.value + 7 * DAY_BLOCKS;
  const mat = a.maturity ?? a.bond?.maturity ?? a.quote?.maturity ?? height.value + 30 * DAY_BLOCKS;
  const raw = a.expiry || height.value + 7 * DAY_BLOCKS;
  return a.mode === "term" ? Math.max(height.value + 30, raw) : Math.max(height.value + 30, Math.min(raw, mat - 4));
});

// Value-to-maturity chart (for live bonds without an active ask)
const bondValueChart = computed(() => {
  const b = bond.value;
  if (!b || ask.value || !(b.maturity > height.value)) return null;
  const rem = b.maturity - height.value;
  const steps = 48;
  const xs = Array.from({ length: steps + 1 }, (_, i) => height.value + (rem * i) / steps);
  const face = b.repayment;
  const mv = metric.value;
  const bidPts = xs.map((at) => {
    const d = Math.max(1, b.maturity - at);
    const yBps = lineAt(bidLine.value, d);
    return { x: (at - height.value) / DAY_BLOCKS, y: yBps != null ? toChartMetric(yBps, d, mv, face) : null };
  });
  const askPts = xs.map((at) => {
    const d = Math.max(1, b.maturity - at);
    const yBps = lineAt(askLine.value, d);
    return { x: (at - height.value) / DAY_BLOCKS, y: yBps != null ? toChartMetric(yBps, d, mv, face) : null };
  });

  const layers: ChartLayer[] = [];
  if (bidPts.some((p) => p.y != null)) {
    layers.push({ type: "area", key: "bv-area", points: bidPts, color: "var(--sf-bid)", opacity: 0.1 });
    layers.push({ type: "line", key: "bv-bid", points: bidPts, color: "var(--sf-bid)", width: 2.3 });
  }
  if (askPts.some((p) => p.y != null)) {
    layers.push({ type: "line", key: "bv-ask", points: askPts, color: "var(--sf-ask)", width: 1.7, dash: "5 4" });
  }
  const standingDots = fixedAskDots(marketCurves.value)
    .filter((dot) => dot.d > 0 && dot.d <= rem)
    .map((dot) => ({
      id: dot.id,
      x: (rem - dot.d) / DAY_BLOCKS,
      y: toChartMetric(dot.y, dot.d, mv, face),
      r: 3.6,
      color: "var(--sf-ask)",
      opacity: 0.82
    }));
  if (standingDots.length > 0) {
    layers.push({ type: "dots", key: "bv-dots", points: standingDots });
  }
  if (mv === "pct") {
    layers.push({ type: "hline", key: "par", y: 100, color: "var(--sf-dim)", dash: "2 5", label: "100% face" });
  } else if (mv === "abs") {
    layers.push({ type: "hline", key: "par", y: face, color: "var(--sf-dim)", dash: "2 5", label: `face ${formatMarketAmount(face, market.value)}` });
  }
  if (myLendPosition.value?.paid != null && mv !== "yield") {
    const costY = mv === "pct" ? (myLendPosition.value.paid / face) * 100 : myLendPosition.value.paid;
    layers.push({
      type: "hline",
      key: "cost",
      y: costY,
      color: "var(--sf-cobalt)",
      dash: "3 4",
      label: `paid ${formatMarketAmount(myLendPosition.value.paid, market.value)}`
    });
  }

  const allY: number[] = [];
  for (const p of [...bidPts, ...askPts]) if (p.y != null) allY.push(p.y);
  if (mv === "pct") allY.push(100);
  if (mv === "abs") allY.push(face);
  return {
    layers,
    xDomain: [0, Math.max(rem / DAY_BLOCKS, 1)] as [number, number],
    yDomain: niceDomain(allY.length ? allY : [0, 12], 0.14, mv === "yield")
  };
});

function bondHoverReadout(daysFromNow: number): ChartReadout | null {
  const b = bond.value;
  if (!b) return null;
  const at = Math.round(height.value + daysFromNow * DAY_BLOCKS);
  const d = Math.max(1, b.maturity - at);
  const bid = lineAt(bidLine.value, d);
  const askV = lineAt(askLine.value, d);
  const rows: ChartReadout["rows"] = [];
  const marks: ChartReadout["marks"] = [];
  if (bid != null) {
    const px = priceForYield(b.repayment, bid, d);
    marks.push({ y: toChartMetric(bid, d, metric.value, b.repayment), color: "var(--sf-bid)" });
    rows.push({
      label: "Best bid",
      value: `${formatApr(bid)} · ${formatMarketAmount(px, market.value)}`,
      tone: "bid"
    });
  }
  if (askV != null) {
    marks.push({ y: toChartMetric(askV, d, metric.value, b.repayment), color: "var(--sf-ask)" });
    rows.push({ label: "Best ask", value: formatApr(askV), tone: "ask" });
  }
  return {
    header: daysFromNow < 0.04 ? "Now" : `In ${formatDur(at - height.value, unit.value)}`,
    subHeader: `${formatDur(d, unit.value)} left · ${dateAtHeight(at, height.value)}`,
    marks,
    rows
  };
}

const fmtAmt = (x: number) => formatMarketAmount(x, market.value);

// Position P&L when user holds this bond
const myPnl = computed(() => {
  const pos = myLendPosition.value;
  if (!pos || pos.paid == null || !bond.value) return null;
  const summary = positionPnl(pos, height.value, oraclePrice.value);
  const rem = Math.max(1, bond.value.maturity - height.value);
  const bestBid = lineAt(bidLine.value, rem);
  const valNow =
    summary.value ?? (bestBid != null ? priceForYield(summary.face, bestBid, rem) : null);
  const pnlVal = summary.pnl ?? (valNow != null && pos.paid != null ? valNow - pos.paid : null);
  return {
    face: summary.face,
    valNow,
    summary: { ...summary, pnl: pnlVal }
  };
});

// Collateral composition breakdown
const colBreakdown = computed(() => {
  const items: {
    key: string;
    label: string;
    amount: string;
    usd: number | null;
    token: ZcCollateralToken;
  }[] = [];
  if (collateral.value.erg > 0) {
    items.push({
      key: "ERG",
      label: "ERG",
      amount: `${formatNumber(collateral.value.erg, 3, 0)} ERG`,
      usd: oraclePrice.value > 0 ? collateral.value.erg * oraclePrice.value : null,
      token: {
        id: "ERG",
        ticker: "ERG",
        name: "Ergo",
        decimals: 9,
        amount: collateral.value.erg,
        rawAmount: String(Math.round(collateral.value.erg * 1e9)),
        kind: "token",
        verified: true
      }
    });
  }
  if (collateral.value.usd > 0) {
    items.push({
      key: "SigUSD",
      label: "SigUSD",
      amount: `${formatNumber(collateral.value.usd, 2, 0)} SigUSD`,
      usd: collateral.value.usd,
      token: {
        id: SIGUSD_TOKEN_ID,
        ticker: "SigUSD",
        name: "SigmaUSD",
        decimals: 2,
        amount: collateral.value.usd,
        rawAmount: String(Math.round(collateral.value.usd * 100)),
        kind: "token",
        verified: true
      }
    });
  }
  for (const t of collateral.value.tokens || []) {
    items.push({
      key: t.id,
      label: t.ticker || t.name || shortenString(t.id, 10),
      amount: `${formatNumber(t.amount, 4, 0)} ${t.ticker || ""}`.trim(),
      usd: null,
      token: t
    });
  }
  const totalUsd = items.reduce((s, x) => s + (x.usd || 0), 0);
  return { items, totalUsd };
});

const checks = computed(() => ask.value?.checks || bond.value?.checks || []);
const checkStats = computed(() => ({
  total: checks.value.length,
  passed: checks.value.filter((c) => c.ok === true).length,
  failed: checks.value.filter((c) => c.ok === false).length
}));

const matchingOfferCount = computed(() => matches.value?.offers?.length ?? 0);
const isBuyback = computed(() => !!ask.value?.borrowedByMe && ask.value.kind !== "order" && !ask.value.owner);
const usable = computed(() => !ask.value || ask.value.ok || isOracleRefreshingOnly(ask.value));

const pageTitle = computed(() => {
  if (ask.value) {
    if (ask.value.kind === "order") return "Borrow Order";
    if (ask.value.kind === "shares") return "Bond Shares Resale";
    return "Bond Resale";
  }
  if (lookup.value?.type === "shares") return "Bond Shares";
  return "Zero-Coupon Bond";
});

const markKind = computed<"order" | "unit" | "shares">(() => {
  if (ask.value) return ask.value.kind;
  if (lookup.value?.type === "shares" || bond.value?.vault) return "shares";
  return "unit";
});

async function copyId() {
  try {
    await navigator.clipboard.writeText(recordId.value);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // ignore
  }
}

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

function openActionPreview(kind: "fill" | "cancel" | "repay" | "addCollateral" | "extinguish" | "unfrac") {
  const q = activeQuote.value;
  const m = market.value;

  if (kind === "fill" && ask.value && q) {
    previewPayload.value = {
      title: isBuyback.value
        ? "Buy Back & Extinguish Bond"
        : ask.value.kind === "order"
          ? "Fund Borrow Order"
          : "Buy Bond Position",
      subtitle: `${pricingName(ask.value)} · ${m} market`,
      badge: `${kindLabel(ask.value.kind)} · ${m}`,
      tone: "bid",
      heroLabel: "You pay",
      heroValue: formatMarketAmount(q.cost, m),
      heroSub: `Repays ${formatMarketAmount(q.face, m)} at ${formatApr(q.yieldBps)}`,
      rows: [
        { label: "Listing", value: shortenString(ask.value.id, 14) },
        { label: "Term", value: `${formatDur(q.d, unit.value)} (${dateAtHeight(q.maturity, height.value)})` },
        ...(isSharesAsk.value ? [{ label: "Shares", value: `${formatNumber((selectedShareUnits.value / SHARES_UNITS) * 100, 2, 0)}%` }] : []),
        { label: "Cover", value: covNow.value != null ? `${Math.round(covNow.value)}%` : "Maturity only" }
      ],
      rawSummary: {
        action: ask.value.kind === "order" ? "fundOrder" : "buyAsk",
        boxId: ask.value.boxId,
        market: m,
        maturity: q.maturity,
        units: selectedShareUnits.value
      }
    };
    return;
  }

  if (kind === "cancel" && ask.value) {
    previewPayload.value = {
      title: ask.value.kind === "order" ? "Cancel Borrow Order" : "Cancel Resale Listing",
      subtitle: "Returns locked collateral or bond tokens to Nautilus",
      badge: `Cancel · ${m}`,
      tone: "ask",
      heroLabel: "Returning",
      heroValue: ask.value.kind === "order" ? "Collateral basket" : formatMarketAmount(repayment.value, m),
      heroSub: shortenString(ask.value.id, 14),
      rows: [{ label: "Box ID", value: shortenString(ask.value.boxId, 16) }],
      rawSummary: { action: ask.value.kind === "order" ? "cancelOrder" : "cancelAsk", boxId: ask.value.boxId }
    };
    return;
  }

  if (kind === "repay" && bond.value) {
    previewPayload.value = {
      title: "Repay Zero-Coupon Bond",
      subtitle: "Repays face value and unlocks your collateral basket",
      badge: `Repay · ${m}`,
      tone: "bid",
      heroLabel: "Repayment due",
      heroValue: formatMarketAmount(bond.value.repayment, m),
      heroSub: `Bond ${shortenString(bond.value.id, 14)}`,
      rows: [
        { label: "Collateral unlocked", value: colBreakdown.value.items.map((i) => i.amount).join(" + ") || "—" },
        { label: "Maturity", value: dateAtHeight(bond.value.maturity, height.value) }
      ],
      rawSummary: { action: "repayBond", bondId: bond.value.id }
    };
    return;
  }

  if (kind === "addCollateral" && bond.value) {
    previewPayload.value = {
      title: "Add Bond Collateral",
      subtitle: "Top up collateral to raise cover ratio and lower liquidation risk",
      badge: `Top Up · ${m}`,
      tone: "cobalt",
      heroLabel: "Current cover",
      heroValue: covNow.value != null ? `${Math.round(covNow.value)}%` : "—",
      heroSub: liqInfo.value?.price ? `Liquidation ${liqInfo.value.dir === "below" ? "≤" : "≥"} $${liqInfo.value.price.toFixed(3)}` : undefined,
      rows: [{ label: "Bond", value: shortenString(bond.value.id, 14) }],
      rawSummary: { action: "addCollateral", bondId: bond.value.id }
    };
    return;
  }

  if (kind === "extinguish" && bond.value) {
    previewPayload.value = {
      title: "Extinguish Bond",
      subtitle: "Burns bond unit you hold against your own debt and releases collateral",
      badge: `Extinguish · ${m}`,
      tone: "bid",
      heroLabel: "Debt extinguished",
      heroValue: formatMarketAmount(bond.value.repayment, m),
      heroSub: "No cash repayment required",
      rows: [{ label: "Bond", value: shortenString(bond.value.id, 14) }],
      rawSummary: { action: "extinguishBond", bondId: bond.value.id }
    };
    return;
  }

  if (kind === "unfrac" && bond.value) {
    previewPayload.value = {
      title: "Un-fractionalize Bond Shares",
      subtitle: "Recombines 100% of shares back into a whole bond unit",
      badge: `Recombine · ${m}`,
      tone: "cobalt",
      heroLabel: "Whole bond unit",
      heroValue: formatMarketAmount(bond.value.repayment, m),
      rows: [{ label: "Bond", value: shortenString(bond.value.id, 14) }],
      rawSummary: { action: "unfractionalize", bondId: bond.value.id }
    };
  }
}
</script>

<template>
  <!-- Seamless delegation when an offer ID is visited under /app/bond/:id -->
  <zc-offer-view v-if="isOfferRedirect" :id-override="targetId" />

  <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
    <!-- Loading -->
    <div
      v-if="loading && !ask && !bond"
      class="sf-terminal-plate flex min-h-[320px] flex-1 items-center justify-center rounded-[22px] p-8"
    >
      <span class="sf-mono text-[12px] text-[color:var(--sf-muted)]">Loading bond terms…</span>
    </div>

    <!-- Error -->
    <div
      v-else-if="error || (!ask && !bond)"
      class="sf-terminal-plate flex min-h-[320px] flex-1 flex-col items-center justify-center rounded-[22px] p-8 text-center"
    >
      <alert-circle-icon class="h-8 w-8 text-[color:var(--sf-ask)]" />
      <h2 class="sf-display mt-3 text-[19px] font-bold text-[color:var(--sf-ink)]">
        {{ error || "Bond not found" }}
      </h2>
      <router-link
        to="/app"
        class="sf-btn-outline mt-4 inline-flex h-9 items-center gap-1.5 rounded-full px-5 text-[12.5px]"
      >
        <arrow-left-icon class="h-3.5 w-3.5" />
        <span>Back to Yield Curve</span>
      </router-link>
    </div>

    <!-- Main Bond / Order Content -->
    <template v-else>
      <!-- Continuation / Spent Banner -->
      <div
        v-if="lookup?.current && lookup.current !== targetId"
        class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-3.5 py-2 text-[12px]"
      >
        <span class="text-[color:var(--sf-ink)]">
          Showing updated record for this UTXO chain.
        </span>
        <router-link
          :to="{ name: 'zc-bond', params: { id: lookup.current } }"
          class="sf-mono inline-flex items-center gap-1 font-semibold text-[color:var(--sf-cobalt)] hover:underline"
        >
          <span>Open active record</span>
          <arrow-up-right-icon class="h-3.5 w-3.5" />
        </router-link>
      </div>

      <!-- Top Identity & KPI Banner -->
      <header class="sf-terminal-plate rounded-[18px] rounded-tl-[6px] p-3.5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            <router-link
              to="/app"
              class="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] transition-colors hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-ink)]"
              title="Back to Yield Curve"
            >
              <arrow-left-icon class="h-4 w-4" />
            </router-link>

            <div class="relative grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[color:var(--sf-ask-soft)] ring-1 ring-[color:var(--sf-line-ask)]">
              <zc-order-mark :kind="markKind" :size="32" :market="market" />
            </div>

            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h1 class="sf-display text-[19px] font-bold leading-tight text-[color:var(--sf-ink)]">
                  {{ pageTitle }}
                </h1>
                <span class="inline-flex items-center gap-1 rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-0.5 text-[11px] font-semibold text-[color:var(--sf-ink)]">
                  <market-coin :market="market" :size="13" />
                  <span>{{ market }}</span>
                </span>
                <span
                  class="sf-mono rounded-[5px] px-2 py-0.5 text-[10px] font-semibold uppercase"
                  :class="
                    ask
                      ? usable
                        ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                        : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                      : 'bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                  "
                >
                  {{ ask ? (ask.pending ? "Pending" : usable ? "Live" : ask.reason) : bond?.state || "Live" }}
                </span>
                <span
                  v-if="ask?.owner || myLendPosition"
                  class="sf-mono rounded-[5px] bg-[color:var(--sf-cobalt-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[color:var(--sf-cobalt)]"
                >
                  Yours
                </span>
              </div>

              <div class="mt-1 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="sf-mono inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
                  @click="copyId"
                >
                  <span>{{ shortenString(recordId, 18) }}</span>
                  <check-icon v-if="copied" class="h-3 w-3 text-[color:var(--sf-bid)]" />
                  <copy-icon v-else class="h-3 w-3 opacity-70" />
                </button>
                <span class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
                  · {{ ask ? pricingName(ask) : rule === "oracle" ? `Oracle ≥ ${ratio}%` : "Maturity only" }}
                </span>
              </div>
            </div>
          </div>

          <!-- 4 KPI Cells -->
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                {{ ask ? "Cost now" : "Principal" }}
              </div>
              <div class="sf-mono mt-0.5 text-[14px] font-bold text-[color:var(--sf-ink)]">
                {{ formatMarketAmount(principal, market) }}
              </div>
            </div>
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Repayment
              </div>
              <div class="sf-mono mt-0.5 text-[14px] font-bold text-[color:var(--sf-ink)]">
                {{ formatMarketAmount(activeQuote?.face ?? repayment, market) }}
              </div>
            </div>
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                {{ ask ? "APR" : "Interest" }}
              </div>
              <div class="sf-mono mt-0.5 text-[14px] font-bold text-[color:var(--sf-ask)]">
                {{
                  activeQuote
                    ? formatApr(activeQuote.yieldBps)
                    : principal != null && repayment > principal
                      ? formatMarketAmount(repayment - principal, market)
                      : "—"
                }}
              </div>
            </div>
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                {{ lifecycle ? "Remaining" : "Term" }}
              </div>
              <div class="sf-mono mt-0.5 text-[14px] font-bold text-[color:var(--sf-ink)]">
                {{
                  activeQuote
                    ? formatDur(activeQuote.d, unit)
                    : lifecycle
                      ? lifecycle.matured
                        ? "Matured"
                        : formatDur(lifecycle.rem, unit)
                      : "—"
                }}
              </div>
            </div>
          </div>
        </div>

        <!-- Integrated Lifecycle Progress Bar (live bonds) -->
        <div
          v-if="lifecycle && bond"
          class="mt-3 flex items-center gap-2.5 border-t border-[color:var(--sf-line)] pt-2.5"
        >
          <span class="sf-mono text-[10px] text-[color:var(--sf-dim)]">
            Issued {{ dateAtHeight(bond.start, height) }}
          </span>
          <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--sf-line-strong)]">
            <div
              class="h-full rounded-full bg-[color:var(--sf-cobalt)] transition-all duration-500"
              :style="{ width: `${lifecycle.pct}%` }"
            />
          </div>
          <span class="sf-mono text-[10px] font-semibold text-[color:var(--sf-ink-2)]">
            Matures {{ dateAtHeight(bond.maturity, height) }}
          </span>
        </div>
      </header>

      <!-- Main 2-column Body -->
      <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_348px]">
        <!-- LEFT COLUMN -->
        <div class="flex min-h-0 flex-col gap-3">
          <!-- Pricing / Value-to-Maturity Plate -->
          <section class="sf-terminal-plate rounded-[20px] p-3.5">
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                {{
                  ask
                    ? isWindow
                      ? "Variable Maturity Curve"
                      : "Pricing Over Fill Time"
                    : "Market Value to Maturity"
                }}
              </span>

              <div v-if="!ask && bondValueChart" class="sf-seg">
                <button
                  type="button"
                  class="sf-seg-btn !h-6 !px-2 !text-[10.5px]"
                  :class="metric === 'yield' ? 'is-active tone-cobalt' : ''"
                  @click="metric = 'yield'"
                >
                  APR
                </button>
                <button
                  type="button"
                  class="sf-seg-btn !h-6 !px-2 !text-[10.5px]"
                  :class="metric === 'pct' ? 'is-active tone-cobalt' : ''"
                  @click="metric = 'pct'"
                >
                  % Face
                </button>
                <button
                  type="button"
                  class="sf-seg-btn !h-6 !px-2 !text-[10.5px]"
                  :class="metric === 'abs' ? 'is-active tone-cobalt' : ''"
                  @click="metric = 'abs'"
                >
                  {{ market }}
                </button>
              </div>
            </div>

            <zc-curve-editor
              v-if="ask && isWindow && ask.points && ask.window"
              :points="ask.points"
              :lo="ask.window.min"
              :hi="ask.window.max"
              side="window"
              :market="curveMarketOverlay"
              :cap="ask.cap"
              :face="repayment"
              :asset="market"
              :metric="metric"
              :height="height"
              :unit="unit"
              read-only
              :chart-height="250"
              @update:metric="metric = $event"
            />
            <zc-time-editor
              v-else-if="ask && ask.pricing === 'yield' && ask.tp"
              :tp="ask.tp"
              :height="height"
              :end="askExpiryEnd"
              :d-at="askDAt"
              :face="repayment"
              :floor="ask.floor"
              :bid-at="askBidAt"
              :asset="market"
              :cost-basis="myLendPosition?.paid ?? null"
              :metric="metric"
              :unit="unit"
              :role="ask.kind === 'order' ? 'borrow' : 'sell'"
              read-only
              :chart-height="245"
              @update:metric="metric = $event"
            />
            <zc-fixed-chart
              v-else-if="ask"
              :principal="activeQuote?.cost ?? principal ?? 0"
              :repayment="activeQuote?.face ?? repayment"
              :height="height"
              :expiry-h="askExpiryEnd"
              :d-at="askDAt"
              :bid-at="askBidAt"
              :asset="market"
              :cost-basis="myLendPosition?.paid ?? null"
              :metric="metric"
              :unit="unit"
              :role="ask.kind === 'order' ? 'borrow' : 'sell'"
              :chart-height="240"
              @update:metric="metric = $event"
            />
            <zc-interactive-chart
              v-else-if="bondValueChart"
              :height="245"
              :x-domain="bondValueChart.xDomain"
              :y-domain="bondValueChart.yDomain"
              :x-format="(v) => formatAxisFromNow(v, unit)"
              :y-format="(v) => (metric === 'abs' ? formatNumber(v, 2, 0) : `${formatNumber(v, 1, 0)}%`)"
              :margin-left="metricMarginLeft(bondValueChart.yDomain, metric, market)"
              :layers="bondValueChart.layers"
              :hover-fn="bondHoverReadout"
              label="Bond market value path to maturity"
            />
            <div
              v-else
              class="sf-dock-well rounded-xl px-4 py-6 text-center text-[12px] text-[color:var(--sf-muted)]"
            >
              Bond has reached maturity.
            </div>
          </section>

          <!-- Collateral & Liquidation Plate -->
          <section class="sf-terminal-plate rounded-[18px] p-3.5">
            <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2.5">
                <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                  Collateral &amp; Liquidation
                </span>
                <cover-meter
                  :value="shockPct !== 0 ? shockedCover : covNow"
                  :ratio="rule === 'oracle' ? ratio : null"
                  :guard="ask?.guard?.ratio ?? null"
                />
              </div>

              <div v-if="rule === 'oracle' && oraclePrice > 0" class="flex items-center gap-2 text-[11px]">
                <span class="sf-mono text-[color:var(--sf-muted)]">
                  ERG ${{ oraclePrice.toFixed(3) }}
                </span>
                <span
                  v-if="liqInfo?.price"
                  class="sf-mono font-semibold text-[color:var(--sf-ask)]"
                >
                  Liq {{ liqInfo.dir === "below" ? "≤" : "≥" }} ${{ liqInfo.price.toFixed(3) }}
                  <template v-if="liqDistancePct != null">
                    ({{ liqDistancePct.toFixed(1) }}%)
                  </template>
                </span>
              </div>
            </div>

            <!-- Interactive ERG Shock & Liquidation Track -->
            <div v-if="trackScale && rule === 'oracle'" class="sf-dock-well mb-3 rounded-xl px-3 py-2.5">
              <div class="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span class="sf-mono text-[10px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                  ERG Price Stress Test
                </span>
                <div class="flex items-center gap-2">
                  <span
                    class="sf-mono font-semibold"
                    :class="
                      shockedCover != null && ratio != null && shockedCover < ratio
                        ? 'text-[color:var(--sf-danger)]'
                        : 'text-[color:var(--sf-ink)]'
                    "
                  >
                    ${{ shockedPrice.toFixed(3) }} ({{ shockPct >= 0 ? "+" : "" }}{{ shockPct }}%) →
                    {{ shockedCover != null ? `${Math.round(shockedCover)}% cover` : "—" }}
                  </span>
                  <button
                    v-if="shockPct !== 0"
                    type="button"
                    class="sf-mono text-[10px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                    @click="shockPct = 0"
                  >
                    Reset
                  </button>
                </div>
              </div>

              <!-- Visual Liquidation Track -->
              <div class="relative mt-2.5 h-2.5 overflow-hidden rounded-full bg-[color:var(--sf-line-strong)]">
                <!-- Liquidation danger zone -->
                <div
                  class="absolute top-0 h-full bg-[color:var(--sf-danger)] opacity-35"
                  :style="
                    trackScale.dir === 'below'
                      ? { left: '0%', width: `${trackScale.liqPos}%` }
                      : { left: `${trackScale.liqPos}%`, width: `${100 - trackScale.liqPos}%` }
                  "
                />
                <!-- Liquidation trigger pin -->
                <span
                  class="absolute top-0 h-full w-[2px] bg-[color:var(--sf-danger)]"
                  :style="{ left: `${trackScale.liqPos}%` }"
                  title="Liquidation trigger"
                />
                <!-- Current oracle pin -->
                <span
                  class="absolute top-0 h-full w-[2.5px] bg-[color:var(--sf-bid)]"
                  :style="{ left: `${trackScale.nowPos}%` }"
                  title="Current ERG oracle price"
                />
                <!-- Shocked pin -->
                <span
                  v-if="shockPct !== 0"
                  class="absolute top-0 h-full w-[3px] bg-[color:var(--sf-cobalt)]"
                  :style="{ left: `${trackScale.shockPos}%` }"
                  title="Stressed ERG price"
                />
              </div>

              <input
                v-model.number="shockPct"
                type="range"
                min="-50"
                max="50"
                step="1"
                class="sf-range mt-2 w-full"
                aria-label="ERG price shock percentage"
              />
            </div>

            <!-- Collateral Asset Cards (bond links + wrap receipt hover tooltips) -->
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <zc-asset-chip
                v-for="item in colBreakdown.items"
                :key="item.key"
                :token="item.token"
                :usd="item.usd"
                :height="height"
                variant="card"
              />
            </div>
          </section>

          <!-- Owned Position P&L Plate -->
          <section v-if="myPnl?.summary" class="sf-terminal-plate rounded-[18px] p-3.5">
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                Your Position P&amp;L
              </span>
              <span
                class="sf-mono text-[12px] font-bold"
                :class="
                  pnlTone(myPnl.summary.pnl) === 'bid'
                    ? 'text-[color:var(--sf-bid)]'
                    : pnlTone(myPnl.summary.pnl) === 'danger'
                      ? 'text-[color:var(--sf-danger)]'
                      : 'text-[color:var(--sf-muted)]'
                "
              >
                {{ signedFormat(myPnl.summary.pnl, fmtAmt) }}
              </span>
            </div>

            <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div class="sf-dock-well rounded-xl px-3 py-2">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)]">Paid</div>
                <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
                  {{ formatMarketAmount(myLendPosition?.paid, market) }}
                </div>
              </div>
              <div class="sf-dock-well rounded-xl px-3 py-2">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)]">Mark now</div>
                <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
                  {{ formatMarketAmount(myPnl.valNow, market) }}
                </div>
              </div>
              <div class="sf-dock-well rounded-xl px-3 py-2">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)]">APR earned</div>
                <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-cobalt)]">
                  {{ formatApr(myPnl.summary.heldApr) }}
                </div>
              </div>
              <div class="sf-dock-well rounded-xl px-3 py-2">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)]">At maturity</div>
                <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-bid)]">
                  {{ signedFormat(myPnl.summary.atMaturity, fmtAmt) }}
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- RIGHT ACTION DOCK -->
        <aside
          class="sf-action-dock flex flex-col self-start rounded-[22px] rounded-tr-[6px]"
          :data-tone="ask ? 'ask' : 'cobalt'"
          aria-label="Bond Action Panel"
          @mousemove="onDockPointerMove"
        >
          <div class="sf-panel-head px-4 pt-3.5 pb-3">
            <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              {{ ask ? (isBuyback ? "Buyback cost" : "You pay") : "Face value at maturity" }}
            </div>
            <div
              class="sf-serif mt-0.5 text-[32px] font-semibold leading-none"
              :class="ask ? 'text-[color:var(--sf-ask)]' : 'text-[color:var(--sf-ink)]'"
            >
              {{ formatMarketAmount(activeQuote?.cost ?? repayment, market) }}
            </div>
            <div v-if="activeQuote" class="sf-mono mt-1 text-[11.5px] text-[color:var(--sf-ink-2)]">
              Repays {{ formatMarketAmount(activeQuote.face, market) }} · {{ formatApr(activeQuote.yieldBps) }}
            </div>
          </div>

          <div class="space-y-2.5 px-4 py-3">
            <!-- Window Maturity Picker (for variable maturity orders) -->
            <div v-if="ask && isWindow && ask.window" class="sf-dock-well rounded-xl px-3 py-2.5">
              <div class="flex items-center justify-between gap-2">
                <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                  Pick maturity
                </span>
                <button
                  type="button"
                  class="sf-mono text-[10px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                  @click="snapWindowToGrid"
                >
                  {{ (height + currentWindowBlocks) % GRID_BLOCKS === 0 ? "On grid" : "Snap to grid" }}
                </button>
              </div>
              <input
                type="range"
                :min="ask.window.min"
                :max="ask.window.max"
                :value="currentWindowBlocks"
                class="sf-range mt-2 w-full"
                @input="windowPickBlocks = Number(($event.target as HTMLInputElement).value)"
              />
              <div class="sf-mono mt-1 flex justify-between text-[10px] text-[color:var(--sf-ink-2)]">
                <span>{{ formatDur(currentWindowBlocks, unit) }}</span>
                <span>{{ dateAtHeight(height + currentWindowBlocks, height) }}</span>
              </div>
            </div>

            <!-- Share Lot Slider (for share asks) -->
            <div v-if="ask && isSharesAsk" class="sf-dock-well rounded-xl px-3 py-2.5">
              <div class="flex items-center justify-between gap-2">
                <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                  Shares to buy
                </span>
                <span class="sf-mono text-[11px] font-bold text-[color:var(--sf-ink)]">
                  {{ formatNumber((selectedShareUnits / SHARES_UNITS) * 100, 2, 0) }}%
                </span>
              </div>
              <input
                v-model.number="sharesPct"
                type="range"
                :min="minSharesPct"
                :max="maxSharesPct"
                step="0.5"
                class="sf-range mt-2 w-full"
              />
            </div>

            <!-- Live Matches Banner -->
            <div
              v-if="ask && matchingOfferCount > 0"
              class="rounded-xl border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] px-3 py-2 text-[12px] font-semibold text-[color:var(--sf-bid)]"
            >
              {{ matchingOfferCount }} live offer{{ matchingOfferCount === 1 ? "" : "s" }} would fill this now
            </div>

            <!-- zcs1 Verification Badge -->
            <div v-if="checks.length > 0" class="sf-dock-well rounded-xl px-3 py-2">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 text-left"
                @click="checksOpen = !checksOpen"
              >
                <div class="flex items-center gap-1.5">
                  <shield-icon
                    class="h-3.5 w-3.5"
                    :class="
                      checkStats.failed > 0
                        ? 'text-[color:var(--sf-ask)]'
                        : 'text-[color:var(--sf-bid)]'
                    "
                  />
                  <span class="sf-mono text-[11px] font-semibold text-[color:var(--sf-ink)]">
                    {{
                      checkStats.failed > 0
                        ? `${checkStats.failed} check warning${checkStats.failed === 1 ? "" : "s"}`
                        : `zcs1 Verified (${checkStats.passed}/${checkStats.total})`
                    }}
                  </span>
                </div>
                <chevron-up-icon v-if="checksOpen" class="h-3.5 w-3.5 text-[color:var(--sf-muted)]" />
                <chevron-down-icon v-else class="h-3.5 w-3.5 text-[color:var(--sf-muted)]" />
              </button>

              <div v-if="checksOpen" class="mt-2 space-y-1 border-t border-[color:var(--sf-line)] pt-2">
                <div
                  v-for="c in checks"
                  :key="c.key"
                  class="flex items-start gap-1.5 text-[11px]"
                >
                  <check-circle-icon
                    v-if="c.ok === true"
                    class="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--sf-bid)]"
                  />
                  <alert-circle-icon
                    v-else
                    class="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--sf-ask)]"
                  />
                  <span class="text-[color:var(--sf-ink-2)]">{{ c.detail }}</span>
                </div>
              </div>
            </div>

            <!-- Contract KV -->
            <div class="divide-y divide-[color:var(--sf-line)] rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 text-[11.5px]">
              <div class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Liquidation</span>
                <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
                  {{ rule === "oracle" && ratio != null ? `< ${Math.round(ratio)}%` : "Maturity only" }}
                </span>
              </div>
              <div v-if="rule === 'oracle'" class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Oracle max age</span>
                <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">{{ maxOracleAge }} blk</span>
              </div>
              <div v-if="ask?.guard" class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Guard</span>
                <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
                  ≥ {{ Math.round(ask.guard.ratio) }}%
                </span>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Recovery</span>
                <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
                  {{
                    bond?.vault === "selective"
                      ? "Selective vault"
                      : bond?.vault
                        ? "Dutch vault"
                        : "In kind"
                  }}
                </span>
              </div>
              <div v-if="ask?.expiry" class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Expires</span>
                <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
                  {{ formatDur(Math.max(0, ask.expiry - height), unit) }}
                </span>
              </div>
            </div>
          </div>

          <!-- Contextual CTAs -->
          <div class="space-y-2 border-t border-[color:var(--sf-line)] p-3.5">
            <template v-if="ask">
              <button
                v-if="ask.owner"
                type="button"
                class="sf-btn-ask flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px]"
                @click="openActionPreview('cancel')"
              >
                <span>Cancel Listing</span>
                <arrow-right-icon class="h-4 w-4" />
              </button>
              <button
                v-else
                type="button"
                class="sf-btn-bid flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px] disabled:opacity-45"
                :disabled="!usable || !activeQuote"
                @click="openActionPreview('fill')"
              >
                <span>
                  {{
                    isBuyback
                      ? "Buy Back & Extinguish"
                      : ask.kind === "order"
                        ? "Fund Borrow Order"
                        : "Buy Position"
                  }}
                </span>
                <arrow-right-icon class="h-4 w-4" />
              </button>
            </template>

            <template v-else-if="bond">
              <button
                v-if="myBorrowPosition?.holdsUnit"
                type="button"
                class="sf-btn-bid flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px]"
                @click="openActionPreview('extinguish')"
              >
                <span>Extinguish Debt</span>
                <arrow-right-icon class="h-4 w-4" />
              </button>
              <button
                v-if="myBorrowPosition"
                type="button"
                class="sf-btn-bid flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px]"
                @click="openActionPreview('repay')"
              >
                <span>Repay Bond</span>
                <arrow-right-icon class="h-4 w-4" />
              </button>
              <button
                v-if="myBorrowPosition && rule === 'oracle'"
                type="button"
                class="sf-btn-outline flex h-9 w-full items-center justify-center gap-2 rounded-xl text-[12.5px]"
                @click="openActionPreview('addCollateral')"
              >
                <span>Add Collateral</span>
              </button>

              <template v-if="myLendPosition">
                <router-link
                  :to="{ name: 'zc-studio', query: { type: 'sell', token: myLendPosition.tokenId || myLendPosition.id } }"
                  class="sf-btn-cobalt flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px]"
                >
                  <span>Sell in Studio</span>
                  <arrow-right-icon class="h-4 w-4" />
                </router-link>
                <router-link
                  v-if="myLendPosition.kind === 'unit'"
                  :to="{ name: 'zc-studio', query: { type: 'shares', token: myLendPosition.tokenId || myLendPosition.id } }"
                  class="sf-btn-outline flex h-9 w-full items-center justify-center gap-2 rounded-xl text-[12.5px]"
                >
                  <span>Split into 100 Shares</span>
                </router-link>
                <button
                  v-if="myLendPosition.kind === 'shares' && myLendPosition.units >= SHARES_UNITS"
                  type="button"
                  class="sf-btn-outline flex h-9 w-full items-center justify-center gap-2 rounded-xl text-[12.5px]"
                  @click="openActionPreview('unfrac')"
                >
                  <span>Un-fractionalize</span>
                </button>
              </template>

              <router-link
                v-if="!myBorrowPosition && !myLendPosition"
                to="/app"
                class="sf-btn-outline flex h-9 w-full items-center justify-center gap-2 rounded-xl text-[12.5px]"
              >
                <span>Trade on Yield Curve</span>
              </router-link>
            </template>
          </div>
        </aside>
      </div>
    </template>

    <transition name="sf-modal">
      <execution-preview-modal
        v-if="previewPayload"
        :payload="previewPayload"
        @close="previewPayload = null"
      />
    </transition>
  </div>
</template>
