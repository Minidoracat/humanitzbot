/**
 * Panel Tab: Map — Leaflet interactive map with player markers and world layers.
 * @namespace Panel.tabs.map
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const $$ = Panel.core.$$;
  const el = Panel.core.el;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const entityLink = Panel.core.utils.entityLink;
  var getCssColor = Panel.core.getCssColor;

  let _inited = false;
  let mapWorldLayers = {};

  /**
   * Treat empty and UE4 'None' names as missing so tooltips/popups fall back
   * to a readable label instead of rendering the literal 'None' or blank.
   */
  function _entityName(name, fallback) {
    const n = String(name == null ? '' : name).trim();
    if (!n || /^none$/i.test(n)) return fallback;
    return n;
  }

  function _unknownLabel() {
    return i18next.t('web:map.player_detail.unknown', { defaultValue: 'Unknown' });
  }

  function init() {
    if (_inited) return;
    _inited = true;
    initMap();
    const sel = $('#map-basemap');
    if (sel) {
      applyBasemapLabels(sel);
      sel.value = S.mapBasemap || 'color';
      sel.addEventListener('change', function () {
        setBasemap(this.value);
      });
      if (window.i18next && typeof i18next.on === 'function') {
        i18next.on('languageChanged', function () {
          applyBasemapLabels(sel);
        });
      }
    }
    // Keep the whole map reachable when the window / viewport is resized.
    let resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        fitMapView(false);
      }, 150);
    });

    // Fullscreen toggle (button at the map's top-right). Fullscreens the whole map tab
    // so the filter bar + player list stay usable; re-fits the map on enter/exit.
    const fsBtn = $('#map-fullscreen');
    if (fsBtn) {
      fsBtn.addEventListener('click', function () {
        const target = $('#tab-map');
        if (document.fullscreenElement) {
          if (document.exitFullscreen) document.exitFullscreen();
        } else if (target && target.requestFullscreen) {
          target.requestFullscreen().catch(function () {});
        }
      });
      document.addEventListener('fullscreenchange', function () {
        const inFs = !!document.fullscreenElement;
        fsBtn.innerHTML = '<i data-lucide="' + (inFs ? 'minimize' : 'maximize') + '" class="w-4 h-4"></i>';
        if (window.lucide && typeof lucide.createIcons === 'function') lucide.createIcons();
        setTimeout(function () {
          fitMapView(false);
        }, 120);
      });
    }

    // Legend: collapse toggle + rebuild on language change.
    const legendToggle = $('#map-legend-toggle');
    if (legendToggle) {
      legendToggle.addEventListener('click', function () {
        const lg = $('#map-legend');
        if (!lg) return;
        const collapsed = lg.classList.toggle('collapsed');
        legendToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }
    buildMapLegend();
    if (window.i18next && typeof i18next.on === 'function') i18next.on('languageChanged', buildMapLegend);

    // Mobile player-list drawer toggle (#map-sidebar becomes an off-canvas drawer on phones).
    const drawerBtn = $('#map-drawer-toggle');
    if (drawerBtn) {
      drawerBtn.addEventListener('click', function () {
        const sb = $('#map-sidebar');
        if (sb) sb.classList.toggle('open');
      });
    }
  }

  // ── Map Initialization ──────────────────────────────────────────

  function initMap() {
    if (S.mapReady && S.map) return;
    const container = $('#map-container');
    if (!container || !window.L) return;
    // Destroy existing map instance before creating a new one (e.g. after server switch)
    if (S.map) {
      clearMapWorldLayers();
      for (const id in S.mapMarkers) {
        S.map.removeLayer(S.mapMarkers[id]);
      }
      S.mapMarkers = {};
      S.map.remove();
      S.map = null;
    }
    S.map = L.map(container, {
      crs: L.CRS.Simple,
      minZoom: -5, // safe floor only; fitMapView() sets the real min so the whole map fits any screen
      maxZoom: 3,
      zoomSnap: 0, // smooth zoom so the dynamic fit-to-screen zoom isn't snapped into clipping the map
      zoomDelta: 0.6,
      wheelPxPerZoomLevel: 90,
      zoomControl: true,
      attributionControl: false,
    });
    const bounds = MAP_BOUNDS;
    // Two base layers share the SAME calibration (worldBounds): the colored render
    // (rendered from the live game pak) and the legacy line-art map. Player markers
    // align on both because the colored map is framed to the same world rectangle.
    S.mapBasemaps = {
      color: L.imageOverlay(MAP_COLOR_ASSET, bounds, { className: 'map-color' }),
      lineart: L.imageOverlay('/terrain.png', bounds, { className: 'map-lineart' }),
    };
    if (!S.mapBasemap) {
      let storedBase = null;
      try {
        storedBase = localStorage.getItem('hz_basemap');
      } catch (_e) {
        /* storage unavailable */
      }
      S.mapBasemap = storedBase === 'lineart' ? 'lineart' : 'color';
    }
    S.mapBasemaps[S.mapBasemap].addTo(S.map);
    S.mapReady = true;
    S._mapFitted = false;
    fitMapView(true); // best-effort initial fit; re-run once the container is sized (loadMapData)
  }

  // Content-hashed colored basemap (immutable, cached forever). Bump on re-render.
  const MAP_COLOR_ASSET = '/map_color.ef54d6d6.webp';

  // Whole-map bounds in Leaflet CRS.Simple pixel space (matches the 4096² basemap).
  const MAP_BOUNDS = [
    [0, 0],
    [4096, 4096],
  ];

  /**
   * Fit the entire map to any viewport. Sets the minimum zoom to the zoom that
   * shows the whole map in the current container, so even small / low-resolution
   * screens can zoom all the way out and still see the whole island. Pass
   * refit=true to also recenter on the full map.
   */
  function fitMapView(refit) {
    if (!S.map) return;
    S.map.invalidateSize();
    const size = S.map.getSize();
    if (!size.x || !size.y) return;
    // CRS.Simple: the 4096-unit square map renders at 4096px at zoom 0. Fit the whole
    // map into the smaller container dimension with a 2% margin, so any screen — even
    // small / low-resolution ones — can zoom all the way out and still see the whole island.
    const fitZoom = Math.log2((Math.min(size.x, size.y) * 0.98) / 4096);
    if (!isFinite(fitZoom)) return;
    S.map.setMinZoom(fitZoom);
    if (refit) S.map.setView(L.latLngBounds(MAP_BOUNDS).getCenter(), fitZoom, { animate: false });
  }

  // Legend palette/shapes — MUST mirror the marker styles in updateMapWorldLayers / updateMapMarkers.
  const LEGEND = [
    { key: 'players', color: '#6dba82', shape: 'circle' },
    { key: 'structures', color: '#3b82f6', shape: 'square' },
    { key: 'vehicles', color: '#d4a843', shape: 'square' },
    { key: 'containers', color: '#a855f7', shape: 'circle' },
    { key: 'companions', color: '#ec4899', shape: 'circle' },
    { key: 'zombies', color: '#9b59b6', shape: 'circle' },
    { key: 'animals', color: '#e67e22', shape: 'diamond' },
    { key: 'bandits', color: '#e74c3c', shape: 'square' },
    { key: 'quests', color: '#22d3ee', shape: 'circle' },
  ];

  /** Rebuild the on-map legend, showing only currently-enabled layers. */
  function buildMapLegend() {
    const body = $('#map-legend-body');
    if (!body) return;
    body.innerHTML = '';
    for (let i = 0; i < LEGEND.length; i++) {
      const item = LEGEND[i];
      const cb = $('#map-layer-' + item.key);
      if (cb && !cb.checked) continue;
      const row = el('div', 'map-legend-row');
      row.innerHTML =
        '<span class="map-legend-sw ' +
        item.shape +
        '" style="background:' +
        item.color +
        '"></span>' +
        esc(i18next.t('web:map.' + item.key));
      body.appendChild(row);
    }
  }

  /** Switch the active base layer, preserving player/world overlays. */
  function setBasemap(name) {
    if (!S.map || !S.mapBasemaps || !S.mapBasemaps[name]) return;
    const cur = S.mapBasemap;
    if (cur && cur !== name && S.mapBasemaps[cur]) S.map.removeLayer(S.mapBasemaps[cur]);
    S.mapBasemaps[name].addTo(S.map);
    if (S.mapBasemaps[name].bringToBack) S.mapBasemaps[name].bringToBack();
    S.mapBasemap = name;
    try {
      localStorage.setItem('hz_basemap', name); // remember the choice (like the sidebar collapse)
    } catch (_e) {
      /* storage unavailable */
    }
  }

  /** Localize the basemap <select> option labels. */
  function applyBasemapLabels(sel) {
    for (const o of sel.options) {
      if (o.value === 'color') o.textContent = i18next.t('web:map.layers.color', { defaultValue: 'Color' });
      else if (o.value === 'lineart') o.textContent = i18next.t('web:map.layers.lineart', { defaultValue: 'Line art' });
    }
  }

  // ── Map Data Loading ────────────────────────────────────────────

  async function loadMapData() {
    Panel.core.utils.setTabUnavailable('tab-map', S.currentServer === 'all');
    if (S.currentServer === 'all') return;
    if (S.map) {
      setTimeout(function () {
        // Container is now laid out — fit the whole map (first time) and recompute min zoom.
        fitMapView(!S._mapFitted);
        S._mapFitted = true;
      }, 100);
    }
    try {
      const r = await apiFetch('/api/players');
      if (!r.ok) return;
      const d = await r.json();
      S.players = d.players || [];
      S.toggles = d.toggles || {};
      S.worldBounds = d.worldBounds || null;
      updateMapMarkers();
      updateMapSidebar();

      const wantLayers = [];
      ['structures', 'vehicles', 'containers', 'companions', 'zombies', 'animals', 'bandits', 'quests'].forEach(
        function (l) {
          const cb = $('#map-layer-' + l);
          if (cb && cb.checked) wantLayers.push(l);
        },
      );
      if (wantLayers.length > 0) {
        try {
          const lr = await apiFetch('/api/panel/mapdata?layers=' + wantLayers.join(','));
          if (lr.ok) {
            const ld = await lr.json();
            updateMapWorldLayers(ld, wantLayers);
          }
        } catch (_e) {}
      } else {
        clearMapWorldLayers();
      }
    } catch (e) {
      console.error('Map data error:', e);
    }
  }

  // ── World Layers ────────────────────────────────────────────────

  // Per-layer colored cluster bubbles for world entities. Falls back to a plain layer
  // group if the markercluster plugin failed to load, so the map degrades gracefully.
  const CLUSTER_COLORS = {
    structures: '#3b82f6',
    vehicles: '#d4a843',
    containers: '#a855f7',
    companions: '#ec4899',
    zombies: '#9b59b6',
    animals: '#e67e22',
    bandits: '#e74c3c',
    quests: '#22d3ee',
  };
  function clusterGroup(type) {
    if (!L.markerClusterGroup) return L.layerGroup();
    const color = CLUSTER_COLORS[type] || '#8a8a8a';
    return L.markerClusterGroup({
      maxClusterRadius: 45,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      chunkedLoading: true,
      iconCreateFunction: function (cluster) {
        const n = cluster.getChildCount();
        const size = n < 10 ? 28 : n < 100 ? 34 : 40;
        return L.divIcon({
          html: '<div class="hz-cluster-inner" style="background:' + color + '">' + n + '</div>',
          className: 'hz-cluster',
          iconSize: [size, size],
        });
      },
    });
  }

  function clearMapWorldLayers() {
    for (const k in mapWorldLayers) {
      if (mapWorldLayers[k] && S.map) S.map.removeLayer(mapWorldLayers[k]);
    }
    mapWorldLayers = {};
  }

  function updateMapWorldLayers(data, layers) {
    if (!S.map || !window.L) return;
    clearMapWorldLayers();

    // Cache CSS colors once per call to avoid repeated DOM queries inside loops
    var palette = {
      surface300: getCssColor('surface-300', '#12100e'),
      calm: getCssColor('calm', '#6dba82'),
      horde: getCssColor('horde', '#c45a4a'),
      surge: getCssColor('surge', '#d4a843'),
      muted: getCssColor('muted', '#7a746c'),
      mapZombie: getCssColor('map-zombie', '#9b59b6'),
      mapAnimal: getCssColor('map-animal', '#e67e22'),
      mapBandit: getCssColor('map-bandit', '#e74c3c'),
    };

    if (layers.indexOf('structures') !== -1 && data.structures) {
      mapWorldLayers.structures = clusterGroup('structures');
      data.structures.forEach(function (s) {
        if (s.lat == null) return;
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="width:5px;height:5px;background:#3b82f6;border-radius:1px;border:1px solid ' +
            palette.surface300 +
            '"></div>',
          iconSize: [5, 5],
          iconAnchor: [2.5, 2.5],
        });
        const m = L.marker([s.lat, s.lng], { icon: icon });
        const structureName = _entityName(s.name, i18next.t('web:activity.structure'));
        m.bindTooltip(esc(structureName), { direction: 'top', offset: [0, -4] });
        const ownerName = s.owner && data.nameMap ? data.nameMap[s.owner] || s.owner : _unknownLabel();
        const hpPct = s.maxHealth ? Math.round((s.health / s.maxHealth) * 100) : 0;
        const ownerHtml = s.owner
          ? '<span class="player-link" data-steam-id="' + esc(s.owner) + '">' + esc(ownerName) + '</span>'
          : esc(ownerName);
        const popupHtml =
          '<div class="tl-popup" style="min-width:160px"><b>' +
          entityLink(structureName, 'structure') +
          '</b>' +
          (s.upgrade ? '<br><span style="color:' + palette.muted + '">Level ' + s.upgrade + '</span>' : '') +
          '<br>\u2764\ufe0f ' +
          hpPct +
          '%' +
          '<br>\ud83d\udc64 ' +
          ownerHtml +
          (s.itemCount ? '<br>\ud83d\udce6 ' + s.itemCount + ' items' : '') +
          '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.structures);
      });
      mapWorldLayers.structures.addTo(S.map);
    }

    if (layers.indexOf('vehicles') !== -1 && data.vehicles) {
      mapWorldLayers.vehicles = clusterGroup('vehicles');
      data.vehicles.forEach(function (v) {
        if (v.lat == null) return;
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="width:7px;height:7px;background:' +
            palette.surge +
            ';border-radius:1px;border:1px solid ' +
            palette.surface300 +
            '"></div>',
          iconSize: [7, 7],
          iconAnchor: [3.5, 3.5],
        });
        const m = L.marker([v.lat, v.lng], { icon: icon });
        const vehicleName = _entityName(v.name, i18next.t('web:activity.vehicle'));
        m.bindTooltip(esc(vehicleName), { direction: 'top', offset: [0, -5] });
        const hpPct = v.maxHealth ? Math.round((v.health / v.maxHealth) * 100) : 0;
        const hpColor = hpPct > 60 ? palette.calm : hpPct > 30 ? palette.surge : palette.horde;
        const popupHtml =
          '<div class="tl-popup" style="min-width:160px"><b>' +
          entityLink(vehicleName, 'vehicle') +
          '</b>' +
          '<br><span style="color:' +
          palette.muted +
          '">' +
          i18next.t('web:item_popup.durability') +
          '</span> <span style="color:' +
          hpColor +
          '">' +
          hpPct +
          '%</span>' +
          '<br>\u26fd ' +
          i18next.t('web:dashboard.fuel') +
          ': ' +
          (v.fuel || 0) +
          'L</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.vehicles);
      });
      mapWorldLayers.vehicles.addTo(S.map);
    }

    if (layers.indexOf('containers') !== -1 && data.containers) {
      mapWorldLayers.containers = clusterGroup('containers');
      data.containers.forEach(function (c) {
        if (c.lat == null) return;
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="width:4px;height:4px;background:#a855f7;border-radius:50%;border:1px solid ' +
            palette.surface300 +
            '"></div>',
          iconSize: [4, 4],
          iconAnchor: [2, 2],
        });
        const m = L.marker([c.lat, c.lng], { icon: icon });
        const containerName = _entityName(
          c.name,
          i18next.t('web:location_type.container', { defaultValue: 'Container' }),
        );
        m.bindTooltip(esc(containerName) + ' (' + (c.itemCount || 0) + ')', {
          direction: 'top',
          offset: [0, -4],
        });
        const popupHtml =
          '<div class="tl-popup" style="min-width:140px"><b>' +
          entityLink(containerName, 'container') +
          '</b>' +
          '<br>\ud83d\udce6 ' +
          (c.itemCount || 0) +
          ' items' +
          (c.locked ? '<br>\ud83d\udd12 Locked' : '') +
          '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.containers);
      });
      mapWorldLayers.containers.addTo(S.map);
    }

    if (layers.indexOf('companions') !== -1 && data.companions) {
      mapWorldLayers.companions = clusterGroup('companions');
      data.companions.forEach(function (c) {
        if (c.lat == null) return;
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="width:6px;height:6px;background:#ec4899;border-radius:50%;border:1px solid ' +
            palette.surface300 +
            '"></div>',
          iconSize: [6, 6],
          iconAnchor: [3, 3],
        });
        const m = L.marker([c.lat, c.lng], { icon: icon });
        m.bindTooltip(esc(_entityName(c.type, 'Companion')), { direction: 'top', offset: [0, -4] });
        const ownerName = c.owner && data.nameMap ? data.nameMap[c.owner] || c.owner : _unknownLabel();
        const ownerHtml = c.owner
          ? '<span class="player-link" data-steam-id="' + esc(c.owner) + '">' + esc(ownerName) + '</span>'
          : esc(ownerName);
        const popupHtml =
          '<div class="tl-popup" style="min-width:140px"><b>' +
          entityLink(c.type || 'Companion', 'animal') +
          '</b>' +
          '<br>\ud83d\udc64 ' +
          ownerHtml +
          (c.health != null ? '<br>\u2764\ufe0f ' + Math.round(c.health) : '') +
          '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.companions);
      });
      mapWorldLayers.companions.addTo(S.map);
    }

    if (layers.indexOf('zombies') !== -1 && data.zombies) {
      mapWorldLayers.zombies = clusterGroup('zombies');
      data.zombies.forEach(function (z) {
        if (z.lat == null) return;
        const icon = L.divIcon({
          className: 'timeline-marker',
          html:
            '<div style="width:6px;height:6px;border-radius:50%;background:' +
            palette.mapZombie +
            ';border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px ' +
            palette.mapZombie +
            '60;" title="Zombie"></div>',
          iconSize: [6, 6],
          iconAnchor: [3, 3],
        });
        const m = L.marker([z.lat, z.lng], { icon: icon });
        m.bindTooltip(esc(_entityName(z.name, 'Zombie')), { direction: 'top', offset: [0, -4] });
        m.addTo(mapWorldLayers.zombies);
      });
      mapWorldLayers.zombies.addTo(S.map);
    }

    if (layers.indexOf('animals') !== -1 && data.animals) {
      mapWorldLayers.animals = clusterGroup('animals');
      data.animals.forEach(function (a) {
        if (a.lat == null) return;
        const icon = L.divIcon({
          className: 'timeline-marker',
          html:
            '<div style="width:7px;height:7px;transform:rotate(45deg);border-radius:2px;background:' +
            palette.mapAnimal +
            ';border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px ' +
            palette.mapAnimal +
            '60;" title="Animal"></div>',
          iconSize: [7, 7],
          iconAnchor: [3.5, 3.5],
        });
        const m = L.marker([a.lat, a.lng], { icon: icon });
        m.bindTooltip(esc(_entityName(a.name, 'Animal')), { direction: 'top', offset: [0, -4] });
        m.addTo(mapWorldLayers.animals);
      });
      mapWorldLayers.animals.addTo(S.map);
    }

    if (layers.indexOf('bandits') !== -1 && data.bandits) {
      mapWorldLayers.bandits = clusterGroup('bandits');
      data.bandits.forEach(function (b) {
        if (b.lat == null) return;
        const icon = L.divIcon({
          className: 'timeline-marker',
          html:
            '<div style="width:8px;height:8px;border-radius:2px;background:' +
            palette.mapBandit +
            ';border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px ' +
            palette.mapBandit +
            '60;" title="Bandit"></div>',
          iconSize: [8, 8],
          iconAnchor: [4, 4],
        });
        const m = L.marker([b.lat, b.lng], { icon: icon });
        m.bindTooltip(esc(_entityName(b.name, 'Bandit')), { direction: 'top', offset: [0, -4] });
        m.addTo(mapWorldLayers.bandits);
      });
      mapWorldLayers.bandits.addTo(S.map);
    }

    if (layers.indexOf('quests') !== -1 && data.quests) {
      mapWorldLayers.quests = clusterGroup('quests');
      data.quests.forEach(function (q) {
        if (q.lat == null) return;
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="width:8px;height:8px;background:#22d3ee;border-radius:50%;border:1.5px solid ' +
            palette.surface300 +
            ';box-shadow:0 0 4px #22d3ee60"></div>',
          iconSize: [8, 8],
          iconAnchor: [4, 4],
        });
        const m = L.marker([q.lat, q.lng], { icon: icon });
        const questName = _entityName(q.name, i18next.t('web:map.quest'));
        // One row can carry several quests sharing a transform — show them all
        const entries = Array.isArray(q.entries) && q.entries.length ? q.entries : [{ name: q.name, time: q.time }];
        const extraCount = entries.length > 1 ? ' +' + (entries.length - 1) : '';
        m.bindTooltip(esc(questName) + extraCount, { direction: 'top', offset: [0, -5] });
        let popupHtml = '<div class="tl-popup" style="min-width:160px"><b>' + esc(questName) + '</b>';
        entries.forEach(function (entry, ei) {
          const entryName = ei === 0 ? '' : '<b>' + esc(_entityName(entry.name, i18next.t('web:map.quest'))) + '</b> ';
          if (ei > 0 || entry.time) popupHtml += '<br>' + entryName;
          if (entry.time) {
            popupHtml +=
              '<span style="color:' +
              palette.muted +
              '">' +
              i18next.t('web:map.quest_time') +
              ':</span> ' +
              esc(new Date(entry.time).toLocaleString());
          }
        });
        if (q.itemCount) {
          popupHtml += '<br>📦 ' + esc(i18next.t('web:map.quest_items', { count: q.itemCount }));
        }
        popupHtml += '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.quests);
      });
      mapWorldLayers.quests.addTo(S.map);
    }
  }

  // ── Player Markers ──────────────────────────────────────────────

  function makePlayerIcon(isOnline, colorCalm, colorMuted, colorBorder) {
    const color = isOnline ? colorCalm : colorMuted;
    return L.divIcon({
      className: '',
      html:
        '<div style="width:10px;height:10px;border-radius:50%;background:' +
        color +
        ';border:2px solid ' +
        colorBorder +
        '"></div>',
      iconSize: [10, 10],
      iconAnchor: [5, 5],
    });
  }

  function updateMapMarkers() {
    if (!S.map) return;
    let showOffline = true;
    const offlineChk = $('#map-show-offline');
    if (offlineChk) showOffline = offlineChk.checked;

    // Cache CSS colors once to avoid repeated DOM queries inside the player loop
    var colorCalm = getCssColor('calm', '#6dba82');
    var colorMuted = getCssColor('muted', '#7a746c');
    var colorBorder = getCssColor('surface-300', '#12100e');

    // Players layer toggle (#map-layer-players). Default-on when the checkbox is absent.
    const playersChk = $('#map-layer-players');
    const showPlayers = !playersChk || playersChk.checked;

    // Diff in place: move existing markers, add new ones, drop the gone — instead of
    // tearing down and rebuilding all markers every 15s poll (DOM thrash).
    const seen = {};
    if (showPlayers) {
      for (let i = 0; i < S.players.length; i++) {
        const p = S.players[i];
        if (!p.hasPosition) continue;
        if (!showOffline && !p.isOnline) continue;
        if (p.lat == null || p.lng == null) continue;
        const id = p.steamId;
        seen[id] = true;
        let marker = S.mapMarkers[id];
        if (marker) {
          marker.setLatLng([p.lat, p.lng]);
          if (marker._hzOnline !== p.isOnline) {
            marker.setIcon(makePlayerIcon(p.isOnline, colorCalm, colorMuted, colorBorder));
            marker._hzOnline = p.isOnline;
          }
          if (marker._hzName !== p.name) {
            marker.setTooltipContent(esc(p.name)); // keep tooltip current if the player renamed
            marker._hzName = p.name;
          }
          marker._hzPlayer = p; // keep the click handler's reference current
        } else {
          marker = L.marker([p.lat, p.lng], {
            icon: makePlayerIcon(p.isOnline, colorCalm, colorMuted, colorBorder),
          }).addTo(S.map);
          marker._hzOnline = p.isOnline;
          marker._hzName = p.name;
          marker._hzPlayer = p;
          marker.bindTooltip(esc(p.name), { className: 'leaflet-tooltip-dark', offset: [8, 0] });
          marker.on('click', function () {
            showMapPlayerDetail(marker._hzPlayer);
          });
          S.mapMarkers[id] = marker;
        }
      }
    }
    // Remove markers for players that are gone or now hidden.
    for (const id in S.mapMarkers) {
      if (!seen[id]) {
        S.map.removeLayer(S.mapMarkers[id]);
        delete S.mapMarkers[id];
      }
    }

    const count = S.players.filter(function (p) {
      return p.isOnline;
    }).length;
    const cEl = $('#map-player-count');
    if (cEl) cEl.textContent = count + ' ' + i18next.t('web:map.online');
    buildMapLegend();
  }

  // ── Sidebar ─────────────────────────────────────────────────────

  function updateMapSidebar() {
    const list = $('#map-player-list');
    if (!list) return;
    list.innerHTML = '';
    const sorted = S.players.slice().sort(function (a, b) {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const entry = el('div', 'map-player-entry');
      entry.innerHTML =
        '<span class="status-dot ' +
        (p.isOnline ? 'online' : 'offline') +
        '"></span><span class="mp-name ' +
        (p.isOnline ? 'online' : '') +
        '" data-steam-id="' +
        esc(p.steamId || '') +
        '">' +
        esc(p.name) +
        '</span>';
      (function (player) {
        entry.addEventListener('click', function () {
          if (player.hasPosition && player.lat != null && S.map) S.map.setView([player.lat, player.lng], 1);
          showMapPlayerDetail(player);
          // Close the mobile drawer after picking a player.
          const sb = $('#map-sidebar');
          if (sb) sb.classList.remove('open');
        });
      })(p);
      list.appendChild(entry);
    }
    // Re-apply the active search filter so the 15s poll / refresh rebuild doesn't wipe it.
    filterMapPlayers();
  }

  function filterMapPlayers() {
    const q = ($('#map-search') ? $('#map-search').value : '').toLowerCase();
    $$('.map-player-entry', $('#map-player-list')).forEach(function (entry) {
      const name = entry.querySelector('.mp-name');
      const text = name ? name.textContent.toLowerCase() : '';
      entry.style.display = text.includes(q) ? '' : 'none';
    });
  }

  // ── Snapshot Refresh ────────────────────────────────────────────

  async function refreshMapSnapshot() {
    const btn = $('#map-refresh-btn');
    if (!btn) return;
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader" class="w-3 h-3 animate-spin"></i> Saving…';
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
    btn.disabled = true;
    try {
      const r = await (typeof authFetch === 'function' ? authFetch : apiFetch)('/api/panel/refresh-snapshot', {
        method: 'POST',
      });
      if (r.ok) {
        btn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i> Done';
        if (window.lucide) lucide.createIcons({ nodes: [btn] });
        setTimeout(function () {
          loadMapData();
          btn.innerHTML = origHTML;
          if (window.lucide) lucide.createIcons({ nodes: [btn] });
          btn.disabled = false;
        }, 1000);
      } else {
        const d = await r.json().catch(function () {
          return {};
        });
        btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i> ' + (d.error || 'Failed');
        if (window.lucide) lucide.createIcons({ nodes: [btn] });
        setTimeout(function () {
          btn.innerHTML = origHTML;
          if (window.lucide) lucide.createIcons({ nodes: [btn] });
          btn.disabled = false;
        }, 3000);
      }
    } catch (_e) {
      btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i> Error';
      if (window.lucide) lucide.createIcons({ nodes: [btn] });
      setTimeout(function () {
        btn.innerHTML = origHTML;
        if (window.lucide) lucide.createIcons({ nodes: [btn] });
        btn.disabled = false;
      }, 3000);
    }
  }

  function showMapPlayerDetail(p) {
    const panel = $('#map-player-detail');
    const content = $('#map-detail-content');
    if (!panel || !content) return;
    // buildPlayerDetail is on Panel.tabs.players (or fallback to Panel._internal)
    const buildFn =
      (Panel.tabs.players && Panel.tabs.players.buildPlayerDetail) || Panel._internal.buildPlayerDetail || null;
    if (buildFn) {
      content.innerHTML = buildFn(p);
      content.dataset.steamId = p.steamId || '';
      panel.classList.remove('hidden');
    }
  }

  function reset() {
    _inited = false;
    clearMapWorldLayers();
    if (S.map) {
      for (const id in S.mapMarkers) {
        S.map.removeLayer(S.mapMarkers[id]);
      }
      S.mapMarkers = {};
      S.map.remove();
      S.map = null;
    }
    S.mapReady = false;
  }

  Panel.tabs.map = {
    init: init,
    load: loadMapData,
    reset: reset,
    filterPlayers: filterMapPlayers,
    refreshSnapshot: refreshMapSnapshot,
    showPlayerDetail: showMapPlayerDetail,
    updateMarkers: updateMapMarkers,
  };
})();
