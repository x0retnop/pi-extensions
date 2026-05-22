import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, TruncatedText } from "@earendil-works/pi-tui";
import { AskUserQuestionComponent } from "./component.ts";
import { InputSchema, type Question, type Result } from "./schema.ts";
import { validateQuestions } from "./validate.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description: `MANDATORY when you need user input as a choice or short free-text answer.
NEVER use this tool for explanations or open-ended discussion — write plain text instead.

Modes:
- Choice: provide 2-4 options per question. User picks one (or many with multiSelect).
- Open: omit options for a free-text question (name, path, yes/no, quick confirmation).

Rules:
- 1-4 questions per call.
- Each question needs a short header (max 40 chars) for the tab bar.
- Do not add an "Other" option; free-text is built-in for choice mode.
- If you recommend an option, put it first and add "(Recommended)" to the label.`,

    parameters: InputSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Reject ambiguous or hard-to-render question payloads
      const validationError = validateQuestions(params.questions);
      if (validationError) {
        return {
          content: [{ type: "text", text: `Error: ${validationError}` }],
          details: {
            questions: params.questions,
            answers: {},
            cancelled: true,
          } satisfies Result,
        };
      }

      if (!ctx.hasUI) {
        // Non-interactive session — deregister so the LLM won't try again
        pi.setActiveTools(
          pi.getActiveTools().filter((name) => name !== "ask_user_question"),
        );
        return {
          content: [
            {
              type: "text",
              text: "Error: ask_user_question requires an interactive session. The tool has been disabled for this session.",
            },
          ],
          details: {
            questions: params.questions,
            answers: {},
            cancelled: true,
          } satisfies Result,
        };
      }

      const result = await ctx.ui.custom<Result | null>(
        (tui, theme, _kb, done) =>
          new AskUserQuestionComponent(params.questions, tui, theme, done),
      );

      if (result === null || result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled" }],
          details: {
            questions: params.questions,
            answers: {},
            cancelled: true,
          } satisfies Result,
        };
      }

      const summaryLines = result.questions.map(
        (q) =>
          `"${q.question}" = "${result.answers[q.question] ?? "(no answer)"}"`,
      );

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: result satisfies Result,
      };
    },

    renderCall(args, theme) {
      const questions = (args.questions ?? []) as Question[];
      const topics = questions.map((q) => q.header).join(", ");
      return new TruncatedText(
        theme.fg("toolTitle", theme.bold("ask user ")) +
          theme.fg("muted", topics),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as Result | undefined;

      if (!details) {
        const t = result.content[0];
        return new TruncatedText(t?.type === "text" ? t.text : "", 0, 0);
      }

      if (details.cancelled) {
        return new TruncatedText(theme.fg("warning", "Cancelled"), 0, 0);
      }

      // One TruncatedText per question — each line item truncated independently
      const box = new Box(0, 0);
      for (const q of details.questions) {
        const answer = details.answers[q.question] ?? "(no answer)";
        box.addChild(
          new TruncatedText(
            theme.fg("success", "✓ ") +
              theme.fg("accent", `${q.header}: `) +
              theme.fg("text", answer),
            0,
            0,
          ),
        );
      }
      return box;
    },
  });
}
