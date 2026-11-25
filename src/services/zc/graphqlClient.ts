import { chunk } from "@fleet-sdk/common";
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

export type { ChainState, ChainTransaction, ChainTxDataInput, ChainTxInput, GraphqlTokenInfo };

export const DEFAULT_MAINNET_GRAPHQL_URL = "https://api.ergoscan.me/v1/graphql";
export const SIGMASPACE_GRAPHQL_URL = "https://explore.sigmaspace.io/api/graphql/";
export const DEFAULT_TESTNET_GRAPHQL_URL = "https://tn-ergo-explorer.anetabtc.io/graphql";

const TREE_CHUNK_SIZE = 20;
const BOX_PAGE_SIZE = 50;
const MAX_SCAN_PAGES = 40;
const BOX_ID_CHUNK_SIZE = 20;
const TX_ID_CHUNK_SIZE = 10;
const TOKEN_ID_CHUNK_SIZE = 20;
const TX_ADDR_PAGE_SIZE = 25;
const REQUEST_TIMEOUT_MS = 15_000;

interface RawAsset {
  tokenId: string;
  amount: string | number;
}

interface RawBox {
  boxId: string;
  transactionId: string;
  value: string | number;
  index: number;
  creationHeight: number;
  settlementHeight?: number | null;
  ergoTree: string;
  assets?: RawAsset[] | null;
  additionalRegisters?: Record<string, string> | null;
  spentTransactionId?: string | null;
  spentBy?: {
    transactionId?: string | null;
    transaction?: { inclusionHeight?: number | null } | null;
  } | null;
}

interface RawTx {
  transactionId: string;
  inclusionHeight: number;
  timestamp: string | number;
  inputs?: {
    boxId: string;
    index: number;
    extension?: Record<string, string> | null;
    box?: RawBox | null;
  }[] | null;
  dataInputs?: {
    boxId: string;
    index?: number | null;
    box?: RawBox | null;
  }[] | null;
  outputs?: RawBox[] | null;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message?: string }[];
}

const BOX_FIELDS = `
  boxId
  transactionId
  value
  index
  creationHeight
  settlementHeight
  ergoTree
  assets { tokenId amount }
  additionalRegisters
`;

const STATE_AND_ORACLE_QUERY = `
  query ZcStateAndOracle($oracleTrees: [String!]!) {
    state { height blockId network }
    oracleBoxes: boxes(ergoTrees: $oracleTrees, spent: false, take: 5) {
      ${BOX_FIELDS}
    }
  }
`;

const UNSPENT_BOXES_QUERY = `
  query ZcUnspentBoxes($ergoTrees: [String!]!, $skip: Int!, $take: Int!) {
    boxes(ergoTrees: $ergoTrees, spent: false, skip: $skip, take: $take) {
      ${BOX_FIELDS}
    }
  }
`;

const BOXES_BY_IDS_FULL_QUERY = `
  query ZcBoxesByIds($boxIds: [String!]!) {
    boxes(boxIds: $boxIds, take: 50) {
      ${BOX_FIELDS}
      spentBy {
        transactionId
        transaction { inclusionHeight }
      }
    }
  }
`;

const BOXES_BY_IDS_COMPACT_QUERY = `
  query ZcBoxesByIdsCompact($boxIds: [String!]!) {
    boxes(boxIds: $boxIds, take: 50) {
      ${BOX_FIELDS}
    }
  }
`;

const TX_FIELDS_FULL = `
  transactionId
  inclusionHeight
  timestamp
  inputs {
    boxId
    index
    extension
    box {
      ${BOX_FIELDS}
    }
  }
  dataInputs {
    boxId
    index
    box {
      ${BOX_FIELDS}
    }
  }
  outputs {
    ${BOX_FIELDS}
    spentBy {
      transactionId
      transaction { inclusionHeight }
    }
  }
`;

const TX_FIELDS_COMPACT = `
  transactionId
  inclusionHeight
  timestamp
  inputs {
    boxId
    index
    extension
    box {
      ${BOX_FIELDS}
    }
  }
  dataInputs {
    boxId
  }
  outputs {
    ${BOX_FIELDS}
  }
`;

const TXS_BY_IDS_FULL_QUERY = `
  query ZcTransactionsByIds($txIds: [String!]!) {
    transactions(transactionIds: $txIds, take: 20) {
      ${TX_FIELDS_FULL}
    }
  }
`;

const TXS_BY_IDS_COMPACT_QUERY = `
  query ZcTransactionsByIdsCompact($txIds: [String!]!) {
    transactions(transactionIds: $txIds, take: 20) {
      ${TX_FIELDS_COMPACT}
    }
  }
`;

const TXS_BY_ADDRESSES_FULL_QUERY = `
  query ZcTransactionsByAddresses($addresses: [String!]!, $minHeight: Int!, $skip: Int!, $take: Int!) {
    transactions(addresses: $addresses, minHeight: $minHeight, skip: $skip, take: $take) {
      ${TX_FIELDS_FULL}
    }
  }
`;

const TXS_BY_ADDRESSES_COMPACT_QUERY = `
  query ZcTransactionsByAddressesCompact($addresses: [String!]!, $minHeight: Int!, $skip: Int!, $take: Int!) {
    transactions(addresses: $addresses, minHeight: $minHeight, skip: $skip, take: $take) {
      ${TX_FIELDS_COMPACT}
    }
  }
`;

const TOKENS_BY_IDS_QUERY = `
  query ZcTokensByIds($tokenIds: [String!]!) {
    tokens(tokenIds: $tokenIds, take: 50) {
      tokenId
      name
      decimals
      description
      emissionAmount
    }
  }
`;

function mapBox(raw: RawBox): ChainBox {
  const assets: ChainAsset[] = (raw.assets ?? []).map((a) => ({
    tokenId: String(a.tokenId).toLowerCase(),
    amount: BigInt(a.amount)
  }));
  const regs: Record<string, string> = {};
  if (raw.additionalRegisters) {
    for (const [k, v] of Object.entries(raw.additionalRegisters)) {
      if (typeof v === "string" && v.length > 0) regs[k] = v;
    }
  }
  const spentTxId = raw.spentBy?.transactionId ?? raw.spentTransactionId ?? null;
  return {
    boxId: String(raw.boxId).toLowerCase(),
    transactionId: String(raw.transactionId).toLowerCase(),
    value: BigInt(raw.value),
    index: Number(raw.index ?? 0),
    creationHeight: Number(raw.creationHeight ?? 0),
    settlementHeight: Number(raw.settlementHeight ?? raw.creationHeight ?? 0),
    ergoTree: String(raw.ergoTree).toLowerCase(),
    assets,
    additionalRegisters: regs,
    spentTransactionId: spentTxId ? String(spentTxId).toLowerCase() : null,
    spendingHeight:
      raw.spentBy?.transaction?.inclusionHeight != null
        ? Number(raw.spentBy.transaction.inclusionHeight)
        : null
  };
}

function mapTx(raw: RawTx): ChainTransaction {
  const inputs: ChainTxInput[] = (raw.inputs ?? [])
    .map((inp) => ({
      boxId: String(inp.boxId).toLowerCase(),
      index: Number(inp.index ?? 0),
      extension: inp.extension ?? {},
      box: inp.box ? mapBox(inp.box) : null
    }))
    .sort((a, b) => a.index - b.index);

  const dataInputs: ChainTxDataInput[] = (raw.dataInputs ?? [])
    .map((di, idx) => ({
      boxId: String(di.boxId).toLowerCase(),
      index: Number(di.index ?? idx),
      box: di.box ? mapBox(di.box) : null
    }))
    .sort((a, b) => a.index - b.index);

  const outputs: ChainBox[] = (raw.outputs ?? [])
    .map(mapBox)
    .sort((a, b) => a.index - b.index);

  return {
    transactionId: String(raw.transactionId).toLowerCase(),
    inclusionHeight: Number(raw.inclusionHeight ?? 0),
    timestamp: Number(raw.timestamp ?? 0),
    inputs,
    dataInputs,
    outputs
  };
}

function isFieldSchemaError(err: unknown): boolean {
  if (!(err instanceof ZcApiError)) return false;
  return /Cannot query field/i.test(err.message);
}

/**
 * If the GraphQL endpoint sits on a REST-capable host (e.g. `https://api.ergoscan.me/v1/graphql`),
 * returns its sibling REST prefix (`https://api.ergoscan.me/v1`) for enriching `spentTransactionId`
 * when the GraphQL `Box` type omits `spentBy`.
 */
function siblingRestBase(gqlEndpoint: string): string | null {
  const clean = gqlEndpoint.trim().replace(/\/+$/, "");
  if (clean.endsWith("/v1/graphql")) {
    return clean.slice(0, -"/graphql".length);
  }
  return null;
}

export class ZcGraphqlClient implements ZcChainClient {
  private endpoint: string;
  private compactSchema: boolean;
  private readonly expectedNetwork: string | null;

  constructor(endpoint = DEFAULT_MAINNET_GRAPHQL_URL, expectedNetwork?: string | null) {
    this.endpoint = endpoint;
    this.compactSchema = endpoint.includes("ergoscan");
    this.expectedNetwork = expectedNetwork ? expectedNetwork.trim().toLowerCase() : null;
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  setEndpoint(url: string): void {
    this.endpoint = url.trim() || DEFAULT_MAINNET_GRAPHQL_URL;
    this.compactSchema = this.endpoint.includes("ergoscan");
  }

  private async query<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const timeout = withTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ query, variables }),
        signal: timeout.signal
      });
    } catch (err) {
      timeout.cleanup();
      if (signal?.aborted) throw err;
      throw new ZcApiError(
        timeout.didTimeout() ? "Ergo GraphQL endpoint timed out" : "Ergo GraphQL endpoint unreachable",
        0,
        err
      );
    }
    timeout.cleanup();

    const text = await res.text();
    let json: GraphqlResponse<T> | null = null;
    try {
      json = text ? (JSON.parse(text) as GraphqlResponse<T>) : null;
    } catch {
      // non-json error body
    }

    if (!res.ok) {
      const msg = json?.errors?.[0]?.message || `Ergo GraphQL HTTP ${res.status}`;
      throw new ZcApiError(msg, res.status, json);
    }

    if (json?.errors && json.errors.length > 0 && !json.data) {
      throw new ZcApiError(json.errors[0].message || "Ergo GraphQL query error", 502, json.errors);
    }

    if (!json?.data) {
      throw new ZcApiError("Empty response from Ergo GraphQL", 502, json);
    }

    return json.data;
  }

  private async queryAdaptive<T>(
    fullQuery: string,
    compactQuery: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.compactSchema) {
      return this.query<T>(compactQuery, variables, signal);
    }
    try {
      return await this.query<T>(fullQuery, variables, signal);
    } catch (err) {
      if (isFieldSchemaError(err)) {
        this.compactSchema = true;
        return this.query<T>(compactQuery, variables, signal);
      }
      throw err;
    }
  }

  async fetchStateAndOracle(
    signal?: AbortSignal
  ): Promise<{ state: ChainState; oracle: ZcOracle | null }> {
    const data = await this.query<{
      state: { height: number; blockId: string; network?: string | null };
      oracleBoxes: RawBox[];
    }>(STATE_AND_ORACLE_QUERY, { oracleTrees: [ZC_ORACLE_V2_ERGO_TREE] }, signal);

    const rawReported = data.state.network ? String(data.state.network).trim().toLowerCase() : "";
    const inferredFromUrl = /testnet|tn-/i.test(this.endpoint) ? "testnet" : "";
    const reportedNetwork = rawReported || inferredFromUrl;
    if (
      this.expectedNetwork &&
      reportedNetwork &&
      reportedNetwork !== this.expectedNetwork
    ) {
      throw new ZcApiError(
        `GraphQL endpoint network mismatch: expected ${this.expectedNetwork}, got ${reportedNetwork} (${this.endpoint}).`,
        400
      );
    }

    const state: ChainState = {
      height: Number(data.state.height),
      blockId: String(data.state.blockId).toLowerCase(),
      network: reportedNetwork || this.expectedNetwork || "mainnet"
    };

    const nftBoxes = (data.oracleBoxes ?? []).map(mapBox).filter(holdsOracleNft);
    const oracle = nftBoxes.length === 1 ? readZcOracle(nftBoxes[0]) : null;
    return { state, oracle };
  }

  async fetchAllUnspentZcBoxes(
    signal?: AbortSignal
  ): Promise<{ boxes: ChainBox[]; cut: boolean }> {
    const treeChunks = chunk([...ALL_ZC_BOX_TREES], TREE_CHUNK_SIZE);
    let cut = false;

    const results = await Promise.all(
      treeChunks.map(async (ergoTrees) => {
        const chunkBoxes: ChainBox[] = [];
        for (let page = 0; page < MAX_SCAN_PAGES; page++) {
          const skip = page * BOX_PAGE_SIZE;
          const data = await this.query<{ boxes: RawBox[] }>(
            UNSPENT_BOXES_QUERY,
            { ergoTrees, skip, take: BOX_PAGE_SIZE },
            signal
          );
          const rows = data.boxes ?? [];
          for (const row of rows) chunkBoxes.push(mapBox(row));
          if (rows.length < BOX_PAGE_SIZE) break;
          if (page === MAX_SCAN_PAGES - 1) cut = true;
        }
        return chunkBoxes;
      })
    );

    const dedup = new Map<string, ChainBox>();
    for (const list of results) {
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

    const batches = chunk(unique, BOX_ID_CHUNK_SIZE);
    const results = await Promise.all(
      batches.map((ids) =>
        this.queryAdaptive<{ boxes: RawBox[] }>(
          BOXES_BY_IDS_FULL_QUERY,
          BOXES_BY_IDS_COMPACT_QUERY,
          { boxIds: ids },
          signal
        )
      )
    );

    for (const res of results) {
      for (const row of res.boxes ?? []) {
        const mapped = mapBox(row);
        out.set(mapped.boxId, mapped);
      }
    }

    // If compact GraphQL schema omitted `spentBy`, enrich `spentTransactionId` via sibling REST if available
    const restBase = this.compactSchema ? siblingRestBase(this.endpoint) : null;
    if (restBase && out.size > 0) {
      await Promise.all(
        Array.from(out.values()).map(async (box) => {
          if (box.spentTransactionId) return;
          try {
            const r = await fetch(`${restBase}/boxes/${box.boxId}`, { signal });
            if (!r.ok) return;
            const j = (await r.json()) as { spentTransactionId?: string | null };
            if (j?.spentTransactionId) {
              out.set(box.boxId, {
                ...box,
                spentTransactionId: String(j.spentTransactionId).toLowerCase()
              });
            }
          } catch {
            // fail-soft
          }
        })
      );
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

    const batches = chunk(unique, TX_ID_CHUNK_SIZE);
    const results = await Promise.all(
      batches.map((ids) =>
        this.queryAdaptive<{ transactions: RawTx[] }>(
          TXS_BY_IDS_FULL_QUERY,
          TXS_BY_IDS_COMPACT_QUERY,
          { txIds: ids },
          signal
        )
      )
    );

    for (const res of results) {
      for (const row of res.transactions ?? []) {
        const mapped = mapTx(row);
        out.set(mapped.transactionId, mapped);
      }
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

    for (let page = 0; page < maxPages; page++) {
      const skip = page * TX_ADDR_PAGE_SIZE;
      const data = await this.queryAdaptive<{ transactions: RawTx[] }>(
        TXS_BY_ADDRESSES_FULL_QUERY,
        TXS_BY_ADDRESSES_COMPACT_QUERY,
        { addresses: [...addresses], minHeight: clampedMin, skip, take: TX_ADDR_PAGE_SIZE },
        signal
      );
      const rows = data.transactions ?? [];
      for (const row of rows) {
        const tx = mapTx(row);
        if (!dedup.has(tx.transactionId)) dedup.set(tx.transactionId, tx);
      }
      if (rows.length < TX_ADDR_PAGE_SIZE) break;
    }

    return Array.from(dedup.values());
  }

  async fetchTokensByIds(
    tokenIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, GraphqlTokenInfo>> {
    const unique = Array.from(new Set(tokenIds.map((id) => id.toLowerCase())));
    const out = new Map<string, GraphqlTokenInfo>();
    if (unique.length === 0) return out;

    const batches = chunk(unique, TOKEN_ID_CHUNK_SIZE);
    const results = await Promise.all(
      batches.map((ids) =>
        this.query<{
          tokens: {
            tokenId: string;
            name?: string | null;
            decimals?: number | null;
            description?: string | null;
            emissionAmount?: string | null;
          }[];
        }>(TOKENS_BY_IDS_QUERY, { tokenIds: ids }, signal)
      )
    );

    for (const res of results) {
      for (const row of res.tokens ?? []) {
        const id = String(row.tokenId).toLowerCase();
        out.set(id, {
          tokenId: id,
          name: row.name ?? null,
          decimals: row.decimals != null ? Number(row.decimals) : null,
          description: row.description ?? null,
          emissionAmount: row.emissionAmount != null ? String(row.emissionAmount) : null
        });
      }
    }
    return out;
  }
}
