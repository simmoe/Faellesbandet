<script lang="ts">
	/**
	 * Contenteditable chord-grid editor (WYSIWYG).
	 *
	 * - Venstre side: chord-rækkens `text` er literal pipe-notation
	 *   (fx `C | F | G | Am`). Vises præcis som skrevet.
	 * - Højre side: `bassLines[rowIdx]` er literal pipe-notation. Hvis
	 *   ikke sat, er højre celle tom. Aldrig auto-deriveret.
	 * - Begge sider rendres via samme `renderBarLine` for visuel symmetri.
	 * - Ingen cross-talk: redigering på den ene side ændrer aldrig den
	 *   anden, og drag-and-drop fungerer kun inden for samme side.
	 */
	import {
		buildSections,
		findPreviousSameType,
		parseRows,
		type Row
	} from '$lib/songParse';
	import {
		cleanSectionHeader,
		normalizeAccidentals,
		renderBarLine
	} from '$lib/chordFormatter';
	import { normalizeBassLine } from '$lib/migrate';
	import {
		relocateSection,
		sectionDropIsNoOp,
		type SectionDropPlace,
		type SectionRelocateMode
	} from '$lib/sectionReorder';
	import type { BassLines, CollapsedSections } from '$lib/types';
	import { tick } from 'svelte';

	interface Props {
		rows: Row[];
		barsPerLine: 2 | 4 | 8;
		bassLines?: BassLines;
		collapsedSections?: CollapsedSections;
		readOnly?: boolean;
		onRowsChange?: (next: Row[]) => void;
		onBassLinesChange?: (next: BassLines) => void;
		onCollapsedSectionsChange?: (next: CollapsedSections) => void;
	}

	let {
		rows: rowsProp,
		bassLines = {},
		collapsedSections = [],
		readOnly = false,
		onRowsChange,
		onBassLinesChange,
		onCollapsedSectionsChange
	}: Props = $props();

	let rows = $state<Row[]>([]);
	let lastEmitted = $state<Row[] | null>(null);

	$effect(() => {
		if (rowsProp === lastEmitted) return;
		// Eksternt opdaterede rows (fx transponer-knap, første load eller
		// undo). Adopter kun hvis brugeren ikke aktivt skriver, så vi ikke
		// overskriver in-flight contenteditable-input.
		if (
			document.activeElement &&
			(document.activeElement as HTMLElement).closest?.('.editable-song')
		) {
			return;
		}
		rows = rowsProp;
	});

	// ──────────────────────────────────────────────────────────────────────
	// Undo (Cmd/Ctrl+Z) — coalesces typing-bursts til ét trin pr. 400ms.
	// ──────────────────────────────────────────────────────────────────────
	type Snapshot = { rows: Row[]; bassLines: BassLines };
	const MAX_UNDO = 100;
	let undoStack: Snapshot[] = [];
	let lastSnapshotTime = 0;

	function pushUndo(rs: Row[], bl: BassLines) {
		const now = Date.now();
		if (now - lastSnapshotTime < 400 && undoStack.length > 0) return;
		undoStack.push({ rows: rs.map((r) => ({ ...r }) as Row), bassLines: { ...bl } });
		if (undoStack.length > MAX_UNDO) undoStack.shift();
		lastSnapshotTime = now;
	}

	function undo() {
		const snap = undoStack.pop();
		if (!snap) return;
		(document.activeElement as HTMLElement | null)?.blur?.();
		rows = snap.rows;
		lastEmitted = snap.rows;
		lastSnapshotTime = 0;
		onRowsChange?.(snap.rows);
		onBassLinesChange?.(snap.bassLines);
	}

	function emit(nextRows: Row[]) {
		pushUndo(rows, bassLines);
		rows = nextRows;
		lastEmitted = nextRows;
		onRowsChange?.(nextRows);
	}

	// ──────────────────────────────────────────────────────────────────────
	// Sektioner (verse/chorus/…)
	// ──────────────────────────────────────────────────────────────────────
	const sections = $derived(buildSections(rows));
	const collapsedSet = $derived(new Set(collapsedSections));
	const unlabeledRowIdxs = $derived.by(() => {
		const end = sections[0]?.headerRowIdx ?? rows.length;
		if (end <= 0) return [] as number[];
		return Array.from({ length: end }, (_, i) => i);
	});
	const isPristineSong = $derived.by(() => {
		if (readOnly || rows.length > 1) return false;
		if (rows.length === 0) return true;
		const r = rows[0];
		return r.kind === 'blank' || r.text.trim() === '';
	});
	const rowToHeaderIdx = $derived.by(() => {
		const map = new Array<number>(rows.length).fill(-1);
		for (const s of sections) {
			for (let i = s.bodyStart; i < s.bodyEnd; i++) map[i] = s.headerIdx;
		}
		return map;
	});

	function toggleSectionCollapsed(headerIdx: number) {
		if (!onCollapsedSectionsChange) return;
		const set = new Set(collapsedSections);
		if (set.has(headerIdx)) set.delete(headerIdx);
		else set.add(headerIdx);
		onCollapsedSectionsChange([...set].sort((a, b) => a - b));
	}

	// ──────────────────────────────────────────────────────────────────────
	// Row-keyed `bassLines` skal følge med når rækker indsættes/slettes.
	// Helpers: shift keys ≥ idx ±delta, eller drop keys i et interval.
	// ──────────────────────────────────────────────────────────────────────
	function shiftBassLines(start: number, delta: number, dropRange?: [number, number]) {
		const out: BassLines = {};
		for (const [k, v] of Object.entries(bassLines)) {
			const r = Number(k);
			if (!Number.isFinite(r)) continue;
			if (dropRange && r >= dropRange[0] && r < dropRange[1]) continue;
			const newR = r >= start ? r + delta : r;
			out[String(newR)] = normalizeBassLine(v);
		}
		if (JSON.stringify(out) !== JSON.stringify(bassLines)) emitBassLines(out);
	}

	function emitBassLines(next: BassLines) {
		bassLines = next;
		onBassLinesChange?.(next);
	}

	function sectionIsEmpty(headerIdx: number): boolean {
		const s = sections[headerIdx];
		if (!s) return false;
		if (rowPlainText(rows[s.headerRowIdx]).trim() !== '') return false;
		for (let i = s.bodyStart; i < s.bodyEnd; i++) {
			const r = rows[i];
			if (!r || r.kind === 'blank') continue;
			if (r.kind === 'header') continue;
			if (r.text.trim() !== '') return false;
		}
		return true;
	}

	function deleteSection(headerIdx: number, focusPrev = false) {
		const cur = sections[headerIdx];
		if (!cur) return;
		const start = cur.headerRowIdx;
		const end = cur.bodyEnd;
		const removed = end - start;
		if (removed <= 0) return;
		const focusAt = Math.max(0, start - 1);
		(document.activeElement as HTMLElement | null)?.blur?.();

		emit([...rows.slice(0, start), ...rows.slice(end)]);
		shiftBassLines(end, -removed, [start, end]);
		if (onCollapsedSectionsChange) {
			const v = collapsedSections
				.filter((h) => h !== headerIdx)
				.map((h) => (h > headerIdx ? h - 1 : h))
				.sort((a, b) => a - b);
			if (JSON.stringify(v) !== JSON.stringify(collapsedSections)) {
				onCollapsedSectionsChange(v);
			}
		}
		if (focusPrev) focusRow(focusAt);
	}

	function copyFromPreviousSameType(headerIdx: number) {
		const cur = sections[headerIdx];
		if (!cur) return;
		const src = findPreviousSameType(sections, headerIdx, rows);
		if (!src) return;

		const srcRows = rows.slice(src.bodyStart, src.bodyEnd).map((r) => ({ ...r }));
		const tgtStart = cur.bodyStart;
		const tgtEnd = cur.bodyEnd;
		const delta = srcRows.length - (tgtEnd - tgtStart);

		// Kopiér også bass-linjer for de kilde-rækker hvor de er sat —
		// så det nye copy-pasted indhold visuelt matcher kilden.
		const next = [...rows.slice(0, tgtStart), ...srcRows, ...rows.slice(tgtEnd)];
		emit(next);

		const out: BassLines = {};
		for (const [k, v] of Object.entries(bassLines)) {
			const r = Number(k);
			if (!Number.isFinite(r)) continue;
			if (r >= tgtStart && r < tgtEnd) continue; // gamle target-linjer ryddes
			const newR = r >= tgtEnd ? r + delta : r;
			out[String(newR)] = normalizeBassLine(v);
		}
		const offset = tgtStart - src.bodyStart;
		for (let i = 0; i < srcRows.length; i++) {
			const srcRowIdx = src.bodyStart + i;
			const v = bassLines[String(srcRowIdx)];
			if (v) out[String(srcRowIdx + offset)] = normalizeBassLine(v);
		}
		if (JSON.stringify(out) !== JSON.stringify(bassLines)) emitBassLines(out);
	}

	function chordRowIndicesInSection(start: number, end: number): number[] {
		const out: number[] = [];
		for (let i = start; i < end; i++) {
			if (rows[i]?.kind === 'chord') out.push(i);
		}
		return out;
	}

	function previousSameTypeHasChords(headerIdx: number): boolean {
		const src = findPreviousSameType(sections, headerIdx, rows);
		if (!src) return false;
		return chordRowIndicesInSection(src.bodyStart, src.bodyEnd).length > 0;
	}

	/**
	 * Find display-rækken hvor bassen for chord-rækken `chordIdx` ligger.
	 * Hvis chorden efterfølges af en lyric, sidder bassen på lyric-rækken;
	 * ellers på chord-rækken selv.
	 */
	function bassRowForChordRow(rs: Row[], chordIdx: number): number {
		return rs[chordIdx + 1]?.kind === 'lyric' ? chordIdx + 1 : chordIdx;
	}

	function copyChordsAndBassFromPreviousSameType(headerIdx: number) {
		if (!onBassLinesChange) return;
		const cur = sections[headerIdx];
		const src = findPreviousSameType(sections, headerIdx, rows);
		if (!cur || !src) return;

		const srcChordRows = chordRowIndicesInSection(src.bodyStart, src.bodyEnd);
		const targetChordRows = chordRowIndicesInSection(cur.bodyStart, cur.bodyEnd);
		if (srcChordRows.length === 0 || targetChordRows.length === 0) return;

		const nextRows = [...rows];
		const next: BassLines = { ...bassLines };
		let changed = false;
		const count = Math.min(srcChordRows.length, targetChordRows.length);
		for (let i = 0; i < count; i++) {
			const srcChordIdx = srcChordRows[i];
			const targetChordIdx = targetChordRows[i];
			const srcRow = rows[srcChordIdx];
			const targetRow = rows[targetChordIdx];
			if (srcRow?.kind === 'chord' && targetRow?.kind === 'chord' && srcRow.text !== targetRow.text) {
				nextRows[targetChordIdx] = { ...targetRow, text: srcRow.text };
				changed = true;
			}

			const srcBassRow = bassRowForChordRow(rows, srcChordIdx);
			const targetBassRow = bassRowForChordRow(nextRows, targetChordIdx);
			const srcLine = bassLines[String(srcBassRow)];
			const normalizedSrcLine = srcLine?.trim() ? normalizeBassLine(srcLine) : '';
			const targetKey = String(targetBassRow);
			if (normalizedSrcLine) {
				if (next[targetKey] !== normalizedSrcLine) {
					next[targetKey] = normalizedSrcLine;
					changed = true;
				}
			} else if (next[targetKey]) {
				delete next[targetKey];
				changed = true;
			}
		}
		if (!changed) return;
		emit(nextRows);
		emitBassLines(next);
	}

	function applySectionRelocate(
		sourceHeaderIdx: number,
		targetHeaderIdx: number,
		place: SectionDropPlace,
		mode: SectionRelocateMode
	) {
		const result = relocateSection({
			rows,
			bassLines,
			collapsedSections,
			sourceHeaderIdx,
			targetHeaderIdx,
			place,
			mode
		});
		if (!result) return;
		emit(result.rows);
		if (JSON.stringify(result.bassLines) !== JSON.stringify(bassLines)) {
			emitBassLines(result.bassLines);
		}
		if (
			onCollapsedSectionsChange &&
			JSON.stringify(result.collapsedSections) !== JSON.stringify(collapsedSections)
		) {
			onCollapsedSectionsChange(result.collapsedSections);
		}
	}

	// ──────────────────────────────────────────────────────────────────────
	// Cell-redigering (lyric/header/blank)
	// ──────────────────────────────────────────────────────────────────────
	function setField(idx: number, value: string) {
		const r = rows[idx];
		if (!r) return;
		const next = [...rows];
		if (r.kind === 'lyric') next[idx] = { ...r, text: value };
		else if (r.kind === 'header') next[idx] = { ...r, text: value };
		else if (r.kind === 'blank') next[idx] = { kind: 'lyric', text: value };
		else return;
		emit(next);
	}

	function onCellInput(e: Event, idx: number) {
		const text = (e.currentTarget as HTMLElement).innerText.replace(/\n+$/, '');
		setField(idx, text);
	}

	function onCellBlur(idx: number) {
		const r = rows[idx];
		if (!r) return;
		if (r.kind === 'header') {
			const cleaned = cleanSectionHeader(r.text);
			if (cleaned === r.text) return;
			const next = [...rows];
			next[idx] = { kind: 'header', text: cleaned };
			const el = document.querySelector(
				`.editable-song [data-row="${idx}"][data-field="text"]`
			) as HTMLElement | null;
			if (el && el.innerText !== cleaned) el.innerText = cleaned;
			emit(next);
		}
	}

	async function focusRow(idx: number, offset: number | 'end' = 'end') {
		await tick();
		const root = document.querySelector(`.editable-song`);
		if (!root) return;
		const el = root.querySelector(`[data-row="${idx}"][data-field]`) as HTMLElement | null;
		if (el) {
			el.focus();
			const text = cellPlainText(el);
			placeCaret(el, offset === 'end' ? text.length : Math.max(0, Math.min(offset, text.length)));
			return;
		}
		(root.querySelector(`[data-row="${idx}"]`) as HTMLElement | null)?.focus();
	}

	function cellPlainText(el: HTMLElement): string {
		return el.innerText.replace(/\u00a0/g, ' ').replace(/\n+$/, '');
	}

	function placeCaret(el: HTMLElement, offset: number) {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let remaining = offset;
		let node = walker.nextNode();
		while (node) {
			const len = node.textContent?.length ?? 0;
			if (remaining <= len) {
				const range = document.createRange();
				range.setStart(node, remaining);
				range.collapse(true);
				const s = window.getSelection();
				s?.removeAllRanges();
				s?.addRange(range);
				return;
			}
			remaining -= len;
			node = walker.nextNode();
		}
		const range = document.createRange();
		range.selectNodeContents(el);
		range.collapse(false);
		const s = window.getSelection();
		s?.removeAllRanges();
		s?.addRange(range);
	}

	function selectionCollapsedIn(el: HTMLElement): boolean {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return true;
		if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return true;
		return sel.isCollapsed;
	}

	function onCellKeydown(e: KeyboardEvent, idx: number) {
		const target = e.currentTarget as HTMLElement;

		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			splitRowAtCaret(idx, target);
			return;
		}

		if (
			e.key === 'Backspace' &&
			selectionCollapsedIn(target) &&
			(getCaretOffset(target) === 0 || cellPlainText(target) === '')
		) {
			if (idx === 0 || rows.length <= 1) return;
			e.preventDefault();
			joinRowWithPrevious(idx);
			return;
		}

		if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
			e.preventDefault();
			deleteRow(idx, 'next');
			return;
		}

		if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
			if (undoStack.length > 0) {
				e.preventDefault();
				undo();
				return;
			}
		}

		if (e.key === 'ArrowUp' && idx > 0) {
			e.preventDefault();
			focusRow(idx - 1);
		} else if (e.key === 'ArrowDown' && idx < rows.length - 1) {
			e.preventDefault();
			focusRow(idx + 1);
		}
	}

	function getCaretOffset(el: HTMLElement): number {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return 0;
		const range = sel.getRangeAt(0);
		if (!el.contains(range.startContainer)) return 0;
		const pre = range.cloneRange();
		pre.selectNodeContents(el);
		pre.setEnd(range.startContainer, range.startOffset);
		return pre.toString().length;
	}

	function splitRowAtCaret(idx: number, cellEl: HTMLElement) {
		const row = rows[idx];
		if (!row) return;
		const caret = getCaretOffset(cellEl);

		const next = [...rows];
		let newRow: Row;
		const root = document.querySelector('.editable-song');
		const textCellEl = root?.querySelector(
			`[data-row="${idx}"][data-field="text"]`
		) as HTMLElement | null;

		if (row.kind === 'lyric' || row.kind === 'chord' || row.kind === 'header') {
			const before = row.text.slice(0, caret);
			const after = row.text.slice(caret);
			next[idx] = { ...row, text: before } as Row;
			newRow = { ...row, text: after } as Row;
			if (textCellEl) textCellEl.innerText = before;
		} else {
			newRow = { kind: 'blank' };
		}

		next.splice(idx + 1, 0, newRow);
		emit(next);
		shiftBassLines(idx + 1, 1);
		focusRow(idx + 1);
		requestAnimationFrame(() => {
			const root2 = document.querySelector('.editable-song');
			const el = root2?.querySelector(
				`[data-row="${idx + 1}"][data-field="text"]`
			) as HTMLElement | null;
			if (!el) return;
			const range = document.createRange();
			range.selectNodeContents(el);
			range.collapse(true);
			const s = window.getSelection();
			s?.removeAllRanges();
			s?.addRange(range);
		});
	}

	function deleteLine(idx: number) {
		(document.activeElement as HTMLElement | null)?.blur?.();
		const headerIdx = sections.findIndex((s) => s.headerRowIdx === idx);
		if (headerIdx >= 0 && sectionIsEmpty(headerIdx)) {
			deleteSection(headerIdx, false);
			return;
		}
		deleteRow(idx, 'none');
		if (headerIdx >= 0 && onCollapsedSectionsChange) {
			const v = collapsedSections
				.filter((h) => h !== headerIdx)
				.map((h) => (h > headerIdx ? h - 1 : h))
				.sort((a, b) => a - b);
			if (JSON.stringify(v) !== JSON.stringify(collapsedSections)) {
				onCollapsedSectionsChange(v);
			}
		}
		void tick().then(() => {
			const active = document.activeElement;
			if (active instanceof HTMLElement && active.closest('.editable-song')) active.blur();
		});
	}

	function deleteRow(idx: number, focus: 'prev' | 'next' | 'none' = 'none') {
		if (idx < 0 || idx >= rows.length) return;
		if (rows.length <= 1) {
			emit([{ kind: 'blank' }]);
			focusRow(0);
			return;
		}
		const next = rows.filter((_, i) => i !== idx);
		emit(next);
		shiftBassLines(idx + 1, -1, [idx, idx + 1]);
		if (focus === 'prev') focusRow(Math.max(0, idx - 1));
		else if (focus === 'next') focusRow(Math.min(idx, next.length - 1));
	}

	function rowPlainText(row: Row | undefined): string {
		if (!row || row.kind === 'blank') return '';
		return row.text;
	}

	function joinRowWithPrevious(idx: number) {
		if (idx <= 0) return;
		const cur = rows[idx];
		const prev = rows[idx - 1];
		if (!cur || !prev) return;

		const curText = rowPlainText(cur);
		if (cur.kind === 'header') {
			const headerIdx = sections.findIndex((s) => s.headerRowIdx === idx);
			if (headerIdx >= 0 && sectionIsEmpty(headerIdx)) {
				deleteSection(headerIdx, true);
				return;
			}
			if (curText === '') {
				(document.activeElement as HTMLElement | null)?.blur?.();
				deleteRow(idx, 'prev');
			}
			return;
		}
		if (curText === '') {
			deleteRow(idx, 'prev');
			return;
		}
		if (prev.kind === 'chord' || prev.kind === 'header') return;

		const prevText = rowPlainText(prev);
		const merged = prevText + curText;
		const next = [...rows];
		next[idx - 1] = merged === '' ? { kind: 'blank' } : { kind: 'lyric', text: merged };
		next.splice(idx, 1);
		const prevEl = document.querySelector(
			`.editable-song [data-row="${idx - 1}"][data-field="text"]`
		) as HTMLElement | null;
		if (prevEl && prevEl.innerText !== merged) prevEl.innerText = merged;
		emit(next);
		shiftBassLines(idx + 1, -1, [idx, idx + 1]);
		focusRow(idx - 1, prevText.length);
	}

	function insertTextRow(idx: number, place: 'before' | 'after') {
		if (idx < 0 || idx >= rows.length) return;
		const at = place === 'before' ? idx : idx + 1;
		emit([...rows.slice(0, at), { kind: 'blank' }, ...rows.slice(at)]);
		shiftBassLines(at, 1);
	}

	function insertNewSection(insertAt: number) {
		if (insertAt < 0 || insertAt > rows.length) return;
		const block: Row[] = [{ kind: 'header', text: '' }, { kind: 'blank' }];
		emit([...rows.slice(0, insertAt), ...block, ...rows.slice(insertAt)]);
		shiftBassLines(insertAt, block.length);
		if (onCollapsedSectionsChange) {
			const next = collapsedSections
				.map((h) => {
					const s = sections[h];
					return s && s.headerRowIdx >= insertAt ? h + 1 : h;
				})
				.sort((a, b) => a - b);
			if (JSON.stringify(next) !== JSON.stringify(collapsedSections)) {
				onCollapsedSectionsChange(next);
			}
		}
		focusRow(insertAt);
	}

	function onCellPaste(e: ClipboardEvent, idx: number) {
		const text = e.clipboardData?.getData('text/plain') ?? '';
		if (!text.includes('\n')) return;
		e.preventDefault();
		const pasted = parseRows(text);
		const next = [...rows];
		const replaceCurrent = isEmptyRow(rows[idx]);
		if (replaceCurrent) next.splice(idx, 1, ...pasted);
		else next.splice(idx + 1, 0, ...pasted);
		emit(next);
		const inserted = pasted.length;
		const after = replaceCurrent ? idx + 1 : idx + 2;
		const delta = replaceCurrent ? inserted - 1 : inserted;
		if (delta !== 0) shiftBassLines(after - delta, delta);
	}

	function isEmptyRow(r: Row): boolean {
		if (r.kind === 'blank') return true;
		return r.text.trim() === '';
	}

	type LineKind = 'chord' | 'lyric' | 'form';

	function rowKindToOption(r: Row | undefined): LineKind | null {
		if (!r) return null;
		if (r.kind === 'chord') return 'chord';
		if (r.kind === 'lyric' || r.kind === 'blank') return 'lyric';
		if (r.kind === 'header') return 'form';
		return null;
	}

	function changeRowKind(idx: number, target: LineKind) {
		const r = rows[idx];
		if (!r) return;
		const current = rowKindToOption(r);
		if (current === target) return;

		const text = r.kind === 'blank' ? '' : r.text;
		const nextRow: Row =
			target === 'chord'
				? { kind: 'chord', text: normalizeAccidentals(text) }
				: target === 'lyric'
					? { kind: 'lyric', text }
					: { kind: 'header', text: cleanSectionHeader(text) };
		const next = [...rows];
		next[idx] = nextRow;
		emit(next);
		if (target === 'form' && bassLines[String(idx)]) {
			const out = { ...bassLines };
			delete out[String(idx)];
			emitBassLines(out);
		}
	}

	// Action der initierer cell-indhold uden at konkurrere med cursoren.
	function init(node: HTMLElement, text: string) {
		if (node.innerText !== text) node.innerText = text;
		return {
			update(newText: string) {
				if (document.activeElement === node) return;
				if (node.innerText !== newText) node.innerText = newText;
			}
		};
	}

	// ──────────────────────────────────────────────────────────────────────
	// Bass-linjer er 1-til-1 med visningsrækken: `bassLines[i]` er
	// bas-linjen for række `i`. Header-rækker har aldrig en baslinje;
	// alle andre (chord, lyric, blank) kan have en. Migrationen i
	// `migrate.ts` flytter gamle keys fra chord-row til lyric-row hvis
	// chorden efterfølges af lyrics, så denne forenklede invariant
	// holder for alle eksisterende sange.
	// ──────────────────────────────────────────────────────────────────────
	function canHaveBass(i: number): boolean {
		return rows[i]?.kind !== 'header';
	}

	function bassHtmlFor(rowIdx: number): string {
		const line = bassLines[String(rowIdx)];
		if (!line || line.trim() === '') return '';
		return renderBarLine(line);
	}

	/**
	 * Init-tekst når brugeren starter en helt ny baslinje på række `i`.
	 * - chord-row: brug rækkens egen tekst som udgangspunkt.
	 * - lyric-row: brug chord-rækken umiddelbart ovenover, hvis findes.
	 * - blank-row: ingen kilde — start blot på `|  |`.
	 */
	function initialBassFor(i: number): string {
		const row = rows[i];
		if (!row) return '|  |';
		if (row.kind === 'chord') return normalizeBassLine(row.text) || '|  |';
		if (row.kind === 'lyric') {
			const prev = rows[i - 1];
			if (prev?.kind === 'chord') return normalizeBassLine(prev.text) || '|  |';
		}
		return '|  |';
	}

	// ──────────────────────────────────────────────────────────────────────
	// Modaler — chord-modal og bass-modal har SAMME format og hint.
	// ──────────────────────────────────────────────────────────────────────
	let chordModal = $state<{ rowIdx: number; value: string } | null>(null);
	let bassModal = $state<{ rowIdx: number; value: string } | null>(null);

	function openChordModal(rowIdx: number) {
		const row = rows[rowIdx];
		if (!row || row.kind !== 'chord') return;
		chordModal = { rowIdx, value: row.text };
	}

	function saveChordModal() {
		if (!chordModal) return;
		const trimmed = normalizeAccidentals(chordModal.value.trim());
		const next = [...rows];
		const r = next[chordModal.rowIdx];
		if (!r || r.kind !== 'chord') {
			chordModal = null;
			return;
		}
		next[chordModal.rowIdx] = { ...r, text: trimmed };
		emit(next);
		chordModal = null;
	}

	/**
	 * Åbn baslinje-modalen for række `i`. Hvis der allerede findes en
	 * baslinje, åbnes den til redigering. Ellers oprettes en ny ud fra
	 * `initialBassFor(i)` og skrives straks ind i `bassLines`, så højre
	 * kolonne får synligt indhold (også hvis brugeren afbryder modalen).
	 */
	function openOrStartBassModal(rowIdx: number) {
		if (!onBassLinesChange) return;
		if (!canHaveBass(rowIdx)) return;
		const existing = bassLines[String(rowIdx)];
		if (existing?.trim()) {
			bassModal = { rowIdx, value: existing };
			return;
		}
		const value = initialBassFor(rowIdx);
		emitBassLines({ ...bassLines, [String(rowIdx)]: value });
		bassModal = { rowIdx, value };
	}

	function saveBassModal() {
		if (!bassModal || !onBassLinesChange) return;
		const trimmed = normalizeBassLine(bassModal.value);
		const k = String(bassModal.rowIdx);
		const next: BassLines = { ...bassLines };
		if (trimmed === '') delete next[k];
		else next[k] = trimmed;
		emitBassLines(next);
		bassModal = null;
	}

	// ──────────────────────────────────────────────────────────────────────
	// Drag-and-drop — kun WITHIN-side (chord ↔ chord, bass ↔ bass).
	// ──────────────────────────────────────────────────────────────────────
	type DragCol = 'chord' | 'bass';
	let dragInfo = $state<{ rowIdx: number; col: DragCol } | null>(null);
	let dropTarget = $state<{ rowIdx: number; col: DragCol } | null>(null);
	let sectionDrag = $state<{ headerIdx: number } | null>(null);
	let sectionDragCompact = $state(false);
	let sectionDropTarget = $state<{ headerIdx: number; place: SectionDropPlace } | null>(null);
	let sectionDragCopy = $state(false);
	let compactTimer: ReturnType<typeof setTimeout> | undefined;

	function headerIdxForRow(rowIdx: number): number {
		const row = rows[rowIdx];
		if (row?.kind === 'header') {
			return sections.findIndex((s) => s.headerRowIdx === rowIdx);
		}
		return rowToHeaderIdx[rowIdx] ?? -1;
	}

	function resolveDropHeaderIdx(rowIdx: number): number {
		const idx = headerIdxForRow(rowIdx);
		if (idx >= 0) return idx;
		const first = sections[0];
		if (first && rowIdx < first.headerRowIdx) return 0;
		return -1;
	}

	function sectionModeFromEvent(e: DragEvent): SectionRelocateMode {
		return e.altKey ? 'copy' : 'move';
	}

	function hitSectionDrop(clientY: number): { headerIdx: number; place: SectionDropPlace } | null {
		const root = document.querySelector('.editable-song');
		if (!root) return null;
		const els = [...root.querySelectorAll<HTMLElement>('[data-section-block]')].filter(
			(el) => el.offsetParent !== null && !el.classList.contains('section-drag-source')
		);
		if (els.length === 0) return null;
		const first = els[0];
		const firstRect = first.getBoundingClientRect();
		const firstIdx = Number(first.dataset.sectionBlock);
		if (!Number.isInteger(firstIdx)) return null;
		if (clientY < firstRect.top + Math.min(16, firstRect.height * 0.4)) {
			return { headerIdx: firstIdx, place: 'before' };
		}
		let chosen = first;
		for (const el of els) {
			if (el.getBoundingClientRect().top <= clientY) chosen = el;
		}
		const headerIdx = Number(chosen.dataset.sectionBlock);
		if (!Number.isInteger(headerIdx)) return null;
		return { headerIdx, place: 'after' };
	}

	function applySectionHit(e: DragEvent): boolean {
		if (!sectionDrag) return false;
		const mode = sectionModeFromEvent(e);
		const hit = hitSectionDrop(e.clientY);
		if (!hit) return false;
		if (sectionDropIsNoOp(rows, sectionDrag.headerIdx, hit.headerIdx, hit.place, mode)) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
			if (sectionDropTarget) sectionDropTarget = null;
			return true;
		}
		e.preventDefault();
		sectionDragCopy = mode === 'copy';
		if (e.dataTransfer) e.dataTransfer.dropEffect = mode === 'copy' ? 'copy' : 'move';
		if (sectionDropTarget?.headerIdx !== hit.headerIdx || sectionDropTarget?.place !== hit.place) {
			sectionDropTarget = hit;
		}
		return true;
	}

	function sectionRowClass(
		headerIdx: number
	): {
		source: boolean;
		target: boolean;
		before: boolean;
		after: boolean;
	} {
		const source = sectionDrag?.headerIdx === headerIdx && headerIdx >= 0;
		const target = sectionDropTarget?.headerIdx === headerIdx && headerIdx >= 0;
		return {
			source,
			target,
			before: !!(target && sectionDropTarget?.place === 'before'),
			after: !!(target && sectionDropTarget?.place === 'after')
		};
	}

	function onLineDragStart(e: DragEvent, rowIdx: number, col: DragCol) {
		if (!e.dataTransfer) return;
		e.dataTransfer.effectAllowed = 'copy';
		e.dataTransfer.setData('application/x-chord-line', JSON.stringify({ rowIdx, col }));
		const r = rows[rowIdx];
		const text =
			col === 'chord' && r?.kind === 'chord' ? r.text : bassLines[String(rowIdx)] ?? '';
		if (text) e.dataTransfer.setData('text/plain', text);
		dragInfo = { rowIdx, col };
	}

	function onLineDragEnd() {
		dragInfo = null;
		dropTarget = null;
	}

	function onLineDragOver(e: DragEvent, rowIdx: number, col: DragCol) {
		if (sectionDrag) {
			applySectionHit(e);
			return;
		}
		if (!dragInfo || dragInfo.col !== col || dragInfo.rowIdx === rowIdx) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		if (dropTarget?.rowIdx !== rowIdx || dropTarget?.col !== col) {
			dropTarget = { rowIdx, col };
		}
	}

	function onLineDragLeave(rowIdx: number, col: DragCol) {
		if (sectionDrag) return;
		if (dropTarget?.rowIdx === rowIdx && dropTarget?.col === col) dropTarget = null;
	}

	function onLineDrop(e: DragEvent, targetIdx: number, col: DragCol) {
		e.preventDefault();
		if (sectionDrag || e.dataTransfer?.types.includes('application/x-song-section')) {
			applySectionHit(e);
			onSectionDrop(e, sectionDropTarget?.headerIdx ?? resolveDropHeaderIdx(targetIdx));
			return;
		}
		const raw = e.dataTransfer?.getData('application/x-chord-line');
		dropTarget = null;
		dragInfo = null;
		if (!raw) return;
		let info: { rowIdx: number; col: DragCol };
		try {
			info = JSON.parse(raw);
		} catch {
			return;
		}
		if (info.col !== col || info.rowIdx === targetIdx) return;
		if (col === 'chord') copyChordLine(info.rowIdx, targetIdx);
		else copyBassLine(info.rowIdx, targetIdx);
	}

	function copyChordLine(srcIdx: number, tgtIdx: number) {
		const src = rows[srcIdx];
		const tgt = rows[tgtIdx];
		if (src?.kind !== 'chord' || tgt?.kind !== 'chord') return;
		if (!src.text.trim()) return;
		const next = [...rows];
		next[tgtIdx] = { ...tgt, text: src.text };
		emit(next);
	}

	function copyBassLine(srcIdx: number, tgtIdx: number) {
		if (!onBassLinesChange) return;
		const srcLine = bassLines[String(srcIdx)];
		if (!srcLine || !srcLine.trim()) return;
		emitBassLines({ ...bassLines, [String(tgtIdx)]: normalizeBassLine(srcLine) });
	}

	function onSectionDragStart(e: DragEvent, headerIdx: number) {
		if ((e.target as HTMLElement | null)?.closest?.('.line-actions')) {
			e.preventDefault();
			return;
		}
		if (!e.dataTransfer || headerIdx < 0) {
			e.preventDefault();
			return;
		}
		e.dataTransfer.effectAllowed = 'copyMove';
		e.dataTransfer.setData('application/x-song-section', String(headerIdx));
		e.dataTransfer.setData('text/plain', sections[headerIdx]?.headerText ?? 'Formstykke');
		const block = document.querySelector(
			`.editable-song [data-section-block="${headerIdx}"]`
		) as HTMLElement | null;
		if (block) {
			const ghost = block.cloneNode(true) as HTMLElement;
			ghost.style.position = 'absolute';
			ghost.style.top = '-2000px';
			ghost.style.left = '0';
			ghost.style.width = `${Math.max(block.getBoundingClientRect().width, 160)}px`;
			ghost.style.background = 'rgba(15, 23, 42, 0.06)';
			document.body.appendChild(ghost);
			e.dataTransfer.setDragImage(ghost, 24, 16);
			setTimeout(() => ghost.remove(), 0);
		}
		sectionDrag = { headerIdx };
		sectionDragCopy = e.altKey;
		sectionDropTarget = null;
		sectionDragCompact = false;
		clearTimeout(compactTimer);
		// Vent til browseren har låst drag — ellers dør HTML5-trækket
		// når vi klapper de andre formstykker sammen.
		compactTimer = setTimeout(() => {
			sectionDragCompact = true;
		}, 0);
	}

	function onSectionDragEnd() {
		clearTimeout(compactTimer);
		sectionDrag = null;
		sectionDragCompact = false;
		sectionDropTarget = null;
		sectionDragCopy = false;
	}

	function onSectionDragOver(e: DragEvent) {
		applySectionHit(e);
	}

	function onSectionDrop(e: DragEvent, fallbackHeaderIdx: number) {
		const isSection =
			!!sectionDrag || !!e.dataTransfer?.types.includes('application/x-song-section');
		if (!isSection) return;
		e.preventDefault();
		const raw = e.dataTransfer?.getData('application/x-song-section');
		const sourceHeaderIdx = raw ? Number(raw) : sectionDrag?.headerIdx;
		const mode: SectionRelocateMode =
			sectionModeFromEvent(e) === 'copy' || sectionDragCopy ? 'copy' : 'move';
		const targetHeaderIdx = sectionDropTarget?.headerIdx ?? fallbackHeaderIdx;
		const place = sectionDropTarget?.place ?? 'after';
		clearTimeout(compactTimer);
		sectionDrag = null;
		sectionDragCompact = false;
		sectionDropTarget = null;
		sectionDragCopy = false;
		if (sourceHeaderIdx === undefined || !Number.isInteger(sourceHeaderIdx)) return;
		if (targetHeaderIdx < 0) return;
		applySectionRelocate(sourceHeaderIdx, targetHeaderIdx, place, mode);
	}

	function focusOnMount(node: HTMLInputElement) {
		requestAnimationFrame(() => {
			node.focus();
			node.select();
		});
	}

	// Fælles hint vist i begge modaler.
	const MODAL_HINT = 'Skriv linjen som du vil have den. Brug `|` mellem takter, mellemrum mellem akkorder i samme takt, og `-` for et tomt slag. Fx `C | F - G | Am - - -`.';
</script>

{#snippet sectionInserts(beforeAt: number, afterAt: number)}
	{#if !readOnly && !sectionDragCompact}
		<button
			type="button"
			class="section-insert section-insert--before"
			title="Tilføj formstykke ovenover"
			aria-label="Tilføj formstykke ovenover"
			onmousedown={(e) => e.preventDefault()}
			onclick={() => insertNewSection(beforeAt)}
		>
			+
		</button>
		<button
			type="button"
			class="section-insert section-insert--after"
			title="Tilføj formstykke nedenunder"
			aria-label="Tilføj formstykke nedenunder"
			onmousedown={(e) => e.preventDefault()}
			onclick={() => insertNewSection(afterAt)}
		>
			+
		</button>
	{/if}
{/snippet}

{#snippet lineActions(rowIdx: number)}
	{@const kind = rowKindToOption(rows[rowIdx])}
	{#if !readOnly && kind && !sectionDragCompact}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="line-actions"
			draggable="false"
			onpointerdown={(e) => e.stopPropagation()}
			onmousedown={(e) => e.stopPropagation()}
			onclick={(e) => e.stopPropagation()}
			ondragstart={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
		>
			<button
				type="button"
				class="line-delete"
				title="Slet linje"
				aria-label="Slet linje"
				onmousedown={(e) => e.preventDefault()}
				onclick={() => deleteLine(rowIdx)}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="3 6 5 6 21 6"></polyline>
					<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
					<path d="M10 11v6"></path>
					<path d="M14 11v6"></path>
					<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
				</svg>
			</button>
			<button
				type="button"
				class="line-insert"
				title="Indsæt linje nedenunder"
				aria-label="Indsæt linje nedenunder"
				onmousedown={(e) => e.preventDefault()}
				onclick={() => insertTextRow(rowIdx, 'after')}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="6 9 12 15 18 9"></polyline>
				</svg>
			</button>
			<button
				type="button"
				class="line-insert"
				title="Indsæt linje ovenover"
				aria-label="Indsæt linje ovenover"
				onmousedown={(e) => e.preventDefault()}
				onclick={() => insertTextRow(rowIdx, 'before')}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="18 15 12 9 6 15"></polyline>
				</svg>
			</button>
			<select
				class="line-kind"
				aria-label="Linjetype"
				title="Linjetype"
				value={kind}
				onchange={(e) =>
					changeRowKind(rowIdx, (e.currentTarget as HTMLSelectElement).value as LineKind)}
			>
				<option value="chord">Akkord</option>
				<option value="lyric">Lyrics</option>
				<option value="form">Form</option>
			</select>
		</div>
	{/if}
{/snippet}

{#snippet bassCell(i: number)}
	{@const hasBass = !!bassLines[String(i)]?.trim()}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="rhythm-cell rhythm-cell-clickable"
		class:rhythm-cell-empty={!hasBass}
		class:drop-target={dropTarget?.rowIdx === i && dropTarget?.col === 'bass'}
		class:drag-source={dragInfo?.rowIdx === i && dragInfo?.col === 'bass'}
		data-row={i}
		title={readOnly ? undefined : hasBass ? 'Klik for at redigere · træk for at kopiere bass-linjen' : 'Klik for at starte en baslinje'}
		draggable={readOnly || !hasBass ? 'false' : 'true'}
		ondragstart={readOnly || !hasBass ? undefined : (e) => onLineDragStart(e, i, 'bass')}
		ondragend={readOnly ? undefined : onLineDragEnd}
		ondragover={readOnly ? undefined : (e) => onLineDragOver(e, i, 'bass')}
		ondragleave={readOnly ? undefined : () => onLineDragLeave(i, 'bass')}
		ondrop={readOnly ? undefined : (e) => onLineDrop(e, i, 'bass')}
		onclick={readOnly ? undefined : () => openOrStartBassModal(i)}
	>
		{#if hasBass}{@html bassHtmlFor(i)}{:else}&nbsp;{/if}
	</div>
{/snippet}

{#snippet songLine(i: number)}
	{@const row = rows[i]}
	{#if row.kind === 'blank' || row.kind === 'lyric'}
		<div class="song-line-wrap" class:is-empty={isEmptyRow(row)}>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="lyrics-cell blank-cell song-line"
				class:lyric-cell={row.kind === 'lyric'}
				contenteditable={readOnly ? 'false' : 'plaintext-only'}
				use:init={row.kind === 'blank' ? '' : row.text}
				data-row={i}
				data-field="text"
				oninput={readOnly ? undefined : (e) => onCellInput(e, i)}
				onblur={readOnly ? undefined : () => onCellBlur(i)}
				onkeydown={readOnly ? undefined : (e) => onCellKeydown(e, i)}
				onpaste={readOnly ? undefined : (e) => onCellPaste(e, i)}
				ondragover={readOnly ? undefined : onSectionDragOver}
				ondrop={readOnly ? undefined : (e) => onSectionDrop(e, resolveDropHeaderIdx(i))}
				role={readOnly ? 'presentation' : 'textbox'}
				tabindex={readOnly ? undefined : 0}
				aria-label={readOnly ? undefined : row.kind === 'blank' ? 'Tom linje' : 'Tekst-linje'}
			></div>
			{@render lineActions(i)}
		</div>
		{@render bassCell(i)}
	{:else if row.kind === 'chord'}
		<div class="song-line-wrap is-chord" class:is-empty={isEmptyRow(row)}>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				class="lyrics-cell chord-cell chord-cell-clickable song-line"
				class:drop-target={dropTarget?.rowIdx === i && dropTarget?.col === 'chord'}
				class:drag-source={dragInfo?.rowIdx === i && dragInfo?.col === 'chord'}
				data-row={i}
				title={readOnly ? undefined : 'Klik for at redigere · træk for at kopiere til en anden linje'}
				draggable={readOnly ? 'false' : 'true'}
				ondragstart={readOnly ? undefined : (e) => onLineDragStart(e, i, 'chord')}
				ondragend={readOnly ? undefined : onLineDragEnd}
				ondragover={readOnly ? undefined : (e) => onLineDragOver(e, i, 'chord')}
				ondragleave={readOnly ? undefined : () => onLineDragLeave(i, 'chord')}
				ondrop={readOnly ? undefined : (e) => onLineDrop(e, i, 'chord')}
				onclick={readOnly ? undefined : () => openChordModal(i)}
				role={readOnly ? 'presentation' : 'button'}
				tabindex={readOnly ? undefined : 0}
				aria-label={readOnly ? undefined : `Rediger akkord-linje for række ${i + 1}`}
			>{#if row.text.trim()}{@html renderBarLine(row.text)}{:else}&nbsp;{/if}</div>
			{@render lineActions(i)}
		</div>
		{@render bassCell(i)}
	{/if}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="editable-song"
	class:read-only={readOnly}
	class:is-pristine={isPristineSong}
	class:is-section-dragging={sectionDragCompact}
	class:is-section-copying={sectionDragCopy}
	role={readOnly ? 'presentation' : 'textbox'}
	aria-multiline={readOnly ? undefined : 'true'}
	tabindex={readOnly ? undefined : -1}
	ondragover={readOnly ? undefined : onSectionDragOver}
	ondrop={readOnly ? undefined : (e) => onSectionDrop(e, sectionDropTarget?.headerIdx ?? -1)}
>
	{#if unlabeledRowIdxs.length && !sectionDragCompact}
		{@const unlabeledEnd = sections[0]?.headerRowIdx ?? rows.length}
		<section class="song-section song-section--unlabeled">
			{@render sectionInserts(0, unlabeledEnd)}
			<div class="song-section-grid chord-grid">
				{#each unlabeledRowIdxs as i (i)}
					{@render songLine(i)}
				{/each}
			</div>
		</section>
	{/if}
	{#each sections as section (section.headerRowIdx)}
		{@const headerIdx = section.headerIdx}
		{@const headerRow = rows[section.headerRowIdx]}
		{@const isCollapsed = collapsedSet.has(headerIdx)}
		{@const hideBody = isCollapsed || sectionDragCompact}
		{@const prevSame = findPreviousSameType(sections, headerIdx, rows)}
		{@const sectionCls = sectionRowClass(headerIdx)}
		<section
			class="song-section song-section--{section.type}"
			class:song-section--collapsed={isCollapsed}
			class:section-drop-target={sectionCls.target}
			class:section-drop-before={sectionCls.before}
			class:section-drop-after={sectionCls.after}
			class:section-drag-source={sectionCls.source}
			data-section={headerIdx}
			data-section-block={headerIdx}
			ondragover={readOnly ? undefined : onSectionDragOver}
			ondrop={readOnly ? undefined : (e) => onSectionDrop(e, headerIdx)}
		>
			{@render sectionInserts(section.headerRowIdx, section.bodyEnd)}
			<div class="song-section-grid chord-grid">
				<div
					class="song-section-label"
					class:is-empty={isEmptyRow(headerRow)}
					title={readOnly ? undefined : 'Træk hele formstykket for at flytte · hold Alt for at kopiere'}
					draggable={readOnly ? 'false' : 'true'}
					ondragstart={readOnly ? undefined : (e) => onSectionDragStart(e, headerIdx)}
					ondragend={readOnly ? undefined : onSectionDragEnd}
				>
					{#if !readOnly}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span
							class="section-drag-handle"
							title="Træk hele formstykket for at flytte · hold Alt for at kopiere"
							draggable="true"
							ondragstart={(e) => {
								e.stopPropagation();
								onSectionDragStart(e, headerIdx);
							}}
							ondragend={onSectionDragEnd}
						>
							<svg width="10" height="12" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true">
								<circle cx="3" cy="3" r="1.15"></circle>
								<circle cx="9" cy="3" r="1.15"></circle>
								<circle cx="3" cy="7" r="1.15"></circle>
								<circle cx="9" cy="7" r="1.15"></circle>
								<circle cx="3" cy="11" r="1.15"></circle>
								<circle cx="9" cy="11" r="1.15"></circle>
							</svg>
						</span>
					{/if}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="section-header-edit"
						contenteditable={readOnly ? 'false' : 'plaintext-only'}
						use:init={headerRow.kind === 'header' ? headerRow.text : ''}
						data-row={section.headerRowIdx}
						data-field="text"
						oninput={readOnly ? undefined : (e) => onCellInput(e, section.headerRowIdx)}
						onblur={readOnly ? undefined : () => onCellBlur(section.headerRowIdx)}
						onkeydown={readOnly ? undefined : (e) => onCellKeydown(e, section.headerRowIdx)}
						onpaste={readOnly ? undefined : (e) => onCellPaste(e, section.headerRowIdx)}
						role={readOnly ? 'presentation' : 'textbox'}
						tabindex={readOnly ? undefined : 0}
						aria-label={readOnly ? undefined : 'Sektionsnavn'}
					></div>
					{#if isCollapsed}
						<span class="song-section-ellipsis" aria-hidden="true">…</span>
					{/if}
					{#if !readOnly}
						<div class="section-header-actions">
							{#if prevSame}
								<button
									type="button"
									class="section-action-btn"
									title="Kopiér indhold fra forrige {prevSame.headerText}"
									aria-label="Kopiér indhold fra forrige {prevSame.headerText}"
									onmousedown={(e) => e.preventDefault()}
									onclick={() => copyFromPreviousSameType(headerIdx)}
								>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<rect x="9" y="9" width="11" height="11" rx="2"></rect>
										<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
									</svg>
								</button>
								{#if previousSameTypeHasChords(headerIdx)}
									<button
										type="button"
										class="section-copy-link"
										title="Kopiér akkorder og bas fra forrige {prevSame.headerText}"
										onmousedown={(e) => e.preventDefault()}
										onclick={() => copyChordsAndBassFromPreviousSameType(headerIdx)}
									>
										Kopiér akkorder og bas fra sidste {prevSame.headerText}
									</button>
								{/if}
							{/if}
							<button
								type="button"
								class="section-action-btn"
								class:is-active={isCollapsed}
								title={isCollapsed ? 'Klap ud' : 'Klap sammen (skjules også ved print)'}
								aria-label={isCollapsed ? 'Klap sektion ud' : 'Klap sektion sammen'}
								aria-expanded={!isCollapsed}
								onmousedown={(e) => e.preventDefault()}
								onclick={() => toggleSectionCollapsed(headerIdx)}
							>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="chevron">
									<polyline points="6 9 12 15 18 9"></polyline>
								</svg>
							</button>
							<button
								type="button"
								class="section-action-btn section-action-btn--danger"
								title="Slet hele sektionen (kan fortrydes med ⌘Z)"
								aria-label="Slet sektion"
								onmousedown={(e) => e.preventDefault()}
								onclick={() => deleteSection(headerIdx)}
							>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<polyline points="3 6 5 6 21 6"></polyline>
									<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
									<path d="M10 11v6"></path>
									<path d="M14 11v6"></path>
									<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
								</svg>
							</button>
						</div>
					{/if}
					{@render lineActions(section.headerRowIdx)}
				</div>
				<div class="song-section-end"></div>
				{#if !hideBody}
					{#each Array.from({ length: section.bodyEnd - section.bodyStart }, (_, offset) => section.bodyStart + offset) as i (i)}
						{@render songLine(i)}
					{/each}
				{/if}
			</div>
		</section>
	{/each}
</div>

{#if (chordModal || bassModal) && !readOnly}
	{@const isBass = !!bassModal}
	{@const m = (isBass ? bassModal : chordModal) as { rowIdx: number; value: string }}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="bass-modal-backdrop"
		onclick={() => {
			chordModal = null;
			bassModal = null;
		}}
	>
		<div
			class="bass-modal"
			role="dialog"
			aria-modal="true"
			aria-label={isBass ? 'Rediger bass-linje' : 'Rediger akkord-linje'}
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<h3>{isBass ? 'Rediger bass-linje' : 'Rediger akkord-linje'}</h3>
			<p class="bass-modal-hint">{MODAL_HINT}</p>
			<input
				type="text"
				class="bass-modal-input"
				value={m.value}
				oninput={(e) => {
					const v = (e.currentTarget as HTMLInputElement).value;
					if (isBass && bassModal) bassModal = { ...bassModal, value: v };
					else if (chordModal) chordModal = { ...chordModal, value: v };
				}}
				use:focusOnMount
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						if (isBass) saveBassModal();
						else saveChordModal();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						chordModal = null;
						bassModal = null;
					}
				}}
				placeholder="C | F - G | Am - - -"
				spellcheck="false"
				autocomplete="off"
				autocorrect="off"
				autocapitalize="off"
			/>
			<div class="bass-modal-actions">
				<span style="flex: 1"></span>
				<button
					type="button"
					class="bass-modal-btn"
					onclick={() => {
						chordModal = null;
						bassModal = null;
					}}>Annullér</button
				>
				<button
					type="button"
					class="bass-modal-btn bass-modal-btn--primary"
					onclick={() => (isBass ? saveBassModal() : saveChordModal())}
				>
					Gem (Enter)
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.editable-song {
		min-height: 4rem;
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 1em;
		padding: 0.2em 0 0.4em;
	}
	.editable-song.read-only,
	.editable-song.read-only :global(*) {
		cursor: default !important;
		caret-color: transparent !important;
	}
	.editable-song.read-only .lyrics-cell:hover,
	.editable-song.read-only .lyrics-cell:focus,
	.editable-song.read-only .chord-cell-clickable:hover,
	.editable-song.read-only .chord-cell-clickable:focus-visible,
	.editable-song.read-only .rhythm-cell:hover,
	.editable-song.read-only .section-header-edit:focus {
		background: transparent !important;
		outline: none !important;
		box-shadow: none !important;
	}
	.editable-song.read-only .blank-cell:empty::before {
		content: '' !important;
	}
	.editable-song .song-section {
		--section-accent: #6b7280;
		position: relative;
		container-type: inline-size;
		border: 1px solid var(--section-accent);
		border-radius: 7px;
		background: #fff;
		padding: 0.6em 0.95em 0.7em;
		overflow: visible;
	}
	.editable-song .section-insert {
		appearance: none;
		position: absolute;
		left: 50%;
		z-index: 5;
		width: 1.35em;
		height: 1.35em;
		padding: 0;
		border-radius: 50%;
		border: 1px solid color-mix(in srgb, var(--section-accent) 45%, #d1d5db);
		background: #fff;
		color: var(--section-accent);
		font-size: 1.05em;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		opacity: 0;
		pointer-events: none;
		display: grid;
		place-items: center;
		box-shadow: 0 1px 4px rgba(15, 23, 42, 0.12);
		transition: opacity 120ms ease, background-color 120ms ease, transform 120ms ease;
	}
	.editable-song .section-insert--before {
		top: 0;
		transform: translate(-50%, -50%);
	}
	.editable-song .section-insert--after {
		bottom: 0;
		transform: translate(-50%, 50%);
	}
	.editable-song .song-section:hover .section-insert,
	.editable-song .section-insert:focus-visible {
		opacity: 1;
		pointer-events: auto;
	}
	.editable-song .section-insert:hover,
	.editable-song .section-insert:focus-visible {
		background: var(--section-accent);
		color: #fff;
	}
	.editable-song.is-section-dragging .section-insert {
		display: none;
	}
	@media (hover: none), (pointer: coarse) {
		.editable-song .section-insert {
			opacity: 0.72;
			pointer-events: auto;
		}
		.editable-song .line-actions {
			opacity: 0.72;
			pointer-events: auto;
		}
	}
	.editable-song .song-section--unlabeled {
		border-color: #cfd8dc;
	}
	.editable-song .song-section-label {
		grid-column: 1;
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4em 0.65em;
		min-width: 0;
		min-height: 1.65em;
		padding: 0 0.15em 0.28em 0;
		color: var(--section-accent);
		font-size: 0.78em;
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		background: transparent;
		line-height: 1.15;
	}
	.editable-song .song-section-end {
		min-width: 0;
		min-height: 1.2em;
	}
	.editable-song .song-line-wrap {
		grid-column: 1;
		position: relative;
		z-index: 1;
		min-width: 0;
	}
	.editable-song .song-line-wrap:hover,
	.editable-song .song-section-label:hover {
		z-index: 6;
	}
	.editable-song .line-actions {
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(50cqi + 1.2rem);
		right: auto;
		z-index: 4;
		display: flex;
		align-items: stretch;
		gap: 0.3rem;
		padding: 2px 0.45rem;
		font-size: 16px;
		isolation: isolate;
		background: #fff;
		box-shadow: 0 0 0 6px #fff;
		opacity: 0;
		pointer-events: none;
		transition: opacity 80ms ease;
	}
	.editable-song .line-actions::before {
		content: '';
		position: absolute;
		inset: -2px -8px;
		z-index: -1;
		background: #fff;
	}
	.editable-song .song-line-wrap:hover .line-actions,
	.editable-song .song-section-label:hover:not(:has(.section-header-edit:focus)) .line-actions,
	.editable-song .song-section-label.is-empty:hover .line-actions,
	.editable-song .line-actions:focus-within {
		opacity: 1;
		pointer-events: auto;
	}
	.editable-song .line-delete {
		appearance: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.7rem;
		margin: 0;
		padding: 0;
		border: 1px solid #d1d5db;
		border-radius: 5px;
		background: #fff;
		color: #6b7280;
		cursor: pointer;
		line-height: 0;
	}
	.editable-song .line-delete:hover {
		border-color: #ef4444;
		background: rgba(239, 68, 68, 0.08);
		color: #ef4444;
	}
	.editable-song .line-insert {
		appearance: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.7rem;
		margin: 0;
		padding: 0;
		border: 1px solid #d1d5db;
		border-radius: 5px;
		background: #fff;
		color: #6b7280;
		cursor: pointer;
		line-height: 0;
	}
	.editable-song .line-insert:hover {
		border-color: #9ca3af;
		background: #f3f4f6;
		color: #374151;
	}
	.editable-song .line-kind {
		appearance: none;
		-webkit-appearance: none;
		box-sizing: border-box;
		margin: 0;
		width: 7.25rem;
		min-width: 7.25rem;
		max-width: 7.25rem;
		height: auto;
		padding: 0 1.7em 0 0.7em;
		border: 1px solid #d1d5db;
		border-radius: 5px;
		background-color: #fff;
		background-image: var(--site-caret-down);
		background-position: right 0.45em center;
		background-size: 0.38rem 0.28rem;
		background-repeat: no-repeat;
		color: #4b5563;
		font: 500 13px/1 var(--font-sans);
		font-style: normal;
		letter-spacing: 0;
		text-transform: none;
		cursor: pointer;
	}
	.editable-song .line-kind option {
		font: 500 13px/1.3 var(--font-sans);
		text-transform: none;
		letter-spacing: 0;
	}
	.editable-song .line-kind:hover,
	.editable-song .line-kind:focus-visible {
		border-color: #9ca3af;
		outline: none;
		color: #374151;
	}
	.editable-song .song-section-ellipsis {
		color: var(--section-accent);
		opacity: 0.55;
		letter-spacing: 0.15em;
		font-weight: 700;
	}
	.editable-song .song-section-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(8em, max-content);
		column-gap: 1em;
		row-gap: 0.18em;
		align-items: center;
		width: 100%;
	}
	.editable-song .song-section-grid :global(.rhythm-cell) {
		justify-self: stretch;
		text-align: right;
		margin-left: 0;
	}
	.editable-song:not(.read-only) .song-section-label,
	.editable-song:not(.read-only) .section-drag-handle {
		cursor: grab;
	}
	.editable-song:not(.read-only) .song-section-label:active,
	.editable-song:not(.read-only) .section-drag-handle:active {
		cursor: grabbing;
	}
	.editable-song .section-drag-handle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 0.95em;
		height: 1.15em;
		color: inherit;
		opacity: 0.45;
		touch-action: none;
	}
	.editable-song .song-section-label:hover .section-drag-handle,
	.editable-song .song-section-label:focus-within .section-drag-handle {
		opacity: 1;
	}
	.editable-song .section-header-edit {
		flex: 1 1 auto;
		min-width: 6ch;
		display: inline-block;
		padding: 0;
		border: 0;
		border-radius: 0;
		font-size: inherit;
		font-weight: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		color: inherit;
		background: transparent;
		-webkit-user-drag: none;
	}
	.editable-song.is-section-dragging {
		gap: 0.55rem;
		min-height: 8rem;
	}
	.editable-song.is-section-dragging .song-section-grid {
		grid-template-columns: minmax(0, 1fr);
	}
	.editable-song.is-section-dragging .section-header-actions,
	.editable-song.is-section-dragging .line-actions {
		display: none;
	}
	.editable-song.is-section-dragging .section-header-edit {
		pointer-events: none;
	}
	.editable-song .song-section.section-drag-source {
		opacity: 0.4;
	}
	.editable-song .song-section.section-drop-after::after,
	.editable-song .song-section.section-drop-before::before {
		content: '';
		position: absolute;
		left: 0.2rem;
		right: 0.2rem;
		height: 3px;
		border-radius: 2px;
		background: var(--color-accent, #f59e0b);
		box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.18);
		pointer-events: none;
	}
	.editable-song .song-section.section-drop-after::after {
		bottom: -0.4rem;
	}
	.editable-song .song-section.section-drop-before::before {
		top: -0.4rem;
	}
	.editable-song .section-header-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.35em 0.55em;
		margin-left: auto;
		flex: 0 0 auto;
		opacity: 1;
	}
	.editable-song .section-copy-link {
		appearance: none;
		display: inline-flex;
		align-items: center;
		padding: 0.08rem 0;
		border: none;
		background: transparent;
		color: color-mix(in srgb, var(--section-accent) 72%, #64748b);
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		white-space: nowrap;
		cursor: pointer;
	}
	.editable-song .section-copy-link:hover {
		color: var(--color-accent, #f59e0b);
	}
	.editable-song .section-action-btn {
		appearance: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6em;
		height: 1.6em;
		padding: 0;
		border-radius: 50%;
		border: 1px solid color-mix(in srgb, var(--section-accent) 28%, #d1d5db);
		background: #fff;
		color: color-mix(in srgb, var(--section-accent) 72%, #6b7280);
		cursor: pointer;
		line-height: 0;
		transition: background-color 120ms ease, color 120ms ease, transform 120ms ease;
	}
	.editable-song .section-action-btn:hover {
		background: rgba(245, 158, 11, 0.18);
		color: var(--color-accent, #f59e0b);
	}
	.editable-song .section-action-btn--bass:hover {
		background: rgba(13, 148, 136, 0.18);
		color: #0f766e;
	}
	.editable-song .section-action-btn--danger:hover {
		background: rgba(239, 68, 68, 0.2);
		color: #ef4444;
	}
	.editable-song .section-action-btn .chevron {
		transition: transform 150ms ease;
	}
	.editable-song .section-action-btn.is-active .chevron {
		transform: rotate(-90deg);
	}
	.editable-song .song-section--collapsed .song-section-label {
		opacity: 0.82;
	}
	.editable-song .lyrics-cell,
	.editable-song .section-header-edit {
		outline: none;
		caret-color: var(--color-accent);
	}
	.editable-song .lyrics-cell {
		min-width: 1ch;
	}
	.editable-song .lyrics-cell:focus,
	.editable-song .section-header-edit:focus {
		background: rgba(245, 158, 11, 0.08);
		border-radius: 3px;
	}
	.editable-song .lyrics-cell:hover {
		background: rgba(245, 158, 11, 0.04);
		border-radius: 3px;
	}
	.editable-song .blank-cell {
		min-height: 1.2em;
	}
	.editable-song.is-pristine .blank-cell:empty::before {
		content: 'Skriv eller paste sang her — fx [Verse 1] og chord/lyric-linjer fra Ultimate Guitar';
		color: var(--color-ink-faint);
		font-style: italic;
		pointer-events: none;
	}
	.editable-song .chord-cell {
		font-family: var(--font-mono);
		color: var(--color-chord);
		font-weight: 600;
		font-size: 14px;
	}
	.editable-song .chord-cell-clickable,
	.editable-song .rhythm-cell-clickable {
		cursor: pointer;
		white-space: pre;
		border-radius: 3px;
		padding: 0 0.15rem;
		min-height: 1.2em;
		transition: background-color 100ms ease, box-shadow 100ms ease, opacity 100ms ease;
	}
	.editable-song .rhythm-cell-clickable,
	.editable-song .rhythm-cell-clickable :global(*),
	.editable-song .chord-cell-clickable,
	.editable-song .chord-cell-clickable :global(*) {
		cursor: pointer;
	}
	.editable-song .chord-cell-clickable:hover,
	.editable-song .chord-cell-clickable:focus-visible,
	.editable-song .rhythm-cell-clickable:hover {
		background: rgba(245, 158, 11, 0.08);
		outline: none;
	}
	.editable-song .chord-cell-clickable.drag-source,
	.editable-song .rhythm-cell-clickable.drag-source {
		opacity: 0.45;
	}
	.editable-song .chord-cell-clickable.drop-target,
	.editable-song .rhythm-cell-clickable.drop-target {
		background: rgba(245, 158, 11, 0.22);
		box-shadow: inset 0 0 0 2px var(--color-accent, #f59e0b);
	}
	@media print {
		.editable-song .chord-cell-clickable,
		.editable-song .rhythm-cell-clickable {
			cursor: auto;
			background: transparent !important;
			box-shadow: none !important;
		}
		.editable-song .section-drag-handle,
		.editable-song .section-insert,
		.editable-song .section-header-actions,
		.editable-song .line-actions {
			display: none;
		}
		.editable-song .song-section-grid {
			grid-template-columns: minmax(0, 1fr) minmax(8em, max-content);
		}
	}
	.editable-song .lyric-cell {
		font-weight: 700;
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}

	/* ── Modal ─────────────────────────────────────────────────────── */
	.bass-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 23, 42, 0.45);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
		padding: 1rem;
	}
	.bass-modal {
		background: #fff;
		border-radius: 12px;
		padding: 1.4rem 1.6rem 1.2rem;
		min-width: 380px;
		max-width: min(560px, 92vw);
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
	}
	.bass-modal h3 {
		margin: 0 0 0.4rem;
		font-size: 1.05rem;
		font-weight: 700;
		color: #111827;
	}
	.bass-modal-hint {
		margin: 0 0 1rem;
		font-size: 0.85rem;
		line-height: 1.4;
		color: #6b7280;
	}
	.bass-modal-input {
		width: 100%;
		font-family: var(--font-mono);
		font-size: 1rem;
		font-weight: 600;
		padding: 0.55rem 0.7rem;
		border: 1.5px solid #d1d5db;
		border-radius: 6px;
		outline: none;
		transition: border-color 100ms ease, box-shadow 100ms ease;
		box-sizing: border-box;
	}
	.bass-modal-input:focus {
		border-color: var(--color-accent, #f59e0b);
		box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18);
	}
	.bass-modal-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.bass-modal-btn {
		appearance: none;
		font-size: 0.9rem;
		font-weight: 600;
		padding: 0.45rem 0.95rem;
		border-radius: 6px;
		border: 1px solid #d1d5db;
		background: #fff;
		color: #1f2937;
		cursor: pointer;
		transition: background 100ms ease, border-color 100ms ease;
	}
	.bass-modal-btn:hover {
		background: #f3f4f6;
	}
	.bass-modal-btn--primary {
		background: var(--color-accent, #f59e0b);
		border-color: var(--color-accent, #f59e0b);
		color: #fff;
	}
	.bass-modal-btn--primary:hover {
		background: #d97706;
		border-color: #d97706;
	}
	.editable-song .section-header-edit:empty::before {
		content: 'FORM';
		opacity: 0.35;
		pointer-events: none;
	}
</style>
