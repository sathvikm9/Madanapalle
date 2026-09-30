import assert from "node:assert/strict";
import test from "node:test";

await import("./movie-metadata.js");
const { movieSlug, movieUrl, parseReleaseDateText, readPage } = globalThis.SKCTMovieMetadata;

test("parses BookMyShow release dates into stable ISO dates", () => {
  assert.equal(parseReleaseDateText("UA16+ · 25 Sep, 2026"), "2026-09-25");
  assert.equal(parseReleaseDateText("2h 54m · 24 September 2026"), "2026-09-24");
  assert.equal(parseReleaseDateText("No release date"), null);
});

test("builds the canonical Madanapalle BookMyShow movie URL", () => {
  assert.equal(movieSlug("Avengers Endgame: Encore"), "avengers-endgame-encore");
  assert.equal(
    movieUrl("The Paradise", "ET00436621"),
    "https://in.bookmyshow.com/movies/madanapalle/the-paradise/ET00436621"
  );
});

test("reads the title and release date from the movie hero", () => {
  const hero = { textContent: "The Paradise 2h 54m · 24 Sep, 2026", parentElement: null };
  const document = {
    title: "The Paradise Movie",
    body: { innerText: hero.textContent },
    querySelector: (selector) => selector === "h1" ? { textContent: "The Paradise", parentElement: hero } : null
  };
  assert.deepEqual(readPage(document, { href: "https://in.bookmyshow.com/movies/madanapalle/the-paradise/ET00436621" }), {
    canonicalTitle: "The Paradise",
    releaseDate: "2026-09-24",
    movieUrl: "https://in.bookmyshow.com/movies/madanapalle/the-paradise/ET00436621"
  });
});
