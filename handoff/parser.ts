import { Value } from "typebox/value";
import {
  ExtractionOutputSchema,
  type ExtractionOutput,
  type HandoffConfig,
  type ParseResult,
  type RelevantFile,
} from "./types.js";

/**
 * Attempts to extract JSON from text that may contain markdown code blocks
 * or other surrounding content.
 */
export function extractJsonFromText(text: string): unknown | null {
  const trimmed = text.trim();

  // Fast path: exact JSON response.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try fenced blocks and balanced objects below.
  }

  // Prefer fenced JSON blocks, but tolerate a generic fenced block too.
  const codeBlockMatches = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/gi)];
  for (const match of codeBlockMatches) {
    try {
      return JSON.parse(match[1].trim());
    } catch {
      // Try the next block.
    }
  }

  // Scan for balanced JSON objects instead of using a greedy /{.*}/ match.
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const candidate = extractBalancedObject(text, start);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue scanning; the first brace may belong to prose or an example.
    }
  }

  return null;
}

function extractBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}

/**
 * Parses the LLM response and validates it against the extraction schema.
 */
export function parseExtractionResponse(text: string): ParseResult {
  const parsed = extractJsonFromText(text);

  if (parsed === null) {
    return {
      success: false,
      error: "Could not extract valid JSON from response",
    };
  }

  // Validate against schema
  if (!Value.Check(ExtractionOutputSchema, parsed)) {
    const errors = [...Value.Errors(ExtractionOutputSchema, parsed)];
    const errorMessages = errors
      .slice(0, 3)
      .map((e) => `${(e as { path?: string }).path ?? ""}: ${e.message}`)
      .join("; ");
    return {
      success: false,
      error: `Schema validation failed: ${errorMessages}`,
    };
  }

  return {
    success: true,
    data: parsed as ExtractionOutput,
  };
}

/**
 * Validates that extracted files were actually mentioned in the conversation.
 * Filters out hallucinated file paths that the LLM invented.
 *
 * @param files - The files extracted by the LLM
 * @param conversationText - The full conversation text to check against
 * @returns Files that were actually mentioned in the conversation
 */
export function validateFilesAgainstConversation(
  files: RelevantFile[],
  conversationText: string,
): RelevantFile[] {
  const lowerConversation = conversationText.toLowerCase();

  return files.filter((file) => {
    const path = file.path.toLowerCase();

    // Check if the full path appears in the conversation
    if (lowerConversation.includes(path)) {
      return true;
    }

    // Check if just the filename appears (handles cases where path is mentioned without full path)
    const filename = path.split(/[\\/]/).pop();
    if (filename && lowerConversation.includes(filename)) {
      return true;
    }

    // File was not mentioned - filter it out
    return false;
  });
}

/**
 * Normalizes the extraction output by:
 * - Deduplicating files and commands
 * - Capping arrays to configured maximums
 * - Stripping @ prefix from file paths
 * - Filtering empty entries
 * - Optionally validating files against conversation
 */
export function normalizeExtraction(
  extraction: ExtractionOutput,
  config: HandoffConfig,
  conversationText?: string,
): ExtractionOutput {
  // Normalize and dedupe files
  const seenPaths = new Set<string>();
  let normalizedFiles = extraction.relevantFiles
    .map((file) => ({
      path: file.path.replace(/^@/, ""), // Strip @ prefix
      reason: file.reason,
    }))
    .filter((file) => {
      if (seenPaths.has(file.path)) {
        return false;
      }
      seenPaths.add(file.path);
      return true;
    });

  // Validate files against conversation if enabled and text provided
  if (config.validateFiles && conversationText) {
    normalizedFiles = validateFilesAgainstConversation(
      normalizedFiles,
      conversationText,
    );
  }

  // Cap to max files
  normalizedFiles = normalizedFiles.slice(0, config.maxFiles);

  // Dedupe commands and filter empty
  const seenCommands = new Set<string>();
  const normalizedCommands = extraction.relevantCommands
    .filter((cmd) => cmd.trim().length > 0)
    .filter((cmd) => {
      if (seenCommands.has(cmd)) {
        return false;
      }
      seenCommands.add(cmd);
      return true;
    })
    .slice(0, config.maxCommands);

  // Filter empty entries from other arrays
  const normalizedInfo = extraction.relevantInformation
    .filter((item) => item.trim().length > 0)
    .slice(0, config.maxInformationItems);

  const normalizedDecisions = extraction.decisions
    .filter((item) => item.trim().length > 0)
    .slice(0, config.maxDecisionItems);

  const normalizedQuestions = extraction.openQuestions
    .filter((item) => item.trim().length > 0)
    .slice(0, config.maxOpenQuestions);

  return {
    relevantFiles: normalizedFiles,
    relevantCommands: normalizedCommands,
    relevantInformation: normalizedInfo,
    decisions: normalizedDecisions,
    openQuestions: normalizedQuestions,
  };
}
