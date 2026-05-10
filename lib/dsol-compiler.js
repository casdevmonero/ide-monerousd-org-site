/* DSOL compiler — browser port of `build-1261/dark-contracts/compiler/`.
 *
 * Single-file bundle of the canonical wallet-side compiler with two
 * substitutions:
 *
 *   1. `node:crypto.createHash('sha256').update(x).digest()` →
 *      `sha256Sync(x)` from `./sha256-sync.js`. The hot paths are
 *      synchronous (entrypoint selector, state slot keys, mapping base
 *      keys, event topic hashing, codeHash); SubtleCrypto.digest is
 *      async and unusable here.
 *
 *   2. `node:fs / node:path / node:url`-backed `defaultResolveParent`
 *      → browser-pluggable resolver. The IDE passes its bundled stdlib
 *      via `opts.stdlibMap = { Ownable: '<src>', Pausable: '<src>', ...}`,
 *      so child contracts can `is Ownable, Pausable` without filesystem
 *      access.
 *
 * Everything else — lexer, parser, typecheck pass, AST flattener,
 * codegen, ABI builder, source-map emission — is byte-functional with
 * the canonical implementation. The compile-parity invariant (IDE-5)
 * is held by `tests/static/compile-parity.test.js` which runs every
 * shipped DSOL template through both this module and the canonical
 * Node path, asserting byte-equal `bytecode + codeHash`.
 *
 * Public surface:
 *
 *   compileSource(src, opts?) → { bytecode: Uint8Array, abi, codeHash, source, ast, sourceMap }
 *   tokenize(src) → tokens[]      // exposed for IDE diagnostics
 *   parse(tokens) → ast
 *   typecheck(ast) → analysis
 *   flattenContract(ast, resolveParent) → flat ast
 *   compile(ast, analysis) → { bytecode, sourceMap }   // codegen entrypoint
 *
 *   makeStdlibResolver(stdlibMap) → (name) => parsed-ast
 *
 * The compileSource opts object:
 *   - resolveParent?: (name) => parsed-ast
 *       called by the flattener when a contract uses `is Parent`. If
 *       omitted, falls back to a resolver built from `opts.stdlibMap`
 *       (object: name → DSOL source). If neither is provided, the
 *       compiler throws a descriptive error when an inheritance edge
 *       is encountered.
 */

import { sha256Sync, sha256SyncHex } from './sha256-sync.js';

/* ────────────────────────── lexer ────────────────────────── */

const KEYWORDS = new Set([
  'dark', 'contract', 'constructor', 'entry', 'function', 'returns',
  'if', 'else', 'for', 'while', 'return', 'require', 'emit', 'syscall',
  'private', 'public', 'mapping', 'struct', 'event',
  'is', 'modifier',
  'uint64', 'int64', 'uint8', 'bool', 'string', 'bytes', 'stealth', 'address',
  'true', 'false', 'when', 'revealed', 'encrypted',
  'msg', 'block', 'ctx', 'this',
  'let', 'const', 'break', 'continue',
]);

const PUNCT_TWO = new Set(['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '->']);
const PUNCT_ONE = new Set(['(', ')', '{', '}', '[', ']', ';', ',', '.', '=', '<', '>', '+', '-', '*', '/', '%', '@', '!', '&', '|', ':']);

export function tokenize(src) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const n = src.length;

  function peek(o = 0) { return i + o < n ? src[i + o] : ''; }
  function advance() {
    const c = src[i++];
    if (c === '\n') { line += 1; col = 1; } else { col += 1; }
    return c;
  }

  while (i < n) {
    const c = peek();

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }

    // Line comment
    if (c === '/' && peek(1) === '/') {
      while (i < n && peek() !== '\n') advance();
      continue;
    }
    // Block comment
    if (c === '/' && peek(1) === '*') {
      advance(); advance();
      while (i < n && !(peek() === '*' && peek(1) === '/')) advance();
      if (i < n) { advance(); advance(); }
      continue;
    }

    // String literal
    if (c === '"' || c === '\'') {
      const quote = c;
      const startLine = line, startCol = col;
      advance();
      let val = '';
      while (i < n && peek() !== quote) {
        if (peek() === '\\') {
          advance();
          const esc = advance();
          if (esc === 'n') val += '\n';
          else if (esc === 't') val += '\t';
          else if (esc === 'r') val += '\r';
          else if (esc === '\\') val += '\\';
          else if (esc === '"') val += '"';
          else if (esc === '\'') val += '\'';
          else val += esc;
        } else {
          val += advance();
        }
      }
      if (i >= n) throw new Error(`Unterminated string at line ${startLine}:${startCol}`);
      advance(); // closing quote
      tokens.push({ kind: 'str', value: val, line: startLine, col: startCol });
      continue;
    }

    // Number literal (decimal; hex with 0x prefix; underscores allowed)
    if (c >= '0' && c <= '9') {
      const startLine = line, startCol = col;
      let s = '';
      if (c === '0' && (peek(1) === 'x' || peek(1) === 'X')) {
        s += advance(); s += advance();
        while (i < n && /[0-9a-fA-F_]/.test(peek())) s += advance();
      } else {
        while (i < n && /[0-9_]/.test(peek())) s += advance();
      }
      tokens.push({ kind: 'num', value: s.replace(/_/g, ''), line: startLine, col: startCol });
      continue;
    }

    // Identifier or keyword
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      const startLine = line, startCol = col;
      let s = '';
      while (i < n && /[A-Za-z0-9_]/.test(peek())) s += advance();
      const kind = KEYWORDS.has(s) ? 'kw' : 'ident';
      tokens.push({ kind, value: s, line: startLine, col: startCol });
      continue;
    }

    // Punctuation
    const two = c + peek(1);
    if (PUNCT_TWO.has(two)) {
      const startLine = line, startCol = col;
      advance(); advance();
      tokens.push({ kind: 'punct', value: two, line: startLine, col: startCol });
      continue;
    }
    if (PUNCT_ONE.has(c)) {
      const startLine = line, startCol = col;
      advance();
      tokens.push({ kind: 'punct', value: c, line: startLine, col: startCol });
      continue;
    }

    throw new Error(`Unexpected character '${c}' at line ${line}:${col}`);
  }

  tokens.push({ kind: 'eof', value: '', line, col });
  return tokens;
}

/* ────────────────────────── parser ────────────────────────── */

export function parse(tokens) {
  let pos = 0;
  function peek(o = 0) { return tokens[pos + o] || { kind: 'eof' }; }
  function eat(kind, value) {
    const t = tokens[pos];
    if (!t || t.kind !== kind || (value != null && t.value !== value)) {
      const exp = value != null ? `${kind} '${value}'` : kind;
      const got = t ? `${t.kind}:${t.value}` : 'EOF';
      throw new Error(`expected ${exp} at ${t.line}:${t.col}, got ${got}`);
    }
    pos++;
    return t;
  }
  function check(kind, value) {
    const t = tokens[pos];
    return t && t.kind === kind && (value == null || t.value === value);
  }
  function accept(kind, value) {
    if (check(kind, value)) return tokens[pos++];
    return null;
  }

  function parseType() {
    const t = tokens[pos++];
    if (!t) throw new Error('type expected');
    if (t.kind === 'kw' && ['uint64', 'int64', 'uint8', 'bool', 'string', 'stealth', 'bytes'].includes(t.value)) {
      return { kind: 'type', name: t.value };
    }
    if (t.kind === 'kw' && t.value === 'mapping') {
      eat('punct', '(');
      const keyT = parseType();
      eat('punct', '=');
      eat('punct', '>');
      const valT = parseType();
      eat('punct', ')');
      return { kind: 'type', name: 'mapping', keyType: keyT, valueType: valT };
    }
    throw new Error(`unexpected type token '${t.value}' at ${t.line}:${t.col}`);
  }

  function parseParams() {
    const out = [];
    eat('punct', '(');
    if (!check('punct', ')')) {
      while (true) {
        const t = parseType();
        const name = eat('ident').value;
        out.push({ name, type: t });
        if (!accept('punct', ',')) break;
      }
    }
    eat('punct', ')');
    return out;
  }

  function parseBlock() {
    eat('punct', '{');
    const stmts = [];
    while (!check('punct', '}')) stmts.push(parseStatement());
    eat('punct', '}');
    return { kind: 'block', stmts };
  }

  function parseStatement() {
    const t = peek();
    if (t.kind === 'kw') {
      if (t.value === 'if') return parseIf();
      if (t.value === 'return') { pos++; let e = null; if (!check('punct', ';')) e = parseExpr(); eat('punct', ';'); return { kind: 'return', value: e }; }
      if (t.value === 'require') { pos++; eat('punct', '('); const cond = parseExpr(); let msg = null; if (accept('punct', ',')) msg = parseExpr(); eat('punct', ')'); eat('punct', ';'); return { kind: 'require', cond, message: msg }; }
      if (t.value === 'emit') return parseEmit();
      if (t.value === 'syscall') return parseSyscall(true);
      if (t.value === 'let' || t.value === 'const') { pos++; const name = eat('ident').value; let ty = null; if (accept('punct', ':')) ty = parseType(); eat('punct', '='); const init = parseExpr(); eat('punct', ';'); return { kind: 'let', name, ty, init }; }
    }
    // Assignment or expression statement.
    const e = parseExpr();
    if (accept('punct', '=') || accept('punct', '+=') || accept('punct', '-=')) {
      const opTok = tokens[pos - 1];
      const rhs = parseExpr();
      eat('punct', ';');
      return { kind: 'assign', op: opTok.value, lhs: e, rhs };
    }
    eat('punct', ';');
    return { kind: 'exprstmt', expr: e };
  }

  function parseIf() {
    eat('kw', 'if');
    eat('punct', '(');
    const cond = parseExpr();
    eat('punct', ')');
    const cons = parseBlock();
    let alt = null;
    if (accept('kw', 'else')) alt = check('kw', 'if') ? parseStatement() : parseBlock();
    return { kind: 'if', cond, cons, alt };
  }

  function parseEmit() {
    eat('kw', 'emit');
    let encrypted = false;
    if (accept('kw', 'encrypted')) encrypted = true;
    const name = eat('ident').value;
    eat('punct', '(');
    const args = [];
    if (!check('punct', ')')) {
      while (true) { args.push(parseExpr()); if (!accept('punct', ',')) break; }
    }
    eat('punct', ')');
    eat('punct', ';');
    return { kind: 'emit', name, args, encrypted };
  }

  function parseSyscall(expectSemicolon) {
    eat('kw', 'syscall');
    eat('punct', '(');
    const opTok = eat('ident');
    eat('punct', ',');
    const argv = parseExpr();
    eat('punct', ')');
    if (expectSemicolon) eat('punct', ';');
    return { kind: 'syscall', op: opTok.value, argv };
  }

  // Pratt-ish expression parser with a fixed precedence table.
  function parseExpr() { return parseBin(0); }
  const PREC = {
    '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4,
    '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
  };
  function parseBin(minPrec) {
    let lhs = parseUnary();
    while (true) {
      const t = peek();
      if (t.kind !== 'punct') break;
      const op = t.value;
      if (!(op in PREC)) break;
      const p = PREC[op];
      if (p < minPrec) break;
      pos++;
      const rhs = parseBin(p + 1);
      lhs = { kind: 'bin', op, lhs, rhs };
    }
    return lhs;
  }
  function parseUnary() {
    if (accept('punct', '!')) return { kind: 'unary', op: '!', expr: parseUnary() };
    if (accept('punct', '-')) return { kind: 'unary', op: '-', expr: parseUnary() };
    return parsePostfix();
  }
  function parsePostfix() {
    let e = parsePrimary();
    while (true) {
      if (accept('punct', '.')) {
        const name = eat('ident').value;
        e = { kind: 'member', obj: e, name };
      } else if (accept('punct', '[')) {
        const idx = parseExpr();
        eat('punct', ']');
        e = { kind: 'index', obj: e, idx };
      } else if (accept('punct', '(')) {
        const args = [];
        if (!check('punct', ')')) {
          while (true) { args.push(parseExpr()); if (!accept('punct', ',')) break; }
        }
        eat('punct', ')');
        e = { kind: 'call', callee: e, args };
      } else {
        break;
      }
    }
    return e;
  }
  function parsePrimary() {
    const t = tokens[pos];
    if (t.kind === 'num') { pos++; return { kind: 'num', value: t.value }; }
    if (t.kind === 'str') { pos++; return { kind: 'str', value: t.value }; }
    if (t.kind === 'kw' && (t.value === 'true' || t.value === 'false')) { pos++; return { kind: 'bool', value: t.value === 'true' }; }
    if (t.kind === 'kw' && t.value === 'msg') {
      pos++; eat('punct', '.'); const n = eat('ident').value;
      return { kind: 'ctx', field: 'msg.' + n };
    }
    if (t.kind === 'kw' && t.value === 'block') {
      pos++; eat('punct', '.'); const n = eat('ident').value;
      return { kind: 'ctx', field: 'block.' + n };
    }
    if (t.kind === 'kw' && t.value === 'ctx') {
      pos++; eat('punct', '.'); const n = eat('ident').value;
      return { kind: 'ctx', field: 'ctx.' + n };
    }
    if (t.kind === 'kw' && t.value === 'syscall') return parseSyscall(false);
    if (t.kind === 'ident') { pos++; return { kind: 'ident', name: t.value }; }
    if (t.kind === 'punct' && t.value === '(') { pos++; const e = parseExpr(); eat('punct', ')'); return e; }
    throw new Error(`unexpected token '${t.value}' at ${t.line}:${t.col}`);
  }

  // ----- contract -----
  eat('kw', 'dark');
  eat('kw', 'contract');
  const nameTok = eat('ident');
  const contractLine = nameTok.line, contractCol = nameTok.col;
  const name = nameTok.value;
  const parents = [];
  if (accept('kw', 'is')) {
    while (true) {
      const p = eat('ident').value;
      parents.push(p);
      if (!accept('punct', ',')) break;
    }
  }
  eat('punct', '{');
  const statevars = [];
  const entries = [];
  const events = [];
  const modifiers = [];
  let ctor = null;
  while (!check('punct', '}')) {
    const attrs = new Set();
    while (accept('punct', '@')) {
      const a = eat('ident').value;
      if (!['batch', 'direct', 'highrisk'].includes(a)) {
        throw new Error(`unknown attribute @${a}`);
      }
      attrs.add(a);
    }
    let priv = null;
    if (accept('kw', 'private')) priv = true;
    else if (accept('kw', 'public')) priv = false;

    const tok = peek();
    if (tok.kind === 'kw' && tok.value === 'modifier') {
      pos++;
      const mnameTok = eat('ident');
      const params = parseParams();
      const body = parseBlock();
      modifiers.push({ kind: 'modifier', name: mnameTok.value, params, body, line: mnameTok.line, col: mnameTok.col });
      continue;
    }
    if (tok.kind === 'kw' && tok.value === 'constructor') {
      pos++;
      const params = parseParams();
      const body = parseBlock();
      ctor = { kind: 'ctor', params, body, line: tok.line, col: tok.col };
      continue;
    }
    if (tok.kind === 'kw' && tok.value === 'entry') {
      pos++;
      const fnameTok = eat('ident');
      const fname = fnameTok.value;
      const params = parseParams();
      const invokedMods = [];
      while (check('ident')) {
        const m = eat('ident').value;
        const args = [];
        if (accept('punct', '(')) {
          if (!check('punct', ')')) {
            while (true) { args.push(parseExpr()); if (!accept('punct', ',')) break; }
          }
          eat('punct', ')');
        }
        invokedMods.push({ name: m, args });
      }
      let returns = null;
      if (accept('kw', 'returns')) {
        eat('punct', '(');
        const rt = parseType();
        let whenRevealed = false;
        if (accept('kw', 'when')) { eat('kw', 'revealed'); whenRevealed = true; }
        eat('punct', ')');
        returns = { type: rt, whenRevealed };
      }
      const body = parseBlock();
      entries.push({
        kind: 'entry', name: fname, params, body, returns,
        attrs: [...attrs], modifiers: invokedMods,
        line: fnameTok.line, col: fnameTok.col,
      });
      continue;
    }
    if (tok.kind === 'kw' && tok.value === 'event') {
      pos++;
      const enameTok = eat('ident');
      const params = parseParams();
      eat('punct', ';');
      events.push({ kind: 'event', name: enameTok.value, params, line: enameTok.line, col: enameTok.col });
      continue;
    }
    // state variable
    const tyTok = peek();
    const ty = parseType();
    const snameTok = eat('ident');
    eat('punct', ';');
    statevars.push({
      kind: 'statevar', name: snameTok.value, type: ty, isPrivate: priv === true,
      line: tyTok.line, col: tyTok.col,
    });
  }
  eat('punct', '}');
  eat('eof');
  return {
    kind: 'contract', name, parents, statevars, entries, events, modifiers, ctor,
    line: contractLine, col: contractCol,
  };
}

/* ────────────────────────── typecheck ────────────────────────── */

export function typecheck(ast) {
  if (ast.kind !== 'contract') throw new Error('expected contract root');
  const privateStateNames = new Set();
  const publicStateNames = new Set();
  const allStateNames = new Set();
  const stateSlot = new Map();
  let slotCursor = 0;
  for (const sv of ast.statevars) {
    if (allStateNames.has(sv.name)) throw new Error(`duplicate state name '${sv.name}'`);
    allStateNames.add(sv.name);
    stateSlot.set(sv.name, slotCursor++);
    if (sv.isPrivate) privateStateNames.add(sv.name);
    else publicStateNames.add(sv.name);
    const tn = sv.type.name;
    if (tn === 'int64') throw new Error(`int64 not supported yet (use uint64): '${sv.name}'`);
    if (tn === 'mapping') {
      const k = sv.type.keyType.name;
      if (!['stealth', 'uint64', 'bytes'].includes(k)) {
        throw new Error(`mapping key must be stealth|uint64|bytes: '${sv.name}'`);
      }
    }
  }

  function checkEntry(e, ctor) {
    const isBatch = ctor || (e.attrs && e.attrs.includes('batch'));
    const isDirect = e.attrs && e.attrs.includes('direct');
    if (isBatch && isDirect) throw new Error(`entry '${e.name}' cannot be both @batch and @direct`);
    checkBlock(e.body, { inBatch: isBatch, inCtor: !!ctor, entry: e });
    if (e.returns) {
      if (e.returns.type.name === 'uint64' && !e.returns.whenRevealed) {
        const privateLeak = findPrivateReturnLeak(e.body, privateStateNames);
        if (privateLeak) {
          throw new Error(`entry '${e.name}' returns private '${privateLeak}' without 'when revealed'`);
        }
      }
    }
  }
  function checkBlock(b, env) {
    for (const s of b.stmts) checkStmt(s, env);
  }
  function checkStmt(s, env) {
    if (s.kind === 'block') return checkBlock(s, env);
    if (s.kind === 'assign') {
      const tgt = rootName(s.lhs);
      if (tgt && privateStateNames.has(tgt) && !(env.inBatch || env.inCtor)) {
        throw new Error(`writing private '${tgt}' requires @batch on the entry`);
      }
      return;
    }
    if (s.kind === 'if') { checkBlock(s.cons, env); if (s.alt) { if (s.alt.kind === 'block') checkBlock(s.alt, env); else checkStmt(s.alt, env); } return; }
    if (s.kind === 'emit' && !s.encrypted) {
      for (const a of s.args) {
        const r = rootName(a);
        if (r && privateStateNames.has(r)) {
          throw new Error(`event '${s.name}' references private '${r}' — use 'emit encrypted'`);
        }
      }
    }
  }
  function rootName(e) {
    if (!e) return null;
    if (e.kind === 'ident') return e.name;
    if (e.kind === 'member' || e.kind === 'index') return rootName(e.obj);
    return null;
  }
  function findPrivateReturnLeak(block, privSet) {
    for (const s of block.stmts) {
      if (s.kind === 'return') {
        const r = rootName(s.value);
        if (r && privSet.has(r)) return r;
      }
      if (s.kind === 'if') {
        const l = findPrivateReturnLeak(s.cons, privSet);
        if (l) return l;
        if (s.alt && s.alt.kind === 'block') {
          const l2 = findPrivateReturnLeak(s.alt, privSet);
          if (l2) return l2;
        }
      }
    }
    return null;
  }

  if (ast.ctor) checkEntry(ast.ctor, true);
  for (const e of ast.entries) checkEntry(e);

  return { ok: true, stateSlot, privateStateNames, publicStateNames };
}

/* ────────────────────────── flatten ────────────────────────── */

export function flattenContract(ast, resolveParent) {
  const withInheritance = linearizeInheritance(ast, resolveParent);
  return inlineModifiers(withInheritance);
}

function linearizeInheritance(ast, resolveParent) {
  if (!ast.parents || ast.parents.length === 0) {
    return cloneContract(ast);
  }
  const merged = {
    kind: 'contract',
    name: ast.name,
    parents: [],
    statevars: [],
    entries: [],
    events: [],
    modifiers: [],
    ctor: null,
    line: ast.line,
    col: ast.col,
  };

  for (const parentName of ast.parents) {
    if (typeof resolveParent !== 'function') {
      throw new Error(
        `contract '${ast.name}' inherits from '${parentName}' but no parent resolver was provided. ` +
        `Pass opts.resolveParent or opts.stdlibMap to compileSource().`,
      );
    }
    const parentAst = resolveParent(parentName);
    if (!parentAst) throw new Error(`parent contract '${parentName}' not found`);
    const parentFlat = linearizeInheritance(parentAst, resolveParent);
    mergeFrom(merged, parentFlat);
  }

  mergeFrom(merged, ast);

  return merged;
}

function mergeFrom(dst, src) {
  for (const sv of src.statevars || []) {
    const ex = dst.statevars.findIndex((x) => x.name === sv.name);
    if (ex >= 0) dst.statevars[ex] = sv;
    else dst.statevars.push(sv);
  }
  for (const ev of src.events || []) {
    const ex = dst.events.findIndex((x) => x.name === ev.name);
    if (ex >= 0) dst.events[ex] = ev;
    else dst.events.push(ev);
  }
  for (const m of src.modifiers || []) {
    const ex = dst.modifiers.findIndex((x) => x.name === m.name);
    if (ex >= 0) dst.modifiers[ex] = m;
    else dst.modifiers.push(m);
  }
  for (const e of src.entries || []) {
    const ex = dst.entries.findIndex((x) => x.name === e.name);
    if (ex >= 0) dst.entries[ex] = e;
    else dst.entries.push(e);
  }
  if (src.ctor) {
    if (!dst.ctor) {
      dst.ctor = {
        kind: 'ctor',
        params: [...src.ctor.params],
        body: { kind: 'block', stmts: [...src.ctor.body.stmts] },
        line: src.ctor.line,
        col: src.ctor.col,
      };
    } else {
      dst.ctor.params = [...dst.ctor.params, ...src.ctor.params];
      dst.ctor.body.stmts = [...dst.ctor.body.stmts, ...src.ctor.body.stmts];
    }
  }
}

function cloneContract(ast) {
  return JSON.parse(JSON.stringify(ast));
}

function inlineModifiers(ast) {
  const modsByName = new Map();
  for (const m of ast.modifiers || []) modsByName.set(m.name, m);

  const newEntries = [];
  for (const e of ast.entries) {
    if (!e.modifiers || e.modifiers.length === 0) {
      newEntries.push(e);
      continue;
    }
    const wrapped = applyEntryModifiers(e, modsByName);
    newEntries.push({ ...wrapped, modifiers: [] });
  }

  return { ...ast, entries: newEntries, modifiers: [] };
}

function applyEntryModifiers(entry, modsByName) {
  let innerBody = entry.body;
  for (let i = entry.modifiers.length - 1; i >= 0; i--) {
    const invocation = entry.modifiers[i];
    const def = modsByName.get(invocation.name);
    if (!def) {
      throw new Error(`modifier '${invocation.name}' not declared`);
    }
    if (def.params.length !== invocation.args.length) {
      throw new Error(
        `modifier '${invocation.name}' expects ${def.params.length} args, got ${invocation.args.length}`,
      );
    }
    innerBody = wrapWithModifier(def, invocation.args, innerBody);
  }
  return { ...entry, body: innerBody };
}

function wrapWithModifier(modDef, invocationArgs, innerBody) {
  const paramNames = new Set(modDef.params.map((p) => p.name));
  const renamedBody = renameParamRefs(modDef.body, paramNames);
  const substitutedStmts = substitutePlaceholder(renamedBody.stmts, innerBody);
  const paramLets = modDef.params.map((p, i) => ({
    kind: 'let',
    name: `__m_${p.name}`,
    ty: p.type,
    init: invocationArgs[i],
    line: p.line,
    col: p.col,
  }));

  return {
    kind: 'block',
    stmts: [...paramLets, ...substitutedStmts],
  };
}

function substitutePlaceholder(stmts, innerBody) {
  const out = [];
  for (const s of stmts) {
    if (isPlaceholder(s)) {
      out.push(...innerBody.stmts);
      continue;
    }
    if (s.kind === 'block') {
      out.push({ ...s, stmts: substitutePlaceholder(s.stmts, innerBody) });
      continue;
    }
    if (s.kind === 'if') {
      out.push({
        ...s,
        cons: { ...s.cons, stmts: substitutePlaceholder(s.cons.stmts, innerBody) },
        alt: s.alt
          ? (s.alt.kind === 'block'
            ? { ...s.alt, stmts: substitutePlaceholder(s.alt.stmts, innerBody) }
            : s.alt)
          : null,
      });
      continue;
    }
    out.push(s);
  }
  return out;
}

function isPlaceholder(s) {
  return (
    s &&
    s.kind === 'exprstmt' &&
    s.expr &&
    s.expr.kind === 'ident' &&
    s.expr.name === '_'
  );
}

function renameParamRefs(node, paramNames) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((x) => renameParamRefs(x, paramNames));
  if (node.kind === 'ident' && paramNames.has(node.name)) {
    return { ...node, name: `__m_${node.name}` };
  }
  const out = {};
  for (const k of Object.keys(node)) {
    out[k] = renameParamRefs(node[k], paramNames);
  }
  return out;
}

/** Build a parent resolver from a `{ Name: '<dsol src>' }` map.
 *  The IDE bundles its stdlib templates at build time and passes
 *  this map via `compileSource(src, { stdlibMap }).` */
export function makeStdlibResolver(stdlibMap) {
  if (!stdlibMap || typeof stdlibMap !== 'object') {
    throw new TypeError('makeStdlibResolver: stdlibMap must be an object');
  }
  return function resolveParent(name) {
    const src = stdlibMap[name];
    if (typeof src !== 'string') {
      throw new Error(`parent contract '${name}' not found in stdlibMap`);
    }
    const tokens = tokenize(src);
    return parse(tokens);
  };
}

/* ────────────────────────── codegen ────────────────────────── */

const OP = {
  PUSH_U64: 0x01, PUSH_BYTES: 0x02, POP: 0x03, DUP: 0x04, SWAP: 0x05,
  ADD_U64: 0x10, SUB_U64: 0x11, MUL_U64: 0x12, DIV_U64: 0x13, MOD_U64: 0x14,
  LT: 0x20, EQ: 0x21, NOT: 0x22, AND: 0x23, OR: 0x24,
  JUMP: 0x30, JUMPI: 0x31, RETURN: 0x32, REVERT: 0x33,
  SLOAD: 0x40, SSTORE: 0x41, SSTORE_PRIV: 0x42,
  COMMIT_U64: 0x50, RANGEPROOF: 0x51, NULLIFIER: 0x52, REVEAL: 0x53,
  SYSCALL: 0x60,
  MSG_SENDER: 0x70, BLOCK_NUMBER: 0x71, CONTRACT_ID: 0x72, TX_HASH: 0x73,
  SHA256: 0x80, EMIT: 0x90,
  LOCAL_GET: 0xa0, LOCAL_SET: 0xa1, ALLOC_LOCALS: 0xa2,
  U64_FROM_BYTES: 0xa3, U64_TO_BYTES: 0xa4,
  MAP_LOAD: 0xa5, MAP_STORE: 0xa6, MAP_STORE_PRIV: 0xa7,
  CONCAT: 0xa8, BYTES_LEN: 0xa9, STR_EQ: 0xaa,
};

const SYSCALL_ID = {
  TOKEN_TRANSFER_EMIT_V1: 0x0101,
  TOKEN_MINT_SUPPLY_V1:   0x0102,
  LP_MINT_V1:    0x0201,
  LP_BURN_V1:    0x0202,
  BRIDGE_UNWRAP_EMIT_V1: 0x0301,
  NFT_MINT_V1:     0x0401,
  NFT_TRANSFER_V1: 0x0402,
  READ_BALANCE_V1: 0x0500,
  READ_BLOCK_V1:   0x0501,
  EXT_CALL_TAIL_V1: 0x0601,
};

function entrypointSelector(name) {
  return sha256Sync(String(name)).slice(0, 4);
}

function makeBuf() {
  const chunks = []; let size = 0;
  const pendingJumps = []; const labels = new Map();
  return {
    pushByte(b) { chunks.push(new Uint8Array([b & 0xff])); size += 1; },
    pushU16(v) { const a = new Uint8Array(2); a[0] = v & 0xff; a[1] = (v >> 8) & 0xff; chunks.push(a); size += 2; },
    pushU32(v) { const a = new Uint8Array(4); a[0] = v & 0xff; a[1] = (v >> 8) & 0xff; a[2] = (v >> 16) & 0xff; a[3] = (v >>> 24) & 0xff; chunks.push(a); size += 4; },
    pushU64LE(big) { const v = BigInt(big) & ((1n << 64n) - 1n); const a = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { a[i] = Number(x & 0xffn); x >>= 8n; } chunks.push(a); size += 8; },
    pushBytes(b) { const bb = b instanceof Uint8Array ? b : Uint8Array.from(b); chunks.push(bb); size += bb.length; },
    placeJump(label) { pendingJumps.push({ pcOffset: size, label }); chunks.push(new Uint8Array(4)); size += 4; },
    defineLabel(label) { labels.set(label, size); },
    get size() { return size; },
    resolve() {
      const out = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      for (const { pcOffset, label } of pendingJumps) {
        if (!labels.has(label)) throw new Error(`unresolved label ${label}`);
        const target = labels.get(label);
        out[pcOffset] = target & 0xff; out[pcOffset + 1] = (target >> 8) & 0xff;
        out[pcOffset + 2] = (target >> 16) & 0xff; out[pcOffset + 3] = (target >>> 24) & 0xff;
      }
      return out;
    },
  };
}

let labelCounter = 0;
const makeLabel = (p) => `${p}_${labelCounter++}`;

export function compile(ast, analysis) {
  labelCounter = 0;
  const { stateSlot, privateStateNames } = analysis;

  const stateMeta = new Map();
  for (const sv of ast.statevars) {
    stateMeta.set(sv.name, {
      slot: stateSlot.get(sv.name),
      isMapping: sv.type.name === 'mapping',
      isPrivate: privateStateNames.has(sv.name),
      keyType: sv.type.keyType ? sv.type.keyType.name : null,
      valueType: (sv.type.keyType ? sv.type.valueType.name : sv.type.name),
    });
  }

  const buf = makeBuf();
  const codeBuf = makeBuf();
  const entrypointOffsets = [];
  const sourceMap = [];

  if (ast.ctor) {
    entrypointOffsets.push({ name: 'constructor', offset: codeBuf.size });
    emitEntry(codeBuf, { name: 'constructor', params: ast.ctor.params, body: ast.ctor.body, returns: null, attrs: [] });
  }
  for (const e of ast.entries) {
    entrypointOffsets.push({ name: e.name, offset: codeBuf.size });
    emitEntry(codeBuf, e);
  }

  buf.pushByte(0x01);
  buf.pushU32(entrypointOffsets.length);
  for (const ep of entrypointOffsets) {
    buf.pushBytes(entrypointSelector(ep.name));
    buf.pushU32(ep.offset);
  }
  const headerSize = buf.size;
  buf.pushBytes(codeBuf.resolve());
  return { bytecode: buf.resolve(), sourceMap: sourceMap.map((s) => ({ ...s, pc: s.pc + headerSize })) };

  function emitEntry(b, e) {
    const locals = {};
    let nextIdx = 0;
    for (const p of e.params) { locals[p.name] = { idx: nextIdx++, ty: p.type.name }; }
    collectLets(e.body, locals, () => nextIdx++);
    const totalLocals = Object.keys(locals).length;

    if (totalLocals > 0) { b.pushByte(OP.ALLOC_LOCALS); b.pushByte(totalLocals); }
    for (let i = e.params.length - 1; i >= 0; i--) {
      const name = e.params[i].name;
      b.pushByte(OP.LOCAL_SET); b.pushByte(locals[name].idx);
    }

    emitBlock(b, e.body, { locals, entry: e });
    b.pushByte(OP.RETURN);
  }

  function collectLets(block, locals, alloc) {
    for (const s of block.stmts) {
      if (s.kind === 'let') {
        if (locals[s.name]) throw new Error(`duplicate local '${s.name}'`);
        locals[s.name] = { idx: alloc(), ty: s.ty ? s.ty.name : 'u64' };
      } else if (s.kind === 'if') {
        collectLets(s.cons, locals, alloc);
        if (s.alt && s.alt.kind === 'block') collectLets(s.alt, locals, alloc);
      } else if (s.kind === 'block') {
        collectLets(s, locals, alloc);
      }
    }
  }

  function emitBlock(b, block, env) {
    for (const s of block.stmts) emitStmt(b, s, env);
  }

  function markPos(b, node) {
    if (node && node.line != null) sourceMap.push({ pc: b.size, line: node.line, col: node.col });
  }

  function emitStmt(b, s, env) {
    markPos(b, s);
    if (s.kind === 'block') return emitBlock(b, s, env);
    if (s.kind === 'let') {
      emitExpr(b, s.init, env);
      b.pushByte(OP.LOCAL_SET); b.pushByte(env.locals[s.name].idx);
      return;
    }
    if (s.kind === 'return') {
      if (s.value) emitExpr(b, s.value, env);
      b.pushByte(OP.RETURN);
      return;
    }
    if (s.kind === 'require') {
      const ok = makeLabel('req_ok');
      emitExpr(b, s.cond, env);
      b.pushByte(OP.JUMPI); b.placeJump(ok);
      if (s.message) emitExpr(b, s.message, env);
      else { b.pushByte(OP.PUSH_BYTES); b.pushU16(0); }
      b.pushByte(OP.REVERT);
      b.defineLabel(ok);
      return;
    }
    if (s.kind === 'assign') {
      emitAssign(b, s, env);
      return;
    }
    if (s.kind === 'if') {
      const endL = makeLabel('if_end');
      const elseL = makeLabel('if_else');
      emitExpr(b, s.cond, env);
      b.pushByte(OP.NOT);
      b.pushByte(OP.JUMPI); b.placeJump(elseL);
      emitBlock(b, s.cons, env);
      b.pushByte(OP.JUMP); b.placeJump(endL);
      b.defineLabel(elseL);
      if (s.alt) {
        if (s.alt.kind === 'block') emitBlock(b, s.alt, env);
        else emitStmt(b, s.alt, env);
      }
      b.defineLabel(endL);
      return;
    }
    if (s.kind === 'emit') {
      const topic = sha256Sync('evt:' + s.name).slice(0, 8);
      b.pushByte(OP.PUSH_BYTES); b.pushU16(topic.length); b.pushBytes(topic);
      if (!s.args.length) {
        b.pushByte(OP.PUSH_BYTES); b.pushU16(0);
      } else {
        emitExpr(b, s.args[0], env);
        coerceToBytes(b, s.args[0], env);
        for (let i = 1; i < s.args.length; i++) {
          emitExpr(b, s.args[i], env);
          coerceToBytes(b, s.args[i], env);
          b.pushByte(OP.CONCAT);
        }
      }
      b.pushByte(OP.EMIT);
      return;
    }
    if (s.kind === 'exprstmt') {
      emitExpr(b, s.expr, env);
      b.pushByte(OP.POP);
      return;
    }
    if (s.kind === 'syscall') {
      const id = SYSCALL_ID[s.op] || (s.op.startsWith('0x') ? parseInt(s.op, 16) : null);
      if (id == null) throw new Error(`unknown syscall op '${s.op}'`);
      emitExpr(b, s.argv, env);
      coerceToBytes(b, s.argv, env);
      b.pushByte(OP.SYSCALL); b.pushU16(id);
      b.pushByte(OP.POP);
      return;
    }
    throw new Error(`unsupported stmt '${s.kind}'`);
  }

  function emitAssign(b, s, env) {
    if (s.lhs.kind === 'ident') {
      const name = s.lhs.name;
      if (env.locals[name]) {
        if (s.op === '=') {
          emitExpr(b, s.rhs, env);
        } else {
          b.pushByte(OP.LOCAL_GET); b.pushByte(env.locals[name].idx);
          emitExpr(b, s.rhs, env);
          if (s.op === '+=') b.pushByte(OP.ADD_U64);
          else if (s.op === '-=') b.pushByte(OP.SUB_U64);
          else if (s.op === '*=') b.pushByte(OP.MUL_U64);
          else if (s.op === '/=') b.pushByte(OP.DIV_U64);
        }
        b.pushByte(OP.LOCAL_SET); b.pushByte(env.locals[name].idx);
        return;
      }
      if (!stateMeta.has(name)) throw new Error(`assign to unknown '${name}'`);
      const meta = stateMeta.get(name);
      if (meta.isMapping) throw new Error(`cannot assign to mapping '${name}' without a key`);
      emitSlotKeyScalar(b, meta.slot);
      if (s.op !== '=') {
        emitSlotKeyScalar(b, meta.slot);
        b.pushByte(OP.SLOAD);
        b.pushByte(OP.U64_FROM_BYTES);
        emitExpr(b, s.rhs, env);
        coerceToU64(b, s.rhs, env);
        if (s.op === '+=') b.pushByte(OP.ADD_U64);
        else if (s.op === '-=') b.pushByte(OP.SUB_U64);
        else if (s.op === '*=') b.pushByte(OP.MUL_U64);
        else if (s.op === '/=') b.pushByte(OP.DIV_U64);
        b.pushByte(OP.U64_TO_BYTES);
      } else {
        emitExpr(b, s.rhs, env);
        coerceScalarToStateBytes(b, meta, s.rhs, env);
      }
      b.pushByte(meta.isPrivate ? OP.SSTORE_PRIV : OP.SSTORE);
      return;
    }
    if (s.lhs.kind === 'index') {
      const base = s.lhs.obj;
      if (base.kind !== 'ident' || !stateMeta.has(base.name)) {
        throw new Error(`mapping write requires identifier base (got '${base.kind}')`);
      }
      const meta = stateMeta.get(base.name);
      if (!meta.isMapping) throw new Error(`'${base.name}' is not a mapping`);
      emitMapBaseBytes(b, meta.slot);
      emitExpr(b, s.lhs.idx, env);
      coerceToBytes(b, s.lhs.idx, env);
      if (s.op !== '=') {
        emitMapBaseBytes(b, meta.slot);
        emitExpr(b, s.lhs.idx, env);
        coerceToBytes(b, s.lhs.idx, env);
        b.pushByte(OP.MAP_LOAD);
        b.pushByte(OP.U64_FROM_BYTES);
        emitExpr(b, s.rhs, env);
        coerceToU64(b, s.rhs, env);
        if (s.op === '+=') b.pushByte(OP.ADD_U64);
        else if (s.op === '-=') b.pushByte(OP.SUB_U64);
        else if (s.op === '*=') b.pushByte(OP.MUL_U64);
        else if (s.op === '/=') b.pushByte(OP.DIV_U64);
        b.pushByte(OP.U64_TO_BYTES);
      } else {
        emitExpr(b, s.rhs, env);
        coerceToBytes(b, s.rhs, env);
      }
      b.pushByte(meta.isPrivate ? OP.MAP_STORE_PRIV : OP.MAP_STORE);
      return;
    }
    throw new Error(`unsupported assign LHS kind '${s.lhs.kind}'`);
  }

  function emitSlotKeyScalar(b, slotId) {
    const idBuf = new Uint8Array(4);
    idBuf[0] = slotId & 0xff; idBuf[1] = (slotId >> 8) & 0xff;
    const k = sha256Sync(idBuf);
    b.pushByte(OP.PUSH_BYTES); b.pushU16(k.length); b.pushBytes(k);
  }
  function emitMapBaseBytes(b, slotId) {
    const idBuf = new Uint8Array(5);
    idBuf[0] = 0x4d; // 'M'
    idBuf[1] = slotId & 0xff; idBuf[2] = (slotId >> 8) & 0xff;
    const k = sha256Sync(idBuf);
    b.pushByte(OP.PUSH_BYTES); b.pushU16(k.length); b.pushBytes(k);
  }

  function inferType(e, env) {
    if (!e) return 'u64';
    if (e.kind === 'num' || e.kind === 'bool') return 'u64';
    if (e.kind === 'str') return 'bytes';
    if (e.kind === 'ctx') {
      if (e.field === 'msg.sender') return 'bytes';
      if (e.field === 'block.number') return 'u64';
      if (e.field === 'ctx.txHash' || e.field === 'ctx.contractId') return 'bytes';
    }
    if (e.kind === 'ident' && env.locals && env.locals[e.name]) {
      const ty = env.locals[e.name].ty;
      if (ty === 'uint64' || ty === 'uint8' || ty === 'int64' || ty === 'bool') return 'u64';
      return 'bytes';
    }
    if (e.kind === 'ident' && stateMeta.has(e.name)) {
      const meta = stateMeta.get(e.name);
      return (meta.valueType === 'uint64' || meta.valueType === 'uint8' || meta.valueType === 'bool') ? 'u64' : 'bytes';
    }
    if (e.kind === 'bin') return 'u64';
    if (e.kind === 'unary') return 'u64';
    if (e.kind === 'index') {
      const base = e.obj;
      if (base.kind === 'ident' && stateMeta.has(base.name)) {
        const meta = stateMeta.get(base.name);
        if (meta.valueType === 'uint64' || meta.valueType === 'bool') return 'u64';
      }
      return 'bytes';
    }
    if (e.kind === 'syscall') return 'bytes';
    return 'bytes';
  }
  function coerceToBytes(b, e, env) {
    if (inferType(e, env) === 'u64') b.pushByte(OP.U64_TO_BYTES);
  }
  function coerceToU64(b, e, env) {
    if (inferType(e, env) === 'bytes') b.pushByte(OP.U64_FROM_BYTES);
  }
  function coerceScalarToStateBytes(b, meta, e, env) {
    if (meta.valueType === 'uint64' || meta.valueType === 'bool') {
      coerceToBytes(b, e, env);
    } else {
      coerceToBytes(b, e, env);
    }
  }

  function emitExpr(b, e, env) {
    markPos(b, e);
    if (e.kind === 'num') {
      b.pushByte(OP.PUSH_U64);
      b.pushU64LE(BigInt(e.value));
      return;
    }
    if (e.kind === 'bool') {
      b.pushByte(OP.PUSH_U64);
      b.pushU64LE(e.value ? 1n : 0n);
      return;
    }
    if (e.kind === 'str') {
      const data = new TextEncoder().encode(e.value);
      b.pushByte(OP.PUSH_BYTES); b.pushU16(data.length); b.pushBytes(data);
      return;
    }
    if (e.kind === 'ctx') {
      if (e.field === 'msg.sender') { b.pushByte(OP.MSG_SENDER); return; }
      if (e.field === 'block.number') { b.pushByte(OP.BLOCK_NUMBER); return; }
      if (e.field === 'ctx.txHash') { b.pushByte(OP.TX_HASH); return; }
      if (e.field === 'ctx.contractId') { b.pushByte(OP.CONTRACT_ID); return; }
      throw new Error(`unsupported ctx field '${e.field}'`);
    }
    if (e.kind === 'ident') {
      if (env.locals && env.locals[e.name]) {
        b.pushByte(OP.LOCAL_GET); b.pushByte(env.locals[e.name].idx);
        return;
      }
      if (stateMeta.has(e.name)) {
        const meta = stateMeta.get(e.name);
        if (meta.isMapping) throw new Error(`mapping '${e.name}' needs a [key]`);
        emitSlotKeyScalar(b, meta.slot);
        b.pushByte(OP.SLOAD);
        if (meta.valueType === 'uint64' || meta.valueType === 'uint8' || meta.valueType === 'bool') {
          b.pushByte(OP.U64_FROM_BYTES);
        }
        return;
      }
      throw new Error(`unknown identifier '${e.name}'`);
    }
    if (e.kind === 'bin') {
      emitExpr(b, e.lhs, env);
      if (e.op === '==' || e.op === '!=') {
        const bothU64 = inferType(e.lhs, env) === 'u64' && inferType(e.rhs, env) === 'u64';
        if (bothU64) {
          emitExpr(b, e.rhs, env);
          b.pushByte(OP.EQ);
        } else {
          coerceToBytes(b, e.lhs, env);
          emitExpr(b, e.rhs, env);
          coerceToBytes(b, e.rhs, env);
          b.pushByte(OP.STR_EQ);
        }
        if (e.op === '!=') b.pushByte(OP.NOT);
        return;
      }
      coerceToU64(b, e.lhs, env);
      emitExpr(b, e.rhs, env);
      coerceToU64(b, e.rhs, env);
      switch (e.op) {
        case '+': b.pushByte(OP.ADD_U64); return;
        case '-': b.pushByte(OP.SUB_U64); return;
        case '*': b.pushByte(OP.MUL_U64); return;
        case '/': b.pushByte(OP.DIV_U64); return;
        case '%': b.pushByte(OP.MOD_U64); return;
        case '<': b.pushByte(OP.LT); return;
        case '>': b.pushByte(OP.SWAP); b.pushByte(OP.LT); return;
        case '<=': b.pushByte(OP.SWAP); b.pushByte(OP.LT); b.pushByte(OP.NOT); return;
        case '>=': b.pushByte(OP.LT); b.pushByte(OP.NOT); return;
        case '&&': b.pushByte(OP.AND); return;
        case '||': b.pushByte(OP.OR); return;
      }
      throw new Error(`unsupported bin op '${e.op}'`);
    }
    if (e.kind === 'unary') {
      emitExpr(b, e.expr, env);
      if (e.op === '!') { b.pushByte(OP.NOT); return; }
      if (e.op === '-') {
        b.pushByte(OP.PUSH_U64); b.pushU64LE(0n);
        b.pushByte(OP.SWAP);
        b.pushByte(OP.SUB_U64);
        return;
      }
      throw new Error(`unsupported unary '${e.op}'`);
    }
    if (e.kind === 'index') {
      const base = e.obj;
      if (base.kind !== 'ident' || !stateMeta.has(base.name)) {
        throw new Error(`mapping read requires identifier base`);
      }
      const meta = stateMeta.get(base.name);
      if (!meta.isMapping) throw new Error(`'${base.name}' is not a mapping`);
      emitMapBaseBytes(b, meta.slot);
      emitExpr(b, e.idx, env);
      coerceToBytes(b, e.idx, env);
      b.pushByte(OP.MAP_LOAD);
      if (meta.valueType === 'uint64' || meta.valueType === 'uint8' || meta.valueType === 'bool') {
        b.pushByte(OP.U64_FROM_BYTES);
      }
      return;
    }
    if (e.kind === 'syscall') {
      const id = SYSCALL_ID[e.op] || (e.op.startsWith('0x') ? parseInt(e.op, 16) : null);
      if (id == null) throw new Error(`unknown syscall op '${e.op}'`);
      emitExpr(b, e.argv, env);
      coerceToBytes(b, e.argv, env);
      b.pushByte(OP.SYSCALL); b.pushU16(id);
      return;
    }
    throw new Error(`unsupported expr '${e.kind}'`);
  }
}

/* ────────────────────────── compileSource (entry point) ────────────────────────── */

function buildAbi(ast, analysis) {
  const entrypoints = [];
  if (ast.ctor) {
    entrypoints.push({
      name: 'constructor',
      batch: true,
      returns: null,
      args: ast.ctor.params.map((p) => ({ name: p.name, type: abiType(p.type) })),
    });
  }
  for (const e of ast.entries) {
    const isBatch = e.attrs.includes('batch');
    const isDirect = e.attrs.includes('direct');
    const batch = isBatch || (!isDirect);
    entrypoints.push({
      name: e.name,
      selector: sha256SyncHex(e.name).slice(0, 8),
      batch,
      highRisk: e.attrs.includes('highrisk'),
      returns: e.returns
        ? (e.returns.whenRevealed ? abiType(e.returns.type) + '-revealed' : abiType(e.returns.type))
        : null,
      args: e.params.map((p) => ({ name: p.name, type: abiType(p.type) })),
    });
  }
  return {
    version: 1,
    name: ast.name,
    entrypoints,
    state: ast.statevars.map((sv) => ({
      name: sv.name,
      kind: sv.type.name === 'mapping' ? 'mapping' : 'scalar',
      slot: analysis.stateSlot.get(sv.name),
      private: !!sv.isPrivate,
      valueType: sv.type.name === 'mapping' ? abiType(sv.type.valueType) : abiType(sv.type),
      keyType: sv.type.name === 'mapping' ? abiType(sv.type.keyType) : null,
    })),
    events: ast.events.map((ev) => ({
      name: ev.name,
      args: ev.params.map((p) => ({ name: p.name, type: abiType(p.type) })),
    })),
  };
}
function abiType(t) {
  if (!t) return 'void';
  if (t.name === 'mapping') return `mapping(${abiType(t.keyType)}=>${abiType(t.valueType)})`;
  return t.name;
}

/** Browser-side entry point. Returns { bytecode, abi, codeHash, source, ast, sourceMap }.
 *
 * `opts.resolveParent` overrides parent resolution. If absent and
 * `opts.stdlibMap` is provided, `makeStdlibResolver(stdlibMap)` is used.
 * Inheriting contracts without a resolver throw a clear error. */
export function compileSource(src, opts = {}) {
  let resolveParent = opts.resolveParent;
  if (!resolveParent && opts.stdlibMap) {
    resolveParent = makeStdlibResolver(opts.stdlibMap);
  }
  const tokens = tokenize(src);
  const parsed = parse(tokens);
  const ast = flattenContract(parsed, resolveParent);
  const analysis = typecheck(ast);
  const { bytecode, sourceMap } = compile(ast, analysis);
  const abi = buildAbi(ast, analysis);
  abi.sourceMap = sourceMap;
  const codeHash = sha256SyncHex(bytecode);
  return { bytecode, abi, codeHash, source: src, ast, sourceMap };
}

/** Identifier exposed for IDE-5 / IDE-14 parity tests + diagnostics. */
export const COMPILER_VERSION_TAG = 'dsol-compiler-browser-mirror/v1';
