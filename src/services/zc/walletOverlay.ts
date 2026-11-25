import { Amount, Box } from "@fleet-sdk/common";
import { Subscription, SubscriptionState } from "@hergmes/sdk";
import { HergmesRelayLike } from "./hergmesClient";

export const WALLET_ERG_TOKEN_ID = "ERG";
export const MAX_WALLET_HERGMES_ADDRS = 15;
const MAX_UNUSED_OVERLAY_ADDRS = 2;

export interface WalletAddressInput {
  readonly changeAddress?: string;
  readonly usedAddresses: readonly string[];
  readonly unusedAddresses: readonly string[];
}

export interface TrackedWalletAddresses {
  readonly tracked: readonly string[];
  readonly allCount: number;
  readonly capped: boolean;
}

export interface WalletOverlaySnapshot {
  /** True iff all wallet addresses are tracked (<= cap) AND every subscription is `"live"`. */
  readonly complete: boolean;
  /** True iff at least one address is tracked and all tracked subscriptions are `"live"`. */
  readonly allLive: boolean;
  readonly trackedCount: number;
  readonly totalAddressCount: number;
  /** Signed mempool deltas: nanoERG under `ERG_TOKEN_ID` and token amounts under lowercase tokenId. */
  readonly pendingBalance: ReadonlyMap<string, bigint>;
  /** True if any tracked address has pending mempool txs or non-zero pending balance deltas. */
  readonly hasPendingTx: boolean;
  /** Deduplicated live spendable UTXOs across tracked addresses, ready for Fleet / Nautilus signing. */
  readonly spendableBoxes: readonly Box<Amount>[];
}

export const EMPTY_WALLET_OVERLAY: WalletOverlaySnapshot = {
  complete: false,
  allLive: false,
  trackedCount: 0,
  totalAddressCount: 0,
  pendingBalance: new Map<string, bigint>(),
  hasPendingTx: false,
  spendableBoxes: []
};

/**
 * Selects up to `maxAddresses` (default 15) wallet addresses to subscribe over the shared
 * Hergmes WebSocket so large HD wallets stay well under the relay's 100-subscription limit.
 * Priority: `changeAddress` first, then most recently used addresses, then up to 2 unused
 * addresses (and all remaining addresses whenever total <= `maxAddresses`).
 */
export function selectTrackedWalletAddresses(
  input: WalletAddressInput,
  maxAddresses = MAX_WALLET_HERGMES_ADDRS
): TrackedWalletAddresses {
  const allUnique = new Set<string>();
  const addUnique = (addr: string | undefined) => {
    const clean = addr?.trim();
    if (clean) allUnique.add(clean);
  };

  addUnique(input.changeAddress);
  for (const a of input.usedAddresses) addUnique(a);
  for (const a of input.unusedAddresses) addUnique(a);

  const allCount = allUnique.size;
  if (allCount === 0 || maxAddresses <= 0) {
    return { tracked: [], allCount, capped: allCount > 0 };
  }

  const tracked: string[] = [];
  const picked = new Set<string>();
  const pick = (addr: string | undefined): boolean => {
    if (tracked.length >= maxAddresses) return false;
    const clean = addr?.trim();
    if (!clean || picked.has(clean)) return false;
    picked.add(clean);
    tracked.push(clean);
    return true;
  };

  // 1. Change address always first
  pick(input.changeAddress);

  // 2. Most recently used addresses (reverse order of EIP-12 derivation index list)
  for (let i = input.usedAddresses.length - 1; i >= 0; i--) {
    if (tracked.length >= maxAddresses) break;
    pick(input.usedAddresses[i]);
  }

  // 3. Unused addresses (all fit if total <= maxAddresses; otherwise up to 2 if room remains)
  let unusedAdded = 0;
  const unusedBudget = allCount <= maxAddresses ? maxAddresses : MAX_UNUSED_OVERLAY_ADDRS;
  for (const a of input.unusedAddresses) {
    if (tracked.length >= maxAddresses || unusedAdded >= unusedBudget) break;
    if (pick(a)) unusedAdded++;
  }

  return {
    tracked,
    allCount,
    capped: allCount > maxAddresses
  };
}

function toFleetAmountBox(box: Box<bigint>): Box<Amount> {
  const regs: Record<string, string> = {};
  if (box.additionalRegisters) {
    for (const [k, v] of Object.entries(box.additionalRegisters)) {
      if (typeof v === "string" && v.length > 0) regs[k] = v;
    }
  }
  return {
    boxId: box.boxId,
    transactionId: box.transactionId,
    index: box.index,
    ergoTree: box.ergoTree,
    creationHeight: box.creationHeight,
    value: box.value.toString(),
    assets: box.assets.map((a) => ({
      tokenId: a.tokenId,
      amount: a.amount.toString()
    })),
    additionalRegisters: regs
  };
}

/**
 * Aggregates live Hergmes subscriptions for tracked wallet addresses into confirmed+pending
 * spendable UTXOs and signed mempool balance deltas.
 */
export function aggregateWalletOverlay(
  entries: readonly { readonly address: string; readonly state: SubscriptionState }[],
  totalAddressCount: number,
  maxAddresses = MAX_WALLET_HERGMES_ADDRS
): WalletOverlaySnapshot {
  if (entries.length === 0 || totalAddressCount === 0) {
    return {
      ...EMPTY_WALLET_OVERLAY,
      totalAddressCount
    };
  }

  const allLive = entries.every((e) => e.state.phase === "live");
  const complete = allLive && totalAddressCount <= maxAddresses && entries.length === totalAddressCount;

  const pendingBalance = new Map<string, bigint>();
  let pendingErg = 0n;
  let hasPendingBoxes = false;
  const spendableById = new Map<string, Box<Amount>>();

  for (const entry of entries) {
    if (entry.state.phase !== "live") continue;

    const bal = entry.state.balance;
    if (bal) {
      pendingErg += bal.pending.nanoErgs;
      for (const [tokenId, delta] of bal.pending.tokens) {
        if (delta === 0n) continue;
        const low = tokenId.toLowerCase();
        pendingBalance.set(low, (pendingBalance.get(low) ?? 0n) + delta);
      }
    }

    const view = entry.state.boxes;
    if (view) {
      if (view.pending.length > 0) hasPendingBoxes = true;
      for (const box of view.spendable) {
        const id = box.boxId.toLowerCase();
        if (!spendableById.has(id)) {
          spendableById.set(id, toFleetAmountBox(box));
        }
      }
    }
  }

  if (pendingErg !== 0n) {
    pendingBalance.set(WALLET_ERG_TOKEN_ID, pendingErg);
  }
  for (const [id, amt] of Array.from(pendingBalance.entries())) {
    if (amt === 0n) pendingBalance.delete(id);
  }

  const hasPendingTx = hasPendingBoxes || pendingBalance.size > 0;

  return {
    complete,
    allLive,
    trackedCount: entries.length,
    totalAddressCount,
    pendingBalance,
    hasPendingTx,
    spendableBoxes: Array.from(spendableById.values())
  };
}

interface WalletSubSlot {
  readonly address: string;
  readonly subscription: Subscription;
  unsubscribe: () => void;
  state: SubscriptionState;
}

/**
 * Manages live Hergmes address subscriptions for a connected Nautilus wallet over the
 * shared `Relay` WebSocket, diffing address lists to avoid unnecessary re-snapshots.
 */
export class ZcWalletOverlayManager {
  private relay: HergmesRelayLike | null = null;
  private slots = new Map<string, WalletSubSlot>();
  private totalAddressCount = 0;
  private snapshot: WalletOverlaySnapshot = EMPTY_WALLET_OVERLAY;
  private syncing = false;
  private readonly maxAddresses: number;
  private readonly onChange: (snapshot: WalletOverlaySnapshot) => void;

  constructor(
    onChange: (snapshot: WalletOverlaySnapshot) => void,
    maxAddresses = MAX_WALLET_HERGMES_ADDRS
  ) {
    this.onChange = onChange;
    this.maxAddresses = maxAddresses;
  }

  getSnapshot(): WalletOverlaySnapshot {
    return this.snapshot;
  }

  sync(relay: HergmesRelayLike | null, addresses: WalletAddressInput | null): void {
    if (!relay || !addresses) {
      this.clear();
      return;
    }

    const selection = selectTrackedWalletAddresses(addresses, this.maxAddresses);
    if (selection.tracked.length === 0) {
      this.clear();
      return;
    }

    const relayChanged = this.relay !== relay;
    this.syncing = true;
    try {
      if (relayChanged) {
        this.closeAllSlots();
        this.relay = relay;
      }

      this.totalAddressCount = selection.allCount;
      const desired = new Set(selection.tracked);

      // Release holds no longer needed
      for (const [addr, slot] of Array.from(this.slots.entries())) {
        if (!desired.has(addr)) {
          slot.unsubscribe();
          slot.subscription.close();
          this.slots.delete(addr);
        }
      }

      // Open holds for newly tracked addresses
      for (const addr of selection.tracked) {
        if (this.slots.has(addr)) continue;
        const subscription = relay.subscribe({ address: addr }, { boxes: true });
        const slot: WalletSubSlot = {
          address: addr,
          subscription,
          unsubscribe: () => undefined,
          state: subscription.state
        };
        slot.unsubscribe = subscription.subscribe((nextState) => {
          if (this.slots.get(addr) !== slot) return;
          slot.state = nextState;
          if (!this.syncing) {
            this.recompute();
          }
        });
        this.slots.set(addr, slot);
      }
    } finally {
      this.syncing = false;
    }

    this.recompute();
  }

  clear(): void {
    const hadAny =
      this.relay !== null ||
      this.slots.size > 0 ||
      this.snapshot !== EMPTY_WALLET_OVERLAY;
    this.closeAllSlots();
    this.relay = null;
    this.totalAddressCount = 0;
    this.snapshot = EMPTY_WALLET_OVERLAY;
    if (hadAny) {
      this.onChange(this.snapshot);
    }
  }

  dispose(): void {
    this.clear();
  }

  private closeAllSlots(): void {
    for (const slot of this.slots.values()) {
      slot.unsubscribe();
      slot.subscription.close();
    }
    this.slots.clear();
  }

  private recompute(): void {
    const entries = Array.from(this.slots.values()).map((s) => ({
      address: s.address,
      state: s.state
    }));
    this.snapshot = aggregateWalletOverlay(entries, this.totalAddressCount, this.maxAddresses);
    this.onChange(this.snapshot);
  }
}
