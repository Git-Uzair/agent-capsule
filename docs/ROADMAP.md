# Agent Capsule Roadmap

**Current Release:** v0.1.0 ("Capsule Core")  
**Date:** August 2026

---

## 1. Milestone Overview

| Milestone | Target Window | Theme | Primary Goals |
| :--- | :--- | :--- | :--- |
| **v0.1.0** | **Shipped (2026-08)** | Capsule Core & Verification | Deterministic ZIP format, Ed25519/JCS signing, TOFU trust, QuickJS sandbox, effect ports, hash-chained journal & replay, MCP 2026-07-28, MCP Apps, OTel tracing, Agent Plugins export. |
| **v0.2.0** | **Q4 2026** | Enterprise Trust & Native Host Sandboxing | WASI 0.3 component model guests, OS-level host sandboxing, Sigstore keyless signing, Streamable HTTP transport, MCP Tasks extension, desktop integration. |
| **v0.3.0** | **2027** | Distribution & Collaborative Ecosystem | Capsule Hub decentralized registry, browser-based Genesis Studio, vector capabilities (`sqlite-vec`), and multi-capsule pipelines. |

---

## 2. Shipped in v0.1 ("Capsule Core")

- [x] **Deterministic Container Format:** Single-file `.capsule` ZIP archives with sorted entries, normalized DOS timestamps, and strict path verification.
- [x] **Cryptographic Provenance:** In-toto attestation statements, RFC 8785 JSON Canonicalization (JCS), and Ed25519 signatures.
- [x] **Trust-on-First-Use (TOFU) Keystore:** Automatic key pinning, key drift detection, and tool catalog digest pinning.
- [x] **Zero-Ambient-Authority Sandbox:** QuickJS-in-Wasm execution with virtualized clocks (`Date`), deterministic random numbers (`Math.random`), memory caps, and CPU deadline interrupts.
- [x] **Quarantined Effect Ports:** Synchronous and asynchronous effect dispatches (`clock.now`, `random.bytes`, `sql.query`, `sql.exec`, `kv.get`, `kv.set`, `log.write`, `net.fetch`). `pack.write` is schema-declared in v0.1 — it is part of the manifest effect vocabulary and the capability/grant model — but no host port is wired, so dispatching it fails with `E_USAGE: pack.write is not available in this runtime`; the host-side implementation is targeted for v0.2 (see §3.8).
- [x] **Hash-Chained Journal & Deterministic Replay:** Append-only event history in `<capsule>.journal.sqlite` supporting strict replay, divergence detection, and audit trails.
- [x] **Model Context Protocol (MCP) `2026-07-28`:** Stateless JSON-RPC 2.0 transport over stdio, `server/discover`, caching metadata (`ttlMs`, `cacheScope`), and Model-Requested Tool Routing (MRTR) consent.
- [x] **MCP Apps UI Extension:** Interactive user interfaces served over loopback HTTP and MCP Apps (`io.modelcontextprotocol/ui`) with Content Security Policy enforcement.
- [x] **OpenTelemetry (OTel) Tracing:** Export OTLP trace spans for tool invocations and individual effect dispatches.
- [x] **Ecosystem Interoperability:** Agent Plugins 1.0.0 export (`plugin.json`, `mcp.json`, `SKILL.md`), guarded client configuration injection (`capsule inject`), and Windows file association handler.
- [x] **Comprehensive Conformance Suite:** 12 normative vectors (C01–C12) verifying format legality, cryptographic validity, determinism, and performance budgets.

---

## 3. v0.2 Milestone: Enterprise Trust & Native Host Hardening

### 3.1 WASI 0.3 Component Model Guests

- **Context & Evidence:** WASI 0.3.0 was ratified on 2026-06-11, making asynchronous I/O native to the Wasm Component Model and removing legacy `wasi:io`. Wasmtime 46 and `jco preview3-shim` now offer conformant component hosts.
- **Scope:** Introduce WebAssembly Component Model guests (compiled from Rust, Go, C, or TypeScript) running behind the identical effect ports and capability model as QuickJS guests.
- **Acceptance Criteria:** Component guests pass Conformance Vectors C01–C12 without altering the container manifest schema.

### 3.2 Host-Process OS Sandboxing

- **Context & Evidence:** In v0.1, the host process runs with the privileges of the calling user. Modern agent runners (Claude Code, Codex CLI) sandbox host processes at the OS level.
- **Scope:** Wrap the runtime in platform-native OS sandboxes:
  - **Linux:** Landlock LSM rules and `seccomp-bpf` syscall filters.
  - **macOS:** Seatbelt / App Sandbox profiles limiting file access strictly to `.tmp/` and `$CAPSULE_HOME`.
  - **Windows:** Restricted Access Tokens and AppContainer isolation.

### 3.3 Sigstore Keyless Signing & Transparency Logs

- **Context & Evidence:** Enterprise CI/CD pipelines use OIDC workload identities (GitHub Actions, GitLab CI) rather than long-lived private keys.
- **Scope:** Support Sigstore keyless signing (Fulcio root certificates) and Rekor transparency log inclusion proofs embedded in `statement.predicate`.

### 3.4 Streamable HTTP Transport & MCP Tasks Extension

- **Scope:**
  - Implement MCP `2026-07-28` Streamable HTTP transport with mandatory `Mcp-Method` and `Mcp-Name` routing headers.
  - Add OAuth 2.1 Authorization Code flow with PKCE for remote capsule invocation.
  - Implement `io.modelcontextprotocol/tasks` for asynchronous, long-running agent workflows.

### 3.5 Native Desktop Handlers for macOS & Linux

- **Scope:**
  - **macOS:** Generate signed `.app` bundle / LaunchServices plist registration for double-click opening into `capsule ui`.
  - **Linux:** Desktop entry (`.desktop`) and shared MIME database registration (`application/x-capsule`).

### 3.6 Host Vector Capabilities (`sqlite-vec`)

- **Scope:** Expose vector embeddings and semantic search as a host-provided capability rather than embedding platform-specific native binaries (`.so`, `.dylib`, `.dll`) inside the payload.

### 3.7 APE Single-File Executable Experiment

- **Scope:** Experimental tier for Actually Portable Executables (APE).
- **Strict Acceptance Gate:** Must survive Windows Defender cloud heuristics, macOS Gatekeeper notarization, and Linux execution on clean test VMs without false positives. If any scanner quarantines the binary, the feature will not ship to stable.

### 3.8 Host `pack.write` Effect Port

- **Context & Evidence:** v0.1 declares `pack.write` in the manifest effect vocabulary, the `capabilities.pack` flag, and the `pack` user grant, but wires no host port and exposes no guest binding, so a dispatch fails with `E_USAGE: pack.write is not available in this runtime`. Capsule building is CLI-only (`capsule pack`).
- **Scope:** Implement the host-side port so a granted capsule can build and sign a capsule from a directory, returning `{ file, capsuleId, bytes }`, with the written path confined to the invoking host's working directory.
- **Acceptance Criteria:** A capsule declaring `pack.write` produces a capsule that passes `capsule verify`, and the effect records and replays through the hash-chained journal like every other port.

---

## 4. v0.3 Milestone: Distribution & Collaborative Ecosystem

### 4.1 Genesis Studio & Visual Builder

- Browser-based WebAssembly development environment to build, test, sign, and inspect Agent Capsules without installing local toolchains.

### 4.2 Capsule Hub: Content-Addressed Registry

- Decentralized, content-addressed distribution protocol for discovering, downloading, and verifying signed capsules with cryptographic audit logs.

### 4.3 Multi-Capsule Composition & Orchestration

- Declarative composition pipelines allowing capsules to securely invoke sub-capsules within bounded capability envelopes.
