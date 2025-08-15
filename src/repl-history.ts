/**
 * REPL History Management using Functional Programming principles
 * 
 * This module provides a robust, immutable history system for the REPL.
 * All operations return new state objects rather than mutating existing state.
 */

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Represents a single history entry
 */
export interface HistoryEntry {
  readonly id: string;
  readonly command: string;
  readonly timestamp: number;
}

/**
 * Represents the current state of history navigation
 */
export interface HistoryState {
  readonly entries: ReadonlyArray<HistoryEntry>;
  readonly currentIndex: number | null; // null means we're at the current input (not in history)
  readonly temporaryInput: string; // What the user was typing before navigating history
}

/**
 * Result of a history operation
 */
export type HistoryResult<T> = 
  | { success: true; value: T }
  | { success: false; error: string };

/**
 * History navigation direction
 */
export type NavigationDirection = 'backward' | 'forward';

// ============================================================================
// Pure Functions for History Management
// ============================================================================

/**
 * Creates an initial empty history state
 */
export const createEmptyHistory = (): HistoryState => ({
  entries: [],
  currentIndex: null,
  temporaryInput: ''
});

/**
 * Creates a history entry from a command
 */
const createHistoryEntry = (command: string): HistoryEntry => ({
  id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  command,
  timestamp: Date.now()
});

/**
 * Adds a new command to history
 * Pure function: returns new state without mutating the original
 */
export const addToHistory = (
  state: HistoryState,
  command: string
): HistoryResult<HistoryState> => {
  // Validation
  if (!command || command.trim().length === 0) {
    return { success: false, error: 'Cannot add empty command to history' };
  }

  // Don't add duplicates of the most recent command
  const lastEntry = state.entries[state.entries.length - 1];
  if (lastEntry && lastEntry.command === command.trim()) {
    // Just reset the navigation state
    return {
      success: true,
      value: {
        ...state,
        currentIndex: null,
        temporaryInput: ''
      }
    };
  }

  // Create new state with the added entry
  const newEntry = createHistoryEntry(command.trim());
  return {
    success: true,
    value: {
      entries: [...state.entries, newEntry],
      currentIndex: null,
      temporaryInput: ''
    }
  };
};

/**
 * Navigates backward in history (older entries)
 */
export const navigateBackward = (
  state: HistoryState,
  currentInput: string
): HistoryResult<{ state: HistoryState; display: string }> => {
  // No history to navigate
  if (state.entries.length === 0) {
    return { success: false, error: 'No history available' };
  }

  let newIndex: number;
  let newTemporaryInput: string;

  if (state.currentIndex === null) {
    // We're at current input, move to most recent history entry
    newIndex = state.entries.length - 1;
    newTemporaryInput = currentInput;
  } else if (state.currentIndex > 0) {
    // Move to older entry
    newIndex = state.currentIndex - 1;
    newTemporaryInput = state.temporaryInput;
  } else {
    // Already at oldest entry
    return { success: false, error: 'Already at oldest history entry' };
  }

  const newState: HistoryState = {
    ...state,
    currentIndex: newIndex,
    temporaryInput: newTemporaryInput
  };

  return {
    success: true,
    value: {
      state: newState,
      display: state.entries[newIndex]?.command ?? ''
    }
  };
};

/**
 * Navigates forward in history (newer entries)
 */
export const navigateForward = (
  state: HistoryState
): HistoryResult<{ state: HistoryState; display: string }> => {
  // Not in history navigation
  if (state.currentIndex === null) {
    return { success: false, error: 'Not currently navigating history' };
  }

  let newIndex: number | null;
  let display: string;

  if (state.currentIndex < state.entries.length - 1) {
    // Move to newer entry
    newIndex = state.currentIndex + 1;
    display = state.entries[newIndex]?.command ?? '';
  } else {
    // Return to current input
    newIndex = null;
    display = state.temporaryInput;
  }

  const newState: HistoryState = {
    ...state,
    currentIndex: newIndex,
    temporaryInput: newIndex === null ? '' : state.temporaryInput
  };

  return {
    success: true,
    value: {
      state: newState,
      display
    }
  };
};

/**
 * Clears all history
 */
export const clearHistory = (_state: HistoryState): HistoryState => ({
  entries: [],
  currentIndex: null,
  temporaryInput: ''
});

/**
 * Gets a display-friendly list of history entries
 */
export const getHistoryDisplay = (
  state: HistoryState,
  options: {
    maxEntries?: number;
    reverseOrder?: boolean;
  } = {}
): ReadonlyArray<{ index: number; command: string; timestamp: number }> => {
  const { maxEntries = Number.MAX_SAFE_INTEGER, reverseOrder = false } = options;
  
  const entries = state.entries.slice(-maxEntries);
  const indexed = entries.map((entry, idx) => ({
    index: state.entries.length - entries.length + idx + 1,
    command: entry.command,
    timestamp: entry.timestamp
  }));

  return reverseOrder ? indexed.reverse() : indexed;
};

/**
 * Searches history for commands matching a pattern
 */
export const searchHistory = (
  state: HistoryState,
  pattern: string,
  options: {
    caseSensitive?: boolean;
    regex?: boolean;
  } = {}
): ReadonlyArray<HistoryEntry> => {
  const { caseSensitive = false, regex = false } = options;

  if (!pattern) {
    return [];
  }

  let matcher: (command: string) => boolean;

  if (regex) {
    try {
      const re = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
      matcher = (command) => re.test(command);
    } catch {
      return []; // Invalid regex
    }
  } else {
    const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();
    matcher = (command) => {
      const searchTarget = caseSensitive ? command : command.toLowerCase();
      return searchTarget.includes(searchPattern);
    };
  }

  return state.entries.filter(entry => matcher(entry.command));
};

/**
 * Gets statistics about the history
 */
export const getHistoryStats = (state: HistoryState): {
  totalEntries: number;
  uniqueCommands: number;
  mostRecent: HistoryEntry | null;
  oldest: HistoryEntry | null;
} => {
  const uniqueCommands = new Set(state.entries.map(e => e.command)).size;
  
  return {
    totalEntries: state.entries.length,
    uniqueCommands,
    mostRecent: state.entries[state.entries.length - 1] || null,
    oldest: state.entries[0] || null
  };
};

/**
 * Removes duplicate consecutive commands from history
 */
export const deduplicateHistory = (state: HistoryState): HistoryState => {
  const deduplicated = state.entries.reduce<HistoryEntry[]>((acc, entry) => {
    const last = acc[acc.length - 1];
    if (!last || last.command !== entry.command) {
      acc.push(entry);
    }
    return acc;
  }, []);

  return {
    ...state,
    entries: deduplicated,
    currentIndex: null,
    temporaryInput: ''
  };
};

/**
 * Limits history to a maximum number of entries (removes oldest)
 */
export const limitHistorySize = (
  state: HistoryState,
  maxSize: number
): HistoryState => {
  if (maxSize <= 0) {
    return clearHistory(state);
  }

  if (state.entries.length <= maxSize) {
    return state;
  }

  const trimmed = state.entries.slice(-maxSize);
  const indexAdjustment = state.entries.length - trimmed.length;

  return {
    ...state,
    entries: trimmed,
    currentIndex: state.currentIndex === null 
      ? null 
      : Math.max(0, state.currentIndex - indexAdjustment),
    temporaryInput: state.temporaryInput
  };
};

// ============================================================================
// History Manager Class (Wrapper for stateful operations)
// ============================================================================

/**
 * A stateful wrapper around the pure history functions
 * This class maintains the state and provides a convenient API
 */
export class HistoryManager {
  private state: HistoryState;
  private readonly maxSize: number;
  private readonly deduplicateConsecutive: boolean;

  constructor(options: {
    maxSize?: number;
    deduplicateConsecutive?: boolean;
  } = {}) {
    this.state = createEmptyHistory();
    this.maxSize = options.maxSize || 1000;
    this.deduplicateConsecutive = options.deduplicateConsecutive ?? true;
  }

  /**
   * Gets the current state (read-only)
   */
  getState(): Readonly<HistoryState> {
    return this.state;
  }

  /**
   * Adds a command to history
   */
  add(command: string): boolean {
    const result = addToHistory(this.state, command);
    
    if (result.success) {
      this.state = result.value;
      
      // Apply size limit if needed
      if (this.state.entries.length > this.maxSize) {
        this.state = limitHistorySize(this.state, this.maxSize);
      }

      // Deduplicate if enabled
      if (this.deduplicateConsecutive) {
        this.state = deduplicateHistory(this.state);
      }

      // Debug: Log history state after add
      // console.log('[History] Added:', command, 'Total entries:', this.state.entries.length);
      // console.log('[History] Last 3 entries:', this.state.entries.slice(-3).map(e => e.command));
      return true;
    }

    return false;
  }

  /**
   * Navigates backward in history
   */
  navigateBackward(currentInput: string): string | null {
    // Debug: Log navigation state
    // console.log('[History] navigateBackward called');
    // console.log('[History] Current state:', {
    //   entries: this.state.entries.map(e => e.command),
    //   currentIndex: this.state.currentIndex,
    //   temporaryInput: this.state.temporaryInput,
    //   currentInput: currentInput
    // });
    
    const result = navigateBackward(this.state, currentInput);
    
    if (result.success) {
      this.state = result.value.state;
      // console.log('[History] Navigation successful, returning:', result.value.display);
      // console.log('[History] New index:', this.state.currentIndex);
      return result.value.display;
    }

    // console.log('[History] Navigation failed:', result.error);
    return null;
  }

  /**
   * Navigates forward in history
   */
  navigateForward(): string | null {
    const result = navigateForward(this.state);
    
    if (result.success) {
      this.state = result.value.state;
      return result.value.display;
    }

    return null;
  }

  /**
   * Clears all history
   */
  clear(): void {
    this.state = clearHistory(this.state);
  }

  /**
   * Gets display-friendly history
   */
  getDisplay(options?: Parameters<typeof getHistoryDisplay>[1]): ReturnType<typeof getHistoryDisplay> {
    return getHistoryDisplay(this.state, options);
  }

  /**
   * Searches history
   */
  search(pattern: string, options?: Parameters<typeof searchHistory>[2]): ReadonlyArray<HistoryEntry> {
    return searchHistory(this.state, pattern, options);
  }

  /**
   * Gets history statistics
   */
  getStats(): ReturnType<typeof getHistoryStats> {
    return getHistoryStats(this.state);
  }

  /**
   * Exports history as JSON
   */
  export(): string {
    return JSON.stringify({
      version: '1.0.0',
      entries: this.state.entries,
      exportedAt: Date.now()
    }, null, 2);
  }

  /**
   * Imports history from JSON
   */
  import(json: string): boolean {
    try {
      const data = JSON.parse(json);
      
      if (!data.entries || !Array.isArray(data.entries)) {
        return false;
      }

      // Validate and reconstruct entries
      const entries = data.entries
        .filter((e: any) => e.command && typeof e.command === 'string')
        .map((e: any) => ({
          id: e.id || `imported-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          command: e.command,
          timestamp: e.timestamp || Date.now()
        }));

      this.state = {
        entries,
        currentIndex: null,
        temporaryInput: ''
      };

      // Apply size limit
      if (this.state.entries.length > this.maxSize) {
        this.state = limitHistorySize(this.state, this.maxSize);
      }

      return true;
    } catch {
      return false;
    }
  }
}