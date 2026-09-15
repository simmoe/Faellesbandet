export const SONGBOOK_SESSION_SELECTION_KEY = 'faellesbandet.songbook.session-selection';

export function persistSongbookCategory(cat: string): void {
	sessionStorage.setItem(
		SONGBOOK_SESSION_SELECTION_KEY,
		JSON.stringify({ activeCategory: cat, printCategory: cat })
	);
}
