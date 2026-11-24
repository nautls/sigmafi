<script setup lang="ts">
import { ArrowRightIcon, ArrowUpRightIcon, ShieldIcon, XIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ExecutionPreviewPayload } from "./ExecutionPreviewModal.vue";
import ZcOrderMark from "./ZcOrderMark.vue";
import { ZcAskSummary, ZcDurationUnit } from "@/types/zc";
import { shortenString } from "@/utils";
import {
  dateAtHeight,
  DAY_BLOCKS,
  formatApr,
  formatDur,
  formatMarketAmount,
  formatNumber,
  GRID_BLOCKS,
  kindLabel,
  pricingName,
  resolvedAskQuote,
  SHARES_UNITS,
  windowCandidates
} from "@/utils/zcMath";

const props = defineProps<{
  ask: ZcAskSummary;
  height: number;
  unit: ZcDurationUnit;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "proceed", payload: ExecutionPreviewPayload): void;
}>();

const isWindow = computed(() => props.ask.pricing === "window" && !!props.ask.window);
const isShares = computed(() => props.ask.kind === "shares");
const isBuyback = computed(
  () => !!props.ask.borrowedByMe && props.ask.kind !== "order" && !props.ask.owner
);

const candidates = computed(() =>
  isWindow.value ? windowCandidates(props.ask, props.height) : []
);

const windowBlocks = ref<number>(0);
const sharesPct = ref<number>(100);

function initState() {
  if (isWindow.value && props.ask.window) {
    const best = resolvedAskQuote(props.ask, props.height);
    const gridHit = candidates.value.find((d) => (props.height + d) % GRID_BLOCKS === 0);
    windowBlocks.value = best?.d ?? gridHit ?? props.ask.window.min;
  }
  if (isShares.value) {
    sharesPct.value = (props.ask.units / SHARES_UNITS) * 100;
  }
}

watch(() => props.ask.id, initState, { immediate: true });

const maxSharesPct = computed(() =>
  isShares.value ? Math.max(0.01, (props.ask.units / SHARES_UNITS) * 100) : 100
);
const minSharesPct = computed(() =>
  isShares.value ? Math.max(0.01, ((props.ask.minFill || 1) / SHARES_UNITS) * 100) : 100
);

const selectedUnits = computed(() => {
  if (!isShares.value) return 1;
  return Math.round(
    Math.min(
      props.ask.units,
      Math.max(props.ask.minFill || 1, (sharesPct.value / 100) * SHARES_UNITS)
    )
  );
});

const shareFrac = computed(() =>
  isShares.value && props.ask.units > 0 ? selectedUnits.value / props.ask.units : 1
);

const baseQuote = computed(() =>
  resolvedAskQuote(props.ask, props.height, isWindow.value ? windowBlocks.value : null)
);

const activeQuote = computed(() => {
  const q = baseQuote.value;
  if (!q) return null;
  if (!isShares.value || shareFrac.value === 1) return q;
  return {
    ...q,
    cost: q.cost * shareFrac.value,
    face: q.face * shareFrac.value
  };
});

const isOnGrid = computed(() => {
  if (!isWindow.value || !props.height) return false;
  return (props.height + windowBlocks.value) % GRID_BLOCKS === 0;
});

function snapToCandidate(d: number) {
  windowBlocks.value = d;
}

function proceedToSign() {
  const q = activeQuote.value;
  if (!q) return;
  const m = props.ask.market;
  const rule = props.ask.bond?.rule || props.ask.rule;
  const ratio = props.ask.bond?.ratio ?? props.ask.ratio;

  emit("proceed", {
    title:
      props.ask.kind === "order"
        ? `Fund ${m} Borrow Order`
        : isBuyback.value
          ? `Buy Back Your ${isShares.value ? "Shares" : "Bond"}`
          : `Buy ${kindLabel(props.ask.kind)} (${m})`,
    subtitle: `${pricingName(props.ask)} · ${shortenString(props.ask.id, 14)}`,
    badge:
      props.ask.kind === "order"
        ? "Direct Lend"
        : isBuyback.value
          ? "Loan Buyback"
          : "Secondary Buy",
    tone: "bid",
    heroLabel: props.ask.kind === "order" ? "You fund now" : "You pay now",
    heroValue: formatMarketAmount(q.cost, m),
    heroSub: `${formatApr(q.yieldBps)} APR · ${q.pct.toFixed(2)}% of face`,
    rows: [
      { label: "Claim at maturity", value: formatMarketAmount(q.face, m) },
      { label: "Gross interest", value: `+${formatMarketAmount(q.face - q.cost, m)}`, tone: "bid" },
      {
        label: "Maturity",
        value: `${dateAtHeight(props.height + q.d, props.height)} · ${formatDur(q.d, props.unit)}`
      },
      ...(isShares.value
        ? [
            {
              label: "Share lot",
              value: `${formatNumber((selectedUnits.value / SHARES_UNITS) * 100, 2, 0)} / 100 shares`
            }
          ]
        : []),
      {
        label: "Collateral cover",
        value:
          rule === "oracle"
            ? `${props.ask.cov != null ? Math.round(props.ask.cov) : "—"}% (liq. < ${ratio ?? "—"}%)`
            : "Maturity rule"
      },
      ...(props.ask.kind === "order"
        ? [{ label: "Fee reserve", value: "0.05 ERG (returned)" }]
        : [])
    ],
    rawSummary: {
      action: props.ask.kind === "order" ? "fillOrder" : "buyAsk",
      boxId: props.ask.id,
      market: m,
      units: isShares.value ? String(selectedUnits.value) : "1",
      cost: q.cost,
      face: q.face,
      yieldBps: Math.round(q.yieldBps),
      blocksLeft: q.d,
      maturity: q.maturity
    },
    txAction:
      props.ask.kind === "order"
        ? {
            type: "fillOrder",
            boxId: props.ask.id,
            maturity: isWindow.value ? BigInt(q.maturity) : null
          }
        : {
            type: "buyAsk",
            boxId: props.ask.id,
            units: isShares.value ? BigInt(selectedUnits.value) : null
          }
  });
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-md"
    role="dialog"
    aria-modal="true"
    aria-label="Configure quick fill"
    @click.self="emit('close')"
  >
    <div
      class="sf-modal-card sf-action-dock flex w-full max-w-md flex-col overflow-hidden rounded-[24px] rounded-tr-[8px]"
      data-tone="bid"
    >
      <!-- Header -->
      <div class="sf-panel-head flex items-start justify-between gap-3 px-5 py-4">
        <div class="flex items-center gap-3">
          <zc-order-mark :kind="ask.kind" :size="36" :market="ask.market" />
          <div>
            <h3 class="sf-display text-[18px] font-bold leading-tight text-[color:var(--sf-ink)]">
              {{ isWindow ? "Pick Maturity to Fund" : "Choose Share Quantity" }}
            </h3>
            <p class="sf-mono mt-0.5 text-[11px] text-[color:var(--sf-muted)]">
              {{ ask.market }} · {{ shortenString(ask.id, 14) }}
            </p>
          </div>
        </div>

        <button
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
          aria-label="Close"
          @click="emit('close')"
        >
          <x-icon class="h-4 w-4" />
        </button>
      </div>

      <!-- Body -->
      <div class="space-y-4 px-5 py-4">
        <!-- Hero Live Quote -->
        <div
          class="grid grid-cols-2 divide-x divide-[color:var(--sf-line)] rounded-2xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)]"
        >
          <div class="p-3">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              APR
            </div>
            <div class="sf-serif mt-0.5 text-[28px] font-semibold leading-none text-[color:var(--sf-bid)]">
              {{ formatApr(activeQuote?.yieldBps) }}
            </div>
          </div>
          <div class="p-3">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              {{ ask.kind === "order" ? "You Fund" : "You Pay" }}
            </div>
            <div class="sf-mono mt-1 text-[17px] font-bold leading-tight text-[color:var(--sf-ink)]">
              {{ activeQuote ? formatMarketAmount(activeQuote.cost, ask.market) : "—" }}
            </div>
          </div>
        </div>

        <!-- Window Maturity Picker -->
        <div
          v-if="isWindow && ask.window"
          class="space-y-2.5 rounded-2xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/35 p-3.5"
        >
          <div class="sf-mono flex items-center justify-between text-[11px]">
            <span class="font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-cobalt)]">
              Maturity
            </span>
            <span class="font-semibold text-[color:var(--sf-ink)]">
              {{ dateAtHeight(height + windowBlocks, height) }} · {{ formatDur(windowBlocks, unit) }}
              <span v-if="isOnGrid" class="ml-1 text-[color:var(--sf-cobalt)]">· grid</span>
            </span>
          </div>

          <input
            v-model.number="windowBlocks"
            type="range"
            :min="ask.window.min"
            :max="ask.window.max"
            :step="DAY_BLOCKS"
            aria-label="Choose maturity"
            class="sf-range"
          />

          <div v-if="candidates.length > 0" class="flex flex-wrap gap-1.5 pt-1">
            <button
              v-for="d in candidates.slice(0, 6)"
              :key="d"
              type="button"
              class="sf-mono rounded-lg border px-2 py-1 text-[10.5px] font-semibold transition-colors"
              :class="
                windowBlocks === d
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-card)] text-[color:var(--sf-cobalt)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="snapToCandidate(d)"
            >
              {{ formatDur(d, unit) }}
            </button>
          </div>
        </div>

        <!-- Shares Quantity Picker -->
        <div
          v-if="isShares"
          class="space-y-2.5 rounded-2xl border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)]/35 p-3.5"
        >
          <div class="sf-mono flex items-center justify-between text-[11px]">
            <span class="font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-bid)]">
              Shares to Buy
            </span>
            <span class="font-semibold text-[color:var(--sf-ink)]">
              {{ formatNumber(sharesPct, 2, 0) }} / {{ formatNumber(maxSharesPct, 2, 0) }} sh
            </span>
          </div>

          <input
            v-model.number="sharesPct"
            type="range"
            :min="minSharesPct"
            :max="maxSharesPct"
            step="0.5"
            aria-label="Choose share quantity"
            class="sf-range"
          />

          <div class="flex flex-wrap gap-1.5 pt-0.5">
            <button
              v-for="frac in [0.25, 0.5, 0.75, 1]"
              :key="frac"
              type="button"
              class="sf-mono rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2 py-1 text-[10.5px] font-semibold text-[color:var(--sf-ink-2)] hover:border-[color:var(--sf-line-bid)] hover:text-[color:var(--sf-bid)]"
              @click="sharesPct = Math.max(minSharesPct, Number((maxSharesPct * frac).toFixed(2)))"
            >
              {{ frac === 1 ? "All" : `${Math.round(frac * 100)}%` }}
            </button>
          </div>
        </div>

        <dl class="divide-y divide-[color:var(--sf-line)] text-[12px]">
          <div class="flex items-center justify-between py-2">
            <dt class="text-[color:var(--sf-muted)]">Claim at maturity</dt>
            <dd class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              {{ activeQuote ? formatMarketAmount(activeQuote.face, ask.market) : "—" }}
            </dd>
          </div>
          <div class="flex items-center justify-between py-2">
            <dt class="text-[color:var(--sf-muted)]">Gross interest</dt>
            <dd class="sf-mono font-semibold text-[color:var(--sf-bid)]">
              {{
                activeQuote
                  ? `+${formatMarketAmount(activeQuote.face - activeQuote.cost, ask.market)}`
                  : "—"
              }}
            </dd>
          </div>
        </dl>
      </div>

      <!-- Footer -->
      <div
        class="flex items-center justify-between gap-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-5 py-3"
      >
        <router-link
          :to="{ name: 'zc-bond', params: { id: ask.id } }"
          class="sf-btn-outline inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[12px] font-semibold"
          @click="emit('close')"
        >
          <shield-icon class="h-3.5 w-3.5 text-[color:var(--sf-cobalt)]" />
          <span>Full Terms</span>
          <arrow-up-right-icon class="h-3 w-3 opacity-70" />
        </router-link>

        <button
          type="button"
          :disabled="!activeQuote"
          class="sf-btn-bid inline-flex h-9 items-center gap-1.5 rounded-xl px-4 text-[12.5px] disabled:opacity-45"
          @click="proceedToSign"
        >
          <span>Review &amp; Sign</span>
          <arrow-right-icon class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
