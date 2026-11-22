import { Network } from "@fleet-sdk/common";
import { ZcApiError } from "./zc/errors";
import {
  DEFAULT_MAINNET_GRAPHQL_URL,
  DEFAULT_TESTNET_GRAPHQL_URL
} from "./zc/graphqlClient";
import { ZcGraphqlEngine, ZcWalletProvider } from "./zc/reads";
import { VERIFIED_ASSETS } from "@/maps/verifiedAssets";
import {
  ZcAskSummary,
  ZcAuctionLotSummary,
  ZcAuctionVaultSummary,
  ZcBondSummary,
  ZcCollateral,
  ZcCollateralToken,
  ZcCurves,
  ZcFillsResponse,
  ZcFillSummary,
  ZcInfoResponse,
  ZcMarket,
  ZcMatchesResponse,
  ZcOfferSummary,
  ZcOrderbook,
  ZcPagedResult,
  ZcRawCurvesResponse,
  ZcSearchHit,
  ZcSimulateResponse
} from "@/types/zc";
import { getNetworkType } from "@/utils/otherUtils";
import {
  DAY_BLOCKS,
  fromErg,
  fromMarket,
  fromRaw,
  LIT_TOKEN_ID,
  reasonText,
  SIGUSD_TOKEN_ID,
  toMarket
} from "@/utils/zcMath";

export { ZcApiError, DEFAULT_MAINNET_GRAPHQL_URL, DEFAULT_TESTNET_GRAPHQL_URL };
export type { ZcWalletProvider };

export type ZcDataSource = "graphql" | "lithos";

const DATA_SOURCE_KEY = "sigmafi.zc.dataSource";
const GRAPHQL_URL_KEY = "sigmafi.zc.graphqlUrl";
const BASE_URL_KEY = "sigmafi.zc.baseUrl";
const API_KEY_STORAGE = "sigmafi.zc.apiKey";

const VERIFIED_META_BY_ID = new Map(
  VERIFIED_ASSETS.map((a) => [a.tokenId.toLowerCase(), a.metadata])
);

export interface ZcTokenMeta {
  id: string;
  ticker?: string;
  name?: string;
  decimals?: number;
  verified?: boolean;
  kind?: string;
}

export function getDefaultZcGraphqlUrl(): string {
  const envUrl = import.meta.env.VITE_ERGO_GRAPHQL_URL;
  if (typeof envUrl === "string" && envUrl.trim()) return envUrl.trim();
  return getNetworkType() === Network.Mainnet
    ? DEFAULT_MAINNET_GRAPHQL_URL
    : DEFAULT_TESTNET_GRAPHQL_URL;
}

export function getZcDataSource(): ZcDataSource {
  try {
    const stored = localStorage.getItem(DATA_SOURCE_KEY);
    if (stored === "lithos" || stored === "graphql") return stored;
  } catch {
    // storage unavailable
  }
  return "graphql";
}

export function setZcDataSource(source: ZcDataSource): void {
  try {
    localStorage.setItem(DATA_SOURCE_KEY, source);
  } catch {
    // storage unavailable
  }
}

export function getZcGraphqlUrl(): string {
  try {
    const stored = localStorage.getItem(GRAPHQL_URL_KEY);
    if (stored !== null && stored.trim()) return stored.trim();
  } catch {
    // storage unavailable
  }
  return getDefaultZcGraphqlUrl();
}

export function setZcGraphqlUrl(url: string): void {
  const clean = url.trim();
  try {
    if (clean) localStorage.setItem(GRAPHQL_URL_KEY, clean);
    else localStorage.removeItem(GRAPHQL_URL_KEY);
  } catch {
    // storage unavailable
  }
  zcGraphqlEngine.setEndpoint(clean || getDefaultZcGraphqlUrl());
}

export function getZcBaseUrl(): string {
  try {
    const stored = localStorage.getItem(BASE_URL_KEY);
    if (stored !== null) return stored;
  } catch {
    // storage unavailable
  }
  return import.meta.env.VITE_LITHOS_API_URL || "";
}

export function setZcBaseUrl(url: string): void {
  const clean = url.trim().replace(/\/+$/, "");
  try {
    if (clean) localStorage.setItem(BASE_URL_KEY, clean);
    else localStorage.removeItem(BASE_URL_KEY);
  } catch {
    // storage unavailable
  }
}

export function getZcApiKey(): string {
  try {
    return sessionStorage.getItem(API_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

export function setZcApiKey(key: string): void {
  try {
    const clean = key.trim();
    if (clean) sessionStorage.setItem(API_KEY_STORAGE, clean);
    else sessionStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // storage unavailable
  }
}

export const zcGraphqlEngine = new ZcGraphqlEngine(getZcGraphqlUrl());

export function setZcWalletProvider(provider: ZcWalletProvider): void {
  zcGraphqlEngine.setWalletProvider(provider);
}

export function resetZcEngine(): void {
  zcGraphqlEngine.reset();
}

function useGraphql(): boolean {
  return getZcDataSource() === "graphql";
}

function buildQuery(params?: Record<string, string | number | boolean | undefined | null>): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function lithosRequest<T>(
  path: string,
  options?: {
    method?: "GET" | "POST";
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    auth?: boolean;
    allowNotModified?: boolean;
    signal?: AbortSignal;
  }
): Promise<T | { notModified: true }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options?.body !== undefined) headers["Content-Type"] = "application/json";
  if (options?.auth) {
    const key = getZcApiKey();
    if (!key) throw new ZcApiError("API key required.", 401);
    headers.api_key = key;
  }

  const url = `${getZcBaseUrl()}${path}${buildQuery(options?.query)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: options?.method || "GET",
      headers,
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options?.signal
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ZcApiError("Lithos client unreachable", 0, err);
  }

  if (res.status === 304 && options?.allowNotModified) {
    return { notModified: true };
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-json
  }

  if (!res.ok) {
    const record = (json || {}) as Record<string, string | undefined>;
    const msg = record.detail || record.reason || record.message || `HTTP ${res.status}`;
    throw new ZcApiError(msg, res.status, json);
  }

  return json as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adaptCollateral(col: any, tokenMap: Record<string, ZcTokenMeta> = {}): ZcCollateral {
  if (!col) return { erg: 0, usd: 0, tokens: [] };
  const erg = fromErg(col.nanoErg) ?? 0;
  let usd = 0;
  const tokens: ZcCollateralToken[] = [];
  for (const t of col.tokens || []) {
    const id = String(t.tokenId || "").toLowerCase();
    if (id === SIGUSD_TOKEN_ID) {
      usd += fromRaw(t.amount, 2) ?? 0;
    } else {
      const meta = tokenMap[id];
      const knownMeta = VERIFIED_META_BY_ID.get(id);
      const decimals = meta?.decimals ?? knownMeta?.decimals ?? (id === LIT_TOKEN_ID ? 9 : 0);
      tokens.push({
        id,
        ticker:
          meta?.ticker ||
          meta?.name ||
          knownMeta?.name ||
          (id === LIT_TOKEN_ID ? "LIT" : `${id.slice(0, 6)}…`),
        name: meta?.name || knownMeta?.name || (id === LIT_TOKEN_ID ? "Lithos" : null),
        decimals,
        amount: fromRaw(t.amount, decimals) ?? 0,
        rawAmount: String(t.amount ?? "0"),
        kind:
          meta?.kind === "wrapReceipt"
            ? "receipt"
            : meta?.kind === "provision"
              ? "provision"
              : meta?.kind === "bondUnit"
                ? "bond"
                : meta?.kind === "shares"
                  ? "shares"
                  : "token",
        verified: meta?.verified
      });
    }
  }
  return { erg, usd, tokens };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adaptBond(raw: any, tokenMap: Record<string, ZcTokenMeta> = {}): ZcBondSummary | null {
  if (!raw) return null;
  const market: ZcMarket = raw.market === "ERG" ? "ERG" : "SigUSD";
  return {
    id: raw.assetId || raw.id || "",
    market,
    principal: raw.principal != null ? fromMarket(raw.principal, market) : null,
    repayment: fromMarket(raw.repayment, market) ?? 0,
    start: raw.start ?? 0,
    maturity: raw.maturity ?? 0,
    collateral: adaptCollateral(raw.collateral, tokenMap),
    rule: raw.rule?.kind || "maturity",
    ratio: raw.rule?.ratioBps != null ? raw.rule.ratioBps / 100 : null,
    oracleAge: raw.rule?.oracleAge ?? 60,
    cov: raw.coverBps != null ? raw.coverBps / 100 : null,
    vault: null
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ratioToTotal(rat: any, unitsRaw: string | number | undefined, market: ZcMarket): number | null {
  if (!rat || rat.num == null || rat.den == null) return null;
  try {
    const den = BigInt(rat.den);
    if (den <= 0n) return null;
    const totalRaw = (BigInt(rat.num) * BigInt(unitsRaw || "1") + den - 1n) / den;
    return fromMarket(totalRaw.toString(), market);
  } catch {
    return null;
  }
}

export function adaptCurves(raw: ZcRawCurvesResponse, market: ZcMarket): ZcCurves {
  const totals = raw.totals || {
    asks: { matchable: 0, count: 0, cost: "0" },
    offers: { matchable: 0, count: 0, capital: "0" }
  };

  return {
    domain: raw.domain || [0, 262_800],
    bidLine: (raw.bidLine || []).map((p) => ({
      d: p.blocks,
      y: p.bps,
      id: p.offerId ?? null
    })),
    askLine: (raw.askLine || []).map((p) => ({
      d: p.blocks,
      y: p.bps,
      id: p.askId ?? null
    })),
    dots: (raw.askDots || []).map((p) => ({
      id: p.askId,
      d: p.blocks,
      y: p.bps,
      ok: p.ok !== false,
      pending: !!p.pending
    })),
    windows: (raw.windows || []).map((w) => ({
      id: w.askId,
      min: w.minBlocks,
      max: w.maxBlocks,
      cap: w.capBps,
      points: (w.points || []).map((pt) => ({ d: pt.blocks, y: pt.bps }))
    })),
    totals: {
      asks: {
        matchable: totals.asks?.matchable ?? 0,
        count: totals.asks?.count ?? 0,
        cost: fromMarket(totals.asks?.cost ?? "0", market) ?? 0
      },
      offers: {
        matchable: totals.offers?.matchable ?? 0,
        count: totals.offers?.count ?? 0,
        capital: fromMarket(totals.offers?.capital ?? "0", market) ?? 0
      }
    },
    searched: {
      bids: totals.searched?.offers ?? totals.offers?.count ?? 0,
      bidTotal: totals.offers?.count ?? 0,
      asks: totals.searched?.asks ?? totals.asks?.count ?? 0,
      askTotal: totals.asks?.count ?? 0
    }
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptAskSummary(raw: any, tokenMap: Record<string, ZcTokenMeta> = {}): ZcAskSummary {
  const market: ZcMarket = raw.market === "ERG" ? "ERG" : "SigUSD";
  const cost = raw.quote ? fromMarket(raw.quote.cost, market) ?? 0 : 0;
  const face = raw.quote ? fromMarket(raw.quote.face, market) ?? 0 : 0;
  const q = raw.quote
    ? {
        d: raw.quote.blocksLeft,
        maturity: raw.quote.maturity,
        cost,
        face,
        yieldBps: raw.quote.yieldBps,
        quotedYieldBps: raw.quote.quotedYieldBps ?? null,
        pct: face > 0 ? (cost / face) * 100 : 0,
        validFrom: raw.quote.validFrom,
        validThrough: raw.quote.validThrough
      }
    : null;

  const isOrder = raw.kind === "order";
  const status = raw.status || "ok";
  const reasons: string[] = Array.isArray(raw.reasons) ? raw.reasons : [];
  const checks = Array.isArray(raw.checks) ? raw.checks : [];

  if (isOrder) {
    const timing = raw.timing || {};
    const mode: "fixed" | "term" | "window" =
      timing.mode === "window" ? "window" : timing.mode === "term" ? "term" : "fixed";
    const curve = timing.curve || null;
    const guardRatio = raw.fillGuard?.ratioBps != null ? raw.fillGuard.ratioBps / 100 : null;
    const guard =
      guardRatio != null
        ? { ratio: guardRatio, age: raw.fillGuard?.oracleAge ?? raw.rule?.oracleAge ?? 60 }
        : null;

    return {
      id: raw.boxId,
      boxId: raw.boxId,
      chainId: raw.chainId || raw.boxId,
      txId: raw.txId || null,
      created: raw.created ?? 0,
      market,
      kind: "order",
      contract: raw.contract || null,
      pricing: raw.pricing || "fixed",
      mode,
      maturity: timing.maturity ?? null,
      duration: timing.duration ?? null,
      window:
        mode === "window" && timing.minDuration != null && timing.maxDuration != null
          ? { min: timing.minDuration, max: timing.maxDuration }
          : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      points: curve ? (curve.points || []).map((p: any) => ({ d: p.blocks, y: p.bps })) : null,
      cap: curve?.capBps ?? null,
      principal: raw.principal != null ? fromMarket(raw.principal, market) : null,
      repayment: raw.repayment != null ? fromMarket(raw.repayment, market) : null,
      price: null,
      floor: 0,
      tp: raw.yield
        ? { h0: raw.yield.h0, y0: raw.yield.y0, h1: raw.yield.h1, y1: raw.yield.y1 }
        : null,
      units: 1,
      minFill: 1,
      collateral: adaptCollateral(raw.collateral, tokenMap),
      bond: null,
      cov: raw.coverBps != null ? raw.coverBps / 100 : null,
      status,
      reasons,
      reason: reasonText(reasons, status, guardRatio),
      ok: status === "ok",
      pending: !!raw.pending,
      owner: !!raw.mine,
      quote: q,
      rule: raw.rule?.kind || "maturity",
      ratio: raw.rule?.ratioBps != null ? raw.rule.ratioBps / 100 : null,
      oracleAge: raw.rule?.oracleAge ?? 60,
      guard,
      expiry: raw.expiry ?? 0,
      expiryFee: raw.expiryFeeNanoErg != null ? fromErg(raw.expiryFeeNanoErg) ?? 0.005 : 0.005,
      checks
    };
  }

  const bond = adaptBond(raw.bond, tokenMap);
  if (bond && raw.shares?.type && raw.shares.type !== "plain") {
    bond.vault = raw.shares.type;
  }
  const guardRatio = raw.saleGuard?.ratioBps != null ? raw.saleGuard.ratioBps / 100 : null;
  const guard =
    guardRatio != null ? { ratio: guardRatio, age: raw.saleGuard?.oracleAge ?? 30 } : null;
  const fixedPrice =
    raw.pricing === "fixed"
      ? ratioToTotal(raw.price || raw.floor, raw.units, market) ?? q?.cost ?? null
      : null;
  const rawFloor = raw.pricing === "yield" ? ratioToTotal(raw.floor, raw.units, market) : null;
  const floor = rawFloor != null && rawFloor > 1e-6 ? rawFloor : 0;

  return {
    id: raw.boxId,
    boxId: raw.boxId,
    chainId: raw.chainId || raw.boxId,
    txId: raw.txId || null,
    created: raw.created ?? 0,
    market,
    kind: raw.kind === "shares" ? "shares" : "unit",
    contract: raw.contract || null,
    pricing: raw.pricing || "fixed",
    mode: "fixed",
    maturity: bond?.maturity ?? q?.maturity ?? null,
    duration: null,
    window: null,
    points: null,
    cap: null,
    principal: bond?.principal ?? null,
    repayment: bond?.repayment ?? q?.face ?? null,
    price: fixedPrice,
    floor,
    tp: raw.yield
      ? { h0: raw.yield.h0, y0: raw.yield.y0, h1: raw.yield.h1, y1: raw.yield.y1 }
      : null,
    units: Number(raw.units || 1),
    minFill: Number(raw.minFill || 1),
    collateral: bond?.collateral || { erg: 0, usd: 0, tokens: [] },
    bond,
    cov: raw.coverBps != null ? raw.coverBps / 100 : bond?.cov ?? null,
    status,
    reasons,
    reason: reasonText(reasons, status, guardRatio),
    ok: status === "ok",
    pending: !!raw.pending,
    owner: !!raw.mine,
    quote: q,
    rule: bond?.rule || raw.rule?.kind || "maturity",
    ratio: bond?.ratio ?? (raw.rule?.ratioBps != null ? raw.rule.ratioBps / 100 : null),
    oracleAge: bond?.oracleAge ?? 60,
    guard,
    expiry: raw.expiry ?? 0,
    expiryFee: 0.002,
    checks
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptOfferSummary(raw: any): ZcOfferSummary {
  const market: ZcMarket = raw.market === "ERG" ? "ERG" : "SigUSD";
  const status = raw.status || "ok";
  const reasons: string[] = Array.isArray(raw.reasons) ? raw.reasons : [];
  const capital = fromMarket(raw.capital, market) ?? 0;

  return {
    id: raw.boxId,
    boxId: raw.boxId,
    chainId: raw.chainId || raw.boxId,
    txId: raw.txId || null,
    created: raw.created ?? 0,
    market,
    capital,
    funded: raw.originalCapital != null ? fromMarket(raw.originalCapital, market) ?? capital : capital,
    boxErg: fromErg(raw.boxNanoErg),
    minYieldBps: raw.minYieldBps ?? 0,
    minBlocks: raw.minBlocks ?? 1,
    maxBlocks: raw.maxBlocks ?? 262_800,
    floor: raw.policy?.floorBps != null ? raw.policy.floorBps / 100 : 150,
    oracleAge: raw.policy?.oracleAge ?? 30,
    fee: raw.batcherFeeNanoErg != null ? fromErg(raw.batcherFeeNanoErg) ?? 0.005 : 0.005,
    reserve: raw.reserveNanoErg != null ? fromErg(raw.reserveNanoErg) ?? 0.05 : 0.05,
    rewardNow: raw.rewardNowNanoErg != null ? fromErg(raw.rewardNowNanoErg) : null,
    minPrice: raw.minPrice != null ? fromMarket(raw.minPrice, market) : null,
    expiry: raw.expiry ?? 0,
    delivery: raw.delivery?.kind || "unit",
    shares: raw.shareBounds
      ? { floor: raw.shareBounds.floorBps, expiry: raw.shareBounds.maxExpiry }
      : null,
    tokenBudget: raw.tokenBudget
      ? {
          originalCapital: fromMarket(raw.tokenBudget.originalCapital, market),
          totalErgBudget: fromErg(raw.tokenBudget.totalErgBudget),
          minFillBps: raw.tokenBudget.minFillBps ?? 100,
          rewardBudget: fromErg(raw.tokenBudget.rewardBudget)
        }
      : null,
    status,
    reasons,
    reason: reasonText(reasons, status),
    ok: status === "ok",
    pending: !!raw.pending,
    owner: !!raw.mine,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    points: (raw.curve || []).map((p: any) => ({ d: p.blocks, y: p.bps })),
    checks: Array.isArray(raw.checks) ? raw.checks : []
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptOrderbook(raw: any, market: ZcMarket, band: number | null, isRange: boolean): ZcOrderbook {
  const mapKind = (k: string): "order" | "unit" | "shares" =>
    k === "new" ? "order" : k === "shares" ? "shares" : "unit";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asks = (raw?.asks || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => ({
      id: r.boxId,
      kind: mapKind(r.kind),
      y: r.bps,
      size: fromMarket(r.size, market) ?? 0,
      d: r.blocks,
      window: !!r.window,
      ok: r.ok !== false,
      reason: reasonText(r.reason, r.ok === false ? "paused" : "ok")
    }))
    .sort((a: { y: number }, b: { y: number }) => (a.y ?? 0) - (b.y ?? 0));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bids = (raw?.bids || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => ({
      id: r.boxId,
      y: r.bps,
      size: fromMarket(r.size, market) ?? 0,
      range: (r.range || [raw?.range?.from ?? DAY_BLOCKS, raw?.range?.to ?? 262_800]) as [
        number,
        number
      ],
      ok: r.ok !== false,
      reason: reasonText(r.reason, r.ok === false ? "paused" : "ok")
    }))
    .sort((a: { y: number }, b: { y: number }) => (a.y ?? 0) - (b.y ?? 0));

  return {
    asks,
    bids,
    bestAsk: raw?.bestAskBps ?? null,
    bestBid: raw?.bestBidBps ?? null,
    spread: raw?.spreadBps ?? null,
    lo: raw?.range?.from ?? DAY_BLOCKS,
    hi: raw?.range?.to ?? 262_800,
    band,
    range: isRange
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptFillSummary(raw: any): ZcFillSummary {
  const market: ZcMarket = raw.market === "ERG" ? "ERG" : "SigUSD";
  return {
    id: raw.id,
    txId: raw.txId,
    height: raw.height,
    timestamp: raw.timestamp,
    market,
    kind: raw.kind || "new",
    via: raw.via || "wallet",
    offerId: raw.offerId ?? null,
    sourceId: raw.sourceId ?? null,
    bondId: raw.bondId ?? null,
    d: raw.blocksLeft,
    maturity: raw.maturity,
    cost: fromMarket(raw.cost, market) ?? 0,
    face: fromMarket(raw.face, market) ?? 0,
    yieldBps: raw.yieldBps,
    cov: raw.coverBps != null ? raw.coverBps / 100 : null
  };
}

export function buildWalletLendDraft(params: {
  market: ZcMarket;
  amount: number;
  to: number;
  coverage: number;
}): {
  type: "walletLend";
  market: ZcMarket;
  amount: string;
  to: number;
  coverage: number;
} | null {
  const raw = toMarket(params.amount, params.market, "floor");
  if (!raw || BigInt(raw) <= 0n) return null;
  return {
    type: "walletLend",
    market: params.market,
    amount: raw,
    to: Math.round(params.to),
    coverage: Math.round(params.coverage * 100)
  };
}

export const zcApi = {
  getInfo(ifRevision?: number, signal?: AbortSignal) {
    if (useGraphql()) {
      return zcGraphqlEngine.getInfo(ifRevision, signal);
    }
    return lithosRequest<ZcInfoResponse>("/sigmafi/zc/info", {
      query: { ifRevision },
      allowNotModified: ifRevision != null,
      signal
    });
  },

  async getCurves(
    market: ZcMarket,
    params?: { coverage?: number; kind?: string; matchable?: boolean; grid?: boolean },
    signal?: AbortSignal
  ): Promise<ZcCurves> {
    const res = useGraphql()
      ? await zcGraphqlEngine.getCurvesRaw(market, params, signal)
      : ((await lithosRequest<ZcRawCurvesResponse>(`/sigmafi/zc/markets/${market}/curves`, {
          query: params,
          signal
        })) as ZcRawCurvesResponse);
    return adaptCurves(res, market);
  },

  async getOrderbook(
    market: ZcMarket,
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
  ): Promise<ZcOrderbook> {
    const res = useGraphql()
      ? await zcGraphqlEngine.getOrderbookRaw(market, params, signal)
      : await lithosRequest<unknown>(`/sigmafi/zc/markets/${market}/orderbook`, {
          query: params,
          signal
        });
    return adaptOrderbook(res, market, params?.band ?? null, params?.to != null);
  },

  async listAsksPage(
    market: ZcMarket,
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
    tokenMap?: Record<string, ZcTokenMeta>,
    signal?: AbortSignal
  ): Promise<ZcPagedResult<ZcAskSummary>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (useGraphql()
      ? await zcGraphqlEngine.listAsksRaw(market, params, signal)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await lithosRequest<any>(`/sigmafi/zc/markets/${market}/asks`, {
          query: params,
          signal
        })) as { items?: unknown[]; total?: number; next?: string | null; pendingLeftOut?: number };
    const list = res?.items || [];
    return {
      items: list.map((x) => adaptAskSummary(x, tokenMap)),
      total: res?.total ?? list.length,
      next: res?.next ?? null,
      pendingLeftOut: res?.pendingLeftOut ?? 0
    };
  },

  async listAsks(
    market: ZcMarket,
    params?: {
      coverage?: number;
      kind?: string;
      matchable?: boolean;
      grid?: boolean;
      from?: number;
      to?: number;
      sort?: string;
      limit?: number;
    },
    signal?: AbortSignal
  ): Promise<ZcAskSummary[]> {
    const page = await this.listAsksPage(market, params, undefined, signal);
    return page.items;
  },

  async listOffersPage(
    market: ZcMarket,
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
  ): Promise<ZcPagedResult<ZcOfferSummary>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (useGraphql()
      ? await zcGraphqlEngine.listOffersRaw(market, params, signal)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await lithosRequest<any>(`/sigmafi/zc/markets/${market}/offers`, {
          query: params,
          signal
        })) as { items?: unknown[]; total?: number; next?: string | null; pendingLeftOut?: number };
    const list = res?.items || [];
    return {
      items: list.map(adaptOfferSummary),
      total: res?.total ?? list.length,
      next: res?.next ?? null,
      pendingLeftOut: res?.pendingLeftOut ?? 0
    };
  },

  async listOffers(
    market: ZcMarket,
    params?: {
      coverage?: number;
      kind?: string;
      matchable?: boolean;
      grid?: boolean;
      from?: number;
      to?: number;
      sort?: string;
      limit?: number;
    },
    signal?: AbortSignal
  ): Promise<ZcOfferSummary[]> {
    const page = await this.listOffersPage(market, params, signal);
    return page.items;
  },

  async listFillsResult(
    market: ZcMarket,
    params?: { fromHeight?: number; kind?: string; via?: string; limit?: number },
    signal?: AbortSignal
  ): Promise<ZcFillsResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (useGraphql()
      ? await zcGraphqlEngine.listFillsRaw(market, params, signal)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await lithosRequest<any>(`/sigmafi/zc/markets/${market}/fills`, {
          query: params,
          signal
        })) as { items?: unknown[]; status?: string; indexedTo?: number | null };
    return {
      items: (res?.items || []).map(adaptFillSummary),
      status: res?.status || "ready",
      indexedTo: res?.indexedTo ?? null
    };
  },

  async listFills(
    market: ZcMarket,
    params?: { fromHeight?: number; kind?: string; limit?: number },
    signal?: AbortSignal
  ): Promise<ZcFillSummary[]> {
    const res = await this.listFillsResult(market, params, signal);
    return res.items;
  },

  async simulate(draft: Record<string, unknown>, signal?: AbortSignal): Promise<ZcSimulateResponse> {
    if (useGraphql()) {
      return (await zcGraphqlEngine.simulateRaw(draft, signal)) as unknown as ZcSimulateResponse;
    }
    return (await lithosRequest<ZcSimulateResponse>("/sigmafi/zc/simulate", {
      method: "POST",
      body: { draft },
      signal
    })) as ZcSimulateResponse;
  },

  async getMatches(id: string, signal?: AbortSignal): Promise<ZcMatchesResponse> {
    if (useGraphql()) {
      return (await zcGraphqlEngine.getMatchesRaw(id, signal)) as unknown as ZcMatchesResponse;
    }
    return (await lithosRequest<ZcMatchesResponse>(`/sigmafi/zc/matches/${encodeURIComponent(id)}`, {
      signal
    })) as ZcMatchesResponse;
  },

  async lookup(
    id: string,
    tokenMap?: Record<string, ZcTokenMeta>,
    signal?: AbortSignal
  ): Promise<{
    type: string;
    ask?: ZcAskSummary;
    offer?: ZcOfferSummary;
    current?: boolean;
    spentBy?: string;
  } | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (useGraphql()
      ? await zcGraphqlEngine.lookupRaw(id, signal)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await lithosRequest<any>(`/sigmafi/zc/lookup/${encodeURIComponent(id)}`, {
          signal
        })) as Record<string, unknown>;
    if (!raw) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = (raw.record as any)?.current || raw.record;
    const type = String(raw.type || "");
    if ((type === "order" || type === "ask") && rec?.market) {
      return {
        type,
        ask: adaptAskSummary(rec, tokenMap),
        current: Boolean(raw.current),
        spentBy: raw.spentBy ? String(raw.spentBy) : undefined
      };
    }
    if (type === "offer" && rec?.market) {
      return {
        type: "offer",
        offer: adaptOfferSummary(rec),
        current: Boolean(raw.current),
        spentBy: raw.spentBy ? String(raw.spentBy) : undefined
      };
    }
    return {
      type,
      current: Boolean(raw.current),
      spentBy: raw.spentBy ? String(raw.spentBy) : undefined
    };
  },

  async search(q: string, signal?: AbortSignal): Promise<ZcSearchHit[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (useGraphql()
      ? await zcGraphqlEngine.searchRaw(q, signal)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await lithosRequest<{ hits?: any[] }>("/sigmafi/zc/search", {
          query: { q },
          signal
        })) as { hits?: ZcSearchHit[] };
    return res?.hits || [];
  },

  async lookupAssets(
    tokenIds: string[],
    signal?: AbortSignal
  ): Promise<Record<string, ZcTokenMeta>> {
    if (!tokenIds.length) return {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (useGraphql()
      ? await zcGraphqlEngine.lookupAssetsRaw(tokenIds, signal)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await lithosRequest<{ tokens?: Record<string, any> }>("/sigmafi/zc/assets", {
          method: "POST",
          body: { tokenIds },
          signal
        })) as { tokens?: Record<string, ZcTokenMeta> };

    const out: Record<string, ZcTokenMeta> = {};
    for (const [id, meta] of Object.entries(res?.tokens || {})) {
      const low = id.toLowerCase();
      const known = VERIFIED_META_BY_ID.get(low);
      out[low] = {
        ...meta,
        id: low,
        name: meta.name || known?.name,
        ticker: meta.ticker || meta.name || known?.name,
        decimals: meta.decimals ?? known?.decimals
      };
    }
    return out;
  },

  async listAuctions(signal?: AbortSignal): Promise<{
    lots: ZcAuctionLotSummary[];
    vaults: ZcAuctionVaultSummary[];
  }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (useGraphql()
      ? await zcGraphqlEngine.listAuctionsRaw(undefined, signal)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await lithosRequest<{ lots?: any[]; vaults?: any[] }>("/sigmafi/zc/auctions", {
          signal
        })) as { lots?: unknown[]; vaults?: unknown[] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lots = (res?.lots || []).map((l: any): ZcAuctionLotSummary => {
      const m: ZcMarket = l.market === "ERG" ? "ERG" : "SigUSD";
      return {
        boxId: l.boxId,
        market: m,
        opening: fromMarket(l.opening, m) ?? 0,
        floor: fromMarket(l.floor, m) ?? 0,
        priceNow: l.priceNow != null ? fromMarket(l.priceNow, m) : null,
        phase: l.phase || "falling",
        itemCount: (l.items || []).length,
        pending: !!l.pending
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaults = (res?.vaults || []).map((v: any): ZcAuctionVaultSummary => {
      const m: ZcMarket = v.market === "ERG" ? "ERG" : "SigUSD";
      const excess = v.state === 4;
      const payRaw = excess ? v.quote?.priceRaw : v.quote?.payRaw;
      return {
        boxId: v.boxId,
        bondId: v.bondId,
        market: m,
        vaultType: v.type || "selective",
        state: v.state ?? 1,
        repayment: fromMarket(v.repayment, m) ?? 0,
        payNow: payRaw != null ? fromMarket(payRaw, m) : null,
        pending: !!v.pending
      };
    });

    return { lots, vaults };
  },

  async getPortfolio(signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (useGraphql()) {
      return zcGraphqlEngine.getPortfolioRaw(signal);
    }
    return (await lithosRequest<Record<string, unknown>>("/sigmafi/zc/portfolio", {
      auth: true,
      signal
    })) as Record<string, unknown>;
  }
};
