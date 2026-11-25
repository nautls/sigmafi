<script setup lang="ts">
import { computed, ref } from "vue";
import { ZcDurationUnit, ZcMarket, ZcPortfolioPosition } from "@/types/zc";
import {
  dateAtHeight,
  DAY_BLOCKS,
  formatBlocksCompact,
  formatCompact,
  formatMarketAmount,
  shareTotalOf
} from "@/utils/zcMath";

const props = defineProps<{
  positions: ZcPortfolioPosition[];
  market: ZcMarket;
  height: number;
  unit: ZcDurationUnit;
}>();

const emit = defineEmits<{
  (e: "update:market", m: ZcMarket): void;
}>();

const hoveredIdx = ref<number | null>(null);

const MONTHS = 12;
const STEP = 30 * DAY_BLOCKS;

const buckets = computed(() => {
  const list = Array.from({ length: MONTHS }, (_, i) => ({
    i,
    fromH: props.height + i * STEP,
    toH: props.height + (i + 1) * STEP,
    inflow: 0,
    outflow: 0,
    inCount: 0,
    outCount: 0
  }));

  for (const p of props.positions) {
    if (p.status !== "live" || p.bond.market !== props.market) continue;
    const idx = Math.floor((p.bond.maturity - props.height) / STEP);
    if (idx < 0 || idx >= MONTHS) continue;
    if (p.side === "lend") {
      const frac = p.kind === "shares" ? p.units / shareTotalOf(p) : 1;
      list[idx].inflow += (p.bond.repayment || 0) * frac;
      list[idx].inCount += 1;
    } else {
      list[idx].outflow += p.bond.repayment || 0;
      list[idx].outCount += 1;
    }
  }
  return list;
});

const maxVal = computed(() =>
  Math.max(1, ...buckets.value.map((b) => Math.max(b.inflow, b.outflow)))
);
const totalIn = computed(() => buckets.value.reduce((s, b) => s + b.inflow, 0));
const totalOut = computed(() => buckets.value.reduce((s, b) => s + b.outflow, 0));

const activeBucket = computed(() =>
  hoveredIdx.value != null ? buckets.value[hoveredIdx.value] || null : null
);

function barH(val: number): string {
  if (!(val > 0)) return "0px";
  return `${Math.max(10, Math.round((val / maxVal.value) * 100))}%`;
}

function monthLabel(i: number, fromH: number): string {
  if (props.unit === "blocks") return `+${formatBlocksCompact((i + 1) * STEP)}`;
  return dateAtHeight(fromH, props.height, { month: "short" }).replace(/ \d{2}(\d{2})$/, " '$1");
}
</script>

<template>
  <section
    class="sf-terminal-plate rounded-[20px] p-3.5"
    :aria-label="`${market} upcoming repayments ladder`"
  >
    <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-2.5">
        <h2 class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
          12-Month Maturity Ladder
        </h2>
        <div class="sf-seg" role="tablist" aria-label="Ladder market">
          <button
            v-for="m in (['SigUSD', 'ERG'] as ZcMarket[])"
            :key="m"
            type="button"
            class="sf-seg-btn !h-6 !px-2 !text-[10.5px]"
            :class="market === m ? 'is-active tone-cobalt' : ''"
            @click="emit('update:market', m)"
          >
            {{ m }}
          </button>
        </div>
      </div>

      <div class="sf-mono flex flex-wrap items-center gap-3 text-[11px]">
        <template v-if="activeBucket">
          <span class="text-[color:var(--sf-muted)]">
            {{ dateAtHeight(activeBucket.fromH, height) }}–{{ dateAtHeight(activeBucket.toH, height) }}
          </span>
          <span class="font-semibold text-[color:var(--sf-bid)]">
            +{{ formatMarketAmount(activeBucket.inflow, market) }}
          </span>
          <span class="font-semibold text-[color:var(--sf-ask)]">
            -{{ formatMarketAmount(activeBucket.outflow, market) }}
          </span>
        </template>
        <template v-else>
          <span class="inline-flex items-center gap-1.5 text-[color:var(--sf-ink-2)]">
            <i class="h-2 w-2 rounded-full bg-[color:var(--sf-bid)]" />
            <span>In <strong class="text-[color:var(--sf-bid)]">{{ formatMarketAmount(totalIn, market) }}</strong></span>
          </span>
          <span class="inline-flex items-center gap-1.5 text-[color:var(--sf-ink-2)]">
            <i class="h-2 w-2 rounded-full bg-[color:var(--sf-ask)]" />
            <span>Out <strong class="text-[color:var(--sf-ask)]">{{ formatMarketAmount(totalOut, market) }}</strong></span>
          </span>
        </template>
      </div>
    </div>

    <div class="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
      <div
        v-for="b in buckets"
        :key="b.i"
        class="group flex flex-col items-center rounded-xl border border-transparent px-1 py-1.5 transition-colors"
        :class="
          hoveredIdx === b.i
            ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/50'
            : b.inflow > 0 || b.outflow > 0
              ? 'hover:bg-[color:var(--sf-well-soft)]'
              : 'opacity-45'
        "
        @pointerenter="hoveredIdx = b.i"
        @pointerleave="hoveredIdx = null"
      >
        <span class="sf-mono h-3.5 text-[9.5px] font-semibold text-[color:var(--sf-bid)]">
          {{ b.inflow > 0 ? formatCompact(b.inflow) : "" }}
        </span>

        <!-- Inflow Bar (Up) -->
        <div class="flex h-10 w-full items-end justify-center px-1">
          <div
            class="w-full max-w-[20px] rounded-t-[4px] bg-[color:var(--sf-bid)] transition-all duration-300"
            :style="{ height: barH(b.inflow) }"
          />
        </div>

        <!-- Zero Axis Divider -->
        <div class="h-[1px] w-full bg-[color:var(--sf-line-strong)]" />

        <!-- Outflow Bar (Down) -->
        <div class="flex h-10 w-full items-start justify-center px-1">
          <div
            class="w-full max-w-[20px] rounded-b-[4px] bg-[color:var(--sf-ask)] transition-all duration-300"
            :style="{ height: barH(b.outflow) }"
          />
        </div>

        <span class="sf-mono h-3.5 text-[9.5px] font-semibold text-[color:var(--sf-ask)]">
          {{ b.outflow > 0 ? formatCompact(b.outflow) : "" }}
        </span>

        <span class="sf-mono mt-0.5 text-[9.5px] text-[color:var(--sf-muted)]">
          {{ monthLabel(b.i, b.fromH) }}
        </span>
      </div>
    </div>
  </section>
</template>
