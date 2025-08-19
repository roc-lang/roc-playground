import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import {
  hoverTooltip,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import {
  search,
  openSearchPanel,
  replaceNext,
  replaceAll,
  selectNextOccurrence,
  selectMatches,
} from "@codemirror/search";
import {
  defaultKeymap,
  indentMore,
  indentLess,
  toggleComment,
} from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  indentOnInput,
  bracketMatching,
  foldGutter,
  codeFolding,
} from "@codemirror/language";
import { EditorView as EditorViewCore } from "@codemirror/view";
import { closeBrackets } from "@codemirror/autocomplete";
import { rocStreamLanguage } from "./roc-language";
import {
  rocDiagnosticsExtension,
  updateEditorDiagnostics,
  RocDiagnostic,
} from "./diagnostics";

// Theme compartment for dynamic theme switching
const themeCompartment = new Compartment();

interface EditorViewOptions {
  doc?: string;
  theme?: "light" | "dark";
  hoverTooltip?: (view: EditorView, pos: number, side: number) => Promise<any>;
  onChange?: (content: string) => void;
  diagnostics?: RocDiagnostic[];
  largeDocument?: boolean;
  enableViewportDecorations?: boolean;
  searchConfig?: {
    top?: boolean;
    caseSensitive?: boolean;
    regexp?: boolean;
    wholeWord?: boolean;
  };
  accessibilityConfig?: {
    announceChanges?: boolean;
    reduceMotion?: boolean;
    highContrast?: boolean;
  };
}

/**
 * Factory function to create a basic editor with minimal features
 */
export function createMinimalEditor(
  parent: HTMLElement,
  content: string = "",
  onChange?: (content: string) => void,
): EditorView {
  const editorOptions: EditorViewOptions = {
    doc: content,
  };
  if (onChange) {
    editorOptions.onChange = onChange;
  }
  return createEditorView(parent, editorOptions);
}

/**
 * Creates a CodeMirror 6 editor view with the specified configuration
 */
export function createEditorView(
  parent: HTMLElement,
  options: EditorViewOptions = {},
): EditorView {
  if (!parent) {
    throw new Error("Parent element is required for createEditorView");
  }

  const extensions = [
    basicSetup,
    search(
      options.searchConfig || {
        top: false,
        caseSensitive: false,
        regexp: false,
        wholeWord: false,
      },
    ),
    EditorView.lineWrapping,
    rocStreamLanguage(),

    // Multi-cursor support
    EditorState.allowMultipleSelections.of(true),

    // Line numbers
    lineNumbers(),

    // Code folding
    codeFolding(),
    foldGutter(),

    // Active line highlighting
    highlightActiveLine(),
    highlightActiveLineGutter(),

    // Diagnostic integration
    rocDiagnosticsExtension(),

    // Better indentation handling
    indentOnInput(),

    // Auto-complete brackets and quotes
    closeBrackets(),

    // Highlight matching brackets
    bracketMatching(),

    // Performance optimizations for large documents
    ...(options.largeDocument
      ? [
          EditorView.scrollMargins.of(() => ({ top: 100, bottom: 100 })),
          EditorState.tabSize.of(2), // Smaller tabs for better performance
        ]
      : []),

    // Enhanced key bindings
    keymap.of([
      ...defaultKeymap,
      { key: "Tab", run: indentMore, preventDefault: true },
      { key: "Shift-Tab", run: indentLess, preventDefault: true },
      { key: "Ctrl-/", run: toggleComment },
      { key: "Cmd-/", run: toggleComment },
      // Find and replace
      { key: "Ctrl-h", mac: "Cmd-Alt-f", run: openSearchPanel },
      { key: "Ctrl-Shift-l", mac: "Cmd-Shift-l", run: selectMatches },
      { key: "Ctrl-d", mac: "Cmd-d", run: selectNextOccurrence },
      // Replace commands (will work when search panel is open)
      { key: "Ctrl-Shift-h", mac: "Cmd-Alt-h", run: replaceNext },
      { key: "Ctrl-Shift-Alt-h", mac: "Cmd-Alt-Shift-h", run: replaceAll },
    ]),

    EditorView.theme({
      "&": {
        fontSize: "14px",
        fontFamily:
          "'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace",
      },
      ".cm-content": {
        padding: "16px",
        // Better IME support
        "ime-mode": "auto",
      },
      ".cm-editor": {
        borderRadius: "4px",
        border: "1px solid var(--border-color, #e1e5e9)",
      },
      ".cm-scroller": {
        borderRadius: "4px",
      },
      ".cm-focused": {
        outline: "2px solid var(--accent-color, #7c3aed)",
        // Ensure focus is visible for screen readers
        outlineOffset: "2px",
      },
      // Accessibility improvements
      ".cm-line": {
        // Better line height for readability
        lineHeight: options.accessibilityConfig?.highContrast ? "1.6" : "1.4",
      },
      // Reduce motion if requested
      ...(options.accessibilityConfig?.reduceMotion && {
        "*": {
          animationDuration: "0.01ms !important",
          animationIterationCount: "1 !important",
          transitionDuration: "0.01ms !important",
        },
      }),
    }),
  ];

  // Add theme using compartment for dynamic switching
  extensions.push(themeCompartment.of(options.theme === "dark" ? oneDark : []));

  // Add change handler if provided
  if (options.onChange) {
    const changeHandler = options.onChange;
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          try {
            changeHandler(update.state.doc.toString());
          } catch (error) {
            console.error("Error in change handler:", error);
          }
        }
      }),
    );
  }

  // Add hover tooltip if provided
  if (options.hoverTooltip) {
    extensions.push(hoverTooltip(options.hoverTooltip));
  }

  const state = EditorState.create({
    doc: options.doc || "",
    extensions,
    ...(options.largeDocument && {
      // Performance optimizations for large documents
      lineSeparator: "\n", // Consistent line separators
    }),
  });

  try {
    const view = new EditorView({
      state,
      parent,
    });

    return view;
  } catch (error) {
    console.error("Failed to create CodeMirror editor:", error);
    throw new Error(
      `CodeMirror initialization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Gets the current document content from an editor view
 */
export function getDocumentContent(view: EditorView): string {
  return view.state.doc.toString();
}

/**
 * Sets the document content in an editor view
 */
export function setDocumentContent(view: EditorView, content: string): void {
  try {
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
    });
  } catch (error) {
    console.error("Failed to set document content:", error);
    throw new Error(
      `Failed to update document: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Updates diagnostics in an editor view
 */
export function updateDiagnosticsInView(
  view: EditorView,
  diagnostics: RocDiagnostic[],
): void {
  updateEditorDiagnostics(view, diagnostics);
}

/**
 * Updates the theme of an existing editor view
 */
export function updateEditorTheme(
  view: EditorView,
  theme: "light" | "dark",
): void {
  try {
    view.dispatch({
      effects: themeCompartment.reconfigure(theme === "dark" ? oneDark : []),
    });
  } catch (error) {
    console.error("Failed to update editor theme:", error);
    throw new Error(
      `Failed to update theme: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Factory function to create a full-featured editor for development
 */
export function createFullEditor(
  parent: HTMLElement,
  options: {
    content?: string;
    theme?: "light" | "dark";
    onChange?: (content: string) => void;
    onHover?: (view: EditorView, pos: number, side: number) => Promise<any>;
    diagnostics?: RocDiagnostic[];
  } = {},
): EditorView {
  const editorOptions: EditorViewOptions = {
    doc: options.content || "",
    theme: options.theme || "light",
  };
  if (options.onChange) {
    editorOptions.onChange = options.onChange;
  }
  if (options.onHover) {
    editorOptions.hoverTooltip = options.onHover;
  }
  if (options.diagnostics) {
    editorOptions.diagnostics = options.diagnostics;
  }
  return createEditorView(parent, editorOptions);
}

/**
 * Factory function to create a read-only editor for display purposes
 */
export function createReadOnlyEditor(
  parent: HTMLElement,
  content: string,
  theme: "light" | "dark" = "light",
): EditorView {
  const extensions = [
    basicSetup,
    rocStreamLanguage(),
    themeCompartment.of(theme === "dark" ? oneDark : []),
    EditorState.readOnly.of(true),
    EditorViewCore.editable.of(false),
  ];

  const state = EditorState.create({
    doc: content,
    extensions,
  });

  return new EditorView({
    state,
    parent,
  });
}

/**
 * Factory function to create an editor optimized for large documents
 */
export function createLargeDocumentEditor(
  parent: HTMLElement,
  options: {
    content?: string;
    theme?: "light" | "dark";
    onChange?: (content: string) => void;
  } = {},
): EditorView {
  const editorOptions: EditorViewOptions = {
    doc: options.content || "",
    theme: options.theme || "light",
    largeDocument: true,
  };
  if (options.onChange) {
    editorOptions.onChange = options.onChange;
  }
  return createEditorView(parent, editorOptions);
}

/**
 * Factory function to create an accessible editor with enhanced a11y features
 */
export function createAccessibleEditor(
  parent: HTMLElement,
  options: {
    content?: string;
    theme?: "light" | "dark";
    onChange?: (content: string) => void;
    highContrast?: boolean;
  } = {},
): EditorView {
  const editorOptions: EditorViewOptions = {
    doc: options.content || "",
    theme: options.theme || "light",
  };
  if (options.onChange) {
    editorOptions.onChange = options.onChange;
  }
  return createEditorView(parent, editorOptions);
}

// Export the search function for compatibility
export { openSearchPanel };
// Export diagnostic types for use in other modules
export type { RocDiagnostic };
