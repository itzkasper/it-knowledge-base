/* ==========================================================================
   docs.js — knowledge base browser: category tree, full-text search over the
   generated index, and markdown article rendering with a table of contents.
   Routing is hash-based (#/sops/reset-ad-account) so IIS needs no rewrite rule.
   ========================================================================== */

(function () {
  'use strict';

  var core = window.KB.core;
  var markdown = window.KB.markdown;

  var INDEX_URL = 'content/index.json';

  var state = {
    index: null,
    docs: [],
    current: null,
    query: '',
  };

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------------ index */

  function loadIndex() {
    return core.getJson(INDEX_URL).then(function (index) {
      state.index = index;
      state.docs = index.documents || [];
      return index;
    });
  }

  /* -------------------------------------------------------------------- tree */

  function renderTree() {
    var host = $('tree');
    var groups = {};
    var order = [];

    state.docs.forEach(function (doc) {
      var category = doc.category || 'Uncategorised';
      if (!groups[category]) {
        groups[category] = [];
        order.push(category);
      }
      groups[category].push(doc);
    });

    order.sort(function (a, b) { return a.localeCompare(b); });

    if (!order.length) {
      host.innerHTML = '<li class="empty">No documents indexed.</li>';
      return;
    }

    var html = '';
    order.forEach(function (category) {
      var docs = groups[category].slice().sort(function (a, b) {
        return a.title.localeCompare(b.title);
      });

      html += '<li class="tree__group">' +
        '<div class="tree__group-title">' + core.escapeHtml(category) +
        '<span class="tree__count">' + docs.length + '</span></div>' +
        '<ul class="tree">';

      docs.forEach(function (doc) {
        html += '<li class="tree__item">' +
          '<a class="tree__link" href="#/' + encodeURI(doc.slug) + '"' +
          (state.current && state.current.slug === doc.slug
            ? ' aria-current="true"' : '') + '>' +
          core.escapeHtml(doc.title) + '</a></li>';
      });

      html += '</ul></li>';
    });

    host.innerHTML = html;
  }

  /* ------------------------------------------------------------------ search */

  /* Scores title matches above heading matches above body matches, so an
     exact SOP name always surfaces first. */
  function search(query) {
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];

    var results = [];

    state.docs.forEach(function (doc) {
      var title = doc.title.toLowerCase();
      var headings = (doc.headings || []).join(' ').toLowerCase();
      var tags = (doc.tags || []).join(' ').toLowerCase();
      var body = (doc.body || '').toLowerCase();
      var score = 0;
      var matchedAll = true;

      terms.forEach(function (term) {
        var hit = 0;
        if (title.indexOf(term) !== -1) hit += title === term ? 120 : 60;
        if (tags.indexOf(term) !== -1) hit += 25;
        if (headings.indexOf(term) !== -1) hit += 15;
        if (body.indexOf(term) !== -1) hit += 5;
        if (!hit) matchedAll = false;
        score += hit;
      });

      if (matchedAll && score > 0) {
        results.push({ doc: doc, score: score, snippet: snippetFor(doc, terms[0]) });
      }
    });

    return results.sort(function (a, b) { return b.score - a.score; }).slice(0, 40);
  }

  function snippetFor(doc, term) {
    var body = doc.body || '';
    var index = body.toLowerCase().indexOf(term);
    if (index === -1) return body.slice(0, 160);

    var start = Math.max(0, index - 60);
    return (start > 0 ? '…' : '') + body.slice(start, start + 180) + '…';
  }

  function highlight(text, query) {
    var escaped = core.escapeHtml(text);
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    terms.forEach(function (term) {
      // Escape regex metacharacters from the user's query.
      var safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      escaped = escaped.replace(new RegExp('(' + safe + ')', 'gi'),
        '<mark>$1</mark>');
    });

    return escaped;
  }

  function renderSearchResults(query) {
    var host = $('content');
    var results = search(query);

    var html = '<div class="page-head"><h1>Search</h1><p>' +
      (results.length
        ? results.length + ' document' + (results.length === 1 ? '' : 's') +
          ' matching “' + core.escapeHtml(query) + '”'
        : 'No documents match “' + core.escapeHtml(query) + '”.') +
      '</p></div>';

    if (results.length) {
      html += '<div class="result-list">';
      results.forEach(function (result) {
        html += '<a class="result" href="#/' + encodeURI(result.doc.slug) + '">' +
          '<div class="result__title">' +
            highlight(result.doc.title, query) + '</div>' +
          '<div class="result__path">' +
            core.escapeHtml(result.doc.category || 'Uncategorised') +
            (result.doc.updated ? ' · updated ' +
              core.escapeHtml(core.formatDate(result.doc.updated)) : '') +
          '</div>' +
          '<div class="result__snippet">' +
            highlight(result.snippet, query) + '</div>' +
          '</a>';
      });
      html += '</div>';
    }

    host.innerHTML = html;
    host.className = '';
  }

  /* ----------------------------------------------------------------- article */

  function renderArticle(doc) {
    var host = $('content');
    core.setBusy(host, 6);

    core.getText('content/' + doc.path)
      .then(function (source) {
        var rendered = markdown.render(source);
        var meta = rendered.meta || {};
        var title = meta.title || doc.title;

        var html = '<article class="article">';

        html += '<div class="article__meta">' +
          '<span>' + core.escapeHtml(meta.category || doc.category ||
            'Uncategorised') + '</span>';

        if (meta.updated || doc.updated) {
          html += '<span>·</span><span>Updated ' +
            core.escapeHtml(core.formatDate(meta.updated || doc.updated)) +
            '</span>';
        }
        if (meta.owner) {
          html += '<span>·</span><span>Owner: ' +
            core.escapeHtml(meta.owner) + '</span>';
        }

        var tags = meta.tags || doc.tags || [];
        if (tags.length) {
          html += '<span style="flex:1"></span>';
          tags.forEach(function (tag) {
            html += '<span class="tag">' + core.escapeHtml(tag) + '</span>';
          });
        }
        html += '</div>';

        // The frontmatter title is authoritative; only add an <h1> when the
        // body doesn't already open with one, so it is never shown twice.
        var hasOwnTitle = rendered.headings.length &&
          rendered.headings[0].level === 1;

        if (!hasOwnTitle) {
          html += '<h1 style="font-size:28px;letter-spacing:-0.02em">' +
            core.escapeHtml(title) + '</h1>';
        }

        html += tableOfContents(rendered.headings);
        html += '<div class="prose">' + rendered.html + '</div>';
        html += '</article>';

        host.innerHTML = html;
        host.className = '';
        document.title = title + ' · City of Homestead IT';

        scrollToHashTarget();
      })
      .catch(function (error) {
        core.showError(host, error, 'Could not load “' + doc.title + '”');
      });
  }

  /* Only worth showing when there is real structure to navigate. */
  function tableOfContents(headings) {
    var items = headings.filter(function (heading) {
      return heading.level === 2 || heading.level === 3;
    });

    if (items.length < 3) return '';

    var html = '<nav class="toc"><div class="toc__title">On this page</div><ol>';
    var depth = 2;

    items.forEach(function (heading) {
      if (heading.level > depth) { html += '<ol>'; depth = heading.level; }
      else if (heading.level < depth) { html += '</ol>'; depth = heading.level; }

      html += '<li><a href="#' + core.escapeHtml(heading.id) + '">' +
        core.escapeHtml(heading.text) + '</a></li>';
    });

    if (depth > 2) html += '</ol>';
    return html + '</ol></nav>';
  }

  /* An in-page anchor (#section-id) inside the current article. */
  function scrollToHashTarget() {
    var hash = location.hash;
    if (!hash || hash.indexOf('#/') === 0) return;

    var target = document.getElementById(hash.slice(1));
    if (target) target.scrollIntoView();
  }

  /* ------------------------------------------------------------------- home */

  function renderHome() {
    var host = $('content');

    var recent = state.docs.slice().sort(function (a, b) {
      return String(b.updated || '').localeCompare(String(a.updated || ''));
    }).slice(0, 8);

    var categories = {};
    state.docs.forEach(function (doc) {
      var key = doc.category || 'Uncategorised';
      categories[key] = (categories[key] || 0) + 1;
    });

    var html = '<div class="page-head"><h1>Knowledge base</h1><p>' +
      core.formatNumber(state.docs.length) + ' documents across ' +
      Object.keys(categories).length + ' categories' +
      (state.index.generated
        ? ' · index built ' + core.escapeHtml(core.formatDate(state.index.generated))
        : '') +
      '</p></div>';

    html += '<div class="grid grid--halves">';

    html += '<section class="card"><div class="card__head"><h2>Recently updated</h2>' +
      '</div><div class="card__body card__body--flush"><table class="table"><tbody>';

    if (!recent.length) {
      html += '<tr><td class="empty">No documents yet. Add a .md file under ' +
        'wwwroot/content and run tools/Build-DocsIndex.ps1.</td></tr>';
    }

    recent.forEach(function (doc) {
      html += '<tr><td><a href="#/' + encodeURI(doc.slug) + '">' +
        core.escapeHtml(doc.title) + '</a>' +
        '<div class="stat__foot" style="margin:2px 0 0">' +
        core.escapeHtml(doc.category || 'Uncategorised') + '</div></td>' +
        '<td class="num muted" style="white-space:nowrap">' +
        core.escapeHtml(core.formatDate(doc.updated)) + '</td></tr>';
    });

    html += '</tbody></table></div></section>';

    html += '<section class="card"><div class="card__head"><h2>Categories</h2>' +
      '</div><div class="card__body card__body--flush"><table class="table"><tbody>';

    Object.keys(categories).sort().forEach(function (name) {
      html += '<tr><td>' + core.escapeHtml(name) + '</td>' +
        '<td class="num muted">' + categories[name] + '</td></tr>';
    });

    html += '</tbody></table></div></section></div>';

    host.innerHTML = html;
    host.className = '';
    document.title = 'Knowledge base · City of Homestead IT';
  }

  /* ----------------------------------------------------------------- routing */

  function findDoc(slug) {
    var decoded = decodeURIComponent(slug);

    for (var i = 0; i < state.docs.length; i++) {
      if (state.docs[i].slug === decoded) return state.docs[i];
    }
    return null;
  }

  function route() {
    var hash = location.hash;

    if (state.query) {
      renderSearchResults(state.query);
      return;
    }

    if (hash.indexOf('#/') !== 0) {
      // A bare #anchor belongs to the article already on screen.
      if (hash && state.current) { scrollToHashTarget(); return; }
      state.current = null;
      renderTree();
      renderHome();
      return;
    }

    var slug = hash.slice(2);
    var doc = findDoc(slug);

    if (!doc) {
      state.current = null;
      renderTree();
      $('content').innerHTML =
        '<div class="notice notice--error"><div><strong>Document not found</strong>' +
        '<br>No indexed document matches “' + core.escapeHtml(slug) + '”. ' +
        'If you just added it, re-run tools/Build-DocsIndex.ps1.</div></div>';
      return;
    }

    state.current = doc;
    renderTree();
    renderArticle(doc);
  }

  /* -------------------------------------------------------------------- init */

  function initSearch() {
    var input = $('search-input');
    var timer = null;

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.query = input.value.trim();

        if (state.query) {
          renderSearchResults(state.query);
        } else if (state.current) {
          renderArticle(state.current);
        } else {
          renderHome();
        }
      }, 140);
    });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        input.value = '';
        state.query = '';
        route();
      }
    });

    // "/" focuses search, the usual docs-site shortcut.
    document.addEventListener('keydown', function (event) {
      if (event.key === '/' && event.target !== input &&
          !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
        event.preventDefault();
        input.focus();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    core.init();
    initSearch();

    loadIndex()
      .then(function () {
        route();
        window.addEventListener('hashchange', route);
      })
      .catch(function (error) {
        $('tree').innerHTML = '';
        core.showError($('content'), error,
          'Could not load the document index (content/index.json)');
      });
  });
})();
