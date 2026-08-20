import { bmsCodeToIso, captureAtFromCutoff, cutoffFromStart, isoDateFromCode } from "./time.js";
import { rupeesToPaise } from "./money.js";

export function extractAssignedJson(html, assignment = "window.__INITIAL_STATE__") {
  const marker = html.indexOf(assignment);
  if (marker < 0) throw new Error(`${assignment} was not found in the page`);
  const start = html.indexOf("{", marker + assignment.length);
  if (start < 0) throw new Error(`No JSON object follows ${assignment}`);

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
  }

  throw new Error(`Unterminated JSON object for ${assignment}`);
}

function findShowtimeData(state, venueCode, dateCode) {
  const queries = state?.venueShowtimesFunctionalApi?.queries || {};
  const direct = queries[`getShowtimesByVenue-${venueCode}-${dateCode}`];
  if (direct?.data?.showDetailsTransformed) return direct.data.showDetailsTransformed;

  const match = Object.values(queries).find(
    (query) =>
      query?.originalArgs?.venueCode === venueCode &&
      String(query?.originalArgs?.dateCode || query?.originalArgs?.showDateCode || "") === dateCode
  );
  if (match?.data?.showDetailsTransformed) return match.data.showDetailsTransformed;

  const legacy = state?.venueShowtimesNew?.[dateCode];
  if (legacy?.events || legacy?.Event) {
    return {
      Event: legacy.events || legacy.Event,
      Venues: state.venueShowtimesNew.venueDetails
    };
  }

  throw new Error(`No showtime payload found for ${venueCode} on ${dateCode}`);
}

export function parseVenueShowsFromHtml(html, venue, dateCode) {
  const state = extractAssignedJson(html);
  const details = findShowtimeData(state, venue.venueCode, dateCode);
  const shows = [];

  for (const event of details.Event || []) {
    for (const child of event.ChildEvents || []) {
      for (const show of child.ShowTimes || []) {
        const startAt = bmsCodeToIso(show.ShowDateTime);
        const cutoffAt = show.CutOffDateTime
          ? bmsCodeToIso(show.CutOffDateTime)
          : cutoffFromStart(startAt, venue.fallbackCutoffMinutes || 15);
        const sessionId = String(show.SessionId || "");
        const eventCode = String(child.EventCode || "");
        const naturalKey = [venue.venueCode, show.ShowDateCode, show.ShowTimeCode, sessionId, eventCode].join(":");
        const slotKey = [venue.venueCode, show.ShowDateCode, show.ShowTimeCode].join(":");

        shows.push({
          naturalKey,
          slotKey,
          venueCode: venue.venueCode,
          venueName: details.Venues?.VenueName || venue.name,
          showDate: isoDateFromCode(show.ShowDateCode),
          showDateCode: show.ShowDateCode,
          showTimeCode: show.ShowTimeCode,
          showTimeLabel: show.ShowTime,
          startAt,
          cutoffAt,
          captureAt: captureAtFromCutoff(cutoffAt, venue.captureBeforeCutoffMinutes ?? 1),
          sessionId,
          eventCode,
          movieTitle: event.EventTitle || child.EventName || "Unknown movie",
          movieVariant: child.EventName || event.EventTitle || "Unknown movie",
          language: child.EventLanguage || "",
          format: child.EventDimension || "",
          attributes: show.Attributes || "",
          screenName: show.ScreenName || "",
          advertisedCategories: (show.Categories || []).map((category) => ({
            name: category.PriceDesc || "Category",
            priceCode: category.PriceCode || "",
            listPricePaise: rupeesToPaise(category.CurPrice)
          })),
          seatLayoutUrl: `https://in.bookmyshow.com/movies/mdnp/seat-layout/${eventCode}/${venue.venueCode}/${sessionId}/${show.ShowDateCode}`
        });
      }
    }
  }

  return shows;
}
