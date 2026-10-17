/* ==========================================================================
   core.js — shared helpers: theme, API access, formatting, status rendering.
   Exposes window.KB.core. Loaded on every page.
   ========================================================================== */

window.KB = window.KB || {};

window.KB.core = (function () {
  'use strict';

  /* ------------------------------------------------------------------ theme */

  var THEME_KEY = 'kb.theme';

  /* Storage can throw outright (private mode, blocked site data), so every
     access is guarded and the page renders fine with no stored value. */
  function readTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }

  function writeTheme(value) {
    try {
      if (value) window.localStorage.setItem(THEME_KEY, value);
      else window.localStorage.removeItem(THEME_KEY);
    } catch (e) { /* non-fatal */ }
  }

  function applyTheme(value) {
    if (value === 'dark' || value === 'light') {
      document.documentElement.setAttribute('data-theme', value);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function initTheme() {
    applyTheme(readTheme());

    var button = document.querySelector('[data-theme-toggle]');
    if (!button) return;

    button.addEventListener('click', function () {
      var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      var current = document.documentElement.getAttribute('data-theme') ||
        (dark ? 'dark' : 'light');
      var next = current === 'dark' ? 'light' : 'dark';

      applyTheme(next);
      writeTheme(next);
      button.setAttribute('aria-label',
        next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    });
  }

  /* -------------------------------------------------------------------- API */

  /** GET a JSON endpoint. Throws an Error carrying the server's problem title. */
  function getJson(url, options) {
    var opts = options || {};

    return fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: opts.signal,
    }).then(function (response) {
      var type = response.headers.get('content-type') || '';

      if (!response.ok) {
        // ASP.NET problem details carry a useful title/detail; surface those.
        if (type.indexOf('json') !== -1) {
          return response.json().then(function (problem) {
            var error = new Error(problem.detail || problem.title || response.statusText);
            error.title = problem.title;
            error.status = response.status;
            throw error;
          }, function () {
            throw httpError(response);
          });
        }
        throw httpError(response);
      }

      return response.json();
    });
  }

  function httpError(response) {
    var error = new Error(
      response.status === 401 || response.status === 403
        ? 'You are not authorised to view this data.'
        : 'Request failed (' + response.status + ' ' + response.statusText + ').');
    error.status = response.status;
    return error;
  }

  function getText(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw httpError(response);
      return response.text();
    });
  }

  /* --------------------------------------------------------------- identity */

  function initUser() {
    var slot = document.querySelector('[data-user]');
    if (!slot) return;

    getJson('api/me').then(function (me) {
      if (me && me.shortName) {
        slot.textContent = me.shortName;
        slot.title = me.name || me.shortName;
      } else {
        slot.textContent = '';
      }
    }).catch(function () {
      slot.textContent = '';
    });
  }

  /* ------------------------------------------------------------- formatting */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatNumber(value) {
    if (value == null || isNaN(value)) return '--';
    return Number(value).toLocaleString();
  }

  function formatDate(value) {
    if (!value) return '';

    var date = parseDate(value);
    if (!date) return String(value);

    return date.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  /* A bare "2026-10-14" is parsed as UTC midnight by Date, which renders as
     the previous day anywhere west of Greenwich. Front matter dates are
     calendar dates, not instants, so build them in local time. */
  function parseDate(value) {
    var text = String(value).trim();
    var ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    var date = ymd
      ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
      : new Date(text);

    return isNaN(date.getTime()) ? null : date;
  }

  function relativeTime(value) {
    if (!value) return '';
    var date = parseDate(value);
    if (!date) return '';

    var seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
    if (seconds < 2592000) return Math.floor(seconds / 86400) + ' d ago';
    return formatDate(value);
  }

  /* ----------------------------------------------------------------- status */

  var SEVERITY_LABELS = {
    good: 'Up',
    warning: 'Warning',
    serious: 'Acknowledged',
    critical: 'Down',
    paused: 'Paused',
    unknown: 'Unknown',
  };

  /* Status always renders as dot + text: hue never carries meaning alone. */
  function statusPill(severity, text) {
    var kind = SEVERITY_LABELS[severity] ? severity : 'unknown';
    return '<span class="pill pill--' + kind + '">' +
      '<i class="pill__dot"></i>' +
      escapeHtml(text || SEVERITY_LABELS[kind]) +
      '</span>';
  }

  function severityLabel(severity) {
    return SEVERITY_LABELS[severity] || 'Unknown';
  }

  /* ------------------------------------------------------------------- misc */

  function setBusy(host, lines) {
    var count = lines || 3;
    var html = '';
    for (var i = 0; i < count; i++) {
      html += '<div class="skeleton" style="width:' + (100 - i * 12) + '%"></div>';
    }
    host.innerHTML = '<div style="padding:18px">' + html + '</div>';
  }

  function showError(host, error, context) {
    var message = error && error.message ? error.message : 'Something went wrong.';
    host.innerHTML =
      '<div class="notice notice--error"><div><strong>' +
      escapeHtml(context || 'Could not load data') + '</strong><br>' +
      escapeHtml(message) + '</div></div>';
  }

  function showEmpty(host, text) {
    host.innerHTML = '<div class="empty">' + escapeHtml(text) + '</div>';
  }

  /** Marks the nav link matching the current page. */
  function initNav() {
    var here = location.pathname.replace(/\/$/, '/index.html').toLowerCase();

    Array.prototype.forEach.call(
      document.querySelectorAll('.nav__link'),
      function (link) {
        var target = link.getAttribute('href').toLowerCase();
        if (here.indexOf(target.replace(/^\./, '')) !== -1) {
          link.setAttribute('aria-current', 'page');
        }
      });
  }

  function init() {
    initTheme();
    initUser();
    initNav();
  }

  return {
    init: init,
    initTheme: initTheme,
    getJson: getJson,
    getText: getText,
    escapeHtml: escapeHtml,
    formatNumber: formatNumber,
    formatDate: formatDate,
    relativeTime: relativeTime,
    statusPill: statusPill,
    severityLabel: severityLabel,
    setBusy: setBusy,
    showError: showError,
    showEmpty: showEmpty,
  };
})();
