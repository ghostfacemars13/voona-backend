/**
 * Source 5 : OCR de tickets de caisse
 *
 * Stratégie en 2 étapes :
 *   1. Extraction du texte avec Tesseract.js (gratuit, local)
 *      OU avec une API cloud type Mindee/Veryfi (plus précis, payant)
 *   2. Parsing : détection de l'enseigne (logo en haut), puis pour
 *      chaque ligne, extraction (nom_produit, prix). Quand un
 *      EAN est imprimé, on le récupère.
 *
 * Pour le prototype, on utilise Tesseract.js. En prod, basculez vers
 * Mindee Receipt API (~0,01€/ticket, taux de réussite >95%).
 */

import { createWorker } from "tesseract.js";

// Patterns enseignes connues (logos / mentions textuelles)
const STORE_PATTERNS = [
  { id: "leclerc", regex: /e\.?\s*leclerc|scapnor|scaouest/i },
  { id: "carrefour", regex: /carrefour/i },
  { id: "auchan", regex: /auchan/i },
  { id: "lidl", regex: /lidl/i },
  { id: "action", regex: /action\s*france/i },
  { id: "intermarche", regex: /intermarch[ée]|itm/i },
  { id: "monoprix", regex: /monoprix/i },
  { id: "casino", regex: /\bcasino\b/i },
];

// Pattern ligne ticket :  "PRODUIT XYZ            3,49 €"
const LINE_PATTERN = /^(.+?)\s+(\d+[,.]\d{2})\s*[€E]?\s*$/;

export async function extractTicketWithOCR(imageBuffer, storeHint) {
  const worker = await createWorker("fra");
  let storeId = null;
  const lines = [];
  try {
    const { data } = await worker.recognize(imageBuffer);
    const text = data.text;

    // Détecte l'enseigne
    if (storeHint) {
      storeId = storeHint;
    } else {
      for (const { id, regex } of STORE_PATTERNS) {
        if (regex.test(text)) {
          storeId = id;
          break;
        }
      }
    }

    // Parse les lignes
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      const m = line.match(LINE_PATTERN);
      if (m) {
        const name = m[1].trim();
        const price = parseFloat(m[2].replace(",", "."));
        // Filtres : ignore TOTAL, TVA, RENDU, etc.
        if (
          name.length > 2 &&
          !/total|sous.total|tva|rendu|esp[èe]ces?|carte|cb/i.test(name) &&
          price > 0 &&
          price < 500
        ) {
          lines.push({ name, price, barcode: null });
        }
      }
    }

    return { storeId, lines, rawText: text };
  } finally {
    await worker.terminate();
  }
}

/**
 * Pour la prod, remplacez par Mindee :
 *
 * import { Client, product } from "mindee";
 * const mindeeClient = new Client({ apiKey: process.env.MINDEE_KEY });
 * const inputSource = mindeeClient.docFromBuffer(imageBuffer, "receipt.jpg");
 * const result = await mindeeClient.parse(product.ReceiptV5, inputSource);
 * → result.document.inference.prediction.lineItems = [{ description, totalAmount }]
 *
 * Mindee gère :
 *   - Rotation/redressement
 *   - Multi-langues
 *   - Extraction structurée (TVA, total, lignes, code EAN si imprimé)
 *   - Coût ~0,01€/page, 250 pages gratuites/mois
 */
