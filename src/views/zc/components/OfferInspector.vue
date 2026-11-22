<script setup lang="ts">
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  XIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { zcApi } from "@/services/zcApi";
import { ZcDurationUnit, ZcMatchBuy, ZcOfferSummary } from "@/types/zc";
import { shortenString } from "@/utils";
import {
  dateAtHeight,
  DAY_BLOCKS,
  formatApr,
  formatCompact,
  formatDur,
  formatNumber,
  isHex64,
  isOracleRefreshingOnly,
  MIN_MATURITY_BLOCKS,
  offerYieldAt
} from "@/utils/zcMath";

const props = defineProps<{
  offer: ZcOfferSummary;
  height: number;
  targetBlocks: number;
  upto: boolean;
  unit: ZcDurationUnit;
  connected: boolean;
  revision: number;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "borrow-against", params: { aprPct: number; days: number }): void;
}>();

const copied = ref(false);
const buys = ref<ZcMatchBuy[]>([]);
const hoverDays = ref<number | null>(null);

let matchAc: AbortController | null = null;

async function fetchMatches() {
  if (matchAc) matchAc.abort();
  if (!props.connected || !isHex64(props.offer.id)) {
    buys.value = [];
    return;
  }
  const ac = new AbortController();
  matchAc = ac;
  try {
    const res = await zcApi.getMatches(props.offer.id, ac.signal);
    if (!ac.signal.aborted) {
      buys.value = res?.buys || res?.matches || [];
    }
  } catch {
    if (!ac.signal.aborted) buys.value = [];
  }
}

watch([() => props.offer.id, () => props.connected, () => props.revision], () => {
  void fetchMatches();
}, { immediate: true });

onBeforeUnmount(() => matchAc?.abort());

const usable = computed(() => props.offer.ok || isOracleRefreshingOnly(props.offer));

const requiredBps = computed(() => {
  if (!props.upto) return offerYieldAt(props.offer, props.targetBlocks);
  const a0 = Math.max(MIN_MATURITY_BLOCKS, props.offer.minBlocks);
  const a1 = Math.min(props.targetBlocks, props.offer.maxBlocks);
  if (a0 > a1) return null;
  let minY: number | null = null;
  const sampleDs = [
    a0,
    a1,
    ...props.offer.points.map((p) => p.d).filter((d) => d > a0 && d < a1)
  ];
  for (const d of sampleDs) {
    const y = offerYieldAt(props.offer, d);
    if (y != null && (minY == null || y < minY)) minY = y;
  }
  return minY;
});

/* Mini Offer Curve SVG */
const chartData = computed(() => {
  const W = 280;
  const H = 132;
  const PAD = { l: 34, r: 10, t: 10, b: 22 };
  const loD = props.offer.minBlocks;
  const hiD = Math.max(loD + DAY_BLOCKS, props.offer.maxBlocks);

  const pts = Array.from({ length: 36 }, (_, i) => {
    const d = loD + ((hiD - loD) * i) / 35;
    const y = offerYieldAt(props.offer, d) ?? props.offer.minYieldBps;
    return { d, x: d / DAY_BLOCKS, y: y / 100 };
  });

  const buyDots = buys.value
    .map((b) => ({
      d: Math.max(1, (b.maturity || props.height) - props.height),
      y: b.yieldBps / 100
    }))
    .filter((b) => b.d >= loD && b.d <= hiD);

  const ys = [...pts.map((p) => p.y), ...buyDots.map((b) => b.y)];
  const yMax = Math.max(8, ...ys) * 1.2;
  const xMin = loD / DAY_BLOCKS;
  const xMax = hiD / DAY_BLOCKS;

  const sx = (daysVal: number) => PAD.l + ((daysVal - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r);
  const sy = (apr: number) => PAD.t + (1 - Math.min(yMax, Math.max(0, apr)) / yMax) * (H - PAD.t - PAD.b);

  const lineD = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
    .join(" ");
  const areaD = `${lineD} L${sx(xMax).toFixed(1)},${(H - PAD.b).toFixed(1)} L${sx(xMin).toFixed(
    1
  )},${(H - PAD.b).toFixed(1)} Z`;

  return { W, H, PAD, xMin, xMax, yMax, sx, sy, lineD, areaD, buyDots };
});

const hoverInfo = computed(() => {
  if (hoverDays.value == null) return null;
  const blocks = Math.round(hoverDays.value * DAY_BLOCKS);
  const bps = offerYieldAt(props.offer, blocks);
  return { blocks, bps, x: chartData.value.sx(hoverDays.value) };
});

function onSvgMove(e: PointerEvent) {
  const el = e.currentTarget as SVGSVGElement;
  const r = el.getBoundingClientRect();
  const X = ((e.clientX - r.left) / (r.width || 1)) * chartData.value.W;
  const { PAD, W, xMin, xMax } = chartData.value;
  if (X >= PAD.l && X <= W - PAD.r) {
    hoverDays.value = xMin + ((X - PAD.l) / (W - PAD.l - PAD.r)) * (xMax - xMin);
  } else {
    hoverDays.value = null;
  }
}

async function copyId() {
  try {
    await navigator.clipboard.writeText(props.offer.id);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // ignore
  }
}

function handleBorrowAgainst() {
  const targetD = Math.min(
    props.offer.maxBlocks,
    Math.max(props.offer.minBlocks, props.targetBlocks)
  );
  const yBps = (offerYieldAt(props.offer, targetD) ?? props.offer.minYieldBps) + 1;
  emit("borrow-against", {
    aprPct: Number((yBps / 100).toFixed(2)),
    days: Math.max(1, Math.round(targetD / DAY_BLOCKS))
  });
}
</script>

<template>
  <aside class="sf-plate flex h-full flex-col overflow-hidden rounded-2xl" aria-label="Lend Offer Inspector">
    <!-- Header -->
    <div class="border-b border-[color:var(--sf-line)] px-4 py-3.5">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="sf-mono rounded bg-[color:var(--sf-bid-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-bid)]"
            >
              Lend Offer · {{ offer.market }}
            </span>
            <span
              class="sf-mono rounded px-1.5 py-0.5 text-[10px] font-semibold"
              :class="
                offer.owner
                  ? 'bg-cobalt-50 text-cobalt-700'
                  : offer.ok
                    ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                    : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
              "
            >
              {{ offer.pending ? "Pending" : offer.owner ? "Yours" : offer.ok ? "Bidding" : offer.reason }}
            </span>
          </div>

          <div class="mt-1.5 flex items-center gap-1.5">
            <span class="truncate text-[12.5px] font-medium text-[color:var(--sf-ink)]">
              {{ offer.delivery === "unit" ? "Buys bond units" : `Delivers ${offer.delivery} shares` }}
            </span>
            <button
              type="button"
              class="sf-mono inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
              :title="`Copy offer ID ${offer.id}`"
              @click="copyId"
            >
              <span>{{ shortenString(offer.id, 10) }}</span>
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
    </div>

    <!-- Body -->
    <div class="sf-scroll flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
      <!-- Headline Figures -->
      <div
        class="grid grid-cols-2 divide-x divide-[color:var(--sf-line)] rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)]"
      >
        <div class="p-3">
          <div class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            {{ upto ? `From (≤ ${formatDur(targetBlocks, unit)})` : `At ${formatDur(targetBlocks, unit)}` }}
          </div>
          <div class="sf-serif mt-0.5 text-[24px] font-semibold leading-tight text-[color:var(--sf-bid)]">
            {{ formatApr(requiredBps) }}
          </div>
          <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
            {{ requiredBps == null ? "Outside range" : `floor ${formatApr(offer.minYieldBps)}` }}
          </div>
        </div>

        <div class="p-3">
          <div class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            Capital
          </div>
          <div class="sf-mono mt-0.5 text-[18px] font-semibold leading-tight text-[color:var(--sf-ink)]">
            {{ formatCompact(offer.capital) }}
            <span class="text-[11px] font-medium text-[color:var(--sf-muted)]">{{ offer.market }}</span>
          </div>
          <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
            {{ buys.length }} {{ buys.length === 1 ? "ask" : "asks" }} clear now
          </div>
        </div>
      </div>

      <!-- Mini Rolling Yield Curve -->
      <div class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] p-2.5">
        <div class="mb-1 flex items-center justify-between text-[10.5px]">
          <span class="sf-mono uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            Rolling curve · {{ offer.points.length }} pts
          </span>
          <span v-if="hoverInfo" class="sf-mono font-semibold text-[color:var(--sf-bid)]">
            {{ formatDur(hoverInfo.blocks, unit) }} → {{ formatApr(hoverInfo.bps) }}
          </span>
        </div>

        <svg
          :viewBox="`0 0 ${chartData.W} ${chartData.H}`"
          class="h-[132px] w-full cursor-crosshair select-none"
          role="img"
          aria-label="Offer rolling yield curve"
          @pointermove="onSvgMove"
          @pointerleave="hoverDays = null"
        >
          <defs>
            <linearGradient id="sfOfferFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--sf-bid)" stop-opacity="0.18" />
              <stop offset="100%" stop-color="var(--sf-bid)" stop-opacity="0" />
            </linearGradient>
          </defs>

          <g v-for="frac in [0, 0.5, 1]" :key="frac">
            <line
              :x1="chartData.PAD.l"
              :x2="chartData.W - chartData.PAD.r"
              :y1="chartData.sy(chartData.yMax * frac)"
              :y2="chartData.sy(chartData.yMax * frac)"
              stroke="var(--sf-line)"
              :stroke-dasharray="frac === 0 ? undefined : '2 3'"
            />
            <text
              :x="chartData.PAD.l - 5"
              :y="chartData.sy(chartData.yMax * frac) + 3"
              text-anchor="end"
              fill="var(--sf-muted)"
              font-size="9"
              class="sf-mono"
            >
              {{ (chartData.yMax * frac).toFixed(0) }}%
            </text>
          </g>

          <text :x="chartData.PAD.l" :y="chartData.H - 5" fill="var(--sf-muted)" font-size="9" class="sf-mono">
            {{ formatDur(offer.minBlocks, unit) }}
          </text>
          <text
            :x="chartData.W - chartData.PAD.r"
            :y="chartData.H - 5"
            text-anchor="end"
            fill="var(--sf-muted)"
            font-size="9"
            class="sf-mono"
          >
            {{ formatDur(offer.maxBlocks, unit) }}
          </text>

          <path :d="chartData.areaD" fill="url(#sfOfferFill)" />
          <path
            :d="chartData.lineD"
            fill="none"
            stroke="var(--sf-bid)"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <circle
            v-for="(dot, i) in chartData.buyDots"
            :key="i"
            :cx="chartData.sx(dot.d / DAY_BLOCKS)"
            :cy="chartData.sy(dot.y)"
            r="2.8"
            fill="var(--sf-ask)"
            stroke="var(--sf-card)"
            stroke-width="1.2"
          />

          <line
            v-if="hoverInfo"
            :x1="hoverInfo.x"
            :x2="hoverInfo.x"
            :y1="chartData.PAD.t"
            :y2="chartData.H - chartData.PAD.b"
            stroke="var(--sf-line-strong)"
            stroke-dasharray="2 3"
          />
        </svg>
      </div>

      <!-- Terms -->
      <dl class="divide-y divide-[color:var(--sf-line)] text-[12px]">
        <div class="flex justify-between gap-2 py-2">
          <dt class="text-[color:var(--sf-muted)]">Maturities</dt>
          <dd class="sf-mono font-medium text-[color:var(--sf-ink)]">
            {{ formatDur(offer.minBlocks, unit) }} – {{ formatDur(offer.maxBlocks, unit) }}
          </dd>
        </div>
        <div class="flex justify-between gap-2 py-2">
          <dt class="text-[color:var(--sf-muted)]">Cover floor</dt>
          <dd class="sf-mono font-semibold text-[color:var(--sf-ink)]">
            ≥ {{ offer.floor }}% · oracle
          </dd>
        </div>
        <div class="flex justify-between gap-2 py-2">
          <dt class="text-[color:var(--sf-muted)]">Also buys shares</dt>
          <dd class="sf-mono text-[color:var(--sf-ink-2)]">
            {{
              offer.shares
                ? `≥ ${(offer.shares.floor / 100).toFixed(0)}% · ≤ ${formatNumber(
                    offer.shares.expiry,
                    0,
                    0
                  )} blk`
                : "No"
            }}
          </dd>
        </div>
        <div class="flex justify-between gap-2 py-2">
          <dt class="text-[color:var(--sf-muted)]">
            {{ offer.market === "ERG" ? "Batcher fee" : "Refund fee" }}
          </dt>
          <dd class="sf-mono text-[color:var(--sf-ink-2)]">
            {{ offer.fee }} ERG
            <template v-if="offer.tokenBudget?.rewardBudget != null">
              · {{ formatNumber(offer.tokenBudget.rewardBudget, 3, 0) }} budget
            </template>
          </dd>
        </div>
        <div class="flex justify-between gap-2 py-2">
          <dt class="text-[color:var(--sf-muted)]">Expires</dt>
          <dd class="sf-mono text-[color:var(--sf-ink-2)]">
            {{ dateAtHeight(offer.expiry, height) }} ·
            {{ formatDur(Math.max(0, offer.expiry - height), unit) }}
          </dd>
        </div>
      </dl>

      <!-- Checks -->
      <div v-if="offer.checks.length" class="space-y-1">
        <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
          Contract verification
        </div>
        <div
          v-for="chk in offer.checks"
          :key="chk.key"
          class="flex items-center gap-2 text-[11.5px] text-[color:var(--sf-ink-2)]"
        >
          <check-circle-icon
            class="h-3.5 w-3.5 shrink-0"
            :class="chk.ok ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ask)]'"
          />
          <span class="truncate">{{ chk.detail }}</span>
        </div>
      </div>
    </div>

    <!-- Action Footer -->
    <div class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] p-4">
      <button
        type="button"
        :disabled="!usable"
        class="sf-btn-primary flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-45"
        @click="handleBorrowAgainst"
      >
        <span>Match with Borrow Ticket</span>
        <arrow-right-icon class="h-3.5 w-3.5" />
      </button>
    </div>
  </aside>
</template>
