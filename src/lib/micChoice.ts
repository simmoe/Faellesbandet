const STORAGE_KEY = 'faellesbandet.mic-id';

export type MicDevice = {
	deviceId: string;
	label: string;
};

export function readMicDeviceId(): string {
	if (typeof localStorage === 'undefined') return '';
	return localStorage.getItem(STORAGE_KEY) ?? '';
}

export function writeMicDeviceId(id: string) {
	localStorage.setItem(STORAGE_KEY, id);
}

/** Pin capture to the chosen input. Empty id keeps the browser default. */
export function applyMicDevice(constraints: MediaTrackConstraints): MediaTrackConstraints {
	const id = readMicDeviceId();
	if (!id) return constraints;
	return { ...constraints, deviceId: { exact: id } };
}

function realInputs(devices: MediaDeviceInfo[]) {
	return devices.filter(
		(device) =>
			device.kind === 'audioinput' &&
			device.deviceId &&
			device.deviceId !== 'default' &&
			device.deviceId !== 'communications'
	);
}

function rank(label: string): number {
	const text = label.toLowerCase();
	if (/built-in|macbook|imac|iphone|ipad|internal/.test(text)) return 0;
	if (/airpod|headset|headphone|bluetooth|høretelefon/.test(text)) return 2;
	return 1;
}

let probedDefault = '';

export function standardMicLabel(devices: MediaDeviceInfo[]): string {
	const marked = devices.find(
		(device) =>
			device.kind === 'audioinput' &&
			(device.deviceId === 'default' || /^default\b/i.test(device.label))
	);
	const name = marked?.label?.replace(/^default\s*[-–:]\s*/i, '').trim();
	return name ? `Standard (${name})` : probedDefault ? `Standard (${probedDefault})` : 'Browserens standard';
}

async function probeDefaultLabel() {
	if (probedDefault || !navigator.mediaDevices?.getUserMedia) return;
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
		video: false
	});
	probedDefault = stream.getAudioTracks()[0]?.label?.trim() ?? '';
	for (const track of stream.getTracks()) track.stop();
}

export async function listMicrophones(ask: boolean): Promise<{
	mics: MicDevice[];
	standardLabel: string;
	labeled: boolean;
}> {
	if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
		return { mics: [], standardLabel: 'Browserens standard', labeled: false };
	}
	let devices = await navigator.mediaDevices.enumerateDevices();
	let inputs = realInputs(devices);
	if (ask && (inputs.length === 0 || inputs.some((device) => !device.label))) {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
			video: false
		});
		for (const track of stream.getTracks()) track.stop();
		devices = await navigator.mediaDevices.enumerateDevices();
		inputs = realInputs(devices);
	}
	const labeled = inputs.some((device) => !!device.label);
	if (labeled) {
		try {
			await probeDefaultLabel();
		} catch {
			/* the select still lists the named inputs */
		}
	}
	const mics = inputs
		.map((device, index) => ({
			deviceId: device.deviceId,
			label: device.label || `Mikrofon ${index + 1}`
		}))
		.sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label, 'da'));
	return { mics, standardLabel: standardMicLabel(devices), labeled };
}
