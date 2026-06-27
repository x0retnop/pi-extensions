export interface SingleEdit {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface MultiEdit {
  path: string;
  edits: Array<{
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }>;
}

export interface InsertEdit {
  path: string;
  insert_line: number;
  new_string: string;
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
  usedFuzzy?: boolean;
}

export interface Workspace {
  readText: (absolutePath: string) => Promise<string>;
  writeText: (absolutePath: string, content: string) => Promise<void>;
  checkWriteAccess: (absolutePath: string) => Promise<void>;
}

export interface ExecuteResult {
  content: { type: "text"; text: string }[];
  details: {
    stats?: ChangeStats;
    firstChangedLine?: number;
  };
}
