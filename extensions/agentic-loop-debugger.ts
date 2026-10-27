import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = 45998;
const PACKAGE_DIAGRAM = fileURLToPath(new URL("../agentic-loop-lifecycle.mmd", import.meta.url));
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
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi Agentic Loop Debugger</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#e6e9f2;font:14px/1.4 -apple-system,system-ui,sans-serif}
header{height:54px;padding:8px 14px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #26314e}
header b{font-size:15px}.dot{width:10px;height:10px;border-radius:50%;background:#64748b}.dot.live{background:#22c55e;box-shadow:0 0 8px #22c55e}
#state{margin-left:auto;color:#fbbf24;font-size:12px}.controls{display:flex;gap:7px}.controls button{padding:6px 11px;border:1px solid #475569;border-radius:6px;color:#e6e9f2;background:#172033;cursor:pointer}.controls button.primary{background:#2563eb;border-color:#3b82f6}.controls button:disabled{opacity:.4;cursor:not-allowed}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;height:calc(100vh - 78px)}#diagram{overflow:auto;padding:14px}#log{overflow:auto;border-left:1px solid #26314e;background:#0d1428;padding:8px 10px}#log h3{margin:6px 2px;color:#94a3b8;font-size:12px;letter-spacing:.06em;text-transform:uppercase}
.row{padding:4px 5px;font:11px ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.time{color:#64748b;margin-right:6px}.node-name{color:#38bdf8}.signal{color:#a78bfa}.hook .signal{color:#f472b6}
.hl,.route-hl{fill:none;stroke:#ef4444;vector-effect:non-scaling-stroke;rx:6}.hl{stroke-width:3.5px;filter:drop-shadow(0 0 5px rgba(239,68,68,.85));animation:blink 1.1s ease-in-out infinite}.route-hl{stroke-width:3px;filter:drop-shadow(0 0 4px rgba(239,68,68,.7))}#diagram .edgePaths path.route-edge{stroke:#ef4444!important;stroke-width:4px!important;filter:drop-shadow(0 0 3px rgba(239,68,68,.8))}@keyframes blink{50%{opacity:.55}}
footer{height:24px;padding:3px 14px;color:#64748b;font-size:11px}
</style></head><body>
<header><span id="dot" class="dot"></span><b>Pi Agentic Loop Debugger</b><span id="state">DEBUGGER OFF</span><div class="controls"><button id="next" class="primary" disabled>Next</button><button id="continue">Continue</button><button id="pause" disabled>Pause</button></div></header>
<div class="layout"><div id="diagram"><pre>Loading diagram…</pre></div><div id="log"><h3>Pi loop signals</h3><div id="rows"></div></div></div>
<footer>Pi awaited extension events pause execution; use /agentic-loop-debugger on|off|toggle in Pi</footer>
<script>
var DIAGRAM=__DIAGRAM__;
var LABELS=[["START","session starts"],["WAIT","wait for prompt"],["INPUT","handle input"],["CONTEXT","build initial context"],["TASK","start task"],["PROMPT_SKILL","prompt-provided"],["LLM","llm core"],["SKILL","load agent skill"],["TOOL","choose tool"],["ACTION","use tool"],["CHECK","result"],["RESPONSE","return response"],["REVIEW","human review"]];
var EDGES=[["START","WAIT"],["WAIT","INPUT"],["INPUT","CONTEXT"],["CONTEXT","TASK"],["TASK","PROMPT_SKILL"],["PROMPT_SKILL","LLM"],["TASK","LLM"],["LLM","SKILL"],["SKILL","LLM"],["LLM","TOOL"],["TOOL","ACTION"],["ACTION","CHECK"],["CHECK","LLM"],["LLM","RESPONSE"],["RESPONSE","REVIEW"],["REVIEW","INPUT"],["REVIEW","WAIT"]];
var nodes={},svg=null,last=null,activeBox=null,routeEdges=[],routeBoxes=[],paused=false,mode="off",redMarker="pi-agentic-loop-arrow";
mermaid.initialize({startOnLoad:false,theme:"dark",flowchart:{htmlLabels:true,curve:"basis"}});
mermaid.render("pi-loop",DIAGRAM).then(function(r){document.getElementById("diagram").innerHTML=r.svg;svg=document.querySelector("#diagram svg");if(svg)svg.querySelectorAll("g.node").forEach(function(g){var text=(g.textContent||"").toLowerCase();for(var i=0;i<LABELS.length;i++)if(text.indexOf(LABELS[i][1])>=0){nodes[LABELS[i][0]]=g;return}});if(last)paint(last.node,last.label,null)}).catch(function(e){document.getElementById("diagram").textContent=String(e)});
function box(el){if(!svg||!el||!svg.getScreenCTM())return null;var r=el.getBoundingClientRect(),inv=svg.getScreenCTM().inverse(),p=svg.createSVGPoint();p.x=r.left;p.y=r.top;var a=p.matrixTransform(inv);p.x=r.right;p.y=r.bottom;var b=p.matrixTransform(inv);return{x:a.x,y:a.y,w:b.x-a.x,h:b.y-a.y}}
function clearRoute(){routeEdges.forEach(function(x){x.el.classList.remove("route-edge");if(x.marker)x.el.setAttribute("marker-end",x.marker);else x.el.removeAttribute("marker-end")});routeEdges=[];routeBoxes.forEach(function(x){x.remove()});routeBoxes=[]}
function path(from,to){var q=[{n:from,ns:[from],es:[]}],seen=new Set([from]);while(q.length){var cur=q.shift();for(var i=0;i<EDGES.length;i++){var e=EDGES[i];if(e[0]!==cur.n||seen.has(e[1]))continue;var ns=cur.ns.concat([e[1]]),es=cur.es.concat([e]);if(e[1]===to)return{ns:ns,es:es};seen.add(e[1]);q.push({n:e[1],ns:ns,es:es})}}return null}
function ensureMarker(){if(svg.querySelector("#"+redMarker))return;var defs=svg.querySelector("defs"),m=document.createElementNS("http://www.w3.org/2000/svg","marker");m.setAttribute("id",redMarker);m.setAttribute("viewBox","0 0 10 10");m.setAttribute("refX","5");m.setAttribute("refY","5");m.setAttribute("markerUnits","userSpaceOnUse");m.setAttribute("markerWidth","8");m.setAttribute("markerHeight","8");m.setAttribute("orient","auto");var p=document.createElementNS("http://www.w3.org/2000/svg","path");p.setAttribute("d","M 0 0 L 10 5 L 0 10 z");p.setAttribute("fill","#ef4444");p.setAttribute("stroke","#ef4444");m.appendChild(p);defs.appendChild(m)}
function addRouteRect(el){var b=box(el);if(!b)return;var r=document.createElementNS("http://www.w3.org/2000/svg","rect");r.setAttribute("class","route-hl");r.setAttribute("x",b.x-6);r.setAttribute("y",b.y-6);r.setAttribute("width",b.w+12);r.setAttribute("height",b.h+12);r.setAttribute("rx",6);svg.appendChild(r);routeBoxes.push(r)}
function route(from,to){var p=path(from,to);if(!p)return;ensureMarker();p.es.forEach(function(e){var el=svg.querySelector('.edgePaths [data-id="L_'+e[0]+'_'+e[1]+'_0"]');if(!el)return;routeEdges.push({el:el,marker:el.getAttribute("marker-end")});el.classList.add("route-edge");el.setAttribute("marker-end","url(#"+redMarker+")")});p.ns.slice(1,-1).forEach(function(id){if(nodes[id])addRouteRect(nodes[id])})}
function paint(id,label,previous){if(previous!==id){clearRoute();if(previous)route(previous,id)}Object.keys(nodes).forEach(function(k){nodes[k].classList.remove("pulse")});if(activeBox){activeBox.remove();activeBox=null}var n=nodes[id];if(n){n.classList.add("pulse");var b=box(n);if(b){var r=document.createElementNS("http://www.w3.org/2000/svg","rect");r.setAttribute("class","hl");r.setAttribute("x",b.x-6);r.setAttribute("y",b.y-6);r.setAttribute("width",b.w+12);r.setAttribute("height",b.h+12);r.setAttribute("rx",6);svg.appendChild(r);activeBox=r}n.scrollIntoView({block:"nearest",inline:"nearest"})}document.title="Pi Loop · "+id}
function log(m){var d=document.createElement("div");d.className="row"+(m.source==="hook"?" hook":"");var detail=m.toolName&&(m.type==="tool.execution"||m.type==="tool_execution_start")?" · "+m.toolName:"";d.innerHTML='<span class="time">'+new Date(m.ts).toLocaleTimeString()+'</span><span class="node-name">'+m.node+'</span> <span class="signal">'+m.type+detail+'</span>';var rows=document.getElementById("rows");rows.insertBefore(d,rows.firstChild);while(rows.childElementCount>300)rows.removeChild(rows.lastChild)}
function state(s,n){paused=s==="paused";mode=s==="running"?"continue":s==="off"?"off":(s==="step"||paused?"step":mode);document.getElementById("state").textContent=n|| (paused?"PAUSED · "+(n||""):mode==="off"?"DEBUGGER OFF":mode==="continue"?"CONTINUING":"STEP MODE");document.getElementById("next").disabled=!paused;document.getElementById("continue").disabled=mode==="off"||(mode==="continue"&&!paused);document.getElementById("pause").disabled=mode==="off"||(mode==="step"&&!paused)}
async function control(action){try{await fetch("/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:action})})}catch(e){document.getElementById("state").textContent="CONTROL ERROR"}}
document.getElementById("next").onclick=function(){control("next")};document.getElementById("continue").onclick=function(){control("continue")};document.getElementById("pause").onclick=function(){control("pause")};
var es=new EventSource("/events");es.onopen=function(){document.getElementById("dot").classList.add("live")};es.onerror=function(){document.getElementById("dot").classList.remove("live")};es.onmessage=function(ev){if(!ev.data)return;var m=JSON.parse(ev.data);if(m.kind==="snapshot"){state(m.mode);if(m.node){last={node:m.node,label:m.label};paint(m.node,m.label,null)}return}if(m.kind==="debugger"){state(m.state,m.state==="paused"?m.node:undefined);if(m.state==="paused"&&m.node)paint(m.node,m.label,last&&last.node);return}if(m.kind!=="signal")return;var previous=last&&last.node;last={node:m.node,label:m.label};paint(m.node,m.label,previous);log(m)};
</script></body></html>`;
  return html.replace("__DIAGRAM__", JSON.stringify(diagram));
}

function extractPromptSkills(prompt: string) {
  const names: string[] = [];
  for (const match of prompt.matchAll(/<skill\s+name="([^"]+)"/g)) names.push(match[1]);
  return [...new Set(names)];
}

function skillTool(toolName: string, args: unknown) {
  let serialized = "";
  try { serialized = JSON.stringify(args); } catch { /* ignore */ }
  return /skill/i.test(toolName) || /SKILL\.md/i.test(serialized);
}

function startServer() {
  if (server?.listening) return Promise.resolve(true);
  if (startPromise) return startPromise;
  startPromise = new Promise<boolean>((resolveStart) => {
    const instance = createServer((req, res) => {
      const pathName = (req.url || "/").split("?")[0];
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
