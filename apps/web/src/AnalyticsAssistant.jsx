import { useEffect, useRef, useState } from "react";
import { formatAnalyticsAnswer, formatComparisonAnswer, formatMultiMovieAnswer, parseAnalyticsQuestion } from "./analyticsQuery.js";
import { formatFullGrossAnswer, parseFullGrossQuestion } from "./fullGrossCalculator.js";

const CATALOG_MAX_AGE_MS = 10 * 60 * 1000;
const CONTEXT_IDLE_MS = 15 * 60 * 1000;
const PRIMARY_EXAMPLES = [
  "Give Irumudi report till now",
  "Give Irumudi first week theatre wise data",
  "How many Irumudi shows were housefull?",
  "Give yesterday’s all-theatre report",
  "Which theatre has the highest Irumudi gross?",
  "What movies data do you have?"
];
const MORE_EXAMPLES = [
  "Give Sri Krishna yesterday’s report",
  "Give 30 August theatre-wise report",
  "Give day-wise Irumudi gross",
  "Compare Irumudi and Toxic first weekend",
  "Calculate Ravi full show gross and 5 shows with ₹170 and ₹100 prices",
  "Calculate Ravi, Sai Chitra, ASR and Sri Krishna full show gross and 5 shows with ₹250 and ₹150 prices"
];

let nextMessageId = 1;

function message(role, text) {
  const uniquePart = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${nextMessageId++}`;
  return { id: `${role}-${uniquePart}`, role, text };
}

function shouldTryAiFallback(reply) {
  return /^I couldn’t identify the movie\b/i.test(reply || "")
    || /^Name two movies to compare\b/i.test(reply || "");
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Analytics API returned ${response.status}`);
  return body;
}

export default function AnalyticsAssistant({ apiBase }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [showMoreExamples, setShowMoreExamples] = useState(false);
  const catalogRef = useRef(null);
  const catalogFetchedAtRef = useRef(0);
  const lastContextRef = useRef(null);
  const conversationRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const usesMobileKeyboard = window.matchMedia("(max-width: 640px), (pointer: coarse)").matches;
    const previousBodyOverflow = document.body.style.overflow;

    if (usesMobileKeyboard) {
      document.body.style.overflow = "hidden";
    } else {
      inputRef.current?.focus({ preventScroll: true });
    }

    function closeOnEscape(event) {
      if (event.key === "Escape") closeAssistant();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    conversationRef.current?.scrollTo({ top: conversationRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function loadCatalog(force = false) {
    const stale = Date.now() - catalogFetchedAtRef.current >= CATALOG_MAX_AGE_MS;
    if (force || !catalogRef.current || stale) {
      catalogRef.current = await responseJson(await fetch(`${apiBase}/api/analytics/catalog`, { cache: "no-store" }));
      catalogFetchedAtRef.current = Date.now();
    }
    return catalogRef.current;
  }

  function closeAssistant() {
    setOpen(false);
    setInput("");
    setMessages([]);
    setCopiedId(null);
    setShowMoreExamples(false);
    lastContextRef.current = null;
  }

  function activeContext() {
    const saved = lastContextRef.current;
    if (!saved) return null;
    if (Date.now() - saved.updatedAt >= CONTEXT_IDLE_MS) {
      lastContextRef.current = null;
      return null;
    }
    return saved;
  }

  function rememberContext(type, request) {
    lastContextRef.current = { type, request, updatedAt: Date.now() };
  }

  async function aiInterpretation(question, context) {
    try {
      return await responseJson(await fetch(`${apiBase}/api/analytics/interpret`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, context })
      }));
    } catch {
      return { status: "unavailable" };
    }
  }

  async function ask(rawQuestion) {
    const question = String(rawQuestion || "").trim();
    if (!question || loading) return;
    setInput("");
    setMessages((current) => [...current, message("user", question)]);
    setLoading(true);

    try {
      let catalog = await loadCatalog();
      const conversationContext = activeContext();
      const capacityContext = conversationContext?.type === "capacity" ? conversationContext.request : null;
      const capacityParsed = parseFullGrossQuestion(question, catalog, capacityContext);
      if (capacityParsed) {
        const answer = capacityParsed.reply || formatFullGrossAnswer(capacityParsed.request, catalog);
        if (capacityParsed.request) rememberContext("capacity", capacityParsed.request);
        setMessages((current) => [...current, message("assistant", answer)]);
        return;
      }

      const analyticsContext = conversationContext?.type === "analytics" ? conversationContext.request : null;
      let parsed = parseAnalyticsQuestion(question, catalog, new Date(), analyticsContext);
      if (parsed.reply?.startsWith("I couldn’t identify the movie")) {
        catalog = await loadCatalog(true);
        parsed = parseAnalyticsQuestion(question, catalog, new Date(), analyticsContext);
      }
      if (parsed.reply && shouldTryAiFallback(parsed.reply)) {
        const interpreted = await aiInterpretation(question, conversationContext);
        if (interpreted.status === "clarify" || interpreted.status === "unsupported") {
          setMessages((current) => [...current, message("assistant", interpreted.reply)]);
          return;
        }
        if (interpreted.status === "resolved" && interpreted.canonicalQuestion) {
          const aiCapacityParsed = parseFullGrossQuestion(interpreted.canonicalQuestion, catalog, capacityContext);
          if (aiCapacityParsed) {
            const answer = aiCapacityParsed.reply || formatFullGrossAnswer(aiCapacityParsed.request, catalog);
            if (aiCapacityParsed.request) rememberContext("capacity", aiCapacityParsed.request);
            setMessages((current) => [...current, message("assistant", answer)]);
            return;
          }
          const aiParsed = parseAnalyticsQuestion(interpreted.canonicalQuestion, catalog, new Date(), analyticsContext);
          if (!aiParsed.reply) parsed = aiParsed;
        }
      }
      if (parsed.reply) {
        if (parsed.resetContext) lastContextRef.current = null;
        setMessages((current) => [...current, message("assistant", parsed.reply)]);
        return;
      }

      if (parsed.request.mode === "comparison" || parsed.request.mode === "multi_report") {
        const summaries = await Promise.all(parsed.request.entries.map(async (entry) => {
          const query = new URLSearchParams({
            movie: entry.movieTitle,
            venueCode: entry.venueCode,
            startDate: entry.startDate,
            endDate: entry.endDate,
            ...(entry.completeDaysOnly ? { completeDaysOnly: "1" } : {})
          });
          return responseJson(await fetch(`${apiBase}/api/analytics/summary?${query}`, { cache: "no-store" }));
        }));
        rememberContext("analytics", parsed.request.contextRequest);
        const answer = parsed.request.mode === "comparison"
          ? formatComparisonAnswer(parsed.request, summaries)
          : formatMultiMovieAnswer(parsed.request, summaries);
        setMessages((current) => [...current, message("assistant", answer)]);
        return;
      }

      const query = new URLSearchParams({
        movie: parsed.request.movieTitle,
        venueCode: parsed.request.venueCode,
        startDate: parsed.request.startDate,
        endDate: parsed.request.endDate,
        ...(parsed.request.completeDaysOnly ? { completeDaysOnly: "1" } : {})
      });
      const summary = await responseJson(await fetch(`${apiBase}/api/analytics/summary?${query}`, { cache: "no-store" }));
      rememberContext("analytics", parsed.request);
      setMessages((current) => [...current, message("assistant", formatAnalyticsAnswer(parsed.request, summary))]);
    } catch (error) {
      setMessages((current) => [...current, message("assistant", `I couldn’t read the captured data. ${error.message}`)]);
    } finally {
      setLoading(false);
    }
  }

  async function copyAnswer(item) {
    try {
      await window.navigator.clipboard.writeText(item.text);
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      setCopiedId(null);
    }
  }

  return (
    <>
      <button className="assistant-launcher" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span aria-hidden="true">✦</span> Ask MPLTalkies
      </button>

      {open && (
        <aside className="analytics-assistant" role="dialog" aria-modal="false" aria-labelledby="analytics-assistant-title">
          <header className="analytics-assistant__header">
            <div>
              <span className="analytics-assistant__mark" aria-hidden="true">MPL</span>
              <span><strong id="analytics-assistant-title">Collection Assistant</strong><small>Captured records only</small></span>
            </div>
            <span className="analytics-assistant__readonly">Read-only</span>
            <button type="button" onClick={closeAssistant} aria-label="Close collection assistant">×</button>
          </header>

          <div className="analytics-assistant__conversation" ref={conversationRef} aria-live="polite">
            {!messages.length && (
              <div className="analytics-assistant__welcome">
                <p className="eyebrow">Ask the collection desk</p>
                <h2>Fast answers from captured show data.</h2>
                <p className="analytics-assistant__examples-note">Example questions — replace the movie, theatre, date or prices.</p>
                <ol className="analytics-assistant__examples">
                  {PRIMARY_EXAMPLES.map((example) => <li key={example}>{example}</li>)}
                  {showMoreExamples && MORE_EXAMPLES.map((example) => <li key={example}>{example}</li>)}
                </ol>
                <button
                  className="analytics-assistant__examples-toggle"
                  type="button"
                  aria-expanded={showMoreExamples}
                  onClick={() => setShowMoreExamples((visible) => !visible)}
                >
                  {showMoreExamples ? "Show fewer examples" : "More examples"}
                  <span aria-hidden="true">{showMoreExamples ? "−" : "+"}</span>
                </button>
              </div>
            )}

            {messages.map((item) => (
              <article className={`assistant-message assistant-message--${item.role}`} key={item.id}>
                <span>{item.role === "assistant" ? "MPLTalkies" : "You"}</span>
                <p>{item.text}</p>
                {item.role === "assistant" && (
                  <button type="button" onClick={() => copyAnswer(item)}>
                    {copiedId === item.id ? "Copied!" : "Copy answer"}
                  </button>
                )}
              </article>
            ))}

            {loading && (
              <div className="assistant-thinking" role="status"><i /><i /><i /><span>Checking captured data…</span></div>
            )}
          </div>

          <form className="analytics-assistant__composer" onSubmit={(event) => { event.preventDefault(); ask(input); }}>
            <label className="sr-only" htmlFor="analytics-question">Ask about collection data</label>
            <textarea
              id="analytics-question"
              ref={inputRef}
              rows="2"
              maxLength="240"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  ask(input);
                }
              }}
              placeholder="Try: iru 1w g, 28 rpt, rv 170 100…"
            />
            <button type="submit" disabled={!input.trim() || loading} aria-label="Send question">→</button>
          </form>
          <p className="analytics-assistant__note">Answers cannot edit the tracker database.</p>
        </aside>
      )}
    </>
  );
}
