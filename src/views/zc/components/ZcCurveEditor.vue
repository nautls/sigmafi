<script setup lang="ts">
import { MinusIcon, PlusIcon } from "@zhuowenli/vue-feather-icons";
import { computed, ref } from "vue";
import ZcInteractiveChart, {
  ChartEditConfig,
  ChartEditPoint,
  ChartLayer,
  ChartReadout
} from "./ZcInteractiveChart.vue";
import ZcSelect, { ZcSelectOption } from "./ZcSelect.vue";
import {
  ZcAskDot,
  ZcChartMetric,
  ZcCurveMove,
  ZcCurvePoint,
  ZcCurveShape,
  ZcDurationUnit,
  ZcMarket
} from "@/types/zc";
import {
  curvePointsAt,
  dateAtHeight,
  DAY_BLOCKS,
  fitToLine,
  formatApr,
  formatAxisDays,
  formatDur,
  formatMarketAmount,
  formatMetricTick,
  formatNumber,
  insertCurvePoint,
  lineAt,
  MAX_CURVE_POINTS,
  metricMarginLeft,
  moveCurve,
  nearestAskDot,
  niceDomain,
  priceForYield,
  pricePct,
  reflectApr,
  reflectMaturity,
  resampleCurve,
  shapeCurve,
  toChartMetric,
  YEAR_BLOCKS,
  yieldOfAbs,
  yieldOfPct,
  ZcSimpleCurvePoint
} from "@/utils/zcMath";

export interface CurveMarketOverlay {
  bidLine: ZcCurvePoint[];
  askLine: ZcCurvePoint[];
  askFit?: ZcCurvePoint[];
  dots: (ZcAskDot & { hit?: boolean })[];
}

const props = withDefaults(
  defineProps<{
    points: ZcSimpleCurvePoint[];
    lo: number;
    hi: number;
    side?: "offer" | "window";
    market?: CurveMarketOverlay | null;
    floor?: number | null;
    cap?: number | null;
    face?: number;
    asset?: ZcMarket | null;
    faceIsSample?: boolean;
    faceNote?: string | null;
    capital?: number | null;
    metric?: ZcChartMetric;
    feeBidLine?: ZcCurvePoint[] | null;
    feeErg?: number;
    height?: number;
    unit?: ZcDurationUnit;
    readOnly?: boolean;
    chartHeight?: number;
    fillHeight?: boolean;
  }>(),
  {
    side: "offer",
    market: null,
    floor: null,
    cap: null,
    face: 100,
    asset: null,
    faceIsSample: false,
    faceNote: null,
    capital: null,
    metric: "yield",
    feeBidLine: null,
    feeErg: 0,
    height: 0,
    unit: "days",
    readOnly: false,
    chartHeight: 280,
    fillHeight: false
  }
);

const emit = defineEmits<{
  (e: "update:points", pts: ZcSimpleCurvePoint[]): void;
  (e: "update:metric", metric: ZcChartMetric): void;
  (e: "fit", pts: ZcSimpleCurvePoint[]): void;
}>();

const selectedIdx = ref<number | null>(null);
const stepBps = ref<number>(25);
const editingCell = ref<{ key: string; text: string } | null>(null);

const STEP_OPTIONS: readonly ZcSelectOption[] = [5, 10, 25, 50, 100].map((v) => ({
  value: v,
  label: `${v} bp`
}));

const GLYPHS: Record<ZcCurveShape | ZcCurveMove, string> = {
  normal: "M2 12C6 7.5 10 4.5 20 2.5",
  flat: "M2 7.5H20",
  inverted: "M2 2.5C6 7.5 10 10.5 20 12",
  humped: "M2 11.5C7 1.5 13 1.5 20 8.5",
  up: "M2 10.5H20M2 5.5H20",
  down: "M2 4.5H20M2 9.5H20",
  bullSteep: "M2 11.5L20 3.5M2 7.5L20 3.5",
  bearSteep: "M2 9.5L20 1.5M2 9.5L20 6.5",
  bullFlat: "M2 8.5L20 10.5M2 8.5L20 4.5",
  bearFlat: "M2 4.5L20 7.5M2 9.5L20 7.5",
  flyUp: "M2 8.5Q11 0.5 20 8.5",
  flyDown: "M2 5.5Q11 13.5 20 5.5"
};

const SHAPES: { key: ZcCurveShape; label: string }[] = [
  { key: "normal", label: "Normal" },
  { key: "flat", label: "Flat" },
  { key: "inverted", label: "Inverted" },
  { key: "humped", label: "Humped" }
];

const MOVES: { key: ZcCurveMove; title: string }[] = [
  { key: "up", title: "Parallel shift up" },
  { key: "down", title: "Parallel shift down" },
  { key: "bullSteep", title: "Bull steepener (short end down)" },
  { key: "bearSteep", title: "Bear steepener (long end up)" },
  { key: "bullFlat", title: "Bull flattener (long end down)" },
  { key: "bearFlat", title: "Bear flattener (short end up)" },
  { key: "flyUp", title: "Butterfly up (belly up)" },
  { key: "flyDown", title: "Butterfly down (belly down)" }
];

const metricView = computed<ZcChartMetric>(() =>
  props.metric === "abs" && !props.asset ? "pct" : props.metric
);

const refFace = computed(() => (props.face > 0 ? props.face : 100));
const color = computed(() => (props.side === "offer" ? "var(--sf-cobalt)" : "var(--sf-ask)"));
const inBlocks = computed(() => props.unit === "blocks");
const n = computed(() => props.points.length);

const levelBps = computed(() =>
  props.points.length
    ? props.points.reduce((a, p) => a + p.y, 0) / props.points.length
    : 800
);

const editPts = computed<ChartEditPoint[]>(() =>
  props.points.map((p) => ({
    x: p.d / DAY_BLOCKS,
    y: toChartMetric(p.y, p.d, metricView.value, refFace.value) ?? 0
  }))
);

const spanDays = computed(() => Math.max(1, (props.hi - props.lo) / DAY_BLOCKS));
const snapX = computed(() => (spanDays.value > 40 ? 1 : spanDays.value > 8 ? 0.25 : 1 / 24));

function fromEditPts(pts: ChartEditPoint[]): ZcSimpleCurvePoint[] {
  return pts.map((p) => {
    const d = Math.max(1, Math.round(p.x * DAY_BLOCKS));
    const y =
      metricView.value === "yield"
        ? Math.round(p.y * 100)
        : metricView.value === "pct"
          ? Math.round(yieldOfPct(p.y, d))
          : Math.round(yieldOfAbs(p.y, refFace.value, d));
    return { d, y: Math.max(0, y) };
  });
}

function setPoints(pts: ZcSimpleCurvePoint[], sel: number | null = null) {
  emit("update:points", pts);
  selectedIdx.value = sel;
}

const layers = computed<ChartLayer[]>(() => {
  const out: ChartLayer[] = [];
  const sample = (fn: (d: number) => number | null, k = 60) =>
    Array.from({ length: k + 1 }, (_, i) => {
      const d = props.lo + ((props.hi - props.lo) * i) / k;
      const y = fn(d);
      return { x: d / DAY_BLOCKS, y: toChartMetric(y, d, metricView.value, refFace.value) };
    });

  if (props.market?.bidLine?.length) {
    out.push({
      type: "line",
      key: "mb",
      color: "var(--sf-bid)",
      width: props.side === "offer" ? 2.1 : props.feeBidLine?.length ? 1.5 : 1.7,
      dash: props.side === "offer" || props.feeBidLine?.length ? undefined : "5 4",
      opacity: props.side === "offer" ? 0.92 : props.feeBidLine?.length ? 0.6 : 0.82,
      points: sample((d) => lineAt(props.market!.bidLine, d))
    });
  }
  if (props.feeBidLine?.length && props.side === "window") {
    out.push({
      type: "line",
      key: "mbf",
      color: "var(--sf-bid)",
      width: 1.9,
      dash: "5 4",
      opacity: 0.94,
      points: sample((d) => lineAt(props.feeBidLine!, d))
    });
  }
  if (props.market?.askLine?.some((p) => p.y != null)) {
    const raw = props.market.askLine;
    const xs = new Set<number>([props.lo, props.hi]);
    for (const p of raw) {
      if (p.d >= props.lo && p.d <= props.hi) xs.add(p.d);
    }
    const askPts = [...xs]
      .sort((a, b) => a - b)
      .map((d) => {
        const y = lineAt(raw, d);
        return { x: d / DAY_BLOCKS, y: toChartMetric(y, d, metricView.value, refFace.value) };
      });
    out.push({
      type: "line",
      key: "ma",
      color: "var(--sf-ask)",
      width: 1.5,
      dash: "5 4",
      opacity: props.side === "window" ? 0.55 : 0.8,
      points: askPts
    });
  }
  if (props.market?.dots?.length) {
    out.push({
      type: "dots",
      key: "md",
      points: props.market.dots
        .filter((q) => q.d >= props.lo && q.d <= props.hi)
        .map((q) => ({
          id: q.id,
          x: q.d / DAY_BLOCKS,
          y: toChartMetric(q.y, q.d, metricView.value, refFace.value),
          r: q.hit ? 5 : 3.2,
          color: q.hit ? "var(--sf-card)" : "var(--sf-ask)",
          stroke: q.hit ? "var(--sf-ask)" : undefined,
          opacity: q.hit ? 1 : 0.6
        }))
    });
  }

  const curve = sample((d) => {
    const c = curvePointsAt(props.points, d);
    if (c == null) return null;
    return props.side === "offer"
      ? Math.max(props.floor ?? 0, c)
      : Math.min(props.cap ?? Infinity, c);
  }, 110);

  if (props.floor != null && props.side === "offer") {
    out.push({
      type: "line",
      key: "floor",
      color: "var(--sf-cobalt)",
      width: 1.25,
      dash: "2 3",
      opacity: 0.7,
      points: sample(() => props.floor!, 28)
    });
  }
  if (props.cap != null && props.side === "window") {
    out.push({
      type: "line",
      key: "cap",
      color: "var(--sf-ask)",
      width: 1.25,
      dash: "2 3",
      opacity: 0.7,
      points: sample(() => props.cap!, 28)
    });
  }

  out.push({
    type: "area",
    key: "effArea",
    color: color.value,
    opacity: 0.08,
    points: curve
  });
  out.push({
    type: "line",
    key: "eff",
    color: color.value,
    width: 2.6,
    points: curve
  });
  return out;
});

const yDomain = computed<[number, number]>(() => {
  const baseYs: number[] = [];
  for (const L of layers.value) {
    if (L.key === "mbf") continue;
    if (L.type === "line" || L.type === "area") {
      for (const p of L.points) if (p.y != null && Number.isFinite(p.y)) baseYs.push(p.y);
    } else if (L.type === "dots") {
      for (const p of L.points) if (p.y != null && Number.isFinite(p.y)) baseYs.push(p.y);
    }
  }
  for (const p of editPts.value) if (Number.isFinite(p.y)) baseYs.push(p.y);

  const feeAprCap = Math.max((baseYs.length ? Math.max(...baseYs) : 15) * 2.1, 38);
  const feeLayer = layers.value.find((L) => L.key === "mbf");
  const feeYs: number[] = [];
  if (feeLayer && feeLayer.type === "line") {
    for (const p of feeLayer.points) {
      if (p.y != null && Number.isFinite(p.y) && (metricView.value !== "yield" || p.y <= feeAprCap)) {
        feeYs.push(p.y);
      }
    }
  }
  return metricView.value === "yield"
    ? niceDomain([...baseYs, ...feeYs], 0.14, true)
    : niceDomain([...baseYs, ...feeYs], 0.08, false);
});

const ySpan = computed(() => yDomain.value[1] - yDomain.value[0]);
const marginLeft = computed(() => metricMarginLeft(yDomain.value, metricView.value, props.asset));

const absSnapY = computed(() =>
  Math.max(props.asset === "ERG" ? 0.001 : 0.01, Number((refFace.value / 2000).toPrecision(1)))
);

const editConfig = computed<ChartEditConfig>(() => {
  if (props.readOnly) {
    return { points: editPts.value, color: color.value, lockX: true, lockY: true };
  }
  return {
    points: editPts.value,
    color: color.value,
    selected: selectedIdx.value,
    minGap: snapX.value,
    snapX: snapX.value,
    snapY: metricView.value === "abs" ? absSnapY.value : 0.01,
    keyX: snapX.value,
    keyY: metricView.value === "yield" ? 0.01 : metricView.value === "pct" ? 0.05 : absSnapY.value * 5,
    xBounds: [props.lo / DAY_BLOCKS, props.hi / DAY_BLOCKS],
    yBounds:
      metricView.value === "yield"
        ? [0, 200]
        : metricView.value === "pct"
          ? [10, 100]
          : [refFace.value * 0.1, refFace.value],
    remove: true,
    min: 2,
    max: MAX_CURVE_POINTS
  };
});

function hoverReadout(xv: number): ChartReadout {
  const d = Math.max(1, Math.round(xv * DAY_BLOCKS));
  const mine = curvePointsAt(props.points, d);
  const eff =
    mine == null
      ? null
      : props.side === "offer"
        ? Math.max(props.floor ?? 0, mine)
        : Math.min(props.cap ?? Infinity, mine);
  const mb = props.market?.bidLine ? lineAt(props.market.bidLine, d) : null;
  const mbf = props.feeBidLine?.length ? lineAt(props.feeBidLine, d) : null;
  const near = nearestAskDot(props.market?.dots, d, DAY_BLOCKS / 2);
  const mw = props.market?.askLine ? lineAt(props.market.askLine, d) : null;
  const ma = near ? Math.max(near.y, mw ?? -Infinity) : mw;

  const fmtSide = (bps: number | null) => {
    if (bps == null) return "—";
    if (metricView.value === "abs" && props.asset) {
      return `${formatMarketAmount(priceForYield(refFace.value, bps, d), props.asset)} · ${formatApr(bps)}`;
    }
    return formatApr(bps);
  };

  const rows: ChartReadout["rows"] = [
    {
      label: props.side === "offer" ? "Min APR" : "Max APR",
      value: formatApr(eff),
      tone: props.side === "offer" ? "cobalt" : "ask"
    },
    {
      label: "% of face",
      value: eff == null ? "—" : `${formatNumber(pricePct(eff, d), 2, 2)}%`
    }
  ];

  if (refFace.value > 0) {
    rows.push({
      label:
        props.side === "offer"
          ? `Cost / ${props.asset ? formatMarketAmount(refFace.value, props.asset) : refFace.value}`
          : props.faceIsSample
            ? `Per ${props.asset ? formatMarketAmount(refFace.value, props.asset) : refFace.value}`
            : "Receive",
      value:
        eff == null
          ? "—"
          : props.asset
            ? formatMarketAmount(priceForYield(refFace.value, eff, d), props.asset)
            : formatNumber(priceForYield(refFace.value, eff, d), 2, 2)
    });
  }

  if (props.side === "offer" && props.capital && props.capital > 0 && props.asset && eff != null) {
    rows.push({
      label: "Repays",
      value: formatMarketAmount(
        props.capital * (1 + (eff / 10_000) * (d / YEAR_BLOCKS)),
        props.asset
      ),
      tone: "bid"
    });
  }

  if (mb != null) rows.push({ label: "Best bid", value: fmtSide(mb), tone: "bid" });
  if (mbf != null) rows.push({ label: "Bid w/ fee", value: fmtSide(mbf), tone: "bid" });
  if (ma != null) {
    rows.push({
      label: near && near.d !== d ? `Ask @${formatDur(near.d, props.unit)}` : "Best ask",
      value: fmtSide(ma),
      tone: "ask"
    });
  }

  return {
    header: formatDur(d, props.unit),
    subHeader: props.height ? dateAtHeight(props.height + d, props.height) : undefined,
    marks: [{ y: toChartMetric(eff, d, metricView.value, refFace.value), color: color.value }],
    rows
  };
}

const hasBids = computed(() => !!props.market?.bidLine?.some((p) => p.y != null));
const askFitSource = computed(() => props.market?.askFit || props.market?.askLine || []);
const hasAsks = computed(() => askFitSource.value.some((p) => p.y != null));

function applyShape(k: ZcCurveShape) {
  setPoints(shapeCurve(k, Math.max(50, Math.round(levelBps.value)), Math.max(2, n.value), props.lo, props.hi));
}

function applyMove(k: ZcCurveMove) {
  setPoints(moveCurve(props.points, k, stepBps.value), selectedIdx.value);
}

function applyCount(k: number) {
  const clamped = Math.min(MAX_CURVE_POINTS, Math.max(2, k));
  const base = props.points.length
    ? props.points
    : shapeCurve("flat", 800, 2, props.lo, props.hi);
  setPoints(resampleCurve(base, clamped));
}

function applyFit(line: readonly ZcCurvePoint[], offsetBps: number) {
  const fitted = fitToLine(line, Math.max(2, n.value), props.lo, props.hi, offsetBps);
  if (!fitted) return;
  setPoints(fitted);
  emit("fit", fitted);
}

function addPoint() {
  const res = insertCurvePoint(props.points, selectedIdx.value, props.lo, props.hi);
  if (res) setPoints(res.pts, res.at);
}

function removePoint() {
  if (selectedIdx.value == null || n.value <= 2) return;
  const idx = selectedIdx.value;
  setPoints(
    props.points.filter((_, j) => j !== idx),
    Math.min(idx, n.value - 2)
  );
}

function onCellFocus(key: string, val: string) {
  editingCell.value = { key, text: val };
}

function onCellBlur() {
  editingCell.value = null;
}

function onMaturityCellInput(i: number, raw: string) {
  const clean = raw.replace(/[^0-9.]/g, "");
  editingCell.value = { key: `d-${i}`, text: clean };
  const v = Number(clean);
  if (!clean || !Number.isFinite(v) || v <= 0) return;
  const d = Math.round(inBlocks.value ? v : v * DAY_BLOCKS);
  const next = props.points
    .map((q, j) => (j === i ? { ...q, d } : q))
    .sort((a, b) => a.d - b.d);
  if (new Set(next.map((q) => q.d)).size === next.length) {
    emit("update:points", next);
  }
}

function onAprCellInput(i: number, raw: string) {
  const clean = raw.replace(/[^0-9.]/g, "");
  editingCell.value = { key: `y-${i}`, text: clean };
  const v = Number(clean);
  if (!clean || !Number.isFinite(v) || v < 0) return;
  emit(
    "update:points",
    props.points.map((q, j) => (j === i ? { ...q, y: Math.round(v * 100) } : q))
  );
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <!-- Top Toolbar Row: Mode Slot + Metric + Point Controls + Reflect + Market Fit -->
    <div class="flex flex-wrap items-center justify-between gap-1.5">
      <div class="flex flex-wrap items-center gap-1.5">
        <slot name="mode-toggle" />

        <!-- Y-Axis Metric Segmented Control -->
        <div class="sf-seg" role="group" aria-label="Curve Y-axis unit">
          <button
            type="button"
            class="sf-seg-btn sf-mono px-2 py-1 text-[10.5px]"
            :class="metricView === 'yield' ? 'is-active tone-cobalt' : ''"
            @click="emit('update:metric', 'yield')"
          >
            APR
          </button>
          <button
            type="button"
            class="sf-seg-btn sf-mono px-2 py-1 text-[10.5px]"
            :class="metricView === 'pct' ? 'is-active tone-cobalt' : ''"
            @click="emit('update:metric', 'pct')"
          >
            % Face
          </button>
          <button
            v-if="asset"
            type="button"
            class="sf-seg-btn sf-mono px-2 py-1 text-[10.5px]"
            :class="metricView === 'abs' ? 'is-active tone-cobalt' : ''"
            @click="emit('update:metric', 'abs')"
          >
            {{ asset }}
          </button>
        </div>

        <!-- Point Count + Add / Remove -->
        <template v-if="!readOnly">
          <div
            class="sf-seg inline-flex items-center"
            title="Number of curve breakpoints (max 20)"
          >
            <button
              type="button"
              :disabled="n <= 2"
              aria-label="Fewer points"
              class="sf-seg-btn px-1.5 py-1 text-[11px] disabled:opacity-35"
              @click="applyCount(n - 1)"
            >
              <minus-icon class="h-3 w-3" />
            </button>
            <span class="sf-mono px-1.5 text-[10.5px] font-semibold text-[color:var(--sf-ink-2)]">
              {{ n }}/{{ MAX_CURVE_POINTS }}
            </span>
            <button
              type="button"
              :disabled="n >= MAX_CURVE_POINTS"
              aria-label="More points"
              class="sf-seg-btn px-1.5 py-1 text-[11px] disabled:opacity-35"
              @click="applyCount(n + 1)"
            >
              <plus-icon class="h-3 w-3" />
            </button>
          </div>

          <button
            type="button"
            :disabled="n >= MAX_CURVE_POINTS"
            class="preset-chip"
            @click="addPoint"
          >
            <plus-icon class="h-3 w-3" />
            <span>Add</span>
          </button>
          <button
            type="button"
            :disabled="selectedIdx == null || n <= 2"
            class="preset-chip"
            @click="removePoint"
          >
            <minus-icon class="h-3 w-3" />
            <span>Del</span>
          </button>
        </template>
        <span v-else class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">
          {{ n }} pts
        </span>
      </div>

      <!-- Right Controls: Reflect + Market Fit -->
      <div v-if="!readOnly" class="flex flex-wrap items-center gap-1.5">
        <div class="flex items-center gap-1" role="group" aria-label="Reflect curve">
          <button
            type="button"
            class="preset-chip"
            title="Reflect maturity axis (swap short and long ends)"
            @click="setPoints(reflectMaturity(points, lo, hi))"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M8 2v12M5 5L2 8l3 3M11 5l3 3-3 3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            class="preset-chip"
            title="Reflect APR axis (invert slope)"
            @click="setPoints(reflectApr(points), selectedIdx)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M2 8h12M5 5L8 2l3 3M5 11l3 3 3-3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>

        <div v-if="market" class="flex items-center gap-1">
          <template v-if="side === 'offer'">
            <button
              type="button"
              :disabled="!hasBids"
              class="preset-chip tone-bid"
              title="Match best market bid curve"
              @click="applyFit(market.bidLine, 0)"
            >
              Join bids
            </button>
            <button
              type="button"
              :disabled="!hasAsks"
              class="preset-chip tone-ask"
              title="Meet open borrower asks"
              @click="applyFit(askFitSource, -1)"
            >
              Hit asks
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              :disabled="!hasAsks"
              class="preset-chip tone-ask"
              title="Match best competing asks"
              @click="applyFit(askFitSource, 0)"
            >
              Join asks
            </button>
            <button
              type="button"
              :disabled="!hasBids"
              class="preset-chip tone-bid"
              title="Meet market best bids to fill immediately"
              @click="applyFit(feeBidLine?.length ? feeBidLine : market.bidLine, 1)"
            >
              Hit bids{{ feeBidLine?.length ? " (w/ fee)" : "" }}
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- Second Toolbar Row (Editable only): Shapes + Curve Movements + BP Step -->
    <div v-if="!readOnly" class="flex flex-wrap items-center justify-between gap-1.5">
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Curve shapes">
        <button
          v-for="sh in SHAPES"
          :key="sh.key"
          type="button"
          class="preset-chip"
          @click="applyShape(sh.key)"
        >
          <svg width="18" height="12" viewBox="0 0 22 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path :d="GLYPHS[sh.key]" />
          </svg>
          <span>{{ sh.label }}</span>
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Curve movements">
        <button
          v-for="mv in MOVES"
          :key="mv.key"
          type="button"
          class="preset-chip px-1.5"
          :title="`${mv.title} (${stepBps} bp)`"
          :aria-label="mv.title"
          @click="applyMove(mv.key)"
        >
          <svg width="18" height="12" viewBox="0 0 22 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <path :d="GLYPHS[mv.key]" />
          </svg>
        </button>

        <zc-select
          :model-value="stepBps"
          :options="STEP_OPTIONS"
          aria-label="Basis points move step"
          mono
          align="right"
          @update:model-value="stepBps = Number($event)"
        />
      </div>
    </div>

    <!-- Interactive Chart Stage -->
    <div class="min-h-0 flex-1">
      <zc-interactive-chart
        :height="chartHeight"
        :fill-height="fillHeight"
        :x-domain="[lo / DAY_BLOCKS, hi / DAY_BLOCKS]"
        :y-domain="yDomain"
        :x-format="(v) => formatAxisDays(v, unit)"
        :y-format="(v) => formatMetricTick(v, metricView, ySpan, asset)"
        :margin-left="marginLeft"
        :layers="layers"
        :edit="editConfig"
        :hover-fn="hoverReadout"
        :label="side === 'offer' ? 'Lend offer yield curve' : 'Variable maturity curve'"
        @edit-change="(pts, idx) => setPoints(fromEditPts(pts), idx)"
        @edit-select="selectedIdx = $event"
      />
    </div>

    <!-- Compact Legend -->
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[10.5px] text-[color:var(--sf-muted)]">
      <div class="flex flex-wrap items-center gap-3">
        <span class="inline-flex items-center gap-1.5 font-medium text-[color:var(--sf-ink-2)]">
          <span class="h-0.5 w-3 rounded-full" :style="{ background: color }" />
          {{ side === "offer" ? "Your offer" : "Your curve" }}
        </span>
        <span v-if="market?.bidLine?.length" class="inline-flex items-center gap-1.5">
          <span class="h-0.5 w-3 rounded-full bg-[color:var(--sf-bid)]" />
          Best bid
        </span>
        <span
          v-if="feeBidLine?.length && side === 'window'"
          class="inline-flex items-center gap-1.5"
        >
          <span class="h-0 w-3 border-t-2 border-dashed border-[color:var(--sf-bid)]" />
          Bid w/ ~{{ formatNumber(feeErg, 3, 0) }} ERG fee
        </span>
        <span v-if="market?.askLine?.some((p) => p.y != null)" class="inline-flex items-center gap-1.5">
          <span class="h-0.5 w-3 rounded-full bg-[color:var(--sf-ask)]" />
          Window asks
        </span>
        <span v-if="market?.dots?.length" class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-ask)]" />
          Asks
        </span>
      </div>
      <span v-if="!readOnly" class="sf-mono hidden text-[10px] text-[color:var(--sf-dim)] lg:inline">
        Drag handles · Del removes · Shift+arrows ×10 · Ctrl+scroll zooms
      </span>
    </div>

    <!-- Compact Inline Point Matrix (Editable) -->
    <div
      v-if="!readOnly"
      class="sf-scroll flex max-h-[82px] flex-wrap gap-1.5 overflow-y-auto pt-0.5"
    >
      <div
        v-for="(p, i) in points"
        :key="i"
        class="point-pill sf-mono flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11px] transition-all"
        :class="
          selectedIdx === i
            ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-ink)]'
            : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] text-[color:var(--sf-ink-2)] hover:border-[color:var(--sf-line-strong)]'
        "
        @click="selectedIdx = i"
      >
        <span class="text-[9.5px] font-bold text-[color:var(--sf-dim)]">{{ i + 1 }}</span>
        <input
          :aria-label="`Point ${i + 1} maturity`"
          inputmode="decimal"
          :value="
            editingCell?.key === `d-${i}`
              ? editingCell.text
              : inBlocks
                ? String(p.d)
                : String(Number((p.d / DAY_BLOCKS).toFixed(2)))
          "
          class="w-[44px] bg-transparent text-right font-semibold text-[color:var(--sf-ink)] outline-none"
          @focus="
            onCellFocus(
              `d-${i}`,
              inBlocks ? String(p.d) : String(Number((p.d / DAY_BLOCKS).toFixed(2)))
            )
          "
          @blur="onCellBlur"
          @input="onMaturityCellInput(i, ($event.target as HTMLInputElement).value)"
        />
        <span class="text-[9.5px] text-[color:var(--sf-dim)]">{{ inBlocks ? "blk" : "d" }}</span>
        <span class="text-[color:var(--sf-line-strong)]">·</span>
        <input
          :aria-label="`Point ${i + 1} APR`"
          inputmode="decimal"
          :value="
            editingCell?.key === `y-${i}`
              ? editingCell.text
              : String(Number((p.y / 100).toFixed(2)))
          "
          class="w-[40px] bg-transparent text-right font-semibold text-[color:var(--sf-cobalt)] outline-none"
          @focus="onCellFocus(`y-${i}`, String(Number((p.y / 100).toFixed(2))))"
          @blur="onCellBlur"
          @input="onAprCellInput(i, ($event.target as HTMLInputElement).value)"
        />
        <span class="text-[9.5px] text-[color:var(--sf-dim)]">%</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preset-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border-radius: 8px;
  border: 1px solid var(--sf-line);
  background: var(--sf-card);
  color: var(--sf-ink-2);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  box-shadow: var(--sf-rim-top);
  transition:
    border-color 0.18s var(--sf-ease),
    background-color 0.18s var(--sf-ease),
    color 0.18s var(--sf-ease),
    transform 0.16s var(--sf-spring);
}

.preset-chip:hover:not(:disabled) {
  border-color: var(--sf-line-cobalt);
  color: var(--sf-ink);
  transform: translateY(-1px);
}

.preset-chip:active:not(:disabled) {
  transform: scale(0.96);
}

.preset-chip:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.preset-chip.tone-bid:hover:not(:disabled) {
  border-color: var(--sf-line-bid);
  background: var(--sf-bid-soft);
  color: var(--sf-bid);
}

.preset-chip.tone-ask:hover:not(:disabled) {
  border-color: var(--sf-line-ask);
  background: var(--sf-ask-soft);
  color: var(--sf-ask);
}
</style>
