import {
  isStateKind,
  LONG_MIN,
  MIN_BOX,
  ZcAsk,
  ZcBond,
  ZcEntry,
  ZcLot,
  ZcOffer,
  ZcOracle,
  ZcOrder,
  ZcOrigin,
  ZcRecord,
  ZcSettlement,
  ZcShareRequest,
  ZcShareVault,
  ZcWrapRequest,
  ZcWrapVault
} from "./boxes";
import { marketTokenId } from "./contracts";
import { bigMax, isValidLong, MIN_BATCHING_FEE, rankYield, yieldBps } from "./pricing";
import {
  askPrice,
  batcherFee,
  belowOwnRatio,
  bondTermsOf,
  buysShares,
  deliveryErgBig,
  deliveryValid,
  Either,
  feeReserve,
  fillFee,
  fillRefusal,
  guardRefusal,
  isTokenOffer,
  isWindowOrder,
  left,
  liqRuleKind,
  maxBlocks,
  minBlocks,
  minContinuationErg,
  minFill,
  minFillBps,
  offerCost,
  offerCurve,
  offerRefusal,
  offerStateOf,
  orderMaturity,
  orderRefusal,
  originalCapital,
  policyValid,
  prospectBondTerms,
  resolvePrincipal,
  rewardBudget,
  right,
  saleGuardRefusal,
  shareRefusal,
  spendBudget,
  vaultCurrency,
  windowMaturity,
  ZcBondTerms,
  ZcOfferState
} from "./rules";
import { ZcMarket } from "@/types/zc";

export const MINER_FEE = 1_000_000n;
export const MAX_OFFERS = 200;
export const MAX_SOURCES = 1000;
export const DEFAULT_ROUNDS = 10;

export interface ZcOpen<A extends ZcRecord = ZcRecord> {
  readonly record: A;
  readonly pending: boolean;
  readonly boxId: string;
}

export function openOf<A extends ZcRecord>(record: A, pending = false): ZcOpen<A> {
  return { record, pending, boxId: record.boxId };
}

export interface ZcMarketBook {
  readonly height: number;
  readonly blockId: string;
  readonly revision: number;
  readonly cut: boolean;
  readonly mempool: boolean;
  readonly entries: ReadonlyMap<string, ZcEntry>;
  readonly confirmedOracle: ZcOracle | null;
  readonly refreshPending: boolean;
  readonly oracle: ZcOracle | null;
  readonly orders: readonly ZcOpen<ZcOrder>[];
  readonly asks: readonly ZcOpen<ZcAsk>[];
  readonly offers: readonly ZcOpen<ZcOffer>[];
  readonly lots: readonly ZcOpen<ZcLot>[];
  readonly shareRequests: readonly ZcOpen<ZcShareRequest>[];
  readonly wrapRequests: readonly ZcOpen<ZcWrapRequest>[];
  readonly bonds: ReadonlyMap<string, ZcOpen<ZcBond>>;
  readonly settlements: ReadonlyMap<string, ZcOpen<ZcSettlement>>;
  readonly shareVaults: ReadonlyMap<string, ZcOpen<ZcShareVault>>;
  readonly wrapVaults: ReadonlyMap<string, ZcOpen<ZcWrapVault>>;
  readonly allOpen: readonly ZcOpen<ZcRecord>[];
  readonly byBoxId: ReadonlyMap<string, ZcOpen<ZcRecord>>;
}

function cmpBoxId(a: { boxId: string }, b: { boxId: string }): number {
  return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
}

export function buildMarketBook(params: {
  height: number;
  blockId: string;
  revision: number;
  cut: boolean;
  entries: ReadonlyMap<string, ZcEntry>;
  confirmedOracle: ZcOracle | null;
  refreshPending?: boolean;
}): ZcMarketBook {
  const refreshPending = params.refreshPending ?? false;
  const orders: ZcOpen<ZcOrder>[] = [];
  const asks: ZcOpen<ZcAsk>[] = [];
  const offers: ZcOpen<ZcOffer>[] = [];
  const lots: ZcOpen<ZcLot>[] = [];
  const shareRequests: ZcOpen<ZcShareRequest>[] = [];
  const wrapRequests: ZcOpen<ZcWrapRequest>[] = [];
  const allOpen: ZcOpen<ZcRecord>[] = [];
  const byBoxId = new Map<string, ZcOpen<ZcRecord>>();
  const stateBuckets = new Map<string, ZcOpen<ZcRecord>[]>();

  for (const entry of params.entries.values()) {
    const r = entry.record;
    const open = openOf(r, false);
    allOpen.push(open);
    byBoxId.set(r.boxId, open);

    switch (r.recordType) {
      case "order":
        orders.push(openOf(r, false));
        break;
      case "ask":
        asks.push(openOf(r, false));
        break;
      case "offer":
        offers.push(openOf(r, false));
        break;
      case "lot":
        lots.push(openOf(r, false));
        break;
      case "shareRequest":
        shareRequests.push(openOf(r, false));
        break;
      case "wrapRequest":
        wrapRequests.push(openOf(r, false));
        break;
      default:
        if (isStateKind(r.script.kind)) {
          const first = r.box.assets[0];
          if (first) {
            const list = stateBuckets.get(first.tokenId) ?? [];
            list.push(open);
            stateBuckets.set(first.tokenId, list);
          }
        }
        break;
    }
  }

  const bonds = new Map<string, ZcOpen<ZcBond>>();
  const settlements = new Map<string, ZcOpen<ZcSettlement>>();
  const shareVaults = new Map<string, ZcOpen<ZcShareVault>>();
  const wrapVaults = new Map<string, ZcOpen<ZcWrapVault>>();

  for (const [tokenId, list] of stateBuckets) {
    // A token claimed by more than one state box has no unique state box (mirrors ZcMarketBook.of).
    if (list.length !== 1) continue;
    const one = list[0];
    switch (one.record.recordType) {
      case "bond":
        bonds.set(tokenId, one as ZcOpen<ZcBond>);
        break;
      case "settlement":
        settlements.set(tokenId, one as ZcOpen<ZcSettlement>);
        break;
      case "shareVault":
        shareVaults.set(tokenId, one as ZcOpen<ZcShareVault>);
        break;
      case "wrapVault":
        wrapVaults.set(tokenId, one as ZcOpen<ZcWrapVault>);
        break;
      default:
        break;
    }
  }

  orders.sort(cmpBoxId);
  asks.sort(cmpBoxId);
  offers.sort(cmpBoxId);
  lots.sort(cmpBoxId);
  shareRequests.sort(cmpBoxId);
  wrapRequests.sort(cmpBoxId);

  return {
    height: params.height,
    blockId: params.blockId,
    revision: params.revision,
    cut: params.cut,
    mempool: false,
    entries: params.entries,
    confirmedOracle: params.confirmedOracle,
    refreshPending,
    oracle: refreshPending ? null : params.confirmedOracle,
    orders,
    asks,
    offers,
    lots,
    shareRequests,
    wrapRequests,
    bonds,
    settlements,
    shareVaults,
    wrapVaults,
    allOpen,
    byBoxId
  };
}

export interface ZcOrderSource {
  readonly sourceType: "order";
  readonly open: ZcOpen<ZcOrder>;
  readonly boxId: string;
  readonly pending: boolean;
  readonly market: ZcMarket;
  readonly order: ZcOrder;
}

export interface ZcAskSource {
  readonly sourceType: "ask";
  readonly open: ZcOpen<ZcAsk>;
  readonly boxId: string;
  readonly pending: boolean;
  readonly market: ZcMarket;
  readonly ask: ZcAsk;
  readonly asset: string;
  readonly whole: bigint;
  readonly bond: ZcOpen<ZcBond>;
  readonly mint: ZcOrigin | null;
  readonly shares: boolean;
  readonly units: bigint;
}

export type ZcSource = ZcOrderSource | ZcAskSource;

export function orderSourceOf(open: ZcOpen<ZcOrder>): ZcOrderSource {
  return {
    sourceType: "order",
    open,
    boxId: open.boxId,
    pending: open.pending,
    market: open.record.market,
    order: open.record
  };
}

export interface ZcMatch {
  readonly offerId: string;
  readonly sourceId: string;
  readonly units: bigint;
  readonly price: bigint;
  readonly cost: bigint;
  readonly face: bigint;
  readonly maturity: bigint;
  readonly blocksLeft: bigint;
  readonly yieldBps: bigint;
  readonly requiredBps: bigint;
  readonly rank: bigint;
  readonly fee: bigint;
  readonly ergOut: bigint;
}

export interface ZcSearched {
  readonly offers: number;
  readonly offersSearched: number;
  readonly sources: number;
  readonly sourcesSearched: number;
}

export interface ZcBatchRun {
  readonly rounds: number;
  readonly taken: ReadonlyMap<string, ZcMatch[]>;
  readonly takenBy: ReadonlyMap<string, ZcMatch>;
  readonly searched: ZcSearched;
}

export class ZcMatcher {
  readonly height: bigint;
  private readonly oracle: ZcOracle | null;

  constructor(
    readonly book: ZcMarketBook,
    private readonly originFn: (token: string) => ZcOrigin | null,
    private readonly maxOffers = MAX_OFFERS,
    private readonly maxSources = MAX_SOURCES,
    private readonly excluded: (r: ZcRecord) => boolean = () => false
  ) {
    this.height = BigInt(book.height);
    this.oracle = book.oracle;
  }

  claimOf(token: string): Either<string, { asset: string; whole: bigint; mint: ZcOrigin | null }> {
    const o = this.originFn(token);
    if (!o) return left("the token's origin is unverified");
    if (o.kind === "Order" || o.kind === "PricedOrder") {
      return right({ asset: token, whole: 1n, mint: null });
    }
    if (o.kind === "FractionalMint" || o.kind === "DutchAuctionMint") {
      const vaultOpen = this.book.shareVaults.get(token);
      if (!vaultOpen) return left("no share vault holds this token's reserve");
      const v = vaultOpen.record;
      const unit = o.held;
      const currencyOk = !v.dutch || (o.market !== null && marketTokenId(o.market) === vaultCurrency(v));
      if (
        !unit ||
        unit.tokenId !== v.bondAsset ||
        o.terms[0] !== v.shares ||
        v.dutch !== (o.kind === "DutchAuctionMint") ||
        !currencyOk
      ) {
        return left("the shares' vault does not match their mint request");
      }
      const bOrigin = this.originFn(v.bondAsset);
      if (!bOrigin) return left("the shares' bond asset is unverified");
      if (bOrigin.kind === "Order" || bOrigin.kind === "PricedOrder") {
        return right({ asset: v.bondAsset, whole: v.shares, mint: o });
      }
      return left("the shares' bond asset was not minted by a standard order");
    }
    return left("the token was not minted as a bond unit or shares");
  }

  askSource(open: ZcOpen<ZcAsk>): Either<string, ZcAskSource> {
    const c = this.claimOf(open.record.token.tokenId);
    if (!c.ok) return c;
    const { asset, whole, mint } = c.value;
    const bond = this.book.bonds.get(asset);
    if (!bond) return left("the bond is not live");
    if (this.excluded(bond.record)) return left("the bond is excluded");
    if (bond.record.market !== open.record.market) {
      return left("the ask is paid in another market than its bond");
    }
    if (open.record.priced && open.record.pricedAsset !== asset) {
      return left("the ask prices another bond");
    }
    const shares = whole > 1n;
    return right({
      sourceType: "ask",
      open,
      boxId: open.boxId,
      pending: open.pending,
      market: open.record.market,
      ask: open.record,
      asset,
      whole,
      bond,
      mint,
      shares,
      units: shares ? open.record.token.amount : 1n
    });
  }

  evaluate(s: ZcOfferState, source: ZcSource, ignoreYield = false): Either<string, ZcMatch> {
    if (s.market !== source.market) return left("another market");
    return source.sourceType === "order"
      ? this.evaluateOrder(s, source.order, ignoreYield)
      : this.evaluateAsk(s, source, ignoreYield);
  }

  private evaluateOrder(
    s: ZcOfferState,
    order: ZcOrder,
    ignoreYield: boolean
  ): Either<string, ZcMatch> {
    let matRes: Either<string, bigint>;
    if (isWindowOrder(order)) {
      const wm = windowMaturity(s, order, this.oracle, this.height, ignoreYield);
      matRes = wm === null ? left("no maturity in the window suits the offer") : right(wm);
    } else {
      matRes = orderMaturity(order, this.height);
    }
    if (!matRes.ok) return matRes;
    const m = matRes.value;

    const pRes = resolvePrincipal(order, this.height, m);
    if (!pRes.ok) return pRes;
    const principal = pRes.value;

    const bond = prospectBondTerms(order, this.height, m, principal);
    const oRef = offerRefusal(s, bond, principal, 1n, 1n, this.oracle, this.height, {
      primary: true,
      ignoreYield
    });
    if (oRef !== null) return left(oRef);
    const gRef = guardRefusal(order, bond, this.oracle, this.height);
    if (gRef !== null) return left(gRef);

    const fee = fillFee(s, principal);
    const ergOut = fee + deliveryErgBig(s.offer, false) + feeReserve(s.offer) + bond.principalErg;
    if (ergOut < 0n || !isValidLong(ergOut)) return left("the fill's ERG requirement overflows");

    return this.purchase(s, order.boxId, 1n, 1n, principal, order.repayment, m, fee, ergOut);
  }

  private evaluateAskUnits(
    s: ZcOfferState,
    a: ZcAskSource,
    bond: ZcBondTerms,
    units: bigint,
    ignoreYield: boolean
  ): Either<string, ZcMatch> {
    const fRef = fillRefusal(a.ask, units, this.height);
    if (fRef !== null) return left(fRef);

    const qRes = askPrice(a.ask, units, bond, this.height);
    if (!qRes.ok) return qRes;
    const price = !isTokenOffer(s.offer) ? bigMax(qRes.value, MIN_BOX) : qRes.value;

    const oRef = offerRefusal(s, bond, price, units, a.whole, this.oracle, this.height, {
      shares: a.shares,
      ignoreYield
    });
    if (oRef !== null) return left(oRef);
    const sgRef = saleGuardRefusal(a.ask, bond, this.oracle, this.height);
    if (sgRef !== null) return left(sgRef);

    const fee = fillFee(s, price);
    const ergOut =
      fee + deliveryErgBig(s.offer, a.shares) + (isTokenOffer(s.offer) ? MIN_BOX : price);
    if (ergOut < 0n || !isValidLong(ergOut)) return left("the fill's ERG requirement overflows");

    return this.purchase(
      s,
      a.boxId,
      units,
      a.whole,
      price,
      bond.repayment,
      bond.maturity,
      fee,
      ergOut
    );
  }

  private askUnitsAffordable(
    s: ZcOfferState,
    a: ZcAskSource,
    bond: ZcBondTerms,
    units: bigint
  ): boolean {
    const qRes = askPrice(a.ask, units, bond, this.height);
    if (!qRes.ok) return false;
    const price = !isTokenOffer(s.offer) ? bigMax(qRes.value, MIN_BOX) : qRes.value;
    if (price > s.capital) return false;
    const fee = fillFee(s, price);
    const ergOut =
      fee + deliveryErgBig(s.offer, a.shares) + (isTokenOffer(s.offer) ? MIN_BOX : price);
    if (ergOut < 0n || !isValidLong(ergOut)) return false;
    const minCont = minContinuationErg(s.offer, isTokenOffer(s.offer) ? s.capital - price : 0n);
    if (!isTokenOffer(s.offer)) {
      return s.value - ergOut >= minCont;
    }
    const orig = originalCapital(s);
    return (
      orig > 0n &&
      ergOut * orig <= spendBudget(s.offer) * price &&
      s.value - ergOut >= bigMax(minCont, MIN_BOX + batcherFee(s.offer))
    );
  }

  private evaluateAsk(
    s: ZcOfferState,
    a: ZcAskSource,
    ignoreYield: boolean
  ): Either<string, ZcMatch> {
    const bond = bondTermsOf(a.bond.record);

    if (a.shares) {
      if (!a.mint) return left("the shares' mint is unknown");
      const sRef = shareRefusal(s.offer, a.mint);
      if (sRef !== null) return left(sRef);
    }

    const fullRes = this.evaluateAskUnits(s, a, bond, a.units, ignoreYield);
    if (fullRes.ok || !a.shares) return fullRes;

    // Support partial fills on share asks when the offer's remaining capital/ERG cannot
    // take the entire ask but can take at least `minFill`.
    const loBound = bigMax(1n, minFill(a.ask));
    const hiBound = a.ask.token.amount - 1n;
    if (loBound > hiBound) return fullRes;

    if (!this.askUnitsAffordable(s, a, bond, loBound)) {
      return fullRes;
    }

    let lo = loBound;
    let hi = hiBound;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (this.askUnitsAffordable(s, a, bond, mid)) lo = mid;
      else hi = mid - 1n;
    }
    return this.evaluateAskUnits(s, a, bond, lo, ignoreYield);
  }

  private purchase(
    s: ZcOfferState,
    sourceId: string,
    units: bigint,
    whole: bigint,
    price: bigint,
    repayment: bigint,
    maturity: bigint,
    fee: bigint,
    ergOut: bigint
  ): Either<string, ZcMatch> {
    if (fee <= MINER_FEE) return left("the batcher reward does not cover a miner fee");
    const minCont = minContinuationErg(s.offer, isTokenOffer(s.offer) ? s.capital - price : 0n);
    if (ergOut < 0n || s.value - ergOut < minCont) {
      return left("the offer cannot keep a box minimum after this fill");
    }
    const c = offerCost(s, price);
    const face = repayment * units;
    const leftBlocks = maturity - (this.height + 1n);
    return right({
      offerId: s.boxId,
      sourceId,
      units,
      price,
      cost: c,
      face: face / whole,
      maturity,
      blocksLeft: leftBlocks,
      yieldBps: yieldBps(face, c * whole, leftBlocks) ?? 0n,
      requiredBps: offerCurve(s.offer).bpsAt(leftBlocks),
      rank: rankYield(face, c * whole, leftBlocks),
      fee,
      ergOut
    });
  }

  offerStates(market: ZcMarket): ZcOfferState[] {
    const out: ZcOfferState[] = [];
    for (const op of this.book.offers) {
      const o = op.record;
      const s = offerStateOf(o);
      if (
        o.market !== market ||
        this.height + 1n >= o.expiry ||
        this.excluded(o) ||
        !policyValid(o) ||
        !offerCurve(o).ordered ||
        o.terms[0] < 0n ||
        minBlocks(o) < 1n ||
        maxBlocks(o) < minBlocks(o) ||
        feeReserve(o) < 0n ||
        !deliveryValid(o) ||
        batcherFee(o) < MIN_BATCHING_FEE
      ) {
        continue;
      }
      if (!isTokenOffer(o)) {
        const minDelivery = deliveryErgBig(o, buysShares(o));
        const minCont = minContinuationErg(o, 0n);
        if (s.value <= batcherFee(o) + minCont + minDelivery) continue;
      } else {
        const minCont = minContinuationErg(o, s.capital);
        if (
          originalCapital(s) <= 0n ||
          s.capital <= 0n ||
          s.capital > originalCapital(s) ||
          spendBudget(o) <= 0n ||
          rewardBudget(o) <= 0n ||
          rewardBudget(o) >= spendBudget(o) ||
          minFillBps(o) < 100n ||
          minFillBps(o) > 10_000n ||
          s.value < bigMax(minCont, MIN_BOX + batcherFee(o)) + MIN_BATCHING_FEE
        ) {
          continue;
        }
      }
      if (fillFee(s, s.capital) > MINER_FEE) {
        out.push(s);
      }
    }
    out.sort((a, b) => {
      const fa = fillFee(a, a.capital);
      const fb = fillFee(b, b.capital);
      if (fa !== fb) return fa > fb ? -1 : 1;
      return cmpBoxId(a, b);
    });
    return out;
  }

  sources(market: ZcMarket): ZcSource[] {
    const list: { source: ZcSource; yieldRank: bigint }[] = [];

    for (const o of this.book.orders) {
      if (
        o.record.market === market &&
        !this.excluded(o.record) &&
        liqRuleKind(o.record.liqHash, market) === "oracle" &&
        orderRefusal(o.record, this.height) === null
      ) {
        const src = orderSourceOf(o);
        list.push({ source: src, yieldRank: this.ownYield(src) });
      }
    }

    for (const a of this.book.asks) {
      if (
        a.record.market !== market ||
        this.height + 1n >= a.record.expiry ||
        this.excluded(a.record)
      ) {
        continue;
      }
      const res = this.askSource(a);
      if (!res.ok) continue;
      const src = res.value;
      if (liqRuleKind(src.bond.record.liqHash, market) !== "oracle") continue;
      if (this.oracle && belowOwnRatio(bondTermsOf(src.bond.record), this.oracle.price)) continue;
      list.push({ source: src, yieldRank: this.ownYield(src) });
    }

    list.sort((a, b) => {
      if (a.yieldRank !== b.yieldRank) return a.yieldRank > b.yieldRank ? -1 : 1;
      return cmpBoxId(a.source, b.source);
    });
    return list.map((x) => x.source);
  }

  ownYield(source: ZcSource): bigint {
    if (source.sourceType === "order") {
      const m = orderMaturity(source.order, this.height);
      if (!m.ok) return LONG_MIN;
      const p = resolvePrincipal(source.order, this.height, m.value);
      if (!p.ok) return LONG_MIN;
      return rankYield(source.order.repayment, p.value, m.value - (this.height + 1n));
    }
    const bond = bondTermsOf(source.bond.record);
    const p = askPrice(source.ask, source.units, bond, this.height);
    if (!p.ok) return LONG_MIN;
    return rankYield(
      bond.repayment * source.units,
      p.value * source.whole,
      bond.maturity - (this.height + 1n)
    );
  }

  candidates(s: ZcOfferState, from: readonly ZcSource[]): ZcMatch[] {
    const out: ZcMatch[] = [];
    for (const src of from) {
      const res = this.evaluate(s, src);
      if (res.ok) out.push(res.value);
    }
    out.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank > b.rank ? -1 : 1;
      return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
    });
    return out;
  }

  batch(
    market: ZcMarket,
    rounds = DEFAULT_ROUNDS,
    extraOffers: readonly ZcOfferState[] = [],
    extraSources: readonly ZcSource[] = []
  ): ZcBatchRun {
    const allOffers = [
      ...this.offerStates(market),
      ...extraOffers.filter((s) => s.market === market)
    ];
    allOffers.sort((a, b) => {
      const fa = fillFee(a, a.capital);
      const fb = fillFee(b, b.capital);
      if (fa !== fb) return fa > fb ? -1 : 1;
      return cmpBoxId(a, b);
    });

    const base = this.sources(market);
    const extra = extraSources.filter((s) => s.market === market);
    let allSources: ZcSource[];
    if (extra.length === 0) {
      allSources = base;
    } else {
      const ranked = [...base, ...extra].map((source) => ({
        source,
        y: this.ownYield(source)
      }));
      ranked.sort((a, b) => {
        if (a.y !== b.y) return a.y > b.y ? -1 : 1;
        return cmpBoxId(a.source, b.source);
      });
      allSources = ranked.map((x) => x.source);
    }

    const searchedOffers = allOffers.slice(0, this.maxOffers);
    const searchedSources = allSources.slice(0, this.maxSources);

    let states = searchedOffers;
    let open = searchedSources;
    const taken = new Map<string, ZcMatch[]>();
    const takenBy = new Map<string, ZcMatch>();
    let round = 0;
    let progress = true;

    while (progress && round < rounds) {
      round++;
      progress = false;
      const used = new Set<string>();
      const nextStates: ZcOfferState[] = [];

      for (const s of states) {
        let best: ZcMatch | null = null;
        for (const src of open) {
          if (used.has(src.boxId)) continue;
          const res = this.evaluate(s, src);
          if (!res.ok) continue;
          const m = res.value;
          if (
            !best ||
            m.rank > best.rank ||
            (m.rank === best.rank && m.sourceId < best.sourceId)
          ) {
            best = m;
          }
        }
        if (best) {
          used.add(best.sourceId);
          const list = taken.get(s.boxId) ?? [];
          list.push(best);
          taken.set(s.boxId, list);
          takenBy.set(best.sourceId, best);
          progress = true;
          const nextValue = s.value - best.ergOut;
          nextStates.push({
            ...s,
            capital: isTokenOffer(s.offer) ? s.capital - best.price : nextValue,
            value: nextValue
          });
        } else {
          nextStates.push(s);
        }
      }

      states = nextStates;
      open = open.filter((src) => !used.has(src.boxId));
    }

    return {
      rounds: round,
      taken,
      takenBy,
      searched: {
        offers: allOffers.length,
        offersSearched: searchedOffers.length,
        sources: allSources.length,
        sourcesSearched: searchedSources.length
      }
    };
  }
}
