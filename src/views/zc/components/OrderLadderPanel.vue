<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ZcDurationUnit,
  ZcFillSummary,
  ZcMarket,
  ZcOrderbook,
  ZcOrderbookAskRow,
  ZcOrderbookBidRow
} from "@/types/zc";
import {
  formatAgo,
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
  fills: ZcFillSummary[];
  fillsStatus: string;
  height: number;
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

type DockView = "book" | "split" | "tape";
const view = ref<DockView>("book");

const maxSize = computed(() =>
  Math.max(
    1,
    ...props.book.asks.map((r) => r.size),
    ...props.book.bids.map((r) => r.size)
  )
);

// props.book.asks is sorted ascending by APR; reversing puts the highest-APR (best) ask at index 0.
// Rendered inside a flex-col-reverse container so index 0 sits directly above the spread bridge
// and scroll overflow stays anchored to the spread.
const asksFromBest = computed(() => [...props.book.asks].reverse());
const activeAskCount = computed(() => props.book.asks.filter(isBookRowActive).length);
const activeBidCount = computed(() => props.book.bids.filter(isBookRowActive).length);
const isCrossed = computed(() => props.book.spread != null && props.book.spread <= 0);

const sliceLabel = computed(() =>
  props.upto
    ? `≤ ${formatDur(props.targetBlocks, props.unit)}`
    : `${formatDur(props.targetBlocks, props.unit)} ± ${formatDur(props.bandBlocks, props.unit)}`
);

const recentFills = computed(() => props.fills.slice(0, 120));

function inSelection(d: number): boolean {
  return props.upto
    ? d >= MIN_MATURITY_BLOCKS && d <= props.targetBlocks
    : Math.abs(d - props.targetBlocks) <= props.bandBlocks;
}

function barWidth(size: number): string {
  return `${Math.max(4, Math.min(100, (size / maxSize.value) * 100))}%`;
}

function askTitle(r: ZcOrderbookAskRow): string {
  if (!isBookRowActive(r) && r.reason) return `${r.reason} · inspect`;
  const bb = r.borrowedByMe && r.kind !== "order" ? " · Your loan (buy back)" : "";
  const gap =
    r.vsBid != null
      ? r.vsBid <= 0
        ? ` · Crosses bid by ${formatBp(Math.abs(r.vsBid))} (bid ${formatApr(r.bidAtD)})`
        : ` · ${formatBp(r.vsBid)} below bid (${formatApr(r.bidAtD)})`
      : "";
  return `${kindLabel(r.kind)}${bb} · ${formatApr(r.y)} · ${formatDur(r.d, props.unit)}${gap}`;
}

function bidTitle(r: ZcOrderbookBidRow): string {
  if (!isBookRowActive(r) && r.reason) return `${r.reason} · inspect`;
  const span =
    r.yMin !== r.yMax
      ? `${formatApr(r.yMin)}–${formatApr(r.yMax)} across slice (at cursor ${formatApr(r.y)})`
      : formatApr(r.y);
  return `Lend offer · ${span} · ${formatDur(r.range[0], props.unit)}–${formatDur(r.range[1], props.unit)}`;
}

function bidAprLabel(r: ZcOrderbookBidRow): string {
  if (props.upto && r.yMin !== r.yMax) {
    return `${(r.yMin / 100).toFixed(2)}–${(r.yMax / 100).toFixed(2)}%`;
  }
  return formatApr(r.y);
}
</script>

<template>
  <section
    class="sf-terminal-plate flex h-full min-h-[420px] flex-col overflow-hidden rounded-[18px] xl:min-h-0"
  >
    <!-- Header: Mode Switch + Active Slice -->
    <div class="sf-panel-head flex shrink-0 items-center justify-between gap-2 px-3 py-2">
      <div class="sf-seg" role="tablist" aria-label="Book and tape view">
        <button
          type="button"
          role="tab"
          :aria-selected="view === 'book'"
          class="sf-seg-btn px-2 py-1 text-[11px]"
          :class="view === 'book' ? 'is-active tone-cobalt' : ''"
          @click="view = 'book'"
        >
          Book
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="view === 'split'"
          class="sf-seg-btn px-2 py-1 text-[11px]"
          :class="view === 'split' ? 'is-active tone-cobalt' : ''"
          @click="view = 'split'"
        >
          Split
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="view === 'tape'"
          class="sf-seg-btn px-2 py-1 text-[11px]"
          :class="view === 'tape' ? 'is-active tone-cobalt' : ''"
          @click="view = 'tape'"
        >
          <span>Tape</span>
          <span
            v-if="fills.length > 0"
            class="sf-mono text-[9.5px] opacity-75"
          >
            {{ fills.length }}
          </span>
        </button>
      </div>

      <div class="flex items-center gap-1.5">
        <span
          v-if="loading"
          class="h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--sf-cobalt)]"
          title="Syncing book"
        />
        <span
          class="sf-mono rounded-[6px] border border-[color:var(--sf-line)] bg-[color:var(--sf-seg-bg)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--sf-ink-2)]"
        >
          {{ sliceLabel }}
        </span>
      </div>
    </div>

    <!-- ======================================================
         ORDER BOOK LADDER (Book & Split Modes)
         ====================================================== -->
    <div
      v-if="view !== 'tape'"
      class="sf-dock-well flex min-h-0 flex-col"
      :class="view === 'split' ? 'flex-[62_1_0%] border-b border-[color:var(--sf-line-strong)]' : 'flex-1'"
    >
      <!-- Column Labels -->
      <div
        class="sf-mono grid shrink-0 grid-cols-[1.15fr_0.9fr_0.95fr] border-b border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-3 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]"
      >
        <span>APR</span>
        <span class="text-right">Size {{ market }}</span>
        <span class="text-right">{{ unit === "blocks" ? "Blk" : "Term" }}</span>
      </div>

      <!-- Asks Stack (column-reverse keeps highest-APR ask pinned right above the spread!) -->
      <div
        class="sf-scroll asks-wash flex min-h-[76px] flex-1 flex-col-reverse overflow-y-auto py-0.5"
      >
        <template v-if="asksFromBest.length">
          <button
            v-for="row in asksFromBest"
            :key="row.id"
            type="button"
            :aria-pressed="selectedId === row.id"
            :title="askTitle(row)"
            class="sf-mono ladder-row group relative grid w-full shrink-0 grid-cols-[1.15fr_0.9fr_0.95fr] items-center px-3 py-[5px] text-left text-[11.5px]"
            :class="[
              selectedId === row.id ? 'is-selected' : '',
              isBookRowActive(row) ? '' : 'opacity-45'
            ]"
            @click="emit('select-ask', row.id)"
          >
            <span
              class="sf-depth-bar-ask pointer-events-none absolute inset-y-[2px] right-0 rounded-l-[3px]"
              :style="{ width: barWidth(row.size) }"
            />
            <span class="relative z-10 flex items-center gap-1 font-semibold text-[color:var(--sf-ask)]">
              <span
                v-if="row.borrowedByMe && row.kind !== 'order'"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--sf-bid)]"
                title="Your loan"
              />
              <span>{{ formatApr(row.y) }}</span>
              <span
                v-if="row.vsBid != null && row.vsBid <= 0 && isBookRowActive(row)"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--sf-ask)]"
                title="Crosses bid curve at this maturity"
              />
              <span v-if="!isBookRowActive(row)" class="text-[9px] text-[color:var(--sf-warn)]">
                ‖
              </span>
            </span>
            <span class="relative z-10 text-right font-medium text-[color:var(--sf-ink)]">
              {{ formatCompact(row.size) }}
            </span>
            <span class="relative z-10 text-right text-[10.5px] text-[color:var(--sf-muted)]">
              {{ row.window ? `≤${formatDurCell(row.d, unit)}` : formatDurCell(row.d, unit) }}
            </span>
          </button>
        </template>
        <div
          v-else
          class="flex flex-1 items-center justify-center px-3 py-4 text-center text-[11.5px] text-[color:var(--sf-dim)]"
        >
          No asks
        </div>
      </div>

      <!-- Spread Bridge (Chromatic Focal Point — Same-Maturity Tightest Spread) -->
      <div class="sf-spread-bridge flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div class="flex items-center gap-1.5">
          <span
            class="sf-mono text-[13px] font-bold tracking-tight"
            :class="isCrossed ? 'text-[color:var(--sf-ask)]' : 'text-[color:var(--sf-ink)]'"
            :title="
              book.spreadD != null
                ? `Tightest same-maturity spread: bid ${formatApr(book.spreadBid)} − ask ${formatApr(book.spreadAsk)} at ${formatDur(book.spreadD, unit)}`
                : 'Requires overlapping bid and ask at the same maturity'
            "
          >
            {{ formatBp(book.spread) }}
          </span>
          <span
            v-if="book.spread != null && book.spreadD != null"
            class="sf-mono text-[10px] font-medium text-[color:var(--sf-muted)]"
          >
            @{{ formatDurCell(book.spreadD, unit) }}
          </span>
          <span
            v-if="isCrossed"
            class="sf-mono rounded-[4px] border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-ask)]"
            title="Ask APR is at or above bid curve at this maturity"
          >
            Crossed
          </span>
        </div>
        <span class="sf-mono text-[10px] font-medium text-[color:var(--sf-muted)]">
          <span class="text-[color:var(--sf-ask)]">{{ activeAskCount }}a</span>
          <span class="mx-1 opacity-40">·</span>
          <span class="text-[color:var(--sf-bid)]">{{ activeBidCount }}b</span>
        </span>
      </div>

      <!-- Bids Stack (lowest/best APR directly below spread) -->
      <div class="sf-scroll bids-wash flex min-h-[76px] flex-1 flex-col overflow-y-auto py-0.5">
        <template v-if="book.bids.length">
          <button
            v-for="row in book.bids"
            :key="row.id"
            type="button"
            :aria-pressed="selectedId === row.id"
            :title="bidTitle(row)"
            class="sf-mono ladder-row group relative grid w-full shrink-0 grid-cols-[1.15fr_0.9fr_0.95fr] items-center px-3 py-[5px] text-left text-[11.5px]"
            :class="[
              selectedId === row.id ? 'is-selected' : '',
              isBookRowActive(row) ? '' : 'opacity-45'
            ]"
            @click="emit('select-bid', row.id)"
          >
            <span
              class="sf-depth-bar-bid pointer-events-none absolute inset-y-[2px] right-0 rounded-l-[3px]"
              :style="{ width: barWidth(row.size) }"
            />
            <span
              class="relative z-10 flex items-center gap-1 whitespace-nowrap font-semibold text-[color:var(--sf-bid)]"
              :class="upto && row.yMin !== row.yMax ? 'text-[10.5px]' : ''"
            >
              <span>{{ bidAprLabel(row) }}</span>
              <span v-if="!isBookRowActive(row)" class="text-[9px] text-[color:var(--sf-warn)]">
                ‖
              </span>
            </span>
            <span class="relative z-10 text-right font-medium text-[color:var(--sf-ink)]">
              {{ formatCompact(row.size) }}
            </span>
            <span class="relative z-10 text-right text-[10.5px] text-[color:var(--sf-muted)]">
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
          class="flex flex-1 items-center justify-center px-3 py-4 text-center text-[11.5px] text-[color:var(--sf-dim)]"
        >
          No bids
        </div>
      </div>

      <!-- Compact Scale Hint -->
      <div
        v-if="view === 'book'"
        class="sf-mono flex shrink-0 items-center justify-between border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-3 py-1.5 text-[9.5px] text-[color:var(--sf-dim)]"
      >
        <span>APR ↑ · price ↓</span>
        <span title="Bars scale to largest individual order on either side">Per-order depth</span>
      </div>
    </div>

    <!-- ======================================================
         LIVE FILLS TAPE (Split & Tape Modes)
         ====================================================== -->
    <div
      v-if="view !== 'book'"
      class="sf-dock-well flex min-h-0 flex-col"
      :class="view === 'split' ? 'flex-[38_1_0%]' : 'flex-1'"
    >
      <div
        class="sf-mono grid shrink-0 grid-cols-[0.9fr_0.75fr_1fr_0.65fr] border-b border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-3 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]"
      >
        <span>Fill APR</span>
        <span class="text-right">{{ unit === "blocks" ? "Blk" : "Term" }}</span>
        <span class="text-right">Size</span>
        <span class="text-right">Age</span>
      </div>

      <div v-if="recentFills.length" class="sf-scroll min-h-0 flex-1 overflow-y-auto py-0.5">
        <div
          v-for="(fill, idx) in recentFills"
          :key="fill.id"
          class="sf-mono tape-row relative grid grid-cols-[0.9fr_0.75fr_1fr_0.65fr] items-center px-3 py-[5px] text-[11px]"
          :class="[
            fill.kind === 'new' ? 'is-new' : 'is-resale',
            idx < 4 ? 'is-fresh' : ''
          ]"
          :style="{ opacity: inSelection(fill.d) ? 1 : 0.48 }"
          :title="`${fill.kind === 'new' ? 'New loan' : fill.kind === 'shares' ? 'Shares' : 'Resale'} · via ${fill.via}`"
        >
          <span
            class="font-semibold"
            :class="fill.kind === 'new' ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ask)]'"
          >
            {{ formatApr(fill.yieldBps) }}
          </span>
          <span class="text-right text-[color:var(--sf-ink-2)]">
            {{ formatDurCell(fill.d, unit) }}
          </span>
          <span class="text-right font-medium text-[color:var(--sf-ink)]">
            {{ formatCompact(fill.cost) }}
          </span>
          <span class="text-right text-[10px] text-[color:var(--sf-dim)]">
            {{ formatAgo(Math.max(1, height - fill.height), unit) }}
          </span>
        </div>
      </div>

      <div
        v-else
        class="flex flex-1 items-center justify-center px-4 py-6 text-center text-[11.5px] text-[color:var(--sf-dim)]"
      >
        {{ fillsStatus === "not-configured" ? "Fill history unavailable" : "No recent fills" }}
      </div>
    </div>
  </section>
</template>

<style scoped>
.asks-wash {
  background: linear-gradient(
    0deg,
    rgba(var(--sf-ask-rgb), 0.085) 0%,
    rgba(var(--sf-ask-rgb), 0.018) 52%,
    transparent 100%
  );
}

.bids-wash {
  background: linear-gradient(
    180deg,
    rgba(var(--sf-bid-rgb), 0.08) 0%,
    rgba(var(--sf-bid-rgb), 0.018) 52%,
    transparent 100%
  );
}

.ladder-row {
  transition:
    background-color 0.14s ease,
    box-shadow 0.2s var(--sf-ease);
}

.ladder-row:hover {
  background: rgba(var(--sf-cobalt-rgb), 0.07);
}

.ladder-row.is-selected {
  background: rgba(var(--sf-cobalt-rgb), 0.14);
  box-shadow:
    inset 2.5px 0 0 var(--sf-cobalt),
    inset 0 0 0 1px rgba(var(--sf-cobalt-rgb), 0.24);
}

.tape-row {
  transition: background-color 0.14s ease;
}

.tape-row::before {
  content: "";
  position: absolute;
  left: 0;
  top: 5px;
  bottom: 5px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  opacity: 0.45;
}

.tape-row.is-new::before {
  background: var(--sf-bid);
}
.tape-row.is-resale::before {
  background: var(--sf-ask);
}

.tape-row.is-fresh::before {
  opacity: 1;
}

.tape-row.is-fresh.is-new {
  background: linear-gradient(90deg, rgba(var(--sf-bid-rgb), 0.11), transparent 72%);
}
.tape-row.is-fresh.is-resale {
  background: linear-gradient(90deg, rgba(var(--sf-ask-rgb), 0.11), transparent 72%);
}

.tape-row:hover {
  background: rgba(var(--sf-cobalt-rgb), 0.07);
}
</style>
