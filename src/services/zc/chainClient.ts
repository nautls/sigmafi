import { SignedTransaction } from "@fleet-sdk/common";
import { ChainBox, ZcOracle } from "./boxes";

export interface ChainState {
  readonly height: number;
  readonly blockId: string;
  readonly network: string;
}

export interface LiveZcSnapshot {
  readonly state: ChainState;
  readonly confirmedOracle: ZcOracle | null;
  readonly refreshPending: boolean;
  readonly confirmedBoxes: readonly ChainBox[];
  readonly pendingBoxes: readonly ChainBox[];
  readonly mempool: boolean;
  readonly cut: boolean;
  readonly fillsDirty: boolean;
}

export type HergmesStreamPhase =
  | "idle"
  | "connecting"
  | "snapshot"
  | "catching_up"
  | "live"
  | "waiting"
  | "disconnected"
  | "rejected";

export type ZcTxCheckResult =
  | { readonly ok: true; readonly txId: string }
  | { readonly ok: false; readonly reason: string; readonly message: string };

export interface ChainTxInput {
  readonly boxId: string;
  readonly index: number;
  readonly extension: Readonly<Record<string, string>>;
  readonly box: ChainBox | null;
}

export interface ChainTxDataInput {
  readonly boxId: string;
  readonly index: number;
  readonly box: ChainBox | null;
}

export interface ChainTransaction {
  readonly transactionId: string;
  readonly inclusionHeight: number;
  readonly timestamp: number;
  readonly inputs: readonly ChainTxInput[];
  readonly dataInputs: readonly ChainTxDataInput[];
  readonly outputs: readonly ChainBox[];
}

export interface ZcChainParameters {
  readonly height: number;
  readonly blockVersion: number;
  readonly storageFeeFactor: number;
  readonly minValuePerByte: number;
  readonly maxBlockSize: number;
  readonly maxBlockCost: number;
  readonly tokenAccessCost: number;
  readonly inputCost: number;
  readonly dataInputCost: number;
  readonly outputCost: number;
  readonly subblocksPerBlock: number | null;
}

export interface GraphqlTokenInfo {
  readonly tokenId: string;
  readonly name: string | null;
  readonly decimals: number | null;
  readonly description: string | null;
  readonly emissionAmount: string | null;
}

export interface ZcChainClient {
  getEndpoint(): string;
  setEndpoint(url: string): void;
  getChainParameters?(): ZcChainParameters | null;
  fetchChainParameters?(signal?: AbortSignal): Promise<ZcChainParameters | null>;
  fetchStateAndOracle(
    signal?: AbortSignal
  ): Promise<{ state: ChainState; oracle: ZcOracle | null }>;
  fetchAllUnspentZcBoxes(signal?: AbortSignal): Promise<{ boxes: ChainBox[]; cut: boolean }>;
  fetchBoxesByIds(boxIds: readonly string[], signal?: AbortSignal): Promise<Map<string, ChainBox>>;
  fetchTransactionsByIds(
    txIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, ChainTransaction>>;
  fetchTransactionsByAddresses(
    addresses: readonly string[],
    minHeight: number,
    maxPages?: number,
    signal?: AbortSignal
  ): Promise<ChainTransaction[]>;
  fetchTokensByIds(
    tokenIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, GraphqlTokenInfo>>;
  fetchSpendableBoxesByIds?(
    boxIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, ChainBox>>;
  checkTransaction?(
    signedTx: SignedTransaction,
    signal?: AbortSignal
  ): Promise<ZcTxCheckResult>;
}

/**
 * Combines an optional caller AbortSignal with a per-request timeout so stalled
 * third-party blockchain endpoints cannot hang the polling loop indefinitely.
 */
export function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const ac = new AbortController();
  let timedOut = false;

  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) {
      ac.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  return {
    signal: ac.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  };
}
