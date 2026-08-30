import { useEffect, useRef, useState } from "react";
import { formatAnalyticsAnswer, formatComparisonAnswer, parseAnalyticsQuestion } from "./analyticsQuery.js";
import { formatFullGrossAnswer, parseFullGrossQuestion } from "./fullGrossCalculator.js";

const suggestions = [
  "iru 1w g",
  "28 rpt",
  "rv 170 100",
  "iru vs tox 1we",
  "all full gross",
  "help"
];
const CATALOG_MAX_AGE_MS = 10 * 60 * 1000;

let nextMessageId = 1;

function message(role, text) {
  const uniquePart = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${nextMessageId++}`;
  return { id: `${role}-${uniquePart}`, role, text };
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
  const catalogRef = useRef(null);
  const catalogFetchedAtRef = useRef(0);
  const lastContextRef = useRef(null);
  const conversationRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
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

  async function ask(rawQuestion) {
    const question = String(rawQuestion || "").trim();
    if (!question || loading) return;
    setInput("");
    setMessages((current) => [...current, message("user", question)]);
    setLoading(true);

    try {
      let catalog = await loadCatalog();
      const capacityContext = lastContextRef.current?.type === "capacity" ? lastContextRef.current.request : null;
      const capacityParsed = parseFullGrossQuestion(question, catalog, capacityContext);
      if (capacityParsed) {
        const answer = capacityParsed.reply || formatFullGrossAnswer(capacityParsed.request, catalog);
        if (capacityParsed.request) lastContextRef.current = { type: "capacity", request: capacityParsed.request };
        setMessages((current) => [...current, message("assistant", answer)]);
        return;
      }

      const analyticsContext = lastContextRef.current?.type === "analytics" ? lastContextRef.current.request : null;
      let parsed = parseAnalyticsQuestion(question, catalog, new Date(), analyticsContext);
      if (parsed.reply?.startsWith("I couldn’t identify the movie")) {
        catalog = await loadCatalog(true);
        parsed = parseAnalyticsQuestion(question, catalog, new Date(), analyticsContext);
      }
      if (parsed.reply) {
        setMessages((current) => [...current, message("assistant", parsed.reply)]);
        return;
      }

      if (parsed.request.mode === "comparison") {
        const summaries = await Promise.all(parsed.request.entries.map(async (entry) => {
          const query = new URLSearchParams({
            movie: entry.movieTitle,
            venueCode: entry.venueCode,
            startDate: entry.startDate,
            endDate: entry.endDate
          });
          return responseJson(await fetch(`${apiBase}/api/analytics/summary?${query}`, { cache: "no-store" }));
        }));
        lastContextRef.current = { type: "analytics", request: parsed.request.contextRequest };
        setMessages((current) => [...current, message("assistant", formatComparisonAnswer(parsed.request, summaries))]);
        return;
      }

      const query = new URLSearchParams({
        movie: parsed.request.movieTitle,
        venueCode: parsed.request.venueCode,
        startDate: parsed.request.startDate,
        endDate: parsed.request.endDate
      });
      const summary = await responseJson(await fetch(`${apiBase}/api/analytics/summary?${query}`, { cache: "no-store" }));
      lastContextRef.current = { type: "analytics", request: parsed.request };
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
            <button type="button" onClick={() => setOpen(false)} aria-label="Close collection assistant">×</button>
          </header>

          <div className="analytics-assistant__conversation" ref={conversationRef} aria-live="polite">
            {!messages.length && (
              <div className="analytics-assistant__welcome">
                <p className="eyebrow">Ask the collection desk</p>
                <h2>Fast answers from captured show data.</h2>
                <p>Full questions, shortcuts, typo correction, comparisons, and rankings work. Try “iru 1w g”, “iru vs tox 1we”, or type “help”.</p>
                <div className="analytics-assistant__suggestions">
                  {suggestions.map((suggestion) => (
                    <button type="button" key={suggestion} onClick={() => ask(suggestion)}>{suggestion}</button>
                  ))}
                </div>
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
