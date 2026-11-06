/**
 * PumpCode - Client-side Fuel Price Tracker
 * Pure Vanilla JavaScript (Zero build step, zero dependencies)
 */

(function () {
  'use strict';

  // Application State
  const state = {
    selectedGrade: 'E10',
    currentOutcode: null,
    outcodesIndex: null,
    currentPayload: null,
    userCoords: null,
    stations: []
  };

  // DOM Elements
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('outcode-search');
  const searchBtn = document.getElementById('search-btn');
  const autocompleteList = document.getElementById('autocomplete-list');
  const locateBtn = document.getElementById('locate-btn');
  const freshnessBadge = document.getElementById('freshness-badge');
  const themeToggle = document.getElementById('theme-toggle');
  const statusContainer = document.getElementById('status-container');
  const resultsHeader = document.getElementById('results-header');
  const resultsTitle = document.getElementById('results-title');
  const resultsCount = document.getElementById('results-count');
  const resultsSummary = document.getElementById('results-summary');
  const stationsGrid = document.getElementById('stations-grid');
  const quickOutcodesContainer = document.getElementById('quick-outcodes');
  const gradeRadios = document.querySelectorAll('input[name="fuel-grade"]');

  // Initialize Application
  init();

  async function init() {
    setupThemeToggle();
    setupGradeSelector();
    setupSearch();
    setupGeolocation();

    // Fetch master index file
    await loadIndex();

    // Attempt geolocation on initial page load
    requestGeolocation();
  }

  // --- Theme Management ---
  function setupThemeToggle() {
    const metaColorScheme = document.querySelector('meta[name="color-scheme"]');

    themeToggle.addEventListener('click', () => {
      const currentResolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      const activeMeta = metaColorScheme.getAttribute('content');
      const isCurrentlyDark = activeMeta === 'dark' || (activeMeta === 'light dark' && currentResolved === 'dark');

      const nextTheme = isCurrentlyDark ? 'light' : 'dark';

      // If user toggles to match their OS preference, clear explicit override
      if (nextTheme === currentResolved) {
        metaColorScheme.setAttribute('content', 'light dark');
        try {
          localStorage.removeItem('pumpcode-theme');
        } catch (_) {}
      } else {
        metaColorScheme.setAttribute('content', nextTheme);
        try {
          localStorage.setItem('pumpcode-theme', nextTheme);
        } catch (_) {}
      }
    });

    // Listen to OS theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      // Re-evaluate if needed
    });
  }

  // --- Grade Selector ---
  function setupGradeSelector() {
    gradeRadios.forEach((radio) => {
      radio.addEventListener('change', (e) => {
        state.selectedGrade = e.target.value;
        if (state.stations.length > 0) {
          renderStations();
        }
      });
    });
  }

  // --- Master Index Loader ---
  async function loadIndex() {
    try {
      const res = await fetch('data/outcodes/index.json');
      if (!res.ok) {
        throw new Error(`Failed to load index: ${res.status}`);
      }
      state.outcodesIndex = await res.json();
      updateFreshnessBadge(state.outcodesIndex.updated_at);
      renderQuickOutcodes(state.outcodesIndex.outcodes);
    } catch (err) {
      console.warn('Index load error:', err);
      freshnessBadge.textContent = 'Data offline';
    }
  }

  function renderQuickOutcodes(outcodes) {
    if (!outcodes || !outcodes.length) return;
    quickOutcodesContainer.innerHTML = '';

    // Show up to 8 top outcodes as quick buttons
    const sample = outcodes.slice(0, 8);
    sample.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-btn';
      btn.textContent = item.outcode;
      btn.title = `${item.station_count} stations in ${item.outcode}`;
      btn.addEventListener('click', () => {
        loadOutcode(item.outcode);
      });
      quickOutcodesContainer.appendChild(btn);
    });
  }

  // --- Geolocation ---
  function setupGeolocation() {
    locateBtn.addEventListener('click', () => {
      requestGeolocation(true);
    });
  }

  function requestGeolocation(manualTrigger = false) {
    if (!('geolocation' in navigator)) {
      if (manualTrigger) {
        showStatus('Geolocation is not supported by your browser.', 'alert-warning');
      }
      fallbackToFirstOutcode();
      return;
    }

    showStatus('Locating nearby forecourts...', 'alert-info');

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        state.userCoords = { lat: latitude, lon: longitude };
        await resolveOutcodeFromCoordinates(latitude, longitude);
      },
      (err) => {
        console.warn('Geolocation error:', err.message);
        clearStatus();
        if (manualTrigger) {
          showStatus('Location permission denied. Please enter your outcode or postcode manually.', 'alert-warning');
        }
        fallbackToFirstOutcode();
      },
      { timeout: 8000, maximumAge: 300000 }
    );
  }

  async function resolveOutcodeFromCoordinates(lat, lon) {
    try {
      const res = await fetch(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}`);
      if (!res.ok) throw new Error('Postcodes.io request failed');
      const data = await res.json();

      if (data.result && data.result.length > 0 && data.result[0].outcode) {
        const detectedOutcode = data.result[0].outcode.toUpperCase();
        const exists = state.outcodesIndex && state.outcodesIndex.outcodes && state.outcodesIndex.outcodes.some((item) => item.outcode === detectedOutcode);
        if (exists) {
          showStatus(`Located near ${detectedOutcode}. Loading fuel prices...`, 'alert-info');
          await loadOutcode(detectedOutcode);
          return;
        }
      }
      // If direct outcode has no station or lookup was inconclusive, find nearest with stations
      await findAndLoadNearestOutcode(lat, lon, 'your location');
    } catch (err) {
      console.warn('Coordinate resolution failed:', err);
      fallbackToFirstOutcode();
    }
  }

  function fallbackToFirstOutcode() {
    if (state.currentOutcode) return;
    if (state.outcodesIndex && state.outcodesIndex.outcodes.length > 0) {
      // Pick first available outcode as initial view
      loadOutcode(state.outcodesIndex.outcodes[0].outcode);
    }
  }

  // --- Search and Autocomplete ---
  function setupSearch() {
    let debounceTimer;

    if (searchForm) {
      searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        performSearch();
      });
    }

    if (searchBtn) {
      searchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        performSearch();
      });
    }

    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      const query = e.target.value.trim().toUpperCase();

      if (!query) {
        closeAutocomplete();
        return;
      }

      debounceTimer = setTimeout(() => {
        handleAutocomplete(query);
      }, 160);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        closeAutocomplete();
        performSearch();
      } else if (e.key === 'Escape') {
        closeAutocomplete();
      }
    });

    // Close autocomplete on click outside
    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !autocompleteList.contains(e.target)) {
        closeAutocomplete();
      }
    });
  }

  async function performSearch(rawInput) {
    const raw = (rawInput || searchInput.value || '').trim().toUpperCase();
    if (!raw) return;

    closeAutocomplete();
    const candidateOutcode = parseOutcodeFromInput(raw);

    // Direct match against indexed outcodes
    const exists = state.outcodesIndex && state.outcodesIndex.outcodes && state.outcodesIndex.outcodes.some((item) => item.outcode === candidateOutcode);

    if (exists) {
      await loadOutcode(candidateOutcode);
      return;
    }

    // Attempt lookup via postcodes.io for full postcode or missing outcode
    showStatus(`Looking up postcode "${raw}"...`, 'alert-info');
    const resolved = await resolvePostcodeOrNearest(raw, candidateOutcode);
    if (!resolved) {
      showStatus(`No filling stations found for "${raw}". Try entering a nearby town or district.`, 'alert-warning');
    }
  }

  async function resolvePostcodeOrNearest(query, fallbackOutcode) {
    try {
      const cleanPostcode = encodeURIComponent(query.replace(/[^A-Za-z0-9]/g, ''));
      const res = await fetch(`https://api.postcodes.io/postcodes/${cleanPostcode}`);

      if (res.ok) {
        const data = await res.json();
        if (data.result) {
          const { latitude, longitude, outcode } = data.result;
          state.userCoords = { lat: latitude, lon: longitude };

          const exists = state.outcodesIndex && state.outcodesIndex.outcodes && state.outcodesIndex.outcodes.some((item) => item.outcode === outcode);
          if (exists) {
            await loadOutcode(outcode);
            return true;
          }
          return await findAndLoadNearestOutcode(latitude, longitude, outcode);
        }
      }

      // Try looking up outcode directly
      const outcodeRes = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(fallbackOutcode)}`);
      if (outcodeRes.ok) {
        const outData = await outcodeRes.json();
        if (outData.result && outData.result.latitude) {
          return await findAndLoadNearestOutcode(outData.result.latitude, outData.result.longitude, fallbackOutcode);
        }
      }

      return false;
    } catch (err) {
      console.warn('Postcode resolution error:', err);
      return false;
    }
  }

  async function findAndLoadNearestOutcode(lat, lon, originalDistrict) {
    if (!state.outcodesIndex || !state.outcodesIndex.outcodes || state.outcodesIndex.outcodes.length === 0) {
      return false;
    }

    let nearest = null;
    let minDistance = Infinity;

    for (const item of state.outcodesIndex.outcodes) {
      if (!item.lat || !item.lon) continue;
      const d = calculateDistanceMiles(lat, lon, item.lat, item.lon);
      if (d < minDistance) {
        minDistance = d;
        nearest = item;
      }
    }

    if (!nearest) return false;

    showStatus(
      `No forecourts recorded directly in ${originalDistrict}. Showing nearest stations in ${nearest.outcode} (${minDistance.toFixed(1)} miles away).`,
      'alert-info'
    );
    await loadOutcode(nearest.outcode, true);
    return true;
  }

  function calculateDistanceMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function parseOutcodeFromInput(input) {
    const cleaned = input.trim().toUpperCase();
    const parts = cleaned.split(/\s+/);
    if (parts.length >= 2) {
      return parts[0];
    }
    const compact = cleaned.replace(/\s+/g, '');
    if (compact.length > 3) {
      return compact.slice(0, compact.length - 3);
    }
    return compact;
  }

  function handleAutocomplete(query) {
    if (!state.outcodesIndex || !state.outcodesIndex.outcodes) {
      closeAutocomplete();
      return;
    }

    const candidate = parseOutcodeFromInput(query);
    const matches = state.outcodesIndex.outcodes.filter((item) =>
      item.outcode === candidate || item.outcode.startsWith(candidate) || item.outcode.startsWith(query)
    );

    if (matches.length === 0) {
      closeAutocomplete();
      return;
    }

    autocompleteList.innerHTML = '';
    matches.slice(0, 8).forEach((item) => {
      const option = document.createElement('div');
      option.className = 'autocomplete-item';
      option.setAttribute('role', 'option');

      const outcodeSpan = document.createElement('span');
      outcodeSpan.className = 'ac-outcode';
      outcodeSpan.textContent = item.outcode;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'ac-meta';
      const minE10 = item.min_prices && item.min_prices.E10 ? `${item.min_prices.E10.toFixed(1)}p` : '';
      metaSpan.textContent = `${item.station_count} station${item.station_count > 1 ? 's' : ''}${minE10 ? ' | from ' + minE10 : ''}`;

      option.appendChild(outcodeSpan);
      option.appendChild(metaSpan);

      option.addEventListener('click', () => {
        searchInput.value = item.outcode;
        closeAutocomplete();
        loadOutcode(item.outcode);
      });

      autocompleteList.appendChild(option);
    });

    autocompleteList.hidden = false;
  }

  function closeAutocomplete() {
    autocompleteList.hidden = true;
    autocompleteList.innerHTML = '';
  }

  // --- Outcode Data Loader ---
  async function loadOutcode(outcode, keepStatus = false) {
    if (!outcode) return;
    const cleanOutcode = outcode.toUpperCase();
    state.currentOutcode = cleanOutcode;
    searchInput.value = cleanOutcode;

    if (!keepStatus) {
      showStatus(`Fetching prices for district ${cleanOutcode}...`, 'alert-info');
    }

    try {
      const res = await fetch(`data/outcodes/${cleanOutcode}.json`);
      if (!res.ok) {
        if (res.status === 404) {
          showStatus(`No filling station data recorded yet for district "${cleanOutcode}".`, 'alert-warning');
          stationsGrid.innerHTML = '';
          resultsHeader.hidden = true;
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = await res.json();
      state.currentPayload = payload;
      state.stations = payload.stations || [];

      if (!keepStatus) {
        clearStatus();
      }
      updateFreshnessBadge(payload.updated_at);
      renderStations();
    } catch (err) {
      console.error('Failed to load outcode data:', err);
      showStatus(`Could not load price data for "${cleanOutcode}".`, 'alert-warning');
    }
  }

  // --- Rendering Stations ---
  function renderStations() {
    const grade = state.selectedGrade;
    const outcode = state.currentOutcode;

    // Filter stations that have a price for this grade, or sort them with priced ones first
    const stationsWithPrices = [...state.stations].sort((a, b) => {
      const priceA = a.prices && a.prices[grade] ? a.prices[grade] : 999999;
      const priceB = b.prices && b.prices[grade] ? b.prices[grade] : 999999;
      return priceA - priceB;
    });

    resultsHeader.hidden = false;
    resultsTitle.textContent = `Forecourts in ${outcode}`;
    resultsCount.textContent = `${stationsWithPrices.length} forecourt${stationsWithPrices.length === 1 ? '' : 's'}`;

    // Calculate Price Statistics for Summary Bar
    if (resultsSummary) {
      resultsSummary.innerHTML = '';
      const pricedOnly = stationsWithPrices.filter((s) => s.prices && s.prices[grade] && s.prices[grade] > 0);

      if (pricedOnly.length > 0) {
        const lowest = pricedOnly[0].prices[grade];
        const highest = pricedOnly[pricedOnly.length - 1].prices[grade];
        const sum = pricedOnly.reduce((acc, s) => acc + s.prices[grade], 0);
        const avg = sum / pricedOnly.length;
        const spread = highest - lowest;

        const lowPill = document.createElement('span');
        lowPill.className = 'summary-pill summary-pill-highlight';
        lowPill.textContent = `Lowest: ${lowest.toFixed(1)}p`;
        resultsSummary.appendChild(lowPill);

        const avgPill = document.createElement('span');
        avgPill.className = 'summary-pill';
        avgPill.textContent = `Average: ${avg.toFixed(1)}p`;
        resultsSummary.appendChild(avgPill);

        if (pricedOnly.length > 1 && spread > 0) {
          const spreadPill = document.createElement('span');
          spreadPill.className = 'summary-pill';
          spreadPill.textContent = `Spread: ${spread.toFixed(1)}p`;
          resultsSummary.appendChild(spreadPill);
        }
      }
    }

    stationsGrid.innerHTML = '';

    if (stationsWithPrices.length === 0) {
      stationsGrid.innerHTML = `
        <div class="alert alert-warning" style="grid-column: 1 / -1;">
          No forecourts found in ${outcode}.
        </div>
      `;
      return;
    }

    // Determine the lowest price for the currently selected fuel grade
    let lowestPrice = Infinity;
    stationsWithPrices.forEach((s) => {
      if (s.prices && s.prices[grade] && s.prices[grade] < lowestPrice) {
        lowestPrice = s.prices[grade];
      }
    });

    stationsWithPrices.forEach((station) => {
      const card = createStationCard(station, grade, lowestPrice);
      stationsGrid.appendChild(card);
    });
  }

  function createStationCard(station, grade, lowestPrice) {
    const card = document.createElement('article');
    card.className = 'station-card';

    const currentPrice = station.prices && station.prices[grade];
    const isCheapest = currentPrice && currentPrice === lowestPrice;

    if (isCheapest) {
      card.classList.add('is-cheapest');
      const badge = document.createElement('div');
      badge.className = 'cheapest-badge';
      badge.textContent = 'Cheapest Nearby';
      card.appendChild(badge);
    }

    // Top section: Identity & Price
    const cardTop = document.createElement('div');
    cardTop.className = 'card-top';

    const identity = document.createElement('div');
    identity.className = 'station-identity';

    const brandName = station.brand || 'Forecourt';
    const brandBadge = document.createElement('span');
    const brandSlug = brandName.toLowerCase().replace(/[^a-z]/g, '');
    brandBadge.className = `brand-badge brand-${brandSlug}`;
    brandBadge.textContent = brandName;

    const name = document.createElement('h3');
    name.className = 'station-name';
    name.textContent = station.name || brandName;

    const metaRow = document.createElement('div');
    metaRow.className = 'station-meta-row';

    const postcode = document.createElement('span');
    postcode.className = 'station-postcode';
    postcode.textContent = station.postcode || '';
    metaRow.appendChild(postcode);

    // Compute approximate distance if user coordinates are known
    if (state.userCoords && station.lat && station.lon) {
      const distMiles = calculateDistanceMiles(state.userCoords.lat, state.userCoords.lon, station.lat, station.lon);
      const distBadge = document.createElement('span');
      distBadge.className = 'station-distance';
      distBadge.textContent = `${distMiles.toFixed(1)} mi away`;
      metaRow.appendChild(distBadge);
    }

    identity.appendChild(brandBadge);
    identity.appendChild(name);
    identity.appendChild(metaRow);

    const priceBox = document.createElement('div');
    priceBox.className = 'primary-price-box';

    const priceValue = document.createElement('div');
    priceValue.className = 'price-main';
    priceValue.textContent = currentPrice ? `${currentPrice.toFixed(1)}p` : 'N/A';

    const priceUnit = document.createElement('div');
    priceUnit.className = 'price-unit';
    priceUnit.textContent = `${grade} / L`;

    priceBox.appendChild(priceValue);
    priceBox.appendChild(priceUnit);

    cardTop.appendChild(identity);
    cardTop.appendChild(priceBox);
    card.appendChild(cardTop);

    // Other Fuel Grades
    if (station.prices) {
      const otherPrices = document.createElement('div');
      otherPrices.className = 'other-prices';

      const gradesList = Object.keys(station.prices).filter((k) => k !== grade);
      gradesList.forEach((k) => {
        const pill = document.createElement('span');
        pill.className = 'other-price-pill';
        pill.textContent = `${k}: ${station.prices[k].toFixed(1)}p`;
        otherPrices.appendChild(pill);
      });

      if (gradesList.length > 0) {
        card.appendChild(otherPrices);
      }
    }

    // Amenities
    if (station.amenities && station.amenities.length > 0) {
      const amenitiesContainer = document.createElement('div');
      amenitiesContainer.className = 'amenities-list';

      station.amenities.forEach((amenity) => {
        const tag = document.createElement('span');
        tag.className = 'amenity-tag';
        tag.textContent = formatAmenityName(amenity);
        amenitiesContainer.appendChild(tag);
      });

      card.appendChild(amenitiesContainer);
    }

    // Navigation Action
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const directionsLink = document.createElement('a');
    directionsLink.className = 'btn btn-primary btn-directions';
    directionsLink.target = '_blank';
    directionsLink.rel = 'noopener noreferrer';

    // Direct link to open navigation in Google Maps / Apple Maps
    directionsLink.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(station.lat)},${encodeURIComponent(station.lon)}`;
    directionsLink.innerHTML = `
      <span>Get Directions</span>
      <svg class="directions-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="5" y1="12" x2="19" y2="12"></line>
        <polyline points="12 5 19 12 12 19"></polyline>
      </svg>
    `;

    actions.appendChild(directionsLink);
    card.appendChild(actions);

    return card;
  }

  function formatAmenityName(raw) {
    const map = {
      car_wash: 'Car Wash',
      air_water: 'Air & Water',
      shop: 'Convenience Store',
      pay_at_pump: 'Pay at Pump',
      atm: 'ATM',
      costa_coffee: 'Coffee',
      deli: 'Deli',
      mands_food: 'M&S Food'
    };
    return map[raw] || raw.replace(/_/g, ' ');
  }

  // --- Freshness & Time Helpers ---
  function updateFreshnessBadge(isoString) {
    if (!isoString) return;
    const date = new Date(isoString);
    const relative = getRelativeTime(date);
    freshnessBadge.textContent = `Updated ${relative}`;
    freshnessBadge.classList.add('badge-fresh');
    freshnessBadge.title = `Last synced at: ${date.toLocaleString()}`;
  }

  function getRelativeTime(date) {
    const now = new Date();
    const diffSeconds = Math.floor((now - date) / 1000);

    if (diffSeconds < 60) return 'just now';
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  // --- UI Helpers ---
  function showStatus(message, className = 'alert-info') {
    statusContainer.innerHTML = `
      <div class="alert ${className}">
        <span>${escapeHTML(message)}</span>
      </div>
    `;
  }

  function clearStatus() {
    statusContainer.innerHTML = '';
  }

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, (tag) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }
})();
