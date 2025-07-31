# Roc WASM Playground API: Interface Control Document

## 1. Overview

This document provides a detailed specification for the WebAssembly (WASM) module that powers the Roc playground. The module exposes a state machine-driven interface for compiling and inspecting Roc source code, designed for interactive use in a web environment.

### 1.1. Core Concepts

- **State Machine:** The API operates as a simple, linear state machine. The host must send messages in the correct order to transition the module between states. The primary states are `START`, `READY`, and `LOADED`.
- **"Keep Going" Strategy:** The compiler is designed to be resilient. It attempts to proceed through all compilation stages (parsing, canonicalization, type checking) even if errors are encountered in earlier stages. This allows the playground to provide rich feedback, such as type information for valid code, even in the presence of syntax errors elsewhere in the file.
- **JSON-Based Communication:** All interaction with the WASM module is handled via JSON-formatted messages. The host sends a JSON request, and the module returns a JSON response.

## 2. Communication Protocol

The primary interaction with the WASM module is through a set of exported functions that manage memory and process messages.

### 2.1. Interaction Flow

The interaction flow is designed to be memory-safe by giving the host control over buffer allocation for both requests and responses.

1.  **Encode the Request:** The host serializes the JSON request message to a UTF-8 byte array.
2.  **Allocate & Write Request Buffer:** The host calls `allocateMessageBuffer(message_len)` to get a pointer (`message_ptr`) to a buffer in WASM memory, and then writes the message bytes into that buffer.
3.  **Allocate Response Buffer:** The host calls `allocateResponseBuffer(response_buffer_size)` to get a pointer (`response_ptr`) to a buffer where the WASM module will write its response. A size of 256KB is recommended.
4.  **Call `processMessage`:** The host calls the core `processMessage(message_ptr, message_len, response_ptr, response_buffer_size)` function. This function returns a status code (`WasmError` enum). A return value of `0` indicates success.
5.  **Read the Response:** If successful, the response buffer at `response_ptr` will be structured as follows:
    -   Bytes 0-3: The length of the JSON response string (as a `u32` little-endian integer).
    -   Bytes 4 onwards: The UTF-8 encoded JSON response string.
    The host reads the length, then decodes the response string.
6.  **Free Buffers:** The host must call `freeMessageBuffer()` and `freeResponseBuffer()` to release the memory used during the operation. The WASM module manages the pointers internally.

### 2.2. General Request Format

All requests sent to the module are JSON objects based on the `WasmMessage` structure.

```json
{
  "type": "MESSAGE_TYPE",
  "source": "(optional) source code string",
  "identifier": "(optional) identifier string",
  "line": "(optional) line number",
  "ch": "(optional) column number"
}
```

### 2.3. General Response Format

All responses from the module are JSON objects based on the `WasmResponse` structure.

```json
{
  "status": "SUCCESS" | "ERROR" | "INVALID_STATE" | "INVALID_MESSAGE",
  "message": "(optional) A human-readable description of the outcome",
  "data": "(optional) Payload data, typically HTML content for queries",
  "diagnostics": "(optional) Detailed compilation diagnostics",
  "type_info": "(optional) Type information for an identifier"
}
```

## 3. State Machine

The module's behavior is dictated by its current state. Sending a message in the wrong state will result in an `INVALID_STATE` error.

-   **`START`**: The initial state upon module instantiation. The module is uninitialized.
-   **`READY`**: The module has been initialized and is ready to accept Roc source code.
-   **`LOADED`**: Source code has been loaded and compiled. The module is ready to answer queries about the code.

-   **`START` -> `READY`**: Achieved by sending an `INIT` message.
-   **`READY` -> `LOADED`**: Achieved by sending a `LOAD_SOURCE` message.
-   **`LOADED` -> `READY`**: Achieved by sending a `RESET` message.
-   **`READY` -> `READY`**: Sending a `RESET` message in the `READY` state is a no-op that returns a success response.

## 4. API Reference

### 4.1. `INIT`

-   **Description:** Initializes the compiler, allocates necessary memory, and prepares the module to receive source code.
-   **Required State:** `START`
-   **State Transition:** `START` -> `READY`
-   **Request Payload:**
    ```json
    { "type": "INIT" }
    ```
-   **Success Response:** The `message` field contains the current compiler version string.
    ```json
    {
      "status": "SUCCESS",
      "message": "0.1.0-dev"
    }
    ```

### 4.2. `LOAD_SOURCE`

-   **Description:** Submits Roc source code for compilation. The module runs through all compiler stages and collects diagnostics.
-   **Required State:** `READY`
-   **State Transition:** `READY` -> `LOADED`
-   **Request Payload:**
    ```json
    {
      "type": "LOAD_SOURCE",
      "source": "module [main]\n\nmain = \"Hello, World!\""
    }
    ```
-   **Success Response:** The `message` is "LOADED" and the `diagnostics` object contains detailed results from the compilation.
    ```json
    {
      "status": "SUCCESS",
      "message": "LOADED",
      "diagnostics": { ... }
    }
    ```

### 4.3. `QUERY_TOKENS`

-   **Description:** Requests an HTML-formatted representation of the token stream from the last successful `LOAD_SOURCE` command.
-   **Required State:** `LOADED`
-   **Request Payload:**
    ```json
    { "type": "QUERY_TOKENS" }
    ```
-   **Success Response:** The `data` field contains an HTML string.
    ```json
    {
      "status": "SUCCESS",
      "data": "<div class='token-list'>...</div>"
    }
    ```

### 4.4. `QUERY_AST`

-   **Description:** Requests an HTML-formatted S-expression representation of the Abstract Syntax Tree (AST).
-   **Required State:** `LOADED`
-   **Request Payload:**
    ```json
    { "type": "QUERY_AST" }
    ```
-   **Success Response:** The `data` field contains an HTML string.
    ```json
    {
      "status": "SUCCESS",
      "data": "<div class='sexpr-tree'>...</div>"
    }
    ```

### 4.5. `QUERY_CIR`

-   **Description:** Requests an HTML-formatted S-expression representation of the Canonical Intermediate Representation (CIR).
-   **Required State:** `LOADED`
-   **Request Payload:**
    ```json
    { "type": "QUERY_CIR" }
    ```
-   **Success Response:** The `data` field contains an HTML string.
    ```json
    {
      "status": "SUCCESS",
      "data": "<div class='sexpr-tree'>...</div>"
    }
    ```

### 4.6. `QUERY_TYPES`

-   **Description:** Requests an HTML-formatted S-expression representation of the inferred types for all definitions.
-   **Required State:** `LOADED`
-   **Request Payload:**
    ```json
    { "type": "QUERY_TYPES" }
    ```
-   **Success Response:** The `data` field contains an HTML string.
    ```json
    {
      "status": "SUCCESS",
      "data": "<div class='sexpr-tree'>...</div>"
    }
    ```

### 4.7. `GET_TYPE_INFO`

-   **Description:** Requests the inferred type for a specific identifier at a given source position (1-based line, 0-based column).
-   **Required State:** `LOADED`
-   **Request Payload:**
    ```json
    {
      "type": "GET_TYPE_INFO",
      "identifier": "myVar",
      "line": 5,
      "ch": 2
    }
    ```
-   **Success Response:** The `type_info` object contains the string representation of the identifier's type.
    ```json
    {
      "status": "SUCCESS",
      "type_info": {
        "type": "Str"
      }
    }
    ```

### 4.8. `RESET`

-   **Description:** Resets the compiler state, clearing all loaded source code, diagnostics, and compiled artifacts.
-   **Required State:** `READY` or `LOADED`
-   **State Transition:** `READY` -> `READY` or `LOADED` -> `READY`
-   **Request Payload:**
    ```json
    { "type": "RESET" }
    ```
-   **Success Response:** Same as `INIT`, returns the compiler version.
    ```json
    {
      "status": "SUCCESS",
      "message": "0.1.0-dev"
    }
    ```

## 5. Data Structures Reference

### 5.1. `Diagnostics` Object

Returned by `LOAD_SOURCE`, this object provides a comprehensive summary of compiler feedback.

-   `summary`: A high-level count of errors and warnings.
    -   `errors`: `u32` - Total number of errors.
    -   `warnings`: `u32` - Total number of warnings.
-   `html`: `string` - A single HTML string containing all formatted diagnostic reports, suitable for display in a panel.
-   `list`: `Array<Diagnostic>` - A structured list of individual diagnostics, useful for placing markers in a code editor.
-   `debug_counts`: `object` - Detailed diagnostic counts broken down by compiler stage (`tokenize`, `parse`, `can`, `type`).

### 5.2. `Diagnostic` Object

Represents a single piece of compiler feedback.

-   `severity`: `string` - The level of severity, either `"error"`, `"warning"`, or `"info"`.
-   `message`: `string` - The primary message for the diagnostic.
-   `region`: `Region` - The source code location associated with the diagnostic.

### 5.3. `Region` Object

Defines a region in the source code.

-   `start_line`: `u32` - The 1-based starting line number.
-   `start_column`: `u32` - The 1-based starting column number.
-   `end_line`: `u32` - The 1-based ending line number.
-   `end_column`: `u32` - The 1-based ending column number.

### 5.4. `TypeInfo` Object

Returned by `GET_TYPE_INFO`, this object provides details about an identifier's type.

-   `type`: `string` - The string representation of the inferred type (e.g., `"Str"`, `"I32"`, `"List U8"`).
-   `description`: `?string` - (Optional) A more detailed description of the type. Currently unused.

## 6. Memory Management

The host is responsible for managing the memory buffers used for communication with the WASM module. This prevents uncontrolled memory growth within the module.

-   **`processMessage(...)`**: The primary function for sending a request. It uses buffers allocated by the host. It returns an integer status code, not a pointer.
-   **`allocateMessageBuffer(size)`**: Allocates a buffer for the request message.
-   **`freeMessageBuffer()`**: Frees the request message buffer.
-   **`allocateResponseBuffer(size)`**: Allocates a buffer for the response.
-   **`freeResponseBuffer()`**: Frees the response buffer.

**Note:** The module manages buffer pointers internally. The `free` functions do not take arguments.

## 7. Debugging

The module contains an internal, in-memory debug log to aid in troubleshooting.

-   **`getDebugLogBuffer()`**: Returns a pointer to the start of a null-terminated string containing the debug log.
-   **`clearDebugLog()`**: Clears the debug log.

The host can use these functions to read and display internal logging from the WASM module, which is especially useful when an unexpected error occurs.
