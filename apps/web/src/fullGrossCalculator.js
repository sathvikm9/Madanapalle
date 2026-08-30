const VENUE_ALIASES = [
  { code: "SCM", aliases: ["sai chitra", "saichitra", "sai", "sc"] },
  { code: "ASRM", aliases: ["asr"] },
  { code: "RTDM", aliases: ["ravi", "rv"] },
  { code: "SKMD", aliases: ["sri krishna", "srikrishna", "krishna", "sri", "sk"] }
];

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9₹]+/g, " ")
    .trim()
    .toLocaleLowerCase("en-IN");
}

function mentionedVenueCodes(question) {
  const text = ` ${normalize(question)} `;
  return VENUE_ALIASES
    .filter((venue) => venue.aliases.some((alias) => text.includes(` ${alias} `)))
    .map((venue) => venue.code);
}

function mentionsKnownMovie(question, catalog) {
  const text = ` ${normalize(question)} `;
  return (catalog.movies || []).some((movie) => {
    const title = normalize(movie.title);
    const shortTitle = normalize(String(movie.title).split(":")[0]);
    return text.includes(` ${title} `) || (shortTitle.length >= 5 && text.includes(` ${shortTitle} `));
  });
}

function extractShowCount(question) {
  const text = String(question);
  const match = text.match(/\b(\d{1,3})\s*(?:full\s*)?shows?\b/i);
  if (match) return Number(match[1]);
  const multiplier = text.match(/(?:\bx\s*(\d{1,3})\b|\b(\d{1,3})\s*x\b)/i);
  return multiplier ? Number(multiplier[1] || multiplier[2]) : null;
}

function extractPrices(question) {
  const prices = [];
  const text = String(question);
  for (const match of text.matchAll(/(?:₹\s*)?\b(\d+(?:\.\d{1,2})?)/g)) {
    const before = text.slice(0, match.index || 0);
    const after = text.slice((match.index || 0) + match[0].length);
    if (/x\s*$/i.test(before) || /^\s*x\b/i.test(after)) continue;
    if (/^\s*(?:full\s*)?shows?\b/i.test(after)) continue;
    if (/^\s*(?:st|nd|rd|th)?\s*days?\b/i.test(after)) continue;
    const value = Number(match[1]);
    if (value >= 2000 && value <= 2100) continue;
    prices.push(value);
  }
  return prices.sort((left, right) => right - left);
}

function capacityIntent(question, catalog, context) {
  const text = normalize(question);
  const explicit = /\bfull show gross\b|\bshow full gross\b|\bfull gross\b|\bfull capacity\b|\beach show\b.*\bgross\b|\btheatre\b.*\bfull\b.*\bgross\b/.test(text);
  const prices = extractPrices(question);
  const venues = mentionedVenueCodes(question);
  const mentionsAll = /\ball(?: theatres?)?\b/.test(text);
  const hasCurrencyMarker = /₹|\b(?:rs|rupees?)\b/i.test(String(question));
  const looksLikePricePair = prices.length >= 2 && prices.every((price) => price >= 50 && price <= 1000);
  const priceShorthand = prices.length > 0
    && venues.length > 0
    && (/\b(with|at|calculate|price|prices)\b/.test(text) || hasCurrencyMarker || looksLikePricePair);
  const allPriceShorthand = mentionsAll && looksLikePricePair && /\b(full|gross|calculate)\b/.test(text);
  if (explicit || priceShorthand || allPriceShorthand) return true;
  if (!context || mentionsKnownMovie(question, catalog)) return false;
  return /\b(gross|how much|shows?|prices?|each theatre|all theatres?)\b/.test(text)
    || /(?:\bx\s*\d+\b|\b\d+\s*x\b)/.test(text);
}

export function parseFullGrossQuestion(question, catalog, context = null) {
  if (!capacityIntent(question, catalog, context)) return null;
  const text = normalize(question);
  const profiles = catalog.capacityProfiles || [];
  if (!profiles.length) return { reply: "The theatre capacity profiles are not available yet." };

  const explicitVenues = mentionedVenueCodes(question);
  const explicitlyAll = /\b(?:all(?: theatres?)?|every theatre)\b/.test(text);
  const genericAll = !context && explicitVenues.length === 0 && /\b(theatre|each theatre)\b/.test(text);
  const venueCodes = explicitlyAll || genericAll
    ? profiles.map((profile) => profile.venueCode)
    : explicitVenues.length
      ? explicitVenues
      : context?.venueCodes || profiles.map((profile) => profile.venueCode);

  const enteredPrices = extractPrices(question);
  const prices = enteredPrices.length ? enteredPrices : context?.prices || null;
  if (prices?.some((price) => price <= 5 || price > 5000)) {
    return { reply: "Enter realistic ticket prices above ₹5. I subtract ₹5 from every entered price before calculating." };
  }

  const enteredShowCount = extractShowCount(question);
  const eachShow = /\b(each|one) (?:full )?show\b/.test(text);
  const showCount = eachShow ? 1 : enteredShowCount || context?.showCount || 1;
  if (showCount > 1000) return { reply: "Please use 1,000 shows or fewer in one calculation." };

  return {
    request: {
      mode: "full_gross",
      venueCodes,
      prices,
      showCount
    }
  };
}

const amount = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});
const whole = new Intl.NumberFormat("en-IN");

function calculateTheatre(profile, customPrices, showCount) {
  const prices = customPrices || profile.tiers.map((tier) => tier.listPricePaise / 100);
  let tiers;
  if (prices.length === 1) {
    tiers = [{
      classes: ["ALL SEATS"],
      capacity: profile.capacity,
      enteredPrice: prices[0]
    }];
  } else if (prices.length === profile.tiers.length) {
    tiers = profile.tiers.map((tier, index) => ({ ...tier, enteredPrice: prices[index] }));
  } else {
    return {
      error: `${profile.theatreName} has ${profile.tiers.length} price tiers. Enter either one flat price or ${profile.tiers.length} prices from highest to lowest.`
    };
  }

  const calculatedTiers = tiers.map((tier) => {
    const adjustedPrice = tier.enteredPrice - 5;
    return {
      ...tier,
      adjustedPrice,
      gross: tier.capacity * adjustedPrice
    };
  });
  const oneShowGross = calculatedTiers.reduce((total, tier) => total + tier.gross, 0);
  return {
    profile,
    prices,
    tiers: calculatedTiers,
    oneShowGross,
    allShowsGross: oneShowGross * showCount
  };
}

export function formatFullGrossAnswer(request, catalog) {
  const selectedProfiles = request.venueCodes
    .map((code) => (catalog.capacityProfiles || []).find((profile) => profile.venueCode === code))
    .filter(Boolean);
  if (!selectedProfiles.length) return "I couldn’t find a capacity profile for that theatre.";

  const calculations = selectedProfiles.map((profile) => calculateTheatre(profile, request.prices, request.showCount));
  const error = calculations.find((calculation) => calculation.error)?.error;
  if (error) return error;

  const lines = ["Full-capacity gross estimate"];
  if (request.prices) {
    lines.push(
      `Entered prices: ${request.prices.map((price) => amount.format(price)).join(" and ")}`,
      `After ₹5 MC adjustment: ${request.prices.map((price) => amount.format(price - 5)).join(" and ")}`
    );
    if (request.prices.length > 1) lines.push("Prices are matched from the highest seat tier to the lowest.");
  } else {
    lines.push("Using the latest listed ticket prices recorded for each theatre, with ₹5 removed per ticket.");
  }

  for (const calculation of calculations) {
    lines.push("", `${calculation.profile.theatreName} · ${whole.format(calculation.profile.capacity)} seats`);
    if (!request.prices) lines.push(`Listed prices: ${calculation.prices.map((price) => amount.format(price)).join(" and ")}`);
    for (const tier of calculation.tiers) {
      lines.push(`${tier.classes.join(" + ")} — ${whole.format(tier.capacity)} × ${amount.format(tier.adjustedPrice)} = ${amount.format(tier.gross)}`);
    }
    lines.push(`One full show: ${amount.format(calculation.oneShowGross)}`);
    if (request.showCount > 1) {
      lines.push(`${whole.format(request.showCount)} full shows: ${amount.format(calculation.allShowsGross)}`);
    }
  }

  if (calculations.length > 1) {
    const oneShowTotal = calculations.reduce((total, calculation) => total + calculation.oneShowGross, 0);
    lines.push("", `Combined one-show total: ${amount.format(oneShowTotal)}`);
    if (request.showCount > 1) {
      lines.push(`Combined ${whole.format(request.showCount)}-shows-each total: ${amount.format(oneShowTotal * request.showCount)}`);
    }
  }

  return lines.join("\n");
}
