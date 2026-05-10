# Dark Contracts Protocol — v1 (frozen)

This document is the frozen wire-format spec for Dark Contracts. Any
v1-compatible indexer MUST reproduce byte-identical responses from
the same chain state across every operator. Breaking changes require
a `/v2/` surface; extensions are append-only (new fields fine, no
removals).

## 1. Attestation op codes

```
DC_DEPLOY          // payload: { bytecodeB64, abiJson, sourceHash, saltHex, constructorArgs, stepLimit, memoryLimit, creatorStealth }
DC_CALL_COMMIT     // payload: { contractId, entrypoint, commitHash, commitId }
DC_CALL_REVEAL     // payload: { contractId, commitId, entrypoint, argv, salt }
DC_CALL_DIRECT     // payload: { contractId, entrypoint, argv }
DC_DESTROY         // payload: { contractId }
```

Wire format is the existing `ion://op/v1?code=<OP>&…` attestation
URI. Payload cap 2000 bytes JSON; bytecode >2000 bytes is chunked
off-chain and referenced by hash (Phase 3).

## 2. Bytecode format

| Offset | Field | Size |
|--------|-------|------|
| 0 | `version` | 1 byte = `0x01` |
| 1 | `entrypoint_count` | 4 bytes u32 LE |
| 5 | `entrypoint_table` | 8 bytes * count: `{ selector(4) | pc(4) }` |
| 5 + 8·N | `code` | opcodes + immediates |

Version byte changes are **consensus-breaking**. Adding new opcodes
inside version 1 is forward-compatible as long as existing codes
stay at their current indices.

## 3. Opcode table (frozen v1)

See `backend/dark-contracts/vm.js` for the authoritative enum. Every
opcode's semantics are fixed for v1.

## 4. Commit-reveal spec

```
commitHash = SHA256(
  "DC_COMMIT_V1:" | contractId | "|" | entrypoint | "|" |
  canonicalArgv(argv) | "|" | callerStealth | "|" | salt
)

canonicalArgv(argv):  // stable JSON-like serialisation
  if array: "[" + join(",", map(canonicalArgv, argv)) + "]"
  if object: "{" + join(",", sorted(map(k: JSON.stringify(k)+":"+canonicalArgv(argv[k])))) + "}"
  else: JSON.stringify(argv)
```

Window: reveal block ≤ commit block + **16 blocks** (~32 min at
current USDm block time). Outside the window → `DC_COMMIT_WINDOW_EXPIRED`.

## 5. State model

- `dc_contracts` — one row per deployed contract.
- `dc_state` — one row per `(contract_id, slot_key)`. Private slots
  hold the Pedersen commitment bytes; public slots hold the raw
  value bytes (u64 LE for scalars, UTF-8 for strings).
- `dc_nullifiers` — spent-nullifier set. PK on `nullifier`; duplicate
  inserts abort the call (DC-5).
- `dc_commit_reveals` — per-contract commit-reveal store.
- `dc_contract_roots` — per-contract Merkle root snapshot, aggregated
  into the global state root published by `amm/state-commit.js`.

## 6. Endpoints (v1, frozen)

```
GET /v1/contracts
GET /v1/contracts/:id
GET /v1/contracts/:id/calls
```

Responses always include `protocolVersion: 'v1'`. Private slots
return ONLY the commitment hex + a rangeProofHash — never plaintext
(DC-6).

## 7. Invariants (DC-1 … DC-15)

Authoritative copy lives in `ion-monerousd-org/CLAUDE.md` under the
"Dark Contracts — security invariants" section. Mirror here for
reference:

1. **Deterministic execution.** No Number / Date / Math.random; no
   async I/O inside the VM.
2. **Step-limit termination.** 1 M instructions max per call.
3. **Memory-limit termination.** 256 KB max per call.
4. **Commit-reveal required for private mutations.**
5. **Nullifier uniqueness.** `dc_nullifiers` PK enforced.
6. **Private state never plaintext in /v1/\*.**
7. **Syscall allowlist.** `SYSCALLS = Object.freeze({…})`.
8. **Syscall invariants propagate.** Host forwards to existing
   hardcoded handlers — no reduced-check copy.
9. **State anchored to the chain each block.** Every state change
   emits a `pool_events` row.
10. **Deployment bond non-refundable.** 10 USDm flat.
11. **No transparent call path.** Only via attestation.
12. **No pool_events write bypass.** `_applyStateDiff` is the one
    writer.
13. **Bytecode immutable.** `code_hash` UPDATE denied.
14. **Compile-time privacy analysis.** Private → public leak =
    compile error.
15. **Wallet decodes before approval.** ABI-rendered call, not a
    JSON blob.

## 8. Private-field cryptography (Phase 3, v1.2.148)

### 8.1 Pedersen commitment body

Private slots are stored as Pedersen commitments over ed25519:

```
C(v, r) = v·G + r·H
```

Where `G` is the ed25519 base point and `H` is a nothing-up-sleeve
second generator defined as:

```
H = G × scalar(SHA-512("DC-PEDERSEN-H-v1") mod L)
```

- Input bytes: ASCII `"DC-PEDERSEN-H-v1"` (16 bytes).
- Hash: SHA-512 → 64 bytes big-endian.
- Reduce mod L (the ed25519 subgroup order).
- If the reduced scalar is zero, substitute `1` (never happens for
  this input; guard retained for safety).

The commitment body is 32 bytes — standard compressed ed25519
point encoding. Addition is point addition; the scheme is
additively homomorphic:

```
C(a, r1) + C(b, r2) = C(a + b, r1 + r2)
```

Zero value is legal (`C(0, r) = r·H`); zero blinding is forbidden
(`r = 0` collapses hiding — the codec substitutes `1`).

### 8.2 Range-proof shape

v1 range proof is a 96-byte `(commitment || proof_blob)` pair.
The commitment is real Pedersen from day one; the proof body in
v1 is a structured deterministic placeholder
(`SHA-512(commitment || value_le8 || blinding_le32)`) pending the
Bulletproofs+ swap in v2. Wire shape is frozen so the v2 upgrade
swaps the proof body without any downstream codec change.

### 8.3 AES-GCM event encryption

`emit encrypted EventName(args)` compiles to an `EMIT` opcode
whose `data` bytes are AES-256-GCM-wrapped. Wire format:

```
[0]       version = 0x01
[1..13]   96-bit IV (12 bytes, CSPRNG per emit)
[13..end] AES-256-GCM ciphertext || 16-byte GCM tag
```

Key derivation is deterministic:

```
key = HKDF-SHA256(
  ikm  = caller_viewkey_hash,
  salt = "DC-EMIT-V1",
  info = contract_id || 0x7C || event_name,
  len  = 32,
)
```

The recipient re-derives the key from `(callerViewkeyHash,
contractId, eventName)` with no extra on-chain metadata; the IV
rides in the ciphertext. Authentication is the 16-byte GCM tag —
any modification of the ciphertext fails verification and the
event cannot be decrypted.

## 9. Inter-contract tail-call (Phase 3)

### 9.1 Syscall opcode

```
SYSCALL_ID.EXT_CALL_TAIL_V1 = 0x0601
```

Dispatched via `SYSCALL opId, argvBytes`. The reserved opcode
`OP.EXT_CALL_TAIL = 0xab` is present in the opcode space for a
future first-class tail-call keyword; today the live path is the
SYSCALL form.

### 9.2 Argv shape

JSON-encoded to UTF-8 bytes:

```json
{
  "contractId": "dc1_...",
  "entrypoint": "<entry name>",
  "args": [ { "tag": "u64|bytes|stealth", "value": <typed> } ]
}
```

- `tag: "u64"`  — `value` is a number, bigint, or decimal string.
- `tag: "bytes"` — `value` is a `0x`-prefixed hex string OR plain
   string bytes.
- `tag: "stealth"` — `value` is a string (callee treats as bytes).

### 9.3 Runtime semantics

- **Self-call forbidden.** `calleeId === ctx.contractId` → `DC_EXTCALL_SELF`.
- **Reentrancy forbidden.** The dispatcher maintains an in-flight
  `extCallStack: Set<contractId>` across the entire tail chain. A
  second call into an already-in-flight contract → `DC_REENTRANT:<id>`.
- **Depth cap.** `DC_MAX_EXT_CALL_DEPTH = 4`. Deeper chain →
  `DC_EXTCALL_DEPTH`.
- **Batch entries unreachable.** An entry marked `@batch` cannot be
  reached via EXT_CALL_TAIL → `DC_EXTCALL_NOT_DIRECT`. The
  commit-reveal gate (DC-4) still applies to top-level calls only;
  attempting to tail into a private entry via a public wrapper is a
  compile-error at the callee side.
- **Shared step budget.** The caller's `{ remaining }` counter is
  threaded through vm → syscall → host → runCallee → vm. A 1 M-
  instruction top-level budget is indivisible across the chain —
  depth-4 loops that burn 250 k steps each trip `DC_STEP_LIMIT` at
  the fourth level, not after four independent 1 M budgets.
- **Return value.** Callee's return bytes are passed straight
  through as the syscall result. The DSOL surface expects the caller
  to immediately `return` that value, making this a genuine tail
  call — no caller frame survives to be re-entered.

### 9.4 Invariants preserved

| Invariant | Enforcement under EXT_CALL_TAIL |
|-----------|---------------------------------|
| DC-1 (determinism) | Shared BigInt VM; no async I/O on the call path. |
| DC-2 (step-limit) | Shared `{ remaining }` counter; cap applies to the full chain. |
| DC-4 (commit-reveal) | Batch entries refused at the boundary. |
| DC-5 (nullifier uniqueness) | PK-enforced in `dc_nullifiers`; independent of caller. |
| DC-7 (syscall allowlist) | `EXT_CALL_TAIL_V1` is a frozen entry in `SYSCALLS`. |
| DC-13 (bytecode immutable) | Callee bytecode is LOADed, never mutated. |

## 10. Inheritance (Phase 3)

### 10.1 Syntax

```
dark contract Child is Parent1, Parent2 { ... }
```

Multiple parents permitted (left-to-right order is significant).

### 10.2 Linearization rules

Flattening happens at the top of `compile()`, before typecheck:

1. **Order.** Left-to-right DFS of the `parents` list, parents
   recursed fully before siblings.
2. **State variables.** Merged in linearization order.
   Duplicate name → child wins (last-writer-wins).
3. **Events.** Merged in linearization order. Child event with the
   same name overrides parent signature.
4. **Modifiers.** Merged in linearization order. Child overrides.
5. **Entrypoints.** Merged in linearization order. Child entry with
   the same name replaces the parent's implementation entirely.
6. **Constructor.** Parent constructor bodies concatenate FIRST,
   in linearization order (most-base parent runs first); child
   constructor runs LAST. Each constructor sees the state produced
   by its predecessors.

### 10.3 Modifier inlining

`entry transfer(...) onlyOwner, nonReentrant { body }` expands at
codegen:

```
function transfer(...) {
  onlyOwner_preamble
  nonReentrant_preamble
  body                             ← at the `_;` position
  nonReentrant_postamble
  onlyOwner_postamble
}
```

Modifiers compose in left-to-right declaration order — the first
modifier wraps all subsequent ones. Modifier parameters allocate
into the entry's local frame at inlining time (no separate call
frame).

### 10.4 ABI surface

Inherited entries appear in the flattened `abi.entrypoints[]` as
if declared on the child. The wallet's decode-before-approval
path (DC-15) renders them using the child's contract name.

## 11. Version / upgrade policy

- Wire-shape fields above (§8.1 H-generator derivation, §8.3 AES-GCM
  layout, §9.2 argv shape, §10.2 linearization rules) are
  **consensus**. Any change bumps the bytecode version byte (§2).
- v2 swaps the range-proof body (§8.2) for Bulletproofs+ without
  changing the envelope — commitment bytes unchanged, proof_blob
  stays 64 bytes.
- A new syscall id under 0x06xx is forward-compatible; removing or
  renumbering an existing id is a consensus break.
