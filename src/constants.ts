import { Network } from "@fleet-sdk/common";
import { RECOMMENDED_MIN_FEE_VALUE } from "@fleet-sdk/core";
import { getNetworkType } from "./utils/otherUtils";

export const ERG_TOKEN_ID = "ERG";
export const MIN_FEE = RECOMMENDED_MIN_FEE_VALUE * 2n;
export const ERG_DECIMALS = 9;
export const EXPLORER_URL =
  getNetworkType() === Network.Mainnet
    ? "https://explorer.ergoplatform.com/"
    : "https://testnet.ergoplatform.com/";

/**
 * SigmaFi V2 (ZC) preview / read-only mode toggle.
 * When `true`, all V2 transaction signing and submission is disabled across the app
 * while V1 remains fully usable. Set `DEFAULT_DISABLE_V2_TX_SIGNING` to `false`
 * (or override via `VITE_DISABLE_V2_TX_SIGNING=false`) when ready to enable live V2 transactions.
 */
const DEFAULT_DISABLE_V2_TX_SIGNING = true;
const envDisableV2TxSigning = import.meta.env?.VITE_DISABLE_V2_TX_SIGNING;
export const DISABLE_V2_TX_SIGNING: boolean =
  envDisableV2TxSigning === "true"
    ? true
    : envDisableV2TxSigning === "false"
      ? false
      : DEFAULT_DISABLE_V2_TX_SIGNING;

export const V2_TX_SIGNING_DISABLED_MESSAGE =
  "SigmaFi V2 transaction signing is currently disabled while in preview mode.";
