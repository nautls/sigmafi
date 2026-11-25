import { blake2b256, hex } from "@fleet-sdk/crypto";
import {
  ChainBox,
  disclosedTrees,
  DISCLOSURE_VAR,
  isMinter,
  MAX_SCRIPT_CHARS,
  originOf,
  readZcBox,
  ZcOrigin,
  ZcRecord
} from "./boxes";
import { ChainTransaction, GraphqlTokenInfo, ZcChainClient } from "./chainClient";
import { ZC_PINNED_COMMIT, ZcKind } from "./contracts";
import { ZcMarketBook } from "./matcher";
import { ZcMarket } from "@/types/zc";

const RETRY_BLOCKS = 30;
const MAX_CHAIN_STEPS = 64;
const MAX_CACHE_ENTRIES = 50_000;
const MAX_PERSISTED_ENTRIES = 2_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 1_000;
const RESOLVER_CACHE_PREFIX = "sigmafi.zc.resolverCache.v1";

const VALID_ZC_KINDS = new Set<ZcKind>([
  "BondVault",
  "FractionalVault",
  "FractionalMint",
  "DutchAuctionVault",
  "WrapVault",
  "WrapMint",
  "Bond",
  "Order",
  "LendOffer",
  "SaleOrder",
  "PricedAsk",
  "DutchAuctionMint",
  "PricedOrder",
  "LotAuction"
]);

export interface ChainRootInfo {
  readonly rootId: string;
  readonly initialValue: bigint;
}

export interface ResolverStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ZcResolverOptions {
  readonly network?: string;
  readonly storage?: ResolverStorageLike | null;
  readonly persistDebounceMs?: number;
}

interface SerializedOrigin {
  token: string;
  kind: ZcKind;
  market: ZcMarket | null;
  txId: string;
  height: number | null;
  terms: string[];
  held: { tokenId: string; amount: string } | null;
}

interface SerializedRoot {
  rootId: string;
  initialValue: string;
}

interface PersistedResolverPayload {
  v: 1;
  origins: [string, SerializedOrigin][];
  scripts: [string, string][];
  roots: [string, SerializedRoot][];
}

export function resolverCacheStorageKey(network: string): string {
  const cleanNet = (network || "mainnet").trim().toLowerCase() || "mainnet";
  return `${RESOLVER_CACHE_PREFIX}:${cleanNet}:${ZC_PINNED_COMMIT}`;
}

function defaultStorage(): ResolverStorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
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

function trimMap<K, V>(map: Map<K, V>, cap = MAX_CACHE_ENTRIES): void {
  if (map.size < cap) return;
  let drop = Math.max(1, map.size - cap + Math.floor(cap / 8) + 1);
  for (const k of map.keys()) {
    map.delete(k);
    if (--drop <= 0) break;
  }
}

function serializeOrigin(o: ZcOrigin): SerializedOrigin {
  return {
    token: o.token,
    kind: o.kind,
    market: o.market,
    txId: o.txId,
    height: o.height,
    terms: o.terms.map((t) => t.toString()),
    held: o.held ? { tokenId: o.held.tokenId, amount: o.held.amount.toString() } : null
  };
}

function deserializeOrigin(raw: unknown): ZcOrigin | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.token !== "string" || !r.token) return null;
  if (typeof r.kind !== "string" || !VALID_ZC_KINDS.has(r.kind as ZcKind)) return null;
  if (r.market !== null && r.market !== "ERG" && r.market !== "SigUSD") return null;
  if (typeof r.txId !== "string" || !r.txId) return null;
  if (r.height !== null && typeof r.height !== "number") return null;
  if (!Array.isArray(r.terms)) return null;

  try {
    const terms = r.terms.map((x) => BigInt(String(x)));
    let held: { tokenId: string; amount: bigint } | null = null;
    if (r.held !== null) {
      if (!r.held || typeof r.held !== "object") return null;
      const h = r.held as Record<string, unknown>;
      if (typeof h.tokenId !== "string" || !h.tokenId) return null;
      held = { tokenId: h.tokenId.toLowerCase(), amount: BigInt(String(h.amount)) };
    }
    return {
      token: r.token.toLowerCase(),
      kind: r.kind as ZcKind,
      market: r.market as ZcMarket | null,
      txId: r.txId.toLowerCase(),
      height: r.height as number | null,
      terms,
      held
    };
  } catch {
    return null;
  }
}

function deserializeRoot(raw: unknown): ChainRootInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.rootId !== "string" || !r.rootId) return null;
  try {
    return {
      rootId: r.rootId.toLowerCase(),
      initialValue: BigInt(String(r.initialValue))
    };
  } catch {
    return null;
  }
}

/**
 * Batched client-side port of Lithos-Client's ZcResolver.
 * Permanently caches verified token origins, disclosed party scripts, chain roots,
 * and token metadata, with a 30-block negative cache for unverified items and
 * debounced `localStorage` persistence for immutable confirmed facts.
 */
export class ZcResolver {
  private readonly origins = new Map<string, ZcOrigin>();
  private readonly scripts = new Map<string, string>();
  private readonly roots = new Map<string, ChainRootInfo>();
  private readonly tokenMeta = new Map<string, GraphqlTokenInfo>();
  private readonly missing = new Map<string, number>();
  private readonly storage: ResolverStorageLike | null;
  private readonly persistDebounceMs: number;
  private network: string;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private _generation = 0;

  constructor(
    private readonly getClient: () => ZcChainClient,
    options: ZcResolverOptions = {}
  ) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.persistDebounceMs = Math.max(0, options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS);
    this.network = (options.network || "mainnet").trim().toLowerCase() || "mainnet";
    this.hydrateFromStorage();
  }

  private get gql(): ZcChainClient {
    return this.getClient();
  }

  get generation(): number {
    return this._generation;
  }

  getNetwork(): string {
    return this.network;
  }

  /**
   * Switches the active network scope for persisted confirmed facts.
   * When switching networks, clears in-memory state and hydrates from the target network's cache.
   */
  setNetwork(network: string): void {
    const clean = (network || "mainnet").trim().toLowerCase() || "mainnet";
    if (clean === this.network) return;
    this.cancelPersistTimer();
    this.network = clean;
    this.origins.clear();
    this.scripts.clear();
    this.roots.clear();
    this.tokenMeta.clear();
    this.missing.clear();
    this._generation++;
    this.hydrateFromStorage();
  }

  /**
   * Clears transient negative-cache and token-metadata entries while keeping immutable
   * confirmed origins, disclosed scripts, and chain roots intact across transport switches.
   */
  clearTransient(): void {
    this.tokenMeta.clear();
    this.missing.clear();
  }

  /**
   * Clears in-memory resolver caches. Pass `{ purgePersisted: true }` to also delete the
   * persisted `localStorage` entry for the current network.
   */
  clear(options?: { purgePersisted?: boolean }): void {
    this.cancelPersistTimer();
    this.origins.clear();
    this.scripts.clear();
    this.roots.clear();
    this.tokenMeta.clear();
    this.missing.clear();
    this._generation++;
    if (options?.purgePersisted && this.storage) {
      try {
        this.storage.removeItem(resolverCacheStorageKey(this.network));
      } catch {
        // storage unavailable
      }
    }
  }

  /**
   * Immediately writes immutable confirmed caches (`origins`, `scripts`, `roots`) to storage.
   */
  flushPersistence(): void {
    this.cancelPersistTimer();
    this.writeToStorage();
  }

  private cancelPersistTimer(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private schedulePersist(): void {
    if (!this.storage) return;
    if (this.persistDebounceMs === 0) {
      this.writeToStorage();
      return;
    }
    this.cancelPersistTimer();
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeToStorage();
    }, this.persistDebounceMs);
  }

  private hydrateFromStorage(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(resolverCacheStorageKey(this.network));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedResolverPayload>;
      if (!parsed || parsed.v !== 1) return;

      if (Array.isArray(parsed.origins)) {
        for (const pair of parsed.origins.slice(-MAX_PERSISTED_ENTRIES)) {
          if (!Array.isArray(pair) || pair.length !== 2) continue;
          const [key, val] = pair;
          if (typeof key !== "string" || !key) continue;
          const origin = deserializeOrigin(val);
          if (origin) this.origins.set(key.toLowerCase(), origin);
        }
      }

      if (Array.isArray(parsed.scripts)) {
        for (const pair of parsed.scripts.slice(-MAX_PERSISTED_ENTRIES)) {
          if (!Array.isArray(pair) || pair.length !== 2) continue;
          const [hash, tree] = pair;
          if (typeof hash === "string" && typeof tree === "string" && hash && tree) {
            this.scripts.set(hash.toLowerCase(), tree.toLowerCase());
          }
        }
      }

      if (Array.isArray(parsed.roots)) {
        for (const pair of parsed.roots.slice(-MAX_PERSISTED_ENTRIES)) {
          if (!Array.isArray(pair) || pair.length !== 2) continue;
          const [boxId, val] = pair;
          if (typeof boxId !== "string" || !boxId) continue;
          const root = deserializeRoot(val);
          if (root) this.roots.set(boxId.toLowerCase(), root);
        }
      }
    } catch {
      // ignore corrupted or inaccessible storage
    }
  }

  private writeToStorage(): void {
    if (!this.storage) return;
    try {
      const originsEntries = Array.from(this.origins.entries())
        .slice(-MAX_PERSISTED_ENTRIES)
        .map(([k, v]): [string, SerializedOrigin] => [k, serializeOrigin(v)]);
      const scriptsEntries = Array.from(this.scripts.entries()).slice(-MAX_PERSISTED_ENTRIES);
      const rootsEntries = Array.from(this.roots.entries())
        .slice(-MAX_PERSISTED_ENTRIES)
        .map(([k, v]): [string, SerializedRoot] => [
          k,
          { rootId: v.rootId, initialValue: v.initialValue.toString() }
        ]);

      const payload: PersistedResolverPayload = {
        v: 1,
        origins: originsEntries,
        scripts: scriptsEntries,
        roots: rootsEntries
      };
      this.storage.setItem(resolverCacheStorageKey(this.network), JSON.stringify(payload));
    } catch {
      // ignore quota / storage errors
    }
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
    let added = false;
    for (const [h, tree] of found) {
      if (!this.scripts.has(h)) {
        trimMap(this.scripts);
        this.scripts.set(h, tree);
        this._generation++;
        added = true;
      }
    }
    if (added) this.schedulePersist();
  }

  async resolveOrigins(
    tokenIds: readonly string[],
    height: number,
    signal?: AbortSignal,
    options?: { cacheMisses?: boolean }
  ): Promise<void> {
    const cacheMisses = options?.cacheMisses ?? true;
    const needed: string[] = [];
    for (const raw of tokenIds) {
      const id = raw.toLowerCase();
      if (this.origins.has(id) || this.tried(`o:${id}`, height)) continue;
      needed.push(id);
    }
    const unique = Array.from(new Set(needed));
    if (unique.length === 0) return;

    const boxes = await this.gql.fetchBoxesByIds(unique, signal);
    let added = false;
    for (const id of unique) {
      const box = boxes.get(id);
      const orig = box ? mintedOrigin(box) : null;
      if (orig) {
        trimMap(this.origins);
        if (!this.origins.has(id)) {
          this._generation++;
          added = true;
        }
        this.origins.set(id, orig);
      } else if (cacheMisses) {
        this.miss(`o:${id}`, height);
      }
    }
    if (added) this.schedulePersist();
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
    signal?: AbortSignal,
    options?: { cacheMisses?: boolean }
  ): Promise<void> {
    const cacheMisses = options?.cacheMisses ?? true;
    interface Walk {
      at: ZcRecord;
      path: string[];
    }
    const active: Walk[] = [];
    for (const r of records) {
      if (this.roots.has(r.boxId)) continue;
      const pred = predecessorOf(r);
      if (pred === null) {
        if (cacheMisses) {
          trimMap(this.roots);
          this.roots.set(r.boxId, { rootId: r.boxId, initialValue: r.box.value });
          this.schedulePersist();
        }
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
          this.cacheChain(w.at.boxId, w.path, root, cacheMisses);
          continue;
        }
        const cached = this.roots.get(predId);
        if (cached) {
          this.cacheChain(w.at.boxId, w.path, cached, cacheMisses);
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
            this.cacheChain(linked.boxId, nextPath, root, cacheMisses);
          } else {
            const hit = this.roots.get(nextPred);
            if (hit) {
              this.cacheChain(linked.boxId, nextPath, hit, cacheMisses);
            } else if (!this.tried(`c:${linked.boxId}`, height)) {
              nextQueue.push({ at: linked, path: nextPath });
            }
          }
        } else if (cacheMisses) {
          this.miss(`c:${w.at.boxId}`, height);
        }
      }

      queue = nextQueue;
    }
  }

  private cacheChain(
    headId: string,
    path: readonly string[],
    root: ChainRootInfo,
    persist = true
  ): void {
    trimMap(this.roots);
    let changed = !this.roots.has(headId);
    this.roots.set(headId, root);
    for (const id of path) {
      if (!this.roots.has(id)) changed = true;
      this.roots.set(id, root);
    }
    if (changed && persist) {
      this._generation++;
      this.schedulePersist();
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
   * script disclosures, and offer/ask chain roots in parallel batches.
   *
   * Mempool-safe: skips disclosure lookups for `pending: true` records (preventing wasted
   * 404s and 30-block negative-cache poisoning before confirmation) and disables negative
   * caching for origin/chain lookups referenced only by pending boxes.
   */
  async warmForBook(book: ZcMarketBook, signal?: AbortSignal): Promise<void> {
    const height = book.height;
    const confirmedOriginSet = new Set<string>();
    const pendingOriginSet = new Set<string>();

    const collectOrigin = (tokenId: string, pending: boolean) => {
      const low = tokenId.toLowerCase();
      if (pending) pendingOriginSet.add(low);
      else confirmedOriginSet.add(low);
    };

    for (const a of book.asks) collectOrigin(a.record.token.tokenId, a.pending);
    for (const v of book.shareVaults.values()) {
      collectOrigin(v.record.shareId, v.pending);
      collectOrigin(v.record.bondAsset, v.pending);
    }
    for (const [asset, b] of book.bonds) collectOrigin(asset, b.pending);
    for (const [asset, s] of book.settlements) collectOrigin(asset, s.pending);
    for (const [receipt, w] of book.wrapVaults) collectOrigin(receipt, w.pending);

    const confirmedOriginIds = Array.from(confirmedOriginSet);
    const pendingOnlyOriginIds = Array.from(pendingOriginSet).filter(
      (id) => !confirmedOriginSet.has(id)
    );

    const confirmedChainRecords: ZcRecord[] = [];
    const pendingChainRecords: ZcRecord[] = [];
    for (const o of book.offers) {
      if (!o.record.predecessor) continue;
      if (o.pending) pendingChainRecords.push(o.record);
      else confirmedChainRecords.push(o.record);
    }
    for (const a of book.asks) {
      if (!a.record.predecessor) continue;
      if (a.pending) pendingChainRecords.push(a.record);
      else confirmedChainRecords.push(a.record);
    }

    // Only resolve creating-tx script disclosures for confirmed boxes (mempool txs are not in Explorer).
    const disclosureRecords: ZcRecord[] = [
      ...book.orders.filter((x) => !x.pending).map((x) => x.record),
      ...book.asks.filter((x) => !x.pending).map((x) => x.record),
      ...book.offers.filter((x) => !x.pending).map((x) => x.record),
      ...Array.from(book.bonds.values())
        .filter((x) => !x.pending)
        .map((x) => x.record)
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
      soft(this.resolveOrigins(confirmedOriginIds, height, signal, { cacheMisses: true })),
      pendingOnlyOriginIds.length > 0
        ? soft(this.resolveOrigins(pendingOnlyOriginIds, height, signal, { cacheMisses: false }))
        : Promise.resolve(),
      soft(this.resolveChainRoots(confirmedChainRecords, height, signal, { cacheMisses: true })),
      pendingChainRecords.length > 0
        ? soft(this.resolveChainRoots(pendingChainRecords, height, signal, { cacheMisses: false }))
        : Promise.resolve()
    ]);

    // Step 2: if any newly learned share mint holds a bond asset whose origin is unknown, resolve it too
    const secondPassConfirmed: string[] = [];
    const secondPassPending: string[] = [];
    for (const a of book.asks) {
      const orig = this.knownOrigin(a.record.token.tokenId);
      if (orig?.held && !this.origins.has(orig.held.tokenId)) {
        if (a.pending) secondPassPending.push(orig.held.tokenId);
        else secondPassConfirmed.push(orig.held.tokenId);
      }
    }
    const secondConfirmedSet = new Set(secondPassConfirmed);
    const secondPendingOnly = secondPassPending.filter((id) => !secondConfirmedSet.has(id));

    // Step 3: resolve script disclosures (after origins so bond fill txs are known) + any secondary origins
    await Promise.all([
      soft(this.resolveDisclosures(disclosureRecords, height, signal)),
      secondPassConfirmed.length > 0
        ? soft(this.resolveOrigins(secondPassConfirmed, height, signal, { cacheMisses: true }))
        : Promise.resolve(),
      secondPendingOnly.length > 0
        ? soft(this.resolveOrigins(secondPendingOnly, height, signal, { cacheMisses: false }))
        : Promise.resolve()
    ]);
  }
}
