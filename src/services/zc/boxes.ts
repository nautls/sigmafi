import { hex } from "@fleet-sdk/crypto";
import { decode, estimateBoxSize } from "@fleet-sdk/serializer";
import {
  classifyErgoTree,
  marketTokenId,
  ZC_ORACLE_V2_NFT,
  ZcKind,
  ZcScript
} from "./contracts";
import { ZcMarket } from "@/types/zc";

export const LONG_MAX = 9_223_372_036_854_775_807n;
export const LONG_MIN = -9_223_372_036_854_775_808n;
export const MAX_CURVE_POINTS = 20;
export const MIN_BOX = 1_000_000n;
export const MIN_VALUE_PER_BYTE = 360n;
export const MAX_BOX_SIZE = 4096;
export const MAX_COLLATERAL_TOKENS = 30;
export const DISCLOSURE_VAR = "64";
export const MAX_SCRIPT_CHARS = 8192;

const DUMMY_HEX_64 = "0".repeat(64);
const DEFAULT_SIZE_HEIGHT = 1_500_000;

export interface BoxSizeInput {
  readonly value: bigint | string;
  readonly ergoTree: string;
  readonly creationHeight?: number;
  readonly assets: readonly { readonly tokenId: string; readonly amount: bigint | string }[];
  readonly additionalRegisters: Readonly<Record<string, string | undefined>>;
}

/**
 * Exact consensus `ErgoBox` wire size in bytes (matching Appkit's `toDummyInput(ctx).bytes.length`).
 */
export function boxCandidateSize(box: BoxSizeInput, index = 0): number {
  const regs: Record<string, string> = {};
  for (const k of ["R4", "R5", "R6", "R7", "R8", "R9"] as const) {
    const v = box.additionalRegisters[k];
    if (typeof v === "string" && v.length > 0) regs[k] = v;
  }
  return estimateBoxSize({
    boxId: DUMMY_HEX_64,
    transactionId: DUMMY_HEX_64,
    index,
    value: typeof box.value === "bigint" ? box.value.toString() : box.value,
    ergoTree: box.ergoTree,
    creationHeight: box.creationHeight ?? DEFAULT_SIZE_HEIGHT,
    assets: box.assets.map((a) => ({
      tokenId: a.tokenId,
      amount: typeof a.amount === "bigint" ? a.amount.toString() : a.amount
    })),
    additionalRegisters: regs
  });
}

/**
 * Ergo consensus minimum box value (`max(MIN_BOX, boxSize * minValuePerByte)`), iterated
 * once in case raising `value` crosses a VLQ byte-length boundary.
 */
export function minBoxValue(
  box: BoxSizeInput,
  index = 0,
  minValuePerByte: bigint = MIN_VALUE_PER_BYTE
): bigint {
  const rate = minValuePerByte > 0n ? minValuePerByte : MIN_VALUE_PER_BYTE;
  const cur = typeof box.value === "bigint" ? box.value : BigInt(box.value);
  const baseVal = cur > MIN_BOX ? cur : MIN_BOX;
  const firstRaw = BigInt(boxCandidateSize({ ...box, value: baseVal }, index)) * rate;
  const first = firstRaw > MIN_BOX ? firstRaw : MIN_BOX;
  const secondRaw = BigInt(boxCandidateSize({ ...box, value: first }, index)) * rate;
  return secondRaw > first ? secondRaw : first;
}

export interface ChainAsset {
  readonly tokenId: string;
  readonly amount: bigint;
}

export interface ChainBox {
  readonly boxId: string;
  readonly transactionId: string;
  readonly value: bigint;
  readonly index: number;
  readonly creationHeight: number;
  readonly settlementHeight: number;
  readonly ergoTree: string;
  readonly assets: readonly ChainAsset[];
  readonly additionalRegisters: Readonly<Record<string, string>>;
  readonly spentTransactionId?: string | null;
  readonly spendingHeight?: number | null;
}

interface ZcRecordBase {
  readonly box: ChainBox;
  readonly script: ZcScript;
  readonly boxId: string;
  readonly namedHash: string | null;
}

export interface ZcOrder extends ZcRecordBase {
  readonly recordType: "order";
  readonly market: ZcMarket;
  readonly terms: readonly bigint[];
  readonly principalTokens: readonly ChainAsset[];
  readonly borrowerHash: string;
  readonly liqHash: string;
  readonly guardHash: string | null;
  readonly pricingHash: string | null;
  readonly pricingTerms: readonly bigint[];
  readonly policies: number;
  readonly priced: boolean;
  readonly repayment: bigint;
  readonly principalErg: bigint;
  readonly principal: bigint;
  readonly expiry: bigint;
  readonly expiryFee: bigint;
  readonly mode: bigint;
  readonly payload: readonly bigint[];
}

export interface ZcBond extends ZcRecordBase {
  readonly recordType: "bond";
  readonly market: ZcMarket;
  readonly terms: readonly bigint[];
  readonly principalTokens: readonly ChainAsset[];
  readonly borrowerHash: string;
  readonly liqHash: string;
  readonly feeReserve: bigint;
  readonly start: bigint;
  readonly maturity: bigint;
  readonly asset: string;
  readonly repayment: bigint;
  readonly collateral: readonly ChainAsset[];
  readonly collateralErg: bigint;
}

export interface ZcSettlement extends ZcRecordBase {
  readonly recordType: "settlement";
  readonly bondBoxId: string;
  readonly liquidated: boolean;
  readonly asset: string;
  readonly proceeds: readonly ChainAsset[];
}

export interface ZcOffer extends ZcRecordBase {
  readonly recordType: "offer";
  readonly market: ZcMarket;
  readonly ownerHash: string;
  readonly terms: readonly bigint[];
  readonly policyHash: string;
  readonly predecessor: string | null;
  readonly fractional: readonly bigint[];
  readonly metadata: readonly Uint8Array[];
  readonly mintHashHex: string;
  readonly expiry: bigint;
  readonly capital: bigint;
  readonly curve: readonly [bigint, bigint][];
}

export interface ZcAsk extends ZcRecordBase {
  readonly recordType: "ask";
  readonly market: ZcMarket;
  readonly sellerHash: string;
  readonly terms: readonly bigint[];
  readonly pricingHash: string | null;
  readonly pricedAsset: string | null;
  readonly predecessor: string | null;
  readonly priced: boolean;
  readonly token: ChainAsset;
  readonly expiry: bigint;
}

export interface ZcLot extends ZcRecordBase {
  readonly recordType: "lot";
  readonly market: ZcMarket;
  readonly sellerHash: string;
  readonly terms: readonly bigint[];
  readonly expiry: bigint;
}

export interface ZcShareRequest extends ZcRecordBase {
  readonly recordType: "shareRequest";
  readonly dutch: ZcMarket | null;
  readonly ownerHash: string;
  readonly deliveryTag: string | null;
  readonly terms: readonly bigint[];
  readonly metadata: readonly Uint8Array[];
  readonly bondAsset: string;
  readonly shareId: string;
}

export interface ZcShareVault extends ZcRecordBase {
  readonly recordType: "shareVault";
  readonly dutch: boolean;
  readonly bondAsset: string;
  readonly shares: bigint;
  readonly outstanding: bigint;
  readonly pullFee: bigint;
  readonly state: number | null;
  readonly auction: readonly bigint[];
  readonly currencyHex: string | null;
  readonly shareId: string;
  readonly holding: boolean;
}

export interface ZcWrapRequest extends ZcRecordBase {
  readonly recordType: "wrapRequest";
  readonly ownerHash: string;
  readonly mintFee: bigint;
  readonly metadata: readonly Uint8Array[];
  readonly receiptId: string;
  readonly wrapped: ChainAsset;
}

export interface ZcWrapVault extends ZcRecordBase {
  readonly recordType: "wrapVault";
  readonly receiptId: string;
  readonly wrapped: ChainAsset;
}

export type ZcRecord =
  | ZcOrder
  | ZcBond
  | ZcSettlement
  | ZcOffer
  | ZcAsk
  | ZcLot
  | ZcShareRequest
  | ZcShareVault
  | ZcWrapRequest
  | ZcWrapVault;

export interface ZcOracle {
  readonly box: ChainBox;
  readonly price: bigint;
  readonly epoch: number;
}

export interface ZcEntry {
  readonly record: ZcRecord;
  readonly height: number;
}

export interface ZcOrigin {
  readonly token: string;
  readonly kind: ZcKind;
  readonly market: ZcMarket | null;
  readonly txId: string;
  readonly height: number | null;
  readonly terms: readonly bigint[];
  readonly held: ChainAsset | null;
}

const STATE_KINDS = new Set<ZcKind>([
  "Bond",
  "BondVault",
  "FractionalVault",
  "DutchAuctionVault",
  "WrapVault"
]);

export function isStateKind(kind: ZcKind): boolean {
  return STATE_KINDS.has(kind);
}

export function isMinter(r: ZcRecord): boolean {
  return (
    r.recordType === "order" || r.recordType === "shareRequest" || r.recordType === "wrapRequest"
  );
}

export function originOf(minter: ZcRecord, txId: string, height: number | null): ZcOrigin {
  if (minter.recordType === "shareRequest") {
    return {
      token: minter.boxId,
      kind: minter.script.kind,
      market: minter.script.market,
      txId,
      height,
      terms: minter.terms,
      held: minter.box.assets[0] ?? null
    };
  }
  if (minter.recordType === "wrapRequest") {
    return {
      token: minter.boxId,
      kind: minter.script.kind,
      market: null,
      txId,
      height,
      terms: [],
      held: minter.wrapped
    };
  }
  return {
    token: minter.boxId,
    kind: minter.script.kind,
    market: minter.script.market,
    txId,
    height,
    terms: [],
    held: null
  };
}

export function offerBase(market: ZcMarket): number {
  return marketTokenId(market) === null ? 11 : 15;
}

function offerTermsShape(market: ZcMarket, size: number): boolean {
  const base = offerBase(market);
  return size >= base && size <= base + 2 * MAX_CURVE_POINTS && (size - base) % 2 === 0;
}

function toHex(bytes: Uint8Array): string {
  return hex.encode(bytes);
}

function readRegisterRaw(box: ChainBox, index: number): string | null {
  const v = box.additionalRegisters[`R${index}`];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function decodeReg(box: ChainBox, index: number, expectedType: string): unknown | null {
  const raw = readRegisterRaw(box, index);
  if (!raw) return null;
  try {
    const constant = decode(raw);
    if (!constant || constant.type.toString() !== expectedType) return null;
    return constant.data;
  } catch {
    return null;
  }
}

function regBytes(box: ChainBox, index: number): Uint8Array | null {
  const data = decodeReg(box, index, "SColl[SByte]");
  return data instanceof Uint8Array ? data : null;
}

function regLongs(box: ChainBox, index: number): bigint[] | null {
  const data = decodeReg(box, index, "SColl[SLong]");
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (typeof item !== "bigint") return null;
  }
  return data as bigint[];
}

function regLong(box: ChainBox, index: number): bigint | null {
  const data = decodeReg(box, index, "SLong");
  return typeof data === "bigint" ? data : null;
}

function regInt(box: ChainBox, index: number): number | null {
  const data = decodeReg(box, index, "SInt");
  return typeof data === "number" ? data : null;
}

function regByte(box: ChainBox, index: number): number | null {
  const data = decodeReg(box, index, "SByte");
  return typeof data === "number" ? data : null;
}

function regBytesList(box: ChainBox, index: number): Uint8Array[] | null {
  const data = decodeReg(box, index, "SColl[SColl[SByte]]");
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (!(item instanceof Uint8Array)) return null;
  }
  return data as Uint8Array[];
}

function regTokens(box: ChainBox, index: number): ChainAsset[] | null {
  const data = decodeReg(box, index, "SColl[(SColl[SByte], SLong)]");
  if (!Array.isArray(data)) return null;
  const out: ChainAsset[] = [];
  for (const pair of data) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [idBytes, amount] = pair;
    if (!(idBytes instanceof Uint8Array) || idBytes.length !== 32) return null;
    if (typeof amount !== "bigint" || amount <= 0n) return null;
    out.push({ tokenId: toHex(idBytes), amount });
  }
  return out;
}

function decodeOrder(box: ChainBox, script: ZcScript): ZcOrder | null {
  if (!script.market) return null;
  const market = script.market;
  const priced = script.kind === "PricedOrder";
  const terms = regLongs(box, 4);
  if (!terms || terms.length < 7 || terms.length > 64) return null;
  const principalTokens = regTokens(box, 5);
  if (!principalTokens) return null;
  const borrower = regBytes(box, 6);
  if (!borrower || borrower.length !== 32) return null;
  const liq = regBytes(box, 7);
  if (!liq || liq.length !== 32) return null;

  const policies = priced ? regBytesList(box, 8) ?? [] : [];
  let guardBytes: Uint8Array | null = null;
  if (priced) {
    const second = policies[1];
    guardBytes = second && second.length > 0 ? second : null;
  } else {
    guardBytes = regBytes(box, 8);
  }
  const pricingHash = priced ? toHex(policies[0] ?? new Uint8Array(0)) : null;
  const pricingTerms = priced ? regLongs(box, 9) ?? [] : [];
  const borrowerHash = toHex(borrower);
  const principalErg = terms[1];
  const principal =
    marketTokenId(market) === null ? principalErg : principalTokens[0]?.amount ?? 0n;

  return {
    recordType: "order",
    box,
    script,
    boxId: box.boxId,
    namedHash: borrowerHash,
    market,
    terms,
    principalTokens,
    borrowerHash,
    liqHash: toHex(liq),
    guardHash: guardBytes ? toHex(guardBytes) : null,
    pricingHash,
    pricingTerms,
    policies: policies.length,
    priced,
    repayment: terms[0],
    principalErg,
    principal,
    expiry: terms[4],
    expiryFee: terms[5],
    mode: terms[6],
    payload: terms.slice(7)
  };
}

function decodeBond(box: ChainBox, script: ZcScript): ZcBond | null {
  if (!script.market) return null;
  const first = box.assets[0];
  if (!first || first.amount !== 2n) return null;
  const origin = regBytes(box, 4);
  if (!origin || toHex(origin) !== first.tokenId) return null;
  const borrower = regBytes(box, 5);
  if (!borrower || borrower.length !== 32) return null;
  const terms = regLongs(box, 6);
  if (!terms || terms.length < 7 || terms.length > 64) return null;
  const principalTokens = regTokens(box, 7);
  if (!principalTokens) return null;
  const liq = regBytes(box, 8);
  if (!liq || liq.length !== 32) return null;
  const lender = regLongs(box, 9);
  if (!lender || lender.length !== 3 || lender[0] < 0n || lender[0] > box.value - MIN_BOX) {
    return null;
  }
  const borrowerHash = toHex(borrower);
  const feeReserve = lender[0];
  return {
    recordType: "bond",
    box,
    script,
    boxId: box.boxId,
    namedHash: borrowerHash,
    market: script.market,
    terms,
    principalTokens,
    borrowerHash,
    liqHash: toHex(liq),
    feeReserve,
    start: lender[1],
    maturity: lender[2],
    asset: first.tokenId,
    repayment: terms[0],
    collateral: box.assets.slice(1),
    collateralErg: box.value - feeReserve
  };
}

function decodeSettlement(box: ChainBox, script: ZcScript): ZcSettlement | null {
  const first = box.assets[0];
  if (!first || first.amount !== 2n) return null;
  const bondId = regBytes(box, 4);
  if (!bondId || bondId.length !== 32) return null;
  const path = regByte(box, 5);
  if (path !== 0 && path !== 1) return null;
  return {
    recordType: "settlement",
    box,
    script,
    boxId: box.boxId,
    namedHash: null,
    bondBoxId: toHex(bondId),
    liquidated: path === 1,
    asset: first.tokenId,
    proceeds: box.assets.slice(1)
  };
}

function decodeOffer(box: ChainBox, script: ZcScript): ZcOffer | null {
  if (!script.market) return null;
  const market = script.market;
  const owner = regBytes(box, 4);
  if (!owner || owner.length !== 32) return null;
  const terms = regLongs(box, 5);
  if (!terms || !offerTermsShape(market, terms.length)) return null;
  const policyRecord = regBytes(box, 6);
  if (!policyRecord || (policyRecord.length !== 32 && policyRecord.length !== 64)) return null;
  const fractional = regLongs(box, 7);
  if (!fractional) return null;
  const metadata = regBytesList(box, 8);
  if (!metadata) return null;
  const mint = regBytes(box, 9);
  if (!mint) return null;

  const ownerHash = toHex(owner);
  const policyHash = toHex(policyRecord.slice(0, 32));
  const predecessor = policyRecord.length === 64 ? toHex(policyRecord.slice(32, 64)) : null;

  const tokenId = marketTokenId(market);
  const capital =
    tokenId === null
      ? box.value
      : box.assets
          .filter((a) => a.tokenId === tokenId)
          .reduce((acc, a) => acc + a.amount, 0n);

  const curve: [bigint, bigint][] = [];
  const tail = terms.slice(offerBase(market));
  for (let i = 0; i + 1 < tail.length; i += 2) {
    curve.push([tail[i], tail[i + 1]]);
  }

  return {
    recordType: "offer",
    box,
    script,
    boxId: box.boxId,
    namedHash: ownerHash,
    market,
    ownerHash,
    terms,
    policyHash,
    predecessor,
    fractional,
    metadata,
    mintHashHex: toHex(mint),
    expiry: terms[6],
    capital,
    curve
  };
}

function decodeAsk(box: ChainBox, script: ZcScript): ZcAsk | null {
  if (!script.market) return null;
  const priced = script.kind === "PricedAsk";
  if (box.assets.length !== 1) return null;
  const seller = regBytes(box, 4);
  if (!seller || seller.length !== 32) return null;
  const terms = regLongs(box, 5);
  if (!terms) return null;
  if (priced) {
    if (terms.length < 5 || terms.length > 64) return null;
  } else if (terms.length !== 4) {
    return null;
  }
  if (terms[0] <= 0n || terms[1] <= 0n) return null;

  let pricingHash: string | null = null;
  let pricedAsset: string | null = null;
  if (priced) {
    const p = regBytes(box, 6);
    if (!p) return null;
    pricingHash = toHex(p);
    const asset = regBytes(box, 7);
    if (!asset || asset.length !== 32) return null;
    pricedAsset = toHex(asset);
  }
  const predBytes = regBytes(box, priced ? 8 : 6);
  const predecessor = predBytes && predBytes.length === 32 ? toHex(predBytes) : null;
  const sellerHash = toHex(seller);

  return {
    recordType: "ask",
    box,
    script,
    boxId: box.boxId,
    namedHash: sellerHash,
    market: script.market,
    sellerHash,
    terms,
    pricingHash,
    pricedAsset,
    predecessor,
    priced,
    token: box.assets[0],
    expiry: terms[3]
  };
}

function decodeLot(box: ChainBox, script: ZcScript): ZcLot | null {
  if (!script.market) return null;
  const seller = regBytes(box, 4);
  if (!seller || seller.length !== 32) return null;
  const terms = regLongs(box, 5);
  if (!terms || terms.length !== 6) return null;
  const sellerHash = toHex(seller);
  return {
    recordType: "lot",
    box,
    script,
    boxId: box.boxId,
    namedHash: sellerHash,
    market: script.market,
    sellerHash,
    terms,
    expiry: terms[4]
  };
}

function decodeShareRequest(box: ChainBox, script: ZcScript): ZcShareRequest | null {
  const dutch = script.kind === "DutchAuctionMint" ? script.market : null;
  const first = box.assets[0];
  if (!first || box.assets.length !== 1 || first.amount !== 1n) return null;
  const ownerRecord = regBytes(box, 7);
  if (!ownerRecord || (ownerRecord.length !== 32 && ownerRecord.length !== 64)) return null;
  const terms = regLongs(box, 8);
  if (!terms || terms.length !== (dutch ? 8 : 3)) return null;
  const metadata = regBytesList(box, 9);
  if (!metadata || metadata.length !== 3) return null;

  const ownerHash = toHex(ownerRecord.slice(0, 32));
  const deliveryTag = ownerRecord.length === 64 ? toHex(ownerRecord.slice(32, 64)) : null;

  return {
    recordType: "shareRequest",
    box,
    script,
    boxId: box.boxId,
    namedHash: ownerHash,
    dutch,
    ownerHash,
    deliveryTag,
    terms,
    metadata,
    bondAsset: first.tokenId,
    shareId: box.boxId
  };
}

function decodeShareVault(box: ChainBox, script: ZcScript): ZcShareVault | null {
  const dutch = script.kind === "DutchAuctionVault";
  const first = box.assets[0];
  if (!first) return null;
  const asset = regBytes(box, 4);
  if (!asset || asset.length !== 32) return null;
  const supply = regLongs(box, 5);
  if (!supply || supply.length !== 3 || supply[0] >= LONG_MAX || first.amount !== supply[0] + 1n) {
    return null;
  }
  let auction: bigint[] = [];
  let currencyHex: string | null = null;
  if (dutch) {
    const a = regLongs(box, 7);
    if (!a || a.length !== 7) return null;
    const c = regBytes(box, 8);
    if (!c) return null;
    auction = a;
    currencyHex = toHex(c);
  }
  const bondAsset = toHex(asset);
  const state = regByte(box, 6);

  return {
    recordType: "shareVault",
    box,
    script,
    boxId: box.boxId,
    namedHash: null,
    dutch,
    bondAsset,
    shares: supply[0],
    outstanding: supply[1],
    pullFee: supply[2],
    state,
    auction,
    currencyHex,
    shareId: first.tokenId,
    holding: box.assets.slice(1).some((t) => t.tokenId === bondAsset)
  };
}

function decodeWrapRequest(box: ChainBox, script: ZcScript): ZcWrapRequest | null {
  if (box.assets.length !== 1) return null;
  const owner = regBytes(box, 4);
  if (!owner || owner.length !== 32) return null;
  const fee = regLong(box, 5);
  if (fee === null) return null;
  const metadata = regBytesList(box, 6);
  if (!metadata || metadata.length !== 3) return null;
  const ownerHash = toHex(owner);
  return {
    recordType: "wrapRequest",
    box,
    script,
    boxId: box.boxId,
    namedHash: ownerHash,
    ownerHash,
    mintFee: fee,
    metadata,
    receiptId: box.boxId,
    wrapped: box.assets[0]
  };
}

function decodeWrapVault(box: ChainBox, script: ZcScript): ZcWrapVault | null {
  const hasRegisters = Object.values(box.additionalRegisters).some(
    (v) => typeof v === "string" && v.length > 0
  );
  if (box.assets.length !== 2 || box.assets[0].amount !== 2n || hasRegisters) return null;
  return {
    recordType: "wrapVault",
    box,
    script,
    boxId: box.boxId,
    namedHash: null,
    receiptId: box.assets[0].tokenId,
    wrapped: box.assets[1]
  };
}

export function readZcBox(found: ChainBox, matchedScript?: ZcScript | null): ZcRecord | null {
  const script = matchedScript ?? classifyErgoTree(found.ergoTree);
  if (!script) return null;
  const box: ChainBox =
    found.ergoTree === script.ergoTreeHex ? found : { ...found, ergoTree: script.ergoTreeHex };
  switch (script.kind) {
    case "Order":
    case "PricedOrder":
      return decodeOrder(box, script);
    case "Bond":
      return decodeBond(box, script);
    case "BondVault":
      return decodeSettlement(box, script);
    case "LendOffer":
      return decodeOffer(box, script);
    case "SaleOrder":
    case "PricedAsk":
      return decodeAsk(box, script);
    case "LotAuction":
      return decodeLot(box, script);
    case "FractionalMint":
    case "DutchAuctionMint":
      return decodeShareRequest(box, script);
    case "FractionalVault":
    case "DutchAuctionVault":
      return decodeShareVault(box, script);
    case "WrapMint":
      return decodeWrapRequest(box, script);
    case "WrapVault":
      return decodeWrapVault(box, script);
  }
}

export function holdsOracleNft(box: ChainBox): boolean {
  return box.assets.some((a) => a.tokenId === ZC_ORACLE_V2_NFT);
}

export function readZcOracle(box: ChainBox): ZcOracle | null {
  if (!box.assets.some((a) => a.tokenId === ZC_ORACLE_V2_NFT && a.amount === 1n)) return null;
  const price = regLong(box, 4);
  if (price === null || price <= 0n) return null;
  const epoch = regInt(box, 5);
  if (epoch === null) return null;
  return { box, price, epoch };
}

export function payoutTag(box: ChainBox): { askId: string; units: bigint } | null {
  const askId = regBytes(box, 4);
  if (!askId || askId.length !== 32) return null;
  const units = regLong(box, 5);
  if (units === null || units <= 0n) return null;
  return { askId: toHex(askId), units };
}

export function disclosedTrees(serializedHex: string): string[] {
  try {
    const constant = decode(serializedHex);
    if (!constant || constant.type.toString() !== "SColl[SColl[SByte]]") return [];
    const list = constant.data;
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const item of list) {
      if (item instanceof Uint8Array) out.push(toHex(item));
    }
    return out;
  } catch {
    return [];
  }
}
