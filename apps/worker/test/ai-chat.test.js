import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatInterpreterMessages,
  interpretChatQuestion,
  safeContext,
  validateInterpretation
} from "../src/ai-chat.js";

const catalog = {
  movies: [
    { title: "Irumudi" },
    { title: "The Paradise" },
    { title: "Paradise Lost" }
  ],
  capacityProfiles: [
    { theatreName: "Ravi", venueCode: "RTDM", tiers: [{}, {}] }
  ]
};

test("builds a constrained interpreter prompt with conversation context", () => {
  const messages = buildChatInterpreterMessages({
    question: "and gross?",
    context: {
      type: "analytics",
      request: {
        movieTitle: "Irumudi",
        venueCode: "ALL",
        metric: "housefull",
        label: "Day 9",
        startDate: "2026-08-29",
        endDate: "2026-08-29"
      }
    },
    catalog
  });
  assert.equal(messages[1].content, "and gross?");
  assert.match(messages[0].content, /Irumudi/);
  assert.match(messages[0].content, /Day 9/);
  assert.match(messages[0].content, /Never calculate money/);
  assert.match(messages[0].content, /Never .*create SQL/);
  assert.match(messages[0].content, /list tracked movies/);
  assert.match(messages[0].content, /preserve every named movie/);
  assert.match(messages[0].content, /revenue, earnings, business/);
  assert.match(messages[0].content, /Theatre data, by theatre/);
});

test("uses Workers AI only to return a canonical question", async () => {
  let received;
  const ai = {
    async run(model, input) {
      received = { model, input };
      return {
        response: JSON.stringify({
          status: "resolved",
          canonicalQuestion: "The Paradise first week gross Ravi",
          reply: ""
        })
      };
    }
  };
  const result = await interpretChatQuestion(ai, {
    question: "paradise week one rv money",
    catalog
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.canonicalQuestion, "The Paradise first week gross Ravi");
  assert.equal(received.input.temperature, 0);
  assert.deepEqual(received.input.guided_json, {
    type: "object",
    properties: {
      status: { type: "string", enum: ["resolved", "clarify", "unsupported"] },
      canonicalQuestion: { type: "string" },
      reply: { type: "string" }
    },
    required: ["status", "canonicalQuestion", "reply"],
    additionalProperties: false
  });
});

test("passes clarification through without querying data", async () => {
  const ai = {
    async run() {
      return {
        response: JSON.stringify({
          status: "clarify",
          canonicalQuestion: "",
          reply: "Did you mean The Paradise or Paradise Lost?"
        })
      };
    }
  };
  const result = await interpretChatQuestion(ai, { question: "paradise gross", catalog });
  assert.deepEqual(result, {
    status: "clarify",
    canonicalQuestion: "",
    reply: "Did you mean The Paradise or Paradise Lost?"
  });
});

test("accepts the OpenAI-compatible response shape used by current Workers AI models", async () => {
  const ai = {
    async run() {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              status: "resolved",
              canonicalQuestion: "Irumudi first week gross Ravi",
              reply: ""
            })
          }
        }]
      };
    }
  };
  const result = await interpretChatQuestion(ai, { question: "irumdi week one money rv", catalog });
  assert.deepEqual(result, {
    status: "resolved",
    canonicalQuestion: "Irumudi first week gross Ravi",
    reply: ""
  });
});

test("fails closed when AI is missing or returns invalid output", async () => {
  assert.deepEqual(await interpretChatQuestion(null, { question: "hello", catalog }), { status: "unavailable" });
  assert.deepEqual(
    await interpretChatQuestion({ run: async () => ({ response: "not json" }) }, { question: "hello", catalog }),
    { status: "unavailable" }
  );
  assert.equal(validateInterpretation({ status: "resolved", canonicalQuestion: "", reply: "" }), null);
});

test("normalizes a logically inconsistent status when the canonical rewrite is clear", () => {
  assert.deepEqual(validateInterpretation({
    status: "clarify",
    canonicalQuestion: "Irumudi first week gross Ravi",
    reply: ""
  }), {
    status: "resolved",
    canonicalQuestion: "Irumudi first week gross Ravi",
    reply: ""
  });
});

test("sanitizes context before it is sent to the model", () => {
  assert.deepEqual(safeContext({
    type: "capacity",
    request: {
      venueCodes: ["RTDM"],
      prices: [170, "100", "bad"],
      showCount: 5,
      ignored: "not included"
    }
  }), {
    type: "capacity",
    movieTitle: null,
    venueCode: null,
    theatreName: null,
    metric: null,
    period: null,
    startDate: null,
    endDate: null,
    venueCodes: ["RTDM"],
    prices: [170, 100],
    showCount: 5
  });
});
