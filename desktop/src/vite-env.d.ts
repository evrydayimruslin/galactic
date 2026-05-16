/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_UL_ENVIRONMENT?: string;
  readonly VITE_UL_API_BASE?: string;
  readonly VITE_UL_GPU_SUPPORT_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
