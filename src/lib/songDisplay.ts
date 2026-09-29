export interface SongDisplayFlags {
	showBassTabs: boolean;
	columnLayout: boolean;
	fitSinglePage: boolean;
}

function storageKey(songId: string): string {
	return `faellesbandet.song-display.${songId}`;
}

export function readSongDisplayFlags(songId: string): SongDisplayFlags | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(storageKey(songId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<SongDisplayFlags>;
		const columnLayout = parsed.columnLayout === true;
		return {
			columnLayout,
			fitSinglePage: parsed.fitSinglePage !== false,
			showBassTabs: columnLayout ? false : parsed.showBassTabs !== false
		};
	} catch {
		return null;
	}
}

export function writeSongDisplayFlags(songId: string, flags: SongDisplayFlags): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(
			storageKey(songId),
			JSON.stringify({
				columnLayout: flags.columnLayout,
				fitSinglePage: flags.fitSinglePage,
				showBassTabs: flags.columnLayout ? false : flags.showBassTabs
			})
		);
	} catch {
		// Private mode / quota — keep the in-memory toggle.
	}
}
