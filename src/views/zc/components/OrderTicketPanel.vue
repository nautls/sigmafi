<script setup lang="ts">
import { decimalize } from "@fleet-sdk/common";
import { ArrowRightIcon, ArrowUpRightIcon, ChevronRightIcon, ZapIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ExecutionPreviewPayload } from "./ExecutionPreviewModal.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { ERG_DECIMALS, ERG_TOKEN_ID } from "@/constants";
import { buildOfferBody, buildOrderBody, buildWalletLendDraft, zcApi } from "@/services/zcApi";
import { useWalletStore } from "@/stories";
import {
  ZcCurves,
  ZcDurationUnit,
  ZcMarket,
  ZcOrderbook,
  ZcRateBookFilters,
  ZcSimulateResponse
} from "@/types/zc";
import {
  collateralFor,
  dateAtHeight,
  DAY_BLOCKS,
  formatApr,
  formatDur,
  formatMarketAmount,
  formatNumber,
  fromMarket,
  isBookRowActive,
  lineAt,
  liquidationPrice,
  priceForYield,
  repaymentFor,
  roundDown,
  roundUp,
  SIGUSD_TOKEN_ID,
  snapMaturity,
  yieldForPrice
} from "@/utils/zcMath";

const TERMS = [7, 30, 60, 90, 180, 365] as const;

type TicketSide = "lend" | "borrow" | "sell";

const props = defineProps<{
  market: ZcMarket;
  curves: ZcCurves | null;
  filters: ZcRateBookFilters;
  height: number;
  oraclePrice: number;
  oracleRefreshing: boolean;
  connected: boolean;
  revision: number;
  unit: ZcDurationUnit;
  prefill?: {
    seq: number;
    side?: TicketSide;
    amount?: string;
    days?: number;
    apr?: number | null;
  } | null;
}>();

const emit = defineEmits<{
  (e: "preview", payload: ExecutionPreviewPayload): void;
}>();

const wallet = useWalletStore();

const side = ref<TicketSide>("lend");
const amountText = ref<string>("");
const termDays = ref<number>(365);
const aprInput = ref<number | null>(null);

const ticketBook = ref<ZcOrderbook | null>(null);
const simRes = ref<ZcSimulateResponse | null>(null);
const simLoading = ref(false);

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

// Apply external prefills (from Landing Quote Card or OfferInspector)
watch(
  () => props.prefill?.seq,
  () => {
    const pf = props.prefill;
    if (!pf) return;
    if (pf.side) side.value = pf.side;
    if (pf.amount !== undefined) amountText.value = pf.amount;
    if (pf.days && pf.days >= 1) {
      const closest = TERMS.reduce((a, b) =>
        Math.abs(b - pf.days!) < Math.abs(a - pf.days!) ? b : a
      );
      termDays.value = closest;
    }
    if (pf.apr !== undefined) aprInput.value = pf.apr;
  },
  { immediate: true }
);

watch(
  () => props.market,
  () => {
    aprInput.value = null;
  }
);

const amount = computed<number | null>(() => {
  if (!amountText.value.trim()) return null;
  const n = Number(amountText.value);
  return Number.isFinite(n) && n > 0 ? n : null;
});

const T = computed(() => termDays.value * DAY_BLOCKS);
const maturity = computed(() =>
  props.height > 0 ? snapMaturity(props.height + T.value, props.height) : T.value
);
const D = computed(() =>
  props.height > 0 ? Math.max(DAY_BLOCKS, maturity.value - props.height) : T.value
);

const bestBidAtTerm = computed(() =>
  props.curves ? lineAt(props.curves.bidLine, side.value === "lend" ? T.value : D.value) : null
);

const effectiveAprBps = computed(() => {
  if (aprInput.value != null) return Math.round(aprInput.value * 100);
  if (bestBidAtTerm.value == null) return null;
  return side.value === "lend"
    ? Math.round(bestBidAtTerm.value)
    : Math.ceil(bestBidAtTerm.value) + 1;
});

const sliderPct = computed(() => {
  const val = Math.min(30, Math.max(0, (effectiveAprBps.value ?? 0) / 100));
  return `${(val / 30) * 100}%`;
});

// Nautilus connected wallet balance
const walletMarketBalance = computed<number | null>(() => {
  if (!wallet.connected) return null;
  if (props.market === "ERG") {
    const raw = wallet.balance.find((x) => x.tokenId === ERG_TOKEN_ID)?.amount || 0n;
    return Number(decimalize(raw, { decimals: ERG_DECIMALS }));
  }
  const raw = wallet.balance.find((x) => x.tokenId === SIGUSD_TOKEN_ID)?.amount || 0n;
  return Number(raw) / 100;
});

function setBalanceFraction(frac: number) {
  if (walletMarketBalance.value == null || walletMarketBalance.value <= 0) return;
  const raw = walletMarketBalance.value * frac;
  const step = props.market === "ERG" ? 1000 : 100;
  const floored = Math.floor(raw * step) / step;
  amountText.value = floored > 0 ? String(floored) : "";
}

// Live orderbook slice for matching count readout
let obAc: AbortController | null = null;
watch(
  [
    () => props.connected,
    () => props.revision,
    () => props.market,
    () => props.filters.coverage,
    () => props.filters.kind,
    () => props.filters.matchable,
    () => props.filters.grid,
    side,
    termDays
  ],
  async () => {
    if (obAc) obAc.abort();
    if (!props.connected) {
      ticketBook.value = null;
      return;
    }
    const ac = new AbortController();
    obAc = ac;
    try {
      const book = await zcApi.getOrderbook(
        props.market,
        {
          coverage: Math.round(props.filters.coverage * 100),
          kind: props.filters.kind,
          matchable: props.filters.matchable && !props.oracleRefreshing,
          grid: props.filters.grid,
          ...(side.value === "lend" ? { to: T.value } : { around: D.value, band: DAY_BLOCKS })
        },
        ac.signal
      );
      if (!ac.signal.aborted) ticketBook.value = book;
    } catch {
      // keep previous
    }
  },
  { immediate: true }
);

// Live lend simulation
let simTimer: number | null = null;
let simAc: AbortController | null = null;
let simSeq = 0;

watch(
  [
    () => props.connected,
    () => props.revision,
    () => props.market,
    () => props.filters.coverage,
    side,
    amount,
    termDays
  ],
  () => {
    if (simTimer !== null) window.clearTimeout(simTimer);
    if (simAc) simAc.abort();

    if (!props.connected || side.value !== "lend" || !amount.value) {
      simRes.value = null;
      simLoading.value = false;
      return;
    }
    const draft = buildWalletLendDraft({
      market: props.market,
      amount: amount.value,
      to: T.value,
      coverage: props.filters.coverage
    });
    if (!draft) {
      simRes.value = null;
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
        if (mySeq === simSeq) simRes.value = res;
      } catch {
        // transient
      } finally {
        if (mySeq === simSeq) simLoading.value = false;
      }
    }, 300);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  obAc?.abort();
  simAc?.abort();
  if (simTimer !== null) window.clearTimeout(simTimer);
});

const lendSimSummary = computed(() => {
  const matches = simRes.value?.matches || [];
  const spent =
    simRes.value?.filled != null ? fromMarket(simRes.value.filled, props.market) ?? 0 : 0;
  const face = matches.reduce((acc, m) => acc + (fromMarket(m.face, props.market) ?? 0), 0);
  const avgBps =
    spent > 0
      ? matches.reduce(
          (acc, m) => acc + (fromMarket(m.cost, props.market) ?? 0) * (m.yieldBps ?? 0),
          0
        ) / spent
      : null;
  return { count: matches.length, spent, face, interest: Math.max(0, face - spent), avgBps };
});

// Borrow calculations
const borrowRepayment = computed(() =>
  side.value === "borrow" && amount.value && effectiveAprBps.value != null
    ? repaymentFor(amount.value, effectiveAprBps.value, D.value, props.market)
    : null
);
const borrowEffBps = computed(() =>
  borrowRepayment.value && amount.value
    ? yieldForPrice(borrowRepayment.value, amount.value, D.value)
    : effectiveAprBps.value
);
const collAsset = computed<ZcMarket>(() => (props.market === "ERG" ? "SigUSD" : "ERG"));
const collAmount = computed(() =>
  borrowRepayment.value && props.oraclePrice > 0
    ? roundUp(
        collateralFor(
          borrowRepayment.value,
          props.market,
          props.filters.coverage + 10,
          props.oraclePrice
        ),
        collAsset.value
      )
    : null
);
const borrowLiq = computed(() => {
  if (!borrowRepayment.value || !collAmount.value) return null;
  const col =
    props.market === "ERG"
      ? { erg: 0.001, usd: collAmount.value, tokens: [] }
      : { erg: collAmount.value, usd: 0, tokens: [] };
  return liquidationPrice(col, borrowRepayment.value, props.market, props.filters.coverage);
});

// Sale Ask (secondary bond resale) calculations
const salePrice = computed(() =>
  side.value === "sell" && amount.value && effectiveAprBps.value != null
    ? roundDown(priceForYield(amount.value, effectiveAprBps.value, D.value), props.market)
    : null
);
const saleEffBps = computed(() =>
  salePrice.value && amount.value
    ? yieldForPrice(amount.value, salePrice.value, D.value)
    : effectiveAprBps.value
);
const saleParPct = computed(() =>
  salePrice.value && amount.value ? (salePrice.value / amount.value) * 100 : null
);
const saleDiscount = computed(() =>
  salePrice.value != null && amount.value != null ? Math.max(0, amount.value - salePrice.value) : null
);

const dockTone = computed(() =>
  side.value === "lend" ? "bid" : side.value === "borrow" ? "ask" : "cobalt"
);

const matchReadout = computed(() => {
  const book = ticketBook.value;
  if (!book) return props.connected ? "Scanning book…" : "Feed offline";
  const target = effectiveAprBps.value;
  if (side.value === "lend") {
    const n = book.asks.filter(
      (r) => isBookRowActive(r) && !r.window && (target == null || r.y >= target)
    ).length;
    return `${n} ${n === 1 ? "ask" : "asks"} ≤ ${formatDur(T.value, props.unit)}${
      target != null ? ` ≥ ${formatApr(target)}` : ""
    }`;
  }
  const n = book.bids.filter(
    (r) => isBookRowActive(r) && (target == null || r.y <= target)
  ).length;
  return `${n} ${n === 1 ? "bid" : "bids"} at ${
    target != null ? formatApr(target) : "market"
  } · ${formatDur(D.value, props.unit)}`;
});

function handleAmountInput(e: Event) {
  const cleaned = (e.target as HTMLInputElement).value.replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  const normalized = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : cleaned;
  if (normalized === "" || Number.isFinite(Number(normalized))) {
    amountText.value = normalized;
  }
}

function handleAprInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  if (raw === "") {
    aprInput.value = null;
    return;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 200) aprInput.value = n;
}

function snapToBestBid() {
  if (bestBidAtTerm.value == null) return;
  const bps =
    side.value === "lend" ? Math.round(bestBidAtTerm.value) : Math.ceil(bestBidAtTerm.value) + 1;
  aprInput.value = Number((bps / 100).toFixed(2));
}

function openPreview() {
  const m = props.market;
  if (side.value === "lend") {
    const sim = lendSimSummary.value;
    const isDirect = amount.value != null && sim.count > 0;
    const rateBps = isDirect ? sim.avgBps : effectiveAprBps.value ?? 800;
    const bpsInt = Math.max(0, Math.round(rateBps ?? 800));
    const maxBlk = Math.max(DAY_BLOCKS, T.value);
    const offerBody = !isDirect
      ? buildOfferBody({
          market: m,
          capital: amount.value,
          minYield: bpsInt,
          points: [
            { d: DAY_BLOCKS, y: bpsInt },
            { d: Math.max(2 * DAY_BLOCKS, maxBlk), y: bpsInt }
          ],
          minBlocks: DAY_BLOCKS,
          maxBlocks: maxBlk,
          floor: props.filters.coverage,
          expiry: props.height > 0 ? props.height + 5040 : undefined
        })
      : null;

    emit("preview", {
      title: isDirect ? `Direct Lend (${m})` : `Lend Offer (${m})`,
      subtitle: isDirect
        ? `Matches ${sim.count} open ${sim.count === 1 ? "ask" : "asks"} immediately`
        : `Rolling yield offer on ${m} yield curve`,
      badge: isDirect ? "Wallet Lend" : "Lend Offer · Bid",
      tone: "bid",
      heroLabel: isDirect ? "Immediate allocation" : "Offer capital",
      heroValue: formatMarketAmount(isDirect ? sim.spent : amount.value ?? 0, m),
      heroSub: `${formatApr(rateBps)} APR · ≤ ${formatDur(T.value, props.unit)}`,
      rows: [
        ...(isDirect
          ? [
              { label: "Matched asks", value: `${sim.count} bonds` },
              { label: "Claim at maturity", value: formatMarketAmount(sim.face, m) },
              {
                label: "Gross interest",
                value: `+${formatMarketAmount(sim.interest, m)}`,
                tone: "bid" as const
              }
            ]
          : [
              { label: "Minimum APR floor", value: formatApr(rateBps), tone: "bid" as const },
              { label: "Accepted maturities", value: `1d – ${formatDur(T.value, props.unit)}` }
            ]),
        { label: "Cover floor", value: `≥ ${props.filters.coverage}% · oracle` },
        { label: "Delivery", value: "Bond units (1:1)" }
      ],
      rawSummary: {
        type: isDirect ? "walletLend" : "lendOffer",
        market: m,
        amount: amount.value,
        maxBlocks: T.value,
        minCoverPct: props.filters.coverage,
        aprBps: rateBps != null ? Math.round(rateBps) : null
      },
      txAction: isDirect
        ? {
            type: "walletLendBatch",
            market: m,
            steps: (simRes.value?.matches || []).map((mt, idx) => ({
              boxId: mt.counterpartyId,
              units: mt.units ? BigInt(mt.units) : null,
              label: `Fill #${idx + 1} (${mt.counterpartyId.slice(0, 8)}…)`,
              expectedCostRaw: mt.cost ? BigInt(mt.cost) : 0n
            }))
          }
        : offerBody
          ? { type: "createOffer", body: offerBody }
          : null
    });
  } else if (side.value === "borrow") {
    const rep = borrowRepayment.value;
    const orderBody = buildOrderBody({
      market: m,
      pricing: "fixed",
      principal: amount.value,
      repayment: rep,
      mode: "fixed",
      maturity: maturity.value,
      exact: false,
      collateral:
        m === "ERG"
          ? { erg: 0.001, usd: collAmount.value ?? 0, tokens: [] }
          : { erg: collAmount.value ?? 0.001, usd: 0, tokens: [] },
      rule: "oracle",
      ratio: props.filters.coverage,
      guard: props.filters.coverage
    });

    emit("preview", {
      title: `Borrow Order (${m})`,
      subtitle: `Matures ${dateAtHeight(maturity.value, props.height)}`,
      badge: "Borrow · Ask",
      tone: "ask",
      heroLabel: "Principal received",
      heroValue: formatMarketAmount(amount.value ?? 0, m),
      heroSub: rep
        ? `Repay ${formatMarketAmount(rep, m)} · ${formatApr(borrowEffBps.value)} APR`
        : `${formatApr(effectiveAprBps.value)} target APR`,
      rows: [
        { label: "Repayment", value: rep ? formatMarketAmount(rep, m) : "—" },
        {
          label: "Gross interest",
          value: rep && amount.value ? formatMarketAmount(rep - amount.value, m) : "—",
          tone: "ask"
        },
        {
          label: "Maturity",
          value: `${dateAtHeight(maturity.value, props.height)} · ${formatDur(D.value, props.unit)}`
        },
        {
          label: "Collateral",
          value: collAmount.value
            ? `${formatMarketAmount(collAmount.value, collAsset.value)} (${props.filters.coverage + 10}%)`
            : `${props.filters.coverage + 10}% ${collAsset.value}`
        },
        {
          label: "Liquidation",
          value: borrowLiq.value?.price
            ? `ERG ${borrowLiq.value.dir === "below" ? "<" : ">"} $${borrowLiq.value.price.toFixed(3)}`
            : `< ${props.filters.coverage}% cover`
        }
      ],
      rawSummary: {
        type: "borrowOrder",
        market: m,
        principal: amount.value,
        repayment: rep,
        maturity: maturity.value,
        blocksLeft: D.value,
        aprBps: borrowEffBps.value != null ? Math.round(borrowEffBps.value) : null,
        collateralAsset: collAsset.value,
        collateralAmount: collAmount.value,
        liquidationRatioPct: props.filters.coverage
      },
      txAction: orderBody ? { type: "createOrder", body: orderBody } : null
    });
  } else {
    const price = salePrice.value;
    emit("preview", {
      title: `Sale Ask (${m})`,
      subtitle: `Secondary bond listing · Matures ${dateAtHeight(maturity.value, props.height)}`,
      badge: "Resale · Ask",
      tone: "cobalt",
      heroLabel: "Receive on sale",
      heroValue: price != null ? formatMarketAmount(price, m) : "—",
      heroSub: `${formatApr(saleEffBps.value)} APR · ${
        saleParPct.value != null ? `${saleParPct.value.toFixed(2)}% of face` : "—"
      }`,
      rows: [
        { label: "Bond face value", value: formatMarketAmount(amount.value ?? 0, m) },
        {
          label: "Discount to par",
          value: saleDiscount.value != null ? `-${formatMarketAmount(saleDiscount.value, m)}` : "—",
          tone: "cobalt"
        },
        {
          label: "Remaining term",
          value: `${dateAtHeight(maturity.value, props.height)} · ${formatDur(D.value, props.unit)}`
        },
        {
          label: "Orderbook match",
          value: matchReadout.value
        }
      ],
      rawSummary: {
        type: "saleAsk",
        market: m,
        face: amount.value,
        askPrice: price,
        maturity: maturity.value,
        blocksLeft: D.value,
        aprBps: saleEffBps.value != null ? Math.round(saleEffBps.value) : null
      },
      studioRedirect: {
        name: "zc-studio",
        query: { type: "sell" },
        label: "Pick Bond in Studio"
      }
    });
  }
}
const studioLink = computed(() => {
  const query: Record<string, string> = {
    type: side.value,
    days: String(termDays.value)
  };
  if (amount.value != null) query.amount = String(amount.value);
  if (effectiveAprBps.value != null) query.apr = (effectiveAprBps.value / 100).toFixed(2);
  return { name: "zc-studio", query };
});
</script>

<template>
  <aside
    class="sf-action-dock flex h-full min-h-0 flex-col rounded-[22px] rounded-tr-[6px]"
    :data-tone="dockTone"
    aria-label="Order Ticket"
    @mousemove="onDockPointerMove"
  >
    <!-- Header + Side Switch -->
    <div class="sf-panel-head shrink-0 px-4 pt-3.5 pb-3">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <market-coin :market="market" :size="22" bare />
          <h2 class="sf-display text-[16px] font-bold leading-none text-[color:var(--sf-ink)]">
            Order Ticket
          </h2>
        </div>
        <span class="sf-mono text-[10.5px] font-medium text-[color:var(--sf-muted)]">
          {{
            walletMarketBalance != null
              ? `${formatNumber(walletMarketBalance, 2)} ${market}`
              : market
          }}
        </span>
      </div>

      <div class="sf-seg ticket-side-seg mt-3 text-[11.5px]" role="tablist" aria-label="Order type">
        <button
          type="button"
          role="tab"
          :aria-selected="side === 'lend'"
          class="sf-seg-btn ticket-side-btn"
          :class="side === 'lend' ? 'is-active tone-bid' : ''"
          @click="side = 'lend'"
        >
          Lend Bid
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="side === 'borrow'"
          class="sf-seg-btn ticket-side-btn"
          :class="side === 'borrow' ? 'is-active tone-ask' : ''"
          @click="side = 'borrow'"
        >
          Borrow Ask
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="side === 'sell'"
          class="sf-seg-btn ticket-side-btn"
          :class="side === 'sell' ? 'is-active tone-cobalt' : ''"
          @click="side = 'sell'"
        >
          Sale Ask
        </button>
      </div>
    </div>

    <!-- Scrollable Form Body -->
    <div class="sf-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
      <!-- Amount -->
      <div>
        <div class="mb-1 flex items-center justify-between text-[11px]">
          <label for="sf-rb-amount" class="font-medium text-[color:var(--sf-ink-2)]">
            {{ side === "lend" ? "Capital" : side === "borrow" ? "Principal" : "Face value" }}
          </label>
          <div
            v-if="walletMarketBalance != null && walletMarketBalance > 0 && side === 'lend'"
            class="sf-mono flex items-center gap-1 text-[10px]"
          >
            <button
              v-for="[lbl, f] in ([['25%', 0.25], ['50%', 0.5], ['Max', 1]] as const)"
              :key="lbl"
              type="button"
              class="rounded-[4px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-1.5 py-0.5 text-[color:var(--sf-muted)] transition-colors hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-cobalt)]"
              @click="setBalanceFraction(f)"
            >
              {{ lbl }}
            </button>
          </div>
        </div>

        <div
          class="sf-input-well flex items-center gap-2 rounded-xl px-3 py-2"
          :data-tone="dockTone"
        >
          <input
            id="sf-rb-amount"
            :value="amountText"
            inputmode="decimal"
            autocomplete="off"
            placeholder="0.00"
            class="sf-mono w-full min-w-0 bg-transparent text-[17px] font-semibold text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
            @input="handleAmountInput"
          />
          <span class="sf-mono shrink-0 text-[11.5px] font-semibold text-[color:var(--sf-muted)]">
            {{ market }}
          </span>
        </div>
      </div>

      <!-- Target APR + Gradient Slider -->
      <div>
        <div class="mb-1 flex items-center justify-between text-[11px]">
          <label for="sf-rb-apr" class="font-medium text-[color:var(--sf-ink-2)]">
            {{ side === "lend" ? "Min APR" : side === "borrow" ? "Offered APR" : "Sale APR" }}
          </label>
          <button
            type="button"
            :disabled="bestBidAtTerm == null"
            class="sf-mono text-[10.5px] font-semibold text-[color:var(--sf-cobalt)] transition-opacity hover:underline disabled:opacity-40"
            @click="snapToBestBid"
          >
            Best bid {{ formatApr(bestBidAtTerm) }}
          </button>
        </div>

        <div
          class="sf-input-well flex items-center gap-2 rounded-xl px-3 py-2"
          :data-tone="dockTone"
        >
          <input
            id="sf-rb-apr"
            type="number"
            step="0.05"
            min="0"
            max="200"
            :value="effectiveAprBps != null ? (effectiveAprBps / 100).toFixed(2) : ''"
            placeholder="0.00"
            class="sf-mono w-full min-w-0 bg-transparent text-[16px] font-semibold text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
            @input="handleAprInput"
          />
          <span class="sf-mono shrink-0 text-[11px] font-semibold text-[color:var(--sf-muted)]">
            % APR
          </span>
        </div>

        <input
          type="range"
          min="0"
          max="30"
          step="0.05"
          :value="Math.min(30, (effectiveAprBps ?? 0) / 100)"
          aria-label="Adjust target APR"
          class="sf-range ticket-range mt-2.5"
          :style="{
            '--range-fill': sliderPct,
            '--range-color':
              side === 'lend'
                ? 'var(--sf-bid)'
                : side === 'borrow'
                  ? 'var(--sf-ask)'
                  : 'var(--sf-cobalt)'
          }"
          @input="aprInput = Number(($event.target as HTMLInputElement).value)"
        />
      </div>

      <!-- Maturity Tenor Tray -->
      <div>
        <div class="mb-1 flex items-center justify-between text-[11px]">
          <span class="font-medium text-[color:var(--sf-ink-2)]">
            {{ side === "lend" ? "Max maturity" : side === "borrow" ? "Term" : "Remaining" }}
          </span>
          <span class="sf-mono text-[10px] text-[color:var(--sf-dim)]">
            {{ dateAtHeight(maturity, height) }}
          </span>
        </div>
        <div class="sf-seg grid w-full grid-cols-6">
          <button
            v-for="d in TERMS"
            :key="d"
            type="button"
            :aria-pressed="termDays === d"
            class="sf-seg-btn sf-mono py-1.5 text-[10.5px]"
            :class="termDays === d ? 'is-active tone-cobalt' : ''"
            @click="termDays = d"
          >
            {{ d === 365 ? "1y" : `${d}d` }}
          </button>
        </div>
      </div>

      <!-- Live Match Pulse -->
      <div
        class="flex items-center gap-2 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-3 py-2"
      >
        <zap-icon
          class="h-3.5 w-3.5 shrink-0"
          :class="
            side === 'lend'
              ? 'text-[color:var(--sf-bid)]'
              : side === 'borrow'
                ? 'text-[color:var(--sf-ask)]'
                : 'text-[color:var(--sf-cobalt)]'
          "
        />
        <span class="sf-mono text-[11px] font-medium text-[color:var(--sf-ink-2)]">
          {{ matchReadout }}
        </span>
      </div>

      <!-- Live Simulated Output / Borrow Terms / Sale Pricing -->
      <div
        v-if="amount != null"
        class="sf-stage-sharp space-y-1.5 px-3 py-2.5 text-[11.5px]"
      >
        <template v-if="side === 'lend'">
          <div class="flex items-center justify-between">
            <span class="text-[color:var(--sf-muted)]">Execution</span>
            <span class="sf-mono font-semibold text-[color:var(--sf-bid)]">
              {{
                simLoading
                  ? "Simulating…"
                  : lendSimSummary.count > 0
                    ? `${lendSimSummary.count} fills · ${formatApr(lendSimSummary.avgBps)}`
                    : "Rests as offer"
              }}
            </span>
          </div>
          <div
            v-if="!simLoading && lendSimSummary.count > 0"
            class="sf-mono flex items-center justify-between text-[11px] text-[color:var(--sf-ink-2)]"
          >
            <span>Placed {{ formatMarketAmount(lendSimSummary.spent, market) }}</span>
            <span class="font-semibold text-[color:var(--sf-bid)]">
              +{{ formatMarketAmount(lendSimSummary.interest, market) }}
            </span>
          </div>
        </template>

        <template v-else-if="side === 'borrow'">
          <div class="flex items-center justify-between">
            <span class="text-[color:var(--sf-muted)]">Repay</span>
            <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              {{ borrowRepayment ? formatMarketAmount(borrowRepayment, market) : "—" }}
            </span>
          </div>
          <div class="sf-mono flex items-center justify-between text-[11px] text-[color:var(--sf-muted)]">
            <span>Collateral ({{ filters.coverage + 10 }}%)</span>
            <span class="font-medium text-[color:var(--sf-ink-2)]">
              {{ collAmount ? formatMarketAmount(collAmount, collAsset) : "—" }}
            </span>
          </div>
          <div
            v-if="borrowLiq?.price"
            class="sf-mono flex items-center justify-between text-[11px] text-[color:var(--sf-muted)]"
          >
            <span>Liquidates</span>
            <span class="font-semibold text-[color:var(--sf-ask)]">
              ERG {{ borrowLiq.dir === "below" ? "<" : ">" }} ${{ borrowLiq.price.toFixed(3) }}
            </span>
          </div>
        </template>

        <template v-else>
          <div class="flex items-center justify-between">
            <span class="text-[color:var(--sf-muted)]">Receive now</span>
            <span class="sf-mono font-semibold text-[color:var(--sf-cobalt)]">
              {{ salePrice != null ? formatMarketAmount(salePrice, market) : "—" }}
            </span>
          </div>
          <div class="sf-mono flex items-center justify-between text-[11px] text-[color:var(--sf-muted)]">
            <span>Par (P / F)</span>
            <span class="font-medium text-[color:var(--sf-ink-2)]">
              {{ saleParPct != null ? `${saleParPct.toFixed(2)}%` : "—" }}
            </span>
          </div>
          <div
            v-if="saleDiscount != null"
            class="sf-mono flex items-center justify-between text-[11px] text-[color:var(--sf-muted)]"
          >
            <span>Discount</span>
            <span class="font-medium text-[color:var(--sf-ink-2)]">
              -{{ formatMarketAmount(saleDiscount, market) }}
            </span>
          </div>
        </template>
      </div>
    </div>

    <!-- Pinned Action Footer -->
    <div class="shrink-0 space-y-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-4 py-3">
      <button
        type="button"
        :disabled="!amount"
        class="flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-40"
        :class="
          side === 'lend' ? 'sf-btn-bid' : side === 'borrow' ? 'sf-btn-ask' : 'sf-btn-cobalt'
        "
        @click="openPreview"
      >
        <span>
          {{
            side === "lend"
              ? amount && lendSimSummary.count > 0
                ? `Lend ${formatMarketAmount(lendSimSummary.spent, market)}`
                : "Preview Lend Offer"
              : side === "borrow"
                ? "Preview Borrow Order"
                : "Preview Sale Ask"
          }}
        </span>
        <arrow-right-icon class="h-3.5 w-3.5" />
      </button>

      <router-link
        :to="studioLink"
        class="sf-btn-outline flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/50 px-4 text-[12px] font-semibold text-[color:var(--sf-cobalt)] transition-all hover:bg-[color:var(--sf-cobalt-soft)]"
      >
        <span>Full Studio</span>
        <arrow-up-right-icon class="h-3.5 w-3.5" />
      </router-link>

      <div class="flex items-center justify-between pt-0.5 text-[11px] text-[color:var(--sf-muted)]">
        <router-link
          to="/app/auctions"
          class="inline-flex items-center gap-0.5 font-medium transition-colors hover:text-[color:var(--sf-ink)]"
        >
          <span>Auctions</span>
          <chevron-right-icon class="h-3 w-3" />
        </router-link>
        <router-link
          to="/app/portfolio"
          class="inline-flex items-center gap-0.5 font-medium transition-colors hover:text-[color:var(--sf-ink)]"
        >
          <span>Portfolio</span>
          <chevron-right-icon class="h-3 w-3" />
        </router-link>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.ticket-side-seg {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
  gap: 5px;
  padding: 4px;
}

.ticket-side-btn {
  padding: 8px 10px;
}

.ticket-range {
  background: linear-gradient(
    to right,
    var(--range-color, var(--sf-cobalt)) 0%,
    var(--range-color, var(--sf-cobalt)) var(--range-fill, 0%),
    var(--sf-line-strong) var(--range-fill, 0%),
    var(--sf-line-strong) 100%
  );
}
</style>
