/* DSOL Monaco language definition.
 *
 * Registered once on first Monaco mount. Provides:
 *   - Monarch tokenizer (keywords, types, attrs, syscalls, strings, numbers, comments)
 *   - HoverProvider — reads cached AST after each compile
 *   - CompletionItemProvider — stdlib symbols + AST identifiers
 *   - DiagnosticsProvider — surfaces compile errors as red squiggles
 *
 * IDE-7 invariant: keyword set MUST mirror LANGUAGE.md. The static-test
 * `tests/static/lang-parity.test.js` parses LANGUAGE.md keyword tables
 * and asserts coverage here.
 */

const LANGUAGE_ID = 'dsol';

// ─── Keyword inventory pulled from LANGUAGE.md ───
const KEYWORDS = [
  'dark', 'contract', 'is',
  'constructor', 'entry', 'modifier',
  'private', 'public', 'returns', 'when', 'revealed', 'encrypted',
  'mapping', 'emit',
  'if', 'else', 'while', 'for', 'do',
  'return', 'break', 'continue',
  'require', 'syscall',
  'let', 'true', 'false', 'null',
  'this', 'self',
];

const TYPES = [
  'uint8', 'uint16', 'uint32', 'uint64', 'uint128', 'uint256',
  'bool', 'string', 'bytes',
  'stealth', 'address', 'commitment',
];

const ATTRS = ['@batch', '@direct', '@highrisk', '@view', '@payable'];

const SYSCALLS = [
  'TOKEN_TRANSFER_EMIT_V1',
  'TOKEN_MINT_SUPPLY_V1',
  'LP_MINT_V1',
  'LP_BURN_V1',
  'BRIDGE_UNWRAP_EMIT_V1',
  'NFT_MINT_V1',
  'NFT_TRANSFER_V1',
  'READ_BALANCE_V1',
  'READ_BLOCK_V1',
  'EXT_CALL_TAIL_V1',
];

const BUILTINS = [
  'msg', 'block', 'tx',           // msg.sender, block.number, tx.fee
  'sender', 'value', 'data',
  'number', 'timestamp', 'fee',
];

const STDLIB_CONTRACTS = [
  'Ownable', 'Pausable', 'ReentrancyGuard',
  'Erc20Private', 'NftCollection', 'PausableToken',
];

// Cache last AST + diagnostics keyed by Monaco model URI.
const astByUri = new Map();
const errorsByUri = new Map();

/** Register everything with a Monaco runtime. Idempotent: subsequent calls
 * with the same `monaco` are no-ops. */
let registered = false;

export function registerDsolLanguage(monaco) {
  if (registered) return;
  registered = true;

  monaco.languages.register({
    id: LANGUAGE_ID,
    extensions: ['.dsol'],
    aliases: ['DSOL', 'DarkSolidity', 'dsol'],
    mimetypes: ['text/x-dsol'],
  });

  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{',  close: '}' },
      { open: '[',  close: ']' },
      { open: '(',  close: ')' },
      { open: '"',  close: '"' },
      { open: "'",  close: "'" },
      { open: '/*', close: '*/' },
    ],
    surroundingPairs: [
      { open: '{',  close: '}' },
      { open: '[',  close: ']' },
      { open: '(',  close: ')' },
      { open: '"',  close: '"' },
      { open: "'",  close: "'" },
    ],
    indentationRules: {
      increaseIndentPattern: /(\{[^}"']*$|\([^)"']*$|\[[^\]"']*$)/,
      decreaseIndentPattern: /^\s*[}\])]/,
    },
    folding: {
      markers: {
        start: new RegExp('^\\s*//\\s*#region\\b'),
        end:   new RegExp('^\\s*//\\s*#endregion\\b'),
      },
    },
  });

  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    defaultToken: 'invalid',
    tokenPostfix: '.dsol',

    keywords:  KEYWORDS,
    typeKeywords: TYPES,
    syscalls:  SYSCALLS,
    builtins:  BUILTINS,
    contracts: STDLIB_CONTRACTS,

    operators: [
      '=', '==', '!=', '<', '<=', '>', '>=',
      '+', '-', '*', '/', '%',
      '+=', '-=', '*=', '/=',
      '&&', '||', '!', '&', '|', '^', '~',
      '<<', '>>',
      '?', ':', '=>',
    ],

    symbols:  /[=><!~?:&|+\-*/^%]+/,
    escapes:  /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    tokenizer: {
      root: [
        // Annotations / attributes
        [/@(batch|direct|highrisk|view|payable)\b/, 'attribute'],

        // Identifiers and keywords
        [/[A-Z][\w$]*/, {
          cases: {
            '@contracts':    'type.contract',
            '@typeKeywords': 'type',
            '@syscalls':     'constant.syscall',
            '@default':      'type.identifier',
          },
        }],
        [/[a-z_$][\w$]*/, {
          cases: {
            '@keywords':     'keyword',
            '@typeKeywords': 'type',
            '@builtins':     'variable.predefined',
            '@default':      'identifier',
          },
        }],

        // Whitespace and comments
        { include: '@whitespace' },

        // Brackets and delimiters
        [/[{}()[\]]/, '@brackets'],
        [/[<>](?!@symbols)/, '@brackets'],

        // Numbers
        [/0[xX][0-9a-fA-F_]+/,         'number.hex'],
        [/0[bB][01_]+/,                 'number.binary'],
        [/\d+_?[\d_]*[eE][-+]?\d+/,    'number.float'],
        [/\d+\.\d+([eE][-+]?\d+)?/,    'number.float'],
        [/\d[\d_]*/,                    'number'],

        // Strings
        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/'([^'\\]|\\.)*$/, 'string.invalid'],
        [/"/,  { token: 'string.quote', bracket: '@open', next: '@string_d' }],
        [/'/,  { token: 'string.quote', bracket: '@open', next: '@string_s' }],

        // Operators
        [/@symbols/, {
          cases: {
            '@operators': 'operator',
            '@default':   '',
          },
        }],

        // Stealth-address literal: ion1_… or stealth:0x…
        [/(?:ion1_)[a-z0-9]+/,  'string.stealth'],
        [/(?:dc1_)[a-z0-9]+/,   'string.contract-id'],

        // Delimiters
        [/[;,.]/, 'delimiter'],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/\/\*/,        { token: 'comment.quote', next: '@comment' }],
        [/\/\/.*$/,      'comment'],
      ],

      comment: [
        [/[^/*]+/,      'comment'],
        [/\*\//,         { token: 'comment.quote', next: '@pop' }],
        [/[/*]/,         'comment'],
      ],

      string_d: [
        [/[^\\"]+/,      'string'],
        [/@escapes/,     'string.escape'],
        [/\\./,          'string.escape.invalid'],
        [/"/,            { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],
      string_s: [
        [/[^\\']+/,      'string'],
        [/@escapes/,     'string.escape'],
        [/\\./,          'string.escape.invalid'],
        [/'/,            { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],
    },
  });

  // ─── Hover ───
  monaco.languages.registerHoverProvider(LANGUAGE_ID, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const sym = word.word;
      const ast = astByUri.get(model.uri.toString());
      const doc = lookupDoc(sym, ast);
      if (!doc) return null;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: doc.map(line => ({ value: line })),
      };
    },
  });

  // ─── Completions ───
  monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: ['.', ':'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const suggestions = [];
      const ast = astByUri.get(model.uri.toString());

      // Keywords
      for (const k of KEYWORDS) {
        suggestions.push({
          label: k,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: k,
          range,
        });
      }
      // Types
      for (const t of TYPES) {
        suggestions.push({
          label: t,
          kind: monaco.languages.CompletionItemKind.TypeParameter,
          insertText: t,
          range,
        });
      }
      // Syscalls
      for (const s of SYSCALLS) {
        suggestions.push({
          label: s,
          kind: monaco.languages.CompletionItemKind.Constant,
          insertText: s,
          documentation: { value: `Syscall: \`${s}\` — see LANGUAGE.md syscall table.` },
          range,
        });
      }
      // Stdlib contracts
      for (const c of STDLIB_CONTRACTS) {
        suggestions.push({
          label: c,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: c,
          documentation: { value: `Stdlib contract: \`${c}\`.` },
          range,
        });
      }
      // AST-derived identifiers
      if (ast?.identifiers) {
        for (const id of ast.identifiers) {
          suggestions.push({
            label: id.name,
            kind: identifierKindToMonaco(monaco, id.kind),
            insertText: id.name,
            detail: id.detail || '',
            range,
          });
        }
      }
      return { suggestions };
    },
  });

  // ─── Snippets ───
  monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: ['d', 'e', 'c'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: [
          {
            label: 'contract',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: [
              'dark contract ${1:Name} {',
              '  ${2:// state vars}',
              '',
              '  constructor() {',
              '    ${3:// runs once at deploy time}',
              '  }',
              '',
              '  @direct',
              '  entry ${4:doSomething}() {',
              '    ${5:// body}',
              '  }',
              '}',
            ].join('\n'),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: 'Skeleton contract.' },
            range,
          },
          {
            label: 'entry-batch',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: [
              '@batch',
              'entry ${1:transfer}(${2:stealth to}, ${3:uint64 amount}) {',
              '  ${0:// commit-reveal body}',
              '}',
            ].join('\n'),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: 'Front-run-proof entrypoint (commit + reveal).' },
            range,
          },
          {
            label: 'entry-direct',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: [
              '@direct',
              'entry ${1:get}() returns (${2:uint64 when revealed}) {',
              '  return ${0:value};',
              '}',
            ].join('\n'),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: 'One-shot read-only entrypoint.' },
            range,
          },
          {
            label: 'modifier-onlyOwner',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: [
              'modifier ${1:onlyOwner}() {',
              '  require(msg.sender == ${2:owner}, "${3:NOT_OWNER}");',
              '  _;',
              '}',
            ].join('\n'),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          },
        ],
      };
    },
  });

  // ─── Theme — must match --syn-* design tokens ───
  monaco.editor.defineTheme('monerousd-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '',                     foreground: 'f5f5f5' },
      { token: 'comment',              foreground: '6a6a6a', fontStyle: 'italic' },
      { token: 'comment.quote',        foreground: '6a6a6a', fontStyle: 'italic' },
      { token: 'keyword',              foreground: 'FF8833', fontStyle: 'bold' },
      { token: 'attribute',            foreground: 'fb923c', fontStyle: 'bold' },
      { token: 'type',                 foreground: 'facc15' },
      { token: 'type.identifier',      foreground: 'fde047' },
      { token: 'type.contract',        foreground: 'fde68a' },
      { token: 'identifier',           foreground: 'f5f5f5' },
      { token: 'variable.predefined',  foreground: '93c5fd' },
      { token: 'constant.syscall',     foreground: 'f0abfc', fontStyle: 'bold' },
      { token: 'string',               foreground: '86efac' },
      { token: 'string.escape',        foreground: '4ade80' },
      { token: 'string.invalid',       foreground: 'ef4444' },
      { token: 'string.stealth',       foreground: 'a78bfa' },
      { token: 'string.contract-id',   foreground: 'a78bfa' },
      { token: 'number',               foreground: 'f0abfc' },
      { token: 'number.hex',           foreground: 'f0abfc' },
      { token: 'number.binary',        foreground: 'f0abfc' },
      { token: 'number.float',         foreground: 'f0abfc' },
      { token: 'operator',             foreground: 'f5f5f5' },
      { token: 'delimiter',            foreground: 'a0a0a0' },
      { token: 'invalid',              foreground: 'ef4444' },
    ],
    colors: {
      'editor.background':            '#2a2a2a',
      'editor.foreground':            '#f5f5f5',
      'editor.lineHighlightBackground':'#1f1f1f',
      'editor.selectionBackground':   '#FF66001f',
      'editor.inactiveSelectionBackground':'#FF660014',
      'editorCursor.foreground':      '#FF6600',
      'editorWhitespace.foreground':  '#3a3a3a',
      'editorIndentGuide.background': '#2f2f2f',
      'editorIndentGuide.activeBackground':'#3a3a3a',
      'editorLineNumber.foreground':  '#6a6a6a',
      'editorLineNumber.activeForeground':'#FF6600',
      'editorBracketMatch.background':'#FF660030',
      'editorBracketMatch.border':    '#FF6600',
      'scrollbarSlider.background':   '#3a3a3a80',
      'scrollbarSlider.hoverBackground':'#4a4a4a',
      'scrollbarSlider.activeBackground':'#FF660060',
      'editorWidget.background':      '#333333',
      'editorWidget.border':          '#3a3a3a',
      'editorSuggestWidget.background':'#333333',
      'editorSuggestWidget.border':   '#3a3a3a',
      'editorSuggestWidget.selectedBackground':'#3a2410',
      'editorError.foreground':       '#ef4444',
      'editorWarning.foreground':     '#f59e0b',
      'editorInfo.foreground':        '#38bdf8',
    },
  });
}

function identifierKindToMonaco(monaco, kind) {
  const k = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'function': return k.Function;
    case 'method':   return k.Method;
    case 'variable': return k.Variable;
    case 'param':    return k.Variable;
    case 'state':    return k.Property;
    case 'mapping':  return k.Property;
    case 'event':    return k.Event;
    case 'modifier': return k.Function;
    default:         return k.Text;
  }
}

function lookupDoc(symbol, ast) {
  // Built-in keyword docs
  const keywordDocs = {
    private:  ['**`private` state**', 'Stored on-chain as a Pedersen commitment.', 'Reading requires `returns (… when revealed)`.'],
    public:   ['**`public` state**', 'Plain on-chain. Readable via `/v1/contracts/:id`.'],
    revealed: ['**`when revealed`**', 'Opens the return commitment to the caller\'s viewkey with a Bulletproofs+ range proof.'],
    encrypted:['**`emit encrypted`**', 'Wraps the event payload with AES-256-GCM bound to the caller\'s viewkey.'],
    syscall:  ['**`syscall(…)`**', 'Allowlisted external effect. Unknown syscalls abort with `SYSCALL_UNKNOWN`.'],
    require:  ['**`require(cond, msg)`**', 'Aborts on false; tx fee is consumed.'],
    constructor: ['**`constructor`**', 'Runs once at `DC_DEPLOY`. Bond is 10 USDm (non-refundable).'],
  };
  if (keywordDocs[symbol]) return keywordDocs[symbol];

  if (SYSCALLS.includes(symbol)) {
    return [`**Syscall \`${symbol}\`**`, 'See LANGUAGE.md syscall allowlist for full semantics.'];
  }
  if (TYPES.includes(symbol)) {
    return [`**Type \`${symbol}\`**`, 'See LANGUAGE.md type table.'];
  }
  if (STDLIB_CONTRACTS.includes(symbol)) {
    return [`**Stdlib contract \`${symbol}\`**`, 'Reusable parent. Inherit via `is ${symbol}`.'];
  }
  if (ast?.symbols?.[symbol]) {
    return ast.symbols[symbol];
  }
  return null;
}

/** Compiler integration: cache AST + diagnostics keyed by Monaco model URI. */
export function setAst(monaco, modelUri, ast) {
  astByUri.set(modelUri, ast);
}

export function setDiagnostics(monaco, model, errors, warnings = []) {
  const all = [
    ...errors.map(e => ({ ...e, severity: monaco.MarkerSeverity.Error })),
    ...warnings.map(w => ({ ...w, severity: monaco.MarkerSeverity.Warning })),
  ];
  errorsByUri.set(model.uri.toString(), all);
  monaco.editor.setModelMarkers(model, LANGUAGE_ID, all.map(d => ({
    severity:        d.severity,
    startLineNumber: d.line || 1,
    startColumn:     d.col  || 1,
    endLineNumber:   d.endLine || (d.line || 1),
    endColumn:       d.endCol  || ((d.col || 1) + (d.length || 1)),
    message:         d.message,
    source:          'dsol',
  })));
}

export function clearDiagnostics(monaco, model) {
  errorsByUri.delete(model.uri.toString());
  monaco.editor.setModelMarkers(model, LANGUAGE_ID, []);
}

export const LANGUAGE = {
  id: LANGUAGE_ID,
  KEYWORDS, TYPES, ATTRS, SYSCALLS, BUILTINS, STDLIB_CONTRACTS,
};
