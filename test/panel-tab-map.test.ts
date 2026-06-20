/**
 * Unit tests for panel-tab-map.js `updateMapMarkers()` — the in-place player
 * marker diffing that replaced tear-down-and-rebuild on every 15s poll.
 *
 * The browser file is loaded into a vm sandbox with a mocked Leaflet (`L`) and
 * `Panel.core`, then we drive `Panel.tabs.map.updateMarkers()` across polls and
 * assert markers are reused (moved/re-iconed/re-tooltipped) rather than recreated,
 * and that gone/hidden players are removed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

interface FakeMarker {
  latlng: [number, number];
  icon: unknown;
  tooltip: string | null;
  removed: boolean;
  onMap: boolean;
  setLatLngCalls: number;
  setIconCalls: number;
  setTooltipCalls: number;
  _hzOnline?: boolean;
  _hzName?: string;
  _hzPlayer?: unknown;
  setLatLng(ll: [number, number]): void;
  setIcon(icon: unknown): void;
  setTooltipContent(s: string): void;
  bindTooltip(): FakeMarker;
  on(): FakeMarker;
  addTo(): FakeMarker;
}

function loadMapTab() {
  const created: FakeMarker[] = [];
  const added: FakeMarker[] = [];
  const removed: FakeMarker[] = [];
  const elements = new Map<string, { checked?: boolean; textContent?: string }>();

  const map = {
    removeLayer(m: FakeMarker) {
      m.removed = true;
      m.onMap = false;
      removed.push(m);
    },
    setView() {},
    invalidateSize() {},
    getSize: () => ({ x: 800, y: 600 }),
    setMinZoom() {},
  };

  const S: Record<string, any> = { map, players: [], mapMarkers: {} };

  const L = {
    marker(latlng: [number, number]): FakeMarker {
      const m: FakeMarker = {
        latlng,
        icon: null,
        tooltip: null,
        removed: false,
        onMap: false,
        setLatLngCalls: 0,
        setIconCalls: 0,
        setTooltipCalls: 0,
        setLatLng(ll) {
          this.latlng = ll;
          this.setLatLngCalls++;
        },
        setIcon(icon) {
          this.icon = icon;
          this.setIconCalls++;
        },
        setTooltipContent(s) {
          this.tooltip = s;
          this.setTooltipCalls++;
        },
        bindTooltip() {
          return this;
        },
        on() {
          return this;
        },
        addTo() {
          this.onMap = true;
          added.push(this);
          return this;
        },
      };
      created.push(m);
      return m;
    },
    divIcon(opts: unknown) {
      return { _icon: opts };
    },
  };

  const context: Record<string, any> = {
    console,
    L,
    i18next: { t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || key },
  };
  context.window = context;
  context.Panel = {
    core: {
      S,
      MAP_COLOR_BASEMAP: '/map_color.test.webp',
      $: (sel: string) => (sel.startsWith('#') ? elements.get(sel.slice(1)) || null : null),
      $$: () => [],
      el: () => ({ appendChild: () => undefined, innerHTML: '' }),
      esc: (v: unknown) => String(v),
      apiFetch: () => Promise.resolve({ ok: false }),
      getCssColor: (_name: string, fallback: string) => fallback || '#000',
      utils: { entityLink: (name: string) => name },
    },
    tabs: {},
  };

  vm.runInNewContext(readFileSync('src/web-map/public/js/panel-tab-map.js', 'utf8'), context, {
    filename: 'panel-tab-map.js',
  });

  return { mapTab: context.Panel.tabs.map, S, created, added, removed, elements };
}

function player(over: Record<string, any> = {}) {
  return {
    steamId: 's1',
    name: 'Alice',
    isOnline: true,
    hasPosition: true,
    lat: 100,
    lng: 200,
    ...over,
  };
}

describe('panel map tab — updateMapMarkers diffing', () => {
  it('creates one marker per positioned player', () => {
    const { mapTab, S, created } = loadMapTab();
    S.players = [player(), player({ steamId: 's2', name: 'Bob', lat: 300, lng: 400 })];
    mapTab.updateMarkers();
    assert.equal(created.length, 2);
    assert.ok(S.mapMarkers.s1 && S.mapMarkers.s2);
    assert.equal(S.mapMarkers.s1.onMap, true, 'new marker is added to the map');
    assert.equal(S.mapMarkers.s1.latlng[0], 100);
    assert.equal(S.mapMarkers.s1.latlng[1], 200);
    assert.equal(S.mapMarkers.s1._hzOnline, true);
    assert.equal(S.mapMarkers.s1._hzName, 'Alice');
  });

  it('skips players without a usable position', () => {
    const { mapTab, S, created } = loadMapTab();
    S.players = [
      player({ steamId: 's1', hasPosition: false }),
      player({ steamId: 's2', lat: null }),
      player({ steamId: 's3', lng: null }),
      player({ steamId: 's4', lat: 1, lng: 2 }),
    ];
    mapTab.updateMarkers();
    assert.equal(created.length, 1);
    assert.ok(S.mapMarkers.s4 && !S.mapMarkers.s1 && !S.mapMarkers.s2 && !S.mapMarkers.s3);
  });

  it('reuses the same marker on the next poll instead of recreating it', () => {
    const { mapTab, S, created } = loadMapTab();
    S.players = [player()];
    mapTab.updateMarkers();
    const first = S.mapMarkers.s1;
    // next poll: player moved
    S.players = [player({ lat: 555, lng: 666 })];
    mapTab.updateMarkers();
    assert.equal(created.length, 1, 'no new marker created');
    assert.equal(S.mapMarkers.s1, first, 'same marker object reused');
    assert.equal(first.setLatLngCalls, 1, 'moved via setLatLng');
    assert.equal(first.latlng[0], 555);
    assert.equal(first.latlng[1], 666);
  });

  it('re-icons only when online status changes', () => {
    const { mapTab, S } = loadMapTab();
    S.players = [player({ isOnline: true })];
    mapTab.updateMarkers();
    const m = S.mapMarkers.s1;
    // same status -> no re-icon
    S.players = [player({ isOnline: true, lat: 101 })];
    mapTab.updateMarkers();
    assert.equal(m.setIconCalls, 0);
    // status flip -> re-icon
    S.players = [player({ isOnline: false, lat: 101 })];
    mapTab.updateMarkers();
    assert.equal(m.setIconCalls, 1);
    assert.equal(m._hzOnline, false);
  });

  it('re-tooltips only when the player name changes', () => {
    const { mapTab, S } = loadMapTab();
    S.players = [player({ name: 'Alice' })];
    mapTab.updateMarkers();
    const m = S.mapMarkers.s1;
    S.players = [player({ name: 'Alice', lat: 101 })];
    mapTab.updateMarkers();
    assert.equal(m.setTooltipCalls, 0);
    S.players = [player({ name: 'Alice2', lat: 101 })];
    mapTab.updateMarkers();
    assert.equal(m.setTooltipCalls, 1);
    assert.equal(m._hzName, 'Alice2');
    assert.equal(m.tooltip, 'Alice2');
  });

  it('removes markers for players that disappear from the roster', () => {
    const { mapTab, S, removed } = loadMapTab();
    S.players = [player(), player({ steamId: 's2', name: 'Bob', lat: 1, lng: 2 })];
    mapTab.updateMarkers();
    const bob = S.mapMarkers.s2;
    S.players = [player()]; // Bob gone
    mapTab.updateMarkers();
    assert.ok(!S.mapMarkers.s2, 'gone player dropped from mapMarkers');
    assert.equal(bob.removed, true, 'gone marker removed from the map');
    assert.ok(removed.includes(bob));
  });

  it('hides offline players when "show offline" is unchecked', () => {
    const { mapTab, S, elements } = loadMapTab();
    elements.set('map-show-offline', { checked: false });
    S.players = [player({ steamId: 's1', isOnline: true }), player({ steamId: 's2', isOnline: false, lat: 1, lng: 2 })];
    mapTab.updateMarkers();
    assert.ok(S.mapMarkers.s1, 'online kept');
    assert.ok(!S.mapMarkers.s2, 'offline hidden');
  });

  it('removes all player markers when the players layer is toggled off', () => {
    const { mapTab, S, elements } = loadMapTab();
    S.players = [player(), player({ steamId: 's2', name: 'Bob', lat: 1, lng: 2 })];
    mapTab.updateMarkers();
    assert.equal(Object.keys(S.mapMarkers).length, 2);
    // turn the layer off and re-poll
    elements.set('map-layer-players', { checked: false });
    mapTab.updateMarkers();
    assert.equal(Object.keys(S.mapMarkers).length, 0, 'all markers cleared');
  });

  it('removes a marker when the player loses its position on a later poll', () => {
    const { mapTab, S } = loadMapTab();
    S.players = [player()];
    mapTab.updateMarkers();
    const m = S.mapMarkers.s1;
    // same player comes back without a usable position
    S.players = [player({ hasPosition: false })];
    mapTab.updateMarkers();
    assert.ok(!S.mapMarkers.s1, 'stale marker dropped from mapMarkers');
    assert.equal(m.removed, true, 'stale marker removed from the map');
    assert.equal(m.onMap, false);
  });

  it('re-creates a fresh marker when a removed player re-appears', () => {
    const { mapTab, S, created } = loadMapTab();
    S.players = [player()];
    mapTab.updateMarkers();
    const first = S.mapMarkers.s1;
    S.players = []; // gone
    mapTab.updateMarkers();
    assert.ok(!S.mapMarkers.s1 && first.removed === true);
    S.players = [player({ lat: 10, lng: 20 })]; // same id returns
    mapTab.updateMarkers();
    assert.equal(created.length, 2, 'a brand-new marker is created on return');
    assert.notEqual(S.mapMarkers.s1, first, 'not the stale (removed) marker');
    assert.equal(S.mapMarkers.s1.onMap, true, 're-added to the map');
    assert.equal(S.mapMarkers.s1.latlng[0], 10);
  });

  it('keeps _hzPlayer current on reuse so the click handler opens the live player', () => {
    const { mapTab, S } = loadMapTab();
    const p1 = player({ name: 'Alice', isOnline: true });
    S.players = [p1];
    mapTab.updateMarkers();
    const m = S.mapMarkers.s1;
    assert.equal(m._hzPlayer, p1);
    const p2 = player({ name: 'Alice2', isOnline: false, lat: 9 }); // same id, new object
    S.players = [p2];
    mapTab.updateMarkers();
    assert.equal(S.mapMarkers.s1, m, 'marker reused');
    assert.equal(m._hzPlayer, p2, '_hzPlayer points at the latest player object');
  });
});
