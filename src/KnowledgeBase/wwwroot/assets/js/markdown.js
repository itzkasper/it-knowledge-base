/* ==========================================================================
   markdown.js — a dependency-free Markdown renderer for SOP documents.
   Exposes window.KB.markdown.
   Supports: ATX headings (with anchors), fenced code, lists (nested, ordered,
   task), tables, blockquotes, GitHub-style callouts, hr, and inline emphasis /
   code / links / images / autolinks. All text is HTML-escaped before any tag is
   emitted, and link targets are scheme-checked.
   ========================================================================== */

window.KB = window.KB || {};

window.KB.markdown = (function () {
  'use strict';

  var ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ESCAPE_MAP[ch];
    });
  }

  /* Blocks javascript:/vbscript: and non-image data: URLs. Input arrives
     already HTML-escaped, which leaves these schemes textually intact. */
  function safeUrl(url) {
    var trimmed = String(url || '').trim();
    var lower = trimmed.toLowerCase().replace(/[\s\u0000-\u001f]/g, '');

    if (lower.indexOf('javascript:') === 0) return '#';
    if (lower.indexOf('vbscript:') === 0) return '#';
    if (lower.indexOf('data:') === 0 && lower.indexOf('data:image/') !== 0) return '#';

    return trimmed;
  }

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-') || 'section';
  }

  /* ------------------------------------------------------------- inline pass */

  /* A URL inside (...): either plain characters or one balanced paren pair, so
     ".../alert(1)" and Wikipedia-style "..._(disambiguation)" both survive. */
  var URL_IN_PARENS = '((?:[^()\\s]|\\([^()\\s]*\\))+)';

  var RE_IMAGE = new RegExp(
    '!\\[([^\\]]*)\\]\\(\\s*' + URL_IN_PARENS + '(?:\\s+"([^"]*)")?\\s*\\)', 'g');
  var RE_LINK = new RegExp(
    '\\[([^\\]]+)\\]\\(\\s*' + URL_IN_PARENS + '(?:\\s+"([^"]*)")?\\s*\\)', 'g');
  var RE_AUTOLINK = /(^|[\s(])((?:https?:\/\/|mailto:)[^\s<>() ]+)/g;

  function renderInline(text) {
    /* Every generated tag is parked in `tokens` and replaced by a sentinel, so
       the emphasis passes below can never see -- and therefore never corrupt --
       markup this function produced. (An earlier version ran emphasis over the
       generated HTML, which turned target="_blank" into target="<em>blank".)
       Sentinels contain NUL, which cannot occur in a source document, so they
       never collide with real text and pass through escapeHtml untouched. */
    var tokens = [];

    function stash(html) {
      tokens.push(html);
      return '\u0000t' + (tokens.length - 1) + '\u0000';
    }

    // 1. Inline code first: its contents must not be read as any other syntax.
    var out = String(text).replace(/`([^`]+)`/g, function (_, code) {
      return stash('<code>' + escapeHtml(code) + '</code>');
    });

    // 2. Images before links -- the link pattern would otherwise swallow them.
    out = out.replace(RE_IMAGE, function (_, alt, src, title) {
      return stash(
        '<img src="' + escapeHtml(safeUrl(src)) + '" alt="' + escapeHtml(alt) + '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : '') + ' loading="lazy">');
    });

    // 3. Links: only the tags are stashed. The label stays in the stream so it
    //    still gets escaped and emphasised like the prose around it.
    out = out.replace(RE_LINK, function (_, label, href, title) {
      var url = safeUrl(href);
      var external = /^(?:https?:)?\/\//i.test(url);

      return stash(
        '<a href="' + escapeHtml(url) + '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : '') +
        (external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>'
      ) + label + stash('</a>');
    });

    // 4. Bare URLs. Anything already linked above is now behind a sentinel.
    out = out.replace(RE_AUTOLINK, function (_, lead, url) {
      return lead + stash(
        '<a href="' + escapeHtml(safeUrl(url)) +
        '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>');
    });

    // 5. Only prose remains unescaped at this point.
    out = escapeHtml(out);

    out = out
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // Two or more trailing spaces = hard break.
    out = out.replace(/ {2,}\n/g, '<br>\n');

    return out.replace(/\u0000t(\d+)\u0000/g, function (_, index) {
      return tokens[Number(index)];
    });
  }

  /* ---------------------------------------------------------- fence pre-pass */

  /* Replaces each fenced block with a single placeholder line so the block
     parser never has to look inside code. */
  function extractFences(lines, store) {
    var result = [];
    var i = 0;

    while (i < lines.length) {
      var open = lines[i].match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)/);
      if (!open) {
        result.push(lines[i]);
        i++;
        continue;
      }

      var marker = open[1][0];
      var minLength = open[1].length;
      var language = open[2] || '';
      var body = [];
      i++;

      while (i < lines.length) {
        var close = lines[i].match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
        if (close && close[1][0] === marker && close[1].length >= minLength) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }

      store.push(
        '<pre><code' +
        (language ? ' class="language-' + escapeHtml(language) + '"' : '') +
        '>' + escapeHtml(body.join('\n')) + '</code></pre>'
      );
      result.push('\u0000F' + (store.length - 1) + '\u0000');
    }

    return result;
  }

  /* ------------------------------------------------------------ block tests */

  var RE_HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
  var RE_HR = /^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
  var RE_QUOTE = /^[ \t]{0,3}>[ \t]?/;
  var RE_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
  var RE_FENCE_PLACEHOLDER = /^\u0000F(\d+)\u0000$/;
  var RE_TABLE_DIVIDER = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

  function indentWidth(text) {
    var width = 0;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === ' ') width += 1;
      else if (text[i] === '\t') width += 4;
      else break;
    }
    return width;
  }

  function startsBlock(lines, index) {
    var line = lines[index];

    if (!line.trim() ||
        RE_HEADING.test(line) ||
        RE_HR.test(line) ||
        RE_QUOTE.test(line) ||
        RE_ITEM.test(line) ||
        RE_FENCE_PLACEHOLDER.test(line)) {
      return true;
    }

    // A table may follow a paragraph with no blank line between them.
    return isTableStart(lines, index);
  }

  function isTableStart(lines, index) {
    return index + 1 < lines.length &&
      lines[index].indexOf('|') !== -1 &&
      lines[index + 1].indexOf('-') !== -1 &&
      RE_TABLE_DIVIDER.test(lines[index + 1]);
  }

  /* ----------------------------------------------------------- table parsing */

  function splitRow(line) {
    var trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map(function (cell) { return cell.trim(); });
  }

  function parseTable(lines, start, ctx) {
    var header = splitRow(lines[start]);
    var alignments = splitRow(lines[start + 1]).map(function (spec) {
      if (/^:-+:$/.test(spec)) return 'center';
      if (/^-+:$/.test(spec)) return 'right';
      return 'left';
    });

    var i = start + 2;
    var rows = [];
    while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) {
      rows.push(splitRow(lines[i]));
      i++;
    }

    function align(index) {
      var value = alignments[index] || 'left';
      return value === 'left' ? '' : ' style="text-align:' + value + '"';
    }

    var html = '<div class="table-scroll"><table><thead><tr>';
    header.forEach(function (cell, index) {
      html += '<th' + align(index) + '>' + renderInline(cell) + '</th>';
    });
    html += '</tr></thead><tbody>';

    rows.forEach(function (row) {
      html += '<tr>';
      for (var c = 0; c < header.length; c++) {
        html += '<td' + align(c) + '>' + renderInline(row[c] || '') + '</td>';
      }
      html += '</tr>';
    });

    html += '</tbody></table></div>';
    ctx.hasTable = true;
    return { html: html, next: i };
  }

  /* ------------------------------------------------------------ list parsing */

  function parseList(lines, start, ctx) {
    var first = lines[start].match(RE_ITEM);
    var baseIndent = indentWidth(first[1]);
    var ordered = /\d/.test(first[2]);
    var startNumber = ordered ? parseInt(first[2], 10) : 1;

    var items = [];
    var loose = false;
    var i = start;

    while (i < lines.length) {
      var match = lines[i].match(RE_ITEM);

      if (match && indentWidth(match[1]) === baseIndent) {
        // A different marker family starts a new list.
        if (/\d/.test(match[2]) !== ordered) break;

        var content = [match[3]];
        i++;

        // Absorb continuations: anything indented past the marker, plus blank
        // lines that are followed by more indented content.
        while (i < lines.length) {
          if (!lines[i].trim()) {
            var lookahead = i + 1;
            while (lookahead < lines.length && !lines[lookahead].trim()) lookahead++;
            if (lookahead < lines.length && indentWidth(lines[lookahead]) > baseIndent) {
              loose = true;
              content.push('');
              i = lookahead;
              continue;
            }
            break;
          }
          if (indentWidth(lines[i]) > baseIndent) {
            content.push(lines[i]);
            i++;
            continue;
          }
          break;
        }

        items.push(content);
        continue;
      }

      if (match && indentWidth(match[1]) > baseIndent && items.length) {
        // Deeper item that lost its continuation indent — attach to last item.
        items[items.length - 1].push(lines[i]);
        i++;
        continue;
      }

      break;
    }

    // Dedent each item's continuation lines, then parse them as blocks.
    var isTaskList = false;
    var rendered = items.map(function (content) {
      var head = content[0];
      var task = head.match(/^\[([ xX])\][ \t]+(.*)$/);
      var checkbox = '';

      if (task) {
        isTaskList = true;
        checkbox = '<input type="checkbox" disabled' +
          (task[1].toLowerCase() === 'x' ? ' checked' : '') + '>';
        head = task[2];
      }

      var tail = content.slice(1).map(function (line) {
        if (!line.trim()) return '';
        var strip = Math.min(indentWidth(line), baseIndent + 2);
        var removed = 0;
        var index = 0;
        while (index < line.length && removed < strip) {
          removed += line[index] === '\t' ? 4 : 1;
          index++;
        }
        return line.slice(index);
      });

      var body = parseBlocks([head].concat(tail), ctx);

      // Tight list: unwrap only the leading paragraph, so an item that also
      // carries a nested list keeps that list as a block.
      if (!loose && body.indexOf('<p>') === 0) {
        var close = body.indexOf('</p>');
        if (close !== -1) body = body.slice(3, close) + body.slice(close + 4);
      }

      return '<li>' + checkbox + body + '</li>';
    }).join('');

    var tag = ordered ? 'ol' : 'ul';
    var attrs = isTaskList ? ' class="task-list"' : '';
    if (ordered && startNumber !== 1) attrs += ' start="' + startNumber + '"';

    return { html: '<' + tag + attrs + '>' + rendered + '</' + tag + '>', next: i };
  }

  /* ------------------------------------------------------ blockquote/callout */

  var CALLOUTS = {
    NOTE: { kind: 'note', label: 'Note' },
    TIP: { kind: 'tip', label: 'Tip' },
    IMPORTANT: { kind: 'note', label: 'Important' },
    WARNING: { kind: 'warning', label: 'Warning' },
    CAUTION: { kind: 'caution', label: 'Caution' },
  };

  function parseQuote(lines, start, ctx) {
    var buffer = [];
    var i = start;

    while (i < lines.length && RE_QUOTE.test(lines[i])) {
      buffer.push(lines[i].replace(RE_QUOTE, ''));
      i++;
    }

    var callout = buffer.length ? buffer[0].match(/^\[!(\w+)\][ \t]*(.*)$/) : null;

    if (callout && CALLOUTS[callout[1].toUpperCase()]) {
      var spec = CALLOUTS[callout[1].toUpperCase()];
      var rest = buffer.slice(1);
      if (callout[2].trim()) rest.unshift(callout[2]);

      return {
        html: '<div class="callout callout--' + spec.kind + '">' +
          '<div class="callout__title">' + spec.label + '</div>' +
          parseBlocks(rest, ctx) + '</div>',
        next: i,
      };
    }

    return { html: '<blockquote>' + parseBlocks(buffer, ctx) + '</blockquote>', next: i };
  }

  /* ----------------------------------------------------------- block parsing */

  function parseBlocks(lines, ctx) {
    var html = '';
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      var fence = line.match(RE_FENCE_PLACEHOLDER);
      if (fence) {
        html += ctx.fences[Number(fence[1])];
        i++;
        continue;
      }

      var heading = line.match(RE_HEADING);
      if (heading) {
        var level = heading[1].length;
        var text = renderInline(heading[2]);
        var id = ctx.uniqueSlug(slugify(heading[2]));

        ctx.headings.push({ level: level, text: heading[2].trim(), id: id });

        html += '<h' + level + ' id="' + id + '">' + text +
          '<a class="anchor" href="#' + id + '" aria-label="Link to this section">#</a>' +
          '</h' + level + '>';
        i++;
        continue;
      }

      if (RE_HR.test(line)) { html += '<hr>'; i++; continue; }

      if (RE_QUOTE.test(line)) {
        var quote = parseQuote(lines, i, ctx);
        html += quote.html;
        i = quote.next;
        continue;
      }

      if (isTableStart(lines, i)) {
        var table = parseTable(lines, i, ctx);
        html += table.html;
        i = table.next;
        continue;
      }

      if (RE_ITEM.test(line)) {
        var list = parseList(lines, i, ctx);
        html += list.html;
        i = list.next;
        continue;
      }

      // Paragraph: run until a blank line or the start of another block.
      var paragraph = [line];
      i++;
      while (i < lines.length && !startsBlock(lines, i)) {
        paragraph.push(lines[i]);
        i++;
      }
      html += '<p>' + renderInline(paragraph.join('\n').trim()) + '</p>';
    }

    return html;
  }

  /* -------------------------------------------------------------- frontmatter */

  /* Minimal YAML: scalars, `key: [a, b]` and `- item` lists. Enough for the
     title/category/tags/updated block every SOP carries. */
  function parseFrontMatter(source) {
    var match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
    if (!match) return { data: {}, body: source };

    var data = {};
    var lines = match[1].split(/\r?\n/);
    var currentKey = null;

    lines.forEach(function (raw) {
      if (!raw.trim() || /^\s*#/.test(raw)) return;

      var item = raw.match(/^\s*-\s+(.*)$/);
      if (item && currentKey) {
        if (!Array.isArray(data[currentKey])) data[currentKey] = [];
        data[currentKey].push(unquote(item[1]));
        return;
      }

      var pair = raw.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (!pair) return;

      currentKey = pair[1];
      var value = pair[2].trim();

      if (!value) { data[currentKey] = []; return; }

      if (value[0] === '[' && value[value.length - 1] === ']') {
        data[currentKey] = value.slice(1, -1).split(',')
          .map(function (part) { return unquote(part.trim()); })
          .filter(Boolean);
        return;
      }

      data[currentKey] = unquote(value);
    });

    return { data: data, body: source.slice(match[0].length) };
  }

  function unquote(value) {
    var text = String(value).trim();
    if (text.length > 1 &&
        ((text[0] === '"' && text.slice(-1) === '"') ||
         (text[0] === "'" && text.slice(-1) === "'"))) {
      return text.slice(1, -1);
    }
    return text;
  }

  /* Plain text of a document, for search indexing and snippets. */
  function toPlainText(body) {
    return body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/\[!\w+\]/g, '')          // callout markers aren't prose
      .replace(/^[ \t]*\[[ xX]\][ \t]+/gm, '')
      .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/^[ \t]*[|:\-\s]{3,}$/gm, ' ')  // table rules and hr, not prose
      .replace(/[*_~|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ----------------------------------------------------------------- public */

  function render(source) {
    var parsed = parseFrontMatter(String(source || ''));
    var normalized = parsed.body.replace(/\r\n?/g, '\n');

    var ctx = {
      fences: [],
      headings: [],
      hasTable: false,
      used: Object.create(null),
      uniqueSlug: function (slug) {
        if (!this.used[slug]) {
          this.used[slug] = 1;
          return slug;
        }
        this.used[slug] += 1;
        return slug + '-' + this.used[slug];
      },
    };

    var lines = extractFences(normalized.split('\n'), ctx.fences);

    return {
      html: parseBlocks(lines, ctx),
      headings: ctx.headings,
      meta: parsed.data,
      text: toPlainText(normalized),
    };
  }

  return {
    render: render,
    parseFrontMatter: parseFrontMatter,
    toPlainText: toPlainText,
    escapeHtml: escapeHtml,
    slugify: slugify,
  };
})();
