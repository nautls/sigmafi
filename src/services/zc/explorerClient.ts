import { ChainAsset, ChainBox, holdsOracleNft, readZcOracle, ZcOracle } from "./boxes";
import {
  ChainState,
  ChainTransaction,
  ChainTxDataInput,
  ChainTxInput,
  GraphqlTokenInfo,
  withTimeoutSignal,
  ZcChainClient
} from "./chainClient";
import { ALL_ZC_BOX_TREES, ZC_ORACLE_V2_ERGO_TREE } from "./contracts";
import { ZcApiError } from "./errors";

export const DEFAULT_MAINNET_EXPLORER_URL = "https://api.ergoscan.me/v1";
export const OFFICIAL_MAINNET_EXPLORER_URL = "https://api.ergoplatform.com/api/v1";
export const DEFAULT_TESTNET_EXPLORER_URL = "https://api-testnet.ergoplatform.com/api/v1";

const BOX_PAGE_SIZE = 500;
const MAX_SCAN_PAGES = 10;
const TX_ADDR_PAGE_SIZE = 100;
const TREE_CONCURRENCY = 6;
const ITEM_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 15_000;

interface ExplorerRawAsset {
  tokenId: string;
  amount: string | number;
}

interface ExplorerRawRegisterObj {
  serializedValue?: string;
}

type ExplorerRawRegister = string | ExplorerRawRegisterObj | null | undefined;

interface ExplorerRawBox {
  boxId: string;
  transactionId?: string | null;
  outputTransactionId?: string | null;
  value: string | number;
  index?: number | null;
  outputIndex?: number | null;
  creationHeight?: number | null;
  outputCreatedAt?: number | null;
  settlementHeight?: number | null;
  outputSettledAt?: number | null;
  ergoTree?: string | null;
  assets?: ExplorerRawAsset[] | null;
  additionalRegisters?: Record<string, ExplorerRawRegister> | null;
  spentTransactionId?: string | null;
}

interface ExplorerRawInput extends ExplorerRawBox {
  extension?: Record<string, string> | null;
  spendingProof?: string | { proofBytes?: string; extension?: Record<string, string> } | null;
}

interface ExplorerRawDataInput {
  boxId: string;
  index?: number | null;
  ergoTree?: string | null;
  value?: string | number | null;
  transactionId?: string | null;
  outputTransactionId?: string | null;
  outputIndex?: number | null;
  creationHeight?: number | null;
  outputCreatedAt?: number | null;
  settlementHeight?: number | null;
  outputSettledAt?: number | null;
  assets?: ExplorerRawAsset[] | null;
  additionalRegisters?: Record<string, ExplorerRawRegister> | null;
}

interface ExplorerRawTx {
  id?: string;
  transactionId?: string;
  inclusionHeight?: number | null;
  timestamp?: string | number | null;
  inputs?: ExplorerRawInput[] | null;
  dataInputs?: ExplorerRawDataInput[] | null;
  outputs?: ExplorerRawBox[] | null;
}

interface ExplorerPage<T> {
  items?: T[] | null;
  total?: number | null;
}

interface ExplorerNetworkState {
  height?: number | null;
  fullHeight?: number | null;
  lastBlockId?: string | null;
  blockId?: string | null;
  network?: string | null;
}

interface ExplorerRawToken {
  id?: string;
  tokenId?: string;
  name?: string | null;
  decimals?: number | null;
  description?: string | null;
  emissionAmount?: string | number | null;
}

function normalizeExplorerUrl(raw: string): string {
  const clean = raw.trim().replace(/\/+$/, "");
  if (!clean) return DEFAULT_MAINNET_EXPLORER_URL;
  try {
    const parsed = new URL(clean);
    const p = parsed.pathname.replace(/\/+$/, "");
    if (!p) {
      if (parsed.hostname.includes("ergoscan")) return `${parsed.origin}/v1`;
      return `${parsed.origin}/api/v1`;
    }
    return `${parsed.origin}${p}`;
  } catch {
    return clean;
  }
}

/**
 * Quotes raw JSON integer literals for nanoERG/token fields before JSON.parse so
 * `/api/v1` endpoints that emit exact integers beyond 2^53 never lose precision.
 */
function parseExplorerJson<T>(text: string): T {
  const safe = text.replace(/"(value|amount|emissionAmount)"\s*:\s*(\d+)/g, '"$1":"$2"');
  return JSON.parse(safe) as T;
}

function mapRegisters(
  raw: Record<string, ExplorerRawRegister> | null | undefined
): Record<string, string> {
  const regs: Record<string, string> = {};
  if (!raw) return regs;
  for (const [k, v] of Object.entries(raw)) {
    const hexVal = typeof v === "string" ? v : v?.serializedValue;
    if (typeof hexVal === "string" && hexVal.length > 0) regs[k] = hexVal;
  }
  return regs;
}

function mapExplorerBox(raw: ExplorerRawBox): ChainBox {
  const assets: ChainAsset[] = (raw.assets ?? []).map((a) => ({
    tokenId: String(a.tokenId).toLowerCase(),
    amount: BigInt(String(a.amount))
  }));
  const txId = raw.outputTransactionId || raw.transactionId || "";
  const created = Number(raw.outputCreatedAt ?? raw.creationHeight ?? 0);
  const settled = Number(raw.outputSettledAt ?? raw.settlementHeight ?? created);
  return {
    boxId: String(raw.boxId).toLowerCase(),
    transactionId: String(txId).toLowerCase(),
    value: BigInt(String(raw.value ?? "0")),
    index: Number(raw.outputIndex ?? raw.index ?? 0),
    creationHeight: created,
    settlementHeight: settled,
    ergoTree: String(raw.ergoTree ?? "").toLowerCase(),
    assets,
    additionalRegisters: mapRegisters(raw.additionalRegisters),
    spentTransactionId: raw.spentTransactionId ? String(raw.spentTransactionId).toLowerCase() : null,
    spendingHeight: null
  };
}

function mapExplorerTx(raw: ExplorerRawTx): ChainTransaction {
  const inputs: ChainTxInput[] = (raw.inputs ?? [])
    .map((inp, idx) => {
      const ext =
        inp.extension ??
        (typeof inp.spendingProof === "object" && inp.spendingProof !== null
          ? inp.spendingProof.extension
          : null) ??
        {};
      const hasBox = typeof inp.ergoTree === "string" && inp.ergoTree.length > 0;
      return {
        boxId: String(inp.boxId).toLowerCase(),
        index: Number(inp.index ?? idx),
        extension: ext,
        box: hasBox ? mapExplorerBox(inp) : null
      };
    })
    .sort((a, b) => a.index - b.index);

  const dataInputs: ChainTxDataInput[] = (raw.dataInputs ?? [])
    .map((di, idx) => {
      const hasBox = typeof di.ergoTree === "string" && di.ergoTree.length > 0;
      return {
        boxId: String(di.boxId).toLowerCase(),
        index: Number(di.index ?? idx),
        box: hasBox
          ? mapExplorerBox({
              boxId: di.boxId,
              transactionId: di.outputTransactionId || di.transactionId,
              value: di.value ?? "0",
              index: di.outputIndex ?? di.index ?? idx,
              creationHeight: di.outputCreatedAt ?? di.creationHeight ?? 0,
              settlementHeight: di.outputSettledAt ?? di.settlementHeight ?? 0,
              ergoTree: di.ergoTree,
              assets: di.assets,
              additionalRegisters: di.additionalRegisters
            })
          : null
      };
    })
    .sort((a, b) => a.index - b.index);

  const outputs: ChainBox[] = (raw.outputs ?? [])
    .map((o) =>
      mapExplorerBox({
        ...o,
        transactionId: o.transactionId || raw.id || raw.transactionId || ""
      })
    )
    .sort((a, b) => a.index - b.index);

  return {
    transactionId: String(raw.id || raw.transactionId || "").toLowerCase(),
    inclusionHeight: Number(raw.inclusionHeight ?? 0),
    timestamp: Number(raw.timestamp ?? 0),
    inputs,
    dataInputs,
    outputs
  };
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

export class ZcExplorerClient implements ZcChainClient {
  private endpoint: string;

  constructor(endpoint = DEFAULT_MAINNET_EXPLORER_URL) {
    this.endpoint = normalizeExplorerUrl(endpoint);
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  setEndpoint(url: string): void {
    this.endpoint = normalizeExplorerUrl(url);
  }

  private async getJson<T>(
    path: string,
    signal?: AbortSignal,
    allowNotFound = false
  ): Promise<T | null> {
    const url = `${this.endpoint}${path}`;
    const timeout = withTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: timeout.signal
      });
    } catch (err) {
      timeout.cleanup();
      if (signal?.aborted) throw err;
      throw new ZcApiError(
        timeout.didTimeout() ? "Ergo Explorer API timed out" : "Ergo Explorer API unreachable",
        0,
        err
      );
    }
    timeout.cleanup();

    if (res.status === 404 && allowNotFound) return null;

    const text = await res.text();
    if (!res.ok) {
      throw new ZcApiError(`Ergo Explorer API HTTP ${res.status}`, res.status, text);
    }

    try {
      return text ? parseExplorerJson<T>(text) : null;
    } catch (err) {
      throw new ZcApiError("Invalid JSON from Ergo Explorer API", 502, err);
    }
  }

  async fetchStateAndOracle(
    signal?: AbortSignal
  ): Promise<{ state: ChainState; oracle: ZcOracle | null }> {
    const [netRes, oraclePage] = await Promise.all([
      this.getJson<ExplorerNetworkState>("/networkState", signal).catch(() =>
        this.getJson<ExplorerNetworkState>("/info", signal)
      ),
      this.getJson<ExplorerPage<ExplorerRawBox>>(
        `/boxes/unspent/byErgoTree/${ZC_ORACLE_V2_ERGO_TREE}?limit=5`,
        signal
      )
    ]);

    if (!netRes || (netRes.height == null && netRes.fullHeight == null)) {
      throw new ZcApiError("Empty state from Ergo Explorer API", 502, netRes);
    }

    const height = Number(netRes.height ?? netRes.fullHeight ?? 0);
    const blockId = String(netRes.lastBlockId ?? netRes.blockId ?? "").toLowerCase();
    const network = String(netRes.network || "mainnet").toLowerCase();

    const nftBoxes = (oraclePage?.items ?? []).map(mapExplorerBox).filter(holdsOracleNft);
    const oracle = nftBoxes.length === 1 ? readZcOracle(nftBoxes[0]) : null;

    return {
      state: { height, blockId, network },
      oracle
    };
  }

  async fetchAllUnspentZcBoxes(
    signal?: AbortSignal
  ): Promise<{ boxes: ChainBox[]; cut: boolean }> {
    let cut = false;

    const perTree = await mapPool([...ALL_ZC_BOX_TREES], TREE_CONCURRENCY, async (tree) => {
      const list: ChainBox[] = [];
      for (let page = 0; page < MAX_SCAN_PAGES; page++) {
        const offset = page * BOX_PAGE_SIZE;
        const data = await this.getJson<ExplorerPage<ExplorerRawBox>>(
          `/boxes/unspent/byErgoTree/${tree}?offset=${offset}&limit=${BOX_PAGE_SIZE}`,
          signal
        );
        const rows = data?.items ?? [];
        for (const row of rows) list.push(mapExplorerBox(row));
        if (rows.length < BOX_PAGE_SIZE) break;
        if (page === MAX_SCAN_PAGES - 1) cut = true;
      }
      return list;
    });

    const dedup = new Map<string, ChainBox>();
    for (const list of perTree) {
      for (const box of list) {
        if (!dedup.has(box.boxId)) dedup.set(box.boxId, box);
      }
    }

    return { boxes: Array.from(dedup.values()), cut };
  }

  async fetchBoxesByIds(
    boxIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, ChainBox>> {
    const unique = Array.from(new Set(boxIds.map((id) => id.toLowerCase())));
    const out = new Map<string, ChainBox>();
    if (unique.length === 0) return out;

    const rows = await mapPool(unique, ITEM_CONCURRENCY, (id) =>
      this.getJson<ExplorerRawBox>(`/boxes/${id}`, signal, true)
    );
    for (const row of rows) {
      if (!row) continue;
      const mapped = mapExplorerBox(row);
      out.set(mapped.boxId, mapped);
    }
    return out;
  }

  async fetchTransactionsByIds(
    txIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, ChainTransaction>> {
    const unique = Array.from(new Set(txIds.map((id) => id.toLowerCase())));
    const out = new Map<string, ChainTransaction>();
    if (unique.length === 0) return out;

    const rows = await mapPool(unique, TREE_CONCURRENCY, (id) =>
      this.getJson<ExplorerRawTx>(`/transactions/${id}`, signal, true)
    );
    for (const row of rows) {
      if (!row) continue;
      const mapped = mapExplorerTx(row);
      if (mapped.transactionId) out.set(mapped.transactionId, mapped);
    }
    return out;
  }

  async fetchTransactionsByAddresses(
    addresses: readonly string[],
    minHeight: number,
    maxPages = 8,
    signal?: AbortSignal
  ): Promise<ChainTransaction[]> {
    if (addresses.length === 0) return [];
    const dedup = new Map<string, ChainTransaction>();
    const clampedMin = Math.max(0, Math.floor(minHeight));

    await mapPool(addresses, Math.min(3, addresses.length), async (addr) => {
      for (let page = 0; page < maxPages; page++) {
        const offset = page * TX_ADDR_PAGE_SIZE;
        const data = await this.getJson<ExplorerPage<ExplorerRawTx>>(
          `/addresses/${encodeURIComponent(addr)}/transactions?fromHeight=${clampedMin}&offset=${offset}&limit=${TX_ADDR_PAGE_SIZE}`,
          signal,
          true
        );
        const rows = data?.items ?? [];
        for (const row of rows) {
          const tx = mapExplorerTx(row);
          if (tx.transactionId && tx.inclusionHeight >= clampedMin && !dedup.has(tx.transactionId)) {
            dedup.set(tx.transactionId, tx);
          }
        }
        if (rows.length < TX_ADDR_PAGE_SIZE) break;
      }
    });

    return Array.from(dedup.values()).sort((a, b) => b.inclusionHeight - a.inclusionHeight);
  }

  async fetchTokensByIds(
    tokenIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, GraphqlTokenInfo>> {
    const unique = Array.from(new Set(tokenIds.map((id) => id.toLowerCase())));
    const out = new Map<string, GraphqlTokenInfo>();
    if (unique.length === 0) return out;

    const rows = await mapPool(unique, ITEM_CONCURRENCY, (id) =>
      this.getJson<ExplorerRawToken>(`/tokens/${id}`, signal, true)
    );
    for (const row of rows) {
      if (!row) continue;
      const id = String(row.tokenId || row.id || "").toLowerCase();
      if (!id) continue;
      out.set(id, {
        tokenId: id,
        name: row.name ?? null,
        decimals: row.decimals != null ? Number(row.decimals) : null,
        description: row.description ?? null,
        emissionAmount: row.emissionAmount != null ? String(row.emissionAmount) : null
      });
    }
    return out;
  }
}
