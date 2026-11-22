<script setup lang="ts">
import { decimalize } from "@fleet-sdk/common";
import { ArrowRightIcon, ZapIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ExecutionPreviewPayload } from "./ExecutionPreviewModal.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { ERG_DECIMALS, ERG_TOKEN_ID } from "@/constants";
import { buildWalletLendDraft, zcApi } from "@/services/zcApi";
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
  repaymentFor,
  roundUp,
  SIGUSD_TOKEN_ID,
  snapMaturity,
  yieldForPrice
} from "@/utils/zcMath";

const TERMS = [7, 30, 60, 90, 180, 365] as const;

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
    side?: "lend" | "borrow";
    amount?: string;
    days?: number;
    apr?: number | null;
  } | null;
}>();

const emit = defineEmits<{
  (e: "preview", payload: ExecutionPreviewPayload): void;
}>();

const wallet = useWalletStore();

const side = ref<"lend" | "borrow">("lend");
const amountText = ref<string>("");
const termDays = ref<number>(30);
const aprInput = ref<number | null>(null);

const ticketBook = ref<ZcOrderbook | null>(null);
const simRes = ref<ZcSimulateResponse | null>(null);
const simLoading = ref(false);

// Apply external prefills (from Landing Quote Card or OfferInspector!)
watch(
  () => props.prefill?.seq,
  () => {
    const pf = props.prefill;
    if (!pf) return;
    if (pf.side) side.value = pf.side;
    if (pf.amount !== undefined) amountText.value = pf.amount;
    if (pf.days && pf.days >= 1) {
      // snap to nearest preset or keep exact
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
  return side.value === "borrow" ? Math.ceil(bestBidAtTerm.value) + 1 : Math.round(bestBidAtTerm.value);
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
        // rate limit or transient
      } finally {
        if (mySeq === simSeq) simLoading.value = false;
      }
    }, 320);
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
  const spent = simRes.value?.filled != null ? fromMarket(simRes.value.filled, props.market) ?? 0 : 0;
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

const matchReadout = computed(() => {
  const book = ticketBook.value;
  if (!book) return props.connected ? "Scanning order book…" : "Connect feed to match";
  const target = effectiveAprBps.value;
  if (side.value === "lend") {
    const n = book.asks.filter(
      (r) => isBookRowActive(r) && !r.window && (target == null || r.y >= target)
    ).length;
    return `${n} ${n === 1 ? "ask" : "asks"} ≤ ${formatDur(T.value, props.unit)}${
      target != null ? ` pay ≥ ${formatApr(target)}` : ""
    }`;
  }
  const n = book.bids.filter(
    (r) => isBookRowActive(r) && (target == null || r.y <= target)
  ).length;
  return `${n} ${n === 1 ? "bid" : "bids"} accept ${
    target != null ? formatApr(target) : "orders"
  } near ${formatDur(D.value, props.unit)}`;
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
  const bps = side.value === "borrow" ? Math.ceil(bestBidAtTerm.value) + 1 : Math.round(bestBidAtTerm.value);
  aprInput.value = Number((bps / 100).toFixed(2));
}

function openPreview() {
  const m = props.market;
  if (side.value === "lend") {
    const sim = lendSimSummary.value;
    const isDirect = amount.value != null && sim.count > 0;
    const rateBps = isDirect ? sim.avgBps : effectiveAprBps.value ?? 800;
    emit("preview", {
      title: isDirect ? `Direct Lend Plan (${m})` : `Standing Lend Offer (${m})`,
      subtitle: isDirect
        ? `Matches ${sim.count} open ${sim.count === 1 ? "ask" : "asks"} immediately`
        : `Posts a rolling yield offer on the ${m} rate book`,
      badge: isDirect ? "Wallet Lend" : "Lend Offer · Bid",
      heroLabel: isDirect ? "Immediate allocation" : "Offer capital",
      heroValue: formatMarketAmount(isDirect ? sim.spent : amount.value ?? 0, m),
      heroSub: `${formatApr(rateBps)} APR · ≤ ${formatDur(T.value, props.unit)}`,
      rows: [
        ...(isDirect
          ? [
              { label: "Matched asks", value: `${sim.count} bonds` },
              { label: "Total claim at maturity", value: formatMarketAmount(sim.face, m) },
              {
                label: "Projected gross interest",
                value: `+${formatMarketAmount(sim.interest, m)}`,
                tone: "bid" as const
              }
            ]
          : [
              { label: "Minimum APR floor", value: formatApr(rateBps), tone: "bid" as const },
              { label: "Accepted maturities", value: `1d – ${formatDur(T.value, props.unit)}` }
            ]),
        { label: "Minimum collateral cover", value: `≥ ${props.filters.coverage}% (oracle rule)` },
        { label: "Delivery", value: "Bond units (1:1 circulating)" }
      ],
      rawSummary: {
        type: isDirect ? "walletLend" : "lendOffer",
        market: m,
        amount: amount.value,
        maxBlocks: T.value,
        minCoverPct: props.filters.coverage,
        aprBps: rateBps != null ? Math.round(rateBps) : null
      }
    });
  } else {
    const rep = borrowRepayment.value;
    emit("preview", {
      title: `Borrow Order Plan (${m})`,
      subtitle: `Zero-coupon borrow order · matures ${dateAtHeight(maturity.value, props.height)}`,
      badge: "Borrow Order · Ask",
      heroLabel: "You receive if filled",
      heroValue: formatMarketAmount(amount.value ?? 0, m),
      heroSub: rep
        ? `Repay ${formatMarketAmount(rep, m)} · ${formatApr(borrowEffBps.value)} APR`
        : `${formatApr(effectiveAprBps.value)} target APR`,
      rows: [
        { label: "Repayment at maturity", value: rep ? formatMarketAmount(rep, m) : "—" },
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
          label: "Collateral locked",
          value: collAmount.value
            ? `${formatMarketAmount(collAmount.value, collAsset.value)} (${props.filters.coverage + 10}% start)`
            : `${props.filters.coverage + 10}% ${collAsset.value}`
        },
        {
          label: "Liquidation trigger",
          value: borrowLiq.value?.price
            ? `ERG ${borrowLiq.value.dir === "below" ? "<" : ">"} $${borrowLiq.value.price.toFixed(3)}`
            : `Under ${props.filters.coverage}% cover`
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
      }
    });
  }
}
</script>

<template>
  <aside class="sf-plate flex h-full flex-col overflow-hidden rounded-2xl" aria-label="Order Ticket">
    <!-- Header -->
    <div class="border-b border-[color:var(--sf-line)] px-4 py-3">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <market-coin :market="market" :size="20" />
          <h2 class="sf-serif text-[16px] font-semibold text-[color:var(--sf-ink)]">Order Ticket</h2>
        </div>
        <span class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
          {{ walletMarketBalance != null ? `${formatNumber(walletMarketBalance, 2)} ${market}` : "Quote mode" }}
        </span>
      </div>

      <!-- Lend / Borrow Switch -->
      <div
        class="mt-2.5 grid grid-cols-2 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5 text-[12px]"
      >
        <button
          type="button"
          :aria-pressed="side === 'lend'"
          class="rounded-md py-1.5 font-semibold transition-all"
          :class="
            side === 'lend'
              ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-bid)] shadow-sm ring-1 ring-slate-900/10'
              : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="side = 'lend'"
        >
          Lend · Bid
        </button>
        <button
          type="button"
          :aria-pressed="side === 'borrow'"
          class="rounded-md py-1.5 font-semibold transition-all"
          :class="
            side === 'borrow'
              ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ask)] shadow-sm ring-1 ring-slate-900/10'
              : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="side = 'borrow'"
        >
          Borrow · Ask
        </button>
      </div>
    </div>

    <!-- Form Body -->
    <div class="sf-scroll flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
      <!-- Amount Input -->
      <div>
        <div class="mb-1 flex items-center justify-between text-[11px]">
          <label for="sf-rb-amount" class="font-medium text-[color:var(--sf-ink-2)]">
            {{ side === "lend" ? "Lending capital" : "Principal to borrow" }}
          </label>
          <button
            v-if="walletMarketBalance != null && walletMarketBalance > 0 && side === 'lend'"
            type="button"
            class="sf-mono text-[10.5px] text-cobalt-600 hover:underline"
            @click="amountText = String(Math.floor(walletMarketBalance * 100) / 100)"
          >
            Max
          </button>
        </div>

        <div
          class="flex items-center gap-2 rounded-xl border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-paper)] px-3 py-2 focus-within:border-cobalt-600"
        >
          <input
            id="sf-rb-amount"
            :value="amountText"
            inputmode="decimal"
            autocomplete="off"
            placeholder="0.00"
            class="sf-mono w-full min-w-0 bg-transparent text-[16px] font-semibold text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
            @input="handleAmountInput"
          />
          <span class="sf-mono shrink-0 text-[11.5px] font-semibold text-[color:var(--sf-muted)]">
            {{ market }}
          </span>
        </div>
      </div>

      <!-- APR Target -->
      <div>
        <div class="mb-1 flex items-center justify-between text-[11px]">
          <label for="sf-rb-apr" class="font-medium text-[color:var(--sf-ink-2)]">
            {{ side === "lend" ? "Minimum APR" : "Offered APR" }}
          </label>
          <button
            type="button"
            :disabled="bestBidAtTerm == null"
            class="sf-mono text-[10.5px] font-medium text-cobalt-600 hover:underline disabled:opacity-40"
            @click="snapToBestBid"
          >
            Best bid {{ formatApr(bestBidAtTerm) }}
          </button>
        </div>

        <div
          class="flex items-center gap-2 rounded-xl border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-paper)] px-3 py-2 focus-within:border-cobalt-600"
        >
          <input
            id="sf-rb-apr"
            type="number"
            step="0.05"
            min="0"
            max="200"
            :value="effectiveAprBps != null ? (effectiveAprBps / 100).toFixed(2) : ''"
            placeholder="0.00"
            class="sf-mono w-full min-w-0 bg-transparent text-[15px] font-semibold text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
            @input="handleAprInput"
          />
          <span class="sf-mono shrink-0 text-[11px] font-medium text-[color:var(--sf-muted)]">
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
          class="sf-range mt-2"
          @input="aprInput = Number(($event.target as HTMLInputElement).value)"
        />
      </div>

      <!-- Maturity Selector -->
      <div>
        <span class="mb-1 block text-[11px] font-medium text-[color:var(--sf-ink-2)]">
          {{ side === "lend" ? "Longest maturity" : "Maturity term" }}
        </span>
        <div class="grid grid-cols-6 gap-1">
          <button
            v-for="d in TERMS"
            :key="d"
            type="button"
            :aria-pressed="termDays === d"
            class="sf-mono rounded-md border py-1.5 text-center text-[10.5px] font-medium transition-all"
            :class="
              termDays === d
                ? 'border-cobalt-600 bg-cobalt-50 text-cobalt-700'
                : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)]'
            "
            @click="termDays = d"
          >
            {{ d === 365 ? "1y" : `${d}d` }}
          </button>
        </div>
      </div>

      <!-- Live Matching Pulse -->
      <div
        class="flex items-center gap-2 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-3 py-2 text-[11.5px] text-[color:var(--sf-ink-2)]"
      >
        <zap-icon
          class="h-3.5 w-3.5 shrink-0"
          :class="side === 'lend' ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ask)]'"
        />
        <span class="sf-mono text-[11px]">{{ matchReadout }}</span>
      </div>

      <!-- Live Simulated Output -->
      <div
        v-if="amount != null"
        class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] p-3 text-[11.5px]"
      >
        <template v-if="side === 'lend'">
          <div class="flex items-center justify-between">
            <span class="text-[color:var(--sf-muted)]">Simulated fills</span>
            <span class="sf-mono font-semibold text-[color:var(--sf-bid)]">
              {{
                simLoading
                  ? "Simulating…"
                  : lendSimSummary.count > 0
                    ? `${lendSimSummary.count} asks · ${formatApr(lendSimSummary.avgBps)}`
                    : "Rests as bid offer"
              }}
            </span>
          </div>
          <div
            v-if="!simLoading && lendSimSummary.count > 0"
            class="sf-mono mt-1.5 flex items-center justify-between text-[11px] text-[color:var(--sf-ink-2)]"
          >
            <span>Placed {{ formatMarketAmount(lendSimSummary.spent, market) }}</span>
            <span class="text-[color:var(--sf-bid)]">
              +{{ formatMarketAmount(lendSimSummary.interest, market) }}
            </span>
          </div>
        </template>

        <template v-else>
          <div class="flex items-center justify-between">
            <span class="text-[color:var(--sf-muted)]">Repay at maturity</span>
            <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              {{ borrowRepayment ? formatMarketAmount(borrowRepayment, market) : "—" }}
            </span>
          </div>
          <div class="sf-mono mt-1.5 flex items-center justify-between text-[11px] text-[color:var(--sf-muted)]">
            <span>Collateral ({{ filters.coverage + 10 }}%)</span>
            <span class="font-medium text-[color:var(--sf-ink-2)]">
              {{ collAmount ? formatMarketAmount(collAmount, collAsset) : "—" }}
            </span>
          </div>
          <div
            v-if="borrowLiq?.price"
            class="sf-mono mt-1 flex items-center justify-between text-[11px] text-[color:var(--sf-muted)]"
          >
            <span>Liquidates</span>
            <span class="font-semibold text-[color:var(--sf-ask)]">
              ERG {{ borrowLiq.dir === "below" ? "<" : ">" }} ${{ borrowLiq.price.toFixed(3) }}
            </span>
          </div>
        </template>
      </div>
    </div>

    <!-- Action Footer -->
    <div class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] p-4">
      <button
        type="button"
        :disabled="!amount"
        class="sf-btn-primary flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-45"
        @click="openPreview"
      >
        <span>
          {{
            side === "lend"
              ? amount && lendSimSummary.count > 0
                ? `Preview Lend ${formatMarketAmount(lendSimSummary.spent, market)}`
                : "Preview Lend Offer"
              : "Preview Borrow Order"
          }}
        </span>
        <arrow-right-icon class="h-3.5 w-3.5" />
      </button>
      <p class="mt-2 text-center text-[11px] text-[color:var(--sf-dim)]">
        Click any ask or bid in the book to inspect its curve &amp; collateral
      </p>
    </div>
  </aside>
</template>
