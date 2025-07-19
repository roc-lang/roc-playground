import { Diagnostic, linter, lintGutter } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { Text } from "@codemirror/state";

export interface RocDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  region: {
    start_line: number;
    start_column: number;
    end_line: number;
    end_column: number;
  };
  code?: string;
}

/**
 * Converts structured region data to CodeMirror document positions
 */
function regionToPositions(
  region: {
    start_line: number;
    start_column: number;
    end_line: number;
    end_column: number;
  },
  doc: Text,
): { from: number; to: number } | null {
  try {
    // CodeMirror uses 0-based indexing, but compiler uses 1-based
    const startLine = Math.max(0, region.start_line - 1);
    const startColumn = Math.max(0, region.start_column - 1);
    const endLine = Math.max(0, region.end_line - 1);
    const endColumn = Math.max(0, region.end_column - 1);

    if (startLine >= doc.lines || endLine >= doc.lines) {
      return null;
    }

    const startLineObj = doc.line(startLine + 1);
    const from = startLineObj.from + Math.min(startColumn, startLineObj.length);

    const endLineObj = doc.line(endLine + 1);
    const to = endLineObj.from + Math.min(endColumn, endLineObj.length);

    return { from, to: Math.max(from, to) };
  } catch (error) {
    console.warn("Failed to convert region to positions:", error);
    return null;
  }
}

/**
 * Creates a linter that integrates with Roc compiler diagnostics
 */
export function createRocLinter(getDiagnostics: () => RocDiagnostic[]) {
  return linter((view) => {
    const diagnostics: Diagnostic[] = [];
    const rocDiagnostics = getDiagnostics();

    for (const rocDiag of rocDiagnostics) {
      const positions = regionToPositions(rocDiag.region, view.state.doc);
      if (!positions) {
        console.warn("Could not convert region to positions:", rocDiag.region);
        continue;
      }

      diagnostics.push({
        from: positions.from,
        to: positions.to,
        severity: rocDiag.severity,
        message: rocDiag.message,
      });
    }

    return diagnostics;
  });
}

/**
 * State effect to update diagnostics
 */
export const updateDiagnostics = StateEffect.define<RocDiagnostic[]>();

/**
 * State field to store current diagnostics
 */
export const diagnosticsState = StateField.define<RocDiagnostic[]>({
  create: () => [],
  update: (diagnostics, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(updateDiagnostics)) {
        return effect.value;
      }
    }
    return diagnostics;
  },
});

/**
 * Extension that provides diagnostic integration
 */
export function rocDiagnostics() {
  return [
    diagnosticsState,
    lintGutter(),
    createRocLinter(() => {
      // This will be called by the linter to get current diagnostics
      // We'll update this when we integrate with the editor
      return [];
    }),
  ];
}

/**
 * Updates diagnostics in the editor view
 */
export function updateEditorDiagnostics(
  view: EditorView,
  diagnostics: RocDiagnostic[],
): void {
  view.dispatch({
    effects: updateDiagnostics.of(diagnostics),
  });
}

/**
 * Creates a diagnostic-aware linter that uses the state field
 */
export function createStatefulRocLinter() {
  return linter((view) => {
    const diagnostics: Diagnostic[] = [];
    const rocDiagnostics = view.state.field(diagnosticsState, false) || [];

    for (const rocDiag of rocDiagnostics) {
      const positions = regionToPositions(rocDiag.region, view.state.doc);
      if (!positions) {
        continue;
      }

      diagnostics.push({
        from: positions.from,
        to: positions.to,
        severity: rocDiag.severity,
        message: rocDiag.message,
      });
    }

    return diagnostics;
  });
}

/**
 * Complete diagnostic extension with state management
 */
export function rocDiagnosticsExtension() {
  return [diagnosticsState, lintGutter(), createStatefulRocLinter()];
}
