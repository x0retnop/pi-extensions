interface DiffTheme {
	fg(color: string, text: string): string;
}

const MARKUP_LANGUAGES = new Set(["html", "htm", "xml", "svg", "xhtml"]);
const MARKUP_TOKEN_PATTERN = /<!--[\s\S]*?-->|<\/?[\w:-]+(?:\s+[\w:@.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g;
const MARKUP_PART_PATTERN = /<\/?|\/?>|[\w:-]+|[\w:@.-]+(?=\s*=)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|=|\s+|./g;

export function isMarkupLikeLanguage(language: string | undefined): boolean {
	return typeof language === "string" && MARKUP_LANGUAGES.has(language.toLowerCase());
}

function colorizeToken(theme: DiffTheme, color: string, text: string): string {
	return text ? theme.fg(color, text) : text;
}

export function shouldUseMarkupHighlighter(language: string | undefined, line: string): boolean {
	if (isMarkupLikeLanguage(language)) {
		return true;
	}
	if (!line) {
		return false;
	}
	MARKUP_TOKEN_PATTERN.lastIndex = 0;
	return language === "markdown" && MARKUP_TOKEN_PATTERN.test(line);
}

function highlightMarkupTag(tagText: string, theme: DiffTheme): string {
	const parts = tagText.match(MARKUP_PART_PATTERN) ?? [tagText];
	let result = "";
	let expectingTagName = false;
	let expectingAttributeName = false;
	let expectingAttributeValue = false;

	for (const part of parts) {
		if (!part) {
			continue;
		}

		if (/^\s+$/.test(part)) {
			result += part;
			continue;
		}

		if (part === "<" || part === "</" || part === ">" || part === "/>") {
			result += colorizeToken(theme, "warning", part);
			expectingTagName = part === "<" || part === "</";
			expectingAttributeName = part === ">";
			expectingAttributeValue = false;
			continue;
		}

		if (part === "=") {
			result += colorizeToken(theme, "syntaxPunctuation", part);
			expectingAttributeValue = true;
			expectingAttributeName = false;
			continue;
		}

		if (/^"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'$/.test(part)) {
			result += colorizeToken(theme, "syntaxString", part);
			expectingAttributeValue = false;
			expectingAttributeName = true;
			continue;
		}

		if (expectingTagName) {
			result += colorizeToken(theme, "warning", part);
			expectingTagName = false;
			expectingAttributeName = true;
			continue;
		}

		if (expectingAttributeValue) {
			result += colorizeToken(theme, "syntaxString", part);
			expectingAttributeValue = false;
			expectingAttributeName = true;
			continue;
		}

		if (expectingAttributeName && /^[\w:@.-]+$/.test(part)) {
			result += colorizeToken(theme, "muted", part);
			continue;
		}

		result += colorizeToken(theme, "syntaxPunctuation", part);
	}

	return result;
}

export function highlightMarkupLine(line: string, theme: DiffTheme): string {
	if (!line) {
		return line;
	}

	let cursor = 0;
	let result = "";
	for (const match of line.matchAll(MARKUP_TOKEN_PATTERN)) {
		const index = match.index ?? 0;
		if (index > cursor) {
			result += line.slice(cursor, index);
		}

		const token = match[0] ?? "";
		result += token.startsWith("<!--")
			? colorizeToken(theme, "syntaxComment", token)
			: highlightMarkupTag(token, theme);
		cursor = index + token.length;
	}

	if (cursor < line.length) {
		result += line.slice(cursor);
	}

	return result || line;
}
