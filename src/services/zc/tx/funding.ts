/**
 * SECURITY AUDIT BOUNDARY: Pure wallet address indexing, deterministic coin selection,
 * creator authorization box selection, and zcs1 script disclosure (`var 64`).
 *
 * Security properties enforced here:
 * 1. Every wallet address is validated against the active Ergo network (mainnet/testnet).
 * 2. `avoidTokens` prevents coin selection from pulling extra copies of a burned token
 *    (which would otherwise either fail contract burn checks or leave unintended tokens).
 * 3. `selectAuthBox` only ever selects UTXOs sitting at the exact creator ErgoTree hash.
 * 4. `applyScriptDisclosure` attaches `var 64` to `INPUTS(0)` iff no input/output already
 *    carries the named ErgoTree, enabling permissionless batching & third-party settlement.
 */
import { Amount, Box, BoxCandidate, EIP12UnsignedInput, Network } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import { hex } from "@fleet-sdk/crypto";
import { ChainAsset, ChainBox, DISCLOSURE_VAR } from "../boxes";
import { encodeBytesList, hashErgoTreeHex } from "./encoding";
import { ZcTxRefusalError, ZcWalletAddresses } from "./types";

const DISCLOSURE_KEY = Number(DISCLOSURE_VAR);

export interface WalletAddressBook {
  readonly network: Network;
  readonly changeAddress: string;
  readonly changeTreeHex: string;
  readonly changeTreeHash: string;
  readonly byTreeHex: ReadonlyMap<string, string>;
  readonly byTreeHash: ReadonlyMap<string, { readonly address: string; readonly ergoTreeHex: string }>;
  readonly allAddresses: readonly string[];
}

/**
 * Validates and indexes every Base58 address owned by the connected wallet.
 * Rejects any address whose network prefix does not match `network`.
 */
export function indexWalletAddresses(
  raw: ZcWalletAddresses,
  network: Network
): WalletAddressBook {
  if (!raw.changeAddress || !raw.changeAddress.trim()) {
    throw new ZcTxRefusalError("Wallet has no change address. Connect Nautilus first.");
  }

  const byTreeHex = new Map<string, string>();
  const byTreeHash = new Map<string, { readonly address: string; readonly ergoTreeHex: string }>();
  const seenAddrs = new Set<string>();
  const ordered: string[] = [];

  const register = (addrStr: string) => {
    const clean = addrStr.trim();
    if (!clean || seenAddrs.has(clean)) return;
    let parsed: ErgoAddress;
    try {
      parsed = ErgoAddress.fromBase58(clean);
    } catch {
      throw new ZcTxRefusalError(`Wallet reported an invalid Ergo address: ${clean}`);
    }
    if (parsed.network !== network) {
      throw new ZcTxRefusalError(
        `Wallet address ${clean} is on the wrong network (expected ${
          network === Network.Mainnet ? "mainnet" : "testnet"
        }).`
      );
    }
    const treeHex = parsed.ergoTree.toLowerCase();
    const treeHash = hashErgoTreeHex(treeHex);
    seenAddrs.add(clean);
    ordered.push(clean);
    if (!byTreeHex.has(treeHex)) byTreeHex.set(treeHex, clean);
    if (!byTreeHash.has(treeHash)) byTreeHash.set(treeHash, { address: clean, ergoTreeHex: treeHex });
  };

  register(raw.changeAddress);
  for (const a of raw.usedAddresses) register(a);
  for (const a of raw.unusedAddresses) register(a);

  const changeParsed = ErgoAddress.fromBase58(raw.changeAddress.trim());
  const changeTreeHex = changeParsed.ergoTree.toLowerCase();
  const changeTreeHash = hashErgoTreeHex(changeTreeHex);

  return {
    network,
    changeAddress: raw.changeAddress.trim(),
    changeTreeHex,
    changeTreeHash,
    byTreeHex,
    byTreeHash,
    allAddresses: ordered
  };
}

/**
 * Normalizes a Fleet/Nautilus `Box<Amount>` into the internal immutable `ChainBox` format.
 */
export function normalizeWalletUtxo(box: Box<Amount>): ChainBox {
  const additionalRegisters: Record<string, string> = {};
  if (box.additionalRegisters) {
    for (const k of ["R4", "R5", "R6", "R7", "R8", "R9"] as const) {
      const v = box.additionalRegisters[k];
      if (typeof v === "string" && v.length > 0) additionalRegisters[k] = v;
    }
  }
  return {
    boxId: String(box.boxId).toLowerCase(),
    transactionId: String(box.transactionId).toLowerCase(),
    index: Number(box.index),
    value: BigInt(box.value),
    creationHeight: Number(box.creationHeight),
    settlementHeight: Number(box.creationHeight),
    ergoTree: String(box.ergoTree).toLowerCase(),
    assets: (box.assets ?? []).map((a) => ({
      tokenId: String(a.tokenId).toLowerCase(),
      amount: BigInt(a.amount)
    })),
    additionalRegisters,
    spentTransactionId: null,
    spendingHeight: null
  };
}

/**
 * Selects a single unspent wallet box sitting at `creatorTreeHex` to authorize
 * creator-only contract paths (`cancel`, `repay` from collateral, `recollateralize`, `extinguish`).
 *
 * Prefers a box holding `preferToken` (when set), then boxes meeting `minValue` (when set),
 * then clean / token-light boxes (when `preferClean` is set), then smallest nanoERG value,
 * then lexicographic `boxId`.
 */
export function selectAuthBox(
  utxos: readonly ChainBox[],
  creatorTreeHex: string,
  opts?: {
    readonly preferToken?: string;
    readonly preferClean?: boolean;
    readonly minValue?: bigint;
    readonly excludeBoxIds?: ReadonlySet<string>;
  }
): ChainBox | null {
  const targetTree = creatorTreeHex.toLowerCase();
  const prefer = opts?.preferToken?.toLowerCase() ?? null;
  const preferClean = opts?.preferClean ?? false;
  const minValue = opts?.minValue ?? null;
  const exclude = opts?.excludeBoxIds;

  const candidates = utxos.filter(
    (u) => u.ergoTree.toLowerCase() === targetTree && !(exclude && exclude.has(u.boxId))
  );
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (prefer !== null) {
      const ha = a.assets.some((t) => t.tokenId === prefer) ? 0 : 1;
      const hb = b.assets.some((t) => t.tokenId === prefer) ? 0 : 1;
      if (ha !== hb) return ha - hb;
    }
    if (minValue !== null) {
      const ma = a.value >= minValue ? 0 : 1;
      const mb = b.value >= minValue ? 0 : 1;
      if (ma !== mb) return ma - mb;
    }
    if (preferClean) {
      const ca = a.assets.length === 0 ? 0 : 1;
      const cb = b.assets.length === 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      if (a.assets.length !== b.assets.length) return a.assets.length - b.assets.length;
    }
    if (a.value !== b.value) return a.value < b.value ? -1 : 1;
    return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
  });

  return candidates[0];
}

/**
 * Deterministic wallet coin selector matching Lithos-Client's `reserveAvoiding`.
 *
 * - Never selects boxes in `excludeBoxIds`.
 * - Never selects boxes holding any token in `avoidTokens` (prevents pulling extra units
 *   of a token that the transaction burns).
 * - Satisfies every required token first, then adds ERG boxes (preferring token-free UTXOs)
 *   until `requiredNanoErg` is covered.
 */
export function selectWalletFunding(
  utxos: readonly ChainBox[],
  requiredNanoErg: bigint,
  requiredTokens: readonly ChainAsset[],
  opts?: {
    readonly avoidTokens?: ReadonlySet<string>;
    readonly excludeBoxIds?: ReadonlySet<string>;
    readonly walletBook?: WalletAddressBook;
  }
): ChainBox[] {
  const avoid = opts?.avoidTokens ?? new Set<string>();
  const exclude = opts?.excludeBoxIds ?? new Set<string>();
  const book = opts?.walletBook;

  // Merge duplicate required token entries
  const needTokens = new Map<string, bigint>();
  for (const t of requiredTokens) {
    if (t.amount <= 0n) continue;
    const id = t.tokenId.toLowerCase();
    needTokens.set(id, (needTokens.get(id) ?? 0n) + t.amount);
  }

  if (requiredNanoErg <= 0n && needTokens.size === 0) {
    return [];
  }

  const eligible = utxos.filter((u) => {
    if (exclude.has(u.boxId)) return false;
    if (book && !book.byTreeHex.has(u.ergoTree.toLowerCase())) return false;
    if (avoid.size > 0 && u.assets.some((a) => avoid.has(a.tokenId))) return false;
    return true;
  });

  const picked: ChainBox[] = [];
  const pickedIds = new Set<string>();
  let ergSum = 0n;
  const tokSum = new Map<string, bigint>();

  const take = (box: ChainBox) => {
    if (pickedIds.has(box.boxId)) return;
    pickedIds.add(box.boxId);
    picked.push(box);
    ergSum += box.value;
    for (const a of box.assets) {
      tokSum.set(a.tokenId, (tokSum.get(a.tokenId) ?? 0n) + a.amount);
    }
  };

  // Pass 1: satisfy every required token
  for (const [tokenId, needed] of needTokens) {
    const have = () => tokSum.get(tokenId) ?? 0n;
    if (have() >= needed) continue;

    const holders = eligible
      .filter((u) => !pickedIds.has(u.boxId) && u.assets.some((a) => a.tokenId === tokenId))
      .sort((a, b) => {
        const amtA = a.assets
          .filter((x) => x.tokenId === tokenId)
          .reduce((acc, x) => acc + x.amount, 0n);
        const amtB = b.assets
          .filter((x) => x.tokenId === tokenId)
          .reduce((acc, x) => acc + x.amount, 0n);
        if (amtA !== amtB) return amtA > amtB ? -1 : 1;
        if (a.assets.length !== b.assets.length) return a.assets.length - b.assets.length;
        return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
      });

    for (const box of holders) {
      take(box);
      if (have() >= needed) break;
    }

    if (have() < needed) {
      throw new ZcTxRefusalError(
        `Wallet holds ${have().toString()} of token ${tokenId.slice(0, 10)}…, but ${needed.toString()} is required.`
      );
    }
  }

  // Pass 2: satisfy requiredNanoErg (preferring pure-ERG boxes, largest first)
  if (ergSum < requiredNanoErg) {
    const remaining = eligible
      .filter((u) => !pickedIds.has(u.boxId))
      .sort((a, b) => {
        const cleanA = a.assets.length === 0 ? 0 : 1;
        const cleanB = b.assets.length === 0 ? 0 : 1;
        if (cleanA !== cleanB) return cleanA - cleanB;
        if (a.value !== b.value) return a.value > b.value ? -1 : 1;
        return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
      });

    for (const box of remaining) {
      take(box);
      if (ergSum >= requiredNanoErg) break;
    }
  }

  if (ergSum < requiredNanoErg) {
    const shortNano = requiredNanoErg - ergSum;
    const shortErg = (Number(shortNano) / 1e9).toFixed(4);
    const avoidNote =
      avoid.size > 0
        ? " (boxes holding burned tokens were excluded to prevent unintended token burns)"
        : "";
    throw new ZcTxRefusalError(
      `Insufficient ERG in wallet: short by ${shortErg} ERG${avoidNote}.`
    );
  }

  return picked;
}

/**
 * zcs1 Script Disclosure (`var 64`):
 * If `namedTreeHex` does not already appear as the ErgoTree of any output,
 * attaches `Coll[Coll[Byte]](namedTreeBytes)` to `INPUTS(0).extension[64]` so batchers
 * and counterparties can learn the party's script from the transaction's outputs or
 * extension alone (even while the tx is in the mempool where input boxes may not be
 * present in `inputs` metadata).
 *
 * Mirrors `AppBase.disclose` / `ZcUserTransactions.disclosed`.
 */
export function applyScriptDisclosure(
  inputs: readonly EIP12UnsignedInput[],
  outputs: readonly BoxCandidate<string>[],
  namedTreeHex: string
): EIP12UnsignedInput[] {
  if (inputs.length === 0) {
    throw new ZcTxRefusalError("Script disclosure requires at least one input.");
  }
  const target = namedTreeHex.trim().toLowerCase();
  const alreadyPresent = outputs.some((o) => o.ergoTree.toLowerCase() === target);

  if (alreadyPresent) {
    return inputs.map((i) => ({ ...i, extension: { ...i.extension } }));
  }

  const encoded = encodeBytesList([hex.decode(target)]);
  return inputs.map((inp, idx) =>
    idx === 0
      ? {
          ...inp,
          extension: {
            ...inp.extension,
            [DISCLOSURE_KEY]: encoded
          }
        }
      : { ...inp, extension: { ...inp.extension } }
  );
}
