<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth.svelte';
	import { BUILD_TIME, BUILD_TIME_LABEL } from '$lib/buildInfo';
	import { songPlayBar } from '$lib/songPlayBar.svelte';

	let { children } = $props();

	onMount(() => authState.init());
</script>

<div class="min-h-dvh">
	<main>
		{@render children()}
	</main>
	{#if !songPlayBar.active}
		<footer
			class="deploy-stamp no-print"
			title={`Build: ${BUILD_TIME}`}
		>
			Deploy: {BUILD_TIME_LABEL}
		</footer>
	{/if}
</div>

{#if songPlayBar.active}
	<div id="song-play-bar" class="no-print">
		<div class="play-controls" class:is-playing={songPlayBar.playing}>
			<button
				type="button"
				class="play-side"
				onclick={() => songPlayBar.slower()}
				title={`Langsommere · nu ×${songPlayBar.speedLabel}`}
				aria-label="Langsommere"
			>
				−
			</button>
			<button
				type="button"
				class="play-main"
				onclick={() => songPlayBar.start()}
				title={songPlayBar.playing
					? `Stop (Esc) · tempo ×${songPlayBar.speedLabel}`
					: `Løbende scroll · tempo ×${songPlayBar.speedLabel}`}
			>
				{#if songPlayBar.playing}
					<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>
					Stop
				{:else}
					<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>
					Spil
				{/if}
			</button>
			<button
				type="button"
				class="play-side"
				onclick={() => songPlayBar.faster()}
				title={`Hurtigere · nu ×${songPlayBar.speedLabel}`}
				aria-label="Hurtigere"
			>
				+
			</button>
		</div>
	</div>
{/if}
