// DarkVM — browser-functional mirror of `ion-monerousd-org/backend/dark-contracts/vm.js`.
// Maintains opcode + execute() parity (IDE-14) under browser constraints:
//
//   • `node:crypto` → vendored sync SHA-256 (`./sha256-sync.js`).
//   • `Buffer.from(...).toString('hex')` → `bytesToHex` (`./bytes.js`).
//   • Pedersen / view-key crypto are STUBBED for browser preview only.
//
// What "stubbed" means: COMMIT_U64, RANGEPROOF, NULLIFIER, REVEAL emit
// deterministic 32-byte placeholders derived via SHA-256, NOT real
// curve25519 commits / Bulletproofs / AES-GCM. The IDE surfaces a
// banner on the Run activity making this explicit. Real values appear
// on-chain when the user uses Deploy & Run; the local VM is preview-
// only and CANNOT be used to forge a chain proof — the chain validates
// via the canonical backend impl, which uses real crypto.
//
// Non-negotiable invariants (matches plan DC-1..DC-5, IDE-14):
//   - All numeric math is BigInt. No Number, no Date, no Math.random.
//   - Step-limit and memory-limit aborts are POSITIVE; never silently truncate.
//   - `host` callback is the ONLY escape to the outside world.
//   - Bytecode format is versioned (first byte); unknown versions
//     throw DC_BYTECODE_VERSION (DC-13).

import { sha256Sync, createSha256 } from './sha256-sync.js';
import { bytesToHex, hexToBytes, concat as concatBytes, utf8, utf8Decode } from './bytes.js';

// Bytecode layout (v1):
//   [0]        version = 0x01
//   [1..4]     entrypoint count (u32 LE)
//   [5..]      entrypoint table: { nameHash(4) | pc(4) } * count
//   [...]      code bytes (opcodes + immediates)

const U64_MASK = (1n << 64n) - 1n;

// Canonical opcode table — must stay byte-equal to backend vm.js OP.
// Renumbering = consensus break for every deployed contract.
export const OP = Object.freeze({
  // Stack / constants
  PUSH_U64:       0x01,
  PUSH_BYTES:     0x02,   // [len:u16][bytes...]
  POP:            0x03,
  DUP:            0x04,
  SWAP:           0x05,

  // Arithmetic (u64, wrap on overflow)
  ADD_U64:        0x10,
  SUB_U64:        0x11,
  MUL_U64:        0x12,
  DIV_U64:        0x13,   // DIV_BY_ZERO aborts
  MOD_U64:        0x14,

  // Comparison / logical
  LT:             0x20,
  EQ:             0x21,
  NOT:            0x22,
  AND:            0x23,
  OR:             0x24,

  // Control flow (jumps are absolute PC offsets, u32)
  JUMP:           0x30,   // [pc:u32]
  JUMPI:          0x31,   // [pc:u32]
  RETURN:         0x32,
  REVERT:         0x33,

  // Storage
  SLOAD:          0x40,   // (slot_bytes) -> (value_bytes)
  SSTORE:         0x41,   // (slot_bytes, value_bytes) ->
  SSTORE_PRIV:    0x42,   // like SSTORE but sets is_private=1

  // Privacy primitives — STUBBED in this browser mirror, see header.
  COMMIT_U64:     0x50,   // (value, blinding) -> C
  RANGEPROOF:     0x51,   // (value, blinding) -> proofHex
  NULLIFIER:      0x52,   // (secret) -> null_hash
  REVEAL:         0x53,   // (value_u64, callerVKHash) -> encryptedBlobHex

  // Host syscall
  SYSCALL:        0x60,   // (argv_bytes), [op:u16] -> (result_bytes)

  // Context / msg
  MSG_SENDER:     0x70,
  BLOCK_NUMBER:   0x71,
  CONTRACT_ID:    0x72,
  TX_HASH:        0x73,

  // Hashing
  SHA256:         0x80,   // (bytes) -> digest32

  // Emit log
  EMIT:           0x90,   // (topic_bytes, data_bytes)

  // Phase 2 — locals / coercion / mapping helpers
  LOCAL_GET:      0xa0,
  LOCAL_SET:      0xa1,
  ALLOC_LOCALS:   0xa2,
  U64_FROM_BYTES: 0xa3,
  U64_TO_BYTES:   0xa4,
  MAP_LOAD:       0xa5,
  MAP_STORE:      0xa6,
  MAP_STORE_PRIV: 0xa7,
  CONCAT:         0xa8,
  BYTES_LEN:      0xa9,
  STR_EQ:         0xaa,

  // Phase 3 — inter-contract tail-call (host-dispatched via syscall today)
  EXT_CALL_TAIL:  0xab,
});

// String<->bytes — TextEncoder/TextDecoder are browser natives.
const te = new TextEncoder();
const td = new TextDecoder();

function readU32(buf, pc) {
  return (buf[pc] | (buf[pc + 1] << 8) | (buf[pc + 2] << 16) | (buf[pc + 3] << 24)) >>> 0;
}
function readU16(buf, pc) {
  return buf[pc] | (buf[pc + 1] << 8);
}
function readU64LE(buf, pc) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) { v = (v << 8n) | BigInt(buf[pc + i]); }
  return v & U64_MASK;
}

// ────────── Browser-stub privacy primitives ──────────
// Real implementations: ion-monerousd-org/backend/dark-contracts/{pedersen,emit-crypto}.js
// These produce DETERMINISTIC 32-byte outputs from their inputs (so the
// local VM trace is reproducible for the same call) but do NOT correspond
// to real curve25519 / Bulletproofs / AES-256-GCM ciphertexts. The chain
// validates against the canonical backend; this is preview-only.
function _stubPedersenCommit(valueU64, blindingBytes) {
  const v = new Uint8Array(8);
  let x = valueU64;
  for (let i = 0; i < 8; i++) { v[i] = Number(x & 0xffn); x >>= 8n; }
  return sha256Sync(concatBytes(utf8('darkvm/stub/commit-u64'), v, blindingBytes || new Uint8Array(0)));
}
function _stubPedersenRangeProof(valueU64, blindingBytes) {
  const v = new Uint8Array(8);
  let x = valueU64;
  for (let i = 0; i < 8; i++) { v[i] = Number(x & 0xffn); x >>= 8n; }
  return sha256Sync(concatBytes(utf8('darkvm/stub/range-proof'), v, blindingBytes || new Uint8Array(0)));
}
function _stubPedersenNullifier(contractId, secretBytes) {
  return sha256Sync(concatBytes(utf8('darkvm/stub/nullifier'), utf8(String(contractId || '')), secretBytes || new Uint8Array(0)));
}
function _stubEncryptForViewkey({ callerViewkeyHash, contractId, eventName, plaintext }) {
  return sha256Sync(concatBytes(
    utf8('darkvm/stub/reveal'),
    utf8(String(contractId || '')),
    utf8(String(eventName || '')),
    callerViewkeyHash || new Uint8Array(0),
    plaintext || new Uint8Array(0),
  ));
}

// Parse the bytecode header + entrypoint table.
export function parseBytecode(bytecode) {
  const buf = bytecode instanceof Uint8Array ? bytecode : new Uint8Array(bytecode);
  if (buf.length < 5) throw new Error('DC_BYTECODE_TOO_SHORT');
  const version = buf[0];
  if (version !== 0x01) throw new Error(`DC_BYTECODE_VERSION:${version}`);
  const count = readU32(buf, 1);
  if (count > 256) throw new Error('DC_BYTECODE_TOO_MANY_ENTRYPOINTS');
  const entrypoints = {};
  let p = 5;
  for (let i = 0; i < count; i++) {
    if (p + 8 > buf.length) throw new Error('DC_BYTECODE_TRUNCATED_ENTRYPOINT_TABLE');
    const nameHash = bytesToHex(buf.slice(p, p + 4));
    const pc = readU32(buf, p + 4);
    entrypoints[nameHash] = pc;
    p += 8;
  }
  return { version, codeStart: p, entrypoints, buf };
}

// SHA256(name).slice(0,4) hex selector.
export function entrypointSelector(name) {
  const h = sha256Sync(utf8(String(name)));
  return bytesToHex(h.slice(0, 4));
}

/**
 * Execute a bytecode entrypoint. Same signature as canonical backend.
 *
 * @returns {{ ok: true, returnValue: Uint8Array|null, logs: Array, diffs: Array, stepsUsed: number }
 *         | { ok: false, error: string, reverted: boolean }}
 */
export function execute({
  bytecode, entrypoint, args, ctx,
  loadSlot, storeSlot, syscall, emitNullifier, emitLog,
  stepLimit = 1_000_000, memoryLimit = 262_144,
  sharedBudget,
}) {
  // Header parse — captured in the error envelope so a malformed
  // bytecode (bad version, truncated table, …) returns
  // { ok: false, error: 'DC_BYTECODE_*' } instead of throwing out of
  // execute() and crashing the IDE Run page.
  let codeStart, entrypoints, buf;
  try {
    ({ codeStart, entrypoints, buf } = parseBytecode(bytecode));
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e),
      reverted: false,
      stepsUsed: 0,
    };
  }
  const selector = entrypointSelector(entrypoint);
  const startPc = entrypoints[selector];
  if (startPc == null) {
    return { ok: false, error: 'DC_UNKNOWN_ENTRYPOINT:' + entrypoint, reverted: false };
  }

  const stack = [];
  const diffs = [];
  const logs = [];
  const pendingWrites = new Map();
  const pendingReads  = new Map();
  const locals = [];
  let memoryUsed = 0;
  const budget = sharedBudget || { remaining: stepLimit };
  const startBudget = budget.remaining;
  let pc = codeStart + startPc;

  if (!Array.isArray(args)) args = args ? [args] : [];
  if (args.length > 64) return { ok: false, error: 'DC_ARGS_TOO_MANY', reverted: false };
  for (const a of args) {
    switch (a.tag) {
      case 'u64':    push(BigInt(a.value) & U64_MASK); break;
      case 'bytes':
      case 'stealth':
        pushBytes(a.value instanceof Uint8Array ? a.value : utf8(String(a.value)));
        break;
      default: return { ok: false, error: 'DC_BAD_ARG_TAG:' + a.tag, reverted: false };
    }
  }

  function push(v) {
    if (stack.length >= 1024) throw new Error('DC_STACK_OVERFLOW');
    stack.push({ t: 'u64', v: BigInt(v) & U64_MASK });
    memoryUsed += 16; checkMem();
  }
  function pushBytes(b) {
    if (stack.length >= 1024) throw new Error('DC_STACK_OVERFLOW');
    const bb = b instanceof Uint8Array ? b : Uint8Array.from(b);
    stack.push({ t: 'bytes', v: bb });
    memoryUsed += bb.length + 16; checkMem();
  }
  function pop() {
    if (stack.length === 0) throw new Error('DC_STACK_UNDERFLOW');
    const x = stack.pop();
    memoryUsed -= (x.t === 'bytes' ? x.v.length : 0) + 16;
    return x;
  }
  function popU64() {
    const x = pop();
    if (x.t !== 'u64') throw new Error('DC_TYPE_MISMATCH_EXPECTED_U64');
    return x.v;
  }
  function popBytes() {
    const x = pop();
    if (x.t !== 'bytes') throw new Error('DC_TYPE_MISMATCH_EXPECTED_BYTES');
    return x.v;
  }
  function checkMem() {
    if (memoryUsed > memoryLimit) throw new Error('DC_MEMORY_LIMIT');
  }
  function tick() {
    budget.remaining -= 1;
    if (budget.remaining < 0) throw new Error('DC_STEP_LIMIT');
  }
  function u8() { tick(); if (pc >= buf.length) throw new Error('DC_PC_OVERFLOW'); return buf[pc++]; }
  function u16imm() { const v = readU16(buf, pc); pc += 2; tick(); return v; }
  function u32imm() { const v = readU32(buf, pc); pc += 4; tick(); return v; }
  function u64imm() { const v = readU64LE(buf, pc); pc += 8; tick(); return v; }

  function loadSlotCached(slotHex) {
    if (pendingWrites.has(slotHex)) return pendingWrites.get(slotHex);
    if (pendingReads.has(slotHex)) return { valueHex: pendingReads.get(slotHex), isPrivate: false };
    const r = loadSlot ? loadSlot(slotHex) : null;
    pendingReads.set(slotHex, r ? r.valueHex : '');
    return r;
  }
  function storeSlotPending(slotHex, valueHex, isPrivate) {
    pendingWrites.set(slotHex, { valueHex, isPrivate });
  }

  try {
    while (true) {
      const op = u8();
      switch (op) {
        case OP.PUSH_U64: { push(u64imm()); break; }
        case OP.PUSH_BYTES: {
          const len = u16imm();
          if (len > 65535) throw new Error('DC_BYTES_TOO_LONG');
          if (pc + len > buf.length) throw new Error('DC_BYTECODE_TRUNCATED_BYTES');
          pushBytes(buf.slice(pc, pc + len));
          pc += len;
          break;
        }
        case OP.POP: pop(); break;
        case OP.DUP: {
          if (stack.length === 0) throw new Error('DC_STACK_UNDERFLOW');
          const top = stack[stack.length - 1];
          if (top.t === 'u64') push(top.v);
          else pushBytes(top.v);
          break;
        }
        case OP.SWAP: {
          if (stack.length < 2) throw new Error('DC_STACK_UNDERFLOW');
          const a = stack.pop(); const b = stack.pop();
          stack.push(a); stack.push(b);
          break;
        }
        case OP.ADD_U64: { const b = popU64(); const a = popU64(); push((a + b) & U64_MASK); break; }
        case OP.SUB_U64: { const b = popU64(); const a = popU64(); push((a - b) & U64_MASK); break; }
        case OP.MUL_U64: { const b = popU64(); const a = popU64(); push((a * b) & U64_MASK); break; }
        case OP.DIV_U64: { const b = popU64(); const a = popU64(); if (b === 0n) throw new Error('DC_DIV_ZERO'); push((a / b) & U64_MASK); break; }
        case OP.MOD_U64: { const b = popU64(); const a = popU64(); if (b === 0n) throw new Error('DC_MOD_ZERO'); push((a % b) & U64_MASK); break; }
        case OP.LT: { const b = popU64(); const a = popU64(); push(a < b ? 1n : 0n); break; }
        case OP.EQ: {
          const b = pop(); const a = pop();
          if (a.t !== b.t) push(0n);
          else if (a.t === 'u64') push(a.v === b.v ? 1n : 0n);
          else {
            if (a.v.length !== b.v.length) { push(0n); break; }
            let eq = 1n; for (let i = 0; i < a.v.length; i++) if (a.v[i] !== b.v[i]) { eq = 0n; break; }
            push(eq);
          }
          break;
        }
        case OP.NOT: { const a = popU64(); push(a === 0n ? 1n : 0n); break; }
        case OP.AND: { const b = popU64(); const a = popU64(); push((a & b) & U64_MASK); break; }
        case OP.OR:  { const b = popU64(); const a = popU64(); push((a | b) & U64_MASK); break; }
        case OP.JUMP: { const t = u32imm(); pc = codeStart + t; break; }
        case OP.JUMPI: {
          const t = u32imm();
          const cond = popU64();
          if (cond !== 0n) pc = codeStart + t;
          break;
        }
        case OP.RETURN: {
          let ret = null;
          if (stack.length > 0) {
            const x = pop();
            if (x.t === 'u64') {
              ret = new Uint8Array(8);
              let v = x.v;
              for (let i = 0; i < 8; i++) { ret[i] = Number(v & 0xffn); v >>= 8n; }
            } else {
              ret = x.v;
            }
          }
          for (const [slot, { valueHex, isPrivate }] of pendingWrites.entries()) {
            diffs.push({ slot, value: valueHex, isPrivate });
          }
          return { ok: true, returnValue: ret, logs, diffs, stepsUsed: startBudget - budget.remaining };
        }
        case OP.REVERT: {
          let msg = 'DC_REVERT';
          if (stack.length > 0 && stack[stack.length - 1].t === 'bytes') {
            msg = 'DC_REVERT:' + td.decode(stack[stack.length - 1].v);
          }
          return { ok: false, error: msg, reverted: true };
        }
        case OP.SLOAD: {
          const slot = popBytes();
          const slotHex = bytesToHex(slot);
          const r = loadSlotCached(slotHex);
          pushBytes(r && r.valueHex ? hexToBytes(r.valueHex) : new Uint8Array(0));
          break;
        }
        case OP.SSTORE:
        case OP.SSTORE_PRIV: {
          const value = popBytes();
          const slot = popBytes();
          storeSlotPending(bytesToHex(slot), bytesToHex(value), op === OP.SSTORE_PRIV);
          break;
        }
        case OP.COMMIT_U64: {
          const blinding = popBytes();
          const v = popU64();
          pushBytes(_stubPedersenCommit(v, blinding));
          break;
        }
        case OP.RANGEPROOF: {
          const blinding = popBytes();
          const v = popU64();
          pushBytes(_stubPedersenRangeProof(v, blinding));
          break;
        }
        case OP.NULLIFIER: {
          const secret = popBytes();
          const nHash = _stubPedersenNullifier(ctx?.contractId || '', secret);
          if (emitNullifier) emitNullifier(bytesToHex(nHash));
          pushBytes(nHash);
          break;
        }
        case OP.REVEAL: {
          const vkHash = popBytes();
          const value = popU64();
          const pt = new Uint8Array(8);
          let x = value;
          for (let i = 0; i < 8; i++) { pt[i] = Number(x & 0xffn); x >>= 8n; }
          const ct = _stubEncryptForViewkey({
            callerViewkeyHash: vkHash,
            contractId: ctx?.contractId || '',
            eventName: 'reveal',
            plaintext: pt,
          });
          pushBytes(ct);
          break;
        }
        case OP.SYSCALL: {
          const opId = u16imm();
          const argv = popBytes();
          if (!syscall) throw new Error('DC_SYSCALL_HOST_MISSING:' + opId);
          const r = syscall(opId, argv, { budget });
          if (!r || r.ok === false) throw new Error('DC_SYSCALL_FAILED:' + opId + ':' + (r?.error || 'unknown'));
          pushBytes(r.result || new Uint8Array(0));
          break;
        }
        case OP.MSG_SENDER: pushBytes(utf8(ctx?.msgSender || '')); break;
        case OP.BLOCK_NUMBER: push(BigInt(ctx?.blockNumber || 0)); break;
        case OP.CONTRACT_ID: pushBytes(utf8(ctx?.contractId || '')); break;
        case OP.TX_HASH: pushBytes(utf8(ctx?.txHash || '')); break;
        case OP.SHA256: {
          const b = popBytes();
          pushBytes(sha256Sync(b));
          break;
        }
        case OP.EMIT: {
          const data = popBytes();
          const topic = popBytes();
          if (emitLog) emitLog(topic, data);
          logs.push({ topicHex: bytesToHex(topic), dataHex: bytesToHex(data) });
          break;
        }
        // ────────── Phase 2 opcodes ──────────
        case OP.ALLOC_LOCALS: {
          const n = u8();
          if (n > 256) throw new Error('DC_TOO_MANY_LOCALS');
          while (locals.length < n) locals.push({ t: 'u64', v: 0n });
          memoryUsed += n * 16;
          checkMem();
          break;
        }
        case OP.LOCAL_GET: {
          const idx = u8();
          if (idx >= locals.length) throw new Error('DC_LOCAL_OOB');
          const x = locals[idx];
          if (x.t === 'u64') push(x.v);
          else pushBytes(x.v);
          break;
        }
        case OP.LOCAL_SET: {
          const idx = u8();
          if (idx >= locals.length) throw new Error('DC_LOCAL_OOB');
          const x = pop();
          const prev = locals[idx];
          if (prev && prev.t === 'bytes') memoryUsed -= prev.v.length;
          if (x.t === 'bytes') memoryUsed += x.v.length;
          locals[idx] = x;
          break;
        }
        case OP.U64_FROM_BYTES: {
          const b = popBytes();
          let v = 0n;
          for (let i = 7; i >= 0; i--) {
            v = (v << 8n) | BigInt(b[i] || 0);
          }
          push(v & U64_MASK);
          break;
        }
        case OP.U64_TO_BYTES: {
          const v = popU64();
          const out = new Uint8Array(8);
          let x = v;
          for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
          pushBytes(out);
          break;
        }
        case OP.MAP_LOAD: {
          const key = popBytes();
          const base = popBytes();
          const slotBytes = createSha256().update(base).update(key).digest();
          const slotHex = bytesToHex(slotBytes);
          const r = loadSlotCached(slotHex);
          pushBytes(r && r.valueHex ? hexToBytes(r.valueHex) : new Uint8Array(0));
          break;
        }
        case OP.MAP_STORE:
        case OP.MAP_STORE_PRIV: {
          const value = popBytes();
          const key = popBytes();
          const base = popBytes();
          const slotBytes = createSha256().update(base).update(key).digest();
          const slotHex = bytesToHex(slotBytes);
          storeSlotPending(slotHex, bytesToHex(value), op === OP.MAP_STORE_PRIV);
          break;
        }
        case OP.CONCAT: {
          const b = popBytes();
          const a = popBytes();
          const out = new Uint8Array(a.length + b.length);
          out.set(a, 0); out.set(b, a.length);
          pushBytes(out);
          break;
        }
        case OP.BYTES_LEN: {
          const b = popBytes();
          push(BigInt(b.length) & U64_MASK);
          break;
        }
        case OP.STR_EQ: {
          const b = popBytes();
          const a = popBytes();
          if (a.length !== b.length) { push(0n); break; }
          let eq = 1n;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { eq = 0n; break; }
          push(eq);
          break;
        }
        default:
          throw new Error('DC_UNKNOWN_OPCODE:0x' + op.toString(16));
      }
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e), reverted: true, stepsUsed: startBudget - budget.remaining };
  }
}

/** Make a default no-op host bundle for the IDE's local-VM Run page.
 * The renderer calls this then overrides specific callbacks if needed. */
export function makeLocalHost({ ctx, state }) {
  const slots = state || new Map();
  const nullifiers = new Set();
  return {
    ctx: ctx || { msgSender: 'local-preview', blockNumber: 0, contractId: 'dc1_local', txHash: 'preview' },
    loadSlot(slotHex) {
      const v = slots.get(slotHex);
      return v ? { valueHex: v.value, isPrivate: !!v.isPrivate } : null;
    },
    storeSlot(slotHex, valueHex, isPrivate) {
      slots.set(slotHex, { value: valueHex, isPrivate: !!isPrivate });
    },
    syscall(opId, argv, opts) {
      // Browser preview: refuse all syscalls so contracts that try to
      // emit on-chain side-effects are surfaced clearly. The IDE Run
      // page renders a "syscall in preview is no-op" hint when this fires.
      return { ok: false, error: 'SYSCALL_PREVIEW_DISABLED:' + opId };
    },
    emitNullifier(hex) {
      if (nullifiers.has(hex)) throw new Error('DC_NULLIFIER_DUPLICATE');
      nullifiers.add(hex);
    },
    emitLog(_topic, _data) { /* logs collected via execute() return.logs */ },
    state: slots,
    nullifiers,
  };
}

export const VM_VERSION_TAG = 'darkvm-browser-mirror/v1';
