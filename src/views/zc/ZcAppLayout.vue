<script setup lang="ts">
import { decimalize } from "@fleet-sdk/common";
import {
  ArrowUpRightIcon,
  LockIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersIcon,
  XIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import MarketCoin from "@/components/MarketCoin.vue";
import SigmaFiMark from "@/components/SigmaFiMark.vue";
import ThemeToggle from "@/components/ThemeToggle.vue";
import ZcKyaModal from "@/components/ZcKyaModal.vue";
import {
  DISABLE_V2_TX_SIGNING,
  ERG_DECIMALS,
  ERG_TOKEN_ID,
  V2_TX_SIGNING_DISABLED_MESSAGE
} from "@/constants";
import {
  DEFAULT_MAINNET_EXPLORER_URL,
  DEFAULT_MAINNET_GRAPHQL_URL,
  DEFAULT_MAINNET_HERGMES_URL,
  isValidHergmesUrl,
  OFFICIAL_MAINNET_EXPLORER_URL,
  SIGMASPACE_GRAPHQL_URL,
  zcApi,
  ZcDataSource
} from "@/services/zcApi";
import { useUIStore, useWalletStore, useZcStore } from "@/stories";
import { ZcMarket, ZcSearchHit } from "@/types/zc";
import { shortenString } from "@/utils";
import { formatApr, formatNumber, SIGUSD_TOKEN_ID } from "@/utils/zcMath";

const zc = useZcStore();
const wallet = useWalletStore();
const ui = useUIStore();
const route = useRoute();
const router = useRouter();

const kyaOpen = ref(!ui.isKYAAccepted.value);

type ChainFeedMode = "hergmes" | "explorer" | "graphql";

const HERGMES_LOCAL_URL = "http://127.0.0.1:8080";

const HERGMES_PRESETS = computed(() => {
  const list: { label: string; url: string }[] = [];
  const def = zc.defaultHergmesUrl;
  if (def && isValidHergmesUrl(def) && def !== DEFAULT_MAINNET_HERGMES_URL) {
    list.push({ label: "Default", url: def });
  }
  list.push({ label: "Nautilus Relay", url: DEFAULT_MAINNET_HERGMES_URL });
  list.push({ label: "Local (127.0.0.1:8080)", url: HERGMES_LOCAL_URL });
  return list;
});

const EXPLORER_PRESETS = [
  { label: "ErgoScan", url: DEFAULT_MAINNET_EXPLORER_URL },
  { label: "Ergo Explorer", url: OFFICIAL_MAINNET_EXPLORER_URL }
] as const;

const GRAPHQL_PRESETS = [
  { label: "ErgoScan GQL", url: DEFAULT_MAINNET_GRAPHQL_URL },
  { label: "SigmaSpace", url: SIGMASPACE_GRAPHQL_URL }
] as const;

function feedModeOf(source: ZcDataSource): ChainFeedMode {
  if (source === "hergmes") return "hergmes";
  if (source === "graphql") return "graphql";
  return "explorer";
}

function endpointForMode(mode: ChainFeedMode): string {
  if (mode === "hergmes") return zc.hergmesUrl;
  if (mode === "graphql") return zc.graphqlUrl;
  return zc.explorerUrl;
}

const feedOpen = ref(false);
const feedModeInput = ref<ChainFeedMode>(feedModeOf(zc.dataSource));
const endpointInput = ref(endpointForMode(feedModeInput.value));
const feedRef = ref<HTMLElement | null>(null);

const activePresets = computed(() => {
  if (feedModeInput.value === "hergmes") return HERGMES_PRESETS.value;
  if (feedModeInput.value === "explorer") return EXPLORER_PRESETS;
  return GRAPHQL_PRESETS;
});

const hergmesUrlInvalid = computed(
  () => feedModeInput.value === "hergmes" && !isValidHergmesUrl(endpointInput.value)
);

const searchInputRef = ref<HTMLInputElement | null>(null);
const headerRef = ref<HTMLElement | null>(null);
const headerHeight = ref(62);
const searchFocused = ref(false);
const searchHits = ref<ZcSearchHit[]>([]);

function syncRouteMarket() {
  const qMarket = route.query.market;
  if (qMarket === "ERG" || qMarket === "SigUSD") {
    zc.setActiveMarket(qMarket);
  }
}

function toggleFeedPopover() {
  feedModeInput.value = feedModeOf(zc.dataSource);
  endpointInput.value = endpointForMode(feedModeInput.value);
  feedOpen.value = !feedOpen.value;
}

function switchFeedMode(mode: ChainFeedMode) {
  feedModeInput.value = mode;
  endpointInput.value = endpointForMode(mode);
}

function pickPreset(url: string) {
  endpointInput.value = url;
  saveEndpoint();
}

function saveEndpoint() {
  const mode = feedModeInput.value;
  if (mode === "hergmes") {
    if (!isValidHergmesUrl(endpointInput.value)) return;
    zc.applyHergmesFeed(endpointInput.value);
    feedOpen.value = false;
    return;
  }
  if (zc.dataSource !== mode) {
    zc.updateDataSource(mode);
  }
  if (mode === "explorer") {
    zc.updateExplorerUrl(endpointInput.value);
  } else {
    zc.updateGraphqlUrl(endpointInput.value);
  }
  feedOpen.value = false;
}

function resetEndpoint() {
  if (isValidHergmesUrl(zc.defaultHergmesUrl)) {
    feedModeInput.value = "hergmes";
    endpointInput.value = zc.defaultHergmesUrl;
    zc.applyHergmesFeed("");
  } else {
    feedModeInput.value = "explorer";
    endpointInput.value = zc.defaultExplorerUrl;
    zc.updateDataSource("explorer");
    zc.updateExplorerUrl("");
  }
  feedOpen.value = false;
}

function fallbackToExplorer() {
  feedModeInput.value = "explorer";
  endpointInput.value = zc.explorerUrl;
  zc.updateDataSource("explorer");
  feedOpen.value = false;
}

function onDocClick(e: MouseEvent) {
  if (!feedOpen.value) return;
  if (feedRef.value && !feedRef.value.contains(e.target as Node)) {
    feedOpen.value = false;
  }
}

// Global '/' keyboard shortcut focuses lookup bar
function onGlobalKey(e: KeyboardEvent) {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
    return;
  }
  const el = searchInputRef.value;
  if (!el || !el.offsetParent) return;
  e.preventDefault();
  el.focus();
  el.select();
}

// Debounced remote hex lookup (6+ hex chars)
let searchTimer: number | null = null;
let searchAc: AbortController | null = null;
watch(
  () => zc.searchQuery,
  (val) => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    if (searchAc) searchAc.abort();
    const clean = val.trim().toLowerCase();
    if (!zc.connected || clean.length < 6 || !/^[0-9a-f]+$/.test(clean)) {
      searchHits.value = [];
      return;
    }
    searchTimer = window.setTimeout(async () => {
      const ac = new AbortController();
      searchAc = ac;
      try {
        const hits = await zcApi.search(clean, ac.signal);
        if (!ac.signal.aborted) searchHits.value = hits.slice(0, 6);
      } catch {
        if (!ac.signal.aborted) searchHits.value = [];
      }
    }, 220);
  }
);

function pickSearchHit(hit: ZcSearchHit) {
  if (hit.market && (hit.market === "ERG" || hit.market === "SigUSD")) {
    zc.setActiveMarket(hit.market);
  }
  searchFocused.value = false;
  searchInputRef.value?.blur();
  if (hit.type === "offer") {
    void router.push({ name: "zc-offer", params: { id: hit.id } });
  } else {
    void router.push({ name: "zc-bond", params: { id: hit.id } });
  }
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (zc.searchQuery) {
      zc.searchQuery = "";
    } else {
      searchInputRef.value?.blur();
    }
  } else if (e.key === "Enter" && searchHits.value.length > 0) {
    e.preventDefault();
    pickSearchHit(searchHits.value[0]);
  }
}

watch(() => route.query.market, syncRouteMarket, { immediate: true });

function syncHeaderHeight() {
  const h = headerRef.value?.getBoundingClientRect().height;
  if (h && h > 0) headerHeight.value = Math.ceil(h);
}

watch(
  headerRef,
  (el, _prev, onCleanup) => {
    if (!el) return;
    syncHeaderHeight();
    window.addEventListener("resize", syncHeaderHeight);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(syncHeaderHeight);
      ro.observe(el);
    }
    onCleanup(() => {
      window.removeEventListener("resize", syncHeaderHeight);
      ro?.disconnect();
    });
  },
  { immediate: true }
);

onMounted(() => {
  // Always use a direct Ergo blockchain feed (Hergmes WS, Explorer REST, or GraphQL)
  if (zc.dataSource === "lithos") {
    zc.updateDataSource(isValidHergmesUrl(zc.defaultHergmesUrl) ? "hergmes" : "explorer");
  }
  zc.start();
  document.addEventListener("mousedown", onDocClick);
  document.addEventListener("keydown", onGlobalKey);
});

onBeforeUnmount(() => {
  zc.stop();
  document.removeEventListener("mousedown", onDocClick);
  document.removeEventListener("keydown", onGlobalKey);
  searchAc?.abort();
  if (searchTimer !== null) window.clearTimeout(searchTimer);
});

const ergBalance = computed(() => {
  const raw = wallet.balance.find((x) => x.tokenId === "ERG")?.amount || "0";
  return decimalize(raw, { decimals: ERG_DECIMALS, thousandMark: "," });
});

const walletPendingTooltip = computed(() => {
  if (!wallet.hasPendingTx) return "Connected via Nautilus — click to disconnect";
  const parts: string[] = [];
  const ergDelta = wallet.pendingBalance.get(ERG_TOKEN_ID) ?? 0n;
  if (ergDelta !== 0n) {
    const sign = ergDelta > 0n ? "+" : "-";
    const absErg = Number(ergDelta < 0n ? -ergDelta : ergDelta) / 1e9;
    parts.push(`${sign}${formatNumber(absErg, 3, 0)} ERG`);
  }
  const usdDelta = wallet.pendingBalance.get(SIGUSD_TOKEN_ID) ?? 0n;
  if (usdDelta !== 0n) {
    const sign = usdDelta > 0n ? "+" : "-";
    const absUsd = Number(usdDelta < 0n ? -usdDelta : usdDelta) / 100;
    parts.push(`${sign}${formatNumber(absUsd, 2, 2)} SigUSD`);
  }
  return parts.length > 0
    ? `Pending mempool: ${parts.join(", ")} · click to disconnect`
    : "Pending mempool transaction · click to disconnect";
});

const oracleStale = computed(
  () => zc.connected && (zc.oracle.missing || zc.oracle.refreshPending || zc.oracle.age > 30)
);

const hergmesPhaseLabel = computed(() => {
  switch (zc.streamPhase) {
    case "live":
      return "live";
    case "connecting":
    case "snapshot":
    case "catching_up":
      return "syncing";
    case "waiting":
    case "disconnected":
      return "reconnecting";
    case "rejected":
      return "rejected";
    default:
      return "idle";
  }
});

const feedDotIdle = computed(
  () =>
    !zc.connected ||
    (zc.dataSource === "hergmes" &&
      (zc.streamPhase === "disconnected" || zc.streamPhase === "rejected"))
);

const feedDotWarn = computed(
  () =>
    !feedDotIdle.value &&
    (oracleStale.value || (zc.dataSource === "hergmes" && zc.streamPhase !== "live"))
);

const chainTooltip = computed(() => {
  const via =
    zc.dataSource === "hergmes"
      ? `Hergmes WS (${hergmesPhaseLabel.value})`
      : zc.dataSource === "graphql"
        ? "GraphQL"
        : "Explorer API";
  if (!zc.connected) return zc.loading ? `Syncing Ergo ${via}...` : zc.error || "Feed offline";
  if (zc.oracle.missing) {
    return `Block #${zc.height.toLocaleString("en-US")} (${via}) · Oracle box missing`;
  }
  const status = zc.oracle.refreshPending
    ? "Oracle refresh in mempool"
    : zc.oracle.age > 30
      ? `Oracle stale (${zc.oracle.age} blk)`
      : `Oracle fresh (${zc.oracle.age} blk)`;
  const mempoolTag = zc.mempoolActive ? " · Mempool active" : "";
  return `#${zc.height.toLocaleString("en-US")} (${via}${mempoolTag}) · ERG $${zc.oracle.price.toFixed(3)} · ${status}`;
});

const isSingleScreen = computed(() => route.name === "zc-market" || route.name === "zc-studio");

const navItems = [
  { to: "/app", label: "Yield Curve", name: "zc-market" },
  { to: "/app/market", label: "Market", name: "zc-listings" },
  { to: "/app/studio", label: "Studio", name: "zc-studio" },
  { to: "/app/auctions", label: "Auctions", name: "zc-auctions" },
  { to: "/app/portfolio", label: "Portfolio", name: "zc-portfolio" }
];
</script>

<template>
  <div
    class="sf-shell relative flex min-h-screen flex-col overflow-x-clip"
    :class="isSingleScreen ? 'ratebook-viewport-lock' : ''"
    :style="{ '--sf-header-h': `${headerHeight}px` }"
  >
    <!-- Landing-Unified Atmospheric Backdrop (subtle washes + faint parametric contours) -->
    <div class="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div class="app-wash-top" />
      <div class="app-wash-mid" />
      <svg
        class="app-contours absolute inset-0 h-full w-full"
        viewBox="0 0 1440 960"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
      >
        <g class="app-contour-lines" stroke="currentColor" stroke-width="1">
          <path d="M-120 185 C 260 55, 620 295, 1020 140 C 1250 52, 1400 105, 1560 64" />
          <path d="M-120 228 C 280 102, 640 338, 1040 184 C 1265 98, 1410 146, 1560 108" />
          <path d="M-80 835 C 260 700, 640 915, 1040 748 C 1265 654, 1415 696, 1560 648" />
        </g>
        <g class="app-contour-arcs" stroke="currentColor" stroke-width="1">
          <circle cx="1290" cy="140" r="320" stroke-dasharray="3 10" />
          <circle cx="120" cy="820" r="290" stroke-dasharray="4 12" />
        </g>
      </svg>
    </div>

    <!-- Floating Frosted Capsule App Bar (matches LandingHeader.vue) -->
    <header ref="headerRef" class="sticky top-0 z-40 shrink-0 px-3 pt-2.5 sm:px-4">
      <div
        class="sf-header app-capsule relative mx-auto flex min-h-[52px] max-w-[1680px] flex-wrap items-center justify-between gap-2 rounded-2xl border border-[color:var(--sf-line-strong)] px-3 py-1.5 backdrop-blur-xl sm:px-4"
      >
        <!-- Left: Brand + Primary Nav + Global '/' Lookup -->
        <div class="flex items-center gap-2.5 lg:gap-3">
          <router-link
            to="/"
            class="group inline-flex h-8 shrink-0 items-center gap-2 rounded-full transition-opacity hover:opacity-90"
          >
            <sigma-fi-mark :size="26" />
            <span
              class="sf-serif inline-flex translate-y-[0.5px] items-center text-[19px] font-semibold leading-none tracking-tight text-[color:var(--sf-ink)]"
            >
              SigmaFi
            </span>
          </router-link>

          <span
            v-if="DISABLE_V2_TX_SIGNING"
            class="sf-mono inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-600 dark:text-amber-300"
            :title="V2_TX_SIGNING_DISABLED_MESSAGE"
          >
            <lock-icon class="h-2.5 w-2.5 shrink-0" />
            <span>Preview</span>
          </span>

          <span class="hidden h-4 w-px bg-[color:var(--sf-line)] md:block" aria-hidden="true" />

          <nav class="hidden items-center gap-0.5 md:flex" aria-label="SigmaFi V2">
            <router-link
              v-for="item in navItems"
              :key="item.name"
              :to="item.to"
              class="nav-pill inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-all"
              :class="
                route.name === item.name
                  ? 'is-active text-[color:var(--sf-ink)]'
                  : 'text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]'
              "
            >
              <span>{{ item.label }}</span>
              <span
                v-if="item.name === 'zc-auctions' && zc.auctionsCount > 0"
                class="sf-mono rounded-[4px] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-[1px] text-[10px] font-semibold text-[color:var(--sf-cobalt)]"
              >
                {{ zc.auctionsCount }}
              </span>
              <span
                v-else-if="item.name === 'zc-portfolio' && zc.portfolio.attentionCount > 0"
                class="sf-mono rounded-[4px] bg-[color:var(--sf-warn-soft)] px-1.5 py-[1px] text-[10px] font-semibold text-[color:var(--sf-warn)]"
                :title="`${zc.portfolio.attentionCount} position${zc.portfolio.attentionCount === 1 ? '' : 's'} need attention`"
              >
                {{ zc.portfolio.attentionCount }}
              </span>
            </router-link>
          </nav>

          <!-- Compact Expandable Search / Box Lookup ('/' hotkey) -->
          <div class="search-shell relative hidden sm:block">
            <div
              class="sf-input-well search-box flex h-8 items-center gap-1.5 rounded-xl px-2.5 transition-all duration-200"
              :class="searchFocused ? 'w-56 lg:w-64' : 'w-36 lg:w-40 xl:w-44'"
            >
              <search-icon
                class="h-3.5 w-3.5 shrink-0 transition-colors"
                :class="
                  searchFocused ? 'text-[color:var(--sf-cobalt)]' : 'text-[color:var(--sf-dim)]'
                "
              />
              <input
                ref="searchInputRef"
                v-model="zc.searchQuery"
                type="text"
                placeholder="Filter or box ID"
                aria-label="Filter orders or lookup box ID"
                aria-keyshortcuts="/"
                class="sf-mono w-full min-w-0 bg-transparent text-[11.5px] text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
                @focus="searchFocused = true"
                @blur="searchFocused = false"
                @keydown="onSearchKeydown"
              />
              <button
                v-if="zc.searchQuery"
                type="button"
                class="text-[color:var(--sf-muted)] transition-colors hover:text-[color:var(--sf-ink)]"
                aria-label="Clear search"
                @mousedown.prevent="zc.searchQuery = ''"
              >
                <x-icon class="h-3 w-3" />
              </button>
              <kbd
                v-else-if="!searchFocused"
                aria-hidden="true"
                class="sf-mono pointer-events-none rounded-[4px] border border-[color:var(--sf-line-strong)] px-1.5 py-[1px] text-[9.5px] text-[color:var(--sf-dim)]"
              >
                /
              </kbd>
            </div>

            <transition name="sf-pop">
              <div
                v-if="searchFocused && searchHits.length"
                class="sf-popover absolute left-0 top-[calc(100%+8px)] z-50 w-72 overflow-hidden rounded-xl p-1"
              >
                <button
                  v-for="hit in searchHits"
                  :key="hit.id"
                  type="button"
                  class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[11.5px] transition-colors hover:bg-[color:var(--sf-well-soft)]"
                  @mousedown.prevent="pickSearchHit(hit)"
                >
                  <div class="min-w-0">
                    <div class="sf-mono truncate font-semibold text-[color:var(--sf-ink)]">
                      {{ shortenString(hit.id, 14) }}
                    </div>
                    <div v-if="hit.title" class="truncate text-[10.5px] text-[color:var(--sf-muted)]">
                      {{ hit.title }}
                    </div>
                  </div>
                  <div class="sf-mono shrink-0 text-right">
                    <span
                      class="rounded-[4px] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase"
                      :class="
                        hit.type === 'offer'
                          ? 'bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                          : 'bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                      "
                    >
                      {{ hit.type }} {{ hit.market || "" }}
                    </span>
                    <div
                      v-if="hit.yieldBps != null"
                      class="mt-0.5 text-[10.5px] font-semibold text-[color:var(--sf-ink-2)]"
                    >
                      {{ formatApr(hit.yieldBps) }}
                    </div>
                  </div>
                </button>
              </div>
            </transition>
          </div>
        </div>

        <!-- Right: Market + Unit + Chain Feed + V1 + Theme + Nautilus -->
        <div class="flex items-center gap-1.5 sm:gap-2">
          <!-- Market Switch -->
          <div class="sf-seg" role="tablist" aria-label="Active market">
            <button
              v-for="m in (['ERG', 'SigUSD'] as ZcMarket[])"
              :key="m"
              type="button"
              role="tab"
              :aria-selected="zc.activeMarket === m"
              class="sf-seg-btn px-2.5 py-1 text-[11.5px]"
              :class="zc.activeMarket === m ? 'is-active tone-cobalt' : ''"
              @click="zc.setActiveMarket(m)"
            >
              <market-coin :market="m" :size="15" bare />
              <span>{{ m }}</span>
            </button>
          </div>

          <!-- Duration Unit (d / blk) -->
          <div class="sf-seg hidden sm:inline-flex" role="group" aria-label="Duration display unit">
            <button
              type="button"
              :aria-pressed="zc.durationUnit === 'days'"
              title="Show durations in days and dates"
              class="sf-seg-btn sf-mono px-2 py-1 text-[11px]"
              :class="zc.durationUnit === 'days' ? 'is-active' : ''"
              @click="zc.setDurationUnit('days')"
            >
              Days
            </button>
            <button
              type="button"
              :aria-pressed="zc.durationUnit === 'blocks'"
              title="Show durations in blocks and heights"
              class="sf-seg-btn sf-mono px-2 py-1 text-[11px]"
              :class="zc.durationUnit === 'blocks' ? 'is-active' : ''"
              @click="zc.setDurationUnit('blocks')"
            >
              Blk
            </button>
          </div>

          <!-- Demo / Mock Data Toggle (commented out for now; uncomment to preview mock Auctions/Portfolio/Bonds)
          <button
            type="button"
            class="sf-mono inline-flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-[11px] font-semibold transition-all"
            :class="
              zc.demoMode
                ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)] shadow-[0_0_16px_rgba(var(--sf-cobalt-rgb),0.18)]'
                : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)]'
            "
            :aria-pressed="zc.demoMode"
            :title="
              zc.demoMode
                ? 'Demo dataset active — click to switch back to live on-chain data'
                : 'Load sample Auctions, Portfolio, Bond & Offer data for previewing'
            "
            @click="zc.toggleDemoMode()"
          >
            <span
              class="h-1.5 w-1.5 rounded-full transition-colors"
              :class="zc.demoMode ? 'bg-[color:var(--sf-cobalt)]' : 'bg-[color:var(--sf-dim)]'"
            />
            <span>Demo</span>
          </button>
          -->

          <!-- Blockchain Feed Pill + Popover (Hergmes WS + Explorer REST + GraphQL) -->
          <div ref="feedRef" class="relative" @keydown.esc="feedOpen = false">
            <button
              type="button"
              class="sf-mono inline-flex h-8 items-center gap-2 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2.5 text-[11px] text-[color:var(--sf-ink-2)] transition-all hover:border-[color:var(--sf-line-cobalt)]"
              :title="chainTooltip"
              :aria-expanded="feedOpen"
              @click="toggleFeedPopover"
            >
              <span
                class="sf-live-dot"
                :class="{ 'is-warn': feedDotWarn, 'is-idle': feedDotIdle }"
              />
              <span v-if="zc.connected" class="hidden xl:inline">
                #{{ zc.height.toLocaleString("en-US") }}
                <span class="mx-1 opacity-40">·</span>
                <span class="font-semibold text-[color:var(--sf-ink)]">
                  ${{ zc.oracle.price.toFixed(3) }}
                </span>
              </span>
              <span v-else class="hidden xl:inline">{{ zc.loading ? "Sync" : "Offline" }}</span>
              <sliders-icon class="h-3.5 w-3.5 opacity-60" />
            </button>

            <transition name="sf-pop">
              <div
                v-if="feedOpen"
                class="sf-popover fixed inset-x-4 top-[66px] z-50 rounded-2xl p-4 sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+10px)] sm:w-[360px]"
              >
                <div class="flex items-center justify-between pb-3">
                  <span
                    class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[color:var(--sf-muted)]"
                  >
                    Ergo Chain Feed
                  </span>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-[11.5px] font-medium text-[color:var(--sf-cobalt)] hover:underline"
                    @click="zc.refresh()"
                  >
                    <refresh-cw-icon class="h-3 w-3" />
                    <span>Sync</span>
                  </button>
                </div>

                <!-- Transport Mode Switch: Hergmes WS vs Explorer API vs GraphQL -->
                <div
                  class="sf-seg mb-3 grid w-full grid-cols-3 text-[11px]"
                  role="tablist"
                  aria-label="Blockchain API transport"
                >
                  <button
                    type="button"
                    role="tab"
                    :aria-selected="feedModeInput === 'hergmes'"
                    class="sf-seg-btn py-1.5"
                    :class="feedModeInput === 'hergmes' ? 'is-active tone-cobalt' : ''"
                    @click="switchFeedMode('hergmes')"
                  >
                    Hergmes
                  </button>
                  <button
                    type="button"
                    role="tab"
                    :aria-selected="feedModeInput === 'explorer'"
                    class="sf-seg-btn py-1.5"
                    :class="feedModeInput === 'explorer' ? 'is-active tone-cobalt' : ''"
                    @click="switchFeedMode('explorer')"
                  >
                    Explorer API
                  </button>
                  <button
                    type="button"
                    role="tab"
                    :aria-selected="feedModeInput === 'graphql'"
                    class="sf-seg-btn py-1.5"
                    :class="feedModeInput === 'graphql' ? 'is-active tone-cobalt' : ''"
                    @click="switchFeedMode('graphql')"
                  >
                    GraphQL
                  </button>
                </div>

                <form class="space-y-2.5" @submit.prevent="saveEndpoint">
                  <div class="sf-input-well rounded-xl px-3 py-2">
                    <input
                      v-model="endpointInput"
                      :aria-label="
                        feedModeInput === 'hergmes'
                          ? 'Hergmes relay URL'
                          : feedModeInput === 'explorer'
                            ? 'Ergo Explorer API URL'
                            : 'Ergo GraphQL endpoint URL'
                      "
                      type="text"
                      :placeholder="
                        feedModeInput === 'hergmes'
                          ? zc.defaultHergmesUrl || DEFAULT_MAINNET_HERGMES_URL
                          : feedModeInput === 'explorer'
                            ? zc.defaultExplorerUrl
                            : zc.defaultGraphqlUrl
                      "
                      class="sf-mono w-full bg-transparent text-[11.5px] text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
                    />
                  </div>

                  <p
                    v-if="hergmesUrlInvalid"
                    class="text-[10.5px] text-[color:var(--sf-warn)]"
                  >
                    Enter a valid http:// or https:// Hergmes relay URL.
                  </p>

                  <!-- Quick Endpoint Presets -->
                  <div class="flex flex-wrap items-center gap-1.5">
                    <button
                      v-for="preset in activePresets"
                      :key="preset.url"
                      type="button"
                      class="sf-mono rounded-[7px] border px-2 py-1 text-[10.5px] font-medium transition-colors"
                      :class="
                        endpointInput.trim().replace(/\/+$/, '') ===
                        preset.url.replace(/\/+$/, '')
                          ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
                          : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)]'
                      "
                      @click="pickPreset(preset.url)"
                    >
                      {{ preset.label }}
                    </button>
                  </div>

                  <div class="flex items-center justify-between gap-2 pt-0.5">
                    <button
                      type="button"
                      class="text-[11.5px] text-[color:var(--sf-muted)] transition-colors hover:text-[color:var(--sf-ink)]"
                      @click="resetEndpoint"
                    >
                      Reset default
                    </button>
                    <button
                      type="submit"
                      :disabled="hergmesUrlInvalid"
                      class="sf-btn-cobalt rounded-full px-4 py-1.5 text-[11.5px] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Apply
                    </button>
                  </div>
                </form>

                <div
                  class="mt-3 space-y-1.5 border-t border-[color:var(--sf-line)] pt-2.5 text-[11px] text-[color:var(--sf-muted)]"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="truncate">
                      <template v-if="zc.dataSource === 'hergmes'">
                        {{ zc.network }} · Hergmes WS ({{ hergmesPhaseLabel }})
                      </template>
                      <template v-else-if="zc.connected">
                        {{ zc.network }} · {{ zc.dataSource === "graphql" ? "GraphQL" : "Explorer" }}
                      </template>
                      <template v-else>
                        {{ zc.error || "Offline" }}
                      </template>
                    </span>
                    <span v-if="zc.connected" class="sf-mono shrink-0">
                      #{{ zc.height.toLocaleString("en-US") }}
                    </span>
                  </div>
                  <div
                    v-if="zc.dataSource === 'hergmes'"
                    class="flex items-center justify-between gap-2 text-[10.5px]"
                  >
                    <span class="truncate text-[color:var(--sf-dim)]">
                      History &amp; spent boxes via Explorer API
                    </span>
                    <span
                      v-if="zc.mempoolActive && zc.streamPhase === 'live'"
                      class="sf-mono shrink-0 rounded bg-[color:var(--sf-bid-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[color:var(--sf-bid)]"
                    >
                      Mempool active
                    </span>
                  </div>
                  <div
                    v-if="zc.dataSource === 'hergmes' && (zc.streamError || (!zc.connected && !zc.loading))"
                    class="space-y-1.5 rounded-lg border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)]/60 px-2.5 py-2 text-[10.5px] text-[color:var(--sf-ask)]"
                  >
                    <div class="sf-mono font-semibold">
                      {{
                        zc.streamError
                          ? `${zc.streamError.code}: ${zc.streamError.message}`
                          : zc.error || "Hergmes relay offline"
                      }}
                    </div>
                    <button
                      v-if="zc.streamPhase === 'rejected' || (!zc.connected && !zc.loading)"
                      type="button"
                      class="sf-mono rounded bg-[color:var(--sf-card)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sf-ink)] hover:underline"
                      @click="fallbackToExplorer"
                    >
                      Switch to Explorer API
                    </button>
                  </div>
                  <div v-if="zc.connected && !zc.oracle.missing" class="sf-mono flex justify-between">
                    <span>ERG/USD Oracle</span>
                    <span :class="oracleStale ? 'text-[color:var(--sf-warn)]' : 'text-[color:var(--sf-bid)]'">
                      ${{ zc.oracle.price.toFixed(3) }} · {{ zc.oracle.age }} blk
                    </span>
                  </div>
                </div>
              </div>
            </transition>
          </div>

          <!-- V1 Switch -->
          <router-link
            to="/v1"
            class="hidden h-8 items-center gap-0.5 rounded-full border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2.5 text-[11.5px] font-medium text-[color:var(--sf-muted)] transition-all hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)] lg:inline-flex"
          >
            <span>V1</span>
            <arrow-up-right-icon class="h-3 w-3 opacity-65" />
          </router-link>

          <theme-toggle />

          <!-- Nautilus Wallet -->
          <button
            v-if="!wallet.connected"
            type="button"
            class="sf-btn-cobalt inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12px]"
            @click="wallet.connect('nautilus')"
          >
            <span>Connect</span>
          </button>
          <button
            v-else
            type="button"
            class="sf-mono inline-flex h-8 items-center gap-2 rounded-full border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-3 text-[11.5px] font-semibold text-[color:var(--sf-cobalt)] transition-all hover:brightness-110"
            :title="walletPendingTooltip"
            @click="wallet.disconnect()"
          >
            <span
              v-if="wallet.hasPendingTx"
              class="sf-live-dot is-warn"
              aria-label="Pending mempool transaction"
            />
            <span>{{ ergBalance }} ERG</span>
            <span class="hidden opacity-75 sm:inline">
              {{ shortenString(wallet.changeAddress, 9) }}
            </span>
          </button>
        </div>
      </div>

      <!-- Mobile Sub-Nav -->
      <nav
        class="mx-auto mt-1.5 flex max-w-[1680px] items-center gap-1 overflow-x-auto rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card-glass)] px-2 py-1 backdrop-blur-md md:hidden"
        aria-label="Mobile navigation"
      >
        <router-link
          v-for="item in navItems"
          :key="item.name"
          :to="item.to"
          class="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium whitespace-nowrap"
          :class="
            route.name === item.name
              ? 'bg-[color:var(--sf-seg-active)] text-[color:var(--sf-ink)] shadow-sm'
              : 'text-[color:var(--sf-muted)]'
          "
        >
          <span>{{ item.label }}</span>
          <span
            v-if="item.name === 'zc-auctions' && zc.auctionsCount > 0"
            class="sf-mono rounded bg-[color:var(--sf-cobalt-soft)] px-1 text-[10px] text-[color:var(--sf-cobalt)]"
          >
            {{ zc.auctionsCount }}
          </span>
          <span
            v-else-if="item.name === 'zc-portfolio' && zc.portfolio.attentionCount > 0"
            class="sf-mono rounded bg-[color:var(--sf-warn-soft)] px-1 text-[10px] text-[color:var(--sf-warn)]"
          >
            {{ zc.portfolio.attentionCount }}
          </span>
        </router-link>
      </nav>
    </header>

    <main
      class="relative z-10 mx-auto flex w-full max-w-[1680px] flex-1 flex-col px-3 pt-2.5 pb-3 sm:px-4"
      :class="isSingleScreen ? 'ratebook-main-lock' : 'py-5'"
    >
      <router-view />
    </main>

    <!-- Know Your Assumptions (KYA) Modal — shown once until accepted -->
    <transition name="sf-modal">
      <zc-kya-modal
        v-if="kyaOpen"
        :can-dismiss="ui.isKYAAccepted.value"
        @close="kyaOpen = false"
      />
    </transition>
  </div>
</template>

<style scoped>
.app-capsule {
  box-shadow: var(--sf-rim-top), var(--sf-shadow-card);
}

.app-capsule::after {
  content: "";
  position: absolute;
  left: 8%;
  right: 8%;
  bottom: -1px;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(var(--sf-cobalt-rgb), 0.34) 32%,
    rgba(var(--sf-bid-rgb), 0.24) 68%,
    transparent
  );
}

.nav-pill.is-active {
  background: var(--sf-seg-active);
  box-shadow:
    var(--sf-rim-top),
    0 1px 4px rgba(10, 16, 32, 0.14),
    0 0 0 1px var(--sf-seg-active-ring);
}

.app-contours {
  color: var(--sf-contour-color);
}
.app-contour-lines {
  opacity: calc(var(--sf-contour-line-opacity) * 0.65);
}
.app-contour-arcs {
  opacity: calc(var(--sf-contour-arc-opacity) * 0.6);
}

.app-wash-top {
  position: absolute;
  top: -260px;
  right: -8%;
  height: 620px;
  width: 820px;
  border-radius: 9999px;
  background: var(--sf-wash-top);
  opacity: 0.72;
  filter: blur(28px);
}

.app-wash-mid {
  position: absolute;
  bottom: -220px;
  left: -140px;
  height: 580px;
  width: 720px;
  border-radius: 9999px;
  background: var(--sf-wash-mid);
  opacity: 0.62;
  filter: blur(30px);
}

/* Single-screen desktop lock when viewport is wide & tall enough for comfortable charts + ledger */
@media (min-width: 1280px) and (min-height: 680px) {
  .ratebook-viewport-lock {
    height: 100vh;
    overflow: hidden;
  }
  .ratebook-main-lock {
    min-height: 0;
    overflow: hidden;
  }
}
</style>
