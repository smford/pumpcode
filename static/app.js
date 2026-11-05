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
  const searchInput = document.getElementById('outcode-search');
  const autocompleteList = document.getElementById('autocomplete-list');
  const locateBtn = document.getElementById('locate-btn');
  const freshnessBadge = document.getElementById('freshness-badge');
  const themeToggle = document.getElementById('theme-toggle');
  const statusContainer = document.getElementById('status-container');
  const resultsHeader = document.getElementById('results-header');
  const resultsTitle = document.getElementById('results-title');
  const resultsCount = document.getElementById('results-count');
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

    // Show up to 5 top outcodes as quick buttons
    const sample = outcodes.slice(0, 5);
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
          showStatus('Location permission denied. Please enter your outcode manually.', 'alert-warning');
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
        showStatus(`Located near ${detectedOutcode}. Loading fuel prices...`, 'alert-info');
        await loadOutcode(detectedOutcode);
      } else {
        fallbackToFirstOutcode();
      }
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

    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      const query = e.target.value.trim().toUpperCase();

      if (!query) {
        closeAutocomplete();
        return;
      }

      debounceTimer = setTimeout(() => {
        handleAutocomplete(query);
      }, 180);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const raw = searchInput.value.trim().toUpperCase();
        if (raw) {
          const parsed = parseOutcodeFromInput(raw);
          closeAutocomplete();
          loadOutcode(parsed);
        }
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

    const matches = state.outcodesIndex.outcodes.filter((item) =>
      item.outcode.startsWith(query)
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
  async function loadOutcode(outcode) {
    if (!outcode) return;
    const cleanOutcode = outcode.toUpperCase();
    state.currentOutcode = cleanOutcode;
    searchInput.value = cleanOutcode;

    showStatus(`Fetching prices for district ${cleanOutcode}...`, 'alert-info');

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

      clearStatus();
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

    const brand = document.createElement('span');
    brand.className = 'brand-tag';
    brand.textContent = station.brand || 'Forecourt';

    const name = document.createElement('h3');
    name.className = 'station-name';
    name.textContent = station.name || station.brand;

    const postcode = document.createElement('span');
    postcode.className = 'station-postcode';
    postcode.textContent = station.postcode || '';

    identity.appendChild(brand);
    identity.appendChild(name);
    identity.appendChild(postcode);

    const priceBox = document.createElement('div');
    priceBox.className = 'primary-price-box';

    const priceValue = document.createElement('div');
    priceValue.className = 'price-main';
    priceValue.textContent = currentPrice ? `${currentPrice.toFixed(1)}p` : 'N/A';

    const priceUnit = document.createElement('div');
    priceUnit.className = 'price-unit';
    priceUnit.textContent = `${grade} per litre`;

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
    directionsLink.className = 'btn btn-primary';
    directionsLink.target = '_blank';
    directionsLink.rel = 'noopener noreferrer';

    // Direct link to open navigation in Google Maps / Apple Maps
    directionsLink.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(station.lat)},${encodeURIComponent(station.lon)}`;
    directionsLink.textContent = 'Get Directions';

    actions.appendChild(directionsLink);
    card.appendChild(actions);

    return card;
  }

  function formatAmenityName(raw) {
    return raw.replace(/_/g, ' ');
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
