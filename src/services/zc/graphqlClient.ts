import { chunk } from "@fleet-sdk/common";
import { ChainAsset, ChainBox, holdsOracleNft, readZcOracle, ZcOracle } from "./boxes";
import { ALL_ZC_BOX_TREES, ZC_ORACLE_V2_ERGO_TREE } from "./contracts";
import { ZcApiError } from "./errors";

export const DEFAULT_MAINNET_GRAPHQL_URL = "https://explore.sigmaspace.io/api/graphql/";
export const DEFAULT_TESTNET_GRAPHQL_URL = "https://tn-ergo-explorer.anetabtc.io/graphql";

const TREE_CHUNK_SIZE = 20;
const BOX_PAGE_SIZE = 50;
const MAX_SCAN_PAGES = 40;
const BOX_ID_CHUNK_SIZE = 20;
const TX_ID_CHUNK_SIZE = 10;
const TOKEN_ID_CHUNK_SIZE = 20;
const TX_ADDR_PAGE_SIZE = 25;

export interface ChainState {
  readonly height: number;
  readonly blockId: string;
  readonly network: string;
}

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

export interface GraphqlTokenInfo {
  readonly tokenId: string;
  readonly name: string | null;
  readonly decimals: number | null;
  readonly description: string | null;
  readonly emissionAmount: string | null;
}

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
    index: number;
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

const BOXES_BY_IDS_QUERY = `
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

const TX_FIELDS = `
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

const TXS_BY_IDS_QUERY = `
  query ZcTransactionsByIds($txIds: [String!]!) {
    transactions(transactionIds: $txIds, take: 20) {
      ${TX_FIELDS}
    }
  }
`;

const TXS_BY_ADDRESSES_QUERY = `
  query ZcTransactionsByAddresses($addresses: [String!]!, $minHeight: Int!, $skip: Int!, $take: Int!) {
    transactions(addresses: $addresses, minHeight: $minHeight, skip: $skip, take: $take) {
      ${TX_FIELDS}
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
    spentTransactionId: raw.spentBy?.transactionId
      ? String(raw.spentBy.transactionId).toLowerCase()
      : null,
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
    .map((di) => ({
      boxId: String(di.boxId).toLowerCase(),
      index: Number(di.index ?? 0),
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

export class ZcGraphqlClient {
  private endpoint: string;

  constructor(endpoint = DEFAULT_MAINNET_GRAPHQL_URL) {
    this.endpoint = endpoint;
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  setEndpoint(url: string): void {
    this.endpoint = url.trim() || DEFAULT_MAINNET_GRAPHQL_URL;
  }

  private async query<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ query, variables }),
        signal
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      throw new ZcApiError("Ergo GraphQL endpoint unreachable", 0, err);
    }

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

  async fetchStateAndOracle(
    signal?: AbortSignal
  ): Promise<{ state: ChainState; oracle: ZcOracle | null }> {
    const data = await this.query<{
      state: { height: number; blockId: string; network?: string | null };
      oracleBoxes: RawBox[];
    }>(STATE_AND_ORACLE_QUERY, { oracleTrees: [ZC_ORACLE_V2_ERGO_TREE] }, signal);

    const state: ChainState = {
      height: Number(data.state.height),
      blockId: String(data.state.blockId).toLowerCase(),
      network: String(data.state.network || "mainnet").toLowerCase()
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
        this.query<{ boxes: RawBox[] }>(BOXES_BY_IDS_QUERY, { boxIds: ids }, signal)
      )
    );

    for (const res of results) {
      for (const row of res.boxes ?? []) {
        const mapped = mapBox(row);
        out.set(mapped.boxId, mapped);
      }
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
        this.query<{ transactions: RawTx[] }>(TXS_BY_IDS_QUERY, { txIds: ids }, signal)
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
      const data = await this.query<{ transactions: RawTx[] }>(
        TXS_BY_ADDRESSES_QUERY,
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
