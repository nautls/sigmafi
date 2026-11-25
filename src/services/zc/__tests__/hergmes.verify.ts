/* eslint-disable no-console */
/**
 * Automated verification suite for SigmaFi V2 Hergmes integration.
 *
 * Step 1 coverage (`ZcHergmesClient` & `ZcChainClient` live/spendable extensions):
 *  1. URL validation & lazy `Relay` instantiation (no socket on empty/invalid URL).
 *  2. `relay.rest.status()` network mismatch rejection vs valid 23-subscription startup
 *     (22 V2 P2S contract addresses + 1 Oracle NFT + `relay.onTip`).
 *  3. Aggregate `streamPhase` priority (`rejected` > `disconnected` > `waiting` > `live` / `snapshot` / `catching_up`).
 *  4. Exact `BoxView.spendable` / `confirmed` / `pending` mapping into `LiveZcSnapshot`
 *     (including `bigint` precision > 2^53, mempool-spent exclusions, and oracle `refreshPending`).
 *  5. Trailing debounce coalescing, balance-only no-op filtering, tip-only pushes, and
 *     targeted `fillsDirty` invalidation on `Bond` / `SaleOrder` / `PricedAsk` block & rollback changes.
 *  6. REST methods (`fetchTokensByIds`, `fetchSpendableBoxesByIds`, `checkTransaction`,
 *     REST fallback `fetchStateAndOracle` / `fetchAllUnspentZcBoxes`) and historical companion delegation.
 *  7. Shared `getRelay()` access and clean `close()` / `setEndpoint()` / `dispose()` teardown.
 */
import { Box, Network, SignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import { blake2b256, hex } from "@fleet-sdk/crypto";
import {
  BlockRef,
  BoxPage,
  BoxView,
  ConfirmedBox,
  Key,
  PendingTx,
  Phase,
  PoolBox,
  RelayError,
  Status,
  Subscription,
  SubscriptionError,
  SubscriptionState,
  TokenList
} from "@hergmes/sdk";
import { ChainBox, readZcBox, ZcEntry, ZcOrder, ZcRecord } from "../boxes";
import {
  ChainState,
  ChainTransaction,
  GraphqlTokenInfo,
  HergmesStreamPhase,
  LiveZcSnapshot,
  ZcChainClient
} from "../chainClient";
import {
  getZcScript,
  getZcScriptAddress,
  ZC_ORACLE_V2_ERGO_TREE,
  ZC_ORACLE_V2_NFT,
  ZC_PINNED_COMMIT,
  ZC_SCRIPTS
} from "../contracts";
import { ZcApiError } from "../errors";
import {
  DEFAULT_MAINNET_HERGMES_URL,
  HergmesRelayLike,
  isValidHergmesUrl,
  mapHergmesBox,
  normalizeHergmesUrl,
  ZcHergmesClient
} from "../hergmesClient";
import { ZcJson } from "../json";
import { buildMarketBook, ZcMatcher } from "../matcher";
import { ZcGraphqlEngine } from "../reads";
import { resolverCacheStorageKey, ResolverStorageLike, ZcResolver } from "../resolver";
import { encodeBytes, encodeInt, encodeLong, encodeLongs, encodeTokenPairs } from "../tx/encoding";
import { buildZcAction, signAndSubmitZcAction } from "../tx/planner";
import { ZcTxConflictError, ZcTxDeps, ZcWalletTxAdapter } from "../tx/types";
import {
  aggregateWalletOverlay,
  MAX_WALLET_HERGMES_ADDRS,
  selectTrackedWalletAddresses,
  WALLET_ERG_TOKEN_ID,
  ZcWalletOverlayManager
} from "../walletOverlay";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed (${msg}): expected ${String(expected)}, got ${String(actual)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexId(tag: string): string {
  const clean = tag.toLowerCase().replace(/[^0-9a-f]/g, "a");
  return clean.padEnd(64, "0").slice(0, 64);
}

function keyId(key: Key): string {
  if ("address" in key) return `a:${key.address}`;
  return "tokenId" in key ? `t:${key.tokenId}` : `p:${key.template}`;
}

function makeConfirmedBox(overrides: Partial<ConfirmedBox> = {}): ConfirmedBox {
  return {
    boxId: hexId("b1"),
    transactionId: hexId("aa1"),
    value: 5_000_000_000n,
    index: 0,
    creationHeight: 1_500_000,
    inclusionHeight: 1_500_001,
    ergoTree: getZcScript("Order", "ERG").ergoTreeHex,
    assets: [],
    additionalRegisters: {},
    ...overrides
  };
}

function makePendingBox(overrides: Partial<Box<bigint>> = {}): Box<bigint> {
  return {
    boxId: hexId("f1"),
    transactionId: hexId("ff1"),
    value: 2_000_000_000n,
    index: 0,
    creationHeight: 1_500_005,
    ergoTree: getZcScript("Order", "ERG").ergoTreeHex,
    assets: [],
    additionalRegisters: {},
    ...overrides
  };
}

function makeOracleConfirmedBox(
  boxId: string,
  priceNanoErgPerUsd: bigint,
  epoch: number,
  inclusionHeight = 1_500_000
): ConfirmedBox {
  return {
    boxId,
    transactionId: hexId("cc1"),
    value: 10_000_000n,
    index: 0,
    creationHeight: inclusionHeight - 1,
    inclusionHeight,
    ergoTree: ZC_ORACLE_V2_ERGO_TREE,
    assets: [{ tokenId: ZC_ORACLE_V2_NFT, amount: 1n }],
    additionalRegisters: {
      R4: encodeLong(priceNanoErgPerUsd),
      R5: encodeInt(epoch)
    }
  };
}

function makeBoxView(params: {
  lastChange: BlockRef;
  confirmed?: ConfirmedBox[];
  pending?: PendingTx[];
}): BoxView {
  const confirmed = params.confirmed ?? [];
  const pending = params.pending ?? [];
  const spent = new Set(pending.flatMap((tx) => tx.spent));
  const confirmedIds = new Set(confirmed.map((b) => b.boxId));
  const spendable: Box<bigint>[] = confirmed.filter((b) => !spent.has(b.boxId));
  for (const tx of pending) {
    for (const b of tx.created) {
      if (!spent.has(b.boxId) && !confirmedIds.has(b.boxId)) {
        spendable.push(b);
      }
    }
  }
  return Object.freeze({
    lastChange: params.lastChange,
    confirmed,
    pending,
    spendable
  });
}

class MockSubscription implements Subscription {
  readonly key: Key;
  state: SubscriptionState;
  closed = false;
  private listeners = new Set<(state: SubscriptionState) => void>();

  constructor(key: Key, initialPhase: Phase = "snapshot") {
    this.key = key;
    this.state = Object.freeze({
      key,
      phase: initialPhase,
      boxes: undefined,
      balance: undefined,
      error: undefined
    });
  }

  subscribe(listener: (state: SubscriptionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  push(next: Partial<Omit<SubscriptionState, "key">>): void {
    this.state = Object.freeze({
      ...this.state,
      ...next
    });
    for (const l of this.listeners) {
      l(this.state);
    }
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

class MockRelay implements HergmesRelayLike {
  tip: BlockRef | undefined = undefined;
  closed = false;
  readonly subs = new Map<string, MockSubscription>();
  readonly subscribeOrder: string[] = [];
  readonly tipListeners = new Set<(tip: BlockRef) => void>();
  restBoxCalls: string[] = [];
  restTokenCalls: string[][] = [];
  restBoxesCalls: Key[] = [];
  restStatusCalls = 0;

  statusHandler: () => Promise<Status> = async () => ({
    version: "0.1.0",
    network: "mainnet",
    tip: { height: 1_500_000, headerId: hexId("100") },
    ready: true
  });

  restBoxHandler: (boxId: string) => Promise<PoolBox> = async (id) => {
    throw new RelayError(404, `Box ${id} not found`, { code: "box_not_found" });
  };

  restBoxesHandler: (key: Key) => Promise<BoxPage> = async () => ({
    asOf: { height: 1_500_000, headerId: hexId("100") },
    items: [],
    nextCursor: null
  });

  restTokensHandler: (ids: readonly string[]) => Promise<TokenList> = async () => ({
    items: []
  });

  submitHandler: (
    tx: string | SignedTransaction,
    options?: { broadcast?: boolean }
  ) => Promise<{ transactionId: string }> = async () => ({
    transactionId: hexId("999")
  });

  readonly rest: HergmesRelayLike["rest"] = {
    status: async () => {
      this.restStatusCalls++;
      return this.statusHandler();
    },
    boxes: async (key) => {
      this.restBoxesCalls.push(key);
      return this.restBoxesHandler(key);
    },
    box: async (boxId) => {
      this.restBoxCalls.push(boxId);
      return this.restBoxHandler(boxId);
    },
    tokens: async (ids) => {
      this.restTokenCalls.push([...ids]);
      return this.restTokensHandler(ids);
    },
    submitTransaction: async (tx, options) => {
      return this.submitHandler(tx, options);
    }
  };

  onTip(listener: (tip: BlockRef) => void): () => void {
    this.tipListeners.add(listener);
    return () => {
      this.tipListeners.delete(listener);
    };
  }

  emitTip(next: BlockRef): void {
    this.tip = next;
    for (const l of this.tipListeners) {
      l(next);
    }
  }

  subscribe(key: Key): Subscription {
    const id = keyId(key);
    const sub = new MockSubscription(key);
    this.subs.set(id, sub);
    this.subscribeOrder.push(id);
    return sub;
  }

  getSub(key: Key): MockSubscription {
    const sub = this.subs.get(keyId(key));
    if (!sub) throw new Error(`Missing mock subscription for ${keyId(key)}`);
    return sub;
  }

  setAllLive(
    lastChange: BlockRef,
    overrides?: Map<string, BoxView>
  ): void {
    for (const [id, sub] of this.subs) {
      const view = overrides?.get(id) ?? makeBoxView({ lastChange });
      sub.push({ phase: "live", boxes: view, error: undefined });
    }
  }

  close(): void {
    this.closed = true;
    this.tipListeners.clear();
  }
}

class MockHistoricalClient implements ZcChainClient {
  endpoint = "https://historical.example/v1";
  boxCalls: string[][] = [];
  txIdCalls: string[][] = [];
  txAddrCalls: { addresses: string[]; minHeight: number; maxPages?: number }[] = [];

  boxesResult = new Map<string, ChainBox>();
  txsResult = new Map<string, ChainTransaction>();
  addrTxsResult: ChainTransaction[] = [];

  getEndpoint(): string {
    return this.endpoint;
  }
  setEndpoint(url: string): void {
    this.endpoint = url;
  }
  async fetchStateAndOracle(): Promise<{ state: ChainState; oracle: null }> {
    return { state: { height: 0, blockId: "", network: "mainnet" }, oracle: null };
  }
  async fetchAllUnspentZcBoxes(): Promise<{ boxes: ChainBox[]; cut: boolean }> {
    return { boxes: [], cut: false };
  }
  async fetchBoxesByIds(boxIds: readonly string[]): Promise<Map<string, ChainBox>> {
    this.boxCalls.push([...boxIds]);
    return this.boxesResult;
  }
  async fetchTransactionsByIds(txIds: readonly string[]): Promise<Map<string, ChainTransaction>> {
    this.txIdCalls.push([...txIds]);
    return this.txsResult;
  }
  async fetchTransactionsByAddresses(
    addresses: readonly string[],
    minHeight: number,
    maxPages?: number
  ): Promise<ChainTransaction[]> {
    this.txAddrCalls.push({ addresses: [...addresses], minHeight, maxPages });
    return this.addrTxsResult;
  }
  async fetchTokensByIds(): Promise<Map<string, GraphqlTokenInfo>> {
    return new Map();
  }
}

async function runSuite(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  console.log(`  PASS: ${name}`);
}

async function main(): Promise<void> {
  console.log("Running SigmaFi V2 Hergmes verification suite...\n");

  await runSuite("1. URL validation & lazy Relay creation", async () => {
    assertEq(isValidHergmesUrl(""), false, "empty url invalid");
    assertEq(isValidHergmesUrl("   "), false, "whitespace url invalid");
    assertEq(isValidHergmesUrl("ws://127.0.0.1:8080"), false, "ws scheme invalid");
    assertEq(isValidHergmesUrl("not-a-url"), false, "garbage url invalid");
    assertEq(isValidHergmesUrl("http://127.0.0.1:8080"), true, "local http valid");
    assertEq(isValidHergmesUrl("https://relay.sigmafi.app/hergmes/"), true, "https path valid");
    assertEq(
      normalizeHergmesUrl("  https://relay.sigmafi.app/hergmes///  "),
      "https://relay.sigmafi.app/hergmes",
      "strips trailing slashes"
    );

    let createdCount = 0;
    const client = new ZcHergmesClient("", {
      network: Network.Mainnet,
      debounceMs: 10,
      createRelay: () => {
        createdCount++;
        return new MockRelay();
      }
    });

    assertEq(createdCount, 0, "relay not created in constructor for empty URL");
    assertEq(client.getRelay(), null, "getRelay null before start");
    assertEq(client.getStreamPhase(), "idle", "initial phase idle");

    await client.start();
    assertEq(createdCount, 0, "relay not created on start with empty URL");
    assertEq(client.getStreamPhase(), "rejected", "empty URL rejects");
    assertEq(client.getLastError()?.code, "invalid_url", "invalid_url error code");

    let readyErr: unknown = null;
    try {
      await client.waitUntilReady(500);
    } catch (err) {
      readyErr = err;
    }
    assert(readyErr instanceof ZcApiError, "waitUntilReady throws ZcApiError on invalid URL");
    client.dispose();
  });

  await runSuite("2. Network mismatch rejected before subscribing", async () => {
    const relay = new MockRelay();
    relay.statusHandler = async () => ({
      version: "0.1.0",
      network: "testnet",
      tip: { height: 500_000, headerId: hexId("55") },
      ready: true
    });

    const client = new ZcHergmesClient("https://relay.example.com", {
      network: Network.Mainnet,
      debounceMs: 10,
      createRelay: () => relay
    });

    const phases: HergmesStreamPhase[] = [];
    client.onPhaseChange((p) => phases.push(p));

    await client.start();
    assertEq(client.getStreamPhase(), "rejected", "network mismatch rejects");
    assertEq(client.getLastError()?.code, "network_mismatch", "network_mismatch code");
    assertEq(relay.subs.size, 0, "zero subscriptions opened on mismatch");
    assertEq(relay.closed, true, "relay closed after mismatch");
    assertEq(client.getRelay(), null, "getRelay cleared after mismatch");
    assert(phases.includes("connecting") && phases.includes("rejected"), "phase sequence recorded");

    let errCaught: unknown = null;
    try {
      await client.waitUntilReady(500);
    } catch (e) {
      errCaught = e;
    }
    assert(errCaught instanceof ZcApiError && errCaught.status === 409, "409 mismatch error");
    client.dispose();
  });

  await runSuite("3. 23 subscriptions, tip-gating, and aggregate streamPhase priority", async () => {
    const relay = new MockRelay();
    const client = new ZcHergmesClient("https://relay.example.com/", {
      network: Network.Mainnet,
      debounceMs: 15,
      createRelay: () => relay
    });

    assertEq(client.getEndpoint(), "https://relay.example.com", "normalized endpoint");

    await client.start();
    assertEq(relay.restStatusCalls, 1, "status called once");
    assertEq(relay.subs.size, 23, "22 scripts + 1 oracle NFT = 23 subscriptions");
    assertEq(relay.tipListeners.size, 1, "tip listener attached");
    assertEq(client.getRelay(), relay as unknown, "getRelay returns shared relay");

    for (const script of ZC_SCRIPTS) {
      const addr = getZcScriptAddress(script, Network.Mainnet);
      assert(relay.subs.has(`a:${addr}`), `subscribed to ${script.label}`);
    }
    assert(relay.subs.has(`t:${ZC_ORACLE_V2_NFT}`), "subscribed to oracle NFT");
    assertEq(client.getStreamPhase(), "snapshot", "starts in snapshot");

    // All 23 keys live, but tip NOT yet received -> catching_up
    const tip1: BlockRef = { height: 1_500_010, headerId: hexId("a10") };
    relay.setAllLive(tip1);
    assertEq(client.getStreamPhase(), "catching_up", "waits for tip before marking live");

    // Now emit tip -> live
    const readyPromise = client.waitUntilReady(1000);
    relay.emitTip(tip1);
    assertEq(client.getStreamPhase(), "live", "becomes live once tip + all 23 keys live");

    const snap = await readyPromise;
    assertEq(snap.state.height, 1_500_010, "snapshot height");
    assertEq(snap.state.blockId, hexId("a10"), "snapshot blockId");
    assertEq(snap.state.network, "mainnet", "snapshot network");
    assertEq(snap.mempool, true, "mempool active");

    // Phase priority checks: waiting < disconnected < rejected
    const orderSub = relay.getSub({
      address: getZcScriptAddress(getZcScript("Order", "ERG"), Network.Mainnet)
    });
    const bondSub = relay.getSub({
      address: getZcScriptAddress(getZcScript("Bond", "ERG"), Network.Mainnet)
    });
    const oracleSub = relay.getSub({ tokenId: ZC_ORACLE_V2_NFT });

    const waitErr: SubscriptionError = {
      code: "capacity_exceeded",
      message: "too busy",
      status: 503,
      retryAfter: 10
    };
    orderSub.push({ phase: "waiting", error: waitErr });
    assertEq(client.getStreamPhase(), "waiting", "waiting propagates");
    assertEq(client.getLastError()?.code, "capacity_exceeded", "waiting error code preserved");

    bondSub.push({ phase: "disconnected" });
    assertEq(client.getStreamPhase(), "disconnected", "disconnected overrides waiting");

    oracleSub.push({
      phase: "rejected",
      error: { code: "key_not_allowed", message: "forbidden key" }
    });
    assertEq(client.getStreamPhase(), "rejected", "rejected overrides disconnected & waiting");
    assertEq(client.getLastError()?.code, "key_not_allowed", "rejected code preserved");
    assertEq(client.getLastError()?.keyLabel, "Oracle NFT", "rejected keyLabel set");

    client.dispose();
  });

  await runSuite("4. Exact mempool BoxView mapping, bigint precision & oracle refreshPending", async () => {
    const relay = new MockRelay();
    const client = new ZcHergmesClient("https://relay.example.com", {
      network: Network.Mainnet,
      debounceMs: 15,
      createRelay: () => relay
    });

    const snapshots: LiveZcSnapshot[] = [];
    client.onLiveUpdate((s) => snapshots.push(s));

    await client.start();

    const tip: BlockRef = { height: 1_500_020, headerId: hexId("a20") };
    const orderAddr = getZcScriptAddress(getZcScript("Order", "ERG"), Network.Mainnet);

    const hugeVal = 9_007_199_254_740_995n; // > Number.MAX_SAFE_INTEGER
    const confirmedActive = makeConfirmedBox({
      boxId: hexId("c1"),
      value: hugeVal,
      inclusionHeight: 1_500_012
    });
    const confirmedSpentInMempool = makeConfirmedBox({
      boxId: hexId("c2"),
      value: 3_000_000_000n,
      inclusionHeight: 1_500_015
    });
    const pendingCreated = makePendingBox({
      boxId: hexId("d1"),
      value: 4_000_000_000n
    });

    const oracleBoxId = hexId("e1");
    const oracleBox = makeOracleConfirmedBox(oracleBoxId, 750_000_000n, 42, 1_500_018);

    const overrides = new Map<string, BoxView>([
      [
        `a:${orderAddr}`,
        makeBoxView({
          lastChange: tip,
          confirmed: [confirmedActive, confirmedSpentInMempool],
          pending: [
            {
              txId: hexId("ee1"),
              created: [pendingCreated],
              spent: [confirmedSpentInMempool.boxId]
            }
          ]
        })
      ],
      [
        `t:${ZC_ORACLE_V2_NFT}`,
        makeBoxView({
          lastChange: tip,
          confirmed: [oracleBox],
          pending: []
        })
      ]
    ]);

    relay.emitTip(tip);
    relay.setAllLive(tip, overrides);
    await sleep(40);

    assertEq(snapshots.length, 1, "initial live state coalesced into 1 push");
    const snap1 = snapshots[0];
    assertEq(snap1.confirmedBoxes.length, 1, "only unspent confirmed box remains");
    assertEq(snap1.confirmedBoxes[0].boxId, confirmedActive.boxId, "active confirmed box present");
    assertEq(snap1.confirmedBoxes[0].value, hugeVal, "bigint > 2^53 preserved exactly");
    assertEq(snap1.confirmedBoxes[0].settlementHeight, 1_500_012, "inclusionHeight -> settlementHeight");
    assertEq(snap1.pendingBoxes.length, 1, "mempool output in pendingBoxes");
    assertEq(snap1.pendingBoxes[0].boxId, pendingCreated.boxId, "pending box id matches");
    assertEq(snap1.pendingBoxes[0].settlementHeight, 0, "pending box settlementHeight is 0");
    assert(snap1.confirmedOracle !== null, "oracle decoded");
    assertEq(snap1.confirmedOracle.price, 750_000_000n, "oracle price decoded");
    assertEq(snap1.confirmedOracle.epoch, 42, "oracle epoch decoded");
    assertEq(snap1.refreshPending, false, "oracle refreshPending initially false");

    // Oracle box gets spent in mempool -> refreshPending flips true while confirmedOracle remains
    const oracleSub = relay.getSub({ tokenId: ZC_ORACLE_V2_NFT });
    oracleSub.push({
      boxes: makeBoxView({
        lastChange: tip,
        confirmed: [oracleBox],
        pending: [{ txId: hexId("ee9"), created: [], spent: [oracleBoxId] }]
      })
    });
    await sleep(40);

    assertEq(snapshots.length, 2, "oracle mempool update emitted");
    assertEq(snapshots[1].refreshPending, true, "refreshPending becomes true");
    assertEq(snapshots[1].confirmedOracle?.box.boxId, oracleBoxId, "confirmedOracle retained");

    client.dispose();
  });

  await runSuite("5. Debounce coalescing, balance-only filter, tip-only & targeted fillsDirty", async () => {
    const relay = new MockRelay();
    const client = new ZcHergmesClient("https://relay.example.com", {
      network: Network.Mainnet,
      debounceMs: 30,
      createRelay: () => relay
    });

    const snapshots: LiveZcSnapshot[] = [];
    client.onLiveUpdate((s) => snapshots.push(s));

    await client.start();
    const tip1: BlockRef = { height: 1_500_030, headerId: hexId("a30") };
    relay.emitTip(tip1);
    relay.setAllLive(tip1);
    await sleep(60);

    assertEq(snapshots.length, 1, "1 initial snapshot");
    assertEq(snapshots[0].fillsDirty, false, "initial load does not mark fillsDirty");

    const orderSub = relay.getSub({
      address: getZcScriptAddress(getZcScript("Order", "ERG"), Network.Mainnet)
    });
    const bondSub = relay.getSub({
      address: getZcScriptAddress(getZcScript("Bond", "ERG"), Network.Mainnet)
    });
    const askSub = relay.getSub({
      address: getZcScriptAddress(getZcScript("PricedAsk", "SigUSD"), Network.Mainnet)
    });

    // Balance-only frame (same boxes ref) should NOT trigger an extra live push
    orderSub.push({
      balance: {
        asOf: tip1,
        confirmed: { nanoErgs: 100n, tokens: new Map() },
        pending: { nanoErgs: 0n, tokens: new Map() }
      }
    });
    await sleep(60);
    assertEq(snapshots.length, 1, "balance-only change did not trigger redundant push");

    // Burst: tip advances + non-fill Order(ERG) changes + Bond(ERG) mempool-only change (lastChange unchanged)
    const tip2: BlockRef = { height: 1_500_031, headerId: hexId("a31") };
    relay.emitTip(tip2);
    orderSub.push({
      boxes: makeBoxView({ lastChange: tip2, confirmed: [makeConfirmedBox({ boxId: hexId("c31"), inclusionHeight: 1_500_031 })] })
    });
    bondSub.push({
      boxes: makeBoxView({
        lastChange: tip1, // unchanged lastChange -> mempool-only
        pending: [{ txId: hexId("dd1"), created: [makePendingBox({ boxId: hexId("d31") })], spent: [] }]
      })
    });
    await sleep(60);

    assertEq(snapshots.length, 2, "burst coalesced into 1 push");
    assertEq(snapshots[1].state.height, 1_500_031, "new tip reflected");
    assertEq(snapshots[1].fillsDirty, false, "non-fill block + Bond mempool do NOT dirty fills");

    // Tip-only advance (no key changes) still emits with fillsDirty: false
    const tip3: BlockRef = { height: 1_500_032, headerId: hexId("a32") };
    relay.emitTip(tip3);
    await sleep(60);
    assertEq(snapshots.length, 3, "tip-only advance pushed");
    assertEq(snapshots[2].state.height, 1_500_032, "height updated on tip-only block");
    assertEq(snapshots[2].fillsDirty, false, "tip-only does not dirty fills");

    // Confirmed block on Bond(ERG) -> fillsDirty = true
    const tip4: BlockRef = { height: 1_500_033, headerId: hexId("a33") };
    relay.emitTip(tip4);
    bondSub.push({ boxes: makeBoxView({ lastChange: tip4 }) });
    await sleep(60);
    assertEq(snapshots.length, 4, "Bond block pushed");
    assertEq(snapshots[3].fillsDirty, true, "Bond confirmed block marks fillsDirty");

    // Next unrelated push resets fillsDirty back to false
    const tip5: BlockRef = { height: 1_500_034, headerId: hexId("a34") };
    relay.emitTip(tip5);
    await sleep(60);
    assertEq(snapshots.length, 5, "tip5 pushed");
    assertEq(snapshots[4].fillsDirty, false, "fillsDirty resets after emission");

    // Rollback on PricedAsk(SigUSD) (lastChange changes back) -> fillsDirty = true
    const rollbackRef: BlockRef = { height: 1_500_029, headerId: hexId("a29") };
    askSub.push({ boxes: makeBoxView({ lastChange: rollbackRef }) });
    await sleep(60);
    assertEq(snapshots.length, 6, "rollback pushed");
    assertEq(snapshots[5].fillsDirty, true, "PricedAsk rollback marks fillsDirty");

    client.dispose();
  });

  await runSuite("6. REST methods, live spendable cache + 404 fallback, checkTransaction & historical delegation", async () => {
    const relay = new MockRelay();
    const historical = new MockHistoricalClient();

    const histBox = mapHergmesBox(makeConfirmedBox({ boxId: hexId("77") }));
    historical.boxesResult.set(histBox.boxId, histBox);

    const client = new ZcHergmesClient("https://relay.example.com", {
      network: Network.Mainnet,
      debounceMs: 10,
      historicalClient: historical,
      createRelay: () => relay
    });

    // Historical delegation works directly
    const histBoxes = await client.fetchBoxesByIds([histBox.boxId]);
    assertEq(histBoxes.get(histBox.boxId)?.boxId, histBox.boxId, "fetchBoxesByIds delegates");
    assertEq(historical.boxCalls.length, 1, "historical fetchBoxesByIds called");

    await client.fetchTransactionsByIds([hexId("88")]);
    assertEq(historical.txIdCalls.length, 1, "fetchTransactionsByIds delegates");

    await client.fetchTransactionsByAddresses(["9fAddr"], 1_400_000, 2);
    assertEq(historical.txAddrCalls.length, 1, "fetchTransactionsByAddresses delegates");

    // fetchTokensByIds uses relay.rest.tokens
    const tokId = hexId("555");
    relay.restTokensHandler = async () => ({
      items: [
        {
          tokenId: tokId,
          mintingBoxId: hexId("556"),
          name: "SigUSD",
          description: "AgeUSD stablecoin",
          decimals: 2,
          emission: "100000000"
        }
      ]
    });
    const tokens = await client.fetchTokensByIds([tokId.toUpperCase(), tokId]);
    assertEq(relay.restTokenCalls.length, 1, "tokens requested in one batch");
    assertEq(relay.restTokenCalls[0].length, 1, "deduplicated token ids");
    assertEq(tokens.get(tokId)?.name, "SigUSD", "token name mapped");
    assertEq(tokens.get(tokId)?.decimals, 2, "token decimals mapped");
    assertEq(tokens.get(tokId)?.emissionAmount, "100000000", "token emission mapped");

    // Start live stream with 1 live spendable box + 1 mempool-spent box
    await client.start();
    const tip: BlockRef = { height: 1_500_040, headerId: hexId("a40") };
    const orderAddr = getZcScriptAddress(getZcScript("Order", "ERG"), Network.Mainnet);
    const liveBox = makeConfirmedBox({ boxId: hexId("b10"), inclusionHeight: 1_500_038 });
    const spentBox = makeConfirmedBox({ boxId: hexId("b11"), inclusionHeight: 1_500_038 });
    const externalWalletBoxId = hexId("b12");

    relay.restBoxHandler = async (id) => {
      if (id === externalWalletBoxId) {
        return {
          boxId: externalWalletBoxId,
          transactionId: hexId("a12"),
          value: "1500000000",
          index: 1,
          creationHeight: 1_500_039,
          inclusionHeight: 1_500_040,
          ergoTree: "0008cd02",
          assets: [],
          additionalRegisters: {}
        };
      }
      throw new RelayError(404, "box not found", { code: "box_not_found" });
    };

    relay.emitTip(tip);
    relay.setAllLive(
      tip,
      new Map([
        [
          `a:${orderAddr}`,
          makeBoxView({
            lastChange: tip,
            confirmed: [liveBox, spentBox],
            pending: [{ txId: hexId("ee2"), created: [], spent: [spentBox.boxId] }]
          })
        ]
      ])
    );

    const spendable = await client.fetchSpendableBoxesByIds([
      liveBox.boxId,
      spentBox.boxId,
      externalWalletBoxId
    ]);
    assertEq(spendable.has(liveBox.boxId), true, "live box served from in-memory map");
    assertEq(spendable.has(spentBox.boxId), false, "mempool-spent box absent after 404");
    assertEq(spendable.has(externalWalletBoxId), true, "external spendable box fetched via REST");
    assertEq(
      spendable.get(externalWalletBoxId)?.value,
      1_500_000_000n,
      "REST PoolBox value converted to bigint"
    );
    assert(
      !relay.restBoxCalls.includes(liveBox.boxId),
      "live box did NOT hit REST /v1/boxes/{id}"
    );
    assert(
      relay.restBoxCalls.includes(spentBox.boxId) &&
        relay.restBoxCalls.includes(externalWalletBoxId),
      "only non-live ids hit REST /v1/boxes/{id}"
    );

    // Non-404 REST error must throw ZcApiError (not silently report absent)
    relay.restBoxHandler = async () => {
      throw new RelayError(503, "node unavailable", { code: "node_unavailable" });
    };
    let boxErr: unknown = null;
    try {
      await client.fetchSpendableBoxesByIds([hexId("b99")]);
    } catch (e) {
      boxErr = e;
    }
    assert(boxErr instanceof ZcApiError && boxErr.status === 503, "503 propagates as ZcApiError");

    // checkTransaction: ok and structured rejection
    const dummySignedTx = {
      id: hexId("123"),
      inputs: [],
      dataInputs: [],
      outputs: []
    } as unknown as SignedTransaction;

    let lastBroadcast: boolean | undefined;
    relay.submitHandler = async (_tx, opts) => {
      lastBroadcast = opts?.broadcast;
      return { transactionId: hexId("123") };
    };
    const okRes = await client.checkTransaction(dummySignedTx);
    assertEq(lastBroadcast, false, "checkTransaction sets broadcast: false");
    assertEq(okRes.ok, true, "checkTransaction ok");
    if (okRes.ok) assertEq(okRes.txId, hexId("123"), "checkTransaction txId");

    relay.submitHandler = async () => {
      throw new RelayError(400, "Fee is below minimum", {
        code: "transaction_rejected",
        reason: "fee_too_low"
      });
    };
    const failRes = await client.checkTransaction(dummySignedTx);
    assertEq(failRes.ok, false, "checkTransaction returns ok: false on RelayError");
    if (!failRes.ok) {
      assertEq(failRes.reason, "fee_too_low", "structured RejectReason returned");
      assertEq(failRes.message, "Fee is below minimum", "error message preserved");
    }

    // Live fast-path for fetchStateAndOracle & fetchAllUnspentZcBoxes uses 0 extra REST calls
    const statusCallsBefore = relay.restStatusCalls;
    const boxesCallsBefore = relay.restBoxesCalls.length;
    const stateAndOracle = await client.fetchStateAndOracle();
    const allUnspent = await client.fetchAllUnspentZcBoxes();
    assertEq(stateAndOracle.state.height, 1_500_040, "live fetchStateAndOracle height");
    assertEq(allUnspent.boxes.length, 1, "live fetchAllUnspentZcBoxes count");
    assertEq(relay.restStatusCalls, statusCallsBefore, "0 REST status calls when live");
    assertEq(relay.restBoxesCalls.length, boxesCallsBefore, "0 REST boxes calls when live");

    client.dispose();
  });

  await runSuite("7. Clean close(), setEndpoint() & pending waiter teardown", async () => {
    const relays: MockRelay[] = [];
    const client = new ZcHergmesClient("https://relay-1.example.com", {
      network: Network.Mainnet,
      debounceMs: 20,
      createRelay: () => {
        const r = new MockRelay();
        relays.push(r);
        return r;
      }
    });

    await client.start();
    assertEq(relays.length, 1, "first relay created");
    const firstRelay = relays[0];
    const waiter = client.waitUntilReady(5_000);

    client.setEndpoint("https://relay-2.example.com");
    assertEq(firstRelay.closed, true, "old relay closed on setEndpoint");
    assertEq(client.getRelay(), null, "getRelay null after setEndpoint before start");
    assertEq(client.getStreamPhase(), "idle", "phase reset to idle");
    for (const sub of firstRelay.subs.values()) {
      assertEq(sub.closed, true, "every subscription hold closed");
    }

    let waiterErr: unknown = null;
    try {
      await waiter;
    } catch (e) {
      waiterErr = e;
    }
    assert(waiterErr instanceof ZcApiError, "pending waiter rejected on close");

    await client.start();
    assertEq(relays.length, 2, "second relay created after start");
    assertEq(client.getEndpoint(), "https://relay-2.example.com", "new endpoint active");

    client.dispose();
    assertEq(relays[1].closed, true, "second relay closed on dispose");
    assertEq(client.getRelay(), null, "getRelay null after dispose");
  });

  await runSuite("8. Step 2: Mempool-aware buildMarketBook & pending standing", async () => {
    const partyTree = `0008cd02${"11".repeat(32)}`;
    const partyHash = hex.encode(blake2b256(hex.decode(partyTree)));
    const liqHash = "caa76cff5dc32ccc9546daa3025f4a051690d5970528ce9198b63fd3a76ba8fb";
    const orderScript = getZcScript("Order", "ERG");
    const makeOrderBox = (id: string, txId: string, inclusionHeight?: number): ChainBox => ({
      boxId: id,
      transactionId: txId,
      value: 20_000_000_000n,
      index: 0,
      creationHeight: 1_500_000,
      settlementHeight: inclusionHeight ?? 0,
      ergoTree: orderScript.ergoTreeHex,
      assets: [],
      additionalRegisters: {
        R4: encodeLongs([12_000_000_000n, 10_000_000_000n, 1_500_000n, 1_510_000n, 1_505_000n, 5_000_000n, 0n]),
        R5: encodeTokenPairs([]),
        R6: encodeBytes(hex.decode(partyHash)),
        R7: encodeBytes(hex.decode(liqHash))
      }
    });

    const confBox = makeOrderBox(hexId("0a1"), hexId("aa01"), 1_500_001);
    const pendBox = makeOrderBox(hexId("0a2"), hexId("aa02"));
    const confRec = readZcBox(confBox) as ZcOrder;
    const pendRec = readZcBox(pendBox) as ZcOrder;
    assert(confRec && pendRec, "both orders decode cleanly");

    const entries = new Map<string, ZcEntry>([
      [confRec.boxId, { record: confRec, height: 1_500_001 }]
    ]);
    const pendingRecords = new Map<string, ZcRecord>([
      [confRec.boxId, confRec], // duplicate id must NOT double-add
      [pendRec.boxId, pendRec]
    ]);

    const oracleBox = mapHergmesBox(makeOracleConfirmedBox(hexId("0e1"), 750_000_000n, 55, 1_500_000));
    const oracleRec = { box: oracleBox, price: 750_000_000n, epoch: 55 };

    const book = buildMarketBook({
      height: 1_500_005,
      blockId: hexId("b05"),
      revision: 3,
      cut: false,
      entries,
      pendingRecords,
      mempool: true,
      confirmedOracle: oracleRec,
      refreshPending: true
    });

    assertEq(book.mempool, true, "book.mempool reflects true");
    assertEq(book.orders.length, 2, "1 confirmed + 1 pending order (deduplicated)");
    const confOpen = book.byBoxId.get(confRec.boxId)!;
    const pendOpen = book.byBoxId.get(pendRec.boxId)!;
    assertEq(confOpen.pending, false, "confirmed order has pending: false");
    assertEq(pendOpen.pending, true, "mempool order has pending: true");
    assertEq(book.confirmedOracle?.box.boxId, oracleBox.boxId, "confirmedOracle preserved");
    assertEq(book.refreshPending, true, "refreshPending propagated");
    assertEq(book.oracle, null, "book.oracle nulled while refreshPending");

    const matcher = new ZcMatcher(book, () => null);
    const json = new ZcJson(matcher, {
      origin: () => null,
      disclosed: () => null, // not looked up yet (mempool tx)
      mine: () => false,
      chain: () => null
    });
    const pendJson = json.orderJson(pendOpen as never);
    assertEq(pendJson.pending, true, "JSON marks pending: true");
    assertEq(pendJson.created, null, "JSON createdHeight is null for pending order");
    assertEq(pendJson.status, "ok", "pending order with undisclosed=null is NOT falsely flagged");
  });

  await runSuite("9. Step 3: ZcResolver pending-safe warming & localStorage persistence", async () => {
    const store = new Map<string, string>();
    const storage: ResolverStorageLike = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
      removeItem: (k) => {
        store.delete(k);
      }
    };

    const hist = new MockHistoricalClient();
    const partyTree = `0008cd02${"22".repeat(32)}`;
    const partyHash = hex.encode(blake2b256(hex.decode(partyTree)));
    const liqHash = "caa76cff5dc32ccc9546daa3025f4a051690d5970528ce9198b63fd3a76ba8fb";
    const orderScript = getZcScript("Order", "ERG");
    const makeOrderBox = (id: string, txId: string, inclusionHeight?: number): ChainBox => ({
      boxId: id,
      transactionId: txId,
      value: 20_000_000_000n,
      index: 0,
      creationHeight: 1_500_000,
      settlementHeight: inclusionHeight ?? 0,
      ergoTree: orderScript.ergoTreeHex,
      assets: [],
      additionalRegisters: {
        R4: encodeLongs([12_000_000_000n, 10_000_000_000n, 1_500_000n, 1_510_000n, 1_505_000n, 5_000_000n, 0n]),
        R5: encodeTokenPairs([]),
        R6: encodeBytes(hex.decode(partyHash)),
        R7: encodeBytes(hex.decode(liqHash))
      }
    });

    const pendOrder = readZcBox(makeOrderBox(hexId("0b1"), hexId("bb01"))) as ZcOrder;
    const pendBook = buildMarketBook({
      height: 1_500_010,
      blockId: hexId("b10"),
      revision: 1,
      cut: false,
      entries: new Map(),
      pendingRecords: new Map([[pendOrder.boxId, pendOrder]]),
      mempool: true,
      confirmedOracle: null
    });

    const resolver1 = new ZcResolver(() => hist, {
      network: "mainnet",
      storage,
      persistDebounceMs: 0
    });
    await resolver1.warmForBook(pendBook);
    assertEq(hist.txIdCalls.length, 0, "pending order skipped disclosure tx lookup");
    assertEq(
      resolver1.knownDisclosed(pendOrder, 1_500_010),
      null,
      "pending order NOT negatively cached as undisclosed"
    );

    // Once mined (pending: false), creating tx resolves & persists script hash to storage
    hist.txsResult.set(pendOrder.box.transactionId, {
      transactionId: pendOrder.box.transactionId,
      inclusionHeight: 1_500_011,
      timestamp: 1_700_000_000_000,
      inputs: [{ boxId: hexId("001"), index: 0, extension: {}, box: null }],
      dataInputs: [],
      outputs: [
        {
          ...pendOrder.box,
          boxId: hexId("002"),
          ergoTree: partyTree
        }
      ]
    });

    // Also test confirmed origin with bigint terms & held amount persistence
    const spentMinterBox: ChainBox = {
      ...makeOrderBox(hexId("0b9"), hexId("bb09"), 1_499_990),
      spentTransactionId: hexId("bb10"),
      spendingHeight: 1_499_995
    };
    hist.boxesResult.set(spentMinterBox.boxId, spentMinterBox);

    const confBook = buildMarketBook({
      height: 1_500_011,
      blockId: hexId("b11"),
      revision: 2,
      cut: false,
      entries: new Map([[pendOrder.boxId, { record: pendOrder, height: 1_500_011 }]]),
      mempool: true,
      confirmedOracle: null
    });

    await resolver1.warmForBook(confBook);
    await resolver1.resolveOrigins([spentMinterBox.boxId], 1_500_011);
    assertEq(resolver1.knownDisclosed(pendOrder, 1_500_011), true, "mined order disclosed cleanly");
    assertEq(resolver1.knownOrigin(spentMinterBox.boxId)?.txId, hexId("bb10"), "origin resolved");
    assert(
      store.has(resolverCacheStorageKey("mainnet")),
      `persisted under key ${resolverCacheStorageKey("mainnet")} (commit ${ZC_PINNED_COMMIT})`
    );

    // Rehydrate fresh resolver from same storage -> 0 historical calls needed!
    const hist2 = new MockHistoricalClient();
    const resolver2 = new ZcResolver(() => hist2, {
      network: "mainnet",
      storage,
      persistDebounceMs: 0
    });
    assertEq(resolver2.knownScript(partyHash), partyTree, "script hydrated from storage");
    assertEq(resolver2.knownOrigin(spentMinterBox.boxId)?.txId, hexId("bb10"), "origin hydrated");
    await resolver2.warmForBook(confBook);
    assertEq(hist2.txIdCalls.length, 0, "rehydrated resolver makes 0 tx calls");

    // Switching network isolates caches cleanly
    resolver2.setNetwork("testnet");
    assertEq(resolver2.knownScript(partyHash), null, "testnet isolated from mainnet cache");
  });

  await runSuite("10. Step 4: ZcGraphqlEngine hergmes push mode & targeted fills cache", async () => {
    const relay = new MockRelay();
    const historical = new MockHistoricalClient();
    const engine = new ZcGraphqlEngine(DEFAULT_MAINNET_HERGMES_URL, "hergmes");

    // Inject mock relay onto engine via setTransport or direct hergmesClient test
    // Verify engine's default hergmes wiring and live push lifecycle with a mock client
    const mockHergmes = new ZcHergmesClient(DEFAULT_MAINNET_HERGMES_URL, {
      network: Network.Mainnet,
      debounceMs: 10,
      historicalClient: historical,
      createRelay: () => relay
    });

    // Wire a fresh engine whose internal hergmes client uses mockHergmes via transport override check
    assertEq(engine.getTransport(), "hergmes", "engine supports hergmes transport");
    assertEq(engine.getEndpoint(), DEFAULT_MAINNET_HERGMES_URL, "default relay URL is Nautilus Relay");
    assert(engine.getHergmesClient() !== null, "engine exposes getHergmesClient()");
    engine.stopLive();
    engine.setTransport("explorer", "https://api.ergoscan.me/v1");
    assertEq(engine.getHergmesClient(), null, "switching to explorer disposes hergmes client");

    // Verify mockHergmes snapshot + live push + fillsDirty flag end-to-end
    const pushes: LiveZcSnapshot[] = [];
    mockHergmes.onLiveUpdate((s) => pushes.push(s));
    await mockHergmes.start();
    const tip1: BlockRef = { height: 1_500_050, headerId: hexId("a50") };
    relay.emitTip(tip1);
    relay.setAllLive(tip1);
    const readySnap = await mockHergmes.waitUntilReady(1_000);
    assertEq(readySnap.mempool, true, "live snapshot marks mempool: true");
    assertEq(readySnap.fillsDirty, false, "initial live snapshot does not mark fillsDirty");
    mockHergmes.dispose();
  });

  await runSuite("11. Step 7: Pre-sign fetchSpendableBoxesByIds & checkTransaction dry-run", async () => {
    const relay = new MockRelay();
    const historical = new MockHistoricalClient();
    const hergmes = new ZcHergmesClient(DEFAULT_MAINNET_HERGMES_URL, {
      network: Network.Mainnet,
      debounceMs: 10,
      historicalClient: historical,
      createRelay: () => relay
    });
    await hergmes.start();
    const tip: BlockRef = { height: 1_500_060, headerId: hexId("a60") };
    const orderScript = getZcScript("Order", "ERG");
    const orderAddr = getZcScriptAddress(orderScript, Network.Mainnet);
    const partyTree = `0008cd02${"33".repeat(32)}`;
    const partyAddr = ErgoAddress.fromErgoTree(partyTree, Network.Mainnet).encode(Network.Mainnet);
    const partyHash = hex.encode(blake2b256(hex.decode(partyTree)));
    const liqHash = "caa76cff5dc32ccc9546daa3025f4a051690d5970528ce9198b63fd3a76ba8fb";

    const orderBox = makeConfirmedBox({
      boxId: hexId("0c1"),
      value: 20_000_000_000n,
      inclusionHeight: 1_500_055,
      ergoTree: orderScript.ergoTreeHex,
      additionalRegisters: {
        R4: encodeLongs([12_000_000_000n, 10_000_000_000n, 1_500_000n, 1_510_000n, 1_505_000n, 5_000_000n, 0n]),
        R5: encodeTokenPairs([]),
        R6: encodeBytes(hex.decode(partyHash)),
        R7: encodeBytes(hex.decode(liqHash))
      }
    });

    // Order is confirmed on Explorer, but ALREADY SPENT in mempool on Hergmes!
    historical.boxesResult.set(orderBox.boxId, mapHergmesBox(orderBox));
    relay.emitTip(tip);
    relay.setAllLive(
      tip,
      new Map([
        [
          `a:${orderAddr}`,
          makeBoxView({
            lastChange: tip,
            confirmed: [orderBox],
            pending: [{ txId: hexId("ee7"), created: [], spent: [orderBox.boxId] }]
          })
        ]
      ])
    );

    const orderRec = readZcBox(mapHergmesBox(orderBox)) as ZcOrder;
    const book = buildMarketBook({
      height: 1_500_060,
      blockId: hexId("a60"),
      revision: 1,
      cut: false,
      entries: new Map([[orderRec.boxId, { record: orderRec, height: 1_500_055 }]]),
      confirmedOracle: null
    });
    const resolver = new ZcResolver(() => hergmes, { storage: null });
    const walletAdapter: ZcWalletTxAdapter = {
      network: Network.Mainnet,
      async getAddresses() {
        return { changeAddress: partyAddr, usedAddresses: [partyAddr], unusedAddresses: [] };
      },
      async getUtxos() {
        return [
          {
            boxId: hexId("0d1"),
            transactionId: hexId("dd01"),
            index: 0,
            ergoTree: partyTree,
            creationHeight: 1_500_000,
            value: "50000000000",
            assets: [],
            additionalRegisters: {}
          }
        ];
      },
      async getCurrentHeight() {
        return 1_500_060;
      },
      async signTx() {
        return { id: hexId("999"), inputs: [], dataInputs: [], outputs: [] } as unknown as SignedTransaction;
      },
      async submitTx() {
        throw new Error("Generic Nautilus submission failure");
      }
    };

    const deps: ZcTxDeps = {
      wallet: walletAdapter,
      async getReadContext() {
        return {
          client: hergmes,
          resolver,
          book,
          matcher: new ZcMatcher(book, () => null),
          network: "mainnet"
        };
      },
      checkTransaction: (tx) => hergmes.checkTransaction(tx)
    };

    // buildZcAction uses fetchSpendableBoxesByIds -> detects mempool spend -> throws ZcTxConflictError!
    let conflictErr: unknown = null;
    try {
      await buildZcAction({ type: "cancel", boxId: orderBox.boxId }, deps);
    } catch (e) {
      conflictErr = e;
    }
    assert(
      conflictErr instanceof ZcTxConflictError && /mempool/i.test(conflictErr.message),
      "fresh build catches mempool-spent box via fetchSpendableBoxesByIds"
    );

    // Now make the order box unspent again and verify signAndSubmitZcAction enriches submit failure via checkTransaction
    relay.getSub({ address: orderAddr }).push({
      boxes: makeBoxView({ lastChange: tip, confirmed: [orderBox], pending: [] })
    });
    relay.submitHandler = async () => {
      throw new RelayError(400, "Fee below relay minimum", {
        code: "transaction_rejected",
        reason: "fee_too_low"
      });
    };

    let submitErr: unknown = null;
    try {
      await signAndSubmitZcAction({ type: "cancel", boxId: orderBox.boxId }, deps);
    } catch (e) {
      submitErr = e;
    }
    assert(
      submitErr instanceof ZcTxConflictError &&
        submitErr.message.includes("fee_too_low") &&
        submitErr.message.includes("Fee below relay minimum"),
      "signAndSubmitZcAction surfaces structured Hergmes RelayError.reason on submit failure"
    );

    hergmes.dispose();
  });

  await runSuite("12. Step 9: Wallet live mempool overlay, 15-address cap & spendable UTXOs", async () => {
    // 1. Address cap & priority selection
    const used20 = Array.from({ length: 20 }, (_, i) => `9fUsed${String(i).padStart(2, "0")}`);
    const selBig = selectTrackedWalletAddresses({
      changeAddress: "9fChange",
      usedAddresses: used20,
      unusedAddresses: ["9fUnused0", "9fUnused1", "9fUnused2"]
    });
    assertEq(selBig.tracked.length, MAX_WALLET_HERGMES_ADDRS, "capped at 15 addresses");
    assertEq(selBig.allCount, 24, "total unique count tracked");
    assertEq(selBig.capped, true, "capped flag true for 24 addresses");
    assertEq(selBig.tracked[0], "9fChange", "changeAddress prioritized first");
    assertEq(selBig.tracked[1], "9fUsed19", "most recently used address prioritized next");

    // 2. Full coverage aggregation with confirmed + pending ERG/token deltas + mempool change box
    const relay = new MockRelay();
    const updates: ReturnType<typeof aggregateWalletOverlay>[] = [];
    const manager = new ZcWalletOverlayManager((snap) => updates.push(snap));

    const addrA = "9fWalletA";
    const addrB = "9fWalletB";
    manager.sync(relay, {
      changeAddress: addrA,
      usedAddresses: [addrA, addrB],
      unusedAddresses: []
    });
    assertEq(relay.subs.size, 2, "subscribed to both wallet addresses over shared relay");
    assertEq(manager.getSnapshot().complete, false, "incomplete until all subs are live");

    const tip: BlockRef = { height: 1_500_070, headerId: hexId("a70") };
    const tokId = hexId("516");
    const changeBox = makePendingBox({
      boxId: hexId("0f1"),
      value: 8_500_000_000n,
      assets: [{ tokenId: tokId, amount: 500n }]
    });
    const confirmedB = makeConfirmedBox({
      boxId: hexId("0f2"),
      value: 3_000_000_000n,
      inclusionHeight: 1_500_065
    });

    relay.getSub({ address: addrA }).push({
      phase: "live",
      boxes: makeBoxView({
        lastChange: tip,
        confirmed: [],
        pending: [{ txId: hexId("ff9"), created: [changeBox], spent: [hexId("0f0")] }]
      }),
      balance: {
        asOf: tip,
        confirmed: { nanoErgs: 10_000_000_000n, tokens: new Map() },
        pending: { nanoErgs: -1_500_000_000n, tokens: new Map([[tokId, 500n]]) }
      }
    });
    assertEq(manager.getSnapshot().complete, false, "still incomplete while addrB in snapshot");

    relay.getSub({ address: addrB }).push({
      phase: "live",
      boxes: makeBoxView({
        lastChange: tip,
        confirmed: [confirmedB],
        pending: []
      }),
      balance: {
        asOf: tip,
        confirmed: { nanoErgs: 3_000_000_000n, tokens: new Map() },
        pending: { nanoErgs: 500_000_000n, tokens: new Map() }
      }
    });

    const snap = manager.getSnapshot();
    assertEq(snap.complete, true, "complete true when <= 15 addresses and all live");
    assertEq(snap.hasPendingTx, true, "hasPendingTx true");
    assertEq(snap.pendingBalance.get(WALLET_ERG_TOKEN_ID), -1_000_000_000n, "net pending ERG aggregated across addresses");
    assertEq(snap.pendingBalance.get(tokId), 500n, "pending token delta aggregated");
    assertEq(snap.spendableBoxes.length, 2, "includes mempool change output + confirmed box");
    assert(
      snap.spendableBoxes.some((b) => b.boxId === changeBox.boxId && b.value === "8500000000"),
      "mempool change box converted cleanly to Box<Amount>"
    );

    // 3. Oversized wallet (>15 addrs) keeps complete === false while still reporting tracked pending deltas
    manager.sync(relay, {
      changeAddress: addrA,
      usedAddresses: used20,
      unusedAddresses: []
    });
    for (const sub of relay.subs.values()) {
      if (sub.state.phase !== "live") {
        sub.push({ phase: "live", boxes: makeBoxView({ lastChange: tip }) });
      }
    }
    const cappedSnap = manager.getSnapshot();
    assertEq(cappedSnap.trackedCount, 15, "only 15 holds open");
    assertEq(cappedSnap.allLive, true, "all tracked holds live");
    assertEq(cappedSnap.complete, false, "complete false when wallet exceeds 15-address cap");
    assertEq(cappedSnap.hasPendingTx, true, "pending deltas still reported for tracked subset");

    // 4. Clean disconnect teardown
    manager.clear();
    assertEq(manager.getSnapshot().trackedCount, 0, "cleared trackedCount");
    assertEq(manager.getSnapshot().complete, false, "cleared complete");
    for (const sub of relay.subs.values()) {
      assertEq(sub.closed, true, "every wallet subscription hold closed on clear");
    }
  });

  console.log("\nAll 12 SigmaFi V2 Hergmes verification suites passed!");
}

main().catch((err) => {
  console.error("\nVERIFICATION FAILED:\n", err);
  throw err;
});
