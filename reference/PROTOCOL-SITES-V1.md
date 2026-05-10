# Sovereign Sites Protocol — v1 (frozen)

This document is the frozen wire-format specification for `SITE_PUBLISH`,
`SITE_TRANSFER`, and `SITE_REVOKE`. Any v1-compatible Ion Swap indexer MUST
materialize byte-identical `dark_sites` rows from the same chain state across
every operator. Breaking changes require a `/v2/` surface; extensions are
append-only (new fields fine, no removals).

## 1. Attestation op codes

```
SITE_PUBLISH   0x27  // payload: { domain, rootHash, bundleSize, version, contentType, publisher, signature, feePaid }
SITE_TRANSFER  0x28  // payload: { domain, newPublisher, effectiveBlock, signature }
SITE_REVOKE    0x29  // payload: { domain, signature }
```

Wire format is the existing `ion://op/v1?code=<OP>&...` attestation URI, fed
through the same `attestation-codec.js` ↔ `attestation.js` dispatch path the
DC ops use. Payload cap is 2000 bytes JSON; bundles >2 MB gzipped are
rejected at ingress.

## 2. SITE_PUBLISH payload

```json
{
  "domain":      "monerousd.org",
  "rootHash":    "<hex32>",
  "bundleSize":  147234,
  "version":     "1.2.160",
  "contentType": "static",
  "publisher":   "<stealth>",
  "signature":   "<ed25519(domain || rootHash || version || bundleSize)>",
  "feePaid":     1234
}
```

| Field         | Type   | Constraint                                         |
|---------------|--------|----------------------------------------------------|
| `domain`      | string | Either an allowlisted official domain (one of `monerousd.org`, `ionswap.monerousd.org`, `explorer.monerousd.org`, `ide.monerousd.org`) or `dark-sites.local/<name>` |
| `rootHash`    | hex64  | Lowercase 64-char SHA-256 of the gzipped tarball   |
| `bundleSize`  | u32    | Compressed bytes; cap 2 097 152 (2 MB)             |
| `version`     | string | Semver `MAJOR.MINOR.PATCH`; must be > prior        |
| `contentType` | string | One of `static`, `spa`, `spa-with-api`             |
| `publisher`   | stealth| Stealth subaddress; signature signer               |
| `signature`   | hex128 | Ed25519 over `concat(domain, rootHash, version, bundleSize)` |
| `feePaid`     | u64    | USDm atomic; ≥ `computeSiteFee(...)` for the bundle|

The corresponding bundle is `POST`ed off-chain to
`/api/sites/:domain/bundle` (rule 12) and stored content-addressed by
`bundle-store.js`. Verification flow:

1. Indexer reads `SITE_PUBLISH` payload from `pool_events`.
2. Pulls the bundle by `rootHash` from the operator cache (or fetches from
   another indexer if it doesn't have it locally).
3. Recomputes SHA-256 over the gzip stream.
4. Asserts `rootHash` match. Mismatch → reject; the row is not committed.
5. Asserts `feePaid ≥ computeSiteFee({domain, bundleSize, isFirstPublish})`.
6. Asserts `signature` valid against `publisher`'s stealth ed25519 pubkey.
7. Asserts `version > previousVersion` for the same domain.
8. Upserts `dark_sites` and emits `recordEvent('site_published')`.

## 3. SITE_TRANSFER payload

```json
{
  "domain":         "myapp.dark-sites.local",
  "newPublisher":   "<stealth>",
  "effectiveBlock": 4123100,
  "signature":      "<ed25519(domain || newPublisher || effectiveBlock)>"
}
```

Signed by the **current** publisher. Bond is **not** refunded — bonds remain
in the reserve forever (SW-19). Fee: 10 USDm flat → reserve.

## 4. SITE_REVOKE payload

```json
{
  "domain":    "myapp.dark-sites.local",
  "signature": "<ed25519(domain || \"REVOKE_V1\")>"
}
```

Signed by the current publisher. Free apart from carrier-tx fee. The indexer
flips `dark_sites.revoked = true` and the wallet's sovereign-server returns
a "Revoked by publisher" page instead of stale content.

## 5. Fee curve (SW-18)

`computeSiteFee({domain, bundleSize, isFirstPublish}) → USDm_atomic` is the
**single source of truth**. Wallet preview, IDE preview, indexer enforcement,
and CLI (`scripts/publish-sovereign-site.js`) all import the same file
(`backend/sites/fee-curve.js`; mirrored byte-identical at
`build-1261/lib/site-fee-curve.js` and `monerousd-ide/lib/fee-curve.js`).

| Name length | Bond (USDm) | Tier                                |
|-------------|-------------|-------------------------------------|
| 1-3 chars   | 5,000       | Premium short names                 |
| 4-6 chars   | 500         | Standard names                      |
| 7-10 chars  | 100         | Common names                        |
| 11+ chars   | 25          | Long-tail / dev names               |

Update fee: `1 USDm + 0.01 USDm/KB` of compressed bundle.
Total = `bond (if first publish) + update`.

## 6. Reserve routing (SW-17)

100% of every `SITE_*` fee routes through
`backend/fees/split.js::chargeBond(amount, 'reserve')`. No operator cut, no
LP cut, no DAO cut. Verified by `tests/sites/fee-routing.test.js`: publish
N ops, assert reserve balance increments by exactly
`Σ computeSiteFee(...)`.

## 7. Indexer schema

```sql
CREATE TABLE IF NOT EXISTS dark_sites (
  domain         TEXT PRIMARY KEY,
  publisher      TEXT NOT NULL,
  current_root   TEXT NOT NULL,
  bundle_size    INTEGER NOT NULL,
  version        TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  first_block    INTEGER NOT NULL,
  last_block     INTEGER NOT NULL,
  revoked        INTEGER NOT NULL DEFAULT 0,
  total_fees     TEXT NOT NULL DEFAULT '0'   -- BigInt USDm atomic, lifetime
);
```

`backend/indexer/sites.js::deriveSites(pool_events) → dark_sites` is pure;
SW-9 deterministic. Two indexers seeded from the same `pool_events` produce
byte-identical `dark_sites` and identical Merkle roots over the materialized
state.

## 8. Public read endpoints

```
GET  /v1/sites                                List all anchored domains
GET  /v1/sites/:domain                        Latest rootHash + meta
GET  /v1/sites/:domain/bundle                 Stream tarball; ETag = rootHash
GET  /v1/sites/stats                          { totalReserveContributions }
POST /api/sites/:domain/bundle                Publisher bundle ingress (rule 12)
```

## 9. Cross-cutting invariants

| #   | Name                     | Enforcement                                     |
|-----|--------------------------|-------------------------------------------------|
| SW-1| Served bytes ≡ rootHash  | Wallet sovereign-server SHA-256 tee on every read |
| SW-2| Publisher-bound updates  | Dispatch checks `payload.publisher === dark_sites.publisher` |
| SW-3| Sovereign server is local| Hardcoded bind `127.0.0.1`; CI lint              |
| SW-4| No official-domain spoof | Allowlist for the four official domains          |
| SW-5| Provider gated to verified `<webview>` | `dapp-preload.js`           |
| SW-6| Bundle CSP               | `default-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:27751 http://localhost:27750` |
| SW-9| Indexer determinism      | `deriveSites` pure BigInt/JSON                    |
| SW-10| pool_events bypass forbidden | `_applySitePublish` always emits recordEvent |
| SW-11| Carrier amount = real fee | rule 15                                          |
| SW-12| Carrier destination = swap wallet | rule 10                                  |
| SW-13| Codec parity              | Static parity test                              |
| SW-14| Approval modal shows reserve callout | rule 5 +`buildOpFields('SITE_PUBLISH')` |
| SW-17| Fee → reserve 100%        | `chargeBond(payload.feePaid, 'reserve')`         |
| SW-18| Fee curve parity          | Single file imported by backend, wallet, IDE     |
| SW-19| Bond non-refundable on TRANSFER | Bond stays in reserve forever              |

## 10. Reference implementation

- Codec: `ion-monerousd-org/backend/monitor/attestation-codec.js`
- Dispatch: `ion-monerousd-org/backend/monitor/attestation.js`
- Site publish handler: `ion-monerousd-org/backend/monitor/site-publish.js`
- Fee curve: `ion-monerousd-org/backend/sites/fee-curve.js`
- Registry HTTP: `ion-monerousd-org/backend/sites/registry.js`
- Bundle store: `ion-monerousd-org/backend/sites/bundle-store.js`
- Publisher ingest: `ion-monerousd-org/backend/sites/publisher.js`
- Indexer derivation: `ion-monerousd-org/backend/indexer/sites.js`
- Wallet IPC: `build-1261/main.js::publishSite`
- Wallet provider: `build-1261/dapp-browser/dapp-preload.js`
- Wallet codec mirror: `build-1261/dapp-browser/attestation.js`
- Browser-extension provider: `extensions/monerousd-chrome/content/injected-provider.js`
- IDE preview: `monerousd-ide/lib/fee-curve.js` + `pages/site-preview.js`
