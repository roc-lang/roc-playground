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
import { HistoryManager } from "./repl-history";
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

const AppModeType = {
  EDITOR: "EDITOR",
  REPL: "REPL",
} as const;

const InitStateType = {
  INIT: "INIT",
  WASM_LOADING: "WASM_LOADING",
  WASM_READY: "WASM_READY",
  EDITOR_READY: "EDITOR_READY",
  REPL_INITIALIZING: "REPL_INITIALIZING",
  REPL_READY: "REPL_READY",
  ERROR: "ERROR",
} as const;

const IntentType = {
  DEFAULT_REPL: "DEFAULT_REPL",
  LOAD_URL_CONTENT: "LOAD_URL_CONTENT",
  LOAD_EXAMPLE: "LOAD_EXAMPLE",
} as const;

type AppMode =
  | { type: typeof AppModeType.EDITOR; content?: string }
  | { type: typeof AppModeType.REPL };

type InitState =
  | { type: typeof InitStateType.INIT }
  | { type: typeof InitStateType.WASM_LOADING }
  | { type: typeof InitStateType.WASM_READY }
  | { type: typeof InitStateType.EDITOR_READY }
  | { type: typeof InitStateType.REPL_INITIALIZING }
  | { type: typeof InitStateType.REPL_READY }
  | { type: typeof InitStateType.ERROR; message: string };

type InitIntent =
  | { type: typeof IntentType.DEFAULT_REPL }
  | { type: typeof IntentType.LOAD_URL_CONTENT; content: string }
  | { type: typeof IntentType.LOAD_EXAMPLE; exampleIndex: number };

interface AppState {
  initState: InitState;
  mode: AppMode;
  intent: InitIntent;
}

const isMode = {
  editor: (
    mode: AppMode,
  ): mode is { type: typeof AppModeType.EDITOR; content?: string } =>
    mode.type === AppModeType.EDITOR,
  repl: (mode: AppMode): mode is { type: typeof AppModeType.REPL } =>
    mode.type === AppModeType.REPL,
};

const isInitState = {
  init: (state: InitState): state is { type: typeof InitStateType.INIT } =>
    state.type === InitStateType.INIT,
  wasmLoading: (
    state: InitState,
  ): state is { type: typeof InitStateType.WASM_LOADING } =>
    state.type === InitStateType.WASM_LOADING,
  wasmReady: (
    state: InitState,
  ): state is { type: typeof InitStateType.WASM_READY } =>
    state.type === InitStateType.WASM_READY,
  editorReady: (
    state: InitState,
  ): state is { type: typeof InitStateType.EDITOR_READY } =>
    state.type === InitStateType.EDITOR_READY,
  replInitializing: (
    state: InitState,
  ): state is { type: typeof InitStateType.REPL_INITIALIZING } =>
    state.type === InitStateType.REPL_INITIALIZING,
  replReady: (
    state: InitState,
  ): state is { type: typeof InitStateType.REPL_READY } =>
    state.type === InitStateType.REPL_READY,
  error: (
    state: InitState,
  ): state is { type: typeof InitStateType.ERROR; message: string } =>
    state.type === InitStateType.ERROR,
};

const isIntent = {
  defaultRepl: (
    intent: InitIntent,
  ): intent is { type: typeof IntentType.DEFAULT_REPL } =>
    intent.type === IntentType.DEFAULT_REPL,
  loadUrlContent: (
    intent: InitIntent,
  ): intent is { type: typeof IntentType.LOAD_URL_CONTENT; content: string } =>
    intent.type === IntentType.LOAD_URL_CONTENT,
  loadExample: (
    intent: InitIntent,
  ): intent is { type: typeof IntentType.LOAD_EXAMPLE; exampleIndex: number } =>
    intent.type === IntentType.LOAD_EXAMPLE,
};

// Global state variables
let wasmInterface: WasmInterface | null = null;
let currentState: "INIT" | "READY" | "LOADED" | "REPL_ACTIVE" = "INIT";
let currentView: "PROBLEMS" | "TOKENS" | "AST" | "CIR" | "TYPES" = "PROBLEMS";
let lastDiagnostics: Diagnostic[] = [];
let activeExample: number | null = null;
let lastCompileTime: number | null = null;

let appState: AppState = {
  initState: { type: InitStateType.INIT },
  mode: { type: AppModeType.REPL },
  intent: { type: IntentType.DEFAULT_REPL },
};

let codeMirrorEditor: any = null;

let replHistory: Array<{
  input: string;
  output: string;
  type: "definition" | "expression" | "error";
}> = [];

const historyManager = new HistoryManager({
  maxSize: 500,
  deduplicateConsecutive: true,
});

function updateAppState(updates: Partial<AppState>): void {
  appState = { ...appState, ...updates };
  debugLog("App state updated:", appState);
  updateLoadingUI();
}

function updateLoadingUI(): void {
  if (isInitState.replInitializing(appState.initState)) {
    showReplLoadingSpinner();
  } else {
    hideReplLoadingSpinner();
  }
}

function showReplLoadingSpinner(): void {
  const replContainer = document.getElementById("replContainer");
  if (!replContainer) return;

  // Remove existing spinner if present
  const existingSpinner = replContainer.querySelector(".repl-loading-spinner");
  if (existingSpinner) return;

  // Create spinner overlay
  const spinner = document.createElement("div");
  spinner.className = "repl-loading-spinner";
  spinner.innerHTML = `
    <div class="spinner-overlay">
      <div class="spinner"></div>
      <div class="spinner-text">Initializing REPL...</div>
    </div>
  `;

  replContainer.appendChild(spinner);
}

function hideReplLoadingSpinner(): void {
  const existingSpinner = document.querySelector(".repl-loading-spinner");
  if (existingSpinner) {
    existingSpinner.remove();
  }
}

function determineInitIntent(): InitIntent {
  const hash = window.location.hash.slice(1);
  if (hash && (hash.startsWith("content=") || hash.length > 0)) {
    try {
      let b64 = hash;
      if (hash.startsWith("content=")) {
        b64 = hash.slice("content=".length);
      }
      // We don't decode here, just detect that content exists
      return { type: IntentType.LOAD_URL_CONTENT, content: b64 };
    } catch {
      return { type: IntentType.DEFAULT_REPL };
    }
  }
  return { type: IntentType.DEFAULT_REPL };
}

async function executeIntent(
  intent: InitIntent,
  playground: RocPlayground,
): Promise<void> {
  if (isIntent.defaultRepl(intent)) {
    updateAppState({ mode: { type: AppModeType.REPL } });
    await playground.ensureReplMode();
  } else if (isIntent.loadUrlContent(intent)) {
    updateAppState({ mode: { type: AppModeType.EDITOR } });
    await playground.ensureEditorMode();
    await playground.restoreFromHash();
  } else if (isIntent.loadExample(intent)) {
    updateAppState({ mode: { type: AppModeType.EDITOR } });
    await playground.ensureEditorMode();
    await playground.loadExampleInternal(intent.exampleIndex);
  }
}

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
      updateAppState({ initState: { type: InitStateType.INIT } });

      // Initialize debug utilities
      initializeDebug();

      // Determine what we plan to do before starting
      const intent = determineInitIntent();
      updateAppState({ intent });

      // Initialize WASM first
      updateAppState({ initState: { type: InitStateType.WASM_LOADING } });
      await this.initializeWasm();
      updateAppState({ initState: { type: InitStateType.WASM_READY } });

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

      currentState = "READY";

      // Execute the determined intent
      await executeIntent(intent, this);

      debugLog("Playground initialized successfully");
      console.log(
        "💡 Tip: Use toggleVerboseLogging() in console to enable detailed debug logging",
      );
    } catch (error) {
      console.error("Failed to initialize playground:", error);
      const message = error instanceof Error ? error.message : String(error);
      updateAppState({ initState: { type: InitStateType.ERROR, message } });
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
    const basicTypesExample = examples.find((ex) => ex.name === "Basic Types");
    const initialContent = basicTypesExample
      ? basicTypesExample.code
      : "# Select an example or write Roc code here...";

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
      exampleItem.setAttribute("role", "button");
      exampleItem.setAttribute("tabindex", "0");
      exampleItem.setAttribute("aria-label", `Load ${example.name} example`);
      exampleItem.innerHTML = `
        <div class="example-filename">${example.filename}</div>
      `;

      const handleActivation = () => {
        this.loadExample(index);
      };

      exampleItem.addEventListener("click", handleActivation);
      exampleItem.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleActivation();
        }
      });

      examplesList?.appendChild(exampleItem);
    });
  }

  async loadExample(index: number): Promise<void> {
    const intent: InitIntent = {
      type: IntentType.LOAD_EXAMPLE,
      exampleIndex: index,
    };
    updateAppState({ intent });
    await executeIntent(intent, this);
  }

  async loadExampleInternal(index: number): Promise<void> {
    const example = examples[index];
    if (!example) return;

    // Update active example
    if (activeExample !== null) {
      const exampleItems = document.querySelectorAll(".example-item");
      const previousItem = exampleItems[activeExample] as HTMLElement;
      previousItem?.classList.remove("active");
      previousItem?.setAttribute("aria-pressed", "false");
    }

    activeExample = index;
    const exampleItems = document.querySelectorAll(".example-item");
    const activeItem = exampleItems[index] as HTMLElement;
    activeItem?.classList.add("active");
    activeItem?.setAttribute("aria-pressed", "true");

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
      updateAppState({ mode: { type: AppModeType.EDITOR } });
      this.ensureEditorMode();
    });

    replModeBtn?.addEventListener("click", () => {
      updateAppState({ mode: { type: AppModeType.REPL } });
      this.ensureReplMode();
    });
  }

  async ensureEditorMode(): Promise<void> {
    if (isMode.editor(appState.mode)) {
      await this.switchToEditorMode();
      updateAppState({ initState: { type: InitStateType.EDITOR_READY } });
    }
  }

  async ensureReplMode(): Promise<void> {
    if (isMode.repl(appState.mode)) {
      updateAppState({ initState: { type: InitStateType.REPL_INITIALIZING } });
      await this.switchToReplMode();
      updateAppState({ initState: { type: InitStateType.REPL_READY } });
    }
  }

  async switchToEditorMode(): Promise<void> {
    debugLog("Switching to Editor mode...");

    // Update UI first
    const editorContainer = document.getElementById("editorContainer");
    const replContainer = document.getElementById("replContainer");
    const examplesSidebar = document.querySelector(".examples-sidebar") as HTMLElement;

    if (editorContainer) editorContainer.style.display = "flex";
    if (replContainer) replContainer.style.display = "none";
    if (examplesSidebar) examplesSidebar.style.display = "flex";

    this.updateModeButtons("EDITOR");

    // Reset WASM to editor mode
    if (wasmInterface) {
      await wasmInterface.reset();
      currentState = "READY";
    }

    debugLog("Editor mode activated");
  }

  async switchToReplMode(): Promise<void> {
    debugLog("Switching to REPL mode...");

    // Clear URL content and reset editor
    this.clearUrlContent();
    this.resetEditorContent();

    // Update UI
    const editorContainer = document.getElementById("editorContainer");
    const replContainer = document.getElementById("replContainer");
    const examplesSidebar = document.querySelector(".examples-sidebar") as HTMLElement;

    if (editorContainer) {
      editorContainer.style.display = "none";
      debugLog("Editor container hidden");
    }
    if (replContainer) {
      replContainer.style.display = "flex";
      debugLog("REPL container shown");
    }
    if (examplesSidebar) {
      examplesSidebar.style.display = "none";
      debugLog("Examples sidebar hidden");
    }

    this.updateModeButtons("REPL");

    // Initialize REPL
    debugLog("About to initialize REPL...");
    await this.initializeRepl();
    debugLog("REPL initialization completed");
  }

  updateModeButtons(mode?: "EDITOR" | "REPL"): void {
    const editorModeBtn = document.getElementById("editorModeBtn");
    const replModeBtn = document.getElementById("replModeBtn");

    const currentModeType = mode || appState.mode.type;

    if (currentModeType === "EDITOR") {
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
      updateAppState({
        initState: { type: "ERROR", message: "WASM interface not available" },
      });
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
        updateAppState({
          initState: {
            type: "ERROR",
            message: response.message || "REPL initialization failed",
          },
        });
        this.showError(`Failed to initialize REPL: ${response.message}`);
      }
    } catch (error) {
      console.error("Error initializing REPL:", error);
      debugLog("REPL initialization threw error:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      updateAppState({ initState: { type: "ERROR", message: errorMessage } });
      this.showError(`REPL initialization failed: ${errorMessage}`);
    }
  }

  setupReplInterface(): void {
    const sourceInput = document.getElementById(
      "source-input",
    ) as HTMLTextAreaElement;

    if (!sourceInput) {
      debugLog("REPL source input element not found");
      return;
    }

    debugLog("Setting up REPL interface...");

    // Clear the input value
    sourceInput.value = "";

    // Remove any existing event listeners first
    if (this.boundHandleReplInputKeyup) {
      sourceInput.removeEventListener("keyup", this.boundHandleReplInputKeyup);
    }
    if (this.boundHandleReplInputKeydown) {
      sourceInput.removeEventListener(
        "keydown",
        this.boundHandleReplInputKeydown,
      );
    }

    // Create bound functions
    this.boundHandleReplInputKeyup = (event: KeyboardEvent) => {
      this.handleReplInputKeyup(event);
    };
    this.boundHandleReplInputKeydown = (event: KeyboardEvent) => {
      this.handleReplInputKeydown(event);
    };

    // Setup keydown handler for arrow keys (to prevent default)
    sourceInput.addEventListener("keydown", this.boundHandleReplInputKeydown);

    // Setup keyup handler for ENTER key
    sourceInput.addEventListener("keyup", this.boundHandleReplInputKeyup);

    // Focus the input
    sourceInput.focus();

    debugLog("REPL interface set up successfully");
  }

  resetSourceInputHeight(): void {
    // Function disabled - was causing undesired auto-resize behavior
    // Keeping function stub to avoid breaking other code that might call it
  }

  private boundHandleReplInputKeyup: ((event: KeyboardEvent) => void) | null =
    null;
  private boundHandleReplInputKeydown: ((event: KeyboardEvent) => void) | null =
    null;

  handleReplInputKeydown(event: KeyboardEvent): void {
    const UP = 38;
    const DOWN = 40;
    const { keyCode } = event;

    switch (keyCode) {
      case UP:
        event.preventDefault(); // Prevent cursor movement
        this.navigateHistoryBackward();
        break;

      case DOWN:
        event.preventDefault(); // Prevent cursor movement
        this.navigateHistoryForward();
        break;

      default:
        break;
    }
  }

  handleReplInputKeyup(event: KeyboardEvent): void {
    const ENTER = 13;
    const { keyCode } = event;

    switch (keyCode) {
      case ENTER:
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
          this.processReplInput(inputText, true);
        }
        break;

      default:
        break;
    }
  }

  private addToHistory(input: string): void {
    // Use the robust history manager
    // console.log('[REPL] Adding to history:', input);
    historyManager.add(input);
  }

  private navigateHistoryBackward(): void {
    const sourceInput = document.getElementById(
      "source-input",
    ) as HTMLTextAreaElement;
    if (!sourceInput) return;

    const currentInputValue = sourceInput.value;
    // console.log('[REPL] UP pressed, current input:', currentInputValue);
    const historyCommand = historyManager.navigateBackward(currentInputValue);

    if (historyCommand !== null) {
      // console.log('[REPL] Setting input to:', historyCommand);
      this.setReplInput(historyCommand);
    } else {
      // console.log('[REPL] No history command returned');
    }
    // If null, we're at the oldest entry or have no history
  }

  private navigateHistoryForward(): void {
    const historyCommand = historyManager.navigateForward();

    if (historyCommand !== null) {
      this.setReplInput(historyCommand);
    }
    // If null, we're not in history navigation mode
  }

  setReplInput(value: string): void {
    const sourceInput = document.getElementById(
      "source-input",
    ) as HTMLTextAreaElement;
    if (sourceInput) {
      sourceInput.value = value;
      sourceInput.selectionStart = value.length;
      sourceInput.selectionEnd = value.length;
      // Removed auto-resize call
    }
  }

  async processReplInput(
    input: string,
    addToHistory: boolean = true,
  ): Promise<void> {
    if (!wasmInterface) {
      debugLog("REPL input processing failed: WASM interface not available");
      return;
    }

    debugLog(`Processing REPL input: "${input}"`);

    // Only add to history on first call, not on retries
    if (addToHistory) {
      // Hide intro text on first input
      const introText = document.getElementById("repl-intro-text");
      if (introText) {
        introText.style.display = "none";
      }

      // Add to input history (but skip commands starting with :)
      if (!input.startsWith(":")) {
        this.addToHistory(input);
      }

      // Add input to history display
      this.addReplHistoryEntry(input, "input");
    }

    try {
      // Handle client-side REPL commands
      if (input.startsWith(":")) {
        await this.handleReplCommand(input);
        return;
      }

      debugLog("Sending REPL_STEP message to WASM...");
      const response = await wasmInterface.replStep(input);
      debugLog("REPL_STEP response:", response);

      if (response.status === "SUCCESS" && response.result) {
        const result = response.result;
        debugLog(`REPL result: type=${result.type}, output="${result.output}"`);

        // Check for crash errors that require REPL reset
        const isCrash =
          result.type === "error" &&
          (result.output.includes("error.Crash") ||
            result.output.includes("panic!") ||
            result.output.includes("internal compiler error") ||
            result.output.includes("REPL crashed"));

        // Pass error stage and details for enhanced error display
        this.addReplHistoryEntry(
          result.output,
          result.type,
          result.error_stage,
          result.error_details,
        );

        // Add to internal history
        replHistory.push({
          input: input,
          output: result.output,
          type: result.type,
        });

        // If REPL crashed, automatically reset it
        if (isCrash) {
          await this.handleReplCrash();
        }
      } else if (response.status === "INVALID_STATE") {
        debugLog(
          "REPL not properly initialized, attempting to reinitialize...",
        );

        // Show loading spinner instead of error message
        updateAppState({ initState: { type: "REPL_INITIALIZING" } });

        // Try to reinitialize
        await this.initializeRepl();

        // If successful, retry the input
        if (appState.initState.type !== "ERROR") {
          updateAppState({ initState: { type: "REPL_READY" } });
          // Retry the original input without adding to history again
          await this.processReplInput(input, false);
        }
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

  addReplHistoryEntry(
    text: string,
    type: "input" | "definition" | "expression" | "error",
    errorStage?: string,
    errorDetails?: string,
    allowHtml: boolean = false,
  ): void {
    const historyText = document.getElementById("history-text");
    if (!historyText) return;

    const entry = document.createElement("div");
    entry.className = "repl-entry";

    if (type === "input") {
      const displayText = allowHtml ? text : this.escapeHtml(text);
      entry.innerHTML = `<div class="repl-input">
        <span class="repl-prompt">»</span>
        <span class="repl-input-text">${displayText}</span>
      </div>`;
    } else if (type === "error") {
      // Enhanced error display with stage information
      const stageClass = errorStage ? errorStage : "";
      const stageName = errorStage
        ? this.getErrorStageName(errorStage)
        : "Error";

      const displayText = allowHtml ? text : this.escapeHtml(text);
      const displayDetails = allowHtml
        ? errorDetails
        : this.escapeHtml(errorDetails || "");
      entry.innerHTML = `<div class="repl-error ${stageClass}">
        <div class="repl-error-header">
          <span class="repl-error-icon">⚠</span>
          <span class="repl-error-stage">${stageName}</span>
        </div>
        <div class="repl-error-message">${displayText}</div>
        ${errorDetails ? `<div class="repl-error-details">${displayDetails}</div>` : ""}
      </div>`;
    } else {
      // Success outputs (definition/expression)
      // Double-check that error text doesn't accidentally get here
      if (text.toLowerCase().includes("error")) {
        // Safety fallback - treat as error even if type suggests otherwise
        const displayText = allowHtml ? text : this.escapeHtml(text);
        entry.innerHTML = `<div class="repl-error">
          <div class="repl-error-header">
            <span class="repl-error-icon">⚠</span>
            <span class="repl-error-stage">Error</span>
          </div>
          <div class="repl-error-message">${displayText}</div>
        </div>`;
      } else {
        const variant = type === "definition" ? "definition" : "expression";
        const displayText = allowHtml ? text : this.escapeHtml(text);

        entry.innerHTML = `<div class="repl-output ${variant}">
          <span class="repl-text">${displayText}</span>
        </div>`;
      }
    }

    historyText.appendChild(entry);

    // Scroll to bottom - try multiple approaches for reliability
    this.scrollReplToBottom();
  }

  private scrollReplToBottom(): void {
    // Try multiple approaches to ensure scrolling works reliably
    requestAnimationFrame(() => {
      const historyText = document.getElementById("history-text");
      const replElement = document.getElementById("repl");
      const replContainer = document.getElementById("replContainer");

      // Try scrolling the history text element
      if (historyText) {
        historyText.scrollTop = historyText.scrollHeight;
      }

      // Try scrolling the main repl element
      if (replElement) {
        replElement.scrollTop = replElement.scrollHeight;
      }

      // Try scrolling the container
      if (replContainer) {
        replContainer.scrollTop = replContainer.scrollHeight;
      }

      // Use scrollIntoView as a fallback to ensure the last entry is visible
      const lastEntry = historyText?.lastElementChild;
      if (lastEntry) {
        lastEntry.scrollIntoView({
          behavior: "smooth",
          block: "end",
          inline: "nearest",
        });
      }
    });
  }

  private async handleReplCommand(command: string): Promise<void> {
    const parts = command.split(/\s+/);
    if (parts.length === 0 || !parts[0]) {
      return;
    }
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    switch (cmd) {
      case ":clear":
        this.clearReplHistory();
        break;

      case ":help":
        this.showReplHelp();
        break;

      case ":reset":
        await this.resetRepl();
        break;

      case ":history":
        this.showReplCommandHistory();
        break;

      case ":search":
        this.searchReplHistory(args);
        break;

      case ":stats":
        this.showHistoryStats();
        break;

      case ":export":
        this.exportHistory();
        break;

      case ":examples":
        this.switchToExamples();
        break;

      case ":theme":
        this.toggleTheme();
        this.addReplHistoryEntry("Theme toggled", "definition");
        break;

      default:
        this.addReplHistoryEntry(
          `Unknown command: ${command}. Type :help for available commands.`,
          "error",
        );
    }
  }

  private clearReplHistory(): void {
    const historyText = document.getElementById("history-text");
    if (historyText) {
      historyText.innerHTML = "";
    }
    historyManager.clear();
  }

  private showReplHelp(): void {
    const helpText =
      `Available REPL commands:<br><br>` +
      `  :clear         - Clear the REPL display<br>` +
      `  :help          - Show this help message<br>` +
      `  :reset         - Reset REPL state (clear variables)<br>` +
      `  :history       - Show command history<br>` +
      `  :search [term] - Search command history<br>` +
      `  :stats         - Show history statistics<br>` +
      `  :export        - Export history to clipboard<br>` +
      `  :examples      - Switch to Editor mode with examples<br>` +
      `  :theme         - Toggle light/dark theme<br><br>` +
      `Navigation:<br>` +
      `  ↑ (Up Arrow)   - Navigate to previous command<br>` +
      `  ↓ (Down Arrow) - Navigate to next command<br><br>` +
      `Enter expressions to evaluate or definitions (like x = 1) to use later.`;

    this.addReplHistoryEntry(
      helpText,
      "definition",
      undefined,
      undefined,
      true,
    );
  }

  private async resetRepl(): Promise<void> {
    this.addReplHistoryEntry("Resetting REPL state...", "definition");

    // Clear history using the history manager
    historyManager.clear();

    updateAppState({ initState: { type: InitStateType.REPL_INITIALIZING } });
    await this.initializeRepl();
    updateAppState({ initState: { type: InitStateType.REPL_READY } });
    this.addReplHistoryEntry("REPL state reset", "definition");
  }

  private showReplCommandHistory(): void {
    const historyDisplay = historyManager.getDisplay({ reverseOrder: false });

    if (historyDisplay.length === 0) {
      this.addReplHistoryEntry("No command history", "definition");
      return;
    }

    const historyText = historyDisplay
      .map((entry) => `${entry.index}. ${entry.command}`)
      .join("<br>");

    const stats = historyManager.getStats();
    const statsText = `<br><br>Statistics: ${stats.totalEntries} total, ${stats.uniqueCommands} unique`;

    this.addReplHistoryEntry(
      `Command history:<br>${historyText}${statsText}`,
      "definition",
      undefined,
      undefined,
      true,
    );
  }

  private searchReplHistory(searchTerm: string): void {
    if (!searchTerm) {
      this.addReplHistoryEntry(
        "Usage: :search [term]<br>Example: :search map",
        "error",
        undefined,
        undefined,
        true,
      );
      return;
    }

    const results = historyManager.search(searchTerm, { caseSensitive: false });

    if (results.length === 0) {
      this.addReplHistoryEntry(
        `No commands found matching "${searchTerm}"`,
        "definition",
      );
      return;
    }

    const resultText = results
      .map((entry, idx) => `${idx + 1}. ${this.escapeHtml(entry.command)}`)
      .join("<br>");

    this.addReplHistoryEntry(
      `Found ${results.length} command(s) matching "${searchTerm}":<br>${resultText}`,
      "definition",
      undefined,
      undefined,
      true,
    );
  }

  private showHistoryStats(): void {
    const stats = historyManager.getStats();

    const statsText =
      `History Statistics:<br><br>` +
      `Total commands: ${stats.totalEntries}<br>` +
      `Unique commands: ${stats.uniqueCommands}<br>` +
      `Duplicate ratio: ${
        stats.totalEntries > 0
          ? ((1 - stats.uniqueCommands / stats.totalEntries) * 100).toFixed(1)
          : 0
      }%<br>`;

    if (stats.mostRecent) {
      const timeAgo = Date.now() - stats.mostRecent.timestamp;
      const minutes = Math.floor(timeAgo / 60000);
      const timeText = minutes < 1 ? "just now" : `${minutes} minute(s) ago`;

      this.addReplHistoryEntry(
        statsText +
          `<br>Most recent: "${this.escapeHtml(stats.mostRecent.command)}" (${timeText})`,
        "definition",
        undefined,
        undefined,
        true,
      );
    } else {
      this.addReplHistoryEntry(
        statsText,
        "definition",
        undefined,
        undefined,
        true,
      );
    }
  }

  private async exportHistory(): Promise<void> {
    try {
      const historyJson = historyManager.export();
      await navigator.clipboard.writeText(historyJson);

      this.addReplHistoryEntry(
        "History exported to clipboard (JSON format)",
        "definition",
      );
    } catch (error) {
      this.addReplHistoryEntry(
        "Failed to export history to clipboard",
        "error",
      );
    }
  }

  private async handleReplCrash(): Promise<void> {
    debugLog("REPL crash detected, initiating automatic reset");

    // Show a user-friendly message
    this.addReplHistoryEntry(
      "⚠️ The REPL encountered an error and needs to restart.<br>" +
        "Reinitializing REPL state...",
      "definition",
      undefined,
      undefined,
      true,
    );

    // Small delay to let user see the message
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Reset the REPL state
    updateAppState({ initState: { type: InitStateType.REPL_INITIALIZING } });

    // Reset WASM state and reinitialize REPL
    if (wasmInterface) {
      try {
        await wasmInterface.reset();
        await this.initializeRepl();
        updateAppState({ initState: { type: InitStateType.REPL_READY } });

        this.addReplHistoryEntry(
          "✓ REPL successfully restarted. You can continue entering expressions.",
          "definition",
          undefined,
          undefined,
          true,
        );
      } catch (error) {
        debugLog("Failed to reset REPL after crash:", error);
        updateAppState({
          initState: {
            type: InitStateType.ERROR,
            message: "Failed to restart REPL. Please refresh the page.",
          },
        });

        this.addReplHistoryEntry(
          "❌ Failed to restart REPL. Please refresh the page to continue.",
          "error",
          undefined,
          undefined,
          true,
        );
      }
    }
  }

  private switchToExamples(): void {
    this.addReplHistoryEntry("Switching to Editor mode...", "definition");
    updateAppState({ mode: { type: AppModeType.EDITOR } });
    this.ensureEditorMode();
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
      unknown: "Error",
    };
    return stageNames[stage] || "Error";
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
      button.setAttribute("aria-selected", "false");
      button.setAttribute("tabindex", "-1");
    });

    const activeButton = document.getElementById(this.getButtonId(currentView));
    if (activeButton) {
      activeButton.classList.add("active");
      activeButton.setAttribute("aria-selected", "true");
      activeButton.setAttribute("tabindex", "0");
      
      // Update the output panel's aria-labelledby
      const outputContent = document.getElementById("outputContent");
      if (outputContent) {
        outputContent.setAttribute("aria-labelledby", activeButton.id);
      }
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

    // Remove existing summary and time elements
    const existingSummary = editorHeader?.querySelector(".diagnostic-summary");
    const existingTimeText = editorHeader?.querySelector(".compile-time");
    if (existingSummary) {
      existingSummary.remove();
    }
    if (existingTimeText) {
      existingTimeText.remove();
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

      if (totalErrors === 0 && totalWarnings === 0) {
        summaryText += "No errors or warnings";
      } else {
        const errorText = totalErrors === 1 ? 'error' : 'errors';
        const warningText = totalWarnings === 1 ? 'warning' : 'warnings';
        
        let errorPart = "";
        let warningPart = "";
        
        if (totalErrors > 0) {
          errorPart = `<span style="color: var(--color-error); font-weight: bold;">${totalErrors}</span> ${errorText}`;
        }
        
        if (totalWarnings > 0) {
          warningPart = `<span style="color: var(--color-warning); font-weight: bold;">${totalWarnings}</span> ${warningText}`;
        }
        
        if (errorPart && warningPart) {
          summaryText += `${errorPart} - ${warningPart}`;
        } else {
          summaryText += errorPart + warningPart;
        }
      }

      summaryDiv.innerHTML = summaryText;

      // Create separate time element
      if (lastCompileTime !== null) {
        const timeDiv = document.createElement("div");
        timeDiv.className = "compile-time";
        let timeText;
        if (lastCompileTime < 1000) {
          const ms = lastCompileTime.toFixed(1);
          timeText = ms.endsWith('.0') ? `${Math.round(lastCompileTime)} ms` : `${ms} ms`;
        } else {
          const seconds = (lastCompileTime / 1000).toFixed(1);
          timeText = seconds.endsWith('.0') ? `${Math.round(lastCompileTime / 1000)}s` : `${seconds}s`;
        }
        timeDiv.innerHTML = `⚡ ${timeText}`;
        editorHeader?.appendChild(timeDiv);
      }

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
    this.setupTabNavigation();
  }

  async updateUrlWithCompressedContent(): Promise<void> {
    // Don't update URL when in REPL mode
    if (isMode.repl(appState.mode)) {
      return;
    }

    if (this.updateUrlTimeout) {
      clearTimeout(this.updateUrlTimeout);
    }

    this.updateUrlTimeout = setTimeout(async () => {
      // Double-check mode hasn't changed during timeout
      if (isMode.repl(appState.mode)) {
        return;
      }

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

  clearUrlContent(): void {
    debugLog("Clearing URL content");

    // Clear any pending URL update timeouts
    if (this.updateUrlTimeout) {
      clearTimeout(this.updateUrlTimeout);
      this.updateUrlTimeout = null;
    }

    // Clear the URL
    window.history.replaceState(null, "", window.location.pathname);
  }

  resetEditorContent(): void {
    debugLog("Resetting editor content");
    if (codeMirrorEditor) {
      // Reset to empty content or default example
      const defaultContent = "# Enter Roc code here...";
      setDocumentContent(codeMirrorEditor, defaultContent);
    }

    // Clear active example
    if (activeExample !== null) {
      const exampleItems = document.querySelectorAll(".example-item");
      const activeItem = exampleItems[activeExample] as HTMLElement;
      activeItem?.classList.remove("active");
      activeItem?.setAttribute("aria-pressed", "false");
      activeExample = null;
    }
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
    const themeButton = document.getElementById("themeSwitch") as HTMLButtonElement;
    const currentTheme = document.documentElement.getAttribute("data-theme");
    if (themeButton) {
      themeButton.textContent = currentTheme === "dark" ? "Use Light Mode" : "Use Dark Mode";
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
    const editorHeader = document.querySelector(".editor-header");
    if (editorHeader) {
      let shareButton = editorHeader.querySelector(
        ".share-button",
      ) as HTMLButtonElement;
      if (!shareButton) {
        shareButton = document.createElement("button");
        shareButton.className = "share-button";
        shareButton.innerHTML = "share link";
        shareButton.title = "Copy shareable link to clipboard";
        shareButton.onclick = () => this.copyShareLink();
        editorHeader.appendChild(shareButton);
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

  setupTabNavigation(): void {
    const tabList = document.querySelector('.stage-tabs[role="tablist"]');
    if (!tabList) return;

    const tabs = Array.from(tabList.querySelectorAll('[role="tab"]')) as HTMLElement[];

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        this.activateTab(tab);
      });

      tab.addEventListener('keydown', (e) => {
        this.handleTabKeydown(e, tabs, index);
      });
    });
  }

  private activateTab(tab: HTMLElement): void {
    const tabId = tab.id;
    
    // Map tab IDs to their corresponding methods
    switch (tabId) {
      case 'diagnosticsBtn':
        this.showDiagnostics();
        break;
      case 'tokensBtn':
        this.showTokens();
        break;
      case 'parseBtn':
        this.showParseAst();
        break;
      case 'canBtn':
        this.showCanCir();
        break;
      case 'typesBtn':
        this.showTypes();
        break;
    }
  }

  private handleTabKeydown(e: KeyboardEvent, tabs: HTMLElement[], currentIndex: number): void {
    let targetIndex = currentIndex;

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        targetIndex = (currentIndex + 1) % tabs.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        e.preventDefault();
        targetIndex = 0;
        break;
      case 'End':
        e.preventDefault();
        targetIndex = tabs.length - 1;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        const currentTab = tabs[currentIndex];
        if (currentTab) {
          this.activateTab(currentTab);
        }
        return;
      default:
        return;
    }

    // Move focus to the target tab
    const targetTab = tabs[targetIndex];
    if (targetTab) {
      targetTab.focus();
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
