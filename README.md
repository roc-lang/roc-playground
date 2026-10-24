# Roc Playground

**Work in Progress** the Roc compiler is not yet ready for general use. This playground is intended for Roc developers and contributors.

There are many known bugs and issues with the Roc compiler. If you would like to help build the Roc compiler and improve this playground, please visit the Roc community on our [Roc Zulip Chat](https://roc.zulipchat.com/).


## Setup

The playground builds `playground.wasm` and `echo.wasm` from the exact [roc-lang/roc](https://github.com/roc-lang/roc) commit in `roc-revision`. Install [Node.js 24 LTS](https://nodejs.org/), Git and [Zig 0.17.0](https://ziglang.org/download/) and add them to your PATH before setup. Local setup and CI use the same revision and ReleaseSmall build.

### Quick Start

```bash
npm run setup
```

This installs dependencies and builds `playground.wasm` and `echo.wasm`. Roc source and build files are cached in `.cache/roc/`.

### Manual Setup

```bash
npm ci
npm run fetch-wasm
```

### Development

```bash
npm run dev
```

### Updating Roc

To upgrade Roc, put the full upstream Git SHA in `roc-revision`, then rebuild:

```bash
npm run fetch-wasm
```

The Output tab runs headerless programs containing `main!` through Roc’s echo platform and displays `echo!` output and compiler diagnostics. Programs are limited to 64 KiB by the echo API.

### Verification

After setup, run the same checks as CI:

```bash
npm audit --audit-level=high
npm run typecheck
npm test
npm run build
```

The tests load both WASM artifacts, compile every bundled example, exercise all compiler views and hover, evaluate a REPL expression, and check echo output, diagnostics, and recovery after execution errors.
