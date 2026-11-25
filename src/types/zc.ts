export type ZcMarket = "ERG" | "SigUSD";
export type ZcDurationUnit = "days" | "blocks";
export type ZcSourceKind = "all" | "new" | "resale" | "shares";
export type ZcSortKey = "apr" | "maturity" | "size";
export type ZcStudioTab = "borrow" | "lend" | "sell" | "auction" | "shares" | "wrap";
export type ZcChartMetric = "yield" | "pct" | "abs";
export type ZcCurveShape = "normal" | "flat" | "inverted" | "humped";
export type ZcCurveMove =
  | "up"
  | "down"
  | "bullSteep"
  | "bearSteep"
  | "bullFlat"
  | "bearFlat"
  | "flyUp"
  | "flyDown";

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
  kind?: string;
  blocks: number;
  bps: number;
  ok?: boolean;
  pending?: boolean;
  borrowedByMe?: boolean;
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
  kind?: "order" | "unit" | "shares";
  d: number;
  y: number;
  ok: boolean;
  pending: boolean;
  borrowedByMe: boolean;
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

export interface ZcWrappedTokenInfo {
  id: string;
  ticker: string;
  name: string | null;
  description: string | null;
  decimals: number;
  amount: number;
  rawAmount: string;
  kind?: "token" | "provision" | "bond" | "shares";
  bondId?: string | null;
  vaultBoxId?: string | null;
  refreshFrom?: number | null;
  state?: string | null;
}

export interface ZcCollateralToken {
  id: string;
  ticker: string;
  name: string | null;
  description?: string | null;
  decimals: number;
  amount: number;
  rawAmount: string;
  kind: "token" | "provision" | "receipt" | "bond" | "shares";
  bondId?: string | null;
  wraps?: ZcWrappedTokenInfo | null;
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
  ok: boolean | null;
  detail: string;
}

export interface ZcBondSummary {
  id: string;
  stateBoxId?: string | null;
  created?: number;
  state?: string;
  market: ZcMarket;
  borrowerHash?: string | null;
  principal: number | null;
  repayment: number;
  start: number;
  maturity: number;
  timing?: string;
  reserve?: number;
  collateral: ZcCollateral;
  rule: string;
  ratio: number | null;
  oracleAge: number;
  cov: number | null;
  recollateralizeFrom?: number | null;
  refreshFrom?: number | null;
  settlement?: Record<string, number> | null;
  vault: string | null;
  pending?: boolean;
  mine?: boolean;
  borrowedByMe?: boolean;
  checks?: ZcCheckItem[];
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
  shareCount?: number;
  collateral: ZcCollateral;
  bond: ZcBondSummary | null;
  cov: number | null;
  status: string;
  reasons: string[];
  reason: string | null;
  ok: boolean;
  pending: boolean;
  owner: boolean;
  borrowedByMe: boolean;
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
  borrowedByMe: boolean;
  reason: string | null;
  bidAtD: number | null;
  vsBid: number | null;
}

export interface ZcOrderbookBidRow {
  id: string;
  y: number;
  yMin: number;
  yMax: number;
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
  anchorBlocks: number | null;
  anchorBid: number | null;
  spread: number | null;
  spreadD: number | null;
  spreadBid: number | null;
  spreadAsk: number | null;
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
  offerId?: string;
  units: string;
  cost: string;
  face: string;
  yieldBps: number;
  requiredBps?: number;
  maturity: number;
}

export interface ZcSimulateResponse {
  outcome: string;
  refusal?: string | null;
  matches: ZcSimulateMatch[];
  offers?: ZcSimulateMatch[];
  filled: string;
  remaining: string;
  searched?: number;
  bidLine?: { offerId?: string | null; blocks: number; bps: number }[];
  askLine?: { askId?: string | null; blocks: number; bps: number }[];
  askDots?: { askId: string; blocks: number; bps: number; requiredBps?: number }[];
  collateralNeeded?: string | null;
  rounds?: number;
}

export interface ZcMatchBuy {
  counterpartyId?: string;
  boxId?: string;
  askId?: string;
  offerId?: string;
  units?: string;
  maturity: number;
  yieldBps: number;
  requiredBps?: number;
  coverBps?: number | null;
  borrowedByMe?: boolean;
  cost?: string;
  face?: string;
}

export interface ZcMatchesResponse {
  type?: "offer" | "ask" | string;
  offerId?: string;
  askId?: string;
  notMatchable?: string | null;
  buys?: ZcMatchBuy[];
  matches?: ZcMatchBuy[];
  offers?: {
    offerId: string;
    units: string;
    cost: string;
    yieldBps: number;
    requiredBps: number;
  }[];
  next?: {
    taken: string[];
    spent: string;
    avgYieldBps: number | null;
    rounds: number;
  };
  first?: string | null;
}

export interface ZcLookupResult {
  type: string;
  ask?: ZcAskSummary;
  offer?: ZcOfferSummary;
  bond?: ZcBondSummary;
  shares?: {
    tokenId: string;
    bondId: string;
    type: string;
    shareCount: string;
    decimals: number;
    minLot?: string | null;
    vault?: {
      boxId: string;
      state: number;
      pulled: boolean;
      outstanding: string;
    } | null;
  } | null;
  current?: string | null;
  spentBy?: string | null;
  successorId?: string | null;
  note?: string | null;
}

export interface ZcWalletToken {
  id: string;
  ticker: string;
  name: string | null;
  description?: string | null;
  decimals: number;
  amount: number;
  rawAmount: string;
  kind: "token" | "provision" | "receipt" | "bond" | "shares";
  bondId?: string | null;
  wraps?: ZcWrappedTokenInfo | null;
  verified?: boolean;
  unverified?: boolean;
  usd?: number | null;
  pool?: string | null;
  liquidity?: string | null;
  fees?: string | null;
}

export interface ZcActionAvailability {
  name: string;
  enabled: boolean;
  reason: string | null;
}

export interface ZcPortfolioPosition {
  id: string;
  tokenId?: string;
  side: "lend" | "borrow";
  kind: "unit" | "shares";
  units: number;
  unitsRaw?: string;
  holdsUnit?: boolean;
  borrowedByMe?: boolean;
  status: string;
  bond: ZcBondSummary;
  shares?: {
    tokenId?: string;
    bondId?: string;
    type?: string;
    shareCount?: string | number;
    minLot?: string | null;
    vault?: { boxId?: string; state?: number; pulled?: boolean; outstanding?: string } | null;
  } | null;
  paid?: number | null;
  at?: number | null;
  via?: string | null;
  vaultId?: string | null;
  mark?: {
    basis: string;
    bid: number | null;
    value: number | null;
    pnl: number | null;
    entry: number | null;
    atMaturity: number | null;
  } | null;
  actions: Record<string, ZcActionAvailability>;
  settlement?: Record<string, number> | null;
}

export interface ZcPortfolioMintRequest {
  id: string;
  boxId: string;
  bondId: string;
  pending?: boolean;
}

export interface ZcPortfolioWrap {
  id: string;
  boxId?: string;
  receiptId?: string;
  vaultBoxId?: string;
  receipt: ZcWalletToken;
  token: ZcWalletToken;
  state: "requested" | "wrapped" | string;
  refreshFrom?: number | null;
  pending?: boolean;
  inWallet: boolean;
}

export interface ZcPortfolioState {
  loaded: boolean;
  loading: boolean;
  walletErg: number;
  walletSigUsd: number;
  walletTokens: ZcWalletToken[];
  positions: ZcPortfolioPosition[];
  openOrders: ZcAskSummary[];
  openAsks: ZcAskSummary[];
  openOffers: ZcOfferSummary[];
  openLots: ZcAuctionLotSummary[];
  mintRequests: ZcPortfolioMintRequest[];
  wraps: ZcPortfolioWrap[];
  attentionCount: number;
}

export interface ZcSearchHit {
  type: string;
  id: string;
  market?: ZcMarket;
  status?: string;
  summary?: string;
  title?: string;
  yieldBps?: number;
  borrowedByMe?: boolean;
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
  id: string;
  boxId: string;
  chainId?: string;
  market: ZcMarket;
  opening: number;
  floor: number;
  start: number;
  end: number;
  expiry: number;
  refundFee: number;
  erg: number;
  items: ZcCollateralToken[];
  priceNow: number | null;
  phase: "before" | "falling" | "floor" | "expired" | string;
  itemCount: number;
  valid: boolean;
  owner: boolean;
  borrowedByMe: boolean;
  borrowedBondIds: string[];
  pending: boolean;
}

export interface ZcAuctionVaultSummary {
  id: string;
  boxId: string;
  shareTokenId?: string;
  bondId: string;
  market: ZcMarket;
  vaultType: "selective" | "dutch" | string;
  state: number;
  repayment: number;
  openBps: number;
  floorBps: number;
  length: number;
  expiry: number;
  start: number;
  currencyHeld: number;
  items: ZcCollateralToken[];
  payNow: number | null;
  quote: {
    pay: number | null;
    target: number | null;
    bps: number | null;
    done: boolean;
  };
  pending: boolean;
}
