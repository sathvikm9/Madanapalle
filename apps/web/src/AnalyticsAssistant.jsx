import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatAnalyticsAnswer, formatComparisonAnswer, formatMultiMovieAnswer, parseAnalyticsQuestion } from "./analyticsQuery.js";
import { formatFullGrossAnswer, parseFullGrossQuestion } from "./fullGrossCalculator.js";

const CATALOG_MAX_AGE_MS = 10 * 60 * 1000;
const CONTEXT_IDLE_MS = 15 * 60 * 1000;
const PRIMARY_EXAMPLES = [
  {
    label: "Today",
    title: "Today’s collection",
    description: "All theatres, tickets and gross",
    prompt: "Give today all-theatre report"
  },
  {
    label: "Movie",
    title: "Movie performance",
    description: "Day-wise and theatre-wise data",
    prompt: "Give Jailer 2 report till now"
  },
  {
    label: "Compare",
    title: "Compare movies",
    description: "Opening days, weeks or weekends",
    prompt: "Compare Jailer 2 and Ranabaali first weekend"
  },
  {
    label: "Shows",
    title: "Housefull shows",
    description: "Find sold-out performance",
    prompt: "How many Jailer 2 shows were housefull?"
  }
];
const MORE_EXAMPLES = [
  "Give Sri Krishna yesterday’s report",
  "Which theatre has the highest Jailer 2 gross?",
  "Give day-wise Ranabaali gross",
  "What movies data do you have?",
  "Calculate Ravi full show gross with ₹170 and ₹100 prices"
];
const FOLLOW_UPS = [
  { label: "Theatre-wise", prompt: "Show the same report theatre wise" },
  { label: "Tickets sold", prompt: "How many tickets were sold?" },
  { label: "Housefull", prompt: "How many shows were housefull?" }
];

let nextMessageId = 1;

function message(role, text, tone = "default") {
  const uniquePart = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${nextMessageId++}`;
  return { id: `${role}-${uniquePart}`, role, text, tone };
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
  const launcherRef = useRef(null);

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
    window.setTimeout(() => launcherRef.current?.focus({ preventScroll: true }), 0);
  }

  function startNewConversation() {
    setInput("");
    setMessages([]);
    setCopiedId(null);
    setShowMoreExamples(false);
    lastContextRef.current = null;
    window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
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
      setMessages((current) => [...current, message("assistant", `I couldn’t read the captured data. ${error.message}`, "error")]);
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

  return createPortal(
    <>
      {!open && (
        <button ref={launcherRef} className="assistant-launcher" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <span className="assistant-launcher__spark" aria-hidden="true">✦</span>
          <span className="assistant-launcher__label">Ask MPLTalkies</span>
        </button>
      )}

      {open && (
        <>
          <div className="analytics-assistant__backdrop" aria-hidden="true" onMouseDown={closeAssistant} />
          <aside className="analytics-assistant" role="dialog" aria-modal="true" aria-labelledby="analytics-assistant-title">
            <header className="analytics-assistant__header">
              <div className="analytics-assistant__identity">
              <span className="analytics-assistant__mark" aria-hidden="true">MPL</span>
                <span>
                  <strong id="analytics-assistant-title">Ask MPLTalkies</strong>
                  <small><i aria-hidden="true" /> Captured collection insights</small>
                </span>
              </div>
              <div className="analytics-assistant__actions">
                {messages.length > 0 && (
                  <button className="analytics-assistant__new" type="button" onClick={startNewConversation}>New</button>
                )}
                <button className="analytics-assistant__close" type="button" onClick={closeAssistant} aria-label="Close Ask MPLTalkies">×</button>
              </div>
            </header>

            <div className="analytics-assistant__conversation" ref={conversationRef} aria-live="polite">
              {!messages.length && (
                <div className="analytics-assistant__welcome">
                  <span className="analytics-assistant__eyebrow">Your collection desk</span>
                  <h2>What would you like to know?</h2>
                  <p>Ask naturally or start with one of these.</p>
                  <div className="analytics-assistant__starters">
                    {PRIMARY_EXAMPLES.map((example) => (
                      <button type="button" key={example.title} onClick={() => ask(example.prompt)}>
                        <span>{example.label}</span>
                        <strong>{example.title}</strong>
                        <small>{example.description}</small>
                        <b aria-hidden="true">→</b>
                      </button>
                    ))}
                  </div>
                  <button
                    className="analytics-assistant__examples-toggle"
                    type="button"
                    aria-expanded={showMoreExamples}
                    onClick={() => setShowMoreExamples((visible) => !visible)}
                  >
                    {showMoreExamples ? "Hide more questions" : "More questions"}
                    <span aria-hidden="true">{showMoreExamples ? "−" : "+"}</span>
                  </button>
                  {showMoreExamples && (
                    <div className="analytics-assistant__more">
                      {MORE_EXAMPLES.map((example) => (
                        <button type="button" key={example} onClick={() => ask(example)}>{example}<span aria-hidden="true">→</span></button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {messages.map((item) => (
                <article className={`assistant-message assistant-message--${item.role}${item.tone === "error" ? " assistant-message--error" : ""}`} key={item.id}>
                  <span>{item.role === "assistant" ? "MPLTalkies" : "You"}</span>
                  <div className="assistant-message__bubble">{item.text}</div>
                  {item.role === "assistant" && (
                    <button className="assistant-message__copy" type="button" onClick={() => copyAnswer(item)}>
                      {copiedId === item.id
                        ? <span aria-hidden="true">✓</span>
                        : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M3 10V4.5C3 3.7 3.7 3 4.5 3H10" /></svg>}
                      {copiedId === item.id ? "Copied" : "Copy answer"}
                    </button>
                  )}
                </article>
              ))}

              {loading && (
                <div className="assistant-thinking" role="status"><span className="assistant-thinking__mark">MPL</span><span>Reading captured data</span><i /><i /><i /></div>
              )}

              {!loading && messages.at(-1)?.role === "assistant" && (
                <div className="analytics-assistant__followups" aria-label="Suggested follow-up questions">
                  {FOLLOW_UPS.map((item) => (
                    <button type="button" key={item.label} onClick={() => ask(item.prompt)}>{item.label}</button>
                  ))}
                </div>
              )}
            </div>

            <form className="analytics-assistant__composer" onSubmit={(event) => { event.preventDefault(); ask(input); }}>
              <label className="sr-only" htmlFor="analytics-question">Ask about collection data</label>
              <textarea
                id="analytics-question"
                ref={inputRef}
                rows="1"
                maxLength="240"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    ask(input);
                  }
                }}
                placeholder="Ask about a movie, theatre or date…"
              />
              <button type="submit" disabled={!input.trim() || loading} aria-label="Send question">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4" /></svg>
              </button>
            </form>
            <p className="analytics-assistant__note"><span aria-hidden="true">●</span> Read-only answers from captured records</p>
          </aside>
        </>
      )}
    </>,
    document.body
  );
}
