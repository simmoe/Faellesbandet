#!/usr/bin/env python3
"""Build Fællesbandet icons from the hand-drawn circular mark.

Requires Pillow + numpy (local tools, not an app dependency).
Source: scripts/brand/logo-source.jpg
"""

from __future__ import annotations

import base64
import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts" / "brand" / "logo-source.jpg"
STATIC = ROOT / "static"

CREAM = np.array([244, 234, 214], dtype=np.float32)
GRAPHITE = np.array([32, 28, 24], dtype=np.float32)
MASK_COLOR = "#2a2622"


def find_circle(gray: np.ndarray) -> tuple[float, float, float]:
	dark = gray < 90
	ys, xs = np.where(dark)
	if len(xs) == 0:
		raise SystemExit("Could not find the drawn circle in the source photo.")
	cx = float(xs.mean())
	cy = float(ys.mean())
	dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
	return cx, cy, float(np.percentile(dist, 99.2))


def crop_square(im: Image.Image, cx: float, cy: float, radius: float, pad: float) -> Image.Image:
	half = radius * (1.0 + pad)
	w, h = im.size
	left = int(round(cx - half))
	top = int(round(cy - half))
	right = int(round(cx + half))
	bottom = int(round(cy + half))
	side = max(right - left, bottom - top)
	left = int(round(cx - side / 2))
	top = int(round(cy - side / 2))
	right = left + side
	bottom = top + side
	# If the photo clips one side, keep the square and let PIL pad via crop clamp + paste
	canvas = Image.new("RGB", (side, side), tuple(int(c) for c in CREAM))
	src_left = max(0, left)
	src_top = max(0, top)
	src_right = min(w, right)
	src_bottom = min(h, bottom)
	piece = im.crop((src_left, src_top, src_right, src_bottom))
	canvas.paste(piece, (src_left - left, src_top - top))
	return canvas


def grade(im: Image.Image) -> Image.Image:
	c = np.asarray(im, dtype=np.float32)
	h, w, _ = c.shape
	band = max(8, h // 20)
	paper = np.concatenate(
		[
			c[:band, :].reshape(-1, 3),
			c[-band:, :].reshape(-1, 3),
			c[:, :band].reshape(-1, 3),
			c[:, -band:].reshape(-1, 3),
		],
		axis=0,
	)
	paper_rgb = np.median(paper, axis=0)
	lum = 0.2126 * c[:, :, 0] + 0.7152 * c[:, :, 1] + 0.0722 * c[:, :, 2]
	p_lum = float(0.2126 * paper_rgb[0] + 0.7152 * paper_rgb[1] + 0.0722 * paper_rgb[2])
	dark = lum[lum < 100]
	d_lum = float(np.percentile(dark, 8)) if dark.size else float(lum.min())
	t = np.clip((lum - d_lum) / max(8.0, p_lum - d_lum), 0, 1)
	t = np.power(t, 0.92)
	out = GRAPHITE[None, None, :] * (1 - t)[..., None] + CREAM[None, None, :] * t[..., None]
	graded = Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGB")
	return graded.filter(ImageFilter.UnsharpMask(radius=1.6, percent=90, threshold=2))


def master_from_source(pad: float) -> Image.Image:
	im = Image.open(SOURCE).convert("RGB")
	gray = np.asarray(im.convert("L"), dtype=np.float32)
	cx, cy, radius = find_circle(gray)
	return grade(crop_square(im, cx, cy, radius, pad))


def save_png(im: Image.Image, path: Path, size: int) -> None:
	im.resize((size, size), Image.Resampling.LANCZOS).save(path, "PNG", optimize=True)


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


def write_favicon_svg(path: Path, master: Image.Image) -> None:
	buf = io.BytesIO()
	master.resize((256, 256), Image.Resampling.LANCZOS).save(buf, "PNG", optimize=True)
	b64 = base64.b64encode(buf.getvalue()).decode("ascii")
	path.write_text(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Fællesbandet">\n'
		f'	<image href="data:image/png;base64,{b64}" width="256" height="256"/>\n'
		"</svg>\n",
		encoding="utf-8",
	)


def write_pinned_tab(path: Path) -> None:
	path.write_text(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">\n'
		f'	<circle cx="64" cy="64" r="58" fill="{MASK_COLOR}"/>\n'
		"</svg>\n",
		encoding="utf-8",
	)


def write_og(path: Path, master: Image.Image) -> None:
	canvas = Image.new("RGB", (1200, 630), tuple(int(c) for c in CREAM))
	mark = master.resize((520, 520), Image.Resampling.LANCZOS)
	canvas.paste(mark, ((1200 - 520) // 2, (630 - 520) // 2))
	canvas.save(path, "PNG", optimize=True)


def main() -> None:
	if not SOURCE.exists():
		raise SystemExit(f"Missing source drawing: {SOURCE}")
	STATIC.mkdir(exist_ok=True)

	app = master_from_source(pad=0.14)
	tight = master_from_source(pad=0.06)
	safe = master_from_source(pad=0.28)

	save_png(app, STATIC / "faellesbandet-icon-v1.png", 180)
	save_png(app, STATIC / "apple-touch-icon.png", 180)
	save_png(app, STATIC / "icon-192.png", 192)
	save_png(app, STATIC / "icon-512.png", 512)
	save_png(safe, STATIC / "icon-512-maskable.png", 512)
	save_png(tight, STATIC / "favicon-32.png", 32)
	save_png(tight, STATIC / "favicon-32x32.png", 32)
	save_png(tight, STATIC / "favicon-96x96.png", 96)
	write_ico(STATIC / "favicon.ico", tight)
	write_favicon_svg(STATIC / "favicon.svg", tight)
	write_pinned_tab(STATIC / "safari-pinned-tab.svg")
	write_og(STATIC / "og-image.png", app)
	print("wrote icons in", STATIC)


if __name__ == "__main__":
	main()
