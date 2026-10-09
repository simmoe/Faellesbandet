<script lang="ts">
	import { browser } from '$app/environment';

	interface Props {
		url?: string;
		songTitle?: string;
		canEdit?: boolean;
		uploading?: boolean;
		error?: string | null;
		onUpload: (file: File) => void;
		onRemove: () => void;
	}

	const {
		url = '',
		songTitle = '',
		canEdit = false,
		uploading = false,
		error = null,
		onUpload,
		onRemove
	}: Props = $props();

	let enlarged = $state(false);
	let modalHost: HTMLDivElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();

	const alt = $derived(songTitle ? `Akkordskema til ${songTitle}` : 'Akkordskema');
	const show = $derived(canEdit || !!url);

	$effect(() => {
		if (!browser || !modalHost) return;
		document.body.appendChild(modalHost);
		return () => {
			if (modalHost?.parentNode === document.body) modalHost.remove();
		};
	});

	$effect(() => {
		if (!enlarged || !browser) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') enlarged = false;
		};
		window.addEventListener('keydown', onKey);
		return () => {
			document.body.style.overflow = previous;
			window.removeEventListener('keydown', onKey);
		};
	});

	function handleFileChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) onUpload(file);
		input.value = '';
	}

	function pickFile() {
		fileInput?.click();
	}
</script>

{#if show}
	<div class={url ? 'chart-side' : 'info-field'}>
		{#if !url}
			<span>Akkordskema</span>
		{/if}
		<div class="chart-block">
			{#if url}
				<button
					type="button"
					class="chart-preview"
					onclick={() => (enlarged = true)}
					aria-label="Vis akkordskema større"
				>
					<img src={url} {alt} />
				</button>
			{/if}
			{#if canEdit}
				<div class="chart-actions">
					<input
						bind:this={fileInput}
						type="file"
						accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
						disabled={uploading}
						onchange={handleFileChange}
					/>
					<button type="button" class="chart-btn" disabled={uploading} onclick={pickFile}>
						{uploading ? 'Uploader…' : url ? 'Erstat' : 'Upload'}
					</button>
					{#if url}
						<button type="button" class="chart-btn is-danger" disabled={uploading} onclick={onRemove}>
							Fjern
						</button>
					{/if}
				</div>
			{/if}
			{#if error}
				<p class="chart-error">{error}</p>
			{/if}
		</div>
	</div>
{/if}

<div class="chart-modal-host" class:is-open={enlarged && !!url} bind:this={modalHost}>
	{#if enlarged && url}
		<div class="chart-modal-backdrop" role="presentation">
			<button
				type="button"
				class="chart-modal-dismiss"
				aria-label="Luk akkordskema"
				onclick={() => (enlarged = false)}
			></button>
			<div class="chart-modal card" role="dialog" aria-modal="true" aria-labelledby="chart-modal-title">
				<header class="chart-modal-header">
					<h2 id="chart-modal-title">Akkordskema</h2>
					<button type="button" class="btn-ghost" onclick={() => (enlarged = false)}>Luk</button>
				</header>
				<img class="chart-modal-img" src={url} {alt} />
			</div>
		</div>
	{/if}
</div>

<style>
	.chart-side {
		width: min(30vw, 100%);
		min-width: 0;
		margin-inline-start: auto;
		justify-self: end;
	}
	.chart-block {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--space-2, 0.75rem);
		min-width: 0;
		width: 100%;
	}
	.chart-preview {
		appearance: none;
		display: block;
		width: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: zoom-in;
	}
	.chart-preview img {
		display: block;
		width: 100%;
		height: auto;
		aspect-ratio: auto 640 / 370;
		object-fit: contain;
	}
	.chart-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-3, 1rem);
		align-items: center;
	}
	.chart-actions input[type='file'] {
		display: none;
	}
	.chart-btn {
		appearance: none;
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
	.chart-btn:hover:not(:disabled) {
		color: var(--color-ink);
	}
	.chart-btn.is-danger:hover:not(:disabled) {
		color: var(--color-error);
	}
	.chart-btn:disabled {
		cursor: wait;
	}
	.chart-error {
		margin: 0;
		font: inherit;
		color: var(--color-error);
	}
	.chart-modal-host {
		display: none;
	}
	.chart-modal-host.is-open {
		display: block;
		position: fixed;
		inset: 0;
		z-index: 10000;
		isolation: isolate;
		pointer-events: auto;
	}
	.chart-modal-backdrop {
		position: absolute;
		inset: 0;
		z-index: 1;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: rgba(15, 23, 42, 0.78);
		backdrop-filter: blur(4px);
	}
	.chart-modal-dismiss {
		position: absolute;
		inset: 0;
		border: 0;
		background: transparent;
	}
	.chart-modal {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		width: min(72rem, 100%);
		max-height: calc(100vh - 2rem);
		padding: 1.1rem 1.2rem 1.2rem;
	}
	.chart-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.85rem;
	}
	.chart-modal-header h2 {
		margin: 0;
		font-family: var(--font-title);
		font-size: 1.05rem;
		font-weight: 500;
		letter-spacing: -0.02em;
	}
	.chart-modal-img {
		display: block;
		width: 100%;
		height: auto;
		aspect-ratio: auto 640 / 370;
		max-height: calc(100vh - 7rem);
		object-fit: contain;
		background: #fff;
		border-radius: var(--radius-button, 0.6rem);
	}
</style>
