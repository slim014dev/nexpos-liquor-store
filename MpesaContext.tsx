// =============================================================================
// MpesaContext.tsx
// =============================================================================
// Manages all Safaricom Daraja API interaction for Lipa Na M-Pesa STK Push.
//
// Architecture (updated):
//   Browser  →  Express Proxy (server/index.js)  →  Daraja API
//
//   The proxy solves two problems:
//     1. CORS — Daraja rejects direct browser calls in production.
//     2. Callback — Safaricom POSTs the payment result to the proxy, which
//        stores it.  This context polls the proxy's /callback-result endpoint
//        instead of (or in addition to) the Daraja STK Query endpoint.
//
// Mock Mode:
//   Set MPESA_MOCK_MODE = true in mpesaConfig.ts to simulate the full flow
//   with no network calls (perfect for UI dev without ngrok).
//
// Usage:
//   Wrap your app with <MpesaProvider>.
//   Components consume via the `useMpesa()` hook.
//
//     const { stkStatus, initiatePayment, cancelPayment, errorMessage } = useMpesa();
// =============================================================================

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";

import {
  MPESA_MOCK_MODE,
  normalizeMpesaPhone,
  centsToKes,
} from "./mpesaConfig";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base URL of the Express proxy server. Comes from the Vite env var. */
const PROXY_BASE =
  (import.meta as unknown as { env: Record<string, string> }).env
    ?.VITE_PROXY_BASE_URL ?? "http://localhost:3001";

/** How long to wait between poll attempts (ms). */
const POLL_INTERVAL_MS = 3_000;

/** Max poll attempts before giving up (~30 s total). */
const MAX_POLL_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Full lifecycle of a single STK Push attempt.
 *
 * idle       → no payment attempt in progress
 * auth       → fetching a Bearer token (proxy step)
 * pushing    → STK Push sent; waiting for customer to enter PIN
 * polling    → checking callback-result / STK Query for completion
 * confirmed  → payment accepted ✅
 * failed     → cancelled, timed out, or Daraja error ❌
 * cancelled  → cashier manually cancelled before resolution
 */
export type StkStatus =
  | "idle"
  | "auth"
  | "pushing"
  | "polling"
  | "confirmed"
  | "failed"
  | "cancelled";

export interface MpesaPaymentResult {
  /** Daraja CheckoutRequestID — primary reference for this payment. */
  checkoutRequestId: string;
  /** M-Pesa receipt / transaction number (e.g. "RBK71BJ3Z1"). */
  mpesaReceiptNumber: string;
  /** Phone number the payment came from. */
  phoneNumber: string;
  /** Amount paid in KES (whole shillings). */
  amountKes: number;
}

interface MpesaContextValue {
  /** Current status of the STK Push state machine. */
  stkStatus: StkStatus;

  /** Human-readable error string set when `stkStatus === "failed"`. null otherwise. */
  errorMessage: string | null;

  /**
   * The CheckoutRequestID returned after a successful push.
   * Useful for displaying on the receipt or logging.
   */
  checkoutRequestId: string | null;

  /** Full result populated only after `stkStatus === "confirmed"`. null otherwise. */
  paymentResult: MpesaPaymentResult | null;

  /**
   * Initiate an STK Push to the customer's phone.
   *
   * @param phoneNumber   Kenyan number (07xxxxxxxx or 2547xxxxxxxx)
   * @param amountInCents Cart total in cents (converted to KES internally)
   * @param accountRef    Label shown on customer's M-Pesa prompt (≤ 12 chars)
   * @param description   Description on the push prompt (≤ 13 chars)
   *
   * Resolves with MpesaPaymentResult on success, rejects on failure/cancel.
   */
  initiatePayment: (
    phoneNumber: string,
    amountInCents: number,
    accountRef?: string,
    description?: string
  ) => Promise<MpesaPaymentResult>;

  /** Abort the pending STK Push (if still pushing/polling). */
  cancelPayment: () => void;

  /** Reset context to idle (call after handling confirmed/failed). */
  resetMpesa: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const MpesaContext = createContext<MpesaContextValue | null>(null);

// ---------------------------------------------------------------------------
// Proxy API helpers
// ---------------------------------------------------------------------------

/**
 * Sends the STK Push via the proxy.
 * Returns the CheckoutRequestID on success.
 */
async function proxyStkPush(
  phoneNumber: string,
  amountKes: number,
  accountRef: string,
  description: string
): Promise<string> {
  const res = await fetch(`${PROXY_BASE}/api/mpesa/stk-push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber, amountKes, accountRef, description }),
  });

  const data = await res.json() as {
    checkoutRequestId?: string;
    error?: string;
    detail?: unknown;
  };

  if (!res.ok || !data.checkoutRequestId) {
    throw new Error(`[M-Pesa] STK Push failed: ${data.error ?? res.statusText}`);
  }

  return data.checkoutRequestId;
}

/**
 * Polls the proxy's /callback-result endpoint first (callback-driven).
 * Falls back to querying Daraja directly via /stk-query.
 *
 * Returns:
 *   { resultCode, resultDesc, mpesaReceiptNumber }
 */
async function proxyQueryStatus(
  checkoutRequestId: string
): Promise<{ resultCode: string; resultDesc: string; mpesaReceiptNumber?: string }> {
  // 1. Check if the Safaricom callback has already arrived at the proxy
  const callbackRes = await fetch(
    `${PROXY_BASE}/api/mpesa/callback-result/${encodeURIComponent(checkoutRequestId)}`
  );

  if (callbackRes.status === 200) {
    const data = await callbackRes.json() as {
      resultCode: string;
      resultDesc: string;
      mpesaReceiptNumber?: string | null;
    };
    return {
      resultCode:         String(data.resultCode),
      resultDesc:         data.resultDesc,
      mpesaReceiptNumber: data.mpesaReceiptNumber ?? undefined,
    };
  }

  // 2. Callback not arrived yet — fall back to STK Query polling
  const queryRes = await fetch(`${PROXY_BASE}/api/mpesa/stk-query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkoutRequestId }),
  });

  if (!queryRes.ok) {
    const err = await queryRes.json() as { error?: string };
    throw new Error(`[M-Pesa] STK Query failed: ${err.error ?? queryRes.statusText}`);
  }

  const data = await queryRes.json() as {
    resultCode: string;
    resultDesc: string;
    mpesaReceiptNumber?: string;
  };

  return data;
}

// ---------------------------------------------------------------------------
// Mock implementation (no network calls)
// ---------------------------------------------------------------------------

async function mockStkPush(
  phoneNumber: string,
  amountKes: number
): Promise<MpesaPaymentResult> {
  // Simulate auth + push latency
  await new Promise<void>((res) => setTimeout(res, 1_500));
  const mockCheckoutId = `MOCK-CID-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  // Simulate customer entering PIN (3-second pause)
  await new Promise<void>((res) => setTimeout(res, 3_000));
  const mockReceiptNumber = `MOCK-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;

  return {
    checkoutRequestId: mockCheckoutId,
    mpesaReceiptNumber: mockReceiptNumber,
    phoneNumber,
    amountKes,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function MpesaProvider({ children }: { children: ReactNode }) {
  const [stkStatus, setStkStatus]                 = useState<StkStatus>("idle");
  const [errorMessage, setErrorMessage]           = useState<string | null>(null);
  const [checkoutRequestId, setCheckoutRequestId] = useState<string | null>(null);
  const [paymentResult, setPaymentResult]         = useState<MpesaPaymentResult | null>(null);

  const cancelledRef = useRef(false);

  const resetMpesa = useCallback(() => {
    setStkStatus("idle");
    setErrorMessage(null);
    setCheckoutRequestId(null);
    setPaymentResult(null);
    cancelledRef.current = false;
  }, []);

  const cancelPayment = useCallback(() => {
    cancelledRef.current = true;
    setStkStatus("cancelled");
    setErrorMessage(null);
  }, []);

  const initiatePayment = useCallback(
    async (
      phoneNumber: string,
      amountInCents: number,
      accountRef  = "LiquorPOS",
      description = "Store Payment"
    ): Promise<MpesaPaymentResult> => {
      // Reset any previous run
      cancelledRef.current = false;
      setPaymentResult(null);
      setErrorMessage(null);
      setCheckoutRequestId(null);

      // ── MOCK MODE ──────────────────────────────────────────────────────────
      if (MPESA_MOCK_MODE) {
        setStkStatus("pushing");
        try {
          const normalizedPhone = normalizeMpesaPhone(phoneNumber);
          const amountKes       = centsToKes(amountInCents);

          setStkStatus("polling");
          const result = await mockStkPush(normalizedPhone, amountKes);

          if (cancelledRef.current) throw new Error("[M-Pesa] Payment cancelled by cashier.");

          setPaymentResult(result);
          setCheckoutRequestId(result.checkoutRequestId);
          setStkStatus("confirmed");
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Mock M-Pesa failed.";
          setErrorMessage(msg);
          setStkStatus("failed");
          throw err;
        }
      }

      // ── REAL DARAJA FLOW (via proxy) ───────────────────────────────────────

      // 1. Normalise phone number
      let normalizedPhone: string;
      try {
        normalizedPhone = normalizeMpesaPhone(phoneNumber);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid phone number.";
        setErrorMessage(msg);
        setStkStatus("failed");
        throw err;
      }

      const amountKes = centsToKes(amountInCents);

      // 2. Send STK Push via proxy
      setStkStatus("pushing");
      let reqId: string;
      try {
        reqId = await proxyStkPush(normalizedPhone, amountKes, accountRef, description);
        setCheckoutRequestId(reqId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "STK Push failed.";
        setErrorMessage(msg);
        setStkStatus("failed");
        throw err;
      }

      if (cancelledRef.current) {
        setStkStatus("cancelled");
        throw new Error("[M-Pesa] Cancelled after STK Push.");
      }

      // 3. Poll proxy (callback-result endpoint + STK Query fallback)
      setStkStatus("polling");
      let attempts = 0;

      return new Promise<MpesaPaymentResult>((resolve, reject) => {
        const poll = async () => {
          if (cancelledRef.current) {
            setStkStatus("cancelled");
            reject(new Error("[M-Pesa] Payment cancelled by cashier."));
            return;
          }

          attempts++;
          if (attempts > MAX_POLL_ATTEMPTS) {
            const msg = "Payment timed out. Ask customer to check their M-Pesa messages.";
            setErrorMessage(msg);
            setStkStatus("failed");
            reject(new Error(`[M-Pesa] ${msg}`));
            return;
          }

          try {
            const { resultCode, resultDesc, mpesaReceiptNumber } =
              await proxyQueryStatus(reqId);

            if (resultCode === "0") {
              // ✅ Payment confirmed
              const result: MpesaPaymentResult = {
                checkoutRequestId: reqId,
                mpesaReceiptNumber: mpesaReceiptNumber ?? reqId,
                phoneNumber: normalizedPhone,
                amountKes,
              };
              setPaymentResult(result);
              setStkStatus("confirmed");
              resolve(result);
              return;
            }

            if (resultCode === "1032" || resultCode === "1037") {
              // Customer cancelled (1032) or STK timed out (1037)
              const msg =
                resultCode === "1032"
                  ? "Customer cancelled the M-Pesa prompt."
                  : "M-Pesa request timed out on customer's phone.";
              setErrorMessage(msg);
              setStkStatus("failed");
              reject(new Error(`[M-Pesa] ${msg}`));
              return;
            }

            // Still pending — retry after interval
            setTimeout(poll, POLL_INTERVAL_MS);
          } catch (err) {
            // Network error during polling — retry until exhausted
            if (attempts >= MAX_POLL_ATTEMPTS) {
              const msg = err instanceof Error ? err.message : "Polling error.";
              setErrorMessage(msg);
              setStkStatus("failed");
              reject(err);
            } else {
              setTimeout(poll, POLL_INTERVAL_MS);
            }
          }
        };

        // First poll — wait one interval to let Daraja process the request
        setTimeout(poll, POLL_INTERVAL_MS);
      });
    },
    []
  );

  // ── Context value ────────────────────────────────────────────────────────

  const value: MpesaContextValue = {
    stkStatus,
    errorMessage,
    checkoutRequestId,
    paymentResult,
    initiatePayment,
    cancelPayment,
    resetMpesa,
  };

  return (
    <MpesaContext.Provider value={value}>
      {children}
    </MpesaContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Consumer Hook
// ---------------------------------------------------------------------------

/**
 * `useMpesa` — primary hook for M-Pesa payment state and actions.
 *
 * Must be called inside a <MpesaProvider> tree.
 *
 * @example
 *   const { stkStatus, initiatePayment, cancelPayment } = useMpesa();
 *
 *   async function handleMpesaCheckout() {
 *     try {
 *       const result = await initiatePayment(phoneNumber, cart.totalInCents);
 *       cart.checkout("mpesa", undefined, result.mpesaReceiptNumber, result.checkoutRequestId);
 *     } catch {
 *       // stkStatus === "failed" — show errorMessage to cashier
 *     }
 *   }
 */
export function useMpesa(): MpesaContextValue {
  const ctx = useContext(MpesaContext);
  if (!ctx) {
    throw new Error(
      "[useMpesa] must be called inside a <MpesaProvider>. " +
      "Wrap your POS route or app root with <MpesaProvider>."
    );
  }
  return ctx;
}
