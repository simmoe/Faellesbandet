<script lang="ts">
	import { goto } from '$app/navigation';
	import { authState } from '$lib/auth.svelte';
	import { BAND } from '$lib/data/band';

	$effect(() => {
		if (authState.loading) return;
		goto('/songbook');
	});
</script>

<svelte:head><title>{BAND.name}</title></svelte:head>

<main class="splash">
	<p class="splash-title">{BAND.name}</p>
	<p class="splash-tag">{BAND.tagline}</p>
	<p class="splash-status">Indlæser…</p>
</main>

<style>
	.splash {
		display: grid;
		place-content: center;
		justify-items: center;
		min-height: 100dvh;
		padding: clamp(16px, 5vw, 40px);
		text-align: center;
		gap: clamp(8px, 2vw, 12px);
	}
	.splash-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(1.6rem, 7vw, 2rem);
		font-weight: 700;
		color: var(--color-accent);
	}
	.splash-tag,
	.splash-status {
		margin: 0;
		font-size: clamp(13px, 3.4vw, 15px);
		color: var(--color-ink-faint);
	}
</style>
