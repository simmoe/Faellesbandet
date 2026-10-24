/** Readable Danish titles: "Hit Me Baby · 24. oktober 2026". */
export function recordingTitle(songTitle: string, at: Date, existing: string[]): string {
	const name = songTitle.trim() || 'Uden titel';
	const date = at.toLocaleDateString('da-DK', {
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	});
	const base = `${name} · ${date}`;
	if (!existing.includes(base)) return base;
	const time = at.toLocaleTimeString('da-DK', { hour: 'numeric', minute: '2-digit' });
	return `${base}, kl. ${time}`;
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, '0')}`;
}
