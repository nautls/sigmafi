<script setup lang="ts">
import { MinusIcon, PlusIcon, RotateCcwIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { niceTicks } from "@/utils/zcMath";

export interface ChartPoint {
  x: number;
  y: number | null;
}

export interface ChartDotPoint {
  id?: string;
  x: number;
  y: number | null;
  r?: number;
  color?: string;
  stroke?: string;
  hollow?: boolean;
  beacon?: boolean;
  label?: string;
  opacity?: number;
  title?: string;
}

export type ChartLayer =
  | {
      type: "line";
      key: string;
      points: ChartPoint[];
      color: string;
      width?: number;
      dash?: string;
      opacity?: number;
      step?: boolean;
    }
  | {
      type: "area";
      key: string;
      points: ChartPoint[];
      color: string;
      opacity?: number;
      base?: number;
    }
  | {
      type: "cross";
      key: string;
      upper: ChartPoint[];
      lower: ChartPoint[];
      color: string;
      opacity?: number;
    }
  | {
      type: "band";
      key: string;
      x0: number;
      x1: number;
      color: string;
      opacity?: number;
    }
  | {
      type: "vline";
      key: string;
      x: number;
      color: string;
      dash?: string;
      opacity?: number;
      label?: string;
    }
  | {
      type: "hline";
      key: string;
      y: number;
      color: string;
      dash?: string;
      opacity?: number;
      label?: string;
    }
  | {
      type: "dots";
      key: string;
      points: ChartDotPoint[];
      r?: number;
      color?: string;
      opacity?: number;
      clickable?: boolean;
    };

export interface ChartEditPoint {
  x: number;
  y: number;
}

export interface ChartEditConfig {
  points: ChartEditPoint[];
  color: string;
  selected?: number | null;
  lockX?: boolean | ((idx: number) => boolean);
  lockY?: boolean | ((idx: number) => boolean);
  minGap?: number;
  snapX?: number;
  snapY?: number;
  keyX?: number;
  keyY?: number;
  xBounds?: [number, number];
  yBounds?: [number, number];
  remove?: boolean;
  min?: number;
  max?: number;
  tags?: string[];
  guide?: boolean;
  ariaLabel?: (p: ChartEditPoint, i: number) => string;
}

export interface ChartReadoutMark {
  y: number | null;
  color: string;
}

export interface ChartReadoutRow {
  label: string;
  value: string;
  tone?: "bid" | "ask" | "cobalt" | "warn" | "danger" | "default";
}

export interface ChartReadout {
  header: string;
  subHeader?: string;
  marks?: ChartReadoutMark[];
  rows: ChartReadoutRow[];
}

const props = withDefaults(
  defineProps<{
    height?: number;
    fillHeight?: boolean;
    xDomain: [number, number];
    yDomain: [number, number];
    xFormat?: (v: number) => string;
    yFormat?: (v: number) => string;
    xTicks?: number[];
    yTicks?: number[];
    layers: ChartLayer[];
    edit?: ChartEditConfig | null;
    hoverFn?: ((xVal: number) => ChartReadout | null) | null;
    marginLeft?: number;
    marginRight?: number;
    marginTop?: number;
    marginBottom?: number;
    zoom?: boolean;
    maxZoom?: number;
    xLimit?: [number, number] | null;
    yLimit?: [number, number] | null;
    label?: string;
  }>(),
  {
    height: 280,
    fillHeight: false,
    xFormat: undefined,
    yFormat: undefined,
    xTicks: undefined,
    yTicks: undefined,
    edit: null,
    hoverFn: null,
    marginLeft: 48,
    marginRight: 14,
    marginTop: 14,
    marginBottom: 26,
    zoom: true,
    maxZoom: 8,
    xLimit: null,
    yLimit: null,
    label: "Chart"
  }
);

const emit = defineEmits<{
  (e: "edit-change", pts: ChartEditPoint[], idx: number | null): void;
  (e: "edit-select", idx: number | null): void;
  (e: "point-click", pt: ChartDotPoint, layerKey: string): void;
  (e: "plot-click", x: number, y: number): void;
}>();

const wrapRef = ref<HTMLElement | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);
const width = ref(640);
const measuredH = ref(props.height);

const hx = ref<number | null>(null);
const dragIdx = ref<number | null>(null);
const frozen = ref<{ x: [number, number]; y: [number, number] } | null>(null);
const view = ref<{ x: [number, number]; y: [number, number] } | null>(null);

let panState: {
  X: number;
  Y: number;
  dom: { x: [number, number]; y: [number, number] };
  moved: boolean;
} | null = null;

const clipId = `sf-zc-clip-${Math.random().toString(36).slice(2, 9)}`;
const ZOOM_STEP = 0.72;

let ro: ResizeObserver | null = null;
onMounted(() => {
  if (wrapRef.value && "ResizeObserver" in window) {
    ro = new ResizeObserver(([entry]) => {
      const rw = Math.round(entry.contentRect.width);
      const rh = Math.round(entry.contentRect.height);
      if (rw >= 220) width.value = rw;
      if (props.fillHeight && rh >= 180) measuredH.value = rh;
    });
    ro.observe(wrapRef.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());

const svgH = computed(() => (props.fillHeight ? measuredH.value : props.height));
const m = computed(() => ({
  l: props.marginLeft,
  r: props.marginRight,
  t: props.marginTop,
  b: props.marginBottom
}));
const W = computed(() => Math.max(80, width.value - m.value.l - m.value.r));
const H = computed(() => Math.max(80, svgH.value - m.value.t - m.value.b));

const spanOf = (d: [number, number]) => d[1] - d[0];
const clampRange = (d: [number, number], lim: [number, number]): [number, number] => {
  const w = Math.min(spanOf(d), spanOf(lim));
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
};

watch(
  () => `${props.xDomain[0]}|${props.xDomain[1]}`,
  () => {
    view.value = null;
  }
);

const xl = computed<[number, number]>(() => props.xLimit || props.xDomain);
const yl = computed<[number, number]>(() => {
  if (props.yLimit) return props.yLimit;
  const s = spanOf(props.yDomain);
  return [props.yDomain[0] - s, props.yDomain[1] + s];
});

const dom = computed(() => frozen.value || view.value || { x: props.xDomain, y: props.yDomain });
const zoomed = computed(() => view.value !== null);
const zoomLevel = computed(() => {
  const d = spanOf(dom.value.x);
  return d > 0 ? spanOf(props.xDomain) / d : 1;
});

function sx(v: number): number {
  const [x0, x1] = dom.value.x;
  return m.value.l + ((v - x0) / (x1 - x0 || 1)) * W.value;
}
function sy(v: number): number {
  const [y0, y1] = dom.value.y;
  return m.value.t + (1 - (v - y0) / (y1 - y0 || 1)) * H.value;
}
function ix(X: number): number {
  const [x0, x1] = dom.value.x;
  return x0 + ((X - m.value.l) / W.value) * (x1 - x0);
}
function iy(Y: number): number {
  const [y0, y1] = dom.value.y;
  return y0 + (1 - (Y - m.value.t) / H.value) * (y1 - y0);
}

const xt = computed(() => {
  const [x0, x1] = dom.value.x;
  if (props.xTicks && !zoomed.value) {
    return props.xTicks.filter((v) => v >= x0 && v <= x1);
  }
  return niceTicks(x0, x1, Math.max(2, Math.round(W.value / 92)));
});

const yt = computed(() => {
  const [y0, y1] = dom.value.y;
  if (props.yTicks && !zoomed.value) return props.yTicks;
  return niceTicks(y0, y1, Math.max(3, Math.round(H.value / 46)));
});

const canIn = computed(
  () =>
    spanOf(dom.value.x) > (spanOf(props.xDomain) / props.maxZoom) * 1.001 ||
    spanOf(dom.value.y) > (spanOf(props.yDomain) / props.maxZoom) * 1.001
);
const canOut = computed(
  () =>
    spanOf(dom.value.x) < spanOf(xl.value) * 0.999 ||
    spanOf(dom.value.y) < Math.max(spanOf(props.yDomain), spanOf(yl.value)) * 0.999
);

function zoomBy(f: number, cx?: number, cy?: number) {
  const base = { x: props.xDomain, y: props.yDomain };
  const cur = view.value || base;
  const mx = cx ?? (cur.x[0] + cur.x[1]) / 2;
  const my = cy ?? (cur.y[0] + cur.y[1]) / 2;
  const minX = spanOf(base.x) / props.maxZoom;
  const minY = spanOf(base.y) / props.maxZoom;
  const maxX = spanOf(xl.value);
  const maxY = Math.max(spanOf(base.y), spanOf(yl.value));
  const nx = Math.min(maxX, Math.max(minX, spanOf(cur.x) * f));
  const ny = Math.min(maxY, Math.max(minY, spanOf(cur.y) * f));
  const fx = (mx - cur.x[0]) / (spanOf(cur.x) || 1);
  const fy = (my - cur.y[0]) / (spanOf(cur.y) || 1);
  const nextX = clampRange([mx - nx * fx, mx + nx * (1 - fx)], xl.value);
  const nextY = clampRange([my - ny * fy, my + ny * (1 - fy)], yl.value);
  const same =
    Math.abs(spanOf(nextX) - spanOf(base.x)) < spanOf(base.x) * 1e-5 &&
    Math.abs(nextX[0] - base.x[0]) < spanOf(base.x) * 1e-5 &&
    Math.abs(spanOf(nextY) - spanOf(base.y)) < spanOf(base.y) * 1e-5;
  view.value = same ? null : { x: nextX, y: nextY };
}

function clipSeg(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  xmin: number,
  xmax: number,
  ymin: number,
  ymax: number
): [number, number, number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const checks: [number, number][] = [
    [-dx, x1 - xmin],
    [dx, xmax - x1],
    [-dy, y1 - ymin],
    [dy, ymax - y1]
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

function linePath(points: readonly ChartPoint[], step = false): string {
  const [x0, x1] = dom.value.x;
  const [y0, y1] = dom.value.y;
  let d = "";
  let open = false;
  let prev: { x: number; y: number } | null = null;
  let lastX = NaN;
  let lastY = NaN;
  const emitSeg = (ax: number, ay: number, bx: number, by: number) => {
    const seg = clipSeg(ax, ay, bx, by, x0, x1, y0, y1);
    if (!seg) {
      open = false;
      return;
    }
    const X0 = sx(seg[0]);
    const Y0 = sy(seg[1]);
    const X1 = sx(seg[2]);
    const Y1 = sy(seg[3]);
    if (!open || Math.abs(X0 - lastX) > 0.25 || Math.abs(Y0 - lastY) > 0.25) {
      d += `M${X0.toFixed(1)},${Y0.toFixed(1)}`;
    }
    d += `L${X1.toFixed(1)},${Y1.toFixed(1)}`;
    open = true;
    lastX = X1;
    lastY = Y1;
  };
  for (const p of points) {
    if (p.y == null || !Number.isFinite(p.y)) {
      open = false;
      prev = null;
      continue;
    }
    if (prev) {
      if (step) {
        emitSeg(prev.x, prev.y, p.x, prev.y);
        emitSeg(p.x, prev.y, p.x, p.y);
      } else {
        emitSeg(prev.x, prev.y, p.x, p.y);
      }
    }
    prev = { x: p.x, y: p.y };
  }
  return d;
}

function areaPath(points: readonly ChartPoint[], base?: number): string {
  const [y0, y1] = dom.value.y;
  const clampedBase = Math.min(y1, Math.max(y0, base ?? y0));
  const segs: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p.y == null || !Number.isFinite(p.y)) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
    } else {
      cur.push({ x: p.x, y: Math.min(y1, Math.max(y0, p.y)) });
    }
  }
  if (cur.length > 1) segs.push(cur);
  return segs
    .map(
      (seg) =>
        `M${sx(seg[0].x).toFixed(1)},${sy(clampedBase).toFixed(1)}` +
        seg.map((p) => `L${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("") +
        `L${sx(seg[seg.length - 1].x).toFixed(1)},${sy(clampedBase).toFixed(1)}Z`
    )
    .join("");
}

function crossPath(upper: readonly ChartPoint[], lower: readonly ChartPoint[]): string {
  const [y0, y1] = dom.value.y;
  const clampY = (v: number) => Math.min(y1, Math.max(y0, v));
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
          .join("L")}Z`;
    }
    run = [];
  };
  for (let i = 0; i < upper.length; i++) {
    const u = upper[i];
    const l = lower[i];
    if (u?.y != null && l?.y != null && u.y >= l.y) {
      run.push({ x: u.x, hi: clampY(u.y), lo: clampY(l.y) });
    } else {
      flush();
    }
  }
  flush();
  return d;
}

function isLockedX(i: number): boolean {
  if (!props.edit) return true;
  return typeof props.edit.lockX === "function" ? props.edit.lockX(i) : !!props.edit.lockX;
}
function isLockedY(i: number): boolean {
  if (!props.edit) return true;
  return typeof props.edit.lockY === "function" ? props.edit.lockY(i) : !!props.edit.lockY;
}
function isLocked(i: number): boolean {
  return isLockedX(i) && isLockedY(i);
}

function pointerCoords(e: PointerEvent | WheelEvent) {
  const el = svgRef.value;
  if (!el) return { X: 0, Y: 0 };
  const r = el.getBoundingClientRect();
  return {
    X: ((e.clientX - r.left) / (r.width || 1)) * width.value,
    Y: ((e.clientY - r.top) / (r.height || 1)) * svgH.value
  };
}

function inPlot(X: number, Y: number): boolean {
  return X >= m.value.l && X <= m.value.l + W.value && Y >= m.value.t && Y <= m.value.t + H.value;
}

function snap(v: number, step?: number): number {
  return step ? Math.round(v / step) * step : v;
}

function movePoint(i: number, X: number | null, Y: number | null) {
  if (!props.edit) return;
  const pts = props.edit.points.map((p) => ({ ...p }));
  const gap = props.edit.minGap ?? 0;
  const [x0, x1] = dom.value.x;
  const [y0, y1] = dom.value.y;
  const eb = props.edit.xBounds || [x0, x1];
  const yb = props.edit.yBounds || [y0, y1];
  const bx0 = Math.max(eb[0], x0);
  const bx1 = Math.min(eb[1], x1);
  const by0 = Math.max(yb[0], y0);
  const by1 = Math.min(yb[1], y1);

  if (!isLockedX(i) && X != null) {
    const lo = i > 0 ? pts[i - 1].x + gap : bx0;
    const hi = i < pts.length - 1 ? pts[i + 1].x - gap : bx1;
    pts[i].x = Math.min(hi, Math.max(lo, snap(X, props.edit.snapX)));
  }
  if (!isLockedY(i) && Y != null) {
    pts[i].y = Math.min(by1, Math.max(by0, snap(Y, props.edit.snapY)));
  }
  emit("edit-change", pts, i);
}

function onHandleDown(e: PointerEvent, i: number) {
  e.stopPropagation();
  if (isLocked(i)) return;
  svgRef.value?.setPointerCapture?.(e.pointerId);
  frozen.value = { x: [...dom.value.x] as [number, number], y: [...dom.value.y] as [number, number] };
  dragIdx.value = i;
  emit("edit-select", i);
}

function onBgDown(e: PointerEvent) {
  if (dragIdx.value != null || e.button !== 0) return;
  const { X, Y } = pointerCoords(e);
  if (!inPlot(X, Y)) return;
  panState = {
    X,
    Y,
    dom: { x: [...dom.value.x] as [number, number], y: [...dom.value.y] as [number, number] },
    moved: false
  };
  if (view.value) svgRef.value?.setPointerCapture?.(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  const { X, Y } = pointerCoords(e);
  if (dragIdx.value != null) {
    movePoint(dragIdx.value, ix(X), iy(Y));
    return;
  }
  if (panState) {
    const dx = ((X - panState.X) / W.value) * spanOf(panState.dom.x);
    const dy = ((Y - panState.Y) / H.value) * spanOf(panState.dom.y);
    if (Math.abs(X - panState.X) + Math.abs(Y - panState.Y) > 4) panState.moved = true;
    if (panState.moved && view.value) {
      view.value = {
        x: clampRange([panState.dom.x[0] - dx, panState.dom.x[1] - dx], xl.value),
        y: clampRange([panState.dom.y[0] + dy, panState.dom.y[1] + dy], yl.value)
      };
      hx.value = null;
      return;
    }
  }
  if (X >= m.value.l && X <= m.value.l + W.value) {
    hx.value = ix(X);
  } else {
    hx.value = null;
  }
}

function onPointerUp(e: PointerEvent) {
  if (dragIdx.value != null) {
    svgRef.value?.releasePointerCapture?.(e.pointerId);
    dragIdx.value = null;
    frozen.value = null;
    return;
  }
  const p = panState;
  panState = null;
  if (!p) return;
  svgRef.value?.releasePointerCapture?.(e.pointerId);
  if (!p.moved) {
    const { X, Y } = pointerCoords(e);
    if (inPlot(X, Y)) emit("plot-click", ix(X), iy(Y));
  }
}

function onWheel(e: WheelEvent) {
  if (!props.zoom || (!e.ctrlKey && !e.metaKey)) return;
  e.preventDefault();
  const { X, Y } = pointerCoords(e);
  zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ix(X), iy(Y));
}

function onHandleKey(e: KeyboardEvent, i: number) {
  if (!props.edit || isLocked(i)) return;
  const p = props.edit.points[i];
  const big = e.shiftKey ? 10 : 1;
  const sxStep = (props.edit.keyX || props.edit.snapX || spanOf(dom.value.x) / 100) * big;
  const syStep = (props.edit.keyY || props.edit.snapY || spanOf(dom.value.y) / 100) * big;
  const moveMap: Record<string, [number, number]> = {
    ArrowUp: [0, syStep],
    ArrowDown: [0, -syStep],
    ArrowRight: [sxStep, 0],
    ArrowLeft: [-sxStep, 0]
  };
  const delta = moveMap[e.key];
  if (delta) {
    e.preventDefault();
    movePoint(i, p.x + delta[0], p.y + delta[1]);
  }
  if (
    (e.key === "Delete" || e.key === "Backspace") &&
    props.edit.remove &&
    props.edit.points.length > (props.edit.min || 1)
  ) {
    e.preventDefault();
    emit(
      "edit-change",
      props.edit.points.filter((_, j) => j !== i),
      null
    );
    emit("edit-select", null);
  }
}

const readout = computed(() => {
  if (hx.value == null || !props.hoverFn || dragIdx.value != null) return null;
  return props.hoverFn(hx.value);
});

const hxPx = computed(() => (hx.value != null ? sx(hx.value) : 0));
const readLeft = computed(() => {
  const estW = 204;
  if (hxPx.value + 14 + estW <= width.value - 6) return hxPx.value + 14;
  if (hxPx.value - 14 - estW >= 6) return hxPx.value - 14 - estW;
  return Math.max(6, width.value - estW - 6);
});

function rowToneClass(tone?: ChartReadoutRow["tone"]): string {
  if (tone === "bid") return "text-[color:var(--sf-bid)]";
  if (tone === "ask") return "text-[color:var(--sf-ask)]";
  if (tone === "cobalt") return "text-[color:var(--sf-cobalt)]";
  if (tone === "warn") return "text-[color:var(--sf-warn)]";
  if (tone === "danger") return "text-[color:var(--sf-danger)]";
  return "text-[color:var(--sf-ink)]";
}
</script>

<template>
  <div
    ref="wrapRef"
    class="sf-dock-well relative w-full select-none overflow-hidden rounded-[12px] border border-[color:var(--sf-line)]"
    :class="fillHeight ? 'h-full min-h-[210px]' : ''"
    :style="{
      height: fillHeight ? undefined : `${height}px`,
      touchAction: edit || zoomed ? 'none' : 'pan-y'
    }"
  >
    <!-- Floating Zoom Toolbar -->
    <div
      v-if="zoom"
      class="sf-popover absolute right-2.5 top-2.5 z-20 inline-flex items-center gap-0.5 rounded-lg p-0.5"
      role="group"
      aria-label="Chart zoom"
    >
      <button
        type="button"
        :disabled="!canOut"
        title="Zoom out (Ctrl + scroll)"
        aria-label="Zoom out"
        class="grid h-6 w-6 place-items-center rounded-md text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)] disabled:opacity-30"
        @click="zoomBy(1 / ZOOM_STEP)"
      >
        <minus-icon class="h-3 w-3" />
      </button>
      <span
        v-if="zoomed"
        class="sf-mono px-1 text-[10px] font-semibold text-[color:var(--sf-cobalt)]"
      >
        {{ zoomLevel >= 10 ? Math.round(zoomLevel) : zoomLevel.toFixed(1) }}×
      </span>
      <button
        type="button"
        :disabled="!canIn"
        title="Zoom in (Ctrl + scroll)"
        aria-label="Zoom in"
        class="grid h-6 w-6 place-items-center rounded-md text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)] disabled:opacity-30"
        @click="zoomBy(ZOOM_STEP)"
      >
        <plus-icon class="h-3 w-3" />
      </button>
      <button
        v-if="zoomed"
        type="button"
        title="Reset zoom"
        aria-label="Reset zoom"
        class="grid h-6 w-6 place-items-center rounded-md text-[color:var(--sf-muted)] transition-colors hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]"
        @click="view = null"
      >
        <rotate-ccw-icon class="h-3 w-3" />
      </button>
    </div>

    <svg
      ref="svgRef"
      :width="width"
      :height="svgH"
      :viewBox="`0 0 ${width} ${svgH}`"
      role="img"
      :aria-label="label"
      class="block h-full w-full"
      :class="zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'"
      @pointerdown="onBgDown"
      @pointermove="onPointerMove"
      @pointerleave="dragIdx == null && !panState && (hx = null)"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel="onWheel"
    >
      <defs>
        <clipPath :id="clipId">
          <rect :x="m.l" :y="m.t - 2" :width="Math.max(0, W)" :height="Math.max(0, H + 4)" />
        </clipPath>
      </defs>

      <!-- Coordinate Grid & Ticks -->
      <g>
        <g v-for="v in yt" :key="`y-${v}`">
          <line
            :x1="m.l"
            :x2="m.l + W"
            :y1="sy(v)"
            :y2="sy(v)"
            stroke="var(--sf-line)"
            stroke-dasharray="2 3"
          />
          <text
            :x="m.l - 8"
            :y="sy(v) + 3.5"
            text-anchor="end"
            fill="var(--sf-muted)"
            font-size="10"
            class="sf-mono"
          >
            {{ yFormat ? yFormat(v) : v }}
          </text>
        </g>

        <g v-for="v in xt" :key="`x-${v}`">
          <line
            :x1="sx(v)"
            :x2="sx(v)"
            :y1="m.t"
            :y2="m.t + H"
            stroke="var(--sf-grid)"
          />
          <text
            :x="sx(v)"
            :y="svgH - 7"
            text-anchor="middle"
            fill="var(--sf-muted)"
            font-size="10"
            class="sf-mono"
          >
            {{ xFormat ? xFormat(v) : v }}
          </text>
        </g>
      </g>

      <!-- Clipped Plot Layers -->
      <g :clip-path="`url(#${clipId})`">
        <template v-for="L in layers" :key="L.key">
          <rect
            v-if="L.type === 'band'"
            :x="sx(Math.max(dom.x[0], L.x0))"
            :y="m.t"
            :width="Math.max(0, sx(Math.min(dom.x[1], L.x1)) - sx(Math.max(dom.x[0], L.x0)))"
            :height="H"
            :fill="L.color"
            :opacity="L.opacity ?? 0.08"
          />

          <path
            v-else-if="L.type === 'area'"
            :d="areaPath(L.points, L.base)"
            :fill="L.color"
            :opacity="L.opacity ?? 0.12"
          />

          <path
            v-else-if="L.type === 'cross'"
            :d="crossPath(L.upper, L.lower)"
            :fill="L.color"
            :opacity="L.opacity ?? 0.16"
          />

          <g v-else-if="L.type === 'vline' && L.x >= dom.x[0] && L.x <= dom.x[1]">
            <line
              :x1="sx(L.x)"
              :x2="sx(L.x)"
              :y1="m.t"
              :y2="m.t + H"
              :stroke="L.color"
              :stroke-dasharray="L.dash || '3 4'"
              :opacity="L.opacity ?? 0.72"
            />
            <text
              v-if="L.label"
              :x="sx(L.x) > m.l + W - 125 ? sx(L.x) - 5 : sx(L.x) + 5"
              :y="m.t + 11"
              :text-anchor="sx(L.x) > m.l + W - 125 ? 'end' : 'start'"
              :fill="L.color"
              font-size="9.5"
              font-weight="600"
              class="sf-mono"
            >
              {{ L.label }}
            </text>
          </g>

          <g v-else-if="L.type === 'hline' && L.y >= dom.y[0] && L.y <= dom.y[1]">
            <line
              :x1="m.l"
              :x2="m.l + W"
              :y1="sy(L.y)"
              :y2="sy(L.y)"
              :stroke="L.color"
              :stroke-dasharray="L.dash || '3 4'"
              :opacity="L.opacity ?? 0.7"
            />
            <text
              v-if="L.label"
              :x="m.l + W - 4"
              :y="sy(L.y) - 5"
              text-anchor="end"
              :fill="L.color"
              font-size="9.5"
              font-weight="600"
              class="sf-mono"
            >
              {{ L.label }}
            </text>
          </g>

          <path
            v-else-if="L.type === 'line'"
            :d="linePath(L.points, L.step)"
            fill="none"
            :stroke="L.color"
            :stroke-width="L.width ?? 2"
            :stroke-dasharray="L.dash"
            :opacity="L.opacity ?? 1"
            stroke-linejoin="round"
            stroke-linecap="round"
          />

          <g v-else-if="L.type === 'dots'">
            <template v-for="(pt, j) in L.points" :key="pt.id || j">
              <g
                v-if="
                  pt.y != null &&
                  pt.x >= dom.x[0] &&
                  pt.x <= dom.x[1] &&
                  pt.y >= dom.y[0] &&
                  pt.y <= dom.y[1]
                "
              >
                <circle
                  v-if="pt.beacon"
                  :cx="sx(pt.x)"
                  :cy="sy(pt.y)"
                  :r="(pt.r || L.r || 6) + 7"
                  :fill="pt.color || L.color || 'var(--sf-cobalt)'"
                  fill-opacity="0.18"
                  class="sf-chart-beacon-halo"
                  pointer-events="none"
                />
                <circle
                  v-if="pt.beacon"
                  :cx="sx(pt.x)"
                  :cy="sy(pt.y)"
                  :r="(pt.r || L.r || 6) + 3.5"
                  fill="none"
                  :stroke="pt.color || L.color || 'var(--sf-cobalt)'"
                  stroke-width="1.5"
                  stroke-opacity="0.55"
                  pointer-events="none"
                />
                <circle
                  :cx="sx(pt.x)"
                  :cy="sy(pt.y)"
                  :r="pt.r || L.r || 3.2"
                  :fill="pt.hollow ? 'none' : pt.color || L.color || 'var(--sf-ask)'"
                  :stroke="pt.stroke || (pt.hollow ? pt.color || L.color || 'var(--sf-ask)' : 'none')"
                  :stroke-width="pt.beacon ? 2.4 : pt.hollow ? 1.5 : pt.stroke ? 2 : 1"
                  :opacity="pt.opacity ?? L.opacity ?? 1"
                  :class="L.clickable ? 'cursor-pointer transition-transform' : ''"
                  @pointerdown="L.clickable ? $event.stopPropagation() : undefined"
                  @click="
                    L.clickable
                      ? ($event.stopPropagation(), emit('point-click', pt, L.key))
                      : undefined
                  "
                >
                  <title v-if="pt.title">{{ pt.title }}</title>
                </circle>
              </g>
            </template>
          </g>
        </template>
      </g>

      <!-- Unclipped Beacon Labels (so callout pills stay sharp and readable near edges) -->
      <template v-for="L in layers" :key="`lbl-${L.key}`">
        <template v-if="L.type === 'dots'">
          <template v-for="(pt, j) in L.points" :key="`lbl-${pt.id || j}`">
            <g
              v-if="
                pt.label &&
                pt.y != null &&
                pt.x >= dom.x[0] &&
                pt.x <= dom.x[1] &&
                pt.y >= dom.y[0] &&
                pt.y <= dom.y[1]
              "
              pointer-events="none"
            >
              <rect
                :x="sx(pt.x) > m.l + W - 108 ? sx(pt.x) - (pt.label.length * 6.4 + 22) : sx(pt.x) + 11"
                :y="Math.max(m.t + 2, sy(pt.y) - 10)"
                :width="pt.label.length * 6.4 + 12"
                height="20"
                rx="6"
                :fill="pt.color || L.color || 'var(--sf-cobalt)'"
                fill-opacity="0.94"
              />
              <text
                :x="sx(pt.x) > m.l + W - 108 ? sx(pt.x) - (pt.label.length * 6.4 + 16) : sx(pt.x) + 17"
                :y="Math.max(m.t + 2, sy(pt.y) - 10) + 13.5"
                fill="#ffffff"
                font-size="10"
                font-weight="700"
                class="sf-mono"
              >
                {{ pt.label }}
              </text>
            </g>
          </template>
        </template>
      </template>

      <!-- Crosshair & Readout Marks -->
      <line
        v-if="hx != null && dragIdx == null"
        :x1="hxPx"
        :x2="hxPx"
        :y1="m.t"
        :y2="m.t + H"
        stroke="var(--sf-line-strong)"
        stroke-dasharray="3 3"
        pointer-events="none"
      />
      <template v-if="readout?.marks">
        <template v-for="(mk, idx) in readout.marks" :key="idx">
          <circle
            v-if="mk.y != null && mk.y >= dom.y[0] && mk.y <= dom.y[1]"
            :cx="hxPx"
            :cy="sy(mk.y)"
            r="4.2"
            :fill="mk.color"
            stroke="var(--sf-card)"
            stroke-width="2"
            pointer-events="none"
          />
        </template>
      </template>

      <!-- Interactive Control Handles -->
      <g v-if="edit">
        <path
          v-if="edit.points.length > 1 && edit.guide === true"
          :d="linePath(edit.points)"
          fill="none"
          :stroke="edit.color"
          stroke-width="2.4"
          stroke-linejoin="round"
          :clip-path="`url(#${clipId})`"
        />
        <template v-for="(p, i) in edit.points" :key="i">
          <g
            v-if="
              p.x >= dom.x[0] - 1e-9 &&
              p.x <= dom.x[1] + 1e-9 &&
              p.y >= dom.y[0] &&
              p.y <= dom.y[1]
            "
            :tabindex="isLocked(i) ? -1 : 0"
            role="slider"
            :aria-label="edit.ariaLabel ? edit.ariaLabel(p, i) : `Point ${i + 1}`"
            :aria-valuenow="p.y"
            class="chart-handle outline-none"
            :class="[
              isLocked(i) ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
              edit.selected === i ? 'is-selected' : ''
            ]"
            @pointerdown="onHandleDown($event, i)"
            @keydown="onHandleKey($event, i)"
            @focus="!isLocked(i) && emit('edit-select', i)"
          >
            <circle :cx="sx(p.x)" :cy="sy(p.y)" r="15" fill="transparent" />
            <!-- Soft halo ring when selected or active -->
            <circle
              v-if="edit.selected === i || dragIdx === i"
              :cx="sx(p.x)"
              :cy="sy(p.y)"
              r="10.5"
              :fill="edit.color"
              opacity="0.22"
            />
            <circle
              :cx="sx(p.x)"
              :cy="sy(p.y)"
              :r="edit.selected === i || dragIdx === i ? 6.5 : 5"
              :fill="isLocked(i) ? 'var(--sf-card)' : edit.color"
              :stroke="isLocked(i) ? edit.color : 'var(--sf-card)'"
              stroke-width="2"
            />
            <text
              v-if="edit.tags?.[i]"
              :x="sx(p.x)"
              :y="sy(p.y) - 12"
              text-anchor="middle"
              :fill="edit.color"
              font-size="9.5"
              font-weight="600"
              class="sf-mono pointer-events-none"
            >
              {{ edit.tags[i] }}
            </text>
          </g>
        </template>
      </g>
    </svg>

    <!-- Floating Glass Hover Readout -->
    <div
      v-if="readout"
      class="sf-popover pointer-events-none absolute top-3 z-20 min-w-[186px] max-w-[244px] rounded-xl px-3 py-2 text-[11px]"
      :style="{ left: `${readLeft}px` }"
    >
      <div
        class="sf-mono mb-1.5 flex items-baseline justify-between gap-2 border-b border-[color:var(--sf-line)] pb-1 text-[10.5px] font-semibold text-[color:var(--sf-ink)]"
      >
        <span>{{ readout.header }}</span>
        <span v-if="readout.subHeader" class="font-normal text-[color:var(--sf-muted)]">
          {{ readout.subHeader }}
        </span>
      </div>
      <div class="space-y-0.5">
        <div
          v-for="row in readout.rows"
          :key="row.label"
          class="flex items-center justify-between gap-3"
        >
          <span class="text-[color:var(--sf-muted)]">{{ row.label }}</span>
          <span class="sf-mono font-semibold" :class="rowToneClass(row.tone)">
            {{ row.value }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart-handle circle:nth-of-type(2) {
  transition: r 0.14s var(--sf-spring);
}

.sf-chart-beacon-halo {
  animation: sfBeaconPulse 2.4s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: center;
}

@keyframes sfBeaconPulse {
  0%,
  100% {
    opacity: 0.22;
    transform: scale(0.92);
  }
  50% {
    opacity: 0.4;
    transform: scale(1.18);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sf-chart-beacon-halo {
    animation: none;
  }
}
</style>
