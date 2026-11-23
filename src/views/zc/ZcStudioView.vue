<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ExecutionPreviewModal, { ExecutionPreviewPayload } from "./components/ExecutionPreviewModal.vue";
import StudioAuctionTab from "./studio/StudioAuctionTab.vue";
import StudioBorrowTab from "./studio/StudioBorrowTab.vue";
import StudioLendTab from "./studio/StudioLendTab.vue";
import StudioSellTab from "./studio/StudioSellTab.vue";
import StudioSharesTab from "./studio/StudioSharesTab.vue";
import StudioWrapTab from "./studio/StudioWrapTab.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { useWalletStore, useZcStore } from "@/stories";
import { ZcStudioTab, ZcWalletToken } from "@/types/zc";
import { shortenString } from "@/utils";
import { formatNumber } from "@/utils/zcMath";

const route = useRoute();
const router = useRouter();
const zc = useZcStore();
const wallet = useWalletStore();

const VALID_TABS: readonly ZcStudioTab[] = ["borrow", "lend", "sell", "auction", "shares", "wrap"];

const TABS: { id: ZcStudioTab; label: string; tone: "ask" | "bid" | "cobalt" }[] = [
  { id: "borrow", label: "Borrow", tone: "ask" },
  { id: "lend", label: "Lend", tone: "bid" },
  { id: "sell", label: "Sell", tone: "cobalt" },
  { id: "auction", label: "Auction", tone: "ask" },
  { id: "shares", label: "Shares", tone: "cobalt" },
  { id: "wrap", label: "Wrap", tone: "cobalt" }
];

function parseTab(raw: unknown): ZcStudioTab {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "lot") return "auction";
  return (VALID_TABS as readonly string[]).includes(s) ? (s as ZcStudioTab) : "borrow";
}

const activeTab = ref<ZcStudioTab>(parseTab(route.query.type));
const wrapTargetId = ref<string | null>(
  typeof route.query.token === "string" ? route.query.token : null
);
const previewPayload = ref<ExecutionPreviewPayload | null>(null);

watch(
  () => route.query.type,
  (val) => {
    const parsed = parseTab(val);
    if (parsed !== activeTab.value) activeTab.value = parsed;
  }
);

function selectTab(tab: ZcStudioTab) {
  activeTab.value = tab;
  const nextQuery: Record<string, string> = {};
  if (tab !== "borrow") nextQuery.type = tab;
  void router.replace({ name: "zc-studio", query: nextQuery });
}

function handleWrapToken(tok: ZcWalletToken) {
  wrapTargetId.value = tok.id;
  selectTab("wrap");
}

const numQuery = (key: string): number | null => {
  const v = route.query[key];
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const strQuery = (key: string): string | null => {
  const v = route.query[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

const initialAmount = computed(() => numQuery("amount"));
const initialApr = computed(() => numQuery("apr"));
const initialDays = computed(() => numQuery("days"));
const matchOfferId = computed(() => strQuery("match"));
const initialTokenId = computed(() => strQuery("token") || wrapTargetId.value);

const marketBalance = computed(() =>
  zc.activeMarket === "ERG" ? zc.portfolio.walletErg : zc.portfolio.walletSigUsd
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2.5">
    <!-- Compact Studio Command Bar -->
    <header
      class="sf-terminal-plate flex shrink-0 flex-wrap items-center justify-between gap-2.5 rounded-[16px] rounded-tl-[5px] px-3 py-2"
    >
      <div class="flex flex-wrap items-center gap-2">
        <div class="sf-seg" role="tablist" aria-label="Studio creation mode">
          <button
            v-for="t in TABS"
            :key="t.id"
            type="button"
            role="tab"
            :aria-selected="activeTab === t.id"
            class="sf-seg-btn !h-7 !px-3 !text-[12px]"
            :class="activeTab === t.id ? `is-active tone-${t.tone}` : ''"
            @click="selectTab(t.id)"
          >
            {{ t.label }}
          </button>
        </div>

        <span
          v-if="matchOfferId && (activeTab === 'borrow' || activeTab === 'sell')"
          class="sf-mono rounded-md border border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[color:var(--sf-bid)]"
        >
          Matching offer {{ shortenString(matchOfferId, 10) }}
        </span>
      </div>

      <div class="flex items-center gap-3 text-[11.5px]">
        <div class="flex items-center gap-1.5">
          <market-coin :market="zc.activeMarket" :size="16" />
          <span class="sf-mono font-semibold text-[color:var(--sf-ink)]">
            {{ zc.activeMarket }}
          </span>
        </div>

        <span class="h-3.5 w-[1px] bg-[color:var(--sf-line)]" />

        <span v-if="wallet.connected" class="sf-mono text-[11px] text-[color:var(--sf-ink-2)]">
          {{ formatNumber(marketBalance, 2, 0) }} {{ zc.activeMarket }}
        </span>
        <button
          v-else
          type="button"
          class="sf-mono text-[11px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
          @click="wallet.connect('nautilus')"
        >
          Connect Nautilus
        </button>
      </div>
    </header>

    <!-- Active Studio Tab -->
    <div class="flex min-h-0 flex-1 flex-col">
      <studio-borrow-tab
        v-if="activeTab === 'borrow'"
        :initial-amount="initialAmount"
        :initial-apr="initialApr"
        :initial-days="initialDays"
        :match-offer-id="matchOfferId"
        @preview="previewPayload = $event"
        @wrap-token="handleWrapToken"
      />
      <studio-lend-tab
        v-else-if="activeTab === 'lend'"
        :initial-amount="initialAmount"
        :initial-apr="initialApr"
        :initial-days="initialDays"
        @preview="previewPayload = $event"
      />
      <studio-sell-tab
        v-else-if="activeTab === 'sell'"
        :initial-token-id="initialTokenId"
        :match-offer-id="matchOfferId"
        @preview="previewPayload = $event"
      />
      <studio-auction-tab
        v-else-if="activeTab === 'auction'"
        @preview="previewPayload = $event"
      />
      <studio-shares-tab
        v-else-if="activeTab === 'shares'"
        :initial-token-id="initialTokenId"
        @preview="previewPayload = $event"
      />
      <studio-wrap-tab
        v-else
        :initial-token-id="initialTokenId"
        @preview="previewPayload = $event"
      />
    </div>

    <!-- Shared Execution Preview Modal -->
    <transition name="sf-modal">
      <execution-preview-modal
        v-if="previewPayload"
        :payload="previewPayload"
        @close="previewPayload = null"
      />
    </transition>
  </div>
</template>
