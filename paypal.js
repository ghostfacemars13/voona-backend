/**
 * Voona — PayPal Subscriptions
 * ==============================================================
 *
 * Setup :
 *   1. Compte développeur sur https://developer.paypal.com
 *   2. Créer une App (REST API) en Sandbox puis en Live
 *      → récupérer Client ID + Client Secret
 *   3. Créer un Product : POST /v1/catalogs/products
 *      → exemple ci-dessous via le script setup-paypal.mjs
 *   4. Créer 2 Plans (mensuel + annuel) avec essai 14j
 *   5. Stocker les plan_id dans .env
 *   6. Configurer un webhook (Webhooks dans la console PayPal)
 *      Events : BILLING.SUBSCRIPTION.ACTIVATED,
 *               BILLING.SUBSCRIPTION.CANCELLED,
 *               BILLING.SUBSCRIPTION.SUSPENDED,
 *               PAYMENT.SALE.COMPLETED
 *
 * Frais : ~3,4% + 0,35€ par transaction (cher comparé à LS/CB).
 * Avantage : confiance utilisateurs, paiement en 2 clics.
 */

const PP_API = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("paypal_not_configured");

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${PP_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`paypal_auth_failed_${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function ppFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${PP_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`PayPal ${res.status} ${path}`);
    err.body = data;
    throw err;
  }
  return data;
}

export function mountPayPal(app, db) {
  // ----------------------------------------------------------------
  // 1) Créer une subscription PayPal
  //    POST /api/paypal/subscribe { plan, userId, email }
  //    → retourne approve_url où rediriger l'utilisateur
  // ----------------------------------------------------------------
  app.post("/api/paypal/subscribe", async (req, res) => {
    const { plan = "yearly", userId = "anon", email } = req.body;
    const planId =
      plan === "monthly"
        ? process.env.PAYPAL_PLAN_MONTHLY
        : process.env.PAYPAL_PLAN_YEARLY;
    if (!planId) {
      return res.status(400).json({ error: "missing_paypal_plan_id" });
    }

    try {
      const sub = await ppFetch("/v1/billing/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          plan_id: planId,
          custom_id: userId,
          subscriber: email ? { email_address: email } : undefined,
          application_context: {
            brand_name: "Voona",
            locale: "fr-FR",
            shipping_preference: "NO_SHIPPING",
            user_action: "SUBSCRIBE_NOW",
            payment_method: {
              payer_selected: "PAYPAL",
              payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED",
            },
            return_url: `${process.env.FRONTEND_URL}/success?provider=paypal`,
            cancel_url: `${process.env.FRONTEND_URL}/cancel`,
          },
        }),
      });

      const approveUrl = sub.links?.find((l) => l.rel === "approve")?.href;
      if (!approveUrl) throw new Error("no_approve_url");

      // Stocke en pending pour réconciliation au webhook
      db.pendingSubscriptions = db.pendingSubscriptions || new Map();
      db.pendingSubscriptions.set(sub.id, { userId, plan });

      res.json({ url: approveUrl, subscriptionId: sub.id });
    } catch (e) {
      console.error("PayPal subscribe error:", e.body || e);
      res.status(500).json({ error: "paypal_failed", detail: e.body });
    }
  });

  // ----------------------------------------------------------------
  // 2) Webhook PayPal
  //    À configurer sur https://developer.paypal.com → My apps → Webhooks
  // ----------------------------------------------------------------
  app.post("/api/paypal/webhook", async (req, res) => {
    const event = req.body;

    db.subscriptions = db.subscriptions || new Map();
    const subId = event.resource?.id;
    const userId =
      event.resource?.custom_id ||
      db.pendingSubscriptions?.get(subId)?.userId;
    const plan = db.pendingSubscriptions?.get(subId)?.plan;

    switch (event.event_type) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "BILLING.SUBSCRIPTION.RE-ACTIVATED": {
        db.subscriptions.set(userId, {
          provider: "paypal",
          subscriptionId: subId,
          status: "active",
          plan,
          email: event.resource?.subscriber?.email_address,
          currentPeriodEnd: event.resource?.billing_info?.next_billing_time,
          updatedAt: new Date().toISOString(),
        });
        console.log(`✨ PayPal sub activée pour user ${userId}`);
        break;
      }
      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.SUSPENDED":
      case "BILLING.SUBSCRIPTION.EXPIRED": {
        if (db.subscriptions.has(userId)) {
          db.subscriptions.set(userId, {
            ...db.subscriptions.get(userId),
            status: "cancelled",
          });
        }
        break;
      }
      case "PAYMENT.SALE.COMPLETED": {
        // Renouvellement réussi
        console.log(`💳 PayPal renouvellement pour ${userId}`);
        break;
      }
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
        console.warn(`⚠️ PayPal paiement échoué pour ${userId}`);
        break;
      }
    }

    res.json({ received: true });
  });

  // ----------------------------------------------------------------
  // 3) Annuler un abonnement
  // ----------------------------------------------------------------
  app.post("/api/paypal/cancel", async (req, res) => {
    const sub = db.subscriptions?.get(req.body.userId);
    if (!sub || sub.provider !== "paypal") {
      return res.status(404).json({ error: "no_subscription" });
    }
    try {
      await ppFetch(`/v1/billing/subscriptions/${sub.subscriptionId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "User requested cancellation" }),
      });
      db.subscriptions.set(req.body.userId, { ...sub, status: "cancelled" });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "cancel_failed", detail: e.body });
    }
  });
}
