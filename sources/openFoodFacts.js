const BASE = "https://world.openfoodfacts.org";
const SEARCH_BASE = "https://search.openfoodfacts.org";

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
  const url = `${SEARCH_BASE}/search?q=${encodeURIComponent(query)}&page_size=20`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Voona/1.0" } });
    if (!res.ok) return [];
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); }
    catch (e) { data = JSON.parse(txt.replace(/(?<!\\)""+/g, '"')); }
    return (data.hits || [])
      .map(p => {
        let name = "";
        if (typeof p.product_name === "string") name = p.product_name;
        else if (p.product_name?.fr) name = p.product_name.fr;
        else if (p.product_name?.en) name = p.product_name.en;
        else if (p.product_name?.main) name = p.product_name.main;
        const brand = Array.isArray(p.brands) ? p.brands.join(", ") : (p.brands || "");
        const code = p.code;
        const imageUrl = code && code.length >= 10
          ? `https://images.openfoodfacts.org/images/products/${code.replace(/(.{3})(.{3})(.{3})(.+)/, "$1/$2/$3/$4")}/front_fr.200.jpg`
          : null;
        return { barcode: code, name: name || "Sans nom", brand, quantity: p.quantity || "", imageUrl };
      })
      .filter(p => p.barcode && p.name && p.name !== "Sans nom")
      .slice(0, 15);
  } catch (e) {
    console.warn("searchOFF failed:", e.message);
    return [];
  }
}

