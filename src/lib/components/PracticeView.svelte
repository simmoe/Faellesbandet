<script lang="ts">
	import { browser } from '$app/environment';
	import { tick } from 'svelte';
	import EditableSong from './EditableSong.svelte';
	import { compactRepeatHeaderIdxs, type Row } from '$lib/songParse';
	import type { CollapsedSections } from '$lib/types';

	interface Props {
		title: string;
		artist?: string;
		keyLabel?: string;
		rows: Row[];
		barsPerLine: 2 | 4 | 8;
		collapsedSections?: CollapsedSections;
		onClose: () => void;
	}

	const {
		title,
		artist = '',
		keyLabel = '',
		rows,
		barsPerLine,
		collapsedSections = [],
		onClose
	}: Props = $props();
	const practiceCollapsed = $derived(compactRepeatHeaderIdxs(rows, collapsedSections));

	let host: HTMLDivElement | undefined = $state();
	let stageEl: HTMLElement | undefined = $state();
	let sheetEl: HTMLElement | undefined = $state();
	let closeBtn: HTMLButtonElement | undefined = $state();

	$effect(() => {
		if (!browser || !host) return;
		document.body.appendChild(host);
		return () => {
			if (host?.parentNode === document.body) host.remove();
		};
	});

	$effect(() => {
		if (!browser) return;
		const previousOverflow = document.body.style.overflow;
		document.documentElement.classList.add('practice-open');
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
			document.documentElement.classList.remove('practice-open');
			document.body.style.overflow = previousOverflow;
			window.removeEventListener('keydown', onKey, true);
		};
	});

	function linesClip(sheet: HTMLElement) {
		const nodes = sheet.querySelectorAll<HTMLElement>(
			'.is-chord .chord-cell-clickable, .lyric-cell, .lyrics-cell'
		);
		for (const el of nodes) {
			if (el.scrollWidth > el.clientWidth + 1) return true;
		}
		return false;
	}

	function applySheet(sheet: HTMLElement, cols: number, scale: number) {
		sheet.style.width = scale < 0.995 ? `${(100 / scale).toFixed(4)}%` : '100%';
		sheet.style.setProperty('--practice-columns', String(cols));
		sheet.style.setProperty('--practice-scale', String(scale));
		void sheet.offsetHeight;
	}

	function sheetFits(sheet: HTMLElement, width: number, height: number, scale: number) {
		if (sheet.scrollHeight * scale > height + 1) return false;
		if (sheet.scrollWidth * scale > width + 1) return false;
		if (linesClip(sheet)) return false;
		return true;
	}

	function scaleForColumns(sheet: HTMLElement, cols: number, width: number, height: number) {
		applySheet(sheet, cols, 1);
		if (sheetFits(sheet, width, height, 1)) return 1;
		let lo = 0.22;
		let hi = 1;
		let best = 0.22;
		for (let i = 0; i < 11; i++) {
			const mid = (lo + hi) / 2;
			applySheet(sheet, cols, mid);
			if (sheetFits(sheet, width, height, mid)) {
				best = mid;
				lo = mid;
			} else {
				hi = mid;
			}
		}
		return best;
	}

	async function fitSheet() {
		const stage = stageEl;
		const sheet = sheetEl;
		if (!stage || !sheet) return;
		const width = stage.clientWidth;
		const height = stage.clientHeight;
		if (width < 8 || height < 8) return;

		const compact = width < 720 || height < 520;
		const gap = compact ? 12 : 26;
		const minCol = compact ? 152 : 210;
		const maxCols = Math.min(8, Math.max(1, Math.floor((width + gap) / (minCol + gap))));

		sheet.style.setProperty('--practice-gap', compact ? '0.65em' : '1.6em');
		sheet.style.setProperty('--practice-scale', '1');
		sheet.style.width = '100%';
		sheet.style.setProperty('--practice-columns', '1');
		await tick();
		void sheet.offsetHeight;

		let bestCols = 1;
		let bestScale = scaleForColumns(sheet, 1, width, height);
		for (let cols = 2; cols <= maxCols; cols++) {
			const scale = scaleForColumns(sheet, cols, width, height);
			if (scale > bestScale + 0.008) {
				bestScale = scale;
				bestCols = cols;
			}
		}
		applySheet(sheet, bestCols, bestScale);
	}

	$effect(() => {
		void title;
		void rows;
		void practiceCollapsed;
		if (!browser || !stageEl || !sheetEl) return;
		void fitSheet();
		const observer = new ResizeObserver(() => void fitSheet());
		observer.observe(stageEl);
		const viewport = window.visualViewport;
		viewport?.addEventListener('resize', fitSheet);
		window.addEventListener('resize', fitSheet);
		return () => {
			observer.disconnect();
			viewport?.removeEventListener('resize', fitSheet);
			window.removeEventListener('resize', fitSheet);
		};
	});
</script>

<div class="practice-host" bind:this={host}>
	<div class="practice-frame" role="dialog" aria-modal="true" aria-labelledby="practice-title">
		<header class="practice-head">
			<div class="practice-heading">
				<h2 id="practice-title" class="song-title">{title || 'Uden titel'}</h2>
				{#if artist.trim() || keyLabel.trim()}
					<p class="practice-meta">
						{#if artist.trim()}{artist.trim()}{/if}
						{#if artist.trim() && keyLabel.trim()} · {/if}
						{#if keyLabel.trim()}{keyLabel.trim()}{/if}
					</p>
				{/if}
			</div>
			<button
				type="button"
				class="practice-close"
				bind:this={closeBtn}
				onclick={onClose}
				aria-label="Luk"
				title="Luk"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M18 6 6 18"></path>
					<path d="m6 6 12 12"></path>
				</svg>
			</button>
		</header>
		<div class="practice-stage" bind:this={stageEl}>
			<div class="practice-sheet practice-view no-bass-tabs" bind:this={sheetEl}>
				<EditableSong {rows} {barsPerLine} collapsedSections={practiceCollapsed} readOnly={true} />
			</div>
		</div>
	</div>
</div>

<style>
	.practice-host {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100dvh;
		max-height: 100dvh;
		z-index: 500;
	}
	.practice-frame {
		position: absolute;
		inset: 0;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		background: #ffffff;
		color: var(--color-ink);
	}
	.practice-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: start;
		gap: 0.75rem;
		padding-top: calc(0.45rem + env(safe-area-inset-top, 0px));
		padding-right: calc(0.55rem + env(safe-area-inset-right, 0px));
		padding-bottom: 0.3rem;
		padding-left: calc(0.55rem + env(safe-area-inset-left, 0px));
	}
	.practice-heading {
		min-width: 0;
	}
	.practice-head :global(.song-title) {
		margin: 0;
		font-size: clamp(1.05rem, 2.4vw, 1.45rem);
	}
	.practice-meta {
		margin: 0.1rem 0 0;
		font-size: 0.82rem;
		color: var(--color-ink-faint);
	}
	.practice-close {
		appearance: none;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-ink-muted);
		cursor: pointer;
	}
	.practice-close svg {
		width: 1.15rem;
		height: 1.15rem;
	}
	.practice-close:hover {
		color: var(--color-ink);
	}
	.practice-stage {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		padding-right: calc(0.55rem + env(safe-area-inset-right, 0px));
		padding-bottom: calc(0.45rem + env(safe-area-inset-bottom, 0px));
		padding-left: calc(0.55rem + env(safe-area-inset-left, 0px));
	}
	.practice-sheet {
		width: 100%;
		max-width: none;
		transform: scale(var(--practice-scale, 1));
		transform-origin: top left;
	}
	.practice-sheet :global(.song-section--collapsed) {
		width: max-content;
		min-width: 11em;
		max-width: 100%;
		border: 0.4pt solid #111827;
		border-radius: 4px;
		padding: 0.45em 0.7em;
		margin-top: 0.35em;
	}

	@media (orientation: landscape) and (max-height: 34rem) {
		.practice-head {
			gap: 0.4rem;
			padding-top: calc(0.2rem + env(safe-area-inset-top, 0px));
			padding-bottom: 0.08rem;
		}
		.practice-head :global(.song-title) {
			font-size: 1rem;
		}
		.practice-meta {
			display: none;
		}
		.practice-close {
			width: 1.7rem;
			height: 1.7rem;
		}
		.practice-stage {
			padding-bottom: calc(0.25rem + env(safe-area-inset-bottom, 0px));
		}
	}
</style>
