import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = 45998;
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIAGRAM = join(PACKAGE_DIR, "..", "agentic-loop-lifecycle.mmd");
const FALLBACK_DIAGRAM = `flowchart TD
  START([Session starts]) --> WAIT
  subgraph OUTER[OUTER LOOP]
    WAIT[Wait for prompt] --> INPUT[Handle input]
    INPUT --> CONTEXT[Build initial context]
    subgraph INNER[INNER LOOP]
      CONTEXT --> TASK[Start task]
      TASK -->|Prompt skill attached| PROMPT_SKILL[Load Agent Skill<br/><small>Prompt-provided · prompt.skills</small>]
      PROMPT_SKILL --> LLM{LLM Core}
      TASK -->|No prompt skill| LLM
      LLM --> SKILL[Load Agent Skill]
      SKILL --> LLM
      LLM --> TOOL[Choose tool]
      TOOL --> ACTION[Use tool]
      ACTION --> CHECK[Result]
      CHECK --> LLM
    end
    LLM --> RESPONSE[Return response]
    RESPONSE --> REVIEW{Human review}
    REVIEW --> INPUT
    REVIEW --> WAIT
  end
  linkStyle default stroke:#111111,stroke-width:2px
  linkStyle 0 stroke:#c026d3,stroke-width:2.5px`;

type Mode = "off" | "step" | "continue";
type Pause = { release: () => void };
type Signal = { kind: "signal"; type: string; node: string; label: string; ts: number; source: string; toolName?: string };

let mode: Mode = "off";
let server: Server | undefined;
let startPromise: Promise<boolean> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let browserOpened = false;
let diagram = FALLBACK_DIAGRAM;
let pageTemplate = "";
let mermaidBundle = "";
let activePause: Pause | undefined;
let pauseTail: Promise<void> = Promise.resolve();
let currentNode: string | undefined;
let currentLabel: string | undefined;
let firstContext = true;
let promptSkills: string[] = [];
const clients = new Set<ServerResponse>();

function send(payload: unknown) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

function setMode(next: Mode) {
  mode = next;
  if (next !== "step") activePause?.release();
  send({ kind: "debugger", state: next, ts: Date.now() });
}

function setNode(node: string, label: string, type: string, toolName?: string, source = "hook"): Signal {
  currentNode = node;
  currentLabel = label;
  const signal: Signal = { kind: "signal", type, node, label, ts: Date.now(), source, toolName };
  send(signal);
  return signal;
}

async function checkpoint(
  type: string,
  node: string,
  label: string,
  ctx: ExtensionContext,
  force = false,
  toolName?: string,
) {
  const previous = currentNode;
  setNode(node, label, type, toolName);
  if (mode !== "step" || (!force && previous === node)) return;

  const prior = pauseTail;
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolveTurn) => { releaseTurn = resolveTurn; });
  pauseTail = prior.then(() => turn);
  await prior;
  if (mode !== "step") {
    releaseTurn();
    return;
  }

  let release!: () => void;
  const waiting = new Promise<void>((resolvePause) => { release = resolvePause; });
  activePause = { release };
  send({ kind: "debugger", state: "paused", node, label, type, ts: Date.now() });
  ctx.ui.setStatus("agentic-loop-debugger", `Paused: ${node}`);
  await waiting;
  activePause = undefined;
  send({ kind: "debugger", state: "resumed", ts: Date.now() });
  ctx.ui.setStatus("agentic-loop-debugger", mode === "off" ? "Debugger off" : "Debugger stepping");
  releaseTurn();
}

function setDebuggerMode(next: Mode, ctx: ExtensionContext) {
  setMode(next);
  ctx.ui.setStatus("agentic-loop-debugger", next === "off" ? "Debugger off" : next === "step" ? "Debugger stepping" : "Debugger continuing");
}

function toolNode(toolName: string, args: unknown) {
  let serialized = "";
  try { serialized = JSON.stringify(args); } catch { /* ignore */ }
  if (/skill/i.test(toolName) || /SKILL\.md/i.test(serialized)) {
    return { node: "SKILL", label: `Load Agent Skill · ${toolName}` };
  }
  return { node: "TOOL", label: `Choose tool · ${toolName}` };
}

function buildPage() {
  return pageTemplate.replace("__DIAGRAM__", JSON.stringify(diagram));
}

function startServer() {
  if (server?.listening) return Promise.resolve(true);
  if (startPromise) return startPromise;
  startPromise = new Promise<boolean>((resolveStart) => {
    const instance = createServer((req, res) => {
      const pathName = (req.url || "/").split("?")[0];
      if (pathName === "/vendor/mermaid-11.17.2.min.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" });
        res.end(mermaidBundle);
        return;
      }
      if (pathName === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write("retry: 1500\n\n");
        clients.add(res);
        res.write(`data: ${JSON.stringify({ kind: "snapshot", mode, node: activePause ? currentNode : currentNode, label: currentLabel })}\n\n`);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (pathName === "/control" && req.method === "POST") {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        let body = "";
        req.on("data", (chunk) => { body += chunk; if (body.length > 1024) req.destroy(); });
        req.on("end", () => {
          let action = "";
          try { action = JSON.parse(body || "{}").action; } catch { /* bad request */ }
          if (action === "next") activePause?.release();
          else if (action === "continue") setMode("continue");
          else if (action === "pause") setMode("step");
          else if (action === "off") {
            setMode("off");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, mode }));
            void stopServer();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, mode }));
        });
        return;
      }
      if (pathName === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buildPage());
    });
    server = instance;
    instance.once("error", (error) => {
      console.error("[pi-agentic-loop] server error:", error.message);
      server = undefined;
      resolveStart(false);
    });
    const port = Number(process.env.PI_AGENTIC_LOOP_PORT || DEFAULT_PORT);
    instance.listen(port, "127.0.0.1", () => {
      heartbeat = setInterval(() => send({ kind: "heartbeat", ts: Date.now() }), 15000);
      console.log(`[pi-agentic-loop] web app at http://127.0.0.1:${port}`);
      resolveStart(true);
    });
  }).finally(() => { startPromise = undefined; });
  return startPromise;
}

async function stopServer() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  for (const client of clients) { try { client.end(); } catch { /* ignore */ } }
  clients.clear();
  const current = server;
  server = undefined;
  if (!current?.listening) return;
  await new Promise<void>((resolveStop) => current.close(() => resolveStop()));
}

function openPage() {
  if (browserOpened || process.platform !== "darwin") return;
  browserOpened = true;
  const port = Number(process.env.PI_AGENTIC_LOOP_PORT || DEFAULT_PORT);
  spawn("open", [`http://127.0.0.1:${port}`], { detached: true, stdio: "ignore" }).unref();
}

async function enable(ctx: ExtensionContext) {
  diagram = await readFile(join(ctx.cwd, "agentic-loop-lifecycle.mmd"), "utf8")
    .catch(() => readFile(PACKAGE_DIAGRAM, "utf8"))
    .catch(() => FALLBACK_DIAGRAM);
  pageTemplate = await readFile(join(PACKAGE_DIR, "web", "index.html"), "utf8");
  mermaidBundle = await readFile(join(PACKAGE_DIR, "web", "vendor", "mermaid-11.17.2.min.js"), "utf8");
  if (!await startServer()) throw new Error("Could not start Pi debugger web app");
  setMode("step");
  ctx.ui.setStatus("agentic-loop-debugger", "Debugger stepping");
  openPage();
}

async function disable(ctx: ExtensionContext) {
  setMode("off");
  await stopServer();
  ctx.ui.setStatus("agentic-loop-debugger", "Debugger off");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("agentic-loop-debugger", {
    description: "Start/stop the Pi agentic loop debugger (on, off, toggle)",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "on") return enable(ctx);
      if (action === "off") return disable(ctx);
      if (action === "toggle") return mode === "off" ? enable(ctx) : disable(ctx);
      ctx.ui.notify("Usage: /agentic-loop-debugger [on|off|toggle]", "warning");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    setNode("START", "Session starts", "session_start", undefined, "event");
    ctx.ui.setStatus("agentic-loop-debugger", mode === "off" ? "Debugger off · /agentic-loop-debugger on" : "Debugger stepping");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    firstContext = true;
    promptSkills = extractPromptSkills(event.prompt);
    await checkpoint("before_agent_start", "INPUT", "Handle input · before_agent_start", ctx, true);
  });

  pi.on("context", async (_event, ctx) => {
    if (firstContext) {
      firstContext = false;
      await checkpoint("context", "CONTEXT", "Build initial context · context", ctx, true);
      await checkpoint("context", "TASK", "Start task · before first provider request", ctx, true);
      if (promptSkills.length) {
        await checkpoint("before_agent_start", "PROMPT_SKILL", `Load Agent Skill · ${promptSkills.join(", ")}`, ctx, true);
        promptSkills = [];
      }
    } else {
      await checkpoint("context", "LLM", "LLM Core · continuation context", ctx);
    }
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    await checkpoint("before_provider_request", "LLM", "LLM Core · before_provider_request", ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    const skill = skillTool(event.toolName, event.args);
    await checkpoint("tool_execution_start", skill ? "SKILL" : "TOOL", skill ? `Load Agent Skill · ${event.toolName}` : `Choose tool · ${event.toolName}`, ctx, false, event.toolName);
    setNode("ACTION", `Use tool · ${event.toolName}`, "tool_execution_start", "hook", event.toolName);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    await checkpoint("tool_execution_end", "CHECK", `Result · ${event.isError ? "tool failed" : "tool completed"}`, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as { role?: string; content?: Array<{ type?: string }> };
    if (message.role !== "assistant") return;
    const hasToolCall = (message.content || []).some((part) => part.type === "toolCall" || part.type === "tool_call");
    if (hasToolCall) return;
    await checkpoint("message_end", "RESPONSE", "Return response · assistant message_end", ctx, true);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (currentNode === "RESPONSE")
      await checkpoint("agent_settled", "WAIT", "Wait for prompt · agent_settled", ctx, true);
  });

  pi.on("session_shutdown", async () => {
    setMode("off");
    await stopServer();
  });
}
