# Agent Capsule

**Agent Capsule** is a single-file, signed, capability-sandboxed package standard and runtime for AI agent tools and interactive applications.  
A capsule packages guest JavaScript/Wasm code, declarative capability manifests, and interactive web UIs into an immutable, content-addressed container (`.capsule`).  
Every non-deterministic operation (time, randomness, SQL, KV, network) is mediated through explicit effect ports and recorded in a hash-chained journal for byte-identical replay.  
Capsules run seamlessly in **Claude Desktop** (via double-clickable `.mcpb` bundles or the Capsule Manager gateway), **Cursor**, **VS Code**, **Claude Code**, and **Windsurf** with zero ambient authority, automated prompt-injection screening, and cryptographic TOFU key pinning.

---

## User Journeys

### 1. Running a Capsule in Claude Desktop (1-Click Install)

Recipients do not need Node.js installed, terminal access, or manual JSON editing:

1. Double-click any `.mcpb` bundle (e.g. `greeter-1.0.0.mcpb`).
2. Claude Desktop presents the extension installation dialog.
3. Click **Install** — the capsule's tools appear immediately in chat.

Extensions execute in Claude Desktop's built-in Node.js runtime (`>= 22.13.0`). State and journals automatically persist under `~/.agent-capsule/state/` across updates and re-installations.

To create an `.mcpb` bundle from any `.capsule`:
```bash
capsule export-mcpb my-app.capsule -o my-app.mcpb
```

---

### 2. Authoring Capsules in Chat via Capsule Manager

With the **Capsule Manager** extension installed, your AI agent creates, tests, signs, and shares capsules directly in conversation without opening a terminal:

1. Build the manager bundle (or install the official `capsule-manager.mcpb`):
   ```bash
   capsule build-manager-mcpb -o capsule-manager.mcpb
   ```
2. Double-click `capsule-manager.mcpb` to install it into Claude Desktop.
3. Ask your agent in chat:
   > *"Build me a capsule that tracks my reading list with SQLite and lets me add, search, and rate books."*
4. The agent writes the guest JavaScript, defines the schemas, and calls `capsule_create`.
5. The Manager verifies the capsule, signs it with your cryptographic key, runs the 12-vector conformance suite, installs it into your local registry, and dynamically registers the tools (e.g. `readinglist__add`, `readinglist__search`) without restarting Claude Desktop.
6. The agent hands back a shareable `.mcpb` and `.capsule` path ready to send to colleagues.

**Sharing is self-propagating:** the `.mcpb` an authored capsule emits is a *manager-seeded* bundle. A recipient who double-clicks it gets the capsule **and** the full Capsule Manager — so they can immediately author, install, and share capsules of their own. Seeded bundles all install under the single `capsule-manager` extension identity: installing a second one replaces the platform (never a duplicate gateway) while the recipient's capsule library accumulates in `~/.agent-capsule/`. A seeded capsule installs once; if the recipient uninstalls it, later restarts do not resurrect it.

---

### 3. Using Capsules in Cursor, VS Code, Claude Code, and Windsurf

To share or install a capsule across non-Claude clients, use `capsule share`:

```bash
capsule share my-app.capsule
```

Output provides ready-to-use links and configurations:

- **Cursor:** Click or copy the generated deep link (`cursor://anysphere.cursor-deeplink/mcp/install?...`).
- **VS Code:** Click or copy the generated deep link (`vscode:mcp/install?...`).
- **Claude Code / Terminal:** Run `npx -y agent-capsule mcp "/path/to/my-app.capsule" --state-home`.
- **Windsurf / Generic MCP:** Add the standard `mcpServers` JSON block:
  ```json
  {
    "mcpServers": {
      "my-app": {
        "command": "npx",
        "args": ["-y", "agent-capsule", "mcp", "/path/to/my-app.capsule", "--state-home"]
      }
    }
  }
  ```

#### Standalone Discovery & Installer Page
Double-clicking a bare `.capsule` file (or running `capsule ui <file.capsule>` on a capsule without an embedded UI) opens a local, authenticated discovery page displaying publisher cryptographic identity, TOFU trust status, declared capabilities, tool list, and 1-click install snippets.

---

## Developer CLI Reference

The CLI is available as `capsule` or `agent-capsule` (via `npm install -g agent-capsule` or `npx agent-capsule`):

| Command | Usage | Description |
| :--- | :--- | :--- |
| `pack` | `capsule pack <dir> [-o out.capsule]` | Pack a project directory into a deterministic, signed `.capsule` archive. |
| `verify` | `capsule verify <file> [--json] [--allow-suspicious] [--accept-drift]` | Verify container integrity, in-toto statement, Ed25519 signatures, and trust state. |
| `run` | `capsule run <file> --tool <name> [--args '<json>'] [--trace]` | Invoke a tool directly in the QuickJS sandbox and record execution in journal. |
| `replay` | `capsule replay <file> [--run <runId>] [--json]` | Replay a recorded run deterministically from the journal and verify zero divergence. |
| `mcp` | `capsule mcp <file> [--state-home] [--accept-drift] [--allow-suspicious]` | Start stateless MCP JSON-RPC server over stdio (negotiates `2026-07-28` to `2024-11-05`). |
| `ui` | `capsule ui <file> [--port <n>] [--timeout <min>] [--no-open]` | Start authenticated loopback HTTP server and open embedded UI or installer page. |
| `share` | `capsule share <file> [--json] [--accept-drift]` | Generate multi-client sharing payloads, Cursor/VS Code deep links, and config snippets. |
| `export-mcpb` | `capsule export-mcpb <file> [-o out.mcpb] [--manager]` | Export a self-contained 1-click install `.mcpb` extension bundle for Claude Desktop. `--manager` emits a manager-seeded bundle: the recipient gets the capsule plus the full Capsule Manager (authoring included). |
| `manager` | `capsule manager [--home <dir>] [--downloads <dir>] [--seed <file>]... [--allow-suspicious]` | Run the stdio Capsule Manager gateway server multiplexing all installed capsules. `--seed` installs a bundled capsule on first run (an uninstall is never overridden). |
| `build-manager-mcpb` | `capsule build-manager-mcpb [-o out.mcpb]` | Build the official Capsule Manager `.mcpb` bundle with authoring skills and gateway runtime. |
| `conformance` | `capsule conformance <file> [--strict] [--perf] [--self-test]` | Run the 12 normative conformance vectors (C01–C12) against a capsule. |
| `inject` | `capsule inject <file> --client-config <path> [--name <name>] [--yes]` | Safely inject MCP server configuration into client config files with shadow detection. |
| `export-plugin` | `capsule export-plugin <file> -o <dir>` | Export Agent Plugins 1.0.0 layout (`plugin.json`, `mcp.json`, `SKILL.md`). |
| `install-handler` | `capsule install-handler [--uninstall] [--yes]` | Register OS shell file associations for `.capsule` double-click launching. |

---

## Architecture & Security Posture

```text
                 .capsule file  =  ZIP archive (immutable, signed, content-addressed)
                 ├── capsule.json                Manifest: metadata, runtime, capabilities, tools, UI
                 ├── src/main.js                 Guest code (QuickJS-in-Wasm, zero ambient authority)
                 ├── ui/index.html               UI served two ways (MCP App + loopback HTTP)
                 └── .capsule/
                     ├── statement.json          in-toto attestation: {subject, files[], predicate}
                     └── signature.json          Ed25519 signature over RFC-8785(statement)

HOST RUNTIME (Node.js 22+)                             MUTABLE SIDECARS (never signed)
┌─────────────────────────────────────────────────┐    ├── <name>.app.sqlite      guest SQL & KV state
│ CLI ──┬── mcp/         stdio JSON-RPC           │    └── <name>.journal.sqlite  hash-chained journal
│       ├── manager/     dynamic gateway & skills │
│       ├── ui/          loopback HTTP + token    │
│       ├── conformance/ 12 normative vectors     │
│       └── share/       deep links & installers  │
│                                                 │
│  invoke.ts ──► validate args against Ajv 2020   │
│            ──► journal tool.proposed            │
│            ──► policy check (declared ∩ grants) │
│            ──► native elicitation / MRTR consent│
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

### Security Invariants
1. **Zero Ambient Authority:** Guest code runs in a WebAssembly sandbox isolated from host filesystem, environment variables, and network sockets.
2. **Deterministic Replay:** Non-deterministic inputs (time, entropy, database reads, network fetch) are journalled to hash-chained SQLite databases. Runs replay byte-for-byte identically.
3. **Cryptographic TOFU:** Public keys and tool catalog digests are pinned on first use (`~/.agent-capsule/trust.json`). Key rotations and catalog drifts require explicit confirmation.
4. **Prompt Injection Screening:** Tool descriptions and schemas are screened for adversarial instructions (`ignore_previous`, `system_prompt`, `conceal`) and unicode homoglyph confusable attacks.
5. **Interactive Consent (MRTR & Elicitation):** Declared network capabilities require interactive consent on first call (`always-allow`, `allow-once`, `deny`).

For detailed specifications, see:
- [Distribution Architecture Guide](docs/DISTRIBUTION.md)
- [Formal Specification (SPEC.md)](docs/SPEC.md)
- [Threat Model (THREAT-MODEL.md)](docs/THREAT-MODEL.md)

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

Run the full automated test suite and conformance harness:

```bash
# Run all unit and integration tests (400+ tests)
npm test

# Run TypeScript typechecker
npm run typecheck

# Run linter
npm run lint

# Build standalone distribution bundle
npm run build
```
