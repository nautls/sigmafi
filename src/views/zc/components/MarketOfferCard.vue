<script setup lang="ts">
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  LayersIcon,
  ShieldIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, ref } from "vue";
import MiniCurveSpark from "./MiniCurveSpark.vue";
import ZcOrderMark from "./ZcOrderMark.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { ZcDurationUnit, ZcOfferSummary } from "@/types/zc";
import { shortenString } from "@/utils";
import {
  DAY_BLOCKS,
  formatApr,
  formatDur,
  formatMarketAmount,
  formatNumber,
  isOracleRefreshingOnly,
  offerYieldAt
} from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    offer: ZcOfferSummary;
    height: number;
    unit: ZcDurationUnit;
    targetBlocks?: number | null;
    index?: number;
  }>(),
  {
    targetBlocks: null,
    index: 0
  }
);

const emit = defineEmits<{
  (e: "quick-borrow", offer: ZcOfferSummary): void;
  (e: "quick-sell", offer: ZcOfferSummary): void;
  (e: "quick-cancel", offer: ZcOfferSummary): void;
}>();

const copied = ref(false);

function onCardPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

const usable = computed(() => props.offer.ok || isOracleRefreshingOnly(props.offer));

const curvePoints = computed(() => {
  const o = props.offer;
  if (o.points.length >= 2) {
    return o.points.map((p) => ({ d: p.d, y: Math.max(p.y, o.minYieldBps) }));
  }
  return [
    { d: o.minBlocks, y: o.minYieldBps },
    { d: Math.max(o.minBlocks + DAY_BLOCKS, o.maxBlocks), y: o.minYieldBps }
  ];
});

const curveStats = computed(() => {
  const ys = curvePoints.value.map((p) => p.y);
  const lo = ys.length ? Math.min(...ys) : props.offer.minYieldBps;
  const hi = ys.length ? Math.max(...ys) : props.offer.minYieldBps;
  return { lo, hi, flat: lo === hi };
});

const headlineAprBps = computed(() => {
  if (props.targetBlocks != null) {
    const exact = offerYieldAt(props.offer, props.targetBlocks);
    if (exact != null) return exact;
  }
  return curveStats.value.lo;
});

const headlineAprLabel = computed(() => {
  if (props.targetBlocks != null && offerYieldAt(props.offer, props.targetBlocks) != null) {
    return `Rate at ${formatDur(props.targetBlocks, props.unit)}`;
  }
  return curveStats.value.flat ? "Flat Curve APR" : "Curve From";
});

const deployedAmount = computed(() =>
  Math.max(0, (props.offer.funded || props.offer.capital) - props.offer.capital)
);

const remainingPct = computed(() => {
  const funded = props.offer.funded || props.offer.capital;
  if (!(funded > 0)) return 100;
  return Math.max(0, Math.min(100, (props.offer.capital / funded) * 100));
});

const expiryLeftBlocks = computed(() =>
  props.offer.expiry > 0 && props.height > 0 ? Math.max(0, props.offer.expiry - props.height) : null
);

const deliveryLabel = computed(() => {
  if (props.offer.delivery === "selective") return "Selective shares";
  if (props.offer.delivery === "dutch") return "Dutch shares";
  return "Bond units";
});

const enterDelay = computed(() => `${Math.min(props.index * 45, 360)}ms`);

async function copyId() {
  try {
    await navigator.clipboard.writeText(props.offer.id);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // clipboard unavailable
  }
}
</script>

<template>
  <article
    class="sf-bento offer-card group relative flex flex-col overflow-hidden rounded-[22px] rounded-tl-[6px]"
    :style="{ '--card-delay': enterDelay }"
    @mousemove="onCardPointerMove"
  >
    <!-- Ambient Emerald / Cobalt Glow & Top Light Beam -->
    <div class="offer-corner-glow" aria-hidden="true" />
    <div class="offer-top-beam" aria-hidden="true" />

    <!-- Header Strip -->
    <div class="flex items-start justify-between gap-2.5 px-4 pt-4 pb-3">
      <div class="flex min-w-0 items-center gap-2.5">
        <zc-order-mark kind="offer" :size="34" :market="offer.market" />
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="sf-mono rounded-[5px] border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-bid)]"
            >
              Lend Offer
            </span>
            <span
              class="sf-mono rounded-[5px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-1.5 py-[2px] text-[9.5px] font-semibold text-[color:var(--sf-ink-2)]"
            >
              {{ deliveryLabel }}
            </span>
          </div>

          <div class="mt-1 flex items-center gap-1.5 text-[11.5px] text-[color:var(--sf-muted)]">
            <span class="truncate font-medium text-[color:var(--sf-ink-2)]">
              {{ offer.points.length || 2 }}-pt rolling curve
            </span>
            <span class="opacity-40">·</span>
            <button
              type="button"
              class="sf-mono inline-flex shrink-0 items-center gap-1 rounded px-1 py-[1px] text-[10.5px] text-[color:var(--sf-dim)] transition-colors hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
              :title="`Copy offer ID ${offer.id}`"
              @click.stop="copyId"
            >
              <span>{{ shortenString(offer.id, 9) }}</span>
              <check-icon v-if="copied" class="h-2.5 w-2.5 text-[color:var(--sf-bid)]" />
              <copy-icon v-else class="h-2.5 w-2.5 opacity-65" />
            </button>
          </div>
        </div>
      </div>

      <!-- Status Pill -->
      <span
        class="sf-mono inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.07em]"
        :class="
          offer.owner
            ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
            : offer.ok
              ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
              : 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
        "
      >
        <span
          v-if="offer.ok && !offer.owner && !offer.pending"
          class="h-1.5 w-1.5 rounded-full bg-[color:var(--sf-bid)]"
        />
        <span>{{
          offer.pending ? "Pending" : offer.owner ? "Yours" : offer.ok ? "Bidding" : offer.reason
        }}</span>
      </span>
    </div>

    <!-- Hero Capital & Curve Rate Stage -->
    <div class="px-4">
      <div
        class="offer-stage relative overflow-hidden rounded-[16px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] p-3.5"
      >
        <div class="offer-stage-glow" aria-hidden="true" />

        <div class="relative z-10 flex items-start justify-between gap-3">
          <div>
            <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              {{ headlineAprLabel }}
            </div>
            <div class="mt-0.5 flex items-baseline gap-2">
              <span
                class="sf-serif text-[30px] font-semibold leading-none tracking-tight text-[color:var(--sf-bid)]"
              >
                {{ formatApr(headlineAprBps) }}
              </span>
              <span class="sf-mono text-[10.5px] font-medium text-[color:var(--sf-muted)]">
                APR
              </span>
            </div>
            <div class="sf-mono mt-1 text-[10.5px] text-[color:var(--sf-dim)]">
              {{
                curveStats.flat
                  ? `Floor ${formatApr(offer.minYieldBps)}`
                  : `Range ${formatApr(curveStats.lo)} – ${formatApr(curveStats.hi)}`
              }}
            </div>
          </div>

          <div class="flex flex-col items-end text-right">
            <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              Available Capital
            </div>
            <div class="mt-0.5 flex items-center gap-1.5">
              <market-coin :market="offer.market" :size="18" bare />
              <span class="sf-mono text-[18px] font-bold leading-tight text-[color:var(--sf-ink)]">
                {{
                  formatNumber(
                    offer.capital,
                    offer.market === "ERG" ? (offer.capital >= 100 ? 1 : 3) : 2,
                    offer.market === "SigUSD" ? 2 : 0
                  )
                }}
              </span>
              <span class="sf-mono text-[11px] font-semibold text-[color:var(--sf-muted)]">
                {{ offer.market }}
              </span>
            </div>
            <div v-if="deployedAmount > 0.001" class="sf-mono mt-1 text-[10px] text-[color:var(--sf-dim)]">
              {{ Math.round(remainingPct) }}% remaining of {{ formatMarketAmount(offer.funded, offer.market) }}
            </div>
            <div v-else class="sf-mono mt-1 text-[10px] text-[color:var(--sf-dim)]">
              100% open liquidity
            </div>
          </div>
        </div>

        <!-- Visual Rolling Yield Curve Preview -->
        <div
          class="relative z-10 mt-3 flex items-center justify-between gap-3 border-t border-[color:var(--sf-line)] pt-2.5"
        >
          <span class="sf-mono shrink-0 text-[10px] font-medium text-[color:var(--sf-muted)]">
            {{ formatDur(offer.minBlocks, unit) }}
          </span>
          <div class="flex flex-1 justify-center">
            <mini-curve-spark
              :points="curvePoints"
              :width="176"
              :height="28"
              color="var(--sf-bid)"
              fill
              :title="`Rolling lender curve (${formatApr(curveStats.lo)} to ${formatApr(curveStats.hi)})`"
            />
          </div>
          <span class="sf-mono shrink-0 text-[10px] font-medium text-[color:var(--sf-muted)]">
            {{ formatDur(offer.maxBlocks, unit) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Offer Terms Body -->
    <div class="flex flex-1 flex-col gap-2.5 px-4 pt-3 pb-3.5">
      <div class="grid grid-cols-2 gap-2 text-[11.5px]">
        <div class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2.5 py-2">
          <div class="sf-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-dim)]">
            Cover Floor
          </div>
          <div class="sf-mono mt-0.5 flex items-center gap-1.5 font-semibold text-[color:var(--sf-ink)]">
            <shield-icon class="h-3 w-3 text-[color:var(--sf-cobalt)]" />
            <span>≥ {{ offer.floor }}% oracle</span>
          </div>
        </div>

        <div class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2.5 py-2">
          <div class="sf-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-dim)]">
            Share Resales
          </div>
          <div class="sf-mono mt-0.5 flex items-center gap-1.5 font-semibold text-[color:var(--sf-ink)]">
            <layers-icon
              class="h-3 w-3"
              :class="offer.shares ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-dim)]'"
            />
            <span>{{ offer.shares ? `Yes (≥${Math.round(offer.shares.floor / 100)}%)` : "Whole only" }}</span>
          </div>
        </div>
      </div>

      <!-- Bottom Meta Line -->
      <div
        class="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--sf-line)] pt-2.5 text-[10.5px] text-[color:var(--sf-muted)]"
      >
        <span class="sf-mono">
          {{ offer.market === "ERG" ? `Batcher ${offer.fee} ERG` : `Refund ${offer.fee} ERG` }}
        </span>
        <span v-if="expiryLeftBlocks != null" class="sf-mono text-[color:var(--sf-dim)]">
          Exp {{ formatDur(expiryLeftBlocks, unit) }}
        </span>
      </div>
    </div>

    <!-- Action Footer: Quick Borrow / Sell + Terms & Verification -->
    <div
      class="flex items-center gap-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card-glass)] px-4 py-3"
    >
      <button
        v-if="offer.owner"
        type="button"
        class="sf-btn-ask flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[12px]"
        @click="emit('quick-cancel', offer)"
      >
        <span>Cancel &amp; Refund</span>
        <arrow-right-icon class="h-3.5 w-3.5" />
      </button>

      <template v-else>
        <button
          type="button"
          :disabled="!usable"
          :title="
            usable
              ? 'Prefill sidebar to borrow against this offer'
              : offer.reason || 'Offer paused'
          "
          class="sf-btn-ask flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[12px] disabled:cursor-not-allowed disabled:opacity-45"
          @click="emit('quick-borrow', offer)"
        >
          <span class="truncate">{{ usable ? "Quick Borrow" : offer.reason || "Paused" }}</span>
          <arrow-right-icon v-if="usable" class="h-3.5 w-3.5 shrink-0" />
        </button>

        <button
          type="button"
          :disabled="!usable"
          title="Sell a held bond into this offer"
          class="sf-btn-outline inline-flex h-9 shrink-0 items-center justify-center rounded-xl px-2.5 text-[11.5px] font-semibold text-[color:var(--sf-ink-2)] hover:text-[color:var(--sf-bid)] disabled:cursor-not-allowed disabled:opacity-45"
          @click="emit('quick-sell', offer)"
        >
          Sell
        </button>
      </template>

      <router-link
        :to="{ name: 'zc-offer', params: { id: offer.id } }"
        class="sf-btn-outline inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-xl px-3 text-[11.5px] font-semibold text-[color:var(--sf-ink-2)] hover:text-[color:var(--sf-cobalt)]"
        title="Open full lend offer terms, curve & verification"
      >
        <shield-icon class="h-3.5 w-3.5 text-[color:var(--sf-cobalt)]" />
        <span>Terms</span>
        <arrow-up-right-icon class="h-3 w-3 opacity-70" />
      </router-link>
    </div>
  </article>
</template>

<style scoped>
.offer-card {
  animation: sfCardLiftIn 0.48s var(--sf-ease) var(--card-delay, 0ms) both;
}

.offer-card:hover {
  transform: translateY(-3px);
}

.offer-top-beam {
  position: absolute;
  top: 0;
  left: 14%;
  right: 14%;
  height: 2px;
  border-radius: 0 0 999px 999px;
  pointer-events: none;
  z-index: 4;
  opacity: 0.72;
  transition:
    opacity 0.28s var(--sf-ease),
    left 0.34s var(--sf-ease),
    right 0.34s var(--sf-ease);
  background: linear-gradient(
    90deg,
    transparent,
    rgba(var(--sf-bid-rgb), 0.85),
    transparent
  );
}

.offer-card:hover .offer-top-beam {
  opacity: 1;
  left: 6%;
  right: 6%;
}

.offer-corner-glow {
  position: absolute;
  top: -54px;
  right: -54px;
  width: 170px;
  height: 170px;
  border-radius: 9999px;
  pointer-events: none;
  z-index: 0;
  opacity: 0.45;
  filter: blur(22px);
  transition: opacity 0.32s var(--sf-ease);
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-bid-rgb), 0.22),
    transparent 74%
  );
}

.offer-card:hover .offer-corner-glow {
  opacity: 0.88;
}

.offer-stage {
  box-shadow: var(--sf-well-shadow);
}

.offer-stage-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 64% 80% at 15% 15%, rgba(var(--sf-bid-rgb), 0.13), transparent 72%),
    radial-gradient(ellipse 52% 72% at 88% 82%, rgba(var(--sf-cobalt-rgb), 0.08), transparent 72%);
}

:root[data-theme="dark"] .offer-stage-glow {
  background:
    radial-gradient(ellipse 64% 80% at 15% 15%, rgba(var(--sf-bid-rgb), 0.06), transparent 72%),
    radial-gradient(ellipse 52% 72% at 88% 82%, rgba(var(--sf-cobalt-rgb), 0.08), transparent 72%);
}

@keyframes sfCardLiftIn {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .offer-card {
    animation: none !important;
  }
  .offer-card:hover {
    transform: none !important;
  }
}
</style>
