import { AttachmentBuilder, type Message } from "discord.js";
import type { DiscordMessage } from "../messageTypes.ts";
import { renderBurnGif } from "./burn.ts";
import { renderMessageCard } from "./card.ts";
import { renderDustGif } from "./dust.ts";
import type { EffectGif, EffectOptions, RgbaImage } from "./effect.ts";
import { extractPreviewFrame } from "./preview.ts";

export { renderBurnGif, renderDustGif, renderMessageCard };

const AVATAR_SIZE = 128;
const FETCH_TIMEOUT_MS = 5_000;
// leave the empty gif up briefly so slow clients still see the whole thing
const LINGER_AFTER_EFFECT_MS = 1_500;

export const EFFECTS = {
	burn: { render: renderBurnGif, caption: "-# no 👀 detected" },
	dust: {
		render: renderDustGif,
		caption: "-# no 👀 detected. i don't feel so good",
	},
} satisfies Record<
	string,
	{
		render: (
			card: RgbaImage,
			options: Partial<EffectOptions>,
		) => Promise<EffectGif>;
		caption: string;
	}
>;

export type EffectName = keyof typeof EFFECTS;
const MENTION_START = "\ue000";
const MENTION_END = "\ue001";

export type IncinerateOptions = {
	// already-downloaded media to show on the card, so we don't fetch twice
	media?: { bytes: Buffer; sourceLabel: string } | null;
	// random (but stable per message) when not given
	effect?: EffectName;
	timeZone?: string;
	scheduleCleanup?: (cleanup: () => void, delayMs: number) => void;
};

/**
 * Replaces a message with a gif of itself burning away (or turning to dust),
 * then removes the gif once it has played. Falls back to a plain delete if
 * rendering fails, so a broken renderer never lets a message through.
 */
export async function incinerateMessage(
	message: DiscordMessage,
	options: IncinerateOptions = {},
): Promise<void> {
	const effect = options.effect ?? pickEffect(message.id ?? "");
	const startedAt = performance.now();
	const rendered = await renderMessageEffect(message, effect, options).catch(
		(error) => {
			console.error(
				"[bot] failed rendering incineration, deleting",
				error,
			);
			return null;
		},
	);

	if (!rendered || typeof message.channel?.send !== "function") {
		await message.delete();
		return;
	}

	const renderedAt = performance.now();
	// Upload first, delete second: the gif opens on the intact message, so
	// the swap looks seamless instead of leaving a gap while it uploads.
	const sent: Message = await message.channel.send({
		content: EFFECTS[effect].caption,
		files: [
			new AttachmentBuilder(rendered.gif, { name: "incinerated.gif" }),
		],
		allowedMentions: { parse: [] },
	});

	try {
		await message.delete();
	} catch (error) {
		// can't remove the original, so don't leave a fake funeral behind
		await sent.delete().catch(() => {});
		throw error;
	}
	console.log(
		`[bot] ${effect} sent: render ${Math.round(renderedAt - startedAt)}ms, upload+delete ${Math.round(performance.now() - renderedAt)}ms, ${(rendered.gif.length / 1024).toFixed(0)}KB`,
	);

	const schedule =
		options.scheduleCleanup ??
		((cleanup, delayMs) => void setTimeout(cleanup, delayMs));
	schedule(() => {
		sent.delete().catch((error: unknown) => {
			console.error("[bot] failed cleaning up incineration gif", error);
		});
	}, rendered.durationMs + LINGER_AFTER_EFFECT_MS);
}

export function pickEffect(messageId: string): EffectName {
	const names = Object.keys(EFFECTS) as EffectName[];
	return names[hashString(messageId) % names.length]!;
}

export async function renderMessageEffect(
	message: DiscordMessage,
	effect: EffectName,
	options: IncinerateOptions = {},
): Promise<EffectGif> {
	const [avatar, media] = await Promise.all([
		fetchAvatar(message),
		options.media
			? extractPreviewFrame(
					options.media.bytes,
					options.media.sourceLabel,
				)
			: Promise.resolve(null),
	]);

	const card = await renderMessageCard({
		displayName:
			message.member?.displayName ??
			message.author?.globalName ??
			message.author?.username ??
			"someone",
		nameColor: message.member?.displayHexColor ?? null,
		avatar,
		timestamp: message.createdAt ?? new Date(),
		content: formatMessageContent(message),
		media,
		isEdited: Boolean(message.editedTimestamp),
		timeZone: options.timeZone,
	});

	// same message, same fire
	return EFFECTS[effect].render(card, { seed: hashString(message.id ?? "") });
}

function hashString(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
	}
	return hash >>> 0;
}

async function fetchAvatar(message: DiscordMessage): Promise<Buffer | null> {
	const avatarOptions = {
		extension: "png",
		size: AVATAR_SIZE,
		forceStatic: true,
	} as const;
	const url =
		message.member?.displayAvatarURL(avatarOptions) ??
		message.author?.displayAvatarURL(avatarOptions);
	if (!url) {
		return null;
	}

	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
	} catch (error) {
		console.error("[bot] failed fetching avatar", error);
		return null;
	}
}

/**
 * Resolves the raw message syntax (<@id>, <#id>, <:emoji:id>, <t:unix>) into
 * what a reader would see. Mentions are wrapped in private-use markers so the
 * card renderer can draw them as pills.
 */
export function formatMessageContent(message: DiscordMessage): string {
	const content = message.content ?? "";
	if (isBareEmbeddedLink(message)) {
		return "";
	}

	const mention = (label: string) => `${MENTION_START}${label}${MENTION_END}`;
	const mentions = message.mentions;

	return content
		.replace(/<@!?(\d+)>/g, (_, id: string) => {
			const name =
				mentions?.members?.get(id)?.displayName ??
				mentions?.users?.get(id)?.globalName ??
				mentions?.users?.get(id)?.username ??
				"unknown-user";
			return mention(`@${name}`);
		})
		.replace(/<@&(\d+)>/g, (_, id: string) =>
			mention(`@${mentions?.roles?.get(id)?.name ?? "unknown-role"}`),
		)
		.replace(/<#(\d+)>/g, (_, id: string) => {
			const channel = mentions?.channels?.get(id);
			const name =
				channel && "name" in channel && channel.name
					? channel.name
					: "unknown";
			return mention(`#${name}`);
		})
		.replace(/<a?:(\w+):\d+>/g, ":$1:")
		.replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, seconds: string) =>
			new Date(Number(seconds) * 1000).toLocaleString("en-NZ"),
		);
}

/** Discord hides the link text when a message is just a gif/image link. */
function isBareEmbeddedLink(message: DiscordMessage): boolean {
	const content = (message.content ?? "").trim();
	return (
		/^https?:\/\/\S+$/.test(content) &&
		(message.embeds ?? []).some(
			(embed) => embed.video || embed.image || embed.thumbnail,
		)
	);
}
