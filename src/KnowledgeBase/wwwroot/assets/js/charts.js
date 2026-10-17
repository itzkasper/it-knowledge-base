/* ==========================================================================
   charts.js — inline-SVG charts, no dependencies. Exposes window.KB.charts.
   Mark specs: 2px lines, >=8px markers with a 2px surface ring, area fills at
   ~10% opacity, hairline solid gridlines, one y-axis only, legend whenever two
   or more series are plotted, and a crosshair tooltip on every time series.
   ========================================================================== */

window.KB = window.KB || {};

window.KB.charts = (function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // Categorical slots in fixed order — assigned by series index, never cycled.
  var SERIES_VARS = [
    '--series-1', '--series-2', '--series-3', '--series-4',
    '--series-5', '--series-6', '--series-7', '--series-8',
  ];

  function seriesColor(index) {
    return 'var(' + SERIES_VARS[index % SERIES_VARS.length] + ')';
  }

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key) && attrs[key] != null) {
        node.setAttribute(key, String(attrs[key]));
      }
    }
    return node;
  }

  /* ----------------------------------------------------------- number format */

  /* Compact SI-style formatting; charts carry bytes/s, bits/s and plain counts. */
  function compact(value, unit) {
    if (value == null || isNaN(value)) return '--';

    var abs = Math.abs(value);
    var scaled = value;
    var suffix = '';

    if (abs >= 1e9) { scaled = value / 1e9; suffix = 'G'; }
    else if (abs >= 1e6) { scaled = value / 1e6; suffix = 'M'; }
    else if (abs >= 1e3) { scaled = value / 1e3; suffix = 'k'; }

    var decimals = Math.abs(scaled) >= 100 || suffix === '' ? 0 : 1;
    var text = scaled.toFixed(decimals).replace(/\.0$/, '');

    return text + suffix + (unit ? ' ' + unit : '');
  }

  /* Axis ticks land on 1/2/5 x 10^n so labels read as round numbers. */
  function niceCeiling(value) {
    if (value <= 0) return 1;

    var magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    var normalized = value / magnitude;
    var step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;

    return step * magnitude;
  }

  function niceTicks(max, count) {
    var top = niceCeiling(max);
    var ticks = [];
    for (var i = 0; i <= count; i++) ticks.push((top / count) * i);
    return { top: top, ticks: ticks };
  }

  /* ------------------------------------------------------------- line chart */

  /**
   * Multi-series time chart. One y-axis by construction — there is no option
   * for a second scale.
   *
   * @param {HTMLElement} host
   * @param {{labels: string[], series: {name: string, values: (number|null)[]}[],
   *          unit?: string, area?: boolean, height?: number}} config
   */
  function lineChart(host, config) {
    var labels = config.labels || [];
    var series = (config.series || []).filter(function (s) { return s && s.values; });
    var unit = config.unit || '';
    var height = config.height || 240;

    host.textContent = '';
    host.classList.add('chart');

    if (!labels.length || !series.length) {
      host.appendChild(emptyState('No data in this window.'));
      return;
    }

    var width = 760;                       // viewBox units; scales to the host
    var pad = { top: 12, right: 16, bottom: 26, left: 52 };
    var plotW = width - pad.left - pad.right;
    var plotH = height - pad.top - pad.bottom;

    var peak = 0;
    series.forEach(function (s) {
      s.values.forEach(function (v) {
        if (v != null && !isNaN(v) && v > peak) peak = v;
      });
    });

    var scale = niceTicks(peak || 1, 4);

    function x(index) {
      return labels.length === 1
        ? pad.left + plotW / 2
        : pad.left + (plotW * index) / (labels.length - 1);
    }

    function y(value) {
      return pad.top + plotH - (plotH * value) / scale.top;
    }

    var svg = el('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      preserveAspectRatio: 'none',
      'aria-label': config.ariaLabel || 'Time series chart',
    });

    // Gridlines + y labels: recessive, hairline, solid.
    scale.ticks.forEach(function (tick) {
      var yy = y(tick);
      svg.appendChild(el('line', {
        x1: pad.left, x2: width - pad.right, y1: yy, y2: yy,
        class: tick === 0 ? 'axis-line' : 'grid-line',
      }));

      var label = el('text', {
        x: pad.left - 8, y: yy + 4, class: 'axis-label', 'text-anchor': 'end',
      });
      label.textContent = compact(tick, '');
      svg.appendChild(label);
    });

    // X labels: first, last and a few evenly spaced inner ticks.
    var maxXLabels = 6;
    var stride = Math.max(1, Math.ceil(labels.length / maxXLabels));
    labels.forEach(function (text, index) {
      if (index % stride !== 0 && index !== labels.length - 1) return;

      var label = el('text', {
        x: x(index), y: height - 8, class: 'axis-label',
        'text-anchor': index === 0 ? 'start'
          : index === labels.length - 1 ? 'end' : 'middle',
      });
      label.textContent = text;
      svg.appendChild(label);
    });

    // Series: optional 10% area wash under a 2px line.
    series.forEach(function (s, sIndex) {
      var color = seriesColor(sIndex);
      var segments = [];
      var current = [];

      s.values.forEach(function (value, index) {
        if (value == null || isNaN(value)) {
          if (current.length) segments.push(current);
          current = [];
          return;
        }
        current.push([x(index), y(value), index]);
      });
      if (current.length) segments.push(current);

      segments.forEach(function (points) {
        var path = points.map(function (p, i) {
          return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
        }).join(' ');

        if (config.area && points.length > 1) {
          svg.appendChild(el('path', {
            d: path + ' L' + points[points.length - 1][0].toFixed(1) + ' ' + y(0) +
               ' L' + points[0][0].toFixed(1) + ' ' + y(0) + ' Z',
            fill: color,
            'fill-opacity': '0.1',
            stroke: 'none',
          }));
        }

        svg.appendChild(el('path', {
          d: path,
          fill: 'none',
          stroke: color,
          'stroke-width': '2',
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
          'vector-effect': 'non-scaling-stroke',
        }));

        // A lone sample has no line to read — draw the point itself.
        if (points.length === 1) {
          svg.appendChild(el('circle', {
            cx: points[0][0], cy: points[0][1], r: 4,
            fill: color, stroke: 'var(--surface)', 'stroke-width': '2',
          }));
        }
      });
    });

    host.appendChild(svg);

    // Legend: always present for two or more series; a single series is already
    // named by the card's title, so a one-swatch box would just restate it.
    if (series.length > 1) {
      var legend = document.createElement('div');
      legend.className = 'chart__legend';

      series.forEach(function (s, sIndex) {
        var item = document.createElement('span');
        var key = document.createElement('i');
        key.className = 'chart__key';
        key.style.background = seriesColor(sIndex);
        item.appendChild(key);
        item.appendChild(document.createTextNode(s.name || 'Series ' + (sIndex + 1)));
        legend.appendChild(item);
      });

      host.appendChild(legend);
    }

    attachCrosshair(host, svg, {
      labels: labels, series: series, unit: unit,
      x: x, y: y, width: width,
      padTop: pad.top, plotH: plotH,
    });
  }

  /* --------------------------------------------------------- hover crosshair */

  function attachCrosshair(host, svg, ctx) {
    var line = el('line', {
      y1: ctx.padTop, y2: ctx.padTop + ctx.plotH,
      class: 'axis-line', opacity: '0',
    });
    svg.appendChild(line);

    var markers = ctx.series.map(function (_, index) {
      // 2px surface ring keeps the dot legible where it crosses another line.
      var dot = el('circle', {
        r: 4, fill: seriesColor(index),
        stroke: 'var(--surface)', 'stroke-width': '2', opacity: '0',
      });
      svg.appendChild(dot);
      return dot;
    });

    var tip = document.createElement('div');
    tip.className = 'chart__tooltip';
    host.appendChild(tip);

    function hide() {
      line.setAttribute('opacity', '0');
      markers.forEach(function (m) { m.setAttribute('opacity', '0'); });
      tip.setAttribute('data-visible', 'false');
    }

    function show(event) {
      var box = svg.getBoundingClientRect();
      if (!box.width) return;

      // Pointer position -> viewBox units -> nearest sample index.
      var vx = ((event.clientX - box.left) / box.width) * ctx.width;
      var best = 0;
      var bestDistance = Infinity;

      for (var i = 0; i < ctx.labels.length; i++) {
        var distance = Math.abs(ctx.x(i) - vx);
        if (distance < bestDistance) { bestDistance = distance; best = i; }
      }

      var px = ctx.x(best);
      line.setAttribute('x1', px);
      line.setAttribute('x2', px);
      line.setAttribute('opacity', '1');

      var rows = '';
      ctx.series.forEach(function (s, index) {
        var value = s.values[best];
        var marker = markers[index];

        if (value == null || isNaN(value)) {
          marker.setAttribute('opacity', '0');
        } else {
          // Reuse the chart's own y scale so the dot sits exactly on the line.
          marker.setAttribute('cx', px);
          marker.setAttribute('cy', ctx.y(value));
          marker.setAttribute('opacity', '1');
        }

        rows += '<div class="chart__tooltip-row">' +
          '<i class="chart__key" style="background:' + seriesColor(index) + '"></i>' +
          escapeText(s.name || 'Series ' + (index + 1)) +
          '<b>' + (value == null || isNaN(value) ? '--' : compact(value, ctx.unit)) + '</b>' +
          '</div>';
      });

      tip.innerHTML = '<div class="chart__tooltip-head">' +
        escapeText(ctx.labels[best]) + '</div>' + rows;
      tip.setAttribute('data-visible', 'true');

      // Keep the tooltip inside the card.
      var hostBox = host.getBoundingClientRect();
      var left = (px / ctx.width) * hostBox.width + 14;
      if (left + tip.offsetWidth > hostBox.width) {
        left = (px / ctx.width) * hostBox.width - tip.offsetWidth - 14;
      }
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = '8px';
    }

    // Generous hit area: the whole plot, not just the 2px marks.
    host.addEventListener('pointermove', show);
    host.addEventListener('pointerleave', hide);
    host.addEventListener('pointercancel', hide);
  }

  /* -------------------------------------------------------------- sparkline */

  /** 12-point trend line for a stat tile. No axes, no tooltip. */
  function sparkline(host, values, options) {
    var opts = options || {};
    var points = (values || []).filter(function (v) {
      return v != null && !isNaN(v);
    });

    host.textContent = '';
    host.classList.add('chart', 'sparkline');

    if (points.length < 2) return;

    var width = 200;
    var height = 34;
    var inset = 3;
    var peak = Math.max.apply(null, points);
    var floor = Math.min.apply(null, points);
    var span = peak - floor || 1;

    function x(i) { return (width * i) / (points.length - 1); }
    function y(v) { return height - inset - ((height - inset * 2) * (v - floor)) / span; }

    var path = points.map(function (v, i) {
      return (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(v).toFixed(1);
    }).join(' ');

    var svg = el('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    });

    var color = opts.color || seriesColor(0);

    svg.appendChild(el('path', {
      d: path + ' L' + width + ' ' + height + ' L0 ' + height + ' Z',
      fill: color, 'fill-opacity': '0.1', stroke: 'none',
    }));

    svg.appendChild(el('path', {
      d: path, fill: 'none', stroke: color, 'stroke-width': '2',
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke',
    }));

    host.appendChild(svg);
  }

  /* ------------------------------------------------------------- bar chart */

  /**
   * Horizontal bars for ranked categories (top talkers, busiest devices).
   * Bars are capped at 24px, square at the baseline, rounded at the data end.
   */
  function barChart(host, config) {
    var rows = (config.rows || []).slice(0, config.limit || 8);

    host.textContent = '';
    host.classList.add('chart');

    if (!rows.length) {
      host.appendChild(emptyState(config.emptyText || 'Nothing to show.'));
      return;
    }

    var barHeight = 18;
    var gap = 12;                 // > 2px, so the surface gap is never the issue
    var labelW = config.labelWidth || 170;
    var valueW = 76;
    var width = 760;
    var height = rows.length * (barHeight + gap);
    var plotW = width - labelW - valueW;
    var top = niceCeiling(Math.max.apply(null, rows.map(function (r) {
      return Number(r.value) || 0;
    })) || 1);

    var svg = el('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      'aria-label': config.ariaLabel || 'Ranked bar chart',
    });

    rows.forEach(function (row, index) {
      var yy = index * (barHeight + gap);
      var value = Number(row.value) || 0;
      var barW = Math.max(2, (plotW * value) / top);

      var name = el('text', {
        x: 0, y: yy + barHeight / 2 + 4, class: 'axis-label',
      });
      name.textContent = truncate(row.label, 26);
      svg.appendChild(name);

      // Track, then fill. Rounded only on the data end.
      svg.appendChild(el('rect', {
        x: labelW, y: yy, width: plotW, height: barHeight,
        rx: 3, fill: 'var(--grid)',
      }));
      svg.appendChild(el('path', {
        d: roundedRightRect(labelW, yy, barW, barHeight, 4),
        fill: config.color || seriesColor(0),
      }));

      var amount = el('text', {
        x: width, y: yy + barHeight / 2 + 4,
        class: 'axis-label', 'text-anchor': 'end',
      });
      amount.textContent = compact(value, config.unit || '');
      svg.appendChild(amount);
    });

    host.appendChild(svg);
  }

  /* Square at the baseline (left), 4px rounded at the data end (right). */
  function roundedRightRect(x, y, w, h, r) {
    var radius = Math.min(r, w / 2, h / 2);
    return 'M' + x + ' ' + y +
      ' H' + (x + w - radius) +
      ' Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + radius) +
      ' V' + (y + h - radius) +
      ' Q' + (x + w) + ' ' + (y + h) + ' ' + (x + w - radius) + ' ' + (y + h) +
      ' H' + x + ' Z';
  }

  /* ---------------------------------------------------------------- helpers */

  function emptyState(text) {
    var node = document.createElement('div');
    node.className = 'empty';
    node.textContent = text;
    return node;
  }

  function truncate(text, max) {
    var value = String(text == null ? '' : text);
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return {
    lineChart: lineChart,
    barChart: barChart,
    sparkline: sparkline,
    compact: compact,
    seriesColor: seriesColor,
  };
})();
