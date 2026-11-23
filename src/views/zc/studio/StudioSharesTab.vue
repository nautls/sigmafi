<script setup lang="ts">
import {
  AlertCircleIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckCircleIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, ref, watch } from "vue";
import { ExecutionPreviewPayload } from "../components/ExecutionPreviewModal.vue";
import ZcDurInput from "../components/ZcDurInput.vue";
import ZcOrderMark from "../components/ZcOrderMark.vue";
import ZcScheduleEditor, { DutchSchedule } from "../components/ZcScheduleEditor.vue";
import ZcSelect, { ZcSelectOption } from "../components/ZcSelect.vue";
import { buildFractionalizeBody } from "@/services/zcApi";
import { useWalletStore, useZcStore } from "@/stories";
import { ZcPortfolioPosition } from "@/types/zc";
import { shortenString } from "@/utils";
import { DAY_BLOCKS, formatDur, formatMarketAmount, formatNumber } from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    initialTokenId?: string | null;
  }>(),
  {
    initialTokenId: null
  }
);

const emit = defineEmits<{
  (e: "preview", payload: ExecutionPreviewPayload): void;
}>();

const zc = useZcStore();
const wallet = useWalletStore();

const height = computed(() => zc.height);
const unit = computed(() => zc.durationUnit);

const splittableUnits = computed<ZcPortfolioPosition[]>(() =>
  zc.portfolio.positions.filter(
    (p) =>
      p.side === "lend" &&
      p.kind === "unit" &&
      (p.status === "live" || p.status === "active") &&
      p.bond.maturity > height.value
  )
);

const selectedId = ref(props.initialTokenId || "");

watch(
  [splittableUnits, () => props.initialTokenId],
  ([list, init]) => {
    if (init && list.some((p) => (p.tokenId || p.id) === init)) {
      selectedId.value = init;
      return;
    }
    if (!selectedId.value || !list.some((p) => (p.tokenId || p.id) === selectedId.value)) {
      selectedId.value = list[0]?.tokenId || list[0]?.id || "";
    }
  },
  { immediate: true }
);

const position = computed<ZcPortfolioPosition | null>(
  () => splittableUnits.value.find((p) => (p.tokenId || p.id) === selectedId.value) || null
);

const options = computed<ZcSelectOption[]>(() =>
  splittableUnits.value.map((p) => ({
    value: p.tokenId || p.id,
    label: `${formatMarketAmount(p.bond.repayment, p.bond.market)} · ${formatDur(
      Math.max(0, p.bond.maturity - height.value),
      unit.value
    )}`
  }))
);

const vault = ref<"selective" | "dutch">("selective");
const openingPctText = ref("200");
const floorPctText = ref("90");
const fallsDays = ref<number | null>(1);
const heldDays = ref<number | null>(3);
const yMode = ref<"pct" | "abs">("pct");

const openingPct = computed(() => {
  const n = Number(openingPctText.value);
  return Number.isFinite(n) ? Math.max(10, Math.min(500, n)) : 200;
});

const floorPct = computed(() => {
  const n = Number(floorPctText.value);
  return Number.isFinite(n) ? Math.max(5, Math.min(openingPct.value, n)) : 90;
});

const lengthBlocks = computed(() => Math.max(30, Math.round((fallsDays.value || 1) * DAY_BLOCKS)));
const expiryBlocks = computed(() =>
  Math.max(lengthBlocks.value + 30, Math.round((heldDays.value || 3) * DAY_BLOCKS))
);

const rep = computed(() => position.value?.bond.repayment || 100);
const posMarket = computed(() => position.value?.bond.market || zc.activeMarket);

const sched = computed<DutchSchedule>(() => {
  const scale = yMode.value === "pct" ? 1 : rep.value / 100;
  return {
    start: height.value,
    opening: openingPct.value * scale,
    end: height.value + lengthBlocks.value,
    floor: floorPct.value * scale,
    expiry: height.value + expiryBlocks.value
  };
});

function onSchedUpdate(next: DutchSchedule) {
  const scale = yMode.value === "pct" ? 1 : rep.value / 100;
  openingPctText.value = String(Number((next.opening / scale).toFixed(1)));
  floorPctText.value = String(Number((next.floor / scale).toFixed(1)));
  fallsDays.value = Number(((next.end - next.start) / DAY_BLOCKS).toFixed(2));
  heldDays.value = Number(((next.expiry - next.start) / DAY_BLOCKS).toFixed(2));
}

const matchingOfferCount = computed(() => {
  const list = zc.markets[posMarket.value].offers || [];
  return list.filter(
    (o) =>
      o.ok &&
      o.shares != null &&
      floorPct.value * 100 >= o.shares.floor &&
      expiryBlocks.value <= o.shares.expiry
  ).length;
});

const checks = computed(() => [
  { label: position.value ? "Whole bond unit selected" : "Select a live bond unit", ok: !!position.value },
  {
    label: openingPct.value >= floorPct.value ? `Default auction ${openingPct.value}% → ${floorPct.value}%` : "Opening must be ≥ floor",
    ok: openingPct.value >= floorPct.value
  }
]);

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

function openPreview() {
  if (!position.value) return;
  const body = buildFractionalizeBody({
    vault: vault.value,
    opening: openingPct.value,
    floor: floorPct.value,
    length: lengthBlocks.value,
    expiry: expiryBlocks.value
  });

  emit("preview", {
    title: "Split Bond into 100 Shares",
    subtitle: `${vault.value === "selective" ? "Selective" : "Dutch"} liquidation vault · ${posMarket.value}`,
    badge: `Split · ${posMarket.value}`,
    tone: "cobalt",
    heroLabel: "Shares minted",
    heroValue: "100.00 shares",
    heroSub: `1 share = ${formatMarketAmount(rep.value / 100, posMarket.value)} at maturity`,
    rows: [
      { label: "Bond", value: shortenString(position.value.bond.id, 14) },
      { label: "Vault type", value: vault.value === "selective" ? "Selective shares" : "Dutch shares" },
      { label: "Auction range", value: `${openingPct.value}% → ${floorPct.value}% of repayment` },
      { label: "Falls / Held", value: `${formatDur(lengthBlocks.value, unit.value)} / ${formatDur(expiryBlocks.value, unit.value)}` },
      { label: "Mint / Pull fees", value: "0.005 / 0.005 ERG" },
      {
        label: "Offers accepting",
        value: matchingOfferCount.value > 0 ? `${matchingOfferCount.value} live offers` : "None currently",
        tone: matchingOfferCount.value > 0 ? "bid" : "default"
      }
    ],
    rawSummary: { action: "fractionalize", bondId: position.value.bond.id, ...body }
  });
}
</script>

<template>
  <!-- Empty State -->
  <div
    v-if="!position"
    class="sf-terminal-plate flex flex-1 flex-col items-center justify-center rounded-[22px] p-8 text-center"
  >
    <zc-order-mark kind="shares" :size="48" />
    <h2 class="sf-display mt-3 text-[19px] font-bold text-[color:var(--sf-ink)]">
      {{ wallet.connected ? "No whole bond units to split" : "Connect Nautilus to split bonds" }}
    </h2>
    <p class="mt-1.5 max-w-md text-[13px] text-[color:var(--sf-muted)]">
      {{
        wallet.connected
          ? "Splitting requires holding an un-fractionalized live zero-coupon bond unit in your wallet."
          : "Connect Nautilus to inspect your whole zero-coupon bond units and split them into 100 tradable shares."
      }}
    </p>
    <div class="mt-5 flex items-center gap-2.5">
      <button
        v-if="!wallet.connected"
        type="button"
        class="sf-btn-cobalt h-10 rounded-full px-6 text-[13.5px]"
        @click="wallet.connect('nautilus')"
      >
        Connect Nautilus
      </button>
      <router-link
        to="/app"
        class="sf-btn-outline inline-flex h-10 items-center gap-1.5 rounded-full px-5 text-[13px]"
      >
        <span>Browse Yield Curve</span>
        <arrow-up-right-icon class="h-3.5 w-3.5" />
      </router-link>
    </div>
  </div>

  <!-- Active Split Workbench -->
  <div v-else class="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_348px]">
    <!-- LEFT WORKBENCH -->
    <div class="flex min-h-0 flex-col gap-2.5">
      <section class="sf-terminal-plate shrink-0 rounded-[18px] rounded-tl-[6px] p-3">
        <!-- Bond Unit Picker + Vault Selector -->
        <div class="flex flex-wrap items-center justify-between gap-2.5 pb-2.5">
          <div class="flex min-w-0 flex-1 items-center gap-2.5">
            <zc-order-mark kind="unit" :size="28" />
            <div class="min-w-[220px] max-w-[360px] flex-1">
              <zc-select v-model="selectedId" :options="options" size="sm" aria-label="Bond unit to split" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              class="rounded-xl border px-3 py-1.5 text-left transition-all"
              :class="
                vault === 'selective'
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] hover:border-[color:var(--sf-line-strong)]'
              "
              @click="vault = 'selective'"
            >
              <div class="text-[11.5px] font-bold text-[color:var(--sf-ink)]">Selective</div>
              <div class="sf-mono text-[9.5px] text-[color:var(--sf-muted)]">Pick collateral items</div>
            </button>
            <button
              type="button"
              class="rounded-xl border px-3 py-1.5 text-left transition-all"
              :class="
                vault === 'dutch'
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] hover:border-[color:var(--sf-line-strong)]'
              "
              @click="vault = 'dutch'"
            >
              <div class="text-[11.5px] font-bold text-[color:var(--sf-ink)]">Dutch</div>
              <div class="sf-mono text-[9.5px] text-[color:var(--sf-muted)]">Whole basket clears</div>
            </button>
          </div>
        </div>

        <!-- Default Auction Parameters -->
        <div class="grid grid-cols-2 gap-2 border-t border-[color:var(--sf-line)] pt-2.5 sm:grid-cols-4">
          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Opening %
            </label>
            <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2.5" data-tone="cobalt">
              <input v-model="openingPctText" inputmode="decimal" class="sf-mono w-full bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] outline-none" />
              <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">%</span>
            </div>
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Floor %
            </label>
            <div class="sf-input-well flex h-9 items-center gap-1 rounded-xl px-2.5" data-tone="cobalt">
              <input v-model="floorPctText" inputmode="decimal" class="sf-mono w-full bg-transparent text-[13px] font-semibold text-[color:var(--sf-ink)] outline-none" />
              <span class="sf-mono text-[10px] text-[color:var(--sf-muted)]">%</span>
            </div>
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Falls over
            </label>
            <zc-dur-input v-model="fallsDays" :unit="unit" of="days" tone="cobalt" />
          </div>

          <div>
            <label class="sf-mono mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Held until
            </label>
            <zc-dur-input v-model="heldDays" :unit="unit" of="days" tone="cobalt" />
          </div>
        </div>
      </section>

      <!-- Default Recovery Schedule Chart -->
      <section class="sf-terminal-plate flex min-h-[270px] flex-1 flex-col rounded-[20px] rounded-bl-[6px] p-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            Default Liquidation Auction Schedule
          </span>

          <div class="sf-seg">
            <button
              type="button"
              class="sf-seg-btn !h-6 !px-2 !text-[10.5px]"
              :class="yMode === 'pct' ? 'is-active tone-cobalt' : ''"
              @click="yMode = 'pct'"
            >
              % Repayment
            </button>
            <button
              type="button"
              class="sf-seg-btn !h-6 !px-2 !text-[10.5px]"
              :class="yMode === 'abs' ? 'is-active tone-cobalt' : ''"
              @click="yMode = 'abs'"
            >
              {{ posMarket }}
            </button>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col">
          <zc-schedule-editor
            :sched="sched"
            :height="height"
            :unit-label="yMode === 'pct' ? '%' : posMarket"
            :duration-unit="unit"
            color="var(--sf-cobalt)"
            lock-start
            :y-format="(v) => (yMode === 'pct' ? `${formatNumber(v, 1, 0)}%` : formatNumber(v, 2, 0))"
            fill-height
            @update:sched="onSchedUpdate"
          />
        </div>
      </section>
    </div>

    <!-- RIGHT ACTION DOCK -->
    <aside
      class="sf-action-dock flex h-full min-h-0 flex-col rounded-[22px] rounded-tr-[6px]"
      data-tone="cobalt"
      aria-label="Split Bond Ticket"
      @mousemove="onDockPointerMove"
    >
      <div class="sf-panel-head shrink-0 px-4 pt-3.5 pb-3">
        <span class="sf-mono rounded-[4px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-cobalt)]">
          Fractionalize · {{ posMarket }}
        </span>

        <div class="mt-2.5">
          <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Minted output
          </div>
          <div class="sf-serif mt-0.5 text-[32px] font-semibold leading-none text-[color:var(--sf-ink)]">
            100 shares
          </div>
          <div class="sf-mono mt-1 text-[11.5px] text-[color:var(--sf-ink-2)]">
            {{ formatMarketAmount(rep / 100, posMarket) }} face / share
          </div>
        </div>
      </div>

      <div class="sf-scroll flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        <div class="grid grid-cols-2 gap-2">
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Vault
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold capitalize text-[color:var(--sf-ink)]">
              {{ vault }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Auction
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-cobalt)]">
              {{ openingPct }}% → {{ floorPct }}%
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Fees
            </div>
            <div class="sf-mono mt-0.5 text-[13px] font-bold text-[color:var(--sf-ink)]">
              0.01 ERG
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Offers buy it
            </div>
            <div
              class="sf-mono mt-0.5 text-[13px] font-bold"
              :class="matchingOfferCount > 0 ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-muted)]'"
            >
              {{ matchingOfferCount }}
            </div>
          </div>
        </div>

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
          class="sf-btn-cobalt flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px]"
          @click="openPreview"
        >
          <span>Split into 100 Shares</span>
          <arrow-right-icon class="h-4 w-4" />
        </button>
      </div>
    </aside>
  </div>
</template>
