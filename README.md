# Pi Agentic Loop Debugger

A local web app that visualizes selected parts of Pi's agentic loop and pauses
at awaited Pi extension events for educational purposes.

The package includes a Mermaid diagram. A project-local
`agentic-loop-lifecycle.mmd` takes precedence when present.

## Install from GitHub

Install globally from GitHub with:

```sh
pi install git:github.com/thanhtientc/pi-agentic-loop-debugger
```

Install only for the current project with `-l`:

```sh
pi install git:github.com/thanhtientc/pi-agentic-loop-debugger -l
```

Enable step mode in Pi:

```text
/agentic-loop-debugger on
```

Use **Next**, **Continue**, and **Pause** in the web app. Turn the debugger off
with:

```text
/agentic-loop-debugger off
```

The web app binds to `127.0.0.1:45998` by default. Override the port with
`PI_AGENTIC_LOOP_PORT`.

## Event-to-node mapping

| Diagram node | Pi hook/event signal(s) |
| --- | --- |
| **Session starts** | `session_start` |
| **Wait for prompt** | `agent_settled` |
| **Handle input** | `before_agent_start` |
| **Build initial context** | First `context` per agent run |
| **Start task** | Initial `context` · synthetic checkpoint |
| **Load Agent Skill** (prompt-provided) | Expanded `<skill>` in `before_agent_start`; initial `context` checkpoint |
| **Load Agent Skill** (agent-activated) | `tool_execution_start` (`skill` tool or `SKILL.md` path) |
| **LLM Core** | `before_provider_request`; continuation `context` |
| **Choose tool** | `tool_execution_start` |
| **Use tool** | `tool_execution_start` resume · synthetic `tool.execution` |
| **Result** | `tool_execution_end` |
| **Return response** | `message_end` (assistant message without tool call) |
| **Human review** | — |

## Local development

Pi discovers the extension from the package manifest's `extensions` directory.
It can also be loaded directly during development:

```sh
pi -e ./extensions/agentic-loop-debugger.ts
```

This package targets the `@earendil-works/pi-coding-agent` fork.
