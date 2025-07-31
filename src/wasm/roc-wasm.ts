/**
 * WASM Integration Module for Roc Playground
 * Handles loading, initialization, and communication with the Roc WASM module
 */

import { debugLog } from "../utils/debug";

interface WasmMessage {
  type: string;
  source?: string;
  identifier?: string;
  line?: number;
  ch?: number;
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
}

interface WasmInterface {
  compile: (code: string) => Promise<WasmResponse>;
  tokenize: () => Promise<WasmResponse>;
  parse: () => Promise<WasmResponse>;
  canonicalize: () => Promise<WasmResponse>;
  getTypes: () => Promise<WasmResponse>;
  getHoverInfo: (
    identifier: string,
    line: number,
    ch: number,
  ) => Promise<WasmResponse | null>;
  isReady: () => boolean;
  getMemoryUsage: () => number;
  sendMessage: (message: WasmMessage) => Promise<WasmResponse>;
  getDebugLog: () => string;
  clearDebugLog: () => void;
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
      "processMessage",
      "allocateMessageBuffer",
      "freeMessageBuffer",
      "allocateResponseBuffer",
      "freeResponseBuffer",
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
    compile: async (code) => {
      await sendMessageQueued({ type: "RESET" });
      return sendMessageQueued({ type: "LOAD_SOURCE", source: code });
    },
    tokenize: () => sendMessageQueued({ type: "QUERY_TOKENS" }),
    parse: () => sendMessageQueued({ type: "QUERY_AST" }),
    canonicalize: () => sendMessageQueued({ type: "QUERY_CIR" }),
    getTypes: () => sendMessageQueued({ type: "QUERY_TYPES" }),
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
  const responseBufferSize = 256 * 1024; // 256KB

  try {
    const messageStr = JSON.stringify(message);
    const messageBytes = new TextEncoder().encode(messageStr);

    messagePtr = wasmModule.allocateMessageBuffer(messageBytes.length);
    if (!messagePtr) throw new Error("Failed to allocate message memory in WASM");
    new Uint8Array(wasmMemory.buffer).set(messageBytes, messagePtr);

    responsePtr = wasmModule.allocateResponseBuffer(responseBufferSize);
    if (!responsePtr) throw new Error("Failed to allocate response memory in WASM");

    const resultCode = wasmModule.processMessage(
      messagePtr,
      messageBytes.length,
      responsePtr,
      responseBufferSize,
    );

    // WasmError enum in Zig
    if (resultCode !== 0) {
        const errorMessages = [
            "success", "invalid_json", "missing_message_type", "unknown_message_type",
            "invalid_state_for_message", "response_buffer_too_small", "internal_error"
        ];
        throw new Error(`WASM processMessage failed with code ${resultCode}: ${errorMessages[resultCode] || 'Unknown error'}`);
    }

    const responseMemory = new DataView(wasmMemory.buffer);
    const responseLen = responseMemory.getUint32(responsePtr, true); // true for little-endian

    if (responseLen === 0 || responseLen > responseBufferSize - 4) {
      throw new Error(`WASM returned invalid response length: ${responseLen}`);
    }

    const responseBytes = new Uint8Array(wasmMemory.buffer, responsePtr + 4, responseLen);
    const responseStr = new TextDecoder().decode(responseBytes);

    const responseObject = JSON.parse(responseStr) as WasmResponse;

    // After any operation, successful or not, check the debug log.
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
      // Always clear the log after we've read it.
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
    if (messagePtr !== null) {
      wasmModule.freeMessageBuffer();
    }
    if (responsePtr !== null) {
      wasmModule.freeResponseBuffer();
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
