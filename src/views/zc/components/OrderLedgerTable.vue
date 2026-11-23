<script setup lang="ts">
import { computed } from "vue";
import CoverMeter from "./CoverMeter.vue";
import MiniCurveSpark from "./MiniCurveSpark.vue";
import ZcOrderMark from "./ZcOrderMark.vue";
import {
  ZcAskSummary,
  ZcDurationUnit,
  ZcFillSummary,
  ZcMarket,
  ZcOfferSummary,
  ZcSortKey
} from "@/types/zc";
import { shortenString } from "@/utils";
import {
  askPath,
  dateAtHeight,
  formatAgo,
  formatApr,
  formatCompact,
  formatDur,
  formatDurCell,
  formatMarketAmount,
  formatNumber,
  isOracleRefreshingOnly,
  kindLabel,
  pricingName,
  resolvedAskQuote
} from "@/utils/zcMath";

const props = defineProps<{
  tab: "asks" | "bids" | "fills";
  sort: ZcSortKey;
  market: ZcMarket;
  unit: ZcDurationUnit;
  height: number;
  follow: boolean;
  asks: ZcAskSummary[];
  asksTotal: number;
  asksNext: string | null;
  asksPendingHidden: number;
  asksLoading: boolean;
  offers: ZcOfferSummary[];
  offersTotal: number;
  offersNext: string | null;
  offersPendingHidden: number;
  offersLoading: boolean;
  fills: ZcFillSummary[];
  fillsStatus: string;
  selectedId: string | null;
  searchQuery: string;
}>();

const emit = defineEmits<{
  (e: "update:tab", v: "asks" | "bids" | "fills"): void;
  (e: "update:sort", v: ZcSortKey): void;
  (e: "select-ask", id: string): void;
  (e: "select-bid", id: string): void;
  (e: "quick-fund", ask: ZcAskSummary): void;
  (e: "load-more-asks"): void;
  (e: "load-more-offers"): void;
}>();

const qLower = computed(() => props.searchQuery.trim().toLowerCase());

const filteredAsks = computed(() => {
  if (!qLower.value) return props.asks;
  return props.asks.filter(
    (a) =>
      a.id.toLowerCase().includes(qLower.value) ||
      a.chainId.toLowerCase().includes(qLower.value) ||
      kindLabel(a.kind).toLowerCase().includes(qLower.value) ||
      pricingName(a).toLowerCase().includes(qLower.value)
  );
});

const filteredOffers = computed(() => {
  if (!qLower.value) return props.offers;
  return props.offers.filter(
    (o) =>
      o.id.toLowerCase().includes(qLower.value) ||
      o.chainId.toLowerCase().includes(qLower.value) ||
      o.delivery.toLowerCase().includes(qLower.value)
  );
});

const filteredFills = computed(() => {
  if (!qLower.value) return props.fills;
  return props.fills.filter(
    (f) =>
      f.id.toLowerCase().includes(qLower.value) ||
      f.txId.toLowerCase().includes(qLower.value) ||
      (f.bondId || "").toLowerCase().includes(qLower.value)
  );
});

function askQuoteFor(a: ZcAskSummary) {
  return resolvedAskQuote(a, props.height);
}

function askSparkPts(a: ZcAskSummary) {
  return askPath(a, props.height, 14);
}

function isUsable(x: { ok: boolean; status?: string; reasons?: string[] }) {
  return x.ok || isOracleRefreshingOnly(x);
}

function isBuyback(a: ZcAskSummary) {
  return !!a.borrowedByMe && a.kind !== "order" && !a.owner;
}
</script>

<template>
  <section
    class="sf-terminal-plate ledger-shell flex h-full min-h-[220px] flex-col overflow-hidden rounded-[20px] rounded-bl-[6px] xl:min-h-0"
    :data-side="tab"
  >
    <!-- Header Bar -->
    <div class="sf-panel-head flex shrink-0 flex-wrap items-center justify-between gap-2 px-3.5 py-2">
      <div class="flex flex-wrap items-center gap-2">
        <div class="sf-seg" role="tablist" aria-label="Order Ledger side">
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'asks'"
            class="sf-seg-btn px-2.5 py-1 text-[11.5px]"
            :class="tab === 'asks' ? 'is-active tone-ask' : ''"
            @click="emit('update:tab', 'asks')"
          >
            <span>Asks</span>
            <span class="sf-mono text-[10.5px] opacity-80">{{ asksTotal }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'bids'"
            class="sf-seg-btn px-2.5 py-1 text-[11.5px]"
            :class="tab === 'bids' ? 'is-active tone-bid' : ''"
            @click="emit('update:tab', 'bids')"
          >
            <span>Offers</span>
            <span class="sf-mono text-[10.5px] opacity-80">{{ offersTotal }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'fills'"
            class="sf-seg-btn px-2.5 py-1 text-[11.5px]"
            :class="tab === 'fills' ? 'is-active tone-cobalt' : ''"
            @click="emit('update:tab', 'fills')"
          >
            <span>Fills</span>
            <span class="sf-mono text-[10.5px] opacity-80">{{ fills.length }}</span>
          </button>
        </div>

        <span
          v-if="follow && tab !== 'fills'"
          class="sf-mono rounded-[5px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-cobalt)]"
        >
          Following slice
        </span>

        <span
          v-if="(tab === 'asks' && asksPendingHidden > 0) || (tab === 'bids' && offersPendingHidden > 0)"
          class="sf-mono rounded-[5px] bg-[color:var(--sf-ask-soft)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--sf-ask)]"
        >
          +{{ tab === "asks" ? asksPendingHidden : offersPendingHidden }} pending
        </span>
      </div>

      <!-- Sort Controls -->
      <div v-if="tab !== 'fills'" class="sf-seg" role="group" aria-label="Sort rows">
        <button
          v-for="sKey in (['apr', 'maturity', 'size'] as ZcSortKey[])"
          :key="sKey"
          type="button"
          class="sf-seg-btn sf-mono px-2 py-1 text-[10.5px] capitalize"
          :class="sort === sKey ? 'is-active' : ''"
          @click="emit('update:sort', sKey)"
        >
          {{ sKey === "apr" ? "APR" : sKey }}
        </button>
      </div>
    </div>

    <!-- ASKS TABLE -->
    <div v-if="tab === 'asks'" class="sf-scroll sf-dock-well min-h-0 flex-1 overflow-auto">
      <table v-if="filteredAsks.length" class="w-full min-w-[540px] border-collapse text-left">
        <thead class="ledger-thead sticky top-0 z-10 bg-[color:var(--sf-card)]">
          <tr class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            <th class="px-3.5 py-2">Listing</th>
            <th class="px-2.5 py-2 text-right">APR</th>
            <th class="hidden px-2.5 py-2 sm:table-cell">Path</th>
            <th class="hidden px-2.5 py-2 text-right 2xl:table-cell">Par</th>
            <th class="px-2.5 py-2 text-right">Size</th>
            <th class="px-2.5 py-2 text-right">
              {{ unit === "blocks" ? "Blk" : "Matures" }}
            </th>
            <th class="px-2.5 py-2">Cover</th>
            <th class="px-3.5 py-2 text-right" />
          </tr>
        </thead>

        <tbody class="divide-y divide-[color:var(--sf-line)] text-[12px]">
          <tr
            v-for="ask in filteredAsks"
            :key="ask.id"
            class="ledger-row cursor-pointer"
            :class="[
              selectedId === ask.id ? 'is-selected' : '',
              isUsable(ask) ? '' : 'opacity-55'
            ]"
            @click="emit('select-ask', ask.id)"
          >
            <td class="px-3.5 py-2">
              <div class="flex items-center gap-2.5">
                <zc-order-mark :kind="ask.kind" :size="28" />
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5 leading-tight">
                    <span class="font-medium text-[color:var(--sf-ink)]">
                      {{ kindLabel(ask.kind) }}
                    </span>
                    <span class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
                      {{ shortenString(ask.id, 8) }}
                    </span>
                    <span
                      v-if="isBuyback(ask)"
                      class="sf-mono rounded-[4px] bg-[color:var(--sf-bid-soft)] px-1.5 py-[1px] text-[9px] font-semibold text-[color:var(--sf-bid)]"
                    >
                      Your loan
                    </span>
                  </div>
                  <div class="truncate text-[10.5px] text-[color:var(--sf-muted)]">
                    {{ pricingName(ask) }}{{ ask.pending ? " · pending" : "" }}
                  </div>
                </div>
              </div>
            </td>

            <td class="sf-mono px-2.5 py-2 text-right font-semibold text-[color:var(--sf-ask)]">
              <span>{{ formatApr(askQuoteFor(ask)?.yieldBps) }}</span>
              <span
                v-if="ask.pricing === 'window'"
                class="ml-1 text-[9px] font-normal text-[color:var(--sf-dim)]"
              >
                max
              </span>
            </td>

            <td class="hidden px-2.5 py-2 sm:table-cell">
              <mini-curve-spark
                :points="askSparkPts(ask)"
                color="var(--sf-ask)"
                :width="56"
                :height="19"
                :title="
                  ask.pricing === 'window'
                    ? 'APR by chosen maturity'
                    : 'Projected APR until expiry'
                "
              />
            </td>

            <td class="sf-mono hidden px-2.5 py-2 text-right text-[color:var(--sf-ink-2)] 2xl:table-cell">
              {{ askQuoteFor(ask) ? `${askQuoteFor(ask)!.pct.toFixed(2)}%` : "—" }}
            </td>

            <td class="sf-mono px-2.5 py-2 text-right font-medium text-[color:var(--sf-ink)]">
              {{ askQuoteFor(ask) ? formatMarketAmount(askQuoteFor(ask)!.cost, ask.market) : "—" }}
            </td>

            <td class="sf-mono px-2.5 py-2 text-right text-[color:var(--sf-ink-2)]">
              <template v-if="ask.pricing === 'window' && ask.window">
                {{ formatDurCell(ask.window.min, unit) }}–{{ formatDurCell(ask.window.max, unit) }}
              </template>
              <template v-else-if="ask.mode === 'term'">
                {{ formatDurCell(askQuoteFor(ask)?.d ?? ask.duration, unit) }}
                <span class="text-[9.5px] text-[color:var(--sf-dim)]"> fill</span>
              </template>
              <template v-else-if="askQuoteFor(ask)">
                <span>{{ dateAtHeight(height + askQuoteFor(ask)!.d, height) }}</span>
                <span class="ml-1 text-[10px] text-[color:var(--sf-dim)]">
                  {{ formatDurCell(askQuoteFor(ask)!.d, unit) }}
                </span>
              </template>
              <template v-else>—</template>
            </td>

            <td class="px-2.5 py-2">
              <cover-meter
                :value="ask.cov"
                :ratio="ask.ratio"
                :guard="ask.guard?.ratio"
                compact
              />
            </td>

            <td class="px-3.5 py-2 text-right">
              <span
                v-if="ask.owner"
                class="sf-mono inline-block rounded-[5px] bg-[color:var(--sf-cobalt-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-cobalt)]"
              >
                Yours
              </span>
              <button
                v-else-if="isUsable(ask)"
                type="button"
                class="sf-mono inline-flex h-6 items-center rounded-[6px] border px-2.5 text-[10.5px] font-semibold transition-all active:scale-95"
                :class="
                  isBuyback(ask)
                    ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)] hover:brightness-110'
                    : 'border-[color:var(--sf-line-strong)] bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-cobalt)]'
                "
                @click.stop="emit('quick-fund', ask)"
              >
                {{ ask.kind === "order" ? "Fund" : isBuyback(ask) ? "Buy back" : "Buy" }}
              </button>
              <span
                v-else
                class="sf-mono inline-block rounded-[5px] bg-[color:var(--sf-ask-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-ask)]"
              >
                {{ ask.reason || "Paused" }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else class="flex h-full min-h-[140px] items-center justify-center px-6 text-[12px] text-[color:var(--sf-muted)]">
        {{ qLower ? `No asks matching "${searchQuery}".` : `No open ${market} asks.` }}
      </div>

      <div
        v-if="asksNext"
        class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-4 py-2 text-center"
      >
        <button
          type="button"
          :disabled="asksLoading"
          class="sf-btn-outline rounded-full px-4 py-1 text-[11.5px]"
          @click="emit('load-more-asks')"
        >
          {{ asksLoading ? "Loading…" : "Load more" }}
        </button>
      </div>
    </div>

    <!-- OFFERS (BIDS) TABLE -->
    <div v-else-if="tab === 'bids'" class="sf-scroll sf-dock-well min-h-0 flex-1 overflow-auto">
      <table v-if="filteredOffers.length" class="w-full min-w-[520px] border-collapse text-left">
        <thead class="ledger-thead sticky top-0 z-10 bg-[color:var(--sf-card)]">
          <tr class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            <th class="px-3.5 py-2">Offer</th>
            <th class="px-2.5 py-2 text-right">Min APR</th>
            <th class="hidden px-2.5 py-2 sm:table-cell">Curve</th>
            <th class="px-2.5 py-2 text-right">Capital</th>
            <th class="px-2.5 py-2 text-right">
              {{ unit === "blocks" ? "Blk" : "Maturities" }}
            </th>
            <th class="px-2.5 py-2 text-right">Floor</th>
            <th class="px-3.5 py-2 text-right">Status</th>
          </tr>
        </thead>

        <tbody class="divide-y divide-[color:var(--sf-line)] text-[12px]">
          <tr
            v-for="offer in filteredOffers"
            :key="offer.id"
            class="ledger-row cursor-pointer"
            :class="[
              selectedId === offer.id ? 'is-selected' : '',
              isUsable(offer) ? '' : 'opacity-55'
            ]"
            @click="emit('select-bid', offer.id)"
          >
            <td class="px-3.5 py-2">
              <div class="flex items-center gap-2.5">
                <zc-order-mark kind="offer" :size="26" :market="offer.market" />
                <div>
                  <div class="sf-mono font-medium leading-tight text-[color:var(--sf-ink)]">
                    {{ shortenString(offer.id, 10) }}
                  </div>
                  <div class="text-[10.5px] text-[color:var(--sf-muted)]">
                    {{ offer.delivery === "unit" ? "Units" : `${offer.delivery} shares` }} ·
                    {{ offer.points.length }} pts{{ offer.pending ? " · pending" : "" }}
                  </div>
                </div>
              </div>
            </td>

            <td class="sf-mono px-2.5 py-2 text-right font-semibold text-[color:var(--sf-bid)]">
              {{ formatApr(offer.minYieldBps) }}
            </td>

            <td class="hidden px-2.5 py-2 sm:table-cell">
              <mini-curve-spark
                :points="offer.points"
                color="var(--sf-bid)"
                :width="60"
                :height="19"
                fill
                :title="`Rolling curve (${offer.points.length} pts)`"
              />
            </td>

            <td class="sf-mono px-2.5 py-2 text-right font-medium text-[color:var(--sf-ink)]">
              {{ formatMarketAmount(offer.capital, offer.market) }}
            </td>

            <td class="sf-mono px-2.5 py-2 text-right text-[color:var(--sf-ink-2)]">
              {{ formatDurCell(offer.minBlocks, unit) }}–{{ formatDurCell(offer.maxBlocks, unit) }}
            </td>

            <td class="sf-mono px-2.5 py-2 text-right font-medium text-[color:var(--sf-ink-2)]">
              ≥ {{ offer.floor }}%
            </td>

            <td class="px-3.5 py-2 text-right">
              <span
                class="sf-mono inline-block rounded-[5px] px-2 py-0.5 text-[10px] font-semibold"
                :class="
                  offer.owner
                    ? 'bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                    : isUsable(offer)
                      ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                      : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                "
              >
                {{ offer.owner ? "Yours" : isUsable(offer) ? "Bidding" : offer.reason || "Paused" }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else class="flex h-full min-h-[140px] items-center justify-center px-6 text-[12px] text-[color:var(--sf-muted)]">
        {{ qLower ? `No offers matching "${searchQuery}".` : `No open ${market} lend offers.` }}
      </div>

      <div
        v-if="offersNext"
        class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-4 py-2 text-center"
      >
        <button
          type="button"
          :disabled="offersLoading"
          class="sf-btn-outline rounded-full px-4 py-1 text-[11.5px]"
          @click="emit('load-more-offers')"
        >
          {{ offersLoading ? "Loading…" : "Load more" }}
        </button>
      </div>
    </div>

    <!-- FILLS TABLE -->
    <div v-else class="sf-scroll sf-dock-well min-h-0 flex-1 overflow-auto">
      <table v-if="filteredFills.length" class="w-full min-w-[560px] border-collapse text-left">
        <thead class="ledger-thead sticky top-0 z-10 bg-[color:var(--sf-card)]">
          <tr class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            <th class="px-3.5 py-2">Type</th>
            <th class="px-2.5 py-2 text-right">APR</th>
            <th class="px-2.5 py-2 text-right">Cost</th>
            <th class="px-2.5 py-2 text-right">Face</th>
            <th class="px-2.5 py-2 text-right">Term</th>
            <th class="px-2.5 py-2 text-right">Cover</th>
            <th class="px-3.5 py-2 text-right">Age</th>
          </tr>
        </thead>

        <tbody class="divide-y divide-[color:var(--sf-line)] text-[12px]">
          <tr v-for="fill in filteredFills" :key="fill.id" class="ledger-row">
            <td class="px-3.5 py-2">
              <span
                class="sf-mono rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold"
                :class="
                  fill.kind === 'new'
                    ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                    : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                "
              >
                {{ fill.kind === "new" ? "New" : fill.kind === "shares" ? "Shares" : "Resale" }}
              </span>
              <span class="sf-mono ml-1.5 text-[10.5px] text-[color:var(--sf-dim)]">
                {{ fill.via }}
              </span>
            </td>
            <td class="sf-mono px-2.5 py-2 text-right font-semibold text-[color:var(--sf-ink)]">
              {{ formatApr(fill.yieldBps) }}
            </td>
            <td class="sf-mono px-2.5 py-2 text-right text-[color:var(--sf-ink)]">
              {{ formatCompact(fill.cost) }} {{ fill.market }}
            </td>
            <td class="sf-mono px-2.5 py-2 text-right text-[color:var(--sf-ink-2)]">
              {{ formatCompact(fill.face) }} {{ fill.market }}
            </td>
            <td class="sf-mono px-2.5 py-2 text-right text-[color:var(--sf-ink-2)]">
              {{ formatDur(fill.d, unit) }}
            </td>
            <td class="sf-mono px-2.5 py-2 text-right text-[color:var(--sf-ink-2)]">
              {{ fill.cov != null ? `${formatNumber(fill.cov, 0, 0)}%` : "—" }}
            </td>
            <td class="sf-mono px-3.5 py-2 text-right text-[color:var(--sf-muted)]">
              {{ formatAgo(Math.max(0, height - fill.height), unit) }}
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else class="flex h-full min-h-[140px] items-center justify-center px-6 text-[12px] text-[color:var(--sf-muted)]">
        {{
          fillsStatus === "not-configured"
            ? "Fill history unavailable on this feed."
            : fillsStatus === "disabled"
              ? "Fill history disabled."
              : `No confirmed ${market} fills in the last 10 days.`
        }}
      </div>
    </div>
  </section>
</template>

<style scoped>
.ledger-shell {
  --side-rgb: var(--sf-ask-rgb);
}
.ledger-shell[data-side="bids"] {
  --side-rgb: var(--sf-bid-rgb);
}
.ledger-shell[data-side="fills"] {
  --side-rgb: var(--sf-cobalt-rgb);
}

.ledger-thead th {
  border-bottom: 1px solid rgba(var(--side-rgb), 0.28);
  box-shadow: 0 6px 12px -8px rgba(var(--side-rgb), 0.28);
}

.ledger-row {
  transition:
    background-color 0.14s ease,
    box-shadow 0.2s var(--sf-ease);
}

.ledger-row:hover {
  background: rgba(var(--sf-cobalt-rgb), 0.055);
  box-shadow: inset 2px 0 0 rgba(var(--side-rgb), 0.45);
}

.ledger-row.is-selected {
  background: linear-gradient(
    90deg,
    rgba(var(--sf-cobalt-rgb), 0.14),
    rgba(var(--sf-cobalt-rgb), 0.04) 68%
  );
  box-shadow: inset 2.5px 0 0 var(--sf-cobalt);
}
</style>
