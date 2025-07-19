import {
  LanguageSupport,
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
  StringStream,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

interface StreamState {
  context?: string;
  tokenize?: (stream: StringStream, state: StreamState) => string | null;
  inString?: boolean;
  stringQuote?: string;
  interpolationDepth?: number;
  braceDepth?: number;
  parenDepth?: number;
  bracketDepth?: number;
  lastToken?: string;
  expectingValue?: boolean;
  inComment?: boolean;
  errorRecovery?: boolean;
}

// Define the highlight style that maps token types to CSS classes
const rocHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, class: "cm-keyword" },
  { tag: t.string, class: "cm-string" },
  { tag: t.number, class: "cm-number" },
  { tag: t.comment, class: "cm-comment" },
  { tag: t.operator, class: "cm-operator" },
  { tag: t.punctuation, class: "cm-punctuation" },
  { tag: t.typeName, class: "cm-type" },
  { tag: t.className, class: "cm-builtin" },
  { tag: t.variableName, class: "cm-variable" },
  { tag: t.literal, class: "cm-constant" },
  { tag: t.processingInstruction, class: "cm-string" },
  { tag: t.invalid, class: "cm-error" },
]);

// Create the language support with custom highlighting
export function rocStreamLanguage(): LanguageSupport {
  const streamLang = StreamLanguage.define({
    name: "roc",

    startState(): StreamState {
      return {
        braceDepth: 0,
        parenDepth: 0,
        bracketDepth: 0,
        interpolationDepth: 0,
        expectingValue: false,
        inComment: false,
        errorRecovery: false,
      };
    },

    token(stream: StringStream, state: StreamState): string | null {
      // Skip whitespace
      if (stream.eatSpace()) return null;

      const ch = stream.next();
      if (!ch) return null;

      // Error recovery: if we're in error recovery mode, try to find a safe point
      if (state.errorRecovery) {
        // Look for statement boundaries or safe tokens
        if (ch === "\n" || ch === ";" || ch === "}" || ch === ")") {
          state.errorRecovery = false;
          if (ch === "}")
            state.braceDepth = Math.max(0, (state.braceDepth || 0) - 1);
          if (ch === ")")
            state.parenDepth = Math.max(0, (state.parenDepth || 0) - 1);
          return "punctuation";
        }
        // Continue consuming tokens in error recovery
        stream.next();
        return "error";
      }

      // Comments
      if (ch === "#") {
        state.inComment = true;
        stream.skipToEnd();
        state.inComment = false;
        return "comment";
      }

      // Strings with better error recovery
      if (ch === '"') {
        const quote = ch;
        let escaped = false;
        let next: string | void;
        let foundEnd = false;

        while ((next = stream.next()) !== undefined) {
          if (next === quote && !escaped) {
            foundEnd = true;
            break;
          }

          // String interpolation with error recovery
          if (next === "$" && stream.peek() === "{" && !escaped) {
            stream.next(); // consume {
            let depth = 1;
            let interpolationComplete = false;

            while (depth > 0 && (next = stream.next()) !== undefined) {
              if (next === "{") depth++;
              if (next === "}") {
                depth--;
                if (depth === 0) interpolationComplete = true;
              }
              // Break on newline to prevent runaway parsing
              if (next === "\n" && depth > 0) {
                state.errorRecovery = true;
                break;
              }
            }

            if (!interpolationComplete) {
              state.errorRecovery = true;
              return "error";
            }
          }

          escaped = !escaped && next === "\\";

          // Prevent runaway string parsing
          if (next === "\n") {
            // Single quotes don't typically span lines
            stream.backUp(1);
            state.errorRecovery = true;
            return "error";
          }
        }

        if (!foundEnd) {
          // Unterminated string
          state.errorRecovery = true;
          return "error";
        }

        return "string";
      }

      // Numbers
      if (/\d/.test(ch)) {
        stream.eatWhile(/\d/);
        if (stream.eat(".")) {
          stream.eatWhile(/\d/);
        }
        if (stream.eat(/[eE]/)) {
          stream.eat(/[+-]/);
          stream.eatWhile(/\d/);
        }
        return "number";
      }

      // Hex numbers
      if (ch === "0" && /[xX]/.test(stream.peek() || "")) {
        stream.next();
        stream.eatWhile(/[0-9a-fA-F]/);
        return "number";
      }

      // Multi-character operators - check longer operators first
      const next = stream.peek();
      if (ch === "." && next === ".") {
        // Check for triple dot first

        stream.next(); // consume second dot
        if (stream.peek() === ".") {
          stream.next(); // consume third dot
          return "operator";
        }
        // If not triple dot, it's a double dot - already consumed one dot
        return "operator";
      }

      if (
        (ch === "?" && next === "?") ||
        (ch === "=" && next === ">") || // Fat arrow =>
        (ch === "-" && next === ">") ||
        (ch === "=" && next === "=") ||
        (ch === "!" && next === "=") ||
        (ch === "<" && next === "=") ||
        (ch === ">" && next === "=") ||
        (ch === "/" && next === "/") // Double slash //
      ) {
        stream.next();
        return "operator";
      }

      // Single-character operators
      if ("+-*/<>!|&^%".indexOf(ch) !== -1) {
        return "operator";
      }

      // Punctuation with bracket tracking for error recovery
      if ("=,;.:".indexOf(ch) !== -1) {
        return "punctuation";
      }

      // Track bracket depth for error recovery
      if (ch === "{") {
        state.braceDepth = (state.braceDepth || 0) + 1;
        return "punctuation";
      }
      if (ch === "}") {
        state.braceDepth = Math.max(0, (state.braceDepth || 0) - 1);
        return "punctuation";
      }
      if (ch === "(") {
        state.parenDepth = (state.parenDepth || 0) + 1;
        return "punctuation";
      }
      if (ch === ")") {
        state.parenDepth = Math.max(0, (state.parenDepth || 0) - 1);
        return "punctuation";
      }
      if (ch === "[") {
        state.bracketDepth = (state.bracketDepth || 0) + 1;
        return "punctuation";
      }
      if (ch === "]") {
        state.bracketDepth = Math.max(0, (state.bracketDepth || 0) - 1);
        return "punctuation";
      }

      // Identifiers and keywords with better error recovery
      if (/[a-zA-Z_]/.test(ch)) {
        stream.eatWhile(/[\w]/);

        // Check for trailing underscore or bang suffix (but not both)
        const nextChar = stream.peek();
        if (nextChar === "!" || nextChar === "_") {
          // Only consume if it's a valid suffix pattern
          if (stream.current().length > 1 || nextChar === "_") {
            stream.next();
          }
        }

        const word = stream.current();

        // Validate identifier format - catch malformed identifiers
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*[!_]?$/.test(word)) {
          state.errorRecovery = true;
          return "error";
        }

        // Handle special case of lone underscore (wildcard pattern)
        if (word === "_") {
          return "keyword";
        }

        // For keyword matching, strip trailing _ or !
        const baseWord =
          word.endsWith("!") || word.endsWith("_") ? word.slice(0, -1) : word;

        // Keywords
        const keywords: string[] = [
          "if",
          "else",
          "match",
          "as",
          "import",
          "exposing",
          "module",
          "app",
          "platform",
          "package",
          "expect",
          "dbg",
          "crash",
          "var",
          "return",
          "for",
          "in",
          "where",
        ];

        if (keywords.includes(baseWord)) {
          state.lastToken = "keyword";
          return "keyword";
        }

        // Word-based operators
        if (baseWord === "and" || baseWord === "or") {
          return "operator";
        }

        // Built-in types
        const builtins: string[] = [
          "List",
          "Dict",
          "Set",
          "Str",
          "Num",
          "Bool",
          "Result",
          "Box",
          "U8",
          "U16",
          "U32",
          "U64",
          "U128",
          "Int",
          "I8",
          "I16",
          "I32",
          "I64",
          "I128",
          "F32",
          "F64",
          "Dec",
          "Frac",
        ];

        if (builtins.includes(baseWord)) {
          return "builtin";
        }

        // Type names (capitalized)
        if (/^[A-Z]/.test(baseWord)) {
          return "type";
        }

        state.lastToken = "variable";
        return "variable";
      }

      // If we get here, we have an unexpected character
      // Enter error recovery mode
      state.errorRecovery = true;
      return "error";
    },

    languageData: {
      commentTokens: { line: "#" },
      indentOnInput: /^\s*[\}\]\)]$/,
      closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
      wordChars: "_!",
    },

    tokenTable: {
      keyword: t.keyword,
      string: t.string,
      "string-interpolation": t.processingInstruction,
      number: t.number,
      comment: t.comment,
      operator: t.operator,
      punctuation: t.punctuation,
      type: t.typeName,
      builtin: t.className,
      variable: t.variableName,
      constant: t.literal,
      error: t.invalid,
    },
  });

  return new LanguageSupport(streamLang, [
    syntaxHighlighting(rocHighlightStyle),
  ]);
}
