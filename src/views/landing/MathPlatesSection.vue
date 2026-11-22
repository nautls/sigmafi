<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import HeroSigmaBackdrop from "./HeroSigmaBackdrop.vue";

/* ---- FIG. 02: Zero-Coupon Bond Convergence + Share Split ---- */
const bondView = ref<"unit" | "shares">("unit");

/* ---- FIG. 03: Interactive zcs1 Rolling Curve Presets ---- */
type CurveShape = "normal" | "flat" | "inverted" | "humped";
const SHAPES: { key: CurveShape; label: string; fn: (t: number) => number }[] = [
  { key: "normal", label: "Normal", fn: (t) => 0.78 + 0.44 * Math.sqrt(t) },
  { key: "flat", label: "Flat", fn: () => 1.0 },
  { key: "inverted", label: "Inverted", fn: (t) => 1.24 - 0.44 * Math.sqrt(t) },
  { key: "humped", label: "Humped", fn: (t) => 0.84 + 0.36 * Math.sin(Math.PI * Math.min(1, t * 1.2)) }
];
const activeShape = ref<CurveShape>("normal");

const curveNodes = computed(() => {
  const shape = SHAPES.find((s) => s.key === activeShape.value) || SHAPES[0];
  const baseRate = 9.5;
  return Array.from({ length: 6 }, (_, i) => {
    const t = i / 5;
    const rate = baseRate * shape.fn(t);
    const x = 18 + t * 244;
    const y = 78 - ((rate - 5) / 9) * 58;
    return { x, y, rate };
  });
});

const curvePath = computed(() =>
  curveNodes.value
    .map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ")
);

const curveArea = computed(() => {
  const pts = curveNodes.value;
  return `${curvePath.value} L${pts[pts.length - 1].x.toFixed(1)},88 L${pts[0].x.toFixed(1)},88 Z`;
});

/* ---- FIG. 04: Animated Dutch Auction Price Sweep ---- */
const auctionProgress = ref(0.42);
const auctionPaused = ref(false);
const auctionPlate = ref<HTMLElement | null>(null);
const auctionVisible = ref(false);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let observer: IntersectionObserver | null = null;
let rafId: number | null = null;
let lastTs = 0;

function tickAuction(ts: number) {
  if (!lastTs) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  auctionProgress.value = (auctionProgress.value + dt * 0.14) % 1;
  rafId = window.requestAnimationFrame(tickAuction);
}

function syncAuctionMotion() {
  if (rafId !== null) window.cancelAnimationFrame(rafId);
  rafId = null;
  lastTs = 0;
  if (auctionVisible.value && !auctionPaused.value && !reduceMotion.matches && !document.hidden) {
    rafId = window.requestAnimationFrame(tickAuction);
  }
}

watch([auctionVisible, auctionPaused], syncAuctionMotion);
onMounted(() => {
  observer = new IntersectionObserver(([entry]) => { auctionVisible.value = entry.isIntersecting; });
  if (auctionPlate.value) observer.observe(auctionPlate.value);
  reduceMotion.addEventListener("change", syncAuctionMotion);
  document.addEventListener("visibilitychange", syncAuctionMotion);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  reduceMotion.removeEventListener("change", syncAuctionMotion);
  document.removeEventListener("visibilitychange", syncAuctionMotion);
  if (rafId !== null) window.cancelAnimationFrame(rafId);
});

// Piece-wise linear Dutch auction: Opening (0..0.2) -> Linear fall (0.2..0.75) -> Floor hold (0.75..1)
const auctionState = computed(() => {
  const p = auctionProgress.value;
  let pctPrice = 100;
  let phase = "Opening";
  if (p <= 0.2) {
    pctPrice = 100;
    phase = "Opening";
  } else if (p <= 0.75) {
    const f = (p - 0.2) / 0.55;
    pctPrice = 100 - f * 35;
    phase = "Falling";
  } else {
    pctPrice = 65;
    phase = "Floor";
  }
  const x = 16 + p * 248;
  const y = 16 + ((100 - pctPrice) / 45) * 56;
  return { x, y, pctPrice, phase };
});
</script>

<template>
  <section id="mechanics" class="mx-auto max-w-[1280px] border-t border-[color:var(--sf-line)] px-5 pb-16 sm:px-8 lg:pb-20">
    <div class="mechanics-intro">
      <div class="mechanics-copy">
        <h2 class="sf-serif">
          How SigmaFi works
        </h2>
        <p>A zero-coupon bond promises one payment at maturity. Its price today and the time until repayment determine its implied yield.</p>
      </div>
      <hero-sigma-backdrop class="mechanics-sigma" />
    </div>

    <div class="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <!-- FIG. 02: Zero-Coupon Bond Convergence & 100 Shares -->
      <article class="sf-plate flex flex-col justify-between rounded-2xl p-6 sm:p-7 lg:col-span-7">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="max-w-[44ch]">
            <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-cobalt-600">
              Zero-coupon bonds
            </span>
            <h3 class="sf-serif mt-1.5 text-[23px] font-semibold text-[color:var(--sf-ink)]">
              Discount to par, divisible into shares
            </h3>
            <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
              Fixed repayment <span class="sf-math text-[color:var(--sf-ink)]">F</span> at maturity.
              Circulating bond units trade whole or split into 100 fungible shares.
            </p>
          </div>

          <div
            class="inline-flex rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5 text-[11.5px]"
          >
            <button
              type="button"
              class="sf-mono rounded-md px-2.5 py-1 font-medium transition-all"
              :class="
                bondView === 'unit'
                  ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
                  : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="bondView = 'unit'"
            >
              1 Unit
            </button>
            <button
              type="button"
              class="sf-mono rounded-md px-2.5 py-1 font-medium transition-all"
              :class="
                bondView === 'shares'
                  ? 'bg-[color:var(--sf-card)] text-cobalt-700 shadow-sm ring-1 ring-cobalt-600/20'
                  : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="bondView = 'shares'"
            >
              100 Shares
            </button>
          </div>
        </div>

        <div class="mt-6 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] p-4">
          <div class="flex items-center justify-between text-[10.5px] text-[color:var(--sf-muted)]">
            <span class="sf-mono">
              <span class="sf-math text-[12px] text-[color:var(--sf-ink)]">P(0)</span> = 92.4
            </span>
            <span class="sf-mono text-cobalt-600">
              {{ bondView === "unit" ? "1 circulating unit · 2 locked" : "100.000000 fungible shares" }}
            </span>
            <span class="sf-mono font-semibold text-[color:var(--sf-bid)]">
              <span class="sf-math text-[12px]">F</span> = 100.0
            </span>
          </div>

          <div class="mt-3.5 grid h-16 grid-cols-12 items-end gap-1.5">
            <div
              v-for="(hPct, idx) in [48, 52, 56, 61, 65, 70, 74, 79, 84, 89, 94, 100]"
              :key="idx"
              class="relative overflow-hidden rounded-t transition-all duration-300"
              :style="{ height: `${hPct}%` }"
              :class="
                idx === 11
                  ? 'bg-[#059669]'
                  : idx === 0
                    ? 'bg-cobalt-600'
                    : bondView === 'shares'
                      ? 'bg-cobalt-600/25 ring-1 ring-inset ring-cobalt-600/30'
                      : 'bg-[color:var(--sf-line)]'
              "
            >
              <div
                v-if="bondView === 'shares' && idx > 0 && idx < 11"
                class="h-full w-full bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_5px,rgba(255,255,255,0.7)_5px,rgba(255,255,255,0.7)_6px)]"
              />
            </div>
          </div>
        </div>
      </article>

      <!-- FIG. 03: Interactive Rolling Yield Curve Shapes -->
      <article class="sf-plate flex flex-col justify-between rounded-2xl p-6 sm:p-7 lg:col-span-5">
        <div>
          <div class="flex items-center justify-between gap-2">
            <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[color:var(--sf-bid)]">
              Lending
            </span>
            <span class="sf-mono text-[10px] text-[color:var(--sf-dim)]">≤ 20 pts</span>
          </div>
          <h3 class="sf-serif mt-1.5 text-[23px] font-semibold text-[color:var(--sf-ink)]">
            Rolling term curves
          </h3>
          <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
            Standing lend offers index APR by remaining blocks
            <span class="sf-math text-[color:var(--sf-ink)]">τ</span>.
          </p>
        </div>

        <div class="mt-5 space-y-3">
          <div class="flex flex-wrap gap-1.5" role="group" aria-label="Illustrative yield curve shapes">
            <button
              v-for="sh in SHAPES"
              :key="sh.key"
              type="button"
              class="sf-mono rounded-md border px-2 py-1 text-[11px] font-medium transition-all"
              :class="
                activeShape === sh.key
                  ? 'border-[#059669] bg-[#059669]/10 text-[color:var(--sf-bid)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              :aria-pressed="activeShape === sh.key" @click="activeShape = sh.key"
            >
              {{ sh.label }}
            </button>
          </div>

          <div class="rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] p-3">
            <svg viewBox="0 0 280 96" class="h-[88px] w-full" aria-hidden="true">
              <defs>
                <linearGradient id="sfShapeFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--sf-bid)" stop-opacity="0.16" />
                  <stop offset="100%" stop-color="var(--sf-bid)" stop-opacity="0" />
                </linearGradient>
              </defs>
              <line x1="12" x2="268" y1="88" y2="88" stroke="var(--sf-line-strong)" />
              <line x1="12" x2="268" y1="48" y2="48" stroke="var(--sf-line)" stroke-dasharray="2 4" />
              <path :d="curveArea" fill="url(#sfShapeFill)" class="transition-all duration-300" />
              <path
                :d="curvePath"
                fill="none"
                stroke="var(--sf-bid)"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="transition-all duration-300"
              />
              <g v-for="(node, idx) in curveNodes" :key="idx">
                <circle
                  :cx="node.x"
                  :cy="node.y"
                  r="4"
                  fill="var(--sf-card)"
                  stroke="var(--sf-bid)"
                  stroke-width="2"
                  class="transition-all duration-300"
                />
              </g>
            </svg>
          </div>
        </div>
      </article>

      <!-- FIG. 04: Animated Dutch Auction Decay -->
      <article
        ref="auctionPlate"
        class="sf-plate flex flex-col justify-between rounded-2xl p-6 sm:p-7 lg:col-span-5"
        @mouseenter="auctionPaused = true"
        @mouseleave="auctionPaused = false"
      >
        <div>
          <div class="flex items-center justify-between gap-2">
            <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[color:var(--sf-ask)]">
              Recovery
            </span>
            <span class="sf-mono rounded bg-[#d97706]/10 px-2 py-0.5 text-[10.5px] font-medium text-[color:var(--sf-ask)]">
              {{ auctionState.phase }} · {{ auctionState.pctPrice.toFixed(0) }}%
            </span>
          </div>
          <h3 class="sf-serif mt-1.5 text-[23px] font-semibold text-[color:var(--sf-ink)]">
            Oracle guards &amp; Dutch auctions
          </h3>
          <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
            Continuous ERG/USD collateral enforcement and linear falling-price liquidation auctions.
          </p>
        </div>

        <div class="mt-6 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] p-3">
          <svg viewBox="0 0 280 92" class="h-[86px] w-full" aria-hidden="true">
            <line x1="16" x2="264" y1="80" y2="80" stroke="var(--sf-line-strong)" />
            <path
              d="M 16 16 L 65.6 16 L 202 59.6 L 264 59.6 L 264 80 L 16 80 Z"
              fill="rgba(217, 119, 6, 0.09)"
            />
            <path
              d="M 16 16 L 65.6 16 L 202 59.6 L 264 59.6"
              fill="none"
              stroke="var(--sf-ask)"
              stroke-width="2.2"
            />
            <line
              :x1="auctionState.x"
              :x2="auctionState.x"
              y1="10"
              y2="80"
              stroke="var(--sf-line-strong)"
              stroke-dasharray="2 3"
            />
            <circle
              :cx="auctionState.x"
              :cy="auctionState.y"
              r="8"
              fill="var(--sf-ask)"
              fill-opacity="0.16"
            />
            <circle
              :cx="auctionState.x"
              :cy="auctionState.y"
              r="4.2"
              fill="var(--sf-ask)"
              stroke="var(--sf-card)"
              stroke-width="1.8"
            />
          </svg>
        </div>
      </article>

      <!-- FIG. 05: Custody Wraps Schematic -->
      <article class="sf-plate flex flex-col justify-between rounded-2xl p-6 sm:p-7 lg:col-span-7">
        <div class="max-w-[48ch]">
          <span class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-cobalt-600">
            Collateral
          </span>
          <h3 class="sf-serif mt-1.5 text-[23px] font-semibold text-[color:var(--sf-ink)]">
            NFT custody wraps
          </h3>
          <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
            Wrap LP position NFTs into 1:1 custody receipts safe to pledge as bond collateral,
            unwrapping back cleanly by burning all three receipt units.
          </p>
        </div>

        <div class="mt-6 rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-4 py-5 sm:px-6">
          <svg viewBox="0 0 500 68" class="h-[64px] w-full" aria-hidden="true">
            <!-- Flowing connection lines -->
            <line
              x1="112"
              y1="34"
              x2="190"
              y2="34"
              stroke="var(--sf-cobalt)"
              stroke-width="1.8"
              class="sf-signal-flow"
            />
            <line
              x1="310"
              y1="34"
              x2="388"
              y2="34"
              stroke="var(--sf-bid)"
              stroke-width="1.8"
              class="sf-signal-flow"
            />
            <!-- Node 1: LD-NFT -->
            <rect
              x="4"
              y="14"
              width="108"
              height="40"
              rx="8"
              fill="var(--sf-card)"
              stroke="var(--sf-line-strong)"
            />
            <text x="58" y="38" text-anchor="middle" fill="var(--sf-ink)" font-size="11.5" font-weight="600" class="sf-mono">
              LP NFT
            </text>

            <!-- Node 2: WrapVault -->
            <rect
              x="190"
              y="10"
              width="120"
              height="48"
              rx="9"
              fill="var(--sf-cobalt-soft)"
              stroke="var(--sf-cobalt)"
              stroke-width="1.4"
            />
            <text x="250" y="31" text-anchor="middle" fill="var(--sf-cobalt)" font-size="11.5" font-weight="600" class="sf-mono">
              WrapVault
            </text>
            <text x="250" y="47" text-anchor="middle" fill="var(--sf-cobalt)" font-size="9.5" class="sf-mono">
              custody box
            </text>

            <!-- Node 3: 1:1 Receipt -->
            <rect
              x="388"
              y="14"
              width="108"
              height="40"
              rx="8"
              fill="var(--sf-bid-soft)"
              stroke="var(--sf-bid)"
              stroke-width="1.4"
            />
            <text x="442" y="38" text-anchor="middle" fill="var(--sf-bid)" font-size="11.5" font-weight="600" class="sf-mono">
              1:1 Receipt
            </text>
          </svg>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.mechanics-intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, .86fr);
  align-items: center;
  column-gap: 2rem;
  padding-block: 1.25rem;
}
.mechanics-copy h2 { font-size: clamp(2.3rem, 4.6vw, 4rem); font-weight: 500; line-height: 1.02; letter-spacing: -.045em; }
.mechanics-copy p { max-width: 43ch; color: var(--sf-ink-2); margin-top: 1rem; line-height: 1.6; }
.mechanics-sigma { max-width: 29rem; justify-self: center; }
@media (max-width: 639px) {
  .mechanics-intro { grid-template-columns: minmax(0, 1fr) 37%; column-gap: 0; padding-block: 2rem; }
  .mechanics-copy { display: contents; }
  .mechanics-copy h2 { grid-area: 1 / 1; }
  .mechanics-copy p { grid-area: 2 / 1 / 3 / 3; margin-top: .65rem; }
  .mechanics-sigma { grid-area: 1 / 2; width: 128%; max-width: none; }
}
</style>
