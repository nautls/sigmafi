<script setup lang="ts">
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  ShieldIcon,
  XIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, ref, watch } from "vue";
import CoverMeter from "./CoverMeter.vue";
import { ExecutionPreviewPayload } from "./ExecutionPreviewModal.vue";
import { ZcAskSummary, ZcCurves, ZcDurationUnit } from "@/types/zc";
import { shortenString } from "@/utils";
import {
  askQuote,
  coverage,
  dateAtHeight,
  DAY_BLOCKS,
  formatApr,
  formatCompact,
  formatDur,
  formatDurLong,
  formatMarketAmount,
  formatNumber,
  isOracleRefreshingOnly,
  kindLabel,
  lineAt,
  liquidationPrice,
  pricingName,
  resolvedAskQuote,
  SHARES_UNITS
} from "@/utils/zcMath";

const props = defineProps<{
  ask: ZcAskSummary;
  curves: ZcCurves | null;
  height: number;
  oraclePrice: number;
  oracleAge: number;
  unit: ZcDurationUnit;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "preview", payload: ExecutionPreviewPayload): void;
}>();

const tab = ref<"quote" | "path" | "risk">("quote");
const shockPct = ref(0);
const copied = ref(false);
const windowPickBlocks = ref<number | null>(null);

watch(
  () => props.ask.id,
  () => {
    tab.value = "quote";
    shockPct.value = 0;
    windowPickBlocks.value = null;
  }
);

const isWindow = computed(() => props.ask.pricing === "window" && !!props.ask.window);
const activeQuote = computed(() =>
  resolvedAskQuote(props.ask, props.height, isWindow.value ? windowPickBlocks.value : null)
);

const currentWindowBlocks = computed(() => {
  if (!props.ask.window) return 0;
  return windowPickBlocks.value ?? activeQuote.value?.d ?? props.ask.window.min;
});

const collateral = computed(() => props.ask.bond?.collateral || props.ask.collateral);
const repayment = computed(() => props.ask.bond?.repayment ?? props.ask.repayment ?? activeQuote.value?.face ?? 0);
const rule = computed(() => props.ask.bond?.rule || props.ask.rule);
const ratio = computed(() => props.ask.bond?.ratio ?? props.ask.ratio);
const maxOracleAge = computed(() => props.ask.bond?.oracleAge ?? props.ask.oracleAge ?? 60);
const cov = computed(() => {
  if (props.ask.cov != null) return props.ask.cov;
  if (rule.value === "oracle" && props.oraclePrice > 0 && repayment.value > 0) {
    return coverage(collateral.value, repayment.value, props.ask.market, props.oraclePrice);
  }
  return null;
});

const refreshing = computed(() => isOracleRefreshingOnly(props.ask));
const usable = computed(() => props.ask.ok || refreshing.value);

const liqInfo = computed(() =>
  rule.value === "oracle" && ratio.value != null && repayment.value > 0
    ? liquidationPrice(collateral.value, repayment.value, props.ask.market, ratio.value)
    : null
);

const liqDistancePct = computed(() => {
  if (!liqInfo.value?.price || !props.oraclePrice) return null;
  return Math.abs(props.oraclePrice / liqInfo.value.price - 1) * 100;
});

const shockedCover = computed(() => {
  if (rule.value !== "oracle" || !(props.oraclePrice > 0) || !(repayment.value > 0)) return null;
  return coverage(
    collateral.value,
    repayment.value,
    props.ask.market,
    props.oraclePrice * (1 + shockPct.value / 100)
  );
});

const termReturnPct = computed(() => {
  const q = activeQuote.value;
  if (!q || !(q.cost > 0)) return null;
  return (q.face / q.cost - 1) * 100;
});

/* Mini APR Path Chart (Window yield curve OR fill-later trajectory vs Best Bid) */
const pathData = computed(() => {
  const h = props.height;
  const bidLine = props.curves?.bidLine || [];
  const W = 280;
  const H = 132;
  const PAD = { l: 34, r: 10, t: 10, b: 22 };

  let mine: { x: number; y: number | null; raw: number }[] = [];
  let bid: { x: number; y: number | null }[] = [];

  if (isWindow.value && props.ask.window) {
    const { min, max } = props.ask.window;
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const d = min + ((max - min) * i) / steps;
      const q = askQuote(props.ask, h, d);
      const b = lineAt(bidLine, d);
      mine.push({ x: d / DAY_BLOCKS, y: q ? q.yieldBps / 100 : null, raw: d });
      bid.push({ x: d / DAY_BLOCKS, y: b != null ? b / 100 : null });
    }
  } else {
    const matAt = (at: number) =>
      props.ask.kind === "order"
        ? props.ask.mode === "term"
          ? at + (props.ask.duration || DAY_BLOCKS)
          : props.ask.maturity
        : props.ask.bond?.maturity ?? props.ask.quote?.maturity;
    const end = Math.max(h + 30, Math.min((props.ask.expiry || h + 5040) - 1, (matAt(h) || h + 5040) - 4));
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const at = h + ((end - h) * i) / steps;
      const q = askQuote(props.ask, at);
      const rem = (matAt(at) || at) - at;
      const b = lineAt(bidLine, rem);
      mine.push({ x: (at - h) / DAY_BLOCKS, y: q ? q.yieldBps / 100 : null, raw: at });
      bid.push({ x: (at - h) / DAY_BLOCKS, y: b != null ? b / 100 : null });
    }
  }

  const allY = [...mine, ...bid].map((p) => p.y).filter((v): v is number => v != null && Number.isFinite(v));
  const yMax = Math.max(8, ...(allY.length ? allY : [10])) * 1.18;
  const xMin = mine[0]?.x ?? 0;
  const xMax = Math.max(xMin + 0.5, mine[mine.length - 1]?.x ?? 1);

  const sx = (v: number) => PAD.l + ((v - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
  const sy = (v: number) => PAD.t + (1 - Math.min(yMax, Math.max(0, v)) / yMax) * (H - PAD.t - PAD.b);

  const mkPath = (pts: { x: number; y: number | null }[]) => {
    let d = "";
    let open = false;
    for (const p of pts) {
      if (p.y == null) {
        open = false;
        continue;
      }
      d += `${open ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
      open = true;
    }
    return d;
  };

  const crossIdx = mine.findIndex((p, idx) => p.y != null && bid[idx]?.y != null && p.y >= (bid[idx].y as number));
  const cross = crossIdx >= 0 ? mine[crossIdx] : null;

  return {
    W,
    H,
    PAD,
    yMax,
    xMin,
    xMax,
    sx,
    sy,
    minePath: mkPath(mine),
    bidPath: mkPath(bid),
    cross
  };
});

async function copyId() {
  try {
    await navigator.clipboard.writeText(props.ask.id);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // ignore
  }
}

function openPreview() {
  const q = activeQuote.value;
  if (!q) return;
  const m = props.ask.market;
  emit("preview", {
    title: props.ask.kind === "order" ? `Fund ${m} Borrow Order` : `Buy ${kindLabel(props.ask.kind)} (${m})`,
    subtitle: `${pricingName(props.ask)} · ${shortenString(props.ask.id, 14)}`,
    badge: props.ask.kind === "order" ? "Direct Lend" : "Secondary Buy",
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
      {
        label: "Collateral cover",
        value:
          rule.value === "oracle"
            ? `${cov.value != null ? Math.round(cov.value) : "—"}% (liq. < ${ratio.value ?? "—"}%)`
            : "Maturity rule"
      },
      ...(props.ask.kind === "order"
        ? [{ label: "Liquidation fee reserve", value: "0.05 ERG (returned on settlement)" }]
        : [])
    ],
    rawSummary: {
      action: props.ask.kind === "order" ? "fillOrder" : "buyAsk",
      boxId: props.ask.id,
      market: m,
      cost: q.cost,
      face: q.face,
      yieldBps: Math.round(q.yieldBps),
      blocksLeft: q.d,
      maturity: q.maturity
    }
  });
}
</script>

<template>
  <aside class="sf-plate flex h-full flex-col overflow-hidden rounded-2xl" aria-label="Ask Inspector">
    <!-- Header -->
    <div class="border-b border-[color:var(--sf-line)] px-4 py-3.5">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="sf-mono rounded bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-ask)]"
            >
              {{ kindLabel(ask.kind) }} · {{ ask.market }}
            </span>
            <span
              class="sf-mono rounded px-1.5 py-0.5 text-[10px] font-semibold"
              :class="
                ask.owner
                  ? 'bg-cobalt-50 text-cobalt-700'
                  : ask.ok
                    ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                    : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
              "
            >
              {{ ask.pending ? "Pending" : ask.owner ? "Yours" : ask.ok ? "Tradable" : ask.reason }}
            </span>
          </div>

          <div class="mt-1.5 flex items-center gap-1.5">
            <span class="truncate text-[12.5px] font-medium text-[color:var(--sf-ink)]">
              {{ pricingName(ask) }}
            </span>
            <button
              type="button"
              class="sf-mono inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
              :title="`Copy box ID ${ask.id}`"
              @click="copyId"
            >
              <span>{{ shortenString(ask.id, 10) }}</span>
              <check-icon v-if="copied" class="h-3 w-3 text-[color:var(--sf-bid)]" />
              <copy-icon v-else class="h-3 w-3 opacity-70" />
            </button>
          </div>
        </div>

        <button
          type="button"
          class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
          aria-label="Close inspector"
          title="Back to Order Ticket"
          @click="emit('close')"
        >
          <x-icon class="h-4 w-4" />
        </button>
      </div>

      <!-- Inspector Sub-Tabs -->
      <div
        class="mt-3 grid grid-cols-3 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5 text-[11.5px]"
      >
        <button
          v-for="t in (['quote', 'path', 'risk'] as const)"
          :key="t"
          type="button"
          class="relative rounded-md py-1 font-semibold capitalize transition-all"
          :class="
            tab === t
              ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
              : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="tab = t"
        >
          {{ t === "path" ? "APR Path" : t }}
          <span
            v-if="t === 'risk' && !ask.ok"
            class="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--sf-ask)] align-middle"
          />
        </button>
      </div>
    </div>

    <!-- Body -->
    <div class="sf-scroll flex-1 overflow-y-auto px-4 py-3.5">
      <!-- TAB 1: QUOTE -->
      <div v-if="tab === 'quote'" class="space-y-3.5">
        <div
          class="grid grid-cols-2 divide-x divide-[color:var(--sf-line)] rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)]"
        >
          <div class="p-3">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              {{ isWindow && windowPickBlocks == null ? "Best APR" : "APR now" }}
            </div>
            <div class="sf-serif mt-0.5 text-[24px] font-semibold leading-tight text-[color:var(--sf-bid)]">
              {{ formatApr(activeQuote?.yieldBps) }}
            </div>
            <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
              {{ termReturnPct != null ? `${termReturnPct.toFixed(2)}% term` : "—" }}
            </div>
          </div>

          <div class="p-3">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              {{ ask.kind === "order" ? "Fund now" : "Pay now" }}
            </div>
            <div class="sf-mono mt-0.5 text-[18px] font-semibold leading-tight text-[color:var(--sf-ink)]">
              {{ activeQuote ? formatCompact(activeQuote.cost) : "—" }}
              <span class="text-[11px] font-medium text-[color:var(--sf-muted)]">{{ ask.market }}</span>
            </div>
            <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
              {{ activeQuote ? `${activeQuote.pct.toFixed(2)}% of face` : "" }}
            </div>
          </div>
        </div>

        <!-- Window Maturity Interactive Slider -->
        <div
          v-if="isWindow && ask.window"
          class="rounded-xl border border-cobalt-600/25 bg-cobalt-50/45 p-3"
        >
          <div class="flex items-center justify-between text-[11px]">
            <span class="sf-mono font-semibold uppercase tracking-[0.08em] text-cobalt-700">
              Pick maturity
            </span>
            <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              {{ formatDur(currentWindowBlocks, unit) }}
            </span>
          </div>
          <input
            type="range"
            :min="ask.window.min"
            :max="ask.window.max"
            :step="DAY_BLOCKS"
            :value="currentWindowBlocks"
            aria-label="Pick window order maturity"
            class="sf-range mt-2"
            @input="windowPickBlocks = Number(($event.target as HTMLInputElement).value)"
          />
          <div class="sf-mono mt-1 flex justify-between text-[10px] text-[color:var(--sf-muted)]">
            <span>{{ formatDur(ask.window.min, unit) }}</span>
            <span>{{ formatDur(ask.window.max, unit) }}</span>
          </div>
        </div>

        <!-- Terms Rows -->
        <dl class="divide-y divide-[color:var(--sf-line)] text-[12px]">
          <div class="flex justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">Claim if repaid</dt>
            <dd class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              {{ activeQuote ? formatMarketAmount(activeQuote.face, ask.market) : "—" }}
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">Gain before fees</dt>
            <dd class="sf-mono font-semibold text-[color:var(--sf-bid)]">
              {{
                activeQuote
                  ? `+${formatMarketAmount(activeQuote.face - activeQuote.cost, ask.market)}`
                  : "—"
              }}
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">Matures</dt>
            <dd class="sf-mono text-right font-medium text-[color:var(--sf-ink)]">
              <template v-if="isWindow && ask.window && windowPickBlocks == null">
                {{ formatDur(ask.window.min, unit) }}–{{ formatDur(ask.window.max, unit) }}
              </template>
              <template v-else-if="ask.kind === 'order' && ask.mode === 'term'">
                {{ formatDur(ask.duration, unit) }} from fill
              </template>
              <template v-else-if="activeQuote">
                {{ dateAtHeight(height + activeQuote.d, height) }} · {{ formatDur(activeQuote.d, unit) }}
              </template>
              <template v-else>—</template>
            </dd>
          </div>
          <div v-if="ask.kind === 'shares'" class="flex justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">Share lot</dt>
            <dd class="sf-mono font-medium text-[color:var(--sf-ink)]">
              {{ formatNumber((ask.units / SHARES_UNITS) * 100, 2, 0) }} / 100 shares
            </dd>
          </div>
          <div v-if="ask.kind === 'order'" class="flex justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">Fee reserve</dt>
            <dd class="sf-mono text-[color:var(--sf-ink-2)]">0.05 ERG, returned</dd>
          </div>
        </dl>

        <!-- Quick Safety Banner -->
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-3 py-2.5 text-left text-[11.5px] transition-colors hover:border-[color:var(--sf-line-strong)]"
          @click="tab = 'risk'"
        >
          <span class="flex items-center gap-2 text-[color:var(--sf-ink-2)]">
            <shield-icon class="h-3.5 w-3.5 shrink-0 text-cobalt-600" />
            <span>
              {{
                rule === "oracle"
                  ? `${cov != null ? Math.round(cov) : "—"}% cover · liq < ${ratio ?? "—"}%`
                  : "Maturity rule · no early trigger"
              }}
            </span>
          </span>
          <span
            class="sf-mono shrink-0 text-[10.5px] font-semibold"
            :class="ask.ok ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ask)]'"
          >
            {{ !ask.ok ? "Paused" : ask.guard ? "Guarded" : "Inspect" }}
          </span>
        </button>
      </div>

      <!-- TAB 2: APR PATH -->
      <div v-else-if="tab === 'path'" class="space-y-3">
        <div class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] p-2.5">
          <svg
            :viewBox="`0 0 ${pathData.W} ${pathData.H}`"
            class="h-[136px] w-full"
            role="img"
            :aria-label="isWindow ? 'Window APR curve' : 'APR if filled later'"
          >
            <g v-for="frac in [0, 0.5, 1]" :key="frac">
              <line
                :x1="pathData.PAD.l"
                :x2="pathData.W - pathData.PAD.r"
                :y1="pathData.sy(pathData.yMax * frac)"
                :y2="pathData.sy(pathData.yMax * frac)"
                stroke="var(--sf-line)"
                :stroke-dasharray="frac === 0 ? undefined : '2 3'"
              />
              <text
                :x="pathData.PAD.l - 5"
                :y="pathData.sy(pathData.yMax * frac) + 3"
                text-anchor="end"
                fill="var(--sf-muted)"
                font-size="9"
                class="sf-mono"
              >
                {{ (pathData.yMax * frac).toFixed(0) }}%
              </text>
            </g>

            <text
              :x="pathData.PAD.l"
              :y="pathData.H - 5"
              fill="var(--sf-muted)"
              font-size="9"
              class="sf-mono"
            >
              {{ isWindow ? `${Math.round(pathData.xMin)}d` : "now" }}
            </text>
            <text
              :x="pathData.W - pathData.PAD.r"
              :y="pathData.H - 5"
              text-anchor="end"
              fill="var(--sf-muted)"
              font-size="9"
              class="sf-mono"
            >
              {{ `${Math.round(pathData.xMax)}d` }}
            </text>

            <path
              v-if="pathData.bidPath"
              :d="pathData.bidPath"
              fill="none"
              stroke="var(--sf-bid)"
              stroke-width="1.5"
              stroke-dasharray="4 3"
            />
            <path
              v-if="pathData.minePath"
              :d="pathData.minePath"
              fill="none"
              stroke="var(--sf-ask)"
              stroke-width="2.2"
              stroke-linecap="round"
            />

            <line
              v-if="!isWindow && pathData.cross"
              :x1="pathData.sx(pathData.cross.x)"
              :x2="pathData.sx(pathData.cross.x)"
              :y1="pathData.PAD.t"
              :y2="pathData.H - pathData.PAD.b"
              stroke="var(--sf-bid)"
              stroke-dasharray="2 3"
            />
          </svg>
        </div>

        <div class="flex items-center gap-4 text-[11px] text-[color:var(--sf-muted)]">
          <span class="inline-flex items-center gap-1.5">
            <span class="h-0.5 w-3 bg-[color:var(--sf-ask)]" />
            <span>{{ isWindow ? "Curve by maturity" : "This ask" }}</span>
          </span>
          <span class="inline-flex items-center gap-1.5">
            <span class="h-0.5 w-3 border-t border-dashed border-[color:var(--sf-bid)]" />
            <span>Best bid today</span>
          </span>
        </div>

        <p class="text-[12px] leading-relaxed text-[color:var(--sf-ink-2)]">
          <template v-if="isWindow">
            Variable-maturity order pays the APR along its curve at the maturity you pick, capped at
            {{ formatApr(ask.cap) }}.
          </template>
          <template v-else-if="pathData.cross">
            {{
              pathData.cross.x === 0
                ? "Clears today's best bid now — a standing lend offer can match it on the next batch."
                : `Reaches today's best bid in ${formatDurLong(pathData.cross.raw - height, unit)} if bids hold steady.`
            }}
          </template>
          <template v-else>
            Does not cross today's best bid before expiry; a direct lender can still fund it at its
            quote.
          </template>
        </p>
      </div>

      <!-- TAB 3: RISK & SHOCK SIMULATOR -->
      <div v-else class="space-y-3.5">
        <dl class="divide-y divide-[color:var(--sf-line)] text-[12px]">
          <div class="flex items-center justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">Cover now</dt>
            <dd>
              <cover-meter :value="cov" :ratio="ratio" :guard="ask.guard?.ratio" compact />
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">Liquidates if</dt>
            <dd class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              <template v-if="!liqInfo">Unpaid at maturity</template>
              <template v-else-if="liqInfo.price == null">
                {{ liqInfo.dir === "never" ? "Price cannot trigger" : "Now" }}
              </template>
              <template v-else>
                ERG {{ liqInfo.dir === "below" ? "<" : ">" }} ${{ liqInfo.price.toFixed(3) }}
              </template>
            </dd>
          </div>
          <div v-if="liqDistancePct != null" class="flex justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">Price buffer</dt>
            <dd
              class="sf-mono font-semibold"
              :class="liqDistancePct < 12 ? 'text-[color:var(--sf-ask)]' : 'text-[color:var(--sf-bid)]'"
            >
              {{ liqDistancePct.toFixed(1) }}%
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">
              {{ ask.kind === "order" ? "Fill guard" : "Sale guard" }}
            </dt>
            <dd class="sf-mono text-[color:var(--sf-ink-2)]">
              {{ ask.guard ? `≥ ${ask.guard.ratio}% · ≤ ${ask.guard.age} blk` : "None" }}
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-2">
            <dt class="text-[color:var(--sf-muted)]">Oracle age</dt>
            <dd
              class="sf-mono"
              :class="oracleAge > maxOracleAge ? 'font-semibold text-[color:var(--sf-ask)]' : 'text-[color:var(--sf-ink-2)]'"
            >
              {{ oracleAge }} / {{ maxOracleAge }} blk
            </dd>
          </div>
        </dl>

        <!-- Interactive ERG Price Shock Simulator -->
        <div
          v-if="rule === 'oracle' && oraclePrice > 0 && shockedCover != null"
          class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] p-3"
        >
          <div class="flex items-center justify-between text-[11px]">
            <span class="font-medium text-[color:var(--sf-ink-2)]">ERG price shock</span>
            <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              {{ shockPct > 0 ? "+" : "" }}{{ shockPct }}% · ${{
                (oraclePrice * (1 + shockPct / 100)).toFixed(3)
              }}
            </span>
          </div>
          <input
            v-model.number="shockPct"
            type="range"
            min="-50"
            max="50"
            step="5"
            aria-label="ERG price shock simulation"
            class="sf-range mt-2"
          />
          <div class="mt-2 flex items-center justify-between text-[11.5px]">
            <span class="text-[color:var(--sf-muted)]">Scenario cover</span>
            <span
              class="sf-mono font-semibold"
              :class="
                ratio != null && shockedCover < ratio
                  ? 'text-[color:var(--sf-danger)]'
                  : ratio != null && shockedCover < ratio * 1.12
                    ? 'text-[color:var(--sf-ask)]'
                    : 'text-[color:var(--sf-bid)]'
              "
            >
              {{ Math.round(shockedCover) }}%{{
                ratio != null && shockedCover < ratio ? " · liquidatable" : ""
              }}
            </span>
          </div>
        </div>

        <!-- Locked Collateral Breakdown -->
        <div class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] p-3">
          <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Locked collateral
          </div>
          <div class="sf-mono mt-1.5 space-y-1 text-[11.5px] text-[color:var(--sf-ink)]">
            <div v-if="collateral.erg > 0.0011" class="flex justify-between">
              <span>ERG</span>
              <span class="font-semibold">{{ formatNumber(collateral.erg, 3, 0) }} ERG</span>
            </div>
            <div v-if="collateral.usd > 0" class="flex justify-between">
              <span>SigUSD</span>
              <span class="font-semibold">{{ formatNumber(collateral.usd, 2, 2) }} SigUSD</span>
            </div>
            <div v-for="tok in collateral.tokens" :key="tok.id" class="flex justify-between">
              <span class="truncate">{{ tok.ticker }}</span>
              <span class="font-semibold">{{ formatNumber(tok.amount, 2, 0) }}</span>
            </div>
            <div
              v-if="collateral.erg <= 0.0011 && collateral.usd <= 0 && !collateral.tokens.length"
              class="text-[color:var(--sf-dim)]"
            >
              Box reserve only
            </div>
          </div>
        </div>

        <!-- On-chain Checks -->
        <div v-if="ask.checks.length" class="space-y-1">
          <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Contract verification
          </div>
          <div
            v-for="chk in ask.checks"
            :key="chk.key"
            class="flex items-center gap-2 text-[11.5px]"
            :class="chk.ok ? 'text-[color:var(--sf-ink-2)]' : 'text-[color:var(--sf-ask)]'"
          >
            <check-circle-icon
              class="h-3.5 w-3.5 shrink-0"
              :class="chk.ok ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ask)]'"
            />
            <span class="truncate">{{ chk.detail }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Action Footer -->
    <div class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] p-4">
      <button
        type="button"
        :disabled="!usable || !activeQuote"
        class="sf-btn-primary flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-45"
        @click="openPreview"
      >
        <span>
          {{
            usable && activeQuote
              ? `Preview ${ask.kind === "order" ? "Fund" : "Buy"} · ${formatMarketAmount(
                  activeQuote.cost,
                  ask.market
                )}`
              : ask.reason || "Unavailable"
          }}
        </span>
        <arrow-right-icon v-if="usable" class="h-3.5 w-3.5" />
      </button>
    </div>
  </aside>
</template>
