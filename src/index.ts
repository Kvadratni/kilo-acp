#!/usr/bin/env node
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { Agent } from "@agentclientprotocol/sdk";
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  AuthenticateRequest,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

interface KiloPart {
  id: string;
  type: string;
  text?: string;
}

interface KiloOutputMessage {
  type: string;
  timestamp: number;
  sessionID: string;
  part?: KiloPart;
  text?: string;
  message?: string;
  reason?: string;
}

interface KiloSession {
  workingDir: string;
  child: ChildProcess | null;
  pendingPrompt: {
    resolve: (response: PromptResponse) => void;
    reject: (error: Error) => void;
    abort: AbortController;
  } | null;
  messages: KiloOutputMessage[];
}

class KiloAgent implements Agent {
  private connection: AgentSideConnection;
  private sessions: Map<string, KiloSession> = new Map();
  private kiloBinary: string;

  constructor(connection: AgentSideConnection, kiloBinary: string = "kilo") {
    this.connection = connection;
    this.kiloBinary = kiloBinary;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.sessions.set(sessionId, {
      workingDir: params.cwd,
      child: null,
      pendingPrompt: null,
      messages: [],
    });

    return { sessionId };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    return;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    session.pendingPrompt?.abort.abort();
    session.pendingPrompt = {
      resolve: () => { },
      reject: () => { },
      abort: new AbortController(),
    };

    const promptText = this.extractPromptText(params.prompt);

    return new Promise((resolve, reject) => {
      if (!session.pendingPrompt) return;

      session.pendingPrompt.resolve = resolve;
      session.pendingPrompt.reject = reject;

      const child = spawn(
        this.kiloBinary,
        ["run", "--format", "json", promptText],
        {
          cwd: session.workingDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            TERM: "dumb",
            CI: "true",
          },
        },
      );

      session.child = child;
      const outputQueue: string[] = [];
      let processing = false;
      let outputBuffer = "";
      let resolveOnEmpty = false;

      const processQueue = async () => {
        if (processing) return;
        processing = true;

        while (outputQueue.length > 0) {
          const line = outputQueue.shift()!;
          if (line.trim()) {
            const shouldResolve = await this.handleKiloOutput(
              params.sessionId,
              line.trim(),
            );
            if (shouldResolve && session.pendingPrompt) {
              session.pendingPrompt.resolve({ stopReason: "end_turn" });
              session.pendingPrompt = null;
              session.child = null;
              return;
            }
          }
        }

        processing = false;

        const checkEmpty = () => {
          if (resolveOnEmpty && outputQueue.length === 0) {
            if (session.pendingPrompt) {
              session.pendingPrompt.resolve({ stopReason: "end_turn" });
              session.pendingPrompt = null;
            }
            session.child = null;
          }
        };

        checkEmpty();
      };

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        outputBuffer += chunk;

        const lines = outputBuffer.split("\n");
        outputBuffer = lines.pop() || "";

        for (const line of lines) {
          outputQueue.push(line);
        }

        processQueue();
      });

      child.stderr?.on("data", (data: Buffer) => {
        console.error("[kilo stderr]", data.toString());
      });

      child.on("close", () => {
        resolveOnEmpty = true;
        // If there's any remaining buffer, push it to the queue
        if (outputBuffer.trim()) {
          outputQueue.push(outputBuffer);
          outputBuffer = "";
          processQueue();
        } else if (!processing && outputQueue.length === 0) {
          if (session.pendingPrompt) {
            session.pendingPrompt.resolve({ stopReason: "end_turn" });
            session.pendingPrompt = null;
          }
          session.child = null;
        }
      });

      child.on("error", (err) => {
        if (session.pendingPrompt) {
          session.pendingPrompt.reject(err);
          session.pendingPrompt = null;
        }
      });
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.pendingPrompt?.abort.abort();
      if (session.child) {
        session.child.kill("SIGTERM");
      }
    }
  }

  private extractPromptText(prompt: unknown[]): string {
    const parts: string[] = [];

    for (const block of prompt) {
      if (block && typeof block === "object" && "text" in block) {
        parts.push((block as { text: string }).text);
      }
    }

    return parts.join("\n");
  }

  private async handleKiloOutput(
    sessionId: string,
    line: string,
  ): Promise<boolean> {
    let msg: KiloOutputMessage;

    try {
      msg = JSON.parse(line);
    } catch {
      return false;
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages.push(msg);
    }

    switch (msg.type) {
      case "text":
        const textContent = msg.part?.text || msg.text;
        if (textContent) {
          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: textContent,
              },
            },
          });
        }
        return false;

      case "tool":
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: msg.part?.id || `tool-${Date.now()}`,
            title: msg.part?.type || "Tool Call",
            status: "pending",
          },
        });
        return false;

      case "step_finish":
        return true;

      case "error":
        const errorSession = this.sessions.get(sessionId);
        if (errorSession?.pendingPrompt) {
          errorSession.pendingPrompt.reject(
            new Error(msg.text || msg.message || "Unknown error"),
          );
          errorSession.pendingPrompt = null;
        }
        return true;
    }

    return false;
  }
}

const input = Writable.toWeb(process.stdout) as WritableStream;
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(input, output);
new AgentSideConnection((conn) => new KiloAgent(conn), stream);
