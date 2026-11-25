<script setup lang="ts">
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  ZapIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import CoverMeter from "./components/CoverMeter.vue";
import ExecutionPreviewModal, { ExecutionPreviewPayload } from "./components/ExecutionPreviewModal.vue";
import PortfolioActionModal from "./components/PortfolioActionModal.vue";
import PortfolioHealthGauge from "./components/PortfolioHealthGauge.vue";
import PortfolioRepaymentLadder from "./components/PortfolioRepaymentLadder.vue";
import ZcAssetChip from "./components/ZcAssetChip.vue";
import ZcOrderMark from "./components/ZcOrderMark.vue";
import AssetIcon from "@/components/AssetIcon.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { ERG_TOKEN_ID } from "@/constants";
import { useWalletStore, useZcStore } from "@/stories";
import {
  ZcAskSummary,
  ZcAuctionLotSummary,
  ZcMarket,
  ZcOfferSummary,
  ZcPortfolioMintRequest,
  ZcPortfolioPosition,
  ZcPortfolioWrap,
  ZcWalletToken
} from "@/types/zc";
import { shortenString } from "@/utils";
import {
  coverage,
  dateAtHeight,
  formatApr,
  formatDur,
  formatMarketAmount,
  formatNumber,
  liquidationPrice,
  loanHealth,
  lotPriceAt,
  offerPnl,
  pnlTone,
  positionPnl,
  pricingName,
  resolvedAskQuote,
  shareTotalOf,
  signedFormat,
  SIGUSD_TOKEN_ID
} from "@/utils/zcMath";

const zc = useZcStore();
const wallet = useWalletStore();
const route = useRoute();

type PortfolioTab = "lend" | "borrow" | "open" | "wraps";

function parseTabQuery(raw: unknown): PortfolioTab | null {
  if (raw === "lend" || raw === "borrow" || raw === "open" || raw === "wraps") return raw;
  return null;
}

const initialTab = parseTabQuery(route.query.tab);
const activeTab = ref<PortfolioTab>(initialTab ?? "lend");
const userPickedTab = ref(initialTab !== null);

function selectTab(tab: PortfolioTab) {
  userPickedTab.value = true;
  activeTab.value = tab;
}

function syncPortfolio() {
  void wallet.getBoxes(true);
  void zc.refresh();
  void zc.refreshPortfolio();
}

function onTxSubmitted() {
  if (zc.dataSource === "hergmes" && zc.streamPhase === "live" && wallet.liveOverlayActive) {
    return;
  }
  syncPortfolio();
}

const pendingErgDelta = computed<number | null>(() => {
  const raw = wallet.pendingBalance.get(ERG_TOKEN_ID) ?? 0n;
  return raw === 0n ? null : Number(raw) / 1e9;
});

const pendingSigUsdDelta = computed<number | null>(() => {
  const raw = wallet.pendingBalance.get(SIGUSD_TOKEN_ID) ?? 0n;
  return raw === 0n ? null : Number(raw) / 100;
});

function pendingTokenDelta(tokenId: string, decimals: number): number | null {
  const raw = wallet.pendingBalance.get(tokenId.toLowerCase()) ?? 0n;
  if (raw === 0n) return null;
  return Number(raw) / Math.pow(10, Math.max(0, decimals));
}

function formatPendingChip(delta: number, maxDecimals: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign}${formatNumber(Math.abs(delta), maxDecimals, 0)} pending`;
}

watch(
  () => route.query.tab,
  (q) => {
    const parsed = parseTabQuery(q);
    if (parsed) {
      userPickedTab.value = true;
      activeTab.value = parsed;
    }
  }
);
const lendFilter = ref<"all" | "live" | "actionable">("all");
const ladderMarket = ref<ZcMarket>(zc.activeMarket);
const actionModal = ref<{ mode: "repay" | "addCollateral"; position: ZcPortfolioPosition } | null>(
  null
);
const previewPayload = ref<ExecutionPreviewPayload | null>(null);

const height = computed(() => (zc.height > 100_000 ? zc.height : 1_650_000));
const oraclePrice = computed(() => (zc.oracle.price > 0.05 ? zc.oracle.price : 1.42));
const unit = computed(() => zc.durationUnit);

const isReady = computed(() => wallet.connected || zc.demoMode);

const lendPositions = computed(() =>
  zc.portfolio.positions.filter((p) => p.side === "lend")
);
const borrowPositions = computed(() =>
  zc.portfolio.positions.filter((p) => p.side === "borrow")
);

const filteredLend = computed(() => {
  if (lendFilter.value === "all") return lendPositions.value;
  if (lendFilter.value === "live") {
    return lendPositions.value.filter((p) => p.status === "live");
  }
  return lendPositions.value.filter((p) => p.status !== "live" || !!p.actions?.extinguish?.enabled);
});

const pnlMap = computed(() => {
  const m = new Map<string, ReturnType<typeof positionPnl>>();
  for (const p of lendPositions.value) {
    m.set(p.id, positionPnl(p, height.value, oraclePrice.value));
  }
  return m;
});

type OpenBoxItem =
  | { type: "ask"; key: string; ask: ZcAskSummary }
  | { type: "offer"; key: string; offer: ZcOfferSummary }
  | { type: "lot"; key: string; lot: ZcAuctionLotSummary }
  | { type: "mint"; key: string; req: ZcPortfolioMintRequest };

const openItems = computed<OpenBoxItem[]>(() => [
  ...zc.portfolio.openOrders.map((a): OpenBoxItem => ({ type: "ask", key: `ord-${a.id}`, ask: a })),
  ...zc.portfolio.openAsks.map((a): OpenBoxItem => ({ type: "ask", key: `ask-${a.id}`, ask: a })),
  ...zc.portfolio.openOffers.map((o): OpenBoxItem => ({ type: "offer", key: `off-${o.id}`, offer: o })),
  ...zc.portfolio.openLots.map((l): OpenBoxItem => ({ type: "lot", key: `lot-${l.id}`, lot: l })),
  ...zc.portfolio.mintRequests.map((r): OpenBoxItem => ({ type: "mint", key: `mnt-${r.id}`, req: r }))
]);

// If user landed on Portfolio with no explicit ?tab= and has no Lending bonds yet,
// automatically focus Open Orders (or Borrowing) so cancellable orders aren't hidden.
watch(
  [() => zc.portfolio.loaded, () => lendPositions.value.length, () => borrowPositions.value.length, () => openItems.value.length],
  ([loaded, lendCount, borrowCount, openCount]) => {
    if (!loaded || userPickedTab.value || lendCount > 0) return;
    if (openCount > 0) {
      activeTab.value = "open";
    } else if (borrowCount > 0) {
      activeTab.value = "borrow";
    }
  },
  { immediate: true }
);

const rawWrappableNfts = computed(() =>
  zc.portfolio.walletTokens.filter(
    (t) => t.kind === "provision" || (t.kind !== "receipt" && t.decimals === 0 && t.amount === 1)
  )
);

// --- Overview Metrics ---
const walletAmts = computed<Record<ZcMarket, number>>(() => ({
  SigUSD: zc.portfolio.walletSigUsd,
  ERG: zc.portfolio.walletErg
}));

const lentAmts = computed<Record<ZcMarket, number>>(() => {
  const out: Record<ZcMarket, number> = { SigUSD: 0, ERG: 0 };
  for (const p of lendPositions.value) {
    if (p.status !== "live") continue;
    const frac = p.kind === "shares" ? p.units / shareTotalOf(p) : 1;
    out[p.bond.market] += (p.bond.repayment || 0) * frac;
  }
  return out;
});

const owedAmts = computed<Record<ZcMarket, number>>(() => {
  const out: Record<ZcMarket, number> = { SigUSD: 0, ERG: 0 };
  for (const p of borrowPositions.value) {
    out[p.bond.market] += p.bond.repayment || 0;
  }
  return out;
});

const unrealizedPnl = computed<Record<ZcMarket, number>>(() => {
  const out: Record<ZcMarket, number> = { SigUSD: 0, ERG: 0 };
  for (const p of lendPositions.value) {
    const x = pnlMap.value.get(p.id);
    if (x?.pnl != null) out[x.market] += x.pnl;
  }
  return out;
});

const atMaturityPnl = computed<Record<ZcMarket, number>>(() => {
  const out: Record<ZcMarket, number> = { SigUSD: 0, ERG: 0 };
  for (const p of lendPositions.value) {
    const x = pnlMap.value.get(p.id);
    if (x?.atMaturity != null) out[x.market] += x.atMaturity;
  }
  return out;
});

const toUsd = (v: Record<ZcMarket, number>) => v.SigUSD + v.ERG * oraclePrice.value;

const overview = computed(() => {
  const W = toUsd(walletAmts.value);
  const L = toUsd(lentAmts.value);
  const O = toUsd(owedAmts.value);
  const net = W + L - O;
  const sum = Math.max(1, W + L + O);
  const debtRatio = W + L > 0 ? (O / (W + L)) * 100 : 0;
  return {
    W,
    L,
    O,
    net,
    wPct: (W / sum) * 100,
    lPct: (L / sum) * 100,
    oPct: (O / sum) * 100,
    debtRatio
  };
});

const lowestHealth = computed(() => {
  const vals = borrowPositions.value
    .map((p) => loanHealth(p.bond, oraclePrice.value))
    .filter((v): v is number => v != null);
  return vals.length ? Math.min(...vals) : null;
});

const attentionLoans = computed(() =>
  borrowPositions.value.filter((p) => {
    const hf = loanHealth(p.bond, oraclePrice.value);
    return (hf != null && hf < 1.25) || p.bond.maturity - height.value < 2160;
  }).length
);

const STATUS_META: Record<string, { label: string; tone: "bid" | "warn" | "danger" | "cobalt" }> = {
  live: { label: "Live", tone: "bid" },
  repaid: { label: "Repaid", tone: "bid" },
  claimable: { label: "Ready to claim", tone: "bid" },
  liquidated: { label: "Liquidated", tone: "warn" },
  pullNeeded: { label: "Pull needed", tone: "warn" },
  auction: { label: "Auction open", tone: "warn" },
  maturedUnpaid: { label: "Matured unpaid", tone: "danger" },
  matured: { label: "Matured unpaid", tone: "danger" },
  overdue: { label: "Liquidatable", tone: "danger" }
};

function statusBadge(s: string) {
  return STATUS_META[s] || { label: s, tone: "cobalt" as const };
}

function coverOf(p: ZcPortfolioPosition): number | null {
  if (p.bond.rule !== "oracle") return null;
  return (
    p.bond.cov ??
    (oraclePrice.value > 0
      ? coverage(p.bond.collateral, p.bond.repayment, p.bond.market, oraclePrice.value)
      : null)
  );
}

function healthOf(p: ZcPortfolioPosition): number | null {
  return loanHealth(p.bond, oraclePrice.value);
}

function healthBarWidth(hf: number): string {
  return `${Math.min(100, Math.max(6, ((hf - 0.8) / 1.2) * 100))}%`;
}

function liqOf(p: ZcPortfolioPosition) {
  if (p.bond.rule !== "oracle" || p.bond.ratio == null) return null;
  return liquidationPrice(p.bond.collateral, p.bond.repayment, p.bond.market, p.bond.ratio);
}

function sparkPath(points: { d: number; y: number }[], w = 84, h = 22): string {
  if (!points.length) return "";
  if (points.length === 1) return `M2,${(h / 2).toFixed(1)} L${w - 2},${(h / 2).toFixed(1)}`;
  const x0 = points[0].d;
  const x1 = Math.max(x0 + 1, points[points.length - 1].d);
  const ys = points.map((p) => p.y);
  const y0 = Math.min(...ys);
  const y1 = Math.max(y0 + 1, Math.max(...ys));
  return points
    .map((p, i) => {
      const X = 2 + ((p.d - x0) / (x1 - x0)) * (w - 4);
      const Y = h - 3 - ((p.y - y0) / (y1 - y0)) * (h - 6);
      return `${i === 0 ? "M" : "L"}${X.toFixed(1)},${Y.toFixed(1)}`;
    })
    .join(" ");
}

function fmtMarketSigned(val: number | null | undefined, m: ZcMarket): string {
  return signedFormat(val, (abs) => formatMarketAmount(abs, m));
}

function offerPerf(o: ZcOfferSummary) {
  return offerPnl(o, zc.portfolio.positions, height.value, oraclePrice.value);
}

// --- Contextual Preview Handlers ---
function previewExtinguish(p: ZcPortfolioPosition) {
  const b = p.bond;
  previewPayload.value = {
    title: "Extinguish Bond",
    subtitle: "Burns circulating bond unit against your own debt and releases collateral",
    badge: `Extinguish · ${b.market}`,
    tone: "bid",
    heroLabel: "Debt extinguished",
    heroValue: formatMarketAmount(b.repayment, b.market),
    heroSub: "Zero cash required · collateral + reserve returned immediately",
    rows: [
      { label: "Bond", value: shortenString(b.id, 14) },
      { label: "Fee reserve returned", value: `${formatNumber(b.reserve ?? 0.05, 3, 0)} ERG` }
    ],
    rawSummary: { action: "extinguishBond", bondId: b.id },
    txAction: { type: "extinguish", assetId: b.id }
  };
}

function previewClaim(p: ZcPortfolioPosition, unfrac = false) {
  const b = p.bond;
  const tokId = p.tokenId || p.id;
  previewPayload.value = {
    title: unfrac ? "Un-fractionalize Bond Shares" : "Claim Bond Settlement",
    subtitle: unfrac
      ? "Burns all 100 shares to recover the underlying whole bond unit"
      : p.kind === "shares"
        ? "Claims pro-rata settlement for your shares"
        : "Burns bond unit to claim repayment / settlement",
    badge: unfrac ? "Recombine" : `Claim · ${b.market}`,
    tone: "bid",
    heroLabel: unfrac ? "You receive" : "Settlement claim",
    heroValue: unfrac
      ? "1 whole bond unit"
      : formatMarketAmount(
          b.repayment * (p.kind === "shares" ? p.units / shareTotalOf(p) : 1),
          b.market
        ),
    heroSub: `Bond ${shortenString(b.id, 14)}`,
    rows: [
      { label: "Token", value: shortenString(tokId, 14) },
      ...(p.kind === "shares"
        ? [{ label: "Shares", value: `${formatNumber((p.units / shareTotalOf(p)) * 100, 2, 0)}%` }]
        : [])
    ],
    rawSummary: {
      action: unfrac ? "unfractionalize" : "claimSettlement",
      tokenId: tokId,
      bondId: b.id,
      units: p.unitsRaw
    },
    txAction: {
      type: "claim",
      tokenId: tokId,
      units: p.kind === "shares" && p.unitsRaw ? BigInt(p.unitsRaw) : null
    }
  };
}

function previewPull(p: ZcPortfolioPosition) {
  previewPayload.value = {
    title: "Pull Settlement into Share Vault",
    subtitle: "Moves liquidated/repaid bond proceeds into the share vault so holders can claim",
    badge: "Pull Vault",
    tone: "cobalt",
    heroLabel: "Vault",
    heroValue: shortenString(p.vaultId || p.bond.id, 14),
    heroSub: `Bond ${shortenString(p.bond.id, 14)}`,
    rows: [{ label: "Market", value: p.bond.market }],
    rawSummary: { action: "pullVault", vaultId: p.vaultId, bondId: p.bond.id },
    txAction: p.vaultId ? { type: "pull", boxId: p.vaultId } : null
  };
}

function previewLiquidate(p: ZcPortfolioPosition) {
  previewPayload.value = {
    title: "Liquidate Defaulted Bond",
    subtitle: "Triggers collateral recovery for this matured or under-ratio bond",
    badge: `Liquidate · ${p.bond.market}`,
    tone: "ask",
    heroLabel: "Unpaid repayment",
    heroValue: formatMarketAmount(p.bond.repayment, p.bond.market),
    heroSub: `Bond ${shortenString(p.bond.id, 14)}`,
    rows: [
      { label: "Rule", value: p.bond.rule === "oracle" ? `Oracle < ${p.bond.ratio}%` : "Matured unpaid" }
    ],
    rawSummary: { action: "liquidateBond", bondId: p.bond.id },
    txAction: { type: "liquidate", assetId: p.bond.id }
  };
}

function previewCancelBox(title: string, boxId: string, sub: string) {
  previewPayload.value = {
    title,
    subtitle: "Returns everything locked in this open box to your Nautilus wallet",
    badge: "Cancel & Refund",
    tone: "ask",
    heroLabel: "Box ID",
    heroValue: shortenString(boxId, 14),
    heroSub: sub,
    rows: [{ label: "Action", value: "Cancel and refund" }],
    rawSummary: { action: "cancelBox", boxId },
    txAction: { type: "cancel", boxId }
  };
}

function previewRunMint(label: string, boxId: string) {
  previewPayload.value = {
    title: label,
    subtitle: "Executes pending mint request box immediately instead of waiting for a batcher",
    badge: "Run Batcher",
    tone: "cobalt",
    heroLabel: "Request box",
    heroValue: shortenString(boxId, 14),
    rows: [{ label: "Action", value: label }],
    rawSummary: { action: "runMint", boxId },
    txAction: { type: "mint", boxId }
  };
}

function previewWrapNft(t: ZcWalletToken) {
  previewPayload.value = {
    title: "Wrap NFT into Custody Receipt",
    subtitle: "Locks NFT in custody vault & mints ZCS-Wrap receipt (0.03 ERG refundable reserve; decreases if refreshed after 4+ yrs)",
    badge: "Custody Wrap",
    tone: "cobalt",
    heroLabel: "Wrapping cost",
    heroValue: "0.037 ERG",
    heroSub: `${t.name || t.ticker} · 0.038 ERG incl. miner fee`,
    rows: [
      { label: "Token", value: shortenString(t.id, 14) },
      { label: "Receipt", value: `ZCS-Wrap-${t.id.slice(0, 6)}` }
    ],
    rawSummary: { action: "wrapNft", tokenId: t.id },
    txAction: { type: "createWrap", body: { tokenId: t.id } }
  };
}

function previewUnwrap(w: ZcPortfolioWrap) {
  const receiptId = w.receiptId || w.id;
  previewPayload.value = {
    title: "Unwrap Custody Receipt",
    subtitle: "Burns receipt and releases the original NFT + 0.03 ERG reserve back to Nautilus",
    badge: "Unwrap",
    tone: "cobalt",
    heroLabel: "Releases",
    heroValue: w.token.ticker,
    heroSub: `Receipt ${shortenString(receiptId, 14)}`,
    rows: [{ label: "Underlying token", value: shortenString(w.token.id, 14) }],
    rawSummary: { action: "unwrapNft", receiptId, innerTokenId: w.token.id },
    txAction: { type: "unwrap", receiptId }
  };
}
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <!-- Top Page Bar -->
    <header class="flex flex-wrap items-center justify-between gap-2.5 px-0.5">
      <div class="flex items-center gap-2.5">
        <h1 class="sf-display text-[22px] font-bold leading-none text-[color:var(--sf-ink)]">
          Portfolio
        </h1>
        <span
          v-if="zc.demoMode"
          class="sf-mono rounded-[5px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-2 py-0.5 text-[10px] font-bold uppercase text-[color:var(--sf-cobalt)]"
        >
          Demo Mode
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="zc.demoMode"
          type="button"
          class="sf-mono h-8 rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-3 text-[11px] font-semibold text-[color:var(--sf-cobalt)] transition-all hover:brightness-110"
          @click="zc.setDemoMode(false)"
        >
          Exit Demo → Live
        </button>
        <button
          v-else-if="wallet.connected"
          type="button"
          class="sf-mono inline-flex h-8 items-center gap-1.5 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-3 text-[11px] font-semibold text-[color:var(--sf-muted)] transition-colors hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-ink)]"
          @click="syncPortfolio"
        >
          <refresh-cw-icon class="h-3 w-3" :class="zc.portfolio.loading ? 'animate-spin' : ''" />
          <span>Sync</span>
        </button>

        <router-link
          :to="{ name: 'zc-studio', query: { type: 'lend' } }"
          class="sf-btn-bid inline-flex h-8 items-center gap-1 rounded-xl px-3 text-[11.5px]"
        >
          <plus-icon class="h-3.5 w-3.5" />
          <span>Lend</span>
        </router-link>
        <router-link
          :to="{ name: 'zc-studio', query: { type: 'borrow' } }"
          class="sf-btn-ask inline-flex h-8 items-center gap-1 rounded-xl px-3 text-[11.5px]"
        >
          <plus-icon class="h-3.5 w-3.5" />
          <span>Borrow</span>
        </router-link>
      </div>
    </header>

    <!-- Disconnected State (when Nautilus not connected & Demo Mode off) -->
    <section
      v-if="!isReady"
      class="sf-terminal-plate flex flex-col items-center justify-center rounded-[22px] p-10 text-center"
    >
      <div class="grid h-12 w-12 place-items-center rounded-2xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]">
        <zap-icon class="h-6 w-6" />
      </div>
      <h2 class="sf-display mt-3.5 text-[20px] font-bold text-[color:var(--sf-ink)]">
        Connect Nautilus to load your ZC portfolio
      </h2>
      <p class="mt-1.5 max-w-md text-[13px] text-[color:var(--sf-muted)]">
        Inspect live bond claims, collateralized loans, health gauges, open rolling offers, and custody wraps directly from your Ergo wallet.
      </p>
      <div class="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <button
          type="button"
          class="sf-btn-cobalt inline-flex h-10 items-center gap-1.5 rounded-full px-6 text-[13.5px]"
          @click="wallet.connect('nautilus')"
        >
          <span>Connect Nautilus</span>
        </button>
        <!-- Demo button (uncomment to preview mock portfolio)
        <button
          type="button"
          class="sf-btn-outline inline-flex h-10 items-center gap-1.5 rounded-full px-5 text-[13px]"
          @click="zc.setDemoMode(true)"
        >
          <zap-icon class="h-3.5 w-3.5 text-[color:var(--sf-cobalt)]" />
          <span>Preview with Demo Data</span>
        </button>
        -->
      </div>
    </section>

    <template v-else>
      <!-- 3-ZONE EXECUTIVE OVERVIEW BENTO -->
      <section
        class="sf-terminal-plate grid grid-cols-1 gap-4 rounded-[22px] rounded-tl-[6px] p-4 lg:grid-cols-[1.05fr_1.45fr_0.75fr]"
        aria-label="Portfolio overview"
      >
        <!-- Zone 1: Net Worth & P&L -->
        <div class="flex flex-col justify-between gap-3">
          <div>
            <div class="sf-mono text-[10px] font-semibold uppercase tracking-[0.11em] text-[color:var(--sf-muted)]">
              Net Position (Oracle ${{ oraclePrice.toFixed(2) }})
            </div>
            <div
              class="sf-serif mt-1 text-[34px] font-semibold leading-none"
              :class="overview.net < 0 ? 'text-[color:var(--sf-danger)]' : 'text-[color:var(--sf-ink)]'"
            >
              {{ overview.net < 0 ? "−" : "" }}${{ formatNumber(Math.abs(overview.net), 2, 2) }}
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                Unrealized P&amp;L
              </div>
              <div class="mt-1 space-y-0.5">
                <div
                  v-for="m in (['SigUSD', 'ERG'] as ZcMarket[]).filter((x) => Math.abs(unrealizedPnl[x]) > 1e-6)"
                  :key="m"
                  class="sf-mono flex items-center gap-1 text-[12px] font-bold"
                  :class="
                    pnlTone(unrealizedPnl[m]) === 'bid'
                      ? 'text-[color:var(--sf-bid)]'
                      : 'text-[color:var(--sf-danger)]'
                  "
                >
                  <market-coin :market="m" :size="12" />
                  <span>{{ fmtMarketSigned(unrealizedPnl[m], m) }}</span>
                </div>
                <span
                  v-if="Math.abs(unrealizedPnl.SigUSD) <= 1e-6 && Math.abs(unrealizedPnl.ERG) <= 1e-6"
                  class="sf-mono text-[12px] text-[color:var(--sf-dim)]"
                >
                  —
                </span>
              </div>
            </div>

            <div class="sf-dock-well rounded-xl px-3 py-2">
              <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                At Maturity
              </div>
              <div class="mt-1 space-y-0.5">
                <div
                  v-for="m in (['SigUSD', 'ERG'] as ZcMarket[]).filter((x) => Math.abs(atMaturityPnl[x]) > 1e-6)"
                  :key="m"
                  class="sf-mono flex items-center gap-1 text-[12px] font-bold text-[color:var(--sf-bid)]"
                >
                  <market-coin :market="m" :size="12" />
                  <span>{{ fmtMarketSigned(atMaturityPnl[m], m) }}</span>
                </div>
                <span
                  v-if="Math.abs(atMaturityPnl.SigUSD) <= 1e-6 && Math.abs(atMaturityPnl.ERG) <= 1e-6"
                  class="sf-mono text-[12px] text-[color:var(--sf-dim)]"
                >
                  —
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Zone 2: Capital Allocation Bar & Coin Breakdown -->
        <div class="flex flex-col justify-between gap-2.5 border-t border-[color:var(--sf-line)] pt-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4">
          <div class="flex items-center justify-between gap-2 text-[11px]">
            <span class="sf-mono font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Holdings vs Debt
            </span>
            <span v-if="overview.W + overview.L > 0" class="sf-mono text-[color:var(--sf-ink-2)]">
              Debt {{ formatNumber(overview.debtRatio, 1, 0) }}% of assets
            </span>
          </div>

          <!-- Proportional Bar -->
          <div class="flex h-2.5 w-full overflow-hidden rounded-full bg-[color:var(--sf-line-strong)]">
            <div
              v-if="overview.W > 0"
              class="h-full bg-[color:var(--sf-cobalt)] transition-all duration-500"
              :style="{ width: `${overview.wPct}%` }"
            />
            <div
              v-if="overview.L > 0"
              class="h-full bg-[color:var(--sf-bid)] transition-all duration-500"
              :style="{ width: `${overview.lPct}%` }"
            />
            <div
              v-if="overview.O > 0"
              class="h-full bg-[color:var(--sf-ask)] transition-all duration-500"
              :style="{ width: `${overview.oPct}%` }"
            />
          </div>

          <!-- 3 Breakdown Rows -->
          <div class="divide-y divide-[color:var(--sf-line)] text-[12px]">
            <div
              v-for="row in [
                {
                  key: 'w',
                  dot: 'var(--sf-cobalt)',
                  label: 'Wallet',
                  sub: 'Free capital',
                  amts: walletAmts,
                  usd: overview.W
                },
                {
                  key: 'l',
                  dot: 'var(--sf-bid)',
                  label: 'Repays to you',
                  sub: `${lendPositions.filter((p) => p.status === 'live').length} live`,
                  amts: lentAmts,
                  usd: overview.L
                },
                {
                  key: 'o',
                  dot: 'var(--sf-ask)',
                  label: 'You owe',
                  sub: `${borrowPositions.length} loan${borrowPositions.length === 1 ? '' : 's'}`,
                  amts: owedAmts,
                  usd: overview.O
                }
              ]"
              :key="row.key"
              class="grid grid-cols-[minmax(0,1fr)_auto_78px] items-center gap-3 py-1.5"
            >
              <div class="flex min-w-0 items-center gap-2">
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: row.dot }" />
                <span class="truncate font-semibold text-[color:var(--sf-ink)]">{{ row.label }}</span>
                <span class="sf-mono shrink-0 text-[10.5px] text-[color:var(--sf-dim)]">{{ row.sub }}</span>
              </div>

              <div class="sf-mono flex items-center justify-end gap-2 text-[11.5px] text-[color:var(--sf-ink-2)]">
                <span
                  v-for="m in (['SigUSD', 'ERG'] as ZcMarket[]).filter((x) => row.amts[x] > 1e-6)"
                  :key="m"
                  class="inline-flex items-center gap-1"
                >
                  <market-coin :market="m" :size="12" />
                  <span>{{ formatNumber(row.amts[m], m === "ERG" ? 2 : 0, 0) }}</span>
                </span>
              </div>

              <span class="sf-mono text-right font-bold text-[color:var(--sf-ink)]">
                ${{ formatNumber(row.usd, 0, 0) }}
              </span>
            </div>
          </div>
        </div>

        <!-- Zone 3: Lowest Loan Health Half-Dial -->
        <div class="flex flex-col items-center justify-between gap-2 border-t border-[color:var(--sf-line)] pt-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4">
          <div class="sf-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Lowest Health
          </div>
          <portfolio-health-gauge :value="lowestHealth" />
          <div
            class="sf-mono flex items-center gap-1 text-center text-[11px] font-semibold"
            :class="
              !borrowPositions.length
                ? 'text-[color:var(--sf-muted)]'
                : attentionLoans > 0
                  ? 'text-[color:var(--sf-ask)]'
                  : 'text-[color:var(--sf-bid)]'
            "
          >
            <alert-triangle-icon v-if="attentionLoans > 0" class="h-3.5 w-3.5" />
            <span>
              {{
                !borrowPositions.length
                  ? "No active loans"
                  : attentionLoans > 0
                    ? `${attentionLoans} loan${attentionLoans === 1 ? "" : "s"} need attention`
                    : "All loans healthy"
              }}
            </span>
          </div>
        </div>
      </section>

      <!-- 12-MONTH MATURITY LADDER -->
      <portfolio-repayment-ladder
        :positions="zc.portfolio.positions"
        :market="ladderMarket"
        :height="height"
        :unit="unit"
        @update:market="ladderMarket = $event"
      />

      <!-- POSITIONS & ORDERS PANEL -->
      <section class="sf-terminal-plate overflow-hidden rounded-[20px]">
        <!-- Tab Bar -->
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--sf-line)] px-4 py-2.5">
          <div class="sf-seg" role="tablist" aria-label="Portfolio sections">
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-3 !text-[12px]"
              :class="activeTab === 'lend' ? 'is-active tone-bid' : ''"
              @click="selectTab('lend')"
            >
              Lending · {{ lendPositions.length }}
            </button>
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-3 !text-[12px]"
              :class="activeTab === 'borrow' ? 'is-active tone-ask' : ''"
              @click="selectTab('borrow')"
            >
              <span>Borrowing · {{ borrowPositions.length }}</span>
              <span
                v-if="attentionLoans > 0"
                class="sf-mono ml-1 rounded bg-[color:var(--sf-ask)] px-1 py-[1px] text-[9.5px] font-bold text-white"
              >
                {{ attentionLoans }}
              </span>
            </button>
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-3 !text-[12px]"
              :class="activeTab === 'open' ? 'is-active tone-cobalt' : ''"
              @click="selectTab('open')"
            >
              Open Orders · {{ openItems.length }}
            </button>
            <button
              type="button"
              class="sf-seg-btn !h-7 !px-3 !text-[12px]"
              :class="activeTab === 'wraps' ? 'is-active tone-cobalt' : ''"
              @click="selectTab('wraps')"
            >
              Wraps &amp; Wallet · {{ zc.portfolio.wraps.length + zc.portfolio.walletTokens.length }}
            </button>
          </div>

          <div v-if="activeTab === 'lend'" class="sf-seg">
            <button
              v-for="f in (['all', 'live', 'actionable'] as const)"
              :key="f"
              type="button"
              class="sf-seg-btn !h-6 !px-2 !text-[10.5px] capitalize"
              :class="lendFilter === f ? 'is-active tone-cobalt' : ''"
              @click="lendFilter = f"
            >
              {{ f }}
            </button>
          </div>
        </div>

        <!-- TAB 1: LENDING POSITIONS -->
        <div v-if="activeTab === 'lend'">
          <div
            v-if="filteredLend.length === 0"
            class="flex flex-col items-center justify-center p-10 text-center"
          >
            <p class="text-[13px] text-[color:var(--sf-muted)]">No lending positions in this view.</p>
            <router-link
              to="/app"
              class="sf-btn-outline mt-3 inline-flex h-9 items-center gap-1.5 rounded-full px-5 text-[12.5px]"
            >
              <span>Browse Yield Curve</span>
              <arrow-up-right-icon class="h-3.5 w-3.5" />
            </router-link>
          </div>

          <div v-else class="divide-y divide-[color:var(--sf-line)]">
            <!-- Fixed-Column Desktop Header -->
            <div
              class="sf-mono hidden items-center gap-3 bg-[color:var(--sf-well-inset)]/70 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)] lg:grid lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1.05fr)_minmax(0,0.85fr)_minmax(0,1fr)_minmax(0,0.9fr)_228px]"
            >
              <div>Position</div>
              <div>Repays</div>
              <div>Matures</div>
              <div>P&amp;L</div>
              <div>Cover &amp; Status</div>
              <div class="text-right">Actions</div>
            </div>

            <div
              v-for="p in filteredLend"
              :key="p.id"
              class="grid grid-cols-1 items-center gap-3 px-4 py-3 transition-colors hover:bg-[color:var(--sf-well-soft)]/70 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1.05fr)_minmax(0,0.85fr)_minmax(0,1fr)_minmax(0,0.9fr)_228px]"
            >
              <!-- Identity -->
              <router-link
                :to="{ name: 'zc-bond', params: { id: p.bond.id } }"
                class="flex min-w-0 items-center gap-2.5 group"
              >
                <zc-order-mark :kind="p.kind" :size="34" :market="p.bond.market" />
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="truncate text-[13.5px] font-bold text-[color:var(--sf-ink)] group-hover:text-[color:var(--sf-cobalt)]">
                      {{
                        p.kind === "shares"
                          ? `${formatNumber((p.units / shareTotalOf(p)) * 100, 1, 0)} shares · ${p.bond.market}`
                          : `${p.bond.market} Bond`
                      }}
                    </span>
                    <span
                      v-if="p.borrowedByMe"
                      class="sf-mono rounded bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[color:var(--sf-ask)]"
                    >
                      Your loan
                    </span>
                  </div>
                  <div class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
                    {{ shortenString(p.bond.id, 14) }}{{ p.bond.vault ? ` · ${p.bond.vault}` : "" }}
                  </div>
                </div>
              </router-link>

              <!-- Repays / Entry -->
              <div class="min-w-0">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Repays</div>
                <div class="sf-mono text-[13px] font-bold text-[color:var(--sf-ink)]">
                  {{ formatMarketAmount(pnlMap.get(p.id)?.face, p.bond.market) }}
                </div>
                <div class="sf-mono truncate text-[10px] text-[color:var(--sf-muted)]">
                  {{
                    pnlMap.get(p.id)?.paid != null
                      ? `paid ${formatNumber(pnlMap.get(p.id)?.paid, p.bond.market === "ERG" ? 2 : 0, 0)} · ${formatApr(pnlMap.get(p.id)?.entry)}`
                      : "cost unpriced"
                  }}
                </div>
              </div>

              <!-- Matures -->
              <div class="min-w-0">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Matures</div>
                <div class="sf-mono text-[12.5px] font-semibold text-[color:var(--sf-ink)]">
                  {{ p.bond.maturity ? dateAtHeight(p.bond.maturity, height) : "—" }}
                </div>
                <div class="sf-mono text-[10px] text-[color:var(--sf-muted)]">
                  {{ p.bond.maturity > height ? `${formatDur(p.bond.maturity - height, unit)} left` : "matured" }}
                </div>
              </div>

              <!-- P&L -->
              <div class="min-w-0">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">P&amp;L</div>
                <div
                  class="sf-mono text-[13px] font-bold"
                  :class="
                    pnlTone(pnlMap.get(p.id)?.pnl) === 'bid'
                      ? 'text-[color:var(--sf-bid)]'
                      : pnlTone(pnlMap.get(p.id)?.pnl) === 'danger'
                        ? 'text-[color:var(--sf-danger)]'
                        : 'text-[color:var(--sf-muted)]'
                  "
                >
                  {{ fmtMarketSigned(pnlMap.get(p.id)?.pnl, p.bond.market) }}
                </div>
                <div class="sf-mono truncate text-[10px] text-[color:var(--sf-muted)]">
                  {{
                    pnlMap.get(p.id)?.pnlPct != null
                      ? `${pnlMap.get(p.id)!.pnlPct! >= 0 ? "+" : ""}${pnlMap.get(p.id)!.pnlPct!.toFixed(2)}%${
                          pnlMap.get(p.id)?.heldApr != null ? ` · ${formatApr(pnlMap.get(p.id)?.heldApr)}` : ""
                        }`
                      : "—"
                  }}
                </div>
              </div>

              <!-- Cover & Status -->
              <div class="flex min-w-0 flex-col items-start gap-1">
                <cover-meter :value="coverOf(p)" :ratio="p.bond.ratio" compact />
                <span
                  class="sf-mono rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase"
                  :class="
                    statusBadge(p.status).tone === 'bid'
                      ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                      : statusBadge(p.status).tone === 'danger'
                        ? 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-danger)]'
                        : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                  "
                >
                  {{ statusBadge(p.status).label }}
                </span>
              </div>

              <!-- Contextual Actions (Fixed-width track prevents row text shift) -->
              <div class="flex flex-wrap items-center justify-start gap-1.5 lg:justify-end">
                <button
                  v-if="p.actions?.extinguish?.enabled || (p.borrowedByMe && p.kind === 'unit' && p.status === 'live')"
                  type="button"
                  class="sf-btn-bid h-7 rounded-lg px-2.5 text-[11px]"
                  @click="previewExtinguish(p)"
                >
                  Extinguish
                </button>
                <button
                  v-if="p.kind === 'shares' && p.units >= shareTotalOf(p) && p.status === 'live'"
                  type="button"
                  class="sf-btn-outline h-7 rounded-lg px-2.5 text-[11px]"
                  @click="previewClaim(p, true)"
                >
                  Un-frac
                </button>
                <template v-if="p.status === 'live'">
                  <router-link
                    :to="{ name: 'zc-studio', query: { type: 'sell', token: p.tokenId || p.id } }"
                    class="sf-btn-outline inline-flex h-7 items-center rounded-lg px-2.5 text-[11px] font-semibold"
                  >
                    Sell
                  </router-link>
                  <router-link
                    v-if="p.kind === 'unit'"
                    :to="{ name: 'zc-studio', query: { type: 'shares', token: p.tokenId || p.id } }"
                    class="sf-mono inline-flex h-7 items-center rounded-lg border border-[color:var(--sf-line)] px-2 text-[10.5px] font-semibold text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-ink)]"
                  >
                    Split
                  </router-link>
                </template>
                <button
                  v-if="p.actions?.pull?.enabled || p.status === 'pullNeeded'"
                  type="button"
                  class="sf-btn-cobalt h-7 rounded-lg px-2.5 text-[11px]"
                  @click="previewPull(p)"
                >
                  Pull
                </button>
                <button
                  v-if="p.actions?.claim?.enabled || p.status === 'repaid' || p.status === 'claimable'"
                  type="button"
                  class="sf-btn-bid h-7 rounded-lg px-2.5 text-[11px]"
                  @click="previewClaim(p, false)"
                >
                  Claim
                </button>
                <button
                  v-if="p.actions?.liquidate?.enabled || p.status === 'maturedUnpaid' || p.status === 'matured'"
                  type="button"
                  class="sf-btn-ask h-7 rounded-lg px-2.5 text-[11px]"
                  @click="previewLiquidate(p)"
                >
                  Liquidate
                </button>
                <router-link
                  v-if="p.status === 'auction'"
                  to="/app/auctions"
                  class="sf-btn-outline inline-flex h-7 items-center rounded-lg px-2.5 text-[11px]"
                >
                  Auction
                </router-link>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 2: BORROWING LOANS -->
        <div v-else-if="activeTab === 'borrow'">
          <div
            v-if="borrowPositions.length === 0"
            class="flex flex-col items-center justify-center p-10 text-center"
          >
            <p class="text-[13px] text-[color:var(--sf-muted)]">No active loans.</p>
            <router-link
              :to="{ name: 'zc-studio', query: { type: 'borrow' } }"
              class="sf-btn-ask mt-3 inline-flex h-9 items-center gap-1.5 rounded-full px-5 text-[12.5px]"
            >
              <span>Create Borrow Order</span>
            </router-link>
          </div>

          <div v-else class="divide-y divide-[color:var(--sf-line)]">
            <!-- Fixed-Column Desktop Header -->
            <div
              class="sf-mono hidden items-center gap-3 bg-[color:var(--sf-well-inset)]/70 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)] lg:grid lg:grid-cols-[minmax(0,1.65fr)_minmax(0,0.95fr)_minmax(0,0.85fr)_minmax(0,1.1fr)_minmax(0,0.95fr)_258px]"
            >
              <div>Loan &amp; Collateral</div>
              <div>You Owe</div>
              <div>Due</div>
              <div>Health</div>
              <div>Liquidates</div>
              <div class="text-right">Actions</div>
            </div>

            <div
              v-for="p in borrowPositions"
              :key="p.id"
              class="grid grid-cols-1 items-center gap-3 px-4 py-3 transition-colors hover:bg-[color:var(--sf-well-soft)]/70 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,0.95fr)_minmax(0,0.85fr)_minmax(0,1.1fr)_minmax(0,0.95fr)_258px]"
            >
              <div class="flex min-w-0 items-center gap-2.5">
                <router-link :to="{ name: 'zc-bond', params: { id: p.bond.id } }" class="shrink-0">
                  <zc-order-mark kind="order" :size="34" :market="p.bond.market" />
                </router-link>
                <div class="min-w-0">
                  <router-link
                    :to="{ name: 'zc-bond', params: { id: p.bond.id } }"
                    class="group flex flex-wrap items-center gap-1.5"
                  >
                    <span class="text-[13.5px] font-bold text-[color:var(--sf-ink)] group-hover:text-[color:var(--sf-cobalt)]">
                      {{ p.bond.market }} Loan
                    </span>
                    <span
                      v-if="p.holdsUnit"
                      class="sf-mono rounded bg-[color:var(--sf-bid-soft)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[color:var(--sf-bid)]"
                    >
                      Unit in wallet
                    </span>
                  </router-link>
                  <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <router-link
                      :to="{ name: 'zc-bond', params: { id: p.bond.id } }"
                      class="sf-mono text-[10.5px] text-[color:var(--sf-dim)] hover:text-[color:var(--sf-cobalt)]"
                    >
                      {{ shortenString(p.bond.id, 12) }}
                    </router-link>
                    <zc-asset-chip
                      v-for="t in p.bond.collateral.tokens.slice(0, 3)"
                      :key="t.id"
                      :token="t"
                      :height="height"
                      variant="chip"
                      compact
                    />
                  </div>
                </div>
              </div>

              <!-- You Owe -->
              <div class="min-w-0">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">You owe</div>
                <div class="sf-mono text-[13px] font-bold text-[color:var(--sf-ask)]">
                  {{ formatMarketAmount(p.bond.repayment, p.bond.market) }}
                </div>
                <div class="sf-mono truncate text-[10px] text-[color:var(--sf-muted)]">
                  borrowed {{ formatMarketAmount(p.bond.principal, p.bond.market) }}
                </div>
              </div>

              <!-- Due -->
              <div class="min-w-0">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Due</div>
                <div
                  class="sf-mono text-[12.5px] font-semibold"
                  :class="p.bond.maturity - height < 2160 ? 'text-[color:var(--sf-ask)]' : 'text-[color:var(--sf-ink)]'"
                >
                  {{ p.bond.maturity > height ? dateAtHeight(p.bond.maturity, height) : "Now" }}
                </div>
                <div class="sf-mono text-[10px] text-[color:var(--sf-muted)]">
                  {{ p.bond.maturity > height ? `${formatDur(p.bond.maturity - height, unit)} left` : "overdue" }}
                </div>
              </div>

              <!-- Inline Health Meter -->
              <div class="min-w-0">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Health</div>
                <template v-if="healthOf(p) != null">
                  <div class="mt-0.5 flex items-center gap-2">
                    <span
                      class="sf-mono text-[13px] font-bold"
                      :class="
                        healthOf(p)! < 1.05
                          ? 'text-[color:var(--sf-danger)]'
                          : healthOf(p)! < 1.25
                            ? 'text-[color:var(--sf-ask)]'
                            : 'text-[color:var(--sf-bid)]'
                      "
                    >
                      {{ formatNumber(healthOf(p), 2, 2) }}
                    </span>
                    <div class="h-1.5 w-20 overflow-hidden rounded-full bg-[color:var(--sf-line-strong)]">
                      <div
                        class="h-full rounded-full transition-all duration-300"
                        :style="{
                          width: healthBarWidth(healthOf(p)!),
                          backgroundColor:
                            healthOf(p)! < 1.05
                              ? 'var(--sf-danger)'
                              : healthOf(p)! < 1.25
                                ? 'var(--sf-ask)'
                                : 'var(--sf-bid)'
                        }"
                      />
                    </div>
                  </div>
                  <div class="sf-mono text-[10px] text-[color:var(--sf-muted)]">
                    {{ coverOf(p) != null ? `${Math.round(coverOf(p)!)}% cover · ${p.bond.ratio}% min` : "" }}
                  </div>
                </template>
                <span v-else class="sf-mono text-[11px] text-[color:var(--sf-dim)]">Maturity rule</span>
              </div>

              <!-- Liquidation Price -->
              <div class="min-w-0">
                <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Liquidates</div>
                <div class="sf-mono text-[12.5px] font-semibold text-[color:var(--sf-ink)]">
                  {{
                    liqOf(p)?.price != null
                      ? `ERG ${liqOf(p)!.dir === "below" ? "<" : ">"} $${liqOf(p)!.price!.toFixed(3)}`
                      : p.bond.rule === "oracle"
                        ? "No liq price"
                        : "At maturity"
                  }}
                </div>
                <div
                  v-if="liqOf(p)?.price && oraclePrice > 0"
                  class="sf-mono text-[10px] text-[color:var(--sf-muted)]"
                >
                  {{ formatNumber(Math.abs(oraclePrice / liqOf(p)!.price! - 1) * 100, 1, 1) }}% away
                </div>
              </div>

              <!-- Actions (Fixed-width track prevents row text shift) -->
              <div class="flex flex-wrap items-center justify-start gap-1.5 lg:justify-end">
                <button
                  v-if="p.holdsUnit || p.actions?.extinguish?.enabled"
                  type="button"
                  class="sf-btn-bid h-7 rounded-lg px-2.5 text-[11px]"
                  @click="previewExtinguish(p)"
                >
                  Extinguish
                </button>
                <button
                  type="button"
                  class="sf-btn-cobalt h-7 rounded-lg px-2.5 text-[11px] disabled:opacity-45"
                  :disabled="p.bond.maturity <= height + 1"
                  @click="actionModal = { mode: 'repay', position: p }"
                >
                  Repay
                </button>
                <button
                  v-if="p.bond.rule === 'oracle'"
                  type="button"
                  class="sf-btn-outline h-7 rounded-lg px-2.5 text-[11px] font-semibold disabled:opacity-45"
                  :disabled="p.bond.maturity <= height + 1"
                  @click="actionModal = { mode: 'addCollateral', position: p }"
                >
                  Add collateral
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 3: OPEN ORDERS & OFFERS -->
        <div v-else-if="activeTab === 'open'">
          <div
            v-if="openItems.length === 0"
            class="p-10 text-center text-[13px] text-[color:var(--sf-muted)]"
          >
            No resting orders, offers, auctions, or mint requests.
          </div>

          <div v-else class="divide-y divide-[color:var(--sf-line)]">
            <!-- Fixed-Column Desktop Header -->
            <div
              class="sf-mono hidden items-center gap-3 bg-[color:var(--sf-well-inset)]/70 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)] lg:grid lg:grid-cols-[minmax(0,1.65fr)_minmax(0,0.95fr)_minmax(0,0.95fr)_minmax(0,0.95fr)_minmax(0,0.75fr)_176px]"
            >
              <div>Order / Offer</div>
              <div>Rate / Price</div>
              <div>Size / Value</div>
              <div>Terms</div>
              <div>Status</div>
              <div class="text-right">Actions</div>
            </div>

            <div
              v-for="item in openItems"
              :key="item.key"
              class="grid grid-cols-1 items-center gap-3 px-4 py-3 transition-colors hover:bg-[color:var(--sf-well-soft)]/70 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,0.95fr)_minmax(0,0.95fr)_minmax(0,0.95fr)_minmax(0,0.75fr)_176px]"
            >
              <!-- Ask / Borrow Order -->
              <template v-if="item.type === 'ask'">
                <router-link
                  :to="{ name: 'zc-bond', params: { id: item.ask.id } }"
                  class="flex min-w-0 items-center gap-2.5 group"
                >
                  <zc-order-mark :kind="item.ask.kind" :size="32" :market="item.ask.market" />
                  <div class="min-w-0">
                    <div class="truncate text-[13px] font-bold text-[color:var(--sf-ink)] group-hover:text-[color:var(--sf-cobalt)]">
                      {{
                        item.ask.kind === "order"
                          ? "Borrow Order"
                          : item.ask.kind === "shares"
                            ? "Share Resale Ask"
                            : "Bond Resale Ask"
                      }}
                    </div>
                    <div class="sf-mono truncate text-[10.5px] text-[color:var(--sf-dim)]">
                      {{ item.ask.market }} · {{ pricingName(item.ask) }} · exp {{ dateAtHeight(item.ask.expiry, height) }}
                    </div>
                  </div>
                </router-link>

                <div class="min-w-0">
                  <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">APR now</div>
                  <div class="sf-mono text-[13px] font-bold text-[color:var(--sf-ask)]">
                    {{ formatApr(resolvedAskQuote(item.ask, height)?.yieldBps) }}
                  </div>
                </div>

                <div class="min-w-0">
                  <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">
                    {{ item.ask.kind === "order" ? "Receive" : "Sale price" }}
                  </div>
                  <div class="sf-mono text-[13px] font-semibold text-[color:var(--sf-ink)]">
                    {{ formatMarketAmount(resolvedAskQuote(item.ask, height)?.cost, item.ask.market) }}
                  </div>
                </div>

                <div class="min-w-0">
                  <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Cover</div>
                  <cover-meter :value="item.ask.cov" :ratio="item.ask.ratio" compact />
                </div>

                <div>
                  <span
                    class="sf-mono rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase"
                    :class="item.ask.ok ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]' : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'"
                  >
                    {{ item.ask.pending ? "Pending" : item.ask.ok ? "Resting" : item.ask.reason }}
                  </span>
                </div>

                <div class="flex justify-start lg:justify-end">
                  <button
                    type="button"
                    class="sf-btn-outline h-7 rounded-lg px-2.5 text-[11px] font-semibold"
                    @click="previewCancelBox('Cancel Open Order', item.ask.boxId, `${item.ask.market} · ${pricingName(item.ask)}`)"
                  >
                    Cancel
                  </button>
                </div>
              </template>

              <!-- Rolling Lend Offer -->
              <template v-else-if="item.type === 'offer'">
                <router-link
                  :to="{ name: 'zc-offer', params: { id: item.offer.id } }"
                  class="flex min-w-0 items-center gap-2.5 group"
                >
                  <zc-order-mark kind="offer" :size="32" :market="item.offer.market" />
                  <div class="min-w-0">
                    <div class="truncate text-[13px] font-bold text-[color:var(--sf-ink)] group-hover:text-[color:var(--sf-cobalt)]">
                      Lend Offer · {{ item.offer.market }}
                    </div>
                    <div class="sf-mono truncate text-[10.5px] text-[color:var(--sf-dim)]">
                      {{ formatDur(item.offer.minBlocks, unit) }}–{{ formatDur(item.offer.maxBlocks, unit) }} · cov ≥ {{ Math.round(item.offer.floor) }}%
                    </div>
                  </div>
                </router-link>

                <div class="min-w-0">
                  <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Capital left</div>
                  <div class="sf-mono text-[13px] font-bold text-[color:var(--sf-bid)]">
                    {{ formatMarketAmount(item.offer.capital, item.offer.market) }}
                  </div>
                  <div class="sf-mono truncate text-[10px] text-[color:var(--sf-muted)]">
                    of {{ formatMarketAmount(offerPerf(item.offer).funded, item.offer.market) }}
                  </div>
                </div>

                <div class="min-w-0">
                  <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Deployed / P&amp;L</div>
                  <div class="sf-mono text-[12.5px] font-semibold text-[color:var(--sf-ink)]">
                    {{ formatMarketAmount(offerPerf(item.offer).deployed, item.offer.market) }}
                  </div>
                  <div
                    v-if="offerPerf(item.offer).rows.length > 0"
                    class="sf-mono truncate text-[10px] font-semibold"
                    :class="pnlTone(offerPerf(item.offer).pnl) === 'bid' ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-danger)]'"
                  >
                    {{ fmtMarketSigned(offerPerf(item.offer).pnl, item.offer.market) }} · {{ offerPerf(item.offer).rows.length }} bond{{ offerPerf(item.offer).rows.length === 1 ? "" : "s" }}
                  </div>
                </div>

                <!-- Inline Curve Sparkline -->
                <div class="min-w-0">
                  <div class="sf-mono text-[9.5px] text-[color:var(--sf-muted)]">
                    min {{ formatApr(item.offer.minYieldBps) }}
                  </div>
                  <svg viewBox="0 0 84 22" class="mt-0.5 h-5 w-[84px]" aria-hidden="true">
                    <path
                      :d="sparkPath(item.offer.points)"
                      fill="none"
                      stroke="var(--sf-bid)"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </div>

                <div>
                  <span
                    class="sf-mono rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase"
                    :class="item.offer.ok ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]' : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'"
                  >
                    {{ item.offer.pending ? "Pending" : item.offer.ok ? "Bidding" : item.offer.reason }}
                  </span>
                </div>

                <div class="flex justify-start lg:justify-end">
                  <button
                    type="button"
                    class="sf-btn-outline h-7 rounded-lg px-2.5 text-[11px] font-semibold"
                    @click="previewCancelBox('Cancel Lend Offer', item.offer.boxId, `${formatMarketAmount(item.offer.capital, item.offer.market)} returned`)"
                  >
                    Cancel
                  </button>
                </div>
              </template>

              <!-- Open Sale Auction Lot -->
              <template v-else-if="item.type === 'lot'">
                <router-link
                  to="/app/auctions"
                  class="flex min-w-0 items-center gap-2.5 group"
                >
                  <zc-order-mark
                    v-if="item.lot.items[0] && (item.lot.items[0].kind === 'bond' || item.lot.items[0].kind === 'shares')"
                    :kind="item.lot.items[0].kind === 'shares' ? 'shares' : 'unit'"
                    :size="32"
                  />
                  <asset-icon
                    v-else-if="item.lot.items[0] && item.lot.items[0].kind !== 'receipt'"
                    :token-id="item.lot.items[0].id"
                    custom-class="h-8 w-8 rounded-full object-cover"
                  />
                  <market-coin v-else :market="item.lot.market" :size="32" />
                  <div class="min-w-0">
                    <div class="truncate text-[13px] font-bold text-[color:var(--sf-ink)] group-hover:text-[color:var(--sf-cobalt)]">
                      Sale Auction · {{ item.lot.itemCount }} items
                    </div>
                    <div class="sf-mono truncate text-[10.5px] text-[color:var(--sf-dim)]">
                      {{ item.lot.items.map((x) => x.ticker).join(", ") }}{{ item.lot.erg > 0 ? " + ERG" : "" }}
                    </div>
                  </div>
                </router-link>

                <div class="min-w-0">
                  <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Price now</div>
                  <div class="sf-mono text-[13px] font-bold text-[color:var(--sf-ask)]">
                    {{ formatMarketAmount(item.lot.priceNow ?? lotPriceAt(item.lot, height), item.lot.market) }}
                  </div>
                </div>

                <div class="min-w-0">
                  <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Floor</div>
                  <div class="sf-mono text-[12.5px] font-semibold text-[color:var(--sf-ink)]">
                    {{ formatMarketAmount(item.lot.floor, item.lot.market) }}
                  </div>
                  <div class="sf-mono text-[10px] text-[color:var(--sf-muted)]">floor</div>
                </div>

                <div class="min-w-0">
                  <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Ends</div>
                  <div class="sf-mono text-[12.5px] text-[color:var(--sf-ink-2)]">
                    {{ dateAtHeight(item.lot.expiry, height) }}
                  </div>
                </div>

                <div>
                  <span class="sf-mono rounded-[5px] bg-[color:var(--sf-bid-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-[color:var(--sf-bid)]">
                    {{ item.lot.phase }}
                  </span>
                </div>

                <div class="flex justify-start lg:justify-end">
                  <button
                    type="button"
                    class="sf-btn-outline h-7 rounded-lg px-2.5 text-[11px] font-semibold"
                    @click="previewCancelBox('Cancel Sale Auction', item.lot.boxId, `${item.lot.itemCount} items returned`)"
                  >
                    Cancel
                  </button>
                </div>
              </template>

              <!-- Share Mint Request -->
              <template v-else>
                <router-link
                  :to="{ name: 'zc-bond', params: { id: item.req.bondId } }"
                  class="flex min-w-0 items-center gap-2.5 group"
                >
                  <zc-order-mark kind="shares" :size="32" />
                  <div class="min-w-0">
                    <div class="truncate text-[13px] font-bold text-[color:var(--sf-ink)] group-hover:text-[color:var(--sf-cobalt)]">
                      Share Mint Request
                    </div>
                    <div class="sf-mono truncate text-[10.5px] text-[color:var(--sf-dim)]">
                      Bond {{ shortenString(item.req.bondId, 14) }}
                    </div>
                  </div>
                </router-link>

                <div class="min-w-0 lg:col-span-3">
                  <div class="sf-mono text-[9.5px] uppercase text-[color:var(--sf-dim)] lg:hidden">Request box</div>
                  <div class="sf-mono truncate text-[12px] text-[color:var(--sf-ink-2)]">
                    Box {{ shortenString(item.req.boxId, 18) }}
                  </div>
                </div>

                <div>
                  <span class="sf-mono rounded-[5px] bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-[color:var(--sf-ask)]">
                    Waiting batcher
                  </span>
                </div>

                <div class="flex items-center justify-start gap-1.5 lg:justify-end">
                  <button
                    type="button"
                    class="sf-btn-cobalt h-7 rounded-lg px-2.5 text-[11px]"
                    @click="previewRunMint('Mint Bond Shares', item.req.boxId)"
                  >
                    Run batcher
                  </button>
                  <button
                    type="button"
                    class="sf-btn-outline h-7 rounded-lg px-2.5 text-[11px]"
                    @click="previewCancelBox('Cancel Mint Request', item.req.boxId, 'Returns bond unit')"
                  >
                    Cancel
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- TAB 4: CUSTODY WRAPS & WALLET ASSETS -->
        <div v-else class="space-y-4 p-4">
          <!-- Wraps & Wrappable LP NFTs -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                Custody Wraps &amp; LP NFTs
              </span>
              <router-link
                :to="{ name: 'zc-studio', query: { type: 'wrap' } }"
                class="sf-mono inline-flex items-center gap-1 text-[11px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
              >
                <package-icon class="h-3 w-3" />
                <span>Wrap Studio</span>
              </router-link>
            </div>

            <div
              v-if="rawWrappableNfts.length === 0 && zc.portfolio.wraps.length === 0"
              class="sf-dock-well rounded-xl p-4 text-[12px] text-[color:var(--sf-muted)]"
            >
              No wrapped receipts or wrappable NFTs detected.
            </div>

            <div v-else class="divide-y divide-[color:var(--sf-line)] overflow-hidden rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)]">
              <!-- Fixed-Column Desktop Header -->
              <div
                class="sf-mono hidden items-center gap-3 bg-[color:var(--sf-well-inset)]/70 px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)] lg:grid lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1.2fr)_110px_176px]"
              >
                <div>Asset / Receipt</div>
                <div>Details</div>
                <div>Status</div>
                <div class="text-right">Actions</div>
              </div>

              <div
                v-for="t in rawWrappableNfts"
                :key="t.id"
                class="grid grid-cols-1 items-center gap-3 px-3.5 py-2.5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1.2fr)_110px_176px]"
              >
                <div class="flex min-w-0 items-center gap-2">
                  <zc-asset-chip :token="t" :height="height" variant="chip" />
                </div>
                <div class="sf-mono min-w-0 truncate text-[10.5px] text-[color:var(--sf-dim)]">
                  {{ t.pool ? `${t.pool} · ` : "" }}{{ shortenString(t.id, 14) }}
                  <template v-if="t.liquidity"> · Liq {{ t.liquidity }}</template>
                  <template v-if="t.fees"> · Fees {{ t.fees }}</template>
                </div>
                <div>
                  <span class="sf-mono rounded bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-[color:var(--sf-ask)]">
                    Raw NFT
                  </span>
                </div>
                <div class="flex justify-start lg:justify-end">
                  <button
                    type="button"
                    class="sf-btn-cobalt h-7 rounded-lg px-3 text-[11px]"
                    @click="previewWrapNft(t)"
                  >
                    Wrap
                  </button>
                </div>
              </div>

              <div
                v-for="w in zc.portfolio.wraps"
                :key="w.id"
                class="grid grid-cols-1 items-center gap-3 px-3.5 py-2.5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1.2fr)_110px_176px]"
              >
                <div class="flex min-w-0 items-center gap-2">
                  <zc-asset-chip :token="w.receipt" :height="height" variant="chip" />
                </div>

                <div class="sf-mono min-w-0 truncate text-[10.5px] text-[color:var(--sf-dim)]">
                  {{ w.receipt.ticker }} · 0.03 ERG reserve
                  <template v-if="w.refreshFrom"> · refresh {{ dateAtHeight(w.refreshFrom, height) }}</template>
                </div>

                <div>
                  <span
                    class="sf-mono rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase"
                    :class="
                      w.state === 'requested'
                        ? 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                        : w.inWallet
                          ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                          : 'bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                    "
                  >
                    {{ w.state === "requested" ? "Minting" : w.inWallet ? "In wallet" : "Pledged" }}
                  </span>
                </div>

                <div class="flex items-center justify-start gap-1.5 lg:justify-end">
                  <template v-if="w.state === 'requested'">
                    <button
                      type="button"
                      class="sf-btn-cobalt h-7 rounded-lg px-2.5 text-[11px]"
                      @click="previewRunMint('Mint Wrap Receipt', w.boxId || w.id)"
                    >
                      Run batcher
                    </button>
                    <button
                      type="button"
                      class="sf-btn-outline h-7 rounded-lg px-2.5 text-[11px]"
                      @click="previewCancelBox('Cancel Wrap Request', w.boxId || w.id, `Returns ${w.token.ticker}`)"
                    >
                      Cancel
                    </button>
                  </template>
                  <button
                    v-else-if="w.inWallet"
                    type="button"
                    class="sf-btn-outline h-7 rounded-lg px-3 text-[11px] font-semibold"
                    @click="previewUnwrap(w)"
                  >
                    Unwrap
                  </button>
                  <span v-else class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">Locked in loan</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Wallet Token Inventory -->
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <span class="sf-mono block text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                Wallet Balances
              </span>
              <span
                v-if="wallet.hasPendingTx"
                class="sf-mono rounded bg-[color:var(--sf-warn-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[color:var(--sf-warn)]"
              >
                Mempool pending
              </span>
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <div class="flex items-center justify-between rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 py-2">
                <div class="flex items-center gap-2">
                  <market-coin market="ERG" :size="20" />
                  <span class="text-[13px] font-bold text-[color:var(--sf-ink)]">ERG</span>
                </div>
                <div class="sf-mono text-right">
                  <div class="text-[12.5px] font-bold text-[color:var(--sf-ink)]">
                    {{ formatNumber(zc.portfolio.walletErg, 3, 0) }}
                  </div>
                  <div
                    v-if="pendingErgDelta !== null"
                    class="text-[9.5px] font-semibold"
                    :class="pendingErgDelta > 0 ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-warn)]'"
                  >
                    {{ formatPendingChip(pendingErgDelta, 3) }}
                  </div>
                  <div class="text-[10px] text-[color:var(--sf-muted)]">
                    ${{ formatNumber(zc.portfolio.walletErg * oraclePrice, 2, 0) }}
                  </div>
                </div>
              </div>

              <div class="flex items-center justify-between rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 py-2">
                <div class="flex items-center gap-2">
                  <market-coin market="SigUSD" :size="20" />
                  <span class="text-[13px] font-bold text-[color:var(--sf-ink)]">SigUSD</span>
                </div>
                <div class="sf-mono text-right">
                  <div class="text-[12.5px] font-bold text-[color:var(--sf-ink)]">
                    {{ formatNumber(zc.portfolio.walletSigUsd, 2, 2) }}
                  </div>
                  <div
                    v-if="pendingSigUsdDelta !== null"
                    class="text-[9.5px] font-semibold"
                    :class="pendingSigUsdDelta > 0 ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-warn)]'"
                  >
                    {{ formatPendingChip(pendingSigUsdDelta, 2) }}
                  </div>
                  <div class="text-[10px] text-[color:var(--sf-muted)]">
                    ${{ formatNumber(zc.portfolio.walletSigUsd, 2, 0) }}
                  </div>
                </div>
              </div>

              <div
                v-for="t in zc.portfolio.walletTokens.filter((x) => x.kind === 'token')"
                :key="t.id"
                class="flex items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 py-2"
              >
                <div class="flex min-w-0 items-center gap-2">
                  <asset-icon :token-id="t.id" custom-class="h-5 w-5 shrink-0 rounded-full object-cover" />
                  <span class="truncate text-[13px] font-bold text-[color:var(--sf-ink)]">
                    {{ t.ticker }}
                  </span>
                </div>
                <div class="sf-mono shrink-0 text-right">
                  <div class="text-[12.5px] font-bold text-[color:var(--sf-ink)]">
                    {{ formatNumber(t.amount, Math.min(4, t.decimals), 0) }}
                  </div>
                  <div
                    v-if="pendingTokenDelta(t.id, t.decimals) !== null"
                    class="text-[9.5px] font-semibold"
                    :class="
                      (pendingTokenDelta(t.id, t.decimals) ?? 0) > 0
                        ? 'text-[color:var(--sf-bid)]'
                        : 'text-[color:var(--sf-warn)]'
                    "
                  >
                    {{ formatPendingChip(pendingTokenDelta(t.id, t.decimals) ?? 0, Math.min(4, t.decimals)) }}
                  </div>
                  <div v-if="t.usd && t.usd > 0" class="text-[10px] text-[color:var(--sf-muted)]">
                    ${{ formatNumber(t.amount * t.usd, 2, 0) }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- Interactive Repay / Add Collateral Modal -->
    <transition name="sf-modal">
      <portfolio-action-modal
        v-if="actionModal"
        :mode="actionModal.mode"
        :position="actionModal.position"
        :height="height"
        :oracle-price="oraclePrice"
        :wallet-erg="zc.portfolio.walletErg"
        :wallet-sig-usd="zc.portfolio.walletSigUsd"
        :unit="unit"
        @close="actionModal = null"
        @preview="
          actionModal = null;
          previewPayload = $event;
        "
      />
    </transition>

    <!-- Execution Preview Modal -->
    <transition name="sf-modal">
      <execution-preview-modal
        v-if="previewPayload"
        :payload="previewPayload"
        @close="previewPayload = null"
        @submitted="onTxSubmitted"
      />
    </transition>
  </div>
</template>
