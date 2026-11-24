/**
 * SECURITY AUDIT BOUNDARY: Explicit Nautilus v2.0.0-beta.3+ ErgoTree v3 signer mapping.
 *
 * Because ErgoTree v3 uses blind signing in Nautilus (`v2.0.0-beta.3`), Nautilus cannot
 * infer from the v3 bytecode which inputs require a wallet signature vs which inputs are
 * guard-only contract boxes. We MUST pass `{ signers: Record<number, string | null> }`:
 *
 * - Protocol contract inputs  -> `null` (no wallet signature)
 * - Creator auth / funding    -> exact Base58 address matching `input.ergoTree`
 *
 * Ref: https://docs.nautiluswallet.com/dapp-connector/wallet-interaction#choose-the-signing-address-of-each-input
 */
import { EIP12UnsignedInput } from "@fleet-sdk/common";
import { classifyErgoTree } from "../contracts";
import { WalletAddressBook } from "./funding";
import { ZcSignerAuditEntry, ZcTxInvariantError } from "./types";

export interface NautilusSignerBuildResult {
  readonly signers: Record<number, string | null>;
  readonly audit: readonly ZcSignerAuditEntry[];
}

export function buildNautilusV3Signers(params: {
  readonly inputs: readonly EIP12UnsignedInput[];
  readonly protocolIndices: ReadonlySet<number>;
  readonly authIndices: ReadonlySet<number>;
  readonly walletBook: WalletAddressBook;
}): NautilusSignerBuildResult {
  const { inputs, protocolIndices, authIndices, walletBook } = params;
  const signers: Record<number, string | null> = {};
  const audit: ZcSignerAuditEntry[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const tree = inp.ergoTree.toLowerCase();
    const isProtocol = protocolIndices.has(i);
    const isAuth = authIndices.has(i);

    if (isProtocol && isAuth) {
      throw new ZcTxInvariantError(`Input #${i} cannot be both a protocol input and an auth input.`);
    }

    if (isProtocol) {
      if (walletBook.byTreeHex.has(tree)) {
        throw new ZcTxInvariantError(
          `Input #${i} (${inp.boxId}) is marked as a protocol input, but its ErgoTree belongs to the connected wallet.`
        );
      }
      const script = classifyErgoTree(tree);
      signers[i] = null;
      audit.push({
        index: i,
        boxId: inp.boxId,
        role: "protocol",
        contractLabel: script ? script.label : "Protocol Contract",
        ergoTree: tree,
        value: BigInt(inp.value),
        signerAddress: null
      });
      continue;
    }

    const ownerAddr = walletBook.byTreeHex.get(tree);
    if (!ownerAddr) {
      throw new ZcTxInvariantError(
        `Wallet input #${i} (${inp.boxId}) does not match any address owned by the connected Nautilus wallet.`
      );
    }

    signers[i] = ownerAddr;
    audit.push({
      index: i,
      boxId: inp.boxId,
      role: isAuth ? "auth" : "wallet",
      contractLabel: isAuth ? "Creator Auth (P2PK)" : "Wallet Funding (P2PK)",
      ergoTree: tree,
      value: BigInt(inp.value),
      signerAddress: ownerAddr
    });
  }

  return { signers, audit };
}
