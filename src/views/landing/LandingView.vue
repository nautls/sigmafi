<script setup lang="ts">
import { ArrowRightIcon, ArrowUpRightIcon, HeartIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import MarketCoin from "@/components/MarketCoin.vue";
import SigmaFiMark from "@/components/SigmaFiMark.vue";
import SupportDevModal from "@/components/SupportDevModal.vue";
import ZcKyaModal from "@/components/ZcKyaModal.vue";
import { ERG_TOKEN_ID } from "@/constants";
import { vReveal } from "@/directives/vReveal";
import { useChainStore, useZcStore } from "@/stories";
import { ZcMarket } from "@/types/zc";
import { formatBigNumber } from "@/utils";
import { formatApr, formatCompact } from "@/utils/zcMath";
import DiscountSurface from "@/views/landing/DiscountSurface.vue";
import HeroSigmaBackdrop from "@/views/landing/HeroSigmaBackdrop.vue";
import HeroYieldExchange from "@/views/landing/HeroYieldExchange.vue";
import LandingHeader from "@/views/landing/LandingHeader.vue";
import MarketSparkline from "@/views/landing/MarketSparkline.vue";
import SafetyAuctionShowcase from "@/views/landing/SafetyAuctionShowcase.vue";
import SharesWrapShowcase from "@/views/landing/SharesWrapShowcase.vue";
import UnifiedCurveShowcase from "@/views/landing/UnifiedCurveShowcase.vue";

const zc = useZcStore();
const chain = useChainStore();
const supportOpen = ref(false);
const kyaOpen = ref(false);

onMounted(() => zc.start());
onBeforeUnmount(() => zc.stop());

function onCardPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

const bestLendAprBps = computed(() => {
  const candidates = [zc.markets.ERG.bestAskBps, zc.markets.SigUSD.bestAskBps].filter(
    (v): v is number => v != null
  );
  if (!candidates.length) return null;
  return zc.connected ? Math.max(...candidates) : null;
});

const openLiquidityDisplay = computed(() => {
  if (!zc.connected) return "2 Markets";
  return `$${formatCompact(zc.totalLiquidityUsd)}`;
});

const ergPriceDisplay = computed(() => {
  if (zc.connected && !zc.oracle.missing && zc.oracle.price > 0) {
    return `$${zc.oracle.price.toFixed(3)}`;
  }
  const fallback = chain.priceRates[ERG_TOKEN_ID]?.fiat;
  if (fallback && fallback > 0) {
    return `$${fallback.toFixed(3)}`;
  }
  return "—";
});

const marketCards = computed(() =>
  (["ERG", "SigUSD"] as ZcMarket[]).map((m) => {
    const snap = zc.markets[m];
    const totals = snap.curves?.totals;
    return {
      market: m,
      snap,
      bestBid: formatApr(zc.connected ? snap.bestBidBps : null),
      bestAsk: formatApr(zc.connected ? snap.bestAskBps : null),
      offerCap: `${formatCompact(totals?.offers.capital ?? 0)} ${m}`,
      askCap: `${formatCompact(totals?.asks.cost ?? 0)} ${m}`,
      offerCount: totals?.offers.count ?? 0,
      askCount: totals?.asks.count ?? 0
    };
  })
);

function openKya() {
  kyaOpen.value = true;
}
</script>

<template>
  <div class="sf-shell landing overflow-x-clip">
    <!-- Atmospheric Color Fields + Subtle Architectural Contour Artwork -->
    <div class="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div class="atmo-wash-top" />
      <div class="atmo-wash-mid" />
      <div class="atmo-wash-low" />

      <!-- Faint topographic yield contours, compass arcs & registration motifs -->
      <svg
        class="atmo-contours absolute inset-0 h-full w-full"
        viewBox="0 0 1440 960"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
      >
        <!-- Sweeping parametric yield contour curves -->
        <g class="contour-lines" stroke="currentColor" stroke-width="1">
          <path d="M-120 210 C 260 60, 580 340, 960 175 C 1210 66, 1390 120, 1560 72" />
          <path d="M-120 248 C 280 112, 600 378, 980 218 C 1225 112, 1395 162, 1560 118" />
          <path d="M-120 288 C 300 164, 620 416, 1000 264 C 1240 162, 1405 208, 1560 166" />
          <path d="M-80 790 C 240 650, 620 885, 1020 710 C 1245 612, 1410 656, 1560 605" />
          <path d="M-80 832 C 260 704, 640 924, 1040 756 C 1260 662, 1420 702, 1560 655" />
        </g>

        <!-- Faint drafting compass arcs -->
        <g class="contour-arcs" stroke="currentColor" stroke-width="1">
          <circle cx="1220" cy="180" r="340" stroke-dasharray="3 10" />
          <circle cx="1220" cy="180" r="490" />
          <circle cx="160" cy="760" r="320" stroke-dasharray="4 12" />
          <circle cx="160" cy="760" r="460" />
        </g>
      </svg>
    </div>

    <div class="relative z-10 flex min-h-screen flex-col">
      <landing-header />

      <main class="flex-1">
        <!-- ==========================================================
             HERO SECTION — Clean Morpho Opening + P2P Yield Plane
             ========================================================== -->
        <section class="mx-auto max-w-[1280px] px-5 pt-10 pb-14 sm:px-8 sm:pt-12 lg:pt-16 lg:pb-20">
          <div class="grid grid-cols-1 items-center gap-10 lg:grid-cols-[1.02fr_0.98fr] lg:gap-12">
            <div>
              <h1 class="sf-serif sf-rise hero-headline text-[color:var(--sf-ink)]">
                <span class="block sm:whitespace-nowrap">A P2P market for</span>
                <em class="hero-shimmer block sm:whitespace-nowrap">liquid yield.</em>
              </h1>

              <p class="sf-rise sf-rise-d1 hero-subcopy mt-5 text-[color:var(--sf-ink-2)]">
                Lend along rolling yield curves, borrow fixed-term against collateral baskets, and
                trade zero-coupon bonds or shares in one unified order book.
              </p>

              <div class="sf-rise sf-rise-d2 mt-7 flex flex-wrap items-center gap-3.5">
                <router-link
                  to="/app"
                  class="sf-btn-cobalt inline-flex h-12 items-center gap-2 rounded-full px-7 text-[15px]"
                >
                  <span>Launch App</span>
                  <arrow-right-icon class="h-4 w-4" />
                </router-link>

                <router-link
                  :to="{ hash: '#markets' }"
                  class="sf-btn-outline inline-flex h-12 items-center gap-2 rounded-full px-6 text-[14.5px]"
                >
                  <span>Explore Markets</span>
                </router-link>
              </div>
            </div>

            <div class="sf-rise sf-rise-d1 min-w-0">
              <hero-yield-exchange />
            </div>
          </div>

          <!-- Restyled Floating Sculptural Metric Strip -->
          <div
            v-reveal="40"
            class="mt-14 grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-4"
          >
            <div
              class="sf-bento stat-pill rounded-[20px] rounded-tl-[6px] px-5 py-5 sm:px-6"
              @mousemove="onCardPointerMove"
            >
              <span class="stat-accent-bar bg-[color:var(--sf-bid)]" />
              <div class="stat-label">Best Lend APR</div>
              <div class="sf-serif stat-figure text-[color:var(--sf-bid)]">
                {{ bestLendAprBps != null ? formatApr(bestLendAprBps) : "APR-Quoted" }}
              </div>
            </div>

            <div
              class="sf-bento stat-pill rounded-[20px] px-5 py-5 sm:px-6"
              @mousemove="onCardPointerMove"
            >
              <span class="stat-accent-bar bg-[color:var(--sf-cobalt)]" />
              <div class="stat-label">Open Orders</div>
              <div class="sf-serif stat-figure text-[color:var(--sf-ink)]">
                {{ zc.connected ? zc.totalOrdersCount : "ERG · SigUSD" }}
              </div>
            </div>

            <div
              class="sf-bento stat-pill rounded-[20px] px-5 py-5 sm:px-6"
              @mousemove="onCardPointerMove"
            >
              <span class="stat-accent-bar bg-[color:var(--sf-cobalt)]" />
              <div class="stat-label">Open Liquidity</div>
              <div class="sf-serif stat-figure text-[color:var(--sf-cobalt)]">
                {{ openLiquidityDisplay }}
              </div>
            </div>

            <div
              class="sf-bento stat-pill rounded-[20px] rounded-br-[6px] px-5 py-5 sm:px-6"
              @mousemove="onCardPointerMove"
            >
              <span class="stat-accent-bar bg-[color:var(--sf-ask)]" />
              <div class="stat-label">ERG / USD</div>
              <div class="sf-serif stat-figure text-[color:var(--sf-ink)]">
                {{ ergPriceDisplay }}
              </div>
            </div>
          </div>
        </section>

        <!-- ==========================================================
             CHAPTER 01 — P2P Exchange & Unified Market (Zero Graphs)
             ========================================================== -->
        <section
          id="curves"
          class="mx-auto max-w-[1280px] px-5 py-16 sm:px-8 lg:py-28"
        >
          <div class="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.12fr_0.88fr] lg:gap-16">
            <div v-reveal class="order-2 min-w-0 lg:order-1">
              <unified-curve-showcase />
            </div>

            <div v-reveal="80" class="order-1 lg:order-2">
              <h2 class="sf-serif chapter-title text-[color:var(--sf-ink)]">
                One market for loans,<br />
                <span class="title-accent-cobalt">resales, and curves.</span>
              </h2>
              <p class="chapter-copy mt-5 text-[color:var(--sf-ink-2)]">
                New borrow requests, whole bond resales, and fractional shares all clear directly
                peer-to-peer against the same standing lender curves — keeping credit liquid from
                origination to maturity.
              </p>

              <div class="mt-8 flex flex-wrap items-center gap-3.5">
                <router-link
                  to="/app?side=lend"
                  class="sf-btn-primary inline-flex h-11 items-center gap-2 rounded-full px-6 text-[14px]"
                >
                  <span>Lend on a Curve</span>
                  <arrow-right-icon class="h-4 w-4" />
                </router-link>
              </div>
            </div>
          </div>
        </section>

        <!-- ==========================================================
             CHAPTER 02 — Priced in Yield Itself (Deep Contrast Band + 3D Manifold)
             ========================================================== -->
        <section id="yield-manifold" class="sf-contrast-band relative overflow-hidden py-20 lg:py-28">
          <div class="contrast-glow" aria-hidden="true" />
          <div
            class="relative z-10 mx-auto grid max-w-[1280px] grid-cols-1 items-center gap-12 px-5 sm:px-8 lg:grid-cols-[0.86fr_1.14fr] lg:gap-16"
          >
            <div v-reveal>
              <h2 class="sf-serif chapter-title text-[color:var(--sf-ink)]">
                Priced in <span class="title-gradient-luminous">yield itself,</span><br />
                not currency.
              </h2>
              <p class="chapter-copy mt-5 text-[color:var(--sf-ink-2)]">
                Zero-coupon bonds change value with every passing block. By quoting the entire
                order book directly in APR, resting orders and secondary resales reprice
                automatically as maturity approaches.
              </p>

              <div class="mt-8 flex flex-wrap items-center gap-3.5">
                <router-link
                  to="/app"
                  class="sf-btn-cobalt inline-flex h-11 items-center gap-2 rounded-full px-6 text-[14px]"
                >
                  <span>Explore Yield Curve</span>
                  <arrow-right-icon class="h-4 w-4" />
                </router-link>
              </div>
            </div>

            <div v-reveal="80" class="min-w-0">
              <discount-surface :dark-stage="true" />
            </div>
          </div>
        </section>

        <!-- ==========================================================
             CHAPTER 03 — Collateral Baskets & Falling-Price Dutch Auctions
             ========================================================== -->
        <section
          id="safety"
          class="mx-auto max-w-[1280px] px-5 py-20 sm:px-8 lg:py-28"
        >
          <div class="grid grid-cols-1 items-center gap-12 lg:grid-cols-[0.88fr_1.12fr] lg:gap-16">
            <div v-reveal>
              <h2 class="sf-serif chapter-title text-[color:var(--sf-ink)]">
                Collateral baskets.<br />
                <span class="title-accent-muted">Dutch auction recovery.</span>
              </h2>
              <p class="chapter-copy mt-5 text-[color:var(--sf-ink-2)]">
                Borrowers can pledge ERG, SigUSD, Ergo tokens, and wrapped LP receipts together in a
                single vault to strengthen lender safety. When liquidation or collateral lot sales
                trigger, falling-price Dutch auctions clear assets smoothly.
              </p>

              <div class="mt-8 flex flex-wrap items-center gap-3.5">
                <router-link
                  to="/app/auctions"
                  class="sf-btn-primary inline-flex h-11 items-center gap-2 rounded-full px-6 text-[14px]"
                >
                  <span>View Auctions</span>
                  <arrow-right-icon class="h-4 w-4" />
                </router-link>
              </div>
            </div>

            <div v-reveal="80" class="min-w-0">
              <safety-auction-showcase />
            </div>
          </div>
        </section>

        <!-- ==========================================================
             CHAPTER 04 — Bond Share Fractionalization & NFT Custody Wraps
             ========================================================== -->
        <section
          id="primitives"
          class="mx-auto max-w-[1280px] border-t border-[color:var(--sf-line)] px-5 py-20 sm:px-8 lg:py-28"
        >
          <div class="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.12fr_0.88fr] lg:gap-16">
            <div v-reveal class="order-2 min-w-0 lg:order-1">
              <shares-wrap-showcase />
            </div>

            <div v-reveal="80" class="order-1 lg:order-2">
              <h2 class="sf-serif chapter-title text-[color:var(--sf-ink)]">
                Split bonds into shares.<br />
                <span class="title-accent-cobalt">Wrap NFTs safely.</span>
              </h2>
              <p class="chapter-copy mt-5 text-[color:var(--sf-ink-2)]">
                Divide any circulating bond into 100 fungible shares to sell partial exposure on the
                open book, and lock LP position NFTs inside immutable custody vaults to pledge clean
                1:1 receipts as collateral.
              </p>

              <div class="mt-8 flex flex-wrap items-center gap-3.5">
                <router-link
                  to="/app"
                  class="sf-btn-cobalt inline-flex h-11 items-center gap-2 rounded-full px-6 text-[14px]"
                >
                  <span>Launch App</span>
                  <arrow-right-icon class="h-4 w-4" />
                </router-link>
              </div>
            </div>
          </div>
        </section>

        <!-- ==========================================================
             ACTIVE BOND MARKETS — Clean Minimal Entry Cards
             ========================================================== -->
        <section
          id="markets"
          class="mx-auto max-w-[1280px] border-t border-[color:var(--sf-line)] px-5 py-20 sm:px-8 lg:py-24"
        >
          <div v-reveal class="mb-10 flex flex-wrap items-end justify-between gap-4">
            <h2 class="sf-serif chapter-title text-[color:var(--sf-ink)]">Bond markets</h2>

            <router-link
              to="/app"
              class="sf-btn-outline inline-flex h-10 items-center gap-2 rounded-full px-5 text-[13.5px]"
            >
              <span>All maturities</span>
              <arrow-right-icon class="h-3.5 w-3.5" />
            </router-link>
          </div>

          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <router-link
              v-for="(card, idx) in marketCards"
              :key="card.market"
              v-reveal="idx * 80"
              :to="`/app?market=${card.market}`"
              class="sf-bento group flex flex-col justify-between rounded-[24px] p-6 sm:p-7"
              @mousemove="onCardPointerMove"
            >
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-3.5">
                  <market-coin :market="card.market" :size="42" />
                  <div>
                    <h3 class="sf-serif text-[28px] font-medium leading-none text-[color:var(--sf-ink)]">
                      {{ card.market }}
                    </h3>
                    <div
                      v-if="zc.connected && card.snap.curves"
                      class="sf-mono mt-1.5 text-[11.5px] text-[color:var(--sf-muted)]"
                    >
                      {{ card.offerCount }} offers · {{ card.askCount }} asks
                    </div>
                  </div>
                </div>

                <span
                  class="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] text-[color:var(--sf-muted)] transition-all duration-200 group-hover:border-[color:var(--sf-cobalt)] group-hover:bg-[color:var(--sf-cobalt)] group-hover:text-white"
                >
                  <arrow-up-right-icon class="h-4 w-4" />
                </span>
              </div>

              <div
                v-if="zc.connected && card.snap.curves && card.offerCount + card.askCount > 0"
                class="sf-stage-sharp my-5 px-3.5 py-2.5"
              >
                <market-sparkline
                  :curves="card.snap.curves"
                  :asks="card.snap.asks"
                  :height="zc.height"
                  :oracle-refreshing="zc.oracle.refreshPending"
                />
              </div>

              <dl
                class="mt-6 grid grid-cols-2 gap-4 border-t border-[color:var(--sf-line)] pt-4 sm:grid-cols-4"
              >
                <div>
                  <dt class="sf-mono text-[10px] uppercase tracking-[0.11em] text-[color:var(--sf-muted)]">
                    Best Bid
                  </dt>
                  <dd class="sf-mono mt-1 text-[16px] font-semibold text-[color:var(--sf-bid)]">
                    {{ card.bestBid }}
                  </dd>
                </div>
                <div>
                  <dt class="sf-mono text-[10px] uppercase tracking-[0.11em] text-[color:var(--sf-muted)]">
                    Best Ask
                  </dt>
                  <dd class="sf-mono mt-1 text-[16px] font-semibold text-[color:var(--sf-ask)]">
                    {{ card.bestAsk }}
                  </dd>
                </div>
                <div>
                  <dt class="sf-mono text-[10px] uppercase tracking-[0.11em] text-[color:var(--sf-muted)]">
                    Offers
                  </dt>
                  <dd class="sf-mono mt-1 text-[14.5px] font-medium text-[color:var(--sf-ink-2)]">
                    {{ zc.connected && card.snap.curves ? card.offerCap : "—" }}
                  </dd>
                </div>
                <div>
                  <dt class="sf-mono text-[10px] uppercase tracking-[0.11em] text-[color:var(--sf-muted)]">
                    Asks
                  </dt>
                  <dd class="sf-mono mt-1 text-[14.5px] font-medium text-[color:var(--sf-ink-2)]">
                    {{ zc.connected && card.snap.curves ? card.askCap : "—" }}
                  </dd>
                </div>
              </dl>
            </router-link>
          </div>
        </section>

        <!-- ==========================================================
             CLOSING STAGE — Contrast Showcase + Engraved Sigma Motif
             ========================================================== -->
        <section class="mx-auto max-w-[1280px] px-5 pb-16 sm:px-8 lg:pb-24">
          <div
            v-reveal
            class="sf-contrast-band cta-stage relative overflow-hidden rounded-[28px] border border-[color:var(--sf-line-strong)] px-7 py-12 sm:px-11 sm:py-16 lg:px-14"
          >
            <div class="cta-stage-glow" aria-hidden="true" />
            <!-- Selective subtle drafting grid strictly inside the engraved Sigma showcase -->
            <div
              class="sf-graph-bg pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_68%_78%_at_76%_50%,#000_22%,transparent_100%)]"
              aria-hidden="true"
            />

            <div class="relative z-10 grid grid-cols-1 items-center gap-10 lg:grid-cols-[1.12fr_0.88fr]">
              <div>
                <h2 class="sf-serif chapter-title text-[color:var(--sf-ink)]">
                  Start trading <em class="hero-shimmer">liquid yield.</em>
                </h2>
                <p class="chapter-copy mt-4 text-[color:var(--sf-ink-2)]">
                  Connect Nautilus to lend along rolling curves, borrow fixed-term against basket
                  collateral, or trade bond shares on Ergo.
                </p>

                <div class="mt-8 flex flex-wrap items-center gap-3.5">
                  <router-link
                    to="/app"
                    class="sf-btn-cobalt inline-flex h-12 items-center gap-2 rounded-full px-7 text-[15px]"
                  >
                    <span>Launch SigmaFi App</span>
                    <arrow-right-icon class="h-4 w-4" />
                  </router-link>
                  <button
                    type="button"
                    class="sf-btn-outline inline-flex h-12 items-center gap-2 rounded-full px-6 text-[14.5px]"
                    @click="supportOpen = true"
                  >
                    <heart-icon class="h-4 w-4 text-[color:var(--sf-cobalt)]" />
                    <span>Support Development</span>
                  </button>
                </div>
              </div>

              <div class="mx-auto w-full max-w-[380px] lg:max-w-none">
                <hero-sigma-backdrop />
              </div>
            </div>
          </div>

          <!-- Compact SigmaFi V1 Legacy Access -->
          <div
            v-reveal="40"
            class="mt-6 flex flex-col items-start justify-between gap-4 rounded-[12px] border border-[color:var(--sf-line)] bg-[color:var(--sf-card-glass)] px-5 py-4 sm:flex-row sm:items-center sm:px-6"
          >
            <div class="flex flex-wrap items-center gap-3">
              <span
                class="sf-mono rounded-[3px] border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-well)] px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[color:var(--sf-ink)]"
              >
                SigmaFi V1
              </span>
              <span class="text-[13.5px] text-[color:var(--sf-ink-2)]">
                First-generation loan requests and active bonds remain accessible.
              </span>
              <span
                v-if="chain.tvl?.gt(0)"
                class="sf-mono rounded-[3px] bg-[color:var(--sf-cobalt-soft)] px-2 py-0.5 text-[11px] font-semibold text-[color:var(--sf-cobalt)]"
              >
                TVL ${{ formatBigNumber(chain.tvl, 2) }}
              </span>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <router-link
                to="/v1"
                class="sf-btn-outline inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12px]"
              >
                <span>V1 Market</span>
                <arrow-right-icon class="h-3 w-3" />
              </router-link>
              <router-link
                to="/v1/dashboard"
                class="inline-flex h-8 items-center rounded-full px-3 text-[12px] font-medium text-[color:var(--sf-muted)] transition-colors hover:text-[color:var(--sf-ink)]"
              >
                Dashboard
              </router-link>
            </div>
          </div>
        </section>
      </main>

      <!-- ==========================================================
           STRUCTURED FOOTER
           ========================================================== -->
      <footer class="border-t border-[color:var(--sf-line)] bg-[color:var(--sf-paper-2)]">
        <div
          class="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 px-5 py-12 text-[13px] text-[color:var(--sf-muted)] sm:grid-cols-2 sm:px-8 lg:grid-cols-[1.5fr_1fr_1fr_1fr]"
        >
          <div>
            <div class="flex items-center gap-2.5">
              <sigma-fi-mark :size="24" />
              <span class="sf-serif text-[20px] font-semibold text-[color:var(--sf-ink)]">
                SigmaFi
              </span>
            </div>
            <p class="mt-3 max-w-[30ch] text-[13px] leading-relaxed text-[color:var(--sf-muted)]">
              A P2P market for liquid yield on Ergo.
            </p>
          </div>

          <div>
            <div
              class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[color:var(--sf-ink)]"
            >
              Application
            </div>
            <ul class="mt-3 space-y-2">
              <li>
                <router-link to="/app" class="transition-colors hover:text-[color:var(--sf-ink)]">
                  Yield Curve
                </router-link>
              </li>
              <li>
                <router-link
                  to="/app/market"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                >
                  Market
                </router-link>
              </li>
              <li>
                <router-link
                  to="/app/studio"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                >
                  Studio
                </router-link>
              </li>
              <li>
                <router-link
                  to="/app/auctions"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                >
                  Dutch Auctions
                </router-link>
              </li>
              <li>
                <router-link
                  to="/app/portfolio"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                >
                  Portfolio
                </router-link>
              </li>
              <li>
                <router-link to="/v1" class="transition-colors hover:text-[color:var(--sf-ink)]">
                  SigmaFi V1
                </router-link>
              </li>
            </ul>
          </div>

          <div>
            <div
              class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[color:var(--sf-ink)]"
            >
              Contracts &amp; Code
            </div>
            <ul class="mt-3 space-y-2">
              <li>
                <a
                  href="https://github.com/Lithos-Protocol/Sigma-Finance-V2"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                >
                  ZC Standard Contracts
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/K-Singh/Sigma-Finance"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                >
                  V1 Contracts
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/nautls/sigmafi"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                >
                  UI Repository
                </a>
              </li>
            </ul>
          </div>

          <div>
            <div
              class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[color:var(--sf-ink)]"
            >
              Resources
            </div>
            <ul class="mt-3 space-y-2">
              <li>
                <a
                  href="https://sigmafi.gitbook.io/sigmafi-docs/"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                >
                  Documentation
                </a>
              </li>
              <li>
                <button
                  type="button"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                  @click="openKya"
                >
                  Know Your Assumptions (KYA)
                </button>
              </li>
              <li>
                <button
                  type="button"
                  class="transition-colors hover:text-[color:var(--sf-ink)]"
                  @click="supportOpen = true"
                >
                  Support Development
                </button>
              </li>
            </ul>
          </div>
        </div>
      </footer>
    </div>

    <transition name="sf-modal">
      <support-dev-modal v-if="supportOpen" @close="supportOpen = false" />
    </transition>

    <transition name="sf-modal">
      <zc-kya-modal v-if="kyaOpen" :can-dismiss="true" @close="kyaOpen = false" />
    </transition>
  </div>
</template>

<style scoped>
.hero-headline {
  font-size: clamp(2.4rem, 11.8vw, 2.9rem);
  font-weight: 500;
  line-height: 1.04;
  letter-spacing: -0.04em;
}

@media (min-width: 640px) {
  .hero-headline {
    font-size: clamp(2.9rem, 4.65vw, 4.5rem);
  }
}

.hero-shimmer {
  font-style: italic;
  font-weight: 400;
  background: linear-gradient(112deg, var(--sf-cobalt) 0%, #3b82f6 44%, var(--sf-bid) 100%);
  background-size: 200% auto;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: sfTitleShimmer 9s ease-in-out infinite alternate;
}

@keyframes sfTitleShimmer {
  from {
    background-position: 0% 50%;
  }
  to {
    background-position: 100% 50%;
  }
}

.hero-subcopy {
  max-width: 42ch;
  font-size: 1.12rem;
  line-height: 1.62;
}

.chapter-title {
  font-size: clamp(2.35rem, 4.4vw, 3.45rem);
  font-weight: 500;
  line-height: 1.03;
  letter-spacing: -0.042em;
}

.title-accent-cobalt {
  color: var(--sf-cobalt);
}

.title-accent-muted {
  color: var(--sf-muted);
}

.title-gradient-luminous {
  background: linear-gradient(115deg, #8ab9ff 0%, #48eab5 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.chapter-copy {
  max-width: 46ch;
  font-size: 1.04rem;
  line-height: 1.65;
}

/* Faint sculptural background contour artwork (themed cleanly via CSS vars) */
.atmo-contours {
  color: var(--sf-contour-color);
}

.contour-lines {
  opacity: var(--sf-contour-line-opacity);
}

.contour-arcs {
  opacity: var(--sf-contour-arc-opacity);
}

/* Multi-hue atmospheric washes (themed cleanly via CSS vars, zero root leakage) */
.atmo-wash-top {
  position: absolute;
  top: -220px;
  right: -10%;
  height: 760px;
  width: 960px;
  border-radius: 9999px;
  background: var(--sf-wash-top);
  filter: blur(24px);
}

.atmo-wash-mid {
  position: absolute;
  top: 26%;
  left: -180px;
  height: 680px;
  width: 800px;
  border-radius: 9999px;
  background: var(--sf-wash-mid);
  filter: blur(28px);
}

.atmo-wash-low {
  position: absolute;
  bottom: 2%;
  right: -120px;
  height: 640px;
  width: 760px;
  border-radius: 9999px;
  background: var(--sf-wash-low);
  filter: blur(28px);
}

/* Floating Sculptural Metric Strip */
.stat-pill {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: var(--sf-card-glass);
  backdrop-filter: blur(12px);
}

.stat-accent-bar {
  display: block;
  width: 24px;
  height: 2.5px;
  border-radius: 9999px;
  margin-bottom: 14px;
  opacity: 0.85;
}

.stat-label {
  font-family: var(--sf-font-sans);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--sf-muted);
}

.stat-figure {
  margin-top: 6px;
  font-size: clamp(1.75rem, 2.7vw, 2.15rem);
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1.05;
}

.contrast-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 52% 72% at 75% 42%, rgba(92, 152, 255, 0.28), transparent 72%),
    radial-gradient(ellipse 46% 64% at 18% 72%, rgba(66, 232, 176, 0.16), transparent 74%);
}

.cta-stage {
  box-shadow: var(--sf-rim-top), var(--sf-shadow-hero);
}

.cta-stage-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 58% 76% at 82% 32%, rgba(98, 152, 255, 0.28), transparent 72%),
    radial-gradient(ellipse 48% 68% at 14% 85%, rgba(66, 232, 176, 0.16), transparent 74%);
}

@media (prefers-reduced-motion: reduce) {
  .hero-shimmer {
    animation: none;
  }
}
</style>
