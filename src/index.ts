import {
  createFullEditor,
  setDocumentContent,
  getDocumentContent,
  updateDiagnosticsInView,
  updateEditorTheme,
} from "./editor/cm6-setup";
import { EditorView } from "@codemirror/view";
import { createTypeHintTooltip } from "./editor/type-hints";
import { initializeWasm } from "./wasm/roc-wasm";
import { debugLog, initializeDebug } from "./utils/debug";
import "./styles/styles.css";

// Interfaces
import { examples } from "./examples";

interface Diagnostic {
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

interface WasmInterface {
  compile: (code: string) => Promise<any>;
  tokenize: () => Promise<any>;
  parse: () => Promise<any>;
  canonicalize: () => Promise<any>;
  getTypes: () => Promise<any>;
  getTypeInfo: (identifier: string, line: number, ch: number) => Promise<any>;
  isReady: () => boolean;
  getMemoryUsage: () => number;
  sendMessage: (message: any) => Promise<any>;
}

// Global state variables (keeping same structure as app.js)
let wasmInterface: WasmInterface | null = null;
let currentState: "INIT" | "READY" | "LOADED" = "INIT";
let currentView: "PROBLEMS" | "TOKENS" | "AST" | "CIR" | "TYPES" = "PROBLEMS";
let lastDiagnostics: Diagnostic[] = [];
let activeExample: number | null = null;
let lastCompileTime: number | null = null;

let codeMirrorEditor: any = null;

// Examples data (from app.js)

// Main playground class
class RocPlayground {
  private compileTimeout: ReturnType<typeof setTimeout> | null = null;
  private compileStartTime: number | null = null;
  private isResizing: boolean = false;
  private startX: number = 0;
  private startWidthLeft: number = 0;
  private startWidthRight: number = 0;
  private lastCompileResult: any = null;
  private updateUrlTimeout: ReturnType<typeof setTimeout> | null = null;
  private isUpdatingView: boolean = false;

  constructor() {
    this.compileTimeout = null;
    this.compileStartTime = null;
    this.isResizing = false;
    this.startX = 0;
    this.startWidthLeft = 0;
    this.startWidthRight = 0;
    this.lastCompileResult = null;
    this.isUpdatingView = false;
  }

  async initialize(): Promise<void> {
    try {
      debugLog("Initializing Roc Playground...");

      // Initialize debug utilities
      initializeDebug();

      // Initialize WASM first
      await this.initializeWasm();

      // Initialize theme before editor setup
      this.initTheme();

      // Setup editor
      this.setupEditor();

      // Setup UI components
      this.setupExamples();
      this.setupAutoCompile();
      this.setupUrlSharing();
      this.setupResizeHandle();

      // Restore from URL if present
      await this.restoreFromHash();

      currentState = "READY";
      debugLog("Playground initialized successfully");
      console.log(
        "💡 Tip: Use toggleVerboseLogging() in console to enable detailed debug logging",
      );
    } catch (error) {
      console.error("Failed to initialize playground:", error);
      const message = error instanceof Error ? error.message : String(error);
      this.showError(`Failed to initialize playground: ${message}`);
    }
  }

  async initializeWasm(): Promise<void> {
    try {
      debugLog("Loading WASM module...");
      const wasmResult = await initializeWasm();
      wasmInterface = wasmResult.interface;

      const outputContent = document.getElementById("outputContent");
      if (!outputContent) {
        throw new Error("Output content element not found");
      }

      if (wasmResult.compilerVersion) {
        outputContent.innerHTML = `Ready to compile! (Roc ${wasmResult.compilerVersion})`;
      } else {
        outputContent.innerHTML = "Ready to compile!";
      }
      outputContent.classList.add("status-text");

      debugLog("WASM module loaded successfully");
    } catch (error) {
      console.error("Failed to initialize WASM:", error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`WASM initialization failed: ${message}`);
    }
  }

  setupEditor(): void {
    const editorContainer = document.getElementById("editor");
    if (!editorContainer) {
      throw new Error("Editor container not found");
    }
    const themeAttr = document.documentElement.getAttribute("data-theme");
    const theme: "light" | "dark" = themeAttr === "dark" ? "dark" : "light";

    codeMirrorEditor = createFullEditor(editorContainer, {
      content: "# Select an example or write Roc code here...",
      theme: theme,
      onHover: createTypeHintTooltip(wasmInterface),
      onChange: (content: string) => {
        this.handleCodeChange(content);
      },
      diagnostics: lastDiagnostics,
    });

    debugLog("Editor setup complete");
  }

  handleCodeChange(content: string): void {
    // Auto-compile with debouncing and validation
    if (this.compileTimeout) {
      clearTimeout(this.compileTimeout);
    }

    this.compileTimeout = setTimeout(() => {
      this.compileCodeWithRecovery(content);
    }, 50);
  }

  /**
   * Compile code with better error recovery
   */
  async compileCodeWithRecovery(content: string): Promise<void> {
    try {
      await this.compileCode(content);
    } catch (error) {
      console.warn("Compilation failed, attempting recovery:", error);

      // Update UI to show compilation failed
      this.setStatus("❌ Compilation failed");
      this.showError(
        `Compilation error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async compileCode(code?: string, skipViewUpdate?: boolean): Promise<void> {
    if (!wasmInterface) {
      this.showError("WASM module not loaded");
      return;
    }

    try {
      this.compileStartTime = Date.now();
      this.setStatus("Compiling...");

      // Add compilation timeout protection
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Compilation timeout")), 10000);
      });

      const compilationPromise = wasmInterface.compile(
        code || getDocumentContent(codeMirrorEditor),
      );

      const result = await Promise.race([compilationPromise, timeoutPromise]);

      lastCompileTime = Date.now() - this.compileStartTime;

      if (result.status === "SUCCESS") {
        // Parse diagnostics from the result
        lastDiagnostics = this.parseDiagnostics(result);
        this.updateDiagnosticSummary();

        // Update editor with diagnostics
        if (codeMirrorEditor) {
          updateDiagnosticsInView(codeMirrorEditor, lastDiagnostics);
        }

        // Store the full result for other views
        this.lastCompileResult = result;
      } else {
        // Handle error response
        lastDiagnostics = [
          {
            severity: "error" as const,
            message: result.message || "Compilation failed",
            region: {
              start_line: 1,
              start_column: 1,
              end_line: 1,
              end_column: 1,
            },
          },
        ];
        this.updateDiagnosticSummary();

        // Update editor with error diagnostic
        if (codeMirrorEditor) {
          updateDiagnosticsInView(codeMirrorEditor, lastDiagnostics);
        }

        this.lastCompileResult = null;
      }

      // Show current view (unless we're already updating a view to prevent recursion)
      if (!skipViewUpdate && !this.isUpdatingView) {
        this.showCurrentView();
      }

      // Update URL with compressed content
      this.updateUrlWithCompressedContent();
    } catch (error) {
      console.error("Compilation error:", error);
      const message = error instanceof Error ? error.message : String(error);
      this.showError(`Compilation failed: ${message}`);
    }
  }

  setupExamples(): void {
    const examplesList = document.getElementById("examplesList");

    examples.forEach((example, index) => {
      const exampleItem = document.createElement("div");
      exampleItem.className = "example-item";
      exampleItem.innerHTML = `
        <div class="example-title">${example.name}</div>
        <div class="example-description">${example.description}</div>
      `;

      exampleItem.addEventListener("click", () => {
        this.loadExample(index);
      });

      examplesList?.appendChild(exampleItem);
    });
  }

  async loadExample(index: number): Promise<void> {
    const example = examples[index];
    if (!example) return;

    // Update active example
    if (activeExample !== null) {
      const exampleItems = document.querySelectorAll(".example-item");
      exampleItems[activeExample]?.classList.remove("active");
    }

    activeExample = index;
    const exampleItems = document.querySelectorAll(".example-item");
    // exampleItems[index]?.classList.add("active");

    // Set editor content
    setDocumentContent(codeMirrorEditor, example.code);

    // Compile the new code
    await this.compileCode(example.code);
  }

  setupAutoCompile(): void {
    // Auto-compile is handled in handleCodeChange
  }

  showCurrentView(): void {
    switch (currentView) {
      case "PROBLEMS":
        this.showDiagnostics();
        break;
      case "TOKENS":
        this.showTokens();
        break;
      case "AST":
        this.showParseAst();
        break;
      case "CIR":
        this.showCanCir();
        break;
      case "TYPES":
        this.showTypes();
        break;
    }
  }

  async showDiagnostics(): Promise<void> {
    currentView = "PROBLEMS";
    this.updateStageButtons();

    const outputContent = document.getElementById("outputContent");

    if (lastDiagnostics.length === 0) {
      if (outputContent) {
        outputContent.innerHTML = `<div class="success-message">No problems found!</div>`;
      }
      return;
    }

    // Use pre-formatted HTML from WASM if available
    if (this.lastCompileResult?.diagnostics?.html) {
      if (outputContent) {
        outputContent.innerHTML = this.lastCompileResult.diagnostics.html;
      }
      return;
    }

    // Fallback to simple diagnostic display
    let html = "";
    lastDiagnostics.forEach((diagnostic) => {
      const severity = diagnostic.severity || "error";
      html += `
        <div class="diagnostic ${severity}">
          <div class="diagnostic-header">
            <span class="diagnostic-severity">${severity.toUpperCase()}</span>
            <span class="diagnostic-location">Line ${diagnostic.region.start_line}:${diagnostic.region.start_column}</span>
          </div>
          <div class="diagnostic-message">${this.escapeHtml(diagnostic.message || "")}</div>
          ${diagnostic.code ? `<div class="diagnostic-code">${this.escapeHtml(diagnostic.code)}</div>` : ""}
        </div>
      `;
    });

    if (outputContent) {
      outputContent.innerHTML = html;
    }
  }

  async showTokens(): Promise<void> {
    currentView = "TOKENS";
    this.updateStageButtons();

    if (!wasmInterface) {
      this.showError("WASM module not loaded");
      return;
    }

    try {
      this.isUpdatingView = true;

      // Ensure source is compiled/loaded before tokenizing
      const currentCode = getDocumentContent(codeMirrorEditor);
      await this.compileCode(currentCode, true);

      const result = await wasmInterface.tokenize();

      const outputContent = document.getElementById("outputContent");
      if (result.status === "SUCCESS") {
        if (outputContent) {
          outputContent.innerHTML = result.data || "No tokens";
        }
      } else {
        if (outputContent) {
          outputContent.innerHTML = `<div class="error-message">${this.escapeHtml(result.message || "Failed to get tokens")}</div>`;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showError(`Failed to get tokens: ${message}`);
    } finally {
      this.isUpdatingView = false;
    }

    // Setup source range interactions after content is loaded
    this.setupSourceRangeInteractions();
  }

  async showParseAst(): Promise<void> {
    currentView = "AST";
    this.updateStageButtons();

    if (!wasmInterface) {
      this.showError("WASM module not loaded");
      return;
    }

    try {
      this.isUpdatingView = true;

      // Ensure source is compiled/loaded before parsing
      const currentCode = getDocumentContent(codeMirrorEditor);
      await this.compileCode(currentCode, true);

      const result = await wasmInterface.parse();

      const outputContent = document.getElementById("outputContent");
      if (result.status === "SUCCESS") {
        if (outputContent) {
          outputContent.innerHTML = `<div class="sexp-output">${result.data || "No AST"}</div>`;
        }
      } else {
        if (outputContent) {
          outputContent.innerHTML = `<div class="error-message">${this.escapeHtml(result.message || "Failed to get AST")}</div>`;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showError(`Failed to get AST: ${message}`);
    } finally {
      this.isUpdatingView = false;
    }

    // Setup source range interactions after content is loaded
    this.setupSourceRangeInteractions();
  }

  async showCanCir(): Promise<void> {
    currentView = "CIR";
    this.updateStageButtons();

    if (!wasmInterface) {
      this.showError("WASM module not loaded");
      return;
    }

    try {
      this.isUpdatingView = true;

      // Ensure source is compiled/loaded before getting canonical IR
      const currentCode = getDocumentContent(codeMirrorEditor);
      await this.compileCode(currentCode, true);

      const result = await wasmInterface.canonicalize();

      const outputContent = document.getElementById("outputContent");
      if (result.status === "SUCCESS") {
        if (outputContent) {
          outputContent.innerHTML = `<div class="sexp-output">${result.data || "No CIR"}</div>`;
        }
      } else {
        if (outputContent) {
          outputContent.innerHTML = `<div class="error-message">${this.escapeHtml(result.message || "Failed to get CIR")}</div>`;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showError(`Failed to get canonical IR: ${message}`);
    } finally {
      this.isUpdatingView = false;
    }

    // Setup source range interactions after content is loaded
    this.setupSourceRangeInteractions();
  }

  async showTypes(): Promise<void> {
    currentView = "TYPES";
    this.updateStageButtons();

    if (!wasmInterface) {
      this.showError("WASM module not loaded");
      return;
    }

    try {
      this.isUpdatingView = true;

      // Ensure source is compiled/loaded before getting types
      const currentCode = getDocumentContent(codeMirrorEditor);
      await this.compileCode(currentCode, true);

      const result = await wasmInterface.getTypes();

      const outputContent = document.getElementById("outputContent");
      if (result.status === "SUCCESS") {
        if (outputContent) {
          outputContent.innerHTML = `<div class="sexp-output">${result.data || "No types"}</div>`;
        }
      } else {
        if (outputContent) {
          outputContent.innerHTML = `<div class="error-message">${this.escapeHtml(result.message || "Failed to get types")}</div>`;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showError(`Failed to get types: ${message}`);
    } finally {
      this.isUpdatingView = false;
    }

    // Setup source range interactions after content is loaded
    this.setupSourceRangeInteractions();
  }

  updateStageButtons(): void {
    const buttons = document.querySelectorAll(".stage-button");
    buttons.forEach((button) => {
      button.classList.remove("active");
    });

    const activeButton = document.getElementById(this.getButtonId(currentView));
    if (activeButton) {
      activeButton.classList.add("active");
    }
  }

  getButtonId(view: string): string {
    const mapping: Record<string, string> = {
      PROBLEMS: "diagnosticsBtn",
      TOKENS: "tokensBtn",
      AST: "parseBtn",
      CIR: "canBtn",
      TYPES: "typesBtn",
    };
    return mapping[view] || "diagnosticsBtn";
  }

  updateDiagnosticSummary(): void {
    const editorHeader = document.querySelector(".editor-header");

    // Remove existing summary
    const existingSummary = editorHeader?.querySelector(".diagnostic-summary");
    if (existingSummary) {
      existingSummary.remove();
    }

    // Always show summary after compilation (when timing info is available)
    if (lastCompileTime !== null) {
      const summaryDiv = document.createElement("div");
      summaryDiv.className = "diagnostic-summary";

      let totalErrors = 0;
      let totalWarnings = 0;

      // Use summary from WASM result if available
      if (
        this.lastCompileResult &&
        this.lastCompileResult.diagnostics &&
        this.lastCompileResult.diagnostics.summary
      ) {
        const diagnosticSummary = this.lastCompileResult.diagnostics.summary;
        totalErrors = diagnosticSummary.errors;
        totalWarnings = diagnosticSummary.warnings;
      } else {
        // Fallback to counting diagnostics
        totalErrors = lastDiagnostics.filter(
          (d) => d.severity === "error",
        ).length;
        totalWarnings = lastDiagnostics.filter(
          (d) => d.severity === "warning",
        ).length;
      }

      let summaryText = "";
      // Always show error/warning count after compilation
      summaryText += `Found ${totalErrors} error(s) and ${totalWarnings} warning(s)`;

      if (lastCompileTime !== null) {
        let timeText;
        if (lastCompileTime < 1000) {
          timeText = `${Math.round(lastCompileTime)}ms`;
        } else {
          timeText = `${(lastCompileTime / 1000).toFixed(1)}s`;
        }
        summaryText += (summaryText ? " " : "") + `⚡ ${timeText}`;
      }

      summaryDiv.innerHTML = summaryText;
      editorHeader?.appendChild(summaryDiv);
    }
  }

  setupResizeHandle(): void {
    const resizeHandle = document.getElementById("resizeHandle");
    const editorContainer = document.querySelector(
      ".editor-container",
    ) as HTMLElement;
    const outputContainer = document.querySelector(
      ".output-container",
    ) as HTMLElement;

    resizeHandle?.addEventListener("mousedown", (e: MouseEvent) => {
      this.isResizing = true;
      this.startX = e.clientX;
      this.startWidthLeft = editorContainer?.offsetWidth || 0;
      this.startWidthRight = outputContainer?.offsetWidth || 0;
      document.addEventListener("mousemove", (e: MouseEvent) =>
        this.handleMouseMove(e),
      );
      document.addEventListener("mouseup", () => this.handleMouseUp());
    });
  }

  handleMouseMove(e: MouseEvent): void {
    if (!this.isResizing) return;

    const deltaX = e.clientX - this.startX;
    const newLeftWidth = this.startWidthLeft + deltaX;
    const newRightWidth = this.startWidthRight - deltaX;

    if (newLeftWidth > 200 && newRightWidth > 200) {
      const editorContainer = document.querySelector(
        ".editor-container",
      ) as HTMLElement;
      const outputContainer = document.querySelector(
        ".output-container",
      ) as HTMLElement;
      if (editorContainer) {
        editorContainer.style.flex = `0 0 ${newLeftWidth}px`;
      }
      if (outputContainer) {
        outputContainer.style.flex = `0 0 ${newRightWidth}px`;
      }
    }
  }

  handleMouseUp(): void {
    this.isResizing = false;
    document.removeEventListener("mousemove", (e: MouseEvent) =>
      this.handleMouseMove(e),
    );
    document.removeEventListener("mouseup", () => this.handleMouseUp());
  }

  setupUrlSharing(): void {
    // URL sharing functionality
    window.addEventListener("hashchange", () => {
      this.restoreFromHash();
    });

    this.addShareButton();
  }

  async updateUrlWithCompressedContent(): Promise<void> {
    if (this.updateUrlTimeout) {
      clearTimeout(this.updateUrlTimeout);
    }

    this.updateUrlTimeout = setTimeout(async () => {
      try {
        const code = getDocumentContent(codeMirrorEditor);

        if (!code || code.length > 10000) {
          // Don't share very large content
          window.history.replaceState(null, "", "");
          return;
        }

        const compressed = await this.compressAndEncode(code);
        window.history.replaceState(null, "", `#content=${compressed}`);
      } catch (error) {
        console.error("Failed to update URL:", error);
      }
    }, 1000);
  }

  async restoreFromHash(): Promise<void> {
    const hash = window.location.hash.slice(1);
    if (hash) {
      try {
        let b64 = hash;

        // Handle old format: #content=base64data
        if (hash.startsWith("content=")) {
          b64 = hash.slice("content=".length);
        }

        // Handle new format: #base64data (no prefix)
        const code = await this.decodeAndDecompress(b64);
        setDocumentContent(codeMirrorEditor, code);

        // Wait for the playground to be ready before compiling
        if (currentState === "READY") {
          await this.compileCode(code);
        } else {
          debugLog("Playground not ready, skipping auto-compile");
        }
      } catch (error) {
        console.error("Failed to restore from hash:", error);
      }
    }
  }

  async compressAndEncode(text: string): Promise<string> {
    // Use simple base64 encoding for better browser support
    // TODO: Add compression later with a polyfill
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    return this.uint8ToBase64(data);
  }

  async decodeAndDecompress(base64: string): Promise<string> {
    // Use simple base64 decoding for better browser support
    // TODO: Add decompression later with a polyfill
    const data = this.base64ToUint8(base64);
    return new TextDecoder().decode(data);
  }

  uint8ToBase64(uint8Array: Uint8Array): string {
    return btoa(String.fromCharCode(...uint8Array));
  }

  base64ToUint8(base64: string): Uint8Array {
    return new Uint8Array(
      atob(base64)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
  }

  initTheme(): void {
    const themeSwitch = document.getElementById("themeSwitch");
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;

    // Set initial theme
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme) {
      document.documentElement.setAttribute("data-theme", savedTheme);
    } else if (prefersDark) {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.setAttribute("data-theme", "light");
    }

    this.updateThemeLabel();

    // Theme switch event
    themeSwitch?.addEventListener("click", () => {
      this.toggleTheme();
    });

    // System theme change
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        if (!localStorage.getItem("theme")) {
          const newTheme = e.matches ? "dark" : "light";
          document.documentElement.setAttribute("data-theme", newTheme);
          this.updateThemeLabel();

          // Update editor theme
          if (codeMirrorEditor) {
            updateEditorTheme(codeMirrorEditor, newTheme);
          }
        }
      });
  }

  toggleTheme(): void {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    const newTheme = currentTheme === "dark" ? "light" : "dark";

    document.documentElement.setAttribute("data-theme", newTheme);
    localStorage.setItem("theme", newTheme);
    this.updateThemeLabel();

    // Update editor theme
    if (codeMirrorEditor) {
      updateEditorTheme(codeMirrorEditor, newTheme);
    }
  }

  updateThemeLabel(): void {
    const themeLabel = document.querySelector(".theme-label");
    const currentTheme = document.documentElement.getAttribute("data-theme");
    if (themeLabel) {
      themeLabel.textContent = currentTheme === "dark" ? "Dark" : "Light";
    }
  }

  setStatus(message: string): void {
    const outputContent = document.getElementById("outputContent");
    if (outputContent) {
      outputContent.innerHTML = `<div class="status-text">${message}</div>`;
    }
  }

  showError(message: string): void {
    const outputContent = document.getElementById("outputContent");
    if (outputContent) {
      outputContent.innerHTML = `<div class="error-message">${this.escapeHtml(message)}</div>`;
    }
  }

  escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  parseDiagnostics(result: any): Diagnostic[] {
    debugLog("Raw result for diagnostic parsing:", result);
    const diagnostics: Diagnostic[] = [];

    // Handle new structured diagnostic format
    if (
      result.diagnostics &&
      result.diagnostics.list &&
      Array.isArray(result.diagnostics.list)
    ) {
      debugLog("Found structured diagnostics list:", result.diagnostics.list);
      for (const diag of result.diagnostics.list) {
        // Validate that the diagnostic has the expected region structure
        if (
          diag.region &&
          typeof diag.region.start_line === "number" &&
          typeof diag.region.start_column === "number" &&
          typeof diag.region.end_line === "number" &&
          typeof diag.region.end_column === "number"
        ) {
          const parsedDiag: Diagnostic = {
            severity: diag.severity as "error" | "warning" | "info",
            message: diag.message,
            region: {
              start_line: diag.region.start_line,
              start_column: diag.region.start_column,
              end_line: diag.region.end_line,
              end_column: diag.region.end_column,
            },
          };
          debugLog("Parsed diagnostic:", parsedDiag);
          diagnostics.push(parsedDiag);
        } else {
          console.warn("Skipping diagnostic without valid region:", diag);
        }
      }
    } else {
      debugLog("No structured diagnostics found in result");
    }

    // Debug: Show stage report distribution
    if (result.diagnostics && result.diagnostics.debug_counts) {
      debugLog("Stage report distribution:", result.diagnostics.debug_counts);
      const counts = result.diagnostics.debug_counts;
      debugLog("Detailed breakdown:");
      debugLog("  Tokenize:", counts.tokenize);
      debugLog("  Parse:", counts.parse);
      debugLog("  Canonicalize:", counts.can);
      debugLog("  Type:", counts.type);
    }

    // Summary is now only used for the "Found X errors, Y warnings" display
    // Individual diagnostics come from the structured list above

    debugLog("Total diagnostics parsed:", diagnostics.length);
    return diagnostics;
  }

  setupSourceRangeInteractions(): void {
    const outputContent = document.getElementById("outputContent");
    if (!outputContent) return;

    // Remove existing event listeners to prevent duplicates
    outputContent.removeEventListener(
      "mouseenter",
      this.handleSourceRangeHover,
      true,
    );
    outputContent.removeEventListener(
      "mouseleave",
      this.handleSourceRangeLeave,
      true,
    );
    outputContent.removeEventListener(
      "click",
      this.handleSourceRangeClick,
      true,
    );

    // Add event listeners for source range interactions
    outputContent.addEventListener(
      "mouseenter",
      this.handleSourceRangeHover.bind(this),
      true,
    );
    outputContent.addEventListener(
      "mouseleave",
      this.handleSourceRangeLeave.bind(this),
      true,
    );
    outputContent.addEventListener(
      "click",
      this.handleSourceRangeClick.bind(this),
      true,
    );
  }

  handleSourceRangeHover(event: Event): void {
    const target = event.target as HTMLElement;
    debugLog("Hover event on element:", target, "classList:", target.classList);

    if (!target.classList.contains("source-range")) {
      debugLog("Not a source-range element, ignoring");
      return;
    }

    const startByte = parseInt(target.dataset.startByte || "0", 10);
    const endByte = parseInt(target.dataset.endByte || "0", 10);
    debugLog("Source range hover:", { startByte, endByte });

    if (!codeMirrorEditor || isNaN(startByte) || isNaN(endByte)) {
      debugLog("Invalid state or bytes:", {
        codeMirrorEditor: !!codeMirrorEditor,
        startByte,
        endByte,
      });
      return;
    }

    // Highlight the range in the editor
    this.highlightSourceRange(startByte, endByte);

    // Add highlighted class to the source range element
    target.classList.add("highlighted");
  }

  handleSourceRangeLeave(event: Event): void {
    const target = event.target as HTMLElement;
    debugLog("Leave event on element:", target);

    if (!target.classList.contains("source-range")) {
      debugLog("Not a source-range element, ignoring leave");
      return;
    }

    debugLog("Source range leave");

    // Clear highlighting in the editor
    this.clearSourceRangeHighlight();

    // Remove highlighted class from the source range element
    target.classList.remove("highlighted");
  }

  handleSourceRangeClick(event: Event): void {
    const target = event.target as HTMLElement;
    debugLog("Click event on element:", target);

    if (!target.classList.contains("source-range")) {
      debugLog("Not a source-range element, ignoring click");
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startByte = parseInt(target.dataset.startByte || "0", 10);
    debugLog("Source range click, navigating to:", startByte);

    if (!codeMirrorEditor || isNaN(startByte)) {
      debugLog("Invalid state or startByte:", {
        codeMirrorEditor: !!codeMirrorEditor,
        startByte,
      });
      return;
    }

    // Navigate to the start of the range
    this.navigateToSourcePosition(startByte);
  }

  private sourceRangeHighlight: { from: number; to: number } | null = null;

  highlightSourceRange(startByte: number, endByte: number): void {
    if (!codeMirrorEditor) return;

    try {
      // Clear existing highlights
      this.clearSourceRangeHighlight();

      const doc = codeMirrorEditor.state.doc;
      const from = Math.min(startByte, doc.length);
      const to = Math.min(endByte, doc.length);

      if (from >= to) return;

      this.sourceRangeHighlight = { from, to };

      // Create a temporary selection to highlight the range
      codeMirrorEditor.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: "nearest" }),
      });

      // Add a CSS class to the editor to show we're in highlighting mode
      const editorElement = codeMirrorEditor.dom;
      editorElement.classList.add("cm-source-range-active");

      debugLog(`Highlighting range ${from}-${to} in editor`);
    } catch (error) {
      console.warn("Failed to highlight source range:", error);
    }
  }

  clearSourceRangeHighlight(): void {
    if (!codeMirrorEditor) return;

    try {
      // Remove the highlighting class
      const editorElement = codeMirrorEditor.dom;
      editorElement.classList.remove("cm-source-range-active");

      // Restore the original cursor position (move to start of highlighted range)
      if (this.sourceRangeHighlight) {
        const doc = codeMirrorEditor.state.doc;
        const pos = Math.min(this.sourceRangeHighlight.from, doc.length);
        codeMirrorEditor.dispatch({
          selection: { anchor: pos, head: pos },
        });
      }

      this.sourceRangeHighlight = null;
      debugLog("Cleared source range highlight");
    } catch (error) {
      console.warn("Failed to clear source range highlight:", error);
    }
  }

  navigateToSourcePosition(byteOffset: number): void {
    if (!codeMirrorEditor) return;

    try {
      const doc = codeMirrorEditor.state.doc;
      const pos = Math.min(byteOffset, doc.length);

      // Set cursor position and scroll into view
      codeMirrorEditor.dispatch({
        selection: { anchor: pos, head: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });

      // Focus the editor
      codeMirrorEditor.focus();
    } catch (error) {
      console.warn("Failed to navigate to source position:", error);
    }
  }

  addShareButton(): void {
    const headerStatus = document.querySelector(".header-status");
    if (headerStatus) {
      let shareButton = headerStatus.querySelector(
        ".share-button",
      ) as HTMLButtonElement;
      if (!shareButton) {
        shareButton = document.createElement("button");
        shareButton.className = "share-button";
        shareButton.innerHTML = "share link";
        shareButton.title = "Copy shareable link to clipboard";
        shareButton.onclick = () => this.copyShareLink();
        const themeToggle = headerStatus.querySelector(".theme-toggle");
        headerStatus.insertBefore(shareButton, themeToggle);
      }
    }
  }

  async copyShareLink(): Promise<void> {
    if (codeMirrorEditor) {
      const content = getDocumentContent(codeMirrorEditor).trim();
      if (content) {
        try {
          const b64 = await this.compressAndEncode(content);
          const shareUrl = `${window.location.origin}${window.location.pathname}#content=${b64}`;
          await navigator.clipboard.writeText(shareUrl);

          // Show temporary feedback
          const shareButton = document.querySelector(
            ".share-button",
          ) as HTMLButtonElement;
          const originalText = shareButton.innerHTML;
          shareButton.innerHTML = "copied!";
          shareButton.style.background = "var(--color-success)";

          setTimeout(() => {
            shareButton.innerHTML = originalText;
            shareButton.style.background = "";
          }, 2000);
        } catch (error) {
          console.error("Failed to copy share link:", error);
          alert("Failed to copy link to clipboard");
        }
      } else {
        alert("No content to share");
      }
    }
  }
}

// Global functions for button clicks (maintaining compatibility)
declare global {
  interface Window {
    showDiagnostics: () => void;
    showTokens: () => void;
    showParseAst: () => void;
    showCanCir: () => void;
    showTypes: () => void;
  }
}

// Initialize playground when DOM is ready
let playground: RocPlayground;

document.addEventListener("DOMContentLoaded", () => {
  playground = new RocPlayground();
  playground.initialize();

  // Set up global functions
  window.showDiagnostics = () => playground.showDiagnostics();
  window.showTokens = () => playground.showTokens();
  window.showParseAst = () => playground.showParseAst();
  window.showCanCir = () => playground.showCanCir();
  window.showTypes = () => playground.showTypes();
});
