/* eslint-disable no-console */
/**
 * Automated verification suite for the isolated SigmaFi V2 (zcs1) ErgoTree v3
 * transaction subsystem (`src/services/zc/tx/`).
 *
 * Verifies:
 *  1. Cryptographic integrity of all 15 pinned ErgoTree v3 expression `bytesHex` values.
 *  2. Byte-for-byte parity of `ZcMetadata` against Lithos-Client's `ZcUserTransactionsSpec`.
 *  3. Exact register round-tripping (`readZcBox`) for every posted box type.
 *  4. Script disclosure (`var 64`) presence & omission rules.
 *  5. All 19 `ZcTxAction` types end-to-end through `quoteZcAction`, `buildZcAction`,
 *     and `signAndSubmitZcAction` with explicit Nautilus v2.0.0-beta.3+ per-input `signers`.
 *  6. Security edge cases: `avoidTokens` burn protection, dust absorption, `mintWrap` `alone=true`,
 *     partial vs final share claims, Dutch pull states, `repay` from collateral.
 *  7. Negative invariant tests proving `assertTxInvariants` blocks ERG tamper, unintended token
 *     burns, unauthorized mints, wrong/missing Nautilus v3 signers, unverified change
 *     destinations, and `limits` slippage drift.
 */
import { Amount, Box, EIP12UnsignedTransaction, Network, SignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import { blake2b256, hex } from "@fleet-sdk/crypto";
import {
  boxCandidateSize,
  ChainAsset,
  ChainBox,
  disclosedTrees,
  LONG_MAX,
  MAX_BOX_SIZE,
  MAX_COLLATERAL_TOKENS,
  MIN_BOX,
  minBoxValue,
  readZcBox,
  ZcAsk,
  ZcEntry,
  ZcOffer,
  ZcOracle,
  ZcOrder,
  ZcShareVault,
  ZcWrapVault
} from "../../boxes";
import { ChainTransaction, GraphqlTokenInfo, ZcChainClient } from "../../chainClient";
import {
  getZcExpressionHash,
  getZcScript,
  ZC_EXPRESSIONS,
  ZC_ORACLE_V2_ERGO_TREE,
  ZC_ORACLE_V2_NFT,
  ZC_PINNED_COMMIT,
  ZC_SCRIPTS,
  ZC_SIGUSD_TOKEN_ID
} from "../../contracts";
import { selectSpectrumTokenRates } from "../../../assetPricingService";
import { SPECTRUM_ERG_TOKEN_ID } from "../../../spectrumService";
import { coverage } from "../../../../utils/zcMath";
import { buildDraftOffer, buildDraftOrder, simulateDraft } from "../../drafts";
import { ZcApiError } from "../../errors";
import { ZcExplorerClient } from "../../explorerClient";
import { ZcGraphqlClient } from "../../graphqlClient";
import { ZcJson } from "../../json";
import { buildMarketBook, openOf, ZcMatcher } from "../../matcher";
import { ZcResolver } from "../../resolver";
import { verifyToken } from "../../tokenVerification";
import {
  belowOwnRatio,
  lotTarget,
  offerRefusal,
  offerStateOf,
  orderRefusal,
  windowMaturity
} from "../../rules";
import {
  applyScriptDisclosure,
  assertTxInvariants,
  bondMetadata,
  buildBuyFromVaultSpend,
  buildClaimSharesSpend,
  buildFillOrderSpend,
  buildOrderOutput,
  buildUnwrapSpend,
  buildZcAction,
  encodeByte,
  encodeHexBytes,
  encodeInt,
  encodeLong,
  encodeLongs,
  encodeUtf8,
  hashErgoTreeHex,
  indexWalletAddresses,
  NautilusSignOptions,
  quoteZcAction,
  receiptMetadata,
  registersFromList,
  resolveWalletLendStep,
  ruleFields,
  selectAuthBox,
  sharesMetadata,
  signAndSubmitZcAction,
  TX_FEE,
  ZcTxAction,
  ZcTxConflictError,
  ZcTxDeps,
  ZcTxInvariantError,
  ZcWalletTxAdapter
} from "../index";

function toPrintable(val: unknown): string {
  return JSON.stringify(val, (_, v) => (typeof v === "bigint" ? `${v.toString()}n` : v));
}

const assert = {
  ok(cond: unknown, msg?: string): void {
    if (!cond) throw new Error(msg || "Assertion failed: expected truthy value");
  },
  equal<T>(actual: T, expected: T, msg?: string): void {
    if (actual !== expected) {
      throw new Error(
        `${msg ? `${msg}: ` : ""}expected ${toPrintable(expected)}, got ${toPrintable(actual)}`
      );
    }
  },
  deepEqual(actual: unknown, expected: unknown, msg?: string): void {
    const a = toPrintable(actual);
    const e = toPrintable(expected);
    if (a !== e) {
      throw new Error(`${msg ? `${msg}: ` : ""}expected ${e}, got ${a}`);
    }
  },
  throws(fn: () => void, errCtor: new (...args: never[]) => Error): void {
    try {
      fn();
    } catch (err) {
      if (err instanceof errCtor) return;
      throw new Error(
        `Expected ${errCtor.name}, but caught ${err instanceof Error ? err.name : String(err)}`
      );
    }
    throw new Error(`Expected function to throw ${errCtor.name}, but it succeeded`);
  }
};

// ─── Deterministic test fixtures ─────────────────────────────────────────────

const HEIGHT = 1_650_000;
const ERG = 1_000_000_000n;

// Deterministic valid mainnet P2PK addresses constructed from valid secp256k1 compressed pubkeys
const PUBKEY_WALLET_A = "02" + "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PUBKEY_WALLET_B = "02" + "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const PUBKEY_COUNTERPARTY = "02" + "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

const ADDR_A = ErgoAddress.fromPublicKey(PUBKEY_WALLET_A, Network.Mainnet).encode();
const ADDR_B = ErgoAddress.fromPublicKey(PUBKEY_WALLET_B, Network.Mainnet).encode();
const ADDR_CP = ErgoAddress.fromPublicKey(PUBKEY_COUNTERPARTY, Network.Mainnet).encode();

const TREE_A = ErgoAddress.fromBase58(ADDR_A).ergoTree.toLowerCase();
const TREE_B = ErgoAddress.fromBase58(ADDR_B).ergoTree.toLowerCase();
const TREE_CP = ErgoAddress.fromBase58(ADDR_CP).ergoTree.toLowerCase();

const HASH_A = hashErgoTreeHex(TREE_A);
const HASH_CP = hashErgoTreeHex(TREE_CP);

function hexId(seed: number): string {
  return seed.toString(16).padStart(2, "0").repeat(32);
}

function makeChainBox(params: {
  id: string;
  txId?: string;
  index?: number;
  ergoTree: string;
  value: bigint;
  assets?: readonly ChainAsset[];
  additionalRegisters?: Readonly<Record<string, string>>;
  creationHeight?: number;
  spentTransactionId?: string | null;
}): ChainBox {
  const h = params.creationHeight ?? HEIGHT - 100;
  return {
    boxId: params.id.toLowerCase(),
    transactionId: (params.txId ?? hexId(0xee)).toLowerCase(),
    index: params.index ?? 0,
    value: params.value,
    creationHeight: h,
    settlementHeight: h,
    ergoTree: params.ergoTree.toLowerCase(),
    assets: (params.assets ?? []).map((a) => ({
      tokenId: a.tokenId.toLowerCase(),
      amount: a.amount
    })),
    additionalRegisters: params.additionalRegisters ?? {},
    spentTransactionId: params.spentTransactionId ?? null,
    spendingHeight: null
  };
}

function toWalletBox(b: ChainBox): Box<Amount> {
  return {
    boxId: b.boxId,
    transactionId: b.transactionId,
    index: b.index,
    value: b.value.toString(),
    creationHeight: b.creationHeight,
    ergoTree: b.ergoTree,
    assets: b.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
    additionalRegisters: { ...b.additionalRegisters }
  };
}

function candidateToChainBox(
  tx: EIP12UnsignedTransaction,
  outIdx: number,
  boxId: string,
  txId: string
): ChainBox {
  const o = tx.outputs[outIdx];
  const regs: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.additionalRegisters || {})) {
    if (typeof v === "string") regs[k] = v;
  }
  return makeChainBox({
    id: boxId,
    txId,
    index: outIdx,
    ergoTree: o.ergoTree,
    value: BigInt(o.value),
    assets: o.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
    additionalRegisters: regs,
    creationHeight: o.creationHeight
  });
}

// ─── Mock Chain & Wallet Harness ─────────────────────────────────────────────

interface MockHarness {
  readonly deps: ZcTxDeps;
  readonly boxes: Map<string, ChainBox>;
  readonly txs: Map<string, ChainTransaction>;
  readonly tokens: Map<string, GraphqlTokenInfo>;
  readonly entries: Map<string, ZcEntry>;
  readonly walletUtxos: ChainBox[];
  readonly signedCalls: { tx: EIP12UnsignedTransaction; options?: NautilusSignOptions }[];
  oraclePrice: bigint;
  oracleHeight: number;
  height: number;
  registerRecord(box: ChainBox, originTx?: ChainTransaction): void;
  registerSpentBox(box: ChainBox, spentTxId: string): void;
}

function createHarness(): MockHarness {
  const boxes = new Map<string, ChainBox>();
  const txs = new Map<string, ChainTransaction>();
  const tokens = new Map<string, GraphqlTokenInfo>();
  const entries = new Map<string, ZcEntry>();
  const walletUtxos: ChainBox[] = [];
  const signedCalls: { tx: EIP12UnsignedTransaction; options?: NautilusSignOptions }[] = [];

  const harness: MockHarness = {
    deps: null as unknown as ZcTxDeps,
    boxes,
    txs,
    tokens,
    entries,
    walletUtxos,
    signedCalls,
    oraclePrice: 1_000_000_000n, // $1.00 / ERG -> 1e9 nanoERG per USD
    oracleHeight: HEIGHT - 5,
    height: HEIGHT,
    registerRecord(box: ChainBox, originTx?: ChainTransaction) {
      boxes.set(box.boxId, box);
      const rec = readZcBox(box);
      if (rec) {
        entries.set(box.boxId, { record: rec, height: box.creationHeight });
      }
      if (originTx) {
        txs.set(originTx.transactionId.toLowerCase(), originTx);
      }
    },
    registerSpentBox(box: ChainBox, spentTxId: string) {
      const spent: ChainBox = { ...box, spentTransactionId: spentTxId.toLowerCase() };
      boxes.set(spent.boxId, spent);
      entries.delete(spent.boxId);
    }
  };

  const oracleBox = (): ChainBox =>
    makeChainBox({
      id: hexId(0x99),
      ergoTree: ZC_ORACLE_V2_ERGO_TREE,
      value: 10_000_000n,
      assets: [{ tokenId: ZC_ORACLE_V2_NFT, amount: 1n }],
      additionalRegisters: registersFromList([encodeLong(harness.oraclePrice), encodeInt(100)]),
      creationHeight: harness.oracleHeight
    });

  const client: ZcChainClient = {
    getEndpoint: () => "mock://chain",
    setEndpoint: () => undefined,
    async fetchStateAndOracle() {
      const ob = oracleBox();
      boxes.set(ob.boxId, ob);
      const oracle: ZcOracle = { box: ob, price: harness.oraclePrice, epoch: 100 };
      return {
        state: { height: harness.height, blockId: hexId(0xaa), network: "mainnet" },
        oracle
      };
    },
    async fetchAllUnspentZcBoxes() {
      return { boxes: Array.from(entries.values()).map((e) => e.record.box), cut: false };
    },
    async fetchBoxesByIds(ids: readonly string[]) {
      const ob = oracleBox();
      boxes.set(ob.boxId, ob);
      const out = new Map<string, ChainBox>();
      for (const raw of ids) {
        const id = raw.toLowerCase();
        const found = boxes.get(id);
        if (found) out.set(id, found);
      }
      return out;
    },
    async fetchTransactionsByIds(ids: readonly string[]) {
      const out = new Map<string, ChainTransaction>();
      for (const raw of ids) {
        const id = raw.toLowerCase();
        const found = txs.get(id);
        if (found) out.set(id, found);
      }
      return out;
    },
    async fetchTokensByIds(ids: readonly string[]) {
      const out = new Map<string, GraphqlTokenInfo>();
      for (const raw of ids) {
        const id = raw.toLowerCase();
        const found = tokens.get(id);
        if (found) out.set(id, found);
      }
      return out;
    },
    async fetchTransactionsByAddresses() {
      return [];
    }
  };

  const resolver = new ZcResolver(() => client);

  const wallet: ZcWalletTxAdapter = {
    network: Network.Mainnet,
    async getAddresses() {
      return {
        changeAddress: ADDR_A,
        usedAddresses: [ADDR_A, ADDR_B],
        unusedAddresses: []
      };
    },
    async getUtxos() {
      return walletUtxos.map(toWalletBox);
    },
    async getCurrentHeight() {
      return harness.height;
    },
    async signTx(unsignedTx: EIP12UnsignedTransaction, options?: NautilusSignOptions) {
      signedCalls.push({ tx: unsignedTx, options });
      return {
        id: hexId(0xab),
        inputs: unsignedTx.inputs.map((i) => ({
          boxId: i.boxId,
          spendingProof: { proofBytes: "", extension: i.extension }
        })),
        dataInputs: unsignedTx.dataInputs.map((d) => ({ boxId: d.boxId })),
        outputs: unsignedTx.outputs.map((o, idx) => ({
          ...o,
          boxId: hexId(0xc0 + idx),
          transactionId: hexId(0xab),
          index: idx
        }))
      } as unknown as SignedTransaction;
    },
    async submitTx() {
      return hexId(0xab);
    }
  };

  (harness as { deps: ZcTxDeps }).deps = {
    wallet,
    async getReadContext() {
      const ob = oracleBox();
      boxes.set(ob.boxId, ob);
      const oracle: ZcOracle = { box: ob, price: harness.oraclePrice, epoch: 100 };
      const book = buildMarketBook({
        height: harness.height,
        blockId: hexId(0xaa),
        revision: 1,
        cut: false,
        entries: new Map(entries),
        confirmedOracle: oracle
      });
      await resolver.warmForBook(book);
      const matcher = new ZcMatcher(book, (t) => resolver.knownOrigin(t));
      return { client, resolver, book, matcher, network: "mainnet" };
    }
  };

  return harness;
}

function makeDisclosureTx(txId: string, disclosedTreeHex: string): ChainTransaction {
  return {
    transactionId: txId.toLowerCase(),
    inclusionHeight: HEIGHT - 50,
    timestamp: Date.now(),
    inputs: [],
    dataInputs: [],
    outputs: [
      makeChainBox({
        id: hexId(0xfe),
        txId,
        index: 1,
        ergoTree: disclosedTreeHex,
        value: MIN_BOX
      })
    ]
  };
}

// ─── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

async function runAll(): Promise<void> {
  console.log("\n=== SigmaFi V2 (zcs1) ErgoTree v3 Transaction Verification ===\n");

  // 1. Cryptographic integrity of all 15 pinned expression bytes
  await test("1. All 15 pinned ZC_EXPRESSIONS bytesHex hash via blake2b256 to their exact pinned hash", () => {
    assert.equal(ZC_EXPRESSIONS.length, 15);
    for (const e of ZC_EXPRESSIONS) {
      assert.ok(e.bytesHex.length > 0, `Missing bytesHex for ${e.expression}`);
      const actual = hex.encode(blake2b256(hex.decode(e.bytesHex)));
      assert.equal(
        actual,
        e.hash,
        `Hash mismatch for ${e.expression}(${e.market ?? "shared"})`
      );
    }
  });

  // 2. Metadata parity with ZcUserTransactionsSpec.scala
  await test("2. ZcMetadata matches Lithos-Client ZcUserTransactionsSpec byte-for-byte", () => {
    const selective = sharesMetadata(
      "ERG",
      {
        openingBps: 10_000n,
        floorBps: 9_000n,
        length: 720n,
        expiry: 2160n,
        threshold: 100n
      },
      null
    );
    assert.deepEqual(selective, [
      "ZCS-Bond-Shares",
      `{"zcs":1,"type":"selective shares","shares":100,"market":"ERG","via":"lend offer","auction":{"from":100,"to":90,"blocks":720,"expiry":2160,"threshold":100},"note":"Verify on chain."}`,
      "6"
    ]);

    const bondMeta = bondMetadata({
      market: "ERG",
      asset: "abcdef1234567890".repeat(4),
      principal: 10_000_000_000n,
      repayment: 11_000_000_000n,
      start: 1_650_000n,
      maturity: 1_700_000n,
      rule: ruleFields("oracle", [15_000n, 60n], getZcExpressionHash("OracleLiquidation", "ERG"))
    });
    assert.equal(bondMeta[0], "ZCS-Bond-Unit-abcdef");
    assert.equal(bondMeta[2], "0");
    assert.equal(
      bondMeta[1],
      `{"zcs":1,"type":"bond unit","market":"ERG","principal":10,"repayment":11,"start":1650000,"maturity":1700000,"rule":"oracle","ratio":150,"note":"Verify on chain."}`
    );

    const wrapMeta = receiptMetadata("123456".padEnd(64, "0"), 1n);
    assert.equal(wrapMeta[0], "ZCS-Wrap-123456");
    assert.equal(wrapMeta[2], "0");
  });

  // 3. Script disclosure var 64 (I-8: outputs-only check so exact-ERG mempool txs stay resolvable)
  await test("3. Script disclosure var 64 attaches iff named script is absent from outputs (I-8)", () => {
    const inpB = {
      boxId: hexId(1),
      transactionId: hexId(2),
      index: 0,
      ergoTree: TREE_B,
      creationHeight: HEIGHT - 10,
      value: ERG.toString(),
      assets: [],
      additionalRegisters: {},
      extension: {}
    };
    const outB = {
      ergoTree: TREE_B,
      creationHeight: HEIGHT,
      value: (ERG / 2n).toString(),
      assets: [],
      additionalRegisters: {}
    };

    const disclosed = applyScriptDisclosure([inpB], [outB], TREE_A);
    assert.ok(disclosed[0].extension[64], "Expected var 64 on INPUTS(0)");
    assert.deepEqual(disclosedTrees(disclosed[0].extension[64]!), [TREE_A]);

    // Even when TREE_A is in inputs, outputs lack TREE_A -> var 64 MUST still be attached!
    const inpA = { ...inpB, ergoTree: TREE_A };
    const disclosedExact = applyScriptDisclosure([inpA], [outB], TREE_A);
    assert.ok(
      disclosedExact[0].extension[64],
      "var 64 MUST be attached when named tree appears only in inputs (exact-ERG mempool disclosure)"
    );
    assert.deepEqual(disclosedTrees(disclosedExact[0].extension[64]!), [TREE_A]);

    // When TREE_A appears in outputs, var 64 is omitted
    const outA = { ...outB, ergoTree: TREE_A };
    const omitted = applyScriptDisclosure([inpB], [outA], TREE_A);
    assert.equal(omitted[0].extension[64], undefined, "var 64 should be omitted when present in outputs");
  });

  // 4-22. All 19 ZcTxActions end-to-end (quote + build + Nautilus v3 signers + readZcBox round-trip)
  const h = createHarness();
  const NFT_ID = hexId(0x77);
  h.walletUtxos.push(
    makeChainBox({ id: hexId(0x01), ergoTree: TREE_A, value: 100n * ERG }),
    makeChainBox({
      id: hexId(0x02),
      ergoTree: TREE_A,
      value: 5n * ERG,
      assets: [{ tokenId: ZC_SIGUSD_TOKEN_ID, amount: 50_000n }]
    }),
    makeChainBox({
      id: hexId(0x03),
      ergoTree: TREE_A,
      value: 2n * ERG,
      assets: [{ tokenId: NFT_ID, amount: 1n }]
    })
  );

  // Action 1: createOrder (yield PricedOrder + FillGuard)
  let postedOrderBox!: ChainBox;
  await test("4. [1/19] createOrder builds, passes invariants, round-trips via readZcBox", async () => {
    const body = {
      market: "ERG",
      pricing: "yield",
      principal: (1n * ERG).toString(),
      repayment: (11n * ERG / 10n).toString(),
      timing: { mode: "fixed", maturity: HEIGHT + 50_000, exact: true },
      yield: { startBps: 800, endBps: 1200 },
      collateral: { nanoErg: (3n * ERG).toString() },
      rule: { kind: "oracle", ratioBps: 15_000 }
    };
    const action: ZcTxAction = { type: "createOrder", body };
    const quote = await quoteZcAction(action, h.deps);
    assert.equal(quote.refusals.length, 0);
    const res = await signAndSubmitZcAction(action, h.deps, quote.suggestedLimits);
    assert.equal(res.built.signers[0], ADDR_A);

    postedOrderBox = candidateToChainBox(res.built.unsignedTx, 0, hexId(0x10), hexId(0x50));
    const decoded = readZcBox(postedOrderBox) as ZcOrder;
    assert.ok(decoded && decoded.recordType === "order");
    assert.equal(decoded.script.kind, "PricedOrder");
    assert.equal(decoded.borrowerHash, HASH_A);
    assert.equal(decoded.guardHash, getZcExpressionHash("FillGuard", "ERG"));
    assert.equal(orderRefusal(decoded, BigInt(HEIGHT)), null);
  });

  // Action 2: createOffer (with Selective shares metadata)
  let postedOfferBox!: ChainBox;
  await test("5. [2/19] createOffer builds with Selective metadata & round-trips via readZcBox", async () => {
    const body = {
      market: "ERG",
      capital: (5n * ERG).toString(),
      minYieldBps: 700,
      floorBps: 15_000,
      curve: [{ blocks: 21_600, bps: 820 }],
      delivery: { kind: "selective", openingBps: 10_000, floorBps: 9_000 }
    };
    const action: ZcTxAction = { type: "createOffer", body };
    const quote = await quoteZcAction(action, h.deps);
    assert.equal(quote.refusals.length, 0);
    const built = await buildZcAction(action, h.deps, quote.suggestedLimits);
    assert.equal(built.signers[0], ADDR_A);

    postedOfferBox = candidateToChainBox(built.unsignedTx, 0, hexId(0x11), hexId(0x51));
    const decoded = readZcBox(postedOfferBox) as ZcOffer;
    assert.ok(decoded && decoded.recordType === "offer");
    assert.deepEqual(decoded.curve, [[820n, 21_600n]]);
    assert.equal(
      new TextDecoder().decode(decoded.metadata[1]),
      `{"zcs":1,"type":"selective shares","shares":100,"market":"ERG","via":"lend offer","auction":{"from":100,"to":90,"blocks":720,"expiry":2160,"threshold":100},"note":"Verify on chain."}`
    );
  });

  // Action 7: cancel (protocol input #0 -> null, auth input #1 -> ADDR_A)
  await test("6. [3/19] cancel maps IN(0) protocol=null and IN(1) auth=ADDR_A", async () => {
    h.registerRecord(postedOfferBox);
    const action: ZcTxAction = { type: "cancel", boxId: postedOfferBox.boxId };
    const quote = await quoteZcAction(action, h.deps);
    assert.equal(quote.refusals.length, 0);
    const built = await buildZcAction(action, h.deps);
    assert.equal(built.signers[0], null);
    assert.equal(built.signers[1], ADDR_A);
    assert.equal(built.unsignedTx.outputs.length, 2);
  });

  // Action 8: fillOrder (counterparty order -> mints bond unit + live bond)
  const CP_ORDER_ID = hexId(0x20);
  const CP_ORDER_TX = hexId(0x60);
  let liveBondBox!: ChainBox;
  let bondUnitId!: string;
  await test("7. [4/19] fillOrder maps protocol IN(0)=null, wallet IN(1)=ADDR_A, mints bond unit", async () => {
    const draft = buildDraftOrder(
      {
        market: "ERG",
        pricing: "fixed",
        principal: (2n * ERG).toString(),
        repayment: (22n * ERG / 10n).toString(),
        timing: { mode: "fixed", maturity: HEIGHT + 50_000, exact: true },
        collateral: {
          nanoErg: MIN_BOX.toString(),
          tokens: [{ tokenId: ZC_SIGUSD_TOKEN_ID, amount: "400" }]
        },
        rule: { kind: "oracle", ratioBps: 15_000 }
      },
      BigInt(HEIGHT)
    );
    const outDraft = buildOrderOutput(draft, HASH_CP, HEIGHT);
    const cpOrderBox = makeChainBox({
      id: CP_ORDER_ID,
      txId: CP_ORDER_TX,
      ergoTree: outDraft.ergoTree,
      value: outDraft.value,
      assets: outDraft.assets,
      additionalRegisters: outDraft.additionalRegisters as Record<string, string>
    });
    h.registerRecord(cpOrderBox, makeDisclosureTx(CP_ORDER_TX, TREE_CP));

    const action: ZcTxAction = { type: "fillOrder", boxId: CP_ORDER_ID };
    const quote = await quoteZcAction(action, h.deps);
    assert.equal(quote.refusals.length, 0);
    const built = await buildZcAction(action, h.deps, quote.suggestedLimits);

    assert.equal(built.signers[0], null);
    assert.equal(built.signers[1], ADDR_A);
    assert.equal(built.expectedMinted, CP_ORDER_ID);
    assert.equal(built.unsignedTx.dataInputs.length, 1); // oracle data input for FillGuard

    // Register minted bond as live & spend cpOrderBox so origin resolves!
    bondUnitId = CP_ORDER_ID;
    const fillTxId = hexId(0x61);
    h.registerSpentBox(cpOrderBox, fillTxId);
    liveBondBox = candidateToChainBox(built.unsignedTx, 1, hexId(0x21), fillTxId);
    h.registerRecord(liveBondBox, makeDisclosureTx(fillTxId, TREE_CP));
    // Give our wallet the 1 minted bond unit
    h.walletUtxos.push(
      makeChainBox({
        id: hexId(0x04),
        ergoTree: TREE_A,
        value: MIN_BOX,
        assets: [{ tokenId: bondUnitId, amount: 1n }]
      })
    );
    // Also check resolveWalletLendStep detects orders vs asks
    const cpOrder2 = makeChainBox({ ...cpOrderBox, id: hexId(0x2f) });
    h.registerRecord(cpOrder2);
    const resolvedStep = await resolveWalletLendStep(
      { boxId: hexId(0x2f), label: "step1", expectedCostRaw: 2n * ERG },
      h.deps
    );
    assert.equal(resolvedStep.type, "fillOrder");
  });

  // Action 3: createAsk (yield PricedAsk selling bondUnitId)
  let postedAskBox!: ChainBox;
  await test("8. [5/19] createAsk lists proven bond unit & round-trips via readZcBox", async () => {
    const body = {
      tokenId: bondUnitId,
      units: "1",
      pricing: {
        kind: "yield",
        startBps: 900,
        endBps: 1100,
        endHeight: HEIGHT + 5000,
        floor: "0"
      },
      saleGuard: { ratioBps: 15_000, oracleAge: 30 },
      minFill: "1",
      expiry: HEIGHT + 5040
    };
    const action: ZcTxAction = { type: "createAsk", body };
    const quote = await quoteZcAction(action, h.deps);
    assert.equal(quote.refusals.length, 0, `Unexpected refusal: ${quote.refusals.join("; ")}`);
    const built = await buildZcAction(action, h.deps, quote.suggestedLimits);
    assert.equal(built.signers[0], ADDR_A);

    postedAskBox = candidateToChainBox(built.unsignedTx, 0, hexId(0x22), hexId(0x62));
    const decoded = readZcBox(postedAskBox);
    assert.ok(decoded && decoded.recordType === "ask" && decoded.priced);
  });

  // Action 9: buyAsk
  await test("9. [6/19] buyAsk maps protocol IN(0)=null, wallet=ADDR_A, includes bond+oracle dataInputs", async () => {
    h.registerRecord(postedAskBox, makeDisclosureTx(hexId(0x62), TREE_A));
    const action: ZcTxAction = { type: "buyAsk", boxId: postedAskBox.boxId };
    const quote = await quoteZcAction(action, h.deps);
    assert.equal(quote.refusals.length, 0, `Unexpected refusal: ${quote.refusals.join("; ")}`);
    const built = await buildZcAction(action, h.deps, quote.suggestedLimits);
    assert.equal(built.signers[0], null);
    assert.equal(built.signers[1], ADDR_A);
    assert.equal(built.unsignedTx.dataInputs.length, 2); // live bond + oracle for GuardedYieldPricing
  });

  // Action 4 & 10: createLot + buyLot
  await test("10. [7-8/19] createLot and buyLot build & verify invariants", async () => {
    const lotBody = {
      market: "ERG",
      items: [{ tokenId: NFT_ID, amount: "1" }],
      opening: (5n * ERG).toString(),
      floor: (2n * ERG).toString(),
      start: HEIGHT,
      end: HEIGHT + 720,
      expiry: HEIGHT + 2160,
      refundFeeNanoErg: "2000000"
    };
    const createAct: ZcTxAction = { type: "createLot", body: lotBody };
    const q1 = await quoteZcAction(createAct, h.deps);
    assert.equal(q1.refusals.length, 0);
    const b1 = await buildZcAction(createAct, h.deps, q1.suggestedLimits);
    const lotBox = candidateToChainBox(b1.unsignedTx, 0, hexId(0x23), hexId(0x63));
    h.registerRecord(lotBox, makeDisclosureTx(hexId(0x63), TREE_A));

    const buyAct: ZcTxAction = { type: "buyLot", boxId: lotBox.boxId };
    const q2 = await quoteZcAction(buyAct, h.deps);
    assert.equal(q2.refusals.length, 0);
    const b2 = await buildZcAction(buyAct, h.deps, q2.suggestedLimits);
    assert.equal(b2.signers[0], null);
    assert.equal(b2.signers[1], ADDR_A);
  });

  // Action 5 & 16 (shares): fractionalize + mint (DutchAuctionMint)
  let shareReqBox!: ChainBox;
  let shareVaultBox!: ChainBox;
  let shareTokenId!: string;
  await test("11. [9-10/19] fractionalize and mint (Dutch shares) build & verify", async () => {
    const fracAct: ZcTxAction = {
      type: "fractionalize",
      assetId: bondUnitId,
      body: {
        vault: "dutch",
        openingBps: 20_000,
        floorBps: 9_000,
        length: 720,
        expiry: 2160
      }
    };
    const q1 = await quoteZcAction(fracAct, h.deps);
    assert.equal(q1.refusals.length, 0, `Refusal: ${q1.refusals.join("; ")}`);
    const b1 = await buildZcAction(fracAct, h.deps, q1.suggestedLimits);
    shareReqBox = candidateToChainBox(b1.unsignedTx, 0, hexId(0x24), hexId(0x64));
    h.registerRecord(shareReqBox, makeDisclosureTx(hexId(0x64), TREE_A));

    const mintAct: ZcTxAction = { type: "mint", boxId: shareReqBox.boxId };
    const q2 = await quoteZcAction(mintAct, h.deps);
    assert.equal(q2.refusals.length, 0, `Refusal: ${q2.refusals.join("; ")}`);
    const b2 = await buildZcAction(mintAct, h.deps, q2.suggestedLimits);
    assert.equal(b2.signers[0], null);
    assert.equal(b2.expectedMinted, shareReqBox.boxId);
    assert.equal(b2.unsignedTx.dataInputs.length, 1); // live bond data input

    shareTokenId = shareReqBox.boxId;
    const mintTxId = hexId(0x65);
    h.registerSpentBox(shareReqBox, mintTxId);
    shareVaultBox = candidateToChainBox(b2.unsignedTx, 1, hexId(0x25), mintTxId);
    h.registerRecord(shareVaultBox);
    h.walletUtxos.push(
      makeChainBox({
        id: hexId(0x05),
        ergoTree: TREE_A,
        value: MIN_BOX,
        assets: [{ tokenId: shareTokenId, amount: 100_000_000n }]
      })
    );
  });

  // Action 6, 16 (wrap, alone=true), 19 (unwrap)
  await test("12. [11-12/19] createWrap, mint (WrapMint alone=true), and unwrap build & verify", async () => {
    const wrapAct: ZcTxAction = { type: "createWrap", body: { tokenId: NFT_ID } };
    const q1 = await quoteZcAction(wrapAct, h.deps);
    assert.equal(q1.refusals.length, 0);
    const b1 = await buildZcAction(wrapAct, h.deps, q1.suggestedLimits);
    const wrapReqBox = candidateToChainBox(b1.unsignedTx, 0, hexId(0x26), hexId(0x66));
    h.registerRecord(wrapReqBox, makeDisclosureTx(hexId(0x66), TREE_A));

    // Mint wrap MUST be alone (1 single input, signer[0] === null)
    const mintWrapAct: ZcTxAction = { type: "mint", boxId: wrapReqBox.boxId };
    const q2 = await quoteZcAction(mintWrapAct, h.deps);
    assert.equal(q2.refusals.length, 0);
    const b2 = await buildZcAction(mintWrapAct, h.deps, q2.suggestedLimits);
    assert.equal(b2.unsignedTx.inputs.length, 1, "WrapMint MUST have exactly 1 input (alone=true)");
    assert.equal(b2.signers[0], null);
    assert.equal(b2.expectedMinted, wrapReqBox.boxId);

    const wrapTxId = hexId(0x67);
    h.registerSpentBox(wrapReqBox, wrapTxId);
    const wrapVaultBox = candidateToChainBox(b2.unsignedTx, 1, hexId(0x27), wrapTxId);
    h.registerRecord(wrapVaultBox);
    h.walletUtxos.push(
      makeChainBox({
        id: hexId(0x06),
        ergoTree: TREE_A,
        value: MIN_BOX,
        assets: [{ tokenId: wrapReqBox.boxId, amount: 1n }]
      })
    );

    const unwrapAct: ZcTxAction = { type: "unwrap", receiptId: wrapReqBox.boxId };
    const q3 = await quoteZcAction(unwrapAct, h.deps);
    assert.equal(q3.refusals.length, 0, `Refusal: ${q3.refusals.join("; ")}`);
    const b3 = await buildZcAction(unwrapAct, h.deps, q3.suggestedLimits);
    assert.equal(b3.signers[0], null);
    assert.equal(b3.signers[1], ADDR_A);
    assert.deepEqual(b3.expectedBurn, [{ tokenId: wrapReqBox.boxId, amount: 3n }]);
  });

  // Actions 11, 12, 13, 14: repay (incl. fromCollateral), extinguish, recollateralize, liquidate
  // Create a borrower-owned live bond (borrowerHash = HASH_A)
  const OWN_BOND_ASSET = hexId(0x30);
  let ownBondBox!: ChainBox;
  await test("13. [13-16/19] repay (regular + fromCollateral), recollateralize, extinguish, liquidate", async () => {
    const draft = buildDraftOrder(
      {
        market: "ERG",
        pricing: "fixed",
        principal: (2n * ERG).toString(),
        repayment: (22n * ERG / 10n).toString(),
        timing: { mode: "fixed", maturity: HEIGHT + 10_000, exact: true },
        collateral: {
          nanoErg: (3n * ERG).toString(),
          tokens: [{ tokenId: ZC_SIGUSD_TOKEN_ID, amount: "100" }]
        },
        rule: { kind: "oracle", ratioBps: 15_000 }
      },
      BigInt(HEIGHT - 100)
    );
    const outDraft = buildOrderOutput(draft, HASH_A, HEIGHT - 100);
    const ordBox = makeChainBox({
      id: OWN_BOND_ASSET,
      txId: hexId(0x70),
      ergoTree: outDraft.ergoTree,
      value: outDraft.value,
      assets: outDraft.assets,
      additionalRegisters: outDraft.additionalRegisters as Record<string, string>,
      creationHeight: HEIGHT - 100
    });
    const ordRec = readZcBox(ordBox) as ZcOrder;
    const fillSpend = buildFillOrderSpend({
      order: ordRec,
      orderBox: ordBox,
      borrowerTree: TREE_A,
      lenderTree: TREE_A,
      start: BigInt(HEIGHT - 100),
      maturity: BigInt(HEIGHT + 10_000),
      feeReserve: 50_000_000n,
      oracleBox: null
    });
    const bondDraft = fillSpend.outputs[1];
    ownBondBox = makeChainBox({
      id: hexId(0x31),
      txId: hexId(0x71),
      ergoTree: bondDraft.ergoTree,
      value: bondDraft.value,
      assets: bondDraft.assets,
      additionalRegisters: bondDraft.additionalRegisters as Record<string, string>,
      creationHeight: HEIGHT - 100
    });
    h.registerSpentBox(ordBox, hexId(0x71));
    h.registerRecord(ownBondBox);
    h.walletUtxos.push(
      makeChainBox({
        id: hexId(0x07),
        ergoTree: TREE_A,
        value: MIN_BOX,
        assets: [{ tokenId: OWN_BOND_ASSET, amount: 1n }]
      })
    );

    // 13a. Repay (from wallet)
    const repayAct: ZcTxAction = { type: "repay", assetId: OWN_BOND_ASSET };
    const qr1 = await quoteZcAction(repayAct, h.deps);
    assert.equal(qr1.refusals.length, 0);
    const br1 = await buildZcAction(repayAct, h.deps, qr1.suggestedLimits);
    assert.equal(br1.signers[0], null);
    assert.equal(br1.signers[1], ADDR_A);

    // 13b. Repay (fromCollateral = "max" -> uses auth box at IN(1))
    const repayColAct: ZcTxAction = {
      type: "repay",
      assetId: OWN_BOND_ASSET,
      fromCollateral: "max"
    };
    const qr2 = await quoteZcAction(repayColAct, h.deps);
    assert.equal(qr2.refusals.length, 0);
    const br2 = await buildZcAction(repayColAct, h.deps, qr2.suggestedLimits);
    assert.equal(br2.signers[0], null);
    assert.equal(br2.signers[1], ADDR_A);
    assert.equal(br2.signerAudit[1].role, "auth");

    // 13c. Recollateralize (add 1 ERG)
    const recollAct: ZcTxAction = {
      type: "recollateralize",
      assetId: OWN_BOND_ASSET,
      nanoErg: 1n * ERG
    };
    const qrc = await quoteZcAction(recollAct, h.deps);
    assert.equal(qrc.refusals.length, 0);
    const brc = await buildZcAction(recollAct, h.deps, qrc.suggestedLimits);
    assert.equal(brc.signers[0], null);
    assert.equal(brc.signerAudit[1].role, "auth");

    // 13d. Extinguish (burns 3 units: 2 in bond + 1 in wallet)
    const extAct: ZcTxAction = { type: "extinguish", assetId: OWN_BOND_ASSET };
    const qe = await quoteZcAction(extAct, h.deps);
    assert.equal(qe.refusals.length, 0);
    const be = await buildZcAction(extAct, h.deps, qe.suggestedLimits);
    assert.equal(be.signers[0], null);
    assert.equal(be.signerAudit[1].role, "auth");
    assert.deepEqual(be.expectedBurn, [{ tokenId: OWN_BOND_ASSET, amount: 3n }]);

    // 13e. Liquidate (after maturity — self-funded from feeReserve!)
    h.height = HEIGHT + 10_005;
    const liqAct: ZcTxAction = { type: "liquidate", assetId: OWN_BOND_ASSET };
    const ql = await quoteZcAction(liqAct, h.deps);
    assert.equal(ql.refusals.length, 0);
    const bl = await buildZcAction(liqAct, h.deps, ql.suggestedLimits);
    assert.equal(bl.unsignedTx.inputs.length, 1, "Self-funded liquidation needs only bond box");
    assert.equal(bl.signers[0], null);
    h.height = HEIGHT; // restore height
  });

  // Actions 15 (claim unit & claim shares), 17 (pull), 18 (buyVault)
  await test("14. [17-19/19] pull, buyVault, claim (shares partial + final), and claim (bond unit)", async () => {
    // Liquidate liveBondBox (cp bond) by setting oracle price so SigUSD collateral drops under 150%
    // liveBondBox has 400 SigUSD ($4) against 2.2 ERG repayment. If 1 USD = 0.25 ERG ($4/ERG),
    // 400 SigUSD = 1 ERG < 2.2 * 1.5 = 3.3 ERG -> liquidatable!
    h.oraclePrice = 250_000_000n; // $4 / ERG
    const liqCpAct: ZcTxAction = { type: "liquidate", assetId: bondUnitId };
    const qLiq = await quoteZcAction(liqCpAct, h.deps);
    assert.equal(qLiq.refusals.length, 0, `Refusal: ${qLiq.refusals.join("; ")}`);
    const bLiq = await buildZcAction(liqCpAct, h.deps, qLiq.suggestedLimits);
    assert.equal(bLiq.unsignedTx.dataInputs.length, 1); // oracle data input

    // Transition liveBondBox -> confirmed settlement box
    h.registerSpentBox(liveBondBox, hexId(0x80));
    const settlementBox = candidateToChainBox(bLiq.unsignedTx, 0, hexId(0x32), hexId(0x80));
    h.registerRecord(settlementBox);

    // 14a. Claim bond unit directly (burns 3 units: 2 in settlement + 1 in wallet)
    const claimUnitAct: ZcTxAction = { type: "claim", tokenId: bondUnitId };
    const qcu = await quoteZcAction(claimUnitAct, h.deps);
    assert.equal(qcu.refusals.length, 0, `Refusal: ${qcu.refusals.join("; ")}`);
    const bcu = await buildZcAction(claimUnitAct, h.deps, qcu.suggestedLimits);
    assert.equal(bcu.signers[0], null);
    assert.equal(bcu.signers[1], ADDR_A);
    assert.deepEqual(bcu.expectedBurn, [{ tokenId: bondUnitId, amount: 3n }]);

    // 14b. Pull settlement into shareVaultBox (triggers Dutch auction state 1!)
    const pullAct: ZcTxAction = { type: "pull", boxId: shareVaultBox.boxId };
    const qp = await quoteZcAction(pullAct, h.deps);
    assert.equal(qp.refusals.length, 0, `Refusal: ${qp.refusals.join("; ")}`);
    const bp = await buildZcAction(pullAct, h.deps, qp.suggestedLimits);
    assert.equal(bp.signers[0], null); // shareVault
    assert.equal(bp.signers[1], null); // settlement
    assert.deepEqual(bp.expectedBurn, [{ tokenId: bondUnitId, amount: 3n }]);

    // Advance shareVaultBox to pulled vault with open auction (state 1 or 4)
    h.registerSpentBox(shareVaultBox, hexId(0x81));
    h.registerSpentBox(settlementBox, hexId(0x81));
    const pulledVaultBox = candidateToChainBox(bp.unsignedTx, 0, hexId(0x33), hexId(0x81));
    h.registerRecord(pulledVaultBox);

    // While auction is open, partial share claim MUST be refused with requires=["auction"]
    const partialBlocked = await quoteZcAction(
      { type: "claim", tokenId: shareTokenId, units: 50_000_000n },
      h.deps
    );
    assert.ok(partialBlocked.refusals.length > 0);
    assert.deepEqual(partialBlocked.requires, ["auction"]);

    // 14c. buyVault on the open auction
    const bvAct: ZcTxAction = { type: "buyVault", boxId: pulledVaultBox.boxId };
    const qbv = await quoteZcAction(bvAct, h.deps);
    assert.equal(qbv.refusals.length, 0, `Refusal: ${qbv.refusals.join("; ")}`);
    const bbv = await buildZcAction(bvAct, h.deps, qbv.suggestedLimits);
    assert.equal(bbv.signers[0], null);
    assert.equal(bbv.signers[1], ADDR_A);

    // Advance pulledVaultBox -> post-auction vault (state 2, claimable!)
    h.registerSpentBox(pulledVaultBox, hexId(0x82));
    const soldVaultBox = candidateToChainBox(bbv.unsignedTx, 0, hexId(0x34), hexId(0x82));
    h.registerRecord(soldVaultBox);

    // 14d. Partial share claim (burns 50M shares)
    const partialAct: ZcTxAction = {
      type: "claim",
      tokenId: shareTokenId,
      units: 50_000_000n
    };
    const qcs1 = await quoteZcAction(partialAct, h.deps);
    assert.equal(qcs1.refusals.length, 0, `Refusal: ${qcs1.refusals.join("; ")}`);
    const bcs1 = await buildZcAction(partialAct, h.deps, qcs1.suggestedLimits);
    assert.equal(bcs1.signers[0], null);
    assert.equal(bcs1.signers[1], ADDR_A);
    assert.deepEqual(bcs1.expectedBurn, [{ tokenId: shareTokenId, amount: 50_000_000n }]);

    // 14e. Final share claim (burns all outstanding + reserve + 1)
    const finalAct: ZcTxAction = {
      type: "claim",
      tokenId: shareTokenId,
      units: 100_000_000n
    };
    const qcs2 = await quoteZcAction(finalAct, h.deps);
    assert.equal(qcs2.refusals.length, 0, `Refusal: ${qcs2.refusals.join("; ")}`);
    const bcs2 = await buildZcAction(finalAct, h.deps, qcs2.suggestedLimits);
    assert.deepEqual(bcs2.expectedBurn, [{ tokenId: shareTokenId, amount: 200_000_001n }]);
    h.oraclePrice = 1_000_000_000n;
  });

  // 15. Negative Security Invariant Tests
  await test("15. Security gate `assertTxInvariants` blocks every tampering & drift vector", async () => {
    const walletBook = indexWalletAddresses(
      { changeAddress: ADDR_A, usedAddresses: [ADDR_A], unusedAddresses: [] },
      Network.Mainnet
    );
    const built = await buildZcAction(
      { type: "createWrap", body: { tokenId: NFT_ID } },
      h.deps
    );
    const baseExp = {
      unsignedTx: built.unsignedTx,
      signers: built.signers,
      protocolIndices: new Set<number>(),
      walletOutputIndices: new Set<number>([1]),
      walletBook,
      expectedMinted: null,
      expectedBurn: [],
      market: null
    };

    // Baseline passes
    assertTxInvariants(baseExp);

    // (a) ERG conservation violation
    assert.throws(
      () =>
        assertTxInvariants({
          ...baseExp,
          unsignedTx: {
            ...built.unsignedTx,
            outputs: built.unsignedTx.outputs.map((o, i) =>
              i === 0 ? { ...o, value: (BigInt(o.value) + 1n).toString() } : o
            )
          }
        }),
      ZcTxInvariantError
    );

    // (b) Unintended token burn
    assert.throws(
      () =>
        assertTxInvariants({
          ...baseExp,
          unsignedTx: {
            ...built.unsignedTx,
            outputs: built.unsignedTx.outputs.map((o, i) => (i === 0 ? { ...o, assets: [] } : o))
          }
        }),
      ZcTxInvariantError
    );

    // (c) Unverified change destination (attacker ErgoTree)
    assert.throws(
      () =>
        assertTxInvariants({
          ...baseExp,
          unsignedTx: {
            ...built.unsignedTx,
            outputs: built.unsignedTx.outputs.map((o, i) =>
              i === 1 ? { ...o, ergoTree: TREE_CP } : o
            )
          }
        }),
      ZcTxInvariantError
    );

    // (d) Wrong Nautilus v3 signer address
    assert.throws(
      () =>
        assertTxInvariants({
          ...baseExp,
          signers: { ...built.signers, 0: ADDR_CP }
        }),
      ZcTxInvariantError
    );

    // (e) Protocol input accidentally assigned a wallet signer instead of null
    assert.throws(
      () =>
        assertTxInvariants({
          ...baseExp,
          protocolIndices: new Set([0]),
          signers: { ...built.signers, 0: ADDR_A }
        }),
      ZcTxInvariantError
    );

    // (f) Excessive miner fee
    assert.throws(
      () =>
        assertTxInvariants({
          ...baseExp,
          unsignedTx: {
            ...built.unsignedTx,
            outputs: built.unsignedTx.outputs.map((o, i) =>
              i === built.unsignedTx.outputs.length - 1
                ? { ...o, value: (TX_FEE + MIN_BOX).toString() }
                : i === 1
                  ? { ...o, value: (BigInt(o.value) - MIN_BOX).toString() }
                  : o
            )
          }
        }),
      ZcTxInvariantError
    );

    // (g) Slippage / limits drift throws ZcTxConflictError
    assert.throws(
      () =>
        assertTxInvariants({
          ...baseExp,
          limits: { maxPay: 1_000_000n }
        }),
      ZcTxConflictError
    );
  });

  // 16. FS-2: Pinned WrapMint contract & blake2b256 verification of all 22 ZC_SCRIPTS
  await test("16. [FS-2] WrapMint pinned to adce8ac (466 B) and all 22 ZC_SCRIPTS match their treeHash", () => {
    assert.equal(ZC_PINNED_COMMIT, "adce8ac");
    const wrapMint = getZcScript("WrapMint", null);
    assert.equal(wrapMint.ergoTreeHex.length / 2, 466, "WrapMint ErgoTree must be 466 bytes");
    assert.equal(
      wrapMint.treeHash,
      "95dd499a9ea4c10c14ce474a5ee916f60236b1eec379ae04f170d22b2a651a47"
    );
    assert.equal(
      wrapMint.templateHash,
      "9972a876f976da80074b4e0d81fc4cc1b731df11ca5f0128f8d072883b48dcba"
    );
    assert.equal(ZC_SCRIPTS.length, 22);
    for (const s of ZC_SCRIPTS) {
      const actual = hex.encode(blake2b256(hex.decode(s.ergoTreeHex)));
      assert.equal(actual, s.treeHash, `Tree hash mismatch for ${s.label}`);
    }
  });

  // 17. FS-5 & FS-3: Partial claimShares minBoxValue floor + trailing spam register stripping
  await test("17. [FS-5 & FS-3] Partial claimShares tops up low-ERG vault & strips trailing spam registers", () => {
    const shareId = hexId(0x91);
    const bondId = hexId(0x92);
    const spamReg = encodeUtf8("spam-register-payload");

    // Low-ERG SigUSD DutchAuctionVault (state 2 = claimable) holding 2_000_000 nanoERG + 1000 SigUSD
    // plus an injected trailing spam register R9.
    const dutchVaultBox = makeChainBox({
      id: hexId(0x93),
      ergoTree: getZcScript("DutchAuctionVault", null).ergoTreeHex,
      value: 2_000_000n,
      assets: [
        { tokenId: shareId, amount: 100_000_001n },
        { tokenId: ZC_SIGUSD_TOKEN_ID, amount: 1_000n }
      ],
      additionalRegisters: registersFromList([
        encodeHexBytes(bondId),
        encodeLongs([100_000_000n, 100_000_000n, 5_000_000n]),
        encodeByte(2),
        encodeLongs([1_000n, 20_000n, 9_000n, 720n, 2160n, LONG_MAX, BigInt(HEIGHT - 5000)]),
        encodeHexBytes(ZC_SIGUSD_TOKEN_ID),
        spamReg // R9 spam register
      ])
    });
    const vaultRec = readZcBox(dutchVaultBox) as ZcShareVault;
    assert.ok(vaultRec && vaultRec.recordType === "shareVault" && vaultRec.dutch);

    // Claiming 75% leaves raw 500_000 nanoERG < MIN_BOX; FS-5 floors continuation at >= minBoxValue
    const partialSpend = buildClaimSharesSpend({
      vault: vaultRec,
      vaultBox: dutchVaultBox,
      burned: 75_000_000n,
      toTree: TREE_A
    });
    const contOut = partialSpend.outputs[1];
    assert.ok(
      contOut.value >= minBoxValue(contOut),
      `Continuation vault value ${contOut.value} must be >= minBoxValue ${minBoxValue(contOut)}`
    );
    assert.ok(contOut.value >= MIN_BOX, "Continuation vault value must be >= MIN_BOX");
    // FS-3: R9 spam register must be stripped
    assert.equal(contOut.additionalRegisters.R9, undefined, "Trailing R9 spam must be stripped on claimShares");
    assert.ok(contOut.additionalRegisters.R8, "Protocol R8 currency register must be preserved");

    // FS-3 on buildBuyFromVaultSpend: open Dutch auction (state 1) with spam R9
    const openAuctionBox = makeChainBox({
      id: hexId(0x94),
      ergoTree: getZcScript("DutchAuctionVault", null).ergoTreeHex,
      value: 2_000_000n,
      assets: [
        { tokenId: shareId, amount: 100_000_001n },
        { tokenId: NFT_ID, amount: 1n }
      ],
      additionalRegisters: registersFromList([
        encodeHexBytes(bondId),
        encodeLongs([100_000_000n, 100_000_000n, 5_000_000n]),
        encodeByte(1),
        encodeLongs([1_000n, 20_000n, 9_000n, 720n, 2160n, LONG_MAX, BigInt(HEIGHT - 10)]),
        encodeHexBytes(ZC_SIGUSD_TOKEN_ID),
        spamReg
      ])
    });
    const openVaultRec = readZcBox(openAuctionBox) as ZcShareVault;
    const buySpend = buildBuyFromVaultSpend({
      vault: openVaultRec,
      vaultBox: openAuctionBox,
      height: BigInt(HEIGHT)
    });
    assert.equal(
      buySpend.outputs[0].additionalRegisters.R9,
      undefined,
      "Trailing R9 spam must be stripped on buyFromVault"
    );
    assert.ok(buySpend.outputs[0].value >= minBoxValue(buySpend.outputs[0]));
  });

  // 18. FS-4: Dynamic 360 nanoERG/byte minBoxValue, 4096 B cap, 30-token cap, 4 KB offer check
  await test("18. [FS-4] Dynamic minBoxValue (360 nanoERG/B), 4096 B max size, 30-token cap, & 4 KB offer check", async () => {
    const walletBook = indexWalletAddresses(
      { changeAddress: ADDR_A, usedAddresses: [ADDR_A], unusedAddresses: [] },
      Network.Mainnet
    );

    // Build an output > 2,777 B (30 tokens inside a DutchAuctionVault = ~3,500 B -> needs > 1.25M nanoERG)
    const manyTokens: ChainAsset[] = Array.from({ length: 30 }, (_, i) => ({
      tokenId: hexId(0xa0 + i),
      amount: 10n
    }));
    const bigBox = {
      ergoTree: getZcScript("DutchAuctionVault", null).ergoTreeHex,
      creationHeight: HEIGHT,
      value: MIN_BOX.toString(),
      assets: manyTokens.map((t) => ({ tokenId: t.tokenId, amount: t.amount.toString() })),
      additionalRegisters: {}
    };
    const sz = boxCandidateSize(bigBox, 0);
    assert.ok(sz > 2777 && sz <= MAX_BOX_SIZE, `Expected 2777 < size (${sz}) <= 4096`);
    const reqMin = minBoxValue(bigBox, 0);
    assert.ok(reqMin > MIN_BOX, `Expected dynamic minBoxValue (${reqMin}) > MIN_BOX`);

    const feeBox = {
      ergoTree: getZcScript("BondVault", null).ergoTreeHex, // dummy replaced below
      creationHeight: HEIGHT,
      value: TX_FEE.toString(),
      assets: [],
      additionalRegisters: {}
    };
    const dummyInput = {
      boxId: hexId(0xd1),
      transactionId: hexId(0xd2),
      index: 0,
      ergoTree: TREE_A,
      creationHeight: HEIGHT - 10,
      value: (MIN_BOX + TX_FEE).toString(),
      assets: manyTokens.map((t) => ({ tokenId: t.tokenId, amount: t.amount.toString() })),
      additionalRegisters: {},
      extension: {}
    };
    // assertTxInvariants MUST reject MIN_BOX on a >2777 B output
    assert.throws(
      () =>
        assertTxInvariants({
          unsignedTx: {
            inputs: [dummyInput],
            dataInputs: [],
            outputs: [bigBox, feeBox]
          },
          signers: { 0: ADDR_A },
          protocolIndices: new Set(),
          walletOutputIndices: new Set(),
          walletBook,
          expectedMinted: null,
          expectedBurn: [],
          market: null
        }),
      ZcTxInvariantError
    );

    // 31 distinct collateral tokens MUST be refused by buildDraftOrder & createOrder
    const tooManyTokens = Array.from({ length: MAX_COLLATERAL_TOKENS + 1 }, (_, i) => ({
      tokenId: hexId(0x40 + i),
      amount: "1"
    }));
    const q31 = await quoteZcAction(
      {
        type: "createOrder",
        body: {
          market: "ERG",
          pricing: "fixed",
          principal: (1n * ERG).toString(),
          repayment: (11n * ERG / 10n).toString(),
          timing: { mode: "fixed", maturity: HEIGHT + 50_000, exact: true },
          collateral: { nanoErg: (2n * ERG).toString(), tokens: tooManyTokens },
          rule: { kind: "oracle", ratioBps: 15_000 }
        }
      },
      h.deps
    );
    assert.ok(q31.refusals.length > 0, "Expected 31-token order to be refused");

    // 31-token bond MUST also be refused by offerRefusal when offer delivers shares
    const offerDraft = buildDraftOffer(
      {
        market: "ERG",
        capital: (5n * ERG).toString(),
        minYieldBps: 500,
        floorBps: 12_000,
        delivery: { kind: "selective", openingBps: 10_000, floorBps: 9_000 }
      },
      BigInt(HEIGHT)
    );
    const fakeOracle: ZcOracle = {
      box: makeChainBox({
        id: hexId(0x99),
        ergoTree: ZC_ORACLE_V2_ERGO_TREE,
        value: 10_000_000n,
        creationHeight: HEIGHT - 5
      }),
      price: 1_000_000_000n,
      epoch: 100
    };
    const bigBondRefusal = offerRefusal(
      offerStateOf(offerDraft),
      {
        market: "ERG",
        repayment: 11n * ERG / 10n,
        principalErg: 1n * ERG,
        payload: [15_000n, 60n],
        liqHash: getZcExpressionHash("OracleLiquidation", "ERG"),
        collateralErg: 3n * ERG,
        collateral: Array.from({ length: MAX_COLLATERAL_TOKENS + 1 }, (_, i) => ({
          tokenId: hexId(0x40 + i),
          amount: 1n
        })),
        start: BigInt(HEIGHT),
        maturity: BigInt(HEIGHT + 50_000)
      },
      1n * ERG,
      1n,
      1n,
      fakeOracle,
      BigInt(HEIGHT),
      { primary: true }
    );
    assert.ok(
      bigBondRefusal && bigBondRefusal.includes("30"),
      `Expected 30-token offerRefusal, got: ${String(bigBondRefusal)}`
    );
  });

  // 19. I-8: Exact-ERG posting & exact-ERG recollateralize both emit var 64 disclosure
  await test("19. [I-8] Exact-ERG posting & exact-ERG recollateralize attach var 64 on INPUTS(0)", async () => {
    const exactH = createHarness();
    // Exact UTXO matching wrap box (37_000_000) + TX_FEE (1_000_000) = 38_000_000 nanoERG (zero change output!)
    exactH.walletUtxos.push(
      makeChainBox({
        id: hexId(0xe1),
        ergoTree: TREE_A,
        value: 38_000_000n,
        assets: [{ tokenId: NFT_ID, amount: 1n }]
      })
    );
    const wrapBuilt = await buildZcAction(
      { type: "createWrap", body: { tokenId: NFT_ID } },
      exactH.deps
    );
    assert.equal(wrapBuilt.unsignedTx.outputs.length, 2, "Exact-ERG post should have no change output");
    assert.ok(
      wrapBuilt.unsignedTx.inputs[0].extension[64],
      "Exact-ERG post MUST attach var 64 disclosure on INPUTS(0)"
    );
    assert.deepEqual(disclosedTrees(wrapBuilt.unsignedTx.inputs[0].extension[64]!), [TREE_A]);

    // Exact-ERG recollateralize: auth box holds exact 1 ERG + TX_FEE (no change output)
    exactH.registerRecord(ownBondBox);
    exactH.walletUtxos.length = 0;
    exactH.walletUtxos.push(
      makeChainBox({
        id: hexId(0xe2),
        ergoTree: TREE_A,
        value: 1n * ERG + TX_FEE
      })
    );
    const recollBuilt = await buildZcAction(
      { type: "recollateralize", assetId: OWN_BOND_ASSET, nanoErg: 1n * ERG },
      exactH.deps
    );
    assert.equal(recollBuilt.unsignedTx.outputs.length, 2, "Exact-ERG recollateralize has bond + fee only");
    assert.ok(
      recollBuilt.unsignedTx.inputs[0].extension[3],
      "Bond input extension[3] must remain intact"
    );
    assert.ok(
      recollBuilt.unsignedTx.inputs[0].extension[64],
      "Exact-ERG recollateralize MUST attach var 64 disclosure on INPUTS(0)"
    );
    assert.deepEqual(disclosedTrees(recollBuilt.unsignedTx.inputs[0].extension[64]!), [TREE_A]);
  });

  // 20. SF-1: Raw LithosDex provision NFT blocked in createLot & createOrder
  await test("20. [SF-1] Raw LithosDex provision / capability NFT refused in createLot & createOrder", async () => {
    const PROV_NFT = hexId(0x79);
    h.tokens.set(PROV_NFT, {
      tokenId: PROV_NFT,
      name: "LithosDex Provision LD-NFT",
      description: "LP capability token",
      decimals: 0,
      emissionAmount: "1"
    });
    h.walletUtxos.push(
      makeChainBox({
        id: hexId(0x09),
        ergoTree: TREE_A,
        value: MIN_BOX,
        assets: [{ tokenId: PROV_NFT, amount: 1n }]
      })
    );
    const lotQ = await quoteZcAction(
      {
        type: "createLot",
        body: {
          market: "ERG",
          items: [{ tokenId: PROV_NFT, amount: "1" }],
          opening: (5n * ERG).toString(),
          floor: (2n * ERG).toString(),
          start: HEIGHT,
          end: HEIGHT + 720,
          expiry: HEIGHT + 2160
        }
      },
      h.deps
    );
    assert.ok(lotQ.refusals.length > 0, "Raw provision NFT must be refused in createLot");
    assert.deepEqual(lotQ.requires, ["wrap"]);

    const ordQ = await quoteZcAction(
      {
        type: "createOrder",
        body: {
          market: "ERG",
          pricing: "fixed",
          principal: (1n * ERG).toString(),
          repayment: (11n * ERG / 10n).toString(),
          timing: { mode: "fixed", maturity: HEIGHT + 50_000, exact: true },
          collateral: {
            nanoErg: (3n * ERG).toString(),
            tokens: [{ tokenId: PROV_NFT, amount: "1" }]
          },
          rule: { kind: "oracle", ratioBps: 15_000 }
        }
      },
      h.deps
    );
    assert.ok(ordQ.refusals.length > 0, "Raw provision NFT must be refused in createOrder");
    assert.deepEqual(ordQ.requires, ["wrap"]);
  });

  // 21. Engine audit parity: I-1, I-4, I-5, I-6, I-7, R-1, R-4, I-10, FS-1, I-3, FS-7
  await test("21. [I-1/I-4/I-5/I-6/I-7/R-1/R-4/I-10/FS-1/I-3/FS-7] Mirrored ZC engine audit parity", async () => {
    const fakeOracle: ZcOracle = {
      box: makeChainBox({
        id: hexId(0x99),
        ergoTree: ZC_ORACLE_V2_ERGO_TREE,
        value: 10_000_000n,
        creationHeight: HEIGHT - 5
      }),
      price: 1_000_000_000n,
      epoch: 100
    };

    // I-1: ERG offer that covers price (1 ERG) but cannot cover price + batcherFee + delivery + reserve + continuation
    const tightOffer = buildDraftOffer(
      {
        market: "ERG",
        capital: (1_020_000_000n).toString(), // 1.02 ERG — cannot pay 1 ERG + 0.005 fee + 0.001 del + 0.05 reserve + >0.001 cont
        minYieldBps: 100,
        floorBps: 12_000
      },
      BigInt(HEIGHT)
    );
    const bondTerms = {
      market: "ERG" as const,
      repayment: 12n * ERG / 10n,
      principalErg: 1n * ERG,
      payload: [15_000n, 60n],
      liqHash: getZcExpressionHash("OracleLiquidation", "ERG"),
      collateralErg: 3n * ERG,
      collateral: [],
      start: BigInt(HEIGHT),
      maturity: BigInt(HEIGHT + 50_000)
    };
    const i1Ref = offerRefusal(
      offerStateOf(tightOffer),
      bondTerms,
      1n * ERG,
      1n,
      1n,
      fakeOracle,
      BigInt(HEIGHT),
      { primary: true }
    );
    assert.ok(i1Ref && i1Ref.includes("continuation"), `Expected I-1 refusal, got: ${String(i1Ref)}`);

    // I-1 secondary ask: ERG secondary ask with price=1 ERG on 1.005 ERG offer must also be refused
    const tightSecOffer = buildDraftOffer(
      {
        market: "ERG",
        capital: (1_006_000_000n).toString(),
        minYieldBps: 100,
        floorBps: 12_000
      },
      BigInt(HEIGHT)
    );
    const i1SecRef = offerRefusal(
      offerStateOf(tightSecOffer),
      bondTerms,
      1n * ERG,
      1n,
      1n,
      fakeOracle,
      BigInt(HEIGHT),
      { primary: false }
    );
    assert.ok(i1SecRef && i1SecRef.includes("continuation"), `Expected I-1 secondary refusal, got: ${String(i1SecRef)}`);

    // I-4: belowOwnRatio uses OracleLiquidation's market, not bond.market
    // SigUSD bond with ERG collateral (2 ERG) and SigUSD repayment (100 = $1) carrying ERG OracleLiquidation hash:
    // At price = 2e9 nanoERG/USD ($0.50/ERG), ERG-denominated cover treats repayment as 100 nanoERG (huge) while
    // SigUSD-denominated cover treats collateral as 2 ERG = $1 (100% < 150%).
    const crossRuleBond = {
      market: "SigUSD" as const,
      repayment: 100n,
      principalErg: 0n,
      payload: [15_000n, 60n],
      liqHash: getZcExpressionHash("OracleLiquidation", "ERG"),
      collateralErg: 2n * ERG,
      collateral: [],
      start: BigInt(HEIGHT),
      maturity: BigInt(HEIGHT + 50_000)
    };
    assert.equal(
      belowOwnRatio(crossRuleBond, 2_000_000_000n),
      false,
      "I-4: ERG oracle rule must measure cover in ERG market, not SigUSD market"
    );

    // I-5: orderRefusal checks chosen maturity for window orders
    const winOrder = buildDraftOrder(
      {
        market: "ERG",
        pricing: "window",
        principal: (1n * ERG).toString(),
        repayment: (12n * ERG / 10n).toString(),
        timing: { mode: "window", minDuration: 1000, maxDuration: 50_000 },
        curve: { capBps: 1500, points: [{ blocks: 10_000, bps: 900 }] },
        collateral: { nanoErg: (3n * ERG).toString() },
        rule: { kind: "oracle", ratioBps: 15_000 }
      },
      BigInt(HEIGHT)
    );
    assert.equal(orderRefusal(winOrder, BigInt(HEIGHT), BigInt(HEIGHT + 5000)), null);
    assert.ok(
      orderRefusal(winOrder, BigInt(HEIGHT), BigInt(HEIGHT + 500)) !== null,
      "I-5: out-of-window chosen maturity must be refused by orderRefusal"
    );

    // I-6: 3-block inclusion slack refuses bond at exactly minBlocks from height+1
    const slackOffer = buildDraftOffer(
      {
        market: "ERG",
        capital: (5n * ERG).toString(),
        minYieldBps: 100,
        floorBps: 12_000,
        minBlocks: 1000
      },
      BigInt(HEIGHT)
    );
    const tightMatBond = { ...bondTerms, maturity: BigInt(HEIGHT + 1 + 1000) };
    const i6Ref = offerRefusal(
      offerStateOf(slackOffer),
      tightMatBond,
      1n * ERG,
      1n,
      1n,
      fakeOracle,
      BigInt(HEIGHT),
      { primary: true }
    );
    assert.ok(i6Ref && i6Ref.includes("outside"), `Expected I-6 slack refusal, got: ${String(i6Ref)}`);

    // R-1: lotTarget returns null on 64-bit overflow
    const overflowVault = {
      recordType: "shareVault",
      auction: [LONG_MAX, 1_000_000n, 1_000_000n, 720n, 2160n, LONG_MAX, BigInt(HEIGHT)]
    } as unknown as ZcShareVault;
    assert.equal(lotTarget(overflowVault, BigInt(HEIGHT)), null, "R-1: lotTarget must return null on overflow");

    // R-4: interior ERG concave peak found by windowMaturity between curve breakpoints.
    // Window [1000, 12_000] from HEIGHT=1_650_000 contains zero 21_600-block grid points.
    // Borrow curve flat 2000 bps; offer demands 1200 bps at 1000 -> 1900 bps at 12_000 with
    // 0.01 ERG batcher fee on a 10 ERG loan. Both endpoints fail (1000 has negative net yield
    // from fee drag; 12_000 yields ~1780 bps < 1900 bps), while interior durations around ~6500
    // clear the offer curve (~1580 bps > 1550 bps).
    const peakOrder = buildDraftOrder(
      {
        market: "ERG",
        pricing: "window",
        principal: (1n * ERG).toString(),
        repayment: (10n * ERG).toString(),
        timing: { mode: "window", minDuration: 1000, maxDuration: 12_000 },
        curve: { capBps: 2000, points: [] },
        collateral: { nanoErg: (25n * ERG).toString() },
        rule: { kind: "oracle", ratioBps: 15_000 }
      },
      BigInt(HEIGHT)
    );
    const peakOffer = buildDraftOffer(
      {
        market: "ERG",
        capital: (20n * ERG).toString(),
        minYieldBps: 1200,
        floorBps: 12_000,
        minBlocks: 1000,
        maxBlocks: 12_000,
        erg: { batcherFeeNanoErg: (10_000_000n).toString() }, // 0.01 ERG fee -> interior concave peak
        curve: [
          { blocks: 1000, bps: 1200 },
          { blocks: 12_000, bps: 1900 }
        ]
      },
      BigInt(HEIGHT)
    );
    const chosenPeak = windowMaturity(
      offerStateOf(peakOffer),
      peakOrder,
      fakeOracle,
      BigInt(HEIGHT)
    );
    assert.ok(
      chosenPeak !== null &&
        chosenPeak > BigInt(HEIGHT + 1003) &&
        chosenPeak < BigInt(HEIGHT + 12_000),
      `R-4: windowMaturity must find strictly interior ERG peak, got ${String(chosenPeak)}`
    );

    // I-10: ERG batcherFee >= capital - MIN_BOX rejected by buildDraftOffer
    let threwFeeCap = false;
    try {
      buildDraftOffer(
        {
          market: "ERG",
          capital: (5_000_000n).toString(),
          minYieldBps: 500,
          floorBps: 15_000,
          erg: { batcherFeeNanoErg: (4_500_000n).toString() }
        },
        BigInt(HEIGHT)
      );
    } catch {
      threwFeeCap = true;
    }
    assert.ok(threwFeeCap, "I-10: ERG offer batcherFee >= capital - MIN_BOX must be rejected");

    // I-7: partial share-ask matching in ZcMatcher when offer capital < full ask and >= minFill
    const shareVaultRec = readZcBox(shareVaultBox) as ZcShareVault;
    const shareAskOrder = makeChainBox({
      id: hexId(0xf1),
      ergoTree: getZcScript("SaleOrder", "ERG").ergoTreeHex,
      value: 3_000_000n,
      assets: [{ tokenId: shareTokenId, amount: 100_000_000n }],
      additionalRegisters: registersFromList([
        encodeHexBytes(HASH_A),
        encodeLongs([2n * ERG, 100_000_000n, 10_000_000n, BigInt(HEIGHT + 5000)])
      ])
    });
    const partOffer = buildDraftOffer(
      {
        market: "ERG",
        capital: (1n * ERG).toString(), // can only afford ~49% of the 2 ERG full share ask!
        minYieldBps: 100,
        floorBps: 12_000,
        shareBounds: { floorBps: 8_000, maxExpiry: 5_000 }
      },
      BigInt(HEIGHT)
    );
    const partBookEntries = new Map<string, ZcEntry>();
    const liveRec = readZcBox(liveBondBox)!;
    partBookEntries.set(liveBondBox.boxId, { record: liveRec, height: HEIGHT - 10 });
    partBookEntries.set(shareVaultBox.boxId, { record: shareVaultRec, height: HEIGHT - 5 });
    partBookEntries.set(shareAskOrder.boxId, { record: readZcBox(shareAskOrder)!, height: HEIGHT });
    const partBook = buildMarketBook({
      height: HEIGHT,
      blockId: hexId(0xaa),
      revision: 1,
      cut: false,
      entries: partBookEntries,
      confirmedOracle: fakeOracle
    });
    const partMatcher = new ZcMatcher(partBook, (tok) => {
      if (tok === bondUnitId) {
        return {
          token: tok,
          kind: "Order",
          market: "ERG",
          txId: hexId(0x61),
          height: HEIGHT - 10,
          held: null,
          terms: []
        };
      }
      if (tok === shareTokenId) {
        return {
          token: tok,
          kind: "DutchAuctionMint",
          market: "ERG",
          txId: hexId(0x65),
          height: HEIGHT - 5,
          held: { tokenId: bondUnitId, amount: 1n },
          terms: [100_000_000n, 5_000_000n, 5_000_000n, 20_000n, 9_000n, 720n, 2160n, LONG_MAX]
        };
      }
      return null;
    });
    const askSrc = partMatcher.askSource(openOf(readZcBox(shareAskOrder) as ZcAsk, false));
    assert.ok(askSrc.ok, `Expected valid share askSource, got: ${!askSrc.ok ? askSrc.error : ""}`);
    if (askSrc.ok) {
      const partMatch = partMatcher.evaluate(offerStateOf(partOffer), askSrc.value);
      assert.ok(partMatch.ok, `I-7: expected partial share match, got: ${!partMatch.ok ? partMatch.error : ""}`);
      if (partMatch.ok) {
        assert.ok(
          partMatch.value.units >= 10_000_000n && partMatch.value.units < 100_000_000n,
          `I-7: expected partial units in [10M, 100M), got ${partMatch.value.units}`
        );
      }
    }

    // I-10 buyLot !holdsCurrency pre-check
    const badSigUsdLot = makeChainBox({
      id: hexId(0xf5),
      ergoTree: getZcScript("LotAuction", "SigUSD").ergoTreeHex,
      value: 3_000_000n,
      assets: [{ tokenId: ZC_SIGUSD_TOKEN_ID, amount: 100n }],
      additionalRegisters: registersFromList([
        encodeHexBytes(HASH_A),
        encodeLongs([1000n, 500n, BigInt(HEIGHT), BigInt(HEIGHT + 720), BigInt(HEIGHT + 2160), 2_000_000n])
      ])
    });
    h.registerRecord(badSigUsdLot, makeDisclosureTx(hexId(0xee), TREE_A));
    const qBadLot = await quoteZcAction({ type: "buyLot", boxId: badSigUsdLot.boxId }, h.deps);
    assert.ok(
      qBadLot.refusals.some((r) => r.includes("holds SigUSD")),
      `I-10: expected buyLot holdsCurrency refusal, got: ${qBadLot.refusals.join("; ")}`
    );

    // FS-1 & I-10 warnings on createAsk & SigUSD createLot
    const qSigLot = await quoteZcAction(
      {
        type: "createLot",
        body: {
          market: "SigUSD",
          items: [{ tokenId: NFT_ID, amount: "1" }],
          opening: "500",
          floor: "200",
          start: HEIGHT,
          end: HEIGHT + 720,
          expiry: HEIGHT + 2160,
          refundFeeNanoErg: "2000000"
        }
      },
      h.deps
    );
    assert.ok(
      qSigLot.warnings.some((w) => w.includes("entire box ERG")),
      `I-10: expected SigUSD lot ERG warning, got: ${qSigLot.warnings.join("; ")}`
    );

    // FS-7: buildUnwrapSpend sums actual vault + holder receipt token counts instead of hardcoding 3n
    const customReceipt = hexId(0xf9);
    const customWrapVaultBox = makeChainBox({
      id: hexId(0xf8),
      ergoTree: getZcScript("WrapVault", null).ergoTreeHex,
      value: 31_000_000n,
      assets: [
        { tokenId: customReceipt, amount: 2n },
        { tokenId: NFT_ID, amount: 1n }
      ]
    });
    const customHolderBox = makeChainBox({
      id: hexId(0xf7),
      ergoTree: TREE_A,
      value: MIN_BOX,
      assets: [{ tokenId: customReceipt, amount: 2n }]
    });
    const customVaultRec = readZcBox(customWrapVaultBox) as ZcWrapVault;
    const unwrapSpend = buildUnwrapSpend({
      vault: customVaultRec,
      vaultBox: customWrapVaultBox,
      toTree: TREE_A,
      holderBox: customHolderBox
    });
    assert.deepEqual(
      unwrapSpend.burn,
      [{ tokenId: customReceipt, amount: 4n }],
      "FS-7: buildUnwrapSpend must burn actual vaultLocked + holderCount (4n)"
    );
  });

  // 22. Security audit regression tests (V2 Findings #1-#6)
  await test("22. V2 Audit Fixes #1-#6 (Direct Lend, Cancel Top-up, SigUSD ERG Limits, Wrap Verification, Spectrum Pricing)", async () => {
    const fakeOracleBox = makeChainBox({
      id: hexId(0xe1),
      ergoTree: ZC_ORACLE_V2_ERGO_TREE,
      value: 10_000_000n,
      assets: [{ tokenId: ZC_ORACLE_V2_NFT, amount: 1n }],
      additionalRegisters: registersFromList([encodeLong(1_000_000_000n), encodeInt(100)]),
      creationHeight: HEIGHT - 2
    });
    const fakeOracle: ZcOracle = { box: fakeOracleBox, price: 1_000_000_000n, epoch: 100 };

    // --- Finding #1: simulateWalletLend ---
    const mkOrderBox = (
      idSeed: number,
      principal: bigint,
      repayment: bigint,
      ratioBps: number,
      collateralSigUsd: bigint
    ): ChainBox => {
      const d = buildDraftOrder(
        {
          market: "ERG",
          pricing: "fixed",
          principal: principal.toString(),
          repayment: repayment.toString(),
          timing: { mode: "fixed", maturity: HEIGHT + 262_800, exact: true },
          collateral: {
            nanoErg: MIN_BOX.toString(),
            tokens: [{ tokenId: ZC_SIGUSD_TOKEN_ID, amount: collateralSigUsd.toString() }]
          },
          rule: { kind: "oracle", ratioBps }
        },
        BigInt(HEIGHT)
      );
      const out = buildOrderOutput(d, HASH_CP, HEIGHT);
      return makeChainBox({
        id: hexId(idSeed),
        ergoTree: out.ergoTree,
        value: out.value,
        assets: out.assets,
        additionalRegisters: out.additionalRegisters as Record<string, string>
      });
    };

    // Negative APR (principal 10 ERG > repayment 9 ERG), 0% APR (10 -> 10),
    // low liquidation ratio (125% ratio despite 250% cover),
    // valid 5% APR @ 175% ratio, valid 12% APR @ 175% ratio
    const negOrder = mkOrderBox(0xa1, 10n * ERG, 9n * ERG, 17_500, 2000n);
    const zeroOrder = mkOrderBox(0xa2, 10n * ERG, 10n * ERG, 17_500, 2000n);
    const lowRatioOrder = mkOrderBox(0xa3, 10n * ERG, 12n * ERG, 12_500, 3000n);
    const apr5Order = mkOrderBox(0xa4, 10n * ERG, (105n * ERG) / 10n, 17_500, 2500n);
    const apr12Order = mkOrderBox(0xa5, 10n * ERG, (112n * ERG) / 10n, 17_500, 2500n);

    const lendEntries = new Map<string, ZcEntry>();
    for (const bx of [negOrder, zeroOrder, lowRatioOrder, apr5Order, apr12Order]) {
      lendEntries.set(bx.boxId, { record: readZcBox(bx)!, height: HEIGHT });
    }
    const lendBook = buildMarketBook({
      height: HEIGHT,
      blockId: hexId(0xaa),
      revision: 1,
      cut: false,
      entries: lendEntries,
      confirmedOracle: fakeOracle
    });
    const lendKnown = {
      mine: () => false,
      disclosed: () => true,
      chain: () => null,
      origin: () => null
    };
    const lendMatcher = new ZcMatcher(lendBook, () => null);
    const lendJson = new ZcJson(lendMatcher, lendKnown);

    // Without minYieldBps, must ONLY match positive-APR orders with ratio >= 175% (apr12 + apr5)
    const simAll = simulateDraft(
      {
        type: "walletLend",
        market: "ERG",
        amount: (100n * ERG).toString(),
        to: 300_000,
        coverage: 17_500
      },
      lendMatcher,
      lendJson
    ) as { matches: { counterpartyId: string; yieldBps: number }[] };
    const matchedIds = simAll.matches.map((m) => m.counterpartyId);
    assert.deepEqual(
      matchedIds,
      [apr12Order.boxId, apr5Order.boxId],
      "Finding #1: negative-APR, 0%-APR, and below-liquidation-ratio orders must be excluded"
    );

    // With minYieldBps = 1000 (10%), must exclude apr5Order and match ONLY apr12Order
    const simMinApr = simulateDraft(
      {
        type: "walletLend",
        market: "ERG",
        amount: (100n * ERG).toString(),
        to: 300_000,
        coverage: 17_500,
        minYieldBps: 1000
      },
      lendMatcher,
      lendJson
    ) as { matches: { counterpartyId: string }[] };
    assert.deepEqual(
      simMinApr.matches.map((m) => m.counterpartyId),
      [apr12Order.boxId],
      "Finding #1: minYieldBps must filter out below-APR orders"
    );

    // With null oracle, must match ZERO orders (no null-oracle cover bypass)
    const noOracleBook = buildMarketBook({
      height: HEIGHT,
      blockId: hexId(0xaa),
      revision: 1,
      cut: false,
      entries: lendEntries,
      confirmedOracle: null
    });
    const noOracleMatcher = new ZcMatcher(noOracleBook, () => null);
    const noOracleJson = new ZcJson(noOracleMatcher, lendKnown);
    const simNoOracle = simulateDraft(
      {
        type: "walletLend",
        market: "ERG",
        amount: (100n * ERG).toString(),
        to: 300_000,
        coverage: 15_000
      },
      noOracleMatcher,
      noOracleJson
    ) as { matches: unknown[]; outcome: string };
    assert.equal(simNoOracle.matches.length, 0, "Finding #1: null oracle must yield zero matches");
    assert.equal(simNoOracle.outcome, "waiting");

    // resolveWalletLendStep preserves maturity ONLY for window orders
    const winDraft = buildDraftOrder(
      {
        market: "ERG",
        pricing: "window",
        principal: (2n * ERG).toString(),
        repayment: (22n * ERG / 10n).toString(),
        timing: { mode: "window", minDuration: 1000, maxDuration: 50_000 },
        curve: { capBps: 1200, points: [{ blocks: 1000, bps: 800 }, { blocks: 50_000, bps: 1200 }] },
        collateral: { nanoErg: (5n * ERG).toString() },
        rule: { kind: "oracle", ratioBps: 15_000 }
      },
      BigInt(HEIGHT)
    );
    const winOut = buildOrderOutput(winDraft, HASH_CP, HEIGHT);
    const winBox = makeChainBox({
      id: hexId(0xa6),
      ergoTree: winOut.ergoTree,
      value: winOut.value,
      assets: winOut.assets,
      additionalRegisters: winOut.additionalRegisters as Record<string, string>
    });
    h.registerRecord(winBox);
    const resWin = await resolveWalletLendStep(
      {
        boxId: winBox.boxId,
        maturity: BigInt(HEIGHT + 21_600),
        label: "win",
        expectedCostRaw: 2n * ERG
      },
      h.deps
    );
    assert.equal(resWin.type, "fillOrder");
    if (resWin.type === "fillOrder") {
      assert.equal(
        resWin.maturity,
        BigInt(HEIGHT + 21_600),
        "Finding #1: resolveWalletLendStep must preserve window maturity"
      );
    }

    // --- Finding #3: Cancel lockout on token-heavy box + low-ERG auth box ---
    const cancelH = createHarness();
    const manyTokens: ChainAsset[] = Array.from({ length: 90 }, (_, i) => ({
      tokenId: (0x1000 + i).toString(16).padStart(64, "0"),
      amount: 100n
    }));
    // Protocol lot box holding 90 tokens (~3,100 B -> minBoxValue > 1.1M nanoERG) with 0.0011 ERG
    // Previously `totalErg = 1.1M >= MIN_BOX` passed assembleCancelTx's naive MIN_BOX check
    // and crashed assertTxInvariants with ZcTxInvariantError!
    const tokenHeavyLot = makeChainBox({
      id: hexId(0xc1),
      ergoTree: getZcScript("LotAuction", "ERG").ergoTreeHex,
      value: 1_100_000n,
      assets: manyTokens,
      additionalRegisters: registersFromList([
        encodeHexBytes(HASH_A),
        encodeLongs([5n * ERG, 2n * ERG, BigInt(HEIGHT), BigInt(HEIGHT + 720), BigInt(HEIGHT + 2160), 2_000_000n])
      ])
    });
    cancelH.registerRecord(tokenHeavyLot);
    // Creator address ADDR_A ONLY holds a 0.001 ERG token box; ERG lives at ADDR_B!
    cancelH.walletUtxos.push(
      makeChainBox({
        id: hexId(0xc2),
        ergoTree: TREE_A,
        value: MIN_BOX,
        assets: [{ tokenId: hexId(0xbc), amount: 1n }]
      }),
      makeChainBox({
        id: hexId(0xc3),
        ergoTree: TREE_B,
        value: 2n * ERG
      })
    );
    const cancelQuote = await quoteZcAction({ type: "cancel", boxId: tokenHeavyLot.boxId }, cancelH.deps);
    assert.equal(cancelQuote.refusals.length, 0, `Finding #3: cancel quote failed: ${cancelQuote.refusals.join("; ")}`);
    const cancelBuilt = await buildZcAction({ type: "cancel", boxId: tokenHeavyLot.boxId }, cancelH.deps);
    assert.equal(cancelBuilt.unsignedTx.inputs.length, 3, "Finding #3: cancel must pull extra funding input");
    assert.equal(cancelBuilt.signers[0], null);
    assert.equal(cancelBuilt.signers[1], ADDR_A);
    assert.equal(cancelBuilt.signers[2], ADDR_B);
    assert.equal(cancelBuilt.unsignedTx.outputs.length, 2);

    // Also verify selectAuthBox prefers clean/sufficient ERG box when available
    const dustTokenBox = makeChainBox({
      id: hexId(0xc4),
      ergoTree: TREE_A,
      value: MIN_BOX,
      assets: [{ tokenId: hexId(0xbd), amount: 1n }]
    });
    const cleanErgBox = makeChainBox({
      id: hexId(0xc5),
      ergoTree: TREE_A,
      value: 5_000_000n
    });
    const pickedAuth = selectAuthBox([dustTokenBox, cleanErgBox], TREE_A, {
      preferClean: true,
      minValue: 2_000_000n
    });
    assert.equal(pickedAuth?.boxId, cleanErgBox.boxId, "Finding #3: selectAuthBox should prefer clean sufficient ERG box");

    // --- Finding #4: SigUSD slippage limits enforce maxErgPay ---
    const sigOfferAct: ZcTxAction = {
      type: "createOffer",
      body: {
        market: "SigUSD",
        capital: "5000",
        minYieldBps: 700,
        floorBps: 15_000,
        curve: [{ blocks: 21_600, bps: 800 }]
      }
    };
    const sigQuote = await quoteZcAction(sigOfferAct, h.deps);
    assert.equal(sigQuote.refusals.length, 0, `SigUSD createOffer quote failed: ${sigQuote.refusals.join("; ")}`);
    assert.equal(sigQuote.suggestedLimits.maxPay, 5000n, "Finding #4: SigUSD maxPay must be populated");
    assert.ok(
      sigQuote.suggestedLimits.maxErgPay !== undefined && sigQuote.suggestedLimits.maxErgPay > 0n,
      "Finding #4: SigUSD maxErgPay must be populated"
    );
    // Building with exact suggestedLimits succeeds
    const sigBuilt = await buildZcAction(sigOfferAct, h.deps, sigQuote.suggestedLimits);
    assert.ok(sigBuilt.unsignedTx.outputs.length >= 2);
    // Tightening ONLY maxErgPay by 1 nanoERG must trigger ZcTxConflictError
    let threwErgLimit = false;
    try {
      await buildZcAction(sigOfferAct, h.deps, {
        ...sigQuote.suggestedLimits,
        maxErgPay: sigQuote.suggestedLimits.maxErgPay! - 1n
      });
    } catch (err) {
      threwErgLimit = err instanceof ZcTxConflictError;
    }
    assert.ok(threwErgLimit, "Finding #4: exceeding maxErgPay on SigUSD tx must throw ZcTxConflictError");

    // --- Finding #5: Unverified wrap receipt must NOT show verified status ---
    const unverifiedReceipt = verifyToken({
      id: hexId(0xd1),
      ticker: "ZCS-Wrap-Fake",
      decimals: 0,
      amount: 1,
      kind: "receipt",
      verified: false,
      wraps: {
        id: ZC_SIGUSD_TOKEN_ID,
        ticker: "SigUSD",
        name: "SigUSD",
        description: null,
        decimals: 2,
        amount: 100,
        rawAmount: "10000",
        kind: "token",
        bondId: null,
        vaultBoxId: null,
        refreshFrom: null,
        state: "wrapped"
      }
    });
    assert.equal(
      unverifiedReceipt.status,
      "unverified",
      "Finding #5: unverified wrap receipt must have status=unverified"
    );
    assert.equal(unverifiedReceipt.badge, "Custody unverified");

    const verifiedReceipt = verifyToken({
      id: hexId(0xd2),
      ticker: "ZCS-Wrap-Real",
      decimals: 0,
      amount: 1,
      kind: "receipt",
      verified: true,
      wraps: {
        id: ZC_SIGUSD_TOKEN_ID,
        ticker: "SigUSD",
        name: "SigUSD",
        description: null,
        decimals: 2,
        amount: 100,
        rawAmount: "10000",
        kind: "token",
        bondId: null,
        vaultBoxId: null,
        refreshFrom: null,
        state: "wrapped"
      }
    });
    assert.equal(verifiedReceipt.status, "verified");
    assert.equal(verifiedReceipt.badge, "Custody + Asset Verified");

    // --- Finding #6: Spectrum pool selection picks deepest ERG pool & rejects non-ERG/thin pools ---
    const unverifiedTok = hexId(0xd3);
    const poolThin = {
      id: "pool-thin",
      baseId: SPECTRUM_ERG_TOKEN_ID,
      baseSymbol: "ERG",
      quoteId: ZC_SIGUSD_TOKEN_ID,
      quoteSymbol: "SigUSD",
      lastPrice: 0.01, // fake 100 ERG per SigUSD
      baseVolume: { value: 5 },
      quoteVolume: { value: 1 }
    };
    const poolDeep = {
      id: "pool-deep",
      baseId: SPECTRUM_ERG_TOKEN_ID,
      baseSymbol: "ERG",
      quoteId: ZC_SIGUSD_TOKEN_ID,
      quoteSymbol: "SigUSD",
      lastPrice: 1.5, // real ~0.6667 ERG per SigUSD
      baseVolume: { value: 50_000 },
      quoteVolume: { value: 75_000 }
    };
    const poolNonErg = {
      id: "pool-non-erg",
      baseId: hexId(0xd9),
      baseSymbol: "FAKE",
      quoteId: ZC_SIGUSD_TOKEN_ID,
      quoteSymbol: "SigUSD",
      lastPrice: 0.0001,
      baseVolume: { value: 999_999 },
      quoteVolume: { value: 999_999 }
    };
    const poolUnverifiedThin = {
      id: "pool-unv-thin",
      baseId: SPECTRUM_ERG_TOKEN_ID,
      baseSymbol: "ERG",
      quoteId: unverifiedTok,
      quoteSymbol: "SCAM",
      lastPrice: 0.001,
      baseVolume: { value: 100_000 },
      quoteVolume: { value: 100 }
    };
    const poolZeroPrice = {
      id: "pool-zero",
      baseId: SPECTRUM_ERG_TOKEN_ID,
      baseSymbol: "ERG",
      quoteId: unverifiedTok,
      quoteSymbol: "SCAM",
      lastPrice: 0,
      baseVolume: { value: 100_000 },
      quoteVolume: { value: 100 }
    };
    const stats = [
      {
        id: "pool-thin",
        lockedX: { id: SPECTRUM_ERG_TOKEN_ID, amount: 10, ticker: "ERG", decimals: 9 },
        lockedY: { id: ZC_SIGUSD_TOKEN_ID, amount: 10, ticker: "SigUSD", decimals: 2 },
        tvl: { value: 20 }
      },
      {
        id: "pool-deep",
        lockedX: { id: SPECTRUM_ERG_TOKEN_ID, amount: 100_000, ticker: "ERG", decimals: 9 },
        lockedY: { id: ZC_SIGUSD_TOKEN_ID, amount: 150_000, ticker: "SigUSD", decimals: 2 },
        tvl: { value: 250_000 }
      },
      {
        id: "pool-unv-thin",
        lockedX: { id: SPECTRUM_ERG_TOKEN_ID, amount: 100, ticker: "ERG", decimals: 9 },
        lockedY: { id: unverifiedTok, amount: 100, ticker: "SCAM", decimals: 0 },
        tvl: { value: 500 } // below MIN_USD_LIQUIDITY (10,000)
      }
    ];

    // Check BOTH array orderings ([thin, deep, nonErg] AND [deep, thin, nonErg])
    const r1 = selectSpectrumTokenRates([poolThin, poolDeep, poolNonErg, poolUnverifiedThin, poolZeroPrice], stats);
    const r2 = selectSpectrumTokenRates([poolDeep, poolThin, poolNonErg, poolUnverifiedThin, poolZeroPrice], stats);
    assert.ok(r1.has(ZC_SIGUSD_TOKEN_ID) && r2.has(ZC_SIGUSD_TOKEN_ID));
    assert.equal(
      r1.get(ZC_SIGUSD_TOKEN_ID)!.toFixed(6),
      (1 / 1.5).toFixed(6),
      "Finding #6: deepest ERG pool must win when listed second"
    );
    assert.equal(
      r2.get(ZC_SIGUSD_TOKEN_ID)!.toFixed(6),
      (1 / 1.5).toFixed(6),
      "Finding #6: deepest ERG pool must win when listed first"
    );
    assert.ok(
      !r1.has(unverifiedTok),
      "Finding #6: unverified token below MIN_USD_LIQUIDITY must be excluded"
    );
    // Non-ERG pool alone for verified token must also be excluded
    const rNonErgOnly = selectSpectrumTokenRates([poolNonErg], stats);
    assert.ok(
      !rNonErgOnly.has(ZC_SIGUSD_TOKEN_ID),
      "Finding #6: non-ERG base pool for verified token must be rejected"
    );
  });

  // 23. Security audit regression tests (V2 Findings #7-#13)
  await test("23. V2 Audit Fixes #7-#13 (Zero Oracle Coverage, Unproven SaleOrder Refusal, Network & Cache Integrity, Pending Unit Claim)", async () => {
    // --- Finding #7: coverage() returns null when oraclePrice <= 0 ---
    assert.equal(
      coverage({ erg: 100, usd: 0, tokens: [] }, 50, "SigUSD", 0),
      null,
      "Finding #7: coverage must return null when oraclePrice is 0"
    );
    assert.equal(
      coverage({ erg: 0, usd: 100, tokens: [] }, 50, "ERG", 0),
      null,
      "Finding #7: coverage must return null when oraclePrice is 0"
    );

    // --- Finding #9: buyAsk refuses arbitrary unproven non-bond token by default ---
    const spoofToken = hexId(0xe8);
    const spoofAskBox = makeChainBox({
      id: hexId(0xe9),
      txId: hexId(0xea),
      ergoTree: getZcScript("SaleOrder", "ERG").ergoTreeHex,
      value: 3_000_000n,
      assets: [{ tokenId: spoofToken, amount: 1n }],
      additionalRegisters: registersFromList([
        encodeHexBytes(HASH_CP),
        encodeLongs([5n * ERG, 1n, 1n, BigInt(HEIGHT + 5000)])
      ])
    });
    h.registerRecord(spoofAskBox, makeDisclosureTx(hexId(0xea), TREE_CP));

    const qSpoof = await quoteZcAction({ type: "buyAsk", boxId: spoofAskBox.boxId }, h.deps);
    assert.ok(
      qSpoof.refusals.some((r) => r.includes("not a proven")),
      `Finding #9: unproven SaleOrder must be refused by default, got: ${qSpoof.refusals.join("; ")}`
    );
    // Explicit allowUnproven opt-in still builds cleanly
    const qSpoofOptIn = await quoteZcAction(
      { type: "buyAsk", boxId: spoofAskBox.boxId, allowUnproven: true },
      h.deps
    );
    assert.equal(qSpoofOptIn.refusals.length, 0, "Finding #9: allowUnproven opt-in should succeed");
    assert.ok(qSpoofOptIn.warnings.length > 0);

    // --- Finding #10a: ZcResolver discards tampered localStorage scripts ---
    const memStorage = new Map<string, string>();
    const storageLike = {
      getItem: (k: string) => memStorage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memStorage.set(k, v);
      },
      removeItem: (k: string) => {
        memStorage.delete(k);
      }
    };
    const cacheKey = `sigmafi.zc.resolverCache.v1:mainnet:${ZC_PINNED_COMMIT}`;
    memStorage.set(
      cacheKey,
      JSON.stringify({
        v: 1,
        commit: ZC_PINNED_COMMIT,
        origins: [],
        scripts: [
          [HASH_A, TREE_A], // valid hash -> tree
          [HASH_CP, TREE_A] // tampered! HASH_CP does not match blake2b256(TREE_A)
        ],
        roots: []
      })
    );
    const mockClient = {
      getEndpoint: () => "mock://net",
      setEndpoint: () => undefined,
      fetchStateAndOracle: async () => ({ state: { height: HEIGHT, blockId: hexId(1), network: "mainnet" }, oracle: null }),
      fetchAllUnspentZcBoxes: async () => ({ boxes: [], cut: false }),
      fetchBoxesByIds: async () => new Map(),
      fetchTransactionsByIds: async () => new Map(),
      fetchTokensByIds: async () => new Map(),
      fetchTransactionsByAddresses: async () => []
    } as unknown as ZcChainClient;
    const resolverFromCache = new ZcResolver(() => mockClient, {
      network: "mainnet",
      storage: storageLike
    });
    assert.equal(
      resolverFromCache.knownScript(HASH_A),
      TREE_A,
      "Finding #10: valid cached script must be preserved"
    );
    assert.equal(
      resolverFromCache.knownScript(HASH_CP),
      null,
      "Finding #10: tampered cached script with hash mismatch must be discarded"
    );

    // --- Finding #10b: Explorer & GraphQL clients reject wrong-network endpoints ---
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            data: {
              state: { height: 500_000, blockId: hexId(0x11), network: "testnet" },
              oracleBoxes: []
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as typeof fetch;
      const gqlMain = new ZcGraphqlClient("https://custom.example/graphql", "mainnet");
      let gqlRejected = false;
      try {
        await gqlMain.fetchStateAndOracle();
      } catch (err) {
        gqlRejected = err instanceof ZcApiError && err.message.includes("network mismatch");
      }
      assert.ok(gqlRejected, "Finding #10: ZcGraphqlClient must reject testnet response on mainnet");

      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/networkState") || u.includes("/info")) {
          return new Response(
            JSON.stringify({ height: 500_000, lastBlockId: hexId(0x11), network: "testnet" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }) as typeof fetch;
      const expMain = new ZcExplorerClient("https://custom.example/api/v1", "mainnet");
      let expRejected = false;
      try {
        await expMain.fetchStateAndOracle();
      } catch (err) {
        expRejected = err instanceof ZcApiError && err.message.includes("network mismatch");
      }
      assert.ok(expRejected, "Finding #10: ZcExplorerClient must reject testnet response on mainnet");
    } finally {
      globalThis.fetch = origFetch;
    }

    // --- Finding #13c: pending (mempool) bond unit settlement can be claimed ---
    const pendBondAsset = hexId(0xeb);
    const pendSettleBox = makeChainBox({
      id: hexId(0xec),
      ergoTree: getZcScript("BondVault", null).ergoTreeHex,
      value: 5n * ERG,
      assets: [{ tokenId: pendBondAsset, amount: 2n }],
      additionalRegisters: registersFromList([
        encodeHexBytes(pendBondAsset),
        encodeByte(0),
        encodeHexBytes(hexId(0xed))
      ])
    });
    const pendSettleRec = readZcBox(pendSettleBox)!;
    const pendH = createHarness();
    pendH.boxes.set(pendSettleBox.boxId, pendSettleBox);
    pendH.walletUtxos.push(
      makeChainBox({
        id: hexId(0xef),
        ergoTree: TREE_A,
        value: 2n * ERG,
        assets: [{ tokenId: pendBondAsset, amount: 1n }]
      })
    );
    const pendBaseDeps = pendH.deps;
    const pendDeps: ZcTxDeps = {
      ...pendBaseDeps,
      async getReadContext() {
        const baseCtx = await pendBaseDeps.getReadContext();
        const pendBook = buildMarketBook({
          height: HEIGHT,
          blockId: hexId(0xaa),
          revision: 2,
          cut: false,
          entries: new Map(),
          pendingRecords: new Map([[pendSettleBox.boxId, pendSettleRec]]),
          confirmedOracle: baseCtx.book.confirmedOracle
        });
        const mockResolver = Object.create(baseCtx.resolver) as ZcResolver;
        mockResolver.knownOrigin = (tok: string) =>
          tok.toLowerCase() === pendBondAsset
            ? {
                token: pendBondAsset,
                kind: "Order",
                market: "ERG",
                txId: hexId(0x61),
                height: HEIGHT - 100,
                held: null,
                terms: []
              }
            : baseCtx.resolver.knownOrigin(tok);
        const pendMatcher = new ZcMatcher(pendBook, (t) => mockResolver.knownOrigin(t));
        return { ...baseCtx, book: pendBook, resolver: mockResolver, matcher: pendMatcher };
      }
    };
    const qPendClaim = await quoteZcAction({ type: "claim", tokenId: pendBondAsset }, pendDeps);
    assert.equal(
      qPendClaim.refusals.length,
      0,
      `Finding #13: pending bond unit settlement must be claimable, got: ${qPendClaim.refusals.join("; ")}`
    );
    const bPendClaim = await buildZcAction({ type: "claim", tokenId: pendBondAsset }, pendDeps);
    assert.equal(bPendClaim.signers[0], null);
  });

  console.log(`\nALL ${passed} VERIFICATION SUITES PASSED.\n`);
}

runAll().catch((err) => {
  console.error("\nVERIFICATION FAILED:\n", err);
  throw err;
});
