/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISABLE_V2_TX_SIGNING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
