import { Box, Network, SignedTransaction } from "@fleet-sdk/common";
import {
  BlockRef,
  ConfirmedBox,
  Key,
  Relay,
  RelayError,
  RelayOptions,
  RestClient,
  SubscribeOptions,
  Subscription,
  SubscriptionError,
  SubscriptionState
} from "@hergmes/sdk";
import { ChainAsset, ChainBox, holdsOracleNft, readZcOracle, ZcOracle } from "./boxes";
import {
  ChainState,
  ChainTransaction,
  GraphqlTokenInfo,
  HergmesStreamPhase,
  LiveZcSnapshot,
  withTimeoutSignal,
  ZcChainClient,
  ZcTxCheckResult
} from "./chainClient";
import {
  getZcScriptAddress,
  ZC_ORACLE_V2_NFT,
  ZC_SCRIPTS,
  ZcKind,
  ZcScript
} from "./contracts";
import { ZcApiError } from "./errors";
import {
  DEFAULT_MAINNET_EXPLORER_URL,
  DEFAULT_TESTNET_EXPLORER_URL,
  ZcExplorerClient
} from "./explorerClient";
import { getNetworkType } from "@/utils/otherUtils";

export const DEFAULT_MAINNET_HERGMES_URL = "https://hergmes.nautiluswallet.com";
export const DEFAULT_HERGMES_DEBOUNCE_MS = 200;

const REQUEST_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 15_000;
const REST_PAGE_SIZE = 1000;
const REST_BOX_CONCURRENCY = 6;
const ITEM_CONCURRENCY = 8;
const STATUS_RETRY_FIRST_MS = 1_000;
const STATUS_RETRY_MAX_MS = 30_000;

const FILLS_RELEVANT_KINDS = new Set<ZcKind>(["Bond", "SaleOrder", "PricedAsk"]);

export interface HergmesStreamError {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly retryAfter?: number;
  readonly keyLabel?: string;
}

/**
 * Structural subset of `@hergmes/sdk`'s `Relay` used by `ZcHergmesClient`.
 * Allows injecting mock relays in unit tests without monkey-patching globals.
 */
export interface HergmesRelayLike {
  readonly rest: Pick<
    RestClient,
    "status" | "boxes" | "box" | "tokens" | "submitTransaction"
  >;
  readonly tip: BlockRef | undefined;
  onTip(listener: (tip: BlockRef) => void): () => void;
  subscribe(key: { address: string }, options?: SubscribeOptions): Subscription;
  subscribe(key: Key): Subscription;
  close(): void;
}

export interface ZcHergmesClientOptions {
  /** Historical companion client for spent-box and full-transaction queries. Defaults to `ZcExplorerClient`. */
  readonly historicalClient?: ZcChainClient;
  /** Target Ergo network. Defaults to `getNetworkType()` (or Mainnet outside Vite). */
  readonly network?: Network;
  /** Trailing debounce window (ms) for coalescing bursty WS key updates. Defaults to 200ms. */
  readonly debounceMs?: number;
  /** Options forwarded to `new Relay(url, relayOptions)`. */
  readonly relayOptions?: RelayOptions;
  /** Optional factory override for unit testing with a mock relay. */
  readonly createRelay?: (url: string, options?: RelayOptions) => HergmesRelayLike;
}

interface ScriptSubSlot {
  readonly script: ZcScript;
  readonly address: string;
  readonly fillsRelevant: boolean;
  readonly subscription: Subscription;
  unsubscribe: () => void;
  state: SubscriptionState;
  lastConfirmedChangeKey: string | null;
}

interface OracleSubSlot {
  readonly subscription: Subscription;
  unsubscribe: () => void;
  state: SubscriptionState;
}

interface ReadyWaiter {
  resolve: (snapshot: LiveZcSnapshot) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

type HergmesBoxInput = Box<bigint | string> & { readonly inclusionHeight?: number };

function resolveAppNetwork(): Network {
  try {
    return getNetworkType();
  } catch {
    return Network.Mainnet;
  }
}

function expectedNetworkName(network: Network): "mainnet" | "testnet" {
  return network === Network.Testnet ? "testnet" : "mainnet";
}

function defaultHistoricalClient(network: Network): ZcChainClient {
  return new ZcExplorerClient(
    network === Network.Testnet ? DEFAULT_TESTNET_EXPLORER_URL : DEFAULT_MAINNET_EXPLORER_URL
  );
}

/**
 * Validates that a relay URL is non-empty and uses `http:` or `https:`.
 */
export function isValidHergmesUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * Normalizes a Hergmes relay URL by trimming whitespace and trailing slashes.
 * Returns `""` when blank; returns the trimmed string as-is when non-empty and unparseable
 * so callers can surface validation errors clearly.
 */
export function normalizeHergmesUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return trimmed;
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return trimmed;
  }
}

/**
 * Converts a Hergmes `ConfirmedBox`, pending `Box<bigint>`, or REST `PoolBox` into SigmaFi's `ChainBox`.
 * Preserves `bigint` amounts without floating-point precision loss.
 */
export function mapHergmesBox(raw: HergmesBoxInput): ChainBox {
  const assets: ChainAsset[] = (raw.assets ?? []).map((a) => ({
    tokenId: String(a.tokenId).toLowerCase(),
    amount: typeof a.amount === "bigint" ? a.amount : BigInt(String(a.amount))
  }));

  const additionalRegisters: Record<string, string> = {};
  if (raw.additionalRegisters) {
    for (const [k, v] of Object.entries(raw.additionalRegisters)) {
      if (typeof v === "string" && v.length > 0) {
        additionalRegisters[k] = v;
      }
    }
  }

  return {
    boxId: String(raw.boxId).toLowerCase(),
    transactionId: String(raw.transactionId ?? "").toLowerCase(),
    value: typeof raw.value === "bigint" ? raw.value : BigInt(String(raw.value ?? "0")),
    index: Number(raw.index ?? 0),
    creationHeight: Number(raw.creationHeight ?? 0),
    settlementHeight: raw.inclusionHeight != null ? Number(raw.inclusionHeight) : 0,
    ergoTree: String(raw.ergoTree ?? "").toLowerCase(),
    assets,
    additionalRegisters,
    spentTransactionId: null,
    spendingHeight: null
  };
}

function blockRefKey(ref: BlockRef): string {
  return `${ref.height}:${ref.headerId.toLowerCase()}`;
}

function isTransientRelayError(err: RelayError): boolean {
  return (
    err.retryAfter !== undefined ||
    err.status >= 500 ||
    err.status === 408 ||
    err.status === 429
  );
}

function isNotFoundRelayError(err: unknown): boolean {
  return err instanceof RelayError && (err.status === 404 || err.code === "box_not_found");
}

function toStreamError(err: SubscriptionError | undefined, keyLabel?: string): HergmesStreamError | null {
  if (!err) return null;
  return {
    code: err.code,
    message: keyLabel ? `${keyLabel}: ${err.message}` : err.message,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
    ...(keyLabel ? { keyLabel } : {})
  };
}

function sameStreamError(a: HergmesStreamError | null, b: HergmesStreamError | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.code === b.code &&
    a.message === b.message &&
    a.status === b.status &&
    a.retryAfter === b.retryAfter &&
    a.keyLabel === b.keyLabel
  );
}

function wrapRelayFailure(err: unknown, fallbackMessage: string, timedOut = false): ZcApiError {
  if (err instanceof ZcApiError) return err;
  if (err instanceof RelayError) {
    return new ZcApiError(
      err.message || `${fallbackMessage} (HTTP ${err.status})`,
      err.status,
      err
    );
  }
  return new ZcApiError(
    timedOut ? `${fallbackMessage}: timed out` : `${fallbackMessage}: unreachable`,
    0,
    err
  );
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

export class ZcHergmesClient implements ZcChainClient {
  private endpoint: string;
  private readonly network: Network;
  private readonly debounceMs: number;
  private readonly relayOptions?: RelayOptions;
  private readonly createRelayFn: (url: string, options?: RelayOptions) => HergmesRelayLike;
  private historicalClient: ZcChainClient;

  private relay: HergmesRelayLike | null = null;
  private unsubTip: (() => void) | null = null;
  private scriptSubs: ScriptSubSlot[] = [];
  private oracleSub: OracleSubSlot | null = null;

  private tip: BlockRef | null = null;
  private validatedNetwork: "mainnet" | "testnet" | null = null;
  private streamPhase: HergmesStreamPhase = "idle";
  private lastError: HergmesStreamError | null = null;

  private pendingFillsDirty = false;
  private spendableIndexDirty = true;
  private liveSpendableIndex = new Map<string, ChainBox>();

  private started = false;
  private disposed = false;
  private openingSubs = false;
  private sessionId = 0;
  private sessionAbort: AbortController | null = null;
  private startPromise: Promise<void> | null = null;
  private statusAttempt = 0;
  private statusRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly liveListeners = new Set<(snapshot: LiveZcSnapshot) => void>();
  private readonly phaseListeners = new Set<
    (phase: HergmesStreamPhase, error: HergmesStreamError | null) => void
  >();
  private readonly readyWaiters = new Set<ReadyWaiter>();

  constructor(endpoint = "", options: ZcHergmesClientOptions = {}) {
    this.endpoint = normalizeHergmesUrl(endpoint);
    this.network = options.network ?? resolveAppNetwork();
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_HERGMES_DEBOUNCE_MS);
    this.relayOptions = options.relayOptions;
    this.createRelayFn =
      options.createRelay ?? ((url, opts) => new Relay(url, opts));
    this.historicalClient = options.historicalClient ?? defaultHistoricalClient(this.network);
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  setEndpoint(url: string): void {
    const clean = normalizeHergmesUrl(url);
    if (clean === this.endpoint) return;
    this.close();
    this.disposed = false;
    this.endpoint = clean;
  }

  getNetwork(): Network {
    return this.network;
  }

  getHistoricalClient(): ZcChainClient {
    return this.historicalClient;
  }

  setHistoricalClient(client: ZcChainClient): void {
    this.historicalClient = client;
  }

  /**
   * Exposes the shared `@hergmes/sdk` `Relay` instance so the wallet mempool overlay
   * can multiplex wallet address subscriptions over the exact same WebSocket connection.
   */
  getRelay(): Relay | null {
    return this.relay as Relay | null;
  }

  isNetworkValidated(): boolean {
    return this.validatedNetwork !== null;
  }

  getStreamPhase(): HergmesStreamPhase {
    return this.streamPhase;
  }

  getLastError(): HergmesStreamError | null {
    return this.lastError;
  }

  getTip(): BlockRef | null {
    return this.tip ? { height: this.tip.height, headerId: this.tip.headerId } : null;
  }

  /**
   * Returns a `LiveZcSnapshot` built from the current in-memory subscription state when live,
   * or `null` if the client has not reached `"live"` with a known tip yet.
   */
  getLiveSnapshot(options?: { consumeFillsDirty?: boolean }): LiveZcSnapshot | null {
    if (this.streamPhase !== "live" || !this.tip) return null;
    const fillsDirty = this.pendingFillsDirty;
    if (options?.consumeFillsDirty) {
      this.pendingFillsDirty = false;
    }
    return this.buildLiveSnapshot(fillsDirty);
  }

  onLiveUpdate(listener: (snapshot: LiveZcSnapshot) => void): () => void {
    this.liveListeners.add(listener);
    return () => {
      this.liveListeners.delete(listener);
    };
  }

  onPhaseChange(
    listener: (phase: HergmesStreamPhase, error: HergmesStreamError | null) => void
  ): () => void {
    this.phaseListeners.add(listener);
    return () => {
      this.phaseListeners.delete(listener);
    };
  }

  /**
   * Validates the relay's network via `GET /v1/status` against the active app network,
   * then opens all 23 live subscriptions (22 V2 P2S contract addresses + 1 Oracle NFT)
   * and attaches the `relay.onTip` listener. Idempotent while already started.
   */
  start(): Promise<void> {
    if (this.disposed) {
      this.disposed = false;
    }
    if (this.started && this.streamPhase !== "rejected") {
      return this.startPromise ?? Promise.resolve();
    }

    if (!isValidHergmesUrl(this.endpoint)) {
      const err: HergmesStreamError = {
        code: "invalid_url",
        message: "Hergmes relay URL must be a valid http:// or https:// URL.",
        status: 400
      };
      this.setPhase("rejected", err);
      this.rejectReadyWaiters(new ZcApiError(err.message, 400, err));
      return Promise.resolve();
    }

    this.teardownSessionState();
    this.started = true;
    const session = ++this.sessionId;
    this.sessionAbort = new AbortController();
    this.statusAttempt = 0;

    const run = this.validateAndSubscribe(session);
    this.startPromise = run;
    return run;
  }

  /**
   * Waits until the relay reaches `"live"` (network validated, tip known, and all 23
   * subscriptions live) and returns the resulting `LiveZcSnapshot`.
   */
  waitUntilReady(
    timeoutMs = READY_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<LiveZcSnapshot> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Aborted"));
    }

    if (this.streamPhase === "live" && this.tip) {
      return Promise.resolve(this.buildLiveSnapshot(false));
    }

    if (this.streamPhase === "rejected") {
      return Promise.reject(
        new ZcApiError(
          this.lastError?.message || "Hergmes relay rejected connection.",
          this.lastError?.status ?? 403,
          this.lastError
        )
      );
    }

    if (!this.started) {
      void this.start();
      if (this.getStreamPhase() === "rejected") {
        return Promise.reject(
          new ZcApiError(
            this.lastError?.message || "Hergmes relay rejected connection.",
            this.lastError?.status ?? 400,
            this.lastError
          )
        );
      }
    }

    return new Promise<LiveZcSnapshot>((resolve, reject) => {
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        waiter.cleanup();
        this.readyWaiters.delete(waiter);
        reject(signal?.reason ?? new Error("Aborted"));
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiter.cleanup();
        this.readyWaiters.delete(waiter);
        reject(
          new ZcApiError(
            this.lastError?.message
              ? `Hergmes relay timed out waiting to go live (${this.lastError.message})`
              : "Hergmes relay timed out waiting for live snapshot.",
            504,
            this.lastError
          )
        );
      }, Math.max(1, timeoutMs));

      const waiter: ReadyWaiter = {
        resolve: (snap) => {
          if (settled) return;
          settled = true;
          waiter.cleanup();
          resolve(snap);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          waiter.cleanup();
          reject(err);
        },
        cleanup: () => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
        }
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.readyWaiters.add(waiter);
    });
  }

  /**
   * Closes all 23 subscriptions, cancels pending timers/requests, closes the shared `Relay`,
   * and returns the client to `"idle"` while keeping registered listeners attached.
   */
  close(): void {
    this.sessionId++;
    this.started = false;
    this.startPromise = null;
    this.teardownSessionState();
    this.teardownRelay();
    this.rejectReadyWaiters(new ZcApiError("Hergmes client closed.", 0));
    this.setPhase("idle", null);
  }

  /**
   * Permanently disposes the client, closing all subscriptions and the `Relay` and removing
   * all registered listeners.
   */
  dispose(): void {
    this.disposed = true;
    this.close();
    this.liveListeners.clear();
    this.phaseListeners.clear();
  }

  // ─── ZcChainClient implementation ───────────────────────────────────────────

  async fetchStateAndOracle(
    signal?: AbortSignal
  ): Promise<{ state: ChainState; oracle: ZcOracle | null }> {
    if (this.streamPhase === "live" && this.tip) {
      return {
        state: this.buildChainState(),
        oracle: this.readConfirmedOracleFromSub()
      };
    }

    const relay = this.requireRelay();
    const timeout = withTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const status = await relay.rest.status({ signal: timeout.signal });
      const expected = expectedNetworkName(this.network);
      const relayNet = String(status.network || "").toLowerCase();
      if (relayNet !== expected) {
        throw new ZcApiError(
          `Hergmes relay is on ${relayNet || "unknown"}, expected ${expected}.`,
          409,
          status
        );
      }
      if (!status.tip) {
        throw new ZcApiError("Hergmes relay has no chain tip yet.", 503, status);
      }

      const rawBoxes = await this.fetchAllRestBoxesForKey(
        relay,
        { tokenId: ZC_ORACLE_V2_NFT },
        timeout.signal
      );
      const nftBoxes = rawBoxes.map(mapHergmesBox).filter(holdsOracleNft);
      const oracle = nftBoxes.length === 1 ? readZcOracle(nftBoxes[0]) : null;

      return {
        state: {
          height: status.tip.height,
          blockId: status.tip.headerId.toLowerCase(),
          network: relayNet
        },
        oracle
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      throw wrapRelayFailure(err, "Hergmes state/oracle request failed", timeout.didTimeout());
    } finally {
      timeout.cleanup();
    }
  }

  async fetchAllUnspentZcBoxes(
    signal?: AbortSignal
  ): Promise<{ boxes: ChainBox[]; cut: boolean }> {
    if (this.streamPhase === "live" && this.tip) {
      const snap = this.buildLiveSnapshot(false);
      return { boxes: [...snap.confirmedBoxes], cut: snap.cut };
    }

    const relay = this.requireRelay();
    const timeout = withTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const addresses = ZC_SCRIPTS.map((script) => getZcScriptAddress(script, this.network));
      const perAddress = await mapPool(addresses, REST_BOX_CONCURRENCY, (address) =>
        this.fetchAllRestBoxesForKey(relay, { address }, timeout.signal)
      );

      const dedup = new Map<string, ChainBox>();
      for (const list of perAddress) {
        for (const raw of list) {
          const mapped = mapHergmesBox(raw);
          if (!dedup.has(mapped.boxId)) dedup.set(mapped.boxId, mapped);
        }
      }
      return { boxes: Array.from(dedup.values()), cut: false };
    } catch (err) {
      if (signal?.aborted) throw err;
      throw wrapRelayFailure(err, "Hergmes box scan failed", timeout.didTimeout());
    } finally {
      timeout.cleanup();
    }
  }

  async fetchBoxesByIds(
    boxIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, ChainBox>> {
    return this.historicalClient.fetchBoxesByIds(boxIds, signal);
  }

  async fetchTransactionsByIds(
    txIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, ChainTransaction>> {
    return this.historicalClient.fetchTransactionsByIds(txIds, signal);
  }

  async fetchTransactionsByAddresses(
    addresses: readonly string[],
    minHeight: number,
    maxPages?: number,
    signal?: AbortSignal
  ): Promise<ChainTransaction[]> {
    return this.historicalClient.fetchTransactionsByAddresses(
      addresses,
      minHeight,
      maxPages,
      signal
    );
  }

  async fetchTokensByIds(
    tokenIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, GraphqlTokenInfo>> {
    const unique = Array.from(new Set(tokenIds.map((id) => id.toLowerCase())));
    const out = new Map<string, GraphqlTokenInfo>();
    if (unique.length === 0) return out;

    const relay = this.requireRelay();
    const timeout = withTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const { items } = await relay.rest.tokens(unique, { signal: timeout.signal });
      for (const item of items) {
        const id = String(item.tokenId).toLowerCase();
        if (!id) continue;
        out.set(id, {
          tokenId: id,
          name: item.name || null,
          decimals: item.decimals != null ? Number(item.decimals) : null,
          description: item.description || null,
          emissionAmount: item.emission != null ? String(item.emission) : null
        });
      }
      return out;
    } catch (err) {
      if (signal?.aborted) throw err;
      throw wrapRelayFailure(err, "Hergmes token metadata request failed", timeout.didTimeout());
    } finally {
      timeout.cleanup();
    }
  }

  async fetchSpendableBoxesByIds(
    boxIds: readonly string[],
    signal?: AbortSignal
  ): Promise<Map<string, ChainBox>> {
    const unique = Array.from(new Set(boxIds.map((id) => id.toLowerCase())));
    const out = new Map<string, ChainBox>();
    if (unique.length === 0) return out;

    const missing: string[] = [];
    if (this.streamPhase === "live") {
      const liveIndex = this.getLiveSpendableIndex();
      for (const id of unique) {
        const hit = liveIndex.get(id);
        if (hit) {
          out.set(id, hit);
        } else {
          missing.push(id);
        }
      }
    } else {
      missing.push(...unique);
    }

    if (missing.length === 0) return out;

    const relay = this.requireRelay();
    const timeout = withTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const fetched = await mapPool(missing, ITEM_CONCURRENCY, async (id) => {
        try {
          const raw = await relay.rest.box(id, { signal: timeout.signal });
          return mapHergmesBox(raw);
        } catch (err) {
          if (isNotFoundRelayError(err)) return null;
          throw err;
        }
      });

      for (const box of fetched) {
        if (box) out.set(box.boxId, box);
      }
      return out;
    } catch (err) {
      if (signal?.aborted) throw err;
      throw wrapRelayFailure(err, "Hergmes spendable box lookup failed", timeout.didTimeout());
    } finally {
      timeout.cleanup();
    }
  }

  async checkTransaction(
    signedTx: SignedTransaction,
    signal?: AbortSignal
  ): Promise<ZcTxCheckResult> {
    const relay = this.requireRelay();
    const timeout = withTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const res = await relay.rest.submitTransaction(signedTx, {
        broadcast: false,
        signal: timeout.signal
      });
      return { ok: true, txId: String(res.transactionId).toLowerCase() };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof RelayError) {
        return {
          ok: false,
          reason: err.reason ?? err.code ?? `http_${err.status}`,
          message: err.message
        };
      }
      throw wrapRelayFailure(err, "Hergmes transaction check failed", timeout.didTimeout());
    } finally {
      timeout.cleanup();
    }
  }

  // ─── Internal lifecycle & state aggregation ─────────────────────────────────

  private ensureRelay(): HergmesRelayLike | null {
    if (!isValidHergmesUrl(this.endpoint)) return null;
    if (!this.relay) {
      this.relay = this.createRelayFn(this.endpoint, this.relayOptions);
    }
    return this.relay;
  }

  private requireRelay(): HergmesRelayLike {
    const relay = this.ensureRelay();
    if (!relay) {
      throw new ZcApiError("Hergmes relay URL is not configured or invalid.", 400);
    }
    return relay;
  }

  private async fetchAllRestBoxesForKey(
    relay: HergmesRelayLike,
    key: Key,
    signal?: AbortSignal
  ): Promise<HergmesBoxInput[]> {
    const first = await relay.rest.boxes(key, { limit: REST_PAGE_SIZE, signal });
    const items: HergmesBoxInput[] = [...first.items];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await relay.rest.boxes(key, { limit: REST_PAGE_SIZE, cursor, signal });
      items.push(...page.items);
      cursor = page.nextCursor;
    }
    return items;
  }

  private async validateAndSubscribe(session: number): Promise<void> {
    const relay = this.ensureRelay();
    if (!relay) {
      const err: HergmesStreamError = {
        code: "invalid_url",
        message: "Hergmes relay URL must be a valid http:// or https:// URL.",
        status: 400
      };
      this.setPhase("rejected", err);
      this.rejectReadyWaiters(new ZcApiError(err.message, 400, err));
      return;
    }

    this.setPhase("connecting", null);

    const timeout = withTimeoutSignal(this.sessionAbort?.signal, REQUEST_TIMEOUT_MS);
    try {
      const status = await relay.rest.status({ signal: timeout.signal });
      timeout.cleanup();

      if (session !== this.sessionId || this.disposed) return;

      const expected = expectedNetworkName(this.network);
      const relayNet = String(status.network || "").toLowerCase();
      if (relayNet !== expected) {
        const err: HergmesStreamError = {
          code: "network_mismatch",
          message: `Hergmes relay is on ${relayNet || "unknown"}, but SigmaFi expects ${expected}.`,
          status: 409
        };
        this.started = false;
        this.teardownSessionState();
        this.teardownRelay();
        this.setPhase("rejected", err);
        this.rejectReadyWaiters(new ZcApiError(err.message, 409, err));
        return;
      }

      this.validatedNetwork = relayNet as "mainnet" | "testnet";
      this.statusAttempt = 0;
      this.openSubscriptions(relay, session);
    } catch (err) {
      timeout.cleanup();
      if (session !== this.sessionId || this.disposed) return;

      if (err instanceof RelayError && !isTransientRelayError(err)) {
        const streamErr: HergmesStreamError = {
          code: err.code ?? `http_${err.status}`,
          message: err.message,
          status: err.status
        };
        this.started = false;
        this.teardownSessionState();
        this.teardownRelay();
        this.setPhase("rejected", streamErr);
        this.rejectReadyWaiters(new ZcApiError(streamErr.message, err.status, err));
        return;
      }

      const retryMs =
        err instanceof RelayError && err.retryAfter !== undefined
          ? Math.max(0, err.retryAfter * 1000)
          : Math.min(STATUS_RETRY_MAX_MS, STATUS_RETRY_FIRST_MS * 2 ** this.statusAttempt++) *
            (0.5 + Math.random() * 0.5);

      const streamErr: HergmesStreamError =
        err instanceof RelayError
          ? {
              code: err.code ?? `http_${err.status}`,
              message: err.message,
              status: err.status,
              retryAfter: retryMs / 1000
            }
          : {
              code: "network",
              message: timeout.didTimeout()
                ? "Hergmes relay status request timed out."
                : "Hergmes relay unreachable.",
              retryAfter: retryMs / 1000
            };

      this.setPhase("waiting", streamErr);
      this.scheduleStatusRetry(session, retryMs);
    }
  }

  private scheduleStatusRetry(session: number, delayMs: number): void {
    if (this.statusRetryTimer !== null) {
      clearTimeout(this.statusRetryTimer);
    }
    this.statusRetryTimer = setTimeout(() => {
      this.statusRetryTimer = null;
      if (session !== this.sessionId || this.disposed || !this.started) return;
      this.startPromise = this.validateAndSubscribe(session);
    }, Math.max(50, Math.round(delayMs)));
  }

  private openSubscriptions(relay: HergmesRelayLike, session: number): void {
    this.openingSubs = true;
    try {
      // Attach tip listener before opening the first subscription so we never miss the initial WS tip frame.
      if (relay.tip) {
        this.tip = {
          height: relay.tip.height,
          headerId: relay.tip.headerId.toLowerCase()
        };
      }
      this.unsubTip = relay.onTip((nextTip) => {
        if (session !== this.sessionId || this.disposed) return;
        const normalized: BlockRef = {
          height: nextTip.height,
          headerId: nextTip.headerId.toLowerCase()
        };
        const changed =
          !this.tip ||
          this.tip.height !== normalized.height ||
          this.tip.headerId !== normalized.headerId;
        this.tip = normalized;
        if (!this.openingSubs && changed) {
          this.recomputeState(true);
        }
      });

      this.scriptSubs = ZC_SCRIPTS.map((script) => {
        const address = getZcScriptAddress(script, this.network);
        const subscription = relay.subscribe({ address }, { boxes: true });
        const slot: ScriptSubSlot = {
          script,
          address,
          fillsRelevant: FILLS_RELEVANT_KINDS.has(script.kind),
          subscription,
          unsubscribe: () => undefined,
          state: subscription.state,
          lastConfirmedChangeKey: null
        };
        this.recordScriptConfirmedChange(slot, subscription.state);
        slot.unsubscribe = subscription.subscribe((nextState) => {
          if (session !== this.sessionId || this.disposed) return;
          const prev = slot.state;
          slot.state = nextState;
          this.recordScriptConfirmedChange(slot, nextState);

          const boxesChanged = prev.boxes !== nextState.boxes;
          const phaseChanged = prev.phase !== nextState.phase;
          const errorChanged = prev.error !== nextState.error;
          if (!boxesChanged && !phaseChanged && !errorChanged) return;

          if (boxesChanged) {
            this.spendableIndexDirty = true;
          }
          if (!this.openingSubs) {
            this.recomputeState(boxesChanged);
          }
        });
        return slot;
      });

      const oracleSubscription = relay.subscribe({ tokenId: ZC_ORACLE_V2_NFT });
      const oracleSlot: OracleSubSlot = {
        subscription: oracleSubscription,
        unsubscribe: () => undefined,
        state: oracleSubscription.state
      };
      oracleSlot.unsubscribe = oracleSubscription.subscribe((nextState) => {
        if (session !== this.sessionId || this.disposed) return;
        const prev = oracleSlot.state;
        oracleSlot.state = nextState;

        const boxesChanged = prev.boxes !== nextState.boxes;
        const phaseChanged = prev.phase !== nextState.phase;
        const errorChanged = prev.error !== nextState.error;
        if (!boxesChanged && !phaseChanged && !errorChanged) return;

        if (boxesChanged) {
          this.spendableIndexDirty = true;
        }
        if (!this.openingSubs) {
          this.recomputeState(boxesChanged);
        }
      });
      this.oracleSub = oracleSlot;
      this.spendableIndexDirty = true;
    } finally {
      this.openingSubs = false;
    }

    this.recomputeState(true);
  }

  private recordScriptConfirmedChange(slot: ScriptSubSlot, state: SubscriptionState): void {
    if (state.phase !== "live" || !state.boxes) return;
    const changeKey = blockRefKey(state.boxes.lastChange);
    if (slot.lastConfirmedChangeKey === null) {
      slot.lastConfirmedChangeKey = changeKey;
      return;
    }
    if (slot.lastConfirmedChangeKey !== changeKey) {
      slot.lastConfirmedChangeKey = changeKey;
      if (slot.fillsRelevant) {
        this.pendingFillsDirty = true;
      }
    }
  }

  private computeAggregatePhase(): { phase: HergmesStreamPhase; error: HergmesStreamError | null } {
    if (!this.started) {
      return { phase: "idle", error: null };
    }
    if (!this.oracleSub || this.scriptSubs.length !== ZC_SCRIPTS.length) {
      return { phase: "connecting", error: null };
    }

    let firstRejected: HergmesStreamError | null = null;
    let hasDisconnected = false;
    let firstDisconnectedErr: HergmesStreamError | null = null;
    let firstWaiting: HergmesStreamError | null = null;
    let hasWaiting = false;
    let hasSnapshot = false;
    let allLive = true;

    const inspect = (state: SubscriptionState, label: string) => {
      switch (state.phase) {
        case "rejected":
          allLive = false;
          if (!firstRejected) {
            firstRejected = toStreamError(state.error, label) ?? {
              code: "rejected",
              message: `${label}: subscription rejected`,
              keyLabel: label
            };
          }
          break;
        case "disconnected":
          allLive = false;
          hasDisconnected = true;
          if (!firstDisconnectedErr && state.error) {
            firstDisconnectedErr = toStreamError(state.error, label);
          }
          break;
        case "waiting":
          allLive = false;
          hasWaiting = true;
          if (!firstWaiting) {
            firstWaiting = toStreamError(state.error, label) ?? {
              code: "waiting",
              message: `${label}: waiting to retry`,
              keyLabel: label
            };
          }
          break;
        case "snapshot":
          allLive = false;
          hasSnapshot = true;
          break;
        case "catching_up":
          allLive = false;
          break;
        case "live":
          break;
      }
    };

    for (const slot of this.scriptSubs) {
      inspect(slot.state, slot.script.label);
    }
    inspect(this.oracleSub.state, "Oracle NFT");

    if (firstRejected) {
      return { phase: "rejected", error: firstRejected };
    }
    if (hasDisconnected) {
      return { phase: "disconnected", error: firstDisconnectedErr };
    }
    if (hasWaiting) {
      return { phase: "waiting", error: firstWaiting };
    }
    if (allLive && this.tip !== null) {
      return { phase: "live", error: null };
    }
    if (hasSnapshot) {
      return { phase: "snapshot", error: null };
    }
    return { phase: "catching_up", error: null };
  }

  private recomputeState(dataChanged: boolean): void {
    const prevPhase = this.streamPhase;
    const { phase, error } = this.computeAggregatePhase();
    this.setPhase(phase, error);

    if (phase === "rejected") {
      this.clearDebounceTimer();
      this.rejectReadyWaiters(
        new ZcApiError(
          error?.message || "Hergmes relay rejected required subscription.",
          error?.status ?? 403,
          error
        )
      );
      return;
    }

    if (phase === "live" && (prevPhase !== "live" || dataChanged)) {
      this.scheduleLivePush();
    } else if (phase !== "live") {
      this.clearDebounceTimer();
    }
  }

  private setPhase(phase: HergmesStreamPhase, error: HergmesStreamError | null): void {
    if (phase === this.streamPhase && sameStreamError(error, this.lastError)) return;
    this.streamPhase = phase;
    this.lastError = error;
    for (const listener of this.phaseListeners) {
      try {
        listener(phase, error);
      } catch {
        // isolate listener failures
      }
    }
  }

  private scheduleLivePush(): void {
    this.clearDebounceTimer();
    const session = this.sessionId;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (session !== this.sessionId || this.disposed) return;
      if (this.streamPhase !== "live" || !this.tip) return;

      const fillsDirty = this.pendingFillsDirty;
      this.pendingFillsDirty = false;
      const snapshot = this.buildLiveSnapshot(fillsDirty);

      this.resolveReadyWaiters(snapshot);

      for (const listener of this.liveListeners) {
        try {
          listener(snapshot);
        } catch {
          // isolate listener failures
        }
      }
    }, this.debounceMs);
  }

  private buildChainState(): ChainState {
    const tip = this.tip;
    return {
      height: tip?.height ?? 0,
      blockId: tip?.headerId.toLowerCase() ?? "",
      network: this.validatedNetwork ?? expectedNetworkName(this.network)
    };
  }

  private readConfirmedOracleFromSub(): ZcOracle | null {
    const view = this.oracleSub?.state.boxes;
    if (!view) return null;
    const nftBoxes = view.confirmed.map(mapHergmesBox).filter(holdsOracleNft);
    return nftBoxes.length === 1 ? readZcOracle(nftBoxes[0]) : null;
  }

  private buildLiveSnapshot(fillsDirty: boolean): LiveZcSnapshot {
    const confirmedById = new Map<string, ChainBox>();
    const pendingById = new Map<string, ChainBox>();

    for (const slot of this.scriptSubs) {
      const view = slot.state.boxes;
      if (!view) continue;

      const confirmedLookup = new Map<string, ConfirmedBox>();
      for (const cb of view.confirmed) {
        confirmedLookup.set(cb.boxId.toLowerCase(), cb);
      }

      for (const sb of view.spendable) {
        const id = sb.boxId.toLowerCase();
        const confirmedBox = confirmedLookup.get(id);
        if (confirmedBox) {
          if (!confirmedById.has(id)) {
            confirmedById.set(id, mapHergmesBox(confirmedBox));
          }
          pendingById.delete(id);
        } else if (!confirmedById.has(id) && !pendingById.has(id)) {
          pendingById.set(id, mapHergmesBox(sb));
        }
      }
    }

    const oracleView = this.oracleSub?.state.boxes;
    const confirmedOracle = this.readConfirmedOracleFromSub();
    const refreshPending =
      confirmedOracle !== null &&
      (oracleView?.pending ?? []).some((tx) =>
        tx.spent.some((spentId) => spentId.toLowerCase() === confirmedOracle.box.boxId)
      );

    return {
      state: this.buildChainState(),
      confirmedOracle,
      refreshPending,
      confirmedBoxes: Array.from(confirmedById.values()),
      pendingBoxes: Array.from(pendingById.values()),
      mempool: true,
      cut: false,
      fillsDirty
    };
  }

  private getLiveSpendableIndex(): Map<string, ChainBox> {
    if (!this.spendableIndexDirty) return this.liveSpendableIndex;

    const index = new Map<string, ChainBox>();
    const indexView = (view: SubscriptionState["boxes"]) => {
      if (!view) return;
      const confirmedLookup = new Map<string, ConfirmedBox>();
      for (const cb of view.confirmed) {
        confirmedLookup.set(cb.boxId.toLowerCase(), cb);
      }
      for (const sb of view.spendable) {
        const id = sb.boxId.toLowerCase();
        if (index.has(id)) continue;
        const confirmedBox = confirmedLookup.get(id);
        index.set(id, mapHergmesBox(confirmedBox ?? sb));
      }
    };

    for (const slot of this.scriptSubs) {
      indexView(slot.state.boxes);
    }
    if (this.oracleSub) {
      indexView(this.oracleSub.state.boxes);
    }

    this.liveSpendableIndex = index;
    this.spendableIndexDirty = false;
    return index;
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private teardownSessionState(): void {
    this.clearDebounceTimer();
    if (this.statusRetryTimer !== null) {
      clearTimeout(this.statusRetryTimer);
      this.statusRetryTimer = null;
    }
    if (this.sessionAbort) {
      this.sessionAbort.abort();
      this.sessionAbort = null;
    }
    if (this.unsubTip) {
      this.unsubTip();
      this.unsubTip = null;
    }
    for (const slot of this.scriptSubs) {
      slot.unsubscribe();
      slot.subscription.close();
    }
    this.scriptSubs = [];
    if (this.oracleSub) {
      this.oracleSub.unsubscribe();
      this.oracleSub.subscription.close();
      this.oracleSub = null;
    }
    this.tip = null;
    this.validatedNetwork = null;
    this.pendingFillsDirty = false;
    this.spendableIndexDirty = true;
    this.liveSpendableIndex.clear();
    this.statusAttempt = 0;
  }

  private teardownRelay(): void {
    if (this.relay) {
      this.relay.close();
      this.relay = null;
    }
  }

  private resolveReadyWaiters(snapshot: LiveZcSnapshot): void {
    if (this.readyWaiters.size === 0) return;
    const waiters = Array.from(this.readyWaiters);
    this.readyWaiters.clear();
    for (const w of waiters) {
      w.resolve(snapshot);
    }
  }

  private rejectReadyWaiters(err: unknown): void {
    if (this.readyWaiters.size === 0) return;
    const waiters = Array.from(this.readyWaiters);
    this.readyWaiters.clear();
    for (const w of waiters) {
      w.reject(err);
    }
  }
}
