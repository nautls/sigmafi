<script setup lang="ts">
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  ShieldIcon,
  ZapIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import CoverMeter from "../components/CoverMeter.vue";
import { ExecutionPreviewPayload } from "../components/ExecutionPreviewModal.vue";
import ZcDurInput from "../components/ZcDurInput.vue";
import ZcFixedChart from "../components/ZcFixedChart.vue";
import ZcFullYieldCurveCompare, { FullCurveOverlay } from "../components/ZcFullYieldCurveCompare.vue";
import ZcOrderMark from "../components/ZcOrderMark.vue";
import ZcPnlChart from "../components/ZcPnlChart.vue";
import ZcSelect, { ZcSelectOption } from "../components/ZcSelect.vue";
import ZcTimeEditor from "../components/ZcTimeEditor.vue";
import { buildAskBody, zcApi } from "@/services/zcApi";
import { useWalletStore, useZcStore } from "@/stories";
import {
  ZcChartMetric,
  ZcPortfolioPosition,
  ZcSimulateResponse,
  ZcTwoPointYield
} from "@/types/zc";
import { shortenString } from "@/utils";
import {
  dateAtHeight,
  DAY_BLOCKS,
  feeAdjustedBidBps,
  formatApr,
  formatDur,
  formatMarketAmount,
  formatNumber,
  lineAt,
  MIN_MATURITY_BLOCKS,
  offerYieldAt,
  pnlTone,
  priceForYield,
  SHARES_UNITS,
  signedFormat,
  YEAR_BLOCKS,
  yieldForPrice
} from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    initialTokenId?: string | null;
    matchOfferId?: string | null;
  }>(),
  {
    initialTokenId: null,
    matchOfferId: null
  }
);

const emit = defineEmits<{
  (e: "preview", payload: ExecutionPreviewPayload): void;
}>();

const zc = useZcStore();
const wallet = useWalletStore();

const height = computed(() => zc.height);
const unit = computed(() => zc.durationUnit);

const sellablePositions = computed<ZcPortfolioPosition[]>(() =>
  zc.portfolio.positions.filter(
    (p) => p.side === "lend" && (p.status === "live" || p.status === "active") && p.bond.maturity > height.value
  )
);

const selectedTokenId = ref<string>(props.initialTokenId || "");

watch(
  [sellablePositions, () => props.initialTokenId],
  ([list, init]) => {
    if (init && list.some((p) => (p.tokenId || p.id) === init)) {
      selectedTokenId.value = init;
      return;
    }
    if (!selectedTokenId.value || !list.some((p) => (p.tokenId || p.id) === selectedTokenId.value)) {
      selectedTokenId.value = list[0]?.tokenId || list[0]?.id || "";
    }
  },
  { immediate: true }
);

const position = computed<ZcPortfolioPosition | null>(
  () => sellablePositions.value.find((p) => (p.tokenId || p.id) === selectedTokenId.value) || null
);

const positionOptions = computed<ZcSelectOption[]>(() =>
  sellablePositions.value.map((p) => {
    const id = p.tokenId || p.id;
    const rem = Math.max(0, p.bond.maturity - height.value);
    const shareTag =
      p.kind === "shares" ? ` · ${formatNumber((p.units / SHARES_UNITS) * 100, 1, 0)}% shares` : "";
    return {
      value: id,
      label: `${formatMarketAmount(p.bond.repayment, p.bond.market)} · ${formatDur(rem, unit.value)}${shareTag}`
    };
  })
);

const posMarket = computed(() => position.value?.bond.market || zc.activeMarket);
const posSnap = computed(() => zc.markets[posMarket.value]);
const feeErg = computed(() => (posMarket.value === "ERG" ? 0.002 : 0));

const isShares = computed(() => position.value?.kind === "shares");
const sharesToSellText = ref("100");
const pricing = ref<"yield" | "fixed">("yield");
const chartTab = ref<"edit" | "full" | "pnl">("edit");
const metric = ref<ZcChartMetric>("yield");

const expiryDays = ref<number | null>(7);
const floorText = ref("");
const fixedPriceText = ref("");

const tp = ref<ZcTwoPointYield>({
  h0: Math.max(1, zc.height),
  y0: 800,
  h1: Math.max(1, zc.height) + 7 * DAY_BLOCKS,
  y1: 900
});

const guardOn = ref(false);
const guardRatio = ref(150);
const scrubHeight = ref<number | null>(null);

const selectedUnits = computed(() => {
  if (!position.value) return 1;
  if (!isShares.value) return 1;
  const pct = Number(sharesToSellText.value);
  const clamped = Number.isFinite(pct) ? Math.max(0.01, Math.min((position.value.units / SHARES_UNITS) * 100, pct)) : (position.value.units / SHARES_UNITS) * 100;
  return Math.max(1, Math.min(position.value.units, Math.round((clamped / 100) * SHARES_UNITS)));
});

const faceVal = computed(() => {
  if (!position.value) return 0;
  if (!isShares.value) return position.value.bond.repayment;
  return position.value.bond.repayment * (selectedUnits.value / SHARES_UNITS);
});

const costBasis = computed(() => {
  if (!position.value || position.value.paid == null) return null;
  if (!isShares.value || !(position.value.units > 0)) return position.value.paid;
  return position.value.paid * (selectedUnits.value / position.value.units);
});

const remBlocks = computed(() =>
  position.value ? Math.max(MIN_MATURITY_BLOCKS, position.value.bond.maturity - height.value) : DAY_BLOCKS
);

const expiryHeight = computed(() => {
  if (!position.value) return height.value + 7 * DAY_BLOCKS;
  const raw = height.value + Math.max(60, Math.round((expiryDays.value || 7) * DAY_BLOCKS));
  return Math.max(height.value + 30, Math.min(raw, position.value.bond.maturity - 6));
});

const bidLine = computed(() => posSnap.value.curves?.bidLine || []);
const askLine = computed(() => posSnap.value.curves?.askLine || []);

const bestBidAtRem = computed(() => lineAt(bidLine.value, remBlocks.value));
const bestBidEffAtRem = computed(() => {
  if (bestBidAtRem.value == null) return null;
  if (feeErg.value > 0 && faceVal.value > 0) {
    return feeAdjustedBidBps(faceVal.value, bestBidAtRem.value, remBlocks.value, feeErg.value);
  }
  return bestBidAtRem.value;
});
const bestAskAtRem = computed(() => lineAt(askLine.value, remBlocks.value));

// Initialize pricing when position changes
watch(
  [position, () => props.matchOfferId],
  ([pos, matchId]) => {
    if (!pos) return;
    if (pos.kind === "shares") {
      sharesToSellText.value = String(Number(((pos.units / SHARES_UNITS) * 100).toFixed(2)));
    }
    const offer = matchId ? posSnap.value.offers.find((o) => o.id === matchId) : null;
    const targetBps =
      (offer ? offerYieldAt(offer, remBlocks.value) : null) ??
      bestBidEffAtRem.value ??
      bestBidAtRem.value ??
      850;
    tp.value = {
      h0: Math.max(1, height.value),
      y0: Math.round(targetBps),
      h1: Math.max(height.value + 60, expiryHeight.value),
      y1: Math.round(targetBps + 100)
    };
    const px = priceForYield(faceVal.value || pos.bond.repayment, targetBps, remBlocks.value);
    fixedPriceText.value = String(Number(px.toFixed(pos.bond.market === "ERG" ? 4 : 2)));
    guardOn.value = false;
    guardRatio.value = Math.max(125, Math.round((pos.bond.ratio || 150) + 10));
    if (chartTab.value === "pnl" && pos.paid == null) chartTab.value = "edit";
  },
  { immediate: true }
);

const floorNum = computed(() => {
  const n = Number(floorText.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
});

const fixedPriceNum = computed(() => {
  const n = Number(fixedPriceText.value);
  return Number.isFinite(n) && n > 0 ? n : null;
});

const salePriceNow = computed(() => {
  if (!(faceVal.value > 0)) return null;
  if (pricing.value === "fixed") return fixedPriceNum.value;
  return Math.max(floorNum.value, priceForYield(faceVal.value, tp.value.y0, remBlocks.value));
});

const buyerAprNow = computed(() => {
  if (!salePriceNow.value || !(faceVal.value > 0)) return null;
  return yieldForPrice(faceVal.value, salePriceNow.value, remBlocks.value);
});

const pctFaceNow = computed(() =>
  salePriceNow.value && faceVal.value > 0 ? (salePriceNow.value / faceVal.value) * 100 : null
);

const holdAprBps = computed(() => {
  if (!position.value || !costBasis.value || !(costBasis.value > 0) || !(faceVal.value > 0)) return null;
  const term = position.value.bond.maturity - (position.value.at ?? position.value.bond.start);
  if (!(term > 0)) return null;
  return ((faceVal.value / costBasis.value - 1) * YEAR_BLOCKS * 10_000) / term;
});

const pnlSummary = computed(() => {
  if (!position.value || costBasis.value == null || salePriceNow.value == null) return null;
  const pnl = salePriceNow.value - costBasis.value;
  return {
    pnl,
    pct: costBasis.value > 0 ? (pnl / costBasis.value) * 100 : null
  };
});

const fmtSellAmt = (x: number) => formatMarketAmount(x, posMarket.value);

const lifecyclePct = computed(() => {
  if (!position.value) return 0;
  const span = Math.max(1, position.value.bond.maturity - position.value.bond.start);
  return Math.max(0, Math.min(100, ((height.value - position.value.bond.start) / span) * 100));
});

const guardState = computed(() => {
  if (!guardOn.value || !position.value || position.value.bond.rule !== "oracle") return "off";
  if (position.value.bond.cov == null) return "unknown";
  return position.value.bond.cov >= guardRatio.value ? "passing" : "paused";
});

function snapPrice(targetBps: number | null) {
  if (targetBps == null || !(faceVal.value > 0)) return;
  if (pricing.value === "yield") {
    tp.value = { ...tp.value, y0: Math.round(targetBps), y1: Math.max(Math.round(targetBps), tp.value.y1) };
  } else {
    const px = priceForYield(faceVal.value, targetBps, remBlocks.value);
    fixedPriceText.value = String(Number(px.toFixed(posMarket.value === "ERG" ? 4 : 2)));
  }
}

function dAt(at: number): number {
  return position.value ? Math.max(0, position.value.bond.maturity - at) : 0;
}

function bidAt(at: number): number | null {
  const d = dAt(at);
  return d > 0 ? lineAt(bidLine.value, d) : null;
}

const fullOverlay = computed<FullCurveOverlay | null>(() => {
  if (!position.value || !(faceVal.value > 0)) return null;
  const face = faceVal.value;
  return {
    type: "point-path",
    dAt,
    aprAt: (at: number) => {
      const rem = dAt(at);
      if (!(rem > 0)) return null;
      if (pricing.value === "fixed") {
        return fixedPriceNum.value ? yieldForPrice(face, fixedPriceNum.value, rem) : null;
      }
      const { h0, y0, h1, y1 } = tp.value;
      const clamped = Math.min(Math.max(at, h0), h1);
      const bps = y0 + ((y1 - y0) * (clamped - h0)) / Math.max(1, h1 - h0);
      const px = Math.max(floorNum.value, priceForYield(face, bps, rem));
      return yieldForPrice(face, px, rem);
    },
    priceAt: (at: number) => {
      const rem = dAt(at);
      if (!(rem > 0)) return null;
      if (pricing.value === "fixed") return fixedPriceNum.value;
      const { h0, y0, h1, y1 } = tp.value;
      const clamped = Math.min(Math.max(at, h0), h1);
      const bps = y0 + ((y1 - y0) * (clamped - h0)) / Math.max(1, h1 - h0);
      return Math.max(floorNum.value, priceForYield(face, bps, rem));
    },
    expiry: expiryHeight.value,
    maxAt: Math.max(expiryHeight.value, position.value.bond.maturity - MIN_MATURITY_BLOCKS),
    face,
    costBasis: costBasis.value,
    color: "var(--sf-cobalt)",
    label: "Your resale"
  };
});

// Live simulation
const sim = ref<ZcSimulateResponse | null>(null);
const simLoading = ref(false);
let simTimer: number | null = null;
let simAc: AbortController | null = null;

function buildDraft() {
  if (!position.value) return null;
  return buildAskBody({
    tokenId: position.value.tokenId || position.value.id,
    market: posMarket.value,
    units: selectedUnits.value,
    pricing: pricing.value,
    price: pricing.value === "fixed" ? fixedPriceNum.value : null,
    floor: pricing.value === "yield" ? floorNum.value : null,
    tp: pricing.value === "yield" ? tp.value : null,
    guard:
      guardOn.value && position.value.bond.rule === "oracle"
        ? { ratio: guardRatio.value, age: 30 }
        : null,
    minFill: isShares.value ? Math.min(selectedUnits.value, Math.max(1, Math.round(selectedUnits.value * 0.1))) : 1,
    expiry: expiryHeight.value
  });
}

const simDeps = computed(() =>
  JSON.stringify({
    tid: selectedTokenId.value,
    u: selectedUnits.value,
    p: pricing.value,
    fp: fixedPriceNum.value,
    fl: floorNum.value,
    tp: tp.value,
    g: guardOn.value ? guardRatio.value : null,
    ex: expiryHeight.value,
    rev: zc.revision
  })
);

watch(
  simDeps,
  () => {
    if (simTimer !== null) window.clearTimeout(simTimer);
    if (simAc) simAc.abort();
    const body = buildDraft();
    if (!zc.connected || !body) {
      sim.value = null;
      return;
    }
    simTimer = window.setTimeout(async () => {
      const ac = new AbortController();
      simAc = ac;
      simLoading.value = true;
      try {
        const res = await zcApi.simulate({ type: "ask", ...body }, ac.signal);
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

const matchCount = computed(() => sim.value?.offers?.length ?? sim.value?.matches?.length ?? 0);

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

function openPreview() {
  const body = buildDraft();
  if (!body || !position.value) return;
  emit("preview", {
    title: isShares.value ? "List Bond Shares for Sale" : "List Bond for Sale",
    subtitle: `${pricing.value === "yield" ? "Moving APR" : "Fixed price"} · ${posMarket.value} market`,
    badge: `Resale · ${posMarket.value}`,
    tone: "cobalt",
    heroLabel: "Sale price now",
    heroValue: formatMarketAmount(salePriceNow.value, posMarket.value),
    heroSub: `Buyer earns ${formatApr(buyerAprNow.value)} · ${formatNumber(pctFaceNow.value, 2, 1)}% of face`,
    rows: [
      { label: "Bond", value: shortenString(position.value.bond.id, 14) },
      { label: "Face value", value: formatMarketAmount(faceVal.value, posMarket.value) },
      {
        label: "Sale guard",
        value: guardOn.value ? `Cover ≥ ${guardRatio.value}% (${guardState.value})` : "Off"
      },
      {
        label: "Expires",
        value: `${formatDur(expiryHeight.value - height.value, unit.value)} (${dateAtHeight(expiryHeight.value, height.value)})`
      },
      ...(pnlSummary.value
        ? [
            {
              label: "Projected P&L",
              value: signedFormat(pnlSummary.value.pnl, fmtSellAmt),
              tone: (pnlSummary.value.pnl >= 0 ? "bid" : "ask") as "bid" | "ask"
            }
          ]
        : [])
    ],
    rawSummary: { action: "createAsk", ...body },
    txAction: { type: "createAsk", body }
  });
}
</script>

<template>
  <!-- Empty State when wallet not connected or no live bonds -->
  <div
    v-if="!position"
    class="sf-terminal-plate flex flex-1 flex-col items-center justify-center rounded-[22px] p-8 text-center"
  >
    <zc-order-mark kind="unit" :size="48" />
    <h2 class="sf-display mt-3 text-[19px] font-bold text-[color:var(--sf-ink)]">
      {{ wallet.connected ? "No live bond positions to sell" : "Connect Nautilus to sell bonds" }}
    </h2>
    <p class="mt-1.5 max-w-md text-[13px] text-[color:var(--sf-muted)]">
      {{
        wallet.connected
          ? "Hold a live zero-coupon bond or bond shares in your connected wallet to list them on the yield curve."
          : "Connect your Nautilus wallet so Studio can load your live zero-coupon bonds and cost basis."
      }}
    </p>
    <div class="mt-5 flex items-center gap-2.5">
      <button
        v-if="!wallet.connected"
        type="button"
        class="sf-btn-cobalt h-10 rounded-full px-6 text-[13.5px]"
        @click="wallet.connect('nautilus')"
      >
        Connect Nautilus
      </button>
      <router-link
        to="/app"
        class="sf-btn-outline inline-flex h-10 items-center gap-1.5 rounded-full px-5 text-[13px]"
      >
        <span>Browse Yield Curve</span>
        <arrow-up-right-icon class="h-3.5 w-3.5" />
      </router-link>
    </div>
  </div>

  <!-- Active Sell Workbench -->
  <div v-else class="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_348px]">
    <!-- LEFT WORKBENCH -->
    <div class="flex min-h-0 flex-col gap-2.5">
      <!-- Position Telemetry & Pricing Controls -->
      <section class="sf-terminal-plate shrink-0 rounded-[18px] rounded-tl-[6px] p-3">
        <!-- Position Picker + Telemetry Strip -->
        <div class="flex flex-wrap items-center justify-between gap-2.5 pb-2.5">
          <div class="flex min-w-0 flex-1 items-center gap-2.5">
            <zc-order-mark :kind="isShares ? 'shares' : 'unit'" :size="30" />
            <div class="min-w-[220px] max-w-[360px] flex-1">
              <zc-select
                v-model="selectedTokenId"
                :options="positionOptions"
                size="sm"
                aria-label="Select bond position to sell"
              />
            </div>
            <router-link
              :to="{ name: 'zc-bond', params: { id: position.bond.id } }"
              class="sf-mono inline-flex items-center gap-1 rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-1 text-[10.5px] font-semibold text-[color:var(--sf-cobalt)] transition-colors hover:border-[color:var(--sf-line-cobalt)]"
            >
              <span>{{ shortenString(position.bond.id, 10) }}</span>
              <arrow-up-right-icon class="h-3 w-3" />
            </router-link>
          </div>

          <div class="flex flex-wrap items-center gap-3 text-[11.5px]">
            <div>
              <span class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)]">Paid </span>
              <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
                {{ costBasis != null ? formatMarketAmount(costBasis, posMarket) : "—" }}
              </span>
            </div>
            <div>
              <span class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)]">Hold APR </span>
              <span class="sf-mono font-semibold text-[color:var(--sf-bid)]">
                {{ formatApr(holdAprBps) }}
              </span>
            </div>
            <cover-meter :value="position.bond.cov" :ratio="position.bond.ratio" compact />
          </div>
        </div>

        <!-- Compact Lifecycle Bar -->
        <div class="mb-2.5 flex items-center gap-2">
          <span class="sf-mono text-[9.5px] text-[color:var(--sf-dim)]">
            {{ Math.round(lifecyclePct) }}% elapsed
          </span>
          <div class="h-1 flex-1 overflow-hidden rounded-full bg-[color:var(--sf-line-strong)]">
            <div
              class="h-full rounded-full bg-[color:var(--sf-cobalt)] transition-all duration-500"
              :style="{ width: `${lifecyclePct}%` }"
            />
          </div>
          <span class="sf-mono text-[9.5px] font-semibold text-[color:var(--sf-ink-2)]">
            {{ formatDur(remBlocks, unit) }} left
          </span>
        </div>

        <!-- Pricing Row -->
        <div class="grid grid-cols-2 items-end gap-2 border-t border-[color:var(--sf-line)] pt-2.5 sm:grid-cols-4 lg:grid-cols-[auto_1fr_1fr_1fr_auto]">
          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Pricing
            </label>
            <div class="sf-seg">
              <button
                type="button"
                class="sf-seg-btn !h-[30px] !px-2.5 !text-[11px]"
                :class="pricing === 'yield' ? 'is-active tone-cobalt' : ''"
                @click="pricing = 'yield'"
              >
                Moving APR
              </button>
              <button
                type="button"
                class="sf-seg-btn !h-[30px] !px-2.5 !text-[11px]"
                :class="pricing === 'fixed' ? 'is-active tone-cobalt' : ''"
                @click="pricing = 'fixed'"
              >
                Fixed
              </button>
            </div>
          </div>

          <div v-if="isShares">
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Shares to sell
            </label>
            <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2.5" data-tone="cobalt">
              <input
                v-model="sharesToSellText"
                inputmode="decimal"
                class="sf-mono w-full min-w-0 bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] outline-none"
              />
              <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">%</span>
            </div>
          </div>

          <div v-if="pricing === 'fixed'">
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Sale price
            </label>
            <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2.5" data-tone="cobalt">
              <input
                v-model="fixedPriceText"
                inputmode="decimal"
                class="sf-mono w-full min-w-0 bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] outline-none"
              />
              <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">{{ posMarket }}</span>
            </div>
          </div>
          <div v-else>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Price floor
            </label>
            <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2.5" data-tone="cobalt">
              <input
                v-model="floorText"
                inputmode="decimal"
                placeholder="None"
                class="sf-mono w-full min-w-0 bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
              />
              <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">{{ posMarket }}</span>
            </div>
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Ask expires
            </label>
            <zc-dur-input v-model="expiryDays" :unit="unit" of="days" tone="cobalt" />
          </div>

          <div class="flex items-center gap-1.5">
            <button
              v-if="bestBidEffAtRem != null || bestBidAtRem != null"
              type="button"
              class="sf-mono inline-flex h-9 items-center gap-1 rounded-xl border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] px-2.5 text-[10.5px] font-semibold text-[color:var(--sf-bid)] transition-all hover:brightness-110 active:scale-95"
              @click="snapPrice((bestBidEffAtRem ?? bestBidAtRem)! + 1)"
            >
              <zap-icon class="h-3 w-3" />
              <span>Bid {{ formatApr(bestBidEffAtRem ?? bestBidAtRem) }}</span>
            </button>
            <button
              v-if="bestAskAtRem != null"
              type="button"
              class="sf-mono inline-flex h-9 items-center rounded-xl border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] px-2.5 text-[10.5px] font-semibold text-[color:var(--sf-ask)] transition-all hover:brightness-110 active:scale-95"
              @click="snapPrice(bestAskAtRem)"
            >
              Ask {{ formatApr(bestAskAtRem) }}
            </button>
          </div>
        </div>
      </section>

      <!-- Chart Plate -->
      <section class="sf-terminal-plate flex min-h-[290px] flex-1 flex-col rounded-[20px] rounded-bl-[6px] p-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <div class="sf-seg" role="tablist">
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
              :class="chartTab === 'edit' ? 'is-active tone-cobalt' : ''"
              @click="chartTab = 'edit'"
            >
              Over Fill Time
            </button>
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
              :class="chartTab === 'full' ? 'is-active tone-cobalt' : ''"
              @click="chartTab = 'full'"
            >
              Full Yield Curve
            </button>
            <button
              v-if="costBasis != null && costBasis > 0"
              type="button"
              class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
              :class="chartTab === 'pnl' ? 'is-active tone-bid' : ''"
              @click="chartTab = 'pnl'"
            >
              P&amp;L
            </button>
          </div>

          <span class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">
            Matures {{ dateAtHeight(position.bond.maturity, height) }}
          </span>
        </div>

        <div class="flex min-h-0 flex-1 flex-col">
          <template v-if="chartTab === 'edit'">
            <zc-time-editor
              v-if="pricing === 'yield'"
              :tp="tp"
              :height="height"
              :end="expiryHeight"
              :d-at="dAt"
              :face="faceVal"
              :floor="floorNum"
              :bid-at="bidAt"
              :asset="posMarket"
              :fee-erg="feeErg"
              :cost-basis="costBasis"
              :metric="metric"
              :unit="unit"
              role="sell"
              fill-height
              @update:tp="tp = $event"
              @update:metric="metric = $event"
            />
            <zc-fixed-chart
              v-else
              :principal="fixedPriceNum || faceVal"
              :repayment="faceVal"
              :height="height"
              :expiry-h="expiryHeight"
              :d-at="dAt"
              :bid-at="bidAt"
              :asset="posMarket"
              :fee-erg="feeErg"
              :cost-basis="costBasis"
              :metric="metric"
              :unit="unit"
              role="sell"
              pay-label="You receive"
              fill-height
              @update:metric="metric = $event"
            />
          </template>

          <zc-full-yield-curve-compare
            v-else-if="chartTab === 'full'"
            :market="posMarket"
            :height="height"
            :unit="unit"
            :connected="zc.connected"
            :revision="zc.revision"
            :cover="position.bond.cov"
            :overlay="fullOverlay"
            :at-height="scrubHeight"
            role="sell"
            :fee-erg="feeErg"
            :refusal="sim?.refusal || null"
            :match-count="matchCount"
            :metric="metric"
            fill-height
            @update:at-height="scrubHeight = $event"
            @update:metric="metric = $event"
          />

          <zc-pnl-chart
            v-else-if="costBasis != null"
            :tp="pricing === 'yield' ? tp : null"
            :fixed-price="pricing === 'fixed' ? fixedPriceNum : null"
            :floor="floorNum"
            :face="faceVal"
            :cost-basis="costBasis"
            :entry-at="position.at"
            :maturity="position.bond.maturity"
            :height="height"
            :expiry-h="expiryHeight"
            :market="posMarket"
            :unit="unit"
            fill-height
          />
        </div>
      </section>
    </div>

    <!-- RIGHT ACTION DOCK -->
    <aside
      class="sf-action-dock flex h-full min-h-0 flex-col rounded-[22px] rounded-tr-[6px]"
      data-tone="cobalt"
      aria-label="Sell Bond Ticket"
      @mousemove="onDockPointerMove"
    >
      <div class="sf-panel-head shrink-0 px-4 pt-3.5 pb-3">
        <div class="flex items-center justify-between gap-2">
          <span class="sf-mono rounded-[4px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-cobalt)]">
            Sell {{ isShares ? "Shares" : "Bond" }} · {{ posMarket }}
          </span>
          <span
            v-if="pnlSummary"
            class="sf-mono rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold"
            :class="
              pnlTone(pnlSummary.pnl) === 'bid'
                ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                : pnlTone(pnlSummary.pnl) === 'danger'
                  ? 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-danger)]'
                  : 'bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)]'
            "
          >
            {{ signedFormat(pnlSummary.pnl, fmtSellAmt) }}
          </span>
        </div>

        <div class="mt-2.5">
          <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Sale price now
          </div>
          <div class="sf-serif mt-0.5 text-[32px] font-semibold leading-none text-[color:var(--sf-ink)]">
            {{ formatMarketAmount(salePriceNow, posMarket) }}
          </div>
        </div>
      </div>

      <div class="sf-scroll flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        <div class="grid grid-cols-2 gap-2">
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Buyer earns
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ask)]">
              {{ formatApr(buyerAprNow) }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              % of face
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
              {{ pctFaceNow != null ? `${formatNumber(pctFaceNow, 2, 1)}%` : "—" }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Face
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
              {{ formatMarketAmount(faceVal, posMarket) }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Expires
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
              {{ formatDur(expiryHeight - height, unit) }}
            </div>
          </div>
        </div>

        <!-- Interactive Sale Guard Slider (Oracle bonds) -->
        <div
          v-if="position.bond.rule === 'oracle'"
          class="sf-dock-well rounded-xl px-3 py-2.5"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5">
              <shield-icon class="h-3.5 w-3.5 text-[color:var(--sf-cobalt)]" />
              <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-ink)]">
                Sale Guard
              </span>
            </div>
            <button
              type="button"
              class="sf-mono rounded-md px-2 py-0.5 text-[10px] font-semibold transition-colors"
              :class="
                guardState === 'passing'
                  ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                  : guardState === 'paused'
                    ? 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                    : 'bg-[color:var(--sf-well)] text-[color:var(--sf-muted)]'
              "
              @click="guardOn = !guardOn"
            >
              {{
                !guardOn
                  ? "Off"
                  : guardState === "passing"
                    ? `≥ ${guardRatio}% · Passing`
                    : `≥ ${guardRatio}% · Paused`
              }}
            </button>
          </div>

          <div v-if="guardOn" class="mt-2.5">
            <input
              v-model.number="guardRatio"
              type="range"
              :min="Math.max(125, Math.round(position.bond.ratio || 125))"
              :max="Math.max(250, Math.round((position.bond.cov || 200) + 40))"
              step="1"
              class="sf-range w-full"
              aria-label="Sale guard minimum cover ratio"
            />
            <div class="sf-mono mt-1 flex justify-between text-[9.5px] text-[color:var(--sf-dim)]">
              <span>Liq {{ Math.round(position.bond.ratio || 125) }}%</span>
              <span>Now {{ position.bond.cov != null ? `${Math.round(position.bond.cov)}%` : "—" }}</span>
            </div>
          </div>
        </div>

        <!-- Book Match -->
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
              Book Match
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
                ? `${matchCount} offer${matchCount === 1 ? "" : "s"} would take this now`
                : sim?.refusal || "Rests on the secondary book"
            }}
          </div>
        </div>
      </div>

      <div class="shrink-0 border-t border-[color:var(--sf-line)] p-3.5">
        <button
          type="button"
          class="sf-btn-cobalt flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
          :disabled="!salePriceNow"
          @click="openPreview"
        >
          <span>List for Sale</span>
          <arrow-right-icon class="h-4 w-4" />
        </button>
      </div>
    </aside>
  </div>
</template>
