<script lang="ts">
	import {
		buildSections,
		findPreviousSameType,
		parseRows,
		sectionHasBodyContent,
		type Row
	} from '$lib/songParse';
	import type { CategoryMeta, SongDoc } from '$lib/types';
	import SongbookToc from './SongbookToc.svelte';
	import { buildSongbookTocPages, tocPageCountForSongs } from '$lib/songbookToc';

	interface Props {
		title: string;
		songs: SongDoc[];
		categoryMeta?: CategoryMeta;
		includeFrontMatter?: boolean;
	}

	const { title, songs, categoryMeta, includeFrontMatter = true }: Props = $props();

	type AudienceLine =
		| { kind: 'lyric'; text: string }
		| { kind: 'label'; text: string }
		| { kind: 'repeat'; text: string }
		| { kind: 'blank' };

	interface AudienceSong {
		id: string;
		title: string;
		artist?: string;
		lines: AudienceLine[];
		columns: 1 | 2;
	}

	interface AudiencePage extends AudienceSong {
		page: number;
	}

	const sourceSongs = $derived(songs.map(toAudienceSong).filter((song) => song.lines.length > 0));
	let measureRoot = $state<HTMLDivElement | undefined>();
	let planned = $state<AudiencePage[] | null>(null);

	const tocPages = $derived.by(() => {
		if (!planned || !includeFrontMatter) return [];
		const seen = new Set<string>();
		const tocSongs = [];
		for (const page of planned) {
			if (seen.has(page.id)) continue;
			seen.add(page.id);
			tocSongs.push({
				id: page.id,
				title: page.title,
				artist: page.artist,
				page: page.page
			});
		}
		return buildSongbookTocPages(tocSongs);
	});

	const showPageNumbers = $derived(includeFrontMatter || (planned?.length ?? 0) > 1);

	$effect(() => {
		const snapshot = sourceSongs;
		const front = includeFrontMatter;
		const root = measureRoot;
		if (!root) return;
		let cancelled = false;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (cancelled || !root.isConnected) return;
				planned = paginateSongs(root, snapshot, front);
			});
		});
		return () => {
			cancelled = true;
		};
	});

	function rowsFor(song: SongDoc): Row[] {
		return song.rows ?? parseRows(song.rawInput ?? '');
	}

	function toAudienceSong(song: SongDoc): AudienceSong {
		const rows = rowsFor(song);
		const sections = buildSections(rows);
		const collapsed = new Set(song.collapsedSections ?? []);
		const lines: AudienceLine[] = [];
		let hasRenderedChorus = false;

		if (sections.length === 0) {
			for (const row of rows) appendAudienceRow(lines, row);
		} else {
			for (const section of sections) {
				const isChorus = section.type === 'chorus';
				const hasLyrics = sectionHasBodyContent(rows, section);
				const collapsedHere = collapsed.has(section.headerIdx);
				const previousSame = findPreviousSameType(sections, section.headerIdx, rows);
				const repeatWithoutText =
					(isChorus && hasRenderedChorus) ||
					collapsedHere ||
					(!hasLyrics && previousSame !== null);

				if (repeatWithoutText) {
					appendBlank(lines);
					appendRepeat(lines, sectionLabel(section.headerText, isChorus));
					if (isChorus) hasRenderedChorus = true;
					continue;
				}

				appendBlank(lines);
				if (isChorus) {
					appendLabel(lines, sectionLabel(section.headerText, true));
					hasRenderedChorus = true;
				}
				for (let i = section.bodyStart; i < section.bodyEnd; i++) {
					appendAudienceRow(lines, rows[i]);
				}
			}
		}

		return {
			id: song.id,
			title: song.title,
			artist: song.artist,
			lines: trimAudienceLines(lines),
			columns: song.columnLayout ? 2 : 1
		};
	}

	function appendAudienceRow(lines: AudienceLine[], row: Row | undefined): void {
		if (!row) return;
		if (row.kind === 'chord') return;
		if (row.kind === 'header') {
			appendBlank(lines);
			return;
		}
		if (row.kind === 'lyric') {
			lines.push({ kind: 'lyric', text: row.text });
			return;
		}
		appendBlank(lines);
	}

	function appendBlank(lines: AudienceLine[]): void {
		if (lines.at(-1)?.kind !== 'blank') lines.push({ kind: 'blank' });
	}

	function appendLabel(lines: AudienceLine[], text: string): void {
		const lastNonBlank = [...lines].reverse().find((line) => line.kind !== 'blank');
		if (lastNonBlank?.kind === 'label' && lastNonBlank.text === text) return;
		lines.push({ kind: 'label', text });
	}

	function appendRepeat(lines: AudienceLine[], text: string): void {
		const lastNonBlank = [...lines].reverse().find((line) => line.kind !== 'blank');
		if (lastNonBlank?.kind === 'repeat' && lastNonBlank.text === text) return;
		lines.push({ kind: 'repeat', text });
	}

	function sectionLabel(headerText: string, chorus: boolean): string {
		const trimmed = headerText.trim();
		if (trimmed) return trimmed;
		return chorus ? 'Omkvæd' : 'Sektion';
	}

	function trimAudienceLines(lines: AudienceLine[]): AudienceLine[] {
		let start = 0;
		let end = lines.length;
		while (start < end && lines[start].kind === 'blank') start++;
		while (end > start && lines[end - 1].kind === 'blank') end--;
		return lines.slice(start, end);
	}

	function lineOverflows(line: Element, box: DOMRect): boolean {
		const rect = line.getBoundingClientRect();
		return rect.bottom > box.bottom + 1.5 || rect.right > box.right + 1.5;
	}

	function visibleFitCount(lineEls: HTMLElement[], box: DOMRect): number {
		let count = 0;
		for (const line of lineEls) {
			if (line.style.display === 'none') continue;
			if (count > 0 && lineOverflows(line, box)) break;
			count++;
		}
		return Math.max(1, count);
	}

	function paginateSong(section: HTMLElement, song: AudienceSong): AudienceLine[][] {
		const linesBox = section.querySelector<HTMLElement>('.audience-lines');
		if (!linesBox) return [song.lines];
		const lineEls = [...linesBox.querySelectorAll<HTMLElement>('[data-audience-line]')];
		if (lineEls.length === 0) return [song.lines];

		const chunks: AudienceLine[][] = [];
		let start = 0;
		while (start < lineEls.length) {
			for (let i = 0; i < lineEls.length; i++) {
				lineEls[i].style.display = i < start ? 'none' : '';
			}
			void linesBox.offsetHeight;
			const box = linesBox.getBoundingClientRect();
			const take = visibleFitCount(lineEls.slice(start), box);
			chunks.push(song.lines.slice(start, start + take));
			start += take;
		}
		return chunks;
	}

	function paginateSongs(
		root: HTMLElement,
		input: AudienceSong[],
		front: boolean
	): AudiencePage[] {
		void root.offsetHeight;
		let page = front ? 2 + tocPageCountForSongs(input.length) : 1;
		const pages: AudiencePage[] = [];
		for (const song of input) {
			const section = root.querySelector<HTMLElement>(`[data-song-id="${CSS.escape(song.id)}"]`);
			const chunks = section ? paginateSong(section, song) : [song.lines];
			for (const lines of chunks) {
				pages.push({ ...song, lines, page });
				page += 1;
			}
		}
		return pages;
	}
</script>

<article class="audience-book bg-white text-[#1f2933]" data-ready={planned !== null ? 'true' : 'false'}>
	{#if planned === null}
		<div class="audience-measure" bind:this={measureRoot}>
			{#each sourceSongs as song (song.id)}
				{@render songPage(song, song.lines, 0, false)}
			{/each}
		</div>
	{:else}
		{#if includeFrontMatter}
			<section class="audience-page audience-cover" data-fit-single-page="false">
				{#if categoryMeta?.imageUrl}
					<img class="audience-cover-image" src={categoryMeta.imageUrl} alt="" crossorigin="anonymous" />
				{/if}
				<div class="audience-cover-copy">
					<p class="audience-kicker">Publikums-sangbog</p>
					<h1>{title}</h1>
					<p class="audience-count">{sourceSongs.length} {sourceSongs.length === 1 ? 'sang' : 'sange'}</p>
					{#if categoryMeta?.introText?.trim()}
						<p class="audience-intro">{categoryMeta.introText.trim()}</p>
					{/if}
				</div>
			</section>
			<SongbookToc pages={tocPages} />
		{/if}

		{#each planned as page (page.id + '-' + page.page)}
			{@render songPage(page, page.lines, page.page, showPageNumbers)}
		{/each}
	{/if}
</article>

{#snippet songPage(song: AudienceSong, lines: AudienceLine[], page: number, numbered: boolean)}
	<section
		class="audience-page audience-song-page"
		data-fit-single-page="false"
		data-song-id={song.id}
	>
		<section class="audience-song">
			<header>
				<h2>{song.title}</h2>
				{#if song.artist}<p>{song.artist}</p>{/if}
			</header>
			<div class="audience-lines" class:audience-lines--two={song.columns === 2}>
				{#each lines as line, index}
					{#if line.kind === 'lyric'}
						<p data-audience-line={index}>{line.text}</p>
					{:else if line.kind === 'label'}
						<p class="audience-repeat-label" data-audience-line={index}>{line.text}</p>
					{:else if line.kind === 'repeat'}
						<div class="audience-repeat" data-audience-line={index}>
							<span>{line.text}</span>
							<svg
								class="audience-repeat-icon"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M17 1.5 21 5.5 17 9.5"></path>
								<path d="M3 11.5v-2a4 4 0 0 1 4-4h14"></path>
								<path d="M7 22.5 3 18.5 7 14.5"></path>
								<path d="M21 12.5v2a4 4 0 0 1-4 4H3"></path>
							</svg>
						</div>
					{:else}
						<div class="audience-blank" data-audience-line={index}></div>
					{/if}
				{/each}
			</div>
		</section>
		{#if numbered}
			<footer class="audience-page-number">{page}</footer>
		{/if}
	</section>
{/snippet}

<style>
	.audience-book {
		width: 210mm;
		font-family: var(--font-sans);
		--audience-rule: #d7b56d;
	}
	.audience-measure {
		position: absolute;
		left: 0;
		top: 0;
		width: 210mm;
	}
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
	}
	.audience-cover {
		display: grid;
		align-content: end;
		gap: 10mm;
		background: linear-gradient(180deg, #fffbf3 0%, #ffffff 55%);
	}
	.audience-cover-image {
		width: 100%;
		height: 120mm;
		object-fit: cover;
		border-radius: 12px;
		box-shadow: 0 18px 40px rgba(15, 23, 42, 0.18);
	}
	.audience-cover-copy {
		max-width: 140mm;
	}
	.audience-kicker {
		margin: 0 0 4mm;
		color: #9a6a12;
		font-size: 11pt;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.audience-cover h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 34pt;
		line-height: 0.95;
		color: #172033;
	}
	.audience-count {
		margin: 5mm 0 0;
		color: #6b7280;
		font-size: 12pt;
	}
	.audience-intro {
		margin: 9mm 0 0;
		font-size: 13pt;
		line-height: 1.55;
		color: #334155;
	}
	.audience-song-page {
		display: flex;
		flex-direction: column;
		padding-top: 20mm;
		padding-bottom: 17mm;
	}
	.audience-song {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}
	.audience-song header {
		flex: 0 0 auto;
		margin-bottom: 5mm;
		padding-bottom: 3mm;
		border-bottom: 1px solid #dcc48d;
	}
	.audience-song h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 16pt;
		line-height: 1.08;
		color: #172033;
	}
	.audience-song header p {
		margin: 1mm 0 0;
		color: #64748b;
		font-size: 9.5pt;
		font-style: italic;
	}
	.audience-lines {
		flex: 1 1 auto;
		height: 0;
		min-height: 0;
		columns: 1;
		column-fill: auto;
		column-gap: 11mm;
		font-family: Palatino, 'Palatino Linotype', 'Book Antiqua', Georgia, serif;
	}
	.audience-lines--two {
		columns: 2;
	}
	.audience-measure .audience-page,
	.audience-measure .audience-song,
	.audience-measure .audience-lines {
		overflow: visible;
	}
	.audience-lines p {
		margin: 0 0 1.2mm;
		font-size: 15.4pt;
		line-height: 1.24;
		color: #1f2937;
		white-space: pre-wrap;
		break-inside: avoid;
	}
	.audience-lines .audience-repeat-label {
		margin: 2.4mm 0 1.7mm;
		color: #9a6a12;
		font-family: var(--font-display);
		font-size: 13.2pt;
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.audience-repeat {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75em;
		width: max-content;
		min-width: 11em;
		max-width: 100%;
		margin: 2.4mm 0 1.7mm;
		padding: 0.45em 0.7em;
		border: 0.4pt solid #111827;
		border-radius: 4px;
		break-inside: avoid;
		color: #172033;
		font-family: var(--font-display);
		font-size: 11pt;
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.audience-repeat-icon {
		width: 1.15em;
		height: 1.15em;
		flex: 0 0 auto;
		opacity: 0.88;
	}
	.audience-blank {
		height: 3.2mm;
		break-inside: avoid;
	}
	.audience-page-number {
		position: absolute;
		right: 20mm;
		bottom: 8mm;
		color: #9ca3af;
		font-family: var(--font-display);
		font-size: 9pt;
	}
</style>
