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
	<img class="splash-mark" src="/logo-mark.png?v=10" alt="" />
	<p class="splash-name">{BAND.name}</p>
</main>

<style>
	.splash {
		display: grid;
		place-content: center;
		justify-items: center;
		min-height: 100dvh;
		padding: clamp(16px, 5vw, 40px);
		text-align: center;
		gap: 0.85rem;
	}
	.splash-mark {
		width: clamp(88px, 26vw, 128px);
		height: clamp(88px, 26vw, 128px);
		object-fit: contain;
		border-radius: 50%;
	}
	.splash-name {
		margin: 0;
		font-family: var(--font-display);
		font-size: 0.78rem;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-ink-faint);
	}
</style>
