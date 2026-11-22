<script setup lang="ts">
import { decimalize } from "@fleet-sdk/common";
import { ArrowUpRightIcon, RefreshCwIcon, SlidersIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import MarketCoin from "@/components/MarketCoin.vue";
import SigmaFiMark from "@/components/SigmaFiMark.vue";
import ThemeToggle from "@/components/ThemeToggle.vue";
import { ERG_DECIMALS } from "@/constants";
import { ZcDataSource } from "@/services/zcApi";
import { useWalletStore, useZcStore } from "@/stories";
import { ZcMarket } from "@/types/zc";
import { shortenString } from "@/utils";

const zc = useZcStore();
const wallet = useWalletStore();
const route = useRoute();

const feedOpen = ref(false);
const modeInput = ref<ZcDataSource>(zc.dataSource);
const endpointInput = ref(
  zc.dataSource === "graphql" ? zc.graphqlUrl : zc.baseUrl
);
const feedRef = ref<HTMLElement | null>(null);

function syncRouteMarket() {
  const qMarket = route.query.market;
  if (qMarket === "ERG" || qMarket === "SigUSD") {
    zc.setActiveMarket(qMarket);
  }
}

function toggleFeedPopover() {
  modeInput.value = zc.dataSource;
  endpointInput.value =
    zc.dataSource === "graphql" ? zc.graphqlUrl : zc.baseUrl;
  feedOpen.value = !feedOpen.value;
}

function selectMode(mode: ZcDataSource) {
  modeInput.value = mode;
  endpointInput.value = mode === "graphql" ? zc.graphqlUrl : zc.baseUrl;
}

function saveEndpoint() {
  if (modeInput.value !== zc.dataSource) {
    zc.updateDataSource(modeInput.value);
  }
  if (modeInput.value === "graphql") {
    zc.updateGraphqlUrl(endpointInput.value);
  } else {
    zc.updateBaseUrl(endpointInput.value);
  }
  feedOpen.value = false;
}

function resetEndpoint() {
  modeInput.value = "graphql";
  endpointInput.value = zc.defaultGraphqlUrl;
  zc.updateDataSource("graphql");
  zc.updateGraphqlUrl("");
  feedOpen.value = false;
}

function onDocClick(e: MouseEvent) {
  if (!feedOpen.value) return;
  if (feedRef.value && !feedRef.value.contains(e.target as Node)) {
    feedOpen.value = false;
  }
}

watch(() => route.query.market, syncRouteMarket, { immediate: true });

onMounted(() => {
  zc.start();
  document.addEventListener("mousedown", onDocClick);
});

onBeforeUnmount(() => {
  zc.stop();
  document.removeEventListener("mousedown", onDocClick);
});

const ergBalance = computed(() => {
  const raw = wallet.balance.find((x) => x.tokenId === "ERG")?.amount || "0";
  return decimalize(raw, { decimals: ERG_DECIMALS, thousandMark: "," });
});

const oracleStale = computed(
  () => zc.connected && (zc.oracle.missing || zc.oracle.refreshPending || zc.oracle.age > 30)
);

const navItems = [
  { to: "/app", label: "Rate Book", name: "zc-market" },
  { to: "/app/auctions", label: "Auctions", name: "zc-auctions" },
  { to: "/app/portfolio", label: "Portfolio", name: "zc-portfolio" }
];
</script>

<template>
  <div class="sf-shell relative flex min-h-screen flex-col overflow-x-clip">
    <!-- Subtle Quantitative Paper backdrop -->
    <div class="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div
        class="sf-graph-bg absolute inset-0 opacity-65 [mask-image:radial-gradient(ellipse_95%_60%_at_50%_0%,#000_25%,transparent_100%)]"
      />
    </div>

    <header
      class="sticky top-0 z-40 border-b border-[color:var(--sf-line)] sf-header backdrop-blur-md"
    >
      <div
        class="mx-auto flex min-h-[4rem] max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-8"
      >
        <div class="flex items-center gap-6">
          <router-link to="/" class="flex items-center gap-2.5">
            <sigma-fi-mark :size="28" />
            <span class="sf-serif text-[19px] font-semibold text-[color:var(--sf-ink)]">
              SigmaFi
            </span>
          </router-link>

          <nav class="hidden items-center gap-1 md:flex" aria-label="ZC App">
            <router-link
              v-for="item in navItems"
              :key="item.name"
              :to="item.to"
              class="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors"
              :class="
                route.name === item.name
                  ? 'bg-[color:var(--sf-well)] text-[color:var(--sf-ink)] ring-1 ring-[color:var(--sf-line)]'
                  : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
            >
              <span>{{ item.label }}</span>
              <span
                v-if="item.name === 'zc-auctions' && zc.auctionsCount > 0"
                class="sf-mono rounded bg-cobalt-50 px-1.5 py-0.5 text-[10px] text-cobalt-600 ring-1 ring-cobalt-600/20"
              >
                {{ zc.auctionsCount }}
              </span>
            </router-link>
          </nav>
        </div>

        <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <!-- Market Switch -->
          <div
            class="inline-flex rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
            role="tablist"
            aria-label="Active market"
          >
            <button
              v-for="m in (['ERG', 'SigUSD'] as ZcMarket[])"
              :key="m"
              type="button"
              role="tab"
              :aria-selected="zc.activeMarket === m"
              class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-all"
              :class="
                zc.activeMarket === m
                  ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
                  : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="zc.setActiveMarket(m)"
            >
              <market-coin :market="m" :size="14" />
              <span>{{ m }}</span>
            </button>
          </div>

          <!-- Duration Unit -->
          <div
            class="hidden rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5 sm:inline-flex"
            role="group"
            aria-label="Duration display unit"
          >
            <button
              v-for="u in (['days', 'blocks'] as const)"
              :key="u"
              type="button"
              :aria-pressed="zc.durationUnit === u"
              class="sf-mono rounded-md px-2 py-1 text-[11px] capitalize transition-all"
              :class="
                zc.durationUnit === u
                  ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
                  : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="zc.setDurationUnit(u)"
            >
              {{ u }}
            </button>
          </div>

          <!-- Live Chain Pill + Data Feed Popover -->
          <div ref="feedRef" class="relative" @keydown.esc="feedOpen = false">
            <button
              type="button"
              class="sf-mono inline-flex h-8 items-center gap-2 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2.5 text-[11px] text-[color:var(--sf-ink-2)] transition-colors hover:border-[color:var(--sf-line-strong)]"
              title="Data feed & chain state"
              :aria-expanded="feedOpen"
              @click="toggleFeedPopover"
            >
              <span
                class="sf-live-dot"
                :class="{ 'is-warn': oracleStale, 'is-idle': !zc.connected }"
              />
              <span v-if="zc.connected" class="hidden lg:inline">
                #{{ zc.height.toLocaleString("en-US") }} · ERG ${{ zc.oracle.price.toFixed(3) }}
              </span>
              <span v-else class="hidden lg:inline">Offline</span>
              <sliders-icon class="h-3.5 w-3.5 opacity-60" />
            </button>

            <div
              v-if="feedOpen"
              class="sf-plate fixed inset-x-4 top-[64px] z-50 rounded-xl p-4 sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+10px)] sm:w-80"
            >
              <div class="flex items-center justify-between pb-3">
                <span
                  class="sf-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--sf-muted)]"
                >
                  Chain Data Feed
                </span>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 text-[11.5px] font-medium text-cobalt-600 hover:text-cobalt-700"
                  @click="zc.refresh()"
                >
                  <refresh-cw-icon class="h-3 w-3" />
                  <span>Sync</span>
                </button>
              </div>

              <div
                class="mb-3 grid grid-cols-2 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5 text-[11.5px]"
                role="group"
                aria-label="Data source mode"
              >
                <button
                  type="button"
                  :aria-pressed="modeInput === 'graphql'"
                  class="rounded-md px-2 py-1 font-medium transition-all"
                  :class="
                    modeInput === 'graphql'
                      ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
                      : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
                  "
                  @click="selectMode('graphql')"
                >
                  Ergo GraphQL
                </button>
                <button
                  type="button"
                  :aria-pressed="modeInput === 'lithos'"
                  class="rounded-md px-2 py-1 font-medium transition-all"
                  :class="
                    modeInput === 'lithos'
                      ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
                      : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
                  "
                  @click="selectMode('lithos')"
                >
                  Lithos Client
                </button>
              </div>

              <form class="space-y-3" @submit.prevent="saveEndpoint">
                <input
                  v-model="endpointInput"
                  :aria-label="
                    modeInput === 'graphql' ? 'Ergo GraphQL endpoint URL' : 'Lithos client URL'
                  "
                  type="text"
                  :placeholder="
                    modeInput === 'graphql'
                      ? zc.defaultGraphqlUrl
                      : 'Default proxy (127.0.0.1:9000)'
                  "
                  class="sf-mono w-full rounded-lg border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-well)] px-3 py-2 text-[12px] text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none focus:border-cobalt-600"
                />
                <div class="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    class="text-[11.5px] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]"
                    @click="resetEndpoint"
                  >
                    Use default
                  </button>
                  <button type="submit" class="sf-btn-primary rounded-lg px-3.5 py-1.5 text-[12px]">
                    Apply
                  </button>
                </div>
              </form>

              <div
                class="mt-3 flex items-center justify-between border-t border-[color:var(--sf-line)] pt-2.5 text-[11px] text-[color:var(--sf-muted)]"
              >
                <span>{{
                  zc.connected
                    ? `${zc.network} · ${zc.dataSource === 'graphql' ? 'GraphQL' : 'Lithos'} · ${zc.profile}`
                    : zc.error || "Offline"
                }}</span>
                <span v-if="zc.connected" class="sf-mono">rev {{ zc.revision }}</span>
              </div>
            </div>
          </div>

          <!-- V1 Switch -->
          <router-link
            to="/v1"
            class="hidden h-8 items-center gap-1 rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2.5 text-[12px] font-medium text-[color:var(--sf-muted)] transition-colors hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)] sm:inline-flex"
          >
            <span>V1</span>
            <arrow-up-right-icon class="h-3 w-3 opacity-70" />
          </router-link>

          <theme-toggle />

          <!-- Nautilus Wallet -->
          <button
            v-if="!wallet.connected"
            type="button"
            class="sf-btn-primary inline-flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-[12px]"
            @click="wallet.connect('nautilus')"
          >
            <span>Connect</span>
          </button>
          <button
            v-else
            type="button"
            class="sf-mono inline-flex h-8 items-center gap-2 rounded-lg border border-cobalt-600/30 bg-cobalt-50 px-3 text-[11.5px] font-medium text-cobalt-700 transition-colors hover:bg-cobalt-100"
            @click="wallet.disconnect()"
          >
            <span>{{ ergBalance }} ERG</span>
            <span class="hidden opacity-65 sm:inline">{{
              shortenString(wallet.changeAddress, 10)
            }}</span>
          </button>
        </div>
      </div>

      <!-- Mobile sub-nav -->
      <nav
        class="flex items-center gap-1 border-t border-[color:var(--sf-line)] px-4 py-1.5 md:hidden"
        aria-label="Mobile ZC navigation"
      >
        <router-link
          v-for="item in navItems"
          :key="item.name"
          :to="item.to"
          class="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium"
          :class="
            route.name === item.name
              ? 'bg-[color:var(--sf-well)] text-[color:var(--sf-ink)]'
              : 'text-[color:var(--sf-muted)]'
          "
        >
          <span>{{ item.label }}</span>
          <span
            v-if="item.name === 'zc-auctions' && zc.auctionsCount > 0"
            class="sf-mono rounded bg-cobalt-50 px-1 text-[10px] text-cobalt-600"
          >
            {{ zc.auctionsCount }}
          </span>
        </router-link>
      </nav>
    </header>

    <main class="relative z-10 mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-8 sm:py-7">
      <router-view />
    </main>
  </div>
</template>
