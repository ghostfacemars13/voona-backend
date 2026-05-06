/**
 * DB ultra-simple en mémoire pour le prototype.
 *
 * En production, remplacez par PostgreSQL :
 *
 *   CREATE TABLE products (
 *     barcode TEXT PRIMARY KEY,
 *     name TEXT, brand TEXT, image_url TEXT,
 *     quantity TEXT, categories TEXT[],
 *     created_at TIMESTAMPTZ DEFAULT now()
 *   );
 *
 *   CREATE TABLE prices (
 *     id BIGSERIAL PRIMARY KEY,
 *     barcode TEXT REFERENCES products(barcode),
 *     store_id TEXT NOT NULL,
 *     price NUMERIC(10,2) NOT NULL,
 *     is_promo BOOLEAN DEFAULT FALSE,
 *     source TEXT NOT NULL,        -- open_prices | bonial | user | receipt
 *     observed_at TIMESTAMPTZ DEFAULT now(),
 *     user_id UUID  -- pour modération anti-abus
 *   );
 *   CREATE INDEX ON prices (barcode, observed_at DESC);
 *   CREATE INDEX ON prices (store_id);
 */

export const db = {
  products: new Map(),       // barcode → product
  prices: new Map(),         // barcode → [{ storeId, price, source, observedAt, ... }]
  popularBarcodes: new Set(),// codes-barres souvent scannés
  lastRefresh: null,
};

export function initDB() {
  // Précharge les top produits français pour amorcer la DB
  const seed = [
    "3017620422003", // Nutella 750g
    "3274080005003", // Évian 1.5L
    "3155250351086", // Coca-Cola 1.5L
    "3168930009993", // Président Camembert
    "3033710076383", // Lactel Lait 1L
    "3228857000852", // Harry's Pain de mie
    "3046920022606", // Lavazza Café 250g
    "3017800238615", // Kinder Bueno
    "3168930150107", // Président Beurre 250g
    "3175680011480", // Activia Yaourt 4x125g
    "8076809513753", // Barilla Spaghetti
    "3014260101213", // Heinz Ketchup
  ];
  seed.forEach((b) => db.popularBarcodes.add(b));
  console.log(`📦 DB initialisée — ${seed.length} produits seed`);
}
