<script setup lang="ts">
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  ShieldIcon,
  XIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, ref, watch } from "vue";
import CoverMeter from "./CoverMeter.vue";
import { ExecutionPreviewPayload } from "./ExecutionPreviewModal.vue";
import ZcAssetChip from "./ZcAssetChip.vue";
import { ZcAskSummary, ZcCurves, ZcDurationUnit } from "@/types/zc";
import { shortenString } from "@/utils";
import {
  askQuote,
  coverage,
  dateAtHeight,
  DAY_BLOCKS,
  formatApr,
  formatCompact,
  formatDur,
  formatDurLong,
  formatMarketAmount,
  formatNumber,
  GRID_BLOCKS,
  isOracleRefreshingOnly,
  kindLabel,
  lineAt,
  liquidationPrice,
  pricingName,
  resolvedAskQuote,
  shareTotalOf
} from "@/utils/zcMath";

const props = defineProps<{
  ask: ZcAskSummary;
  curves: ZcCurves | null;
  height: number;
  oraclePrice: number;
  oracleAge: number;
  unit: ZcDurationUnit;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "preview", payload: ExecutionPreviewPayload): void;
}>();

const tab = ref<"quote" | "path" | "risk">("quote");
const shockPct = ref(0);
const copied = ref(false);
const windowPickBlocks = ref<number | null>(null);
const sharesPct = ref<number>(100);
const pathHoverIdx = ref<number | null>(null);

function resetForAsk() {
  tab.value = "quote";
  shockPct.value = 0;
  windowPickBlocks.value = null;
  sharesPct.value = props.ask.kind === "shares" ? (props.ask.units / shareTotalOf(props.ask)) * 100 : 100;
  pathHoverIdx.value = null;
}

watch(() => props.ask.id, resetForAsk, { immediate: true });

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

const isWindow = computed(() => props.ask.pricing === "window" && !!props.ask.window);
const isShares = computed(() => props.ask.kind === "shares");
const isBuyback = computed(() => !!props.ask.borrowedByMe && props.ask.kind !== "order" && !props.ask.owner);

const askShareTotal = computed(() => shareTotalOf(props.ask));

const maxSharesPct = computed(() =>
  isShares.value ? Math.max(0.01, (props.ask.units / askShareTotal.value) * 100) : 100
);
const minSharesPct = computed(() =>
  isShares.value ? Math.max(0.01, ((props.ask.minFill || 1) / askShareTotal.value) * 100) : 100
);
const selectedShareUnits = computed(() => {
  if (!isShares.value) return 1;
  return Math.round(
    Math.min(
      props.ask.units,
      Math.max(props.ask.minFill || 1, (sharesPct.value / 100) * askShareTotal.value)
    )
  );
});
const shareFrac = computed(() =>
  isShares.value && props.ask.units > 0 ? selectedShareUnits.value / props.ask.units : 1
);

const baseQuote = computed(() =>
  resolvedAskQuote(props.ask, props.height, isWindow.value ? windowPickBlocks.value : null)
);

const activeQuote = computed(() => {
  const q = baseQuote.value;
  if (!q) return null;
  if (!isShares.value || shareFrac.value === 1) return q;
  return {
    ...q,
    cost: q.cost * shareFrac.value,
    face: q.face * shareFrac.value
  };
});

const currentWindowBlocks = computed(() => {
  if (!props.ask.window) return 0;
  return windowPickBlocks.value ?? baseQuote.value?.d ?? props.ask.window.min;
});

const isWindowGrid = computed(() => {
  if (!isWindow.value || !props.height) return false;
  return (props.height + currentWindowBlocks.value) % GRID_BLOCKS === 0;
});

const collateral = computed(() => props.ask.bond?.collateral || props.ask.collateral);
const repayment = computed(
  () => props.ask.bond?.repayment ?? props.ask.repayment ?? baseQuote.value?.face ?? 0
);
const rule = computed(() => props.ask.bond?.rule || props.ask.rule);
const ratio = computed(() => props.ask.bond?.ratio ?? props.ask.ratio);
const maxOracleAge = computed(() => props.ask.bond?.oracleAge ?? props.ask.oracleAge ?? 60);
const cov = computed(() => {
  if (props.ask.cov != null) return props.ask.cov;
  if (rule.value === "oracle" && props.oraclePrice > 0 && repayment.value > 0) {
    return coverage(collateral.value, repayment.value, props.ask.market, props.oraclePrice);
  }
  return null;
});

const refreshing = computed(() => isOracleRefreshingOnly(props.ask));
const usable = computed(() => props.ask.ok || refreshing.value);

const liqInfo = computed(() =>
  rule.value === "oracle" && ratio.value != null && repayment.value > 0
    ? liquidationPrice(collateral.value, repayment.value, props.ask.market, ratio.value)
    : null
);

const liqDistancePct = computed(() => {
  if (!liqInfo.value?.price || !props.oraclePrice) return null;
  return Math.abs(props.oraclePrice / liqInfo.value.price - 1) * 100;
});

const shockedCover = computed(() => {
  if (rule.value !== "oracle" || !(props.oraclePrice > 0) || !(repayment.value > 0)) return null;
  return coverage(
    collateral.value,
    repayment.value,
    props.ask.market,
    props.oraclePrice * (1 + shockPct.value / 100)
  );
});

const termReturnPct = computed(() => {
  const q = activeQuote.value;
  if (!q || !(q.cost > 0)) return null;
  return (q.face / q.cost - 1) * 100;
});

const recoveryLabel = computed(() => {
  const v = props.ask.bond?.vault;
  if (v === "selective") return "Selective shares vault";
  if (v) return "Dutch auction vault";
  return "Collateral in kind";
});

/* Interactive APR Path Chart (Window curve OR fill-later trajectory vs Best Bid) */
const pathData = computed(() => {
  const h = props.height;
  const bidLine = props.curves?.bidLine || [];
  const W = 286;
  const H = 148;
  const PAD = { l: 34, r: 10, t: 10, b: 22 };

  const mine: { x: number; y: number | null; raw: number }[] = [];
  const bid: { x: number; y: number | null }[] = [];

  if (isWindow.value && props.ask.window) {
    const { min, max } = props.ask.window;
    const steps = 36;
    for (let i = 0; i <= steps; i++) {
      const d = min + ((max - min) * i) / steps;
      const q = askQuote(props.ask, h, d);
      const b = lineAt(bidLine, d);
      mine.push({ x: d / DAY_BLOCKS, y: q ? q.yieldBps / 100 : null, raw: d });
      bid.push({ x: d / DAY_BLOCKS, y: b != null ? b / 100 : null });
    }
  } else {
    const matAt = (at: number) =>
      props.ask.kind === "order"
        ? props.ask.mode === "term"
          ? at + (props.ask.duration || DAY_BLOCKS)
          : props.ask.maturity
        : props.ask.bond?.maturity ?? props.ask.quote?.maturity;
    const end = Math.max(
      h + 30,
      Math.min((props.ask.expiry || h + 5040) - 1, (matAt(h) || h + 5040) - 4)
    );
    const steps = 36;
    for (let i = 0; i <= steps; i++) {
      const at = h + ((end - h) * i) / steps;
      const q = askQuote(props.ask, at);
      const rem = (matAt(at) || at) - at;
      const b = lineAt(bidLine, rem);
      mine.push({ x: (at - h) / DAY_BLOCKS, y: q ? q.yieldBps / 100 : null, raw: at });
      bid.push({ x: (at - h) / DAY_BLOCKS, y: b != null ? b / 100 : null });
    }
  }

  const allY = [...mine, ...bid]
    .map((p) => p.y)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const yMax = Math.max(8, ...(allY.length ? allY : [10])) * 1.18;
  const xMin = mine[0]?.x ?? 0;
  const xMax = Math.max(xMin + 0.5, mine[mine.length - 1]?.x ?? 1);

  const sx = (v: number) => PAD.l + ((v - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
  const sy = (v: number) => PAD.t + (1 - Math.min(yMax, Math.max(0, v)) / yMax) * (H - PAD.t - PAD.b);

  const mkPath = (pts: { x: number; y: number | null }[]) => {
    let d = "";
    let open = false;
    for (const p of pts) {
      if (p.y == null) {
        open = false;
        continue;
      }
      d += `${open ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
      open = true;
    }
    return d;
  };

  // Shaded clear zone where ask >= best bid
  let clearArea = "";
  let run: { x: number; hi: number; lo: number }[] = [];
  const flush = () => {
    if (run.length > 1) {
      clearArea +=
        `M${run.map((p) => `${sx(p.x).toFixed(1)},${sy(p.hi).toFixed(1)}`).join("L")}` +
        `L${run
          .slice()
          .reverse()
          .map((p) => `${sx(p.x).toFixed(1)},${sy(p.lo).toFixed(1)}`)
          .join("L")}Z `;
    }
    run = [];
  };
  for (let i = 0; i < mine.length; i++) {
    const m = mine[i];
    const b = bid[i];
    if (m.y != null && b?.y != null && m.y >= b.y) {
      run.push({ x: m.x, hi: m.y, lo: b.y });
    } else {
      flush();
    }
  }
  flush();

  const crossIdx = mine.findIndex(
    (p, idx) => p.y != null && bid[idx]?.y != null && p.y >= (bid[idx].y as number)
  );
  const cross = crossIdx >= 0 ? mine[crossIdx] : null;

  return {
    W,
    H,
    PAD,
    yMax,
    xMin,
    xMax,
    sx,
    sy,
    mine,
    bid,
    minePath: mkPath(mine),
    bidPath: mkPath(bid),
    clearArea,
    cross
  };
});

const pathHover = computed(() => {
  const idx = pathHoverIdx.value;
  if (idx == null) return null;
  const d = pathData.value;
  const m = d.mine[idx];
  const b = d.bid[idx];
  if (!m) return null;
  return {
    px: d.sx(m.x),
    xDays: m.x,
    askY: m.y,
    bidY: b?.y ?? null
  };
});

function onPathMove(e: PointerEvent) {
  const el = e.currentTarget as SVGSVGElement;
  const r = el.getBoundingClientRect();
  const d = pathData.value;
  const X = ((e.clientX - r.left) / (r.width || 1)) * d.W;
  if (X < d.PAD.l || X > d.W - d.PAD.r) {
    pathHoverIdx.value = null;
    return;
  }
  const frac = (X - d.PAD.l) / (d.W - d.PAD.l - d.PAD.r);
  const idx = Math.round(frac * (d.mine.length - 1));
  pathHoverIdx.value = Math.max(0, Math.min(d.mine.length - 1, idx));
}

async function copyId() {
  try {
    await navigator.clipboard.writeText(props.ask.id);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // ignore
  }
}

function openPreview() {
  const q = activeQuote.value;
  if (!q) return;
  const m = props.ask.market;
  emit("preview", {
    title:
      props.ask.kind === "order"
        ? `Fund ${m} Borrow Order`
        : isBuyback.value
          ? `Buy Back Your ${props.ask.kind === "shares" ? "Shares" : "Bond"}`
          : `Buy ${kindLabel(props.ask.kind)} (${m})`,
    subtitle: `${pricingName(props.ask)} · ${shortenString(props.ask.id, 14)}`,
    badge:
      props.ask.kind === "order"
        ? "Direct Lend"
        : isBuyback.value
          ? "Loan Buyback"
          : "Secondary Buy",
    tone: "bid",
    heroLabel: props.ask.kind === "order" ? "You fund now" : "You pay now",
    heroValue: formatMarketAmount(q.cost, m),
    heroSub: `${formatApr(q.yieldBps)} APR · ${q.pct.toFixed(2)}% of face`,
    rows: [
      { label: "Claim at maturity", value: formatMarketAmount(q.face, m) },
      { label: "Gross interest", value: `+${formatMarketAmount(q.face - q.cost, m)}`, tone: "bid" },
      {
        label: "Maturity",
        value: `${dateAtHeight(props.height + q.d, props.height)} · ${formatDur(q.d, props.unit)}`
      },
      ...(isShares.value
        ? [
            {
              label: "Share lot",
              value: `${formatNumber((selectedShareUnits.value / askShareTotal.value) * 100, 2, 0)} / 100 shares`
            }
          ]
        : []),
      {
        label: "Collateral cover",
        value:
          rule.value === "oracle"
            ? `${cov.value != null ? Math.round(cov.value) : "—"}% (liq. < ${ratio.value ?? "—"}%)`
            : "Maturity rule"
      },
      ...(props.ask.kind === "order"
        ? [{ label: "Fee reserve", value: "0.05 ERG (returned)" }]
        : [])
    ],
    rawSummary: {
      action: props.ask.kind === "order" ? "fillOrder" : "buyAsk",
      boxId: props.ask.id,
      market: m,
      units: isShares.value ? String(selectedShareUnits.value) : "1",
      cost: q.cost,
      face: q.face,
      yieldBps: Math.round(q.yieldBps),
      blocksLeft: q.d,
      maturity: q.maturity
    },
    txAction:
      props.ask.kind === "order"
        ? {
            type: "fillOrder",
            boxId: props.ask.id,
            maturity: isWindow.value ? BigInt(q.maturity) : null
          }
        : {
            type: "buyAsk",
            boxId: props.ask.id,
            units: isShares.value ? BigInt(selectedShareUnits.value) : null
          }
  });
}

function openCancelPreview() {
  const a = props.ask;
  const label =
    a.kind === "order"
      ? "Borrow Order"
      : a.kind === "shares"
        ? "Share Resale Ask"
        : "Bond Resale Ask";
  emit("preview", {
    title: `Cancel & Refund ${label}`,
    subtitle: "Returns everything locked in this open listing to your Nautilus wallet",
    badge: `Cancel · ${a.market}`,
    tone: "ask",
    heroLabel: "Box ID",
    heroValue: shortenString(a.boxId, 14),
    heroSub: `${a.market} · ${pricingName(a)}`,
    rows: [
      { label: "Listing", value: label },
      { label: "Action", value: "Cancel and refund to wallet" }
    ],
    rawSummary: { action: "cancelBox", boxId: a.boxId },
    txAction: { type: "cancel", boxId: a.boxId }
  });
}
</script>

<template>
  <aside
    class="sf-action-dock flex h-full min-h-0 flex-col rounded-[22px] rounded-tr-[6px]"
    :data-tone="usable && !ask.owner ? 'bid' : 'ask'"
    aria-label="Ask Inspector"
    @mousemove="onDockPointerMove"
  >
    <!-- Header -->
    <div class="sf-panel-head shrink-0 px-4 pt-3.5 pb-3">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="sf-mono rounded-[4px] border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-ask)]"
            >
              {{ kindLabel(ask.kind) }} · {{ ask.market }}
            </span>
            <span
              v-if="isBuyback"
              class="sf-mono rounded-[4px] bg-[color:var(--sf-bid-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[color:var(--sf-bid)]"
            >
              Your loan
            </span>
            <span
              class="sf-mono rounded-[4px] px-1.5 py-0.5 text-[9.5px] font-semibold"
              :class="
                ask.owner
                  ? 'bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                  : ask.ok
                    ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                    : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
              "
            >
              {{ ask.pending ? "Pending" : ask.owner ? "Yours" : ask.ok ? "Tradable" : ask.reason }}
            </span>
          </div>

          <div class="mt-1.5 flex items-center gap-1.5">
            <span class="truncate text-[12px] font-medium text-[color:var(--sf-ink)]">
              {{ pricingName(ask) }}
            </span>
            <button
              type="button"
              class="sf-mono inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[10px] text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
              :title="`Copy ${ask.id}`"
              @click="copyId"
            >
              <span>{{ shortenString(ask.id, 10) }}</span>
              <check-icon v-if="copied" class="h-3 w-3 text-[color:var(--sf-bid)]" />
              <copy-icon v-else class="h-3 w-3 opacity-70" />
            </button>
          </div>
        </div>

        <button
          type="button"
          class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[color:var(--sf-muted)] transition-all hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)] active:scale-90"
          aria-label="Close inspector"
          title="Back to ticket (Esc)"
          @click="emit('close')"
        >
          <x-icon class="h-4 w-4" />
        </button>
      </div>

      <!-- Inspector Sub-Tabs -->
      <div class="sf-seg mt-2.5 grid w-full grid-cols-3 text-[11px]">
        <button
          v-for="t in (['quote', 'path', 'risk'] as const)"
          :key="t"
          type="button"
          class="sf-seg-btn relative py-1 capitalize"
          :class="tab === t ? 'is-active tone-cobalt' : ''"
          @click="tab = t"
        >
          <span>{{ t === "path" ? "APR Path" : t }}</span>
          <span
            v-if="t === 'risk' && !ask.ok"
            class="h-1.5 w-1.5 rounded-full bg-[color:var(--sf-ask)]"
          />
        </button>
      </div>
    </div>

    <!-- Scrollable Body -->
    <div class="sf-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <!-- TAB 1: QUOTE -->
      <div v-if="tab === 'quote'" class="space-y-3">
        <div
          class="grid grid-cols-2 divide-x divide-[color:var(--sf-line)] rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)]"
        >
          <div class="p-2.5">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              {{ isWindow && windowPickBlocks == null ? "Best APR" : "APR" }}
            </div>
            <div class="sf-serif mt-0.5 text-[24px] font-semibold leading-none text-[color:var(--sf-bid)]">
              {{ formatApr(activeQuote?.yieldBps) }}
            </div>
            <div class="sf-mono mt-1 text-[10px] text-[color:var(--sf-dim)]">
              {{ termReturnPct != null ? `${termReturnPct.toFixed(2)}% term` : "—" }}
            </div>
          </div>

          <div class="p-2.5">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              {{ ask.kind === "order" ? "Fund" : "Pay" }}
            </div>
            <div class="sf-mono mt-0.5 text-[18px] font-semibold leading-tight text-[color:var(--sf-ink)]">
              {{ activeQuote ? formatCompact(activeQuote.cost) : "—" }}
              <span class="text-[11px] font-medium text-[color:var(--sf-muted)]">{{ ask.market }}</span>
            </div>
            <div class="sf-mono mt-0.5 text-[10px] text-[color:var(--sf-dim)]">
              {{ activeQuote ? `${activeQuote.pct.toFixed(2)}% par` : "" }}
            </div>
          </div>
        </div>

        <!-- Window Maturity Slider -->
        <div
          v-if="isWindow && ask.window"
          class="rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/45 p-2.5"
        >
          <div class="sf-mono flex items-center justify-between text-[10.5px]">
            <span class="font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-cobalt)]">
              Maturity
            </span>
            <span class="font-semibold text-[color:var(--sf-ink)]">
              {{ formatDur(currentWindowBlocks, unit)
              }}<span v-if="isWindowGrid" class="ml-1 text-[color:var(--sf-cobalt)]">· grid</span>
            </span>
          </div>
          <input
            type="range"
            :min="ask.window.min"
            :max="ask.window.max"
            :step="DAY_BLOCKS"
            :value="currentWindowBlocks"
            aria-label="Pick window order maturity"
            class="sf-range mt-2"
            @input="windowPickBlocks = Number(($event.target as HTMLInputElement).value)"
          />
          <div class="sf-mono mt-1 flex justify-between text-[9.5px] text-[color:var(--sf-muted)]">
            <span>{{ formatDur(ask.window.min, unit) }}</span>
            <span>{{ formatDur(ask.window.max, unit) }}</span>
          </div>
        </div>

        <!-- Share Lot Partial Selector -->
        <div
          v-if="isShares && maxSharesPct > minSharesPct"
          class="rounded-xl border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)]/40 p-2.5"
        >
          <div class="sf-mono flex items-center justify-between text-[10.5px]">
            <span class="font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-bid)]">
              Shares
            </span>
            <span class="font-semibold text-[color:var(--sf-ink)]">
              {{ formatNumber(sharesPct, 2, 0) }} / {{ formatNumber(maxSharesPct, 2, 0) }}
            </span>
          </div>
          <input
            v-model.number="sharesPct"
            type="range"
            :min="minSharesPct"
            :max="maxSharesPct"
            step="0.5"
            aria-label="Select share quantity"
            class="sf-range mt-2"
          />
        </div>

        <!-- Compact Terms -->
        <dl class="divide-y divide-[color:var(--sf-line)] text-[11.5px]">
          <div class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Claim</dt>
            <dd class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              {{ activeQuote ? formatMarketAmount(activeQuote.face, ask.market) : "—" }}
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Gross gain</dt>
            <dd class="sf-mono font-semibold text-[color:var(--sf-bid)]">
              {{
                activeQuote
                  ? `+${formatMarketAmount(activeQuote.face - activeQuote.cost, ask.market)}`
                  : "—"
              }}
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Matures</dt>
            <dd class="sf-mono text-right font-medium text-[color:var(--sf-ink)]">
              <template v-if="isWindow && ask.window && windowPickBlocks == null">
                {{ formatDur(ask.window.min, unit) }}–{{ formatDur(ask.window.max, unit) }}
              </template>
              <template v-else-if="ask.kind === 'order' && ask.mode === 'term'">
                {{ formatDur(ask.duration, unit) }} from fill
              </template>
              <template v-else-if="activeQuote">
                {{ dateAtHeight(height + activeQuote.d, height) }} · {{ formatDur(activeQuote.d, unit) }}
              </template>
              <template v-else>—</template>
            </dd>
          </div>
          <div v-if="isShares" class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Available</dt>
            <dd class="sf-mono font-medium text-[color:var(--sf-ink)]">
              {{ formatNumber(maxSharesPct, 2, 0) }} / 100 sh
            </dd>
          </div>
          <div v-if="ask.kind === 'order'" class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Fee reserve</dt>
            <dd class="sf-mono text-[color:var(--sf-ink-2)]">0.05 ERG · returned</dd>
          </div>
        </dl>

        <!-- Safety Shortcut -->
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-3 py-2 text-left text-[11px] transition-all hover:border-[color:var(--sf-line-cobalt)]"
          @click="tab = 'risk'"
        >
          <span class="flex items-center gap-2 text-[color:var(--sf-ink-2)]">
            <shield-icon class="h-3.5 w-3.5 shrink-0 text-[color:var(--sf-cobalt)]" />
            <span>
              {{
                rule === "oracle"
                  ? `${cov != null ? Math.round(cov) : "—"}% cover · liq < ${ratio ?? "—"}%`
                  : "Maturity rule"
              }}
            </span>
          </span>
          <span
            class="sf-mono shrink-0 text-[10px] font-semibold"
            :class="ask.ok ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ask)]'"
          >
            {{ !ask.ok ? "Paused" : ask.guard ? "Guarded" : "Risk →" }}
          </span>
        </button>
      </div>

      <!-- TAB 2: INTERACTIVE APR PATH -->
      <div v-else-if="tab === 'path'" class="space-y-2.5">
        <div
          class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] p-2.5"
        >
          <div class="sf-mono mb-1 flex items-center justify-between text-[10px]">
            <span class="uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              {{ isWindow ? "Curve by term" : "Fill-later trajectory" }}
            </span>
            <span v-if="pathHover" class="font-semibold text-[color:var(--sf-ink)]">
              <span class="text-[color:var(--sf-ask)]">
                {{ pathHover.askY != null ? `${pathHover.askY.toFixed(2)}%` : "—" }}
              </span>
              <span class="mx-1 text-[color:var(--sf-dim)]">/</span>
              <span class="text-[color:var(--sf-bid)]">
                {{ pathHover.bidY != null ? `${pathHover.bidY.toFixed(2)}%` : "—" }}
              </span>
            </span>
          </div>

          <svg
            :viewBox="`0 0 ${pathData.W} ${pathData.H}`"
            class="h-[144px] w-full cursor-crosshair select-none"
            role="img"
            :aria-label="isWindow ? 'Window APR curve' : 'APR if filled later'"
            @pointermove="onPathMove"
            @pointerleave="pathHoverIdx = null"
          >
            <g v-for="frac in [0, 0.5, 1]" :key="frac">
              <line
                :x1="pathData.PAD.l"
                :x2="pathData.W - pathData.PAD.r"
                :y1="pathData.sy(pathData.yMax * frac)"
                :y2="pathData.sy(pathData.yMax * frac)"
                stroke="var(--sf-line)"
                :stroke-dasharray="frac === 0 ? undefined : '2 3'"
              />
              <text
                :x="pathData.PAD.l - 5"
                :y="pathData.sy(pathData.yMax * frac) + 3"
                text-anchor="end"
                fill="var(--sf-muted)"
                font-size="9"
                class="sf-mono"
              >
                {{ (pathData.yMax * frac).toFixed(0) }}%
              </text>
            </g>

            <text
              :x="pathData.PAD.l"
              :y="pathData.H - 5"
              fill="var(--sf-muted)"
              font-size="9"
              class="sf-mono"
            >
              {{ isWindow ? `${Math.round(pathData.xMin)}d` : "now" }}
            </text>
            <text
              :x="pathData.W - pathData.PAD.r"
              :y="pathData.H - 5"
              text-anchor="end"
              fill="var(--sf-muted)"
              font-size="9"
              class="sf-mono"
            >
              {{ `${Math.round(pathData.xMax)}d` }}
            </text>

            <path
              v-if="pathData.clearArea"
              :d="pathData.clearArea"
              fill="var(--sf-bid)"
              fill-opacity="0.14"
            />
            <path
              v-if="pathData.bidPath"
              :d="pathData.bidPath"
              fill="none"
              stroke="var(--sf-bid)"
              stroke-width="1.5"
              stroke-dasharray="4 3"
            />
            <path
              v-if="pathData.minePath"
              :d="pathData.minePath"
              fill="none"
              stroke="var(--sf-ask)"
              stroke-width="2.2"
              stroke-linecap="round"
            />

            <line
              v-if="!isWindow && pathData.cross"
              :x1="pathData.sx(pathData.cross.x)"
              :x2="pathData.sx(pathData.cross.x)"
              :y1="pathData.PAD.t"
              :y2="pathData.H - pathData.PAD.b"
              stroke="var(--sf-bid)"
              stroke-dasharray="2 3"
            />

            <g v-if="pathHover" pointer-events="none">
              <line
                :x1="pathHover.px"
                :x2="pathHover.px"
                :y1="pathData.PAD.t"
                :y2="pathData.H - pathData.PAD.b"
                stroke="var(--sf-line-strong)"
              />
              <circle
                v-if="pathHover.askY != null"
                :cx="pathHover.px"
                :cy="pathData.sy(pathHover.askY)"
                r="3.2"
                fill="var(--sf-ask)"
                stroke="var(--sf-card)"
                stroke-width="1.5"
              />
              <circle
                v-if="pathHover.bidY != null"
                :cx="pathHover.px"
                :cy="pathData.sy(pathHover.bidY)"
                r="3.2"
                fill="var(--sf-bid)"
                stroke="var(--sf-card)"
                stroke-width="1.5"
              />
            </g>
          </svg>
        </div>

        <div class="flex items-center gap-3.5 text-[10.5px] text-[color:var(--sf-muted)]">
          <span class="inline-flex items-center gap-1.5">
            <span class="h-0.5 w-3 bg-[color:var(--sf-ask)]" />
            <span>{{ isWindow ? "Window APR" : "This ask" }}</span>
          </span>
          <span class="inline-flex items-center gap-1.5">
            <span class="h-0.5 w-3 border-t border-dashed border-[color:var(--sf-bid)]" />
            <span>Best bid</span>
          </span>
        </div>

        <div
          class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-3 py-2 text-[11.5px] leading-snug text-[color:var(--sf-ink-2)]"
        >
          <template v-if="isWindow">
            Variable-maturity curve capped at {{ formatApr(ask.cap) }}.
          </template>
          <template v-else-if="pathData.cross">
            {{
              pathData.cross.x === 0
                ? "Crosses best bid now — batch-matchable."
                : `Crosses today's best bid in ${formatDurLong(pathData.cross.raw - height, unit)}.`
            }}
          </template>
          <template v-else>
            Below current best bid until expiry; direct fill only.
          </template>
        </div>
      </div>

      <!-- TAB 3: RISK & SHOCK SIMULATOR -->
      <div v-else class="space-y-3">
        <dl class="divide-y divide-[color:var(--sf-line)] text-[11.5px]">
          <div class="flex items-center justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Cover</dt>
            <dd>
              <cover-meter :value="cov" :ratio="ratio" :guard="ask.guard?.ratio" compact />
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Liquidates</dt>
            <dd class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              <template v-if="!liqInfo">At maturity</template>
              <template v-else-if="liqInfo.price == null">
                {{ liqInfo.dir === "never" ? "Never on price" : "Now" }}
              </template>
              <template v-else>
                ERG {{ liqInfo.dir === "below" ? "<" : ">" }} ${{ liqInfo.price.toFixed(3) }}
              </template>
            </dd>
          </div>
          <div v-if="liqDistancePct != null" class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Buffer</dt>
            <dd
              class="sf-mono font-semibold"
              :class="liqDistancePct < 12 ? 'text-[color:var(--sf-ask)]' : 'text-[color:var(--sf-bid)]'"
            >
              {{ liqDistancePct.toFixed(1) }}%
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">
              {{ ask.kind === "order" ? "Fill guard" : "Sale guard" }}
            </dt>
            <dd class="sf-mono text-[color:var(--sf-ink-2)]">
              {{ ask.guard ? `≥ ${ask.guard.ratio}% · ≤ ${ask.guard.age} blk` : "None" }}
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Oracle</dt>
            <dd
              class="sf-mono"
              :class="
                oracleAge > maxOracleAge
                  ? 'font-semibold text-[color:var(--sf-ask)]'
                  : 'text-[color:var(--sf-ink-2)]'
              "
            >
              {{ oracleAge }} / {{ maxOracleAge }} blk
            </dd>
          </div>
          <div class="flex justify-between gap-2 py-1.5">
            <dt class="text-[color:var(--sf-muted)]">Recovery</dt>
            <dd class="sf-mono text-[color:var(--sf-ink-2)]">{{ recoveryLabel }}</dd>
          </div>
        </dl>

        <!-- ERG Price Shock Simulator -->
        <div
          v-if="rule === 'oracle' && oraclePrice > 0 && shockedCover != null"
          class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] p-2.5"
        >
          <div class="flex items-center justify-between text-[11px]">
            <span class="font-medium text-[color:var(--sf-ink-2)]">ERG shock</span>
            <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
              {{ shockPct > 0 ? "+" : "" }}{{ shockPct }}% · ${{
                (oraclePrice * (1 + shockPct / 100)).toFixed(3)
              }}
            </span>
          </div>
          <input
            v-model.number="shockPct"
            type="range"
            min="-50"
            max="50"
            step="5"
            aria-label="ERG price shock simulation"
            class="sf-range mt-2"
          />
          <div class="mt-1.5 flex items-center justify-between text-[11px]">
            <span class="text-[color:var(--sf-muted)]">Scenario cover</span>
            <span
              class="sf-mono font-semibold"
              :class="
                ratio != null && shockedCover < ratio
                  ? 'text-[color:var(--sf-danger)]'
                  : ratio != null && shockedCover < ratio * 1.12
                    ? 'text-[color:var(--sf-ask)]'
                    : 'text-[color:var(--sf-bid)]'
              "
            >
              {{ Math.round(shockedCover) }}%{{
                ratio != null && shockedCover < ratio ? " · liquidatable" : ""
              }}
            </span>
          </div>
        </div>

        <!-- Locked Collateral Breakdown -->
        <div class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] p-2.5">
          <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Collateral
          </div>
          <div class="sf-mono mt-1 space-y-0.5 text-[11px] text-[color:var(--sf-ink)]">
            <div v-if="collateral.erg > 0.0011" class="flex justify-between">
              <span>ERG</span>
              <span class="font-semibold">{{ formatNumber(collateral.erg, 3, 0) }} ERG</span>
            </div>
            <div v-if="collateral.usd > 0" class="flex justify-between">
              <span>SigUSD</span>
              <span class="font-semibold">{{ formatNumber(collateral.usd, 2, 2) }} SigUSD</span>
            </div>
            <zc-asset-chip
              v-for="tok in collateral.tokens"
              :key="tok.id"
              :token="tok"
              :height="height"
              variant="inline"
            />
            <div
              v-if="collateral.erg <= 0.0011 && collateral.usd <= 0 && !collateral.tokens.length"
              class="text-[color:var(--sf-dim)]"
            >
              Box reserve only
            </div>
          </div>
        </div>

        <!-- Contract Checks -->
        <div v-if="ask.checks.length" class="space-y-1">
          <div
            v-for="chk in ask.checks"
            :key="chk.key"
            class="flex items-center gap-1.5 text-[11px]"
            :class="chk.ok ? 'text-[color:var(--sf-ink-2)]' : 'text-[color:var(--sf-ask)]'"
          >
            <check-circle-icon
              class="h-3.5 w-3.5 shrink-0"
              :class="chk.ok ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ask)]'"
            />
            <span class="truncate">{{ chk.detail }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Pinned Action Footer -->
    <div class="shrink-0 space-y-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-4 py-3">
      <template v-if="ask.owner">
        <button
          type="button"
          class="sf-btn-ask flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px]"
          @click="openCancelPreview"
        >
          <span>Cancel &amp; Refund</span>
          <arrow-right-icon class="h-3.5 w-3.5" />
        </button>
        <router-link
          :to="{ name: 'zc-portfolio', query: { tab: 'open' } }"
          class="sf-btn-outline flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-[12px] font-semibold"
        >
          <span>Open Orders in Portfolio</span>
          <arrow-right-icon class="h-3.5 w-3.5" />
        </router-link>
      </template>
      <button
        v-else
        type="button"
        :disabled="!usable || !activeQuote"
        class="sf-btn-bid flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-40"
        @click="openPreview"
      >
        <span>
          {{
            usable && activeQuote
              ? `${ask.kind === "order" ? "Fund" : isBuyback ? "Buy back" : "Buy"} ${formatMarketAmount(
                  activeQuote.cost,
                  ask.market
                )}`
              : ask.reason || "Unavailable"
          }}
        </span>
        <arrow-right-icon v-if="usable" class="h-3.5 w-3.5" />
      </button>

      <router-link
        :to="{ name: 'zc-bond', params: { id: ask.id } }"
        class="sf-btn-outline flex w-full items-center justify-center gap-1.5 rounded-xl border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/55 px-4 py-2 text-[12px] font-semibold text-[color:var(--sf-cobalt)] transition-all hover:bg-[color:var(--sf-cobalt-soft)]"
      >
        <span>Full {{ ask.kind === "order" ? "Order" : "Bond" }} Terms &amp; Verification</span>
        <arrow-up-right-icon class="h-3.5 w-3.5" />
      </router-link>
    </div>
  </aside>
</template>
