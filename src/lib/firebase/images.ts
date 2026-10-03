import { getBytes, ref } from 'firebase/storage';
import { getStorageBucket } from './client';

export async function categoryImageDataUrl(imagePath: string): Promise<string> {
	const bytes = await getBytes(ref(getStorageBucket(), imagePath));
	const blob = new Blob([bytes]);
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result?.toString() ?? '');
		reader.onerror = () => reject(reader.error ?? new Error('Kunne ikke læse kategori-billede'));
		reader.readAsDataURL(blob);
	});
}
