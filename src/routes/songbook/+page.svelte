<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { authState } from '$lib/auth.svelte';
	import { BAND } from '$lib/data/band';
	import {
		deleteCategoryImage,
		saveCategoryColors,
		saveCategoryMeta,
		subscribeCategoryColors,
		subscribeCategoryMeta,
		subscribeSongs,
		updateSong,
		uploadCategoryImage
	} from '$lib/firebase/songs';
	import {
		inviteBandMember,
		listBandMembers,
		removeBandMember,
		updateMyProfile,
		type BandMemberProfile,
		type InvitedBandMember
	} from '$lib/firebase/members';
	import { uniqueCategoriesFromSongs } from '$lib/chordFormatter';
	import CategoryMetaDialog from '$lib/components/CategoryMetaDialog.svelte';
	import CategoryPicker from '$lib/components/CategoryPicker.svelte';
	import ProfileDialog from '$lib/components/ProfileDialog.svelte';
	import { SONGBOOK_SESSION_SELECTION_KEY } from '$lib/songbookSelection';
	import { exportAudienceSongbookAsPdf, exportSongsAsPdf, type SongbookPrintEntry } from '$lib/pdf';
	import {
		assignMissingCategoryColors,
		colorForCategory as paletteColorForCategory,
		hasSameCategoryColors
	} from '$lib/categoryColors';
	import type {
		CategoryColorMap,
		CategoryMeta,
		CategoryMetaMap,
		SongDoc
	} from '$lib/types';

	let songs = $state<SongDoc[]>([]);
	let loadingSongs = $state(true);
	let error = $state<string | null>(null);
	let activeCategory = $state<string | null>(null); // null = alle (filter)
	let printCategory = $state<string>(''); // '' = hele sangbogen
	let search = $state('');
	let categoryColorMap = $state<CategoryColorMap>({});
	let categoryMetaMap = $state<CategoryMetaMap>({});
	let pdfBusy = $state(false);
	let audiencePdfBusy = $state(false);
	let editingCategories = $state(false);
	let editingFocusCategory = $state('');
	let categorySaving = $state(false);
	let categoryUploading = $state(false);
	let categoryError = $state<string | null>(null);
	let restoredSessionSelection = $state(false);
	let editingProfile = $state(false);
	let profileMembers = $state<BandMemberProfile[]>([]);
	let profileLoading = $state(false);
	let profileSaving = $state(false);
	let profileInviting = $state(false);
	let profileRemovingUid = $state<string | null>(null);
	let profileError = $state<string | null>(null);
	let canManageMembers = $state(false);
	let printDrag = $state<{ kind: 'palette-set' } | { kind: 'print-entry'; index: number } | null>(null);
	let printDropIndex = $state<number | null>(null);
	let editingPrintOrder = $state<string | null>(null);
	const pdfGenerating = $derived(pdfBusy || audiencePdfBusy);

	type PrintOrderEntry =
		| { type: 'song'; songId: string }
		| { type: 'set'; id: string; label: string };

	const SET_ORDER_PREFIX = '__set__:';

	const canEdit = $derived(!!authState.user);

	$effect(() => {
		if (authState.loading) return;
		const unsub = subscribeSongs(
			(s) => {
				songs = s;
				loadingSongs = false;
			},
			(err) => {
				error = err.message;
				loadingSongs = false;
			}
		);
		return () => unsub();
	});

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

	const categories = $derived(uniqueCategoriesFromSongs(songs));
	const allCategoryNames = $derived.by(() => {
		const names = new Set([...categories, ...Object.keys(categoryMetaMap)]);
		return [...names].sort((a, b) => a.localeCompare(b, 'da'));
	});
	const effectiveCategoryColorMap = $derived(
		assignMissingCategoryColors(allCategoryNames, categoryColorMap)
	);

	$effect(() => {
		if (!browser || restoredSessionSelection) return;
		restoredSessionSelection = true;
		const raw = sessionStorage.getItem(SONGBOOK_SESSION_SELECTION_KEY);
		if (!raw) return;
		try {
			const saved = JSON.parse(raw) as { activeCategory?: string | null; printCategory?: string };
			activeCategory = saved.activeCategory ?? null;
			printCategory = saved.printCategory ?? saved.activeCategory ?? '';
		} catch {
			sessionStorage.removeItem(SONGBOOK_SESSION_SELECTION_KEY);
		}
	});

	$effect(() => {
		if (!browser || !restoredSessionSelection) return;
		sessionStorage.setItem(
			SONGBOOK_SESSION_SELECTION_KEY,
			JSON.stringify({ activeCategory, printCategory })
		);
	});

	$effect(() => {
		if (!authState.user || allCategoryNames.length === 0) return;
		if (!hasSameCategoryColors(effectiveCategoryColorMap, categoryColorMap)) {
			void saveCategoryColors(effectiveCategoryColorMap);
		}
	});

	function colorForCategory(cat: string) {
		return paletteColorForCategory(cat, effectiveCategoryColorMap);
	}

	const filteredSongs = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return [...songs]
			.filter((s) => {
				if (activeCategory && !(s.categories ?? []).includes(activeCategory)) return false;
				if (!q) return true;
				return s.title.toLowerCase().includes(q) || (s.artist ?? '').toLowerCase().includes(q);
			})
			.sort((a, b) => a.title.localeCompare(b.title, 'da'));
	});

	type SongLetterGroup = { letter: string; songs: SongDoc[] };

	function songLetter(title: string): string {
		const ch = title.trim().charAt(0).toLocaleUpperCase('da');
		return /[A-ZÆØÅ]/.test(ch) ? ch : '#';
	}

	const groupedSongs = $derived.by<SongLetterGroup[]>(() => {
		const groups = new Map<string, SongDoc[]>();
		for (const song of filteredSongs) {
			const letter = songLetter(song.title);
			const bucket = groups.get(letter);
			if (bucket) bucket.push(song);
			else groups.set(letter, [song]);
		}
		return [...groups.entries()]
			.sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b, 'da')))
			.map(([letter, group]) => ({ letter, songs: group }));
	});

	function onSearchInput(): void {
		if (!search.trim()) return;
		if (activeCategory !== null || printCategory) {
			activeCategory = null;
			printCategory = '';
		}
	}

	async function handleSignOut() {
		await authState.signOut();
		goto('/songbook');
	}

	async function openProfileDialog(): Promise<void> {
		if (authState.user && authState.profile) {
			profileMembers = mergeProfileMembers([], [
				{
					uid: authState.user.uid,
					displayName: authState.profile.displayName,
					email: authState.profile.email
				}
			]);
		}
		editingProfile = true;
		profileError = null;
		await refreshProfileMembers();
	}

	async function refreshProfileMembers(): Promise<void> {
		profileLoading = true;
		profileError = null;
		try {
			const result = await listBandMembers();
			canManageMembers = result.canRemoveMembers;
			profileMembers = mergeProfileMembers(profileMembers, result.members);
		} catch (err) {
			profileError = err instanceof Error ? err.message : 'Kunne ikke hente medlemmer.';
		} finally {
			profileLoading = false;
		}
	}

	function mergeProfileMembers(
		current: BandMemberProfile[],
		incoming: BandMemberProfile[]
	): BandMemberProfile[] {
		const byUid = new Map(current.map((member) => [member.uid, member]));
		for (const member of incoming) {
			byUid.set(member.uid, { ...(byUid.get(member.uid) ?? {}), ...member });
		}
		return [...byUid.values()];
	}

	async function saveProfile(displayName: string, email: string): Promise<void> {
		if (!authState.user) return;
		profileSaving = true;
		profileError = null;
		try {
			const updated = await updateMyProfile(displayName, email);
			authState.profile = {
				...(authState.profile ?? {}),
				displayName: updated.displayName,
				email: updated.email
			} as typeof authState.profile;
			profileMembers = profileMembers.map((member) =>
				member.uid === updated.uid ? { ...member, ...updated } : member
			);
		} catch (err) {
			profileError = err instanceof Error ? err.message : 'Kunne ikke gemme profilen.';
		} finally {
			profileSaving = false;
		}
	}

	async function inviteMember(email: string, displayName: string): Promise<InvitedBandMember | null> {
		profileInviting = true;
		profileError = null;
		try {
			const invited = await inviteBandMember(email, displayName);
			if (!profileMembers.some((member) => member.uid === invited.uid)) {
				profileMembers = [...profileMembers, invited];
			} else {
				profileMembers = profileMembers.map((member) =>
					member.uid === invited.uid ? { ...member, ...invited } : member
				);
			}
			return invited;
		} catch (err) {
			profileError = err instanceof Error ? err.message : 'Kunne ikke invitere medlemmet.';
			return null;
		} finally {
			profileInviting = false;
		}
	}

	async function removeMember(uid: string): Promise<void> {
		profileRemovingUid = uid;
		profileError = null;
		try {
			await removeBandMember(uid);
			profileMembers = profileMembers.filter((member) => member.uid !== uid);
		} catch (err) {
			profileError = err instanceof Error ? err.message : 'Kunne ikke fjerne medlemmet.';
		} finally {
			profileRemovingUid = null;
		}
	}

	async function handlePdfBook() {
		if (pdfBusy || printSongs.length === 0) return;
		pdfBusy = true;
		try {
			const title = printCategory || `${BAND.name}s sangbog`;
			await exportSongsAsPdf(printEntries, {
				filename: title,
				withBassTabs: true,
				includeCover: true,
				coverTitle: title,
				coverMeta: printCategory ? categoryMetaMap[printCategory] : undefined
			});
		} catch (err) {
			console.error('PDF-eksport fejlede:', err);
			alert('Kunne ikke generere PDF — se konsollen for detaljer.');
		} finally {
			pdfBusy = false;
		}
	}

	async function handleAudiencePdfBook() {
		if (audiencePdfBusy || printSongs.length === 0) return;
		audiencePdfBusy = true;
		try {
			const title = printCategory || `${BAND.name}s Sangbog`;
			await exportAudienceSongbookAsPdf(printSongs, {
				title,
				filename: `${title} - tekst`,
				categoryMeta: printCategory ? categoryMetaMap[printCategory] : undefined
			});
		} catch (err) {
			console.error('Publikums-PDF fejlede:', err);
			alert('Kunne ikke generere publikums-PDF — se konsollen for detaljer.');
		} finally {
			audiencePdfBusy = false;
		}
	}

	function openCategoryEditor(category?: string): void {
		editingFocusCategory = category ?? '';
		editingCategories = true;
		categoryError = null;
	}

	async function addCategoryMeta(category: string): Promise<void> {
		const now = Date.now();
		categorySaving = true;
		categoryError = null;
		try {
			await saveCategoryMeta({
				...categoryMetaMap,
				[category]: cleanCategoryMeta({
					...(categoryMetaMap[category] ?? {}),
					createdAt: categoryMetaMap[category]?.createdAt ?? now,
					updatedAt: now
				})
			});
		} catch (err) {
			categoryError = err instanceof Error ? err.message : 'Kunne ikke gemme kategori.';
		} finally {
			categorySaving = false;
		}
	}

	async function saveEditingCategory(category: string, meta: CategoryMeta): Promise<void> {
		const now = Date.now();
		categorySaving = true;
		categoryError = null;
		try {
			await saveCategoryMeta({
				...categoryMetaMap,
				[category]: cleanCategoryMeta({
					...meta,
					createdAt: meta.createdAt ?? categoryMetaMap[category]?.createdAt ?? now,
					updatedAt: now
				})
			});
		} catch (err) {
			categoryError = err instanceof Error ? err.message : 'Kunne ikke gemme kategori.';
			throw err;
		} finally {
			categorySaving = false;
		}
	}

	async function renameCategory(from: string, to: string): Promise<void> {
		const nextName = to.trim();
		if (!nextName || nextName === from || !authState.user) return;
		categorySaving = true;
		categoryError = null;
		try {
			const currentMeta = categoryMetaMap[from] ?? {};
			const now = Date.now();
			const nextMeta = { ...categoryMetaMap };
			delete nextMeta[from];
			nextMeta[nextName] = cleanCategoryMeta({
				...currentMeta,
				createdAt: currentMeta.createdAt ?? now,
				updatedAt: now
			});
			await saveCategoryMeta(nextMeta);
			await Promise.all(
				songs
					.filter((song) => (song.categories ?? []).includes(from))
					.map((song) =>
						updateSong(
							song.id,
							{
								categories: [...new Set((song.categories ?? []).map((cat) => (cat === from ? nextName : cat)))]
							},
							authState.user!.uid
						)
					)
			);
			if (activeCategory === from) activeCategory = nextName;
			if (printCategory === from) printCategory = nextName;
		} catch (err) {
			categoryError = err instanceof Error ? err.message : 'Kunne ikke omdøbe kategori.';
			throw err;
		} finally {
			categorySaving = false;
		}
	}

	async function deleteCategoryMeta(category: string): Promise<void> {
		if (!authState.user) return;
		const ok = confirm(
			`Slet kategorien "${category}" fra kategori-listen og fra alle sange? Selve sangene bliver ikke slettet.`
		);
		if (!ok) return;
		categorySaving = true;
		categoryError = null;
		try {
			const current = categoryMetaMap[category];
			if (current?.imagePath) await deleteCategoryImage(current.imagePath);
			const next = { ...categoryMetaMap };
			delete next[category];
			await saveCategoryMeta(next);
			await Promise.all(
				songs
					.filter((song) => (song.categories ?? []).includes(category))
					.map((song) =>
						updateSong(
							song.id,
							{ categories: (song.categories ?? []).filter((cat) => cat !== category) },
							authState.user!.uid
						)
					)
			);
			if (activeCategory === category) activeCategory = null;
			if (printCategory === category) printCategory = '';
		} catch (err) {
			categoryError = err instanceof Error ? err.message : 'Kunne ikke slette kategori.';
		} finally {
			categorySaving = false;
		}
	}

	async function uploadEditingCategoryImage(category: string, file: File): Promise<void> {
		if (!authState.user) return;
		categoryUploading = true;
		categoryError = null;
		try {
			const current = categoryMetaMap[category] ?? {};
			const uploaded = await uploadCategoryImage(category, file, authState.user.uid);
			if (current.imagePath) {
				deleteCategoryImage(current.imagePath).catch((err) =>
					console.warn('Kunne ikke slette gammelt kategori-billede:', err)
				);
			}
			const now = Date.now();
			await saveCategoryMeta({
				...categoryMetaMap,
				[category]: cleanCategoryMeta({
					...current,
					...uploaded,
					createdAt: current.createdAt ?? now,
					updatedAt: now
				})
			});
		} catch (err) {
			categoryError = firebaseErrorMessage(err, 'Kunne ikke uploade billede.');
		} finally {
			categoryUploading = false;
		}
	}

	function firebaseErrorMessage(err: unknown, fallback: string): string {
		if (!(err instanceof Error)) return fallback;
		const code = (err as { code?: string }).code;
		return code ? `${fallback} (${code}: ${err.message})` : `${fallback} (${err.message})`;
	}

	async function removeEditingCategoryImage(category: string): Promise<void> {
		categorySaving = true;
		categoryError = null;
		try {
			const current = categoryMetaMap[category] ?? {};
			if (current.imagePath) await deleteCategoryImage(current.imagePath);
			const now = Date.now();
			await saveCategoryMeta({
				...categoryMetaMap,
				[category]: cleanCategoryMeta({
					...current,
					imageUrl: undefined,
					imagePath: undefined,
					updatedAt: now
				})
			});
		} catch (err) {
			categoryError = err instanceof Error ? err.message : 'Kunne ikke fjerne billede.';
		} finally {
			categorySaving = false;
		}
	}

	function cleanCategoryMeta(meta: CategoryMeta): CategoryMeta {
		return {
			...(meta.introText?.trim() ? { introText: meta.introText.trim() } : {}),
			...(meta.imageUrl ? { imageUrl: meta.imageUrl } : {}),
			...(meta.imagePath ? { imagePath: meta.imagePath } : {}),
			...(meta.songOrder?.length ? { songOrder: meta.songOrder } : {}),
			...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
			...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {})
		};
	}

	function defaultPrintOrderForCategory(cat: string): PrintOrderEntry[] {
		return songs
			.filter((song) => (song.categories ?? []).includes(cat))
			.map((song) => ({ type: 'song' as const, songId: song.id }));
	}

	function printOrderForCategory(cat: string): PrintOrderEntry[] {
		const saved = (categoryMetaMap[cat]?.songOrder ?? []).map(orderTokenToEntry);
		const categorySongIds = new Set(
			songs.filter((song) => (song.categories ?? []).includes(cat)).map((song) => song.id)
		);
		if (saved.length === 0) return defaultPrintOrderForCategory(cat);
		const out = saved.filter((entry) => entry.type === 'set' || categorySongIds.has(entry.songId));
		const knownSongIds = new Set(out.filter((entry) => entry.type === 'song').map((entry) => entry.songId));
		for (const id of categorySongIds) {
			if (!knownSongIds.has(id)) out.push({ type: 'song', songId: id });
		}
		return out;
	}

	function countSetsForCategory(cat: string): number {
		return printOrderForCategory(cat).filter((entry) => entry.type === 'set').length + 1;
	}

	function songCountLabel(count: number): string {
		return `${count} ${count === 1 ? 'sang' : 'sange'}`;
	}

	function setCountLabel(count: number): string {
		return `${count} ${count === 1 ? 'sæt' : 'sæt'}`;
	}

	function savePrintOrder(order: PrintOrderEntry[]): void {
		if (!printCategory) return;
		const now = Date.now();
		const current = categoryMetaMap[printCategory] ?? {};
		void saveEditingCategory(printCategory, {
			...current,
			songOrder: order.map(entryToOrderToken),
			createdAt: current.createdAt ?? now,
			updatedAt: now
		});
	}

	function orderTokenToEntry(token: string): PrintOrderEntry {
		if (token.startsWith(SET_ORDER_PREFIX)) {
			const raw = token.slice(SET_ORDER_PREFIX.length);
			const [id, ...labelParts] = raw.split(':');
			const label = labelParts.join(':') || 'Sæt';
			return { type: 'set', id: id || raw || `set-${Date.now()}`, label };
		}
		return { type: 'song', songId: token };
	}

	function entryToOrderToken(entry: PrintOrderEntry): string {
		if (entry.type === 'song') return entry.songId;
		return `${SET_ORDER_PREFIX}${entry.id}:${entry.label}`;
	}

	function nextSetEntry(order: PrintOrderEntry[]): PrintOrderEntry {
		return { type: 'set', id: `set-${Date.now()}`, label: 'Sæt' };
	}

	function setLabelForOrderIndex(order: PrintOrderEntry[], index: number): string {
		const setBeforeOrAtIndex = order
			.slice(0, index + 1)
			.filter((entry) => entry.type === 'set').length;
		return `${setBeforeOrAtIndex + 1}. sæt`;
	}

	function removeSetAt(index: number): void {
		if (!printCategory) return;
		const current = printOrderForCategory(printCategory);
		if (current[index]?.type !== 'set') return;
		savePrintOrder(current.filter((_, i) => i !== index));
	}

	function onPrintDragStart(e: DragEvent, drag: typeof printDrag): void {
		if (!e.dataTransfer) return;
		printDrag = drag;
		e.dataTransfer.effectAllowed = drag?.kind === 'palette-set' ? 'copy' : 'move';
		e.dataTransfer.setData('application/x-print-order', JSON.stringify(drag));
	}

	function onPrintDragOver(e: DragEvent, index: number): void {
		if (!printDrag) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = printDrag.kind === 'palette-set' ? 'copy' : 'move';
		printDropIndex = index;
	}

	function onPrintItemDragOver(e: DragEvent, index: number): void {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const before = e.clientY < rect.top + rect.height / 2;
		onPrintDragOver(e, before ? index : index + 1);
	}

	function onPrintDrop(e: DragEvent, index: number): void {
		e.preventDefault();
		if (!printCategory || !printDrag) return;
		const current = printOrderForCategory(printCategory);
		let next = [...current];
		if (printDrag.kind === 'palette-set') {
			next.splice(index, 0, nextSetEntry(current));
		} else {
			const [moved] = next.splice(printDrag.index, 1);
			if (!moved) return;
			const target = printDrag.index < index ? index - 1 : index;
			next.splice(target, 0, moved);
		}
		printDrag = null;
		printDropIndex = null;
		savePrintOrder(next);
	}

	function onPrintOrderDrop(e: DragEvent): void {
		if (!printDrag || !printCategory) return;
		e.preventDefault();
		e.stopPropagation();
		const fallbackIndex = printOrderForCategory(printCategory).length;
		onPrintDrop(e, printDropIndex ?? fallbackIndex);
	}

	function allowPrintOrderDrop(e: DragEvent): void {
		if (!printDrag) return;
		e.preventDefault();
	}

	function onPrintDragEnd(): void {
		printDrag = null;
		printDropIndex = null;
	}

	function selectPrintCategory(cat: string): void {
		printCategory = cat;
		activeCategory = cat || null;
		search = '';
	}

	function pickPrintCategory(cat: string): void {
		if (cat && cat === printCategory) {
			selectPrintCategory('');
			return;
		}
		selectPrintCategory(cat);
	}

	function printOptionLabel(cat: string): string {
		if (!cat) return `Alle (${songs.length})`;
		const count = songs.filter((s) => (s.categories ?? []).includes(cat)).length;
		return `${cat} (${count})`;
	}

	const printCount = $derived.by(() => {
		if (!printCategory) return songs.length;
		return songs.filter((s) => (s.categories ?? []).includes(printCategory)).length;
	});

	const printSongs = $derived.by(() => {
		if (!printCategory) return songs;
		const byId = new Map(songs.map((song) => [song.id, song]));
		return printOrderForCategory(printCategory)
			.filter((entry) => entry.type === 'song')
			.map((entry) => byId.get(entry.songId))
			.filter((song): song is SongDoc => !!song);
	});

	const printEntries = $derived.by<SongbookPrintEntry[]>(() => {
		if (!printCategory) {
			return songs.map((song) => ({
				type: 'song',
				song,
				withBassTabs: song.showBassTabs ?? true
			}));
		}
		const byId = new Map(songs.map((song) => [song.id, song]));
		const order = printOrderForCategory(printCategory);
		return order
			.map((entry, index): SongbookPrintEntry | null => {
				if (entry.type === 'set') return { ...entry, label: setLabelForOrderIndex(order, index) };
				const song = byId.get(entry.songId);
				return song
					? { type: 'song' as const, song, withBassTabs: song.showBassTabs ?? true }
					: null;
			})
			.filter((entry): entry is SongbookPrintEntry => !!entry);
	});
</script>

<svelte:head><title>Sangbog · {BAND.name}</title></svelte:head>

<main class="songbook">
	<div class="songbook-chrome">
		<header class="page-head">
			<div class="page-brand">
				<img class="page-mark" src="/logo-mark.png?v=10" alt="" />
				<div>
					<h1 class="font-display text-2xl font-bold tracking-tight text-[var(--color-accent)]">
						{BAND.name}
					</h1>
					<p class="page-tagline">{BAND.name}s samlede sangbog</p>
				</div>
			</div>
			<div class="page-account">
				{#if authState.profile}
					<button
						type="button"
						class="profile-name-button"
						onclick={openProfileDialog}
						aria-label="Åbn profil og invitationer"
					>{authState.profile.displayName}</button>
					<button type="button" class="account-link" onclick={handleSignOut}>Log ud</button>
				{:else if !authState.loading}
					<a href="/login?next=/songbook" class="account-link">Log ind</a>
				{/if}
				{#if canEdit}
					<a href="/songbook/new" class="toolbar-add" aria-label="Tilføj ny sang">Tilføj</a>
					<button type="button" class="cat-manage" onclick={openCategoryEditor}>Kategorier</button>
				{/if}
			</div>
		</header>

		<div class="toolbar">
			<input
				class="toolbar-search"
				type="search"
				placeholder="Søg titel eller kunstner"
				bind:value={search}
				oninput={onSearchInput}
				aria-label="Søg i sangbogen"
			/>
			<div class="print-group">
				<CategoryPicker
					options={allCategoryNames.map((cat) => ({ value: cat, label: printOptionLabel(cat) }))}
					selected={printCategory ? [printCategory] : []}
					triggerLabel={printOptionLabel(printCategory)}
					triggerValue={printCategory}
					emptyOption={{ value: '', label: `Alle (${songs.length})` }}
					ariaLabel="Filtrér og vælg hvad der skal eksporteres som PDF"
					variant="joined"
					colorFor={colorForCategory}
					onToggle={pickPrintCategory}
				/>
				<button
					type="button"
					class="pdf-choice"
					class:is-busy={pdfBusy}
					onclick={handlePdfBook}
					disabled={printCount === 0 || pdfGenerating}
					aria-label={printCategory
						? `Lav akkord-PDF for kategorien ${printCategory}`
						: 'Lav akkord-PDF for hele sangbogen'}
					aria-busy={pdfBusy}
				>
					{#if pdfBusy}
						<span class="pdf-spinner" aria-hidden="true"></span>
					{:else}
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
					{/if}
					<span class="pdf-choice-label">{pdfBusy ? 'Bygger…' : 'Akkorder'}</span>
				</button>
				<button
					type="button"
					class="pdf-choice"
					class:is-busy={audiencePdfBusy}
					onclick={handleAudiencePdfBook}
					disabled={printCount === 0 || pdfGenerating}
					aria-label={printCategory
						? `Lav publikums-PDF for kategorien ${printCategory}`
						: 'Lav publikums-PDF for hele sangbogen'}
					aria-busy={audiencePdfBusy}
					title="Publikums-PDF uden akkorder"
				>
					{#if audiencePdfBusy}
						<span class="pdf-spinner" aria-hidden="true"></span>
					{:else}
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
					{/if}
					<span class="pdf-choice-label">{audiencePdfBusy ? 'Bygger…' : 'Tekster'}</span>
				</button>
			</div>
		</div>
	</div>

	{#if printCategory}
		{@const categoryMeta = categoryMetaMap[printCategory]}
		<section class="print-order-panel card mb-4">
			<div class="print-order-head">
				<div class="print-order-copy">
					<h2>{printCategory}</h2>
					{#if editingPrintOrder !== printCategory}
						<p class="print-order-summary">
							{songCountLabel(printSongs.length)}
							{#if countSetsForCategory(printCategory)}
								· {setCountLabel(countSetsForCategory(printCategory))}
							{/if}
						</p>
					{:else}
						<div
							class="print-set-palette"
							role="button"
							tabindex="0"
							draggable="true"
							ondragstart={(e) => onPrintDragStart(e, { kind: 'palette-set' })}
							ondragend={onPrintDragEnd}
							title="Træk ind i listen for at indsætte en ny tom sæt-side"
						>
							<span aria-hidden="true">+</span>
							Sæt
						</div>
					{/if}
				</div>
				<div class="print-order-actions">
					{#if canEdit}
						{#if editingPrintOrder === printCategory}
							<button
								type="button"
								class="panel-link"
								onclick={() => (editingPrintOrder = null)}
							>
								Færdig
							</button>
						{:else}
							<button
								type="button"
								class="panel-link"
								onclick={() => (editingPrintOrder = printCategory)}
							>
								Redigér rækkefølge
							</button>
						{/if}
						<button
							type="button"
							class="panel-link"
							onclick={() => openCategoryEditor(printCategory)}
						>
							Redigér kategori
						</button>
					{/if}
				</div>
				{#if categoryMeta?.imageUrl}
					<div class="print-order-image-wrap">
						<img class="print-order-image" src={categoryMeta.imageUrl} alt="" />
					</div>
				{/if}
			</div>
			{#if editingPrintOrder === printCategory}
				{@const currentPrintOrder = printOrderForCategory(printCategory)}
				<div
					class="print-order-edit-area"
					role="listbox"
					tabindex="0"
					ondragover={allowPrintOrderDrop}
					ondrop={onPrintOrderDrop}
				>
					<ol class="print-order-list">
						{#each currentPrintOrder as entry, index}
							{@const song = entry.type === 'song' ? songs.find((s) => s.id === entry.songId) : null}
							<li
								class:drop-before={printDropIndex === index}
								class:drop-after={printDropIndex === index + 1}
								ondragover={(e) => onPrintItemDragOver(e, index)}
							>
								<div
									class="print-order-item"
									class:print-order-item--set={entry.type === 'set'}
									role="button"
									tabindex="0"
									draggable="true"
									ondragstart={(e) => onPrintDragStart(e, { kind: 'print-entry', index })}
									ondragend={onPrintDragEnd}
								>
									<span class="print-order-handle" aria-hidden="true">⋮⋮</span>
									{#if entry.type === 'set'}
										<strong>{setLabelForOrderIndex(currentPrintOrder, index)}</strong>
										<button
											type="button"
											class="print-order-delete"
											aria-label="Fjern {setLabelForOrderIndex(currentPrintOrder, index)}"
											title="Fjern sæt"
											onclick={(e) => {
												e.stopPropagation();
												removeSetAt(index);
											}}
										>
											×
										</button>
									{:else if song}
										<strong>{song.title}</strong>
										{#if song.artist}<small>{song.artist}</small>{/if}
									{:else}
										<strong>Mangler sang</strong>
									{/if}
								</div>
							</li>
						{/each}
					</ol>
					<div
						class="print-order-end-drop"
						class:print-order-end-drop--active={printDropIndex === printOrderForCategory(printCategory).length}
						role="button"
						tabindex="0"
						ondragover={(e) => onPrintDragOver(e, printOrderForCategory(printCategory).length)}
					>
						Slip her for at placere sidst
					</div>
				</div>
			{/if}
		</section>
	{/if}

	<!-- Liste -->
	{#if loadingSongs}
		<div class="card p-8 text-center text-[var(--color-ink-muted)]">Henter sangbog…</div>
	{:else if error}
		<div class="card p-6">
			<p class="text-[var(--color-error)] font-semibold">Kunne ikke hente sange</p>
			<p class="mt-1 text-sm text-[var(--color-ink-muted)]">{error}</p>
		</div>
	{:else if filteredSongs.length === 0}
		<div class="card p-10 text-center">
			{#if songs.length === 0}
				<p class="text-lg font-semibold text-[var(--color-ink)]">Ingen sange endnu</p>
				{#if canEdit}
					<p class="mt-2 text-sm text-[var(--color-ink-muted)]">
						Klik på <span class="font-semibold">Tilføj sang</span> for at lægge den første sang i sangbogen.
					</p>
				{/if}
			{:else}
				<p class="text-[var(--color-ink-muted)]">Ingen sange matcher dit filter.</p>
			{/if}
		</div>
	{:else}
		<div class="song-alpha">
			{#each groupedSongs as group (group.letter)}
				<section class="letter-group" aria-labelledby={`letter-${group.letter}`}>
					<h2 class="letter-head" id={`letter-${group.letter}`}>{group.letter}</h2>
					<ul class="letter-list">
						{#each group.songs as song (song.id)}
							<li>
								<a href={`/song/${song.id}`} class="song-row">
									<span class="song-row-title">{song.title}</span>
									{#if song.artist}
										<span class="song-row-artist">{song.artist}</span>
									{/if}
									{#if song.key}
										<span class="song-row-key">{song.key}</span>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	{/if}

	{#if editingCategories}
		<CategoryMetaDialog
			categories={allCategoryNames}
			metaMap={categoryMetaMap}
			saving={categorySaving}
			uploading={categoryUploading}
			error={categoryError}
			onClose={() => {
				editingCategories = false;
				editingFocusCategory = '';
			}}
			initialCategory={editingFocusCategory}
			onAddCategory={addCategoryMeta}
			onRenameCategory={renameCategory}
			onDeleteCategory={deleteCategoryMeta}
			onSave={saveEditingCategory}
			onUploadImage={uploadEditingCategoryImage}
			onRemoveImage={removeEditingCategoryImage}
		/>
	{/if}

	{#if editingProfile && authState.profile}
		<ProfileDialog
			displayName={authState.profile.displayName}
			email={authState.profile.email}
			members={profileMembers}
			loadingMembers={profileLoading}
			saving={profileSaving}
			inviting={profileInviting}
			removingUid={profileRemovingUid}
			canRemoveMembers={canManageMembers}
			currentUserUid={authState.user?.uid}
			error={profileError}
			onClose={() => (editingProfile = false)}
			onSaveProfile={saveProfile}
			onInvite={inviteMember}
			onRemoveMember={removeMember}
		/>
	{/if}
</main>

<style>
	.profile-name-button {
		margin: 0;
		border: 0;
		background: transparent;
		color: var(--color-ink-on-dark);
		padding: 0;
		font: inherit;
		font-weight: 700;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: transparent;
		text-underline-offset: 0.18em;
		transition: color 120ms ease, text-decoration-color 120ms ease;
	}

	.profile-name-button:hover {
		color: var(--color-accent);
		text-decoration-color: currentColor;
	}

	.songbook {
		--pad: clamp(12px, 4vw, 24px);
		--gap: clamp(8px, 2.4vw, 16px);
		--ctrl-h: clamp(44px, 12vw, 48px);
		--type: clamp(16px, 4.2vw, 18px);
		--type-sm: clamp(13px, 3.4vw, 15px);
		--type-xs: clamp(12px, 3vw, 13px);
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: var(--gap);
		width: min(100%, 72rem);
		margin-inline: auto;
		padding: var(--pad);
		padding-bottom: calc(var(--pad) + 3.5rem);
	}
	.songbook-chrome {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--gap);
		position: sticky;
		top: 0;
		z-index: 20;
		margin-inline: calc(var(--pad) * -1);
		padding: var(--pad) var(--pad) var(--gap);
		background: var(--color-bg);
	}
	.page-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--gap);
		min-width: 0;
	}
	.page-brand {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: var(--gap);
		min-width: 0;
	}
	.page-mark {
		width: clamp(40px, 10vw, 60px);
		height: clamp(40px, 10vw, 60px);
		object-fit: contain;
	}
	.page-tagline {
		margin: 0.15rem 0 0;
		font-size: var(--type-xs);
		color: var(--color-ink-faint);
	}
	.page-account {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: max-content;
		align-items: center;
		justify-content: end;
		gap: var(--gap);
		min-width: 0;
	}
	.account-link {
		color: var(--color-ink-faint);
		font-size: var(--type-sm);
		line-height: 1.2;
		text-decoration: none;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
	}
	.account-link:hover {
		color: var(--color-ink-on-dark);
	}

	.toolbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--gap);
		min-width: 0;
	}
	.toolbar-add {
		display: grid;
		place-items: center;
		height: var(--ctrl-h);
		padding: 0 clamp(10px, 2.5vw, 14px);
		border-radius: var(--radius-button);
		background: var(--color-accent);
		color: #ffffff;
		font-size: var(--type-sm);
		font-weight: 600;
		white-space: nowrap;
		text-decoration: none;
	}
	.toolbar-add:hover {
		background: var(--color-accent-hover);
	}
	.toolbar-search {
		width: 100%;
		min-width: 0;
		height: var(--ctrl-h);
		padding: 0 clamp(10px, 2.8vw, 14px);
		border: 1px solid rgba(226, 232, 240, 0.16);
		border-radius: var(--radius-button);
		background: rgba(255, 255, 255, 0.92);
		color: var(--color-ink);
		font-size: 16px;
	}
	.toolbar-search::placeholder {
		color: var(--color-ink-faint);
	}
	.toolbar-search:focus {
		outline: 2px solid var(--color-accent);
		outline-offset: -1px;
	}

	.cat-manage {
		padding: 0;
		border: none;
		background: transparent;
		color: var(--color-ink-faint);
		font-size: var(--type-sm);
		font-weight: 500;
	}
	.cat-manage:hover {
		color: var(--color-ink-on-dark);
	}
	.print-order-panel {
		color: var(--color-ink);
		overflow: hidden;
		padding: 0;
	}
	.print-order-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: stretch;
	}
	.print-order-copy {
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: flex-start;
		gap: 0.2rem;
		padding: 0.7rem 0.85rem 0.7rem 1rem;
	}
	.print-order-copy h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.05rem;
	}
	.print-order-image-wrap {
		position: relative;
		height: 0;
		min-height: 100%;
		aspect-ratio: 1 / 1;
		overflow: hidden;
	}
	.print-order-image {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.print-order-edit-area {
		padding: 0 0.85rem 0.85rem;
	}
	.print-order-actions {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		justify-content: center;
		gap: 0.05rem;
		padding: 0.65rem 0.85rem;
	}
	.panel-link {
		padding: 0.08rem 0;
		border: none;
		background: transparent;
		color: var(--color-ink-faint);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		text-align: right;
		white-space: nowrap;
	}
	.panel-link:hover {
		color: var(--color-ink);
	}
	.print-set-palette,
	.print-order-item {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		border-radius: var(--radius-button);
		border: 1px solid var(--color-border-subtle);
		background: #ffffff;
		padding: 0.65rem 0.8rem;
		cursor: grab;
		user-select: none;
	}
	.print-set-palette {
		min-height: 2rem;
		margin-top: 0.25rem;
		padding: 0.35rem 0.75rem;
		border-style: dashed;
		background: var(--color-accent-soft);
		color: #92400e;
		font-size: 0.82rem;
		font-weight: 800;
	}
	.print-set-palette span {
		font-size: 0.95rem;
		line-height: 1;
	}
	.print-order-list {
		display: grid;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.print-order-list li {
		position: relative;
		transition: margin 150ms ease, transform 150ms ease, filter 150ms ease;
	}
	.print-order-list li.drop-before {
		margin-top: 1.15rem;
		transform: translateY(0.18rem);
	}
	.print-order-list li.drop-after {
		margin-bottom: 1.15rem;
		transform: translateY(-0.18rem);
	}
	.print-order-list li.drop-before .print-order-item,
	.print-order-list li.drop-after .print-order-item {
		filter: brightness(1.015);
		box-shadow:
			0 1px 0 rgba(255, 255, 255, 0.85) inset,
			0 10px 26px rgba(15, 23, 42, 0.14);
	}
	.print-order-item {
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.85) inset, 0 4px 14px rgba(15, 23, 42, 0.08);
	}
	.print-order-item--set {
		background: linear-gradient(135deg, #fff7ed, #fffbeb);
		border: 2px dashed #d97706;
		box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.18), 0 7px 18px rgba(146, 64, 14, 0.12);
	}
	.print-order-item--set .print-order-handle {
		color: #b45309;
	}
	.print-order-item--set strong {
		color: #92400e;
		font-family: var(--font-display);
		font-size: 1rem;
	}
	.print-order-handle {
		color: var(--color-ink-faint);
		font-weight: 900;
		letter-spacing: -0.16em;
	}
	.print-order-item strong {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.9rem;
	}
	.print-order-delete {
		margin-left: auto;
		display: inline-grid;
		place-items: center;
		width: 1.65rem;
		height: 1.65rem;
		border-radius: 999px;
		border: 1px solid rgba(180, 83, 9, 0.22);
		background: rgba(255, 255, 255, 0.78);
		color: #b45309;
		font-size: 1.1rem;
		font-weight: 800;
		line-height: 1;
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease, transform 120ms ease;
	}
	.print-order-delete:hover {
		background: #b45309;
		color: #ffffff;
		transform: scale(1.04);
	}
	.print-order-item small {
		color: var(--color-ink-faint);
		font-size: 0.75rem;
	}
	.print-order-summary {
		margin: 0;
		color: var(--color-ink-muted);
		font-size: 0.86rem;
	}
	.print-order-end-drop {
		margin-top: 0.5rem;
		border-radius: var(--radius-button);
		border: 1px dashed var(--color-border-subtle);
		padding: 0.55rem;
		color: var(--color-ink-faint);
		font-size: 0.78rem;
		text-align: center;
		transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
	}
	.print-order-end-drop--active {
		background: var(--color-accent-soft);
		border-color: var(--color-accent);
		color: #92400e;
	}
	.song-alpha {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: clamp(12px, 3vw, 20px);
		min-width: 0;
	}
	.letter-group {
		min-width: 0;
	}
	.letter-head {
		margin: 0 0 0.15rem;
		padding: 0.15rem 0;
		font-family: var(--font-display);
		font-size: var(--type-xs);
		font-weight: 700;
		color: var(--color-ink-faint);
	}
	.letter-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.song-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto auto;
		column-gap: clamp(8px, 2vw, 12px);
		align-items: baseline;
		padding: clamp(6px, 1.8vw, 10px) 0;
		border-bottom: 1px solid rgba(226, 232, 240, 0.08);
		color: inherit;
		text-decoration: none;
	}
	.song-row-title {
		grid-column: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-title);
		font-size: var(--type);
		color: var(--color-ink-on-dark);
	}
	.song-row-artist {
		grid-column: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--type-xs);
		color: var(--color-ink-faint);
	}
	.song-row-key {
		grid-column: 2;
		grid-row: 1 / span 2;
		align-self: center;
		font-size: var(--type-xs);
		font-weight: 600;
		color: var(--color-chord);
	}
	.song-row:hover .song-row-title {
		color: #ffffff;
	}
	.print-group {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		height: var(--ctrl-h);
		min-width: 0;
		position: relative;
		z-index: 2;
	}
	.print-group :global(.category-picker) {
		min-width: 0;
		width: 100%;
		height: 100%;
	}
	.print-group :global(.category-picker-trigger) {
		min-width: 0;
		max-width: none;
		width: 100%;
		height: 100%;
	}
	.pdf-choice {
		display: grid;
		grid-auto-flow: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		border: 1px solid var(--color-border-subtle);
		border-left: 0;
		background: rgba(255, 255, 255, 0.94);
		color: var(--color-ink);
		padding: 0 clamp(10px, 2.4vw, 14px);
		font-size: var(--type-sm);
		font-weight: 500;
		white-space: nowrap;
	}
	.print-icon {
		width: 0.82rem;
		height: 0.82rem;
		flex-shrink: 0;
	}
	.pdf-choice:hover {
		background: #f8fafc;
	}
	.pdf-choice.is-busy {
		background: #fffaf0;
		color: #92400e;
	}
	.pdf-choice:disabled {
		opacity: 0.72;
		cursor: not-allowed;
	}
	.pdf-spinner {
		width: 0.95rem;
		height: 0.95rem;
		border-radius: 999px;
		border: 2px solid rgba(146, 64, 14, 0.25);
		border-top-color: #92400e;
		animation: pdf-spin 0.8s linear infinite;
	}
	@keyframes pdf-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.print-group .pdf-choice {
		border-radius: 0 !important;
	}
	.print-group .pdf-choice:last-child {
		border-radius: 0 var(--radius-button) var(--radius-button) 0 !important;
	}

	@media (max-width: 47.99rem) {
		.page-brand {
			display: none;
		}
		.page-head {
			grid-template-columns: 1fr;
		}
		.page-account {
			justify-self: end;
		}
		.print-group :global(.category-picker-menu) {
			min-width: 100%;
			max-width: calc(100vw - 2 * var(--pad));
			right: 0;
			left: auto;
		}
		.print-order-head {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.print-order-image-wrap {
			display: none;
		}
	}

	@media (max-width: 22rem) {
		.pdf-choice-label {
			display: none;
		}
	}

	@media (orientation: landscape) and (max-height: 34rem) {
		.songbook {
			--pad: clamp(8px, 2vw, 16px);
			--ctrl-h: 44px;
		}
		.page-brand {
			display: none;
		}
		.toolbar {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
		}
		.song-alpha {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			column-gap: clamp(16px, 4vw, 32px);
		}
		.print-order-panel {
			display: none;
		}
	}

	@media (min-width: 48rem) {
		.toolbar {
			grid-template-columns: minmax(0, 1fr) minmax(18rem, 0.9fr);
		}
		.song-alpha {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			column-gap: clamp(24px, 4vw, 48px);
		}
	}

	@media (min-width: 72rem) {
		.song-alpha {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
</style>
