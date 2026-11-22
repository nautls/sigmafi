<script setup lang="ts">
import { computed } from "vue";
import {
  ZcDurationUnit,
  ZcMarket,
  ZcOrderbook,
  ZcOrderbookAskRow,
  ZcOrderbookBidRow
} from "@/types/zc";
import {
  formatApr,
  formatBp,
  formatCompact,
  formatDur,
  formatDurCell,
  isBookRowActive,
  kindLabel,
  MIN_MATURITY_BLOCKS
} from "@/utils/zcMath";

const props = defineProps<{
  book: ZcOrderbook;
  market: ZcMarket;
  unit: ZcDurationUnit;
  upto: boolean;
  targetBlocks: number;
  bandBlocks: number;
  selectedId: string | null;
  loading?: boolean;
}>();

const emit = defineEmits<{
  (e: "select-ask", id: string): void;
  (e: "select-bid", id: string): void;
}>();

const maxSize = computed(() =>
  Math.max(
    1,
    ...props.book.asks.map((r) => r.size),
    ...props.book.bids.map((r) => r.size)
  )
);

const reversedAsks = computed(() => [...props.book.asks].reverse());
const activeAskCount = computed(() => props.book.asks.filter(isBookRowActive).length);
const activeBidCount = computed(() => props.book.bids.filter(isBookRowActive).length);
const isCrossed = computed(() => props.book.spread != null && props.book.spread <= 0);

const sliceLabel = computed(() =>
  props.upto
    ? `${formatDur(MIN_MATURITY_BLOCKS, props.unit)} – ${formatDur(props.targetBlocks, props.unit)}`
    : `${formatDur(props.targetBlocks, props.unit)} ± ${formatDur(props.bandBlocks, props.unit)}`
);

function barWidth(size: number): string {
  return `${Math.max(4, Math.min(100, (size / maxSize.value) * 100))}%`;
}

function askTitle(r: ZcOrderbookAskRow): string {
  if (!isBookRowActive(r) && r.reason) return `${r.reason} · click to inspect`;
  return `${kindLabel(r.kind)} · ${formatApr(r.y)} · ${formatDur(r.d, props.unit)} · click to inspect`;
}

function bidTitle(r: ZcOrderbookBidRow): string {
  if (!isBookRowActive(r) && r.reason) return `${r.reason} · click to inspect`;
  return `Lend offer · ${formatDur(r.range[0], props.unit)}–${formatDur(
    r.range[1],
    props.unit
  )} · click to inspect`;
}
</script>

<template>
  <section class="sf-plate flex h-full flex-col overflow-hidden rounded-2xl">
    <!-- Header -->
    <div
      class="flex items-center justify-between gap-2 border-b border-[color:var(--sf-line)] px-4 py-3"
    >
      <div class="flex items-center gap-2">
        <h2 class="sf-serif text-[16px] font-semibold text-[color:var(--sf-ink)]">Rate Ladder</h2>
        <span
          v-if="loading"
          class="sf-mono text-[10px] uppercase tracking-[0.08em] text-[color:var(--sf-dim)]"
        >
          sync
        </span>
      </div>
      <span
        class="sf-mono rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] px-2 py-0.5 text-[10.5px] text-[color:var(--sf-ink-2)]"
      >
        {{ sliceLabel }}
      </span>
    </div>

    <!-- Column Labels -->
    <div
      class="sf-mono grid grid-cols-3 border-b border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-[color:var(--sf-muted)]"
    >
      <span>APR</span>
      <span class="text-right">Size {{ market }}</span>
      <span class="text-right">{{ unit === "blocks" ? "Mat · blk" : "Maturity" }}</span>
    </div>

    <!-- Asks Stack (highest APR closest to the spread) -->
    <div class="sf-scroll flex min-h-[144px] max-h-[214px] flex-1 flex-col justify-end overflow-y-auto py-1">
      <template v-if="reversedAsks.length">
        <button
          v-for="row in reversedAsks"
          :key="row.id"
          type="button"
          :aria-pressed="selectedId === row.id"
          :title="askTitle(row)"
          class="sf-mono group relative grid w-full grid-cols-3 items-center px-3.5 py-1.5 text-left text-[11.5px] transition-colors"
          :class="[
            selectedId === row.id
              ? 'bg-cobalt-50/90 ring-1 ring-inset ring-cobalt-600/35'
              : 'hover:bg-[color:var(--sf-well)]',
            isBookRowActive(row) ? '' : 'opacity-50'
          ]"
          @click="emit('select-ask', row.id)"
        >
          <span
            class="pointer-events-none absolute inset-y-0.5 right-0 rounded-l transition-all duration-300"
            :style="{
              width: barWidth(row.size),
              background: 'var(--sf-ask-soft)'
            }"
          />
          <span class="relative z-10 font-semibold text-[color:var(--sf-ask)]">
            {{ formatApr(row.y) }}
          </span>
          <span class="relative z-10 text-right font-medium text-[color:var(--sf-ink)]">
            {{ formatCompact(row.size) }}
          </span>
          <span class="relative z-10 text-right text-[11px] text-[color:var(--sf-muted)]">
            {{ row.window ? `≤${formatDurCell(row.d, unit)}` : formatDurCell(row.d, unit) }}
          </span>
        </button>
      </template>
      <div
        v-else
        class="flex flex-1 items-center justify-center px-4 py-6 text-center text-[12px] text-[color:var(--sf-muted)]"
      >
        No asks {{ upto ? "in this range" : "near this maturity" }}
      </div>
    </div>

    <!-- Spread Ribbon -->
    <div
      class="flex items-center justify-between gap-2 border-y border-[color:var(--sf-line-strong)] px-3.5 py-2"
      :class="isCrossed ? 'bg-[color:var(--sf-ask-soft)]' : 'bg-[color:var(--sf-paper)]'"
    >
      <div class="flex items-center gap-2">
        <span class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
          Spread
        </span>
        <span
          class="sf-mono text-[12.5px] font-semibold"
          :class="isCrossed ? 'text-[color:var(--sf-ask)]' : 'text-[color:var(--sf-ink)]'"
        >
          {{ formatBp(book.spread) }}
        </span>
        <span
          v-if="isCrossed"
          class="sf-mono rounded bg-[color:var(--sf-card)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-ask)] ring-1 ring-[color:var(--sf-ask)]/30"
          title="Best ask APR is at or above best bid APR — immediate batchable overlap"
        >
          Crossed
        </span>
      </div>
      <span class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">
        {{ activeAskCount }}a · {{ activeBidCount }}b
      </span>
    </div>

    <!-- Bids Stack (lowest/best APR closest to the spread) -->
    <div class="sf-scroll min-h-[144px] max-h-[214px] flex-1 overflow-y-auto py-1">
      <template v-if="book.bids.length">
        <button
          v-for="row in book.bids"
          :key="row.id"
          type="button"
          :aria-pressed="selectedId === row.id"
          :title="bidTitle(row)"
          class="sf-mono group relative grid w-full grid-cols-3 items-center px-3.5 py-1.5 text-left text-[11.5px] transition-colors"
          :class="[
            selectedId === row.id
              ? 'bg-cobalt-50/90 ring-1 ring-inset ring-cobalt-600/35'
              : 'hover:bg-[color:var(--sf-well)]',
            isBookRowActive(row) ? '' : 'opacity-50'
          ]"
          @click="emit('select-bid', row.id)"
        >
          <span
            class="pointer-events-none absolute inset-y-0.5 right-0 rounded-l transition-all duration-300"
            :style="{
              width: barWidth(row.size),
              background: 'var(--sf-bid-soft)'
            }"
          />
          <span class="relative z-10 font-semibold text-[color:var(--sf-bid)]">
            {{ formatApr(row.y) }}
          </span>
          <span class="relative z-10 text-right font-medium text-[color:var(--sf-ink)]">
            {{ formatCompact(row.size) }}
          </span>
          <span class="relative z-10 text-right text-[11px] text-[color:var(--sf-muted)]">
            {{
              upto
                ? `${formatDurCell(row.range[0], unit)}–${formatDurCell(row.range[1], unit)}`
                : `≤${formatDurCell(row.range[1], unit)}`
            }}
          </span>
        </button>
      </template>
      <div
        v-else
        class="flex h-full items-center justify-center px-4 py-6 text-center text-[12px] text-[color:var(--sf-muted)]"
      >
        No bids cover {{ upto ? "this range" : "this maturity" }}
      </div>
    </div>

    <!-- Footer Note -->
    <div
      class="sf-mono flex items-center justify-between border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-3.5 py-2 text-[10px] text-[color:var(--sf-dim)]"
    >
      <span>APR ↑ · price ↓</span>
      <span title="Bars compare each individual order against the largest on its side (non-cumulative)">
        Per-order depth
      </span>
    </div>
  </section>
</template>
