#!/usr/bin/env python3
"""Rasterize Fællesbandet note icons from the shared 128-unit geometry."""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"

NAVY = (15, 23, 42, 255)  # #0f172a
AMBER = (245, 158, 11, 255)  # #f59e0b
TRANSPARENT = (0, 0, 0, 0)

# Geometry on a 128×128 grid (same numbers as the SVG files).
LEFT_HEAD = (42.0, 94.0, 17.5, 12.8, math.radians(-24))
RIGHT_HEAD = (86.0, 85.0, 17.5, 12.8, math.radians(-24))
LEFT_STEM = (51.25, 36.0, 8.5, 62.0)  # x, y, w, h
RIGHT_STEM = (95.25, 27.0, 8.5, 62.0)
BEAM = ((51.25, 36.0), (103.75, 27.0), (103.75, 38.0), (51.25, 47.0))


def in_ellipse(x: float, y: float, cx: float, cy: float, rx: float, ry: float, theta: float) -> bool:
	dx, dy = x - cx, y - cy
	ct, st = math.cos(theta), math.sin(theta)
	u = dx * ct + dy * st
	v = -dx * st + dy * ct
	return (u / rx) ** 2 + (v / ry) ** 2 <= 1.0


def in_rect(x: float, y: float, rx: float, ry: float, rw: float, rh: float) -> bool:
	return rx <= x < rx + rw and ry <= y < ry + rh


def in_polygon(x: float, y: float, pts: tuple[tuple[float, float], ...]) -> bool:
	inside = False
	n = len(pts)
	j = n - 1
	for i in range(n):
		xi, yi = pts[i]
		xj, yj = pts[j]
		if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
			inside = not inside
		j = i
	return inside


def in_circle(x: float, y: float, size: float = 128) -> bool:
	c = size / 2
	return (x - c) ** 2 + (y - c) ** 2 <= c * c


def is_note(x: float, y: float) -> bool:
	if in_ellipse(x, y, *LEFT_HEAD) or in_ellipse(x, y, *RIGHT_HEAD):
		return True
	if in_rect(x, y, *LEFT_STEM) or in_rect(x, y, *RIGHT_STEM):
		return True
	return in_polygon(x, y, BEAM)


def render(size: int, *, circle: bool, samples: int = 3) -> bytes:
	"""Return RGBA bytes, row-major, `size`×`size`."""
	out = bytearray(size * size * 4)
	scale = 128 / size
	inv = 1.0 / samples

	for py in range(size):
		for px in range(size):
			navy = 0
			amber = 0
			clear = 0
			for sy in range(samples):
				for sx in range(samples):
					x = (px + (sx + 0.5) * inv) * scale
					y = (py + (sy + 0.5) * inv) * scale
					if circle and not in_circle(x, y):
						clear += 1
						continue
					if is_note(x, y):
						amber += 1
					else:
						navy += 1
			total = samples * samples
			i = (py * size + px) * 4
			if circle:
				a = 255 * (total - clear) // total
				if a == 0:
					out[i : i + 4] = bytes(TRANSPARENT)
					continue
				covered = total - clear
				out[i] = (AMBER[0] * amber + NAVY[0] * navy) // covered
				out[i + 1] = (AMBER[1] * amber + NAVY[1] * navy) // covered
				out[i + 2] = (AMBER[2] * amber + NAVY[2] * navy) // covered
				out[i + 3] = a
			else:
				out[i] = (AMBER[0] * amber + NAVY[0] * navy) // total
				out[i + 1] = (AMBER[1] * amber + NAVY[1] * navy) // total
				out[i + 2] = (AMBER[2] * amber + NAVY[2] * navy) // total
				out[i + 3] = 255
	return bytes(out)


def write_png(path: Path, size: int, rgba: bytes) -> None:
	raw = b"".join(b"\x00" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size))

	def chunk(tag: bytes, data: bytes) -> bytes:
		return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

	png = b"\x89PNG\r\n\x1a\n"
	png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
	png += chunk(b"IDAT", zlib.compress(raw, 9))
	png += chunk(b"IEND", b"")
	path.write_bytes(png)


def png_bytes(size: int, rgba: bytes) -> bytes:
	raw = b"".join(b"\x00" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size))

	def chunk(tag: bytes, data: bytes) -> bytes:
		return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

	png = b"\x89PNG\r\n\x1a\n"
	png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
	png += chunk(b"IDAT", zlib.compress(raw, 9))
	png += chunk(b"IEND", b"")
	return png


def write_ico(path: Path, images: list[tuple[int, bytes]]) -> None:
	n = len(images)
	offset = 6 + 16 * n
	entries = []
	payload = b""
	for size, png in images:
		w = 0 if size >= 256 else size
		entries.append(struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(png), offset))
		payload += png
		offset += len(png)
	path.write_bytes(struct.pack("<HHH", 0, 1, n) + b"".join(entries) + payload)


def main() -> None:
	STATIC.mkdir(exist_ok=True)

	square = {
		180: render(180, circle=False, samples=3),
		192: render(192, circle=False, samples=3),
		512: render(512, circle=False, samples=3),
	}
	round_tab = {
		16: render(16, circle=True, samples=5),
		32: render(32, circle=True, samples=4),
		48: render(48, circle=True, samples=4),
	}

	write_png(STATIC / "favicon-32.png", 32, round_tab[32])
	write_png(STATIC / "apple-touch-icon.png", 180, square[180])
	write_png(STATIC / "icon-192.png", 192, square[192])
	write_png(STATIC / "icon-512.png", 512, square[512])

	write_ico(
		STATIC / "favicon.ico",
		[
			(16, png_bytes(16, round_tab[16])),
			(32, png_bytes(32, round_tab[32])),
			(48, png_bytes(48, round_tab[48])),
		],
	)
	print("wrote icons in", STATIC)


if __name__ == "__main__":
	main()
