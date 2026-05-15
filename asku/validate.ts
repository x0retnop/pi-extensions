import type { Question } from "./schema.ts";

const RESERVED_LABELS = new Set(["other", "type your own answer..."]);

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Returns an error message if questions are ambiguous or hard to render,
 * or null if validation passes.
 */
export function validateQuestions(questions: Question[]): string | null {
  const seen = new Set<string>();
  for (const q of questions) {
    const question = q.question.trim();
    const header = q.header.trim();

    if (!question) return "Question text must not be empty";
    if (!header) return `Header must not be empty for question "${question}"`;
    if ([...header].length > 12) {
      return `Header "${header}" is too long; max 12 characters`;
    }

    const normalizedQuestion = normalize(question);
    if (seen.has(normalizedQuestion)) {
      return `Duplicate question: "${question}"`;
    }
    seen.add(normalizedQuestion);

    const labels = new Set<string>();
    for (const opt of q.options) {
      const label = opt.label.trim();
      if (!label) return `Option label must not be empty in question "${question}"`;
      if (RESERVED_LABELS.has(normalize(label))) {
        return `Option label "${label}" is reserved; free-text is added automatically`;
      }

      const normalizedLabel = normalize(label);
      if (labels.has(normalizedLabel)) {
        return `Duplicate option label "${label}" in question "${question}"`;
      }
      labels.add(normalizedLabel);
    }
  }
  return null;
}
