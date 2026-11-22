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
  ZcOfferSummary
} from "@/types/zc";
import {
  bandFor,
  bestAskAt,
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

const LENSES: { key: RateBookLens; label: string; subtitle: string }[] = [
  { key: "curve", label: "Term Curve", subtitle: "Bid & ask yield envelopes" },
  { key: "matrix", label: "Term Ladder", subtitle: "Maturity bucket spreads" },
  { key: "safety", label: "Risk Map", subtitle: "Cover vs APR scatter" },
  { key: "history", label: "Fills", subtitle: "10-day executions" }
];

/* ============================================================
   Responsive SVG Container Sizing
   ============================================================ */
const plotWrapRef = ref<HTMLElement | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);
const plotW = ref(680);
const PLOT_H = 368;
const MARGIN = { l: 48, r: 16, t: 16, b: 30 };

let ro: ResizeObserver | null = null;
onMounted(() => {
  if (plotWrapRef.value && "ResizeObserver" in window) {
    ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w >= 260) plotW.value = w;
    });
    ro.observe(plotWrapRef.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());

const innerW = computed(() => Math.max(120, plotW.value - MARGIN.l - MARGIN.r));
const innerH = computed(() => PLOT_H - MARGIN.t - MARGIN.b);

/* ============================================================
   Shared Curve & Domain Calculations
   ============================================================ */
const askById = computed(() => new Map(props.asks.map((a) => [a.id, a])));
const windows = computed(() => visibleWindows(props.curves));
const windowIds = computed(() => new Set(windows.value.map((w) => w.id)));
const bandBlocks = computed(() => bandFor(props.targetBlocks));

const maxDomainDays = computed(() => Math.max(30, (props.curves?.domain?.[1] || YEAR_BLOCKS) / DAY_BLOCKS));

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

const askEnvelopePoints = computed(() => {
  const c = props.curves;
  if (!c) return [] as { x: number; y: number | null }[];
  const nonWin = c.askLine.filter((p) => !p.id || !windowIds.value.has(p.id));
  if (!windows.value.length) {
    return nonWin.map((p) => ({ x: p.d / DAY_BLOCKS, y: p.y == null ? null : p.y / 100 }));
  }
  const xs = new Set<number>(nonWin.map((p) => p.d));
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
      const bps = bestAskAt(c, d, askById.value, props.height);
      return { x: d / DAY_BLOCKS, y: bps == null ? null : bps / 100 };
    });
});

const crossedSamples = computed(() => {
  const c = props.curves;
  if (!c) return { upper: [] as { x: number; y: number | null }[], lower: [] as { x: number; y: number | null }[] };
  const lower = bidPoints.value.map((p) => ({ x: p.x, y: p.y }));
  const upper = bidPoints.value.map((p) => {
    const bps = bestAskAt(c, p.d, askById.value, props.height);
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
    const baseR = 2.8 + Math.sqrt(cost / maxCost) * 1.4;
    return {
      id: dot.id,
      x: dot.d / DAY_BLOCKS,
      y: dot.y / 100,
      bps: dot.y,
      d: dot.d,
      cost,
      r: dot.id === props.selectedId ? 5 : baseR,
      active,
      kind: full?.kind || "order"
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
      opacity: Math.max(0.16, 0.65 - (Math.max(0, props.height - f.height) / 7200) * 0.48),
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
let panState: { startX: number; startY: number; dom: { x: [number, number]; y: [number, number] }; moved: boolean } | null = null;

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
  const same = Math.abs(nextX[1] - nextX[0] - baseSpanX) < baseSpanX * 1e-4 && Math.abs(nextY[1] - nextY[0] - baseSpanY) < baseSpanY * 1e-4;
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
  return niceTicks(y0, y1, 5);
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

const curveHoverReadout = computed(() => {
  if (hoverX.value == null || !props.curves) return null;
  const blocks = Math.max(DAY_BLOCKS, Math.round(hoverX.value * DAY_BLOCKS));
  const bidBps = lineAt(props.curves.bidLine, blocks);
  const askBps = bestAskAt(props.curves, blocks, askById.value, props.height);
  const spread = bidBps != null && askBps != null ? bidBps - askBps : null;
  const refBps = askBps ?? bidBps;
  const parPct = refBps != null ? 100 / (1 + (refBps / 10_000) * (blocks / YEAR_BLOCKS)) : null;
  const px = sx(hoverX.value);
  const flip = px > plotW.value - 220;
  return {
    blocks,
    px,
    left: flip ? Math.max(MARGIN.l + 8, px - 210) : Math.min(plotW.value - 208, px + 14),
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
    Y: ((e.clientY - r.top) / (r.height || 1)) * PLOT_H
  };
}

function inPlot(X: number, Y: number) {
  return X >= MARGIN.l && X <= MARGIN.l + innerW.value && Y >= MARGIN.t && Y <= MARGIN.t + innerH.value;
}

function onCurvePointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const { X, Y } = pointerSvgCoords(e);
  if (!inPlot(X, Y)) return;
  panState = {
    startX: X,
    startY: Y,
    dom: { x: [...activeDom.value.x] as [number, number], y: [...activeDom.value.y] as [number, number] },
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
   LENS 2: Term Ladder Heatmap Matrix (Out-of-the-Box View!)
   ============================================================ */
const BUCKETS = [
  { key: "7d", label: "1 – 7d", loDays: 1, hiDays: 7, pickDays: 7 },
  { key: "30d", label: "7 – 30d", loDays: 7, hiDays: 30, pickDays: 30 },
  { key: "60d", label: "30 – 60d", loDays: 30, hiDays: 60, pickDays: 60 },
  { key: "90d", label: "60 – 90d", loDays: 60, hiDays: 90, pickDays: 90 },
  { key: "180d", label: "90 – 180d", loDays: 90, hiDays: 180, pickDays: 180 },
  { key: "365d", label: "180d – 1y", loDays: 180, hiDays: 365, pickDays: 365 }
] as const;

const ladderRows = computed(() => {
  const c = props.curves;
  const rows = BUCKETS.map((b) => {
    const lo = b.loDays * DAY_BLOCKS;
    const hi = b.hiDays * DAY_BLOCKS;
    const mid = Math.round((lo + hi) / 2);

    // Best bid in bucket (lowest min APR across sample points)
    let bestBid: number | null = null;
    if (c) {
      for (const sampleD of [lo, mid, hi]) {
        const y = lineAt(c.bidLine, sampleD);
        if (y != null && (bestBid == null || y < bestBid)) bestBid = y;
      }
    }

    // Best ask in bucket (highest APR from asks/dots/windows falling in bucket)
    let bestAsk: number | null = null;
    let askCost = 0;
    let askCount = 0;
    for (const a of props.asks) {
      if (a.pricing === "window" && a.window) {
        if (a.window.max >= lo && a.window.min <= hi) {
          askCount += 1;
          const clampedMid = Math.min(a.window.max, Math.max(a.window.min, mid));
          const q = resolvedAskQuote(a, props.height, clampedMid);
          if (q) {
            askCost += q.cost;
            if (bestAsk == null || q.yieldBps > bestAsk) bestAsk = q.yieldBps;
          }
        }
      } else if (a.quote && a.quote.d >= lo && a.quote.d <= hi) {
        askCount += 1;
        askCost += a.quote.cost;
        if (bestAsk == null || a.quote.yieldBps > bestAsk) bestAsk = a.quote.yieldBps;
      }
    }
    if (bestAsk == null && c) {
      for (const sampleD of [lo, mid, hi]) {
        const y = bestAskAt(c, sampleD, askById.value, props.height);
        if (y != null && (bestAsk == null || y > bestAsk)) bestAsk = y;
      }
    }

    // Offers covering this bucket
    let offerCap = 0;
    let offerCount = 0;
    for (const o of props.offers) {
      if (o.maxBlocks >= lo && o.minBlocks <= hi) {
        offerCount += 1;
        offerCap += o.capital;
      }
    }

    const spread = bestBid != null && bestAsk != null ? bestBid - bestAsk : null;
    const crossed = spread != null && spread <= 0;
    const refBps = bestAsk ?? bestBid;
    const parPct = refBps != null ? 100 / (1 + (refBps / 10_000) * (mid / YEAR_BLOCKS)) : null;
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
   LENS 3: Collateral Safety Landscape (Cover vs APR Scatter!)
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
  const yDom = niceDomain(pts.map((p) => p.apr), 0.2, true);
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
const safetyYTicks = computed(() => niceTicks(safetyData.value.yDom[0], safetyData.value.yDom[1], 5));

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
    opacity: inSel(f.d) ? 0.9 : 0.3
  }));
  const yDom = niceDomain(fills.map((f) => f.yieldBps / 100), 0.16, true);
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
    left: px > plotW.value - 190 ? Math.max(MARGIN.l + 8, px - 180) : px + 12,
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
  if (props.fillsStatus === "not-configured") return "Fill history indexing not enabled on node";
  if (props.fillsStatus === "disabled") return "Fill history disabled";
  return "No recent fills in the last 10 days";
});
</script>

<template>
  <section class="sf-plate flex h-full flex-col overflow-hidden rounded-2xl">
    <!-- Top Lens Bar -->
    <div
      class="flex flex-wrap items-center justify-between gap-2.5 border-b border-[color:var(--sf-line)] px-4 py-2.5 sm:px-5"
    >
      <div
        class="inline-flex flex-wrap rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
        role="tablist"
        aria-label="Rate Book view lens"
      >
        <button
          v-for="item in LENSES"
          :key="item.key"
          type="button"
          role="tab"
          :aria-selected="lens === item.key"
          :title="item.subtitle"
          class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-all"
          :class="
            lens === item.key
              ? 'bg-[color:var(--sf-card)] text-[color:var(--sf-ink)] shadow-sm ring-1 ring-slate-900/10'
              : 'text-[color:var(--sf-muted)] hover:text-[color:var(--sf-ink)]'
          "
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
          class="sf-mono rounded bg-cobalt-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-cobalt-700"
        >
          {{ zoomLevel.toFixed(1) }}×
        </span>
        <div
          class="inline-flex items-center rounded-lg border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] p-0.5"
          role="group"
          aria-label="Chart zoom"
        >
          <button
            type="button"
            class="grid h-6 w-6 place-items-center rounded text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-card)] hover:text-[color:var(--sf-ink)]"
            title="Zoom out (Ctrl + scroll)"
            aria-label="Zoom out"
            @click="zoomBy(1 / ZOOM_STEP)"
          >
            <minus-icon class="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            class="grid h-6 w-6 place-items-center rounded text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-card)] hover:text-[color:var(--sf-ink)]"
            title="Zoom in (Ctrl + scroll)"
            aria-label="Zoom in"
            @click="zoomBy(ZOOM_STEP)"
          >
            <plus-icon class="h-3.5 w-3.5" />
          </button>
          <button
            v-if="isZoomed"
            type="button"
            class="grid h-6 w-6 place-items-center rounded text-cobalt-600 hover:bg-[color:var(--sf-card)]"
            title="Reset zoom"
            aria-label="Reset zoom"
            @click="zoomView = null"
          >
            <rotate-ccw-icon class="h-3 w-3" />
          </button>
        </div>
      </div>

      <div
        v-else-if="lens === 'matrix'"
        class="sf-mono text-[11px] text-[color:var(--sf-muted)]"
      >
        Click a tenor bucket to focus
      </div>

      <div
        v-else-if="lens === 'safety'"
        class="sf-mono text-[11px] text-[color:var(--sf-muted)]"
      >
        Cover ≥ {{ coverage }}% · bubble size = capital
      </div>

      <div v-else class="sf-mono text-[11px] text-[color:var(--sf-muted)]">
        Last {{ formatDur(historySpanBlocks, unit) }} · {{ historyData.count }} fills
      </div>
    </div>

    <!-- ======================================================
         MAIN STAGE BODY
         ====================================================== -->
    <div ref="plotWrapRef" class="relative flex-1 bg-[color:var(--sf-card)]">
      <!-- LENS 1: TERM CURVE -->
      <template v-if="lens === 'curve'">
        <div v-if="curveEmpty" class="flex h-[368px] flex-col items-center justify-center px-6 text-center">
          <div
            class="grid h-11 w-11 place-items-center rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] text-[color:var(--sf-muted)]"
          >
            <activity-icon class="h-5 w-5" />
          </div>
          <p class="sf-serif mt-3 text-[18px] font-medium text-[color:var(--sf-ink)]">
            {{ connected ? `No ${market} orders match these filters` : "Connect to Lithos feed" }}
          </p>
          <p class="mt-1 max-w-sm text-[12.5px] text-[color:var(--sf-muted)]">
            {{
              connected
                ? `Try lowering minimum cover below ${coverage}%, toggling off Matchable only, or switching markets.`
                : "Start the local Lithos client or set a feed URL in the top bar to stream live zero-coupon curves."
            }}
          </p>
        </div>

        <div v-else class="relative select-none" :style="{ height: `${PLOT_H}px` }">
          <svg
            ref="svgRef"
            :width="plotW"
            :height="PLOT_H"
            :viewBox="`0 0 ${plotW} ${PLOT_H}`"
            class="block h-full w-full"
            :class="isZoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'"
            role="img"
            :aria-label="`${market} yield curve`"
            @pointerdown="onCurvePointerDown"
            @pointermove="onCurvePointerMove"
            @pointerup="onCurvePointerUp"
            @pointercancel="onCurvePointerUp"
            @pointerleave="hoverX = null; hoveredOfferId = null"
            @wheel="onCurveWheel"
          >
            <defs>
              <clipPath id="sfCurvePlotClip">
                <rect
                  :x="MARGIN.l"
                  :y="MARGIN.t - 4"
                  :width="innerW"
                  :height="innerH + 8"
                />
              </clipPath>
              <linearGradient id="sfRbBidGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--sf-bid)" stop-opacity="0.16" />
                <stop offset="100%" stop-color="var(--sf-bid)" stop-opacity="0.0" />
              </linearGradient>
              <pattern
                id="sfCrossHatch"
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="6" height="6" fill="var(--sf-ask)" fill-opacity="0.11" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--sf-ask)" stroke-opacity="0.32" stroke-width="1.5" />
              </pattern>
            </defs>

            <!-- Grid -->
            <g>
              <g v-for="yt in curveYTicks" :key="`y-${yt}`">
                <line
                  :x1="MARGIN.l"
                  :x2="MARGIN.l + innerW"
                  :y1="sy(yt)"
                  :y2="sy(yt)"
                  :stroke="yt === 0 ? 'var(--sf-line-strong)' : 'var(--sf-line)'"
                  :stroke-dasharray="yt === 0 ? undefined : '3 4'"
                />
                <text
                  :x="MARGIN.l - 8"
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
                />
                <text
                  :x="sx(xt)"
                  :y="PLOT_H - 9"
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
                fill="var(--sf-cobalt)"
                fill-opacity="0.065"
              />

              <!-- Crossed Market Hatch Ribbon -->
              <path v-if="crossAreaD" :d="crossAreaD" fill="url(#sfCrossHatch)" />

              <!-- Individual Bid Curves Overlay -->
              <g v-if="showOffers">
                <path
                  v-for="fil in offerFilaments"
                  :key="fil.id"
                  :d="buildSegmentedPath(fil.pts)"
                  fill="none"
                  stroke="var(--sf-bid)"
                  :stroke-width="hoveredOfferId === fil.id || selectedId === fil.id ? 2 : 1"
                  :stroke-opacity="
                    hoveredOfferId === fil.id || selectedId === fil.id ? 0.85 : fil.ok ? 0.24 : 0.1
                  "
                  class="cursor-pointer transition-opacity"
                  @pointerenter="hoveredOfferId = fil.id"
                  @pointerleave="hoveredOfferId = null"
                  @pointerdown.stop
                  @click.stop="emit('select-bid', fil.id)"
                />
              </g>

              <!-- Window Order Curves -->
              <g v-for="wc in windowCurvesData" :key="`win-${wc.id}`">
                <path
                  :d="buildSegmentedPath(wc.pts)"
                  fill="none"
                  stroke="var(--sf-ask)"
                  :stroke-width="selectedId === wc.id ? 2.6 : 1.45"
                  stroke-dasharray="5 3"
                  :stroke-opacity="selectedId === wc.id ? 1 : 0.65"
                  class="cursor-pointer"
                  @pointerdown.stop
                  @click.stop="emit('select-ask', wc.id)"
                />
              </g>

              <!-- 10d Fills Scatter -->
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

              <!-- Best Bid Envelope -->
              <path v-if="bidAreaD" :d="bidAreaD" fill="url(#sfRbBidGrad)" />
              <path
                v-if="bidLineD"
                :d="bidLineD"
                fill="none"
                stroke="var(--sf-bid)"
                stroke-width="2.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />

              <!-- Best Ask Envelope -->
              <path
                v-if="askLineD"
                :d="askLineD"
                fill="none"
                stroke="var(--sf-ask)"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />

              <!-- Size-Scaled Clickable Ask Nodes -->
              <g
                v-for="dot in askDotsData"
                :key="dot.id"
                class="cursor-pointer"
                @pointerenter="hoveredAskId = dot.id"
                @pointerleave="hoveredAskId = null"
                @pointerdown.stop
                @click.stop="emit('select-ask', dot.id)"
              >
                <circle :cx="sx(dot.x)" :cy="sy(dot.y)" r="10" fill="transparent" />
                <circle
                  v-if="selectedId === dot.id || hoveredAskId === dot.id"
                  :cx="sx(dot.x)"
                  :cy="sy(dot.y)"
                  :r="dot.r + 2.5"
                  :fill="selectedId === dot.id ? 'var(--sf-cobalt)' : 'var(--sf-ask)'"
                  :fill-opacity="selectedId === dot.id ? 0.2 : 0.16"
                />
                <circle
                  :cx="sx(dot.x)"
                  :cy="sy(dot.y)"
                  :r="dot.r"
                  :fill="
                    selectedId === dot.id
                      ? 'var(--sf-card)'
                      : dot.active
                        ? 'var(--sf-ask)'
                        : 'var(--sf-card)'
                  "
                  :stroke="selectedId === dot.id ? 'var(--sf-cobalt)' : dot.active ? 'var(--sf-card)' : 'var(--sf-ask)'"
                  :stroke-width="selectedId === dot.id ? 1.8 : 1.3"
                >
                  <title>
                    {{ kindLabel(dot.kind) }} · {{ formatApr(dot.bps) }} ·
                    {{ formatDur(dot.d, unit) }} · {{ formatMarketAmount(dot.cost, market) }}
                  </title>
                </circle>
              </g>

              <!-- Active Maturity Cursor Line -->
              <g v-if="cursorXDays >= activeDom.x[0] && cursorXDays <= activeDom.x[1]">
                <line
                  :x1="sx(cursorXDays)"
                  :x2="sx(cursorXDays)"
                  :y1="MARGIN.t"
                  :y2="MARGIN.t + innerH"
                  stroke="var(--sf-cobalt)"
                  stroke-width="1.2"
                  stroke-dasharray="3 3"
                  stroke-opacity="0.8"
                />
                <text
                  :x="sx(cursorXDays) > MARGIN.l + innerW - 76 ? sx(cursorXDays) - 6 : sx(cursorXDays) + 6"
                  :y="MARGIN.t + 12"
                  :text-anchor="sx(cursorXDays) > MARGIN.l + innerW - 76 ? 'end' : 'start'"
                  fill="var(--sf-cobalt)"
                  font-size="10.5"
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
                r="3.5"
                fill="var(--sf-bid)"
                stroke="var(--sf-card)"
                stroke-width="1.5"
              />
              <circle
                v-if="curveHoverReadout.askBps != null"
                :cx="curveHoverReadout.px"
                :cy="sy(curveHoverReadout.askBps / 100)"
                r="3.5"
                fill="var(--sf-ask)"
                stroke="var(--sf-card)"
                stroke-width="1.5"
              />
            </g>
          </svg>

          <!-- Floating Crosshair Telemetry Card -->
          <div
            v-if="curveHoverReadout"
            class="sf-plate pointer-events-none absolute top-3 z-20 w-48 rounded-xl px-3 py-2.5 text-[11px]"
            :style="{ left: `${curveHoverReadout.left}px` }"
          >
            <div class="sf-mono flex items-center justify-between border-b border-[color:var(--sf-line)] pb-1.5 font-semibold text-[color:var(--sf-ink)]">
              <span>{{ formatDur(curveHoverReadout.blocks, unit) }}</span>
              <span class="font-normal text-[color:var(--sf-muted)]">
                {{ dateAtHeight(height + curveHoverReadout.blocks, height) }}
              </span>
            </div>
            <div class="sf-mono mt-1.5 space-y-1">
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Best bid</span>
                <span class="font-semibold text-[color:var(--sf-bid)]">
                  {{ formatApr(curveHoverReadout.bidBps) }}
                </span>
              </div>
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Best ask</span>
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
                <span class="font-semibold text-cobalt-600">
                  {{ curveHoverReadout.parPct != null ? `${curveHoverReadout.parPct.toFixed(2)}%` : "—" }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- LENS 2: TERM LADDER HEATMAP MATRIX (OUT-OF-THE-BOX VIEW!) -->
      <template v-else-if="lens === 'matrix'">
        <div class="min-h-[368px] p-4 sm:p-5">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <button
              v-for="row in ladderRows.rows"
              :key="row.key"
              type="button"
              class="group relative flex flex-col justify-between rounded-xl border p-3.5 text-left transition-all"
              :class="
                row.selected
                  ? 'border-cobalt-600/45 bg-cobalt-50/40 shadow-sm'
                  : 'border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] hover:border-[color:var(--sf-line-strong)] hover:bg-[color:var(--sf-well)]'
              "
              @click="emit('update:targetBlocks', row.pickDays * DAY_BLOCKS)"
            >
              <!-- Bucket Header -->
              <div class="flex items-center justify-between gap-2">
                <span class="sf-serif text-[17px] font-semibold text-[color:var(--sf-ink)]">
                  {{
                    unit === "blocks"
                      ? `${formatDur(row.lo, "blocks").replace(" blk", "")}–${formatDur(row.hi, "blocks")}`
                      : row.label
                  }}
                </span>
                <span
                  v-if="row.crossed"
                  class="sf-mono rounded bg-[color:var(--sf-ask-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-ask)]"
                >
                  Crossed
                </span>
                <span
                  v-else-if="row.spread != null"
                  class="sf-mono text-[10.5px] text-[color:var(--sf-muted)]"
                >
                  {{ formatBp(row.spread) }}
                </span>
                <span v-else class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]"> — </span>
              </div>

              <!-- Shared-Scale APR Gauge -->
              <div class="mt-3">
                <div class="relative h-5 rounded-md bg-[color:var(--sf-card)] px-2 ring-1 ring-[color:var(--sf-line)]">
                  <div class="absolute inset-x-2 top-1/2 h-[2px] -translate-y-1/2 rounded bg-[color:var(--sf-line-strong)]" />
                  <!-- Spread Connector Segment -->
                  <div
                    v-if="row.bestBid != null && row.bestAsk != null"
                    class="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
                    :style="{
                      left: `calc(8px + ${(Math.min(row.bestBid, row.bestAsk) / ladderRows.maxBps) * 84}%)`,
                      width: `max(4px, ${(Math.abs(row.bestAsk - row.bestBid) / ladderRows.maxBps) * 84}%)`,
                      background: row.crossed ? 'var(--sf-ask)' : 'var(--sf-cobalt)',
                      opacity: row.crossed ? 0.55 : 0.35
                    }"
                  />
                  <!-- Bid Anchor Dot -->
                  <span
                    v-if="row.bestBid != null"
                    class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--sf-card)] bg-[color:var(--sf-bid)]"
                    :style="{ left: `calc(8px + ${(row.bestBid / ladderRows.maxBps) * 84}%)` }"
                    :title="`Best Bid ${formatApr(row.bestBid)}`"
                  />
                  <!-- Ask Anchor Dot -->
                  <span
                    v-if="row.bestAsk != null"
                    class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--sf-card)] bg-[color:var(--sf-ask)]"
                    :style="{ left: `calc(8px + ${(row.bestAsk / ladderRows.maxBps) * 84}%)` }"
                    :title="`Best Ask ${formatApr(row.bestAsk)}`"
                  />
                </div>

                <div class="sf-mono mt-2 flex items-center justify-between text-[12px]">
                  <div>
                    <span class="block text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                      Bid
                    </span>
                    <span class="font-semibold text-[color:var(--sf-bid)]">
                      {{ formatApr(row.bestBid) }}
                    </span>
                  </div>
                  <div class="text-center">
                    <span class="block text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                      Par
                    </span>
                    <span class="font-medium text-cobalt-600">
                      {{ row.parPct != null ? `${row.parPct.toFixed(1)}%` : "—" }}
                    </span>
                  </div>
                  <div class="text-right">
                    <span class="block text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--sf-muted)]">
                      Ask
                    </span>
                    <span class="font-semibold text-[color:var(--sf-ask)]">
                      {{ formatApr(row.bestAsk) }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Liquidity Balance Strip -->
              <div class="mt-3 border-t border-[color:var(--sf-line)] pt-2.5">
                <div class="flex h-1.5 overflow-hidden rounded-full bg-[color:var(--sf-line)]">
                  <div
                    class="h-full bg-[color:var(--sf-bid)] transition-all"
                    :style="{ width: `${(row.offerCap / ladderRows.maxLiq) * 100}%` }"
                  />
                  <div
                    class="h-full bg-[color:var(--sf-ask)] transition-all"
                    :style="{ width: `${(row.askCost / ladderRows.maxLiq) * 100}%` }"
                  />
                </div>
                <div class="sf-mono mt-1.5 flex items-center justify-between text-[10.5px] text-[color:var(--sf-muted)]">
                  <span>{{ formatCompact(row.offerCap) }} {{ market }} ({{ row.offerCount }}b)</span>
                  <span>{{ formatCompact(row.askCost) }} {{ market }} ({{ row.askCount }}a)</span>
                </div>
              </div>
            </button>
          </div>
        </div>
      </template>

      <!-- LENS 3: COLLATERAL SAFETY LANDSCAPE (COVER × APR SCATTER!) -->
      <template v-else-if="lens === 'safety'">
        <div
          v-if="!safetyData.pts.length && !safetyData.maturityAsks.length"
          class="flex h-[368px] flex-col items-center justify-center px-6 text-center"
        >
          <div
            class="grid h-11 w-11 place-items-center rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] text-[color:var(--sf-muted)]"
          >
            <shield-icon class="h-5 w-5" />
          </div>
          <p class="sf-serif mt-3 text-[18px] font-medium text-[color:var(--sf-ink)]">
            No open {{ market }} asks to plot
          </p>
          <p class="mt-1 text-[12.5px] text-[color:var(--sf-muted)]">
            Every open ask appears here mapped by its collateral coverage ratio against offered APR.
          </p>
        </div>

        <div v-else class="relative">
          <svg
            :width="plotW"
            :height="PLOT_H"
            :viewBox="`0 0 ${plotW} ${PLOT_H}`"
            class="block w-full select-none"
            role="img"
            :aria-label="`${market} collateral cover vs APR risk map`"
          >
            <!-- Below-filter zone tint -->
            <rect
              :x="MARGIN.l"
              :y="MARGIN.t"
              :width="Math.max(0, safetyX(coverage) - MARGIN.l)"
              :height="innerH"
              fill="var(--sf-ask)"
              fill-opacity="0.045"
            />

            <!-- Horizontal Y Grid (APR) -->
            <g v-for="yt in safetyYTicks" :key="`sy-${yt}`">
              <line
                :x1="MARGIN.l"
                :x2="MARGIN.l + innerW"
                :y1="safetyY(yt)"
                :y2="safetyY(yt)"
                :stroke="yt === 0 ? 'var(--sf-line-strong)' : 'var(--sf-line)'"
                :stroke-dasharray="yt === 0 ? undefined : '3 4'"
              />
              <text
                :x="MARGIN.l - 8"
                :y="safetyY(yt) + 3.5"
                text-anchor="end"
                fill="var(--sf-muted)"
                font-size="10"
                class="sf-mono"
              >
                {{ yt.toFixed(0) }}%
              </text>
            </g>

            <!-- Vertical X Grid (Cover %) -->
            <g v-for="xt in safetyXTicks" :key="`sx-${xt}`">
              <line
                :x1="safetyX(xt)"
                :x2="safetyX(xt)"
                :y1="MARGIN.t"
                :y2="MARGIN.t + innerH"
                stroke="var(--sf-line)"
              />
              <text
                :x="safetyX(xt)"
                :y="PLOT_H - 9"
                text-anchor="middle"
                fill="var(--sf-muted)"
                font-size="10"
                class="sf-mono"
              >
                {{ xt }}%
              </text>
            </g>

            <!-- Min Floor 125% Line -->
            <line
              :x1="safetyX(MIN_COVER)"
              :x2="safetyX(MIN_COVER)"
              :y1="MARGIN.t"
              :y2="MARGIN.t + innerH"
              stroke="var(--sf-danger)"
              stroke-dasharray="2 4"
              stroke-opacity="0.5"
            />

            <!-- Active Cover Filter Line -->
            <g>
              <line
                :x1="safetyX(coverage)"
                :x2="safetyX(coverage)"
                :y1="MARGIN.t"
                :y2="MARGIN.t + innerH"
                stroke="var(--sf-cobalt)"
                stroke-width="1.4"
                stroke-dasharray="4 3"
              />
              <text
                :x="safetyX(coverage) + 6"
                :y="MARGIN.t + 12"
                fill="var(--sf-cobalt)"
                font-size="10"
                font-weight="600"
                class="sf-mono"
              >
                Filter ≥ {{ coverage }}%
              </text>
            </g>

            <!-- Reference Best Bid Line -->
            <g v-if="safetyData.refBidBps != null">
              <line
                :x1="MARGIN.l"
                :x2="MARGIN.l + innerW"
                :y1="safetyY(safetyData.refBidBps / 100)"
                :y2="safetyY(safetyData.refBidBps / 100)"
                stroke="var(--sf-bid)"
                stroke-width="1.2"
                stroke-dasharray="5 4"
              />
              <text
                :x="MARGIN.l + innerW - 6"
                :y="safetyY(safetyData.refBidBps / 100) - 5"
                text-anchor="end"
                fill="var(--sf-bid)"
                font-size="10"
                font-weight="600"
                class="sf-mono"
              >
                Best bid {{ formatApr(safetyData.refBidBps) }}
              </text>
            </g>

            <!-- Bubbles -->
            <g
              v-for="pt in safetyData.pts"
              :key="pt.id"
              class="cursor-pointer"
              @pointerenter="hoveredSafetyId = pt.id"
              @pointerleave="hoveredSafetyId = null"
              @click="emit('select-ask', pt.id)"
            >
              <circle :cx="safetyX(pt.cov)" :cy="safetyY(pt.apr)" r="11" fill="transparent" />
              <circle
                v-if="selectedId === pt.id || hoveredSafetyId === pt.id"
                :cx="safetyX(pt.cov)"
                :cy="safetyY(pt.apr)"
                :r="pt.r + 2.5"
                :fill="selectedId === pt.id ? 'var(--sf-cobalt)' : kindColor(pt.kind)"
                fill-opacity="0.2"
              />
              <circle
                :cx="safetyX(pt.cov)"
                :cy="safetyY(pt.apr)"
                :r="pt.r"
                :fill="pt.ok ? kindColor(pt.kind) : 'var(--sf-card)'"
                :stroke="
                  selectedId === pt.id
                    ? 'var(--sf-ink)'
                    : pt.ok
                      ? 'var(--sf-card)'
                      : kindColor(pt.kind)
                "
                :stroke-width="selectedId === pt.id ? 1.8 : 1.3"
                fill-opacity="0.9"
              />
            </g>
          </svg>

          <!-- Floating Hover Info -->
          <div
            v-if="hoveredSafetyPoint"
            class="sf-plate pointer-events-none absolute right-4 top-4 z-20 w-52 rounded-xl px-3 py-2.5 text-[11px]"
          >
            <div class="sf-mono flex items-center justify-between border-b border-[color:var(--sf-line)] pb-1.5 font-semibold text-[color:var(--sf-ink)]">
              <span>{{ kindLabel(hoveredSafetyPoint.kind) }}</span>
              <span class="text-[color:var(--sf-ask)]">{{ formatApr(hoveredSafetyPoint.yieldBps) }}</span>
            </div>
            <div class="sf-mono mt-1.5 space-y-1">
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Cover now</span>
                <span class="font-semibold text-[color:var(--sf-bid)]">
                  {{ Math.round(hoveredSafetyPoint.cov) }}%
                </span>
              </div>
              <div v-if="hoveredSafetyPoint.ratio" class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Liquidates</span>
                <span>&lt; {{ hoveredSafetyPoint.ratio }}%</span>
              </div>
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Size</span>
                <span>{{ formatMarketAmount(hoveredSafetyPoint.cost, market) }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-[color:var(--sf-muted)]">Maturity</span>
                <span>{{ formatDur(hoveredSafetyPoint.d, unit) }}</span>
              </div>
            </div>
          </div>

          <!-- Maturity-rule asks strip (if any) -->
          <div
            v-if="safetyData.maturityAsks.length"
            class="flex flex-wrap items-center gap-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-4 py-2 text-[11px]"
          >
            <span class="sf-mono uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
              Maturity-rule asks:
            </span>
            <button
              v-for="ma in safetyData.maturityAsks"
              :key="ma.id"
              type="button"
              class="sf-mono rounded-md border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-2 py-0.5 text-[color:var(--sf-ink)] hover:border-cobalt-600"
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
          class="flex h-[368px] flex-col items-center justify-center px-6 text-center"
        >
          <div
            class="grid h-11 w-11 place-items-center rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well)] text-[color:var(--sf-muted)]"
          >
            <layers-icon class="h-5 w-5" />
          </div>
          <p class="sf-serif mt-3 text-[18px] font-medium text-[color:var(--sf-ink)]">
            {{ historyEmptyTitle }}
          </p>
          <p class="mt-1 max-w-sm text-[12.5px] text-[color:var(--sf-muted)]">
            Confirmed bond executions over the last 10 days plot here with volume histograms and
            rolling maturity-weighted APR.
          </p>
        </div>

        <div v-else class="relative select-none" :style="{ height: `${PLOT_H}px` }">
          <svg
            :width="plotW"
            :height="PLOT_H"
            :viewBox="`0 0 ${plotW} ${PLOT_H}`"
            class="block h-full w-full cursor-crosshair"
            role="img"
            :aria-label="`${market} 10-day fill history`"
            @pointermove="onHistoryMove"
            @pointerleave="historyHoverX = null"
          >
            <g v-for="yt in niceTicks(historyData.yDom[0], historyData.yDom[1], 5)" :key="`hy-${yt}`">
              <line
                :x1="MARGIN.l"
                :x2="MARGIN.l + innerW"
                :y1="histY(yt)"
                :y2="histY(yt)"
                stroke="var(--sf-line)"
                stroke-dasharray="3 4"
              />
              <text
                :x="MARGIN.l - 8"
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
              />
              <text
                :x="histX(xt)"
                :y="PLOT_H - 9"
                text-anchor="middle"
                fill="var(--sf-muted)"
                font-size="10"
                class="sf-mono"
              >
                {{ xt === 0 ? "now" : unit === "blocks" ? `−${formatCompact(-xt * DAY_BLOCKS)}` : `${xt}d` }}
              </text>
            </g>

            <!-- Volume Histogram -->
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

            <!-- Weighted Avg Line -->
            <path
              v-if="histAvgPath"
              :d="histAvgPath"
              fill="none"
              stroke="var(--sf-ink)"
              stroke-width="1.8"
              stroke-linecap="round"
            />

            <!-- Fill Dots -->
            <circle
              v-for="dot in historyData.dots"
              :key="dot.id"
              :cx="histX(dot.x)"
              :cy="histY(dot.y)"
              :r="dot.r"
              :fill="dot.color"
              :fill-opacity="dot.opacity"
            />

            <!-- Hover Line -->
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
            class="sf-plate pointer-events-none absolute top-3 z-20 w-44 rounded-xl px-3 py-2 text-[11px]"
            :style="{ left: `${historyReadout.left}px` }"
          >
            <div class="sf-mono border-b border-[color:var(--sf-line)] pb-1 font-semibold">
              {{ historyReadout.agoText }} ago
            </div>
            <div class="sf-mono mt-1.5 space-y-1">
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

    <!-- Bottom Legend & Inline Overlay Toggles -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-4 py-2.5 text-[11px] text-[color:var(--sf-muted)] sm:px-5"
    >
      <div v-if="lens === 'curve'" class="flex flex-wrap items-center gap-3.5">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-[2.5px] w-3.5 rounded-full bg-[color:var(--sf-bid)]" />
          <span>Best bid</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-[2.5px] w-3.5 rounded-full bg-[color:var(--sf-ask)]" />
          <span>Best ask</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-full bg-[color:var(--sf-ask)]" />
          <span>Asks (click to inspect)</span>
        </span>

        <label class="inline-flex cursor-pointer items-center gap-1.5 hover:text-[color:var(--sf-ink)]">
          <input
            type="checkbox"
            :checked="showOffers"
            class="h-3.5 w-3.5 rounded accent-cobalt-600"
            @change="emit('update:showOffers', ($event.target as HTMLInputElement).checked)"
          />
          <span>Every bid curve</span>
        </label>

        <label class="inline-flex cursor-pointer items-center gap-1.5 hover:text-[color:var(--sf-ink)]">
          <input
            type="checkbox"
            :checked="showFills"
            class="h-3.5 w-3.5 rounded accent-cobalt-600"
            @change="emit('update:showFills', ($event.target as HTMLInputElement).checked)"
          />
          <span>Fills · 10d</span>
        </label>
      </div>

      <div v-else-if="lens === 'matrix'" class="flex flex-wrap items-center gap-3.5">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-bid)]" />
          <span>Offer capital / Best bid</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full bg-[color:var(--sf-ask)]" />
          <span>Ask demand / Best ask</span>
        </span>
      </div>

      <div v-else-if="lens === 'safety'" class="flex flex-wrap items-center gap-3.5">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-full bg-[color:var(--sf-ask)]" />
          <span>New loan</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-full bg-[color:var(--sf-cobalt)]" />
          <span>Resale bond</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-full bg-[color:var(--sf-bid)]" />
          <span>Shares</span>
        </span>
      </div>

      <div v-else class="flex flex-wrap items-center gap-3.5">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-full bg-[color:var(--sf-bid)]" />
          <span>New loans</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-full bg-[color:var(--sf-ask)]" />
          <span>Resale &amp; shares</span>
        </span>
      </div>

      <span v-if="curves" class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">
        {{ curves.searched.bids }}/{{ curves.searched.bidTotal }} bids ·
        {{ curves.searched.asks }}/{{ curves.searched.askTotal }} asks
      </span>
    </div>
  </section>
</template>
