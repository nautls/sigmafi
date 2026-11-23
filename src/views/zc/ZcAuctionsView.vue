<script setup lang="ts">
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  LayersIcon,
  PlusIcon,
  ShieldIcon,
  ZapIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, ref } from "vue";
import AuctionScheduleChart, { SchedulePt } from "./components/AuctionScheduleChart.vue";
import ExecutionPreviewModal, { ExecutionPreviewPayload } from "./components/ExecutionPreviewModal.vue";
import ZcAssetChip from "./components/ZcAssetChip.vue";
import ZcSelect, { ZcSelectOption } from "./components/ZcSelect.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { useChainStore, useZcStore } from "@/stories";
import { ZcAuctionLotSummary, ZcAuctionVaultSummary, ZcMarket } from "@/types/zc";
import { shortenString } from "@/utils";
import {
  dateAtHeight,
  formatDur,
  formatMarketAmount,
  formatNumber,
  lotPriceAt,
  SIGUSD_TOKEN_ID,
  vaultAuctionAt
} from "@/utils/zcMath";

const zc = useZcStore();
const chain = useChainStore();

const marketFilter = ref<"all" | ZcMarket>("all");
const typeFilter = ref<"all" | "lots" | "vaults">("all");
const hideExpired = ref(true);
const sortBy = ref<"ending" | "price" | "discount">("ending");
const previewPayload = ref<ExecutionPreviewPayload | null>(null);

const SORT_OPTIONS: readonly ZcSelectOption[] = [
  { value: "ending", label: "Ending soon" },
  { value: "discount", label: "Best discount" },
  { value: "price", label: "Lowest price" }
];

const height = computed(() => (zc.height > 100_000 ? zc.height : 1_650_000));
const oraclePrice = computed(() => (zc.oracle.price > 0.05 ? zc.oracle.price : 1.42));
const unit = computed(() => zc.durationUnit);

function onCardPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

function estimateItemsUsd(items: ZcAuctionLotSummary["items"], extraErg = 0): number | null {
  let sum = 0;
  let knownAny = false;
  if (extraErg > 0 && oraclePrice.value > 0) {
    sum += extraErg * oraclePrice.value;
    knownAny = true;
  }
  for (const it of items) {
    const id = it.id.toLowerCase();
    if (id === "erg") {
      sum += it.amount * oraclePrice.value;
      knownAny = true;
    } else if (id === SIGUSD_TOKEN_ID) {
      sum += it.amount;
      knownAny = true;
    } else {
      const rate = chain.priceRates[id]?.fiat;
      if (rate && rate > 0) {
        sum += it.amount * rate;
        knownAny = true;
      }
    }
  }
  return knownAny && sum > 0 ? sum : null;
}

function lotPriceNow(l: ZcAuctionLotSummary): number | null {
  if (l.phase === "expired") return null;
  return l.priceNow ?? lotPriceAt(l, height.value);
}

function lotDiscountPct(l: ZcAuctionLotSummary): number | null {
  const price = lotPriceNow(l);
  if (price == null || !(price > 0)) return null;
  const estUsd = estimateItemsUsd(l.items, l.erg);
  if (estUsd == null) return null;
  const priceUsd = l.market === "ERG" ? price * oraclePrice.value : price;
  if (!(priceUsd > 0)) return null;
  return ((estUsd - priceUsd) / estUsd) * 100;
}

function lotPts(l: ZcAuctionLotSummary): SchedulePt[] {
  const h = height.value;
  return [
    { x: Math.min(h, l.start) - 60, y: l.opening },
    { x: l.start, y: l.opening },
    { x: l.end, y: l.floor },
    { x: l.expiry, y: l.floor }
  ];
}

function lotPhaseMeta(l: ZcAuctionLotSummary): {
  label: string;
  tone: "bid" | "ask" | "warn" | "cobalt" | "neutral";
} {
  if (l.pending) return { label: "Pending", tone: "cobalt" };
  if (l.phase === "expired") return { label: "Expired", tone: "neutral" };
  if (l.phase === "before") {
    return {
      label: `Starts in ${formatDur(Math.max(1, l.start - height.value), unit.value)}`,
      tone: "cobalt"
    };
  }
  if (l.phase === "falling") {
    return {
      label: `Floor in ${formatDur(Math.max(1, l.end - height.value), unit.value)}`,
      tone: "ask"
    };
  }
  return {
    label: `Floor · ends ${formatDur(Math.max(1, l.expiry - height.value), unit.value)}`,
    tone: "bid"
  };
}

function vaultEval(v: ZcAuctionVaultSummary) {
  const fb = vaultAuctionAt(v, height.value);
  const pay = v.quote?.pay ?? fb.pay;
  const bps = v.quote?.bps ?? fb.bps;
  const done = v.quote?.done ?? fb.done;
  const excess = v.state === 4;
  const pts: SchedulePt[] = excess
    ? [
        { x: v.start, y: v.openBps },
        { x: v.start + v.length, y: 0 }
      ]
    : [
        { x: v.start, y: v.openBps },
        { x: v.start + v.length, y: v.floorBps },
        { x: v.start + v.expiry, y: v.floorBps }
      ];
  return { pay, bps, done, excess, pts };
}

const filteredLots = computed(() => {
  const list = zc.lots.filter((l) => {
    if (marketFilter.value !== "all" && l.market !== marketFilter.value) return false;
    if (hideExpired.value && l.phase === "expired") return false;
    return true;
  });

  return [...list].sort((a, b) => {
    if (sortBy.value === "price") {
      const pa = lotPriceNow(a) ?? Infinity;
      const pb = lotPriceNow(b) ?? Infinity;
      return pa - pb;
    }
    if (sortBy.value === "discount") {
      const da = lotDiscountPct(a) ?? -999;
      const db = lotDiscountPct(b) ?? -999;
      return db - da;
    }
    return a.expiry - b.expiry;
  });
});

const filteredVaults = computed(() => {
  const list = zc.vaults.filter((v) => {
    if (marketFilter.value !== "all" && v.market !== marketFilter.value) return false;
    if (hideExpired.value && vaultEval(v).done) return false;
    return true;
  });

  return [...list].sort((a, b) => {
    if (sortBy.value === "price") {
      return (vaultEval(a).pay ?? Infinity) - (vaultEval(b).pay ?? Infinity);
    }
    return a.start + a.expiry - (b.start + b.expiry);
  });
});

const fallingCount = computed(
  () =>
    zc.lots.filter((l) => l.phase === "falling").length +
    zc.vaults.filter((v) => !vaultEval(v).done).length
);

const walletBal = (m: ZcMarket) =>
  m === "ERG" ? zc.portfolio.walletErg : zc.portfolio.walletSigUsd;

function openBuyLot(l: ZcAuctionLotSummary) {
  const price = lotPriceNow(l);
  if (price == null) return;
  const estUsd = estimateItemsUsd(l.items, l.erg);
  const disc = lotDiscountPct(l);
  const itemsDesc = [
    ...(l.erg > 0 ? [`${formatNumber(l.erg, 3, 0)} ERG`] : []),
    ...l.items.map((it) => `${formatNumber(it.amount, Math.min(4, it.decimals), 0)} ${it.ticker}`)
  ].join(" + ");

  previewPayload.value = {
    title: "Buy Sale Auction Lot",
    subtitle: `${l.itemCount} item${l.itemCount === 1 ? "" : "s"} · ${l.market} Dutch auction`,
    badge: `Sale Lot · ${l.market}`,
    tone: l.borrowedByMe ? "bid" : "ask",
    heroLabel: "Price now",
    heroValue: formatMarketAmount(price, l.market),
    heroSub:
      height.value < l.end
        ? `Falls to ${formatMarketAmount(l.floor, l.market)} by ${dateAtHeight(l.end, height.value)}`
        : `Held at floor until ${dateAtHeight(l.expiry, height.value)}`,
    rows: [
      { label: "Lot ID", value: shortenString(l.id, 14) },
      { label: "Basket", value: itemsDesc || "—" },
      ...(estUsd != null
        ? [
            {
              label: "Est. market value",
              value: `$${formatNumber(estUsd, 2, 0)}${disc != null && disc > 0 ? ` (-${disc.toFixed(1)}%)` : ""}`,
              tone: (disc != null && disc > 0 ? "bid" : "default") as "bid" | "default"
            }
          ]
        : []),
      ...(l.borrowedByMe
        ? [
            {
              label: "Borrower benefit",
              value: "Contains your loan — can extinguish after buying",
              tone: "bid" as const
            }
          ]
        : []),
      {
        label: "Wallet balance",
        value: formatMarketAmount(walletBal(l.market), l.market)
      }
    ],
    rawSummary: { action: "buyLot", lotId: l.id, boxId: l.boxId, market: l.market, priceNow: price }
  };
}

function openCancelLot(l: ZcAuctionLotSummary) {
  previewPayload.value = {
    title: "Cancel Sale Auction",
    subtitle: "Returns the entire locked basket back to your Nautilus wallet",
    badge: `Cancel Lot · ${l.market}`,
    tone: "ask",
    heroLabel: "Returning",
    heroValue: `${l.itemCount} asset${l.itemCount === 1 ? "" : "s"}`,
    heroSub: `Lot ${shortenString(l.id, 14)}`,
    rows: [
      { label: "Opening / Floor", value: `${formatMarketAmount(l.opening, l.market)} → ${formatMarketAmount(l.floor, l.market)}` },
      { label: "Refund fee", value: `${formatNumber(l.refundFee, 4, 0)} ERG` }
    ],
    rawSummary: { action: "cancelLot", lotId: l.id, boxId: l.boxId }
  };
}

function openBuyVault(v: ZcAuctionVaultSummary) {
  const ev = vaultEval(v);
  if (ev.pay == null || ev.done) return;
  const itemsDesc = v.items
    .map((it) => `${formatNumber(it.amount, Math.min(4, it.decimals), 0)} ${it.ticker}`)
    .join(" + ");

  previewPayload.value = {
    title: ev.excess ? "Buy Surplus Collateral" : "Buy Liquidated Collateral",
    subtitle: `${v.vaultType === "selective" ? "Selective" : "Dutch"} share vault · ${v.market}`,
    badge: ev.excess ? `Excess · ${v.market}` : `Liquidation · ${v.market}`,
    tone: ev.excess ? "cobalt" : "ask",
    heroLabel: ev.excess ? "Price now" : "Top-up due now",
    heroValue: formatMarketAmount(ev.pay, v.market),
    heroSub: ev.excess
      ? "Falls linearly to zero before distributing in kind"
      : `Brings vault to ${formatNumber((ev.bps ?? 0) / 100, 1, 1)}% of ${formatMarketAmount(v.repayment, v.market)}`,
    rows: [
      { label: "Bond", value: shortenString(v.bondId, 14) },
      { label: "Vault box", value: shortenString(v.boxId, 14) },
      { label: "Collateral", value: itemsDesc || "—" },
      { label: "Vault holds", value: formatMarketAmount(v.currencyHeld, v.market) }
    ],
    rawSummary: {
      action: "buyVault",
      vaultId: v.id,
      bondId: v.bondId,
      market: v.market,
      payNow: ev.pay
    }
  };
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Top Auctions Command & Telemetry Bar -->
    <header
      class="sf-terminal-plate flex flex-wrap items-center justify-between gap-3 rounded-[18px] rounded-tl-[6px] px-4 py-3"
    >
      <div class="flex flex-wrap items-center gap-4">
        <div>
          <div class="flex items-center gap-2">
            <h1 class="sf-display text-[20px] font-bold leading-none text-[color:var(--sf-ink)]">
              Dutch Auctions
            </h1>
            <span
              v-if="zc.demoMode"
              class="sf-mono rounded-[5px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-[color:var(--sf-cobalt)]"
            >
              Demo
            </span>
          </div>
          <p class="mt-1 text-[12px] text-[color:var(--sf-muted)]">
            Falling-price basket lots &amp; post-liquidation share vaults. Hover any curve to scrub future prices.
          </p>
        </div>

        <span class="hidden h-7 w-px bg-[color:var(--sf-line)] md:block" aria-hidden="true" />

        <dl class="sf-mono hidden items-center gap-4 text-[11.5px] sm:flex">
          <div>
            <dt class="text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-dim)]">Sale Lots</dt>
            <dd class="font-bold text-[color:var(--sf-ink)]">{{ zc.lots.length }}</dd>
          </div>
          <div>
            <dt class="text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-dim)]">Liquidations</dt>
            <dd class="font-bold text-[color:var(--sf-ask)]">{{ zc.vaults.length }}</dd>
          </div>
          <div>
            <dt class="text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-dim)]">Active</dt>
            <dd class="font-bold text-[color:var(--sf-bid)]">{{ fallingCount }}</dd>
          </div>
        </dl>
      </div>

      <!-- Filters & Actions -->
      <div class="flex flex-wrap items-center gap-2">
        <div class="sf-seg" role="tablist" aria-label="Filter by market">
          <button
            v-for="opt in (['all', 'ERG', 'SigUSD'] as const)"
            :key="opt"
            type="button"
            class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
            :class="marketFilter === opt ? 'is-active tone-cobalt' : ''"
            @click="marketFilter = opt"
          >
            {{ opt === "all" ? "All" : opt }}
          </button>
        </div>

        <div class="sf-seg" role="tablist" aria-label="Filter by auction type">
          <button
            type="button"
            class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
            :class="typeFilter === 'all' ? 'is-active tone-cobalt' : ''"
            @click="typeFilter = 'all'"
          >
            All
          </button>
          <button
            type="button"
            class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
            :class="typeFilter === 'lots' ? 'is-active tone-ask' : ''"
            @click="typeFilter = 'lots'"
          >
            Lots
          </button>
          <button
            type="button"
            class="sf-seg-btn !h-7 !px-2.5 !text-[11px]"
            :class="typeFilter === 'vaults' ? 'is-active tone-ask' : ''"
            @click="typeFilter = 'vaults'"
          >
            Vaults
          </button>
        </div>

        <zc-select
          :model-value="sortBy"
          :options="SORT_OPTIONS"
          size="sm"
          aria-label="Sort auctions"
          @update:model-value="sortBy = $event as 'ending' | 'price' | 'discount'"
        />

        <button
          type="button"
          class="sf-mono h-7 rounded-lg border px-2 text-[10.5px] font-semibold transition-colors"
          :class="
            hideExpired
              ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)]'
          "
          @click="hideExpired = !hideExpired"
        >
          Live only
        </button>

        <router-link
          :to="{ name: 'zc-studio', query: { type: 'auction' } }"
          class="sf-btn-ask inline-flex h-8 items-center gap-1.5 rounded-xl px-3.5 text-[12px]"
        >
          <plus-icon class="h-3.5 w-3.5" />
          <span>New Auction</span>
        </router-link>
      </div>
    </header>

    <!-- Demo Data Prompt when live chain currently has zero auctions -->
    <div
      v-if="!zc.demoMode && zc.lots.length === 0 && zc.vaults.length === 0"
      class="sf-terminal-plate flex flex-col items-center justify-center rounded-[22px] p-10 text-center"
    >
      <div class="grid h-12 w-12 place-items-center rounded-2xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]">
        <zap-icon class="h-6 w-6" />
      </div>
      <h2 class="sf-display mt-3.5 text-[19px] font-bold text-[color:var(--sf-ink)]">
        No live Dutch auctions on chain right now
      </h2>
      <p class="mt-1.5 max-w-md text-[13px] text-[color:var(--sf-muted)]">
        Create a falling-price basket auction in Studio to sell tokens, bonds, or wrap receipts on a linear schedule.
      </p>
      <div class="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <!-- Demo button (uncomment to preview mock auctions)
        <button
          type="button"
          class="sf-btn-cobalt inline-flex h-10 items-center gap-1.5 rounded-full px-5 text-[13px]"
          @click="zc.setDemoMode(true)"
        >
          <zap-icon class="h-3.5 w-3.5" />
          <span>Preview with Demo Data</span>
        </button>
        -->
        <router-link
          :to="{ name: 'zc-studio', query: { type: 'auction' } }"
          class="sf-btn-cobalt inline-flex h-10 items-center gap-1.5 rounded-full px-5 text-[13px]"
        >
          <plus-icon class="h-3.5 w-3.5" />
          <span>Start a Sale Auction</span>
        </router-link>
      </div>
    </div>

    <!-- SALE AUCTIONS SECTION -->
    <section v-if="typeFilter !== 'vaults' && (zc.lots.length > 0 || zc.demoMode)" class="space-y-3">
      <div class="flex items-center justify-between gap-2 px-1">
        <div class="flex items-center gap-2">
          <span class="grid h-6 w-6 place-items-center rounded-lg bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]">
            <layers-icon class="h-3.5 w-3.5" />
          </span>
          <h2 class="sf-display text-[16px] font-bold text-[color:var(--sf-ink)]">
            Sale Auctions
          </h2>
          <span class="sf-mono rounded-[5px] bg-[color:var(--sf-well)] px-1.5 py-0.5 text-[10.5px] font-bold text-[color:var(--sf-ink-2)]">
            {{ filteredLots.length }}
          </span>
        </div>
        <span class="sf-mono text-[11px] text-[color:var(--sf-muted)]">
          Whole basket · linear descent to floor
        </span>
      </div>

      <div
        v-if="filteredLots.length === 0"
        class="sf-terminal-plate rounded-2xl p-6 text-center text-[12.5px] text-[color:var(--sf-muted)]"
      >
        No sale auctions match the current filters.
      </div>

      <div v-else class="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="l in filteredLots"
          :key="l.id"
          class="sf-bento sf-terminal-plate flex flex-col overflow-hidden rounded-[20px] rounded-tl-[6px]"
          @mousemove="onCardPointerMove"
        >
          <!-- Edge-to-Edge Interactive Schedule Stage -->
          <auction-schedule-chart
            :pts="lotPts(l)"
            :now="height"
            label="Price now"
            :value-display="lotPriceNow(l) == null ? '—' : formatNumber(lotPriceNow(l), l.market === 'ERG' ? 3 : 2, 0)"
            :unit-text="l.market"
            :phase-label="lotPhaseMeta(l).label"
            :phase-tone="lotPhaseMeta(l).tone"
            :note="`floor ${formatMarketAmount(l.floor, l.market)}`"
            :discount-pct="lotDiscountPct(l)"
            :color="l.borrowedByMe && !l.owner ? 'var(--sf-bid)' : 'var(--sf-ask)'"
            :market="l.market"
            :duration-unit="unit"
          />

          <!-- Card Body -->
          <div class="flex flex-1 flex-col gap-3 p-4">
            <div class="flex items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2">
                <market-coin :market="l.market" :size="20" />
                <div class="min-w-0">
                  <div class="text-[13.5px] font-bold leading-tight text-[color:var(--sf-ink)]">
                    {{ l.itemCount }} item{{ l.itemCount === 1 ? "" : "s" }}
                  </div>
                  <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
                    {{ shortenString(l.id, 14) }}
                  </div>
                </div>
              </div>

              <div class="flex flex-wrap items-center justify-end gap-1">
                <span
                  v-if="l.borrowedByMe && !l.owner"
                  class="sf-mono rounded-[5px] border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[color:var(--sf-bid)]"
                >
                  Your loan
                </span>
                <span
                  v-if="l.owner"
                  class="sf-mono rounded-[5px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[color:var(--sf-cobalt)]"
                >
                  Yours
                </span>
              </div>
            </div>

            <!-- Basket Token Chips with Icons, Bond Links & Wrap Tooltips -->
            <div class="flex flex-wrap gap-1.5">
              <div
                v-if="l.erg > 0"
                class="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-1 text-[11.5px]"
              >
                <market-coin market="ERG" :size="15" />
                <span class="font-semibold text-[color:var(--sf-ink)]">ERG</span>
                <span class="sf-mono font-bold text-[color:var(--sf-ink-2)]">
                  {{ formatNumber(l.erg, 3, 0) }}
                </span>
              </div>

              <zc-asset-chip
                v-for="(it, idx) in l.items"
                :key="it.id + idx"
                :token="it"
                :height="height"
                variant="chip"
              />
            </div>
          </div>

          <!-- Action Footer -->
          <div class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-4 py-3">
            <button
              v-if="l.owner"
              type="button"
              class="sf-btn-outline flex h-9 w-full items-center justify-center gap-1.5 rounded-xl text-[12.5px] font-semibold"
              @click="openCancelLot(l)"
            >
              <span>Cancel &amp; Refund Lot</span>
            </button>
            <button
              v-else
              type="button"
              class="flex h-9 w-full items-center justify-center gap-1.5 rounded-xl text-[12.5px] disabled:cursor-not-allowed disabled:opacity-45"
              :class="l.borrowedByMe ? 'sf-btn-bid' : 'sf-btn-ask'"
              :disabled="lotPriceNow(l) == null || !l.valid"
              @click="openBuyLot(l)"
            >
              <span>
                {{
                  lotPriceNow(l) == null
                    ? "Expired"
                    : `Buy for ${formatMarketAmount(lotPriceNow(l), l.market)}`
                }}
              </span>
              <arrow-right-icon v-if="lotPriceNow(l) != null" class="h-3.5 w-3.5" />
            </button>
          </div>
        </article>
      </div>
    </section>

    <!-- LIQUIDATION VAULT AUCTIONS SECTION -->
    <section v-if="typeFilter !== 'lots' && (zc.vaults.length > 0 || zc.demoMode)" class="space-y-3">
      <div class="flex items-center justify-between gap-2 px-1">
        <div class="flex items-center gap-2">
          <span class="grid h-6 w-6 place-items-center rounded-lg bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]">
            <shield-icon class="h-3.5 w-3.5" />
          </span>
          <h2 class="sf-display text-[16px] font-bold text-[color:var(--sf-ink)]">
            Liquidation Auctions
          </h2>
          <span class="sf-mono rounded-[5px] bg-[color:var(--sf-well)] px-1.5 py-0.5 text-[10.5px] font-bold text-[color:var(--sf-ink-2)]">
            {{ filteredVaults.length }}
          </span>
        </div>
        <span class="sf-mono text-[11px] text-[color:var(--sf-muted)]">
          Selective &amp; Dutch collateral recovery vaults
        </span>
      </div>

      <div
        v-if="filteredVaults.length === 0"
        class="sf-terminal-plate rounded-2xl p-6 text-center text-[12.5px] text-[color:var(--sf-muted)]"
      >
        No liquidation vault auctions match the current filters.
      </div>

      <div v-else class="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="v in filteredVaults"
          :key="v.id"
          class="sf-bento sf-terminal-plate flex flex-col overflow-hidden rounded-[20px] rounded-tr-[6px]"
          @mousemove="onCardPointerMove"
        >
          <auction-schedule-chart
            :pts="vaultEval(v).pts"
            :now="height"
            :label="vaultEval(v).excess ? 'Surplus price now' : 'Top-up now'"
            :value-display="vaultEval(v).pay == null ? '—' : formatNumber(vaultEval(v).pay, v.market === 'ERG' ? 3 : 2, 0)"
            :unit-text="v.market"
            :phase-label="v.pending ? 'Pending' : vaultEval(v).excess ? 'Excess' : 'Floor auction'"
            :phase-tone="vaultEval(v).excess ? 'cobalt' : 'warn'"
            :note="
              vaultEval(v).excess
                ? `to 0 in ${formatDur(Math.max(1, v.start + v.length - height), unit)}`
                : `${formatNumber((vaultEval(v).bps ?? 0) / 100, 1, 1)}% of ${formatMarketAmount(v.repayment, v.market)}`
            "
            :color="vaultEval(v).excess ? 'var(--sf-cobalt)' : 'var(--sf-warn)'"
            :market="v.market"
            :duration-unit="unit"
            y-is-bps
            :repayment="v.repayment"
          />

          <div class="flex flex-1 flex-col gap-3 p-4">
            <div class="flex items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2">
                <market-coin :market="v.market" :size="20" />
                <div class="min-w-0">
                  <div class="text-[13.5px] font-bold leading-tight text-[color:var(--sf-ink)]">
                    {{ vaultEval(v).excess ? "Surplus Collateral" : "Liquidated Collateral" }}
                  </div>
                  <div class="mt-0.5 flex items-center gap-1.5">
                    <router-link
                      :to="{ name: 'zc-bond', params: { id: v.bondId } }"
                      class="sf-mono inline-flex items-center gap-0.5 text-[10.5px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                    >
                      <span>Bond {{ shortenString(v.bondId, 10) }}</span>
                      <arrow-up-right-icon class="h-3 w-3" />
                    </router-link>
                  </div>
                </div>
              </div>

              <span class="sf-mono rounded-[5px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-0.5 text-[9.5px] font-semibold uppercase text-[color:var(--sf-ink-2)]">
                {{ v.vaultType }}
              </span>
            </div>

            <!-- Collateral Basket Chips with Icons, Bond Links & Wrap Tooltips -->
            <div class="flex flex-wrap gap-1.5">
              <zc-asset-chip
                v-for="(it, idx) in v.items"
                :key="it.id + idx"
                :token="it"
                :height="height"
                variant="chip"
              />
            </div>
          </div>

          <div class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-4 py-3">
            <button
              type="button"
              class="flex h-9 w-full items-center justify-center gap-1.5 rounded-xl text-[12.5px] disabled:cursor-not-allowed disabled:opacity-45"
              :class="vaultEval(v).excess ? 'sf-btn-cobalt' : 'sf-btn-ask'"
              :disabled="vaultEval(v).done || vaultEval(v).pay == null"
              @click="openBuyVault(v)"
            >
              <span>
                {{
                  vaultEval(v).done
                    ? "Paid out in kind"
                    : `Buy for ${formatMarketAmount(vaultEval(v).pay, v.market)}`
                }}
              </span>
              <arrow-right-icon v-if="!vaultEval(v).done && vaultEval(v).pay != null" class="h-3.5 w-3.5" />
            </button>
          </div>
        </article>
      </div>
    </section>

    <transition name="sf-modal">
      <execution-preview-modal
        v-if="previewPayload"
        :payload="previewPayload"
        @close="previewPayload = null"
      />
    </transition>
  </div>
</template>
