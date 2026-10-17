#!/usr/bin/env python3
"""Regenerate the raster icons (favicon.ico, PNGs) from the brand mark.

OPTIONAL. You only need this after changing the mark or the brand colour; the
SVG files under wwwroot/assets/brand are the source of truth and the site uses
them directly. Requires Python 3 and nothing else -- it can be run on any
machine, not necessarily the web server.

    python3 tools/Build-Icons.py

Pure stdlib: the mark is a rounded box plus three round-capped strokes, so it
is evaluated as signed-distance fields and supersampled for antialiasing --
no image library and no browser needed.

IMPORTANT: the geometry below duplicates assets/brand/favicon.svg. If you
change the SVG paths, change STROKES_FULL to match, or the .ico fallback will
drift from the SVG that modern browsers actually show.
"""

import math
import os
import struct
import zlib

# Resolved from this script's location, so the repo can live anywhere.
OUT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '..', 'src', 'KnowledgeBase', 'wwwroot', 'assets', 'brand', '')

TILE_LIGHT = (0x11, 0x6b, 0x63)     # --brand light step, from app.css
WHITE = (0xff, 0xff, 0xff)

SS = 4                               # supersampling factor per axis
STROKE_HALF = 1.6                    # stroke-width 3.2 in the 32-unit space

# Round-capped strokes, in 32-unit space. The chevron is two segments sharing
# an endpoint, which reproduces the SVG's round line-join for free.
STROKES_FULL = [
    ((6.5, 16.5), (16.0, 9.0)),
    ((16.0, 9.0), (25.5, 16.5)),
    ((10.5, 22.5), (21.5, 22.5)),
]


def sdf_round_box(px, py, half, radius):
    """Signed distance to a square of half-extent `half` with corner radius."""
    qx = abs(px - half) - (half - radius)
    qy = abs(py - half) - (half - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - radius


def dist_to_segment(px, py, a, b):
    ax, ay = a
    bx, by = b
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    seg_len2 = vx * vx + vy * vy
    t = 0.0 if seg_len2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / seg_len2))
    return math.hypot(wx - t * vx, wy - t * vy)


def sample(x, y, radius):
    """Composited RGBA at one point in 32-unit space, each channel 0..1."""
    if sdf_round_box(x, y, 16.0, radius) >= 0.0:
        return 0.0, 0.0, 0.0, 0.0          # outside the tile

    r, g, b = (c / 255.0 for c in TILE_LIGHT)
    a = 1.0

    for seg in STROKES_FULL:
        if dist_to_segment(x, y, *seg) <= STROKE_HALF:
            return WHITE[0] / 255.0, WHITE[1] / 255.0, WHITE[2] / 255.0, 1.0

    return r, g, b, a


def render(size, radius_units):
    """Supersampled RGBA8 buffer, returned as rows of bytes."""
    scale = 32.0 / size
    step = scale / SS
    offset = step / 2.0
    inv = 1.0 / (SS * SS)
    rows = []

    for py in range(size):
        row = bytearray()
        base_y = py * scale
        for px in range(size):
            base_x = px * scale
            ar = ag = ab = aa = 0.0

            for sy in range(SS):
                y = base_y + sy * step + offset
                for sx in range(SS):
                    x = base_x + sx * step + offset
                    r, g, b, a = sample(x, y, radius_units)
                    # Accumulate premultiplied so the rounded edge blends right.
                    ar += r * a
                    ag += g * a
                    ab += b * a
                    aa += a

            ar *= inv
            ag *= inv
            ab *= inv
            aa *= inv

            if aa > 0.0:                    # un-premultiply
                ar, ag, ab = ar / aa, ag / aa, ab / aa

            row += bytes((
                max(0, min(255, int(round(ar * 255)))),
                max(0, min(255, int(round(ag * 255)))),
                max(0, min(255, int(round(ab * 255)))),
                max(0, min(255, int(round(aa * 255)))),
            ))
        rows.append(bytes(row))

    return rows


def chunk(tag, payload):
    body = tag + payload
    return (struct.pack('>I', len(payload)) + body +
            struct.pack('>I', zlib.crc32(body) & 0xffffffff))


def encode_png(size, rows):
    raw = b''.join(b'\x00' + row for row in rows)   # filter type 0 per scanline
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw, 9)) +
            chunk(b'IEND', b''))


def encode_ico(pngs):
    """ICO with PNG payloads (supported by every browser that reads .ico)."""
    count = len(pngs)
    header = struct.pack('<HHH', 0, 1, count)
    offset = 6 + 16 * count
    entries, blobs = b'', b''

    for size, data in pngs:
        entries += struct.pack('<BBBBHHII',
                               size if size < 256 else 0,
                               size if size < 256 else 0,
                               0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)

    return header + entries + blobs


def main():
    written = []

    # Favicon sizes keep the rounded tile.
    ico_parts = []
    for size in (16, 32, 48):
        png = encode_png(size, render(size, 7.5))
        ico_parts.append((size, png))
        path = OUT + 'favicon-%d.png' % size
        open(path, 'wb').write(png)
        written.append((path, len(png)))

    ico = encode_ico(ico_parts)
    open(OUT + 'favicon.ico', 'wb').write(ico)
    written.append((OUT + 'favicon.ico', len(ico)))

    # iOS applies its own rounded mask, so the touch icon is full-bleed.
    touch = encode_png(180, render(180, 0.0))
    open(OUT + 'apple-touch-icon.png', 'wb').write(touch)
    written.append((OUT + 'apple-touch-icon.png', len(touch)))

    for path, size in written:
        print('%-78s %6d bytes' % (path.rsplit('/', 1)[-1], size))


if __name__ == '__main__':
    main()
