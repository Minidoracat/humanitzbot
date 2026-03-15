/**
 * Panel Tab: Database — table browser, query builder, raw SQL, and CSV export.
 * @namespace Panel.tabs.database
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  var S = Panel.core.S;
  var $ = Panel.core.$;
  var el = Panel.core.el;
  var esc = Panel.core.esc;
  var apiFetch = Panel.core.apiFetch;
  var fmtDateTime = Panel.core.utils.fmtDateTime;
  var fmtNum = Panel.core.utils.fmtNum;
  var humanizeSettingKey = Panel.core.utils.humanizeSettingKey;
  var showToast = Panel.core.utils.showToast;

  var _inited = false;

  function init() {
    if (_inited) return;
    _inited = true;
  }

  // ── Data Loading ────────────────────────────────────────────────

  async function loadDatabase() {
    var container = $('#db-results');
    if (!container) return;
    var table = $('#db-table') ? $('#db-table').value : 'activity_log';
    var search = ($('#db-search') ? $('#db-search').value : '').trim();
    var limit = parseInt($('#db-limit') ? $('#db-limit').value : '50', 10);

    container.innerHTML =
      '<div class="feed-empty">' + i18next.t('web:loading.generic', { defaultValue: 'Loading...' }) + '</div>';

    try {
      var params = new URLSearchParams({ limit: String(limit) });
      if (search) params.set('search', search);
      var r = await apiFetch('/api/panel/db/' + table + '?' + params);
      if (!r.ok) {
        var err = {};
        try {
          err = await r.json();
        } catch (_e) {}
        container.innerHTML = '<div class="feed-empty">Error: ' + esc(err.error || r.statusText) + '</div>';
        return;
      }
      var d = await r.json();
      var rows = d.rows || [];
      var columns = d.columns || [];
      S.dbLastResult = { table: table, rows: rows, columns: columns };
      if (!rows.length) {
        container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_data_found') + '</div>';
        return;
      }
      renderDbTable(container, rows, columns);
    } catch (e) {
      container.innerHTML =
        '<div class="feed-empty">' +
        i18next.t('web:empty_states.failed_to_load_data', {
          message: esc(e.message),
          defaultValue: 'Failed to load data: {{message}}',
        }) +
        '</div>';
    }
  }

  // ── Table Rendering ─────────────────────────────────────────────

  function renderDbTable(container, rows, columns) {
    if (!rows || !rows.length) {
      container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_data') + '</div>';
      return;
    }
    var hasResolved = rows.some(function (r) {
      return r._resolved_name;
    });

    var steamToName = {};
    for (var pi = 0; pi < S.players.length; pi++) {
      if (S.players[pi].steamId) steamToName[S.players[pi].steamId] = S.players[pi].name;
    }

    var steamCols = {};
    for (var sc = 0; sc < columns.length; sc++) {
      var cn = columns[sc].toLowerCase();
      if (cn === 'steam_id' || cn === 'target_steam_id' || cn === 'steamid' || cn === 'owner_steam_id')
        steamCols[columns[sc]] = true;
    }

    var fkMap = {
      player_id: 'players',
      clan_id: 'clans',
      steam_id: 'activity_log',
      target_steam_id: 'activity_log',
      owner_steam_id: 'players',
    };

    var table = el('table', 'db-table');
    var thead = el('thead');
    var headRow = el('tr');
    for (var ci = 0; ci < columns.length; ci++) {
      headRow.appendChild(el('th', '', humanizeSettingKey(columns[ci])));
    }
    if (hasResolved)
      headRow.appendChild(el('th', '', i18next.t('web:table.player_name', { defaultValue: 'Player Name' })));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      var tr = el('tr');
      for (var ci2 = 0; ci2 < columns.length; ci2++) {
        var col = columns[ci2];
        var td = el('td');
        var val = row[col];
        if (val == null) val = '';
        else if (typeof val === 'object') val = JSON.stringify(val);
        if (
          (col === 'created_at' ||
            col === 'updated_at' ||
            col === 'first_seen' ||
            col === 'last_seen' ||
            col === 'timestamp') &&
          val
        ) {
          try {
            val = fmtDateTime(val) || val;
          } catch (_e) {}
        }

        if (steamCols[col] && val && String(val).length > 10) {
          var resolved = steamToName[String(val)] || '';
          td.innerHTML =
            '<span class="player-link text-accent cursor-pointer" data-steam-id="' +
            esc(String(val)) +
            '">' +
            esc(resolved || String(val)) +
            '</span>';
          if (resolved) td.title = String(val);
          else td.title = String(val);
        } else if (fkMap[col] && val && !steamCols[col]) {
          var linkEl = document.createElement('span');
          linkEl.className = 'db-link text-accent cursor-pointer hover:underline';
          linkEl.dataset.table = fkMap[col];
          linkEl.dataset.search = String(val);
          linkEl.textContent = String(val);
          td.appendChild(linkEl);
          td.title = i18next.t('web:database.click_to_lookup_in', {
            table: fkMap[col],
            defaultValue: 'Click to look up in {{table}}',
          });
        } else if (typeof val === 'number' && val > 9999) td.textContent = fmtNum(val);
        else td.textContent = String(val);

        if (!td.title) td.title = String(row[col] != null ? row[col] : '');
        tr.appendChild(td);
      }
      if (hasResolved) {
        var nameTd = el('td');
        nameTd.textContent = row._resolved_name || '';
        nameTd.className = 'text-accent';
        tr.appendChild(nameTd);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);
  }

  // ── CSV Export ───────────────────────────────────────────────────

  function exportDbCsv() {
    if (!S.dbLastResult || !S.dbLastResult.rows.length) return;
    var d = S.dbLastResult;
    var cols = d.columns;
    var rows = d.rows;

    var lines = [];
    lines.push(cols.map(csvEsc).join(','));
    for (var i = 0; i < rows.length; i++) {
      var cells = [];
      for (var j = 0; j < cols.length; j++) {
        var val = rows[i][cols[j]];
        if (val == null) val = '';
        else if (typeof val === 'object') val = JSON.stringify(val);
        cells.push(csvEsc(String(val)));
      }
      lines.push(cells.join(','));
    }

    var csv = lines.join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = d.table + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvEsc(str) {
    if (!str) return '';
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // ── Live Table List ─────────────────────────────────────────────

  async function fetchDbTableList() {
    try {
      var r = await apiFetch('/api/panel/db/tables');
      if (!r.ok) return;
      var d = await r.json();
      S.dbTablesLive = d.tables || [];
      var selects = [$('#db-table'), $('#qb-table')];
      for (var si = 0; si < selects.length; si++) {
        var sel = selects[si];
        if (!sel) continue;
        var prevVal = sel.value;
        sel.innerHTML = '';
        for (var i = 0; i < S.dbTablesLive.length; i++) {
          var t = S.dbTablesLive[i];
          var opt = document.createElement('option');
          opt.value = t.name;
          opt.textContent =
            t.name +
            ' (' +
            (t.rowCount || 0).toLocaleString() +
            ' ' +
            i18next.t('web:database.rows', { defaultValue: 'rows' }) +
            ')';
          sel.appendChild(opt);
        }
        if (prevVal) sel.value = prevVal;
      }
      for (var j = 0; j < S.dbTablesLive.length; j++) {
        S.dbSchemaCache[S.dbTablesLive[j].name] = S.dbTablesLive[j].columns || [];
      }
    } catch (_e) {
      /* ignore — will fall back to static list */
    }
  }

  // ── Schema Viewer ───────────────────────────────────────────────

  function showDbSchema() {
    var table = $('#db-table') ? $('#db-table').value : '';
    var container = $('#db-schema-info');
    if (!container) return;
    var cols = S.dbSchemaCache[table];
    if (!cols || !cols.length) {
      container.innerHTML =
        '<span class="text-muted text-xs">' + i18next.t('web:empty_states.no_schema_info_available') + '</span>';
      return;
    }
    var html = '<div class="overflow-x-auto"><table class="db-table text-xs"><thead><tr>';
    html +=
      '<th>' +
      i18next.t('web:table.column', { defaultValue: 'Column' }) +
      '</th><th>' +
      i18next.t('web:table.type', { defaultValue: 'Type' }) +
      '</th><th>' +
      i18next.t('web:table.pk', { defaultValue: 'PK' }) +
      '</th><th>' +
      i18next.t('web:table.nullable', { defaultValue: 'Nullable' }) +
      '</th>';
    html += '</tr></thead><tbody>';
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      html += '<tr>';
      html += '<td class="font-mono text-accent">' + esc(c.name) + '</td>';
      html += '<td>' + esc(c.type || 'TEXT') + '</td>';
      html += '<td>' + (c.pk ? '\u2713' : '') + '</td>';
      html +=
        '<td>' +
        (c.nullable
          ? i18next.t('web:table.yes', { defaultValue: 'yes' })
          : i18next.t('web:table.no', { defaultValue: 'no' })) +
        '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    container.innerHTML = html;
  }

  // ── Query Builder ───────────────────────────────────────────────

  function updateQbColumns() {
    var table = $('#qb-table') ? $('#qb-table').value : '';
    var cols = S.dbSchemaCache[table] || [];
    var whereCol = $('#qb-where-col');
    var orderCol = $('#qb-order-col');
    var selects = [whereCol, orderCol];
    for (var si = 0; si < selects.length; si++) {
      var sel = selects[si];
      if (!sel) continue;
      sel.innerHTML = '<option value="">--</option>';
      for (var i = 0; i < cols.length; i++) {
        var opt = document.createElement('option');
        opt.value = cols[i].name;
        opt.textContent = cols[i].name;
        sel.appendChild(opt);
      }
    }
  }

  function buildQbSql() {
    var table = $('#qb-table') ? $('#qb-table').value : '';
    var columns = ($('#qb-columns') ? $('#qb-columns').value : '').trim() || '*';
    var whereCol = $('#qb-where-col') ? $('#qb-where-col').value : '';
    var whereOp = $('#qb-where-op') ? $('#qb-where-op').value : '=';
    var whereVal = ($('#qb-where-val') ? $('#qb-where-val').value : '').trim();
    var orderCol = $('#qb-order-col') ? $('#qb-order-col').value : '';
    var orderDir = $('#qb-order-dir') ? $('#qb-order-dir').value : 'DESC';
    var limit = ($('#qb-limit') ? $('#qb-limit').value : '100').trim() || '100';

    if (!table) return '';
    var sql = 'SELECT ' + columns + ' FROM ' + table;
    if (whereCol && (whereVal || whereOp === 'IS NULL' || whereOp === 'IS NOT NULL')) {
      if (whereOp === 'IS NULL') sql += ' WHERE ' + whereCol + ' IS NULL';
      else if (whereOp === 'IS NOT NULL') sql += ' WHERE ' + whereCol + ' IS NOT NULL';
      else if (whereOp === 'LIKE') sql += ' WHERE ' + whereCol + " LIKE '%" + whereVal.replace(/'/g, "''") + "%'";
      else if (whereOp === 'IN') sql += ' WHERE ' + whereCol + ' IN (' + whereVal + ')';
      else sql += ' WHERE ' + whereCol + ' ' + whereOp + " '" + whereVal.replace(/'/g, "''") + "'";
    }
    if (orderCol) sql += ' ORDER BY ' + orderCol + ' ' + orderDir;
    sql += ' LIMIT ' + parseInt(limit, 10);
    return sql;
  }

  function updateQbPreview() {
    var preview = $('#qb-preview');
    if (preview) preview.textContent = buildQbSql();
  }

  async function runQueryBuilder() {
    var sql = buildQbSql();
    if (!sql) return showToast(i18next.t('web:toast.select_table_first'), 'error');
    await executeRawQuery(sql);
  }

  async function runRawSql() {
    var input = $('#db-raw-sql');
    var sql = (input ? input.value : '').trim();
    if (!sql) return showToast(i18next.t('web:toast.enter_sql_query'), 'error');
    await executeRawQuery(sql);
  }

  async function executeRawQuery(sql) {
    var container = $('#db-query-results');
    var status = $('#db-query-status');
    if (!container) return;
    container.innerHTML =
      '<div class="feed-empty">' + i18next.t('web:database.running', { defaultValue: 'Running...' }) + '</div>';
    if (status) status.textContent = '';

    try {
      var r = await apiFetch('/api/panel/db/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sql, limit: 500 }),
      });
      var d = await r.json();
      if (d.error) {
        container.innerHTML = '<div class="feed-empty text-danger">' + esc(d.error) + '</div>';
        if (status) status.textContent = i18next.t('web:dashboard.error');
        return;
      }
      var rows = d.rows || [];
      var columns = d.columns || [];
      S.dbLastResult = { table: 'query', rows: rows, columns: columns };
      if (status)
        status.textContent = i18next.t('web:database.rows_returned', {
          count: rows.length,
          defaultValue: '{{count}} row returned',
          defaultValue_plural: '{{count}} rows returned',
        });
      if (!rows.length) {
        container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_results') + '</div>';
        return;
      }
      renderDbTable(container, rows, columns);
    } catch (e) {
      container.innerHTML = '<div class="feed-empty text-danger">Request failed: ' + esc(e.message) + '</div>';
      if (status) status.textContent = i18next.t('web:status.failed', { defaultValue: 'Failed' });
    }
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.database = {
    init: init,
    load: loadDatabase,
    reset: reset,
    exportCsv: exportDbCsv,
    showSchema: showDbSchema,
    fetchTableList: fetchDbTableList,
    updateQbColumns: updateQbColumns,
    updateQbPreview: updateQbPreview,
    runQueryBuilder: runQueryBuilder,
    runRawSql: runRawSql,
    buildQbSql: buildQbSql,
  };
})();
