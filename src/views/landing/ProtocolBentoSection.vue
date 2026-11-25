<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { vReveal } from "@/directives/vReveal";

/* ---- Spotlight Hover Handler ---- */
function onBentoPointerMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
  el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
}

/* ---- BENTO 01: Singular Market (Primary + Resale Convergence) ---- */
type FlowMode = "all" | "primary" | "resale";
const flowMode = ref<FlowMode>("all");

const FLOW_MODES: { key: FlowMode; label: string }[] = [
  { key: "all", label: "Unified Book" },
  { key: "primary", label: "Primary Loans" },
  { key: "resale", label: "Resales & Shares" }
];

/* ---- BENTO 02: Yield Curve Orders & Window Curves ---- */
type CurveShape = "normal" | "flat" | "inverted" | "humped" | "window";
const SHAPES: { key: CurveShape; label: string; desc: string; fn: (t: number) => number }[] = [
  {
    key: "normal",
    label: "Normal",
    desc: "Higher APR required for longer maturities",
    fn: (t) => 0.72 + 0.5 * Math.pow(t, 0.72)
  },
  {
    key: "flat",
    label: "Flat",
    desc: "Uniform rate floor across every tenor",
    fn: () => 1.0
  },
  {
    key: "inverted",
    label: "Inverted",
    desc: "Premium demand for short-duration credit",
    fn: (t) => 1.26 - 0.48 * Math.pow(t, 0.75)
  },
  {
    key: "humped",
    label: "Humped",
    desc: "Peak yield preference around mid-term tenors",
    fn: (t) => 0.8 + 0.42 * Math.sin(Math.PI * Math.min(1, t * 1.15))
  },
  {
    key: "window",
    label: "Window",
    desc: "Borrower curve — lender picks maturity in window",
    fn: (t) => 0.84 + 0.36 * Math.pow(t, 0.85)
  }
];
const activeShape = ref<CurveShape>("normal");

const activeShapeMeta = computed(
  () => SHAPES.find((s) => s.key === activeShape.value) || SHAPES[0]
);

const curveNodes = computed(() => {
  const shape = activeShapeMeta.value;
  const baseRate = 9.8;
  return Array.from({ length: 7 }, (_, i) => {
    const t = i / 6;
    const rate = baseRate * shape.fn(t);
    const x = 22 + t * 266;
    const y = 92 - ((rate - 5) / 10) * 68;
    return { x, y, rate, t };
  });
});

const curvePath = computed(() =>
  curveNodes.value
    .map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ")
);

const curveArea = computed(() => {
  const pts = curveNodes.value;
  return `${curvePath.value} L${pts[pts.length - 1].x.toFixed(1)},104 L${pts[0].x.toFixed(1)},104 Z`;
});

/* ---- BENTO 03: Multi-Asset Collateral Baskets ---- */
interface BasketAsset {
  id: string;
  label: string;
  sub: string;
  coverBoost: number;
  color: string;
  stable?: boolean;
}

const BASKET_ASSETS: BasketAsset[] = [
  { id: "erg", label: "ERG", sub: "Native collateral", coverBoost: 118, color: "var(--sf-cobalt)" },
  {
    id: "sigusd",
    label: "SigUSD",
    sub: "Stable buffer",
    coverBoost: 36,
    color: "var(--sf-bid)",
    stable: true
  },
  {
    id: "lp",
    label: "Wrapped LP",
    sub: "Custody receipt",
    coverBoost: 28,
    color: "#7c6bff"
  },
  {
    id: "tokens",
    label: "Ergo Tokens",
    sub: "Extra margin",
    coverBoost: 18,
    color: "var(--sf-ask)"
  }
];

const selectedBasket = ref<string[]>(["erg", "sigusd", "lp"]);

function toggleBasketAsset(id: string) {
  const idx = selectedBasket.value.indexOf(id);
  if (idx >= 0) {
    if (selectedBasket.value.length <= 1) return;
    selectedBasket.value = selectedBasket.value.filter((x) => x !== id);
  } else {
    selectedBasket.value = [...selectedBasket.value, id];
  }
}

const activeBasketItems = computed(() =>
  BASKET_ASSETS.filter((a) => selectedBasket.value.includes(a.id))
);

const totalCoverPct = computed(() =>
  activeBasketItems.value.reduce((acc, a) => acc + a.coverBoost, 0)
);

const safetyMarginPct = computed(() => Math.max(0, totalCoverPct.value - 125));

const basketSegments = computed(() => {
  const total = Math.max(1, totalCoverPct.value);
  return activeBasketItems.value.map((a) => ({
    ...a,
    sharePct: (a.coverBoost / total) * 100
  }));
});

/* ---- BENTO 04: Dutch Auctions (Liquidation + Lot Sales) ---- */
const auctionMode = ref<"liquidation" | "lot">("liquidation");
const auctionProgress = ref(0.38);
const auctionPaused = ref(false);
const auctionScrub = ref<number | null>(null);
const auctionPlate = ref<HTMLElement | null>(null);
const auctionVisible = ref(false);

const reduceMotion =
  typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
let observer: IntersectionObserver | null = null;
let rafId: number | null = null;
let lastTs = 0;

function tickAuction(ts: number) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  auctionProgress.value = (auctionProgress.value + dt * 0.13) % 1;
  rafId = window.requestAnimationFrame(tickAuction);
}

function syncAuctionMotion() {
  if (rafId !== null) window.cancelAnimationFrame(rafId);
  rafId = null;
  lastTs = 0;
  if (
    auctionVisible.value &&
    !auctionPaused.value &&
    auctionScrub.value === null &&
    !reduceMotion?.matches &&
    !document.hidden
  ) {
    rafId = window.requestAnimationFrame(tickAuction);
  }
}

watch([auctionVisible, auctionPaused, auctionScrub], syncAuctionMotion);

onMounted(() => {
  if ("IntersectionObserver" in window && auctionPlate.value) {
    observer = new IntersectionObserver(([entry]) => {
      auctionVisible.value = entry.isIntersecting;
    });
    observer.observe(auctionPlate.value);
  } else {
    auctionVisible.value = true;
  }
  reduceMotion?.addEventListener("change", syncAuctionMotion);
  document.addEventListener("visibilitychange", syncAuctionMotion);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  reduceMotion?.removeEventListener("change", syncAuctionMotion);
  document.removeEventListener("visibilitychange", syncAuctionMotion);
  if (rafId !== null) window.cancelAnimationFrame(rafId);
});

function handleAuctionMove(e: MouseEvent) {
  const svg = e.currentTarget as SVGSVGElement;
  const r = svg.getBoundingClientRect();
  const norm = Math.max(0, Math.min(1, (e.clientX - r.left - r.width * 0.06) / (r.width * 0.88)));
  auctionScrub.value = norm;
}

const auctionState = computed(() => {
  const p = auctionScrub.value ?? auctionProgress.value;
  const floorVal = auctionMode.value === "liquidation" ? 62 : 70;
  let pctPrice = 100;
  let phase = "Opening";
  if (p <= 0.18) {
    pctPrice = 100;
    phase = "Opening";
  } else if (p <= 0.76) {
    const f = (p - 0.18) / 0.58;
    pctPrice = 100 - f * (100 - floorVal);
    phase = "Decay";
  } else {
    pctPrice = floorVal;
    phase = "Floor";
  }
  const x = 20 + p * 270;
  const y = 18 + ((100 - pctPrice) / 48) * 64;
  const floorY = 18 + ((100 - floorVal) / 48) * 64;
  return { x, y, pctPrice, phase, floorVal, floorY };
});

/* ---- BENTO 05: Fractional Shares & NFT Custody Wraps ---- */
const bondView = ref<"unit" | "shares">("shares");
const wrapDirection = ref<"wrap" | "unwrap">("wrap");
const SHARE_CELLS = Array.from({ length: 100 }, (_, i) => i);
</script>

<template>
  <section
    id="architecture"
    class="mx-auto max-w-[1280px] border-t border-[color:var(--sf-line)] px-5 py-20 sm:px-8 lg:py-28"
  >
    <!-- Section Heading -->
    <div v-reveal class="mb-12 flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
      <div class="max-w-[44rem]">
        <div class="mb-3 inline-flex items-center gap-2">
          <span class="h-1.5 w-1.5 bg-[color:var(--sf-cobalt)]" />
          <span
            class="sf-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--sf-cobalt)]"
          >
            Protocol Architecture
          </span>
        </div>
        <h2
          class="sf-serif text-[38px] font-medium leading-[1.01] tracking-[-0.04em] text-[color:var(--sf-ink)] sm:text-[52px]"
        >
          Every primitive built for <em class="text-[color:var(--sf-cobalt)]">liquid yield.</em>
        </h2>
      </div>
      <p class="max-w-[38ch] text-[15px] leading-relaxed text-[color:var(--sf-ink-2)]">
        SigmaFi V2 unifies primary credit, secondary resales, multi-asset collateral baskets, Dutch
        auctions, fractional shares, and custody wraps into one permissionless Ergo standard.
      </p>
    </div>

    <!-- Asymmetric Bento Grid -->
    <div class="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <!-- ========================================================
           BENTO 01: Resales Unified into a Singular Market (7 cols)
           ======================================================== -->
      <article
        v-reveal="40"
        class="sf-bento flex flex-col justify-between rounded-[26px] p-6 sm:p-7 lg:col-span-7"
        @mousemove="onBentoPointerMove"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="max-w-[42ch]">
            <span
              class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[color:var(--sf-cobalt)]"
            >
              01 · Singular Market
            </span>
            <h3 class="sf-serif mt-2 text-[26px] font-medium leading-tight text-[color:var(--sf-ink)]">
              Primary loans &amp; secondary resales share one book
            </h3>
            <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
              New borrower orders, whole bond resales, and fractional share asks all route into the
              exact same standing lender curves — so yield stays liquid from block one.
            </p>
          </div>

          <div
            class="inline-flex rounded-[8px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
            role="group"
            aria-label="Inspect order flow"
          >
            <button
              v-for="m in FLOW_MODES"
              :key="m.key"
              type="button"
              :aria-pressed="flowMode === m.key"
              class="sf-mono rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-all"
              :class="
                flowMode === m.key
                  ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-[color:var(--sf-line-strong)]'
                  : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="flowMode = m.key"
            >
              {{ m.label }}
            </button>
          </div>
        </div>

        <!-- Sharp Inset Architectural Flow Stage -->
        <div class="sf-stage-sharp mt-6 p-4 sm:p-5">
          <svg
            viewBox="0 0 560 156"
            class="h-[144px] w-full select-none sm:h-[160px]"
            role="img"
            aria-label="Diagram showing borrower orders, whole bond resales, and share asks converging into one singular yield market and clearing against standing lend offers"
          >
            <!-- Subtle horizontal grid guides -->
            <line x1="14" y1="30" x2="546" y2="30" stroke="var(--sf-line)" stroke-dasharray="2 5" />
            <line x1="14" y1="78" x2="546" y2="78" stroke="var(--sf-line)" stroke-dasharray="2 5" />
            <line x1="14" y1="126" x2="546" y2="126" stroke="var(--sf-line)" stroke-dasharray="2 5" />

            <!-- Path 1: Primary Borrower Orders -> Singular Book -->
            <path
              d="M 136 30 C 194 30, 198 70, 248 73"
              fill="none"
              stroke="var(--sf-ask)"
              stroke-width="2"
              class="sf-signal-flow transition-opacity duration-300"
              :opacity="flowMode === 'resale' ? 0.16 : 0.92"
            />
            <!-- Path 2: Secondary Whole Bond Resales -> Singular Book -->
            <path
              d="M 136 78 L 248 78"
              fill="none"
              stroke="var(--sf-cobalt)"
              stroke-width="2"
              class="sf-signal-flow transition-opacity duration-300"
              :opacity="flowMode === 'primary' ? 0.16 : 0.95"
            />
            <!-- Path 3: Fractional Share Asks -> Singular Book -->
            <path
              d="M 136 126 C 194 126, 198 86, 248 83"
              fill="none"
              stroke="var(--sf-bid)"
              stroke-width="2"
              class="sf-signal-flow transition-opacity duration-300"
              :opacity="flowMode === 'primary' ? 0.16 : 0.92"
            />

            <!-- Output Flow: Singular Book -> Standing Lender Curve -->
            <path
              d="M 358 78 L 424 78"
              fill="none"
              stroke="var(--sf-bid)"
              stroke-width="2.4"
              class="sf-signal-flow"
            />

            <!-- Left Node 1: Borrower Orders -->
            <g :opacity="flowMode === 'resale' ? 0.35 : 1" class="transition-opacity duration-300">
              <rect
                x="6"
                y="12"
                width="130"
                height="36"
                rx="4"
                fill="var(--sf-card)"
                stroke="var(--sf-ask)"
                stroke-width="1.2"
              />
              <circle cx="20" cy="30" r="3.5" fill="var(--sf-ask)" />
              <text x="31" y="34" fill="var(--sf-ink)" font-size="11" font-weight="600" class="sf-mono">
                Borrower Order
              </text>
            </g>

            <!-- Left Node 2: Bond Resale -->
            <g :opacity="flowMode === 'primary' ? 0.35 : 1" class="transition-opacity duration-300">
              <rect
                x="6"
                y="60"
                width="130"
                height="36"
                rx="4"
                fill="var(--sf-card)"
                stroke="var(--sf-cobalt)"
                stroke-width="1.2"
              />
              <circle cx="20" cy="78" r="3.5" fill="var(--sf-cobalt)" />
              <text x="31" y="82" fill="var(--sf-ink)" font-size="11" font-weight="600" class="sf-mono">
                Bond Resale Ask
              </text>
            </g>

            <!-- Left Node 3: Fractional Share Ask -->
            <g :opacity="flowMode === 'primary' ? 0.35 : 1" class="transition-opacity duration-300">
              <rect
                x="6"
                y="108"
                width="130"
                height="36"
                rx="4"
                fill="var(--sf-card)"
                stroke="var(--sf-bid)"
                stroke-width="1.2"
              />
              <circle cx="20" cy="126" r="3.5" fill="var(--sf-bid)" />
              <text x="31" y="130" fill="var(--sf-ink)" font-size="11" font-weight="600" class="sf-mono">
                Share Slice Ask
              </text>
            </g>

            <!-- Center Node: Singular Yield Book -->
            <rect
              x="248"
              y="38"
              width="110"
              height="80"
              rx="10"
              fill="var(--sf-cobalt-soft)"
              stroke="var(--sf-cobalt)"
              stroke-width="1.6"
            />
            <text
              x="303"
              y="69"
              text-anchor="middle"
              fill="var(--sf-cobalt)"
              font-size="11"
              font-weight="700"
              class="sf-mono"
            >
              SINGULAR
            </text>
            <text
              x="303"
              y="84"
              text-anchor="middle"
              fill="var(--sf-ink)"
              font-size="11"
              font-weight="600"
              class="sf-mono"
            >
              YIELD BOOK
            </text>
            <text
              x="303"
              y="102"
              text-anchor="middle"
              fill="var(--sf-muted)"
              font-size="9.5"
              class="sf-mono"
            >
              APR × τ plane
            </text>

            <!-- Right Node: Standing Lend Offer Curve -->
            <rect
              x="424"
              y="34"
              width="130"
              height="88"
              rx="10"
              fill="var(--sf-bid-soft)"
              stroke="var(--sf-bid)"
              stroke-width="1.5"
            />
            <text
              x="489"
              y="56"
              text-anchor="middle"
              fill="var(--sf-bid)"
              font-size="11"
              font-weight="700"
              class="sf-mono"
            >
              Lend Offer
            </text>
            <path
              d="M 442 98 Q 466 86 489 78 T 536 66"
              fill="none"
              stroke="var(--sf-bid)"
              stroke-width="2"
              stroke-linecap="round"
            />
            <circle cx="442" cy="98" r="2.5" fill="var(--sf-bid)" />
            <circle cx="489" cy="78" r="2.5" fill="var(--sf-bid)" />
            <circle cx="536" cy="66" r="2.5" fill="var(--sf-bid)" />
            <text
              x="489"
              y="112"
              text-anchor="middle"
              fill="var(--sf-muted)"
              font-size="9.5"
              class="sf-mono"
            >
              Matches both sides
            </text>
          </svg>
        </div>
      </article>

      <!-- ========================================================
           BENTO 02: Yield Curve Orders & Window Curves (5 cols)
           ======================================================== -->
      <article
        v-reveal="100"
        class="sf-bento flex flex-col justify-between rounded-[26px] rounded-tr-[6px] p-6 sm:p-7 lg:col-span-5"
        @mousemove="onBentoPointerMove"
      >
        <div>
          <div class="flex items-center justify-between gap-2">
            <span
              class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[color:var(--sf-bid)]"
            >
              02 · Yield Curve Orders
            </span>
            <span
              class="sf-mono rounded-[3px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] px-2 py-0.5 text-[10px] text-[color:var(--sf-muted)]"
            >
              ≤ 20 (APR, τ) pts
            </span>
          </div>
          <h3 class="sf-serif mt-2 text-[26px] font-medium leading-tight text-[color:var(--sf-ink)]">
            Rolling term curves &amp; window orders
          </h3>
          <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
            Lenders index minimum APR by remaining blocks
            <span class="sf-math text-[color:var(--sf-ink)]">τ</span>. Borrowers post window curves
            letting lenders pick the exact maturity.
          </p>
        </div>

        <div class="mt-5 space-y-3">
          <div class="flex flex-wrap gap-1.5" role="group" aria-label="Yield curve presets">
            <button
              v-for="sh in SHAPES"
              :key="sh.key"
              type="button"
              :aria-pressed="activeShape === sh.key"
              class="sf-mono rounded-[6px] border px-2.5 py-1 text-[11px] font-medium transition-all"
              :class="
                activeShape === sh.key
                  ? 'border-[color:var(--sf-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] text-[color:var(--sf-muted)] hover:border-[color:var(--sf-line-strong)] hover:text-[color:var(--sf-ink)]'
              "
              @click="activeShape = sh.key"
            >
              {{ sh.label }}
            </button>
          </div>

          <div class="sf-stage-sharp p-3.5">
            <svg viewBox="0 0 310 114" class="h-[108px] w-full" aria-hidden="true">
              <defs>
                <linearGradient id="sfBentoCurveFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--sf-bid)" stop-opacity="0.22" />
                  <stop offset="100%" stop-color="var(--sf-bid)" stop-opacity="0" />
                </linearGradient>
              </defs>

              <!-- Window order highlighted range -->
              <rect
                v-if="activeShape === 'window'"
                x="110"
                y="12"
                width="134"
                height="92"
                fill="var(--sf-cobalt-soft)"
                stroke="var(--sf-line-cobalt)"
                stroke-dasharray="3 3"
              />
              <text
                v-if="activeShape === 'window'"
                x="177"
                y="24"
                text-anchor="middle"
                fill="var(--sf-cobalt)"
                font-size="9"
                font-weight="600"
                class="sf-mono"
              >
                LENDER MATURITY WINDOW
              </text>

              <line x1="14" x2="296" y1="104" y2="104" stroke="var(--sf-line-strong)" />
              <line
                x1="14"
                x2="296"
                y1="58"
                y2="58"
                stroke="var(--sf-line)"
                stroke-dasharray="2 4"
              />
              <path
                :d="curveArea"
                fill="url(#sfBentoCurveFill)"
                class="transition-all duration-300"
              />
              <path
                :d="curvePath"
                fill="none"
                :stroke="activeShape === 'window' ? 'var(--sf-cobalt)' : 'var(--sf-bid)'"
                stroke-width="2.4"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="transition-all duration-300"
              />
              <g v-for="(node, idx) in curveNodes" :key="idx">
                <circle
                  :cx="node.x"
                  :cy="node.y"
                  r="4.2"
                  fill="var(--sf-card)"
                  :stroke="activeShape === 'window' ? 'var(--sf-cobalt)' : 'var(--sf-bid)'"
                  stroke-width="2"
                  class="transition-all duration-300"
                />
              </g>
            </svg>
            <div class="sf-mono mt-1.5 flex items-center justify-between text-[10.5px] text-[color:var(--sf-muted)]">
              <span>{{ activeShapeMeta.desc }}</span>
              <span class="text-[color:var(--sf-dim)]">7d → 1y</span>
            </div>
          </div>
        </div>
      </article>

      <!-- ========================================================
           BENTO 03: Multi-Asset Collateral Baskets (6 cols)
           ======================================================== -->
      <article
        v-reveal="60"
        class="sf-bento flex flex-col justify-between rounded-[26px] rounded-bl-[6px] p-6 sm:p-7 lg:col-span-6"
        @mousemove="onBentoPointerMove"
      >
        <div>
          <div class="flex items-center justify-between gap-2">
            <span
              class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[color:var(--sf-cobalt)]"
            >
              03 · Collateral Baskets
            </span>
            <span
              class="sf-mono rounded-[3px] bg-[color:var(--sf-bid-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[color:var(--sf-bid)]"
            >
              {{ totalCoverPct }}% Cover
            </span>
          </div>
          <h3 class="sf-serif mt-2 text-[26px] font-medium leading-tight text-[color:var(--sf-ink)]">
            Multi-asset baskets boost lender safety
          </h3>
          <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
            A single bond vault can hold ERG, SigUSD, Ergo tokens, and wrapped LP receipts together —
            enforced continuously by on-chain oracle ratios and fill/sale guards.
          </p>
        </div>

        <!-- Interactive Basket Configurator -->
        <div class="mt-5 space-y-3.5">
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button
              v-for="asset in BASKET_ASSETS"
              :key="asset.id"
              type="button"
              :aria-pressed="selectedBasket.includes(asset.id)"
              class="group flex flex-col items-start rounded-[10px] border p-2.5 text-left transition-all"
              :class="
                selectedBasket.includes(asset.id)
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-well)] shadow-sm'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] opacity-60 hover:opacity-95'
              "
              @click="toggleBasketAsset(asset.id)"
            >
              <div class="flex w-full items-center justify-between gap-1">
                <span
                  class="h-2.5 w-2.5 rounded-full transition-transform"
                  :style="{ background: asset.color }"
                />
                <span class="sf-mono text-[10px] text-[color:var(--sf-dim)]">
                  +{{ asset.coverBoost }}%
                </span>
              </div>
              <span class="sf-mono mt-1.5 text-[12px] font-semibold text-[color:var(--sf-ink)]">
                {{ asset.label }}
              </span>
              <span class="text-[10.5px] text-[color:var(--sf-muted)]">{{ asset.sub }}</span>
            </button>
          </div>

          <div class="sf-stage-sharp p-4">
            <div class="mb-2 flex items-center justify-between text-[11px]">
              <span class="sf-mono uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
                Vault Basket Composition
              </span>
              <span class="sf-mono font-medium text-[color:var(--sf-ink-2)]">
                +{{ safetyMarginPct }}% above 125% liq. floor
              </span>
            </div>

            <!-- Animated Stacked Composition Bar -->
            <div
              class="relative flex h-5 w-full overflow-hidden rounded-[3px] bg-[color:var(--sf-well)]"
            >
              <div
                v-for="seg in basketSegments"
                :key="seg.id"
                class="h-full transition-all duration-300"
                :style="{
                  width: `${seg.sharePct}%`,
                  background: seg.color
                }"
              />
              <!-- 125% Liquidation Threshold Marker -->
              <div
                class="pointer-events-none absolute inset-y-0 border-r-2 border-dashed border-[color:var(--sf-ink)] opacity-75"
                :style="{ left: `${Math.min(92, (125 / Math.max(150, totalCoverPct)) * 100)}%` }"
              />
            </div>

            <div class="sf-mono mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[10.5px]">
              <span class="text-[color:var(--sf-muted)]">
                Toggle assets to compose vault backing
              </span>
              <span class="font-semibold text-[color:var(--sf-bid)]">
                {{
                  totalCoverPct >= 165
                    ? "High resilience · Oracle guarded"
                    : totalCoverPct >= 135
                      ? "Protected · Oracle guarded"
                      : "Near floor · Recollateralize ready"
                }}
              </span>
            </div>
          </div>
        </div>
      </article>

      <!-- ========================================================
           BENTO 04: Dutch Auctions for Liquidations & Sales (6 cols)
           ======================================================== -->
      <article
        ref="auctionPlate"
        v-reveal="120"
        class="sf-bento flex flex-col justify-between rounded-[26px] p-6 sm:p-7 lg:col-span-6"
        @mousemove="onBentoPointerMove"
        @mouseenter="auctionPaused = true"
        @mouseleave="
          auctionPaused = false;
          auctionScrub = null;
        "
      >
        <div>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span
              class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[color:var(--sf-ask)]"
            >
              04 · Dutch Auctions
            </span>
            <div class="flex items-center gap-2">
              <span
                class="sf-mono rounded-[3px] bg-[color:var(--sf-ask-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[color:var(--sf-ask)]"
              >
                {{ auctionState.phase }} · {{ auctionState.pctPrice.toFixed(0) }}%
              </span>
            </div>
          </div>
          <h3 class="sf-serif mt-2 text-[26px] font-medium leading-tight text-[color:var(--sf-ink)]">
            Falling-price liquidations &amp; lot sales
          </h3>
          <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
            Thin liquidated collateral and whole-basket lots clear through transparent linear Dutch
            auctions — converting collateral back into repayment assets with zero DEX dependency.
          </p>
        </div>

        <div class="mt-5 space-y-3">
          <div
            class="inline-flex rounded-[8px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
            role="group"
            aria-label="Dutch auction type"
          >
            <button
              type="button"
              :aria-pressed="auctionMode === 'liquidation'"
              class="sf-mono rounded-[6px] px-3 py-1 text-[11px] font-medium transition-all"
              :class="
                auctionMode === 'liquidation'
                  ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ask)] shadow-sm ring-1 ring-[color:var(--sf-line-strong)]'
                  : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="auctionMode = 'liquidation'"
            >
              Liquidation Vault
            </button>
            <button
              type="button"
              :aria-pressed="auctionMode === 'lot'"
              class="sf-mono rounded-[6px] px-3 py-1 text-[11px] font-medium transition-all"
              :class="
                auctionMode === 'lot'
                  ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-cobalt)] shadow-sm ring-1 ring-[color:var(--sf-line-strong)]'
                  : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
              "
              @click="auctionMode = 'lot'"
            >
              Basket Lot Sale
            </button>
          </div>

          <div class="sf-stage-sharp p-3.5">
            <svg
              viewBox="0 0 310 106"
              class="h-[106px] w-full cursor-ew-resize select-none"
              role="img"
              aria-label="Interactive Dutch auction price schedule showing opening hold, linear price decay, and floor hold"
              @mousemove="handleAuctionMove"
              @mouseleave="auctionScrub = null"
            >
              <defs>
                <linearGradient id="sfDutchArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--sf-ask)" stop-opacity="0.22" />
                  <stop offset="100%" stop-color="var(--sf-ask)" stop-opacity="0.01" />
                </linearGradient>
              </defs>

              <!-- Baseline & Phase Regions -->
              <line x1="20" x2="290" y1="90" y2="90" stroke="var(--sf-line-strong)" />
              <line
                x1="68.6"
                x2="68.6"
                y1="14"
                y2="90"
                stroke="var(--sf-line)"
                stroke-dasharray="2 4"
              />
              <line
                x1="225.2"
                x2="225.2"
                y1="14"
                y2="90"
                stroke="var(--sf-line)"
                stroke-dasharray="2 4"
              />

              <path
                :d="`M 20 18 L 68.6 18 L 225.2 ${auctionState.floorY.toFixed(1)} L 290 ${auctionState.floorY.toFixed(1)} L 290 90 L 20 90 Z`"
                fill="url(#sfDutchArea)"
                class="transition-all duration-300"
              />
              <path
                :d="`M 20 18 L 68.6 18 L 225.2 ${auctionState.floorY.toFixed(1)} L 290 ${auctionState.floorY.toFixed(1)}`"
                fill="none"
                stroke="var(--sf-ask)"
                stroke-width="2.4"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="transition-all duration-300"
              />

              <!-- Active Sweep Hairline & Bead -->
              <line
                :x1="auctionState.x"
                :x2="auctionState.x"
                y1="12"
                y2="90"
                stroke="var(--sf-line-strong)"
                stroke-dasharray="3 3"
              />
              <circle
                :cx="auctionState.x"
                :cy="auctionState.y"
                r="10"
                fill="var(--sf-ask)"
                fill-opacity="0.18"
              />
              <circle
                :cx="auctionState.x"
                :cy="auctionState.y"
                r="4.6"
                fill="var(--sf-ask)"
                stroke="var(--sf-card)"
                stroke-width="2"
              />

              <!-- Axis Phase Labels -->
              <text x="44" y="102" text-anchor="middle" fill="var(--sf-muted)" font-size="9" class="sf-mono">
                OPEN
              </text>
              <text x="147" y="102" text-anchor="middle" fill="var(--sf-muted)" font-size="9" class="sf-mono">
                LINEAR DECAY
              </text>
              <text x="258" y="102" text-anchor="middle" fill="var(--sf-muted)" font-size="9" class="sf-mono">
                FLOOR {{ auctionState.floorVal }}%
              </text>
            </svg>
          </div>
        </div>
      </article>

      <!-- ========================================================
           BENTO 05: Fractional Bond Shares & NFT Custody Wraps (12 cols)
           ======================================================== -->
      <article
        v-reveal="80"
        class="sf-bento rounded-[26px] p-6 sm:p-8 lg:col-span-12"
        @mousemove="onBentoPointerMove"
      >
        <div class="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-10">
          <!-- LEFT STAGE: Split Bond Tokens into 100 Fungible Shares -->
          <div class="flex flex-col justify-between">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="max-w-[38ch]">
                <span
                  class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[color:var(--sf-bid)]"
                >
                  05 · Fractional Shares
                </span>
                <h3 class="sf-serif mt-2 text-[25px] font-medium leading-tight text-[color:var(--sf-ink)]">
                  Split any bond into 100 fungible shares
                </h3>
                <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
                  Every bond mints 3 units (2 locked in state, 1 circulating). Fractionalize that
                  circulating unit into <strong class="font-semibold text-[color:var(--sf-ink)]">100.000000 shares</strong>
                  to sell partial slices or trade granular fixed yield.
                </p>
              </div>

              <div
                class="inline-flex rounded-[8px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
                role="group"
                aria-label="Bond unit vs shares view"
              >
                <button
                  type="button"
                  :aria-pressed="bondView === 'unit'"
                  class="sf-mono rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-all"
                  :class="
                    bondView === 'unit'
                      ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-[color:var(--sf-line-strong)]'
                      : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
                  "
                  @click="bondView = 'unit'"
                >
                  1 Unit
                </button>
                <button
                  type="button"
                  :aria-pressed="bondView === 'shares'"
                  class="sf-mono rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-all"
                  :class="
                    bondView === 'shares'
                      ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-bid)] shadow-sm ring-1 ring-[color:var(--sf-line-strong)]'
                      : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
                  "
                  @click="bondView = 'shares'"
                >
                  100 Shares
                </button>
              </div>
            </div>

            <div class="sf-stage-sharp mt-5 p-4">
              <div class="mb-3 flex items-center justify-between text-[10.5px]">
                <span class="sf-mono font-semibold text-[color:var(--sf-ink-2)]">
                  {{
                    bondView === "unit"
                      ? "Whole Bond · 1 Circulating + 2 Locked State"
                      : "FractionalVault · 100 Shares (1.00 = 1% Claim)"
                  }}
                </span>
                <span class="sf-mono text-[color:var(--sf-bid)]">
                  {{ bondView === "unit" ? "100% Claim" : "25% Listed · 75% Held" }}
                </span>
              </div>

              <!-- Unit View vs 10x10 Shares Matrix -->
              <div v-if="bondView === 'unit'" class="grid h-[104px] grid-cols-3 gap-2.5">
                <div
                  class="col-span-1 flex flex-col justify-between rounded-[4px] border border-dashed border-[color:var(--sf-line-strong)] bg-[color:var(--sf-well-soft)] p-3"
                >
                  <span class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
                    Locked State
                  </span>
                  <span class="sf-mono text-[16px] font-semibold text-[color:var(--sf-ink-2)]">
                    2 Units
                  </span>
                </div>
                <div
                  class="col-span-2 flex flex-col justify-between rounded-[4px] border border-[color:var(--sf-cobalt)] bg-[color:var(--sf-cobalt-soft)] p-3"
                >
                  <div class="flex items-center justify-between">
                    <span class="sf-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--sf-cobalt)]">
                      Circulating Bearer Bond
                    </span>
                    <span class="sf-live-dot" />
                  </div>
                  <div class="flex items-baseline justify-between">
                    <span class="sf-serif text-[22px] font-medium text-[color:var(--sf-ink)]">
                      1 Whole Bond Unit
                    </span>
                    <span class="sf-mono text-[11px] font-semibold text-[color:var(--sf-cobalt)]">
                      Splittable →
                    </span>
                  </div>
                </div>
              </div>

              <div v-else class="grid h-[104px] grid-cols-20 gap-[3px]">
                <span
                  v-for="idx in SHARE_CELLS"
                  :key="idx"
                  class="share-cell rounded-[2px] transition-all duration-300"
                  :class="
                    idx < 25
                      ? 'bg-[color:var(--sf-cobalt)] opacity-90'
                      : 'bg-[color:var(--sf-bid)] opacity-75'
                  "
                  :style="{ transitionDelay: `${(idx % 20) * 12}ms` }"
                />
              </div>
            </div>
          </div>

          <!-- RIGHT STAGE: NFT Custody Wraps -->
          <div
            class="flex flex-col justify-between border-t border-[color:var(--sf-line)] pt-7 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-10"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="max-w-[38ch]">
                <span
                  class="sf-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[color:var(--sf-cobalt)]"
                >
                  06 · NFT Custody Wraps
                </span>
                <h3 class="sf-serif mt-2 text-[25px] font-medium leading-tight text-[color:var(--sf-ink)]">
                  Wrap capability NFTs into safe collateral
                </h3>
                <p class="mt-2 text-[14px] leading-relaxed text-[color:var(--sf-muted)]">
                  Position NFTs like LithosDex LP owners carry spend authority. Lock them inside an
                  immutable <span class="sf-mono text-[color:var(--sf-ink)]">WrapVault</span> to
                  pledge clean 1:1 custody receipts — then burn to unwrap.
                </p>
              </div>

              <div
                class="inline-flex rounded-[8px] border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
                role="group"
                aria-label="Wrap direction"
              >
                <button
                  type="button"
                  :aria-pressed="wrapDirection === 'wrap'"
                  class="sf-mono rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-all"
                  :class="
                    wrapDirection === 'wrap'
                      ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-cobalt)] shadow-sm ring-1 ring-[color:var(--sf-line-strong)]'
                      : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
                  "
                  @click="wrapDirection = 'wrap'"
                >
                  Wrap
                </button>
                <button
                  type="button"
                  :aria-pressed="wrapDirection === 'unwrap'"
                  class="sf-mono rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-all"
                  :class="
                    wrapDirection === 'unwrap'
                      ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-bid)] shadow-sm ring-1 ring-[color:var(--sf-line-strong)]'
                      : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
                  "
                  @click="wrapDirection = 'unwrap'"
                >
                  Unwrap
                </button>
              </div>
            </div>

            <div class="sf-stage-sharp mt-5 p-4">
              <div class="mb-2 flex items-center justify-between text-[10.5px]">
                <span class="sf-mono font-semibold text-[color:var(--sf-ink-2)]">
                  {{
                    wrapDirection === "wrap"
                      ? "Isolate LP Authority → Pledge 1:1 Receipt"
                      : "Burn Receipt Units → Release Original NFT"
                  }}
                </span>
                <span class="sf-mono text-[color:var(--sf-cobalt)]">Non-custodial</span>
              </div>

              <svg viewBox="0 0 500 96" class="h-[100px] w-full" aria-hidden="true">
                <!-- Animated directional signal lines -->
                <line
                  :x1="wrapDirection === 'wrap' ? 124 : 186"
                  y1="48"
                  :x2="wrapDirection === 'wrap' ? 186 : 124"
                  y2="48"
                  stroke="var(--sf-cobalt)"
                  stroke-width="2"
                  class="sf-signal-flow"
                />
                <line
                  :x1="wrapDirection === 'wrap' ? 314 : 376"
                  y1="48"
                  :x2="wrapDirection === 'wrap' ? 376 : 314"
                  y2="48"
                  stroke="var(--sf-bid)"
                  stroke-width="2"
                  class="sf-signal-flow"
                />

                <!-- Node 1: Raw LP NFT -->
                <rect
                  x="6"
                  y="22"
                  width="118"
                  height="52"
                  rx="4"
                  fill="var(--sf-card)"
                  stroke="var(--sf-line-strong)"
                  stroke-width="1.3"
                />
                <text
                  x="65"
                  y="45"
                  text-anchor="middle"
                  fill="var(--sf-ink)"
                  font-size="11.5"
                  font-weight="600"
                  class="sf-mono"
                >
                  LP Owner NFT
                </text>
                <text
                  x="65"
                  y="62"
                  text-anchor="middle"
                  fill="var(--sf-muted)"
                  font-size="9.5"
                  class="sf-mono"
                >
                  capability token
                </text>

                <!-- Node 2: WrapVault -->
                <rect
                  x="186"
                  y="14"
                  width="128"
                  height="68"
                  rx="12"
                  fill="var(--sf-cobalt-soft)"
                  stroke="var(--sf-cobalt)"
                  stroke-width="1.6"
                />
                <text
                  x="250"
                  y="44"
                  text-anchor="middle"
                  fill="var(--sf-cobalt)"
                  font-size="12"
                  font-weight="700"
                  class="sf-mono"
                >
                  WrapVault
                </text>
                <text
                  x="250"
                  y="62"
                  text-anchor="middle"
                  fill="var(--sf-ink-2)"
                  font-size="9.5"
                  class="sf-mono"
                >
                  immutable lockbox
                </text>

                <!-- Node 3: 1:1 Receipt -->
                <rect
                  x="376"
                  y="22"
                  width="118"
                  height="52"
                  rx="4"
                  fill="var(--sf-bid-soft)"
                  stroke="var(--sf-bid)"
                  stroke-width="1.4"
                />
                <text
                  x="435"
                  y="45"
                  text-anchor="middle"
                  fill="var(--sf-bid)"
                  font-size="11.5"
                  font-weight="600"
                  class="sf-mono"
                >
                  1:1 Receipt
                </text>
                <text
                  x="435"
                  y="62"
                  text-anchor="middle"
                  fill="var(--sf-muted)"
                  font-size="9.5"
                  class="sf-mono"
                >
                  safe collateral
                </text>
              </svg>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.grid-cols-20 {
  grid-template-columns: repeat(20, minmax(0, 1fr));
}

.share-cell:hover {
  transform: scale(1.22);
  opacity: 1;
}
</style>
