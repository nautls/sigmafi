<script setup lang="ts">
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  ShieldIcon,
  SlidersIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, ref } from "vue";
import CoverMeter from "./CoverMeter.vue";
import MiniCurveSpark from "./MiniCurveSpark.vue";
import ZcAssetChip from "./ZcAssetChip.vue";
import ZcOrderMark from "./ZcOrderMark.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { ZcAskSummary, ZcCollateralToken, ZcDurationUnit } from "@/types/zc";
import { shortenString } from "@/utils";
import {
  askPath,
  coverage,
  dateAtHeight,
  formatApr,
  formatDur,
  formatMarketAmount,
  formatNumber,
  isOracleRefreshingOnly,
  kindLabel,
  liquidationPrice,
  pricingName,
  resolvedAskQuote,
  shareTotalOf,
  SIGUSD_TOKEN_ID
} from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    ask: ZcAskSummary;
    height: number;
    oraclePrice: number;
    unit: ZcDurationUnit;
    index?: number;
  }>(),
  {
    index: 0
  }
);

const emit = defineEmits<{
  (e: "quick-fill", ask: ZcAskSummary): void;
  (e: "quick-cancel", ask: ZcAskSummary): void;
}>();

const copied = ref(false);

function onCardPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

const quote = computed(() => resolvedAskQuote(props.ask, props.height));
const isWindow = computed(() => props.ask.pricing === "window" && !!props.ask.window);
const isShares = computed(() => props.ask.kind === "shares");
const isPartialShares = computed(
  () => isShares.value && props.ask.units > (props.ask.minFill || 1)
);
const isBuyback = computed(
  () => !!props.ask.borrowedByMe && props.ask.kind !== "order" && !props.ask.owner
);
const usable = computed(() => props.ask.ok || isOracleRefreshingOnly(props.ask));

const collateral = computed(() => props.ask.bond?.collateral || props.ask.collateral);
const repayment = computed(
  () => props.ask.bond?.repayment ?? props.ask.repayment ?? quote.value?.face ?? 0
);
const rule = computed(() => props.ask.bond?.rule || props.ask.rule);
const ratio = computed(() => props.ask.bond?.ratio ?? props.ask.ratio);

const cov = computed(() => {
  if (props.ask.cov != null) return props.ask.cov;
  if (rule.value === "oracle" && props.oraclePrice > 0 && repayment.value > 0) {
    return coverage(collateral.value, repayment.value, props.ask.market, props.oraclePrice);
  }
  return null;
});

const liqInfo = computed(() =>
  rule.value === "oracle" && ratio.value != null && repayment.value > 0
    ? liquidationPrice(collateral.value, repayment.value, props.ask.market, ratio.value)
    : null
);

const liqText = computed(() => {
  if (rule.value !== "oracle") return "No early liquidation";
  const lp = liqInfo.value;
  if (!lp) return ratio.value != null ? `Liq < ${ratio.value}%` : "Oracle rule";
  if (lp.price == null) {
    return lp.dir === "never" ? "Price-protected" : "At threshold";
  }
  return `Liq ERG ${lp.dir === "below" ? "<" : ">"} $${formatNumber(lp.price, 3, 2)}`;
});

const termReturnPct = computed(() => {
  const q = quote.value;
  if (!q || !(q.cost > 0)) return null;
  return (q.face / q.cost - 1) * 100;
});

const grossGain = computed(() => {
  const q = quote.value;
  if (!q) return null;
  return Math.max(0, q.face - q.cost);
});

const sharesAvailPct = computed(() =>
  isShares.value ? (props.ask.units / shareTotalOf(props.ask)) * 100 : 100
);

const sparkPoints = computed(() => askPath(props.ask, props.height, 16));

const expiryLeftBlocks = computed(() =>
  props.ask.expiry > 0 && props.height > 0 ? Math.max(0, props.ask.expiry - props.height) : null
);

const collateralChips = computed<ZcCollateralToken[]>(() => {
  const col = collateral.value;
  const list: ZcCollateralToken[] = [];
  if (col.erg > 0.0011) {
    list.push({
      id: "erg",
      ticker: "ERG",
      name: "Ergo",
      decimals: 9,
      amount: col.erg,
      rawAmount: String(Math.round(col.erg * 1e9)),
      kind: "token",
      verified: true
    });
  }
  if (col.usd > 0) {
    list.push({
      id: SIGUSD_TOKEN_ID,
      ticker: "SigUSD",
      name: "SigmaUSD",
      decimals: 2,
      amount: col.usd,
      rawAmount: String(Math.round(col.usd * 100)),
      kind: "token",
      verified: true
    });
  }
  for (const t of col.tokens || []) {
    list.push(t);
  }
  return list;
});

const cardTone = computed<"ask" | "cobalt" | "bid">(() => {
  if (isBuyback.value) return "bid";
  if (props.ask.kind === "order") return "ask";
  return "cobalt";
});

const kindBadgeLabel = computed(() => {
  if (props.ask.kind === "order") return "Borrow Request";
  if (props.ask.kind === "shares") return "Share Resale";
  return "Bond Resale";
});

const quickActionLabel = computed(() => {
  if (!usable.value) return props.ask.reason || "Paused";
  const costStr = quote.value ? formatMarketAmount(quote.value.cost, props.ask.market) : "";
  if (isWindow.value) return "Pick Term & Fund";
  if (isBuyback.value) return costStr ? `Buy Back · ${costStr}` : "Buy Back";
  if (props.ask.kind === "order") return costStr ? `Fund · ${costStr}` : "Quick Fund";
  if (isPartialShares.value) return costStr ? `Buy Shares · ${costStr}` : "Buy Shares";
  return costStr ? `Buy · ${costStr}` : "Quick Buy";
});

const enterDelay = computed(() => `${Math.min(props.index * 45, 360)}ms`);

async function copyId() {
  try {
    await navigator.clipboard.writeText(props.ask.id);
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
    class="sf-bento market-card group relative flex flex-col overflow-hidden rounded-[22px] rounded-tl-[6px]"
    :data-tone="cardTone"
    :style="{ '--card-delay': enterDelay }"
    @mousemove="onCardPointerMove"
  >
    <!-- Ambient Chromatic Corner Glow & Top Rim Light -->
    <div class="card-corner-glow" aria-hidden="true" />
    <div class="card-top-beam" aria-hidden="true" />

    <!-- Header Strip: Order Mark + Listing Kind + Status + Box ID -->
    <div class="flex items-start justify-between gap-2.5 px-4 pt-4 pb-3">
      <div class="flex min-w-0 items-center gap-2.5">
        <zc-order-mark :kind="ask.kind" :size="34" :market="ask.market" />
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="sf-mono rounded-[5px] border px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-[0.08em]"
              :class="
                ask.kind === 'order'
                  ? 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                  : 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
              "
            >
              {{ kindBadgeLabel }}
            </span>
            <span
              v-if="isBuyback"
              class="sf-mono rounded-[5px] border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--sf-bid)]"
            >
              Your Loan
            </span>
            <span
              v-if="isShares"
              class="sf-mono rounded-[5px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-1.5 py-[2px] text-[9.5px] font-semibold text-[color:var(--sf-ink-2)]"
            >
              {{ formatNumber(sharesAvailPct, 1, 0) }} / 100 sh
            </span>
          </div>
          <div class="mt-1 flex items-center gap-1.5 text-[11.5px] text-[color:var(--sf-muted)]">
            <span class="truncate font-medium text-[color:var(--sf-ink-2)]">
              {{ pricingName(ask) }}
            </span>
            <span class="opacity-40">·</span>
            <button
              type="button"
              class="sf-mono inline-flex shrink-0 items-center gap-1 rounded px-1 py-[1px] text-[10.5px] text-[color:var(--sf-dim)] transition-colors hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
              :title="`Copy box ID ${ask.id}`"
              @click.stop="copyId"
            >
              <span>{{ shortenString(ask.id, 9) }}</span>
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
          ask.owner
            ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
            : ask.ok
              ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
              : 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
        "
      >
        <span
          v-if="ask.ok && !ask.owner && !ask.pending"
          class="h-1.5 w-1.5 rounded-full bg-[color:var(--sf-bid)]"
        />
        <span>{{ ask.pending ? "Pending" : ask.owner ? "Yours" : ask.ok ? "Live" : ask.reason }}</span>
      </span>
    </div>

    <!-- Hero Financial Stage: APR + Principal / Pay Now + Mini Path Spark -->
    <div class="px-4">
      <div
        class="hero-stage relative overflow-hidden rounded-[16px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] p-3.5"
      >
        <div class="hero-stage-glow" aria-hidden="true" />
        <div class="relative z-10 flex items-start justify-between gap-3">
          <div>
            <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              {{ isWindow ? "Best Window APR" : "Lender Earns" }}
            </div>
            <div class="mt-0.5 flex items-baseline gap-2">
              <span
                class="sf-serif text-[30px] font-semibold leading-none tracking-tight text-[color:var(--sf-bid)]"
              >
                {{ formatApr(quote?.yieldBps) }}
              </span>
              <span class="sf-mono text-[10.5px] font-medium text-[color:var(--sf-muted)]">
                APR
              </span>
            </div>
            <div class="sf-mono mt-1 text-[10.5px] text-[color:var(--sf-dim)]">
              {{
                termReturnPct != null
                  ? `+${formatNumber(termReturnPct, 2, 2)}% over term`
                  : kindLabel(ask.kind)
              }}
            </div>
          </div>

          <div class="flex flex-col items-end text-right">
            <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              {{ ask.kind === "order" ? "Fund Now" : "Pay Now" }}
            </div>
            <div class="mt-0.5 flex items-center gap-1.5">
              <market-coin :market="ask.market" :size="18" bare />
              <span class="sf-mono text-[18px] font-bold leading-tight text-[color:var(--sf-ink)]">
                {{
                  quote
                    ? formatNumber(
                        quote.cost,
                        ask.market === "ERG" ? (quote.cost >= 100 ? 1 : 3) : 2,
                        ask.market === "SigUSD" ? 2 : 0
                      )
                    : "—"
                }}
              </span>
              <span class="sf-mono text-[11px] font-semibold text-[color:var(--sf-muted)]">
                {{ ask.market }}
              </span>
            </div>
            <div class="mt-1 flex items-center gap-2">
              <span v-if="quote" class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
                {{ quote.pct.toFixed(1) }}% par
              </span>
              <mini-curve-spark
                v-if="sparkPoints.length >= 2"
                :points="sparkPoints"
                :width="48"
                :height="16"
                :color="ask.kind === 'order' ? 'var(--sf-ask)' : 'var(--sf-cobalt)'"
                :title="isWindow ? 'APR across maturity window' : 'APR path until expiry'"
              />
            </div>
          </div>
        </div>

        <!-- Compact Claim / Interest / Term Row inside Stage -->
        <div
          class="relative z-10 mt-3 grid grid-cols-3 gap-2 border-t border-[color:var(--sf-line)] pt-2.5"
        >
          <div class="min-w-0">
            <div class="sf-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-dim)]">
              Repays
            </div>
            <div class="sf-mono mt-0.5 truncate text-[12px] font-semibold text-[color:var(--sf-ink)]">
              {{ quote ? formatMarketAmount(quote.face, ask.market) : "—" }}
            </div>
          </div>

          <div class="min-w-0">
            <div class="sf-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-dim)]">
              Gross Gain
            </div>
            <div class="sf-mono mt-0.5 truncate text-[12px] font-semibold text-[color:var(--sf-bid)]">
              {{ grossGain != null ? `+${formatMarketAmount(grossGain, ask.market)}` : "—" }}
            </div>
          </div>

          <div class="min-w-0 text-right">
            <div class="sf-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-dim)]">
              {{ isWindow ? "Window" : ask.kind === "order" && ask.mode === "term" ? "Term" : "Matures" }}
            </div>
            <div
              class="sf-mono mt-0.5 truncate text-[12px] font-semibold text-[color:var(--sf-ink)]"
              :title="
                quote
                  ? `${dateAtHeight(height + quote.d, height)} · ${formatDur(quote.d, unit)}`
                  : undefined
              "
            >
              <template v-if="isWindow && ask.window">
                {{ formatDur(ask.window.min, unit) }}–{{ formatDur(ask.window.max, unit) }}
              </template>
              <template v-else-if="ask.kind === 'order' && ask.mode === 'term'">
                {{ formatDur(ask.duration, unit) }}
              </template>
              <template v-else-if="quote">
                {{ formatDur(quote.d, unit) }}
              </template>
              <template v-else>—</template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Collateral & Safety Body (V1 Heritage + V2 Precision) -->
    <div class="flex flex-1 flex-col gap-2.5 px-4 pt-3 pb-3.5">
      <div class="flex items-center justify-between gap-2">
        <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
          Collateral
        </span>
        <cover-meter
          v-if="rule === 'oracle'"
          :value="cov"
          :ratio="ratio"
          :guard="ask.guard?.ratio ?? null"
          compact
        />
        <span
          v-else
          class="sf-mono rounded-[5px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-1.5 py-[1px] text-[10px] font-semibold text-[color:var(--sf-ink-2)]"
        >
          Maturity rule
        </span>
      </div>

      <!-- Collateral Basket Chips -->
      <div v-if="collateralChips.length > 0" class="flex flex-wrap items-center gap-1.5">
        <zc-asset-chip
          v-for="(tok, idx) in collateralChips.slice(0, 5)"
          :key="`${tok.id}-${idx}`"
          :token="tok"
          :height="height"
          variant="chip"
        />
        <span
          v-if="collateralChips.length > 5"
          class="sf-mono rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-1 text-[10.5px] font-semibold text-[color:var(--sf-muted)]"
        >
          +{{ collateralChips.length - 5 }} more
        </span>
      </div>
      <div v-else class="sf-mono text-[11px] text-[color:var(--sf-dim)]">
        Collateral metadata loading…
      </div>

      <!-- Safety & Schedule Metadata Footer inside Body -->
      <div
        class="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[color:var(--sf-line)] pt-2.5 text-[10.5px] text-[color:var(--sf-muted)]"
      >
        <span class="sf-mono inline-flex items-center gap-1">
          <shield-icon
            class="h-3 w-3 shrink-0"
            :class="
              rule === 'oracle' ? 'text-[color:var(--sf-cobalt)]' : 'text-[color:var(--sf-dim)]'
            "
          />
          <span>{{ liqText }}</span>
        </span>
        <span v-if="expiryLeftBlocks != null" class="sf-mono text-[color:var(--sf-dim)]">
          Exp {{ formatDur(expiryLeftBlocks, unit) }}
        </span>
      </div>
    </div>

    <!-- Action Footer: Quick Fill + Terms & Verification -->
    <div
      class="flex items-center gap-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card-glass)] px-4 py-3"
    >
      <button
        v-if="ask.owner"
        type="button"
        class="sf-btn-ask flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[12px]"
        @click="emit('quick-cancel', ask)"
      >
        <span>Cancel &amp; Refund</span>
        <arrow-right-icon class="h-3.5 w-3.5" />
      </button>

      <button
        v-else
        type="button"
        :disabled="!usable"
        :title="usable ? 'Quick fill this listing via Nautilus' : ask.reason || 'Listing paused'"
        class="sf-btn-bid flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[12px] disabled:cursor-not-allowed disabled:opacity-45"
        @click="emit('quick-fill', ask)"
      >
        <sliders-icon v-if="(isWindow || isPartialShares) && usable" class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate">{{ quickActionLabel }}</span>
        <arrow-right-icon v-if="usable && !isWindow && !isPartialShares" class="h-3.5 w-3.5 shrink-0" />
      </button>

      <router-link
        :to="{ name: 'zc-bond', params: { id: ask.id } }"
        class="sf-btn-outline inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-xl px-3 text-[11.5px] font-semibold text-[color:var(--sf-ink-2)] hover:text-[color:var(--sf-cobalt)]"
        title="Open full terms, collateral breakdown & cryptographic verification"
      >
        <shield-icon class="h-3.5 w-3.5 text-[color:var(--sf-cobalt)]" />
        <span>Terms</span>
        <arrow-up-right-icon class="h-3 w-3 opacity-70" />
      </router-link>
    </div>
  </article>
</template>

<style scoped>
.market-card {
  animation: sfCardLiftIn 0.48s var(--sf-ease) var(--card-delay, 0ms) both;
}

.market-card:hover {
  transform: translateY(-3px);
}

.card-top-beam {
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
    rgba(var(--sf-cobalt-rgb), 0.78),
    transparent
  );
}

.market-card[data-tone="ask"] .card-top-beam {
  background: linear-gradient(
    90deg,
    transparent,
    rgba(var(--sf-ask-rgb), 0.82),
    transparent
  );
}

.market-card[data-tone="bid"] .card-top-beam {
  background: linear-gradient(
    90deg,
    transparent,
    rgba(var(--sf-bid-rgb), 0.85),
    transparent
  );
}

.market-card:hover .card-top-beam {
  opacity: 1;
  left: 6%;
  right: 6%;
}

.card-corner-glow {
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
    rgba(var(--sf-cobalt-rgb), 0.24),
    transparent 74%
  );
}

.market-card[data-tone="ask"] .card-corner-glow {
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-ask-rgb), 0.22),
    transparent 74%
  );
}

.market-card[data-tone="bid"] .card-corner-glow {
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-bid-rgb), 0.24),
    transparent 74%
  );
}

.market-card:hover .card-corner-glow {
  opacity: 0.85;
}

.hero-stage {
  box-shadow: var(--sf-well-shadow);
}

.hero-stage-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 64% 80% at 14% 18%, rgba(var(--sf-bid-rgb), 0.11), transparent 72%),
    radial-gradient(ellipse 52% 72% at 90% 85%, rgba(var(--sf-cobalt-rgb), 0.08), transparent 72%);
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
  .market-card {
    animation: none !important;
  }
  .market-card:hover {
    transform: none !important;
  }
}
</style>
