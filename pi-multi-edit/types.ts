export interface EditItem {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface ChangeStats {
  added: number;
  removed: number;
}

export interface EditResult {
  path: string;
  success: boolean;
  message: string;
  stats?: ChangeStats;
  firstChangedLine?: number;
  skipped?: boolean;
}

export interface Workspace {
  readText: (absolutePath: string) => Promise<string>;
  writeText: (absolutePath: string, content: string) => Promise<void>;
  checkWriteAccess: (absolutePath: string) => Promise<void>;
}

export type EditMode = "single" | "batch" | "multi";

export interface ExecuteResult {
  content: { type: "text"; text: string }[];
  details: {
    stats: ChangeStats;
    firstChangedLine?: number;
  };
}