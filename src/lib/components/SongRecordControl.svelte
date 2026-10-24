<script lang="ts">
	import { songRecordBar } from '$lib/songRecordBar.svelte';

	interface Props {
		compact?: boolean;
	}

	const { compact = false }: Props = $props();

	const label = $derived.by(() => {
		if (songRecordBar.phase === 'recording') return songRecordBar.elapsedLabel;
		if (songRecordBar.phase === 'busy') return 'Gemmer';
		return 'Optag';
	});
</script>

<div class="rec-wrap">
	<button
		type="button"
		class="rec-control"
		class:is-compact={compact}
		class:is-live={songRecordBar.phase === 'recording'}
		class:is-busy={songRecordBar.phase === 'busy'}
		disabled={songRecordBar.phase === 'busy'}
		onclick={() => songRecordBar.toggle()}
		title={songRecordBar.phase === 'recording' ? 'Stop og gem optagelsen' : 'Optag øvestykke'}
		aria-label={songRecordBar.phase === 'recording' ? 'Stop optagelse' : 'Start optagelse'}
	>
		<span class="rec-dot" style:transform={`scale(${0.72 + songRecordBar.level * 0.45})`}></span>
		<span class="rec-label">{label}</span>
	</button>
	{#if songRecordBar.error}
		<p class="rec-error">{songRecordBar.error}</p>
	{/if}
</div>

<style>
	.rec-wrap {
		position: relative;
	}
	.rec-control {
		appearance: none;
		position: relative;
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		min-width: 6.4rem;
		margin: 0;
		padding: 0.65rem 0.95rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-button);
		background: #ffffff;
		color: var(--color-ink);
		font-weight: 600;
		font-size: 0.9rem;
		box-shadow: 0 8px 22px rgba(15, 23, 42, 0.14);
		cursor: pointer;
	}
	.rec-control.is-compact {
		min-width: 0;
		padding: 0.45rem 0.8rem;
		box-shadow: none;
	}
	.rec-control:hover:not(:disabled) {
		background: #f3f4f6;
	}
	.rec-control.is-live {
		border-color: #b91c1c;
		background: #7f1d1d;
		color: #fff;
	}
	.rec-control.is-busy {
		opacity: 0.7;
		cursor: wait;
	}
	.rec-dot {
		width: 0.72rem;
		height: 0.72rem;
		border-radius: 999px;
		background: #dc2626;
		box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.16);
	}
	.rec-control.is-live .rec-dot {
		background: #fecaca;
		box-shadow: 0 0 0 4px rgba(254, 202, 202, 0.28);
	}
	.rec-label {
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
	}
	.rec-error {
		position: absolute;
		left: 50%;
		bottom: calc(100% + 0.4rem);
		width: max-content;
		max-width: 16rem;
		margin: 0;
		padding: 0.35rem 0.55rem;
		transform: translateX(-50%);
		border-radius: 6px;
		background: #111827;
		color: #fff;
		font-size: 0.75rem;
		font-weight: 500;
	}
</style>
