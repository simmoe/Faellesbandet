import { normalizeBassLine } from './migrate';
import { buildSections, type Row } from './songParse';
import type { BassLines, CollapsedSections } from './types';

export type SectionRelocateMode = 'move' | 'copy';
export type SectionDropPlace = 'before' | 'after';

export interface RelocateSectionInput {
	rows: Row[];
	bassLines: BassLines;
	collapsedSections: CollapsedSections;
	sourceHeaderIdx: number;
	targetHeaderIdx: number;
	place: SectionDropPlace;
	mode: SectionRelocateMode;
}

export interface RelocateSectionResult {
	rows: Row[];
	bassLines: BassLines;
	collapsedSections: CollapsedSections;
}

function cloneRow(row: Row): Row {
	return { ...row } as Row;
}

function insertRowIndex(
	rows: Row[],
	targetHeaderIdx: number,
	place: SectionDropPlace
): number | null {
	const sections = buildSections(rows);
	const target = sections[targetHeaderIdx];
	if (!target) return null;
	return place === 'before' ? target.headerRowIdx : target.bodyEnd;
}

function remapBassLines(args: {
	bassLines: BassLines;
	sourceStart: number;
	sourceEnd: number;
	insertAt: number;
	mode: SectionRelocateMode;
}): BassLines {
	const { bassLines, sourceStart, sourceEnd, insertAt, mode } = args;
	const len = sourceEnd - sourceStart;
	const out: BassLines = {};

	if (mode === 'move') {
		for (const [k, v] of Object.entries(bassLines)) {
			const oldIdx = Number(k);
			if (!Number.isFinite(oldIdx)) continue;
			let newIdx: number;
			if (oldIdx >= sourceStart && oldIdx < sourceEnd) {
				newIdx = insertAt + (oldIdx - sourceStart);
			} else {
				newIdx = oldIdx;
				if (oldIdx >= sourceEnd) newIdx -= len;
				if (newIdx >= insertAt) newIdx += len;
			}
			out[String(newIdx)] = normalizeBassLine(v);
		}
		return out;
	}

	for (const [k, v] of Object.entries(bassLines)) {
		const oldIdx = Number(k);
		if (!Number.isFinite(oldIdx)) continue;
		const newIdx = oldIdx >= insertAt ? oldIdx + len : oldIdx;
		out[String(newIdx)] = normalizeBassLine(v);
	}
	for (let i = 0; i < len; i++) {
		const src = bassLines[String(sourceStart + i)];
		if (src) out[String(insertAt + i)] = normalizeBassLine(src);
	}
	return out;
}

function remapCollapsed(args: {
	collapsedSections: CollapsedSections;
	rows: Row[];
	nextRows: Row[];
	sourceHeaderIdx: number;
	sourceStart: number;
	sourceEnd: number;
	insertAt: number;
	mode: SectionRelocateMode;
}): CollapsedSections {
	const {
		collapsedSections,
		rows,
		nextRows,
		sourceHeaderIdx,
		sourceStart,
		sourceEnd,
		insertAt,
		mode
	} = args;
	const sections = buildSections(rows);
	const nextSections = buildSections(nextRows);
	const len = sourceEnd - sourceStart;
	const collapsedOldRows = collapsedSections
		.map((idx) => sections[idx]?.headerRowIdx)
		.filter((idx): idx is number => idx !== undefined);

	const mapped = new Set<number>();
	if (mode === 'move') {
		for (const oldRow of collapsedOldRows) {
			let newRow: number;
			if (oldRow >= sourceStart && oldRow < sourceEnd) {
				newRow = insertAt + (oldRow - sourceStart);
			} else {
				newRow = oldRow;
				if (oldRow >= sourceEnd) newRow -= len;
				if (newRow >= insertAt) newRow += len;
			}
			mapped.add(newRow);
		}
	} else {
		for (const oldRow of collapsedOldRows) {
			mapped.add(oldRow >= insertAt ? oldRow + len : oldRow);
		}
		if (collapsedSections.includes(sourceHeaderIdx)) {
			mapped.add(insertAt);
		}
	}

	return nextSections
		.map((section, idx) => (mapped.has(section.headerRowIdx) ? idx : -1))
		.filter((idx) => idx >= 0);
}

/**
 * Flyt eller kopiér et helt formstykke (header + body) til før/efter et andet.
 * Returnerer `null` hvis indekser er ugyldige, eller flytningen er en no-op.
 */
export function relocateSection(input: RelocateSectionInput): RelocateSectionResult | null {
	const { rows, bassLines, collapsedSections, sourceHeaderIdx, targetHeaderIdx, place, mode } =
		input;
	const sections = buildSections(rows);
	const source = sections[sourceHeaderIdx];
	if (!source) return null;

	const insertAtOriginal = insertRowIndex(rows, targetHeaderIdx, place);
	if (insertAtOriginal === null) return null;

	const sourceStart = source.headerRowIdx;
	const sourceEnd = source.bodyEnd;
	const chunk = rows.slice(sourceStart, sourceEnd).map(cloneRow);
	if (chunk.length === 0) return null;

	let insertAt = insertAtOriginal;
	let nextRows: Row[];

	if (mode === 'move') {
		if (insertAt === sourceStart || insertAt === sourceEnd) return null;
		const withoutSource = [...rows.slice(0, sourceStart), ...rows.slice(sourceEnd)];
		if (sourceStart < insertAt) insertAt -= chunk.length;
		nextRows = [...withoutSource.slice(0, insertAt), ...chunk, ...withoutSource.slice(insertAt)];
	} else {
		nextRows = [...rows.slice(0, insertAt), ...chunk, ...rows.slice(insertAt)];
	}

	return {
		rows: nextRows,
		bassLines: remapBassLines({
			bassLines,
			sourceStart,
			sourceEnd,
			insertAt,
			mode
		}),
		collapsedSections: remapCollapsed({
			collapsedSections,
			rows,
			nextRows,
			sourceHeaderIdx,
			sourceStart,
			sourceEnd,
			insertAt,
			mode
		})
	};
}

export function sectionDropIsNoOp(
	rows: Row[],
	sourceHeaderIdx: number,
	targetHeaderIdx: number,
	place: SectionDropPlace,
	mode: SectionRelocateMode
): boolean {
	if (mode === 'copy') return false;
	const sections = buildSections(rows);
	const source = sections[sourceHeaderIdx];
	const target = sections[targetHeaderIdx];
	if (!source || !target) return true;
	const insertAt = place === 'before' ? target.headerRowIdx : target.bodyEnd;
	return insertAt === source.headerRowIdx || insertAt === source.bodyEnd;
}
