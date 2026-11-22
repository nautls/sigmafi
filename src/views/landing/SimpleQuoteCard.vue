<script setup lang="ts">
import { ArrowRightIcon, ShieldIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { buildWalletLendDraft, zcApi } from "@/services/zcApi";
import { useZcStore } from "@/stories/zcStore";
import { ZcAskSummary, ZcCurves, ZcMarket, ZcOrderbook, ZcSimulateResponse } from "@/types/zc";
import {
  bestAskAt,
  collateralFor,
  dateAtHeight,
  DAY_BLOCKS,
  DEFAULT_COVER,
  formatApr,
  formatBlocksShort,
  formatCompact,
  formatDaysShort,
  formatMarketAmount,
  formatNumber,
  fromMarket,
  kindLabel,
  lineAt,
  liquidationPrice,
  MIN_MATURITY_BLOCKS,
  repaymentFor,
  roundUp,
  snapMaturity,
  yieldForPrice
} from "@/utils/zcMath";

const TERMS = [7, 30, 60, 90, 180, 365] as const;
const TABLE_TERMS = [7, 30, 90, 180, 365] as const;
const COVERS = [125, 150, 175, 200] as const;

const zc = useZcStore();

const side = ref<"lend" | "borrow">("lend");
const amountText = ref<string>("");
const tenor = ref<number>(90);
const cover = ref<number>(DEFAULT_COVER);
const aprInput = ref<number | null>(null);

const localCurves = ref<{ key: string; data: ZcCurves } | null>(null);
const localBook = ref<{ key: string; data: ZcOrderbook } | null>(null);
const localAsks = ref<{ key: string; data: ZcAskSummary[] } | null>(null);
const simResult = ref<ZcSimulateResponse | null>(null);
const simLoading = ref(false);

const market = computed<ZcMarket>(() => zc.activeMarket);
const contextKey = computed(() => `${market.value}|${cover.value}`);
const bookKey = computed(() => `${market.value}|${cover.value}|${tenor.value}|${side.value}`);
const amount = computed<number | null>(() => {
  if (!amountText.value.trim()) return null;
  const n = Number(amountText.value);
  return Number.isFinite(n) && n > 0 ? n : null;
});

const presets = computed(() =>
  market.value === "ERG" ? [5, 25, 100, 500] : [50, 250, 1000, 5000]
);

const T = computed(() => tenor.value * DAY_BLOCKS);
const h = computed(() => zc.height);
const oraclePrice = computed(() => zc.oracle.price);
const refreshing = computed(() => !!zc.oracle.refreshPending);

const activeCurves = computed<ZcCurves | null>(() => {
  if (!zc.connected) return null;
  if (localCurves.value && localCurves.value.key === contextKey.value) {
    return localCurves.value.data;
  }
  if (cover.value === DEFAULT_COVER) return zc.markets[market.value].curves;
  return null;
});

const activeBook = computed<ZcOrderbook | null>(() =>
  localBook.value && localBook.value.key === bookKey.value ? localBook.value.data : null
);

const activeAsks = computed<ZcAskSummary[]>(() =>
  localAsks.value && localAsks.value.key === bookKey.value ? localAsks.value.data : []
);

const askById = computed(() => new Map(activeAsks.value.map((a) => [a.id, a])));
const obAskById = computed(() => new Map((activeBook.value?.asks || []).map((a) => [a.id, a])));

const maturity = computed(() => (h.value > 0 ? snapMaturity(h.value + T.value, h.value) : T.value));
const D = computed(() => (h.value > 0 ? Math.max(DAY_BLOCKS, maturity.value - h.value) : T.value));

// Fetch live market data for the chosen cover/tenor/market
let dataController: AbortController | null = null;

async function fetchQuoteContext() {
  if (dataController) dataController.abort();
  if (!zc.connected) {
    localCurves.value = null;
    localBook.value = null;
    localAsks.value = null;
    return;
  }

  const ac = new AbortController();
  dataController = ac;
  const covBps = Math.round(cover.value * 100);
  const matchable = !refreshing.value;
  const m = market.value;
  const targetT = T.value;
  const targetD = D.value;
  const cKey = contextKey.value;
  const bKey = bookKey.value;

  try {
    const [curvesRes, bookRes, asksRes] = await Promise.all([
      zcApi.getCurves(m, { coverage: covBps, kind: "all", matchable, grid: false }, ac.signal),
      zcApi.getOrderbook(
        m,
        side.value === "lend"
          ? { coverage: covBps, kind: "all", matchable, grid: false, to: targetT }
          : {
              coverage: covBps,
              kind: "all",
              matchable,
              grid: false,
              around: Math.max(DAY_BLOCKS, targetD)
            },
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
              to: targetT,
              sort: "apr",
              limit: 20
            },
            ac.signal
          )
        : Promise.resolve([])
    ]);

    if (ac.signal.aborted) return;
    localCurves.value = { key: cKey, data: curvesRes };
    localBook.value = { key: bKey, data: bookRes };
    localAsks.value = { key: bKey, data: asksRes };
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
  }
}

watch(
  [() => zc.connected, () => zc.revision, () => zc.refreshSeq, market, cover, tenor, side],
  () => {
    void fetchQuoteContext();
  },
  { immediate: true }
);

// Reset custom APR override when market or tenor changes
watch([market, tenor], () => {
  aprInput.value = null;
});

// Debounced live simulation via POST /sigmafi/zc/simulate for Lend quotes
let simTimer: number | null = null;
let simController: AbortController | null = null;
let simSeq = 0;

watch(
  [() => zc.connected, () => zc.revision, () => zc.refreshSeq, market, side, amount, tenor, cover],
  () => {
    if (simTimer !== null) {
      window.clearTimeout(simTimer);
      simTimer = null;
    }
    if (simController) {
      simController.abort();
      simController = null;
    }

    if (!zc.connected || side.value !== "lend" || !amount.value) {
      simResult.value = null;
      simLoading.value = false;
      return;
    }

    const draft = buildWalletLendDraft({
      market: market.value,
      amount: amount.value,
      to: T.value,
      coverage: cover.value
    });

    if (!draft) {
      simResult.value = null;
      simLoading.value = false;
      return;
    }

    const mySeq = ++simSeq;
    simLoading.value = true;
    simTimer = window.setTimeout(async () => {
      const ac = new AbortController();
      simController = ac;
      try {
        const res = await zcApi.simulate(draft, ac.signal);
        if (mySeq === simSeq) {
          simResult.value = res;
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
      } finally {
        if (mySeq === simSeq) {
          simLoading.value = false;
        }
      }
    }, 300);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  if (dataController) dataController.abort();
  if (simController) simController.abort();
  if (simTimer !== null) window.clearTimeout(simTimer);
});

// Lend quote plan
const lendPlan = computed(() => {
  const m = market.value;
  const matches = simResult.value?.matches || [];
  const take = matches.map((mt) => {
    const a = askById.value.get(mt.counterpartyId);
    const ob = obAskById.value.get(mt.counterpartyId);
    const kind = a?.kind || ob?.kind || "order";
    const cost = fromMarket(mt.cost, m) ?? 0;
    const face = fromMarket(mt.face, m) ?? 0;
    const d = Math.max(1, (mt.maturity ?? h.value + DAY_BLOCKS) - h.value);
    return {
      id: mt.counterpartyId,
      kind,
      label: kindLabel(kind),
      cost,
      face,
      yieldBps: mt.yieldBps,
      d
    };
  });

  const spent =
    simResult.value?.filled != null
      ? fromMarket(simResult.value.filled, m) ?? 0
      : take.reduce((acc, x) => acc + x.cost, 0);
  const totalFace = take.reduce((acc, x) => acc + x.face, 0);
  const interest = Math.max(0, totalFace - spent);
  const avgBps =
    spent > 0 ? take.reduce((acc, x) => acc + x.cost * (x.yieldBps ?? 0), 0) / spent : null;
  const bestBps =
    activeBook.value?.bestAsk ??
    activeAsks.value[0]?.quote?.yieldBps ??
    bestAskAt(activeCurves.value, T.value, askById.value, h.value);
  const remaining = amount.value != null ? Math.max(0, amount.value - spent) : 0;

  return { take, spent, totalFace, interest, avgBps, bestBps, remaining };
});

const offerRateAtTenor = computed(() => {
  const b = activeCurves.value ? lineAt(activeCurves.value.bidLine, T.value) : null;
  return b != null ? Math.round(b) : 800;
});

// Borrow quote math (matches Simple.js exactly)
const borrowBidBps = computed(() =>
  activeCurves.value ? lineAt(activeCurves.value.bidLine, D.value) : null
);
const autoBorrowBps = computed(() =>
  borrowBidBps.value == null ? null : Math.ceil(borrowBidBps.value) + 1
);
const targetBorrowBps = computed(() =>
  aprInput.value != null ? Math.round(aprInput.value * 100) : autoBorrowBps.value
);

const borrowRepayment = computed(() =>
  amount.value && targetBorrowBps.value != null
    ? repaymentFor(amount.value, targetBorrowBps.value, D.value, market.value)
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

const borrowInterest = computed(() =>
  borrowRepayment.value && amount.value ? Math.max(0, borrowRepayment.value - amount.value) : null
);

const borrowParPct = computed(() =>
  borrowRepayment.value && amount.value && borrowRepayment.value > 0
    ? (amount.value / borrowRepayment.value) * 100
    : null
);

const collAsset = computed<ZcMarket>(() => (market.value === "ERG" ? "SigUSD" : "ERG"));
const collAmount = computed(() =>
  borrowRepayment.value && oraclePrice.value > 0
    ? roundUp(
        collateralFor(borrowRepayment.value, market.value, cover.value + 10, oraclePrice.value),
        collAsset.value
      )
    : null
);

const borrowCollateral = computed(() =>
  market.value === "ERG"
    ? { erg: 0.001, usd: collAmount.value || 0, tokens: [] }
    : { erg: collAmount.value || 0, usd: 0, tokens: [] }
);

const borrowLiq = computed(() =>
  borrowRepayment.value && collAmount.value
    ? liquidationPrice(borrowCollateral.value, borrowRepayment.value, market.value, cover.value)
    : null
);

const liqDistancePct = computed(() => {
  if (!borrowLiq.value?.price || !oraclePrice.value) return null;
  return Math.abs(oraclePrice.value / borrowLiq.value.price - 1) * 100;
});

const borrowFillsNow = computed(
  () =>
    borrowBidBps.value != null &&
    borrowEffBps.value != null &&
    borrowEffBps.value >= borrowBidBps.value
);

// Tabular rates across key maturities (replaces graph!)
const maturityRates = computed(() =>
  TABLE_TERMS.map((d) => {
    const blocks = d * DAY_BLOCKS;
    const c = activeCurves.value;
    const bid = c ? lineAt(c.bidLine, blocks) : null;
    const ask = bestAskAt(c, blocks, askById.value, h.value);
    return { days: d, bid, ask };
  })
);

function handleAmountInput(e: Event) {
  const target = e.target as HTMLInputElement;
  const cleaned = target.value.replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  const normalized = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : cleaned;
  if (normalized === "" || Number.isFinite(Number(normalized))) {
    amountText.value = normalized;
  }
}

function handleAprNumberInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  if (val === "") {
    aprInput.value = null;
    return;
  }
  const n = Number(val);
  if (Number.isFinite(n) && n >= 0 && n <= 200) {
    aprInput.value = n;
  }
}

function marketCount(m: ZcMarket): number {
  const t = zc.markets[m].curves?.totals;
  return (t?.asks.count ?? 0) + (t?.offers.count ?? 0);
}

const appLinkTo = computed(() => {
  const query: Record<string, string> = {
    market: market.value,
    side: side.value,
    days: String(tenor.value),
    cover: String(cover.value)
  };
  if (amount.value != null) query.amount = String(amount.value);
  if (side.value === "borrow" && targetBorrowBps.value != null) {
    query.apr = (targetBorrowBps.value / 100).toFixed(2);
  }
  return { path: "/app", query };
});

const ctaLabel = computed(() => {
  if (side.value === "lend") {
    if (amount.value && lendPlan.value.take.length > 0) {
      return `Lend ${formatMarketAmount(lendPlan.value.spent, market.value)} in app`;
    }
    if (amount.value) {
      return `Post ${formatMarketAmount(amount.value, market.value)} offer in app`;
    }
    return `Open ${market.value} Rate Book`;
  }
  if (amount.value) {
    return `Borrow ${formatMarketAmount(amount.value, market.value)} in app`;
  }
  return `Open ${market.value} Rate Book`;
});
</script>

<template>
  <div class="sf-plate relative overflow-hidden rounded-2xl" aria-label="Bond quote calculator">
    <!-- Header: Side Intent + Market Switch (no "Term structure" label!) -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--sf-line)] px-4 py-3 sm:px-5"
    >
      <div
        class="inline-flex rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
        role="group"
        aria-label="Action"
      >
        <button
          type="button"
          :aria-pressed="side === 'lend'"
          class="rounded-md px-3.5 py-1.5 text-[12.5px] font-semibold transition-all"
          :class="
            side === 'lend'
              ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-bid)] shadow-sm ring-1 ring-slate-900/10'
              : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="side = 'lend'"
        >
          Lend
        </button>
        <button
          type="button"
          :aria-pressed="side === 'borrow'"
          class="rounded-md px-3.5 py-1.5 text-[12.5px] font-semibold transition-all"
          :class="
            side === 'borrow'
              ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ask)] shadow-sm ring-1 ring-slate-900/10'
              : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="side = 'borrow'"
        >
          Borrow
        </button>
      </div>

      <div
        class="inline-flex rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
        role="tablist"
        aria-label="Market"
      >
        <button
          v-for="m in (['ERG', 'SigUSD'] as ZcMarket[])"
          :key="m"
          type="button"
          role="tab"
          :aria-selected="market === m"
          class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-all"
          :class="
            market === m
              ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
              : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="zc.setActiveMarket(m)"
        >
          <market-coin :market="m" :size="15" />
          <span>{{ m }}</span>
          <span
            v-if="marketCount(m) > 0"
            class="sf-mono rounded bg-[color:var(--sf-line)] px-1 text-[10px] text-[color:var(--sf-ink-2)]"
          >
            {{ marketCount(m) }}
          </span>
        </button>
      </div>
    </div>

    <!-- Input Controls -->
    <div class="space-y-4 px-4 py-4 sm:px-5">
      <!-- Amount Field -->
      <div>
        <div class="mb-1.5 flex items-baseline justify-between gap-2">
          <label
            for="sf-landing-quote-amount"
            class="sf-mono text-[10.5px] font-medium uppercase tracking-[0.11em] text-[color:var(--sf-muted)]"
          >
            {{ side === "lend" ? "I want to lend" : "I want to borrow" }}
          </label>
          <span v-if="zc.connected" class="sf-mono text-[11px] text-[color:var(--sf-dim)]">
            {{
              side === "lend"
                ? `${formatCompact(activeCurves?.totals.asks.cost ?? 0)} ${market} asking`
                : `${formatCompact(activeCurves?.totals.offers.capital ?? 0)} ${market} bidding`
            }}
          </span>
        </div>

        <div
          class="flex items-center gap-2 rounded-xl border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-paper)] px-3.5 py-2.5 transition-colors focus-within:border-cobalt-600"
        >
          <input
            id="sf-landing-quote-amount"
            :value="amountText"
            inputmode="decimal"
            autocomplete="off"
            placeholder="0.00"
            class="sf-mono w-full min-w-0 bg-transparent text-[22px] font-semibold tracking-tight text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
            @input="handleAmountInput"
          />
          <button
            v-if="amountText"
            type="button"
            class="sf-mono rounded px-1.5 py-0.5 text-[10.5px] text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
            @click="amountText = ''"
          >
            Clear
          </button>
          <span
            class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2.5 py-1 text-[12.5px] font-semibold text-[color:var(--sf-ink)]"
          >
            <market-coin :market="market" :size="16" />
            <span>{{ market }}</span>
          </span>
        </div>

        <!-- Quick Presets -->
        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            v-for="p in presets"
            :key="p"
            type="button"
            class="sf-mono rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors"
            :class="
              amount === p
                ? 'border-cobalt-600 bg-cobalt-50 text-cobalt-700'
                : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)]'
            "
            @click="amountText = String(p)"
          >
            {{ formatNumber(p, 0, 0) }} {{ market }}
          </button>
        </div>
      </div>

      <!-- Maturity + Cover Settings -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <span
            class="sf-mono mb-1.5 block text-[10px] font-medium uppercase tracking-[0.11em] text-[color:var(--sf-muted)]"
          >
            {{ side === "lend" ? "Longest maturity" : "Maturity" }}
          </span>
          <div class="grid grid-cols-6 gap-1">
            <button
              v-for="d in TERMS"
              :key="d"
              type="button"
              :aria-pressed="tenor === d"
              class="sf-mono rounded-md border py-1.5 text-center text-[11px] font-medium transition-all"
              :class="
                tenor === d
                  ? 'border-cobalt-600 bg-cobalt-50 text-cobalt-700'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)]'
              "
              @click="tenor = d"
            >
              {{ d === 365 ? "1y" : `${d}d` }}
            </button>
          </div>
        </div>

        <div>
          <span
            class="sf-mono mb-1.5 block text-[10px] font-medium uppercase tracking-[0.11em] text-[color:var(--sf-muted)]"
          >
            {{ side === "lend" ? "Collateral at least" : "Liquidate under" }}
          </span>
          <div class="grid grid-cols-4 gap-1">
            <button
              v-for="c in COVERS"
              :key="c"
              type="button"
              :aria-pressed="cover === c"
              class="sf-mono rounded-md border py-1.5 text-center text-[11px] font-medium transition-all"
              :class="
                cover === c
                  ? 'border-cobalt-600 bg-cobalt-50 text-cobalt-700'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)]'
              "
              @click="cover = c"
            >
              {{ c }}%
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- LIVE QUOTE READOUT PANEL -->
    <div
      class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-4 py-4 sm:px-5"
      aria-live="polite"
    >
      <!-- LEND QUOTE -->
      <template v-if="side === 'lend'">
        <div class="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div
              class="sf-mono text-[10px] font-medium uppercase tracking-[0.11em] text-[color:var(--sf-muted)]"
            >
              {{ amount ? "Simulated earn APR" : "Best APR available now" }}
            </div>
            <div class="mt-1 flex items-baseline gap-2.5">
              <span
                class="sf-serif text-[34px] font-semibold leading-none tracking-tight text-[color:var(--sf-bid)]"
              >
                {{
                  !zc.connected
                    ? "—"
                    : amount
                      ? simLoading
                        ? "…"
                        : formatApr(lendPlan.avgBps)
                      : formatApr(lendPlan.bestBps)
                }}
              </span>
              <span class="sf-mono text-[11.5px] text-[color:var(--sf-muted)]">
                simple · ≤ {{ tenor === 365 ? "1y" : `${tenor}d` }}
              </span>
            </div>
          </div>

          <div v-if="amount && lendPlan.take.length > 0" class="text-right">
            <div
              class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]"
            >
              Projected gain
            </div>
            <div class="sf-mono mt-1 text-[14.5px] font-semibold text-[color:var(--sf-bid)]">
              +{{ formatMarketAmount(lendPlan.interest, market) }}
            </div>
          </div>
        </div>

        <p class="mt-2 text-[12.5px] leading-relaxed text-[color:var(--sf-ink-2)]">
          <template v-if="!zc.connected">
            Connecting to the Ergo chain feed to stream live order quotes.
          </template>
          <template v-else-if="amount">
            <template v-if="simLoading">Simulating against open asks…</template>
            <template v-else-if="lendPlan.take.length > 0">
              <strong class="font-semibold text-[color:var(--sf-ink)]">
                {{ lendPlan.take.length }} {{ lendPlan.take.length === 1 ? "bond" : "bonds" }}
              </strong>
              · {{ formatMarketAmount(lendPlan.spent, market) }} of
              {{ formatMarketAmount(amount, market) }} placed immediately
              <template v-if="lendPlan.remaining > 0.0001">
                · remaining {{ formatMarketAmount(lendPlan.remaining, market) }} can rest as an
                offer at {{ formatApr(offerRateAtTenor) }}
              </template>
            </template>
            <template v-else>
              No matching asks up to {{ tenor === 365 ? "1y" : `${tenor}d` }} at ≥{{ cover }}%
              cover. Open the app to post a standing lend offer at
              <strong class="sf-mono font-semibold text-[color:var(--sf-bid)]">{{
                formatApr(offerRateAtTenor)
              }}</strong
              >.
            </template>
          </template>
          <template v-else>
            Enter an amount to simulate exact fill allocation across asks maturing within
            {{ tenor === 365 ? "1 year" : `${tenor} days` }} at ≥{{ cover }}% cover.
          </template>
        </p>

        <!-- Matched Allocation Breakdown (when simulated) -->
        <div
          v-if="amount && lendPlan.take.length > 0"
          class="mt-3.5 overflow-hidden rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card)]"
        >
          <div
            class="sf-mono flex items-center justify-between border-b border-[color:var(--sf-line)] px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]"
          >
            <span>Matched fills</span>
            <span>Claim {{ formatMarketAmount(lendPlan.totalFace, market) }}</span>
          </div>
          <div class="divide-y divide-[color:var(--sf-line)]">
            <div
              v-for="item in lendPlan.take.slice(0, 3)"
              :key="item.id"
              class="sf-mono flex items-center justify-between gap-2 px-3 py-2 text-[11.5px]"
            >
              <span class="truncate text-[color:var(--sf-ink-2)]">
                {{ item.label }} · {{ formatDaysShort(item.d) }}
              </span>
              <span class="flex items-center gap-3 shrink-0">
                <span class="text-[color:var(--sf-muted)]">{{
                  formatMarketAmount(item.cost, market)
                }}</span>
                <span class="font-semibold text-[color:var(--sf-bid)]">{{
                  formatApr(item.yieldBps)
                }}</span>
              </span>
            </div>
            <div
              v-if="lendPlan.take.length > 3"
              class="sf-mono px-3 py-1.5 text-[10.5px] text-[color:var(--sf-dim)]"
            >
              +{{ lendPlan.take.length - 3 }} more matched in app
            </div>
          </div>
        </div>

        <!-- Tabular Rates Strip (when no amount or no fills — no redundant graph!) -->
        <div
          v-else
          class="mt-3.5 overflow-hidden rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card)]"
        >
          <div
            class="sf-mono grid grid-cols-3 border-b border-[color:var(--sf-line)] px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]"
          >
            <span>Tenor</span>
            <span class="text-right">Lenders earn</span>
            <span class="text-right">Borrowers pay</span>
          </div>
          <div class="divide-y divide-[color:var(--sf-line)]">
            <button
              v-for="row in maturityRates"
              :key="row.days"
              type="button"
              class="sf-mono grid w-full grid-cols-3 items-center px-3 py-1.5 text-left text-[11.5px] transition-colors"
              :class="
                row.days === tenor
                  ? 'bg-cobalt-50/70 font-semibold text-[color:var(--sf-ink)]'
                  : 'text-[color:var(--sf-ink-2)] hover:bg-[color:var(--sf-well)]'
              "
              @click="tenor = row.days"
            >
              <span class="flex items-center gap-1.5">
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  :class="row.days === tenor ? 'bg-cobalt-600' : 'bg-transparent'"
                />
                <span>{{ row.days === 365 ? "1y" : `${row.days}d` }}</span>
              </span>
              <span class="text-right font-semibold text-[color:var(--sf-ask)]">
                {{ formatApr(row.ask) }}
              </span>
              <span class="text-right font-semibold text-[color:var(--sf-bid)]">
                {{ formatApr(row.bid) }}
              </span>
            </button>
          </div>
        </div>
      </template>

      <!-- BORROW QUOTE -->
      <template v-else>
        <div class="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div
              class="sf-mono text-[10px] font-medium uppercase tracking-[0.11em] text-[color:var(--sf-muted)]"
            >
              You repay at maturity
            </div>
            <div class="mt-1 flex items-baseline gap-2">
              <span
                class="sf-serif text-[32px] font-semibold leading-none tracking-tight text-[color:var(--sf-ink)]"
              >
                {{
                  borrowRepayment != null
                    ? formatNumber(borrowRepayment, market === "ERG" ? 3 : 2, market === "SigUSD" ? 2 : 0)
                    : "—"
                }}
              </span>
              <span class="sf-mono text-[12px] font-semibold text-[color:var(--sf-muted)]">
                {{ market }}
              </span>
            </div>
          </div>

          <div class="text-right">
            <div
              class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]"
            >
              Due · {{ formatBlocksShort(D) }}
            </div>
            <div class="sf-mono mt-1 text-[13px] font-medium text-[color:var(--sf-ink-2)]">
              {{ h > 0 ? dateAtHeight(maturity, h) : `~${tenor}d` }}
            </div>
          </div>
        </div>

        <p class="mt-1.5 text-[12px] text-[color:var(--sf-ink-2)]">
          <template v-if="borrowRepayment && amount && borrowInterest != null">
            {{ formatMarketAmount(amount, market) }} principal +
            <span class="sf-mono font-semibold text-[color:var(--sf-ask)]">
              {{ formatMarketAmount(borrowInterest, market) }}
            </span>
            interest
          </template>
          <template v-else-if="targetBorrowBps == null">
            No live bids at this maturity yet — set your own target APR below.
          </template>
          <template v-else>
            Enter a borrow amount to compute exact repayment and collateral.
          </template>
        </p>

        <!-- APR Fine-Tuning Slider -->
        <div
          class="mt-3.5 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] p-3"
        >
          <div class="flex items-center justify-between gap-2">
            <span
              class="sf-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-[color:var(--sf-muted)]"
            >
              Offered APR
            </span>
            <div class="flex items-center gap-2">
              <button
                v-if="aprInput != null && autoBorrowBps != null"
                type="button"
                class="sf-mono text-[10.5px] font-medium text-cobalt-600 hover:underline"
                @click="aprInput = null"
              >
                Best bid
              </button>
              <div
                class="flex items-center rounded-md border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-paper)] px-2 py-0.5"
              >
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="200"
                  aria-label="Offered APR percent"
                  :value="targetBorrowBps != null ? (targetBorrowBps / 100).toFixed(2) : ''"
                  placeholder="0.00"
                  class="sf-mono w-14 bg-transparent text-right text-[12.5px] font-semibold text-[color:var(--sf-ink)] outline-none"
                  @input="handleAprNumberInput"
                />
                <span class="sf-mono ml-1 text-[11px] text-[color:var(--sf-muted)]">%</span>
              </div>
            </div>
          </div>

          <input
            type="range"
            min="0"
            max="30"
            step="0.05"
            aria-label="Adjust offered APR"
            :value="Math.min(30, (targetBorrowBps ?? 0) / 100)"
            class="sf-range mt-2.5"
            @input="aprInput = Number(($event.target as HTMLInputElement).value)"
          />

          <div class="sf-mono mt-1.5 flex items-center justify-between text-[11px]">
            <span
              :class="
                borrowEffBps == null
                  ? 'text-[color:var(--sf-dim)]'
                  : borrowFillsNow
                    ? 'text-[color:var(--sf-bid)]'
                    : 'text-[color:var(--sf-ask)]'
              "
            >
              <template v-if="borrowEffBps == null">Set an APR to preview</template>
              <template v-else-if="borrowFillsNow">
                ≥ best bid {{ formatApr(borrowBidBps) }} · fills next batch
              </template>
              <template v-else-if="borrowBidBps == null">
                No bid at {{ tenor === 365 ? "1y" : `${tenor}d` }} · rests on book
              </template>
              <template v-else>
                Under best bid {{ formatApr(borrowBidBps) }} · rests on book
              </template>
            </span>
            <span v-if="aprShifted" class="text-[color:var(--sf-dim)]">
              eff. {{ formatApr(borrowEffBps) }}
            </span>
          </div>
        </div>

        <!-- Collateral & Liquidation Metrics -->
        <dl
          class="mt-3 grid grid-cols-3 divide-x divide-[color:var(--sf-line)] rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card)]"
        >
          <div class="px-3 py-2">
            <dt class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              Collateral
            </dt>
            <dd class="sf-mono mt-0.5 text-[12px] font-semibold text-[color:var(--sf-ink)]">
              {{ collAmount != null ? formatMarketAmount(collAmount, collAsset) : `${cover + 10}%` }}
            </dd>
          </div>
          <div class="px-3 py-2">
            <dt class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              Liquidates
            </dt>
            <dd class="sf-mono mt-0.5 text-[12px] font-semibold text-[color:var(--sf-ask)]">
              <template v-if="borrowLiq?.price != null">
                {{ borrowLiq.dir === "below" ? "<" : ">" }} ${{ borrowLiq.price.toFixed(3) }}
              </template>
              <template v-else>&lt; {{ cover }}%</template>
            </dd>
          </div>
          <div class="px-3 py-2">
            <dt class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              Par <span class="sf-math normal-case">P/F</span>
            </dt>
            <dd class="sf-mono mt-0.5 text-[12px] font-semibold text-cobalt-600">
              {{ borrowParPct != null ? `${borrowParPct.toFixed(2)}%` : "—" }}
            </dd>
          </div>
        </dl>
      </template>
    </div>

    <!-- Action Footer (Opens App — Never Signs on Landing) -->
    <div
      class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-4 py-3.5 sm:px-5"
    >
      <router-link
        :to="appLinkTo"
        class="sf-btn-primary flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[13.5px]"
      >
        <span>{{ ctaLabel }}</span>
        <arrow-right-icon class="h-4 w-4" />
      </router-link>

      <div
        class="mt-2.5 flex items-start gap-2 text-[11.5px] leading-snug text-[color:var(--sf-muted)]"
      >
        <shield-icon class="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-75" />
        <span v-if="side === 'lend'">
          Oracle-guarded bonds at ≥{{ cover }}% cover. Opens the Rate Book with these terms pre-filled.
        </span>
        <span v-else>
          Locks {{ collAsset }} at {{ cover + 10 }}% starting cover
          <template v-if="liqDistancePct != null">
            ({{ liqDistancePct.toFixed(1) }}% buffer from ${{ oraclePrice.toFixed(3) }})</template
          >. Opens the Rate Book to review before signing.
        </span>
      </div>
    </div>
  </div>
</template>
