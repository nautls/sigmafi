/**
 * ============================================================================
 * SIGMAFI V2 (zcs1) — ISOLATED ERGOTREE V3 TRANSACTION SUBSYSTEM
 * ============================================================================
 *
 * Security Audit Map (zero Vue/Pinia/DOM imports in this directory):
 *
 *  1. types.ts      — Exhaustive 19-action union, quote/build types, refusal/conflict/invariant errors.
 *  2. encoding.ts   — Pure Sigma register & context-var encoders (`@fleet-sdk/serializer`) + ErgoBox wire bytes.
 *  3. metadata.ts   — Pure BigInt zcs1 EIP-4 metadata generator (`bond`, `shares`, `receipt`).
 *  4. funding.ts    — Network-verified wallet address book, auth-box picker, `avoidTokens` coin selector, `var 64` disclosure.
 *  5. signers.ts    — Nautilus v2.0.0-beta.3+ ErgoTree v3 explicit per-input `signers` map (`null` for protocol inputs, verified Base58 for wallet inputs).
 *  6. invariants.ts — Independent post-build safety gate (ERG conservation, fee bounds, exact token burn/mint check, verified signers & destinations, `limits` slippage check).
 *  7. builders.ts   — Pure 1-to-1 port of `ZcUserTransactions.scala` (6 box builders, 14 spend builders, 3 assemblers).
 *  8. planner.ts    — 1-to-1 port of `ZcWriteExecution.scala` (`quoteZcAction`, `buildZcAction`, `signAndSubmitZcAction`, `resolveWalletLendStep`, `formatNautilusError`).
 * ============================================================================
 */
export * from "./types";
export * from "./encoding";
export * from "./metadata";
export * from "./funding";
export * from "./signers";
export * from "./invariants";
export * from "./builders";
export * from "./planner";
