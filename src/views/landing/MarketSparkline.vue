<script setup lang="ts">
import { computed } from "vue";
import { vDrawOnView } from "@/directives/vDrawOnView";
import { ZcCurves } from "@/types/zc";
import { DAY_BLOCKS } from "@/utils/zcMath";

let instanceCounter = 0;

const props = defineProps<{
  curves: ZcCurves | null;
}>();

const gradId = `sfMiniBid-${++instanceCounter}`;

const W = 220;
const H = 56;
const MAX_D = 365 * DAY_BLOCKS;

const bidPts = computed(() => {
  const c = props.curves;
  if (!c) return [] as { x: number; y: number }[];
  return c.bidLine
    .filter((p) => p.y != null && p.d <= MAX_D)
    .map((p) => ({ x: p.d / MAX_D, y: (p.y as number) / 100 }));
});

const askDots = computed(() => {
  const c = props.curves;
  if (!c) return [] as { x: number; y: number }[];
  return c.dots
    .filter((d) => d.d <= MAX_D)
    .map((d) => ({ x: d.d / MAX_D, y: d.y / 100 }));
});

const maxY = computed(() => {
  const ys = [...bidPts.value.map((p) => p.y), ...askDots.value.map((p) => p.y)];
  if (!ys.length) return 15;
  return Math.max(8, Math.max(...ys) * 1.25);
});

const sx = (nx: number) => 6 + nx * (W - 12);
const sy = (val: number) => H - 8 - (Math.min(maxY.value, Math.max(0, val)) / maxY.value) * (H - 16);

const path = computed(() => {
  if (bidPts.value.length < 2) return "";
  return bidPts.value
    .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
    .join(" ");
});

const area = computed(() => {
  if (bidPts.value.length < 2) return "";
  const first = sx(bidPts.value[0].x).toFixed(1);
  const last = sx(bidPts.value[bidPts.value.length - 1].x).toFixed(1);
  return `${path.value} L${last},${H - 6} L${first},${H - 6} Z`;
});
</script>

<template>
  <svg v-draw-on-view :viewBox="`0 0 ${W} ${H}`" class="h-14 w-full" aria-hidden="true">
    <defs>
      <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--sf-bid)" stop-opacity="0.22" />
        <stop offset="100%" stop-color="var(--sf-bid)" stop-opacity="0" />
      </linearGradient>
    </defs>

    <line
      x1="4"
      :x2="W - 4"
      :y1="H - 6"
      :y2="H - 6"
      stroke="var(--sf-line-strong)"
      stroke-dasharray="2 4"
    />

    <g class="sf-plot-traces">
      <path v-if="area" :d="area" :fill="`url(#${gradId})`" />
      <path
        v-if="path"
        :d="path"
        fill="none"
        stroke="var(--sf-bid)"
        stroke-width="2"
        stroke-linecap="round"
      />

      <circle
        v-for="(dot, i) in askDots"
        :key="i"
        :cx="sx(dot.x)"
        :cy="sy(dot.y)"
        r="3.4"
        fill="var(--sf-ask)"
        stroke="var(--sf-card)"
        stroke-width="1.4"
      />
    </g>
  </svg>
</template>
