import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailySummaryNotification,
  buildPeriodNotification,
  showPeriod
} from "../src/index.js";

test("show periods follow MPLTalkies naming boundaries", () => {
  assert.equal(showPeriod("07:30 AM").label, "Early Morning");
  assert.equal(showPeriod("09:30 AM").label, "Early Morning");
  assert.equal(showPeriod("10:00 AM").label, "Morning");
  assert.equal(showPeriod("12:00 PM").label, "Morning");
  assert.equal(showPeriod("02:15 PM").label, "Matinee");
  assert.equal(showPeriod("06:00 PM").label, "Evening");
  assert.equal(showPeriod("09:45 PM").label, "Second");
});

test("period notification combines selected theatre results", () => {
  const notification = buildPeriodNotification([
    {
      venueShortName: "Sri Krishna",
      showTime: "11:10 AM",
      movieTitle: "Mandaadi",
      status: "completed",
      snapshot: { sold: 342, collectionPaise: 3412500 }
    },
    {
      venueShortName: "Ravi",
      showTime: "10:45 AM",
      movieTitle: "The Paradise",
      status: "completed",
      snapshot: { sold: 300, collectionPaise: 2995000 }
    }
  ]);

  assert.equal(notification.title, "Morning shows");
  assert.equal(notification.body, "Sri Krishna · 11:10 AM — Mandaadi · ₹34,125\nRavi · 10:45 AM — The Paradise · ₹29,950");
  assert.doesNotMatch(notification.body, /tickets/i);
  assert.doesNotMatch(notification.body, /final/i);
});

test("daily summary groups movies and orders them by gross", () => {
  const notification = buildDailySummaryNotification({
    showDate: "2026-09-27",
    theatreLabel: "All theatres",
    shows: [
      { movieTitle: "The Paradise", status: "completed", snapshot: { collectionPaise: 60000000 } },
      { movieTitle: "The Paradise", status: "completed", snapshot: { collectionPaise: 6904000 } },
      { movieTitle: "Irumudi", status: "completed", snapshot: { collectionPaise: 7262000 } }
    ]
  });

  assert.equal(notification.title, "27th September - All theatres");
  assert.equal(notification.body, "The Paradise - 2 Shows - 6,69,040/-\nIrumudi - 1 Show - 72,620/-");
});
