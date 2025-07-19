import { EditorView } from "@codemirror/view";

interface WasmInterface {
  getTypeInfo: (identifier: string, line: number, ch: number) => Promise<any>;
}

interface TypeInfo {
  type: string;
  description?: string | null;
}

interface WordInfo {
  word: string;
  start: number;
  end: number;
  lineNumber: number;
  column: number;
}

/**
 * Creates a hover tooltip function for type hints
 */
export function createTypeHintTooltip(wasmInterface: WasmInterface | null) {
  return async (view: EditorView, pos: number, _side: number) => {
    if (!wasmInterface) {
      return null;
    }

    // Get the word at the current position
    const wordInfo = getWordAtPosition(view, pos);
    if (!wordInfo || wordInfo.word.length === 0) {
      return null;
    }

    try {
      // Calculate line/column from position
      const line = view.state.doc.lineAt(pos);
      const lineNumber = line.number - 1; // Convert to 0-based
      const column = pos - line.from;

      // Get type information from WASM
      const typeInfo = await getTypeInformation(
        wasmInterface,
        wordInfo.word,
        lineNumber,
        column,
      );
      if (!typeInfo) {
        return null;
      }

      return {
        pos,
        above: true,
        create(_view: EditorView) {
          const dom = createTooltipDOM(typeInfo);
          return { dom };
        },
      };
    } catch (error) {
      console.error("Error getting type information:", error);
      return null;
    }
  };
}

/**
 * Gets the word at a specific position in the editor
 */
function getWordAtPosition(view: EditorView, pos: number): WordInfo | null {
  const line = view.state.doc.lineAt(pos);
  const lineText = line.text;
  const linePos = pos - line.from;

  // Check if we're on a valid identifier character
  const currentChar = lineText[linePos] || "";
  if (!/[a-zA-Z0-9_!]/.test(currentChar)) {
    return null;
  }

  // Find word boundaries for Roc identifiers
  let start = linePos;
  let end = linePos;

  // Move start backward to find beginning of identifier
  // Roc identifiers can contain letters, numbers, and underscores
  while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1] || "")) {
    start--;
  }

  // Move end forward to find end of identifier
  // Include letters, numbers, and underscores
  while (end < lineText.length && /[a-zA-Z0-9_]/.test(lineText[end] || "")) {
    end++;
  }

  // Check for effect suffix (!) - this should be the last character
  if (end < lineText.length && lineText[end] === "!") {
    end++;
  }

  if (start === end) {
    return null;
  }

  const word = lineText.slice(start, end);
  return {
    word,
    start: line.from + start,
    end: line.from + end,
    lineNumber: line.number - 1, // 0-based
    column: start,
  };
}

/**
 * Creates the DOM element for the type hint tooltip
 */
function createTooltipDOM(typeInfo: TypeInfo): HTMLElement {
  const element = document.createElement("span");

  // Show only the type information - no styling since CodeMirror handles the tooltip container
  if (typeInfo.type) {
    element.textContent = typeInfo.type;
  } else {
    element.textContent = "Unknown type";
  }

  return element;
}

/**
 * Gets type information for a word at a specific position
 */
async function getTypeInformation(
  wasmInterface: WasmInterface | null,
  identifier: string,
  line: number,
  column: number,
): Promise<TypeInfo | null> {
  try {
    if (!wasmInterface || !wasmInterface.getTypeInfo) {
      console.warn("getTypeInfo not available in WASM interface");
      return null;
    }

    const result = await wasmInterface.getTypeInfo(identifier, line, column);

    if (!result || result.error || result.status !== "SUCCESS") {
      return null;
    }

    // Extract type information from the response
    const typeInfo = result.type_info;
    if (!typeInfo || !typeInfo.type) {
      return null;
    }

    return {
      type: typeInfo.type,
      description: typeInfo.description || null,
    };
  } catch (error) {
    console.error("Error in getTypeInformation:", error);
    return null;
  }
}

/**
 * Utility function to show a type hint tooltip at a specific position
 */
export async function showTypeHintAtPosition(
  view: EditorView,
  pos: number,
  wasmInterface: WasmInterface | null,
): Promise<void> {
  const wordInfo = getWordAtPosition(view, pos);
  if (!wordInfo) return;

  const typeInfo = await getTypeInformation(
    wasmInterface,
    wordInfo.word,
    wordInfo.lineNumber,
    wordInfo.column,
  );
  if (!typeInfo) return;

  // Create and show tooltip
  const tooltip = createTooltipDOM(typeInfo);
  document.body.appendChild(tooltip);

  // Position the tooltip
  const coords = view.coordsAtPos(pos);
  if (coords) {
    tooltip.style.position = "fixed";
    tooltip.style.left = coords.left + "px";
    tooltip.style.top = coords.top - 40 + "px";
  }

  // Auto-hide after 3 seconds
  setTimeout(() => {
    if (tooltip.parentNode) {
      tooltip.parentNode.removeChild(tooltip);
    }
  }, 3000);
}

/**
 * Hides any visible type hint tooltips
 */
export function hideTypeHint(): void {
  const tooltips = document.querySelectorAll(".cm-tooltip-type-hint");
  tooltips.forEach((tooltip) => {
    if (tooltip.parentNode) {
      tooltip.parentNode.removeChild(tooltip);
    }
  });
}
