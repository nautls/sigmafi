<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const MIN_DAYS = 7;
const MAX_DAYS = 365;
const MAX_RATE = 22;

const wrapperRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const isVisible = ref(true);

interface ThemePalette {
  isDark: boolean;
  bg: string;
  card: string;
  ink: string;
  muted: string;
  dim: string;
  line: string;
  lineStrong: string;
  cobalt: string;
  bid: string;
  ask: string;
}

// Fixed on-fill borrower ask: stationary in maturity (X), pops into existence, fills when Lender Curve touches it
interface FixedAsk {
  day: number;
  rate: number;
  baseOffset: number;
  climbSpeed: number;
  state: "cooldown" | "popping" | "waiting";
  timer: number;
  cooldownDuration: number;
  popScale: number;
  alpha: number;
  slotIndex: number;
  spawnBelowAsk?: boolean;
}

// Fixed-maturity / Resale ask: glides strictly BACKWARDS in remaining maturity (right -> left)
interface DriftingAsk {
  kind: "resale" | "fixedMat";
  day: number;
  rate: number;
  speedDaysPerSec: number;
  yieldTilt: number;
  trail: { day: number; rate: number }[];
  alpha: number;
  state: "cooldown" | "active";
  timer: number;
  spawnBelowAsk?: boolean;
  spawnDayRange?: [number, number];
}

interface FillBurst {
  day: number;
  rate: number;
  kind: "borrow" | "resale";
  age: number;
}

const reduceMotion =
  typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

const CONTROL_DAYS = [18, 55, 105, 165, 235, 305, 355];
const FIXED_DAY_SLOTS = [42, 88, 136, 194, 258, 318];

// Pre-seeded Fixed On-Fill Asks (pop into place at fixed maturity, fill on lender-curve contact)
const fixedAsks: FixedAsk[] = [
  {
    day: 88,
    rate: 10.6,
    baseOffset: 1.55,
    climbSpeed: 0.38,
    state: "waiting",
    timer: 0,
    cooldownDuration: 1.4,
    popScale: 1,
    alpha: 1,
    slotIndex: 1
  },
  {
    day: 194,
    rate: 12.8,
    baseOffset: 1.85,
    climbSpeed: 0.34,
    state: "popping",
    timer: 0.15,
    cooldownDuration: 1.8,
    popScale: 0.5,
    alpha: 0.7,
    slotIndex: 3
  },
  {
    day: 318,
    rate: 14.9,
    baseOffset: 1.7,
    climbSpeed: 0.3,
    state: "cooldown",
    timer: 0.9,
    cooldownDuration: 1.6,
    popScale: 0,
    alpha: 0,
    slotIndex: 5
  },
  // Spawns below the orange borrower ask curve to show the curve does not determine eligibility
  {
    day: 258,
    rate: 10.2,
    baseOffset: 2.35,
    climbSpeed: 0.42,
    state: "waiting",
    timer: 0,
    cooldownDuration: 1.5,
    popScale: 1,
    alpha: 1,
    slotIndex: 4,
    spawnBelowAsk: true
  }
];

// Pre-seeded Moving Asks (Bond Resales & Fixed-Maturity Asks drifting strictly LEFTWARDS)
const driftingAsks: DriftingAsk[] = [
  {
    kind: "resale",
    day: 292,
    rate: 14.3,
    speedDaysPerSec: 22,
    yieldTilt: 0.24,
    trail: [],
    alpha: 1,
    state: "active",
    timer: 0
  },
  {
    kind: "resale",
    day: 168,
    rate: 12.6,
    speedDaysPerSec: 19,
    yieldTilt: 0.28,
    trail: [],
    alpha: 1,
    state: "active",
    timer: 0
  },
  {
    kind: "fixedMat",
    day: 245,
    rate: 13.0,
    speedDaysPerSec: 17,
    yieldTilt: 0.22,
    trail: [],
    alpha: 1,
    state: "active",
    timer: 0
  },
  {
    kind: "resale",
    day: 112,
    rate: 11.4,
    speedDaysPerSec: 21,
    yieldTilt: 0.25,
    trail: [],
    alpha: 0,
    state: "cooldown",
    timer: 1.1
  },
  // Spawns below the orange borrower ask curve at shorter maturities (< 180d)
  {
    kind: "fixedMat",
    day: 158,
    rate: 9.2,
    speedDaysPerSec: 13.5,
    yieldTilt: 0.32,
    trail: [],
    alpha: 1,
    state: "active",
    timer: 0,
    spawnBelowAsk: true,
    spawnDayRange: [115, 173]
  }
];

const bursts: FillBurst[] = [];

const targetMouse = { x: 0.52, y: 0.46, active: 0 };
const smoothMouse = { x: 0.52, y: 0.46, active: 0 };

let palette: ThemePalette | null = null;
let size = { w: 0, h: 0 };
let phase = 0;
let rafId = 0;
let lastTs = 0;
let slotCounter = 2;
let resizeObserver: ResizeObserver | null = null;
let intersectionObserver: IntersectionObserver | null = null;
let themeObserver: MutationObserver | null = null;

// Lender Bid Curve: HIGHER yield (minimum APR lenders accept) — breathes organically so it touches waiting asks
function lenderBidRateAt(day: number, tPhase: number): number {
  const norm = Math.max(0, Math.min(1, (day - MIN_DAYS) / (MAX_DAYS - MIN_DAYS)));
  const base = 8.4 + 8.3 * Math.pow(norm, 0.62) + 1.15 * Math.sin(norm * Math.PI * 1.12);
  const breathe =
    0.72 * Math.sin(tPhase * 0.92 + norm * 3.1) + 0.36 * Math.cos(tPhase * 0.62 - norm * 4.0);
  return Math.max(5.5, Math.min(MAX_RATE - 1.2, base + breathe));
}

// Borrower Ask Envelope: LOWER yield (borrowers ask for lower rates than resting lender bids)
function borrowerAskRateAt(day: number, tPhase: number): number {
  const norm = Math.max(0, Math.min(1, (day - MIN_DAYS) / (MAX_DAYS - MIN_DAYS)));
  const spread =
    2.65 + 0.85 * Math.sin(norm * Math.PI) + 0.28 * Math.cos(tPhase * 0.7 + norm * 2.1);
  return Math.max(1.8, lenderBidRateAt(day, tPhase) - spread);
}

function readPalette(): ThemePalette {
  const cs = window.getComputedStyle(document.documentElement);
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;

  return {
    isDark,
    bg: get("--sf-paper", isDark ? "#060a14" : "#e8eef7"),
    card: get("--sf-card", isDark ? "#0e1629" : "#f8faff"),
    ink: get("--sf-ink", isDark ? "#f4f7ff" : "#0a1020"),
    muted: get("--sf-muted", isDark ? "#8c9fbc" : "#556681"),
    dim: get("--sf-dim", isDark ? "#6c80a2" : "#70829e"),
    line: get("--sf-line", isDark ? "rgba(164,200,255,0.13)" : "rgba(15,29,58,0.1)"),
    lineStrong: get("--sf-line-strong", isDark ? "rgba(164,200,255,0.24)" : "rgba(15,29,58,0.18)"),
    cobalt: get("--sf-cobalt", isDark ? "#6aa0ff" : "#2457f5"),
    bid: get("--sf-bid", isDark ? "#42e8b0" : "#05875f"),
    ask: get("--sf-ask", isDark ? "#ffb866" : "#c2590a")
  };
}

function resizeCanvas() {
  const cv = canvasRef.value;
  if (!cv) return;
  const rect = cv.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  size = { w: rect.width, h: rect.height };
  cv.width = Math.max(1, Math.round(rect.width * dpr));
  cv.height = Math.max(1, Math.round(rect.height * dpr));
  cv.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function popEaseOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = Math.max(0, Math.min(1, t));
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function updateAsks(dt: number) {
  if (dt <= 0) return;

  // 1. Fixed On-Fill Asks (stay fixed in maturity X, pop into existence, fill when Lender Curve touches them)
  for (const fa of fixedAsks) {
    if (fa.state === "cooldown") {
      fa.timer -= dt;
      if (fa.timer <= 0) {
        let nextSlot = slotCounter++ % FIXED_DAY_SLOTS.length;
        for (let tries = 0; tries < FIXED_DAY_SLOTS.length; tries++) {
          const occupied = fixedAsks.some(
            (other) => other !== fa && other.state !== "cooldown" && other.slotIndex === nextSlot
          );
          if (!occupied) break;
          nextSlot = slotCounter++ % FIXED_DAY_SLOTS.length;
        }
        fa.slotIndex = nextSlot;
        fa.day = FIXED_DAY_SLOTS[fa.slotIndex] + ((slotCounter * 7) % 15) - 7;
        const anchorRate = fa.spawnBelowAsk
          ? borrowerAskRateAt(fa.day, phase)
          : lenderBidRateAt(fa.day, phase);
        fa.rate = Math.max(fa.spawnBelowAsk ? 1.8 : 2.4, anchorRate - fa.baseOffset);
        fa.state = "popping";
        fa.timer = 0;
        fa.popScale = 0;
        fa.alpha = 0;
      }
      continue;
    }

    if (fa.state === "popping") {
      fa.timer += dt;
      const p = Math.min(1, fa.timer / 0.48);
      fa.popScale = popEaseOutBack(p);
      fa.alpha = Math.min(1, p * 1.4);
      if (p >= 1) {
        fa.state = "waiting";
        fa.popScale = 1;
        fa.alpha = 1;
      }
      continue;
    }

    // Waiting at fixed maturity X: gently lifts yield or holds until Lender Curve dips down to touch it
    fa.rate += fa.climbSpeed * dt;
    const bidNow = lenderBidRateAt(fa.day, phase);
    if (fa.rate >= bidNow - 0.14) {
      bursts.push({
        day: fa.day,
        rate: bidNow,
        kind: "borrow",
        age: 0
      });
      fa.state = "cooldown";
      fa.timer = fa.cooldownDuration;
      fa.alpha = 0;
      fa.popScale = 0;
    }
  }

  // 2. Drifting Fixed-Maturity & Resale Asks (move strictly BACKWARDS: decreasing maturity day)
  for (const da of driftingAsks) {
    if (da.state === "cooldown") {
      da.timer -= dt;
      if (da.timer <= 0) {
        const [minDay, maxDay] = da.spawnDayRange ?? [265, 353];
        da.day = minDay + Math.random() * (maxDay - minDay);
        if (da.spawnBelowAsk) {
          const askNow = borrowerAskRateAt(da.day, phase);
          const offset = 1.8 + Math.random() * 0.9;
          da.rate = Math.max(2.0, askNow - offset);
        } else {
          const bidNow = lenderBidRateAt(da.day, phase);
          const offset =
            da.kind === "resale" ? 1.1 + Math.random() * 0.9 : 1.55 + Math.random() * 0.9;
          da.rate = Math.max(2.5, bidNow - offset);
        }
        da.trail = [];
        da.alpha = 0;
        da.state = "active";
      }
      continue;
    }

    // Strictly move backwards in maturity (right -> left)
    da.day -= da.speedDaysPerSec * dt;
    // Slight upward yield drift as seller steps rate toward lender bid curve
    da.rate += da.yieldTilt * dt;
    da.alpha = Math.min(1, da.alpha + dt * 2.2);

    da.trail.unshift({ day: da.day, rate: da.rate });
    if (da.trail.length > 18) da.trail.pop();

    const bidNow = lenderBidRateAt(da.day, phase);
    if (da.rate >= bidNow - 0.14) {
      bursts.push({
        day: da.day,
        rate: bidNow,
        kind: da.kind === "resale" ? "resale" : "borrow",
        age: 0
      });
      da.state = "cooldown";
      da.timer = 1.0 + Math.random() * 0.9;
      da.trail = [];
    } else if (da.day <= MIN_DAYS + 8) {
      da.state = "cooldown";
      da.timer = 0.8 + Math.random() * 0.7;
      da.trail = [];
    }
  }
}

function drawScene(dt: number) {
  const cv = canvasRef.value;
  if (!cv || !palette) return;
  const ctx = cv.getContext("2d");
  const { w, h } = size;
  if (!ctx || !w || !h) return;

  updateAsks(dt);

  // Smooth spring-damped pointer easing
  const damp = dt > 0 ? Math.min(1, dt * 4.5) : 1;
  smoothMouse.x += (targetMouse.x - smoothMouse.x) * damp;
  smoothMouse.y += (targetMouse.y - smoothMouse.y) * damp;
  smoothMouse.active += (targetMouse.active - smoothMouse.active) * damp;

  const parallaxX = (smoothMouse.x - 0.5) * 24;
  const parallaxY = (smoothMouse.y - 0.5) * 14;

  const pal = palette;
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 48, r: 22, t: 54, b: 36 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const X = (day: number) => pad.l + ((day - MIN_DAYS) / (MAX_DAYS - MIN_DAYS)) * pw;
  const Y = (rate: number) => pad.t + (1 - Math.max(0, Math.min(MAX_RATE, rate)) / MAX_RATE) * ph;

  // 1. Atmospheric studio color washes + gentle pointer spotlight
  const cobaltBloom = ctx.createRadialGradient(
    w * 0.72 + parallaxX * 0.85,
    h * 0.24 + parallaxY * 0.65,
    12,
    w * 0.72 + parallaxX * 0.85,
    h * 0.24 + parallaxY * 0.65,
    w * 0.62
  );
  cobaltBloom.addColorStop(0, pal.isDark ? "rgba(106, 160, 255, 0.24)" : "rgba(36, 87, 245, 0.14)");
  cobaltBloom.addColorStop(1, "rgba(36, 87, 245, 0)");
  ctx.fillStyle = cobaltBloom;
  ctx.fillRect(0, 0, w, h);

  const emeraldBloom = ctx.createRadialGradient(
    w * 0.28 - parallaxX * 0.55,
    h * 0.72 - parallaxY * 0.5,
    10,
    w * 0.28 - parallaxX * 0.55,
    h * 0.72 - parallaxY * 0.5,
    w * 0.48
  );
  emeraldBloom.addColorStop(0, pal.isDark ? "rgba(66, 232, 176, 0.17)" : "rgba(5, 135, 95, 0.11)");
  emeraldBloom.addColorStop(1, "rgba(5, 135, 95, 0)");
  ctx.fillStyle = emeraldBloom;
  ctx.fillRect(0, 0, w, h);

  if (smoothMouse.active > 0.01) {
    const mx = smoothMouse.x * w;
    const my = smoothMouse.y * h;
    const spot = ctx.createRadialGradient(mx, my, 4, mx, my, w * 0.34);
    spot.addColorStop(
      0,
      pal.isDark
        ? `rgba(140, 186, 255, ${0.16 * smoothMouse.active})`
        : `rgba(36, 87, 245, ${0.09 * smoothMouse.active})`
    );
    spot.addColorStop(1, "rgba(36, 87, 245, 0)");
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, w, h);
  }

  // 2. Subtle perspective floor plane reacting softly to pointer parallax
  ctx.save();
  const horizonY = pad.t + ph * 0.58 + parallaxY * 0.35;
  const bottomY = pad.t + ph;
  const vanishX = pad.l + pw * 0.5 + parallaxX * 1.05;
  ctx.strokeStyle = pal.isDark ? "rgba(140, 188, 255, 0.09)" : "rgba(36, 87, 245, 0.085)";
  ctx.lineWidth = 1;
  for (let i = -5; i <= 5; i++) {
    const bx = vanishX + i * (pw * 0.145) - parallaxX * 0.4;
    const hx = vanishX + i * (pw * 0.046);
    ctx.beginPath();
    ctx.moveTo(hx, horizonY);
    ctx.lineTo(bx, bottomY);
    ctx.stroke();
  }
  for (let row = 1; row <= 4; row++) {
    const f = Math.pow(row / 4, 1.48);
    const ry = horizonY + f * (bottomY - horizonY);
    ctx.beginPath();
    ctx.moveTo(pad.l, ry);
    ctx.lineTo(w - pad.r, ry);
    ctx.stroke();
  }
  ctx.restore();

  // 3. Clean Coordinate Axes
  ctx.save();
  ctx.font = '500 10px "IBM Plex Sans", "DM Sans", sans-serif';
  for (const r of [0, 6, 12, 18]) {
    const y = Y(r);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.strokeStyle = r === 0 ? pal.lineStrong : pal.line;
    ctx.setLineDash(r === 0 ? [] : [3, 5]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = "right";
    ctx.fillText(`${r}%`, pad.l - 10, y + 3.5);
  }

  for (const d of [7, 30, 90, 180, 270, 365]) {
    const x = X(d);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, bottomY);
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = pal.muted;
    ctx.textAlign = "center";
    ctx.fillText(d === 365 ? "1y" : `${d}d`, x, h - 12);
  }

  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t - 4);
  ctx.lineTo(pad.l, bottomY);
  ctx.strokeStyle = pal.lineStrong;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // 4. Sample Upper Lender Bid Curve & Lower Borrower Ask Curve
  const sampleCount = 72;
  const bidPts: { x: number; y: number }[] = [];
  const askPts: { x: number; y: number }[] = [];

  for (let i = 0; i <= sampleCount; i++) {
    const day = MIN_DAYS + (i / sampleCount) * (MAX_DAYS - MIN_DAYS);
    const px = X(day);
    bidPts.push({ x: px, y: Y(lenderBidRateAt(day, phase)) });
    askPts.push({ x: px, y: Y(borrowerAskRateAt(day, phase)) });
  }

  // Shaded Bid-Ask Yield Spread Corridor
  ctx.save();
  const spreadGrad = ctx.createLinearGradient(0, pad.t, 0, bottomY);
  if (pal.isDark) {
    spreadGrad.addColorStop(0, "rgba(66, 232, 176, 0.21)");
    spreadGrad.addColorStop(0.55, "rgba(106, 160, 255, 0.16)");
    spreadGrad.addColorStop(1, "rgba(255, 184, 102, 0.11)");
  } else {
    spreadGrad.addColorStop(0, "rgba(5, 135, 95, 0.15)");
    spreadGrad.addColorStop(0.55, "rgba(36, 87, 245, 0.12)");
    spreadGrad.addColorStop(1, "rgba(194, 89, 10, 0.09)");
  }
  ctx.beginPath();
  bidPts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  for (let i = askPts.length - 1; i >= 0; i--) ctx.lineTo(askPts[i].x, askPts[i].y);
  ctx.closePath();
  ctx.fillStyle = spreadGrad;
  ctx.fill();

  // Soft wash beneath lower Borrower Ask curve
  const askFill = ctx.createLinearGradient(0, pad.t + ph * 0.35, 0, bottomY);
  askFill.addColorStop(0, pal.isDark ? "rgba(255, 184, 102, 0.09)" : "rgba(194, 89, 10, 0.075)");
  askFill.addColorStop(1, "rgba(194, 89, 10, 0)");
  ctx.beginPath();
  askPts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.lineTo(askPts[askPts.length - 1].x, bottomY);
  ctx.lineTo(askPts[0].x, bottomY);
  ctx.closePath();
  ctx.fillStyle = askFill;
  ctx.fill();

  // LOWER Curve: Borrower Ask Curve (dashed amber)
  ctx.beginPath();
  askPts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = pal.ask;
  ctx.lineWidth = 2.0;
  ctx.setLineDash([6, 4]);
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // UPPER Curve: Standing Lender Bid Curve
  ctx.save();
  const bidGrad = ctx.createLinearGradient(pad.l, 0, w - pad.r, 0);
  bidGrad.addColorStop(0, pal.bid);
  bidGrad.addColorStop(0.62, pal.cobalt);
  bidGrad.addColorStop(1, pal.isDark ? "#a5c8ff" : "#1d4ed8");

  if (pal.isDark) {
    ctx.shadowColor = "rgba(66, 232, 176, 0.4)";
    ctx.shadowBlur = 15;
  }
  ctx.beginPath();
  bidPts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = bidGrad;
  ctx.lineWidth = 2.9;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();

  // Rolling control vertices along Lender Bid Curve
  for (const cd of CONTROL_DAYS) {
    const cx = X(cd);
    const cy = Y(lenderBidRateAt(cd, phase));
    ctx.beginPath();
    ctx.arc(cx, cy, 3.8, 0, Math.PI * 2);
    ctx.fillStyle = pal.card;
    ctx.fill();
    ctx.strokeStyle = pal.bid;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  // 5. Render Fixed On-Fill Borrower Asks (popping into place at fixed maturity X)
  for (const fa of fixedAsks) {
    if (fa.state === "cooldown" || fa.alpha <= 0.01) continue;
    const fx = X(fa.day);
    const fy = Y(fa.rate);
    const s = fa.popScale;

    ctx.save();
    ctx.globalAlpha = fa.alpha;

    // Subtle vertical maturity tether showing fixed on-fill duration
    const bidY = Y(lenderBidRateAt(fa.day, phase));
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(fx, bidY);
    ctx.strokeStyle = pal.ask;
    ctx.globalAlpha = fa.alpha * 0.28;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = fa.alpha;

    // Outer pop halo + architectural ring
    ctx.beginPath();
    ctx.arc(fx, fy, Math.max(0.5, 9.5 * s), 0, Math.PI * 2);
    ctx.fillStyle = pal.ask;
    ctx.globalAlpha = fa.alpha * 0.16;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(fx, fy, Math.max(0.5, 6.8 * s), 0, Math.PI * 2);
    ctx.strokeStyle = pal.ask;
    ctx.globalAlpha = fa.alpha * 0.55;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // Solid dot core
    ctx.globalAlpha = fa.alpha;
    ctx.beginPath();
    ctx.arc(fx, fy, Math.max(0.5, 4.1 * s), 0, Math.PI * 2);
    ctx.fillStyle = pal.ask;
    ctx.fill();
    ctx.strokeStyle = pal.card;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }

  // 6. Render Backward-Moving Resales & Fixed-Maturity Asks (gliding right -> left)
  for (const da of driftingAsks) {
    if (da.state !== "active" || da.alpha <= 0.01) continue;
    const col = da.kind === "resale" ? pal.cobalt : pal.ask;

    ctx.save();
    // Glowing wake trailing to the RIGHT (showing leftward maturity decay)
    if (da.trail.length > 1) {
      for (let k = 1; k < da.trail.length; k++) {
        const p0 = da.trail[k - 1];
        const p1 = da.trail[k];
        const frac = 1 - k / da.trail.length;
        ctx.beginPath();
        ctx.moveTo(X(p0.day), Y(p0.rate));
        ctx.lineTo(X(p1.day), Y(p1.rate));
        ctx.strokeStyle = col;
        ctx.globalAlpha = da.alpha * frac * 0.55;
        ctx.lineWidth = 2.6 * frac;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    }

    const dx = X(da.day);
    const dy = Y(da.rate);

    ctx.globalAlpha = da.alpha * 0.2;
    ctx.beginPath();
    ctx.arc(dx, dy, 9, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();

    ctx.globalAlpha = da.alpha;
    ctx.beginPath();
    ctx.arc(dx, dy, 4.1, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.strokeStyle = pal.card;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }

  // 7. Crisp Multi-Ring Fill Animations on Lender Curve Contact
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    if (dt > 0) b.age += dt * 1.15;
    if (b.age >= 1) {
      bursts.splice(i, 1);
      continue;
    }
    const bx = X(b.day);
    const by = Y(b.rate);
    const col = b.kind === "resale" ? pal.cobalt : pal.ask;

    ctx.save();
    // Primary expanding settlement ring
    const r1 = 5 + b.age * 28;
    ctx.beginPath();
    ctx.arc(bx, by, r1, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.globalAlpha = (1 - b.age) * 0.78;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Secondary emerald lender-match halo
    if (b.age < 0.75) {
      const f2 = b.age / 0.75;
      ctx.beginPath();
      ctx.arc(bx, by, 4 + f2 * 18, 0, Math.PI * 2);
      ctx.strokeStyle = pal.bid;
      ctx.globalAlpha = (1 - f2) * 0.7;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // Brief bright core flash at match instant
    if (b.age < 0.32) {
      const flash = 1 - b.age / 0.32;
      ctx.beginPath();
      ctx.arc(bx, by, 5.5 * flash + 2, 0, Math.PI * 2);
      ctx.fillStyle = pal.isDark ? "#ffffff" : col;
      ctx.globalAlpha = flash * 0.9;
      ctx.fill();
    }
    ctx.restore();
  }
}

function tick(ts: number) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  phase += dt;
  drawScene(dt);
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
    drawScene(0);
  }
}

function handlePointerMove(e: MouseEvent) {
  const cv = canvasRef.value;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  targetMouse.x = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
  targetMouse.y = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
  targetMouse.active = 1;
}

function handlePointerLeave() {
  targetMouse.x = 0.52;
  targetMouse.y = 0.46;
  targetMouse.active = 0;
}

watch(isVisible, syncMotion);

onMounted(() => {
  palette = readPalette();
  resizeCanvas();
  drawScene(0);

  if ("IntersectionObserver" in window && wrapperRef.value) {
    intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        isVisible.value = entry.isIntersecting;
      },
      { threshold: 0.05 }
    );
    intersectionObserver.observe(wrapperRef.value);
  }

  if ("ResizeObserver" in window && wrapperRef.value) {
    resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
      drawScene(0);
    });
    resizeObserver.observe(wrapperRef.value);
  }

  themeObserver = new MutationObserver(() => {
    palette = readPalette();
    drawScene(0);
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
  <div
    ref="wrapperRef"
    class="hero-plane-shell relative overflow-hidden rounded-[28px] border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-card)]"
    @mousemove="handlePointerMove"
    @mouseleave="handlePointerLeave"
  >
    <div
      class="pointer-events-none absolute top-4 right-5 left-12 z-10 flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5 text-[11.5px] font-medium text-[color:var(--sf-ink-2)]"
    >
      <span class="inline-flex items-center gap-1.5">
        <span class="h-2 w-2 rounded-full bg-[color:var(--sf-bid)]" />
        <span>Lender Bids</span>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="h-2 w-2 rounded-full bg-[color:var(--sf-cobalt)]" />
        <span>Resales</span>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="h-2 w-2 rounded-full bg-[color:var(--sf-ask)]" />
        <span>Borrower Asks</span>
      </span>
    </div>

    <canvas
      ref="canvasRef"
      class="block h-[330px] w-full select-none sm:h-[400px]"
      role="img"
      aria-label="Animated peer-to-peer yield plane showing fixed on-fill asks popping into place and resale asks moving backwards in maturity until filled by the standing lender curve."
    />
  </div>
</template>

<style scoped>
.hero-plane-shell {
  box-shadow: var(--sf-rim-top), var(--sf-shadow-hero);
}
</style>
