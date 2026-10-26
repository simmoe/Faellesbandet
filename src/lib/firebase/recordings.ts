import { httpsCallable } from 'firebase/functions';
import { getFns } from './client';

/** Hent optagelsens bytes via funktionen, så Storage-CORS ikke blokerer overdub. */
export async function recordingAudioBytes(path: string): Promise<ArrayBuffer> {
	if (!path) throw new Error('Optagelsen mangler en fil.');
	const callable = httpsCallable<{ path: string }, { dataUrl: string }>(
		getFns(),
		'recordingAudioDataUrl'
	);
	const result = await callable({ path });
	const dataUrl = result.data?.dataUrl;
	if (!dataUrl?.startsWith('data:audio/')) {
		throw new Error('Kunne ikke hente optagelsen.');
	}
	const response = await fetch(dataUrl);
	if (!response.ok) throw new Error('Kunne ikke hente optagelsen.');
	return response.arrayBuffer();
}
