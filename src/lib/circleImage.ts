/** Map a full rectangular photo into a circle with a mild wide-angle squeeze. */

const DEFAULT_FILL = '#f7f3ea';
const DEFAULT_SIZE = 1400;
const DEFAULT_STRENGTH = 0.78;

export async function toCircularWideAngle(
	src: string,
	opts?: { size?: number; fill?: string; strength?: number }
): Promise<string> {
	const size = opts?.size ?? DEFAULT_SIZE;
	const strength = opts?.strength ?? DEFAULT_STRENGTH;
	const fill = parseHex(opts?.fill ?? DEFAULT_FILL);
	const img = await loadImage(src);
	const srcW = img.naturalWidth;
	const srcH = img.naturalHeight;
	if (srcW < 2 || srcH < 2) throw new Error('Kategori-billedet er tomt.');

	const srcCanvas = document.createElement('canvas');
	srcCanvas.width = srcW;
	srcCanvas.height = srcH;
	const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
	if (!srcCtx) throw new Error('Kunne ikke læse kategori-billedet.');
	srcCtx.drawImage(img, 0, 0);
	const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

	const out = document.createElement('canvas');
	out.width = size;
	out.height = size;
	const ctx = out.getContext('2d');
	if (!ctx) throw new Error('Kunne ikke tegne kategori-billedet.');
	const dest = ctx.createImageData(size, size);
	const pixels = dest.data;
	const cx = (size - 1) / 2;
	const cy = (size - 1) / 2;
	const radius = size / 2;
	const tanS = Math.tan(strength);
	const halfW = (srcW - 1) / 2;
	const halfH = (srcH - 1) / 2;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const nx = (x - cx) / radius;
			const ny = (y - cy) / radius;
			const r = Math.hypot(nx, ny);
			const i = (y * size + x) * 4;
			if (r > 1) {
				pixels[i] = fill[0];
				pixels[i + 1] = fill[1];
				pixels[i + 2] = fill[2];
				pixels[i + 3] = 255;
				continue;
			}
			const warped = r < 1e-6 ? 0 : Math.tan(r * strength) / tanS;
			const dist = warped * edgeDist(nx, ny, r, halfW, halfH);
			const sx = halfW + (r < 1e-6 ? 0 : (nx / r) * dist);
			const sy = halfH + (r < 1e-6 ? 0 : (ny / r) * dist);
			const sample = sampleBilinear(srcData, srcW, srcH, sx, sy);
			pixels[i] = sample[0];
			pixels[i + 1] = sample[1];
			pixels[i + 2] = sample[2];
			pixels[i + 3] = 255;
		}
	}

	ctx.putImageData(dest, 0, 0);
	return out.toDataURL('image/jpeg', 0.92);
}

function edgeDist(nx: number, ny: number, r: number, halfW: number, halfH: number): number {
	if (r < 1e-6) return 0;
	const c = Math.abs(nx / r);
	const s = Math.abs(ny / r);
	const xHit = c < 1e-6 ? Number.POSITIVE_INFINITY : halfW / c;
	const yHit = s < 1e-6 ? Number.POSITIVE_INFINITY : halfH / s;
	return Math.min(xHit, yHit);
}

function sampleBilinear(
	data: Uint8ClampedArray,
	w: number,
	h: number,
	x: number,
	y: number
): [number, number, number] {
	const xx = clamp(x, 0, w - 1);
	const yy = clamp(y, 0, h - 1);
	const x0 = Math.floor(xx);
	const y0 = Math.floor(yy);
	const x1 = Math.min(x0 + 1, w - 1);
	const y1 = Math.min(y0 + 1, h - 1);
	const fx = xx - x0;
	const fy = yy - y0;
	const a = pixel(data, w, x0, y0);
	const b = pixel(data, w, x1, y0);
	const c = pixel(data, w, x0, y1);
	const d = pixel(data, w, x1, y1);
	return [
		Math.round(lerp(lerp(a[0], b[0], fx), lerp(c[0], d[0], fx), fy)),
		Math.round(lerp(lerp(a[1], b[1], fx), lerp(c[1], d[1], fx), fy)),
		Math.round(lerp(lerp(a[2], b[2], fx), lerp(c[2], d[2], fx), fy))
	];
}

function pixel(
	data: Uint8ClampedArray,
	w: number,
	x: number,
	y: number
): [number, number, number] {
	const i = (y * w + x) * 4;
	return [data[i], data[i + 1], data[i + 2]];
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

function parseHex(hex: string): [number, number, number] {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	const n = m ? parseInt(m[1], 16) : 0xf7f3ea;
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Kunne ikke indlæse kategori-billedet.'));
		img.src = src;
	});
}
