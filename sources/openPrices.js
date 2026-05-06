/**
 * Source 2 : Open Prices (lancé par Open Food Facts en 2024)
 *   - Base de prix crowd-sourcés, libre, légale
 *   - https://prices.openfoodfacts.org/api/docs
 *   - GET /api/v1/prices?product_code=...&country_code=fr
 *   - POST /api/v1/prices (avec token utilisateur OAuth)
 *
 * C'est LA source moderne qui remplace le scraping. La communauté
 * (vous y compris) prend en photo les étiquettes en magasin et soumet
 * le prix. En retour, vous accédez à toute la base.
 */

const BASE = "https://prices.openfoodfacts.org/api/v1";

// Mapping enseigne → location_id Open Prices (à enrichir)
const LOCATION_MAP = {
  // Open Prices identifie les magasins par OSM ID. À termes,
  // on devrait plutôt grouper par enseigne via leur metadata.
  // Pour le prototype, on infère depuis le nom du magasin.
};

export async function fetchOpenPrices(barcode) {
  const url = `${BASE}/prices?product_code=${barcode}&order_by=-created`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Voona/1.0" } });
    if (!res.ok) return [];
    const data = await res.json();
    // Garde les 30 derniers prix max, normalise au format interne
    return (data.items || [])
      .slice(0, 30)
      .map((p) => {
        const storeId = inferStoreId(p.location?.osm_name || p.location_osm_name || "");
        if (!storeId) return null;
        return {
          barcode,
          storeId,
          storeName: capitalize(storeId),
          price: parseFloat(p.price),
          isPromo: !!p.price_is_discounted,
          observedAt: p.date || p.created,
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.warn(`Open Prices fetch failed for ${barcode}:`, e.message);
    return [];
  }
}

export async function submitPriceToOpenPrices({ barcode, storeId, price, isPromo }) {
  // Nécessite un token OAuth utilisateur — ici on log juste un stub.
  // Pour la prod : implémentez le flow OAuth d'Open Prices,
  // stockez le token utilisateur, et POST /api/v1/prices.
  if (!process.env.OPEN_PRICES_TOKEN) return false;
  // Implementation stub — voir https://prices.openfoodfacts.org/api/docs
  return true;
}

function inferStoreId(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes("leclerc")) return "leclerc";
  if (n.includes("carrefour")) return "carrefour";
  if (n.includes("auchan")) return "auchan";
  if (n.includes("lidl")) return "lidl";
  if (n.includes("action")) return "action";
  if (n.includes("intermarché") || n.includes("intermarche")) return "intermarche";
  if (n.includes("monoprix")) return "monoprix";
  if (n.includes("casino")) return "casino";
  return null;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
