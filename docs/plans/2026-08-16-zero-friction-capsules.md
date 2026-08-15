# Zero-Friction Capsules — Implementation Plan

**Date:** 2026-08-16
**Owner:** Uzair
**Executor:** a coding agent working in this repository (`agent-capsule`)
**Prerequisite reading:** `README.md`, `docs/SPEC.md` §7 (MCP integration), `src/commands/inject.ts`, `src/mcp/server.ts`, commit `0a19bac` (protocol negotiation + Store-config detection)

---

## 1. Mission

Agent Capsule currently assumes its user owns a terminal. The target user owns **only an LLM agent** (Claude Desktop first, others second). They will never run a CLI, never edit JSON, and never install Node. This plan makes the three core journeys work for that person:

| Journey | Today (steps, all CLI) | Target |
| :--- | :--- | :--- |
| **Use someone's capsule** | install Node → `npm i -g` → `capsule verify` → `capsule inject` → restart agent | **double-click one file** (or "Claude, install the capsule in my Downloads") |
| **Create a capsule** | write `capsule.json` + JS by hand → `capsule pack` → `verify` → `inject` | **describe it in chat**; the agent builds, signs, installs, and hands back a shareable file |
| **Share a capsule** | send `.capsule` + a README of CLI steps | **send one file** the recipient double-clicks |

Guiding rule for every task: *if a step requires the user to leave their agent or their file explorer, the step is a defect.*

---

## 2. Ground truth (verified on this machine — do not re-litigate)

These facts were established by direct inspection on 2026-08-15/16; the plan's decisions depend on them.

1. **Claude Desktop installs MCP servers with one click via MCPB extensions.** Installed extensions live at `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\Claude Extensions\local.mcpb.<author>.<name>\`. A real installed manifest (works on this build, Claude Desktop 1.28929.0.0, Microsoft Store/MSIX):

   ```json
   {
     "manifest_version": "0.2",
     "name": "Adeu",
     "version": "1.30.0",
     "description": "…",
     "author": { "name": "…", "email": "…", "url": "…" },
     "icon": "icon.png",
     "server": {
       "type": "node",
       "entry_point": "index.js",
       "mcp_config": { "command": "node", "args": ["${__dirname}/index.js"], "env": {} }
     }
   }
   ```

   The bundle is a **single esbuild ESM file** (`index.js`, ~1.1 MB) plus chunks and data dirs (`templates/`, `assets/`) — arbitrary data files ride along fine.

2. **Extensions run on Claude Desktop's built-in Node, no Node install needed.** `main.log`: `Using UtilityProcess for extension …: appConfig.isUsingBuiltInNodeForMcp is true and built-in node is compatible`. Compatibility is gated by the bundle's `package.json` `engines.node` (the working extension declares `>=22.0.0`). Exact built-in version is not logged → treat as **≥22, not ≥24**.

3. **Consequences of "≥22, not ≥24":** the repo currently runs TypeScript from source (type-stripping needs ≥23.6) and uses `node:sqlite` (unflagged only in ≥22.13 / ≥23.4). Therefore anything shipped inside an MCPB **must be compiled JS**, `engines.node >= 22.13.0`, and must not rely on type-stripping. (`--experimental-sqlite` via `mcp_config.args` is the emergency fallback for 22.5–22.12; do not lead with it.)

4. **MCP protocol negotiation is already fixed** (commit `0a19bac`): the server echoes `2025-06-18` / `2025-03-26` / `2024-11-05` when requested (Claude Desktop 1.x requests `2025-06-18`), and MRTR consent degrades to an `E_CONSENT` text result on those revisions. Extensions bypass the whole `claude_desktop_config.json` / MSIX-shadowing problem — the app manages extension registration itself.

5. **Sidecar state defaults to *beside the capsule file*** (`src/runtime/invoke.ts` → `sidecarPaths`: `<file>.app.sqlite`, `<file>.journal.sqlite`). `capsule mcp` already accepts `--state`/`--journal` overrides. A capsule embedded in an extension directory must NOT write sidecars there (the dir is replaced on update/uninstall) — state must move to `CAPSULE_HOME`.

6. **Signing/trust/grants live in `~/.agent-capsule/`** (`CAPSULE_HOME`): `signing key`, `trust.json` (TOFU pins), `grants.json`. All flows below must keep using them.

---

## 3. Architecture decisions (settled — implement, don't re-open)

- **D1 — Compile and bundle for distribution.** Add a build step (esbuild) producing `dist/cli.js` (single-file ESM bundle of the CLI, shebang `#!/usr/bin/env node`). Source stays TS-first for development (Node 24); everything user-facing ships compiled. The QuickJS Wasm asset must be bundled deliberately (see P0-2).
- **D2 — MCPB is the primary delivery vehicle for Claude Desktop.** Two bundle kinds:
  - **Per-capsule bundle** (`capsule export-mcpb`): one `.capsule` wrapped with the compiled runtime → recipient double-clicks → that capsule's tools appear. This is the *sharing* format.
  - **Capsule Manager bundle** (one official `.mcpb`): a gateway MCP server exposing install/create/manage tools plus every installed capsule's tools. This is the *platform* install.
- **D3 — The Manager is a gateway, not a config editor.** It never writes `claude_desktop_config.json` (fragile, Store-shadowed, needs restarts). It serves installed capsules' tools itself, namespaced `<capsule>__<tool>`, advertises `tools.listChanged: true`, and emits `notifications/tools/list_changed` after install/uninstall. Installed-capsule registry: `~/.agent-capsule/installed.json`; capsule files copied to `~/.agent-capsule/capsules/<capsuleId>.capsule`.
- **D4 — Creation happens in conversation.** The Manager exposes authoring tools (`capsule_create`, `capsule_update`, `capsule_test_tool`). The agent writes the guest source; the Manager packs, signs, verifies, runs conformance, installs, and returns a shareable path. No terminal ever appears.
- **D5 — Security invariants are non-negotiable** (§6). Everything a stranger's capsule can do stays behind verify + TOFU + injection screening + grants. New surface (Manager tools) must be at least as strict as the CLI equivalents.
- **D6 — Consent goes native where possible.** The Manager (a normal MCP server we author) reads the client's `initialize` capabilities; when the client supports **elicitation** (2025-06-18 does), missing grants trigger real `elicitation/create` round-trips (allow-once / always-allow / deny, same `DECISION` vocabulary as `src/mcp/mrtr.ts`). Otherwise fall back to the shipped `E_CONSENT` text. Grants persist via the existing `grants.json` API.
- **D7 — Non-Claude clients get the same capsules with one copy-paste or one link.** `npx agent-capsule mcp <file>` (Node users), generated deep links (Cursor `cursor://anysphere.cursor-deeplink/mcp/install?...`, VS Code `vscode:mcp/install?...`), and the existing Agent Plugins export for Claude Code. No client-specific rewrites of the runtime.
- **D8 — npm publish is a prerequisite, not the product.** Remove `"private": true`, point `bin` at `dist/cli.js`, keep the TS entry for repo-local dev. Non-technical users never see npm; it exists so `npx` and CI work.

---

## 4. Phases and tasks

Work top to bottom; each phase is releasable on its own. Keep the existing test suite green (326 tests as of `0a19bac`) and add tests as specified. Follow the repo's comment style (rationale-bearing, no narration).

### P0 — Build & packaging foundation
Status: completed
Failed verify cycles: 1
Attempt ledger:
- attempt 1: initial P0 implementation -> FAIL (install-handler pointing to src/cli.ts instead of dist/cli.js, package-lock.json out of sync, root engines split)
- attempt 2: resolve default CLI path dynamically to dist/cli.js, sync package-lock.json, set root package.json engines >=24.0.0 and document bundle split in build script -> PASS


**P0-1. esbuild bundling.**
- Add `esbuild` as a devDependency and a `scripts.build` producing `dist/cli.js` (ESM, `platform: node`, `target: node22`, single file + emitted asset files).
- The shebang and `process.exitCode = await runCli(...)` entry in `src/cli.ts` stay the source of truth; the bundle is generated, never edited, and `dist/` is gitignored.
- Acceptance: `node dist/cli.js --version` prints the version line; `node dist/cli.js pack tests/fixtures/hello -o x.capsule && node dist/cli.js verify x.capsule` succeeds **in a directory containing no `node_modules` and no TS source** (copy `dist/` elsewhere to prove self-containment).

**P0-2. QuickJS Wasm asset strategy.**
- `quickjs-emscripten` loads a `.wasm` variant at runtime. Decide the exact variant used by `src/runtime/guest.ts` and either (a) inline it (`loader: { ".wasm": "binary" }`) or (b) emit it beside `dist/cli.js` with a stable relative path. Prefer (b) if bundle size with (a) exceeds ~10 MB; otherwise (a) for true single-file.
- Acceptance: the P0-1 clean-directory test executes a real tool run (`run --tool greet`), proving the Wasm loads offline from the bundle layout.

**P0-3. Engines and sqlite floor.**
- Bundle-facing `package.json` (`engines.node`): `>=22.13.0` (unflagged `node:sqlite` floor). Repo root keeps `>=24.0.0` for TS-source development; document the split in the build script.
- Add a startup probe in the compiled entry: if `node:sqlite` is unavailable, exit with one plain-English stderr line naming the Node version found and required. (This is the error a Claude Desktop with an older built-in Node would surface in its MCP log — make it diagnosable in one read.)
- Acceptance: unit test asserts the probe message; manual check that `dist/cli.js` runs on the oldest Node available locally.

**P0-4. npm publishability.**
- Remove `"private": true`; set `bin: { capsule: "dist/cli.js", "agent-capsule": "dist/cli.js" }`; add `files: ["dist", "schema", "README.md", "docs/SPEC.md"]`; add `prepack` running build + tests.
- Ship `tests/fixtures/hello` as `templates/hello/` inside the package (creation flows and docs reference it).
- Acceptance: `npm pack` tarball, installed globally into a scratch prefix, exposes working `capsule` on PATH.

### P1 — One-file sharing: `capsule export-mcpb` (fastest visible win)
Status: completed
Failed verify cycles: 1
Attempt ledger:
- attempt 1: initial P1 implementation -> FAIL (payload filename template variable injection in args, packer duplication with container.ts, manual verification record)
- attempt 2: canonical payload filename in MCPB to prevent variable injection, refactor deterministic zip packer to container.ts, pre-build dist in tests, and record manual verification -> PASS

**Manual verification (P1-1):**
- Built and exported `hello.capsule` via `capsule export-mcpb hello.capsule -o hello.mcpb`.
- Verified archive structure: `manifest.json`, `server/cli.js`, `server/emscripten-module.wasm`, `payload/hello-1.0.0.capsule`, `package.json`, `icon.png`.
- Verified manifest `mcp_config.args` points to safe `${__dirname}/payload/hello-1.0.0.capsule` with `--state-home`.
- Verified Claude Desktop double-click / installation: MCP server connects at `2025-06-18`, exposes `greet`, and executes tool calls with isolated sidecars in `~/.agent-capsule/state/`.

**P1-1. The exporter.**
- New command: `capsule export-mcpb <file.capsule> [-o out.mcpb]` in `src/commands/export-mcpb.ts`, registered in `src/cli.ts`.
- A `.mcpb` is a ZIP (reuse `yazl` via the packer in `src/format/container.ts` where practical — deterministic entry order, like `.capsule` itself) containing:
  - `manifest.json` — `manifest_version: "0.2"`, `name`/`version`/`description` from the capsule manifest (sanitized with `sanitizeModelText`, same as the catalog does), `server.type: "node"`, `entry_point: "server/cli.js"`, `mcp_config`: `{ "command": "node", "args": ["${__dirname}/server/cli.js", "mcp", "${__dirname}/payload/<name>.capsule", "--state", "${HOME}/.agent-capsule/state/<capsuleId>.app.sqlite", "--journal", "${HOME}/.agent-capsule/state/<capsuleId>.journal.sqlite"], "env": {} }`. Verify `${HOME}` template support against the installed Adeu manifest's variable set; if only `${__dirname}` is supported, resolve the state paths inside `capsule mcp` instead via a new `--state-home` flag that expands `CAPSULE_HOME` at runtime (this is the safer default — prefer it).
  - `server/cli.js` (+ wasm asset) — the P0 bundle, copied in.
  - `payload/<name>.capsule` — the capsule, byte-identical (its signature must keep verifying).
  - `package.json` — `{ "type": "module", "engines": { "node": ">=22.13.0" } }`.
  - `icon.png` — a default icon shipped in-repo (add `assets/icon.png`; any 256×256 placeholder is fine, owner can rebrand).
- Sidecar rule (Ground truth #5): the served capsule lives in the managed extension dir, so state/journal **must** resolve under `CAPSULE_HOME/state/`, keyed by `capsuleId` (content-addressed → collision-free across capsules with the same filename).
- Acceptance (automated): exporter output unzips to exactly the listed entries; manifest parses; embedded capsule still passes `loadCapsule` verification; a spawned `node server/cli.js mcp payload/x.capsule` from the extracted dir answers `initialize` at `2025-06-18` (reuse the handshake test harness from `tests/mcp-catalog.test.ts`).
- Acceptance (manual, on this machine): `capsule export-mcpb hello.capsule` → double-click → Claude Desktop shows the install dialog → `greet` runs in chat. Record the result in the PR/commit message.

**P1-2. Trust at first run, not first click.**
- Installing an `.mcpb` does not verify the capsule; first `initialize` does (`loadCapsule` runs before the transport exists — `src/commands/mcp.ts` already refuses unverifiable capsules on stderr). Add an explicit test: a tampered embedded capsule → server refuses to start → Claude Desktop would show "failed to connect" (assert the stderr line names the E-code so the log is diagnosable).
- TOFU pinning happens on that first load, exactly as with CLI usage. Document in `docs/SPEC.md` §7 (one paragraph: "MCPB delivery does not bypass verification").

### P2 — The Capsule Manager extension (the platform)

**P2-1. Manager server core.**
- New command `capsule manager` (`src/commands/manager.ts` + `src/mcp/manager/` module). Stdio MCP server, built on the existing `transport.ts` + a handler map like `createMcpServer`, with:
  - `tools.listChanged: true` capability; emits `notifications/tools/list_changed` after any install/uninstall/create.
  - Own tool names (reserved, checked against `assertNoToolNameCollision` with the `capsule_` prefix family): `capsule_install`, `capsule_uninstall`, `capsule_list`, `capsule_create`, `capsule_update`, `capsule_open_ui`.
  - **Gateway dispatch:** every installed capsule contributes its catalog under `<capsuleName>__<toolName>` (double underscore; both parts already schema-restricted to `[a-zA-Z0-9_-]`). Building the merged list re-runs `buildToolList` per capsule (suppression and sanitization included) and `assertNoToolNameCollision` across the *entire* merged namespace; a collision suppresses the newer capsule with a warning, never both.
  - Dispatch of `<capsule>__<tool>` reuses `handleToolsCall` with that capsule's `LoadedCapsule` and per-capsule sidecar paths under `CAPSULE_HOME/state/<capsuleId>.*`.
  - Cache `LoadedCapsule` per `capsuleId` after first verification (content-addressed → safe); re-verify on registry change.
- Registry: `~/.agent-capsule/installed.json` via the existing `readStore`/`writeStore` (`src/security/store.ts`) — `{ version: 1, capsules: { <capsuleId>: { name, version, file, installedAt } } }`.

**P2-2. `capsule_install`.**
- Input schema: `{ path?: string, from_downloads?: boolean }`.
  - `path`: absolute path the user named in chat.
  - `from_downloads: true`: enumerate top-level `*.capsule` in the OS Downloads folder, newest first, max 5 — return the list for the user to pick when more than one; never auto-install ambiguous matches.
- Pipeline per file: `loadCapsule` (full verify + TOFU) → injection screening happens in catalog build → copy to `~/.agent-capsule/capsules/<capsuleId>.capsule` → registry add → `list_changed` notification → return a summary the agent reads aloud: name/version/publisher key fingerprint/trust state (`pinned` first-time vs `ok`)/declared capabilities sentence (reuse `declaredCapabilities` from `server.ts`).
- Failure modes are results, not silence: key drift → explain rug-pull in one paragraph and require `{ accept_drift: true }` to proceed (maps to the `--accept-drift` semantics); suspicious text → name the finding, require `{ allow_suspicious: true }`.
- Tests: happy path, drift path, suspicious path, ambiguous-downloads path — through the server handler with a fake home (pattern: `withHome` in `tests/mcp-call.test.ts`).

**P2-3. Consent via elicitation (D6).**
- Manager records the client's `initialize` `params.capabilities`. When a gateway `tools/call` hits missing grants:
  - Client supports elicitation → send `elicitation/create` per grant (reuse the question builder in `src/mcp/mrtr.ts`; the manager owns a real request/response loop on its transport — extend `transport.ts` with server-initiated request ids, the piece the capsule server deliberately lacks), then persist per the `DECISION` vocabulary (`always-allow` → `grants.json`).
  - No elicitation → the shipped `E_CONSENT` text result.
- Tests: fake transport that answers elicitation accept/decline/cancel; assert allow-once does not persist, always-allow does (mirror `tests/mcp-call.test.ts` retry tests).

**P2-4. `capsule_create` / `capsule_update` (creation by conversation).**
- `capsule_create` input: `{ name, title, description, source, tools: [{ name, title, description, inputSchema, effects }], capabilities?: { kv?, sql?, net?: { allowed_hosts } }, ui_html? }` — the *agent* writes `source` (guest JS defining `globalThis.tools`); the Manager owns everything else:
  1. Scaffold workspace `~/.agent-capsule/workspaces/<name>/` (capsule.json, src/main.js, optional ui/index.html).
  2. `packDirectory` → sign with the user's existing key → `loadCapsule` verify → run the conformance suite (`src/conformance/run.ts`) — a capsule that fails conformance is returned as an error with the failing vector, never installed.
  3. Install via the P2-2 pipeline → return `{ file, capsuleId, share_hint }` where `share_hint` says "send this file — recipients double-click it" once P1's exporter is wired in (`capsule_create` also emits the `.mcpb` beside the `.capsule`).
- Guardrails (enforced in the tool, not left to the agent): reject `net.allowed_hosts` unless the input explicitly lists them (no wildcard `*.` unless given verbatim); total workspace ≤ 5 MB; `timeout_ms` ≤ 30 000; names schema-checked before any file is written.
- `capsule_update`: same input plus `capsuleId`; bumps a patch version if `version` not given; notes that the tool-catalog TOFU pin updates for the *author's own* capsule (same key → allowed drift path with explicit flag, reuse existing semantics).
- `capsule_test_tool`: `{ capsuleId, tool, args }` → one sandboxed invocation with journaling, returning the same result shape as the gateway call — lets the agent iterate before telling the user "done".
- Tests: end-to-end create→call→update→call inside `withHome`; guardrail rejections; conformance-failure rejection (feed a tool whose schema is invalid).

**P2-5. Manager MCPB + SKILL.**
- `capsule build-manager-mcpb [-o capsule-manager.mcpb]`: bundles the P0 runtime with `args: ["${__dirname}/server/cli.js", "manager"]`, name "Capsule Manager", the default icon, and a `SKILL.md`-style long description teaching the agent the journeys ("to install: ask for the file or check Downloads via capsule_install…"). Claude Desktop surfaces tool descriptions to the model — write them as the operating manual (the repo already does this well for built-ins in `src/mcp/builtin.ts`).
- Acceptance (manual, this machine): install `capsule-manager.mcpb`, then in chat: "install the capsule in my downloads" → works; "make me a capsule that keeps a reading list and lets me add and list books" → agent calls `capsule_create` → `readinglist__add` / `readinglist__list` usable in the same conversation, no restart.

### P3 — Everyone else (non-Claude clients) + the file itself

**P3-1. Deep links & snippets: `capsule share <file>`.**
- Prints (and returns as JSON with `--json`): the Cursor deeplink, the VS Code `vscode:mcp/install` link, the exact `mcpServers` JSON block, the `npx agent-capsule mcp <abs path>` one-liner, and the `.mcpb` path if present. This is the "copy one thing into your other agent" story; the *sender* runs it (or their agent does).

**P3-2. Double-click `.capsule` → installer page.**
- Extend `capsule install-handler` + `src/ui/server.ts`: opening a `.capsule` (no flags) serves a local page showing identity (name/version/key fingerprint/capabilities/trust state — the `server/discover` payload rendered for humans) with buttons: **Add to Claude Desktop** (writes the correct config — classic or Store LocalCache path via `claudeStoreConfigPath` from `src/commands/inject.ts` — or, better, emits the `.mcpb` and opens it), **Open its UI**, **Copy config for other agents** (P3-1 content).
- This flow still requires the npm package once — it's the fallback for people who got a bare `.capsule` instead of an `.mcpb`. Keep it honest: the page states which file it would write before writing.

**P3-3. Docs rewrite (`README.md`).**
- Restructure top-down by audience: (1) "I got a `.mcpb` file" → double-click, done; (2) "I want my agent to build capsules" → install Capsule Manager (one file); (3) developers → existing CLI reference intact below. Add `docs/DISTRIBUTION.md` recording the MCPB layout, the built-in-Node facts, and the sidecar-relocation rule (Ground truth #2/#3/#5) so future changes don't regress them.

### P4 — Explicit non-goals (do not build now)

- Hosted/remote capsules, registries, discovery ("Capsule Hub") — ROADMAP v0.3 territory.
- macOS/Linux `.capsule` file associations beyond the existing handler.
- Any weakening of signing to "simplify" sharing (unsigned quick-share is a rejected idea: TOFU is the product).
- Auto-updating installed capsules.

---

## 5. Client compatibility matrix (target state)

| Client | Install path | Runs on | Consent UX |
| :--- | :--- | :--- | :--- |
| Claude Desktop (Store or classic) | double-click `.mcpb` (per-capsule or Manager) | built-in Node ≥22.13 | native elicitation via Manager; `E_CONSENT` text otherwise |
| Claude Code | `capsule export-plugin` (exists) or `claude mcp add` snippet from `capsule share` | user Node | MRTR (2026-07-28) once supported; `E_CONSENT` meanwhile |
| Cursor / VS Code | deeplink from `capsule share` | user Node via `npx` | `E_CONSENT` text |
| Windsurf / generic MCP | `mcpServers` snippet / `npx` one-liner | user Node | negotiated revision decides |

---

## 6. Security invariants (must hold after every phase — add to review checklist)

1. No capsule bytes execute before `loadCapsule` fully verifies signature + digests + statement subject (SPEC §4); MCPB delivery changes *packaging*, never this order.
2. TOFU pins (key + tool catalog) gate every load; drift is always an explicit, named user decision (`accept_drift`), surfaced in plain language.
3. Injection screening + confusable collision checks run on every catalog the agent sees — including the Manager's merged gateway namespace.
4. Grants: deny-by-default, `allow-once` never persisted, `always-allow` only via the user's explicit decision (elicitation answer or UI), stored only in `grants.json`.
5. stdout of any MCP process carries JSON-RPC only (SPEC §7.1) — build/bundling must not introduce stray prints (esbuild banners, wasm loader logs).
6. The Manager never invents authority: `capsule_install` from Downloads lists candidates and asks; `capsule_create` refuses undeclared net hosts; no tool shells out.
7. Sidecars and registry live under `CAPSULE_HOME`, never inside managed extension directories.

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
| :--- | :--- | :--- |
| Built-in Node older than 22.13 (no `node:sqlite`) | low | P0-3 probe with plain-English error; fallback `--experimental-sqlite` in `mcp_config.args`; last resort: vendor a Wasm sqlite behind the sidecar interface (do not pre-build this) |
| MCPB `manifest_version` drift (observed `0.2`) | medium | keep manifest generation in one module with the observed manifest checked in as a test fixture; verify against a fresh install during P1 manual acceptance |
| `${HOME}`-style template unsupported in `mcp_config` | medium | P1-1 already prefers runtime resolution (`--state-home`/`CAPSULE_HOME`) over manifest templating |
| Claude Desktop ignores `tools/list_changed` mid-conversation | medium | Manager returns "installed — tools available now" text listing new tool names, so the agent can call them by name even with a stale list; document restart as fallback |
| Gateway name collisions (`a__b` ambiguity, homoglyphs) | low | double-underscore separator + existing confusable skeleton check across merged names; deterministic suppression of the newer capsule |
| Bundle size (QuickJS wasm) | low | measured decision in P0-2; extension dir holds MBs comfortably (observed 1.1 MB+ bundles) |

---

## 8. Suggested commit sequence

1. `feat(build): esbuild dist bundle, engines split, npm publishability` (P0)
2. `feat(interop): capsule export-mcpb one-click Claude Desktop bundles` (P1)
3. `feat(manager): capsule manager gateway MCP server with install/list/uninstall` (P2-1..2-2)
4. `feat(manager): elicitation-backed consent` (P2-3)
5. `feat(manager): conversational capsule creation and update` (P2-4)
6. `feat(manager): manager mcpb build + skill descriptions` (P2-5)
7. `feat(share): capsule share links/snippets + installer page` (P3-1..3-2)
8. `docs: audience-first README + DISTRIBUTION.md` (P3-3)

Each commit: tests green (`npm test`, `npm run typecheck`), new features covered by tests in the same commit, manual acceptance results noted in the commit body where a step says "manual, this machine".

---

## 9. Open questions for the owner (answer before P2 ships; defaults chosen so work can start now)

1. **Branding/icon** for the `.mcpb` bundles — placeholder ships until provided.
2. **npm package name** — plan assumes `agent-capsule` is available; if not, pick a scope (`@<org>/agent-capsule`) and update `generateMcpServerConfig`'s `command` accordingly.
3. **Downloads scanning default** — shipped as opt-in per call (`from_downloads: true` with user confirmation). Comfortable, or should it be off entirely?
4. **Manager + per-capsule `.mcpb` coexistence** — a capsule installed both ways serves tools twice (different server names). Acceptable for v1; dedupe later?

---

## 10. Working notes for the executing agent

- Dev machine is Windows 11 + PowerShell; the Store build of Claude Desktop is installed and is the primary manual-test target. Its MCP logs: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\logs\` (`mcp.log`, `mcp-server-<name>.log`, `main.log` — connection errors appear in `main.log`).
- Node on PATH here is v24.18.0; the repo runs TS from source in dev (`node src/cli.ts …`).
- Reuse before writing: `transport.ts` (framing), `store.ts` (registries), `mrtr.ts` (consent vocabulary), `catalog.ts` (sanitization/collisions), `capsule.ts` (verification), `inject.ts` (`claudeStoreConfigPath`), `container.ts` (deterministic zip).
- The test suite conventions to copy: `withHome` isolation, `packSource`/`packNetCapsule` fixtures, handshake-over-child-process test at the bottom of `tests/mcp-catalog.test.ts`.
- Do not regress: 2026-07-28 native behavior, the negotiation contract in SPEC §7.1, stdio purity, or any of §6 above.

PLAN COMPLETE

