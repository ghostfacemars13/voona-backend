/**
 * Source 3 : Bonial.fr — agrégateur officiel de catalogues promo
 *   - Bonial publie publiquement les prospectus des enseignes
 *   - C'est leur métier d'agréger, donc le scraping ciblé est tolérable
 *     (tant qu'on respecte robots.txt et qu'on rate-limite)
 *   - Plus pérenne : utiliser leur **flux RSS par enseigne** plutôt que HTML
 *
 * ⚠️ Avant la prod :
 *   1. Lisez https://www.bonial.fr/robots.txt
 *   2. Mettez un User-Agent identifiable + email contact
 *   3. Rate-limit 1 req/sec max
 *   4. Cachez agressivement (les prospectus changent rarement)
 *   5. Considérez leur API B2B partenaire (https://www.bonial.com/business)
 *      qui est l'option propre pour la prod
 */

import * as cheerio from "cheerio";

const BASE = "https://www.bonial.fr";
const STORE_SLUGS = {
  leclerc: "e-leclerc",
  carrefour: "carrefour",
  auchan: "auchan",
  lidl: "lidl",
  action: "action",
  intermarche: "intermarche",
};

export async function scrapeBonial(stores = []) {
  const results = [];
  for (const storeId of stores) {
    const slug = STORE_SLUGS[storeId];
    if (!slug) continue;
    try {
      const offers = await scrapeStoreOffers(storeId, slug);
      results.push(...offers);
      // Politesse : 1 seconde entre 2 enseignes
      await sleep(1000);
    } catch (e) {
      console.warn(`Bonial ${storeId} failed:`, e.message);
    }
  }
  return results;
}

async function scrapeStoreOffers(storeId, slug) {
  const url = `${BASE}/enseignes/${slug}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Voona/1.0 (+contact@voona.example)",
      Accept: "text/html",
    },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const $ = cheerio.load(html);

  // Bonial sert ses offres dans des cards de classe `.brochure-card` ou
  // dans un blob JSON `__NEXT_DATA__`. On essaie les deux.
  const offers = [];

  // Parcours JSON Next.js si dispo (plus stable que le HTML)
  const nextData = $("script#__NEXT_DATA__").html();
  if (nextData) {
    try {
      const data = JSON.parse(nextData);
      const items = findOffers(data);
      for (const item of items) {
        offers.push({
          barcode: item.gtin || null, // souvent absent — c'est la limite
          storeId,
          storeName: capitalize(storeId),
          price: item.price,
          isPromo: true,
          productName: item.title || item.name,
          observedAt: new Date().toISOString(),
        });
      }
    } catch {}
  }

  // Fallback HTML : .offer-card, .brochure-tile, etc. (à adapter au DOM réel)
  $(".offer-card, .product-tile, .promo-card").each((_, el) => {
    const title = $(el).find(".title, .product-name, h3").first().text().trim();
    const priceText = $(el).find(".price, .offer-price").first().text().trim();
    const price = parsePrice(priceText);
    if (title && price) {
      offers.push({
        barcode: null,
        storeId,
        storeName: capitalize(storeId),
        price,
        isPromo: true,
        productName: title,
        observedAt: new Date().toISOString(),
      });
    }
  });

  console.log(`  Bonial/${storeId}: ${offers.length} offres trouvées`);
  return offers.filter((o) => o.barcode); // ne garde que celles liables à un produit
}

// Walk récursif dans le JSON Next.js pour trouver les objets ressemblant à des offres
function findOffers(obj, results = []) {
  if (!obj || typeof obj !== "object") return results;
  if (obj.price && (obj.title || obj.name)) results.push(obj);
  if (Array.isArray(obj)) {
    obj.forEach((it) => findOffers(it, results));
  } else {
    Object.values(obj).forEach((v) => findOffers(v, results));
  }
  return results;
}

function parsePrice(text) {
  const m = text.match(/(\d+)[,.](\d{1,2})/);
  if (!m) return null;
  return parseFloat(`${m[1]}.${m[2]}`);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
