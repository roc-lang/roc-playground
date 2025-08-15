/**
 * Shared debug utility for the Roc Playground
 * Provides centralized verbose logging that can be toggled on/off
 */

// Global verbose flag for debug logging
let verbose = false;

/**
 * Debug logging helper - only logs when verbose mode is enabled
 */
export function debugLog(...args: any[]): void {
  if (verbose) {
    console.log(...args);
  }
}

/**
 * Check if verbose logging is currently enabled
 */
export function isVerbose(): boolean {
  return verbose;
}

/**
 * Function to toggle verbose logging on/off
 */
export function toggleVerboseLogging(): void {
  verbose = !verbose;
  console.log(`Verbose logging ${verbose ? "enabled" : "disabled"}`);
}

/**
 * Initialize debug utilities and expose toggle function globally
 */
export function initializeDebug(): void {
  // Make toggle function available globally for debugging
  (window as any).toggleVerboseLogging = toggleVerboseLogging;

  // Also expose the verbose flag for direct checking
  Object.defineProperty(window, "isVerboseEnabled", {
    get: () => verbose,
    configurable: true,
  });
}

/**
 * Force enable verbose logging (useful for testing)
 */
export function enableVerbose(): void {
  verbose = true;
}

/**
 * Force disable verbose logging
 */
export function disableVerbose(): void {
  verbose = false;
}
