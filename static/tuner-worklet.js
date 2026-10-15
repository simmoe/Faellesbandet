/**
 * Karplus–Strong plucked string with a fractional delay line so the six
 * guitar references land on pitch, not the nearest integer sample period.
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
		this.port.onmessage = (event) => {
			if (event.data?.type === 'pluck') this.pluck(event.data.hz);
		};
	}

	pluck(hz) {
		const freq = Math.max(40, Math.min(1200, hz));
		this.period = sampleRate / freq;
		this.buf.fill(0);
		const burst = Math.max(8, Math.min(this.buf.length - 2, Math.floor(this.period)));
		let acc = 0;
		for (let i = 0; i < burst; i++) {
			acc = acc * 0.91 + (Math.random() * 2 - 1);
			this.buf[i] = acc * 0.22;
		}
		this.write = burst % this.buf.length;
		this.lp = 0;
		this.damp = 0.38 + Math.min(0.32, freq / 1600);
		this.fb = 0.991 + Math.min(0.007, freq / 70000);
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
			out[i] = y * 1.35;
		}
		this.write = write;
		this.lp = lp;
		return true;
	}
}

registerProcessor('karplus-strong', KarplusStrongProcessor);
