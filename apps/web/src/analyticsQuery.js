const THEATRES = [
  { code: "SCM", name: "Sai Chitra", aliases: ["sai chitra", "saichitra", "sai", "sc"] },
  { code: "ASRM", name: "ASR", aliases: ["asr"] },
  { code: "RTDM", name: "Ravi", aliases: ["ravi", "rv"] },
  { code: "SKMD", name: "Sri Krishna", aliases: ["sri krishna", "srikrishna", "krishna", "sri", "sk"] }
];

const DAY_ONE_OVERRIDES = new Map([
  ["irumudi", "2026-08-21"]
]);

const MONTH_NUMBERS = new Map([
  ["jan", 1], ["january", 1],
  ["feb", 2], ["february", 2],
  ["mar", 3], ["march", 3],
  ["apr", 4], ["april", 4],
  ["may", 5],
  ["jun", 6], ["june", 6],
  ["jul", 7], ["july", 7],
  ["aug", 8], ["august", 8],
  ["sep", 9], ["sept", 9], ["september", 9],
  ["oct", 10], ["october", 10],
  ["nov", 11], ["november", 11],
  ["dec", 12], ["december", 12]
]);
const MONTH_PATTERN = Array.from(MONTH_NUMBERS.keys()).sort((a, b) => b.length - a.length).join("|");

const mutationPattern = /\b(update|change|correct|edit|delete|remove|overwrite|replace|write|set)\b/i;
const trackedDataPattern = /\b(gross|collection|show|ticket|data|database|record|amount)\b/i;

export const READ_ONLY_REPLY = "I’m read-only. I cannot update, correct, or delete tracked data. I can only report what the collector already stored.";
export const SHORTCUTS_REPLY = [
  "Shortcut examples",
  "",
  "Movies: iru, tox, vis (or any unique first few letters)",
  "Theatres: sc, asr, rv, sk, all",
  "Metrics: g = gross, hf = housefull, sh = shows, tix = tickets, rpt = report",
  "Periods: d1 = Day 1, 1w = first week, 1we = first weekend, 10d = first 10 days",
  "Dates: 28 g, 28 rpt, today g, yday rpt",
  "Calculator: rv 170 100, sk 105 84 x5, all 200 150 full",
  "Follow-ups: g?, hf?, rv?, x5, same sk",
  "Compare: iru vs tox 1we, compare d1 vs d2",
  "Rankings: highest iru theatre gross, iru day wise, which day iru most hf"
].join("\n");

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[’']/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLocaleLowerCase("en-IN");
}

function expandShortcuts(value) {
  const replacements = new Map([
    ["g", "gross"], ["grs", "gross"], ["gros", "gross"], ["groos", "gross"], ["coll", "gross"],
    ["hf", "housefull"], ["hfull", "housefull"], ["housfull", "housefull"], ["soldout", "housefull"],
    ["sh", "screened"], ["scr", "screened"],
    ["tix", "tickets"], ["tkt", "tickets"], ["tkts", "tickets"],
    ["rpt", "report"], ["rep", "report"], ["reprot", "report"], ["sumry", "summary"],
    ["tw", "theatre wise"], ["theaterwise", "theatre wise"], ["theatrewise", "theatre wise"],
    ["tdy", "today"], ["2day", "today"], ["yday", "yesterday"], ["yst", "yesterday"], ["ydy", "yesterday"],
    ["wk1", "first week"], ["w1", "first week"], ["1w", "first week"],
    ["we1", "first weekend"], ["1we", "first weekend"]
  ]);
  return normalize(value).split(" ").flatMap((token) => {
    if (replacements.has(token)) return replacements.get(token).split(" ");
    const movieDay = token.match(/^d(\d{1,3})$/);
    if (movieDay) return ["day", movieDay[1]];
    const firstDays = token.match(/^(\d{1,3})d$/);
    if (firstDays) return ["first", firstDays[1], "days"];
    return [token];
  }).join(" ");
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function calendarDate(year, month, day) {
  const padded = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const value = new Date(`${padded}T00:00:00.000Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === padded ? padded : null;
}

function calendarPeriod(question, today) {
  const raw = String(question || "").toLocaleLowerCase("en-IN");
  const isoMatch = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const date = calendarDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    if (date) return { key: "date", label: "Selected date", startDate: date, endDate: date };
  }

  const text = raw
    .replace(/[–—]/g, " to ")
    .replace(/(\d)\s*-\s*(?=\d|[a-z])/g, "$1 to ")
    .replace(/[,./]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const defaultYear = Number(today.slice(0, 4));
  const ordinal = "(\\d{1,2})(?:st|nd|rd|th)?";

  const monthFirst = text.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+${ordinal}(?:\\s+(?:to|through|until)\\s+(?:(${MONTH_PATTERN})\\s+)?${ordinal})?(?:\\s+(20\\d{2}))?\\b`));
  if (monthFirst) {
    const year = Number(monthFirst[5] || defaultYear);
    const start = calendarDate(year, MONTH_NUMBERS.get(monthFirst[1]), Number(monthFirst[2]));
    const end = monthFirst[4]
      ? calendarDate(year, MONTH_NUMBERS.get(monthFirst[3] || monthFirst[1]), Number(monthFirst[4]))
      : start;
    if (start && end) return { key: start === end ? "date" : "date_range", label: start === end ? "Selected date" : "Selected dates", startDate: start, endDate: end };
  }

  const dayFirstRange = text.match(new RegExp(`\\b${ordinal}\\s+(?:to|through|until)\\s+${ordinal}\\s+(${MONTH_PATTERN})(?:\\s+(20\\d{2}))?\\b`));
  if (dayFirstRange) {
    const year = Number(dayFirstRange[4] || defaultYear);
    const month = MONTH_NUMBERS.get(dayFirstRange[3]);
    const start = calendarDate(year, month, Number(dayFirstRange[1]));
    const end = calendarDate(year, month, Number(dayFirstRange[2]));
    if (start && end) return { key: "date_range", label: "Selected dates", startDate: start, endDate: end };
  }

  const dayFirst = text.match(new RegExp(`\\b${ordinal}\\s+(${MONTH_PATTERN})(?:\\s+(20\\d{2}))?\\b`));
  if (dayFirst) {
    const date = calendarDate(Number(dayFirst[3] || defaultYear), MONTH_NUMBERS.get(dayFirst[2]), Number(dayFirst[1]));
    if (date) return { key: "date", label: "Selected date", startDate: date, endDate: date };
  }

  return null;
}

function firstWeekend(dayOne) {
  const weekday = new Date(`${dayOne}T00:00:00.000Z`).getUTCDay();
  const startOffset = weekday === 6 || weekday === 0 ? 0 : (5 - weekday + 7) % 7;
  const startDate = addDays(dayOne, startOffset);
  const startWeekday = new Date(`${startDate}T00:00:00.000Z`).getUTCDay();
  const endDate = addDays(startDate, (7 - startWeekday) % 7);
  return { key: "first_weekend", label: "First weekend", startDate, endDate };
}

export function indiaDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

function movieAliasCandidates(movies) {
  const ignoredInitialWords = new Set(["a", "an", "and", "for", "of", "the", "to"]);
  return movies.map((movie) => {
    const full = normalize(movie.title);
    const beforeColon = normalize(String(movie.title).split(":")[0]);
    const first = full.split(" ")[0];
    const aliases = new Set([full]);
    if (beforeColon.length >= 4) aliases.add(beforeColon);
    const withoutJoiners = full.split(" ").filter((word) => !ignoredInitialWords.has(word)).join(" ");
    if (withoutJoiners.length >= 4) aliases.add(withoutJoiners);
    for (let length = 3; length <= first.length; length += 1) aliases.add(first.slice(0, length));
    const initials = full.split(" ")
      .filter((word) => !ignoredInitialWords.has(word))
      .map((word) => word[0])
      .join("");
    if (initials.length >= 2 && initials !== "vs") aliases.add(initials);
    return { movie, aliases };
  });
}

function movieAliases(movies) {
  const candidates = movieAliasCandidates(movies);
  const aliasCounts = new Map();
  for (const candidate of candidates) {
    for (const alias of candidate.aliases) aliasCounts.set(alias, (aliasCounts.get(alias) || 0) + 1);
  }
  return candidates.flatMap(({ movie, aliases }) => Array.from(aliases)
    .filter((alias) => aliasCounts.get(alias) === 1)
    .map((alias) => ({ alias, movie })))
    .sort((left, right) => right.alias.length - left.alias.length);
}

function ambiguousMovieAlias(question, movies) {
  const padded = ` ${normalize(question)} `;
  const aliases = new Map();
  for (const { movie, aliases: candidateAliases } of movieAliasCandidates(movies)) {
    for (const alias of candidateAliases) {
      if (!aliases.has(alias)) aliases.set(alias, []);
      aliases.get(alias).push(movie);
    }
  }

  return Array.from(aliases.entries())
    .filter(([alias, matches]) => matches.length > 1 && padded.includes(` ${alias} `))
    .sort((left, right) => right[0].length - left[0].length)[0]?.[1] || [];
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function questionPhrases(question) {
  const ignored = new Set([
    "and", "compare", "versus", "vs", "gross", "report", "summary", "housefull", "screened",
    "tickets", "first", "week", "weekend", "day", "days", "theatre", "theater", "wise", "highest",
    "most", "which", "give", "show", "shows", "full", "till", "now", "same", "what", "is", "the"
  ]);
  const words = normalize(question).split(" ").filter((word) => word && !ignored.has(word) && !/^\d/.test(word));
  const phrases = new Set(words);
  for (let size = 2; size <= Math.min(4, words.length); size += 1) {
    for (let index = 0; index <= words.length - size; index += 1) {
      phrases.add(words.slice(index, index + size).join(" "));
    }
  }
  return Array.from(phrases);
}

function findMovies(question, movies) {
  const padded = ` ${normalize(question)} `;
  const matches = [];
  for (const { alias, movie } of movieAliases(movies)) {
    if (padded.includes(` ${alias} `) && !matches.includes(movie)) matches.push(movie);
  }
  return matches;
}

function findMovieMatch(question, movies) {
  const exact = findMovies(question, movies);
  if (exact.length) return { movie: exact[0], movies: exact, fuzzy: false };

  const sharedAliasMatches = ambiguousMovieAlias(question, movies);
  if (sharedAliasMatches.length) {
    return { movie: null, movies: [], fuzzy: false, uncertain: sharedAliasMatches };
  }

  const candidates = new Map();
  for (const phrase of questionPhrases(question)) {
    for (const { alias, movie } of movieAliases(movies)) {
      if (Math.abs(phrase.length - alias.length) > 2 || phrase[0] !== alias[0]) continue;
      const distance = editDistance(phrase, alias);
      const threshold = alias.length <= 6 ? 1 : 2;
      if (distance > threshold) continue;
      const previous = candidates.get(movie.title);
      if (!previous || distance < previous.distance) candidates.set(movie.title, { movie, distance });
    }
  }
  const ranked = Array.from(candidates.values()).sort((left, right) => left.distance - right.distance);
  if (!ranked.length) return { movie: null, movies: [], fuzzy: false };
  const best = ranked.filter((candidate) => candidate.distance === ranked[0].distance);
  if (best.length > 1) return { movie: null, movies: [], fuzzy: true, uncertain: best.map((candidate) => candidate.movie) };
  return { movie: best[0].movie, movies: [best[0].movie], fuzzy: true };
}

function findMovie(question, movies) {
  return findMovieMatch(question, movies).movie;
}

function findTheatre(question) {
  const padded = ` ${normalize(question)} `;
  return THEATRES.find((theatre) => theatre.aliases.some((alias) => padded.includes(` ${alias} `))) || null;
}

function periodForQuestion(question, movie, today) {
  const normalized = normalize(question);
  const dayOne = DAY_ONE_OVERRIDES.get(normalize(movie.title)) || movie.firstTrackedDate;
  if (/\btoday\b/.test(normalized)) {
    return { key: "today", label: "Today", startDate: today, endDate: today };
  }
  if (/\byesterday\b/.test(normalized)) {
    const yesterday = addDays(today, -1);
    return { key: "yesterday", label: "Yesterday", startDate: yesterday, endDate: yesterday };
  }
  const selectedCalendarPeriod = calendarPeriod(question, today);
  if (selectedCalendarPeriod) return selectedCalendarPeriod;
  if (/\b(first|1st) weekend\b/.test(normalized)) return firstWeekend(dayOne);
  if (/\b(first|1st) week\b/.test(normalized)) {
    return { key: "first_week", label: "First week", startDate: dayOne, endDate: addDays(dayOne, 6) };
  }
  const movieDayMatch = normalized.match(/\bday\s*(\d{1,3})\b/) || normalized.match(/\b(\d{1,3})(?:st|nd|rd|th) day\b/);
  if (movieDayMatch) {
    const day = Math.max(1, Math.min(Number(movieDayMatch[1]), 366));
    const date = addDays(dayOne, day - 1);
    return { key: "movie_day", label: `Day ${day}`, startDate: date, endDate: date };
  }
  const daysMatch = normalized.match(/\b(\d{1,3})\s*days?\b/);
  if (daysMatch) {
    const days = Math.max(1, Math.min(Number(daysMatch[1]), 366));
    return { key: "days", label: `First ${days} days`, startDate: dayOne, endDate: addDays(dayOne, days - 1) };
  }
  return null;
}

function standaloneCalendarPeriod(question, today, allowBareDay = false) {
  const normalized = normalize(question);
  if (/\btoday\b/.test(normalized)) {
    return { key: "today", label: "Today", startDate: today, endDate: today };
  }
  if (/\byesterday\b/.test(normalized)) {
    const yesterday = addDays(today, -1);
    return { key: "yesterday", label: "Yesterday", startDate: yesterday, endDate: yesterday };
  }
  const selected = calendarPeriod(question, today);
  if (selected) return selected;

  const numbers = Array.from(normalized.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\b/g));
  const hasMetricHint = /\b(gross|report|summary|housefull|screened|tickets)\b/.test(normalized);
  const isRelativePeriod = /\b(day|days|week|weekend|shows?|prices?|rs|rupees?)\b/.test(normalized);
  if (numbers.length === 1 && !isRelativePeriod && (hasMetricHint || allowBareDay)) {
    const day = Number(numbers[0][1]);
    const [year, month] = today.split("-").map(Number);
    const date = calendarDate(year, month, day);
    if (date) return { key: "date", label: "Selected date", startDate: date, endDate: date };
  }
  return null;
}

function metricForQuestion(question, theatreWise) {
  const normalized = normalize(question);
  if (/\b(report|summary|breakdown)\b/.test(normalized)) return "report";
  if (theatreWise) return "report";
  if (/house ?full|sold ?out|\bfulls?\b/.test(normalized)) return "housefull";
  if (/\b(screened|screening)\b/.test(normalized) || /how many .*shows/.test(normalized)) return "screened";
  if (/\b(tickets?|footfalls?)\b/.test(normalized)) return "tickets";
  if (/\b(gross|collection|amount)\b/.test(normalized)) return "gross";
  return null;
}

function defaultPeriod(movie, today) {
  const dayOne = DAY_ONE_OVERRIDES.get(normalize(movie.title)) || movie.firstTrackedDate;
  return { key: "till_now", label: "Till now", startDate: dayOne, endDate: today };
}

function inheritedPeriod(context, movie, today) {
  if (!context) return defaultPeriod(movie, today);
  const sameMovie = normalize(context.movieTitle) === normalize(movie.title);
  if (sameMovie || new Set(["date", "date_range", "today", "yesterday"]).has(context.key)) {
    return {
      key: context.key,
      label: context.label,
      startDate: context.startDate,
      endDate: context.endDate
    };
  }

  const semanticPeriod = periodForQuestion(context.label, movie, today);
  return semanticPeriod || defaultPeriod(movie, today);
}

function comparisonMovies(question, movies) {
  const matched = [...findMovies(question, movies)];
  if (matched.length >= 2) return matched;
  for (const segment of normalize(question).split(/\b(?:compare|and|versus|vs)\b/)) {
    const candidate = findMovieMatch(segment, movies).movie;
    if (candidate && !matched.some((movie) => movie.title === candidate.title)) matched.push(candidate);
  }
  return matched;
}

function boundedPeriod(period, catalog, today) {
  const value = { ...period };
  if (value.endDate > today) value.endDate = today;
  if (value.startDate < catalog.firstLiveDate) value.startDate = catalog.firstLiveDate;
  return value;
}

function analyticsRequest(movie, period, theatre, metric = "report", extra = {}) {
  return {
    movieTitle: movie.title,
    venueCode: theatre?.code || "ALL",
    theatreName: theatre?.name || "All theatres",
    theatreWise: false,
    metric,
    ...period,
    ...extra
  };
}

export function parseAnalyticsQuestion(question, catalog, now = new Date(), context = null) {
  const rawText = String(question || "").trim();
  const text = expandShortcuts(rawText);
  if (!text) return { reply: "Type a question about a movie’s gross, screened shows, or housefull shows." };
  if (rawText === "?" || /^(help|shortcuts?|examples?)$/i.test(rawText)) return { reply: SHORTCUTS_REPLY };
  if (mutationPattern.test(text) && trackedDataPattern.test(text)) return { reply: READ_ONLY_REPLY };

  const today = indiaDate(now);
  const selectedStandalonePeriod = standaloneCalendarPeriod(text, today, Boolean(context));
  const movieMatch = findMovieMatch(text, catalog.movies || []);
  if (movieMatch.uncertain?.length) {
    return { reply: `I’m not certain which movie you mean. Did you mean ${movieMatch.uncertain.map((movie) => movie.title).join(" or ")}? Please type the movie name.` };
  }
  const detectedMovie = movieMatch.movie;
  const inheritedMovie = context && !selectedStandalonePeriod
    ? (context.movieTitle === "ALL"
      ? { title: "ALL", firstTrackedDate: catalog.firstLiveDate }
      : (catalog.movies || []).find((movie) => normalize(movie.title) === normalize(context.movieTitle)))
    : null;
  const normalizedQuestion = normalize(text);
  const theatre = findTheatre(text);

  const compareIntent = /\b(compare|versus|vs)\b/.test(normalizedQuestion);
  if (compareIntent) {
    const dayComparison = normalizedQuestion.match(/\bday\s*(\d{1,3})\b.*?\b(?:and|versus|vs)\b.*?\bday\s*(\d{1,3})\b/);
    if (dayComparison) {
      const movie = detectedMovie || inheritedMovie;
      if (!movie || movie.title === "ALL") return { reply: "Which movie should I use for the Day comparison? Try “Irumudi d1 vs d2”." };
      const entries = [dayComparison[1], dayComparison[2]].map((day) => analyticsRequest(
        movie,
        boundedPeriod(periodForQuestion(`day ${day}`, movie, today), catalog, today),
        theatre,
        "report"
      ));
      return {
        request: {
          mode: "comparison",
          comparisonType: "periods",
          metric: "report",
          entries,
          contextRequest: entries[0]
        }
      };
    }

    const movies = comparisonMovies(text, catalog.movies || []);
    if (movies.length < 2) return { reply: "Name two movies to compare, for example “Irumudi vs Toxic first weekend”." };
    const entries = movies.slice(0, 4).map((movie) => analyticsRequest(
      movie,
      boundedPeriod(periodForQuestion(text, movie, today) || defaultPeriod(movie, today), catalog, today),
      theatre,
      "report"
    ));
    return {
      request: {
        mode: "comparison",
        comparisonType: "movies",
        metric: "report",
        entries,
        contextRequest: entries[0]
      }
    };
  }

  const movie = detectedMovie || inheritedMovie || (selectedStandalonePeriod
    ? { title: "ALL", firstTrackedDate: catalog.firstLiveDate }
    : null);
  if (!movie) {
    const choices = (catalog.movies || []).map((item) => item.title).slice(0, 6).join(", ");
    return { reply: choices
      ? `I couldn’t identify the movie. Try including one of these names: ${choices}.`
      : "I couldn’t find any tracked movie data yet." };
  }

  const allTheatres = /\ball(?: theatres?)?\b/.test(normalizedQuestion);
  const explicitTheatreWise = /\b(theatre|theater)\s*(wise|breakdown)\b/.test(normalize(text));
  const metric = metricForQuestion(text, explicitTheatreWise)
    || (explicitTheatreWise ? "report" : context?.metric)
    || "report";
  const dailyAllMovies = movie.title === "ALL";
  const highestTheatre = !dailyAllMovies
    && (/\b(which|top|best|highest)\b.*\btheatre\b|\btheatre\b.*\b(highest|top|best)\b/.test(normalizedQuestion))
    && /\b(gross|collection)\b/.test(normalizedQuestion);
  const dayWise = !dailyAllMovies && /\b(day wise|daywise)\b/.test(normalizedQuestion);
  const highestHousefullDay = !dailyAllMovies
    && (/\bwhich day\b.*\b(housefull|full)\b|\bday\b.*\bmost\b.*\b(housefull|full)\b/.test(normalizedQuestion));
  const theatreWise = explicitTheatreWise || (dailyAllMovies && !theatre && metric === "report");
  const continuesPreviousPeriod = /\b(same|also|what about)\b/.test(normalizedQuestion) || /^and\b/.test(normalizedQuestion);
  const period = selectedStandalonePeriod
    || (dailyAllMovies
      ? inheritedPeriod(context, movie, today)
      : periodForQuestion(text, movie, today)
        || (detectedMovie && !continuesPreviousPeriod ? defaultPeriod(movie, today) : inheritedPeriod(context, movie, today)));
  if (period.endDate > today) period.endDate = today;
  if (period.endDate < catalog.firstLiveDate) {
    return { reply: `Tracked data begins on 21 August 2026, so I don’t have records for that date.` };
  }
  if (period.startDate < catalog.firstLiveDate) period.startDate = catalog.firstLiveDate;
  if (period.startDate > period.endDate) {
    return { reply: `${dailyAllMovies ? "That date" : movie.title} has not started in the tracked date range yet.` };
  }

  const venueCode = highestTheatre || theatreWise || allTheatres
    ? "ALL"
    : theatre?.code || context?.venueCode || "ALL";
  const theatreName = highestTheatre || theatreWise || allTheatres
    ? "All theatres"
    : theatre?.name || context?.theatreName || "All theatres";
  return {
    request: {
      movieTitle: movie.title,
      venueCode,
      theatreName,
      theatreWise,
      metric,
      ...(highestTheatre
        ? { analysisType: "highest_theatre" }
        : dayWise
          ? { analysisType: "day_wise" }
          : highestHousefullDay
            ? { analysisType: "highest_housefull_day" }
            : {}),
      ...period
    }
  };
}

const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
});
const count = new Intl.NumberFormat("en-IN");

function displayRange(startDate, endDate) {
  const options = { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" };
  const start = new Intl.DateTimeFormat("en-IN", options).format(new Date(`${startDate}T00:00:00Z`));
  if (startDate === endDate) return start;
  const end = new Intl.DateTimeFormat("en-IN", options).format(new Date(`${endDate}T00:00:00Z`));
  return `${start} – ${end}`;
}

function coverageLine(totals) {
  return totals.capturedShows === totals.screenedShows
    ? null
    : `Data captured: ${count.format(totals.capturedShows)}/${count.format(totals.screenedShows)} shows`;
}

function reportLines(totals) {
  const lines = [
    `Gross: ${currency.format(totals.collectionPaise / 100)}`,
    `Shows: ${count.format(totals.housefullShows)}/${count.format(totals.screenedShows)} full`,
    `Tickets: ${count.format(totals.ticketsSold)}`
  ];
  const coverage = coverageLine(totals);
  if (coverage) lines.push(coverage);
  return lines;
}

function displayShortDate(date) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}

export function formatComparisonAnswer(request, summaries) {
  if (!summaries.length) return "No captured comparison data was found.";
  const title = request.comparisonType === "movies"
    ? summaries.map((summary) => summary.movieTitle).join(" vs ")
    : `${summaries[0].movieTitle} — ${request.entries.map((entry) => entry.label).join(" vs ")}`;
  const lines = [`${title} — Comparison`, ""];

  summaries.forEach((summary, index) => {
    const entry = request.entries[index];
    lines.push(
      request.comparisonType === "movies" ? summary.movieTitle : entry.label,
      displayRange(summary.startDate, summary.endDate),
      ...reportLines(summary.total),
      ""
    );
  });

  if (summaries.length === 2) {
    const [left, right] = summaries.map((summary) => summary.total);
    const grossDifference = Math.abs(left.collectionPaise - right.collectionPaise);
    const leader = left.collectionPaise === right.collectionPaise
      ? "Gross is equal"
      : `${left.collectionPaise > right.collectionPaise
        ? (request.comparisonType === "movies" ? summaries[0].movieTitle : request.entries[0].label)
        : (request.comparisonType === "movies" ? summaries[1].movieTitle : request.entries[1].label)} leads by ${currency.format(grossDifference / 100)}`;
    lines.push(leader);
  }
  return lines.join("\n").trim();
}

export function formatAnalyticsAnswer(request, summary) {
  const titleParts = request.movieTitle === "ALL"
    ? [request.venueCode === "ALL" ? "All theatres" : request.theatreName, request.label]
    : [summary.movieTitle, request.label];
  if (!request.theatreWise && request.venueCode !== "ALL") titleParts.push(request.theatreName);
  const lines = [titleParts.join(" — "), displayRange(summary.startDate, summary.endDate), ""];
  const totals = summary.total;

  if (!totals.screenedShows) {
    lines.push("No screened shows were found for this selection.");
    return lines.join("\n");
  }

  if (request.analysisType === "highest_theatre") {
    const ranked = [...summary.venues].sort((left, right) => right.collectionPaise - left.collectionPaise);
    const winner = ranked[0];
    if (!winner) return `${summary.movieTitle} — Highest-grossing theatre\n\nNo theatre data was found.`;
    return [
      `${summary.movieTitle} — Highest-grossing theatre`,
      displayRange(summary.startDate, summary.endDate),
      "",
      `${winner.name} is highest at ${currency.format(winner.collectionPaise / 100)}.`,
      "",
      ...ranked.map((venue, index) => `${index + 1}. ${venue.name} — ${currency.format(venue.collectionPaise / 100)} · ${count.format(venue.capturedShows)}/${count.format(venue.screenedShows)} captured`)
    ].join("\n");
  }

  if (request.analysisType === "day_wise") {
    return [
      `${summary.movieTitle} — Day-wise gross`,
      displayRange(summary.startDate, summary.endDate),
      "",
      ...summary.days.map((day) => `${displayShortDate(day.date)} — ${currency.format(day.collectionPaise / 100)} · ${count.format(day.capturedShows)}/${count.format(day.screenedShows)} captured`),
      "",
      `Total: ${currency.format(totals.collectionPaise / 100)}`
    ].join("\n");
  }

  if (request.analysisType === "highest_housefull_day") {
    const rankedDays = [...summary.days].sort((left, right) =>
      right.housefullShows - left.housefullShows || right.collectionPaise - left.collectionPaise
    );
    const best = rankedDays[0];
    if (!best) return `${summary.movieTitle} — Most housefull shows\n\nNo daily data was found.`;
    const ties = rankedDays.filter((day) => day.housefullShows === best.housefullShows);
    return [
      `${summary.movieTitle} — Most housefull shows`,
      displayRange(summary.startDate, summary.endDate),
      "",
      `${ties.map((day) => displayShortDate(day.date)).join(" and ")} — ${count.format(best.housefullShows)} housefull ${best.housefullShows === 1 ? "show" : "shows"}`,
      `Gross on leading day: ${currency.format(best.collectionPaise / 100)}`
    ].join("\n");
  }

  if (request.metric === "gross") {
    lines.push(`Gross: ${currency.format(totals.collectionPaise / 100)}`);
    const coverage = coverageLine(totals);
    if (coverage) lines.push(coverage);
  } else if (request.metric === "housefull") {
    lines.push(`Housefull shows: ${count.format(totals.housefullShows)} of ${count.format(totals.screenedShows)}`);
    const coverage = coverageLine(totals);
    if (coverage) lines.push(coverage);
  } else if (request.metric === "screened") {
    lines.push(`Shows screened: ${count.format(totals.screenedShows)}`);
    lines.push(`Housefull: ${count.format(totals.housefullShows)}`);
    lines.push(`Captured: ${count.format(totals.capturedShows)}/${count.format(totals.screenedShows)}`);
  } else if (request.metric === "tickets") {
    lines.push(`Tickets: ${count.format(totals.ticketsSold)}`);
    const coverage = coverageLine(totals);
    if (coverage) lines.push(coverage);
  } else {
    lines.push(`Total gross: ${currency.format(totals.collectionPaise / 100)}`);
    lines.push(`Shows: ${count.format(totals.housefullShows)}/${count.format(totals.screenedShows)} full`);
    lines.push(`Tickets: ${count.format(totals.ticketsSold)}`);
    const coverage = coverageLine(totals);
    if (coverage) lines.push(coverage);
  }

  if (request.theatreWise) {
    for (const venue of summary.venues) {
      lines.push("", venue.name, ...reportLines(venue));
    }
  }

  return lines.join("\n");
}
