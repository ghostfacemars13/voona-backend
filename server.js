/**
 * Voona — Backend
 * ==============================================================
 *
 * Agrège les prix produits depuis 5 sources :
 *   1. Open Food Facts        — base produits (3M réf)
 *   2. Open Prices            — prix crowd-sourcés (officiel OFF, 2024)
 *   3. Bonial.fr              — catalogues promo des enseignes
 *   4. Crowd utilisateurs     — soumissions via l'app
 *   5. Tickets de caisse OCR  — photos uploadées par les users
 *
 * Cron quotidien à 8h00 (Europe/Paris) :
 *   → rafraîchit Open Prices + Bonial pour les ~500 produits les plus
 *     scannés, écrit en DB, expose via /api/prices/:barcode
 *
 * Endpoints :
 *   GET  /api/prices/:barcode      → prix agrégés multi-sources
 *   GET  /api/products/search?q=   → recherche dans Open Food Facts
 *   POST /api/prices               → user soumet un prix vu en magasin
 *   POST /api/receipts             → user upload un ticket → OCR
 *   POST /api/refresh              → déclenche le cron manuellement
 *   GET  /health
 *
 * Lancement : npm install && npm start
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cron from "node-cron";
import multer from "multer";
import { fetchOpenFoodFactsProduct, searchOFF } from "./sources/openFoodFacts.js";
import { fetchOpenPrices, submitPriceToOpenPrices } from "./sources/openPrices.js";
import { scrapeBonial } from "./sources/bonial.js";
import { extractTicketWithOCR } from "./sources/receiptOCR.js";
import { fetchAllDrivesPrices } from "./sources/drives.js";
import { db, initDB } from "./db.js";
import { mountExtensions, maybeNotifyPriceDrop } from "./routes-extensions.js";
import { mountLemonSqueezy } from "./lemonsqueezy.js";
import { mountPayPal } from "./paypal.js";
import { mountBilling } from "./billing.js";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }));

initDB();
mountExtensions(app, db);
mountLemonSqueezy(app, db);
mountPayPal(app, db);
mountBilling(app, db);

// ------------------------------------------------------------------
// 1) Recherche produits dans Open Food Facts
// ------------------------------------------------------------------
app.get("/api/products/search", async (req, res) => {
  try {
    const products = await searchOFF(req.query.q || "");
    res.json(products);
  } catch (e) {
    res.status(500).json({ error: "search_failed", message: e.message });
  }
});

// ------------------------------------------------------------------
// 2) Détails produit + prix agrégés
//    Combine TOUTES les sources, pondère et renvoie un classement.
// ------------------------------------------------------------------
app.get("/api/prices/:barcode", async (req, res) => {
  const barcode = req.params.barcode;
  try {
    // a) Produit depuis OFF (cache local pour ne pas re-fetcher)
    let product = db.products.get(barcode);
    if (!product) {
      product = await fetchOpenFoodFactsProduct(barcode);
      if (product) db.products.set(barcode, product);
    }
    if (!product) return res.status(404).json({ error: "product_not_found" });

    // b) Prix agrégés multi-sources
    const prices = aggregatePrices(barcode);

    res.json({ product, prices });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "prices_failed", message: e.message });
  }
});

function aggregatePrices(barcode) {
  // Récupère tous les prix de la DB pour ce code-barres,
  // les groupe par enseigne, garde le plus récent par enseigne,
  // trie par prix croissant.
  const allPrices = db.prices.get(barcode) || [];
  const byStore = new Map();
  for (const p of allPrices) {
    const existing = byStore.get(p.storeId);
    if (!existing || new Date(p.observedAt) > new Date(existing.observedAt)) {
      byStore.set(p.storeId, p);
    }
  }
  return [...byStore.values()].sort((a, b) => a.price - b.price);
}

// ------------------------------------------------------------------
// 3) Soumission d'un prix par un utilisateur (crowd-sourcing)
//    POST /api/prices
//    body: { barcode, storeId, price, isPromo?, source?, userToken? }
// ------------------------------------------------------------------
app.post("/api/prices", async (req, res) => {
  try {
    const { barcode, storeId, price, isPromo = false } = req.body;
    if (!barcode || !storeId || typeof price !== "number") {
      return res.status(400).json({ error: "invalid_payload" });
    }
    const entry = {
      barcode,
      storeId,
      storeName: STORE_NAMES[storeId] || storeId,
      price,
      isPromo,
      source: "user",
      observedAt: new Date().toISOString(),
    };
    addPrice(entry);

    // Optionnel : forwarde aussi vers Open Prices pour bénéficier à toute la communauté
    if (process.env.OPEN_PRICES_TOKEN) {
      submitPriceToOpenPrices(entry).catch((e) =>
        console.warn("Open Prices submit failed:", e.message)
      );
    }

    res.json({ ok: true, prices: aggregatePrices(barcode) });
  } catch (e) {
    res.status(500).json({ error: "submit_failed", message: e.message });
  }
});

// ------------------------------------------------------------------
// 4) Upload ticket de caisse → OCR → extraction prix
//    POST /api/receipts (multipart/form-data, champ "image")
// ------------------------------------------------------------------
app.post("/api/receipts", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no_image" });
    const result = await extractTicketWithOCR(req.file.buffer, req.body.storeHint);
    // result = { storeId, lines: [{ name, price, barcode? }] }
    let added = 0;
    for (const line of result.lines) {
      if (!line.barcode || !result.storeId) continue;
      addPrice({
        barcode: line.barcode,
        storeId: result.storeId,
        storeName: STORE_NAMES[result.storeId] || result.storeId,
        price: line.price,
        isPromo: false,
        source: "receipt",
        observedAt: new Date().toISOString(),
      });
      added++;
    }
    res.json({ ok: true, store: result.storeId, lines: result.lines, added });
  } catch (e) {
    res.status(500).json({ error: "ocr_failed", message: e.message });
  }
});

// ------------------------------------------------------------------
// 5) Déclenchement manuel du refresh quotidien
// ------------------------------------------------------------------
app.post("/api/refresh", async (_, res) => {
  runDailyRefresh()
    .then((stats) => res.json({ ok: true, stats }))
    .catch((e) => res.status(500).json({ error: e.message }));
});

// =================================================================
// ENDPOINT DRIVES — récupère les prix réels depuis les 4 drives
// GET /api/drives/:barcode?postcode=75001
// =================================================================
app.get("/api/drives/:barcode", async (req, res) => {
  const barcode = req.params.barcode.replace(/\D/g, "");
  if (!barcode || barcode.length < 8) {
    return res.status(400).json({ error: "invalid_barcode" });
  }
  try {
    const prices = await fetchAllDrivesPrices(barcode, {
      postcode: req.query.postcode || "75001",
    });
    res.json({ barcode, prices, count: prices.length, fetchedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: "drives_failed", message: e.message });
  }
});

app.get("/health", (_, res) =>
  res.json({
    ok: true,
    products: db.products.size,
    pricedProducts: db.prices.size,
    totalPriceObservations: [...db.prices.values()].reduce((s, a) => s + a.length, 0),
    lastRefresh: db.lastRefresh,
  })
);

// ==============================================================
// Helper : ajout d'un prix dans la DB (avec dedupe)
// ==============================================================
function addPrice(entry) {
  const list = db.prices.get(entry.barcode) || [];
  list.push(entry);
  db.prices.set(entry.barcode, list);
  // Trigger push notif si baisse significative
  maybeNotifyPriceDrop(db, entry.barcode, entry.price).catch(() => {});
}

const STORE_NAMES = {
  leclerc: "E.Leclerc",
  carrefour: "Carrefour",
  auchan: "Auchan",
  lidl: "Lidl",
  action: "Action",
  intermarche: "Intermarché",
  amazon: "Amazon",
  monoprix: "Monoprix",
  casino: "Casino",
};

// ==============================================================
// CRON QUOTIDIEN — 8h00 Europe/Paris
// Rafraîchit les prix pour les top 500 produits.
// ==============================================================
async function runDailyRefresh() {
  console.log(`[${new Date().toISOString()}] 🔄 Daily refresh START`);
  const stats = { openPrices: 0, bonial: 0, errors: 0 };

  // Liste des codes-barres à rafraîchir : top scannés + favoris users
  const barcodes = [...new Set([...db.popularBarcodes, ...db.products.keys()])].slice(0, 500);

  // Source 2 : Open Prices
  for (const barcode of barcodes) {
    try {
      const prices = await fetchOpenPrices(barcode);
      for (const p of prices) {
        addPrice({ ...p, source: "open_prices" });
        stats.openPrices++;
      }
    } catch (e) {
      stats.errors++;
    }
  }

  // Source 3 : Bonial — scrape les promotions actuelles
  try {
    const promos = await scrapeBonial(["leclerc", "carrefour", "auchan", "lidl", "action"]);
    for (const promo of promos) {
      addPrice({ ...promo, source: "bonial" });
      stats.bonial++;
    }
  } catch (e) {
    console.error("Bonial scrape failed:", e.message);
    stats.errors++;
  }

  db.lastRefresh = new Date().toISOString();
  console.log(`[${new Date().toISOString()}] ✅ Daily refresh DONE`, stats);
  return stats;
}

// Schedule : tous les jours à 8h00 (Paris)
cron.schedule("0 8 * * *", runDailyRefresh, { timezone: "Europe/Paris" });

// Refresh initial au démarrage (si DB vide)
setTimeout(() => {
  if (db.prices.size === 0) {
    console.log("DB vide, refresh initial...");
    runDailyRefresh().catch(console.error);
  }
}, 3000);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Voona backend démarré sur http://localhost:${PORT}`);
  console.log(`⏰ Cron quotidien programmé à 8h00 Europe/Paris`);
});
