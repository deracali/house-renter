const PAGE_SIZE = 12;
const cityPhotos = {
  Austin: "photo-1531218150217-54595bc2b934",
  Seattle: "photo-1502175353174-a7a70e73b362",
  Denver: "photo-1518005020951-eccb494ad742",
  Chicago: "photo-1494522358652-f30e61a60313",
  Dallas: "photo-1519608487953-e999c86e7455",
  Boston: "photo-1501979376754-2ff867a4f659",
  Miami: "photo-1514214246283-d427a95c5d2f",
  Portland: "photo-1500530855697-b586d89ba3ee",
  "New York": "photo-1518391846015-55a9cc003b25",
  "Los Angeles": "photo-1515894347714-2f2c8e8d0cf5",
  Phoenix: "photo-1534452203293-494d7ddbf7e0",
  Nashville: "photo-1514525253161-7a46d19cd819",
  "San Diego": "photo-1533105079780-92b9be482077",
  Minneapolis: "photo-1506744038136-46273834b3fb",
  Charleston: "photo-1499793983690-e29da59ef1c2"
};

const state = { houses: [], filtered: [], visibleCount: PAGE_SIZE, selectedCity: "", authMode: "signin", showAllCities: false, lightboxImages: [], lightboxIndex: 0, currentUser: null, favorites: new Set() };
const $ = (selector) => document.querySelector(selector);
const propertyGrid = $("#propertyGrid");
const propertyDialog = $("#propertyDialog");
const authDialog = $("#authDialog");

function imageUrl(id, width = 720) {
  const host = id.startsWith("premium_photo-") ? "plus.unsplash.com" : "images.unsplash.com";
  return `https://${host}/${id}?auto=format&fit=crop&w=${width}&q=80`;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "The server could not complete that request.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function cityCounts(houses) {
  return houses.reduce((counts, house) => {
    counts[house.city] = (counts[house.city] || 0) + 1;
    return counts;
  }, {});
}

function renderCities() {
  const counts = cityCounts(state.houses);
  const allCities = Object.keys(counts);
  const featuredCities = allCities.slice(0, 6);
  if (allCities.includes("San Diego") && !featuredCities.includes("San Diego")) {
    featuredCities[featuredCities.length - 1] = "San Diego";
  }
  const cities = state.showAllCities ? allCities : featuredCities;
  $("#cityGrid").innerHTML = cities.map((city) => {
    const listingCount = counts[city];
    return `<button class="city-card" type="button" data-city="${escapeHtml(city)}" aria-label="Browse ${escapeHtml(city)} homes">
      <img src="${imageUrl(cityPhotos[city] || state.houses.find((house) => house.city === city).images[0], 500)}" alt="${escapeHtml(city)} city view" loading="lazy">
      <span class="city-info"><strong>${escapeHtml(city)}</strong><small>${listingCount} ${listingCount === 1 ? "home" : "homes"}</small></span>
    </button>`;
  }).join("");
  $("#allCities").textContent = state.showAllCities ? "Show fewer cities ↑" : "View all cities →";
}

function renderPropertyCard(house) {
  const isFavorite = state.favorites.has(house.id);
  const location = `${house.city}, ${house.state}`;
  return `<article class="property-card" data-house-id="${escapeHtml(house.id)}">
    <div class="property-image-wrap">
      <img class="property-image" src="${imageUrl(house.images[0])}" alt="${escapeHtml(house.title)} in ${escapeHtml(location)}" loading="lazy" data-photo-index="0">
      <span class="property-location">${escapeHtml(location)}</span>
      <button class="favorite-button${isFavorite ? " active" : ""}" type="button" data-favorite="${escapeHtml(house.id)}" aria-label="${isFavorite ? "Remove from" : "Add to"} saved homes" aria-pressed="${isFavorite}">${isFavorite ? "♥" : "♡"}</button>
      <span class="property-tag">${escapeHtml(house.tag)}</span>
    </div>
    <div class="property-body">
      <div class="price-rating"><strong class="property-price">${money(house.price)}<span>/mo</span></strong><span class="rating">★ ${house.rating} (${house.reviews})</span></div>
      <p class="property-name">${escapeHtml(house.beds)} Bed · ${escapeHtml(house.baths)} Bath · ${escapeHtml(house.type === "house" ? "Whole House" : house.type === "room" ? "Private Room" : "Apartment")}</p>
      <div class="property-meta"><span>${house.beds} Bed</span><span>${house.baths} Bath</span><span>${house.area.toLocaleString()} sq ft</span></div>
      <div class="property-features"><span>✓ Verified Landlord</span><span>◷ Fast reply</span></div>
      <button class="details-button" type="button" data-details="${escapeHtml(house.id)}">View Details</button>
    </div>
  </article>`;
}

function renderListings() {
  const visible = state.filtered.slice(0, state.visibleCount);
  propertyGrid.innerHTML = visible.map(renderPropertyCard).join("");
  $("#resultCount").textContent = `${state.filtered.length.toLocaleString()} near you`;
  $("#emptyState").hidden = state.filtered.length !== 0;
  $("#loadMore").hidden = state.visibleCount >= state.filtered.length;
  const filters = [];
  if (state.selectedCity) filters.push(state.selectedCity);
  const maxPrice = Number($("#priceFilter").value);
  if (maxPrice < 12000) filters.push(`up to ${money(maxPrice)}/mo`);
  $("#activeFilter").textContent = filters.length ? `Showing verified homes in ${filters.join(" · ")}` : "Hand-picked verified rooms & homes near you.";
}

function applyFilters() {
  const search = $("#citySearch").value.trim().toLowerCase();
  const type = $("#typeFilter").value;
  const maxPrice = Number($("#priceFilter").value) || 12000;
  const minPrice = Number($("#minPrice").value) || 0;
  const panelMax = Number($("#maxPrice").value) || 12000;
  const beds = Number($("#bedroomFilter").value) || 0;
  const lease = $("#leaseTerm").value;
  const moveDate = $("#moveDate").value;
  state.filtered = state.houses.filter((house) => {
    const matchesText = !search || `${house.city} ${house.state} ${house.neighborhood} ${house.title} ${house.city} ${house.state.slice(0, 2)}`.toLowerCase().includes(search);
    const matchesCity = !state.selectedCity || house.city === state.selectedCity;
    const availableByMoveDate = !moveDate || house.available === "Available now" || new Date(house.available) <= new Date(`${moveDate}T23:59:59`);
    return matchesText && matchesCity && (!type || house.type === type) &&
      house.price <= Math.min(maxPrice, panelMax) && house.price >= minPrice && house.beds >= beds &&
      (!lease || house.lease === lease) && availableByMoveDate;
  });
  const sort = $("#sortSelect").value;
  if (sort === "price-low") state.filtered.sort((a, b) => a.price - b.price);
  if (sort === "price-high") state.filtered.sort((a, b) => b.price - a.price);
  if (sort === "rating") state.filtered.sort((a, b) => b.rating - a.rating || b.reviews - a.reviews);
  state.visibleCount = PAGE_SIZE;
  renderListings();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

function renderPropertyDetails(id) {
  const house = state.houses.find((item) => item.id === id);
  if (!house) return;
  $("#propertyDetail").innerHTML = `<div class="detail-content">
    <div class="detail-gallery" data-house-id="${escapeHtml(house.id)}">${house.images.slice(0, 5).map((image, index) => `<img src="${imageUrl(image, 900)}" alt="${escapeHtml(house.title)} photo ${index + 1}" data-photo-index="${index}" tabindex="0" role="button" aria-label="View photo ${index + 1} of ${house.images.length}">`).join("")}</div>
    <div class="detail-title-row"><div><h2 id="propertyTitle">${escapeHtml(house.title)}</h2><p>${escapeHtml(house.neighborhood)}, ${escapeHtml(house.city)}, ${escapeHtml(house.state)} · ${escapeHtml(house.available)}</p></div><div class="detail-rent">${money(house.price)}<span>/ month</span></div></div>
    <div class="detail-facts"><span>${house.beds} bedrooms</span><span>${house.baths} bathrooms</span><span>${house.area.toLocaleString()} sq ft</span><span>${escapeHtml(house.lease)}</span><span>★ ${house.rating} (${house.reviews} reviews)</span></div>
    <p class="detail-description">${escapeHtml(house.description)}</p>
    <div class="detail-facts">${house.features.map((feature) => `<span>✓ ${escapeHtml(feature)}</span>`).join("")}</div>
    <div class="detail-bottom"><div class="host-info"><strong>Hosted by ${escapeHtml(house.host)}</strong><small>Verified RentHub landlord · Usually replies within 1 hour</small></div><button class="button button-green" type="button" data-contact="${escapeHtml(house.id)}">Contact landlord</button></div>
  </div>`;
  propertyDialog.showModal();
}

function openPhotoViewer(houseId, index) {
  const house = state.houses.find((item) => item.id === houseId);
  if (!house) return;
  state.lightboxImages = house.images;
  state.lightboxIndex = index;
  updatePhotoViewer();
  $("#photoViewer").showModal();
}

function updatePhotoViewer() {
  const house = state.houses.find((item) => item.images === state.lightboxImages);
  const image = state.lightboxImages[state.lightboxIndex];
  $("#photoViewerImage").src = imageUrl(image, 1600);
  $("#photoViewerImage").alt = `${house ? escapeHtml(house.title) : "Property"} photo ${state.lightboxIndex + 1}`;
  $("#photoCounter").textContent = `${state.lightboxIndex + 1} / ${state.lightboxImages.length}`;
  $("#photoPrevious").disabled = state.lightboxImages.length < 2;
  $("#photoNext").disabled = state.lightboxImages.length < 2;
}

function movePhoto(direction) {
  const total = state.lightboxImages.length;
  if (!total) return;
  state.lightboxIndex = (state.lightboxIndex + direction + total) % total;
  updatePhotoViewer();
}

function openAuth(mode = "signin") {
  setAuthMode(mode);
  $("#authMessage").textContent = "";
  authDialog.showModal();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signingUp = mode === "signup";
  $("#nameField").hidden = !signingUp;
  $("#authName").required = signingUp;
  $("#authPassword").autocomplete = signingUp ? "new-password" : "current-password";
  $("#authTitle").textContent = signingUp ? "Create your account" : "Welcome home";
  $("#authSubtitle").textContent = signingUp ? "Join renters finding their next home." : "Sign in to save homes and contact landlords.";
  $("#authSubmit").textContent = signingUp ? "Create Account" : "Sign In";
  document.querySelectorAll(".auth-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.authMode === mode));
}

function refreshAuthButton() {
  const user = state.currentUser;
  $("#authButton").textContent = user ? `Hi, ${user.name.split(" ")[0]}` : "Sign In";
  $("#headerSignup").textContent = user ? "Sign Out" : "Sign Up";
}

async function onAuthSubmit(event) {
  event.preventDefault();
  const email = $("#authEmail").value.trim().toLowerCase();
  const password = $("#authPassword").value;
  const message = $("#authMessage");
  const submit = $("#authSubmit");
  message.classList.remove("success");
  message.textContent = "";
  submit.disabled = true;
  try {
    let result;
    if (state.authMode === "signup") {
      result = await apiRequest("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          name: $("#authName").value.trim(),
          email,
          password
        })
      });
      message.textContent = "Account created. You’re signed in!";
    } else {
      result = await apiRequest("/api/auth/signin", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      message.textContent = "Signed in successfully.";
    }
    state.currentUser = result.user;
    state.favorites = new Set(result.user.favorites || []);
  } catch (error) {
    message.textContent = error.message;
    return;
  } finally {
    submit.disabled = false;
  }
  message.classList.add("success");
  refreshAuthButton();
  renderListings();
  window.setTimeout(() => authDialog.close(), 700);
}

async function loadCurrentUser() {
  try {
    const result = await apiRequest("/api/auth/me");
    state.currentUser = result.user;
    state.favorites = new Set(result.user.favorites || []);
  } catch (error) {
    if (error.status !== 401) {
      console.error("Could not load the signed-in user from the server.", error);
      showToast(error.message);
    }
    state.currentUser = null;
    state.favorites.clear();
  }
  refreshAuthButton();
  renderListings();
}

async function loadHouses() {
  try {
    const response = await fetch("./houses.json");
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    const houses = await response.json();
    if (!Array.isArray(houses) || houses.length === 0) throw new Error("The property list is empty or invalid.");
    state.houses = houses;
    state.filtered = [...houses];
    renderCities();
    renderListings();
  } catch (error) {
    console.error("Could not load property listings.", error);
    $("#propertyGrid").innerHTML = "";
    $("#emptyState").hidden = false;
    $("#emptyState").textContent = "We couldn’t load the homes. Please run this site from a local web server and try again.";
  }
}

$("#searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.selectedCity = "";
  applyFilters();
  $("#homes").scrollIntoView({ behavior: "smooth" });
});
$("#sortSelect").addEventListener("change", applyFilters);
$("#filterToggle").addEventListener("click", () => { $("#filterPanel").hidden = !$("#filterPanel").hidden; });
$("#applyFilters").addEventListener("click", applyFilters);
$("#clearFilters").addEventListener("click", () => {
  $("#minPrice").value = "";
  $("#maxPrice").value = "";
  $("#bedroomFilter").value = "";
  $("#priceFilter").value = "12000";
  $("#typeFilter").value = "";
  $("#citySearch").value = "";
  state.selectedCity = "";
  applyFilters();
});
$("#loadMore").addEventListener("click", () => { state.visibleCount += PAGE_SIZE; renderListings(); });
$("#cityGrid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-city]");
  if (!button) return;
  state.selectedCity = button.dataset.city;
  $("#citySearch").value = "";
  applyFilters();
  $("#homes").scrollIntoView({ behavior: "smooth" });
});
$("#allCities").addEventListener("click", () => {
  state.showAllCities = !state.showAllCities;
  state.selectedCity = "";
  $("#citySearch").value = "";
  renderCities();
  applyFilters();
});
propertyGrid.addEventListener("click", async (event) => {
  const photo = event.target.closest("[data-photo-index]");
  if (photo) {
    openPhotoViewer(photo.closest("[data-house-id]").dataset.houseId, Number(photo.dataset.photoIndex));
    return;
  }
  const favoriteButton = event.target.closest("[data-favorite]");
  if (favoriteButton) {
    if (!state.currentUser) {
      openAuth("signin");
      showToast("Sign in to save your favorite homes.");
      return;
    }
    const houseId = favoriteButton.dataset.favorite;
    const wasFavorite = state.favorites.has(houseId);
    try {
      const result = await apiRequest(`/api/auth/favorites/${encodeURIComponent(houseId)}`, {
        method: wasFavorite ? "DELETE" : "PUT"
      });
      state.favorites = new Set(result.favorites);
      renderListings();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  const detailsButton = event.target.closest("[data-details]");
  if (detailsButton) renderPropertyDetails(detailsButton.dataset.details);
});
$("#propertyDetail").addEventListener("click", (event) => {
  const photo = event.target.closest("[data-photo-index]");
  if (photo) {
    openPhotoViewer(photo.closest("[data-house-id]").dataset.houseId, Number(photo.dataset.photoIndex));
    return;
  }
  const contactButton = event.target.closest("[data-contact]");
  if (!contactButton) return;
  if (!state.currentUser) {
    propertyDialog.close();
    openAuth("signin");
    showToast("Sign in to contact this landlord.");
    return;
  }
  const house = state.houses.find((item) => item.id === contactButton.dataset.contact);
  if (house) showToast(`Your inquiry to ${house.host} is ready. Contact hello@renthub.example to follow up.`);
});
document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));
$("#authForm").addEventListener("submit", onAuthSubmit);
$("#authButton").addEventListener("click", () => {
  if (state.currentUser) {
    openAuth("signin");
    $("#authEmail").value = state.currentUser.email;
  } else openAuth("signin");
});
$("#headerSignup").addEventListener("click", async () => {
  if (state.currentUser) {
    try {
      await apiRequest("/api/auth/signout", { method: "POST", body: "{}" });
    } catch (error) {
      showToast(error.message);
      return;
    }
    state.currentUser = null;
    state.favorites.clear();
    refreshAuthButton();
    renderListings();
    showToast("You’ve signed out.");
  } else openAuth("signup");
});
$("#listProperty").addEventListener("click", () => {
  if (!state.currentUser) openAuth("signup");
  else showToast("Thanks for your interest! Email hello@renthub.example to list your home.");
});
document.querySelectorAll("[data-filter-kind]").forEach((link) => link.addEventListener("click", () => {
  $("#typeFilter").value = link.dataset.filterKind;
  state.selectedCity = "";
  applyFilters();
}));
$("#newsletterForm").addEventListener("submit", (event) => {
  event.preventDefault();
  $("#newsletterMessage").textContent = "You’re on the list! Watch your inbox for new homes.";
  event.currentTarget.reset();
});
$("#menuToggle").addEventListener("click", () => {
  const nav = document.querySelector(".main-nav");
  const isOpen = nav.classList.toggle("open");
  $("#menuToggle").setAttribute("aria-expanded", String(isOpen));
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
for (const dialog of [propertyDialog, authDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
$("#photoPrevious").addEventListener("click", () => movePhoto(-1));
$("#photoNext").addEventListener("click", () => movePhoto(1));
$("#photoViewerClose").addEventListener("click", () => $("#photoViewer").close());
$("#photoViewer").addEventListener("click", (event) => {
  if (event.target === $("#photoViewer")) $("#photoViewer").close();
});
$("#photoViewer").addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") movePhoto(-1);
  if (event.key === "ArrowRight") movePhoto(1);
});
$("#propertyDetail").addEventListener("keydown", (event) => {
  const photo = event.target.closest("[data-photo-index]");
  if (photo && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openPhotoViewer(photo.closest("[data-house-id]").dataset.houseId, Number(photo.dataset.photoIndex));
  }
});

refreshAuthButton();
loadCurrentUser();
loadHouses();
