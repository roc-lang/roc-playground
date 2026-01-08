/**
 * WASM Integration Module for Roc Playground
 * Handles loading, initialization, and communication with the Roc WASM module
 */

import { debugLog } from "../utils/debug";

interface WasmMessage {
  type: string;
  source?: string;
  filename?: string;
  identifier?: string;
  line?: number;
  ch?: number;
  input?: string; // For REPL_STEP
}

interface Region {
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  region: Region;
}

interface Diagnostics {
  summary: {
    errors: number;
    warnings: number;
  };
  html: string;
  list: Diagnostic[];
  debug_counts: object;
}

interface ReplInfo {
  compiler_version: string;
  state: string;
}

interface ReplResult {
  output: string;
  type: "definition" | "expression" | "error";
  compiler_available: boolean;
  error_stage?: "parse" | "canonicalize" | "typecheck" | "layout" | "evaluation" | "interpreter" | "runtime" | "unknown";
  error_details?: string;
}

interface WasmResponse {
  status: "SUCCESS" | "ERROR" | "INVALID_STATE" | "INVALID_MESSAGE";
  message?: string;
  data?: string;
  diagnostics?: Diagnostics;
  hover_info?: {
    name: string;
    type_str: string;
    definition_region: Region;
    docs: string | null;
  } | null;
  repl_info?: ReplInfo;
  result?: ReplResult;
}

export interface WasmInterface {
  compile: (code: string, filename: string) => Promise<WasmResponse>;
  tokenize: () => Promise<WasmResponse>;
  parse: () => Promise<WasmResponse>;
  canonicalize: () => Promise<WasmResponse>;
  getTypes: () => Promise<WasmResponse>;
  formatCode: () => Promise<WasmResponse>;
  getHoverInfo: (
    identifier: string,
    line: number,
    ch: number,
  ) => Promise<WasmResponse | null>;
  evaluateTests: () => Promise<WasmResponse>;
  isReady: () => boolean;
  getMemoryUsage: () => number;
  sendMessage: (message: WasmMessage) => Promise<WasmResponse>;
  getDebugLog: () => string;
  clearDebugLog: () => void;

  // REPL functionality
  initRepl: () => Promise<WasmResponse>;
  replStep: (input: string) => Promise<WasmResponse>;
  clearRepl: () => Promise<WasmResponse>;
  reset: () => Promise<WasmResponse>;
}

interface QueuedMessage {
  message: WasmMessage;
  resolve: (value: WasmResponse) => void;
  reject: (reason?: any) => void;
}

let wasmModule: any = null;
let wasmMemory: WebAssembly.Memory | null = null;
let messageQueue: QueuedMessage[] = [];
let messageInProgress: boolean = false;
let wasmIsDead = false;

/**
 * Initializes the WASM module and returns an interface object
 */
export async function initializeWasm(): Promise<{
  interface: WasmInterface;
  compilerVersion?: string;
}> {
  try {
    debugLog("Initializing WASM module...");

    const response = await fetch(
      new URL("../assets/playground.wasm", import.meta.url),
    );
    if (!response.ok) {
      throw new Error(
        `Failed to fetch WASM file: ${response.status} ${response.statusText}`,
      );
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error("WASM file is empty");
    debugLog(`WASM file loaded: ${bytes.byteLength} bytes`);

    const module = await WebAssembly.instantiate(bytes, {
      env: {
        // Add any required imports here
      },
    });

    wasmModule = module.instance.exports;
    wasmMemory = wasmModule.memory;
    debugLog("WASM module instantiated");
    debugLog("Available WASM exports:", Object.keys(wasmModule));

    const requiredExports = [
      "init",
      "processAndRespond",
      "allocateMessageBuffer",
      "freeMessageBuffer",
      "freeWasmString",
    ];

    for (const exportName of requiredExports) {
      if (typeof wasmModule[exportName] !== "function") {
        throw new Error(
          `Missing required WASM export: ${exportName} (type: ${typeof wasmModule[exportName]})`,
        );
      }
    }
    debugLog("[WASM Debug] All required exports found");

    wasmModule.init();
    debugLog("WASM module 'init' called successfully");

    // Since this is the first call, it's okay if it fails with OOM,
    // as subsequent calls will use the more stable processMessage.
    // We use it here just to get the version string easily.
    const initResponse = await sendMessageQueued({ type: "INIT" });
    let compilerVersion: string | undefined;

    if (initResponse.status === "SUCCESS" && initResponse.message) {
      compilerVersion = initResponse.message;
      console.log(`Roc Compiler Version: ${compilerVersion}`);
    } else {
      console.warn("Failed to get compiler version from INIT response", initResponse);
    }

    const result: { interface: WasmInterface; compilerVersion?: string } = {
      interface: createWasmInterface(),
    };

    if (compilerVersion) {
      result.compilerVersion = compilerVersion;
    }

    return result;
  } catch (error) {
    console.error("Error initializing WASM:", error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize WASM module: ${message}`);
  }
}

/**
 * Creates the WASM interface object that other modules can use
 */
function createWasmInterface(): WasmInterface {
  return {
    compile: async (code, filename) => {
      await sendMessageQueued({ type: "RESET" });
      return sendMessageQueued({ type: "LOAD_SOURCE", source: code, filename });
    },
    tokenize: () => sendMessageQueued({ type: "QUERY_TOKENS" }),
    parse: () => sendMessageQueued({ type: "QUERY_AST" }),
    canonicalize: () => sendMessageQueued({ type: "QUERY_CIR" }),
    getTypes: () => sendMessageQueued({ type: "QUERY_TYPES" }),
    formatCode: () => sendMessageQueued({ type: "QUERY_FORMATTED" }),
    evaluateTests: () => sendMessageQueued({ type: "EVALUATE_TESTS" }),
    getHoverInfo: async (identifier, line, ch) => {
      try {
        // The WASM module expects a 1-based column, but editor tooling
        // often provides a 0-based column (`ch`).
        return await sendMessageQueued({
          type: "GET_HOVER_INFO",
          identifier,
          line,
          ch: ch + 1,
        });
      } catch (error) {
        console.error("Error getting hover info:", error);
        return null;
      }
    },
    isReady: () => wasmModule !== null,
    getMemoryUsage: () => (wasmMemory ? wasmMemory.buffer.byteLength : 0),
    sendMessage: sendMessageQueued,
    getDebugLog: () => wasmModule?.getDebugLogBuffer ? readNullTerminatedString(wasmModule.getDebugLogBuffer()) : "Debug log not available.",
    clearDebugLog: () => wasmModule?.clearDebugLog ? wasmModule.clearDebugLog() : undefined,

    // REPL functionality
    initRepl: () => sendMessageQueued({ type: "INIT_REPL" }),
    replStep: (input) => sendMessageQueued({ type: "REPL_STEP", input }),
    clearRepl: () => sendMessageQueued({ type: "CLEAR_REPL" }),
    reset: () => sendMessageQueued({ type: "RESET" }),
  };
}

function sendMessageQueued(message: WasmMessage): Promise<WasmResponse> {
  return new Promise<WasmResponse>((resolve, reject) => {
    messageQueue.push({ message, resolve, reject });
    processMessageQueue();
  });
}

async function processMessageQueue(): Promise<void> {
  if (messageInProgress || messageQueue.length === 0) return;

  messageInProgress = true;
  while (messageQueue.length > 0) {
    const queuedMessage = messageQueue.shift();
    if (!queuedMessage) break;

    const { message, resolve, reject } = queuedMessage;
    try {
      const result = await sendMessageToWasm(message);
      resolve(result);
    } catch (error) {
      reject(error);
    }
  }
  messageInProgress = false;
}

/**
 * Sends a message using the `processMessage` flow, which is more memory-stable
 * as it avoids large internal allocations in WASM.
 */
async function sendMessageToWasm(message: WasmMessage): Promise<WasmResponse> {
  debugLog(`[WASM Debug] sendMessageToWasm called with message:`, message);
  if (wasmIsDead) {
    throw new Error(
      "WASM module has crashed and is in an unrecoverable state. Please reload the page.",
    );
  }
  if (!wasmModule || !wasmMemory) {
    throw new Error("WASM module or memory not available");
  }

  let messagePtr: number | null = null;
  let responsePtr: number | null = null;

  try {
    const messageStr = JSON.stringify(message);
    const messageBytes = new TextEncoder().encode(messageStr);

    debugLog(`[WASM Debug] Sending JSON message: ${messageStr}`);
    debugLog(`[WASM Debug] Message bytes length: ${messageBytes.length}`);

    // Allocate message buffer (matching integration test API)
    messagePtr = wasmModule.allocateMessageBuffer(messageBytes.length);
    debugLog(`[WASM Debug] Allocated message buffer at: ${messagePtr}`);
    if (!messagePtr || messagePtr === 0) {
      throw new Error("Failed to allocate message memory in WASM");
    }

    // Copy message to WASM memory
    new Uint8Array(wasmMemory.buffer).set(messageBytes, messagePtr);
    debugLog(`[WASM Debug] Copied message to WASM memory`);

    // Call processAndRespond (matching integration test API)
    debugLog(`[WASM Debug] Calling processAndRespond(${messagePtr}, ${messageBytes.length})`);
    responsePtr = wasmModule.processAndRespond(messagePtr, messageBytes.length);
    debugLog(`[WASM Debug] processAndRespond returned: ${responsePtr}`);

    // Free message buffer immediately after use
    wasmModule.freeMessageBuffer();
    messagePtr = null;

    if (!responsePtr || responsePtr === 0) {
      throw new Error("WASM processAndRespond returned null, indicating an internal error");
    }

    // Read the null-terminated response string from WASM memory
    const responseMemory = new Uint8Array(wasmMemory.buffer);
    let responseLength = 0;

    // Find null terminator
    for (let i = responsePtr; i < wasmMemory.buffer.byteLength; i++) {
      if (responseMemory[i] === 0) {
        responseLength = i - responsePtr;
        break;
      }
    }

    if (responseLength === 0) {
      throw new Error("WASM returned response string without a null terminator");
    }

    const responseBytes = responseMemory.slice(responsePtr, responsePtr + responseLength);
    const responseStr = new TextDecoder().decode(responseBytes);

    debugLog(`[WASM Debug] Response string: ${responseStr}`);

    // Parse JSON response
    const responseObject = JSON.parse(responseStr) as WasmResponse;
    debugLog(`[WASM Debug] Parsed response object:`, responseObject);

    // Free the WASM-allocated response string
    wasmModule.freeWasmString(responsePtr);
    responsePtr = null;

    // Check debug log (optional, for debugging)
    try {
      const wasmDebugLog = wasmModule?.getDebugLogBuffer ? readNullTerminatedString(wasmModule.getDebugLogBuffer()) : "";
      if (wasmDebugLog) {
        console.log("%c--- WASM Internal Debug Log (Success) ---", "color: #00a; font-weight: bold;");
        console.log(wasmDebugLog);
        console.log("%c-----------------------------------------", "color: #00a; font-weight: bold;");
      }
    } catch (logError) {
      console.error("Failed to retrieve WASM debug log on success:", logError);
    } finally {
      // Always clear the log after we've read it
      if (wasmModule?.clearDebugLog) {
        wasmModule.clearDebugLog();
      }
    }

    return responseObject;
  } catch (error) {
    debugLog("[WASM Debug] Error in sendMessageToWasm:", error);
    if (error instanceof WebAssembly.RuntimeError) {
      console.error(
        "Unrecoverable WASM RuntimeError detected. The WASM module has been deactivated.",
      );
      wasmIsDead = true;

      // Fetch and display the debug log from WASM for diagnostics
      try {
        const wasmDebugLog = wasmModule?.getDebugLogBuffer ? readNullTerminatedString(wasmModule.getDebugLogBuffer()) : "Debug log not available.";
        if (wasmDebugLog) {
          console.log("%c--- WASM Internal Debug Log ---", "color: #f5a; font-weight: bold;");
          console.log(wasmDebugLog);
          console.log("%c-------------------------------", "color: #f5a; font-weight: bold;");
        }
      } catch (logError) {
        console.error("Failed to retrieve WASM debug log:", logError);
      }
    }
    throw error;
  } finally {
    // Clean up any remaining allocated memory
    if (messagePtr !== null) {
      try {
        wasmModule.freeMessageBuffer();
      } catch (e) {
        console.warn("Failed to free message buffer:", e);
      }
    }
    if (responsePtr !== null) {
      try {
        wasmModule.freeWasmString(responsePtr);
      } catch (e) {
        console.warn("Failed to free response string:", e);
      }
    }
  }
}

function readNullTerminatedString(ptr: number): string {
  if (!wasmMemory || !ptr) return "";
  const memory = new Uint8Array(wasmMemory.buffer);
  let end = ptr;
  while (memory[end] !== 0) {
    end++;
  }
  const bytes = memory.subarray(ptr, end);
  return new TextDecoder().decode(bytes);
}

export function isWasmReady(): boolean {
  return wasmModule !== null;
}

export function getWasmMemoryUsage(): number {
  return wasmMemory ? wasmMemory.buffer.byteLength : 0;
}

export function resetWasm(): void {
  wasmModule = null;
  wasmMemory = null;
  messageQueue = [];
  messageInProgress = false;
  wasmIsDead = false;
}
