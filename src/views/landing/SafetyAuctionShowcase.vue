<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const wrapperRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const isVisible = ref(true);

interface Palette {
  isDark: boolean;
  card: string;
  paper: string;
  well: string;
  ink: string;
  ink2: string;
  muted: string;
  dim: string;
  line: string;
  lineStrong: string;
  cobalt: string;
  bid: string;
  ask: string;
}

const reduceMotion =
  typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

const targetMouse = { x: 0.5, y: 0.5, active: 0 };
const smoothMouse = { x: 0.5, y: 0.5, active: 0 };

const CATCH_LEVELS = [74, 68, 79, 65];

// Real Ergo ecosystem token icons preloaded for high-DPI canvas drawing
type IconKey = "erg" | "sigusd" | "rsbtc";
const ICON_URLS: Record<IconKey, string> = {
  erg: "/asset-icons/ergo.png",
  sigusd: "/asset-icons/sigusd.svg",
  rsbtc: "/asset-icons/rsbtc.svg"
};
const loadedIcons: Partial<Record<IconKey, { img: HTMLImageElement; ready: boolean }>> = {};

let palette: Palette | null = null;
let size = { w: 0, h: 0 };
let elapsed = 0;
let rafId = 0;
let lastTs = 0;
let ro: ResizeObserver | null = null;
let io: IntersectionObserver | null = null;
let mo: MutationObserver | null = null;

function readPalette(): Palette {
  const cs = window.getComputedStyle(document.documentElement);
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const get = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
  return {
    isDark,
    card: get("--sf-card", isDark ? "#121826" : "#f8faff"),
    paper: get("--sf-paper", isDark ? "#070a10" : "#e8eef7"),
    well: get("--sf-well", isDark ? "#1a2336" : "#dfe7f5"),
    ink: get("--sf-ink", isDark ? "#f8fafc" : "#0a1020"),
    ink2: get("--sf-ink-2", isDark ? "#d6e1f2" : "#30405a"),
    muted: get("--sf-muted", isDark ? "#9eb0cc" : "#556681"),
    dim: get("--sf-dim", isDark ? "#7b8fae" : "#70829e"),
    line: get("--sf-line", isDark ? "rgba(205,224,255,0.14)" : "rgba(15,29,58,0.1)"),
    lineStrong: get("--sf-line-strong", isDark ? "rgba(205,224,255,0.26)" : "rgba(15,29,58,0.18)"),
    cobalt: get("--sf-cobalt", isDark ? "#5c9bff" : "#2457f5"),
    bid: get("--sf-bid", isDark ? "#34eba9" : "#05875f"),
    ask: get("--sf-ask", isDark ? "#ffae52" : "#c2590a")
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

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawTokenIcon(
  ctx: CanvasRenderingContext2D,
  key: IconKey,
  cx: number,
  cy: number,
  r: number,
  withOverlapShadow = false
) {
  const entry = loadedIcons[key];
  if (!entry || !entry.ready) return;

  ctx.save();
  if (withOverlapShadow) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.32)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = -1.5;
  }
  ctx.drawImage(entry.img, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

function easeOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 3);
}

function easeInOutQuad(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
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

  // Subtle ambient lighting fields
  const leftBloom = ctx.createRadialGradient(w * 0.27, h * 0.5, 10, w * 0.27, h * 0.5, w * 0.4);
  leftBloom.addColorStop(0, pal.isDark ? "rgba(92, 155, 255, 0.14)" : "rgba(36, 87, 245, 0.10)");
  leftBloom.addColorStop(1, "rgba(36, 87, 245, 0)");
  ctx.fillStyle = leftBloom;
  ctx.fillRect(0, 0, w, h);

  const rightBloom = ctx.createRadialGradient(w * 0.74, h * 0.52, 12, w * 0.74, h * 0.52, w * 0.4);
  rightBloom.addColorStop(0, pal.isDark ? "rgba(255, 174, 82, 0.14)" : "rgba(194, 89, 10, 0.10)");
  rightBloom.addColorStop(1, "rgba(194, 89, 10, 0)");
  ctx.fillStyle = rightBloom;
  ctx.fillRect(0, 0, w, h);

  if (smoothMouse.active > 0.01) {
    const spot = ctx.createRadialGradient(
      smoothMouse.x * w,
      smoothMouse.y * h,
      6,
      smoothMouse.x * w,
      smoothMouse.y * h,
      w * 0.34
    );
    spot.addColorStop(
      0,
      pal.isDark
        ? `rgba(120, 178, 255, ${0.14 * smoothMouse.active})`
        : `rgba(36, 87, 245, ${0.08 * smoothMouse.active})`
    );
    spot.addColorStop(1, "rgba(36, 87, 245, 0)");
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, w, h);
  }

  const pad = w < 440 ? 14 : 22;
  const gap = w < 440 ? 12 : 18;
  const halfW = (w - pad * 2 - gap) * 0.5;

  /* ==============================================================
     LEFT CHAMBER: Multi-Asset Collateral Basket with Real Token Icons
     ============================================================== */
  const vx = pad;
  const vy = pad;
  const vw = halfW;
  const vh = h - pad * 2;

  ctx.save();
  roundRect(ctx, vx, vy, vw, vh, 16);
  ctx.fillStyle = pal.isDark ? "rgba(7, 10, 16, 0.65)" : "rgba(232, 238, 247, 0.68)";
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Header inside vault chamber
  ctx.font = '600 10px "IBM Plex Sans", "DM Sans", sans-serif';
  ctx.fillStyle = pal.muted;
  ctx.textAlign = "left";
  ctx.fillText("COLLATERAL BASKET", vx + 16, vy + 24);

  // Vault Circular Emblem + 2x2 Floating Token Icon Medallions
  const basketCx = vx + vw * 0.5;
  const basketCy = vy + vh * 0.51;
  const vaultR = Math.min(vw * 0.42, vh * 0.34);

  // Subtle concentric vault guard rings
  ctx.save();
  ctx.beginPath();
  ctx.arc(basketCx, basketCy, vaultR, 0, Math.PI * 2);
  ctx.fillStyle = pal.isDark ? "rgba(18, 24, 38, 0.55)" : "rgba(248, 250, 255, 0.62)";
  ctx.fill();
  ctx.strokeStyle = pal.lineStrong;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Slow rotating outer dashed oracle protection ring
  ctx.beginPath();
  ctx.arc(basketCx, basketCy, vaultR + 10, 0, Math.PI * 2);
  ctx.strokeStyle = pal.bid;
  ctx.globalAlpha = pal.isDark ? 0.32 : 0.28;
  ctx.setLineDash([4, 7]);
  ctx.lineDashOffset = -elapsed * 10;
  ctx.lineWidth = 1.25;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Two gentle sentinel orbit particles circling the vault guard ring
  for (let s = 0; s < 2; s++) {
    const a = elapsed * 0.45 + s * Math.PI;
    const sx = basketCx + Math.cos(a) * (vaultR + 10);
    const sy = basketCy + Math.sin(a) * (vaultR + 10);
    ctx.beginPath();
    ctx.arc(sx, sy, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = s === 0 ? pal.bid : pal.cobalt;
    ctx.fill();
  }
  ctx.restore();

  // Positions of the 4 basket assets cleanly arranged inside the vault
  const spreadX = Math.min(vw * 0.24, 62);
  const spreadY = Math.min(vh * 0.19, 54);
  const coinR = Math.max(15, Math.min(19, vw * 0.075));

  interface SingleItem {
    kind: "single";
    key: IconKey;
    label: string;
    x: number;
    y: number;
    accent: string;
    phase: number;
  }
  interface PairItem {
    kind: "lp";
    leftKey: IconKey;
    rightKey: IconKey;
    label: string;
    x: number;
    y: number;
    accent: string;
    phase: number;
  }

  const items: (SingleItem | PairItem)[] = [
    {
      kind: "single",
      key: "erg",
      label: "ERG",
      x: basketCx - spreadX,
      y: basketCy - spreadY,
      accent: pal.cobalt,
      phase: 0
    },
    {
      kind: "single",
      key: "sigusd",
      label: "SigUSD",
      x: basketCx + spreadX,
      y: basketCy - spreadY,
      accent: pal.bid,
      phase: 1.4
    },
    {
      kind: "single",
      key: "rsbtc",
      label: "rsBTC",
      x: basketCx - spreadX,
      y: basketCy + spreadY,
      accent: pal.ask,
      phase: 2.7
    },
    {
      kind: "lp",
      leftKey: "erg",
      rightKey: "sigusd",
      label: "Wrapped LP",
      x: basketCx + spreadX,
      y: basketCy + spreadY,
      accent: pal.cobalt,
      phase: 4.1
    }
  ];

  // Subtle geometric links stopping cleanly outside each icon (zero lines peeking behind octagons)
  ctx.save();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  for (const it of items) {
    const fy = it.y + Math.sin(elapsed * 1.15 + it.phase) * 2.2;
    const dx = it.x - basketCx;
    const dy = fy - basketCy;
    const dist = Math.hypot(dx, dy) || 1;
    const stopGap = it.kind === "lp" ? coinR + 14 : coinR + 7;
    if (dist > stopGap + 8) {
      const endX = basketCx + (dx / dist) * (dist - stopGap);
      const endY = basketCy + (dy / dist) * (dist - stopGap);
      ctx.beginPath();
      ctx.moveTo(basketCx, basketCy);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    }
  }
  // Tiny subtle center vault hub dot
  ctx.beginPath();
  ctx.arc(basketCx, basketCy, 3, 0, Math.PI * 2);
  ctx.fillStyle = pal.bid;
  ctx.fill();
  ctx.restore();

  // Draw clean token icons directly (zero background, ring, or halo peeking behind the octagons!)
  for (const it of items) {
    const iy = it.y + Math.sin(elapsed * 1.15 + it.phase) * 2.2;
    ctx.save();

    if (it.kind === "single") {
      drawTokenIcon(ctx, it.key, it.x, iy, coinR, false);
    } else {
      // Standard Liquidity Position Pair: Two clean smaller overlapping octagons side-by-side
      const lpR = Math.round(coinR * 0.82);
      const overlap = Math.round(lpR * 0.62);

      drawTokenIcon(ctx, it.leftKey, it.x - overlap, iy, lpR, false);
      drawTokenIcon(ctx, it.rightKey, it.x + overlap, iy, lpR, true);
    }

    // Crisp token label below icon
    ctx.font = '600 10.5px "IBM Plex Sans", "DM Sans", sans-serif';
    ctx.fillStyle = pal.ink2;
    ctx.textAlign = "center";
    ctx.fillText(it.label, it.x, iy + coinR + 15);
    ctx.restore();
  }

  // Bottom vault caption
  ctx.font = '600 10.5px "IBM Plex Sans", sans-serif';
  ctx.fillStyle = pal.bid;
  ctx.textAlign = "center";
  ctx.fillText("Unified multi-asset vault", basketCx, vy + vh - 16);
  ctx.restore();

  /* ==============================================================
     RIGHT CHAMBER: Falling-Price Dutch Auction Drop Tower (No Graph!)
     ============================================================== */
  const ax = pad + halfW + gap;
  const ay = pad;
  const aw = halfW;
  const ah = h - pad * 2;

  ctx.save();
  roundRect(ctx, ax, ay, aw, ah, 16);
  ctx.fillStyle = pal.isDark ? "rgba(7, 10, 16, 0.65)" : "rgba(232, 238, 247, 0.68)";
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = '600 10px "IBM Plex Sans", "DM Sans", sans-serif';
  ctx.fillStyle = pal.muted;
  ctx.textAlign = "left";
  ctx.fillText("DUTCH AUCTION", ax + 16, ay + 24);

  const trackTop = ay + 54;
  const trackBot = ay + ah - 32;
  const trackH = trackBot - trackTop;
  const priceToY = (pct: number) => trackTop + ((100 - pct) / 40) * trackH;
  const railX = ax + aw * 0.55;

  for (const pct of [100, 90, 80, 70, 60]) {
    const ry = priceToY(pct);
    ctx.beginPath();
    ctx.moveTo(ax + 44, ry);
    ctx.lineTo(ax + aw - 16, ry);
    ctx.strokeStyle = pct === 60 ? pal.lineStrong : pal.line;
    ctx.setLineDash(pct === 60 ? [] : [2, 5]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '500 9.5px "IBM Plex Sans", sans-serif';
    ctx.fillStyle = pct === 60 ? pal.muted : pal.dim;
    ctx.textAlign = "right";
    ctx.fillText(pct === 60 ? "Floor" : `${pct}%`, ax + 38, ry + 3);
  }

  ctx.beginPath();
  ctx.moveTo(railX, trackTop);
  ctx.lineTo(railX, trackBot);
  ctx.strokeStyle = pal.lineStrong;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const cycleDur = 6.2;
  const cycleIdx = Math.floor(elapsed / cycleDur);
  const c = (elapsed % cycleDur) / cycleDur;
  const catchPct = CATCH_LEVELS[cycleIdx % CATCH_LEVELS.length];

  let curPct = 100;
  let lotAlpha = 1;
  let clearedFrac = 0;
  let statusText = "OPENING";
  let statusColor = pal.ask;

  if (c < 0.14) {
    curPct = 100;
    lotAlpha = easeOutCubic(c / 0.14);
    statusText = "OPENING";
  } else if (c < 0.66) {
    const f = easeInOutQuad((c - 0.14) / 0.52);
    curPct = 100 - f * (100 - catchPct);
    statusText = "FALLING";
  } else if (c < 0.86) {
    curPct = catchPct;
    clearedFrac = easeOutCubic((c - 0.66) / 0.2);
    statusText = "CLEARED";
    statusColor = pal.bid;
  } else {
    curPct = catchPct;
    clearedFrac = 1;
    lotAlpha = 1 - easeOutCubic((c - 0.86) / 0.14);
    statusText = "CLEARED";
    statusColor = pal.bid;
  }

  ctx.font = '600 10px "IBM Plex Sans", sans-serif';
  ctx.fillStyle = statusColor;
  ctx.textAlign = "right";
  ctx.fillText(statusText, ax + aw - 16, ay + 24);

  const lotY = priceToY(curPct);

  if (curPct < 99.6 && lotAlpha > 0.02) {
    ctx.save();
    ctx.globalAlpha = lotAlpha;
    const trailGrad = ctx.createLinearGradient(railX, trackTop, railX, lotY);
    trailGrad.addColorStop(0, "transparent");
    trailGrad.addColorStop(
      1,
      clearedFrac > 0.05
        ? pal.isDark
          ? "rgba(52, 235, 169, 0.42)"
          : "rgba(5, 135, 95, 0.34)"
        : pal.isDark
          ? "rgba(255, 174, 82, 0.44)"
          : "rgba(194, 89, 10, 0.34)"
    );
    ctx.fillStyle = trailGrad;
    ctx.fillRect(railX - 18, trackTop, 36, Math.max(0, lotY - trackTop));

    ctx.beginPath();
    ctx.moveTo(railX, trackTop);
    ctx.lineTo(railX, lotY);
    ctx.strokeStyle = clearedFrac > 0.05 ? pal.bid : pal.ask;
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.restore();
  }

  if (clearedFrac > 0.01 && lotAlpha > 0.02) {
    ctx.save();
    const ringR = 16 + clearedFrac * 34;
    ctx.beginPath();
    ctx.arc(railX, lotY, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = pal.bid;
    ctx.globalAlpha = (1 - clearedFrac * 0.82) * lotAlpha * 0.65;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(ax + aw - 14, lotY);
    ctx.lineTo(railX + 42, lotY);
    ctx.strokeStyle = pal.bid;
    ctx.globalAlpha = lotAlpha * 0.72;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // Sculpted Falling Collateral Lot Capsule carrying miniature real token icons!
  if (lotAlpha > 0.02) {
    const lotW = Math.min(126, aw - 56);
    const lotH = 40;
    const lx = railX - lotW * 0.5;
    const ly = lotY - lotH * 0.5;
    const accent = clearedFrac > 0.05 ? pal.bid : pal.ask;

    ctx.save();
    ctx.globalAlpha = lotAlpha;

    const halo = ctx.createRadialGradient(railX, lotY, 4, railX, lotY, lotW * 0.65);
    halo.addColorStop(
      0,
      clearedFrac > 0.05
        ? pal.isDark
          ? "rgba(52, 235, 169, 0.25)"
          : "rgba(5, 135, 95, 0.2)"
        : pal.isDark
          ? "rgba(255, 174, 82, 0.25)"
          : "rgba(194, 89, 10, 0.2)"
    );
    halo.addColorStop(1, "transparent");
    ctx.fillStyle = halo;
    ctx.fillRect(lx - 24, ly - 24, lotW + 48, lotH + 48);

    roundRect(ctx, lx, ly, lotW, lotH, 11);
    ctx.fillStyle = pal.card;
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Overlapping miniature real Ergo token icons on the left of the falling lot (no backing circles!)
    const miniR = 8.5;
    drawTokenIcon(ctx, "erg", lx + 17, lotY, miniR, false);
    drawTokenIcon(ctx, "sigusd", lx + 28, lotY, miniR, true);
    drawTokenIcon(ctx, "rsbtc", lx + 39, lotY, miniR, true);

    ctx.font = '700 12.5px "IBM Plex Sans", sans-serif';
    ctx.fillStyle = accent;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(curPct)}%`, lx + lotW - 11, lotY + 0.5);
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  ctx.restore();
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
  // Preload token icons cleanly with explicit square size for SVGs; redraw automatically once loaded
  (Object.keys(ICON_URLS) as IconKey[]).forEach((k) => {
    const img = new Image(128, 128);
    const entry = { img, ready: false };
    loadedIcons[k] = entry;
    img.onload = () => {
      entry.ready = true;
      draw(0);
    };
    img.src = ICON_URLS[k];
  });

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
    class="showcase-frame relative overflow-hidden rounded-[28px] rounded-bl-[6px] border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-card)]"
    @mousemove="onMove"
    @mouseleave="onLeave"
  >
    <canvas
      ref="canvasRef"
      class="block h-[350px] w-full select-none sm:h-[400px]"
      role="img"
      aria-label="Animated multi-asset collateral vault holding ERG, SigUSD, rsBTC, and a wrapped LP token pair alongside a falling-price Dutch auction drop column."
    />
  </div>
</template>

<style scoped>
.showcase-frame {
  box-shadow: var(--sf-rim-top), var(--sf-shadow-hero);
}
</style>
