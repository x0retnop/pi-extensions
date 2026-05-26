import { constants } from "fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "fs/promises";

import type { Workspace } from "./types.ts";

export function createRealWorkspace(): Workspace {
  const readCache = new Map<string, string>();
  return {
    readText: async (absolutePath: string) => {
      if (readCache.has(absolutePath)) return readCache.get(absolutePath)!;
      const content = await fsReadFile(absolutePath, "utf-8");
      readCache.set(absolutePath, content);
      return content;
    },
    writeText: async (absolutePath: string, content: string) => {
      const existing = readCache.get(absolutePath);
      if (existing === content) return;
      readCache.delete(absolutePath);
      await fsWriteFile(absolutePath, content, "utf-8");
    },
    deleteFile: async (absolutePath: string) => {
      readCache.delete(absolutePath);
      await fsUnlink(absolutePath);
    },
    exists: async (absolutePath: string) => {
      try {
        await fsAccess(absolutePath, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    checkWriteAccess: (absolutePath: string) =>
      fsAccess(absolutePath, constants.R_OK | constants.W_OK),
  };
}

export function createVirtualWorkspace(cwd: string): Workspace {
  const state = new Map<string, string | null>();

  async function ensureLoaded(absolutePath: string): Promise<void> {
    if (state.has(absolutePath)) return;
    try {
      const content = await fsReadFile(absolutePath, "utf-8");
      state.set(absolutePath, content);
    } catch {
      state.set(absolutePath, null);
    }
  }

  return {
    readText: async (absolutePath) => {
      await ensureLoaded(absolutePath);
      const content = state.get(absolutePath);
      if (content === null || content === undefined) {
        throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, "")}`);
      }
      return content;
    },
    writeText: async (absolutePath, content) => {
      state.set(absolutePath, content);
    },
    deleteFile: async (absolutePath) => {
      await ensureLoaded(absolutePath);
      if (state.get(absolutePath) === null) {
        throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, "")}`);
      }
      state.set(absolutePath, null);
    },
    exists: async (absolutePath) => {
      await ensureLoaded(absolutePath);
      return state.get(absolutePath) !== null;
    },
    checkWriteAccess: async (absolutePath: string) => {
      await fsAccess(absolutePath, constants.W_OK);
    },
  };
}
