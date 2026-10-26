<script lang="ts">
	import { browser } from '$app/environment';
	import { PitchDetector } from 'pitchy';
	import { applyMicDevice } from '$lib/micChoice';
	import { BASS_STRINGS, GUITAR_STRINGS, hzToPitch, median, type DetectedPitch } from '$lib/tuner';

	interface Props {
		onClose: () => void;
	}

	const { onClose }: Props = $props();

	const TICKS = 40;
	const ARC_START = 210;
	const ARC_SWEEP = 300;
	const BUFFER_SIZE = 8192;
	const MIN_HZ = 36;
	const MAX_HZ = 750;
	const MIN_CLARITY = 0.9;

	let host: HTMLDivElement | undefined = $state();
	let closeBtn: HTMLButtonElement | undefined = $state();
	let pitch = $state<DetectedPitch | null>(null);
	let live = $state(false);
	let kind = $state<'guitar' | 'bass'>('guitar');
	let playingId = $state<string | null>(null);
	let needle = $state(20);
	let hit = $state(false);
	let wasInTune = false;
	let hitTimer: ReturnType<typeof setTimeout> | null = null;
	let playString: ((hz: number) => void) | null = null;
	let playTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (!browser || !host) return;
		document.body.appendChild(host);
		return () => {
			if (host?.parentNode === document.body) host.remove();
		};
	});

	$effect(() => {
		if (!browser) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		closeBtn?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		window.addEventListener('keydown', onKey, true);
		return () => {
			document.body.style.overflow = previous;
			window.removeEventListener('keydown', onKey, true);
		};
	});

	$effect(() => {
		if (!browser) return;
		let cancelled = false;
		let raf = 0;
		let ctx: AudioContext | null = null;
		let stream: MediaStream | null = null;
		let worklet: AudioWorkletNode | null = null;
		let filter: BiquadFilterNode | null = null;
		let tap: GainNode | null = null;
		const recent: number[] = [];
		let silent = 0;

		async function start() {
			ctx = new AudioContext();
			await ctx.resume();
			try {
				await ctx.audioWorklet.addModule('/tuner-worklet.js?v=3');
				worklet = new AudioWorkletNode(ctx, 'karplus-strong');
				filter = ctx.createBiquadFilter();
				filter.type = 'lowpass';
				filter.frequency.value = 6200;
				filter.Q.value = 0.5;
				const outGain = ctx.createGain();
				outGain.gain.value = 0.72;
				worklet.connect(filter);
				filter.connect(outGain);
				outGain.connect(ctx.destination);
				playString = (hz: number) => {
					worklet?.port.postMessage({ type: 'pluck', hz });
				};
			} catch {
				playString = null;
			}

			try {
				stream = await navigator.mediaDevices.getUserMedia({
					audio: applyMicDevice({
						echoCancellation: false,
						noiseSuppression: false,
						autoGainControl: false
					}),
					video: false
				});
			} catch {
				live = false;
				return;
			}
			if (cancelled || !ctx) return;
			const source = ctx.createMediaStreamSource(stream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = BUFFER_SIZE;
			analyser.smoothingTimeConstant = 0;
			const mix = ctx.createGain();
			source.connect(mix);
			if (filter) {
				tap = ctx.createGain();
				tap.gain.value = 0.42;
				filter.connect(tap);
				tap.connect(mix);
			}
			mix.connect(analyser);
			const samples = new Float32Array(BUFFER_SIZE);
			const detector = PitchDetector.forFloat32Array(BUFFER_SIZE);
			detector.clarityThreshold = 0.9;
			detector.minVolumeDecibels = -45;
			live = true;

			const tick = () => {
				if (cancelled || !ctx) return;
				analyser.getFloatTimeDomainData(samples);
				const [hz, clarity] = detector.findPitch(samples, ctx.sampleRate);
				if (hz >= MIN_HZ && hz <= MAX_HZ && clarity >= MIN_CLARITY) {
					recent.push(hz);
					if (recent.length > 5) recent.shift();
					silent = 0;
					pitch = hzToPitch(median(recent));
					needle = centsToTick(pitch.cents);
				} else {
					silent += 1;
					if (silent > 14) {
						recent.length = 0;
						pitch = null;
						needle = 20;
					}
				}
				raf = requestAnimationFrame(tick);
			};
			raf = requestAnimationFrame(tick);
		}

		void start();
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
			playString = null;
			worklet?.disconnect();
			filter?.disconnect();
			tap?.disconnect();
			stream?.getTracks().forEach((track) => track.stop());
			void ctx?.close();
		};
	});

	function centsToTick(cents: number) {
		const t = (Math.max(-50, Math.min(50, cents)) + 50) / 100;
		return Math.round(t * (TICKS - 1));
	}

	function tickAngle(i: number) {
		return ARC_START + (i * ARC_SWEEP) / (TICKS - 1);
	}

	function tickLit(i: number) {
		if (!pitch) return 0;
		const dist = Math.abs(i - needle);
		if (dist === 0) return 1;
		if (dist === 1) return 0.55;
		if (dist === 2) return 0.22;
		return 0;
	}

	function tickDelay(i: number) {
		return (i / (TICKS - 1)) * 0.32;
	}

	const strings = $derived(kind === 'bass' ? BASS_STRINGS : GUITAR_STRINGS);

	function pluck(id: string, hz: number) {
		playString?.(hz);
		playingId = id;
		if (playTimer) clearTimeout(playTimer);
		playTimer = setTimeout(() => {
			if (playingId === id) playingId = null;
		}, 1600);
	}

	const inTune = $derived(!!pitch && Math.abs(pitch.cents) < 4);
	const flatCents = $derived(pitch && pitch.cents < -0.6 ? Math.abs(pitch.cents) : null);
	const sharpCents = $derived(pitch && pitch.cents > 0.6 ? pitch.cents : null);

	$effect(() => {
		if (inTune && !wasInTune) {
			hit = false;
			requestAnimationFrame(() => {
				hit = true;
			});
			if (hitTimer) clearTimeout(hitTimer);
			hitTimer = setTimeout(() => {
				hit = false;
			}, 900);
		}
		wasInTune = inTune;
	});
</script>

<div class="tuner-host" bind:this={host}>
	<div class="tuner-backdrop" role="presentation">
		<button type="button" class="tuner-dismiss" aria-label="Luk" onclick={onClose}></button>
		<div class="tuner-frame" role="dialog" aria-modal="true" aria-labelledby="tuner-note">
			<button
				type="button"
				class="tuner-close"
				bind:this={closeBtn}
				onclick={onClose}
				aria-label="Luk"
				title="Luk"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
					<path d="M18 6 6 18"></path>
					<path d="m6 6 12 12"></path>
				</svg>
			</button>
			<div class="tuner" class:live class:in-tune={inTune} class:hit>
				<div class="tuner-io">
					<div class="tuner-col">
						<span class="tuner-label">♭</span>
						<span class="tuner-reading">
							<span class="tuner-value">{flatCents != null ? Math.round(flatCents) : '–'}</span>
							<span class="tuner-unit">cent</span>
						</span>
					</div>

					<div class="tuner-dial">
						<svg class="tuner-dial-ring" viewBox="0 0 100 100" aria-hidden="true">
							{#each Array.from({ length: TICKS }, (_, i) => i) as i (i)}
								<g transform="rotate({tickAngle(i)} 50 50)">
									<rect
										class="tuner-tick"
										class:is-needle={tickLit(i) > 0}
										x="49.1"
										y="4.6"
										width="1.8"
										height="9.3"
										style="animation-delay: {tickDelay(i)}s; opacity: {hit
											? undefined
											: pitch
												? Math.max(0.14, tickLit(i))
												: 0.14}"
									/>
								</g>
							{/each}
						</svg>
						<span class="tuner-soc" id="tuner-note">
							<span class="tuner-value tuner-value--soc">{pitch?.name ?? '–'}</span>
							{#if pitch}
								<span class="tuner-soc-frac">
									<span class="tuner-soc-tenth">{pitch.cents >= 0 ? '+' : ''}{pitch.cents.toFixed(1)}</span>
									<span class="tuner-unit tuner-unit--soc">cent</span>
								</span>
							{/if}
						</span>
					</div>

					<div class="tuner-col">
						<span class="tuner-label">♯</span>
						<span class="tuner-reading">
							<span class="tuner-value">{sharpCents != null ? Math.round(sharpCents) : '–'}</span>
							<span class="tuner-unit">cent</span>
						</span>
					</div>

					<div class="tuner-strings">
						<div class="tuner-ports" aria-label="Strenge">
							{#each strings as string (string.id)}
								<button
									type="button"
									class="tuner-port"
									class:on={playingId === string.id || pitch?.stringId === string.id}
									onclick={() => pluck(string.id, string.hz)}
								>
									{string.letter}
								</button>
							{/each}
						</div>
						<div class="tuner-kind">
							<button
								type="button"
								class="tuner-kind-btn"
								class:on={kind === 'guitar'}
								onclick={() => (kind = 'guitar')}
							>
								Guitar
							</button>
							<button
								type="button"
								class="tuner-kind-btn"
								class:on={kind === 'bass'}
								onclick={() => (kind = 'bass')}
							>
								Bas
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	.tuner-host {
		position: fixed;
		inset: 0;
		z-index: 70;
	}
	.tuner-backdrop {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: color-mix(in srgb, #05070b 62%, transparent);
	}
	.tuner-dismiss {
		position: absolute;
		inset: 0;
		border: 0;
		background: transparent;
		cursor: default;
	}
	.tuner-frame {
		position: relative;
		z-index: 1;
		width: min(880px, 100%);
		background: #141414;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 1.1rem;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
		color: #f2f2f2;
	}
	.tuner-close {
		position: absolute;
		top: 0.7rem;
		right: 0.7rem;
		z-index: 2;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: #9b9b9b;
		cursor: pointer;
	}
	.tuner-close svg {
		width: 1.1rem;
		height: 1.1rem;
	}
	.tuner-close:hover {
		color: #f2f2f2;
	}
	.tuner {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: min(68vh, 520px);
		padding: 1.6rem 1rem 1.4rem;
	}
	.tuner-io {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		grid-template-rows: auto auto;
		align-items: center;
		justify-items: center;
		width: 100%;
		max-width: 760px;
		column-gap: clamp(24px, 7vw, 72px);
		row-gap: 1.4rem;
	}
	.tuner-col:first-child {
		grid-column: 1;
		grid-row: 1;
	}
	.tuner-dial {
		grid-column: 2;
		grid-row: 1;
	}
	.tuner-col:nth-child(3) {
		grid-column: 3;
		grid-row: 1;
	}
	.tuner-strings {
		grid-column: 2;
		grid-row: 2;
		display: grid;
		justify-items: center;
		gap: 0.2rem;
	}
	.tuner-col {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
	}
	.tuner-label {
		color: #9b9b9b;
		font-size: 0.66rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
	}
	.tuner-reading {
		display: flex;
		align-items: baseline;
		gap: 6px;
	}
	.tuner-value {
		color: #f2f2f2;
		font-size: clamp(1.7rem, 5vw, 2.8rem);
		font-weight: 200;
		letter-spacing: 0.02em;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.tuner-unit {
		color: #9b9b9b;
		font-size: 0.72rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}
	.tuner-dial {
		position: relative;
		display: grid;
		place-items: center;
		width: min(40vh, 280px);
		height: min(40vh, 280px);
		aspect-ratio: 1;
		container-type: size;
	}
	.tuner-soc {
		position: relative;
		display: grid;
		place-items: center;
		z-index: 1;
	}
	.tuner-value--soc {
		font-size: 28cqmin;
	}
	.tuner-soc-frac {
		position: absolute;
		top: calc(100% + 0.22em);
		left: 50%;
		display: flex;
		align-items: baseline;
		gap: 2px;
		transform: translateX(-50%);
		white-space: nowrap;
		pointer-events: none;
	}
	.tuner-soc-tenth,
	.tuner-unit--soc {
		color: #9b9b9b;
		font-size: 0.62rem;
		font-weight: 300;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.tuner-dial-ring {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		opacity: 0.45;
		transition: opacity 0.4s ease;
	}
	.tuner.live .tuner-dial-ring {
		opacity: 1;
	}
	.tuner-tick {
		fill: rgba(255, 255, 255, 0.16);
	}
	.tuner-tick.is-needle {
		fill: #f2f2f2;
	}
	.tuner.in-tune .tuner-tick.is-needle {
		fill: var(--color-accent);
	}
	.tuner.hit .tuner-tick {
		fill: #f59e0b;
		animation: tuner-lock 0.9s ease-out both;
	}
	@keyframes tuner-lock {
		0% {
			fill: rgba(255, 255, 255, 0.16);
			opacity: 0.16;
		}
		14% {
			fill: #f59e0b;
			opacity: 1;
		}
		62% {
			fill: #ffb020;
			opacity: 1;
		}
		100% {
			fill: #f59e0b;
			opacity: 0.38;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.tuner.hit .tuner-tick {
			animation: none;
			opacity: 1;
		}
	}
	.tuner-ports {
		display: flex;
		gap: 4px;
	}
	.tuner-port {
		appearance: none;
		min-width: 2.1rem;
		margin: 0;
		padding: 0.35rem 0.45rem;
		border: 0;
		background: transparent;
		color: #555;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		font-size: 0.78rem;
		font-weight: 300;
		cursor: pointer;
		transition: color 0.25s ease;
	}
	.tuner-port.on,
	.tuner-port:hover {
		color: var(--color-accent);
	}
	.tuner-kind {
		display: flex;
		gap: 0.85rem;
	}
	.tuner-kind-btn {
		appearance: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: #555;
		font-size: 0.68rem;
		font-weight: 400;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
	}
	.tuner-kind-btn.on,
	.tuner-kind-btn:hover {
		color: #c8c8c8;
	}
	@media (max-width: 40rem) {
		.tuner {
			min-height: 0;
			padding: 2.2rem 0.6rem 1.1rem;
		}
		.tuner-io {
			column-gap: 0.7rem;
			row-gap: 1rem;
		}
		.tuner-dial {
			width: min(42vw, 22vh, 160px);
			height: min(42vw, 22vh, 160px);
		}
		.tuner-value:not(.tuner-value--soc) {
			font-size: 1.35rem;
		}
	}
</style>
