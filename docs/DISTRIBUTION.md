# Agent Capsule Distribution & Packaging Guide

This document specifies the distribution architecture for Agent Capsules, covering `.mcpb` bundle generation, the Claude Desktop runtime environment, sidecar state relocation, gateway multiplexing in Capsule Manager, and non-Claude client integration.

---

## 1. Overview & Distribution Models

Agent Capsules support two primary distribution vehicles depending on target client environments:

1. **Standalone `.mcpb` Extension Bundle** (Claude Desktop 1-Click Install):
   - A single ZIP archive containing the signed capsule, compiled runtime, QuickJS Wasm engine, icon, and extension manifest (`manifest_version: 0.2`).
   - Created via `capsule export-mcpb <file.capsule>`.
   - Recipients double-click the `.mcpb` file to install it directly into Claude Desktop with zero terminal commands, zero configuration editing, and no requirement for an external Node.js installation.
   - **Manager-seeded variant** (`capsule export-mcpb <file.capsule> --manager`, and the default output of in-chat `capsule_create`/`capsule_update`): the same payload, but the bundle runs `manager --seed <payload>` instead of a dedicated single-capsule server. The recipient gets the capsule *and* the full Capsule Manager, making sharing self-propagating — see §2a.

2. **Capsule Manager Platform Gateway** (Claude Desktop In-Chat Creation & Management):
   - An MCP server extension (`capsule-manager.mcpb`) that acts as a local gateway for installing, creating, updating, and executing capsules inside conversation.
   - Installed capsules expose tools namespaced as `<capsuleName>__<toolName>`.
   - Communicates dynamically with Claude Desktop via `notifications/tools/list_changed`.

3. **Multi-Client Deep Links & npx One-Liners** (Cursor, VS Code, Claude Code, Windsurf):
   - Generated via `capsule share <file.capsule>`.
   - Generates 1-click Cursor and VS Code deep links in each vendor's documented wire format (see §6), `npx` execution commands, and a pasteable `mcpServers` config block.
   - Double-clicking a bare `.capsule` file launches an authenticated loopback installer/discovery page (`capsule ui <file.capsule>`).

---

## 2. `.mcpb` Bundle Structure

An `.mcpb` file is a ZIP archive constructed deterministically with the following layout:

```text
my-capsule.mcpb
├── manifest.json                  Extension manifest (version 0.2)
├── package.json                   Engine declaration (node >= 22.13.0)
├── icon.png                       256x256 PNG extension icon
├── server/
│   ├── cli.js                     Compiled ESM runtime bundle (esbuild)
│   └── emscripten-module.wasm     QuickJS WebAssembly sandbox engine
└── payload/
    └── <name>-<version>.capsule   Byte-identical signed capsule archive
```

### `manifest.json` Specification (v0.2)

```json
{
  "manifest_version": "0.2",
  "name": "greeter",
  "version": "1.0.0",
  "description": "Greets users in conversation",
  "icon": "icon.png",
  "server": {
    "type": "node",
    "entry_point": "server/cli.js",
    "mcp_config": {
      "command": "node",
      "args": [
        "${__dirname}/server/cli.js",
        "mcp",
        "${__dirname}/payload/greeter-1.0.0.capsule",
        "--state-home"
      ],
      "env": {}
    }
  }
}
```

### Manifest Invariants
- `name`: Sanitized identifier matching `^[a-zA-Z0-9_-]{1,64}$`.
- `args`: Paths to `server/cli.js` and `payload/<name>.capsule` use `${__dirname}` templating resolved by Claude Desktop.
- `--state-home`: Directs the runtime to store state under `~/.agent-capsule/state/` rather than the extension directory (see Section 4).
- `payload`: The embedded `.capsule` file is packaged byte-identically so its statement digest and Ed25519 signature verify on load.

---

## 2a. Manager-Seeded Bundles (Self-Propagating Sharing)

A bundle built with `--manager` carries the same `payload/<name>-<version>.capsule` but its manifest launches the gateway instead of a dedicated server:

```json
"args": ["${__dirname}/server/cli.js", "manager", "--seed", "${__dirname}/payload/notepad-0.1.2.capsule"]
```

Invariants:

- **Stable extension identity.** The manifest `name` is always `capsule-manager` (version = host version, author = Agent Capsule). Clients derive the extension id from `name`, so installing any seeded bundle *replaces* the manager extension rather than standing up a second gateway over the same registry. The platform is fungible; the library under `~/.agent-capsule/` accumulates.
- **Seed-once semantics.** On boot, `--seed` runs the exact `capsule_install` pipeline (container verification, Ed25519 signature, TOFU pinning, prompt-injection screening, registry write) and then records the capsuleId in `~/.agent-capsule/seeded.json`. A capsuleId present there is never offered again: a user who uninstalls a seeded capsule does not find it resurrected on the next restart.
- **The platform survives its cargo.** A seed that fails verification, screening, or trust checks emits a diagnostic on `stderr` and is skipped; the manager serves regardless. `stdout` stays 100% JSON-RPC pure.
- **Trust is unchanged.** The recipient's first load TOFU-pins the sender's publisher key for that capsule name. A later seeded bundle whose same-named capsule is signed by a different key, or whose tool catalog drifted, is refused exactly as `capsule_install` would refuse it — seeding grants no bypass.

---

## 3. Claude Desktop Runtime Engine & SQLite Floor

### Built-in Node Runtime
Claude Desktop executes MCP extensions in a managed `UtilityProcess` using its built-in Node.js runtime (`appConfig.isUsingBuiltInNodeForMcp`). Users do not need Node.js installed on their machine.

### Node Engine Floor: `>= 22.13.0`
- `package.json` in the `.mcpb` root declares:
  ```json
  {
    "type": "module",
    "engines": {
      "node": ">=22.13.0"
    }
  }
  ```
- **Rationale:** Agent Capsule utilizes Node's built-in `node:sqlite` module for guest state databases and hash-chained journals. `node:sqlite` became available unflagged in Node `v22.13.0` and `v23.4.0`.
- **Startup Probe:** The compiled `cli.js` entry executes `probeSqliteSupport()` at startup. If `node:sqlite` is unavailable, it emits a plain-English diagnostic to `stderr` explaining the required Node version floor while keeping `stdout` 100% JSON-RPC pure.

---

## 4. Sidecar Relocation Rule (`--state-home`)

### The Problem
By default, the Agent Capsule CLI writes mutable sidecar databases beside the capsule file:
- `<file>.app.sqlite` (guest KV & SQL state)
- `<file>.journal.sqlite` (hash-chained replay journal)

In Claude Desktop, installed extensions live inside managed AppData directories (e.g., `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\Claude Extensions\local.mcpb.<author>.<name>\`). These directories are overwritten or deleted whenever an extension is updated or uninstalled. Storing database files inside the bundle directory causes data loss on upgrade and risks corrupting container verification.

### The Invariant
When executed with `--state-home` (the default for `.mcpb` bundles and Capsule Manager), sidecar databases are relocated to `CAPSULE_HOME`:

```text
~/.agent-capsule/
└── state/
    ├── sha256_<capsuleId>.app.sqlite
    └── sha256_<capsuleId>.journal.sqlite
```

- Databases are keyed by `capsuleId` (the SHA-256 payload digest), ensuring content-addressed isolation with zero namespace collision across different capsules sharing the same name.
- Upgrades preserve historical state seamlessly when the capsule ID is unchanged or referenced across sessions.

---

## 5. Capsule Manager Gateway Architecture

The Capsule Manager (`capsule-manager.mcpb`) is an official platform extension providing a dynamic MCP gateway.

### Architectural Decisions
- **No Direct Config Manipulation:** The Manager never edits `claude_desktop_config.json` (which is fragile, shadowed by MSIX Store packages on Windows, and requires application restarts).
- **Gateway Multiplexing:** The Manager server registers itself once in Claude Desktop and serves its own management tools alongside all installed capsules' tools.
- **Namespacing:** Installed capsule tools are mapped to `<capsuleName>__<toolName>` (double-underscore delimiter).
- **Dynamic List Changes:** The Manager advertises `tools.listChanged: true` in its capabilities and emits JSON-RPC `notifications/tools/list_changed` whenever a capsule is installed, created, updated, or removed.

### Management Registry
Installed capsules are tracked in `~/.agent-capsule/installed.json` and mirrored in `~/.agent-capsule/capsules/<capsuleId>.capsule`.

### Native Consent Elicitation
- When a client connects via MCP `2025-06-18` (or later) and advertises elicitation capabilities, missing capability grants (`net:*`, `pack`) trigger interactive `elicitation/create` prompts in chat.
- User decisions (`always-allow`, `allow-once`, `deny`) map directly to the MRTR security vocabulary.
- `always-allow` grants persist to `~/.agent-capsule/grants.json`.
- `allow-once` grants apply strictly to the immediate tool invocation and are never saved to disk.
- Legacy clients receive structured `E_CONSENT` error responses.

---

## 6. Multi-Client Sharing & Discovery

### `capsule share <file.capsule>`
The `share` command generates sharing payloads and deep links for any client environment:

- **JSON Payload (`--json`):**
  ```json
  {
    "name": "greeter",
    "version": "1.0.0",
    "capsuleId": "sha256:...",
    "keyId": "sha256:...",
    "npx_command": "npx -y agent-capsule mcp \"/path/to/greeter.capsule\" --state-home",
    "mcp_servers_config": {
      "mcpServers": {
        "greeter": {
          "command": "npx",
          "args": ["-y", "agent-capsule", "mcp", "/path/to/greeter.capsule", "--state-home"]
        }
      }
    },
    "cursor_deeplink": "cursor://anysphere.cursor-deeplink/mcp/install?name=greeter&config=eyJjb21tYW5kIjoi...",
    "vscode_deeplink": "vscode:mcp/install?%7B%22name%22%3A%22greeter%22%2C%22command%22%3A%22npx%22..."
  }
  ```

  `mcp_servers_config` carries the `mcpServers` wrapper on purpose: it is a client config file as pasted, not a fragment to re-wrap.

- **Deep link wire formats** (each vendor decodes its link its own way, so each is encoded its own way):

  | Client | Wire format | How the client reads it |
  | :--- | :--- | :--- |
  | Cursor | `cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 JSON>` | `name` is the server name; `config` is `JSON.stringify(serverConfig)` base64-encoded (`{"command":…,"args":[…]}` — no name, no `mcpServers` wrapper). Decode: `JSON.parse(atob(url.searchParams.get("config")))`. |
  | VS Code | `vscode:mcp/install?<URL-encoded JSON>` | The **whole query** is `encodeURIComponent(JSON.stringify({ name, ...serverConfig }))` — the name lives *inside* the object and there is no `config` parameter. Decode: `JSON.parse(decodeURIComponent(link.split("?")[1]))`. |

  Sources: [Cursor MCP install links](https://cursor.com/docs/mcp/install-links) and [VS Code — create an MCP installation URL](https://code.visualstudio.com/api/extension-guides/ai/mcp#create-an-mcp-installation-url).

  The Cursor base64 is additionally percent-encoded in the URL. Standard base64 can contain `+` and `/`, and a query parser that treats `+` as a space would corrupt the payload; percent-encoding round-trips through `URLSearchParams` unchanged.

- **Interactive Installer & Discovery Page:**
  - Running `capsule ui <file.capsule>` on a capsule without an embedded UI (or navigating to `/installer` on any capsule) serves a local, authenticated discovery page.
  - Displays cryptographic identity, publisher key fingerprint, TOFU trust state, declared capabilities, tool list with effects, and copyable client setup snippets.
  - The page writes no client configuration. The Claude Desktop section points at the `.mcpb` bundle (or the `capsule export-mcpb` command that produces one), names the exact `claude_desktop_config.json` it would otherwise edit — the Store `LocalCache` overlay when that shadowing copy exists, per `claudeStoreConfigPath` — and offers the `mcpServers` block to paste there by hand.
  - Enforces strict Content Security Policy (`default-src 'none'`, hashed inline scripts, loopback host validation, and token authentication).

---

## 7. Security Invariants

All distribution paths enforce the following non-negotiable security invariants:

1. **Verify Before Execute:** No guest code executes before `loadCapsule` verifies container digests, statement in-toto attestation, and the Ed25519 signature.
2. **Cryptographic TOFU:** Public keys and tool catalog digests are pinned on first use (`~/.agent-capsule/trust.json`). Key or catalog drift requires explicit user approval (`accept_drift: true`).
3. **Injection Screening:** Tool titles, descriptions, and schema property keys are screened for prompt injection markers (`ignore_previous`, `system_prompt`, `conceal`, etc.) and confusable homoglyphs prior to catalog publication.
4. **Deny-by-Default Capabilities:** Ambient host access is zero. Network requests to undeclared hosts or loopback addresses are blocked at the capability layer before DNS resolution.
5. **JSON-RPC Stdout Purity:** Stdio transports carry strictly valid JSON-RPC messages. Warnings, diagnostics, and probe failures route exclusively to `stderr`.
