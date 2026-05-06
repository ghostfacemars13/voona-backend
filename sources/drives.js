/**
 * VOONA — Sources Drives en ligne
 * ==============================================================
 *
 * Récupère les prix réels des drives en ligne (catalogues publics).
 *
 * Couverts : Carrefour Drive, Auchan Drive, Intermarché Drive,
 *            Leclerc Drive, Casino Drive (selon disponibilité).
 *
 * Pourquoi c'est défendable légalement :
 *   - Les drives publient leurs prix PUBLIQUEMENT sur leur site web
 *     (nécessaire pour vendre en ligne)
 *   - Ces prix sont destinés aux consommateurs
 *   - La comparaison de prix entre commerçants est une pratique
 *     légale reconnue en droit français (art. L121-9 Code de la conso)
 *
 * Précautions à respecter (cf. CCPA/RGPD/CGU) :
 *   - User-Agent identifiable + email contact
 *   - Rate-limit : 1 req/sec max par drive
 *   - Cache agressif côté serveur (au moins 4h par produit)
 *   - Respecter robots.txt
 *   - Si un drive nous bloque ou demande l'arrêt : on stoppe
 *
 * ⚠️ IMPORTANT : ces APIs sont des **endpoints internes** des sites
 * (utilisés par leur propre frontend). Ils peuvent changer sans préavis.
 * Le code ci-dessous reflète la structure observée à la date d'écriture.
 * En cas de panne, ouvrez les DevTools du site cible (onglet Network)
 * pour repérer la nouvelle structure d'API.
 */

import * as cheerio from "cheerio";

const UA = "VoonaPriceComparator/1.0 (+contact@voona.fr)";
const REQUEST_TIMEOUT = 8000;

// Cache en mémoire (à remplacer par Redis en prod)
const cache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 heures

function getCached(key) {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expires) return null;
  return entry.data;
}
function setCached(key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    return await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/html",
        "Accept-Language": "fr-FR,fr;q=0.9",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

// =================================================================
// CARREFOUR DRIVE
// =================================================================
// Endpoint observé : https://www.carrefour.fr/search?q=<barcode>
// Retourne du HTML avec un blob JSON __NEXT_DATA__ ou des données dans une API REST.
// Plus stable : leur API search-api (utilisée en interne).
// =================================================================
export async function fetchCarrefourPrice(barcode) {
  const cacheKey = `carrefour:${barcode}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  try {
    // Tentative 1 : API publique de recherche (souvent accessible)
    const apiUrl = `https://www.carrefour.fr/api/v3/search?q=${barcode}&displayedAttributes=ean,name,price,packaging,offers`;
    const r = await fetchWithTimeout(apiUrl);
    if (r.ok) {
      const data = await r.json();
      const product = (data?.results?.products || [])[0];
      if (product?.offers?.[0]?.price) {
        const result = {
          storeId: "carrefour",
          storeName: "Carrefour Drive",
          price: parseFloat(product.offers[0].price),
          ean: product.ean || barcode,
          productName: product.name,
          available: true,
          fetchedAt: new Date().toISOString(),
        };
        setCached(cacheKey, result);
        return result;
      }
    }

    // Tentative 2 : fallback HTML scraping (extraction du blob __NEXT_DATA__)
    const htmlUrl = `https://www.carrefour.fr/s?q=${barcode}`;
    const html = await fetchWithTimeout(htmlUrl).then((r) => (r.ok ? r.text() : ""));
    const $ = cheerio.load(html);
    const nextData = $("script#__NEXT_DATA__").html();
    if (nextData) {
      const data = JSON.parse(nextData);
      const found = findProductInJSON(data, barcode);
      if (found) {
        const result = {
          storeId: "carrefour",
          storeName: "Carrefour Drive",
          price: found.price,
          productName: found.name,
          available: true,
          fetchedAt: new Date().toISOString(),
        };
        setCached(cacheKey, result);
        return result;
      }
    }

    setCached(cacheKey, null);
    return null;
  } catch (e) {
    console.warn("Carrefour fetch failed:", e.message);
    return null;
  }
}

// =================================================================
// AUCHAN DRIVE
// =================================================================
// Endpoint API observé (utilisé par leur frontend) :
// https://www.auchan.fr/api/v0/search/<barcode>
// =================================================================
export async function fetchAuchanPrice(barcode) {
  const cacheKey = `auchan:${barcode}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  try {
    const apiUrl = `https://www.auchan.fr/api/v0/search/${barcode}?searchType=ean`;
    const r = await fetchWithTimeout(apiUrl);
    if (r.ok) {
      const data = await r.json();
      const product = data?.products?.[0] || data?.results?.[0];
      if (product?.price) {
        const price = parseFloat(product.price?.value || product.price);
        if (!isNaN(price)) {
          const result = {
            storeId: "auchan",
            storeName: "Auchan Drive",
            price,
            productName: product.name || product.title,
            available: true,
            fetchedAt: new Date().toISOString(),
          };
          setCached(cacheKey, result);
          return result;
        }
      }
    }

    // Fallback : page produit publique
    const url = `https://www.auchan.fr/recherche?text=${barcode}`;
    const html = await fetchWithTimeout(url).then((r) => (r.ok ? r.text() : ""));
    const priceMatch = html.match(/"price":\s*\{?\s*"?value"?:\s*"?(\d+[.,]\d{1,2})/);
    if (priceMatch) {
      const result = {
        storeId: "auchan",
        storeName: "Auchan Drive",
        price: parseFloat(priceMatch[1].replace(",", ".")),
        productName: null,
        available: true,
        fetchedAt: new Date().toISOString(),
      };
      setCached(cacheKey, result);
      return result;
    }

    setCached(cacheKey, null);
    return null;
  } catch (e) {
    console.warn("Auchan fetch failed:", e.message);
    return null;
  }
}

// =================================================================
// INTERMARCHÉ DRIVE
// =================================================================
// API : https://www.intermarche.com/api/products/...
// Nécessite souvent un store_id (code postal de l'utilisateur).
// On utilise un store par défaut pour le prototype.
// =================================================================
export async function fetchIntermarchePrice(barcode, storeId = "default") {
  const cacheKey = `intermarche:${barcode}:${storeId}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  try {
    const apiUrl = `https://www.intermarche.com/api/products/${barcode}?store=${storeId}`;
    const r = await fetchWithTimeout(apiUrl);
    if (r.ok) {
      const data = await r.json();
      if (data?.price?.value) {
        const result = {
          storeId: "intermarche",
          storeName: "Intermarché Drive",
          price: parseFloat(data.price.value),
          productName: data.name,
          available: data.availability !== "OUT_OF_STOCK",
          fetchedAt: new Date().toISOString(),
        };
        setCached(cacheKey, result);
        return result;
      }
    }
    setCached(cacheKey, null);
    return null;
  } catch (e) {
    console.warn("Intermarché fetch failed:", e.message);
    return null;
  }
}

// =================================================================
// LECLERC DRIVE
// =================================================================
// Le plus complexe : chaque magasin a son propre subdomain.
// Format : https://leclercdrive.fr/{ville-code}/produits/<id>
// Plus simple : utiliser le moteur central qui demande un code postal.
// =================================================================
export async function fetchLeclercPrice(barcode, postcode = "75001") {
  const cacheKey = `leclerc:${barcode}:${postcode}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  try {
    const url = `https://www.e.leclerc/api/produit/${barcode}?codePostal=${postcode}`;
    const r = await fetchWithTimeout(url);
    if (r.ok) {
      const data = await r.json();
      if (data?.prix?.valeur) {
        const result = {
          storeId: "leclerc",
          storeName: "E.Leclerc Drive",
          price: parseFloat(data.prix.valeur),
          productName: data.libelle,
          available: data.disponible !== false,
          fetchedAt: new Date().toISOString(),
        };
        setCached(cacheKey, result);
        return result;
      }
    }
    setCached(cacheKey, null);
    return null;
  } catch (e) {
    console.warn("Leclerc fetch failed:", e.message);
    return null;
  }
}

// =================================================================
// FONCTION D'AGRÉGATION
// Lance les 4 drives en parallèle, retourne tous les prix trouvés.
// =================================================================
export async function fetchAllDrivesPrices(barcode, opts = {}) {
  const postcode = opts.postcode || "75001";
  const promises = [
    fetchCarrefourPrice(barcode),
    fetchAuchanPrice(barcode),
    fetchIntermarchePrice(barcode),
    fetchLeclercPrice(barcode, postcode),
  ];
  const results = await Promise.allSettled(promises);
  return results
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((r) => r && r.price > 0)
    .sort((a, b) => a.price - b.price);
}

// =================================================================
// HELPER : Recherche récursive d'un produit dans un JSON
// =================================================================
function findProductInJSON(obj, barcode, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;
  if (obj.ean === barcode || obj.code === barcode || obj.gtin === barcode) {
    if (obj.price || obj.prix) {
      return {
        name: obj.name || obj.title || obj.libelle,
        price: parseFloat(obj.price?.value || obj.price || obj.prix?.value || obj.prix),
      };
    }
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findProductInJSON(item, barcode, depth + 1);
      if (found) return found;
    }
  } else {
    for (const val of Object.values(obj)) {
      const found = findProductInJSON(val, barcode, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
