/**
 * SECURITY AUDIT BOUNDARY: Independent post-build transaction safety gate.
 *
 * EVERY unsigned transaction MUST pass `assertTxInvariants` before being surfaced for
 * inspection or sent to `ergo.sign_tx`. This module is intentionally self-contained and
 * re-verifies every conservation, signer, fee, destination, and slippage invariant directly
 * from the final `EIP12UnsignedTransaction` JSON object.
 */
import { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import {
  boxCandidateSize,
  ChainAsset,
  MAX_BOX_SIZE,
  MIN_BOX,
  MIN_VALUE_PER_BYTE
} from "../boxes";
import { marketTokenId, MINER_FEE_ERGO_TREE } from "../contracts";
import { bigMax } from "../pricing";
import { WalletAddressBook } from "./funding";
import { ZcTxConflictError, ZcTxInvariantError, ZcTxLimits } from "./types";
import { ZcMarket } from "@/types/zc";

export const TX_FEE = 1_000_000n;

export interface TxInvariantExpectation {
  readonly unsignedTx: EIP12UnsignedTransaction;
  readonly signers: Record<number, string | null>;
  readonly protocolIndices: ReadonlySet<number>;
  readonly walletOutputIndices: ReadonlySet<number>;
  readonly walletBook: WalletAddressBook;
  readonly expectedMinted: string | null;
  readonly expectedBurn: readonly ChainAsset[];
  readonly market: ZcMarket | null;
  readonly limits?: ZcTxLimits;
}

function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

function tallyTokens(list: readonly { tokenId: string; amount: string | bigint }[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const a of list) {
    const id = a.tokenId.toLowerCase();
    const amt = typeof a.amount === "bigint" ? a.amount : BigInt(a.amount);
    out.set(id, (out.get(id) ?? 0n) + amt);
  }
  return out;
}

/**
 * Verifies all protocol and user-fund safety invariants on the final unsigned EIP-12 tx.
 * Throws `ZcTxInvariantError` on any violation, or `ZcTxConflictError` on `limits` drift.
 */
export function assertTxInvariants(exp: TxInvariantExpectation): void {
  const {
    unsignedTx,
    signers,
    protocolIndices,
    walletOutputIndices,
    walletBook,
    expectedMinted,
    expectedBurn,
    market,
    limits
  } = exp;

  const { inputs, dataInputs, outputs } = unsignedTx;

  // 1. Structural non-emptiness & duplicate input prevention
  if (inputs.length === 0) {
    throw new ZcTxInvariantError("Transaction has zero inputs.");
  }
  if (outputs.length < 2) {
    throw new ZcTxInvariantError("Transaction must have at least one output plus the miner fee output.");
  }

  const seenInputs = new Set<string>();
  let totalInputErg = 0n;
  const inTokens = new Map<string, bigint>();

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const id = inp.boxId.toLowerCase();
    if (!isHex64(id)) {
      throw new ZcTxInvariantError(`Input #${i} has invalid boxId: ${inp.boxId}`);
    }
    if (seenInputs.has(id)) {
      throw new ZcTxInvariantError(`Duplicate input boxId detected: ${id}`);
    }
    seenInputs.add(id);

    if (!isHex64(inp.transactionId)) {
      throw new ZcTxInvariantError(`Input #${i} has invalid transactionId: ${inp.transactionId}`);
    }
    if (!Number.isInteger(inp.index) || inp.index < 0) {
      throw new ZcTxInvariantError(`Input #${i} has invalid output index: ${inp.index}`);
    }
    if (!Number.isInteger(inp.creationHeight) || inp.creationHeight <= 0) {
      throw new ZcTxInvariantError(`Input #${i} has invalid creationHeight: ${inp.creationHeight}`);
    }
    const val = BigInt(inp.value);
    if (val <= 0n) {
      throw new ZcTxInvariantError(`Input #${i} has non-positive ERG value: ${inp.value}`);
    }
    totalInputErg += val;

    for (const a of inp.assets) {
      const tid = a.tokenId.toLowerCase();
      if (!isHex64(tid)) {
        throw new ZcTxInvariantError(`Input #${i} has invalid tokenId: ${a.tokenId}`);
      }
      const amt = BigInt(a.amount);
      if (amt <= 0n) {
        throw new ZcTxInvariantError(`Input #${i} has non-positive token amount for ${tid}`);
      }
      inTokens.set(tid, (inTokens.get(tid) ?? 0n) + amt);
    }
  }

  const seenDataInputs = new Set<string>();
  for (let i = 0; i < dataInputs.length; i++) {
    const di = dataInputs[i];
    const id = di.boxId.toLowerCase();
    if (!isHex64(id)) {
      throw new ZcTxInvariantError(`Data input #${i} has invalid boxId: ${di.boxId}`);
    }
    if (seenDataInputs.has(id)) {
      throw new ZcTxInvariantError(`Duplicate data input boxId detected: ${id}`);
    }
    seenDataInputs.add(id);
  }

  // 2. Output validation & ERG conservation
  let totalOutputErg = 0n;
  const outTokens = new Map<string, bigint>();

  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    const val = BigInt(out.value);
    if (!Number.isInteger(out.creationHeight) || out.creationHeight <= 0) {
      throw new ZcTxInvariantError(`Output #${i} has invalid creationHeight: ${out.creationHeight}`);
    }
    if (!out.ergoTree || out.ergoTree.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(out.ergoTree)) {
      throw new ZcTxInvariantError(`Output #${i} has malformed ErgoTree hex.`);
    }
    const size = boxCandidateSize(out, i);
    if (size > MAX_BOX_SIZE) {
      throw new ZcTxInvariantError(
        `Output #${i} serialized size ${size} bytes exceeds Ergo consensus limit (${MAX_BOX_SIZE} bytes).`
      );
    }
    const requiredMin = bigMax(MIN_BOX, BigInt(size) * MIN_VALUE_PER_BYTE);
    if (val < requiredMin) {
      throw new ZcTxInvariantError(
        `Output #${i} value ${val.toString()} is below required minimum box value (${requiredMin.toString()} for ${size} bytes).`
      );
    }
    totalOutputErg += val;

    for (const a of out.assets) {
      const tid = a.tokenId.toLowerCase();
      if (!isHex64(tid)) {
        throw new ZcTxInvariantError(`Output #${i} has invalid tokenId: ${a.tokenId}`);
      }
      const amt = BigInt(a.amount);
      if (amt <= 0n) {
        throw new ZcTxInvariantError(`Output #${i} has non-positive token amount for ${tid}`);
      }
      outTokens.set(tid, (outTokens.get(tid) ?? 0n) + amt);
    }
  }

  if (totalInputErg !== totalOutputErg) {
    throw new ZcTxInvariantError(
      `ERG conservation violated: inputs=${totalInputErg.toString()} != outputs=${totalOutputErg.toString()}.`
    );
  }

  // 3. Explicit miner fee box sanity check (last output)
  const feeOut = outputs[outputs.length - 1];
  const feeVal = BigInt(feeOut.value);
  if (feeOut.ergoTree.toLowerCase() !== MINER_FEE_ERGO_TREE.toLowerCase()) {
    throw new ZcTxInvariantError("Last output must be the standard Ergo miner fee box.");
  }
  if (feeOut.assets.length !== 0) {
    throw new ZcTxInvariantError("Miner fee output must not carry any tokens.");
  }
  if (Object.keys(feeOut.additionalRegisters || {}).length !== 0) {
    throw new ZcTxInvariantError("Miner fee output must not carry additional registers.");
  }
  if (feeVal < TX_FEE || feeVal >= TX_FEE + MIN_BOX) {
    throw new ZcTxInvariantError(
      `Miner fee ${feeVal.toString()} nanoERG is outside safe bounds [${TX_FEE.toString()}, ${(TX_FEE + MIN_BOX - 1n).toString()}].`
    );
  }

  // 4. Exact token conservation — blocks unintended token burns and unauthorized mints
  const burnMap = tallyTokens(expectedBurn);
  const allTokenIds = new Set<string>([
    ...inTokens.keys(),
    ...outTokens.keys(),
    ...burnMap.keys()
  ]);
  const mintAllowedId = expectedMinted ? expectedMinted.toLowerCase() : null;
  const firstInputId = inputs[0].boxId.toLowerCase();

  for (const tid of allTokenIds) {
    const inv = inTokens.get(tid) ?? 0n;
    const outv = outTokens.get(tid) ?? 0n;
    const expBurn = burnMap.get(tid) ?? 0n;

    if (outv > inv) {
      // Minting
      if (mintAllowedId === null || tid !== mintAllowedId || tid !== firstInputId) {
        throw new ZcTxInvariantError(
          `Unexpected token mint for ${tid}: expected minted=${mintAllowedId ?? "none"}, INPUTS(0)=${firstInputId}.`
        );
      }
      if (expBurn > 0n) {
        throw new ZcTxInvariantError(`Token ${tid} cannot be both minted and burned.`);
      }
    } else if (inv > outv) {
      // Burning
      const actualBurn = inv - outv;
      if (actualBurn !== expBurn) {
        throw new ZcTxInvariantError(
          `Unintended token burn blocked for ${tid}: actual burn=${actualBurn.toString()}, expected burn=${expBurn.toString()}.`
        );
      }
    } else if (expBurn > 0n) {
      throw new ZcTxInvariantError(
        `Expected burn of ${expBurn.toString()} for ${tid} did not occur.`
      );
    }
  }

  // 5. Complete & verified Nautilus v3 per-input `signers` mapping
  const signerKeys = Object.keys(signers);
  if (signerKeys.length !== inputs.length) {
    throw new ZcTxInvariantError(
      `Nautilus v3 signers map has ${signerKeys.length} entries for ${inputs.length} inputs.`
    );
  }
  for (let i = 0; i < inputs.length; i++) {
    if (!(i in signers)) {
      throw new ZcTxInvariantError(`Nautilus v3 signers map is missing input index ${i}.`);
    }
    const tree = inputs[i].ergoTree.toLowerCase();
    const assigned = signers[i];
    if (protocolIndices.has(i)) {
      if (assigned !== null) {
        throw new ZcTxInvariantError(
          `Protocol input #${i} MUST have signer=null, got ${String(assigned)}.`
        );
      }
      if (walletBook.byTreeHex.has(tree)) {
        throw new ZcTxInvariantError(
          `Protocol input #${i} unexpectedly matches a wallet address ErgoTree.`
        );
      }
    } else {
      const expectedAddr = walletBook.byTreeHex.get(tree);
      if (typeof assigned !== "string" || !expectedAddr || assigned !== expectedAddr) {
        throw new ZcTxInvariantError(
          `Wallet input #${i} signer mismatch: mapped=${String(assigned)}, expected=${expectedAddr ?? "unknown"}.`
        );
      }
    }
  }

  // 6. Change / sweep outputs must ONLY go to addresses verified in the connected wallet
  for (const outIdx of walletOutputIndices) {
    const out = outputs[outIdx];
    if (!out) {
      throw new ZcTxInvariantError(`Invalid wallet output index ${outIdx}.`);
    }
    if (!walletBook.byTreeHex.has(out.ergoTree.toLowerCase())) {
      throw new ZcTxInvariantError(
        `Change/sweep output #${outIdx} does not go to an address owned by the connected wallet.`
      );
    }
  }

  // 7. Quote-drift / slippage guard (`limits`) computed directly from the final tx
  if (
    limits &&
    (limits.maxPay !== undefined ||
      limits.minReceive !== undefined ||
      limits.maxErgPay !== undefined ||
      limits.minErgReceive !== undefined)
  ) {
    const mToken = market ? marketTokenId(market) : null;
    let walletErgIn = 0n;
    let walletErgOut = 0n;
    let walletTokenIn = 0n;
    let walletTokenOut = 0n;

    for (let i = 0; i < inputs.length; i++) {
      if (!walletBook.byTreeHex.has(inputs[i].ergoTree.toLowerCase())) continue;
      walletErgIn += BigInt(inputs[i].value);
      if (mToken !== null) {
        for (const a of inputs[i].assets) {
          if (a.tokenId.toLowerCase() === mToken) walletTokenIn += BigInt(a.amount);
        }
      }
    }
    for (let i = 0; i < outputs.length; i++) {
      if (!walletBook.byTreeHex.has(outputs[i].ergoTree.toLowerCase())) continue;
      walletErgOut += BigInt(outputs[i].value);
      if (mToken !== null) {
        for (const a of outputs[i].assets) {
          if (a.tokenId.toLowerCase() === mToken) walletTokenOut += BigInt(a.amount);
        }
      }
    }

    // Benign sub-MIN_BOX UTXO dust absorbed into miner fee (already bounded < MIN_BOX in step 3)
    // is excluded from quote-drift comparison so dust never causes false conflicts.
    const ergDust = feeVal - TX_FEE;
    const ergNetDelta = walletErgOut - walletErgIn + ergDust;
    const actualErgPays = ergNetDelta < 0n ? -ergNetDelta : 0n;
    const actualErgReceives = ergNetDelta > 0n ? ergNetDelta : 0n;

    const primaryNetDelta = mToken === null ? ergNetDelta : walletTokenOut - walletTokenIn;
    const actualPays = primaryNetDelta < 0n ? -primaryNetDelta : 0n;
    const actualReceives = primaryNetDelta > 0n ? primaryNetDelta : 0n;

    if (limits.maxPay !== undefined && actualPays > limits.maxPay) {
      throw new ZcTxConflictError(
        `Quote moved before signing: transaction now pays ${actualPays.toString()}, above your limit of ${limits.maxPay.toString()}.`
      );
    }
    if (limits.minReceive !== undefined && actualReceives < limits.minReceive) {
      throw new ZcTxConflictError(
        `Quote moved before signing: transaction now receives ${actualReceives.toString()}, below your limit of ${limits.minReceive.toString()}.`
      );
    }
    if (limits.maxErgPay !== undefined && actualErgPays > limits.maxErgPay) {
      throw new ZcTxConflictError(
        `Quote moved before signing: transaction now spends ${actualErgPays.toString()} nanoERG, above your ERG limit of ${limits.maxErgPay.toString()}.`
      );
    }
    if (limits.minErgReceive !== undefined && actualErgReceives < limits.minErgReceive) {
      throw new ZcTxConflictError(
        `Quote moved before signing: transaction now receives ${actualErgReceives.toString()} nanoERG, below your ERG limit of ${limits.minErgReceive.toString()}.`
      );
    }
  }
}
