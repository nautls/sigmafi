<script setup lang="ts">
import { computed } from "vue";
import ZcInteractiveChart, { ChartLayer, ChartReadout } from "./ZcInteractiveChart.vue";
import { ZcDurationUnit, ZcMarket, ZcTwoPointYield } from "@/types/zc";
import {
  dateAtHeight,
  DAY_BLOCKS,
  formatApr,
  formatAxisFromNow,
  formatDur,
  formatMarketAmount,
  formatNumber,
  niceDomain,
  priceForYield,
  signedFormat,
  YEAR_BLOCKS
} from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    tp?: ZcTwoPointYield | null;
    fixedPrice?: number | null;
    floor?: number | null;
    face: number;
    costBasis: number;
    entryAt?: number | null;
    maturity: number;
    height: number;
    expiryH: number;
    market: ZcMarket;
    unit?: ZcDurationUnit;
    chartHeight?: number;
    fillHeight?: boolean;
  }>(),
  {
    tp: null,
    fixedPrice: null,
    floor: null,
    entryAt: null,
    unit: "days",
    chartHeight: 245,
    fillHeight: false
  }
);

const span = computed(() => Math.max(1, props.expiryH - props.height));

const entryYieldBps = computed(() => {
  if (!(props.costBasis > 0) || !(props.face > props.costBasis) || props.entryAt == null) return null;
  const term = props.maturity - props.entryAt;
  if (!(term > 0)) return null;
  return ((props.face / props.costBasis - 1) * YEAR_BLOCKS * 10_000) / term;
});

function salePriceAt(at: number): number | null {
  const rem = props.maturity - at;
  if (!(rem > 0)) return null;
  if (props.fixedPrice != null) return props.fixedPrice;
  if (!props.tp) return null;
  const { h0, y0, h1, y1 } = props.tp;
  const t = Math.min(Math.max(at, h0), h1);
  const bps = y0 + ((y1 - y0) * (t - h0)) / Math.max(1, h1 - h0);
  return Math.max(props.floor || 0, priceForYield(props.face, bps, rem));
}

function accruedPnlAt(at: number): number | null {
  if (props.entryAt == null || !(props.costBasis > 0)) return null;
  const total = props.maturity - props.entryAt;
  if (!(total > 0)) return null;
  const elapsed = Math.max(0, Math.min(total, at - props.entryAt));
  return ((props.face - props.costBasis) * elapsed) / total;
}

const series = computed(() => {
  const k = 60;
  const xs = Array.from({ length: k + 1 }, (_, i) => props.height + (span.value * i) / k);
  const pnlPts = xs.map((at) => {
    const px = salePriceAt(at);
    return {
      x: (at - props.height) / DAY_BLOCKS,
      y: px != null ? px - props.costBasis : null
    };
  });
  const zeroPts = xs.map((at) => ({ x: (at - props.height) / DAY_BLOCKS, y: 0 }));
  const accPts =
    props.entryAt != null
      ? xs.map((at) => ({ x: (at - props.height) / DAY_BLOCKS, y: accruedPnlAt(at) }))
      : [];
  return { pnlPts, zeroPts, accPts };
});

const layers = computed<ChartLayer[]>(() => {
  const { pnlPts, zeroPts, accPts } = series.value;
  const out: ChartLayer[] = [
    { type: "cross", key: "gain", upper: pnlPts, lower: zeroPts, color: "var(--sf-bid)", opacity: 0.16 },
    { type: "cross", key: "loss", upper: zeroPts, lower: pnlPts, color: "var(--sf-danger)", opacity: 0.16 },
    {
      type: "hline",
      key: "zero",
      y: 0,
      color: "var(--sf-dim)",
      dash: "3 4",
      opacity: 0.72,
      label: "breakeven"
    }
  ];
  if (accPts.length > 1) {
    out.push({
      type: "line",
      key: "accrued",
      points: accPts,
      color: "var(--sf-muted)",
      width: 1.4,
      dash: "4 4",
      opacity: 0.75
    });
  }
  out.push({
    type: "line",
    key: "pnl",
    points: pnlPts,
    color: "var(--sf-cobalt)",
    width: 2.5,
    opacity: 0.98
  });
  return out;
});

const yDomain = computed<[number, number]>(() => {
  const ys = [
    0,
    ...series.value.pnlPts.map((p) => p.y).filter((v): v is number => v != null),
    ...series.value.accPts.map((p) => p.y).filter((v): v is number => v != null)
  ];
  return niceDomain(ys, 0.18, false);
});

const xDomain = computed<[number, number]>(() => [0, Math.max(span.value / DAY_BLOCKS, 1)]);

function fmtY(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${formatNumber(v, props.market === "SigUSD" ? 2 : 3, 0)}`;
}

function hoverReadout(daysFromNow: number): ChartReadout | null {
  const at = Math.round(props.height + daysFromNow * DAY_BLOCKS);
  const px = salePriceAt(at);
  if (px == null) return null;
  const pnl = px - props.costBasis;
  const pct = props.costBasis > 0 ? (pnl / props.costBasis) * 100 : null;
  const held = props.entryAt != null ? Math.max(1, at - props.entryAt) : null;
  const earnedBps =
    held != null && props.costBasis > 0
      ? ((px / props.costBasis - 1) * YEAR_BLOCKS * 10_000) / held
      : null;
  const acc = accruedPnlAt(at);

  const fmtAmt = (x: number) => formatMarketAmount(x, props.market);
  const rows: ChartReadout["rows"] = [
    {
      label: "P&L",
      value: `${signedFormat(pnl, fmtAmt)}${pct != null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}`,
      tone: pnl > 0 ? "bid" : pnl < 0 ? "danger" : "default"
    },
    {
      label: "Sale price",
      value: formatMarketAmount(px, props.market)
    }
  ];
  if (earnedBps != null) {
    rows.push({
      label: "APR earned",
      value: formatApr(earnedBps),
      tone: earnedBps >= 0 ? "cobalt" : "danger"
    });
  }
  if (acc != null) {
    const diff = pnl - acc;
    rows.push({
      label: "Vs entry APR",
      value: `${signedFormat(diff, fmtAmt)}${entryYieldBps.value != null ? ` (${formatApr(entryYieldBps.value)})` : ""}`,
      tone: diff >= 0 ? "bid" : "warn"
    });
  }

  return {
    header: daysFromNow < 0.04 ? "If sold now" : `In ${formatDur(at - props.height, props.unit)}`,
    subHeader: dateAtHeight(at, props.height),
    marks: [{ y: pnl, color: pnl >= 0 ? "var(--sf-bid)" : "var(--sf-danger)" }],
    rows
  };
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <zc-interactive-chart
      :height="chartHeight"
      :fill-height="fillHeight"
      :x-domain="xDomain"
      :y-domain="yDomain"
      :x-format="(v) => formatAxisFromNow(v, unit)"
      :y-format="fmtY"
      :margin-left="56"
      :layers="layers"
      :hover-fn="hoverReadout"
      label="Resale profit and loss over fill time"
    />
  </div>
</template>
