<script setup lang="ts">
import { computed } from "vue";
import CoverMeter from "./CoverMeter.vue";
import MiniCurveSpark from "./MiniCurveSpark.vue";
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
  return askPath(a, props.height, 16);
}

function isUsable(x: { ok: boolean; status?: string; reasons?: string[] }) {
  return x.ok || isOracleRefreshingOnly(x);
}
</script>

<template>
  <section class="sf-plate overflow-hidden rounded-2xl">
    <!-- Ledger Header Bar -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--sf-line)] px-4 py-3 sm:px-5"
    >
      <div class="flex flex-wrap items-center gap-2.5">
        <div
          class="inline-flex rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5 text-[12px]"
          role="tablist"
          aria-label="Order Ledger side"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'asks'"
            class="rounded-md px-3 py-1 font-semibold transition-all"
            :class="
              tab === 'asks'
                ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ask)] shadow-sm ring-1 ring-slate-900/10'
                : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
            "
            @click="emit('update:tab', 'asks')"
          >
            Asks <span class="sf-mono ml-1 opacity-80">{{ asksTotal }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'bids'"
            class="rounded-md px-3 py-1 font-semibold transition-all"
            :class="
              tab === 'bids'
                ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-bid)] shadow-sm ring-1 ring-slate-900/10'
                : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
            "
            @click="emit('update:tab', 'bids')"
          >
            Lend Offers <span class="sf-mono ml-1 opacity-80">{{ offersTotal }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'fills'"
            class="rounded-md px-3 py-1 font-semibold transition-all"
            :class="
              tab === 'fills'
                ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
                : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
            "
            @click="emit('update:tab', 'fills')"
          >
            Fills <span class="sf-mono ml-1 opacity-80">{{ fills.length }}</span>
          </button>
        </div>

        <span
          v-if="follow && tab !== 'fills'"
          class="sf-mono rounded-md bg-cobalt-50 px-2 py-0.5 text-[10.5px] font-semibold text-cobalt-700 ring-1 ring-cobalt-600/20"
        >
          Following maturity
        </span>

        <span
          v-if="(tab === 'asks' && asksPendingHidden > 0) || (tab === 'bids' && offersPendingHidden > 0)"
          class="sf-mono rounded-md bg-[color:var(--sf-ask-soft)] px-2 py-0.5 text-[10.5px] font-medium text-[color:var(--sf-ask)]"
        >
          +{{ tab === "asks" ? asksPendingHidden : offersPendingHidden }} pending hidden
        </span>
      </div>

      <!-- Sort Controls -->
      <div
        v-if="tab !== 'fills'"
        class="inline-flex items-center rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5 text-[11.5px]"
        role="group"
        aria-label="Sort rows"
      >
        <button
          v-for="sKey in (['apr', 'maturity', 'size'] as ZcSortKey[])"
          :key="sKey"
          type="button"
          class="sf-mono rounded-md px-2.5 py-1 font-medium capitalize transition-all"
          :class="
            sort === sKey
              ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
              : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="emit('update:sort', sKey)"
        >
          {{ sKey === "apr" ? "APR" : sKey }}
        </button>
      </div>
    </div>

    <!-- ASKS TABLE -->
    <div v-if="tab === 'asks'" class="sf-scroll max-h-[460px] overflow-auto">
      <table v-if="filteredAsks.length" class="w-full min-w-[720px] border-collapse text-left">
        <thead
          class="sticky top-0 z-10 border-b border-[color:var(--sf-line)] bg-[color:var(--sf-paper)]"
        >
          <tr class="sf-mono text-[10px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            <th class="px-4 py-2.5 font-medium sm:px-5">Listing</th>
            <th class="px-3 py-2.5 text-right font-medium">APR now</th>
            <th class="px-3 py-2.5 font-medium">Trajectory</th>
            <th class="px-3 py-2.5 text-right font-medium">Par P/F</th>
            <th class="px-3 py-2.5 text-right font-medium">Size</th>
            <th class="px-3 py-2.5 text-right font-medium">
              {{ unit === "blocks" ? "Matures · blk" : "Matures" }}
            </th>
            <th class="px-3 py-2.5 font-medium">Cover</th>
            <th class="px-4 py-2.5 text-right font-medium sm:px-5">Status</th>
          </tr>
        </thead>

        <tbody class="divide-y divide-[color:var(--sf-line)] text-[12.5px]">
          <tr
            v-for="ask in filteredAsks"
            :key="ask.id"
            class="cursor-pointer transition-colors"
            :class="[
              selectedId === ask.id
                ? 'bg-cobalt-50/70'
                : 'hover:bg-[color:var(--sf-well)]',
              isUsable(ask) ? '' : 'opacity-60'
            ]"
            @click="emit('select-ask', ask.id)"
          >
            <td class="px-4 py-3 sm:px-5">
              <div class="flex items-center gap-2.5">
                <span
                  class="sf-mono grid h-7 w-7 shrink-0 place-items-center rounded-lg border text-[10px] font-bold uppercase"
                  :class="
                    ask.kind === 'order'
                      ? 'border-[color:var(--sf-ask)]/30 bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                      : ask.kind === 'shares'
                        ? 'border-[color:var(--sf-bid)]/30 bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                        : 'border-cobalt-600/25 bg-cobalt-50 text-cobalt-700'
                  "
                >
                  {{ ask.kind === "order" ? "LN" : ask.kind === "shares" ? "SH" : "BD" }}
                </span>
                <div>
                  <div class="flex items-center gap-1.5 font-medium text-[color:var(--sf-ink)]">
                    <span>{{ kindLabel(ask.kind) }}</span>
                    <span class="sf-mono text-[11px] text-[color:var(--sf-dim)]">
                      {{ shortenString(ask.id, 10) }}
                    </span>
                  </div>
                  <div class="text-[11px] text-[color:var(--sf-muted)]">
                    {{ pricingName(ask) }}{{ ask.pending ? " · pending" : "" }}
                  </div>
                </div>
              </div>
            </td>

            <td class="sf-mono px-3 py-3 text-right font-semibold text-[color:var(--sf-ask)]">
              {{ formatApr(askQuoteFor(ask)?.yieldBps) }}
              <span
                v-if="ask.pricing === 'window'"
                class="block text-[9.5px] font-normal text-[color:var(--sf-dim)]"
              >
                peak
              </span>
            </td>

            <td class="px-3 py-3">
              <mini-curve-spark
                :points="askSparkPts(ask)"
                color="var(--sf-ask)"
                :width="64"
                :height="22"
                :title="
                  ask.pricing === 'window'
                    ? 'APR by chosen maturity'
                    : 'Projected APR trajectory until expiry'
                "
              />
            </td>

            <td class="sf-mono px-3 py-3 text-right text-[color:var(--sf-ink-2)]">
              {{ askQuoteFor(ask) ? `${askQuoteFor(ask)!.pct.toFixed(2)}%` : "—" }}
            </td>

            <td class="sf-mono px-3 py-3 text-right font-medium text-[color:var(--sf-ink)]">
              {{ askQuoteFor(ask) ? formatMarketAmount(askQuoteFor(ask)!.cost, ask.market) : "—" }}
            </td>

            <td class="sf-mono px-3 py-3 text-right text-[color:var(--sf-ink-2)]">
              <template v-if="ask.pricing === 'window' && ask.window">
                {{ formatDurCell(ask.window.min, unit) }}–{{ formatDurCell(ask.window.max, unit) }}
              </template>
              <template v-else-if="ask.mode === 'term'">
                {{ formatDurCell(askQuoteFor(ask)?.d ?? ask.duration, unit) }}
                <span class="block text-[10px] text-[color:var(--sf-dim)]">from fill</span>
              </template>
              <template v-else-if="askQuoteFor(ask)">
                <span>{{ dateAtHeight(height + askQuoteFor(ask)!.d, height) }}</span>
                <span class="block text-[10px] text-[color:var(--sf-dim)]">
                  {{ formatDur(askQuoteFor(ask)!.d, unit) }}
                </span>
              </template>
              <template v-else>—</template>
            </td>

            <td class="px-3 py-3">
              <cover-meter
                :value="ask.cov"
                :ratio="ask.ratio"
                :guard="ask.guard?.ratio"
                compact
              />
            </td>

            <td class="px-4 py-3 text-right sm:px-5">
              <span
                class="sf-mono inline-block rounded-md px-2 py-0.5 text-[10.5px] font-semibold"
                :class="
                  ask.owner
                    ? 'bg-cobalt-50 text-cobalt-700'
                    : isUsable(ask)
                      ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                      : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                "
              >
                {{ ask.owner ? "Yours" : isUsable(ask) ? "Inspect" : ask.reason || "Paused" }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else class="px-6 py-12 text-center text-[13px] text-[color:var(--sf-muted)]">
        {{ qLower ? `No asks matching "${searchQuery}".` : `No open ${market} asks match the active filters.` }}
      </div>

      <div
        v-if="asksNext"
        class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-4 py-3 text-center"
      >
        <button
          type="button"
          :disabled="asksLoading"
          class="sf-btn-outline rounded-lg px-4 py-1.5 text-[12px]"
          @click="emit('load-more-asks')"
        >
          {{ asksLoading ? "Loading…" : "Load more asks" }}
        </button>
      </div>
    </div>

    <!-- OFFERS (BIDS) TABLE -->
    <div v-else-if="tab === 'bids'" class="sf-scroll max-h-[460px] overflow-auto">
      <table v-if="filteredOffers.length" class="w-full min-w-[680px] border-collapse text-left">
        <thead
          class="sticky top-0 z-10 border-b border-[color:var(--sf-line)] bg-[color:var(--sf-paper)]"
        >
          <tr class="sf-mono text-[10px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            <th class="px-4 py-2.5 font-medium sm:px-5">Lend Offer</th>
            <th class="px-3 py-2.5 text-right font-medium">Min APR</th>
            <th class="px-3 py-2.5 font-medium">Curve</th>
            <th class="px-3 py-2.5 text-right font-medium">Capital</th>
            <th class="px-3 py-2.5 text-right font-medium">
              {{ unit === "blocks" ? "Maturities · blk" : "Maturities" }}
            </th>
            <th class="px-3 py-2.5 text-right font-medium">Cover floor</th>
            <th class="px-4 py-2.5 text-right font-medium sm:px-5">Status</th>
          </tr>
        </thead>

        <tbody class="divide-y divide-[color:var(--sf-line)] text-[12.5px]">
          <tr
            v-for="offer in filteredOffers"
            :key="offer.id"
            class="cursor-pointer transition-colors"
            :class="[
              selectedId === offer.id
                ? 'bg-cobalt-50/70'
                : 'hover:bg-[color:var(--sf-well)]',
              isUsable(offer) ? '' : 'opacity-60'
            ]"
            @click="emit('select-bid', offer.id)"
          >
            <td class="px-4 py-3 sm:px-5">
              <div class="flex items-center gap-2.5">
                <span
                  class="sf-mono grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[color:var(--sf-bid)]/30 bg-[color:var(--sf-bid-soft)] text-[10px] font-bold text-[color:var(--sf-bid)]"
                >
                  LO
                </span>
                <div>
                  <div class="sf-mono font-medium text-[color:var(--sf-ink)]">
                    {{ shortenString(offer.id, 12) }}
                  </div>
                  <div class="text-[11px] text-[color:var(--sf-muted)]">
                    {{ offer.delivery === "unit" ? "Bond units" : `Into ${offer.delivery} shares` }}
                    · {{ offer.points.length }} pts{{ offer.pending ? " · pending" : "" }}
                  </div>
                </div>
              </div>
            </td>

            <td class="sf-mono px-3 py-3 text-right font-semibold text-[color:var(--sf-bid)]">
              {{ formatApr(offer.minYieldBps) }}
            </td>

            <td class="px-3 py-3">
              <mini-curve-spark
                :points="offer.points"
                color="var(--sf-bid)"
                :width="68"
                :height="22"
                fill
                :title="`Rolling yield curve (${offer.points.length} points)`"
              />
            </td>

            <td class="sf-mono px-3 py-3 text-right font-medium text-[color:var(--sf-ink)]">
              {{ formatMarketAmount(offer.capital, offer.market) }}
            </td>

            <td class="sf-mono px-3 py-3 text-right text-[color:var(--sf-ink-2)]">
              {{ formatDurCell(offer.minBlocks, unit) }}–{{ formatDurCell(offer.maxBlocks, unit) }}
            </td>

            <td class="sf-mono px-3 py-3 text-right font-medium text-[color:var(--sf-ink-2)]">
              ≥ {{ offer.floor }}%
            </td>

            <td class="px-4 py-3 text-right sm:px-5">
              <span
                class="sf-mono inline-block rounded-md px-2 py-0.5 text-[10.5px] font-semibold"
                :class="
                  offer.owner
                    ? 'bg-cobalt-50 text-cobalt-700'
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

      <div v-else class="px-6 py-12 text-center text-[13px] text-[color:var(--sf-muted)]">
        {{
          qLower
            ? `No lend offers matching "${searchQuery}".`
            : `No open ${market} lend offers match the active filters.`
        }}
      </div>

      <div
        v-if="offersNext"
        class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-4 py-3 text-center"
      >
        <button
          type="button"
          :disabled="offersLoading"
          class="sf-btn-outline rounded-lg px-4 py-1.5 text-[12px]"
          @click="emit('load-more-offers')"
        >
          {{ offersLoading ? "Loading…" : "Load more offers" }}
        </button>
      </div>
    </div>

    <!-- FILLS TABLE -->
    <div v-else class="sf-scroll max-h-[460px] overflow-auto">
      <table v-if="filteredFills.length" class="w-full min-w-[640px] border-collapse text-left">
        <thead
          class="sticky top-0 z-10 border-b border-[color:var(--sf-line)] bg-[color:var(--sf-paper)]"
        >
          <tr class="sf-mono text-[10px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            <th class="px-4 py-2.5 font-medium sm:px-5">Type</th>
            <th class="px-3 py-2.5 text-right font-medium">Fill APR</th>
            <th class="px-3 py-2.5 text-right font-medium">Cost</th>
            <th class="px-3 py-2.5 text-right font-medium">Face</th>
            <th class="px-3 py-2.5 text-right font-medium">Maturity</th>
            <th class="px-3 py-2.5 text-right font-medium">Cover</th>
            <th class="px-4 py-2.5 text-right font-medium sm:px-5">Age</th>
          </tr>
        </thead>

        <tbody class="divide-y divide-[color:var(--sf-line)] text-[12.5px]">
          <tr
            v-for="fill in filteredFills"
            :key="fill.id"
            class="hover:bg-[color:var(--sf-well)]"
          >
            <td class="px-4 py-2.5 sm:px-5">
              <span
                class="sf-mono rounded px-1.5 py-0.5 text-[10.5px] font-semibold"
                :class="
                  fill.kind === 'new'
                    ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                    : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                "
              >
                {{ fill.kind === "new" ? "New loan" : fill.kind === "shares" ? "Shares" : "Resale" }}
              </span>
              <span class="sf-mono ml-2 text-[11px] text-[color:var(--sf-dim)]">
                via {{ fill.via }}
              </span>
            </td>
            <td class="sf-mono px-3 py-2.5 text-right font-semibold text-[color:var(--sf-ink)]">
              {{ formatApr(fill.yieldBps) }}
            </td>
            <td class="sf-mono px-3 py-2.5 text-right text-[color:var(--sf-ink)]">
              {{ formatCompact(fill.cost) }} {{ fill.market }}
            </td>
            <td class="sf-mono px-3 py-2.5 text-right text-[color:var(--sf-ink-2)]">
              {{ formatCompact(fill.face) }} {{ fill.market }}
            </td>
            <td class="sf-mono px-3 py-2.5 text-right text-[color:var(--sf-ink-2)]">
              {{ formatDur(fill.d, unit) }}
            </td>
            <td class="sf-mono px-3 py-2.5 text-right text-[color:var(--sf-ink-2)]">
              {{ fill.cov != null ? `${formatNumber(fill.cov, 0, 0)}%` : "—" }}
            </td>
            <td class="sf-mono px-4 py-2.5 text-right text-[color:var(--sf-muted)] sm:px-5">
              {{ formatAgo(Math.max(0, height - fill.height), unit) }}
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else class="px-6 py-12 text-center text-[13px] text-[color:var(--sf-muted)]">
        {{
          fillsStatus === "not-configured"
            ? "Fill history indexing is not configured on this data feed."
            : fillsStatus === "unavailable"
              ? "Fill history could not be loaded from the data feed."
              : fillsStatus === "disabled"
                ? "Fill history indexing is disabled."
                : `No confirmed ${market} fills in the last 10 days.`
        }}
      </div>
    </div>
  </section>
</template>
