import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { examples } from "../src/examples.ts";
import { runEcho } from "../src/wasm/echo-wasm.ts";

const revision = (await readFile(new URL("../roc-revision", import.meta.url), "utf8")).trim();
const { instance } = await WebAssembly.instantiate(
  await readFile(new URL("../src/assets/playground.wasm", import.meta.url)),
  { env: {} },
);
const wasm = instance.exports;
wasm.init();
function send(message) {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  const ptr = wasm.allocateMessageBuffer(bytes.length);
  assert(ptr, "allocateMessageBuffer returned null");
  new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
  const capacity = 4 * 1024 * 1024;
  const responsePtr = wasm.allocateResponseBuffer(capacity);
  assert(responsePtr, "allocateResponseBuffer returned null");
  const status = wasm.processMessage(ptr, bytes.length, responsePtr, capacity);
  wasm.freeMessageBuffer();
  assert.equal(status, 0, `processMessage failed for ${message.type}: ${status}`);
  const length = new DataView(wasm.memory.buffer).getUint32(responsePtr, true);
  assert(length > 0 && length <= capacity - 4, "Invalid response length");
  const response = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, responsePtr + 4, length)));
  wasm.freeResponseBuffer();
  assert.equal(response.status, "SUCCESS", JSON.stringify({ message, response }));
  return response;
}
assert(send({ type: "INIT" }).message.includes(revision.slice(0, 8)));
for (const example of examples) {
  send({ type: "RESET" });
  const loaded = send({ type: "LOAD_SOURCE", source: example.code, filename: example.rocFilename });
  assert.equal(loaded.diagnostics.summary.errors, 0, `${example.name}: ${JSON.stringify(loaded.diagnostics.list)}`);
  for (const type of ["QUERY_TOKENS", "QUERY_AST", "QUERY_CIR", "QUERY_TYPES", "QUERY_FORMATTED", "EVALUATE_TESTS"]) {
    assert(send({ type }).data, `${example.name}: ${type} must return data`);
  }
  console.log(`Compiler example passed: ${example.name}`);
}
send({ type: "RESET" });
send({ type: "LOAD_SOURCE", source: 'main! = |_| {}\n\nfoo = "bar"', filename: "main.roc" });
const hover = send({ type: "GET_HOVER_INFO", identifier: "foo", line: 3, ch: 1 });
assert.match(hover.hover_info.type_str, /Str/);
console.log("Hover protocol passed");
send({ type: "RESET" });
send({ type: "INIT_REPL" });
assert(send({ type: "REPL_STEP", input: "1 + 2" }).result.output.includes("3"));
send({ type: "CLEAR_REPL" });
console.log("REPL protocol passed");

// Load the real echo artifact through the browser adapter, without an HTTP server.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(new URL(url).pathname.endsWith("/assets/echo.wasm"), true);
  return new Response(await readFile(new URL("../src/assets/echo.wasm", import.meta.url)));
};
try {
  for (const message of ["Hello, World!", "héllo 🌍", "<script>alert(1)</script>"]) {
    const result = await runEcho(`main! = |_| { echo!("${message}")\n Ok({}) }`);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output.trim(), message);
  }
  const invalid = await runEcho("main! = |_| { missing!() }");
  assert.notEqual(invalid.exitCode, 0);
  assert.match(invalid.diagnostics, /missing/);
  assert(!invalid.diagnostics.includes("\u001b["), "Diagnostics must not contain ANSI colors");
  const crash = await runEcho('main! = |_| { crash "deliberate crash" }');
  assert.notEqual(crash.exitCode, 0);
  assert(crash.diagnostics.length > 0);
  const recovery = await runEcho('main! = |_| { echo!("after error")\n Ok({}) }');
  assert.equal(recovery.exitCode, 0, JSON.stringify(recovery));
  assert.equal(recovery.output.trim(), "after error");
  await assert.rejects(() => runEcho("x".repeat(65537)), /64 KiB/);
  console.log("Echo output, diagnostics, trap recovery, and size limit passed");
} finally {
  globalThis.fetch = originalFetch;
}
