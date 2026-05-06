# Voona — Backend

Agrégateur de prix multi-sources avec rafraîchissement quotidien à 8h.

## Sources de données

| Source            | Type         | Légalité       | Volume     | Fraîcheur |
|-------------------|--------------|----------------|------------|-----------|
| Open Food Facts   | API publique | ✅ libre       | ~3M produits | mensuelle |
| Open Prices       | API publique | ✅ libre       | ~200K prix   | quotidienne |
| Bonial.fr         | Scraping     | ⚠️ tolérable   | promos/sem | hebdo |
| Crowd users       | Crowd        | ✅             | dépend volume | temps réel |
| Tickets OCR       | Tesseract    | ✅             | dépend volume | temps réel |

## Démarrage

```bash
cd backend-prix
npm install
cp .env.example .env  # optionnel pour Open Prices / Mindee
npm start
```

Le serveur démarre sur `http://localhost:4000` et déclenche un refresh
initial pour amorcer la base. Le cron quotidien tourne ensuite à 8h00
Europe/Paris automatiquement.

## Endpoints

```
GET  /api/products/search?q=nutella       → recherche dans OFF
GET  /api/prices/:barcode                 → produit + prix agrégés
POST /api/prices                          → user soumet un prix
     body: { barcode, storeId, price, isPromo }
POST /api/receipts                        → upload ticket de caisse (multipart)
     field: "image" (jpg/png), "storeHint" (optionnel)
POST /api/refresh                         → déclenche le cron manuellement
GET  /health                              → stats DB
```

## Effet réseau

Plus vous avez d'utilisateurs qui scannent et soumettent des prix, plus
la base devient riche — c'est le modèle qui a fait Yuka (50M users).

À chaque scan/upload :
1. Vous enrichissez votre DB locale (`/api/prices`)
2. Vous renvoyez aussi le prix vers **Open Prices** (si `OPEN_PRICES_TOKEN`
   configuré) → bénéfice mutuel avec la communauté

## Architecture du cron

```js
cron.schedule("0 8 * * *", async () => {
  // Pour chaque produit populaire :
  //   → fetch Open Prices
  //   → scrape Bonial
  //   → addPrice(...)
  // Persiste lastRefresh
}, { timezone: "Europe/Paris" });
```

En production, faites tourner le cron sur un job séparé (Render Cron Job,
Railway Cron, ou Github Action sur planning) plutôt que dans le serveur
HTTP, pour pouvoir scaler les deux indépendamment.

## Avant la prod

1. **Remplacez la DB en mémoire par PostgreSQL** (voir schéma dans `db.js`)
2. **Authentification utilisateur** : JWT pour signer les soumissions de
   prix et lutter contre le spam (un user qui spam des prix faux pour
   tromper la concurrence, ça arrive)
3. **Modération** : score de confiance par user, moyenne pondérée des prix
   soumis pour un même produit/magasin (déjà fait par Open Prices)
4. **Rate-limiting** sur tous les endpoints publics
5. **Bonial** : passez à leur **API B2B partenaire** plutôt que le
   scraping HTML pour éviter les ruptures
6. **Mindee** pour l'OCR : bien plus fiable que Tesseract sur les tickets
   réels (taux >95% vs ~70% pour Tesseract)
