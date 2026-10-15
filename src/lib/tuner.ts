export const GUITAR_STRINGS = [
	{ id: 'E2', letter: 'E', hz: 82.40689 },
	{ id: 'A2', letter: 'A', hz: 110 },
	{ id: 'D3', letter: 'D', hz: 146.8324 },
	{ id: 'G3', letter: 'G', hz: 196 },
	{ id: 'B3', letter: 'B', hz: 246.9417 },
	{ id: 'E4', letter: 'e', hz: 329.6276 }
] as const;

export type GuitarString = (typeof GUITAR_STRINGS)[number];

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export type DetectedPitch = {
	hz: number;
	name: string;
	cents: number;
	stringId: GuitarString['id'] | null;
};

export function hzToPitch(hz: number): DetectedPitch {
	const midi = 69 + 12 * Math.log2(hz / 440);
	const rounded = Math.round(midi);
	const cents = (midi - rounded) * 100;
	const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
	let stringId: GuitarString['id'] | null = null;
	let best = Infinity;
	for (const string of GUITAR_STRINGS) {
		const diff = Math.abs(1200 * Math.log2(hz / string.hz));
		if (diff < best) {
			best = diff;
			stringId = string.id;
		}
	}
	if (best > 50) stringId = null;
	return { hz, name, cents, stringId };
}

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
