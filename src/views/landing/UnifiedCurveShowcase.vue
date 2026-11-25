<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const wrapperRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const isVisible = ref(true);

interface Palette {
  isDark: boolean;
  card: string;
  paper: string;
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

type PeerRole = "borrower" | "lender" | "reseller";

interface PeerNode {
  id: number;
  role: PeerRole;
  label: string;
  angle: number;
  radiusScale: number;
  flare: number;
}

interface BilateralSwap {
  fromIdx: number;
  toIdx: number;
  kind: "loan" | "resale";
  t: number;
  speed: number;
  coreFlashed: boolean;
}

const PEERS: PeerNode[] = [
  { id: 0, role: "borrower", label: "Borrower", angle: Math.PI * 0.85, radiusScale: 0.86, flare: 0 },
  { id: 1, role: "reseller", label: "Bond Reseller", angle: Math.PI * 1.18, radiusScale: 0.88, flare: 0 },
  { id: 2, role: "borrower", label: "Borrower", angle: Math.PI * 0.56, radiusScale: 0.84, flare: 0 },
  { id: 3, role: "lender", label: "Lender", angle: -Math.PI * 0.16, radiusScale: 0.88, flare: 0 },
  { id: 4, role: "lender", label: "Lender", angle: Math.PI * 0.18, radiusScale: 0.86, flare: 0 },
  { id: 5, role: "reseller", label: "Share Seller", angle: -Math.PI * 0.52, radiusScale: 0.84, flare: 0 }
];

const SWAP_PAIRS: { fromIdx: number; toIdx: number; kind: "loan" | "resale" }[] = [
  { fromIdx: 0, toIdx: 3, kind: "loan" },
  { fromIdx: 1, toIdx: 4, kind: "resale" },
  { fromIdx: 5, toIdx: 4, kind: "resale" },
  { fromIdx: 2, toIdx: 3, kind: "loan" },
  { fromIdx: 1, toIdx: 3, kind: "resale" },
  { fromIdx: 0, toIdx: 4, kind: "loan" }
];

const swaps: BilateralSwap[] = [
  { fromIdx: 0, toIdx: 3, kind: "loan", t: 0.18, speed: 0.34, coreFlashed: false },
  { fromIdx: 1, toIdx: 4, kind: "resale", t: 0.62, speed: 0.31, coreFlashed: true }
];

let nextPairIdx = 2;
let spawnCooldown = 0.8;

const targetMouse = { x: 0.5, y: 0.5, active: 0 };
const smoothMouse = { x: 0.5, y: 0.5, active: 0 };

const reduceMotion =
  typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

let palette: Palette | null = null;
let size = { w: 0, h: 0 };
let elapsed = 0;
let coreGlow = 0;
let coreGlowColor: "cobalt" | "ask" | "bid" = "cobalt";
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
    card: get("--sf-card", isDark ? "#0e1629" : "#f8faff"),
    paper: get("--sf-paper", isDark ? "#060a14" : "#e8eef7"),
    ink: get("--sf-ink", isDark ? "#f4f7ff" : "#0a1020"),
    ink2: get("--sf-ink-2", isDark ? "#c6d4ea" : "#30405a"),
    muted: get("--sf-muted", isDark ? "#8c9fbc" : "#556681"),
    dim: get("--sf-dim", isDark ? "#6c80a2" : "#70829e"),
    line: get("--sf-line", isDark ? "rgba(164,200,255,0.13)" : "rgba(15,29,58,0.1)"),
    lineStrong: get("--sf-line-strong", isDark ? "rgba(164,200,255,0.24)" : "rgba(15,29,58,0.18)"),
    cobalt: get("--sf-cobalt", isDark ? "#6aa0ff" : "#2457f5"),
    bid: get("--sf-bid", isDark ? "#42e8b0" : "#05875f"),
    ask: get("--sf-ask", isDark ? "#ffb866" : "#c2590a")
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

function peerColor(role: PeerRole, pal: Palette): string {
  if (role === "lender") return pal.bid;
  if (role === "borrower") return pal.ask;
  return pal.cobalt;
}

function quadPoint(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  t: number
) {
  const inv = 1 - t;
  return {
    x: inv * inv * x0 + 2 * inv * t * cx + t * t * x1,
    y: inv * inv * y0 + 2 * inv * t * cy + t * t * y1
  };
}

// Geometric Ergo Sigma emblem centered optically at (cx, cy)
function drawErgoSigma(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number) {
  const pts: [number, number][] = [
    [-0.64, -0.92],
    [0.68, -0.92],
    [0.68, -0.55],
    [-0.12, -0.55],
    [0.39, 0.0],
    [-0.12, 0.55],
    [0.68, 0.55],
    [0.68, 0.92],
    [-0.64, 0.92],
    [-0.64, 0.58],
    [-0.11, 0.0],
    [-0.64, -0.58]
  ];
  ctx.beginPath();
  pts.forEach(([x, y], idx) => {
    const px = cx + x * scale;
    const py = cy + y * scale;
    if (idx === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
}

function drawPolygon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  sides: number,
  rot: number
) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function draw(dt: number) {
  const cv = canvasRef.value;
  if (!cv || !palette) return;
  const ctx = cv.getContext("2d");
  const { w, h } = size;
  if (!ctx || !w || !h) return;

  const pal = palette;
  const damp = dt > 0 ? Math.min(1, dt * 4.8) : 1;
  smoothMouse.x += (targetMouse.x - smoothMouse.x) * damp;
  smoothMouse.y += (targetMouse.y - smoothMouse.y) * damp;
  smoothMouse.active += (targetMouse.active - smoothMouse.active) * damp;

  // Update simulation
  if (dt > 0) {
    for (const peer of PEERS) {
      peer.flare = Math.max(0, peer.flare - dt * 1.15);
    }
    coreGlow = Math.max(0, coreGlow - dt * 1.1);

    spawnCooldown -= dt;
    if (spawnCooldown <= 0 && swaps.length < 3) {
      const pair = SWAP_PAIRS[nextPairIdx % SWAP_PAIRS.length];
      nextPairIdx++;
      swaps.push({
        fromIdx: pair.fromIdx,
        toIdx: pair.toIdx,
        kind: pair.kind,
        t: 0,
        speed: 0.3 + Math.random() * 0.06,
        coreFlashed: false
      });
      PEERS[pair.fromIdx].flare = 0.55;
      spawnCooldown = 1.5;
    }

    for (let i = swaps.length - 1; i >= 0; i--) {
      const sw = swaps[i];
      sw.t += dt * sw.speed;
      if (!sw.coreFlashed && sw.t >= 0.5) {
        sw.coreFlashed = true;
        coreGlow = 0.85;
        coreGlowColor = sw.kind === "loan" ? "ask" : "cobalt";
      }
      if (sw.t >= 1) {
        PEERS[sw.toIdx].flare = 0.85;
        PEERS[sw.fromIdx].flare = 0.65;
        swaps.splice(i, 1);
      }
    }
  }

  ctx.clearRect(0, 0, w, h);

  const cx = w * 0.5;
  const cy = h * 0.5;
  const orbitRx = Math.min(w * 0.41, 224);
  const orbitRy = Math.min(h * 0.38, 152);
  const coreR = Math.min(w, h) * 0.118;

  // 1. Ambient radial lighting field
  const centerBloom = ctx.createRadialGradient(cx, cy, 8, cx, cy, Math.max(orbitRx, orbitRy) * 1.25);
  centerBloom.addColorStop(
    0,
    pal.isDark ? "rgba(106, 160, 255, 0.24)" : "rgba(36, 87, 245, 0.15)"
  );
  centerBloom.addColorStop(
    0.55,
    pal.isDark ? "rgba(66, 232, 176, 0.08)" : "rgba(5, 135, 95, 0.06)"
  );
  centerBloom.addColorStop(1, "rgba(36, 87, 245, 0)");
  ctx.fillStyle = centerBloom;
  ctx.fillRect(0, 0, w, h);

  if (smoothMouse.active > 0.01) {
    const spot = ctx.createRadialGradient(
      smoothMouse.x * w,
      smoothMouse.y * h,
      6,
      smoothMouse.x * w,
      smoothMouse.y * h,
      w * 0.36
    );
    spot.addColorStop(
      0,
      pal.isDark
        ? `rgba(140, 190, 255, ${0.15 * smoothMouse.active})`
        : `rgba(36, 87, 245, ${0.09 * smoothMouse.active})`
    );
    spot.addColorStop(1, "rgba(36, 87, 245, 0)");
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, w, h);
  }

  // 2. Sculptural Orbital Astrolabe Rings (counter-rotating architectural precision)
  ctx.save();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(cx, cy, orbitRx * 0.94, orbitRy * 0.94, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(cx, cy, orbitRx * 0.62, orbitRy * 0.62, 0, 0, Math.PI * 2);
  ctx.setLineDash([3, 6]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Subtle tick marks on outer ellipse
  const tickCount = 36;
  ctx.strokeStyle = pal.lineStrong;
  ctx.globalAlpha = 0.55;
  for (let i = 0; i < tickCount; i++) {
    const a = (i / tickCount) * Math.PI * 2 + elapsed * 0.05;
    const x1 = cx + Math.cos(a) * orbitRx * 0.91;
    const y1 = cy + Math.sin(a) * orbitRy * 0.91;
    const x2 = cx + Math.cos(a) * orbitRx * 0.96;
    const y2 = cy + Math.sin(a) * orbitRy * 0.96;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();

  // Compute live peer positions (gentle orbital breathing, zero hover parallax)
  const peerPos = PEERS.map((p, idx) => {
    const drift = 0.04 * Math.sin(elapsed * 0.55 + idx * 1.4);
    const a = p.angle + drift;
    const px = cx + Math.cos(a) * orbitRx * p.radiusScale;
    const py = cy + Math.sin(a) * orbitRy * p.radiusScale;
    return { x: px, y: py, peer: p };
  });

  // 3. Faint static connection spokes linking every peer to the Unified Market Core
  ctx.save();
  for (const pp of peerPos) {
    ctx.beginPath();
    ctx.moveTo(pp.x, pp.y);
    ctx.lineTo(cx, cy);
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();

  // 4. Active Bilateral P2P Exchange Arcs (asset flows one way, liquidity flows back simultaneously!)
  for (const sw of swaps) {
    const pFrom = peerPos[sw.fromIdx];
    const pTo = peerPos[sw.toIdx];
    const assetCol = sw.kind === "loan" ? pal.ask : pal.cobalt;
    const cashCol = pal.bid;

    // Slight perpendicular offset so outgoing asset & returning liquidity form an elegant double-helix through Core
    const dx = pTo.x - pFrom.x;
    const dy = pTo.y - pFrom.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const bow = 18;

    const c1x = cx + nx * bow;
    const c1y = cy + ny * bow;
    const c2x = cx - nx * bow;
    const c2y = cy - ny * bow;

    const laneAlpha = Math.sin(sw.t * Math.PI);

    // Highlight active bilateral lanes
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pFrom.x, pFrom.y);
    ctx.quadraticCurveTo(c1x, c1y, pTo.x, pTo.y);
    ctx.strokeStyle = assetCol;
    ctx.globalAlpha = 0.25 + laneAlpha * 0.42;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(pTo.x, pTo.y);
    ctx.quadraticCurveTo(c2x, c2y, pFrom.x, pFrom.y);
    ctx.strokeStyle = cashCol;
    ctx.globalAlpha = 0.22 + laneAlpha * 0.36;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Forward packet (Bond / Share moving from Borrower or Reseller -> Lender)
    for (let s = 7; s >= 0; s--) {
      const u = Math.max(0, sw.t - s * 0.017);
      const pt = quadPoint(pFrom.x, pFrom.y, c1x, c1y, pTo.x, pTo.y, u);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, s === 0 ? 5.2 : 2.8 * (1 - s / 9), 0, Math.PI * 2);
      ctx.fillStyle = assetCol;
      ctx.globalAlpha = (1 - s / 8) * (s === 0 ? 1 : 0.45);
      ctx.fill();
    }

    // Counter-flow packet (Principal / Liquidity moving simultaneously Lender -> Borrower or Reseller)
    for (let s = 7; s >= 0; s--) {
      const u = Math.max(0, sw.t - s * 0.017);
      const pt = quadPoint(pTo.x, pTo.y, c2x, c2y, pFrom.x, pFrom.y, u);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, s === 0 ? 4.8 : 2.5 * (1 - s / 9), 0, Math.PI * 2);
      ctx.fillStyle = cashCol;
      ctx.globalAlpha = (1 - s / 8) * (s === 0 ? 1 : 0.45);
      ctx.fill();
    }
    ctx.restore();
  }

  // 5. Central Unified Market Core (Steady Precision Octagon + Exact Centered Ergo Sigma)
  ctx.save();
  const flashCol = pal[coreGlowColor];

  // Steady soft ambient halo behind core (subtle opacity glow on fill, zero jumping radius)
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 1.38, 0, Math.PI * 2);
  ctx.fillStyle = pal.isDark ? "rgba(92, 155, 255, 0.14)" : "rgba(36, 87, 245, 0.10)";
  ctx.fill();

  // Outer rotating hairline octagon — subtly catches the clearing asset color
  drawPolygon(ctx, cx, cy, coreR * 1.12, 8, elapsed * 0.14);
  ctx.strokeStyle = pal.lineStrong;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.25;
  ctx.stroke();

  if (coreGlow > 0.02) {
    drawPolygon(ctx, cx, cy, coreR * 1.12, 8, elapsed * 0.14);
    ctx.strokeStyle = flashCol;
    ctx.globalAlpha = coreGlow * 0.55;
    ctx.lineWidth = 1.75;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Inner stationary Ergo-aligned octagon medallion (flat top/bottom edges matching Ergo's mark!)
  drawPolygon(ctx, cx, cy, coreR * 0.92, 8, Math.PI / 8);
  ctx.fillStyle = pal.card;
  ctx.fill();
  ctx.strokeStyle = pal.cobalt;
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Subtle inner tint kiss when a bilateral trade passes through
  if (coreGlow > 0.02) {
    drawPolygon(ctx, cx, cy, coreR * 0.92, 8, Math.PI / 8);
    ctx.fillStyle = flashCol;
    ctx.globalAlpha = coreGlow * (pal.isDark ? 0.14 : 0.1);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Exact dead-centered geometric Ergo Sigma polygon
  drawErgoSigma(ctx, cx, cy, coreR * 0.44);
  ctx.fillStyle = pal.ink;
  ctx.fill();
  ctx.restore();

  // 6. Render Perimeter Peer Nodes + Subtle Settlement Luminance Kiss
  for (const pp of peerPos) {
    const col = peerColor(pp.peer.role, pal);
    const flare = pp.peer.flare;

    ctx.save();
    // Subtle stationary glow kiss on settlement (no big expanding pulse rings)
    ctx.beginPath();
    ctx.arc(pp.x, pp.y, 13.5, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.globalAlpha = pal.isDark ? 0.15 + flare * 0.22 : 0.11 + flare * 0.16;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Sculpted Node Circle
    ctx.beginPath();
    ctx.arc(pp.x, pp.y, 9.5, 0, Math.PI * 2);
    ctx.fillStyle = pal.card;
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.8 + flare * 0.8;
    ctx.stroke();

    // Inner core dot (gently brightens on fill)
    ctx.beginPath();
    ctx.arc(pp.x, pp.y, 3.6 + flare * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();

    // Crisp outward label
    const isBottom = pp.y > cy + 20;
    ctx.font = '600 10.5px "IBM Plex Sans", "DM Sans", sans-serif';
    ctx.fillStyle = pal.ink2;
    ctx.textAlign = "center";
    ctx.fillText(pp.peer.label, pp.x, isBottom ? pp.y + 23 : pp.y - 16);
    ctx.restore();
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
  targetMouse.x = 0.5;
  targetMouse.y = 0.5;
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
    class="showcase-frame relative overflow-hidden rounded-[28px] rounded-tr-[6px] border border-[color:var(--sf-line-strong)] bg-[color:var(--sf-card)]"
    @mousemove="onMove"
    @mouseleave="onLeave"
  >
    <canvas
      ref="canvasRef"
      class="block h-[350px] w-full select-none sm:h-[400px]"
      role="img"
      aria-label="Animated peer-to-peer exchange topology showing borrowers, bond resellers, and share sellers clearing directly against lenders through one unified market core."
    />
  </div>
</template>

<style scoped>
.showcase-frame {
  box-shadow: var(--sf-rim-top), var(--sf-shadow-hero);
}
</style>
