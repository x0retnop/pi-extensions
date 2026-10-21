import assert from "node:assert";
import { describe, it } from "node:test";

import {
	RETRY_TRIGGER,
	WARM_TRIGGER,
	WARM_USER_TEXT,
	applyTriggerContext,
} from "../../a-rewind/trigger-context.js";

function user(content: string) {
	return { role: "user", content };
}
function assistant(content: string) {
	return { role: "assistant", content };
}
function warmTrigger() {
	return { role: "custom", customType: WARM_TRIGGER, content: " " };
}
function retryTrigger() {
	return { role: "custom", customType: RETRY_TRIGGER, content: " " };
}

describe("applyTriggerContext — idle", () => {
	it("returns undefined when there are no triggers", () => {
		const messages = [user("task"), assistant("done")];
		assert.strictEqual(applyTriggerContext(messages), undefined);
	});

	it("returns undefined on empty input", () => {
		assert.strictEqual(applyTriggerContext([]), undefined);
	});
});

describe("applyTriggerContext — warm ping turn", () => {
	it("injects the quiet cue only while the trigger is last", () => {
		const messages = [user("task"), assistant("done with tools"), warmTrigger()];
		const out = applyTriggerContext(messages);
		assert.ok(out);
		assert.strictEqual(out.length, 3);
		assert.deepStrictEqual(out.slice(0, 2), messages.slice(0, 2));
		assert.strictEqual(out[2].role, "user");
		assert.strictEqual(out[2].content, WARM_USER_TEXT);
	});
});

describe("applyTriggerContext — after /warm, real task", () => {
	it("does not re-inject the cue; drops trigger and ping reply", () => {
		const task = user("normal task after warm");
		const messages = [
			user("task"),
			assistant("done with tools"),
			warmTrigger(),
			assistant("ok. Do not use tools."),
			task,
		];
		const out = applyTriggerContext(messages);
		assert.ok(out);
		assert.deepStrictEqual(out, [user("task"), assistant("done with tools"), task]);
		assert.ok(out.every((m) => m.content !== WARM_USER_TEXT));
	});

	it("strips a Russian no-tools ping reply the same way", () => {
		const task = user("сделай фичу");
		const messages = [
			user("task"),
			assistant("done"),
			warmTrigger(),
			assistant("ок, не юзаю тулы"),
			task,
		];
		const out = applyTriggerContext(messages);
		assert.ok(out);
		assert.deepStrictEqual(out, [user("task"), assistant("done"), task]);
	});

	it("strips a warm exchange that used tools anyway", () => {
		const task = user("next");
		const messages = [
			user("task"),
			assistant("done"),
			warmTrigger(),
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }] },
			{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: "x" },
			assistant("ok"),
			task,
		];
		const out = applyTriggerContext(messages);
		assert.ok(out);
		assert.deepStrictEqual(out, [user("task"), assistant("done"), task]);
	});
});

describe("applyTriggerContext — retry", () => {
	it("strips retry trigger and adds a space placeholder after assistant", () => {
		const messages = [user("task"), assistant("partial"), retryTrigger()];
		const out = applyTriggerContext(messages);
		assert.ok(out);
		assert.strictEqual(out[out.length - 1].role, "user");
		assert.strictEqual(out[out.length - 1].content, " ");
		assert.ok(out.every((m) => m.customType !== RETRY_TRIGGER));
	});

	it("strips a leftover retry trigger on a later user turn without injecting", () => {
		const task = user("follow-up");
		const messages = [
			user("task"),
			assistant("partial"),
			retryTrigger(),
			assistant("continued"),
			task,
		];
		const out = applyTriggerContext(messages);
		assert.ok(out);
		assert.deepStrictEqual(out, [
			user("task"),
			assistant("partial"),
			assistant("continued"),
			task,
		]);
	});
});
