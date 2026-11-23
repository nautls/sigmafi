<script setup lang="ts">
import { computed } from "vue";
import ZcInteractiveChart, {
  ChartEditConfig,
  ChartEditPoint,
  ChartLayer,
  ChartReadout
} from "./ZcInteractiveChart.vue";
import { ZcChartMetric, ZcDurationUnit, ZcMarket, ZcTwoPointYield } from "@/types/zc";
import {
  dateAtHeight,
  DAY_BLOCKS,
  feeAdjustedBidBps,
  formatApr,
  formatAxisFromNow,
  formatDur,
  formatMarketAmount,
  formatMetricTick,
  formatNumber,
  metricMarginLeft,
  niceDomain,
  priceForYield,
  toChartMetric,
  YEAR_BLOCKS,
  yieldOfAbs,
  yieldOfPct
} from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    tp: ZcTwoPointYield;
    height: number;
    end: number;
    dAt: (at: number) => number;
    face: number;
    floor?: number | null;
    bidAt?: ((at: number) => number | null) | null;
    asset?: ZcMarket | null;
    feeErg?: number;
    costBasis?: number | null;
    metric?: ZcChartMetric;
    unit?: ZcDurationUnit;
    role?: "borrow" | "sell";
    readOnly?: boolean;
    chartHeight?: number;
    fillHeight?: boolean;
  }>(),
  {
    floor: null,
    bidAt: null,
    asset: null,
    feeErg: 0,
    costBasis: null,
    metric: "yield",
    unit: "days",
    role: "borrow",
    readOnly: false,
    chartHeight: 250,
    fillHeight: false
  }
);

const emit = defineEmits<{
  (e: "update:tp", tp: ZcTwoPointYield): void;
  (e: "update:metric", metric: ZcChartMetric): void;
}>();

const metricView = computed<ZcChartMetric>(() =>
  props.metric === "abs" && !props.asset ? "pct" : props.metric
);

const span = computed(() => Math.max(1, props.end - props.height));

const toY = (yBps: number, at: number) =>
  toChartMetric(yBps, props.dAt(at), metricView.value, props.face) ?? 0;

const handlePts = computed<ChartEditPoint[]>(() => [
  { x: 0, y: toY(props.tp.y0, props.height) },
  { x: (props.tp.h1 - props.height) / DAY_BLOCKS, y: toY(props.tp.y1, props.tp.h1) }
]);

const layers = computed<ChartLayer[]>(() => {
  const k = 60;
  const out: ChartLayer[] = [];
  const xs = Array.from({ length: k + 1 }, (_, i) => props.height + (span.value * i) / k);
  const mine = xs.map((at) => {
    const yv =
      props.tp.y0 +
      ((props.tp.y1 - props.tp.y0) * (Math.min(Math.max(at, props.tp.h0), props.tp.h1) - props.tp.h0)) /
        Math.max(1, props.tp.h1 - props.tp.h0);
    return { at, yv };
  });

  const eff = mine.map(({ at, yv }) => {
    const d = props.dAt(at);
    if (!(d > 0)) return { x: (at - props.height) / DAY_BLOCKS, y: null };
    const price = Math.max(props.floor || 0, priceForYield(props.face, yv, d));
    const y =
      metricView.value === "yield"
        ? ((props.face / price - 1) * YEAR_BLOCKS) / d * 100
        : metricView.value === "pct"
          ? (price / props.face) * 100
          : price;
    return { x: (at - props.height) / DAY_BLOCKS, y };
  });

  if (props.bidAt) {
    const rawBids = xs.map((at) => {
      const b = props.bidAt!(at);
      const d = props.dAt(at);
      return {
        x: (at - props.height) / DAY_BLOCKS,
        y: b == null ? null : toChartMetric(b, d, metricView.value, props.face)
      };
    });
    if (props.feeErg > 0) {
      const effBids = xs.map((at) => {
        const b = props.bidAt!(at);
        const d = props.dAt(at);
        const eb = b != null && d > 0 ? feeAdjustedBidBps(props.face, b, d, props.feeErg) : null;
        return {
          x: (at - props.height) / DAY_BLOCKS,
          y: eb == null ? null : toChartMetric(eb, d, metricView.value, props.face)
        };
      });
      out.push({
        type: "line",
        key: "bidRaw",
        color: "var(--sf-bid)",
        width: 1.2,
        dash: "2 4",
        opacity: 0.45,
        points: rawBids
      });
      out.push({
        type: "line",
        key: "bid",
        color: "var(--sf-bid)",
        width: 1.8,
        dash: "5 4",
        opacity: 0.92,
        points: effBids
      });
      out.push(
        metricView.value === "yield"
          ? { type: "cross", key: "x", upper: eff, lower: effBids, color: "var(--sf-bid)", opacity: 0.16 }
          : { type: "cross", key: "x", upper: effBids, lower: eff, color: "var(--sf-bid)", opacity: 0.16 }
      );
    } else {
      out.push({
        type: "line",
        key: "bid",
        color: "var(--sf-bid)",
        width: 1.7,
        dash: "5 4",
        points: rawBids
      });
      out.push(
        metricView.value === "yield"
          ? { type: "cross", key: "x", upper: eff, lower: rawBids, color: "var(--sf-bid)", opacity: 0.16 }
          : { type: "cross", key: "x", upper: rawBids, lower: eff, color: "var(--sf-bid)", opacity: 0.16 }
      );
    }
  }

  if (metricView.value !== "yield" && props.floor && props.floor > 0) {
    out.push({
      type: "hline",
      key: "floor",
      y: metricView.value === "pct" ? (props.floor / props.face) * 100 : props.floor,
      color: "var(--sf-muted)",
      dash: "2 4",
      opacity: 0.6,
      label: "price floor"
    });
  }

  if (metricView.value !== "yield" && props.costBasis != null && props.face > 0) {
    out.push({
      type: "hline",
      key: "basis",
      y: metricView.value === "pct" ? (props.costBasis / props.face) * 100 : props.costBasis,
      color: "var(--sf-warn)",
      dash: "3 4",
      opacity: 0.72,
      label: "your cost"
    });
  }

  const quoted = mine.map(({ at, yv }) => ({
    x: (at - props.height) / DAY_BLOCKS,
    y: toChartMetric(yv, props.dAt(at), metricView.value, props.face)
  }));
  const eps =
    metricView.value === "yield"
      ? 0.005
      : metricView.value === "pct"
        ? 0.01
        : Math.max(0.0005, props.face * 0.0001);
  if (
    props.floor &&
    quoted.some((q, i) => eff[i].y != null && q.y != null && Math.abs(q.y - eff[i].y!) > eps)
  ) {
    out.push({
      type: "line",
      key: "quoted",
      color: "var(--sf-ask)",
      width: 1.3,
      dash: "3 4",
      opacity: 0.55,
      points: quoted
    });
  }

  out.push({ type: "line", key: "eff", color: "var(--sf-ask)", width: 2.6, points: eff });
  return out;
});

const yDomain = computed<[number, number]>(() => {
  const ys: number[] = [];
  for (const L of layers.value) {
    if (L.type === "line" || L.type === "area") {
      for (const p of L.points) if (p.y != null && Number.isFinite(p.y)) ys.push(p.y);
    } else if (L.type === "cross") {
      for (const p of L.upper) if (p.y != null && Number.isFinite(p.y)) ys.push(p.y);
    }
  }
  for (const p of handlePts.value) if (Number.isFinite(p.y)) ys.push(p.y);
  if (metricView.value !== "yield" && props.costBasis != null && props.face > 0) {
    ys.push(metricView.value === "pct" ? (props.costBasis / props.face) * 100 : props.costBasis);
  }
  return niceDomain(ys, 0.16, metricView.value === "yield");
});

const ySpan = computed(() => yDomain.value[1] - yDomain.value[0]);
const marginLeft = computed(() => metricMarginLeft(yDomain.value, metricView.value, props.asset));
const absSnapY = computed(() =>
  Math.max(props.asset === "ERG" ? 0.001 : 0.01, Number((props.face / 2000).toPrecision(1)))
);

const editConfig = computed<ChartEditConfig>(() => ({
  points: handlePts.value,
  color: "var(--sf-ask)",
  lockX: (i) => props.readOnly || i === 0,
  lockY: () => props.readOnly,
  minGap: span.value / DAY_BLOCKS / 200,
  snapX: span.value > 2 * DAY_BLOCKS ? 1 / 24 : 1 / 720,
  snapY: metricView.value === "abs" ? absSnapY.value : 0.01,
  keyY: metricView.value === "abs" ? absSnapY.value * 5 : 0.05,
  xBounds: [0, span.value / DAY_BLOCKS],
  yBounds:
    metricView.value === "yield"
      ? [0, 200]
      : metricView.value === "pct"
        ? [10, 100]
        : [props.face * 0.1, props.face],
  tags: ["now", props.tp.h1 >= props.end ? "expiry" : formatDur(props.tp.h1 - props.height, props.unit)]
}));

function onEditChange(next: ChartEditPoint[]) {
  if (props.readOnly || next.length < 2) return;
  const conv = (p: ChartEditPoint, at: number) =>
    metricView.value === "yield"
      ? Math.round(p.y * 100)
      : metricView.value === "pct"
        ? Math.round(yieldOfPct(p.y, props.dAt(at)))
        : Math.round(yieldOfAbs(p.y, props.face, props.dAt(at)));
  const h1 = Math.max(props.height + 1, Math.round(props.height + next[1].x * DAY_BLOCKS));
  emit("update:tp", {
    h0: props.height,
    y0: Math.max(0, conv(next[0], props.height)),
    h1,
    y1: Math.max(0, conv(next[1], h1))
  });
}

function hoverReadout(xv: number): ChartReadout {
  const at = props.height + xv * DAY_BLOCKS;
  const d = props.dAt(at);
  const yv =
    props.tp.y0 +
    ((props.tp.y1 - props.tp.y0) * (Math.min(Math.max(at, props.tp.h0), props.tp.h1) - props.tp.h0)) /
      Math.max(1, props.tp.h1 - props.tp.h0);
  const price = Math.max(props.floor || 0, priceForYield(props.face, yv, d));
  const b = props.bidAt ? props.bidAt(at) : null;
  const eb = props.feeErg > 0 && b != null && d > 0 ? feeAdjustedBidBps(props.face, b, d, props.feeErg) : null;
  const bidPrice = b != null && d > 0 ? priceForYield(props.face, b, d) : null;
  const effBidPrice = eb != null && d > 0 ? priceForYield(props.face, eb, d) : null;

  const rows: ChartReadout["rows"] = [
    {
      label: props.role === "sell" ? "Buyer earns" : "You pay",
      value: formatApr(((props.face / price - 1) * YEAR_BLOCKS) / d * 10_000),
      tone: "ask"
    },
    { label: "% of face", value: `${formatNumber((price / props.face) * 100, 2, 2)}%` },
    {
      label: props.role === "sell" ? "Proceeds" : "Receive",
      value: props.asset ? formatMarketAmount(price, props.asset) : formatNumber(price, 2, 2)
    }
  ];
  if (b != null) {
    rows.push({
      label: eb != null ? "Best bid (raw)" : "Best bid",
      value:
        props.asset && bidPrice != null
          ? `${formatApr(b)} · ${formatMarketAmount(bidPrice, props.asset)}`
          : formatApr(b),
      tone: "bid"
    });
  }
  if (eb != null) {
    rows.push({
      label: "Bid w/ fee",
      value:
        props.asset && effBidPrice != null
          ? `${formatApr(eb)} · ${formatMarketAmount(effBidPrice, props.asset)}`
          : formatApr(eb),
      tone: "bid"
    });
  }

  return {
    header: `In ${formatDur(Math.max(1, at - props.height), props.unit)}`,
    subHeader: dateAtHeight(Math.round(at), props.height),
    rows
  };
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-1.5">
        <slot name="mode-toggle" />
        <div class="sf-seg" role="group" aria-label="Time editor Y-axis">
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
      </div>

      <div v-if="!readOnly" class="flex flex-wrap items-center gap-1">
        <button
          type="button"
          class="path-btn"
          @click="emit('update:tp', { ...tp, y1: tp.y0 })"
        >
          Fixed
        </button>
        <button
          type="button"
          class="path-btn"
          @click="emit('update:tp', { ...tp, y1: tp.y0 + 100 })"
        >
          Rising +1%
        </button>
        <button
          type="button"
          class="path-btn"
          @click="emit('update:tp', { ...tp, y1: Math.max(0, tp.y0 - 100) })"
        >
          Falling −1%
        </button>
        <button
          type="button"
          class="path-btn"
          title="Flip start and end APR"
          @click="emit('update:tp', { ...tp, y0: tp.y1, y1: tp.y0 })"
        >
          Flip ↕
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <zc-interactive-chart
        :height="chartHeight"
        :fill-height="fillHeight"
        :x-domain="[0, span / DAY_BLOCKS]"
        :y-domain="yDomain"
        :x-format="(v) => formatAxisFromNow(v, unit)"
        :y-format="(v) => formatMetricTick(v, metricView, ySpan, asset)"
        :margin-left="marginLeft"
        :layers="layers"
        :edit="editConfig"
        :hover-fn="hoverReadout"
        label="APR and price over fill time"
        @edit-change="onEditChange"
      />
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-[color:var(--sf-muted)]">
      <div class="flex flex-wrap items-center gap-3">
        <span class="inline-flex items-center gap-1.5 font-medium text-[color:var(--sf-ink-2)]">
          <span class="h-0.5 w-3 rounded-full bg-[color:var(--sf-ask)]" />
          {{ role === "sell" ? "Sale path" : "Borrow path" }}
        </span>
        <span v-if="bidAt" class="inline-flex items-center gap-1.5">
          <span class="h-0 w-3 border-t-2 border-dashed border-[color:var(--sf-bid)]" />
          {{ feeErg > 0 ? `Best bid (incl. ~${formatNumber(feeErg, 3, 0)} ERG fee)` : "Best bid" }}
        </span>
        <span v-if="bidAt" class="inline-flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-[3px] bg-[color:var(--sf-bid)] opacity-30" />
          Clears bid
        </span>
      </div>
      <span v-if="!readOnly" class="sf-mono hidden text-[10px] text-[color:var(--sf-dim)] sm:inline">
        Drag handles to shape fill-time path
      </span>
    </div>
  </div>
</template>

<style scoped>
.path-btn {
  display: inline-flex;
  align-items: center;
  height: 27px;
  padding: 0 9px;
  border-radius: 8px;
  border: 1px solid var(--sf-line);
  background: var(--sf-card);
  color: var(--sf-ink-2);
  font-size: 11px;
  font-weight: 600;
  box-shadow: var(--sf-rim-top);
  transition: all 0.16s var(--sf-ease);
}
.path-btn:hover {
  border-color: var(--sf-line-cobalt);
  color: var(--sf-ink);
  transform: translateY(-1px);
}
.path-btn:active {
  transform: scale(0.96);
}
</style>
