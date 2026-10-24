#!/usr/bin/env bash
set -euo pipefail

# Build the playground from the exact upstream revision used by this project.
PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROC_REVISION=$(cat "$PROJECT_DIR/roc-revision")
if [[ ! "$ROC_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Error: roc-revision must contain a full Git SHA" >&2
    exit 1
fi

command -v zig >/dev/null || { echo "Error: Install Zig 0.17.0 and add it to PATH" >&2; exit 1; }
SOURCE_DIR="$PROJECT_DIR/.cache/roc/$ROC_REVISION"
mkdir -p "$SOURCE_DIR"
if [ ! -d "$SOURCE_DIR/.git" ]; then
    git init "$SOURCE_DIR"
    git -C "$SOURCE_DIR" remote add origin https://github.com/roc-lang/roc.git
fi
if ! git -C "$SOURCE_DIR" cat-file -e "$ROC_REVISION^{commit}" 2>/dev/null; then
    git -C "$SOURCE_DIR" fetch --depth=1 origin "$ROC_REVISION"
fi
git -C "$SOURCE_DIR" checkout --detach "$ROC_REVISION"
if [ -n "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=no)" ]; then
    echo "Error: Cached Roc source has local changes: $SOURCE_DIR" >&2
    exit 1
fi

echo "Building playground.wasm and echo.wasm from roc-lang/roc@$ROC_REVISION (ReleaseSmall)..."
(cd "$SOURCE_DIR" && zig build build-playground build-echo-wasm -Doptimize=ReleaseSmall)
mkdir -p "$PROJECT_DIR/src/assets"
cp "$SOURCE_DIR/zig-out/bin/playground.wasm" "$PROJECT_DIR/src/assets/playground.wasm"
cp "$SOURCE_DIR/zig-out/lib/echo/echo.wasm" "$PROJECT_DIR/src/assets/echo.wasm"
echo "Built playground.wasm and echo.wasm from $ROC_REVISION"
