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
	import { songPlayBar } from '$lib/songPlayBar.svelte';
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

	const PLAY_OFFENDERS = [
		'.song-chrome',
		'.song-prints',
		'.info-block',
		'.section-insert',
		'.line-actions',
		'.section-drag-handle',
		'.section-header-actions'
	] as const;

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
		infoOpen = false;
		playing = true;
		playLastTs = 0;
		playPos = window.scrollY;
		playRaf = requestAnimationFrame(playFrame);
	}

	$effect(() => {
		if (!browser) return;
		void rows.length;
		void infoOpen;
		document.body.classList.toggle('song-is-playing', playing);
		const nodes = PLAY_OFFENDERS.flatMap((sel) => [...document.querySelectorAll(sel)]);
		for (const el of nodes) el.classList.toggle('play-hidden', playing);
		return () => {
			document.body.classList.remove('song-is-playing');
			for (const el of nodes) el.classList.remove('play-hidden');
		};
	});

	$effect(() => {
		if (!browser) return;
		songPlayBar.active = true;
		songPlayBar.playing = playing;
		songPlayBar.speedLabel = formatPlaySpeed(playSpeed);
		songPlayBar.start = startPlay;
		songPlayBar.slower = slowerPlay;
		songPlayBar.faster = fasterPlay;
		return () => {
			songPlayBar.active = false;
			songPlayBar.playing = false;
			songPlayBar.start = () => {};
			songPlayBar.slower = () => {};
			songPlayBar.faster = () => {};
		};
	});

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

<div class="song-page">
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

				{#if artist}
					<p class="artist-line">{artist}</p>
				{/if}
			</div>

			{#if canEdit || youtubeLinks.length > 0}
			<section class="info-block no-print" class:is-open={infoOpen}>
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
				<div class="info-fold" class:is-open={infoOpen}>
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
								<div class="info-field info-key">
									<span>Toneart</span>
									<div class="key-cluster" aria-label="Toneart, transponér">
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
									</div>
								</div>
								<div class="info-flags">
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
								</div>
								<div class="info-cats">
									{#each categories as cat (cat)}
										{@const c = colorForCategory(cat)}
										<button
											type="button"
											class="info-cat"
											style:--cat-color={c.text}
											onclick={() => goToSongbookCategory(cat)}
										>
											{cat}
										</button>
									{/each}
									<CategoryPicker
										options={pickerCategories.map((cat) => ({ value: cat, label: cat }))}
										selected={categories}
										triggerLabel="Tilføj kategori"
										ariaLabel="Tilføj eller fjern kategori"
										allowCreate
										colorFor={colorForCategory}
										onToggle={toggleCategory}
									/>
								</div>
								<button type="button" class="song-tool song-tool-danger" onclick={handleDelete}>Slet</button>
							{:else if key.trim() || categories.length > 0}
								{#if key.trim()}
									<div class="info-field info-key">
										<span>Toneart</span>
										<div class="key-cluster is-static" aria-label="Toneart">
											<span class="key-input">{key}</span>
										</div>
									</div>
								{/if}
								{#if categories.length > 0}
									<div class="info-cats">
										{#each categories as cat (cat)}
											{@const c = colorForCategory(cat)}
											<button
												type="button"
												class="info-cat"
												style:--cat-color={c.text}
												onclick={() => goToSongbookCategory(cat)}
											>
												{cat}
											</button>
										{/each}
									</div>
								{/if}
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
			</section>
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
	{/if}
</div>

<style>
	.song-page {
		--pad: clamp(14px, 5vw, 28px);
		--gap: clamp(6px, 2vw, 12px);
		--type: clamp(16px, 4.2vw, 18px);
		--type-sm: clamp(13px, 3.4vw, 15px);
		--type-xs: clamp(12px, 3vw, 13px);
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		min-height: 100dvh;
		width: 100%;
		max-width: 100%;
		margin-inline: 0;
		padding-top: calc(var(--pad) + env(safe-area-inset-top, 0px));
		padding-right: calc(var(--pad) + env(safe-area-inset-right, 0px));
		padding-bottom: calc(5.5rem + env(safe-area-inset-bottom, 0px));
		padding-left: calc(var(--pad) + env(safe-area-inset-left, 0px));
		background: #ffffff;
		color: var(--color-ink);
		overflow-x: clip;
		box-sizing: border-box;
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
	.artist-line {
		margin: 0.15rem 0 0;
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
	.info-block {
		margin-top: 0.45rem;
		padding-top: 0.15rem;
		border-top: 1px solid var(--color-border-subtle);
	}
	.info-toggle {
		appearance: none;
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		justify-content: start;
		gap: 0.4rem;
		width: 100%;
		border: none;
		background: transparent;
		padding: 0.7rem 0;
		font-size: var(--type-sm);
		font-weight: 600;
		color: var(--color-ink-muted);
		cursor: pointer;
		white-space: nowrap;
	}
	.info-toggle:hover,
	.info-toggle.is-open {
		color: var(--color-ink);
	}
	.info-chevron {
		width: 0.75rem;
		height: 0.75rem;
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
		gap: 0.95rem;
		margin: 0 0 0.95rem;
		padding: 0.95rem 1rem 1.05rem;
		background: #f8fafc;
		border: 1px solid var(--color-border-subtle);
		border-radius: 12px;
	}
	.info-flags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.85rem 1.15rem;
	}
	.print-toggle {
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		gap: 0.4rem;
		font-size: var(--type-sm);
		font-weight: 500;
		color: var(--color-ink-muted);
		cursor: pointer;
	}
	.info-key .key-cluster {
		justify-self: start;
	}
	.key-cluster {
		display: inline-grid;
		grid-template-columns: 2.75rem minmax(2.8rem, auto) 2.75rem;
		align-items: stretch;
		width: max-content;
		max-width: 100%;
		min-height: 2.75rem;
		color: var(--color-ink);
		border: 1px solid #cbd5e1;
		border-radius: var(--radius-button);
		background: #ffffff;
		overflow: hidden;
	}
	.key-cluster.is-static {
		grid-template-columns: minmax(2.8rem, auto);
		padding: 0 0.85rem;
		align-items: center;
	}
	.key-btn {
		min-width: 2.75rem;
		min-height: 2.75rem;
		padding: 0;
		font-size: 1.25rem;
		font-weight: 600;
		line-height: 1;
		color: var(--color-ink);
		background: #ffffff;
		border: none;
		cursor: pointer;
	}
	.key-btn:first-child {
		border-right: 1px solid #e2e8f0;
	}
	.key-btn:last-child {
		border-left: 1px solid #e2e8f0;
	}
	.key-input {
		width: 3rem;
		min-width: 0;
		text-align: center;
		font-weight: 600;
		font-family: var(--font-mono);
		font-size: 0.95rem;
		color: var(--color-ink);
		background: #ffffff;
		border: none;
		padding: 0;
	}
	.key-input:focus {
		outline: none;
		box-shadow: inset 0 -2px 0 var(--color-ink);
	}
	.info-cats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.55rem;
		align-items: center;
	}
	.info-cat {
		appearance: none;
		display: inline-flex;
		align-items: center;
		min-height: 2.4rem;
		padding: 0.4rem 0.9rem;
		border: 1px solid color-mix(in srgb, var(--cat-color, #64748b) 28%, #e2e8f0);
		border-radius: 999px;
		background: #ffffff;
		color: var(--cat-color, var(--color-ink-muted));
		font-size: var(--type-sm);
		font-weight: 600;
		cursor: pointer;
	}
	.info-cats :global(.category-picker) {
		min-width: min(12rem, 100%);
		min-height: 2.4rem;
	}
	.info-field {
		display: grid;
		grid-template-columns: 6rem minmax(0, 1fr);
		align-items: baseline;
		gap: 0.75rem;
	}
	.info-field.info-key {
		align-items: center;
	}
	.info-field > span {
		font-size: var(--type-sm);
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
		width: 100%;
		margin-inline: 0;
		padding-inline: 0;
	}
	:global(.play-hidden) {
		display: none !important;
	}

	@media (orientation: landscape) and (max-height: 34rem) {
		.song-page {
			--pad: clamp(10px, 2.4vw, 18px);
			--gap: clamp(4px, 1.2vw, 8px);
			--type: clamp(15px, 2.2vw, 17px);
			padding-top: calc(var(--pad) + env(safe-area-inset-top, 0px));
			padding-right: calc(var(--pad) + env(safe-area-inset-right, 0px));
			padding-bottom: calc(4.6rem + env(safe-area-inset-bottom, 0px));
			padding-left: calc(var(--pad) + env(safe-area-inset-left, 0px));
		}
		.title-input {
			font-size: clamp(1.15rem, 3.6vw, 1.45rem);
		}
		.song-prints {
			gap: 0.5rem;
		}
		.song-chrome {
			margin-bottom: 0;
		}
	}
</style>
