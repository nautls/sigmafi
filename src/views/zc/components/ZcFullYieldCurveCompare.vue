<script setup lang="ts">
import { ArrowUpRightIcon, XIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import ZcInteractiveChart, {
  ChartDotPoint,
  ChartLayer,
  ChartReadout,
  ChartReadoutRow
} from "./ZcInteractiveChart.vue";
import { zcApi } from "@/services/zcApi";
import {
  ZcAskSummary,
  ZcChartMetric,
  ZcCurves,
  ZcDurationUnit,
  ZcFillSummary,
  ZcMarket,
  ZcOfferSummary
} from "@/types/zc";
import {
  bestAskNear,
  buildFeeAdjustedBidLine,
  curvePointsAt,
  dateAtHeight,
  DAY_BLOCKS,
  feeAdjustedBidBps,
  fixedAskDots,
  formatApr,
  formatAxisDays,
  formatDur,
  formatMarketAmount,
  formatNumber,
  kindLabel,
  lineAt,
  metricMarginLeft,
  MIN_MATURITY_BLOCKS,
  nearestAskDot,
  niceDomain,
  offerYieldAt,
  priceForYield,
  priceToChartMetric,
  toChartMetric,
  windowAskLine,
  ZcSimpleCurvePoint
} from "@/utils/zcMath";

export type FullCurveOverlay =
  | {
      type: "curve";
      points: ZcSimpleCurvePoint[];
      lo: number;
      hi: number;
      floor?: number | null;
      cap?: number | null;
      label?: string;
      color?: string;
      face?: number;
    }
  | {
      type: "point-path";
      dAt: (atHeight: number) => number;
      aprAt: (atHeight: number) => number | null;
      priceAt: (atHeight: number) => number | null;
      expiry: number;
      maxAt: number;
      face: number;
      costBasis?: number | null;
      color?: string;
      label?: string;
    };

const props = withDefaults(
  defineProps<{
    market: ZcMarket;
    height: number;
    unit: ZcDurationUnit;
    connected: boolean;
    revision: number;
    cover?: number | null;
    overlay?: FullCurveOverlay | null;
    atHeight?: number | null;
    role?: "borrow" | "lend" | "sell";
    feeErg?: number;
    refusal?: string | null;
    matchCount?: number | null;
    metric?: ZcChartMetric;
    chartHeight?: number;
    fillHeight?: boolean;
  }>(),
  {
    cover: null,
    overlay: null,
    atHeight: null,
    role: "borrow",
    feeErg: 0,
    refusal: null,
    matchCount: null,
    metric: "yield",
    chartHeight: 280,
    fillHeight: false
  }
);

const emit = defineEmits<{
  (e: "update:atHeight", h: number): void;
  (e: "update:metric", m: ZcChartMetric): void;
}>();

const matchCover = ref(true);
const showFills = ref(false);
const showAllBids = ref(false);
const loading = ref(false);

const curves = ref<ZcCurves | null>(null);
const asks = ref<ZcAskSummary[]>([]);
const offers = ref<ZcOfferSummary[]>([]);
const fills = ref<ZcFillSummary[]>([]);
const pickedAskId = ref<string | null>(null);

const effectiveCover = computed(() =>
  matchCover.value && props.cover != null && Number.isFinite(props.cover) && props.cover > 0
    ? Math.max(10_000, Math.round(props.cover * 100))
    : undefined
);

let fetchAc: AbortController | null = null;
let fetchTimer: number | null = null;

async function loadMarketData() {
  if (!props.connected) return;
  if (fetchAc) fetchAc.abort();
  const ac = new AbortController();
  fetchAc = ac;
  loading.value = true;
  const cov = effectiveCover.value;
  try {
    const [c, aPage, oPage, fRes] = await Promise.all([
      zcApi.getCurves(props.market, { coverage: cov }, ac.signal),
      zcApi.listAsksPage(
        props.market,
        { coverage: cov, matchable: true, limit: 150 },
        undefined,
        ac.signal
      ),
      zcApi.listOffersPage(props.market, { coverage: cov, matchable: true, limit: 120 }, ac.signal),
      showFills.value
        ? zcApi
            .listFillsResult(
              props.market,
              { fromHeight: Math.max(0, props.height - 10 * DAY_BLOCKS), limit: 120 },
              ac.signal
            )
            .catch(() => ({ items: [] as ZcFillSummary[], status: "ready", indexedTo: null }))
        : Promise.resolve({ items: [] as ZcFillSummary[], status: "ready", indexedTo: null })
    ]);
    if (ac.signal.aborted) return;
    curves.value = c;
    asks.value = aPage.items;
    offers.value = oPage.items;
    fills.value = fRes.items;
  } catch {
    // fail-soft
  } finally {
    if (!ac.signal.aborted) loading.value = false;
  }
}

watch(
  [() => props.market, () => props.connected, () => props.revision, effectiveCover, showFills],
  () => {
    if (fetchTimer !== null) window.clearTimeout(fetchTimer);
    fetchTimer = window.setTimeout(() => {
      void loadMarketData();
    }, 160);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  fetchAc?.abort();
  if (fetchTimer !== null) window.clearTimeout(fetchTimer);
});

const faceVal = computed(() => {
  if (!props.overlay) return 100;
  return props.overlay.face && props.overlay.face > 0 ? props.overlay.face : 100;
});

const hasAbsFace = computed(
  () => !!(props.overlay && props.overlay.face && props.overlay.face > 0)
);

const metricView = computed<ZcChartMetric>(() =>
  props.metric === "abs" && !hasAbsFace.value ? "pct" : props.metric
);

const askById = computed(() => new Map(asks.value.map((a) => [a.id, a])));
const bidLine = computed(() => curves.value?.bidLine || []);
const askDots = computed(() => fixedAskDots(curves.value));
const winAsks = computed(() => windowAskLine(curves.value, askById.value, props.height));

const feeBidLine = computed(() =>
  props.feeErg > 0 && hasAbsFace.value
    ? buildFeeAdjustedBidLine(bidLine.value, offers.value, faceVal.value, props.feeErg)
    : null
);

const currentH = computed(() => {
  if (props.overlay?.type !== "point-path") return props.height;
  const raw = props.atHeight ?? props.height;
  return Math.max(props.height, Math.min(props.overlay.maxAt, Math.round(raw)));
});

const currentD = computed(() =>
  props.overlay?.type === "point-path" ? Math.max(1, props.overlay.dAt(currentH.value)) : 0
);

const currentApr = computed(() =>
  props.overlay?.type === "point-path" ? props.overlay.aprAt(currentH.value) : null
);

const currentPrice = computed(() =>
  props.overlay?.type === "point-path" ? props.overlay.priceAt(currentH.value) : null
);

const currentBidRaw = computed(() =>
  props.overlay?.type === "point-path" && currentD.value > 0
    ? lineAt(bidLine.value, currentD.value)
    : null
);

const currentBidEff = computed(() => {
  if (currentBidRaw.value == null || !(currentD.value > 0)) return null;
  if (props.feeErg > 0 && hasAbsFace.value) {
    return feeAdjustedBidBps(faceVal.value, currentBidRaw.value, currentD.value, props.feeErg);
  }
  return currentBidRaw.value;
});

const hasSignificantFeeDrag = computed(() => {
  if (currentBidRaw.value == null || currentBidEff.value == null) return false;
  return currentBidEff.value - currentBidRaw.value >= 10;
});

const isExpiredAtCurrent = computed(
  () => props.overlay?.type === "point-path" && currentH.value > props.overlay.expiry
);

const expiryTickPct = computed(() => {
  if (props.overlay?.type !== "point-path") return 100;
  const span = Math.max(1, props.overlay.maxAt - props.height);
  return Math.max(0, Math.min(100, ((props.overlay.expiry - props.height) / span) * 100));
});

const xDomain = computed<[number, number]>(() => {
  const ds: number[] = [];
  for (const p of bidLine.value) ds.push(p.d);
  for (const p of winAsks.value) ds.push(p.d);
  for (const d of askDots.value) ds.push(d.d);
  if (showFills.value) {
    for (const f of fills.value) ds.push(f.d);
  }
  if (props.overlay?.type === "curve") {
    ds.push(props.overlay.lo, props.overlay.hi);
  } else if (props.overlay?.type === "point-path") {
    ds.push(props.overlay.dAt(props.height), props.overlay.dAt(props.overlay.expiry));
  }
  const positive = ds.filter((d) => Number.isFinite(d) && d > 0);
  const loD = positive.length ? Math.min(...positive) : DAY_BLOCKS;
  const hiD = positive.length ? Math.max(...positive) : 180 * DAY_BLOCKS;
  const minDays = Math.max(0, loD / DAY_BLOCKS - 2);
  const maxDays = Math.max(minDays + 14, (hiD / DAY_BLOCKS) * 1.08);
  return [minDays, maxDays];
});

const toMetricY = (bps: number | null, d: number) =>
  bps == null || !(d > 0) ? null : toChartMetric(bps, d, metricView.value, faceVal.value);

const chartLayers = computed<ChartLayer[]>(() => {
  const out: ChartLayer[] = [];

  // Optional individual offer curves
  if (showAllBids.value) {
    offers.value.slice(0, 28).forEach((o, idx) => {
      if (!o.points?.length) return;
      const sampleCount = 24;
      const pts = Array.from({ length: sampleCount + 1 }, (_, i) => {
        const d = o.minBlocks + ((o.maxBlocks - o.minBlocks) * i) / sampleCount;
        const y = offerYieldAt(o, d);
        return { x: d / DAY_BLOCKS, y: toMetricY(y, d) };
      });
      out.push({
        type: "line",
        key: `ob-${idx}`,
        points: pts,
        color: "var(--sf-bid)",
        width: 1,
        opacity: 0.22
      });
    });
  }

  // Market bid line
  const bidPts = bidLine.value.map((p) => ({
    x: p.d / DAY_BLOCKS,
    y: toMetricY(p.y, p.d)
  }));

  // Market window ask line
  const winAskPts = winAsks.value.map((p) => ({
    x: p.d / DAY_BLOCKS,
    y: toMetricY(p.y, p.d)
  }));

  // Crossed market shade (when window ask yields >= bid)
  if (bidPts.length > 1 && winAskPts.length > 1) {
    const gridXs = Array.from(
      new Set([
        ...bidLine.value.map((p) => p.d),
        ...winAsks.value.map((p) => p.d)
      ])
    ).sort((a, b) => a - b);
    const bOn = gridXs.map((d) => ({ x: d / DAY_BLOCKS, y: toMetricY(lineAt(bidLine.value, d), d) }));
    const aOn = gridXs.map((d) => ({ x: d / DAY_BLOCKS, y: toMetricY(lineAt(winAsks.value, d), d) }));
    out.push(
      metricView.value === "yield"
        ? { type: "cross", key: "mkt-cross", upper: aOn, lower: bOn, color: "var(--sf-warn)", opacity: 0.14 }
        : { type: "cross", key: "mkt-cross", upper: bOn, lower: aOn, color: "var(--sf-warn)", opacity: 0.14 }
    );
  }

  if (bidPts.length > 1) {
    out.push({
      type: "area",
      key: "bid-area",
      points: bidPts,
      color: "var(--sf-bid)",
      opacity: 0.08
    });
    out.push({
      type: "line",
      key: "bid-line",
      points: bidPts,
      color: "var(--sf-bid)",
      width: 2.1,
      opacity: 0.92
    });
  }

  // Fee-adjusted bid line (for ERG fee drag on borrow/sell)
  if (feeBidLine.value && feeBidLine.value.length > 1) {
    out.push({
      type: "line",
      key: "fee-bid-line",
      points: feeBidLine.value.map((p) => ({
        x: p.d / DAY_BLOCKS,
        y: toMetricY(p.y, p.d)
      })),
      color: "var(--sf-bid)",
      width: 1.5,
      dash: "4 4",
      opacity: 0.72
    });
  }

  if (winAskPts.length > 1) {
    out.push({
      type: "line",
      key: "win-ask-line",
      points: winAskPts,
      color: "var(--sf-ask)",
      width: 1.9,
      opacity: 0.85
    });
  }

  // Par & cost basis lines in price/pct views
  if (metricView.value === "pct") {
    out.push({
      type: "hline",
      key: "par",
      y: 100,
      color: "var(--sf-dim)",
      dash: "2 5",
      opacity: 0.55,
      label: "100% face"
    });
  } else if (metricView.value === "abs") {
    out.push({
      type: "hline",
      key: "par",
      y: faceVal.value,
      color: "var(--sf-dim)",
      dash: "2 5",
      opacity: 0.55,
      label: `face ${formatMarketAmount(faceVal.value, props.market)}`
    });
  }

  if (
    props.overlay?.type === "point-path" &&
    props.overlay.costBasis != null &&
    props.overlay.costBasis > 0 &&
    metricView.value !== "yield"
  ) {
    const costY =
      metricView.value === "pct"
        ? (props.overlay.costBasis / faceVal.value) * 100
        : props.overlay.costBasis;
    out.push({
      type: "hline",
      key: "cost-basis",
      y: costY,
      color: "var(--sf-cobalt)",
      dash: "3 4",
      opacity: 0.78,
      label: `paid ${formatMarketAmount(props.overlay.costBasis, props.market)}`
    });
  }

  // Recent fills dots
  if (showFills.value && fills.value.length > 0) {
    out.push({
      type: "dots",
      key: "fills",
      points: fills.value.map((f) => ({
        x: f.d / DAY_BLOCKS,
        y: toMetricY(f.yieldBps, f.d),
        r: 3.1,
        color: "var(--sf-cobalt)",
        hollow: true,
        opacity: 0.75
      }))
    });
  }

  // Discrete asks dots (clickable!)
  if (askDots.value.length > 0) {
    out.push({
      type: "dots",
      key: "asks",
      clickable: true,
      points: askDots.value.map((d) => ({
        id: d.id,
        x: d.d / DAY_BLOCKS,
        y: toMetricY(d.y, d.d),
        r: d.id === pickedAskId.value ? 6.5 : 4.2,
        color: "var(--sf-ask)",
        stroke: d.id === pickedAskId.value ? "var(--sf-ink)" : "var(--sf-panel)",
        opacity: d.id === pickedAskId.value ? 1 : 0.9
      }))
    });
  }

  // User overlay
  if (props.overlay?.type === "curve") {
    const ov = props.overlay;
    const col = ov.color || (props.role === "lend" ? "var(--sf-cobalt)" : "var(--sf-ask)");
    const count = 48;
    const pts = Array.from({ length: count + 1 }, (_, i) => {
      const d = ov.lo + ((ov.hi - ov.lo) * i) / count;
      const raw = curvePointsAt(ov.points, d);
      const floored = raw != null ? Math.max(ov.floor ?? 0, raw) : ov.floor ?? null;
      const yBps = floored != null && ov.cap != null ? Math.min(ov.cap, floored) : floored;
      return { x: d / DAY_BLOCKS, y: toMetricY(yBps, d) };
    });
    out.push({
      type: "area",
      key: "user-curve-area",
      points: pts,
      color: col,
      opacity: 0.12
    });
    out.push({
      type: "line",
      key: "user-curve",
      points: pts,
      color: col,
      width: 2.8,
      opacity: 1
    });
  } else if (props.overlay?.type === "point-path") {
    const ov = props.overlay;
    // Always use high-contrast Cobalt for the user's own order so it stands out immediately
    // from competing amber ask dots and emerald bid curves.
    const col = "var(--sf-cobalt)";
    const markerColor = isExpiredAtCurrent.value ? "var(--sf-warn)" : col;
    const expH = Math.max(props.height, Math.min(ov.maxAt, ov.expiry));
    const samplePath = (h0: number, h1: number, n: number) => {
      if (h1 <= h0) return [];
      return Array.from({ length: n + 1 }, (_, i) => {
        const at = h0 + ((h1 - h0) * i) / n;
        const d = ov.dAt(at);
        const apr = ov.aprAt(at);
        const px = ov.priceAt(at);
        const y =
          metricView.value === "yield"
            ? apr != null
              ? apr / 100
              : null
            : px != null && d > 0
              ? priceToChartMetric(px, ov.face, d, metricView.value)
              : null;
        return { x: d / DAY_BLOCKS, y };
      }).filter((p) => p.x >= 0);
    };

    const liveTrail = samplePath(props.height, expH, 32);
    const trailMoves =
      liveTrail.length > 1 &&
      liveTrail.some(
        (p) =>
          Math.abs(p.x - liveTrail[0].x) > 0.05 ||
          (p.y != null && liveTrail[0].y != null && Math.abs(p.y - liveTrail[0].y) > 0.02)
      );
    if (trailMoves) {
      out.push({
        type: "line",
        key: "user-live-trail",
        points: liveTrail,
        color: col,
        width: 2.8,
        opacity: 0.96
      });
    }

    if (ov.maxAt > expH + 6) {
      const postTrail = samplePath(expH, ov.maxAt, 24);
      const postMoves =
        postTrail.length > 1 &&
        postTrail.some(
          (p) =>
            Math.abs(p.x - postTrail[0].x) > 0.05 ||
            (p.y != null && postTrail[0].y != null && Math.abs(p.y - postTrail[0].y) > 0.02)
        );
      if (postMoves) {
        out.push({
          type: "line",
          key: "user-post-trail",
          points: postTrail,
          color: "var(--sf-warn)",
          width: 1.7,
          dash: "4 4",
          opacity: 0.65
        });
      }
    }

    // Active marker value at scrubbed height
    const curY =
      metricView.value === "yield"
        ? currentApr.value != null
          ? currentApr.value / 100
          : null
        : currentPrice.value != null && currentD.value > 0
          ? priceToChartMetric(currentPrice.value, ov.face, currentD.value, metricView.value)
          : null;

    // Expiry hollow marker (only when visually distinct from active user dot)
    const expD = ov.dAt(expH);
    const expApr = ov.aprAt(expH);
    const expPx = ov.priceAt(expH);
    const expY =
      metricView.value === "yield"
        ? expApr != null
          ? expApr / 100
          : null
        : expPx != null && expD > 0
          ? priceToChartMetric(expPx, ov.face, expD, metricView.value)
          : null;
    const expDistinct =
      Math.abs(expD - currentD.value) > DAY_BLOCKS * 0.5 ||
      (expY != null && curY != null && Math.abs(expY - curY) > 0.15);
    if (expD > 0 && expY != null && expDistinct) {
      out.push({
        type: "dots",
        key: "user-expiry-dot",
        points: [{ x: expD / DAY_BLOCKS, y: expY, r: 4.5, color: "var(--sf-warn)", hollow: true }]
      });
    }

    // Guide lines + prominent cobalt beacon marker + callout tag for user's own order
    if (currentD.value > 0 && curY != null) {
      const curXDays = currentD.value / DAY_BLOCKS;
      const valTag =
        metricView.value === "yield"
          ? formatApr(currentApr.value)
          : metricView.value === "pct"
            ? `${formatNumber(curY, 1, 1)}%`
            : formatMarketAmount(curY, props.market);
      out.push({
        type: "vline",
        key: "user-now-vx",
        x: curXDays,
        color: markerColor,
        dash: "2 4",
        opacity: 0.45
      });
      out.push({
        type: "hline",
        key: "user-now-hy",
        y: curY,
        color: markerColor,
        dash: "2 4",
        opacity: 0.35
      });
      out.push({
        type: "dots",
        key: "user-now-dot",
        points: [
          {
            x: curXDays,
            y: curY,
            r: 6,
            color: markerColor,
            stroke: "var(--sf-card)",
            beacon: true,
            label: `You · ${valTag}`,
            opacity: 1
          }
        ]
      });
    }
  }

  return out;
});

const yDomain = computed<[number, number]>(() => {
  const vals: number[] = [];
  for (const layer of chartLayers.value) {
    if (layer.type === "line" || layer.type === "area") {
      for (const p of layer.points) if (p.y != null) vals.push(p.y);
    } else if (layer.type === "dots") {
      for (const p of layer.points) if (p.y != null) vals.push(p.y);
    } else if (layer.type === "hline") {
      vals.push(layer.y);
    }
  }
  return niceDomain(vals.length ? vals : [0, 12], 0.14, metricView.value === "yield");
});

const verdict = computed<{ text: string; tone: "bid" | "warn" | "cobalt" | "neutral" } | null>(
  () => {
    if (props.refusal) return { text: props.refusal, tone: "warn" };
    if (props.matchCount != null && props.matchCount > 0) {
      return {
        text:
          props.role === "lend"
            ? `Takes ${props.matchCount} ask${props.matchCount === 1 ? "" : "s"} now`
            : `Clears now (${props.matchCount} offer${props.matchCount === 1 ? "" : "s"})`,
        tone: "bid"
      };
    }
    if (props.overlay?.type === "point-path") {
      if (isExpiredAtCurrent.value) return { text: "Expired at scrubbed time", tone: "warn" };
      if (
        currentApr.value != null &&
        currentBidRaw.value != null &&
        currentBidEff.value != null
      ) {
        if (currentApr.value >= currentBidEff.value) {
          return { text: "Clears best bid", tone: "bid" };
        }
        if (currentApr.value >= currentBidRaw.value && hasSignificantFeeDrag.value) {
          return { text: "Blocked by ERG fee drag", tone: "warn" };
        }
        const gap = currentBidEff.value - currentApr.value;
        return {
          text: `${formatNumber(gap / 100, 2, 2)}% under bid · rests`,
          tone: "neutral"
        };
      }
      return { text: "Rests on book", tone: "neutral" };
    }
    if (props.overlay?.type === "curve") {
      return { text: "Rests on book", tone: "neutral" };
    }
    return null;
  }
);

const pickedAsk = computed(() =>
  pickedAskId.value ? asks.value.find((a) => a.id === pickedAskId.value) || null : null
);

function onPointClick(pt: ChartDotPoint, layerKey: string) {
  if (layerKey === "asks" && pt.id) {
    pickedAskId.value = pickedAskId.value === pt.id ? null : pt.id;
  }
}

function setScrubHeight(h: number) {
  if (props.overlay?.type !== "point-path") return;
  const clamped = Math.max(props.height, Math.min(props.overlay.maxAt, Math.round(h)));
  emit("update:atHeight", clamped);
}

function fmtY(v: number): string {
  if (metricView.value === "yield") return `${formatNumber(v, 1, 0)}%`;
  if (metricView.value === "pct") return `${formatNumber(v, 1, 0)}%`;
  return formatNumber(v, 2, 0);
}

function hoverReadout(daysVal: number): ChartReadout | null {
  const d = Math.max(MIN_MATURITY_BLOCKS, Math.round(daysVal * DAY_BLOCKS));
  const bid = lineAt(bidLine.value, d);
  const feeBid = feeBidLine.value ? lineAt(feeBidLine.value, d) : null;
  const askRes = bestAskNear(curves.value, d, askById.value, props.height, 4 * DAY_BLOCKS);
  const ask = askRes?.y ?? null;
  const nearDot = nearestAskDot(askDots.value, d, 4 * DAY_BLOCKS);
  const nearAsk = nearDot ? askById.value.get(nearDot.id) || null : null;

  const rows: ChartReadoutRow[] = [];
  const marks: { y: number | null; color: string }[] = [];

  if (props.overlay?.type === "curve") {
    if (d >= props.overlay.lo && d <= props.overlay.hi) {
      const raw = curvePointsAt(props.overlay.points, d);
      const floored = raw != null ? Math.max(props.overlay.floor ?? 0, raw) : props.overlay.floor ?? 0;
      const yv = props.overlay.cap != null ? Math.min(props.overlay.cap, floored) : floored;
      const col = props.overlay.color || "var(--sf-cobalt)";
      marks.push({ y: toMetricY(yv, d), color: col });
      rows.push({
        label: props.overlay.label || "Your curve",
        value:
          metricView.value === "yield"
            ? formatApr(yv)
            : metricView.value === "pct"
              ? `${formatNumber((priceForYield(100, yv, d) / 100) * 100, 2, 1)}%`
              : formatMarketAmount(priceForYield(faceVal.value, yv, d), props.market),
        tone: props.role === "lend" ? "cobalt" : "ask"
      });
    }
  }

  if (bid != null) {
    marks.push({ y: toMetricY(bid, d), color: "var(--sf-bid)" });
    rows.push({ label: "Best bid", value: formatApr(bid), tone: "bid" });
  }
  if (feeBid != null && bid != null && feeBid - bid >= 10) {
    rows.push({ label: "Bid (after fee)", value: formatApr(feeBid), tone: "warn" });
  }
  if (ask != null) {
    marks.push({ y: toMetricY(ask, d), color: "var(--sf-ask)" });
    rows.push({ label: "Best ask", value: formatApr(ask), tone: "ask" });
  }
  if (nearDot) {
    rows.push({
      label: nearAsk ? `Listed ${kindLabel(nearAsk.kind)}` : "Listed ask",
      value: `${formatApr(nearDot.y)}${nearAsk?.quote ? ` · ${formatMarketAmount(nearAsk.quote.cost, props.market)}` : ""}`
    });
  }

  return {
    header: formatDur(d, props.unit),
    subHeader: props.height ? dateAtHeight(props.height + d, props.height) : undefined,
    marks,
    rows
  };
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <!-- Top Controls Bar -->
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-1.5">
        <div class="sf-seg" role="tablist" aria-label="Chart metric">
          <button
            type="button"
            class="sf-seg-btn !h-6 !px-2 !text-[10.5px]"
            :class="metricView === 'yield' ? 'is-active tone-cobalt' : ''"
            @click="emit('update:metric', 'yield')"
          >
            APR
          </button>
          <button
            type="button"
            class="sf-seg-btn !h-6 !px-2 !text-[10.5px]"
            :class="metricView === 'pct' ? 'is-active tone-cobalt' : ''"
            @click="emit('update:metric', 'pct')"
          >
            % Face
          </button>
          <button
            v-if="hasAbsFace"
            type="button"
            class="sf-seg-btn !h-6 !px-2 !text-[10.5px]"
            :class="metricView === 'abs' ? 'is-active tone-cobalt' : ''"
            @click="emit('update:metric', 'abs')"
          >
            {{ market }}
          </button>
        </div>

        <button
          v-if="cover != null && cover > 0"
          type="button"
          class="sf-mono h-6 rounded-lg border px-2 text-[10px] font-semibold transition-all"
          :class="
            matchCover
              ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="matchCover = !matchCover"
        >
          Cover ≥ {{ Math.round(cover) }}%
        </button>

        <button
          type="button"
          class="sf-mono h-6 rounded-lg border px-2 text-[10px] font-semibold transition-all"
          :class="
            showFills
              ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="showFills = !showFills"
        >
          Fills · 10d
        </button>

        <button
          type="button"
          class="sf-mono h-6 rounded-lg border px-2 text-[10px] font-semibold transition-all"
          :class="
            showAllBids
              ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="showAllBids = !showAllBids"
        >
          All bids
        </button>
      </div>

      <div class="flex items-center gap-2">
        <span
          v-if="loading"
          class="sf-mono text-[10px] text-[color:var(--sf-dim)]"
        >
          syncing…
        </span>
        <span
          v-if="verdict"
          class="sf-mono rounded-[5px] border px-2 py-0.5 text-[10.5px] font-semibold"
          :class="
            verdict.tone === 'bid'
              ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
              : verdict.tone === 'warn'
                ? 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)]'
          "
        >
          {{ verdict.text }}
        </span>
      </div>
    </div>

    <!-- Main Interactive Chart -->
    <div class="min-h-0 flex-1">
      <zc-interactive-chart
        :height="chartHeight"
        :fill-height="fillHeight"
        :x-domain="xDomain"
        :y-domain="yDomain"
        :x-format="(v) => formatAxisDays(v, unit)"
        :y-format="fmtY"
        :margin-left="metricMarginLeft(yDomain, metricView, market)"
        :layers="chartLayers"
        :hover-fn="hoverReadout"
        label="Full market yield curve comparison"
        @point-click="onPointClick"
      />
    </div>

    <!-- Picked Ask Inspection Strip -->
    <div
      v-if="pickedAsk"
      class="sf-dock-well flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line-ask)] px-3 py-1.5"
    >
      <div class="flex flex-wrap items-center gap-2.5 text-[11.5px]">
        <span class="sf-mono rounded bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[color:var(--sf-ask)]">
          {{ kindLabel(pickedAsk.kind) }}
        </span>
        <span class="sf-mono font-bold text-[color:var(--sf-ask)]">
          {{ formatApr(pickedAsk.quote?.yieldBps) }}
        </span>
        <span class="sf-mono text-[color:var(--sf-ink-2)]">
          {{ formatDur(pickedAsk.quote?.d, unit) }}
        </span>
        <span class="sf-mono text-[color:var(--sf-muted)]">
          {{ formatMarketAmount(pickedAsk.quote?.cost, pickedAsk.market) }} →
          {{ formatMarketAmount(pickedAsk.quote?.face, pickedAsk.market) }}
        </span>
        <span v-if="pickedAsk.cov != null" class="sf-mono text-[color:var(--sf-muted)]">
          {{ Math.round(pickedAsk.cov) }}% cov
        </span>
      </div>
      <div class="flex items-center gap-1.5">
        <router-link
          :to="{ name: 'zc-bond', params: { id: pickedAsk.id } }"
          target="_blank"
          class="sf-mono inline-flex items-center gap-1 rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-panel)] px-2 py-0.5 text-[10.5px] font-semibold text-[color:var(--sf-cobalt)] transition-colors hover:border-[color:var(--sf-line-cobalt)]"
        >
          <span>Full terms</span>
          <arrow-up-right-icon class="h-3 w-3" />
        </router-link>
        <button
          type="button"
          class="grid h-6 w-6 place-items-center rounded-md text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
          aria-label="Dismiss ask preview"
          @click="pickedAskId = null"
        >
          <x-icon class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <!-- Time-Until-Maturity Scrubber (for Borrow / Sell point-path overlays) -->
    <div
      v-if="overlay?.type === 'point-path'"
      class="sf-dock-well rounded-xl px-3 py-2"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-1.5">
          <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            If filled
          </span>
          <span
            class="sf-mono rounded-[4px] px-1.5 py-0.5 text-[9.5px] font-semibold"
            :class="
              isExpiredAtCurrent
                ? 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                : 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
            "
          >
            {{
              currentH <= height + 2
                ? "Now"
                : isExpiredAtCurrent
                  ? "After expiry"
                  : `+${formatDur(currentH - height, unit)}`
            }}
          </span>
        </div>

        <div class="flex items-center gap-1">
          <button
            type="button"
            class="sf-mono rounded-md border border-[color:var(--sf-line)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-ink-2)] transition-colors hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-cobalt)]"
            @click="setScrubHeight(height)"
          >
            Now
          </button>
          <button
            type="button"
            class="sf-mono rounded-md border border-[color:var(--sf-line)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-ink-2)] transition-colors hover:border-[color:var(--sf-line-ask)] hover:text-[color:var(--sf-ask)]"
            @click="setScrubHeight(overlay.expiry)"
          >
            Expiry
          </button>
          <button
            type="button"
            class="sf-mono rounded-md border border-[color:var(--sf-line)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-ink-2)] transition-colors hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-cobalt)]"
            @click="setScrubHeight(overlay.maxAt)"
          >
            Maturity
          </button>
        </div>
      </div>

      <div class="relative mt-2 flex items-center">
        <input
          type="range"
          :min="height"
          :max="Math.max(height + 1, overlay.maxAt)"
          :value="currentH"
          class="sf-range w-full"
          aria-label="Fill time scrubber"
          @input="setScrubHeight(Number(($event.target as HTMLInputElement).value))"
        />
        <span
          v-if="expiryTickPct > 2 && expiryTickPct < 98"
          class="pointer-events-none absolute top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-full bg-[color:var(--sf-warn)]"
          :style="{ left: `${expiryTickPct}%` }"
          title="Order expiry"
        />
      </div>

      <div class="mt-2 grid grid-cols-4 gap-2 border-t border-[color:var(--sf-line)] pt-1.5">
        <div>
          <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-dim)]">
            Term left
          </div>
          <div class="sf-mono text-[11.5px] font-semibold text-[color:var(--sf-ink)]">
            {{ formatDur(currentD, unit) }}
          </div>
        </div>
        <div>
          <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-dim)]">
            Your APR
          </div>
          <div class="sf-mono text-[11.5px] font-semibold text-[color:var(--sf-cobalt)]">
            {{ formatApr(currentApr) }}
          </div>
        </div>
        <div>
          <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-dim)]">
            Best bid{{ hasSignificantFeeDrag ? " (fee)" : "" }}
          </div>
          <div class="sf-mono text-[11.5px] font-semibold text-[color:var(--sf-bid)]">
            {{ formatApr(currentBidEff) }}
          </div>
        </div>
        <div>
          <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-dim)]">
            Cash
          </div>
          <div class="sf-mono text-[11.5px] font-semibold text-[color:var(--sf-ink)]">
            {{ formatMarketAmount(currentPrice, market) }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
