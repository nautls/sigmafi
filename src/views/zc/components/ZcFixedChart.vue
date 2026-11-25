<script setup lang="ts">
import { computed } from "vue";
import ZcInteractiveChart, { ChartLayer, ChartReadout } from "./ZcInteractiveChart.vue";
import { ZcChartMetric, ZcDurationUnit, ZcMarket } from "@/types/zc";
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
  priceToChartMetric,
  toChartMetric,
  yieldForPrice
} from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    principal: number;
    repayment: number;
    height: number;
    expiryH: number;
    dAt: (at: number) => number;
    bidAt: (at: number) => number | null;
    asset?: ZcMarket | null;
    feeErg?: number;
    metric?: ZcChartMetric;
    costBasis?: number | null;
    role?: "borrow" | "sell";
    payLabel?: string;
    unit?: ZcDurationUnit;
    chartHeight?: number;
    fillHeight?: boolean;
  }>(),
  {
    asset: null,
    feeErg: 0,
    metric: "yield",
    costBasis: null,
    role: "borrow",
    payLabel: "You pay",
    unit: "days",
    chartHeight: 240,
    fillHeight: false
  }
);

const emit = defineEmits<{
  (e: "update:metric", m: ZcChartMetric): void;
}>();

const metricView = computed<ZcChartMetric>(() =>
  props.metric === "abs" && !props.asset ? "pct" : props.metric
);

const span = computed(() => Math.max(1, props.expiryH - props.height));

const layers = computed<ChartLayer[]>(() => {
  const xs = Array.from({ length: 61 }, (_, i) => props.height + (span.value * i) / 60);
  const mine = xs.map((at) => {
    const d = props.dAt(at);
    return {
      x: (at - props.height) / DAY_BLOCKS,
      y: d > 0 ? priceToChartMetric(props.principal, props.repayment, d, metricView.value) : null
    };
  });
  const rawBid = xs.map((at) => {
    const d = props.dAt(at);
    const b = props.bidAt(at);
    return {
      x: (at - props.height) / DAY_BLOCKS,
      y: b == null || !(d > 0) ? null : toChartMetric(b, d, metricView.value, props.repayment)
    };
  });
  const effBid =
    props.feeErg > 0
      ? xs.map((at) => {
          const d = props.dAt(at);
          const b = props.bidAt(at);
          const eb =
            b != null && d > 0 ? feeAdjustedBidBps(props.repayment, b, d, props.feeErg) : null;
          return {
            x: (at - props.height) / DAY_BLOCKS,
            y: eb == null ? null : toChartMetric(eb, d, metricView.value, props.repayment)
          };
        })
      : rawBid;

  const out: ChartLayer[] = [
    metricView.value === "yield"
      ? { type: "cross", key: "x", upper: mine, lower: effBid, color: "var(--sf-bid)", opacity: 0.16 }
      : { type: "cross", key: "x", upper: effBid, lower: mine, color: "var(--sf-bid)", opacity: 0.16 },
    ...(props.feeErg > 0
      ? [
          {
            type: "line" as const,
            key: "bRaw",
            points: rawBid,
            color: "var(--sf-bid)",
            width: 1.2,
            dash: "2 4",
            opacity: 0.45
          }
        ]
      : []),
    {
      type: "line",
      key: "b",
      points: effBid,
      color: "var(--sf-bid)",
      width: props.feeErg > 0 ? 1.8 : 1.7,
      dash: "5 4",
      opacity: 0.92
    },
    { type: "line", key: "m", points: mine, color: "var(--sf-ask)", width: 2.6 }
  ];

  if (metricView.value !== "yield" && props.costBasis != null && props.repayment > 0) {
    out.push({
      type: "hline",
      key: "basis",
      y:
        metricView.value === "pct"
          ? (props.costBasis / props.repayment) * 100
          : props.costBasis,
      color: "var(--sf-warn)",
      dash: "3 4",
      opacity: 0.72,
      label: "your cost"
    });
  }
  return out;
});

const yDomain = computed<[number, number]>(() => {
  const ys: number[] = [];
  for (const L of layers.value) {
    if (L.type === "line") {
      for (const p of L.points) if (p.y != null && Number.isFinite(p.y)) ys.push(p.y);
    }
  }
  if (metricView.value !== "yield" && props.costBasis != null && props.repayment > 0) {
    ys.push(
      metricView.value === "pct" ? (props.costBasis / props.repayment) * 100 : props.costBasis
    );
  }
  return niceDomain(ys, metricView.value === "yield" ? 0.2 : 0.14, metricView.value === "yield");
});

const ySpan = computed(() => yDomain.value[1] - yDomain.value[0]);
const marginLeft = computed(() => metricMarginLeft(yDomain.value, metricView.value, props.asset));

function hoverReadout(xv: number): ChartReadout {
  const at = props.height + xv * DAY_BLOCKS;
  const d = props.dAt(at);
  const b = props.bidAt(at);
  const eb =
    props.feeErg > 0 && b != null && d > 0
      ? feeAdjustedBidBps(props.repayment, b, d, props.feeErg)
      : null;
  const bidPrice = b != null && d > 0 ? priceForYield(props.repayment, b, d) : null;
  const effBidPrice = eb != null && d > 0 ? priceForYield(props.repayment, eb, d) : null;

  const rows: ChartReadout["rows"] = [
    {
      label: props.payLabel,
      value: formatApr(yieldForPrice(props.repayment, props.principal, d)),
      tone: "ask"
    },
    {
      label: "% of face",
      value: `${formatNumber((props.principal / props.repayment) * 100, 2, 2)}%`
    },
    {
      label: props.role === "sell" ? "Sale price" : "Receive",
      value: props.asset
        ? formatMarketAmount(props.principal, props.asset)
        : formatNumber(props.principal, 2, 2)
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
        <div class="sf-seg" role="group" aria-label="Chart Y-axis unit">
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

      <div class="flex items-center gap-3 text-[10.5px] text-[color:var(--sf-muted)]">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-0.5 w-3 bg-[color:var(--sf-ask)]" />
          Fixed {{ role === "sell" ? "ask" : "order" }}
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-0 w-3 border-t-2 border-dashed border-[color:var(--sf-bid)]" />
          {{ feeErg > 0 ? "Bid w/ fee" : "Best bid" }}
        </span>
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
        :hover-fn="hoverReadout"
        label="Fixed price over fill time"
      />
    </div>
  </div>
</template>
