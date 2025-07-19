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
      return {};
    },

    token(stream: StringStream, _state: StreamState): string | null {
      // Skip whitespace
      if (stream.eatSpace()) return null;

      const ch = stream.next();
      if (!ch) return null;

      // Comments
      if (ch === "#") {
        stream.skipToEnd();
        return "comment";
      }

      // Strings
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let escaped = false;
        let next: string | void;

        while ((next = stream.next()) !== undefined) {
          if (next === quote && !escaped) {
            return "string";
          }

          // String interpolation
          if (next === "$" && stream.peek() === "{" && !escaped) {
            stream.next(); // consume {
            let depth = 1;
            while (depth > 0 && (next = stream.next()) !== undefined) {
              if (next === "{") depth++;
              if (next === "}") depth--;
            }
            return "string-interpolation";
          }

          escaped = !escaped && next === "\\";
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

      // Punctuation
      if ("=,;.:[]{}()".indexOf(ch) !== -1) {
        return "punctuation";
      }

      // Identifiers and keywords
      if (/[a-zA-Z_]/.test(ch)) {
        stream.eatWhile(/[\w]/);

        // Check for trailing underscore or bang suffix (but not both)
        const nextChar = stream.peek();
        if (nextChar === "!" || nextChar === "_") {
          stream.next();
        }

        const word = stream.current();

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
        ];

        if (keywords.includes(baseWord)) {
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

        return "variable";
      }

      return null;
    },

    languageData: {
      commentTokens: { line: "#" },
      indentOnInput: /^\s*[\}\]\)]$/,
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
