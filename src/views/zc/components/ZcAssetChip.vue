<script setup lang="ts">
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  ShieldIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, ref } from "vue";
import ZcOrderMark from "./ZcOrderMark.vue";
import AssetIcon from "@/components/AssetIcon.vue";
import MarketCoin from "@/components/MarketCoin.vue";
import { verifyToken } from "@/services/zc/tokenVerification";
import { ZcCollateralToken, ZcWalletToken } from "@/types/zc";
import { shortenString } from "@/utils";
import { dateAtHeight, formatNumber, SHARES_UNITS, SIGUSD_TOKEN_ID } from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    token: ZcCollateralToken | ZcWalletToken;
    variant?: "chip" | "card" | "inline";
    compact?: boolean;
    usd?: number | null;
    height?: number;
  }>(),
  {
    variant: "chip",
    compact: false,
    usd: null,
    height: 0
  }
);

const isErg = computed(() => props.token.id.toLowerCase() === "erg");
const isSigUsd = computed(() => props.token.id.toLowerCase() === SIGUSD_TOKEN_ID);
const isBond = computed(() => props.token.kind === "bond" || props.token.kind === "shares");
const isReceipt = computed(() => props.token.kind === "receipt");
const isProvision = computed(() => props.token.kind === "provision");

const bondRouteId = computed(() => props.token.bondId || props.token.id);

const hasPopover = computed(() => isReceipt.value || isProvision.value);

const verification = computed(() => verifyToken(props.token));

const iconSize = computed(() => {
  if (props.variant === "card") return 22;
  if (props.compact) return 14;
  return 16;
});

const formattedAmount = computed(() => {
  const t = props.token;
  if (t.kind === "shares") {
    // Support both raw share units (out of 100,000,000) and already-decimalized shares (out of 100)
    const pct = t.amount > 100 ? (t.amount / SHARES_UNITS) * 100 : t.amount;
    return `${formatNumber(pct, 2, 0)}%`;
  }
  if ((t.kind === "bond" || t.kind === "receipt" || t.kind === "provision") && t.amount === 1) {
    return "";
  }
  return formatNumber(t.amount, Math.min(4, t.decimals), 0);
});

const displayTitle = computed(() => {
  const t = props.token;
  if (t.kind === "receipt") {
    return t.wraps?.name || t.wraps?.ticker || t.name || t.ticker;
  }
  if (t.kind === "bond") return t.name || t.ticker || `Bond ${shortenString(bondRouteId.value, 10)}`;
  if (t.kind === "shares") {
    return t.name || t.ticker || `Bond Shares ${shortenString(bondRouteId.value, 10)}`;
  }
  return t.ticker || t.name || shortenString(t.id, 10);
});

// Teleported interactive hover popover (never clipped by overflow-hidden containers)
const triggerRef = ref<HTMLElement | null>(null);
const open = ref(false);
const popStyle = ref<Record<string, string>>({});
const copiedKey = ref<string | null>(null);
let closeTimer: number | null = null;
let copyTimer: number | null = null;

function clearCloseTimer() {
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function positionPopover() {
  const el = triggerRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 24);
  const left = Math.max(12, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 12));
  const openAbove = r.top > window.innerHeight * 0.56;
  popStyle.value = {
    left: `${Math.round(left)}px`,
    width: `${Math.round(width)}px`,
    ...(openAbove
      ? { bottom: `${Math.round(window.innerHeight - r.top + 8)}px` }
      : { top: `${Math.round(r.bottom + 8)}px` })
  };
}

function openPopover() {
  if (!hasPopover.value) return;
  clearCloseTimer();
  positionPopover();
  open.value = true;
}

function scheduleClose() {
  clearCloseTimer();
  closeTimer = window.setTimeout(() => {
    open.value = false;
  }, 160);
}

function closeNow() {
  clearCloseTimer();
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") closeNow();
}

function onScrollOrResize() {
  if (open.value) positionPopover();
}

async function copyHex(key: string, val: string) {
  try {
    await navigator.clipboard.writeText(val);
    copiedKey.value = key;
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copiedKey.value = null;
    }, 1500);
  } catch {
    // ignore
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);
}

onBeforeUnmount(() => {
  clearCloseTimer();
  if (copyTimer !== null) window.clearTimeout(copyTimer);
  if (typeof window !== "undefined") {
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
  }
});
</script>

<template>
  <!-- 1. BOND / BOND SHARES: Clickable link to /app/bond/:id with official SigmaFi icon -->
  <router-link
    v-if="isBond"
    :to="{ name: 'zc-bond', params: { id: bondRouteId } }"
    :title="`Inspect ${token.kind === 'shares' ? 'bond shares' : 'bond'} ${shortenString(bondRouteId, 14)}`"
    class="group transition-all"
    :class="
      variant === 'card'
        ? 'flex items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line-cobalt)]/70 bg-[color:var(--sf-well-soft)] px-3 py-2 hover:border-[color:var(--sf-line-cobalt)] hover:bg-[color:var(--sf-cobalt-soft)]/35'
        : variant === 'inline'
          ? 'flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-[color:var(--sf-cobalt-soft)]/45'
          : compact
            ? 'inline-flex items-center gap-1 rounded-md border border-[color:var(--sf-line-cobalt)]/60 bg-[color:var(--sf-cobalt-soft)]/35 px-1.5 py-[1px] text-[10px] hover:border-[color:var(--sf-line-cobalt)] hover:bg-[color:var(--sf-cobalt-soft)]/70'
            : 'inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--sf-line-cobalt)]/65 bg-[color:var(--sf-cobalt-soft)]/30 px-2 py-1 text-[11.5px] hover:border-[color:var(--sf-line-cobalt)] hover:bg-[color:var(--sf-cobalt-soft)]/60'
    "
    @click.stop
  >
    <template v-if="variant === 'card'">
      <div class="flex min-w-0 items-center gap-2.5">
        <zc-order-mark :kind="token.kind === 'shares' ? 'shares' : 'unit'" :size="iconSize" />
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-[12.5px] font-semibold text-[color:var(--sf-ink)] group-hover:text-[color:var(--sf-cobalt)]">
              {{ displayTitle }}
            </span>
            <span class="sf-mono rounded bg-[color:var(--sf-cobalt-soft)] px-1 py-[1px] text-[9px] font-semibold uppercase text-[color:var(--sf-cobalt)]">
              {{ token.kind === "shares" ? "Shares" : "Bond" }}
            </span>
          </div>
          <div class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]">
            {{ formattedAmount ? `${formattedAmount} · ` : "" }}{{ shortenString(bondRouteId, 12) }}
          </div>
        </div>
      </div>
      <arrow-up-right-icon class="h-3.5 w-3.5 shrink-0 text-[color:var(--sf-cobalt)] opacity-70 transition-transform group-hover:translate-x-[1px] group-hover:-translate-y-[1px] group-hover:opacity-100" />
    </template>

    <template v-else-if="variant === 'inline'">
      <span class="flex min-w-0 items-center gap-1.5">
        <zc-order-mark :kind="token.kind === 'shares' ? 'shares' : 'unit'" :size="15" />
        <span class="truncate font-semibold text-[color:var(--sf-cobalt)] group-hover:underline">
          {{ displayTitle }}
        </span>
      </span>
      <span class="sf-mono flex shrink-0 items-center gap-1 font-semibold text-[color:var(--sf-ink)]">
        <span>{{ formattedAmount || (token.kind === "shares" ? "Shares" : "1 unit") }}</span>
        <arrow-up-right-icon class="h-3 w-3 text-[color:var(--sf-cobalt)]" />
      </span>
    </template>

    <template v-else>
      <zc-order-mark :kind="token.kind === 'shares' ? 'shares' : 'unit'" :size="iconSize" />
      <span
        class="truncate font-semibold text-[color:var(--sf-ink)] group-hover:text-[color:var(--sf-cobalt)]"
        :class="compact ? 'max-w-[110px]' : 'max-w-[140px]'"
      >
        {{ displayTitle }}
      </span>
      <span v-if="formattedAmount" class="sf-mono font-bold text-[color:var(--sf-ink-2)]">
        {{ formattedAmount }}
      </span>
      <span
        v-else-if="!compact"
        class="sf-mono rounded bg-[color:var(--sf-cobalt-soft)] px-1 py-[1px] text-[9px] font-semibold uppercase text-[color:var(--sf-cobalt)]"
      >
        {{ token.kind === "shares" ? "Shares" : "Bond" }}
      </span>
      <arrow-up-right-icon
        class="shrink-0 text-[color:var(--sf-cobalt)] opacity-75 transition-transform group-hover:translate-x-[1px] group-hover:-translate-y-[1px] group-hover:opacity-100"
        :class="compact ? 'h-2.5 w-2.5' : 'h-3 w-3'"
      />
    </template>
  </router-link>

  <!-- 2. WRAP RECEIPT (no token icon) OR SPECIAL/LP PROVISION TOKEN: Interactive hover tooltip -->
  <span
    v-else-if="hasPopover"
    ref="triggerRef"
    tabindex="0"
    class="group cursor-help outline-none transition-all focus-visible:ring-1 focus-visible:ring-[color:var(--sf-cobalt)]"
    :class="
      variant === 'card'
        ? 'flex items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 py-2 hover:border-[color:var(--sf-line-cobalt)]'
        : variant === 'inline'
          ? 'flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-[color:var(--sf-well-soft)]'
          : compact
            ? 'inline-flex items-center gap-1 rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] px-1.5 py-[1px] text-[10px] hover:border-[color:var(--sf-line-cobalt)]'
            : 'inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-1 text-[11.5px] hover:border-[color:var(--sf-line-cobalt)]'
    "
    @mouseenter="openPopover"
    @mouseleave="scheduleClose"
    @focus="openPopover"
    @blur="scheduleClose"
    @click.stop="open ? closeNow() : openPopover()"
    @keydown="onKeydown"
  >
    <template v-if="variant === 'card'">
      <div class="flex min-w-0 items-center gap-2">
        <asset-icon
          v-if="!isReceipt"
          :token-id="token.id"
          custom-class="h-[18px] w-[18px] shrink-0 rounded-full object-cover"
        />
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span
              v-if="isReceipt"
              class="sf-mono shrink-0 rounded bg-[color:var(--sf-ask-soft)] px-1.5 py-[1px] text-[9px] font-bold uppercase text-[color:var(--sf-ask)]"
            >
              Wrap
            </span>
            <span class="truncate text-[12.5px] font-semibold text-[color:var(--sf-ink)]">
              {{ displayTitle }}
            </span>
          </div>
          <div class="sf-mono truncate text-[10.5px] text-[color:var(--sf-muted)]">
            {{ isReceipt ? token.ticker : shortenString(token.id, 14) }}
          </div>
        </div>
      </div>
      <info-icon class="h-3.5 w-3.5 shrink-0 text-[color:var(--sf-muted)] transition-colors group-hover:text-[color:var(--sf-cobalt)]" />
    </template>

    <template v-else-if="variant === 'inline'">
      <span class="flex min-w-0 items-center gap-1.5">
        <span
          v-if="isReceipt"
          class="sf-mono shrink-0 rounded bg-[color:var(--sf-ask-soft)] px-1 py-[1px] text-[8.5px] font-bold uppercase text-[color:var(--sf-ask)]"
        >
          Wrap
        </span>
        <asset-icon
          v-else
          :token-id="token.id"
          custom-class="h-3.5 w-3.5 shrink-0 rounded-full object-cover"
        />
        <span class="truncate font-semibold text-[color:var(--sf-ink)]">{{ displayTitle }}</span>
      </span>
      <span class="sf-mono flex shrink-0 items-center gap-1 text-[10.5px] text-[color:var(--sf-muted)]">
        <span>{{ formattedAmount || "1 NFT" }}</span>
        <info-icon class="h-3 w-3 text-[color:var(--sf-muted)] group-hover:text-[color:var(--sf-cobalt)]" />
      </span>
    </template>

    <template v-else>
      <span
        v-if="isReceipt"
        class="sf-mono shrink-0 rounded bg-[color:var(--sf-ask-soft)] px-1 py-[1px] font-bold uppercase text-[color:var(--sf-ask)]"
        :class="compact ? 'text-[8.5px]' : 'text-[9px]'"
      >
        Wrap
      </span>
      <asset-icon
        v-else
        :token-id="token.id"
        :custom-class="compact ? 'h-3 w-3 shrink-0 rounded-full object-cover' : 'h-[15px] w-[15px] shrink-0 rounded-full object-cover'"
      />
      <span
        class="truncate font-semibold text-[color:var(--sf-ink)]"
        :class="compact ? 'max-w-[110px]' : 'max-w-[155px]'"
      >
        {{ displayTitle }}
      </span>
      <span v-if="formattedAmount" class="sf-mono font-bold text-[color:var(--sf-ink-2)]">
        {{ formattedAmount }}
      </span>
      <info-icon
        class="shrink-0 text-[color:var(--sf-muted)] transition-colors group-hover:text-[color:var(--sf-cobalt)]"
        :class="compact ? 'h-2.5 w-2.5' : 'h-3 w-3'"
      />
    </template>

    <!-- Teleported Rich Hover Card -->
    <teleport to="body">
      <div
        v-if="open"
        role="tooltip"
        :style="popStyle"
        class="sf-popover fixed z-[90] rounded-2xl border border-[color:var(--sf-line-strong)] p-3.5 text-left shadow-2xl"
        @mouseenter="clearCloseTimer"
        @mouseleave="scheduleClose"
        @click.stop
      >
        <!-- Header -->
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="sf-mono rounded bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[color:var(--sf-cobalt)]">
                {{ isReceipt ? "ZCS Wrap Receipt" : "Special Token" }}
              </span>
              <span
                class="sf-mono rounded px-1.5 py-0.5 text-[9px] font-bold uppercase"
                :class="
                  verification.status === 'verified'
                    ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                    : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                "
              >
                {{ verification.badge }}
              </span>
            </div>
            <div class="mt-1.5 text-[13px] font-bold leading-snug text-[color:var(--sf-ink)]">
              {{ isReceipt ? (token.wraps?.name || token.wraps?.ticker || token.name || token.ticker) : (token.name || token.ticker) }}
            </div>
            <div v-if="isReceipt" class="sf-mono mt-0.5 text-[10px] text-[color:var(--sf-dim)]">
              Receipt {{ token.ticker }}
            </div>
          </div>
        </div>

        <!-- Underlying / Real Token Metadata -->
        <div class="mt-2.5 space-y-2 border-t border-[color:var(--sf-line)] pt-2.5 text-[11px]">
          <div>
            <div class="flex items-center justify-between gap-2">
              <span class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.07em] text-[color:var(--sf-dim)]">
                {{ isReceipt ? "Underlying Token ID" : "Token ID" }}
              </span>
              <button
                type="button"
                class="sf-mono inline-flex items-center gap-1 text-[10px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                @click="copyHex('inner', isReceipt && token.wraps ? token.wraps.id : token.id)"
              >
                <check-icon v-if="copiedKey === 'inner'" class="h-3 w-3 text-[color:var(--sf-bid)]" />
                <copy-icon v-else class="h-3 w-3" />
                <span>{{ copiedKey === "inner" ? "Copied" : "Copy" }}</span>
              </button>
            </div>
            <div class="sf-mono mt-0.5 break-all rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-2 py-1.5 text-[10px] leading-relaxed text-[color:var(--sf-ink)] select-all">
              {{ isReceipt && token.wraps ? token.wraps.id : token.id }}
            </div>
          </div>

          <div v-if="isReceipt && token.wraps">
            <div class="flex items-center justify-between gap-2">
              <span class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.07em] text-[color:var(--sf-dim)]">
                Receipt Token ID
              </span>
              <button
                type="button"
                class="sf-mono inline-flex items-center gap-1 text-[10px] font-semibold text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]"
                @click="copyHex('receipt', token.id)"
              >
                <check-icon v-if="copiedKey === 'receipt'" class="h-3 w-3 text-[color:var(--sf-bid)]" />
                <copy-icon v-else class="h-3 w-3" />
                <span>{{ copiedKey === "receipt" ? "Copied" : shortenString(token.id, 12) }}</span>
              </button>
            </div>
          </div>

          <div>
            <div class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.07em] text-[color:var(--sf-dim)]">
              On-chain Description
            </div>
            <p class="mt-0.5 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-2.5 py-1.5 text-[11px] leading-snug text-[color:var(--sf-ink-2)]">
              {{
                (isReceipt ? token.wraps?.description : token.description) ||
                "No on-chain description recorded for this token."
              }}
            </p>
          </div>

          <div
            v-if="isReceipt"
            class="sf-mono flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-[color:var(--sf-muted)]"
          >
            <span>Custody reserve: 0.03 ERG</span>
            <span v-if="token.wraps?.refreshFrom && height > 0">
              Refresh {{ dateAtHeight(token.wraps.refreshFrom, height) }}
            </span>
          </div>
        </div>

        <!-- Modular Verification Status Notice -->
        <div
          class="mt-2.5 flex items-start gap-2 rounded-xl border px-2.5 py-2 text-[10.5px] leading-snug"
          :class="
            verification.status === 'verified'
              ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
              : 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ink)]'
          "
        >
          <check-circle-icon
            v-if="verification.status === 'verified'"
            class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--sf-bid)]"
          />
          <alert-triangle-icon
            v-else
            class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--sf-ask)]"
          />
          <div class="min-w-0 space-y-1">
            <div class="font-semibold">
              {{ verification.note || verification.summary }}
            </div>
            <ul
              v-if="verification.checks && verification.checks.length > 0"
              class="sf-mono space-y-0.5 text-[9.5px] text-[color:var(--sf-ink-2)]"
            >
              <li
                v-for="chk in verification.checks"
                :key="chk.label"
                class="flex items-start gap-1.5"
              >
                <span
                  :class="
                    chk.ok === true
                      ? 'text-[color:var(--sf-bid)]'
                      : chk.ok === false
                        ? 'text-[color:var(--sf-ask)]'
                        : 'text-[color:var(--sf-muted)]'
                  "
                >
                  {{ chk.ok === true ? "✓" : chk.ok === false ? "✗" : "•" }}
                </span>
                <span>{{ chk.label }}: {{ chk.detail }}</span>
              </li>
            </ul>
          </div>
        </div>

        <!-- If a wrapped inner asset happens to be a verified bond, offer direct bond navigation -->
        <div
          v-if="isReceipt && token.wraps && (token.wraps.kind === 'bond' || token.wraps.kind === 'shares')"
          class="mt-2 border-t border-[color:var(--sf-line)] pt-2"
        >
          <router-link
            :to="{ name: 'zc-bond', params: { id: token.wraps.bondId || token.wraps.id } }"
            class="sf-mono inline-flex items-center gap-1 text-[11px] font-semibold text-[color:var(--sf-cobalt)] hover:underline"
            @click="closeNow"
          >
            <shield-icon class="h-3 w-3" />
            <span>Open underlying bond terms</span>
            <arrow-up-right-icon class="h-3 w-3" />
          </router-link>
        </div>
      </div>
    </teleport>
  </span>

  <!-- 3. STANDARD TOKENS / ERG / SigUSD -->
  <div
    v-else
    :class="
      variant === 'card'
        ? 'flex items-center justify-between gap-2 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-3 py-2'
        : variant === 'inline'
          ? 'flex items-center justify-between gap-2'
          : compact
            ? 'inline-flex items-center gap-1 rounded-md bg-[color:var(--sf-well)] px-1.5 py-[1px] text-[10px] text-[color:var(--sf-ink-2)]'
            : 'inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well-soft)] px-2 py-1 text-[11.5px]'
    "
  >
    <template v-if="variant === 'card'">
      <div class="flex min-w-0 items-center gap-2">
        <market-coin v-if="isErg || isSigUsd" :market="isErg ? 'ERG' : 'SigUSD'" :size="18" />
        <asset-icon
          v-else
          :token-id="token.id"
          custom-class="h-[18px] w-[18px] shrink-0 rounded-full object-cover"
        />
        <div class="min-w-0">
          <div class="truncate text-[12.5px] font-semibold text-[color:var(--sf-ink)]">
            {{ token.ticker }}
          </div>
          <div class="sf-mono text-[11px] text-[color:var(--sf-ink-2)]">
            {{ formattedAmount }} {{ token.ticker }}
          </div>
        </div>
      </div>
      <span v-if="usd != null" class="sf-mono shrink-0 text-[11px] text-[color:var(--sf-muted)]">
        ${{ formatNumber(usd, 2, 0) }}
      </span>
    </template>

    <template v-else-if="variant === 'inline'">
      <span class="flex min-w-0 items-center gap-1.5">
        <market-coin v-if="isErg || isSigUsd" :market="isErg ? 'ERG' : 'SigUSD'" :size="14" />
        <asset-icon
          v-else
          :token-id="token.id"
          custom-class="h-3.5 w-3.5 shrink-0 rounded-full object-cover"
        />
        <span class="truncate">{{ token.ticker }}</span>
      </span>
      <span class="sf-mono shrink-0 font-semibold">{{ formattedAmount }}</span>
    </template>

    <template v-else>
      <market-coin v-if="isErg || isSigUsd" :market="isErg ? 'ERG' : 'SigUSD'" :size="iconSize" />
      <asset-icon
        v-else
        :token-id="token.id"
        :custom-class="compact ? 'h-3 w-3 shrink-0 rounded-full object-cover' : 'h-[15px] w-[15px] shrink-0 rounded-full object-cover'"
      />
      <span
        class="truncate font-semibold text-[color:var(--sf-ink)]"
        :class="compact ? 'max-w-[96px]' : 'max-w-[140px]'"
      >
        {{ token.ticker }}
      </span>
      <span v-if="formattedAmount && !compact" class="sf-mono font-bold text-[color:var(--sf-ink-2)]">
        {{ formattedAmount }}
      </span>
    </template>
  </div>
</template>
