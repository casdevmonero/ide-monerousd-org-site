# MoneroUSD Sovereign Mirror — `ide.monerousd.org`

This is the public, GitHub Pages-served mirror of the MoneroUSD
sovereign site at `https://ide.monerousd.org`. The bundle is byte-identical
to the chain-anchored T2 bundle (per SITE_PUBLISH attestation) and
to the T1 bundle shipped inside the desktop wallet's installer.

## Trust model

The bytes here are NOT trusted directly — the wallet verifies every
byte against the chain-anchored `rootHash` from the
`SITE_PUBLISH` attestation before rendering. This repo is just a
fast, free, anycast-served transport.

## Why public

GitHub Pages requires a public repo on the free tier, and any wallet
or browser must be able to fetch the bundle without authentication.
The default-deny `.gitignore` prevents wallet seeds, SSH keys,
PATs, env files, or Claude state from accidentally landing here.
