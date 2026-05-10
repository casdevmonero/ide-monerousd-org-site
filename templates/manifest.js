/* Bundled templates + stdlib. Inlined so the browser compiler can resolve
 * `is Ownable` / `is Pausable` etc. without extra HTTP roundtrips, and the
 * template gallery doesn't need to fan-out fetches.
 *
 * Keep these in sync with build-1261/dark-contracts/{stdlib,examples}/. The
 * static test `tests/static/template-source-parity.test.js` asserts byte-
 * equality (mirror, not divergent fork).
 */

/* ─── Stdlib (used by the compiler's inheritance resolver) ─── */

export const STDLIB = {

  Ownable: `// Ownable — single-owner pattern. Inherit via \`is Ownable\`.
dark contract Ownable {
  public stealth owner;

  constructor() {
    owner = msg.sender;
  }

  modifier onlyOwner() {
    require(msg.sender == owner, "NOT_OWNER");
    _;
  }

  @direct
  entry transferOwnership(stealth newOwner) onlyOwner {
    owner = newOwner;
  }
}
`,

  Pausable: `dark contract Pausable {
  public bool paused;

  modifier whenNotPaused() {
    require(!paused, "PAUSED");
    _;
  }

  modifier whenPaused() {
    require(paused, "NOT_PAUSED");
    _;
  }
}
`,

  ReentrancyGuard: `dark contract ReentrancyGuard {
  private bool _entered;

  modifier nonReentrant() {
    require(!_entered, "REENTRANCY");
    _entered = true;
    _;
    _entered = false;
  }
}
`,

  Erc20Private: `// Private ERC20-equivalent. Balances stored as Pedersen commitments.
dark contract Erc20Private is Ownable {
  private mapping(stealth => uint64) balances;
  public string symbol;
  public uint64 totalSupply;

  constructor(string sym, uint64 supply) {
    symbol = sym;
    totalSupply = supply;
    balances[msg.sender] = supply;
  }

  @batch
  entry transfer(stealth to, uint64 amount) {
    require(balances[msg.sender] >= amount, "INSUFFICIENT");
    balances[msg.sender] = balances[msg.sender] - amount;
    balances[to] = balances[to] + amount;
    emit encrypted Transfer(msg.sender, to, amount);
  }

  @direct
  entry balanceOf(stealth who) returns (uint64 when revealed) {
    return balances[who];
  }
}
`,

  PausableToken: `dark contract PausableToken is Erc20Private, Pausable {
  @direct
  entry pause() onlyOwner {
    paused = true;
  }
  @direct
  entry unpause() onlyOwner {
    paused = false;
  }

  @batch
  entry transfer(stealth to, uint64 amount) whenNotPaused {
    require(balances[msg.sender] >= amount, "INSUFFICIENT");
    balances[msg.sender] = balances[msg.sender] - amount;
    balances[to] = balances[to] + amount;
    emit encrypted Transfer(msg.sender, to, amount);
  }
}
`,

  NftCollection: `dark contract NftCollection is Ownable {
  public string name;
  public uint64 nextId;
  private mapping(uint64 => stealth) ownerOf;

  constructor(string n) {
    name = n;
  }

  @batch
  entry mint(stealth to) onlyOwner returns (uint64 when revealed) {
    let id = nextId;
    ownerOf[id] = to;
    nextId = id + 1;
    return id;
  }

  @batch
  entry transfer(uint64 id, stealth to) {
    require(ownerOf[id] == msg.sender, "NOT_OWNER_OF_TOKEN");
    ownerOf[id] = to;
  }
}
`,
};

/* ─── DSOL contract templates (gallery) ─── */

export const DSOL_TEMPLATES = [
  {
    id: 'counter',
    name: 'Counter',
    blurb: 'Minimal contract — increment + read a private counter. Best first deploy.',
    files: [
      { path: 'Counter.dsol', content: `// A minimal DSOL contract — best first deploy.
//
//   private uint64 count
//     ↳ stored on-chain as a Pedersen commitment
//   @batch entry increment()
//     ↳ commit-reveal so the value is hidden until your reveal block
//   @direct entry getCount()
//     ↳ returns the current value to your viewkey via a Bulletproofs+ range proof

dark contract Counter {
  private uint64 count;

  @batch
  entry increment() {
    count = count + 1;
  }

  @direct
  entry getCount() returns (uint64 when revealed) {
    return count;
  }
}
` },
    ],
  },
  {
    id: 'token-transfer',
    name: 'Token Transfer',
    blurb: 'Erc20-style private transfer + balance lookup. Deployer picks symbol + supply.',
    files: [
      { path: 'Token.dsol', content: `// Inherits the standard Erc20Private contract from stdlib. The
// deployer supplies (string symbol, uint64 totalSupply) at deploy
// time; the inherited constructor mints the entire supply to
// msg.sender and the inherited @batch transfer + @direct balanceOf
// entrypoints come along for free.
dark contract Token is Erc20Private {}
` },
    ],
  },
  {
    id: 'erc-private',
    name: 'Private ERC20',
    blurb: 'Full Erc20Private + owner-only mint() — encrypted Transfer / Mint events.',
    files: [
      { path: 'PrivateToken.dsol', content: `// Erc20Private + an owner-only mint() entrypoint. Inherits the
// (string sym, uint64 supply) constructor from Erc20Private; the
// inherited Ownable.transferOwnership() entrypoint lets the owner
// rotate to a new address.
dark contract PrivateToken is Erc20Private {
  event Mint(stealth to, uint64 amount);

  @batch
  entry mint(stealth to, uint64 amount) onlyOwner {
    balances[to] = balances[to] + amount;
    totalSupply = totalSupply + amount;
    emit encrypted Mint(to, amount);
  }
}
` },
    ],
  },
  {
    id: 'nft-collection',
    name: 'NFT Collection',
    blurb: 'Owner-controlled NFT mint + transfer with private ownership mapping.',
    files: [
      { path: 'Collection.dsol', content: `// Wraps the standard NftCollection from stdlib. The deployer
// supplies (string name) at deploy time; the inherited @batch mint
// + @batch transfer entrypoints handle minting and ownership rotation.
dark contract Collection is NftCollection {}
` },
    ],
  },
  {
    id: 'voting',
    name: 'Voting',
    blurb: 'Anonymous yes/no voting with nullifier-tracked one-vote-per-address.',
    files: [
      { path: 'Voting.dsol', content: `dark contract Voting {
  public uint64 yes;
  public uint64 no;
  public uint64 deadline;
  private mapping(stealth => bool) voted;

  constructor(uint64 deadlineBlock) {
    deadline = deadlineBlock;
  }

  @batch
  entry vote(bool support) {
    require(block.number < deadline, "ENDED");
    require(!voted[msg.sender], "ALREADY_VOTED");
    voted[msg.sender] = true;
    if (support) { yes = yes + 1; } else { no = no + 1; }
  }
}
` },
    ],
  },
  {
    id: 'escrow',
    name: 'Escrow',
    blurb: 'Two-party escrow — buyer locks USDm, seller releases or refunds.',
    files: [
      { path: 'Escrow.dsol', content: `// Two-party escrow — owner (arbiter) either releases held USDm to
// the seller or refunds the buyer. Settlement uses the
// TOKEN_TRANSFER_EMIT_V1 syscall whose argv encodes the recipient.
//
// Note: syscalls are no-ops in the IDE Run preview ("syscall preview
// disabled"); the real transfer fires when the contract executes
// on-chain inside the indexer's DarkVM.
dark contract Escrow is Ownable {
  public stealth buyer;
  public stealth seller;
  public uint64 amount;
  public bool released;

  constructor(stealth b, stealth s, uint64 a) {
    buyer = b;
    seller = s;
    amount = a;
  }

  @batch
  entry release() onlyOwner {
    require(!released, "ALREADY_RELEASED");
    released = true;
    syscall(TOKEN_TRANSFER_EMIT_V1, seller);
  }

  @batch
  entry refund() onlyOwner {
    require(!released, "ALREADY_RELEASED");
    released = true;
    syscall(TOKEN_TRANSFER_EMIT_V1, buyer);
  }
}
` },
    ],
  },
];

/* ─── Site project templates ─── */

export const SITE_TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank',
    blurb: 'Empty index.html. Bring your own stack.',
    files: [
      { path: 'index.html', content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My Sovereign Site</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <h1>Hello, sovereign web!</h1>
  <p>This site is chain-anchored on the MoneroUSD chain.</p>
  <script src="app.js"></script>
</body>
</html>
` },
      { path: 'style.css', content: `body { font-family: system-ui, sans-serif; max-width: 56rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
h1 { color: #FF6600; }
` },
      { path: 'app.js', content: `console.log('Hello from a chain-anchored site.');
` },
    ],
  },
  {
    id: 'bio',
    name: 'Single-page bio',
    blurb: 'Personal site / link page with hero + contact card.',
    files: [
      { path: 'index.html', content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Your Name</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main>
    <header>
      <h1>Your Name</h1>
      <p class="tagline">Builder · Researcher · Contributor</p>
    </header>
    <section>
      <p>Welcome to my chain-anchored homepage. Edit <code>index.html</code> to make it yours.</p>
    </section>
    <section class="links">
      <a href="https://example.com">Portfolio</a>
      <a href="https://example.com">Writing</a>
      <a href="mailto:you@example.com">Contact</a>
    </section>
  </main>
</body>
</html>
` },
      { path: 'style.css', content: `:root{--accent:#FF6600;}
body{margin:0;font-family:system-ui,sans-serif;background:#0d0d0d;color:#f5f5f5;}
main{max-width:48rem;margin:5rem auto;padding:0 1.5rem;}
h1{color:var(--accent);font-size:2.5rem;margin-bottom:.25rem;}
.tagline{color:#a0a0a0;margin-top:0;}
section{margin:2rem 0;}
.links{display:flex;flex-wrap:wrap;gap:1rem;}
.links a{color:var(--accent);text-decoration:none;border:1px solid #2a2a2a;border-radius:.5rem;padding:.5rem 1rem;}
.links a:hover{background:rgba(255,102,0,.12);}
` },
    ],
  },
  {
    id: 'blog',
    name: 'Static blog',
    blurb: 'Multi-page blog with index + posts directory.',
    files: [
      { path: 'index.html', content: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>My Blog</title><link rel="stylesheet" href="style.css"></head>
<body><main>
<h1>My Blog</h1>
<ul class="posts">
  <li><a href="posts/hello.html">Hello, sovereign web</a> · 2026-04-26</li>
</ul>
</main></body></html>
` },
      { path: 'posts/hello.html', content: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hello, sovereign web</title><link rel="stylesheet" href="../style.css"></head>
<body><main>
<a href="../index.html">← Home</a>
<h1>Hello, sovereign web</h1>
<p>This post is anchored to the MoneroUSD chain. Editing it requires a SITE_PUBLISH op signed by my publisher key.</p>
</main></body></html>
` },
      { path: 'style.css', content: `body{font-family:system-ui,sans-serif;background:#0d0d0d;color:#f5f5f5;margin:0;}
main{max-width:48rem;margin:4rem auto;padding:0 1.5rem;}
h1{color:#FF6600;}
a{color:#FF8833;}
.posts{list-style:none;padding:0;}
.posts li{padding:.75rem 0;border-bottom:1px solid #2a2a2a;}
` },
    ],
  },
  {
    id: 'dapp-shell',
    name: 'dApp shell',
    blurb: 'window.monerousd-aware shell with Connect + Deploy hook example.',
    files: [
      { path: 'index.html', content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My dApp</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main>
    <h1>My dApp</h1>
    <p id="status">Checking for MoneroUSD wallet…</p>
    <button id="connect" type="button" hidden>Connect MoneroUSD</button>
    <button id="action"  type="button" hidden>Run example call</button>
    <pre id="out"></pre>
  </main>
  <script src="app.js" type="module"></script>
</body>
</html>
` },
      { path: 'app.js', content: `const status = document.getElementById('status');
const connectBtn = document.getElementById('connect');
const actionBtn  = document.getElementById('action');
const out        = document.getElementById('out');

if (!window.monerousd) {
  status.textContent = 'No MoneroUSD provider found. Open this site inside the wallet or with the monerousd-chrome extension.';
} else {
  status.textContent = 'MoneroUSD provider detected.';
  connectBtn.hidden = false;
  connectBtn.addEventListener('click', async () => {
    try {
      const addr = await window.monerousd.connect();
      status.textContent = 'Connected: ' + (addr?.address ?? addr);
      actionBtn.hidden = false;
    } catch (err) {
      status.textContent = 'Connect failed: ' + err.message;
    }
  });
  actionBtn.addEventListener('click', async () => {
    out.textContent = 'Open the IDE Deploy activity to instantiate a contract — then call it from here using window.monerousd.callContract({...}).';
  });
}
` },
      { path: 'style.css', content: `body{margin:0;font-family:system-ui,sans-serif;background:#0d0d0d;color:#f5f5f5;}
main{max-width:48rem;margin:4rem auto;padding:0 1.5rem;}
h1{color:#FF6600;}
button{background:#FF6600;color:#0d0d0d;border:none;padding:.5rem 1rem;border-radius:.4rem;font-weight:600;cursor:pointer;margin-right:.5rem;}
button:hover{background:#FF8833;}
pre{background:#1a1a1a;border-radius:.5rem;padding:1rem;color:#a0a0a0;overflow:auto;}
` },
    ],
  },
];
