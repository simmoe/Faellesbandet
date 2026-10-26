import { scheduleClick } from './click';
import { applyMicDevice } from './micChoice';
import { openPlaybackTap } from './playbackSink';

/**
 * Capture a rehearsal take through Web Audio instead of a raw MediaRecorder
 * tap: disable phone "voice" DSP, then a short music chain (rumble cut,
 * presence, gentle glue, brickwall) before Opus/AAC encode.
 */
export type SongTake = {
	blob: Blob;
	mimeType: string;
	extension: string;
	durationMs: number;
};

export type RecordingSession = {
	stop: () => Promise<SongTake>;
};

const MIME_CANDIDATES = [
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/mp4;codecs=mp4a.40.2',
	'audio/mp4',
	'audio/ogg;codecs=opus'
];

function pickMimeType(): { mimeType: string; extension: string } {
	if (typeof MediaRecorder === 'undefined') {
		throw new Error('Denne browser kan ikke optage lyd.');
	}
	for (const mimeType of MIME_CANDIDATES) {
		if (MediaRecorder.isTypeSupported(mimeType)) {
			if (mimeType.includes('mp4')) return { mimeType, extension: 'm4a' };
			if (mimeType.includes('ogg')) return { mimeType, extension: 'ogg' };
			return { mimeType, extension: 'webm' };
		}
	}
	return { mimeType: '', extension: 'webm' };
}

function audioConstraints(): MediaTrackConstraints {
	return applyMicDevice({
		channelCount: 1,
		sampleRate: 48000,
		echoCancellation: false,
		noiseSuppression: false,
		autoGainControl: false,
		googEchoCancellation: false,
		googNoiseSuppression: false,
		googAutoGainControl: false,
		googHighpassFilter: false,
		googTypingNoiseDetection: false,
		voiceIsolation: false
	} as MediaTrackConstraints);
}

function connectMusicChain(ctx: AudioContext, source: MediaStreamAudioSourceNode) {
	const rumble = ctx.createBiquadFilter();
	rumble.type = 'highpass';
	rumble.frequency.value = 72;
	rumble.Q.value = 0.7;

	const presence = ctx.createBiquadFilter();
	presence.type = 'peaking';
	presence.frequency.value = 3200;
	presence.Q.value = 0.85;
	presence.gain.value = 2.4;

	const air = ctx.createBiquadFilter();
	air.type = 'highshelf';
	air.frequency.value = 8500;
	air.gain.value = 1.4;

	const glue = ctx.createDynamicsCompressor();
	glue.threshold.value = -22;
	glue.knee.value = 18;
	glue.ratio.value = 2.8;
	glue.attack.value = 0.012;
	glue.release.value = 0.16;

	const makeup = ctx.createGain();
	makeup.gain.value = 1.55;

	const limit = ctx.createDynamicsCompressor();
	limit.threshold.value = -1.8;
	limit.knee.value = 0;
	limit.ratio.value = 20;
	limit.attack.value = 0.002;
	limit.release.value = 0.05;

	source.connect(rumble);
	rumble.connect(presence);
	presence.connect(air);
	air.connect(glue);
	glue.connect(makeup);
	makeup.connect(limit);
	return limit;
}

/** Copy one mic channel into both ears. Safari otherwise stores the mono take on the right only. */
export function centerMono(ctx: AudioContext, input: AudioNode): ChannelMergerNode {
	const split = ctx.createChannelSplitter(2);
	const merge = ctx.createChannelMerger(2);
	input.connect(split);
	split.connect(merge, 0, 0);
	split.connect(merge, 0, 1);
	return merge;
}

export async function startSongRecording(
	onLevel: (level: number) => void,
	metronome?: { bpm: number }
): Promise<RecordingSession> {
	const { mimeType, extension } = pickMimeType();
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: audioConstraints(),
		video: false
	});

	let ctx: AudioContext;
	try {
		ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
	} catch {
		ctx = new AudioContext({ latencyHint: 'interactive' });
	}
	if (ctx.state === 'suspended') await ctx.resume();
	const playback = await openPlaybackTap(ctx);

	const source = ctx.createMediaStreamSource(stream);
	const chain = connectMusicChain(ctx, source);
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 2048;
	analyser.smoothingTimeConstant = 0.55;
	const dest = ctx.createMediaStreamDestination();
	centerMono(ctx, chain).connect(dest);
	const silent = ctx.createGain();
	silent.gain.value = 0;

	chain.connect(analyser);
	chain.connect(silent);
	silent.connect(playback.node);

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
	const startedAt = performance.now();

	const tick = () => {
		analyser.getByteTimeDomainData(timeData);
		let sum = 0;
		for (let i = 0; i < timeData.length; i++) {
			const v = (timeData[i] - 128) / 128;
			sum += v * v;
		}
		const rms = Math.sqrt(sum / timeData.length);
		onLevel(Math.min(1, rms * 3.2));
		raf = requestAnimationFrame(tick);
	};
	raf = requestAnimationFrame(tick);
	recorder.start(1000);

	let metroTimer: ReturnType<typeof setInterval> | null = null;
	if (metronome && metronome.bpm >= 40) {
		const beat = 60 / metronome.bpm;
		const startAt = ctx.currentTime + 0.05;
		let next = startAt;
		const schedule = () => {
			while (next < ctx.currentTime + 0.6) {
				const index = Math.round((next - startAt) / beat);
				scheduleClick(ctx, next, index % 4 === 0, playback.node);
				next += beat;
			}
		};
		schedule();
		metroTimer = setInterval(schedule, 200);
	}

	let stopped = false;
	return {
		stop: () =>
			new Promise<SongTake>((resolve, reject) => {
				if (stopped) return;
				stopped = true;
				const teardown = () => {
					cancelAnimationFrame(raf);
					if (metroTimer) clearInterval(metroTimer);
					playback.close();
					onLevel(0);
					for (const track of stream.getTracks()) track.stop();
					void ctx.close();
				};
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
				recorder.addEventListener('error', () => {
					teardown();
					reject(new Error('Optagelsen fejlede.'));
				}, { once: true });
				recorder.addEventListener('stop', finish, { once: true });
				if (recorder.state === 'inactive') finish();
				else recorder.stop();
			})
	};
}
