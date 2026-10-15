import './style.css';
import L from 'leaflet';

const app = document.querySelector('#app');

const categories = [
  { id: 'library', label: 'Libraries', icon: '▤', tag: ['amenity', 'library'] },
  { id: 'cafe', label: 'Cafés', icon: '☕', tag: ['amenity', 'cafe'] },
  { id: 'restaurant', label: 'Restaurants', icon: '♧', tag: ['amenity', 'restaurant'] },
  { id: 'park', label: 'Parks', icon: '♧', tag: ['leisure', 'park'] },
];

const state = {
  category: 'library',
  places: [],
  saved: loadSavedPlaces(),
  query: '',
  message: 'Search for a campus or location to discover mapped places.',
  loading: false,
  center: { lat: 12.9345, lon: 77.6065, name: 'Christ University, Bengaluru' },
  hasSearched: false,
};

let map = null;
let markerLayer = null;
let searchMarkerLayer = null;
let requestController = null;

function loadSavedPlaces() {
  try {
    const stored = JSON.parse(localStorage.getItem('campus-compass-saved') || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function savePlaces() {
  try {
    localStorage.setItem('campus-compass-saved', JSON.stringify(state.saved));
  } catch (error) {
    console.warn('Could not save places in local storage:', error);
    setMessage('Your browser could not save this shortlist.');
  }
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function icon(name) {
  const icons = {
    compass: '✳', bookmark: '♡', pin: '⌖',
  };
  return icons[name] || '•';
}

function setMessage(message, type = 'info') {
  state.message = message;
  const node = document.querySelector('#statusMessage');
  if (node) {
    node.textContent = message;
    node.className = `mt-3 text-sm ${type === 'error' ? 'text-rose-300' : type === 'success' ? 'text-emerald-300' : 'text-slate-400'}`;
  }
}

function getFilteredPlaces() {
  return state.places.filter((place) => place.category === state.category);
}

async function geocodeLocation(location, signal) {
  // Vite proxies this local route to Nominatim, avoiding browser-to-service CORS issues.
  const params = new URLSearchParams({ q: location, format: 'jsonv2', limit: '1' });
  const response = await fetch(`/api/geocode?${params}`, { signal });

  if (!response.ok) {
    throw new Error(`Location lookup failed (HTTP ${response.status}). Please try again.`);
  }

  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('Location not found. Try a more specific name, such as “Christ University, Bengaluru, India”.');
  }

  const lat = Number(results[0].lat);
  const lon = Number(results[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('The location service returned invalid coordinates.');
  }

  return { lat, lon, name: results[0].display_name || location };
}

async function fetchNearbyPlaces(lat, lon, category, signal) {
  const selected = categories.find((item) => item.id === category);
  if (!selected) throw new Error('Please select a valid place category.');

  const [key, value] = selected.tag;
  const query = `
    [out:json][timeout:25];
    (
      node["${key}"="${value}"](around:2000,${lat},${lon});
      way["${key}"="${value}"](around:2000,${lat},${lon});
      relation["${key}"="${value}"](around:2000,${lat},${lon});
    );
    out center tags;
  `;

  // Vite proxies this local route to the Overpass API.
  const response = await fetch('/api/overpass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ data: query }),
    signal,
  });

  if (!response.ok) {
    const detail = response.status === 429
      ? 'The map data service is busy. Wait a little and try again.'
      : `Nearby-place lookup failed (HTTP ${response.status}).`;
    throw new Error(detail);
  }

  const data = await response.json();
  if (!Array.isArray(data.elements)) {
    throw new Error('The geographic service returned an unexpected response.');
  }

  const unique = new Map();
  for (const element of data.elements) {
    const elementLat = Number(element.lat ?? element.center?.lat);
    const elementLon = Number(element.lon ?? element.center?.lon);
    if (!Number.isFinite(elementLat) || !Number.isFinite(elementLon)) continue;

    const tags = element.tags || {};
    const place = {
      id: `${element.type}-${element.id}`,
      name: tags.name || tags['name:en'] || 'Unnamed mapped place',
      category,
      address: [
        tags['addr:housenumber'],
        tags['addr:street'],
        tags['addr:suburb'] || tags['addr:neighbourhood'],
        tags['addr:city'],
      ].filter(Boolean).join(', ') || 'Address not provided in map data',
      lat: elementLat,
      lon: elementLon,
    };
    unique.set(place.id, place);
  }

  return [...unique.values()];
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const earthRadius = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function render() {
  const places = getFilteredPlaces();
  const selectedCategory = categories.find((item) => item.id === state.category);

  app.innerHTML = `
    <div class="min-h-screen md:flex app-shell">
      <aside id="sidebar" class="sidebar fixed inset-y-0 left-0 z-[1000] flex w-[276px] -translate-x-full flex-col transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0">
        <div class="flex items-center gap-3 border-b border-white/10 px-5 py-5">
          <div class="brand-mark">${icon('compass')}</div>
          <div class="min-w-0">
            <h1 class="text-lg font-bold tracking-tight text-white">Campus Compass</h1>
            <p class="text-xs text-slate-400">A better way to explore</p>
          </div>
          <button id="closeSidebar" class="ml-auto rounded-lg px-2 py-1 text-xl text-slate-400 md:hidden" aria-label="Close navigation">×</button>
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          <p class="section-label mb-3">Explore categories</p>
          <div class="space-y-2">
            ${categories.map((category) => `
              <button class="category-button ${state.category === category.id ? 'category-active' : ''}" data-category="${category.id}">
                <span class="text-lg">${category.icon}</span>
                <span class="flex-1 text-left text-sm font-medium">${category.label}</span>
                ${state.category === category.id ? '<span class="active-dot"></span>' : ''}
              </button>
            `).join('')}
          </div>

          <div class="my-6 border-t border-white/10"></div>
          <div class="mb-3 flex items-center justify-between">
            <p class="section-label">Your collection</p>
            <span class="count-pill">${state.saved.length}</span>
          </div>
          <button id="showSaved" class="nav-button">
            <span class="text-lg">♡</span><span class="flex-1 text-left text-sm">Saved places</span><span class="text-xs">${state.saved.length}</span>
          </button>

          <div class="tip-card mt-7">
            <div class="mb-3 text-2xl text-amber-300">✦</div>
            <h3 class="text-sm font-semibold text-white">Make every trip count</h3>
            <p class="mt-2 text-xs leading-5 text-slate-400">Find useful places around campus and keep your favourites close.</p>
          </div>
        </div>

        <div class="border-t border-white/10 px-5 py-4">
          <p class="text-xs leading-5 text-slate-500">Map data © OpenStreetMap contributors</p>
        </div>
      </aside>

      <div id="sidebarBackdrop" class="fixed inset-0 z-[900] hidden bg-slate-950/60 md:hidden"></div>

      <main class="min-w-0 flex-1">
        <header class="topbar flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-7">
          <div class="flex items-center gap-3">
            <button id="openSidebar" class="mobile-menu rounded-xl px-3 py-2 text-lg md:hidden" aria-label="Open navigation">☰</button>
            <div>
              <p class="section-label">YOUR DISCOVERY SPACE</p>
              <h2 class="mt-1 text-lg font-semibold text-white">Explore nearby</h2>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="hidden text-xs text-slate-400 sm:inline">Powered by OpenStreetMap</span>
            <div class="avatar">CC</div>
          </div>
        </header>

        <div class="mx-auto max-w-[1600px] p-4 sm:p-7 lg:p-9">
          <section class="mb-7">
            <p class="eyebrow">FIND YOUR NEXT FAVOURITE PLACE</p>
            <h2 class="hero-title mt-3 max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              Your campus. <span>Beyond the usual.</span>
            </h2>
            <p class="mt-3 max-w-2xl text-sm leading-6 text-slate-400 sm:text-base">
              Discover libraries, cafés, restaurants, and green spaces near the places that matter to you.
            </p>
          </section>

          <section class="search-panel mb-7 p-4 sm:p-5">
            <form id="searchForm" class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_190px_auto]">
              <div>
                <label for="locationInput" class="field-label mb-2 block">CAMPUS OR LOCATION</label>
                <input id="locationInput" name="location" type="text" value="${escapeHTML(state.query)}" placeholder="e.g. Christ University, Bengaluru" autocomplete="off" required class="field-input w-full" />
              </div>
              <div>
                <label for="categorySelect" class="field-label mb-2 block">PLACE CATEGORY</label>
                <select id="categorySelect" class="field-input w-full">
                  ${categories.map((category) => `<option value="${category.id}" ${state.category === category.id ? 'selected' : ''}>${category.label}</option>`).join('')}
                </select>
              </div>
              <div class="flex items-end">
                <button type="submit" id="searchButton" class="primary-button w-full md:w-auto" ${state.loading ? 'disabled' : ''}>
                  ${state.loading ? '<span class="spinner"></span> Searching' : 'Find places ↗'}
                </button>
              </div>
            </form>
            <p id="statusMessage" role="status" aria-live="polite" class="mt-3 text-sm ${state.messageType === 'error' ? 'text-rose-300' : state.messageType === 'success' ? 'text-emerald-300' : 'text-slate-400'}">${escapeHTML(state.message)}</p>
          </section>

          <section class="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
            <div class="map-panel overflow-hidden">
              <div class="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
                <div>
                  <h3 class="font-semibold text-white">Explore the map</h3>
                  <p class="mt-1 text-xs text-slate-400">Select a marker to inspect a place</p>
                </div>
                <span class="count-pill">${places.length} places</span>
              </div>
              <div id="map" class="h-[350px] sm:h-[460px]"></div>
              <div class="flex flex-wrap items-center gap-4 border-t border-white/10 px-5 py-3 text-xs text-slate-400">
                <span class="flex items-center gap-2"><span class="legend-dot"></span> Places</span>
                <span class="flex items-center gap-2"><span class="legend-dot saved-dot"></span> Saved places</span>
                <span class="ml-auto">Search radius: 2 km</span>
              </div>
            </div>

            <div class="min-w-0">
              <div class="mb-4 flex items-end justify-between gap-3">
                <div>
                  <h3 class="text-lg font-semibold text-white">Discover places</h3>
                  <p class="mt-1 text-xs text-slate-400">${escapeHTML(selectedCategory?.label || 'Places')} ${state.hasSearched ? 'near your search' : 'near Christ University'}</p>
                </div>
                <span class="text-xs text-slate-400">${places.length} results</span>
              </div>

              <div id="results" class="space-y-3">
                ${state.loading ? `
                  <div class="empty-card"><div class="spinner mx-auto mb-3"></div><h4 class="font-semibold text-white">Finding nearby places</h4><p class="mt-2 text-sm text-slate-400">This can take a few seconds.</p></div>
                ` : places.length ? places.map((place) => {
                  const isSaved = state.saved.some((saved) => saved.id === place.id);
                  return `
                    <article class="place-card">
                      <div class="flex gap-4">
                        <div class="place-icon">${selectedCategory?.icon || '⌖'}</div>
                        <div class="min-w-0 flex-1">
                          <h4 class="font-semibold text-white">${escapeHTML(place.name)}</h4>
                          <p class="mt-1 text-xs leading-5 text-slate-400">${escapeHTML(place.address)}</p>
                          ${Number.isFinite(place.distanceKm) ? `<p class="mt-2 text-xs font-semibold text-amber-300">${place.distanceKm.toFixed(2)} km away · straight-line distance</p>` : ''}
                          <div class="mt-4 flex flex-wrap gap-2">
                            <button class="showOnMap secondary-button" data-id="${escapeHTML(place.id)}">View on map</button>
                            <button class="toggleSave ${isSaved ? 'save-active' : 'save-button'}" data-id="${escapeHTML(place.id)}">${isSaved ? '♥ Saved' : '♡ Save place'}</button>
                          </div>
                        </div>
                      </div>
                    </article>`;
                }).join('') : `
                  <div class="empty-card">
                    <div class="mb-3 text-3xl text-slate-500">${state.hasSearched ? '⌕' : '✦'}</div>
                    <h4 class="font-semibold text-white">${state.hasSearched ? 'No matching places found' : 'Ready to explore?'}</h4>
                    <p class="mt-2 text-sm leading-6 text-slate-400">${state.hasSearched ? 'Try another location or category. Some places may not be mapped in OpenStreetMap.' : 'Enter a campus or location above, choose a category, and search to see real mapped results.'}</p>
                  </div>
                `}
              </div>

              <section id="savedSection" class="saved-panel mt-6 p-5">
                <div class="flex items-center justify-between gap-3">
                  <div><h3 class="font-semibold text-white">Your shortlist</h3><p class="mt-1 text-xs text-slate-400">Places you want to revisit</p></div>
                  <span class="count-pill">${state.saved.length} saved</span>
                </div>
                <div class="mt-4 space-y-3">
                  ${state.saved.length ? state.saved.map((place) => `
                    <div class="flex items-center justify-between gap-3">
                      <div class="min-w-0"><p class="truncate text-sm text-slate-200">${escapeHTML(place.name)}</p><p class="mt-1 truncate text-xs text-slate-400">${escapeHTML(place.address)}</p></div>
                      <button class="removeSaved text-xs font-medium text-rose-300 hover:text-rose-200" data-id="${escapeHTML(place.id)}">Remove</button>
                    </div>
                  `).join('') : '<p class="py-2 text-sm text-slate-400">Your saved places will appear here.</p>'}
                </div>
              </section>
            </div>
          </section>

          <footer class="mt-8 border-t border-white/10 pt-5 text-xs leading-5 text-slate-500">
            Map data © <a class="footer-link" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>. Place names and addresses depend on community-mapped data.
          </footer>
        </div>
      </main>
    </div>
  `;

  attachEvents();
  updateMap(places);
}

function initializeMap() {
  const mapElement = document.querySelector('#map');
  if (!mapElement) return;

  map = L.map(mapElement, { zoomControl: true }).setView(
    [state.center.lat, state.center.lon],
    14
  );

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    maxZoom: 19,
  }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
  searchMarkerLayer = L.layerGroup().addTo(map);
}

function updateMap(places) {
  const mapElement = document.querySelector('#map');
  if (!mapElement) return;

  // The dashboard is re-rendered, so safely rebuild the Leaflet instance.
  // Preserve the user's map center and zoom across UI updates.
  let previousView = state.center
    ? { center: [state.center.lat, state.center.lon], zoom: 14 }
    : null;

  if (map) {
    previousView = { center: map.getCenter(), zoom: map.getZoom() };
    map.remove();
    map = null;
    markerLayer = null;
    searchMarkerLayer = null;
  }

  initializeMap();

  if (previousView && map) {
    map.setView(previousView.center, previousView.zoom);
  }

  if (!map || !markerLayer || !searchMarkerLayer) return;
  markerLayer.clearLayers();
  searchMarkerLayer.clearLayers();

  const centerIcon = L.divIcon({
    className: '',
    html: '<div class="center-marker"><span>⌖</span></div>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });

  L.marker([state.center.lat, state.center.lon], { icon: centerIcon })
    .bindPopup(`<strong>Search location</strong><br>${escapeHTML(state.center.name || state.query || 'Selected location')}`)
    .addTo(searchMarkerLayer);

  places.forEach((place) => {
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
    const isSaved = state.saved.some((saved) => saved.id === place.id);
    const markerIcon = L.divIcon({
      className: '',
      html: `<div class="custom-marker ${isSaved ? 'saved' : ''}"><span>⌖</span></div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 35],
    });

    L.marker([place.lat, place.lon], { icon: markerIcon })
      .bindPopup(`<strong>${escapeHTML(place.name)}</strong><br><span>${escapeHTML(place.address)}</span>`)
      .addTo(markerLayer);
  });

  if (state.hasSearched && places.length) {
    const bounds = L.latLngBounds([
      [state.center.lat, state.center.lon],
      ...places.map((place) => [place.lat, place.lon]),
    ]);
    map.fitBounds(bounds.pad(0.18), { maxZoom: 16 });
  }

  setTimeout(() => map?.invalidateSize(), 50);
}

function attachEvents() {
  document.querySelectorAll('.category-button').forEach((button) => {
    button.addEventListener('click', () => {
      state.category = button.dataset.category;
      if (state.hasSearched && state.query) {
        runSearch(state.query, true);
      } else {
        state.places = [];
        render();
      }
    });
  });

  document.querySelector('#categorySelect')?.addEventListener('change', (event) => {
    state.category = event.target.value;
    if (state.hasSearched && state.query) {
      runSearch(state.query, true);
    } else {
      state.places = [];
      render();
    }
  });

  document.querySelector('#searchForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.querySelector('#locationInput');
    const location = input?.value.trim() || '';
    if (!location) {
      setMessage('Please enter a campus or location.', 'error');
      input?.focus();
      return;
    }
    await runSearch(location, false);
  });

  document.querySelectorAll('.toggleSave').forEach((button) => {
    button.addEventListener('click', () => {
      const place = state.places.find((item) => item.id === button.dataset.id);
      if (!place) return;
      const exists = state.saved.some((item) => item.id === place.id);
      state.saved = exists
        ? state.saved.filter((item) => item.id !== place.id)
        : [...state.saved, place];
      savePlaces();
      render();
    });
  });

  document.querySelectorAll('.removeSaved').forEach((button) => {
    button.addEventListener('click', () => {
      state.saved = state.saved.filter((item) => item.id !== button.dataset.id);
      savePlaces();
      render();
    });
  });

  document.querySelectorAll('.showOnMap').forEach((button) => {
    button.addEventListener('click', () => {
      const place = state.places.find((item) => item.id === button.dataset.id);
      if (!place || !map) return;
      map.setView([place.lat, place.lon], 17);
      markerLayer?.eachLayer((marker) => {
        const pos = marker.getLatLng();
        if (Math.abs(pos.lat - place.lat) < 0.000001 && Math.abs(pos.lng - place.lon) < 0.000001) {
          marker.openPopup();
        }
      });
    });
  });

  document.querySelector('#showSaved')?.addEventListener('click', () => {
    document.querySelector('#savedSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.querySelector('#openSidebar')?.addEventListener('click', () => {
    document.querySelector('#sidebar')?.classList.remove('-translate-x-full');
    document.querySelector('#sidebarBackdrop')?.classList.remove('hidden');
  });

  const closeSidebar = () => {
    document.querySelector('#sidebar')?.classList.add('-translate-x-full');
    document.querySelector('#sidebarBackdrop')?.classList.add('hidden');
  };
  document.querySelector('#closeSidebar')?.addEventListener('click', closeSidebar);
  document.querySelector('#sidebarBackdrop')?.addEventListener('click', closeSidebar);
}

async function runSearch(location, categoryOnly) {
  if (requestController) requestController.abort();
  requestController = new AbortController();
  const { signal } = requestController;

  state.loading = true;
  state.query = location;
  state.messageType = 'info';
  state.message = categoryOnly ? 'Updating category results…' : 'Finding your location…';
  render();

  try {
    const center = categoryOnly && state.center
      ? state.center
      : await geocodeLocation(location, signal);

    state.center = center;
    state.message = 'Searching for nearby mapped places…';
    render();

    const places = await fetchNearbyPlaces(center.lat, center.lon, state.category, signal);
    state.places = places.map((place) => ({
      ...place,
      distanceKm: calculateDistance(center.lat, center.lon, place.lat, place.lon),
    }));
    state.hasSearched = true;
    state.messageType = 'success';
    state.message = places.length
      ? `Found ${places.length} mapped ${categories.find((item) => item.id === state.category)?.label.toLowerCase()} within approximately 2 km.`
      : 'No matching mapped places found within 2 km. Try another category or location.';
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Search failed:', error);
    state.places = [];
    state.messageType = 'error';
    state.message = error.message || 'Search failed. Please check your connection and try again.';
  } finally {
    state.loading = false;
    render();
  }
}

render();
