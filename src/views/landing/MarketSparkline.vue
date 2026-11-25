<script setup lang="ts">
import { computed } from "vue";
import { vDrawOnView } from "@/directives/vDrawOnView";
import { ZcAskSummary, ZcCurves } from "@/types/zc";
import {
  bestWindowAskAt,
  DAY_BLOCKS,
  fixedAskDots,
  visibleWindows,
  windowYieldAtPoint,
  YEAR_BLOCKS
} from "@/utils/zcMath";

let instanceCounter = 0;

const props = defineProps<{
  curves: ZcCurves | null;
  asks?: ZcAskSummary[];
  height?: number;
  oracleRefreshing?: boolean;
}>();

const gradId = `sfMiniBid-${++instanceCounter}`;

const W = 220;
const H = 56;

const askById = computed(() => new Map((props.asks || []).map((a) => [a.id, a])));
const maxD = computed(() => Math.max(30 * DAY_BLOCKS, props.curves?.domain?.[1] || YEAR_BLOCKS));
const windows = computed(() => visibleWindows(props.curves));

const bidPts = computed(() => {
  const c = props.curves;
  if (!c) return [] as { x: number; y: number | null }[];
  return c.bidLine
    .filter((p) => p.d >= 0 && p.d <= maxD.value)
    .map((p) => ({
      x: p.d / maxD.value,
      y: p.y == null ? null : p.y / 100
    }));
});

const windowCurvesData = computed(() =>
  windows.value
    .map((w) => {
      const lo = Math.max(0, w.min);
      const hi = Math.min(maxD.value, w.max);
      if (lo > hi) return null;
      const pts = Array.from({ length: 25 }, (_, i) => {
        const d = lo + ((hi - lo) * i) / 24;
        const bps = windowYieldAtPoint(w, d, askById.value, props.height ?? 0);
        return { x: d / maxD.value, y: bps != null ? bps / 100 : null };
      });
      return { id: w.id, pts };
    })
    .filter((w): w is { id: string; pts: { x: number; y: number | null }[] } => w != null)
);

const askEnvelopePts = computed(() => {
  const c = props.curves;
  if (!c || !windows.value.length) return [] as { x: number; y: number | null }[];
  const xs = new Set<number>();
  for (const w of windows.value) {
    const lo = Math.max(0, w.min);
    const hi = Math.min(maxD.value, w.max);
    if (lo > hi) continue;
    xs.add(lo);
    xs.add(hi);
    for (const pt of w.points) if (pt.d >= lo && pt.d <= hi) xs.add(pt.d);
    for (let i = 1; i < 24; i++) xs.add(Math.round(lo + ((hi - lo) * i) / 24));
    if (lo > 0) xs.add(lo - 1);
    if (hi < maxD.value) xs.add(hi + 1);
  }
  return [...xs]
    .sort((a, b) => a - b)
    .map((d) => {
      const bps = bestWindowAskAt(c, d, askById.value, props.height ?? 0);
      return { x: d / maxD.value, y: bps == null ? null : bps / 100 };
    });
});

const askDots = computed(() => {
  const c = props.curves;
  if (!c) return [] as { id: string; x: number; y: number; active: boolean }[];
  return fixedAskDots(c)
    .filter((d) => d.d >= 0 && d.d <= maxD.value)
    .map((d) => ({
      id: d.id,
      x: d.d / maxD.value,
      y: d.y / 100,
      active: d.ok || !!props.oracleRefreshing
    }));
});

const maxY = computed(() => {
  const ys = [
    ...bidPts.value.map((p) => p.y),
    ...askEnvelopePts.value.map((p) => p.y),
    ...windowCurvesData.value.flatMap((w) => w.pts.map((p) => p.y)),
    ...askDots.value.map((p) => p.y)
  ].filter((v): v is number => v != null && Number.isFinite(v));
  if (!ys.length) return 15;
  return Math.max(8, Math.max(...ys) * 1.25);
});

const sx = (nx: number) => 6 + nx * (W - 12);
const sy = (val: number) => H - 8 - (Math.min(maxY.value, Math.max(0, val)) / maxY.value) * (H - 16);

function buildSegmentedPath(pts: { x: number; y: number | null }[]): string {
  const segs: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (const p of pts) {
    if (p.y == null || !Number.isFinite(p.y)) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
    } else {
      cur.push({ x: p.x, y: p.y });
    }
  }
  if (cur.length > 1) segs.push(cur);
  return segs
    .map((seg) =>
      seg
        .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
        .join(" ")
    )
    .join(" ");
}

function buildAreaPath(pts: { x: number; y: number | null }[]): string {
  const baseY = (H - 6).toFixed(1);
  const segs: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (const p of pts) {
    if (p.y == null || !Number.isFinite(p.y)) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
    } else {
      cur.push({ x: p.x, y: p.y });
    }
  }
  if (cur.length > 1) segs.push(cur);
  return segs
    .map(
      (seg) =>
        `M${sx(seg[0].x).toFixed(1)},${baseY}` +
        seg.map((p) => `L${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("") +
        `L${sx(seg[seg.length - 1].x).toFixed(1)},${baseY}Z`
    )
    .join(" ");
}

const bidPath = computed(() => buildSegmentedPath(bidPts.value));
const bidArea = computed(() => buildAreaPath(bidPts.value));
const askPath = computed(() => buildSegmentedPath(askEnvelopePts.value));
const windowCurvePaths = computed(() =>
  windowCurvesData.value.map((w) => ({ id: w.id, d: buildSegmentedPath(w.pts) }))
);
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
      <template v-if="windowCurvePaths.length > 1">
        <path
          v-for="wc in windowCurvePaths"
          :key="wc.id"
          :d="wc.d"
          fill="none"
          stroke="var(--sf-ask)"
          stroke-width="0.9"
          stroke-dasharray="2.5 2.5"
          stroke-opacity="0.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </template>

      <path v-if="bidArea" :d="bidArea" :fill="`url(#${gradId})`" />
      <path
        v-if="bidPath"
        :d="bidPath"
        fill="none"
        stroke="var(--sf-bid)"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

      <path
        v-if="askPath"
        :d="askPath"
        fill="none"
        stroke="var(--sf-ask)"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

      <circle
        v-for="dot in askDots"
        :key="dot.id"
        :cx="sx(dot.x)"
        :cy="sy(dot.y)"
        r="3.4"
        :fill="dot.active ? 'var(--sf-ask)' : 'var(--sf-card)'"
        :stroke="dot.active ? 'var(--sf-card)' : 'var(--sf-ask)'"
        stroke-width="1.4"
      />
    </g>
  </svg>
</template>
