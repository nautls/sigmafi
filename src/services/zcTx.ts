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
  signAndSubmitZcAction as rawSignAndSubmitZcAction,
  resolveWalletLendStep,
  ZcSubmitResult,
  ZcTxAction,
  ZcTxDeps,
  ZcTxLimits,
  ZcWalletTxAdapter
} from "./zc/tx";
import { zcGraphqlEngine } from "./zcApi";
import { DISABLE_V2_TX_SIGNING, V2_TX_SIGNING_DISABLED_MESSAGE } from "@/constants";
import type { useWalletStore } from "@/stories/walletStore";
import { getNetworkType } from "@/utils";

export { buildZcAction, formatNautilusError, quoteZcAction, resolveWalletLendStep };
export * from "./zc/tx/types";

export async function signAndSubmitZcAction(
  action: ZcTxAction,
  deps: ZcTxDeps,
  limits?: ZcTxLimits
): Promise<ZcSubmitResult> {
  if (DISABLE_V2_TX_SIGNING) {
    throw new Error(V2_TX_SIGNING_DISABLED_MESSAGE);
  }
  return rawSignAndSubmitZcAction(action, deps, limits);
}

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
      if (DISABLE_V2_TX_SIGNING) {
        throw new Error(V2_TX_SIGNING_DISABLED_MESSAGE);
      }
      return wallet.signTx(unsignedTx, options);
    },
    async submitTx(signedTx) {
      if (DISABLE_V2_TX_SIGNING) {
        throw new Error(V2_TX_SIGNING_DISABLED_MESSAGE);
      }
      return wallet.submitTx(signedTx);
    }
  };

  return {
    wallet: adapter,
    getReadContext(force = false, signal?: AbortSignal) {
      return zcGraphqlEngine.getTxReadContext(force, signal);
    },
    checkTransaction(signedTx, signal?: AbortSignal) {
      const hc = zcGraphqlEngine.getHergmesClient();
      if (!hc || !hc.getEndpoint()) {
        return Promise.resolve({ ok: true, txId: signedTx.id ?? "" });
      }
      return hc.checkTransaction(signedTx, signal);
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
