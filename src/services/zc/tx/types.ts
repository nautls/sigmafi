/**
 * SECURITY AUDIT BOUNDARY: Pure type definitions & error classes for the isolated
 * SigmaFi V2 (zcs1) ErgoTree v3 transaction subsystem.
 *
 * No runtime side effects, no Vue/Pinia imports, no network/wallet calls.
 */
import {
  Amount,
  Box,
  EIP12UnsignedTransaction,
  Network,
  SignedTransaction
} from "@fleet-sdk/common";
import { ChainAsset } from "../boxes";
import { ZcChainClient } from "../chainClient";
import { ZcMarketBook, ZcMatcher } from "../matcher";
import { ZcResolver } from "../resolver";
import { ZcMarket } from "@/types/zc";

/**
 * Nautilus v2.0.0-beta.3+ per-input signer mapping for ErgoTree v3 blind signing.
 *
 * - Every protocol contract input index MUST be mapped to `null` (no wallet signature).
 * - Every wallet / creator-auth input index MUST be mapped to its exact Base58 address
 *   owned by the connected wallet.
 *
 * Ref: https://docs.nautiluswallet.com/dapp-connector/wallet-interaction#choose-the-signing-address-of-each-input
 */
export interface NautilusSignOptions {
  readonly signers?: Record<number, string | null>;
}

/**
 * Slippage / quote-drift protection checked immediately before signing.
 * Units: nanoERG for ERG / no-market actions (miner fee included); raw units (cents) for SigUSD.
 */
export interface ZcTxLimits {
  readonly maxPay?: bigint;
  readonly minReceive?: bigint;
}

export interface ZcTxFeeItem {
  readonly name: string;
  readonly nanoErg: bigint;
  readonly kind: "spent" | "locked" | "earned" | "refundable";
}

export interface ZcTxCreatedBox {
  readonly role: string;
  readonly contract: string | null;
  readonly nanoErg: bigint;
  readonly tokens: readonly ChainAsset[];
}

export interface ZcTxQuote {
  readonly action: string;
  readonly market: ZcMarket | null;
  readonly paysNanoErgs: bigint;
  readonly receivesNanoErgs: bigint;
  readonly paysTokens: readonly ChainAsset[];
  readonly receivesTokens: readonly ChainAsset[];
  readonly fees: readonly ZcTxFeeItem[];
  readonly creates: readonly ZcTxCreatedBox[];
  readonly terms: Readonly<Record<string, unknown>>;
  readonly validFrom: number;
  readonly validThrough: number | null;
  readonly warnings: readonly string[];
  readonly refusals: readonly string[];
  readonly requires: readonly string[];
  readonly suggestedLimits: ZcTxLimits;
}

export interface ZcSignerAuditEntry {
  readonly index: number;
  readonly boxId: string;
  readonly role: "protocol" | "auth" | "wallet";
  readonly contractLabel: string;
  readonly ergoTree: string;
  readonly value: bigint;
  readonly signerAddress: string | null;
}

export interface ZcBuiltTx {
  readonly action: string;
  readonly market: ZcMarket | null;
  readonly unsignedTx: EIP12UnsignedTransaction;
  readonly signers: Record<number, string | null>;
  readonly signerAudit: readonly ZcSignerAuditEntry[];
  readonly quote: ZcTxQuote;
  readonly minerFee: bigint;
  readonly expectedMinted: string | null;
  readonly expectedBurn: readonly ChainAsset[];
  readonly primaryOutputIndex: number;
  readonly assetId: string | null;
}

export interface ZcSubmitResult {
  readonly txId: string;
  readonly action: string;
  readonly built: ZcBuiltTx;
  readonly warnings: readonly string[];
}

/**
 * Exhaustive discriminated union of all 19 SigmaFi V2 (zcs1) user transactions.
 */
export type ZcTxAction =
  | { readonly type: "createOrder"; readonly body: Record<string, unknown> }
  | { readonly type: "createOffer"; readonly body: Record<string, unknown> }
  | { readonly type: "createAsk"; readonly body: Record<string, unknown> }
  | { readonly type: "createLot"; readonly body: Record<string, unknown> }
  | { readonly type: "fractionalize"; readonly assetId: string; readonly body: Record<string, unknown> }
  | { readonly type: "createWrap"; readonly body: Record<string, unknown> }
  | { readonly type: "cancel"; readonly boxId: string }
  | {
      readonly type: "fillOrder";
      readonly boxId: string;
      readonly maturity?: bigint | number | null;
      readonly reserveNanoErg?: bigint | null;
      readonly allowLiquidatable?: boolean;
    }
  | {
      readonly type: "buyAsk";
      readonly boxId: string;
      readonly units?: bigint | null;
      readonly allowLiquidatable?: boolean;
    }
  | { readonly type: "buyLot"; readonly boxId: string }
  | {
      readonly type: "repay";
      readonly assetId: string;
      readonly fromCollateral?: "max" | bigint | null;
    }
  | { readonly type: "extinguish"; readonly assetId: string }
  | {
      readonly type: "recollateralize";
      readonly assetId: string;
      readonly nanoErg?: bigint;
      readonly tokens?: readonly ChainAsset[];
    }
  | { readonly type: "liquidate"; readonly assetId: string }
  | { readonly type: "claim"; readonly tokenId: string; readonly units?: bigint | null }
  | { readonly type: "mint"; readonly boxId: string }
  | { readonly type: "pull"; readonly boxId: string }
  | { readonly type: "buyVault"; readonly boxId: string }
  | { readonly type: "unwrap"; readonly receiptId: string };

export interface ZcWalletLendBatchStep {
  readonly boxId: string;
  readonly units?: bigint | null;
  readonly label: string;
  readonly expectedCostRaw: bigint;
}

export interface ZcBatchAction {
  readonly type: "walletLendBatch";
  readonly market: ZcMarket;
  readonly steps: readonly ZcWalletLendBatchStep[];
}

export type ZcExecutableAction = ZcTxAction | ZcBatchAction;

export interface ZcWalletAddresses {
  readonly changeAddress: string;
  readonly usedAddresses: readonly string[];
  readonly unusedAddresses: readonly string[];
}

export interface ZcWalletTxAdapter {
  readonly network: Network;
  getAddresses(): Promise<ZcWalletAddresses>;
  getUtxos(force?: boolean): Promise<readonly Box<Amount>[]>;
  getCurrentHeight(): Promise<number>;
  signTx(
    unsignedTx: EIP12UnsignedTransaction,
    options?: NautilusSignOptions
  ): Promise<SignedTransaction>;
  submitTx(signedTx: SignedTransaction): Promise<string>;
}

export interface ZcTxReadContext {
  readonly client: ZcChainClient;
  readonly resolver: ZcResolver;
  readonly book: ZcMarketBook;
  readonly matcher: ZcMatcher;
  readonly network: string;
}

export interface ZcTxDeps {
  readonly wallet: ZcWalletTxAdapter;
  getReadContext(force?: boolean, signal?: AbortSignal): Promise<ZcTxReadContext>;
  /** Optional predicate identifying raw capability / LithosDex provision NFTs that must be wrapped first. */
  isCapabilityToken?(tokenId: string): boolean;
}

/** Action refused by protocol rules or wallet constraints (e.g., expired, missing auth box, pull required). */
export class ZcTxRefusalError extends Error {
  readonly requires: readonly string[];

  constructor(message: string, requires: readonly string[] = []) {
    super(message);
    this.name = "ZcTxRefusalError";
    this.requires = requires;
  }
}

/** On-chain state moved between quote and build (spent box, or price crossed `limits`). */
export class ZcTxConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZcTxConflictError";
  }
}

/**
 * Fatal post-build safety assertion failure (ERG/token conservation, unexpected burn,
 * invalid signer map, or unverified change destination). Never catch-and-proceed past this.
 */
export class ZcTxInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZcTxInvariantError";
  }
}
