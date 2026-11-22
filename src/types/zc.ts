export type ZcMarket = "ERG" | "SigUSD";
export type ZcDurationUnit = "days" | "blocks";
export type ZcSourceKind = "all" | "new" | "resale" | "shares";
export type ZcSortKey = "apr" | "maturity" | "size";

export interface ZcSnapshotMeta {
  height: number;
  blockId: string;
  indexedHeight: number;
  revision: number;
  cut: boolean;
  mempool: boolean;
}

export interface ZcOracleInfo {
  feed: string;
  boxId: string;
  nanoErgPerUsd: string;
  usdPerErg: string;
  updatedHeight: number;
  age: number;
  refreshPending: boolean;
}

export interface ZcInfoResponse {
  at: ZcSnapshotMeta;
  network: string;
  profile: string;
  pinnedCommit?: string;
  deployed: boolean;
  oracle: ZcOracleInfo | null;
  defaults?: Record<string, string | number>;
}

export interface ZcRawCurvePoint {
  blocks: number;
  bps: number | null;
  offerId?: string | null;
  askId?: string | null;
}

export interface ZcRawAskDot {
  askId: string;
  blocks: number;
  bps: number;
  ok?: boolean;
  pending?: boolean;
}

export interface ZcRawWindowCurve {
  askId: string;
  minBlocks: number;
  maxBlocks: number;
  capBps: number;
  points: { blocks: number; bps: number }[];
}

export interface ZcRawCurvesResponse {
  at: ZcSnapshotMeta;
  domain: [number, number];
  bidLine: ZcRawCurvePoint[];
  askLine: ZcRawCurvePoint[];
  askDots: ZcRawAskDot[];
  windows?: ZcRawWindowCurve[];
  totals: {
    asks: { matchable: number; count: number; cost: string };
    offers: { matchable: number; count: number; capital: string };
    searched?: { asks: number; offers: number };
  };
}

export interface ZcCurvePoint {
  d: number;
  y: number | null;
  id: string | null;
}

export interface ZcAskDot {
  id: string;
  d: number;
  y: number;
  ok: boolean;
  pending: boolean;
}

export interface ZcWindowCurve {
  id: string;
  min: number;
  max: number;
  cap: number;
  points: { d: number; y: number }[];
}

export interface ZcCurves {
  domain: [number, number];
  bidLine: ZcCurvePoint[];
  askLine: ZcCurvePoint[];
  dots: ZcAskDot[];
  windows: ZcWindowCurve[];
  totals: {
    asks: { matchable: number; count: number; cost: number };
    offers: { matchable: number; count: number; capital: number };
  };
  searched: {
    bids: number;
    bidTotal: number;
    asks: number;
    askTotal: number;
  };
}

export interface ZcQuote {
  d: number;
  maturity: number;
  cost: number;
  face: number;
  yieldBps: number;
  quotedYieldBps: number | null;
  pct: number;
  validFrom?: number;
  validThrough?: number;
}

export interface ZcCollateralToken {
  id: string;
  ticker: string;
  name: string | null;
  decimals: number;
  amount: number;
  rawAmount: string;
  kind: "token" | "provision" | "receipt" | "bond" | "shares";
  verified?: boolean;
}

export interface ZcCollateral {
  erg: number;
  usd: number;
  tokens: ZcCollateralToken[];
}

export interface ZcTwoPointYield {
  h0: number;
  y0: number;
  h1: number;
  y1: number;
}

export interface ZcCheckItem {
  key: string;
  ok: boolean;
  detail: string;
}

export interface ZcBondSummary {
  id: string;
  market: ZcMarket;
  principal: number | null;
  repayment: number;
  start: number;
  maturity: number;
  collateral: ZcCollateral;
  rule: string;
  ratio: number | null;
  oracleAge: number;
  cov: number | null;
  vault: string | null;
}

export interface ZcAskSummary {
  id: string;
  boxId: string;
  chainId: string;
  txId: string | null;
  created: number;
  market: ZcMarket;
  kind: "order" | "unit" | "shares";
  contract: string | null;
  pricing: "fixed" | "yield" | "window" | string;
  mode: "fixed" | "term" | "window";
  maturity: number | null;
  duration: number | null;
  window: { min: number; max: number } | null;
  points: { d: number; y: number }[] | null;
  cap: number | null;
  principal: number | null;
  repayment: number | null;
  price: number | null;
  floor: number;
  tp: ZcTwoPointYield | null;
  units: number;
  minFill: number;
  collateral: ZcCollateral;
  bond: ZcBondSummary | null;
  cov: number | null;
  status: string;
  reasons: string[];
  reason: string | null;
  ok: boolean;
  pending: boolean;
  owner: boolean;
  quote: ZcQuote | null;
  rule: string;
  ratio: number | null;
  oracleAge: number;
  guard: { ratio: number; age: number } | null;
  expiry: number;
  expiryFee: number;
  checks: ZcCheckItem[];
}

export interface ZcOfferSummary {
  id: string;
  boxId: string;
  chainId: string;
  txId: string | null;
  created: number;
  market: ZcMarket;
  capital: number;
  funded: number;
  boxErg: number | null;
  minYieldBps: number;
  minBlocks: number;
  maxBlocks: number;
  floor: number;
  oracleAge: number;
  fee: number;
  reserve: number;
  rewardNow: number | null;
  minPrice: number | null;
  expiry: number;
  delivery: string;
  shares: { floor: number; expiry: number } | null;
  tokenBudget: {
    originalCapital: number | null;
    totalErgBudget: number | null;
    minFillBps: number;
    rewardBudget: number | null;
  } | null;
  status: string;
  reasons: string[];
  reason: string | null;
  ok: boolean;
  pending: boolean;
  owner: boolean;
  points: { d: number; y: number }[];
  checks: ZcCheckItem[];
}

export interface ZcOrderbookAskRow {
  id: string;
  kind: "order" | "unit" | "shares";
  y: number;
  size: number;
  d: number;
  window: boolean;
  ok: boolean;
  reason: string | null;
}

export interface ZcOrderbookBidRow {
  id: string;
  y: number;
  size: number;
  range: [number, number];
  ok: boolean;
  reason: string | null;
}

export interface ZcOrderbook {
  asks: ZcOrderbookAskRow[];
  bids: ZcOrderbookBidRow[];
  bestAsk: number | null;
  bestBid: number | null;
  spread: number | null;
  lo: number;
  hi: number;
  band: number | null;
  range: boolean;
}

export interface ZcFillSummary {
  id: string;
  txId: string;
  height: number;
  timestamp?: number;
  market: ZcMarket;
  kind: string;
  via: string;
  offerId?: string | null;
  sourceId?: string | null;
  bondId?: string | null;
  d: number;
  maturity?: number;
  cost: number;
  face: number;
  yieldBps: number;
  cov: number | null;
}

export interface ZcFillsResponse {
  items: ZcFillSummary[];
  status: "ready" | "not-configured" | "disabled" | string;
  indexedTo: number | null;
}

export interface ZcPagedResult<T> {
  items: T[];
  total: number;
  next: string | null;
  pendingLeftOut: number;
}

export interface ZcSimulateMatch {
  counterpartyId: string;
  units: string;
  cost: string;
  face: string;
  yieldBps: number;
  maturity: number;
}

export interface ZcSimulateResponse {
  outcome: string;
  matches: ZcSimulateMatch[];
  filled: string;
  remaining: string;
  searched: number;
}

export interface ZcMatchBuy {
  counterpartyId?: string;
  boxId?: string;
  askId?: string;
  maturity: number;
  yieldBps: number;
  cost?: string;
  face?: string;
}

export interface ZcMatchesResponse {
  buys?: ZcMatchBuy[];
  matches?: ZcMatchBuy[];
}

export interface ZcSearchHit {
  type: string;
  id: string;
  market?: ZcMarket;
  status?: string;
  summary?: string;
}

export interface ZcRateBookFilters {
  coverage: number;
  kind: ZcSourceKind;
  matchable: boolean;
  grid: boolean;
}

export interface ZcMarketSnapshot {
  market: ZcMarket;
  curves: ZcCurves | null;
  asks: ZcAskSummary[];
  offers: ZcOfferSummary[];
  fills: ZcFillSummary[];
  weightedFillAprBps: number | null;
  bestBidBps: number | null;
  bestAskBps: number | null;
}

export interface ZcAuctionLotSummary {
  boxId: string;
  market: ZcMarket;
  opening: number;
  floor: number;
  priceNow: number | null;
  phase: string;
  itemCount: number;
  pending: boolean;
}

export interface ZcAuctionVaultSummary {
  boxId: string;
  bondId: string;
  market: ZcMarket;
  vaultType: string;
  state: number;
  repayment: number;
  payNow: number | null;
  pending: boolean;
}
