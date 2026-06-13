export interface EditItem {
  path: string;
  oldText: string;
  newText: string;
}

export interface EditResult {
  path: string;
  success: boolean;
  message: string;
  diff?: string;
  firstChangedLine?: number;
  /** True when the edit text matched during preflight/continueOnError, but it will be skipped in the actual apply because an earlier edit in the same file failed. */
  skipped?: boolean;
  /** True when this result comes from a preflight (virtual) pass. */
  preflight?: boolean;
}

export interface Workspace {
  readText: (absolutePath: string) => Promise<string>;
  writeText: (absolutePath: string, content: string) => Promise<void>;
  deleteFile: (absolutePath: string) => Promise<void>;
  exists: (absolutePath: string) => Promise<boolean>;
  checkWriteAccess: (absolutePath: string) => Promise<void>;
}
