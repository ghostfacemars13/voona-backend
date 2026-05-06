/**
 * Source 1 : Open Food Facts
 *   - Base produits gratuite, légale, ~3M références
 *   - https://world.openfoodfacts.org/api/v2
 *   - Pas de clé API requise, fair-use (max ~100 req/min)
 */

const BASE = "https://world.openfoodfacts.org";

export async function fetchOpenFoodFactsProduct(barcode) {
  const url = `${BASE}/api/v2/product/${barcode}.json?fields=product_name,product_name_fr,brands,image_front_url,image_url,quantity,categories_tags,nutriscore_grade`;
  const res = await fetch(url, { headers: { "User-Agent": "Voona/1.0" } });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 1) return null;
  const p = data.product;
  return {
    barcode,
    name: p.product_name_fr || p.product_name || "Produit inconnu",
    brand: p.brands || "",
    quantity: p.quantity || "",
    imageUrl: p.image_front_url || p.image_url || null,
    categories: p.categories_tags || [],
    nutriscore: p.nutriscore_grade || null,
  };
}

export async function searchOFF(query) {
  if (!query || query.length < 2) return [];
  const url = `${BASE}/cgi/search.pl?search_terms=${encodeURIComponent(
    query
  )}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,product_name_fr,brands,image_front_small_url,quantity,countries_tags`;
  const res = await fetch(url, { headers: { "User-Agent": "Voona/1.0" } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.products || [])
    .filter((p) => (p.countries_tags || []).some((c) => c.includes("france")))
    .map((p) => ({
      barcode: p.code,
      name: p.product_name_fr || p.product_name || "Sans nom",
      brand: p.brands || "",
      quantity: p.quantity || "",
      imageUrl: p.image_front_small_url || null,
    }))
    .slice(0, 15);
}
