export const songRecordBar = $state({
	active: false,
	phase: 'idle' as 'idle' | 'recording' | 'busy',
	elapsedLabel: '0:00',
	level: 0,
	error: null as string | null,
	toggle: () => {}
});
