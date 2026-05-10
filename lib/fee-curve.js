/* Site-publish fee computation. Mirror of `backend/sites/fee-curve.js`.
 * SW-18 invariant: byte-identical logic backend ↔ wallet ↔ web IDE.
 *
 * USDm atomic unit is 1e8 (CRITICAL — see project_atomic_unit_1e8 memory).
 * Bond curve from the plan (anti-squatting):
 *   1-3 chars:  5,000 USDm
 *   4-6 chars:    500 USDm
 *   7-10 chars:   100 USDm
 *   11+ chars:     25 USDm
 * Update fee:
 *   1 USDm base + 0.01 USDm per KB of gzipped bundle.
 *
 * `bundleSize` is bytes (gzipped). `domain` is the canonical domain (no scheme).
 */

const ATOMIC = 100_000_000n; // 1 USDm = 1e8 atomic
const KB     = 1024;

function usdmToAtomic(usdm) {
  // Accept fractional USDm (e.g. 0.01 → 0.01 * 1e8 = 1_000_000 atomic).
  // Implement precise via integer scaling.
  const [intPart, fracPart = ''] = String(usdm).split('.');
  const fracPad = (fracPart + '00000000').slice(0, 8);
  const sign = intPart.startsWith('-') ? -1n : 1n;
  const absInt = BigInt(intPart.replace('-', '') || '0');
  return sign * (absInt * ATOMIC + BigInt(fracPad));
}

/** Length used for the bond-tier curve.
 *
 * Convention: third-party names use the slash-prefixed form
 * `dark-sites.local/<name>` and the bond scales with `<name>` length
 * (the part after the slash). Top-level / official domains use the
 * full domain length (`monerousd.org` is 13 chars, `ionswap.monerousd.org`
 * is 21 chars). Matches the plan's example economics table.
 */
function nameLengthForBond(domain) {
  const s = String(domain);
  if (s.startsWith('dark-sites.local/')) {
    const after = s.slice('dark-sites.local/'.length);
    // The bare label, no further sub-suffix dotting.
    const base = after.split('.')[0] || after;
    return base.length;
  }
  return s.length;
}

/** First-publish bond, returned in USDm atomic. */
export function bondAtomic(domain) {
  const len = nameLengthForBond(domain);
  if (len <= 3)  return usdmToAtomic('5000');
  if (len <= 6)  return usdmToAtomic('500');
  if (len <= 10) return usdmToAtomic('100');
  return usdmToAtomic('25');
}

/** Update fee: 1 USDm base + 0.01 USDm per KB (ceil). Returned in USDm atomic.
 *
 * The "per KB" rate, rendered in cents-of-USDm, is 1 cent / KB. So the
 * extra cents = ceil(bundleSize / 1024). For sub-KB bundles this rounds
 * up to a 1-cent floor (~0.01 USDm), so a 100-byte update is 1.01 USDm,
 * the same as a 1024-byte update.
 */
export function updateFeeAtomic(bundleSize) {
  if (typeof bundleSize !== 'number' || bundleSize < 0 || !Number.isFinite(bundleSize)) {
    throw new Error(`updateFeeAtomic: invalid bundleSize ${bundleSize}`);
  }
  const sizeKb = bundleSize / KB;
  const perKbCents = Math.ceil(sizeKb); // 1 cent per KB (= 0.01 USDm/KB).
  // Total in cents-of-USDm: 100 (base) + perKbCents.
  const cents = 100n + BigInt(perKbCents);
  // 1 cent of USDm = 1e6 atomic (since 1 USDm = 1e8).
  return cents * 1_000_000n;
}

/** Single source of truth: { bondAtomic, updateAtomic, totalAtomic }. */
export function computeSiteFee({ domain, bundleSize, isFirstPublish }) {
  const bond     = isFirstPublish ? bondAtomic(domain) : 0n;
  const update   = updateFeeAtomic(bundleSize);
  const total    = bond + update;
  return { bondAtomic: bond, updateAtomic: update, totalAtomic: total };
}

/** Display-friendly USDm string (8-decimal precision, trailing zeros trimmed). */
export function formatUSDm(atomic) {
  const a = BigInt(atomic);
  const sign = a < 0n ? '-' : '';
  const abs  = a < 0n ? -a : a;
  const intPart  = abs / ATOMIC;
  const fracPart = (abs % ATOMIC).toString().padStart(8, '0').replace(/0+$/, '');
  return fracPart.length
    ? `${sign}${intPart}.${fracPart}`
    : `${sign}${intPart}`;
}

/** Given a domain, return the bond tier label for UI display. */
export function bondTierLabel(domain) {
  const len = nameLengthForBond(domain);
  if (len <= 3)  return 'Premium short name (1-3 chars)';
  if (len <= 6)  return 'Standard name (4-6 chars)';
  if (len <= 10) return 'Common name (7-10 chars)';
  return 'Long-tail name (11+ chars)';
}
