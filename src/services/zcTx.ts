/**
 * Thin application glue connecting Pinia's `useWalletStore()` and `zcGraphqlEngine`
 * to the isolated, pure ErgoTree v3 transaction subsystem in `src/services/zc/tx/`.
 *
 * All cryptographic serialization, coin selection, Nautilus v3 per-input signer mapping,
 * and post-build safety invariants live strictly inside `src/services/zc/tx/`.
 */
import { Network } from "@fleet-sdk/common";
import {
  buildZcAction,
  formatNautilusError,
  quoteZcAction,
  resolveWalletLendStep,
  signAndSubmitZcAction,
  ZcTxDeps,
  ZcWalletTxAdapter
} from "./zc/tx";
import { zcGraphqlEngine } from "./zcApi";
import type { useWalletStore } from "@/stories/walletStore";
import { getNetworkType } from "@/utils";

export {
  buildZcAction,
  formatNautilusError,
  quoteZcAction,
  resolveWalletLendStep,
  signAndSubmitZcAction
};
export * from "./zc/tx/types";

export function createZcTxDeps(wallet: ReturnType<typeof useWalletStore>): ZcTxDeps {
  const adapter: ZcWalletTxAdapter = {
    network: getNetworkType(),
    async getAddresses() {
      const [changeAddress, usedAddresses, unusedAddresses] = await Promise.all([
        wallet.getChangeAddress(),
        wallet.getUsedAddresses(),
        wallet.getUnusedAddresses()
      ]);
      return { changeAddress, usedAddresses, unusedAddresses };
    },
    async getUtxos(force = false) {
      return wallet.getBoxes(force);
    },
    async getCurrentHeight() {
      return wallet.getCurrentHeight();
    },
    async signTx(unsignedTx, options) {
      return wallet.signTx(unsignedTx, options);
    },
    async submitTx(signedTx) {
      return wallet.submitTx(signedTx);
    }
  };

  return {
    wallet: adapter,
    getReadContext(force = false, signal?: AbortSignal) {
      return zcGraphqlEngine.getTxReadContext(force, signal);
    }
  };
}

export function explorerTxUrl(txId: string): string {
  const base =
    getNetworkType() === Network.Testnet
      ? "https://testnet.ergoplatform.com/en/transactions"
      : "https://ergexplorer.com/transactions";
  return `${base}/${encodeURIComponent(txId)}`;
}
