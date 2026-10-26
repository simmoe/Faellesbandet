/** A short stick click. Downbeats are a touch louder, same sound. */

const noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();

function noise(ctx: AudioContext): AudioBuffer {
	const cached = noiseBuffers.get(ctx);
	if (cached) return cached;
	const length = Math.floor(ctx.sampleRate * 0.03);
	const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
	noiseBuffers.set(ctx, buffer);
	return buffer;
}

export function scheduleClick(
	ctx: AudioContext,
	time: number,
	accent = false,
	out: AudioNode = ctx.destination
) {
	const source = ctx.createBufferSource();
	source.buffer = noise(ctx);
	const band = ctx.createBiquadFilter();
	band.type = 'bandpass';
	band.frequency.value = accent ? 3400 : 2500;
	band.Q.value = 0.7;
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(accent ? 0.62 : 0.4, time);
	gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.016);
	source.connect(band);
	band.connect(gain);
	gain.connect(out);
	source.start(time);
	source.stop(time + 0.03);
}
