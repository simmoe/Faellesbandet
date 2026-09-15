<script lang="ts">
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
		colorFor,
		onToggle
	}: Props = $props();

	let open = $state(false);
	let rootEl = $state<HTMLDivElement | null>(null);

	const triggerColor = $derived(triggerValue ? colorFor(triggerValue).text : '');
	const emptySelected = $derived(selected.length === 0);

	function isSelected(value: string): boolean {
		if (!value) return emptySelected;
		const needle = value.toLocaleLowerCase('da');
		return selected.some((cat) => cat.toLocaleLowerCase('da') === needle);
	}

	function choose(value: string): void {
		onToggle(value);
		open = false;
	}

	$effect(() => {
		if (!open) return;
		const close = (e: PointerEvent) => {
			if (rootEl && !rootEl.contains(e.target as Node)) open = false;
		};
		window.addEventListener('pointerdown', close);
		return () => window.removeEventListener('pointerdown', close);
	});
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') open = false;
	}}
/>

<div class="category-picker {variant}" bind:this={rootEl}>
	<button
		type="button"
		class="category-picker-trigger"
		class:is-open={open}
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label={ariaLabel}
		onclick={() => (open = !open)}
	>
		{#if triggerValue}
			<span class="cat-mark" style:color={triggerColor} aria-hidden="true"></span>
		{/if}
		<span class="category-picker-label">{triggerLabel}</span>
		<span class="category-picker-caret" aria-hidden="true"></span>
	</button>
	{#if open}
		<ul class="category-picker-menu" role="listbox">
			{#if emptyOption}
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
			{#each options as opt (opt.value)}
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
	.category-picker-trigger:focus {
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
