import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { Client } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as readline from "node:readline";

class TestClient implements Client {
  async notify(_notification: any): Promise<void> {
    console.log("[Client] Notified:", _notification);
  }

  async requestPermission(params: any): Promise<any> {
    console.log("[Client] requestPermission:", params);
    return { result: "allow" };
  }

  async sessionUpdate(params: any): Promise<void> {
    if (params.update.sessionUpdate === "agent_message_chunk") {
      const text = params.update.content?.text || "";
      process.stdout.write(text);
    } else {
      console.log("\n[Session Update]:", params);
    }
  }
}

async function main() {
  console.log("Starting kilo-acp process...");
  const child = spawn("node", ["./dist/index.js"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  child.on("error", (err) => {
    console.error("Failed to start child process:", err);
  });

  const writeToAgent = Writable.toWeb(child.stdin) as WritableStream;
  const readFromAgent = Readable.toWeb(
    child.stdout,
  ) as ReadableStream<Uint8Array>;

  const stream = ndJsonStream(writeToAgent, readFromAgent);

  const client = new TestClient();
  const connection = new ClientSideConnection(() => client, stream);

  console.log("Initializing connection...");
  try {
    const initResponse = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    console.log("Initialization successful:", initResponse);

    const sessionResponse = await connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      extensions: [],
    });
    const sessionId = sessionResponse.sessionId;
    console.log("New session created:", sessionId);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = () => {
      rl.question('\nPrompt (or "exit"): ', async (prompt) => {
        if (prompt.toLowerCase() === "exit") {
          rl.close();
          child.kill();
          process.exit(0);
        }

        if (!prompt.trim()) {
          ask();
          return;
        }

        try {
          console.log("[Test] Sending prompt...");
          const res = await connection.prompt({
            sessionId,
            prompt: [{ type: "text", text: prompt }],
          });
          console.log(
            "\n[Test] Prompt completed. Stop reason:",
            res.stopReason,
          );
        } catch (e) {
          console.error("[Test] Error asking prompt:", e);
        }

        ask();
      });
    };

    ask();
  } catch (err) {
    console.error("Error during setup:", err);
    child.kill();
  }
}

main();
