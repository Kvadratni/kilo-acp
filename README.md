# kilo-acp

ACP (Agent Client Protocol) adapter for [Kilo Code](https://kilo.ai).

This package bridges Kilo Code CLI to the Agent Client Protocol, allowing Kilo to be used as an agent in ACP-compatible applications like Staged.

## Installation

```bash
npm install -g kilo-acp
```

Or link locally for development:

```bash
cd kilo-acp
npm link
```

## Requirements

- [Kilo CLI](https://kilo.ai/docs/cli) installed and available in PATH
- Node.js 20+

## Usage

Once installed, `kilo-acp` will be available as a command. ACP-compatible applications will auto-detect it.

### Manual invocation

```bash
kilo-acp
```

This starts the ACP agent, communicating via newline-delimited JSON on stdin/stdout.

## How it works

The adapter spawns `kilo run --format json` and translates between:

- **ACP protocol**: Used by ACP clients (like Staged)
- **Kilo JSON Events**: Kilo's internal JSON messaging format

### Message translation

| ACP Event             | Kilo JSON-IO                      |
| --------------------- | --------------------------------- |
| `prompt`              | N/A (invokes `kilo run <prompt>`) |
| `agent_message_chunk` | `{"type": "text", ...}`           |
| `tool_call`           | `{"type": "tool", ...}`           |
| `requestPermission`   | N/A                               |
| `cancel`              | SIGTERM to child process          |

## Development

```bash
npm install
npm run build
```

### Testing the Bridge

You can test the ACP bridge locally using the interactive test client:

```bash
npm run build
node dist/test-client.js
```

This will instantiate a dummy SDK connection locally and allow you to interactively prompt the bridge and observe the raw text chunks that are returned.

## License

Apache-2.0
