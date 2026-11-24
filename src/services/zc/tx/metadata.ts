/**
 * SECURITY AUDIT BOUNDARY: Deterministic zcs1 EIP-4 token metadata generator.
 *
 * Exact 1-to-1 TypeScript port of Lithos-Client's `ZcMetadata.scala`.
 * Uses pure BigInt decimal formatting so every client writes identical bytes
 * with zero floating-point rounding drift.
 *
 * Display only: protocol contracts never verify security properties from metadata.
 */
import { LONG_MAX } from "../boxes";
import { marketTokenId } from "../contracts";
import { ZcShareAuctionDraft } from "../drafts";
import { SHARE_COUNT } from "../pricing";
import { ZcRuleKind } from "../rules";
import { ZcMarket } from "@/types/zc";

export const ZCS_META_VERSION = "1";
export const ZCS_SHARE_DECIMALS = "6";
export const ZCS_BOND_DECIMALS = "0";
export const ZCS_VERIFY_NOTE = "Verify on chain.";

export type MetadataField = readonly [key: string, jsonValue: string];

export interface ZcBondMetadataFacts {
  readonly market: ZcMarket;
  readonly asset: string;
  readonly principal: bigint;
  readonly repayment: bigint;
  readonly start: bigint;
  readonly maturity: bigint;
  readonly rule: readonly MetadataField[];
}

export function marketUnitDecimals(market: ZcMarket): number {
  return marketTokenId(market) === null ? 9 : 2;
}

/**
 * Exact BigInt decimal formatting matching Java `BigDecimal.stripTrailingZeros.toPlainString`:
 * no trailing zeros, no trailing decimal point, no grouping separators.
 */
export function formatPlainDecimal(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const sign = raw < 0n ? "-" : "";
  const abs = raw < 0n ? -raw : raw;
  if (decimals <= 0) return `${sign}${abs.toString()}`;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const rem = abs % scale;
  if (rem === 0n) return `${sign}${whole.toString()}`;
  const frac = rem.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}.${frac}`;
}

/** A raw amount in the market's unit: no trailing zeros, no trailing point, no separators. */
export function formatMarketNumber(raw: bigint, market: ZcMarket): string {
  return formatPlainDecimal(raw, marketUnitDecimals(market));
}

/** Basis points as a percentage: 9000 -> "90", 9050 -> "90.5". */
export function formatPercentBps(bps: bigint): string {
  return formatPlainDecimal(bps, 2);
}

export function shortId6(id: string): string {
  return id.slice(0, 6).toLowerCase();
}

function jsonStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function compactJson(fields: readonly MetadataField[]): string {
  return `{${fields.map(([k, v]) => `${jsonStr(k)}:${v}`).join(",")}}`;
}

export function ruleFields(
  rule: ZcRuleKind,
  payload: readonly bigint[],
  liqHash: string
): MetadataField[] {
  if (rule === "maturity") {
    return [["rule", jsonStr("maturity")]];
  }
  if (rule === "oracle" && payload.length > 0) {
    return [
      ["rule", jsonStr("oracle")],
      ["ratio", formatPercentBps(payload[0])]
    ];
  }
  return [
    ["rule", jsonStr("other")],
    ["ruleHash", jsonStr(liqHash.slice(0, 8))]
  ];
}

function bondTermFields(f: ZcBondMetadataFacts): MetadataField[] {
  return [
    ["principal", formatMarketNumber(f.principal, f.market)],
    ["repayment", formatMarketNumber(f.repayment, f.market)],
    ["start", f.start.toString()],
    ["maturity", f.maturity.toString()],
    ...f.rule
  ];
}

/** A bond unit's EIP-4 `(name, description, decimals)` triple. */
export function bondMetadata(f: ZcBondMetadataFacts): [string, string, string] {
  return [
    `ZCS-Bond-Unit-${shortId6(f.asset)}`,
    compactJson([
      ["zcs", ZCS_META_VERSION],
      ["type", jsonStr("bond unit")],
      ["market", jsonStr(f.market)],
      ...bondTermFields(f),
      ["note", jsonStr(ZCS_VERIFY_NOTE)]
    ]),
    ZCS_BOND_DECIMALS
  ];
}

/** Shares' EIP-4 `(name, description, decimals)` triple, naming the bond only when known. */
export function sharesMetadata(
  market: ZcMarket,
  auction: ZcShareAuctionDraft | null,
  bond: ZcBondMetadataFacts | null
): [string, string, string] {
  const whole = formatPlainDecimal(SHARE_COUNT, Number(ZCS_SHARE_DECIMALS));
  const selective = auction !== null && auction.threshold !== LONG_MAX;
  const kind = auction === null ? "shares" : selective ? "selective shares" : "auction shares";

  const head: MetadataField[] = [
    ["zcs", ZCS_META_VERSION],
    ["type", jsonStr(kind)],
    ["shares", whole]
  ];
  const what: MetadataField[] =
    bond === null
      ? [
          ["market", jsonStr(market)],
          ["via", jsonStr("lend offer")]
        ]
      : [
          ["bond", jsonStr(shortId6(bond.asset))],
          ["market", jsonStr(market)],
          ...bondTermFields(bond)
        ];

  const sale: MetadataField[] =
    auction === null
      ? []
      : [
          [
            "auction",
            compactJson([
              ["from", formatPercentBps(auction.openingBps)],
              ["to", formatPercentBps(auction.floorBps)],
              ["blocks", auction.length.toString()],
              ["expiry", auction.expiry.toString()],
              ...(selective ? ([["threshold", auction.threshold.toString()]] as MetadataField[]) : [])
            ])
          ]
        ];

  const name = `ZCS-Bond-Shares${bond === null ? "" : `-${shortId6(bond.asset)}`}`;
  return [
    name,
    compactJson([...head, ...what, ...sale, ["note", jsonStr(ZCS_VERIFY_NOTE)]]),
    ZCS_SHARE_DECIMALS
  ];
}

/** A wrap receipt's EIP-4 `(name, description, decimals)` triple. */
export function receiptMetadata(wrapped: string, amount: bigint): [string, string, string] {
  return [
    `ZCS-Wrap-${shortId6(wrapped)}`,
    compactJson([
      ["zcs", ZCS_META_VERSION],
      ["type", jsonStr("wrap receipt")],
      ["token", jsonStr(wrapped)],
      ["amount", amount.toString()],
      ["note", jsonStr(ZCS_VERIFY_NOTE)]
    ]),
    "0"
  ];
}
