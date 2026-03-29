// =============================================================================
// mpesaConfig.ts
// =============================================================================
// Safaricom Daraja API configuration for Lipa Na M-Pesa (STK Push).
//
// ⚠️  Credentials have been moved to the server/.env file (Express proxy).
//     This frontend file only holds:
//       • MPESA_MOCK_MODE toggle
//       • Pure helper functions (timestamp, phone normalizer, currency converter)
//
// The proxy server (server/index.js) reads credentials from ../.env at startup
// and makes all Daraja calls server-to-server (no CORS issues).
//
// For mock/dev: keep MPESA_MOCK_MODE = true
// For sandbox:  set MPESA_MOCK_MODE = false + run `npm start` in server/
// For prod:     update .env with production credentials + use a public URL
// =============================================================================

// ---------------------------------------------------------------------------
// Mock mode toggle
// ---------------------------------------------------------------------------

/**
 * When true, no real HTTP calls are made.
 * The STK push is simulated: after ~4.5 s it auto-confirms with a fake receipt.
 * When false, MpesaContext routes all calls through the Express proxy.
 */
export const MPESA_MOCK_MODE = true;   // ← flip to false to use the real proxy

// ---------------------------------------------------------------------------
// Helper: Timestamp
// ---------------------------------------------------------------------------

/**
 * Returns the current EAT (UTC+3) timestamp in YYYYMMDDHHmmss format.
 * Used by the proxy server; exported here for any shared utility needs.
 */
export function getMpesaTimestamp(): string {
  const now = new Date();
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    eat.getUTCFullYear().toString() +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  );
}

// ---------------------------------------------------------------------------
// Helper: Phone normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a Kenyan phone number to the international M-Pesa format (2547xxxxxxxx).
 *
 * Accepted inputs:
 *   07xxxxxxxx    → 2547xxxxxxxx
 *   7xxxxxxxx     → 2547xxxxxxxx
 *   2547xxxxxxxx  → 2547xxxxxxxx  (already correct)
 *   +2547xxxxxxxx → 2547xxxxxxxx  (strip leading +)
 *
 * Throws a user-friendly error if the number cannot be normalised.
 */
export function normalizeMpesaPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");

  if (/^2547\d{8}$/.test(digits)) return digits;
  if (/^07\d{8}$/.test(digits))   return "254" + digits.slice(1);
  if (/^7\d{8}$/.test(digits))    return "254" + digits;

  throw new Error(
    `[M-Pesa] Invalid phone number: "${raw}". ` +
    `Please enter a Kenyan number starting with 07 or 2547.`
  );
}

// ---------------------------------------------------------------------------
// Helper: Currency conversion
// ---------------------------------------------------------------------------

/**
 * Converts the cart total from cents to whole KES shillings.
 *
 * The mock database stores prices in "cents" (smallest unit).  In a USD store
 * 100 cents = $1.  In a KES context 100 cents = KES 1.
 *
 * M-Pesa requires the amount as a whole-number of shillings (no decimals).
 * A minimum of KES 1 is enforced (Daraja rejects amounts < 1).
 *
 * ⚠️  If your POS stores USD cents and you need to charge in KES, replace
 *     the formula below with an actual FX rate lookup before going live.
 */
export function centsToKes(cents: number): number {
  return Math.max(1, Math.ceil(cents / 100));
}
