/**
 * Voona — Stripe (abonnement Premium)
 * ==============================================================
 *
 * Modèle :
 *   - Plan mensuel : 2,99€/mois
 *   - Plan annuel : 29€/an (~19% d'économie)
 *   - Essai gratuit 14 jours (Stripe gère automatiquement)
 *
 * Flow :
 *   1. User clique "S'abonner" → POST /api/stripe/checkout
 *   2. On crée une Stripe Checkout Session, on renvoie l'URL
 *   3. User paie sur la page Stripe hébergée (PCI compliant)
 *   4. Stripe redirige vers /success ou /cancel
 *   5. Stripe envoie un webhook customer.subscription.created → on
 *      flag l'utilisateur comme Premium en DB
 *
 * Setup :
 *   1. https://dashboard.stripe.com → créer un produit + 2 prix
 *      (mensuel et annuel) avec essai 14 jours
 *   2. Copier les price_id dans .env :
 *      STRIPE_PRICE_MONTHLY=price_xxx
 *      STRIPE_PRICE_YEARLY=price_yyy
 *   3. STRIPE_SECRET_KEY=sk_test_... (clé secrète test)
 *   4. STRIPE_WEBHOOK_SECRET=whsec_... (récupéré au moment de
 *      configurer le webhook https://dashboard.stripe.com/webhooks)
 */

import Stripe from "stripe";

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
}

const PRICE_IDS = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  yearly: process.env.STRIPE_PRICE_YEARLY,
};

export function mountStripe(app, db) {
  // ----------------------------------------------------------------
  // 1) Créer une Checkout Session
  // ----------------------------------------------------------------
  app.post("/api/stripe/checkout", async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: "stripe_not_configured" });
    }
    const { plan = "yearly", userId, email } = req.body;
    const priceId = PRICE_IDS[plan];
    if (!priceId) return res.status(400).json({ error: "invalid_plan" });

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: {
          trial_period_days: 14,
          metadata: { userId: userId || "anon", plan },
        },
        customer_email: email || undefined,
        success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL}/cancel`,
        allow_promotion_codes: true,
        locale: "fr",
      });
      res.json({ url: session.url, sessionId: session.id });
    } catch (e) {
      console.error("Stripe checkout error:", e.message);
      res.status(500).json({ error: "checkout_failed", message: e.message });
    }
  });

  // ----------------------------------------------------------------
  // 2) Créer un lien vers le portail client (gérer/annuler l'abo)
  // ----------------------------------------------------------------
  app.post("/api/stripe/portal", async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "stripe_not_configured" });
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: "no_customer" });
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${process.env.FRONTEND_URL}/profile`,
      });
      res.json({ url: portal.url });
    } catch (e) {
      res.status(500).json({ error: "portal_failed", message: e.message });
    }
  });

  // ----------------------------------------------------------------
  // 3) Webhook Stripe (events de subscription)
  //    À configurer sur https://dashboard.stripe.com/webhooks
  //    Events à écouter :
  //      - checkout.session.completed
  //      - customer.subscription.created
  //      - customer.subscription.updated
  //      - customer.subscription.deleted
  //      - invoice.paid
  //      - invoice.payment_failed
  // ----------------------------------------------------------------
  app.post(
    "/api/stripe/webhook",
    (req, res, next) => {
      // Important : raw body pour vérifier la signature
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        req.rawBody = raw;
        next();
      });
    },
    async (req, res) => {
      if (!stripe) return res.sendStatus(503);
      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.rawBody,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (e) {
        console.error("Webhook signature error:", e.message);
        return res.status(400).send(`Webhook Error: ${e.message}`);
      }

      db.subscriptions = db.subscriptions || new Map();

      switch (event.type) {
        case "checkout.session.completed": {
          const s = event.data.object;
          const userId = s.metadata?.userId || s.customer_email;
          db.subscriptions.set(userId, {
            customerId: s.customer,
            subscriptionId: s.subscription,
            status: "trialing",
            plan: s.metadata?.plan || "yearly",
            updatedAt: new Date().toISOString(),
          });
          console.log(`✨ User ${userId} a démarré son essai Premium`);
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.created": {
          const sub = event.data.object;
          const userId = sub.metadata?.userId;
          if (userId) {
            db.subscriptions.set(userId, {
              customerId: sub.customer,
              subscriptionId: sub.id,
              status: sub.status, // active | trialing | past_due | canceled
              plan: sub.metadata?.plan,
              currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const userId = sub.metadata?.userId;
          if (userId && db.subscriptions.has(userId)) {
            db.subscriptions.set(userId, {
              ...db.subscriptions.get(userId),
              status: "canceled",
            });
          }
          break;
        }
        case "invoice.payment_failed": {
          const inv = event.data.object;
          console.warn(`⚠️ Paiement échoué pour ${inv.customer_email}`);
          // Envoyez un email à l'utilisateur ici
          break;
        }
      }

      res.json({ received: true });
    }
  );

  // ----------------------------------------------------------------
  // 4) Vérifier le statut Premium d'un utilisateur (appelé par le front)
  // ----------------------------------------------------------------
  app.get("/api/stripe/status/:userId", (req, res) => {
    const sub = db.subscriptions?.get(req.params.userId);
    if (!sub) return res.json({ isPremium: false });
    const isPremium = ["active", "trialing"].includes(sub.status);
    res.json({
      isPremium,
      status: sub.status,
      plan: sub.plan,
      currentPeriodEnd: sub.currentPeriodEnd,
    });
  });
}
