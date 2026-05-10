# MoneroUSD IDE — Changelog

The MoneroUSD IDE is shipped as a single web bundle reachable at three coherent
locations: `https://ide.monerousd.org` (clearnet), `http://localhost:27752/ide.monerousd.org/`
(wallet-bundled T1 mirror), and chain-anchored via `SITE_PUBLISH` (T2). All three
serve byte-identical bundles per IDE-11.

Versioning follows the wallet's release semver: each IDE release pins to the
wallet build that ships its T1 mirror, so the changelog is shared across both
shipments.

## v1.2.181 — Inaugural release

The IDE ships fully-functional from day one. No phasing, no follow-ups, no
"coming soon" pills. Every button you see in the chrome resolves to a real
implemented action.

### Editor

- Monaco editor vendored at `lib/monaco/`, web workers stubbed (no `'unsafe-eval'`
  needed; IDE-6).
- Custom DSOL language definition: keyword tokenizer, hover types from the
  latest AST, autocomplete seeded from stdlib symbols + project-local
  identifiers, red-squiggle diagnostics from the compiler's source map.
- Multi-file tabs with drag-to-rearrange, modified-dot indicator, inline rename
  via the file explorer.
- Auto-save to IndexedDB (debounced 500 ms); `localStorage` carries the current
  project pointer + open files.
- Keyboard shortcuts: `⌘S` save, `⌘B` toggle side panel, `⌘J` toggle terminal,
  `⌘↵` compile, `⌘⇧D` open Deploy activity, `⌘P` quick-open file, `⌘K`
  command palette.

### DSOL compile

- In-page invocation of the canonical 6-stage compiler at `lib/dsol-compiler.js`
  — byte-identical bytecode and `codeHash` to the wallet-bundled compiler and
  the CLI (IDE-5 parity test).
- Errors auto-surface as Monaco red squiggles + a Problems list in the side
  panel.
- ABI viewer in the plugin panel: entrypoint signatures, state-var declarations,
  event schemas — generated from compiler output.

### Run (local DarkVM)

- Browser-side DarkVM runs against an ephemeral in-memory state (`Map<projectId,
  vmState>`); state never persists to IndexedDB or `localStorage` (IDE-2).
- ABI-driven form per entrypoint; results show gas used, step count, emitted
  events, and a step-trace.
- VM module surface is hardcoded read-only — no host-injection parameter, no
  `eval`, no `Function` constructor (IDE-8).

### Deploy on-chain (centerpiece)

- Deploy button on the Compile activity invokes
  `window.monerousd.deployContract({bytecode, abi, codeHash})`.
- Wallet's existing `buildOpFields('DC_DEPLOY')` approval modal renders — same
  fields whether the call originates from the IDE, a remote dApp, or the
  browser extension (IDE-9 parity).
- Returns `{contractId, txHash}`; IDE polls `/v1/contracts/:contractId` per
  rule 17, with a tx-hash explorer fallback if polling times out.

### Call entrypoints

- Per-entrypoint Call form on the Deploy & Run activity → calls
  `window.monerousd.callContract({contractId, entrypoint, argv, mode})` for
  `commit`, `reveal`, or `direct`.
- Reads via `GET /v1/contracts/:contractId/state` show on the same panel.

### Site project mode

- Same three-pane shell with HTML/CSS/JS files (Monaco built-in languages).
- Live preview in a sandboxed `blob:` iframe (`sandbox="allow-scripts"` only —
  no `allow-same-origin`); same-origin asset references rewritten to blob URLs
  recursively for HTML and CSS (IDE-12).
- Publish button → `window.monerousd.publishSite({domain, bundle, version,
  contentType})` → wallet `buildOpFields('SITE_PUBLISH')` modal (SW-14, with
  reserve-contribution callout) → `SITE_PUBLISH` (`0x27`) on chain → bundle
  `POST` to indexer.
- Live fee preview as you edit: gzipped size × `computeSiteFee` (SW-18 parity
  with backend), plus the "100% routes to reserve" callout.

### Templates gallery

- DSOL: `Counter`, `TokenTransfer`, `ErcPrivate`, `NftCollection`, `Voting`,
  `Escrow` — sourced from the wallet's `dark-contracts/{examples,stdlib}/`.
- Sites: blank, single-page bio, blog, dApp shell (with a `window.monerousd`
  provider hook example).
- Click → opens detail modal with full source preview + tabs for multi-file
  templates → "Open in editor" creates a new project (or splats into the
  current empty project) and switches to the relevant activity.

### Reference panel

- Inline rendering of `LANGUAGE.md` (DSOL syntax/semantics), `PROTOCOL-DC-V1.md`
  (Dark Contracts ABI), `PROTOCOL-SITES-V1.md` (Sovereign Sites ABI), and this
  changelog.
- Auto-generated table of contents per doc, smooth-scroll on heading click.

### Settings

- Indexer URL override (default `https://ion.monerousd.org`) with a
  Test-connection button that hits `/v1/health`.
- Auto-compile toggle (default on).
- Editor font-size control.
- Persistent-storage permission status + estimated quota usage.
- "Erase all local IDE data" danger-zone button (deletes the IndexedDB +
  clears the `monerousd-ide.*` `localStorage` namespace).
- About panel: build version, origin, transport, sovereign anchor status
  (queries `/v1/sites/ide.monerousd.org` for the chain-anchored rootHash).

### Connection

- Top-bar Connect button + status-bar pill share a single `connectionState`
  store — the UI never shows "connected" while a CTA shows "Connect to deploy"
  (or vice-versa).
- Connect flow goes through `window.monerousd.connect()`. The IDE never holds
  keys, never signs locally, never speaks to wallet-rpc directly (IDE-1).
- When `window.monerousd` is absent (clean browser, no extension), editor +
  compile + local VM run all still work; Deploy/Call/Publish CTAs reflect the
  disconnected state inline.

### Approval-flow integration

- IDE-driven `DC_DEPLOY`, `DC_CALL_*`, and `SITE_PUBLISH` ops trigger the same
  approval modals as remote-dApp ops; field set is byte-identical (IDE-9
  parity test).
- No IDE-specific approval renderer in the wallet — the "what am I signing?"
  guarantee survives.

### Visual design

- Monero-orange palette (`#FF6600` accents on `#1a1a1a`/`#2a2a2a` surfaces),
  Inter for UI, JetBrains Mono for hashes/amounts/code, all vendored — no CDN
  runtime dependency.
- `prefers-reduced-motion: reduce` honored across animations.
- Lighthouse targets: Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 90.

### Sovereign Hosting backbone (folded in)

The IDE's Publish flow ships with the full Sovereign Hosting Phase 2 backbone
on the indexer side:

- `SITE_PUBLISH = 0x27`, `SITE_TRANSFER = 0x28`, `SITE_REVOKE = 0x29` opcodes
  registered in the attestation codec.
- `backend/sites/registry.js` HTTP endpoints: `/v1/sites`, `/v1/sites/:domain`,
  `/v1/sites/:domain/bundle`, `/v1/sites/stats`.
- `backend/sites/publisher.js` ingress at `POST /api/sites/:domain/bundle`,
  hash-verified per rule 12.
- `backend/sites/bundle-store.js` content-addressed disk cache, `ETag: <rootHash>`.
- `backend/sites/fee-curve.js` single-source fee computation, mirrored
  byte-identical at `monerousd-ide/lib/fee-curve.js` (SW-18).
- `backend/indexer/sites.js` pure `deriveSites(pool_events) → dark_sites`
  (SW-9 deterministic).
- `backend/fees/split.js` adds `'reserve'` destination — 100% of `SITE_*` fees
  route through `chargeBond(amount, 'reserve')` (SW-17).

### Wallet (`build-1261`)

- Sovereign-server on `127.0.0.1:27752` serves `sites/ide-monerousd-org/` as
  the IDE's T1 fallback (SW-3).
- `main.js` `publishSite` IPC handler routes through `walletBroadcast()` (rule
  1, SW-11, SW-12).
- `dapp-preload.js` exposes `publishSite` on `window.monerousd` for the IDE's
  webview origin and the localhost mirror.
- `CONNECT_ORIGINS` allowlist: `https://ide.monerousd.org` + `http://localhost:27752`.
- Launchpad: new verified IDE tile with the localhost-fallback wired in via
  rule 23.
- `dark-contracts/vm.js` mirrors the canonical backend VM (IDE-14).

### Browser extension (`monerousd-chrome`)

- `injected-provider.js` adds `publishSite` for SW-13 + IDE-13 parity.
- `manifest.json` `host_permissions` and `content_scripts.matches` extended for
  `https://ide.monerousd.org/*` and `http://localhost:27752/*`.

### Recursive bootstrap

The IDE's first chain-anchored publish is itself: once the wallet build with
the T1 mirror is OTA'd and the public DNS for `ide.monerousd.org` flips, the
team uses the IDE to broadcast its own `SITE_PUBLISH` for `ide.monerousd.org`,
proving the full publish flow + T1/T2/edge byte-equality + reserve increment
in a single dogfood action.

### Invariants

14 IDE invariants (IDE-1..IDE-14) plus 19 Sovereign Sites invariants
(SW-1..SW-19) — see the Reference panel's protocol docs for the full table.

### Tests

- Unit: compile-parity, lang-parity, vm-runner, vm-sandbox-escape,
  path-traversal, idb-projects, fee-curve-parity, sha256-parity.
- Static (CI grep + AST scans): no-cdn, no-unsafe-eval, vm-mirror-parity,
  compiler-mirror-parity, no-dead-buttons, clearnet-local-parity,
  approval-parity, origin-allowlist.
- Playwright e2e: connect-disconnect, compile-deploy-popup (**ship-day gate**),
  call-entrypoint-popup, publish-site-popup, local-vm-run, template-gallery,
  project-crud, keyboard-shortcuts, visual-regression, clearnet-local-parity.

### Known limitations

- Dark-mode-only theme at v1; light theme is intentionally out of scope.
- Mobile renders an "open on a desktop browser" splash — there's no realistic
  way to author Solidity-style code on a phone keyboard.
- Safari users without the wallet extension can still use the IDE inside the
  desktop wallet's launchpad (provider injects via `<webview>` preload
  regardless of browser).
