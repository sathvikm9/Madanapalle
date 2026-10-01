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

  function districtMovieSlug(title) {
    return String(title || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function districtMovieCode(value) {
    const match = String(value || "").trim().toUpperCase().match(/^(?:MV)?(\d+)$/);
    if (!match) throw new Error("A valid District movie code is required");
    return `MV${match[1]}`;
  }

  function districtMovieUrl(title, value) {
    const code = districtMovieCode(value);
    const slug = districtMovieSlug(title);
    if (!slug) throw new Error("A movie title is required");
    return `https://www.district.in/movies/${slug}-movie-tickets-${code}`;
  }

  function normalizedTitle(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("en-IN")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function titlesMatch(left, right) {
    const normalizedLeft = normalizedTitle(left);
    const normalizedRight = normalizedTitle(right);
    return normalizedLeft === normalizedRight ||
      normalizedLeft.replaceAll(" ", "") === normalizedRight.replaceAll(" ", "");
  }

  function validRawDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? isoDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
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

  function readDistrictPage(document, location, expected = {}) {
    const href = String(location?.href || "");
    let url;
    try {
      url = new URL(href);
    } catch {
      throw new Error("District movie URL is invalid");
    }
    if (url.protocol !== "https:" || !(
      url.hostname === "district.in" ||
      url.hostname === "www.district.in" ||
      url.hostname.endsWith(".district.in")
    )) {
      throw new Error("District movie metadata opened on an unexpected host");
    }

    const expectedCode = districtMovieCode(expected.eventCode);
    const urlCode = url.pathname.match(/-MV(\d+)(?:$|[/?#])/i);
    if (!urlCode || districtMovieCode(urlCode[1]) !== expectedCode) {
      throw new Error("District movie page did not match the requested movie code");
    }

    let movie = null;
    const nextData = document?.querySelector?.('script#__NEXT_DATA__[type="application/json"]');
    if (nextData?.textContent) {
      try {
        movie = JSON.parse(nextData.textContent)?.props?.pageProps?.data?.movieData?.meta?.movie || null;
      } catch {
        throw new Error("District movie metadata was invalid");
      }
    }

    let canonicalTitle = String(movie?.name || "").trim();
    let releaseDate = validRawDate(movie?.release_date);
    const contentId = String(movie?.content_id ?? movie?.contentId ?? "").trim();

    if (!canonicalTitle || !releaseDate || !contentId) {
      for (const script of document?.querySelectorAll?.('script[type="application/ld+json"]') || []) {
        try {
          const structured = JSON.parse(script.textContent || "null");
          const entries = Array.isArray(structured) ? structured : [structured];
          const candidate = entries.find((entry) => entry?.["@type"] === "Movie");
          if (!candidate) continue;
          canonicalTitle ||= String(candidate.name || "").trim();
          releaseDate ||= validRawDate(candidate.datePublished);
        } catch {
          // Ignore unrelated or malformed structured-data blocks.
        }
      }
    }

    if (contentId && districtMovieCode(contentId) !== expectedCode) {
      throw new Error("District movie content ID did not match the requested movie code");
    }
    if (!canonicalTitle) throw new Error("District movie title was not found");
    if (!releaseDate) throw new Error("District raw release date was not found");
    if (expected.movieTitle && !titlesMatch(canonicalTitle, expected.movieTitle)) {
      throw new Error("District movie title did not match the discovered show");
    }

    return {
      canonicalTitle,
      releaseDate,
      movieUrl: url.toString(),
      eventCode: expectedCode
    };
  }

  global.SKCTMovieMetadata = {
    districtMovieCode,
    districtMovieSlug,
    districtMovieUrl,
    movieSlug,
    movieUrl,
    parseReleaseDateText,
    readDistrictPage,
    readPage
  };
})(globalThis);
