(function attachMovieMetadata(global) {
  const MONTHS = new Map([
    ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3],
    ["apr", 4], ["april", 4], ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7],
    ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9], ["september", 9], ["oct", 10],
    ["october", 10], ["nov", 11], ["november", 11], ["dec", 12], ["december", 12]
  ]);

  function isoDate(year, month, day) {
    const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
  }

  function parseReleaseDateText(text) {
    const pattern = /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*,?\s*(\d{4})\b/i;
    const match = String(text || "").match(pattern);
    if (!match) return null;
    return isoDate(Number(match[3]), MONTHS.get(match[2].toLowerCase()), Number(match[1]));
  }

  function movieSlug(title) {
    return String(title || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function movieUrl(title, eventCode) {
    const code = String(eventCode || "").trim().toUpperCase();
    if (!/^ET\d+$/.test(code)) throw new Error("A valid BookMyShow event code is required");
    const slug = movieSlug(title);
    if (!slug) throw new Error("A movie title is required");
    return `https://in.bookmyshow.com/movies/madanapalle/${slug}/${code}`;
  }

  function readPage(document, location) {
    const bodyText = String(document?.body?.innerText || document?.body?.textContent || "");
    const pageTitle = String(document?.title || "");
    if (/cloudflare|checking your browser|verify you are human|just a moment/i.test(`${pageTitle}\n${bodyText}`)) {
      throw new Error("BookMyShow opened a verification page instead of the movie details");
    }
    const heading = document?.querySelector?.("h1");
    const canonicalTitle = String(heading?.textContent || "").trim();
    let releaseDate = null;
    let node = heading;
    for (let depth = 0; node && depth < 7 && !releaseDate; depth += 1, node = node.parentElement) {
      releaseDate = parseReleaseDateText(node.textContent);
    }
    releaseDate ||= parseReleaseDateText(bodyText);
    if (!canonicalTitle) throw new Error("BookMyShow movie title was not found");
    if (!releaseDate) throw new Error("BookMyShow release date was not found");
    return {
      canonicalTitle,
      releaseDate,
      movieUrl: String(location?.href || "")
    };
  }

  global.SKCTMovieMetadata = { movieSlug, movieUrl, parseReleaseDateText, readPage };
})(globalThis);
