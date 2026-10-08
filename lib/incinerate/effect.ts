import { spawn } from "node:child_process";

export type RgbaImage = {
	data: Buffer;
	width: number;
	height: number;
};

export type EffectOptions = {
	fps: number;
	// intact frames up front, so the swap from the real message is seamless
	holdMs: number;
	activeMs: number;
	// stragglers drifting off after the last of the card is gone
	tailMs: number;
	seed: number;
};

export type EffectGif = {
	gif: Buffer;
	durationMs: number;
	frameCount: number;
};

export type FrameEffect = (
	card: RgbaImage,
	options: EffectOptions,
) => Iterable<Buffer>;

export async function renderEffectGif(
	card: RgbaImage,
	effect: FrameEffect,
	options: EffectOptions,
): Promise<EffectGif> {
	const gif = await encodeGif(
		effect(card, options),
		card.width,
		card.height,
		options.fps,
	);
	const frameCount = getFrameCount(options);

	return {
		gif,
		durationMs: Math.round((frameCount * 1000) / options.fps),
		frameCount,
	};
}

export function createRng(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function getFrameCount(options: EffectOptions): number {
	return Math.ceil(
		((options.holdMs + options.activeMs + options.tailMs) * options.fps) /
			1000,
	);
}

/** Bilinear value noise summed over a few octaves, normalised to 0..1. */
export function buildValueNoise(
	width: number,
	height: number,
	cellSizes: number[],
	rng: () => number,
): Float32Array {
	const result = new Float32Array(width * height);
	let amplitude = 1;
	let total = 0;

	for (const cell of cellSizes) {
		const gw = Math.ceil(width / cell) + 2;
		const gh = Math.ceil(height / cell) + 2;
		const grid = new Float32Array(gw * gh);
		for (let i = 0; i < grid.length; i += 1) {
			grid[i] = rng();
		}

		for (let y = 0; y < height; y += 1) {
			const gy = y / cell;
			const y0 = gy | 0;
			const fy = smoothstep(gy - y0);
			for (let x = 0; x < width; x += 1) {
				const gx = x / cell;
				const x0 = gx | 0;
				const fx = smoothstep(gx - x0);
				const a = grid[y0 * gw + x0]!;
				const b = grid[y0 * gw + x0 + 1]!;
				const c = grid[(y0 + 1) * gw + x0]!;
				const d = grid[(y0 + 1) * gw + x0 + 1]!;
				const top = a + (b - a) * fx;
				const bottom = c + (d - c) * fx;
				result[y * width + x]! +=
					(top + (bottom - top) * fy) * amplitude;
			}
		}
		total += amplitude;
		amplitude *= 0.55;
	}

	for (let i = 0; i < result.length; i += 1) {
		result[i] = result[i]! / total;
	}
	return result;
}

export function encodeGif(
	frames: Iterable<Buffer>,
	width: number,
	height: number,
	fps: number,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const ffmpeg = spawn("ffmpeg", [
			"-v",
			"error",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			"-s",
			`${width}x${height}`,
			"-r",
			String(fps),
			"-i",
			"pipe:0",
			"-filter_complex",
			"[0:v]split[a][b];[a]palettegen=max_colors=128:reserve_transparent=1:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle:alpha_threshold=128",
			// play once, then sit on the empty last frame until we delete it
			"-loop",
			"-1",
			"-final_delay",
			"500",
			"-f",
			"gif",
			"pipe:1",
		]);

		const chunks: Buffer[] = [];
		let stderr = "";
		ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		ffmpeg.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		ffmpeg.on("error", reject);
		ffmpeg.on("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
				return;
			}
			reject(
				new Error(
					`ffmpeg gif encode failed (${code}): ${stderr.trim()}`,
				),
			);
		});
		ffmpeg.stdin.on("error", reject);

		(async () => {
			for (const frame of frames) {
				if (!ffmpeg.stdin.write(frame)) {
					await new Promise((drained) =>
						ffmpeg.stdin.once("drain", drained),
					);
				}
			}
			ffmpeg.stdin.end();
		})().catch(reject);
	});
}

export function smoothstep(t: number): number {
	return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clampByte(value: number): number {
	return value < 0 ? 0 : value > 255 ? 255 : value;
}

export function hashUnit(i: number, seed: number): number {
	let h = Math.imul(i ^ seed, 0x45d9f3b);
	h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
