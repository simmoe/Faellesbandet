<script lang="ts">
	import type { SongRecording } from '$lib/types';

	interface Props {
		recordings: SongRecording[];
		onRemove: (id: string) => void;
		readOnly?: boolean;
	}

	const { recordings, onRemove, readOnly = false }: Props = $props();

	let playingId = $state<string | null>(null);

	function durationLabel(ms: number | undefined): string {
		if (!ms || ms < 1000) return '';
		const total = Math.round(ms / 1000);
		const m = Math.floor(total / 60);
		const s = total % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}
</script>

{#if recordings.length > 0}
	<div class="info-field">
		<span>Optagelser</span>
		<div class="rec-block">
			<ul class="rec-list">
				{#each recordings as take (take.id)}
					<li class="rec-row">
						<div class="rec-copy">
							<button
								type="button"
								class="rec-title"
								onclick={() => (playingId = playingId === take.id ? null : take.id)}
							>
								{take.title}
							</button>
							{#if durationLabel(take.durationMs)}
								<span class="rec-len">{durationLabel(take.durationMs)}</span>
							{/if}
						</div>
						{#if !readOnly}
							<button
								type="button"
								class="rec-remove"
								title="Fjern"
								aria-label="Fjern {take.title}"
								onclick={() => onRemove(take.id)}
							>
								×
							</button>
						{/if}
						{#if playingId === take.id}
							<audio class="rec-player" src={take.url} controls autoplay playsinline></audio>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}

<style>
	.rec-block {
		display: flex;
		flex-direction: column;
		gap: var(--space-2, 0.75rem);
		min-width: 0;
	}
	.rec-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2, 0.75rem);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.rec-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.35rem 0.75rem;
		min-width: 0;
	}
	.rec-copy {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.55rem;
		min-width: 0;
	}
	.rec-title {
		appearance: none;
		border: none;
		background: transparent;
		padding: 0;
		font: inherit;
		color: var(--color-ink);
		text-align: left;
		cursor: pointer;
	}
	.rec-title:hover {
		color: var(--color-ink-muted);
	}
	.rec-len {
		color: var(--color-ink-faint);
		font-size: var(--type-xs);
		font-variant-numeric: tabular-nums;
	}
	.rec-remove {
		appearance: none;
		border: none;
		background: transparent;
		padding: 0;
		font: inherit;
		line-height: 1;
		color: var(--color-ink-faint);
		cursor: pointer;
	}
	.rec-remove:hover {
		color: var(--color-ink);
	}
	.rec-player {
		grid-column: 1 / -1;
		width: 100%;
		height: 2.2rem;
	}
</style>
