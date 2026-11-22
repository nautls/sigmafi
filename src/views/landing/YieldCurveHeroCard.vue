<script setup lang="ts">
import { ArrowRightIcon } from "@zhuowenli/vue-feather-icons";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { vDrawOnView } from "@/directives/vDrawOnView";
import MarketCoin from "@/components/MarketCoin.vue";
import { useZcStore } from "@/stories/zcStore";
import { ZcMarket } from "@/types/zc";
import {
  bestAskAt,
  DAY_BLOCKS,
  DEFAULT_COVER,
  formatApr,
  formatBlocksShort,
  lineAt,
  YEAR_BLOCKS
} from "@/utils/zcMath";

const TENORS = [7, 30, 90, 180, 365] as const;
const MAX_DAYS = 365;
const VB_W = 580;
const VB_H = 230;
const PAD = { t: 18, r: 18, b: 28, l: 44 };

const zc = useZcStore();
const selectedTenor = ref<number>(90);
const route = useRoute();
watch(() => route.query.days, (value) => {
  if (route.name !== "zc-market" || typeof value !== "string") return;
  const days = Number(value);
  if (Number.isInteger(days) && days >= 1 && days <= MAX_DAYS) selectedTenor.value = days;
}, { immediate: true });
const hoverDay = ref<number | null>(null);

const market = computed<ZcMarket>(() => zc.activeMarket);
const snap = computed(() => zc.markets[market.value]);
const curves = computed(() => zc.connected ? snap.value.curves : null);

const hasCurveData = computed(() => {
  const c = curves.value;
  if (!c) return false;
  return (
    c.bidLine.some((p) => p.y != null) ||
    c.askLine.some((p) => p.y != null) ||
    c.dots.length > 0 ||
    c.windows.length > 0
  );
});

const bidSamples = computed(() => {
  const c = curves.value;
  if (!c) return [] as { x: number; y: number }[];
  const pts: { x: number; y: number }[] = [];
  for (const p of c.bidLine) {
    if (p.y != null) {
      const days = p.d / DAY_BLOCKS;
      if (days >= 0 && days <= MAX_DAYS) {
        pts.push({ x: days, y: p.y / 100 });
      }
    }
  }
  return pts;
});

const askSamples = computed(() => {
  const c = curves.value;
  if (!c) return [] as { x: number; y: number }[];
  const daysSet = new Set<number>();
  for (let d = 1; d <= MAX_DAYS; d += 5) daysSet.add(d);
  for (const p of c.askLine) {
    const day = p.d / DAY_BLOCKS;
    if (day >= 0 && day <= MAX_DAYS) daysSet.add(day);
  }
  const sorted = [...daysSet].sort((a, b) => a - b);
  const pts: { x: number; y: number }[] = [];
  for (const d of sorted) {
    const bps = bestAskAt(c, Math.round(d * DAY_BLOCKS));
    if (bps != null) pts.push({ x: d, y: bps / 100 });
  }
  return pts;
});

const askDots = computed(() => {
  const c = curves.value;
  if (!c) return [];
  return c.dots
    .filter((d) => d.d / DAY_BLOCKS <= MAX_DAYS)
    .map((d) => ({
      id: d.id,
      x: d.d / DAY_BLOCKS,
      y: d.y / 100,
      bps: d.y,
      ok: d.ok
    }));
});

const yMax = computed(() => {
  const vals: number[] = [
    ...bidSamples.value.map((p) => p.y),
    ...askSamples.value.map((p) => p.y),
    ...askDots.value.map((p) => p.y)
  ];
  if (!vals.length) return 16;
  const hi = Math.max(...vals);
  const padded = Math.max(8, hi * 1.25);
  return Math.ceil(padded / 4) * 4;
});

const yTicks = computed(() => {
  const hi = yMax.value;
  return [0, hi * 0.25, hi * 0.5, hi * 0.75, hi];
});

const xTicks = [1, 90, 180, 270, 365];

function pxX(day: number): number {
  const plotW = VB_W - PAD.l - PAD.r;
  return PAD.l + (Math.min(MAX_DAYS, Math.max(0, day)) / MAX_DAYS) * plotW;
}

function pxY(pctVal: number): number {
  const plotH = VB_H - PAD.t - PAD.b;
  const clamped = Math.min(yMax.value, Math.max(0, pctVal));
  return PAD.t + (1 - clamped / yMax.value) * plotH;
}

function buildLinePath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  return pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${pxX(p.x).toFixed(1)},${pxY(p.y).toFixed(1)}`)
    .join(" ");
}

const bidPath = computed(() => buildLinePath(bidSamples.value));
const bidAreaPath = computed(() => {
  const pts = bidSamples.value;
  if (pts.length < 2) return "";
  const baseY = pxY(0).toFixed(1);
  const firstX = pxX(pts[0].x).toFixed(1);
  const lastX = pxX(pts[pts.length - 1].x).toFixed(1);
  return `${bidPath.value} L${lastX},${baseY} L${firstX},${baseY} Z`;
});

const askPath = computed(() => buildLinePath(askSamples.value));

const activeDay = computed(() => hoverDay.value ?? selectedTenor.value);

const activeReadout = computed(() => {
  const day = Math.max(1, Math.round(activeDay.value));
  const blocks = day * DAY_BLOCKS;
  const c = curves.value;
  const bidBps = c ? lineAt(c.bidLine, blocks) : null;
  let askBps = bestAskAt(c, blocks);

  if (askBps == null && c && c.dots.length > 0) {
    let bestDot: { dist: number; y: number } | null = null;
    for (const dot of c.dots) {
      const dist = Math.abs(dot.d / DAY_BLOCKS - day);
      if (dist <= 14 && (!bestDot || dist < bestDot.dist)) {
        bestDot = { dist, y: dot.y };
      }
    }
    if (bestDot) askBps = bestDot.y;
  }

  const refBps = askBps ?? bidBps;
  const discountPrice =
    refBps != null ? 100 / (1 + (refBps / 10_000) * (blocks / YEAR_BLOCKS)) : null;

  return { day, blocks, bidBps, askBps, refBps, discountPrice };
});

function handlePointerMove(e: MouseEvent) {
  const svg = e.currentTarget as SVGSVGElement;
  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  const relX = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse()).x;
  const plotW = VB_W - PAD.l - PAD.r;
  const norm = (relX - PAD.l) / plotW;
  if (norm < 0 || norm > 1) {
    hoverDay.value = null;
    return;
  }
  hoverDay.value = Math.max(1, Math.round(norm * MAX_DAYS));
}

function handlePointerLeave() {
  hoverDay.value = null;
}

function handleSvgClick() {
  if (hoverDay.value != null) {
    selectedTenor.value = hoverDay.value;
  }
}

function marketCount(m: ZcMarket): number {
  const t = zc.markets[m].curves?.totals;
  return (t?.asks.count ?? 0) + (t?.offers.count ?? 0);
}
</script>

<template>
  <figure class="sf-plate relative overflow-hidden rounded-2xl">
    <!-- Figure Header -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--sf-line)] px-4 py-3 sm:px-5"
    >
      <div class="flex items-center gap-3">
        <span
          class="sf-mono rounded bg-cobalt-50 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-cobalt-600 ring-1 ring-cobalt-600/20"
        >
          Term structure
        </span>

        <div
          class="inline-flex rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
          role="tablist"
          aria-label="Market"
        >
          <button
            v-for="m in (['ERG', 'SigUSD'] as ZcMarket[])"
            :key="m"
            type="button"
            role="tab"
            :aria-selected="market === m"
            class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-all"
            :class="
              market === m
                ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
                : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
            "
            @click="zc.setActiveMarket(m)"
          >
            <market-coin :market="m" :size="15" />
            <span>{{ m }}</span>
            <span
              v-if="marketCount(m) > 0"
              class="sf-mono rounded bg-[color:var(--sf-line)] px-1 text-[10px] text-[color:var(--sf-ink-2)]"
            >
              {{ marketCount(m) }}
            </span>
          </button>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <div class="hidden items-center gap-3 text-[11px] font-medium text-[color:var(--sf-muted)] sm:flex">
          <span class="inline-flex items-center gap-1.5">
            <span class="h-2 w-2 rounded-full bg-[#059669]" />
            <span>Bid</span>
          </span>
          <span class="inline-flex items-center gap-1.5">
            <span class="h-2 w-2 rounded-full bg-[#d97706]" />
            <span>Ask</span>
          </span>
        </div>
        <span
          class="sf-mono rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] px-2 py-0.5 text-[10.5px] text-[color:var(--sf-muted)]"
        >
          ≥{{ DEFAULT_COVER }}%
        </span>
      </div>
    </div>

    <!-- Live Readout Strip -->
    <div
      class="grid grid-cols-2 divide-x divide-[color:var(--sf-line)] border-b border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] sm:grid-cols-4"
    >
      <div class="px-4 py-2.5">
        <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
          Tenor <span class="sf-math normal-case text-[12px]">τ</span>
        </div>
        <div class="sf-mono mt-0.5 flex items-baseline gap-1.5 text-[14.5px] font-semibold text-[color:var(--sf-ink)]">
          <span>{{ activeReadout.day === 365 ? "1y" : `${activeReadout.day}d` }}</span>
          <span class="text-[10.5px] font-normal text-[color:var(--sf-dim)]">
            {{ formatBlocksShort(activeReadout.blocks) }}
          </span>
        </div>
      </div>

      <div class="px-4 py-2.5">
        <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
          Bid <span class="sf-math normal-case text-[12px]">r<sub>b</sub></span>
        </div>
        <div class="sf-mono mt-0.5 text-[14.5px] font-semibold text-[color:var(--sf-bid)]">
          {{ formatApr(activeReadout.bidBps) }}
        </div>
      </div>

      <div class="border-t border-[color:var(--sf-line)] px-4 py-2.5 sm:border-t-0">
        <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
          Ask <span class="sf-math normal-case text-[12px]">r<sub>a</sub></span>
        </div>
        <div class="sf-mono mt-0.5 text-[14.5px] font-semibold text-[color:var(--sf-ask)]">
          {{ formatApr(activeReadout.askBps) }}
        </div>
      </div>

      <div class="border-t border-[color:var(--sf-line)] px-4 py-2.5 sm:border-t-0">
        <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
          Par <span class="sf-math normal-case text-[12px]">P/F</span>
        </div>
        <div class="sf-mono mt-0.5 text-[14.5px] font-semibold text-cobalt-600">
          {{ activeReadout.discountPrice != null ? `${activeReadout.discountPrice.toFixed(2)}%` : "—" }}
        </div>
      </div>
    </div>

    <!-- Coordinate Plane SVG -->
    <div class="relative bg-[color:var(--sf-card)] px-2 pt-3 pb-1 sm:px-3">
      <svg
        v-draw-on-view
        :key="market"
        :viewBox="`0 0 ${VB_W} ${VB_H}`"
        class="h-[214px] w-full select-none sm:h-[234px]"
        :class="{ 'cursor-crosshair': hasCurveData }"
        role="img"
        :aria-label="`${market} yield curve`"
        @mousemove="handlePointerMove"
        @mouseleave="handlePointerLeave"
        @click="handleSvgClick"
      >
        <defs>
          <linearGradient id="sfLightBidArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--sf-bid)" stop-opacity="0.16" />
            <stop offset="100%" stop-color="var(--sf-bid)" stop-opacity="0.0" />
          </linearGradient>
          <linearGradient id="sfLightTenorBand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--sf-cobalt)" stop-opacity="0.08" />
            <stop offset="100%" stop-color="var(--sf-cobalt)" stop-opacity="0.01" />
          </linearGradient>
        </defs>

        <!-- Vertical X-grid -->
        <g v-for="xt in xTicks" :key="`xg-${xt}`">
          <line
            :x1="pxX(xt)"
            :x2="pxX(xt)"
            :y1="PAD.t"
            :y2="VB_H - PAD.b"
            stroke="var(--sf-line)"
          />
          <text
            :x="pxX(xt)"
            :y="VB_H - 8"
            text-anchor="middle"
            fill="var(--sf-muted)"
            font-size="10"
            class="sf-mono"
          >
            {{ xt === 365 ? "1y" : `${xt}d` }}
          </text>
        </g>

        <!-- Horizontal Y-grid -->
        <g v-for="tick in yTicks" :key="tick">
          <line
            :x1="PAD.l"
            :x2="VB_W - PAD.r"
            :y1="pxY(tick)"
            :y2="pxY(tick)"
            :stroke="tick === 0 ? 'var(--sf-line-strong)' : 'var(--sf-line)'"
            :stroke-dasharray="tick === 0 ? undefined : '3 4'"
          />
          <text
            :x="PAD.l - 8"
            :y="pxY(tick) + 3.5"
            text-anchor="end"
            fill="var(--sf-muted)"
            font-size="10"
            class="sf-mono"
          >
            {{ Math.round(tick) }}%
          </text>
        </g>

        <!-- Y-axis spine -->
        <line
          :x1="PAD.l"
          :x2="PAD.l"
          :y1="PAD.t"
          :y2="VB_H - PAD.b"
          stroke="var(--sf-line-strong)"
        />

        <!-- Tenor selection band -->
        <rect
          v-if="hasCurveData"
          :x="PAD.l"
          :y="PAD.t"
          :width="Math.max(0, pxX(selectedTenor) - PAD.l)"
          :height="VB_H - PAD.t - PAD.b"
          fill="url(#sfLightTenorBand)"
        />

        <!-- Reveal both sides of the book, retaining the dashed ask convention. -->
        <g v-if="hasCurveData" class="sf-plot-traces">
        <path v-if="bidAreaPath" :d="bidAreaPath" fill="url(#sfLightBidArea)" />
        <path
          v-if="bidPath"
          :d="bidPath"
          fill="none"
          stroke="var(--sf-bid)"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />

        <!-- Ask curve -->
        <path
          v-if="askPath"
          :d="askPath"
          fill="none"
          stroke="var(--sf-ask)"
          stroke-width="2"
          stroke-dasharray="5 3"
          stroke-linecap="round"
        />

        <!-- Ask Dots -->
        <g
          v-for="dot in askDots"
          :key="dot.id"
          class="cursor-pointer"
          @click.stop="selectedTenor = Math.max(1, Math.round(dot.x))"
        >
          <circle :cx="pxX(dot.x)" :cy="pxY(dot.y)" r="9" fill="var(--sf-ask)" fill-opacity="0.14" />
          <circle
            :cx="pxX(dot.x)"
            :cy="pxY(dot.y)"
            r="4.2"
            fill="var(--sf-ask)"
            stroke="var(--sf-card)"
            stroke-width="1.8"
          />
        </g>

        </g>
        <!-- Crosshair & active markers -->
        <g v-if="hasCurveData">
          <line
            :x1="pxX(activeDay)"
            :x2="pxX(activeDay)"
            :y1="PAD.t"
            :y2="VB_H - PAD.b"
            stroke="var(--sf-line-cobalt)"
            stroke-width="1.2"
            stroke-dasharray="3 3"
          />
          <circle
            v-if="activeReadout.bidBps != null"
            :cx="pxX(activeDay)"
            :cy="pxY(activeReadout.bidBps / 100)"
            r="4.8"
            fill="var(--sf-bid)"
            stroke="var(--sf-card)"
            stroke-width="2"
          />
          <circle
            v-if="activeReadout.askBps != null"
            :cx="pxX(activeDay)"
            :cy="pxY(activeReadout.askBps / 100)"
            r="4.8"
            fill="var(--sf-ask)"
            stroke="var(--sf-card)"
            stroke-width="2"
          />
        </g>
      </svg>

      <!-- Empty / offline overlay -->
      <div
        v-if="!hasCurveData"
        class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <span class="sf-mono text-[12px] text-[color:var(--sf-muted)]">
          {{
            zc.connected
              ? `No open ${market} orders at ≥${DEFAULT_COVER}% cover`
              : zc.loading
                ? "Syncing chain state..."
                : "Offline · connect data feed to stream curves"
          }}
        </span>
        <router-link
          :to="`/app?market=${market}`"
          class="pointer-events-auto inline-flex items-center gap-1 text-[12px] font-semibold text-cobalt-600 hover:text-cobalt-700"
        >
          <span>Open {{ market }} book</span>
          <arrow-right-icon class="h-3.5 w-3.5" />
        </router-link>
      </div>
    </div>

    <!-- Live Pricing Equation Strip (EQ. 01) -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-4 py-2.5 sm:px-5"
    >
      <div class="flex flex-wrap items-center gap-2 text-[12.5px] text-[color:var(--sf-ink-2)]">
        <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-dim)]">
          Price
        </span>
        <span class="sf-math text-[14.5px] text-[color:var(--sf-ink)]">
          P(τ) = F / (1 + r(τ)·τ/Y)
        </span>
      </div>

      <div
        v-if="activeReadout.discountPrice != null && activeReadout.refBps != null"
        class="sf-mono text-[11.5px] text-[color:var(--sf-ink-2)]"
      >
        100 / (1 + {{ (activeReadout.refBps / 10000).toFixed(4) }} · {{ activeReadout.day }}/365) =
        <span class="font-semibold text-cobalt-600">{{ activeReadout.discountPrice.toFixed(2) }}</span>
      </div>
      <div v-else class="sf-mono text-[11.5px] text-[color:var(--sf-dim)]">
        Y = 262,800 blocks
      </div>
    </div>

    <!-- Tenor Controls Footer -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-4 py-3 sm:px-5"
    >
      <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Maturity tenor">
        <button
          v-for="d in TENORS"
          :key="d"
          :aria-pressed="selectedTenor === d"
          type="button"
          class="sf-mono rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-all"
          :class="
            selectedTenor === d
              ? 'border-cobalt-600 bg-cobalt-50 text-cobalt-700'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)]'
          "
          @click="selectedTenor = d"
        >
          {{ d === 365 ? "1y" : `${d}d` }}
        </button>
      </div>

      <router-link
        :to="`/app?market=${market}&days=${selectedTenor}`"
        class="inline-flex items-center gap-1.5 rounded-lg border border-cobalt-600/25 bg-cobalt-50 px-3 py-1.5 text-[12px] font-semibold text-cobalt-700 transition-colors hover:bg-cobalt-100"
      >
        <span>Rate Book</span>
        <arrow-right-icon class="h-3.5 w-3.5" />
      </router-link>
    </div>
  </figure>
</template>
