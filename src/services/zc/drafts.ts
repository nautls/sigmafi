import {
  ChainAsset,
  ChainBox,
  LONG_MAX,
  MAX_CURVE_POINTS,
  MIN_BOX,
  ZcAsk,
  ZcOffer,
  ZcOrder
} from "./boxes";
import {
  getZcExpressionHash,
  getZcScript,
  marketNamed,
  marketTokenId,
  ZC_SIGUSD_TOKEN_ID,
  ZcKind
} from "./contracts";
import { ZcApiError } from "./errors";
import { toSafeNum, ZcJson } from "./json";
import {
  DEFAULT_ROUNDS,
  MAX_OFFERS,
  MAX_SOURCES,
  openOf,
  orderSourceOf,
  ZcMatch,
  ZcMatcher
} from "./matcher";
import {
  bigMax,
  BLOCKS_PER_YEAR,
  BorrowCurve,
  defaultOrderExpiry,
  GRID,
  GUARDED_FIXED_YIELD,
  MAX_ORACLE_AGE,
  MIN_BATCHING_FEE,
  orderedPoints,
  rankYield,
  REFRESH_BOUNTY,
  SHARE_COUNT,
  snapMaturityBig,
  yieldBps,
  YieldLine
} from "./pricing";
import {
  askPrice,
  belowOwnRatio,
  bondTermsOf,
  floorBps,
  guardRefusal,
  offerStateOf,
  orderMaturity,
  orderRefusal,
  prospectBondTerms,
  resolvePrincipal,
  saleGuardRefusal,
  ZcOfferState
} from "./rules";
import { ZcMarket } from "@/types/zc";

export const DRAFT_ID = "f".repeat(64);

type Obj = Record<string, unknown>;

function badRequest(msg: string): never {
  throw new ZcApiError(msg, 400);
}

function check(ok: boolean, why: string): void {
  if (!ok) badRequest(why);
}

function asObj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function optObj(parent: Obj, field: string): Obj | null {
  return asObj(parent[field]);
}

function optLong(parent: Obj, field: string): bigint | null {
  const v = parent[field];
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) badRequest(`${field} must be an integer`);
    return BigInt(v);
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!/^-?\d+$/.test(trimmed)) badRequest(`${field} must be an integer`);
    return BigInt(trimmed);
  }
  badRequest(`${field} must be an integer`);
}

function needLong(parent: Obj, field: string): bigint {
  const v = optLong(parent, field);
  if (v === null) badRequest(`${field} is required: zcs1 never defaults it`);
  return v;
}

function marketOf(d: Obj): ZcMarket {
  const raw = typeof d.market === "string" ? marketNamed(d.market) : null;
  if (!raw) badRequest("market must be ERG or SigUSD");
  return raw;
}

function readPoints(raw: unknown): [bigint, bigint][] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const p = asObj(item);
    if (!p) badRequest("curve point must be an object");
    return [needLong(p, "bps"), needLong(p, "blocks")];
  });
}

export function readTokens(raw: unknown): ChainAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const t = asObj(item);
    if (!t || typeof t.tokenId !== "string" || t.tokenId.trim().length !== 64) {
      badRequest("each token needs a 64-character tokenId");
    }
    return { tokenId: t.tokenId.trim().toLowerCase(), amount: needLong(t, "amount") };
  });
}

function draftBox(
  kind: ZcKind,
  market: ZcMarket,
  value: bigint,
  assets: ChainAsset[],
  height: bigint
): ChainBox {
  const h = Number(height);
  return {
    boxId: DRAFT_ID,
    transactionId: "",
    value,
    index: 0,
    creationHeight: h,
    settlementHeight: h,
    ergoTree: getZcScript(kind, market).ergoTreeHex,
    assets,
    additionalRegisters: {}
  };
}

function matchJson(mt: ZcMatch): Record<string, unknown> {
  return {
    counterpartyId: mt.sourceId,
    offerId: mt.offerId,
    units: mt.units.toString(),
    cost: mt.cost.toString(),
    face: mt.face.toString(),
    yieldBps: toSafeNum(mt.yieldBps),
    requiredBps: toSafeNum(mt.requiredBps),
    maturity: toSafeNum(mt.maturity)
  };
}

function simulateWalletLend(
  d: Obj,
  matcher: ZcMatcher,
  json: ZcJson
): Record<string, unknown> {
  const m = marketOf(d);
  const amount = needLong(d, "amount");
  const to = optLong(d, "to") ?? BLOCKS_PER_YEAR;
  const coverage = optLong(d, "coverage") ?? 15_000n;
  check(amount > 0n, "amount must be positive");
  const h = matcher.height;
  const oracle = matcher.book.oracle;

  interface BuyRow {
    id: string;
    units: bigint;
    whole: bigint;
    cost: bigint;
    repayment: bigint;
    mat: bigint;
    rank: bigint;
  }

  const buys: BuyRow[] = [];
  for (const src of matcher.sources(m)) {
    if (src.sourceType === "order") {
      const mRes = orderMaturity(src.order, h);
      if (!mRes.ok) continue;
      const pRes = resolvePrincipal(src.order, h, mRes.value);
      if (!pRes.ok) continue;
      const bond = prospectBondTerms(src.order, h, mRes.value, pRes.value);
      if (guardRefusal(src.order, bond, oracle, h) !== null) continue;
      if (oracle && belowOwnRatio(bond, oracle.price)) continue;
      if (mRes.value - (h + 1n) > to) continue;
      const cov = json.coverBps(bond);
      if (cov !== null && cov < coverage) continue;
      const face = src.order.repayment;
      buys.push({
        id: src.boxId,
        units: 1n,
        whole: 1n,
        cost: pRes.value,
        repayment: src.order.repayment,
        mat: mRes.value,
        rank: rankYield(face, pRes.value, mRes.value - (h + 1n))
      });
    } else {
      const bond = bondTermsOf(src.bond.record);
      const pRes = askPrice(src.ask, src.ask.token.amount, bond, h);
      if (!pRes.ok) continue;
      if (saleGuardRefusal(src.ask, bond, oracle, h) !== null) continue;
      if (oracle && belowOwnRatio(bond, oracle.price)) continue;
      if (bond.maturity - (h + 1n) > to) continue;
      const cov = json.coverBps(bond);
      if (cov !== null && cov < coverage) continue;
      const face = bond.repayment * src.ask.token.amount;
      buys.push({
        id: src.boxId,
        units: src.ask.token.amount,
        whole: src.whole,
        cost: pRes.value,
        repayment: bond.repayment,
        mat: bond.maturity,
        rank: rankYield(face, pRes.value * src.whole, bond.maturity - (h + 1n))
      });
    }
  }

  buys.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank > b.rank ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let left = amount;
  const taken: BuyRow[] = [];
  for (const row of buys) {
    if (row.cost <= left) {
      left -= row.cost;
      taken.push(row);
    }
  }
  const filled = amount - left;

  return {
    outcome: taken.length === 0 ? "waiting" : left === 0n ? "full" : "partial",
    matches: taken.map((row) => {
      const face = row.repayment * row.units;
      const yb = yieldBps(face, row.cost * row.whole, row.mat - (h + 1n));
      return {
        counterpartyId: row.id,
        units: row.units.toString(),
        cost: row.cost.toString(),
        face: (face / row.whole).toString(),
        yieldBps: yb !== null ? toSafeNum(yb) : 0,
        maturity: toSafeNum(row.mat)
      };
    }),
    filled: filled.toString(),
    remaining: left.toString(),
    searched: buys.length
  };
}

export function buildDraftOffer(d: Obj, h: bigint): ZcOffer {
  const m = marketOf(d);
  const capital = needLong(d, "capital");
  const minYield = needLong(d, "minYieldBps");
  const floor = needLong(d, "floorBps");
  const curve = readPoints(d.curve);
  const minB = optLong(d, "minBlocks") ?? 1n;
  const maxB = optLong(d, "maxBlocks") ?? BLOCKS_PER_YEAR;
  const age = optLong(d, "oracleAge") ?? 30n;
  const expiry = optLong(d, "expiry") ?? h + 5040n;
  const reserve = optLong(d, "reserveNanoErg") ?? 50_000_000n;
  const minP = optLong(d, "minPrice") ?? 1n;
  const bounds = optObj(d, "shareBounds");
  const aFloor = bounds ? optLong(bounds, "floorBps") ?? 0n : 0n;
  const aExpiry = bounds ? optLong(bounds, "maxExpiry") ?? 0n : 0n;

  check(
    capital > 0n && minYield >= 0n && floor > 0n,
    "capital and floorBps must be positive, minYieldBps not negative"
  );
  check(
    reserve >= 0n && minP >= 1n && aFloor >= 0n && aExpiry >= 0n,
    "reserveNanoErg and shareBounds cannot be negative, and minPrice must be at least 1"
  );
  check(minB >= 1n && maxB >= minB, "the window needs 1 <= minBlocks <= maxBlocks");
  check(
    curve.length <= MAX_CURVE_POINTS &&
      orderedPoints(curve) &&
      curve.every(([y, b]) => y >= 0n && b >= 1n),
    `the curve holds at most ${MAX_CURVE_POINTS} points, blocks strictly increasing`
  );
  check(age >= 1n && age <= MAX_ORACLE_AGE, "oracleAge must be 1 to 100000");
  check(expiry > h + 1n, "the expiry must be above the current height");

  const delivery = optObj(d, "delivery") ?? { kind: "unit" };
  const deliveryKind = typeof delivery.kind === "string" ? delivery.kind : "unit";
  let fractional: bigint[] = [];
  let mintHashHex = "";
  let metadata: Uint8Array[] = [];

  if (deliveryKind === "selective" || deliveryKind === "dutch") {
    fractional = [
      optLong(delivery, "shareCount") ?? SHARE_COUNT,
      optLong(delivery, "pullFeeNanoErg") ?? 5_000_000n,
      optLong(delivery, "mintFeeNanoErg") ?? 5_000_000n,
      needLong(delivery, "openingBps"),
      needLong(delivery, "floorBps"),
      optLong(delivery, "length") ?? 720n,
      optLong(delivery, "expiry") ?? 2160n,
      deliveryKind === "dutch" ? LONG_MAX : 100n
    ];
    mintHashHex = getZcScript("DutchAuctionMint", m).treeHash;
    metadata = [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)];
  } else if (deliveryKind !== "unit") {
    badRequest(`delivery.kind must be unit, selective or dutch, not ${deliveryKind}`);
  }

  const mToken = marketTokenId(m);
  let value: bigint;
  let assets: ChainAsset[];
  let fee: bigint;
  let budget: bigint[];

  if (mToken === null) {
    const ergObj = optObj(d, "erg");
    fee = ergObj ? optLong(ergObj, "batcherFeeNanoErg") ?? 5_000_000n : 5_000_000n;
    value = capital;
    assets = [];
    budget = [];
  } else {
    const tObj = optObj(d, "token") ?? {};
    fee = optLong(tObj, "refundFeeNanoErg") ?? 5_000_000n;
    const funding = optLong(tObj, "ergFundingNanoErg") ?? 500_000_000n;
    const minFill = optLong(tObj, "minFillBps") ?? 100n;
    check(minFill >= 100n && minFill <= 10_000n, "minFillBps must be 100 to 10000");
    const reward =
      optLong(tObj, "rewardBudgetNanoErg") ??
      (MIN_BATCHING_FEE * 10_000n + minFill - 1n) / minFill;
    const spend = funding - MIN_BOX - fee;
    check(
      reward > 0n && spend > reward,
      "the ERG funding must cover the reward budget, box funding and the refund fee"
    );
    value = funding;
    assets = [{ tokenId: mToken, amount: capital }];
    budget = [capital, spend, minFill, reward];
  }

  check(fee >= MIN_BATCHING_FEE, "the batcher fee must be at least 0.002 ERG");

  const terms: bigint[] = [
    minYield,
    minB,
    maxB,
    fee,
    reserve,
    floor,
    expiry,
    minP,
    age,
    aFloor,
    aExpiry,
    ...budget,
    ...curve.flatMap(([y, b]) => [y, b])
  ];

  const script = getZcScript("LendOffer", m);
  return {
    recordType: "offer",
    box: draftBox("LendOffer", m, value, assets, h),
    script,
    boxId: DRAFT_ID,
    namedHash: "",
    market: m,
    ownerHash: "",
    terms,
    policyHash: getZcExpressionHash("CollateralPolicy", m),
    predecessor: null,
    fractional,
    metadata,
    mintHashHex,
    expiry,
    capital,
    curve
  };
}

function simulateOffer(d: Obj, matcher: ZcMatcher): Record<string, unknown> {
  const o = buildDraftOffer(d, matcher.height);
  const state = offerStateOf(o);
  const run = matcher.batch(o.market, DEFAULT_ROUNDS, [state], []);
  const taken = run.taken.get(DRAFT_ID) ?? [];
  const reachable: ZcMatch[] = [];
  for (const src of matcher.sources(o.market).slice(0, MAX_SOURCES)) {
    const res = matcher.evaluate(state, src, true);
    if (res.ok) reachable.push(res.value);
  }
  const filled = taken.reduce((acc, t) => acc + t.price, 0n);

  const buckets = new Map<bigint, ZcMatch[]>();
  for (const mt of reachable) {
    const k = mt.blocksLeft / GRID;
    const list = buckets.get(k) ?? [];
    list.push(mt);
    buckets.set(k, list);
  }
  const askLine = Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, ms]) => {
      let best = ms[0];
      for (const x of ms.slice(1)) {
        if (x.yieldBps > best.yieldBps || (x.yieldBps === best.yieldBps && x.sourceId > best.sourceId)) {
          best = x;
        }
      }
      return {
        blocks: toSafeNum(best.blocksLeft),
        bps: toSafeNum(best.yieldBps),
        askId: best.sourceId
      };
    });

  return {
    outcome: taken.length === 0 ? "waiting" : filled >= o.capital ? "full" : "partial",
    matches: taken.map(matchJson),
    filled: filled.toString(),
    remaining: (o.capital - filled).toString(),
    askDots: reachable.map((mt) => ({
      askId: mt.sourceId,
      blocks: toSafeNum(mt.blocksLeft),
      bps: toSafeNum(mt.yieldBps),
      requiredBps: toSafeNum(mt.requiredBps)
    })),
    askLine,
    collateralNeeded: null,
    rounds: run.rounds
  };
}

export function buildDraftOrder(d: Obj, h: bigint): ZcOrder {
  const m = marketOf(d);
  const pricing = typeof d.pricing === "string" ? d.pricing : "fixed";
  const principal = needLong(d, "principal");
  const repayment = needLong(d, "repayment");
  check(principal > 0n && repayment > 0n, "principal and repayment must be positive");

  const timing = optObj(d, "timing");
  if (!timing) badRequest("timing is required: zcs1 never defaults the maturity");

  let maturityTerm: bigint;
  let mode: bigint;
  let fixedMaturity: bigint | null;

  if (timing.mode === "fixed") {
    const matOpt = optLong(timing, "maturity");
    const blkOpt = optLong(timing, "blocks");
    const target = matOpt ?? (blkOpt !== null ? h + blkOpt : null);
    if (target === null) badRequest("a fixed timing needs maturity or blocks");
    const mat = timing.exact === true ? target : snapMaturityBig(target, h);
    check(mat > h + 2n, "the maturity is too close");
    maturityTerm = mat;
    mode = 0n;
    fixedMaturity = mat;
  } else if (timing.mode === "term") {
    const dur = needLong(timing, "duration");
    check(dur >= 30n, "a term is at least 30 blocks");
    maturityTerm = dur;
    mode = 1n;
    fixedMaturity = null;
  } else if (timing.mode === "window") {
    const lo = needLong(timing, "minDuration");
    const hi = needLong(timing, "maxDuration");
    check(lo >= 30n && hi >= lo, "a window needs 30 <= minDuration <= maxDuration");
    check(pricing === "window", "a window order is priced by a curve: pricing window");
    maturityTerm = lo;
    mode = 2n;
    fixedMaturity = null;
  } else {
    badRequest("timing.mode must be fixed, term or window");
  }

  const expiry = optLong(d, "expiry") ?? defaultOrderExpiry(h, fixedMaturity, 5040n);
  const expiryFee = optLong(d, "expiryFeeNanoErg") ?? 5_000_000n;
  check(expiry > h + 1n, "the expiry must be above the current height");
  check(expiryFee >= MIN_BATCHING_FEE, "the expiry fee must be at least 0.002 ERG");

  const rule = optObj(d, "rule");
  if (!rule) badRequest("rule is required: oracle with ratioBps, or maturity");
  let liqHash: string;
  let payload: bigint[];

  if (rule.kind === "maturity") {
    liqHash = getZcExpressionHash("MaturityLiquidation", null);
    payload = [];
  } else if (rule.kind === "oracle") {
    const ratio = needLong(rule, "ratioBps");
    const age = optLong(rule, "oracleAge") ?? 60n;
    check(
      ratio > 0n && age >= 1n && age <= MAX_ORACLE_AGE,
      "the oracle rule needs a positive ratio and an age of 1 to 100000"
    );
    let guard: bigint | null;
    if (!("fillGuard" in d) || d.fillGuard === undefined) {
      guard = ratio;
    } else if (d.fillGuard === null) {
      guard = null;
    } else {
      const gObj = asObj(d.fillGuard);
      guard = gObj ? optLong(gObj, "ratioBps") ?? ratio : ratio;
    }
    if (guard !== null) {
      check(guard >= ratio, "the fill guard's ratio cannot be under the liquidation ratio");
    }
    liqHash = getZcExpressionHash("OracleLiquidation", m);
    payload = guard !== null ? [ratio, age, guard] : [ratio, age];
  } else {
    badRequest("rule.kind must be oracle or maturity");
  }

  const guarded = payload.length === 3;
  const col = optObj(d, "collateral");
  if (!col) badRequest("collateral is required");
  const colErg = optLong(col, "nanoErg") ?? 0n;
  check(colErg >= MIN_BOX, "the collateral must hold at least 0.001 ERG");

  const mToken = marketTokenId(m);
  const principalErg = mToken === null ? principal : 0n;
  const floorErg = mToken === null ? repayment : MIN_BOX;
  const principalTokens: ChainAsset[] = mToken === null ? [] : [{ tokenId: mToken, amount: principal }];
  const terms: bigint[] = [
    repayment,
    principalErg,
    floorErg,
    maturityTerm,
    expiry,
    expiryFee,
    mode,
    ...payload
  ];
  const guardHash = guarded ? getZcExpressionHash("FillGuard", m) : null;

  let kind: ZcKind;
  let pricingHash: string | null;
  let pricingTerms: bigint[];

  if (pricing === "fixed") {
    kind = "Order";
    pricingHash = null;
    pricingTerms = [];
  } else if (pricing === "yield") {
    const y = optObj(d, "yield");
    if (!y) badRequest("yield pricing needs yield.startBps");
    const start = needLong(y, "startBps");
    const line = new YieldLine(
      h,
      start,
      optLong(y, "endHeight") ?? expiry,
      optLong(y, "endBps") ?? start
    );
    check(line.valid, "the yield needs non-negative points and an end above the current height");
    kind = "PricedOrder";
    pricingHash = getZcExpressionHash("YieldOrderPricing", m);
    pricingTerms = [line.start, line.startBps, line.end, line.endBps];
  } else if (pricing === "window") {
    check(mode === 2n, "window pricing needs a window timing");
    const c = optObj(d, "curve");
    if (!c) badRequest("window pricing needs curve.capBps");
    const curve = new BorrowCurve(needLong(c, "capBps"), readPoints(c.points));
    check(
      curve.valid,
      "the curve needs at most 20 points, blocks strictly increasing, no negative yield"
    );
    kind = "PricedOrder";
    pricingHash = getZcExpressionHash("CurveOrderPricing", m);
    pricingTerms = [
      needLong(timing, "maxDuration"),
      curve.maxBps,
      ...curve.points.flatMap(([y, b]) => [y, b])
    ];
  } else {
    badRequest(`pricing must be fixed, yield or window, not ${pricing}`);
  }

  const script = getZcScript(kind, m);
  return {
    recordType: "order",
    box: draftBox(kind, m, colErg + expiryFee, readTokens(col.tokens), h),
    script,
    boxId: DRAFT_ID,
    namedHash: "",
    market: m,
    terms,
    principalTokens,
    borrowerHash: "",
    liqHash,
    guardHash,
    pricingHash,
    pricingTerms,
    policies: kind === "PricedOrder" ? 2 : 0,
    priced: kind === "PricedOrder",
    repayment,
    principalErg,
    principal,
    expiry,
    expiryFee,
    mode,
    payload
  };
}

function collateralNeeded(
  o: ZcOrder,
  funders: readonly ZcOfferState[],
  matcher: ZcMatcher
): string | null {
  const or = matcher.book.confirmedOracle;
  if (!or || o.payload.length === 0) return null;

  let target = o.payload[0];
  if (o.payload.length > 2 && o.payload[2] > target) target = o.payload[2];
  if (funders.length > 0) {
    let minOfferFloor = floorBps(funders[0].offer);
    for (const s of funders.slice(1)) {
      const f = floorBps(s.offer);
      if (f < minOfferFloor) minOfferFloor = f;
    }
    if (minOfferFloor > target) target = minOfferFloor;
  }

  const sigUsd = o.box.assets
    .filter((a) => a.tokenId === ZC_SIGUSD_TOKEN_ID)
    .reduce((acc, a) => acc + a.amount, 0n);
  const debt =
    marketTokenId(o.market) === null ? o.repayment * 100n : or.price * o.repayment;
  const needed = ((debt * target + 9_999n) / 10_000n - or.price * sigUsd + 99n) / 100n;
  return bigMax(needed, MIN_BOX).toString();
}

function simulateOrder(d: Obj, matcher: ZcMatcher): Record<string, unknown> {
  const o = buildDraftOrder(d, matcher.height);
  const source = orderSourceOf(openOf(o, true));
  const run = matcher.batch(o.market, DEFAULT_ROUNDS, [], [source]);
  const offers = matcher.offerStates(o.market).slice(0, MAX_OFFERS);
  const fund: { s: ZcOfferState; mt: ZcMatch }[] = [];
  for (const s of offers) {
    const res = matcher.evaluate(s, source, true);
    if (res.ok) fund.push({ s, mt: res.value });
  }
  const taker = run.takenBy.get(DRAFT_ID) ?? null;
  const refusal = orderRefusal(o, matcher.height);

  return {
    outcome: refusal !== null ? "incomplete" : taker ? "full" : "waiting",
    refusal,
    matches: taker ? [matchJson(taker)] : [],
    filled: taker ? taker.price.toString() : "0",
    remaining: taker ? "0" : o.principal.toString(),
    bidLine: fund.map(({ s, mt }) => ({
      offerId: s.boxId,
      blocks: toSafeNum(mt.blocksLeft),
      bps: toSafeNum(mt.requiredBps)
    })),
    collateralNeeded: collateralNeeded(
      o,
      fund.map((x) => x.s),
      matcher
    ),
    rounds: run.rounds
  };
}

export function buildDraftAsk(d: Obj, matcher: ZcMatcher): ZcAsk {
  const h = matcher.height;
  const token =
    typeof d.tokenId === "string" && d.tokenId.trim().length === 64
      ? d.tokenId.trim().toLowerCase()
      : badRequest("tokenId must be a 64-character id");
  const units = needLong(d, "units");
  check(units >= 1n, "units must be at least 1");

  const claimRes = matcher.claimOf(token);
  if (!claimRes.ok) badRequest(`the token is no claim on a ZC bond: ${claimRes.error}`);
  const { asset, whole } = claimRes.value;
  const bondOpen = matcher.book.bonds.get(asset);
  if (!bondOpen) badRequest("the bond is not live");
  const m = bondOpen.record.market;

  const expiry = optLong(d, "expiry") ?? h + 5040n;
  check(expiry > h + 1n, "the expiry must be above the current height");
  const minF = optLong(d, "minFill") ?? 1n;
  const guardObj = optObj(d, "saleGuard");
  const guard: [bigint, bigint] | null = guardObj
    ? [needLong(guardObj, "ratioBps"), optLong(guardObj, "oracleAge") ?? 30n]
    : null;

  const p = optObj(d, "pricing");
  if (!p) badRequest("pricing is required");

  let kind: ZcKind;
  let terms: bigint[];
  let pricingHash: string | null;

  if (p.kind === "fixed" && guard === null) {
    kind = "SaleOrder";
    terms = [needLong(p, "price"), units, minF, expiry];
    pricingHash = null;
  } else if (p.kind === "fixed" && guard !== null) {
    kind = "PricedAsk";
    terms = [
      needLong(p, "price"),
      units,
      minF,
      expiry,
      whole,
      h,
      GUARDED_FIXED_YIELD,
      expiry,
      GUARDED_FIXED_YIELD,
      guard[0],
      guard[1]
    ];
    pricingHash = getZcExpressionHash("GuardedYieldPricing", m);
  } else if (p.kind === "yield") {
    const start = needLong(p, "startBps");
    const line = new YieldLine(
      h,
      start,
      optLong(p, "endHeight") ?? expiry,
      optLong(p, "endBps") ?? start
    );
    check(line.valid, "the yield needs non-negative points and an end above the current height");
    const floorVal = optLong(p, "floor");
    const [num, den]: [bigint, bigint] =
      floorVal !== null && floorVal > 0n ? [floorVal, units] : [1n, 1_000_000_000_000n];
    kind = "PricedAsk";
    terms = [
      num,
      den,
      minF,
      expiry,
      whole,
      line.start,
      line.startBps,
      line.end,
      line.endBps,
      ...(guard ? [guard[0], guard[1]] : [])
    ];
    pricingHash = getZcExpressionHash(
      guard ? "GuardedYieldPricing" : "YieldAskPricing",
      m
    );
  } else {
    badRequest("pricing.kind must be fixed or yield");
  }

  const script = getZcScript(kind, m);
  return {
    recordType: "ask",
    box: draftBox(kind, m, MIN_BOX + 2_000_000n, [{ tokenId: token, amount: units }], h),
    script,
    boxId: DRAFT_ID,
    namedHash: "",
    market: m,
    sellerHash: "",
    terms,
    pricingHash,
    pricedAsset: kind === "PricedAsk" ? asset : null,
    predecessor: null,
    priced: kind === "PricedAsk",
    token: { tokenId: token, amount: units },
    expiry
  };
}

function simulateAsk(d: Obj, matcher: ZcMatcher): Record<string, unknown> {
  const a = buildDraftAsk(d, matcher);
  const srcRes = matcher.askSource(openOf(a, true));
  if (!srcRes.ok) badRequest(srcRes.error);
  const source = srcRes.value;
  const run = matcher.batch(a.market, DEFAULT_ROUNDS, [], [source]);
  const taker = run.takenBy.get(DRAFT_ID) ?? null;
  const takers: ZcMatch[] = [];
  for (const s of matcher.offerStates(a.market).slice(0, MAX_OFFERS)) {
    const res = matcher.evaluate(s, source);
    if (res.ok) takers.push(res.value);
  }

  return {
    outcome: taker ? "full" : "waiting",
    matches: taker ? [matchJson(taker)] : [],
    offers: takers.map(matchJson),
    filled: taker ? taker.units.toString() : "0",
    remaining: taker ? "0" : a.token.amount.toString(),
    rounds: run.rounds
  };
}

export interface ZcLotDraft {
  readonly market: ZcMarket;
  readonly items: readonly ChainAsset[];
  readonly erg: bigint;
  /** R5: [opening, floor, start, end, expiry, refundFee] */
  readonly terms: readonly bigint[];
}

export interface ZcShareAuctionDraft {
  readonly openingBps: bigint;
  readonly floorBps: bigint;
  readonly length: bigint;
  readonly expiry: bigint;
  readonly threshold: bigint;
}

export interface ZcShareRequestDraft {
  /** R8: [shareCount, pullFee, mintFee, ...auctionTerms] */
  readonly terms: readonly bigint[];
  readonly auction: ZcShareAuctionDraft | null;
}

export interface ZcWrapDraft {
  readonly tokenId: string;
  readonly amount: bigint | null;
  readonly mintFee: bigint;
  readonly refreshReserve: bigint;
}

export const DEFAULT_REFUND_FEE = 2_000_000n;
export const DEFAULT_SHARE_FEE = 5_000_000n;
export const DEFAULT_WRAP_FEE = 5_000_000n;
export const DEFAULT_REFRESH_RESERVE = 3n * REFRESH_BOUNTY;
export const DEFAULT_AUCTION_LENGTH = 720n;
export const DEFAULT_AUCTION_EXPIRY = 2160n;
export const SELECTIVE_THRESHOLD = 100n;

/** Exact port of ZcDrafts.lotOf. */
export function buildDraftLot(d: Obj, h: bigint): ZcLotDraft {
  const m = marketOf(d);
  const items = readTokens(d.items);
  const erg = optLong(d, "nanoErg") ?? 0n;
  const opening = needLong(d, "opening");
  const floor = needLong(d, "floor");
  const start = optLong(d, "start") ?? h;
  const end = needLong(d, "end");
  const expiry = optLong(d, "expiry") ?? end;
  const refund = optLong(d, "refundFeeNanoErg") ?? DEFAULT_REFUND_FEE;
  const mToken = marketTokenId(m);

  check(
    items.length > 0 || (mToken !== null && erg > 0n),
    `name at least one item${mToken !== null ? ", or some nanoErg" : ""}`
  );
  const uniqueIds = new Set(items.map((t) => t.tokenId));
  check(
    uniqueIds.size === items.length && items.every((t) => t.amount >= 1n),
    "list each item once, with a positive amount"
  );
  check(
    mToken !== null || erg === 0n,
    "an ERG lot sells tokens only: its box's nanoERG return to the seller with the payment"
  );
  check(erg >= 0n && refund >= 0n, "nanoErg and refundFeeNanoErg cannot be negative");
  check(floor >= 1n && floor <= opening, "the lot needs 1 <= floor <= opening");
  check(end > start, "the price must fall over at least one block: end must be above start");
  check(expiry >= end, "the expiry cannot come before the end of the fall");
  check(expiry > h + 1n, "the expiry must be above the current height");
  return { market: m, items, erg, terms: [opening, floor, start, end, expiry, refund] };
}

/** Exact port of ZcDrafts.shareRequestOf. */
export function buildDraftShareRequest(d: Obj): ZcShareRequestDraft {
  const n = optLong(d, "shareCount") ?? SHARE_COUNT;
  const pull = optLong(d, "pullFeeNanoErg") ?? DEFAULT_SHARE_FEE;
  const mint = optLong(d, "mintFeeNanoErg") ?? DEFAULT_SHARE_FEE;
  check(n >= 1n && n <= 1_000_000_000n, "shareCount must be 1 to 1000000000");
  check(
    pull >= MIN_BATCHING_FEE && mint >= MIN_BATCHING_FEE,
    "the pull and mint fees must each be at least 0.002 ERG"
  );

  const vaultKind = typeof d.vault === "string" ? d.vault : "selective";
  let auction: ZcShareAuctionDraft | null = null;
  if (vaultKind === "plain") {
    auction = null;
  } else if (vaultKind === "selective" || vaultKind === "dutch") {
    const length = optLong(d, "length") ?? DEFAULT_AUCTION_LENGTH;
    const openingBps = needLong(d, "openingBps");
    const floorBpsVal = needLong(d, "floorBps");
    const expiry = optLong(d, "expiry") ?? bigMax(DEFAULT_AUCTION_EXPIRY, length);
    const threshold = vaultKind === "dutch" ? LONG_MAX : SELECTIVE_THRESHOLD;
    check(
      floorBpsVal >= 0n && floorBpsVal <= openingBps && openingBps <= 1_000_000n,
      "the auction needs 0 <= floorBps <= openingBps <= 1000000"
    );
    check(length >= 1n && length <= 1_000_000n, "the auction length must be 1 to 1000000 blocks");
    check(
      expiry >= length && expiry <= 1_000_000n,
      "the auction expiry must be from its length to 1000000 blocks"
    );
    auction = { openingBps, floorBps: floorBpsVal, length, expiry, threshold };
  } else {
    badRequest(`vault must be selective, dutch or plain, not ${vaultKind}`);
  }

  const terms = auction
    ? [
        n,
        pull,
        mint,
        auction.openingBps,
        auction.floorBps,
        auction.length,
        auction.expiry,
        auction.threshold
      ]
    : [n, pull, mint];
  return { terms, auction };
}

/** Exact port of ZcDrafts.wrapOf. */
export function buildDraftWrap(d: Obj): ZcWrapDraft {
  const rawToken = typeof d.tokenId === "string" ? d.tokenId.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(rawToken)) {
    badRequest("tokenId must be a 64-character id");
  }
  const amount = optLong(d, "amount");
  const mintFee = optLong(d, "mintFeeNanoErg") ?? DEFAULT_WRAP_FEE;
  const refreshReserve = optLong(d, "refreshReserveNanoErg") ?? DEFAULT_REFRESH_RESERVE;
  check(mintFee >= MIN_BATCHING_FEE, "the mint fee must be at least 0.002 ERG");
  check(refreshReserve >= 0n, "the refresh reserve cannot be negative");
  return { tokenId: rawToken, amount, mintFee, refreshReserve };
}

export function simulateDraft(
  draftInput: Record<string, unknown>,
  matcher: ZcMatcher,
  json: ZcJson
): Record<string, unknown> {
  const d = asObj(draftInput);
  if (!d) badRequest("the body needs a draft object");
  switch (d.type) {
    case "walletLend":
      return simulateWalletLend(d, matcher, json);
    case "offer":
      return simulateOffer(d, matcher);
    case "order":
      return simulateOrder(d, matcher);
    case "ask":
      return simulateAsk(d, matcher);
    default:
      badRequest(
        `draft.type must be order, offer, ask or walletLend, not ${String(d.type ?? "missing")}`
      );
  }
}
