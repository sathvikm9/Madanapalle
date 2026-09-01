const DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_CATALOG_MOVIES = 80;
const MAX_REPLY_LENGTH = 360;
const MAX_CANONICAL_LENGTH = 300;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["resolved", "clarify", "unsupported"] },
    canonicalQuestion: { type: "string" },
    reply: { type: "string" }
  },
  required: ["status", "canonicalQuestion", "reply"],
  additionalProperties: false
};

function cleanText(value, maximum) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function safeContext(context) {
  const request = context?.request || context;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  return {
    type: context?.type === "capacity" ? "capacity" : "analytics",
    movieTitle: cleanText(request.movieTitle, 300) || null,
    venueCode: cleanText(request.venueCode, 10) || null,
    theatreName: cleanText(request.theatreName, 80) || null,
    metric: cleanText(request.metric, 30) || null,
    period: cleanText(request.label, 80) || null,
    startDate: cleanText(request.startDate, 10) || null,
    endDate: cleanText(request.endDate, 10) || null,
    venueCodes: Array.isArray(request.venueCodes)
      ? request.venueCodes.map((value) => cleanText(value, 10)).filter(Boolean).slice(0, 4)
      : null,
    prices: Array.isArray(request.prices)
      ? request.prices.map(Number).filter(Number.isFinite).slice(0, 4)
      : null,
    showCount: Number.isFinite(Number(request.showCount)) ? Number(request.showCount) : null
  };
}

function responseText(response) {
  if (typeof response === "string") return response;
  if (typeof response?.response === "string") return response.response;
  if (response?.response && typeof response.response === "object") return JSON.stringify(response.response);
  const choiceContent = response?.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string") return choiceContent;
  if (choiceContent && typeof choiceContent === "object") return JSON.stringify(choiceContent);
  return JSON.stringify(response || {});
}

function parseJsonObject(value) {
  const text = responseText(value).trim();
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        return null;
      }
    }
    const object = text.match(/\{[\s\S]*\}/)?.[0];
    if (!object) return null;
    try {
      return JSON.parse(object);
    } catch {
      return null;
    }
  }
}

function validateInterpretation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!new Set(["resolved", "clarify", "unsupported"]).has(value.status)) return null;
  const canonicalQuestion = cleanText(value.canonicalQuestion, MAX_CANONICAL_LENGTH);
  const reply = cleanText(value.reply, MAX_REPLY_LENGTH);
  // Guided JSON guarantees the shape, but a model can still choose an inconsistent
  // status. A canonical rewrite with no user-facing reply is unambiguously resolved.
  if (canonicalQuestion && !reply) return { status: "resolved", canonicalQuestion, reply: "" };
  if (value.status === "resolved" && !canonicalQuestion) return null;
  if (value.status !== "resolved" && !reply) return null;
  return { status: value.status, canonicalQuestion, reply };
}

export function buildChatInterpreterMessages({ question, context, catalog }) {
  const movies = (catalog.movies || []).slice(0, MAX_CATALOG_MOVIES).map((movie) => movie.title);
  const capacities = (catalog.capacityProfiles || []).map((profile) => ({
    theatre: profile.theatreName,
    code: profile.venueCode,
    priceTiers: profile.tiers?.length || 0
  }));
  const previous = safeContext(context);
  return [
    {
      role: "system",
      content: [
        "You interpret questions for a read-only cinema collection tracker.",
        "Return JSON only and follow the supplied schema.",
        "Your job is only to rewrite the user's wording into a short canonical question for the existing exact parser.",
        "Never calculate money, invent data, answer from general knowledge, create SQL, or request a database change.",
        "Use the canonical metric words gross, tickets, shows, or housefull; use the period words first week, first weekend, Day N, a specific date, or till now.",
        "Understand natural synonyms: revenue, earnings, business, collection and box office mean gross; admissions, footfalls and audience mean tickets; sold out, packed and full mean housefull; screenings and played mean shows.",
        "Theatre data, by theatre, each theatre, venue-wise, cinema-wise, theatre split and similar wording all mean theatre-wise report.",
        "Prefer forms such as '<Exact Movie Title> first week gross Ravi', '<Exact Movie Title> Day 9 housefull', or 'compare <Exact Movie Title> and <Exact Movie Title> first weekend gross'.",
        "Preserve all dates, day numbers, first-week or weekend periods, theatre names, ticket prices, show multipliers, metrics, and comparison intent.",
        "Use only an exact movie title from the supplied movie list.",
        "If one title clearly matches a shortened or misspelled name, use that exact title.",
        "If multiple titles could match, return status clarify with a concise 'Did you mean ...?' reply.",
        "For requests to update, correct, delete, or write data, return unsupported and say the assistant is read-only.",
        "For questions asking which or how many movies are tracked, rewrite to 'list tracked movies'.",
        "When the user names two or more movies and asks for a report or data, preserve every named movie.",
        "For unrelated questions, return unsupported.",
        "For resolved requests, put the rewritten request in canonicalQuestion and leave reply empty.",
        `Tracked movies: ${JSON.stringify(movies)}`,
        "Theatres: Sai Chitra (SCM), ASR (ASRM), Ravi (RTDM), Sri Krishna (SKMD), or All theatres.",
        `Capacity profiles: ${JSON.stringify(capacities)}`,
        `Previous conversation context: ${JSON.stringify(previous)}`
      ].join("\n")
    },
    { role: "user", content: cleanText(question, 240) }
  ];
}

export async function interpretChatQuestion(ai, { question, context, catalog, model = DEFAULT_MODEL }) {
  if (!ai?.run) return { status: "unavailable" };
  try {
    const response = await ai.run(model, {
      messages: buildChatInterpreterMessages({ question, context, catalog }),
      temperature: 0,
      max_tokens: 220,
      guided_json: OUTPUT_SCHEMA
    });
    const interpretation = validateInterpretation(parseJsonObject(response));
    if (!interpretation) {
      console.warn("Workers AI returned an invalid interpretation", responseText(response).slice(0, 500));
      return { status: "unavailable" };
    }
    return interpretation;
  } catch (error) {
    console.warn("Workers AI interpretation unavailable", error?.message || error);
    return { status: "unavailable" };
  }
}

export { DEFAULT_MODEL, safeContext, validateInterpretation };
