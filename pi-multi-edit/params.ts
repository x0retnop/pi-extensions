import { type Static, Type } from "typebox";

import type { InsertEdit, MultiEdit, SingleEdit } from "./types.ts";

const pathProp = Type.String({
  description: "File path (relative or absolute). Copy from your last read.",
});

const oldStringProp = Type.String({
  description:
    "Exact text to find. MUST match whitespace, tabs, quotes, and trailing spaces exactly.",
});

const newStringProp = Type.String({
  description: 'Replacement text. Use "" (empty string) to delete the matched block.',
});

const replaceAllProp = Type.Optional(
  Type.Boolean({
    description: "Replace every occurrence instead of requiring uniqueness.",
  }),
);

export const singleEditParameters = Type.Object(
  {
    path: pathProp,
    old_string: oldStringProp,
    new_string: newStringProp,
    replace_all: replaceAllProp,
  },
  { additionalProperties: false },
);

export type SingleEditInput = Static<typeof singleEditParameters>;

const multiEditItemSchema = Type.Object(
  {
    old_string: oldStringProp,
    new_string: newStringProp,
    replace_all: replaceAllProp,
  },
  { additionalProperties: false },
);

export const multiEditParameters = Type.Object(
  {
    path: pathProp,
    edits: Type.Array(multiEditItemSchema, {
      minItems: 1,
      maxItems: 4,
      description:
        "Batch of independent replacements in ONE file. Each edit is applied to the result of the previous edit in the list. Maximum 4 edits per call — split larger changes into multiple calls with fresh reads between them.",
    }),
  },
  { additionalProperties: false },
);

export type MultiEditInput = Static<typeof multiEditParameters>;

export function parseSingleEdit(input: unknown): SingleEdit {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid edit tool input: expected object.");
  }
  const raw = input as Record<string, unknown>;

  const path = typeof raw.path === "string" && raw.path ? raw.path : undefined;
  const old_string = typeof raw.old_string === "string" ? raw.old_string : undefined;
  const new_string = typeof raw.new_string === "string" ? raw.new_string : undefined;
  const replace_all = raw.replace_all === true;

  if (!path) throw new Error("Missing path — add the file path you just read.");
  if (old_string === undefined) throw new Error("Missing old_string.");
  if (new_string === undefined) throw new Error("Missing new_string.");

  return { path, old_string, new_string, replace_all };
}

export function parseMultiEdit(input: unknown): MultiEdit {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid multi_edit tool input: expected object.");
  }
  const raw = input as Record<string, unknown>;

  const path = typeof raw.path === "string" && raw.path ? raw.path : undefined;
  if (!path) throw new Error("Missing path — add the file path you just read.");

  const editsArr = Array.isArray(raw.edits) ? raw.edits : undefined;
  if (!editsArr || editsArr.length === 0) {
    throw new Error("Missing edits — provide at least one {old_string, new_string}.");
  }
  if (editsArr.length > 4) {
    throw new Error(
      `Too many edits (${editsArr.length}). multi_edit supports at most 4 edits per call. Split larger changes into multiple calls and re-read the file between them.`,
    );
  }

  const edits: MultiEdit["edits"] = [];
  for (let i = 0; i < editsArr.length; i++) {
    const e = editsArr[i];
    if (!e || typeof e !== "object") {
      throw new Error(`edits[${i}] is invalid.`);
    }
    const rec = e as Record<string, unknown>;
    const old_string = typeof rec.old_string === "string" ? rec.old_string : undefined;
    const new_string = typeof rec.new_string === "string" ? rec.new_string : undefined;
    const replace_all = rec.replace_all === true;

    if (old_string === undefined) throw new Error(`edits[${i}] missing old_string.`);
    if (new_string === undefined) throw new Error(`edits[${i}] missing new_string.`);

    edits.push({ old_string, new_string, replace_all });
  }

  return { path, edits };
}

const insertLineProp = Type.Integer({
  description:
    "Line number (1-indexed) BEFORE which the text is inserted. Use 1 to prepend, use line_count+1 to append.",
  minimum: 1,
});

export const insertParameters = Type.Object(
  {
    path: pathProp,
    insert_line: insertLineProp,
    new_string: newStringProp,
  },
  { additionalProperties: false },
);

export type InsertInput = Static<typeof insertParameters>;

export function parseInsert(input: unknown): InsertEdit {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid insert tool input: expected object.");
  }
  const raw = input as Record<string, unknown>;

  const path = typeof raw.path === "string" && raw.path ? raw.path : undefined;
  const insert_line = typeof raw.insert_line === "number" ? raw.insert_line : undefined;
  const new_string = typeof raw.new_string === "string" ? raw.new_string : undefined;

  if (!path) throw new Error("Missing path — add the file path you just read.");
  if (insert_line === undefined) throw new Error("Missing insert_line.");
  if (new_string === undefined) throw new Error("Missing new_string.");

  return { path, insert_line, new_string };
}
