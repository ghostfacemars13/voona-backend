/**
 * Voona — Lemon Squeezy (Merchant of Record)
 * ==============================================================
 *
 * Lemon Squeezy gère la TVA, émet les factures, encaisse pour vous.
 * Vous touchez 100% - 5% - 0,50€ par transaction.
 *
 * AVANTAGE pour solo founder : zéro paperasse fiscale.
 *
 * Setup :
 *   1. Créer compte sur https://app.lemonsqueezy.com
 *   2. Créer un Store (gratuit)
 *   3. Créer un Product "Voona Premium" avec 2 variants :
 *        - "Mensuel" : 2,99€/mois récurrent, essai 14j
 *        - "Annuel"  : 29€/an récurrent, essai 14j
 *   4. Récupérer le STORE_ID et les VARIANT_ID dans .env
 *   5. Récupérer un API key dans Settings → API
 *   6. Configurer un webhook (Settings → Webhooks) qui pointe vers
 *      https://votreapi.com/api/lemonsqueezy/webhook
 *      Events : subscription_created, subscription_updated,
 *               subscription_cancelled, subscription_payment_success
 *
 * Documentation : https://docs.lemonsqueezy.com/api
 */

import crypto from "crypto";

const LS_API = "https://api.lemonsqueezy.com/v1";

async function lsFetch(path, options = {}) {
  const res = await fetch(`${LS_API}${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
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
    const err = new Error(`Lemon Squeezy ${res.status} ${path}`);
    err.body = data;
    throw err;
  }
  return data;
}

export function mountLemonSqueezy(app, db) {
  // ----------------------------------------------------------------
  // 1) Créer une URL de checkout Lemon Squeezy
  //    POST /api/lemonsqueezy/checkout { plan, userId, email }
  // ----------------------------------------------------------------
  app.post("/api/lemonsqueezy/checkout", async (req, res) => {
    if (!process.env.LEMONSQUEEZY_API_KEY) {
      return res.status(503).json({ error: "lemonsqueezy_not_configured" });
    }
    const { plan = "yearly", userId = "anon", email } = req.body;
    const variantId =
      plan === "monthly"
        ? process.env.LEMONSQUEEZY_VARIANT_MONTHLY
        : process.env.LEMONSQUEEZY_VARIANT_YEARLY;
    const storeId = process.env.LEMONSQUEEZY_STORE_ID;
    if (!variantId || !storeId) {
      return res.status(400).json({ error: "missing_lemonsqueezy_ids" });
    }

    try {
      const data = await lsFetch("/checkouts", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "checkouts",
            attributes: {
              checkout_data: {
                email,
                custom: { user_id: userId, plan },
              },
              checkout_options: {
                embed: false,
                media: false,
                logo: true,
                desc: true,
                discount: true,
                dark: false,
              },
              product_options: {
                redirect_url: `${process.env.FRONTEND_URL}/success?provider=ls`,
                receipt_button_text: "Retour à Voona",
                receipt_thank_you_note: "Merci ! Votre Premium est activé.",
              },
            },
            relationships: {
              store: { data: { type: "stores", id: storeId } },
              variant: { data: { type: "variants", id: variantId } },
            },
          },
        }),
      });
      const url = data?.data?.attributes?.url;
      if (!url) throw new Error("no_url_returned");
      res.json({ url });
    } catch (e) {
      console.error("LS checkout error:", e.body || e);
      res.status(500).json({ error: "ls_checkout_failed", detail: e.body });
    }
  });

  // ----------------------------------------------------------------
  // 2) Webhook Lemon Squeezy
  //    Vérification HMAC SHA256 de la signature
  // ----------------------------------------------------------------
  app.post(
    "/api/lemonsqueezy/webhook",
    (req, res, next) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        req.rawBody = raw;
        next();
      });
    },
    (req, res) => {
      const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
      if (!secret) {
        console.warn("LEMONSQUEEZY_WEBHOOK_SECRET non configuré, signature ignorée");
      } else {
        const sig = req.headers["x-signature"];
        const expected = crypto
          .createHmac("sha256", secret)
          .update(req.rawBody)
          .digest("hex");
        if (sig !== expected) {
          return res.status(401).json({ error: "invalid_signature" });
        }
      }

      const event = JSON.parse(req.rawBody);
      const eventName = event.meta?.event_name;
      const userId = event.meta?.custom_data?.user_id;
      const attrs = event.data?.attributes || {};

      db.subscriptions = db.subscriptions || new Map();

      switch (eventName) {
        case "subscription_created":
        case "subscription_updated":
        case "subscription_resumed": {
          db.subscriptions.set(userId, {
            provider: "lemonsqueezy",
            subscriptionId: event.data?.id,
            status: attrs.status, // active | on_trial | past_due | unpaid | cancelled | expired
            plan: event.meta?.custom_data?.plan,
            email: attrs.user_email,
            currentPeriodEnd: attrs.renews_at,
            updatedAt: new Date().toISOString(),
          });
          console.log(`✨ LS ${eventName}: user ${userId} → ${attrs.status}`);
          break;
        }
        case "subscription_cancelled":
        case "subscription_expired": {
          if (db.subscriptions.has(userId)) {
            db.subscriptions.set(userId, {
              ...db.subscriptions.get(userId),
              status: "cancelled",
            });
          }
          break;
        }
        case "subscription_payment_failed": {
          console.warn(`⚠️ LS paiement échoué pour ${attrs.user_email}`);
          break;
        }
      }

      res.json({ received: true });
    }
  );

  // ----------------------------------------------------------------
  // 3) Portail client (gérer/annuler son abo)
  //    LS expose l'URL `urls.customer_portal` directement dans la sub
  // ----------------------------------------------------------------
  app.post("/api/lemonsqueezy/portal", async (req, res) => {
    const sub = db.subscriptions?.get(req.body.userId);
    if (!sub || sub.provider !== "lemonsqueezy") {
      return res.status(404).json({ error: "no_subscription" });
    }
    try {
      const data = await lsFetch(`/subscriptions/${sub.subscriptionId}`);
      const url = data?.data?.attributes?.urls?.customer_portal;
      res.json({ url });
    } catch (e) {
      res.status(500).json({ error: "portal_failed" });
    }
  });
}
