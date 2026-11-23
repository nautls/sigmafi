<script setup lang="ts">
import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LayersIcon,
  ZapIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import CoverMeter from "../components/CoverMeter.vue";
import { ExecutionPreviewPayload } from "../components/ExecutionPreviewModal.vue";
import ZcCurveEditor, { CurveMarketOverlay } from "../components/ZcCurveEditor.vue";
import ZcDurInput from "../components/ZcDurInput.vue";
import ZcFixedChart from "../components/ZcFixedChart.vue";
import ZcFullYieldCurveCompare, { FullCurveOverlay } from "../components/ZcFullYieldCurveCompare.vue";
import ZcTimeEditor from "../components/ZcTimeEditor.vue";
import ZcTokenPicker, { SelectedWalletToken } from "../components/ZcTokenPicker.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { buildOrderBody, zcApi } from "@/services/zcApi";
import { useZcStore } from "@/stories";
import {
  ZcChartMetric,
  ZcSimulateResponse,
  ZcTwoPointYield,
  ZcWalletToken
} from "@/types/zc";
import {
  buildFeeAdjustedBidLine,
  combinedAskLine,
  coverage,
  dateAtHeight,
  DAY_BLOCKS,
  feeAdjustedBidBps,
  fixedAskDots,
  formatApr,
  formatDur,
  formatMarketAmount,
  formatNumber,
  lineAt,
  liquidationPrice,
  MIN_MATURITY_BLOCKS,
  offerYieldAt,
  priceForYield,
  repaymentFor,
  SIGUSD_TOKEN_ID,
  snapMaturity,
  spreadCurve,
  windowAskLine,
  yieldForPrice,
  ZcSimpleCurvePoint
} from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    initialAmount?: number | null;
    initialApr?: number | null;
    initialDays?: number | null;
    matchOfferId?: string | null;
  }>(),
  {
    initialAmount: null,
    initialApr: null,
    initialDays: null,
    matchOfferId: null
  }
);

const emit = defineEmits<{
  (e: "preview", payload: ExecutionPreviewPayload): void;
  (e: "wrap-token", tok: ZcWalletToken): void;
}>();

const zc = useZcStore();

const market = computed(() => zc.activeMarket);
const snap = computed(() => zc.activeSnapshot);
const height = computed(() => zc.height);
const oraclePrice = computed(() => zc.oracle.price);
const unit = computed(() => zc.durationUnit);
const feeErg = computed(() => (market.value === "ERG" ? 0.005 : 0));

const pricing = ref<"fixed" | "yield" | "window">("fixed");
const chartTab = ref<"edit" | "full">("edit");
const metric = ref<ZcChartMetric>("yield");

const borrowText = ref(props.initialAmount ? String(props.initialAmount) : "100");
const aprText = ref(props.initialApr != null ? String(props.initialApr) : "8");
const maturityDays = ref<number | null>(props.initialDays ?? 365);
const timingMode = ref<"fixed" | "term">("term");
const exactMaturity = ref(false);
const expiryDays = ref<number | null>(7);

// Variable maturity (window) fields
const repayWindowText = ref(props.initialAmount ? String(Number((props.initialAmount * 1.08).toFixed(2))) : "108");
const winMinDays = ref<number | null>(7);
const winMaxDays = ref<number | null>(365);
const minCashText = ref("");
const windowPoints = ref<ZcSimpleCurvePoint[]>([
  { d: 7 * DAY_BLOCKS, y: 700 },
  { d: 90 * DAY_BLOCKS, y: 900 },
  { d: 365 * DAY_BLOCKS, y: 1150 }
]);

// Moving APR two-point state
const tp = ref<ZcTwoPointYield>({
  h0: Math.max(1, zc.height),
  y0: Math.round((props.initialApr ?? 8) * 100),
  h1: Math.max(1, zc.height) + 7 * DAY_BLOCKS,
  y1: Math.round(((props.initialApr ?? 8) + 1) * 100)
});

// Dual Collateral (both SigUSD and ERG, including the borrowed currency itself) & risk
const ergColText = ref("");
const usdColText = ref("");
const rule = ref<"oracle" | "maturity">("oracle");
const ratioText = ref("150");
const fillGuardOn = ref(true);
const fillGuardText = ref("160");
const extraTokensOpen = ref(false);
const extraTokens = ref<SelectedWalletToken[]>([]);

// Scrubber height for full yield curve comparison
const scrubHeight = ref<number | null>(null);

// Live simulation
const sim = ref<ZcSimulateResponse | null>(null);
const simLoading = ref(false);

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

// Seed from ?match=<offerId> if present
watch(
  [() => props.matchOfferId, () => snap.value.offers.length, height],
  ([offerId]) => {
    if (!offerId) return;
    const offer = snap.value.offers.find((o) => o.id === offerId);
    if (!offer) return;
    const targetD = Math.min(offer.maxBlocks, Math.max(offer.minBlocks, 365 * DAY_BLOCKS));
    const bps = offerYieldAt(offer, targetD);
    maturityDays.value = Math.max(1, Math.round(targetD / DAY_BLOCKS));
    if (bps != null) {
      const apr = Number(((bps + 2) / 100).toFixed(2));
      aprText.value = String(apr);
      tp.value = {
        h0: Math.max(1, height.value),
        y0: Math.round(apr * 100),
        h1: Math.max(1, height.value) + Math.round((expiryDays.value || 7) * DAY_BLOCKS),
        y1: Math.round((apr + 1) * 100)
      };
    }
    if (offer.floor > 0) {
      ratioText.value = String(Math.max(125, Math.round(offer.floor)));
      fillGuardText.value = String(Math.max(125, Math.round(offer.floor + 10)));
    }
  },
  { immediate: true }
);

// Keep tp h0/h1 synced with chain height & expiry
watch([height, expiryDays], ([h, expD]) => {
  if (!(h > 0)) return;
  const expH = h + Math.max(60, Math.round((expD || 7) * DAY_BLOCKS));
  if (tp.value.h0 < h || tp.value.h1 <= h) {
    tp.value = {
      ...tp.value,
      h0: h,
      h1: Math.max(h + 60, expH)
    };
  }
});

// Keep window points clamped to winMin/winMax
const winMinBlocks = computed(() =>
  Math.max(MIN_MATURITY_BLOCKS, Math.round((winMinDays.value || 7) * DAY_BLOCKS))
);
const winMaxBlocks = computed(() =>
  Math.max(winMinBlocks.value + DAY_BLOCKS, Math.round((winMaxDays.value || 90) * DAY_BLOCKS))
);

watch([winMinBlocks, winMaxBlocks], ([lo, hi]) => {
  windowPoints.value = spreadCurve(windowPoints.value, Math.max(2, windowPoints.value.length), lo, hi);
});

const borrowNum = computed(() => {
  const n = Number(borrowText.value);
  return Number.isFinite(n) && n > 0 ? n : null;
});

const aprBps = computed(() => {
  if (pricing.value === "yield") return tp.value.y0;
  const n = Number(aprText.value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
});

const termBlocks = computed(() =>
  Math.max(MIN_MATURITY_BLOCKS, Math.round((maturityDays.value || 30) * DAY_BLOCKS))
);

const rawMaturityHeight = computed(() => height.value + termBlocks.value);
const maturityHeight = computed(() =>
  timingMode.value === "fixed" && !exactMaturity.value && height.value > 0
    ? Math.max(height.value + MIN_MATURITY_BLOCKS, snapMaturity(rawMaturityHeight.value, height.value))
    : rawMaturityHeight.value
);

const effectiveD = computed(() =>
  timingMode.value === "term" ? termBlocks.value : Math.max(MIN_MATURITY_BLOCKS, maturityHeight.value - height.value)
);

const expiryBlocks = computed(() => Math.max(60, Math.round((expiryDays.value || 7) * DAY_BLOCKS)));
const expiryHeight = computed(() => {
  const raw = height.value + expiryBlocks.value;
  if (pricing.value !== "window" && timingMode.value === "fixed") {
    return Math.max(height.value + 30, Math.min(raw, maturityHeight.value - 6));
  }
  return raw;
});

const repayWindowNum = computed(() => {
  const n = Number(repayWindowText.value);
  return Number.isFinite(n) && n > 0 ? n : null;
});

const windowMaxCurveBps = computed(() => {
  const pts = windowPoints.value;
  if (!pts.length) return 1000;
  return Math.max(...pts.map((p) => p.y));
});

const windowFloorCash = computed(() => {
  if (!repayWindowNum.value) return null;
  let minP = Infinity;
  for (const p of windowPoints.value) {
    const px = priceForYield(repayWindowNum.value, p.y, p.d);
    if (px < minP) minP = px;
  }
  return Number.isFinite(minP) ? minP : null;
});

const principalNum = computed(() => {
  if (pricing.value === "window") {
    const custom = Number(minCashText.value);
    if (minCashText.value.trim() !== "" && Number.isFinite(custom) && custom > 0) return custom;
    return windowFloorCash.value;
  }
  return borrowNum.value;
});

const repaymentNum = computed(() => {
  if (pricing.value === "window") return repayWindowNum.value;
  if (borrowNum.value == null || aprBps.value == null) return null;
  return repaymentFor(borrowNum.value, aprBps.value, effectiveD.value, market.value);
});

const minCashTooHigh = computed(() => {
  if (pricing.value !== "window") return false;
  const custom = Number(minCashText.value);
  if (minCashText.value.trim() === "" || !Number.isFinite(custom)) return false;
  return windowFloorCash.value != null && custom > windowFloorCash.value * 1.0001;
});

const ergColNum = computed(() => {
  const n = Number(ergColText.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
});

const usdColNum = computed(() => {
  const n = Number(usdColText.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
});

const hasCurrencyCol = computed(() => ergColNum.value > 0 || usdColNum.value > 0);

const collateralObj = computed(() => ({
  erg: ergColNum.value,
  usd: usdColNum.value,
  tokens: extraTokens.value.map((t) => ({
    id: t.id,
    ticker: t.ticker,
    name: t.name ?? null,
    amount: t.amount,
    rawAmount: String(t.amount),
    decimals: t.decimals,
    kind: (t.kind === "receipt" ? "receipt" : "token") as "receipt" | "token"
  }))
}));

const ratioNum = computed(() => {
  const n = Number(ratioText.value);
  return Number.isFinite(n) ? Math.max(125, n) : 150;
});

const guardNum = computed(() => {
  if (rule.value !== "oracle" || !fillGuardOn.value) return null;
  const n = Number(fillGuardText.value);
  return Number.isFinite(n) ? Math.max(125, n) : null;
});

const coverPct = computed(() => {
  if (rule.value !== "oracle" || !(oraclePrice.value > 0) || !(repaymentNum.value && repaymentNum.value > 0)) {
    return null;
  }
  if (!hasCurrencyCol.value) return null;
  return coverage(collateralObj.value, repaymentNum.value, market.value, oraclePrice.value);
});

const liq = computed(() =>
  rule.value === "oracle" && repaymentNum.value && hasCurrencyCol.value
    ? liquidationPrice(collateralObj.value, repaymentNum.value, market.value, ratioNum.value)
    : null
);

function setCoverPreset(pct: number) {
  if (!(oraclePrice.value > 0) || !(repaymentNum.value && repaymentNum.value > 0)) return;
  const debtUsd = market.value === "ERG" ? repaymentNum.value * oraclePrice.value : repaymentNum.value;
  const targetUsd = (debtUsd * pct) / 100;
  const curErgUsd = ergColNum.value * oraclePrice.value;
  const curUsd = usdColNum.value;
  const curTotal = curErgUsd + curUsd;

  if (ergColNum.value > 0 && usdColNum.value > 0 && curTotal > 0) {
    // Preserve the trader's current ERG / SigUSD split ratio
    const ergShare = curErgUsd / curTotal;
    const usdShare = 1 - ergShare;
    ergColText.value = String(Number(((targetUsd * ergShare) / oraclePrice.value).toFixed(3)));
    usdColText.value = String(Number((targetUsd * usdShare).toFixed(2)));
  } else if (curTotal > 0 && ergColNum.value > 0 && market.value === "ERG") {
    ergColText.value = String(Number((targetUsd / oraclePrice.value).toFixed(3)));
  } else if (curTotal > 0 && usdColNum.value > 0 && market.value === "SigUSD") {
    usdColText.value = String(Number(targetUsd.toFixed(2)));
  } else if (market.value === "ERG") {
    usdColText.value = String(Number(targetUsd.toFixed(2)));
    ergColText.value = "";
  } else {
    ergColText.value = String(Number((targetUsd / oraclePrice.value).toFixed(3)));
    usdColText.value = "";
  }
}

function splitCollateral() {
  if (!(oraclePrice.value > 0)) return;
  const curTotalUsd = ergColNum.value * oraclePrice.value + usdColNum.value;
  let totalUsd = curTotalUsd;
  if (!(totalUsd > 0) && repaymentNum.value && repaymentNum.value > 0) {
    const pct = Math.max(150, ratioNum.value, guardNum.value ?? 0);
    const debtUsd =
      market.value === "ERG" ? repaymentNum.value * oraclePrice.value : repaymentNum.value;
    totalUsd = (debtUsd * pct) / 100;
  }
  if (!(totalUsd > 0)) return;
  const halfUsd = totalUsd / 2;
  usdColText.value = String(Number(halfUsd.toFixed(2)));
  ergColText.value = String(Number((halfUsd / oraclePrice.value).toFixed(3)));
}

const collateralSummary = computed(() => {
  const parts: string[] = [];
  if (usdColNum.value > 0) parts.push(`${formatNumber(usdColNum.value, 2, 0)} SigUSD`);
  if (ergColNum.value > 0) parts.push(`${formatNumber(ergColNum.value, 3, 0)} ERG`);
  if (extraTokens.value.length > 0) {
    parts.push(`${extraTokens.value.length} token${extraTokens.value.length === 1 ? "" : "s"}`);
  }
  return parts.length ? parts.join(" + ") : "—";
});

const askById = computed(() => new Map(snap.value.asks.map((a) => [a.id, a])));
const bidLine = computed(() => snap.value.curves?.bidLine || []);
const feeBidLine = computed(() =>
  feeErg.value > 0 && repaymentNum.value
    ? buildFeeAdjustedBidLine(bidLine.value, snap.value.offers, repaymentNum.value, feeErg.value)
    : null
);

const bestBidAtTerm = computed(() => lineAt(bidLine.value, effectiveD.value));
const bestBidEffAtTerm = computed(() => {
  if (bestBidAtTerm.value == null) return null;
  if (feeErg.value > 0 && repaymentNum.value) {
    return feeAdjustedBidBps(repaymentNum.value, bestBidAtTerm.value, effectiveD.value, feeErg.value);
  }
  return bestBidAtTerm.value;
});

function snapToBestBid() {
  const b = bestBidEffAtTerm.value ?? bestBidAtTerm.value;
  if (b == null) return;
  const target = b + 2;
  if (pricing.value === "yield") {
    tp.value = { ...tp.value, y0: target, y1: Math.max(target, tp.value.y1) };
  } else {
    aprText.value = String(Number((target / 100).toFixed(2)));
  }
}

function dAt(at: number): number {
  if (timingMode.value === "term") return termBlocks.value;
  return Math.max(0, maturityHeight.value - at);
}

function bidAt(at: number): number | null {
  const d = dAt(at);
  return d > 0 ? lineAt(bidLine.value, d) : null;
}

const curveMarketOverlay = computed<CurveMarketOverlay>(() => ({
  bidLine: bidLine.value,
  askLine: windowAskLine(snap.value.curves, askById.value, height.value),
  askFit: combinedAskLine(snap.value.curves, askById.value, height.value),
  dots: fixedAskDots(snap.value.curves)
}));

const fullOverlay = computed<FullCurveOverlay | null>(() => {
  if (!repaymentNum.value || !(repaymentNum.value > 0)) return null;
  if (pricing.value === "window") {
    return {
      type: "curve",
      points: windowPoints.value,
      lo: winMinBlocks.value,
      hi: winMaxBlocks.value,
      cap: windowMaxCurveBps.value,
      face: repaymentNum.value,
      color: "var(--sf-ask)",
      label: "Your window curve"
    };
  }
  const face = repaymentNum.value;
  const maxAt =
    timingMode.value === "fixed"
      ? Math.max(expiryHeight.value, maturityHeight.value - MIN_MATURITY_BLOCKS)
      : expiryHeight.value;
  return {
    type: "point-path",
    dAt,
    aprAt: (at: number) => {
      const rem = dAt(at);
      if (!(rem > 0)) return null;
      if (pricing.value === "yield") {
        const { h0, y0, h1, y1 } = tp.value;
        const clamped = Math.min(Math.max(at, h0), h1);
        return y0 + ((y1 - y0) * (clamped - h0)) / Math.max(1, h1 - h0);
      }
      return principalNum.value ? yieldForPrice(face, principalNum.value, rem) : null;
    },
    priceAt: (at: number) => {
      const rem = dAt(at);
      if (!(rem > 0)) return null;
      if (pricing.value === "yield") {
        const { h0, y0, h1, y1 } = tp.value;
        const clamped = Math.min(Math.max(at, h0), h1);
        const bps = y0 + ((y1 - y0) * (clamped - h0)) / Math.max(1, h1 - h0);
        return priceForYield(face, bps, rem);
      }
      return principalNum.value;
    },
    expiry: expiryHeight.value,
    maxAt,
    face,
    color: "var(--sf-ask)",
    label: "Your borrow order"
  };
});

// Debounced live simulation
let simTimer: number | null = null;
let simAc: AbortController | null = null;

function buildDraft(useProbeCol = false) {
  const rep = repaymentNum.value;
  const prin = principalNum.value;
  if (!rep || !prin) return null;
  let col = collateralObj.value;
  if (useProbeCol && rule.value === "oracle" && !hasCurrencyCol.value && oraclePrice.value > 0) {
    const probe =
      market.value === "ERG"
        ? (rep * oraclePrice.value * Math.max(ratioNum.value, 160)) / 100
        : (rep * Math.max(ratioNum.value, 160)) / (100 * oraclePrice.value);
    col = {
      ...col,
      erg: market.value === "SigUSD" ? probe : 0.01,
      usd: market.value === "ERG" ? probe : 0
    };
  }
  return buildOrderBody({
    market: market.value,
    pricing: pricing.value,
    principal: prin,
    repayment: rep,
    mode: pricing.value === "window" ? "window" : timingMode.value,
    maturity: maturityHeight.value,
    exact: exactMaturity.value,
    duration: termBlocks.value,
    window: { min: winMinBlocks.value, max: winMaxBlocks.value },
    tp: pricing.value === "yield" ? tp.value : null,
    points: pricing.value === "window" ? windowPoints.value : null,
    cap: pricing.value === "window" ? windowMaxCurveBps.value : null,
    collateral: col,
    rule: rule.value,
    ratio: ratioNum.value,
    guard: guardNum.value,
    expiry: expiryHeight.value
  });
}

const simDeps = computed(() =>
  JSON.stringify({
    m: market.value,
    p: pricing.value,
    pr: principalNum.value,
    re: repaymentNum.value,
    tm: timingMode.value,
    mh: maturityHeight.value,
    tb: termBlocks.value,
    ex: expiryHeight.value,
    tp: tp.value,
    wp: windowPoints.value,
    ergCol: ergColNum.value,
    usdCol: usdColNum.value,
    rule: rule.value,
    rat: ratioNum.value,
    grd: guardNum.value,
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
        const res = await zcApi.simulate({ type: "order", ...body }, ac.signal);
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

const checks = computed(() => {
  const list: { label: string; ok: boolean }[] = [];
  list.push({
    label: principalNum.value && principalNum.value > 0 ? "Principal set" : "Enter borrow amount",
    ok: !!(principalNum.value && principalNum.value > 0)
  });
  if (pricing.value === "window") {
    list.push({
      label: minCashTooHigh.value ? "Min cash exceeds curve floor" : `${windowPoints.value.length}-pt curve valid`,
      ok: !minCashTooHigh.value && windowPoints.value.length >= 2
    });
  }
  if (rule.value === "oracle") {
    const req = Math.max(ratioNum.value, guardNum.value ?? 0);
    const hasCol = hasCurrencyCol.value && coverPct.value != null && coverPct.value >= req;
    list.push({
      label: !hasCurrencyCol.value
        ? "Add ERG or SigUSD collateral"
        : coverPct.value != null && coverPct.value < req
          ? `Cover ${Math.round(coverPct.value)}% < ${Math.round(req)}%`
          : `Cover ${Math.round(coverPct.value || 0)}% ≥ ${Math.round(req)}%`,
      ok: hasCol
    });
  } else {
    const hasAnyCol = hasCurrencyCol.value || extraTokens.value.length > 0;
    list.push({
      label: hasAnyCol ? "Maturity collateral set" : "Add collateral or NFTs",
      ok: hasAnyCol
    });
  }
  return list;
});

const canSubmit = computed(() => checks.value.every((c) => c.ok) && !!buildDraft(false));

const heroAprDisplay = computed(() => {
  if (pricing.value === "window") {
    const ys = windowPoints.value.map((p) => p.y);
    if (!ys.length) return "—";
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    return lo === hi ? formatApr(lo) : `${formatApr(lo)}–${formatApr(hi)}`;
  }
  if (pricing.value === "yield") {
    return tp.value.y0 === tp.value.y1
      ? formatApr(tp.value.y0)
      : `${formatApr(tp.value.y0)} → ${formatApr(tp.value.y1)}`;
  }
  return formatApr(aprBps.value);
});

const matchCount = computed(() => (sim.value?.offers?.length ?? sim.value?.matches?.length ?? 0));

function openPreview() {
  const body = buildDraft(false);
  if (!body) return;
  emit("preview", {
    title: "Post Borrow Order",
    subtitle: `${pricing.value === "window" ? "Variable maturity" : pricing.value === "yield" ? "Moving APR" : "Fixed rate"} · ${market.value} market`,
    badge: `Borrow · ${market.value}`,
    tone: "ask",
    heroLabel: pricing.value === "window" ? "Minimum cash received" : "You receive",
    heroValue: formatMarketAmount(principalNum.value, market.value),
    heroSub: `Repay ${formatMarketAmount(repaymentNum.value, market.value)} · ${heroAprDisplay.value}`,
    rows: [
      {
        label: "Maturity",
        value:
          pricing.value === "window"
            ? `${formatDur(winMinBlocks.value, unit.value)} – ${formatDur(winMaxBlocks.value, unit.value)}`
            : timingMode.value === "term"
              ? `${formatDur(termBlocks.value, unit.value)} from fill`
              : `${formatDur(effectiveD.value, unit.value)} (${dateAtHeight(maturityHeight.value, height.value)})`
      },
      {
        label: "Collateral",
        value: collateralSummary.value
      },
      {
        label: "Rule",
        value:
          rule.value === "oracle"
            ? `Oracle ≥ ${ratioNum.value}%${guardNum.value ? ` · Guard ≥ ${guardNum.value}%` : ""}`
            : "Maturity only"
      },
      {
        label: "Order expires",
        value: `${formatDur(expiryHeight.value - height.value, unit.value)} (${dateAtHeight(expiryHeight.value, height.value)})`
      },
      {
        label: "Immediate matches",
        value:
          matchCount.value > 0
            ? `${matchCount.value} offer${matchCount.value === 1 ? "" : "s"} ready`
            : sim.value?.refusal || "Rests on book",
        tone: matchCount.value > 0 ? "bid" : "default"
      }
    ],
    rawSummary: { action: "createOrder", ...body }
  });
}
</script>

<template>
  <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_348px]">
    <!-- LEFT WORKBENCH -->
    <div class="flex min-h-0 flex-col gap-2.5">
      <!-- Parameters & Collateral Deck -->
      <section class="sf-terminal-plate shrink-0 rounded-[18px] rounded-tl-[6px] p-3">
        <!-- Row 1: Pricing mode + primary terms -->
        <div class="flex flex-wrap items-center justify-between gap-2 pb-2.5">
          <div class="sf-seg" role="tablist" aria-label="Borrow pricing mode">
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-2.5 !text-[11.5px]"
              :class="pricing === 'fixed' ? 'is-active tone-ask' : ''"
              @click="pricing = 'fixed'"
            >
              Fixed
            </button>
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-2.5 !text-[11.5px]"
              :class="pricing === 'yield' ? 'is-active tone-ask' : ''"
              @click="pricing = 'yield'"
            >
              Moving APR
            </button>
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-2.5 !text-[11.5px]"
              :class="pricing === 'window' ? 'is-active tone-ask' : ''"
              @click="pricing = 'window'"
            >
              Variable Maturity
            </button>
          </div>

          <div class="flex items-center gap-1.5">
            <button
              v-if="pricing !== 'window' && (bestBidEffAtTerm != null || bestBidAtTerm != null)"
              type="button"
              class="sf-mono inline-flex h-7 items-center gap-1 rounded-lg border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] px-2.5 text-[10.5px] font-semibold text-[color:var(--sf-bid)] transition-all hover:brightness-110 active:scale-95"
              @click="snapToBestBid"
            >
              <zap-icon class="h-3 w-3" />
              <span>
                Best bid{{ feeErg > 0 ? " (w/ fee)" : "" }}
                {{ formatApr(bestBidEffAtTerm ?? bestBidAtTerm) }}
              </span>
            </button>

            <button
              v-if="pricing !== 'window'"
              type="button"
              class="sf-mono h-7 rounded-lg border px-2 text-[10.5px] font-semibold transition-colors"
              :class="
                timingMode === 'fixed' && !exactMaturity
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              :disabled="timingMode === 'term'"
              title="Snap maturity date to the 360-block liquidity grid"
              @click="exactMaturity = !exactMaturity"
            >
              {{ timingMode === "term" ? "From fill" : exactMaturity ? "Exact date" : "Grid snap" }}
            </button>
          </div>
        </div>

        <!-- Primary Term Inputs -->
        <div
          v-if="pricing !== 'window'"
          class="grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Borrow
            </label>
            <div class="sf-input-well flex h-9 items-center gap-1.5 rounded-xl px-2.5" data-tone="ask">
              <input
                v-model="borrowText"
                inputmode="decimal"
                placeholder="100"
                class="sf-mono w-full min-w-0 bg-transparent text-[13.5px] font-semibold text-[color:var(--sf-ink)] outline-none"
              />
              <span class="sf-mono shrink-0 text-[10.5px] font-semibold text-[color:var(--sf-muted)]">
                {{ market }}
              </span>
            </div>
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              {{ pricing === "fixed" ? "APR" : "Start → End APR" }}
            </label>
            <div
              v-if="pricing === 'fixed'"
              class="sf-input-well flex h-9 items-center gap-1.5 rounded-xl px-2.5"
              data-tone="ask"
            >
              <input
                v-model="aprText"
                inputmode="decimal"
                placeholder="8.0"
                class="sf-mono w-full min-w-0 bg-transparent text-[13.5px] font-semibold text-[color:var(--sf-ink)] outline-none"
              />
              <span class="sf-mono shrink-0 text-[10.5px] font-semibold text-[color:var(--sf-muted)]">
                %
              </span>
            </div>
            <div
              v-else
              class="sf-dock-well flex h-9 items-center justify-between rounded-xl px-2.5"
            >
              <span class="sf-mono text-[12px] font-bold text-[color:var(--sf-ask)]">
                {{ formatApr(tp.y0) }}
              </span>
              <span class="sf-mono text-[10px] text-[color:var(--sf-dim)]">→</span>
              <span class="sf-mono text-[12px] font-bold text-[color:var(--sf-ask)]">
                {{ formatApr(tp.y1) }}
              </span>
            </div>
          </div>

          <div>
            <div class="mb-1 flex items-center justify-between">
              <label class="sf-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Maturity
              </label>
              <button
                type="button"
                class="sf-mono text-[9.5px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                @click="timingMode = timingMode === 'fixed' ? 'term' : 'fixed'"
              >
                {{ timingMode === "fixed" ? "Date" : "From fill" }}
              </button>
            </div>
            <zc-dur-input
              v-model="maturityDays"
              :unit="unit"
              of="days"
              tone="ask"
              aria-label="Maturity duration"
            />
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Expires
            </label>
            <zc-dur-input
              v-model="expiryDays"
              :unit="unit"
              of="days"
              tone="cobalt"
              aria-label="Order expiry"
            />
          </div>
        </div>

        <!-- Variable Maturity Inputs -->
        <div v-else class="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Repay
            </label>
            <div class="sf-input-well flex h-9 items-center gap-1.5 rounded-xl px-2.5" data-tone="ask">
              <input
                v-model="repayWindowText"
                inputmode="decimal"
                placeholder="105"
                class="sf-mono w-full min-w-0 bg-transparent text-[13.5px] font-semibold text-[color:var(--sf-ink)] outline-none"
              />
              <span class="sf-mono shrink-0 text-[10px] font-semibold text-[color:var(--sf-muted)]">
                {{ market }}
              </span>
            </div>
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Shortest
            </label>
            <zc-dur-input v-model="winMinDays" :unit="unit" of="days" tone="ask" />
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Longest
            </label>
            <zc-dur-input v-model="winMaxDays" :unit="unit" of="days" tone="ask" />
          </div>

          <div>
            <label
              class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em]"
              :class="minCashTooHigh ? 'text-[color:var(--sf-danger)]' : 'text-[color:var(--sf-muted)]'"
            >
              Min cash
            </label>
            <div
              class="sf-input-well flex h-9 items-center gap-1.5 rounded-xl px-2.5"
              :data-tone="minCashTooHigh ? 'ask' : 'cobalt'"
            >
              <input
                v-model="minCashText"
                inputmode="decimal"
                :placeholder="windowFloorCash != null ? formatNumber(windowFloorCash, 2, 0) : 'auto'"
                class="sf-mono w-full min-w-0 bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
              />
            </div>
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Expires
            </label>
            <zc-dur-input v-model="expiryDays" :unit="unit" of="days" tone="cobalt" />
          </div>
        </div>

        <!-- Row 2: Dual Collateral (Counter + Market Currency) & Risk Strip -->
        <div class="mt-2.5 grid grid-cols-1 items-end gap-2.5 border-t border-[color:var(--sf-line)] pt-2.5 lg:grid-cols-[1.35fr_1fr]">
          <!-- Dual Collateral Inputs + Quick Cover Presets + Split 50/50 + Meter -->
          <div class="flex flex-col gap-1.5">
            <div class="flex flex-wrap items-center justify-between gap-1.5">
              <div class="flex items-center gap-2">
                <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                  Collateral
                </span>
                <cover-meter
                  :value="coverPct"
                  :ratio="rule === 'oracle' ? ratioNum : null"
                  :guard="guardNum"
                  compact
                />
                <span
                  v-if="liq"
                  class="sf-mono text-[10px] font-semibold"
                  :class="
                    liq.dir === 'never'
                      ? 'text-[color:var(--sf-bid)]'
                      : liq.dir === 'now'
                        ? 'text-[color:var(--sf-danger)]'
                        : 'text-[color:var(--sf-muted)]'
                  "
                >
                  {{
                    liq.dir === "never"
                      ? "No liq price"
                      : liq.dir === "now"
                        ? "Liquidatable"
                        : liq.price != null
                          ? `Liq ${liq.dir === "below" ? "≤" : "≥"} $${liq.price.toFixed(3)}`
                          : ""
                  }}
                </span>
              </div>

              <div v-if="rule === 'oracle'" class="flex flex-wrap items-center gap-1">
                <button
                  v-for="p in [125, 150, 175, 200]"
                  :key="p"
                  type="button"
                  class="sf-mono rounded px-1.5 py-0.5 text-[9.5px] font-semibold transition-colors"
                  :class="
                    coverPct != null && Math.abs(coverPct - p) < 3
                      ? 'bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                      : 'bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
                  "
                  @click="setCoverPreset(p)"
                >
                  {{ p }}%
                </button>
                <button
                  type="button"
                  class="sf-mono rounded border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[color:var(--sf-cobalt)] transition-all hover:brightness-110 active:scale-95"
                  title="Split collateral 50/50 between SigUSD and ERG"
                  @click="splitCollateral"
                >
                  Split 50/50
                </button>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2">
              <!-- Counter-currency input first, borrowed market currency second -->
              <div
                class="sf-input-well flex h-9 items-center gap-1.5 rounded-xl px-2.5"
                :data-tone="market === 'ERG' ? 'cobalt' : 'ask'"
              >
                <market-coin market="SigUSD" :size="15" />
                <input
                  v-model="usdColText"
                  inputmode="decimal"
                  placeholder="0.00"
                  aria-label="SigUSD collateral"
                  class="sf-mono w-full min-w-0 bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] outline-none"
                />
                <span class="sf-mono shrink-0 text-[10px] font-semibold text-[color:var(--sf-muted)]">
                  SigUSD<span v-if="market === 'SigUSD'" class="text-[color:var(--sf-dim)]"> · debt</span>
                </span>
              </div>

              <div
                class="sf-input-well flex h-9 items-center gap-1.5 rounded-xl px-2.5"
                :data-tone="market === 'SigUSD' ? 'cobalt' : 'ask'"
              >
                <market-coin market="ERG" :size="15" />
                <input
                  v-model="ergColText"
                  inputmode="decimal"
                  placeholder="0.00"
                  aria-label="ERG collateral"
                  class="sf-mono w-full min-w-0 bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] outline-none"
                />
                <span class="sf-mono shrink-0 text-[10px] font-semibold text-[color:var(--sf-muted)]">
                  ERG<span v-if="market === 'ERG'" class="text-[color:var(--sf-dim)]"> · debt</span>
                </span>
              </div>
            </div>
          </div>

          <!-- Rule / Liq ratio / Fill guard / Extra tokens -->
          <div class="flex flex-wrap items-end justify-between gap-2">
            <div class="flex items-center gap-2">
              <div class="sf-seg" role="tablist" aria-label="Liquidation rule">
                <button
                  type="button"
                  class="sf-seg-btn !h-7 !px-2 !text-[10.5px]"
                  :class="rule === 'oracle' ? 'is-active tone-cobalt' : ''"
                  @click="rule = 'oracle'"
                >
                  Oracle
                </button>
                <button
                  type="button"
                  class="sf-seg-btn !h-7 !px-2 !text-[10.5px]"
                  :class="rule === 'maturity' ? 'is-active tone-cobalt' : ''"
                  @click="rule = 'maturity'"
                >
                  Maturity
                </button>
              </div>

              <template v-if="rule === 'oracle'">
                <div
                  class="sf-input-well flex h-7 w-[76px] items-center gap-1 rounded-lg px-2"
                  data-tone="cobalt"
                  title="Liquidation cover ratio (min 125%)"
                >
                  <span class="sf-mono text-[9.5px] text-[color:var(--sf-dim)]">Liq</span>
                  <input
                    v-model="ratioText"
                    inputmode="decimal"
                    class="sf-mono w-full min-w-0 bg-transparent text-right text-[11.5px] font-semibold text-[color:var(--sf-ink)] outline-none"
                  />
                  <span class="sf-mono text-[9.5px] text-[color:var(--sf-muted)]">%</span>
                </div>

                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    class="sf-mono h-7 rounded-lg border px-2 text-[10px] font-semibold transition-colors"
                    :class="
                      fillGuardOn
                        ? 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                        : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)]'
                    "
                    @click="fillGuardOn = !fillGuardOn"
                  >
                    Guard
                  </button>
                  <div
                    v-if="fillGuardOn"
                    class="sf-input-well flex h-7 w-[64px] items-center gap-0.5 rounded-lg px-1.5"
                    data-tone="ask"
                  >
                    <input
                      v-model="fillGuardText"
                      inputmode="decimal"
                      class="sf-mono w-full min-w-0 bg-transparent text-right text-[11.5px] font-semibold text-[color:var(--sf-ink)] outline-none"
                    />
                    <span class="sf-mono text-[9.5px] text-[color:var(--sf-muted)]">%</span>
                  </div>
                </div>
              </template>
            </div>

            <button
              type="button"
              class="sf-mono inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[10.5px] font-semibold transition-colors"
              :class="
                extraTokensOpen || extraTokens.length > 0
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="extraTokensOpen = !extraTokensOpen"
            >
              <layers-icon class="h-3 w-3" />
              <span>Tokens{{ extraTokens.length ? ` (${extraTokens.length})` : "" }}</span>
              <chevron-up-icon v-if="extraTokensOpen" class="h-3 w-3" />
              <chevron-down-icon v-else class="h-3 w-3" />
            </button>
          </div>
        </div>

        <!-- Collapsible Extra Collateral Token Picker -->
        <div v-if="extraTokensOpen" class="mt-2.5 border-t border-[color:var(--sf-line)] pt-2.5">
          <zc-token-picker
            v-model="extraTokens"
            :exclude-ids="[SIGUSD_TOKEN_ID]"
            compact
            show-wrap-action
            tone="ask"
            @wrap="emit('wrap-token', $event)"
          />
        </div>
      </section>

      <!-- Chart Plate -->
      <section class="sf-terminal-plate flex min-h-[290px] flex-1 flex-col rounded-[20px] rounded-bl-[6px] p-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div class="sf-seg" role="tablist" aria-label="Chart view">
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
              :class="chartTab === 'edit' ? 'is-active tone-ask' : ''"
              @click="chartTab = 'edit'"
            >
              {{ pricing === "window" ? "Edit Curve" : "Over Fill Time" }}
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
            {{
              pricing === "window"
                ? `${formatDur(winMinBlocks, unit)} – ${formatDur(winMaxBlocks, unit)}`
                : timingMode === "fixed"
                  ? `Matures ${dateAtHeight(maturityHeight, height)}`
                  : `${formatDur(termBlocks, unit)} from fill`
            }}
          </span>
        </div>

        <div class="flex min-h-0 flex-1 flex-col">
          <template v-if="chartTab === 'edit'">
            <zc-curve-editor
              v-if="pricing === 'window'"
              :points="windowPoints"
              :lo="winMinBlocks"
              :hi="winMaxBlocks"
              side="window"
              :market="curveMarketOverlay"
              :cap="windowMaxCurveBps"
              :face="repaymentNum || 100"
              :asset="market"
              :metric="metric"
              :fee-bid-line="feeBidLine"
              :fee-erg="feeErg"
              :height="height"
              :unit="unit"
              fill-height
              @update:points="windowPoints = $event"
              @update:metric="metric = $event"
            />
            <zc-time-editor
              v-else-if="pricing === 'yield'"
              :tp="tp"
              :height="height"
              :end="expiryHeight"
              :d-at="dAt"
              :face="repaymentNum || 100"
              :bid-at="bidAt"
              :asset="market"
              :fee-erg="feeErg"
              :metric="metric"
              :unit="unit"
              role="borrow"
              fill-height
              @update:tp="tp = $event"
              @update:metric="metric = $event"
            />
            <zc-fixed-chart
              v-else
              :principal="principalNum || 100"
              :repayment="repaymentNum || 105"
              :height="height"
              :expiry-h="expiryHeight"
              :d-at="dAt"
              :bid-at="bidAt"
              :asset="market"
              :fee-erg="feeErg"
              :metric="metric"
              :unit="unit"
              role="borrow"
              pay-label="You receive"
              fill-height
              @update:metric="metric = $event"
            />
          </template>

          <zc-full-yield-curve-compare
            v-else
            :market="market"
            :height="height"
            :unit="unit"
            :connected="zc.connected"
            :revision="zc.revision"
            :cover="coverPct ?? (rule === 'oracle' ? ratioNum : null)"
            :overlay="fullOverlay"
            :at-height="scrubHeight"
            role="borrow"
            :fee-erg="feeErg"
            :refusal="sim?.refusal || null"
            :match-count="matchCount"
            :metric="metric"
            fill-height
            @update:at-height="scrubHeight = $event"
            @update:metric="metric = $event"
          />
        </div>
      </section>
    </div>

    <!-- RIGHT ACTION DOCK -->
    <aside
      class="sf-action-dock flex h-full min-h-0 flex-col rounded-[22px] rounded-tr-[6px]"
      data-tone="ask"
      aria-label="Borrow Order Ticket"
      @mousemove="onDockPointerMove"
    >
      <div class="sf-panel-head shrink-0 px-4 pt-3.5 pb-3">
        <div class="flex items-center justify-between gap-2">
          <span class="sf-mono rounded-[4px] border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-ask)]">
            Borrow · {{ market }}
          </span>
          <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">
            {{ pricing === "window" ? "Window curve" : pricing === "yield" ? "Moving APR" : "Fixed" }}
          </span>
        </div>

        <div class="mt-2.5">
          <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            {{ pricing === "window" ? "Min cash received" : "You receive" }}
          </div>
          <div class="sf-serif mt-0.5 text-[32px] font-semibold leading-none text-[color:var(--sf-ask)]">
            {{ formatMarketAmount(principalNum, market) }}
          </div>
          <div class="sf-mono mt-1 text-[11.5px] text-[color:var(--sf-ink-2)]">
            Repay {{ formatMarketAmount(repaymentNum, market) }}
          </div>
        </div>
      </div>

      <div class="sf-scroll flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        <!-- 2x2 Summary Grid -->
        <div class="grid grid-cols-2 gap-2">
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              APR
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ask)]">
              {{ heroAprDisplay }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Matures
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
              {{
                pricing === "window"
                  ? `${formatDur(winMinBlocks, unit)}–${formatDur(winMaxBlocks, unit)}`
                  : formatDur(effectiveD, unit)
              }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Cover
            </div>
            <div
              class="sf-mono mt-0.5 text-[13px] font-bold"
              :class="
                coverPct == null
                  ? 'text-[color:var(--sf-muted)]'
                  : coverPct >= ratioNum
                    ? 'text-[color:var(--sf-bid)]'
                    : 'text-[color:var(--sf-danger)]'
              "
            >
              {{ rule === "oracle" ? (coverPct != null ? `${Math.round(coverPct)}%` : "—") : "Maturity" }}
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

        <!-- Live Match Status -->
        <div
          class="rounded-xl border px-3 py-2.5"
          :class="
            matchCount > 0
              ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)]'
              : sim?.refusal
                ? 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)]'
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
            :class="
              matchCount > 0
                ? 'text-[color:var(--sf-bid)]'
                : sim?.refusal
                  ? 'text-[color:var(--sf-ask)]'
                  : 'text-[color:var(--sf-ink)]'
            "
          >
            {{
              matchCount > 0
                ? `${matchCount} lend offer${matchCount === 1 ? "" : "s"} can fill immediately`
                : sim?.refusal || "Rests as an open ask on the yield curve"
            }}
          </div>
        </div>

        <!-- Verification Checklist -->
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

      <!-- Pinned Footer CTA -->
      <div class="shrink-0 border-t border-[color:var(--sf-line)] p-3.5">
        <button
          type="button"
          class="sf-btn-ask flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
          :disabled="!canSubmit"
          @click="openPreview"
        >
          <span>Post Borrow Order</span>
          <arrow-right-icon class="h-4 w-4" />
        </button>
      </div>
    </aside>
  </div>
</template>
