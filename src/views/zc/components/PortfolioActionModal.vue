<script setup lang="ts">
import { ArrowRightIcon, XIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import CoverMeter from "./CoverMeter.vue";
import { ExecutionPreviewPayload } from "./ExecutionPreviewModal.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { ZcDurationUnit, ZcMarket, ZcPortfolioPosition } from "@/types/zc";
import { shortenString } from "@/utils";
import {
  coverage,
  dateAtHeight,
  formatDur,
  formatMarketAmount,
  formatNumber,
  liquidationPrice,
  SIGUSD_TOKEN_ID,
  toRaw
} from "@/utils/zcMath";

const props = defineProps<{
  mode: "repay" | "addCollateral";
  position: ZcPortfolioPosition;
  height: number;
  oraclePrice: number;
  walletErg: number;
  walletSigUsd: number;
  unit: ZcDurationUnit;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "preview", payload: ExecutionPreviewPayload): void;
}>();

const bond = computed(() => props.position.bond);
const market = computed<ZcMarket>(() => bond.value.market);

// --- Repay state ---
const useCollateral = ref(false);
const ownInBond = computed(() =>
  market.value === "ERG"
    ? Math.max(0, (bond.value.collateral.erg || 0) - 0.001)
    : bond.value.collateral.usd || 0
);
const usedFromBond = computed(() =>
  useCollateral.value ? Math.min(ownInBond.value, bond.value.repayment) : 0
);
const repayDue = computed(() => Math.max(0, bond.value.repayment - usedFromBond.value));
const walletBalForMarket = computed(() =>
  market.value === "ERG" ? props.walletErg : props.walletSigUsd
);
const repayShort = computed(() => repayDue.value > walletBalForMarket.value + 1e-6);

// --- Add Collateral state (supports both SigUSD & ERG top-ups!) ---
const addAsset = ref<ZcMarket>(market.value === "ERG" ? "SigUSD" : "ERG");
const addAmountText = ref("");

const addAmountNum = computed(() => {
  const n = Number(addAmountText.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
});

const waitFrom = computed(
  () => bond.value.recollateralizeFrom ?? (bond.value.created ?? bond.value.start) + 60
);
const waitBlocks = computed(() => Math.max(0, waitFrom.value - props.height));

const coverBefore = computed(() =>
  bond.value.cov ??
  (props.oraclePrice > 0
    ? coverage(bond.value.collateral, bond.value.repayment, market.value, props.oraclePrice)
    : null)
);

const nextCollateral = computed(() => ({
  ...bond.value.collateral,
  erg: (bond.value.collateral.erg || 0) + (addAsset.value === "ERG" ? addAmountNum.value : 0),
  usd: (bond.value.collateral.usd || 0) + (addAsset.value === "SigUSD" ? addAmountNum.value : 0)
}));

const coverAfter = computed(() =>
  props.oraclePrice > 0
    ? coverage(nextCollateral.value, bond.value.repayment, market.value, props.oraclePrice)
    : null
);

const liqAfter = computed(() =>
  bond.value.rule === "oracle" && bond.value.ratio != null
    ? liquidationPrice(nextCollateral.value, bond.value.repayment, market.value, bond.value.ratio)
    : null
);

const addWalletBal = computed(() =>
  addAsset.value === "ERG" ? props.walletErg : props.walletSigUsd
);
const addShort = computed(() => addAmountNum.value > addWalletBal.value + 1e-6);

function setTargetCover(targetPct: number) {
  if (!(props.oraclePrice > 0)) return;
  const debtUsd =
    market.value === "ERG" ? bond.value.repayment * props.oraclePrice : bond.value.repayment;
  const curUsd =
    (bond.value.collateral.erg || 0) * props.oraclePrice + (bond.value.collateral.usd || 0);
  const needUsd = Math.max(0, (debtUsd * targetPct) / 100 - curUsd);
  const amt = addAsset.value === "ERG" ? needUsd / props.oraclePrice : needUsd;
  addAmountText.value = amt > 0 ? String(Number(amt.toFixed(addAsset.value === "ERG" ? 3 : 2))) : "";
}

function submit() {
  if (props.mode === "repay") {
    emit("preview", {
      title: "Repay Zero-Coupon Loan",
      subtitle: `Returns full collateral basket in the same transaction · ${market.value}`,
      badge: `Repay · ${market.value}`,
      tone: "bid",
      heroLabel: "Cash due from wallet",
      heroValue: formatMarketAmount(repayDue.value, market.value),
      heroSub: useCollateral.value
        ? `${formatMarketAmount(usedFromBond.value, market.value)} covered by collateral in bond`
        : `Total repayment ${formatMarketAmount(bond.value.repayment, market.value)}`,
      rows: [
        { label: "Bond", value: shortenString(bond.value.id, 14) },
        { label: "Total repayment", value: formatMarketAmount(bond.value.repayment, market.value) },
        ...(useCollateral.value
          ? [{ label: "From collateral", value: formatMarketAmount(usedFromBond.value, market.value), tone: "bid" as const }]
          : []),
        {
          label: "Time remaining",
          value: `${formatDur(Math.max(0, bond.value.maturity - props.height), props.unit)} (${dateAtHeight(bond.value.maturity, props.height)})`
        }
      ],
      rawSummary: {
        action: "repayBond",
        bondId: bond.value.id,
        ...(useCollateral.value ? { fromCollateral: "max" } : {})
      },
      txAction: {
        type: "repay",
        assetId: bond.value.id,
        fromCollateral: useCollateral.value ? "max" : null
      }
    });
    return;
  }

  const rawAdd = toRaw(
    addAmountText.value.trim() || addAmountNum.value,
    addAsset.value === "ERG" ? 9 : 2,
    "floor"
  );
  const rawAddBig = rawAdd ? BigInt(rawAdd) : 0n;

  emit("preview", {
    title: "Add Bond Collateral",
    subtitle: `Recollateralize ${shortenString(bond.value.id, 14)} with ${addAsset.value}`,
    badge: `Top Up · ${addAsset.value}`,
    tone: "cobalt",
    heroLabel: "Adding collateral",
    heroValue: formatMarketAmount(addAmountNum.value, addAsset.value),
    heroSub: `Cover ${coverBefore.value != null ? Math.round(coverBefore.value) : "—"}% → ${
      coverAfter.value != null ? Math.round(coverAfter.value) : "—"
    }%`,
    rows: [
      { label: "Bond", value: shortenString(bond.value.id, 14) },
      {
        label: "New liquidation",
        value:
          liqAfter.value?.dir === "never"
            ? "No liquidation price"
            : liqAfter.value?.price != null
              ? `ERG ${liqAfter.value.dir === "below" ? "≤" : "≥"} $${liqAfter.value.price.toFixed(3)}`
              : "—",
        tone: liqAfter.value?.dir === "never" ? "bid" : "default"
      }
    ],
    rawSummary: {
      action: "recollateralize",
      bondId: bond.value.id,
      asset: addAsset.value,
      amount: addAmountNum.value
    },
    txAction:
      rawAddBig > 0n
        ? addAsset.value === "ERG"
          ? { type: "recollateralize", assetId: bond.value.id, nanoErg: rawAddBig }
          : {
              type: "recollateralize",
              assetId: bond.value.id,
              tokens: [{ tokenId: SIGUSD_TOKEN_ID, amount: rawAddBig }]
            }
        : null
  });
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-md"
    role="dialog"
    aria-modal="true"
    @click.self="emit('close')"
  >
    <div
      class="sf-modal-card sf-action-dock w-full max-w-md overflow-hidden rounded-[24px] rounded-tr-[8px]"
      :data-tone="mode === 'repay' ? 'bid' : 'cobalt'"
    >
      <div class="sf-panel-head flex items-start justify-between gap-3 px-5 py-4">
        <div>
          <span
            class="sf-mono inline-block rounded-[4px] border px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em]"
            :class="
              mode === 'repay'
                ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                : 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
            "
          >
            {{ mode === "repay" ? `Repay · ${market}` : `Recollateralize · ${market}` }}
          </span>
          <h3 class="sf-display mt-1.5 text-[20px] font-bold leading-tight text-[color:var(--sf-ink)]">
            {{ mode === "repay" ? "Repay Loan" : "Add Collateral" }}
          </h3>
          <p class="sf-mono mt-0.5 text-[11px] text-[color:var(--sf-muted)]">
            Bond {{ shortenString(bond.id, 16) }} · due {{ dateAtHeight(bond.maturity, height) }}
          </p>
        </div>

        <button
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
          aria-label="Close modal"
          @click="emit('close')"
        >
          <x-icon class="h-4 w-4" />
        </button>
      </div>

      <!-- REPAY BODY -->
      <div v-if="mode === 'repay'" class="space-y-3 px-5 py-4">
        <div class="sf-dock-well rounded-xl px-4 py-3">
          <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            You pay from wallet
          </div>
          <div class="sf-serif mt-0.5 text-[30px] font-semibold leading-none text-[color:var(--sf-bid)]">
            {{ formatMarketAmount(repayDue, market) }}
          </div>
          <div class="sf-mono mt-1 text-[11px] text-[color:var(--sf-muted)]">
            Collateral returns to Nautilus in the same tx
          </div>
        </div>

        <div v-if="ownInBond > 0" class="sf-seg w-full">
          <button
            type="button"
            class="sf-seg-btn flex-1 !h-8 !text-[11.5px]"
            :class="!useCollateral ? 'is-active tone-bid' : ''"
            @click="useCollateral = false"
          >
            From wallet
          </button>
          <button
            type="button"
            class="sf-seg-btn flex-1 !h-8 !text-[11.5px]"
            :class="useCollateral ? 'is-active tone-bid' : ''"
            @click="useCollateral = true"
          >
            Use {{ formatMarketAmount(ownInBond, market) }} in bond
          </button>
        </div>

        <div class="divide-y divide-[color:var(--sf-line)] rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 text-[12px]">
          <div class="flex justify-between py-2">
            <span class="text-[color:var(--sf-muted)]">Total repayment</span>
            <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              {{ formatMarketAmount(bond.repayment, market) }}
            </span>
          </div>
          <div v-if="useCollateral" class="flex justify-between py-2">
            <span class="text-[color:var(--sf-muted)]">Covered by collateral</span>
            <span class="sf-mono font-semibold text-[color:var(--sf-bid)]">
              -{{ formatMarketAmount(usedFromBond, market) }}
            </span>
          </div>
          <div class="flex justify-between py-2">
            <span class="text-[color:var(--sf-muted)]">Wallet balance</span>
            <span
              class="sf-mono font-semibold"
              :class="repayShort ? 'text-[color:var(--sf-danger)]' : 'text-[color:var(--sf-ink)]'"
            >
              {{ formatMarketAmount(walletBalForMarket, market) }}
            </span>
          </div>
        </div>
      </div>

      <!-- ADD COLLATERAL BODY -->
      <div v-else class="space-y-3 px-5 py-4">
        <div class="flex items-center justify-between gap-2">
          <div class="sf-seg">
            <button
              v-for="a in (['SigUSD', 'ERG'] as ZcMarket[])"
              :key="a"
              type="button"
              class="sf-seg-btn !h-7 !px-3 !text-[11.5px]"
              :class="addAsset === a ? 'is-active tone-cobalt' : ''"
              @click="addAsset = a"
            >
              <market-coin :market="a" :size="14" bare />
              <span>{{ a }}</span>
            </button>
          </div>

          <div class="flex items-center gap-1">
            <button
              v-for="p in [175, 200, 250]"
              :key="p"
              type="button"
              class="sf-mono rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-cobalt)]"
              @click="setTargetCover(p)"
            >
              To {{ p }}%
            </button>
          </div>
        </div>

        <div class="sf-input-well flex h-11 items-center gap-2 rounded-xl px-3" data-tone="cobalt">
          <market-coin :market="addAsset" :size="18" />
          <input
            v-model="addAmountText"
            inputmode="decimal"
            placeholder="0.00"
            class="sf-serif w-full min-w-0 bg-transparent text-[24px] font-semibold text-[color:var(--sf-ink)] outline-none"
          />
          <span class="sf-mono text-[11.5px] font-semibold text-[color:var(--sf-muted)]">
            {{ addAsset }}
          </span>
        </div>

        <div class="divide-y divide-[color:var(--sf-line)] rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 text-[12px]">
          <div class="flex items-center justify-between py-2">
            <span class="text-[color:var(--sf-muted)]">Cover now</span>
            <cover-meter :value="coverBefore" :ratio="bond.ratio" compact />
          </div>
          <div class="flex items-center justify-between py-2">
            <span class="text-[color:var(--sf-muted)]">Cover after</span>
            <cover-meter :value="coverAfter" :ratio="bond.ratio" compact />
          </div>
          <div class="flex items-center justify-between py-2">
            <span class="text-[color:var(--sf-muted)]">Liquidates after</span>
            <span
              class="sf-mono font-semibold"
              :class="liqAfter?.dir === 'never' ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ink)]'"
            >
              {{
                liqAfter?.dir === "never"
                  ? "No liq price"
                  : liqAfter?.price != null
                    ? `ERG ${liqAfter.dir === "below" ? "≤" : "≥"} $${liqAfter.price.toFixed(3)}`
                    : "—"
              }}
            </span>
          </div>
          <div class="flex items-center justify-between py-2">
            <span class="text-[color:var(--sf-muted)]">Wallet {{ addAsset }}</span>
            <span
              class="sf-mono font-semibold"
              :class="addShort ? 'text-[color:var(--sf-danger)]' : 'text-[color:var(--sf-ink)]'"
            >
              {{ formatNumber(addWalletBal, addAsset === "ERG" ? 3 : 2, 0) }} {{ addAsset }}
            </span>
          </div>
        </div>

        <div
          v-if="waitBlocks > 0"
          class="rounded-xl border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] px-3 py-2 text-[11.5px] text-[color:var(--sf-ask)]"
        >
          Recollateralization cooldown: opens in {{ waitBlocks }} blocks (#{{ waitFrom }}).
        </div>
      </div>

      <div class="border-t border-[color:var(--sf-line)] px-5 py-3.5">
        <button
          type="button"
          class="flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px] disabled:opacity-45"
          :class="mode === 'repay' ? 'sf-btn-bid' : 'sf-btn-cobalt'"
          :disabled="mode === 'addCollateral' && (!(addAmountNum > 0) || waitBlocks > 0)"
          @click="submit"
        >
          <span>
            {{
              mode === "repay"
                ? `Preview Repay ${formatMarketAmount(repayDue, market)}`
                : waitBlocks > 0
                  ? `Opens in ${waitBlocks} blocks`
                  : `Preview Add ${formatMarketAmount(addAmountNum, addAsset)}`
            }}
          </span>
          <arrow-right-icon class="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>
</template>
