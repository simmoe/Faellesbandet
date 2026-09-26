/** Play-baren lever i root-layout, så `position: fixed` aldrig fanges af sang-CSS. */
export const songPlayBar = $state({
	active: false,
	playing: false,
	speedLabel: '1',
	start: () => {},
	slower: () => {},
	faster: () => {}
});
