import {
  Amount,
  Box,
  EIP12UnsignedTransaction,
  ensureBigInt,
  SignedTransaction as FleetSignedTransaction,
  isUndefined,
  some,
  utxoSum
} from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import type { Relay } from "@hergmes/sdk";
import { EIP12ErgoAPI, SignedTransaction } from "@nautilus-js/eip12-types";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, onBeforeMount, onUnmounted, ref, shallowRef, watch } from "vue";
import { useChainStore } from "./chainStore";
import { ERG_TOKEN_ID } from "@/constants";
import type { NautilusSignOptions } from "@/services/zc/tx/types";
import {
  EMPTY_WALLET_OVERLAY,
  WalletOverlaySnapshot,
  ZcWalletOverlayManager
} from "@/services/zc/walletOverlay";
import { AssetInfo } from "@/types";
import { getNetworkType, showToast } from "@/utils";

/**
 * Extended Nautilus v2.0.0-beta.3+ EIP-12 interface supporting explicit per-input
 * signer selection for ErgoTree v3 blind signing.
 * Ref: https://docs.nautiluswallet.com/dapp-connector/wallet-interaction#choose-the-signing-address-of-each-input
 */
interface NautilusV3ErgoAPI extends EIP12ErgoAPI {
  sign_tx(
    tx: EIP12UnsignedTransaction,
    options?: NautilusSignOptions
  ): Promise<SignedTransaction>;
}

const WALLET_INJECTED_EVENT = "ergo-wallet:injected";

export const useWalletStore = defineStore("wallet", () => {
  const chain = useChainStore();

  // private
  let _context: NautilusV3ErgoAPI | undefined;
  let _boxes: Box<Amount>[] = [];
  let _lastBoxFetch = 0;

  // private state
  const _balance = ref<AssetInfo<bigint>[]>([]);
  const _changeAddress = ref<string>();
  const _loading = ref(false);
  const _connected = ref(false);
  const _usedAddresses = ref<string[]>([]);
  const _unusedAddresses = ref<string[]>([]);
  const _wallets = ref<{ [key: string]: boolean }>({});
  const _connectedWallet = ref<"nautilus" | "safew" | string | undefined>();

  // Step 9: Hergmes live wallet mempool overlay state (shared Relay WebSocket)
  const _hergmesRelay = shallowRef<Relay | null>(null);
  const _overlay = shallowRef<WalletOverlaySnapshot>(EMPTY_WALLET_OVERLAY);
  const _liveOverlaySeq = ref(0);

  const _overlayManager = new ZcWalletOverlayManager((snap) => {
    _overlay.value = snap;
    _liveOverlaySeq.value += 1;

    if (snap.complete && _connected.value) {
      const liveBoxes = [...snap.spendableBoxes];
      _boxes = liveBoxes;
      _lastBoxFetch = Date.now();
      updateBalances(liveBoxes);
      _loading.value = false;
    }
  });

  // computed
  const balance = computed(() =>
    _balance.value.map((asset) => ({
      ...asset,
      metadata: chain.tokensMetadata[asset.tokenId],
      conversion: { rate: chain.priceRates[asset.tokenId]?.fiat, currency: "USD" }
    }))
  );
  const loading = computed(() => _loading.value);
  const changeAddress = computed(() => _changeAddress.value);
  const usedAddresses = computed(() => _usedAddresses.value);
  const unusedAddresses = computed(() => _unusedAddresses.value);
  const allAddresses = computed(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of [
      ...(_changeAddress.value ? [_changeAddress.value] : []),
      ..._usedAddresses.value,
      ..._unusedAddresses.value
    ]) {
      const clean = a.trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
    return out;
  });
  const connected = computed(() => _connected.value);
  const wallets = computed(() => _wallets.value);
  const connectedWallet = computed(() => _connectedWallet.value);

  const pendingBalance = computed<ReadonlyMap<string, bigint>>(
    () => _overlay.value.pendingBalance
  );
  const hasPendingTx = computed(() => _overlay.value.hasPendingTx);
  const liveOverlayActive = computed(() => _overlay.value.complete);
  const liveOverlaySeq = computed(() => _liveOverlaySeq.value);

  function attachHergmesRelay(relay: Relay | null) {
    if (_hergmesRelay.value === relay) return;
    _hergmesRelay.value = relay;
  }

  // Sync live Hergmes wallet address subscriptions whenever connection, addresses, or relay change
  watch(
    [connected, changeAddress, usedAddresses, unusedAddresses, _hergmesRelay],
    ([isConn, change, used, unused, relay]) => {
      if (isConn && relay && (change || used.length > 0 || unused.length > 0)) {
        _overlayManager.sync(relay, {
          changeAddress: change,
          usedAddresses: used,
          unusedAddresses: unused
        });
      } else {
        _overlayManager.clear();
      }
    },
    { immediate: true }
  );

  // watchers
  watch(
    () => chain.height,
    () => {
      if (!liveOverlayActive.value) {
        void getBoxes();
      }
    }
  );

  watch(balance, () => {
    if (some(_balance.value)) {
      chain.loadTokensMetadata(
        balance.value.filter((x) => isUndefined(x.metadata)).map((x) => x.tokenId)
      );
    }
  });

  // hooks
  onBeforeMount(async () => {
    addEventListener(WALLET_INJECTED_EVENT, lookupWallets);
    lookupWallets();
  });

  onUnmounted(() => removeEventListener(WALLET_INJECTED_EVENT, lookupWallets));

  async function lookupWallets() {
    if (typeof ergoConnector === "undefined") return;

    Object.keys(ergoConnector).map((key) => (_wallets.value[key] = true));
    const walletId = localStorage.getItem("connectedWallet");
    if (walletId) await connect(walletId);
  }

  // actions
  async function connect(walletName: "nautilus" | "safew" | string) {
    if (typeof ergoConnector === "undefined") {
      showToast("Ergo wallet not detected.", "alert-error");
      return;
    }

    const walletConnector = ergoConnector[walletName];
    if (!walletConnector) {
      showToast(`${walletName} wallet is not detected.`, "alert-error");
      disconnect();
      return;
    }

    const connected = await walletConnector.connect({ createErgoObject: false });
    if (connected) {
      _loading.value = true;
      _context = await walletConnector.getContext();
      const change = ErgoAddress.fromBase58(await _context.get_change_address());
      if (change.network !== getNetworkType()) {
        disconnect();
        showToast("Wrong wallet network.", "alert-error");
        return;
      }

      _connected.value = true;
      _connectedWallet.value = walletName;
      localStorage.setItem("connectedWallet", walletName);
      await _fetchData();
    } else {
      localStorage.removeItem("connectedWallet");
      _connectedWallet.value = undefined;
      _loading.value = false;
    }
  }

  async function disconnect() {
    const connector =
      typeof ergoConnector !== "undefined" && ergoConnector && _connectedWallet.value
        ? ergoConnector[_connectedWallet.value]
        : undefined;

    if (connector) {
      await connector.disconnect();
    }

    _loading.value = true;
    localStorage.removeItem("connectedWallet");
    _overlayManager.clear();
    _context = undefined;
    _usedAddresses.value = [];
    _unusedAddresses.value = [];
    _changeAddress.value = undefined;
    _balance.value = [];
    _connected.value = false;
    _boxes = [];
    _lastBoxFetch = 0;

    _loading.value = false;
  }

  async function _fetchData() {
    if (!_context) {
      return;
    }

    const [used, unused, change, ergBalance] = await Promise.all([
      _context.get_used_addresses(),
      _context.get_unused_addresses().catch(() => [] as string[]),
      _context.get_change_address(),
      _context.get_balance()
    ]);

    _usedAddresses.value = used;
    _unusedAddresses.value = unused;
    _changeAddress.value = change;

    if (!_overlay.value.complete) {
      _balance.value = [{ tokenId: ERG_TOKEN_ID, amount: ensureBigInt(ergBalance) }];
    }

    if (chain.height > 0 && !_overlay.value.complete) {
      void getBoxes();
    }
  }

  async function getBoxes(force = false) {
    if (!_context) {
      return [];
    }

    // Serve Hergmes live mempool-aware spendable UTXOs directly when full wallet coverage is live.
    if (!force && _overlay.value.complete) {
      const liveBoxes = [..._overlay.value.spendableBoxes];
      _boxes = liveBoxes;
      _lastBoxFetch = Date.now();
      updateBalances(liveBoxes);
      _loading.value = false;
      return _boxes;
    }

    if (!force && _boxes.length > 0 && Date.now() - _lastBoxFetch < 20000) {
      _loading.value = false;

      return _boxes;
    }

    _boxes = (await _context.get_utxos()) ?? [];
    _lastBoxFetch = Date.now();
    updateBalances(_boxes);

    _loading.value = false;

    return _boxes;
  }

  function updateBalances(boxes: Box<Amount>[]) {
    const sum = utxoSum(boxes);

    _balance.value = sum.tokens;
    _balance.value.unshift({ tokenId: ERG_TOKEN_ID, amount: sum.nanoErgs });
  }

  async function getChangeAddress() {
    if (!_context) {
      throw new Error("Wallet not connected.");
    }

    const changeAddress = await _context.get_change_address();
    if (_changeAddress.value !== changeAddress) {
      _changeAddress.value = changeAddress;
    }

    return changeAddress;
  }

  async function getUnusedAddresses() {
    if (!_context) {
      throw new Error("Wallet not connected.");
    }

    const addrs = await _context.get_unused_addresses().catch(() => [] as string[]);
    _unusedAddresses.value = addrs;
    return addrs;
  }

  async function getUsedAddresses() {
    if (!_context) {
      throw new Error("Wallet not connected.");
    }

    const addrs = await _context.get_used_addresses();
    _usedAddresses.value = addrs;
    return addrs;
  }

  async function getCurrentHeight() {
    if (_context) {
      try {
        const h = await _context.get_current_height();
        if (Number.isInteger(h) && h > 0) return h;
      } catch {
        // fallback to chainStore height
      }
    }
    return chain.height;
  }

  async function signTx(
    unsignedTx: EIP12UnsignedTransaction,
    options?: NautilusSignOptions
  ) {
    if (!_context) {
      throw new Error("Wallet not connected.");
    }

    if (options && options.signers) {
      return await _context.sign_tx(unsignedTx, options);
    }
    return await _context.sign_tx(unsignedTx);
  }

  async function submitTx(signedTx: SignedTransaction | FleetSignedTransaction) {
    if (!_context) {
      throw new Error("Wallet not connected.");
    }

    const txId = await _context.submit_tx(signedTx as SignedTransaction);
    // Invalidate UTXO cache so subsequent reads & chained batch fills see spent boxes immediately.
    _lastBoxFetch = 0;
    return txId;
  }

  return {
    connect,
    disconnect,
    attachHergmesRelay,
    getBoxes,
    getChangeAddress,
    getUsedAddresses,
    getUnusedAddresses,
    getCurrentHeight,
    signTx,
    submitTx,
    wallets,
    connectedWallet,
    loading,
    balance,
    pendingBalance,
    hasPendingTx,
    liveOverlayActive,
    liveOverlaySeq,
    changeAddress,
    connected,
    usedAddresses,
    unusedAddresses,
    allAddresses
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWalletStore, import.meta.hot));
}
