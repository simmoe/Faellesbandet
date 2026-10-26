/**
 * Overdub: play the existing take in the headphones, record a new voice
 * through a short vocal chain (body cut, presence, plate), and print one
 * mixed file. A count-in (1, 2, 3, Pyyh) measures how late the voice arrives
 * against the click the singer actually heard, and that offset delays the
 * backing into the mix.
 */
import type { RecordingSession, SongTake } from './recordAudio';

export type OverdubSession = RecordingSession;

function voiceConstraints(): MediaTrackConstraints {
	return {
		channelCount: 1,
		echoCancellation: false,
		noiseSuppression: false,
		autoGainControl: false,
		voiceIsolation: false,
		googEchoCancellation: false,
		googNoiseSuppression: false,
		googAutoGainControl: false,
		googHighpassFilter: false
	} as MediaTrackConstraints;
}

/** One beat of the count-in. Slow enough that a plosive can sit on the fourth. */
const COUNT_BEAT = 0.7;

function scheduleClick(ctx: AudioContext, time: number) {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(1800, time);
	osc.frequency.exponentialRampToValueAtTime(700, time + 0.028);
	gain.gain.setValueAtTime(0.0001, time);
	gain.gain.exponentialRampToValueAtTime(0.32, time + 0.002);
	gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.start(time);
	osc.stop(time + 0.06);
}

/** Onset of the loudest sound after beat 1. `at` is seconds from beat 1. */
function loudest(chunks: { t: number; data: Float32Array }[], rate: number, beat1: number) {
	let samples = 0;
	let peak = 0;
	let peakAt = 0;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.data.length; i++) {
			const rel = chunk.t + i / rate - beat1;
			if (rel < 0) continue;
			samples += 1;
			const level = Math.abs(chunk.data[i]);
			if (level > peak) {
				peak = level;
				peakAt = rel;
			}
		}
	}
	const gate = peak * 0.3;
	const hold = Math.max(3, Math.floor(rate * 0.003));
	let run = 0;
	let at = peakAt;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.data.length; i++) {
			const rel = chunk.t + i / rate - beat1;
			if (rel < peakAt - 0.12 || rel > peakAt) {
				run = 0;
				continue;
			}
			if (Math.abs(chunk.data[i]) >= gate) {
				if (run === 0) at = rel;
				run += 1;
				if (run >= hold) return { samples, peak, at };
			} else {
				run = 0;
			}
		}
	}
	return { samples, peak, at: peakAt };
}

const PROBE_SOURCE = `
class PyhhProbe extends AudioWorkletProcessor {
	process(inputs, outputs) {
		const channel = inputs[0] && inputs[0][0];
		const out = outputs[0] && outputs[0][0];
		if (out) out.fill(0);
		if (channel && channel.length) {
			const copy = new Float32Array(channel);
			this.port.postMessage({ t: currentTime, samples: copy }, [copy.buffer]);
		}
		return true;
	}
}
registerProcessor('pyhh-probe', PyhhProbe);
`;

/** Three clicks, then the singer says Pyyh on the fourth beat. */
async function countIn(
	ctx: AudioContext,
	mic: AudioNode,
	onCue: () => void
): Promise<{ latency: number; songAt: number }> {
	const rate = ctx.sampleRate;
	const chunks: { t: number; data: Float32Array }[] = [];
	const url = URL.createObjectURL(new Blob([PROBE_SOURCE], { type: 'application/javascript' }));
	try {
		await ctx.audioWorklet.addModule(url);
	} catch {
		throw new Error('Kunne ikke måle forsinkelsen i den her browser.');
	} finally {
		URL.revokeObjectURL(url);
	}

	const probe = new AudioWorkletNode(ctx, 'pyhh-probe', {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [1],
		channelCount: 1,
		channelCountMode: 'explicit'
	});
	const sink = ctx.createGain();
	sink.gain.value = 0;
	mic.connect(probe);
	probe.connect(sink);
	sink.connect(ctx.destination);

	const beat = COUNT_BEAT;
	const beat1 = ctx.currentTime + 0.35;
	const until = beat1 + 4 * beat;
	scheduleClick(ctx, beat1);
	scheduleClick(ctx, beat1 + beat);
	scheduleClick(ctx, beat1 + 2 * beat);
	onCue();

	try {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => resolve(), 5000);
			probe.port.onmessage = (event: MessageEvent<{ t: number; samples: Float32Array }>) => {
				const { t, samples } = event.data;
				if (!samples || samples.length === 0) return;
				chunks.push({ t, data: samples });
				if (t + samples.length / rate >= until) {
					clearTimeout(timer);
					resolve();
				}
			};
		});
	} finally {
		probe.port.onmessage = null;
		try {
			probe.disconnect();
			sink.disconnect();
			mic.disconnect(probe);
		} catch {
			// The context may already be closing.
		}
	}

	const heard = loudest(chunks, rate, beat1);
	const beat4 = 3 * beat;
	const raw = heard.at - beat4;
	if (heard.samples === 0 || heard.peak < 0.02) {
		throw new Error('Måling: ingen lyd i optagelsen.');
	}
	if (raw < 0 || raw > 0.7) {
		throw new Error(
			`Måling: top ${heard.peak.toFixed(2)} ved ${heard.at.toFixed(2)} s. Slag 4 er ${beat4.toFixed(2)} s.`
		);
	}
	return { latency: Math.max(0, raw - 0.05), songAt: beat1 + 4 * beat };
}

function pickMimeType(): { mimeType: string; extension: string } {
	const candidates = [
		'audio/webm;codecs=opus',
		'audio/webm',
		'audio/mp4;codecs=mp4a.40.2',
		'audio/mp4',
		'audio/ogg;codecs=opus'
	];
	for (const mimeType of candidates) {
		if (MediaRecorder.isTypeSupported(mimeType)) {
			if (mimeType.includes('mp4')) return { mimeType, extension: 'm4a' };
			if (mimeType.includes('ogg')) return { mimeType, extension: 'ogg' };
			return { mimeType, extension: 'webm' };
		}
	}
	return { mimeType: '', extension: 'webm' };
}

/** Short vocal plate: a few early taps, then a dark exponential tail. */
function vocalPlate(ctx: AudioContext): AudioBuffer {
	const seconds = 1.35;
	const rate = ctx.sampleRate;
	const length = Math.floor(rate * seconds);
	const buffer = ctx.createBuffer(2, length, rate);
	const taps = [0.011, 0.017, 0.029, 0.041, 0.057];
	const gains = [0.46, 0.32, 0.2, 0.13, 0.08];
	for (let ch = 0; ch < 2; ch++) {
		const data = buffer.getChannelData(ch);
		const offset = ch === 0 ? 0 : Math.floor(rate * 0.006);
		for (let t = 0; t < taps.length; t++) {
			const i = Math.floor(taps[t] * rate) + offset;
			if (i >= 0 && i < length) data[i] += gains[t];
		}
		let seed = 1601 + ch * 97;
		const rand = () => {
			seed = (seed * 48271) % 2147483647;
			return (seed / 2147483647) * 2 - 1;
		};
		let low = 0;
		const cutoff = ch === 0 ? 0.11 : 0.14;
		for (let i = Math.floor(rate * 0.018); i < length; i++) {
			low += cutoff * (rand() - low);
			data[i] += low * Math.exp(-2.4 * (i / rate)) * 0.5;
		}
		let peak = 0;
		for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(data[i]));
		const scale = peak > 0 ? 0.8 / peak : 1;
		for (let i = 0; i < length; i++) data[i] *= scale;
	}
	return buffer;
}

export async function startOverdub(
	ctx: AudioContext,
	ready: Promise<unknown>,
	backingBytes: Promise<ArrayBuffer>,
	onLevel: (level: number) => void,
	onFinished: () => void,
	onCue: () => void = () => {},
	onMeasured: (latency: number) => void = () => {}
): Promise<OverdubSession> {
	const { mimeType, extension } = pickMimeType();
	let stream: MediaStream | null = null;
	try {
		await ready;
		if (ctx.state === 'suspended') await ctx.resume();

		const [micStream, backing] = await Promise.all([
			navigator.mediaDevices.getUserMedia({ audio: voiceConstraints(), video: false }),
			backingBytes.then((bytes) => ctx.decodeAudioData(bytes.slice(0)))
		]);
		stream = micStream;
		const mic = ctx.createMediaStreamSource(stream);

		const rumble = ctx.createBiquadFilter();
		rumble.type = 'highpass';
		rumble.frequency.value = 105;
		rumble.Q.value = 0.7;

		const body = ctx.createBiquadFilter();
		body.type = 'peaking';
		body.frequency.value = 260;
		body.Q.value = 0.8;
		body.gain.value = -1.4;

		const presence = ctx.createBiquadFilter();
		presence.type = 'peaking';
		presence.frequency.value = 3400;
		presence.Q.value = 0.85;
		presence.gain.value = 2.5;

		const air = ctx.createBiquadFilter();
		air.type = 'highshelf';
		air.frequency.value = 10000;
		air.gain.value = 1.1;

		const vocal = ctx.createDynamicsCompressor();
		vocal.threshold.value = -18;
		vocal.knee.value = 12;
		vocal.ratio.value = 2.6;
		vocal.attack.value = 0.008;
		vocal.release.value = 0.16;

		const predelay = ctx.createDelay(0.1);
		predelay.delayTime.value = 0.028;

		const sendHp = ctx.createBiquadFilter();
		sendHp.type = 'highpass';
		sendHp.frequency.value = 200;
		sendHp.Q.value = 0.7;

		const plate = ctx.createConvolver();
		plate.buffer = vocalPlate(ctx);

		const tailLp = ctx.createBiquadFilter();
		tailLp.type = 'lowpass';
		tailLp.frequency.value = 6400;
		tailLp.Q.value = 0.7;

		const makeup = ctx.createGain();
		makeup.gain.value = 1.9;
		const dry = ctx.createGain();
		dry.gain.value = 1;
		const wet = ctx.createGain();
		wet.gain.value = 0.16;
		const voiceMonitor = ctx.createGain();
		voiceMonitor.gain.value = 0;

		mic.connect(rumble);
		rumble.connect(body);
		body.connect(presence);
		presence.connect(air);
		air.connect(vocal);
		vocal.connect(makeup);
		makeup.connect(dry);
		makeup.connect(predelay);
		makeup.connect(voiceMonitor);
		predelay.connect(sendHp);
		sendHp.connect(plate);
		plate.connect(tailLp);
		tailLp.connect(wet);
		const plateMonitor = ctx.createGain();
		plateMonitor.gain.value = 0;
		tailLp.connect(plateMonitor);
		voiceMonitor.connect(ctx.destination);
		plateMonitor.connect(ctx.destination);

		const heard = ctx.createGain();
		heard.gain.value = 0.88;
		const printed = ctx.createGain();
		printed.gain.value = 0.66;
		const align = ctx.createDelay(0.8);
		align.delayTime.value = 0;

		const backingSrc = ctx.createBufferSource();
		backingSrc.buffer = backing;
		backingSrc.connect(heard);
		backingSrc.connect(align);
		align.connect(printed);
		heard.connect(ctx.destination);

		const mix = ctx.createGain();
		mix.gain.value = 1;
		const voiceAlign = ctx.createDelay(0.15);
		voiceAlign.delayTime.value = 0;
		dry.connect(voiceAlign);
		wet.connect(voiceAlign);
		voiceAlign.connect(mix);
		printed.connect(mix);

		const glue = ctx.createDynamicsCompressor();
		glue.threshold.value = -18;
		glue.knee.value = 8;
		glue.ratio.value = 1.6;
		glue.attack.value = 0.01;
		glue.release.value = 0.18;

		const limit = ctx.createDynamicsCompressor();
		limit.threshold.value = -1.5;
		limit.knee.value = 0;
		limit.ratio.value = 20;
		limit.attack.value = 0.002;
		limit.release.value = 0.05;

		const analyser = ctx.createAnalyser();
		analyser.fftSize = 2048;
		analyser.smoothingTimeConstant = 0.55;
		const dest = ctx.createMediaStreamDestination();
		mix.connect(glue);
		glue.connect(limit);
		limit.connect(dest);
		vocal.connect(analyser);

		const chunks: BlobPart[] = [];
		let recorder: MediaRecorder;
		try {
			recorder = mimeType
				? new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: 256000 })
				: new MediaRecorder(dest.stream, { audioBitsPerSecond: 192000 });
		} catch {
			recorder = new MediaRecorder(dest.stream);
		}
		const usedType = recorder.mimeType || mimeType || 'audio/webm';
		const usedExt = usedType.includes('mp4') ? 'm4a' : usedType.includes('ogg') ? 'ogg' : extension;
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};

		const timeData = new Uint8Array(analyser.fftSize);
		let raf = 0;
		const tick = () => {
			analyser.getByteTimeDomainData(timeData);
			let sum = 0;
			for (let i = 0; i < timeData.length; i++) {
				const v = (timeData[i] - 128) / 128;
				sum += v * v;
			}
			onLevel(Math.min(1, Math.sqrt(sum / timeData.length) * 3.2));
			raf = requestAnimationFrame(tick);
		};

		let stopped = false;
		let tail: ReturnType<typeof setTimeout> | null = null;
		let stopPromise: Promise<SongTake> | null = null;
		let startedAt = 0;

		const teardown = () => {
			if (tail) clearTimeout(tail);
			cancelAnimationFrame(raf);
			onLevel(0);
			try {
				backingSrc.stop();
			} catch {
				// already ended
			}
			for (const track of stream.getTracks()) track.stop();
			void ctx.close();
		};

		const stop = () => {
			if (!stopPromise) {
				stopPromise = new Promise<SongTake>((resolve, reject) => {
					stopped = true;
					if (tail) clearTimeout(tail);
					const finish = () => {
						teardown();
						const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
						const blob = new Blob(chunks, { type: usedType });
						if (blob.size < 64) {
							reject(new Error('Optagelsen blev for kort.'));
							return;
						}
						resolve({ blob, mimeType: usedType, extension: usedExt, durationMs });
					};
					recorder.addEventListener(
						'error',
						() => {
							teardown();
							reject(new Error('Optagelsen fejlede.'));
						},
						{ once: true }
					);
					recorder.addEventListener('stop', finish, { once: true });
					if (recorder.state === 'inactive') finish();
					else recorder.stop();
				});
			}
			return stopPromise;
		};

		backingSrc.onended = () => {
			if (stopped) return;
			tail = setTimeout(() => onFinished(), 700);
		};

		const { latency, songAt } = await countIn(ctx, mic, onCue);
		align.delayTime.value = latency;
		onMeasured(latency);

		raf = requestAnimationFrame(tick);
		startedAt = performance.now();
		recorder.start(1000);
		backingSrc.start(Math.max(songAt, ctx.currentTime + 0.06));

		return { stop };
	} catch (err) {
		for (const track of stream?.getTracks() ?? []) track.stop();
		void ctx.close();
		throw err;
	}
}
