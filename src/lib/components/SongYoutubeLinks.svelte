<script lang="ts">
	import { browser } from '$app/environment';
	import type { YoutubeLink } from '$lib/types';
	import { youtubeEmbedUrl, youtubeWatchUrl } from '$lib/youtube';

	interface Props {
		links: YoutubeLink[];
		onAdd: (link: YoutubeLink) => void;
		onRemove: (id: string) => void;
		readOnly?: boolean;
	}

	const { links, onAdd, onRemove, readOnly = false }: Props = $props();

	let titleDraft = $state('');
	let urlDraft = $state('');
	let error = $state<string | null>(null);
	let playing = $state<YoutubeLink | null>(null);
	let modalHost: HTMLDivElement | undefined = $state();

	const embedSrc = $derived(playing ? youtubeEmbedUrl(playing.url) : null);

	$effect(() => {
		if (!browser || !modalHost) return;
		document.body.appendChild(modalHost);
		return () => {
			if (modalHost?.parentNode === document.body) modalHost.remove();
		};
	});

	$effect(() => {
		if (!playing || !browser) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') playing = null;
		};
		window.addEventListener('keydown', onKey);
		return () => {
			document.body.style.overflow = previous;
			window.removeEventListener('keydown', onKey);
		};
	});

	function addLink() {
		error = null;
		const title = titleDraft.trim();
		const url = youtubeWatchUrl(urlDraft.trim());
		if (!title) {
			error = 'Skriv en titel.';
			return;
		}
		if (!url) {
			error = 'Skriv et gyldigt YouTube-link.';
			return;
		}
		onAdd({
			id: crypto.randomUUID(),
			title,
			url
		});
		titleDraft = '';
		urlDraft = '';
	}

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		addLink();
	}
</script>

<div class="info-field">
	<span>Videoer</span>
	<div class="yt-block">
		{#if links.length > 0}
			<ul class="yt-list">
				{#each links as link (link.id)}
					<li class="yt-row">
						<button type="button" class="yt-title" onclick={() => (playing = link)}>
							{link.title}
						</button>
						{#if !readOnly}
							<button
								type="button"
								class="yt-remove"
								title="Fjern"
								aria-label="Fjern {link.title}"
								onclick={() => onRemove(link.id)}
							>
								×
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if !readOnly}
		<form class="yt-add" onsubmit={handleSubmit}>
			<input
				class="info-input"
				type="text"
				bind:value={titleDraft}
				placeholder="Titel"
			/>
			<input
				class="info-input"
				type="url"
				bind:value={urlDraft}
				placeholder="YouTube-link"
			/>
			<button type="submit" class="yt-add-btn">Tilføj</button>
		</form>
		{#if error}
			<p class="yt-error">{error}</p>
		{/if}
		{/if}
	</div>
</div>

<div
	class="yt-modal-host"
	class:is-open={!!playing}
	bind:this={modalHost}
>
	{#if playing && embedSrc}
		<div class="yt-modal-backdrop" role="presentation">
			<button type="button" class="yt-modal-dismiss" aria-label="Luk video" onclick={() => (playing = null)}
			></button>
			<div class="yt-modal card" role="dialog" aria-modal="true" aria-labelledby="yt-modal-title">
				<header class="yt-modal-header">
					<h2 id="yt-modal-title">{playing.title}</h2>
					<button type="button" class="btn-ghost" onclick={() => (playing = null)}>Luk</button>
				</header>
				<iframe
					src={embedSrc}
					title={playing.title}
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
					allowfullscreen
				></iframe>
			</div>
		</div>
	{/if}
</div>

<style>
	.yt-block {
		display: flex;
		flex-direction: column;
		gap: var(--space-2, 0.75rem);
		min-width: 0;
	}
	.yt-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-1, 0.4rem);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.yt-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-2, 0.75rem);
		min-width: 0;
	}
	.yt-title {
		appearance: none;
		border: none;
		background: transparent;
		padding: 0;
		font: inherit;
		color: var(--color-ink);
		text-align: left;
		cursor: pointer;
	}
	.yt-title:hover {
		color: var(--color-ink-muted);
	}
	.yt-remove {
		appearance: none;
		border: none;
		background: transparent;
		padding: 0;
		font: inherit;
		line-height: 1;
		color: var(--color-ink-faint);
		cursor: pointer;
	}
	.yt-remove:hover {
		color: var(--color-ink);
	}
	.yt-add-btn {
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
	.yt-add-btn:hover {
		color: var(--color-ink);
	}
	.yt-error {
		margin: 0;
		font: inherit;
		color: var(--color-error);
	}
	.yt-modal-host {
		display: none;
	}
	.yt-modal-host.is-open {
		display: block;
		position: fixed;
		inset: 0;
		z-index: 10000;
		isolation: isolate;
		pointer-events: auto;
	}
	.yt-modal-backdrop {
		position: absolute;
		inset: 0;
		z-index: 1;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: rgba(15, 23, 42, 0.78);
		backdrop-filter: blur(4px);
	}
	.yt-modal-dismiss {
		position: absolute;
		inset: 0;
		border: 0;
		background: transparent;
	}
	.yt-modal {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		width: min(52rem, 100%);
		padding: 1.1rem 1.2rem 1.2rem;
	}
	.yt-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.85rem;
	}
	.yt-modal-header h2 {
		margin: 0;
		font-family: var(--font-title);
		font-size: 1.05rem;
		font-weight: 500;
		letter-spacing: -0.02em;
	}
	iframe {
		width: 100%;
		aspect-ratio: 16 / 9;
		border: 0;
		border-radius: var(--radius-button);
		background: #000;
	}
</style>
