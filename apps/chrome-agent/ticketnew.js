(function attachTicketNewParser(root) {
  const INDIA_TIMEZONE = "Asia/Kolkata";

  function readState(document) {
    const script = document.querySelector('script#__NEXT_DATA__[type="application/json"]');
    if (!script?.textContent) {
      throw new Error("TicketNew data is unavailable. Check the pinned tab and reload it once.");
    }
    return JSON.parse(script.textContent);
  }

  function discover(state, venue, dateCode, pageUrl) {
    const payload = cinemaPayload(state, venue.cinemaId, dateCode);
    const sessions = sessionList(payload);
    const sessionDetails = sessionMetadata(payload, state);
    const shows = [];

    for (const session of sessions) {
      const start = ticketNewDate(session.showTime);
      const cutoff = ticketNewDate(session.closeTime);
      const local = indiaParts(start);
      const localDateCode = `${local.year}${local.month}${local.day}`;
      if (localDateCode !== dateCode) continue;
      const metadata = sessionDetails.get(String(session.sid)) || {};
      const eventCode = String(session.mid || metadata.eventCode || metadata.contentId || "movie");
      const sessionId = String(session.sid || "");
      if (!metadata.movieTitle) {
        throw new Error(`TicketNew did not expose a movie title for session ${sessionId || eventCode}`);
      }
      const showTimeCode = `${local.hour}${local.minute}`;
      const naturalKey = [venue.venueCode, dateCode, showTimeCode, sessionId, eventCode].join(":");

      shows.push({
        naturalKey,
        slotKey: [venue.venueCode, dateCode, showTimeCode].join(":"),
        venueCode: venue.venueCode,
        platform: "ticketnew",
        cinemaId: venue.cinemaId,
        dateCode,
        eventCode,
        contentId: metadata.contentId || "",
        sessionId,
        showDateTime: indiaDateTimeCode(start),
        cutoffDateTime: indiaDateTimeCode(cutoff),
        showTimeCode,
        showTimeLabel: indiaTimeLabel(start),
        movieTitle: metadata.movieTitle,
        movieVariant: metadata.movieVariant || metadata.movieTitle,
        language: session.lang || metadata.language || "",
        format: session.scrnFmt || "",
        attributes: (session.gnrs || []).join(", "),
        screenName: session.audi || "",
        startAt: start.toISOString(),
        cutoffAt: cutoff.toISOString(),
        captureAt: new Date(start.getTime() + Number(venue.captureStartAfterShowMinutes) * 60_000).toISOString(),
        finalCaptureAt: new Date(cutoff.getTime() - 60_000).toISOString(),
        seatLayoutUrl: ticketNewVenueUrl(pageUrl, dateCode, venue),
        directSeatLayoutUrl: ticketNewDirectSeatLayoutUrl(session, metadata, dateCode),
        categories: advertisedCategories(session.areas)
      });
    }

    return { venueCode: venue.venueCode, dateCode, shows };
  }

  function capture(state, show, capturedAt = new Date()) {
    const payload = cinemaPayload(state, show.cinemaId || 4903, show.dateCode);
    const sessions = sessionList(payload);
    const session = sessions.find((candidate) => String(candidate.sid) === String(show.sessionId));
    if (!session) throw new Error(`TicketNew session ${show.sessionId} is no longer listed`);

    const categories = (session.areas || []).map((area) => {
      const capacity = integer(area.sTotal ?? area.seatsTotal, `${area.label} capacity`);
      const available = integer(area.sAvail ?? area.seatsAvail, `${area.label} availability`);
      if (available > capacity) throw new Error(`${area.label} availability exceeded capacity`);
      return {
        name: String(area.label || "Category"),
        price: Number(area.price || 0),
        capacity,
        available,
        sold: capacity - available,
        unknown: 0
      };
    });
    if (!categories.length) throw new Error("TicketNew did not expose seat categories for this session");

    const captured = new Date(capturedAt);
    return {
      naturalKey: show.naturalKey,
      attemptId: show.attemptId,
      capturedAt: captured.toISOString(),
      captureMinute: indiaCaptureMinute(captured),
      categories
    };
  }

  function findLiveSeatLayoutUrl(document, show, pageUrl = document?.location?.href) {
    const sessionId = String(show?.sessionId || "").toLowerCase();
    if (!sessionId) return null;
    for (const anchor of document?.querySelectorAll?.('a[href*="/movies/seat-layout/"]') || []) {
      const rawUrl = anchor.href || anchor.getAttribute?.("href");
      if (!rawUrl) continue;
      let url;
      try {
        url = new URL(rawUrl, pageUrl);
      } catch {
        continue;
      }
      const pathSession = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "").toLowerCase();
      const encodedSession = String(url.searchParams.get("encsessionid") || "").toLowerCase();
      const dateCode = String(url.searchParams.get("fromdate") || "").replaceAll("-", "");
      const matchesSession = sessionIdentityMatches(pathSession, encodedSession, sessionId);
      const matchesDate = !show?.dateCode || dateCode === String(show.dateCode);
      if (url.protocol === "https:" && url.hostname.endsWith("ticketnew.com") &&
          url.pathname.includes("/movies/seat-layout/") && matchesSession && matchesDate) {
        return url.toString();
      }
    }
    return null;
  }

  function isLiveSeatLayout(location, show) {
    try {
      const url = new URL(location?.href || String(location));
      const sessionId = String(show?.sessionId || "").toLowerCase();
      const pathSession = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "").toLowerCase();
      const encodedSession = String(url.searchParams.get("encsessionid") || "").toLowerCase();
      const dateCode = String(url.searchParams.get("fromdate") || "").replaceAll("-", "");
      return url.hostname.endsWith("ticketnew.com") &&
        url.pathname.includes("/movies/seat-layout/") &&
        Boolean(sessionId) &&
        sessionIdentityMatches(pathSession, encodedSession, sessionId) &&
        (!show?.dateCode || dateCode === String(show.dateCode));
    } catch {
      return false;
    }
  }

  function findSessionControl(document, show) {
    const expectedTime = normalizedTime(show?.showTimeLabel);
    const expectedTitle = normalizedTitle(show?.movieTitle);
    if (!expectedTime || !expectedTitle) return null;

    const matches = [];
    for (const control of document?.querySelectorAll?.('[role="button"]') || []) {
      if (normalizedTime(controlText(control)) !== expectedTime) continue;
      const card = movieCardForControl(control);
      if (!card) continue;
      if (!movieCardMatches(card, show, expectedTitle)) continue;
      matches.push(control);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function movieCardMatches(card, show, expectedTitle) {
    const contentId = String(show?.contentId || "").trim();
    if (contentId) {
      for (const link of card?.querySelectorAll?.('a[href*="-movie-detail-"]') || []) {
        const href = String(link.href || link.getAttribute?.("href") || "");
        if (new RegExp(`(?:-|/)${escapePattern(contentId)}(?:$|[/?#])`).test(href)) return true;
      }
      return false;
    }
    return movieTitlesFromCard(card)
      .some((title) => normalizedTitle(title) === expectedTitle);
  }

  function movieCardForControl(control) {
    let candidate = control?.parentElement || null;
    let imageFallback = null;
    for (let depth = 0; candidate && depth < 10; depth += 1, candidate = candidate.parentElement) {
      if (candidate.querySelector?.('a[href*="-movie-detail-"]')) return candidate;
      if (!imageFallback && candidate.querySelector?.('img[alt]')) imageFallback = candidate;
    }
    return imageFallback;
  }

  function movieTitlesFromCard(card) {
    const values = [];
    for (const image of card?.querySelectorAll?.("img[alt]") || []) {
      const value = image.getAttribute?.("alt");
      if (value) values.push(value);
    }
    for (const link of card?.querySelectorAll?.('a[href*="-movie-detail-"]') || []) {
      const value = controlText(link);
      if (value) values.push(value);
    }
    return values;
  }

  function normalizedTime(value) {
    const match = String(value || "").toUpperCase().match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/);
    if (!match) return "";
    return `${String(Number(match[1])).padStart(2, "0")}:${match[2]} ${match[3]}`;
  }

  function normalizedTitle(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/\b(?:movie\s+poster|poster)\b/gi, " ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .trim();
  }

  function controlText(element) {
    return String(
      element?.getAttribute?.("aria-label") ||
      element?.innerText ||
      element?.textContent ||
      ""
    ).trim();
  }

  function escapePattern(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function sessionIdentityMatches(pathSession, encodedSession, sessionId) {
    if (!sessionId) return false;
    return pathSession === sessionId ||
      new RegExp(`(?:^|-)${escapePattern(sessionId)}(?:$|-)`).test(encodedSession);
  }

  function captureLive(document, show, capturedAt = new Date()) {
    const advertised = new Map((show.categories || []).map((category) => [
      normalizeCategoryName(category.name),
      Number(category.listPricePaise || 0) / 100
    ]));
    const observed = new Map();
    const seats = document?.querySelectorAll?.('[aria-label^="available"], [aria-label^="unavailable"]') || [];

    for (const seat of seats) {
      const label = String(seat.getAttribute?.("aria-label") || "").trim();
      const status = /^available\s+seat/i.test(label)
        ? "available"
        : (/^unavailable\s+seat/i.test(label) ? "sold" : null);
      const classMatch = label.match(/class\s+([^,]+)/i);
      if (!status || !classMatch) continue;
      const name = classMatch[1].trim();
      const key = normalizeCategoryName(name);
      const priceMatch = label.match(/price\s+(\d+(?:\.\d+)?)/i);
      const category = observed.get(key) || {
        name,
        price: advertised.get(key) || 0,
        capacity: 0,
        available: 0,
        sold: 0,
        unknown: 0
      };
      category.capacity += 1;
      category[status] += 1;
      if (priceMatch) category.price = Number(priceMatch[1]);
      observed.set(key, category);
    }

    const categories = [...observed.values()];
    if (!categories.length) throw new Error("TicketNew live seat layout has not loaded any seats");
    if (categories.some((category) => !category.price)) {
      throw new Error("TicketNew live seat layout did not expose every class price");
    }
    const advertisedNames = [...advertised.keys()];
    if (advertisedNames.length && (
      categories.length !== advertisedNames.length || advertisedNames.some((name) => !observed.has(name))
    )) {
      throw new Error("TicketNew live seat layout did not expose every advertised class");
    }

    const captured = new Date(capturedAt);
    return {
      naturalKey: show.naturalKey,
      attemptId: show.attemptId,
      capturedAt: captured.toISOString(),
      captureMinute: indiaCaptureMinute(captured),
      categories
    };
  }

  function normalizeCategoryName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
  }

  function cinemaPayload(state, cinemaId, dateCode) {
    const date = `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`;
    const serverState = state?.props?.pageProps?.data?.serverState || {};
    const sessions = serverState.cinemaSessions || {};
    const payload = sessions[`${cinemaId}${date}`] || Object.values(sessions).find((item) => (
      String(item?.meta?.cinema?.id) === String(cinemaId)
    )) || serverState[String(cinemaId)];
    if (!payload || (!payload.pageData && !Array.isArray(payload.arrangedSessions))) {
      throw new Error(`No TicketNew schedule was found for cinema ${cinemaId} on ${date}`);
    }
    return payload;
  }

  function sessionList(payload) {
    const direct = payload.pageData?.sessions;
    if (Array.isArray(direct) && direct.length) return direct;
    return (payload.arrangedSessions || []).flatMap((group) => group.sessions || []);
  }

  function sessionMetadata(payload, state) {
    const result = new Map();
    const byMovieCode = movieCatalog(state);
    const arranged = payload.pageData?.arrangedSessions?.length
      ? payload.pageData.arrangedSessions
      : payload.arrangedSessions || [];

    for (const group of arranged) {
      const metadata = {
        eventCode: group.data?.id,
        contentId: group.entityCode || group.data?.contentId,
        movieTitle: group.entityName || group.data?.label || group.data?.name,
        movieVariant: group.data?.name || group.entityName,
        language: group.data?.lang || group.data?.languages
      };
      for (const session of group.sessions || []) {
        result.set(String(session.sid), metadata);
        if (session.mid) byMovieCode.set(String(session.mid), metadata);
      }
      for (const languageGroup of group.data?.languageFormatGroups || []) {
        for (const format of languageGroup.screenFormats || []) {
          if (format.movieCode) byMovieCode.set(String(format.movieCode), metadata);
        }
      }
    }
    for (const movie of payload.meta?.movies || []) {
      byMovieCode.set(String(movie.id), movieMetadata(movie));
    }
    for (const session of sessionList(payload)) {
      if (result.has(String(session.sid))) continue;
      const metadata = byMovieCode.get(String(session.mid));
      if (metadata) result.set(String(session.sid), metadata);
    }
    return result;
  }

  function movieCatalog(state) {
    const result = new Map();
    const sources = [
      state?.props?.pageProps?.data?.serverState?.currentlyRunningMovies,
      state?.props?.pageProps?.initialState?.movies?.currentlyRunningMovies
    ];
    for (const source of sources) {
      for (const city of Object.values(source || {})) {
        for (const movie of city?.data?.movies || []) {
          if (movie.id) result.set(String(movie.id), movieMetadata(movie));
        }
      }
    }
    return result;
  }

  function movieMetadata(movie) {
    const title = movie.name || movie.label;
    return {
      eventCode: movie.id,
      contentId: movie.contentId,
      movieTitle: title,
      movieVariant: title,
      language: movie.lang || movie.languages
    };
  }

  function advertisedCategories(areas = []) {
    return areas.map((area) => ({
      name: String(area.label || "Category"),
      priceCode: String(area.code || ""),
      listPricePaise: Math.round(Number(area.price || 0) * 100)
    }));
  }

  function ticketNewDate(value) {
    const text = String(value || "");
    const date = new Date(`${text}${text.length === 16 ? ":00" : ""}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? "" : "Z"}`);
    if (!Number.isFinite(date.getTime())) throw new Error(`TicketNew returned an invalid show time: ${text}`);
    return date;
  }

  function indiaParts(value) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: INDIA_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(value);
    return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  }

  function indiaDateTimeCode(value) {
    const parts = indiaParts(value);
    return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
  }

  function indiaTimeLabel(value) {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: INDIA_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    }).format(value).toUpperCase();
  }

  function indiaCaptureMinute(value) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: INDIA_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).format(value);
  }

  function ticketNewVenueUrl(pageUrl, dateCode, venue) {
    const url = new URL(pageUrl);
    if (url.hostname === "www.district.in" || url.hostname.endsWith(".district.in")) {
      url.protocol = "https:";
      url.hostname = "ticketnew.com";
      url.pathname = `/movies/madanapalle/${venue.slug}/${venue.cinemaId}`;
    }
    url.search = "";
    url.searchParams.set("fromdate", `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`);
    return url.toString();
  }

  function ticketNewDirectSeatLayoutUrl(session, metadata, dateCode) {
    const sessionId = String(session?.sid || "");
    const cinemaId = String(session?.cid || "");
    const movieCode = String(session?.mid || metadata?.eventCode || "").toLowerCase();
    const formatId = String(session?.fid || "").toLowerCase();
    if (!sessionId || !cinemaId || !formatId) return null;
    const encodedSession = String(session.encSessionId || [cinemaId, sessionId, movieCode, formatId]
      .filter(Boolean)
      .join("-"));
    if (!sessionIdentityMatches("", encodedSession.toLowerCase(), sessionId.toLowerCase())) return null;

    const url = new URL(`https://ticketnew.com/movies/seat-layout/${encodeURIComponent(formatId)}`);
    url.searchParams.set("encsessionid", encodedSession);
    url.searchParams.set("fromdate", `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`);
    url.searchParams.set("freeseating", String(Boolean(session.freeSeating || session.freeseating)));
    url.searchParams.set("fromsessions", "true");
    url.searchParams.set("type", "CINEMAS");
    if (metadata?.contentId) url.searchParams.set("contentid", String(metadata.contentId));
    return url.toString();
  }

  function integer(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`TicketNew returned an invalid ${name}`);
    return number;
  }

  root.SKCTTicketNew = Object.freeze({
    readState,
    discover,
    capture,
    captureLive,
    findLiveSeatLayoutUrl,
    isLiveSeatLayout,
    findSessionControl,
    sessionIdentityMatches
  });
})(globalThis);
