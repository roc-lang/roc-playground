#!/usr/bin/env bash
set -euo pipefail

# Script to download playground.wasm from the latest Roc nightly release

DEST_DIR="src/assets"
DEST_FILE="$DEST_DIR/playground.wasm"

echo "Fetching latest nightly release info from GitHub..."

# Get the latest release from roc-lang/nightlies
LATEST_RELEASE=$(curl -s "https://api.github.com/repos/roc-lang/nightlies/releases/latest")

# Extract the tag name
TAG_NAME=$(echo "$LATEST_RELEASE" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$TAG_NAME" ]; then
    echo "Error: Could not determine latest nightly release tag"
    exit 1
fi

echo "Latest nightly release: $TAG_NAME"

# Construct the download URL
DOWNLOAD_URL="https://github.com/roc-lang/nightlies/releases/download/$TAG_NAME/playground.wasm"

echo "Downloading playground.wasm from $DOWNLOAD_URL..."

# Ensure destination directory exists
mkdir -p "$DEST_DIR"

# Download the file
if curl -L --fail -o "$DEST_FILE" "$DOWNLOAD_URL"; then
    FILE_SIZE=$(wc -c < "$DEST_FILE" | tr -d ' ')
    echo "Successfully downloaded playground.wasm ($FILE_SIZE bytes)"
else
    echo "Error: Failed to download playground.wasm"
    echo "URL: $DOWNLOAD_URL"
    exit 1
fi
