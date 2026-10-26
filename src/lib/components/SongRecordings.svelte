<script lang="ts">
	import { browser } from '$app/environment';
	import type { SongRecording } from '$lib/types';

	interface Props {
		recordings: SongRecording[];
		onRemove: (id: string) => void;
		onOverdub?: (take: SongRecording, nudgeMs: number) => void;
		onRevert?: (id: string) => void;
		overdubId?: string | null;
		overdubPhase?: 'idle' | 'arming' | 'counting' | 'recording' | 'saving';
		overdubElapsed?: string;
		overdubLevel?: number;
		overdubError?: string | null;
		overdubHint?: string;
		readOnly?: boolean;
	}

	const {
		recordings,
		onRemove,
		onOverdub,
		onRevert,
		overdubId = null,
		overdubPhase = 'idle',
		overdubElapsed = '0:00',
		overdubLevel = 0,
		overdubError = null,
		overdubHint = '',
		readOnly = false
	}: Props = $props();

	let playingId = $state<string | null>(null);
	let nudgeMs = $state(0);
	let nudgeReady = false;

	$effect(() => {
		if (overdubId) playingId = null;
	});

	$effect(() => {
		if (!browser || nudgeReady) return;
		nudgeReady = true;
		const saved = localStorage.getItem('faellesbandet.overdub-clap-nudge');
		const parsed = saved == null ? NaN : Number(saved);
		if (Number.isFinite(parsed)) nudgeMs = Math.min(150, Math.max(-150, Math.round(parsed)));
	});

	$effect(() => {
		if (!browser || !nudgeReady) return;
		localStorage.setItem('faellesbandet.overdub-clap-nudge', String(nudgeMs));
	});

	function overdubLabel(id: string): string {
		if (overdubId !== id || overdubPhase === 'idle') return 'Overdub';
		if (overdubPhase === 'counting') return 'Klap';
		if (overdubPhase === 'recording') return overdubElapsed;
		if (overdubPhase === 'saving') return 'Gemmer';
		return 'Starter';
	}

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
			{#if overdubPhase === 'counting'}
				<p class="rec-hint">Klap på slag 4</p>
			{:else if overdubHint && overdubPhase === 'recording'}
				<p class="rec-hint">{overdubHint}</p>
			{/if}
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
							<div class="rec-actions">
								<label class="rec-nudge">
									<input
										type="range"
										min="-150"
										max="150"
										step="1"
										value={nudgeMs}
										disabled={overdubPhase !== 'idle'}
										aria-label="Millisekunder"
										title="Højere tal lægger andenstemmen senere."
										oninput={(event) => {
											nudgeMs = Number(event.currentTarget.value);
										}}
									/>
									<span>{nudgeMs} ms</span>
								</label>
								<button
									type="button"
									class="rec-action"
									class:is-live={overdubId === take.id && overdubPhase === 'recording'}
									disabled={(overdubPhase !== 'idle' && overdubId !== take.id) ||
										(overdubId === take.id &&
											(overdubPhase === 'arming' ||
												overdubPhase === 'counting' ||
												overdubPhase === 'saving'))}
									title="Læg en stemme ovenpå. Klap på det fjerde slag."
									onclick={() => onOverdub?.(take, nudgeMs)}
								>
									{#if overdubId === take.id && overdubPhase === 'recording'}
										<span class="rec-dot" style:transform={`scale(${0.8 + overdubLevel * 0.45})`}></span>
									{/if}
									{overdubLabel(take.id)}
								</button>
								{#if take.previous && overdubId !== take.id}
									<button
										type="button"
										class="rec-action"
										disabled={overdubPhase !== 'idle'}
										onclick={() => onRevert?.(take.id)}
									>
										Sidste take
									</button>
								{/if}
								<button
									type="button"
									class="rec-remove"
									title="Fjern"
									aria-label="Fjern {take.title}"
									disabled={overdubId === take.id}
									onclick={() => onRemove(take.id)}
								>
									×
								</button>
							</div>
						{/if}
						{#if overdubError && overdubId === take.id}
							<p class="rec-error">{overdubError}</p>
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
	.rec-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.rec-nudge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--color-ink-faint);
		font-size: var(--type-xs);
		font-variant-numeric: tabular-nums;
	}
	.rec-nudge input {
		width: 5.5rem;
		margin: 0;
		accent-color: var(--color-ink-muted, currentColor);
	}
	.rec-nudge input:disabled {
		opacity: 0.45;
	}
	.rec-action {
		appearance: none;
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		gap: 0.35rem;
		border: none;
		background: transparent;
		padding: 0;
		font-size: var(--type-label);
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-faint);
		cursor: pointer;
	}
	.rec-action:hover:not(:disabled) {
		color: var(--color-ink);
	}
	.rec-action:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.rec-hint {
		margin: 0;
		color: var(--color-ink-muted);
		font-size: var(--type-xs);
	}
	.rec-action.is-live {
		color: #b91c1c;
		letter-spacing: 0;
		text-transform: none;
		font-variant-numeric: tabular-nums;
	}
	.rec-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 999px;
		background: #dc2626;
	}
	.rec-error {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--color-error);
		font-size: var(--type-xs);
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
	.rec-remove:disabled {
		opacity: 0.35;
		cursor: default;
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
