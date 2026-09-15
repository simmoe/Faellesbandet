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
	import { exportAudienceSongbookAsPdf, exportSongsAsPdf } from '$lib/pdf';
	import {
		assignMissingCategoryColors,
		colorForCategory as paletteColorForCategory,
		hasSameCategoryColors
	} from '$lib/categoryColors';
	import { tick } from 'svelte';
	import type {
		BassLines,
		CategoryColorMap,
		CategoryMetaMap,
		CollapsedSections,
		SongDoc
	} from '$lib/types';

	$effect(() => {
		if (!authState.loading && !authState.user) goto('/login');
	});

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
	let categoryDraft = $state('');

	let allSongs = $state<SongDoc[]>([]);
	$effect(() => {
		if (!authState.user) return;
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

	function colorForCategory(cat: string) {
		return paletteColorForCategory(cat, effectiveCategoryColorMap);
	}

	$effect(() => {
		if (!authState.user) return;
		const unsub = subscribeCategoryColors((colors) => (categoryColorMap = colors));
		return () => unsub();
	});
	$effect(() => {
		if (!authState.user) return;
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
		if (!id || !authState.user) return;
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

	function addCategory(cat: string) {
		const trimmed = cat.trim();
		if (!trimmed) return;
		if (categories.some((c) => c.toLocaleLowerCase('da') === trimmed.toLocaleLowerCase('da'))) {
			categoryDraft = '';
			return;
		}
		categories = [...categories, trimmed];
		categoryDraft = '';
		scheduleSave();
	}

	function onCategoryInput(value: string) {
		categoryDraft = value;
		const trimmed = value.trim();
		if (!trimmed) return;
		const existing = knownCategories.find(
			(cat) => cat.toLocaleLowerCase('da') === trimmed.toLocaleLowerCase('da')
		);
		if (existing) addCategory(existing);
	}

	function removeCategory(cat: string) {
		categories = categories.filter((c) => c !== cat);
		scheduleSave();
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

<main class="mx-auto max-w-5xl px-6 py-5">
	{#if loading}
		<div class="card p-8 text-center text-[var(--color-ink-muted)]">Henter sang…</div>
	{:else if loadError}
		<a href="/songbook" class="back-link no-print mb-3 inline-flex items-center">
			<span class="site-caret" aria-hidden="true"></span>
			Sangbogen
		</a>
		<div class="card p-6">
			<p class="text-[var(--color-error)] font-semibold">Fejl</p>
			<p class="mt-1 text-sm text-[var(--color-ink-muted)]">{loadError}</p>
		</div>
	{:else if song}
		<article class="card song-card">
			<div class="song-chrome no-print">
				<a href="/songbook" class="back-link">
					<span class="site-caret" aria-hidden="true"></span>
					Sangbogen
				</a>
				<div class="song-chrome-status">
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
				</div>
			</div>

			<div class="song-head no-print-toolbar">
				<div class="title-line">
					<input
						class="title-input"
						type="text"
						bind:value={title}
						oninput={() => scheduleSave()}
						placeholder="Titel"
						style="width: {Math.max(6, (title || 'Titel').length + 1)}ch"
					/>
				</div>
				<div class="song-actions">
					<label class="print-toggle" title="Vis bass-tabs på siden og tag dem med ved print">
						<input type="checkbox" bind:checked={showBassTabs} onchange={() => scheduleSave()} />
						Bass
					</label>
					<label
						class="print-toggle"
						title="Skalér sangen proportionalt så den fylder maks én A4-side"
					>
						<input type="checkbox" bind:checked={fitSinglePage} onchange={() => scheduleSave()} />
						Én side
					</label>
					<button
						type="button"
						class="song-tool"
						onclick={handlePdf}
						disabled={pdfBusy}
						title="Generér akkord-PDF og hent direkte"
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
						{pdfBusy ? 'Genererer…' : 'Akkorder'}
					</button>
					<button
						type="button"
						class="song-tool"
						onclick={handleAudiencePdf}
						disabled={audiencePdfBusy}
						title="Generér publikums-PDF uden akkorder"
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
						{audiencePdfBusy ? 'Genererer…' : 'Tekst'}
					</button>
					<button
						type="button"
						class="song-tool song-tool-danger"
						onclick={handleDelete}
						title="Slet sang">Slet</button
					>
				</div>

				<div class="song-sub">
					<input
						class="artist-input"
						type="text"
						bind:value={artist}
						oninput={() => scheduleSave()}
						placeholder="Kunstner"
						style="width: {Math.max(8, (artist || 'Kunstner').length + 1)}ch"
					/>
					{#if categories.length > 0}
						<div class="artist-cats">
							{#each categories as cat (cat)}
								{@const c = colorForCategory(cat)}
								<button
									type="button"
									class="artist-cat"
									style:--cat-color={c.text}
									title="Fjern {cat}"
									onclick={() => removeCategory(cat)}
								>
									<span class="cat-mark" aria-hidden="true"></span>
									{cat}
								</button>
							{/each}
						</div>
					{/if}
				</div>
				<div class="song-functions">
					<span class="key-cluster" aria-label="Toneart, transponér">
						<button
							type="button"
							class="key-btn"
							title="Transponér ned"
							onclick={() => transpose(-1)}>−</button
						>
						<input
							class="key-input"
							type="text"
							bind:value={key}
							oninput={() => scheduleSave()}
							placeholder="—"
							spellcheck="false"
						/>
						<button
							type="button"
							class="key-btn"
							title="Transponér op"
							onclick={() => transpose(1)}>+</button
						>
					</span>
					<input
						class="cat-pick"
						type="text"
						list="song-known-categories"
						bind:value={categoryDraft}
						oninput={(e) => onCategoryInput(e.currentTarget.value)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ',') {
								e.preventDefault();
								addCategory(categoryDraft);
							}
						}}
						onblur={() => addCategory(categoryDraft)}
						placeholder="Kategori"
						aria-label="Tilføj kategori"
					/>
				</div>
				<button
					type="button"
					class="info-toggle no-print"
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
				<datalist id="song-known-categories">
					{#each knownCategories as c (c)}<option value={c}></option>{/each}
				</datalist>
			</div>
			<div class="info-fold no-print" class:is-open={infoOpen}>
				<div class="info-inner">
					<div class="info-panel">
						<label class="info-field">
							<span>Titel</span>
							<input
								class="info-input"
								type="text"
								bind:value={title}
								oninput={() => scheduleSave()}
								placeholder="Titel"
							/>
						</label>
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
					</div>
				</div>
			</div>

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
				/>
			</div>

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
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
							><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg
						>
						Stop
					{:else}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
							><path d="M8 5v14l11-7z"></path></svg
						>
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
		</article>
	{/if}
</main>

<style>
	.song-card {
		container-type: inline-size;
		padding: 0.85rem 1.25rem 1.15rem;
	}
	.song-chrome {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.6rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-ink-faint);
	}
	.back-link:hover {
		color: var(--color-ink);
	}
	.song-chrome-status {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.68rem;
		letter-spacing: 0.04em;
		color: var(--color-ink-faint);
	}
	.song-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto auto auto;
		align-items: baseline;
		column-gap: 1.25rem;
		row-gap: 0.2rem;
		margin-bottom: 0.55rem;
	}
	.title-line {
		grid-column: 1;
		grid-row: 1;
	}
	.song-actions {
		grid-column: 2;
		grid-row: 1;
		align-self: baseline;
	}
	.song-sub {
		grid-column: 1 / -1;
		grid-row: 2;
		align-self: baseline;
	}
	.song-functions {
		grid-column: 1;
		grid-row: 3;
		justify-self: start;
		align-self: center;
		margin-top: 0.15rem;
	}
	.song-head datalist {
		display: none;
	}
	@container (max-width: 42rem) {
		.song-head {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto;
		}
		.title-line,
		.song-actions,
		.song-sub,
		.song-functions,
		.info-toggle {
			grid-column: 1;
			grid-row: auto;
		}
		.song-actions,
		.info-toggle {
			justify-self: start;
		}
	}
	.song-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		justify-content: flex-end;
		justify-self: end;
		gap: 0.1rem 0.15rem;
	}
	.print-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		cursor: pointer;
		user-select: none;
		padding: 0.2rem 0.35rem;
		white-space: nowrap;
	}
	.print-toggle input {
		accent-color: var(--color-ink);
		width: 0.8rem;
		height: 0.8rem;
	}
	.song-tool {
		appearance: none;
		display: inline-flex;
		align-items: center;
		gap: 0.32rem;
		border: none;
		background: transparent;
		padding: 0.2rem 0.4rem;
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		cursor: pointer;
	}
	.print-icon {
		width: 0.82rem;
		height: 0.82rem;
		flex-shrink: 0;
		color: currentColor;
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
	.song-tool-danger:hover:not(:disabled) {
		color: #991b1b;
	}
	.play-controls {
		position: fixed;
		bottom: 1.25rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 60;
		display: inline-flex;
		align-items: stretch;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-button);
		overflow: hidden;
		background: #ffffff;
		box-shadow: 0 8px 22px rgba(15, 23, 42, 0.14);
		transition: box-shadow 160ms ease, border-color 160ms ease;
	}
	.play-controls.is-playing {
		border-color: var(--color-accent);
		box-shadow: 0 10px 28px rgba(15, 23, 42, 0.2);
	}
	.play-controls .play-side,
	.play-controls .play-main {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		margin: 0;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--color-ink);
		font-weight: 600;
		font-size: 0.9rem;
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}
	.play-controls .play-side {
		min-width: 2.4rem;
		padding: 0.55rem 0.65rem;
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
		padding: 0.55rem 1rem;
		min-width: 5.5rem;
	}
	.play-controls .play-side:hover,
	.play-controls .play-main:hover {
		background: #f3f4f6;
	}
	.play-controls.is-playing .play-main {
		background: var(--color-accent);
		color: #ffffff;
	}
	.play-controls.is-playing .play-main:hover {
		background: var(--color-accent-hover);
	}
	.play-controls.is-playing .play-side {
		color: var(--color-ink);
	}
	.play-controls.is-playing .play-side:hover {
		background: rgba(245, 158, 11, 0.12);
	}
	.title-line {
		display: flex;
		align-items: baseline;
		gap: 0.7rem 0.9rem;
		min-width: 0;
		flex-wrap: wrap;
	}
	.title-input {
		min-width: 6ch;
		max-width: 100%;
		flex: 0 1 auto;
		background: transparent;
		border: none;
		font-family: var(--font-title);
		font-size: 1.55rem;
		line-height: 1.12;
		font-weight: 400;
		letter-spacing: -0.03em;
		color: var(--color-ink);
		padding: 0;
		border-radius: 0;
	}
	.title-input:focus {
		outline: none;
		box-shadow: inset 0 -1px 0 var(--color-ink);
	}
	.song-sub {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.45rem;
		min-width: 0;
	}
	.artist-cats {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.45rem;
		min-width: 0;
		margin-left: auto;
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
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		border: none;
		background: transparent;
		padding: 0;
		font-family: var(--font-sans);
		font-size: 0.72rem;
		font-weight: 400;
		letter-spacing: 0.01em;
		color: var(--cat-color, var(--color-ink-muted));
		cursor: pointer;
	}
	.artist-cat:hover {
		text-decoration: underline;
		text-underline-offset: 0.16em;
	}
	.song-functions {
		display: inline-flex;
		align-items: center;
		gap: 0;
		border: 1px solid var(--color-border-subtle);
		border-radius: 2px;
		min-height: 1.55rem;
		flex-shrink: 0;
	}
	.key-cluster {
		display: inline-flex;
		align-items: baseline;
		flex: 0 0 auto;
		gap: 0.05rem;
		padding: 0 0.35rem 0 0.2rem;
		color: var(--color-ink-muted);
	}
	.key-btn {
		padding: 0 0.2rem;
		font-weight: 400;
		font-size: 0.85rem;
		line-height: 1;
		color: var(--color-ink-faint);
		background: transparent;
		border: none;
		cursor: pointer;
	}
	.key-btn:hover {
		color: var(--color-ink);
	}
	.key-input {
		width: 2.4rem;
		text-align: center;
		font-weight: 500;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		letter-spacing: 0.02em;
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
	.cat-pick {
		width: 9.5rem;
		min-width: 0;
		background: transparent;
		border: none;
		border-left: 1px solid var(--color-border-subtle);
		padding: 0 0.55rem;
		height: 1.55rem;
		font-family: var(--font-title);
		font-size: 0.72rem;
		letter-spacing: 0.04em;
		color: var(--color-ink);
	}
	.cat-pick:focus {
		outline: none;
		background: #f8fafc;
	}
	.cat-pick::placeholder {
		color: var(--color-ink-faint);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		font-size: 0.64rem;
	}
	.info-toggle {
		grid-column: 2;
		grid-row: 3;
		justify-self: end;
		align-self: center;
		appearance: none;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		border: none;
		background: transparent;
		padding: 0.2rem 0;
		margin-top: 0.15rem;
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-faint);
		cursor: pointer;
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
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		padding: 0.75rem 0 0.9rem;
		border-top: 1px solid var(--color-border-subtle);
	}
	.info-field {
		display: grid;
		grid-template-columns: 8.75rem minmax(0, 1fr);
		align-items: baseline;
		gap: 0.75rem;
	}
	.info-field > span {
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
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
		font-weight: 400;
		letter-spacing: -0.015em;
		color: var(--color-ink);
	}
	.info-input:focus {
		outline: none;
		box-shadow: inset 0 -1px 0 var(--color-ink);
	}
	.info-input::placeholder {
		color: var(--color-ink-faint);
		opacity: 0.55;
	}
	.artist-input {
		width: auto;
		min-width: 8ch;
		max-width: 100%;
		flex: 0 1 auto;
		background: transparent;
		border: none;
		font-family: var(--font-title);
		font-size: 0.78rem;
		font-weight: 400;
		color: var(--color-ink-faint);
		padding: 0;
		letter-spacing: 0.02em;
	}
	.artist-input:focus {
		outline: none;
		color: var(--color-ink);
		box-shadow: inset 0 -1px 0 var(--color-ink);
	}
	.artist-input::placeholder {
		color: var(--color-ink-faint);
		opacity: 0.55;
	}
	.print-header {
		display: none;
	}
	.song-area {
		background: #ffffff;
		border-radius: 0.35rem;
		padding: 0.9rem 1rem 1rem;
		border: 1px solid var(--color-border-subtle);
	}
</style>
