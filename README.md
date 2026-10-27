# Pi Agentic Loop Debugger

A local web app that visualizes selected parts of Pi's agentic loop and pauses
at awaited Pi extension events.

> **Educational use only.** This is a simplified visualization of selected Pi
> events, not a complete debugger for Pi internals.

The package includes the bootcamp Mermaid diagram. A project-local
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

## Local development

Pi discovers the extension from the package manifest's `extensions` directory.
It can also be loaded directly during development:

```sh
pi -e ./extensions/agentic-loop-debugger.ts
```
