/** Execute headerless main! programs using Roc's existing echo platform API. */
interface EchoExports {
  memory: WebAssembly.Memory;
  init: () => void;
  allocateBuffer: (size: number) => number;
  compileAndRun: (ptr: number, length: number) => number;
}

export interface EchoResult {
  output: string;
  diagnostics: string;
  exitCode: number;
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

async function loadModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const response = await fetch(new URL("../assets/echo.wasm", import.meta.url));
      if (!response.ok) {
        throw new Error(`Failed to fetch echo WASM: ${response.status} ${response.statusText}`);
      }
      return WebAssembly.compile(await response.arrayBuffer());
    })().catch(error => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

export async function runEcho(source: string): Promise<EchoResult> {
  const bytes = new TextEncoder().encode(source);
  // echo.wasm copies source into a fixed 64 KiB buffer; reject truncation.
  if (bytes.length > 64 * 1024) {
    throw new Error("Programs must be at most 64 KiB to run in the echo platform.");
  }
  const module = await loadModule();
  const result: EchoResult = { output: "", diagnostics: "", exitCode: 255 };
  const decoder = new TextDecoder();
  let wasm: EchoExports;
  // Each run gets fresh compiler/runtime state, including after a WASM trap.
  const instance = await WebAssembly.instantiate(module, {
    env: {
      js_echo: (ptr: number, length: number) => {
        result.output += decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
      },
      js_stderr: (ptr: number, length: number) => {
        result.diagnostics += decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
      },
    },
  });
  wasm = instance.exports as unknown as EchoExports;
  wasm.init();
  const ptr = wasm.allocateBuffer(bytes.length);
  if (!ptr) throw new Error("Could not allocate source buffer in echo WASM.");
  new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
  try {
    result.exitCode = wasm.compileAndRun(ptr, bytes.length);
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) throw error;
    result.diagnostics += `\nExecution stopped: ${error.message}\n`;
  }
  // Terminal diagnostics use ANSI SGR colors; the output panel uses plain text.
  result.diagnostics = result.diagnostics.replace(/\u001b\[[0-9;]*m/g, "");
  return result;
}
