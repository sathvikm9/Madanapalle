export const VENUES = Object.freeze([
  Object.freeze({
    venueCode: "SKMD",
    name: "Sri Krishna A/C 4K Dolby Atmos: Madanapalle",
    shortName: "Sri Krishna",
    slug: "sri-krishna-a-c-4k-dolby-atmos-madanapalle",
    platform: "bookmyshow",
    timezone: "Asia/Kolkata",
    captureStartAfterShowMinutes: 10
  }),
  Object.freeze({
    venueCode: "SCM",
    name: "Sai Chitra Theatre A/C 4K Laser Dolby Surround 7.1: Madanapalle",
    shortName: "Sai Chitra",
    slug: "sai-chitra-theatre-a-c-4k-dolby-surround-7-1-madanapalle-c",
    platform: "ticketnew",
    cinemaId: 4903,
    timezone: "Asia/Kolkata",
    captureStartAfterShowMinutes: 10
  }),
  Object.freeze({
    venueCode: "RTDM",
    name: "Ravi A/C 4K Laser Dolby Surround 7.1: Madanapalle",
    shortName: "Ravi",
    slug: "ravi-a-c-4k-laser-dolby-surround-71-madanapalle",
    platform: "bookmyshow",
    timezone: "Asia/Kolkata",
    captureStartAfterShowMinutes: 15
  }),
  Object.freeze({
    venueCode: "ASRM",
    name: "ASR A/C 4K Laser Dolby Surround 7.1: Madanapalle",
    shortName: "ASR",
    slug: "asr-a-c-4k-laser-dolby-surround-71-madanapalle",
    platform: "bookmyshow",
    timezone: "Asia/Kolkata",
    captureStartAfterShowMinutes: 10
  })
]);

export const ALL_VENUES = Object.freeze({
  venueCode: "ALL",
  name: "All theatres",
  shortName: "All theatres",
  timezone: "Asia/Kolkata"
});

export function venueForCode(venueCode) {
  return VENUES.find((venue) => venue.venueCode === venueCode) || null;
}

export function dashboardVenueForCode(venueCode) {
  return venueCode === ALL_VENUES.venueCode ? ALL_VENUES : venueForCode(venueCode);
}

export function publicVenues() {
  return [ALL_VENUES, ...VENUES].map(({ venueCode: code, name, shortName }) => ({ code, name, shortName }));
}
