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
  {
    id: 'atomic-swap-escrow',
    name: 'Atomic Swap Escrow (bridge zk-v6)',
    blurb: 'Peer-to-peer wBTC escrow for trustless cross-chain swaps. Adaptor-sig + contract-owned escrow stealth — subpoena-resistant, no operator.',
    files: [
      { path: 'AtomicSwapEscrow.dsol', content: `// AtomicSwapEscrow — bridge zk-v6 USDm-side wBTC escrow for peer-to-peer
// atomic swaps. (v6.B — DEPLOYABLE.)
//
// PROTOCOL
// ─────────
// Implements the USDm-chain half of the v6 atomic-swap protocol. The
// pure state-machine reference is at
// \`ion-monerousd-org/backend/bridge/zk/v6/atomic-swap-statemachine.js\`;
// the cryptographic adaptor-signature primitive is at
// \`.../zk/v6/schnorr-adaptor.js\`. The whole v6 architecture spec lives
// at \`ion-monerousd-org/docs/zk-v6/SPEC.md\`.
//
// V6's THESIS — there is no central bridge operator. A user (User) and
// a liquidity provider (LP) execute a peer-to-peer atomic swap whose
// completion is enforced cryptographically by adaptor signatures plus
// time-lock escrows on each side. The USDm side of that escrow is THIS
// CONTRACT. The BTC side rides Taproot adaptor-sig HTLCs (see
// \`htlc-script-btc.js\`, separate file).
//
// The 4-phase swap (BTC → wBTC):
//
//   1. Offer: LP off-chain advertises {price, T = t·G}.
//   2. Lock:  LP calls \`lock()\` here, depositing X wBTC via
//             ESCROW_LOCK_V1 + binding the release to a user-specific
//             adaptor point T_user = t_user·G. In parallel the user
//             funds a BTC HTLC on the BTC chain.
//   3. Reveal: User submits a Schnorr signature that completes the
//             pre-sig under T. The on-chain bytes leak \`t_user\` to the
//             LP. VERIFY_SCHNORR_ADAPTOR_V1 enforces this on-chain.
//   4. Settle: LP uses \`t_user\` to claim the user's BTC HTLC. The
//             BTC-side claim leaks \`t_user\` again — already public,
//             swap is complete.
//
// STATE MACHINE (this contract's slice)
// ─────────────
//   NONE      → swap_id never seen on this contract.
//   LOCKED    → LP funded; awaiting either user \`claim()\` or \`refund()\`.
//   CLAIMED   → user produced the completing sig + received the wBTC.
//   REFUNDED  → lp_timeout_block reached without a claim; LP got the
//               wBTC back.
//
// Terminal: CLAIMED, REFUNDED. NONE is the implicit initial state.
//
// AUTHORIZATION MODEL (CLAUDE.md rules 107, 108)
// ────────────────────
//   lock()   — open to any LP. Records \`swapLp = msg.sender\` (the
//              wallet-identity Schnorr proof tied to the carrier tx)
//              AND \`swapLpSignerPub\` (the ed25519 pubkey the LP will
//              sign the adaptor pre-sig with — may equal the wallet
//              identity, may be a fresh per-swap key). Records the
//              user_stealth that will receive the wBTC on successful
//              claim. ESCROW_LOCK_V1 moves the LP's wBTC into a
//              contract-owned escrow stealth (cryptographically
//              derived from contractId + swap_id) in the same call —
//              no out-of-band carrier tx required.
//
//   claim()  — open to any caller (the adaptor-sig IS the
//              authorization). The (completed, pre-) Schnorr sig pair
//              is verified by VERIFY_SCHNORR_ADAPTOR_V1 against the
//              recorded swapLpSignerPub + swapUserAdaptorPub. The
//              wBTC is paid via ESCROW_RELEASE_V1 to swapUserStealth,
//              never to msg.sender — this defends against a watcher
//              that observes a published completed sig on the BTC
//              side and tries to race a claim from a different
//              stealth on the USDm side. The user's stealth is
//              committed at lock time and is the only valid
//              destination.
//
//   refund() — open ONLY to \`swapLp[swap_id]\`. After lp_timeout, the
//              LP reclaims via ESCROW_RELEASE_V1 to swapLpStealth.
//              Note the asymmetry — the user_timeout on the BTC side
//              is STRICTLY GREATER than lp_timeout here (see
//              state-machine doc §"TIMEOUT INVARIANT"). A stalling
//              LP loses their wBTC because the refund window closes
//              before the BTC-side user refund.
//
// HOST SYSCALL CONTRACTS (registered in backend/dark-contracts/host.js)
// ────────────────────────
//   ESCROW_LOCK_V1 (0x0a02)
//     argv:    { tokenId, amount, subKey }
//     emits:   token_transfer{srcStealth=ctx.callerStealth,
//                              destStealth=SHA-256(dc_escrow_v1: ||
//                              contractId || ":" || subKey)}
//     returns: { escrowStealth, tokenId, amount, ... }
//
//   VERIFY_SCHNORR_ADAPTOR_V1 (0x0a01)
//     argv:    { signerPubHex, adaptorPubHex, messageHex,
//                completedSigHex, preSigHex }  (ALL hex-encoded)
//     returns: 8-byte LE u64 (1 = valid, 0 = invalid) via resultBytes
//     DSOL usage: \`let ok = syscall(VERIFY_SCHNORR_ADAPTOR_V1, ...);\`
//                 \`require(ok != 0, "ADAPTOR_SIG_INVALID");\`
//
//   ESCROW_RELEASE_V1 (0x0a03)
//     argv:    { tokenId, amount, destStealth, subKey }
//     emits:   token_transfer{srcStealth=SHA-256(dc_escrow_v1:...)),
//                              destStealth=argv.destStealth}
//     returns: { escrowStealth, tokenId, amount, ... }
//
// HEX-WIRE FORMAT NOTE
// ─────────────────────
// All cryptographic fields (adaptor pub, sigs, message, LP signer
// pub) flow through the contract as HEX-ENCODED bytes (ASCII safe).
// This avoids the JSON-encoding gap for raw 32-byte values in
// DSOL's current object-literal codegen. The wallet hex-encodes
// before broadcasting; the syscall handler hex-decodes; the
// underlying schnorr-adaptor primitive operates on raw bytes.
//
// CONFIRMED PROTOCOL PROPERTIES
// ──────────────────────────────
//   * Adaptor secret t_user is the ONLY shared scalar between the
//     BTC and USDm sides; both chains' completed sigs publish it.
//   * No on-chain footprint reveals "this BTC HTLC corresponds to
//     this wBTC escrow" — discovering the linkage requires DLOG.
//   * The LP's identity is a single ed25519 pubkey of their choosing
//     (a pseudonymous wallet — there is no protocol-level enrollment).
//   * Operator-as-adversary threat model: the chain operator does NOT
//     execute the protocol; there is no operator. A subpoena to the
//     "bridge operator" returns nothing because there is no operator.
//
// V6.A → V6.B DIFF (audit closure)
// ────────────────────────────────
// v6.A shipped this contract with \`require(false, V6A_*_GATED_*)\`
// hard-gates on claim() and refund() because (a) the syscalls for
// crypto-verification + explicit-srcStealth value flow did not yet
// exist in host.js, and (b) shipping without them would have meant
// trivial theft of escrowed wBTC (see docs/zk-v6/AUDIT.md §A.1-A.4).
//
// v6.B closes the audit findings:
//   * VERIFY_SCHNORR_ADAPTOR_V1 (A.1) — claim() now does on-chain
//     verification of the completed + pre- sig pair against the LP's
//     signer pubkey + the user's adaptor point. A submitter of
//     random sig bytes is rejected with SWAP_BAD_SIG.
//   * ESCROW_LOCK_V1 (A.3) — lock() escrows the LP's wBTC into a
//     contract-derived stealth IN THE SAME CALL. No out-of-band
//     carrier-tx required, no griefing surface for a malicious LP
//     who locks without depositing.
//   * ESCROW_RELEASE_V1 (A.2) — claim()/refund() drain the contract-
//     derived escrow stealth via the host-derived srcStealth. The
//     SELF_TRANSFER + ctx.callerStealth issues of v6.A are closed.

dark contract AtomicSwapEscrow {

  // ────────── STATE ──────────
  //
  // swap_id = SHA-256("monerousd-zk-v6-swap-id-v1:" || userPub || "|"
  //                   || lpPub || "|" || adaptorPub)
  // Computed off-chain by \`computeSwapId(...)\` in
  // atomic-swap-statemachine.js; a 32-byte deterministic identifier
  // hex-encoded to 64 ASCII chars before being passed in. Used as the
  // key for every mapping below AND as the \`subKey\` to derive the
  // contract-owned escrow stealth.

  // State encoded as uint64 — DSOL pre-2.0 has no enum.
  //   0 = NONE (default; mapping miss)
  //   1 = LOCKED
  //   2 = CLAIMED
  //   3 = REFUNDED
  public mapping(bytes => uint64)            swapState;

  // LP wallet identity — the wallet that called lock(). msg.sender at
  // refund() must equal this value.
  public mapping(bytes => wallet_identity)   swapLp;

  // LP's stealth subaddress to receive the wBTC on refund.
  public mapping(bytes => stealth)            swapLpStealth;

  // LP's ed25519 pubkey for adaptor-sig verification (hex-encoded,
  // 64 ASCII chars). Distinct from the wallet identity above so the
  // protocol supports either:
  //   (a) "same key" — LP signs adaptor pre-sig with their wallet's
  //       primary spend key. Simplest.
  //   (b) "fresh key" — LP generates a per-swap ed25519 keypair just
  //       for adaptor signing. Stronger privacy + key compartmentation.
  // Either way, this slot stores the pubkey the verifier checks.
  public mapping(bytes => bytes)              swapLpSignerPub;

  // User's stealth subaddress — the one and only valid destination
  // for a successful claim. Committed at lock() and never mutable.
  public mapping(bytes => stealth)            swapUserStealth;

  // User's adaptor public point T_user = t_user·G (hex-encoded, 64
  // ASCII chars). The completing Schnorr sig MUST chain to this
  // point — enforced on-chain by VERIFY_SCHNORR_ADAPTOR_V1.
  public mapping(bytes => bytes)              swapUserAdaptorPub;

  // Schnorr message domain — the bytes the completed sig signs
  // (hex-encoded). Bound at lock() so a watcher cannot front-run the
  // user by substituting a different message + sig pair.
  public mapping(bytes => bytes)              swapMessage;

  // wBTC ion1_ tokenId. Frozen wrapped-asset id per CLAUDE.md rule
  // 62 ("wrapped-asset tokenId values are FROZEN").
  public mapping(bytes => string)             swapWbtcTokenId;

  // wBTC amount the LP locked, in wrapper-atomic (1e8).
  public mapping(bytes => uint64)             swapWbtcAmount;

  // Block height at which the LP becomes refund-eligible. The
  // state-machine module enforces user_timeout > lp_timeout. THIS
  // contract only sees the LP-side timeout (the BTC HTLC owns the
  // user_timeout asymmetry).
  public mapping(bytes => uint64)             swapLpTimeoutBlock;

  // ────────── LOCK ──────────
  //
  // The LP escrows wBTC AND commits the swap parameters in a single
  // atomic call. ESCROW_LOCK_V1 moves wbtc_amount from the LP's
  // calling stealth into the contract's per-swap escrow stealth
  // (derived from contractId + swap_id). The contract author CANNOT
  // forge an escrow it doesn't own — the destination derivation is
  // host-computed from ctx.contractId, so cross-contract drain
  // attacks are cryptographically impossible.
  @direct
  entry lock(
    bytes            swap_id,
    bytes            user_adaptor_pub,
    bytes            message,
    stealth          user_stealth,
    stealth          lp_stealth,
    bytes            lp_signer_pub,
    string           wbtc_token_id,
    uint64           wbtc_amount,
    uint64           lp_timeout_block
  ) {
    // 1. State-machine pre-conditions.
    require(swapState[swap_id] == 0,                "SWAP_ALREADY_LOCKED");

    // 2. Economic + temporal sanity. lp_timeout_block constrained
    //    to a useful + bounded window:
    //      - MIN buffer 30 blocks (~1 hour at 2-min blocks) so the
    //        user has a realistic claim window. Without a floor,
    //        an LP could set lp_timeout = block.number + 2 (effectively
    //        2-block claim window) and starve a legitimate user
    //        claim. The user would never opt into such a swap, but
    //        the protocol pins the floor anyway as defense-in-depth.
    //      - MAX 4320 blocks (~6 days at 2-min blocks) cap. Atomic
    //        swaps typically settle in hours, not months. The 6-day
    //        ceiling matches Bitcoin's standard 24-48h HTLC window
    //        scaled to USDm block time. Refuses open-ended escrows
    //        that bloat contract state + indexer storage.
    require(wbtc_amount > 0,                         "SWAP_ZERO_AMOUNT");
    require(lp_timeout_block > block.number + 30,    "SWAP_TIMEOUT_TOO_SOON");
    require(lp_timeout_block < block.number + 4320,  "SWAP_TIMEOUT_TOO_FAR");

    // 3. Token id + non-empty crypto fields. Length pinning of
    //    adaptor_pub / signer_pub / message happens in
    //    VERIFY_SCHNORR_ADAPTOR_V1 (verifier rejects non-64-hex-char
    //    pubkeys + odd-length messages); the contract pre-flights
    //    only non-empty.
    require(wbtc_token_id != "",                     "SWAP_BAD_TOKEN_ID");
    require(user_adaptor_pub != "",                  "SWAP_EMPTY_ADAPTOR_PUB");
    require(lp_signer_pub != "",                     "SWAP_EMPTY_LP_SIGNER_PUB");
    require(message != "",                           "SWAP_EMPTY_MESSAGE");

    // 4. Self-dest defense (CLAUDE.md rule 108 audit checklist).
    //    A self-claim swap (LP claiming back through the user-side
    //    path) is economically meaningless AND defeats the protocol's
    //    privacy model — refuse it.
    require(user_stealth != lp_stealth,              "SWAP_SELF_DEST");

    // 5. Commit state BEFORE the escrow side-effect. Defense-in-depth
    //    vs cross-contract reentrancy (mirrors IonSwapDeposit's
    //    pattern); the ESCROW_LOCK_V1 syscall does not callback into
    //    DSOL, but state-first emit-after is the canonical safe
    //    pattern.
    swapState[swap_id]            = 1;  // LOCKED
    swapLp[swap_id]               = msg.sender;
    swapLpStealth[swap_id]        = lp_stealth;
    swapLpSignerPub[swap_id]      = lp_signer_pub;
    swapUserStealth[swap_id]      = user_stealth;
    swapUserAdaptorPub[swap_id]   = user_adaptor_pub;
    swapMessage[swap_id]          = message;
    swapWbtcTokenId[swap_id]      = wbtc_token_id;
    swapWbtcAmount[swap_id]       = wbtc_amount;
    swapLpTimeoutBlock[swap_id]   = lp_timeout_block;

    // 6. Move the LP's wBTC into the contract's per-swap escrow.
    //    srcStealth = ctx.callerStealth (the LP);
    //    destStealth = SHA-256(dc_escrow_v1: || contractId || ":" || swap_id).
    //    The indexer's §3.7 token_transfer derivation credits the
    //    escrow stealth.
    syscall(ESCROW_LOCK_V1, {
      tokenId: wbtc_token_id,
      amount:  wbtc_amount,
      subKey:  swap_id
    });
  }

  // ────────── CLAIM ──────────
  //
  // The user publishes the COMPLETED Schnorr sig that, combined with
  // the LP's PRE-sig, leaks t_user (the user's adaptor secret) to
  // anyone watching the chain. The contract verifies the sig pair
  // on-chain via VERIFY_SCHNORR_ADAPTOR_V1 and credits wBTC to the
  // swap's recorded user_stealth.
  //
  // The caller need not be the user wallet — the completed sig IS
  // the authorization. The destination is ALWAYS the recorded
  // swapUserStealth, so a watcher cannot reroute the wBTC even with
  // a copy of the completed sig.
  @direct
  entry claim(bytes swap_id, bytes completed_sig, bytes pre_sig) {
    // 1. State + timeout.
    require(swapState[swap_id] == 1,                  "SWAP_NOT_LOCKED");
    require(block.number < swapLpTimeoutBlock[swap_id], "SWAP_CLAIM_AFTER_TIMEOUT");

    // 2. Pre-flight non-empty pin. Real sig validation is the
    //    syscall's responsibility — it rejects malformed hex, wrong
    //    lengths, mismatched R, failed verifyPreSign, failed
    //    verifyCompleted. We just refuse empty bytes here so the
    //    syscall isn't called with obviously-bad input.
    require(completed_sig != "",                       "SWAP_BAD_COMPLETED_SIG");
    require(pre_sig != "",                             "SWAP_BAD_PRE_SIG");

    // 3. On-chain adaptor-sig verification. Returns u64 (1 = valid,
    //    0 = invalid). FAIL-CLOSED — any garbage byte sequence
    //    rejects with SWAP_BAD_SIG; only the canonical Aumayr et
    //    al. completion against the recorded (LP signer pub, user
    //    adaptor pub, message) succeeds.
    let sig_ok = syscall(VERIFY_SCHNORR_ADAPTOR_V1, {
      signerPubHex:    swapLpSignerPub[swap_id],
      adaptorPubHex:   swapUserAdaptorPub[swap_id],
      messageHex:      swapMessage[swap_id],
      completedSigHex: completed_sig,
      preSigHex:       pre_sig
    });
    require(sig_ok != 0,                              "SWAP_BAD_SIG");

    // 4. Mark CLAIMED before emitting the release.
    swapState[swap_id] = 2;  // CLAIMED

    // 5. Drain the contract-owned escrow stealth to the user.
    //    srcStealth is HOST-DERIVED from contractId + swap_id —
    //    not caller-supplied — so cross-contract drain is
    //    cryptographically impossible.
    syscall(ESCROW_RELEASE_V1, {
      tokenId:     swapWbtcTokenId[swap_id],
      amount:      swapWbtcAmount[swap_id],
      destStealth: swapUserStealth[swap_id],
      subKey:      swap_id
    });
  }

  // ────────── REFUND ──────────
  //
  // After lp_timeout_block, if no claim has landed, the LP reclaims
  // their wBTC. The strict \`msg.sender == swapLp[swap_id]\` gate
  // closes the v1.2.182-class griefing surface (rule 107).
  @direct
  entry refund(bytes swap_id) {
    // 1. State + authorization + timeout.
    require(swapState[swap_id] == 1,                    "SWAP_NOT_LOCKED");
    require(msg.sender == swapLp[swap_id],              "SWAP_REFUND_NOT_LP");
    require(block.number >= swapLpTimeoutBlock[swap_id], "SWAP_REFUND_TOO_EARLY");

    // 2. Mark REFUNDED before emit.
    swapState[swap_id] = 3;  // REFUNDED

    // 3. Drain the escrow stealth back to the LP's recorded stealth.
    //    Same host-derivation as claim() — only this contract can
    //    drain its own escrows.
    syscall(ESCROW_RELEASE_V1, {
      tokenId:     swapWbtcTokenId[swap_id],
      amount:      swapWbtcAmount[swap_id],
      destStealth: swapLpStealth[swap_id],
      subKey:      swap_id
    });
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
