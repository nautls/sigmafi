import {
  ChainAsset,
  LONG_MAX,
  MIN_BOX,
  ZcAsk,
  ZcBond,
  ZcOffer,
  ZcOrder,
  ZcOrigin,
  ZcRecord,
  ZcWrapVault
} from "./boxes";
import { getZcExpressionHash, getZcScript, marketTokenId } from "./contracts";
import { MINER_FEE, openOf, ZcMarketBook, ZcMatcher, ZcOpen } from "./matcher";
import {
  bigMax,
  GUARDED_FIXED_YIELD,
  MAX_ORACLE_AGE,
  MIN_BATCHING_FEE,
  QUOTE_BLOCKS,
  ratioBps,
  RECOLLATERALIZE_WAIT,
  REFRESH_AGE,
  SHARE_COUNT,
  yieldBps,
  YieldLine
} from "./pricing";
import {
  askPrice,
  askSaleGuard,
  askYieldLine,
  batcherFee,
  belowOwnRatio,
  bondTermsOf,
  borrowCurve,
  buysShares,
  coverOfBond,
  delivers,
  deliveryErgBig,
  deliveryValid,
  feeReserve,
  fillFee,
  floorBps,
  freshOracle,
  guardRefusal,
  isCurveOrder,
  isGuardedAsk,
  isTokenOffer,
  isYieldAsk,
  isYieldOrder,
  liqRuleKind,
  maxAge,
  maxBlocks,
  minBlocks,
  minFill,
  minFillBps,
  minPrice,
  offerCurve,
  offerStateOf,
  orderMaturity,
  orderRefusal,
  orderYieldLine,
  originalCapital,
  policyValid,
  prospectBondTerms,
  resolvePrincipal,
  rewardBudget,
  saleGuardRefusal,
  spendBudget,
  wholeUnits,
  ZcBondTerms
} from "./rules";
import { ZcMarket, ZcSnapshotMeta } from "@/types/zc";

export interface ZcCheck {
  readonly key: string;
  readonly ok: boolean | null;
  readonly detail: string;
}

export interface ZcStanding {
  readonly status: string;
  readonly reasons: readonly string[];
  readonly checks: readonly ZcCheck[];
  readonly ok: boolean;
  readonly flags: readonly string[];
}

export interface ZcKnown {
  origin(token: string): ZcOrigin | null;
  disclosed(record: ZcRecord): boolean | null;
  mine(partyHash: string): boolean;
  chain(record: ZcRecord): { rootId: string; initialValue: bigint } | null;
}

export function buildAtMeta(book: ZcMarketBook): ZcSnapshotMeta {
  return {
    height: book.height,
    blockId: book.blockId,
    indexedHeight: book.height,
    revision: book.revision,
    cut: book.cut,
    mempool: book.mempool
  };
}

function makeStanding(
  status: string,
  reasons: readonly string[],
  checks: readonly ZcCheck[]
): ZcStanding {
  const flags: string[] = [];
  for (const c of checks) {
    if (c.ok === false && !flags.includes(c.key)) flags.push(c.key);
  }
  return { status, reasons, checks, ok: status === "ok", flags };
}

function distinctStrings(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

export function toSafeNum(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (n < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
  return Number(n);
}

export class ZcJson {
  private readonly book: ZcMarketBook;
  private readonly height: bigint;

  constructor(private readonly matcher: ZcMatcher, private readonly known: ZcKnown) {
    this.book = matcher.book;
    this.height = BigInt(this.book.height);
  }

  get at(): ZcSnapshotMeta {
    return buildAtMeta(this.book);
  }

  tokens(ts: readonly ChainAsset[]): { tokenId: string; amount: string }[] {
    return ts.map((t) => ({ tokenId: t.tokenId, amount: t.amount.toString() }));
  }

  collateral(nanoErg: bigint, ts: readonly ChainAsset[]): {
    nanoErg: string;
    tokens: { tokenId: string; amount: string }[];
  } {
    return { nanoErg: nanoErg.toString(), tokens: this.tokens(ts) };
  }

  private createdHeight(r: ZcRecord, pending: boolean): number | null {
    if (pending) return null;
    const entry = this.book.entries.get(r.boxId);
    return entry ? entry.height : null;
  }

  coverBps(b: ZcBondTerms): bigint | null {
    const or = this.book.confirmedOracle;
    if (!or) return null;
    const c = coverOfBond(b, or.price);
    return c ? ratioBps(c) : null;
  }

  ruleJson(
    liqHash: string,
    market: ZcMarket,
    payload: readonly bigint[]
  ): Record<string, unknown> {
    const kind = liqRuleKind(liqHash, market);
    if (kind === "oracle" && payload.length >= 2) {
      return {
        kind,
        hash: liqHash,
        ratioBps: toSafeNum(payload[0]),
        oracleAge: toSafeNum(payload[1])
      };
    }
    return { kind, hash: liqHash };
  }

  private yieldLineJson(l: YieldLine): Record<string, number> {
    return {
      h0: toSafeNum(l.start),
      y0: toSafeNum(l.startBps),
      h1: toSafeNum(l.end),
      y1: toSafeNum(l.endBps)
    };
  }

  private pointsJson(ps: readonly [bigint, bigint][]): { blocks: number; bps: number }[] {
    return ps.map(([y, d]) => ({ blocks: toSafeNum(d), bps: toSafeNum(y) }));
  }

  private disclosureCheck(r: ZcRecord): ZcCheck {
    const d = this.known.disclosed(r);
    if (d === true) {
      return { key: "disclosure", ok: true, detail: "the named script is disclosed" };
    }
    if (d === false) {
      return {
        key: "disclosure",
        ok: false,
        detail: "the creating transaction does not disclose the named script"
      };
    }
    return { key: "disclosure", ok: null, detail: "not looked up yet" };
  }

  private oraclePause(age: bigint): string | null {
    if (this.book.refreshPending) return "oracleRefreshPending";
    const o = this.book.confirmedOracle;
    if (!o || !freshOracle(o, age, this.height)) return "oracleStale";
    return null;
  }

  defaultProspect(o: ZcOrder): ZcBondTerms | null {
    const m = orderMaturity(o, this.height);
    if (!m.ok) return null;
    const p = resolvePrincipal(o, this.height, m.value);
    if (!p.ok) return null;
    return prospectBondTerms(o, this.height, m.value, p.value);
  }

  orderStanding(o: ZcOrder): ZcStanding {
    const expr =
      (o.priced && !isYieldOrder(o) && !isCurveOrder(o)) ||
      liqRuleKind(o.liqHash, o.market) === "other" ||
      (o.guardHash !== null && o.guardHash !== getZcExpressionHash("FillGuard", o.market));
    const disc = this.disclosureCheck(o);
    const refusal = orderRefusal(o, this.height);
    const checks: ZcCheck[] = [
      { key: "origin", ok: true, detail: `${o.script.kind} script, standard` },
      {
        key: "expression",
        ok: !expr,
        detail: expr ? "names an expression outside the pinned set" : "pinned expressions"
      },
      disc
    ];
    if (refusal !== null) checks.push({ key: "terms", ok: false, detail: refusal });

    if (this.height + 1n >= o.expiry) return makeStanding("expired", [], checks);
    if (expr || disc.ok === false) {
      const reasons: string[] = [];
      if (expr) reasons.push("expression");
      if (disc.ok === false) reasons.push("disclosure");
      return makeStanding("flagged", reasons, checks);
    }
    if (refusal !== null) return makeStanding("flagged", ["terms"], checks);

    const bond = this.defaultProspect(o);
    const pauses: string[] = [];
    if (o.guardHash !== null && o.payload.length > 1) {
      const op = this.oraclePause(o.payload[1]);
      if (op) pauses.push(op);
    }
    if (bond && this.book.oracle) {
      if (guardRefusal(o, bond, this.book.oracle, this.height) !== null) {
        pauses.push("guard");
      }
    }
    if (bond && this.book.confirmedOracle && belowOwnRatio(bond, this.book.confirmedOracle.price)) {
      pauses.push("underRatio");
    }
    const uniq = distinctStrings(pauses);
    return makeStanding(uniq.length === 0 ? "ok" : "paused", uniq, checks);
  }

  askStanding(a: ZcAsk): ZcStanding {
    const claim = this.matcher.claimOf(a.token.tokenId);
    const source = this.matcher.askSource(openOf(a, false));
    const sg = askSaleGuard(a);
    const guardBad =
      isGuardedAsk(a) && !(sg !== null && sg[0] > 0n && sg[1] >= 1n && sg[1] <= MAX_ORACLE_AGE);
    const expr = (a.priced && !isYieldAsk(a)) || guardBad;
    const disc = this.disclosureCheck(a);
    const checks: ZcCheck[] = [
      {
        key: "origin",
        ok: claim.ok,
        detail: claim.ok
          ? claim.value.whole > 1n
            ? "shares of a standard mint"
            : "a standard bond unit"
          : claim.error
      },
      {
        key: "state",
        ok: source.ok,
        detail: source.ok ? "the bond is live" : source.error
      },
      {
        key: "expression",
        ok: !expr,
        detail: guardBad
          ? "malformed sale guard terms"
          : expr
            ? "names an unknown pricing expression"
            : "pinned expressions"
      },
      disc
    ];
    if (claim.ok && claim.value.whole > 1n) {
      checks.push({
        key: "shareCount",
        ok: claim.value.whole === SHARE_COUNT,
        detail: `${claim.value.whole} raw shares`
      });
    }

    if (this.height + 1n >= a.expiry) return makeStanding("expired", [], checks);
    if (!claim.ok || expr || disc.ok === false) {
      const reasons: string[] = [];
      if (!claim.ok) reasons.push("origin");
      if (expr) reasons.push("expression");
      if (disc.ok === false) reasons.push("disclosure");
      return makeStanding("flagged", reasons, checks);
    }
    if (!source.ok) return makeStanding("paused", ["settled"], checks);

    const bond = bondTermsOf(source.value.bond.record);
    const pauses: string[] = [];
    if (sg) {
      const op = this.oraclePause(sg[1]);
      if (op) pauses.push(op);
    }
    if (this.book.oracle && saleGuardRefusal(a, bond, this.book.oracle, this.height) !== null) {
      pauses.push("guard");
    }
    if (this.book.confirmedOracle && belowOwnRatio(bond, this.book.confirmedOracle.price)) {
      pauses.push("underRatio");
    }
    const uniq = distinctStrings(pauses);
    return makeStanding(uniq.length === 0 ? "ok" : "paused", uniq, checks);
  }

  offerStanding(o: ZcOffer): ZcStanding {
    const s = offerStateOf(o);
    const policy = policyValid(o);
    const curveOk =
      offerCurve(o).ordered &&
      o.terms[0] >= 0n &&
      minBlocks(o) >= 1n &&
      maxBlocks(o) >= minBlocks(o) &&
      feeReserve(o) >= 0n &&
      deliveryValid(o);
    const disc = this.disclosureCheck(o);
    const ergShort =
      !isTokenOffer(o) &&
      s.value <= batcherFee(o) + MIN_BOX + deliveryErgBig(o, buysShares(o));
    const budgetBad =
      ergShort ||
      (isTokenOffer(o) &&
        (originalCapital(s) <= 0n ||
          s.capital <= 0n ||
          s.capital > originalCapital(s) ||
          spendBudget(o) <= 0n ||
          rewardBudget(o) <= 0n ||
          rewardBudget(o) >= spendBudget(o) ||
          minFillBps(o) < 100n ||
          minFillBps(o) > 10_000n ||
          s.value < MIN_BOX + batcherFee(o) + MIN_BATCHING_FEE));

    const checks: ZcCheck[] = [
      { key: "origin", ok: true, detail: "LendOffer script, standard" },
      {
        key: "expression",
        ok: policy,
        detail: policy ? "the market's collateral policy" : "an unknown collateral policy"
      },
      { key: "curve", ok: curveOk, detail: "points strictly increasing" },
      disc
    ];

    if (this.height + 1n >= o.expiry) return makeStanding("expired", [], checks);
    if (!policy || !curveOk || disc.ok === false) {
      const reasons: string[] = [];
      if (!policy || !curveOk) reasons.push("expression");
      if (disc.ok === false) reasons.push("disclosure");
      return makeStanding("flagged", reasons, checks);
    }

    const pauses: string[] = [];
    const op = this.oraclePause(maxAge(o));
    if (op) pauses.push(op);
    if (batcherFee(o) < MIN_BATCHING_FEE || fillFee(s, s.capital) <= MINER_FEE) {
      pauses.push("feeBelowFloor");
    }
    if (budgetBad) pauses.push("budget");
    const uniq = distinctStrings(pauses);
    return makeStanding(uniq.length === 0 ? "ok" : "paused", uniq, checks);
  }

  private standingFields(s: ZcStanding): Record<string, unknown> {
    return {
      status: s.status,
      reasons: s.reasons,
      flags: s.flags,
      checks: s.checks.map((c) => ({ key: c.key, ok: c.ok, detail: c.detail }))
    };
  }

  private baseFields(r: ZcRecord, pending: boolean, useChain: boolean): Record<string, unknown> {
    const ch = useChain ? this.known.chain(r) : null;
    return {
      boxId: r.boxId,
      chainId: useChain ? (ch ? ch.rootId : null) : r.boxId,
      txId: r.box.transactionId,
      created: this.createdHeight(r, pending),
      pending,
      mine: r.namedHash !== null && this.known.mine(r.namedHash),
      contract: r.script.kind
    };
  }

  orderQuote(
    o: ZcOrder
  ): { json: Record<string, unknown>; yieldBps: bigint; blocksLeft: bigint; cost: bigint } | null {
    const m = orderMaturity(o, this.height);
    if (!m.ok) return null;
    const p = resolvePrincipal(o, this.height, m.value);
    if (!p.ok) return null;
    const left = m.value - (this.height + 1n);
    const y = yieldBps(o.repayment, p.value, left) ?? 0n;
    const line = orderYieldLine(o);
    const bc = borrowCurve(o);
    const quoted = line ? line.bpsAt(this.height) : bc ? bc.bpsAt(left) : y;
    const validThrough = o.priced ? this.height + QUOTE_BLOCKS : o.expiry - 2n;

    return {
      json: {
        height: this.book.height,
        maturity: toSafeNum(m.value),
        blocksLeft: toSafeNum(left),
        cost: p.value.toString(),
        face: o.repayment.toString(),
        yieldBps: toSafeNum(y),
        quotedYieldBps: toSafeNum(quoted),
        validFrom: this.book.height,
        validThrough: toSafeNum(validThrough)
      },
      yieldBps: y,
      blocksLeft: left,
      cost: p.value
    };
  }

  orderJson(open: ZcOpen<ZcOrder>): Record<string, unknown> {
    const o = open.record;
    const s = this.orderStanding(o);
    let timing: Record<string, unknown>;
    if (o.mode === 0n) {
      timing = { mode: "fixed", maturity: toSafeNum(o.terms[3]) };
    } else if (o.mode === 1n) {
      timing = { mode: "term", duration: toSafeNum(o.terms[3]) };
    } else {
      const bc = borrowCurve(o);
      timing = {
        mode: "window",
        minDuration: toSafeNum(o.terms[3]),
        maxDuration: o.pricingTerms.length > 0 ? toSafeNum(o.pricingTerms[0]) : null,
        ...(bc
          ? {
              curve: {
                capBps: toSafeNum(bc.maxBps),
                points: this.pointsJson(bc.points)
              }
            }
          : {})
      };
    }

    const pricing = !o.priced
      ? "fixed"
      : isYieldOrder(o)
        ? "yield"
        : isCurveOrder(o)
          ? "window"
          : "other";
    const line = orderYieldLine(o);
    const q = this.orderQuote(o);
    const prospect = this.defaultProspect(o);
    const cov = prospect ? this.coverBps(prospect) : null;

    return {
      ...this.baseFields(o, open.pending, false),
      market: o.market,
      kind: "order",
      borrowerHash: o.borrowerHash,
      borrowedByMe: this.known.mine(o.borrowerHash),
      pricing,
      timing,
      principal: o.principal.toString(),
      repayment: o.repayment.toString(),
      yield: line ? this.yieldLineJson(line) : null,
      collateral: this.collateral(o.box.value - o.expiryFee, o.box.assets),
      rule: this.ruleJson(o.liqHash, o.market, o.payload),
      fillGuard:
        o.guardHash !== null
          ? {
              hash: o.guardHash,
              ratioBps: o.payload.length > 2 ? toSafeNum(o.payload[2]) : null,
              oracleAge: o.payload.length > 1 ? toSafeNum(o.payload[1]) : null
            }
          : null,
      expiry: toSafeNum(o.expiry),
      expiryFeeNanoErg: o.expiryFee.toString(),
      quote: q ? q.json : null,
      coverBps: cov !== null ? toSafeNum(cov) : null,
      ...this.standingFields(s)
    };
  }

  askQuote(
    a: ZcAsk,
    bond: ZcBond | null,
    whole: bigint
  ): { json: Record<string, unknown>; yieldBps: bigint; blocksLeft: bigint; cost: bigint } | null {
    const terms = bond ? bondTermsOf(bond) : null;
    const pRes = askPrice(a, a.token.amount, terms, this.height);
    if (!pRes.ok || !terms) return null;
    const price = pRes.value;
    const left = terms.maturity - (this.height + 1n);
    const denom = whole > 1n ? whole : 1n;
    const face = (terms.repayment * a.token.amount) / denom;
    const y = yieldBps(terms.repayment * a.token.amount, price * whole, left) ?? 0n;
    const line = askYieldLine(a);
    const quoted = line ? line.bpsAt(this.height) : y;
    const validThrough = a.priced ? this.height + QUOTE_BLOCKS : a.expiry - 2n;

    return {
      json: {
        height: this.book.height,
        maturity: toSafeNum(terms.maturity),
        blocksLeft: toSafeNum(left),
        cost: price.toString(),
        face: face.toString(),
        yieldBps: toSafeNum(y),
        quotedYieldBps: toSafeNum(quoted),
        validFrom: this.book.height,
        validThrough: toSafeNum(validThrough)
      },
      yieldBps: y,
      blocksLeft: left,
      cost: price
    };
  }

  askJson(open: ZcOpen<ZcAsk>): Record<string, unknown> {
    const a = open.record;
    const s = this.askStanding(a);
    const claimRes = this.matcher.claimOf(a.token.tokenId);
    const claim = claimRes.ok ? claimRes.value : null;
    const whole = claim ? claim.whole : wholeUnits(a);
    const bond = claim ? this.book.bonds.get(claim.asset)?.record ?? null : null;
    const line = askYieldLine(a);
    const isFixedGuard = line !== null && line.startBps === GUARDED_FIXED_YIELD;
    const sg = askSaleGuard(a);
    const guard = !isFixedGuard ? sg : null;
    const fixedGuard = isFixedGuard ? sg : null;
    const pricing = !a.priced || fixedGuard !== null ? "fixed" : "yield";

    const priceTerms: Record<string, unknown> = !a.priced
      ? { price: { num: a.terms[0].toString(), den: a.terms[1].toString() } }
      : {
          floor: { num: a.terms[0].toString(), den: a.terms[1].toString() },
          yield: fixedGuard === null && line ? this.yieldLineJson(line) : null
        };

    const activeGuard = guard ?? fixedGuard;
    const q = this.askQuote(a, bond, whole);
    const cov = bond ? this.coverBps(bondTermsOf(bond)) : null;

    return {
      ...this.baseFields(a, open.pending, true),
      market: a.market,
      kind: whole > 1n ? "shares" : "unit",
      sellerHash: a.sellerHash,
      borrowedByMe: bond !== null && this.known.mine(bond.borrowerHash),
      pricing,
      tokenId: a.token.tokenId,
      units: a.token.amount.toString(),
      minFill: minFill(a).toString(),
      saleGuard: activeGuard
        ? { ratioBps: toSafeNum(activeGuard[0]), oracleAge: toSafeNum(activeGuard[1]) }
        : null,
      expiry: toSafeNum(a.expiry),
      bondId: claim ? claim.asset : null,
      bond: claim ? this.bondJson(claim.asset) : null,
      shares: claim && claim.whole > 1n ? this.sharesJson(a.token.tokenId) : null,
      quote: q ? q.json : null,
      coverBps: cov !== null ? toSafeNum(cov) : null,
      ...priceTerms,
      ...this.standingFields(s)
    };
  }

  private deliveryKind(o: ZcOffer): string {
    const fractional = getZcScript("FractionalMint", null).treeHash;
    const dutch = getZcScript("DutchAuctionMint", o.market).treeHash;
    if (o.mintHashHex === fractional) return "plain";
    if (o.mintHashHex === dutch) return o.fractional[7] === LONG_MAX ? "dutch" : "selective";
    return "other";
  }

  offerJson(open: ZcOpen<ZcOffer>): Record<string, unknown> {
    const o = open.record;
    const s = this.offerStanding(o);
    const st = offerStateOf(o);
    const ch = this.known.chain(o);

    const auction =
      o.fractional.length >= 8
        ? {
            openingBps: toSafeNum(o.fractional[3]),
            floorBps: toSafeNum(o.fractional[4]),
            length: toSafeNum(o.fractional[5]),
            expiry: toSafeNum(o.fractional[6]),
            threshold: o.fractional[7].toString()
          }
        : null;

    const delivery = !delivers(o)
      ? { kind: "unit" }
      : {
          kind: this.deliveryKind(o),
          mintHash: o.mintHashHex,
          shareCount: o.fractional.length > 0 ? o.fractional[0].toString() : null,
          pullFeeNanoErg: o.fractional.length > 1 ? o.fractional[1].toString() : null,
          mintFeeNanoErg: o.fractional.length > 2 ? o.fractional[2].toString() : null,
          auction
        };

    return {
      ...this.baseFields(o, open.pending, true),
      predecessorId: o.predecessor,
      market: o.market,
      ownerHash: o.ownerHash,
      capital: o.capital.toString(),
      boxNanoErg: o.box.value.toString(),
      minYieldBps: toSafeNum(o.terms[0]),
      minBlocks: toSafeNum(minBlocks(o)),
      maxBlocks: toSafeNum(maxBlocks(o)),
      curve: this.pointsJson(o.curve),
      policy: {
        hash: o.policyHash,
        floorBps: toSafeNum(floorBps(o)),
        oracleAge: toSafeNum(maxAge(o))
      },
      batcherFeeNanoErg: batcherFee(o).toString(),
      reserveNanoErg: feeReserve(o).toString(),
      minPrice: minPrice(o).toString(),
      expiry: toSafeNum(o.expiry),
      shareBounds: buysShares(o)
        ? { floorBps: toSafeNum(o.terms[9]), maxExpiry: toSafeNum(o.terms[10]) }
        : null,
      tokenBudget: isTokenOffer(o)
        ? {
            originalCapital: o.terms[11].toString(),
            totalErgBudget: o.terms[12].toString(),
            minFillBps: toSafeNum(o.terms[13]),
            rewardBudget: o.terms[14].toString()
          }
        : null,
      rewardNowNanoErg: fillFee(st, st.capital).toString(),
      delivery,
      originalCapital: isTokenOffer(o)
        ? o.terms[11].toString()
        : ch
          ? ch.initialValue.toString()
          : null,
      ...this.standingFields(s)
    };
  }

  private principalOfBond(b: ZcBond): bigint {
    return marketTokenId(b.market) === null ? b.terms[1] : b.principalTokens[0]?.amount ?? 0n;
  }

  bondJson(asset: string): Record<string, unknown> | null {
    const liveOpen = this.book.bonds.get(asset) ?? null;
    const settledOpen = this.book.settlements.get(asset) ?? null;
    if (!liveOpen && !settledOpen) return null;

    const orig = this.known.origin(asset);
    const originJson = orig
      ? {
          orderBoxId: orig.token,
          contract: orig.kind,
          fillTxId: orig.txId,
          height: orig.height
        }
      : null;

    let originCheck: ZcCheck;
    if (orig && (orig.kind === "Order" || orig.kind === "PricedOrder")) {
      originCheck = {
        key: "origin",
        ok: liveOpen === null || orig.market === liveOpen.record.market,
        detail: `minted by a standard ${orig.kind}`
      };
    } else if (orig) {
      originCheck = { key: "origin", ok: false, detail: "not minted by a standard order" };
    } else {
      originCheck = { key: "origin", ok: null, detail: "not looked up yet" };
    }

    if (liveOpen) {
      const b = liveOpen.record;
      const terms = bondTermsOf(b);
      const cov = this.coverBps(terms);
      const timing = b.terms[6] === 0n ? "fixed" : b.terms[6] === 1n ? "term" : "window";
      return {
        assetId: asset,
        stateBoxId: b.boxId,
        stateCreated: b.box.creationHeight,
        state: "live",
        market: b.market,
        borrowerHash: b.borrowerHash,
        principal: this.principalOfBond(b).toString(),
        repayment: b.repayment.toString(),
        start: toSafeNum(b.start),
        maturity: toSafeNum(b.maturity),
        timing,
        reserveNanoErg: b.feeReserve.toString(),
        collateral: this.collateral(b.collateralErg, b.collateral),
        rule: this.ruleJson(b.liqHash, b.market, b.terms.slice(7)),
        coverBps: cov !== null ? toSafeNum(cov) : null,
        recollateralizeFrom: b.box.creationHeight + Number(RECOLLATERALIZE_WAIT),
        refreshFrom: b.box.creationHeight + Number(REFRESH_AGE) + 1,
        origin: originJson,
        settlement: null,
        pending: liveOpen.pending,
        mine: this.known.mine(b.borrowerHash),
        borrowedByMe: this.known.mine(b.borrowerHash),
        checks: [originCheck]
      };
    }

    const v = settledOpen!.record;
    const stateLabel = v.liquidated ? "liquidated" : "repaid";
    return {
      assetId: asset,
      stateBoxId: v.boxId,
      state: stateLabel,
      settledBondBoxId: v.bondBoxId,
      origin: originJson,
      pending: settledOpen!.pending,
      settlement: {
        vaultBoxId: v.boxId,
        kind: stateLabel,
        nanoErg: v.box.value.toString(),
        tokens: this.tokens(v.proceeds)
      },
      checks: [originCheck]
    };
  }

  sharesJson(shareId: string): Record<string, unknown> | null {
    const open = this.book.shareVaults.get(shareId);
    if (!open) return null;
    const v = open.record;
    const mint = this.known.origin(shareId);
    const claim = this.matcher.claimOf(shareId);
    const liveBond = this.book.bonds.get(v.bondAsset);
    const repayment = liveBond ? liveBond.record.repayment : null;

    const auction =
      v.dutch && v.auction.length >= 7
        ? {
            openingBps: toSafeNum(v.auction[1]),
            floorBps: toSafeNum(v.auction[2]),
            length: toSafeNum(v.auction[3]),
            expiry: toSafeNum(v.auction[4]),
            threshold: v.auction[5].toString()
          }
        : null;

    const minLot =
      repayment !== null && repayment > 0n
        ? bigMax(1n, (v.shares + repayment - 1n) / repayment).toString()
        : null;

    return {
      tokenId: shareId,
      bondId: v.bondAsset,
      mint: mint ? mint.kind : null,
      borrowedByMe: liveBond !== undefined && this.known.mine(liveBond.record.borrowerHash),
      type: !v.dutch ? "plain" : v.auction[5] === LONG_MAX ? "dutch" : "selective",
      shareCount: v.shares.toString(),
      decimals: 6,
      auction,
      vault: {
        boxId: v.boxId,
        contract: v.script.kind,
        state: v.state,
        pulled: !v.holding,
        outstanding: v.outstanding.toString(),
        nanoErg: v.box.value.toString(),
        tokens: this.tokens(v.box.assets.slice(1)),
        auctionStart:
          v.auction.length > 6 && v.auction[6] > 0n ? toSafeNum(v.auction[6]) : null,
        pending: open.pending
      },
      minLot,
      checks: [
        {
          key: "origin",
          ok: mint === null ? null : claim.ok,
          detail: claim.ok ? "a standard share mint" : claim.error
        },
        {
          key: "shareCount",
          ok: v.shares === SHARE_COUNT,
          detail: `${v.shares} raw shares`
        }
      ]
    };
  }

  wrapJson(v: ZcWrapVault): Record<string, unknown> {
    return {
      receiptId: v.receiptId,
      token: v.wrapped.tokenId,
      amount: v.wrapped.amount.toString(),
      vaultBoxId: v.boxId,
      state: "wrapped",
      refreshFrom: v.box.creationHeight + Number(REFRESH_AGE) + 1
    };
  }
}
