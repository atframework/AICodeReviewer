/**
 * WeCom application report splitting (design §3, O05): packs rendered report
 * sections into platform-sized parts. Every part keeps whole sections where
 * possible; oversized sections split at line boundaries and a single
 * oversized line splits at code-point boundaries, so no multi-byte UTF-8
 * character is ever cut in half.
 */

const CONTENT_MAX_BYTES = 2048;

export const WECOM_APP_CONTENT_MAX_BYTES = CONTENT_MAX_BYTES;

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function chunkMarkdownSections(sections: readonly string[], maxBytes = CONTENT_MAX_BYTES): string[] {
	const parts: string[] = [];
	let current = "";
	const flush = (): void => {
		if (current.trim().length > 0) parts.push(current.trim());
		current = "";
	};
	const appendPiece = (piece: string): void => {
		const candidate = current === "" ? piece : `${current}\n${piece}`;
		if (byteLength(candidate) <= maxBytes) {
			current = candidate;
			return;
		}
		flush();
		if (byteLength(piece) <= maxBytes) {
			current = piece;
			return;
		}
		// The piece alone exceeds the cap: split it by lines, then characters.
		let lineBuffer = "";
		for (const line of piece.split("\n")) {
			const joined = lineBuffer === "" ? line : `${lineBuffer}\n${line}`;
			if (byteLength(joined) <= maxBytes) {
				lineBuffer = joined;
				continue;
			}
			if (lineBuffer.trim().length > 0) appendPiece(lineBuffer);
			lineBuffer = "";
			if (byteLength(line) <= maxBytes) {
				lineBuffer = line;
				continue;
			}
			let charBuffer = "";
			for (const char of line) {
				if (byteLength(charBuffer + char) > maxBytes) {
					appendPiece(charBuffer);
					charBuffer = char;
				} else {
					charBuffer += char;
				}
			}
			if (charBuffer.length > 0) appendPiece(charBuffer);
		}
		if (lineBuffer.trim().length > 0) appendPiece(lineBuffer);
	};
	for (const section of sections) {
		if (section.trim().length === 0) continue;
		appendPiece(section.trim());
	}
	flush();
	return parts;
}
