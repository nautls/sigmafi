import { blake2b256, hex } from "@fleet-sdk/crypto";
import {
  ChainBox,
  DISCLOSURE_VAR,
  disclosedTrees,
  isMinter,
  MAX_SCRIPT_CHARS,
  originOf,
  readZcBox,
  ZcOrigin,
  ZcRecord
} from "./boxes";
import { ChainTransaction, GraphqlTokenInfo, ZcChainClient } from "./chainClient";
import { ZcMarketBook } from "./matcher";

const RETRY_BLOCKS = 30;
const MAX_CHAIN_STEPS = 64;
const MAX_CACHE_ENTRIES = 50_000;

export interface ChainRootInfo {
  readonly rootId: string;
  readonly initialValue: bigint;
}

function hashTreeHex(treeHex: string): string | null {
  if (!treeHex || treeHex.length > MAX_SCRIPT_CHARS || treeHex.length % 2 !== 0) return null;
  try {
    return hex.encode(blake2b256(hex.decode(treeHex)));
  } catch {
    return null;
  }
}

function extractCarriedScripts(tx: ChainTransaction): Map<string, string> {
  const out = new Map<string, string>();
  const addTree = (treeHex: string) => {
    const clean = treeHex.toLowerCase();
    const h = hashTreeHex(clean);
    if (h) out.set(h, clean);
  };

  for (const inp of tx.inputs) {
    const discRaw = inp.extension[DISCLOSURE_VAR];
    if (typeof discRaw === "string" && discRaw.length > 0) {
      for (const t of disclosedTrees(discRaw)) addTree(t);
    }
    if (inp.box?.ergoTree) addTree(inp.box.ergoTree);
  }
  for (const outBox of tx.outputs) {
    if (outBox.ergoTree) addTree(outBox.ergoTree);
  }
  return out;
}

function mintedOrigin(box: ChainBox): ZcOrigin | null {
  if (!box.spentTransactionId) return null;
  const rec = readZcBox(box);
  if (!rec || !isMinter(rec)) return null;
  return originOf(rec, box.spentTransactionId, box.spendingHeight ?? null);
}

function predecessorOf(r: ZcRecord): string | null {
  if (r.recordType === "offer") return r.predecessor;
  if (r.recordType === "ask") return r.predecessor;
  return null;
}

function trimMap<K, V>(map: Map<K, V>): void {
  if (map.size < MAX_CACHE_ENTRIES) return;
  let drop = Math.floor(MAX_CACHE_ENTRIES / 8) + 1;
  for (const k of map.keys()) {
    map.delete(k);
    if (--drop <= 0) break;
  }
}

/**
 * Batched client-side port of Lithos-Client's ZcResolver.
 * Permanently caches verified token origins, disclosed party scripts, chain roots,
 * and token metadata, with a 30-block negative cache for unverified items.
 */
export class ZcResolver {
  private readonly origins = new Map<string, ZcOrigin>();
  private readonly scripts = new Map<string, string>();
  private readonly roots = new Map<string, ChainRootInfo>();
  private readonly tokenMeta = new Map<string, GraphqlTokenInfo>();
  private readonly missing = new Map<string, number>();
  private _generation = 0;

  constructor(private readonly getClient: () => ZcChainClient) {}

  private get gql(): ZcChainClient {
    return this.getClient();
  }

  get generation(): number {
    return this._generation;
  }

  clear(): void {
    this.origins.clear();
    this.scripts.clear();
    this.roots.clear();
    this.tokenMeta.clear();
    this.missing.clear();
    this._generation++;
  }

  private tried(key: string, height: number): boolean {
    const until = this.missing.get(key);
    return until !== undefined && until > height;
  }

  private miss(key: string, height: number): void {
    const wasTried = this.tried(key, height);
    trimMap(this.missing);
    this.missing.set(key, height + RETRY_BLOCKS);
    if (!wasTried && key.startsWith("s:")) this._generation++;
  }

  knownOrigin(token: string): ZcOrigin | null {
    return this.origins.get(token.toLowerCase()) ?? null;
  }

  knownScript(hash: string): string | null {
    return this.scripts.get(hash.toLowerCase()) ?? null;
  }

  knownDisclosed(record: ZcRecord, height: number): boolean | null {
    if (record.namedHash === null) return true;
    if (this.scripts.has(record.namedHash)) return true;
    if (this.tried(`s:${record.boxId}`, height)) return false;
    return null;
  }

  knownChainRoot(record: ZcRecord): ChainRootInfo | null {
    const cached = this.roots.get(record.boxId);
    if (cached) return cached;
    if (predecessorOf(record) === null) {
      return { rootId: record.boxId, initialValue: record.box.value };
    }
    return null;
  }

  knownToken(tokenId: string): GraphqlTokenInfo | null {
    return this.tokenMeta.get(tokenId.toLowerCase()) ?? null;
  }

  private rememberScripts(found: ReadonlyMap<string, string>): void {
    for (const [h, tree] of found) {
      if (!this.scripts.has(h)) {
        trimMap(this.scripts);
        this.scripts.set(h, tree);
        this._generation++;
      }
    }
  }

  async resolveOrigins(
    tokenIds: readonly string[],
    height: number,
    signal?: AbortSignal
  ): Promise<void> {
    const needed: string[] = [];
    for (const raw of tokenIds) {
      const id = raw.toLowerCase();
      if (this.origins.has(id) || this.tried(`o:${id}`, height)) continue;
      needed.push(id);
    }
    const unique = Array.from(new Set(needed));
    if (unique.length === 0) return;

    const boxes = await this.gql.fetchBoxesByIds(unique, signal);
    for (const id of unique) {
      const box = boxes.get(id);
      const orig = box ? mintedOrigin(box) : null;
      if (orig) {
        trimMap(this.origins);
        if (!this.origins.has(id)) this._generation++;
        this.origins.set(id, orig);
      } else {
        this.miss(`o:${id}`, height);
      }
    }
  }

  async resolveDisclosures(
    records: readonly ZcRecord[],
    height: number,
    signal?: AbortSignal
  ): Promise<void> {
    const pending: ZcRecord[] = [];
    for (const r of records) {
      if (r.namedHash === null) continue;
      if (this.scripts.has(r.namedHash)) continue;
      if (this.tried(`s:${r.boxId}`, height)) continue;
      pending.push(r);
    }
    if (pending.length === 0) return;

    const txIds = new Set<string>();
    for (const r of pending) {
      if (r.box.transactionId) txIds.add(r.box.transactionId);
    }
    if (txIds.size === 0) return;

    const txMap = await this.gql.fetchTransactionsByIds(Array.from(txIds), signal);

    const extraBondFillTxIds = new Set<string>();
    for (const r of pending) {
      const tx = txMap.get(r.box.transactionId);
      if (!tx) continue;
      const carried = extractCarriedScripts(tx);
      this.rememberScripts(carried);
      if (r.recordType === "bond" && r.namedHash && !this.scripts.has(r.namedHash)) {
        const orig = this.knownOrigin(r.asset);
        if (orig && orig.txId && !txMap.has(orig.txId)) {
          extraBondFillTxIds.add(orig.txId);
        }
      }
    }

    if (extraBondFillTxIds.size > 0) {
      const extraTxs = await this.gql.fetchTransactionsByIds(
        Array.from(extraBondFillTxIds),
        signal
      );
      for (const [id, tx] of extraTxs) {
        txMap.set(id, tx);
        this.rememberScripts(extractCarriedScripts(tx));
      }
    }

    for (const r of pending) {
      if (r.namedHash === null || this.scripts.has(r.namedHash)) continue;
      const hadBoxTx = txMap.has(r.box.transactionId);
      if (!hadBoxTx) continue;
      if (r.recordType === "bond") {
        const orig = this.knownOrigin(r.asset);
        const hadFillTx = orig !== null && txMap.has(orig.txId);
        if (hadFillTx) this.miss(`s:${r.boxId}`, height);
      } else {
        this.miss(`s:${r.boxId}`, height);
      }
    }
  }

  async resolveChainRoots(
    records: readonly ZcRecord[],
    height: number,
    signal?: AbortSignal
  ): Promise<void> {
    interface Walk {
      at: ZcRecord;
      path: string[];
    }
    const active: Walk[] = [];
    for (const r of records) {
      if (this.roots.has(r.boxId)) continue;
      const pred = predecessorOf(r);
      if (pred === null) {
        trimMap(this.roots);
        this.roots.set(r.boxId, { rootId: r.boxId, initialValue: r.box.value });
        continue;
      }
      if (!this.tried(`c:${r.boxId}`, height)) {
        active.push({ at: r, path: [] });
      }
    }

    let step = 0;
    let queue = active;
    while (queue.length > 0 && step < MAX_CHAIN_STEPS) {
      step++;
      const predIds = new Set<string>();
      for (const w of queue) {
        const pred = predecessorOf(w.at);
        if (pred) predIds.add(pred);
      }
      if (predIds.size === 0) break;

      const boxes = await this.gql.fetchBoxesByIds(Array.from(predIds), signal);
      const nextQueue: Walk[] = [];

      for (const w of queue) {
        const predId = predecessorOf(w.at);
        if (!predId) {
          const root: ChainRootInfo = { rootId: w.at.boxId, initialValue: w.at.box.value };
          this.cacheChain(w.at.boxId, w.path, root);
          continue;
        }
        const cached = this.roots.get(predId);
        if (cached) {
          this.cacheChain(w.at.boxId, w.path, cached);
          continue;
        }
        const found = boxes.get(predId);
        const linked =
          found && found.spentTransactionId === w.at.box.transactionId ? readZcBox(found) : null;
        if (
          linked &&
          linked.script === w.at.script &&
          linked.namedHash === w.at.namedHash
        ) {
          const nextPath = [...w.path, w.at.boxId];
          const nextPred = predecessorOf(linked);
          if (nextPred === null) {
            const root: ChainRootInfo = { rootId: linked.boxId, initialValue: linked.box.value };
            this.cacheChain(linked.boxId, nextPath, root);
          } else {
            const hit = this.roots.get(nextPred);
            if (hit) {
              this.cacheChain(linked.boxId, nextPath, hit);
            } else if (!this.tried(`c:${linked.boxId}`, height)) {
              nextQueue.push({ at: linked, path: nextPath });
            }
          }
        } else {
          this.miss(`c:${w.at.boxId}`, height);
        }
      }

      queue = nextQueue;
    }
  }

  private cacheChain(headId: string, path: readonly string[], root: ChainRootInfo): void {
    trimMap(this.roots);
    this.roots.set(headId, root);
    for (const id of path) {
      this.roots.set(id, root);
    }
  }

  async resolveTokens(
    tokenIds: readonly string[],
    height: number,
    signal?: AbortSignal
  ): Promise<void> {
    const needed: string[] = [];
    for (const raw of tokenIds) {
      const id = raw.toLowerCase();
      if (this.tokenMeta.has(id) || this.tried(`t:${id}`, height)) continue;
      needed.push(id);
    }
    const unique = Array.from(new Set(needed));
    if (unique.length === 0) return;

    const fetched = await this.gql.fetchTokensByIds(unique, signal);
    for (const id of unique) {
      const info = fetched.get(id);
      if (info) {
        trimMap(this.tokenMeta);
        this.tokenMeta.set(id, info);
      } else {
        this.miss(`t:${id}`, height);
      }
    }
  }

  /**
   * Batched warm-up pass for a freshly fetched market book: resolves unknown origins,
   * script disclosures, and offer/ask chain roots in parallel GraphQL batches.
   */
  async warmForBook(book: ZcMarketBook, signal?: AbortSignal): Promise<void> {
    const height = book.height;
    const originIds: string[] = [];
    for (const a of book.asks) originIds.push(a.record.token.tokenId);
    for (const v of book.shareVaults.values()) {
      originIds.push(v.record.shareId, v.record.bondAsset);
    }
    for (const asset of book.bonds.keys()) originIds.push(asset);
    for (const asset of book.settlements.keys()) originIds.push(asset);
    for (const receipt of book.wrapVaults.keys()) originIds.push(receipt);

    const chainRecords: ZcRecord[] = [];
    for (const o of book.offers) {
      if (o.record.predecessor) chainRecords.push(o.record);
    }
    for (const a of book.asks) {
      if (a.record.predecessor) chainRecords.push(a.record);
    }

    const disclosureRecords: ZcRecord[] = [
      ...book.orders.map((x) => x.record),
      ...book.asks.map((x) => x.record),
      ...book.offers.map((x) => x.record),
      ...Array.from(book.bonds.values()).map((x) => x.record)
    ];

    // Step 1: resolve origins & chain roots in parallel (fail-soft on flaky endpoints)
    const soft = async (p: Promise<void>) => {
      try {
        await p;
      } catch (err) {
        if (signal?.aborted || (err as Error)?.name === "AbortError") throw err;
      }
    };

    await Promise.all([
      soft(this.resolveOrigins(originIds, height, signal)),
      soft(this.resolveChainRoots(chainRecords, height, signal))
    ]);

    // Step 2: if any newly learned share mint holds a bond asset whose origin is unknown, resolve it too
    const secondPassOrigins: string[] = [];
    for (const a of book.asks) {
      const orig = this.knownOrigin(a.record.token.tokenId);
      if (orig?.held && !this.origins.has(orig.held.tokenId)) {
        secondPassOrigins.push(orig.held.tokenId);
      }
    }

    // Step 3: resolve script disclosures (after origins so bond fill txs are known) + any secondary origins
    await Promise.all([
      soft(this.resolveDisclosures(disclosureRecords, height, signal)),
      secondPassOrigins.length > 0
        ? soft(this.resolveOrigins(secondPassOrigins, height, signal))
        : Promise.resolve()
    ]);
  }
}
