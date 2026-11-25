import {
  ZcAskSummary,
  ZcAuctionLotSummary,
  ZcAuctionVaultSummary,
  ZcBondSummary,
  ZcCollateralToken,
  ZcLookupResult,
  ZcMatchesResponse,
  ZcOfferSummary,
  ZcPortfolioMintRequest,
  ZcPortfolioPosition,
  ZcPortfolioState,
  ZcPortfolioWrap,
  ZcWalletToken
} from "@/types/zc";
import {
  DAY_BLOCKS,
  priceForYield,
  SHARES_UNITS,
  SIGUSD_TOKEN_ID
} from "@/utils/zcMath";

// Real Ergo mainnet verified token IDs so AssetIcon renders authentic logos
const SIGRSV_ID = "003bd19d0187117f130b62e1bcab0939929ff5c7709f843c5c4dd158949285d0";
const RSN_ID = "8b08cdd5449a9592a9e79711d7d79249d7a03c535d17efaee83e216e80a44c4b";
const RSADA_ID = "e023c5f382b6e96fbd878f6811aac73345489032157ad5affb84aefd4956c297";
const RSBTC_ID = "7a51950e5f548549ec1aa63ffdc38279505b11e7e803d01bcf8347e0123c88b0";
const SPF_ID = "9a06d9e545a41fd51eeffc5e20d818073bf820c635e2a9d922269913e0de369d";
const ERGOPAD_ID = "d71693c49a84fbbecd4908c94813b46514b18b67a99952dc1e6e4791556de413";
const GAU_ID = "886b7721bef42f60c6317d37d8752da8aca01898cae7dae61808c4a14225edc8";

function hexId(tag: string): string {
  const clean = tag.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return (clean + "a7c3e910f4b28d56e109c3b7a4f2816de590c4b3a871f265d90e3c7a1b4f82e6").slice(0, 64);
}

export const DEMO_IDS = {
  bondLend1: hexId("11a0b1"),
  bondLendShares: hexId("22b0c2"),
  bondSelfHeld: hexId("33c0d3"),
  bondRepaid: hexId("44d0e4"),
  bondPullNeeded: hexId("55e0f5"),
  bondBorrowHealthy: hexId("66f0a6"),
  bondBorrowWarn: hexId("77a1b7"),
  orderBorrowOpen: hexId("88b2c8"),
  askResaleOpen: hexId("99c3d9"),
  offerSigUsd: hexId("aa14ea"),
  offerErg: hexId("bb25fb"),
  lotFalling: hexId("cc360c"),
  lotBuyback: hexId("dd471d"),
  lotMine: hexId("ee582e"),
  lotWrap: hexId("ff693f"),
  vaultSelective: hexId("1234ab"),
  vaultDutch: hexId("2345bc"),
  vaultExcess: hexId("3456cd"),
  mintReq1: hexId("4567de"),
  wrapReceipt1: hexId("5678ef"),
  wrapInner1: hexId("6789f0"),
  wrapReqBox: hexId("7890a1"),
  wrapInner2: hexId("8901b2"),
  wrapPledgedReceipt: hexId("9012c3"),
  wrapInner3: hexId("a123d4"),
  rawLpNft: hexId("b234e5")
};

function tok(
  id: string,
  ticker: string,
  amount: number,
  decimals: number,
  kind: ZcCollateralToken["kind"] = "token",
  name?: string,
  extra?: Partial<ZcCollateralToken>
): ZcCollateralToken {
  return {
    id,
    ticker,
    name: name || ticker,
    decimals,
    amount,
    rawAmount: String(Math.round(amount * 10 ** decimals)),
    kind,
    verified: true,
    ...extra
  };
}

export interface ZcDemoDataset {
  lots: ZcAuctionLotSummary[];
  vaults: ZcAuctionVaultSummary[];
  portfolio: ZcPortfolioState;
  lookupById: Map<string, ZcLookupResult>;
  matchesById: Map<string, ZcMatchesResponse>;
}

export function buildMockDataset(rawHeight: number, rawOracle: number): ZcDemoDataset {
  const h = rawHeight > 100_000 ? rawHeight : 1_650_000;
  const px = rawOracle > 0.05 ? rawOracle : 1.42;

  // --- Bonds ---
  const bLend1: ZcBondSummary = {
    id: DEMO_IDS.bondLend1,
    state: "live",
    market: "SigUSD",
    principal: 1385,
    repayment: 1500,
    start: h - 170 * DAY_BLOCKS,
    maturity: h + 195 * DAY_BLOCKS,
    collateral: {
      erg: Number(((1500 * 1.84) / px).toFixed(2)),
      usd: 0,
      tokens: [tok(RSN_ID, "RSN", 1250, 3, "token", "Rosen Bridge")]
    },
    rule: "oracle",
    ratio: 150,
    oracleAge: 60,
    cov: 184,
    vault: null,
    checks: [
      { key: "origin", ok: true, detail: "Verified zcs1 origin transaction" },
      { key: "terms", ok: true, detail: "Oracle cover 184% ≥ 150% ratio" }
    ]
  };

  const bLendShares: ZcBondSummary = {
    id: DEMO_IDS.bondLendShares,
    state: "live",
    market: "ERG",
    principal: 740,
    repayment: 800,
    start: h - 108 * DAY_BLOCKS,
    maturity: h + 72 * DAY_BLOCKS,
    collateral: {
      erg: 0.01,
      usd: Number((800 * px * 1.62).toFixed(2)),
      tokens: [tok(SPF_ID, "SPF", 8500, 6, "token", "Spectrum")]
    },
    rule: "oracle",
    ratio: 150,
    oracleAge: 60,
    cov: 162,
    vault: "selective",
    checks: [
      { key: "origin", ok: true, detail: "Verified zcs1 fractional vault" },
      { key: "terms", ok: true, detail: "Selective recovery auction 200% → 90%" }
    ]
  };

  const bSelfHeld: ZcBondSummary = {
    id: DEMO_IDS.bondSelfHeld,
    state: "live",
    market: "SigUSD",
    principal: 555,
    repayment: 600,
    start: h - 60 * DAY_BLOCKS,
    maturity: h + 120 * DAY_BLOCKS,
    collateral: {
      erg: Number(((600 * 1.78) / px).toFixed(2)),
      usd: 0,
      tokens: []
    },
    rule: "oracle",
    ratio: 150,
    oracleAge: 60,
    cov: 178,
    vault: null,
    mine: true,
    borrowedByMe: true,
    checks: [
      { key: "origin", ok: true, detail: "Verified zcs1 bond" },
      { key: "extinguish", ok: true, detail: "Wallet holds circulating bond unit" }
    ]
  };

  const bRepaid: ZcBondSummary = {
    id: DEMO_IDS.bondRepaid,
    state: "repaid",
    market: "ERG",
    principal: 462,
    repayment: 500,
    start: h - 180 * DAY_BLOCKS,
    maturity: h - 2 * DAY_BLOCKS,
    collateral: { erg: 0.01, usd: 0, tokens: [] },
    rule: "oracle",
    ratio: 150,
    oracleAge: 60,
    cov: null,
    vault: null,
    settlement: { ERG: 500 }
  };

  const bPullNeeded: ZcBondSummary = {
    id: DEMO_IDS.bondPullNeeded,
    state: "liquidated",
    market: "SigUSD",
    principal: 820,
    repayment: 900,
    start: h - 210 * DAY_BLOCKS,
    maturity: h + 15 * DAY_BLOCKS,
    collateral: { erg: 120, usd: 420, tokens: [] },
    rule: "oracle",
    ratio: 150,
    oracleAge: 60,
    cov: 112,
    vault: "dutch"
  };

  const wrapPledgedTok = tok(
    DEMO_IDS.wrapPledgedReceipt,
    "ZCS-Wrap-a123d4",
    1,
    0,
    "receipt",
    "rsBTC / ERG LP Custody Receipt",
    {
      wraps: {
        id: DEMO_IDS.wrapInner3,
        ticker: "rsBTC/ERG LP",
        name: "LithosDex rsBTC/ERG LP NFT",
        description:
          "Concentrated liquidity provision NFT for the rsBTC / ERG (0.30% fee tier) pool. Grants withdrawal & accrued swap-fee claim rights to whoever unwraps this receipt.",
        decimals: 0,
        amount: 1,
        rawAmount: "1",
        kind: "provision",
        vaultBoxId: hexId("va33"),
        refreshFrom: h + 210 * DAY_BLOCKS,
        state: "wrapped"
      }
    }
  );

  const bBorrowHealthy: ZcBondSummary = {
    id: DEMO_IDS.bondBorrowHealthy,
    state: "live",
    market: "SigUSD",
    principal: 2210,
    repayment: 2400,
    start: h - 42 * DAY_BLOCKS,
    maturity: h + 48 * DAY_BLOCKS,
    collateral: {
      erg: Number(((2400 * 1.48) / px).toFixed(2)),
      usd: 1200,
      tokens: [
        tok(SIGRSV_ID, "SigRSV", 1_450_000, 0, "token", "SigRSV"),
        tok(DEMO_IDS.bondLend1, "SigUSD Bond Unit", 1, 0, "bond", "SigUSD Bond Unit", {
          bondId: DEMO_IDS.bondLend1
        }),
        wrapPledgedTok
      ]
    },
    rule: "oracle",
    ratio: 150,
    oracleAge: 60,
    cov: 198,
    vault: null,
    mine: true,
    borrowedByMe: true
  };

  const bBorrowWarn: ZcBondSummary = {
    id: DEMO_IDS.bondBorrowWarn,
    state: "live",
    market: "ERG",
    principal: 600,
    repayment: 650,
    start: h - 85 * DAY_BLOCKS,
    maturity: h + 19 * DAY_BLOCKS,
    collateral: {
      erg: 0.01,
      usd: Number((650 * px * 1.64).toFixed(2)),
      tokens: [tok(RSBTC_ID, "rsBTC", 0.0125, 8, "token", "Rosen BTC")]
    },
    rule: "oracle",
    ratio: 150,
    oracleAge: 60,
    cov: 164,
    vault: null,
    mine: true,
    borrowedByMe: true
  };

  // --- Positions ---
  const lendPositions: ZcPortfolioPosition[] = [
    {
      id: DEMO_IDS.bondLend1,
      tokenId: DEMO_IDS.bondLend1,
      side: "lend",
      kind: "unit",
      units: 1,
      unitsRaw: "1",
      borrowedByMe: false,
      status: "live",
      bond: bLend1,
      paid: 1385,
      at: h - 170 * DAY_BLOCKS,
      via: DEMO_IDS.offerSigUsd,
      mark: {
        basis: "bid",
        bid: 840,
        value: Number(priceForYield(1500, 840, 195 * DAY_BLOCKS).toFixed(2)),
        pnl: Number((priceForYield(1500, 840, 195 * DAY_BLOCKS) - 1385).toFixed(2)),
        entry: 830,
        atMaturity: 115
      },
      actions: {}
    },
    {
      id: DEMO_IDS.bondLendShares,
      tokenId: DEMO_IDS.bondLendShares,
      side: "lend",
      kind: "shares",
      units: Math.round(SHARES_UNITS * 0.45),
      unitsRaw: String(Math.round(SHARES_UNITS * 0.45)),
      borrowedByMe: false,
      status: "live",
      bond: bLendShares,
      shares: {
        tokenId: DEMO_IDS.bondLendShares,
        bondId: DEMO_IDS.bondLendShares,
        type: "selective"
      },
      paid: 334,
      at: h - 108 * DAY_BLOCKS,
      via: DEMO_IDS.offerErg,
      mark: {
        basis: "bid",
        bid: 920,
        value: Number(priceForYield(360, 920, 72 * DAY_BLOCKS).toFixed(3)),
        pnl: Number((priceForYield(360, 920, 72 * DAY_BLOCKS) - 334).toFixed(3)),
        entry: 1579,
        atMaturity: 26
      },
      actions: {}
    },
    {
      id: DEMO_IDS.bondSelfHeld,
      tokenId: DEMO_IDS.bondSelfHeld,
      side: "lend",
      kind: "unit",
      units: 1,
      unitsRaw: "1",
      borrowedByMe: true,
      status: "live",
      bond: bSelfHeld,
      paid: 550,
      at: h - 25 * DAY_BLOCKS,
      mark: {
        basis: "bid",
        bid: 880,
        value: Number(priceForYield(600, 880, 120 * DAY_BLOCKS).toFixed(2)),
        pnl: Number((priceForYield(600, 880, 120 * DAY_BLOCKS) - 550).toFixed(2)),
        entry: 2290,
        atMaturity: 50
      },
      actions: {
        extinguish: { name: "extinguish", enabled: true, reason: null }
      }
    },
    {
      id: DEMO_IDS.bondRepaid,
      tokenId: DEMO_IDS.bondRepaid,
      side: "lend",
      kind: "unit",
      units: 1,
      unitsRaw: "1",
      borrowedByMe: false,
      status: "claimable",
      bond: bRepaid,
      paid: 462,
      at: h - 180 * DAY_BLOCKS,
      via: DEMO_IDS.offerErg,
      settlement: { ERG: 500 },
      mark: {
        basis: "settled",
        bid: null,
        value: 500,
        pnl: 38,
        entry: 1668,
        atMaturity: 38
      },
      actions: {
        claim: { name: "claim", enabled: true, reason: null }
      }
    },
    {
      id: DEMO_IDS.bondPullNeeded,
      tokenId: DEMO_IDS.bondPullNeeded,
      side: "lend",
      kind: "shares",
      units: Math.round(SHARES_UNITS * 0.3),
      unitsRaw: String(Math.round(SHARES_UNITS * 0.3)),
      borrowedByMe: false,
      status: "pullNeeded",
      bond: bPullNeeded,
      vaultId: DEMO_IDS.vaultDutch,
      paid: 246,
      at: h - 210 * DAY_BLOCKS,
      actions: {
        pull: { name: "pull", enabled: true, reason: null }
      }
    }
  ];

  const borrowPositions: ZcPortfolioPosition[] = [
    {
      id: DEMO_IDS.bondBorrowHealthy,
      side: "borrow",
      kind: "unit",
      units: 1,
      holdsUnit: false,
      borrowedByMe: true,
      status: "live",
      bond: bBorrowHealthy,
      actions: {
        repay: { name: "repay", enabled: true, reason: null },
        recollateralize: { name: "recollateralize", enabled: true, reason: null }
      }
    },
    {
      id: DEMO_IDS.bondBorrowWarn,
      side: "borrow",
      kind: "unit",
      units: 1,
      holdsUnit: false,
      borrowedByMe: true,
      status: "live",
      bond: bBorrowWarn,
      actions: {
        repay: { name: "repay", enabled: true, reason: null },
        recollateralize: { name: "recollateralize", enabled: true, reason: null }
      }
    },
    {
      id: DEMO_IDS.bondSelfHeld,
      side: "borrow",
      kind: "unit",
      units: 1,
      holdsUnit: true,
      borrowedByMe: true,
      status: "live",
      bond: bSelfHeld,
      actions: {
        repay: { name: "repay", enabled: true, reason: null },
        recollateralize: { name: "recollateralize", enabled: true, reason: null },
        extinguish: { name: "extinguish", enabled: true, reason: null }
      }
    }
  ];

  // --- Open Orders / Asks / Offers ---
  const openOrder: ZcAskSummary = {
    id: DEMO_IDS.orderBorrowOpen,
    boxId: DEMO_IDS.orderBorrowOpen,
    chainId: DEMO_IDS.orderBorrowOpen,
    txId: null,
    created: h - 180,
    market: "SigUSD",
    kind: "order",
    contract: "PricedOrder",
    pricing: "yield",
    mode: "term",
    maturity: null,
    duration: 365 * DAY_BLOCKS,
    window: null,
    points: null,
    cap: null,
    principal: 1000,
    repayment: 1095,
    price: null,
    floor: 0,
    tp: { h0: h - 180, y0: 920, h1: h + 6 * DAY_BLOCKS, y1: 1040 },
    units: 1,
    minFill: 1,
    collateral: {
      erg: Number(((1095 * 1.75) / px).toFixed(2)),
      usd: 0,
      tokens: []
    },
    bond: null,
    cov: 175,
    status: "ok",
    reasons: [],
    reason: null,
    ok: true,
    pending: false,
    owner: true,
    borrowedByMe: true,
    quote: {
      d: 365 * DAY_BLOCKS,
      maturity: h + 365 * DAY_BLOCKS,
      cost: 1000,
      face: 1095,
      yieldBps: 950,
      quotedYieldBps: 950,
      pct: 91.32
    },
    rule: "oracle",
    ratio: 150,
    oracleAge: 60,
    guard: { ratio: 160, age: 60 },
    expiry: h + 6 * DAY_BLOCKS,
    expiryFee: 0.005,
    checks: [{ key: "terms", ok: true, detail: "Valid zcs1 moving-APR borrow order" }]
  };

  const openAsk: ZcAskSummary = {
    id: DEMO_IDS.askResaleOpen,
    boxId: DEMO_IDS.askResaleOpen,
    chainId: DEMO_IDS.askResaleOpen,
    txId: null,
    created: h - 420,
    market: "ERG",
    kind: "shares",
    contract: "ShareAsk",
    pricing: "yield",
    mode: "fixed",
    maturity: bLendShares.maturity,
    duration: null,
    window: null,
    points: null,
    cap: null,
    principal: null,
    repayment: 200,
    price: null,
    floor: 185,
    tp: { h0: h - 420, y0: 880, h1: h + 5 * DAY_BLOCKS, y1: 960 },
    units: Math.round(SHARES_UNITS * 0.25),
    minFill: Math.round(SHARES_UNITS * 0.05),
    collateral: bLendShares.collateral,
    bond: bLendShares,
    cov: 162,
    status: "ok",
    reasons: [],
    reason: null,
    ok: true,
    pending: false,
    owner: true,
    borrowedByMe: false,
    quote: {
      d: 72 * DAY_BLOCKS,
      maturity: bLendShares.maturity,
      cost: Number(priceForYield(200, 905, 72 * DAY_BLOCKS).toFixed(3)),
      face: 200,
      yieldBps: 905,
      quotedYieldBps: 905,
      pct: 98.24
    },
    rule: "oracle",
    ratio: 150,
    oracleAge: 60,
    guard: { ratio: 155, age: 30 },
    expiry: h + 5 * DAY_BLOCKS,
    expiryFee: 0.002,
    checks: [{ key: "terms", ok: true, detail: "Valid zcs1 share resale listing" }]
  };

  const offerSigUsd: ZcOfferSummary = {
    id: DEMO_IDS.offerSigUsd,
    boxId: DEMO_IDS.offerSigUsd,
    chainId: DEMO_IDS.offerSigUsd,
    txId: null,
    created: h - 20 * DAY_BLOCKS,
    market: "SigUSD",
    capital: 2615,
    funded: 4000,
    boxErg: 0.48,
    minYieldBps: 750,
    minBlocks: 7 * DAY_BLOCKS,
    maxBlocks: 365 * DAY_BLOCKS,
    floor: 150,
    oracleAge: 30,
    fee: 0.005,
    reserve: 0.05,
    rewardNow: 0.005,
    minPrice: null,
    expiry: h + 42 * DAY_BLOCKS,
    delivery: "unit",
    shares: { floor: 9000, expiry: 2160 },
    tokenBudget: {
      originalCapital: 4000,
      totalErgBudget: 0.5,
      minFillBps: 100,
      rewardBudget: 0.1
    },
    status: "ok",
    reasons: [],
    reason: null,
    ok: true,
    pending: false,
    owner: true,
    points: [
      { d: 7 * DAY_BLOCKS, y: 760 },
      { d: 30 * DAY_BLOCKS, y: 840 },
      { d: 90 * DAY_BLOCKS, y: 950 },
      { d: 180 * DAY_BLOCKS, y: 1060 },
      { d: 365 * DAY_BLOCKS, y: 1180 }
    ],
    checks: [
      { key: "origin", ok: true, detail: "Verified zcs1 rolling lend offer" },
      { key: "budget", ok: true, detail: "ERG batcher reward budget funded" }
    ]
  };

  const offerErg: ZcOfferSummary = {
    id: DEMO_IDS.offerErg,
    boxId: DEMO_IDS.offerErg,
    chainId: DEMO_IDS.offerErg,
    txId: null,
    created: h - 12 * DAY_BLOCKS,
    market: "ERG",
    capital: 1180,
    funded: 2000,
    boxErg: 1180.05,
    minYieldBps: 650,
    minBlocks: 14 * DAY_BLOCKS,
    maxBlocks: 365 * DAY_BLOCKS,
    floor: 160,
    oracleAge: 30,
    fee: 0.005,
    reserve: 0.05,
    rewardNow: 0.005,
    minPrice: null,
    expiry: h + 28 * DAY_BLOCKS,
    delivery: "selective",
    shares: { floor: 9000, expiry: 2160 },
    tokenBudget: null,
    status: "ok",
    reasons: [],
    reason: null,
    ok: true,
    pending: false,
    owner: true,
    points: [
      { d: 14 * DAY_BLOCKS, y: 680 },
      { d: 60 * DAY_BLOCKS, y: 810 },
      { d: 180 * DAY_BLOCKS, y: 940 },
      { d: 365 * DAY_BLOCKS, y: 1090 }
    ],
    checks: [{ key: "origin", ok: true, detail: "Verified zcs1 ERG lend offer" }]
  };

  // --- Sale Auctions (Lots) ---
  const lots: ZcAuctionLotSummary[] = [
    {
      id: DEMO_IDS.lotFalling,
      boxId: DEMO_IDS.lotFalling,
      chainId: DEMO_IDS.lotFalling,
      market: "SigUSD",
      opening: 940,
      floor: 620,
      start: h - Math.round(0.8 * DAY_BLOCKS),
      end: h + Math.round(1.2 * DAY_BLOCKS),
      expiry: h + 4 * DAY_BLOCKS,
      refundFee: 0.005,
      erg: 380,
      items: [
        tok(SIGRSV_ID, "SigRSV", 420_000, 0, "token", "SigRSV"),
        tok(RSADA_ID, "rsADA", 480, 6, "token", "Rosen ADA")
      ],
      priceNow: 812,
      phase: "falling",
      itemCount: 3,
      valid: true,
      owner: false,
      borrowedByMe: false,
      borrowedBondIds: [],
      pending: false
    },
    {
      id: DEMO_IDS.lotBuyback,
      boxId: DEMO_IDS.lotBuyback,
      chainId: DEMO_IDS.lotBuyback,
      market: "ERG",
      opening: 480,
      floor: 365,
      start: h - 3 * DAY_BLOCKS,
      end: h - Math.round(0.5 * DAY_BLOCKS),
      expiry: h + Math.round(2.4 * DAY_BLOCKS),
      refundFee: 0.005,
      erg: 0,
      items: [
        tok(DEMO_IDS.bondBorrowWarn, "ERG Bond Unit", 1, 0, "bond", "ERG Bond Unit", {
          bondId: DEMO_IDS.bondBorrowWarn
        }),
        tok(DEMO_IDS.bondLendShares, "ERG Bond Shares", 25, 6, "shares", "ERG Bond Shares", {
          bondId: DEMO_IDS.bondLendShares
        }),
        tok(GAU_ID, "GAU", 6.5, 4, "token", "Gold-Pegged GAU")
      ],
      priceNow: 365,
      phase: "floor",
      itemCount: 3,
      valid: true,
      owner: false,
      borrowedByMe: true,
      borrowedBondIds: [DEMO_IDS.bondBorrowWarn],
      pending: false
    },
    {
      id: DEMO_IDS.lotMine,
      boxId: DEMO_IDS.lotMine,
      chainId: DEMO_IDS.lotMine,
      market: "SigUSD",
      opening: 440,
      floor: 310,
      start: h + Math.round(0.75 * DAY_BLOCKS),
      end: h + Math.round(2.75 * DAY_BLOCKS),
      expiry: h + 6 * DAY_BLOCKS,
      refundFee: 0.005,
      erg: 150,
      items: [
        tok(RSN_ID, "RSN", 2400, 3, "token", "Rosen Bridge"),
        tok(ERGOPAD_ID, "ErgoPad", 45_000, 2, "token", "ErgoPad")
      ],
      priceNow: 440,
      phase: "before",
      itemCount: 3,
      valid: true,
      owner: true,
      borrowedByMe: false,
      borrowedBondIds: [],
      pending: false
    },
    {
      id: DEMO_IDS.lotWrap,
      boxId: DEMO_IDS.lotWrap,
      chainId: DEMO_IDS.lotWrap,
      market: "ERG",
      opening: 320,
      floor: 210,
      start: h - Math.round(0.4 * DAY_BLOCKS),
      end: h + Math.round(1.6 * DAY_BLOCKS),
      expiry: h + 5 * DAY_BLOCKS,
      refundFee: 0.005,
      erg: 0,
      items: [
        tok(DEMO_IDS.wrapReceipt1, "ZCS-Wrap-6789f0", 1, 0, "receipt", "ERG/SigUSD LP Custody Receipt", {
          wraps: {
            id: DEMO_IDS.wrapInner1,
            ticker: "ERG/SigUSD LP",
            name: "LithosDex ERG/SigUSD LP NFT",
            description:
              "Concentrated liquidity position NFT for ERG / SigUSD (0.30% fee tier). Locked inside a ZCS custody vault; whoever holds this receipt can unwrap the underlying NFT.",
            decimals: 0,
            amount: 1,
            rawAmount: "1",
            kind: "provision",
            vaultBoxId: hexId("va11"),
            refreshFrom: h + 180 * DAY_BLOCKS,
            state: "wrapped"
          }
        }),
        tok(SPF_ID, "SPF", 14_000, 6, "token", "Spectrum")
      ],
      priceNow: 298,
      phase: "falling",
      itemCount: 2,
      valid: true,
      owner: false,
      borrowedByMe: false,
      borrowedBondIds: [],
      pending: false
    }
  ];

  // --- Liquidation Vault Auctions ---
  const vaults: ZcAuctionVaultSummary[] = [
    {
      id: DEMO_IDS.vaultSelective,
      boxId: DEMO_IDS.vaultSelective,
      shareTokenId: DEMO_IDS.bondLendShares,
      bondId: DEMO_IDS.bondBorrowHealthy,
      market: "SigUSD",
      vaultType: "selective",
      state: 1,
      repayment: 1800,
      openBps: 20_000,
      floorBps: 9_000,
      length: 2 * DAY_BLOCKS,
      expiry: 5 * DAY_BLOCKS,
      start: h - Math.round(1.05 * DAY_BLOCKS),
      currencyHeld: 240,
      items: [
        tok("ERG", "ERG", Number(((1800 * 1.38) / px).toFixed(2)), 9, "token", "ERG"),
        tok(RSN_ID, "RSN", 3100, 3, "token", "Rosen Bridge"),
        wrapPledgedTok
      ],
      payNow: 2320,
      quote: {
        pay: 2320,
        target: 2560,
        bps: 14_225,
        done: false
      },
      pending: false
    },
    {
      id: DEMO_IDS.vaultDutch,
      boxId: DEMO_IDS.vaultDutch,
      shareTokenId: DEMO_IDS.bondPullNeeded,
      bondId: DEMO_IDS.bondPullNeeded,
      market: "ERG",
      vaultType: "dutch",
      state: 1,
      repayment: 950,
      openBps: 20_000,
      floorBps: 9_000,
      length: DAY_BLOCKS,
      expiry: 3 * DAY_BLOCKS,
      start: h - Math.round(0.74 * DAY_BLOCKS),
      currencyHeld: 110,
      items: [
        tok(SIGUSD_TOKEN_ID, "SigUSD", Number((950 * px * 1.15).toFixed(2)), 2, "token", "SigUSD"),
        tok(DEMO_IDS.bondLend1, "SigUSD Bond Unit", 1, 0, "bond", "SigUSD Bond Unit", {
          bondId: DEMO_IDS.bondLend1
        }),
        tok(RSBTC_ID, "rsBTC", 0.0085, 8, "token", "Rosen BTC")
      ],
      payNow: 1016.7,
      quote: {
        pay: 1016.7,
        target: 1126.7,
        bps: 11_860,
        done: false
      },
      pending: false
    },
    {
      id: DEMO_IDS.vaultExcess,
      boxId: DEMO_IDS.vaultExcess,
      shareTokenId: DEMO_IDS.bondLend1,
      bondId: DEMO_IDS.bondLend1,
      market: "SigUSD",
      vaultType: "selective",
      state: 4,
      repayment: 600,
      openBps: 10_000,
      floorBps: 0,
      length: DAY_BLOCKS,
      expiry: DAY_BLOCKS,
      start: h - Math.round(0.55 * DAY_BLOCKS),
      currencyHeld: 600,
      items: [
        tok(SPF_ID, "SPF", 11_200, 6, "token", "Spectrum"),
        tok(ERGOPAD_ID, "ErgoPad", 32_000, 2, "token", "ErgoPad")
      ],
      payNow: 270,
      quote: {
        pay: 270,
        target: 270,
        bps: 4_500,
        done: false
      },
      pending: false
    }
  ];

  // --- Wraps & Mint Requests ---
  const mintRequests: ZcPortfolioMintRequest[] = [
    {
      id: DEMO_IDS.mintReq1,
      boxId: DEMO_IDS.mintReq1,
      bondId: DEMO_IDS.bondLend1,
      pending: false
    }
  ];

  const wraps: ZcPortfolioWrap[] = [
    {
      id: DEMO_IDS.wrapReceipt1,
      receiptId: DEMO_IDS.wrapReceipt1,
      vaultBoxId: hexId("va11"),
      receipt: {
        id: DEMO_IDS.wrapReceipt1,
        ticker: "ZCS-Wrap-6789f0",
        name: "ERG / SigUSD LP Receipt",
        decimals: 0,
        amount: 1,
        rawAmount: "1",
        kind: "receipt",
        wraps: {
          id: DEMO_IDS.wrapInner1,
          ticker: "ERG/SigUSD LP",
          name: "LithosDex ERG/SigUSD LP NFT",
          description:
            "Concentrated liquidity position NFT for ERG / SigUSD (0.30% fee tier). Locked inside a ZCS custody vault; unwrap burns receipt to release the NFT.",
          decimals: 0,
          amount: 1,
          rawAmount: "1",
          kind: "provision",
          vaultBoxId: hexId("va11"),
          refreshFrom: h + 180 * DAY_BLOCKS,
          state: "wrapped"
        },
        verified: true
      },
      token: {
        id: DEMO_IDS.wrapInner1,
        ticker: "ERG/SigUSD LP",
        name: "LithosDex ERG/SigUSD LP NFT",
        description:
          "Concentrated liquidity position NFT for ERG / SigUSD (0.30% fee tier). Locked inside a ZCS custody vault; unwrap burns receipt to release the NFT.",
        decimals: 0,
        amount: 1,
        rawAmount: "1",
        kind: "provision",
        verified: false,
        pool: "ERG / SigUSD 0.3%"
      },
      state: "wrapped",
      refreshFrom: h + 180 * DAY_BLOCKS,
      inWallet: true
    },
    {
      id: DEMO_IDS.wrapReqBox,
      boxId: DEMO_IDS.wrapReqBox,
      receipt: {
        id: DEMO_IDS.wrapReqBox,
        ticker: "ZCS-Wrap-8901b2",
        name: "RSN / ERG LP Receipt",
        decimals: 0,
        amount: 1,
        rawAmount: "1",
        kind: "receipt",
        wraps: {
          id: DEMO_IDS.wrapInner2,
          ticker: "RSN/ERG LP",
          name: "LithosDex RSN/ERG LP NFT",
          description:
            "Liquidity provision NFT for the RSN / ERG (0.30% fee tier) pool. Pending custody receipt minting by batcher.",
          decimals: 0,
          amount: 1,
          rawAmount: "1",
          kind: "provision",
          state: "requested"
        },
        verified: true
      },
      token: {
        id: DEMO_IDS.wrapInner2,
        ticker: "RSN/ERG LP",
        name: "LithosDex RSN/ERG LP NFT",
        description:
          "Liquidity provision NFT for the RSN / ERG (0.30% fee tier) pool. Pending custody receipt minting by batcher.",
        decimals: 0,
        amount: 1,
        rawAmount: "1",
        kind: "provision",
        verified: false,
        pool: "RSN / ERG 0.3%"
      },
      state: "requested",
      pending: false,
      inWallet: false
    },
    {
      id: DEMO_IDS.wrapPledgedReceipt,
      receiptId: DEMO_IDS.wrapPledgedReceipt,
      vaultBoxId: hexId("va33"),
      receipt: {
        id: DEMO_IDS.wrapPledgedReceipt,
        ticker: "ZCS-Wrap-a123d4",
        name: "rsBTC / ERG LP Receipt",
        decimals: 0,
        amount: 1,
        rawAmount: "1",
        kind: "receipt",
        wraps: wrapPledgedTok.wraps,
        verified: true
      },
      token: {
        id: DEMO_IDS.wrapInner3,
        ticker: "rsBTC/ERG LP",
        name: "LithosDex rsBTC/ERG LP NFT",
        description: wrapPledgedTok.wraps?.description ?? null,
        decimals: 0,
        amount: 1,
        rawAmount: "1",
        kind: "provision",
        verified: false,
        pool: "rsBTC / ERG 0.3%"
      },
      state: "wrapped",
      refreshFrom: h + 210 * DAY_BLOCKS,
      inWallet: false
    }
  ];

  const walletTokens: ZcWalletToken[] = [
    {
      id: SIGRSV_ID,
      ticker: "SigRSV",
      name: "SigmaRSV",
      decimals: 0,
      amount: 1_850_000,
      rawAmount: "1850000",
      kind: "token",
      verified: true,
      usd: 0.00052
    },
    {
      id: RSN_ID,
      ticker: "RSN",
      name: "Rosen Bridge",
      decimals: 3,
      amount: 4250,
      rawAmount: "4250000",
      kind: "token",
      verified: true,
      usd: 0.095
    },
    {
      id: RSBTC_ID,
      ticker: "rsBTC",
      name: "Rosen BTC",
      decimals: 8,
      amount: 0.015,
      rawAmount: "1500000",
      kind: "token",
      verified: true,
      usd: 88_000
    },
    {
      id: SPF_ID,
      ticker: "SPF",
      name: "Spectrum",
      decimals: 6,
      amount: 24_500,
      rawAmount: "24500000000",
      kind: "token",
      verified: true,
      usd: 0.018
    },
    {
      id: DEMO_IDS.rawLpNft,
      ticker: "ERG/rsADA LP",
      name: "LithosDex ERG/rsADA Position",
      description:
        "Raw liquidity provision NFT for ERG / rsADA (0.30% fee tier). Wrap in a ZCS custody vault before pledging as bond collateral or selling in an auction.",
      decimals: 0,
      amount: 1,
      rawAmount: "1",
      kind: "provision",
      verified: false,
      pool: "ERG / rsADA 0.3%",
      liquidity: "$1,420",
      fees: "$18.40"
    }
  ];

  const portfolio: ZcPortfolioState = {
    loaded: true,
    loading: false,
    walletErg: 4250,
    walletSigUsd: 3180,
    walletTokens,
    positions: [...lendPositions, ...borrowPositions],
    openOrders: [openOrder],
    openAsks: [openAsk],
    openOffers: [offerSigUsd, offerErg],
    openLots: lots.filter((l) => l.owner),
    mintRequests,
    wraps,
    attentionCount: 1
  };

  // --- Lookup & Matches maps so clicking any mock bond/order/offer works end-to-end ---
  const lookupById = new Map<string, ZcLookupResult>();
  for (const b of [
    bLend1,
    bLendShares,
    bSelfHeld,
    bRepaid,
    bPullNeeded,
    bBorrowHealthy,
    bBorrowWarn
  ]) {
    lookupById.set(b.id, { type: "bond", bond: b });
  }
  lookupById.set(openOrder.id, { type: "order", ask: openOrder });
  lookupById.set(openAsk.id, { type: "ask", ask: openAsk });
  lookupById.set(offerSigUsd.id, { type: "offer", offer: offerSigUsd });
  lookupById.set(offerErg.id, { type: "offer", offer: offerErg });

  const matchesById = new Map<string, ZcMatchesResponse>();
  matchesById.set(offerSigUsd.id, {
    type: "offer",
    offerId: offerSigUsd.id,
    buys: [
      {
        askId: openOrder.id,
        maturity: h + 365 * DAY_BLOCKS,
        yieldBps: 950,
        requiredBps: 1180,
        coverBps: 17500,
        cost: "100000",
        face: "109500"
      }
    ],
    next: { taken: [], spent: "0", avgYieldBps: null, rounds: 0 }
  });

  return { lots, vaults, portfolio, lookupById, matchesById };
}
