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
        seatLayoutUrl: ticketNewVenueUrl(pageUrl, dateCode),
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

  function cinemaPayload(state, cinemaId, dateCode) {
    const date = `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`;
    const sessions = state?.props?.pageProps?.data?.serverState?.cinemaSessions || {};
    const payload = sessions[`${cinemaId}${date}`] || Object.values(sessions).find((item) => (
      String(item?.meta?.cinema?.id) === String(cinemaId)
    ));
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
        contentId: group.entityCode,
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

  function ticketNewVenueUrl(pageUrl, dateCode) {
    const url = new URL(pageUrl);
    url.search = "";
    url.searchParams.set("fromdate", `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`);
    return url.toString();
  }

  function integer(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`TicketNew returned an invalid ${name}`);
    return number;
  }

  root.SKCTTicketNew = Object.freeze({ readState, discover, capture });
})(globalThis);
