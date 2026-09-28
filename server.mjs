import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const MCP_URL = "https://mcp.swiggy.com/food";
const MCP_AUTHORIZATION = process.env.SWIGGY_MCP_AUTHORIZATION || (process.env.SWIGGY_MCP_BEARER_TOKEN ? `Bearer ${process.env.SWIGGY_MCP_BEARER_TOKEN}` : "");
let oauthAccessToken = "";
const oauthRequests = new Map();
const orderSessions = new Map();
const MIME_TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };
const getAuthorization = () => oauthAccessToken ? `Bearer ${oauthAccessToken}` : MCP_AUTHORIZATION;

class McpHttpClient {
  constructor(url) { this.url = url; this.sessionId = null; this.nextId = 1; }
  async request(method, params = {}) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(getAuthorization() ? { authorization: getAuthorization() } : {}), ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params })
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) { const error = new Error("Swiggy Food MCP requires authentication."); error.code = "AUTH_REQUIRED"; throw error; }
      throw new Error(`MCP HTTP ${response.status}`);
    }
    if (response.headers.get("mcp-session-id")) this.sessionId = response.headers.get("mcp-session-id");
    const payload = await parseMcpBody(await response.text(), response.headers.get("content-type"));
    if (payload?.error) throw new Error(payload.error.message || "MCP request failed");
    return payload?.result ?? payload;
  }
  async callTool(name, args) { return this.request("tools/call", { name, arguments: args }); }
  async initialize() {
    await this.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "BiteWise", version: "1.0.0" } });
    await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", ...(getAuthorization() ? { authorization: getAuthorization() } : {}), ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) });
  }
}

async function parseMcpBody(body, contentType = "") {
  if (!body) return {};
  if (contentType.includes("text/event-stream")) {
    const data = body.split(/\n\n/).map(block => block.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim()).filter(Boolean).pop();
    return data ? JSON.parse(data) : {};
  }
  return JSON.parse(body);
}

function tryJson(value) { try { return JSON.parse(value); } catch { return null; } }
function toolData(result) {
  const structured = result?.structuredContent;
  const text = (result?.content || []).find(block => block.type === "text")?.text;
  const parsed = structured || tryJson(text) || {};
  if (parsed.success === false) throw new Error(parsed.error?.message || "Swiggy Food MCP returned an error.");
  return parsed.data || parsed;
}

function objectValue(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function firstValue(...values) { return values.find(value => value !== undefined && value !== null && value !== ""); }
function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function cartPayload(value) {
  const root = objectValue(value) || {};
  const data = objectValue(root.data) || root;
  const nested = objectValue(data.data) || data;
  return { root, data, cart: nested };
}

function objectNodes(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return [];
  seen.add(value);
  const nodes = [value];
  for (const child of Object.values(value)) if (child && typeof child === "object") nodes.push(...objectNodes(child, depth + 1, seen));
  return nodes;
}

function safeMcpDiagnostics(label, raw) {
  const { root, data, cart } = cartPayload(raw);
  const pricing = objectValue(cart.pricing) || objectValue(data.pricing) || objectValue(root.pricing);
  const payment = objectValue(data.paymentOptions) || objectValue(root.paymentOptions);
  console.info(`[MCP diagnostics] ${label}`, JSON.stringify({
    rootKeys: Object.keys(root),
    dataKeys: Object.keys(data),
    cartKeys: Object.keys(cart),
    itemKeys: Array.isArray(cart.items) && cart.items[0] ? Object.keys(cart.items[0]) : [],
    pricingKeys: pricing ? Object.keys(pricing) : [],
    paymentKeys: payment ? Object.keys(payment) : [],
    prices: pricing ? Object.fromEntries(["item_total", "delivery_charge", "taxes_and_charges", "to_pay", "subtotal", "final_price"].filter(key => pricing[key] !== undefined).map(key => [key, numberValue(pricing[key]) ?? "non-numeric"])) : {}
  }));
}

function normalizePaymentOptions(value) {
  const root = objectValue(value) || {};
  const candidates = objectNodes(root).filter(objectValue);
  const methods = [];
  for (const candidate of candidates) {
    for (const method of Array.isArray(candidate.allMethods) ? candidate.allMethods : []) methods.push(method);
    for (const platform of [candidate.platforms?.mobile, candidate.platforms?.desktop]) {
      for (const method of Array.isArray(platform?.methods) ? platform.methods : []) methods.push(method);
    }
    for (const key of ["cod", "swiggyMoney"]) if (candidate[key]?.available) methods.push(candidate[key]);
  }
  const allMethods = [...new Map(methods.filter(method => method?.id).map(method => [method.id, {
    id: method.id,
    displayName: method.displayName || method.id,
    kind: method.kind,
    enabled: method.enabled !== false,
    groupName: method.groupName
  }])).values()];
  const source = candidates.find(candidate => candidate.allMethods || candidate.platforms || candidate.cod || candidate.swiggyMoney) || root;
  const reasonSource = candidates.find(candidate => candidate.gpoError || candidate.error?.message || candidate.message) || root;
  return { allMethods, platforms: source.platforms, cod: source.cod, swiggyMoney: source.swiggyMoney, paymentAmount: source.paymentAmount, addressId: source.addressId, reason: firstValue(reasonSource.gpoError, reasonSource.error?.message, reasonSource.message) };
}

async function createFoodClient() {
  const client = new McpHttpClient(MCP_URL);
  await client.initialize();
  return client;
}

async function getAddresses() {
  const client = await createFoodClient();
  const result = toolData(await client.callTool("get_addresses", { page: 1, pageSize: 10 }));
  return (result.addresses || []).map(address => ({ id: address.id, addressLine: address.addressLine, addressTag: address.addressTag || address.addressCategory }));
}

function queryFor(preferences) {
  return [preferences.craving, preferences.meal, ...(preferences.dietary || []).filter(value => !["jain", "vegan", "high-protein"].includes(value))].join(" ");
}

function collectionFor(preferences) {
  if (preferences.craving === "healthy" || (preferences.dietary || []).includes("high-protein")) return "EATRIGHT";
  if (preferences.craving === "quick") return "BOLT";
  if (preferences.budget <= 99) return "STORE_99";
  return undefined;
}

function menuQueryFor(preferences) {
  if (preferences.craving === "sweet") return "dessert";
  if (preferences.craving === "spicy") return "spicy food";
  if (preferences.craving === "healthy" || (preferences.dietary || []).includes("high-protein")) return "healthy food";
  if (preferences.craving === "quick") return "rolls";
  if (preferences.meal === "breakfast") return "breakfast";
  if (preferences.meal === "snacks") return "snacks";
  return "biryani";
}

function normalizeDish(dish) {
  const price = Number(dish.price);
  return {
    name: dish.name,
    restaurant: dish.restaurantName || dish.restaurant_name,
    menuItemId: dish.id || dish.menu_item_id,
    restaurantId: dish.restaurantId || dish.restaurant_id,
    variations: dish.variations,
    variantsV2: dish.variantsV2,
    addons: dish.addons,
    hasVariants: dish.hasVariants,
    hasAddons: dish.hasAddons,
    price: Number.isFinite(price) ? price : undefined,
    dietary: dish.isVeg === true ? ["vegetarian"] : dish.isVeg === false ? ["non-vegetarian"] : [],
    description: dish.description,
    image: dish.imageUrl
  };
}

function orderableItem(item) {
  return item && item.menuItemId && item.restaurantId && item.name;
}

function customizationSchema(item) {
  const variationMode = item.variantsV2 ? "variantsV2" : item.variations?.length ? "variations" : null;
  const variationGroups = item.variantsV2 || (item.variations?.length ? [{ groupId: "default", name: "Choose an option", variations: item.variations }] : []);
  const addonGroups = item.addons || [];
  return { variationMode, variationGroups, addonGroups, requiresCustomization: variationGroups.length > 0 || addonGroups.some(group => Number(group.minAddons || 0) > 0) };
}

function chooseCustomizations(item, selections = {}) {
  const schema = customizationSchema(item);
  const variants = schema.variationGroups.map(group => {
    const selectedId = selections.variants?.[group.groupId];
    const variation = (group.variations || []).find(choice => choice.id === selectedId);
    if (!variation) throw new Error(`Choose an option for ${group.name || "this item"}.`);
    return { ...group, variations: [variation] };
  });
  const addons = schema.addonGroups.map(group => {
    const selectedIds = selections.addons?.[group.groupId] || [];
    if (selectedIds.length < Number(group.minAddons || 0)) throw new Error(`Choose at least ${group.minAddons} add-on(s) for ${group.groupName || group.name || "this item"}.`);
    if (group.maxAddons && selectedIds.length > Number(group.maxAddons)) throw new Error(`Choose no more than ${group.maxAddons} add-on(s) for ${group.groupName || group.name || "this item"}.`);
    const choices = (group.choices || []).filter(choice => selectedIds.includes(choice.id));
    if (choices.length !== selectedIds.length) throw new Error("One or more selected add-ons are no longer available.");
    return { ...group, choices };
  });
  return { variationMode: schema.variationMode, variants, addons: addons.filter(group => group.choices.length > 0) };
}

async function resolveOrderItem(client, addressId, requested) {
  if (!orderableItem(requested)) throw new Error("This recommendation is missing Swiggy item identifiers and cannot be ordered safely.");
  const result = toolData(await client.callTool("search_menu", { addressId, query: requested.name, restaurantIdOfAddedItem: requested.restaurantId, offset: 0 }));
  const item = (result.items || []).find(candidate => (candidate.menu_item_id || candidate.id) === requested.menuItemId);
  if (!item) throw new Error("Swiggy could not re-resolve this menu item. Refresh recommendations before ordering.");
  return { ...item, menu_item_id: item.menu_item_id || item.id, restaurant_id: item.restaurant_id || requested.restaurantId, restaurant_name: item.restaurant_name || requested.restaurant };
}

function cartView(cartResult) {
  safeMcpDiagnostics("get_food_cart", cartResult);
  const { root, data, cart } = cartPayload(cartResult);
  const nodes = objectNodes(root);
  const pricingContainer = nodes.find(node => objectValue(node.pricing));
  const sourcePricing = pricingContainer?.pricing || nodes.find(node => ["item_total", "delivery_charge", "taxes_and_charges", "to_pay"].some(key => node[key] !== undefined)) || {};
  const sourceOffers = nodes.find(node => node.coupon_discount !== undefined || node.coupon_applied !== undefined) || objectValue(cart.offers) || objectValue(data.offers) || objectValue(root.offers) || {};
  const itemsSource = nodes.find(node => Array.isArray(node.items)) || {};
  const pricing = {
    item_total: numberValue(firstValue(sourcePricing.item_total, sourcePricing.subtotal, sourcePricing.items_total)),
    delivery_charge: numberValue(firstValue(sourcePricing.delivery_charge, sourcePricing.delivery_fee, sourcePricing.deliveryFee)),
    taxes_and_charges: numberValue(firstValue(sourcePricing.taxes_and_charges, sourcePricing.taxesAndCharges, sourcePricing.taxes)),
    to_pay: numberValue(firstValue(sourcePricing.to_pay, sourcePricing.final_price, sourcePricing.total, sourcePricing.payable_amount))
  };
  const offers = {
    coupon_applied: firstValue(sourceOffers.coupon_applied, sourceOffers.couponApplied),
    coupon_discount: numberValue(firstValue(sourceOffers.coupon_discount, sourceOffers.couponDiscount, sourceOffers.discount))
  };
  return { cartId: firstValue(cart.cart_id, data.cart_id, root.cart_id), restaurant: cart.restaurant || data.restaurant || root.restaurant, items: itemsSource.items || [], pricing, offers, addressId: firstValue(data.addressId, root.addressId, cart.addressId), availablePaymentMethods: data.availablePaymentMethods || root.availablePaymentMethods, paymentOptions: normalizePaymentOptions(root) };
}

async function createOrderReview(body) {
  if (!body.addressId) throw new Error("Choose a saved Swiggy delivery address before ordering.");
  const client = await createFoodClient();
  const item = await resolveOrderItem(client, body.addressId, body.item);
  const schema = customizationSchema(item);
  if (schema.requiresCustomization && !body.selections) return { needsCustomization: true, item: { name: item.name, price: item.price, restaurant: item.restaurant_name }, ...schema };
  const selected = chooseCustomizations(item, body.selections || {});
  const cartItems = [{ menu_item_id: item.menu_item_id, quantity: 1, ...(selected.variants.length && selected.variationMode === "variantsV2" ? { variantsV2: selected.variants } : {}), ...(selected.variants.length && selected.variationMode === "variations" ? { variations: selected.variants.flatMap(group => group.variations) } : {}), ...(selected.addons.length ? { addons: selected.addons } : {}) }];
  const updated = await client.callTool("update_food_cart", { restaurantId: item.restaurant_id, cartItems, addressId: body.addressId, restaurantName: item.restaurant_name });
  safeMcpDiagnostics("update_food_cart", toolData(updated));
  const cartResult = await client.callTool("get_food_cart", { addressId: body.addressId, restaurantName: item.restaurant_name });
  const cart = cartView(toolData(cartResult));
  const paymentResult = await client.callTool("get_payment_options", { addressId: body.addressId });
  safeMcpDiagnostics("get_payment_options", toolData(paymentResult));
  const paymentOptions = normalizePaymentOptions(toolData(paymentResult));
  const reviewId = base64Url(randomBytes(18));
  orderSessions.set(reviewId, { addressId: body.addressId, item, cart, paymentOptions, createdAt: Date.now() });
  return { reviewId, cart, paymentOptions, address: body.address, item: { name: item.name, restaurant: item.restaurant_name } };
}

async function placeReviewedOrder(body) {
  const session = orderSessions.get(body.reviewId);
  if (!session || Date.now() - session.createdAt > 15 * 60 * 1000) throw new Error("This checkout review expired. Start the order again.");
  if (!body.paymentMethod) throw new Error("Choose an available payment method before confirming.");
  const client = await createFoodClient();
  const latestCart = cartView(toolData(await client.callTool("get_food_cart", { addressId: session.addressId, restaurantName: session.item.restaurant_name })));
  if (latestCart.pricing?.to_pay === undefined) throw new Error("Swiggy returned no payable total. The cart may have changed.");
  const args = { addressId: session.addressId, paymentMethod: body.paymentMethod };
  if (body.paymentMethod === "UPI") {
    if (body.generateUPIQR) args.generateUPIQR = true;
    else if (body.intentApp) args.intentApp = body.intentApp;
  }
  const result = toolData(await client.callTool("place_food_order", args));
  if (result.status === "PENDING_PAYMENT" || result.normalizedStatus === "pending") return { status: "PENDING_PAYMENT", payment: result, total: latestCart.pricing.to_pay };
  if (result.normalizedStatus !== "success" && result.status !== "CONFIRMED") throw new Error("Swiggy did not confirm that the order was placed.");
  orderSessions.delete(body.reviewId);
  return { status: "CONFIRMED", order: result, total: latestCart.pricing.to_pay };
}

async function checkReviewedPayment(body) {
  const session = orderSessions.get(body.reviewId);
  if (!session || !body.payment?.paasId) throw new Error("Payment session is missing or expired.");
  const client = await createFoodClient();
  const status = toolData(await client.callTool("check_payment_status", { paasId: body.payment.paasId, orderId: body.payment.orderId, addressId: body.payment.addressId, cartId: body.payment.cartId, lat: body.payment.lat, lng: body.payment.lng }));
  if (status.confirmed === true) { orderSessions.delete(body.reviewId); return { status: "CONFIRMED", payment: status }; }
  if (status.status === "SUCCESS" || status.normalizedStatus === "success") {
    const confirmed = toolData(await client.callTool("confirm_order", { orderId: status.orderId, addressId: status.addressId || session.addressId, cartId: status.cartId, lat: status.lat, lng: status.lng }));
    if (confirmed.result !== "success") throw new Error("Swiggy payment succeeded, but order confirmation did not succeed.");
    orderSessions.delete(body.reviewId);
    return { status: "CONFIRMED", payment: status, order: confirmed };
  }
  return { status: status.status || "PENDING_PAYMENT", payment: status };
}

async function trackOrder(body) {
  if (!body.orderId) throw new Error("Swiggy did not return an order ID.");
  const client = await createFoodClient();
  return toolData(await client.callTool("track_food_order", { orderId: body.orderId }));
}

function filterDishes(dishes, preferences) {
  return dishes.filter(dish => {
    const price = Number(dish.price);
    return Number.isFinite(price) && price <= preferences.budget;
  })
    .filter(dish => !preferences.dietary?.includes("vegetarian") || dish.isVeg !== false)
    .filter(dish => !preferences.dietary?.includes("non-vegetarian") || dish.isVeg === false)
    .slice(0, 5)
    .map(normalizeDish);
}

async function searchLive(preferences) {
  const budget = Number(preferences.budget);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("Enter a budget greater than ₹0.");
  if (!preferences.addressId) throw new Error("Choose a saved Swiggy delivery address before searching.");
  preferences = { ...preferences, budget };
  const client = await createFoodClient();
  const args = { addressId: preferences.addressId, query: queryFor(preferences), offset: 0 };
  const collection = collectionFor(preferences);
  if (collection) args.collection = collection;
  let result = toolData(await client.callTool("search_restaurants", args));
  let restaurants = new Map((result.restaurants || []).map(restaurant => [restaurant.id, restaurant]));
  let restaurantDishes = (result.dishes || []).filter(dish => {
    const restaurant = restaurants.get(dish.restaurantId);
    return !restaurant || !restaurant.availabilityStatus || restaurant.availabilityStatus === "OPEN";
  });
  let items = filterDishes(restaurantDishes, preferences);

  // STORE_99 is intentionally narrow. Swiggy's guidance says to retry the
  // standard search when a scoped collection has no results.
  if (!items.length && collection) {
    result = toolData(await client.callTool("search_restaurants", { addressId: preferences.addressId, query: queryFor(preferences), offset: 0 }));
    restaurants = new Map((result.restaurants || []).map(restaurant => [restaurant.id, restaurant]));
    restaurantDishes = (result.dishes || []).filter(dish => {
      const restaurant = restaurants.get(dish.restaurantId);
      return !restaurant || !restaurant.availabilityStatus || restaurant.availabilityStatus === "OPEN";
    });
    items = filterDishes(restaurantDishes, preferences);
  }

  // search_restaurants may return restaurants without dish rows. Use the
  // documented dish search with the required addressId in that case.
  if (!items.length) {
    const menuResult = toolData(await client.callTool("search_menu", {
      addressId: preferences.addressId,
      query: menuQueryFor(preferences),
      offset: 0,
      ...(preferences.dietary?.includes("vegetarian") ? { vegFilter: 1 } : {})
    }));
    items = filterDishes(menuResult.items || [], preferences);
  }
  return { items, tool: items.length && result.dishes?.length ? "search_restaurants" : "search_menu" };
}

async function readJson(request) { let body = ""; for await (const chunk of request) body += chunk; return JSON.parse(body || "{}"); }
async function sendJson(response, status, data) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(data)); }

function base64Url(buffer) { return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function callbackUrl(request) { return `http://${request.headers.host}/auth/callback`; }

async function startOAuth(request, response) {
  const redirectUri = `http://localhost:${PORT}/auth/callback`;
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(24));
  const registration = await fetch("https://mcp.swiggy.com/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "BiteWise", redirect_uris: [redirectUri], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  if (!registration.ok) throw new Error(`Swiggy OAuth client registration failed (${registration.status}).`);
  const client = await registration.json();
  const requestedReturnTo = new URL(`http://${request.headers.host}${request.url}`).searchParams.get("returnTo");
  const returnTo = requestedReturnTo?.startsWith("/") ? requestedReturnTo : "/index.html";
  oauthRequests.set(state, { verifier, clientId: client.client_id, redirectUri, returnTo, createdAt: Date.now() });
  const authorize = new URL("https://mcp.swiggy.com/auth/authorize");
  authorize.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, scope: "mcp:tools" });
  response.writeHead(302, { location: authorize.toString() });
  response.end();
}

async function finishOAuth(request, response) {
  const url = new URL(`http://${request.headers.host}${request.url}`);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const flow = oauthRequests.get(state);
  oauthRequests.delete(state);
  if (url.searchParams.get("error")) {
    response.writeHead(302, { location: flow?.returnTo || "/index.html?auth=cancelled" });
    response.end();
    return;
  }
  if (!flow || !code || Date.now() - flow.createdAt > 10 * 60 * 1000) throw new Error("The Swiggy login session expired or was invalid.");
  const tokenResponse = await fetch("https://mcp.swiggy.com/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code, client_id: flow.clientId, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }) });
  if (!tokenResponse.ok) throw new Error(`Swiggy OAuth token exchange failed (${tokenResponse.status}).`);
  const token = await tokenResponse.json();
  if (!token.access_token) throw new Error("Swiggy OAuth did not return an access token.");
  oauthAccessToken = token.access_token;
  response.writeHead(302, { location: flow.returnTo });
  response.end();
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url.startsWith("/auth/start")) return await startOAuth(request, response);
    if (request.method === "GET" && request.url.startsWith("/auth/callback")) return await finishOAuth(request, response);
    if (request.method === "GET" && request.url === "/api/addresses") return sendJson(response, 200, { mode: "addresses", addresses: await getAddresses() });
    if (request.method === "POST" && request.url === "/api/recommendations") {
      const live = await searchLive(await readJson(request));
      return sendJson(response, 200, { mode: "live", source: { server: "swiggy-food", tool: live.tool }, items: live.items });
    }
    if (request.method === "POST" && request.url === "/api/order/review") return sendJson(response, 200, { mode: "review", ...(await createOrderReview(await readJson(request))) });
    if (request.method === "POST" && request.url === "/api/order/confirm") return sendJson(response, 200, { mode: "order", ...(await placeReviewedOrder(await readJson(request))) });
    if (request.method === "POST" && request.url === "/api/order/payment-status") return sendJson(response, 200, { mode: "payment", ...(await checkReviewedPayment(await readJson(request))) });
    if (request.method === "POST" && request.url === "/api/order/track") return sendJson(response, 200, { mode: "tracking", ...(await trackOrder(await readJson(request))) });
    if (request.method === "GET" && request.url === "/api/mcp-status") return sendJson(response, 200, { server: "swiggy-food", url: MCP_URL, configured: Boolean(getAuthorization()), authType: oauthAccessToken ? "oauth" : MCP_AUTHORIZATION ? "bearer" : null });
    if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed" });
    const requestedPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];
    const file = await readFile(join(root, requestedPath.replace(/^\//, "")));
    response.writeHead(200, { "content-type": MIME_TYPES[extname(requestedPath)] || "application/octet-stream" });
    response.end(file);
  } catch (error) {
    if (request.url === "/api/recommendations" && error.code === "AUTH_REQUIRED") return sendJson(response, 200, { mode: "auth_required", authUrl: "/auth/start", error: "Swiggy login is required.", items: [] });
    if (request.url === "/api/addresses" && error.code === "AUTH_REQUIRED") return sendJson(response, 200, { mode: "auth_required", authUrl: "/auth/start", addresses: [] });
    if (request.url === "/api/recommendations") return sendJson(response, 200, { mode: "unavailable", error: error.message, items: [] });
    if (request.url.startsWith("/api/order/")) return sendJson(response, 200, { mode: "unavailable", error: error.message });
    if (request.url.startsWith("/auth/")) { response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); return response.end(error.message); }
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`BiteWise running at http://localhost:${PORT}`));
