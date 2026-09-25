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

	$effect(() => {
		if (!authState.loading && !authState.user) goto('/login');
	});

	$effect(() => {
		if (!authState.user) return;
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
		if (!authState.user) return;
		const unsub = subscribeCategoryColors((colors) => (categoryColorMap = colors));
		return () => unsub();
	});
	$effect(() => {
		if (!authState.user) return;
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

	const recentCategories = $derived.by(() =>
		[...allCategoryNames]
			.sort((a, b) => categorySortTime(b) - categorySortTime(a))
			.slice(0, 3)
	);

	function categorySortTime(cat: string): number {
		return categoryMetaMap[cat]?.updatedAt ?? categoryMetaMap[cat]?.createdAt ?? 0;
	}

	const filteredSongs = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const filtered = songs.filter((s) => {
			if (activeCategory && !(s.categories ?? []).includes(activeCategory)) return false;
			if (!q) return true;
			return (
				s.title.toLowerCase().includes(q) ||
				(s.artist ?? '').toLowerCase().includes(q) ||
				(s.categories ?? []).some((c) => c.toLowerCase().includes(q))
			);
		});
		if (!activeCategory) return filtered;
		return sortSongsForCategory(activeCategory, filtered);
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
		goto('/login');
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

	function sortSongsForCategory(cat: string, input: SongDoc[]): SongDoc[] {
		const order = printOrderForCategory(cat)
			.filter((entry) => entry.type === 'song')
			.map((entry) => entry.songId);
		if (order.length === 0) return input;
		const position = new Map(order.map((id, index) => [id, index]));
		return [...input].sort((a, b) => {
			const aPos = position.get(a.id);
			const bPos = position.get(b.id);
			if (aPos != null && bPos != null) return aPos - bPos;
			if (aPos != null) return -1;
			if (bPos != null) return 1;
			return a.title.localeCompare(b.title, 'da');
		});
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

	function selectSongbookCategory(cat: string | null): void {
		selectPrintCategory(cat ?? '');
	}

	function pickPrintCategory(cat: string): void {
		if (cat && cat === printCategory) {
			selectPrintCategory('');
			return;
		}
		selectPrintCategory(cat);
	}

	function printOptionLabel(cat: string): string {
		if (!cat) return `Hele sangbogen (${songs.length})`;
		const count = songs.filter((s) => (s.categories ?? []).includes(cat)).length;
		const sets = countSetsForCategory(cat);
		return `${cat} (${songCountLabel(count)}${sets ? `, ${setCountLabel(sets)}` : ''})`;
	}

	function categorySortKey(cat: string): string {
		return cat.toLowerCase();
	}

	function highlightedCategoryForSong(song: SongDoc): string | null {
		const songCategories = song.categories ?? [];
		if (activeCategory && songCategories.includes(activeCategory)) return activeCategory;
		const q = search.trim().toLowerCase();
		if (!q) return null;
		return songCategories.find((cat) => cat.toLowerCase().includes(q)) ?? null;
	}

	function displayCategoriesForSong(song: SongDoc): string[] {
		const songCategories = [...(song.categories ?? [])];
		const highlighted = highlightedCategoryForSong(song);
		return songCategories.sort((a, b) => {
			if (a === highlighted) return -1;
			if (b === highlighted) return 1;
			return categorySortKey(a).localeCompare(categorySortKey(b), 'da');
		});
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

<main class="mx-auto max-w-6xl px-6 py-5">
	<header class="page-head">
		<div class="page-brand">
			<img class="page-mark" src="/logo-mark.png?v=5" alt="" />
			<div>
				<h1 class="font-display text-2xl font-bold tracking-tight text-[var(--color-accent)]">
					{BAND.name}
				</h1>
				<p class="page-tagline">{BAND.name}s samlede sangbog</p>
			</div>
		</div>
		{#if authState.profile}
			<div class="flex items-center gap-3 text-sm">
				<span class="text-[var(--color-ink-faint)]">
					Logget ind som
					<button
						type="button"
						class="profile-name-button"
						onclick={openProfileDialog}
						aria-label="Åbn profil og invitationer"
						>{authState.profile.displayName}</button
					>
				</span>
				<button class="btn-ghost" onclick={handleSignOut}>Log ud</button>
			</div>
		{/if}
	</header>

	<div class="toolbar">
		<input
			class="toolbar-search"
			type="search"
			placeholder="Søg titel, kunstner eller kategori"
			bind:value={search}
			oninput={onSearchInput}
			aria-label="Søg i sangbogen"
		/>
		<div class="toolbar-actions">
			<a href="/songbook/new" class="toolbar-add" aria-label="Tilføj ny sang">Tilføj sang</a>
			<div class="print-group">
			<CategoryPicker
				options={allCategoryNames.map((cat) => ({ value: cat, label: printOptionLabel(cat) }))}
				selected={printCategory ? [printCategory] : []}
				triggerLabel={printOptionLabel(printCategory)}
				triggerValue={printCategory}
				emptyOption={{ value: '', label: `Hele sangbogen (${songs.length})` }}
				ariaLabel="Vælg hvad der skal eksporteres som PDF"
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
				<span>{pdfBusy ? 'Bygger…' : 'Akkorder'}</span>
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
				<span>{audiencePdfBusy ? 'Bygger…' : 'Tekster'}</span>
			</button>
			</div>
		</div>
	</div>

	<div class="cat-row">
		<button
			type="button"
			class="cat-chip"
			class:active={activeCategory === null}
			onclick={() => selectSongbookCategory(null)}
		>
			Alle ({songs.length})
		</button>
		{#each recentCategories as cat (cat)}
			{@const count = songs.filter((s) => (s.categories ?? []).includes(cat)).length}
			{@const setCount = countSetsForCategory(cat)}
			{@const c = colorForCategory(cat)}
			<button
				type="button"
				class="cat-chip"
				class:active={activeCategory === cat}
				style:--chip-bg={c.bg}
				style:--chip-text={c.text}
				style:--chip-border={c.border}
				onclick={() => selectSongbookCategory(cat)}
			>
				{cat} ({songCountLabel(count)}{setCount ? `, ${setCountLabel(setCount)}` : ''})
			</button>
		{/each}
		<button type="button" class="cat-manage" onclick={openCategoryEditor}>
			Redigér kategorier
		</button>
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
				<p class="mt-2 text-sm text-[var(--color-ink-muted)]">
					Klik på <span class="font-semibold">Tilføj sang</span> for at lægge den første sang i sangbogen.
				</p>
			{:else}
				<p class="text-[var(--color-ink-muted)]">Ingen sange matcher dit filter.</p>
			{/if}
		</div>
	{:else}
		<ul class="song-grid">
			{#each filteredSongs as song (song.id)}
				<li>
					<div class="song-card card">
						<a href={`/song/${song.id}`} class="song-card-main">
						<div class="song-card-top">
							<h3 class="song-card-title">{song.title}</h3>
							{#if song.key}
								<span class="song-key">{song.key}</span>
							{/if}
						</div>
						</a>
						{#if song.artist || (song.categories ?? []).length > 0}
							<div class="song-card-sub">
								{#if song.artist}
									<a href={`/song/${song.id}`} class="song-card-artist">{song.artist}</a>
								{/if}
								{#if (song.categories ?? []).length > 0}
									<div class="song-card-categories" aria-label={`Kategorier for ${song.title}`}>
										{#each displayCategoriesForSong(song) as cat (cat)}
											{@const c = colorForCategory(cat)}
											<button
												type="button"
												class="cat-pill"
												class:highlighted={cat === highlightedCategoryForSong(song)}
												style:--cat-color={c.text}
												onclick={() => selectSongbookCategory(cat)}
											>
												<span class="cat-mark" aria-hidden="true"></span>
												{cat}
											</button>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
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

	.page-head {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		justify-content: space-between;
		gap: 0.75rem 1.25rem;
		margin-bottom: 1rem;
	}
	.page-brand {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}
	.page-mark {
		width: 3.75rem;
		height: 3.75rem;
		object-fit: contain;
		flex: 0 0 auto;
	}
	.page-tagline {
		margin: 0.15rem 0 0;
		font-size: 0.78rem;
		color: var(--color-ink-faint);
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: 0.55rem;
		margin-bottom: 0.85rem;
	}
	.toolbar-actions {
		display: flex;
		align-items: stretch;
		gap: 0.5rem;
		flex: 0 0 auto;
	}
	.toolbar-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		height: 2.35rem;
		padding: 0 0.95rem;
		border-radius: var(--radius-button);
		background: var(--color-accent);
		color: #ffffff;
		font-size: 0.82rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
		text-decoration: none;
	}
	.toolbar-add:hover {
		background: var(--color-accent-hover);
	}
	.toolbar-search {
		flex: 1 1 16rem;
		min-width: 12rem;
		height: 2.35rem;
		padding: 0 0.85rem;
		border: 1px solid rgba(226, 232, 240, 0.16);
		border-radius: var(--radius-button);
		background: rgba(255, 255, 255, 0.92);
		color: var(--color-ink);
		font-size: 0.88rem;
	}
	.toolbar-search::placeholder {
		color: var(--color-ink-faint);
	}
	.toolbar-search:focus {
		outline: 2px solid var(--color-accent);
		outline-offset: -1px;
	}

	.cat-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem 0.4rem;
		margin-bottom: 0.9rem;
	}
	.cat-chip {
		padding: 0.22rem 0.62rem;
		border-radius: var(--radius-card);
		border: 1px solid var(--chip-border, var(--color-border));
		background: var(--chip-bg, rgba(255, 255, 255, 0.04));
		color: var(--chip-text, var(--color-ink-on-dark));
		font-size: 0.75rem;
		font-weight: 600;
	}
	.cat-chip:hover {
		filter: brightness(0.96);
	}
	.cat-chip.active {
		background: var(--color-accent);
		color: #ffffff;
		border-color: var(--color-accent);
	}
	.cat-manage {
		padding: 0.22rem 0.55rem;
		border: none;
		background: transparent;
		color: var(--color-ink-faint);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.06em;
		text-transform: uppercase;
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
	.song-grid {
		display: grid;
		gap: 0.5rem;
		grid-template-columns: 1fr;
	}
	@media (min-width: 40rem) {
		.song-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (min-width: 64rem) {
		.song-grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	.song-card {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
		min-height: 5.75rem;
		padding: 0.7rem 0.8rem 0.65rem;
		border-radius: var(--radius-card);
	}
	.song-card-main {
		display: block;
		color: inherit;
		text-decoration: none;
		min-width: 0;
	}
	.song-card-top {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.song-card-title {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-title);
		font-size: 0.98rem;
		font-weight: 400;
		letter-spacing: -0.02em;
		color: var(--color-ink);
		min-width: 0;
	}
	.song-card-artist {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.78rem;
		color: var(--color-ink-muted);
		text-decoration: none;
		min-width: 0;
		flex: 0 1 auto;
	}
	.song-card-artist:hover {
		color: var(--color-ink);
	}
	.song-card-sub {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
		margin-top: auto;
	}
	.song-key {
		flex-shrink: 0;
		padding-top: 0.12rem;
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--color-chord);
	}
	.song-card:hover {
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.9) inset, 0 8px 22px rgba(15, 23, 42, 0.22);
	}
	.cat-mark {
		width: 0.2rem;
		height: 0.2rem;
		border-radius: 50%;
		background: currentColor;
		flex-shrink: 0;
	}
	.cat-pill {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--cat-color, var(--color-ink-muted));
		font-size: 0.72rem;
		line-height: 1.25;
		font-weight: 400;
		white-space: nowrap;
	}
	button.cat-pill {
		cursor: pointer;
	}
	button.cat-pill:hover {
		text-decoration: underline;
		text-underline-offset: 0.16em;
	}
	.cat-pill.highlighted {
		font-weight: 500;
	}
	.song-card-categories {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
		flex: 1 1 auto;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: thin;
		overscroll-behavior-x: contain;
	}
	.song-card-categories::-webkit-scrollbar {
		height: 3px;
	}
	.song-card-categories::-webkit-scrollbar-thumb {
		background: color-mix(in srgb, var(--color-ink-faint) 45%, transparent);
		border-radius: 999px;
	}
	.print-group {
		display: inline-flex;
		align-items: stretch;
		flex: 0 0 auto;
		height: 2.35rem;
		position: relative;
		z-index: 2;
	}
	.pdf-choice {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		border: 1px solid var(--color-border-subtle);
		border-left: 0;
		background: rgba(255, 255, 255, 0.94);
		color: var(--color-ink);
		padding: 0 0.85rem;
		font-size: 0.82rem;
		font-weight: 500;
		letter-spacing: 0.01em;
		min-width: 6.1rem;
		transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
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
</style>
