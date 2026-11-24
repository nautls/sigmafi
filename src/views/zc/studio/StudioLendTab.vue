<script setup lang="ts">
import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SlidersIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ExecutionPreviewPayload } from "../components/ExecutionPreviewModal.vue";
import ZcCurveEditor, { CurveMarketOverlay } from "../components/ZcCurveEditor.vue";
import ZcDurInput from "../components/ZcDurInput.vue";
import ZcFullYieldCurveCompare, { FullCurveOverlay } from "../components/ZcFullYieldCurveCompare.vue";
import { buildOfferBody, zcApi } from "@/services/zcApi";
import { useWalletStore, useZcStore } from "@/stories";
import { ZcChartMetric, ZcSimulateResponse } from "@/types/zc";
import {
  combinedAskLine,
  dateAtHeight,
  DAY_BLOCKS,
  fixedAskDots,
  formatApr,
  formatDur,
  formatMarketAmount,
  formatNumber,
  MIN_MATURITY_BLOCKS,
  shapeCurve,
  spreadCurve,
  windowAskLine,
  ZcSimpleCurvePoint
} from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    initialAmount?: number | null;
    initialApr?: number | null;
    initialDays?: number | null;
  }>(),
  {
    initialAmount: null,
    initialApr: null,
    initialDays: null
  }
);

const emit = defineEmits<{
  (e: "preview", payload: ExecutionPreviewPayload): void;
}>();

const zc = useZcStore();
const wallet = useWalletStore();

const market = computed(() => zc.activeMarket);
const snap = computed(() => zc.activeSnapshot);
const height = computed(() => zc.height);
const unit = computed(() => zc.durationUnit);

const chartTab = ref<"edit" | "full">("edit");
const metric = ref<ZcChartMetric>("yield");

const capitalText = ref(props.initialAmount ? String(props.initialAmount) : "500");
const minDays = ref<number | null>(7);
const maxDays = ref<number | null>(props.initialDays ?? 365);
const minAprText = ref(props.initialApr != null ? String(Math.max(0, props.initialApr - 1)) : "5");
const coverFloor = ref(150);

const acceptShares = ref(true);
const shareFloorText = ref("90");
const shareMaxDays = ref<number | null>(3);

const advancedOpen = ref(false);
const delivery = ref<"unit" | "selective" | "dutch">("unit");
const delOpeningText = ref("200");
const delFloorText = ref("90");
const delLengthDays = ref<number | null>(1);
const delExpiryDays = ref<number | null>(3);
const offerExpiryDays = ref<number | null>(30);
const feeText = ref("0.005");
const ergFundingText = ref("0.5");
const rewardBudgetText = ref("0.1");
const minFillPctText = ref("1");

const minBlocks = computed(() =>
  Math.max(MIN_MATURITY_BLOCKS, Math.round((minDays.value || 7) * DAY_BLOCKS))
);
const maxBlocks = computed(() =>
  Math.max(minBlocks.value + DAY_BLOCKS, Math.round((maxDays.value || 365) * DAY_BLOCKS))
);

const baseAprBps = computed(() => {
  const n = Number(minAprText.value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 500;
});

const points = ref<ZcSimpleCurvePoint[]>(
  shapeCurve(
    "normal",
    Math.round((props.initialApr ?? 8) * 100),
    5,
    7 * DAY_BLOCKS,
    (props.initialDays ?? 365) * DAY_BLOCKS
  )
);

watch([minBlocks, maxBlocks], ([lo, hi]) => {
  points.value = spreadCurve(points.value, Math.max(2, points.value.length), lo, hi);
});

const capitalNum = computed(() => {
  const n = Number(capitalText.value);
  return Number.isFinite(n) && n > 0 ? n : null;
});

const walletBalance = computed(() =>
  market.value === "ERG" ? zc.portfolio.walletErg : zc.portfolio.walletSigUsd
);

function setBalancePct(pct: number) {
  if (!(walletBalance.value > 0)) return;
  const reserve = market.value === "ERG" ? 0.1 : 0;
  const avail = Math.max(0, walletBalance.value - reserve);
  const v = avail * pct;
  capitalText.value = String(Number(v.toFixed(market.value === "ERG" ? 3 : 2)));
}

const expiryHeight = computed(
  () => height.value + Math.max(60, Math.round((offerExpiryDays.value || 30) * DAY_BLOCKS))
);

const sim = ref<ZcSimulateResponse | null>(null);
const simLoading = ref(false);

function buildDraft(useProbeCapital = false) {
  const cap = capitalNum.value ?? (useProbeCapital ? 200 : null);
  if (!cap) return null;
  return buildOfferBody({
    market: market.value,
    capital: cap,
    minYield: baseAprBps.value,
    points: points.value,
    minBlocks: minBlocks.value,
    maxBlocks: maxBlocks.value,
    floor: coverFloor.value,
    expiry: expiryHeight.value,
    fee: Number(feeText.value) || 0.005,
    shares: acceptShares.value
      ? {
          floor: Math.round((Number(shareFloorText.value) || 90) * 100),
          expiry: Math.max(60, Math.round((shareMaxDays.value || 3) * DAY_BLOCKS))
        }
      : null,
    delivery: delivery.value,
    deliveryAuction:
      delivery.value !== "unit"
        ? {
            opening: Number(delOpeningText.value) || 200,
            floor: Number(delFloorText.value) || 90,
            length: Math.max(30, Math.round((delLengthDays.value || 1) * DAY_BLOCKS)),
            expiry: Math.max(60, Math.round((delExpiryDays.value || 3) * DAY_BLOCKS))
          }
        : undefined,
    tokenBudget:
      market.value === "SigUSD"
        ? {
            refundFee: Number(feeText.value) || 0.005,
            ergFunding: Number(ergFundingText.value) || 0.5,
            rewardBudget: Number(rewardBudgetText.value) || 0.1,
            minFillBps: Math.max(10, Math.round((Number(minFillPctText.value) || 1) * 100))
          }
        : undefined
  });
}

let simTimer: number | null = null;
let simAc: AbortController | null = null;

const simDeps = computed(() =>
  JSON.stringify({
    m: market.value,
    c: capitalNum.value,
    my: baseAprBps.value,
    pts: points.value,
    lo: minBlocks.value,
    hi: maxBlocks.value,
    fl: coverFloor.value,
    sh: acceptShares.value ? [shareFloorText.value, shareMaxDays.value] : null,
    del: delivery.value,
    rev: zc.revision
  })
);

watch(
  simDeps,
  () => {
    if (simTimer !== null) window.clearTimeout(simTimer);
    if (simAc) simAc.abort();
    if (!zc.connected) {
      sim.value = null;
      return;
    }
    const body = buildDraft(true);
    if (!body) {
      sim.value = null;
      return;
    }
    simTimer = window.setTimeout(async () => {
      const ac = new AbortController();
      simAc = ac;
      simLoading.value = true;
      try {
        const res = await zcApi.simulate({ type: "offer", ...body }, ac.signal);
        if (!ac.signal.aborted) sim.value = res;
      } catch {
        if (!ac.signal.aborted) sim.value = null;
      } finally {
        if (!ac.signal.aborted) simLoading.value = false;
      }
    }, 220);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  if (simTimer !== null) window.clearTimeout(simTimer);
  simAc?.abort();
});

const hitIds = computed(() => {
  const s = new Set<string>();
  for (const m of sim.value?.matches || []) {
    if (m.counterpartyId) s.add(m.counterpartyId);
  }
  return s;
});

const askById = computed(() => new Map(snap.value.asks.map((a) => [a.id, a])));

const curveMarketOverlay = computed<CurveMarketOverlay>(() => {
  const rawDots = fixedAskDots(snap.value.curves);
  return {
    bidLine: snap.value.curves?.bidLine || [],
    askLine: windowAskLine(snap.value.curves, askById.value, height.value),
    askFit: combinedAskLine(snap.value.curves, askById.value, height.value),
    dots: rawDots.map((d) => ({ ...d, hit: hitIds.value.has(d.id) }))
  };
});

const fullOverlay = computed<FullCurveOverlay>(() => ({
  type: "curve",
  points: points.value,
  lo: minBlocks.value,
  hi: maxBlocks.value,
  floor: baseAprBps.value,
  face: capitalNum.value || 100,
  color: "var(--sf-cobalt)",
  label: "Your lend curve"
}));

const curveRangeLabel = computed(() => {
  const ys = points.value.map((p) => Math.max(p.y, baseAprBps.value));
  if (!ys.length) return "—";
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  return lo === hi ? formatApr(lo) : `${formatApr(lo)}–${formatApr(hi)}`;
});

const matchCount = computed(() => sim.value?.matches?.length ?? 0);

const checks = computed(() => {
  const list: { label: string; ok: boolean }[] = [];
  list.push({
    label: capitalNum.value && capitalNum.value > 0 ? "Capital funded" : "Enter capital amount",
    ok: !!(capitalNum.value && capitalNum.value > 0)
  });
  list.push({
    label: points.value.length >= 2 ? `${points.value.length}-point rolling curve` : "Need ≥ 2 curve points",
    ok: points.value.length >= 2
  });
  list.push({
    label: `Cover floor ≥ ${coverFloor.value}%`,
    ok: coverFloor.value >= 125
  });
  return list;
});

const canSubmit = computed(() => checks.value.every((c) => c.ok) && !!buildDraft(false));

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

function openPreview() {
  const body = buildDraft(false);
  if (!body) return;
  emit("preview", {
    title: "Post Rolling Lend Offer",
    subtitle: `${points.value.length}-point yield curve · ${market.value} market`,
    badge: `Lend Offer · ${market.value}`,
    tone: "bid",
    heroLabel: "Capital committed",
    heroValue: formatMarketAmount(capitalNum.value, market.value),
    heroSub: `${curveRangeLabel.value} · floor ${formatApr(baseAprBps.value)}`,
    rows: [
      {
        label: "Maturity window",
        value: `${formatDur(minBlocks.value, unit.value)} – ${formatDur(maxBlocks.value, unit.value)}`
      },
      {
        label: "Cover floor",
        value: `≥ ${coverFloor.value}%`
      },
      {
        label: "Delivery",
        value:
          delivery.value === "unit"
            ? "Bond units"
            : `${delivery.value === "selective" ? "Selective" : "Dutch"} shares (${delOpeningText.value}% → ${delFloorText.value}%)`
      },
      {
        label: "Share lots",
        value: acceptShares.value
          ? `Accepted (floor ≥ ${shareFloorText.value}%)`
          : "Bond units only"
      },
      {
        label: "Offer expires",
        value: `${formatDur(expiryHeight.value - height.value, unit.value)} (${dateAtHeight(expiryHeight.value, height.value)})`
      },
      {
        label: "Clears immediately",
        value:
          matchCount.value > 0
            ? `Takes ${matchCount.value} ask${matchCount.value === 1 ? "" : "s"} now`
            : "Rests on yield curve",
        tone: matchCount.value > 0 ? "bid" : "default"
      }
    ],
    rawSummary: { action: "createOffer", ...body },
    txAction: { type: "createOffer", body }
  });
}
</script>

<template>
  <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_348px]">
    <!-- LEFT WORKBENCH -->
    <div class="flex min-h-0 flex-col gap-2.5">
      <!-- Parameters Deck -->
      <section class="sf-terminal-plate shrink-0 rounded-[18px] rounded-tl-[6px] p-3">
        <div class="grid grid-cols-2 items-end gap-2 sm:grid-cols-3 lg:grid-cols-[0.8fr_0.8fr_0.8fr_1.6fr_auto]">
          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Shortest
            </label>
            <zc-dur-input v-model="minDays" :unit="unit" of="days" tone="bid" />
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Longest
            </label>
            <zc-dur-input v-model="maxDays" :unit="unit" of="days" tone="bid" />
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Min APR
            </label>
            <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2.5" data-tone="bid">
              <input
                v-model="minAprText"
                inputmode="decimal"
                placeholder="5.0"
                class="sf-mono w-full min-w-0 bg-transparent text-[13.5px] font-semibold text-[color:var(--sf-ink)] outline-none"
              />
              <span class="sf-mono text-[10.5px] font-semibold text-[color:var(--sf-muted)]">%</span>
            </div>
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Cover Floor
            </label>
            <div class="sf-seg w-full" role="tablist" aria-label="Minimum cover ratio">
              <button
                v-for="c in [125, 150, 175, 200, 250]"
                :key="c"
                type="button"
                class="sf-seg-btn flex-1 !h-[30px] !px-1.5 !text-[10.5px]"
                :class="coverFloor === c ? 'is-active tone-bid' : ''"
                @click="coverFloor = c"
              >
                {{ c }}%
              </button>
            </div>
          </div>

          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="sf-mono h-9 rounded-xl border px-2.5 text-[10.5px] font-semibold transition-all"
              :class="
                acceptShares
                  ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="acceptShares = !acceptShares"
            >
              Shares {{ acceptShares ? "On" : "Off" }}
            </button>

            <button
              type="button"
              class="sf-mono inline-flex h-9 items-center gap-1 rounded-xl border px-2.5 text-[10.5px] font-semibold transition-all"
              :class="
                advancedOpen
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="advancedOpen = !advancedOpen"
            >
              <sliders-icon class="h-3.5 w-3.5" />
              <span>Delivery</span>
              <chevron-up-icon v-if="advancedOpen" class="h-3 w-3" />
              <chevron-down-icon v-else class="h-3 w-3" />
            </button>
          </div>
        </div>

        <!-- Inline Share Lot Bounds (when Shares On) -->
        <div
          v-if="acceptShares"
          class="mt-2.5 flex flex-wrap items-center gap-3 border-t border-[color:var(--sf-line)] pt-2"
        >
          <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-bid)]">
            Share lot bounds
          </span>
          <div class="flex items-center gap-1.5">
            <span class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">Auction floor</span>
            <div class="sf-input-well flex h-7 w-[72px] items-center gap-0.5 rounded-lg px-2" data-tone="bid">
              <input
                v-model="shareFloorText"
                inputmode="decimal"
                class="sf-mono w-full min-w-0 bg-transparent text-right text-[11.5px] font-semibold text-[color:var(--sf-ink)] outline-none"
              />
              <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">%</span>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <span class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">Max auction</span>
            <div class="w-[100px]">
              <zc-dur-input v-model="shareMaxDays" :unit="unit" of="days" tone="bid" />
            </div>
          </div>
        </div>

        <!-- Collapsible Delivery, Expiry & Budget Drawer -->
        <div
          v-if="advancedOpen"
          class="mt-2.5 space-y-2.5 border-t border-[color:var(--sf-line)] pt-2.5"
        >
          <div class="flex flex-wrap items-end justify-between gap-2.5">
            <div>
              <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Delivery mode
              </label>
              <div class="sf-seg" role="tablist">
                <button
                  type="button"
                  class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
                  :class="delivery === 'unit' ? 'is-active tone-bid' : ''"
                  @click="delivery = 'unit'"
                >
                  Bond units
                </button>
                <button
                  type="button"
                  class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
                  :class="delivery === 'selective' ? 'is-active tone-bid' : ''"
                  @click="delivery = 'selective'"
                >
                  Selective shares
                </button>
                <button
                  type="button"
                  class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
                  :class="delivery === 'dutch' ? 'is-active tone-bid' : ''"
                  @click="delivery = 'dutch'"
                >
                  Dutch shares
                </button>
              </div>
            </div>

            <div class="flex flex-wrap items-end gap-2">
              <div class="w-[105px]">
                <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                  Offer expires
                </label>
                <zc-dur-input v-model="offerExpiryDays" :unit="unit" of="days" tone="cobalt" />
              </div>

              <div class="w-[105px]">
                <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                  {{ market === "ERG" ? "Batcher fee" : "Refund fee" }}
                </label>
                <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2" data-tone="cobalt">
                  <input
                    v-model="feeText"
                    inputmode="decimal"
                    class="sf-mono w-full min-w-0 bg-transparent text-[12px] font-semibold text-[color:var(--sf-ink)] outline-none"
                  />
                  <span class="sf-mono text-[9.5px] text-[color:var(--sf-muted)]">ERG</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="delivery !== 'unit'" class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <label class="sf-mono mb-1 block text-[9.5px] uppercase text-[color:var(--sf-muted)]">
                Opening %
              </label>
              <div class="sf-input-well flex h-8 items-center rounded-lg px-2" data-tone="bid">
                <input v-model="delOpeningText" inputmode="decimal" class="sf-mono w-full bg-transparent text-[12px] font-semibold text-[color:var(--sf-ink)] outline-none" />
              </div>
            </div>
            <div>
              <label class="sf-mono mb-1 block text-[9.5px] uppercase text-[color:var(--sf-muted)]">
                Floor %
              </label>
              <div class="sf-input-well flex h-8 items-center rounded-lg px-2" data-tone="bid">
                <input v-model="delFloorText" inputmode="decimal" class="sf-mono w-full bg-transparent text-[12px] font-semibold text-[color:var(--sf-ink)] outline-none" />
              </div>
            </div>
            <div>
              <label class="sf-mono mb-1 block text-[9.5px] uppercase text-[color:var(--sf-muted)]">
                Falls over
              </label>
              <zc-dur-input v-model="delLengthDays" :unit="unit" of="days" tone="bid" />
            </div>
            <div>
              <label class="sf-mono mb-1 block text-[9.5px] uppercase text-[color:var(--sf-muted)]">
                Held until
              </label>
              <zc-dur-input v-model="delExpiryDays" :unit="unit" of="days" tone="bid" />
            </div>
          </div>

          <div v-if="market === 'SigUSD'" class="grid grid-cols-3 gap-2">
            <div>
              <label class="sf-mono mb-1 block text-[9.5px] uppercase text-[color:var(--sf-muted)]">
                ERG funding
              </label>
              <div class="sf-input-well flex h-8 items-center gap-1 rounded-lg px-2" data-tone="cobalt">
                <input v-model="ergFundingText" inputmode="decimal" class="sf-mono w-full bg-transparent text-[12px] font-semibold text-[color:var(--sf-ink)] outline-none" />
                <span class="sf-mono text-[9.5px] text-[color:var(--sf-muted)]">ERG</span>
              </div>
            </div>
            <div>
              <label class="sf-mono mb-1 block text-[9.5px] uppercase text-[color:var(--sf-muted)]">
                Reward budget
              </label>
              <div class="sf-input-well flex h-8 items-center gap-1 rounded-lg px-2" data-tone="cobalt">
                <input v-model="rewardBudgetText" inputmode="decimal" class="sf-mono w-full bg-transparent text-[12px] font-semibold text-[color:var(--sf-ink)] outline-none" />
                <span class="sf-mono text-[9.5px] text-[color:var(--sf-muted)]">ERG</span>
              </div>
            </div>
            <div>
              <label class="sf-mono mb-1 block text-[9.5px] uppercase text-[color:var(--sf-muted)]">
                Smallest fill
              </label>
              <div class="sf-input-well flex h-8 items-center gap-1 rounded-lg px-2" data-tone="cobalt">
                <input v-model="minFillPctText" inputmode="decimal" class="sf-mono w-full bg-transparent text-[12px] font-semibold text-[color:var(--sf-ink)] outline-none" />
                <span class="sf-mono text-[9.5px] text-[color:var(--sf-muted)]">%</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Curve Editor / Full Yield Curve Plate -->
      <section class="sf-terminal-plate flex min-h-[300px] flex-1 flex-col rounded-[20px] rounded-bl-[6px] p-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div class="sf-seg" role="tablist" aria-label="Lend chart view">
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
              :class="chartTab === 'edit' ? 'is-active tone-bid' : ''"
              @click="chartTab = 'edit'"
            >
              Edit Curve
            </button>
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
              :class="chartTab === 'full' ? 'is-active tone-cobalt' : ''"
              @click="chartTab = 'full'"
            >
              Full Yield Curve
            </button>
          </div>

          <span class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">
            Drag handles or double-click chart to add points
          </span>
        </div>

        <div class="flex min-h-0 flex-1 flex-col">
          <zc-curve-editor
            v-if="chartTab === 'edit'"
            :points="points"
            :lo="minBlocks"
            :hi="maxBlocks"
            side="offer"
            :market="curveMarketOverlay"
            :floor="baseAprBps"
            :face="capitalNum || 100"
            :asset="market"
            :capital="capitalNum"
            :metric="metric"
            :height="height"
            :unit="unit"
            fill-height
            @update:points="points = $event"
            @update:metric="metric = $event"
          />

          <zc-full-yield-curve-compare
            v-else
            :market="market"
            :height="height"
            :unit="unit"
            :connected="zc.connected"
            :revision="zc.revision"
            :cover="coverFloor"
            :overlay="fullOverlay"
            role="lend"
            :refusal="sim?.refusal || null"
            :match-count="matchCount"
            :metric="metric"
            fill-height
            @update:metric="metric = $event"
          />
        </div>
      </section>
    </div>

    <!-- RIGHT ACTION DOCK -->
    <aside
      class="sf-action-dock flex h-full min-h-0 flex-col rounded-[22px] rounded-tr-[6px]"
      data-tone="bid"
      aria-label="Lend Offer Ticket"
      @mousemove="onDockPointerMove"
    >
      <div class="sf-panel-head shrink-0 px-4 pt-3.5 pb-3">
        <div class="flex items-center justify-between gap-2">
          <span class="sf-mono rounded-[4px] border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-bid)]">
            Lend Offer · {{ market }}
          </span>
          <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">
            {{ points.length }} pts
          </span>
        </div>

        <!-- Capital Hero Input -->
        <div class="mt-2.5">
          <div class="mb-1 flex items-center justify-between gap-1">
            <span class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              Capital to commit
            </span>
            <span v-if="wallet.connected" class="sf-mono text-[10px] text-[color:var(--sf-ink-2)]">
              Bal {{ formatNumber(walletBalance, market === "ERG" ? 2 : 2, 0) }} {{ market }}
            </span>
          </div>

          <div class="sf-input-well flex h-11 items-center gap-2 rounded-xl px-3" data-tone="bid">
            <input
              v-model="capitalText"
              inputmode="decimal"
              placeholder="500"
              class="sf-serif w-full min-w-0 bg-transparent text-[26px] font-semibold leading-none text-[color:var(--sf-bid)] outline-none"
            />
            <span class="sf-mono shrink-0 text-[12px] font-bold text-[color:var(--sf-muted)]">
              {{ market }}
            </span>
          </div>

          <div v-if="wallet.connected && walletBalance > 0" class="mt-1.5 flex items-center gap-1">
            <button
              v-for="p in [
                { label: '25%', v: 0.25 },
                { label: '50%', v: 0.5 },
                { label: 'Max', v: 1 }
              ]"
              :key="p.label"
              type="button"
              class="sf-mono flex-1 rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] py-0.5 text-[10px] font-semibold text-[color:var(--sf-muted)] transition-colors hover:border-[color:var(--sf-line-bid)] hover:text-[color:var(--sf-bid)]"
              @click="setBalancePct(p.v)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>
      </div>

      <div class="sf-scroll flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        <!-- 2x2 Grid -->
        <div class="grid grid-cols-2 gap-2">
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Curve
            </div>
            <div class="sf-mono mt-0.5 text-[12.5px] font-bold text-[color:var(--sf-bid)]">
              {{ curveRangeLabel }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Floor APR
            </div>
            <div class="sf-mono mt-0.5 text-[12.5px] font-bold text-[color:var(--sf-ink)]">
              {{ formatApr(baseAprBps) }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Maturities
            </div>
            <div class="sf-mono mt-0.5 text-[12.5px] font-bold text-[color:var(--sf-ink)]">
              {{ formatDur(minBlocks, unit) }}–{{ formatDur(maxBlocks, unit) }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Cover
            </div>
            <div class="sf-mono mt-0.5 text-[12.5px] font-bold text-[color:var(--sf-bid)]">
              ≥ {{ coverFloor }}%
            </div>
          </div>
        </div>

        <!-- Match Banner -->
        <div
          class="rounded-xl border px-3 py-2.5"
          :class="
            matchCount > 0
              ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)]'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)]'
          "
        >
          <div class="flex items-center justify-between gap-2">
            <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              Immediate Fills
            </span>
            <span v-if="simLoading" class="sf-mono text-[10px] text-[color:var(--sf-dim)]">
              simulating…
            </span>
          </div>
          <div
            class="mt-1 text-[12.5px] font-semibold"
            :class="matchCount > 0 ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ink)]'"
          >
            {{
              matchCount > 0
                ? `Takes ${matchCount} ask${matchCount === 1 ? "" : "s"} right away`
                : "Rests as a rolling bid curve"
            }}
          </div>
        </div>

        <!-- Checklist -->
        <div class="space-y-1.5">
          <div
            v-for="chk in checks"
            :key="chk.label"
            class="flex items-center gap-2 text-[11.5px]"
          >
            <check-circle-icon
              v-if="chk.ok"
              class="h-3.5 w-3.5 shrink-0 text-[color:var(--sf-bid)]"
            />
            <alert-circle-icon
              v-else
              class="h-3.5 w-3.5 shrink-0 text-[color:var(--sf-ask)]"
            />
            <span :class="chk.ok ? 'text-[color:var(--sf-ink-2)]' : 'font-medium text-[color:var(--sf-ask)]'">
              {{ chk.label }}
            </span>
          </div>
        </div>
      </div>

      <div class="shrink-0 border-t border-[color:var(--sf-line)] p-3.5">
        <button
          type="button"
          class="sf-btn-bid flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
          :disabled="!canSubmit"
          @click="openPreview"
        >
          <span>Post Lend Offer</span>
          <arrow-right-icon class="h-4 w-4" />
        </button>
      </div>
    </aside>
  </div>
</template>
