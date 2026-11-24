<script setup lang="ts">
import { decimalize } from "@fleet-sdk/common";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  RefreshCwIcon,
  ShieldIcon,
  XIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ExecutionPreviewPayload } from "./ExecutionPreviewModal.vue";
import ZcOrderMark from "./ZcOrderMark.vue";
import ZcSelect, { ZcSelectOption } from "./ZcSelect.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { ERG_DECIMALS, ERG_TOKEN_ID } from "@/constants";
import {
  buildAskBody,
  buildOfferBody,
  buildOrderBody,
  buildWalletLendDraft,
  zcApi
} from "@/services/zcApi";
import { useWalletStore, useZcStore } from "@/stories";
import {
  ZcAskSummary,
  ZcCurves,
  ZcDurationUnit,
  ZcMarket,
  ZcOrderbook,
  ZcPortfolioPosition,
  ZcSimulateResponse
} from "@/types/zc";
import { shortenString } from "@/utils";
import {
  collateralFor,
  coverage,
  dateAtHeight,
  DAY_BLOCKS,
  DEFAULT_COVER,
  formatApr,
  formatDur,
  formatDurLong,
  formatMarketAmount,
  formatNumber,
  fromErg,
  fromMarket,
  kindLabel,
  lineAt,
  liquidationPrice,
  MIN_MATURITY_BLOCKS,
  priceForYield,
  repaymentFor,
  roundDown,
  roundUp,
  SHARES_UNITS,
  SIGUSD_TOKEN_ID,
  snapMaturity,
  yieldForPrice
} from "@/utils/zcMath";

const TERMS = [7, 30, 60, 90, 180, 365] as const;
const COVERS = [125, 150, 175, 200] as const;

export type SimpleSidebarSide = "lend" | "borrow" | "sell";

export interface SimpleSidebarPrefill {
  seq: number;
  side: SimpleSidebarSide;
  days?: number;
  cover?: number;
  aprPct?: number | null;
  matchOfferId?: string | null;
}

const props = withDefaults(
  defineProps<{
    market: ZcMarket;
    height: number;
    oraclePrice: number;
    oracleRefreshing: boolean;
    connected: boolean;
    revision: number;
    refreshSeq: number;
    unit: ZcDurationUnit;
    prefill?: SimpleSidebarPrefill | null;
  }>(),
  {
    prefill: null
  }
);

const emit = defineEmits<{
  (e: "preview", payload: ExecutionPreviewPayload): void;
}>();

const zc = useZcStore();
const wallet = useWalletStore();

const side = ref<SimpleSidebarSide>("lend");
const amountText = ref<string>("");
const tenor = ref<number>(90);
const cover = ref<number>(DEFAULT_COVER);
const aprIn = ref<number | null>(null);
const sellAprIn = ref<number | null>(null);
const selectedPosId = ref<string>("");
const matchedOfferId = ref<string | null>(null);
const pulseRing = ref(false);
let pulseTimer: number | null = null;

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

function triggerHighlight() {
  pulseRing.value = true;
  if (pulseTimer !== null) window.clearTimeout(pulseTimer);
  pulseTimer = window.setTimeout(() => {
    pulseRing.value = false;
  }, 1100);
}

watch(
  () => props.prefill?.seq,
  () => {
    const pf = props.prefill;
    if (!pf) return;
    side.value = pf.side;
    if (pf.days && pf.days >= 1) {
      tenor.value = TERMS.reduce((a, b) =>
        Math.abs(b - pf.days!) < Math.abs(a - pf.days!) ? b : a
      );
    }
    if (pf.cover && pf.cover >= 125) {
      const closestCov = COVERS.find((c) => c >= pf.cover!) ?? COVERS[COVERS.length - 1];
      cover.value = closestCov;
    }
    if (pf.side === "borrow" && pf.aprPct !== undefined) {
      aprIn.value = pf.aprPct;
    }
    if (pf.side === "sell" && pf.aprPct !== undefined) {
      sellAprIn.value = pf.aprPct;
    }
    matchedOfferId.value = pf.matchOfferId ?? null;
    triggerHighlight();
  }
);

watch(
  () => props.market,
  () => {
    aprIn.value = null;
    sellAprIn.value = null;
    matchedOfferId.value = null;
  }
);

const amount = computed<number | null>(() => {
  if (!amountText.value.trim()) return null;
  const n = Number(amountText.value);
  return Number.isFinite(n) && n > 0 ? n : null;
});

const T = computed(() => tenor.value * DAY_BLOCKS);
const maturity = computed(() =>
  props.height > 0 ? snapMaturity(props.height + T.value, props.height) : T.value
);
const D = computed(() =>
  props.height > 0 ? Math.max(DAY_BLOCKS, maturity.value - props.height) : T.value
);

// Wallet balances (live Nautilus or Demo portfolio)
const walletErg = computed<number>(() => {
  if (zc.demoMode) return zc.portfolio.walletErg;
  if (!wallet.connected) return 0;
  const raw = wallet.balance.find((x) => x.tokenId === ERG_TOKEN_ID)?.amount ?? 0n;
  return Number(decimalize(raw, { decimals: ERG_DECIMALS }));
});

const walletSigUsd = computed<number>(() => {
  if (zc.demoMode) return zc.portfolio.walletSigUsd;
  if (!wallet.connected) return 0;
  const raw = wallet.balance.find((x) => x.tokenId.toLowerCase() === SIGUSD_TOKEN_ID)?.amount ?? 0n;
  return Number(raw) / 100;
});

const walletReady = computed(() => wallet.connected || zc.demoMode);
const walletFor = (m: ZcMarket) => (m === "ERG" ? walletErg.value : walletSigUsd.value);
const marketBalance = computed(() => walletFor(props.market));

// Live market curve, book & asks scoped to the sidebar's cover & tenor (matches Simple.js)
const sideCurves = ref<ZcCurves | null>(null);
const sideBook = ref<ZcOrderbook | null>(null);
const sideAsks = ref<ZcAskSummary[]>([]);
const lendSim = ref<ZcSimulateResponse | null>(null);
const simLoading = ref(false);

let ctxAc: AbortController | null = null;

async function fetchSidebarMarket() {
  if (ctxAc) ctxAc.abort();
  if (!props.connected) {
    sideCurves.value = null;
    sideBook.value = null;
    sideAsks.value = [];
    return;
  }

  const ac = new AbortController();
  ctxAc = ac;
  const m = props.market;
  const covBps = Math.round(cover.value * 100);
  const matchable = !props.oracleRefreshing;

  try {
    const [curvesRes, bookRes, asksRes] = await Promise.all([
      zcApi.getCurves(m, { coverage: covBps, kind: "all", matchable, grid: false }, ac.signal),
      zcApi.getOrderbook(
        m,
        side.value === "lend"
          ? { coverage: covBps, kind: "all", matchable, grid: false, to: T.value }
          : { coverage: covBps, kind: "all", matchable, grid: false, around: Math.max(DAY_BLOCKS, D.value) },
        ac.signal
      ),
      side.value === "lend"
        ? zcApi.listAsks(
            m,
            {
              coverage: covBps,
              kind: "all",
              matchable,
              from: MIN_MATURITY_BLOCKS,
              to: T.value,
              sort: "apr",
              limit: 24
            },
            ac.signal
          )
        : Promise.resolve([])
    ]);
    if (ac.signal.aborted) return;
    sideCurves.value = curvesRes;
    sideBook.value = bookRes;
    sideAsks.value = asksRes;
  } catch {
    // keep prior snapshot on transient error
  }
}

watch(
  [
    () => props.connected,
    () => props.revision,
    () => props.refreshSeq,
    () => props.market,
    () => props.oracleRefreshing,
    side,
    tenor,
    cover
  ],
  () => {
    void fetchSidebarMarket();
  },
  { immediate: true }
);

// Debounced live simulation for "Lend now"
let simTimer: number | null = null;
let simAc: AbortController | null = null;
let simSeq = 0;

watch(
  [
    () => props.connected,
    () => props.revision,
    () => props.refreshSeq,
    () => props.market,
    side,
    amount,
    tenor,
    cover
  ],
  () => {
    if (simTimer !== null) window.clearTimeout(simTimer);
    if (simAc) simAc.abort();

    if (!props.connected || side.value !== "lend" || !amount.value) {
      lendSim.value = null;
      simLoading.value = false;
      return;
    }

    const draft = buildWalletLendDraft({
      market: props.market,
      amount: amount.value,
      to: T.value,
      coverage: cover.value
    });
    if (!draft) {
      lendSim.value = null;
      simLoading.value = false;
      return;
    }

    const mySeq = ++simSeq;
    simLoading.value = true;
    simTimer = window.setTimeout(async () => {
      const ac = new AbortController();
      simAc = ac;
      try {
        const res = await zcApi.simulate(draft, ac.signal);
        if (mySeq === simSeq && !ac.signal.aborted) lendSim.value = res;
      } catch {
        // ignore transient error
      } finally {
        if (mySeq === simSeq) simLoading.value = false;
      }
    }, 260);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  ctxAc?.abort();
  simAc?.abort();
  if (simTimer !== null) window.clearTimeout(simTimer);
  if (pulseTimer !== null) window.clearTimeout(pulseTimer);
});

const activeCurves = computed<ZcCurves | null>(
  () => sideCurves.value || zc.markets[props.market].curves
);

const askById = computed(() => new Map(sideAsks.value.map((a) => [a.id, a])));
const obAskById = computed(() => new Map((sideBook.value?.asks || []).map((a) => [a.id, a])));

// ── LEND PLAN ────────────────────────────────────────────────────────────────
const lendPlan = computed(() => {
  const m = props.market;
  const matches = lendSim.value?.matches || [];
  const take = matches.map((mt) => {
    const a = askById.value.get(mt.counterpartyId);
    const ob = obAskById.value.get(mt.counterpartyId);
    const kind = a?.kind || ob?.kind || "order";
    const cost = fromMarket(mt.cost, m) ?? 0;
    const face = fromMarket(mt.face, m) ?? 0;
    const d = Math.max(1, (mt.maturity ?? props.height + DAY_BLOCKS) - props.height);
    return {
      id: mt.counterpartyId,
      kind,
      label: kindLabel(kind),
      units: a?.units ?? Number(mt.units || 1),
      rawUnits: mt.units ? BigInt(mt.units) : null,
      expectedCostRaw: mt.cost ? BigInt(mt.cost) : 0n,
      cost,
      face,
      yieldBps: mt.yieldBps,
      d
    };
  });

  const spent =
    lendSim.value?.filled != null
      ? fromMarket(lendSim.value.filled, m) ?? 0
      : take.reduce((acc, x) => acc + x.cost, 0);
  const totalFace = take.reduce((acc, x) => acc + x.face, 0);
  const interest = Math.max(0, totalFace - spent);
  const avgBps =
    spent > 0 ? take.reduce((acc, x) => acc + x.cost * (x.yieldBps ?? 0), 0) / spent : null;
  const bestBps = sideBook.value?.bestAsk ?? sideAsks.value[0]?.quote?.yieldBps ?? null;
  return { take, spent, totalFace, interest, avgBps, bestBps };
});

const offerRateBps = computed(() => {
  const bid = activeCurves.value ? lineAt(activeCurves.value.bidLine, T.value) : null;
  return Math.round(bid ?? 800);
});

const defaultOfferExpBlocks = computed(() => Number(zc.defaults.offerExpiryBlocks) || 5040);
const defaultBatcherFee = computed(
  () => fromErg(zc.defaults.batcherFeeNanoErg ?? "5000000") ?? 0.005
);
const defaultOfferOracleAge = computed(() => Number(zc.defaults.offerOracleAge) || 30);

const offerBody = computed(() => {
  if (!amount.value || !props.height) return null;
  return buildOfferBody({
    market: props.market,
    capital: amount.value,
    minYield: offerRateBps.value,
    points: [
      { d: MIN_MATURITY_BLOCKS, y: offerRateBps.value },
      { d: Math.max(2 * MIN_MATURITY_BLOCKS, T.value), y: offerRateBps.value }
    ],
    minBlocks: MIN_MATURITY_BLOCKS,
    maxBlocks: T.value,
    floor: cover.value,
    oracleAge: defaultOfferOracleAge.value,
    fee: defaultBatcherFee.value,
    expiry: props.height + defaultOfferExpBlocks.value,
    delivery: "unit",
    shares: null
  });
});

// ── BORROW CALCULATIONS ──────────────────────────────────────────────────────
const borrowBidBps = computed(() =>
  activeCurves.value ? lineAt(activeCurves.value.bidLine, D.value) : null
);
const autoBorrowBps = computed(() =>
  borrowBidBps.value == null ? null : Math.ceil(borrowBidBps.value) + 1
);
const targetBorrowBps = computed(() =>
  aprIn.value != null ? Math.round(aprIn.value * 100) : autoBorrowBps.value
);
const borrowRepayment = computed(() =>
  amount.value && targetBorrowBps.value != null
    ? repaymentFor(amount.value, targetBorrowBps.value, D.value, props.market)
    : null
);
const borrowEffBps = computed(() =>
  borrowRepayment.value && amount.value
    ? yieldForPrice(borrowRepayment.value, amount.value, D.value)
    : targetBorrowBps.value
);
const aprShifted = computed(
  () =>
    targetBorrowBps.value != null &&
    borrowEffBps.value != null &&
    Math.abs(borrowEffBps.value - targetBorrowBps.value) >= 5
);
const collAsset = computed<ZcMarket>(() => (props.market === "ERG" ? "SigUSD" : "ERG"));
const collAmount = computed(() =>
  borrowRepayment.value && props.oraclePrice > 0
    ? roundUp(
        collateralFor(borrowRepayment.value, props.market, cover.value + 10, props.oraclePrice),
        collAsset.value
      )
    : null
);
const borrowCollateral = computed(() =>
  props.market === "ERG"
    ? { erg: 0.001, usd: collAmount.value || 0, tokens: [] }
    : { erg: collAmount.value || 0, usd: 0, tokens: [] }
);
const borrowLiq = computed(() =>
  borrowRepayment.value && collAmount.value
    ? liquidationPrice(borrowCollateral.value, borrowRepayment.value, props.market, cover.value)
    : null
);

const borrowFillsNow = computed(
  () =>
    borrowBidBps.value != null &&
    borrowEffBps.value != null &&
    borrowEffBps.value >= borrowBidBps.value
);

const collFree = computed(() =>
  Math.max(0, walletFor(collAsset.value) - (collAsset.value === "ERG" ? 0.05 : 0))
);
const maxBorrow = computed(() => {
  if (!(props.oraclePrice > 0) || !(collFree.value > 0)) return 0;
  const colPerUnit = collateralFor(1, props.market, cover.value + 10, props.oraclePrice);
  const growth = 1 + ((targetBorrowBps.value || 0) / 10_000) * (D.value / 262_800);
  if (!(colPerUnit > 0 && growth > 0)) return 0;
  return roundDown(collFree.value / colPerUnit / growth, props.market);
});

const defaultOrderExpBlocks = computed(() => Number(zc.defaults.orderExpiryBlocks) || 5040);
const defaultOrderExpFee = computed(
  () => fromErg(zc.defaults.orderExpiryFeeNanoErg ?? "5000000") ?? 0.005
);
const defaultOrderOracleAge = computed(() => Number(zc.defaults.orderOracleAge) || 60);

const orderBody = computed(() => {
  if (!borrowRepayment.value || !collAmount.value || !props.height || !amount.value) return null;
  const expSpan = Math.max(60, Math.min(defaultOrderExpBlocks.value, Math.floor(D.value / 2)));
  return buildOrderBody({
    market: props.market,
    pricing: "fixed",
    principal: amount.value,
    repayment: borrowRepayment.value,
    mode: "fixed",
    maturity: maturity.value,
    exact: false,
    collateral: borrowCollateral.value,
    rule: "oracle",
    ratio: cover.value,
    oracleAge: defaultOrderOracleAge.value,
    guard: cover.value,
    expiry: props.height + expSpan,
    expiryFee: defaultOrderExpFee.value
  });
});

// ── SELL CALCULATIONS ────────────────────────────────────────────────────────
const heldPositions = computed<ZcPortfolioPosition[]>(() =>
  zc.portfolio.positions.filter(
    (p) =>
      p.side === "lend" &&
      (p.status === "live" || p.status === "active") &&
      p.bond.market === props.market &&
      p.bond.maturity - props.height > 1
  )
);

watch(
  heldPositions,
  (list) => {
    if (!selectedPosId.value || !list.some((p) => p.id === selectedPosId.value)) {
      selectedPosId.value = list[0]?.id || "";
    }
  },
  { immediate: true }
);

const activePos = computed<ZcPortfolioPosition | null>(
  () => heldPositions.value.find((p) => p.id === selectedPosId.value) || heldPositions.value[0] || null
);

const posFrac = computed(() =>
  activePos.value
    ? activePos.value.kind === "shares"
      ? activePos.value.units / SHARES_UNITS
      : 1
    : 1
);
const posFace = computed(() =>
  activePos.value ? activePos.value.bond.repayment * posFrac.value : null
);
const posRemBlocks = computed(() =>
  activePos.value ? Math.max(1, activePos.value.bond.maturity - props.height) : null
);
const posBestBidBps = computed(() =>
  activePos.value && posRemBlocks.value != null && activeCurves.value
    ? lineAt(activeCurves.value.bidLine, posRemBlocks.value)
    : null
);
const posTargetSellBps = computed(() => {
  if (sellAprIn.value != null) return Math.round(sellAprIn.value * 100);
  if (posBestBidBps.value != null) return Math.ceil(posBestBidBps.value) + 1;
  return 800;
});
const posSalePrice = computed(() =>
  posFace.value != null && posRemBlocks.value != null
    ? roundDown(priceForYield(posFace.value, posTargetSellBps.value, posRemBlocks.value), props.market)
    : null
);
const posBestBidGet = computed(() =>
  posFace.value != null && posBestBidBps.value != null && posRemBlocks.value != null
    ? priceForYield(posFace.value, posBestBidBps.value, posRemBlocks.value)
    : null
);
const posCover = computed(() => {
  const p = activePos.value;
  if (!p) return null;
  if (p.bond.cov != null) return p.bond.cov;
  if (p.bond.rule === "oracle" && props.oraclePrice > 0) {
    return coverage(p.bond.collateral, p.bond.repayment, props.market, props.oraclePrice);
  }
  return null;
});
const posClearsBid = computed(
  () => posBestBidBps.value != null && posTargetSellBps.value >= posBestBidBps.value
);

const sellAskBody = computed(() => {
  const pos = activePos.value;
  if (!pos || !props.height || !posRemBlocks.value) return null;
  const maxExp = Math.max(props.height + 10, pos.bond.maturity - Math.min(DAY_BLOCKS, Math.floor(posRemBlocks.value / 2)));
  const expiryHeight = Math.min(props.height + 7 * DAY_BLOCKS, maxExp);
  const units = pos.kind === "shares" ? pos.units : 1;
  return buildAskBody({
    tokenId: pos.tokenId || pos.id,
    market: props.market,
    units,
    pricing: "yield",
    floor: 0,
    tp: {
      h0: props.height,
      y0: posTargetSellBps.value,
      h1: Math.max(props.height + 1, expiryHeight),
      y1: posTargetSellBps.value
    },
    guard:
      pos.bond.rule === "oracle" && pos.bond.ratio
        ? { ratio: pos.bond.ratio, age: 30 }
        : null,
    minFill: pos.kind === "shares" ? Math.min(units, Math.max(1, Math.round(units * 0.1))) : 1,
    expiry: expiryHeight
  });
});

// ── UI OPTIONS & VALIDATION ──────────────────────────────────────────────────
const termOptions = computed<ZcSelectOption[]>(() =>
  TERMS.map((t) => {
    const blocks = t * DAY_BLOCKS;
    const prefix = side.value === "lend" ? "Up to " : "";
    const txt =
      props.unit === "blocks"
        ? `${prefix}${formatNumber(blocks, 0, 0)} blk`
        : `${prefix}~${t === 365 ? "1y" : `${t}d`}`;
    return { value: t, label: txt, shortLabel: txt };
  })
);

const coverOptions = computed<ZcSelectOption[]>(() =>
  COVERS.map((c) => ({
    value: c,
    label: `${c}% cover`,
    shortLabel: `${c}%`
  }))
);

const heldSelectOptions = computed<ZcSelectOption[]>(() =>
  heldPositions.value.map((p) => {
    const rem = Math.max(1, p.bond.maturity - props.height);
    const label = `${
      p.kind === "shares"
        ? `${formatNumber((p.units / SHARES_UNITS) * 100, 1, 0)} sh`
        : "Bond"
    } · ${formatMarketAmount(p.bond.repayment * (p.kind === "shares" ? p.units / SHARES_UNITS : 1), p.bond.market)} · ${formatDur(rem, props.unit)}`;
    return { value: p.id, label, shortLabel: label };
  })
);

const chipBase = computed(() => (side.value === "lend" ? marketBalance.value : maxBorrow.value));

const walletInsufficientLend = computed(
  () => walletReady.value && amount.value != null && amount.value > marketBalance.value
);
const walletInsufficientColl = computed(
  () => walletReady.value && collAmount.value != null && collAmount.value > walletFor(collAsset.value)
);

const dockTone = computed(() =>
  side.value === "lend" ? "bid" : side.value === "borrow" ? "ask" : "cobalt"
);

const borrowSliderPct = computed(() => {
  const v = Math.min(30, Math.max(0, (targetBorrowBps.value ?? 0) / 100));
  return `${(v / 30) * 100}%`;
});

const sellSliderPct = computed(() => {
  const v = Math.min(30, Math.max(0, posTargetSellBps.value / 100));
  return `${(v / 30) * 100}%`;
});

function handleAmountInput(e: Event) {
  const cleaned = (e.target as HTMLInputElement).value.replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  const normalized = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : cleaned;
  if (normalized === "" || Number.isFinite(Number(normalized))) {
    amountText.value = normalized;
  }
}

function setPctPreset(pct: number) {
  if (!(chipBase.value > 0)) return;
  const val = roundDown((chipBase.value * pct) / 100, props.market);
  amountText.value = val > 0 ? String(val) : "";
}

function handleBorrowAprInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  if (raw === "") {
    aprIn.value = null;
    return;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 200) aprIn.value = n;
}

function handleSellAprInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  if (raw === "") {
    sellAprIn.value = null;
    return;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 200) sellAprIn.value = n;
}

// ── TRANSACTION PREVIEW DISPATCHERS ──────────────────────────────────────────
function openLendNowPreview() {
  const p = lendPlan.value;
  if (!p.take.length || !amount.value) return;
  const m = props.market;

  emit("preview", {
    title: `Lend Now (${m})`,
    subtitle: `Fills ${p.take.length} open ${p.take.length === 1 ? "listing" : "listings"} sequentially via Nautilus`,
    badge: `Direct Lend · ${m}`,
    tone: "bid",
    heroLabel: "Average APR",
    heroValue: formatApr(p.avgBps),
    heroSub: `${formatMarketAmount(p.spent, m)} placed now · +${formatMarketAmount(p.interest, m)} gross interest`,
    rows: [
      ...p.take.slice(0, 5).map((it) => ({
        label: `${it.label} · ${formatDur(it.d, props.unit)} · ${shortenString(it.id, 8)}`,
        value: `${formatMarketAmount(it.cost, m)} @ ${formatApr(it.yieldBps)}`,
        tone: "bid" as const
      })),
      ...(p.take.length > 5
        ? [{ label: "Additional fills", value: `+${p.take.length - 5} more bonds` }]
        : []),
      { label: "Total claim at maturity", value: formatMarketAmount(p.totalFace, m) },
      { label: "Cover floor", value: `≥ ${cover.value}% · oracle` }
    ],
    rawSummary: {
      action: "walletLendBatch",
      market: m,
      spent: p.spent,
      avgAprBps: p.avgBps != null ? Math.round(p.avgBps) : null,
      steps: p.take.map((t) => ({ id: t.id, cost: t.cost, yieldBps: t.yieldBps }))
    },
    txAction: {
      type: "walletLendBatch",
      market: m,
      steps: p.take.map((it, idx) => ({
        boxId: it.id,
        units: it.kind === "shares" ? it.rawUnits ?? BigInt(it.units) : null,
        label: `Fill #${idx + 1} (${shortenString(it.id, 10)})`,
        expectedCostRaw: it.expectedCostRaw
      }))
    }
  });
}

function openPostOfferPreview() {
  const body = offerBody.value;
  if (!body || !amount.value) return;
  const m = props.market;
  const hasBid = activeCurves.value && lineAt(activeCurves.value.bidLine, T.value) != null;

  emit("preview", {
    title: `Post a Lend Offer (${m})`,
    subtitle: hasBid
      ? "Rests at today's best bid and buys any bond that clears it"
      : "Rests at 8.00% default APR — shape a full curve in Studio",
    badge: `Lend Offer · ${m}`,
    tone: "bid",
    heroLabel: "Capital committed",
    heroValue: formatMarketAmount(amount.value, m),
    heroSub: `${formatApr(offerRateBps.value)} flat · ${formatDur(MIN_MATURITY_BLOCKS, props.unit)} – ${formatDur(T.value, props.unit)}`,
    rows: [
      { label: "APR floor", value: `${formatApr(offerRateBps.value)} flat`, tone: "bid" },
      {
        label: "Maturities",
        value: `${formatDur(MIN_MATURITY_BLOCKS, props.unit)} – ${formatDur(T.value, props.unit)}`
      },
      { label: "Cover floor", value: `≥ ${cover.value}% · oracle` },
      { label: "Delivery", value: "Bond units (1:1)" },
      { label: "Expires", value: formatDurLong(defaultOfferExpBlocks.value, props.unit) }
    ],
    rawSummary: { action: "createOffer", ...body },
    txAction: { type: "createOffer", body }
  });
}

function openBorrowPreview() {
  const body = orderBody.value;
  if (!body || !amount.value || !borrowRepayment.value || !collAmount.value) return;
  const m = props.market;
  const lp = borrowLiq.value;

  emit("preview", {
    title: `Post a Borrow Order (${m})`,
    subtitle: borrowFillsNow.value
      ? "Clears today's best bid — eligible on the next batch"
      : "Rests on the market until a lender fills or matches your APR",
    badge: `Borrow · ${m}`,
    tone: "ask",
    heroLabel: "You receive",
    heroValue: formatMarketAmount(amount.value, m),
    heroSub: `Repay ${formatMarketAmount(borrowRepayment.value, m)} by ${dateAtHeight(maturity.value, props.height)}`,
    rows: [
      {
        label: "Effective APR",
        value: aprShifted.value
          ? `${formatApr(borrowEffBps.value)} (rounded from ${formatApr(targetBorrowBps.value)})`
          : formatApr(borrowEffBps.value),
        tone: "ask"
      },
      {
        label: "Gross interest",
        value: formatMarketAmount(borrowRepayment.value - amount.value, m)
      },
      {
        label: "Collateral locked",
        value: `${formatMarketAmount(collAmount.value, collAsset.value)} (${cover.value + 10}%)`
      },
      {
        label: "Liquidates",
        value: lp?.price
          ? `< ${cover.value}% · ERG ${lp.dir === "below" ? "<" : ">"} $${formatNumber(lp.price, 3, 2)}`
          : `Under ${cover.value}% cover`
      },
      { label: "Fill guard", value: `≥ ${cover.value}%` },
      { label: "Expiry fee", value: `${formatNumber(defaultOrderExpFee.value, 3, 0)} ERG (refunded if filled)` }
    ],
    rawSummary: { action: "createOrder", ...body },
    txAction: { type: "createOrder", body }
  });
}

function openSellPreview() {
  const body = sellAskBody.value;
  const pos = activePos.value;
  if (!body || !pos || posFace.value == null || posSalePrice.value == null) return;
  const m = props.market;

  emit("preview", {
    title: pos.kind === "shares" ? `Sell Bond Shares (${m})` : `Sell Bond Unit (${m})`,
    subtitle: posClearsBid.value
      ? "Clears today's best bid — eligible on the next batch"
      : "Lists on the open market at your chosen APR",
    badge: `Resale · ${m}`,
    tone: "cobalt",
    heroLabel: "You receive on sale",
    heroValue: formatMarketAmount(posSalePrice.value, m),
    heroSub: `${formatApr(posTargetSellBps.value)} buyer APR · ${((posSalePrice.value / posFace.value) * 100).toFixed(2)}% of face`,
    rows: [
      { label: "Bond", value: shortenString(pos.bond.id, 14) },
      { label: "Face value", value: formatMarketAmount(posFace.value, m) },
      ...(pos.kind === "shares"
        ? [
            {
              label: "Quantity",
              value: `${formatNumber(posFrac.value * 100, 2, 0)} / 100 shares`
            }
          ]
        : []),
      {
        label: "Time remaining",
        value: `${dateAtHeight(pos.bond.maturity, props.height)} · ${formatDur(posRemBlocks.value, props.unit)}`
      },
      {
        label: "Sale guard",
        value: pos.bond.rule === "oracle" && pos.bond.ratio ? `Cover ≥ ${pos.bond.ratio}%` : "Off"
      }
    ],
    rawSummary: { action: "createAsk", ...body },
    txAction: { type: "createAsk", body }
  });
}

const fullStudioRoute = computed(() => {
  const query: Record<string, string> = { type: side.value };
  if (side.value === "sell") {
    if (activePos.value) query.token = activePos.value.tokenId || activePos.value.id;
    if (matchedOfferId.value) query.match = matchedOfferId.value;
  } else {
    if (amount.value != null) query.amount = String(amount.value);
    query.days = String(tenor.value);
    if (side.value === "borrow") {
      if (targetBorrowBps.value != null) query.apr = (targetBorrowBps.value / 100).toFixed(2);
      if (matchedOfferId.value) query.match = matchedOfferId.value;
    }
  }
  return { name: "zc-studio", query };
});
</script>

<template>
  <aside
    class="sf-action-dock sidebar-dock relative flex flex-col rounded-[24px] rounded-tr-[8px]"
    :class="{ 'is-pulsing': pulseRing }"
    :data-tone="dockTone"
    aria-label="Lend, borrow or sell"
    @mousemove="onDockPointerMove"
  >
    <!-- Clipped Decorative Ambient Glow Layer (keeps dropdown menus unclipped) -->
    <div class="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden="true">
      <div class="sidebar-glow" />
    </div>

    <!-- Header + 3-Way Intent Switcher (Lend / Borrow / Sell) -->
    <div class="sf-panel-head relative z-10 rounded-t-[23px] rounded-tr-[7px] px-4 pt-4 pb-3.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <market-coin :market="market" :size="22" bare />
          <div>
            <h2 class="sf-display text-[16px] font-bold leading-none text-[color:var(--sf-ink)]">
              Quick Action
            </h2>
            <p class="mt-0.5 text-[11px] text-[color:var(--sf-muted)]">
              Lend, borrow, or sell in a few fields
            </p>
          </div>
        </div>
        <span
          class="sf-mono rounded-full border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-ink-2)]"
        >
          {{ market }}
        </span>
      </div>

      <!-- 3-Way Intent Segmented Control -->
      <div
        class="sf-seg mt-3.5 grid w-full grid-cols-3 text-[12px]"
        role="tablist"
        aria-label="What you want to do"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="side === 'lend'"
          class="sf-seg-btn py-1.5"
          :class="side === 'lend' ? 'is-active tone-bid' : ''"
          @click="side = 'lend'"
        >
          Lend
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="side === 'borrow'"
          class="sf-seg-btn py-1.5"
          :class="side === 'borrow' ? 'is-active tone-ask' : ''"
          @click="side = 'borrow'"
        >
          Borrow
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="side === 'sell'"
          class="sf-seg-btn py-1.5"
          :class="side === 'sell' ? 'is-active tone-cobalt' : ''"
          @click="side = 'sell'"
        >
          Sell
        </button>
      </div>

      <!-- Optional Matched Offer Chip (when triggered from a Lend Offer card) -->
      <div
        v-if="matchedOfferId && side !== 'lend'"
        class="mt-2.5 flex items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)]/70 px-2.5 py-1.5 text-[11px]"
      >
        <span class="sf-mono truncate font-semibold text-[color:var(--sf-bid)]">
          Matching offer {{ shortenString(matchedOfferId, 12) }}
        </span>
        <button
          type="button"
          class="text-[color:var(--sf-bid)] opacity-75 hover:opacity-100"
          aria-label="Clear matched offer"
          @click="matchedOfferId = null"
        >
          <x-icon class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <!-- Main Form Body -->
    <div class="relative z-10 space-y-3.5 px-4 py-4">
      <!-- LEND & BORROW INPUTS -->
      <template v-if="side !== 'sell'">
        <div>
          <div class="mb-1.5 flex items-baseline justify-between gap-2 text-[11.5px]">
            <label for="sf-simple-amount" class="font-semibold text-[color:var(--sf-ink-2)]">
              {{ side === "lend" ? "I want to lend" : "I want to borrow" }}
            </label>
            <span class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">
              <template v-if="!walletReady">
                <button
                  type="button"
                  class="font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                  @click="wallet.connect('nautilus')"
                >
                  Connect Nautilus
                </button>
              </template>
              <template v-else-if="side === 'lend'">
                Wallet {{ formatMarketAmount(marketBalance, market) }}
              </template>
              <template v-else>
                {{
                  maxBorrow > 0
                    ? `Up to ${formatMarketAmount(maxBorrow, market)}`
                    : `No ${collAsset} to pledge`
                }}
              </template>
            </span>
          </div>

          <div
            class="sf-input-well flex items-center gap-2 rounded-2xl px-3.5 py-2.5"
            :data-tone="dockTone"
          >
            <input
              id="sf-simple-amount"
              :value="amountText"
              inputmode="decimal"
              autocomplete="off"
              placeholder="0"
              :aria-label="side === 'lend' ? 'Amount to lend' : 'Amount to borrow'"
              class="sf-mono w-full min-w-0 bg-transparent text-[22px] font-semibold tracking-tight text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
              @input="handleAmountInput"
            />
            <span
              class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2 py-1 text-[12px] font-semibold text-[color:var(--sf-ink)]"
            >
              <market-coin :market="market" :size="16" bare />
              <span>{{ market }}</span>
            </span>
          </div>

          <!-- 25% / 50% / 75% / Max Chips (Matches Simple.js) -->
          <div class="mt-2 grid grid-cols-4 gap-1.5" role="group" aria-label="Amount presets">
            <button
              v-for="pct in [25, 50, 75, 100]"
              :key="pct"
              type="button"
              :disabled="!(chipBase > 0)"
              class="sf-mono rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] py-1 text-[11px] font-semibold text-[color:var(--sf-muted)] transition-all hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-cobalt)] disabled:cursor-not-allowed disabled:opacity-40"
              :title="
                side === 'lend'
                  ? `${pct}% of your ${market}`
                  : `${pct}% of what your ${collAsset} can back at ${cover + 10}% cover`
              "
              @click="setPctPreset(pct)"
            >
              {{ pct === 100 ? "Max" : `${pct}%` }}
            </button>
          </div>
        </div>

        <!-- Maturity + Cover Settings -->
        <div class="grid grid-cols-2 gap-2.5">
          <div>
            <span
              class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]"
            >
              {{ side === "lend" ? "Longest maturity" : "Maturity" }}
            </span>
            <zc-select
              v-model="tenor"
              :options="termOptions"
              mono
              aria-label="Maturity"
              class="w-full [&>button]:w-full [&>button]:justify-between"
            />
          </div>

          <div>
            <span
              class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]"
            >
              {{ side === "lend" ? "Collateral ≥" : "Liquidate under" }}
            </span>
            <zc-select
              v-model="cover"
              :options="coverOptions"
              mono
              align="right"
              aria-label="Cover level"
              class="w-full [&>button]:w-full [&>button]:justify-between"
            />
          </div>
        </div>
      </template>

      <!-- SELL INPUTS -->
      <template v-else>
        <div>
          <div class="mb-1.5 flex items-baseline justify-between gap-2 text-[11.5px]">
            <span class="font-semibold text-[color:var(--sf-ink-2)]">I want to sell</span>
            <span class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">
              {{ heldPositions.length }} live in {{ market }}
            </span>
          </div>

          <zc-select
            v-if="heldPositions.length > 0"
            v-model="selectedPosId"
            :options="heldSelectOptions"
            mono
            aria-label="Select a bond or shares to sell"
            class="w-full [&>button]:h-10 [&>button]:w-full [&>button]:justify-between"
          />

          <div
            v-else
            class="rounded-2xl border border-dashed border-[color:var(--sf-line-strong)] bg-[color:var(--sf-well-inset)] p-4 text-center"
          >
            <p class="text-[12px] font-medium text-[color:var(--sf-ink-2)]">
              {{
                walletReady
                  ? `No live ${market} bonds in your wallet`
                  : "Connect Nautilus to load your bonds"
              }}
            </p>
            <p class="mt-1 text-[11px] text-[color:var(--sf-muted)]">
              Live bonds and fractional shares you hold in {{ market }} appear here.
            </p>
            <button
              v-if="!walletReady"
              type="button"
              class="sf-btn-cobalt mt-3 h-8 rounded-full px-4 text-[11.5px]"
              @click="wallet.connect('nautilus')"
            >
              Connect Nautilus
            </button>
          </div>
        </div>

        <!-- Selected Holding Card -->
        <div
          v-if="activePos"
          class="flex items-start gap-2.5 rounded-2xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] p-3"
        >
          <zc-order-mark :kind="activePos.kind" :size="30" :market="market" />
          <div class="min-w-0 flex-1 text-[11.5px]">
            <div class="flex flex-wrap items-center gap-1.5 font-semibold text-[color:var(--sf-ink)]">
              <span>
                {{
                  activePos.kind === "shares"
                    ? `${formatNumber(posFrac * 100, 2, 0)} of 100 shares`
                    : "1 whole bond"
                }}
              </span>
              <span
                v-if="activePos.borrowedByMe"
                class="sf-mono rounded bg-[color:var(--sf-bid-soft)] px-1.5 py-[1px] text-[9.5px] font-semibold text-[color:var(--sf-bid)]"
              >
                Your loan
              </span>
            </div>
            <div class="sf-mono mt-0.5 text-[10.5px] text-[color:var(--sf-ink-2)]">
              Repays {{ formatMarketAmount(posFace, market) }} on
              {{ dateAtHeight(activePos.bond.maturity, height) }} ·
              {{ formatDurLong(posRemBlocks, unit) }} left
            </div>
            <div class="mt-1 text-[10.5px] text-[color:var(--sf-muted)]">
              <template v-if="activePos.borrowedByMe && activePos.kind === 'unit'">
                You borrowed for this bond — extinguish it in Portfolio to unlock collateral directly.
              </template>
              <template v-else-if="activePos.bond.rule === 'oracle'">
                {{ posCover != null ? Math.round(posCover) : "—" }}% cover · liquidates under
                {{ activePos.bond.ratio ?? "—" }}%
              </template>
              <template v-else>Maturity rule</template>
            </div>
          </div>
        </div>
      </template>

      <!-- LIVE OUTPUT READOUT STAGE -->
      <div
        v-if="side !== 'sell' || activePos"
        class="relative overflow-hidden rounded-2xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] p-3.5"
        aria-live="polite"
      >
        <!-- LEND READOUT -->
        <template v-if="side === 'lend'">
          <div class="flex items-center justify-between gap-2">
            <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              {{ amount ? "You earn" : "Best APR available now" }}
            </span>
            <refresh-cw-icon
              v-if="simLoading"
              class="h-3 w-3 animate-spin text-[color:var(--sf-cobalt)]"
            />
          </div>
          <div class="mt-1 flex items-baseline gap-2">
            <strong class="sf-serif text-[32px] font-semibold leading-none text-[color:var(--sf-bid)]">
              {{
                !connected
                  ? "—"
                  : amount
                    ? simLoading
                      ? "…"
                      : formatApr(lendPlan.avgBps)
                    : formatApr(lendPlan.bestBps)
              }}
            </strong>
            <span class="sf-mono text-[11px] text-[color:var(--sf-muted)]">simple APR</span>
          </div>
          <p class="mt-1.5 text-[11.5px] leading-relaxed text-[color:var(--sf-ink-2)]">
            <template v-if="!connected">Connecting to Ergo chain feed…</template>
            <template v-else-if="amount">
              <template v-if="simLoading">Simulating against open borrows &amp; resales…</template>
              <template v-else-if="lendPlan.take.length > 0">
                <strong class="font-semibold text-[color:var(--sf-ink)]">
                  {{ lendPlan.take.length }} bond{{ lendPlan.take.length > 1 ? "s" : "" }}
                </strong>
                · {{ formatMarketAmount(lendPlan.spent, market) }} of
                {{ formatMarketAmount(amount, market) }} placed now
                <span class="text-[color:var(--sf-bid)]">
                  · ≈ +{{ formatMarketAmount(lendPlan.interest, market) }}
                </span>
              </template>
              <template v-else>
                Nothing that size matches now. Post a standing offer at
                <span class="sf-mono font-semibold text-[color:var(--sf-bid)]">
                  {{ formatApr(offerRateBps) }}
                </span>
                instead.
              </template>
            </template>
            <template v-else>
              Maturing within {{ formatDurLong(T, unit) }} · simple, before fees
            </template>
          </p>

          <!-- Compact matched breakdown when simulation found fills -->
          <div
            v-if="amount && !simLoading && lendPlan.take.length > 0"
            class="mt-2.5 divide-y divide-[color:var(--sf-line)] rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card)]"
          >
            <div
              v-for="item in lendPlan.take.slice(0, 3)"
              :key="item.id"
              class="sf-mono flex items-center justify-between gap-2 px-2.5 py-1.5 text-[10.5px]"
            >
              <span class="truncate text-[color:var(--sf-ink-2)]">
                {{ item.label }} · {{ formatDur(item.d, unit) }}
              </span>
              <span class="shrink-0 font-semibold text-[color:var(--sf-bid)]">
                {{ formatMarketAmount(item.cost, market) }} · {{ formatApr(item.yieldBps) }}
              </span>
            </div>
            <div
              v-if="lendPlan.take.length > 3"
              class="sf-mono px-2.5 py-1 text-[10px] text-[color:var(--sf-dim)]"
            >
              +{{ lendPlan.take.length - 3 }} more included
            </div>
          </div>
        </template>

        <!-- BORROW READOUT -->
        <template v-else-if="side === 'borrow'">
          <div class="sf-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            You repay at maturity
          </div>
          <div class="mt-1 flex items-baseline gap-1.5">
            <strong class="sf-serif text-[30px] font-semibold leading-none text-[color:var(--sf-ink)]">
              {{
                borrowRepayment != null
                  ? formatNumber(
                      borrowRepayment,
                      market === "ERG" ? 3 : 2,
                      market === "SigUSD" ? 2 : 0
                    )
                  : "—"
              }}
            </strong>
            <span class="sf-mono text-[12px] font-semibold text-[color:var(--sf-muted)]">
              {{ market }}
            </span>
          </div>
          <p class="mt-1 text-[11px] text-[color:var(--sf-ink-2)]">
            <template v-if="borrowRepayment && amount">
              {{ formatMarketAmount(amount, market) }} +
              {{ formatMarketAmount(borrowRepayment - amount, market) }} interest · by
              {{ dateAtHeight(maturity, height) }}
            </template>
            <template v-else-if="targetBorrowBps == null">
              No lenders at this maturity yet. Set your own APR below.
            </template>
            <template v-else>Enter an amount to see your repayment.</template>
          </p>

          <!-- APR Control + Best Bid Reset + Slider (Matches Simple.js) -->
          <div class="mt-3 space-y-2 border-t border-[color:var(--sf-line)] pt-2.5">
            <div class="flex items-center justify-between gap-2 text-[11px]">
              <label for="sf-simple-borrow-apr" class="font-semibold text-[color:var(--sf-ink-2)]">
                Offered APR
              </label>
              <div class="flex items-center gap-2">
                <button
                  v-if="aprIn != null && autoBorrowBps != null"
                  type="button"
                  class="sf-mono text-[10.5px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                  @click="aprIn = null"
                >
                  Best bid
                </button>
                <div
                  class="sf-input-well flex w-24 items-center gap-1 rounded-lg px-2 py-1"
                  data-tone="ask"
                >
                  <input
                    id="sf-simple-borrow-apr"
                    type="number"
                    step="0.05"
                    min="0"
                    max="200"
                    :value="targetBorrowBps != null ? (targetBorrowBps / 100).toFixed(2) : ''"
                    placeholder="0.00"
                    class="sf-mono w-full min-w-0 bg-transparent text-right text-[12px] font-semibold text-[color:var(--sf-ink)] outline-none"
                    @input="handleBorrowAprInput"
                  />
                  <span class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">%</span>
                </div>
              </div>
            </div>

            <input
              type="range"
              min="0"
              max="30"
              step="0.05"
              :value="Math.min(30, (targetBorrowBps ?? 0) / 100)"
              aria-label="Adjust borrow APR"
              class="sf-range sidebar-range"
              :style="{ '--range-fill': borrowSliderPct, '--range-color': 'var(--sf-ask)' }"
              @input="aprIn = Number(($event.target as HTMLInputElement).value)"
            />

            <div class="sf-mono text-[10.5px]">
              <span :class="borrowFillsNow ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ask)]'">
                <template v-if="borrowEffBps == null" />
                <template v-else-if="borrowFillsNow">
                  ≥ best bid {{ formatApr(borrowBidBps) }} · fills next batch
                </template>
                <template v-else-if="borrowBidBps == null">
                  No bid at this maturity yet · rests on market
                </template>
                <template v-else>
                  Under best bid {{ formatApr(borrowBidBps) }} · rests
                </template>
                <template v-if="aprShifted"> · eff. {{ formatApr(borrowEffBps) }}</template>
              </span>
            </div>
          </div>
        </template>

        <!-- SELL READOUT -->
        <template v-else-if="activePos">
          <div class="sf-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            {{ sellAprIn != null ? "Your listing receives" : "At today's best bid" }}
          </div>
          <div class="mt-1 flex items-baseline gap-1.5">
            <strong class="sf-serif text-[30px] font-semibold leading-none text-[color:var(--sf-ink)]">
              {{
                (sellAprIn != null ? posSalePrice : posBestBidGet ?? posSalePrice) != null
                  ? formatNumber(
                      sellAprIn != null ? posSalePrice : posBestBidGet ?? posSalePrice,
                      market === "ERG" ? 3 : 2,
                      market === "SigUSD" ? 2 : 0
                    )
                  : "—"
              }}
            </strong>
            <span class="sf-mono text-[12px] font-semibold text-[color:var(--sf-muted)]">
              {{ market }}
            </span>
          </div>
          <p class="mt-1 text-[11px] text-[color:var(--sf-ink-2)]">
            <template v-if="posSalePrice != null && posFace">
              {{ formatApr(posTargetSellBps) }} APR for buyer ·
              {{ ((posSalePrice / posFace) * 100).toFixed(2) }}% of face
            </template>
            <template v-else>No bid covers this maturity right now. You can still list it.</template>
          </p>

          <!-- Quick Sale APR Slider -->
          <div class="mt-3 space-y-2 border-t border-[color:var(--sf-line)] pt-2.5">
            <div class="flex items-center justify-between gap-2 text-[11px]">
              <label for="sf-simple-sell-apr" class="font-semibold text-[color:var(--sf-ink-2)]">
                Sale APR
              </label>
              <div class="flex items-center gap-2">
                <button
                  v-if="sellAprIn != null && posBestBidBps != null"
                  type="button"
                  class="sf-mono text-[10.5px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                  @click="sellAprIn = null"
                >
                  Best bid
                </button>
                <div
                  class="sf-input-well flex w-24 items-center gap-1 rounded-lg px-2 py-1"
                  data-tone="cobalt"
                >
                  <input
                    id="sf-simple-sell-apr"
                    type="number"
                    step="0.05"
                    min="0"
                    max="200"
                    :value="(posTargetSellBps / 100).toFixed(2)"
                    class="sf-mono w-full min-w-0 bg-transparent text-right text-[12px] font-semibold text-[color:var(--sf-ink)] outline-none"
                    @input="handleSellAprInput"
                  />
                  <span class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">%</span>
                </div>
              </div>
            </div>

            <input
              type="range"
              min="0"
              max="30"
              step="0.05"
              :value="Math.min(30, posTargetSellBps / 100)"
              aria-label="Adjust sale APR"
              class="sf-range sidebar-range"
              :style="{ '--range-fill': sellSliderPct, '--range-color': 'var(--sf-cobalt)' }"
              @input="sellAprIn = Number(($event.target as HTMLInputElement).value)"
            />

            <div class="sf-mono text-[10.5px]">
              <span :class="posClearsBid ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-muted)]'">
                {{
                  posBestBidBps == null
                    ? "No active bid at this maturity · lists on market"
                    : posClearsBid
                      ? `≥ best bid ${formatApr(posBestBidBps)} · clears next batch`
                      : `Under best bid ${formatApr(posBestBidBps)} · rests as ask`
                }}
              </span>
            </div>
          </div>
        </template>
      </div>

      <!-- ACTION BUTTONS -->
      <div class="space-y-2">
        <!-- Primary Action -->
        <button
          v-if="side === 'lend'"
          type="button"
          :disabled="!lendPlan.take.length || walletInsufficientLend"
          class="sf-btn-bid flex h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
          @click="openLendNowPreview"
        >
          <span>
            {{
              walletInsufficientLend
                ? `Not enough ${market}`
                : lendPlan.take.length
                  ? `Lend ${formatMarketAmount(lendPlan.spent, market)} now`
                  : "Lend now"
            }}
          </span>
          <arrow-right-icon class="h-4 w-4" />
        </button>

        <button
          v-else-if="side === 'borrow'"
          type="button"
          :disabled="!orderBody || walletInsufficientColl"
          class="sf-btn-ask flex h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
          @click="openBorrowPreview"
        >
          <span>
            {{
              walletInsufficientColl
                ? `Not enough ${collAsset}`
                : "Continue to borrow order"
            }}
          </span>
          <arrow-right-icon class="h-4 w-4" />
        </button>

        <button
          v-else
          type="button"
          :disabled="!activePos || !sellAskBody"
          class="sf-btn-cobalt flex h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
          @click="openSellPreview"
        >
          <span>
            {{
              activePos && posSalePrice != null
                ? `List for ${formatMarketAmount(posSalePrice, market)}`
                : "List for sale"
            }}
          </span>
          <arrow-right-icon class="h-4 w-4" />
        </button>

        <!-- Secondary Row: Post an Offer (Lend) + Full Studio -->
        <div class="flex items-center gap-2">
          <button
            v-if="side === 'lend'"
            type="button"
            :disabled="!offerBody || walletInsufficientLend"
            class="sf-btn-outline flex h-9 flex-1 items-center justify-center rounded-xl px-3 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-45"
            @click="openPostOfferPreview"
          >
            Post an offer
          </button>

          <router-link
            :to="fullStudioRoute"
            class="sf-btn-outline flex h-9 items-center justify-center gap-1 rounded-xl px-3 text-[12px] font-semibold text-[color:var(--sf-ink-2)] hover:text-[color:var(--sf-cobalt)]"
            :class="side === 'lend' ? 'shrink-0' : 'flex-1'"
            title="Every option: custom curves, delivery, guards and expiry"
          >
            <span>Full studio</span>
            <arrow-up-right-icon class="h-3.5 w-3.5 opacity-75" />
          </router-link>
        </div>
      </div>

      <!-- Safety Footnote (Matches Simple.js) -->
      <p class="flex items-start gap-2 border-t border-[color:var(--sf-line)] pt-3 text-[11px] leading-relaxed text-[color:var(--sf-muted)]">
        <shield-icon class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--sf-cobalt)]" />
        <span>
          <template v-if="side === 'lend'">
            Buys only oracle-rule bonds with cover and a liquidation ratio of at least {{ cover }}%.
            Each repays at maturity if its borrower pays.
          </template>
          <template v-else-if="side === 'borrow'">
            Locks
            {{
              collAmount != null
                ? formatMarketAmount(collAmount, collAsset)
                : `${collAsset} at ${cover + 10}% cover`
            }}. Liquidates under {{ cover }}% cover<template v-if="borrowLiq?.price">
              (ERG {{ borrowLiq.dir === "below" ? "under" : "over" }} ${{
                formatNumber(borrowLiq.price, 3, 2)
              }}, now ${{ formatNumber(oraclePrice, 2, 2) }})</template
            >
            or at maturity if unpaid.
          </template>
          <template v-else>
            Listing locks the bond until it sells, you cancel, or it expires. Open Full studio for
            fixed-price or partial-share schedules.
          </template>
        </span>
      </p>
    </div>
  </aside>
</template>

<style scoped>
.sidebar-dock {
  overflow: visible;
  transition:
    border-color 0.28s var(--sf-ease),
    box-shadow 0.32s var(--sf-ease);
}

.sidebar-dock::before {
  border-radius: inherit;
}

.sidebar-dock.is-pulsing {
  border-color: var(--sf-line-bid);
  box-shadow:
    var(--sf-rim-top),
    var(--sf-shadow-dock),
    0 0 0 3px var(--sf-bid-soft);
}

.sidebar-glow {
  position: absolute;
  top: -70px;
  right: -60px;
  width: 210px;
  height: 210px;
  border-radius: 9999px;
  pointer-events: none;
  z-index: 0;
  opacity: 0.45;
  filter: blur(28px);
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-cobalt-rgb), 0.22),
    transparent 74%
  );
  transition: background 0.35s var(--sf-ease);
}

.sidebar-dock[data-tone="bid"] .sidebar-glow {
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-bid-rgb), 0.24),
    transparent 74%
  );
}

.sidebar-dock[data-tone="ask"] .sidebar-glow {
  background: radial-gradient(
    closest-side,
    rgba(var(--sf-ask-rgb), 0.24),
    transparent 74%
  );
}

.sidebar-range {
  background: linear-gradient(
    to right,
    var(--range-color, var(--sf-cobalt)) 0%,
    var(--range-color, var(--sf-cobalt)) var(--range-fill, 0%),
    var(--sf-line-strong) var(--range-fill, 0%),
    var(--sf-line-strong) 100%
  );
}
</style>
