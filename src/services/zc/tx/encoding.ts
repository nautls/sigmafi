/**
 * SECURITY AUDIT BOUNDARY: Pure Sigma register & context-variable serialization.
 *
 * - Pure functions only (no network, no wallet, no side effects).
 * - Uses `@fleet-sdk/serializer` exclusively so every constant round-trips with `boxes.ts`.
 * - Register indices follow Ergo protocol order: R4..R9 (index 0..5 in register arrays).
 */
import { NonMandatoryRegisters } from "@fleet-sdk/common";
import { blake2b256, hex } from "@fleet-sdk/crypto";
import {
  SByte,
  SColl,
  serializeBox,
  SInt,
  SLong,
  SPair
} from "@fleet-sdk/serializer";
import { ChainAsset, ChainBox } from "../boxes";

const UTF8_ENCODER = new TextEncoder();

export function encodeBytes(bytes: Uint8Array): string {
  return SColl(SByte, bytes).toHex();
}

export function encodeHexBytes(hexStr: string): string {
  const clean = hexStr.trim().toLowerCase();
  return encodeBytes(clean.length > 0 ? hex.decode(clean) : new Uint8Array(0));
}

export function encodeUtf8(text: string): string {
  return encodeBytes(UTF8_ENCODER.encode(text));
}

export function encodeUtf8Bytes(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

export function encodeInt(value: number): string {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new Error(`Invalid SInt value: ${value}`);
  }
  return SInt(value).toHex();
}

export function encodeByte(value: number): string {
  if (!Number.isInteger(value) || value < -128 || value > 127) {
    throw new Error(`Invalid SByte value: ${value}`);
  }
  return SByte(value).toHex();
}

export function encodeLong(value: bigint): string {
  return SLong(value).toHex();
}

export function encodeLongs(values: readonly bigint[]): string {
  return SColl(SLong, [...values]).toHex();
}

export function encodeBytesList(items: readonly Uint8Array[]): string {
  return SColl(SColl(SByte), [...items]).toHex();
}

export function encodeTokenPairs(tokens: readonly ChainAsset[]): string {
  const pairs: [Uint8Array, bigint][] = tokens.map((t) => {
    const clean = t.tokenId.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(clean)) {
      throw new Error(`Invalid 32-byte token id for register encoding: ${t.tokenId}`);
    }
    return [hex.decode(clean), t.amount];
  });
  return SColl(SPair(SColl(SByte), SLong), pairs).toHex();
}

/**
 * Converts a dense list of serialized Sigma constant hex values into Ergo's R4..R9 map.
 */
export function registersFromList(values: readonly string[]): NonMandatoryRegisters {
  if (values.length > 6) {
    throw new Error(`Ergo boxes support at most 6 additional registers (R4..R9), got ${values.length}`);
  }
  const regs: NonMandatoryRegisters = {};
  const keys = ["R4", "R5", "R6", "R7", "R8", "R9"] as const;
  for (let i = 0; i < values.length; i++) {
    regs[keys[i]] = values[i];
  }
  return regs;
}

/**
 * Extracts a box's additional registers in dense R4..R{3+n} order.
 */
export function registersToList(
  regs: Readonly<Record<string, string | undefined>>
): string[] {
  const keys = ["R4", "R5", "R6", "R7", "R8", "R9"] as const;
  let last = -1;
  for (let i = 0; i < keys.length; i++) {
    const v = regs[keys[i]];
    if (typeof v === "string" && v.length > 0) last = i;
  }
  const out: string[] = [];
  for (let i = 0; i <= last; i++) {
    const v = regs[keys[i]];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`Sparse register gap at ${keys[i]} while reading box registers`);
    }
    out.push(v);
  }
  return out;
}

/**
 * Returns a copy of `regs` with register `R{regNum}` (4..9) set to `serializedHex`.
 * Validates that registers remain dense (no gaps below `regNum`).
 */
export function setRegisterNumber(
  regs: Readonly<Record<string, string | undefined>>,
  regNum: number,
  serializedHex: string
): NonMandatoryRegisters {
  if (regNum < 4 || regNum > 9) {
    throw new Error(`Register number must be 4..9, got R${regNum}`);
  }
  const out: Record<string, string> = {};
  for (const k of ["R4", "R5", "R6", "R7", "R8", "R9"] as const) {
    const v = regs[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  out[`R${regNum}`] = serializedHex;
  // Re-validate density via registersToList
  return registersFromList(registersToList(out));
}

/**
 * Exact ErgoBox wire serialization (`ErgoBoxSerializer`) for settled-bond Dutch share minting
 * (passed in context variable 1 as `Coll[Byte]`).
 */
export function serializeChainBoxBytes(box: ChainBox): Uint8Array {
  const additionalRegisters: NonMandatoryRegisters = {};
  for (const k of ["R4", "R5", "R6", "R7", "R8", "R9"] as const) {
    const v = box.additionalRegisters[k];
    if (typeof v === "string" && v.length > 0) {
      additionalRegisters[k] = v;
    }
  }
  return serializeBox({
    boxId: box.boxId,
    transactionId: box.transactionId,
    index: box.index,
    value: box.value.toString(),
    creationHeight: box.creationHeight,
    ergoTree: box.ergoTree,
    assets: box.assets.map((a) => ({
      tokenId: a.tokenId,
      amount: a.amount.toString()
    })),
    additionalRegisters
  }).toBytes();
}

export function hashErgoTreeHex(ergoTreeHex: string): string {
  const clean = ergoTreeHex.trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0) {
    throw new Error("Invalid ErgoTree hex");
  }
  return hex.encode(blake2b256(hex.decode(clean)));
}
