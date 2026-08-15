# Agent Capsule Specification v0.1

**Status:** Draft Standard  
**Version:** 0.1.0  
**Date:** 2026-08-15  
**Editors:** Agent Capsule Project Working Group  
**Canonical Schema:** `https://agentcapsule.org/schema/capsule-0.1.schema.json`  
**Reference Input:** [`docs/agent-capsule-proposal.md`](./agent-capsule-proposal.md)

---

## Abstract

Agent Capsule defines a single-file, content-addressed, cryptographically signed packaging format and execution protocol for AI agent tools and applications. A capsule packages guest logic, declarative capability manifests, and interactive user interfaces into an immutable container executed inside a zero-ambient-authority WebAssembly sandbox.

Every non-deterministic operation (system clock, cryptographic randomness, SQLite queries, key-value storage, network requests, logging, and packaging) is mediated across explicit effect ports and recorded in a hash-chained journal. This architecture guarantees strict deterministic replay, auditable execution traces, and zero unauthorized access to host resources. Agent Capsule natively exposes Model Context Protocol (MCP) `2026-07-28` endpoints over stdio and loopback HTTP for AI agents and human users alike.

---

## Terminology and Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

An implementation is a **Conforming Capsule Runtime** if it satisfies all normative requirements and passes Conformance Vectors C01 through C12 defined in §8.

---

## 1. Container Format & Deterministic Packaging

An Agent Capsule package is a single file with the `.capsule` extension structured as a standard PKZIP archive (ZIP format, version 2.0).

```
<name>.capsule (ZIP archive)
├── capsule.json                  # Manifest (§2)
├── src/                          # Guest code directory
│   └── main.js                   # Primary runtime entry point
├── ui/                           # Optional user interface directory
│   └── index.html                # MCP App / HTML UI
├── data/                         # Optional read-only static assets
└── .capsule/                     # Cryptographic metadata directory
    ├── statement.json            # In-toto attestation statement (§3)
    └── signature.json            # Ed25519 digital signature (§3)
```

### 1.1 Archive Constraints & Deterministic Rules

To guarantee content-addressable identity, reproducible builds, and defense against archive attacks:

1. **Deterministic Packing:**
   - Archive entries MUST be stored in strict lexicographical ascending order sorted by entry path as UTF-8 byte sequences (code unit order).
   - All entry modification timestamps (mtime) MUST be normalized to a fixed, timezone-independent DOS timestamp: `1980-01-01 00:00:00` (`0x00210000`).
   - Compression method MUST be either `STORE` (method 0, uncompressed) or standard `DEFLATE` (method 8).
   - Re-packing the extracted payload files under identical entries MUST yield byte-identical payload digests (`payloadDigest`).

2. **Entry Path Normalization:**
   - All entry paths MUST use forward slashes (`/`) as path separators. Backslash characters (`\`) MUST NOT appear in entry paths and MUST be rejected with error code `E_CONTAINER`.
   - Entry paths MUST NOT have a leading slash (`/`) or trailing slash (except directories).
   - Path segments MUST NOT be empty, MUST NOT equal `.`, and MUST NOT equal `..`.
   - Entry paths MUST NOT exceed 256 bytes in UTF-8 length.
   - Entry paths MUST belong to one of the following root prefixes: `capsule.json`, `src/`, `ui/`, `data/`, or `.capsule/`.

3. **Archive Integrity & Limits:**
   - Total number of entries MUST NOT exceed 4,096 (`MAX_ENTRIES = 4096`).
   - Individual uncompressed entry size MUST NOT exceed 32 MiB (`MAX_ENTRY = 32 * 1024 * 1024` bytes).
   - Total uncompressed size of all entries MUST NOT exceed 64 MiB (`MAX_TOTAL = 64 * 1024 * 1024` bytes).
   - Central Directory records MUST strictly match the local file header declarations.
   - Duplicate entry paths MUST NOT exist in the archive. An archive declaring duplicate paths MUST be rejected with `E_CONTAINER`.
   - Archives containing unlisted hidden entries or trailing central directory anomalies MUST be rejected with `E_CONTAINER`.

---

## 2. Manifest Schema (`capsule.json`)

The manifest file `capsule.json` MUST be located at the root of the archive and MUST conform to JSON Schema Draft 2020-12 at `https://agentcapsule.org/schema/capsule-0.1.schema.json`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentcapsule.org/schema/capsule-0.1.schema.json",
  "type": "object",
  "required": ["spec_version", "meta", "runtime", "tools"],
  "additionalProperties": false,
  "properties": {
    "spec_version": { "const": "0.1.0" },
    "meta": {
      "type": "object",
      "required": ["name", "version", "title", "description"],
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$" },
        "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.-]+)?$" },
        "title": { "type": "string", "minLength": 1, "maxLength": 80 },
        "description": { "type": "string", "minLength": 1, "maxLength": 500 },
        "author": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "name": { "type": "string", "maxLength": 80 },
            "key_id": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
          }
        }
      }
    },
    "runtime": {
      "type": "object",
      "required": ["type", "entry"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "quickjs-1" },
        "entry": { "type": "string", "pattern": "^src/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\\.js$" },
        "memory_limit_mb": { "type": "integer", "minimum": 1, "maximum": 512, "default": 64 },
        "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 5000 },
        "determinism": { "enum": ["strict"], "default": "strict" }
      }
    },
    "capabilities": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sql": { "type": "boolean", "default": false },
        "kv": { "type": "boolean", "default": false },
        "pack": { "type": "boolean", "default": false },
        "net": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "allowed_hosts": {
              "type": "array",
              "maxItems": 32,
              "items": {
                "type": "string",
                "pattern": "^(\\*\\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$"
              },
              "default": []
            },
            "allow_localhost": { "type": "boolean", "default": false }
          }
        }
      }
    },
    "tools": {
      "type": "array",
      "minItems": 1,
      "maxItems": 64,
      "items": {
        "type": "object",
        "required": ["name", "title", "description", "inputSchema"],
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string", "pattern": "^[a-zA-Z0-9_-]{1,64}$" },
          "title": { "type": "string", "minLength": 1, "maxLength": 80 },
          "description": { "type": "string", "minLength": 1, "maxLength": 1024 },
          "inputSchema": {
            "type": "object",
            "properties": { "type": { "const": "object" } },
            "required": ["type"]
          },
          "outputSchema": { "type": "object" },
          "effects": {
            "type": "array",
            "default": [],
            "items": {
              "enum": [
                "clock.now",
                "random.bytes",
                "sql.query",
                "sql.exec",
                "kv.get",
                "kv.set",
                "net.fetch",
                "log.write",
                "pack.write"
              ]
            }
          },
          "ui": { "type": "string", "pattern": "^ui://[A-Za-z0-9._/-]+$" }
        }
      }
    },
    "resources": {
      "type": "array",
      "maxItems": 64,
      "items": {
        "type": "object",
        "required": ["uri", "name", "mimeType", "path"],
        "additionalProperties": false,
        "properties": {
          "uri": { "type": "string", "pattern": "^capsule://[A-Za-z0-9._/-]+$" },
          "name": { "type": "string", "maxLength": 80 },
          "mimeType": { "type": "string", "maxLength": 100 },
          "path": { "type": "string", "pattern": "^(src|ui|data)/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$" }
        }
      }
    },
    "ui": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "app": {
          "type": "object",
          "required": ["resourceUri", "path"],
          "additionalProperties": false,
          "properties": {
            "resourceUri": { "type": "string", "pattern": "^ui://[A-Za-z0-9._/-]+$" },
            "path": { "type": "string", "pattern": "^ui/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\\.html$" },
            "csp": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "connectDomains": { "type": "array", "items": { "type": "string" }, "default": [] },
                "resourceDomains": { "type": "array", "items": { "type": "string" }, "default": [] },
                "frameDomains": { "type": "array", "items": { "type": "string" }, "default": [] },
                "baseUriDomains": { "type": "array", "items": { "type": "string" }, "default": [] }
              }
            }
          }
        },
        "local": {
          "type": "object",
          "required": ["path"],
          "additionalProperties": false,
          "properties": {
            "path": { "type": "string", "pattern": "^ui/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\\.html$" }
          }
        }
      }
    }
  }
}
```

### 2.1 Manifest Validation & Semantic Invariants

A conforming runtime MUST enforce the following semantic invariants when parsing `capsule.json`:

1. **Reserved Tool Names:** Tool names MUST NOT start with `capsule_`. The prefix `capsule_` is reserved exclusively for runtime built-in tools (`capsule_info`, `capsule_runs`, `capsule_replay`).
2. **Confusable Tool Names:** All tool names within a manifest MUST have distinct confusable skeletons (computed via NFKC normalization, lowercase folding, and homoglyph mapping). Clashing names MUST cause validation failure (`E_CONTENT`).
3. **Capability Enclosure:**
   - If any tool declares `sql.query` or `sql.exec`, `capabilities.sql` MUST be `true`.
   - If any tool declares `kv.get` or `kv.set`, `capabilities.kv` MUST be `true`.
   - If any tool declares `pack.write`, `capabilities.pack` MUST be `true`.
   - If any tool declares `net.fetch`, `capabilities.net.allowed_hosts` MUST NOT be empty, OR `capabilities.net.allow_localhost` MUST be `true`.
4. **CSP Enclosure:** All domains listed in `ui.app.csp.connectDomains` MUST be covered by `capabilities.net.allowed_hosts` or `capabilities.net.allow_localhost`.
5. **UI Resource Binding:** If a tool declares a `ui` field, its value MUST match `ui.app.resourceUri`.
6. **Path Traversal Immunity:** All relative path references (`runtime.entry`, `resources[].path`, `ui.app.path`, `ui.local.path`) MUST NOT contain `..` path segments and MUST point to existing container entries.

---

## 3. Cryptographic Provenance, Signing & Trust Model

Provenance in Agent Capsule is established via in-toto-inspired attestation statements and Ed25519 digital signatures.

### 3.1 Statement Document (`.capsule/statement.json`)

The statement document binds the capsule identity, individual payload file digests, builder metadata, and the tool catalog digest:

```json
{
  "spec": "agentcapsule.org/statement/0.1",
  "subject": {
    "name": "my-tool",
    "version": "1.0.0",
    "payloadDigest": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069"
  },
  "files": [
    { "path": "capsule.json", "sha256": "sha256:...", "size": 1240 },
    { "path": "src/main.js", "sha256": "sha256:...", "size": 3412 },
    { "path": "ui/index.html", "sha256": "sha256:...", "size": 5120 }
  ],
  "predicate": {
    "builder": {
      "name": "agent-capsule",
      "version": "0.1.0"
    },
    "toolCatalogDigest": "sha256:c06f8ff2ada78badb1f22c23fc07ada1b59e36b01397558899e03f366c3b8057"
  }
}
```

1. **Specification Identifier (`spec`):** MUST be `"agentcapsule.org/statement/0.1"`.
2. **Subject (`subject`):** Binds the capsule `name`, `version`, and `payloadDigest`.
3. **Files Array (`files`):** Contains all archive entries excluding `.capsule/statement.json` and `.capsule/signature.json`, sorted by `path` in UTF-8 code unit order. Each entry specifies `path`, `sha256` (hex-encoded SHA-256 with `sha256:` prefix), and uncompressed `size` in bytes.
4. **Payload Digest (`payloadDigest`):** The `digestOf` calculation (`sha256:` + hex hash of RFC 8785 canonical JSON) of the `files` array.
5. **Predicate (`predicate`):** Contains `builder` (`{ name, version }`) and `toolCatalogDigest`.
6. **Tool Catalog Digest (`toolCatalogDigest`):** The `digestOf` calculation of normalized tool declarations from `capsule.json` (sorted by tool name).

### 3.2 Signature Document (`.capsule/signature.json`)

```json
{
  "alg": "ed25519",
  "publicKey": "MCowBQYDK2VwAyEA...",
  "keyId": "sha256:d6b6...hex",
  "signature": "k2v1...base64"
}
```

1. **Algorithm (`alg`):** MUST be `"ed25519"`.
2. **Public Key (`publicKey`):** Base64-encoded SubjectPublicKeyInfo (SPKI) DER representation of the Ed25519 public key.
3. **Key Identifier (`keyId`):** Derived as `sha256:<hex>` over the raw DER-encoded SPKI bytes of the Ed25519 public key.
4. **Signature (`signature`):** Base64-encoded 64-byte Ed25519 signature over the UTF-8 bytes of `RFC8785(statement.json)`.

### 3.3 Trust-on-First-Use (TOFU) Keystore

The host maintains a local trust database at `$CAPSULE_HOME/trust.json` (default: `~/.agent-capsule/trust.json`).

1. **First Use (Pinning):** When a capsule name is first loaded, the runtime pins its `keyId` and `toolCatalogDigest`.
2. **Key Verification:** On subsequent executions of the same capsule name, the runtime verifies that the signature was generated by the pinned `keyId`. A mismatched `keyId` MUST fail with `E_TRUST` (detecting publisher key substitution / impersonation).
3. **Catalog Drift Detection:** If the `keyId` matches but the signed `toolCatalogDigest` has changed from the pinned value, the runtime MUST refuse execution with `E_TRUST` (catalog drift detected) unless the `--accept-drift` flag is explicitly provided.

---

## 4. Guest ABI & Sandboxing

Guest code execution MUST occur within an isolated WebAssembly sandbox (QuickJS-in-Wasm) with **zero ambient authority**.

```
Host Runtime (Node.js 24+)
  │
  │ QuickJS WebAssembly Sandbox (Zero ambient authority)
  ├── Global isolation (No process, no fs, no net, no setTimeout)
  ├── Determinism Prelude:
  │     Date.now() / new Date()   ──► effect 'clock.now'
  │     Math.random()             ──► effect 'random.bytes'
  │     getTimezoneOffset()       ──► fixed 0 (UTC)
  │
  ├── globalThis.tools = {
  │     my_tool: async (args) => { ... }
  │   }
  │
  └── Host Bridge: __capsule(opJson) ──► Effect Dispatcher
```

### 4.1 Export Surface & Calling Convention

1. Guest entry scripts MUST assign exported tool functions to `globalThis.tools.<toolName>`.
2. Tool functions receive a single validated JSON object argument (`args`) and return a JSON-serializable value or throw an error.
3. The guest environment MUST NOT expose host modules, global network objects (`fetch`, `XMLHttpRequest`), filesystem APIs, or process controls.

### 4.2 Host Bridge & Envelopes

The guest communicates with the host through a single host-injected function: `__capsule(opJson: string): string`.
- Request envelope: `JSON.stringify({ op: EffectName, params: Record<string, unknown> })`
- Response envelope: `JSON.stringify({ ok: true, value: unknown })` or `{ ok: false, error: { code: string, message: string } }`

If `__capsule` returns an envelope with `ok: false`, the guest helper unpacks the error and throws a standard JavaScript `Error` with the corresponding message and `.code` property.

### 4.3 Determinism Prelude

To ensure byte-for-byte reproducible execution:
1. **Clock Virtualization:** `Date.now()` and `new Date()` MUST invoke the `clock.now` effect. `Date.prototype.getTimezoneOffset` MUST return `0`. Local time methods (`getHours()`, `toString()`, etc.) are synthesized from UTC twins to prevent host timezone leakage.
2. **Randomness Virtualization:** `Math.random()` MUST be seeded from entropy acquired through the `random.bytes` effect port.
3. **Immutability:** Host bridge functions, `JSON` primitives, and core prototypes MUST be frozen or sealed against guest tampering.

### 4.4 Resource & Execution Limits

- **Memory Limit:** Configurable via `runtime.memory_limit_mb` (1–512 MiB, default 64 MiB). QuickJS memory allocator terminates exceeding executions with `E_GUEST`.
- **Execution Deadline:** Configurable via `runtime.timeout_ms` (100–60,000 ms, default 5,000 ms). An interrupt handler monitors elapsed CPU and asynchronous host dispatch time, terminating runaway guests with `E_TIMEOUT`.

---

## 5. Effect Vocabulary & State Management

All operations that read the outside world, persist state, or perform side effects are modeled as Effect Ports:

| Operation | Parameters | Return Value | Limits & Security Policy |
| :--- | :--- | :--- | :--- |
| `clock.now` | `{}` | ISO-8601 UTC timestamp string | Derived from host or replay journal. |
| `random.bytes` | `{ n: integer }` | Hexadecimal string | `1 <= n <= 64`. |
| `kv.get` | `{ key: string }` | `string` or `null` | Key length `<= 256` bytes. Requires `capabilities.kv = true`. |
| `kv.set` | `{ key: string, value: string }` | `true` | Key `<= 256` bytes, value `<= 64` KiB, total table `<= 10,000` rows. Requires `capabilities.kv = true`. |
| `sql.query` | `{ sql: string, params?: array }` | Array of row objects | Read-only connection. Max 1,000 rows, max 1 MiB serialized JSON. Requires `capabilities.sql = true`. |
| `sql.exec` | `{ sql: string, params?: array }` | `{ changes: integer }` | Read-write connection. Tokenized keyword checks forbid `ATTACH`, `PRAGMA`, and `VACUUM`. Requires `capabilities.sql = true`. |
| `log.write` | `{ message: string }` | `true` | Message `<= 2` KiB. Stripped of ANSI escapes and control characters, written strictly to host `stderr`. |
| `net.fetch` | `{ url: string, init?: object }` | `{ status, statusText, headers, body }` | HTTPS only (or HTTP on localhost). Host allowlist validation. SSRF protection (rejects RFC 1918 / link-local / cloud metadata IPs). Request `<= 1` MiB, response `<= 4` MiB, max 5 redirects. |
| `pack.write` | `{ dir: string, out?: string }` | `{ file, capsuleId, bytes }` | Directory packing into `.capsule`. Requires `capabilities.pack = true`. |

### 5.1 State Isolation

Guest SQLite database state is stored in an uncompressed sidecar file named `<capsule-path>.app.sqlite`. State files MUST NEVER be stored inside the `.capsule` archive itself. This guarantees that state mutations never invalidate cryptographic container signatures.

---

## 6. Hash-Chained Journal & Replay Engine

Every tool execution generates an immutable, hash-chained log stored in `<capsule-path>.journal.sqlite`.

### 6.1 Journal Schema

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS capsule_runs (
  run_id     TEXT PRIMARY KEY,
  capsule_id TEXT NOT NULL,
  tool       TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('record','replay')),
  status     TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capsule_events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES capsule_runs(run_id),
  idx       INTEGER NOT NULL,
  type      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL,
  UNIQUE (run_id, idx)
);
```

### 6.2 Hash-Chain Calculation

For each event at index `idx >= 0` within a run `run_id`:
- For the genesis event (`idx = 0`):
  `prev_hash = "sha256:" + "0".repeat(64)`
- For subsequent events (`idx > 0`):
  `prev_hash = previous_event.hash`
- Event hash formula:
  `hash = "sha256:" + sha256Hex(canonicalize({ run_id, idx, type, payload, prev_hash }))`
  where `canonicalize` denotes RFC 8785 JSON Canonicalization Scheme (JCS) and `sha256Hex` computes the lowercase hexadecimal SHA-256 digest.

### 6.3 Event Vocabulary

The journal records the following normative event types during execution:
1. `run.started`: Run initialization with run metadata.
2. `tool.proposed`: Tool invocation proposed with arguments or argument digest.
3. `tool.authorized`: Tool execution authorized following capability/policy check.
4. `interrupt.raised`: Interactive interrupt raised (e.g. Model-Requested Tool Routing).
5. `interrupt.resolved`: Interactive interrupt resolved with user consent response.
6. `effect.requested`: Effect invocation requested with operation name and parameters.
7. `effect.completed`: Effect execution completed with return value and elapsed duration.
8. `tool.completed`: Tool execution completed with return value or error.
9. `run.finished`: Run lifecycle finished with terminal status (`ok` or `error`).

### 6.4 Replay Modes

The runtime supports two execution modes for tool invocation and deterministic auditing:
1. **Record Mode (`mode = "record"`):** Standard tool invocation. Non-deterministic effects (`clock.now`, `random.bytes`, `sql.*`, `kv.*`, `net.fetch`, `log.write`, `pack.write`) are executed by host dispatchers, and each event with its parameters and results is appended to the hash-chained SQLite journal. When `CAPSULE_JOURNAL_ARGS=1` is set, invocation arguments are recorded in the journal to enable replay.
2. **Replay Mode (`mode = "replay"`):** Deterministic re-execution of guest code against recorded journal events. Effect results are served directly from the recorded sequence. Any divergence in effect sequence, operation name, or parameter digest triggers `E_NONDETERMINISM`.

---

## 7. Model Context Protocol (MCP) Integration

Agent Capsule implements the **Model Context Protocol specification `2026-07-28`** (stateless profile).

### 7.1 Protocol Discovery & Transport

- **Transport:** JSON-RPC 2.0 over standard input and standard output (`stdio`).
- **Stdio Purity:** Standard output MUST contain only valid JSON-RPC 2.0 messages delimited by single newlines (`\n`). All logging and diagnostic output MUST be directed to standard error (`stderr`).
- **Handshake & Discovery:**
  - `server/discover`: Advertises protocol version `2026-07-28` and capabilities.
  - `initialize`: Confirms protocol version and client metadata.
  - `ping`: Health verification.

### 7.2 Tool Discovery & Catalog Response (`tools/list`)

1. Manifest tools are merged with built-in tools (`capsule_info`, `capsule_runs`, `capsule_replay`).
2. Catalog response format:
   The `tools/list` response envelope includes top-level `resultType`, caching directives (`ttlMs: 3600000`, `cacheScope: "public"`), and server metadata in `_meta`:
```json
{
  "resultType": "complete",
  "tools": [
    {
      "name": "greet",
      "title": "Greet User",
      "description": "Returns a personalized greeting.",
      "inputSchema": {
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"]
      },
      "effects": []
    },
    {
      "name": "capsule_info",
      "title": "Capsule Information",
      "description": "Introspect capsule metadata, capabilities, trust state, publisher key, and tool list with effects.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      },
      "effects": []
    },
    {
      "name": "capsule_runs",
      "title": "Capsule Runs",
      "description": "Query recent execution runs from the journal sidecar, newest first.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "default": 10
          }
        },
        "additionalProperties": false
      },
      "effects": []
    },
    {
      "name": "capsule_replay",
      "title": "Capsule Replay",
      "description": "Replay a recorded run to verify deterministic execution.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "runId": { "type": "string" }
        },
        "required": ["runId"],
        "additionalProperties": false
      },
      "effects": []
    }
  ],
  "ttlMs": 3600000,
  "cacheScope": "public",
  "_meta": {
    "io.modelcontextprotocol/serverInfo": {
      "name": "capsule/my-tool",
      "version": "1.0.0"
    }
  }
}
```
3. **Security Screening:** Tool titles, descriptions, and JSON Schema strings are processed through the sanitization engine:
   - Unicode NFKC normalization.
   - ANSI escape sequence removal.
   - Zero-width character stripping.
   - Prompt injection pattern screening (see `docs/SECURITY.md`).

### 7.3 Model-Requested Tool Routing (MRTR) Consent

When a tool requires an ungranted capability (e.g. network access):
1. The server responds with `resultType: "input_required"`, an HMAC-signed `requestState` token, and a description of required grants.
2. The agent client prompts the user and returns `inputResponses` (`allow-once`, `always-allow`, or `deny`).
3. Consent is evaluated before guest execution starts.

### 7.4 MCP Apps UI Extension (`io.modelcontextprotocol/ui`)

When a capsule defines `ui.app`:
1. `resources/list` exposes `ui://<name>` with MIME type `text/html;profile=mcp-app`.
2. `resources/read` returns the HTML content accompanied by declared Content Security Policy (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`).
3. Tool descriptors in `tools/list` declare `_meta.ui.resourceUri = "ui://<name>"`.

### 7.5 Built-In Tools

| Built-In Tool | Parameters | Description |
| :--- | :--- | :--- |
| `capsule_info` | `{}` | Introspect capsule metadata, capabilities, trust state, publisher key, and tool list with effects. |
| `capsule_runs` | `{ limit?: integer }` | Query recent execution runs from the journal sidecar, newest first (limit: 1–50, default: 10). |
| `capsule_replay` | `{ runId: string }` | Replay a recorded run to verify deterministic execution. |

---

## 8. Conformance Vectors (C01–C12)

A suite of twelve normative conformance vectors defines the standard for conforming capsules:

| ID | Title | Severity | Invariant / Requirement Verified |
| :--- | :--- | :--- | :--- |
| **C01** | Container legal and repack-reproducible | Error | Archive entries, legal path segments, and byte-identical repack reproducibility (`payloadDigest`). |
| **C02** | Statement file digests match | Error | Every file in the container matches its listed SHA-256 digest in `statement.json`. |
| **C03** | Ed25519 signature valid & TOFU trust | Error | Valid Ed25519 signature over `RFC8785(statement.json)`, `keyId` derived from SPKI public key, and TOFU key pinning verified. |
| **C04** | Manifest valid & confusable-free | Error | Manifest valid under JSON Schema 2020-12, no reserved `capsule_*` names, no confusable tool name collisions. |
| **C05** | Schema composition bounds | Error | Tool input/output schemas compile under JSON Schema 2020-12 with depth $\le 8$ and subschemas $\le 200$. |
| **C06** | Capability & CSP enclosure | Error | Declared tool effects are covered by capability flags; CSP connect domains are covered by `allowed_hosts`. |
| **C07** | Prompt injection screening | Warn / Strict | Manifest text trees and schemas are free of prompt injection markers. |
| **C08** | Deterministic example replay | Error | Tool example inputs (`inputSchema.examples[0]`) record and replay identically. |
| **C09** | Host sandbox self-test | Error | Host WebAssembly sandbox successfully denies or interrupts unauthorized memory, CPU, and ambient access probes. |
| **C10** | Cold inspect & invocation budget | Warn | Cold inspection and initial tool call complete within 1,500 ms and $\le 128$ MiB RSS growth. |
| **C11** | Statement binds catalog and subject | Error | `statement.json` subject matches `capsule.json` name/version and binds `toolCatalogDigest`. |
| **C12** | Performance benchmarks | Warn | Performance budgets satisfied: Pack $\le 500$ ms, Verify $\le 200$ ms, Invoke $\le 500$ ms, Replay $\le 200$ ms. |

---

## 9. Divergence Table from Proposal

This specification deliberately diverges from the exploratory proposal (`docs/agent-capsule-proposal.md`) in several critical areas based on empirical security and systems research:

| Area | Proposal Design | Specification v0.1 Design | Technical Rationale |
| :--- | :--- | :--- | :--- |
| **Binary Format** | Cosmopolitan APE polyglot executable | Data-only ZIP container executed by host runtime | APE binaries trigger Windows Defender heuristics, fail Apple Silicon static binary bans, and require `binfmt_misc` on Linux. Data containers provide universal, unquarantined portability. |
| **Guest Runtime** | WAMR + WASI 0.2 components | QuickJS-in-Wasm (WASI 0.3 path on roadmap) | WASI 0.3.0 was ratified in June 2026. QuickJS-in-Wasm provides zero ambient authority, deterministic virtualized clocks, and async effect suspension in a single dependency. |
| **State Storage** | `app.sqlite` stored inside `.capsule` archive | Unsigned sidecar `<name>.app.sqlite` | Mutating an SQLite database inside the container invalidates cryptographic signatures and content-addressed hashes. Sidecars preserve container immutability. |
| **Non-Determinism** | Unrestricted host functions | Quarantined Effect Ports & Hash-Chained Journal | Durable execution pattern enables mathematical proof of replayability, audit trails, and regression verification. |
| **Protocol Version** | MCP 2024 draft with server-initiated elicitation | MCP `2026-07-28` stateless profile with MRTR | Modern MCP standardizes stateless servers, `_meta` request state, result types, and Model-Requested Tool Routing. |
| **Security Scope** | Sandbox boundaries only | Multi-layer: Signatures, TOFU, catalog drift detection, injection filtering | Real-world MCP security research demonstrates tool-poisoning, prompt injection, and silent catalog mutation (rug pulls) are primary threat vectors. |
| **Quine Builder** | Embedded compiler toolchain in every file | Host-provided `pack.write` effect and `capsule pack` tool | Eliminates bloated duplicated toolchains inside every package while preserving the ability for any capsule to produce capsules. |

---

## 10. Client Configuration Path Reference

When injecting MCP server configurations using `capsule inject`, paths are **never guessed or inferred**. Operators MUST explicitly provide the target configuration path via `--client-config`. The following table lists common client configuration locations:

| Client / Agent | Platform | Configuration File Path | Status |
| :--- | :--- | :--- | :--- |
| **Claude Desktop** | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` | `UNVERIFIED` |
| **Claude Desktop** | Windows | `%APPDATA%\Claude\claude_desktop_config.json` | `UNVERIFIED` |
| **Cursor** | macOS | `~/Library/Application Support/Cursor/User/globalStorage/cursor.mcp/mcp.json` | `UNVERIFIED` |
| **Cursor** | Windows | `%APPDATA%\Cursor\User\globalStorage\cursor.mcp\mcp.json` | `UNVERIFIED` |
| **Cursor** | Linux | `~/.config/Cursor/User/globalStorage/cursor.mcp/mcp.json` | `UNVERIFIED` |
| **Windsurf** | macOS | `~/.codeium/windsurf/mcp_config.json` | `UNVERIFIED` |
| **Windsurf** | Windows | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` | `UNVERIFIED` |
| **VS Code (Cline / Roo)** | Multiplatform | `~/.vscode/mcp.json` | `UNVERIFIED` |
| **OpenCode / Kilo** | Multiplatform | `.kilo/mcp.json` or `kilo.json` | `UNVERIFIED` |

---

## References

- [RFC 2119] Key words for use in RFCs to Indicate Requirement Levels
- [RFC 8174] Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words
- [RFC 8785] JSON Canonicalization Scheme (JCS)
- [RFC 8032] Edwards-Curve Digital Signature Algorithm (EdDSA / Ed25519)
- [MCP] Model Context Protocol Specification, version `2026-07-28`
- [in-toto] in-toto Attestation Framework v1.0
