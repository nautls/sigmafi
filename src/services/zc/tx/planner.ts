/**
 * SECURITY AUDIT BOUNDARY: SigmaFi V2 (zcs1) transaction planner, quoter, and executor.
 *
 * Exact client-side port of Lithos-Client's `ZcWriteExecution.scala`:
 * - Supports all 19 SigmaFi V2 user operations (`createOrder`, `createOffer`, `createAsk`,
 *   `createLot`, `fractionalize`, `createWrap`, `cancel`, `fillOrder`, `buyAsk`, `buyLot`,
 *   `repay`, `extinguish`, `recollateralize`, `liquidate`, `claim`, `mint`, `pull`,
 *   `buyVault`, `unwrap`).
 * - Pure read-only quoting (`quoteZcAction`) never signs or mutates anything and collects
 *   protocol refusals, prerequisites (`requires`), warnings, and `suggestedLimits`.
 * - Fresh-state building (`buildZcAction`) re-fetches every spent & data-input box from the
 *   chain, re-reads fresh Nautilus UTXOs, enforces `limits`, attaches explicit Nautilus v3
 *   per-input `signers`, and passes `assertTxInvariants`.
 * - Signing & submission (`signAndSubmitZcAction`) passes `{ signers }` to Nautilus
 *   `v2.0.0-beta.3+` `ergo.sign_tx(unsignedTx, { signers })`.
 */
import { hex } from "@fleet-sdk/crypto";
import {
  ChainAsset,
  ChainBox,
  LONG_MAX,
  MIN_BOX,
  readZcBox,
  ZcAsk,
  ZcBond,
  ZcLot,
  ZcOracle,
  ZcOrder,
  ZcOrigin,
  ZcRecord,
  ZcSettlement,
  ZcShareRequest,
  ZcShareVault,
  ZcWrapRequest,
  ZcWrapVault
} from "../boxes";
import {
  classifyErgoTree,
  getZcExpressionBytes,
  marketByTokenId,
  marketTokenId
} from "../contracts";
import {
  buildDraftAsk,
  buildDraftLot,
  buildDraftOffer,
  buildDraftOrder,
  buildDraftShareRequest,
  buildDraftWrap
} from "../drafts";
import { ZcApiError } from "../errors";
import { MAX_OFFERS, openOf, orderSourceOf, ZcMarketBook, ZcMatcher } from "../matcher";
import {
  atLeast,
  bigMax,
  bigMin,
  crossingPrice,
  MIN_BATCHING_FEE,
  QUOTE_BLOCKS,
  ratioBps,
  RECOLLATERALIZE_WAIT,
  REFRESH_BOUNTY,
  SHARE_COUNT,
  usdPerErg,
  yieldBps
} from "../pricing";
import { ZcResolver } from "../resolver";
import {
  askPrice,
  askSaleGuard,
  auctionOpen,
  batcherFee,
  belowOwnRatio,
  bondTermsOf,
  buysShares,
  claimableFrom,
  coverOfBond,
  currencyHeld,
  excessAuction,
  excessPrice,
  fillRatio,
  fillRefusal,
  freshOracle,
  guardRefusal,
  isTokenOffer,
  isWindowOrder,
  isYieldAsk,
  liqRuleKind,
  lotPrice,
  lotValid,
  minFillBps,
  orderMaturity,
  orderRefusal,
  orderWindow,
  prospectBondTerms,
  repayableFromCollateral,
  resolvePrincipal,
  saleGuardRefusal,
  vaultCurrency,
  ZcBondTerms
} from "../rules";
import {
  assembleCancelTx,
  assemblePostTx,
  assembleSpendTx,
  buildAskOutput,
  buildBuyAskSpend,
  buildBuyFromVaultSpend,
  buildBuyLotSpend,
  buildClaimSharesSpend,
  buildClaimUnitSpend,
  buildExtinguishSpend,
  buildFillOrderSpend,
  buildLiquidateSpend,
  buildLotOutput,
  buildMintSharesSpend,
  buildMintWrapSpend,
  buildOfferOutput,
  buildOrderOutput,
  buildPullSpend,
  buildRecollateralizeSpend,
  buildRepaySpend,
  buildShareRequestOutput,
  buildUnwrapSpend,
  buildWrapRequestOutput,
  DEFAULT_RESERVE,
  resolveOrderPrincipal,
  TxOutputDraft,
  ZcSpendDraft
} from "./builders";
import { serializeChainBoxBytes } from "./encoding";
import {
  indexWalletAddresses,
  normalizeWalletUtxo,
  selectAuthBox,
  WalletAddressBook
} from "./funding";
import { TX_FEE } from "./invariants";
import { receiptMetadata, ruleFields, sharesMetadata } from "./metadata";
import {
  ZcBuiltTx,
  ZcSubmitResult,
  ZcTxAction,
  ZcTxConflictError,
  ZcTxCreatedBox,
  ZcTxDeps,
  ZcTxFeeItem,
  ZcTxInvariantError,
  ZcTxLimits,
  ZcTxQuote,
  ZcTxReadContext,
  ZcTxRefusalError,
  ZcWalletLendBatchStep
} from "./types";
import { ZcMarket } from "@/types/zc";

// ─── Small pure utilities ────────────────────────────────────────────────────

function requireHex64(id: string, label = "id"): string {
  const clean = id.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new ZcTxRefusalError(`'${id}' is not a valid 64-character hex ${label}.`);
  }
  return clean;
}

function walletHeld(utxos: readonly ChainBox[], tokenId: string): bigint {
  const target = tokenId.toLowerCase();
  let sum = 0n;
  for (const u of utxos) {
    for (const a of u.assets) {
      if (a.tokenId === target) sum += a.amount;
    }
  }
  return sum;
}

function feeItem(
  name: string,
  nanoErg: bigint,
  kind: ZcTxFeeItem["kind"]
): ZcTxFeeItem {
  return { name, nanoErg, kind };
}

function tallyAssetList(assets: readonly ChainAsset[]): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const a of assets) {
    if (a.amount <= 0n) continue;
    const id = a.tokenId.toLowerCase();
    map.set(id, (map.get(id) ?? 0n) + a.amount);
  }
  return map;
}

function buildRefusedQuote(
  action: string,
  height: number,
  reason: string,
  requires: readonly string[] = []
): ZcTxQuote {
  return {
    action,
    market: null,
    paysNanoErgs: 0n,
    receivesNanoErgs: 0n,
    paysTokens: [],
    receivesTokens: [],
    fees: [],
    creates: [],
    terms: {},
    validFrom: height,
    validThrough: null,
    warnings: [],
    refusals: [reason],
    requires,
    suggestedLimits: {}
  };
}

function computePostQuote(params: {
  readonly action: string;
  readonly market: ZcMarket | null;
  readonly role: string;
  readonly box: TxOutputDraft;
  readonly terms: Record<string, unknown>;
  readonly height: number;
  readonly warnings?: readonly string[];
  readonly extraFees?: readonly ZcTxFeeItem[];
}): ZcTxQuote {
  const { action, market, role, box, terms, height, warnings = [], extraFees = [] } = params;
  const paysNanoErgs = box.value + TX_FEE;
  const mToken = market ? marketTokenId(market) : null;
  const marketPay =
    mToken === null
      ? paysNanoErgs
      : box.assets
          .filter((a) => a.tokenId.toLowerCase() === mToken)
          .reduce((acc, a) => acc + a.amount, 0n);

  return {
    action,
    market,
    paysNanoErgs,
    receivesNanoErgs: 0n,
    paysTokens: box.assets,
    receivesTokens: [],
    fees: [feeItem("miner", TX_FEE, "spent"), ...extraFees],
    creates: [
      {
        role,
        contract: classifyErgoTree(box.ergoTree)?.kind ?? null,
        nanoErg: box.value,
        tokens: box.assets
      }
    ],
    terms,
    validFrom: height,
    validThrough: null,
    warnings,
    refusals: [],
    requires: [],
    suggestedLimits: marketPay > 0n ? { maxPay: marketPay } : {}
  };
}

function computeSpendQuote(params: {
  readonly action: string;
  readonly market: ZcMarket | null;
  readonly spend: ZcSpendDraft;
  readonly roles: readonly string[];
  readonly terms: Record<string, unknown>;
  readonly walletBook: WalletAddressBook;
  readonly height: number;
  readonly validThrough: bigint | null;
  readonly warnings?: readonly string[];
  readonly extraFees?: readonly ZcTxFeeItem[];
}): ZcTxQuote {
  const {
    action,
    market,
    spend,
    roles,
    terms,
    walletBook,
    height,
    validThrough,
    warnings = [],
    extraFees = []
  } = params;

  // Protocol inputs only (wallet's own auth inputs do not change net wallet balances)
  const outside = spend.inputs.filter((_, idx) => spend.protocolIndices.has(idx));
  const outs: TxOutputDraft[] = [];
  const toWallet: TxOutputDraft[] = [];

  if (spend.sweepToTree === null) {
    for (const o of spend.outputs) {
      if (walletBook.byTreeHex.has(o.ergoTree.toLowerCase())) {
        toWallet.push(o);
      } else {
        outs.push(o);
      }
    }
  }

  const outsideErg = outside.reduce((acc, i) => acc + BigInt(i.value), 0n);
  const outsErg = outs.reduce((acc, o) => acc + o.value, 0n);
  const erg = outsideErg - outsErg - TX_FEE;

  const inTokens = new Map<string, bigint>();
  for (const inp of outside) {
    for (const a of inp.assets) {
      const id = a.tokenId.toLowerCase();
      inTokens.set(id, (inTokens.get(id) ?? 0n) + BigInt(a.amount));
    }
  }
  const usedTokens = tallyAssetList([
    ...outs.flatMap((o) => o.assets),
    ...spend.burn
  ]);

  const mintedId = spend.minted ? spend.minted.toLowerCase() : null;
  const walletOutTokens = tallyAssetList(toWallet.flatMap((o) => o.assets));

  const net = new Map<string, bigint>();
  for (const id of new Set([...inTokens.keys(), ...usedTokens.keys()])) {
    if (id === mintedId) continue;
    const diff = (inTokens.get(id) ?? 0n) - (usedTokens.get(id) ?? 0n);
    if (diff !== 0n) net.set(id, diff);
  }
  if (mintedId) {
    const mintedHere = walletOutTokens.get(mintedId) ?? 0n;
    if (mintedHere !== 0n) net.set(mintedId, mintedHere);
  }

  const paysTokens: ChainAsset[] = [];
  const receivesTokens: ChainAsset[] = [];
  for (const [tokenId, amt] of net) {
    if (amt < 0n) paysTokens.push({ tokenId, amount: -amt });
    else if (amt > 0n) receivesTokens.push({ tokenId, amount: amt });
  }

  const mToken = market ? marketTokenId(market) : null;
  const marketNet = mToken === null ? erg : (net.get(mToken) ?? 0n);

  const creates: ZcTxCreatedBox[] = [];
  for (let i = 0; i < spend.outputs.length; i++) {
    const o = spend.outputs[i];
    if (walletBook.byTreeHex.has(o.ergoTree.toLowerCase())) continue;
    creates.push({
      role: roles[i] ?? "output",
      contract: classifyErgoTree(o.ergoTree)?.kind ?? null,
      nanoErg: o.value,
      tokens: o.assets
    });
  }

  const suggestedLimits: ZcTxLimits =
    marketNet < 0n
      ? { maxPay: -marketNet }
      : marketNet > 0n
        ? { minReceive: marketNet }
        : {};

  return {
    action,
    market,
    paysNanoErgs: erg < 0n ? -erg : 0n,
    receivesNanoErgs: erg > 0n ? erg : 0n,
    paysTokens,
    receivesTokens,
    fees: [feeItem("miner", TX_FEE, "spent"), ...extraFees],
    creates,
    terms,
    validFrom: height,
    validThrough:
      validThrough === null || validThrough >= LONG_MAX ? null : Number(validThrough),
    warnings,
    refusals: [],
    requires: [],
    suggestedLimits
  };
}

// ─── Chain & wallet read helpers ─────────────────────────────────────────────

async function resolveHeight(deps: ZcTxDeps, book: ZcMarketBook): Promise<number> {
  let walletHeight = 0;
  try {
    walletHeight = await deps.wallet.getCurrentHeight();
  } catch {
    walletHeight = 0;
  }
  if (Number.isInteger(walletHeight) && walletHeight > 0) return walletHeight;
  if (Number.isInteger(book.height) && book.height > 0) return book.height;
  throw new ZcTxRefusalError("Unable to read current Ergo blockchain height.");
}

async function readBoxesForTx(
  ctx: ZcTxReadContext,
  ids: readonly string[],
  fresh: boolean
): Promise<Map<string, ChainBox>> {
  const unique = Array.from(new Set(ids.map((x) => x.toLowerCase())));
  const out = new Map<string, ChainBox>();
  const toFetch: string[] = [];

  for (const id of unique) {
    if (!fresh) {
      const cached = ctx.book.byBoxId.get(id)?.record.box;
      if (cached) {
        out.set(id, cached);
        continue;
      }
      if (ctx.book.confirmedOracle?.box.boxId.toLowerCase() === id) {
        out.set(id, ctx.book.confirmedOracle.box);
        continue;
      }
    }
    toFetch.push(id);
  }

  if (toFetch.length > 0) {
    const fetched = await ctx.client.fetchBoxesByIds(toFetch);
    for (const id of toFetch) {
      const box = fetched.get(id);
      if (!box) {
        if (fresh) {
          throw new ZcTxConflictError(
            `Box ${id.slice(0, 10)}… is no longer unspent or could not be found on chain.`
          );
        }
        throw new ZcTxRefusalError(`No unspent box found with id ${id}.`);
      }
      if (box.spentTransactionId) {
        throw new ZcTxConflictError(
          `Box ${id.slice(0, 10)}… was already spent by tx ${box.spentTransactionId.slice(0, 10)}….`
        );
      }
      out.set(id, box);
    }
  }

  return out;
}

async function readSingleBox(
  ctx: ZcTxReadContext,
  boxId: string,
  fresh: boolean
): Promise<ChainBox> {
  const id = requireHex64(boxId, "boxId");
  const map = await readBoxesForTx(ctx, [id], fresh);
  const box = map.get(id);
  if (!box) {
    throw new ZcTxConflictError(`Box ${id.slice(0, 10)}… is no longer unspent.`);
  }
  return box;
}

function requireOracle(book: ZcMarketBook): ZcOracle {
  if (book.refreshPending) {
    throw new ZcTxRefusalError(
      "The ERG/USD oracle pool is currently refreshing in the mempool. Wait for the next block and try again."
    );
  }
  if (!book.oracle) {
    throw new ZcTxRefusalError("No usable ERG/USD oracle pool box is available on chain.");
  }
  return book.oracle;
}

function checkCoverSafety(
  book: ZcMarketBook,
  bond: ZcBondTerms,
  allowLiquidatable: boolean | undefined,
  why: string,
  instead: string
): void {
  const o = book.oracle;
  if (!o) return;
  if (belowOwnRatio(bond, o.price) && !allowLiquidatable) {
    const cov = coverOfBond(bond, o.price);
    const bps = cov ? ratioBps(cov).toString() : "0";
    throw new ZcTxRefusalError(
      `${why} at ${bps} bps of its repayment, under its own liquidation ratio at the oracle price: anyone could liquidate it immediately, taking all the collateral. ${instead}`
    );
  }
}

async function resolvePartyScript(
  record: ZcRecord,
  walletBook: WalletAddressBook,
  resolver: ZcResolver,
  height: number,
  who: string
): Promise<string> {
  if (!record.namedHash) {
    throw new ZcTxRefusalError(`Box ${record.boxId} does not name a ${who}.`);
  }
  const own = walletBook.byTreeHash.get(record.namedHash);
  if (own) return own.ergoTreeHex;

  const cached = resolver.knownScript(record.namedHash);
  if (cached) return cached;

  await resolver.resolveDisclosures([record], height);
  const resolved = resolver.knownScript(record.namedHash);
  if (resolved) return resolved;

  throw new ZcTxRefusalError(
    `Box ${record.boxId.slice(0, 10)}… does not disclose its ${who}'s script (zcs1 script disclosure), so only the ${who} can act on it.`
  );
}

async function ensureOrigin(
  tokenId: string,
  resolver: ZcResolver,
  height: number
): Promise<ZcOrigin | null> {
  const id = tokenId.toLowerCase();
  const cached = resolver.knownOrigin(id);
  if (cached) return cached;
  await resolver.resolveOrigins([id], height);
  return resolver.knownOrigin(id);
}

async function ensureClaimOrigins(
  tokenId: string,
  resolver: ZcResolver,
  height: number
): Promise<ZcOrigin | null> {
  const orig = await ensureOrigin(tokenId, resolver, height);
  if (orig?.held) {
    await ensureOrigin(orig.held.tokenId, resolver, height);
  }
  return orig;
}

function matcherWithFreshOrigins(ctx: ZcTxReadContext): ZcMatcher {
  return new ZcMatcher(ctx.book, (t) => ctx.resolver.knownOrigin(t));
}

async function readLiveBond(
  ctx: ZcTxReadContext,
  assetId: string,
  fresh: boolean
): Promise<{ readonly bond: ZcBond; readonly box: ChainBox }> {
  const asset = requireHex64(assetId, "bond assetId");
  const openBond = ctx.book.bonds.get(asset);
  if (openBond) {
    const box = await readSingleBox(ctx, openBond.boxId, fresh);
    const decoded = readZcBox(box);
    if (!decoded || decoded.recordType !== "bond") {
      throw new ZcTxConflictError(`Box ${openBond.boxId.slice(0, 10)}… is no longer a live bond.`);
    }
    return { bond: decoded, box };
  }
  if (ctx.book.settlements.has(asset)) {
    throw new ZcTxRefusalError(`Bond ${asset.slice(0, 10)}… is already settled.`);
  }
  throw new ZcTxRefusalError(`No live bond holds the reserve of ${asset.slice(0, 10)}….`);
}

function requireCreatorAuth(
  creatorHash: string,
  walletBook: WalletAddressBook,
  walletUtxos: readonly ChainBox[],
  notOwnerMessage: string,
  preferToken?: string
): { readonly ergoTreeHex: string; readonly address: string; readonly authBox: ChainBox } {
  const creator = walletBook.byTreeHash.get(creatorHash.toLowerCase());
  if (!creator) {
    throw new ZcTxRefusalError(notOwnerMessage);
  }
  const authBox = selectAuthBox(walletUtxos, creator.ergoTreeHex, { preferToken });
  if (!authBox) {
    throw new ZcTxRefusalError(
      `Your wallet holds no unspent box at the creator's address (${creator.address.slice(0, 10)}…), which this contract requires for authorization.`
    );
  }
  return {
    ergoTreeHex: creator.ergoTreeHex,
    address: creator.address,
    authBox
  };
}

// ─── Core planner engine (quote + build share exact validation logic) ────────

interface PlanOutcome {
  readonly quote: ZcTxQuote;
  readonly build?: () => ZcBuiltTx;
}

async function planAction(
  action: ZcTxAction,
  deps: ZcTxDeps,
  mode: "quote" | "build",
  limits?: ZcTxLimits
): Promise<PlanOutcome> {
  const fresh = mode === "build";
  const [ctx, rawAddrs, rawUtxos] = await Promise.all([
    deps.getReadContext(fresh),
    deps.wallet.getAddresses(),
    deps.wallet.getUtxos(fresh)
  ]);

  const walletBook = indexWalletAddresses(rawAddrs, deps.wallet.network);
  const walletUtxos = rawUtxos.map(normalizeWalletUtxo);
  const height = await resolveHeight(deps, ctx.book);
  const h = BigInt(height);
  const ownTree = walletBook.changeTreeHex;
  const ownHash = walletBook.changeTreeHash;

  // Helper to wrap posting actions uniformly
  const finishPost = (params: {
    readonly actionName: string;
    readonly market: ZcMarket | null;
    readonly role: string;
    readonly box: TxOutputDraft;
    readonly terms: Record<string, unknown>;
    readonly warnings?: readonly string[];
    readonly extraFees?: readonly ZcTxFeeItem[];
  }): PlanOutcome => {
    const quote = computePostQuote({
      action: params.actionName,
      market: params.market,
      role: params.role,
      box: params.box,
      terms: params.terms,
      height,
      warnings: params.warnings,
      extraFees: params.extraFees
    });
    if (mode === "quote") return { quote };
    return {
      quote,
      build: () =>
        assemblePostTx({
          action: params.actionName,
          market: params.market,
          box: params.box,
          namedTreeHex: ownTree,
          walletUtxos,
          walletBook,
          height,
          quote,
          limits
        })
    };
  };

  // Helper to wrap spend actions uniformly
  const finishSpend = (params: {
    readonly actionName: string;
    readonly market: ZcMarket | null;
    readonly spend: ZcSpendDraft;
    readonly roles: readonly string[];
    readonly terms: Record<string, unknown>;
    readonly validThrough: bigint | null;
    readonly warnings?: readonly string[];
    readonly extraFees?: readonly ZcTxFeeItem[];
    readonly assetId?: string | null;
  }): PlanOutcome => {
    const quote = computeSpendQuote({
      action: params.actionName,
      market: params.market,
      spend: params.spend,
      roles: params.roles,
      terms: params.terms,
      walletBook,
      height,
      validThrough: params.validThrough,
      warnings: params.warnings,
      extraFees: params.extraFees
    });
    if (mode === "quote") return { quote };
    return {
      quote,
      build: () =>
        assembleSpendTx({
          action: params.actionName,
          market: params.market,
          spend: params.spend,
          walletUtxos,
          walletBook,
          height,
          quote,
          assetId: params.assetId ?? null,
          limits
        })
    };
  };

  switch (action.type) {
    // ─── 1. createOrder ─────────────────────────────────────────────────────
    case "createOrder": {
      const draft = buildDraftOrder(action.body, h);
      const ref = orderRefusal(draft, h);
      if (ref && !ref.includes("expired")) {
        throw new ZcTxRefusalError(ref);
      }
      const rule = liqRuleKind(draft.liqHash, draft.market);
      const ratio = rule === "oracle" && draft.payload.length > 0 ? draft.payload[0] : null;
      const guardRatio = fillRatio(draft);

      const matRes = orderMaturity(draft, h);
      const pRes = matRes.ok ? resolvePrincipal(draft, h, matRes.value) : null;
      const prospect =
        matRes.ok && pRes?.ok
          ? prospectBondTerms(draft, h, matRes.value, pRes.value)
          : null;
      const coverNow =
        ctx.book.oracle && prospect ? coverOfBond(prospect, ctx.book.oracle.price) : null;
      const under = ratio !== null && coverNow !== null && !atLeast(coverNow, ratio);
      const allow = action.body.allowLiquidatable === true;
      if (under && guardRatio === null && !allow) {
        throw new ZcTxRefusalError(
          "At the confirmed oracle price the collateral is already under the order's own liquidation ratio: a fill would start a bond anyone could liquidate at once. Add collateral or enable the fill guard."
        );
      }

      const box = buildOrderOutput(draft, ownHash, height);
      const warnings: string[] = [];
      if (guardRatio !== null && coverNow !== null && !atLeast(coverNow, guardRatio)) {
        warnings.push(
          "At the current oracle price the fill guard refuses fills; the order will wait until cover recovers."
        );
      }
      if (draft.mode === 0n) {
        const lastFill = bigMin(draft.expiry - 1n, draft.terms[3] - 2n);
        if (draft.terms[3] - lastFill < (draft.terms[3] - h) / 2n) {
          warnings.push(
            `A fill at height ${lastFill.toString()} leaves only ${(draft.terms[3] - lastFill).toString()} blocks to repay.`
          );
        }
      }

      const liqCross =
        ratio !== null && prospect
          ? crossingPrice(
              prospect.market,
              prospect.collateralErg,
              prospect.collateral,
              prospect.repayment,
              ratio
            )
          : null;
      const guardCross =
        guardRatio !== null && prospect
          ? crossingPrice(
              prospect.market,
              prospect.collateralErg,
              prospect.collateral,
              prospect.repayment,
              guardRatio
            )
          : null;

      return finishPost({
        actionName: "createOrder",
        market: draft.market,
        role: "order",
        box,
        warnings,
        terms: {
          contract: draft.script.kind,
          treeHash: draft.script.treeHash,
          liquidationHash: draft.liqHash,
          pricingHash: draft.pricingHash,
          guardHash: draft.guardHash,
          maturity: draft.mode === 0n ? Number(draft.terms[3]) : null,
          expiry: Number(draft.expiry),
          principal: draft.principal.toString(),
          repayment: draft.repayment.toString(),
          coverBps: coverNow ? Number(ratioBps(coverNow)) : null,
          liquidatesAtUsdPerErg: liqCross ? usdPerErg(liqCross[0]) : null,
          guardStopsAtUsdPerErg: guardCross ? usdPerErg(guardCross[0]) : null
        }
      });
    }

    // ─── 2. createOffer ─────────────────────────────────────────────────────
    case "createOffer": {
      const draft = buildDraftOffer(action.body, h);
      const box = buildOfferOutput(draft, ownHash);
      const warnings: string[] = [];
      if (batcherFee(draft) < MIN_BATCHING_FEE) {
        warnings.push("The batcher fee is under 0.002 ERG: no batcher will fill this offer.");
      }
      if (isTokenOffer(draft) && minFillBps(draft) > 100n) {
        warnings.push("The minimum fill percentage refuses small new loans.");
      }

      return finishPost({
        actionName: "createOffer",
        market: draft.market,
        role: "offer",
        box,
        warnings,
        terms: {
          contract: "LendOffer",
          policyHash: draft.policyHash,
          terms: draft.terms.map((t) => t.toString()),
          funding: draft.box.value.toString()
        }
      });
    }

    // ─── 3. createAsk ───────────────────────────────────────────────────────
    case "createAsk": {
      const tokenIdRaw =
        typeof action.body.tokenId === "string" ? action.body.tokenId.trim().toLowerCase() : "";
      if (/^[0-9a-f]{64}$/.test(tokenIdRaw)) {
        await ensureClaimOrigins(tokenIdRaw, ctx.resolver, height);
      }
      const m = matcherWithFreshOrigins(ctx);
      const draft = buildDraftAsk(action.body, m);
      const claimRes = m.claimOf(draft.token.tokenId);
      const claim = claimRes.ok ? claimRes.value : null;
      const liveBond = claim ? ctx.book.bonds.get(claim.asset)?.record ?? null : null;
      if (liveBond && ctx.book.oracle && belowOwnRatio(bondTermsOf(liveBond), ctx.book.oracle.price)) {
        throw new ZcTxRefusalError(
          "This bond is below its own liquidation ratio: liquidate it (which pays its holder the collateral) rather than selling it."
        );
      }

      const box = buildAskOutput(draft, ownHash);
      return finishPost({
        actionName: "createAsk",
        market: draft.market,
        role: "ask",
        box,
        terms: {
          contract: draft.script.kind,
          tokenId: draft.token.tokenId,
          units: draft.token.amount.toString(),
          bondId: claim?.asset ?? null,
          unitsPerBond: claim ? claim.whole.toString() : null,
          pricingHash: draft.pricingHash,
          terms: draft.terms.map((t) => t.toString())
        }
      });
    }

    // ─── 4. createLot ───────────────────────────────────────────────────────
    case "createLot": {
      const lot = buildDraftLot(action.body, h);
      const mToken = marketTokenId(lot.market);
      if (mToken && lot.items.some((t) => t.tokenId === mToken)) {
        throw new ZcTxRefusalError(`A lot paid in ${lot.market} cannot hold ${lot.market} itself.`);
      }
      const box = buildLotOutput(lot.market, lot.items, lot.erg, lot.terms, ownHash);
      return finishPost({
        actionName: "createLot",
        market: lot.market,
        role: "lot",
        box,
        terms: {
          contract: "LotAuction",
          market: lot.market,
          opening: lot.terms[0].toString(),
          floor: lot.terms[1].toString(),
          start: Number(lot.terms[2]),
          end: Number(lot.terms[3]),
          expiry: Number(lot.terms[4]),
          refundFeeNanoErg: lot.terms[5].toString()
        }
      });
    }

    // ─── 5. fractionalize ───────────────────────────────────────────────────
    case "fractionalize": {
      const asset = requireHex64(action.assetId, "bond assetId");
      const origin = await ensureOrigin(asset, ctx.resolver, height);
      if (!origin) {
        throw new ZcTxRefusalError(`${asset.slice(0, 10)}… was not minted by a standard ZC order.`);
      }
      if (origin.kind !== "Order" && origin.kind !== "PricedOrder") {
        throw new ZcTxRefusalError(`${asset.slice(0, 10)}… is not a bond unit.`);
      }
      if (!origin.market) {
        throw new ZcTxRefusalError("The bond's market could not be determined.");
      }
      const market = origin.market;
      const req = buildDraftShareRequest(action.body);
      const live = ctx.book.bonds.get(asset)?.record ?? null;
      const facts = live
        ? {
            market,
            asset,
            principal:
              marketTokenId(market) === null
                ? live.terms[1]
                : live.principalTokens[0]?.amount ?? 0n,
            repayment: live.repayment,
            start: live.start,
            maturity: live.maturity,
            rule: ruleFields(liqRuleKind(live.liqHash, market), live.terms.slice(7), live.liqHash)
          }
        : null;

      const metadata = sharesMetadata(market, req.auction, facts);
      const box = buildShareRequestOutput(
        asset,
        market,
        req.terms,
        req.auction !== null,
        metadata,
        ownHash
      );

      const buyers = req.auction
        ? ctx.book.offers.filter(
            (o) =>
              o.record.market === market &&
              buysShares(o.record) &&
              h + 1n < o.record.expiry &&
              req.auction!.floorBps >= o.record.terms[9] &&
              req.auction!.expiry <= o.record.terms[10]
          ).length
        : null;

      const warnings: string[] = [];
      if (req.auction === null) {
        warnings.push(
          "A plain fractional vault pays holders in kind after liquidation; lend offers do not buy plain shares."
        );
      }
      if (req.terms[0] !== SHARE_COUNT) {
        warnings.push(`Nonstandard share count: zcs1 standard uses ${SHARE_COUNT.toString()}.`);
      }

      return finishPost({
        actionName: "fractionalize",
        market,
        role: "mintRequest",
        box,
        warnings,
        extraFees: [
          feeItem("mint", req.terms[2], "locked"),
          feeItem("pull", req.terms[1], "locked")
        ],
        terms: {
          contract: req.auction ? "DutchAuctionMint" : "FractionalMint",
          bondId: asset,
          market,
          shares: req.terms[0].toString(),
          pullFeeNanoErg: req.terms[1].toString(),
          mintFeeNanoErg: req.terms[2].toString(),
          name: metadata[0],
          offersBuying: buyers
        }
      });
    }

    // ─── 6. createWrap ──────────────────────────────────────────────────────
    case "createWrap": {
      const w = buildDraftWrap(action.body);
      const held = walletHeld(walletUtxos, w.tokenId);
      const amount = w.amount ?? held;
      if (held <= 0n) {
        throw new ZcTxRefusalError(`Your wallet holds none of token ${w.tokenId.slice(0, 10)}….`);
      }
      if (amount < 1n || amount > held) {
        throw new ZcTxRefusalError(
          `Wrap amount must be between 1 and ${held.toString()} of ${w.tokenId.slice(0, 10)}….`
        );
      }
      const box = buildWrapRequestOutput(
        w.tokenId,
        amount,
        w.mintFee,
        w.refreshReserve,
        ownHash
      );
      return finishPost({
        actionName: "createWrap",
        market: null,
        role: "wrapRequest",
        box,
        extraFees: [
          feeItem("mint", w.mintFee, "locked"),
          feeItem("wrapRefreshReserve", w.refreshReserve, "locked")
        ],
        terms: {
          contract: "WrapMint",
          tokenId: w.tokenId,
          amount: amount.toString(),
          receiptName: receiptMetadata(w.tokenId, amount)[0],
          mintFeeNanoErg: w.mintFee.toString(),
          refreshReserveNanoErg: w.refreshReserve.toString(),
          refreshes: Number(w.refreshReserve / REFRESH_BOUNTY)
        }
      });
    }

    // ─── 7. cancel ──────────────────────────────────────────────────────────
    case "cancel": {
      const id = requireHex64(action.boxId, "boxId");
      const box = await readSingleBox(ctx, id, fresh);
      const record = readZcBox(box);
      if (!record) {
        throw new ZcTxRefusalError(`Box ${id.slice(0, 10)}… is not a recognized SigmaFi V2 box.`);
      }
      let creatorHash: string;
      let expired = false;
      switch (record.recordType) {
        case "order":
          creatorHash = record.borrowerHash;
          expired = h >= record.expiry;
          break;
        case "offer":
          creatorHash = record.ownerHash;
          expired = h >= record.expiry;
          break;
        case "ask":
          creatorHash = record.sellerHash;
          expired = h >= record.expiry;
          break;
        case "lot":
          creatorHash = record.sellerHash;
          expired = h >= record.expiry;
          break;
        case "shareRequest":
          creatorHash = record.ownerHash;
          break;
        case "wrapRequest":
          creatorHash = record.ownerHash;
          break;
        default:
          throw new ZcTxRefusalError(`A ${record.script.kind} box cannot be cancelled.`);
      }

      const auth = requireCreatorAuth(
        creatorHash,
        walletBook,
        walletUtxos,
        `Box ${id.slice(0, 10)}… was not created by the connected Nautilus wallet.`
      );
      const warnings = expired
        ? ["This box is past its expiry: anyone may refund it first and keep its expiry fee."]
        : [];

      const quote: ZcTxQuote = {
        action: "cancel",
        market: null,
        paysNanoErgs: TX_FEE,
        receivesNanoErgs: bigMax(0n, box.value - TX_FEE),
        paysTokens: [],
        receivesTokens: box.assets,
        fees: [feeItem("miner", TX_FEE, "spent")],
        creates: [],
        terms: {
          boxId: id,
          contract: record.script.kind
        },
        validFrom: height,
        validThrough: null,
        warnings,
        refusals: [],
        requires: [],
        suggestedLimits: {}
      };

      if (mode === "quote") return { quote };
      return {
        quote,
        build: () =>
          assembleCancelTx({
            box,
            authBox: auth.authBox,
            refundTreeHex: auth.ergoTreeHex,
            walletBook,
            height,
            quote
          })
      };
    }

    // ─── 8. fillOrder ───────────────────────────────────────────────────────
    case "fillOrder": {
      const id = requireHex64(action.boxId, "order boxId");
      const orderBox = await readSingleBox(ctx, id, fresh);
      const decoded = readZcBox(orderBox);
      if (!decoded || decoded.recordType !== "order") {
        throw new ZcTxRefusalError(`Box ${id.slice(0, 10)}… is not a ZC borrow order.`);
      }
      const order: ZcOrder = decoded;
      const ordRef = orderRefusal(order, h);
      if (ordRef) throw new ZcTxRefusalError(ordRef);

      const chosen =
        action.maturity !== undefined && action.maturity !== null
          ? BigInt(action.maturity)
          : null;
      const reserve = action.reserveNanoErg ?? DEFAULT_RESERVE;
      if (reserve < DEFAULT_RESERVE) {
        throw new ZcTxRefusalError(
          `Liquidation fee reserve must be at least ${DEFAULT_RESERVE.toString()} nanoERG (0.05 ERG).`
        );
      }
      if (chosen !== null && !isWindowOrder(order)) {
        throw new ZcTxRefusalError("Only a window order lets the lender choose maturity.");
      }

      const matRes = orderMaturity(order, h, chosen);
      if (!matRes.ok) throw new ZcTxRefusalError(matRes.error);
      const maturity = matRes.value;

      const pRes = resolvePrincipal(order, h, maturity);
      if (!pRes.ok) throw new ZcTxRefusalError(pRes.error);
      const principal = pRes.value;

      const filled = resolveOrderPrincipal(order, principal);
      const prospect = prospectBondTerms(order, h, maturity, principal);
      const oracle = order.guardHash !== null ? requireOracle(ctx.book) : null;
      const gRef = guardRefusal(order, prospect, oracle, h);
      if (gRef) throw new ZcTxRefusalError(`The order's fill guard refuses this fill: ${gRef}`);

      checkCoverSafety(
        ctx.book,
        prospect,
        action.allowLiquidatable,
        "The bond would start",
        "Wait for the oracle price to recover or for the borrower to add collateral."
      );

      let freshOracleBox: ChainBox | null = null;
      if (oracle) {
        freshOracleBox = await readSingleBox(ctx, oracle.box.boxId, fresh);
      }

      const borrowerTree = await resolvePartyScript(
        order,
        walletBook,
        ctx.resolver,
        height,
        "borrower"
      );

      const spend = buildFillOrderSpend({
        order: filled,
        orderBox,
        borrowerTree,
        lenderTree: ownTree,
        start: h,
        maturity,
        feeReserve: reserve,
        oracleBox: freshOracleBox
      });

      const m = matcherWithFreshOrigins(ctx);
      const competing = m
        .offerStates(order.market)
        .filter((s) => m.evaluate(s, orderSourceOf(openOf(order, false))).ok)
        .slice(0, MAX_OFFERS)
        .map((s) => s.boxId);

      const cov = ctx.book.oracle ? coverOfBond(prospect, ctx.book.oracle.price) : null;
      const win = orderWindow(order);
      const yb = yieldBps(order.repayment, principal, maturity - (h + 1n));
      const validThrough = order.priced
        ? h + QUOTE_BLOCKS
        : bigMin(order.expiry - 2n, maturity - 3n);

      return finishSpend({
        actionName: "fillOrder",
        market: order.market,
        spend,
        roles: ["unit", "bond", "principal"],
        validThrough,
        assetId: id,
        extraFees: [feeItem("liquidationReserve", reserve, "locked")],
        terms: {
          assetId: id,
          market: order.market,
          principal: principal.toString(),
          repayment: order.repayment.toString(),
          start: height,
          maturity: Number(maturity),
          yieldBps: yb !== null ? Number(yb) : null,
          coverBps: cov ? Number(ratioBps(cov)) : null,
          window: win ? { from: Number(h + win[0]), to: Number(h + win[1]) } : null,
          feeReserveNanoErg: reserve.toString(),
          competingOffers: competing.length
        }
      });
    }

    // ─── 9. buyAsk ──────────────────────────────────────────────────────────
    case "buyAsk": {
      const id = requireHex64(action.boxId, "ask boxId");
      const askBox = await readSingleBox(ctx, id, fresh);
      const decoded = readZcBox(askBox);
      if (!decoded || decoded.recordType !== "ask") {
        throw new ZcTxRefusalError(`Box ${id.slice(0, 10)}… is not a ZC resale ask.`);
      }
      const ask: ZcAsk = decoded;
      const units = action.units ?? ask.token.amount;
      const fRef = fillRefusal(ask, units, h);
      if (fRef) throw new ZcTxRefusalError(fRef);

      const token = ask.token.tokenId;
      await ensureClaimOrigins(token, ctx.resolver, height);
      const m = matcherWithFreshOrigins(ctx);
      const claimRes = m.claimOf(token);

      if (!claimRes.ok && ctx.book.shareVaults.has(token)) {
        throw new ZcTxRefusalError(
          `${token.slice(0, 10)}… sits in a share vault naming a bond, but no standard share mint minted it: anyone can create such a vault, so it claims nothing.`
        );
      }

      const claim = claimRes.ok ? claimRes.value : null;
      const liveBond = claim ? ctx.book.bonds.get(claim.asset)?.record ?? null : null;

      if (ask.priced && !isYieldAsk(ask)) {
        throw new ZcTxRefusalError(
          "This ask names a pricing expression not supported by zcs1."
        );
      }

      let pricedBond: ZcBond | null = null;
      if (ask.priced) {
        const found = ask.pricedAsset ? ctx.book.bonds.get(ask.pricedAsset)?.record ?? null : null;
        if (!found) {
          throw new ZcTxRefusalError(
            "The bond this yield ask prices is no longer live: yield asks sell only while their bond is live."
          );
        }
        pricedBond = found;
      }

      const priceRes = askPrice(ask, units, pricedBond ? bondTermsOf(pricedBond) : null, h);
      if (!priceRes.ok) throw new ZcTxRefusalError(priceRes.error);
      const price = priceRes.value;

      if (liveBond) {
        checkCoverSafety(
          ctx.book,
          bondTermsOf(liveBond),
          action.allowLiquidatable,
          `Bond ${liveBond.boxId.slice(0, 10)}… is`,
          "Liquidate it instead: its holder then claims the collateral."
        );
      }

      const oracle = askSaleGuard(ask) !== null ? requireOracle(ctx.book) : null;
      if (pricedBond) {
        const sgRef = saleGuardRefusal(ask, bondTermsOf(pricedBond), oracle, h);
        if (sgRef) throw new ZcTxRefusalError(`The ask's sale guard refuses this sale: ${sgRef}`);
      }

      // Fetch fresh data inputs if needed
      const dataIds: string[] = [];
      if (pricedBond) dataIds.push(pricedBond.boxId);
      if (oracle) dataIds.push(oracle.box.boxId);
      const dataMap = dataIds.length > 0 ? await readBoxesForTx(ctx, dataIds, fresh) : new Map();
      const freshBondBox = pricedBond ? dataMap.get(pricedBond.boxId) ?? null : null;
      const freshOracleBox = oracle ? dataMap.get(oracle.box.boxId) ?? null : null;

      const sellerTree = await resolvePartyScript(ask, walletBook, ctx.resolver, height, "seller");
      const spend = buildBuyAskSpend({
        ask,
        askBox,
        sellerTree,
        units,
        paid: price,
        bondBox: freshBondBox,
        oracleBox: freshOracleBox
      });

      const warnings = claimRes.ok
        ? []
        : [`This token is not a proven bond unit or shares (${claimRes.error}): it claims nothing.`];

      const yb =
        liveBond && claim
          ? yieldBps(
              (liveBond.repayment * units) / claim.whole,
              price,
              liveBond.maturity - (h + 1n)
            )
          : null;

      return finishSpend({
        actionName: "buyAsk",
        market: ask.market,
        spend,
        roles: ["payout", "continuation"],
        validThrough: ask.priced ? h + QUOTE_BLOCKS : ask.expiry - 2n,
        warnings,
        terms: {
          tokenId: token,
          units: units.toString(),
          price: price.toString(),
          market: ask.market,
          bondId: claim?.asset ?? null,
          unitsPerBond: claim ? claim.whole.toString() : null,
          yieldBps: yb !== null ? Number(yb) : null
        }
      });
    }

    // ─── 10. buyLot ─────────────────────────────────────────────────────────
    case "buyLot": {
      const id = requireHex64(action.boxId, "lot boxId");
      const lotBox = await readSingleBox(ctx, id, fresh);
      const decoded = readZcBox(lotBox);
      if (!decoded || decoded.recordType !== "lot") {
        throw new ZcTxRefusalError(`Box ${id.slice(0, 10)}… is not a ZC lot auction.`);
      }
      const lot: ZcLot = decoded;
      if (!lotValid(lot)) {
        throw new ZcTxRefusalError(
          "This lot's terms are malformed, so only its seller can cancel it."
        );
      }
      if (h + 1n >= lot.expiry) {
        throw new ZcTxRefusalError(`This lot expired at height ${lot.expiry.toString()}.`);
      }

      const price = lotPrice(lot, h);
      const sellerTree = await resolvePartyScript(lot, walletBook, ctx.resolver, height, "seller");
      const spend = buildBuyLotSpend({
        lot,
        lotBox,
        sellerTree,
        price
      });

      return finishSpend({
        actionName: "buyLot",
        market: lot.market,
        spend,
        roles: ["payout"],
        validThrough: lot.expiry - 2n,
        terms: {
          price: price.toString(),
          market: lot.market,
          items: lot.box.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
          nanoErg: marketTokenId(lot.market) === null ? "0" : lot.box.value.toString()
        }
      });
    }

    // ─── 11. repay ──────────────────────────────────────────────────────────
    case "repay": {
      const { bond, box: bondBox } = await readLiveBond(ctx, action.assetId, fresh);
      if (h + 1n >= bond.maturity) {
        throw new ZcTxRefusalError(
          `Bond matures at height ${bond.maturity.toString()}: repayment is closed and liquidation is open.`
        );
      }
      const most = repayableFromCollateral(bond);
      const kept =
        action.fromCollateral === "max"
          ? most
          : action.fromCollateral !== undefined && action.fromCollateral !== null
            ? action.fromCollateral
            : 0n;
      if (kept < 0n || kept > most) {
        throw new ZcTxRefusalError(
          `fromCollateral must be between 0 and ${most.toString()}.`
        );
      }

      let borrowerTree: string;
      let authBox: ChainBox | null = null;
      if (kept > 0n) {
        const auth = requireCreatorAuth(
          bond.borrowerHash,
          walletBook,
          walletUtxos,
          "Only the borrower may repay from the bond's collateral."
        );
        borrowerTree = auth.ergoTreeHex;
        authBox = auth.authBox;
      } else {
        borrowerTree = await resolvePartyScript(bond, walletBook, ctx.resolver, height, "borrower");
      }

      const spend = buildRepaySpend({
        bond,
        bondBox,
        borrowerTree,
        kept,
        authBox
      });

      const warnings =
        bond.maturity - h <= 2n
          ? [
              "Two blocks or fewer remain: if repayment lands at or after maturity it will fail and the bond can be liquidated."
            ]
          : [];

      return finishSpend({
        actionName: "repay",
        market: bond.market,
        spend,
        roles: ["vault", "collateral"],
        validThrough: bond.maturity - 2n,
        warnings,
        extraFees: [feeItem("liquidationReserve", bond.feeReserve, "refundable")],
        terms: {
          assetId: bond.asset,
          bondBoxId: bond.boxId,
          repayment: bond.repayment.toString(),
          fromCollateral: kept.toString(),
          maturity: Number(bond.maturity),
          market: bond.market,
          collateralBackNanoErg: spend.outputs[1].value.toString()
        }
      });
    }

    // ─── 12. extinguish ─────────────────────────────────────────────────────
    case "extinguish": {
      const { bond, box: bondBox } = await readLiveBond(ctx, action.assetId, fresh);
      const auth = requireCreatorAuth(
        bond.borrowerHash,
        walletBook,
        walletUtxos,
        "Only the borrower may extinguish this bond.",
        bond.asset
      );

      if (walletHeld(walletUtxos, bond.asset) < 1n) {
        let hint = "";
        for (const sv of ctx.book.shareVaults.values()) {
          if (sv.record.bondAsset === bond.asset && walletHeld(walletUtxos, sv.record.shareId) > 0n) {
            hint = `; your wallet holds shares (${sv.record.shareId.slice(0, 10)}…) — final-claim all ${sv.record.outstanding.toString()} shares first to recover the whole bond unit`;
            break;
          }
        }
        throw new ZcTxRefusalError(
          `Your wallet does not hold bond unit ${bond.asset.slice(0, 10)}…${hint}.`
        );
      }

      const spend = buildExtinguishSpend({
        bond,
        bondBox,
        authBox: auth.authBox,
        toTree: auth.ergoTreeHex
      });

      const warnings: string[] = [];
      if (h >= bond.maturity) {
        warnings.push(
          "This bond has reached maturity and can be liquidated by anyone: extinguishing races liquidation."
        );
      } else if (ctx.book.oracle && belowOwnRatio(bondTermsOf(bond), ctx.book.oracle.price)) {
        warnings.push(
          "This bond is under its liquidation ratio and can be liquidated by anyone: extinguishing races liquidation."
        );
      }

      return finishSpend({
        actionName: "extinguish",
        market: null,
        spend,
        roles: [],
        validThrough: null,
        warnings,
        terms: {
          assetId: bond.asset,
          bondBoxId: bond.boxId,
          market: bond.market,
          repayment: bond.repayment.toString(),
          feeReserveNanoErg: bond.feeReserve.toString()
        }
      });
    }

    // ─── 13. recollateralize ────────────────────────────────────────────────
    case "recollateralize": {
      const { bond, box: bondBox } = await readLiveBond(ctx, action.assetId, fresh);
      const erg = action.nanoErg ?? 0n;
      const added: ChainAsset[] = (action.tokens ?? []).map((t) => ({
        tokenId: requireHex64(t.tokenId, "collateral tokenId"),
        amount: t.amount
      }));
      if (erg < 0n) throw new ZcTxRefusalError("nanoErg cannot be negative.");
      if (erg === 0n && added.length === 0) {
        throw new ZcTxRefusalError("Specify nanoErg or tokens to add as collateral.");
      }
      const uniqueTokIds = new Set(added.map((t) => t.tokenId));
      if (uniqueTokIds.size !== added.length) {
        throw new ZcTxRefusalError("List each collateral token at most once.");
      }
      const mToken = marketTokenId(bond.market);
      for (const t of added) {
        if (t.amount <= 0n) {
          throw new ZcTxRefusalError("Added token amounts must be positive.");
        }
        const alreadyHeld = bond.collateral.some((c) => c.tokenId === t.tokenId);
        if (!alreadyHeld && t.tokenId !== mToken) {
          throw new ZcTxRefusalError(
            `This bond does not hold ${t.tokenId.slice(0, 10)}…: it accepts only ERG, more of its existing tokens, or its repayment token.`
          );
        }
      }
      if (h + 1n >= bond.maturity) {
        throw new ZcTxRefusalError(
          `Bond matures at height ${bond.maturity.toString()}: it can no longer take collateral.`
        );
      }
      const from = BigInt(bond.box.creationHeight) + RECOLLATERALIZE_WAIT;
      if (h < from) {
        throw new ZcTxRefusalError(
          `This bond last moved at height ${bond.box.creationHeight}; it can take collateral again from height ${from.toString()}.`
        );
      }

      const auth = requireCreatorAuth(
        bond.borrowerHash,
        walletBook,
        walletUtxos,
        "Only the borrower may add collateral to this bond."
      );

      const spend = buildRecollateralizeSpend({
        bond,
        bondBox,
        authBox: auth.authBox,
        erg,
        added,
        height
      });

      const afterOut = spend.outputs[0];
      const coverAfter = ctx.book.oracle
        ? coverOfBond(
            {
              ...bondTermsOf(bond),
              collateralErg: afterOut.value - bond.feeReserve,
              collateral: afterOut.assets.slice(1)
            },
            ctx.book.oracle.price
          )
        : null;

      return finishSpend({
        actionName: "recollateralize",
        market: bond.market,
        spend,
        roles: ["bond"],
        validThrough: bond.maturity - 2n,
        terms: {
          assetId: bond.asset,
          bondBoxId: bond.boxId,
          addsNanoErg: erg.toString(),
          addsTokens: added.map((t) => ({ tokenId: t.tokenId, amount: t.amount.toString() })),
          coverBpsAfter: coverAfter ? Number(ratioBps(coverAfter)) : null,
          nextFrom: Number(h + RECOLLATERALIZE_WAIT)
        }
      });
    }

    // ─── 14. liquidate ──────────────────────────────────────────────────────
    case "liquidate": {
      const { bond, box: bondBox } = await readLiveBond(ctx, action.assetId, fresh);
      const matured = h >= bond.maturity;
      const rule = liqRuleKind(bond.liqHash, bond.market);
      let oracle: ZcOracle | null = null;

      if (rule === "other") {
        throw new ZcTxRefusalError(
          "This bond names a liquidation expression not supported by zcs1."
        );
      }
      if (!matured) {
        if (rule === "maturity") {
          throw new ZcTxRefusalError(
            `This bond matures at height ${bond.maturity.toString()}; it can be liquidated from then on.`
          );
        }
        const payload = bond.terms.slice(7);
        if (payload.length < 2) {
          throw new ZcTxRefusalError(
            `This bond has no oracle terms; it can be liquidated from maturity at height ${bond.maturity.toString()}.`
          );
        }
        const o = requireOracle(ctx.book);
        if (!freshOracle(o, payload[1], h)) {
          throw new ZcTxRefusalError(
            `The oracle price is from height ${o.box.creationHeight}, older than the bond's ${payload[1].toString()} block limit.`
          );
        }
        if (!belowOwnRatio(bondTermsOf(bond), o.price)) {
          const cov = coverOfBond(bondTermsOf(bond), o.price);
          const bps = cov ? ratioBps(cov).toString() : "0";
          throw new ZcTxRefusalError(
            `This bond is at ${bps} bps cover, not below its ${payload[0].toString()} bps liquidation ratio.`
          );
        }
        oracle = o;
      }

      const exprBytes =
        rule === "oracle"
          ? getZcExpressionBytes("OracleLiquidation", bond.market)
          : getZcExpressionBytes("MaturityLiquidation", null);
      const freshOracleBox = oracle ? await readSingleBox(ctx, oracle.box.boxId, fresh) : null;

      const spend = buildLiquidateSpend({
        bond,
        bondBox,
        expressionBytesHex: hex.encode(exprBytes),
        oracleBox: freshOracleBox
      });

      const warnings =
        bond.feeReserve <= TX_FEE
          ? ["The bond's fee reserve does not cover the miner fee: your wallet pays the difference."]
          : [];
      const cov = ctx.book.oracle ? coverOfBond(bondTermsOf(bond), ctx.book.oracle.price) : null;

      return finishSpend({
        actionName: "liquidate",
        market: bond.market,
        spend,
        roles: ["vault"],
        validThrough: oracle ? h + 1n : null,
        warnings,
        terms: {
          assetId: bond.asset,
          bondBoxId: bond.boxId,
          rule,
          matured,
          feeReserveNanoErg: bond.feeReserve.toString(),
          coverBps: cov ? Number(ratioBps(cov)) : null
        }
      });
    }

    // ─── 15. claim ──────────────────────────────────────────────────────────
    case "claim": {
      const token = requireHex64(action.tokenId, "claim tokenId");
      const origin = await ensureClaimOrigins(token, ctx.resolver, height);
      if (!origin) {
        throw new ZcTxRefusalError(
          `${token.slice(0, 10)}… is not a proven SigmaFi bond unit or bond share token.`
        );
      }

      if (origin.kind === "Order" || origin.kind === "PricedOrder") {
        if (ctx.book.bonds.has(token)) {
          throw new ZcTxRefusalError(
            "This bond is still live: it has not been repaid or liquidated yet."
          );
        }
        const settlements: ZcSettlement[] = ctx.book.allOpen
          .filter(
            (o) =>
              !o.pending &&
              o.record.recordType === "settlement" &&
              o.record.asset === token
          )
          .map((o) => o.record as ZcSettlement);

        if (settlements.length === 0) {
          throw new ZcTxRefusalError(
            "No confirmed settlement vault holds this bond's reserve yet."
          );
        }
        if (walletHeld(walletUtxos, token) < 1n) {
          throw new ZcTxRefusalError(`Your wallet does not hold bond unit ${token.slice(0, 10)}….`);
        }

        const boxMap = await readBoxesForTx(
          ctx,
          settlements.map((s) => s.boxId),
          fresh
        );
        const settlementBoxes = settlements.map((s) => boxMap.get(s.boxId)!);
        const spend = buildClaimUnitSpend({
          asset: token,
          settlementBoxes,
          toTree: ownTree
        });

        return finishSpend({
          actionName: "claim",
          market: null,
          spend,
          roles: [],
          validThrough: null,
          terms: {
            tokenId: token,
            kind: "bondUnit",
            final: true,
            liquidated: settlements.some((s) => s.liquidated),
            settlements: settlements.map((s) => s.boxId)
          }
        });
      }

      if (origin.kind === "FractionalMint" || origin.kind === "DutchAuctionMint") {
        const vaultOpen = ctx.book.shareVaults.get(token);
        if (!vaultOpen) {
          throw new ZcTxRefusalError(
            `No share vault holds the reserve of ${token.slice(0, 10)}….`
          );
        }
        const vaultBox = await readSingleBox(ctx, vaultOpen.boxId, fresh);
        const decoded = readZcBox(vaultBox);
        if (!decoded || decoded.recordType !== "shareVault") {
          throw new ZcTxConflictError("Share vault box moved or was spent.");
        }
        const vault: ZcShareVault = decoded;

        const m = matcherWithFreshOrigins(ctx);
        const claimRes = m.claimOf(token);
        if (!claimRes.ok) {
          throw new ZcTxRefusalError(`These shares are not proven: ${claimRes.error}`);
        }

        const held = walletHeld(walletUtxos, token);
        if (held <= 0n) {
          throw new ZcTxRefusalError(`Your wallet holds none of share token ${token.slice(0, 10)}….`);
        }
        const burned = action.units ?? held;
        if (burned < 1n || burned > held) {
          throw new ZcTxRefusalError(
            `Claim between 1 and ${held.toString()} shares.`
          );
        }
        const finalClaim = burned >= vault.outstanding;
        if (finalClaim && held < vault.outstanding) {
          throw new ZcTxRefusalError(
            `A final claim burns all ${vault.outstanding.toString()} outstanding shares.`
          );
        }
        if (!finalClaim && vault.holding) {
          throw new ZcTxRefusalError(
            "The bond has not settled into the share vault yet: run Pull first, or make a final claim with 100% of shares.",
            ctx.book.settlements.has(vault.bondAsset) ? ["pull"] : []
          );
        }
        if (!finalClaim && auctionOpen(vault) && h < claimableFrom(vault)) {
          throw new ZcTxRefusalError(
            `The vault's liquidation auction runs until height ${claimableFrom(vault).toString()}; partial claims wait for it.`,
            ["auction"]
          );
        }

        const spend = buildClaimSharesSpend({
          vault,
          vaultBox,
          burned,
          toTree: ownTree
        });

        const warnings: string[] = [];
        if (!finalClaim) {
          for (const t of vault.box.assets.slice(1)) {
            if ((t.amount * burned) / vault.outstanding === 0n) {
              const minShares = (vault.outstanding + t.amount - 1n) / t.amount;
              warnings.push(
                `This claim rounds to 0 of token ${t.tokenId.slice(0, 10)}… (${t.amount.toString()} held); claim at least ${minShares.toString()} shares to receive some.`
              );
            }
          }
        }

        return finishSpend({
          actionName: "claim",
          market: null,
          spend,
          roles: ["payout", "vault"],
          validThrough: null,
          warnings,
          terms: {
            tokenId: token,
            kind: "shares",
            final: finalClaim,
            units: burned.toString(),
            outstanding: vault.outstanding.toString(),
            vaultBoxId: vault.boxId
          }
        });
      }

      throw new ZcTxRefusalError(`${token.slice(0, 10)}… is not a bond unit or bond shares.`);
    }

    // ─── 16. mint ───────────────────────────────────────────────────────────
    case "mint": {
      const id = requireHex64(action.boxId, "mint request boxId");
      const reqBox = await readSingleBox(ctx, id, fresh);
      const decoded = readZcBox(reqBox);

      if (decoded?.recordType === "shareRequest") {
        const req: ZcShareRequest = decoded;
        const [n, pullFee, mintFee] = req.terms;
        if (
          n < 1n ||
          n > 1_000_000_000n ||
          pullFee < MIN_BATCHING_FEE ||
          mintFee < MIN_BATCHING_FEE ||
          pullFee > reqBox.value ||
          mintFee > reqBox.value - pullFee
        ) {
          throw new ZcTxRefusalError(
            "This share mint request's terms are outside contract bounds, so only its owner can cancel it."
          );
        }

        let dutchState: {
          readonly stateBox: ChainBox;
          readonly repayment: bigint;
          readonly settledBondBytes: Uint8Array | null;
        } | null = null;

        if (req.dutch !== null) {
          const liveBond = ctx.book.bonds.get(req.bondAsset)?.record ?? null;
          const settled = ctx.book.settlements.get(req.bondAsset)?.record ?? null;
          if (liveBond) {
            const stateBox = await readSingleBox(ctx, liveBond.boxId, fresh);
            dutchState = {
              stateBox,
              repayment: liveBond.repayment,
              settledBondBytes: null
            };
          } else if (settled) {
            const stateBox = await readSingleBox(ctx, settled.boxId, fresh);
            const spentMap = await ctx.client.fetchBoxesByIds([settled.bondBoxId]);
            const spentBox = spentMap.get(settled.bondBoxId.toLowerCase());
            if (!spentBox) {
              throw new ZcTxRefusalError(
                "Could not fetch the settled bond box required to prove repayment for Dutch share minting."
              );
            }
            const spentRec = readZcBox(spentBox);
            if (!spentRec || spentRec.recordType !== "bond") {
              throw new ZcTxRefusalError("The settled bond box could not be decoded as a bond.");
            }
            dutchState = {
              stateBox,
              repayment: spentRec.repayment,
              settledBondBytes: serializeChainBoxBytes(spentBox)
            };
          } else {
            throw new ZcTxRefusalError(
              `No live bond or settlement holds the reserve of ${req.bondAsset.slice(0, 10)}….`
            );
          }
        }

        const ownerTree = await resolvePartyScript(
          req,
          walletBook,
          ctx.resolver,
          height,
          "share owner"
        );
        const spend = buildMintSharesSpend({
          req,
          reqBox,
          ownerTree,
          dutchState
        });

        return finishSpend({
          actionName: "mint",
          market: null,
          spend,
          roles: ["shares", "vault"],
          validThrough: null,
          assetId: req.shareId,
          extraFees: [feeItem("mint", mintFee, "earned")],
          terms: {
            kind: "shares",
            requestBoxId: id,
            shareTokenId: req.shareId,
            shares: n.toString(),
            bondId: req.bondAsset,
            mintFeeNanoErg: mintFee.toString()
          }
        });
      }

      if (decoded?.recordType === "wrapRequest") {
        const req: ZcWrapRequest = decoded;
        if (req.mintFee < MIN_BATCHING_FEE || req.mintFee > reqBox.value - 2n * MIN_BOX) {
          throw new ZcTxRefusalError(
            "This wrap request's mint fee leaves too little for receipt and vault: only its owner can cancel it."
          );
        }
        if (req.mintFee < TX_FEE) {
          throw new ZcTxRefusalError("The wrap request's mint fee does not cover the miner fee.");
        }
        const ownerTree = await resolvePartyScript(
          req,
          walletBook,
          ctx.resolver,
          height,
          "wrap owner"
        );
        const spend = buildMintWrapSpend({
          req,
          reqBox,
          ownerTree
        });

        return finishSpend({
          actionName: "mint",
          market: null,
          spend,
          roles: ["receipt", "vault"],
          validThrough: null,
          assetId: req.receiptId,
          extraFees: [feeItem("mint", req.mintFee, "earned")],
          terms: {
            kind: "wrap",
            requestBoxId: id,
            receiptId: req.receiptId,
            tokenId: req.wrapped.tokenId,
            amount: req.wrapped.amount.toString(),
            mintFeeNanoErg: req.mintFee.toString()
          }
        });
      }

      throw new ZcTxRefusalError(
        `Box ${id.slice(0, 10)}… is not a pending share or wrap mint request.`
      );
    }

    // ─── 17. pull ───────────────────────────────────────────────────────────
    case "pull": {
      const id = requireHex64(action.boxId, "vault boxId");
      const vaultBox = await readSingleBox(ctx, id, fresh);
      const decoded = readZcBox(vaultBox);
      if (!decoded || decoded.recordType !== "shareVault") {
        throw new ZcTxRefusalError(`Box ${id.slice(0, 10)}… is not a share vault.`);
      }
      const vault: ZcShareVault = decoded;
      if (!vault.holding) {
        throw new ZcTxRefusalError("This share vault has already pulled its bond's settlement.");
      }
      if (vault.pullFee < 0n || vault.pullFee > vaultBox.value) {
        throw new ZcTxRefusalError("The share vault's pull fee is out of bounds.");
      }

      const sourceOpen = ctx.book.settlements.get(vault.bondAsset);
      if (!sourceOpen) {
        throw new ZcTxRefusalError(
          `Bond ${vault.bondAsset.slice(0, 10)}… has not been repaid or liquidated yet.`
        );
      }
      const sourceBox = await readSingleBox(ctx, sourceOpen.boxId, fresh);
      const sourceRec = readZcBox(sourceBox);
      if (!sourceRec || sourceRec.recordType !== "settlement") {
        throw new ZcTxConflictError("Settlement vault box moved or was spent.");
      }

      const { spend, nextState } = buildPullSpend({
        vault,
        vaultBox,
        source: sourceRec,
        sourceBox,
        height: h
      });

      return finishSpend({
        actionName: "pull",
        market: null,
        spend,
        roles: ["vault"],
        validThrough: null,
        extraFees: [feeItem("pull", vault.pullFee, "earned")],
        terms: {
          vaultBoxId: id,
          bondId: vault.bondAsset,
          settlementBoxId: sourceRec.boxId,
          liquidated: sourceRec.liquidated,
          state: nextState,
          pullFeeNanoErg: vault.pullFee.toString()
        }
      });
    }

    // ─── 18. buyVault ───────────────────────────────────────────────────────
    case "buyVault": {
      const id = requireHex64(action.boxId, "vault boxId");
      const vaultBox = await readSingleBox(ctx, id, fresh);
      const decoded = readZcBox(vaultBox);
      if (!decoded || decoded.recordType !== "shareVault") {
        throw new ZcTxRefusalError(`Box ${id.slice(0, 10)}… is not a share vault.`);
      }
      const vault: ZcShareVault = decoded;
      if (!auctionOpen(vault)) {
        throw new ZcTxRefusalError("This share vault does not have an open auction.");
      }
      if (vault.auction[3] < 1n) {
        throw new ZcTxRefusalError("This auction has no positive duration.");
      }
      const excess = excessAuction(vault);
      const end = vault.auction[6] + vault.auction[3];
      if (excess && (excessPrice(vault, h) === null || h + 1n >= end)) {
        throw new ZcTxRefusalError(
          `This excess auction's price reaches zero at height ${end.toString()}: share holders claim the lot in kind.`
        );
      }

      const market = marketByTokenId(vaultCurrency(vault));
      if (!market) {
        throw new ZcTxRefusalError("This vault's currency is not a supported market.");
      }

      const spend = buildBuyFromVaultSpend({
        vault,
        vaultBox,
        height: h
      });

      const before = currencyHeld(vault);
      const mToken = marketTokenId(market);
      const outBox = spend.outputs[0];
      const after =
        mToken === null
          ? outBox.value
          : outBox.assets
              .filter((a) => a.tokenId === mToken)
              .reduce((acc, a) => acc + a.amount, 0n);

      return finishSpend({
        actionName: "buyVault",
        market,
        spend,
        roles: ["vault"],
        validThrough: excess ? end - 2n : vault.auction[6] + vault.auction[4],
        terms: {
          vaultBoxId: id,
          kind: excess ? "excess" : "floor",
          market,
          pays: (after - before).toString(),
          vaultHoldsAfter: after.toString()
        }
      });
    }

    // ─── 19. unwrap ─────────────────────────────────────────────────────────
    case "unwrap": {
      const receipt = requireHex64(action.receiptId, "receiptId");
      const vaultOpen = ctx.book.wrapVaults.get(receipt);
      if (!vaultOpen) {
        throw new ZcTxRefusalError(
          `No custody wrap vault holds the reserve of receipt ${receipt.slice(0, 10)}….`
        );
      }
      const origin = await ensureOrigin(receipt, ctx.resolver, height);
      if (!origin || origin.kind !== "WrapMint") {
        throw new ZcTxRefusalError(`${receipt.slice(0, 10)}… is not a proven wrap receipt.`);
      }
      if (walletHeld(walletUtxos, receipt) < 1n) {
        throw new ZcTxRefusalError(
          `Your wallet does not hold wrap receipt ${receipt.slice(0, 10)}….`
        );
      }

      const vaultBox = await readSingleBox(ctx, vaultOpen.boxId, fresh);
      const decoded = readZcBox(vaultBox);
      if (!decoded || decoded.recordType !== "wrapVault") {
        throw new ZcTxConflictError("Wrap vault box moved or was spent.");
      }
      const vault: ZcWrapVault = decoded;
      const spend = buildUnwrapSpend({
        vault,
        vaultBox,
        toTree: ownTree
      });

      return finishSpend({
        actionName: "unwrap",
        market: null,
        spend,
        roles: [],
        validThrough: null,
        terms: {
          receiptId: receipt,
          vaultBoxId: vault.boxId,
          tokenId: vault.wrapped.tokenId,
          amount: vault.wrapped.amount.toString(),
          nanoErg: vault.box.value.toString()
        }
      });
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolves a simulated `walletLend` match (`boxId` + optional `units`) into its concrete
 * `fillOrder` or `buyAsk` action by inspecting the on-chain box record.
 */
export async function resolveWalletLendStep(
  step: ZcWalletLendBatchStep,
  deps: ZcTxDeps
): Promise<Extract<ZcTxAction, { type: "fillOrder" | "buyAsk" }>> {
  const ctx = await deps.getReadContext(false);
  const box = await readSingleBox(ctx, step.boxId, false);
  const rec = readZcBox(box);
  if (rec?.recordType === "order") {
    return { type: "fillOrder", boxId: step.boxId };
  }
  if (rec?.recordType === "ask") {
    return { type: "buyAsk", boxId: step.boxId, units: step.units ?? null };
  }
  throw new ZcTxRefusalError(
    `Matched box ${step.boxId.slice(0, 10)}… is no longer an open order or ask.`
  );
}

/**
 * Computes an exact dry-run quote without signing or submitting anything.
 * Never throws `ZcTxRefusalError` or `ZcApiError` — converts protocol refusals into
 * `quote.refusals` and `quote.requires` so the UI can display actionable guidance.
 */
export async function quoteZcAction(action: ZcTxAction, deps: ZcTxDeps): Promise<ZcTxQuote> {
  try {
    const out = await planAction(action, deps, "quote");
    return out.quote;
  } catch (err) {
    if (err instanceof ZcTxRefusalError) {
      return buildRefusedQuote(action.type, 0, err.message, err.requires);
    }
    if (err instanceof ZcApiError || err instanceof ZcTxConflictError) {
      return buildRefusedQuote(action.type, 0, err.message);
    }
    throw err;
  }
}

/**
 * Re-reads fresh on-chain boxes & Nautilus UTXOs, enforces `limits`, constructs the unsigned
 * ErgoTree v3 transaction, maps Nautilus v3 per-input `signers`, and runs `assertTxInvariants`.
 */
export async function buildZcAction(
  action: ZcTxAction,
  deps: ZcTxDeps,
  limits?: ZcTxLimits
): Promise<ZcBuiltTx> {
  try {
    const out = await planAction(action, deps, "build", limits);
    if (!out.build) {
      throw new ZcTxInvariantError("Transaction planner did not produce a builder.");
    }
    return out.build();
  } catch (err) {
    if (err instanceof ZcApiError) {
      throw new ZcTxRefusalError(err.message);
    }
    throw err;
  }
}

/**
 * Formats Nautilus EIP-12 / v3 blind-signing errors and transaction errors into
 * concise, actionable user-facing messages.
 */
export function formatNautilusError(err: unknown): string {
  if (
    err instanceof ZcTxRefusalError ||
    err instanceof ZcTxConflictError ||
    err instanceof ZcTxInvariantError
  ) {
    return err.message;
  }
  if (err && typeof err === "object") {
    const obj = err as { code?: unknown; info?: unknown; message?: unknown };
    const code = typeof obj.code === "number" ? obj.code : null;
    const info =
      typeof obj.info === "string"
        ? obj.info
        : typeof obj.message === "string"
          ? obj.message
          : "";

    if (code === 2 || /user declined|rejected|cancel/i.test(info)) {
      return "Signing cancelled in Nautilus.";
    }
    if (code === 1 || /proof|prover|ergotree|tree version|version 3/i.test(info)) {
      return `Nautilus failed to prove this ErgoTree v3 transaction${
        info ? ` (${info})` : ""
      }. Make sure Nautilus v2.0.0-beta.3+ is active, no second Nautilus extension is enabled, and click Requote if a box or oracle moved.`;
    }
    if (info) return info;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Transaction signing or submission failed.";
}

/**
 * End-to-end execution:
 * 1. Fresh-builds & invariant-verifies the unsigned tx (`buildZcAction`).
 * 2. Signs with Nautilus v2.0.0-beta.3+ using explicit per-input `{ signers }`.
 * 3. Submits the signed transaction via Nautilus `ergo.submit_tx`.
 */
export async function signAndSubmitZcAction(
  action: ZcTxAction,
  deps: ZcTxDeps,
  limits?: ZcTxLimits
): Promise<ZcSubmitResult> {
  const built = await buildZcAction(action, deps, limits);
  const signedTx = await deps.wallet.signTx(built.unsignedTx, {
    signers: built.signers
  });
  const txId = await deps.wallet.submitTx(signedTx);
  return {
    txId,
    action: built.action,
    built,
    warnings: built.quote.warnings
  };
}
