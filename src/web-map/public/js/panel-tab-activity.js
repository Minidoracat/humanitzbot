/**
 * Panel Tab: Activity — event feed with category filtering, charts, and fingerprint tracker.
 * @namespace Panel.tabs.activity
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  var S = Panel.core.S;
  var $ = Panel.core.$;
  var $$ = Panel.core.$$;
  var esc = Panel.core.esc;
  var apiFetch = Panel.core.apiFetch;
  var fmtNum = Panel.core.utils.fmtNum;
  var renderActivityFeed = Panel.shared.activityFeed.render;

  var _inited = false;

  function init() {
    if (_inited) return;
    _inited = true;
    // One-time event bindings are handled in the IIFE below
  }

  // ── Activity Loading ────────────────────────────────────────────

  async function loadActivity(append) {
    var container = $('#activity-feed');
    if (!container) return;
    var category = S.activityCategory || '';
    var rawSearch = $('#activity-search') ? $('#activity-search').value : '';
    var search = rawSearch.toLowerCase();
    var date = $('#activity-date') ? $('#activity-date').value : '';

    var paging = Panel.shared.activityFeed;

    // Detect fingerprint search pattern: ItemName#abcdef123456
    var fpMatch = rawSearch.match(/^(.+)#([a-f0-9]{6,})$/i);
    if (fpMatch) {
      var fpItem = fpMatch[1].trim();
      var fpHash = fpMatch[2].trim();
      showFingerprintTracker(fpItem, fpHash);
      // Also load normal activity filtered by item name
      search = fpItem.toLowerCase();
    } else {
      hideFingerprintTracker();
    }

    if (!append) {
      paging.setOffset(0);
    }
    var pageSize = paging.getPageSize();
    var params = new URLSearchParams({ limit: String(pageSize), offset: String(paging.getOffset()) });
    if (category) params.set('type', category);
    if (search) params.set('actor', search);
    try {
      var r = await apiFetch('/api/panel/activity?' + params);
      var d = await r.json();
      var events = d.events || [];
      if (date)
        events = events.filter(function (e) {
          return (e.created_at || '').startsWith(date);
        });
      paging.setHasMore(events.length >= pageSize);
      paging.setOffset(paging.getOffset() + events.length);
      renderActivityFeed(container, events, false, append);
      var btn = $('#activity-load-more');
      if (btn) btn.classList.toggle('hidden', !paging.getHasMore());
    } catch (_e) {
      if (!append)
        container.innerHTML =
          '<div class="feed-empty">' + i18next.t('web:empty_states.failed_to_load_activity') + '</div>';
    }
  }

  // Wire window global for load-more
  window.__loadMoreActivity = function () {
    loadActivity(true);
  };

  // ── Fingerprint Tracker ─────────────────────────────────────────

  function hideFingerprintTracker() {
    var panel = $('#fingerprint-tracker');
    if (panel) panel.classList.add('hidden');
  }

  async function showFingerprintTracker(itemName, fingerprint) {
    var panel = $('#fingerprint-tracker');
    if (!panel) return;

    // Show panel + loading state
    panel.classList.remove('hidden');
    if (window.lucide) lucide.createIcons({ nodes: [panel] });
    var nameEl = $('#fp-item-name');
    var hashEl = $('#fp-hash');
    var infoEl = $('#fp-instance-info');
    var ownershipEl = $('#fp-ownership');
    var chainEl = $('#fp-ownership-chain');
    var movementsEl = $('#fp-movements');
    var loadingEl = $('#fp-loading');
    var emptyEl = $('#fp-empty');

    if (nameEl) nameEl.textContent = itemName;
    if (hashEl) hashEl.textContent = '#' + fingerprint;
    if (infoEl) infoEl.innerHTML = '';
    if (chainEl) chainEl.innerHTML = '';
    if (movementsEl) movementsEl.innerHTML = '';
    if (ownershipEl) ownershipEl.classList.add('hidden');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');

    var limit = parseInt(($('#fp-limit') || {}).value || '50', 10);

    try {
      var params = new URLSearchParams({ fingerprint: fingerprint, item: itemName });
      var r = await apiFetch('/api/panel/items/lookup?' + params);
      if (!r.ok) throw new Error('API error');
      var data = await r.json();

      if (loadingEl) loadingEl.classList.add('hidden');

      var match = data.match;
      var movements = data.movements || [];
      var ownership = data.ownershipChain || [];

      if (!match && movements.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }

      // Render instance info badges
      if (match && infoEl) {
        var infoBadges = '';

        // Current location
        var locLabel = _fpFormatLocation(match.location_type, match.location_id);
        infoBadges +=
          '<div class="fp-info-badge"><div class="fp-info-label">Location</div><div class="fp-info-value">' +
          locLabel +
          '</div></div>';

        // Durability
        if (match.durability != null && match.durability > 0) {
          var durPct =
            match.max_dur > 0 ? Math.round((match.durability / match.max_dur) * 100) : Math.round(match.durability);
          var durCol = durPct > 60 ? 'text-emerald-400' : durPct > 25 ? 'text-amber-400' : 'text-red-400';
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">Durability</div><div class="fp-info-value ' +
            durCol +
            '">' +
            durPct +
            '%</div></div>';
        }

        // Amount
        if (match.amount > 1) {
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">Amount</div><div class="fp-info-value">' +
            match.amount +
            '</div></div>';
        }

        // Total movements
        infoBadges +=
          '<div class="fp-info-badge"><div class="fp-info-label">Movements</div><div class="fp-info-value">' +
          fmtNum(data.totalMovements || movements.length) +
          '</div></div>';

        // Status
        var status = match.lost
          ? '<span class="text-red-400">Lost</span>'
          : '<span class="text-emerald-400">Active</span>';
        infoBadges +=
          '<div class="fp-info-badge"><div class="fp-info-label">Status</div><div class="fp-info-value">' +
          status +
          '</div></div>';

        // First seen
        if (match.first_seen) {
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">First Seen</div><div class="fp-info-value text-xs">' +
            _fpShortDate(match.first_seen) +
            '</div></div>';
        }

        // Last seen
        if (match.last_seen) {
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">Last Seen</div><div class="fp-info-value text-xs">' +
            _fpShortDate(match.last_seen) +
            '</div></div>';
        }

        // Ammo
        if (match.ammo > 0) {
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">Ammo</div><div class="fp-info-value">' +
            match.ammo +
            '</div></div>';
        }

        infoEl.innerHTML = infoBadges;
      }

      // Render ownership chain
      if (ownership.length > 0 && ownershipEl && chainEl) {
        ownershipEl.classList.remove('hidden');
        var chainHtml = '';
        for (var ci = 0; ci < ownership.length; ci++) {
          if (ci > 0) chainHtml += '<span class="fp-custody-arrow">\u2192</span>';
          chainHtml +=
            '<span class="fp-custody-player player-link" data-steam-id="' +
            esc(ownership[ci].steamId || '') +
            '">' +
            esc(ownership[ci].name || ownership[ci].steamId) +
            '</span>';
          chainHtml += '<span class="fp-custody-time">' + _fpShortDate(ownership[ci].at) + '</span>';
        }
        chainEl.innerHTML = chainHtml;
      }

      // Render movement timeline (limited)
      var limited = movements.slice(0, limit);
      if (limited.length > 0 && movementsEl) {
        var movHtml = '';
        for (var mi = 0; mi < limited.length; mi++) {
          var m = limited[mi];
          movHtml += _fpRenderMovementRow(m);
        }
        if (movements.length > limit) {
          movHtml +=
            '<div class="text-[10px] text-muted text-center py-2">' +
            (movements.length - limit) +
            ' older movements not shown. Increase limit to see more.</div>';
        }
        movementsEl.innerHTML = movHtml;
      } else if (emptyEl) {
        emptyEl.classList.remove('hidden');
      }
    } catch (_err) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (movementsEl)
        movementsEl.innerHTML =
          '<div class="text-xs text-red-400 text-center py-2">' +
          i18next.t('web:activity.loading_tracker_data') +
          '</div>';
    }
  }

  function _fpFormatLocation(type, id, resolvedName) {
    if (!type) return '<span class="text-muted">Unknown</span>';
    if (type === 'player') {
      // Use resolved name from API, or try to look up from player list, or fallback to steam ID
      var pName = resolvedName || id;
      var steamId = id;
      if (!resolvedName) {
        for (var pi = 0; pi < S.players.length; pi++) {
          if (S.players[pi].steamId === id) {
            pName = S.players[pi].name;
            break;
          }
        }
      }
      return (
        '<span class="player-link cursor-pointer hover:underline text-accent" data-steam-id="' +
        esc(steamId) +
        '">' +
        esc(pName) +
        '</span>'
      );
    }
    if (type === 'container') {
      var cleanId = id
        .replace(/ChildActor_GEN_VARIABLE_|_C_CAT_\d+|BP_/g, '')
        .replace(/_/g, ' ')
        .trim();
      return '<span class="text-gray-300" title="' + esc(id) + '">' + esc(cleanId || id) + '</span>';
    }
    if (type === 'world_drop') {
      return '<span class="text-amber-400">World Drop</span>';
    }
    if (type === 'global_container') {
      return '<span class="text-blue-400">Global Container</span>';
    }
    return '<span class="text-gray-300">' + esc(type) + ': ' + esc(id) + '</span>';
  }

  function _fpShortDate(dateStr) {
    if (!dateStr) return '';
    try {
      var d = new Date(dateStr + 'Z');
      var now = new Date();
      var diff = now - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      var month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
      return (
        month +
        ' ' +
        d.getDate() +
        ', ' +
        String(d.getHours()).padStart(2, '0') +
        ':' +
        String(d.getMinutes()).padStart(2, '0')
      );
    } catch (_e) {
      return dateStr.slice(0, 16);
    }
  }

  function _fpRenderMovementRow(m) {
    var fromLoc = _fpFormatLocation(m.from_type, m.from_id, m.from_name);
    var toLoc = _fpFormatLocation(m.to_type, m.to_id, m.to_name);
    var time = _fpShortDate(m.created_at);
    var attrName = m.attributed_name || '';

    var html = '<div class="fp-movement-row">';
    html += '<span class="fp-time">' + esc(time) + '</span>';
    html += '<span class="fp-loc">' + fromLoc + '</span>';
    html += '<span class="fp-arrow">\u2192</span>';
    html += '<span class="fp-loc">' + toLoc + '</span>';
    if (attrName) {
      html += '<span class="text-muted text-[10px] ml-auto">by ' + esc(attrName) + '</span>';
    }
    if (m.amount > 1) {
      html += '<span class="text-muted text-[10px]">\u00d7' + m.amount + '</span>';
    }
    html += '</div>';
    return html;
  }

  // ── Activity Stats & Charts ─────────────────────────────────────

  var CHART_COLORS = {
    container: '#60a5fa', // blue
    inventory: '#34d399', // green
    vehicle: '#fbbf24', // yellow
    session: '#a78bfa', // purple
    combat: '#f87171', // red
    structure: '#fb923c', // orange
    horse: '#2dd4bf', // teal
    admin: '#f472b6', // pink
  };

  async function loadActivityStats() {
    try {
      var r = await apiFetch('/api/panel/activity-stats');
      var d = await r.json();
      S.activityStats = d;

      // Populate stat cards
      var totalEl = $('#act-total');
      if (totalEl) totalEl.textContent = (d.total || 0).toLocaleString();
      var typesEl = $('#act-types-count');
      if (typesEl) typesEl.textContent = Object.keys(d.types || {}).length;
      var rangeEl = $('#act-date-range');
      if (rangeEl && d.dateRange) {
        var e0 = d.dateRange.earliest ? d.dateRange.earliest.split('T')[0] : '?';
        var e1 = d.dateRange.latest ? d.dateRange.latest.split('T')[0] : '?';
        rangeEl.textContent = e0 + ' \u2014 ' + e1;
      }
      var topEl = $('#act-top-actor');
      if (topEl && d.topActors && d.topActors.length) {
        topEl.textContent = d.topActors[0].actor + ' (' + d.topActors[0].count.toLocaleString() + ')';
      }

      // Update pill counts
      var pills = $$('.activity-pill');
      for (var i = 0; i < pills.length; i++) {
        var pill = pills[i];
        var cat = pill.dataset.category || '';
        var badge = pill.querySelector('.pill-count');
        var count = 0;
        if (cat === '') count = d.total || 0;
        else count = (d.categories || {})[cat] || 0;
        if (badge) {
          badge.textContent = formatCompact(count);
        } else if (count > 0) {
          var span = document.createElement('span');
          span.className = 'pill-count';
          span.textContent = formatCompact(count);
          pill.appendChild(span);
        }
      }

      // Render charts
      renderDailyChart(d.daily || []);
      renderHourlyChart(d.hourly || []);
      renderCategoryChart(d.categories || {});
      renderTopActorsChart(d.topActors || []);
    } catch (e) {
      console.error('Failed to load activity stats:', e);
    }
  }

  function formatCompact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function destroyChart(key) {
    if (S.activityCharts[key]) {
      S.activityCharts[key].destroy();
      S.activityCharts[key] = null;
    }
  }

  function chartDefaults() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,15,20,0.95)',
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          cornerRadius: 6,
          padding: 8,
        },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 10 } } },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#64748b', font: { size: 10 } },
          beginAtZero: true,
        },
      },
    };
  }

  function renderDailyChart(daily) {
    var canvas = $('#chart-daily-activity');
    if (!canvas) return;
    destroyChart('daily');
    var labels = daily.map(function (d) {
      return d.day ? d.day.slice(5) : '';
    });
    var data = daily.map(function (d) {
      return d.count;
    });
    S.activityCharts.daily = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            borderColor: '#60a5fa',
            backgroundColor: 'rgba(96,165,250,0.15)',
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 1.5,
            pointHoverRadius: 4,
            pointBackgroundColor: '#60a5fa',
          },
        ],
      },
      options: chartDefaults(),
    });
  }

  function renderHourlyChart(hourly) {
    var canvas = $('#chart-hourly-activity');
    if (!canvas) return;
    destroyChart('hourly');
    var labels = [];
    var data = [];
    var hourMap = {};
    for (var i = 0; i < hourly.length; i++) hourMap[hourly[i].hour] = hourly[i].count;
    for (var h = 0; h < 24; h++) {
      labels.push(h.toString().padStart(2, '0') + ':00');
      data.push(hourMap[h] || 0);
    }
    S.activityCharts.hourly = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: 'rgba(167,139,250,0.5)',
            borderColor: '#a78bfa',
            borderWidth: 1,
            borderRadius: 3,
          },
        ],
      },
      options: chartDefaults(),
    });
  }

  function renderCategoryChart(categories) {
    var canvas = $('#chart-category-activity');
    if (!canvas) return;
    destroyChart('category');
    var cats = Object.keys(categories);
    if (!cats.length) return;
    var labels = cats.map(function (c) {
      return c.charAt(0).toUpperCase() + c.slice(1);
    });
    var data = cats.map(function (c) {
      return categories[c];
    });
    var colors = cats.map(function (c) {
      return CHART_COLORS[c] || '#64748b';
    });
    S.activityCharts.category = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: colors,
            borderColor: 'rgba(15,15,20,0.8)',
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: {
            position: 'right',
            labels: { color: '#94a3b8', font: { size: 11 }, padding: 8, usePointStyle: true, pointStyleWidth: 8 },
          },
          tooltip: {
            backgroundColor: 'rgba(15,15,20,0.95)',
            titleColor: '#e2e8f0',
            bodyColor: '#94a3b8',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            cornerRadius: 6,
            padding: 8,
          },
        },
      },
    });
  }

  function renderTopActorsChart(topActors) {
    var canvas = $('#chart-top-actors');
    if (!canvas) return;
    destroyChart('topActors');
    if (!topActors.length) return;
    var labels = topActors.map(function (a) {
      return a.actor || 'Unknown';
    });
    var data = topActors.map(function (a) {
      return a.count;
    });
    S.activityCharts.topActors = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: 'rgba(52,211,153,0.5)',
            borderColor: '#34d399',
            borderWidth: 1,
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15,15,20,0.95)',
            titleColor: '#e2e8f0',
            bodyColor: '#94a3b8',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            cornerRadius: 6,
            padding: 8,
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#64748b', font: { size: 10 } },
            beginAtZero: true,
          },
          y: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } },
        },
      },
    });
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.activity = {
    init: init,
    load: function () {
      loadActivity();
      if (!S.activityChartsLoaded) {
        loadActivityStats();
        S.activityChartsLoaded = true;
      }
    },
    reset: reset,
    loadActivity: loadActivity,
    loadActivityStats: loadActivityStats,
    resetPaging: Panel.shared.activityFeed.resetPaging,
    showFingerprintTracker: showFingerprintTracker,
    hideFingerprintTracker: hideFingerprintTracker,
  };
})();
