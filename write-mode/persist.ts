/**
 * File work for the `write` override.
 *
 * Pi's built-in `write` is `fs.writeFile(absolutePath, content, "utf-8")` — no BOM handling, and a
 * result line that carries no facts. Two things are worth owning on this host (census 2026-10-05,
 * 1071 model-written files over 3 weeks): 178 of 752 source files in the working repos start with a
 * UTF-8 BOM (172 of them `.cs`), so a rewrite through the native path silently strips one, while
 * `edit` has preserved it for months (`pi-multi-edit/normalize.ts`). The second finding is a
 * deliberate *non*-change: not one of those 1071 writes contained CRLF, and 137 of the 752 files are
 * CRLF — line endings stay whatever the model sent, because unlike a BOM they are visible in the
 * content and converting them would be a silent rewrite the caller never asked for.
 */
import { open, stat, writeFile } from "node:fs/promises";

export interface WriteOutcome {
  /** Size of the file as it was before this write; null when the file did not exist. */
  oldBytes: number | null;
  /** True when an existing BOM was re-added in front of content that did not carry one. */
  bomKept: boolean;
}

const BOM = "\uFEFF";

/** Re-add a BOM only when the file had one and the content does not spell it out itself. */
export function applyBom(content: string, hadBom: boolean): string {
  return hadBom && !content.startsWith(BOM) ? BOM + content : content;
}

async function statSize(absolutePath: string): Promise<number | null> {
  try {
    const stats = await stat(absolutePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

async function startsWithBom(absolutePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(absolutePath, "r");
  } catch {
    return false; // missing file, or a path we cannot read — treat it as BOM-less
  }
  try {
    const head = Buffer.alloc(3);
    const { bytesRead } = await handle.read(head, 0, 3, 0);
    return bytesRead === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

/**
 * Write `content` verbatim, keeping the target's existing BOM. Returns what the caller cannot read
 * back afterwards: the size the file had *before* this write (null = it did not exist).
 */
export async function writeTextPreservingBom(absolutePath: string, content: string): Promise<WriteOutcome> {
  const oldBytes = await statSize(absolutePath);
  const finalContent = applyBom(content, await startsWithBom(absolutePath));
  await writeFile(absolutePath, finalContent, "utf-8");
  return { oldBytes, bomKept: finalContent !== content };
}
