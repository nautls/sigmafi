<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { DAY_BLOCKS, YEAR_BLOCKS } from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    darkStage?: boolean;
  }>(),
  {
    darkStage: false
  }
);

const MIN_DAYS = 55;
const MAX_DAYS = 365;
const MIN_DISC = 1.0;
const MAX_DISC = 8.0;
const MAX_APR = 56;
const NU = 26;
const NV = 14;

const figureRef = ref<HTMLElement | null>(null);
const canvas3dRef = ref<HTMLCanvasElement | null>(null);
const canvas2dRef = ref<HTMLCanvasElement | null>(null);

const isVisible = ref(true);
const isHovered = ref(false);
const activeDays = ref(112);

// Smooth spring-damped 3D camera tilt on mouse hover (never disrupts the slice animation)
const targetTilt = { yaw: 0, pitch: 0 };
const smoothTilt = { yaw: 0, pitch: 0 };
let smoothPhaseSpeed = 0.42;
const midApr = ref(13.58);
const minApr = ref(3.3);
const maxApr = ref(28.4);

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface SurfacePoint extends Vec3 {
  days: number;
  disc: number;
  apr: number;
  zNorm: number;
}

interface Projected {
  x: number;
  y: number;
  depth: number;
  persp: number;
}

interface StaticQuad {
  uMid: number;
  litRgb: [number, number, number];
}

interface Palette {
  isDark: boolean;
  card: string;
  paper: string;
  ink: string;
  muted: string;
  dim: string;
  line: string;
  lineStrong: string;
  cobalt: string;
  bid: string;
  ask: string;
  cCobalt: [number, number, number];
  cBid: [number, number, number];
  cAsk: [number, number, number];
}

const LIGHT_DIR = normalize3({ x: -0.35, y: 0.62, z: 0.88 });

const reduceMotion =
  typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

function aprAt(days: number, disc: number): number {
  return (disc / (100 - disc)) * (YEAR_BLOCKS / (days * DAY_BLOCKS)) * 100;
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

// Open amphitheater: high discount crest (8%) on back-left ridge, low front edge (1%) facing viewer.
function surfaceXYZ(u: number, v: number): SurfacePoint {
  const days = MIN_DAYS + (u + 1) * 0.5 * (MAX_DAYS - MIN_DAYS);
  const disc = MAX_DISC - (v + 1) * 0.5 * (MAX_DISC - MIN_DISC);
  const apr = aprAt(days, disc);
  const zNorm = Math.pow(Math.min(1.04, apr / MAX_APR), 0.78);
  return { x: u * 1.12, y: v * 0.74, z: zNorm * 1.16, days, disc, apr, zNorm };
}

// Precomputed static mesh vertices & normals (never recomputed during animation)
const STATIC_VERTS: SurfacePoint[][] = Array.from({ length: NU + 1 }, (_, i) => {
  const u = -1 + (2 * i) / NU;
  return Array.from({ length: NV + 1 }, (_, j) => {
    const v = -1 + (2 * j) / NV;
    return surfaceXYZ(u, v);
  });
});

// Pre-allocated projection grid reused each frame (zero per-frame heap churn)
const projGrid: Projected[][] = Array.from({ length: NU + 1 }, () =>
  Array.from({ length: NV + 1 }, () => ({ x: 0, y: 0, depth: 0, persp: 1 }))
);

let palette: Palette | null = null;
let staticQuads: StaticQuad[][] = [];
let size3 = { w: 0, h: 0 };
let size2 = { w: 0, h: 0 };
let intersectionObserver: IntersectionObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let rafId = 0;
let lastTs = 0;
let lastLabelDay = -1;
let phase = 1.02;

function parseCssColor(value: string): [number, number, number] {
  const probe = document.createElement("span");
  probe.style.color = value;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = window.getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const parts = resolved.match(/[\d.]+/g);
  if (parts && parts.length >= 3) {
    return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  }
  return [29, 78, 216];
}

function buildStaticQuads(pal: Palette): StaticQuad[][] {
  const tintTarget: [number, number, number] = pal.isDark ? [245, 250, 255] : [255, 254, 250];
  const shadeTarget: [number, number, number] = pal.isDark ? [14, 22, 34] : [210, 218, 230];
  const quads: StaticQuad[][] = [];

  for (let i = 0; i < NU; i++) {
    const row: StaticQuad[] = [];
    for (let j = 0; j < NV; j++) {
      const a = STATIC_VERTS[i][j];
      const b = STATIC_VERTS[i + 1][j];
      const c = STATIC_VERTS[i + 1][j + 1];
      const d = STATIC_VERTS[i][j + 1];

      const e1 = sub3(b, a);
      const e2 = sub3(d, a);
      let n = normalize3(cross3(e1, e2));
      if (n.z < 0) n = { x: -n.x, y: -n.y, z: -n.z };
      const ndl = Math.max(0, Math.min(1, 0.44 + 0.56 * dot3(n, LIGHT_DIR)));

      const zMid = (a.zNorm + b.zNorm + c.zNorm + d.zNorm) * 0.25;
      const baseRgb =
        zMid < 0.42
          ? mixRgb(pal.cCobalt, pal.cBid, zMid / 0.42)
          : mixRgb(pal.cBid, pal.cAsk, Math.min(1, (zMid - 0.42) / 0.58));

      const litRgb =
        ndl > 0.6
          ? mixRgb(baseRgb, tintTarget, (ndl - 0.6) * (pal.isDark ? 0.34 : 0.72))
          : mixRgb(baseRgb, shadeTarget, (0.6 - ndl) * (pal.isDark ? 0.52 : 0.34));

      const uMid = -1 + (2 * (i + 0.5)) / NU;
      row.push({ uMid, litRgb });
    }
    quads.push(row);
  }

  return quads;
}

function readPalette(): Palette {
  const sourceEl = figureRef.value || document.documentElement;
  const cs = window.getComputedStyle(sourceEl);
  const isDark =
    props.darkStage || document.documentElement.getAttribute("data-theme") === "dark";
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;

  const cobalt = get("--sf-cobalt", isDark ? "#99b9ff" : "#1d4ed8");
  const bid = get("--sf-bid", isDark ? "#72dcb2" : "#087653");
  const ask = get("--sf-ask", isDark ? "#ffbc75" : "#a6510a");

  const pal: Palette = {
    isDark,
    card: get("--sf-card", isDark ? "#192330" : "#ffffff"),
    paper: get("--sf-paper", isDark ? "#111923" : "#faf9f5"),
    ink: get("--sf-ink", isDark ? "#edf1f7" : "#0f1419"),
    muted: get("--sf-muted", isDark ? "#aab7c8" : "#667085"),
    dim: get("--sf-dim", isDark ? "#97a8bc" : "#687487"),
    line: get("--sf-line", isDark ? "rgba(179,201,230,0.17)" : "rgba(15,23,42,0.1)"),
    lineStrong: get("--sf-line-strong", isDark ? "rgba(179,201,230,0.33)" : "rgba(15,23,42,0.18)"),
    cobalt,
    bid,
    ask,
    cCobalt: parseCssColor(cobalt),
    cBid: parseCssColor(bid),
    cAsk: parseCssColor(ask)
  };
  staticQuads = buildStaticQuads(pal);
  return pal;
}

function makeProjector(w: number, h: number, yaw: number, pitch: number) {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const scale = Math.min(w * 0.222, h * 0.455);
  const cx = w * 0.51;
  const cy = h * 0.658;

  return (x: number, y: number, z: number): Projected => {
    const rx = x * cosY - y * sinY;
    const ry = x * sinY + y * cosY;
    const py = ry * sinP - z * cosP;
    const depth = ry * cosP + z * sinP;
    const persp = 5.6 / (5.6 - depth * 0.38);
    return { x: cx + rx * scale * persp, y: cy + py * scale * persp, depth, persp };
  };
}

function drawFloorEllipse(
  ctx: CanvasRenderingContext2D,
  proj: (x: number, y: number, z: number) => Projected,
  cx: number,
  cy: number,
  rx3: number,
  ry3: number,
  segments = 20
) {
  ctx.beginPath();
  for (let k = 0; k <= segments; k++) {
    const a = (k / segments) * Math.PI * 2;
    const pt = proj(cx + Math.cos(a) * rx3, cy + Math.sin(a) * ry3, 0);
    if (k === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
  ctx.closePath();
}

function drawSurfacePatch(
  ctx: CanvasRenderingContext2D,
  proj: (x: number, y: number, z: number) => Projected,
  u0: number,
  v0: number,
  ru: number,
  rv: number,
  zLift = 0.004,
  segments = 20
) {
  ctx.beginPath();
  for (let k = 0; k <= segments; k++) {
    const a = (k / segments) * Math.PI * 2;
    const u = Math.max(-1, Math.min(1, u0 + Math.cos(a) * ru));
    const v = Math.max(-1, Math.min(1, v0 + Math.sin(a) * rv));
    const s = surfaceXYZ(u, v);
    const pt = proj(s.x, s.y, s.z + zLift);
    if (k === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
  ctx.closePath();
}

function resizeCanvases() {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  if (canvas3dRef.value) {
    const r = canvas3dRef.value.getBoundingClientRect();
    if (r.width && r.height) {
      size3 = { w: r.width, h: r.height };
      canvas3dRef.value.width = Math.max(1, Math.round(r.width * dpr));
      canvas3dRef.value.height = Math.max(1, Math.round(r.height * dpr));
      canvas3dRef.value.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  if (canvas2dRef.value) {
    const r = canvas2dRef.value.getBoundingClientRect();
    if (r.width && r.height) {
      size2 = { w: r.width, h: r.height };
      canvas2dRef.value.width = Math.max(1, Math.round(r.width * dpr));
      canvas2dRef.value.height = Math.max(1, Math.round(r.height * dpr));
      canvas2dRef.value.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
}

function render3D(activeU: number) {
  const cv = canvas3dRef.value;
  if (!cv || !palette) return;
  const ctx = cv.getContext("2d");
  const { w, h } = size3;
  if (!ctx || !w || !h) return;

  const pal = palette;
  ctx.clearRect(0, 0, w, h);

  const yaw = -0.49 + 0.055 * Math.sin(phase * 0.36) + smoothTilt.yaw;
  const pitch = 0.43 + 0.018 * Math.cos(phase * 0.27) + smoothTilt.pitch;
  const proj = makeProjector(w, h, yaw, pitch);

  // Layer 1: 3D Floor Pedestal & Axes
  const f00 = proj(-1.12, -0.74, 0);
  const f10 = proj(1.12, -0.74, 0);
  const f11 = proj(1.12, 0.74, 0);
  const f01 = proj(-1.12, 0.74, 0);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(f00.x, f00.y);
  ctx.lineTo(f10.x, f10.y);
  ctx.lineTo(f11.x, f11.y);
  ctx.lineTo(f01.x, f01.y);
  ctx.closePath();
  ctx.fillStyle = pal.isDark ? "rgba(6, 10, 18, 0.42)" : "rgba(15, 23, 42, 0.028)";
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 0.75;
  for (const d of [120, 180, 270]) {
    const u = ((d - MIN_DAYS) / (MAX_DAYS - MIN_DAYS)) * 2 - 1;
    const a = proj(u * 1.12, -0.74, 0);
    const b = proj(u * 1.12, 0.74, 0);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  const mdA = proj(-1.12, 0, 0);
  const mdB = proj(1.12, 0, 0);
  ctx.beginPath();
  ctx.moveTo(mdA.x, mdA.y);
  ctx.lineTo(mdB.x, mdB.y);
  ctx.stroke();

  const zTop = proj(-1.12, -0.74, 1.16);
  ctx.strokeStyle = pal.lineStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(f00.x, f00.y);
  ctx.lineTo(zTop.x, zTop.y);
  ctx.stroke();

  ctx.font = '500 10px "IBM Plex Sans", "DM Sans", sans-serif';
  ctx.textAlign = "right";
  ctx.fillStyle = pal.muted;
  ctx.fillText("APR", zTop.x - 10, zTop.y - 6);
  for (const rate of [0, 25, 50]) {
    const zn = Math.pow(rate / MAX_APR, 0.78) * 1.16;
    const pt = proj(-1.12, -0.74, zn);
    ctx.fillStyle = pal.dim;
    ctx.fillText(`${rate}%`, pt.x - 10, pt.y + 3.5);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = pal.muted;
  for (const d of [60, 180, 365]) {
    const u = ((d - MIN_DAYS) / (MAX_DAYS - MIN_DAYS)) * 2 - 1;
    const pt = proj(u * 1.12, 0.9, 0);
    ctx.fillText(d === 365 ? "1y" : `${d}d`, pt.x, pt.y + 3);
  }
  ctx.restore();

  // Precompute active cross-section samples
  const NS = 24;
  const halfThick = 0.015;
  const sliceSamples = Array.from({ length: NS }, (_, k) => {
    const v = -1 + (2 * k) / (NS - 1);
    const sCenter = surfaceXYZ(activeU, v);
    const sLeft = surfaceXYZ(Math.max(-1, activeU - halfThick), v);
    const sRight = surfaceXYZ(Math.min(1, activeU + halfThick), v);
    return {
      top: proj(sCenter.x, sCenter.y, sCenter.z),
      topL: proj(sLeft.x, sLeft.y, sLeft.z + 0.006),
      topR: proj(sRight.x, sRight.y, sRight.z + 0.006),
      bot: proj(sCenter.x, sCenter.y, 0)
    };
  });

  const vRef = 1 - ((4 - MIN_DISC) / (MAX_DISC - MIN_DISC)) * 2;
  const ref3 = surfaceXYZ(activeU, vRef);
  const pTop = proj(ref3.x, ref3.y, ref3.z + 0.008);
  const pBot = proj(ref3.x, ref3.y, 0);

  // Layer 2: Under-surface acrylic slicing curtain, floor contact seam, plumb stem & floor shadow
  // Drawn strictly underneath the translucent surface -> zero integer column boundary popping!
  ctx.save();
  const curtainGrad = ctx.createLinearGradient(
    sliceSamples[0].top.x,
    sliceSamples[0].top.y,
    sliceSamples[NS - 1].bot.x,
    sliceSamples[NS - 1].bot.y
  );
  if (pal.isDark) {
    curtainGrad.addColorStop(0, "rgba(138, 180, 255, 0.34)");
    curtainGrad.addColorStop(0.68, "rgba(138, 180, 255, 0.14)");
    curtainGrad.addColorStop(1, "rgba(138, 180, 255, 0.04)");
  } else {
    curtainGrad.addColorStop(0, "rgba(29, 78, 216, 0.24)");
    curtainGrad.addColorStop(0.68, "rgba(29, 78, 216, 0.09)");
    curtainGrad.addColorStop(1, "rgba(29, 78, 216, 0.02)");
  }

  ctx.beginPath();
  sliceSamples.forEach((s, i) => {
    if (i === 0) ctx.moveTo(s.top.x, s.top.y);
    else ctx.lineTo(s.top.x, s.top.y);
  });
  for (let i = NS - 1; i >= 0; i--) ctx.lineTo(sliceSamples[i].bot.x, sliceSamples[i].bot.y);
  ctx.closePath();
  ctx.fillStyle = curtainGrad;
  ctx.fill();

  // Acrylic vertical edge bevels & floor contact line
  ctx.beginPath();
  ctx.moveTo(sliceSamples[0].bot.x, sliceSamples[0].bot.y);
  ctx.lineTo(sliceSamples[0].top.x, sliceSamples[0].top.y);
  ctx.moveTo(sliceSamples[NS - 1].bot.x, sliceSamples[NS - 1].bot.y);
  ctx.lineTo(sliceSamples[NS - 1].top.x, sliceSamples[NS - 1].top.y);
  ctx.moveTo(sliceSamples[0].bot.x, sliceSamples[0].bot.y);
  ctx.lineTo(sliceSamples[NS - 1].bot.x, sliceSamples[NS - 1].bot.y);
  ctx.strokeStyle = pal.isDark ? "rgba(180, 210, 255, 0.42)" : "rgba(29, 78, 216, 0.32)";
  ctx.lineWidth = 1.05;
  ctx.stroke();

  // Projected 3D floor shadow ellipse & vertical plumb stem beneath surface
  drawFloorEllipse(ctx, proj, ref3.x, ref3.y, 0.064, 0.064, 20);
  ctx.fillStyle = pal.isDark ? "rgba(6, 10, 18, 0.48)" : "rgba(15, 23, 42, 0.13)";
  ctx.fill();

  drawFloorEllipse(ctx, proj, ref3.x, ref3.y, 0.024, 0.024, 16);
  ctx.fillStyle = pal.ask;
  ctx.globalAlpha = 0.6;
  ctx.fill();
  ctx.globalAlpha = 1;

  const stemGrad = ctx.createLinearGradient(pTop.x, pTop.y, pBot.x, pBot.y);
  stemGrad.addColorStop(0, pal.ask);
  stemGrad.addColorStop(1, pal.isDark ? "rgba(255,186,112,0.18)" : "rgba(166,81,10,0.2)");
  ctx.beginPath();
  ctx.moveTo(pTop.x, pTop.y);
  ctx.lineTo(pBot.x, pBot.y);
  ctx.strokeStyle = stemGrad;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // Layer 3: Deterministic Back-to-Front Translucent Shaded 3D Manifold
  for (let i = 0; i <= NU; i++) {
    for (let j = 0; j <= NV; j++) {
      const s = STATIC_VERTS[i][j];
      projGrid[i][j] = proj(s.x, s.y, s.z);
    }
  }

  const alpha = pal.isDark ? 0.84 : 0.79;
  for (let i = NU - 1; i >= 0; i--) {
    for (let j = 0; j < NV; j++) {
      const a = projGrid[i][j];
      const b = projGrid[i + 1][j];
      const c = projGrid[i + 1][j + 1];
      const d = projGrid[i][j + 1];
      const q = staticQuads[i][j];
      const nearSlice = Math.exp(-Math.pow((q.uMid - activeU) / 0.085, 2));
      const rgb = nearSlice > 0.06 ? mixRgb(q.litRgb, pal.cCobalt, nearSlice * 0.22) : q.litRgb;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.9})`;
      ctx.lineWidth = 0.65;
      ctx.stroke();

      if (i % 5 === 0) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(d.x, d.y);
        ctx.strokeStyle = pal.isDark ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.5)";
        ctx.lineWidth = 0.85;
        ctx.stroke();
      }
      if (j % 4 === 0 || j === NV - 1) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = pal.isDark ? "rgba(255,255,255,0.13)" : "rgba(15,23,42,0.1)";
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }
    }
  }

  // Layer 4: On-Surface 3D Beveled Cross-Section Ribbon + Surface Tangent Ring + 3D-Lit Sphere
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.beginPath();
  sliceSamples.forEach((s, i) => {
    if (i === 0) ctx.moveTo(s.topL.x, s.topL.y);
    else ctx.lineTo(s.topL.x, s.topL.y);
  });
  for (let i = NS - 1; i >= 0; i--) ctx.lineTo(sliceSamples[i].topR.x, sliceSamples[i].topR.y);
  ctx.closePath();

  const ribGrad = ctx.createLinearGradient(
    sliceSamples[0].top.x,
    sliceSamples[0].top.y,
    sliceSamples[NS - 1].top.x,
    sliceSamples[NS - 1].top.y
  );
  if (pal.isDark) {
    ribGrad.addColorStop(0, "#cde1ff");
    ribGrad.addColorStop(0.55, "#8ab4ff");
    ribGrad.addColorStop(1, "#68d8ae");
  } else {
    ribGrad.addColorStop(0, "#1e3a8a");
    ribGrad.addColorStop(0.55, "#1d4ed8");
    ribGrad.addColorStop(1, "#2563eb");
  }
  ctx.fillStyle = ribGrad;
  ctx.fill();
  
  // Specular bevel highlight on lit edge of the extruded ridge
  ctx.beginPath();
  sliceSamples.forEach((s, i) => {
    if (i === 0) ctx.moveTo(s.topL.x, s.topL.y);
    else ctx.lineTo(s.topL.x, s.topL.y);
  });
  ctx.strokeStyle = pal.isDark ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.7)";
  ctx.lineWidth = 0.65;
  ctx.stroke();
  // Surface-conforming contact shadow underneath the bead (sampled on true surfaceXYZ, clamped to manifold)
  drawSurfacePatch(ctx, proj, activeU + 0.01, vRef + 0.014, 0.03, 0.042, 0.004, 18);
  ctx.fillStyle = pal.isDark ? "rgba(6, 10, 18, 0.42)" : "rgba(15, 23, 42, 0.18)";
  ctx.fill();

  // Studio-matte 3D satin bronze/terracotta bead (soft diffuse lighting matching surface softbox)
  const radius = 4.0 * pTop.persp;
  const sphereGrad = ctx.createRadialGradient(
    pTop.x - radius * 0.24,
    pTop.y - radius * 0.26,
    radius * 0.08,
    pTop.x,
    pTop.y,
    radius * 1.15
  );
  if (pal.isDark) {
    sphereGrad.addColorStop(0, "#f7d8b4");
    sphereGrad.addColorStop(0.46, "#e5a663");
    sphereGrad.addColorStop(0.86, "#ae6829");
    sphereGrad.addColorStop(1, "#c27a38");
  } else {
    sphereGrad.addColorStop(0, "#d6905c");
    sphereGrad.addColorStop(0.46, "#b05b1f");
    sphereGrad.addColorStop(0.86, "#854114");
    sphereGrad.addColorStop(1, "#964d1c");
  }
  ctx.beginPath();
  ctx.arc(pTop.x, pTop.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = sphereGrad;
  ctx.fill();
  ctx.strokeStyle = pal.isDark ? "rgba(255, 235, 210, 0.14)" : "rgba(15, 23, 42, 0.08)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Unobstructed right-edge discount labels
  ctx.font = '500 10px "IBM Plex Sans", "DM Sans", sans-serif';
  ctx.textAlign = "left";
  ctx.fillStyle = pal.muted;
  for (const dc of [8, 1]) {
    const v = 1 - ((dc - MIN_DISC) / (MAX_DISC - MIN_DISC)) * 2;
    const edgeS = surfaceXYZ(1, v);
    const pt = proj(edgeS.x + 0.1, edgeS.y, edgeS.z);
    ctx.fillText(`−${dc}%`, pt.x, pt.y + 3.5);
  }
  ctx.restore();
}

function render2DSlice(daysFloat: number) {
  const cv = canvas2dRef.value;
  if (!cv || !palette) return;
  const ctx = cv.getContext("2d");
  const { w, h } = size2;
  if (!ctx || !w || !h) return;

  const pal = palette;
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 32, r: 10, t: 8, b: 18 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const X = (disc: number) => pad.l + ((disc - MIN_DISC) / (MAX_DISC - MIN_DISC)) * pw;
  const Y = (apr: number) => pad.t + (1 - Math.min(MAX_APR, apr) / MAX_APR) * ph;

  ctx.font = '500 9px "IBM Plex Sans", "DM Sans", sans-serif';
  ctx.textAlign = "right";
  ctx.fillStyle = pal.dim;
  for (const tick of [0, 25, 50]) {
    const y = Y(tick);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.strokeStyle = tick === 0 ? pal.lineStrong : pal.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillText(`${tick}%`, pad.l - 5, y + 3);
  }

  ctx.textAlign = "center";
  for (const dc of [1, 4, 8]) {
    ctx.fillText(`${dc}%`, X(dc), h - 4);
  }

  // Dotted duration envelope (62d upper & 355d lower bounds)
  ctx.save();
  ctx.strokeStyle = pal.lineStrong;
  ctx.lineWidth = 1;
  ctx.setLineDash([2.5, 3.5]);
  for (const refD of [62, 355]) {
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const dc = MIN_DISC + ((MAX_DISC - MIN_DISC) * i) / 24;
      const x = X(dc);
      const y = Y(aprAt(refD, dc));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  const pts = Array.from({ length: 36 }, (_, i) => {
    const dc = MIN_DISC + ((MAX_DISC - MIN_DISC) * i) / 35;
    return { x: X(dc), y: Y(aprAt(daysFloat, dc)) };
  });

  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, pal.isDark ? "rgba(138,180,255,0.28)" : "rgba(29,78,216,0.16)");
  grad.addColorStop(1, "rgba(29,78,216,0)");
  ctx.beginPath();
  pts.forEach((pt, i) => {
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.lineTo(pts[pts.length - 1].x, Y(0));
  ctx.lineTo(pts[0].x, Y(0));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pts.forEach((pt, i) => {
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.strokeStyle = pal.cobalt;
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.stroke();

  const r4 = aprAt(daysFloat, 4);
  const rx = X(4);
  const ry = Y(r4);
  ctx.beginPath();
  ctx.moveTo(rx, ry);
  ctx.lineTo(rx, Y(0));
  ctx.strokeStyle = pal.ask;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(rx, ry, 3.6, 0, Math.PI * 2);
  ctx.fillStyle = pal.ask;
  ctx.fill();
}

function handleManifoldMove(e: MouseEvent) {
  const cv = canvas3dRef.value;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1));
  const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1));
  targetTilt.yaw = nx * 0.14;
  targetTilt.pitch = ny * 0.065;
}

function handleManifoldLeave() {
  targetTilt.yaw = 0;
  targetTilt.pitch = 0;
}

function drawFrame(dt = 0) {
  // Smooth frame-rate-independent damping: responsive when tracking, extra slow & velvety when returning to rest
  const tiltRate = isHovered.value ? 2.4 : 1.05;
  const damp = dt > 0 ? 1 - Math.exp(-dt * tiltRate) : 1;
  smoothTilt.yaw += (targetTilt.yaw - smoothTilt.yaw) * damp;
  smoothTilt.pitch += (targetTilt.pitch - smoothTilt.pitch) * damp;

  // Continuous floating-point days for silky sub-pixel motion (never quantized before projection!)
  const scanNorm = 0.5 - 0.5 * Math.cos(phase * 0.68);
  const daysFloat = 62 + scanNorm * 293;
  const activeU = ((daysFloat - MIN_DAYS) / (MAX_DAYS - MIN_DAYS)) * 2 - 1;

  render3D(activeU);
  render2DSlice(daysFloat);

  // Only update Vue reactive text refs when the integer day changes (cuts Vue DOM churn >85%)
  const rounded = Math.round(daysFloat);
  if (rounded !== lastLabelDay) {
    lastLabelDay = rounded;
    activeDays.value = rounded;
    midApr.value = aprAt(daysFloat, 4);
    minApr.value = aprAt(daysFloat, MIN_DISC);
    maxApr.value = aprAt(daysFloat, MAX_DISC);
  }
}

function tick(ts: number) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  const desiredSpeed = isHovered.value ? 0.3 : 0.42;
  smoothPhaseSpeed += (desiredSpeed - smoothPhaseSpeed) * (1 - Math.exp(-dt * 2.2));
  phase += dt * smoothPhaseSpeed;
  drawFrame(dt);
  rafId = window.requestAnimationFrame(tick);
}

function syncMotion() {
  if (rafId) {
    window.cancelAnimationFrame(rafId);
    rafId = 0;
  }
  lastTs = 0;
  if (isVisible.value && !reduceMotion?.matches && !document.hidden) {
    rafId = window.requestAnimationFrame(tick);
  } else {
    drawFrame();
  }
}

watch(isVisible, syncMotion);

onMounted(() => {
  palette = readPalette();
  resizeCanvases();
  drawFrame();

  if ("IntersectionObserver" in window && figureRef.value) {
    intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        isVisible.value = entry.isIntersecting;
      },
      { threshold: 0.06 }
    );
    intersectionObserver.observe(figureRef.value);
  }

  if ("ResizeObserver" in window && figureRef.value) {
    resizeObserver = new ResizeObserver(() => {
      resizeCanvases();
      drawFrame();
    });
    resizeObserver.observe(figureRef.value);
  }

  themeObserver = new MutationObserver(() => {
    palette = readPalette();
    drawFrame();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"]
  });

  reduceMotion?.addEventListener("change", syncMotion);
  document.addEventListener("visibilitychange", syncMotion);
  syncMotion();
});

onBeforeUnmount(() => {
  intersectionObserver?.disconnect();
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  reduceMotion?.removeEventListener("change", syncMotion);
  document.removeEventListener("visibilitychange", syncMotion);
  if (rafId) window.cancelAnimationFrame(rafId);
});
</script>

<template>
  <figure
    ref="figureRef"
    class="sf-plate manifold-card relative overflow-hidden rounded-[26px]"
    aria-label="Implied yield manifold and maturity cross-section"
    @mouseenter="isHovered = true"
    @mouseleave="
      isHovered = false;
      handleManifoldLeave();
    "
  >
    <!-- Pure 3D Shaded Manifold + Frosted Acrylic Cross-Section -->
    <div
      class="manifold-stage relative h-[310px] w-full sm:h-[348px]"
      @mousemove="handleManifoldMove"
      @mouseleave="handleManifoldLeave"
    >
      <canvas
        ref="canvas3dRef"
        class="block h-full w-full select-none"
        role="img"
        :aria-label="`Animated three-dimensional implied yield manifold with a moving maturity cross-section currently at ${activeDays} days, showing ${midApr.toFixed(2)} percent APR at a 4 percent discount.`"
      />
    </div>

    <!-- Synchronized Extracted Cross-Section Panel -->
    <div class="slice-panel border-t border-[color:var(--sf-line)] bg-[color:var(--sf-paper)]">
      <div class="slice-chart-box px-4 pt-3 pb-2.5">
        <div
          class="mb-1.5 flex items-center justify-between gap-2 text-[10px] text-[color:var(--sf-muted)]"
        >
          <span class="sf-mono">
            <span class="uppercase tracking-[0.1em]">Cross-section</span> ·
            <b class="font-semibold text-[color:var(--sf-cobalt)]">{{ activeDays }}d</b>
          </span>
          <span class="sf-mono text-[color:var(--sf-dim)]">1% → 8% discount</span>
        </div>
        <canvas ref="canvas2dRef" class="block h-[96px] w-full" aria-hidden="true" />
      </div>

      <dl class="slice-metrics">
        <div class="metric-row">
          <dt class="sf-mono text-[10px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            Maturity
          </dt>
          <dd class="sf-mono text-[13.5px] font-semibold text-[color:var(--sf-ink)]">
            {{ activeDays }}d
            <span class="ml-1 text-[10.5px] font-normal text-[color:var(--sf-dim)]">
              {{ ((activeDays * DAY_BLOCKS) / 1000).toFixed(1) }}k
            </span>
          </dd>
        </div>

        <div class="metric-row">
          <dt class="sf-mono text-[10px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            At 4% discount
          </dt>
          <dd class="sf-mono text-[13.5px] font-semibold text-[color:var(--sf-ask)]">
            {{ midApr.toFixed(2) }}%
          </dd>
        </div>

        <div class="metric-row">
          <dt class="sf-mono text-[10px] uppercase tracking-[0.09em] text-[color:var(--sf-muted)]">
            Slice span
          </dt>
          <dd class="sf-mono text-[13.5px] font-semibold text-[color:var(--sf-bid)]">
            {{ minApr.toFixed(1) }}% – {{ maxApr.toFixed(1) }}%
          </dd>
        </div>
      </dl>
    </div>
  </figure>
</template>

<style scoped>
.manifold-card {
  box-shadow: var(--sf-rim-top), var(--sf-shadow-hero);
}

.manifold-stage {
  background: radial-gradient(
    ellipse 70% 66% at 50% 48%,
    var(--sf-cobalt-soft),
    transparent 76%
  );
}

.slice-panel {
  display: grid;
  grid-template-columns: 1.28fr 1fr;
}

.slice-chart-box {
  border-right: 1px solid var(--sf-line);
}

.slice-metrics {
  display: grid;
  grid-template-rows: repeat(3, 1fr);
}

.metric-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 16px;
}

.metric-row + .metric-row {
  border-top: 1px solid var(--sf-line);
}

@media (max-width: 560px) {
  .slice-panel {
    grid-template-columns: 1fr;
  }

  .slice-chart-box {
    border-right: 0;
    border-bottom: 1px solid var(--sf-line);
  }
}
</style>
