const TOOL_LABEL_FOREGROUND = "\x1b[38;2;204;204;204m";
const TOOL_ACCENT_FOREGROUND = "\x1b[38;2;138;190;183m";
const TOOL_DEV_ACCENT_FOREGROUND = "\x1b[38;2;138;190;183m";
const ANSI_FOREGROUND_RESET = "\x1b[39m";

interface ToolLabelThemeLike {
	bold(text: string): string;
}

export function renderToolLabel(
	theme: ToolLabelThemeLike,
	label: string,
): string {
	return `${TOOL_LABEL_FOREGROUND}${theme.bold(label)}${ANSI_FOREGROUND_RESET}`;
}

export function renderToolAccent(text: string): string {
	return `${TOOL_ACCENT_FOREGROUND}${text}${ANSI_FOREGROUND_RESET}`;
}

export function renderDevToolAccent(text: string): string {
	return `${TOOL_DEV_ACCENT_FOREGROUND}${text}${ANSI_FOREGROUND_RESET}`;
}
