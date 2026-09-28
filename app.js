const form = document.querySelector("#preference-form");
const appContent = document.querySelector("#app-content");
const authGate = document.querySelector("#auth-gate");
const authStart = document.querySelector("#auth-start");
const authGateFeedback = document.querySelector("#auth-gate-feedback");
const results = document.querySelector("#results");
const resultsState = document.querySelector("#results-state");
const list = document.querySelector("#recommendation-list");
const emptyState = document.querySelector("#empty-state");
const error = document.querySelector("#form-error");
const summary = document.querySelector("#selection-summary");
const dietaryOptions = document.querySelector("#dietary-options");
const modeBadge = document.querySelector("#mode-badge");
const emptyTitle = document.querySelector("#empty-title");
const emptyCopy = document.querySelector("#empty-copy");
const authStatus = document.querySelector("#auth-status");
const authFeedback = document.querySelector("#auth-feedback");
const locationSelector = document.querySelector("#location-selector");
const addressPanel = document.querySelector("#address-panel");
const addressList = document.querySelector("#address-list");
const addressFeedback = document.querySelector("#address-feedback");
const orderModal = document.querySelector("#order-modal");
const orderBody = document.querySelector("#order-body");
const orderFeedback = document.querySelector("#order-feedback");
let appState = "unauthenticated";
let selectedLocation = null;
let recommendations = [];
let pendingOrderItem = null;
let pendingReview = null;

function selected(name) { return [...form.querySelectorAll(`[name="${name}"]:checked`)].map(input => input.value); }

function setState(nextState, message = "") {
  appState = nextState;
  const authenticated = ["authenticated", "location_required", "location_selected", "ready_to_search"].includes(nextState);
  appContent.hidden = !authenticated;
  authGate.hidden = authenticated;
  const formReady = ["location_selected", "ready_to_search"].includes(nextState);
  form.querySelectorAll("input, button").forEach(control => { control.disabled = !formReady; });
  if (nextState === "location_required") { locationSelector.disabled = false; addressPanel.hidden = false; }
  if (nextState === "location_selected" || nextState === "ready_to_search") addressPanel.hidden = true;
  if (message) authGateFeedback.textContent = message;
}

function readPreferences() {
  const budget = Number(form.querySelector('[name="budget"]')?.value);
  const dietary = selected("dietary");
  return { budget, dietary: dietary.includes("none") ? [] : dietary, craving: selected("craving")[0], meal: selected("meal")[0], addressId: selectedLocation?.id || "" };
}

function pretty(value) { return value.replace("-", " ").replace(/\b\w/g, letter => letter.toUpperCase()); }

function showSummary(preferences) {
  const tags = [`Up to ₹${preferences.budget}`, pretty(preferences.craving), pretty(preferences.meal), ...(preferences.dietary.length ? preferences.dietary.map(pretty) : ["No preference"])];
  summary.innerHTML = tags.map(tag => `<span class="summary-tag">${tag}</span>`).join("");
}

function renderRecommendations(items, preferences) {
  recommendations = items;
  list.innerHTML = items.map(item => {
    const labels = item.dietary.length ? item.dietary.map(pretty) : ["Dietary info not specified"];
    const labelHtml = labels.map(label => `<span class="label${label === "Dietary info not specified" ? " unspecified" : ""}">${label}</span>`).join("");
    const liveLink = item.url ? `<a class="swiggy-link" href="${item.url}" target="_blank" rel="noreferrer">Order on Swiggy →</a>` : `<span class="swiggy-link-missing">Swiggy order link not provided by Food MCP</span>`;
    const photo = item.image ? `<img class="food-photo" src="${item.image}" alt="${item.name}" />` : `<div class="food-placeholder" aria-hidden="true">✦</div>`;
    const price = item.price ? `<span class="price">₹${item.price}</span>` : "";
    const reason = item.description || `A ${pretty(preferences.meal).toLowerCase()} option within your budget.`;
    const orderAction = item.menuItemId && item.restaurantId ? `<button class="order-button" type="button" data-order-index="${items.indexOf(item)}">Order Now <span aria-hidden="true">→</span></button>` : `<span class="swiggy-link-missing">Ordering unavailable: Swiggy identifiers were not returned</span>`;
    return `<article class="recommendation-card">${photo}<div class="food-details"><div class="food-topline"><h3 class="food-name">${item.name}</h3>${price}</div><p class="restaurant">${item.restaurant || "Restaurant not specified"}</p><div class="labels">${labelHtml}</div><p class="match-reason">${reason}</p>${item.url ? liveLink : orderAction}</div></article>`;
  }).join("");
  emptyState.hidden = items.length > 0;
}

function closeOrderModal() { orderModal.hidden = true; orderBody.innerHTML = ""; orderFeedback.textContent = ""; pendingOrderItem = null; pendingReview = null; }

function showOrderModal() { orderModal.hidden = false; orderFeedback.textContent = ""; orderModal.scrollIntoView({ behavior: "smooth", block: "center" }); }

function customizationMarkup(review) {
  const groups = review.variationGroups || [];
  const variants = groups.map(group => `<label class="order-field"><span>${group.name || "Choose an option"}</span><select data-variant-group="${group.groupId}"><option value="">Choose one</option>${(group.variations || []).map(choice => `<option value="${choice.id}">${choice.name}${choice.price ? ` · ₹${choice.price}` : ""}</option>`).join("")}</select></label>`).join("");
  const addons = (review.addonGroups || []).map(group => `<fieldset class="order-addon-group"><legend>${group.groupName || group.name || "Add-ons"}${group.minAddons ? ` · choose at least ${group.minAddons}` : ""}</legend>${(group.choices || []).map(choice => `<label><input type="checkbox" data-addon-group="${group.groupId}" value="${choice.id}" /><span>${choice.name} · ₹${choice.price}</span></label>`).join("")}</fieldset>`).join("");
  return `<p>Choose the required Swiggy options before adding this item to your cart.</p>${variants}${addons}<button class="primary-button order-continue" id="order-customize-submit" type="button">Continue to review <span aria-hidden="true">→</span></button>`;
}

function paymentMethods(review) {
  const options = review.paymentOptions || {};
  const methods = options.allMethods || [];
  return methods.filter(method => method?.enabled !== false && method.id).map((method, index) => `<label class="payment-choice"><input type="radio" name="payment-method" value="${method.id}" ${index === 0 ? "checked" : ""} /><span>${method.displayName || method.id}</span></label>`).join("");
}

function money(value) { return Number.isFinite(Number(value)) ? `₹${Number(value).toLocaleString("en-IN")}` : "Not provided"; }

function renderReview(review) {
  const cart = review.cart || {};
  const pricing = cart.pricing || {};
  const offers = cart.offers || {};
  const items = (cart.items || []).map(item => `<li>${item.quantity}× ${item.name} <strong>${money(item.final_price ?? item.total ?? item.subtotal)}</strong></li>`).join("");
  const methods = paymentMethods(review);
  const paymentMessage = methods || review.paymentOptions?.reason || "Swiggy did not return an available payment method for this cart.";
  orderBody.innerHTML = `<div class="order-summary"><h3>${review.item?.restaurant || cart.restaurant?.name || "Swiggy restaurant"}</h3><ul>${items || `<li>${review.item?.name || "Selected item"}</li>`}</ul><dl><div><dt>Food</dt><dd>${money(pricing.item_total)}</dd></div><div><dt>Delivery</dt><dd>${money(pricing.delivery_charge)}</dd></div><div><dt>Taxes & charges</dt><dd>${money(pricing.taxes_and_charges)}</dd></div>${Number.isFinite(Number(offers.coupon_discount)) && Number(offers.coupon_discount) > 0 ? `<div><dt>Discount</dt><dd>-${money(offers.coupon_discount)}</dd></div>` : ""}<div class="order-total"><dt>Total</dt><dd>${money(pricing.to_pay)}</dd></div></dl></div><div class="delivery-summary"><strong>Deliver to</strong><span>${selectedLocation?.addressLine || "Selected Swiggy address"}</span></div><fieldset class="payment-list"><legend>Payment</legend>${methods || `<p>${paymentMessage}</p>`}</fieldset><button class="primary-button order-confirm" id="order-confirm" type="button" ${methods ? "" : "disabled"}>Confirm & Pay <span aria-hidden="true">→</span></button>`;
  document.querySelector("#order-confirm")?.addEventListener("click", confirmOrder);
}

async function requestOrderReview(selections) {
  orderFeedback.textContent = "Preparing a live Swiggy cart...";
  const response = await fetch("/api/order/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addressId: selectedLocation.id, address: selectedLocation, item: pendingOrderItem, selections }) });
  const result = await response.json();
  if (result.mode === "unavailable") throw new Error(result.error);
  if (result.needsCustomization) { orderBody.innerHTML = customizationMarkup(result); orderFeedback.textContent = ""; document.querySelector("#order-customize-submit").addEventListener("click", () => requestOrderReview(readCustomizations())); return; }
  pendingReview = result; orderFeedback.textContent = ""; renderReview(result);
}

function readCustomizations() {
  const variants = Object.fromEntries([...orderBody.querySelectorAll("[data-variant-group]")].map(select => [select.dataset.variantGroup, select.value]));
  const addons = {};
  orderBody.querySelectorAll("[data-addon-group]:checked").forEach(input => { (addons[input.dataset.addonGroup] ||= []).push(input.value); });
  return { variants, addons };
}

async function beginOrder(item) {
  pendingOrderItem = item; showOrderModal(); orderBody.innerHTML = `<p>Checking the selected Swiggy item and its live customizations...</p>`;
  try { await requestOrderReview(); } catch (requestError) { orderFeedback.textContent = requestError.message; }
}

async function confirmOrder() {
  const selectedMethod = document.querySelector('input[name="payment-method"]:checked')?.value;
  if (!selectedMethod || !pendingReview) return;
  const option = (pendingReview.paymentOptions?.allMethods || []).find(method => method.id === selectedMethod);
  const isUpi = option?.kind === "intent" || option?.kind === "qr" || selectedMethod.toLowerCase().includes("upi");
  orderFeedback.textContent = "Sending the confirmed order request to Swiggy...";
  try {
    const response = await fetch("/api/order/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewId: pendingReview.reviewId, paymentMethod: isUpi ? "UPI" : selectedMethod, intentApp: isUpi && option?.kind !== "qr" ? selectedMethod : undefined, generateUPIQR: isUpi && option?.kind === "qr" }) });
    const result = await response.json();
    if (result.mode === "unavailable") throw new Error(result.error);
    if (result.status === "PENDING_PAYMENT") { const paymentUrl = result.payment?.bridgeUrl || result.payment?.upiIntentUrl; orderBody.innerHTML = `<h3>Complete payment in Swiggy</h3><p>Your order is not placed yet. Complete the UPI payment, then check its status.</p>${paymentUrl ? `<a class="swiggy-link" href="${paymentUrl}" target="_blank" rel="noreferrer">Open UPI payment</a>` : ""}<button class="secondary-button" id="payment-status" type="button">Check payment status</button>`; document.querySelector("#payment-status").addEventListener("click", () => checkPayment(result)); return; }
    renderOrderSuccess(result);
  } catch (requestError) { orderFeedback.textContent = requestError.message; }
}

async function checkPayment(result) { orderFeedback.textContent = "Checking payment status with Swiggy..."; const response = await fetch("/api/order/payment-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewId: pendingReview.reviewId, payment: result.payment }) }); const status = await response.json(); if (status.status === "CONFIRMED") renderOrderSuccess(status); else orderFeedback.textContent = status.payment?.message || `Payment status: ${status.status}`; }
function renderOrderSuccess(result) { orderBody.innerHTML = `<h3>Order placed successfully</h3><p>Swiggy order ID: <strong>${result.order?.orderId || result.payment?.orderId || "-"}</strong></p><p>Final amount: <strong>₹${result.order?.totalAmount || result.total || "-"}</strong></p><button class="secondary-button" id="track-order" type="button">Track order</button>`; document.querySelector("#track-order").addEventListener("click", async () => { const response = await fetch("/api/order/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: result.order?.orderId || result.payment?.orderId }) }); const status = await response.json(); orderFeedback.textContent = status.message || JSON.stringify(status); }); }

function showUnavailable(message) {
  emptyTitle.textContent = "Swiggy results unavailable.";
  emptyCopy.textContent = `${message || "BiteWise could not reach Swiggy Food MCP."} No sample data is shown.`;
  emptyState.hidden = false;
  list.innerHTML = "";
  modeBadge.innerHTML = '<span class="status-dot"></span> Swiggy unavailable';
}

function beginAuth() {
  setState("authenticating");
  authGateFeedback.textContent = "Opening secure Swiggy authentication...";
  window.location.href = "/auth/start?returnTo=%2Findex.html%3Fauth%3Dsuccess";
}

async function loadAddresses() {
  addressPanel.hidden = false;
  addressFeedback.textContent = "Loading saved Swiggy addresses...";
  try {
    const response = await fetch("/api/addresses");
    const result = await response.json();
    if (result.mode === "auth_required") { setState("unauthenticated", "Your Swiggy session expired. Please authenticate again."); return; }
    addressList.innerHTML = (result.addresses || []).map(address => `<label class="address-choice"><input type="radio" name="saved-address" value="${address.id}" /><span><strong>${address.addressTag || "Saved address"}</strong><small>${address.addressLine}</small></span></label>`).join("");
    if (!result.addresses?.length) { addressFeedback.textContent = "No saved addresses were returned. Add an address in Swiggy first."; setState("location_required"); return; }
    addressFeedback.textContent = "Select one address to use for this search.";
    setState("location_required");
    addressList.querySelectorAll('[name="saved-address"]').forEach(input => input.addEventListener("change", event => {
      const address = result.addresses.find(item => item.id === event.target.value);
      selectedLocation = address ? { id: address.id, addressLine: address.addressLine, addressTag: address.addressTag } : null;
      locationSelector.querySelector("span:nth-child(2)").textContent = selectedLocation?.addressTag || selectedLocation?.addressLine || "Choose location";
      addressFeedback.textContent = "Address selected.";
      setState("ready_to_search");
    }));
  } catch {
    addressFeedback.textContent = "Location selection failed. Please try again.";
    setState("location_required");
  }
}

async function refreshMcpStatus() {
  try {
    const response = await fetch("/api/mcp-status");
    const status = await response.json();
    if (status.configured) {
      authStatus.innerHTML = '<span class="status-dot live-dot"></span> Configured';
      authFeedback.textContent = status.authType === "oauth" ? "Swiggy OAuth is connected." : "A server-side bearer token is configured.";
      setState("authenticated");
      await loadAddresses();
      return true;
    }
  } catch { authGateFeedback.textContent = "BiteWise could not reach its local API server."; }
  return false;
}

async function bootstrap() {
  const authResult = new URLSearchParams(window.location.search).get("auth");
  if (authResult === "cancelled") { setState("unauthenticated", "Swiggy authentication was cancelled."); return; }
  const authenticated = await refreshMcpStatus();
  if (!authenticated && authResult !== "success") beginAuth();
  if (!authenticated && authResult === "success") setState("unauthenticated", "Swiggy authentication could not be restored. Please try again.");
}

function runSearch(preferences) {
  results.hidden = false;
  results.scrollIntoView({ behavior: "smooth", block: "start" });
  list.innerHTML = "";
  emptyState.hidden = true;
  resultsState.hidden = false;
  showSummary(preferences);
  window.setTimeout(async () => {
    try {
      const response = await fetch("/api/recommendations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(preferences) });
      if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) throw new Error("Live API server is not running.");
      const live = await response.json();
      if (live.mode === "auth_required") { setState("unauthenticated", "Your Swiggy session expired. Please authenticate again."); return; }
      if (live.mode === "live") {
        modeBadge.innerHTML = '<span class="status-dot live-dot"></span> Live Swiggy results';
        resultsState.hidden = true;
        renderRecommendations(live.items, preferences);
        if (!live.items.length) showUnavailable("Swiggy returned no matching food options.");
        return;
      }
      showUnavailable(live.error);
    } catch (requestError) { showUnavailable(requestError.message); }
    resultsState.hidden = true;
  }, 750);
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const preferences = readPreferences();
  if (appState !== "ready_to_search" || !preferences.addressId) { error.textContent = "Choose a saved Swiggy delivery address before finding food."; error.hidden = false; return; }
  if (!Number.isFinite(preferences.budget) || preferences.budget <= 0 || !preferences.craving || !preferences.meal) { error.textContent = "Enter a budget greater than ₹0, then choose a craving and meal type to continue."; error.hidden = false; return; }
  error.hidden = true;
  runSearch(preferences);
});

dietaryOptions.addEventListener("change", event => {
  if (event.target.value === "none" && event.target.checked) form.querySelectorAll('[name="dietary"]').forEach(input => { if (input.value !== "none") input.checked = false; });
  if (event.target.value !== "none" && event.target.checked) form.querySelector('[name="dietary"][value="none"]').checked = false;
});

list.addEventListener("click", event => { const button = event.target.closest("[data-order-index]"); if (button) beginOrder(recommendations[Number(button.dataset.orderIndex)]); });
document.querySelector("#order-close").addEventListener("click", closeOrderModal);

document.querySelector("#edit-preferences").addEventListener("click", () => { results.hidden = true; document.querySelector("#preferences-title").scrollIntoView({ behavior: "smooth", block: "start" }); });
document.querySelector("#empty-edit").addEventListener("click", () => { results.hidden = true; document.querySelector("#preferences-title").scrollIntoView({ behavior: "smooth", block: "start" }); });
authStart.addEventListener("click", beginAuth);
document.querySelector("#auth-refresh").addEventListener("click", beginAuth);
locationSelector.addEventListener("click", loadAddresses);
bootstrap();
