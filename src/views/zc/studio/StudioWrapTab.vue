<script setup lang="ts">
import { ArrowRightIcon, CheckCircleIcon, PackageIcon, ShieldIcon } from "@zhuowenli/vue-feather-icons";
import { computed, ref, watch } from "vue";
import { ExecutionPreviewPayload } from "../components/ExecutionPreviewModal.vue";
import AssetIcon from "@/components/AssetIcon.vue";
import { useWalletStore, useZcStore } from "@/stories";
import { ZcPortfolioWrap, ZcWalletToken } from "@/types/zc";
import { shortenString } from "@/utils";

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

const wrappableTokens = computed<ZcWalletToken[]>(() =>
  zc.portfolio.walletTokens.filter(
    (t) => t.kind !== "receipt" && t.decimals === 0 && t.amount === 1
  )
);

const selectedTokenId = ref<string>(props.initialTokenId || "");

watch(
  [wrappableTokens, () => props.initialTokenId],
  ([list, init]) => {
    if (init && list.some((t) => t.id === init.toLowerCase())) {
      selectedTokenId.value = init.toLowerCase();
      return;
    }
    if (!selectedTokenId.value || !list.some((t) => t.id === selectedTokenId.value)) {
      selectedTokenId.value = list[0]?.id || "";
    }
  },
  { immediate: true }
);

const selectedToken = computed<ZcWalletToken | null>(
  () => wrappableTokens.value.find((t) => t.id === selectedTokenId.value) || null
);

function onDockPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

function previewWrap(tok: ZcWalletToken) {
  emit("preview", {
    title: "Wrap NFT into Custody Receipt",
    subtitle: "Locks NFT in custody box & mints tradable ZCS-Wrap receipt",
    badge: "Custody Wrap",
    tone: "cobalt",
    heroLabel: "Wrapping cost",
    heroValue: "0.036 ERG",
    heroSub: "Includes 0.03 ERG refundable reserve",
    rows: [
      { label: "Asset", value: tok.ticker },
      { label: "Token ID", value: shortenString(tok.id, 14) },
      { label: "Receipt minted", value: `ZCS-Wrap-${tok.id.slice(0, 6)}` },
      { label: "Custody reserve", value: "0.03 ERG (returned on unwrap)" },
      { label: "Unwrap", value: "Any time by receipt holder", tone: "bid" }
    ],
    rawSummary: { action: "wrapNft", tokenId: tok.id }
  });
}

function previewWrapAction(w: ZcPortfolioWrap, action: "mint" | "cancel" | "unwrap") {
  const titleMap = {
    mint: "Complete Wrap Mint",
    cancel: "Cancel Wrap Request",
    unwrap: "Unwrap Custody Receipt"
  };
  const statusLabel =
    w.state === "requested" ? "Minting" : w.inWallet ? "In wallet" : "Pledged";
  emit("preview", {
    title: titleMap[action],
    subtitle: `${w.token.ticker} · ${shortenString(w.token.id, 14)}`,
    badge: action === "cancel" ? "Cancel Wrap" : "Custody Wrap",
    tone: action === "cancel" ? "ask" : "cobalt",
    heroLabel: "Underlying NFT",
    heroValue: w.token.ticker,
    heroSub: w.receiptId
      ? `Receipt ${shortenString(w.receiptId, 14)}`
      : `Request ${shortenString(w.boxId || w.id, 14)}`,
    rows: [
      { label: "Status", value: statusLabel },
      { label: "Action", value: titleMap[action] }
    ],
    rawSummary: {
      action: action === "mint" ? "mintWrap" : action === "cancel" ? "cancelWrap" : "unwrapNft",
      boxId: w.boxId,
      receiptTokenId: w.receiptId || w.receipt.id,
      innerTokenId: w.token.id
    }
  });
}
</script>

<template>
  <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_348px]">
    <!-- LEFT WORKBENCH -->
    <div class="flex min-h-0 flex-col gap-2.5">
      <!-- Unwrapped Wallet NFTs -->
      <section class="sf-terminal-plate flex min-h-0 flex-1 flex-col rounded-[18px] rounded-tl-[6px] p-3.5">
        <div class="mb-2.5 flex items-center justify-between gap-2">
          <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            Wrappable Wallet NFTs &amp; Positions
          </span>
          <span class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
            {{ wrappableTokens.length }} found
          </span>
        </div>

        <div
          v-if="!wallet.connected"
          class="sf-dock-well flex flex-1 flex-col items-center justify-center rounded-xl p-6 text-center"
        >
          <package-icon class="h-8 w-8 text-[color:var(--sf-cobalt)] opacity-80" />
          <p class="mt-2.5 text-[13px] text-[color:var(--sf-muted)]">
            Connect Nautilus to scan your wallet for wrappable NFTs and LP positions.
          </p>
          <button
            type="button"
            class="sf-btn-cobalt mt-3.5 h-9 rounded-full px-5 text-[12.5px]"
            @click="wallet.connect('nautilus')"
          >
            Connect Nautilus
          </button>
        </div>

        <div
          v-else-if="wrappableTokens.length === 0"
          class="sf-dock-well flex flex-1 flex-col items-center justify-center rounded-xl p-6 text-center"
        >
          <p class="text-[13px] text-[color:var(--sf-muted)]">
            No single-unit NFTs found in the connected Nautilus wallet.
          </p>
        </div>

        <div v-else class="sf-scroll grid flex-1 content-start gap-2 overflow-y-auto pr-0.5 sm:grid-cols-2">
          <button
            v-for="tok in wrappableTokens"
            :key="tok.id"
            type="button"
            class="flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition-all"
            :class="
              selectedTokenId === tok.id
                ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] shadow-sm'
                : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] hover:border-[color:var(--sf-line-strong)]'
            "
            @click="selectedTokenId = tok.id"
          >
            <div class="flex min-w-0 items-center gap-2.5">
              <asset-icon :token-id="tok.id" custom-class="h-6 w-6 shrink-0 rounded-full object-cover" />
              <div class="min-w-0">
                <div class="truncate text-[13px] font-semibold text-[color:var(--sf-ink)]">
                  {{ tok.ticker }}
                </div>
                <div class="sf-mono mt-0.5 text-[10.5px] text-[color:var(--sf-dim)]">
                  {{ shortenString(tok.id, 14) }}
                </div>
              </div>
            </div>
            <span class="sf-mono shrink-0 rounded-md bg-[color:var(--sf-panel)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-cobalt)]">
              NFT
            </span>
          </button>
        </div>
      </section>

      <!-- Existing Wraps -->
      <section class="sf-terminal-plate shrink-0 rounded-[18px] rounded-bl-[6px] p-3.5">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            Your Custody Wraps
          </span>
          <span class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
            {{ zc.portfolio.wraps.length }} active
          </span>
        </div>

        <div
          v-if="zc.portfolio.wraps.length === 0"
          class="sf-dock-well rounded-xl px-3 py-3 text-[12px] text-[color:var(--sf-muted)]"
        >
          No wrapped receipts or pending wrap requests in your wallet.
        </div>

        <div v-else class="sf-scroll max-h-[175px] space-y-1.5 overflow-y-auto pr-0.5">
          <div
            v-for="w in zc.portfolio.wraps"
            :key="w.boxId || w.receiptId || w.id"
            class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 py-2"
          >
            <div class="flex min-w-0 items-center gap-2.5">
              <asset-icon :token-id="w.token.id" custom-class="h-5 w-5 shrink-0 rounded-full object-cover" />
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate text-[12.5px] font-semibold text-[color:var(--sf-ink)]">
                    {{ w.token.ticker }}
                  </span>
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
                <div class="sf-mono text-[10px] text-[color:var(--sf-dim)]">
                  {{ shortenString(w.receiptId || w.token.id, 14) }}
                </div>
              </div>
            </div>

            <div class="flex items-center gap-1.5">
              <template v-if="w.state === 'requested'">
                <button
                  type="button"
                  class="sf-mono rounded-lg border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-2.5 py-1 text-[10.5px] font-semibold text-[color:var(--sf-cobalt)]"
                  @click="previewWrapAction(w, 'mint')"
                >
                  Mint
                </button>
                <button
                  type="button"
                  class="sf-mono rounded-lg border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] px-2.5 py-1 text-[10.5px] font-semibold text-[color:var(--sf-ask)]"
                  @click="previewWrapAction(w, 'cancel')"
                >
                  Cancel
                </button>
              </template>
              <button
                v-else-if="w.inWallet"
                type="button"
                class="sf-mono rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-panel)] px-2.5 py-1 text-[10.5px] font-semibold text-[color:var(--sf-ink)] hover:border-[color:var(--sf-line-cobalt)]"
                @click="previewWrapAction(w, 'unwrap')"
              >
                Unwrap
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- RIGHT ACTION DOCK -->
    <aside
      class="sf-action-dock flex h-full min-h-0 flex-col rounded-[22px] rounded-tr-[6px]"
      data-tone="cobalt"
      aria-label="Custody Wrap Ticket"
      @mousemove="onDockPointerMove"
    >
      <div class="sf-panel-head shrink-0 px-4 pt-3.5 pb-3">
        <span class="sf-mono rounded-[4px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[color:var(--sf-cobalt)]">
          Custody Wrap
        </span>

        <div class="mt-2.5">
          <div class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Wrap deposit
          </div>
          <div class="sf-serif mt-0.5 text-[32px] font-semibold leading-none text-[color:var(--sf-ink)]">
            0.036 ERG
          </div>
          <div class="sf-mono mt-1 text-[11.5px] text-[color:var(--sf-ink-2)]">
            0.03 ERG reserve returned on unwrap
          </div>
        </div>
      </div>

      <div class="sf-scroll flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        <div class="grid grid-cols-2 gap-2">
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Receipt
            </div>
            <div class="sf-mono mt-0.5 truncate text-[12px] font-bold text-[color:var(--sf-cobalt)]">
              {{ selectedToken ? `ZCS-Wrap-${selectedToken.id.slice(0, 6)}` : "ZCS-Wrap-…" }}
            </div>
          </div>
          <div class="sf-dock-well rounded-xl px-3 py-2">
            <div class="sf-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Reserve
            </div>
            <div class="sf-mono mt-0.5 text-[12.5px] font-bold text-[color:var(--sf-ink)]">
              0.03 ERG
            </div>
          </div>
        </div>

        <div class="sf-dock-well space-y-2 rounded-xl px-3 py-2.5 text-[12px] text-[color:var(--sf-ink-2)]">
          <div class="flex items-start gap-2">
            <shield-icon class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--sf-cobalt)]" />
            <span>Pledge wrapped receipts as bond collateral or auction lots without breaking protocol custody.</span>
          </div>
          <div class="flex items-start gap-2">
            <check-circle-icon class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--sf-bid)]" />
            <span>Unwrap any time by burning the receipt; underlying LP fees keep accruing while wrapped.</span>
          </div>
        </div>
      </div>

      <div class="shrink-0 border-t border-[color:var(--sf-line)] p-3.5">
        <button
          type="button"
          class="sf-btn-cobalt flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
          :disabled="!selectedToken"
          @click="selectedToken && previewWrap(selectedToken)"
        >
          <span>Wrap Selected NFT</span>
          <arrow-right-icon class="h-4 w-4" />
        </button>
      </div>
    </aside>
  </div>
</template>
