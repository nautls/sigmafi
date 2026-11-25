import { hex } from "@fleet-sdk/crypto";
import { SByte, SColl, SLong } from "@fleet-sdk/serializer";
import {
  ChainAsset,
  LONG_MAX,
  MAX_COLLATERAL_TOKENS,
  MIN_BOX,
  minBoxValue,
  ZcAsk,
  ZcBond,
  ZcLot,
  ZcOffer,
  ZcOracle,
  ZcOrder,
  ZcOrigin,
  ZcShareVault
} from "./boxes";
import {
  getZcExpressionHash,
  getZcScript,
  marketTokenId,
  ZC_MARKETS,
  ZcExpression
} from "./contracts";
import {
  atLeast,
  bigMax,
  bigMin,
  BorrowCurve,
  coverOf,
  GRID,
  gridBetween,
  isValidLong,
  MAX_ORACLE_AGE,
  MIN_BATCHING_FEE,
  pairsFromTail,
  QUOTE_BLOCKS,
  rankYield,
  YieldCurve,
  YieldLine
} from "./pricing";
import { ZcMarket } from "@/types/zc";

export interface ZcBondTerms {
  readonly market: ZcMarket;
  readonly repayment: bigint;
  readonly principalErg: bigint;
  readonly payload: readonly bigint[];
  readonly liqHash: string;
  readonly collateralErg: bigint;
  readonly collateral: readonly ChainAsset[];
  readonly start: bigint;
  readonly maturity: bigint;
}

export function bondTermsOf(b: ZcBond): ZcBondTerms {
  return {
    market: b.market,
    repayment: b.repayment,
    principalErg: b.terms[1],
    payload: b.terms.slice(7),
    liqHash: b.liqHash,
    collateralErg: b.collateralErg,
    collateral: b.collateral,
    start: b.start,
    maturity: b.maturity
  };
}

export function prospectBondTerms(
  o: ZcOrder,
  start: bigint,
  maturity: bigint,
  principal: bigint
): ZcBondTerms {
  return {
    market: o.market,
    repayment: o.repayment,
    principalErg: marketTokenId(o.market) === null ? principal : o.principalErg,
    payload: o.payload,
    liqHash: o.liqHash,
    collateralErg: o.box.value - o.expiryFee,
    collateral: o.box.assets,
    start,
    maturity
  };
}

export type ZcRuleKind = "maturity" | "oracle" | "other";

export interface ZcOfferState {
  readonly offer: ZcOffer;
  readonly capital: bigint;
  readonly value: bigint;
  readonly boxId: string;
  readonly market: ZcMarket;
}

export function offerStateOf(offer: ZcOffer): ZcOfferState {
  return {
    offer,
    capital: offer.capital,
    value: offer.box.value,
    boxId: offer.boxId,
    market: offer.market
  };
}

export type Either<L, R> = { ok: true; value: R } | { ok: false; error: L };

export function right<R>(value: R): Either<never, R> {
  return { ok: true, value };
}

export function left<L>(error: L): Either<L, never> {
  return { ok: false, error };
}

function hashOf(expr: ZcExpression, market: ZcMarket): string {
  return getZcExpressionHash(expr, expr === "MaturityLiquidation" ? null : market);
}

export function liqRuleKind(liqHash: string, market: ZcMarket): ZcRuleKind {
  if (liqHash === hashOf("MaturityLiquidation", market)) return "maturity";
  if (liqHash === hashOf("OracleLiquidation", market)) return "oracle";
  return "other";
}

export function oracleRuleMarket(liqHash: string): ZcMarket | null {
  return ZC_MARKETS.find((m) => liqHash === hashOf("OracleLiquidation", m)) ?? null;
}

export function ownRatio(b: ZcBondTerms): bigint | null {
  return oracleRuleMarket(b.liqHash) !== null && b.payload.length > 0 ? b.payload[0] : null;
}

export function coverOfBond(b: ZcBondTerms, price: bigint): [bigint, bigint] | null {
  return coverOf(b.market, b.collateralErg, b.collateral, b.repayment, price);
}

export function ruleCoverOfBond(b: ZcBondTerms, price: bigint): [bigint, bigint] | null {
  const m = oracleRuleMarket(b.liqHash) ?? b.market;
  return coverOf(m, b.collateralErg, b.collateral, b.repayment, price);
}

export function belowOwnRatio(b: ZcBondTerms, price: bigint): boolean {
  const r = ownRatio(b);
  if (r === null) return false;
  const c = ruleCoverOfBond(b, price);
  return c !== null && c[0] * 10_000n < c[1] * r;
}

export function freshOracle(oracle: ZcOracle, age: bigint, height: bigint): boolean {
  return height + 1n - BigInt(oracle.box.creationHeight) <= age;
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export function isYieldOrder(o: ZcOrder): boolean {
  return o.pricingHash === hashOf("YieldOrderPricing", o.market);
}

export function isCurveOrder(o: ZcOrder): boolean {
  return o.pricingHash === hashOf("CurveOrderPricing", o.market);
}

export function isWindowOrder(o: ZcOrder): boolean {
  return o.mode === 2n;
}

export function isOnCloseOrder(o: ZcOrder): boolean {
  return o.mode === 1n;
}

export function orderWindow(o: ZcOrder): [bigint, bigint] | null {
  if (!isWindowOrder(o) || o.pricingTerms.length === 0) return null;
  return [o.terms[3], o.pricingTerms[0]];
}

export function borrowCurve(o: ZcOrder): BorrowCurve | null {
  if (!isCurveOrder(o) || o.pricingTerms.length < 2 || o.pricingTerms.length % 2 !== 0) {
    return null;
  }
  return new BorrowCurve(o.pricingTerms[1], pairsFromTail(o.pricingTerms.slice(2)));
}

export function orderYieldLine(o: ZcOrder): YieldLine | null {
  if (!isYieldOrder(o) || o.pricingTerms.length !== 4) return null;
  return new YieldLine(
    o.pricingTerms[0],
    o.pricingTerms[1],
    o.pricingTerms[2],
    o.pricingTerms[3]
  );
}

export function fillRatio(o: ZcOrder): bigint | null {
  return o.guardHash !== null && o.payload.length > 2 ? o.payload[2] : null;
}

export function defaultWindowMaturity(o: ZcOrder, start: bigint): bigint | null {
  const win = orderWindow(o);
  if (!win) return null;
  const [lo, hi] = win;
  const grids = gridBetween(start + lo, start + hi);
  return grids.length > 0 ? grids[0] : start + lo;
}

export function orderMaturity(
  o: ZcOrder,
  start: bigint,
  chosen: bigint | null = null
): Either<string, bigint> {
  if (isWindowOrder(o)) {
    const win = orderWindow(o);
    if (!win) return left("the window order has no most duration");
    const [lo, hi] = win;
    const m = chosen ?? defaultWindowMaturity(o, start)!;
    if (m - start < lo || m - start > hi) {
      return left(`maturity ${m} is outside the window ${start + lo} to ${start + hi}`);
    }
    return right(m);
  }
  const fixed = isOnCloseOrder(o) ? start + o.terms[3] : o.terms[3];
  if (!isValidLong(fixed)) return left("the order's duration overflows");
  if (chosen !== null && chosen !== fixed) {
    return left(`only a window order lets the lender choose; this one matures at ${fixed}`);
  }
  return right(fixed);
}

export function orderPrincipal(
  o: ZcOrder,
  at: bigint,
  maturity: bigint
): Either<string, bigint> {
  if (!o.priced) return right(o.principal);
  if (!isYieldOrder(o) && !isCurveOrder(o)) {
    return left("the order names an unknown pricing expression");
  }
  if (maturity <= at) return left("no blocks left to maturity");

  let price: bigint | null = null;
  if (isCurveOrder(o)) {
    const c = borrowCurve(o);
    if (c && c.valid) price = c.price(o.repayment, maturity - at);
  } else {
    const line = orderYieldLine(o);
    if (line && line.valid) price = line.price(o.repayment, 1n, 1n, maturity - at, at);
  }
  if (price === null) return left("the order's pricing terms are invalid");
  const result = bigMax(price, o.principal);
  if (result <= 0n || !isValidLong(result)) return left("the priced principal is out of range");
  return right(result);
}

export function resolvePrincipal(
  o: ZcOrder,
  height: bigint,
  maturity: bigint
): Either<string, bigint> {
  let best = 0n;
  for (let d = 0n; d <= QUOTE_BLOCKS; d++) {
    const p = orderPrincipal(o, height + d, maturity);
    if (!p.ok) return p;
    if (p.value > best) best = p.value;
  }
  return right(best);
}

export function orderRefusal(
  o: ZcOrder,
  height: bigint,
  chosen: bigint | null = null
): string | null {
  if (isWindowOrder(o)) {
    if (!o.priced || !isCurveOrder(o)) {
      return "a window order not priced by CurveOrder_Pricing";
    }
    const win = orderWindow(o);
    if (!win || win[0] < 30n || win[1] < win[0]) {
      return "the window order's window is malformed";
    }
  } else if (o.priced && isCurveOrder(o) && o.pricingTerms.length === 0) {
    return "the curve order has no pricing terms";
  }

  if (
    o.priced &&
    (o.policies !== 2 ||
      !o.pricingHash ||
      o.pricingHash.length !== 64 ||
      (o.guardHash !== null && o.guardHash.length !== 64) ||
      o.pricingTerms.length > 64)
  ) {
    return "the priced order has malformed policy commitments";
  }

  const mat = orderMaturity(o, height, chosen);
  if (!mat.ok) return mat.error;
  if (o.priced) {
    const p = orderPrincipal(o, height + QUOTE_BLOCKS, mat.value);
    if (!p.ok) return p.error;
  }

  const mToken = marketTokenId(o.market);
  const oneAsset =
    mToken === null
      ? o.principalTokens.length === 0 && o.principalErg > 0n && o.terms[2] <= o.repayment
      : o.principalTokens.length === 1 &&
        o.principalTokens[0].tokenId === mToken &&
        o.principalErg <= MIN_BOX &&
        o.terms[2] <= MIN_BOX;

  if (!oneAsset) return `the order does not lend and repay in ${o.market} alone`;
  if (o.repayment <= 0n || o.terms[2] <= 0n || o.principalErg < 0n) {
    return "the order has invalid amounts";
  }
  if (o.mode !== 0n && o.mode !== 1n && !(o.mode === 2n && o.priced)) {
    return "unknown maturity mode";
  }
  if (o.expiryFee < MIN_BATCHING_FEE || o.expiryFee > o.box.value - MIN_BOX) {
    return "the expiry fee is out of bounds";
  }
  if (height + 1n >= o.expiry) return `the order expired at ${o.expiry}`;
  if (isOnCloseOrder(o) && o.terms[3] < 30n) return "the duration is under 30 blocks";
  if (o.mode === 0n && o.terms[3] <= height + 2n) {
    return `the order matures at ${o.terms[3]}, too close to fill`;
  }
  return null;
}

export function guardRefusal(
  o: ZcOrder,
  bond: ZcBondTerms,
  oracle: ZcOracle | null,
  height: bigint
): string | null {
  if (o.guardHash === null) return null;
  const p = o.payload;
  if (o.guardHash !== hashOf("FillGuard", o.market)) {
    return "the order names an unknown fill guard";
  }
  if (p.length < 3 || p[0] <= 0n || p[2] < p[0] || p[1] < 1n || p[1] > MAX_ORACLE_AGE) {
    return "the order's fill guard terms are malformed";
  }
  if (!oracle) return "no usable oracle";
  if (!freshOracle(oracle, p[1], height)) {
    return `the oracle is older than the order's ${p[1]} blocks`;
  }
  const c = coverOfBond(bond, oracle.price);
  if (!c || !atLeast(c, p[2])) return "under the order's fill guard";
  return null;
}

// ─── Auctions ─────────────────────────────────────────────────────────────────

export function lotValid(l: ZcLot): boolean {
  const [opening, floor, start, end, expiry] = l.terms;
  return floor >= 1n && floor <= opening && start >= 0n && start < end && end <= expiry;
}

export function lotPrice(l: ZcLot, height: bigint): bigint {
  const [opening, floor, start, end] = l.terms;
  const at = bigMin(bigMax(height, start), end);
  const span = end - start;
  if (span <= 0n) return opening;
  const owed = opening * span - (opening - floor) * (at - start);
  return bigMin(bigMax((owed + span - 1n) / span, 0n), LONG_MAX);
}

export function lotRefundFee(l: ZcLot): bigint {
  return l.terms[5];
}

export function vaultCurrency(v: ZcShareVault): string | null {
  return v.currencyHex !== null && v.currencyHex.length === 64 ? v.currencyHex : null;
}

export function auctionOpen(v: ZcShareVault): boolean {
  return (
    v.dutch &&
    !v.holding &&
    v.auction.length >= 7 &&
    v.auction[3] >= 1n &&
    (v.state === 1 || v.state === 4)
  );
}

export function excessAuction(v: ZcShareVault): boolean {
  return auctionOpen(v) && v.state === 4;
}

export function vaultThreshold(v: ZcShareVault): bigint {
  return v.auction[5];
}

export function claimableFrom(v: ZcShareVault): bigint {
  const sum = v.auction[6] + (excessAuction(v) ? v.auction[3] : v.auction[4]);
  return bigMin(bigMax(sum, 0n), LONG_MAX);
}

export function currencyHeld(v: ZcShareVault): bigint {
  const cur = vaultCurrency(v);
  if (cur === null) return v.box.value;
  return v.box.assets
    .slice(1)
    .filter((t) => t.tokenId === cur)
    .reduce((acc, t) => acc + t.amount, 0n);
}

export function lotTarget(v: ZcShareVault, at: bigint): bigint | null {
  const [repayment, opening, floor, length, , , began] = v.auction;
  if (length < 1n || repayment <= 0n) return 0n;
  const since = bigMin(bigMax(at - began, 0n), length);
  const num = repayment * (opening * length - (opening - floor) * since);
  const den = 10_000n * length;
  const target = (num + den - 1n) / den;
  if (target < 0n || !isValidLong(target)) return null;
  return target;
}

export function excessPrice(v: ZcShareVault, at: bigint): bigint | null {
  const [repayment, opening, , length, , , began] = v.auction;
  if (length < 1n || repayment <= 0n || opening <= 0n) return null;
  const since = bigMax(at - began, 0n);
  if (since >= length) return null;
  const num = repayment * opening * (length - since);
  const den = 10_000n * length;
  const p = (num + den - 1n) / den;
  if (p <= 0n || !isValidLong(p)) return null;
  return p;
}

/** The lot tokens an excess sale leaves for pro rata claims: those at or above the in-kind threshold. */
export function keptBySale(v: ZcShareVault): ChainAsset[] {
  if (!excessAuction(v)) return [];
  const cur = vaultCurrency(v);
  const threshold = vaultThreshold(v);
  return v.box.assets
    .slice(1)
    .filter((t) => t.tokenId !== cur && t.amount >= threshold);
}

/** Whether a sale leaves a token currency's nanoERG in the vault: an excess sale does, unless it is thin. */
export function saleKeepsErg(v: ZcShareVault): boolean {
  return (
    excessAuction(v) &&
    vaultCurrency(v) !== null &&
    v.box.value - MIN_BOX >= vaultThreshold(v)
  );
}

/**
 * The most of the repayment the bond's own collateral can pay: nanoERG above the return box's
 * consensus minimum value, or repayment token held.
 */
export function repayableFromCollateral(
  bond: ZcBond,
  borrowerTree?: string,
  minValuePerByte?: bigint
): bigint {
  const mToken = marketTokenId(bond.market);
  if (mToken === null) {
    const returnTree = borrowerTree ?? `0008cd${"02"}${"00".repeat(32)}`;
    const minReturnErg = minBoxValue(
      {
        ergoTree: returnTree,
        value: MIN_BOX,
        assets: bond.collateral,
        additionalRegisters: { R4: SColl(SByte, new Uint8Array(32)).toHex() }
      },
      0,
      minValuePerByte
    );
    return bigMax(0n, bigMin(bond.repayment, bond.collateralErg - minReturnErg));
  }
  const held = bond.collateral
    .filter((t) => t.tokenId === mToken)
    .reduce((acc, t) => acc + t.amount, 0n);
  return bigMin(bond.repayment, held);
}

// ─── Asks ─────────────────────────────────────────────────────────────────────

export function isGuardedAsk(a: ZcAsk): boolean {
  return a.pricingHash === hashOf("GuardedYieldPricing", a.market);
}

export function isYieldAsk(a: ZcAsk): boolean {
  return isGuardedAsk(a) || a.pricingHash === hashOf("YieldAskPricing", a.market);
}

export function wholeUnits(a: ZcAsk): bigint {
  return a.priced ? a.terms[4] : 1n;
}

export function askYieldLine(a: ZcAsk): YieldLine | null {
  if (!isYieldAsk(a) || a.terms.length < 9) return null;
  return new YieldLine(a.terms[5], a.terms[6], a.terms[7], a.terms[8]);
}

export function askSaleGuard(a: ZcAsk): [bigint, bigint] | null {
  if (!isGuardedAsk(a) || a.terms.length < 11) return null;
  return [a.terms[9], a.terms[10]];
}

export function fixedAskPrice(a: ZcAsk, units: bigint): bigint {
  return (units * a.terms[0] + a.terms[1] - 1n) / a.terms[1];
}

export function askPrice(
  a: ZcAsk,
  units: bigint,
  bond: ZcBondTerms | null,
  height: bigint
): Either<string, bigint> {
  if (!a.priced) {
    const p = fixedAskPrice(a, units);
    return p <= 0n || !isValidLong(p) ? left("the ask price is out of range") : right(p);
  }
  if (!isYieldAsk(a)) return left("the ask names an unknown pricing expression");
  if (!bond) return left("the bond the ask prices is not live");
  const line = askYieldLine(a);
  if (!line || !line.valid) return left("the ask's yield terms are invalid");
  const whole = wholeUnits(a);
  if (whole < 1n || whole > 1_000_000_000n) return left("invalid units per bond");
  if (bond.maturity <= height + QUOTE_BLOCKS) return left("no blocks left to maturity");

  let maxRaw = 0n;
  for (let d = 0n; d <= QUOTE_BLOCKS; d++) {
    const at = height + d;
    const p = line.price(bond.repayment, units, whole, bond.maturity - at, at);
    if (p > maxRaw) maxRaw = p;
  }
  const owed = bigMax(maxRaw, fixedAskPrice(a, units));
  return owed <= 0n || !isValidLong(owed) ? left("the ask price is out of range") : right(owed);
}

export function saleGuardRefusal(
  a: ZcAsk,
  bond: ZcBondTerms,
  oracle: ZcOracle | null,
  height: bigint
): string | null {
  if (!isGuardedAsk(a)) return null;
  const sg = askSaleGuard(a);
  if (!sg) return "the ask's sale guard terms are malformed";
  const [minBps, age] = sg;
  if (minBps <= 0n || age < 1n || age > MAX_ORACLE_AGE) {
    return "the ask's sale guard terms are malformed";
  }
  if (!oracle) return "no usable oracle";
  if (!freshOracle(oracle, age, height)) {
    return `the oracle is older than the ask's ${age} blocks`;
  }
  const c = coverOfBond(bond, oracle.price);
  if (!c || !atLeast(c, minBps)) return "under the seller's sale guard";
  return null;
}

export function minFill(a: ZcAsk): bigint {
  return a.terms[2];
}

export function fillRefusal(a: ZcAsk, units: bigint, height: bigint): string | null {
  if (height + 1n >= a.expiry) return `the ask expired at ${a.expiry}`;
  if (units < 1n || units > a.token.amount) return `the ask holds ${a.token.amount}`;
  if (units < minFill(a) && units !== a.token.amount) {
    return `under the ask's least fill of ${minFill(a)}`;
  }
  return null;
}

// ─── Offers ───────────────────────────────────────────────────────────────────

export function offerCurve(o: ZcOffer): YieldCurve {
  return new YieldCurve(o.terms[0], o.curve);
}

export function minBlocks(o: ZcOffer): bigint {
  return o.terms[1];
}

export function maxBlocks(o: ZcOffer): bigint {
  return o.terms[2];
}

export function batcherFee(o: ZcOffer): bigint {
  return o.terms[3];
}

export function feeReserve(o: ZcOffer): bigint {
  return o.terms[4];
}

export function floorBps(o: ZcOffer): bigint {
  return o.terms[5];
}

export function minPrice(o: ZcOffer): bigint {
  return o.terms[7];
}

export function maxAge(o: ZcOffer): bigint {
  return o.terms[8];
}

export function isTokenOffer(o: ZcOffer): boolean {
  return marketTokenId(o.market) !== null;
}

export function originalCapital(s: ZcOfferState): bigint {
  return isTokenOffer(s.offer) ? s.offer.terms[11] : s.value;
}

export function spendBudget(o: ZcOffer): bigint {
  return isTokenOffer(o) ? o.terms[12] : 0n;
}

export function minFillBps(o: ZcOffer): bigint {
  return isTokenOffer(o) ? o.terms[13] : 0n;
}

export function rewardBudget(o: ZcOffer): bigint {
  return isTokenOffer(o) ? o.terms[14] : 0n;
}

export function buysShares(o: ZcOffer): boolean {
  return o.terms[10] > 0n;
}

export function delivers(o: ZcOffer): boolean {
  return o.fractional.length > 0;
}

export function deliveryErgBig(o: ZcOffer, shares: boolean): bigint {
  if (!delivers(o) || shares) return MIN_BOX;
  const pull = o.fractional[1] ?? 0n;
  const mint = o.fractional[2] ?? 0n;
  return 2n * MIN_BOX + pull + mint;
}

export function deliveryValid(o: ZcOffer): boolean {
  if (!delivers(o)) return true;
  const isFrac = o.mintHashHex === getZcScript("FractionalMint", null).treeHash;
  const isDutch = o.mintHashHex === getZcScript("DutchAuctionMint", o.market).treeHash;
  const needed = isDutch ? 8 : 3;
  if (
    !(isFrac || isDutch) ||
    o.fractional.length !== needed ||
    o.metadata.length !== 3 ||
    o.fractional[0] < 1n ||
    o.fractional[0] > 1_000_000_000n ||
    o.fractional[1] < MIN_BATCHING_FEE ||
    o.fractional[2] < MIN_BATCHING_FEE ||
    !isValidLong(deliveryErgBig(o, false))
  ) {
    return false;
  }
  if (isDutch) {
    const [, , , opening, floor, length, expiry, threshold] = o.fractional;
    if (
      floor < 0n ||
      floor > opening ||
      opening > 1_000_000n ||
      length < 1n ||
      length > 1_000_000n ||
      expiry < length ||
      expiry > 1_000_000n ||
      threshold < 0n
    ) {
      return false;
    }
  }
  return true;
}

const DUMMY_CONTINUATION_R6 = SColl(SByte, new Uint8Array(64)).toHex();

/**
 * Projects a `LendOffer`'s post-first-fill registers where `R6` grows from 32 bytes
 * (`policyHash`) to 64 bytes (`policyHash || predecessorBoxId`).
 */
export function offerContinuationRegisters(o: ZcOffer): Record<string, string> {
  const regs = o.box.additionalRegisters;
  if (regs.R4 && regs.R5) {
    const out: Record<string, string> = {};
    for (const k of ["R4", "R5", "R6", "R7", "R8", "R9"] as const) {
      const v = regs[k];
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    out.R6 = DUMMY_CONTINUATION_R6;
    return out;
  }
  const ownerBytes =
    o.ownerHash.length === 64 ? hex.decode(o.ownerHash) : new Uint8Array(32);
  const mintBytes =
    o.mintHashHex.length > 0 && o.mintHashHex.length % 2 === 0
      ? hex.decode(o.mintHashHex)
      : new Uint8Array(0);
  return {
    R4: SColl(SByte, ownerBytes).toHex(),
    R5: SColl(SLong, [...o.terms]).toHex(),
    R6: DUMMY_CONTINUATION_R6,
    R7: SColl(SLong, [...o.fractional]).toHex(),
    R8: SColl(SColl(SByte), [...o.metadata]).toHex(),
    R9: SColl(SByte, mintBytes).toHex()
  };
}

/**
 * Consensus minimum ERG (`max(MIN_BOX, serializedBytes * 360)`) required by `o`'s
 * post-fill continuation box when `remainingCapital` market tokens remain in it.
 */
export function minContinuationErg(
  o: ZcOffer,
  remainingCapital = o.capital,
  minValuePerByte?: bigint
): bigint {
  const mToken = marketTokenId(o.market);
  const assets: ChainAsset[] =
    mToken !== null && remainingCapital > 0n ? [{ tokenId: mToken, amount: remainingCapital }] : [];
  return minBoxValue(
    {
      ergoTree: o.script.ergoTreeHex,
      value: MIN_BOX,
      creationHeight: o.box.creationHeight > 0 ? o.box.creationHeight : undefined,
      assets,
      additionalRegisters: offerContinuationRegisters(o)
    },
    0,
    minValuePerByte
  );
}

export function policyValid(o: ZcOffer): boolean {
  return o.policyHash === hashOf("CollateralPolicy", o.market);
}

export function fillFee(s: ZcOfferState, price: bigint): bigint {
  if (!isTokenOffer(s.offer)) return batcherFee(s.offer);
  const orig = originalCapital(s);
  const budget = rewardBudget(s.offer);
  if (orig <= 0n || budget <= 0n || price <= 0n || price > orig) return 0n;
  return (budget * price) / orig;
}

export function offerCost(s: ZcOfferState, price: bigint): bigint {
  return isTokenOffer(s.offer) ? price : price + fillFee(s, price);
}

export function offerRefusal(
  s: ZcOfferState,
  bond: ZcBondTerms,
  price: bigint,
  units: bigint,
  whole: bigint,
  oracle: ZcOracle | null,
  height: bigint,
  opts?: { primary?: boolean; shares?: boolean; ignoreYield?: boolean }
): string | null {
  const primary = opts?.primary ?? false;
  const shares = opts?.shares ?? false;
  const ignoreYield = opts?.ignoreYield ?? false;
  const o = s.offer;
  const at = height + 1n;
  const slackAt = bigMax(at, bigMin(height + QUOTE_BLOCKS, o.expiry - 1n));
  const remaining = bond.maturity - at;
  const remainingLate = bond.maturity - slackAt;
  const fee = fillFee(s, price);
  const c = offerCost(s, price);
  const delivery = deliveryErgBig(o, shares);
  const ergBesidePrice = !isTokenOffer(o) ? price : primary ? bond.principalErg : MIN_BOX;
  const ergOut = fee + delivery + (primary ? feeReserve(o) : 0n) + ergBesidePrice;

  if (at >= o.expiry) return `the offer expired at ${o.expiry}`;
  if (!policyValid(o)) return "the offer names an unknown collateral policy";
  if (feeReserve(o) < 0n || !deliveryValid(o)) {
    return "the offer's reserve or delivery terms are invalid";
  }
  if (minBlocks(o) < 1n || maxBlocks(o) < minBlocks(o)) {
    return "the offer's maturity bounds are invalid";
  }
  if (o.market !== bond.market) {
    return `the offer lends ${o.market}, the bond repays ${bond.market}`;
  }
  const fractionalMintHash = getZcScript("FractionalMint", null).treeHash;
  if (
    (shares || (delivers(o) && o.mintHashHex !== fractionalMintHash)) &&
    bond.collateral.length > MAX_COLLATERAL_TOKENS
  ) {
    return `the bond holds ${bond.collateral.length} collateral tokens, above the ${MAX_COLLATERAL_TOKENS}-token share-vault limit`;
  }
  if (remaining <= 0n || remainingLate < minBlocks(o) || remaining > maxBlocks(o)) {
    return `${remaining} blocks to maturity, outside the offer's ${minBlocks(o)} to ${maxBlocks(o)}`;
  }
  if (price <= 0n || price < minPrice(o)) return "under the offer's least price";
  const curve = offerCurve(o);
  if (!curve.ordered || o.terms[0] < 0n) return "the offer's curve is malformed";
  if (!isValidLong(c)) {
    return `under the offer's ${curve.bpsAt(remaining)} bps at ${remaining} blocks`;
  }
  if (!ignoreYield) {
    for (let hCheck = at; hCheck <= slackAt; hCheck++) {
      const remCheck = bond.maturity - hCheck;
      if (!curve.accepts(bond.repayment, units, c, whole, remCheck)) {
        return `under the offer's ${curve.bpsAt(remCheck)} bps at ${remCheck} blocks`;
      }
    }
  }
  if (s.capital < price) return "the offer's capital is short";
  if (!isValidLong(ergOut) || ergOut < 0n) return "the fill's ERG requirement overflows";
  if (
    isTokenOffer(o) &&
    (originalCapital(s) <= 0n ||
      s.capital > originalCapital(s) ||
      spendBudget(o) <= 0n ||
      rewardBudget(o) <= 0n ||
      rewardBudget(o) >= spendBudget(o) ||
      minFillBps(o) < 100n ||
      minFillBps(o) > 10_000n ||
      batcherFee(o) < MIN_BATCHING_FEE)
  ) {
    return "the token offer's budget terms are invalid";
  }
  if (isTokenOffer(o) && price * 10_000n < originalCapital(s) * minFillBps(o)) {
    return "under the offer's least fill";
  }
  if (fee < MIN_BATCHING_FEE) return "the batcher reward is under 0.002 ERG";
  if (isTokenOffer(o) && ergOut * originalCapital(s) > spendBudget(o) * price) {
    return "over the offer's ERG budget";
  }
  const minCont = minContinuationErg(o, isTokenOffer(o) ? s.capital - price : 0n);
  if (!isTokenOffer(o) && s.value - ergOut < minCont) {
    return "the offer cannot cover price, fees and continuation minimum";
  }
  if (isTokenOffer(o) && s.value - ergOut < bigMax(minCont, MIN_BOX + batcherFee(o))) {
    return "the fill would spend the offer's refund reserve or continuation minimum";
  }
  if (bond.liqHash !== hashOf("OracleLiquidation", o.market)) {
    return "the bond's rule is not the oracle rule";
  }
  if (
    bond.payload.length < 2 ||
    bond.payload[0] < floorBps(o) ||
    bond.payload[1] < maxAge(o) ||
    bond.payload[1] > MAX_ORACLE_AGE
  ) {
    return "the bond's ratio or oracle age is under the offer's";
  }
  if (!oracle) return "no usable oracle";
  if (!freshOracle(oracle, maxAge(o), height)) {
    return `the oracle is older than the offer's ${maxAge(o)} blocks`;
  }
  const coverNow = coverOfBond(bond, oracle.price);
  if (!coverNow || !atLeast(coverNow, floorBps(o))) {
    return "the collateral is under the offer's floor";
  }
  if (belowOwnRatio(bond, oracle.price)) {
    return "the bond is under its own ratio: liquidate it instead";
  }
  return null;
}

export function shareRefusal(o: ZcOffer, mint: ZcOrigin): string | null {
  if (mint.kind !== "DutchAuctionMint" || mint.terms.length < 8) {
    return "offers buy only Selective or Dutch shares";
  }
  if (!buysShares(o)) return "the offer buys no shares";
  if (mint.terms[4] < o.terms[9] || mint.terms[6] > o.terms[10]) {
    return "the shares' auction is outside the offer's bounds";
  }
  return null;
}

export function windowMaturity(
  s: ZcOfferState,
  order: ZcOrder,
  oracle: ZcOracle | null,
  height: bigint,
  ignoreYield = false
): bigint | null {
  const o = s.offer;
  const start = height;
  const at = start + 1n;
  const slackAt = bigMax(at, bigMin(start + QUOTE_BLOCKS, o.expiry - 1n));
  const win = orderWindow(order);
  const borrow = borrowCurve(order);
  if (!win || !borrow || minBlocks(o) < 1n || maxBlocks(o) < minBlocks(o)) return null;

  const [lo, hi] = win;
  const fromBig = bigMax(start + lo, slackAt + minBlocks(o));
  const toBig = bigMin(bigMin(start + hi, at + maxBlocks(o)), LONG_MAX);
  if (!isValidLong(fromBig) || fromBig > toBig) return null;

  const knotSet = new Set<bigint>();
  const addKnot = (m: bigint) => {
    if (m >= fromBig && m <= toBig && isValidLong(m)) knotSet.add(m);
  };
  addKnot(fromBig);
  addKnot(toBig);
  for (const d of borrow.breakpoints) {
    addKnot(at + d);
  }
  for (const [, d] of o.curve) {
    addKnot(at + d);
  }

  const candSet = new Set<bigint>(knotSet);
  const addCand = (m: bigint) => {
    if (m >= fromBig && m <= toBig && isValidLong(m)) candSet.add(m);
  };
  for (const g of gridBetween(fromBig, toBig)) {
    addCand(g);
  }

  const curve = offerCurve(o);
  const gapOf = (m: bigint): bigint | null => {
    const pRes = resolvePrincipal(order, height, m);
    if (!pRes.ok) return null;
    const [rate, span] = curve.at(m - at);
    return (
      rankYield(order.repayment, offerCost(s, pRes.value), m - at) - (rate * 1_000_000n) / span
    );
  };

  // On ERG offers the fixed batcherFee amortizes over duration D, creating concave interior
  // yield peaks between piecewise-linear breakpoints. Search each segment with ternary search.
  if (!isTokenOffer(o)) {
    const knots = Array.from(knotSet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i + 1 < knots.length; i++) {
      let l = knots[i];
      let r = knots[i + 1];
      if (r - l <= 2n) continue;
      while (r - l > 3n) {
        const m1 = l + (r - l) / 3n;
        const m2 = r - (r - l) / 3n;
        const g1 = gapOf(m1);
        const g2 = gapOf(m2);
        if (g1 === null || g2 === null) break;
        if (g1 < g2) l = m1;
        else r = m2;
      }
      for (let m = l; m <= r; m++) addCand(m);
    }
  }

  const feasible: { m: bigint; gap: bigint }[] = [];
  for (const m of candSet) {
    const pRes = resolvePrincipal(order, height, m);
    if (!pRes.ok) continue;
    const principal = pRes.value;
    const bond = prospectBondTerms(order, start, m, principal);
    if (
      offerRefusal(s, bond, principal, 1n, 1n, oracle, height, {
        primary: true,
        ignoreYield
      }) === null &&
      guardRefusal(order, bond, oracle, height) === null
    ) {
      const [rate, span] = curve.at(m - at);
      const gap =
        rankYield(order.repayment, offerCost(s, principal), m - at) - (rate * 1_000_000n) / span;
      feasible.push({ m, gap });
    }
  }

  if (feasible.length === 0) return null;
  feasible.sort((a, b) => {
    const ga = a.m % GRID === 0n ? 0 : 1;
    const gb = b.m % GRID === 0n ? 0 : 1;
    if (ga !== gb) return ga - gb;
    if (a.gap !== b.gap) return a.gap > b.gap ? -1 : 1;
    return a.m < b.m ? -1 : a.m > b.m ? 1 : 0;
  });
  return feasible[0].m;
}
