import { Network } from "@fleet-sdk/common";
import { ZcApiError } from "./zc/errors";
import {
  DEFAULT_MAINNET_EXPLORER_URL,
  DEFAULT_TESTNET_EXPLORER_URL,
  OFFICIAL_MAINNET_EXPLORER_URL
} from "./zc/explorerClient";
import {
  DEFAULT_MAINNET_GRAPHQL_URL,
  DEFAULT_TESTNET_GRAPHQL_URL,
  SIGMASPACE_GRAPHQL_URL
} from "./zc/graphqlClient";
import { ZcGraphqlEngine, ZcWalletProvider } from "./zc/reads";
import { VERIFIED_ASSETS } from "@/maps/verifiedAssets";
import {
  ZcActionAvailability,
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
  ZcLookupResult,
  ZcMarket,
  ZcMatchesResponse,
  ZcOfferSummary,
  ZcOrderbook,
  ZcPagedResult,
  ZcPortfolioMintRequest,
  ZcPortfolioPosition,
  ZcPortfolioWrap,
  ZcRawCurvesResponse,
  ZcSearchHit,
  ZcSimulateResponse,
  ZcWalletToken,
  ZcWrappedTokenInfo
} from "@/types/zc";
import { getNetworkType } from "@/utils/otherUtils";
import {
  DAY_BLOCKS,
  fromErg,
  fromMarket,
  fromRaw,
  isHex64,
  LIT_TOKEN_ID,
  reasonText,
  SIGUSD_TOKEN_ID,
  toMarket,
  toRaw
} from "@/utils/zcMath";

export {
  ZcApiError,
  DEFAULT_MAINNET_EXPLORER_URL,
  OFFICIAL_MAINNET_EXPLORER_URL,
  DEFAULT_TESTNET_EXPLORER_URL,
  DEFAULT_MAINNET_GRAPHQL_URL,
  SIGMASPACE_GRAPHQL_URL,
  DEFAULT_TESTNET_GRAPHQL_URL
};
export type { ZcWalletProvider };

export type ZcDataSource = "explorer" | "graphql" | "lithos";

const DATA_SOURCE_KEY = "sigmafi.zc.dataSource";
const EXPLORER_URL_KEY = "sigmafi.zc.explorerUrl";
const GRAPHQL_URL_KEY = "sigmafi.zc.graphqlUrl";
const BASE_URL_KEY = "sigmafi.zc.baseUrl";
const API_KEY_STORAGE = "sigmafi.zc.apiKey";

const VERIFIED_META_BY_ID = new Map(
  VERIFIED_ASSETS.map((a) => [a.tokenId.toLowerCase(), a.metadata])
);

export interface ZcTokenMeta {
  id: string;
  ticker?: string;
  name?: string | null;
  description?: string | null;
  decimals?: number | null;
  verified?: boolean;
  kind?: string;
  bondId?: string | null;
  shares?: { bondId?: string | null } | null;
  wrap?: {
    receiptId?: string;
    token?: string;
    amount?: string;
    vaultBoxId?: string;
    state?: string;
    refreshFrom?: number | null;
    innerToken?: {
      id?: string;
      name?: string | null;
      decimals?: number | null;
      description?: string | null;
      kind?: string;
      bondId?: string | null;
    } | null;
  } | null;
}

export function getDefaultZcExplorerUrl(): string {
  const envUrl = import.meta.env.VITE_ERGO_EXPLORER_URL;
  if (typeof envUrl === "string" && envUrl.trim()) return envUrl.trim();
  return getNetworkType() === Network.Mainnet
    ? DEFAULT_MAINNET_EXPLORER_URL
    : DEFAULT_TESTNET_EXPLORER_URL;
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
    if (stored === "explorer" || stored === "graphql" || stored === "lithos") return stored;
  } catch {
    // storage unavailable
  }
  return "explorer";
}

export function setZcDataSource(source: ZcDataSource): void {
  try {
    localStorage.setItem(DATA_SOURCE_KEY, source);
  } catch {
    // storage unavailable
  }
  if (source === "explorer") {
    zcGraphqlEngine.setTransport("explorer", getZcExplorerUrl());
  } else if (source === "graphql") {
    zcGraphqlEngine.setTransport("graphql", getZcGraphqlUrl());
  }
}

export function getZcExplorerUrl(): string {
  try {
    const stored = localStorage.getItem(EXPLORER_URL_KEY);
    if (stored !== null && stored.trim()) return stored.trim();
  } catch {
    // storage unavailable
  }
  return getDefaultZcExplorerUrl();
}

export function setZcExplorerUrl(url: string): void {
  const clean = url.trim();
  try {
    if (clean) localStorage.setItem(EXPLORER_URL_KEY, clean);
    else localStorage.removeItem(EXPLORER_URL_KEY);
  } catch {
    // storage unavailable
  }
  if (getZcDataSource() === "explorer") {
    zcGraphqlEngine.setTransport("explorer", clean || getDefaultZcExplorerUrl());
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
  if (getZcDataSource() === "graphql") {
    zcGraphqlEngine.setTransport("graphql", clean || getDefaultZcGraphqlUrl());
  }
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

const initialSource = getZcDataSource();
export const zcGraphqlEngine = new ZcGraphqlEngine(
  initialSource === "graphql" ? getZcGraphqlUrl() : getZcExplorerUrl(),
  initialSource === "graphql" ? "graphql" : "explorer"
);

export function setZcWalletProvider(provider: ZcWalletProvider): void {
  zcGraphqlEngine.setWalletProvider(provider);
}

let demoLookupProvider:
  | (() => {
      lookupById: Map<string, ZcLookupResult>;
      matchesById: Map<string, ZcMatchesResponse>;
    } | null)
  | null = null;

export function setZcDemoProvider(
  provider:
    | (() => {
        lookupById: Map<string, ZcLookupResult>;
        matchesById: Map<string, ZcMatchesResponse>;
      } | null)
    | null
): void {
  demoLookupProvider = provider;
}

export function resetZcEngine(): void {
  zcGraphqlEngine.reset();
}

function useGraphql(): boolean {
  return getZcDataSource() !== "lithos";
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

function buildWrappedInfo(
  meta: ZcTokenMeta | undefined,
  tokenMap: Record<string, ZcTokenMeta>
): ZcWrappedTokenInfo | null {
  const w = meta?.wrap;
  const innerId = String(w?.innerToken?.id || w?.token || "").toLowerCase();
  if (!innerId) return null;
  const innerMeta = tokenMap[innerId];
  const known = VERIFIED_META_BY_ID.get(innerId);
  const decimals =
    w?.innerToken?.decimals ??
    innerMeta?.decimals ??
    known?.decimals ??
    (innerId === SIGUSD_TOKEN_ID ? 2 : innerId === LIT_TOKEN_ID ? 9 : 0);
  const name = w?.innerToken?.name || innerMeta?.name || known?.name || null;
  const ticker =
    name ||
    innerMeta?.ticker ||
    (innerId === SIGUSD_TOKEN_ID
      ? "SigUSD"
      : innerId === LIT_TOKEN_ID
        ? "LIT"
        : `${innerId.slice(0, 8)}…`);
  const rawAmt = String(w?.amount ?? "1");
  const rawKind = w?.innerToken?.kind || innerMeta?.kind;
  const kind: ZcWrappedTokenInfo["kind"] =
    rawKind === "bond" || rawKind === "bondUnit"
      ? "bond"
      : rawKind === "shares"
        ? "shares"
        : rawKind === "provision"
          ? "provision"
          : "token";
  return {
    id: innerId,
    ticker,
    name,
    description: w?.innerToken?.description ?? innerMeta?.description ?? null,
    decimals,
    amount: fromRaw(rawAmt, decimals) ?? 1,
    rawAmount: rawAmt,
    kind,
    bondId: w?.innerToken?.bondId ?? innerMeta?.bondId ?? null,
    vaultBoxId: w?.vaultBoxId ?? null,
    refreshFrom: typeof w?.refreshFrom === "number" ? w.refreshFrom : null,
    state: w?.state ?? "wrapped"
  };
}

function buildCollateralToken(
  idRaw: string,
  rawAmount: unknown,
  rawKind: string | undefined,
  tokenMap: Record<string, ZcTokenMeta>
): ZcCollateralToken {
  const id = String(idRaw || "").toLowerCase();
  const meta = tokenMap[id];
  const knownMeta = VERIFIED_META_BY_ID.get(id);
  const resolvedKind = rawKind || meta?.kind;
  const kind: ZcCollateralToken["kind"] =
    resolvedKind === "wrapReceipt" || resolvedKind === "receipt"
      ? "receipt"
      : resolvedKind === "provision"
        ? "provision"
        : resolvedKind === "bondUnit" || resolvedKind === "bond"
          ? "bond"
          : resolvedKind === "shares"
            ? "shares"
            : "token";
  const decimals =
    kind === "receipt" || kind === "bond"
      ? 0
      : kind === "shares"
        ? 6
        : meta?.decimals ?? knownMeta?.decimals ?? (id === SIGUSD_TOKEN_ID ? 2 : id === LIT_TOKEN_ID ? 9 : 0);
  const wraps = kind === "receipt" ? buildWrappedInfo(meta, tokenMap) : null;
  const bondId =
    kind === "bond"
      ? meta?.bondId || id
      : kind === "shares"
        ? meta?.bondId || meta?.shares?.bondId || id
        : null;
  const ticker =
    meta?.ticker ||
    meta?.name ||
    knownMeta?.name ||
    (id === SIGUSD_TOKEN_ID
      ? "SigUSD"
      : id === LIT_TOKEN_ID
        ? "LIT"
        : kind === "receipt"
          ? `ZCS-Wrap-${id.slice(0, 6)}`
          : kind === "bond"
            ? `Bond ${id.slice(0, 6)}…`
            : kind === "shares"
              ? `Shares ${id.slice(0, 6)}…`
              : `${id.slice(0, 6)}…`);

  return {
    id,
    ticker,
    name: meta?.name || knownMeta?.name || (id === LIT_TOKEN_ID ? "Lithos" : null),
    description: meta?.description ?? null,
    decimals,
    amount: fromRaw(String(rawAmount ?? "0"), decimals) ?? Number(rawAmount || 0),
    rawAmount: String(rawAmount ?? "0"),
    kind,
    bondId,
    wraps,
    verified: kind === "receipt" || kind === "bond" || kind === "shares" || !!meta?.verified || !!knownMeta
  };
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
      tokens.push(buildCollateralToken(id, t.amount, t.kind, tokenMap));
    }
  }
  return { erg, usd, tokens };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptBond(raw: any, tokenMap: Record<string, ZcTokenMeta> = {}): ZcBondSummary | null {
  if (!raw) return null;
  const inferredMarket: ZcMarket =
    raw.market === "ERG"
      ? "ERG"
      : raw.market === "SigUSD"
        ? "SigUSD"
        : (() => {
            const s = raw.settlement;
            if (!s) return "SigUSD";
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((s.tokens || []).some((t: any) => String(t.tokenId || "").toLowerCase() === SIGUSD_TOKEN_ID)) {
              return "SigUSD";
            }
            if (s.nanoErg && BigInt(s.nanoErg) > 10_000_000n) return "ERG";
            return "SigUSD";
          })();

  const settlement: Record<string, number> | null = raw.settlement
    ? (() => {
        const out: Record<string, number> = {};
        const ergVal = fromErg(raw.settlement.nanoErg);
        if (ergVal && ergVal > 0) out.ERG = ergVal;
        for (const t of raw.settlement.tokens || []) {
          const id = String(t.tokenId || "").toLowerCase();
          if (id === SIGUSD_TOKEN_ID) {
            out.SigUSD = (out.SigUSD || 0) + (fromRaw(t.amount, 2) || 0);
          } else {
            const meta = tokenMap[id];
            const known = VERIFIED_META_BY_ID.get(id);
            const dec = meta?.decimals ?? known?.decimals ?? 0;
            const label = meta?.ticker || meta?.name || known?.name || `${id.slice(0, 6)}…`;
            out[label] = (out[label] || 0) + (fromRaw(t.amount, dec) || 0);
          }
        }
        return out;
      })()
    : null;

  return {
    id: raw.assetId || raw.id || "",
    stateBoxId: raw.stateBoxId ?? null,
    created: raw.stateCreated ?? raw.start ?? 0,
    state: raw.state || "live",
    market: inferredMarket,
    borrowerHash: raw.borrowerHash ?? null,
    principal: raw.principal != null ? fromMarket(raw.principal, inferredMarket) : null,
    repayment: fromMarket(raw.repayment, inferredMarket) ?? 0,
    start: raw.start ?? 0,
    maturity: raw.maturity ?? 0,
    timing: raw.timing || "fixed",
    reserve: raw.reserveNanoErg != null ? fromErg(raw.reserveNanoErg) ?? 0.05 : 0.05,
    collateral: adaptCollateral(raw.collateral, tokenMap),
    rule: raw.rule?.kind || "maturity",
    ratio: raw.rule?.ratioBps != null ? raw.rule.ratioBps / 100 : null,
    oracleAge: raw.rule?.oracleAge ?? 60,
    cov: raw.coverBps != null ? raw.coverBps / 100 : null,
    recollateralizeFrom: raw.recollateralizeFrom ?? null,
    refreshFrom: raw.refreshFrom ?? null,
    settlement,
    vault: null,
    pending: !!raw.pending,
    mine: !!raw.mine,
    borrowedByMe: !!(raw.borrowedByMe ?? raw.mine),
    checks: Array.isArray(raw.checks) ? raw.checks : []
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
      kind:
        p.kind === "new"
          ? ("order" as const)
          : p.kind === "shares"
            ? ("shares" as const)
            : p.kind
              ? ("unit" as const)
              : undefined,
      d: p.blocks,
      y: p.bps,
      ok: p.ok !== false,
      pending: !!p.pending,
      borrowedByMe: !!p.borrowedByMe
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
      borrowedByMe: !!raw.borrowedByMe,
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
    shareCount: raw.shares?.shareCount != null ? Number(raw.shares.shareCount) : undefined,
    collateral: bond?.collateral || { erg: 0, usd: 0, tokens: [] },
    bond,
    cov: raw.coverBps != null ? raw.coverBps / 100 : bond?.cov ?? null,
    status,
    reasons,
    reason: reasonText(reasons, status, guardRatio),
    ok: status === "ok",
    pending: !!raw.pending,
    owner: !!raw.mine,
    borrowedByMe: !!raw.borrowedByMe || !!raw.bond?.borrowedByMe,
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
      borrowedByMe: !!r.borrowedByMe,
      reason: reasonText(r.reason, r.ok === false ? "paused" : "ok"),
      bidAtD: r.bidAtBps ?? null,
      vsBid: r.spreadBps ?? null
    }))
    .sort((a: { y: number }, b: { y: number }) => (a.y ?? 0) - (b.y ?? 0));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bids = (raw?.bids || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => ({
      id: r.boxId,
      y: r.bps,
      yMin: r.minBps ?? r.bps,
      yMax: r.maxBps ?? r.bps,
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
    anchorBlocks: raw?.anchorBlocks ?? null,
    anchorBid: raw?.anchorBidBps ?? null,
    spread: raw?.spreadBps ?? null,
    spreadD: raw?.spreadBlocks ?? null,
    spreadBid: raw?.spreadBidBps ?? null,
    spreadAsk: raw?.spreadAskBps ?? null,
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

export function toErgRaw(
  value: number | string | null | undefined,
  round: "floor" | "ceil" | "round" = "floor"
): string | null {
  return toRaw(value, 9, round);
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

export function buildOrderBody(params: {
  market: ZcMarket;
  pricing: "fixed" | "yield" | "window";
  principal: number | null;
  repayment: number | null;
  mode: "fixed" | "term" | "window";
  maturity?: number | null;
  exact?: boolean;
  duration?: number | null;
  window?: { min: number; max: number } | null;
  tp?: { h0: number; y0: number; h1: number; y1: number } | null;
  points?: { d: number; y: number }[] | null;
  cap?: number | null;
  collateral: { erg: number; usd: number; tokens: { id: string; amount: number; decimals?: number }[] };
  rule: "oracle" | "maturity";
  ratio: number;
  oracleAge?: number;
  guard?: number | null;
  expiry?: number | null;
  expiryFee?: number | null;
}): Record<string, unknown> | null {
  const principalRaw = toMarket(params.principal, params.market, "floor");
  const repaymentRaw = toMarket(params.repayment, params.market, "ceil");
  if (!principalRaw || !repaymentRaw || BigInt(principalRaw) <= 0n || BigInt(repaymentRaw) <= 0n) {
    return null;
  }

  let timing: Record<string, unknown>;
  if (params.pricing === "window" || params.mode === "window") {
    if (!params.window?.min || !params.window?.max) return null;
    timing = {
      mode: "window",
      minDuration: Math.round(params.window.min),
      maxDuration: Math.round(params.window.max)
    };
  } else if (params.mode === "term") {
    if (!params.duration) return null;
    timing = { mode: "term", duration: Math.round(params.duration) };
  } else {
    if (!params.maturity) return null;
    timing = { mode: "fixed", maturity: Math.round(params.maturity), exact: !!params.exact };
  }

  const ergCol = Math.max(0.001, params.collateral?.erg || 0);
  const colTokens: { tokenId: string; amount: string }[] = [];
  if (params.collateral?.usd > 0) {
    const rawUsd = toRaw(params.collateral.usd, 2, "floor");
    if (rawUsd && BigInt(rawUsd) > 0n) {
      colTokens.push({ tokenId: SIGUSD_TOKEN_ID, amount: rawUsd });
    }
  }
  for (const t of params.collateral?.tokens || []) {
    if (t.amount > 0 && isHex64(t.id)) {
      const amtRaw = toRaw(t.amount, t.decimals ?? 0, "floor");
      if (amtRaw && BigInt(amtRaw) > 0n) {
        colTokens.push({ tokenId: t.id.toLowerCase(), amount: amtRaw });
      }
    }
  }

  const body: Record<string, unknown> = {
    market: params.market,
    pricing: params.pricing,
    principal: principalRaw,
    repayment: repaymentRaw,
    timing,
    collateral: {
      nanoErg: toErgRaw(ergCol, "ceil") || "1000000",
      tokens: colTokens
    },
    rule:
      params.rule === "oracle"
        ? {
            kind: "oracle",
            ratioBps: Math.round((params.ratio || 150) * 100),
            oracleAge: Math.round(params.oracleAge || 60)
          }
        : { kind: "maturity" }
  };

  if (params.rule === "oracle") {
    body.fillGuard = params.guard != null ? { ratioBps: Math.round(params.guard * 100) } : null;
  }
  if (params.pricing === "yield" && params.tp) {
    body.yield = {
      startBps: Math.max(0, Math.round(params.tp.y0)),
      endBps: Math.max(0, Math.round(params.tp.y1)),
      endHeight: Math.round(params.tp.h1)
    };
  }
  if (params.pricing === "window") {
    body.curve = {
      capBps: Math.max(0, Math.round(params.cap || 0)),
      points: (params.points || []).map((p) => ({
        blocks: Math.round(p.d),
        bps: Math.max(0, Math.round(p.y))
      }))
    };
  }
  if (params.expiry != null) body.expiry = Math.round(params.expiry);
  if (params.expiryFee != null) body.expiryFeeNanoErg = toErgRaw(params.expiryFee, "ceil");
  return body;
}

export function buildOfferBody(params: {
  market: ZcMarket;
  capital: number | null;
  minYield: number;
  points: { d: number; y: number }[];
  minBlocks: number;
  maxBlocks: number;
  floor: number;
  oracleAge?: number;
  expiry?: number | null;
  reserve?: number | null;
  fee?: number | null;
  tokenBudget?: {
    refundFee?: number;
    ergFunding?: number;
    minFillBps?: number;
    rewardBudget?: number;
  };
  shares?: { floor: number; expiry: number } | null;
  delivery?: "unit" | "selective" | "dutch";
  deliveryAuction?: {
    opening?: number;
    floor?: number;
    length?: number;
    expiry?: number;
    mintFee?: number;
    pullFee?: number;
  };
}): Record<string, unknown> | null {
  const capRaw = toMarket(params.capital, params.market, "floor");
  if (!capRaw || BigInt(capRaw) <= 0n) return null;

  const body: Record<string, unknown> = {
    market: params.market,
    capital: capRaw,
    minYieldBps: Math.max(0, Math.round(params.minYield || 0)),
    curve: (params.points || []).map((p) => ({
      blocks: Math.round(p.d),
      bps: Math.max(0, Math.round(p.y))
    })),
    minBlocks: Math.max(1, Math.round(params.minBlocks || 1)),
    maxBlocks: Math.max(1, Math.round(params.maxBlocks || 262_800)),
    floorBps: Math.round((params.floor || 150) * 100),
    oracleAge: Math.round(params.oracleAge || 30),
    expiry: params.expiry != null ? Math.round(params.expiry) : undefined,
    reserveNanoErg: params.reserve != null ? toErgRaw(params.reserve, "ceil") : undefined,
    shareBounds: params.shares
      ? { floorBps: Math.round(params.shares.floor), maxExpiry: Math.round(params.shares.expiry) }
      : null
  };

  if (params.market === "ERG") {
    body.erg = { batcherFeeNanoErg: toErgRaw(params.fee ?? 0.005, "ceil") };
  } else {
    const t = params.tokenBudget || {};
    body.token = {
      refundFeeNanoErg: toErgRaw(t.refundFee ?? params.fee ?? 0.005, "ceil"),
      ergFundingNanoErg: toErgRaw(t.ergFunding ?? 0.5, "ceil"),
      minFillBps: Math.round(t.minFillBps ?? 100),
      ...(t.rewardBudget != null ? { rewardBudgetNanoErg: toErgRaw(t.rewardBudget, "ceil") } : {})
    };
  }

  if (params.delivery === "selective" || params.delivery === "dutch") {
    const a = params.deliveryAuction || {};
    body.delivery = {
      kind: params.delivery,
      openingBps: Math.round((a.opening ?? 200) * 100),
      floorBps: Math.round((a.floor ?? 90) * 100),
      length: Math.round(a.length ?? 720),
      expiry: Math.round(a.expiry ?? 2160),
      mintFeeNanoErg: toErgRaw(a.mintFee ?? 0.005, "ceil"),
      pullFeeNanoErg: toErgRaw(a.pullFee ?? 0.005, "ceil")
    };
  } else {
    body.delivery = { kind: "unit" };
  }
  return body;
}

export function buildAskBody(params: {
  tokenId: string;
  market: ZcMarket;
  units: number;
  pricing: "fixed" | "yield";
  price?: number | null;
  floor?: number | null;
  tp?: { h0: number; y0: number; h1: number; y1: number } | null;
  guard?: { ratio: number; age?: number } | null;
  minFill?: number;
  expiry?: number;
}): Record<string, unknown> | null {
  if (!isHex64(params.tokenId) || !params.units || params.units < 1) return null;
  const pricingObj =
    params.pricing === "fixed"
      ? { kind: "fixed", price: toMarket(params.price, params.market, "ceil") }
      : {
          kind: "yield",
          startBps: Math.max(0, Math.round(params.tp?.y0 ?? 0)),
          endBps: Math.max(0, Math.round(params.tp?.y1 ?? params.tp?.y0 ?? 0)),
          endHeight: Math.round(params.tp?.h1 ?? params.expiry ?? 0),
          floor: params.floor && params.floor > 0 ? toMarket(params.floor, params.market, "ceil") : "0"
        };
  if (
    params.pricing === "fixed" &&
    (!("price" in pricingObj) || !pricingObj.price || BigInt(pricingObj.price) <= 0n)
  ) {
    return null;
  }
  return {
    tokenId: params.tokenId.toLowerCase(),
    units: String(Math.round(params.units)),
    pricing: pricingObj,
    saleGuard: params.guard
      ? {
          ratioBps: Math.round(params.guard.ratio * 100),
          oracleAge: Math.round(params.guard.age ?? 30)
        }
      : null,
    minFill: params.minFill != null ? String(Math.max(1, Math.round(params.minFill))) : undefined,
    expiry: params.expiry != null ? Math.round(params.expiry) : undefined
  };
}

export function buildLotBody(params: {
  market: ZcMarket;
  items: { id: string; amount: number; decimals?: number }[];
  erg?: number | null;
  opening: number | null;
  floor: number | null;
  start?: number;
  end: number;
  expiry?: number;
  refundFee?: number;
}): Record<string, unknown> | null {
  const openingRaw = toMarket(params.opening, params.market, "ceil");
  const floorRaw = toMarket(params.floor, params.market, "ceil");
  if (!openingRaw || !floorRaw) return null;
  const tokItems = (params.items || [])
    .filter((t) => t.amount > 0 && isHex64(t.id))
    .map((t) => ({
      tokenId: t.id.toLowerCase(),
      amount: toRaw(t.amount, t.decimals ?? 0, "floor")
    }))
    .filter((t): t is { tokenId: string; amount: string } => !!t.amount && BigInt(t.amount) > 0n);

  return {
    market: params.market,
    items: tokItems,
    nanoErg:
      params.market === "SigUSD" && params.erg && params.erg > 0
        ? toErgRaw(params.erg, "floor")
        : undefined,
    opening: openingRaw,
    floor: floorRaw,
    start: params.start != null ? Math.round(params.start) : undefined,
    end: Math.round(params.end),
    expiry: params.expiry != null ? Math.round(params.expiry) : undefined,
    refundFeeNanoErg: params.refundFee != null ? toErgRaw(params.refundFee, "ceil") : undefined
  };
}

export function buildFractionalizeBody(params: {
  vault: "selective" | "dutch";
  opening: number;
  floor: number;
  length?: number;
  expiry?: number;
}): Record<string, unknown> {
  return {
    vault: params.vault,
    openingBps: Math.round(params.opening * 100),
    floorBps: Math.round(params.floor * 100),
    ...(params.length != null ? { length: Math.round(params.length) } : {}),
    ...(params.expiry != null ? { expiry: Math.round(params.expiry) } : {})
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptPortfolio(raw: any, tokenMap: Record<string, ZcTokenMeta> = {}) {
  if (!raw) {
    return {
      walletErg: 0,
      walletSigUsd: 0,
      walletTokens: [] as ZcWalletToken[],
      positions: [] as ZcPortfolioPosition[],
      openOrders: [] as ZcAskSummary[],
      openAsks: [] as ZcAskSummary[],
      openOffers: [] as ZcOfferSummary[],
      openLotIds: [] as string[],
      mintRequests: [] as ZcPortfolioMintRequest[],
      wraps: [] as ZcPortfolioWrap[],
      attentionCount: 0
    };
  }

  const walletErg = fromErg(raw.wallet?.nanoErg ?? "0") ?? 0;
  let walletSigUsd = 0;
  const walletTokens: ZcWalletToken[] = [];
  for (const t of raw.wallet?.tokens || []) {
    const id = String(t.tokenId || "").toLowerCase();
    if (id === SIGUSD_TOKEN_ID) {
      walletSigUsd += fromRaw(t.amount, 2) ?? 0;
    } else if (t.kind === "token" || t.kind === "wrapReceipt" || t.kind === "provision") {
      const meta = tokenMap[id];
      const known = VERIFIED_META_BY_ID.get(id);
      const isReceipt = t.kind === "wrapReceipt" || meta?.kind === "wrapReceipt";
      const isProvision = !isReceipt && t.kind === "provision";
      const decimals =
        isReceipt || isProvision
          ? 0
          : meta?.decimals ?? known?.decimals ?? (id === LIT_TOKEN_ID ? 9 : 0);
      walletTokens.push({
        id,
        ticker:
          meta?.ticker ||
          meta?.name ||
          known?.name ||
          (isReceipt
            ? `ZCS-Wrap-${id.slice(0, 6)}`
            : isProvision
              ? `LD-NFT-${id.slice(0, 6)}`
              : id === LIT_TOKEN_ID
                ? "LIT"
                : `${id.slice(0, 6)}…`),
        name: meta?.name || known?.name || (id === LIT_TOKEN_ID ? "Lithos" : null),
        description: meta?.description ?? null,
        decimals,
        amount: isReceipt || isProvision ? Number(t.amount || 1) : fromRaw(t.amount, decimals) ?? 0,
        rawAmount: String(t.amount ?? "0"),
        kind: isReceipt ? "receipt" : isProvision ? "provision" : "token",
        wraps: isReceipt ? buildWrappedInfo(meta, tokenMap) : null,
        pool: t.pool ?? null,
        liquidity: t.liquidity ?? null,
        fees: t.fees ?? null,
        verified: isReceipt || !!meta?.verified || !!known,
        unverified: !isReceipt && !isProvision && !known && meta != null && !meta.verified
      });
    }
  }

  const positions: ZcPortfolioPosition[] = [];
  for (const item of raw.lending || []) {
    const bond: ZcBondSummary = adaptBond(item.bond, tokenMap) || {
      id: item.shares?.bondId || item.tokenId,
      market: "SigUSD",
      principal: 0,
      repayment: 0,
      start: 0,
      maturity: 0,
      collateral: { erg: 0, usd: 0, tokens: [] },
      rule: "maturity",
      ratio: null,
      oracleAge: 60,
      cov: null,
      vault: null,
      state: item.status
    };
    if (item.shares?.type && item.shares.type !== "plain") {
      bond.vault = item.shares.type;
    }
    const market = bond.market || "SigUSD";
    const isShares = item.kind === "shares";
    const actions: Record<string, ZcActionAvailability> = Object.fromEntries(
      (item.actions || []).map((a: ZcActionAvailability) => [a.name, a])
    );
    positions.push({
      id: item.tokenId,
      tokenId: item.tokenId,
      side: "lend",
      kind: isShares ? "shares" : "unit",
      units: Number(item.units || 1),
      unitsRaw: String(item.units || "1"),
      borrowedByMe: !!(item.borrowedByMe ?? bond.borrowedByMe ?? bond.mine),
      status: item.status || "live",
      bond,
      shares: item.shares || null,
      paid: item.cost?.paid != null ? fromMarket(item.cost.paid, market) : null,
      at: item.cost?.height ?? null,
      via: item.cost?.viaOffer ?? null,
      vaultId: item.shares?.vault?.boxId ?? null,
      mark: item.mark
        ? {
            basis: item.mark.basis,
            bid: item.mark.bidBps ?? null,
            value: item.mark.value != null ? fromMarket(item.mark.value, market) : null,
            pnl: item.mark.pnl != null ? fromMarket(item.mark.pnl, market) : null,
            entry: item.mark.entryBps ?? null,
            atMaturity: item.mark.atMaturity != null ? fromMarket(item.mark.atMaturity, market) : null
          }
        : null,
      actions,
      settlement: bond.settlement ?? null
    });
  }

  for (const item of raw.borrowing || []) {
    const bond = adaptBond(item.bond, tokenMap);
    if (!bond) continue;
    const actions: Record<string, ZcActionAvailability> = Object.fromEntries(
      (item.actions || []).map((a: ZcActionAvailability) => [a.name, a])
    );
    positions.push({
      id: bond.id,
      side: "borrow",
      kind: "unit",
      units: 1,
      holdsUnit: !!item.holdsUnit,
      borrowedByMe: true,
      status: item.status === "liquidatable" ? "overdue" : item.status || "live",
      bond,
      actions
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openOrders = (raw.open?.orders || []).map((o: any) => adaptAskSummary(o, tokenMap));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openAsks = (raw.open?.asks || []).map((a: any) => adaptAskSummary(a, tokenMap));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openOffers = (raw.open?.offers || []).map((o: any) => adaptOfferSummary(o));

  const wraps: ZcPortfolioWrap[] = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(raw.open?.wrapRequests || []).map((r: any): ZcPortfolioWrap => {
      const tid = String(r.token || "").toLowerCase();
      const meta = tokenMap[tid];
      const inner: ZcWalletToken = {
        id: tid,
        ticker: meta?.ticker || meta?.name || `${tid.slice(0, 6)}…`,
        name: meta?.name || null,
        description: meta?.description ?? null,
        decimals: meta?.decimals ?? 0,
        amount: 1,
        rawAmount: "1",
        kind: "token"
      };
      return {
        id: r.boxId,
        boxId: r.boxId,
        receipt: {
          id: r.boxId,
          ticker: `ZCS-Wrap-${tid.slice(0, 6)}`,
          name: `Wrapped ${inner.name || inner.ticker}`,
          decimals: 0,
          amount: 1,
          rawAmount: "1",
          kind: "receipt",
          wraps: {
            id: inner.id,
            ticker: inner.ticker,
            name: inner.name,
            description: inner.description ?? null,
            decimals: inner.decimals,
            amount: inner.amount,
            rawAmount: inner.rawAmount,
            state: "requested"
          },
          verified: true
        },
        token: inner,
        state: "requested",
        pending: !!r.pending,
        inWallet: false
      };
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(raw.wraps || []).map((w: any): ZcPortfolioWrap => {
      const tid = String(w.token || "").toLowerCase();
      const rid = String(w.receiptId || w.boxId || "").toLowerCase();
      const meta = tokenMap[tid];
      const inner: ZcWalletToken = {
        id: tid,
        ticker: meta?.ticker || meta?.name || `${tid.slice(0, 6)}…`,
        name: meta?.name || null,
        description: meta?.description ?? null,
        decimals: meta?.decimals ?? 0,
        amount: fromRaw(w.amount ?? "1", meta?.decimals ?? 0) ?? 1,
        rawAmount: String(w.amount ?? "1"),
        kind: "token"
      };
      const refreshFrom = typeof w.refreshFrom === "number" ? w.refreshFrom : null;
      return {
        id: rid,
        receiptId: rid,
        vaultBoxId: w.vaultBoxId,
        receipt: {
          id: rid,
          ticker: `ZCS-Wrap-${rid.slice(0, 6)}`,
          name: `Wrapped ${inner.name || inner.ticker}`,
          decimals: 0,
          amount: 1,
          rawAmount: "1",
          kind: "receipt",
          wraps: {
            id: inner.id,
            ticker: inner.ticker,
            name: inner.name,
            description: inner.description ?? null,
            decimals: inner.decimals,
            amount: inner.amount,
            rawAmount: inner.rawAmount,
            vaultBoxId: w.vaultBoxId ?? null,
            refreshFrom,
            state: w.state || "wrapped"
          },
          verified: true
        },
        token: inner,
        state: w.state || "wrapped",
        refreshFrom,
        inWallet: !!w.inWallet
      };
    })
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openLotIds: string[] = (raw.open?.lots || []).map((l: any) => String(l.boxId || ""));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mintRequests: ZcPortfolioMintRequest[] = (raw.open?.mintRequests || []).map((r: any) => ({
    id: String(r.boxId || ""),
    boxId: String(r.boxId || ""),
    bondId: String(r.bondId || ""),
    pending: !!r.pending
  }));
  const attentionCount = Number(raw.attention?.borrowing ?? 0);

  return {
    walletErg,
    walletSigUsd,
    walletTokens,
    positions,
    openOrders,
    openAsks,
    openOffers,
    openLotIds,
    mintRequests,
    wraps,
    attentionCount
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
    const demoHit = demoLookupProvider?.()?.matchesById.get(id.toLowerCase());
    if (demoHit) return demoHit;
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
  ): Promise<ZcLookupResult | null> {
    const demoHit = demoLookupProvider?.()?.lookupById.get(id.toLowerCase());
    if (demoHit) return demoHit;
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
    const meta = {
      current: typeof raw.current === "string" ? raw.current : null,
      spentBy: typeof raw.spentBy === "string" ? raw.spentBy : null,
      successorId: typeof raw.successorId === "string" ? raw.successorId : null,
      note: typeof raw.note === "string" ? raw.note : null
    };

    if ((type === "order" || type === "ask") && rec?.market) {
      return {
        type,
        ask: adaptAskSummary(rec, tokenMap),
        ...meta
      };
    }
    if (type === "offer" && rec?.market) {
      return {
        type: "offer",
        offer: adaptOfferSummary(rec),
        ...meta
      };
    }
    if (type === "bond" && rec) {
      const bond = adaptBond(rec, tokenMap);
      return {
        type: "bond",
        bond: bond || undefined,
        ...meta
      };
    }
    if (type === "shares" && rec) {
      const bondId = typeof rec.bondId === "string" ? rec.bondId : null;
      let bond: ZcBondSummary | undefined;
      if (bondId && isHex64(bondId)) {
        try {
          const bondLookup = await this.lookup(bondId, tokenMap, signal);
          if (bondLookup?.bond) {
            bond = {
              ...bondLookup.bond,
              vault: rec.type && rec.type !== "plain" ? String(rec.type) : bondLookup.bond.vault
            };
          }
        } catch {
          // fail-soft
        }
      }
      return {
        type: "shares",
        bond,
        shares: rec,
        ...meta
      };
    }
    return {
      type,
      ...meta
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

  async listAuctions(
    tokenMap: Record<string, ZcTokenMeta> = {},
    signal?: AbortSignal
  ): Promise<{
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
    const mapItems = (rawItems: any[]): ZcCollateralToken[] =>
      (rawItems || []).map((t) => buildCollateralToken(t.tokenId || t.id, t.amount, t.kind, tokenMap));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lots = (res?.lots || []).map((l: any): ZcAuctionLotSummary => {
      const m: ZcMarket = l.market === "ERG" ? "ERG" : "SigUSD";
      const items = mapItems(l.items || []);
      const boxErg = fromErg(l.nanoErg) ?? 0;
      // On-chain ZC_Standard_LotAuction transfers the entire box ERG to the buyer on a SigUSD lot sale.
      const ergInLot = m === "SigUSD" ? boxErg : 0;
      return {
        id: l.boxId,
        boxId: l.boxId,
        chainId: l.chainId || l.boxId,
        market: m,
        opening: fromMarket(l.opening, m) ?? 0,
        floor: fromMarket(l.floor, m) ?? 0,
        start: Number(l.start ?? 0),
        end: Number(l.end ?? 0),
        expiry: Number(l.expiry ?? 0),
        refundFee: fromErg(l.refundFeeNanoErg) ?? 0.005,
        erg: ergInLot,
        items,
        priceNow: l.priceNow != null ? fromMarket(l.priceNow, m) : null,
        phase: l.phase || "falling",
        itemCount: items.length + (ergInLot > 0 ? 1 : 0),
        valid: l.valid !== false,
        owner: !!l.mine,
        borrowedByMe: !!l.borrowedByMe,
        borrowedBondIds: Array.isArray(l.borrowedBondIds) ? l.borrowedBondIds : [],
        pending: !!l.pending
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaults = (res?.vaults || []).map((v: any): ZcAuctionVaultSummary => {
      const m: ZcMarket = v.market === "ERG" ? "ERG" : "SigUSD";
      const excess = v.state === 4;
      const payRaw = excess ? v.quote?.priceRaw : v.quote?.payRaw;
      const payNow = payRaw != null ? fromMarket(payRaw, m) : null;
      const target = v.quote?.targetRaw != null ? fromMarket(v.quote.targetRaw, m) : null;
      return {
        id: v.boxId,
        boxId: v.boxId,
        shareTokenId: v.shareTokenId,
        bondId: v.bondId,
        market: m,
        vaultType: v.type || "selective",
        state: Number(v.state ?? 1),
        repayment: fromMarket(v.repayment, m) ?? 0,
        openBps: Number(v.openingBps ?? 20_000),
        floorBps: Number(v.floorBps ?? 9_000),
        length: Number(v.length ?? 720),
        expiry: Number(v.expiry ?? 2160),
        start: Number(v.auctionStart ?? 0),
        currencyHeld: fromMarket(v.currencyHeld, m) ?? 0,
        items: mapItems(v.items || []),
        payNow,
        quote: {
          pay: payNow,
          target,
          bps: v.quote?.bps != null ? Number(v.quote.bps) : null,
          done: !!v.quote?.done
        },
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
