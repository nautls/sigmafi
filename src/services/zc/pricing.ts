import { ChainAsset, LONG_MAX, LONG_MIN, MAX_CURVE_POINTS } from "./boxes";
import { marketTokenId, ZC_SIGUSD_TOKEN_ID } from "./contracts";
import { ZcMarket } from "@/types/zc";

/** 262,800 blocks times the basis-point denominator (10,000), exact as zcs1 scripts use it. */
export const YEAR = 2_628_000_000n;
export const BLOCKS_PER_YEAR = 262_800n;
export const QUOTE_BLOCKS = 3n;
export const GRID = 21_600n;
export const MIN_BATCHING_FEE = 2_000_000n;
export const RECOLLATERALIZE_WAIT = 60n;
export const REFRESH_AGE = 525_600n;
export const REFRESH_BOUNTY = 10_000_000n;
export const REFRESH_MATURITY_GAP = 720n;
export const MAX_ORACLE_AGE = 100_000n;
export const SHARE_COUNT = 100_000_000n;
export const GUARDED_FIXED_YIELD = 1_000_000_000_000_000n;

export function bigMax(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

export function bigMin(a: bigint, b: bigint): bigint {
  return a <= b ? a : b;
}

export function bigAbs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function isValidLong(n: bigint): boolean {
  return n >= LONG_MIN && n <= LONG_MAX;
}

export function clampLong(n: bigint): bigint {
  if (n > LONG_MAX) return LONG_MAX;
  if (n < LONG_MIN) return LONG_MIN;
  return n;
}

export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  if (r !== 0n && (r < 0n) !== (b < 0n)) {
    return q - 1n;
  }
  return q;
}

export function orderedPoints(points: readonly [bigint, bigint][]): boolean {
  for (let i = 1; i < points.length; i++) {
    if (points[i][1] <= points[i - 1][1]) return false;
  }
  return true;
}

export function interpolate(
  points: readonly [bigint, bigint][],
  blocksLeft: bigint
): [bigint, bigint] | null {
  if (points.length === 0 || !orderedPoints(points)) return null;
  let below = 0;
  for (const [, d] of points) {
    if (d <= blocksLeft) below++;
  }
  if (below === 0) return [points[0][0], 1n];
  if (below === points.length) return [points[points.length - 1][0], 1n];
  const [y1, d1] = points[below - 1];
  const [y2, d2] = points[below];
  const span = d2 - d1;
  if (span <= 0n) return null;
  return [y1 * span + (y2 - y1) * (blocksLeft - d1), span];
}

export function pairsFromTail(tail: readonly bigint[]): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let i = 0; i + 1 < tail.length; i += 2) {
    out.push([tail[i], tail[i + 1]]);
  }
  return out;
}

export class YieldLine {
  constructor(
    readonly start: bigint,
    readonly startBps: bigint,
    readonly end: bigint,
    readonly endBps: bigint
  ) {}

  get valid(): boolean {
    return this.start >= 0n && this.startBps >= 0n && this.endBps >= 0n && this.end > this.start;
  }

  at(height: bigint): [bigint, bigint] {
    const h = bigMin(bigMax(height, this.start), this.end);
    const span = this.end - this.start;
    if (span <= 0n) return [bigMax(this.startBps, 0n), 1n];
    return [this.startBps * span + (this.endBps - this.startBps) * (h - this.start), span];
  }

  bpsAt(height: bigint): bigint {
    const [r, s] = this.at(height);
    return r / s;
  }

  price(
    repayment: bigint,
    units: bigint,
    whole: bigint,
    blocksLeft: bigint,
    height: bigint
  ): bigint {
    const [rate, span] = this.at(height);
    const num = units * repayment * YEAR * span;
    const den = whole * (YEAR * span + rate * blocksLeft);
    return den <= 0n ? 0n : (num + den - 1n) / den;
  }
}

export class YieldCurve {
  constructor(readonly minBps: bigint, readonly points: readonly [bigint, bigint][]) {}

  get ordered(): boolean {
    return orderedPoints(this.points) && this.points.every(([y, d]) => y >= 0n && d >= 0n);
  }

  at(blocksLeft: bigint): [bigint, bigint] {
    const [rate, span] = interpolate(this.points, blocksLeft) ?? [this.minBps, 1n];
    return [bigMax(rate, this.minBps * span), span];
  }

  bpsAt(blocksLeft: bigint): bigint {
    const [r, s] = this.at(blocksLeft);
    return (r + s - 1n) / s;
  }

  accepts(
    repayment: bigint,
    units: bigint,
    cost: bigint,
    whole: bigint,
    blocksLeft: bigint
  ): boolean {
    const [rate, span] = this.at(blocksLeft);
    return repayment * units * YEAR * span >= cost * whole * (YEAR * span + rate * blocksLeft);
  }

  ceiling(repayment: bigint, units: bigint, whole: bigint, blocksLeft: bigint): bigint {
    const [rate, span] = this.at(blocksLeft);
    const den = whole * (YEAR * span + rate * blocksLeft);
    return den <= 0n ? 0n : (repayment * units * YEAR * span) / den;
  }
}

export class BorrowCurve {
  constructor(readonly maxBps: bigint, readonly points: readonly [bigint, bigint][]) {}

  get valid(): boolean {
    return (
      this.maxBps >= 0n &&
      this.points.length <= MAX_CURVE_POINTS &&
      orderedPoints(this.points) &&
      this.points.every(([y, d]) => y >= 0n && d >= 0n)
    );
  }

  at(blocksLeft: bigint): [bigint, bigint] {
    const [rate, span] = interpolate(this.points, blocksLeft) ?? [this.maxBps, 1n];
    return [bigMin(rate, this.maxBps * span), span];
  }

  bpsAt(blocksLeft: bigint): bigint {
    const [r, s] = this.at(blocksLeft);
    return r / s;
  }

  price(repayment: bigint, blocksLeft: bigint): bigint {
    const [rate, span] = this.at(blocksLeft);
    const num = repayment * YEAR * span;
    const den = YEAR * span + rate * blocksLeft;
    return den <= 0n ? 0n : (num + den - 1n) / den;
  }

  get breakpoints(): bigint[] {
    return this.points.map((p) => p[1]);
  }
}

export function snapMaturityBig(target: bigint, height: bigint): bigint {
  if (target - height < GRID) return target;
  const below = floorDiv(target, GRID) * GRID;
  const above = below + GRID;
  if (!isValidLong(above)) return below;
  const distBelow = bigAbs(below - target);
  const distAbove = bigAbs(above - target);
  // Tie goes to the later grid height (`above`)
  return distAbove <= distBelow ? above : below;
}

export function gridBetween(from: bigint, to: bigint): bigint[] {
  if (from > to) return [];
  const first = ((from + GRID - 1n) / GRID) * GRID;
  const out: bigint[] = [];
  for (let x = first; x <= to && isValidLong(x) && out.length < 64; x += GRID) {
    out.push(x);
  }
  return out;
}

export function defaultOrderExpiry(
  height: bigint,
  maturity: bigint | null,
  week: bigint
): bigint {
  if (maturity === null) return height + week;
  const half = (maturity - height) / 2n;
  return bigMax(height + 2n, bigMin(height + week, height + half));
}

function sigUsdHeld(collateral: readonly ChainAsset[]): bigint {
  let sum = 0n;
  for (const t of collateral) {
    if (t.tokenId === ZC_SIGUSD_TOKEN_ID) sum += t.amount;
  }
  return sum;
}

export function coverOf(
  market: ZcMarket,
  collateralErg: bigint,
  collateral: readonly ChainAsset[],
  repayment: bigint,
  price: bigint
): [bigint, bigint] | null {
  if (price <= 0n) return null;
  const value = collateralErg * 100n + price * sigUsdHeld(collateral);
  const debt = marketTokenId(market) === null ? repayment * 100n : price * repayment;
  if (debt <= 0n) return null;
  return [value, debt];
}

export function ratioBps(cover: [bigint, bigint]): bigint {
  return bigMin((cover[0] * 10_000n) / cover[1], LONG_MAX);
}

export function atLeast(cover: [bigint, bigint], bps: bigint): boolean {
  return cover[0] * 10_000n >= cover[1] * bps;
}

export function crossingPrice(
  market: ZcMarket,
  collateralErg: bigint,
  collateral: readonly ChainAsset[],
  repayment: bigint,
  ratio: bigint
): [bigint, boolean] | null {
  const sigUsd = sigUsdHeld(collateral);
  if (marketTokenId(market) === null) {
    const gap = 100n * (repayment * ratio - 10_000n * collateralErg);
    if (sigUsd <= 0n || gap <= 0n) return null;
    return [gap / (sigUsd * 10_000n), false];
  }
  const gap = repayment * ratio - sigUsd * 10_000n;
  if (gap <= 0n) return null;
  return [(1_000_000n * collateralErg) / gap, true];
}

/** Exact half-up rounding of 1e9 / price to 4 decimal places. */
export function usdPerErg(price: bigint): string {
  if (price <= 0n) return "0";
  const scaled = (1_000_000_000n * 10_000n * 2n + price) / (2n * price);
  const whole = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, "0");
  return `${whole}.${frac}`;
}

export function yieldBps(face: bigint, cost: bigint, blocksLeft: bigint): bigint | null {
  if (cost <= 0n || blocksLeft <= 0n) return null;
  return clampLong(((face - cost) * YEAR) / (cost * blocksLeft));
}

export function rankYield(face: bigint, cost: bigint, blocksLeft: bigint): bigint {
  if (cost <= 0n) return LONG_MIN;
  const d = blocksLeft > 1n ? blocksLeft : 1n;
  return ((face - cost) * YEAR * 1_000_000n) / (cost * d);
}
