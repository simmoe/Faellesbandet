<script lang="ts">
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { authState } from '$lib/auth.svelte';
	import { BAND } from '$lib/data/band';

	let email = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state('');
	const nextPath =
		browser ? new URLSearchParams(location.search).get('next') || '/songbook' : '/songbook';

	$effect(() => {
		if (!authState.loading && authState.user) goto(nextPath);
	});

	$effect(() => {
		if (authState.notAuthorized) {
			error =
				'Den valgte konto er ikke på bandets liste. Brug din bandkonto, eller bed Simo om at tilføje dig.';
		}
	});

	async function loginEmail(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		busy = true;
		try {
			await authState.loginEmail(email, password);
		} catch (err: any) {
			if (err?.code === 'auth/invalid-credential' || err?.code === 'auth/wrong-password') {
				error = 'Forkert email eller adgangskode.';
			} else if (err?.code === 'auth/user-not-found') {
				error = 'Den email findes ikke i bandet.';
			} else {
				error = 'Login mislykkedes. Prøv igen.';
			}
		} finally {
			busy = false;
		}
	}

	async function loginGoogle() {
		error = '';
		busy = true;
		try {
			await authState.loginGoogle();
		} catch (err: any) {
			if (err?.code === 'auth/popup-closed-by-user') {
				error = '';
			} else {
				error = 'Google-login mislykkedes. Prøv igen.';
			}
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Log ind · {BAND.name}</title></svelte:head>

<main class="login">
	<div class="login-brand">
		<img class="login-mark" src="/logo-mark.png?v=10" alt="" />
		<h1>{BAND.name}</h1>
		<p>{BAND.tagline}</p>
	</div>

	<div class="login-panel">
	<form class="card login-form" onsubmit={loginEmail}>
		<div>
			<label
				for="email"
				class="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-ink-muted)]"
			>
				Email
			</label>
			<input
				id="email"
				type="email"
				bind:value={email}
				required
				autocomplete="email"
				class="w-full rounded-[var(--radius-button)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-card-muted)] px-3.5 py-3 text-base text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
			/>
		</div>
		<div>
			<label
				for="password"
				class="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-ink-muted)]"
			>
				Adgangskode
			</label>
			<input
				id="password"
				type="password"
				bind:value={password}
				required
				autocomplete="current-password"
				class="w-full rounded-[var(--radius-button)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-card-muted)] px-3.5 py-3 text-base text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
			/>
		</div>

		{#if error}
			<p class="text-sm text-[var(--color-error)]">{error}</p>
		{/if}

		<button class="btn-primary w-full" type="submit" disabled={busy}>
			{busy ? 'Logger ind…' : 'Log ind'}
		</button>
	</form>

	<div class="login-or">
		<span>eller</span>
	</div>

	<button class="btn-secondary w-full" onclick={loginGoogle} disabled={busy}>
		Log ind med Google
	</button>

	<p class="login-note">Kun bandets medlemmer kan logge ind.</p>
	</div>
</main>

<style>
	.login {
		--pad: clamp(16px, 5vw, 40px);
		--gap: clamp(12px, 3vw, 24px);
		display: grid;
		align-content: center;
		justify-items: center;
		min-height: 100dvh;
		padding: var(--pad);
	}
	.login-brand,
	.login-panel {
		display: grid;
		width: min(100%, 24rem);
		gap: var(--gap);
	}
	.login-brand {
		justify-items: center;
		text-align: center;
	}
	.login-mark {
		width: clamp(72px, 22vw, 112px);
		height: clamp(72px, 22vw, 112px);
		object-fit: contain;
	}
	.login-brand h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(1.6rem, 7vw, 2.25rem);
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--color-accent);
	}
	.login-brand p {
		margin: 0;
		font-size: clamp(13px, 3.4vw, 15px);
		color: var(--color-ink-faint);
	}
	.login-form {
		display: grid;
		gap: 1rem;
		padding: clamp(16px, 4vw, 24px);
	}
	.login-or {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: 0.75rem;
		font-size: 0.75rem;
		color: var(--color-ink-faint);
	}
	.login-or::before,
	.login-or::after {
		content: '';
		height: 1px;
		background: var(--color-border);
	}
	.login-note {
		margin: 0;
		text-align: center;
		font-size: clamp(12px, 3vw, 13px);
		color: var(--color-ink-faint);
	}

	@media (orientation: landscape) and (max-height: 34rem) {
		.login {
			align-content: start;
			--pad: clamp(8px, 2vw, 16px);
		}
		.login-mark {
			width: 56px;
			height: 56px;
		}
	}
</style>
