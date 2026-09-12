import { relocateSection, sectionDropIsNoOp, type RelocateSectionResult } from './sectionReorder';
import type { Row } from './songParse';
import type { BassLines } from './types';

function header(text: string): Row {
	return { kind: 'header', text };
}
function chord(text: string): Row {
	return { kind: 'chord', text };
}
function lyric(text: string): Row {
	return { kind: 'lyric', text };
}

const sampleRows: Row[] = [
	header('Verse 1'),
	chord('C | G'),
	lyric('hello'),
	header('Chorus'),
	chord('Am | F'),
	lyric('sing'),
	header('Verse 2'),
	chord('C | G'),
	lyric('again')
];

const sampleBass: BassLines = {
	'1': '| C G |',
	'4': '| A F |',
	'7': '| C G |'
};

function labels(result: RelocateSectionResult): string[] {
	return result.rows.filter((r) => r.kind === 'header').map((r) => r.text);
}

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

function equal(actual: unknown, expected: unknown, msg: string) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	assert(a === b, `${msg}\n  expected ${b}\n  actual   ${a}`);
}

let passed = 0;

function test(name: string, fn: () => void) {
	fn();
	passed += 1;
	console.log(`ok  ${name}`);
}

test('move later section before earlier section', () => {
	const result = relocateSection({
		rows: sampleRows,
		bassLines: sampleBass,
		collapsedSections: [],
		sourceHeaderIdx: 2,
		targetHeaderIdx: 0,
		place: 'before',
		mode: 'move'
	});
	assert(result, 'expected result');
	equal(labels(result), ['Verse 2', 'Verse 1', 'Chorus'], 'section order');
	equal(result.rows[1], chord('C | G'), 'moved body follows header');
	equal(result.bassLines['1'], '| C G |', 'moved bass follows Verse 2');
	equal(result.bassLines['4'], '| C G |', 'Verse 1 bass shifted');
	equal(result.bassLines['7'], '| A F |', 'Chorus bass shifted');
});

test('move earlier section after later section', () => {
	const result = relocateSection({
		rows: sampleRows,
		bassLines: sampleBass,
		collapsedSections: [],
		sourceHeaderIdx: 0,
		targetHeaderIdx: 1,
		place: 'after',
		mode: 'move'
	});
	assert(result, 'expected result');
	equal(labels(result), ['Chorus', 'Verse 1', 'Verse 2'], 'section order');
	equal(result.rows[1], chord('Am | F'), 'chorus body stays first');
	equal(result.bassLines['1'], '| A F |', 'chorus bass now first');
	equal(result.bassLines['4'], '| C G |', 'verse 1 bass after chorus');
});

test('move onto next section before is a no-op', () => {
	assert(
		sectionDropIsNoOp(sampleRows, 0, 1, 'before', 'move'),
		'inserting Verse 1 before Chorus is already its position'
	);
	const result = relocateSection({
		rows: sampleRows,
		bassLines: sampleBass,
		collapsedSections: [],
		sourceHeaderIdx: 0,
		targetHeaderIdx: 1,
		place: 'before',
		mode: 'move'
	});
	assert(result === null, 'move before next section should be null');
});

test('copy with Alt inserts a duplicate after the target', () => {
	const result = relocateSection({
		rows: sampleRows,
		bassLines: sampleBass,
		collapsedSections: [1],
		sourceHeaderIdx: 1,
		targetHeaderIdx: 2,
		place: 'after',
		mode: 'copy'
	});
	assert(result, 'expected result');
	equal(labels(result), ['Verse 1', 'Chorus', 'Verse 2', 'Chorus'], 'copied chorus to end');
	equal(result.rows.length, 12, 'three extra rows copied');
	equal(result.bassLines['1'], '| C G |', 'original verse bass stays');
	equal(result.bassLines['4'], '| A F |', 'original chorus bass stays');
	equal(result.bassLines['10'], '| A F |', 'copied chorus bass');
	equal(result.collapsedSections, [1, 3], 'collapsed follows original and copy');
});

test('copy before self duplicates the formstykke in place', () => {
	const result = relocateSection({
		rows: sampleRows,
		bassLines: sampleBass,
		collapsedSections: [],
		sourceHeaderIdx: 1,
		targetHeaderIdx: 1,
		place: 'before',
		mode: 'copy'
	});
	assert(result, 'expected result');
	equal(labels(result), ['Verse 1', 'Chorus', 'Chorus', 'Verse 2'], 'duplicate chorus');
	equal(result.rows[4], chord('Am | F'), 'copied chords');
	equal(result.bassLines['4'], '| A F |', 'copy bass');
	equal(result.bassLines['7'], '| A F |', 'original chorus bass shifted');
});

test('copy is never treated as a no-op, even on self', () => {
	assert(!sectionDropIsNoOp(sampleRows, 1, 1, 'after', 'copy'), 'copy after self is allowed');
});

test('copy before an earlier section shifts source bass down', () => {
	const result = relocateSection({
		rows: sampleRows,
		bassLines: sampleBass,
		collapsedSections: [],
		sourceHeaderIdx: 2,
		targetHeaderIdx: 0,
		place: 'before',
		mode: 'copy'
	});
	assert(result, 'expected result');
	equal(labels(result), ['Verse 2', 'Verse 1', 'Chorus', 'Verse 2'], 'copied Verse 2 to top');
	equal(result.bassLines['1'], '| C G |', 'copied Verse 2 bass at top');
	equal(result.bassLines['4'], '| C G |', 'original Verse 1 bass shifted');
	equal(result.bassLines['10'], '| C G |', 'original Verse 2 bass shifted');
});

test('move remaps collapsed indices by identity, not label', () => {
	const result = relocateSection({
		rows: sampleRows,
		bassLines: sampleBass,
		collapsedSections: [0, 2],
		sourceHeaderIdx: 2,
		targetHeaderIdx: 0,
		place: 'before',
		mode: 'move'
	});
	assert(result, 'expected result');
	equal(result.collapsedSections, [0, 1], 'Verse 2 (now 0) and Verse 1 (now 1) stay collapsed');
});

console.log(`\n${passed} tests passed`);
