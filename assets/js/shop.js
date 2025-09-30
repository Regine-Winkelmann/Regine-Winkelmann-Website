/* ===========================
   shop.js – zentrale Shop-Logik (ohne Build)
   =========================== */

/* ---------- 1) Produktkonfiguration ---------- */

// Automatische Test-/Live-Modus Erkennung basierend auf URL
function detectTestMode() {
  const hostname = window.location.hostname;
  
  // Live-Modus nur für echte Production-Domain
  const isProductionDomain = hostname === 'reginewinkelmann.de' || hostname === 'www.reginewinkelmann.de';
  
  // Test-Modus: Alles außer Production-Domain
  return !isProductionDomain;
}

const SHOP_CONFIG = {
  TestMode: detectTestMode(),      // automatische Erkennung basierend auf URL
  Currency: "EUR",
  
  // Worker-Endpoints für lokale Entwicklung vs. Production
  WorkerEndpoints: {
    development: "http://localhost:8787",     // npm run dev Default-Port
    production: "https://reginewinkelmannstripe.vaax.workers.dev"
  },
  
  Products: [
    {
      key: "book_dachs",
      title: "Der Dachs und die Welt",
      product_live: "prod_T6iEYdlAANick0",
      product_test: "prod_T73XBAfBZE4zVb",
      // Optional: netto in Cents (empfohlen). Falls weggelassen, wird price_label geparst.
      // price_net_cents: 2700,
      price_label: "25,23 €",     // nur fürs UI / Fallback-Parsing
      thumb: "/assets/img/products/BookSmall.webp",
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
function isDevelopment() {
  const hostname = window.location.hostname;
  const protocol = window.location.protocol;
  
  return (
    hostname === 'localhost' || 
    hostname === '127.0.0.1' ||
    /^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) || // Private IP ranges
    hostname.endsWith('.local') || 
    hostname.endsWith('.test') || 
    hostname.endsWith('.dev') ||
    (protocol === 'http:' && /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) // Any IP with http
  );
}
function getWorkerEndpoint() {
  return isDevelopment() ? SHOP_CONFIG.WorkerEndpoints.development : SHOP_CONFIG.WorkerEndpoints.production;
}
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
  console.log(`Shop-Modus geändert zu: ${flag ? 'TEST' : 'LIVE'} (manuell überschrieben)`);
}

// Debug-Informationen für Entwickler
function getEnvironmentInfo() {
  return {
    hostname: window.location.hostname,
    protocol: window.location.protocol,
    testMode: isTestMode(),
    development: isDevelopment(),
    workerEndpoint: getWorkerEndpoint()
  };
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
  // Mode & Environment
  isTestMode, setTestMode, isDevelopment, getWorkerEndpoint, getEnvironmentInfo,
  // API URLs
  getApiUrl(endpoint) {
    const baseUrl = getWorkerEndpoint();
    switch (endpoint) {
      case 'checkout': return `${baseUrl}/create-checkout-session`;
      case 'invoice': return `${baseUrl}/get-invoice-url`;
      case 'webhook': return `${baseUrl}/webhook`;
      default: return `${baseUrl}/${endpoint}`;
    }
  },
  // Events
  onCartChange(handler) { window.addEventListener("shop:cart-changed", e => handler(e.detail)); }
};

/* ---------- 8) Init ---------- */
// Environment-Info beim Laden ausgeben
console.log('🛍️ Shop initialisiert:', getEnvironmentInfo());

// Warnung bei lokaler Entwicklung
if (isDevelopment()) {
  console.log('🔧 Entwicklungsmodus erkannt!');
  console.log('💡 Worker-Endpoint:', getWorkerEndpoint());
  console.log('⚠️ Stelle sicher, dass der Worker läuft: npm run dev');
}

cartBroadcast();
