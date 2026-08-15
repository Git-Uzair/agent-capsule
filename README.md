# Agent Capsule

**Agent Capsule** is a single-file, signed, capability-sandboxed package standard and runtime for AI agent tools and interactive applications.  
A capsule packages guest JavaScript/Wasm code, declarative capability manifests, and interactive web UIs into an immutable, content-addressed container.  
Every non-deterministic operation (time, randomness, SQL, KV, network) is mediated through explicit effect ports and recorded in a hash-chained journal for byte-identical replay.  
Any 2026 AI agent connects to a capsule as a stateless Model Context Protocol (MCP `2026-07-28`) server over stdio, and any human can launch its embedded UI with a single command.  
Zero ambient authority, automated prompt-injection screening, and cryptographic TOFU key pinning protect both the host machine and the recipient agent's context.

---

## Architecture

```
                 .capsule file  =  ZIP archive (immutable, signed, content-addressed)
                 ├── capsule.json                Manifest: metadata, runtime, capabilities, tools, UI
                 ├── src/main.js                 Guest code (QuickJS-in-Wasm, zero ambient authority)
                 ├── ui/index.html               UI served two ways (MCP App + loopback HTTP)
                 └── .capsule/
                     ├── statement.json          in-toto attestation: {subject, files[], predicate}
                     └── signature.json          Ed25519 signature over RFC-8785(statement)

HOST RUNTIME (Node.js 24+)                             MUTABLE SIDECARS (never signed)
┌─────────────────────────────────────────────────┐    ├── <name>.app.sqlite      guest SQL & KV state
│ CLI ──┬── mcp/         stdio JSON-RPC (2026-07) │    └── <name>.journal.sqlite  hash-chained journal
│       ├── ui/          loopback HTTP + token    │
│       ├── conformance/ 12 normative vectors     │
│       └── interop/     Agent Plugins & inject   │
│                                                 │
│  invoke.ts ──► validate args against Ajv 2020   │
│            ──► journal tool.proposed            │
│            ──► policy check (declared ∩ grants) │
│            ──► MRTR consent before guest runs   │
│                                                 │
│  guest.ts  ──► QuickJS-in-Wasm runtime          │
│            ──► memory ceiling & CPU deadlines   │
│            ──► determinism prelude (Date, Math) │
│            ──► __capsule() is the ONLY bridge   │
│                                                 │
│  effects.ts──► clock · random · sql · kv ·      │
│                net.fetch · log · pack           │
│            ──► record: append to hash-chain     │
│            ──► replay: serve journalled result  │
└─────────────────────────────────────────────────┘
```

---

## Security Posture

Agent Capsule treats the capsule as untrusted, the network as adversarial, and the recipient AI agent as a target. Guest logic runs inside a WebAssembly sandbox with zero access to host files, environment variables, or ambient sockets. Egress network traffic is gated by strict domain allowlists, private/loopback IP screening, and interactive user consent (MRTR). Manifests and parameter schemas are screened for prompt injection markers, hidden instructions, and confusable homoglyphs before reaching an agent. Cryptographic Ed25519 signatures and Trust-on-First-Use (TOFU) key/catalog pinning prevent supply chain tampering and silent capability expansions (rug pulls).

---

## Quickstart

### Prerequisites

- Node.js **>= 24.0.0** (uses built-in TypeScript execution and SQLite)

### Pack and Verify a Capsule

```bash
# Pack a project directory into a signed capsule
node src/cli.ts pack tests/fixtures/hello -o hello.capsule

# Verify cryptographic signature, container digests, and TOFU key pinning
node src/cli.ts verify hello.capsule
```

### Run and Replay Tools

```bash
# Execute a tool directly from the CLI (set CAPSULE_JOURNAL_ARGS=1 so arguments are recorded for replay)
CAPSULE_JOURNAL_ARGS=1 node src/cli.ts run hello.capsule --tool greet --args '{"name":"Ada"}'

# Replay the execution deterministically from the journal
node src/cli.ts replay hello.capsule
```

### Launch MCP Server & Web UI

```bash
# Run as an MCP 2026-07-28 stdio server for an AI agent
node src/cli.ts mcp hello.capsule

# Open the embedded MCP App UI in a browser
node src/cli.ts ui hello.capsule
```

### Run Conformance Suite

```bash
# Run the 12 normative conformance checks (C01–C12)
node src/cli.ts conformance hello.capsule --strict --perf
```

---

## CLI Reference

The CLI is available as `capsule` or `agent-capsule`:

| Command | Usage | Description |
| :--- | :--- | :--- |
| `pack` | `capsule pack <dir> [-o out.capsule]` | Pack a directory into a deterministic, signed `.capsule` archive. |
| `verify` | `capsule verify <file> [--json] [--allow-suspicious] [--accept-drift]` | Verify container integrity, Ed25519 signatures, and trust state. |
| `run` | `capsule run <file> --tool <name> [--args '<json>'] [--trace]` | Invoke a tool directly in the sandbox and record execution in journal (`CAPSULE_JOURNAL_ARGS=1` records args for replay). |
| `replay` | `capsule replay <file> [--run <runId>] [--json]` | Replay a recorded run deterministically and verify zero divergence. |
| `mcp` | `capsule mcp <file> [--accept-drift] [--allow-suspicious]` | Start stateless MCP `2026-07-28` JSON-RPC server over stdio. |
| `ui` | `capsule ui <file> [--port <n>] [--timeout <min>] [--no-open]` | Start authenticated loopback HTTP server and open embedded UI in browser. |
| `conformance` | `capsule conformance <file> [--strict] [--perf] [--self-test]` | Run the 12 normative conformance vectors against a capsule. |
| `inject` | `capsule inject <file> --client-config <path> [--name <name>] [--yes]` | Safely inject MCP server configuration into an AI agent client config. |
| `export-plugin` | `capsule export-plugin <file> -o <dir>` | Export Agent Plugins 1.0.0 layout (`plugin.json`, `mcp.json`, `SKILL.md`). |
| `install-handler` | `capsule install-handler [--uninstall] [--yes]` | Register Windows shell file associations for `.capsule` double-click. |

---

## Client Configuration Guide

To connect an Agent Capsule to your AI editor or desktop assistant, use `capsule inject` or add the stdio configuration manually.

### Automatic Injection

```bash
# Claude Desktop (macOS)
capsule inject my-app.capsule --client-config ~/Library/Application\ Support/Claude/claude_desktop_config.json --yes

# Claude Desktop (Windows)
capsule inject my-app.capsule --client-config "$APPDATA\Claude\claude_desktop_config.json" --yes

# Cursor (macOS)
capsule inject my-app.capsule --client-config ~/Library/Application\ Support/Cursor/User/globalStorage/cursor.mcp/mcp.json --yes

# Windsurf (Windows)
capsule inject my-app.capsule --client-config "$USERPROFILE\.codeium\windsurf\mcp_config.json" --yes
```

### Manual Configuration Example

Add to your client's `mcpServers` block:

```json
{
  "mcpServers": {
    "my-app": {
      "type": "stdio",
      "command": "agent-capsule",
      "args": ["mcp", "/absolute/path/to/my-app.capsule"]
    }
  }
}
```

---

## OpenTelemetry Tracing

Agent Capsule exports OpenTelemetry (OTel) traces for every execution. Tracing captures the root tool invocation span and child spans for each effect dispatch (`clock.now`, `sql.query`, `net.fetch`, etc.):

```bash
# Output OTel trace JSON to stdout
capsule run my-app.capsule --tool score_lead --args '{"domain":"acme.corp"}' --trace

# Automatically save OTLP trace files to a directory
CAPSULE_TRACE_DIR=./traces capsule run my-app.capsule --tool score_lead
```

---

## Verification & Testing

Agent Capsule includes an exhaustive automated test harness covering container cryptography, sandboxing invariants, determinism, MCP protocols, and interop:

```bash
# Run all unit and integration tests
npm test

# Run TypeScript typechecker
npm run typecheck
```

---

## Documentation Links

- **Normative Specification:** [`docs/SPEC.md`](docs/SPEC.md) — Container rules, schemas, ABI, effects, and conformance vectors.
- **Threat Model & Security Architecture:** [`docs/SECURITY.md`](docs/SECURITY.md) — Threat analysis, defense matrix, and disclosure policy.
- **Project Roadmap:** [`docs/ROADMAP.md`](docs/ROADMAP.md) — Shipped features and v0.2/v0.3 milestones.
- **Historical Proposal:** [`docs/agent-capsule-proposal.md`](docs/agent-capsule-proposal.md) — Visionary background input.
