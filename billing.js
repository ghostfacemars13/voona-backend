/**
 * Endpoints unifiés de billing (statut, annulation)
 * Marche peu importe le provider (Lemon Squeezy ou PayPal).
 */

export function mountBilling(app, db) {
  // ----------------------------------------------------------------
  // Statut Premium pour un user (front appelle ça au démarrage)
  // ----------------------------------------------------------------
  app.get("/api/billing/status/:userId", (req, res) => {
    const sub = db.subscriptions?.get(req.params.userId);
    if (!sub) return res.json({ isPremium: false });
    const isPremium = ["active", "trialing", "on_trial"].includes(sub.status);
    res.json({
      isPremium,
      provider: sub.provider,
      status: sub.status,
      plan: sub.plan,
      currentPeriodEnd: sub.currentPeriodEnd,
    });
  });

  // ----------------------------------------------------------------
  // Liste les méthodes de paiement disponibles côté serveur
  // (le front affiche/cache les boutons selon ce qui est configuré)
  // ----------------------------------------------------------------
  app.get("/api/billing/providers", (_, res) => {
    res.json({
      lemonsqueezy: !!process.env.LEMONSQUEEZY_API_KEY,
      paypal: !!process.env.PAYPAL_CLIENT_ID,
    });
  });
}
