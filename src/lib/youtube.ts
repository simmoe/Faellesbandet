const YOUTUBE_HOSTS = new Set([
	'youtube.com',
	'm.youtube.com',
	'music.youtube.com',
	'youtu.be',
	'youtube-nocookie.com'
]);

export function youtubeVideoId(value: string): string | null {
	try {
		const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
		const url = new URL(withProtocol);
		const host = url.hostname.replace(/^www\./, '').toLowerCase();
		if (!YOUTUBE_HOSTS.has(host)) return null;
		if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
		const parts = url.pathname.split('/').filter(Boolean);
		if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
			return parts[1] || null;
		}
		return url.searchParams.get('v');
	} catch {
		return null;
	}
}

export function youtubeWatchUrl(value: string): string | null {
	const id = youtubeVideoId(value);
	return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

export function youtubeEmbedUrl(value: string): string | null {
	const id = youtubeVideoId(value);
	return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}
