import {
  ZcAskDot,
  ZcAskSummary,
  ZcChartMetric,
  ZcCollateral,
  ZcCurveMove,
  ZcCurvePoint,
  ZcCurves,
  ZcCurveShape,
  ZcDurationUnit,
  ZcMarket,
  ZcOfferSummary,
  ZcOrderbookAskRow,
  ZcOrderbookBidRow,
  ZcPortfolioPosition,
  ZcQuote,
  ZcTwoPointYield,
  ZcWindowCurve
} from "@/types/zc";

export const YEAR_BLOCKS = 262_800;
export const GRID_BLOCKS = 21_600;
export const DAY_BLOCKS = 720;
export const SHARES_UNITS = 100_000_000;

/**
 * Resolves a share vault's total share supply from an ask or portfolio position,
 * falling back to the zcs1 standard `SHARES_UNITS` (100,000,000) only when absent.
 */
export function shareTotalOf(
  item:
    | {
        shareCount?: number | string | null;
        shares?: { shareCount?: number | string | null } | null;
      }
    | null
    | undefined
): number {
  const raw = item?.shareCount ?? item?.shares?.shareCount;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : SHARES_UNITS;
}
export const MIN_COVER = 125;
export const DEFAULT_COVER = 150;
export const MIN_MATURITY_BLOCKS = DAY_BLOCKS;
export const MAX_CURVE_POINTS = 20;
export const SIGUSD_TOKEN_ID =
  "03faf2cb329f2e90d6d23b58d91bbb6c046aa143261cc21f52fbe2824bfcbf04";
export const LIT_TOKEN_ID =
  "c1980d829988229516430a47a5eca376060b6ce859616db0936e78ab25cb6de7";

export function marketDecimals(market: ZcMarket): number {
  return market === "ERG" ? 9 : 2;
}

export function isHex64(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/i.test(s.trim());
}

export function fromRaw(raw: string | number | null | undefined, decimals = 0): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return decimals === 0 ? n : n / 10 ** decimals;
}

export function toRaw(
  value: number | string | bigint | null | undefined,
  decimals = 0,
  round: "floor" | "ceil" | "round" = "floor"
): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  let str: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    str = value.toFixed(Math.min(18, Math.max(decimals + 4, 12)));
  } else {
    str = String(value).trim();
  }
  if (!/^\d+(\.\d+)?$/.test(str)) return null;
  const [whole, frac = ""] = str.split(".");
  const scale = 10n ** BigInt(decimals);
  const head = frac.slice(0, decimals).padEnd(decimals, "0");
  const tail = frac.slice(decimals);
  let raw = BigInt(whole || "0") * scale + BigInt(head || "0");
  if (round === "ceil" && /[1-9]/.test(tail)) raw += 1n;
  else if (round === "round" && tail.length > 0 && Number(tail[0]) >= 5) raw += 1n;
  return raw.toString();
}

export function fromMarket(
  raw: string | number | null | undefined,
  market: ZcMarket
): number | null {
  return fromRaw(raw, marketDecimals(market));
}

export function toMarket(
  value: number | string | null | undefined,
  market: ZcMarket,
  round: "floor" | "ceil" | "round" = "floor"
): string | null {
  return toRaw(value, marketDecimals(market), round);
}

export function fromErg(raw: string | number | null | undefined): number | null {
  return fromRaw(raw, 9);
}

export function roundUp(value: number, market: ZcMarket): number {
  const f = 10 ** marketDecimals(market);
  return Math.ceil(value * f - 1e-7) / f;
}

export function roundDown(value: number, market: ZcMarket): number {
  const f = 10 ** marketDecimals(market);
  return Math.floor(value * f + 1e-7) / f;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function priceForYield(face: number, yBps: number, blocks: number): number {
  return face / (1 + (yBps / 10_000) * (blocks / YEAR_BLOCKS));
}

export function yieldForPrice(face: number, price: number, blocks: number): number | null {
  if (!(blocks > 0 && price > 0)) return null;
  return ((face / price - 1) * YEAR_BLOCKS) / blocks * 10_000;
}

export function repaymentFor(
  principal: number,
  yBps: number,
  blocks: number,
  market: ZcMarket
): number {
  return roundUp(principal * (1 + (yBps / 10_000) * (blocks / YEAR_BLOCKS)), market);
}

export function snapMaturity(target: number, currentHeight: number): number {
  if (target - currentHeight < GRID_BLOCKS) return target;
  const lower = Math.floor(target / GRID_BLOCKS) * GRID_BLOCKS;
  const upper = lower + GRID_BLOCKS;
  return target - lower < upper - target ? lower : upper;
}

export function bandFor(blocks: number): number {
  return Math.max(3 * DAY_BLOCKS, Math.round(blocks * 0.22));
}

export function lineAt(line: ZcCurvePoint[], blocks: number): number | null {
  if (!line.length || blocks < line[0].d || blocks > line[line.length - 1].d) return null;
  for (let i = 0; i < line.length; i++) {
    if (line[i].d === blocks) return line[i].y;
    if (i > 0 && blocks < line[i].d) {
      const a = line[i - 1];
      const b = line[i];
      if (a.y == null || b.y == null) return null;
      return a.y + ((b.y - a.y) * (blocks - a.d)) / (b.d - a.d);
    }
  }
  return null;
}

export function curvePointsAt(points: { d: number; y: number }[], blocks: number): number | null {
  if (!points || !points.length) return null;
  if (blocks <= points[0].d) return points[0].y;
  const last = points[points.length - 1];
  if (blocks >= last.d) return last.y;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (blocks <= b.d) {
      const a = points[i - 1];
      return a.y + ((b.y - a.y) * (blocks - a.d)) / (b.d - a.d);
    }
  }
  return last.y;
}

export function offerYieldAt(offer: ZcOfferSummary, blocks: number): number | null {
  if (blocks < offer.minBlocks || blocks > offer.maxBlocks) return null;
  const c = curvePointsAt(offer.points, blocks);
  return Math.max(offer.minYieldBps, c == null ? offer.minYieldBps : c);
}

export function windowYieldAt(ask: ZcAskSummary, blocks: number): number | null {
  if (!ask.window || blocks < ask.window.min || blocks > ask.window.max) return null;
  const cap = ask.cap ?? 0;
  const c = curvePointsAt(ask.points || [], blocks);
  return Math.min(cap, c == null ? cap : c);
}

export function twoPointAt(tp: ZcTwoPointYield, height: number): number {
  if (tp.h1 <= tp.h0) return tp.y1;
  const at = clamp(height, tp.h0, tp.h1);
  return tp.y0 + ((tp.y1 - tp.y0) * (at - tp.h0)) / (tp.h1 - tp.h0);
}

export function askBlocks(ask: ZcAskSummary, height: number, pick?: number | null): number | null {
  if (ask.kind === "order") {
    if (ask.mode === "term") return ask.duration;
    if (ask.mode === "window") return pick == null ? null : pick;
    return ask.maturity != null ? ask.maturity - height : null;
  }
  return ask.bond ? ask.bond.maturity - height : ask.quote?.d ?? null;
}

export function askQuote(ask: ZcAskSummary, height: number, pick?: number | null): ZcQuote | null {
  const market = ask.market;
  const d = askBlocks(ask, height, pick);
  if (d == null || d <= 0) return null;
  let face: number;
  let cost: number;
  let quoted: number | null = null;
  if (ask.kind === "order") {
    if (ask.repayment == null || ask.principal == null) return null;
    face = ask.repayment;
    if (ask.pricing === "fixed") {
      cost = ask.principal;
    } else if (ask.pricing === "window") {
      quoted = windowYieldAt(ask, d);
      if (quoted == null) return null;
      cost = Math.max(ask.principal, roundUp(priceForYield(face, quoted, d), market));
    } else if (ask.tp) {
      quoted = twoPointAt(ask.tp, height);
      cost = Math.max(ask.principal, roundUp(priceForYield(face, quoted, d), market));
    } else {
      cost = ask.principal;
    }
  } else {
    if (!ask.bond) return null;
    const frac = ask.kind === "shares" ? ask.units / shareTotalOf(ask) : 1;
    face = ask.bond.repayment * frac;
    if (ask.pricing === "fixed") {
      if (ask.price == null) return null;
      cost = ask.price;
    } else if (ask.tp) {
      quoted = twoPointAt(ask.tp, height);
      cost = Math.max(ask.floor || 0, roundUp(priceForYield(face, quoted, d), market));
    } else {
      if (ask.price == null) return null;
      cost = ask.price;
    }
  }
  const y = yieldForPrice(face, cost, d);
  if (y == null) return null;
  return {
    d,
    maturity: height + d,
    cost,
    face,
    yieldBps: y,
    quotedYieldBps: quoted,
    pct: face > 0 ? (cost / face) * 100 : 0
  };
}

export function windowCandidates(ask: ZcAskSummary, height: number): number[] {
  if (!ask.window) return [];
  const lo = ask.window.min;
  const hi = ask.window.max;
  if (lo > hi) return [];
  const set = new Set<number>([lo, hi]);
  for (const p of ask.points || []) {
    if (p.d >= lo && p.d <= hi) set.add(p.d);
  }
  if (height > 0) {
    for (let m = Math.ceil((height + lo) / GRID_BLOCKS) * GRID_BLOCKS; m <= height + hi; m += GRID_BLOCKS) {
      set.add(m - height);
    }
  }
  return [...set].sort((a, b) => a - b);
}

export function windowBest(ask: ZcAskSummary, height: number): ZcQuote | null {
  let best: ZcQuote | null = null;
  for (const d of windowCandidates(ask, height)) {
    const q = askQuote(ask, height, d);
    if (q && (!best || q.yieldBps > best.yieldBps)) best = q;
  }
  return best;
}

export function askPath(ask: ZcAskSummary, height: number, n = 24): { d: number; y: number }[] {
  if (ask.pricing === "window" && ask.window) {
    const { min, max } = ask.window;
    const out: { d: number; y: number }[] = [];
    for (let i = 0; i <= n; i++) {
      const d = Math.round(min + ((max - min) * i) / n);
      const q = askQuote(ask, height, d);
      if (q) out.push({ d, y: q.yieldBps });
    }
    return out;
  }
  const maturity =
    ask.kind === "order" ? (ask.mode === "term" ? null : ask.maturity) : ask.bond?.maturity ?? null;
  const last = Math.min((ask.expiry || height) - 1, maturity == null ? Infinity : maturity - 1);
  if (!(last > height)) {
    const q = ask.quote || askQuote(ask, height);
    return q ? [{ d: 0, y: q.yieldBps }] : [];
  }
  const out: { d: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const at = Math.round(height + ((last - height) * i) / n);
    const q = askQuote(ask, at);
    if (q) out.push({ d: at - height, y: q.yieldBps });
  }
  return out;
}

export function visibleWindows(curves: ZcCurves | null): ZcWindowCurve[] {
  if (!curves?.windows?.length) return [];
  const dotIds = new Set(curves.dots.map((d) => d.id));
  return curves.windows.filter((w) => dotIds.has(w.id));
}

export function windowYieldAtPoint(
  w: ZcWindowCurve,
  blocks: number,
  askById?: Map<string, ZcAskSummary>,
  height = 0
): number | null {
  if (blocks < w.min || blocks > w.max) return null;
  const full = askById?.get(w.id);
  if (full) {
    const q = askQuote(full, height, blocks);
    if (q) return q.yieldBps;
  }
  const c = curvePointsAt(w.points, blocks);
  return c == null ? w.cap : Math.min(w.cap, c);
}

export function bestWindowAskAt(
  curves: ZcCurves | null,
  blocks: number,
  askById?: Map<string, ZcAskSummary>,
  height = 0
): number | null {
  if (!curves) return null;
  let best: number | null = null;
  for (const w of visibleWindows(curves)) {
    const y = windowYieldAtPoint(w, blocks, askById, height);
    if (y != null && (best == null || y > best)) {
      best = y;
    }
  }
  return best;
}

export function bestAskAt(
  curves: ZcCurves | null,
  blocks: number,
  askById?: Map<string, ZcAskSummary>,
  height = 0
): number | null {
  if (!curves) return null;
  const wins = visibleWindows(curves);
  const winIds = new Set(wins.map((w) => w.id));
  const plainLine = curves.askLine.filter((p) => !p.id || !winIds.has(p.id));
  let best = lineAt(plainLine, blocks);

  for (const w of wins) {
    const y = windowYieldAtPoint(w, blocks, askById, height);
    if (y != null && (best == null || y > best)) {
      best = y;
    }
  }

  return best;
}

export function bestBidOverall(curves: ZcCurves | null): number | null {
  if (!curves) return null;
  let min: number | null = null;
  for (const p of curves.bidLine) {
    if (p.y != null && (min == null || p.y < min)) {
      min = p.y;
    }
  }
  return min;
}

export function bestAskOverall(curves: ZcCurves | null): number | null {
  if (!curves) return null;
  let max: number | null = null;
  for (const p of curves.dots) {
    if (p.ok && (max == null || p.y > max)) {
      max = p.y;
    }
  }
  for (const p of curves.askLine) {
    if (p.y != null && (max == null || p.y > max)) {
      max = p.y;
    }
  }
  return max;
}

export function coverage(
  collateral: ZcCollateral,
  repayment: number,
  market: ZcMarket,
  oraclePrice: number
): number | null {
  const value = (collateral.erg || 0) * oraclePrice + (collateral.usd || 0);
  const debt = market === "ERG" ? repayment * oraclePrice : repayment;
  return debt > 0 ? (value / debt) * 100 : null;
}

export function liquidationPrice(
  collateral: ZcCollateral,
  repayment: number,
  market: ZcMarket,
  ratio: number
): { price: number | null; dir: "below" | "above" | "never" | "now" } {
  const r = ratio / 100;
  const erg = collateral.erg || 0;
  const usd = collateral.usd || 0;
  if (market === "SigUSD") {
    if (erg <= 0) return { price: null, dir: usd >= r * repayment ? "never" : "now" };
    return { price: (r * repayment - usd) / erg, dir: "below" };
  }
  const den = r * repayment - erg;
  if (den <= 0) return { price: null, dir: "never" };
  return { price: usd / den, dir: "above" };
}

export function collateralFor(
  repayment: number,
  market: ZcMarket,
  ratio: number,
  oraclePrice: number
): number {
  return market === "ERG"
    ? (repayment * ratio) / 100 * oraclePrice
    : ((repayment * ratio) / 100) / oraclePrice;
}

export function isOracleRefreshingOnly(x: { status?: string; reasons?: string[] } | null): boolean {
  return (
    !!x &&
    x.status === "paused" &&
    Array.isArray(x.reasons) &&
    x.reasons.length > 0 &&
    x.reasons.every((r) => r === "oracleRefreshPending")
  );
}

export function isBookRowRefreshingOnly(r: ZcOrderbookAskRow | ZcOrderbookBidRow | null): boolean {
  return !!r && !r.ok && r.reason === "Oracle refreshing";
}

export function isBookRowActive(r: ZcOrderbookAskRow | ZcOrderbookBidRow | null): boolean {
  return !!r && (r.ok || isBookRowRefreshingOnly(r));
}

export function reasonText(
  reasons: string[] | string | null | undefined,
  status?: string,
  guardRatio?: number | null
): string | null {
  if (status === "expired") return "Expired";
  if (status === "spent") return "Spent";
  const code = Array.isArray(reasons) ? reasons[0] : reasons;
  switch (code) {
    case "oracleStale":
      return "Oracle stale";
    case "oracleRefreshPending":
      return "Oracle refreshing";
    case "guard":
      return guardRatio ? `Guard ${guardRatio}%` : "Guard paused";
    case "underRatio":
      return "Under its ratio";
    case "settled":
      return "Bond settled";
    case "origin":
      return "Origin not verified";
    case "expression":
      return "Unknown expression";
    case "disclosure":
      return "Script not disclosed";
    case "terms":
      return "Invalid terms";
    case "feeBelowFloor":
      return "Fee below floor";
    case "budget":
      return "Budget exhausted";
    default:
      return code || (status && status !== "ok" ? status : null);
  }
}

export function kindLabel(kind: ZcAskSummary["kind"] | string): string {
  if (kind === "order") return "New loan";
  if (kind === "shares") return "Shares";
  return "Bond";
}

export function pricingName(a: ZcAskSummary): string {
  if (a.pricing === "window") return `Variable maturity · ${a.points?.length || 0}-pt curve`;
  if (a.pricing === "yield") {
    return !a.tp || a.tp.y0 === a.tp.y1
      ? "APR priced"
      : a.tp.y1 > a.tp.y0
        ? "APR · rising"
        : "APR · falling";
  }
  return a.kind === "order"
    ? a.mode === "term"
      ? "Fixed · term from fill"
      : "Fixed"
    : "Fixed price";
}

export function resolvedAskQuote(ask: ZcAskSummary, height: number, pick?: number | null): ZcQuote | null {
  if (ask.pricing === "window" && ask.window) {
    return (pick != null ? askQuote(ask, height, pick) : windowBest(ask, height)) || ask.quote;
  }
  return ask.quote || askQuote(ask, height);
}

/* ============================================================
   Formatting & Height-to-Date Helpers
   ============================================================ */

let chainAnchorHeight = 0;
let chainAnchorMs = Date.now();

export function setChainNowAnchor(height: number, atMs?: number): void {
  if (Number.isFinite(height) && height > 0 && height !== chainAnchorHeight) {
    chainAnchorHeight = height;
    chainAnchorMs = atMs ?? Date.now();
  }
}

export function formatApr(bps: number | null | undefined, digits = 2): string {
  if (bps == null || !Number.isFinite(bps)) return "—";
  return `${(bps / 100).toFixed(digits)}%`;
}

export function formatBp(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "—";
  const rounded = Math.round(bps);
  return `${rounded > 0 ? "+" : ""}${rounded} bp`;
}

export function formatNumber(
  value: number | null | undefined,
  maxDigits = 2,
  minDigits = 0
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits
  });
}

export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return formatNumber(value, abs < 10 ? 2 : 1, 0);
}

export function formatMarketAmount(value: number | null | undefined, market: ZcMarket): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = market === "ERG" ? (abs >= 100 ? 1 : abs > 0 && abs < 0.01 ? 4 : 3) : 2;
  return `${formatNumber(value, digits, market === "SigUSD" && value > 0 ? 2 : 0)} ${market}`;
}

export function formatDaysShort(blocks: number | null | undefined): string {
  if (blocks == null || !Number.isFinite(blocks)) return "—";
  const dd = blocks / DAY_BLOCKS;
  if (dd >= 365 * 1.5) return `${formatNumber(dd / 365, 1, 0)}y`;
  if (dd >= 364.5 && dd <= 366) return "1y";
  if (dd >= 1) return `${Math.round(dd)}d`;
  return `${Math.max(1, Math.round(blocks / 30))}h`;
}

export function formatBlocksShort(blocks: number | null | undefined): string {
  if (blocks == null || !Number.isFinite(blocks)) return "—";
  const b = Math.round(blocks);
  if (Math.abs(b) >= 1_000_000) return `${formatNumber(b / 1_000_000, 2, 0)}M blk`;
  if (Math.abs(b) >= 10_000) return `${formatNumber(b / 1_000, 1, 0)}k blk`;
  if (Math.abs(b) >= 1_000) return `${formatNumber(b / 1_000, 1, 0)}k blk`;
  return `${formatNumber(b, 0, 0)} blk`;
}

export function formatBlocksCompact(blocks: number | null | undefined): string {
  if (blocks == null || !Number.isFinite(blocks)) return "—";
  const b = Math.round(blocks);
  if (Math.abs(b) >= 1_000_000) return `${formatNumber(b / 1_000_000, 2, 0)}M`;
  if (Math.abs(b) >= 1_000) return `${formatNumber(b / 1_000, b < 100_000 ? 1 : 0, 0)}k`;
  return formatNumber(b, 0, 0);
}

export function formatDur(blocks: number | null | undefined, unit: ZcDurationUnit = "days"): string {
  if (blocks == null || !Number.isFinite(blocks)) return "—";
  return unit === "blocks" ? formatBlocksShort(blocks) : formatDaysShort(blocks);
}

export function formatDurCell(
  blocks: number | null | undefined,
  unit: ZcDurationUnit = "days"
): string {
  if (blocks == null || !Number.isFinite(blocks)) return "—";
  return unit === "blocks" ? formatBlocksCompact(blocks) : formatDaysShort(blocks);
}

export function formatDurLong(
  blocks: number | null | undefined,
  unit: ZcDurationUnit = "days"
): string {
  if (blocks == null || !Number.isFinite(blocks)) return "—";
  if (unit === "blocks") return `${formatNumber(Math.round(blocks), 0, 0)} blocks`;
  const daysVal = blocks / DAY_BLOCKS;
  const formatted = formatNumber(daysVal, blocks < 10 * DAY_BLOCKS ? 1 : 0, 0);
  return `~${formatted} day${formatted === "1" ? "" : "s"}`;
}

export function formatAgo(blocks: number, unit: ZcDurationUnit = "days"): string {
  if (unit === "blocks") return formatBlocksCompact(blocks);
  if (blocks < 30) return `${Math.max(1, Math.round(blocks * 2))}m`;
  if (blocks < DAY_BLOCKS) return `${Math.round(blocks / 30)}h`;
  return `${Math.round(blocks / DAY_BLOCKS)}d`;
}

export function dateAtHeight(
  height: number | null | undefined,
  currentHeight?: number,
  opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
): string {
  if (height == null || !Number.isFinite(height)) return "—";
  const base = currentHeight || chainAnchorHeight;
  if (!base) return `#${formatNumber(height, 0, 0)}`;
  const d = new Date(chainAnchorMs + (height - base) * 120_000);
  const sameYear = d.getUTCFullYear() === new Date(chainAnchorMs).getUTCFullYear();
  return d.toLocaleDateString("en-US", {
    ...opts,
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC"
  });
}

export function formatWhen(
  height: number | null | undefined,
  unit: ZcDurationUnit = "days",
  currentHeight?: number
): string {
  if (height == null || !Number.isFinite(height)) return "—";
  return unit === "blocks"
    ? `#${formatNumber(height, 0, 0)}`
    : dateAtHeight(height, currentHeight);
}

export function formatAxisDays(daysVal: number, unit: ZcDurationUnit = "days"): string {
  if (unit === "blocks") return daysVal === 0 ? "0" : formatBlocksCompact(daysVal * DAY_BLOCKS);
  if (daysVal === 0) return "0";
  if (daysVal >= 540) return `${formatNumber(daysVal / 365, 1, 0)}y`;
  if (daysVal === 365) return "1y";
  if (daysVal < 1) return `${Math.round(daysVal * 24)}h`;
  return `${formatNumber(daysVal, daysVal < 10 ? 1 : 0, 0)}d`;
}

export function formatAxisFromNow(daysVal: number, unit: ZcDurationUnit = "days"): string {
  if (daysVal === 0) return "now";
  return formatAxisDays(daysVal, unit);
}

export function formatDurAlt(blocks: number | null | undefined, unit: ZcDurationUnit = "days"): string {
  if (blocks == null || !Number.isFinite(blocks)) return "—";
  return unit === "blocks" ? formatDaysShort(blocks) : formatBlocksShort(blocks);
}

export function formatDurBoth(blocks: number | null | undefined, unit: ZcDurationUnit = "days"): string {
  if (blocks == null || !Number.isFinite(blocks)) return "—";
  const dStr = formatDaysShort(blocks);
  const bStr = formatBlocksShort(blocks);
  return unit === "blocks" ? `${bStr} (${dStr})` : `${dStr} (${bStr})`;
}

export function formatWhenFull(
  height: number | null | undefined,
  unit: ZcDurationUnit = "days",
  currentHeight?: number
): string {
  if (height == null || !Number.isFinite(height)) return "—";
  const dStr = dateAtHeight(height, currentHeight);
  const hStr = `#${formatNumber(height, 0, 0)}`;
  return unit === "blocks" ? `${hStr} · ${dStr}` : `${dStr} · ${hStr}`;
}

/* ============================================================
   Studio Curve Editing, Market Envelopes & Fee-Adjusted Metrics
   ============================================================ */

export interface ZcSimpleCurvePoint {
  d: number;
  y: number;
}

export function validCurve(points: readonly ZcSimpleCurvePoint[] | null | undefined): boolean {
  if (!points || points.length > MAX_CURVE_POINTS) return false;
  for (let i = 0; i < points.length; i++) {
    if (points[i].y < 0 || points[i].d < 1) return false;
    if (i > 0 && points[i].d <= points[i - 1].d) return false;
  }
  return true;
}

const SHAPE_FNS: Record<ZcCurveShape, (t: number) => number> = {
  normal: (t) => 0.78 + 0.44 * Math.sqrt(t),
  flat: () => 1,
  inverted: (t) => 1.22 - 0.44 * Math.sqrt(t),
  humped: (t) => 0.86 + 0.34 * Math.sin(Math.PI * Math.min(1, t * 1.25))
};

const MOVE_FNS: Record<ZcCurveMove, (t: number) => number> = {
  up: () => 1,
  down: () => -1,
  bullSteep: (t) => -(1 - t),
  bearSteep: (t) => t,
  bullFlat: (t) => -t,
  bearFlat: (t) => 1 - t,
  flyUp: (t) => Math.sin(Math.PI * t),
  flyDown: (t) => -Math.sin(Math.PI * t)
};

export function shapeCurve(
  shape: ZcCurveShape,
  levelBps: number,
  n: number,
  lo: number,
  hi: number
): ZcSimpleCurvePoint[] {
  const f = SHAPE_FNS[shape];
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    return {
      d: Math.round(lo + (hi - lo) * t),
      y: Math.max(0, Math.round(levelBps * f(t)))
    };
  });
}

export function moveCurve(
  points: readonly ZcSimpleCurvePoint[],
  move: ZcCurveMove,
  stepBps: number
): ZcSimpleCurvePoint[] {
  if (!points.length) return [];
  const lo = points[0].d;
  const hi = points[points.length - 1].d;
  return points.map((p) => ({
    ...p,
    y: Math.max(
      0,
      Math.round(p.y + stepBps * MOVE_FNS[move](hi === lo ? 0 : (p.d - lo) / (hi - lo)))
    )
  }));
}

export function spreadCurve(
  points: readonly ZcSimpleCurvePoint[],
  n: number,
  lo: number,
  hi: number
): ZcSimpleCurvePoint[] {
  if (n < 2) {
    return [{ d: lo, y: points.length ? Math.round(curvePointsAt([...points], lo) ?? 0) : 0 }];
  }
  const mutable = [...points];
  return Array.from({ length: n }, (_, i) => {
    const d = Math.round(lo + ((hi - lo) * i) / (n - 1));
    return { d, y: Math.round(curvePointsAt(mutable, d) ?? 0) };
  });
}

export function resampleCurve(
  points: readonly ZcSimpleCurvePoint[],
  n: number
): ZcSimpleCurvePoint[] {
  if (!points.length) return [];
  return spreadCurve(points, n, points[0].d, points[points.length - 1].d);
}

export function fitToLine(
  line: readonly { d: number; y: number | null }[],
  n: number,
  lo: number,
  hi: number,
  offsetBps = 0
): ZcSimpleCurvePoint[] | null {
  const defined = line.filter((p): p is { d: number; y: number } => p.y != null);
  if (!defined.length) return null;
  const curvePts: ZcCurvePoint[] = defined.map((p) => ({ d: p.d, y: p.y, id: null }));
  return Array.from({ length: n }, (_, i) => {
    const d = Math.round(lo + (hi - lo) * (n === 1 ? 0 : i / (n - 1)));
    let y = lineAt(curvePts, d);
    if (y == null) y = d < defined[0].d ? defined[0].y : defined[defined.length - 1].y;
    return { d, y: Math.max(0, Math.round(y + offsetBps)) };
  });
}

export function reflectMaturity(
  points: readonly ZcSimpleCurvePoint[],
  lo: number,
  hi: number
): ZcSimpleCurvePoint[] {
  return points
    .map((p) => ({ ...p, d: Math.round(lo + hi - p.d) }))
    .sort((a, b) => a.d - b.d);
}

export function reflectApr(points: readonly ZcSimpleCurvePoint[]): ZcSimpleCurvePoint[] {
  if (!points.length) return [];
  const ys = points.map((p) => p.y);
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  return points.map((p) => ({ ...p, y: Math.max(0, Math.round(2 * mid - p.y)) }));
}

export function insertCurvePoint(
  points: readonly ZcSimpleCurvePoint[],
  sel: number | null,
  lo: number,
  hi: number
): { pts: ZcSimpleCurvePoint[]; at: number } | null {
  if (points.length >= MAX_CURVE_POINTS) return null;
  if (!points.length) return { pts: [{ d: lo, y: 800 }], at: 0 };
  if (points.length === 1) {
    const p = points[0];
    const d = p.d < (lo + hi) / 2 ? hi : lo;
    if (d === p.d) return null;
    const pts = [...points, { d, y: p.y }].sort((a, b) => a.d - b.d);
    return { pts, at: pts.findIndex((q) => q.d === d) };
  }
  let i = sel != null && sel < points.length - 1 ? sel : -1;
  if (i < 0) {
    let best = 0;
    for (let k = 0; k < points.length - 1; k++) {
      if (points[k + 1].d - points[k].d > points[best + 1].d - points[best].d) best = k;
    }
    i = best;
  }
  const a = points[i];
  const b = points[i + 1];
  if (b.d - a.d < 2) return null;
  const d = Math.round((a.d + b.d) / 2);
  const y = Math.round(curvePointsAt([...points], d) ?? a.y);
  const pts = [...points.slice(0, i + 1), { d, y }, ...points.slice(i + 1)];
  return { pts, at: i + 1 };
}

export function fixedAskDots(curves: ZcCurves | null): ZcAskDot[] {
  if (!curves) return [];
  const wins = new Set(visibleWindows(curves).map((w) => w.id));
  return curves.dots.filter((q) => !wins.has(q.id) && q.d != null && q.y != null);
}

export function nearestAskDot(
  dots: readonly { id: string; d: number; y: number }[] | null | undefined,
  d: number,
  tol: number
): { id: string; d: number; y: number } | null {
  let best: { q: { id: string; d: number; y: number }; gap: number } | null = null;
  for (const q of dots || []) {
    const gap = Math.abs(q.d - d);
    if (
      gap <= tol &&
      (!best || gap < best.gap || (gap === best.gap && q.y > best.q.y))
    ) {
      best = { q, gap };
    }
  }
  return best?.q ?? null;
}

export function bestAskNear(
  curves: ZcCurves | null,
  d: number,
  askById?: Map<string, ZcAskSummary>,
  height = 0,
  tol = 0
): { y: number; d: number } | null {
  const win = bestWindowAskAt(curves, d, askById, height);
  let best: { y: number; d: number } | null = win == null ? null : { y: win, d };
  for (const q of fixedAskDots(curves)) {
    if (
      Math.abs(q.d - d) <= tol &&
      (!best ||
        q.y > best.y ||
        (q.y === best.y && Math.abs(q.d - d) < Math.abs(best.d - d)))
    ) {
      best = { y: q.y, d: q.d };
    }
  }
  return best;
}

export function windowAskLine(
  curves: ZcCurves | null,
  askById?: Map<string, ZcAskSummary>,
  height = 0
): ZcCurvePoint[] {
  if (!curves) return [];
  const xs = new Set<number>();
  for (const w of visibleWindows(curves)) {
    xs.add(w.min);
    xs.add(w.max);
    for (const p of w.points) if (p.d >= w.min && p.d <= w.max) xs.add(p.d);
    for (let i = 1; i < 24; i++) xs.add(Math.round(w.min + ((w.max - w.min) * i) / 24));
    if (w.min > 1) xs.add(w.min - 1);
    xs.add(w.max + 1);
  }
  return [...xs]
    .sort((a, b) => a - b)
    .map((d) => ({ d, y: bestWindowAskAt(curves, d, askById, height), id: null }));
}

export function combinedAskLine(
  curves: ZcCurves | null,
  askById?: Map<string, ZcAskSummary>,
  height = 0
): ZcCurvePoint[] {
  if (!curves) return [];
  const wins = visibleWindows(curves);
  if (!wins.length) return curves.askLine;
  const winIds = new Set(wins.map((w) => w.id));
  const plainLine = curves.askLine.filter((p) => !p.id || !winIds.has(p.id));
  const xs = new Set<number>(plainLine.map((p) => p.d));
  for (const w of wins) {
    xs.add(w.min);
    xs.add(w.max);
    for (const p of w.points) if (p.d >= w.min && p.d <= w.max) xs.add(p.d);
    for (let i = 1; i < 24; i++) xs.add(Math.round(w.min + ((w.max - w.min) * i) / 24));
    if (w.min > 1) xs.add(w.min - 1);
    xs.add(w.max + 1);
  }
  return [...xs]
    .sort((a, b) => a - b)
    .map((d) => ({ d, y: bestAskAt(curves, d, askById, height), id: null }));
}

/* ============================================================
   Chart Metric Conversions (APR | % of face | Asset Price)
   ============================================================ */

export function pricePct(yBps: number, d: number): number {
  return d > 0 ? 100 / (1 + (yBps / 10_000) * (d / YEAR_BLOCKS)) : 100;
}

export function yieldOfPct(pctVal: number, d: number): number {
  return d > 0 && pctVal > 0 ? ((100 / pctVal - 1) * YEAR_BLOCKS) / d * 10_000 : 0;
}

export function yieldOfAbs(price: number, face: number, d: number): number {
  return d > 0 && price > 0 && face > 0 ? ((face / price - 1) * YEAR_BLOCKS) / d * 10_000 : 0;
}

export function feeAdjustedBidPrice(
  face: number,
  rawBidBps: number | null,
  d: number,
  fee: number
): number | null {
  if (rawBidBps == null || !(face > 0) || !(d > 0)) return null;
  const net = priceForYield(face, rawBidBps, d) - (fee || 0);
  return net > 0 ? net : null;
}

export function feeAdjustedBidBps(
  face: number,
  rawBidBps: number | null,
  d: number,
  fee: number
): number | null {
  const net = feeAdjustedBidPrice(face, rawBidBps, d, fee);
  return net == null ? null : yieldForPrice(face, net, d);
}

export function feeAdjustedBorrowBps(
  principal: number,
  rawBidBps: number | null,
  d: number,
  fee: number
): number | null {
  if (rawBidBps == null || !(principal > 0) || !(d > 0)) return null;
  const reqFace = (principal + (fee || 0)) * (1 + (rawBidBps / 10_000) * (d / YEAR_BLOCKS));
  return yieldForPrice(reqFace, principal, d);
}

export function buildFeeAdjustedBidLine(
  bidLine: readonly ZcCurvePoint[],
  offers: readonly ZcOfferSummary[] | null | undefined,
  face: number,
  defaultFee = 0.005,
  refreshing = false
): ZcCurvePoint[] {
  if (!bidLine.length || !(face > 0) || !(defaultFee > 0)) return [];
  const feeById = new Map((offers || []).map((o) => [o.id, o.fee]));
  const activeOffers = (offers || []).filter((o) => o.ok || refreshing);
  return bidLine.map((p) => {
    if (p.y == null || !(p.d > 0)) return { d: p.d, y: null, id: p.id };
    let bestY: number | null = null;
    const fallbackFee = (p.id ? feeById.get(p.id) : undefined) ?? defaultFee;
    if (activeOffers.length) {
      for (const o of activeOffers) {
        const yRaw = offerYieldAt(o, p.d);
        if (yRaw == null) continue;
        const costMax = priceForYield(face, yRaw, p.d);
        if (o.capital > 0 && o.capital < costMax) continue;
        const yEff = feeAdjustedBidBps(face, yRaw, p.d, o.fee);
        if (yEff != null && (bestY == null || yEff < bestY)) bestY = yEff;
      }
    }
    if (bestY == null) bestY = feeAdjustedBidBps(face, p.y, p.d, fallbackFee);
    return { d: p.d, y: bestY, id: p.id };
  });
}

export function toChartMetric(
  yBps: number | null | undefined,
  d: number,
  metric: ZcChartMetric,
  refFace = 100
): number | null {
  if (yBps == null || !Number.isFinite(yBps)) return null;
  if (metric === "yield") return yBps / 100;
  if (!(d > 0)) return metric === "pct" ? 100 : refFace;
  if (metric === "pct") return pricePct(yBps, d);
  return priceForYield(refFace, yBps, d);
}

export function priceToChartMetric(
  price: number | null | undefined,
  face: number,
  d: number,
  metric: ZcChartMetric
): number | null {
  if (price == null || !Number.isFinite(price) || !(face > 0)) return null;
  if (metric === "abs") return price;
  if (metric === "pct") return (price / face) * 100;
  if (!(d > 0)) return null;
  const y = yieldForPrice(face, price, d);
  return y == null ? null : y / 100;
}

export function formatMetricTick(
  v: number,
  metric: ZcChartMetric,
  span: number,
  asset?: ZcMarket | null
): string {
  if (!Number.isFinite(v)) return "";
  if (metric === "yield") return `${formatNumber(v, span < 1.5 ? 2 : 1, 0)}%`;
  if (metric === "pct") return `${formatNumber(v, span < 2 ? 2 : span < 10 ? 1 : 0, 0)}%`;
  if (Math.abs(v) >= 1e5) return formatCompact(v);
  const maxDec = asset === "ERG" ? 4 : 2;
  const dec =
    span < 0.05 ? maxDec : span < 0.5 ? Math.min(3, maxDec) : span < 5 ? 2 : span < 50 ? 1 : 0;
  return formatNumber(v, dec, 0);
}

export function formatMetricValue(
  v: number | null | undefined,
  metric: ZcChartMetric,
  asset?: ZcMarket | null
): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (metric === "yield" || metric === "pct") return `${formatNumber(v, 2, 2)}%`;
  return asset ? formatMarketAmount(v, asset) : formatNumber(v, 2, 2);
}

export function metricMarginLeft(
  yd: [number, number],
  metric: ZcChartMetric,
  asset?: ZcMarket | null
): number {
  if (metric !== "abs") return 46;
  const span = Math.abs(yd[1] - yd[0]);
  const a = formatMetricTick(yd[0], metric, span, asset);
  const b = formatMetricTick(yd[1], metric, span, asset);
  return Math.max(50, Math.min(76, Math.max(a.length, b.length) * 7 + 16));
}

export function niceTicks(a: number, b: number, count = 5): number[] {
  const span = b - a;
  if (!(span > 0)) return [a];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const e = raw / mag;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

export function niceDomain(
  values: readonly (number | null | undefined)[],
  pad = 0.12,
  floor0 = false
): [number, number] {
  const v = values.filter((n): n is number => n != null && Number.isFinite(n));
  if (!v.length) return [0, 10];
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (hi - lo < 1e-9) {
    lo -= Math.abs(lo) * 0.1 || 1;
    hi += Math.abs(hi) * 0.1 || 1;
  }
  const p = (hi - lo) * pad;
  lo -= p;
  hi += p;
  if (floor0 && lo < 0) lo = 0;
  return [lo, hi];
}

/* ============================================================
   P&L Helpers
   ============================================================ */

export interface ZcPositionPnl {
  market: ZcMarket;
  face: number;
  paid: number | null;
  at: number;
  entry: number | null;
  held: number;
  left: number;
  bid: number | null;
  value: number | null;
  basis: string | null;
  accrued: number | null;
  pnl: number | null;
  pnlPct: number | null;
  heldApr: number | null;
  vsAccrual: number | null;
  atMaturity: number | null;
}

export function settlementValue(
  settlement: Record<string, number> | null | undefined,
  market: ZcMarket,
  oraclePrice: number
): number {
  if (!settlement) return 0;
  return Object.entries(settlement).reduce((n, [m, v]) => {
    if (m === market) return n + v;
    if (m === "ERG" && market === "SigUSD" && oraclePrice > 0) return n + v * oraclePrice;
    if (m === "SigUSD" && market === "ERG" && oraclePrice > 0) return n + v / oraclePrice;
    return n;
  }, 0);
}

export function positionPnl(
  p: ZcPortfolioPosition,
  height: number,
  oraclePrice: number
): ZcPositionPnl {
  const b = p.bond;
  const market = b.market || "SigUSD";
  const frac = p.kind === "shares" ? p.units / shareTotalOf(p) : 1;
  const face = (b.repayment || 0) * frac;
  const paid = p.paid ?? null;
  const at = p.at ?? b.start ?? height;
  const mark = p.mark || null;
  const entry =
    paid != null && b.maturity > at
      ? yieldForPrice(face, paid, b.maturity - at)
      : mark?.entry ?? null;
  const held = Math.max(0, Math.min(height, b.maturity || height) - at);
  const left = (b.maturity || height) - height;
  const accrued =
    paid != null && entry != null ? paid * (1 + (entry / 10_000) * (held / YEAR_BLOCKS)) : null;

  const value =
    mark?.value ?? (p.settlement ? settlementValue(p.settlement, market, oraclePrice) : null);
  const bid = mark?.bid ?? null;
  const basis = mark?.basis ?? (p.settlement ? "settled" : null);
  const pnl = mark?.pnl != null ? mark.pnl : paid != null && value != null ? value - paid : null;

  return {
    market,
    face,
    paid,
    at,
    entry,
    held,
    left,
    bid,
    value,
    basis,
    accrued,
    pnl,
    pnlPct: pnl != null && paid ? (pnl / paid) * 100 : null,
    heldApr:
      pnl == null || !paid || held < DAY_BLOCKS || value == null
        ? null
        : (value / paid - 1) * (YEAR_BLOCKS / held) * 10_000,
    vsAccrual: value == null || accrued == null || basis !== "bid" ? null : value - accrued,
    atMaturity: paid != null ? face - paid : null
  };
}

export function offerPnl(
  offer: ZcOfferSummary,
  positions: readonly ZcPortfolioPosition[],
  height: number,
  oraclePrice: number
) {
  const ids = new Set([offer.id, offer.chainId].filter(Boolean));
  const rows = positions
    .filter((p) => p.side === "lend" && p.via && ids.has(p.via))
    .map((p) => ({ p, x: positionPnl(p, height, oraclePrice) }));
  const deployed = rows.reduce((n, r) => n + (r.x.paid ?? 0), 0);
  const valued = rows.filter((r) => r.x.value != null);
  const value = valued.reduce((n, r) => n + (r.x.value ?? 0), 0);
  const pnl = valued.reduce((n, r) => n + (r.x.pnl ?? 0), 0);
  const funded = offer.funded ?? offer.capital + deployed;
  return {
    rows,
    deployed,
    value,
    pnl: rows.length ? pnl : 0,
    funded,
    pnlPct: funded ? (pnl / funded) * 100 : null,
    avgEntry: deployed
      ? rows.reduce((n, r) => n + (r.x.paid || 0) * (r.x.entry || 0), 0) / deployed
      : null,
    atMaturity: rows.reduce((n, r) => n + (r.x.atMaturity ?? 0), 0),
    used: funded ? (deployed / funded) * 100 : 0
  };
}

export function signedFormat(
  v: number | null | undefined,
  fmt: (absVal: number) => string
): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v))}`;
}

export function pnlTone(v: number | null | undefined): "bid" | "danger" | null {
  if (v == null || Math.abs(v) < 1e-9) return null;
  return v > 0 ? "bid" : "danger";
}

/* ============================================================
   Auction Schedules & Loan Health
   ============================================================ */

export function lotPriceAt(
  lot: { opening: number; floor: number; start: number; end: number; expiry: number },
  height: number
): number | null {
  if (height + 1 >= lot.expiry) return null;
  if (height <= lot.start) return lot.opening;
  if (height >= lot.end) return lot.floor;
  const span = Math.max(1, lot.end - lot.start);
  return lot.opening - ((lot.opening - lot.floor) * (height - lot.start)) / span;
}

export function vaultAuctionAt(
  v: {
    state: number;
    repayment: number;
    openBps: number;
    floorBps: number;
    length: number;
    expiry: number;
    start: number;
    currencyHeld: number;
  },
  height: number
): { pay: number | null; bps: number | null; done: boolean } {
  if (!(v.length > 0)) return { pay: null, bps: null, done: true };
  if (v.state === 4) {
    const end = v.start + v.length;
    if (height + 1 >= end) return { pay: null, bps: 0, done: true };
    const elapsed = Math.max(0, height - v.start);
    const bps = Math.max(0, v.openBps * (1 - elapsed / v.length));
    const pay = (v.repayment * bps) / 10_000;
    return { pay, bps, done: false };
  }
  if (height >= v.start + v.expiry) return { pay: null, bps: v.floorBps, done: true };
  const since = Math.min(Math.max(0, height - v.start), v.length);
  const bps = v.openBps - ((v.openBps - v.floorBps) * since) / v.length;
  const target = (v.repayment * bps) / 10_000;
  const pay = Math.max(0, target - (v.currencyHeld || 0));
  return { pay, bps, done: false };
}

export function loanHealth(
  bond: {
    rule: string;
    ratio: number | null;
    cov: number | null;
    collateral: ZcCollateral;
    repayment: number;
    market: ZcMarket;
  },
  oraclePrice: number
): number | null {
  if (bond.rule !== "oracle" || !bond.ratio || !(bond.ratio > 0)) return null;
  const cov =
    bond.cov ??
    (oraclePrice > 0 ? coverage(bond.collateral, bond.repayment, bond.market, oraclePrice) : null);
  return cov != null ? cov / bond.ratio : null;
}
