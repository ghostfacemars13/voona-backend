/**
 * Extensions backend pour les fonctionnalités "Yuka-style" :
 *   - Recommandations d'alternatives moins chères
 *   - Avis communautaires sur produits
 *   - Souscriptions push pour alertes baisse de prix
 *   - Détection de baisses de prix → notifs push
 *
 * À monter dans server.js :
 *   import { mountExtensions } from "./routes-extensions.js";
 *   mountExtensions(app, db);
 */

import webpush from "web-push";

// Génération des clés VAPID (à faire une seule fois) :
//   npx web-push generate-vapid-keys
//   → puis stockez dans .env : VAPID_PUBLIC, VAPID_PRIVATE
//
// Le client appelle GET /api/push/key pour récupérer la public key,
// s'abonne avec la Push API du navigateur, puis POST /api/push/subscribe
// pour enregistrer son endpoint.

export function mountExtensions(app, db) {
  // === Notifications push ===
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
    webpush.setVapidDetails(
      `mailto:${process.env.CONTACT_EMAIL || "contact@voona.example"}`,
      process.env.VAPID_PUBLIC,
      process.env.VAPID_PRIVATE
    );
  }

  app.get("/api/push/key", (_, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC || null });
  });

  app.post("/api/push/subscribe", (req, res) => {
    const { subscription, userId, favorites = [] } = req.body;
    if (!subscription) return res.status(400).json({ error: "no_subscription" });
    db.pushSubscriptions = db.pushSubscriptions || new Map();
    db.pushSubscriptions.set(userId || subscription.endpoint, {
      subscription,
      favorites,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  app.post("/api/push/unsubscribe", (req, res) => {
    const { userId, endpoint } = req.body;
    db.pushSubscriptions?.delete(userId || endpoint);
    res.json({ ok: true });
  });

  // === Alternatives moins chères ===
  // Pour un produit donné, retourne les alternatives MDD ou catégorie similaire.
  // En prod, indexer via embeddings (catégorie + descriptif) avec pgvector.
  app.get("/api/alternatives/:barcode", (req, res) => {
    const alts = db.alternatives?.get(req.params.barcode) || [];
    res.json(alts);
  });

  // === Avis communautaires ===
  app.get("/api/reviews/:barcode", (req, res) => {
    const list = db.reviews?.get(req.params.barcode) || [];
    res.json(list);
  });

  app.post("/api/reviews/:barcode", (req, res) => {
    const { text, positive, userId = "anon" } = req.body;
    if (!text || typeof positive !== "boolean") {
      return res.status(400).json({ error: "invalid" });
    }
    db.reviews = db.reviews || new Map();
    const list = db.reviews.get(req.params.barcode) || [];
    list.unshift({
      text,
      positive,
      userId,
      date: new Date().toISOString(),
    });
    db.reviews.set(req.params.barcode, list.slice(0, 100));
    res.json({ ok: true });
  });
}

// ==============================================================
// Détection de baisses de prix → trigger push notif
// À appeler après chaque ajout de prix (dans server.js#addPrice)
// ==============================================================
export async function maybeNotifyPriceDrop(db, barcode, newPrice) {
  if (!db.pushSubscriptions) return;
  // Récupère le prix le plus bas précédent pour ce barcode
  const allPrices = db.prices.get(barcode) || [];
  if (allPrices.length < 2) return;
  const sorted = [...allPrices].sort((a, b) => a.price - b.price);
  const previousMin = sorted[1]?.price; // 2e car le nouveau est probablement le 1er
  if (!previousMin || newPrice >= previousMin) return;
  const dropPct = ((previousMin - newPrice) / previousMin) * 100;
  if (dropPct < 5) return; // ignore les micro-baisses

  // Notifie tous les users qui ont ce produit en favori
  for (const [userId, sub] of db.pushSubscriptions) {
    if (!sub.favorites?.includes(barcode)) continue;
    try {
      await webpush.sendNotification(
        sub.subscription,
        JSON.stringify({
          title: "💰 Baisse de prix !",
          body: `${db.products.get(barcode)?.name || "Un produit favori"} est à ${newPrice.toFixed(
            2
          )}€ (-${dropPct.toFixed(0)}%)`,
          url: `/?barcode=${barcode}`,
        })
      );
    } catch (e) {
      // Subscription expirée ? On la supprime
      if (e.statusCode === 410) db.pushSubscriptions.delete(userId);
      else console.warn("push failed:", e.message);
    }
  }
}
