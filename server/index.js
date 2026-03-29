// =============================================================================
// server/index.js
// =============================================================================
// Thin Express proxy that sits between the POS browser app and Safaricom
// Daraja API.  This solves two problems:
//
//   1. CORS — Daraja does not allow direct browser-to-API calls in production.
//      All Daraja requests are forwarded from here (server-to-server = no CORS).
//
//   2. Callback receiver — Safaricom POSTs payment confirmations to a public
//      URL.  This server receives those callbacks, stores the result in memory,
//      and exposes a /api/mpesa/callback-result endpoint the frontend polls.
//
// Routes:
//   POST /api/mpesa/token          → proxy auth token request to Daraja
//   POST /api/mpesa/stk-push       → proxy STK Push to Daraja
//   POST /api/mpesa/stk-query      → proxy STK Query to Daraja
//   POST /api/mpesa/callback       → receive Safaricom payment callback
//   GET  /api/mpesa/callback-result/:checkoutRequestId  → frontend polls this
//   GET  /health                   → liveness check
// =============================================================================

require("dotenv").config({ path: "../.env" });

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PROXY_PORT || 3001;

// ---------------------------------------------------------------------------
// Config (read from .env)
// ---------------------------------------------------------------------------

const CONFIG = {
  consumerKey:    process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortCode:      process.env.MPESA_SHORTCODE,
  passkey:        process.env.MPESA_PASSKEY,
  callbackUrl:    process.env.MPESA_CALLBACK_URL,
  baseUrl:        process.env.MPESA_BASE_URL || "https://sandbox.safaricom.co.ke",
};

// Validate required env vars at startup
const REQUIRED = ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY", "MPESA_CALLBACK_URL"];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.warn(`⚠️  [proxy] Missing env var: ${key} — copy .env.example to .env and fill it in.`);
  }
}

// ---------------------------------------------------------------------------
// In-memory callback store
// ---------------------------------------------------------------------------
// Keyed by CheckoutRequestID → callback payload from Safaricom.
// In production, use Redis or a database so multiple server instances share state.

/** @type {Map<string, object>} */
const callbackStore = new Map();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// CORS — allow the Vite dev server and any configured origin
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0
    ? (origin, cb) => {
        // Allow requests with no origin (e.g. curl, Postman, server-to-server)
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`Origin ${origin} not allowed by CORS`));
      }
    : true,  // allow all when ALLOWED_ORIGINS is empty
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns EAT timestamp in YYYYMMDDHHmmss format (Daraja requirement). */
function getMpesaTimestamp() {
  const now = new Date();
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000); // UTC+3
  const pad = (n) => n.toString().padStart(2, "0");
  return (
    eat.getUTCFullYear() +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  );
}

/** Base64(shortCode + passkey + timestamp) */
function getMpesaPassword(timestamp) {
  return Buffer.from(`${CONFIG.shortCode}${CONFIG.passkey}${timestamp}`).toString("base64");
}

/** Basic Auth header value for the OAuth endpoint. */
function getBasicAuth() {
  return Buffer.from(`${CONFIG.consumerKey}:${CONFIG.consumerSecret}`).toString("base64");
}

/** Cached access token + expiry */
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Returns a valid Daraja Bearer token.
 * Tokens are cached for 55 minutes (tokens live ~60 min).
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const url = `${CONFIG.baseUrl}/oauth/v1/generate?grant_type=client_credentials`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${getBasicAuth()}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[Daraja] OAuth failed: ${res.status} — ${body}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("[Daraja] OAuth response missing access_token");

  cachedToken = data.access_token;
  tokenExpiresAt = now + 55 * 60 * 1000; // 55 minutes
  console.log("[proxy] Access token refreshed.");
  return cachedToken;
}

// ---------------------------------------------------------------------------
// Route: GET /health
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    env: process.env.MPESA_BASE_URL?.includes("sandbox") ? "sandbox" : "production",
    callbackUrl: CONFIG.callbackUrl,
  });
});

// ---------------------------------------------------------------------------
// Route: POST /api/mpesa/token
// ---------------------------------------------------------------------------
// Frontend calls this to get a fresh OAuth token (useful if the frontend ever
// needs to include it for debugging — normally the proxy handles it internally).

app.post("/api/mpesa/token", async (_req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ access_token: token });
  } catch (err) {
    console.error("[proxy] /token error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Route: POST /api/mpesa/stk-push
// ---------------------------------------------------------------------------
// Body: { phoneNumber, amountKes, accountRef, description }

app.post("/api/mpesa/stk-push", async (req, res) => {
  const { phoneNumber, amountKes, accountRef = "LiquorPOS", description = "Store Payment" } = req.body;

  if (!phoneNumber || !amountKes) {
    return res.status(400).json({ error: "phoneNumber and amountKes are required." });
  }

  try {
    const accessToken = await getAccessToken();
    const timestamp   = getMpesaTimestamp();
    const password    = getMpesaPassword(timestamp);

    const body = {
      BusinessShortCode: CONFIG.shortCode,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   "CustomerPayBillOnline",
      Amount:            Math.max(1, Math.ceil(amountKes)),
      PartyA:            phoneNumber,
      PartyB:            CONFIG.shortCode,
      PhoneNumber:       phoneNumber,
      CallBackURL:       CONFIG.callbackUrl,
      AccountReference:  String(accountRef).slice(0, 12),
      TransactionDesc:   String(description).slice(0, 13),
    };

    const darajaRes = await fetch(`${CONFIG.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await darajaRes.json();

    if (!darajaRes.ok || data.ResponseCode !== "0") {
      const msg = data.errorMessage || data.ResponseDescription || "STK Push rejected";
      console.error("[proxy] STK Push error:", data);
      return res.status(502).json({ error: msg, detail: data });
    }

    console.log(`[proxy] STK Push sent → CheckoutRequestID: ${data.CheckoutRequestID}`);
    res.json({
      checkoutRequestId:   data.CheckoutRequestID,
      merchantRequestId:   data.MerchantRequestID,
      responseDescription: data.ResponseDescription,
    });
  } catch (err) {
    console.error("[proxy] /stk-push error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Route: POST /api/mpesa/stk-query
// ---------------------------------------------------------------------------
// Body: { checkoutRequestId }

app.post("/api/mpesa/stk-query", async (req, res) => {
  const { checkoutRequestId } = req.body;
  if (!checkoutRequestId) {
    return res.status(400).json({ error: "checkoutRequestId is required." });
  }

  // First, check if the callback already arrived (faster than polling Daraja)
  if (callbackStore.has(checkoutRequestId)) {
    const stored = callbackStore.get(checkoutRequestId);
    console.log(`[proxy] STK Query satisfied from callback cache: ${checkoutRequestId}`);
    return res.json(stored);
  }

  try {
    const accessToken = await getAccessToken();
    const timestamp   = getMpesaTimestamp();
    const password    = getMpesaPassword(timestamp);

    const body = {
      BusinessShortCode: CONFIG.shortCode,
      Password:          password,
      Timestamp:         timestamp,
      CheckoutRequestID: checkoutRequestId,
    };

    const darajaRes = await fetch(`${CONFIG.baseUrl}/mpesa/stkpushquery/v1/query`, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await darajaRes.json();

    if (!darajaRes.ok) {
      return res.status(502).json({ error: data.errorMessage || "STK Query failed", detail: data });
    }

    // Extract M-Pesa receipt number from callback metadata if present
    let mpesaReceiptNumber = null;
    if (data.CallbackMetadata?.Item) {
      const item = data.CallbackMetadata.Item.find((i) => i.Name === "MpesaReceiptNumber");
      if (item?.Value) mpesaReceiptNumber = String(item.Value);
    }

    res.json({
      resultCode:          data.ResultCode,
      resultDesc:          data.ResultDesc,
      mpesaReceiptNumber,
    });
  } catch (err) {
    console.error("[proxy] /stk-query error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Route: POST /api/mpesa/callback
// ---------------------------------------------------------------------------
// Safaricom calls this URL when the customer completes (or cancels) payment.
// This is a server-to-server call from Safaricom's servers, so no auth needed
// — but we validate the expected body shape.

app.post("/api/mpesa/callback", (req, res) => {
  try {
    const body = req.body;
    const stk = body?.Body?.stkCallback;

    if (!stk) {
      console.warn("[proxy] Callback received but missing Body.stkCallback:", body);
      return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid callback body" });
    }

    const checkoutRequestId  = stk.CheckoutRequestID;
    const resultCode         = stk.ResultCode;
    const resultDesc         = stk.ResultDesc;

    // Extract receipt + metadata
    let mpesaReceiptNumber = null;
    let phoneNumber        = null;
    let amountKes          = null;
    let transactionDate    = null;

    if (stk.CallbackMetadata?.Item) {
      for (const item of stk.CallbackMetadata.Item) {
        switch (item.Name) {
          case "MpesaReceiptNumber": mpesaReceiptNumber = String(item.Value); break;
          case "PhoneNumber":        phoneNumber        = String(item.Value); break;
          case "Amount":             amountKes          = Number(item.Value); break;
          case "TransactionDate":    transactionDate    = String(item.Value); break;
        }
      }
    }

    const result = {
      resultCode:          String(resultCode),
      resultDesc,
      mpesaReceiptNumber,
      phoneNumber,
      amountKes,
      transactionDate,
      receivedAt:          new Date().toISOString(),
    };

    // Store for the frontend to pick up via /callback-result
    callbackStore.set(checkoutRequestId, result);

    if (resultCode === 0) {
      console.log(`[proxy] ✅ Payment confirmed: ${checkoutRequestId} | Receipt: ${mpesaReceiptNumber}`);
    } else {
      console.log(`[proxy] ❌ Payment failed/cancelled: ${checkoutRequestId} | ${resultDesc}`);
    }

    // Acknowledge to Safaricom — must respond with 200 and this exact format
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("[proxy] /callback error:", err.message);
    // Still respond 200 so Safaricom doesn't keep retrying
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// ---------------------------------------------------------------------------
// Route: GET /api/mpesa/callback-result/:checkoutRequestId
// ---------------------------------------------------------------------------
// The frontend polls this endpoint after initiating an STK Push.
// Returns the callback result once it arrives, or 204 if still pending.

app.get("/api/mpesa/callback-result/:checkoutRequestId", (req, res) => {
  const { checkoutRequestId } = req.params;
  const result = callbackStore.get(checkoutRequestId);

  if (!result) {
    // Not arrived yet — 204 No Content signals "still waiting"
    return res.status(204).send();
  }

  // Return and remove from store (one-time pickup)
  callbackStore.delete(checkoutRequestId);
  res.json(result);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`\n🚀 M-Pesa proxy server running on http://localhost:${PORT}`);
  console.log(`   Environment : ${CONFIG.baseUrl.includes("sandbox") ? "SANDBOX" : "PRODUCTION"}`);
  console.log(`   Callback URL: ${CONFIG.callbackUrl}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
});
