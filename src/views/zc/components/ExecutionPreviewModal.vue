<script setup lang="ts">
import { Amount, Box, SignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  ShieldIcon,
  XIcon,
  ZapIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { VERIFIED_ASSETS } from "@/maps/verifiedAssets";
import {
  buildZcAction,
  createZcTxDeps,
  explorerTxUrl,
  formatNautilusError,
  quoteZcAction,
  resolveWalletLendStep,
  signAndSubmitZcAction,
  ZcBuiltTx,
  ZcExecutableAction,
  ZcTxAction,
  ZcTxConflictError,
  ZcTxDeps,
  ZcTxQuote
} from "@/services/zcTx";
import { useChainStore, useWalletStore, useZcStore } from "@/stories";
import { shortenString, showToast } from "@/utils";
import {
  formatMarketAmount,
  formatNumber,
  fromRaw,
  SHARES_UNITS,
  shareTotalOf,
  SIGUSD_TOKEN_ID
} from "@/utils/zcMath";

export interface PreviewRow {
  label: string;
  value: string;
  tone?: "bid" | "ask" | "cobalt" | "default";
}

export interface ExecutionPreviewPayload {
  title: string;
  subtitle: string;
  badge: string;
  tone?: "bid" | "ask" | "cobalt";
  heroLabel: string;
  heroValue: string;
  heroSub?: string;
  rows: PreviewRow[];
  rawSummary: Record<string, unknown>;
  txAction?: ZcExecutableAction | null;
  studioRedirect?: {
    name: string;
    query?: Record<string, string>;
    label: string;
  } | null;
}

const props = defineProps<{
  payload: ExecutionPreviewPayload;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "submitted", txIds: string[]): void;
}>();

const router = useRouter();
const chain = useChainStore();
const wallet = useWalletStore();
const zc = useZcStore();

const VERIFIED_BY_ID = new Map(
  VERIFIED_ASSETS.map((a) => [a.tokenId.toLowerCase(), a.metadata])
);

type ExecPhase = "idle" | "quoting" | "ready" | "signing" | "submitted" | "partial" | "error";

const phase = ref<ExecPhase>("idle");
const copied = ref(false);
const copiedTxId = ref<string | null>(null);
const liveQuote = ref<ZcTxQuote | null>(null);
const resolvedBatch = ref<
  {
    readonly label: string;
    readonly action: ZcTxAction;
    readonly quote: ZcTxQuote;
  }[]
>([]);
const batchProgress = ref<{ current: number; total: number } | null>(null);
const submittedTxs = ref<{ txId: string; label: string }[]>([]);
const errorMsg = ref<string | null>(null);
const needsRequote = ref(false);

const auditOpen = ref(false);
const auditLoading = ref(false);
const auditError = ref<string | null>(null);
const inspectedTx = ref<ZcBuiltTx | null>(null);

const isBatch = computed(() => props.payload.txAction?.type === "walletLendBatch");
const hasExecutable = computed(() => !!props.payload.txAction);

const allRefusals = computed<string[]>(() => {
  if (isBatch.value) {
    return resolvedBatch.value.flatMap((s) =>
      s.quote.refusals.map((r) => `${s.label}: ${r}`)
    );
  }
  return liveQuote.value ? [...liveQuote.value.refusals] : [];
});

const allWarnings = computed<string[]>(() => {
  const list = isBatch.value
    ? resolvedBatch.value.flatMap((s) => s.quote.warnings)
    : liveQuote.value
      ? [...liveQuote.value.warnings]
      : [];
  return Array.from(new Set(list));
});

const quoteFlowSummary = computed(() => {
  const quotes = isBatch.value
    ? resolvedBatch.value.map((s) => s.quote)
    : liveQuote.value
      ? [liveQuote.value]
      : [];
  if (quotes.length === 0) return null;

  let netErg = 0n;
  const netTokens = new Map<string, bigint>();
  let totalMinerFee = 0n;

  for (const q of quotes) {
    netErg += q.receivesNanoErgs - q.paysNanoErgs;
    for (const f of q.fees) {
      if (f.name === "miner") totalMinerFee += f.nanoErg;
    }
    for (const t of q.paysTokens) {
      netTokens.set(t.tokenId, (netTokens.get(t.tokenId) ?? 0n) - t.amount);
    }
    for (const t of q.receivesTokens) {
      netTokens.set(t.tokenId, (netTokens.get(t.tokenId) ?? 0n) + t.amount);
    }
  }

  const tokenFlows = Array.from(netTokens.entries())
    .filter(([, amt]) => amt !== 0n)
    .map(([tokenId, amt]) => {
      const low = tokenId.toLowerCase();
      if (low === SIGUSD_TOKEN_ID) {
        const val = Number(amt < 0n ? -amt : amt) / 100;
        return {
          tokenId: low,
          label: `${amt > 0n ? "+" : "-"}${formatMarketAmount(val, "SigUSD")}`,
          positive: amt > 0n
        };
      }
      const abs = amt < 0n ? -amt : amt;
      const sign = amt > 0n ? "+" : "-";
      const sharePos = zc.portfolio.positions.find(
        (p) => p.kind === "shares" && (p.tokenId?.toLowerCase() === low || p.id.toLowerCase() === low)
      );
      const quoteTerms = quotes.find(
        (q) =>
          (typeof q.terms.tokenId === "string" && q.terms.tokenId.toLowerCase() === low) ||
          (typeof q.terms.shareTokenId === "string" && q.terms.shareTokenId.toLowerCase() === low) ||
          (typeof q.terms.assetId === "string" && q.terms.assetId.toLowerCase() === low) ||
          (typeof q.terms.orderBoxId === "string" && q.terms.orderBoxId.toLowerCase() === low)
      )?.terms;
      if (sharePos || quoteTerms?.kind === "shares") {
        const denom = sharePos ? shareTotalOf(sharePos) : SHARES_UNITS;
        const pct = (Number(abs) / denom) * 100;
        return {
          tokenId: low,
          label: `${sign}${formatNumber(pct, 2, 0)}% Shares · ${shortenString(low, 10)}`,
          positive: amt > 0n
        };
      }
      if (
        quoteTerms?.kind === "bondUnit" ||
        (typeof quoteTerms?.orderBoxId === "string" && quoteTerms.orderBoxId.toLowerCase() === low)
      ) {
        return {
          tokenId: low,
          label: `${sign}${abs.toString()} Bond Unit · ${shortenString(low, 10)}`,
          positive: amt > 0n
        };
      }
      const wTok = zc.portfolio.walletTokens.find((t) => t.id.toLowerCase() === low);
      const cMeta = chain.tokensMetadata[low] || VERIFIED_BY_ID.get(low);
      const dec =
        wTok && !wTok.decimalsUnknown
          ? wTok.decimals
          : cMeta?.decimals != null
            ? cMeta.decimals
            : null;
      const name = wTok?.ticker || cMeta?.name || shortenString(low, 10);
      if (dec !== null) {
        const scaled = fromRaw(abs.toString(), dec) ?? Number(abs);
        return {
          tokenId: low,
          label: `${sign}${formatNumber(scaled, Math.min(6, dec), 0)} ${name}`,
          positive: amt > 0n
        };
      }
      return {
        tokenId: low,
        label: `${sign}${abs.toString()} raw · ${name}`,
        positive: amt > 0n
      };
    });

  return {
    netErg,
    minerFee: totalMinerFee,
    tokenFlows,
    txCount: quotes.length
  };
});

const canSign = computed(() => {
  if (!hasExecutable.value || zc.demoMode || !wallet.connected) return false;
  if (phase.value !== "ready" && phase.value !== "error") return false;
  if (allRefusals.value.length > 0) return false;
  if (isBatch.value) return resolvedBatch.value.length > 0;
  return liveQuote.value !== null;
});

function formatNanoErg(nano: bigint): string {
  const abs = nano < 0n ? -nano : nano;
  const erg = Number(abs) / 1e9;
  const sign = nano > 0n ? "+" : nano < 0n ? "-" : "";
  return `${sign}${formatNumber(erg, 4, 0)} ERG`;
}

function getDeps() {
  return createZcTxDeps(wallet);
}

async function runQuote() {
  const action = props.payload.txAction;
  if (!action || !wallet.connected || zc.demoMode) {
    phase.value = "idle";
    return;
  }

  phase.value = "quoting";
  errorMsg.value = null;
  needsRequote.value = false;
  liveQuote.value = null;
  resolvedBatch.value = [];
  inspectedTx.value = null;
  auditError.value = null;

  try {
    const deps = getDeps();
    if (action.type === "walletLendBatch") {
      const items: { label: string; action: ZcTxAction; quote: ZcTxQuote }[] = [];
      for (const step of action.steps) {
        const concrete = await resolveWalletLendStep(step, deps);
        const q = await quoteZcAction(concrete, deps);
        items.push({ label: step.label, action: concrete, quote: q });
      }
      resolvedBatch.value = items;
    } else {
      liveQuote.value = await quoteZcAction(action, deps);
    }
    phase.value = "ready";
  } catch (err) {
    errorMsg.value = formatNautilusError(err);
    phase.value = "error";
  }
}

async function toggleAuditDrawer() {
  auditOpen.value = !auditOpen.value;
  if (!auditOpen.value || inspectedTx.value || auditLoading.value) return;
  if (!wallet.connected || zc.demoMode || allRefusals.value.length > 0) return;

  const action = isBatch.value
    ? resolvedBatch.value[0]?.action ?? null
    : props.payload.txAction && props.payload.txAction.type !== "walletLendBatch"
      ? props.payload.txAction
      : null;
  if (!action) return;

  auditLoading.value = true;
  auditError.value = null;
  try {
    const limits = isBatch.value
      ? resolvedBatch.value[0]?.quote.suggestedLimits
      : liveQuote.value?.suggestedLimits;
    inspectedTx.value = await buildZcAction(action, getDeps(), limits);
  } catch (err) {
    auditError.value = formatNautilusError(err);
    if (err instanceof ZcTxConflictError) needsRequote.value = true;
  } finally {
    auditLoading.value = false;
  }
}

function createSequentialBatchDeps(baseDeps: ZcTxDeps): ZcTxDeps {
  const localSpentIds = new Set<string>();
  const localCreatedBoxes = new Map<string, Box<Amount>>();
  let walletTrees: Set<string> | null = null;

  async function ensureWalletTrees(): Promise<Set<string>> {
    if (walletTrees) return walletTrees;
    const addrs = await baseDeps.wallet.getAddresses();
    const set = new Set<string>();
    for (const a of [addrs.changeAddress, ...addrs.usedAddresses, ...addrs.unusedAddresses]) {
      try {
        if (a && a.trim()) set.add(ErgoAddress.fromBase58(a.trim()).ergoTree.toLowerCase());
      } catch {
        // ignore invalid address string
      }
    }
    walletTrees = set;
    return set;
  }

  return {
    ...baseDeps,
    wallet: {
      ...baseDeps.wallet,
      async getUtxos(force = false) {
        const live = await baseDeps.wallet.getUtxos(force);
        const merged = new Map<string, Box<Amount>>();
        for (const box of live) {
          const id = String(box.boxId).toLowerCase();
          if (localSpentIds.has(id)) continue;
          merged.set(id, box);
        }
        for (const [id, box] of localCreatedBoxes) {
          if (localSpentIds.has(id)) continue;
          if (!merged.has(id)) merged.set(id, box);
        }
        return Array.from(merged.values());
      },
      async submitTx(signedTx: SignedTransaction) {
        const txId = await baseDeps.wallet.submitTx(signedTx);
        const trees = await ensureWalletTrees();
        for (const inp of signedTx.inputs || []) {
          const id = String(inp.boxId).toLowerCase();
          localSpentIds.add(id);
          localCreatedBoxes.delete(id);
        }
        for (const out of signedTx.outputs || []) {
          if (!out.boxId || !out.ergoTree) continue;
          const tree = String(out.ergoTree).toLowerCase();
          if (!trees.has(tree)) continue;
          const id = String(out.boxId).toLowerCase();
          if (localSpentIds.has(id)) continue;
          localCreatedBoxes.set(id, out as unknown as Box<Amount>);
        }
        return txId;
      }
    }
  };
}

async function executeSign() {
  if (!canSign.value) return;
  const action = props.payload.txAction;
  if (!action) return;

  phase.value = "signing";
  errorMsg.value = null;
  needsRequote.value = false;
  submittedTxs.value = [];

  try {
    const deps = getDeps();

    if (action.type === "walletLendBatch") {
      const batchDeps = createSequentialBatchDeps(deps);
      const steps = resolvedBatch.value;
      batchProgress.value = { current: 0, total: steps.length };
      for (let i = 0; i < steps.length; i++) {
        batchProgress.value = { current: i + 1, total: steps.length };
        const step = steps[i];
        const res = await signAndSubmitZcAction(
          step.action,
          batchDeps,
          step.quote.suggestedLimits
        );
        submittedTxs.value.push({ txId: res.txId, label: step.label });
      }
      batchProgress.value = null;
    } else {
      const res = await signAndSubmitZcAction(
        action,
        deps,
        liveQuote.value?.suggestedLimits
      );
      inspectedTx.value = res.built;
      submittedTxs.value.push({ txId: res.txId, label: props.payload.title });
    }

    phase.value = "submitted";
    const ids = submittedTxs.value.map((x) => x.txId);
    showToast(
      ids.length > 1
        ? `${ids.length} transactions submitted to Ergo!`
        : `Transaction submitted: ${shortenString(ids[0], 14)}`,
      "alert-success"
    );
    emit("submitted", ids);
    const hergmesLive = zc.dataSource === "hergmes" && zc.streamPhase === "live";
    if (!wallet.liveOverlayActive) {
      void wallet.getBoxes(true);
    }
    if (!hergmesLive) {
      void zc.refresh();
      void zc.refreshPortfolio();
    }
  } catch (err) {
    batchProgress.value = null;
    errorMsg.value = formatNautilusError(err);
    needsRequote.value = err instanceof ZcTxConflictError;
    phase.value = submittedTxs.value.length > 0 ? "partial" : "error";
    if (submittedTxs.value.length > 0) {
      showToast(
        `${submittedTxs.value.length} of ${resolvedBatch.value.length} batch transactions submitted before stopping.`,
        "alert-error"
      );
      emit(
        "submitted",
        submittedTxs.value.map((x) => x.txId)
      );
      if (!wallet.liveOverlayActive) {
        void wallet.getBoxes(true);
      }
    }
  }
}

function goStudioRedirect() {
  const redir = props.payload.studioRedirect;
  if (!redir) return;
  emit("close");
  void router.push({ name: redir.name, query: redir.query });
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && phase.value !== "signing") emit("close");
}

onMounted(() => {
  document.addEventListener("keydown", onKey);
  if (wallet.connected && hasExecutable.value && !zc.demoMode) {
    void runQuote();
  }
});

onBeforeUnmount(() => document.removeEventListener("keydown", onKey));

watch(
  () => wallet.connected,
  (isConn, wasConn) => {
    if (isConn && !wasConn && hasExecutable.value && !zc.demoMode) {
      void runQuote();
    }
  }
);

async function copyJson() {
  try {
    const content = inspectedTx.value
      ? {
          unsignedTx: inspectedTx.value.unsignedTx,
          nautilusV3Signers: inspectedTx.value.signers
        }
      : props.payload.rawSummary;
    await navigator.clipboard.writeText(JSON.stringify(content, null, 2));
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1800);
  } catch {
    // clipboard unavailable
  }
}

async function copyTxId(txId: string) {
  try {
    await navigator.clipboard.writeText(txId);
    copiedTxId.value = txId;
    window.setTimeout(() => {
      copiedTxId.value = null;
    }, 1800);
  } catch {
    // clipboard unavailable
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-md"
    role="dialog"
    aria-modal="true"
    :aria-label="payload.title"
    @click.self="phase !== 'signing' && emit('close')"
  >
    <div
      class="sf-modal-card sf-action-dock flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-[24px] rounded-tr-[8px]"
      :data-tone="payload.tone || 'cobalt'"
    >
      <!-- Header -->
      <div class="sf-panel-head flex shrink-0 items-start justify-between gap-3 px-5 py-4">
        <div>
          <span
            class="sf-mono inline-block rounded-[4px] border px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.11em]"
            :class="
              payload.tone === 'bid'
                ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                : payload.tone === 'ask'
                  ? 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                  : 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
            "
          >
            {{ payload.badge }}
          </span>
          <h3 class="sf-display mt-1.5 text-[20px] font-bold leading-tight text-[color:var(--sf-ink)]">
            {{ payload.title }}
          </h3>
          <p class="mt-0.5 text-[12px] text-[color:var(--sf-muted)]">
            {{ payload.subtitle }}
          </p>
        </div>

        <button
          type="button"
          :disabled="phase === 'signing'"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[color:var(--sf-muted)] transition-all hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)] active:scale-90 disabled:opacity-40"
          aria-label="Close preview"
          @click="emit('close')"
        >
          <x-icon class="h-4 w-4" />
        </button>
      </div>

      <!-- Scrollable Modal Body -->
      <div class="sf-scroll min-h-0 flex-1 overflow-y-auto">
        <!-- Hero Readout -->
        <div class="border-b border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-5 py-4">
          <div class="sf-mono text-[10px] uppercase tracking-[0.11em] text-[color:var(--sf-muted)]">
            {{ payload.heroLabel }}
          </div>
          <div
            class="sf-serif mt-1 text-[32px] font-semibold leading-none"
            :class="
              payload.tone === 'bid'
                ? 'text-[color:var(--sf-bid)]'
                : payload.tone === 'ask'
                  ? 'text-[color:var(--sf-ask)]'
                  : 'text-[color:var(--sf-ink)]'
            "
          >
            {{ payload.heroValue }}
          </div>
          <div v-if="payload.heroSub" class="sf-mono mt-1.5 text-[12px] text-[color:var(--sf-ink-2)]">
            {{ payload.heroSub }}
          </div>
        </div>

        <!-- Terms Table -->
        <dl class="divide-y divide-[color:var(--sf-line)] px-5 py-1">
          <div
            v-for="row in payload.rows"
            :key="row.label"
            class="flex items-center justify-between gap-4 py-2.5 text-[12px]"
          >
            <dt class="text-[color:var(--sf-muted)]">{{ row.label }}</dt>
            <dd
              class="sf-mono text-right font-semibold"
              :class="
                row.tone === 'bid'
                  ? 'text-[color:var(--sf-bid)]'
                  : row.tone === 'ask'
                    ? 'text-[color:var(--sf-ask)]'
                    : row.tone === 'cobalt'
                      ? 'text-[color:var(--sf-cobalt)]'
                      : 'text-[color:var(--sf-ink)]'
              "
            >
              {{ row.value }}
            </dd>
          </div>
        </dl>

        <!-- Execution / Nautilus v3 Section -->
        <div class="space-y-2.5 px-5 py-3">
          <!-- Submitted / Partially Submitted Result Banner -->
          <div
            v-if="submittedTxs.length > 0"
            class="space-y-2 rounded-xl border p-3.5"
            :class="
              phase === 'partial'
                ? 'border-amber-500/45 bg-amber-500/10'
                : 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)]/70'
            "
          >
            <div
              class="flex items-center gap-2 text-[12.5px] font-semibold"
              :class="phase === 'partial' ? 'text-amber-300' : 'text-[color:var(--sf-bid)]'"
            >
              <alert-triangle-icon v-if="phase === 'partial'" class="h-4 w-4 shrink-0" />
              <check-circle-icon v-else class="h-4 w-4 shrink-0" />
              <span>
                {{
                  phase === "partial"
                    ? `Partially submitted (${submittedTxs.length} of ${resolvedBatch.length} transactions succeeded)`
                    : submittedTxs.length > 1
                      ? `${submittedTxs.length} ErgoTree v3 transactions submitted`
                      : "Transaction submitted to Ergo"
                }}
              </span>
            </div>

            <div class="space-y-1.5">
              <div
                v-for="item in submittedTxs"
                :key="item.txId"
                class="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2.5 py-1.5 text-[11px]"
              >
                <div class="min-w-0">
                  <div v-if="submittedTxs.length > 1" class="truncate text-[10px] text-[color:var(--sf-muted)]">
                    {{ item.label }}
                  </div>
                  <div class="sf-mono truncate font-semibold text-[color:var(--sf-ink)]">
                    {{ shortenString(item.txId, 20) }}
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    class="sf-mono inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
                    @click="copyTxId(item.txId)"
                  >
                    <check-icon v-if="copiedTxId === item.txId" class="h-3 w-3 text-[color:var(--sf-bid)]" />
                    <copy-icon v-else class="h-3 w-3" />
                  </button>
                  <a
                    :href="explorerTxUrl(item.txId)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="sf-mono inline-flex items-center gap-1 rounded bg-[color:var(--sf-cobalt-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-cobalt)] hover:brightness-110"
                  >
                    <span>Explorer</span>
                    <external-link-icon class="h-2.5 w-2.5" />
                  </a>
                </div>
              </div>
            </div>

            <div
              v-if="zc.mempoolActive"
              class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]"
            >
              Live Hergmes mempool active — book &amp; wallet update automatically in ~1–2s.
            </div>
          </div>

          <!-- Demo Mode Notice -->
          <div
            v-if="zc.demoMode && hasExecutable"
            class="flex items-start gap-2.5 rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/55 px-3.5 py-2.5 text-[11.5px] text-[color:var(--sf-ink-2)]"
          >
            <shield-icon class="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--sf-cobalt)]" />
            <div>
              <strong class="font-semibold text-[color:var(--sf-ink)]">Demo Mode active</strong>
              <p class="mt-0.5 text-[color:var(--sf-muted)]">
                Exit Demo Mode to build and sign real ErgoTree v3 transactions with Nautilus.
              </p>
            </div>
          </div>

          <!-- Studio Redirect (for calculator-only previews like OrderTicketPanel Sell) -->
          <div
            v-else-if="!hasExecutable && payload.studioRedirect"
            class="flex items-start gap-2.5 rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/55 px-3.5 py-2.5 text-[11.5px] text-[color:var(--sf-ink-2)]"
          >
            <zap-icon class="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--sf-cobalt)]" />
            <div>
              <strong class="font-semibold text-[color:var(--sf-ink)]">Select a bond token to list</strong>
              <p class="mt-0.5 text-[color:var(--sf-muted)]">
                To sign a resale listing, open Studio Sell to choose the exact bond unit or share lot from your wallet.
              </p>
            </div>
          </div>

          <!-- Disconnected Wallet Prompt -->
          <div
            v-else-if="hasExecutable && !wallet.connected"
            class="flex items-start gap-2.5 rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/55 px-3.5 py-2.5 text-[11.5px] text-[color:var(--sf-ink-2)]"
          >
            <shield-icon class="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--sf-cobalt)]" />
            <div>
              <strong class="font-semibold text-[color:var(--sf-ink)]">
                Nautilus v3 direct signing ready
              </strong>
              <p class="mt-0.5 text-[color:var(--sf-muted)]">
                Connect Nautilus <span class="sf-mono">v2.0.0-beta.3+</span> to validate live chain state, inspect explicit per-input v3 signers, and sign.
              </p>
            </div>
          </div>

          <!-- Live Connected Execution Controls -->
          <template v-else-if="hasExecutable && wallet.connected && !zc.demoMode">
            <!-- Quoting State -->
            <div
              v-if="phase === 'quoting'"
              class="flex items-center gap-2.5 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-3.5 py-3 text-[12px] text-[color:var(--sf-muted)]"
            >
              <refresh-cw-icon class="h-3.5 w-3.5 animate-spin text-[color:var(--sf-cobalt)]" />
              <span class="sf-mono">Validating live boxes, oracle &amp; UTXOs…</span>
            </div>

            <!-- Refusals -->
            <div
              v-if="allRefusals.length > 0"
              class="space-y-1 rounded-xl border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)]/70 px-3.5 py-2.5 text-[11.5px] text-[color:var(--sf-ask)]"
            >
              <div class="flex items-center gap-1.5 font-semibold">
                <alert-triangle-icon class="h-3.5 w-3.5 shrink-0" />
                <span>Cannot execute right now</span>
              </div>
              <p v-for="refusal in allRefusals" :key="refusal" class="leading-relaxed">
                {{ refusal }}
              </p>
            </div>

            <!-- Runtime / Nautilus Error -->
            <div
              v-if="errorMsg"
              class="space-y-1.5 rounded-xl border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)]/70 px-3.5 py-2.5 text-[11.5px] text-[color:var(--sf-ask)]"
            >
              <div class="flex items-center gap-1.5 font-semibold">
                <alert-triangle-icon class="h-3.5 w-3.5 shrink-0" />
                <span>{{ needsRequote ? "On-chain state changed" : "Signing error" }}</span>
              </div>
              <p class="leading-relaxed">{{ errorMsg }}</p>
            </div>

            <!-- Warnings -->
            <div
              v-if="allWarnings.length > 0"
              class="space-y-1 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 text-[11.5px] text-amber-200"
            >
              <div class="flex items-center gap-1.5 font-semibold text-amber-300">
                <alert-triangle-icon class="h-3.5 w-3.5 shrink-0" />
                <span>Protocol notice</span>
              </div>
              <p v-for="w in allWarnings" :key="w" class="leading-relaxed">
                {{ w }}
              </p>
            </div>

            <!-- Verified On-Chain Quote Flows -->
            <div
              v-if="quoteFlowSummary && allRefusals.length === 0 && submittedTxs.length === 0"
              class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-3.5 py-2.5 text-[11.5px]"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="sf-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                  Verified Wallet Flow
                </span>
                <span class="sf-mono text-[10px] text-[color:var(--sf-bid)]">
                  {{
                    quoteFlowSummary.txCount > 1
                      ? `${quoteFlowSummary.txCount} sequential v3 txs`
                      : "ErgoTree v3 · Nautilus"
                  }}
                </span>
              </div>

              <div class="mt-1.5 space-y-1">
                <div class="sf-mono flex items-center justify-between">
                  <span class="text-[color:var(--sf-muted)]">Net ERG (incl. fee)</span>
                  <span
                    class="font-semibold"
                    :class="
                      quoteFlowSummary.netErg > 0n
                        ? 'text-[color:var(--sf-bid)]'
                        : quoteFlowSummary.netErg < 0n
                          ? 'text-[color:var(--sf-ink)]'
                          : 'text-[color:var(--sf-muted)]'
                    "
                  >
                    {{ formatNanoErg(quoteFlowSummary.netErg) }}
                  </span>
                </div>
                <div
                  v-for="tf in quoteFlowSummary.tokenFlows"
                  :key="tf.tokenId"
                  class="sf-mono flex items-center justify-between"
                >
                  <span class="text-[color:var(--sf-muted)]">Token</span>
                  <span
                    class="font-semibold"
                    :class="tf.positive ? 'text-[color:var(--sf-bid)]' : 'text-[color:var(--sf-ink)]'"
                  >
                    {{ tf.label }}
                  </span>
                </div>
                <div class="sf-mono flex items-center justify-between text-[10.5px]">
                  <span class="text-[color:var(--sf-dim)]">Miner fee</span>
                  <span class="text-[color:var(--sf-muted)]">
                    {{ formatNanoErg(-quoteFlowSummary.minerFee).replace(/^-/, "") }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Security Audit Drawer: Inspect TX & Nautilus v3 Signers -->
            <div
              v-if="allRefusals.length === 0 && (phase === 'ready' || phase === 'submitted' || phase === 'partial' || phase === 'error')"
              class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)]"
            >
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-left text-[11.5px] font-semibold text-[color:var(--sf-ink-2)] hover:text-[color:var(--sf-ink)]"
                @click="toggleAuditDrawer"
              >
                <span class="flex items-center gap-1.5">
                  <shield-icon class="h-3.5 w-3.5 text-[color:var(--sf-cobalt)]" />
                  <span>
                    {{
                      isBatch
                        ? "Inspect Step 1 TX & Nautilus v3 Signers"
                        : "Inspect TX & Nautilus v3 Signers"
                    }}
                  </span>
                </span>
                <chevron-up-icon v-if="auditOpen" class="h-3.5 w-3.5 text-[color:var(--sf-muted)]" />
                <chevron-down-icon v-else class="h-3.5 w-3.5 text-[color:var(--sf-muted)]" />
              </button>

              <div v-if="auditOpen" class="space-y-2 border-t border-[color:var(--sf-line)] px-3.5 py-2.5 text-[11px]">
                <div v-if="auditLoading" class="sf-mono flex items-center gap-1.5 text-[color:var(--sf-muted)]">
                  <refresh-cw-icon class="h-3 w-3 animate-spin" />
                  <span>Building &amp; verifying transaction invariants…</span>
                </div>
                <div v-else-if="auditError" class="text-[color:var(--sf-ask)]">
                  {{ auditError }}
                </div>
                <template v-else-if="inspectedTx">
                  <div class="flex items-center gap-1.5 text-[10.5px] font-semibold text-[color:var(--sf-bid)]">
                    <check-circle-icon class="h-3.5 w-3.5 shrink-0" />
                    <span>All safety invariants verified (conservation, fee, destinations, signers)</span>
                  </div>

                  <div>
                    <div class="sf-mono mb-1 text-[9.5px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
                      Inputs &amp; Explicit v3 Signers ({{ inspectedTx.signerAudit.length }})
                    </div>
                    <div class="space-y-1">
                      <div
                        v-for="entry in inspectedTx.signerAudit"
                        :key="entry.index"
                        class="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2.5 py-1.5"
                      >
                        <div class="min-w-0">
                          <div class="sf-mono text-[10.5px] font-semibold text-[color:var(--sf-ink)]">
                            #{{ entry.index }} · {{ entry.contractLabel }}
                          </div>
                          <div class="sf-mono truncate text-[9.5px] text-[color:var(--sf-dim)]">
                            {{ shortenString(entry.boxId, 14) }} · {{ formatNanoErg(entry.value).replace(/^\+/, "") }}
                          </div>
                        </div>
                        <span
                          class="sf-mono shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold"
                          :class="
                            entry.signerAddress === null
                              ? 'bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                              : 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                          "
                        >
                          {{
                            entry.signerAddress === null
                              ? "null (no sig)"
                              : shortenString(entry.signerAddress, 12)
                          }}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div class="sf-mono flex items-center justify-between pt-1 text-[10px] text-[color:var(--sf-muted)]">
                    <span>Outputs: {{ inspectedTx.unsignedTx.outputs.length }} (incl. miner fee)</span>
                    <span>Data inputs: {{ inspectedTx.unsignedTx.dataInputs.length }}</span>
                  </div>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-5 py-3"
      >
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="sf-btn-outline inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[11.5px]"
            @click="copyJson"
          >
            <check-icon v-if="copied" class="h-3.5 w-3.5 text-[color:var(--sf-bid)]" />
            <copy-icon v-else class="h-3.5 w-3.5" />
            <span>{{ copied ? "Copied" : inspectedTx ? "Copy TX JSON" : "Copy JSON" }}</span>
          </button>

          <button
            v-if="hasExecutable && wallet.connected && !zc.demoMode && phase !== 'signing' && phase !== 'submitted' && phase !== 'partial'"
            type="button"
            class="sf-btn-outline inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11.5px]"
            :disabled="phase === 'quoting'"
            @click="runQuote"
          >
            <refresh-cw-icon class="h-3 w-3" :class="phase === 'quoting' ? 'animate-spin' : ''" />
            <span>Requote</span>
          </button>
        </div>

        <div class="flex items-center gap-2">
          <button
            v-if="!hasExecutable && payload.studioRedirect"
            type="button"
            class="sf-btn-cobalt h-8 rounded-full px-4 text-[12px]"
            @click="goStudioRedirect"
          >
            {{ payload.studioRedirect.label }}
          </button>

          <button
            v-else-if="hasExecutable && !wallet.connected && !zc.demoMode"
            type="button"
            class="sf-btn-cobalt h-8 rounded-full px-4 text-[12px]"
            @click="wallet.connect('nautilus')"
          >
            Connect Nautilus
          </button>

          <button
            v-else-if="hasExecutable && !zc.demoMode && phase !== 'submitted' && phase !== 'partial'"
            type="button"
            :disabled="!canSign"
            class="inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-45"
            :class="
              payload.tone === 'bid'
                ? 'sf-btn-bid'
                : payload.tone === 'ask'
                  ? 'sf-btn-ask'
                  : 'sf-btn-cobalt'
            "
            @click="executeSign"
          >
            <refresh-cw-icon v-if="phase === 'signing'" class="h-3.5 w-3.5 animate-spin" />
            <span>
              {{
                phase === "signing"
                  ? batchProgress
                    ? `Signing ${batchProgress.current}/${batchProgress.total}…`
                    : "Waiting for Nautilus…"
                  : isBatch && resolvedBatch.length > 1
                    ? `Sign ${resolvedBatch.length} TXs with Nautilus v3`
                    : "Sign with Nautilus v3"
              }}
            </span>
          </button>

          <button
            v-else
            type="button"
            class="sf-btn-cobalt h-8 rounded-full px-4 text-[12px]"
            @click="emit('close')"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
