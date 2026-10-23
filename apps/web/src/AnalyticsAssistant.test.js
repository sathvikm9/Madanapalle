import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AnalyticsAssistant.jsx", import.meta.url), "utf8");

test("assistant welcome choices submit real questions instead of showing static examples", () => {
  assert.match(source, /PRIMARY_EXAMPLES\.map/);
  assert.match(source, /onClick=\{\(\) => ask\(example\.prompt\)\}/);
  assert.match(source, /analytics-assistant__starters/);
});

test("closing preserves the conversation while New explicitly resets it", () => {
  const closeAssistant = source.match(/function closeAssistant[\s\S]*?\n  }/)?.[0] || "";
  const startNewConversation = source.match(/function startNewConversation[\s\S]*?\n  }/)?.[0] || "";
  assert.doesNotMatch(closeAssistant, /setMessages/);
  assert.match(startNewConversation, /setMessages\(\[\]\)/);
  assert.match(source, />New<\/button>/);
});

test("assistant offers contextual follow-ups and an accessible send control", () => {
  assert.match(source, /FOLLOW_UPS\.map/);
  assert.match(source, /aria-label="Suggested follow-up questions"/);
  assert.match(source, /aria-label="Send question"/);
});
