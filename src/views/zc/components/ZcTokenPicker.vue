<script setup lang="ts">
import { CheckIcon, PackageIcon, PlusIcon, SearchIcon, XIcon } from "@zhuowenli/vue-feather-icons";
import { computed, ref } from "vue";
import AssetIcon from "@/components/AssetIcon.vue";
import { useWalletStore, useZcStore } from "@/stories";
import { ZcWalletToken } from "@/types/zc";
import { shortenString } from "@/utils";
import { formatNumber } from "@/utils/zcMath";

export interface SelectedWalletToken {
  id: string;
  ticker: string;
  name?: string | null;
  decimals: number;
  amount: number;
  max: number;
  kind?: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: SelectedWalletToken[];
    excludeIds?: string[];
    showWrapAction?: boolean;
    maxTokens?: number;
    tone?: "bid" | "ask" | "cobalt";
    compact?: boolean;
    emptyText?: string;
  }>(),
  {
    excludeIds: () => [],
    showWrapAction: false,
    maxTokens: 30,
    tone: "cobalt",
    compact: false,
    emptyText: "No extra tokens in connected wallet."
  }
);

const emit = defineEmits<{
  (e: "update:modelValue", list: SelectedWalletToken[]): void;
  (e: "wrap", token: ZcWalletToken): void;
}>();

const wallet = useWalletStore();
const zc = useZcStore();
const filter = ref("");

const excludeSet = computed(() => new Set(props.excludeIds.map((x) => x.toLowerCase())));

const selectedMap = computed(() => new Map(props.modelValue.map((x) => [x.id.toLowerCase(), x])));

const availableTokens = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return zc.portfolio.walletTokens.filter((t) => {
    if (excludeSet.value.has(t.id.toLowerCase())) return false;
    if (t.amount <= 0) return false;
    if (!q) return true;
    return (
      t.ticker.toLowerCase().includes(q) ||
      (t.name && t.name.toLowerCase().includes(q)) ||
      t.id.toLowerCase().includes(q)
    );
  });
});

const atLimit = computed(() => props.modelValue.length >= props.maxTokens);

function isProvision(tok: ZcWalletToken) {
  return tok.kind === "provision";
}

function toggleToken(tok: ZcWalletToken) {
  const id = tok.id.toLowerCase();
  if (selectedMap.value.has(id)) {
    emit(
      "update:modelValue",
      props.modelValue.filter((x) => x.id.toLowerCase() !== id)
    );
    return;
  }
  // SF-1: raw LithosDex provision / capability NFTs must be wrapped before pledging or auctioning.
  if (isProvision(tok)) {
    if (props.showWrapAction) emit("wrap", tok);
    return;
  }
  // FS-4: enforce distinct-token cap so liquidated share vaults stay under the 4,096 B box limit.
  if (props.modelValue.length >= props.maxTokens) {
    return;
  }
  const next: SelectedWalletToken = {
    id,
    ticker: tok.ticker,
    name: tok.name,
    decimals: tok.decimals,
    amount: tok.decimals === 0 && tok.amount === 1 ? 1 : tok.amount,
    max: tok.amount,
    kind: tok.kind
  };
  emit("update:modelValue", [...props.modelValue, next]);
}

function updateAmount(id: string, raw: string) {
  const clean = raw.replace(/[^0-9.]/g, "");
  const n = Number(clean);
  if (!Number.isFinite(n)) return;
  emit(
    "update:modelValue",
    props.modelValue.map((x) =>
      x.id.toLowerCase() === id.toLowerCase()
        ? { ...x, amount: Math.max(0, Math.min(x.max, n)) }
        : x
    )
  );
}

function removeToken(id: string) {
  emit(
    "update:modelValue",
    props.modelValue.filter((x) => x.id.toLowerCase() !== id.toLowerCase())
  );
}

function isNft(tok: ZcWalletToken) {
  return tok.decimals === 0 && tok.amount === 1;
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <!-- Selected Chips -->
    <div v-if="modelValue.length > 0" class="flex flex-wrap gap-1.5">
      <div
        v-for="item in modelValue"
        :key="item.id"
        class="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-2 py-1 text-[11px]"
      >
        <asset-icon :token-id="item.id" custom-class="h-4 w-4 rounded-full object-cover" />
        <span class="font-semibold text-[color:var(--sf-ink)]">{{ item.ticker }}</span>
        <span v-if="item.decimals === 0 && item.max === 1" class="sf-mono text-[10px] text-[color:var(--sf-cobalt)]">
          NFT
        </span>
        <input
          v-else
          type="text"
          inputmode="decimal"
          :value="item.amount"
          class="sf-mono w-16 rounded border border-[color:var(--sf-line)] bg-[color:var(--sf-panel)] px-1.5 py-0.5 text-right text-[11px] font-semibold text-[color:var(--sf-ink)] outline-none focus:border-[color:var(--sf-cobalt)]"
          @input="updateAmount(item.id, ($event.target as HTMLInputElement).value)"
        />
        <button
          type="button"
          class="text-[color:var(--sf-muted)] transition-colors hover:text-[color:var(--sf-danger)]"
          aria-label="Remove token"
          @click="removeToken(item.id)"
        >
          <x-icon class="h-3 w-3" />
        </button>
      </div>
    </div>

    <!-- Disconnected State -->
    <div
      v-if="!wallet.connected"
      class="sf-dock-well flex items-center justify-between gap-3 rounded-xl px-3 py-2.5"
    >
      <span class="text-[12px] text-[color:var(--sf-muted)]">
        Connect Nautilus to pick tokens or NFTs from your wallet.
      </span>
      <button
        type="button"
        class="sf-btn-cobalt h-7 shrink-0 rounded-lg px-3 text-[11.5px]"
        @click="wallet.connect('nautilus')"
      >
        Connect
      </button>
    </div>

    <!-- Connected Token List -->
    <template v-else>
      <div
        v-if="zc.portfolio.walletTokens.length > 5"
        class="sf-input-well flex h-8 items-center gap-1.5 rounded-xl px-2.5"
        :data-tone="tone"
      >
        <search-icon class="h-3.5 w-3.5 shrink-0 text-[color:var(--sf-muted)]" />
        <input
          v-model="filter"
          type="text"
          placeholder="Filter wallet tokens or IDs…"
          class="sf-mono w-full min-w-0 bg-transparent text-[11.5px] text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
        />
      </div>

      <div
        v-if="availableTokens.length === 0"
        class="sf-dock-well rounded-xl px-3 py-2.5 text-[11.5px] text-[color:var(--sf-muted)]"
      >
        {{ emptyText }}
      </div>

      <div
        v-else
        class="sf-scroll grid gap-1 overflow-y-auto pr-0.5"
        :class="compact ? 'max-h-[140px]' : 'max-h-[210px]'"
      >
        <div
          v-for="tok in availableTokens"
          :key="tok.id"
          class="flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 transition-all"
          :class="
            selectedMap.has(tok.id.toLowerCase())
              ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] hover:border-[color:var(--sf-line-strong)]'
          "
        >
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <asset-icon :token-id="tok.id" custom-class="h-5 w-5 shrink-0 rounded-full object-cover" />
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="truncate text-[12px] font-semibold text-[color:var(--sf-ink)]">
                {{ tok.ticker }}
              </span>
              <span
                v-if="tok.kind === 'receipt'"
                class="sf-mono rounded bg-[color:var(--sf-bid-soft)] px-1 py-0.5 text-[9px] font-semibold uppercase text-[color:var(--sf-bid)]"
              >
                Wrap
              </span>
              <span
                v-else-if="isProvision(tok)"
                class="sf-mono rounded bg-[color:var(--sf-ask-soft)] px-1 py-0.5 text-[9px] font-semibold uppercase text-[color:var(--sf-ask)]"
                title="Raw LithosDex provision NFT — must be wrapped into a custody receipt first"
              >
                Wrap req.
              </span>
              <span
                v-else-if="isNft(tok)"
                class="sf-mono rounded bg-[color:var(--sf-well)] px-1 py-0.5 text-[9px] font-semibold uppercase text-[color:var(--sf-muted)]"
              >
                NFT
              </span>
              <span class="sf-mono text-[10px] text-[color:var(--sf-dim)]">
                {{ shortenString(tok.id, 8) }}
              </span>
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-1.5">
            <span class="sf-mono text-[11px] font-semibold text-[color:var(--sf-ink-2)]">
              {{ formatNumber(tok.amount, Math.min(4, tok.decimals), 0) }}
            </span>

            <button
              v-if="showWrapAction && (isProvision(tok) || (isNft(tok) && tok.kind !== 'receipt'))"
              type="button"
              class="sf-mono inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold transition-colors"
              :class="
                isProvision(tok)
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)] hover:brightness-110'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-panel)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-cobalt)]'
              "
              :title="
                isProvision(tok)
                  ? 'Raw capability NFT must be wrapped into a ZCS-Wrap receipt before pledging or auctioning'
                  : 'Wrap NFT into custody receipt'
              "
              @click.stop="emit('wrap', tok)"
            >
              <package-icon class="h-3 w-3" />
              <span>{{ isProvision(tok) ? "Wrap first" : "Wrap" }}</span>
            </button>

            <button
              v-if="!isProvision(tok)"
              type="button"
              :disabled="!selectedMap.has(tok.id.toLowerCase()) && atLimit"
              class="sf-mono inline-flex h-6 items-center gap-1 rounded-md px-2 text-[10.5px] font-semibold transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
              :class="
                selectedMap.has(tok.id.toLowerCase())
                  ? 'bg-[color:var(--sf-cobalt)] text-white'
                  : 'border border-[color:var(--sf-line)] bg-[color:var(--sf-panel)] text-[color:var(--sf-ink)] hover:border-[color:var(--sf-line-cobalt)]'
              "
              :title="
                !selectedMap.has(tok.id.toLowerCase()) && atLimit
                  ? `Limit of ${maxTokens} distinct tokens reached`
                  : undefined
              "
              @click="toggleToken(tok)"
            >
              <check-icon v-if="selectedMap.has(tok.id.toLowerCase())" class="h-3 w-3" />
              <plus-icon v-else class="h-3 w-3" />
              <span>{{ selectedMap.has(tok.id.toLowerCase()) ? "Added" : "Add" }}</span>
            </button>
            <span
              v-else-if="!showWrapAction"
              class="sf-mono text-[10px] font-semibold text-[color:var(--sf-ask)]"
              title="Wrap this capability NFT in Studio → Wrap before using it"
            >
              Wrap in Studio
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
