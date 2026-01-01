# Roc Playground

**Work in Progress** the Roc compiler is not yet ready for general use. This playground is intended for Roc developers and contributors.

There are many known bugs and issues with the Roc compiler. If you would like to help build the Roc compiler and improve this playground, please visit the Roc community on our [Roc Zulip Chat](https://roc.zulipchat.com/).


## Setup

The playground requires `playground.wasm` which is downloaded from the latest [Roc nightly release](https://github.com/roc-lang/nightlies/releases).

### Quick Start

```bash
npm run setup
```

This installs dependencies and downloads the latest `playground.wasm`.

### Manual Setup

```bash
npm install
npm run fetch-wasm
```

### Development

```bash
npm run dev
```

### Updating playground.wasm

To update to the latest nightly:

```bash
npm run fetch-wasm
```