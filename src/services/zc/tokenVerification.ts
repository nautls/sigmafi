import { VERIFIED_ASSETS } from "@/maps/verifiedAssets";
import { ZcCollateralToken, ZcWalletToken, ZcWrappedTokenInfo } from "@/types/zc";
import { SIGUSD_TOKEN_ID } from "@/utils/zcMath";

export type TokenVerificationStatus = "verified" | "unverifiable" | "unverified";

export interface TokenVerificationCheck {
  label: string;
  ok: boolean | null;
  detail: string;
}

export interface TokenVerificationResult {
  status: TokenVerificationStatus;
  verifierId: string;
  badge: string;
  summary: string;
  note?: string;
  checks?: TokenVerificationCheck[];
}

export interface TokenVerificationSubject {
  id: string;
  ticker: string;
  name?: string | null;
  description?: string | null;
  decimals: number;
  amount: number;
  kind: "token" | "provision" | "receipt" | "bond" | "shares";
  verified?: boolean;
  wraps?: ZcWrappedTokenInfo | null;
}

export interface TokenVerificationContext {
  token: TokenVerificationSubject;
  /** True when verifying the underlying asset locked inside a ZCS wrap custody vault. */
  isWrappedInner?: boolean;
}

/**
 * Modular verifier plugin contract.
 * Future verifiers (e.g. LithosDex LD-NFT verifier, Spectrum LP verifier, NFT collection verifiers)
 * can implement this interface and register via `registerTokenVerifier(...)` without touching UI code.
 */
export interface TokenVerifier {
  readonly id: string;
  /** Higher priority verifiers are evaluated first. */
  readonly priority: number;
  matches(ctx: TokenVerificationContext): boolean;
  verify(ctx: TokenVerificationContext): TokenVerificationResult;
}

const VERIFIED_ASSET_IDS = new Set(VERIFIED_ASSETS.map((a) => a.tokenId.toLowerCase()));

const SPECIAL_LP_NOTE =
  "Special tokens like liquidity provision (LP) NFTs are not verifiable yet. Inspect the raw token ID, name, and on-chain description before transacting.";

function looksLikeSpecialOrLpToken(t: TokenVerificationSubject, isWrappedInner?: boolean): boolean {
  if (t.kind === "provision") return true;
  if (isWrappedInner) return true;
  const hay = `${t.ticker || ""} ${t.name || ""} ${t.description || ""}`.toLowerCase();
  if (/\b(lp|ld-nft|liquidity|provision|pool)\b/.test(hay)) return true;
  // Single-unit 0-decimal NFTs that aren't in the verified fungible registry
  if (t.decimals === 0 && t.amount === 1 && !VERIFIED_ASSET_IDS.has(t.id.toLowerCase())) {
    return true;
  }
  return false;
}

const BUILTIN_VERIFIERS: TokenVerifier[] = [
  {
    id: "ergo-native-market",
    priority: 100,
    matches: ({ token }) => {
      const low = token.id.toLowerCase();
      return low === "erg" || low === SIGUSD_TOKEN_ID;
    },
    verify: ({ token }) => ({
      status: "verified",
      verifierId: "ergo-native-market",
      badge: "Canonical asset",
      summary:
        token.id.toLowerCase() === "erg"
          ? "Native Ergo currency counted by the oracle collateral rule."
          : "Canonical SigmaUSD token counted by the oracle collateral rule."
    })
  },
  {
    id: "zcs1-bond-origin",
    priority: 90,
    matches: ({ token }) => token.kind === "bond" || token.kind === "shares",
    verify: ({ token }) => {
      const ok = token.verified !== false;
      return {
        status: ok ? "verified" : "unverified",
        verifierId: "zcs1-bond-origin",
        badge: ok ? "zcs1 Verified" : "Origin unverified",
        summary:
          token.kind === "shares"
            ? "SigmaFi V2 fractional bond shares backed by a share vault."
            : "SigmaFi V2 zero-coupon bond unit representing the lender claim."
      };
    }
  },
  {
    id: "zcs1-wrap-receipt",
    priority: 85,
    matches: ({ token, isWrappedInner }) => !isWrappedInner && token.kind === "receipt",
    verify: ({ token }) => {
      const innerResult = token.wraps ? verifyWrappedAsset(token.wraps) : null;
      const innerVerified = innerResult?.status === "verified";
      return {
        status: innerVerified ? "verified" : innerResult?.status ?? "unverifiable",
        verifierId: "zcs1-wrap-receipt",
        badge: innerVerified ? "Custody + Asset Verified" : "Underlying not verifiable yet",
        summary:
          "ZCS custody wrap receipt. The wrapped token stays locked in a custody vault until this receipt is burned to unwrap.",
        note: innerVerified ? undefined : innerResult?.note || SPECIAL_LP_NOTE,
        checks: [
          {
            label: "Custody receipt",
            ok: token.verified !== false,
            detail:
              token.verified !== false
                ? "Standard zcs1 custody wrap vault"
                : "Wrap vault origin not yet verified"
          },
          {
            label: "Underlying token",
            ok: innerVerified ? true : null,
            detail: innerResult
              ? `${innerResult.badge} (${innerResult.verifierId})`
              : "No verifier registered for underlying token"
          }
        ]
      };
    }
  },
  {
    id: "verified-asset-registry",
    priority: 70,
    matches: ({ token }) => VERIFIED_ASSET_IDS.has(token.id.toLowerCase()),
    verify: () => ({
      status: "verified",
      verifierId: "verified-asset-registry",
      badge: "Verified token",
      summary: "Matches Ergo mainnet verified token registry."
    })
  },
  {
    id: "special-protocol-token-placeholder",
    priority: 50,
    matches: ({ token, isWrappedInner }) => looksLikeSpecialOrLpToken(token, isWrappedInner),
    verify: () => ({
      status: "unverifiable",
      verifierId: "special-protocol-token-placeholder",
      badge: "Not verifiable yet",
      summary: "Underlying protocol/NFT verification is not yet supported for this token type.",
      note: SPECIAL_LP_NOTE
    })
  },
  {
    id: "default-unverified",
    priority: 0,
    matches: () => true,
    verify: () => ({
      status: "unverified",
      verifierId: "default-unverified",
      badge: "Unverified",
      summary: "Token ID is not in the verified registry. Confirm the raw token ID before trading."
    })
  }
];

const registry: TokenVerifier[] = [...BUILTIN_VERIFIERS].sort((a, b) => b.priority - a.priority);

/**
 * Registers a custom token verifier plugin. Returns an unregister callback.
 * Replacing an existing `id` updates it in place and re-sorts by priority.
 */
export function registerTokenVerifier(verifier: TokenVerifier): () => void {
  const idx = registry.findIndex((v) => v.id === verifier.id);
  if (idx >= 0) registry.splice(idx, 1);
  registry.push(verifier);
  registry.sort((a, b) => b.priority - a.priority);
  return () => {
    const i = registry.findIndex((v) => v.id === verifier.id);
    if (i >= 0) registry.splice(i, 1);
  };
}

export function listTokenVerifiers(): readonly TokenVerifier[] {
  return registry;
}

export function verifyToken(
  token: ZcCollateralToken | ZcWalletToken | TokenVerificationSubject,
  options?: { isWrappedInner?: boolean }
): TokenVerificationResult {
  const ctx: TokenVerificationContext = {
    token,
    isWrappedInner: options?.isWrappedInner
  };
  for (const v of registry) {
    if (v.matches(ctx)) {
      return v.verify(ctx);
    }
  }
  return {
    status: "unverified",
    verifierId: "none",
    badge: "Unverified",
    summary: "No verifier matched this token."
  };
}

export function verifyWrappedAsset(inner: ZcWrappedTokenInfo): TokenVerificationResult {
  return verifyToken(
    {
      id: inner.id,
      ticker: inner.ticker,
      name: inner.name,
      description: inner.description,
      decimals: inner.decimals,
      amount: inner.amount,
      kind: inner.kind || "token"
    },
    { isWrappedInner: true }
  );
}
