<script setup lang="ts">
import { computed } from "vue";
import ZcInteractiveChart, {
  ChartEditConfig,
  ChartEditPoint,
  ChartLayer,
  ChartReadout
} from "./ZcInteractiveChart.vue";
import { ZcDurationUnit } from "@/types/zc";
import {
  dateAtHeight,
  DAY_BLOCKS,
  formatAxisFromNow,
  formatDur,
  formatNumber,
  niceDomain
} from "@/utils/zcMath";

export interface DutchSchedule {
  start: number;
  opening: number;
  end: number;
  floor: number;
  expiry: number;
}

const props = withDefaults(
  defineProps<{
    sched: DutchSchedule;
    height: number;
    unitLabel: string;
    durationUnit?: ZcDurationUnit;
    reference?: number | null;
    refLabel?: string | null;
    color?: string;
    lockStart?: boolean;
    yFormat?: (v: number) => string;
    chartHeight?: number;
    fillHeight?: boolean;
  }>(),
  {
    durationUnit: "days",
    reference: null,
    refLabel: null,
    color: "var(--sf-ask)",
    lockStart: false,
    yFormat: undefined,
    chartHeight: 260,
    fillHeight: false
  }
);

const emit = defineEmits<{
  (e: "update:sched", s: DutchSchedule): void;
}>();

const toX = (at: number) => (at - props.height) / DAY_BLOCKS;

const handlePts = computed<ChartEditPoint[]>(() => [
  { x: toX(props.sched.start), y: props.sched.opening },
  { x: toX(props.sched.end), y: props.sched.floor },
  { x: toX(props.sched.expiry), y: props.sched.floor }
]);

const layers = computed<ChartLayer[]>(() => {
  const out: ChartLayer[] = [];
  if (props.reference != null) {
    out.push({
      type: "hline",
      key: "ref",
      y: props.reference,
      color: "var(--sf-cobalt)",
      dash: "3 4",
      opacity: 0.72,
      label: props.refLabel || undefined
    });
  }
  const pathPts = [{ x: 0, y: props.sched.opening }, ...handlePts.value];
  out.push({ type: "area", key: "area", color: props.color, opacity: 0.1, points: pathPts, base: 0 });
  out.push({ type: "line", key: "path", color: props.color, width: 2.6, points: pathPts });
  out.push({ type: "vline", key: "now", x: 0, color: "var(--sf-muted)", label: "now" });
  return out;
});

const yDomain = computed<[number, number]>(() =>
  niceDomain([0, props.sched.opening, props.sched.floor, props.reference ?? 0], 0.14, true)
);

const xMax = computed(() => Math.max(toX(props.sched.expiry) * 1.14, 2));

const editConfig = computed<ChartEditConfig>(() => ({
  points: handlePts.value,
  color: props.color,
  minGap: 1 / 24,
  snapX: 1 / 24,
  snapY: props.unitLabel === "ERG" ? 0.01 : 1,
  keyY: props.unitLabel === "ERG" ? 0.1 : 5,
  xBounds: [0, Math.max(toX(props.sched.expiry) * 3, 6)],
  yBounds: [0, yDomain.value[1] * 3],
  lockX: (i) => i === 0 && props.lockStart,
  lockY: (i) => i === 2,
  tags: ["open", "floor", "expiry"]
}));

function onEditChange(next: ChartEditPoint[]) {
  if (next.length < 3) return;
  const at = (p: ChartEditPoint) => Math.round(props.height + p.x * DAY_BLOCKS);
  const opening = Math.max(next[0].y, 0);
  const floor = Math.min(Math.max(next[1].y, 0), opening);
  const start = props.lockStart ? props.sched.start : Math.max(props.height, at(next[0]));
  const end = Math.max(at(next[1]), start + 1);
  const expiry = Math.max(at(next[2]), end + 1);
  emit("update:sched", { start, opening, end, floor, expiry });
}

function fmtY(v: number): string {
  return props.yFormat ? props.yFormat(v) : formatNumber(v, 2, 0);
}

function hoverReadout(xv: number): ChartReadout {
  const at = props.height + xv * DAY_BLOCKS;
  const s = props.sched;
  const price =
    at <= s.start
      ? s.opening
      : at >= s.expiry
        ? null
        : at >= s.end
          ? s.floor
          : s.opening + ((s.floor - s.opening) * (at - s.start)) / Math.max(1, s.end - s.start);
  return {
    header: xv <= 0 ? "Now" : `In ${formatDur(at - props.height, props.durationUnit)}`,
    subHeader: dateAtHeight(Math.round(at), props.height),
    rows: [
      {
        label: "Price",
        value: price == null ? "Refundable" : `${fmtY(price)} ${props.unitLabel}`,
        tone: price == null ? "default" : "ask"
      }
    ]
  };
}
</script>

<template>
  <zc-interactive-chart
    :height="chartHeight"
    :fill-height="fillHeight"
    :x-domain="[0, xMax]"
    :y-domain="yDomain"
    :x-limit="[0, Math.max(xMax * 3, 6)]"
    :y-limit="[0, yDomain[1] * 3]"
    :x-format="(v) => formatAxisFromNow(v, durationUnit)"
    :y-format="fmtY"
    :layers="layers"
    :edit="editConfig"
    :hover-fn="hoverReadout"
    label="Falling-price auction schedule"
    @edit-change="onEditChange"
  />
</template>
