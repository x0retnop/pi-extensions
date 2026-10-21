#!/usr/bin/env python3
"""Re-apply the host runtime patches P-2..P-10 to a pi-coding-agent install.

Anchors below are written for **pi 1.0.1** and assert their target text: if an
anchor is missing the script reports FAIL for that patch and changes nothing
about it, so an upgrade can never be patched blindly. When a release moves code
around, update the anchor here and the entry in `docs/runtime-patches.md`.

P-1 (`fullscreenWheelScrollLines`) and P-5 site 1 (`fullscreenCopyOnSelect`) are
settings, not patches: set them in `~/.pi/agent/settings.json`. P-6 has its own
script (`scripts/pi_runtime_decat.py`).

Usage:
  python scripts/pi_runtime_patches.py                 # check only (no writes)
  python scripts/pi_runtime_patches.py --apply         # write, with per-file backups
  python scripts/pi_runtime_patches.py --root <dir>    # operate on a package copy
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

DEFAULT_ROOT = Path(os.environ.get("APPDATA", "")) / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent"

B = "dist/bundle/chunks/"  # live bundle chunks (what `pi` executes)
M = "node_modules/@earendil-works/pi-tui/dist/"  # nested pi-tui mirror

# (relative path, patch id, old text, new text, expected occurrences)
EDITS: list[tuple[str, str, str, str, int]] = [
    # ---- bundle: core chunk (P-2, P-3, P-4) ----
    (
        B + "chunk-5OEJBNHG.js",
        "P-2",
        "for(let model of[...baseline,...dynamic])merged.set(`${getModelType(model)}\\0${model.id}`,model);",
        "for(let model of[...baseline,...dynamic]){let _pk=`${getModelType(model)}\\0${model.id}`,_pv=merged.get(_pk);merged.set(_pk,_pv?{..._pv,...model}/*P-2*/:model)}",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-3",
        "function loadProjectContextFiles(options){let resolvedCwd=",
        "function loadProjectContextFiles(options){return[];/*P-3*/let resolvedCwd=",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-4",
        "if(skillFileReadTool&&skills.length>0){let skillsPrompt=formatSkillsForPrompt(skills,skillFileReadTool).trim();skillsPrompt&&(promptSections.skills=skillsPrompt)}",
        "/*P-4*/",
        1,
    ),
    # ---- bundle: core chunk (P-9: /bug and /share surfaces) ----
    # P-9 markers are per-site so a moved anchor can never be mistaken for "already applied".
    (
        B + "chunk-5OEJBNHG.js",
        "P-9",
        '{name:"bug",description:"Report a bug to the Pi developers",argumentHint:"<description>"},',
        "/*P-9:list-bug*/",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-9",
        '{name:"share",description:"Share session as a secret GitHub gist"},',
        "/*P-9:list-share*/",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-9",
        'if(text==="/bug"||text.startsWith("/bug ")){let hint=text.slice(4).trim();this.editor.setText(""),await this.handleBugCommand(hint||void 0);return}',
        "/*P-9:dispatch-bug*/",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-9",
        'if(text==="/share"){await this.handleShareCommand(),this.editor.setText("");return}',
        "/*P-9:dispatch-share*/",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-9",
        'this.chatContainer.addChild(new ThemedText(()=>theme.fg("muted",`If this looks like a ${APP_NAME} bug, /bug sends a report to the developers.`),this.outputPad,0)),',
        "/*P-9:hint*/",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-9",
        "run /bug. The crash details are attached automatically.",
        "see ~/.pi/agent/crashes.json for details.",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-9",
        "Run /bug to report it; the crash details are attached automatically.",
        "The crash was recorded in ~/.pi/agent/crashes.json.",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-9",
        "  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)",
        "  PI_SHARE_VIEWER_URL              - Unused (session sharing removed on this host)",
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-9",
        "async function shareSession(context){let tempDir=fs3.mkdtempSync(",
        "async function shareSession(context){/*P-9:share*/return;let tempDir=fs3.mkdtempSync(",
        1,
    ),
    # ---- bundle: TUI chunk (P-5, P-7) ----
    (
        B + "chunk-6FX7UEPL.js",
        "P-7",
        'APP_TITLE=piConfigName?APP_NAME:"\\u03C0"',
        'APP_TITLE=piConfigName?APP_NAME:/*P-7*/"pi"',
        1,
    ),
    (
        B + "chunk-6FX7UEPL.js",
        "P-5a",
        'handleRightClickPaste(event){if(!this.onRightClickPaste||process.platform!=="win32"||process.env.TERM_PROGRAM?.toLowerCase()==="vscode"||event.release||event.button!==2)return!1;try{this.onRightClickPaste()}catch{}return!0}',
        'handleRightClickPaste(event){/*P-5*/if(event.release||event.button!==2)return!1;if(this.getSelectionBounds())this.copySelectionToClipboard().finally(()=>{this.selectionAnchor=void 0,this.selectionFocus=void 0,this.selectionGranularity="character",this.selectionInitialRange=void 0,this.requestRender()});return!0}',
        1,
    ),
    (
        B + "chunk-6FX7UEPL.js",
        "P-5b",
        'applySelectionHighlight(text){let result="\\x1B[7m",index=0;for(;index<text.length;){let ansi=extractAnsiCode(text,index);if(!ansi){result+=text[index],index+=1;continue}result+=ansi.code,ansi.code.endsWith("m")&&(result+="\\x1B[7m"),index+=ansi.length}return`${result}\\x1B[27m`}',
        'applySelectionHighlight(text){/*P-5*/return"\\x1B[48;2;38;79;120m\\x1B[38;2;255;255;255m"+stripTerminalSequences(text)+"\\x1B[39;49m"}',
        1,
    ),
    (
        B + "chunk-6FX7UEPL.js",
        "P-5c",
        'tui.altScreen.bottom"))return isRelease||this.scrollToBottom(),{consume:!0}}}',
        'tui.altScreen.bottom"))return isRelease||this.scrollToBottom(),{consume:!0}}/*P-5*/if(!isRelease&&this.getSelectionBounds())this.selectionAnchor=void 0,this.selectionFocus=void 0,this.selectionGranularity="character",this.selectionInitialRange=void 0,this.requestRender()}',
        1,
    ),
    # ---- bundle: CLI entry (P-8) ----
    (
        "dist/bundle/cli-runtime.js",
        "P-8",
        "function setupCli(){process.title=APP_NAME,",
        "function setupCli(){/*P-8*/",
        1,
    ),
    # ---- modular mirrors (readable, kept in sync for reference / modular runs) ----
    (
        "dist/core/remote-catalog-provider.js",
        "P-2",
        "    for (const model of [...baseline, ...dynamic])\n        merged.set(`${getModelType(model)}\\0${model.id}`, model);",
        "    for (const model of [...baseline, ...dynamic]) {\n        const key = `${getModelType(model)}\\0${model.id}`;\n        const prev = merged.get(key);\n        // P-2: catalog overlay must not drop baseline-only fields (headers, api, baseUrl).\n        merged.set(key, prev ? { ...prev, ...model } : model);\n    }",
        1,
    ),
    (
        "dist/core/resource-loader.js",
        "P-3",
        "export function loadProjectContextFiles(options) {\n    const resolvedCwd = resolvePath(options.cwd);",
        "export function loadProjectContextFiles(options) {\n    return []; // P-3: do not load AGENTS.md / CLAUDE.md\n    const resolvedCwd = resolvePath(options.cwd);",
        1,
    ),
    (
        "dist/core/system-prompt.js",
        "P-4",
        '    const skillFileReadTool = ["read", "bash"].find((tool) => selectedTools.includes(tool));\n    if (skillFileReadTool && skills.length > 0) {\n        const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();\n        if (skillsPrompt)\n            promptSections.skills = skillsPrompt;\n    }\n',
        "    // P-4: do not append <available_skills>\n",
        1,
    ),
    (
        "dist/config.js",
        "P-7",
        'export const APP_TITLE = piConfigName ? APP_NAME : "\u03c0";',
        'export const APP_TITLE = piConfigName ? APP_NAME : "pi"; // P-7: plain ASCII title prefix',
        1,
    ),
    (
        "dist/cli/setup.js",
        "P-8",
        "    process.title = APP_NAME;",
        "    // P-8: no process.title - SetConsoleTitleW here clobbers the TUI title in sub-agent children",
        1,
    ),
    (
        M + "tui-alt-screen.js",
        "P-5a",
        '    handleRightClickPaste(event) {\n        if (!this.onRightClickPaste ||\n            process.platform !== "win32" ||\n            process.env.TERM_PROGRAM?.toLowerCase() === "vscode" ||\n            event.release ||\n            event.button !== 2) {\n            return false;\n        }\n        try {\n            this.onRightClickPaste();\n        }\n        catch {\n            // Clipboard paste is best-effort.\n        }\n        return true;\n    }',
        "    handleRightClickPaste(event) {\n        // P-5: right-click never pastes. Selection -> copy + clear; else consume.\n        if (event.release || event.button !== 2)\n            return false;\n        if (this.getSelectionBounds()) {\n            void this.copySelectionToClipboard().finally(() => {\n                this.selectionAnchor = undefined;\n                this.selectionFocus = undefined;\n                this.selectionGranularity = \"character\";\n                this.selectionInitialRange = undefined;\n                this.requestRender();\n            });\n        }\n        return true;\n    }",
        1,
    ),
    (
        M + "tui-alt-screen.js",
        "P-5b",
        '    applySelectionHighlight(text) {\n        let result = "\\x1b[7m";\n        let index = 0;\n        while (index < text.length) {\n            const ansi = extractAnsiCode(text, index);\n            if (!ansi) {\n                result += text[index];\n                index += 1;\n                continue;\n            }\n            result += ansi.code;\n            if (ansi.code.endsWith("m"))\n                result += "\\x1b[7m";\n            index += ansi.length;\n        }\n        return `${result}\\x1b[27m`;\n    }',
        '    applySelectionHighlight(text) {\n        // P-5: uniform theme selectionBg/Text - reverse-video over inner SGR looks like soup.\n        return `\\x1b[48;2;38;79;120m\\x1b[38;2;255;255;255m${stripTerminalSequences(text)}\\x1b[39;49m`;\n    }',
        1,
    ),
    (
        M + "tui-alt-screen.js",
        "P-5c",
        '        if (keybindings.matches(data, "tui.altScreen.bottom")) {\n            if (!isRelease)\n                this.scrollToBottom();\n            return { consume: true };\n        }\n        return undefined;\n    }',
        '        if (keybindings.matches(data, "tui.altScreen.bottom")) {\n            if (!isRelease)\n                this.scrollToBottom();\n            return { consume: true };\n        }\n        // P-5: dismiss app selection when a key falls through to the editor (WT-like).\n        if (!isRelease && this.getSelectionBounds()) {\n            this.selectionAnchor = undefined;\n            this.selectionFocus = undefined;\n            this.selectionGranularity = "character";\n            this.selectionInitialRange = undefined;\n            this.requestRender();\n        }\n        return undefined;\n    }',
        1,
    ),
    # ---- modular mirrors: P-9 (/bug and /share surfaces) ----
    (
        "dist/core/slash-commands.js",
        "P-9",
        """    { name: "bug", description: "Report a bug to the Pi developers", argumentHint: "<description>" },
""",
        """    // P-9: /bug removed (no report upload to the Pi backend on this host)
""",
        1,
    ),
    (
        "dist/core/slash-commands.js",
        "P-9",
        """    { name: "share", description: "Share session as a secret GitHub gist" },
""",
        """    // P-9: /share removed (no Radius upload, no private-gist fallback)
""",
        1,
    ),
    (
        "dist/modes/interactive/interactive-mode.js",
        "P-9",
        """            if (text === "/share") {
                await this.handleShareCommand();
                this.editor.setText("");
                return;
            }
""",
        """            // P-9: /share removed
""",
        1,
    ),
    (
        "dist/modes/interactive/interactive-mode.js",
        "P-9",
        """            if (text === "/bug" || text.startsWith("/bug ")) {
                const hint = text.slice("/bug".length).trim();
                this.editor.setText("");
                await this.handleBugCommand(hint ? hint : undefined);
                return;
            }
""",
        """            // P-9: /bug removed
""",
        1,
    ),
    (
        "dist/modes/interactive/interactive-mode.js",
        "P-9",
        """        this.chatContainer.addChild(new ThemedText(() => theme.fg("muted", `If this looks like a ${APP_NAME} bug, /bug sends a report to the developers.`), this.outputPad, 0));
""",
        """        // P-9: no bug-report hint after model errors
""",
        1,
    ),
    (
        "dist/modes/interactive/interactive-mode.js",
        "P-9",
        r"""        return `To report this crash: ${resume} run /bug. The crash details are attached automatically.`;
""",
        r"""        return `This crash was recorded: ${resume} see ~/.pi/agent/crashes.json.`;
""",
        1,
    ),
    (
        "dist/modes/interactive/interactive-mode.js",
        "P-9",
        r"""            this.showWarning(`${APP_NAME} crashed on ${when} (${crash.message}). Run /bug to report it; the crash details are attached automatically.`);
""",
        r"""            this.showWarning(`${APP_NAME} crashed on ${when} (${crash.message}). The crash was recorded in ~/.pi/agent/crashes.json.`);
""",
        1,
    ),
    (
        "dist/cli/args.js",
        "P-9",
        "  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)",
        "  PI_SHARE_VIEWER_URL              - Unused (session sharing removed on this host)",
        1,
    ),
    (
        "dist/modes/interactive/session-share.js",
        "P-9",
        """export async function shareSession(context) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-"));
""",
        """export async function shareSession(context) {
    // P-9: /share removed (Radius upload + private-gist fallback off).
    return;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-"));
""",
        1,
    ),
    # ---- bundle: one human duration format for timeouts (P-10) ----
    (
        B + "chunk-5OEJBNHG.js",
        "P-10",
        'function formatDuration(ms){let seconds=ms/1e3;if(seconds<60)return`${seconds.toFixed(1)}s`;let totalSeconds=Math.floor(seconds),minutes=Math.floor(totalSeconds/60),remainder=totalSeconds%60;return minutes<60?`${minutes}m ${remainder}s`:`${Math.floor(minutes/60)}h ${minutes%60}m ${remainder}s`}',
        'function formatDuration(ms){/*P-10*/let t=Number.isFinite(ms)?Math.max(0,ms):0;if(t<1e3)return t<50?"0s":`${(t/1e3).toFixed(1)}s`;let totalSeconds=Math.floor(t/1e3),seconds=totalSeconds%60,totalMinutes=Math.floor(totalSeconds/60),minutes=totalMinutes%60,hours=Math.floor(totalMinutes/60),pad=n=>String(n).padStart(2,"0");if(hours>0)return`${hours}h ${pad(minutes)}m${seconds>0?` ${pad(seconds)}s`:""}`;if(minutes>0)return`${minutes}m${seconds>0?` ${pad(seconds)}s`:""}`;return`${seconds}s`}',
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-10",
        '` (timeout ${timeout}s)`',
        '` (timeout ${formatDuration(timeout*1e3)})`/*P-10*/',
        1,
    ),
    (
        B + "chunk-5OEJBNHG.js",
        "P-10",
        '`Command timed out after ${timeoutSecs} seconds`',
        '`Command timed out after ${formatDuration(timeoutSecs*1e3)}`/*P-10*/',
        1,
    ),
    # ---- modular mirror: renderers/bash.js (P-10) ----
    (
        "dist/core/tools/renderers/bash.js",
        "P-10",
        'function formatDuration(ms) {\n    const seconds = ms / 1000;\n    if (seconds < 60)\n        return `${seconds.toFixed(1)}s`;\n    const totalSeconds = Math.floor(seconds);\n    const minutes = Math.floor(totalSeconds / 60);\n    const remainder = totalSeconds % 60;\n    if (minutes < 60)\n        return `${minutes}m ${remainder}s`;\n    return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;\n}',
        'function formatDuration(ms) {\n    // P-10: same human format as common/duration.ts in the extension repo.\n    const t = Number.isFinite(ms) ? Math.max(0, ms) : 0;\n    if (t < 1000)\n        return t < 50 ? "0s" : `${(t / 1000).toFixed(1)}s`;\n    const totalSeconds = Math.floor(t / 1000);\n    const seconds = totalSeconds % 60;\n    const totalMinutes = Math.floor(totalSeconds / 60);\n    const minutes = totalMinutes % 60;\n    const hours = Math.floor(totalMinutes / 60);\n    const pad = (n) => String(n).padStart(2, "0");\n    if (hours > 0)\n        return `${hours}h ${pad(minutes)}m${seconds > 0 ? ` ${pad(seconds)}s` : ""}`;\n    if (minutes > 0)\n        return `${minutes}m${seconds > 0 ? ` ${pad(seconds)}s` : ""}`;\n    return `${seconds}s`;\n}',
        1,
    ),
    (
        "dist/core/tools/renderers/bash.js",
        "P-10",
        '` (timeout ${timeout}s)`',
        '` (timeout ${formatDuration(timeout*1e3)})`/*P-10*/',
        1,
    ),
]

MARKERS = {"P-2": "/*P-2*/", "P-3": "/*P-3*/", "P-4": "/*P-4*/", "P-7": "/*P-7*/", "P-8": "/*P-8*/"}


def run(root: Path, apply: bool) -> int:
    ts = time.strftime("%Y%m%d-%H%M%S")
    files: dict[Path, str] = {}
    rows, failures = [], 0

    for rel, patch, old, new, expected in EDITS:
        path = root / rel
        if not path.exists():
            rows.append((rel, patch, "FILE-MISSING", 0))
            failures += 1
            continue
        text = files.setdefault(path, path.read_bytes().decode("utf-8"))
        found = text.count(old)
        if found == expected:
            files[path] = text.replace(old, new)
            rows.append((rel, patch, "applied" if apply else "would apply", found))
        elif found == 0 and new in text:
            rows.append((rel, patch, "already", 0))
        else:
            rows.append((rel, patch, f"FAIL (found {found}, expected {expected})", found))
            failures += 1

    if apply:
        for path, text in files.items():
            if path.read_bytes().decode("utf-8") == text:
                continue  # nothing changed in this file
            backup = path.with_name(path.name + f".backup-{ts}-hostpatch")
            if not backup.exists():
                shutil.copy2(path, backup)
            path.write_bytes(text.encode("utf-8"))

    print(f"root  : {root}")
    for rel, patch, status, found in rows:
        print(f"  {patch:4s} {status:32s} {rel}")
    print()
    print("P-1 / P-5 site 1 are settings: fullscreenWheelScrollLines=3, fullscreenCopyOnSelect=false")
    print("P-6 has its own script: python scripts/pi_runtime_decat.py [--apply]")
    print(json.dumps({"failures": failures, "applied": apply}))
    return 1 if failures else 0


def main() -> None:
    ap = argparse.ArgumentParser(description="check/re-apply host runtime patches P-2..P-10")
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="pi-coding-agent package dir (default: global npm install)")
    ap.add_argument("--apply", action="store_true", help="write the patches (default: check only)")
    args = ap.parse_args()
    sys.exit(run(args.root, args.apply))


if __name__ == "__main__":
    main()
