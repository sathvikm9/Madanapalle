import assert from "node:assert/strict";
import test from "node:test";

await import("./movie-metadata.js");
const {
  districtMovieUrl,
  movieSlug,
  movieUrl,
  parseReleaseDateText,
  readDistrictPage,
  readPage
} = globalThis.SKCTMovieMetadata;

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

test("builds a District movie URL from its stable MV content code", () => {
  assert.equal(
    districtMovieUrl("Don't Trouble the Trouble", "MV228227"),
    "https://www.district.in/movies/don-t-trouble-the-trouble-movie-tickets-MV228227"
  );
});

test("reads District's raw India release date without converting it to the laptop timezone", () => {
  const nextData = {
    textContent: JSON.stringify({
      props: { pageProps: { data: { movieData: { meta: { movie: {
        content_id: 228227,
        name: "Don't Trouble the Trouble",
        release_date: "2026-10-02"
      } } } } } }
    })
  };
  const document = {
    body: { innerText: "Releasing 1 October 2026" },
    querySelector: (selector) => selector.includes("__NEXT_DATA__") ? nextData : null,
    querySelectorAll: () => []
  };
  assert.deepEqual(readDistrictPage(document, {
    href: "https://www.district.in/movies/don-t-trouble-the-trouble-movie-tickets-MV228227"
  }, {
    eventCode: "MV228227",
    movieTitle: "Don't Trouble the Trouble"
  }), {
    canonicalTitle: "Don't Trouble the Trouble",
    releaseDate: "2026-10-02",
    movieUrl: "https://www.district.in/movies/don-t-trouble-the-trouble-movie-tickets-MV228227",
    eventCode: "MV228227"
  });
});

test("rejects a District movie page whose content ID does not match the discovered show", () => {
  const nextData = {
    textContent: JSON.stringify({
      props: { pageProps: { data: { movieData: { meta: { movie: {
        content_id: 999999,
        name: "Don't Trouble the Trouble",
        release_date: "2026-10-02"
      } } } } } }
    })
  };
  assert.throws(() => readDistrictPage({
    querySelector: () => nextData,
    querySelectorAll: () => []
  }, {
    href: "https://www.district.in/movies/don-t-trouble-the-trouble-movie-tickets-MV228227"
  }, {
    eventCode: "MV228227",
    movieTitle: "Don't Trouble the Trouble"
  }), /content ID did not match/);
});
