<script lang="ts">
	import type { SongbookTocPage } from '$lib/songbookToc';

	interface Props {
		pages: SongbookTocPage[];
	}

	const { pages }: Props = $props();
</script>

{#each pages as tocPage, index (tocPage.number)}
	<section class="audience-page audience-toc songbook-toc-page" data-fit-single-page="false">
		<h2>{index === 0 ? 'Indhold' : 'Indhold fortsat'}</h2>
		<ol>
			{#each tocPage.songs as song (song.id)}
				<li class:is-set={song.kind === 'set'}>
					<div>
						<span>{song.title}</span>
						{#if song.artist && song.kind !== 'set'}<small>{song.artist}</small>{/if}
					</div>
					<strong>{song.page}</strong>
				</li>
			{/each}
		</ol>
	</section>
{/each}

<style>
	.audience-page {
		box-sizing: border-box;
		width: 210mm;
		height: 297mm;
		padding: 18mm 20mm;
		background: #ffffff;
		page-break-after: always;
		break-after: page;
		position: relative;
		overflow: hidden;
		font-family: var(--font-sans);
	}
	.audience-toc {
		padding-top: 20mm;
	}
	.audience-toc h2 {
		margin: 0 0 13mm;
		font-family: var(--font-display);
		font-size: 25pt;
		color: #172033;
	}
	.audience-toc ol {
		margin: 0;
		padding: 0;
		columns: 2;
		column-gap: 12mm;
		list-style: none;
	}
	.audience-toc li {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 3mm;
		break-inside: avoid;
		margin: 0 0 4.2mm;
		padding-bottom: 2.6mm;
		border-bottom: 1px solid #eef1f5;
		font-size: 10.8pt;
		font-weight: 700;
		color: #1f2937;
	}
	.audience-toc strong {
		color: #9a6a12;
		font-family: var(--font-display);
		font-size: 10.5pt;
	}
	.audience-toc small {
		display: block;
		margin-top: 0.6mm;
		color: #6b7280;
		font-size: 8.3pt;
		font-weight: 400;
	}
	.audience-toc li.is-set span {
		color: #9a6a12;
		font-size: 9pt;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.audience-toc li.is-set strong {
		color: #9a6a12;
	}
</style>
