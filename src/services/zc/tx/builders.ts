/**
 * SECURITY AUDIT BOUNDARY: Pure SigmaFi V2 (zcs1) transaction & box builders.
 *
 * Exact 1-to-1 TypeScript port of Lithos-Client's `ZcUserTransactions.scala`:
 * - Exact input/output index positions required by every ErgoTree v3 contract.
 * - Exact register encodings (R4..R9) and context extension variables (`0..3`, `64`).
 * - Pure deterministic assembly (no network, no wallet RPC calls).
 * - Every assembled transaction passes `buildNautilusV3Signers` AND `assertTxInvariants`
 *   before leaving this module.
 */
import {
  BoxCandidate,
  EIP12UnsignedDataInput,
  EIP12UnsignedInput,
  EIP12UnsignedTransaction,
  NonMandatoryRegisters
} from "@fleet-sdk/common";
import { hex } from "@fleet-sdk/crypto";
import {
  ChainAsset,
  ChainBox,
  MIN_BOX,
  ZcAsk,
  ZcBond,
  ZcLot,
  ZcOffer,
  ZcOrder,
  ZcSettlement,
  ZcShareRequest,
  ZcShareVault,
  ZcWrapRequest,
  ZcWrapVault
} from "../boxes";
import {
  getZcExpressionByHash,
  getZcExpressionBytes,
  getZcScript,
  marketTokenId,
  MINER_FEE_ERGO_TREE
} from "../contracts";
import { bigMax } from "../pricing";
import {
  auctionOpen,
  currencyHeld,
  excessAuction,
  excessPrice,
  keptBySale,
  liqRuleKind,
  lotTarget,
  saleKeepsErg,
  vaultCurrency
} from "../rules";
import {
  encodeByte,
  encodeBytes,
  encodeBytesList,
  encodeHexBytes,
  encodeInt,
  encodeLong,
  encodeLongs,
  encodeTokenPairs,
  encodeUtf8,
  encodeUtf8Bytes,
  registersFromList,
  registersToList,
  setRegisterNumber
} from "./encoding";
import {
  applyScriptDisclosure,
  selectWalletFunding,
  WalletAddressBook
} from "./funding";
import { assertTxInvariants, TX_FEE } from "./invariants";
import { bondMetadata, receiptMetadata, ruleFields, sharesMetadata } from "./metadata";
import { buildNautilusV3Signers } from "./signers";
import { ZcBuiltTx, ZcTxLimits, ZcTxQuote, ZcTxRefusalError } from "./types";
import { ZcMarket } from "@/types/zc";

export { TX_FEE };
export const HEADROOM = 1_000_000n;
export const DEFAULT_RESERVE = 50_000_000n;

export interface TxOutputDraft {
  readonly ergoTree: string;
  readonly value: bigint;
  readonly assets: readonly ChainAsset[];
  readonly additionalRegisters: NonMandatoryRegisters;
  readonly creationHeight?: number;
}

export interface ZcSpendDraft {
  readonly inputs: readonly EIP12UnsignedInput[];
  readonly protocolIndices: ReadonlySet<number>;
  readonly authIndices: ReadonlySet<number>;
  readonly outputs: readonly TxOutputDraft[];
  readonly burn: readonly ChainAsset[];
  readonly minted: string | null;
  readonly dataInputs: readonly ChainBox[];
  readonly alone: boolean;
  readonly sweepToTree: string | null;
}

// ─── Low-level box conversion helpers ────────────────────────────────────────

function mergeTokens(tokens: readonly ChainAsset[]): ChainAsset[] {
  const map = new Map<string, bigint>();
  const order: string[] = [];
  for (const t of tokens) {
    if (t.amount <= 0n) continue;
    const id = t.tokenId.toLowerCase();
    if (!map.has(id)) order.push(id);
    map.set(id, (map.get(id) ?? 0n) + t.amount);
  }
  return order.map((id) => ({ tokenId: id, amount: map.get(id)! }));
}

function normalizeRegisters(
  regs: Readonly<Record<string, string | undefined>>
): NonMandatoryRegisters {
  const out: NonMandatoryRegisters = {};
  for (const k of ["R4", "R5", "R6", "R7", "R8", "R9"] as const) {
    const v = regs[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

export function chainBoxToUnsignedInput(
  box: ChainBox,
  extension: Record<number, string> = {}
): EIP12UnsignedInput {
  return {
    boxId: box.boxId.toLowerCase(),
    transactionId: box.transactionId.toLowerCase(),
    index: box.index,
    ergoTree: box.ergoTree.toLowerCase(),
    creationHeight: box.creationHeight,
    value: box.value.toString(),
    assets: box.assets.map((a) => ({
      tokenId: a.tokenId.toLowerCase(),
      amount: a.amount.toString()
    })),
    additionalRegisters: normalizeRegisters(box.additionalRegisters),
    extension: { ...extension }
  };
}

export function chainBoxToDataInput(box: ChainBox): EIP12UnsignedDataInput {
  return {
    boxId: box.boxId.toLowerCase(),
    transactionId: box.transactionId.toLowerCase(),
    index: box.index,
    ergoTree: box.ergoTree.toLowerCase(),
    creationHeight: box.creationHeight,
    value: box.value.toString(),
    assets: box.assets.map((a) => ({
      tokenId: a.tokenId.toLowerCase(),
      amount: a.amount.toString()
    })),
    additionalRegisters: normalizeRegisters(box.additionalRegisters)
  };
}

function draftToCandidate(draft: TxOutputDraft, defaultHeight: number): BoxCandidate<string> {
  return {
    ergoTree: draft.ergoTree.toLowerCase(),
    creationHeight: draft.creationHeight ?? defaultHeight,
    value: draft.value.toString(),
    assets: draft.assets.map((a) => ({
      tokenId: a.tokenId.toLowerCase(),
      amount: a.amount.toString()
    })),
    additionalRegisters: normalizeRegisters(draft.additionalRegisters)
  };
}

function minerFeeCandidate(feeNanoErg: bigint, height: number): BoxCandidate<string> {
  return {
    ergoTree: MINER_FEE_ERGO_TREE,
    creationHeight: height,
    value: feeNanoErg.toString(),
    assets: [],
    additionalRegisters: {}
  };
}

// ─── Posting box builders (ZcUserTransactions.scala lines 136-189) ───────────

/** The order box a draft order describes, naming `borrowerHash`. Priced orders are stamped at `height`. */
export function buildOrderOutput(
  o: ZcOrder,
  borrowerHash: string,
  height: number
): TxOutputDraft {
  const core: string[] = [
    encodeLongs(o.terms),
    encodeTokenPairs(o.principalTokens),
    encodeHexBytes(borrowerHash),
    encodeHexBytes(o.liqHash)
  ];
  const extra: string[] = !o.priced
    ? o.guardHash !== null
      ? [encodeHexBytes(o.guardHash)]
      : []
    : [
        encodeBytesList([
          o.pricingHash ? hex.decode(o.pricingHash) : new Uint8Array(0),
          o.guardHash ? hex.decode(o.guardHash) : new Uint8Array(0)
        ]),
        encodeLongs(o.pricingTerms)
      ];
  return {
    ergoTree: o.script.ergoTreeHex,
    value: o.box.value,
    assets: o.box.assets,
    additionalRegisters: registersFromList([...core, ...extra]),
    creationHeight: o.priced ? height : undefined
  };
}

/** The offer box a draft offer describes, naming `ownerHash`, with zcs1 share metadata when delivering shares. */
export function buildOfferOutput(o: ZcOffer, ownerHash: string): TxOutputDraft {
  const metaBytes: Uint8Array[] =
    o.fractional.length < 8
      ? []
      : sharesMetadata(
          o.market,
          {
            openingBps: o.fractional[3],
            floorBps: o.fractional[4],
            length: o.fractional[5],
            expiry: o.fractional[6],
            threshold: o.fractional[7]
          },
          null
        ).map(encodeUtf8Bytes);

  return {
    ergoTree: o.script.ergoTreeHex,
    value: o.box.value,
    assets: o.box.assets,
    additionalRegisters: registersFromList([
      encodeHexBytes(ownerHash),
      encodeLongs(o.terms),
      encodeHexBytes(o.policyHash),
      encodeLongs(o.fractional),
      encodeBytesList(metaBytes),
      encodeHexBytes(o.mintHashHex)
    ])
  };
}

/** The ask box a draft ask describes, naming `sellerHash`. */
export function buildAskOutput(a: ZcAsk, sellerHash: string): TxOutputDraft {
  const core: string[] = [encodeHexBytes(sellerHash), encodeLongs(a.terms)];
  const priced: string[] = a.priced
    ? [encodeHexBytes(a.pricingHash ?? ""), encodeHexBytes(a.pricedAsset ?? "")]
    : [];
  return {
    ergoTree: a.script.ergoTreeHex,
    value: a.box.value,
    assets: a.box.assets,
    additionalRegisters: registersFromList([...core, ...priced])
  };
}

/** A lot auction box selling `items` (and for token markets, `erg` nanoERG), named for `sellerHash`. */
export function buildLotOutput(
  market: ZcMarket,
  items: readonly ChainAsset[],
  erg: bigint,
  terms: readonly bigint[],
  sellerHash: string
): TxOutputDraft {
  return {
    ergoTree: getZcScript("LotAuction", market).ergoTreeHex,
    value: bigMax(erg, MIN_BOX) + terms[5],
    assets: items,
    additionalRegisters: registersFromList([encodeHexBytes(sellerHash), encodeLongs(terms)])
  };
}

/**
 * A share mint request holding one bond unit (`FractionalMint` or `DutchAuctionMint`).
 * R4..R6 repeat metadata so R7..R9 can be populated densely.
 */
export function buildShareRequestOutput(
  asset: string,
  market: ZcMarket,
  terms: readonly bigint[],
  auction: boolean,
  metadata: readonly [string, string, string],
  ownerHash: string
): TxOutputDraft {
  const script = auction
    ? getZcScript("DutchAuctionMint", market)
    : getZcScript("FractionalMint", null);
  return {
    ergoTree: script.ergoTreeHex,
    value: 2n * MIN_BOX + terms[1] + terms[2],
    assets: [{ tokenId: asset.toLowerCase(), amount: 1n }],
    additionalRegisters: registersFromList([
      ...metadata.map(encodeUtf8),
      encodeHexBytes(ownerHash),
      encodeLongs(terms),
      encodeBytesList(metadata.map(encodeUtf8Bytes))
    ])
  };
}

/** A wrap request locking `amount` of `tokenId` and funding receipt, vault refresh reserve, and mint fee. */
export function buildWrapRequestOutput(
  tokenId: string,
  amount: bigint,
  mintFee: bigint,
  refreshReserve: bigint,
  ownerHash: string
): TxOutputDraft {
  const meta = receiptMetadata(tokenId.toLowerCase(), amount);
  return {
    ergoTree: getZcScript("WrapMint", null).ergoTreeHex,
    value: 2n * MIN_BOX + refreshReserve + mintFee,
    assets: [{ tokenId: tokenId.toLowerCase(), amount }],
    additionalRegisters: registersFromList([
      encodeHexBytes(ownerHash),
      encodeLong(mintFee),
      encodeBytesList(meta.map(encodeUtf8Bytes))
    ])
  };
}

// ─── Spend builders (ZcUserTransactions.scala lines 215-490) ─────────────────

/** Returns a copy of `order` with its resolved principal stored for `PricedOrder` fills. */
export function resolveOrderPrincipal(order: ZcOrder, amount: bigint): ZcOrder {
  if (!order.priced) return order;
  const mToken = marketTokenId(order.market);
  if (mToken === null) {
    const nextTerms = [...order.terms];
    nextTerms[1] = amount;
    return {
      ...order,
      terms: nextTerms,
      principalErg: amount,
      principal: amount
    };
  }
  return {
    ...order,
    principalTokens: [{ tokenId: mToken, amount }],
    principal: amount
  };
}

export function buildFillOrderSpend(params: {
  readonly order: ZcOrder;
  readonly orderBox: ChainBox;
  readonly borrowerTree: string;
  readonly lenderTree: string;
  readonly start: bigint;
  readonly maturity: bigint;
  readonly feeReserve: bigint;
  readonly oracleBox: ChainBox | null;
}): ZcSpendDraft {
  const { order, orderBox, borrowerTree, lenderTree, start, maturity, feeReserve, oracleBox } = params;
  if (feeReserve < 0n) {
    throw new ZcTxRefusalError("the fee reserve cannot be negative");
  }
  const m = order.market;
  const asset = order.boxId.toLowerCase();
  const rule = liqRuleKind(order.liqHash, m);
  const meta = bondMetadata({
    market: m,
    asset,
    principal: order.principal,
    repayment: order.repayment,
    start,
    maturity,
    rule: ruleFields(rule, order.payload, order.liqHash)
  });

  const unitOut: TxOutputDraft = {
    ergoTree: lenderTree,
    value: MIN_BOX,
    assets: [{ tokenId: asset, amount: 1n }],
    additionalRegisters: registersFromList(meta.map(encodeUtf8))
  };

  const collateralErg = order.box.value - order.expiryFee;
  const bondOut: TxOutputDraft = {
    ergoTree: getZcScript("Bond", m).ergoTreeHex,
    value: collateralErg + feeReserve,
    assets: [{ tokenId: asset, amount: 2n }, ...order.box.assets],
    additionalRegisters: registersFromList([
      encodeHexBytes(asset),
      encodeHexBytes(order.borrowerHash),
      encodeLongs(order.terms),
      encodeTokenPairs(order.principalTokens),
      encodeHexBytes(order.liqHash),
      encodeLongs([feeReserve, start, maturity])
    ]),
    creationHeight: Number(start)
  };

  const principalOut: TxOutputDraft = {
    ergoTree: borrowerTree,
    value: order.expiryFee + order.principalErg,
    assets: order.principalTokens,
    additionalRegisters: registersFromList([encodeHexBytes(asset)])
  };

  const ext: Record<number, string> = {};
  if (order.guardHash !== null) {
    ext[1] = encodeBytes(getZcExpressionBytes("FillGuard", m));
  }
  if (order.priced && order.pricingHash) {
    const expr = getZcExpressionByHash(order.pricingHash);
    if (expr) ext[2] = encodeHexBytes(expr.bytesHex);
  }

  return {
    inputs: [chainBoxToUnsignedInput(orderBox, ext)],
    protocolIndices: new Set([0]),
    authIndices: new Set(),
    outputs: [unitOut, bondOut, principalOut],
    burn: [],
    minted: asset,
    dataInputs: order.guardHash !== null && oracleBox ? [oracleBox] : [],
    alone: false,
    sweepToTree: null
  };
}

export function buildBuyAskSpend(params: {
  readonly ask: ZcAsk;
  readonly askBox: ChainBox;
  readonly sellerTree: string;
  readonly units: bigint;
  readonly paid: bigint;
  readonly bondBox: ChainBox | null;
  readonly oracleBox: ChainBox | null;
}): ZcSpendDraft {
  const { ask, askBox, sellerTree, units, paid, bondBox, oracleBox } = params;
  const tag = registersFromList([encodeHexBytes(ask.boxId), encodeLong(units)]);
  const mToken = marketTokenId(ask.market);

  const payoutOut: TxOutputDraft =
    mToken === null
      ? {
          ergoTree: sellerTree,
          value: bigMax(paid, MIN_BOX),
          assets: [],
          additionalRegisters: tag
        }
      : {
          ergoTree: sellerTree,
          value: MIN_BOX,
          assets: [{ tokenId: mToken, amount: paid }],
          additionalRegisters: tag
        };

  const rest = ask.token.amount - units;
  const continuationOut: TxOutputDraft | null =
    rest <= 0n
      ? null
      : {
          ergoTree: ask.script.ergoTreeHex,
          value: ask.box.value,
          assets: [{ tokenId: ask.token.tokenId, amount: rest }],
          additionalRegisters: setRegisterNumber(
            askBox.additionalRegisters,
            ask.priced ? 8 : 6,
            encodeHexBytes(ask.boxId)
          )
        };

  const ext: Record<number, string> = { 0: encodeInt(0) };
  if (continuationOut !== null) {
    ext[1] = encodeInt(1);
  }
  if (ask.priced && ask.pricingHash) {
    const expr = getZcExpressionByHash(ask.pricingHash);
    if (expr) {
      ext[2] = encodeHexBytes(expr.bytesHex);
      ext[3] = encodeInt(0);
    }
  }

  const dataInputs: ChainBox[] = [];
  if (bondBox) dataInputs.push(bondBox);
  if (oracleBox) dataInputs.push(oracleBox);

  return {
    inputs: [chainBoxToUnsignedInput(askBox, ext)],
    protocolIndices: new Set([0]),
    authIndices: new Set(),
    outputs: continuationOut ? [payoutOut, continuationOut] : [payoutOut],
    burn: [],
    minted: null,
    dataInputs,
    alone: false,
    sweepToTree: null
  };
}

export function buildBuyLotSpend(params: {
  readonly lot: ZcLot;
  readonly lotBox: ChainBox;
  readonly sellerTree: string;
  readonly price: bigint;
}): ZcSpendDraft {
  const { lot, lotBox, sellerTree, price } = params;
  const tag = registersFromList([encodeHexBytes(lot.boxId)]);
  const mToken = marketTokenId(lot.market);
  const payoutOut: TxOutputDraft =
    mToken === null
      ? {
          ergoTree: sellerTree,
          value: lot.box.value + price,
          assets: [],
          additionalRegisters: tag
        }
      : {
          ergoTree: sellerTree,
          value: MIN_BOX,
          assets: [{ tokenId: mToken, amount: price }],
          additionalRegisters: tag
        };

  return {
    inputs: [chainBoxToUnsignedInput(lotBox, { 0: encodeInt(0) })],
    protocolIndices: new Set([0]),
    authIndices: new Set(),
    outputs: [payoutOut],
    burn: [],
    minted: null,
    dataInputs: [],
    alone: false,
    sweepToTree: null
  };
}

export function buildRepaySpend(params: {
  readonly bond: ZcBond;
  readonly bondBox: ChainBox;
  readonly borrowerTree: string;
  readonly kept: bigint;
  readonly authBox: ChainBox | null;
}): ZcSpendDraft {
  const { bond, bondBox, borrowerTree, kept, authBox } = params;
  if (kept > 0n && !authBox) {
    throw new ZcTxRefusalError("repaying from collateral needs the borrower's box");
  }
  const tag = registersFromList([encodeHexBytes(bond.boxId), encodeByte(0)]);
  const vaultTree = getZcScript("BondVault", null).ergoTreeHex;
  const mToken = marketTokenId(bond.market);

  const settlementOut: TxOutputDraft =
    mToken === null
      ? {
          ergoTree: vaultTree,
          value: bond.feeReserve + bond.repayment,
          assets: [{ tokenId: bond.asset, amount: 2n }],
          additionalRegisters: tag
        }
      : {
          ergoTree: vaultTree,
          value: bigMax(MIN_BOX, bond.feeReserve + bond.terms[2]),
          assets: [
            { tokenId: bond.asset, amount: 2n },
            { tokenId: mToken, amount: bond.repayment }
          ],
          additionalRegisters: tag
        };

  let backErg = bond.collateralErg;
  let backTokens: ChainAsset[];
  if (mToken === null) {
    backErg = bond.collateralErg - kept;
    backTokens = [...bond.collateral];
  } else {
    let remKept = kept;
    backTokens = [];
    for (const t of bond.collateral) {
      if (t.tokenId !== mToken || remKept <= 0n) {
        backTokens.push(t);
      } else if (t.amount > remKept) {
        backTokens.push({ tokenId: t.tokenId, amount: t.amount - remKept });
        remKept = 0n;
      } else {
        remKept -= t.amount;
      }
    }
  }

  const backOut: TxOutputDraft = {
    ergoTree: borrowerTree,
    value: backErg,
    assets: backTokens,
    additionalRegisters: registersFromList([encodeHexBytes(bond.boxId)])
  };

  const inputs: EIP12UnsignedInput[] = [
    chainBoxToUnsignedInput(bondBox, { 1: encodeInt(0), 2: encodeInt(1) })
  ];
  const authIndices = new Set<number>();
  if (authBox) {
    inputs.push(chainBoxToUnsignedInput(authBox));
    authIndices.add(1);
  }

  return {
    inputs,
    protocolIndices: new Set([0]),
    authIndices,
    outputs: [settlementOut, backOut],
    burn: [],
    minted: null,
    dataInputs: [],
    alone: false,
    sweepToTree: null
  };
}

export function buildExtinguishSpend(params: {
  readonly bond: ZcBond;
  readonly bondBox: ChainBox;
  readonly authBox: ChainBox;
  readonly toTree: string;
}): ZcSpendDraft {
  const { bond, bondBox, authBox, toTree } = params;
  const locked = bondBox.assets
    .filter((a) => a.tokenId === bond.asset)
    .reduce((acc, a) => acc + a.amount, 0n);
  if (locked !== 2n) {
    throw new ZcTxRefusalError(
      `bond ${bond.boxId} must hold 2 reserve units of ${bond.asset}, found ${locked.toString()}`
    );
  }
  return {
    inputs: [chainBoxToUnsignedInput(bondBox), chainBoxToUnsignedInput(authBox)],
    protocolIndices: new Set([0]),
    authIndices: new Set([1]),
    outputs: [],
    burn: [{ tokenId: bond.asset, amount: 3n }],
    minted: null,
    dataInputs: [],
    alone: false,
    sweepToTree: toTree
  };
}

export function buildRecollateralizeSpend(params: {
  readonly bond: ZcBond;
  readonly bondBox: ChainBox;
  readonly authBox: ChainBox;
  readonly erg: bigint;
  readonly added: readonly ChainAsset[];
  readonly height: number;
}): ZcSpendDraft {
  const { bond, bondBox, authBox, erg, added, height } = params;
  const addedMap = new Map<string, bigint>();
  for (const a of added) {
    addedMap.set(a.tokenId.toLowerCase(), a.amount);
  }
  const grown: ChainAsset[] = bondBox.assets.map((t) => {
    const extra = addedMap.get(t.tokenId.toLowerCase());
    return extra !== undefined ? { tokenId: t.tokenId, amount: t.amount + extra } : t;
  });
  const existingIds = new Set(bondBox.assets.map((t) => t.tokenId.toLowerCase()));
  const appended: ChainAsset[] = added.filter((a) => !existingIds.has(a.tokenId.toLowerCase()));

  const successorOut: TxOutputDraft = {
    ergoTree: bond.script.ergoTreeHex,
    value: bond.box.value + erg,
    assets: [...grown, ...appended],
    additionalRegisters: normalizeRegisters(bondBox.additionalRegisters),
    creationHeight: height
  };

  return {
    inputs: [
      chainBoxToUnsignedInput(bondBox, { 3: encodeInt(0) }),
      chainBoxToUnsignedInput(authBox)
    ],
    protocolIndices: new Set([0]),
    authIndices: new Set([1]),
    outputs: [successorOut],
    burn: [],
    minted: null,
    dataInputs: [],
    alone: false,
    sweepToTree: null
  };
}

export function buildLiquidateSpend(params: {
  readonly bond: ZcBond;
  readonly bondBox: ChainBox;
  readonly expressionBytesHex: string;
  readonly oracleBox: ChainBox | null;
}): ZcSpendDraft {
  const { bond, bondBox, expressionBytesHex, oracleBox } = params;
  const settlementOut: TxOutputDraft = {
    ergoTree: getZcScript("BondVault", null).ergoTreeHex,
    value: bond.box.value - bond.feeReserve,
    assets: bondBox.assets,
    additionalRegisters: registersFromList([encodeHexBytes(bond.boxId), encodeByte(1)])
  };
  return {
    inputs: [
      chainBoxToUnsignedInput(bondBox, {
        0: encodeHexBytes(expressionBytesHex),
        1: encodeInt(0)
      })
    ],
    protocolIndices: new Set([0]),
    authIndices: new Set(),
    outputs: [settlementOut],
    burn: [],
    minted: null,
    dataInputs: oracleBox ? [oracleBox] : [],
    alone: false,
    sweepToTree: null
  };
}

export function buildClaimUnitSpend(params: {
  readonly asset: string;
  readonly settlementBoxes: readonly ChainBox[];
  readonly toTree: string;
}): ZcSpendDraft {
  const { asset, settlementBoxes, toTree } = params;
  const locked = settlementBoxes
    .flatMap((b) => b.assets)
    .filter((a) => a.tokenId === asset)
    .reduce((acc, a) => acc + a.amount, 0n);

  const protocolIndices = new Set<number>();
  const inputs = settlementBoxes.map((b, idx) => {
    protocolIndices.add(idx);
    return chainBoxToUnsignedInput(b);
  });

  return {
    inputs,
    protocolIndices,
    authIndices: new Set(),
    outputs: [],
    burn: [{ tokenId: asset, amount: locked + 1n }],
    minted: null,
    dataInputs: [],
    alone: false,
    sweepToTree: toTree
  };
}

export function buildClaimSharesSpend(params: {
  readonly vault: ZcShareVault;
  readonly vaultBox: ChainBox;
  readonly burned: bigint;
  readonly toTree: string;
}): ZcSpendDraft {
  const { vault, vaultBox, burned, toTree } = params;
  const tag = registersFromList([encodeHexBytes(vault.boxId)]);
  const assets = vault.box.assets.slice(1);

  if (burned >= vault.outstanding) {
    return {
      inputs: [chainBoxToUnsignedInput(vaultBox, { 1: encodeInt(0) })],
      protocolIndices: new Set([0]),
      authIndices: new Set(),
      outputs: [
        {
          ergoTree: toTree,
          value: bigMax(vault.box.value, MIN_BOX),
          assets,
          additionalRegisters: tag
        }
      ],
      burn: [{ tokenId: vault.shareId, amount: vault.outstanding + vault.shares + 1n }],
      minted: null,
      dataInputs: [],
      alone: false,
      sweepToTree: null
    };
  }

  const part = (n: bigint) => (n * burned) / vault.outstanding;
  const paidErg = part(vault.box.value);
  const paid: ChainAsset[] = [];
  const kept: ChainAsset[] = [];
  for (const t of assets) {
    const p = part(t.amount);
    if (p > 0n) paid.push({ tokenId: t.tokenId, amount: p });
    const k = t.amount - p;
    if (k > 0n) kept.push({ tokenId: t.tokenId, amount: k });
  }

  const regs = registersToList(vaultBox.additionalRegisters);
  const nextState = auctionOpen(vault) ? 3 : vault.state;
  const nextRegs = [...regs];
  nextRegs[1] = encodeLongs([vault.shares, vault.outstanding - burned, vault.pullFee]);
  if (nextState !== null) {
    if (nextRegs.length > 2) nextRegs[2] = encodeByte(nextState);
    else nextRegs.push(encodeByte(nextState));
  }

  return {
    inputs: [chainBoxToUnsignedInput(vaultBox, { 0: encodeInt(1), 1: encodeInt(0) })],
    protocolIndices: new Set([0]),
    authIndices: new Set(),
    outputs: [
      {
        ergoTree: toTree,
        value: bigMax(paidErg, MIN_BOX),
        assets: paid,
        additionalRegisters: tag
      },
      {
        ergoTree: vault.script.ergoTreeHex,
        value: vault.box.value - paidErg,
        assets: [{ tokenId: vault.shareId, amount: vault.shares + 1n }, ...kept],
        additionalRegisters: registersFromList(nextRegs)
      }
    ],
    burn: [{ tokenId: vault.shareId, amount: burned }],
    minted: null,
    dataInputs: [],
    alone: false,
    sweepToTree: null
  };
}

export function buildMintSharesSpend(params: {
  readonly req: ZcShareRequest;
  readonly reqBox: ChainBox;
  readonly ownerTree: string;
  readonly dutchState: {
    readonly stateBox: ChainBox;
    readonly repayment: bigint;
    readonly settledBondBytes: Uint8Array | null;
  } | null;
}): ZcSpendDraft {
  const { req, reqBox, ownerTree, dutchState } = params;
  const [n, pullFee, mintFee] = req.terms;
  const sharesOut: TxOutputDraft = {
    ergoTree: ownerTree,
    value: MIN_BOX,
    assets: [{ tokenId: req.shareId, amount: n }],
    additionalRegisters: registersFromList(req.metadata.map(encodeBytes))
  };
  const vaultValue = req.box.value - mintFee - MIN_BOX;
  const held: ChainAsset[] = [
    { tokenId: req.shareId, amount: n + 1n },
    { tokenId: req.bondAsset, amount: 1n }
  ];
  const fixed: string[] = [encodeHexBytes(req.bondAsset), encodeLongs([n, n, pullFee])];

  if (req.dutch === null) {
    return {
      inputs: [chainBoxToUnsignedInput(reqBox)],
      protocolIndices: new Set([0]),
      authIndices: new Set(),
      outputs: [
        sharesOut,
        {
          ergoTree: getZcScript("FractionalVault", null).ergoTreeHex,
          value: vaultValue,
          assets: held,
          additionalRegisters: registersFromList(fixed)
        }
      ],
      burn: [],
      minted: req.shareId,
      dataInputs: [],
      alone: false,
      sweepToTree: null
    };
  }

  if (!dutchState) {
    throw new ZcTxRefusalError("a Dutch mint reads the bond's state box");
  }
  const currencyHex = marketTokenId(req.dutch) ?? "";
  const regs: string[] = [
    ...fixed,
    encodeByte(0),
    encodeLongs([dutchState.repayment, ...req.terms.slice(3), 0n]),
    encodeHexBytes(currencyHex)
  ];
  const ext: Record<number, string> = { 0: encodeInt(0) };
  if (dutchState.settledBondBytes) {
    ext[1] = encodeBytes(dutchState.settledBondBytes);
  }
  return {
    inputs: [chainBoxToUnsignedInput(reqBox, ext)],
    protocolIndices: new Set([0]),
    authIndices: new Set(),
    outputs: [
      sharesOut,
      {
        ergoTree: getZcScript("DutchAuctionVault", null).ergoTreeHex,
        value: vaultValue,
        assets: held,
        additionalRegisters: registersFromList(regs)
      }
    ],
    burn: [],
    minted: req.shareId,
    dataInputs: [dutchState.stateBox],
    alone: false,
    sweepToTree: null
  };
}

export function buildPullSpend(params: {
  readonly vault: ZcShareVault;
  readonly vaultBox: ChainBox;
  readonly source: ZcSettlement;
  readonly sourceBox: ChainBox;
  readonly height: bigint;
}): { readonly spend: ZcSpendDraft; readonly nextState: number | null } {
  const { vault, vaultBox, source, sourceBox, height } = params;
  const value = vault.box.value + source.box.value - vault.pullFee;
  const proceeds = source.proceeds;
  const supply: string[] = [
    encodeHexBytes(vault.bondAsset),
    encodeLongs([vault.shares, vault.outstanding, vault.pullFee])
  ];

  let regs: string[];
  let nextState: number | null;
  if (!vault.dutch) {
    nextState = source.liquidated ? 1 : 0;
    regs = [...supply, encodeByte(nextState)];
  } else {
    const currency = vaultCurrency(vault);
    const held =
      currency === null
        ? value
        : proceeds.filter((t) => t.tokenId === currency).reduce((acc, t) => acc + t.amount, 0n);
    const lotTokens = proceeds.filter((t) => t.tokenId !== currency);
    const lotErg = currency === null ? 0n : value - MIN_BOX;
    const hasLot = lotTokens.length > 0 || lotErg > 0n;
    const threshold = vault.auction[5];
    const short = held * 10_000n < vault.auction[0] * vault.auction[2];
    const thin =
      lotTokens.some((t) => t.amount < threshold) || (currency !== null && lotErg < threshold);
    const sells = source.liquidated && hasLot && thin;
    nextState = !source.liquidated
      ? 0
      : sells && short
        ? 1
        : sells && vault.auction[1] > 0n
          ? 4
          : 2;
    const began = nextState === 1 || nextState === 4 ? height : 0n;
    const nextAuction = [...vault.auction];
    nextAuction[6] = began;
    regs = [
      ...supply,
      encodeByte(nextState),
      encodeLongs(nextAuction),
      encodeHexBytes(vault.currencyHex ?? "")
    ];
  }

  const nextVaultOut: TxOutputDraft = {
    ergoTree: vault.script.ergoTreeHex,
    value,
    assets: [{ tokenId: vault.shareId, amount: vault.shares + 1n }, ...proceeds],
    additionalRegisters: registersFromList(regs)
  };

  return {
    nextState: vault.dutch ? nextState : null,
    spend: {
      inputs: [
        chainBoxToUnsignedInput(vaultBox, { 0: encodeInt(0) }),
        chainBoxToUnsignedInput(sourceBox)
      ],
      protocolIndices: new Set([0, 1]),
      authIndices: new Set(),
      outputs: [nextVaultOut],
      burn: [{ tokenId: vault.bondAsset, amount: 3n }],
      minted: null,
      dataInputs: [],
      alone: false,
      sweepToTree: null
    }
  };
}

export function buildBuyFromVaultSpend(params: {
  readonly vault: ZcShareVault;
  readonly vaultBox: ChainBox;
  readonly height: bigint;
}): ZcSpendDraft {
  const { vault, vaultBox, height } = params;
  const before = currencyHeld(vault);
  let after: bigint;
  if (excessAuction(vault)) {
    const p = excessPrice(vault, height);
    if (p === null) {
      throw new ZcTxRefusalError("the excess auction's price reached zero");
    }
    after = before + p;
  } else {
    after = bigMax(lotTarget(vault, height), before);
  }

  const regs = setRegisterNumber(vaultBox.additionalRegisters, 6, encodeByte(2));
  const kept = keptBySale(vault);
  const reserve: ChainAsset = { tokenId: vault.shareId, amount: vault.shares + 1n };
  const cur = vaultCurrency(vault);

  const soldOut: TxOutputDraft =
    cur === null
      ? {
          ergoTree: vault.script.ergoTreeHex,
          value: after,
          assets: [reserve, ...kept],
          additionalRegisters: regs
        }
      : {
          ergoTree: vault.script.ergoTreeHex,
          value: saleKeepsErg(vault) ? vault.box.value : MIN_BOX,
          assets: [reserve, { tokenId: cur, amount: after }, ...kept],
          additionalRegisters: regs
        };

  return {
    inputs: [chainBoxToUnsignedInput(vaultBox, { 0: encodeInt(0) })],
    protocolIndices: new Set([0]),
    authIndices: new Set(),
    outputs: [soldOut],
    burn: [],
    minted: null,
    dataInputs: [],
    alone: false,
    sweepToTree: null
  };
}

export function buildMintWrapSpend(params: {
  readonly req: ZcWrapRequest;
  readonly reqBox: ChainBox;
  readonly ownerTree: string;
}): ZcSpendDraft {
  const { req, reqBox, ownerTree } = params;
  const receiptOut: TxOutputDraft = {
    ergoTree: ownerTree,
    value: MIN_BOX,
    assets: [{ tokenId: req.receiptId, amount: 1n }],
    additionalRegisters: registersFromList(req.metadata.map(encodeBytes))
  };
  const vaultOut: TxOutputDraft = {
    ergoTree: getZcScript("WrapVault", null).ergoTreeHex,
    value: req.box.value - MIN_BOX - req.mintFee,
    assets: [
      { tokenId: req.receiptId, amount: 2n },
      { tokenId: req.wrapped.tokenId, amount: req.wrapped.amount }
    ],
    additionalRegisters: {}
  };
  return {
    inputs: [chainBoxToUnsignedInput(reqBox)],
    protocolIndices: new Set([0]),
    authIndices: new Set(),
    outputs: [receiptOut, vaultOut],
    burn: [],
    minted: req.receiptId,
    dataInputs: [],
    alone: true,
    sweepToTree: null
  };
}

export function buildUnwrapSpend(params: {
  readonly vault: ZcWrapVault;
  readonly vaultBox: ChainBox;
  readonly toTree: string;
}): ZcSpendDraft {
  const { vault, vaultBox, toTree } = params;
  return {
    inputs: [chainBoxToUnsignedInput(vaultBox)],
    protocolIndices: new Set([0]),
    authIndices: new Set(),
    outputs: [],
    burn: [{ tokenId: vault.receiptId, amount: 3n }],
    minted: null,
    dataInputs: [],
    alone: false,
    sweepToTree: toTree
  };
}

// ─── Transaction assembly + Nautilus v3 signers + safety gate ────────────────

function spendLeftover(
  spend: ZcSpendDraft,
  allInputs: readonly EIP12UnsignedInput[]
): { readonly erg: bigint; readonly netTokens: Map<string, bigint> } {
  const outs = spend.sweepToTree !== null ? [] : spend.outputs;
  const inErg = allInputs.reduce((acc, i) => acc + BigInt(i.value), 0n);
  const outErg = outs.reduce((acc, o) => acc + o.value, 0n);
  const erg = inErg - outErg - TX_FEE;

  const held = new Map<string, bigint>();
  for (const inp of allInputs) {
    for (const a of inp.assets) {
      const id = a.tokenId.toLowerCase();
      held.set(id, (held.get(id) ?? 0n) + BigInt(a.amount));
    }
  }
  const used = new Map<string, bigint>();
  for (const out of outs) {
    for (const a of out.assets) {
      const id = a.tokenId.toLowerCase();
      used.set(id, (used.get(id) ?? 0n) + a.amount);
    }
  }
  for (const b of spend.burn) {
    const id = b.tokenId.toLowerCase();
    used.set(id, (used.get(id) ?? 0n) + b.amount);
  }

  const netTokens = new Map<string, bigint>();
  const mintedId = spend.minted ? spend.minted.toLowerCase() : null;
  for (const id of new Set([...held.keys(), ...used.keys()])) {
    if (id === mintedId) continue;
    netTokens.set(id, (held.get(id) ?? 0n) - (used.get(id) ?? 0n));
  }
  return { erg, netTokens };
}

/**
 * Assembles a posting transaction (`createOrder`, `createOffer`, `createAsk`,
 * `createLot`, `fractionalize`, `createWrap`) with zcs1 script disclosure (`var 64`),
 * Nautilus v3 signers, and full post-build invariant verification.
 */
export function assemblePostTx(params: {
  readonly action: string;
  readonly market: ZcMarket | null;
  readonly box: TxOutputDraft;
  readonly namedTreeHex: string;
  readonly walletUtxos: readonly ChainBox[];
  readonly walletBook: WalletAddressBook;
  readonly height: number;
  readonly quote: ZcTxQuote;
  readonly limits?: ZcTxLimits;
}): ZcBuiltTx {
  const { action, market, box, namedTreeHex, walletUtxos, walletBook, height, quote, limits } = params;

  const targetErg = box.value + TX_FEE + HEADROOM;
  let funding: ChainBox[];
  try {
    funding = selectWalletFunding(walletUtxos, targetErg, box.assets, { walletBook });
  } catch {
    // Retry with exact minimum (no headroom) if wallet can cover box + fee cleanly without change
    funding = selectWalletFunding(walletUtxos, box.value + TX_FEE, box.assets, { walletBook });
  }
  if (funding.length === 0) {
    throw new ZcTxRefusalError("Posting requires at least one wallet box.");
  }

  const rawInputs = funding.map((u) => chainBoxToUnsignedInput(u));
  const outErg = box.value;
  const inErg = funding.reduce((acc, u) => acc + u.value, 0n);
  let leftErg = inErg - outErg - TX_FEE;

  const heldMap = new Map<string, bigint>();
  for (const u of funding) {
    for (const a of u.assets) {
      heldMap.set(a.tokenId, (heldMap.get(a.tokenId) ?? 0n) + a.amount);
    }
  }
  for (const a of box.assets) {
    const id = a.tokenId.toLowerCase();
    heldMap.set(id, (heldMap.get(id) ?? 0n) - a.amount);
  }
  const changeTokens: ChainAsset[] = [];
  for (const [tokenId, amount] of heldMap) {
    if (amount > 0n) changeTokens.push({ tokenId, amount });
  }

  // If change tokens exist but leftErg < MIN_BOX, pull one more ERG box so change box is legal
  if (changeTokens.length > 0 && leftErg < MIN_BOX) {
    const pickedIds = new Set(funding.map((u) => u.boxId));
    const extra = selectWalletFunding(walletUtxos, MIN_BOX - leftErg, [], {
      excludeBoxIds: pickedIds,
      walletBook
    });
    for (const u of extra) {
      funding.push(u);
      rawInputs.push(chainBoxToUnsignedInput(u));
      leftErg += u.value;
      for (const a of u.assets) {
        heldMap.set(a.tokenId, (heldMap.get(a.tokenId) ?? 0n) + a.amount);
      }
    }
    changeTokens.length = 0;
    for (const [tokenId, amount] of heldMap) {
      if (amount > 0n) changeTokens.push({ tokenId, amount });
    }
  }

  const dust = leftErg > 0n && leftErg < MIN_BOX && changeTokens.length === 0 ? leftErg : 0n;
  const minerFee = TX_FEE + dust;
  const outputs: BoxCandidate<string>[] = [draftToCandidate(box, height)];
  const walletOutputIndices = new Set<number>();

  if (leftErg >= MIN_BOX) {
    walletOutputIndices.add(outputs.length);
    outputs.push({
      ergoTree: walletBook.changeTreeHex,
      creationHeight: height,
      value: leftErg.toString(),
      assets: changeTokens.map((t) => ({ tokenId: t.tokenId, amount: t.amount.toString() })),
      additionalRegisters: {}
    });
  }
  outputs.push(minerFeeCandidate(minerFee, height));

  const inputs = applyScriptDisclosure(rawInputs, outputs, namedTreeHex);
  const protocolIndices = new Set<number>();
  const authIndices = new Set<number>();
  const { signers, audit } = buildNautilusV3Signers({
    inputs,
    protocolIndices,
    authIndices,
    walletBook
  });

  const unsignedTx: EIP12UnsignedTransaction = {
    inputs,
    dataInputs: [],
    outputs
  };

  assertTxInvariants({
    unsignedTx,
    signers,
    protocolIndices,
    walletOutputIndices,
    walletBook,
    expectedMinted: null,
    expectedBurn: [],
    market,
    limits
  });

  return {
    action,
    market,
    unsignedTx,
    signers,
    signerAudit: audit,
    quote,
    minerFee,
    expectedMinted: null,
    expectedBurn: [],
    primaryOutputIndex: 0,
    assetId: null
  };
}

/**
 * Assembles a creator-authorized cancellation transaction (`cancel`):
 * `IN(0) = protocol box`, `IN(1) = creator auth box` -> `OUT(0) = sweep` to creator, `OUT(1) = fee`.
 */
export function assembleCancelTx(params: {
  readonly box: ChainBox;
  readonly authBox: ChainBox;
  readonly refundTreeHex: string;
  readonly walletBook: WalletAddressBook;
  readonly height: number;
  readonly quote: ZcTxQuote;
}): ZcBuiltTx {
  const { box, authBox, refundTreeHex, walletBook, height, quote } = params;
  const totalErg = box.value + authBox.value - TX_FEE;
  if (totalErg < MIN_BOX) {
    throw new ZcTxRefusalError("Combined box and authorization box values do not cover the miner fee.");
  }

  const mergedAssets = mergeTokens([...box.assets, ...authBox.assets]);
  const inputs: EIP12UnsignedInput[] = [
    chainBoxToUnsignedInput(box),
    chainBoxToUnsignedInput(authBox)
  ];
  const outputs: BoxCandidate<string>[] = [
    {
      ergoTree: refundTreeHex.toLowerCase(),
      creationHeight: height,
      value: totalErg.toString(),
      assets: mergedAssets.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
      additionalRegisters: {}
    },
    minerFeeCandidate(TX_FEE, height)
  ];

  const protocolIndices = new Set<number>([0]);
  const authIndices = new Set<number>([1]);
  const walletOutputIndices = new Set<number>([0]);

  const { signers, audit } = buildNautilusV3Signers({
    inputs,
    protocolIndices,
    authIndices,
    walletBook
  });

  const unsignedTx: EIP12UnsignedTransaction = {
    inputs,
    dataInputs: [],
    outputs
  };

  assertTxInvariants({
    unsignedTx,
    signers,
    protocolIndices,
    walletOutputIndices,
    walletBook,
    expectedMinted: null,
    expectedBurn: [],
    market: null
  });

  return {
    action: "cancel",
    market: null,
    unsignedTx,
    signers,
    signerAudit: audit,
    quote,
    minerFee: TX_FEE,
    expectedMinted: null,
    expectedBurn: [],
    primaryOutputIndex: 0,
    assetId: null
  };
}

/**
 * Assembles any `ZcSpendDraft` transaction (`fillOrder`, `buyAsk`, `buyLot`, `repay`,
 * `extinguish`, `recollateralize`, `liquidate`, `claim`, `mint`, `pull`, `buyVault`, `unwrap`).
 *
 * Mirrors `ZcUserTransactions.plan` + `ZcUserTransactions.build`, then attaches
 * explicit Nautilus v3 `signers` and runs `assertTxInvariants`.
 */
export function assembleSpendTx(params: {
  readonly action: string;
  readonly market: ZcMarket | null;
  readonly spend: ZcSpendDraft;
  readonly walletUtxos: readonly ChainBox[];
  readonly walletBook: WalletAddressBook;
  readonly height: number;
  readonly quote: ZcTxQuote;
  readonly assetId?: string | null;
  readonly limits?: ZcTxLimits;
}): ZcBuiltTx {
  const {
    action,
    market,
    spend,
    walletUtxos,
    walletBook,
    height,
    quote,
    assetId = null,
    limits
  } = params;

  const initial = spendLeftover(spend, spend.inputs);
  const shortTokens: ChainAsset[] = [];
  let carries = spend.sweepToTree !== null;
  for (const [tokenId, net] of initial.netTokens) {
    if (net < 0n) shortTokens.push({ tokenId, amount: -net });
    else if (net > 0n) carries = true;
  }

  const selfFunded =
    shortTokens.length === 0 &&
    (initial.erg >= MIN_BOX || (initial.erg >= 0n && !carries));

  if (!selfFunded && spend.alone) {
    throw new ZcTxRefusalError(
      "the box's own fee does not cover the miner fee, and nothing may be spent beside it"
    );
  }

  const excludeBoxIds = new Set<string>(spend.inputs.map((i) => i.boxId.toLowerCase()));
  const shortIds = new Set(shortTokens.map((t) => t.tokenId.toLowerCase()));
  const avoidTokens = new Set<string>();
  for (const b of spend.burn) {
    const id = b.tokenId.toLowerCase();
    if (!shortIds.has(id)) avoidTokens.add(id);
  }

  let funding: ChainBox[] = [];
  if (!selfFunded) {
    const neededErg = bigMax(0n, MIN_BOX - initial.erg);
    funding = selectWalletFunding(walletUtxos, neededErg, shortTokens, {
      avoidTokens,
      excludeBoxIds,
      walletBook
    });
  }

  const inputs: EIP12UnsignedInput[] = [
    ...spend.inputs,
    ...funding.map((u) => chainBoxToUnsignedInput(u))
  ];

  let finalLeft = spendLeftover(spend, inputs);
  // Edge case: if selected token-funding box had < needed ERG once extra tokens forced a change box
  if (
    !spend.alone &&
    finalLeft.erg < MIN_BOX &&
    (spend.sweepToTree !== null ||
      Array.from(finalLeft.netTokens.values()).some((v) => v > 0n))
  ) {
    for (const f of funding) excludeBoxIds.add(f.boxId);
    const extra = selectWalletFunding(walletUtxos, MIN_BOX - finalLeft.erg, [], {
      avoidTokens,
      excludeBoxIds,
      walletBook
    });
    for (const u of extra) {
      funding.push(u);
      inputs.push(chainBoxToUnsignedInput(u));
    }
    finalLeft = spendLeftover(spend, inputs);
  }

  const keptTokens: ChainAsset[] = [];
  for (const [tokenId, net] of finalLeft.netTokens) {
    if (net > 0n) keptTokens.push({ tokenId, amount: net });
  }

  const outputs: BoxCandidate<string>[] = [];
  const walletOutputIndices = new Set<number>();

  if (spend.sweepToTree !== null) {
    if (finalLeft.erg < MIN_BOX) {
      throw new ZcTxRefusalError("the inputs hold too little ERG for the box they sweep into");
    }
    walletOutputIndices.add(0);
    outputs.push({
      ergoTree: spend.sweepToTree.toLowerCase(),
      creationHeight: height,
      value: finalLeft.erg.toString(),
      assets: keptTokens.map((t) => ({ tokenId: t.tokenId, amount: t.amount.toString() })),
      additionalRegisters: {}
    });
    outputs.push(minerFeeCandidate(TX_FEE, height));
  } else {
    for (const o of spend.outputs) {
      outputs.push(draftToCandidate(o, height));
    }
    const dust =
      finalLeft.erg > 0n && finalLeft.erg < MIN_BOX && keptTokens.length === 0
        ? finalLeft.erg
        : 0n;
    const minerFee = TX_FEE + dust;

    if (finalLeft.erg >= MIN_BOX) {
      walletOutputIndices.add(outputs.length);
      outputs.push({
        ergoTree: walletBook.changeTreeHex,
        creationHeight: height,
        value: finalLeft.erg.toString(),
        assets: keptTokens.map((t) => ({ tokenId: t.tokenId, amount: t.amount.toString() })),
        additionalRegisters: {}
      });
    }
    outputs.push(minerFeeCandidate(minerFee, height));
  }

  const finalFee = BigInt(outputs[outputs.length - 1].value);
  const { signers, audit } = buildNautilusV3Signers({
    inputs,
    protocolIndices: spend.protocolIndices,
    authIndices: spend.authIndices,
    walletBook
  });

  const unsignedTx: EIP12UnsignedTransaction = {
    inputs,
    dataInputs: spend.dataInputs.map(chainBoxToDataInput),
    outputs
  };

  assertTxInvariants({
    unsignedTx,
    signers,
    protocolIndices: spend.protocolIndices,
    walletOutputIndices,
    walletBook,
    expectedMinted: spend.minted,
    expectedBurn: spend.burn,
    market,
    limits
  });

  return {
    action,
    market,
    unsignedTx,
    signers,
    signerAudit: audit,
    quote,
    minerFee: finalFee,
    expectedMinted: spend.minted,
    expectedBurn: spend.burn,
    primaryOutputIndex: 0,
    assetId
  };
}
