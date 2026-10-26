/**
 * Overdub: play the existing take in the headphones, record a new voice
 * through a short vocal chain (body cut, presence, plate), and print one
 * mixed file. The backing is delayed into the mix by the output latency so
 * the sung line lands on what the singer actually heard.
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

/** AirPods and other wireless headsets sit well behind outputLatency. */
const BLUETOOTH_LAG = 0.16;

async function usesBluetoothOutput(stream: MediaStream): Promise<boolean> {
	const labels = stream.getAudioTracks().map((track) => track.label);
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		for (const device of devices) {
			if (device.kind === 'audiooutput' || device.kind === 'audioinput') labels.push(device.label);
		}
	} catch {
		// Labels stay empty on some phones. The Bluetooth toggle covers that.
	}
	return labels.some((label) => /airpod|bluetooth|beats|bose|headset|buds|wh-|wf-/i.test(label));
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
	bluetooth = false
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
		const wireless = bluetooth || (await usesBluetoothOutput(stream));

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
		voiceMonitor.gain.value = 0.4;

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
		plateMonitor.gain.value = 0.34;
		tailLp.connect(plateMonitor);
		voiceMonitor.connect(ctx.destination);
		plateMonitor.connect(ctx.destination);

		const heard = ctx.createGain();
		heard.gain.value = 0.88;
		const printed = ctx.createGain();
		printed.gain.value = 0.66;
		const align = ctx.createDelay(0.45);
		const reported = ctx.outputLatency > 0 ? ctx.outputLatency : ctx.baseLatency || 0;
		align.delayTime.value = wireless
			? Math.max(reported, BLUETOOTH_LAG)
			: Math.min(0.25, Math.max(0, reported));

		const backingSrc = ctx.createBufferSource();
		backingSrc.buffer = backing;
		backingSrc.connect(heard);
		backingSrc.connect(align);
		align.connect(printed);
		heard.connect(ctx.destination);

		const mix = ctx.createGain();
		mix.gain.value = 1;
		dry.connect(mix);
		wet.connect(mix);
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
		const startedAt = performance.now();

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

		raf = requestAnimationFrame(tick);
		recorder.start(1000);
		backingSrc.start(ctx.currentTime + 0.03);

		return { stop };
	} catch (err) {
		for (const track of stream?.getTracks() ?? []) track.stop();
		void ctx.close();
		throw err;
	}
}
