<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const wrapperRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const isVisible = ref(true);

const COLS = 20;
const ROWS = 5;
const CYCLE_SEC = 9.8;

interface Palette {
  isDark: boolean;
  card: string;
  paper: string;
  ink: string;
  ink2: string;
  muted: string;
  line: string;
  lineStrong: string;
  cobalt: string;
  bid: string;
  cCobalt: [number, number, number];
  cBid: [number, number, number];
}

const reduceMotion =
  typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

const targetMouse = { x: 0.5, y: 0.5, active: 0 };
const smoothMouse = { x: 0.5, y: 0.5, active: 0 };

let palette: Palette | null = null;
let size = { w: 0, h: 0 };
let elapsed = 0;
let rafId = 0;
let lastTs = 0;
let ro: ResizeObserver | null = null;
let io: IntersectionObserver | null = null;
let mo: MutationObserver | null = null;

function parseRgb(val: string, fallback: [number, number, number]): [number, number, number] {
  const el = document.createElement("span");
  el.style.color = val;
  el.style.display = "none";
  document.body.appendChild(el);
  const res = window.getComputedStyle(el).color;
  document.body.removeChild(el);
  const m = res.match(/[\d.]+/g);
  if (m && m.length >= 3) return [Number(m[0]), Number(m[1]), Number(m[2])];
  return fallback;
}

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * c),
    Math.round(a[1] + (b[1] - a[1]) * c),
    Math.round(a[2] + (b[2] - a[2]) * c)
  ];
}

function readPalette(): Palette {
  const cs = window.getComputedStyle(document.documentElement);
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const get = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
  const cobalt = get("--sf-cobalt", isDark ? "#5c9bff" : "#2457f5");
  const bid = get("--sf-bid", isDark ? "#34eba9" : "#05875f");

  return {
    isDark,
    card: get("--sf-card", isDark ? "#121826" : "#f8faff"),
    paper: get("--sf-paper", isDark ? "#070a10" : "#e8eef7"),
    ink: get("--sf-ink", isDark ? "#f8fafc" : "#0a1020"),
    ink2: get("--sf-ink-2", isDark ? "#d6e1f2" : "#30405a"),
    muted: get("--sf-muted", isDark ? "#9eb0cc" : "#556681"),
    line: get("--sf-line", isDark ? "rgba(205,224,255,0.14)" : "rgba(15,29,58,0.1)"),
    lineStrong: get("--sf-line-strong", isDark ? "rgba(205,224,255,0.26)" : "rgba(15,29,58,0.18)"),
    cobalt,
    bid,
    cCobalt: parseRgb(cobalt, isDark ? [92, 155, 255] : [36, 87, 245]),
    cBid: parseRgb(bid, isDark ? [52, 235, 169] : [5, 135, 95])
  };
}

function resize() {
  const cv = canvasRef.value;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  size = { w: r.width, h: r.height };
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  cv.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

function easeInOutCubic(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

function roundRectRadii(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number
) {
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.quadraticCurveTo(x, y, x + tl, y);
  ctx.closePath();
}

function drawSolidMonolith(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  pal: Palette
) {
  const topRgb = pal.cCobalt;
  const botScale = pal.isDark ? 0.82 : 0.86;
  const botRgb: [number, number, number] = [
    Math.round(topRgb[0] * botScale),
    Math.round(topRgb[1] * botScale),
    Math.round(topRgb[2] * botScale)
  ];
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, `rgb(${topRgb[0]},${topRgb[1]},${topRgb[2]})`);
  grad.addColorStop(1, `rgb(${botRgb[0]},${botRgb[1]},${botRgb[2]})`);

  ctx.save();
  roundRectRadii(ctx, x, y, w, h, r, r, r, r);
  ctx.fillStyle = grad;
  ctx.fill();

  // Top specular rim light
  ctx.beginPath();
  ctx.moveTo(x + r, y + 0.8);
  ctx.lineTo(x + w - r, y + 0.8);
  ctx.strokeStyle = pal.isDark ? "rgba(255,255,255,0.34)" : "rgba(255,255,255,0.52)";
  ctx.lineWidth = 1.1;
  ctx.stroke();

  roundRectRadii(ctx, x, y, w, h, r, r, r, r);
  ctx.strokeStyle = pal.isDark ? "rgba(200, 224, 255, 0.28)" : "rgba(255, 255, 255, 0.45)";
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.restore();
}

function draw(dt: number) {
  const cv = canvasRef.value;
  if (!cv || !palette) return;
  const ctx = cv.getContext("2d");
  const { w, h } = size;
  if (!ctx || !w || !h) return;

  const pal = palette;
  const damp = dt > 0 ? Math.min(1, dt * 5) : 1;
  smoothMouse.x += (targetMouse.x - smoothMouse.x) * damp;
  smoothMouse.y += (targetMouse.y - smoothMouse.y) * damp;
  smoothMouse.active += (targetMouse.active - smoothMouse.active) * damp;

  ctx.clearRect(0, 0, w, h);

  // Atmospheric glow behind monolith
  const bgGlow = ctx.createRadialGradient(w * 0.5, h * 0.52, 16, w * 0.5, h * 0.52, w * 0.52);
  bgGlow.addColorStop(0, pal.isDark ? "rgba(92, 155, 255, 0.18)" : "rgba(36, 87, 245, 0.13)");
  bgGlow.addColorStop(0.58, pal.isDark ? "rgba(52, 235, 169, 0.06)" : "rgba(5, 135, 95, 0.06)");
  bgGlow.addColorStop(1, "transparent");
  ctx.fillStyle = bgGlow;
  ctx.fillRect(0, 0, w, h);

  if (smoothMouse.active > 0.01) {
    const spot = ctx.createRadialGradient(
      smoothMouse.x * w,
      smoothMouse.y * h,
      8,
      smoothMouse.x * w,
      smoothMouse.y * h,
      w * 0.34
    );
    spot.addColorStop(
      0,
      pal.isDark
        ? `rgba(130, 184, 255, ${0.14 * smoothMouse.active})`
        : `rgba(36, 87, 245, ${0.09 * smoothMouse.active})`
    );
    spot.addColorStop(1, "transparent");
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, w, h);
  }

  // Seamless 6-Act Loop (0 .. 9.8s)
  // Act 1 (0.00 - 1.10s): Solid 1 Whole Bond Unit monolith
  // Act 2 (1.10 - 2.65s): Crisp cut lines progressively score the solid monolith BEFORE splitting
  // Act 3 (2.65 - 4.15s): Exact-size tiles smoothly translate outward into 100 spaced shares
  // Act 4 (4.15 - 6.95s): Right 25% slice levitates gently up & right, then settles back flush
  // Act 5 (6.95 - 8.35s): Exact-size tiles glide smoothly back together (NO box scaling/puffing!)
  // Act 6 (8.35 - 9.80s): Solid monolith underneath + cut lines smoothly fade out to full bond color!
  const t = elapsed % CYCLE_SEC;

  let statusLabel = "1 Whole Bond Unit";
  let statusCol = pal.cobalt;
  if (t >= 1.1 && t < 2.65) {
    statusLabel = "Scoring 100 Shares";
    statusCol = pal.cobalt;
  } else if (t >= 2.65 && t < 4.15) {
    statusLabel = "100 Fungible Shares";
    statusCol = pal.bid;
  } else if (t >= 4.15 && t < 7.05) {
    statusLabel = "25% Listed · 75% Held";
    statusCol = pal.bid;
  } else if (t >= 7.05 && t < 9.35) {
    statusLabel = "Recombining Unit";
    statusCol = pal.cobalt;
  }

  ctx.save();
  ctx.font = '600 10.5px "IBM Plex Sans", "DM Sans", sans-serif';
  ctx.fillStyle = pal.muted;
  ctx.textAlign = "left";
  ctx.fillText("BOND FRACTIONALIZATION", 24, 30);

  ctx.fillStyle = statusCol;
  ctx.textAlign = "right";
  ctx.fillText(statusLabel, w - 24, 30);
  ctx.restore();

  // Constant monolith dimensions (tiles NEVER scale/expand unevenly!)
  const marginX = w < 460 ? 28 : 48;
  const maxGridW = w - marginX * 2 - 26;
  const baseCellW = Math.min(21, maxGridW / COLS);
  const baseCellH = Math.min(33, (h - 122) / ROWS);
  const monoW = baseCellW * COLS;
  const monoH = baseCellH * ROWS;
  const originX = (w - monoW) * 0.5 - 4;
  const originY = (h - monoH) * 0.5 + 14;
  const outerR = 12;

  const maxGapX = Math.max(3.4, baseCellW * 0.22);
  const maxGapY = Math.max(3.8, baseCellH * 0.18);

  // Soft cast shadow beneath monolith
  ctx.save();
  const shadowGrad = ctx.createRadialGradient(
    originX + monoW * 0.5,
    originY + monoH + 14,
    12,
    originX + monoW * 0.5,
    originY + monoH + 14,
    monoW * 0.56
  );
  shadowGrad.addColorStop(0, pal.isDark ? "rgba(0, 0, 0, 0.58)" : "rgba(18, 35, 74, 0.16)");
  shadowGrad.addColorStop(1, "transparent");
  ctx.fillStyle = shadowGrad;
  ctx.fillRect(originX - 40, originY + monoH - 10, monoW + 80, 48);
  ctx.restore();

  const cutLineColor = pal.isDark ? "rgba(7, 10, 16, 0.88)" : "rgba(248, 250, 255, 0.92)";
  const cutDotColor = pal.isDark ? "#070a10" : "#ffffff";

  // ==============================================================
  // ACTS 1, 2, & 6: Solid Unified Monolith + Drawing or Fading Cut Lines
  // ==============================================================
  if (t < 2.65 || t >= 8.35) {
    drawSolidMonolith(ctx, originX, originY, monoW, monoH, outerR, pal);

    // Act 2: Progressive Laser Scoring Lines before split
    if (t >= 1.1 && t < 2.65) {
      const drawP = clamp01((t - 1.1) / 1.4);
      ctx.save();
      roundRectRadii(ctx, originX, originY, monoW, monoH, outerR, outerR, outerR, outerR);
      ctx.clip();

      for (let c = 1; c < COLS; c++) {
        const stagger = ((c - 1) / (COLS - 2)) * 0.36;
        const p = easeOutCubic(clamp01((drawP - stagger) / 0.52));
        if (p <= 0) continue;
        const lx = originX + c * baseCellW;
        const endY = originY + monoH * p;

        ctx.beginPath();
        ctx.moveTo(lx, originY);
        ctx.lineTo(lx, endY);
        ctx.strokeStyle = cutLineColor;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        if (p > 0.04 && p < 0.98) {
          ctx.beginPath();
          ctx.arc(lx, endY, 2.2, 0, Math.PI * 2);
          ctx.fillStyle = cutDotColor;
          ctx.fill();
        }
      }

      for (let r = 1; r < ROWS; r++) {
        const stagger = 0.24 + ((r - 1) / Math.max(1, ROWS - 2)) * 0.24;
        const p = easeOutCubic(clamp01((drawP - stagger) / 0.5));
        if (p <= 0) continue;
        const ly = originY + r * baseCellH;
        const endX = originX + monoW * p;

        ctx.beginPath();
        ctx.moveTo(originX, ly);
        ctx.lineTo(endX, ly);
        ctx.strokeStyle = cutLineColor;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        if (p > 0.04 && p < 0.98) {
          ctx.beginPath();
          ctx.arc(endX, ly, 2.2, 0, Math.PI * 2);
          ctx.fillStyle = cutDotColor;
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Act 6: Cut lines fade cleanly out into the full bond's solid cobalt color!
    if (t >= 8.35) {
      const fadeOut = 1 - easeInOutCubic(clamp01((t - 8.35) / 1.1));
      if (fadeOut > 0.005) {
        ctx.save();
        roundRectRadii(ctx, originX, originY, monoW, monoH, outerR, outerR, outerR, outerR);
        ctx.clip();
        ctx.strokeStyle = cutLineColor;
        ctx.globalAlpha = fadeOut;
        ctx.lineWidth = 1.2;

        ctx.beginPath();
        for (let c = 1; c < COLS; c++) {
          const lx = originX + c * baseCellW;
          ctx.moveTo(lx, originY);
          ctx.lineTo(lx, originY + monoH);
        }
        for (let r = 1; r < ROWS; r++) {
          const ly = originY + r * baseCellH;
          ctx.moveTo(originX, ly);
          ctx.lineTo(originX + monoW, ly);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
    return;
  }

  // ==============================================================
  // ACTS 3, 4, & 5: Constant-Size 100 Share Tiles (Split -> Lift -> Clean Flush Slide Back)
  // ==============================================================
  let sliceLift = 0;
  if (t >= 4.15 && t < 5.0) {
    sliceLift = easeInOutCubic((t - 4.15) / 0.85);
  } else if (t >= 5.0 && t < 6.15) {
    sliceLift = 1;
  } else if (t >= 6.15 && t < 6.95) {
    sliceLift = 1 - easeInOutCubic((t - 6.15) / 0.8);
  }

  const isSplitting = t >= 2.65 && t < 4.15;
  const isReturning = t >= 6.95 && t < 8.35;

  // Constant visual cut seam width (matches the 1.2px drawn cut lines exactly with 0px shift on outer edges!)
  const halfSeam = 0.6;

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const distNorm = Math.hypot((col - 9.5) / 10, (row - 2) / 3);
      let localSplit = 1;

      if (isSplitting) {
        const stagger = Math.min(1, distNorm) * 0.16;
        localSplit = easeOutCubic(clamp01(((t - 2.65) / 1.5 - stagger) / (1 - 0.16)));
      } else if (isReturning) {
        // Uniform silky return so all rows/cols seat cleanly together without uneven puffing
        localSplit = 1 - easeInOutCubic(clamp01((t - 6.95) / 1.4));
      }

      const isResaleSlice = col >= 15;
      const liftX = isResaleSlice ? sliceLift * 14 : 0;
      const liftY = isResaleSlice ? -sliceLift * 18 : 0;

      const offsetX = (col - (COLS - 1) * 0.5) * maxGapX * localSplit;
      const offsetY = (row - (ROWS - 1) * 0.5) * maxGapY * localSplit;

      const leftInset = col === 0 ? 0 : halfSeam;
      const rightInset = col === COLS - 1 ? 0 : halfSeam;
      const topInset = row === 0 ? 0 : halfSeam;
      const botInset = row === ROWS - 1 ? 0 : halfSeam;

      const tw = baseCellW - leftInset - rightInset;
      const th = baseCellH - topInset - botInset;
      const tx = originX + col * baseCellW + leftInset + offsetX + liftX;
      const ty = originY + row * baseCellH + topInset + offsetY + liftY;

      const tileR = 3.8 * localSplit;
      const tl = row === 0 && col === 0 ? outerR * (1 - localSplit) + tileR : tileR;
      const tr = row === 0 && col === COLS - 1 ? outerR * (1 - localSplit) + tileR : tileR;
      const br = row === ROWS - 1 && col === COLS - 1 ? outerR * (1 - localSplit) + tileR : tileR;
      const bl = row === ROWS - 1 && col === 0 ? outerR * (1 - localSplit) + tileR : tileR;

      // Color smoothly morphs: Cobalt (flush) <-> Emerald (shares) <-> Cobalt (lifted 25% resale slice)
      const shareHueMix = isResaleSlice ? localSplit * (1 - sliceLift) : localSplit;
      const baseRgb = mixRgb(pal.cCobalt, pal.cBid, shareHueMix * 0.92);

      // Exact same vertical gradient shading as the solid monolith so the handoff at t=2.65s & t=8.35s is 100% invisible!
      const rowFrac = (row + 0.5) / ROWS;
      const botScale = pal.isDark ? 0.82 : 0.86;
      const rowShade = 1 - rowFrac * (1 - botScale);
      const rCol = Math.round(baseRgb[0] * rowShade);
      const gCol = Math.round(baseRgb[1] * rowShade);
      const bCol = Math.round(baseRgb[2] * rowShade);

      if (isResaleSlice && sliceLift > 0.05) {
        ctx.save();
        roundRectRadii(ctx, tx, ty + sliceLift * 10, tw, th, tl, tr, br, bl);
        ctx.fillStyle = pal.isDark
          ? `rgba(0, 0, 0, ${0.38 * sliceLift})`
          : `rgba(18, 35, 74, ${0.14 * sliceLift})`;
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      roundRectRadii(ctx, tx, ty, tw, th, tl, tr, br, bl);
      ctx.fillStyle = `rgb(${rCol},${gCol},${bCol})`;
      ctx.fill();

      if (localSplit > 0.08 || row === 0) {
        ctx.beginPath();
        ctx.moveTo(tx + tl, ty + 0.7);
        ctx.lineTo(tx + tw - tr, ty + 0.7);
        ctx.strokeStyle = pal.isDark ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.46)";
        ctx.globalAlpha = row === 0 ? 0.85 : localSplit * 0.7;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

function tick(ts: number) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  elapsed += dt;
  draw(dt);
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
    draw(0);
  }
}

function onMove(e: MouseEvent) {
  const cv = canvasRef.value;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  targetMouse.x = (e.clientX - r.left) / Math.max(1, r.width);
  targetMouse.y = (e.clientY - r.top) / Math.max(1, r.height);
  targetMouse.active = 1;
}

function onLeave() {
  targetMouse.active = 0;
}

watch(isVisible, syncMotion);

onMounted(() => {
  palette = readPalette();
  resize();
  draw(0);

  if ("IntersectionObserver" in window && wrapperRef.value) {
    io = new IntersectionObserver(([e]) => (isVisible.value = e.isIntersecting), { threshold: 0.08 });
    io.observe(wrapperRef.value);
  }
  if ("ResizeObserver" in window && wrapperRef.value) {
    ro = new ResizeObserver(() => {
      resize();
      draw(0);
    });
    ro.observe(wrapperRef.value);
  }
  mo = new MutationObserver(() => {
    palette = readPalette();
    draw(0);
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  reduceMotion?.addEventListener("change", syncMotion);
  document.addEventListener("visibilitychange", syncMotion);
  syncMotion();
});

onBeforeUnmount(() => {
  io?.disconnect();
  ro?.disconnect();
  mo?.disconnect();
  reduceMotion?.removeEventListener("change", syncMotion);
  document.removeEventListener("visibilitychange", syncMotion);
  if (rafId) window.cancelAnimationFrame(rafId);
});
</script>

<template>
  <div
    ref="wrapperRef"
    class="showcase-frame relative overflow-hidden rounded-[28px] rounded-tl-[6px] border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-card)]"
    @mousemove="onMove"
    @mouseleave="onLeave"
  >
    <canvas
      ref="canvasRef"
      class="block h-[300px] w-full select-none sm:h-[340px]"
      role="img"
      aria-label="Smooth animation of a whole bond block scored by cut lines, separating into 100 fungible shares with a 25 percent slice lifting out, sliding back flush, and fading cut lines seamlessly back into the whole bond."
    />
  </div>
</template>

<style scoped>
.showcase-frame {
  box-shadow: var(--sf-rim-top), var(--sf-shadow-hero);
}
</style>
