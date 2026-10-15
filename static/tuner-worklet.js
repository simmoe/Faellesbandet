/**
 * Karplus–Strong plucked string with a fractional delay line so the six
 * guitar references land on pitch, not the nearest integer sample period.
 * Treble strings use less loop damping and a brighter burst, and the delay
 * is shortened by the one-pole filter's phase so D/G/B/e stay in tune.
 */
class KarplusStrongProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buf = new Float32Array(8192);
		this.write = 0;
		this.period = 100;
		this.running = false;
		this.lp = 0;
		this.damp = 0.5;
		this.fb = 0.996;
		this.amp = 1.35;
		this.port.onmessage = (event) => {
			if (event.data?.type === 'pluck') this.pluck(event.data.hz);
		};
	}

	pluck(hz) {
		const freq = Math.max(40, Math.min(1200, Number(hz) || 110));
		const t = Math.min(1, Math.max(0, (freq - 82) / 248));
		this.damp = 0.46 - t * 0.3;
		this.fb = 0.9935 + t * 0.0045;
		this.amp = 1.2 + t * 0.7;
		const w = (2 * Math.PI * freq) / sampleRate;
		const pole = this.fb * this.damp;
		const filterDelay =
			w > 1e-6 ? Math.atan2(pole * Math.sin(w), 1 - pole * Math.cos(w)) / w : pole;
		this.period = Math.max(4, sampleRate / freq - filterDelay);
		this.buf.fill(0);
		const burst = Math.max(16, Math.min(this.buf.length - 2, Math.floor(this.period)));
		const leak = 0.92 - t * 0.4;
		let acc = 0;
		for (let i = 0; i < burst; i++) {
			const noise = Math.random() * 2 - 1;
			acc = acc * leak + noise;
			const env = Math.sin((Math.PI * (i + 0.5)) / burst);
			this.buf[i] = (acc * (0.17 + t * 0.08) + noise * t * 0.1) * env;
		}
		this.write = burst % this.buf.length;
		this.lp = 0;
		this.running = true;
	}

	process(_inputs, outputs) {
		const out = outputs[0]?.[0];
		if (!out) return true;
		if (!this.running) {
			out.fill(0);
			return true;
		}
		const buf = this.buf;
		const n = buf.length;
		const period = this.period;
		const damp = this.damp;
		const fb = this.fb;
		const amp = this.amp;
		let write = this.write;
		let lp = this.lp;
		for (let i = 0; i < out.length; i++) {
			let rp = write - period;
			rp -= n * Math.floor(rp / n);
			if (rp < 0) rp += n;
			const i0 = rp | 0;
			const f = rp - i0;
			const i1 = i0 + 1 < n ? i0 + 1 : 0;
			const delayed = buf[i0] * (1 - f) + buf[i1] * f;
			const y = fb * (lp * damp + delayed * (1 - damp));
			lp = y;
			buf[write] = y;
			write = write + 1 < n ? write + 1 : 0;
			out[i] = y * amp;
		}
		this.write = write;
		this.lp = lp;
		return true;
	}
}

registerProcessor('karplus-strong', KarplusStrongProcessor);
