<script setup lang="ts">
import { ArrowUpRightIcon, RefreshCwIcon, SlidersIcon } from "@zhuowenli/vue-feather-icons";
import { onBeforeUnmount, onMounted, ref } from "vue";
import SigmaFiMark from "@/components/SigmaFiMark.vue";
import ThemeToggle from "@/components/ThemeToggle.vue";
import { ZcDataSource } from "@/services/zcApi";
import { useZcStore } from "@/stories/zcStore";

const zc = useZcStore();

const popoverOpen = ref(false);
const modeInput = ref<ZcDataSource>(zc.dataSource);
const endpointInput = ref(
  zc.dataSource === "graphql" ? zc.graphqlUrl : zc.baseUrl
);
const popoverRef = ref<HTMLElement | null>(null);

function togglePopover() {
  modeInput.value = zc.dataSource;
  endpointInput.value =
    zc.dataSource === "graphql" ? zc.graphqlUrl : zc.baseUrl;
  popoverOpen.value = !popoverOpen.value;
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
  popoverOpen.value = false;
}

function resetEndpoint() {
  modeInput.value = "graphql";
  endpointInput.value = zc.defaultGraphqlUrl;
  zc.updateDataSource("graphql");
  zc.updateGraphqlUrl("");
  popoverOpen.value = false;
}

function onDocumentClick(e: MouseEvent) {
  if (!popoverOpen.value) return;
  if (popoverRef.value && !popoverRef.value.contains(e.target as Node)) {
    popoverOpen.value = false;
  }
}

onMounted(() => document.addEventListener("mousedown", onDocumentClick));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocumentClick));
</script>

<template>
  <header class="sticky top-0 z-40 px-4 pt-3 sm:px-6">
    <div
      class="sf-header nav-capsule mx-auto flex h-[60px] max-w-[1280px] items-center justify-between gap-4 rounded-2xl border border-[color:var(--sf-line-strong)] px-4 backdrop-blur-xl sm:px-5"
    >
      <div class="flex items-center gap-7">
        <router-link to="/" class="group flex items-center gap-2.5">
          <sigma-fi-mark :size="28" />
          <span
            class="sf-serif text-[21px] font-semibold tracking-tight text-[color:var(--sf-ink)]"
          >
            SigmaFi
          </span>
          <span
            class="sf-mono rounded-[3px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-[color:var(--sf-cobalt)]"
          >
            V2
          </span>
        </router-link>

        <nav class="hidden items-center gap-1 lg:flex" aria-label="Primary">
          <router-link
            :to="{ hash: '#curves' }"
            class="rounded-full px-3 py-1.5 text-[13.5px] font-medium text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
          >
            P2P Exchange
          </router-link>
          <router-link
            :to="{ hash: '#yield-manifold' }"
            class="rounded-full px-3 py-1.5 text-[13.5px] font-medium text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
          >
            Yield Pricing
          </router-link>
          <router-link
            :to="{ hash: '#markets' }"
            class="rounded-full px-3 py-1.5 text-[13.5px] font-medium text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
          >
            Markets
          </router-link>
          <router-link
            to="/app/auctions"
            class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13.5px] font-medium text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
          >
            <span>Auctions</span>
            <span
              v-if="zc.auctionsCount > 0"
              class="sf-mono rounded-[3px] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--sf-cobalt)]"
            >
              {{ zc.auctionsCount }}
            </span>
          </router-link>
          <a
            href="https://sigmafi.gitbook.io/sigmafi-docs/"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[13.5px] font-medium text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
          >
            <span>Docs</span>
            <arrow-up-right-icon class="h-3.5 w-3.5 opacity-60" />
          </a>
        </nav>
      </div>

      <div class="flex items-center gap-1.5 sm:gap-2">
        <div ref="popoverRef" class="relative" @keydown.esc="popoverOpen = false">
          <button
            type="button"
            class="grid h-9 w-9 place-items-center rounded-full text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
            aria-label="Data feed settings"
            title="Data feed settings"
            :aria-expanded="popoverOpen"
            @click="togglePopover"
          >
            <sliders-icon class="h-4 w-4" />
          </button>

          <div
            v-if="popoverOpen"
            class="sf-plate fixed inset-x-4 top-[76px] z-50 rounded-2xl p-4 sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+12px)] sm:w-80"
          >
            <div class="flex items-center justify-between pb-3">
              <span
                class="sf-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--sf-muted)]"
              >
                Chain Data Feed
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
              <div>
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
                  class="sf-mono w-full rounded-lg border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-well)] px-3 py-2 text-[12px] text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none focus:border-[color:var(--sf-cobalt)]"
                />
              </div>

              <div class="flex items-center justify-between gap-2">
                <button
                  type="button"
                  class="text-[11.5px] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]"
                  @click="resetEndpoint"
                >
                  Use default
                </button>
                <button type="submit" class="sf-btn-primary rounded-full px-4 py-1.5 text-[12px]">
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

        <theme-toggle />

        <router-link
          to="/app"
          class="sf-btn-cobalt inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] sm:px-5"
        >
          <span>Launch App</span>
          <arrow-up-right-icon class="h-3.5 w-3.5" />
        </router-link>
      </div>
    </div>
  </header>
</template>

<style scoped>
.nav-capsule {
  box-shadow: var(--sf-rim-top), var(--sf-shadow-card);
}
</style>
