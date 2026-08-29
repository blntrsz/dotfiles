import assert from "node:assert/strict";
import test from "node:test";
import { parseLaunchArguments, shellWords } from "../extensions/subagent/index.ts";
import { filterForkMessages } from "../extensions/subagent/sdk-adapter.ts";

void test("command parsing preserves quoted tasks and validates canonical options", () => {
  assert.deepEqual(
    parseLaunchArguments('--context fork --model openai/gpt-5.4 "review the branch"'),
    { context: "fork", model: "openai/gpt-5.4", task: "review the branch" },
  );
  assert.throws(() => parseLaunchArguments("--context maybe work"), /fresh or fork/);
  assert.throws(() => parseLaunchArguments("--unknown work"), /Unknown option/);
});

void test("workflow command parsing passes shell-quoted positional strings without option interpretation", () => {
  assert.deepEqual(shellWords(`review-branch "two words" '--literal' plain\\ value`), [
    "review-branch",
    "two words",
    "--literal",
    "plain value",
  ]);
  assert.throws(() => shellWords(`review-branch "unfinished`), /Unterminated/);
});

void test("fork filtering removes orchestration and delivery artifacts without mutating source", () => {
  const ordinary = { role: "user", content: "keep me", timestamp: 1 };
  const source = [
    ordinary,
    { role: "custom", customType: "subagent-delivery", content: "hidden", display: false, timestamp: 2 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: "subagent", arguments: { action: "list" } }],
      api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: 3,
    },
    { role: "toolResult", toolCallId: "1", toolName: "subagent", content: [], isError: false, timestamp: 4 },
    { role: "assistant", content: [{ type: "text", text: "keep answer" }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 5 },
  ];
  const filtered = filterForkMessages(source);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0]?.role, "user");
  assert.equal(filtered[1]?.role, "assistant");
  assert.notEqual(filtered[0], ordinary);
  assert.equal(source.length, 5);
});

void test("fork filtering preserves ordinary content beside orchestration calls", () => {
  const filtered = filterForkMessages([{
    role: "assistant",
    content: [
      { type: "text", text: "keep this reasoning" },
      { type: "toolCall", id: "parent", name: "subagent", arguments: {} },
      { type: "toolCall", id: "ordinary", name: "read", arguments: { path: "README.md" } },
    ],
    api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: 1,
  }]);
  assert.equal(filtered.length, 1);
  const assistant = filtered[0];
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role !== "assistant") throw new Error("expected assistant");
  assert.deepEqual(assistant.content.map((part) => part.type === "toolCall" ? part.name : part.type), ["text", "read"]);
});
