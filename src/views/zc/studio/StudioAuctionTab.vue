<script setup lang="ts">
import { AlertCircleIcon, ArrowRightIcon, CheckCircleIcon } from "@zhuowenli/vue-feather-icons";
import { computed, ref, watch } from "vue";
import { ExecutionPreviewPayload } from "../components/ExecutionPreviewModal.vue";
import ZcDurInput from "../components/ZcDurInput.vue";
import ZcScheduleEditor, { DutchSchedule } from "../components/ZcScheduleEditor.vue";
import ZcTokenPicker, { SelectedWalletToken } from "../components/ZcTokenPicker.vue";
import AssetIcon from "@/components/AssetIcon.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { buildLotBody } from "@/services/zcApi";
import { useZcStore } from "@/stories";
import { ZcWalletToken } from "@/types/zc";
import {
  dateAtHeight,
  DAY_BLOCKS,
  formatDur,
  formatMarketAmount,
  formatNumber,
  SIGUSD_TOKEN_ID
} from "@/utils/zcMath";

const emit = defineEmits<{
  (e: "preview", payload: ExecutionPreviewPayload): void;
  (e: "wrap-token", token: ZcWalletToken): void;
}>();

const zc = useZcStore();

const market = computed(() => zc.activeMarket);
const height = computed(() => zc.height);
const oraclePrice = computed(() => zc.oracle.price);
const unit = computed(() => zc.durationUnit);

const basket = ref<SelectedWalletToken[]>([]);
const ergInLotText = ref("");
const openingText = ref("120");
const floorText = ref("80");
const startInDays = ref<number | null>(0);
const fallsDays = ref<number | null>(2);
const expiryDays = ref<number | null>(5);
const refundFeeText = ref("0.005");

const excludeIds = computed(() => (market.value === "SigUSD" ? [SIGUSD_TOKEN_ID] : []));

const ergInLotNum = computed(() => {
  if (market.value !== "SigUSD") return 0;
  const n = Number(ergInLotText.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
});

const openingNum = computed(() => {
  const n = Number(openingText.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
});

const floorNum = computed(() => {
  const n = Number(floorText.value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, openingNum.value || n) : 0;
});

const startHeight = computed(
  () => height.value + Math.max(0, Math.round((startInDays.value || 0) * DAY_BLOCKS))
);
const endHeight = computed(
  () => startHeight.value + Math.max(30, Math.round((fallsDays.value || 2) * DAY_BLOCKS))
);
const expiryHeight = computed(
  () => Math.max(endHeight.value + 30, height.value + Math.round((expiryDays.value || 5) * DAY_BLOCKS))
);

const sched = computed<DutchSchedule>(() => ({
  start: startHeight.value,
  opening: openingNum.value,
  end: endHeight.value,
  floor: floorNum.value,
  expiry: expiryHeight.value
}));

function onSchedUpdate(next: DutchSchedule) {
  openingText.value = String(Number(next.opening.toFixed(market.value === "ERG" ? 3 : 2)));
  floorText.value = String(Number(next.floor.toFixed(market.value === "ERG" ? 3 : 2)));
  startInDays.value = Number(((next.start - height.value) / DAY_BLOCKS).toFixed(2));
  fallsDays.value = Number(((next.end - next.start) / DAY_BLOCKS).toFixed(2));
  expiryDays.value = Number(((next.expiry - height.value) / DAY_BLOCKS).toFixed(2));
}

// Oracle reference value (for SigUSD in ERG auction or ERG in SigUSD auction)
const oracleRef = computed(() => {
  if (!(oraclePrice.value > 0)) return null;
  if (market.value === "SigUSD" && ergInLotNum.value > 0) {
    return ergInLotNum.value * oraclePrice.value;
  }
  if (market.value === "ERG") {
    const sigItem = basket.value.find((t) => t.id.toLowerCase() === SIGUSD_TOKEN_ID);
    if (sigItem && sigItem.amount > 0) return sigItem.amount / oraclePrice.value;
  }
  return null;
});

watch(oracleRef, (val, prev) => {
  if (val && val > 0 && (!prev || prev === 0)) {
    openingText.value = String(Number((val * 1.1).toFixed(market.value === "ERG" ? 3 : 2)));
    floorText.value = String(Number((val * 0.9).toFixed(market.value === "ERG" ? 3 : 2)));
  }
});

const itemCount = computed(
  () => basket.value.filter((t) => t.amount > 0).length + (ergInLotNum.value > 0 ? 1 : 0)
);

const floorHeldBlocks = computed(() => Math.max(0, expiryHeight.value - endHeight.value));

const checks = computed(() => [
  {
    label: itemCount.value > 0 ? `${itemCount.value} item${itemCount.value === 1 ? "" : "s"} in lot` : "Add at least one asset",
    ok: itemCount.value > 0
  },
  {
    label:
      openingNum.value > 0 && openingNum.value >= floorNum.value
        ? `Schedule ${formatMarketAmount(openingNum.value, market.value)} → ${formatMarketAmount(floorNum.value, market.value)}`
        : "Opening must be ≥ floor",
    ok: openingNum.value > 0 && openingNum.value >= floorNum.value
  }
]);

const canSubmit = computed(() => checks.value.every((c) => c.ok));

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

function openPreview() {
  const body = buildLotBody({
    market: market.value,
    items: basket.value.map((t) => ({ id: t.id, amount: t.amount, decimals: t.decimals })),
    erg: ergInLotNum.value > 0 ? ergInLotNum.value : null,
    opening: openingNum.value,
    floor: floorNum.value,
    start: startHeight.value,
    end: endHeight.value,
    expiry: expiryHeight.value,
    refundFee: Number(refundFeeText.value) || 0.005
  });
  if (!body) return;

  emit("preview", {
    title: "Post Dutch Sale Auction",
    subtitle: `${itemCount.value} asset${itemCount.value === 1 ? "" : "s"} priced in ${market.value}`,
    badge: `Auction · ${market.value}`,
    tone: "ask",
    heroLabel: "Opening price",
    heroValue: formatMarketAmount(openingNum.value, market.value),
    heroSub: `Falls to ${formatMarketAmount(floorNum.value, market.value)} over ${formatDur(endHeight.value - startHeight.value, unit.value)}`,
    rows: [
      { label: "Items in lot", value: `${itemCount.value}` },
      { label: "Floor held", value: formatDur(floorHeldBlocks.value, unit.value) },
      {
        label: "Expires",
        value: `${formatDur(expiryHeight.value - height.value, unit.value)} (${dateAtHeight(expiryHeight.value, height.value)})`
      },
      { label: "Refund fee", value: `${refundFeeText.value || "0.005"} ERG` },
      ...(oracleRef.value != null
        ? [{ label: "Oracle ref", value: formatMarketAmount(oracleRef.value, market.value), tone: "cobalt" as const }]
        : [])
    ],
    rawSummary: { action: "createLot", ...body },
    txAction: { type: "createLot", body }
  });
}
</script>

<template>
  <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_348px]">
    <!-- LEFT WORKBENCH -->
    <div class="flex min-h-0 flex-col gap-2.5">
      <!-- Lot Basket & Schedule Parameters -->
      <section class="sf-terminal-plate shrink-0 rounded-[18px] rounded-tl-[6px] p-3">
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1.15fr]">
          <!-- Basket Picker -->
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Lot Basket
              </span>
              <div
                v-if="market === 'SigUSD'"
                class="sf-input-well flex h-7 w-[150px] items-center gap-1.5 rounded-lg px-2"
                data-tone="ask"
              >
                <market-coin market="ERG" :size="14" />
                <span class="sf-mono text-[9.5px] text-[color:var(--sf-dim)]">+ERG</span>
                <input
                  v-model="ergInLotText"
                  inputmode="decimal"
                  placeholder="0.0"
                  class="sf-mono w-full min-w-0 bg-transparent text-right text-[12px] font-semibold text-[color:var(--sf-ink)] outline-none"
                />
              </div>
            </div>
            <zc-token-picker
              v-model="basket"
              :exclude-ids="excludeIds"
              compact
              show-wrap-action
              tone="ask"
              empty-text="No tokens in wallet to auction."
              @wrap="emit('wrap-token', $event)"
            />
          </div>

          <!-- Schedule Controls -->
          <div class="grid grid-cols-2 content-start gap-2 border-t border-[color:var(--sf-line)] pt-2.5 sm:grid-cols-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-3">
            <div>
              <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Opening
              </label>
              <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2.5" data-tone="ask">
                <input
                  v-model="openingText"
                  inputmode="decimal"
                  class="sf-mono w-full min-w-0 bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] outline-none"
                />
                <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">{{ market }}</span>
              </div>
            </div>

            <div>
              <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Floor
              </label>
              <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2.5" data-tone="ask">
                <input
                  v-model="floorText"
                  inputmode="decimal"
                  class="sf-mono w-full min-w-0 bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] outline-none"
                />
                <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">{{ market }}</span>
              </div>
            </div>

            <div>
              <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Refund fee
              </label>
              <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2.5" data-tone="cobalt">
                <input
                  v-model="refundFeeText"
                  inputmode="decimal"
                  class="sf-mono w-full min-w-0 bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] outline-none"
                />
                <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">ERG</span>
              </div>
            </div>

            <div>
              <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Starts in
              </label>
              <zc-dur-input v-model="startInDays" :unit="unit" of="days" tone="ask" />
            </div>

            <div>
              <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Falls over
              </label>
              <zc-dur-input v-model="fallsDays" :unit="unit" of="days" tone="ask" />
            </div>

            <div>
              <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Expires in
              </label>
              <zc-dur-input v-model="expiryDays" :unit="unit" of="days" tone="cobalt" />
            </div>
          </div>
        </div>
      </section>

      <!-- Draggable Schedule Chart Plate -->
      <section class="sf-terminal-plate flex min-h-[260px] flex-1 flex-col rounded-[20px] rounded-bl-[6px] p-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            Dutch Price Schedule · Drag handles to adjust
          </span>
          <span v-if="oracleRef != null" class="sf-mono text-[10.5px] text-[color:var(--sf-cobalt)]">
            Oracle {{ formatMarketAmount(oracleRef, market) }}
          </span>
        </div>

        <div class="flex min-h-0 flex-1 flex-col">
          <zc-schedule-editor
            :sched="sched"
            :height="height"
            :unit-label="market"
            :duration-unit="unit"
            :reference="oracleRef"
            :ref-label="oracleRef != null ? `oracle ${formatMarketAmount(oracleRef, market)}` : null"
            color="var(--sf-ask)"
            fill-height
            @update:sched="onSchedUpdate"
          />
        </div>
      </section>
    </div>

    <!-- RIGHT ACTION DOCK -->
    <aside
      class="sf-action-dock flex h-full min-h-0 flex-col rounded-[22px] rounded-tr-[6px]"
      data-tone="ask"
      aria-label="Sale Auction Ticket"
      @mousemove="onDockPointerMove"
    >
      <div class="sf-panel-head shrink-0 px-4 pt-3.5 pb-3">
        <span class="sf-mono rounded-[4px] border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-ask)]">
          Sale Auction · {{ market }}
        </span>

        <div class="mt-2.5">
          <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Opening price
          </div>
          <div class="sf-serif mt-0.5 text-[32px] font-semibold leading-none text-[color:var(--sf-ask)]">
            {{ formatMarketAmount(openingNum, market) }}
          </div>
          <div class="sf-mono mt-1 text-[11.5px] text-[color:var(--sf-ink-2)]">
            Floor {{ formatMarketAmount(floorNum, market) }}
          </div>
        </div>
      </div>

      <div class="sf-scroll flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        <div class="grid grid-cols-2 gap-2">
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Items
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
              {{ itemCount }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Floor held
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
              {{ formatDur(floorHeldBlocks, unit) }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Oracle value
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-cobalt)]">
              {{ oracleRef != null ? formatMarketAmount(oracleRef, market) : "—" }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Refund fee
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
              {{ refundFeeText }} ERG
            </div>
          </div>
        </div>

        <!-- Basket chips summary -->
        <div v-if="itemCount > 0" class="flex flex-wrap gap-1.5">
          <span
            v-if="ergInLotNum > 0"
            class="sf-mono inline-flex items-center gap-1.5 rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[color:var(--sf-ink)]"
          >
            <market-coin market="ERG" :size="14" />
            <span>{{ formatNumber(ergInLotNum, 3, 0) }} ERG</span>
          </span>
          <span
            v-for="t in basket"
            :key="t.id"
            class="sf-mono inline-flex items-center gap-1.5 rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[color:var(--sf-ink)]"
          >
            <asset-icon :token-id="t.id" custom-class="h-3.5 w-3.5 rounded-full object-cover" />
            <span>{{ formatNumber(t.amount, Math.min(4, t.decimals), 0) }} {{ t.ticker }}</span>
          </span>
        </div>

        <!-- Checks -->
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

      <div class="shrink-0 border-t border-[color:var(--sf-line)] p-3.5">
        <button
          type="button"
          class="sf-btn-ask flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
          :disabled="!canSubmit"
          @click="openPreview"
        >
          <span>Post Sale Auction</span>
          <arrow-right-icon class="h-4 w-4" />
        </button>
      </div>
    </aside>
  </div>
</template>
