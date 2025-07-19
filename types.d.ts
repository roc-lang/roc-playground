/**
 * Global type declarations for the Roc Playground
 */

// WASM file imports return URLs when using @parcel/transformer-raw
declare module "*.wasm" {
  const wasmUrl: string;
  export default wasmUrl;
}

// Additional asset imports that might be useful
declare module "*.wasm?url" {
  const wasmUrl: string;
  export default wasmUrl;
}

// Parcel URL imports
declare module "url:*" {
  const url: string;
  export default url;
}

// Window interface extensions for global playground functions
declare global {
  interface Window {
    showDiagnostics: () => void;
    showTokens: () => void;
    showParseAst: () => void;
    showCanCir: () => void;
    showTypes: () => void;
    toggleVerboseLogging: () => void;
  }
}

// Ensure this file is treated as a module
export {};
