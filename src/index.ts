import {
  createFullEditor,
  setDocumentContent,
  getDocumentContent,
  updateDiagnosticsInView,
  updateEditorTheme,
} from "./editor/cm6-setup";
import { EditorView } from "@codemirror/view";
import { createTypeHintTooltip } from "./editor/type-hints";
import { initializeWasm, WasmInterface } from "./wasm/roc-wasm";
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


// Global state variables (keeping same structure as app.js)
let wasmInterface: WasmInterface | null = null;
let currentState: "INIT" | "READY" | "LOADED" | "REPL_ACTIVE" = "INIT";
let currentView: "PROBLEMS" | "TOKENS" | "AST" | "CIR" | "TYPES" = "PROBLEMS";
let currentMode: "EDITOR" | "REPL" = "EDITOR";
let lastDiagnostics: Diagnostic[] = [];
let activeExample: number | null = null;
let lastCompileTime: number | null = null;

let codeMirrorEditor: any = null;

// REPL state variables
let replHistory: Array<{input: string; output: string; type: "definition" | "expression" | "error"}> = [];
let replInputHistory: string[] = [];
let replInputHistoryIndex: number = 0;
let replInputStash: string = "";
let replTutorialStep: number = 0;

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
  private boundHandleMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundHandleMouseUp: (() => void) | null = null;

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
      this.setupModeToggle();

      // Restore from URL if present
      await this.restoreFromHash();

      currentState = "READY";
      
      // Check if REPL container is visible and initialize if needed
      const replContainer = document.getElementById("replContainer");
      debugLog(`REPL container found: ${!!replContainer}, display: ${replContainer?.style.display}`);
      if (replContainer && replContainer.style.display === "flex") {
        debugLog("REPL container is visible, switching to REPL mode");
        currentMode = "REPL";
        this.updateModeButtons();
        await this.initializeRepl();
      } else {
        debugLog("REPL container not visible, staying in editor mode");
      }
      
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

    // Load Basic Types example as default content
    const basicTypesExample = examples.find(ex => ex.name === "Basic Types");
    const initialContent = basicTypesExample ? basicTypesExample.code : "# Select an example or write Roc code here...";

    codeMirrorEditor = createFullEditor(editorContainer, {
      content: initialContent,
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
      this.compileStartTime = performance.now();
      this.setStatus("Compiling...");

      // Add compilation timeout protection
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Compilation timeout")), 10000);
      });

      const compilationPromise = wasmInterface.compile(
        code || getDocumentContent(codeMirrorEditor),
      );

      const result = await Promise.race([compilationPromise, timeoutPromise]);

      lastCompileTime = performance.now() - this.compileStartTime;

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

    // Set editor content
    setDocumentContent(codeMirrorEditor, example.code);

    // Compile the new code
    await this.compileCode(example.code);
  }

  setupAutoCompile(): void {
    // Auto-compile is handled in handleCodeChange
  }

  setupModeToggle(): void {
    const editorModeBtn = document.getElementById("editorModeBtn");
    const replModeBtn = document.getElementById("replModeBtn");
    
    editorModeBtn?.addEventListener("click", () => {
      this.switchToEditorMode();
    });
    
    replModeBtn?.addEventListener("click", () => {
      this.switchToReplMode();
    });
  }

  async switchToEditorMode(): Promise<void> {
    if (currentMode === "EDITOR") return;
    
    currentMode = "EDITOR";
    this.updateModeButtons();
    
    // Hide REPL container and show editor container
    const editorContainer = document.getElementById("editorContainer");
    const replContainer = document.getElementById("replContainer");
    
    if (editorContainer) editorContainer.style.display = "flex";
    if (replContainer) replContainer.style.display = "none";
    
    // Reset WASM to editor mode
    if (wasmInterface) {
      await wasmInterface.reset();
      currentState = "READY";
    }
  }

  async switchToReplMode(): Promise<void> {
    if (currentMode === "REPL") return;
    
    debugLog("Switching to REPL mode...");
    currentMode = "REPL";
    this.updateModeButtons();
    
    // Hide editor container and show REPL container
    const editorContainer = document.getElementById("editorContainer");
    const replContainer = document.getElementById("replContainer");
    
    debugLog("Editor container:", editorContainer);
    debugLog("REPL container:", replContainer);
    
    if (editorContainer) {
      editorContainer.style.display = "none";
      debugLog("Editor container hidden");
    }
    if (replContainer) {
      replContainer.style.display = "flex";
      debugLog("REPL container shown");
    }
    
    // Initialize REPL
    debugLog("About to initialize REPL...");
    await this.initializeRepl();
    debugLog("REPL initialization completed");
  }

  updateModeButtons(): void {
    const editorModeBtn = document.getElementById("editorModeBtn");
    const replModeBtn = document.getElementById("replModeBtn");
    
    if (currentMode === "EDITOR") {
      editorModeBtn?.classList.add("active");
      replModeBtn?.classList.remove("active");
    } else {
      editorModeBtn?.classList.remove("active");
      replModeBtn?.classList.add("active");
    }
  }

  async initializeRepl(): Promise<void> {
    debugLog("initializeRepl called");
    if (!wasmInterface) {
      debugLog("WASM interface not available");
      return;
    }
    
    try {
      // First, ensure we're in a clean state by calling RESET
      debugLog("Resetting WASM state before REPL initialization...");
      const resetResponse = await wasmInterface.reset();
      debugLog("RESET response:", resetResponse);
      
      // Now initialize the REPL
      debugLog("Calling wasmInterface.initRepl()...");
      const response = await wasmInterface.initRepl();
      debugLog("WASM initRepl response:", response);
      
      if (response.status === "SUCCESS") {
        debugLog("REPL initialization successful, setting up interface");
        currentState = "REPL_ACTIVE";
        this.setupReplInterface();
        debugLog("Setup complete");
      } else {
        debugLog("REPL initialization failed:", response.message);
        this.showError(`Failed to initialize REPL: ${response.message}`);
      }
    } catch (error) {
      console.error("Error initializing REPL:", error);
      debugLog("REPL initialization threw error:", error);
      this.showError(`REPL initialization failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }


  setupReplInterface(): void {
    const sourceInput = document.getElementById("source-input") as HTMLTextAreaElement;
    
    if (!sourceInput) {
      debugLog("REPL source input element not found");
      return;
    }
    
    debugLog("Setting up REPL interface...");
    
    // Clear the input value
    sourceInput.value = "";
    
    // Input event listener removed (was causing auto-resize issue)
    
    // Setup keydown handler
    sourceInput.addEventListener("keydown", (event) => {
      this.handleReplInputKeydown(event);
    });
    
    // Setup keyup handler for history navigation
    sourceInput.addEventListener("keyup", (event) => {
      this.handleReplInputKeyup(event);
    });
    
    // Focus the input
    sourceInput.focus();
    
    debugLog("REPL interface set up successfully");
  }

  resetSourceInputHeight(): void {
    // Function disabled - was causing undesired auto-resize behavior
    // Keeping function stub to avoid breaking other code that might call it
  }

  handleReplInputKeydown(event: KeyboardEvent): void {
    const ENTER = 13;
    const { keyCode } = event;
    
    if (keyCode === ENTER) {
      // Only submit on Enter without modifier keys (exactly like old implementation)
      if (!event.shiftKey && !event.ctrlKey && !event.altKey) {
        debugLog("Processing REPL enter key - submitting input");
        
        // Don't advance the caret to the next line
        event.preventDefault();
        
        const sourceInput = event.target as HTMLTextAreaElement;
        const inputText = sourceInput.value.trim();
        
        debugLog(`REPL input text: "${inputText}"`);
        
        // Clear the input and reset height (like old implementation)
        sourceInput.value = "";
        sourceInput.style.height = "";
        
        if (inputText) {
          this.processReplInput(inputText);
        }
      }
    }
  }

  handleReplInputKeyup(event: KeyboardEvent): void {
    const UP = 38;
    const DOWN = 40;
    const { keyCode } = event;
    
    const sourceInput = event.target as HTMLTextAreaElement;
    
    switch (keyCode) {
      case UP:
        event.preventDefault(); // Prevent cursor jumping
        if (replInputHistory.length === 0) {
          return;
        }
        if (replInputHistoryIndex === replInputHistory.length) {
          replInputStash = sourceInput.value;
        }
        
        if (replInputHistoryIndex > 0) {
          replInputHistoryIndex--;
          const upValue = replInputHistory[replInputHistoryIndex];
          if (upValue !== undefined) {
            this.setReplInput(upValue);
          }
        }
        break;
        
      case DOWN:
        event.preventDefault(); // Prevent cursor jumping
        if (replInputHistory.length === 0) {
          return;
        }
        if (replInputHistoryIndex < replInputHistory.length - 1) {
          replInputHistoryIndex++;
          const downValue = replInputHistory[replInputHistoryIndex];
          if (downValue !== undefined) {
            this.setReplInput(downValue);
          }
        } else if (replInputHistoryIndex === replInputHistory.length - 1) {
          replInputHistoryIndex = replInputHistory.length;
          this.setReplInput(replInputStash);
        }
        break;
        
      default:
        break;
    }
  }

  setReplInput(value: string): void {
    const sourceInput = document.getElementById("source-input") as HTMLTextAreaElement;
    if (sourceInput) {
      sourceInput.value = value;
      sourceInput.selectionStart = value.length;
      sourceInput.selectionEnd = value.length;
      // Removed auto-resize call
    }
  }


  async processReplInput(input: string): Promise<void> {
    if (!wasmInterface) {
      debugLog("REPL input processing failed: WASM interface not available");
      return;
    }
    
    debugLog(`Processing REPL input: "${input}"`);
    
    // Hide intro text on first input
    const introText = document.getElementById("repl-intro-text");
    if (introText) {
      introText.style.display = "none";
    }
    
    // Add to input history
    replInputHistory.push(input);
    replInputHistoryIndex = replInputHistory.length - 1;
    replInputStash = "";
    
    // Add input to history display
    this.addReplHistoryEntry(input, "input");
    
    try {
      debugLog("Sending REPL_STEP message to WASM...");
      const response = await wasmInterface.replStep(input);
      debugLog("REPL_STEP response:", response);
      
      if (response.status === "SUCCESS" && response.result) {
        const result = response.result;
        debugLog(`REPL result: type=${result.type}, output="${result.output}"`);
        
        // Pass error stage and details for enhanced error display
        this.addReplHistoryEntry(
          result.output, 
          result.type, 
          result.error_stage, 
          result.error_details
        );
        
        // Add to internal history
        replHistory.push({
          input: input,
          output: result.output,
          type: result.type
        });
        
        // Check for tutorial progression
        this.checkReplTutorialStep(input);
        
      } else if (response.status === "INVALID_STATE") {
        debugLog("REPL not properly initialized, attempting to reinitialize...");
        this.addReplHistoryEntry("REPL not initialized. Reinitializing...", "error");
        // Try to reinitialize and then retry the input
        await this.initializeRepl();
      } else {
        const errorMsg = response.message || "Unknown REPL error";
        debugLog(`REPL error response: ${errorMsg}`);
        this.addReplHistoryEntry(errorMsg, "error");
      }
    } catch (error) {
      debugLog("REPL step error:", error);
      const errorMsg = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
      this.addReplHistoryEntry(errorMsg, "error");
    }
  }

  addReplHistoryEntry(text: string, type: "input" | "definition" | "expression" | "error", errorStage?: string, errorDetails?: string): void {
    const historyText = document.getElementById("history-text");
    if (!historyText) return;
    
    const entry = document.createElement("div");
    entry.className = "repl-entry";
    
    if (type === "input") {
      entry.innerHTML = `<div class="repl-input">
        <span class="repl-prompt-symbol">»</span>
        <span class="repl-input-text">${this.escapeHtml(text)}</span>
      </div>`;
    } else if (type === "error") {
      // Enhanced error display with stage information
      const stageClass = errorStage ? `repl-error-${errorStage}` : '';
      const stageName = errorStage ? this.getErrorStageName(errorStage) : 'Error';
      
      entry.innerHTML = `<div class="repl-error ${stageClass}">
        <div class="repl-error-header">
          <span class="repl-error-icon">⚠</span>
          <span class="repl-error-stage">${stageName}</span>
        </div>
        <div class="repl-error-message">${this.escapeHtml(text)}</div>
        ${errorDetails ? `<div class="repl-error-details">${this.escapeHtml(errorDetails)}</div>` : ''}
      </div>`;
    } else {
      // Success outputs (definition/expression) 
      // Double-check that error text doesn't accidentally get here
      if (text.toLowerCase().includes('error')) {
        // Safety fallback - treat as error even if type suggests otherwise
        entry.innerHTML = `<div class="repl-error">
          <div class="repl-error-header">
            <span class="repl-error-icon">⚠</span>
            <span class="repl-error-stage">Error</span>
          </div>
          <div class="repl-error-message">${this.escapeHtml(text)}</div>
        </div>`;
      } else {
        const icon = type === "definition" ? "✓" : "→";
        const className = type === "definition" ? "repl-definition" : "repl-expression";
        
        entry.innerHTML = `<div class="${className}">
          <span class="repl-output-icon">${icon}</span>
          <span class="repl-output-text">${this.escapeHtml(text)}</span>
        </div>`;
      }
    }
    
    historyText.appendChild(entry);
    
    // Scroll to bottom with smooth behavior
    requestAnimationFrame(() => {
      historyText.scrollTop = historyText.scrollHeight;
    });
  }

  private getErrorStageName(stage: string): string {
    const stageNames: Record<string, string> = {
      parse: "Syntax Error",
      canonicalize: "Canonicalization Error", 
      typecheck: "Type Error",
      layout: "Layout Error",
      evaluation: "Runtime Error",
      interpreter: "Interpreter Error",
      runtime: "Runtime Error", 
      unknown: "Error"
    };
    return stageNames[stage] || "Error";
  }

  checkReplTutorialStep(input: string): void {
    // Based on the old REPL tutorial steps from the original implementation
    const tutorialSteps = [
      {
        match: (input: string) => input.replace(/ /g, "") === "0.1+0.2",
        show: '<p>Was this the answer you expected? (If so, try this in other programming languages and see what their answers are.)</p><p>Roc has a <a href="/builtins/Num#Dec">decimal</a> type as well as <a href="/builtins/Num#F64">floating-point</a> for when performance is more important than decimal precision.</p><p>Next, enter <code>name = "(put your name here)"</code></p>',
      },
      {
        match: (input: string) => input.replace(/ /g, "").match(/^name="/i),
        show: '<p>This created a new <a href="https://www.roc-lang.org/tutorial#defs">definition</a>&mdash;<code>name</code> is now defined to be equal to the <a href="/tutorial#strings-and-numbers">string</a> you entered.</p><p>Try using this definition by entering <code>"Hi, ${name}!"</code></p>',
      },
      {
        match: (input: string) => input.match(/^"[^\$]+\$\{name\}/i),
        show: `<p>Nicely done! This is an example of <a href="/tutorial#string-interpolation">string interpolation</a>, which replaces part of a string with whatever you put inside the parentheses after a <code>$</code>.</p><p>Now that you've written a few <a href="/tutorial#naming-things">expressions</a>, you can either continue exploring in this REPL, or move on to the <a href="/tutorial">tutorial</a> to learn how to make full programs.<p><p><span class='welcome-to-roc'>Welcome to Roc!</span> <a href='/tutorial' class='btn-small'>Start Tutorial</a></p>`,
      },
    ];
    
    if (replTutorialStep < tutorialSteps.length) {
      const step = tutorialSteps[replTutorialStep];
      if (step && step.match(input)) {
        // Add tutorial content to history
        const historyText = document.getElementById("history-text");
        if (historyText) {
          const tutorialEntry = document.createElement("div");
          tutorialEntry.className = "repl-entry";
          tutorialEntry.innerHTML = `<div class="repl-tutorial">${step.show}</div>`;
          historyText.appendChild(tutorialEntry);
          historyText.scrollTop = historyText.scrollHeight;
        }
        replTutorialStep++;
      }
    }
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
          timeText = `${lastCompileTime.toFixed(1)}ms`;
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
      
      // Create bound functions to properly remove them later
      this.boundHandleMouseMove = (e: MouseEvent) => this.handleMouseMove(e);
      this.boundHandleMouseUp = () => this.handleMouseUp();
      
      document.addEventListener("mousemove", this.boundHandleMouseMove);
      document.addEventListener("mouseup", this.boundHandleMouseUp);
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
    
    // Remove the bound event listeners
    if (this.boundHandleMouseMove) {
      document.removeEventListener("mousemove", this.boundHandleMouseMove);
      this.boundHandleMouseMove = null;
    }
    if (this.boundHandleMouseUp) {
      document.removeEventListener("mouseup", this.boundHandleMouseUp);
      this.boundHandleMouseUp = null;
    }
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
