<script setup lang="ts">
import { computed, ref } from "vue";
import { ZcDurationUnit, ZcMarket } from "@/types/zc";
import { dateAtHeight, formatDur, formatNumber } from "@/utils/zcMath";

export interface SchedulePt {
  x: number;
  y: number;
}

const props = withDefaults(
  defineProps<{
    pts: SchedulePt[];
    now: number;
    label: string;
    valueDisplay: string;
    unitText: string;
    phaseLabel: string;
    phaseTone?: "bid" | "ask" | "warn" | "cobalt" | "neutral";
    note?: string;
    discountPct?: number | null;
    color?: string;
    market?: ZcMarket;
    durationUnit?: ZcDurationUnit;
    height?: number;
    yIsBps?: boolean;
    repayment?: number;
  }>(),
  {
    phaseTone: "neutral",
    note: "",
    discountPct: null,
    color: "var(--sf-ask)",
    market: "SigUSD",
    durationUnit: "days",
    height: 142,
    yIsBps: false,
    repayment: 0
  }
);

const W = 320;
const TOP_CLEAR = 76;
const PAD_X = 6;
const PAD_B = 8;

const hoverX = ref<number | null>(null);
const gradId = `sfAucGrad-${Math.random().toString(36).slice(2, 9)}`;

const domain = computed(() => {
  if (!props.pts.length) return { x0: 0, x1: 1, hi: 1 };
  const x0 = props.pts[0].x;
  const x1 = Math.max(x0 + 1, props.pts[props.pts.length - 1].x);
  const hi = Math.max(1e-6, ...props.pts.map((p) => p.y));
  return { x0, x1, hi };
});

const sx = (x: number) =>
  PAD_X + ((x - domain.value.x0) / (domain.value.x1 - domain.value.x0 || 1)) * (W - PAD_X * 2);

const sy = (y: number) =>
  props.height - PAD_B - (Math.max(0, y) / domain.value.hi) * (props.height - PAD_B - TOP_CLEAR);

function yAt(xVal: number): number {
  const pts = props.pts;
  if (!pts.length) return 0;
  if (xVal <= pts[0].x) return pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    if (xVal <= pts[i].x) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.y + ((b.y - a.y) * (xVal - a.x)) / (b.x - a.x || 1);
    }
  }
  return pts[pts.length - 1].y;
}

const lineD = computed(() =>
  props.pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
    .join(" ")
);

const areaD = computed(() => {
  if (props.pts.length < 2) return "";
  const firstX = sx(props.pts[0].x).toFixed(1);
  const lastX = sx(props.pts[props.pts.length - 1].x).toFixed(1);
  return `${lineD.value} L${lastX},${props.height} L${firstX},${props.height} Z`;
});

const clampedNow = computed(() =>
  Math.min(Math.max(props.now, domain.value.x0), domain.value.x1)
);
const nowY = computed(() => yAt(clampedNow.value));
const nowLeftPct = computed(() => (sx(clampedNow.value) / W) * 100);
const nowTopPx = computed(() => sy(nowY.value));

const hoverReadout = computed(() => {
  if (hoverX.value == null) return null;
  const hAt = Math.round(hoverX.value);
  const yv = yAt(hAt);
  const leftPct = (sx(hAt) / W) * 100;
  const topPx = sy(yv);
  const delta = hAt - props.now;
  const when =
    Math.abs(delta) < 15
      ? "Now"
      : delta > 0
        ? `+${formatDur(delta, props.durationUnit)}`
        : `-${formatDur(-delta, props.durationUnit)}`;
  const valStr = props.yIsBps
    ? `${formatNumber(yv / 100, 1, 1)}%${props.repayment > 0 ? ` (${formatNumber((props.repayment * yv) / 10_000, props.market === "ERG" ? 2 : 0, 0)} ${props.market})` : ""}`
    : `${formatNumber(yv, props.market === "ERG" ? 3 : 2, 0)} ${props.market}`;
  return {
    hAt,
    leftPct,
    topPx,
    when,
    date: dateAtHeight(hAt, props.now),
    valStr
  };
});

function onMove(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
  const svgX = frac * W;
  const norm = Math.max(0, Math.min(1, (svgX - PAD_X) / (W - PAD_X * 2)));
  hoverX.value = domain.value.x0 + norm * (domain.value.x1 - domain.value.x0);
}
</script>

<template>
  <div
    class="relative select-none overflow-hidden border-b border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)]"
    :style="{ height: `${height}px` }"
    @pointermove="onMove"
    @pointerleave="hoverX = null"
  >
    <!-- Edge-to-Edge Schedule Curve -->
    <svg
      class="block h-full w-full"
      :viewBox="`0 0 ${W} ${height}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="color" stop-opacity="0.22" />
          <stop offset="100%" :stop-color="color" stop-opacity="0.01" />
        </linearGradient>
      </defs>

      <path v-if="areaD" :d="areaD" :fill="`url(#${gradId})`" />
      <path
        v-if="lineD"
        :d="lineD"
        fill="none"
        :stroke="color"
        stroke-width="2.1"
        vector-effect="non-scaling-stroke"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <!-- Now Vertical Guide -->
      <line
        :x1="sx(clampedNow)"
        :x2="sx(clampedNow)"
        :y1="TOP_CLEAR - 10"
        :y2="height"
        stroke="var(--sf-muted)"
        stroke-width="1"
        stroke-dasharray="2 3"
        opacity="0.55"
        vector-effect="non-scaling-stroke"
      />
      <!-- Hover Vertical Guide -->
      <line
        v-if="hoverReadout"
        :x1="sx(hoverReadout.hAt)"
        :x2="sx(hoverReadout.hAt)"
        :y1="TOP_CLEAR - 12"
        :y2="height"
        stroke="var(--sf-cobalt)"
        stroke-width="1"
        stroke-dasharray="2 2"
        opacity="0.7"
        vector-effect="non-scaling-stroke"
      />
    </svg>

    <!-- Round HTML Now Beacon Dot -->
    <span
      class="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
      :style="{ left: `${nowLeftPct}%`, top: `${nowTopPx}px` }"
    >
      <span
        class="block h-2.5 w-2.5 rounded-full ring-2 ring-[color:var(--sf-card)]"
        :style="{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }"
      />
    </span>

    <!-- Hover Dot -->
    <span
      v-if="hoverReadout"
      class="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--sf-cobalt)] ring-2 ring-[color:var(--sf-card)]"
      :style="{ left: `${hoverReadout.leftPct}%`, top: `${hoverReadout.topPx}px` }"
    />

    <!-- Top Stage Overlay -->
    <div class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 px-4 pt-3">
      <div>
        <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
          {{ hoverReadout ? `${hoverReadout.when} · ${hoverReadout.date}` : label }}
        </div>
        <div class="mt-0.5 flex items-baseline gap-1.5">
          <span
            class="sf-serif text-[26px] font-semibold leading-none"
            :class="hoverReadout ? 'text-[color:var(--sf-cobalt)]' : 'text-[color:var(--sf-ink)]'"
          >
            {{ hoverReadout ? hoverReadout.valStr : valueDisplay }}
          </span>
          <span
            v-if="!hoverReadout"
            class="sf-mono text-[11.5px] font-semibold text-[color:var(--sf-muted)]"
          >
            {{ unitText }}
          </span>
        </div>
      </div>

      <div class="flex flex-col items-end gap-1 text-right">
        <div class="flex items-center gap-1.5">
          <span
            v-if="discountPct != null && discountPct > 0.5"
            class="sf-mono rounded-[5px] border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] px-1.5 py-0.5 text-[9.5px] font-bold text-[color:var(--sf-bid)]"
          >
            -{{ discountPct.toFixed(1) }}% est
          </span>
          <span
            class="sf-mono rounded-[5px] border px-1.5 py-0.5 text-[9.5px] font-semibold"
            :class="
              phaseTone === 'bid'
                ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                : phaseTone === 'ask'
                  ? 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                  : phaseTone === 'warn'
                    ? 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-warn)]'
                    : phaseTone === 'cobalt'
                      ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                      : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-ink-2)]'
            "
          >
            {{ phaseLabel }}
          </span>
        </div>
        <span v-if="note" class="sf-mono text-[10px] text-[color:var(--sf-muted)]">
          {{ note }}
        </span>
      </div>
    </div>
  </div>
</template>
