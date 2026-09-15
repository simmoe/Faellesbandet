<script lang="ts">
	import { tick } from 'svelte';

	export type CategoryPickerOption = { value: string; label: string };
	export type CategoryPickerColor = { text: string };

	interface Props {
		options: CategoryPickerOption[];
		selected: string[];
		triggerLabel: string;
		triggerValue?: string;
		emptyOption?: CategoryPickerOption | null;
		ariaLabel: string;
		variant?: 'joined' | 'default';
		allowCreate?: boolean;
		colorFor: (cat: string) => CategoryPickerColor;
		onToggle: (value: string) => void;
	}

	const {
		options,
		selected,
		triggerLabel,
		triggerValue = '',
		emptyOption = null,
		ariaLabel,
		variant = 'default',
		allowCreate = false,
		colorFor,
		onToggle
	}: Props = $props();

	let open = $state(false);
	let draft = $state('');
	let rootEl = $state<HTMLDivElement | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);

	const triggerColor = $derived(triggerValue ? colorFor(triggerValue).text : '');
	const emptySelected = $derived(selected.length === 0);
	const query = $derived(draft.trim());
	const queryKey = $derived(query.toLocaleLowerCase('da'));
	const visibleOptions = $derived.by(() => {
		if (!queryKey) return options;
		return options.filter(
			(opt) =>
				opt.label.toLocaleLowerCase('da').includes(queryKey) ||
				opt.value.toLocaleLowerCase('da').includes(queryKey)
		);
	});
	const exactMatch = $derived(
		options.find((opt) => opt.value.toLocaleLowerCase('da') === queryKey) ?? null
	);
	const canCreate = $derived(allowCreate && query.length > 0 && !exactMatch);

	function isSelected(value: string): boolean {
		if (!value) return emptySelected;
		const needle = value.toLocaleLowerCase('da');
		return selected.some((cat) => cat.toLocaleLowerCase('da') === needle);
	}

	function choose(value: string): void {
		onToggle(value);
		draft = '';
		open = false;
	}

	function commitDraft(): void {
		if (!query) return;
		choose(exactMatch?.value ?? query);
	}

	async function setOpen(next: boolean): Promise<void> {
		open = next;
		if (next && allowCreate) {
			await tick();
			inputEl?.focus();
		}
		if (!next) draft = '';
	}

	function onDraftKey(e: KeyboardEvent): void {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			commitDraft();
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			void setOpen(false);
		}
	}

	$effect(() => {
		if (!open) return;
		const close = (e: PointerEvent) => {
			if (rootEl && !rootEl.contains(e.target as Node)) void setOpen(false);
		};
		window.addEventListener('pointerdown', close);
		return () => window.removeEventListener('pointerdown', close);
	});
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && open) void setOpen(false);
	}}
/>

<div class="category-picker {variant}" bind:this={rootEl}>
	{#if allowCreate}
		<div class="category-picker-trigger is-editable" class:is-open={open}>
			<input
				bind:this={inputEl}
				class="category-picker-input"
				type="text"
				placeholder={triggerLabel}
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				bind:value={draft}
				onfocus={() => (open = true)}
				oninput={() => (open = true)}
				onkeydown={onDraftKey}
			/>
			<button
				type="button"
				class="category-picker-caret-btn"
				tabindex="-1"
				aria-label="Vis kategorier"
				onclick={() => void setOpen(!open)}
			>
				<span class="category-picker-caret" aria-hidden="true"></span>
			</button>
		</div>
	{:else}
		<button
			type="button"
			class="category-picker-trigger"
			class:is-open={open}
			aria-haspopup="listbox"
			aria-expanded={open}
			aria-label={ariaLabel}
			onclick={() => void setOpen(!open)}
		>
			{#if triggerValue}
				<span class="cat-mark" style:color={triggerColor} aria-hidden="true"></span>
			{/if}
			<span class="category-picker-label">{triggerLabel}</span>
			<span class="category-picker-caret" aria-hidden="true"></span>
		</button>
	{/if}
	{#if open}
		<ul class="category-picker-menu" role="listbox">
			{#if canCreate}
				<li>
					<button
						type="button"
						class="category-picker-option"
						role="option"
						aria-selected="false"
						onclick={commitDraft}
					>
						Tilføj “{query}”
					</button>
				</li>
			{/if}
			{#if emptyOption && !queryKey}
				<li>
					<button
						type="button"
						class="category-picker-option"
						class:is-active={emptySelected}
						role="option"
						aria-selected={emptySelected}
						onclick={() => choose(emptyOption.value)}
					>
						{emptyOption.label}
					</button>
				</li>
			{/if}
			{#each visibleOptions as opt (opt.value)}
				{@const c = colorFor(opt.value)}
				{@const active = isSelected(opt.value)}
				<li>
					<button
						type="button"
						class="category-picker-option"
						class:is-active={active}
						style:--cat-color={c.text}
						role="option"
						aria-selected={active}
						onclick={() => choose(opt.value)}
					>
						<span class="cat-mark" aria-hidden="true"></span>
						{opt.label}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.category-picker {
		position: relative;
		display: flex;
		flex: 0 0 auto;
		height: 2.35rem;
	}
	.category-picker-trigger {
		appearance: none;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		height: 100%;
		background: #ffffff;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-button);
		padding: 0 0.7rem 0 0.8rem;
		color: var(--color-ink);
		font-weight: 500;
		font-size: 0.82rem;
		min-width: 12.5rem;
		max-width: 18rem;
		cursor: pointer;
	}
	.joined .category-picker-trigger {
		border-right: 0;
		border-radius: var(--radius-button) 0 0 var(--radius-button);
	}
	.category-picker-trigger.is-editable {
		cursor: text;
		padding-right: 0.35rem;
	}
	.category-picker-input {
		flex: 1 1 auto;
		min-width: 0;
		height: 100%;
		border: 0;
		background: transparent;
		padding: 0;
		color: inherit;
		font: inherit;
		font-weight: 500;
		outline: none;
	}
	.category-picker-input::placeholder {
		color: var(--color-ink-faint);
		font-weight: 500;
	}
	.category-picker-caret-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 1.4rem;
		height: 100%;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.category-picker-label {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.category-picker-caret {
		width: 0.38rem;
		height: 0.28rem;
		flex-shrink: 0;
		background: currentColor;
		clip-path: polygon(0 0, 100% 0, 50% 100%);
		opacity: 0.7;
	}
	.category-picker-trigger.is-open .category-picker-caret {
		transform: scaleY(-1);
	}
	.category-picker-trigger:focus,
	.category-picker-trigger.is-editable:focus-within {
		outline: 2px solid var(--color-accent);
		outline-offset: -1px;
	}
	.category-picker-menu {
		position: absolute;
		top: calc(100% + 0.3rem);
		left: 0;
		z-index: 30;
		min-width: max(100%, 16rem);
		margin: 0;
		padding: 0.3rem;
		list-style: none;
		background: #ffffff;
		color: var(--color-ink);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-card);
		box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
		max-height: 18rem;
		overflow: auto;
	}
	.category-picker-option {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		border: none;
		background: transparent;
		padding: 0.4rem 0.5rem;
		border-radius: calc(var(--radius-card) * 0.7);
		color: var(--cat-color, var(--color-ink));
		font-size: 0.82rem;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
	}
	.category-picker-option:hover {
		background: #f8fafc;
	}
	.category-picker-option.is-active {
		background: #f8fafc;
		font-weight: 700;
	}
	.cat-mark {
		width: 0.2rem;
		height: 0.2rem;
		border-radius: 50%;
		background: currentColor;
		flex-shrink: 0;
	}
</style>
