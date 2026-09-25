#!/usr/bin/env python3
"""Build Fællesbandet icons from the cold-moon circular mark.

Requires Pillow + numpy (local tools, not an app dependency).
Source: scripts/brand/logo-night-source.jpg
"""

from __future__ import annotations

import base64
import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts" / "brand" / "logo-night-source.jpg"
NOTES_SOURCE = ROOT / "scripts" / "brand" / "favicon-notes.png"
STATIC = ROOT / "static"
NAVY = (15, 23, 42, 255)
NIGHT = (11, 18, 36, 255)
MOON = (238, 246, 251, 255)


def crop_circle(im: Image.Image) -> Image.Image:
	g = np.asarray(im.convert("L"), dtype=np.float32)
	mask = g < 245
	ys, xs = np.where(mask)
	pad = 4
	left, top, right, bottom = xs.min() - pad, ys.min() - pad, xs.max() + 1 + pad, ys.max() + 1 + pad
	left = max(0, left)
	top = max(0, top)
	right = min(im.size[0], right)
	bottom = min(im.size[1], bottom)
	cx, cy = (left + right) / 2, (top + bottom) / 2
	side = max(right - left, bottom - top)
	left = int(round(cx - side / 2))
	top = int(round(cy - side / 2))
	crop = im.crop((left, top, left + side, top + side)).convert("RGBA")
	px = np.asarray(crop).copy()
	h, w = px.shape[:2]
	yy, xx = np.ogrid[:h, :w]
	r = min(h, w) / 2 - 0.5
	inside = (xx - (w - 1) / 2) ** 2 + (yy - (h - 1) / 2) ** 2 <= r * r
	px[~inside, 3] = 0
	return Image.fromarray(px, "RGBA")


def add_head_rim(im: Image.Image) -> Image.Image:
	px = np.asarray(im).astype(np.float32)
	h, w = px.shape[:2]
	yy, xx = np.ogrid[:h, :w]
	r = min(h, w) / 2 - 0.5
	circle = (xx - (w - 1) / 2) ** 2 + (yy - (h - 1) / 2) ** 2 <= r * r
	lum = 0.2126 * px[:, :, 0] + 0.7152 * px[:, :, 1] + 0.0722 * px[:, :, 2]
	moon = (lum > 200) & (yy < h * 0.55) & circle
	moon_rgb = px[moon, :3].mean(0) if moon.any() else np.array([224.0, 239.0, 249.0])
	heads = (lum < 70) & circle & (yy > h * 0.42) & (yy < h * 0.97) & (xx > w * 0.06) & (xx < w * 0.78)

	def filt(m: np.ndarray, kind: str, k: int) -> np.ndarray:
		img = Image.fromarray((m.astype(np.uint8) * 255), "L")
		f = ImageFilter.MinFilter(k) if kind == "erode" else ImageFilter.MaxFilter(k)
		return np.asarray(img.filter(f)) > 127

	edge_in = heads & ~filt(heads, "erode", 3)
	edge_out = filt(heads, "dilate", 3) & ~heads & circle & (lum > 40)
	gy, gx = np.gradient(heads.astype(np.float32))
	nx, ny = -gx, -gy
	norm = np.sqrt(nx * nx + ny * ny) + 1e-6
	nx, ny = nx / norm, ny / norm
	ldx, ldy = 0.56 * w - xx, 0.30 * h - yy
	ln = np.sqrt(ldx * ldx + ldy * ldy) + 1e-6
	ldx, ldy = ldx / ln, ldy / ln
	strength = np.clip((nx * ldx + ny * ldy - 0.18) / 0.65, 0, 1)
	lit = strength > 0
	out = px.copy()
	for c in range(3):
		out[:, :, c] = np.where(
			edge_in & lit, out[:, :, c] * (1 - 0.55 * strength) + moon_rgb[c] * (0.55 * strength), out[:, :, c]
		)
		out[:, :, c] = np.where(
			edge_out & lit, out[:, :, c] * (1 - 0.12 * strength) + moon_rgb[c] * (0.12 * strength), out[:, :, c]
		)
	out[:, :, 3] = px[:, :, 3]
	return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")


def master_mark() -> Image.Image:
	return add_head_rim(crop_circle(Image.open(SOURCE).convert("RGB")))


def padded(im: Image.Image, pad: float, size: int) -> Image.Image:
	inner = int(round(size / (1 + 2 * pad)))
	mark = im.resize((inner, inner), Image.Resampling.LANCZOS)
	canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
	off = (size - inner) // 2
	canvas.paste(mark, (off, off), mark)
	return canvas


def flatten_navy(im: Image.Image) -> Image.Image:
	bg = Image.new("RGBA", im.size, NAVY)
	return Image.alpha_composite(bg, im.convert("RGBA")).convert("RGB")


def save_png(im: Image.Image, path: Path) -> None:
	im.save(path, "PNG", optimize=True)


def write_ico(path: Path, master: Image.Image) -> None:
	images: list[tuple[int, bytes]] = []
	for size in (16, 32, 48):
		buf = io.BytesIO()
		master.resize((size, size), Image.Resampling.LANCZOS).save(buf, "PNG", optimize=True)
		images.append((size, buf.getvalue()))
	offset = 6 + 16 * len(images)
	entries = []
	payload = b""
	for size, png in images:
		w = 0 if size >= 256 else size
		entries.append(struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(png), offset))
		payload += png
		offset += len(png)
	path.write_bytes(struct.pack("<HHH", 0, 1, len(images)) + b"".join(entries) + payload)


def load_note_masks() -> list[Image.Image]:
	im = Image.open(NOTES_SOURCE).convert("RGBA")
	arr = np.asarray(im)
	lum = 0.2126 * arr[:, :, 0] + 0.7152 * arr[:, :, 1] + 0.0722 * arr[:, :, 2]
	dark = lum < 100
	runs = [(35, 355), (442, 685), (776, 988)]
	notes: list[Image.Image] = []
	for left, right in runs:
		strip = dark[:, left : right + 1]
		ys, xs = np.where(strip)
		top, bot = int(ys.min()), int(ys.max())
		l, r = int(xs.min()), int(xs.max())
		pad = 2
		top = max(0, top - pad)
		bot = min(strip.shape[0] - 1, bot + pad)
		l = max(0, l - pad)
		r = min(strip.shape[1] - 1, r + pad)
		notes.append(Image.fromarray((strip[top : bot + 1, l : r + 1].astype(np.uint8) * 255), "L"))
	return notes


def simple_circle_mark(size: int, notes: list[Image.Image] | None = None) -> Image.Image:
	"""Round night disc + crescent + the three brand notes."""
	if notes is None:
		notes = load_note_masks()
	s = max(512, size * 16)
	im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
	draw = ImageDraw.Draw(im)
	pad = s * 0.04
	draw.ellipse((pad, pad, s - 1 - pad, s - 1 - pad), fill=NIGHT)

	moon = Image.new("L", (s, s), 0)
	md = ImageDraw.Draw(moon)
	mx, my, mr = 0.72 * s, 0.22 * s, 0.145 * s
	bx, by, br = 0.635 * s, 0.185 * s, 0.125 * s
	md.ellipse((mx - mr, my - mr, mx + mr, my + mr), fill=255)
	md.ellipse((bx - br, by - br, bx + br, by + br), fill=0)
	im.paste(Image.new("RGBA", (s, s), MOON), (0, 0), moon)

	placements = [
		(0, 0.26, 0.62, 0.30, -12),
		(1, 0.50, 0.70, 0.28, 0),
		(2, 0.74, 0.55, 0.27, 10),
	]
	for idx, cx, cy, hf, rot in placements:
		n = notes[idx]
		nh = int(s * hf)
		nw = max(1, int(n.size[0] * nh / n.size[1]))
		scaled = n.resize((nw, nh), Image.Resampling.LANCZOS)
		if rot:
			scaled = scaled.rotate(rot, resample=Image.Resampling.BICUBIC, expand=True)
		layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
		x = int(cx * s - scaled.size[0] / 2)
		y = int(cy * s - scaled.size[1] / 2)
		layer.paste(Image.new("RGBA", scaled.size, MOON), (x, y), scaled)
		im = Image.alpha_composite(im, layer)

	return im.resize((size, size), Image.Resampling.LANCZOS)


def write_favicon_svg(path: Path, master: Image.Image) -> None:
	buf = io.BytesIO()
	master.resize((128, 128), Image.Resampling.LANCZOS).save(buf, "PNG", optimize=True)
	b64 = base64.b64encode(buf.getvalue()).decode("ascii")
	path.write_text(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Fællesbandet">\n'
		f'	<image href="data:image/png;base64,{b64}" width="128" height="128"/>\n'
		"</svg>\n",
		encoding="utf-8",
	)


def write_pinned_tab(path: Path) -> None:
	path.write_text(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n'
		'	<circle cx="16" cy="16" r="15"/>\n'
		"</svg>\n",
		encoding="utf-8",
	)


def write_og(path: Path, master: Image.Image) -> None:
	canvas = Image.new("RGB", (1200, 630), NAVY[:3])
	mark = master.resize((520, 520), Image.Resampling.LANCZOS)
	flat = flatten_navy(mark)
	canvas.paste(flat, ((1200 - 520) // 2, (630 - 520) // 2))
	canvas.save(path, "PNG", optimize=True)


def main() -> None:
	if not SOURCE.exists():
		raise SystemExit(f"Missing source drawing: {SOURCE}")
	if not NOTES_SOURCE.exists():
		raise SystemExit(f"Missing note source: {NOTES_SOURCE}")
	STATIC.mkdir(exist_ok=True)

	# Full illustration for on-page mark
	mark = master_mark()
	# Simplified round mark for tabs / home screen
	notes = load_note_masks()
	fav = simple_circle_mark(512, notes)
	app = flatten_navy(fav)
	fav_safe = Image.new("RGBA", (512, 512), NAVY)
	inner = simple_circle_mark(420, notes)
	fav_safe.paste(inner, ((512 - 420) // 2, (512 - 420) // 2), inner)
	fav_safe_rgb = fav_safe.convert("RGB")

	save_png(padded(mark, 0.06, 256), STATIC / "logo-mark.png")
	save_png(app.resize((180, 180), Image.Resampling.LANCZOS), STATIC / "faellesbandet-icon-v2.png")
	save_png(app.resize((180, 180), Image.Resampling.LANCZOS), STATIC / "apple-touch-icon.png")
	save_png(app.resize((192, 192), Image.Resampling.LANCZOS), STATIC / "icon-192.png")
	save_png(app.resize((512, 512), Image.Resampling.LANCZOS), STATIC / "icon-512.png")
	save_png(fav_safe_rgb, STATIC / "icon-512-maskable.png")
	save_png(simple_circle_mark(32, notes), STATIC / "favicon-32.png")
	save_png(simple_circle_mark(32, notes), STATIC / "favicon-32x32.png")
	save_png(simple_circle_mark(96, notes), STATIC / "favicon-96x96.png")
	write_ico(STATIC / "favicon.ico", simple_circle_mark(256, notes))
	write_favicon_svg(STATIC / "favicon.svg", simple_circle_mark(128, notes))
	write_pinned_tab(STATIC / "safari-pinned-tab.svg")
	write_og(STATIC / "og-image.png", fav)
	print("wrote icons in", STATIC)


if __name__ == "__main__":
	main()
