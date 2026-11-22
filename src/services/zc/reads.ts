import { Network } from "@fleet-sdk/core";
import {
  ChainAsset,
  LONG_MAX,
  LONG_MIN,
  payoutTag,
  readZcBox,
  readZcOracle,
  ZcAsk,
  ZcEntry,
  ZcOffer,
  ZcOrder,
  ZcOrigin,
  ZcRecord,
  ZcShareVault
} from "./boxes";
import {
  getZcScript,
  getZcScriptAddress,
  marketByTokenId,
  marketNamed,
  marketTokenId,
  ZC_EXPRESSIONS,
  ZC_MARKETS,
  ZC_PINNED_COMMIT,
  ZC_SCRIPTS,
  ZC_SIGUSD_TOKEN_ID,
  ZcKind
} from "./contracts";
import { simulateDraft } from "./drafts";
import { ZcApiError } from "./errors";
import {
  ChainTransaction,
  DEFAULT_MAINNET_GRAPHQL_URL,
  ZcGraphqlClient
} from "./graphqlClient";
import { buildAtMeta, toSafeNum, ZcJson, ZcKnown, ZcStanding } from "./json";
import {
  buildMarketBook,
  MAX_OFFERS,
  MAX_SOURCES,
  openOf,
  orderSourceOf,
  ZcBatchRun,
  ZcMarketBook,
  ZcMatch,
  ZcMatcher,
  ZcOpen,
  ZcSearched,
  ZcSource
} from "./matcher";
import {
  bigMax,
  bigMin,
  BLOCKS_PER_YEAR,
  GRID,
  gridBetween,
  MIN_BATCHING_FEE,
  QUOTE_BLOCKS,
  ratioBps,
  RECOLLATERALIZE_WAIT,
  REFRESH_AGE,
  REFRESH_BOUNTY,
  SHARE_COUNT,
  usdPerErg,
  YEAR,
  yieldBps
} from "./pricing";
import { ZcResolver } from "./resolver";
import {
  auctionOpen,
  belowOwnRatio,
  bondTermsOf,
  borrowCurve,
  buysShares,
  claimableFrom,
  coverOfBond,
  currencyHeld,
  excessPrice,
  floorBps,
  freshOracle,
  isWindowOrder,
  lotPrice,
  lotTarget,
  lotValid,
  maxBlocks,
  minBlocks,
  offerCurve,
  offerStateOf,
  orderWindow,
  prospectBondTerms,
  resolvePrincipal,
  vaultCurrency,
  ZcBondTerms
} from "./rules";
import { ZcInfoResponse, ZcMarket, ZcRawCurvesResponse } from "@/types/zc";

export interface ZcFilters {
  coverage: bigint;
  kind: "all" | "new" | "resale" | "shares";
  matchable: boolean;
  grid: boolean;
}

export interface ZcWalletState {
  readonly hashes: ReadonlySet<string>;
  readonly nanoErg: bigint;
  readonly tokens: readonly ChainAsset[];
}

export type ZcWalletProvider = () => ZcWalletState;

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const MAX_PENDING_ROWS = 50;
const MAX_CURVE_OFFERS = 200;
const MAX_DOTS = 500;
const MAX_BOOK_ROWS = 100;
const MAX_MATCH_ROWS = 50;
const MAX_SAMPLES = 400;
const SAMPLE_STEP = 1800n;
const MAX_SEARCH_HITS = 20;
const MAX_ASSETS = 50;
const MAX_LOOKUP_HOPS = 8;
const ATTENTION_BLOCKS = 2160n;
const ATTENTION_COVER_BPS = 12_500n;

export const ZC_DEFAULTS: Record<string, string | number> = {
  minerFeeNanoErg: "1000000",
  gridBlocks: Number(GRID),
  blocksPerYear: Number(BLOCKS_PER_YEAR),
  orderExpiryBlocks: 5040,
  orderExpiryFeeNanoErg: "5000000",
  orderOracleAge: 60,
  offerOracleAge: 30,
  offerMinBlocks: 1,
  offerMaxBlocks: Number(BLOCKS_PER_YEAR),
  offerExpiryBlocks: 5040,
  askExpiryBlocks: 5040,
  batcherFeeNanoErg: "5000000",
  tokenOfferMinFillBps: 100,
  tokenOfferRewardBudgetNanoErg: "200000000",
  reserveNanoErg: "50000000",
  mintFeeNanoErg: "5000000",
  pullFeeNanoErg: "5000000",
  askRefundFeeNanoErg: "2000000",
  tokenOfferErgFundingNanoErg: "500000000",
  askMinFill: "1",
  offerMinPrice: "1",
  fillGuard: "on at the order's own ratio",
  saleGuardOracleAge: 30,
  shareCount: SHARE_COUNT.toString(),
  shareDecimals: 6,
  shareVault: "selective",
  selectiveThreshold: "100",
  auctionLength: 720,
  auctionExpiry: 2160,
  offerMaxAuctionExpiry: 0,
  lotFallBlocks: 720,
  lotHoldBlocks: 2160,
  lotRefundFeeNanoErg: "2000000",
  wrapMintFeeNanoErg: "5000000",
  wrapRefreshReserveNanoErg: "30000000",
  refreshAgeBlocks: Number(REFRESH_AGE),
  refreshBountyNanoErg: REFRESH_BOUNTY.toString(),
  quoteBlocks: Number(QUOTE_BLOCKS),
  minBatchingFeeNanoErg: MIN_BATCHING_FEE.toString()
};

interface AskRow {
  open: ZcOpen<ZcRecord>;
  render: () => Record<string, unknown>;
  yieldBps: bigint | null;
  blocksLeft: bigint | null;
  cost: bigint;
  cover: bigint | null;
  kind: "new" | "resale" | "shares";
  standing: ZcStanding;
  grid: boolean;
  borrowedByMe: boolean;
}

interface RawFill {
  id: string;
  txId: string;
  height: number;
  timestamp: number;
  market: ZcMarket;
  kind: "new" | "resale" | "shares";
  via: "wallet" | "offer";
  offerId: string | null;
  sourceId: string;
  bondId: string;
  blocksLeft: number;
  cost: string;
  face: string;
  yieldBps: number | null;
  maturity: number;
  coverBps: number | null;
}

interface BondFacts {
  market: ZcMarket;
  repayment: bigint;
  maturity: bigint;
}

interface SnapshotState {
  book: ZcMarketBook;
  network: string;
  fingerprint: string;
  batchRuns: Map<ZcMarket, ZcBatchRun>;
}

const EMPTY_WALLET: ZcWalletState = {
  hashes: new Set<string>(),
  nanoErg: 0n,
  tokens: []
};

function requireMarket(name: string): ZcMarket {
  const m = marketNamed(name);
  if (!m) throw new ZcApiError(`unknown market ${name}: ERG or SigUSD`, 400);
  return m;
}

function requireHex64(id: string): string {
  const clean = id.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new ZcApiError(`${id} is not a 64-character hex id`, 400);
  }
  return clean;
}

function parseFilters(params?: {
  coverage?: number;
  kind?: string;
  matchable?: boolean;
  grid?: boolean;
}): ZcFilters {
  const kind = params?.kind ?? "all";
  if (kind !== "all" && kind !== "new" && kind !== "resale" && kind !== "shares") {
    throw new ZcApiError(`kind must be all, new, resale or shares, not ${kind}`, 400);
  }
  const cov = params?.coverage ?? 15000;
  if (!Number.isFinite(cov) || cov < 0) {
    throw new ZcApiError("coverage cannot be negative", 400);
  }
  return {
    coverage: BigInt(Math.round(cov)),
    kind,
    matchable: params?.matchable ?? true,
    grid: params?.grid ?? false
  };
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpBigAsc(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpBigDesc(a: bigint, b: bigint): number {
  return a > b ? -1 : a < b ? 1 : 0;
}

function kindName(k: ZcKind): string {
  if (k === "Order" || k === "PricedOrder") return "bondUnit";
  if (k === "WrapMint") return "wrapReceipt";
  return "shares";
}

function weightedYield(ms: readonly ZcMatch[]): number | null {
  const total = ms.reduce((acc, m) => acc + m.cost, 0n);
  if (total <= 0n) return null;
  const sum = ms.reduce((acc, m) => acc + m.cost * m.yieldBps, 0n);
  return toSafeNum(sum / total);
}

function searchedJson(sr: ZcSearched, here: number): Record<string, number> {
  return {
    offers: sr.offers,
    offersSearched: sr.offersSearched,
    sources: sr.sources,
    sourcesSearched: sr.sourcesSearched,
    candidates: here
  };
}

export class ZcGraphqlEngine {
  readonly gql: ZcGraphqlClient;
  readonly resolver: ZcResolver;
  private walletProvider: ZcWalletProvider = () => EMPTY_WALLET;
  private snapshot: SnapshotState | null = null;
  private revision = 0;
  private inFlightRefresh: Promise<SnapshotState> | null = null;
  private fillsCache = new Map<string, RawFill[]>();

  constructor(endpoint = DEFAULT_MAINNET_GRAPHQL_URL) {
    this.gql = new ZcGraphqlClient(endpoint);
    this.resolver = new ZcResolver(this.gql);
  }

  getEndpoint(): string {
    return this.gql.getEndpoint();
  }

  setEndpoint(url: string): void {
    const clean = url.trim() || DEFAULT_MAINNET_GRAPHQL_URL;
    if (clean === this.gql.getEndpoint()) return;
    this.gql.setEndpoint(clean);
    this.reset();
  }

  reset(): void {
    this.snapshot = null;
    this.revision = 0;
    this.inFlightRefresh = null;
    this.fillsCache.clear();
    this.resolver.clear();
  }

  setWalletProvider(provider: ZcWalletProvider): void {
    this.walletProvider = provider;
  }

  private walletState(): ZcWalletState {
    try {
      return this.walletProvider();
    } catch {
      return EMPTY_WALLET;
    }
  }

  private buildKnown(book: ZcMarketBook): ZcKnown {
    const mineHashes = this.walletState().hashes;
    return {
      origin: (token) => this.resolver.knownOrigin(token),
      disclosed: (record) => this.resolver.knownDisclosed(record, book.height),
      mine: (partyHash) => mineHashes.has(partyHash.toLowerCase()),
      chain: (record) => this.resolver.knownChainRoot(record)
    };
  }

  private buildMatcher(book: ZcMarketBook): ZcMatcher {
    return new ZcMatcher(
      book,
      (token) => this.resolver.knownOrigin(token),
      MAX_OFFERS,
      MAX_SOURCES,
      (r) => this.resolver.knownDisclosed(r, book.height) === false
    );
  }

  private getBatchRun(snap: SnapshotState, market: ZcMarket): ZcBatchRun {
    const cached = snap.batchRuns.get(market);
    if (cached) return cached;
    const run = this.buildMatcher(snap.book).batch(market);
    snap.batchRuns.set(market, run);
    return run;
  }

  /**
   * Refreshes chain state from Ergo GraphQL.
   * Fast path: if `force` is false and tip `blockId` + oracle box have not moved since
   * the current snapshot, skips the 22-tree UTXO scan completely.
   */
  async refresh(force = false, signal?: AbortSignal): Promise<SnapshotState> {
    if (this.inFlightRefresh && !force) return this.inFlightRefresh;

    const run = (async (): Promise<SnapshotState> => {
      const { state, oracle } = await this.gql.fetchStateAndOracle(signal);
      const prev = this.snapshot;

      if (
        !force &&
        prev &&
        prev.book.blockId === state.blockId &&
        (prev.book.confirmedOracle?.box.boxId ?? null) === (oracle?.box.boxId ?? null)
      ) {
        return prev;
      }

      const { boxes, cut } = await this.gql.fetchAllUnspentZcBoxes(signal);
      const entries = new Map<string, ZcEntry>();
      for (const box of boxes) {
        const record = readZcBox(box);
        if (record) {
          entries.set(record.boxId, {
            record,
            height: box.settlementHeight || box.creationHeight
          });
        }
      }

      const sortedIds = Array.from(entries.keys()).sort();
      const provisionalBook = buildMarketBook({
        height: state.height,
        blockId: state.blockId,
        revision: this.revision,
        cut,
        entries,
        confirmedOracle: oracle
      });

      // Resolve origins, script disclosures, and offer/ask chain roots for the scanned book.
      await this.resolver.warmForBook(provisionalBook, signal);

      const fp = `${state.blockId}|${oracle?.box.boxId ?? ""}|${this.resolver.generation}|${sortedIds.join(",")}`;
      if (!prev || prev.fingerprint !== fp) {
        this.revision++;
      }

      const book = buildMarketBook({
        height: state.height,
        blockId: state.blockId,
        revision: this.revision,
        cut,
        entries,
        confirmedOracle: oracle
      });

      if (prev && prev.book.blockId !== state.blockId) {
        this.fillsCache.clear();
      }

      const next: SnapshotState = {
        book,
        network: state.network || "mainnet",
        fingerprint: fp,
        batchRuns: new Map()
      };
      this.snapshot = next;
      return next;
    })();

    this.inFlightRefresh = run;
    try {
      return await run;
    } finally {
      if (this.inFlightRefresh === run) this.inFlightRefresh = null;
    }
  }

  private async ensureSnapshot(signal?: AbortSignal): Promise<SnapshotState> {
    if (this.snapshot) return this.snapshot;
    return this.refresh(false, signal);
  }

  // ─── 1. info ────────────────────────────────────────────────────────────────

  async getInfo(
    ifRevision?: number,
    signal?: AbortSignal
  ): Promise<ZcInfoResponse | { notModified: true }> {
    const force = ifRevision === undefined;
    const snap = await this.refresh(force, signal);
    if (ifRevision !== undefined && snap.book.revision === ifRevision) {
      return { notModified: true };
    }

    const netType = snap.network === "testnet" ? Network.Testnet : Network.Mainnet;
    const or = snap.book.confirmedOracle;
    const markets = ZC_MARKETS.map((m) => {
      const contracts: Record<
        string,
        { treeHash: string; templateHash: string; address: string | null }
      > = {};
      for (const c of ZC_SCRIPTS) {
        if (c.market !== null && c.market !== m) continue;
        let address: string | null = null;
        try {
          address = getZcScriptAddress(c, netType);
        } catch {
          address = null;
        }
        contracts[c.kind] = {
          treeHash: c.treeHash,
          templateHash: c.templateHash,
          address
        };
      }
      const expressions: Record<string, string> = {};
      for (const e of ZC_EXPRESSIONS) {
        if (e.market !== null && e.market !== m) continue;
        expressions[e.expression] = e.hash;
      }
      return {
        market: m,
        tokenId: marketTokenId(m),
        decimals: m === "ERG" ? 9 : 2,
        contracts,
        expressions
      };
    });

    return {
      at: buildAtMeta(snap.book),
      network: snap.network,
      profile: "zcs1",
      pinnedCommit: ZC_PINNED_COMMIT,
      deployed: snap.book.allOpen.length > 0,
      oracle: or
        ? {
            feed: "erg-usd",
            boxId: or.box.boxId,
            nanoErgPerUsd: or.price.toString(),
            usdPerErg: usdPerErg(or.price),
            updatedHeight: or.box.creationHeight,
            age: snap.book.height - or.box.creationHeight,
            refreshPending: snap.book.refreshPending
          }
        : null,
      markets,
      defaults: ZC_DEFAULTS
    } as ZcInfoResponse;
  }

  // ─── 2 & 3. asks & offers ───────────────────────────────────────────────────

  private buildAskRows(
    snap: SnapshotState,
    matcher: ZcMatcher,
    json: ZcJson,
    known: ZcKnown,
    market: ZcMarket
  ): AskRow[] {
    const h = BigInt(snap.book.height);
    const out: AskRow[] = [];

    for (const o of snap.book.orders) {
      if (o.record.market !== market) continue;
      const q = json.orderQuote(o.record);
      const win = orderWindow(o.record);
      const winGrid = win !== null && gridBetween(h + win[0], h + win[1]).length > 0;
      const prospect = json.defaultProspect(o.record);
      out.push({
        open: o,
        render: () => json.orderJson(o),
        yieldBps: q ? q.yieldBps : null,
        blocksLeft: q ? q.blocksLeft : null,
        cost: q ? q.cost : 0n,
        cover: prospect ? json.coverBps(prospect) : null,
        kind: "new",
        standing: json.orderStanding(o.record),
        grid: (o.record.mode === 0n && o.record.terms[3] % GRID === 0n) || winGrid,
        borrowedByMe: known.mine(o.record.borrowerHash)
      });
    }

    for (const a of snap.book.asks) {
      if (a.record.market !== market) continue;
      const claimRes = matcher.claimOf(a.record.token.tokenId);
      const claim = claimRes.ok ? claimRes.value : null;
      const bond = claim ? snap.book.bonds.get(claim.asset)?.record ?? null : null;
      const q = json.askQuote(a.record, bond, claim ? claim.whole : 1n);
      out.push({
        open: a,
        render: () => json.askJson(a),
        yieldBps: q ? q.yieldBps : null,
        blocksLeft: q ? q.blocksLeft : null,
        cost: q ? q.cost : 0n,
        cover: bond ? json.coverBps(bondTermsOf(bond)) : null,
        kind: claim && claim.whole > 1n ? "shares" : "resale",
        standing: json.askStanding(a.record),
        grid: bond !== null && bond.maturity % GRID === 0n,
        borrowedByMe: bond !== null && known.mine(bond.borrowerHash)
      });
    }

    return out;
  }

  private keepAskRow(
    r: AskRow,
    f: ZcFilters,
    from: bigint | null,
    to: bigint | null
  ): boolean {
    if (f.matchable && !r.standing.ok) return false;
    if (r.cover !== null && r.cover < f.coverage) return false;
    if (f.grid && !r.grid) return false;
    if (f.kind === "new" && r.kind !== "new") return false;
    if (f.kind === "resale" && r.kind !== "resale" && r.kind !== "shares") return false;
    if (f.kind === "shares" && r.kind !== "shares") return false;
    if (from !== null && (r.blocksLeft === null || r.blocksLeft < from)) return false;
    if (to !== null && (r.blocksLeft === null || r.blocksLeft > to)) return false;
    return true;
  }

  private paged<T>(
    rows: readonly T[],
    cursor: string | undefined,
    limit: number | undefined,
    isPending: (row: T) => boolean,
    render: (row: T) => Record<string, unknown>
  ): Record<string, unknown> {
    let from = 0;
    if (cursor !== undefined && cursor !== "") {
      const parsed = Number(cursor);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new ZcApiError("cursor must be a number", 400);
      }
      from = parsed;
    }
    const size = limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) {
      throw new ZcApiError(`limit must be 1 to ${MAX_PAGE}`, 400);
    }

    let pendingSeen = 0;
    const kept: T[] = [];
    let leftOut = 0;
    for (const r of rows) {
      if (!isPending(r)) {
        kept.push(r);
      } else {
        pendingSeen++;
        if (pendingSeen <= MAX_PENDING_ROWS) kept.push(r);
        else leftOut++;
      }
    }
    const page = kept.slice(from, from + size);
    return {
      items: page.map(render),
      total: kept.length,
      next: from + size < kept.length ? String(from + size) : null,
      pendingLeftOut: leftOut
    };
  }

  async listAsksRaw(
    marketName: string,
    params?: {
      coverage?: number;
      kind?: string;
      matchable?: boolean;
      grid?: boolean;
      from?: number;
      to?: number;
      sort?: string;
      cursor?: string;
      limit?: number;
    },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(signal);
    const m = requireMarket(marketName);
    const f = parseFilters(params);
    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);

    const from = params?.from != null ? BigInt(Math.round(params.from)) : null;
    const to = params?.to != null ? BigInt(Math.round(params.to)) : null;

    const rows = this.buildAskRows(snap, matcher, json, known, m).filter((r) =>
      this.keepAskRow(r, f, from, to)
    );

    const sortKey = params?.sort ?? "apr";
    if (sortKey === "apr") {
      rows.sort((a, b) => {
        const ya = a.yieldBps ?? LONG_MIN + 1n;
        const yb = b.yieldBps ?? LONG_MIN + 1n;
        return cmpBigDesc(ya, yb) || cmpStr(a.open.boxId, b.open.boxId);
      });
    } else if (sortKey === "maturity") {
      rows.sort((a, b) => {
        const da = a.blocksLeft ?? LONG_MAX;
        const db = b.blocksLeft ?? LONG_MAX;
        return cmpBigAsc(da, db) || cmpStr(a.open.boxId, b.open.boxId);
      });
    } else if (sortKey === "size") {
      rows.sort((a, b) => cmpBigDesc(a.cost, b.cost) || cmpStr(a.open.boxId, b.open.boxId));
    } else {
      throw new ZcApiError(`sort must be apr, maturity or size, not ${sortKey}`, 400);
    }

    return {
      at: buildAtMeta(snap.book),
      ...this.paged(
        rows,
        params?.cursor,
        params?.limit,
        (r) => r.open.pending,
        (r) => r.render()
      )
    };
  }

  async listOffersRaw(
    marketName: string,
    params?: {
      coverage?: number;
      kind?: string;
      matchable?: boolean;
      grid?: boolean;
      from?: number;
      to?: number;
      sort?: string;
      cursor?: string;
      limit?: number;
    },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(signal);
    const m = requireMarket(marketName);
    const f = parseFilters(params);
    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);

    const from = params?.from != null ? BigInt(Math.round(params.from)) : null;
    const to = params?.to != null ? BigInt(Math.round(params.to)) : null;

    const rows: ZcOpen<ZcOffer>[] = [];
    for (const o of snap.book.offers) {
      if (o.record.market !== m) continue;
      const st = json.offerStanding(o.record);
      if (f.matchable && !st.ok) continue;
      if (floorBps(o.record) > f.coverage) continue;
      if (f.kind === "shares" && !buysShares(o.record)) continue;
      if (from !== null && maxBlocks(o.record) < from) continue;
      if (to !== null && minBlocks(o.record) > to) continue;
      rows.push(o);
    }

    const sortKey = params?.sort ?? "apr";
    if (sortKey === "apr") {
      rows.sort(
        (a, b) => cmpBigAsc(a.record.terms[0], b.record.terms[0]) || cmpStr(a.boxId, b.boxId)
      );
    } else if (sortKey === "maturity") {
      rows.sort(
        (a, b) => cmpBigAsc(minBlocks(a.record), minBlocks(b.record)) || cmpStr(a.boxId, b.boxId)
      );
    } else if (sortKey === "size") {
      rows.sort(
        (a, b) => cmpBigDesc(a.record.capital, b.record.capital) || cmpStr(a.boxId, b.boxId)
      );
    } else {
      throw new ZcApiError(`sort must be apr, maturity or size, not ${sortKey}`, 400);
    }

    return {
      at: buildAtMeta(snap.book),
      ...this.paged(
        rows,
        params?.cursor,
        params?.limit,
        (o) => o.pending,
        (o) => json.offerJson(o)
      )
    };
  }

  // ─── 4. curves ──────────────────────────────────────────────────────────────

  async getCurvesRaw(
    marketName: string,
    params?: { coverage?: number; kind?: string; matchable?: boolean; grid?: boolean },
    signal?: AbortSignal
  ): Promise<ZcRawCurvesResponse> {
    const snap = await this.ensureSnapshot(signal);
    const m = requireMarket(marketName);
    const f = parseFilters(params);
    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);

    const offers = snap.book.offers
      .filter((o) => o.record.market === m)
      .map((o) => ({ o, st: json.offerStanding(o.record) }));
    const matchableOffers = offers.filter(
      ({ o, st }) => st.ok && floorBps(o.record) <= f.coverage
    );
    const bidders = (
      f.matchable
        ? matchableOffers
        : offers.filter(({ o }) => floorBps(o.record) <= f.coverage)
    )
      .map((x) => x.o.record)
      .sort((a, b) => cmpBigAsc(a.terms[0], b.terms[0]) || cmpStr(a.boxId, b.boxId))
      .slice(0, MAX_CURVE_OFFERS);

    const sampleSet = new Set<bigint>();
    for (let d = 0n; d <= BLOCKS_PER_YEAR; d += SAMPLE_STEP) sampleSet.add(d);
    for (const o of bidders) {
      const lo = minBlocks(o);
      const hi = maxBlocks(o);
      if (lo >= 0n && lo <= BLOCKS_PER_YEAR) sampleSet.add(lo);
      if (hi >= 0n && hi <= BLOCKS_PER_YEAR) sampleSet.add(hi);
      for (const [, d] of o.curve) {
        if (d >= 0n && d <= BLOCKS_PER_YEAR) sampleSet.add(d);
      }
    }
    const samples = Array.from(sampleSet).sort(cmpBigAsc).slice(0, MAX_SAMPLES);

    const bidLine = samples.map((d) => {
      let best: { offer: ZcOffer; bps: bigint } | null = null;
      for (const o of bidders) {
        if (d < minBlocks(o) || d > maxBlocks(o)) continue;
        const bps = offerCurve(o).bpsAt(d);
        if (!best || bps < best.bps) best = { offer: o, bps };
      }
      return {
        blocks: toSafeNum(d),
        bps: best ? toSafeNum(best.bps) : null,
        offerId: best ? best.offer.boxId : null
      };
    });

    const rows = this.buildAskRows(snap, matcher, json, known, m);
    const shown = rows
      .filter((r) => this.keepAskRow(r, f, null, null) && r.yieldBps !== null)
      .sort((a, b) => cmpBigDesc(a.yieldBps!, b.yieldBps!) || cmpStr(a.open.boxId, b.open.boxId));
    const dots = shown.slice(0, MAX_DOTS);

    const buckets = new Map<bigint, AskRow[]>();
    for (const r of dots) {
      const k = (r.blocksLeft ?? 0n) / GRID;
      const list = buckets.get(k) ?? [];
      list.push(r);
      buckets.set(k, list);
    }
    const askLine = Array.from(buckets.values())
      .map((rs) => {
        let best = rs[0];
        for (const r of rs.slice(1)) {
          if (
            r.yieldBps! > best.yieldBps! ||
            (r.yieldBps! === best.yieldBps! && r.open.boxId > best.open.boxId)
          ) {
            best = r;
          }
        }
        return {
          blocks: toSafeNum(best.blocksLeft ?? 0n),
          bps: toSafeNum(best.yieldBps!),
          askId: best.open.boxId
        };
      })
      .sort((a, b) => a.blocks - b.blocks);

    const windows: {
      askId: string;
      minBlocks: number;
      maxBlocks: number;
      capBps: number;
      points: { blocks: number; bps: number }[];
    }[] = [];
    for (const o of snap.book.orders) {
      if (windows.length >= MAX_DOTS) break;
      if (o.record.market !== m || !isWindowOrder(o.record)) continue;
      const c = borrowCurve(o.record);
      const win = orderWindow(o.record);
      if (!c || !win) continue;
      windows.push({
        askId: o.boxId,
        minBlocks: toSafeNum(win[0]),
        maxBlocks: toSafeNum(win[1]),
        capBps: toSafeNum(c.maxBps),
        points: c.points.map(([y, d]) => ({ blocks: toSafeNum(d), bps: toSafeNum(y) }))
      });
    }

    const matchableAsks = rows.filter(
      (r) => r.standing.ok && (r.cover === null || r.cover >= f.coverage)
    );
    const totalAskCost = matchableAsks.reduce((acc, r) => acc + r.cost, 0n);
    const totalOfferCap = matchableOffers.reduce((acc, x) => acc + x.o.record.capital, 0n);

    return {
      at: buildAtMeta(snap.book),
      domain: [0, Number(BLOCKS_PER_YEAR)],
      bidLine,
      askLine,
      askDots: dots.map((r) => ({
        askId: r.open.boxId,
        kind: r.kind,
        blocks: toSafeNum(r.blocksLeft ?? 0n),
        bps: toSafeNum(r.yieldBps!),
        ok: r.standing.ok,
        pending: r.open.pending,
        borrowedByMe: r.borrowedByMe
      })),
      windows,
      totals: {
        asks: {
          matchable: matchableAsks.length,
          count: rows.length,
          cost: totalAskCost.toString()
        },
        offers: {
          matchable: matchableOffers.length,
          count: offers.length,
          capital: totalOfferCap.toString()
        },
        searched: {
          asks: dots.length,
          offers: bidders.length
        }
      }
    } as ZcRawCurvesResponse;
  }

  // ─── 5. orderbook ───────────────────────────────────────────────────────────

  private bestWindowQuote(
    o: ZcOrder,
    h: bigint,
    lo: bigint,
    hi: bigint
  ): { blocks: bigint; bps: bigint; cost: bigint } | null {
    const win = orderWindow(o);
    const c = borrowCurve(o);
    if (!win || !c) return null;
    const at = h + 1n;
    const from = bigMax(h + win[0], at + lo);
    const until = bigMin(h + win[1], at + hi);
    if (from > until) return null;

    const cands = new Set<bigint>([from, until]);
    for (const d of c.breakpoints) {
      const x = h + d;
      if (x >= from && x <= until) cands.add(x);
    }
    for (const g of gridBetween(from, until)) cands.add(g);

    let best: { blocks: bigint; bps: bigint; cost: bigint } | null = null;
    for (const mat of cands) {
      const pRes = resolvePrincipal(o, h, mat);
      if (!pRes.ok) continue;
      const blocks = mat - at;
      const bps = yieldBps(o.repayment, pRes.value, blocks) ?? 0n;
      if (!best || bps > best.bps || (bps === best.bps && blocks < best.blocks)) {
        best = { blocks, bps, cost: pRes.value };
      }
    }
    return best;
  }

  async getOrderbookRaw(
    marketName: string,
    params?: {
      coverage?: number;
      kind?: string;
      matchable?: boolean;
      grid?: boolean;
      to?: number;
      around?: number;
      band?: number;
    },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(signal);
    const m = requireMarket(marketName);
    const f = parseFilters(params);

    let lo: bigint;
    let hi: bigint;
    if (params?.to != null && params?.around == null && params.to >= 720) {
      lo = 720n;
      hi = BigInt(Math.round(params.to));
    } else if (params?.to == null && params?.around != null && params.around > 0) {
      const a = BigInt(Math.round(params.around));
      const b =
        params.band != null ? BigInt(Math.round(params.band)) : bigMax(720n, a / 10n);
      lo = bigMax(1n, a - b);
      hi = a + b;
    } else if (params?.to == null && params?.around == null) {
      lo = 720n;
      hi = BLOCKS_PER_YEAR;
    } else {
      throw new ZcApiError("give either to (at least 720) or around, not both", 400);
    }

    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);
    const h = BigInt(snap.book.height);

    const rows = this.buildAskRows(snap, matcher, json, known, m).filter((r) =>
      this.keepAskRow(r, f, null, null)
    );

    const asks: {
      boxId: string;
      kind: string;
      bps: number | null;
      bpsBig: bigint;
      size: string;
      blocks: number;
      window: boolean;
      ok: boolean;
      reason: string | null;
      borrowedByMe: boolean;
    }[] = [];

    for (const r of rows) {
      if (r.open.record.recordType === "order" && isWindowOrder(r.open.record)) {
        const wq = this.bestWindowQuote(r.open.record, h, lo, hi);
        if (wq) {
          asks.push({
            boxId: r.open.boxId,
            kind: r.kind,
            bps: toSafeNum(wq.bps),
            bpsBig: wq.bps,
            size: wq.cost.toString(),
            blocks: toSafeNum(wq.blocks),
            window: true,
            ok: r.standing.ok,
            reason: r.standing.reasons[0] ?? null,
            borrowedByMe: r.borrowedByMe
          });
        }
      } else if (r.blocksLeft !== null && r.blocksLeft >= lo && r.blocksLeft <= hi) {
        asks.push({
          boxId: r.open.boxId,
          kind: r.kind,
          bps: r.yieldBps !== null ? toSafeNum(r.yieldBps) : null,
          bpsBig: r.yieldBps ?? LONG_MIN + 1n,
          size: r.cost.toString(),
          blocks: toSafeNum(r.blocksLeft),
          window: false,
          ok: r.standing.ok,
          reason: r.standing.reasons[0] ?? null,
          borrowedByMe: r.borrowedByMe
        });
      }
    }

    asks.sort((a, b) => cmpBigDesc(a.bpsBig, b.bpsBig) || cmpStr(a.boxId, b.boxId));
    const trimmedAsks = asks.slice(0, MAX_BOOK_ROWS).map(({ bpsBig: _ignored, ...rest }) => rest);

    const bids: {
      boxId: string;
      bps: number;
      bpsBig: bigint;
      size: string;
      range: [number, number];
      ok: boolean;
      reason: string | null;
    }[] = [];

    for (const o of snap.book.offers) {
      if (o.record.market !== m) continue;
      const st = json.offerStanding(o.record);
      if (f.matchable && !st.ok) continue;
      if (floorBps(o.record) > f.coverage) continue;
      if (maxBlocks(o.record) < lo || minBlocks(o.record) > hi) continue;

      const a = bigMax(lo, minBlocks(o.record));
      const b = bigMin(hi, maxBlocks(o.record));
      const curve = offerCurve(o.record);
      const pts: bigint[] = [a, b];
      for (const [, d] of o.record.curve) {
        if (d >= a && d <= b) pts.push(d);
      }
      let minY = curve.bpsAt(pts[0]);
      for (const d of pts.slice(1)) {
        const y = curve.bpsAt(d);
        if (y < minY) minY = y;
      }
      bids.push({
        boxId: o.boxId,
        bps: toSafeNum(minY),
        bpsBig: minY,
        size: o.record.capital.toString(),
        range: [toSafeNum(a), toSafeNum(b)],
        ok: st.ok,
        reason: st.reasons[0] ?? null
      });
    }

    bids.sort((a, b) => cmpBigAsc(a.bpsBig, b.bpsBig) || cmpStr(a.boxId, b.boxId));
    const trimmedBids = bids.slice(0, MAX_BOOK_ROWS).map(({ bpsBig: _ignored, ...rest }) => rest);

    let bestAsk: number | null = null;
    for (const a of trimmedAsks) {
      if (a.bps !== null && (bestAsk === null || a.bps > bestAsk)) bestAsk = a.bps;
    }
    let bestBid: number | null = null;
    for (const b of trimmedBids) {
      if (bestBid === null || b.bps < bestBid) bestBid = b.bps;
    }

    return {
      at: buildAtMeta(snap.book),
      filters: {
        coverage: Number(f.coverage),
        kind: f.kind,
        matchable: f.matchable,
        grid: f.grid
      },
      range: { from: toSafeNum(lo), to: toSafeNum(hi) },
      asks: trimmedAsks,
      bids: trimmedBids,
      bestAskBps: bestAsk,
      bestBidBps: bestBid,
      spreadBps: bestAsk !== null && bestBid !== null ? bestBid - bestAsk : null
    };
  }

  // ─── 6. matches ─────────────────────────────────────────────────────────────

  private borrowedAsset(snap: SnapshotState, known: ZcKnown, tokenId: string): string | null {
    const direct = snap.book.bonds.get(tokenId);
    if (direct) return known.mine(direct.record.borrowerHash) ? direct.record.asset : null;
    const sv = snap.book.shareVaults.get(tokenId);
    if (sv) {
      const b = snap.book.bonds.get(sv.record.bondAsset);
      if (b && known.mine(b.record.borrowerHash)) return b.record.asset;
    }
    return null;
  }

  private matchJson(
    snap: SnapshotState,
    known: ZcKnown,
    mt: ZcMatch,
    sourceKey: string
  ): Record<string, unknown> {
    const rec = snap.book.byBoxId.get(mt.sourceId)?.record ?? null;
    const h = BigInt(snap.book.height);
    let coverNow: number | null = null;
    const or = snap.book.confirmedOracle;
    if (or && rec) {
      if (rec.recordType === "order") {
        const p = resolvePrincipal(rec, h, mt.maturity);
        if (p.ok) {
          const c = coverOfBond(prospectBondTerms(rec, h, mt.maturity, p.value), or.price);
          if (c) coverNow = toSafeNum(ratioBps(c));
        }
      } else if (rec.recordType === "ask") {
        for (const b of snap.book.bonds.values()) {
          if (b.record.asset === rec.token.tokenId || rec.pricedAsset === b.record.asset) {
            const c = coverOfBond(bondTermsOf(b.record), or.price);
            if (c) coverNow = toSafeNum(ratioBps(c));
            break;
          }
        }
      }
    }

    const borrowed =
      rec !== null &&
      (rec.recordType === "order"
        ? known.mine(rec.borrowerHash)
        : rec.recordType === "ask"
          ? this.borrowedAsset(snap, known, rec.token.tokenId) !== null
          : false);

    return {
      [sourceKey]: mt.sourceId,
      units: mt.units.toString(),
      cost: mt.cost.toString(),
      face: mt.face.toString(),
      yieldBps: toSafeNum(mt.yieldBps),
      requiredBps: toSafeNum(mt.requiredBps),
      maturity: toSafeNum(mt.maturity),
      coverBps: coverNow,
      borrowedByMe: borrowed
    };
  }

  async getMatchesRaw(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(signal);
    const cleanId = id.trim().toLowerCase();
    const open = snap.book.byBoxId.get(cleanId);
    if (!open) throw new ZcApiError(`${id} is not an open ZC box`, 404);

    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);

    if (open.record.recordType === "offer") {
      const o = open.record;
      const state = offerStateOf(o);
      const srcs = matcher.sources(o.market).slice(0, MAX_SOURCES);
      const buys = matcher.candidates(state, srcs);
      const run = this.getBatchRun(snap, o.market);
      const taken = run.taken.get(o.boxId) ?? [];
      const spent = taken.reduce((acc, t) => acc + t.price, 0n);

      return {
        at: buildAtMeta(snap.book),
        type: "offer",
        offerId: o.boxId,
        buys: buys.slice(0, MAX_MATCH_ROWS).map((mt) => this.matchJson(snap, known, mt, "askId")),
        next: {
          taken: taken.map((t) => t.sourceId),
          spent: spent.toString(),
          avgYieldBps: weightedYield(taken),
          rounds: run.rounds
        },
        searched: searchedJson(run.searched, srcs.length)
      };
    }

    if (open.record.recordType === "order" || open.record.recordType === "ask") {
      const market = open.record.market;
      const srcRes =
        open.record.recordType === "order"
          ? { ok: true as const, value: orderSourceOf(open as ZcOpen<ZcOrder>) as ZcSource }
          : matcher.askSource(open as ZcOpen<ZcAsk>);
      const offers = matcher.offerStates(market).slice(0, MAX_OFFERS);
      const takers: ZcMatch[] = [];
      if (srcRes.ok) {
        for (const st of offers) {
          const ev = matcher.evaluate(st, srcRes.value);
          if (ev.ok) takers.push(ev.value);
        }
      }
      const run = this.getBatchRun(snap, market);
      return {
        at: buildAtMeta(snap.book),
        type: "ask",
        askId: cleanId,
        notMatchable: srcRes.ok ? null : srcRes.error,
        offers: takers.slice(0, MAX_MATCH_ROWS).map((mt) => ({
          offerId: mt.offerId,
          units: mt.units.toString(),
          cost: mt.cost.toString(),
          yieldBps: toSafeNum(mt.yieldBps),
          requiredBps: toSafeNum(mt.requiredBps)
        })),
        first: run.takenBy.get(cleanId)?.offerId ?? null,
        searched: searchedJson(run.searched, offers.length)
      };
    }

    throw new ZcApiError(`${id} is not an open offer, order or ask`, 404);
  }

  // ─── 7. simulate ────────────────────────────────────────────────────────────

  async simulateRaw(
    draft: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(signal);
    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);
    return {
      at: buildAtMeta(snap.book),
      ...simulateDraft(draft, matcher, json)
    };
  }

  // ─── 8. fills (reconstructed via GraphQL transactions) ──────────────────────

  private viaOfferInTx(tx: ChainTransaction): string | null {
    const inputIds = new Set(tx.inputs.map((i) => i.boxId));
    for (const out of tx.outputs) {
      const rec = readZcBox(out);
      if (rec?.recordType === "offer" && rec.predecessor && inputIds.has(rec.predecessor)) {
        return rec.predecessor;
      }
    }
    return null;
  }

  private async fetchAndExtractFills(
    snap: SnapshotState,
    market: ZcMarket,
    fromHeight: number,
    signal?: AbortSignal
  ): Promise<RawFill[]> {
    const cacheKey = `${snap.book.blockId}:${market}:${fromHeight}`;
    const hit = this.fillsCache.get(cacheKey);
    if (hit) return hit;

    const netType = snap.network === "testnet" ? Network.Testnet : Network.Mainnet;
    const addresses = [
      getZcScriptAddress(getZcScript("Bond", market), netType),
      getZcScriptAddress(getZcScript("SaleOrder", market), netType),
      getZcScriptAddress(getZcScript("PricedAsk", market), netType)
    ];

    const txs = await this.gql.fetchTransactionsByAddresses(addresses, fromHeight, 8, signal);

    const bondFacts = new Map<string, BondFacts>();
    const shareFacts = new Map<string, { asset: string; shares: bigint }>();

    // Seed facts from live book first
    for (const [asset, b] of snap.book.bonds) {
      bondFacts.set(asset, {
        market: b.record.market,
        repayment: b.record.repayment,
        maturity: b.record.maturity
      });
    }
    for (const [shareId, sv] of snap.book.shareVaults) {
      shareFacts.set(shareId, { asset: sv.record.bondAsset, shares: sv.record.shares });
    }

    // Pass 1: discover new bonds & share mints in fetched txs
    for (const tx of txs) {
      const firstId = tx.inputs[0]?.boxId ?? null;
      const out1 = tx.outputs[1];
      if (out1 && firstId) {
        const b = readZcBox(out1);
        if (b?.recordType === "bond" && b.asset === firstId) {
          const inp0 = tx.inputs[0]?.box ? readZcBox(tx.inputs[0].box) : null;
          if (inp0?.recordType === "order") {
            bondFacts.set(b.asset, {
              market: b.market,
              repayment: b.repayment,
              maturity: b.maturity
            });
          }
        }
      }
      for (const out of tx.outputs) {
        const v = readZcBox(out);
        if (v?.recordType === "shareVault" && v.shareId === firstId) {
          const inp0 = tx.inputs[0]?.box ? readZcBox(tx.inputs[0].box) : null;
          if (inp0?.recordType === "shareRequest") {
            shareFacts.set(v.shareId, { asset: v.bondAsset, shares: v.shares });
          }
        }
      }
    }

    // Pass 2: if any ask purchase references a token missing from bondFacts/shareFacts, resolve via origin
    const missingTokens = new Set<string>();
    for (const tx of txs) {
      const byInputId = new Map(tx.inputs.map((i) => [i.boxId, i]));
      for (const out of tx.outputs) {
        const tag = payoutTag(out);
        if (!tag) continue;
        const inp = byInputId.get(tag.askId);
        const askRec = inp?.box ? readZcBox(inp.box) : null;
        if (askRec?.recordType === "ask") {
          const tid = askRec.token.tokenId;
          if (!bondFacts.has(tid) && !shareFacts.has(tid)) missingTokens.add(tid);
        }
      }
    }

    if (missingTokens.size > 0) {
      await this.resolver.resolveOrigins(Array.from(missingTokens), snap.book.height, signal);
      const bondFillTxIds = new Set<string>();
      for (const tid of missingTokens) {
        const orig = this.resolver.knownOrigin(tid);
        if (!orig) continue;
        if (orig.kind === "Order" || orig.kind === "PricedOrder") {
          bondFillTxIds.add(orig.txId);
        } else if (
          (orig.kind === "FractionalMint" || orig.kind === "DutchAuctionMint") &&
          orig.held &&
          orig.terms.length > 0
        ) {
          shareFacts.set(tid, { asset: orig.held.tokenId, shares: orig.terms[0] });
          if (!bondFacts.has(orig.held.tokenId)) {
            await this.resolver.resolveOrigins([orig.held.tokenId], snap.book.height, signal);
            const bOrig = this.resolver.knownOrigin(orig.held.tokenId);
            if (bOrig && (bOrig.kind === "Order" || bOrig.kind === "PricedOrder")) {
              bondFillTxIds.add(bOrig.txId);
            }
          }
        }
      }
      if (bondFillTxIds.size > 0) {
        const fillTxs = await this.gql.fetchTransactionsByIds(
          Array.from(bondFillTxIds),
          signal
        );
        for (const ftx of fillTxs.values()) {
          const out1 = ftx.outputs[1];
          const b = out1 ? readZcBox(out1) : null;
          if (b?.recordType === "bond") {
            bondFacts.set(b.asset, {
              market: b.market,
              repayment: b.repayment,
              maturity: b.maturity
            });
          }
        }
      }
    }

    // Pass 3: extract fills matching ZcFills.read
    const fills: RawFill[] = [];
    for (const tx of txs) {
      if (tx.inclusionHeight < fromHeight) continue;
      const firstId = tx.inputs[0]?.boxId ?? null;
      const viaOfferId = this.viaOfferInTx(tx);
      const via: "wallet" | "offer" = viaOfferId ? "offer" : "wallet";

      // New bond fill
      const out1 = tx.outputs[1];
      if (out1 && firstId) {
        const b = readZcBox(out1);
        if (b?.recordType === "bond" && b.asset === firstId && b.market === market) {
          const inp0 = tx.inputs[0]?.box ? readZcBox(tx.inputs[0].box) : null;
          if (inp0?.recordType === "order") {
            const principal =
              marketTokenId(b.market) === null
                ? b.terms[1]
                : b.principalTokens[0]?.amount ?? 0n;
            const left = b.maturity - BigInt(tx.inclusionHeight);
            const data0 = tx.dataInputs[0]?.box ?? null;
            const oracleBox = data0 ? readZcOracle(data0) : null;
            const cov = oracleBox ? coverOfBond(bondTermsOf(b), oracleBox.price) : null;
            const yb = yieldBps(b.repayment, principal, left);
            fills.push({
              id: `${tx.transactionId}:0`,
              txId: tx.transactionId,
              height: tx.inclusionHeight,
              timestamp: tx.timestamp,
              market: b.market,
              kind: "new",
              via,
              offerId: viaOfferId,
              sourceId: b.asset,
              bondId: b.asset,
              blocksLeft: toSafeNum(left),
              cost: principal.toString(),
              face: b.repayment.toString(),
              yieldBps: yb !== null ? toSafeNum(yb) : null,
              maturity: toSafeNum(b.maturity),
              coverBps: cov ? toSafeNum(ratioBps(cov)) : null
            });
          }
        }
      }

      // Ask purchase fills
      const inputMap = new Map(tx.inputs.map((inp, idx) => [inp.boxId, { inp, idx }]));
      for (const payout of tx.outputs) {
        const tag = payoutTag(payout);
        if (!tag) continue;
        const found = inputMap.get(tag.askId);
        if (!found?.inp.box) continue;
        const a = readZcBox(found.inp.box);
        if (!a || a.recordType !== "ask" || a.market !== market) continue;

        const tid = a.token.tokenId;
        let asset: string | null = null;
        let whole = 1n;
        let facts: BondFacts | null = null;

        const directFacts = bondFacts.get(tid);
        if (directFacts) {
          asset = tid;
          whole = 1n;
          facts = directFacts;
        } else {
          const sf = shareFacts.get(tid);
          if (sf) {
            const bf = bondFacts.get(sf.asset);
            if (bf) {
              asset = sf.asset;
              whole = sf.shares;
              facts = bf;
            }
          }
        }

        if (!asset || !facts) continue;
        const mToken = marketTokenId(a.market);
        const paid =
          mToken === null
            ? payout.value
            : payout.assets
                .filter((t) => t.tokenId === mToken)
                .reduce((acc, t) => acc + t.amount, 0n);
        const face = (facts.repayment * tag.units) / whole;
        const left = facts.maturity - BigInt(tx.inclusionHeight);
        const yb = yieldBps(face, paid, left);

        fills.push({
          id: `${tx.transactionId}:${found.idx}`,
          txId: tx.transactionId,
          height: tx.inclusionHeight,
          timestamp: tx.timestamp,
          market: a.market,
          kind: whole > 1n ? "shares" : "resale",
          via,
          offerId: viaOfferId,
          sourceId: tag.askId,
          bondId: asset,
          blocksLeft: toSafeNum(left),
          cost: paid.toString(),
          face: face.toString(),
          yieldBps: yb !== null ? toSafeNum(yb) : null,
          maturity: toSafeNum(facts.maturity),
          coverBps: null
        });
      }
    }

    // Deduplicate and sort newest first
    const byId = new Map<string, RawFill>();
    for (const f of fills) {
      if (!byId.has(f.id)) byId.set(f.id, f);
    }
    const sorted = Array.from(byId.values()).sort(
      (a, b) => b.height - a.height || cmpStr(a.id, b.id)
    );
    this.fillsCache.set(cacheKey, sorted);
    return sorted;
  }

  async listFillsRaw(
    marketName: string,
    params?: { fromHeight?: number; kind?: string; via?: string; cursor?: string; limit?: number },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(signal);
    const m = requireMarket(marketName);
    const fromHeight =
      params?.fromHeight != null
        ? Math.max(0, Math.floor(params.fromHeight))
        : Math.max(0, snap.book.height - 7200);

    try {
      const all = await this.fetchAndExtractFills(snap, m, fromHeight, signal);
      const filtered = all.filter((f) => {
        if (params?.kind && f.kind !== params.kind) return false;
        if (params?.via && f.via !== params.via) return false;
        return true;
      });
      const offset = params?.cursor ? Math.max(0, Number(params.cursor) || 0) : 0;
      const limit = Math.min(MAX_PAGE, Math.max(1, params?.limit ?? DEFAULT_PAGE));
      const page = filtered.slice(offset, offset + limit);
      return {
        at: buildAtMeta(snap.book),
        status: "ready",
        observedAt: Date.now(),
        indexedTo: snap.book.height,
        items: page,
        next: offset + limit < filtered.length ? String(offset + limit) : null
      };
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      return {
        at: buildAtMeta(snap.book),
        status: "unavailable",
        observedAt: null,
        indexedTo: null,
        items: [],
        next: null
      };
    }
  }

  // ─── 9. auctions ────────────────────────────────────────────────────────────

  async listAuctionsRaw(
    marketName?: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(signal);
    const filterMarket = marketName ? requireMarket(marketName) : null;
    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);
    const h = BigInt(snap.book.height);

    const lots = snap.book.lots
      .filter((o) => filterMarket === null || o.record.market === filterMarket)
      .slice(0, MAX_PAGE)
      .map((o) => {
        const lot = o.record;
        const [opening, floor, start, end, expiry, refund] = lot.terms;
        const valid = lotValid(lot);
        const price = valid ? lotPrice(lot, h) : null;
        const borrowedBondIds = Array.from(
          new Set(
            lot.box.assets
              .map((a) => this.borrowedAsset(snap, known, a.tokenId))
              .filter((x): x is string => x !== null)
          )
        );
        const phase =
          h + 1n >= expiry
            ? "expired"
            : h < start
              ? "before"
              : h < end
                ? "falling"
                : "floor";

        return {
          boxId: lot.boxId,
          chainId: lot.boxId,
          pending: o.pending,
          mine: known.mine(lot.sellerHash),
          borrowedByMe: borrowedBondIds.length > 0,
          borrowedBondIds,
          sellerHash: lot.sellerHash,
          market: lot.market,
          items: json.tokens(lot.box.assets),
          nanoErg: lot.box.value.toString(),
          opening: opening.toString(),
          floor: floor.toString(),
          start: toSafeNum(start),
          end: toSafeNum(end),
          expiry: toSafeNum(expiry),
          refundFeeNanoErg: refund.toString(),
          priceNow: price !== null ? price.toString() : null,
          valid,
          phase
        };
      });

    const vaultEntries: { open: ZcOpen<ZcShareVault>; currency: string | null; market: ZcMarket | null }[] =
      [];
    for (const o of snap.book.shareVaults.values()) {
      const v = o.record;
      if (
        !v.dutch ||
        v.holding ||
        (v.state !== 1 && v.state !== 4) ||
        v.auction.length < 7
      ) {
        continue;
      }
      const currency = vaultCurrency(v);
      const vm = marketByTokenId(currency);
      if (filterMarket !== null && vm !== filterMarket) continue;
      vaultEntries.push({ open: o, currency, market: vm });
    }
    vaultEntries.sort((a, b) => cmpStr(a.open.boxId, b.open.boxId));

    const vaults = vaultEntries.slice(0, MAX_PAGE).map(({ open: o, currency, market: vm }) => {
      const v = o.record;
      const [repayment, opening, floor, length, expiry, threshold, began] = v.auction;
      const held = currencyHeld(v);
      const excess = v.state === 4;

      let quote: Record<string, unknown>;
      if (length < 1n) {
        quote = { done: true };
      } else if (excess) {
        const done = h + 1n >= began + length;
        const priceOpt = done ? null : excessPrice(v, h);
        quote =
          priceOpt === null
            ? { priceRaw: null, done: true }
            : { priceRaw: priceOpt.toString(), done: false };
      } else {
        const since = bigMin(bigMax(h - began, 0n), length);
        const target = bigMax(lotTarget(v, h), held);
        const bps = (opening * length - (opening - floor) * since) / length;
        const done = h >= began + expiry;
        quote = {
          targetRaw: target.toString(),
          payRaw: (target - held).toString(),
          bps: toSafeNum(bps),
          done
        };
      }

      const items = v.box.assets
        .slice(1)
        .filter((t) => t.tokenId !== currency)
        .filter((t) => !excess || t.amount < threshold);

      return {
        boxId: v.boxId,
        shareTokenId: v.shareId,
        bondId: v.bondAsset,
        market: vm,
        type: threshold === LONG_MAX ? "dutch" : "selective",
        state: v.state,
        repayment: repayment.toString(),
        openingBps: toSafeNum(opening),
        floorBps: toSafeNum(floor),
        length: toSafeNum(length),
        expiry: toSafeNum(expiry),
        auctionStart: toSafeNum(began),
        currencyHeld: held.toString(),
        items: json.tokens(items),
        quote,
        pending: o.pending
      };
    });

    return {
      at: buildAtMeta(snap.book),
      lots,
      vaults
    };
  }

  // ─── 10. lookup ─────────────────────────────────────────────────────────────

  async lookupRaw(id0: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = requireHex64(id0);
    const snap = await this.ensureSnapshot(signal);
    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);

    const recordJson = (r: ZcRecord, pending: boolean): [string, Record<string, unknown>] => {
      switch (r.recordType) {
        case "order":
          return ["order", json.orderJson(openOf(r, pending))];
        case "ask":
          return ["ask", json.askJson(openOf(r, pending))];
        case "offer":
          return ["offer", json.offerJson(openOf(r, pending))];
        case "bond":
          return ["bond", json.bondJson(r.asset) ?? { assetId: r.asset }];
        case "settlement":
          return ["bond", json.bondJson(r.asset) ?? { assetId: r.asset }];
        case "shareVault":
          return ["shares", json.sharesJson(r.shareId) ?? { tokenId: r.shareId }];
        case "lot":
          return ["lot", { boxId: r.boxId }];
        case "shareRequest":
          return [
            "mintRequest",
            {
              boxId: r.boxId,
              bondId: r.bondAsset,
              terms: r.terms.map((t) => t.toString()),
              mine: known.mine(r.ownerHash)
            }
          ];
        case "wrapRequest":
          return [
            "wrapRequest",
            {
              boxId: r.boxId,
              token: r.wrapped.tokenId,
              amount: r.wrapped.amount.toString(),
              mintFeeNanoErg: r.mintFee.toString(),
              mine: known.mine(r.ownerHash)
            }
          ];
        case "wrapVault":
          return ["wrap", json.wrapJson(r)];
      }
    };

    const answer = (
      type: string,
      record: Record<string, unknown>,
      current: string | null,
      spentBy: string | null,
      successorId: string | null,
      note: string | null = null
    ) => ({
      at: buildAtMeta(snap.book),
      type,
      record,
      current,
      spentBy,
      successorId,
      note
    });

    const openHit = snap.book.byBoxId.get(id);
    if (openHit) {
      const [type, recJson] = recordJson(openHit.record, openHit.pending);
      return answer(type, recJson, openHit.boxId, null, null);
    }

    if (snap.book.bonds.has(id) || snap.book.settlements.has(id)) {
      const stateBox = snap.book.bonds.get(id)?.boxId ?? snap.book.settlements.get(id)?.boxId ?? null;
      return answer("bond", json.bondJson(id)!, stateBox, null, null);
    }
    if (snap.book.shareVaults.has(id)) {
      return answer("shares", json.sharesJson(id)!, snap.book.shareVaults.get(id)!.boxId, null, null);
    }
    if (snap.book.wrapVaults.has(id)) {
      const v = snap.book.wrapVaults.get(id)!;
      return answer("wrap", json.wrapJson(v.record), v.boxId, null, null);
    }

    // Not in open book: fetch directly from GraphQL and follow spent continuations
    const boxMap = await this.gql.fetchBoxesByIds([id], signal);
    const found = boxMap.get(id);
    if (!found) throw new ZcApiError(`${id} is not a ZC box, bond asset, share or receipt`, 404);
    const record = readZcBox(found);
    if (!record) throw new ZcApiError(`${id} is not a ZC box`, 404);

    const kindMap: Record<ZcRecord["recordType"], string> = {
      order: "order",
      ask: "ask",
      offer: "offer",
      bond: "bond",
      lot: "lot",
      shareRequest: "mintRequest",
      wrapRequest: "wrapRequest",
      settlement: "vault",
      shareVault: "vault",
      wrapVault: "vault"
    };
    const kind = kindMap[record.recordType];
    const base: Record<string, unknown> = {
      boxId: id,
      contract: record.script.kind,
      txId: found.transactionId,
      created: found.settlementHeight || found.creationHeight,
      spentTx: found.spentTransactionId ?? null
    };

    if (
      record.recordType === "order" &&
      found.spentTransactionId &&
      (snap.book.bonds.has(record.boxId) || snap.book.settlements.has(record.boxId))
    ) {
      return answer("bond", json.bondJson(record.boxId)!, null, found.spentTransactionId, null, "filled");
    }

    if (!found.spentTransactionId) {
      return answer(kind, base, null, null, null, "unspent, but past the tracker's cap");
    }

    let hops = 0;
    let at = id;
    let spending: string | null = found.spentTransactionId;
    let successor: string | null = null;
    let current: string | null = null;

    while (spending && hops < MAX_LOOKUP_HOPS) {
      hops++;
      const txMap = await this.gql.fetchTransactionsByIds([spending], signal);
      const tx = txMap.get(spending);
      if (!tx) break;
      const nextOut = tx.outputs.find((out) => {
        const r = readZcBox(out);
        if (!r) return false;
        if (r.recordType === "offer") return r.predecessor === at;
        if (r.recordType === "ask") return r.predecessor === at;
        return false;
      });
      if (!nextOut) break;
      if (successor === null) successor = nextOut.boxId;
      at = nextOut.boxId;
      if (snap.book.byBoxId.has(at)) {
        current = at;
        spending = null;
      } else {
        spending = nextOut.spentTransactionId ?? null;
      }
    }

    const note = current
      ? null
      : successor === null
        ? "spent without a continuation: filled whole, cancelled or refunded"
        : "the chain continues past what this lookup followed";

    let currentRecord: Record<string, unknown> | undefined;
    if (current) {
      const curOpen = snap.book.byBoxId.get(current);
      if (curOpen) {
        if (curOpen.record.recordType === "offer") {
          currentRecord = json.offerJson(curOpen as ZcOpen<ZcOffer>);
        } else if (curOpen.record.recordType === "ask") {
          currentRecord = json.askJson(curOpen as ZcOpen<ZcAsk>);
        } else {
          currentRecord = { boxId: curOpen.boxId };
        }
      }
    }

    return answer(
      kind,
      currentRecord ? { ...base, current: currentRecord } : base,
      current,
      found.spentTransactionId,
      successor,
      note
    );
  }

  // ─── 11. search ─────────────────────────────────────────────────────────────

  async searchRaw(q0: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const q = q0.trim().toLowerCase();
    if (q.length < 6 || !/^[0-9a-f]+$/.test(q)) {
      throw new ZcApiError("q needs at least 6 hex characters", 400);
    }
    const snap = await this.ensureSnapshot(signal);
    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);

    const hits = new Map<string, Record<string, unknown>>();
    const addHit = (
      id: string,
      type: string,
      market: ZcMarket | null,
      title: string,
      statusFn: () => string | null,
      yieldFn: () => number | null,
      borrowedFn: () => boolean = () => false
    ) => {
      if (hits.size >= MAX_SEARCH_HITS || !id.startsWith(q) || hits.has(id)) return;
      hits.set(id, {
        id,
        type,
        market,
        title,
        status: statusFn(),
        yieldBps: yieldFn(),
        borrowedByMe: borrowedFn()
      });
    };

    for (const [asset, b] of snap.book.bonds) {
      addHit(asset, "bond", b.record.market, "Bond", () => "live", () => null, () =>
        known.mine(b.record.borrowerHash)
      );
    }
    for (const [asset, v] of snap.book.settlements) {
      addHit(
        asset,
        "bond",
        null,
        "Bond",
        () => (v.record.liquidated ? "liquidated" : "repaid"),
        () => null
      );
    }
    for (const t of snap.book.shareVaults.keys()) {
      addHit(t, "shares", null, "Shares", () => null, () => null, () =>
        this.borrowedAsset(snap, known, t) !== null
      );
    }
    for (const t of snap.book.wrapVaults.keys()) {
      addHit(t, "wrap", null, "Wrap receipt", () => null, () => null);
    }
    for (const o of snap.book.orders) {
      addHit(
        o.boxId,
        "order",
        o.record.market,
        "Borrow order",
        () => json.orderStanding(o.record).status,
        () => {
          const qRes = json.orderQuote(o.record);
          return qRes ? toSafeNum(qRes.yieldBps) : null;
        },
        () => known.mine(o.record.borrowerHash)
      );
    }
    for (const a of snap.book.asks) {
      addHit(
        a.boxId,
        "ask",
        a.record.market,
        "Ask",
        () => json.askStanding(a.record).status,
        () => null,
        () => this.borrowedAsset(snap, known, a.record.token.tokenId) !== null
      );
    }
    for (const o of snap.book.offers) {
      addHit(
        o.boxId,
        "offer",
        o.record.market,
        "Lend offer",
        () => json.offerStanding(o.record).status,
        () => toSafeNum(o.record.terms[0])
      );
    }
    for (const l of snap.book.lots) {
      addHit(
        l.boxId,
        "lot",
        l.record.market,
        "Lot auction",
        () => null,
        () => null,
        () => l.record.box.assets.some((a) => this.borrowedAsset(snap, known, a.tokenId) !== null)
      );
    }

    return {
      at: buildAtMeta(snap.book),
      q,
      hits: Array.from(hits.values())
    };
  }

  // ─── 12. assets ─────────────────────────────────────────────────────────────

  async lookupAssetsRaw(
    tokenIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (tokenIds.length > MAX_ASSETS) {
      throw new ZcApiError(`at most ${MAX_ASSETS} token ids`, 400);
    }
    const snap = await this.ensureSnapshot(signal);
    const ids = Array.from(new Set(tokenIds.map(requireHex64)));

    await Promise.all([
      this.resolver.resolveOrigins(ids, snap.book.height, signal),
      this.resolver.resolveTokens(ids, snap.book.height, signal)
    ]);

    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);

    const tokens: Record<string, unknown> = {};
    for (const id of ids) {
      const origin = this.resolver.knownOrigin(id);
      const info = this.resolver.knownToken(id);
      const mintedExists =
        snap.book.bonds.has(id) ||
        snap.book.settlements.has(id) ||
        snap.book.shareVaults.has(id) ||
        snap.book.wrapVaults.has(id) ||
        info !== null;

      let kind = "token";
      if (mintedExists && origin) {
        if (origin.kind === "Order" || origin.kind === "PricedOrder") kind = "bondUnit";
        else if (origin.kind === "FractionalMint" || origin.kind === "DutchAuctionMint") {
          kind = "shares";
        } else if (origin.kind === "WrapMint") kind = "wrapReceipt";
      }

      const wrapVault = snap.book.wrapVaults.get(id);
      const wrap =
        kind === "wrapReceipt"
          ? wrapVault
            ? json.wrapJson(wrapVault.record)
            : origin?.held
              ? {
                  token: origin.held.tokenId,
                  amount: origin.held.amount.toString(),
                  state: "requested"
                }
              : null
          : null;

      tokens[id] = {
        id,
        name: info?.name ?? null,
        decimals: info?.decimals ?? null,
        verified: kind !== "token",
        kind,
        bond: kind === "bondUnit" ? json.bondJson(id) : null,
        shares: kind === "shares" ? json.sharesJson(id) : null,
        wrap,
        provision: null,
        displayPrice: null
      };
    }

    return {
      at: buildAtMeta(snap.book),
      tokens
    };
  }

  // ─── 13. portfolio ──────────────────────────────────────────────────────────

  private confirmedBelow(snap: SnapshotState, b: ZcBondTerms): boolean {
    const o = snap.book.confirmedOracle;
    if (!o) return false;
    return freshOracle(o, b.payload[1] ?? 0n, BigInt(snap.book.height)) && belowOwnRatio(b, o.price);
  }

  private actionObj(name: string, enabled: boolean, reason: string | null) {
    return { name, enabled, reason: enabled ? null : reason };
  }

  private positionJson(
    snap: SnapshotState,
    json: ZcJson,
    hashes: ReadonlySet<string>,
    t: ChainAsset,
    asset: string,
    whole: bigint,
    vault: ZcShareVault | null
  ): Record<string, unknown> {
    const h = BigInt(snap.book.height);
    const live = snap.book.bonds.get(asset)?.record ?? null;
    const settled = snap.book.settlements.get(asset)?.record ?? null;
    const borrowedByMe = live !== null && hashes.has(live.borrowerHash);
    const canUnfrac = vault !== null && vault.holding && t.amount >= vault.outstanding;

    let status: string;
    if (live) {
      status = h >= live.maturity ? "maturedUnpaid" : "live";
    } else if (settled && vault && vault.holding) {
      status = "pullNeeded";
    } else if (vault && auctionOpen(vault) && h < claimableFrom(vault)) {
      status = "auction";
    } else if (settled && !vault) {
      status = settled.liquidated ? "liquidated" : "repaid";
    } else {
      status = "claimable";
    }

    let mark: Record<string, unknown> | null = null;
    if (live) {
      const left = live.maturity - (h + 1n);
      const face = (live.repayment * t.amount) / whole;
      const cover = json.coverBps(bondTermsOf(live));
      let bestBid: bigint | null = null;
      for (const op of snap.book.offers) {
        const o = op.record;
        if (
          o.market !== live.market ||
          left < minBlocks(o) ||
          left > maxBlocks(o) ||
          (cover !== null && cover < floorBps(o)) ||
          h + 1n >= o.expiry ||
          (whole > 1n && !buysShares(o)) ||
          !json.offerStanding(o).ok
        ) {
          continue;
        }
        const y = offerCurve(o).bpsAt(left);
        if (y >= 0n && (bestBid === null || y < bestBid)) bestBid = y;
      }

      if (bestBid !== null && left > 0n && YEAR + bestBid * left > 0n) {
        const value = (face * YEAR) / (YEAR + bestBid * left);
        mark = {
          basis: "bid",
          bidBps: toSafeNum(bestBid),
          value: value.toString(),
          atMaturity: face.toString(),
          pnl: null,
          entryBps: null
        };
      } else {
        const span = bigMax(live.maturity - live.start, 1n);
        const rawPrincipal =
          marketTokenId(live.market) === null
            ? live.terms[1]
            : live.principalTokens[0]?.amount ?? 0n;
        const principal = (rawPrincipal * t.amount) / whole;
        const elapsed = bigMin(bigMax(h - live.start, 0n), span);
        const accrued = principal + ((face - principal) * elapsed) / span;
        mark = {
          basis: "accrual",
          value: accrued.toString(),
          atMaturity: face.toString(),
          pnl: null,
          entryBps: null
        };
      }
    } else if (settled) {
      const orig = this.resolver.knownOrigin(asset);
      const sigUsdMarket = orig?.market === "SigUSD";
      const sigUsd = settled.proceeds
        .filter((p) => p.tokenId === ZC_SIGUSD_TOKEN_ID)
        .reduce((acc, p) => acc + p.amount, 0n);
      const value = ((sigUsdMarket ? sigUsd : settled.box.value) * t.amount) / whole;
      mark = {
        basis: "settled",
        nanoErg: settled.box.value.toString(),
        value: value.toString(),
        pnl: null
      };
    }

    return {
      tokenId: t.tokenId,
      kind: whole > 1n ? "shares" : "bondUnit",
      units: t.amount.toString(),
      borrowedByMe,
      bond: json.bondJson(asset),
      shares: vault ? json.sharesJson(vault.shareId) : null,
      status,
      cost: null,
      mark,
      actions: [
        this.actionObj("sell", live !== null, "the bond is not live"),
        this.actionObj(
          "claim",
          status === "claimable" || status === "repaid" || status === "liquidated" || canUnfrac,
          "not settled"
        ),
        this.actionObj("pull", status === "pullNeeded", "nothing to pull"),
        this.actionObj(
          "liquidate",
          live !== null && (h >= live.maturity || this.confirmedBelow(snap, bondTermsOf(live))),
          "not due"
        ),
        this.actionObj(
          "extinguish",
          borrowedByMe && whole === 1n && live !== null,
          !borrowedByMe
            ? "not your borrowed bond"
            : whole > 1n
              ? "final-claim all shares first to recover the bond unit"
              : "the bond is not live"
        )
      ]
    };
  }

  async getPortfolioRaw(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(signal);
    const { hashes, nanoErg, tokens: held } = this.walletState();
    await this.resolver.resolveOrigins(
      held.map((t) => t.tokenId),
      snap.book.height,
      signal
    );

    const known = this.buildKnown(snap.book);
    const matcher = this.buildMatcher(snap.book);
    const json = new ZcJson(matcher, known);
    const h = BigInt(snap.book.height);

    const lending: Record<string, unknown>[] = [];
    for (const t of held) {
      const origin: ZcOrigin | null = this.resolver.knownOrigin(t.tokenId);
      if (!origin) continue;
      if (origin.kind === "Order" || origin.kind === "PricedOrder") {
        lending.push(this.positionJson(snap, json, hashes, t, t.tokenId, 1n, null));
      } else if (origin.kind === "FractionalMint" || origin.kind === "DutchAuctionMint") {
        const sv = snap.book.shareVaults.get(t.tokenId);
        if (sv) {
          lending.push(
            this.positionJson(
              snap,
              json,
              hashes,
              t,
              sv.record.bondAsset,
              sv.record.shares,
              sv.record
            )
          );
        }
      }
    }

    const borrowing = Array.from(snap.book.bonds.values())
      .filter((b) => hashes.has(b.record.borrowerHash))
      .sort((a, b) => cmpBigAsc(a.record.maturity, b.record.maturity))
      .map((b) => {
        const r = b.record;
        const due = h >= r.maturity || this.confirmedBelow(snap, bondTermsOf(r));
        const holdsUnit = held.some((t) => t.tokenId === r.asset && t.amount >= 1n);
        const recollHeight = r.box.creationHeight + Number(RECOLLATERALIZE_WAIT);
        return {
          bond: json.bondJson(r.asset),
          status: due ? "liquidatable" : "live",
          holdsUnit,
          actions: [
            this.actionObj(
              "repay",
              h + 1n < r.maturity,
              h + 1n >= r.maturity ? "the bond has reached maturity" : null
            ),
            this.actionObj(
              "recollateralize",
              h + 1n < r.maturity && h >= BigInt(recollHeight),
              h + 1n >= r.maturity ? "the bond has reached maturity" : `opens at #${recollHeight}`
            ),
            this.actionObj("extinguish", holdsUnit, "buy or hold the circulating bond unit first")
          ]
        };
      });

    const openOrders: Record<string, unknown>[] = [];
    const openAsks: Record<string, unknown>[] = [];
    const openOffers: Record<string, unknown>[] = [];
    const openLots: Record<string, unknown>[] = [];
    const openMints: Record<string, unknown>[] = [];
    const openWraps: Record<string, unknown>[] = [];

    for (const op of snap.book.allOpen) {
      if (!op.record.namedHash || !hashes.has(op.record.namedHash)) continue;
      switch (op.record.recordType) {
        case "order":
          openOrders.push(json.orderJson(op as ZcOpen<ZcOrder>));
          break;
        case "ask":
          openAsks.push(json.askJson(op as ZcOpen<ZcAsk>));
          break;
        case "offer":
          openOffers.push(json.offerJson(op as ZcOpen<ZcOffer>));
          break;
        case "lot":
          openLots.push({ boxId: op.boxId, pending: op.pending });
          break;
        case "shareRequest":
          openMints.push({ boxId: op.boxId, bondId: op.record.bondAsset, pending: op.pending });
          break;
        case "wrapRequest":
          openWraps.push({ boxId: op.boxId, token: op.record.wrapped.tokenId, pending: op.pending });
          break;
        default:
          break;
      }
    }

    const wraps: Record<string, unknown>[] = [];
    for (const t of held) {
      const wv = snap.book.wrapVaults.get(t.tokenId);
      if (wv) wraps.push({ ...json.wrapJson(wv.record), inWallet: true });
    }

    const attention = borrowing.filter((item) => {
      if (item.status !== "live") return true;
      const bond = item.bond as Record<string, unknown> | null;
      if (!bond) return false;
      if (typeof bond.maturity === "number" && BigInt(bond.maturity) - h <= ATTENTION_BLOCKS) {
        return true;
      }
      if (typeof bond.coverBps === "number" && BigInt(bond.coverBps) < ATTENTION_COVER_BPS) {
        return true;
      }
      return false;
    }).length;

    return {
      at: buildAtMeta(snap.book),
      wallet: {
        nanoErg: nanoErg.toString(),
        tokens: held.map((t) => {
          const o = this.resolver.knownOrigin(t.tokenId);
          return {
            tokenId: t.tokenId,
            amount: t.amount.toString(),
            kind: o ? kindName(o.kind) : "token"
          };
        })
      },
      lending,
      borrowing,
      open: {
        orders: openOrders,
        asks: openAsks,
        offers: openOffers,
        lots: openLots,
        mintRequests: openMints,
        wrapRequests: openWraps
      },
      wraps,
      attention: { borrowing: attention },
      unrealized: {},
      realized: {},
      history: "off"
    };
  }
}
