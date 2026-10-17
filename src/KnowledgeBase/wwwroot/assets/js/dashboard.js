/* ==========================================================================
   dashboard.js — PRTG front page: status row, NetFlow traffic, top talkers,
   SNMP devices and active alarms. All PRTG access goes through /api/prtg/*,
   so no credentials are ever present in the browser.
   ========================================================================== */

(function () {
  'use strict';

  var core = window.KB.core;
  var charts = window.KB.charts;

  var REFRESH_MS = 60000;
  var state = {
    prtgWebUrl: '',
    flowSensors: [],
    selectedFlowId: null,
    hours: 6,
    timer: null,
  };

  /* --------------------------------------------------------------- helpers */

  function $(id) { return document.getElementById(id); }

  /** Deep-links a sensor into PRTG when the base URL is known. */
  function sensorLink(sensor) {
    var label = core.escapeHtml(sensor.sensor);
    if (!state.prtgWebUrl) return label;

    return '<a href="' + core.escapeHtml(state.prtgWebUrl) +
      '/sensor.htm?id=' + encodeURIComponent(sensor.id) +
      '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  }

  /* PRTG averaging interval, picked so a window yields a readable point count. */
  function averageFor(hours) {
    if (hours <= 2) return 60;
    if (hours <= 12) return 300;
    if (hours <= 48) return 900;
    return 3600;
  }

  /* ----------------------------------------------------------- status row */

  function renderSummary(summary) {
    state.prtgWebUrl = summary.webUrl || '';

    // Hero figure: the one number the page leads with.
    $('stat-total').textContent = core.formatNumber(summary.total);

    var healthy = summary.total
      ? Math.round((summary.up / summary.total) * 1000) / 10
      : 0;
    $('stat-total-foot').textContent = healthy + '% reporting normally';

    setStat('up', summary.up);
    setStat('warning', summary.warning);
    setStat('down', summary.down);

    $('stat-mix-foot').textContent =
      core.formatNumber(summary.flowSensors) + ' flow · ' +
      core.formatNumber(summary.snmpSensors) + ' SNMP';

    var version = $('prtg-version');
    if (version) {
      version.textContent = summary.version
        ? 'PRTG ' + summary.version
        : (summary.reachable ? 'PRTG connected' : 'PRTG unreachable');
    }
  }

  function setStat(key, value) {
    var node = $('stat-' + key);
    if (node) node.textContent = core.formatNumber(value);
  }

  /* ------------------------------------------------------- netflow traffic */

  function renderFlowPicker() {
    var picker = $('flow-sensor');
    picker.innerHTML = '';

    if (!state.flowSensors.length) {
      picker.innerHTML = '<option value="">No flow sensors found</option>';
      picker.disabled = true;
      return;
    }

    picker.disabled = false;
    state.flowSensors.forEach(function (sensor) {
      var option = document.createElement('option');
      option.value = sensor.id;
      option.textContent = sensor.device + ' — ' + sensor.sensor;
      picker.appendChild(option);
    });

    if (state.selectedFlowId) picker.value = state.selectedFlowId;
  }

  function loadFlowChart() {
    var host = $('flow-chart');
    var meta = $('flow-meta');

    if (!state.selectedFlowId) {
      core.showEmpty(host,
        'No NetFlow, IPFIX, sFlow or jFlow sensors were found on this PRTG server.');
      meta.textContent = '';
      return;
    }

    core.setBusy(host, 4);

    var sensor = state.flowSensors.filter(function (s) {
      return String(s.id) === String(state.selectedFlowId);
    })[0];

    meta.innerHTML = sensor
      ? core.statusPill(sensor.severity, core.severityLabel(sensor.severity)) +
        ' <span class="muted">' + core.escapeHtml(sensor.lastValue || '') + '</span>'
      : '';

    core.getJson('api/prtg/sensors/' + encodeURIComponent(state.selectedFlowId) +
                 '/history?hours=' + state.hours + '&avg=' + averageFor(state.hours))
      .then(function (history) {
        if (!history.channels.length || !history.points.length) {
          core.showEmpty(host,
            'PRTG returned no history for this sensor in the selected window.');
          return;
        }

        // Channel count is unbounded in PRTG; past 8 the categorical palette
        // would have to cycle, so the rest fold into a single "Other" series.
        var channels = history.channels.slice();
        var totalsIndex = channels.findIndex
          ? channels.findIndex(isTotalChannel)
          : indexOfTotal(channels);

        var series = buildSeries(history, channels, totalsIndex);

        charts.lineChart(host, {
          labels: history.points.map(function (p) { return p.label; }),
          series: series,
          unit: '',
          area: series.length === 1,
          height: 260,
          ariaLabel: 'Traffic per channel over the last ' + state.hours + ' hours',
        });
      })
      .catch(function (error) {
        core.showError(host, error, 'Could not load traffic history');
      });
  }

  function isTotalChannel(name) {
    return /^total$/i.test(String(name).trim());
  }

  function indexOfTotal(channels) {
    for (var i = 0; i < channels.length; i++) {
      if (isTotalChannel(channels[i])) return i;
    }
    return -1;
  }

  /**
   * Builds plot series from PRTG channels. "Total" is dropped when per-channel
   * breakdowns exist — plotting a total beside its own parts double-reads the
   * same traffic and squashes the components against the axis.
   */
  function buildSeries(history, channels, totalsIndex) {
    var keep = [];
    channels.forEach(function (name, index) {
      if (index === totalsIndex && channels.length > 1) return;
      keep.push({ name: name, index: index });
    });

    if (!keep.length) keep = [{ name: channels[0], index: 0 }];

    var MAX_SERIES = 8;
    var primary = keep.slice(0, MAX_SERIES - 1);
    var overflow = keep.slice(MAX_SERIES - 1);

    var series = primary.map(function (channel) {
      return {
        name: channel.name,
        values: history.points.map(function (point) {
          return point.v[channel.index];
        }),
      };
    });

    if (overflow.length > 1) {
      series.push({
        name: 'Other (' + overflow.length + ' channels)',
        values: history.points.map(function (point) {
          var sum = null;
          overflow.forEach(function (channel) {
            var value = point.v[channel.index];
            if (value != null && !isNaN(value)) sum = (sum || 0) + value;
          });
          return sum;
        }),
      });
    } else if (overflow.length === 1) {
      series.push({
        name: overflow[0].name,
        values: history.points.map(function (point) {
          return point.v[overflow[0].index];
        }),
      });
    }

    return series;
  }

  /* ----------------------------------------------------------- top talkers */

  function loadToplist() {
    var host = $('toplist');

    if (!state.selectedFlowId) {
      core.showEmpty(host, 'Select a flow sensor to see its top talkers.');
      return;
    }

    core.setBusy(host, 3);

    var sensorId = encodeURIComponent(state.selectedFlowId);

    core.getJson('api/prtg/sensors/' + sensorId + '/toplists')
      .then(function (toplists) {
        if (!toplists.length) {
          core.showEmpty(host,
            'This sensor has no toplists. Enable one in PRTG under the ' +
            'sensor\'s Settings > Toplists to see top talkers here.');
          return;
        }

        return core.getJson('api/prtg/sensors/' + sensorId +
                            '/toplists/' + encodeURIComponent(toplists[0].id))
          .then(function (data) {
            renderToplist(host, toplists[0], data);
          });
      })
      .catch(function (error) {
        core.showError(host, error, 'Could not load top talkers');
      });
  }

  function renderToplist(host, toplist, data) {
    if (!data.rows.length) {
      core.showEmpty(host, 'PRTG returned no rows for "' + toplist.name + '" yet.');
      return;
    }

    // Toplist columns differ per definition, so the value column is discovered
    // rather than assumed: prefer a traffic/bytes column, else the last numeric.
    var columns = data.columns;
    var labelColumn = columns[0];
    var valueColumn = pickValueColumn(columns, data.rows);

    var rows = data.rows.map(function (row) {
      return {
        label: row[labelColumn],
        value: parseLoose(row[valueColumn]),
      };
    }).filter(function (row) {
      return row.value != null;
    }).sort(function (a, b) {
      return b.value - a.value;
    });

    if (!rows.length) {
      // Numbers weren't parseable — show the raw table instead of nothing.
      renderRawToplist(host, columns, data.rows);
      return;
    }

    var caption = document.createElement('p');
    caption.className = 'stat__foot';
    caption.style.margin = '0 0 12px';
    caption.textContent = toplist.name + ' — by ' + valueColumn;

    var chartHost = document.createElement('div');

    host.textContent = '';
    host.appendChild(caption);
    host.appendChild(chartHost);

    charts.barChart(chartHost, {
      rows: rows,
      limit: 8,
      unit: '',
      ariaLabel: 'Top talkers by ' + valueColumn,
    });
  }

  function pickValueColumn(columns, rows) {
    var preferred = ['bytestotal', 'bytes', 'traffictotal', 'traffic',
                     'volume', 'sum', 'total'];

    for (var p = 0; p < preferred.length; p++) {
      for (var c = 0; c < columns.length; c++) {
        if (columns[c].toLowerCase().replace(/[^a-z]/g, '') === preferred[p]) {
          return columns[c];
        }
      }
    }

    // Fall back to the right-most column that parses as a number.
    for (var i = columns.length - 1; i >= 1; i--) {
      if (parseLoose(rows[0][columns[i]]) != null) return columns[i];
    }

    return columns[columns.length - 1];
  }

  /* "1.234.567" / "4,812 MByte" / "12,5 MByte" / "843 kbit/s" -> number or null.
     PRTG formats numbers in the core server's locale, so a separator may be
     either a decimal point or a thousands grouping and the string alone has to
     settle it. */
  function parseLoose(value) {
    if (value == null) return null;

    var text = String(value).trim();
    if (!text) return null;

    var match = text.match(/-?[\d.,\s]+/);
    if (!match) return null;

    var digits = match[0].replace(/\s/g, '').replace(/[.,]$/, '');

    var commas = (digits.match(/,/g) || []).length;
    var dots = (digits.match(/\./g) || []).length;

    if (commas && dots) {
      // Both present: the right-most one is the decimal separator.
      if (digits.lastIndexOf(',') > digits.lastIndexOf('.')) {
        digits = digits.replace(/\./g, '').replace(',', '.');
      } else {
        digits = digits.replace(/,/g, '');
      }
    } else if (commas || dots) {
      var separator = commas ? ',' : '.';
      var count = commas || dots;
      var tail = digits.length - digits.lastIndexOf(separator) - 1;

      // Repeated, or a single one with exactly three digits behind it
      // ("4,812"), is grouping. Anything else is a decimal point ("12,5").
      if (count > 1 || tail === 3) {
        digits = digits.split(separator).join('');
      } else {
        digits = digits.replace(separator, '.');
      }
    }

    var number = parseFloat(digits);
    if (isNaN(number)) return null;

    // Re-apply a unit prefix if the original carried one.
    if (/\bk(byte|bit|B)?\b/i.test(text)) number *= 1e3;
    else if (/\bM(byte|bit|B)?\b/i.test(text)) number *= 1e6;
    else if (/\bG(byte|bit|B)?\b/i.test(text)) number *= 1e9;

    return number;
  }

  function renderRawToplist(host, columns, rows) {
    var html = '<div class="table-scroll"><table class="table"><thead><tr>';
    columns.forEach(function (column) {
      html += '<th>' + core.escapeHtml(column) + '</th>';
    });
    html += '</tr></thead><tbody>';

    rows.slice(0, 10).forEach(function (row) {
      html += '<tr>';
      columns.forEach(function (column) {
        html += '<td>' + core.escapeHtml(row[column]) + '</td>';
      });
      html += '</tr>';
    });

    host.innerHTML = html + '</tbody></table></div>';
  }

  /* ------------------------------------------------------------------ SNMP */

  function loadSnmp() {
    var host = $('snmp-list');
    core.setBusy(host, 5);

    core.getJson('api/prtg/snmp?limit=8')
      .then(function (devices) {
        if (!devices.length) {
          core.showEmpty(host, 'No SNMP sensors were found on this PRTG server.');
          return;
        }

        var html = '<div class="table-scroll"><table class="table">' +
          '<thead><tr><th>Device</th><th>Sensor</th><th>Status</th>' +
          '<th class="num">Last value</th></tr></thead><tbody>';

        devices.forEach(function (device) {
          // Keep each device card readable: show its worst few sensors.
          device.sensors.slice(0, 4).forEach(function (sensor, index) {
            html += '<tr>' +
              '<td>' + (index === 0
                ? '<strong>' + core.escapeHtml(device.device) + '</strong>' +
                  '<div class="stat__foot" style="margin:0">' +
                  core.formatNumber(device.total) + ' sensors</div>'
                : '') + '</td>' +
              '<td class="truncate" title="' + core.escapeHtml(sensor.sensor) + '">' +
                sensorLink(sensor) + '</td>' +
              '<td>' + core.statusPill(sensor.severity,
                sensor.paused ? 'Paused' : core.severityLabel(sensor.severity)) + '</td>' +
              '<td class="num muted">' + core.escapeHtml(sensor.lastValue || '--') + '</td>' +
              '</tr>';
          });
        });

        host.innerHTML = html + '</tbody></table></div>';
      })
      .catch(function (error) {
        core.showError(host, error, 'Could not load SNMP sensors');
      });
  }

  /* ---------------------------------------------------------------- alarms */

  function loadAlarms() {
    var host = $('alarm-list');
    core.setBusy(host, 4);

    core.getJson('api/prtg/alarms?limit=12')
      .then(function (alarms) {
        if (!alarms.length) {
          host.innerHTML =
            '<div class="empty"><span class="dot dot--good"></span> ' +
            'No active alarms. Every sensor is reporting normally.</div>';
          return;
        }

        var html = '<div class="table-scroll"><table class="table">' +
          '<thead><tr><th>Status</th><th>Device</th><th>Sensor</th>' +
          '<th>Message</th></tr></thead><tbody>';

        alarms.forEach(function (alarm) {
          html += '<tr>' +
            '<td>' + core.statusPill(alarm.severity,
              core.severityLabel(alarm.severity)) + '</td>' +
            '<td>' + core.escapeHtml(alarm.device) + '</td>' +
            '<td class="truncate" title="' + core.escapeHtml(alarm.sensor) + '">' +
              sensorLink(alarm) + '</td>' +
            '<td class="truncate muted" title="' + core.escapeHtml(alarm.message) + '">' +
              core.escapeHtml(alarm.message || '--') + '</td>' +
            '</tr>';
        });

        host.innerHTML = html + '</tbody></table></div>';
      })
      .catch(function (error) {
        core.showError(host, error, 'Could not load alarms');
      });
  }

  /* ------------------------------------------------------------------ boot */

  function loadAll() {
    core.getJson('api/prtg/summary')
      .then(renderSummary)
      .catch(function (error) {
        var banner = $('prtg-banner');
        banner.hidden = false;
        banner.innerHTML =
          '<div class="notice notice--error"><div><strong>' +
          core.escapeHtml(error.title || 'PRTG is not available') + '</strong><br>' +
          core.escapeHtml(error.message) +
          '<br>The knowledge base below is unaffected.</div></div>';

        ['stat-total', 'stat-up', 'stat-warning', 'stat-down'].forEach(function (id) {
          var node = $(id);
          if (node) node.textContent = '--';
        });
      });

    core.getJson('api/prtg/netflow')
      .then(function (sensors) {
        state.flowSensors = sensors;

        if (sensors.length && !state.selectedFlowId) {
          state.selectedFlowId = sensors[0].id;
        }

        renderFlowPicker();
        loadFlowChart();
        loadToplist();
      })
      .catch(function (error) {
        core.showError($('flow-chart'), error, 'Could not load flow sensors');
        core.showEmpty($('toplist'), 'Unavailable.');
      });

    loadSnmp();
    loadAlarms();
  }

  function initControls() {
    $('flow-sensor').addEventListener('change', function (event) {
      state.selectedFlowId = event.target.value;
      loadFlowChart();
      loadToplist();
    });

    // Time range: one row of controls above the charts.
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-hours]'),
      function (button) {
        button.addEventListener('click', function () {
          state.hours = Number(button.getAttribute('data-hours'));

          Array.prototype.forEach.call(
            document.querySelectorAll('[data-hours]'),
            function (other) {
              other.setAttribute('aria-pressed',
                other === button ? 'true' : 'false');
            });

          loadFlowChart();
        });
      });

    $('refresh').addEventListener('click', loadAll);
  }

  function initAutoRefresh() {
    function schedule() {
      clearTimeout(state.timer);
      // Don't poll PRTG while the tab is in the background.
      if (document.hidden) return;
      state.timer = setTimeout(function () {
        loadAll();
        schedule();
      }, REFRESH_MS);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearTimeout(state.timer);
      else { loadAll(); schedule(); }
    });

    schedule();
  }

  document.addEventListener('DOMContentLoaded', function () {
    core.init();
    initControls();
    loadAll();
    initAutoRefresh();
  });
})();
