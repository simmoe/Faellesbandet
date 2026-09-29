<script lang="ts">
	/**
	 * Self-contained "én sang som A4-side" markup. Bruges både af
	 * `/print` og af PDF-export-utilen (som mounter komponenten
	 * off-screen for at fange et html2canvas-snapshot).
	 *
	 * Fra v4 er `song.rows` autoritativ; falder tilbage til `parseRows`
	 * af `rawInput` hvis et legacy-dokument slipper igennem.
	 */
	import { renderBarLine, sectionHeaderType, transposeBassLine } from '$lib/chordFormatter';
	import { buildSections, parseRows, transposeRows, type Row } from '$lib/songParse';
	import type { BassLines, SongDoc } from '$lib/types';

	interface Props {
		song: SongDoc;
		/** Optional page number shown in the PDF footer (songbook exports). */
		pageNumber?: number;
	}
	const { song, pageNumber }: Props = $props();

	const semitones = $derived(song.transpose ?? 0);
	const baseRows = $derived(song.rows ?? parseRows(song.rawInput ?? ''));
	const rows = $derived(transposeRows(baseRows, semitones));
	const bassLines = $derived(transposeBassLines(song.bassLines, semitones));
	const collapsedSet = $derived(new Set(song.collapsedSections ?? []));
	const sections = $derived(buildPrintableSections(rows, collapsedSet));

	function transposeBassLines(bl: BassLines | undefined, n: number): BassLines {
		if (!bl) return {};
		const out: BassLines = {};
		for (const [k, v] of Object.entries(bl)) out[k] = transposeBassLine(v, n);
		return out;
	}

	type PrintableRow = { rowIdx: number; row: Row };
	type PrintableSection = {
		label: string;
		type: ReturnType<typeof sectionHeaderType>;
		compact: boolean;
		framed: boolean;
		chorusCue: string;
		rows: PrintableRow[];
	};

	function chorusCueLyric(text: string): string {
		const trimmed = text.trim().replace(/[.,;:!?…]+$/u, '').trim();
		return trimmed ? `${trimmed}...` : '';
	}

	function firstChorusCue(sectionRows: PrintableRow[]): string {
		const lyric = sectionRows.find(
			({ row }) => row.kind === 'lyric' && row.text.trim() !== ''
		);
		return lyric && lyric.row.kind === 'lyric' ? chorusCueLyric(lyric.row.text) : '';
	}

	function buildPrintableSections(rs: Row[], collapsed: Set<number>): PrintableSection[] {
		const built = buildSections(rs);
		if (built.length === 0) {
			return [
				{
					label: '',
					type: 'other',
					compact: false,
					framed: false,
					chorusCue: '',
					rows: rs.map((row, rowIdx) => ({ rowIdx, row }))
				}
			];
		}
		let seenFullChorus = false;
		return built.map((section) => {
			const sectionRows = rs
				.slice(section.bodyStart, section.bodyEnd)
				.map((row, offset) => ({ rowIdx: section.bodyStart + offset, row }));
			const hasContent = sectionRows.some(
				({ row }) => row.kind !== 'blank' && (row.kind === 'header' || row.text.trim() !== '')
			);
			const compact = collapsed.has(section.headerIdx) || !hasContent;
			let framed = false;
			let chorusCue = '';
			let rows = compact ? [] : sectionRows;
			if (!compact && section.type === 'chorus') {
				if (!seenFullChorus) {
					framed = true;
					seenFullChorus = true;
				} else {
					chorusCue = firstChorusCue(sectionRows);
					rows = [];
				}
			}
			return {
				label: section.headerText,
				type: section.type,
				compact: compact || (!framed && rows.length === 0 && !chorusCue),
				framed,
				chorusCue,
				rows
			};
		});
	}

	function bassHtmlFor(rowIdx: number): string {
		const line = bassLines[String(rowIdx)];
		return line?.trim() ? renderPrintableBarLine(line) : '';
	}

	function renderPrintableBarLine(line: string): string {
		return renderBarLine(line.replace(/[\u2013\u2014]/g, '-').replace(/\u00a0/g, ' '));
	}

	function isRepeatSection(section: PrintableSection): boolean {
		return Boolean(section.chorusCue) || (section.compact && !!section.label);
	}
</script>

{#snippet sectionHeading(text: string, repeat: boolean)}
	<div class="pdf-section-label">
		<span>{text}</span>
		{#if repeat}
			<svg
				class="pdf-repeat-icon"
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
		{/if}
	</div>
{/snippet}

<article
	class="print-page mb-8 rounded-md bg-white p-6 text-[var(--color-ink)]"
	class:column-layout={Boolean(song.columnLayout)}
	class:no-bass-tabs={Boolean(song.columnLayout) || song.showBassTabs === false}
>
	<header class="print-song-header">
		<h2 class="song-title">{song.title}</h2>
		{#if song.artist || song.key}
			<p class="print-song-meta">
				{#if song.artist}<span>{song.artist}</span>{/if}
				{#if song.artist && song.key}<span> · </span>{/if}
				{#if song.key}<span>{song.key}</span>{/if}
			</p>
		{/if}
	</header>
	<div class="pdf-song-sections">
		{#each sections as section}
			<section
				class="pdf-song-section pdf-song-section--{section.type}"
				class:pdf-song-section--unlabeled={!section.label}
				class:pdf-song-section--compact={section.compact}
				class:pdf-song-section--framed={section.framed}
				class:pdf-song-section--chorus-cue={Boolean(section.chorusCue)}
				class:pdf-song-section--repeat={isRepeatSection(section)}
			>
				{#if section.chorusCue}
					<div class="pdf-chorus-cue">
						{#if section.label}
							{@render sectionHeading(section.label, true)}
						{/if}
						<span class="pdf-chorus-cue-lyric">{section.chorusCue}</span>
					</div>
				{:else}
					{#if section.label}
						{@render sectionHeading(section.label, isRepeatSection(section))}
					{/if}
					{#if !section.compact}
						<div class="pdf-section-grid">
							{#each section.rows as item}
								{#if item.row.kind === 'blank'}
									<div class="pdf-line pdf-line--blank"></div>
									<div class="pdf-bass pdf-line--blank">{@html bassHtmlFor(item.rowIdx)}</div>
								{:else if item.row.kind === 'chord'}
									<div class="pdf-line pdf-chord">{@html renderPrintableBarLine(item.row.text)}</div>
									<div class="pdf-bass">{@html bassHtmlFor(item.rowIdx)}</div>
								{:else if item.row.kind === 'lyric'}
									<div class="pdf-line pdf-lyric">{item.row.text}</div>
									<div class="pdf-bass">{@html bassHtmlFor(item.rowIdx)}</div>
								{/if}
							{/each}
						</div>
					{/if}
				{/if}
			</section>
		{/each}
	</div>
	{#if pageNumber != null}
		<footer class="pdf-page-number">{pageNumber}</footer>
	{/if}
</article>

<style>
	.print-page {
		position: relative;
	}
	.pdf-page-number {
		position: absolute;
		right: 0;
		bottom: 0;
		color: #9ca3af;
		font-family: var(--font-display);
		font-size: 9pt;
	}
</style>
