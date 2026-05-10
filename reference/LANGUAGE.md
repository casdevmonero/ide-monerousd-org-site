# DarkSolidity (DSOL) — language reference

DarkSolidity is a privacy-native smart-contract language for
MoneroUSD. If you can write Solidity, you can write DSOL. The two big
differences:

1. **`private` state is committed, not public.** A `private uint64`
   field is stored on-chain as a Pedersen commitment; the blinding
   factor lives in the user's wallet. Reading a private value requires
   an explicit `when revealed` return, which opens the commitment to
   the caller's viewkey.

2. **`@batch` entrypoints go through commit-reveal**, so public-mempool
   front-running is impossible. You broadcast a `commitHash` in block
   N, then reveal the args in block N+2. Anyone who tries to copy your
   tx between commit and reveal has no idea what entrypoint or args
   you committed to.

## File structure

```dsol
dark contract <Name> {
  // state vars — public or private
  // constructor — runs at DC_DEPLOY time
  // entry fns — invoked via DC_CALL attestations
  // event decls — for the explorer + off-chain watchers
}
```

## Types

| Type | Meaning |
|------|---------|
| `uint64` | 64-bit unsigned integer, wraps on overflow. MoneroUSD's canonical atomic unit. |
| `bool` | Compiles to u64 `0` / `1`. |
| `string` | UTF-8, bounded to 4096 bytes. |
| `bytes` | Raw bytes, bounded to 4096 bytes. |
| `stealth` | MoneroUSD stealth address / subaddress. |
| `mapping(K => V)` | Sparse map; `K` must be `stealth`, `uint64`, or `bytes`. |

Not supported in Phase 1: `int64`, `uint256`, floating point,
dynamic arrays.

## Privacy annotations

- `private <type> <name>;` — state is stored committed; arithmetic on
  it must go through commit-open macros (Phase 2).
- `public <type> <name>;` — state is plain; readable via
  `/v1/contracts/:id`.
- `returns (<type> when revealed)` — the return value is opened to
  the caller's viewkey with a Bulletproofs+ range proof attached.
- `emit encrypted <EventName>(...)` — event payload is AES-GCM wrapped
  to the caller's viewkey. Non-encrypted `emit` is forbidden when a
  referenced arg is a private state var.

## Entrypoints

- `constructor(args) { … }` — runs once at `DC_DEPLOY`. State writes
  are allowed without commit-reveal.
- `entry <name>(args) { … }` — default is `@batch` if any private
  state is written, `@direct` otherwise.
- `@batch` — commit + reveal across two blocks. Front-run-proof.
- `@direct` — one-shot call. Can only read public state or private
  state's commitment (never open plaintext).
- `@highrisk` — forces the wallet approval modal to ask for a second
  confirmation click.

## Control flow

```dsol
if (cond) { ... } else { ... }
require(cond, "MESSAGE");
emit Transferred(to);
syscall(TOKEN_TRANSFER_EMIT_V1, msg.sender);
return value;
```

Phase 1 does not allow user-defined loops. Add them via
compile-time-bounded `for` once Phase 2 lands.

## Syscalls (allowlist)

These are the only ways to touch the outside world:

| Symbol | Effect |
|--------|--------|
| `TOKEN_TRANSFER_EMIT_V1` | Emit a `token_transfer` pool_event — same as the hardcoded OP. |
| `TOKEN_MINT_SUPPLY_V1` | Emit a supply-mint for a token you created. |
| `LP_MINT_V1`, `LP_BURN_V1` | Forward liquidity intent into the AMM. |
| `BRIDGE_UNWRAP_EMIT_V1` | Queue a bridge unwrap (home-chain withdrawal). |
| `NFT_MINT_V1`, `NFT_TRANSFER_V1` | NFT creation + transfer ops. |
| `READ_BALANCE_V1` | Returns a balance commitment hash (not plaintext — DC-6). |
| `READ_BLOCK_V1` | Returns the current block number. |
| `EXT_CALL_TAIL_V1` | Tail-call another dark contract's `@direct` entry. Shares step budget; reentrancy blocked. |

Calling an unknown or unwired syscall aborts with `SYSCALL_UNKNOWN` /
`UNWIRED_PHASE_3`. The caller's state is rolled back; the carrier tx
fee is consumed (anti-spam).

## Security invariants (DC-1 … DC-15)

See [`ion-monerousd-org/CLAUDE.md`](../../ion-monerousd-org/CLAUDE.md).
Every DSOL program is subject to these — they're non-negotiable,
enforced by the VM runtime, attestation dispatcher, or indexer.

## Bond + fees

- Deployment: flat 10 USDm bond (non-refundable).
- Per-call: a 0.1 USDm anti-spam fee (goes to reserves).
- Home-chain network fees on any syscall that touches the bridge.

## Compile

```bash
dsolc compile MyContract.dsol --out-dir=./build
```

Emits `MyContract.dc` (binary bytecode), `MyContract.dc.b64` (the
base64 blob that goes into `DC_DEPLOY` attestation payload), and
`MyContract.abi.json`.

## Deploy + call (wallet flow)

1. Wallet → **Deploy Dark Contract** → selects `.dc` + `abi.json`,
   approves bond, broadcasts `DC_DEPLOY`.
2. Explorer → `/contract/dc1_<id>` shows contract metadata + public
   state.
3. Another wallet → **Call Dark Contract** → picks an entrypoint,
   fills args (ABI-decoded), approves. Wallet broadcasts either
   `DC_CALL_DIRECT` (read-only) or `DC_CALL_COMMIT` + `DC_CALL_REVEAL`
   (state-mutating `@batch` entries).

## Phase-2 capabilities (shipped in v1.2.147)

Everything below now works end-to-end — compilation, bytecode
emission, VM execution, determinism verified across replays:

- **Local frames.** `let` declarations and named parameters
  resolve to local-slot indices via `ALLOC_LOCALS` + `LOCAL_GET/SET`.
- **Mapping read + write.** `balances[msg.sender]`, `balances[to] +=
  amount`, and all other mapping patterns lower to `MAP_LOAD` /
  `MAP_STORE` / `MAP_STORE_PRIV` with SHA256-keyed slot derivation.
- **Full expression evaluation.** Arithmetic (`+`, `-`, `*`, `/`,
  `%`), comparison (`<`, `<=`, `>`, `>=`, `==`, `!=`), logical
  (`&&`, `||`, `!`), mapping lookups, context accessors, unary
  negation, nested calls — all compile.
- **Bytes ↔ u64 coercion.** Type-driven insertion of
  `U64_FROM_BYTES` / `U64_TO_BYTES` so state vars typed `uint64`
  round-trip through byte storage cleanly.
- **Polymorphic equality.** `==` / `!=` work on both u64 and bytes
  (stealth comparison in `msg.sender == owner`).
- **Typed state.** `uint8`, `uint64`, `bool`, `string`, `bytes`,
  `stealth`, plus public/private mappings of those.
- **Op-assign.** `+=`, `-=`, `*=`, `/=` on locals AND mapping slots.
- **Private mapping values stored as commitments.** `SSTORE_PRIV`
  / `MAP_STORE_PRIV` sets `is_private=1` so `/v1/contracts/:id`
  returns only the commitment hex — never plaintext (DC-6).
- **Local simulator.** `dsolc simulate <file.dsol> <entry> [argv]`
  runs the bytecode through the JS DarkVM with an in-memory store —
  no backend, no wallet, no network.
- **Stdlib contracts.** `Ownable`, `Erc20Private`, `NftCollection`,
  `ReentrancyGuard` — all in `build-1261/dark-contracts/stdlib/`.
- **Phase-2 syscalls wired.** `LP_MINT_V1`, `LP_BURN_V1`,
  `NFT_MINT_V1`, `NFT_TRANSFER_V1`, `BRIDGE_UNWRAP_EMIT_V1`,
  `TOKEN_MINT_SUPPLY_V1` all emit `dc_*_request` pool_events the
  indexer can hoist into the full hardcoded handler later
  (versioned; Phase-3 wires the event consumer without changing
  DSOL-level semantics).

## Phase-3 capabilities (shipped in v1.2.148)

Everything below now works end-to-end — compilation, bytecode
emission, VM execution, and replay-determinism verified:

- **Real Pedersen commitments** over ed25519 via `@noble/curves`.
  `H = G × HKDF("DC-PEDERSEN-H-v1")` is a nothing-up-my-sleeve
  generator. `COMMIT_U64` opcode emits 32-byte compressed points;
  two commits to the same value reuse the same blinding and are
  byte-identical (additive homomorphism verified in tests).
- **AES-256-GCM encrypted events**. `emit encrypted EventName(...)`
  lowers to `REVEAL` / HKDF-derived key + ciphertext + tag bound to
  `(callerViewkeyHash, contractId, eventName)`. Decryption on a
  wrong viewkey or mismatched context fails closed.
- **Inheritance**. `dark contract Child is A, B, C { ... }`
  linearizes parents left-to-right (Solidity-style) and flattens
  into a single AST before typecheck + codegen. Child declarations
  override parents by name (last-writer-wins); constructor bodies
  concatenate parent-first so each parent's `_a = ...` runs before
  the child's `_a += 1`. Merged constructor params are the
  concatenation of parent ctors' param lists.
- **Modifiers**. Top-level `modifier foo(params) { body }` + per-
  entry modifier invocations (`entry transfer(...) onlyOwner,
  whenNotPaused { ... }`). At codegen, each modifier's body is
  inlined at the callsite; the modifier's `_;` placeholder expands
  to the original entry body. Modifier params bind as locals (with
  a `__m_<name>` rename so they don't shadow the entry's own
  params), and the inlined body runs its `require(...)` gates
  BEFORE the entry's body executes.
- **Inter-contract tail calls** via `syscall(EXT_CALL_TAIL_V1,
  {contractId, entrypoint, args})`. Callee shares the parent's
  remaining step budget (DC-2) so a deep chain cannot exceed the
  top-level 1M cap. Reentrancy blocked by an in-flight contract-
  id Set + hard depth cap of 4 — A→B→A aborts with `DC_REENTRANT`
  before any frame re-enters. `@batch` entries are not tail-call
  targets (`DC_EXTCALL_NOT_DIRECT`) so the privacy contract of the
  ORIGINAL caller's commit-reveal is never circumvented by
  cross-contract dispatch.
- **Stdlib additions**: `Pausable.dsol` (is Ownable; `whenNotPaused`
  / `whenPaused` modifiers; owner-gated `pause()` / `unpause()`)
  and `PausableToken.dsol` (`is Erc20Private, Pausable` — multi-
  parent flattening exercise; overrides `transfer()` with
  `whenNotPaused` gate).
- **Source-mapped AST nodes**. Parser now stamps `line` + `col`
  on every node; compiler emits a `pcToLineCol` side-band in the
  ABI artifact so reverts can show `file:line:col` on the wallet /
  explorer side.

## Phase-3 syntax additions

### `is <Parent1>, <Parent2>, ...`

```dsol
dark contract PausableToken is Erc20Private, Pausable {
  @batch
  entry transfer(stealth to, uint64 amount) whenNotPaused {
    // inherits balances + totalSupply from Erc20Private
    // inherits paused + owner from Pausable
    require(amount > 0, "AMOUNT_ZERO");
    balances[msg.sender] -= amount;
    balances[to] += amount;
    emit Transferred(msg.sender, to);
  }
}
```

Linearization is strictly left-to-right: `is A, B` runs A's
constructor body before B's, and A's entry overrides show up before
B's in the merged table. Re-declaring an inherited entry in the
child wins.

### `modifier foo(args) { ... _; ... }`

```dsol
modifier onlyOwner() {
  require(msg.sender == owner, "NOT_OWNER");
  _;
}

modifier atLeast(uint64 threshold) {
  require(count >= threshold, "LOW");
  _;
}

@direct
entry mint(uint64 n) onlyOwner, atLeast(100) {
  // executes ONLY if msg.sender == owner AND count >= 100.
  // count >= 100 is evaluated at modifier-inline time with
  // threshold bound to the literal 100.
  totalSupply += n;
}
```

Modifiers always run in the order declared. `_;` is the escape
hatch that re-inserts the entry body — put it at the end for a
pure pre-condition gate, earlier for before/after wrapping.

### `syscall(EXT_CALL_TAIL_V1, argv)`

```dsol
// A contract that forwards every call to a proxied implementation.
dark contract Forwarder {
  public bytes implementationContractId;   // ion_* id encoded

  @direct
  entry call(bytes entrypoint, bytes argv) returns (bytes) {
    return syscall(EXT_CALL_TAIL_V1, {
      contractId: implementationContractId,
      entrypoint: entrypoint,
      args: argv,   // already JSON-encoded by the caller
    });
  }
}
```

The callee's return bytes pass straight through as the syscall's
result — immediately `return` them for a genuine tail call (no
frame remains on the caller's stack, no reentrancy window).

## Phase-4 roadmap (additive, not blocking)

- **Bulletproofs+ range proofs** replacing the 64-byte attestation
  placeholder in `RANGEPROOF`. Wire shape is already fixed
  (32-byte commit + 64-byte proof) so the swap is drop-in.
- **First-class `callTail` keyword** in DSOL, replacing the
  `syscall(EXT_CALL_TAIL_V1, ...)` ceremony with one opcode-backed
  form. The dedicated `OP.EXT_CALL_TAIL = 0xab` opcode is already
  reserved in `vm.js`.
- **Proxy pattern** for contract upgrades — a nullifier-gated
  implementation-pointer slot that survives bytecode immutability
  (DC-13) via the tail-call forwarder pattern above.
- **WASM VM backend** for 10–100× perf.
