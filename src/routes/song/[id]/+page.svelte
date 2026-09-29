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
	import { readSongDisplayFlags, writeSongDisplayFlags } from '$lib/songDisplay';
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
	let columnLayout = $state(false);
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
				applyDisplayFlags(s, !authState.user);
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

	function applyDisplayFlags(s: SongDoc, useLocal: boolean) {
		const local = useLocal ? readSongDisplayFlags(s.id) : null;
		columnLayout = local?.columnLayout ?? s.columnLayout ?? false;
		fitSinglePage = local?.fitSinglePage ?? s.fitSinglePage ?? true;
		showBassTabs = columnLayout ? false : (local?.showBassTabs ?? s.showBassTabs ?? true);
	}

	function persistDisplayFlags() {
		if (!song || !browser) return;
		writeSongDisplayFlags(song.id, { showBassTabs, columnLayout, fitSinglePage });
	}

	function onDisplayFlagsChange() {
		persistDisplayFlags();
		scheduleSave();
	}

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
				columnLayout,
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
					columnLayout,
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
				withBassTabs: columnLayout ? false : showBassTabs,
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
				filename: `${exportTitle} - tekst`,
				includeFrontMatter: false
			});
		} catch (err) {
			console.error('Publikums-PDF fejlede:', err);
			alert('Kunne ikke generere publikums-PDF — se konsollen for detaljer.');
		} finally {
			audiencePdfBusy = false;
		}
	}

	// ───── Spil: CSS-transition i klippet viewport (Safari-compositor) ──
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
	let songPageEl = $state<HTMLElement | null>(null);
	let playMaxScroll = 0;

	function waitFrame(): Promise<void> {
		return new Promise((r) => requestAnimationFrame(() => r()));
	}

	function viewportH(): number {
		return window.visualViewport?.height ?? window.innerHeight;
	}

	function playOffsetY(el: HTMLElement): number {
		const t = getComputedStyle(el).transform;
		if (!t || t === 'none') return 0;
		return -new DOMMatrixReadOnly(t).m42;
	}

	function remainingDuration(fromY: number): number {
		const left = Math.max(0, playMaxScroll - fromY);
		if (playMaxScroll <= 0) return 0;
		return (left / playMaxScroll) * PLAY_FULL_PAGE_SEC / playSpeed;
	}

	function clearPlayMotion(el: HTMLElement): void {
		el.removeEventListener('transitionend', onPlayTransitionEnd);
		el.style.transition = 'none';
		el.style.transform = '';
	}

	function onPlayTransitionEnd(e: TransitionEvent): void {
		if (e.target !== songPageEl || e.propertyName !== 'transform') return;
		const el = songPageEl;
		if (!el || !playing) return;
		if (playOffsetY(el) >= playMaxScroll - 1) stopPlay();
	}

	function glidePlayToEnd(el: HTMLElement, fromY: number): void {
		el.removeEventListener('transitionend', onPlayTransitionEnd);
		el.style.transition = 'none';
		el.style.transform = `translate3d(0, ${-fromY}px, 0)`;
		void el.offsetHeight;
		const sec = remainingDuration(fromY);
		el.addEventListener('transitionend', onPlayTransitionEnd);
		if (sec <= 0) {
			stopPlay();
			return;
		}
		el.style.transition = `transform ${sec}s linear`;
		el.style.transform = `translate3d(0, ${-playMaxScroll}px, 0)`;
	}

	function stopPlay(): void {
		const el = songPageEl;
		let y = window.scrollY;
		if (playing && el) {
			const t = getComputedStyle(el).transform;
			if (t && t !== 'none') y = playOffsetY(el);
		}
		if (el) clearPlayMotion(el);
		document.documentElement.classList.remove('song-is-playing');
		document.body.classList.remove('song-is-playing');
		playing = false;
		window.scrollTo(0, y);
	}

	function slowerPlay(): void {
		playSpeed = playSpeed / PLAY_SPEED_FACTOR;
		if (playing && songPageEl) glidePlayToEnd(songPageEl, playOffsetY(songPageEl));
	}

	function fasterPlay(): void {
		playSpeed = playSpeed * PLAY_SPEED_FACTOR;
		if (playing && songPageEl) glidePlayToEnd(songPageEl, playOffsetY(songPageEl));
	}

	function formatPlaySpeed(s: number): string {
		return String(Number(s.toPrecision(3)));
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
			await waitFrame();
		}
		infoOpen = false;
		playing = true;
		await tick();
		await waitFrame();
		await waitFrame();
		if (!playing) return;

		const el = songPageEl;
		if (!el) {
			stopPlay();
			return;
		}
		playMaxScroll = Math.max(0, el.offsetHeight - viewportH());
		if (playMaxScroll <= 0) {
			stopPlay();
			return;
		}
		const startY = Math.min(window.scrollY, playMaxScroll);

		el.style.transition = 'none';
		el.style.transform = `translate3d(0, ${-startY}px, 0)`;
		document.documentElement.classList.add('song-is-playing');
		document.body.classList.add('song-is-playing');
		window.scrollTo(0, 0);
		await waitFrame();
		if (!playing) return;
		glidePlayToEnd(el, startY);
	}

	$effect(() => {
		if (!browser) return;
		void rows.length;
		void infoOpen;
		const nodes = PLAY_OFFENDERS.flatMap((sel) => [...document.querySelectorAll(sel)]);
		for (const el of nodes) el.classList.toggle('play-hidden', playing);
		return () => {
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
		const blockScroll = (e: Event) => e.preventDefault();
		window.addEventListener('keydown', onKey);
		window.addEventListener('wheel', blockScroll, { passive: false });
		window.addEventListener('touchmove', blockScroll, { passive: false });
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('wheel', blockScroll);
			window.removeEventListener('touchmove', blockScroll);
		};
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

<div class="song-play-viewport">
	<div class="song-page" bind:this={songPageEl}>
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
						class="song-title title-input"
						type="text"
						bind:value={title}
						oninput={() => scheduleSave()}
						placeholder="Titel"
					/>
				{:else}
					<h1 class="song-title title-input">{title || 'Uden titel'}</h1>
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
					<div class="song-print-flags">
						<label class="print-toggle">
							<input
								type="checkbox"
								bind:checked={fitSinglePage}
								onchange={onDisplayFlagsChange}
							/>
							Enkeltside
						</label>
						<label class="print-toggle">
							<input
								type="checkbox"
								bind:checked={columnLayout}
								onchange={() => {
									if (columnLayout) showBassTabs = false;
									onDisplayFlagsChange();
								}}
							/>
							Kolonne
						</label>
						<label class="print-toggle" class:is-disabled={columnLayout}>
							<input
								type="checkbox"
								bind:checked={showBassTabs}
								disabled={columnLayout}
								onchange={onDisplayFlagsChange}
							/>
							Bas
						</label>
					</div>
				</div>

				{#if artist || canEdit || youtubeLinks.length > 0}
					<div class="song-meta">
						{#if artist}
							<p class="artist-line">{artist}</p>
						{:else}
							<span></span>
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
				{/if}

				{#if canEdit || youtubeLinks.length > 0}
				<section class="info-block no-print" class:is-open={infoOpen}>
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
									<div class="info-field">
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
									<div class="info-field">
										<span>Kategorier</span>
										<div class="info-cats">
											{#each categories as cat (cat)}
												{@const c = colorForCategory(cat)}
												<span class="info-cat-wrap">
													<button
														type="button"
														class="info-cat"
														style:--cat-color={c.text}
														onclick={() => goToSongbookCategory(cat)}
													>
														{cat}
													</button>
													<button
														type="button"
														class="info-cat-remove"
														title="Fjern kategori"
														aria-label="Fjern {cat}"
														onclick={() => removeCategory(cat)}
													>
														×
													</button>
												</span>
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
									</div>
								{:else if key.trim() || categories.length > 0}
									{#if key.trim()}
										<div class="info-field">
											<span>Toneart</span>
											<div class="key-cluster is-static" aria-label="Toneart">
												<span class="key-input">{key}</span>
											</div>
										</div>
									{/if}
									{#if categories.length > 0}
										<div class="info-field">
											<span>Kategorier</span>
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
							{#if canEdit}
								<button type="button" class="info-delete" onclick={handleDelete}>Slet sang</button>
							{/if}
						</div>
					</div>
				</section>
				{/if}
			</div>

			<div class="print-header" aria-hidden="true">
				<div class="song-title print-title">{title || 'Uden titel'}</div>
				{#if artist.trim() || key.trim()}
					<div class="print-artist">
						{#if artist.trim()}{artist.trim()}{/if}
						{#if artist.trim() && key.trim()} · {/if}
						{#if key.trim()}<span class="print-key">{key.trim()}</span>{/if}
					</div>
				{/if}
			</div>

			<div
				class="song-area"
				class:no-bass-tabs={!showBassTabs || columnLayout}
				class:column-layout={columnLayout}
			>
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
</div>

<style>
	:global(html.song-is-playing),
	:global(html.song-is-playing body) {
		overflow: hidden;
		overscroll-behavior: none;
		touch-action: none;
	}
	.song-play-viewport {
		display: block;
	}
	:global(html.song-is-playing) .song-play-viewport {
		position: fixed;
		inset: 0;
		z-index: 1;
		overflow: hidden;
		background: #ffffff;
		overscroll-behavior: none;
		touch-action: none;
	}
	.song-page {
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
	:global(html.song-is-playing) .song-page {
		overflow-x: visible;
		backface-visibility: hidden;
		-webkit-backface-visibility: hidden;
	}
	.song-sheet {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-4);
		min-width: 0;
	}
	.song-status {
		margin: var(--space-5) 0;
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
		gap: var(--space-2);
	}
	.back-link {
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		justify-content: start;
		justify-self: start;
		width: max-content;
		gap: var(--space-1);
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
		gap: var(--space-2);
		font-size: var(--type-xs);
		color: var(--color-ink-faint);
	}
	.song-chrome-status a {
		color: inherit;
	}
	.song-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
		min-width: 0;
	}
	.song-prints {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		min-width: 0;
	}
	.song-print-flags {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}
	.song-prints :global(.print-toggle) {
		min-height: 0;
		font-size: var(--type-xs);
		font-weight: 500;
	}
	.song-meta {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--space-2);
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
		gap: var(--space-1);
		border: none;
		background: transparent;
		padding: 0;
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
	.title-input {
		width: 100%;
		min-width: 0;
		background: transparent;
		border: none;
		font-size: clamp(1.35rem, 6vw, 1.7rem);
		padding: 0;
		margin: 0;
	}
	.title-input:focus {
		outline: none;
		box-shadow: inset 0 -1px 0 var(--color-ink);
	}
	.info-block {
		margin: 0;
		padding: 0;
		border: none;
	}
	.info-block.is-open {
		margin-top: var(--space-2);
	}
	.info-toggle {
		appearance: none;
		display: inline-grid;
		grid-auto-flow: column;
		align-items: center;
		justify-content: end;
		gap: var(--space-1);
		width: auto;
		justify-self: end;
		border: none;
		background: transparent;
		padding: 0;
		font-size: var(--type-sm);
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
		display: grid;
		overflow: hidden;
		min-height: 0;
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
			--space-1: 0.3rem;
			--space-2: 0.55rem;
			--space-3: 0.9rem;
			--space-4: 1.25rem;
			--pad: clamp(16px, 2.8vw, 24px);
			--control-h: 2.15rem;
			padding-top: calc(var(--pad) + env(safe-area-inset-top, 0px));
			padding-right: max(3.5rem, calc(var(--pad) + env(safe-area-inset-right, 0px)));
			padding-bottom: calc(4.6rem + env(safe-area-inset-bottom, 0px));
			padding-left: max(3.5rem, calc(var(--pad) + env(safe-area-inset-left, 0px)));
		}
		.title-input {
			font-size: clamp(1.15rem, 3.6vw, 1.45rem);
		}
	}
</style>
