/**
 * WASM Integration Module for Roc Playground
 * Handles loading, initialization, and communication with the Roc WASM module
 */

import { debuglog } from "util";
import { debugLog } from "../utils/debug";

interface WasmMessage {
  type: string;
  source?: string;
  identifier?: string;
  line?: number;
  ch?: number;
  word?: string;
  position?: number;
}

interface WasmResponse {
  status: "SUCCESS" | "ERROR" | "INVALID_STATE" | "INVALID_MESSAGE";
  message?: string;
  data?: string;
  diagnostics?: {
    summary: {
      errors: number;
      warnings: number;
    };
    html: string;
  };
  type_info?: {
    type: string;
    description?: string;
  };
}

interface WasmInterface {
  compile: (code: string) => Promise<WasmResponse>;
  tokenize: () => Promise<WasmResponse>;
  parse: () => Promise<WasmResponse>;
  canonicalize: () => Promise<WasmResponse>;
  getTypes: () => Promise<WasmResponse>;
  getTypeInfo: (
    identifier: string,
    line: number,
    ch: number,
  ) => Promise<WasmResponse | null>;
  isReady: () => boolean;
  getMemoryUsage: () => number;
  sendMessage: (message: WasmMessage) => Promise<WasmResponse>;
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

/**
 * Initializes the WASM module and returns an interface object
 */
export async function initializeWasm(): Promise<{
  interface: WasmInterface;
  compilerVersion?: string;
}> {
  try {
    debugLog("Initializing WASM module...");

    // Load the WASM file
    const response = await fetch("playground.wasm");

    if (!response.ok) {
      throw new Error(
        `Failed to fetch WASM file: ${response.status} ${response.statusText}`,
      );
    }

    const bytes = await response.arrayBuffer();

    if (bytes.byteLength === 0) {
      throw new Error("WASM file is empty");
    }

    debuglog(`WASM file loaded: ${bytes.byteLength} bytes`);

    // Instantiate the WASM module
    const module = await WebAssembly.instantiate(bytes, {
      env: {
        // Add any required imports here
      },
    });

    wasmModule = module.instance.exports;
    wasmMemory = wasmModule.memory;

    debugLog("WASM module instantiated");
    const availableExports = Object.keys(wasmModule);
    debugLog("Available exports:", availableExports);

    // Log export types for debugging (verbose only)
    availableExports.forEach((exportName) => {
      debugLog(
        `[WASM Debug] Export "${exportName}": ${typeof wasmModule[exportName]}`,
      );
    });

    // Verify required exports are present
    const requiredExports = [
      "init",
      "processMessage",
      "allocate",
      "deallocate",
    ];

    debugLog("[WASM Debug] Checking required exports:", requiredExports);

    for (const exportName of requiredExports) {
      const exportType = typeof wasmModule[exportName];
      debugLog(`[WASM Debug] Checking "${exportName}": ${exportType}`);
      if (exportType !== "function") {
        debugLog(
          `[WASM Debug] Missing or invalid export "${exportName}": expected function, got ${exportType}`,
        );
        throw new Error(
          `Missing required WASM export: ${exportName} (type: ${exportType})`,
        );
      }
    }

    debugLog("[WASM Debug] All required exports found");

    // Initialize the WASM module
    wasmModule.init();
    console.log("WASM module initialized successfully");

    // Initialize the WASM module and get compiler version
    const initResponse = await sendMessageDirect({ type: "INIT" });

    let compilerVersion: string | undefined;
    if (initResponse.status === "SUCCESS" && initResponse.message) {
      compilerVersion = initResponse.message;
      console.log(`Roc Compiler Version: ${compilerVersion}`);
    } else {
      console.warn("Failed to get compiler version from INIT response");
    }

    // Return the interface object and compiler version
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
    // Core compilation methods
    compile: async (code) => {
      // Reset to READY state first, then load the source
      try {
        await sendMessageQueued({ type: "RESET" });
      } catch (error) {
        console.warn("Reset failed, continuing anyway:", error);
      }

      // Now load the source
      const loadResult = await sendMessageQueued({
        type: "LOAD_SOURCE",
        source: code,
      });
      return loadResult;
    },
    tokenize: () => sendMessageQueued({ type: "QUERY_TOKENS" }),
    parse: () => sendMessageQueued({ type: "QUERY_AST" }),
    canonicalize: () => sendMessageQueued({ type: "QUERY_CIR" }),
    getTypes: () => sendMessageQueued({ type: "QUERY_TYPES" }),

    // Type information methods
    getTypeInfo: async (identifier, line, ch) => {
      try {
        const result = await sendMessageQueued({
          type: "GET_TYPE_INFO",
          identifier,
          line,
          ch,
        });
        return result;
      } catch (error) {
        console.error("Error getting type info:", error);
        return null;
      }
    },

    // Status methods
    isReady: () => wasmModule !== null,
    getMemoryUsage: () => (wasmMemory ? wasmMemory.buffer.byteLength : 0),

    // Raw message sending for advanced use
    sendMessage: sendMessageQueued,
  };
}

/**
 * Sends a message to the WASM module (queued to handle concurrency)
 */
function sendMessageQueued(message: WasmMessage): Promise<WasmResponse> {
  return new Promise<WasmResponse>((resolve, reject) => {
    messageQueue.push({ message, resolve, reject });
    processMessageQueue();
  });
}

/**
 * Processes the message queue, ensuring only one message is processed at a time
 */
async function processMessageQueue(): Promise<void> {
  if (messageInProgress || messageQueue.length === 0) {
    return;
  }

  messageInProgress = true;

  while (messageQueue.length > 0) {
    const queuedMessage = messageQueue.shift();
    if (!queuedMessage) {
      break;
    }
    const { message, resolve, reject } = queuedMessage;

    try {
      const result = await sendMessageDirect(message);
      resolve(result);
    } catch (error) {
      reject(error);
    }
  }

  messageInProgress = false;
}

/**
 * Sends a message directly to the WASM module
 */
async function sendMessageDirect(message: WasmMessage): Promise<WasmResponse> {
  // Note: For verbose logging, use toggleVerboseLogging() in console
  debugLog(`[WASM Debug] sendMessageDirect called with message:`, message);

  if (!wasmModule) {
    debugLog(`[WASM Debug] WASM module not loaded!`);
    throw new Error("WASM module not loaded");
  }

  debugLog(
    `[WASM Debug] WASM module is loaded, available exports:`,
    Object.keys(wasmModule),
  );

  let messagePtr: number | null = null;
  let responsePtr: number | null = null;
  let messageBytes: Uint8Array | null = null;

  try {
    const messageStr = JSON.stringify(message);
    messageBytes = new TextEncoder().encode(messageStr);

    debugLog(`[WASM Debug] Sending message: ${messageStr}`);
    debugLog(`[WASM Debug] Message bytes length: ${messageBytes.length}`);

    // Allocate memory for message
    messagePtr = wasmModule.allocate(messageBytes.length);
    if (!messagePtr) {
      throw new Error("Failed to allocate message memory");
    }

    if (!wasmMemory) {
      throw new Error("WASM memory not available");
    }
    const memory = new Uint8Array(wasmMemory.buffer);
    memory.set(messageBytes, messagePtr);

    // Allocate memory for response
    const responseBufferSize = 64 * 1024; // 64KB buffer
    responsePtr = wasmModule.allocate(responseBufferSize);
    if (!responsePtr) {
      throw new Error("Failed to allocate response memory");
    }

    debugLog(
      `[WASM Debug] Calling processMessage with messagePtr=${messagePtr}, messageLen=${messageBytes.length}, responsePtr=${responsePtr}, responseBufferSize=${responseBufferSize}`,
    );
    debugLog(`[WASM Debug] About to call processMessage...`);
    const responseLen = wasmModule.processMessage(
      messagePtr,
      messageBytes.length,
      responsePtr,
      responseBufferSize,
    );

    debugLog(`[WASM Debug] Got response length: ${responseLen}`);

    if (typeof responseLen !== "number") {
      debugLog(`[WASM Debug] processMessage returned non-number:`, responseLen);
      throw new Error(
        `WASM processMessage returned invalid type: ${typeof responseLen}`,
      );
    }

    if (responseLen === 0) {
      throw new Error("WASM returned empty response");
    }

    // Read response
    if (!wasmMemory) {
      throw new Error("WASM memory not available for response");
    }
    const responseBytes = new Uint8Array(
      wasmMemory.buffer,
      responsePtr,
      responseLen,
    );
    const responseStr = new TextDecoder().decode(responseBytes);

    debugLog(
      `[WASM Debug] Raw response string (${responseStr.length} chars): ${responseStr.substring(0, 200)}${responseStr.length > 200 ? "..." : ""}`,
    );

    if (!responseStr.trim()) {
      throw new Error("WASM returned empty response string");
    }

    let parsedResponse: WasmResponse;
    try {
      parsedResponse = JSON.parse(responseStr) as WasmResponse;
      debugLog(`[WASM Debug] Parsed response:`, parsedResponse);
    } catch (jsonError) {
      debugLog(`[WASM Debug] JSON parse error:`, jsonError);
      throw new Error(
        `Invalid JSON response from WASM: ${responseStr.substring(0, 100)}...`,
      );
    }

    return parsedResponse;
  } catch (error) {
    debugLog("[WASM Debug] Error in sendMessageDirect:", error);
    debugLog("[WASM Debug] Error occurred with message:", message);
    debugLog(
      "[WASM Debug] WASM module state:",
      wasmModule ? "loaded" : "not loaded",
    );
    throw error;
  } finally {
    // Clean up memory
    if (messagePtr && wasmModule.deallocate && messageBytes) {
      wasmModule.deallocate(messagePtr, messageBytes.length);
    }
    if (responsePtr && wasmModule.deallocate) {
      wasmModule.deallocate(responsePtr, 64 * 1024);
    }
  }
}

/**
 * Utility function to check if WASM is ready
 */
export function isWasmReady(): boolean {
  return wasmModule !== null;
}

/**
 * Gets the current memory usage of the WASM module
 */
export function getWasmMemoryUsage(): number {
  return wasmMemory ? wasmMemory.buffer.byteLength : 0;
}

/**
 * Resets the WASM module state (for testing or recovery)
 */
export function resetWasm(): void {
  wasmModule = null;
  wasmMemory = null;
  messageQueue = [];
  messageInProgress = false;
}
