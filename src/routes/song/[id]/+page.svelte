<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { authState } from '$lib/auth.svelte';
	import { BAND } from '$lib/data/band';
	import {
		deleteSong,
		getSong,
		saveCategoryColors,
		subscribeCategoryColors,
		subscribeCategoryMeta,
		subscribeSongs,
		updateSong
	} from '$lib/firebase/songs';
	import {
		uniqueCategoriesFromSongs,
		transposeBassLine,
		normalizeAccidentals,
		decodeHtmlEntities
	} from '$lib/chordFormatter';
	import { parseRows, serializeRows, transposeRows, type Row } from '$lib/songParse';
	import EditableSong from '$lib/components/EditableSong.svelte';
	import CategoryPicker from '$lib/components/CategoryPicker.svelte';
	import SongYoutubeLinks from '$lib/components/SongYoutubeLinks.svelte';
	import { persistSongbookCategory } from '$lib/songbookSelection';
	import { exportAudienceSongbookAsPdf, exportSongsAsPdf } from '$lib/pdf';
	import {
		assignMissingCategoryColors,
		colorForCategory as paletteColorForCategory,
		hasSameCategoryColors
	} from '$lib/categoryColors';
	import { tick } from 'svelte';
	import { browser } from '$app/environment';
	import type {
		BassLines,
		CategoryColorMap,
		CategoryMetaMap,
		CollapsedSections,
		SongDoc,
		YoutubeLink
	} from '$lib/types';

	const canEdit = $derived(!!authState.user);

	let song = $state<SongDoc | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	let title = $state('');
	let artist = $state('');
	let key = $state('');
	let barsPerLine = $state<2 | 4 | 8>(4);
	let categories = $state<string[]>([]);
	let rows = $state<Row[]>([]);
	let bassLines = $state<BassLines>({});
	let collapsedSections = $state<CollapsedSections>([]);
	let categoryColorMap = $state<CategoryColorMap>({});
	let categoryMetaMap = $state<CategoryMetaMap>({});
	let showBassTabs = $state(true);
	let fitSinglePage = $state(true);
	let infoOpen = $state(false);
	let youtubeLinks = $state<YoutubeLink[]>([]);

	let allSongs = $state<SongDoc[]>([]);
	$effect(() => {
		if (authState.loading) return;
		const unsub = subscribeSongs((s) => (allSongs = s));
		return () => unsub();
	});
	const songCategories = $derived(uniqueCategoriesFromSongs(allSongs));
	const knownCategories = $derived.by(() => {
		const names = new Set([...songCategories, ...Object.keys(categoryMetaMap)]);
		return [...names].sort((a, b) => a.localeCompare(b, 'da'));
	});
	const effectiveCategoryColorMap = $derived(
		assignMissingCategoryColors(knownCategories, categoryColorMap)
	);

	const pickerCategories = $derived.by(() => {
		const names = new Set([...knownCategories, ...categories]);
		return [...names].sort((a, b) => a.localeCompare(b, 'da'));
	});

	function colorForCategory(cat: string) {
		return paletteColorForCategory(cat, effectiveCategoryColorMap);
	}

	$effect(() => {
		if (authState.loading) return;
		const unsub = subscribeCategoryColors((colors) => (categoryColorMap = colors));
		return () => unsub();
	});
	$effect(() => {
		if (authState.loading) return;
		const unsub = subscribeCategoryMeta((meta) => (categoryMetaMap = meta));
		return () => unsub();
	});

	$effect(() => {
		if (!authState.user || knownCategories.length === 0) return;
		if (!hasSameCategoryColors(effectiveCategoryColorMap, categoryColorMap)) {
			void saveCategoryColors(effectiveCategoryColorMap);
		}
	});

	$effect(() => {
		const id = $page.params.id;
		if (!id || authState.loading) return;
		loading = true;
		loadError = null;
		getSong(id)
			.then((s) => {
				if (!s) {
					loadError = 'Sangen findes ikke (måske slettet).';
					return;
				}
				song = s;
				title = decodeHtmlEntities(s.title);
				artist = decodeHtmlEntities(s.artist ?? '');
				key = decodeHtmlEntities(s.key ?? '');
				barsPerLine = s.barsPerLine;
				categories = [...(s.categories ?? [])];
				rows = [...(s.rows ?? parseRows(s.rawInput ?? ''))];
				bassLines = { ...(s.bassLines ?? {}) };
				collapsedSections = [...(s.collapsedSections ?? [])];
				showBassTabs = s.showBassTabs ?? true;
				fitSinglePage = s.fitSinglePage ?? true;
				youtubeLinks = [...(s.youtubeLinks ?? [])];
			})
			.catch((err) => (loadError = err instanceof Error ? err.message : 'Ukendt fejl'))
			.finally(() => (loading = false));
	});

	// ───── Auto-save (debounced) ─────────────────────────────────────────
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let saveStatus = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
	let saveError = $state<string | null>(null);
	const DEBOUNCE_MS = 800;

	function scheduleSave() {
		if (!song || !authState.user) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveStatus = 'idle';
		saveTimer = setTimeout(() => void doSave(), DEBOUNCE_MS);
	}

	async function flushPendingSave() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			await doSave();
		}
	}

	async function doSave() {
		if (!song || !authState.user) return;
		saveStatus = 'saving';
		saveError = null;
		try {
			// `rows` er kanonisk fra v4; `rawInput` holdes i sync som
			// læsbar fallback og søge-felt.
			const patch: Partial<Omit<SongDoc, 'id' | 'createdAt' | 'createdBy'>> = {
				title: title.trim() || 'Uden titel',
				...(artist.trim() ? { artist: artist.trim() } : {}),
				...(key.trim() ? { key: key.trim() } : {}),
				barsPerLine,
				categories,
				rows,
				rawInput: serializeRows(rows),
				bassLines,
				collapsedSections,
				showBassTabs,
				fitSinglePage,
				youtubeLinks,
				schemaVersion: 4
			};
			await updateSong(song.id, patch, authState.user.uid);
			song = { ...song, ...patch } as SongDoc;
			saveStatus = 'saved';
			setTimeout(() => {
				if (saveStatus === 'saved') saveStatus = 'idle';
			}, 1500);
		} catch (err) {
			saveStatus = 'error';
			saveError = err instanceof Error ? err.message : 'Ukendt fejl';
		}
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		const flushSync = () => {
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
				void doSave();
			}
		};
		window.addEventListener('beforeunload', flushSync);
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') flushSync();
		});
		return () => {
			window.removeEventListener('beforeunload', flushSync);
			void flushPendingSave();
		};
	});

	// ───── Field change handlers ─────────────────────────────────────────

	function onRowsChange(next: Row[]) {
		rows = next;
		scheduleSave();
	}

	function onBassLinesChange(next: BassLines) {
		bassLines = next;
		scheduleSave();
	}

	function onCollapsedSectionsChange(next: CollapsedSections) {
		collapsedSections = next;
		scheduleSave();
	}

	function addYoutubeLink(link: YoutubeLink) {
		youtubeLinks = [...youtubeLinks, link];
		scheduleSave();
	}

	function removeYoutubeLink(id: string) {
		youtubeLinks = youtubeLinks.filter((link) => link.id !== id);
		scheduleSave();
	}

	function addCategory(cat: string) {
		const trimmed = cat.trim();
		if (!trimmed) return;
		if (categories.some((c) => c.toLocaleLowerCase('da') === trimmed.toLocaleLowerCase('da'))) {
			return;
		}
		categories = [...categories, trimmed];
		scheduleSave();
	}

	function removeCategory(cat: string) {
		categories = categories.filter((c) => c !== cat);
		scheduleSave();
	}

	function toggleCategory(cat: string) {
		const trimmed = cat.trim();
		if (!trimmed) return;
		const existing = categories.find(
			(c) => c.toLocaleLowerCase('da') === trimmed.toLocaleLowerCase('da')
		);
		if (existing) removeCategory(existing);
		else addCategory(trimmed);
	}

	function goToSongbookCategory(cat: string) {
		if (browser) persistSongbookCategory(cat);
		void goto('/songbook');
	}

	// ───── Transponering ────────────────────────────────────────────────

	async function transpose(semitones: number) {
		rows = transposeRows(rows, semitones);
		const nextBass: BassLines = {};
		for (const [k, v] of Object.entries(bassLines)) nextBass[k] = transposeBassLine(v, semitones);
		bassLines = nextBass;
		if (key.trim()) key = transposeKeyLabel(key, semitones);
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		await doSave();
	}

	function transposeKeyLabel(k: string, semitones: number): string {
		const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
		const flatToSharp: Record<string, string> = {
			Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#'
		};
		const m = k.match(/^([A-G][#b]?)(.*)$/);
		if (!m) return k;
		const root = flatToSharp[m[1]] ?? m[1];
		const idx = SHARP.indexOf(root);
		if (idx === -1) return k;
		const next = (((idx + semitones) % 12) + 12) % 12;
		return normalizeAccidentals(SHARP[next] + m[2]);
	}

	async function handleDelete() {
		if (!song) return;
		const ok = confirm(`Slet "${song.title}"? Det kan ikke fortrydes.`);
		if (!ok) return;
		await deleteSong(song.id);
		goto('/songbook');
	}

	const liveSongForExport = $derived<SongDoc | null>(
		song
			? ({
					...song,
					title: title.trim() || song.title,
					artist: artist.trim() || song.artist,
					key: key.trim() || song.key,
					barsPerLine,
					categories,
					rows,
					rawInput: serializeRows(rows),
					bassLines,
					collapsedSections,
					showBassTabs,
					fitSinglePage
				} as SongDoc)
			: null
	);

	let pdfBusy = $state(false);
	let audiencePdfBusy = $state(false);

	async function handlePdf() {
		if (pdfBusy || !song) return;
		await flushPendingSave();
		pdfBusy = true;
		try {
			if (!liveSongForExport) return;
			await exportSongsAsPdf([liveSongForExport], {
				filename: title.trim() || song.title || 'Sang',
				withBassTabs: showBassTabs,
				fitSinglePage
			});
		} catch (err) {
			console.error('PDF-eksport fejlede:', err);
			alert('Kunne ikke generere PDF — se konsollen for detaljer.');
		} finally {
			pdfBusy = false;
		}
	}

	async function handleAudiencePdf() {
		if (audiencePdfBusy || !song) return;
		await flushPendingSave();
		audiencePdfBusy = true;
		try {
			if (!liveSongForExport) return;
			const exportTitle = title.trim() || song.title || 'Sang';
			await exportAudienceSongbookAsPdf([liveSongForExport], {
				title: exportTitle,
				filename: `${exportTitle} - tekst`
			});
		} catch (err) {
			console.error('Publikums-PDF fejlede:', err);
			alert('Kunne ikke generere publikums-PDF — se konsollen for detaljer.');
		} finally {
			audiencePdfBusy = false;
		}
	}

	// ───── Spil: ultrasmooth løbende scroll (ingen highlight/BPM) ─────────
	/** Ved ×1 scroller hele siden igennem på ca. denne tid (en typisk sang). */
	const PLAY_FULL_PAGE_SEC = 165;
	/** Hver − / + dividerer eller ganger tempoet med denne faktor. */
	const PLAY_SPEED_FACTOR = 1.25;

	let playing = $state(false);
	let playSpeed = $state(1);
	let playRaf: number | null = null;
	let playLastTs = 0;
	/** Fractional scroll-position — undgår at sub-pixel-deltaer forsvinder via scrollY. */
	let playPos = 0;

	function stopPlay(): void {
		playing = false;
		playLastTs = 0;
		if (playRaf != null) {
			cancelAnimationFrame(playRaf);
			playRaf = null;
		}
	}

	function slowerPlay(): void {
		playSpeed = playSpeed / PLAY_SPEED_FACTOR;
	}

	function fasterPlay(): void {
		playSpeed = playSpeed * PLAY_SPEED_FACTOR;
	}

	function formatPlaySpeed(s: number): string {
		return String(Number(s.toPrecision(3)));
	}

	function playFrame(ts: number): void {
		if (!playing) return;
		if (!playLastTs) playLastTs = ts;
		const dt = Math.min(0.05, (ts - playLastTs) / 1000);
		playLastTs = ts;

		const maxScroll = Math.max(
			0,
			document.documentElement.scrollHeight - window.innerHeight
		);
		if (maxScroll <= 0) {
			stopPlay();
			return;
		}
		const pxPerSec = (maxScroll / PLAY_FULL_PAGE_SEC) * playSpeed;
		playPos = Math.min(maxScroll, playPos + pxPerSec * dt);
		window.scrollTo(0, playPos);

		if (playPos >= maxScroll - 0.5) {
			stopPlay();
			return;
		}
		playRaf = requestAnimationFrame(playFrame);
	}

	async function startPlay(): Promise<void> {
		if (playing) {
			stopPlay();
			return;
		}
		if (collapsedSections.length > 0) {
			collapsedSections = [];
			scheduleSave();
			await tick();
			await new Promise<void>((r) => requestAnimationFrame(() => r()));
		}
		playing = true;
		playLastTs = 0;
		playPos = window.scrollY;
		playRaf = requestAnimationFrame(playFrame);
	}

	$effect(() => {
		if (!playing) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') stopPlay();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	$effect(() => {
		return () => stopPlay();
	});

	$effect(() => {
		const handler = () => {
			if (saveTimer) {
				clearTimeout(saveTimer);
				void doSave();
			}
		};
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	});
</script>

<svelte:head>
	<title>{title || song?.title || 'Sang'} · {BAND.name}</title>
</svelte:head>

<main class="song-page">
	{#if loading}
		<p class="song-status">Henter sang…</p>
	{:else if loadError}
		<a href="/songbook" class="back-link no-print">
			<span class="site-caret" aria-hidden="true"></span>
			Sangbogen
		</a>
		<p class="song-status is-error">{loadError}</p>
	{:else if song}
		<article class="song-sheet">
			<div class="song-chrome no-print">
				<a href="/songbook" class="back-link">
					<span class="site-caret" aria-hidden="true"></span>
					Sangbogen
				</a>
				<div class="song-chrome-status">
					{#if canEdit}
						{#if saveStatus === 'saving'}
							<span>Gemmer…</span>
						{:else if saveStatus === 'saved'}
							<span class="text-[var(--color-success)]">Gemt</span>
						{:else if saveStatus === 'error'}
							<span class="text-[var(--color-error)]" title={saveError ?? ''}>Fejl ved gem</span>
						{/if}
						{#if authState.profile}
							<span>{authState.profile.displayName}</span>
						{/if}
					{:else}
						<a href={`/login?next=${encodeURIComponent(`/song/${song.id}`)}`}>Log ind</a>
					{/if}
				</div>
			</div>

			<div class="song-head no-print-toolbar">
				{#if canEdit}
					<input
						class="title-input"
						type="text"
						bind:value={title}
						oninput={() => scheduleSave()}
						placeholder="Titel"
					/>
				{:else}
					<h1 class="title-input">{title || 'Uden titel'}</h1>
				{/if}

				<div class="song-prints">
					<button
						type="button"
						class="song-tool"
						onclick={handlePdf}
						disabled={pdfBusy}
						title="Generér akkord-PDF"
					>
						<svg
							class="print-icon"
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M7 8V3h10v5"></path>
							<path d="M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
							<path d="M7 13h10v8H7z"></path>
						</svg>
						<span>{pdfBusy ? '…' : 'Akkorder'}</span>
					</button>
					<button
						type="button"
						class="song-tool"
						onclick={handleAudiencePdf}
						disabled={audiencePdfBusy}
						title="Generér publikums-PDF"
					>
						<svg
							class="print-icon"
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M7 8V3h10v5"></path>
							<path d="M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
							<path d="M7 13h10v8H7z"></path>
						</svg>
						<span>{audiencePdfBusy ? '…' : 'Tekst'}</span>
					</button>
				</div>

				<div class="song-meta">
					{#if artist}
						<p class="artist-line">{artist}</p>
					{/if}
					{#if canEdit || youtubeLinks.length > 0}
						<button
							type="button"
							class="info-toggle"
							class:is-open={infoOpen}
							aria-expanded={infoOpen}
							onclick={() => (infoOpen = !infoOpen)}
						>
							Oplysninger
							<svg
								class="info-chevron"
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 12 12"
								fill="none"
								stroke="currentColor"
								stroke-width="1.4"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M2.25 4.25 6 8l3.75-3.75"></path>
							</svg>
						</button>
					{/if}
				</div>
			</div>

			{#if canEdit || youtubeLinks.length > 0}
			<div class="info-fold no-print" class:is-open={infoOpen}>
				<div class="info-inner">
					<div class="info-panel">
						{#if canEdit}
							<label class="info-field">
								<span>Kunstner</span>
								<input
									class="info-input"
									type="text"
									bind:value={artist}
									oninput={() => scheduleSave()}
									placeholder="Kunstner"
								/>
							</label>
							<div class="info-tools">
								<label class="print-toggle">
									<input
										type="checkbox"
										bind:checked={showBassTabs}
										onchange={() => scheduleSave()}
									/>
									Bass
								</label>
								<label class="print-toggle">
									<input
										type="checkbox"
										bind:checked={fitSinglePage}
										onchange={() => scheduleSave()}
									/>
									Én side
								</label>
								<span class="key-cluster" aria-label="Toneart, transponér">
									<button type="button" class="key-btn" title="Transponér ned" onclick={() => transpose(-1)}>−</button>
									<input
										class="key-input"
										type="text"
										bind:value={key}
										oninput={() => scheduleSave()}
										placeholder="—"
										spellcheck="false"
									/>
									<button type="button" class="key-btn" title="Transponér op" onclick={() => transpose(1)}>+</button>
								</span>
								<CategoryPicker
									options={pickerCategories.map((cat) => ({ value: cat, label: cat }))}
									selected={categories}
									triggerLabel="Kategori"
									ariaLabel="Tilføj eller fjern kategori"
									allowCreate
									colorFor={colorForCategory}
									onToggle={toggleCategory}
								/>
								<button type="button" class="song-tool song-tool-danger" onclick={handleDelete}>Slet</button>
							</div>
							{#if categories.length > 0}
								<div class="function-cats">
									{#each categories as cat (cat)}
										{@const c = colorForCategory(cat)}
										<button
											type="button"
											class="artist-cat"
											style:--cat-color={c.text}
											onclick={() => goToSongbookCategory(cat)}
										>
											<span class="cat-mark" aria-hidden="true"></span>
											{cat}
										</button>
									{/each}
								</div>
							{/if}
						{:else if key.trim() || categories.length > 0}
							<div class="info-tools">
								{#if key.trim()}
									<span class="key-cluster" aria-label="Toneart">
										<span class="key-input">{key}</span>
									</span>
								{/if}
								{#each categories as cat (cat)}
									{@const c = colorForCategory(cat)}
									<button
										type="button"
										class="artist-cat"
										style:--cat-color={c.text}
										onclick={() => goToSongbookCategory(cat)}
									>
										<span class="cat-mark" aria-hidden="true"></span>
										{cat}
									</button>
								{/each}
							</div>
						{/if}
						<SongYoutubeLinks
							links={youtubeLinks}
							onAdd={addYoutubeLink}
							onRemove={removeYoutubeLink}
							readOnly={!canEdit}
						/>
					</div>
				</div>
			</div>
			{/if}

			<div class="print-header" aria-hidden="true">
				<div>
					<span class="print-title">{title || 'Uden titel'}</span>
					{#if key.trim()}
						<span class="print-key">· {key.trim()}</span>
					{/if}
				</div>
				{#if artist.trim()}
					<div class="print-artist">{artist.trim()}</div>
				{/if}
			</div>

			<div class="song-area" class:no-bass-tabs={!showBassTabs}>
				<EditableSong
					{rows}
					{barsPerLine}
					{bassLines}
					{collapsedSections}
					{onRowsChange}
					{onBassLinesChange}
					{onCollapsedSectionsChange}
					readOnly={!canEdit}
				/>
			</div>
		</article>

		<div
			class="play-controls no-print"
			class:is-playing={playing}
			title="Løbende scroll gennem sangen"
		>
			<button
				type="button"
				class="play-side"
				onclick={slowerPlay}
				title={`Langsommere (÷${PLAY_SPEED_FACTOR}) · nu ×${formatPlaySpeed(playSpeed)}`}
				aria-label="Langsommere"
				>−</button
			>
			<button
				type="button"
				class="play-main"
				onclick={startPlay}
				title={playing
					? `Stop (Esc) · tempo ×${formatPlaySpeed(playSpeed)}`
					: `Løbende scroll · tempo ×${formatPlaySpeed(playSpeed)}`}
			>
				{#if playing}
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
				onclick={fasterPlay}
				title={`Hurtigere (×${PLAY_SPEED_FACTOR}) · nu ×${formatPlaySpeed(playSpeed)}`}
				aria-label="Hurtigere"
				>+</button
			>
		</div>
	{/if}
</main>

<style>
	.song-page {
		--pad: clamp(12px, 4vw, 24px);
		--gap: clamp(6px, 2vw, 12px);
		--type: clamp(16px, 4.2vw, 18px);
		--type-sm: clamp(13px, 3.4vw, 15px);
		--type-xs: clamp(12px, 3vw, 13px);
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		min-height: 100dvh;
		width: 100%;
		margin-inline: 0;
		padding: var(--pad);
		padding-bottom: calc(5.5rem + env(safe-area-inset-bottom, 0px));
		background: #ffffff;
		color: var(--color-ink);
	}
	.song-sheet {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--gap);
		min-width: 0;
	}
	.song-status {
		margin: 2rem 0;
		text-align: center;
		color: var(--color-ink-muted);
	}
	.song-status.is-error {
		color: var(--color-error);
	}
	.song-chrome {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--gap);
	}
	.back-link {
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		gap: 0.28rem;
		font-size: var(--type-xs);
		font-weight: 500;
		color: var(--color-ink-faint);
		text-decoration: none;
	}
	.back-link:hover {
		color: var(--color-ink);
	}
	.song-chrome-status {
		display: grid;
		grid-auto-flow: column;
		align-items: center;
		gap: 0.65rem;
		font-size: var(--type-xs);
		color: var(--color-ink-faint);
	}
	.song-chrome-status a {
		color: inherit;
	}
	.song-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.2rem;
		min-width: 0;
	}
	.song-prints {
		display: grid;
		grid-auto-flow: column;
		justify-content: start;
		gap: 0.75rem;
		min-width: 0;
	}
	.song-meta {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--gap);
		min-width: 0;
	}
	.artist-line {
		margin: 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--type-sm);
		color: var(--color-ink-faint);
	}
	.song-tool {
		appearance: none;
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		gap: 0.32rem;
		border: none;
		background: transparent;
		padding: 0.15rem 0;
		font-size: var(--type-xs);
		font-weight: 500;
		color: var(--color-ink-muted);
		cursor: pointer;
		white-space: nowrap;
	}
	.print-icon {
		width: 0.82rem;
		height: 0.82rem;
	}
	.song-tool:hover:not(:disabled) {
		color: var(--color-ink);
	}
	.song-tool:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.song-tool-danger {
		color: var(--color-error);
	}
	.play-controls {
		position: fixed;
		bottom: calc(0.85rem + env(safe-area-inset-bottom, 0px));
		left: 50%;
		transform: translateX(-50%);
		z-index: 80;
		display: grid;
		grid-template-columns: auto minmax(5.2rem, auto) auto;
		align-items: stretch;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-button);
		overflow: hidden;
		background: #ffffff;
		box-shadow: 0 8px 22px rgba(15, 23, 42, 0.14);
	}
	.play-controls.is-playing {
		border-color: var(--color-accent);
	}
	.play-controls .play-side,
	.play-controls .play-main {
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		margin: 0;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--color-ink);
		font-weight: 600;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.play-controls .play-side {
		min-width: 2.6rem;
		padding: 0.65rem 0.7rem;
		font-size: 1.15rem;
		line-height: 1;
		color: var(--color-ink-muted);
	}
	.play-controls .play-side:first-child {
		border-right: 1px solid var(--color-border-subtle);
	}
	.play-controls .play-side:last-child {
		border-left: 1px solid var(--color-border-subtle);
	}
	.play-controls .play-main {
		padding: 0.65rem 1rem;
	}
	.play-controls .play-side:hover,
	.play-controls .play-main:hover {
		background: #f3f4f6;
	}
	.play-controls.is-playing .play-main {
		background: var(--color-accent);
		color: #ffffff;
	}
	.title-input {
		width: 100%;
		min-width: 0;
		background: transparent;
		border: none;
		font-family: var(--font-title);
		font-size: clamp(1.35rem, 6vw, 1.7rem);
		line-height: 1.12;
		font-weight: 400;
		color: var(--color-ink);
		padding: 0;
		margin: 0;
	}
	.title-input:focus {
		outline: none;
		box-shadow: inset 0 -1px 0 var(--color-ink);
	}
	.function-cats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}
	.cat-mark {
		width: 0.2rem;
		height: 0.2rem;
		border-radius: 50%;
		background: currentColor;
		flex-shrink: 0;
	}
	.artist-cat {
		appearance: none;
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		gap: 0.28rem;
		border: none;
		background: transparent;
		padding: 0;
		font-size: var(--type-xs);
		color: var(--cat-color, var(--color-ink-muted));
		cursor: pointer;
	}
	.info-tools {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, max-content));
		align-items: center;
		gap: 0.55rem 0.75rem;
	}
	.print-toggle {
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		gap: 0.28rem;
		font-size: var(--type-xs);
		font-weight: 500;
		color: var(--color-ink-muted);
		cursor: pointer;
	}
	.key-cluster {
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		gap: 0.05rem;
		padding: 0 0.35rem 0 0.2rem;
		color: var(--color-ink-muted);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-button);
		min-height: 2.2rem;
	}
	.key-btn {
		padding: 0 0.2rem;
		font-size: 0.85rem;
		color: var(--color-ink-faint);
		background: transparent;
		border: none;
		cursor: pointer;
	}
	.key-input {
		width: 2.4rem;
		text-align: center;
		font-weight: 500;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		color: var(--color-ink-muted);
		background: transparent;
		border: none;
		padding: 0;
	}
	.key-input:focus {
		outline: none;
		color: var(--color-ink);
		box-shadow: inset 0 -1px 0 var(--color-ink);
	}
	.info-toggle {
		appearance: none;
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		gap: 0.35rem;
		border: none;
		background: transparent;
		padding: 0;
		font-size: var(--type-xs);
		font-weight: 500;
		color: var(--color-ink-faint);
		cursor: pointer;
		white-space: nowrap;
	}
	.info-toggle:hover,
	.info-toggle.is-open {
		color: var(--color-ink);
	}
	.info-chevron {
		width: 0.7rem;
		height: 0.7rem;
		transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.info-toggle.is-open .info-chevron {
		transform: rotate(180deg);
	}
	.info-fold {
		display: grid;
		grid-template-rows: 0fr;
		transition: grid-template-rows 280ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.info-fold.is-open {
		grid-template-rows: 1fr;
	}
	.info-inner {
		overflow: hidden;
		min-height: 0;
	}
	.info-panel {
		display: grid;
		gap: 0.65rem;
		padding: 0.55rem 0 0.35rem;
		border-top: 1px solid var(--color-border-subtle);
	}
	.info-field {
		display: grid;
		grid-template-columns: 6rem minmax(0, 1fr);
		align-items: baseline;
		gap: 0.75rem;
	}
	.info-field > span {
		font-size: var(--type-xs);
		font-weight: 500;
		color: var(--color-ink-faint);
	}
	.info-input {
		width: 100%;
		min-width: 0;
		background: transparent;
		border: none;
		padding: 0.1rem 0;
		font-family: var(--font-title);
		font-size: 0.95rem;
		color: var(--color-ink);
	}
	.info-input:focus {
		outline: none;
		box-shadow: inset 0 -1px 0 var(--color-ink);
	}
	.print-header {
		display: none;
	}
	.song-area {
		min-width: 0;
		margin-inline: calc(var(--pad) * -1);
		padding-inline: var(--pad);
	}
</style>
