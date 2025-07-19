import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { hoverTooltip, keymap } from "@codemirror/view";
import { search, openSearchPanel } from "@codemirror/search";
import {
  defaultKeymap,
  indentMore,
  indentLess,
  toggleComment,
} from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import { closeBrackets } from "@codemirror/autocomplete";
import { rocStreamLanguage } from "./roc-language";
import {
  rocDiagnosticsExtension,
  updateEditorDiagnostics,
  RocDiagnostic,
} from "./diagnostics";

interface EditorViewOptions {
  doc?: string;
  theme?: "light" | "dark";
  hoverTooltip?: (view: EditorView, pos: number, side: number) => Promise<any>;
  onChange?: (content: string) => void;
  diagnostics?: RocDiagnostic[];
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
    search(),
    EditorView.lineWrapping,
    rocStreamLanguage(),

    // Diagnostic integration
    rocDiagnosticsExtension(),

    // Better indentation handling
    indentOnInput(),

    // Auto-complete brackets and quotes
    closeBrackets(),

    // Highlight matching brackets
    bracketMatching(),

    // Enhanced key bindings
    keymap.of([
      ...defaultKeymap,
      { key: "Tab", run: indentMore, preventDefault: true },
      { key: "Shift-Tab", run: indentLess, preventDefault: true },
      { key: "Ctrl-/", run: toggleComment },
      { key: "Cmd-/", run: toggleComment },
    ]),

    EditorView.theme({
      "&": {
        fontSize: "14px",
        fontFamily:
          "'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace",
      },
      ".cm-content": {
        padding: "16px",
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
      },
    }),
  ];

  // Add theme
  if (options.theme === "dark") {
    extensions.push(oneDark);
  }

  // Add hover tooltip if provided
  if (options.hoverTooltip) {
    extensions.push(hoverTooltip(options.hoverTooltip));
  }

  // Add change handler if provided
  if (options.onChange) {
    const changeHandler = options.onChange;
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          changeHandler(update.state.doc.toString());
        }
      }),
    );
  }

  const state = EditorState.create({
    doc: options.doc || "",
    extensions,
  });

  return new EditorView({
    state,
    parent,
  });
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
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: content,
    },
  });
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

// Export the search function for compatibility
export { openSearchPanel };
// Export diagnostic types for use in other modules
export type { RocDiagnostic };
