# Roc browser WASM APIs

The playground uses two independent modules built from the commit in
[`roc-revision`](roc-revision). Run `npm run fetch-wasm` to build both with
Zig 0.17.0 in ReleaseSmall mode. `npm test` exercises the actual artifacts,
every bundled example, the REPL protocol, and echo execution.

Upstream implementations:

- `src/playground_wasm/main.zig`: compilation, inspection, and REPL messages.
- `src/echo_platform/echo.zig`: compile and run headerless `main!` programs.
- `src/echo_platform/www/app.js`: upstream JavaScript example of the echo API.

## playground.wasm

The adapter is [`src/wasm/roc-wasm.ts`](src/wasm/roc-wasm.ts). Instantiate with
`{ env: {} }`, then call the exported `init()` before sending messages.

### Request and response ownership

The playground uses the host-owned response buffer API:

1. Encode a JSON request as UTF-8.
2. Call `allocateMessageBuffer(byteLength)` and copy the bytes into exported
   `memory`. A zero pointer indicates allocation failure.
3. Call `allocateResponseBuffer(capacity)` with a 4 MiB capacity.
4. Call `processMessage(requestPointer, requestLength, responsePointer, capacity)`.
   It returns an integer error code; zero means the response was written.
5. Call `freeMessageBuffer()`.
6. Read the response's four-byte little-endian JSON byte length, followed by
   that many UTF-8 JSON bytes. Decode and parse the payload.
7. Call `freeResponseBuffer()`.

Recreate typed-array views after calls that may grow WASM memory. The adapter
serializes messages, because the compiler's loaded source and message buffer
are shared within an instance. A WASM trap invalidates that playground
instance; the page must be reloaded to recreate it.

The convenience API `processAndRespond(pointer, length)` also exists. It
returns a null-terminated JSON string that must be released with
`freeWasmString(pointer)`. Its fixed 128 KiB response buffer is too small for
CIR HTML from the bundled Records example, so the frontend uses the API above.
Do not read `processAndRespond` results using the length-prefixed buffer layout.

### Messages and states

The initial state is `START`. `INIT` returns `SUCCESS` with the compiler
version in `message` and enters `READY`. Versions identify both build mode
and commit, for example `release-small-98dcdbfb`.

In `READY`, submit source with an explicit filename:

```json
{
  "type": "LOAD_SOURCE",
  "source": "main! = |_| { echo!(\"Hello, World!\")\n Ok({}) }",
  "filename": "main.roc"
}
```

`LOAD_SOURCE` enters `LOADED` and returns diagnostics. A `SUCCESS` status
means the request was processed; inspect `diagnostics.summary.errors` to
find out whether the source has compilation errors.

The following messages inspect the loaded source:

| Message | Result |
| --- | --- |
| `QUERY_TOKENS` | Token HTML in `data` |
| `QUERY_AST` | AST HTML in `data` |
| `QUERY_CIR` | Canonical IR HTML in `data` |
| `QUERY_TYPES` | Inferred type HTML in `data` |
| `QUERY_FORMATTED` | Formatted Roc source in `data` |
| `EVALUATE_TESTS` | Results of `expect` tests as HTML in `data` |
| `GET_HOVER_INFO` | `hover_info`, or null when no information is available |

Hover requests include `identifier`, `line`, and `ch`. Both source coordinates
are one-based; the adapter adds one to CodeMirror's zero-based column.

`RESET` clears loaded source or REPL state and returns to `READY`. The adapter
sends it before each `LOAD_SOURCE`.

`INIT_REPL` enters `REPL_ACTIVE`. `REPL_STEP` takes an `input` string and
returns `result` with `output` and `type` (`definition`, `expression`, or
`error`). Error results may include `error_stage` and `error_details`.
`CLEAR_REPL` discards definitions while keeping the REPL active. The upstream
standalone `repl.wasm` has a separate protocol; it is not interchangeable with
these messages.

### Responses

All messages return `status`: `SUCCESS`, `ERROR`, `INVALID_STATE`, or
`INVALID_MESSAGE`. Depending on the message, responses may also contain
`message`, `data`, `diagnostics`, `hover_info`, `repl_info`, and `result`.

Compilation diagnostics include:

- `summary.errors` and `summary.warnings`.
- `html`: rendered diagnostic reports.
- `list`: structured diagnostics with `severity`, `message`, and `region`.
- `debug_counts`: compiler-stage counts.

Regions contain `start_line`, `start_column`, `end_line`, and `end_column`,
all one-based. Hover information contains `name`, `type_str`,
`definition_region`, and optional `docs`.

Debug exports include `getDebugLogBuffer()` (null-terminated text),
`getDebugLogLength()`, and `clearDebugLog()`.

## echo.wasm

The Output tab uses [`src/wasm/echo-wasm.ts`](src/wasm/echo-wasm.ts), independently
of the inspection module. It does not send `RUN_MAIN` or rely on an
`is_runnable` field; those are not part of the pinned playground protocol.

Instantiate with two imports:

- `env.js_echo(pointer, length)`: receive UTF-8 program output.
- `env.js_stderr(pointer, length)`: receive UTF-8 compiler/runtime diagnostics.

Read callback bytes from that instance's exported `memory`. For each run:

1. Call `init()`.
2. Encode source as UTF-8, call `allocateBuffer(byteLength)`, and copy the bytes
   into exported `memory`.
3. Call `compileAndRun(pointer, byteLength)`.

Source must be a headerless program containing `main!`. The return value is
its exit code: zero means success, and 255 indicates compilation/execution
failure. Other nonzero program exit codes are also possible. A compiler or
runtime trap can instead throw a JavaScript `WebAssembly.RuntimeError`.

The source buffer is limited to 64 KiB. The frontend rejects larger UTF-8
inputs, since the upstream API otherwise truncates them. It creates a fresh
instance for each run while caching the compiled WebAssembly module, so a
trapped instance is never reused. Output is rendered as text, and ANSI SGR
color codes are removed from diagnostics.

The upstream API additionally supports
`addFile(namePointer, nameLength, contentPointer, contentLength)` after `init`
and before `compileAndRun`. This registers up to 16 imported modules, with
names up to 256 bytes and contents up to 64 KiB each. The current playground
editor supplies a single source file and does not expose module registration.
