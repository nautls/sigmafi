<script setup lang="ts">
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  ShieldIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ExecutionPreviewModal, { ExecutionPreviewPayload } from "./components/ExecutionPreviewModal.vue";
import ZcCurveEditor, { CurveMarketOverlay } from "./components/ZcCurveEditor.vue";
import ZcOrderMark from "./components/ZcOrderMark.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { zcApi } from "@/services/zcApi";
import { useZcStore } from "@/stories";
import {
  ZcAskSummary,
  ZcChartMetric,
  ZcCurves,
  ZcLookupResult,
  ZcMatchesResponse,
  ZcOfferSummary
} from "@/types/zc";
import { shortenString } from "@/utils";
import {
  combinedAskLine,
  dateAtHeight,
  fixedAskDots,
  formatApr,
  formatDur,
  formatMarketAmount,
  formatNumber,
  fromMarket,
  isHex64,
  isOracleRefreshingOnly,
  windowAskLine,
  YEAR_BLOCKS
} from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    idOverride?: string | null;
  }>(),
  {
    idOverride: null
  }
);

const route = useRoute();
const router = useRouter();
const zc = useZcStore();

const targetId = computed(() => {
  if (props.idOverride) return props.idOverride;
  const p = route.params.id;
  if (typeof p === "string" && p.trim()) return p.trim();
  const q = route.query.id;
  return typeof q === "string" && q.trim() ? q.trim() : "";
});

const loading = ref(true);
const error = ref<string | null>(null);
const lookup = ref<ZcLookupResult | null>(null);
const offer = ref<ZcOfferSummary | null>(null);
const matches = ref<ZcMatchesResponse | null>(null);
const marketCurves = ref<ZcCurves | null>(null);
const marketAsks = ref<ZcAskSummary[]>([]);

const metric = ref<ZcChartMetric>("yield");
const copied = ref(false);
const checksOpen = ref(false);
const previewPayload = ref<ExecutionPreviewPayload | null>(null);

let loadAc: AbortController | null = null;

async function loadOffer() {
  if (loadAc) loadAc.abort();
  const id = targetId.value;
  if (!id || !isHex64(id)) {
    loading.value = false;
    error.value = id ? "Invalid 64-character hex offer ID." : "No offer ID specified.";
    offer.value = null;
    return;
  }

  const ac = new AbortController();
  loadAc = ac;
  loading.value = true;
  error.value = null;

  try {
    const res = await zcApi.lookup(id, undefined, ac.signal);
    if (ac.signal.aborted) return;
    lookup.value = res;
    if (!res || res.type !== "offer" || !res.offer) {
      offer.value = null;
      error.value = res?.note || "Lend offer not found on chain.";
      loading.value = false;
      return;
    }
    const o = res.offer;
    offer.value = o;

    const [mRes, cRes, aRes] = await Promise.all([
      zcApi.getMatches(o.id, ac.signal).catch(() => null),
      zcApi.getCurves(o.market, { coverage: Math.round(o.floor * 100) }, ac.signal).catch(() => null),
      zcApi
        .listAsksPage(
          o.market,
          { coverage: Math.round(o.floor * 100), matchable: true, limit: 120 },
          undefined,
          ac.signal
        )
        .catch(() => ({ items: [] as ZcAskSummary[], total: 0, next: null, pendingLeftOut: 0 }))
    ]);
    if (ac.signal.aborted) return;
    matches.value = mRes;
    marketCurves.value = cRes;
    marketAsks.value = aRes.items;
  } catch (err) {
    if (!ac.signal.aborted) {
      error.value = err instanceof Error ? err.message : "Failed to load lend offer.";
      offer.value = null;
    }
  } finally {
    if (!ac.signal.aborted) loading.value = false;
  }
}

watch(
  [targetId, () => zc.connected, () => zc.revision, () => zc.demoMode],
  () => {
    if (zc.connected || zc.demoMode) void loadOffer();
  },
  { immediate: true }
);

onBeforeUnmount(() => loadAc?.abort());

const height = computed(() =>
  zc.height > 100_000 ? zc.height : zc.demoMode ? 1_650_000 : zc.height
);
const unit = computed(() => zc.durationUnit);

const buys = computed(() => matches.value?.buys || matches.value?.matches || []);

const hitAskIds = computed(() => {
  const s = new Set<string>();
  for (const b of buys.value) {
    const bid = b.askId || b.boxId || b.counterpartyId;
    if (bid) s.add(bid);
  }
  return s;
});

const askById = computed(() => new Map(marketAsks.value.map((a) => [a.id, a])));

const curveOverlay = computed<CurveMarketOverlay>(() => {
  const dots = fixedAskDots(marketCurves.value).map((d) => ({
    ...d,
    hit: hitAskIds.value.has(d.id)
  }));
  return {
    bidLine: marketCurves.value?.bidLine || [],
    askLine: windowAskLine(marketCurves.value, askById.value, height.value),
    askFit: combinedAskLine(marketCurves.value, askById.value, height.value),
    dots
  };
});

const curveRange = computed(() => {
  const o = offer.value;
  if (!o || !o.points.length) return formatApr(o?.minYieldBps);
  const ys = o.points.map((p) => Math.max(p.y, o.minYieldBps));
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  return lo === hi ? formatApr(lo) : `${formatApr(lo)}–${formatApr(hi)}`;
});

const windowScale = computed(() => {
  const o = offer.value;
  if (!o) return { left: 0, width: 100 };
  const cap = Math.max(YEAR_BLOCKS, o.maxBlocks);
  const left = Math.max(0, Math.min(100, (o.minBlocks / cap) * 100));
  const right = Math.max(left + 2, Math.min(100, (o.maxBlocks / cap) * 100));
  return { left, width: right - left };
});

const usable = computed(() => !!offer.value && (offer.value.ok || isOracleRefreshingOnly(offer.value)));

const verifiedCount = computed(() => {
  const list = offer.value?.checks || [];
  const passed = list.filter((c) => c.ok === true).length;
  const failed = list.filter((c) => c.ok === false).length;
  return { total: list.length, passed, failed };
});

const boughtByOffer = computed(() => {
  const o = offer.value;
  if (!o || !o.owner) return [];
  return zc.portfolio.positions.filter((p) => p.side === "lend" && p.via === o.id);
});

const deployedAmount = computed(() => {
  const o = offer.value;
  if (!o) return 0;
  return Math.max(0, (o.funded || o.capital) - o.capital);
});

const utilizationPct = computed(() => {
  const o = offer.value;
  if (!o || !(o.funded > 0)) return 0;
  return Math.max(0, Math.min(100, (deployedAmount.value / o.funded) * 100));
});

const nextSpent = computed(() => {
  const o = offer.value;
  const raw = matches.value?.next?.spent;
  if (!o || !raw) return null;
  return fromMarket(raw, o.market);
});

async function copyId() {
  if (!offer.value) return;
  try {
    await navigator.clipboard.writeText(offer.value.id);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // ignore
  }
}

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

function openCancelPreview() {
  const o = offer.value;
  if (!o) return;
  previewPayload.value = {
    title: "Cancel & Refund Lend Offer",
    subtitle: `Returns remaining unspent ${o.market} capital & ERG reserve to Nautilus`,
    badge: `Cancel Offer · ${o.market}`,
    tone: "ask",
    heroLabel: "Capital returned",
    heroValue: formatMarketAmount(o.capital, o.market),
    heroSub: `Offer ${shortenString(o.id, 14)}`,
    rows: [
      { label: "Market", value: o.market },
      { label: "Reserve ERG", value: `${formatNumber(o.reserve, 3, 0)} ERG` },
      { label: "Delivery mode", value: o.delivery }
    ],
    rawSummary: { action: "cancelOffer", offerId: o.id, boxId: o.boxId }
  };
}

function openBorrowAgainst() {
  const o = offer.value;
  if (!o) return;
  zc.setActiveMarket(o.market);
  void router.push({ name: "zc-studio", query: { type: "borrow", match: o.id } });
}

function openSellAgainst() {
  const o = offer.value;
  if (!o) return;
  zc.setActiveMarket(o.market);
  void router.push({ name: "zc-studio", query: { type: "sell", match: o.id } });
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <!-- Loading / Error -->
    <div
      v-if="loading && !offer"
      class="sf-terminal-plate flex min-h-[320px] flex-1 items-center justify-center rounded-[22px] p-8"
    >
      <span class="sf-mono text-[12px] text-[color:var(--sf-muted)]">Loading lend offer…</span>
    </div>

    <div
      v-else-if="error || !offer"
      class="sf-terminal-plate flex min-h-[320px] flex-1 flex-col items-center justify-center rounded-[22px] p-8 text-center"
    >
      <alert-circle-icon class="h-8 w-8 text-[color:var(--sf-ask)]" />
      <h2 class="sf-display mt-3 text-[19px] font-bold text-[color:var(--sf-ink)]">
        {{ error || "Offer not found" }}
      </h2>
      <router-link
        to="/app"
        class="sf-btn-outline mt-4 inline-flex h-9 items-center gap-1.5 rounded-full px-5 text-[12.5px]"
      >
        <arrow-left-icon class="h-3.5 w-3.5" />
        <span>Back to Yield Curve</span>
      </router-link>
    </div>

    <!-- Offer Content -->
    <template v-else>
      <!-- Continuation Notice -->
      <div
        v-if="lookup?.current && lookup.current !== offer.id"
        class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-3.5 py-2 text-[12px]"
      >
        <span class="text-[color:var(--sf-ink)]">
          This offer box was spent and continued into a newer UTXO.
        </span>
        <router-link
          :to="{ name: 'zc-offer', params: { id: lookup.current } }"
          class="sf-mono inline-flex items-center gap-1 font-semibold text-[color:var(--sf-cobalt)] hover:underline"
        >
          <span>Open active continuation</span>
          <arrow-up-right-icon class="h-3.5 w-3.5" />
        </router-link>
      </div>

      <!-- Top Identity & KPI Banner -->
      <header class="sf-terminal-plate rounded-[18px] rounded-tl-[6px] p-3.5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            <router-link
              to="/app"
              class="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)] transition-colors hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-ink)]"
              title="Back to Yield Curve"
            >
              <arrow-left-icon class="h-4 w-4" />
            </router-link>

            <div class="relative grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[color:var(--sf-bid-soft)] ring-1 ring-[color:var(--sf-line-bid)]">
              <zc-order-mark kind="offer" :size="32" :market="offer.market" />
            </div>

            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h1 class="sf-display text-[19px] font-bold leading-tight text-[color:var(--sf-ink)]">
                  Lend Offer
                </h1>
                <span class="inline-flex items-center gap-1 rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-0.5 text-[11px] font-semibold text-[color:var(--sf-ink)]">
                  <market-coin :market="offer.market" :size="13" />
                  <span>{{ offer.market }}</span>
                </span>
                <span
                  class="sf-mono rounded-[5px] px-2 py-0.5 text-[10px] font-semibold uppercase"
                  :class="
                    offer.owner
                      ? 'bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                      : usable
                        ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                        : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                  "
                >
                  {{ offer.pending ? "Pending" : offer.owner ? "Yours" : usable ? "Bidding" : offer.reason }}
                </span>
              </div>

              <div class="mt-1 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="sf-mono inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
                  @click="copyId"
                >
                  <span>{{ shortenString(offer.id, 18) }}</span>
                  <check-icon v-if="copied" class="h-3 w-3 text-[color:var(--sf-bid)]" />
                  <copy-icon v-else class="h-3 w-3 opacity-70" />
                </button>
                <span class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
                  · {{ offer.delivery === "unit" ? "Bond units" : `${offer.delivery} shares` }}
                  · {{ offer.shares ? `Share lots ≥ ${formatNumber(offer.shares.floor / 100, 0)}%` : "Units only" }}
                </span>
              </div>
            </div>
          </div>

          <!-- 4 KPI Cells -->
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Capital left
              </div>
              <div class="sf-mono mt-0.5 text-[14px] font-bold text-[color:var(--sf-bid)]">
                {{ formatMarketAmount(offer.capital, offer.market) }}
              </div>
            </div>
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Minimum APR
              </div>
              <div class="sf-mono mt-0.5 text-[14px] font-bold text-[color:var(--sf-ink)]">
                {{ formatApr(offer.minYieldBps) }}
              </div>
            </div>
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Maturities
              </div>
              <div class="sf-mono mt-0.5 text-[14px] font-bold text-[color:var(--sf-ink)]">
                {{ formatDur(offer.minBlocks, unit) }}–{{ formatDur(offer.maxBlocks, unit) }}
              </div>
            </div>
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Cover floor
              </div>
              <div class="sf-mono mt-0.5 text-[14px] font-bold text-[color:var(--sf-bid)]">
                ≥ {{ Math.round(offer.floor) }}%
              </div>
            </div>
          </div>
        </div>

        <!-- Maturity Window Scale Bar -->
        <div class="mt-3 flex items-center gap-2.5 border-t border-[color:var(--sf-line)] pt-2.5">
          <span class="sf-mono text-[10px] text-[color:var(--sf-dim)]">now</span>
          <div class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--sf-line-strong)]">
            <div
              class="absolute top-0 h-full rounded-full bg-[color:var(--sf-bid)]"
              :style="{ left: `${windowScale.left}%`, width: `${windowScale.width}%` }"
            />
          </div>
          <span class="sf-mono text-[10px] text-[color:var(--sf-dim)]">1y+</span>
          <span class="sf-mono ml-2 text-[10.5px] text-[color:var(--sf-muted)]">
            Expires {{ dateAtHeight(offer.expiry, height) }}
          </span>
        </div>
      </header>

      <!-- Main 2-column Body -->
      <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_348px]">
        <!-- LEFT COLUMN -->
        <div class="flex min-h-0 flex-col gap-3">
          <!-- Rolling Yield Curve Plate -->
          <section class="sf-terminal-plate rounded-[20px] p-3.5">
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                Rolling Yield Curve ({{ offer.points.length }} pts)
              </span>
              <span class="sf-mono text-[11px] font-semibold text-[color:var(--sf-bid)]">
                {{ curveRange }}
              </span>
            </div>

            <zc-curve-editor
              :points="offer.points"
              :lo="offer.minBlocks"
              :hi="offer.maxBlocks"
              side="offer"
              :market="curveOverlay"
              :floor="offer.minYieldBps"
              :face="offer.capital || 100"
              :asset="offer.market"
              :capital="offer.capital"
              :metric="metric"
              :height="height"
              :unit="unit"
              read-only
              :chart-height="265"
              @update:metric="metric = $event"
            />
          </section>

          <!-- Live Matching Queue ("Clears Now") -->
          <section class="sf-terminal-plate rounded-[18px] p-3.5">
            <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                  Clears Now
                </span>
                <span
                  class="sf-mono rounded-[5px] px-1.5 py-0.5 text-[10px] font-semibold"
                  :class="
                    buys.length > 0
                      ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                      : 'bg-[color:var(--sf-well-soft)] text-[color:var(--sf-muted)]'
                  "
                >
                  {{ buys.length }} {{ buys.length === 1 ? "ask" : "asks" }}
                </span>
              </div>

              <span
                v-if="matches?.next && matches.next.taken.length > 0"
                class="sf-mono text-[11px] text-[color:var(--sf-bid)]"
              >
                Batcher takes {{ matches.next.taken.length }} ·
                {{ formatMarketAmount(nextSpent, offer.market) }}
                <template v-if="matches.next.avgYieldBps != null">
                  at {{ formatApr(matches.next.avgYieldBps) }}
                </template>
              </span>
            </div>

            <div
              v-if="buys.length === 0"
              class="sf-dock-well rounded-xl px-3.5 py-3 text-[12px] text-[color:var(--sf-muted)]"
            >
              {{ matches?.notMatchable || "No open asks currently cross this offer's curve." }}
            </div>

            <div v-else class="overflow-x-auto">
              <table class="w-full border-collapse text-left text-[12px]">
                <thead>
                  <tr class="sf-mono border-b border-[color:var(--sf-line)] text-[10px] uppercase tracking-[0.08em] text-[color:var(--sf-dim)]">
                    <th class="py-1.5 pr-3 font-semibold">Listing</th>
                    <th class="py-1.5 px-2 font-semibold">APR</th>
                    <th class="py-1.5 px-2 font-semibold">Requires</th>
                    <th class="py-1.5 px-2 font-semibold">Cost</th>
                    <th class="py-1.5 px-2 font-semibold">Matures</th>
                    <th class="py-1.5 pl-2 text-right font-semibold">Cover</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-[color:var(--sf-line)]">
                  <tr
                    v-for="b in buys"
                    :key="b.askId || b.boxId || b.counterpartyId"
                    class="cursor-pointer transition-colors hover:bg-[color:var(--sf-well-soft)]"
                    @click="
                      router.push({
                        name: 'zc-bond',
                        params: { id: b.askId || b.boxId || b.counterpartyId || '' }
                      })
                    "
                  >
                    <td class="sf-mono py-2 pr-3 font-semibold text-[color:var(--sf-cobalt)]">
                      {{ shortenString(b.askId || b.boxId || b.counterpartyId || "", 12) }}
                    </td>
                    <td class="sf-mono py-2 px-2 font-bold text-[color:var(--sf-ask)]">
                      {{ formatApr(b.yieldBps) }}
                    </td>
                    <td class="sf-mono py-2 px-2 text-[color:var(--sf-bid)]">
                      {{ formatApr(b.requiredBps) }}
                    </td>
                    <td class="sf-mono py-2 px-2 text-[color:var(--sf-ink)]">
                      {{ b.cost ? formatMarketAmount(fromMarket(b.cost, offer.market), offer.market) : "—" }}
                    </td>
                    <td class="sf-mono py-2 px-2 text-[color:var(--sf-ink-2)]">
                      {{ formatDur(Math.max(0, b.maturity - height), unit) }}
                    </td>
                    <td class="sf-mono py-2 pl-2 text-right text-[color:var(--sf-ink-2)]">
                      {{ b.coverBps != null ? `${Math.round(b.coverBps / 100)}%` : "—" }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Owner Offer Performance Plate -->
          <section v-if="offer.owner" class="sf-terminal-plate rounded-[18px] p-3.5">
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                Offer Utilization
              </span>
              <span class="sf-mono text-[11px] font-semibold text-[color:var(--sf-cobalt)]">
                {{ formatNumber(utilizationPct, 1, 0) }}% deployed
              </span>
            </div>

            <div class="grid grid-cols-3 gap-2">
              <div class="sf-dock-well rounded-xl px-3 py-2">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)]">Funded</div>
                <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
                  {{ formatMarketAmount(offer.funded, offer.market) }}
                </div>
              </div>
              <div class="sf-dock-well rounded-xl px-3 py-2">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)]">Deployed</div>
                <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-cobalt)]">
                  {{ formatMarketAmount(deployedAmount, offer.market) }}
                </div>
              </div>
              <div class="sf-dock-well rounded-xl px-3 py-2">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)]">Bonds filled</div>
                <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-bid)]">
                  {{ boughtByOffer.length }}
                </div>
              </div>
            </div>

            <div class="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[color:var(--sf-line-strong)]">
              <div
                class="h-full rounded-full bg-[color:var(--sf-cobalt)] transition-all duration-500"
                :style="{ width: `${utilizationPct}%` }"
              />
            </div>

            <div v-if="boughtByOffer.length > 0" class="mt-2.5 space-y-1">
              <router-link
                v-for="p in boughtByOffer"
                :key="p.id"
                :to="{ name: 'zc-bond', params: { id: p.bond.id } }"
                class="flex items-center justify-between rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2.5 py-1.5 text-[11.5px] transition-colors hover:border-[color:var(--sf-line-cobalt)]"
              >
                <span class="sf-mono font-semibold text-[color:var(--sf-cobalt)]">
                  {{ shortenString(p.bond.id, 14) }}
                </span>
                <span class="sf-mono text-[color:var(--sf-ink)]">
                  {{ formatMarketAmount(p.bond.repayment, p.bond.market) }} ·
                  {{ formatDur(Math.max(0, p.bond.maturity - height), unit) }}
                </span>
              </router-link>
            </div>
          </section>
        </div>

        <!-- RIGHT ACTION DOCK -->
        <aside
          class="sf-action-dock flex flex-col self-start rounded-[22px] rounded-tr-[6px]"
          data-tone="bid"
          aria-label="Lend Offer Actions"
          @mousemove="onDockPointerMove"
        >
          <div class="sf-panel-head px-4 pt-3.5 pb-3">
            <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
              Available capital
            </div>
            <div class="sf-serif mt-0.5 text-[32px] font-semibold leading-none text-[color:var(--sf-bid)]">
              {{ formatMarketAmount(offer.capital, offer.market) }}
            </div>
            <div
              v-if="offer.funded > offer.capital"
              class="sf-mono mt-1 text-[11px] text-[color:var(--sf-muted)]"
            >
              of {{ formatMarketAmount(offer.funded, offer.market) }} funded
            </div>
          </div>

          <div class="space-y-2.5 px-4 py-3">
            <!-- Verification Badge -->
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 text-left"
                @click="checksOpen = !checksOpen"
              >
                <div class="flex items-center gap-1.5">
                  <shield-icon
                    class="h-3.5 w-3.5"
                    :class="
                      verifiedCount.failed > 0
                        ? 'text-[color:var(--sf-ask)]'
                        : 'text-[color:var(--sf-bid)]'
                    "
                  />
                  <span class="sf-mono text-[11px] font-semibold text-[color:var(--sf-ink)]">
                    {{
                      verifiedCount.failed > 0
                        ? `${verifiedCount.failed} check warning${verifiedCount.failed === 1 ? "" : "s"}`
                        : `zcs1 Verified (${verifiedCount.passed}/${verifiedCount.total})`
                    }}
                  </span>
                </div>
                <chevron-up-icon v-if="checksOpen" class="h-3.5 w-3.5 text-[color:var(--sf-muted)]" />
                <chevron-down-icon v-else class="h-3.5 w-3.5 text-[color:var(--sf-muted)]" />
              </button>

              <div v-if="checksOpen && offer.checks.length" class="mt-2 space-y-1 border-t border-[color:var(--sf-line)] pt-2">
                <div
                  v-for="c in offer.checks"
                  :key="c.key"
                  class="flex items-start gap-1.5 text-[11px]"
                >
                  <check-circle-icon
                    v-if="c.ok === true"
                    class="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--sf-bid)]"
                  />
                  <alert-circle-icon
                    v-else
                    class="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--sf-ask)]"
                  />
                  <span class="text-[color:var(--sf-ink-2)]">{{ c.detail }}</span>
                </div>
              </div>
            </div>

            <!-- Contract KV -->
            <div class="divide-y divide-[color:var(--sf-line)] rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 text-[11.5px]">
              <div class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Delivery</span>
                <span class="sf-mono font-semibold capitalize text-[color:var(--sf-ink)]">
                  {{ offer.delivery === "unit" ? "Bond units" : `${offer.delivery} shares` }}
                </span>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Oracle max age</span>
                <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">{{ offer.oracleAge }} blk</span>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Batcher fee</span>
                <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
                  {{ formatNumber(offer.fee, 4, 0) }} ERG
                </span>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Reserve</span>
                <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
                  {{ formatNumber(offer.reserve, 3, 0) }} ERG
                </span>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <span class="text-[color:var(--sf-muted)]">Expires</span>
                <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
                  {{ formatDur(Math.max(0, offer.expiry - height), unit) }}
                </span>
              </div>
            </div>
          </div>

          <div class="space-y-2 border-t border-[color:var(--sf-line)] p-3.5">
            <button
              v-if="offer.owner"
              type="button"
              class="sf-btn-ask flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px]"
              @click="openCancelPreview"
            >
              <span>Cancel &amp; Refund</span>
              <arrow-right-icon class="h-4 w-4" />
            </button>
            <template v-else>
              <button
                type="button"
                class="sf-btn-bid flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px]"
                @click="openBorrowAgainst"
              >
                <span>Borrow from Offer</span>
                <arrow-right-icon class="h-4 w-4" />
              </button>
              <button
                type="button"
                class="sf-btn-outline flex h-9 w-full items-center justify-center gap-2 rounded-xl text-[12.5px]"
                @click="openSellAgainst"
              >
                <span>Sell Bond into Offer</span>
              </button>
            </template>
          </div>
        </aside>
      </div>
    </template>

    <transition name="sf-modal">
      <execution-preview-modal
        v-if="previewPayload"
        :payload="previewPayload"
        @close="previewPayload = null"
      />
    </transition>
  </div>
</template>
