<script setup lang="ts">
import {
  ActivityIcon,
  GridIcon,
  LayersIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  ShieldIcon
} from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ZcAskSummary,
  ZcCurves,
  ZcDurationUnit,
  ZcFillSummary,
  ZcMarket,
  ZcOfferSummary,
  ZcOrderbook
} from "@/types/zc";
import {
  bandFor,
  bestWindowAskAt,
  dateAtHeight,
  DAY_BLOCKS,
  formatAgo,
  formatApr,
  formatAxisDays,
  formatBp,
  formatCompact,
  formatDur,
  formatMarketAmount,
  kindLabel,
  lineAt,
  MIN_COVER,
  MIN_MATURITY_BLOCKS,
  offerYieldAt,
  resolvedAskQuote,
  visibleWindows,
  windowYieldAtPoint,
  YEAR_BLOCKS
} from "@/utils/zcMath";

export type RateBookLens = "curve" | "matrix" | "safety" | "history";

const props = defineProps<{
  market: ZcMarket;
  curves: ZcCurves | null;
  orderbook?: ZcOrderbook | null;
  asks: ZcAskSummary[];
  offers: ZcOfferSummary[];
  fills: ZcFillSummary[];
  fillsStatus: string;
  height: number;
  connected: boolean;
  oracleRefreshing: boolean;
  unit: ZcDurationUnit;
  targetBlocks: number;
  upto: boolean;
  coverage: number;
  showFills: boolean;
  showOffers: boolean;
  selectedId: string | null;
}>();

const emit = defineEmits<{
  (e: "update:targetBlocks", blocks: number): void;
  (e: "update:showFills", val: boolean): void;
  (e: "update:showOffers", val: boolean): void;
  (e: "select-ask", id: string): void;
  (e: "select-bid", id: string): void;
}>();

const lens = ref<RateBookLens>("curve");

const LENSES: { key: RateBookLens; label: string }[] = [
  { key: "curve", label: "Curve" },
  { key: "matrix", label: "Matrix" },
  { key: "safety", label: "Risk" },
  { key: "history", label: "Fills" }
];

/* ============================================================
   Responsive SVG Container Sizing (Dynamic Width & Height)
   ============================================================ */
const plotWrapRef = ref<HTMLElement | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);
const plotW = ref(680);
const plotH = ref(290);
const MARGIN = { l: 44, r: 14, t: 14, b: 26 };

let ro: ResizeObserver | null = null;
onMounted(() => {
  if (plotWrapRef.value && "ResizeObserver" in window) {
    ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (w >= 240) plotW.value = w;
      if (h >= 190) plotH.value = h;
    });
    ro.observe(plotWrapRef.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());

const innerW = computed(() => Math.max(120, plotW.value - MARGIN.l - MARGIN.r));
const innerH = computed(() => Math.max(110, plotH.value - MARGIN.t - MARGIN.b));

/* ============================================================
   Shared Curve & Domain Calculations
   ============================================================ */
const askById = computed(() => new Map(props.asks.map((a) => [a.id, a])));
const windows = computed(() => visibleWindows(props.curves));
const windowIds = computed(() => new Set(windows.value.map((w) => w.id)));
const bandBlocks = computed(() => bandFor(props.targetBlocks));

const maxDomainDays = computed(() =>
  Math.max(30, (props.curves?.domain?.[1] || YEAR_BLOCKS) / DAY_BLOCKS)
);

function niceTicks(a: number, b: number, count = 5): number[] {
  const span = b - a;
  if (!(span > 0)) return [a];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const e = raw / mag;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(8)));
  }
  return out;
}

function niceDomain(values: number[], pad = 0.14, floor0 = true): [number, number] {
  const v = values.filter((n) => Number.isFinite(n));
  if (!v.length) return [0, 16];
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (hi - lo < 1e-6) {
    lo = Math.max(0, lo - Math.max(2, lo * 0.2));
    hi = hi + Math.max(2, hi * 0.2);
  }
  const p = (hi - lo) * pad;
  lo -= p;
  hi += p;
  if (floor0 && lo < 0) lo = 0;
  return [lo, Math.max(4, hi)];
}

const bidPoints = computed(() =>
  (props.curves?.bidLine || []).map((p) => ({
    d: p.d,
    x: p.d / DAY_BLOCKS,
    y: p.y == null ? null : p.y / 100,
    id: p.id
  }))
);

// Solid ask envelope traces ONLY continuous variable-maturity window curves.
// Discrete fixed-maturity ask dots are never stitched into or connected to ask curves.
const askEnvelopePoints = computed(() => {
  const c = props.curves;
  if (!c || !windows.value.length) return [] as { x: number; y: number | null }[];
  const xs = new Set<number>();
  for (const w of windows.value) {
    xs.add(w.min);
    xs.add(w.max);
    for (const pt of w.points) if (pt.d >= w.min && pt.d <= w.max) xs.add(pt.d);
    for (let i = 1; i < 24; i++) xs.add(Math.round(w.min + ((w.max - w.min) * i) / 24));
    if (w.min > 1) xs.add(w.min - 1);
    xs.add(w.max + 1);
  }
  return [...xs]
    .sort((a, b) => a - b)
    .map((d) => {
      const bps = bestWindowAskAt(c, d, askById.value, props.height);
      return { x: d / DAY_BLOCKS, y: bps == null ? null : bps / 100 };
    });
});

const crossedSamples = computed(() => {
  const c = props.curves;
  if (!c || !windows.value.length) {
    return {
      upper: [] as { x: number; y: number | null }[],
      lower: [] as { x: number; y: number | null }[]
    };
  }
  const lower = bidPoints.value.map((p) => ({ x: p.x, y: p.y }));
  const upper = bidPoints.value.map((p) => {
    const bps = bestWindowAskAt(c, p.d, askById.value, props.height);
    return { x: p.x, y: bps == null ? null : bps / 100 };
  });
  return { upper, lower };
});

const windowCurvesData = computed(() =>
  windows.value.map((w) => {
    const pts = Array.from({ length: 25 }, (_, i) => {
      const d = w.min + ((w.max - w.min) * i) / 24;
      const bps = windowYieldAtPoint(w, d, askById.value, props.height);
      return { x: d / DAY_BLOCKS, y: bps != null ? bps / 100 : null };
    });
    return { id: w.id, min: w.min, max: w.max, pts };
  })
);

const offerFilaments = computed(() => {
  if (!props.showOffers) return [];
  const maxD = props.curves?.domain?.[1] || YEAR_BLOCKS;
  return props.offers.map((o) => {
    const pts = Array.from({ length: 40 }, (_, i) => {
      const d = maxD * (i / 39);
      const bps = offerYieldAt(o, d);
      return { x: d / DAY_BLOCKS, y: bps == null ? null : bps / 100 };
    });
    return { id: o.id, ok: o.ok, capital: o.capital, minYieldBps: o.minYieldBps, pts };
  });
});

const hoveredAskId = ref<string | null>(null);

const askDotsData = computed(() => {
  const c = props.curves;
  if (!c) return [];
  const nonWinDots = c.dots.filter((d) => !windowIds.value.has(d.id));
  const costs = nonWinDots.map((d) => askById.value.get(d.id)?.quote?.cost ?? 1);
  const maxCost = Math.max(1, ...costs);
  return nonWinDots.map((dot) => {
    const full = askById.value.get(dot.id);
    const cost = full?.quote?.cost ?? 1;
    const active = dot.ok || props.oracleRefreshing;
    const kind = full?.kind || dot.kind || "order";
    const buyback = (dot.borrowedByMe || !!full?.borrowedByMe) && kind !== "order" && !full?.owner;
    const baseR = 3 + Math.sqrt(cost / maxCost) * 1.5;
    return {
      id: dot.id,
      x: dot.d / DAY_BLOCKS,
      y: dot.y / 100,
      bps: dot.y,
      d: dot.d,
      cost,
      r: dot.id === props.selectedId ? 5.2 : buyback ? baseR + 0.6 : baseR,
      active,
      buyback,
      kind
    };
  });
});

const fillDotsData = computed(() => {
  if (!props.showFills) return [];
  return props.fills
    .filter((f) => f.yieldBps != null)
    .map((f) => ({
      id: f.id,
      x: f.d / DAY_BLOCKS,
      y: f.yieldBps / 100,
      opacity: Math.max(0.18, 0.68 - (Math.max(0, props.height - f.height) / 7200) * 0.48),
      kind: f.kind
    }));
});

const baseCurveYDomain = computed<[number, number]>(() => {
  const winYs = windowCurvesData.value.flatMap((w) => w.pts.map((p) => p.y));
  const vals = [
    ...bidPoints.value.map((p) => p.y),
    ...askDotsData.value.map((d) => d.y),
    ...winYs,
    ...(props.showFills ? fillDotsData.value.map((f) => f.y) : [])
  ].filter((v): v is number => v != null && Number.isFinite(v));
  return niceDomain(vals, 0.14, true);
});

const curveEmpty = computed(
  () =>
    !askDotsData.value.length &&
    !bidPoints.value.some((p) => p.y != null) &&
    !windowCurvesData.value.length
);

/* ============================================================
   Zoom & Pan State (Term Curve Lens)
   ============================================================ */
const ZOOM_STEP = 0.72;
const MAX_ZOOM = 8;
const zoomView = ref<{ x: [number, number]; y: [number, number] } | null>(null);
const hoveredOfferId = ref<string | null>(null);
const hoverX = ref<number | null>(null);
let panState: {
  startX: number;
  startY: number;
  dom: { x: [number, number]; y: [number, number] };
  moved: boolean;
} | null = null;

watch([() => props.market, maxDomainDays], () => {
  zoomView.value = null;
});

const baseDom = computed(() => ({
  x: [0, maxDomainDays.value] as [number, number],
  y: baseCurveYDomain.value
}));

const activeDom = computed(() => zoomView.value || baseDom.value);
const isZoomed = computed(() => zoomView.value !== null);
const zoomLevel = computed(() => {
  const bSpan = baseDom.value.x[1] - baseDom.value.x[0];
  const cSpan = activeDom.value.x[1] - activeDom.value.x[0];
  return cSpan > 0 ? bSpan / cSpan : 1;
});

function clampRange(d: [number, number], lim: [number, number]): [number, number] {
  const w = Math.min(d[1] - d[0], lim[1] - lim[0]);
  let a = d[0];
  let b = a + w;
  if (a < lim[0]) {
    a = lim[0];
    b = a + w;
  }
  if (b > lim[1]) {
    b = lim[1];
    a = b - w;
  }
  return [a, b];
}

function zoomBy(factor: number, cx?: number, cy?: number) {
  const base = baseDom.value;
  const cur = zoomView.value || base;
  const mx = cx ?? (cur.x[0] + cur.x[1]) / 2;
  const my = cy ?? (cur.y[0] + cur.y[1]) / 2;
  const baseSpanX = base.x[1] - base.x[0];
  const baseSpanY = base.y[1] - base.y[0];
  const nx = Math.min(baseSpanX, Math.max(baseSpanX / MAX_ZOOM, (cur.x[1] - cur.x[0]) * factor));
  const ny = Math.min(baseSpanY, Math.max(baseSpanY / MAX_ZOOM, (cur.y[1] - cur.y[0]) * factor));
  const fx = (mx - cur.x[0]) / (cur.x[1] - cur.x[0] || 1);
  const fy = (my - cur.y[0]) / (cur.y[1] - cur.y[0] || 1);
  const nextX = clampRange([mx - nx * fx, mx + nx * (1 - fx)], base.x);
  const nextY = clampRange([my - ny * fy, my + ny * (1 - fy)], [0, base.y[1] * 1.4]);
  const same =
    Math.abs(nextX[1] - nextX[0] - baseSpanX) < baseSpanX * 1e-4 &&
    Math.abs(nextY[1] - nextY[0] - baseSpanY) < baseSpanY * 1e-4;
  zoomView.value = same ? null : { x: nextX, y: nextY };
}

function sx(v: number): number {
  const [x0, x1] = activeDom.value.x;
  return MARGIN.l + ((v - x0) / (x1 - x0 || 1)) * innerW.value;
}

function sy(v: number): number {
  const [y0, y1] = activeDom.value.y;
  return MARGIN.t + (1 - (v - y0) / (y1 - y0 || 1)) * innerH.value;
}

function ix(px: number): number {
  const [x0, x1] = activeDom.value.x;
  return x0 + ((px - MARGIN.l) / (innerW.value || 1)) * (x1 - x0);
}

function iy(py: number): number {
  const [y0, y1] = activeDom.value.y;
  return y0 + (1 - (py - MARGIN.t) / (innerH.value || 1)) * (y1 - y0);
}

const curveXTicks = computed(() => {
  const [x0, x1] = activeDom.value.x;
  if (!isZoomed.value) {
    return [0, 30, 60, 90, 120, 180, 270, 365, 540, 730].filter((v) => v >= x0 && v <= x1);
  }
  return niceTicks(x0, x1, Math.max(3, Math.round(innerW.value / 95)));
});

const curveYTicks = computed(() => {
  const [y0, y1] = activeDom.value.y;
  return niceTicks(y0, y1, Math.max(3, Math.round(innerH.value / 56)));
});

function buildSegmentedPath(pts: { x: number; y: number | null }[]): string {
  let d = "";
  let open = false;
  for (const p of pts) {
    if (p.y == null || !Number.isFinite(p.y)) {
      open = false;
      continue;
    }
    const X = sx(p.x).toFixed(1);
    const Y = sy(p.y).toFixed(1);
    d += `${open ? "L" : "M"}${X},${Y}`;
    open = true;
  }
  return d;
}

function buildAreaPath(pts: { x: number; y: number | null }[]): string {
  const baseY = sy(activeDom.value.y[0]).toFixed(1);
  const segs: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (const p of pts) {
    if (p.y == null || !Number.isFinite(p.y)) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
    } else {
      cur.push({ x: p.x, y: p.y });
    }
  }
  if (cur.length > 1) segs.push(cur);
  return segs
    .map(
      (seg) =>
        `M${sx(seg[0].x).toFixed(1)},${baseY}` +
        seg.map((p) => `L${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("") +
        `L${sx(seg[seg.length - 1].x).toFixed(1)},${baseY}Z`
    )
    .join(" ");
}

function buildCrossPath(): string {
  const { upper, lower } = crossedSamples.value;
  let d = "";
  let run: { x: number; hi: number; lo: number }[] = [];
  const flush = () => {
    if (run.length > 1) {
      d +=
        `M${run.map((p) => `${sx(p.x).toFixed(1)},${sy(p.hi).toFixed(1)}`).join("L")}` +
        `L${run
          .slice()
          .reverse()
          .map((p) => `${sx(p.x).toFixed(1)},${sy(p.lo).toFixed(1)}`)
          .join("L")}Z `;
    }
    run = [];
  };
  for (let i = 0; i < upper.length; i++) {
    const u = upper[i];
    const l = lower[i];
    if (u?.y != null && l?.y != null && u.y >= l.y) {
      run.push({ x: u.x, hi: u.y, lo: l.y });
    } else {
      flush();
    }
  }
  flush();
  return d;
}

const bidLineD = computed(() => buildSegmentedPath(bidPoints.value));
const bidAreaD = computed(() => buildAreaPath(bidPoints.value));
const askLineD = computed(() => buildSegmentedPath(askEnvelopePoints.value));
const crossAreaD = computed(() => buildCrossPath());

const selectionBandRect = computed(() => {
  const [x0, x1] = activeDom.value.x;
  const loDays = props.upto ? 0 : Math.max(0, (props.targetBlocks - bandBlocks.value) / DAY_BLOCKS);
  const hiDays = props.upto
    ? props.targetBlocks / DAY_BLOCKS
    : (props.targetBlocks + bandBlocks.value) / DAY_BLOCKS;
  const a = sx(Math.max(x0, loDays));
  const b = sx(Math.min(x1, hiDays));
  return { x: a, w: Math.max(0, b - a) };
});

const cursorXDays = computed(() => props.targetBlocks / DAY_BLOCKS);

// Visual vertical spread connector on the curve at the exact matched maturity d*
const spreadMarker = computed(() => {
  const ob = props.orderbook;
  if (
    !ob ||
    ob.spread == null ||
    ob.spreadD == null ||
    ob.spreadBid == null ||
    ob.spreadAsk == null
  ) {
    return null;
  }
  const xDays = ob.spreadD / DAY_BLOCKS;
  if (xDays < activeDom.value.x[0] || xDays > activeDom.value.x[1]) return null;
  return {
    x: sx(xDays),
    yBid: sy(ob.spreadBid / 100),
    yAsk: sy(ob.spreadAsk / 100),
    crossed: ob.spread <= 0,
    spread: ob.spread,
    d: ob.spreadD
  };
});

const curveHoverReadout = computed(() => {
  if (hoverX.value == null || !props.curves) return null;
  const hoveredDot = hoveredAskId.value
    ? askDotsData.value.find((d) => d.id === hoveredAskId.value) ?? null
    : null;
  const blocks = hoveredDot
    ? hoveredDot.d
    : Math.max(DAY_BLOCKS, Math.round(hoverX.value * DAY_BLOCKS));
  const bidBps = lineAt(props.curves.bidLine, blocks);
  const winAskBps = bestWindowAskAt(props.curves, blocks, askById.value, props.height);
  const askBps =
    hoveredDot != null
      ? winAskBps != null
        ? Math.max(winAskBps, hoveredDot.bps)
        : hoveredDot.bps
      : winAskBps;
  const spread = bidBps != null && askBps != null ? bidBps - askBps : null;
  const refBps = askBps ?? bidBps;
  const parPct = refBps != null ? 100 / (1 + (refBps / 10_000) * (blocks / YEAR_BLOCKS)) : null;
  const px = sx(hoveredDot ? hoveredDot.x : hoverX.value);
  const flip = px > plotW.value - 210;
  return {
    blocks,
    px,
    left: flip ? Math.max(MARGIN.l + 8, px - 196) : Math.min(plotW.value - 196, px + 14),
    bidBps,
    askBps,
    spread,
    parPct
  };
});

function pointerSvgCoords(e: PointerEvent | WheelEvent) {
  const el = svgRef.value;
  if (!el) return { X: 0, Y: 0 };
  const r = el.getBoundingClientRect();
  return {
    X: ((e.clientX - r.left) / (r.width || 1)) * plotW.value,
    Y: ((e.clientY - r.top) / (r.height || 1)) * plotH.value
  };
}

function inPlot(X: number, Y: number) {
  return (
    X >= MARGIN.l && X <= MARGIN.l + innerW.value && Y >= MARGIN.t && Y <= MARGIN.t + innerH.value
  );
}

function onCurvePointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const { X, Y } = pointerSvgCoords(e);
  if (!inPlot(X, Y)) return;
  panState = {
    startX: X,
    startY: Y,
    dom: {
      x: [...activeDom.value.x] as [number, number],
      y: [...activeDom.value.y] as [number, number]
    },
    moved: false
  };
  if (isZoomed.value) svgRef.value?.setPointerCapture?.(e.pointerId);
}

function onCurvePointerMove(e: PointerEvent) {
  const { X, Y } = pointerSvgCoords(e);
  if (panState) {
    if (Math.abs(X - panState.startX) + Math.abs(Y - panState.startY) > 4) {
      panState.moved = true;
    }
    if (panState.moved && isZoomed.value) {
      const dx = ((X - panState.startX) / innerW.value) * (panState.dom.x[1] - panState.dom.x[0]);
      const dy = ((Y - panState.startY) / innerH.value) * (panState.dom.y[1] - panState.dom.y[0]);
      zoomView.value = {
        x: clampRange([panState.dom.x[0] - dx, panState.dom.x[1] - dx], baseDom.value.x),
        y: clampRange([panState.dom.y[0] + dy, panState.dom.y[1] + dy], [0, baseDom.value.y[1] * 1.4])
      };
      hoverX.value = null;
      return;
    }
  }
  if (inPlot(X, Y)) {
    hoverX.value = Math.max(0, ix(X));
  } else {
    hoverX.value = null;
  }
}

function onCurvePointerUp(e: PointerEvent) {
  const p = panState;
  panState = null;
  if (!p) return;
  svgRef.value?.releasePointerCapture?.(e.pointerId);
  if (!p.moved) {
    const { X, Y } = pointerSvgCoords(e);
    if (inPlot(X, Y)) {
      const pickedDays = Math.max(1, Math.round(ix(X)));
      emit("update:targetBlocks", pickedDays * DAY_BLOCKS);
    }
  }
}

function onCurveWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const { X, Y } = pointerSvgCoords(e);
  zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ix(X), iy(Y));
}

/* ============================================================
   LENS 2: Term Matrix (Maturity Buckets)
   ============================================================ */
const BUCKETS = [
  { key: "7d", label: "1–7d", loDays: 1, hiDays: 7, pickDays: 7 },
  { key: "30d", label: "7–30d", loDays: 7, hiDays: 30, pickDays: 30 },
  { key: "60d", label: "30–60d", loDays: 30, hiDays: 60, pickDays: 60 },
  { key: "90d", label: "60–90d", loDays: 60, hiDays: 90, pickDays: 90 },
  { key: "180d", label: "90–180d", loDays: 90, hiDays: 180, pickDays: 180 },
  { key: "365d", label: "180d–1y", loDays: 180, hiDays: 365, pickDays: 365 }
] as const;

const ladderRows = computed(() => {
  const c = props.curves;
  const rows = BUCKETS.map((b) => {
    const lo = b.loDays * DAY_BLOCKS;
    const hi = b.hiDays * DAY_BLOCKS;
    const mid = Math.round((lo + hi) / 2);

    // Track true same-maturity tightest spread inside this maturity bucket
    let tightest: { d: number; bid: number; ask: number; gap: number } | null = null;
    const considerGap = (d: number, askY: number) => {
      const bidY = c ? lineAt(c.bidLine, d) : null;
      if (bidY == null) return;
      const gap = bidY - askY;
      if (
        !tightest ||
        gap < tightest.gap ||
        (gap === tightest.gap && askY > tightest.ask)
      ) {
        tightest = { d, bid: bidY, ask: askY, gap };
      }
    };

    let bestAskInBucket: number | null = null;
    let askCost = 0;
    let askCount = 0;
    for (const a of props.asks) {
      if (a.pricing === "window" && a.window) {
        if (a.window.max >= lo && a.window.min <= hi) {
          askCount += 1;
          const wLo = Math.max(lo, a.window.min);
          const wHi = Math.min(hi, a.window.max);
          const wMid = Math.round((wLo + wHi) / 2);
          const qMid = resolvedAskQuote(a, props.height, wMid);
          if (qMid) askCost += qMid.cost;
          for (const d of [wLo, wMid, wHi]) {
            const q = resolvedAskQuote(a, props.height, d);
            if (q) {
              if (bestAskInBucket == null || q.yieldBps > bestAskInBucket) {
                bestAskInBucket = q.yieldBps;
              }
              considerGap(d, q.yieldBps);
            }
          }
        }
      } else if (a.quote && a.quote.d >= lo && a.quote.d <= hi) {
        askCount += 1;
        askCost += a.quote.cost;
        if (bestAskInBucket == null || a.quote.yieldBps > bestAskInBucket) {
          bestAskInBucket = a.quote.yieldBps;
        }
        considerGap(a.quote.d, a.quote.yieldBps);
      }
    }

    // Also inspect curve ask dots/windows if not already present in the loaded asks page
    if (c) {
      for (const dot of c.dots) {
        if (dot.d >= lo && dot.d <= hi) {
          if (bestAskInBucket == null || dot.y > bestAskInBucket) bestAskInBucket = dot.y;
          considerGap(dot.d, dot.y);
        }
      }
      for (const w of c.windows) {
        if (w.max >= lo && w.min <= hi) {
          const wLo = Math.max(lo, w.min);
          const wHi = Math.min(hi, w.max);
          const wMid = Math.round((wLo + wHi) / 2);
          for (const d of [wLo, wMid, wHi]) {
            const y = windowYieldAtPoint(w, d, askById.value, props.height);
            if (y != null) {
              if (bestAskInBucket == null || y > bestAskInBucket) bestAskInBucket = y;
              considerGap(d, y);
            }
          }
        }
      }
    }

    const matched = tightest as { d: number; bid: number; ask: number; gap: number } | null;
    // When both sides overlap at a shared maturity inside the bucket, quote the matched pair;
    // otherwise evaluate the bid curve at the bucket midpoint so buckets trace the curve cleanly.
    const bidAtMid = c
      ? lineAt(c.bidLine, mid) ?? lineAt(c.bidLine, lo) ?? lineAt(c.bidLine, hi)
      : null;
    const bestBid = matched ? matched.bid : bidAtMid;
    const bestAsk = matched ? matched.ask : bestAskInBucket;

    let offerCap = 0;
    let offerCount = 0;
    for (const o of props.offers) {
      if (o.maxBlocks >= lo && o.minBlocks <= hi) {
        offerCount += 1;
        offerCap += o.capital;
      }
    }

    const spread = matched ? matched.gap : null;
    const crossed = spread != null && spread <= 0;
    const refD = matched ? matched.d : mid;
    const refBps = bestAsk ?? bestBid;
    const parPct = refBps != null ? 100 / (1 + (refBps / 10_000) * (refD / YEAR_BLOCKS)) : null;
    const selected = props.upto
      ? b.hiDays * DAY_BLOCKS <= props.targetBlocks + 1
      : props.targetBlocks >= lo && props.targetBlocks <= hi;

    return {
      ...b,
      lo,
      hi,
      bestBid,
      bestAsk,
      spread,
      crossed,
      offerCap,
      offerCount,
      askCost,
      askCount,
      parPct,
      selected
    };
  });

  const allBps = rows.flatMap((r) => [r.bestBid, r.bestAsk]).filter((v): v is number => v != null);
  const maxBps = Math.max(1200, ...allBps) * 1.15;
  const maxLiq = Math.max(1, ...rows.map((r) => r.offerCap + r.askCost));

  return { rows, maxBps, maxLiq };
});

/* ============================================================
   LENS 3: Risk Map (Cover vs APR Scatter)
   ============================================================ */
const hoveredSafetyId = ref<string | null>(null);

const safetyData = computed(() => {
  const oracleAsks = props.asks.filter((a) => a.cov != null && resolvedAskQuote(a, props.height));
  const maturityAsks = props.asks.filter((a) => a.cov == null && resolvedAskQuote(a, props.height));
  const costs = oracleAsks.map((a) => resolvedAskQuote(a, props.height)?.cost ?? 1);
  const maxCost = Math.max(1, ...costs);

  const pts = oracleAsks.map((a) => {
    const q = resolvedAskQuote(a, props.height)!;
    return {
      ask: a,
      id: a.id,
      cov: a.cov as number,
      apr: q.yieldBps / 100,
      yieldBps: q.yieldBps,
      cost: q.cost,
      d: q.d,
      r: 3.4 + Math.sqrt(q.cost / maxCost) * 2.8,
      ratio: a.ratio,
      kind: a.kind,
      ok: a.ok
    };
  });

  const maxCov = Math.max(260, props.coverage + 60, ...pts.map((p) => p.cov * 1.12));
  const xDom: [number, number] = [100, Math.ceil(maxCov / 25) * 25];
  const yDom = niceDomain(
    pts.map((p) => p.apr),
    0.2,
    true
  );
  const refBidBps = props.curves ? lineAt(props.curves.bidLine, props.targetBlocks) : null;

  return { pts, maturityAsks, xDom, yDom, refBidBps };
});

function safetyX(cov: number): number {
  const [x0, x1] = safetyData.value.xDom;
  return MARGIN.l + ((cov - x0) / (x1 - x0 || 1)) * innerW.value;
}

function safetyY(apr: number): number {
  const [y0, y1] = safetyData.value.yDom;
  return MARGIN.t + (1 - (apr - y0) / (y1 - y0 || 1)) * innerH.value;
}

const safetyXTicks = computed(() => niceTicks(safetyData.value.xDom[0], safetyData.value.xDom[1], 5));
const safetyYTicks = computed(() =>
  niceTicks(safetyData.value.yDom[0], safetyData.value.yDom[1], Math.max(3, Math.round(innerH.value / 56)))
);

const hoveredSafetyPoint = computed(() =>
  hoveredSafetyId.value
    ? safetyData.value.pts.find((p) => p.id === hoveredSafetyId.value) || null
    : null
);

function kindColor(kind: ZcAskSummary["kind"]): string {
  if (kind === "shares") return "var(--sf-bid)";
  if (kind === "unit") return "var(--sf-cobalt)";
  return "var(--sf-ask)";
}

/* ============================================================
   LENS 4: 10-Day Fill History
   ============================================================ */
const historySpanBlocks = 7200;
const historyHoverX = ref<number | null>(null);

const historyData = computed(() => {
  const fills = props.fills.filter((f) => f.yieldBps != null);
  const buckets = 28;
  const step = historySpanBlocks / buckets;
  const inSel = (d: number) =>
    props.upto
      ? d >= MIN_MATURITY_BLOCKS && d <= props.targetBlocks
      : Math.abs(d - props.targetBlocks) <= bandBlocks.value;

  const bars: { x: number; w: number; v: number }[] = [];
  const avg: { x: number; y: number | null }[] = [];
  for (let i = 0; i < buckets; i++) {
    const lo = props.height - historySpanBlocks + i * step;
    const hi = lo + step;
    const inB = fills.filter((f) => f.height > lo && f.height <= hi);
    const vol = inB.reduce((n, f) => n + f.cost, 0);
    const xDays = (lo + step / 2 - props.height) / DAY_BLOCKS;
    bars.push({ x: xDays, w: step / DAY_BLOCKS, v: vol });
    const selB = inB.filter((f) => inSel(f.d));
    const selVol = selB.reduce((n, f) => n + f.cost, 0);
    avg.push({
      x: xDays,
      y: selVol > 0 ? selB.reduce((n, f) => n + f.cost * f.yieldBps, 0) / selVol / 100 : null
    });
  }
  const maxCost = Math.max(1, ...fills.map((f) => f.cost));
  const maxVol = Math.max(1, ...bars.map((b) => b.v));
  const dots = fills.map((f) => ({
    id: f.id,
    x: (f.height - props.height) / DAY_BLOCKS,
    y: f.yieldBps / 100,
    r: 2.1 + Math.sqrt(f.cost / maxCost) * 2.4,
    color: f.kind === "new" ? "var(--sf-bid)" : "var(--sf-ask)",
    opacity: inSel(f.d) ? 0.92 : 0.32
  }));
  const yDom = niceDomain(
    fills.map((f) => f.yieldBps / 100),
    0.16,
    true
  );
  return { bars, avg, dots, maxVol, yDom, count: fills.length };
});

function histX(daysRel: number): number {
  const minD = -historySpanBlocks / DAY_BLOCKS;
  return MARGIN.l + ((daysRel - minD) / (0 - minD)) * innerW.value;
}

function histY(apr: number): number {
  const [y0, y1] = historyData.value.yDom;
  return MARGIN.t + (1 - (apr - y0) / (y1 - y0 || 1)) * innerH.value;
}

const histAvgPath = computed(() => {
  let d = "";
  let open = false;
  for (const p of historyData.value.avg) {
    if (p.y == null) {
      open = false;
      continue;
    }
    d += `${open ? "L" : "M"}${histX(p.x).toFixed(1)},${histY(p.y).toFixed(1)}`;
    open = true;
  }
  return d;
});

const historyReadout = computed(() => {
  if (historyHoverX.value == null) return null;
  const targetH = props.height + historyHoverX.value * DAY_BLOCKS;
  const near = props.fills.filter((f) => Math.abs(f.height - targetH) < 160 && f.yieldBps != null);
  const vol = near.reduce((n, f) => n + f.cost, 0);
  const avgApr = vol > 0 ? near.reduce((n, f) => n + f.cost * f.yieldBps, 0) / vol : null;
  const px = histX(historyHoverX.value);
  return {
    px,
    left: px > plotW.value - 180 ? Math.max(MARGIN.l + 8, px - 172) : px + 12,
    agoText: formatAgo(Math.max(1, Math.round(props.height - targetH)), props.unit),
    count: near.length,
    avgApr
  };
});

function onHistoryMove(e: PointerEvent) {
  const el = e.currentTarget as SVGSVGElement;
  const r = el.getBoundingClientRect();
  const X = ((e.clientX - r.left) / (r.width || 1)) * plotW.value;
  if (X >= MARGIN.l && X <= MARGIN.l + innerW.value) {
    const minD = -historySpanBlocks / DAY_BLOCKS;
    historyHoverX.value = minD + ((X - MARGIN.l) / innerW.value) * (0 - minD);
  } else {
    historyHoverX.value = null;
  }
}

const historyEmptyTitle = computed(() => {
  if (props.fillsStatus === "not-configured") return "Fill history unavailable on this feed";
  if (props.fillsStatus === "disabled") return "Fill history disabled";
  return "No confirmed fills in the last 10 days";
});
</script>

<template>
  <section
    class="sf-terminal-plate flex h-full min-h-0 flex-col overflow-hidden rounded-[20px] rounded-tl-[6px]"
  >
    <!-- Top Lens & Tool Bar -->
    <div class="sf-panel-head flex shrink-0 items-center justify-between gap-2 px-3.5 py-2">
      <div class="sf-seg" role="tablist" aria-label="Analytical view">
        <button
          v-for="item in LENSES"
          :key="item.key"
          type="button"
          role="tab"
          :aria-selected="lens === item.key"
          class="sf-seg-btn px-2.5 py-1 text-[11.5px]"
          :class="lens === item.key ? 'is-active tone-cobalt' : ''"
          @click="lens = item.key"
        >
          <activity-icon v-if="item.key === 'curve'" class="h-3.5 w-3.5" />
          <grid-icon v-else-if="item.key === 'matrix'" class="h-3.5 w-3.5" />
          <shield-icon v-else-if="item.key === 'safety'" class="h-3.5 w-3.5" />
          <layers-icon v-else class="h-3.5 w-3.5" />
          <span>{{ item.label }}</span>
        </button>
      </div>

      <!-- Contextual Lens Tools -->
      <div v-if="lens === 'curve'" class="flex items-center gap-1.5">
        <span
          v-if="isZoomed"
          class="sf-mono rounded-[5px] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--sf-cobalt)]"
        >
          {{ zoomLevel.toFixed(1) }}×
        </span>
        <div class="sf-seg" role="group" aria-label="Chart zoom">
          <button
            type="button"
            class="sf-seg-btn h-6 w-6 !p-0"
            title="Zoom out (Ctrl + scroll)"
            aria-label="Zoom out"
            @click="zoomBy(1 / ZOOM_STEP)"
          >
            <minus-icon class="h-3 w-3" />
          </button>
          <button
            type="button"
            class="sf-seg-btn h-6 w-6 !p-0"
            title="Zoom in (Ctrl + scroll)"
            aria-label="Zoom in"
            @click="zoomBy(ZOOM_STEP)"
          >
            <plus-icon class="h-3 w-3" />
          </button>
          <button
            v-if="isZoomed"
            type="button"
            class="sf-seg-btn h-6 w-6 !p-0 text-[color:var(--sf-cobalt)]"
            title="Reset zoom"
            aria-label="Reset zoom"
            @click="zoomView = null"
          >
            <rotate-ccw-icon class="h-3 w-3" />
          </button>
        </div>
      </div>

      <span
        v-else-if="lens === 'safety'"
        class="sf-mono rounded-[6px] border border-[color:var(--sf-line)] bg-[color:var(--sf-seg-bg)] px-2 py-0.5 text-[10.5px] text-[color:var(--sf-muted)]"
      >
        ≥ {{ coverage }}% · r ∝ size
      </span>

      <span
        v-else-if="lens === 'history'"
        class="sf-mono rounded-[6px] border border-[color:var(--sf-line)] bg-[color:var(--sf-seg-bg)] px-2 py-0.5 text-[10.5px] text-[color:var(--sf-muted)]"
      >
        {{ formatDur(historySpanBlocks, unit) }} · {{ historyData.count }}
      </span>
    </div>

    <!-- ======================================================
         MAIN DYNAMIC-HEIGHT PLOT STAGE
         ====================================================== -->
    <div
      ref="plotWrapRef"
      class="plot-stage relative min-h-[224px] flex-1 overflow-hidden bg-[color:var(--sf-card)]"
    >
      <!-- Ambient directional studio glow behind chart (echoing HeroYieldExchange) -->
      <div class="plot-bloom pointer-events-none absolute inset-0" aria-hidden="true" />

      <!-- LENS 1: TERM CURVE -->
      <template v-if="lens === 'curve'">
        <div
          v-if="curveEmpty"
          class="relative z-10 flex h-full min-h-[224px] flex-col items-center justify-center px-6 text-center"
        >
          <div
            class="grid h-10 w-10 place-items-center rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] text-[color:var(--sf-muted)]"
          >
            <activity-icon class="h-[18px] w-[18px]" />
          </div>
          <p class="sf-display mt-2.5 text-[16px] font-semibold text-[color:var(--sf-ink)]">
            {{ connected ? `No ${market} orders match filters` : "Syncing Ergo chain" }}
          </p>
          <p class="mt-0.5 text-[12px] text-[color:var(--sf-muted)]">
            {{
              connected
                ? `Lower cover below ${coverage}% or disable Matchable only.`
                : "Configure your Explorer or GraphQL feed in the top bar."
            }}
          </p>
        </div>

        <div v-else class="relative z-10 h-full w-full select-none">
          <svg
            ref="svgRef"
            :width="plotW"
            :height="plotH"
            :viewBox="`0 0 ${plotW} ${plotH}`"
            class="block h-full w-full"
            :class="isZoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'"
            role="img"
            :aria-label="`${market} yield curve`"
            @pointerdown="onCurvePointerDown"
            @pointermove="onCurvePointerMove"
            @pointerup="onCurvePointerUp"
            @pointercancel="onCurvePointerUp"
            @pointerleave="
              hoverX = null;
              hoveredOfferId = null;
            "
            @wheel="onCurveWheel"
          >
            <defs>
              <clipPath id="sfCurvePlotClip">
                <rect :x="MARGIN.l" :y="MARGIN.t - 4" :width="innerW" :height="innerH + 8" />
              </clipPath>
              <linearGradient id="sfRbBidGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--sf-bid)" stop-opacity="0.2" />
                <stop offset="100%" stop-color="var(--sf-bid)" stop-opacity="0.0" />
              </linearGradient>
              <linearGradient id="sfBandGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--sf-cobalt)" stop-opacity="0.11" />
                <stop offset="100%" stop-color="var(--sf-cobalt)" stop-opacity="0.02" />
              </linearGradient>
              <pattern
                id="sfCrossHatch"
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="6" height="6" fill="var(--sf-ask)" fill-opacity="0.12" />
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="6"
                  stroke="var(--sf-ask)"
                  stroke-opacity="0.38"
                  stroke-width="1.5"
                />
              </pattern>
            </defs>

            <!-- Coordinate Grid -->
            <g>
              <g v-for="yt in curveYTicks" :key="`y-${yt}`">
                <line
                  :x1="MARGIN.l"
                  :x2="MARGIN.l + innerW"
                  :y1="sy(yt)"
                  :y2="sy(yt)"
                  :stroke="yt === 0 ? 'var(--sf-line-strong)' : 'var(--sf-line)'"
                  :stroke-dasharray="yt === 0 ? undefined : '3 5'"
                />
                <text
                  :x="MARGIN.l - 7"
                  :y="sy(yt) + 3.5"
                  text-anchor="end"
                  fill="var(--sf-muted)"
                  font-size="10"
                  class="sf-mono"
                >
                  {{ yt % 1 === 0 ? `${yt}%` : `${yt.toFixed(1)}%` }}
                </text>
              </g>

              <g v-for="xt in curveXTicks" :key="`x-${xt}`">
                <line
                  :x1="sx(xt)"
                  :x2="sx(xt)"
                  :y1="MARGIN.t"
                  :y2="MARGIN.t + innerH"
                  stroke="var(--sf-line)"
                  stroke-opacity="0.7"
                />
                <text
                  :x="sx(xt)"
                  :y="plotH - 7"
                  text-anchor="middle"
                  fill="var(--sf-muted)"
                  font-size="10"
                  class="sf-mono"
                >
                  {{ formatAxisDays(xt, unit) }}
                </text>
              </g>

              <line
                :x1="MARGIN.l"
                :x2="MARGIN.l"
                :y1="MARGIN.t"
                :y2="MARGIN.t + innerH"
                stroke="var(--sf-line-strong)"
              />
            </g>

            <!-- Clipped Data Layers -->
            <g clip-path="url(#sfCurvePlotClip)">
              <!-- Selection Maturity Band -->
              <rect
                :x="selectionBandRect.x"
                :y="MARGIN.t"
                :width="selectionBandRect.w"
                :height="innerH"
                fill="url(#sfBandGrad)"
              />

              <!-- Crossed Market Hatch Ribbon -->
              <path v-if="crossAreaD" :d="crossAreaD" fill="url(#sfCrossHatch)" />

              <!-- Individual Bid Offer Filaments -->
              <g v-if="showOffers">
                <path
                  v-for="fil in offerFilaments"
                  :key="fil.id"
                  :d="buildSegmentedPath(fil.pts)"
                  fill="none"
                  stroke="var(--sf-bid)"
                  :stroke-width="hoveredOfferId === fil.id || selectedId === fil.id ? 2.1 : 1"
                  :stroke-opacity="
                    hoveredOfferId === fil.id || selectedId === fil.id ? 0.9 : fil.ok ? 0.26 : 0.1
                  "
                  class="cursor-pointer transition-opacity"
                  @pointerenter="hoveredOfferId = fil.id"
                  @pointerleave="hoveredOfferId = null"
                  @pointerdown.stop
                  @click.stop="emit('select-bid', fil.id)"
                />
              </g>

              <!-- Variable-Maturity Window Order Curves -->
              <g v-for="wc in windowCurvesData" :key="`win-${wc.id}`">
                <path
                  :d="buildSegmentedPath(wc.pts)"
                  fill="none"
                  stroke="var(--sf-ask)"
                  :stroke-width="selectedId === wc.id ? 2 : 0.9"
                  :stroke-dasharray="selectedId === wc.id ? '4 2.5' : '3 3'"
                  :stroke-opacity="selectedId === wc.id ? 0.95 : 0.4"
                  class="cursor-pointer"
                  @pointerdown.stop
                  @click.stop="emit('select-ask', wc.id)"
                />
              </g>

              <!-- 10d Confirmed Fills Scatter -->
              <g v-if="showFills">
                <rect
                  v-for="f in fillDotsData"
                  :key="f.id"
                  :x="sx(f.x) - 2"
                  :y="sy(f.y) - 2"
                  width="4"
                  height="4"
                  :transform="`rotate(45 ${sx(f.x)} ${sy(f.y)})`"
                  fill="var(--sf-cobalt)"
                  :fill-opacity="f.opacity"
                />
              </g>

              <!-- Best Bid Envelope (luminous emerald) -->
              <path v-if="bidAreaD" :d="bidAreaD" fill="url(#sfRbBidGrad)" />
              <path
                v-if="bidLineD"
                :d="bidLineD"
                fill="none"
                stroke="var(--sf-bid)"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="curve-glow-bid"
              />

              <!-- Best Ask Envelope (luminous amber) -->
              <path
                v-if="askLineD"
                :d="askLineD"
                fill="none"
                stroke="var(--sf-ask)"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="curve-glow-ask"
              />

              <!-- Size-Scaled Clickable Ask Nodes -->
              <g
                v-for="dot in askDotsData"
                :key="dot.id"
                class="ask-dot-node sf-rb-ask-dot cursor-pointer"
                :class="{ 'is-selected': selectedId === dot.id }"
                :style="{ '--dot-tone': dot.buyback ? 'var(--sf-bid)' : 'var(--sf-ask)' }"
                @pointerenter="hoveredAskId = dot.id"
                @pointerleave="hoveredAskId = null"
                @pointerdown.stop
                @click.stop="emit('select-ask', dot.id)"
              >
                <circle :cx="sx(dot.x)" :cy="sy(dot.y)" r="10" fill="transparent" />
                <circle
                  v-if="selectedId === dot.id || hoveredAskId === dot.id || dot.buyback"
                  class="sf-rb-dot-halo"
                  :cx="sx(dot.x)"
                  :cy="sy(dot.y)"
                  :r="dot.r + 3.2"
                  :fill="dot.buyback ? 'var(--sf-bid)' : 'var(--sf-ask)'"
                  fill-opacity="0.18"
                />
                <circle
                  class="sf-rb-dot-core"
                  :cx="sx(dot.x)"
                  :cy="sy(dot.y)"
                  :r="hoveredAskId === dot.id ? dot.r + 1.1 : dot.r"
                  :fill="
                    dot.buyback
                      ? 'var(--sf-bid)'
                      : dot.active
                        ? 'var(--sf-ask)'
                        : 'var(--sf-card)'
                  "
                  :stroke="
                    dot.buyback
                      ? 'var(--sf-card)'
                      : dot.active
                        ? 'var(--sf-card)'
                        : 'var(--sf-ask)'
                  "
                  :stroke-width="selectedId === dot.id ? 1.5 : 1.4"
                >
                  <title>
                    {{ kindLabel(dot.kind) }} · {{ formatApr(dot.bps) }} ·
                    {{ formatDur(dot.d, unit) }} · {{ formatMarketAmount(dot.cost, market)
                    }}{{ dot.buyback ? " · Your loan (buy back)" : "" }}
                  </title>
                </circle>
              </g>

              <!-- Tightest Same-Maturity Spread Connector (anchors Spread Bridge to Curve) -->
              <g v-if="spreadMarker" pointer-events="none">
                <line
                  :x1="spreadMarker.x"
                  :x2="spreadMarker.x"
                  :y1="spreadMarker.yBid"
                  :y2="spreadMarker.yAsk"
                  :stroke="spreadMarker.crossed ? 'var(--sf-ask)' : 'var(--sf-cobalt)'"
                  stroke-width="1.8"
                  stroke-dasharray="2.5 2.5"
                  stroke-opacity="0.72"
                />
                <circle
                  :cx="spreadMarker.x"
                  :cy="spreadMarker.yBid"
                  r="3"
                  fill="var(--sf-card)"
                  stroke="var(--sf-bid)"
                  stroke-width="1.6"
                />
                <circle
                  :cx="spreadMarker.x"
                  :cy="spreadMarker.yAsk"
                  r="3"
                  fill="var(--sf-card)"
                  stroke="var(--sf-ask)"
                  stroke-width="1.6"
                />
              </g>

              <!-- Active Maturity Cursor Line -->
              <g v-if="cursorXDays >= activeDom.x[0] && cursorXDays <= activeDom.x[1]">
                <line
                  :x1="sx(cursorXDays)"
                  :x2="sx(cursorXDays)"
                  :y1="MARGIN.t"
                  :y2="MARGIN.t + innerH"
                  stroke="var(--sf-cobalt)"
                  stroke-width="1.25"
                  stroke-dasharray="3 3"
                  stroke-opacity="0.85"
                />
                <text
                  :x="
                    sx(cursorXDays) > MARGIN.l + innerW - 72
                      ? sx(cursorXDays) - 6
                      : sx(cursorXDays) + 6
                  "
                  :y="MARGIN.t + 11"
                  :text-anchor="sx(cursorXDays) > MARGIN.l + innerW - 72 ? 'end' : 'start'"
                  fill="var(--sf-cobalt)"
                  font-size="10"
                  font-weight="600"
                  class="sf-mono"
                >
                  {{ upto ? `≤ ${formatDur(targetBlocks, unit)}` : formatDur(targetBlocks, unit) }}
                </text>
              </g>
            </g>

            <!-- Hover Crosshair -->
            <g v-if="curveHoverReadout" pointer-events="none">
              <line
                :x1="curveHoverReadout.px"
                :x2="curveHoverReadout.px"
                :y1="MARGIN.t"
                :y2="MARGIN.t + innerH"
                stroke="var(--sf-line-strong)"
                stroke-width="1"
              />
              <circle
                v-if="curveHoverReadout.bidBps != null"
                :cx="curveHoverReadout.px"
                :cy="sy(curveHoverReadout.bidBps / 100)"
                r="4"
                fill="var(--sf-bid)"
                stroke="var(--sf-card)"
                stroke-width="1.8"
              />
              <circle
                v-if="curveHoverReadout.askBps != null"
                :cx="curveHoverReadout.px"
                :cy="sy(curveHoverReadout.askBps / 100)"
                r="4"
                fill="var(--sf-ask)"
                stroke="var(--sf-card)"
                stroke-width="1.8"
              />
            </g>
          </svg>

          <!-- Floating Crosshair Telemetry Card -->
          <div
            v-if="curveHoverReadout"
            class="sf-popover pointer-events-none absolute top-2.5 z-20 w-[184px] rounded-xl px-2.5 py-2 text-[11px]"
            :style="{ left: `${curveHoverReadout.left}px` }"
          >
            <div
              class="sf-mono flex items-center justify-between border-b border-[color:var(--sf-line)] pb-1 font-semibold text-[color:var(--sf-ink)]"
            >
              <span>{{ formatDur(curveHoverReadout.blocks, unit) }}</span>
              <span class="font-normal text-[color:var(--sf-muted)]">
                {{ dateAtHeight(height + curveHoverReadout.blocks, height) }}
              </span>
            </div>
            <div class="sf-mono mt-1.5 space-y-0.5">
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Bid</span>
                <span class="font-semibold text-[color:var(--sf-bid)]">
                  {{ formatApr(curveHoverReadout.bidBps) }}
                </span>
              </div>
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Ask</span>
                <span class="font-semibold text-[color:var(--sf-ask)]">
                  {{ formatApr(curveHoverReadout.askBps) }}
                </span>
              </div>
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Spread</span>
                <span
                  class="font-semibold"
                  :class="
                    curveHoverReadout.spread != null && curveHoverReadout.spread <= 0
                      ? 'text-[color:var(--sf-ask)]'
                      : 'text-[color:var(--sf-ink)]'
                  "
                >
                  {{ formatBp(curveHoverReadout.spread) }}
                </span>
              </div>
              <div class="flex justify-between border-t border-[color:var(--sf-line)] pt-1">
                <span class="text-[color:var(--sf-muted)]">Par P/F</span>
                <span class="font-semibold text-[color:var(--sf-cobalt)]">
                  {{
                    curveHoverReadout.parPct != null ? `${curveHoverReadout.parPct.toFixed(2)}%` : "—"
                  }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- LENS 2: TERM MATRIX -->
      <template v-else-if="lens === 'matrix'">
        <div class="sf-scroll relative z-10 h-full overflow-y-auto p-3">
          <div class="grid h-full grid-cols-2 gap-2.5 sm:grid-cols-3">
            <button
              v-for="row in ladderRows.rows"
              :key="row.key"
              type="button"
              class="matrix-cell group relative flex flex-col justify-between rounded-[14px] border p-2.5 text-left transition-all"
              :class="
                row.selected
                  ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/50'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] hover:border-[color:var(--sf-line-strong)]'
              "
              @click="emit('update:targetBlocks', row.pickDays * DAY_BLOCKS)"
            >
              <div class="flex items-center justify-between gap-1.5">
                <span class="sf-display text-[14.5px] font-semibold text-[color:var(--sf-ink)]">
                  {{
                    unit === "blocks"
                      ? `${formatDur(row.lo, "blocks").replace(" blk", "")}–${formatDur(row.hi, "blocks")}`
                      : row.label
                  }}
                </span>
                <span
                  v-if="row.crossed"
                  class="sf-mono rounded-[4px] bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[9px] font-semibold uppercase text-[color:var(--sf-ask)]"
                >
                  Cross
                </span>
                <span v-else class="sf-mono text-[10px] text-[color:var(--sf-muted)]">
                  {{ row.spread != null ? formatBp(row.spread) : "—" }}
                </span>
              </div>

              <!-- Shared-Scale Spread Gauge -->
              <div class="my-2">
                <div
                  class="relative h-4 rounded-md bg-[color:var(--sf-card)] px-1.5 ring-1 ring-[color:var(--sf-line)]"
                >
                  <div
                    class="absolute inset-x-1.5 top-1/2 h-[1.5px] -translate-y-1/2 rounded bg-[color:var(--sf-line-strong)]"
                  />
                  <div
                    v-if="row.bestBid != null && row.bestAsk != null"
                    class="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
                    :style="{
                      left: `calc(6px + ${(Math.min(row.bestBid, row.bestAsk) / ladderRows.maxBps) * 86}%)`,
                      width: `max(4px, ${(Math.abs(row.bestAsk - row.bestBid) / ladderRows.maxBps) * 86}%)`,
                      background: row.crossed ? 'var(--sf-ask)' : 'var(--sf-cobalt)',
                      opacity: row.crossed ? 0.65 : 0.4
                    }"
                  />
                  <span
                    v-if="row.bestBid != null"
                    class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--sf-card)] bg-[color:var(--sf-bid)]"
                    :style="{ left: `calc(6px + ${(row.bestBid / ladderRows.maxBps) * 86}%)` }"
                  />
                  <span
                    v-if="row.bestAsk != null"
                    class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--sf-card)] bg-[color:var(--sf-ask)]"
                    :style="{ left: `calc(6px + ${(row.bestAsk / ladderRows.maxBps) * 86}%)` }"
                  />
                </div>

                <div class="sf-mono mt-1.5 flex items-baseline justify-between text-[11.5px]">
                  <span class="font-semibold text-[color:var(--sf-bid)]">
                    {{ formatApr(row.bestBid) }}
                  </span>
                  <span class="text-[10px] font-medium text-[color:var(--sf-cobalt)]">
                    {{ row.parPct != null ? `${row.parPct.toFixed(1)}%` : "—" }}
                  </span>
                  <span class="font-semibold text-[color:var(--sf-ask)]">
                    {{ formatApr(row.bestAsk) }}
                  </span>
                </div>
              </div>

              <div>
                <div class="flex h-1 overflow-hidden rounded-full bg-[color:var(--sf-line)]">
                  <div
                    class="h-full bg-[color:var(--sf-bid)] transition-all duration-300"
                    :style="{ width: `${(row.offerCap / ladderRows.maxLiq) * 100}%` }"
                  />
                  <div
                    class="h-full bg-[color:var(--sf-ask)] transition-all duration-300"
                    :style="{ width: `${(row.askCost / ladderRows.maxLiq) * 100}%` }"
                  />
                </div>
                <div
                  class="sf-mono mt-1 flex items-center justify-between text-[10px] text-[color:var(--sf-muted)]"
                >
                  <span>{{ formatCompact(row.offerCap) }} ({{ row.offerCount }}b)</span>
                  <span>{{ formatCompact(row.askCost) }} ({{ row.askCount }}a)</span>
                </div>
              </div>
            </button>
          </div>
        </div>
      </template>

      <!-- LENS 3: RISK MAP (COVER × APR SCATTER) -->
      <template v-else-if="lens === 'safety'">
        <div
          v-if="!safetyData.pts.length && !safetyData.maturityAsks.length"
          class="relative z-10 flex h-full min-h-[224px] flex-col items-center justify-center px-6 text-center"
        >
          <div
            class="grid h-10 w-10 place-items-center rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] text-[color:var(--sf-muted)]"
          >
            <shield-icon class="h-[18px] w-[18px]" />
          </div>
          <p class="sf-display mt-2.5 text-[16px] font-semibold text-[color:var(--sf-ink)]">
            No open {{ market }} asks
          </p>
        </div>

        <div v-else class="relative z-10 flex h-full flex-col">
          <div class="relative min-h-0 flex-1">
            <svg
              :width="plotW"
              :height="plotH"
              :viewBox="`0 0 ${plotW} ${plotH}`"
              class="block h-full w-full select-none"
              role="img"
              :aria-label="`${market} collateral cover vs APR risk map`"
            >
              <rect
                :x="MARGIN.l"
                :y="MARGIN.t"
                :width="Math.max(0, safetyX(coverage) - MARGIN.l)"
                :height="innerH"
                fill="var(--sf-ask)"
                fill-opacity="0.05"
              />

              <g v-for="yt in safetyYTicks" :key="`sy-${yt}`">
                <line
                  :x1="MARGIN.l"
                  :x2="MARGIN.l + innerW"
                  :y1="safetyY(yt)"
                  :y2="safetyY(yt)"
                  :stroke="yt === 0 ? 'var(--sf-line-strong)' : 'var(--sf-line)'"
                  :stroke-dasharray="yt === 0 ? undefined : '3 5'"
                />
                <text
                  :x="MARGIN.l - 7"
                  :y="safetyY(yt) + 3.5"
                  text-anchor="end"
                  fill="var(--sf-muted)"
                  font-size="10"
                  class="sf-mono"
                >
                  {{ yt.toFixed(0) }}%
                </text>
              </g>

              <g v-for="xt in safetyXTicks" :key="`sx-${xt}`">
                <line
                  :x1="safetyX(xt)"
                  :x2="safetyX(xt)"
                  :y1="MARGIN.t"
                  :y2="MARGIN.t + innerH"
                  stroke="var(--sf-line)"
                  stroke-opacity="0.7"
                />
                <text
                  :x="safetyX(xt)"
                  :y="plotH - 7"
                  text-anchor="middle"
                  fill="var(--sf-muted)"
                  font-size="10"
                  class="sf-mono"
                >
                  {{ xt }}%
                </text>
              </g>

              <line
                :x1="safetyX(MIN_COVER)"
                :x2="safetyX(MIN_COVER)"
                :y1="MARGIN.t"
                :y2="MARGIN.t + innerH"
                stroke="var(--sf-danger)"
                stroke-dasharray="2 4"
                stroke-opacity="0.55"
              />

              <g>
                <line
                  :x1="safetyX(coverage)"
                  :x2="safetyX(coverage)"
                  :y1="MARGIN.t"
                  :y2="MARGIN.t + innerH"
                  stroke="var(--sf-cobalt)"
                  stroke-width="1.35"
                  stroke-dasharray="4 3"
                />
                <text
                  :x="safetyX(coverage) + 5"
                  :y="MARGIN.t + 11"
                  fill="var(--sf-cobalt)"
                  font-size="10"
                  font-weight="600"
                  class="sf-mono"
                >
                  ≥ {{ coverage }}%
                </text>
              </g>

              <g v-if="safetyData.refBidBps != null">
                <line
                  :x1="MARGIN.l"
                  :x2="MARGIN.l + innerW"
                  :y1="safetyY(safetyData.refBidBps / 100)"
                  :y2="safetyY(safetyData.refBidBps / 100)"
                  stroke="var(--sf-bid)"
                  stroke-width="1.25"
                  stroke-dasharray="5 4"
                />
                <text
                  :x="MARGIN.l + innerW - 5"
                  :y="safetyY(safetyData.refBidBps / 100) - 5"
                  text-anchor="end"
                  fill="var(--sf-bid)"
                  font-size="10"
                  font-weight="600"
                  class="sf-mono"
                >
                  Bid {{ formatApr(safetyData.refBidBps) }}
                </text>
              </g>

              <g
                v-for="pt in safetyData.pts"
                :key="pt.id"
                class="sf-rb-safety-dot cursor-pointer"
                :class="{ 'is-selected': selectedId === pt.id }"
                :style="{ '--dot-tone': kindColor(pt.kind) }"
                @pointerenter="hoveredSafetyId = pt.id"
                @pointerleave="hoveredSafetyId = null"
                @click="emit('select-ask', pt.id)"
              >
                <circle :cx="safetyX(pt.cov)" :cy="safetyY(pt.apr)" r="11" fill="transparent" />
                <circle
                  v-if="selectedId === pt.id || hoveredSafetyId === pt.id"
                  class="sf-rb-dot-halo"
                  :cx="safetyX(pt.cov)"
                  :cy="safetyY(pt.apr)"
                  :r="pt.r + 3"
                  :fill="kindColor(pt.kind)"
                  fill-opacity="0.22"
                />
                <circle
                  class="sf-rb-dot-core"
                  :cx="safetyX(pt.cov)"
                  :cy="safetyY(pt.apr)"
                  :r="pt.r"
                  :fill="pt.ok ? kindColor(pt.kind) : 'var(--sf-card)'"
                  :stroke="pt.ok ? 'var(--sf-card)' : kindColor(pt.kind)"
                  :stroke-width="selectedId === pt.id ? 1.5 : 1.3"
                  fill-opacity="0.92"
                />
              </g>
            </svg>

            <div
              v-if="hoveredSafetyPoint"
              class="sf-popover pointer-events-none absolute right-3 top-3 z-20 w-48 rounded-xl px-2.5 py-2 text-[11px]"
            >
              <div
                class="sf-mono flex items-center justify-between border-b border-[color:var(--sf-line)] pb-1 font-semibold text-[color:var(--sf-ink)]"
              >
                <span>{{ kindLabel(hoveredSafetyPoint.kind) }}</span>
                <span class="text-[color:var(--sf-ask)]">
                  {{ formatApr(hoveredSafetyPoint.yieldBps) }}
                </span>
              </div>
              <div class="sf-mono mt-1.5 space-y-0.5">
                <div class="flex justify-between">
                  <span class="text-[color:var(--sf-muted)]">Cover</span>
                  <span class="font-semibold text-[color:var(--sf-bid)]">
                    {{ Math.round(hoveredSafetyPoint.cov) }}%
                  </span>
                </div>
                <div v-if="hoveredSafetyPoint.ratio" class="flex justify-between">
                  <span class="text-[color:var(--sf-muted)]">Liq</span>
                  <span>&lt; {{ hoveredSafetyPoint.ratio }}%</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-[color:var(--sf-muted)]">Size</span>
                  <span>{{ formatMarketAmount(hoveredSafetyPoint.cost, market) }}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-[color:var(--sf-muted)]">Term</span>
                  <span>{{ formatDur(hoveredSafetyPoint.d, unit) }}</span>
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="safetyData.maturityAsks.length"
            class="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-3 py-1.5 text-[10.5px]"
          >
            <span class="sf-mono uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
              Maturity-rule:
            </span>
            <button
              v-for="ma in safetyData.maturityAsks"
              :key="ma.id"
              type="button"
              class="sf-mono rounded-[5px] border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2 py-0.5 text-[color:var(--sf-ink)] transition-colors hover:border-[color:var(--sf-line-cobalt)]"
              @click="emit('select-ask', ma.id)"
            >
              {{ formatApr(ma.quote?.yieldBps) }} · {{ formatCompact(ma.quote?.cost) }} {{ market }}
            </button>
          </div>
        </div>
      </template>

      <!-- LENS 4: FILL HISTORY -->
      <template v-else>
        <div
          v-if="!historyData.count"
          class="relative z-10 flex h-full min-h-[224px] flex-col items-center justify-center px-6 text-center"
        >
          <div
            class="grid h-10 w-10 place-items-center rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] text-[color:var(--sf-muted)]"
          >
            <layers-icon class="h-[18px] w-[18px]" />
          </div>
          <p class="sf-display mt-2.5 text-[16px] font-semibold text-[color:var(--sf-ink)]">
            {{ historyEmptyTitle }}
          </p>
        </div>

        <div v-else class="relative z-10 h-full w-full select-none">
          <svg
            :width="plotW"
            :height="plotH"
            :viewBox="`0 0 ${plotW} ${plotH}`"
            class="block h-full w-full cursor-crosshair"
            role="img"
            :aria-label="`${market} 10-day fill history`"
            @pointermove="onHistoryMove"
            @pointerleave="historyHoverX = null"
          >
            <g
              v-for="yt in niceTicks(
                historyData.yDom[0],
                historyData.yDom[1],
                Math.max(3, Math.round(innerH / 56))
              )"
              :key="`hy-${yt}`"
            >
              <line
                :x1="MARGIN.l"
                :x2="MARGIN.l + innerW"
                :y1="histY(yt)"
                :y2="histY(yt)"
                stroke="var(--sf-line)"
                stroke-dasharray="3 5"
              />
              <text
                :x="MARGIN.l - 7"
                :y="histY(yt) + 3.5"
                text-anchor="end"
                fill="var(--sf-muted)"
                font-size="10"
                class="sf-mono"
              >
                {{ yt.toFixed(1) }}%
              </text>
            </g>

            <g v-for="xt in [-10, -7, -5, -2, 0]" :key="`hx-${xt}`">
              <line
                :x1="histX(xt)"
                :x2="histX(xt)"
                :y1="MARGIN.t"
                :y2="MARGIN.t + innerH"
                stroke="var(--sf-line)"
                stroke-opacity="0.7"
              />
              <text
                :x="histX(xt)"
                :y="plotH - 7"
                text-anchor="middle"
                fill="var(--sf-muted)"
                font-size="10"
                class="sf-mono"
              >
                {{
                  xt === 0
                    ? "now"
                    : unit === "blocks"
                      ? `−${formatCompact(-xt * DAY_BLOCKS)}`
                      : `${xt}d`
                }}
              </text>
            </g>

            <g opacity="0.28">
              <rect
                v-for="(bar, idx) in historyData.bars"
                :key="idx"
                :x="histX(bar.x - bar.w / 2)"
                :y="MARGIN.t + innerH - (bar.v / historyData.maxVol) * innerH * 0.24"
                :width="Math.max(2, histX(bar.x + bar.w / 2) - histX(bar.x - bar.w / 2) - 2)"
                :height="(bar.v / historyData.maxVol) * innerH * 0.24"
                fill="var(--sf-cobalt)"
                rx="1.5"
              />
            </g>

            <path
              v-if="histAvgPath"
              :d="histAvgPath"
              fill="none"
              stroke="var(--sf-ink)"
              stroke-width="1.8"
              stroke-linecap="round"
            />

            <circle
              v-for="dot in historyData.dots"
              :key="dot.id"
              :cx="histX(dot.x)"
              :cy="histY(dot.y)"
              :r="dot.r"
              :fill="dot.color"
              :fill-opacity="dot.opacity"
            />

            <line
              v-if="historyReadout"
              :x1="historyReadout.px"
              :x2="historyReadout.px"
              :y1="MARGIN.t"
              :y2="MARGIN.t + innerH"
              stroke="var(--sf-line-strong)"
            />
          </svg>

          <div
            v-if="historyReadout"
            class="sf-popover pointer-events-none absolute top-2.5 z-20 w-40 rounded-xl px-2.5 py-2 text-[11px]"
            :style="{ left: `${historyReadout.left}px` }"
          >
            <div class="sf-mono border-b border-[color:var(--sf-line)] pb-1 font-semibold">
              {{ historyReadout.agoText }} ago
            </div>
            <div class="sf-mono mt-1 space-y-0.5">
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Fills</span>
                <span class="font-semibold">{{ historyReadout.count }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Avg APR</span>
                <span class="font-semibold text-[color:var(--sf-bid)]">
                  {{ formatApr(historyReadout.avgApr) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Compact Legend & Inline Layer Toggles -->
    <div
      class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-3.5 py-1.5 text-[11px] text-[color:var(--sf-muted)]"
    >
      <div v-if="lens === 'curve'" class="flex flex-wrap items-center gap-3">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-[2.5px] w-3 rounded-full bg-[color:var(--sf-bid)]" />
          <span>Bid</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-[2.5px] w-3 rounded-full bg-[color:var(--sf-ask)]" />
          <span>Ask</span>
        </span>

        <button
          type="button"
          :aria-pressed="showOffers"
          class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-all"
          :class="
            showOffers
              ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="emit('update:showOffers', !showOffers)"
        >
          <span>All bids</span>
        </button>

        <button
          type="button"
          :aria-pressed="showFills"
          class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-all"
          :class="
            showFills
              ? 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
              : 'border-[color:var(--sf-line)] bg-[color:var(--sf-card)] text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
          @click="emit('update:showFills', !showFills)"
        >
          <span>10d fills</span>
        </button>
      </div>

      <div v-else-if="lens === 'matrix'" class="flex items-center gap-3">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-bid)]" />
          <span>Bid / Offers</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-ask)]" />
          <span>Ask / Demand</span>
        </span>
      </div>

      <div v-else-if="lens === 'safety'" class="flex items-center gap-3">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-ask)]" />
          <span>New loan</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-cobalt)]" />
          <span>Resale</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-bid)]" />
          <span>Shares</span>
        </span>
      </div>

      <div v-else class="flex items-center gap-3">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-bid)]" />
          <span>New</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-ask)]" />
          <span>Resale / Shares</span>
        </span>
      </div>

      <span v-if="curves" class="sf-mono text-[10px] text-[color:var(--sf-dim)]">
        {{ curves.searched.bids }}/{{ curves.searched.bidTotal }}b ·
        {{ curves.searched.asks }}/{{ curves.searched.askTotal }}a
      </span>
    </div>
  </section>
</template>

<style scoped>
.plot-bloom {
  background:
    radial-gradient(
      ellipse 55% 45% at 78% 12%,
      rgba(var(--sf-cobalt-rgb), 0.08),
      transparent 72%
    ),
    radial-gradient(
      ellipse 45% 42% at 20% 85%,
      rgba(var(--sf-bid-rgb), 0.06),
      transparent 72%
    );
}

.curve-glow-bid {
  filter: drop-shadow(0 0 6px var(--sf-bid-glow));
}

.curve-glow-ask {
  filter: drop-shadow(0 0 5px var(--sf-ask-glow));
}

.ask-dot-node circle {
  transition:
    r 0.18s var(--sf-spring),
    fill-opacity 0.16s ease;
}

.matrix-cell:active {
  transform: scale(0.985);
}
</style>

<style>
/* Light mode: crisp matching precision ring around selected ask dots instead of thick cobalt halo */
.sf-rb-ask-dot.is-selected .sf-rb-dot-halo,
.sf-rb-safety-dot.is-selected .sf-rb-dot-halo {
  fill: var(--dot-tone);
  fill-opacity: 0.1;
  stroke: var(--dot-tone);
  stroke-width: 1.35;
  stroke-opacity: 0.88;
}

/* Dark mode: preserve the luminous cobalt reticle highlight unchanged */
:root[data-theme="dark"] .sf-rb-ask-dot.is-selected .sf-rb-dot-halo {
  fill: var(--sf-cobalt);
  fill-opacity: 0.24;
  stroke: none;
}

:root[data-theme="dark"] .sf-rb-ask-dot.is-selected .sf-rb-dot-core {
  fill: var(--sf-card);
  stroke: var(--sf-cobalt);
  stroke-width: 2.1;
}

:root[data-theme="dark"] .sf-rb-safety-dot.is-selected .sf-rb-dot-halo {
  fill: var(--sf-cobalt);
  fill-opacity: 0.22;
  stroke: none;
}

:root[data-theme="dark"] .sf-rb-safety-dot.is-selected .sf-rb-dot-core {
  stroke: var(--sf-ink);
  stroke-width: 2;
}
</style>
