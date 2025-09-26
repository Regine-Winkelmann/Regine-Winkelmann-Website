/* ===========================
   shop.js – zentrale Shop-Logik (ohne Build)
   =========================== */

/* ---------- 1) Produktkonfiguration ---------- */
const SHOP_CONFIG = {
  TestMode: true,                 // im Test-Setup auf true setzen
  Currency: "EUR",
  Products: [
    {
      key: "book_dachs",
      title: "Der Dachs und die Welt",
      product_live: "prod_T6iEYdlAANick0",
      product_test: "prod_T73XBAfBZE4zVb",
      // Optional: netto in Cents (empfohlen). Falls weggelassen, wird price_label geparst.
      // price_net_cents: 2700,
      price_label: "25,23 €",     // nur fürs UI / Fallback-Parsing
      thumb: "products/BookSmall.webp",
      vat_percent: 7              // MwSt-Satz in Prozent
    },
    // weitere Produkte hier ...
  ]
};

/* ---------- 2) Persistenz (localStorage) ---------- */
const CART_KEY = "rw.cart.v1";
const clampQty = n => Math.max(1, Math.min(100, parseInt(n,10) || 1));
const load = () => { try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; } };
const save = (items) => localStorage.setItem(CART_KEY, JSON.stringify(items));

/* ---------- 3) Hilfen auf Produktsicht ---------- */
function isTestMode() { return !!SHOP_CONFIG.TestMode; }
function activeStripeId(prod) { return isTestMode() ? prod.product_test : prod.product_live; }
function findByKey(key) { return SHOP_CONFIG.Products.find(p => p.key === key); }
function findByStripeId(stripeId) {
  return SHOP_CONFIG.Products.find(p => p.product_live === stripeId || p.product_test === stripeId);
}
function displayName(stripeId) {
  const p = findByStripeId(stripeId);
  return p ? p.title : stripeId;
}
function displayThumb(stripeId) {
  const p = findByStripeId(stripeId);
  return p ? p.thumb : "";
}
// mappt eine beliebige (live/test) ID auf die zum aktuellen Modus passende ID
function mapToActiveStripeId(stripeId) {
  const prod = findByStripeId(stripeId);
  return prod ? activeStripeId(prod) : stripeId;
}

/* ---------- 4) Preis-Helpers (netto + brutto) ---------- */
// "27,00 €" -> 2700 (robustes DE-Parsing)
function parsePriceLabelToCents(label) {
  if (!label) return 0;
  const clean = String(label).replace(/[^\d,\.]/g, '').trim(); // nur Ziffern , .
  if (!clean) return 0;
  const norm = clean.replace(/\./g, '').replace(',', '.');     // Tausenderpunkt weg, Komma -> Punkt
  const val = Math.round((parseFloat(norm) || 0) * 100);
  return val;
}
function unitNetCentsForStripeId(stripeId) {
  const p = findByStripeId(stripeId);
  if (!p) return 0;
  if (Number.isFinite(p.price_net_cents)) return p.price_net_cents|0;
  if (p.price_label) return parsePriceLabelToCents(p.price_label);
  return 0;
}
// MwSt-Satz für ein Produkt ermitteln (in Prozent, z.B. 7 oder 19)
function getVatPercentForStripeId(stripeId) {
  const p = findByStripeId(stripeId);
  return p && Number.isFinite(p.vat_percent) ? p.vat_percent : 7; // Default 7%
}
// Netto -> Brutto umrechnen
function unitGrossCentsForStripeId(stripeId) {
  const netCents = unitNetCentsForStripeId(stripeId);
  const vatPercent = getVatPercentForStripeId(stripeId);
  return Math.round(netCents * (1 + vatPercent / 100));
}
function formatCents(cents, currency = SHOP_CONFIG.Currency || 'EUR') {
  return (cents / 100).toLocaleString('de-DE', { style: 'currency', currency });
}

/* ---------- 5) Cart-API ---------- */
function cartBroadcast() {
  const count = cartCount();
  window.dispatchEvent(new CustomEvent("shop:cart-changed", { detail: { count } }));
  // Optional: Badge autoupdate (alle Elemente mit [data-cart-badge])
  document.querySelectorAll("[data-cart-badge]").forEach(el => el.textContent = String(count));
}

function getCart() { return load(); }

function getCartDetailed() {
  return getCart().map(it => {
    const unitNet = unitNetCentsForStripeId(it.product);
    const unitGross = unitGrossCentsForStripeId(it.product);
    const vatPercent = getVatPercentForStripeId(it.product);
    const qty = clampQty(it.quantity);
    return {
      ...it,
      quantity: qty,
      title: displayName(it.product),
      thumb: displayThumb(it.product),
      unit_net_cents: unitNet,
      unit_gross_cents: unitGross,
      line_net_cents: unitNet * qty,
      line_gross_cents: unitGross * qty,
      vat_percent: vatPercent
    };
  });
}

function clearCart() { save([]); cartBroadcast(); }

function addByKey(key, qty=1) {
  const prod = findByKey(key);
  if (!prod) return;
  return addByStripeId(activeStripeId(prod), qty);
}

function addByStripeId(stripeId, qty=1) {
  qty = clampQty(qty);
  // Eingehende IDs (egal ob live/test) auf aktuellen Modus mappen
  const activeId = mapToActiveStripeId(stripeId);

  const items = load();
  const i = items.findIndex(x => x.product === activeId);
  if (i >= 0) items[i].quantity = clampQty(items[i].quantity + qty);
  else items.push({ product: activeId, quantity: qty });
  save(items); cartBroadcast();
}

function setQtyByStripeId(stripeId, qty) {
  qty = clampQty(qty);
  const activeId = mapToActiveStripeId(stripeId);
  const items = load();
  const i = items.findIndex(x => x.product === activeId);
  if (i >= 0) { items[i].quantity = qty; save(items); cartBroadcast(); }
}

function removeByStripeId(stripeId) {
  const activeId = mapToActiveStripeId(stripeId);
  save(load().filter(x => x.product !== activeId)); cartBroadcast();
}

function cartCount() { return load().reduce((s,x)=>s + clampQty(x.quantity), 0); }

// Für Worker/Checkout: items -> [{ product, quantity }]
function toCheckoutItems() {
  return load().map(it => ({
    product: mapToActiveStripeId(it.product), // immer aktive ID senden
    quantity: clampQty(it.quantity)
  }));
}

/* ---------- 6) Mode-Handling ---------- */
function normalizeCartForCurrentMode() {
  const items = load().map(it => ({
    product: mapToActiveStripeId(it.product),
    quantity: clampQty(it.quantity)
  }));
  save(items); cartBroadcast();
}
function setTestMode(flag) {
  SHOP_CONFIG.TestMode = !!flag;
  normalizeCartForCurrentMode();
}

/* ---------- 7) Globales API-Objekt ---------- */
window.Shop = {
  config: SHOP_CONFIG,
  // Produkte
  products() { return SHOP_CONFIG.Products.slice(); },
  findByKey, findByStripeId, activeStripeId,
  // Cart
  getCart, getCartDetailed, clearCart,
  addByKey, addByStripeId, setQtyByStripeId, removeByStripeId,
  cartCount, toCheckoutItems,
  // Preise/Format
  formatCents,
  unitNetCentsForStripeId, unitGrossCentsForStripeId, getVatPercentForStripeId,
  // Mode
  isTestMode, setTestMode,
  // Events
  onCartChange(handler) { window.addEventListener("shop:cart-changed", e => handler(e.detail)); }
};

/* ---------- 8) Init ---------- */
cartBroadcast();
