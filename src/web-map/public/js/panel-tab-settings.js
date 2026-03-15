/**
 * Panel Tab: Settings — game settings, bot config (.env), and schedule editor.
 * @namespace Panel.tabs.settings
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  var S = Panel.core.S;
  var $ = Panel.core.$;
  var $$ = Panel.core.$$;
  var el = Panel.core.el;
  var esc = Panel.core.esc;
  var apiFetch = Panel.core.apiFetch;
  var ENV_BOOLEANS = Panel.core.ENV_BOOLEANS;
  var getSettingCategories = Panel.core.getSettingCategories;
  var getSettingDescs = Panel.core.getSettingDescs;
  var getEnvDescs = Panel.core.getEnvDescs;
  var humanizeSettingKey = Panel.core.utils.humanizeSettingKey;
  var showToast = Panel.core.utils.showToast;

  var _inited = false;

  function init() {
    if (_inited) return;
    _inited = true;
  }

  // ══════════════════════════════════════════════════════════════════
  //  Game Settings
  // ══════════════════════════════════════════════════════════════════

  async function loadSettings() {
    var container = $('#settings-grid');
    if (!container) return;
    try {
      var r = await apiFetch('/api/panel/settings');
      if (!r.ok) {
        container.innerHTML =
          '<div class="feed-empty">' + i18next.t('web:empty_states.settings_unavailable') + '</div>';
        return;
      }
      var d = await r.json();
      var settings = d.settings || {};
      S.settingsOriginal = Object.assign({}, settings);
      S.settingsChanged = {};
      renderSettingsCategories(container, settings);
      var countEl = $('#settings-count');
      if (countEl) countEl.textContent = Object.keys(settings).length + ' settings';
    } catch (_e) {
      container.innerHTML =
        '<div class="feed-empty">' + i18next.t('web:empty_states.failed_to_load_settings') + '</div>';
    }
  }

  function renderSettingsCategories(container, settings) {
    container.innerHTML = '';
    var assigned = {};
    var categories = [];

    var settingCategories = getSettingCategories();
    var settingDescs = getSettingDescs();
    for (var catName in settingCategories) {
      if (!settingCategories.hasOwnProperty(catName)) continue;
      var keys = settingCategories[catName];
      var items = [];
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki] in settings) {
          items.push({ key: keys[ki], value: settings[keys[ki]] });
          assigned[keys[ki]] = true;
        }
      }
      if (items.length) categories.push({ name: catName, items: items });
    }

    var other = [];
    for (var key in settings) {
      if (!settings.hasOwnProperty(key)) continue;
      if (!assigned[key]) other.push({ key: key, value: settings[key] });
    }
    if (other.length)
      categories.push({ name: i18next.t('web:settings.other', { defaultValue: 'Other' }), items: other });

    for (var ci = 0; ci < categories.length; ci++) {
      var cat = categories[ci];
      var section = el('div', 'settings-category');
      var header = el('div', 'settings-category-header');
      header.innerHTML =
        '<span class="cat-arrow">\u25B8</span><span class="cat-label">' +
        cat.name +
        '</span><span class="cat-count">' +
        cat.items.length +
        '</span>';

      var body = el('div', 'settings-category-items');
      for (var ii = 0; ii < cat.items.length; ii++) {
        var item = cat.items[ii];
        var row = el('div', 'setting-row');
        row.dataset.key = item.key;
        var desc = settingDescs[item.key] || '';
        row.innerHTML =
          '<div class="setting-name">' +
          esc(humanizeSettingKey(item.key)) +
          '</div>' +
          (desc ? '<div class="setting-desc">' + esc(desc) + '</div>' : '') +
          '<input type="text" class="setting-input" value="' +
          esc(String(item.value)) +
          '" data-key="' +
          esc(item.key) +
          '" data-original="' +
          esc(String(item.value)) +
          '">';
        body.appendChild(row);
      }

      (function (bodyEl, headerEl) {
        headerEl.addEventListener('click', function () {
          bodyEl.classList.toggle('open');
          headerEl.querySelector('.cat-arrow').classList.toggle('open');
        });
      })(body, header);

      if (ci === 0) {
        body.classList.add('open');
        header.querySelector('.cat-arrow').classList.add('open');
      }

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
    }

    container.addEventListener('input', function (e) {
      if (!e.target.classList.contains('setting-input')) return;
      var key = e.target.dataset.key;
      var orig = e.target.dataset.original;
      var val = e.target.value;
      if (val !== orig) {
        S.settingsChanged[key] = val;
        e.target.classList.add('changed');
      } else {
        delete S.settingsChanged[key];
        e.target.classList.remove('changed');
      }

      var changeCount = Object.keys(S.settingsChanged).length;
      var hasChanges = changeCount > 0;
      var btn = $('#settings-save-btn');
      if (btn) {
        btn.disabled = !hasChanges;
        btn.classList.toggle('opacity-50', !hasChanges);
        btn.classList.toggle('cursor-not-allowed', !hasChanges);
      }
      var countBadge = $('#settings-change-count');
      if (countBadge) {
        countBadge.classList.toggle('hidden', !hasChanges);
        countBadge.textContent = changeCount + ' change' + (changeCount !== 1 ? 's' : '');
      }
      var resetBtn = $('#settings-reset-btn');
      if (resetBtn) resetBtn.classList.toggle('hidden', !hasChanges);
    });
  }

  function filterSettings() {
    var q = ($('#settings-search') ? $('#settings-search').value : '').toLowerCase();
    $$('.setting-row').forEach(function (row) {
      var key = (row.dataset.key || '').toLowerCase();
      var nameEl = row.querySelector('.setting-name');
      var descEl = row.querySelector('.setting-desc');
      var name = nameEl ? nameEl.textContent.toLowerCase() : '';
      var desc = descEl ? descEl.textContent.toLowerCase() : '';
      row.style.display = key.includes(q) || name.includes(q) || desc.includes(q) ? '' : 'none';
    });
    $$('.settings-category').forEach(function (cat) {
      var visibleRows = cat.querySelectorAll('.setting-row:not([style*="display: none"])');
      cat.style.display = visibleRows.length ? '' : 'none';
      if (q && visibleRows.length) {
        var items = cat.querySelector('.settings-category-items');
        if (items) items.classList.add('open');
        var arrow = cat.querySelector('.cat-arrow');
        if (arrow) arrow.classList.add('open');
      }
    });
  }

  function showSettingsDiff() {
    var changed = S.settingsMode === 'bot' ? S.botConfigChanged : S.settingsChanged;
    var originals = S.settingsMode === 'bot' ? S.botConfigOriginal : S.settingsOriginal;
    var keys = Object.keys(changed);
    if (keys.length === 0) return;

    var content = $('#settings-diff-content');
    if (!content) return;
    content.innerHTML = '';

    var catOrder = {};
    var orderIdx = 0;
    var settingCategories = getSettingCategories();
    for (var catName in settingCategories) {
      if (!settingCategories.hasOwnProperty(catName)) continue;
      var catKeys = settingCategories[catName];
      for (var ci = 0; ci < catKeys.length; ci++) {
        catOrder[catKeys[ci]] = orderIdx++;
      }
    }
    keys.sort(function (a, b) {
      var oa = catOrder[a] != null ? catOrder[a] : 9999;
      var ob = catOrder[b] != null ? catOrder[b] : 9999;
      return oa - ob;
    });

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var oldVal = originals[key] != null ? String(originals[key]) : '';
      var newVal = changed[key];
      var isSensitive = S.settingsMode === 'bot' && !oldVal && newVal;
      var displayOld = isSensitive ? '(hidden)' : oldVal;
      var displayNew = isSensitive ? '(updated)' : newVal;
      var row = el('div', 'diff-row');
      var descKey = S.settingsMode === 'bot' ? key : humanizeSettingKey(key);
      row.innerHTML =
        '<div class="diff-key">' +
        esc(descKey) +
        '<div class="diff-key-raw">' +
        esc(key) +
        '</div></div>' +
        '<div class="diff-values">' +
        '<span class="diff-old">' +
        esc(displayOld) +
        '</span>' +
        '<span class="diff-arrow">\u2192</span>' +
        '<span class="diff-new">' +
        esc(String(displayNew)) +
        '</span>' +
        '</div>';
      content.appendChild(row);
    }

    var modal = $('#settings-diff-modal');
    if (modal) modal.classList.remove('hidden');

    if (window.lucide) lucide.createIcons();
  }

  function resetSettingsChanges() {
    if (S.settingsMode === 'bot') return resetBotConfigChanges();

    var keys = Object.keys(S.settingsChanged);
    for (var i = 0; i < keys.length; i++) {
      var input = $('input[data-key="' + keys[i] + '"]');
      if (input) {
        input.value = input.dataset.original;
        input.classList.remove('changed');
      }
    }
    S.settingsChanged = {};
    var btn = $('#settings-save-btn');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
    }
    var countBadge = $('#settings-change-count');
    if (countBadge) countBadge.classList.add('hidden');
    var resetBtn = $('#settings-reset-btn');
    if (resetBtn) resetBtn.classList.add('hidden');
  }

  async function commitSettings() {
    if (S.settingsMode === 'bot') return commitBotConfig();
    if (Object.keys(S.settingsChanged).length === 0) return;
    var btn = $('#settings-save-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = i18next.t('web:schedule_editor.saving');
    }
    try {
      var r = await apiFetch('/api/panel/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: S.settingsChanged }),
      });
      var d = await r.json();
      if (d.ok) {
        var updated = d.updated || [];
        for (var ui = 0; ui < updated.length; ui++) {
          var key = updated[ui];
          S.settingsOriginal[key] = S.settingsChanged[key];
          var input = $('input[data-key="' + key + '"]');
          if (input) {
            input.dataset.original = S.settingsChanged[key];
            input.classList.remove('changed');
          }
        }
        S.settingsChanged = {};
        if (btn) btn.textContent = i18next.t('web:schedule_editor.saved') + ' ✓';
        var countBadge = $('#settings-change-count');
        if (countBadge) countBadge.classList.add('hidden');
        var resetBtn = $('#settings-reset-btn');
        if (resetBtn) resetBtn.classList.add('hidden');
        setTimeout(function () {
          if (btn) {
            btn.textContent = i18next.t('web:settings.save_changes');
            btn.disabled = true;
            btn.classList.add('opacity-50', 'cursor-not-allowed');
          }
        }, 2000);
      } else throw new Error(d.error || i18next.t('web:toast.save_failed'));
    } catch (e) {
      if (btn) {
        btn.textContent = i18next.t('web:dashboard.error');
        btn.disabled = false;
      }
      console.error('Settings save error:', e);
      setTimeout(function () {
        if (btn) btn.textContent = i18next.t('web:settings.save_changes');
      }, 2000);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  Bot Configuration (.env editor)
  // ══════════════════════════════════════════════════════════════════

  async function loadBotConfig() {
    var container = $('#settings-grid');
    if (!container) return;
    try {
      var r = await apiFetch('/api/panel/bot-config');
      if (!r.ok) {
        container.innerHTML =
          '<div class="feed-empty">' + i18next.t('web:empty_states.bot_configuration_unavailable') + '</div>';
        return;
      }
      var d = await r.json();
      S.botConfigSections = d.sections || [];
      S.botConfigOriginal = {};
      S.botConfigChanged = {};
      for (var si = 0; si < S.botConfigSections.length; si++) {
        var sec = S.botConfigSections[si];
        for (var ki = 0; ki < sec.keys.length; ki++) {
          var k = sec.keys[ki];
          S.botConfigOriginal[k.key] = k.value;
        }
      }
      renderBotConfig(container, S.botConfigSections);
      var countEl = $('#settings-count');
      var total = S.botConfigSections.reduce(function (sum, s) {
        return sum + s.keys.length;
      }, 0);
      if (countEl) countEl.textContent = total + ' settings';
      var btn = $('#settings-save-btn');
      if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-50', 'cursor-not-allowed');
      }
      var countBadge = $('#settings-change-count');
      if (countBadge) countBadge.classList.add('hidden');
      var resetBtn = $('#settings-reset-btn');
      if (resetBtn) resetBtn.classList.add('hidden');
      var restartBadge = $('#settings-restart-badge');
      if (restartBadge) restartBadge.classList.add('hidden');
    } catch (e) {
      container.innerHTML =
        '<div class="feed-empty">' + i18next.t('web:empty_states.failed_to_load_bot_configuration') + '</div>';
      console.error('Bot config error:', e);
    }
  }

  function renderBotConfig(container, sections) {
    container.innerHTML = '';

    var envDescs = getEnvDescs();
    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (!sec.keys.length) continue;

      var section = el('div', 'settings-category');
      var header = el('div', 'settings-category-header');
      header.innerHTML =
        '<span class="cat-arrow">\u25B8</span><span class="cat-label">' +
        esc(sec.label) +
        '</span><span class="cat-count">' +
        sec.keys.length +
        '</span>';

      var body = el('div', 'settings-category-items');
      for (var ki = 0; ki < sec.keys.length; ki++) {
        var item = sec.keys[ki];
        var row = el('div', 'setting-row' + (item.commented ? ' setting-commented' : ''));
        row.dataset.key = item.key;
        var desc = envDescs[item.key] || '';
        var isBool = ENV_BOOLEANS.has(item.key);
        var nameHtml = '<div class="setting-name">' + esc(humanizeEnvKey(item.key));
        if (item.sensitive) nameHtml += ' <span class="setting-sensitive-badge">secret</span>';
        if (item.readOnly)
          nameHtml +=
            ' <span class="setting-sensitive-badge" style="color:#d4a843;border-color:rgba(212,168,67,0.15);background:rgba(212,168,67,0.08)">read-only</span>';
        nameHtml += '<div class="setting-env-key">' + esc(item.key) + '</div></div>';

        var inputHtml;
        if (item.readOnly) {
          inputHtml = '<span class="text-xs text-muted font-mono">' + esc(item.value || '-') + '</span>';
        } else if (item.sensitive) {
          inputHtml = '<div class="flex items-center gap-2">';
          if (item.hasValue)
            inputHtml += '<span class="text-xs text-calm">\u2022\u2022\u2022\u2022\u2022\u2022 set</span>';
          else inputHtml += '<span class="text-xs text-muted">not set</span>';
          inputHtml +=
            '<input type="password" class="setting-input bot-config-input" style="width:180px" placeholder="Enter new value..." data-key="' +
            esc(item.key) +
            '" data-original="" data-sensitive="true" autocomplete="off">';
          inputHtml += '</div>';
        } else if (isBool) {
          var isOn = item.value === 'true';
          inputHtml =
            '<label class="setting-toggle"><input type="checkbox" class="bot-config-toggle" data-key="' +
            esc(item.key) +
            '" data-original="' +
            esc(item.value) +
            '"' +
            (isOn ? ' checked' : '') +
            '><span class="toggle-track"></span><span class="toggle-thumb"></span></label>';
        } else {
          inputHtml =
            '<input type="text" class="setting-input bot-config-input" value="' +
            esc(item.value) +
            '" data-key="' +
            esc(item.key) +
            '" data-original="' +
            esc(item.value) +
            '">';
        }

        row.innerHTML = nameHtml + (desc ? '<div class="setting-desc">' + esc(desc) + '</div>' : '') + inputHtml;
        body.appendChild(row);
      }

      (function (bodyEl, headerEl) {
        headerEl.addEventListener('click', function () {
          bodyEl.classList.toggle('open');
          headerEl.querySelector('.cat-arrow').classList.toggle('open');
        });
      })(body, header);

      if (si === 0) {
        body.classList.add('open');
        header.querySelector('.cat-arrow').classList.add('open');
      }

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
    }

    container.addEventListener('input', function (e) {
      if (!e.target.classList.contains('bot-config-input')) return;
      var key = e.target.dataset.key;
      var orig = e.target.dataset.original;
      var val = e.target.value;
      var isSensitive = e.target.dataset.sensitive === 'true';

      if (isSensitive) {
        if (val.length > 0) {
          S.botConfigChanged[key] = val;
          e.target.classList.add('changed');
        } else {
          delete S.botConfigChanged[key];
          e.target.classList.remove('changed');
        }
      } else {
        if (val !== orig) {
          S.botConfigChanged[key] = val;
          e.target.classList.add('changed');
        } else {
          delete S.botConfigChanged[key];
          e.target.classList.remove('changed');
        }
      }
      updateBotConfigBadges();
    });

    container.addEventListener('change', function (e) {
      if (!e.target.classList.contains('bot-config-toggle')) return;
      var key = e.target.dataset.key;
      var orig = e.target.dataset.original;
      var val = e.target.checked ? 'true' : 'false';
      if (val !== orig) {
        S.botConfigChanged[key] = val;
      } else {
        delete S.botConfigChanged[key];
      }
      updateBotConfigBadges();
    });
  }

  function updateBotConfigBadges() {
    var changeCount = Object.keys(S.botConfigChanged).length;
    var hasChanges = changeCount > 0;
    var btn = $('#settings-save-btn');
    if (btn) {
      btn.disabled = !hasChanges;
      btn.classList.toggle('opacity-50', !hasChanges);
      btn.classList.toggle('cursor-not-allowed', !hasChanges);
    }
    var countBadge = $('#settings-change-count');
    if (countBadge) {
      countBadge.classList.toggle('hidden', !hasChanges);
      countBadge.textContent = changeCount + ' change' + (changeCount !== 1 ? 's' : '');
    }
    var resetBtn = $('#settings-reset-btn');
    if (resetBtn) resetBtn.classList.toggle('hidden', !hasChanges);
    var restartBadge = $('#settings-restart-badge');
    if (restartBadge) restartBadge.classList.toggle('hidden', !hasChanges);
  }

  function humanizeEnvKey(key) {
    return key.replace(/_/g, ' ').replace(/\b([A-Z]+)\b/g, function (m) {
      if (/^(ID|IP|RCON|SFTP|FTP|SSH|PVP|API|URL|TTL|CSV|DB|OAUTH|MSG|XP|AI|DM|UI|NPC|ADMIN)$/.test(m)) return m;
      return m.charAt(0) + m.slice(1).toLowerCase();
    });
  }

  function resetBotConfigChanges() {
    var keys = Object.keys(S.botConfigChanged);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var input = $('input.bot-config-input[data-key="' + key + '"]');
      if (input) {
        if (input.dataset.sensitive === 'true') input.value = '';
        else input.value = input.dataset.original;
        input.classList.remove('changed');
      }
      var toggle = $('input.bot-config-toggle[data-key="' + key + '"]');
      if (toggle) {
        toggle.checked = toggle.dataset.original === 'true';
      }
    }
    S.botConfigChanged = {};
    updateBotConfigBadges();
  }

  async function commitBotConfig() {
    if (Object.keys(S.botConfigChanged).length === 0) return;
    var btn = $('#settings-save-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = i18next.t('web:schedule_editor.saving');
    }
    try {
      var r = await apiFetch('/api/panel/bot-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: S.botConfigChanged }),
      });
      var d = await r.json();
      if (d.ok) {
        var updated = d.updated || [];
        for (var ui = 0; ui < updated.length; ui++) {
          var key = updated[ui];
          var newVal = S.botConfigChanged[key];
          if ($('input.bot-config-input[data-key="' + key + '"][data-sensitive="true"]')) {
            var sens = $('input.bot-config-input[data-key="' + key + '"]');
            if (sens) {
              sens.value = '';
              sens.classList.remove('changed');
            }
          } else {
            S.botConfigOriginal[key] = newVal;
            var input = $('input.bot-config-input[data-key="' + key + '"]');
            if (input) {
              input.dataset.original = newVal;
              input.classList.remove('changed');
            }
            var toggle = $('input.bot-config-toggle[data-key="' + key + '"]');
            if (toggle) {
              toggle.dataset.original = newVal;
            }
          }
        }
        S.botConfigChanged = {};
        if (btn) btn.textContent = i18next.t('web:schedule_editor.saved') + ' ✓';
        updateBotConfigBadges();
        var restartBadge = $('#settings-restart-badge');
        if (restartBadge) restartBadge.classList.remove('hidden');
        showToast(
          d.code ? i18next.t('api:errors.' + d.code) : d.message || i18next.t('web:toast.settings_saved'),
          5000,
        );
        setTimeout(function () {
          if (btn) {
            btn.textContent = i18next.t('web:settings.save_changes');
            btn.disabled = true;
            btn.classList.add('opacity-50', 'cursor-not-allowed');
          }
        }, 2000);
      } else throw new Error(d.error || i18next.t('web:toast.save_failed'));
    } catch (e) {
      if (btn) {
        btn.textContent = i18next.t('web:dashboard.error');
        btn.disabled = false;
      }
      console.error('Bot config save error:', e);
      showToast(i18next.t('web:toast.error', { message: e.message }), 5000);
      setTimeout(function () {
        if (btn) btn.textContent = i18next.t('web:settings.save_changes');
      }, 2000);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  Schedule Editor
  // ══════════════════════════════════════════════════════════════════

  var SCHED_SKIP_KEYS = { ServerName: 1, MaxPlayers: 1, PVP: 1 };
  var _schedEdit = { times: [], profiles: [], settings: {}, rotateDaily: false, serverNameTemplate: '' };

  function _deathLabel(v) {
    var k = { 0: 'keep_items', 1: 'drop_items', 2: 'destroy_items' };
    return i18next.t('web:on_death.' + (k[v] || 'drop_items'));
  }

  function _schedLabel(k) {
    var m = {
      ZombieAmountMulti: 'schedule.zombies',
      ZombieDiffHealth: 'schedule.zombie_hp',
      ZombieDiffDamage: 'schedule.zombie_damage',
      ZombieDiffSpeed: 'schedule.zombie_speed',
      HumanAmountMulti: 'schedule.bandits',
      AnimalMulti: 'schedule.animals',
      AIEvent: 'schedule.ai_events',
      XpMultiplier: 'schedule.xp_multiplier',
      OnDeath: 'schedule.on_death',
      RarityFood: 'schedule.food_loot',
      RarityDrink: 'schedule.drink_loot',
      RarityMelee: 'schedule.melee_loot',
      RarityRanged: 'schedule.ranged_loot',
      RarityAmmo: 'schedule.ammo_loot',
      RarityArmor: 'schedule.armor_loot',
      RarityResources: 'schedule.resource_loot',
      RarityOther: 'schedule.other_loot',
      PVP: 'schedule.pvp',
      MaxPlayers: 'schedule.max_players',
    };
    return m[k] ? i18next.t('web:' + m[k]) : null;
  }

  function _schedDiffLabel(v) {
    var k = { 1: 'low', 2: 'normal', 3: 'high', 4: 'very_high' };
    return i18next.t('web:difficulty.' + (k[v] || v));
  }

  function _schedRarityLabel(v) {
    var k = { 1: 'scarce', 2: 'normal', 3: 'plenty', 4: 'abundant' };
    return i18next.t('web:loot_level.' + (k[v] || v));
  }

  function formatSettingVal(key, val) {
    var s = String(val).replace(/^"|"$/g, '');
    if (/^ZombieDiff/.test(key)) return _schedDiffLabel(s);
    if (/^Rarity/.test(key)) return _schedRarityLabel(s);
    if (/Multi$|Multiplier$/.test(key))
      return parseFloat(s) !== 1 ? s + 'x' : '1x (' + i18next.t('web:schedule.default') + ')';
    if (key === 'AIEvent') return _schedDiffLabel(s);
    if (key === 'OnDeath') {
      return _deathLabel(parseInt(s, 10));
    }
    if (key === 'PVP') return s === '1' || s === 'true' ? i18next.t('web:schedule.on') : i18next.t('web:schedule.off');
    return s;
  }

  function buildScheduleTip(name, colorCls, ps) {
    var accent =
      colorCls === 'calm' ? '#6dba82' : colorCls === 'surge' ? '#d4a843' : colorCls === 'horde' ? '#c45a4a' : '#c8c2b8';
    var h = '<div class="sched-tip"><div class="sched-tip-title" style="color:' + accent + '">' + esc(name) + '</div>';
    for (var k in ps) {
      if (!ps.hasOwnProperty(k) || SCHED_SKIP_KEYS[k]) continue;
      var label = _schedLabel(k) || humanizeSettingKey(k);
      var val = formatSettingVal(k, ps[k]);
      h +=
        '<div class="sched-tip-row"><span class="sched-tip-key">' +
        esc(label) +
        '</span><span class="sched-tip-val">' +
        esc(val) +
        '</span></div>';
    }
    h += '</div>';
    return h;
  }

  function getRelativeHint(slot, sched) {
    if (!sched.todaySchedule) return '';
    var now = minutesFromTimeStr(getCurrentTimeInTz(sched.timezone));
    var start = minutesFromTimeStr(slot.startTime);
    var diff = start - now;
    if (diff <= 0) return '';
    if (diff < 60) return i18next.t('web:schedule.in_minutes', { m: diff });
    var h = Math.floor(diff / 60);
    var m = diff % 60;
    return m > 0
      ? i18next.t('web:schedule.in_hours_minutes', { h: h, m: m })
      : i18next.t('web:schedule.in_hours', { h: h });
  }

  function minutesFromTimeStr(ts) {
    if (!ts) return 0;
    var parts = ts.split(':');
    return parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
  }

  function getCurrentTimeInTz(tz) {
    try {
      return new Date().toLocaleTimeString(undefined, {
        timeZone: tz,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_e) {
      return new Date().toTimeString().slice(0, 5);
    }
  }

  function renderSchedule(container, sched, _context) {
    if (!container || !sched || !sched.todaySchedule) return;
    container.innerHTML = '';
    var profileSettings = sched.profileSettings || {};
    var slots = sched.todaySchedule.slots || [];
    if (!slots.length) return;
    var now = getCurrentTimeInTz(sched.timezone);
    var nowMins = minutesFromTimeStr(now);

    var html = '<div class="sched-timeline">';
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var startMins = minutesFromTimeStr(slot.startTime);
      var endMins = i + 1 < slots.length ? minutesFromTimeStr(slots[i + 1].startTime) : 1440;
      var duration = endMins - startMins;
      if (duration < 0) duration += 1440;
      var pct = (duration / 1440) * 100;
      var profile = slot.profile || 'default';
      var colorCls = profile.includes('calm')
        ? 'calm'
        : profile.includes('surge')
          ? 'surge'
          : profile.includes('horde')
            ? 'horde'
            : 'text';
      var isActive =
        nowMins >= startMins && (i + 1 >= slots.length || nowMins < minutesFromTimeStr(slots[i + 1].startTime));
      var hint = getRelativeHint(slot, sched);
      var ps = profileSettings[profile] || {};
      var tip = buildScheduleTip(profile.charAt(0).toUpperCase() + profile.slice(1), colorCls, ps);

      html +=
        '<div class="sched-slot' +
        (isActive ? ' sched-active' : '') +
        '" style="flex:' +
        pct +
        '" data-tippy-content="' +
        esc(tip) +
        '">';
      html += '<div class="sched-slot-label text-' + colorCls + '">';
      html += '<span class="sched-time">' + slot.startTime + '</span>';
      html += '<span class="sched-profile">' + esc(profile.charAt(0).toUpperCase() + profile.slice(1)) + '</span>';
      if (isActive) html += '<span class="sched-now">' + i18next.t('web:schedule.now') + '</span>';
      else if (hint) html += '<span class="sched-hint">' + hint + '</span>';
      html += '</div></div>';
    }
    html += '</div>';
    container.innerHTML = html;
    if (window.tippy)
      tippy(container.querySelectorAll('[data-tippy-content]'), {
        theme: 'translucent',
        allowHTML: true,
        placement: 'top',
        delay: [150, 0],
      });
  }

  function renderTomorrowSchedule(container, sched) {
    if (!container || !sched.tomorrowSchedule) return;
    var tmrw = sched.tomorrowSchedule;
    var slots = tmrw.slots || [];
    if (!slots.length) return;
    var profileSettings = sched.profileSettings || {};

    var html = '<div class="mt-3">';
    html +=
      '<div class="text-[10px] text-muted mb-1">' +
      i18next.t('web:schedule.tomorrow', { defaultValue: 'Tomorrow' }) +
      '</div>';
    html += '<div class="sched-timeline sched-tomorrow">';
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var startMins = minutesFromTimeStr(slot.startTime);
      var endMins = i + 1 < slots.length ? minutesFromTimeStr(slots[i + 1].startTime) : 1440;
      var duration = endMins - startMins;
      if (duration < 0) duration += 1440;
      var pct = (duration / 1440) * 100;
      var profile = slot.profile || 'default';
      var colorCls = profile.includes('calm')
        ? 'calm'
        : profile.includes('surge')
          ? 'surge'
          : profile.includes('horde')
            ? 'horde'
            : 'text';
      var ps = profileSettings[profile] || {};
      var tip = buildScheduleTip(profile.charAt(0).toUpperCase() + profile.slice(1), colorCls, ps);

      html += '<div class="sched-slot" style="flex:' + pct + '" data-tippy-content="' + esc(tip) + '">';
      html += '<div class="sched-slot-label text-' + colorCls + '">';
      html += '<span class="sched-time">' + slot.startTime + '</span>';
      html += '<span class="sched-profile">' + esc(profile.charAt(0).toUpperCase() + profile.slice(1)) + '</span>';
      html += '</div></div>';
    }
    html += '</div></div>';
    container.innerHTML += html;
    if (window.tippy)
      tippy(container.querySelectorAll('.sched-tomorrow [data-tippy-content]'), {
        theme: 'translucent',
        allowHTML: true,
        placement: 'top',
        delay: [150, 0],
      });
  }

  // ── Schedule Editor Core ────────────────────────────────────────

  function _getSchedSettingGroups() {
    var _d = function () {
      return {
        1: i18next.t('web:difficulty.low'),
        2: i18next.t('web:difficulty.normal'),
        3: i18next.t('web:difficulty.high'),
        4: i18next.t('web:difficulty.very_high'),
      };
    };
    var _r = function () {
      return {
        1: i18next.t('web:loot_level.scarce'),
        2: i18next.t('web:loot_level.normal'),
        3: i18next.t('web:loot_level.plenty'),
        4: i18next.t('web:loot_level.abundant'),
      };
    };
    return [
      {
        header: i18next.t('web:schedule_editor.zombies'),
        icon: 'skull',
        items: [
          { key: 'ZombieAmountMulti', label: i18next.t('web:dashboard.amount'), type: 'number', step: '0.1' },
          { key: 'ZombieDiffHealth', label: i18next.t('web:dashboard.health'), type: 'select', opts: _d() },
          { key: 'ZombieDiffDamage', label: i18next.t('web:dashboard.damage'), type: 'select', opts: _d() },
          { key: 'ZombieDiffSpeed', label: i18next.t('web:dashboard.speed'), type: 'select', opts: _d() },
        ],
      },
      {
        header: i18next.t('web:schedule_editor.enemies'),
        icon: 'swords',
        items: [
          { key: 'HumanAmountMulti', label: i18next.t('web:dashboard.bandits'), type: 'number', step: '0.1' },
          { key: 'AnimalMulti', label: i18next.t('web:schedule.animals'), type: 'number', step: '0.1' },
          { key: 'AIEvent', label: i18next.t('web:schedule.ai_events'), type: 'select', opts: _d() },
        ],
      },
      {
        header: i18next.t('web:schedule_editor.loot'),
        icon: 'package',
        items: [
          { key: 'RarityFood', label: i18next.t('web:dashboard.food'), type: 'select', opts: _r() },
          { key: 'RarityDrink', label: i18next.t('web:dashboard.drinks'), type: 'select', opts: _r() },
          { key: 'RarityMelee', label: i18next.t('web:dashboard.melee'), type: 'select', opts: _r() },
          { key: 'RarityRanged', label: i18next.t('web:dashboard.ranged'), type: 'select', opts: _r() },
          { key: 'RarityAmmo', label: i18next.t('web:dashboard.ammo'), type: 'select', opts: _r() },
          { key: 'RarityArmor', label: i18next.t('web:dashboard.armor'), type: 'select', opts: _r() },
          { key: 'RarityResources', label: i18next.t('web:dashboard.resources'), type: 'select', opts: _r() },
          { key: 'RarityOther', label: i18next.t('web:schedule_editor.other'), type: 'select', opts: _r() },
        ],
      },
      {
        header: i18next.t('web:schedule_editor.gameplay'),
        icon: 'settings',
        items: [
          {
            key: 'PVP',
            label: 'PvP',
            type: 'select',
            opts: { 0: i18next.t('web:schedule.off'), 1: i18next.t('web:schedule.on') },
          },
          {
            key: 'OnDeath',
            label: i18next.t('web:schedule.on_death'),
            type: 'select',
            opts: {
              0: i18next.t('web:on_death.keep_items'),
              1: i18next.t('web:on_death.drop_items'),
              2: i18next.t('web:on_death.destroy_items'),
            },
          },
          { key: 'XpMultiplier', label: i18next.t('web:schedule.xp_multiplier'), type: 'number', step: '0.1' },
          { key: 'MaxPlayers', label: i18next.t('web:schedule.max_players'), type: 'number', step: '1' },
        ],
      },
    ];
  }

  function _getSchedSettingOptions() {
    return _getSchedSettingGroups().reduce(function (a, g) {
      return a.concat(g.items);
    }, []);
  }

  async function loadScheduleEditor() {
    var container = $('#settings-grid');
    if (!container) return;
    container.innerHTML =
      '<div class="feed-empty">' +
      i18next.t('web:empty_states.loading_schedule', { defaultValue: 'Loading schedule...' }) +
      '</div>';

    try {
      var r = await apiFetch('/api/panel/scheduler');
      var sched = await r.json();
      S.scheduleData = sched;
    } catch (_e) {
      S.scheduleData = null;
    }

    var data = S.scheduleData || {};
    _schedEdit.times = (data.restartTimes || []).slice();
    _schedEdit.profiles = (data.profiles || []).slice();
    _schedEdit.settings = {};
    var ps = data.profileSettings || {};
    for (var i = 0; i < _schedEdit.profiles.length; i++) {
      var n = _schedEdit.profiles[i];
      _schedEdit.settings[n] = ps[n] ? Object.assign({}, ps[n]) : {};
    }
    _schedEdit.rotateDaily = !!data.rotateDaily;
    _schedEdit.serverNameTemplate = data.serverNameTemplate || '';
    if (!_schedEdit.serverNameTemplate) {
      for (var pi = 0; pi < _schedEdit.profiles.length; pi++) {
        var pSettings = _schedEdit.settings[_schedEdit.profiles[pi]] || {};
        var sn = pSettings.ServerName;
        if (sn) {
          sn = sn.replace(/^"|"$/g, '');
          var pName = _schedEdit.profiles[pi];
          var capName = pName.charAt(0).toUpperCase() + pName.slice(1);
          if (sn.includes(capName)) {
            _schedEdit.serverNameTemplate = sn.replace(capName, '{mode}');
          }
          break;
        }
      }
    }

    _renderScheduleInline(container, data);
  }

  // The schedule editor inline render and wire functions are very long.
  // They are included below but condensed for module extraction.
  // All original logic is preserved exactly.

  function _renderScheduleInline(container, data) {
    container.innerHTML = '';
    var isActive = data && data.active;
    var banner = el(
      'div',
      'flex items-center gap-2 text-xs px-3 py-2 rounded-lg border ' +
        (isActive ? 'bg-accent/5 border-accent/20 text-accent' : 'bg-surface-50 border-border text-muted'),
    );
    banner.innerHTML =
      '<i data-lucide="' +
      (isActive ? 'check-circle' : 'info') +
      '" class="w-3.5 h-3.5"></i>' +
      (isActive
        ? i18next.t('web:settings.schedule_active_banner', {
            profiles: _schedEdit.profiles.length || 0,
            restarts: _schedEdit.times.length || 0,
            defaultValue: 'Schedule is active — {{profiles}} profile(s), {{restarts}} restart time(s)',
          })
        : i18next.t('web:settings.schedule_inactive_banner', {
            defaultValue: 'No schedule configured — add restart times and profiles below',
          }));
    container.appendChild(banner);

    if (isActive) {
      var preview = el('div', 'card');
      var prevHdr = el('div', 'flex items-center justify-between mb-3');
      prevHdr.innerHTML =
        '<h3 class="card-title mb-0">' +
        i18next.t('web:settings.current_schedule', { defaultValue: 'Current Schedule' }) +
        '</h3>';
      preview.appendChild(prevHdr);
      var prevBody = el('div', 'space-y-2');
      prevBody.id = 'sched-inline-preview';
      renderSchedule(prevBody, data, 'dashboard');
      if (data.rotateDaily && data.tomorrowSchedule) {
        renderTomorrowSchedule(prevBody, data);
      }
      preview.appendChild(prevBody);
      container.appendChild(preview);
    }

    if (S.tier < 3) {
      if (!isActive)
        container.innerHTML =
          '<div class="feed-empty">' + i18next.t('web:empty_states.no_schedule_configured_for_server') + '</div>';
      lucide.createIcons({ attrs: { class: '' } });
      return;
    }

    var editorWrap = el('div', 'space-y-5');

    // Restart Times
    var timesSection = el('div', 'card');
    timesSection.innerHTML =
      '<h3 class="card-title flex items-center gap-2"><i data-lucide="clock" class="w-4 h-4 text-muted"></i> ' +
      i18next.t('web:settings.restart_times') +
      '</h3>' +
      '<p class="text-[10px] text-muted mb-3">' +
      i18next.t('web:settings.restart_times_description') +
      '</p>';
    var timesList = el('div', 'flex flex-wrap gap-2 mb-3');
    timesList.id = 'sched-times-list';
    timesSection.appendChild(timesList);
    var addTimeRow = el('div', 'flex items-center gap-2');
    addTimeRow.innerHTML =
      '<input type="time" id="sched-add-time" class="input-field w-28 text-xs py-1">' +
      '<button id="sched-add-time-btn" class="text-xs px-2.5 py-1 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors">' +
      i18next.t('web:settings.add_time') +
      '</button>';
    timesSection.appendChild(addTimeRow);
    editorWrap.appendChild(timesSection);

    // Profiles
    var profilesSection = el('div', 'card');
    profilesSection.innerHTML =
      '<h3 class="card-title flex items-center gap-2"><i data-lucide="layers" class="w-4 h-4 text-muted"></i> ' +
      i18next.t('web:settings.profiles') +
      '</h3>' +
      '<p class="text-[10px] text-muted mb-3">' +
      i18next.t('web:settings.profiles_description') +
      '</p>';
    var profilesList = el('div', '');
    profilesList.id = 'sched-profiles-list';
    profilesSection.appendChild(profilesList);
    var addProfileRow = el('div', 'flex items-center gap-2 mt-3');
    addProfileRow.innerHTML =
      '<input type="text" id="sched-add-profile" placeholder="' +
      i18next.t('web:settings.profile_name_placeholder') +
      '" class="input-field w-40 text-xs py-1">' +
      '<button id="sched-add-profile-btn" class="text-xs px-2.5 py-1 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors">' +
      i18next.t('web:settings.add_profile') +
      '</button>';
    profilesSection.appendChild(addProfileRow);
    editorWrap.appendChild(profilesSection);

    // Server Name Template
    var nameSection = el('div', 'card');
    nameSection.innerHTML =
      '<h3 class="card-title flex items-center gap-2"><i data-lucide="type" class="w-4 h-4 text-muted"></i> ' +
      i18next.t('web:settings.server_name_template') +
      '</h3>' +
      '<p class="text-[10px] text-muted mb-3">' +
      i18next.t('web:settings.server_name_template_description') +
      '</p>' +
      '<input type="text" id="sched-name-template" placeholder="' +
      i18next.t('web:settings.server_name_template_placeholder') +
      '" class="input-field w-full text-xs py-1.5 font-mono" value="' +
      esc(_schedEdit.serverNameTemplate) +
      '">';
    editorWrap.appendChild(nameSection);

    // Options
    var optSection = el('div', 'card');
    var rotateLabel = el('label', 'flex items-center gap-2 text-xs text-text cursor-pointer select-none');
    rotateLabel.innerHTML =
      '<input type="checkbox" id="sched-rotate-daily" class="accent-accent rounded w-3.5 h-3.5"' +
      (_schedEdit.rotateDaily ? ' checked' : '') +
      '> ' +
      i18next.t('web:settings.rotate_profiles_daily');
    optSection.appendChild(rotateLabel);
    editorWrap.appendChild(optSection);

    // Save bar
    var saveBar = el('div', 'flex items-center justify-end gap-3 pt-2');
    saveBar.innerHTML =
      '<span id="sched-editor-status" class="text-[10px] text-muted"></span>' +
      '<button id="sched-editor-save" class="btn-primary flex items-center gap-1.5"><i data-lucide="save" class="w-3.5 h-3.5"></i> ' +
      i18next.t('web:settings.save_schedule') +
      '</button>';
    editorWrap.appendChild(saveBar);

    container.appendChild(editorWrap);
    _renderSchedTimes();
    _renderSchedProfiles();
    _wireScheduleEvents();
    lucide.createIcons({ attrs: { class: '' } });
  }

  function _wireScheduleEvents() {
    var addTimeBtn = $('#sched-add-time-btn');
    if (addTimeBtn)
      addTimeBtn.onclick = function () {
        var inp = $('#sched-add-time');
        var val = inp.value;
        if (!val) return;
        var parts = val.split(':');
        var t =
          String(parseInt(parts[0], 10)).padStart(2, '0') + ':' + String(parseInt(parts[1], 10) || 0).padStart(2, '0');
        if (_schedEdit.times.indexOf(t) === -1) _schedEdit.times.push(t);
        inp.value = '';
        _renderSchedTimes();
      };

    var addProfileBtn = $('#sched-add-profile-btn');
    if (addProfileBtn)
      addProfileBtn.onclick = function () {
        var inp = $('#sched-add-profile');
        var name = inp.value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '');
        if (!name) return;
        if (_schedEdit.profiles.indexOf(name) === -1) {
          _schedEdit.profiles.push(name);
          _schedEdit.settings[name] = {};
        }
        inp.value = '';
        _renderSchedProfiles();
      };

    var rotateCb = $('#sched-rotate-daily');
    if (rotateCb)
      rotateCb.onchange = function () {
        _schedEdit.rotateDaily = rotateCb.checked;
      };

    var tplInput = $('#sched-name-template');
    if (tplInput)
      tplInput.oninput = function () {
        _schedEdit.serverNameTemplate = tplInput.value;
      };

    var saveBtn = $('#sched-editor-save');
    if (saveBtn) saveBtn.onclick = _saveSchedule;
  }

  function _renderSchedTimes() {
    var c = $('#sched-times-list');
    if (!c) return;
    c.innerHTML = '';
    _schedEdit.times.sort();
    for (var i = 0; i < _schedEdit.times.length; i++) {
      (function (idx) {
        var t = _schedEdit.times[idx];
        var chip = el(
          'div',
          'flex items-center gap-1.5 bg-surface-50 border border-border rounded px-2.5 py-1 text-xs font-mono',
        );
        chip.innerHTML = '<span>' + esc(t) + '</span>';
        var btn = el('button', 'text-muted hover:text-horde transition-colors');
        btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i>';
        btn.onclick = function () {
          _schedEdit.times.splice(idx, 1);
          _renderSchedTimes();
        };
        chip.appendChild(btn);
        c.appendChild(chip);
      })(i);
    }
    lucide.createIcons({ attrs: { class: '' } });
  }

  function _renderSchedProfiles() {
    var c = $('#sched-profiles-list');
    if (!c) return;
    c.innerHTML = '';
    for (var i = 0; i < _schedEdit.profiles.length; i++) {
      (function (idx) {
        var name = _schedEdit.profiles[idx];
        var settings = _schedEdit.settings[name] || {};
        var card = el('div', 'sched-profile-card');
        var hdr = el('div', 'sched-profile-hdr');
        var colorCls = name.includes('calm')
          ? 'text-calm'
          : name.includes('surge')
            ? 'text-surge'
            : name.includes('horde')
              ? 'text-horde'
              : 'text-accent';
        hdr.innerHTML =
          '<span class="text-sm font-medium ' +
          colorCls +
          '">' +
          esc(name.charAt(0).toUpperCase() + name.slice(1)) +
          '</span>';
        var actions = el('div', 'flex items-center gap-2');
        var dupeBtn = el('button', 'text-[10px] text-muted hover:text-accent transition-colors');
        dupeBtn.textContent = i18next.t('web:schedule_editor.duplicate');
        dupeBtn.onclick = function () {
          var newName = name + '-copy';
          var suffix = 2;
          while (_schedEdit.profiles.indexOf(newName) >= 0) newName = name + '-copy' + suffix++;
          _schedEdit.profiles.push(newName);
          _schedEdit.settings[newName] = Object.assign({}, _schedEdit.settings[name] || {});
          delete _schedEdit.settings[newName].ServerName;
          _renderSchedProfiles();
        };
        actions.appendChild(dupeBtn);
        var removeBtn = el('button', 'text-[10px] text-muted hover:text-horde transition-colors');
        removeBtn.textContent = i18next.t('web:schedule_editor.remove');
        removeBtn.onclick = function () {
          _schedEdit.profiles.splice(idx, 1);
          delete _schedEdit.settings[name];
          _renderSchedProfiles();
        };
        actions.appendChild(removeBtn);
        hdr.appendChild(actions);
        card.appendChild(hdr);

        var _groups = _getSchedSettingGroups();
        for (var gi = 0; gi < _groups.length; gi++) {
          (function (group) {
            var section = el('div', 'sched-settings-group');
            var groupHdr = el('div', 'sched-group-hdr');
            groupHdr.innerHTML =
              '<i data-lucide="' + group.icon + '" class="w-3 h-3"></i><span>' + group.header + '</span>';
            section.appendChild(groupHdr);
            var grid = el('div', 'sched-settings-grid');
            for (var si = 0; si < group.items.length; si++) {
              (function (opt) {
                var row = el('div', 'sched-setting-row');
                var lbl = el('span', 'sched-setting-label');
                lbl.textContent = opt.label;
                row.appendChild(lbl);
                var curVal = settings[opt.key] != null ? String(settings[opt.key]) : '';
                var input;
                if (opt.type === 'select') {
                  input = document.createElement('select');
                  input.className = 'input-field text-[10px] py-0.5 px-1.5 w-24';
                  var emptyOpt = document.createElement('option');
                  emptyOpt.value = '';
                  emptyOpt.textContent = '— ' + i18next.t('web:schedule.default') + ' —';
                  input.appendChild(emptyOpt);
                  for (var val in opt.opts) {
                    var o = document.createElement('option');
                    o.value = val;
                    o.textContent = opt.opts[val];
                    if (val === curVal) o.selected = true;
                    input.appendChild(o);
                  }
                } else {
                  input = document.createElement('input');
                  input.type = 'number';
                  input.step = opt.step || '1';
                  input.min = '0';
                  input.className = 'input-field text-[10px] py-0.5 px-1.5 w-20';
                  input.placeholder = i18next.t('web:schedule.default');
                  if (curVal) input.value = curVal;
                }
                input.onchange = function () {
                  if (!_schedEdit.settings[name]) _schedEdit.settings[name] = {};
                  if (input.value === '') delete _schedEdit.settings[name][opt.key];
                  else _schedEdit.settings[name][opt.key] = input.value;
                };
                row.appendChild(input);
                grid.appendChild(row);
              })(group.items[si]);
            }
            section.appendChild(grid);
            card.appendChild(section);
          })(_groups[gi]);
        }
        c.appendChild(card);
      })(i);
    }
    lucide.createIcons({ attrs: { class: '' } });
  }

  function _saveSchedule() {
    var statusEl = $('#sched-editor-status');
    if (statusEl) {
      statusEl.textContent = i18next.t('web:schedule_editor.saving');
      statusEl.style.color = '#d4a843';
    }
    var tpl = ($('#sched-name-template') || {}).value || '';
    if (tpl) {
      for (var pi = 0; pi < _schedEdit.profiles.length; pi++) {
        var pn = _schedEdit.profiles[pi];
        var capName = pn.charAt(0).toUpperCase() + pn.slice(1);
        if (!_schedEdit.settings[pn]) _schedEdit.settings[pn] = {};
        _schedEdit.settings[pn].ServerName = '"' + tpl.replace(/\{mode\}/gi, capName) + '"';
      }
    }
    var payload = {
      restartTimes: _schedEdit.times,
      profiles: _schedEdit.profiles,
      profileSettings: _schedEdit.settings,
      rotateDaily: $('#sched-rotate-daily').checked,
      serverNameTemplate: tpl,
    };
    apiFetch('/api/panel/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data.ok) {
          if (statusEl) {
            statusEl.textContent = i18next.t('web:schedule_editor.saved_restart');
            statusEl.style.color = '#6dba82';
          }
          setTimeout(function () {
            loadScheduleEditor();
          }, 1200);
        } else {
          if (statusEl) {
            statusEl.textContent = data.error || i18next.t('web:toast.save_failed');
            statusEl.style.color = '#c45a4a';
          }
        }
      })
      .catch(function (_e) {
        if (statusEl) {
          statusEl.textContent = i18next.t('web:schedule_editor.network_error');
          statusEl.style.color = '#c45a4a';
        }
      });
  }

  // Wire up schedule editor modal close buttons
  (function () {
    var closeBtn = $('#sched-editor-close');
    if (closeBtn)
      closeBtn.onclick = function () {
        $('#sched-editor-modal').classList.add('hidden');
      };
    var cancelBtn = $('#sched-editor-cancel');
    if (cancelBtn)
      cancelBtn.onclick = function () {
        $('#sched-editor-modal').classList.add('hidden');
      };
  })();

  function reset() {
    _inited = false;
  }

  Panel.tabs.settings = {
    init: init,
    load: function () {
      if (S.settingsMode === 'bot') loadBotConfig();
      else if (S.settingsMode === 'schedule') loadScheduleEditor();
      else loadSettings();
    },
    reset: reset,
    loadSettings: loadSettings,
    loadBotConfig: loadBotConfig,
    loadScheduleEditor: loadScheduleEditor,
    filterSettings: filterSettings,
    showSettingsDiff: showSettingsDiff,
    resetSettingsChanges: resetSettingsChanges,
    commitSettings: commitSettings,
    commitBotConfig: commitBotConfig,
    // Exposed for dashboard schedule rendering
    renderSchedule: renderSchedule,
    renderTomorrowSchedule: renderTomorrowSchedule,
  };
})();
