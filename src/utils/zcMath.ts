import {
  ZcAskSummary,
  ZcCollateral,
  ZcCurvePoint,
  ZcCurves,
  ZcDurationUnit,
  ZcMarket,
  ZcOfferSummary,
  ZcOrderbookAskRow,
  ZcOrderbookBidRow,
  ZcQuote,
  ZcTwoPointYield,
  ZcWindowCurve
} from "@/types/zc";

export const YEAR_BLOCKS = 262_800;
export const GRID_BLOCKS = 21_600;
export const DAY_BLOCKS = 720;
export const SHARES_UNITS = 100_000_000;
export const MIN_COVER = 125;
export const DEFAULT_COVER = 150;
export const MIN_MATURITY_BLOCKS = DAY_BLOCKS;
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
    const frac = ask.kind === "shares" ? ask.units / SHARES_UNITS : 1;
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
