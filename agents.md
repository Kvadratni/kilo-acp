# Agent Integration Guide

To use `kilo` as an active agent inside ACP-compatible clients (e.g., Staged, VS Code, Cursor), you must configure the client to communicate with the `kilo-acp` bridge.

## Configuring an ACP Client

Agent Client Protocol establishes communication over `stdio` using newline-delimited JSON. Configure your client to execute the `kilo-acp` binary natively on your machine or inside a container.

### Step 1: Install kilo-acp

Ensure both `kilo` and `kilo-acp` are installed globally and accessible in your system's PATH.

```sh
npm i -g kilo-acp
```

### Step 2: Configure Client Settings

Inside your IDE, editor, or custom ACP client, define the `kilo-acp` agent properties.

**Example Client Configuration:**

```json
{
  "agents": {
    "kilo": {
      "command": "kilo-acp",
      "args": [],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

### How It Works Behind the Scenes

When your client sends a PromptRequest with blocks of text, `kilo-acp` will:

1. Initialize the session using a `kilo run --format json` execution.
2. Proxy your prompt directly to `kilo`.
3. Read the sub-process text streams out via `ndjson`.
4. Wrap those responses within the protocol's Standard `agent_message_chunk` objects and deliver them back perfectly to your IDE.
