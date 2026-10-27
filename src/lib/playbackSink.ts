const STORAGE_KEY = 'faellesbandet.sink-id';
const LABEL_KEY = 'faellesbandet.sink-label';

export type PlaybackDevice = {
	deviceId: string;
	label: string;
};

type SinkContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
type SinkElement = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };

export type PlaybackTap = {
	node: AudioNode;
	close: () => void;
};

export function readSinkId(): string {
	if (typeof localStorage === 'undefined') return '';
	return localStorage.getItem(STORAGE_KEY) ?? '';
}

export function writeSinkId(id: string, label = '') {
	localStorage.setItem(STORAGE_KEY, id);
	localStorage.setItem(LABEL_KEY, id ? label : '');
}

export function readSinkLabel(): string {
	if (typeof localStorage === 'undefined') return '';
	return localStorage.getItem(LABEL_KEY) ?? '';
}

export function isIOS(): boolean {
	if (typeof navigator === 'undefined') return false;
	return (
		/iPhone|iPad|iPod/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	);
}

/**
 * iOS couples a Bluetooth headset's output and mic: playing to it makes it the input too.
 * The phone's own speaker and receiver do not.
 */
export function isHeadsetSink(id: string, label: string): boolean {
	return !!id && !/speaker|højttaler|receiver|iphone|ipad/i.test(label);
}

export function sinkTakesMic(): boolean {
	return isIOS() && isHeadsetSink(readSinkId(), readSinkLabel());
}

function realOutputs(devices: MediaDeviceInfo[]) {
	return devices.filter(
		(device) =>
			device.kind === 'audiooutput' &&
			device.deviceId &&
			device.deviceId !== 'default' &&
			device.deviceId !== 'communications'
	);
}

function rank(label: string): number {
	const text = label.toLowerCase();
	if (/airpod|headset|headphone|bluetooth|høretelefon/.test(text)) return 0;
	if (/speaker|iphone|ipad|receiver|built-in|macbook/.test(text)) return 2;
	return 1;
}

export function standardSinkLabel(devices: MediaDeviceInfo[]): string {
	const marked = devices.find(
		(device) =>
			device.kind === 'audiooutput' &&
			(device.deviceId === 'default' || /^default\b/i.test(device.label))
	);
	const name = marked?.label?.replace(/^default\s*[-–:]\s*/i, '').trim();
	return name ? `Standard (${name})` : 'Standard';
}

export async function listPlaybackDevices(): Promise<{
	devices: PlaybackDevice[];
	standardLabel: string;
	labeled: boolean;
}> {
	if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
		return { devices: [], standardLabel: 'Standard', labeled: false };
	}
	const found = await navigator.mediaDevices.enumerateDevices();
	const outputs = realOutputs(found);
	const labeled = outputs.some((device) => !!device.label);
	const devices = outputs
		.map((device, index) => ({
			deviceId: device.deviceId,
			label: device.label || `Udgang ${index + 1}`
		}))
		.sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label, 'da'));
	return { devices, standardLabel: standardSinkLabel(found), labeled };
}

/** Remember the output while the tap is still a user gesture, so later clicks may use it. */
export async function primePlaybackSink(id: string) {
	if (!id || typeof HTMLAudioElement === 'undefined') return;
	const el = document.createElement('audio') as SinkElement;
	if (!el.setSinkId) return;
	try {
		await el.setSinkId(id);
	} catch {
		/* the next playback falls back to the default route */
	}
}

/**
 * Where clicks and headphone monitoring should play.
 * An explicit device uses AudioContext.setSinkId, or on iPhone an <audio> element,
 * so the built-in mic can stay selected without forcing the speaker.
 */
export async function openPlaybackTap(ctx: AudioContext): Promise<PlaybackTap> {
	const id = readSinkId();
	const direct = ctx as SinkContext;
	if (id && direct.setSinkId) {
		try {
			await direct.setSinkId(id);
			return { node: ctx.destination, close() {} };
		} catch {
			/* try the element path */
		}
	}
	const el = document.createElement('audio') as SinkElement;
	if (!id || !el.setSinkId) return { node: ctx.destination, close() {} };

	const dest = ctx.createMediaStreamDestination();
	el.srcObject = dest.stream;
	el.autoplay = true;
	el.setAttribute('playsinline', '');
	el.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none';
	document.body.appendChild(el);
	const close = () => {
		el.pause();
		el.srcObject = null;
		el.remove();
	};
	try {
		await el.setSinkId(id);
		await el.play();
	} catch {
		close();
		return { node: ctx.destination, close() {} };
	}
	return { node: dest, close };
}
