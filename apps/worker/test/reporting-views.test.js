import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sqliteAvailable = spawnSync("sqlite3", ["--version"], { encoding: "utf8" }).status === 0;
const testIfSqlite = sqliteAvailable ? test : test.skip;
const workerDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sqlite(databasePath, sql, args = []) {
  return execFileSync("sqlite3", [...args, databasePath], {
    input: sql,
    encoding: "utf8"
  });
}

testIfSqlite("reporting migration exposes readable results and uses the application snapshot rule", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "collection-reporting-"));
  const databasePath = path.join(directory, "reporting.sqlite");

  try {
    const migrationDirectory = path.join(workerDirectory, "migrations");
    const migrations = readdirSync(migrationDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(path.join(migrationDirectory, name), "utf8"))
      .join("\n");
    sqlite(databasePath, migrations);

    sqlite(databasePath, `
      INSERT INTO shows (
        id, natural_key, slot_key, venue_code, venue_name, show_date, show_date_code,
        show_time_code, show_time_label, start_at, cutoff_at, capture_at, session_id,
        event_code, movie_title, movie_variant, language, format, seat_layout_url,
        is_current, status, first_seen_at, last_seen_at, capture_attempts, created_at, updated_at
      ) VALUES (
        1, 'show-1', 'slot-1', 'MSDR', 'Siddartha Cinemas:Screen 2 Dolby Laser,Madanapalle', '2026-10-18', '20261018',
        '1100', '11:00 AM', '2026-10-18T05:30:00.000Z', '2026-10-18T05:50:00.000Z',
        '2026-10-18T05:45:00.000Z', 'session-1', 'ET1', 'Example Movie', 'Example Movie',
        'Telugu', '2D', 'https://example.com', 1, 'completed',
        '2026-10-17T12:00:00.000Z', '2026-10-18T05:50:00.000Z', 2,
        '2026-10-17T12:00:00.000Z', '2026-10-18T05:50:00.000Z'
      );

      INSERT INTO snapshots (
        id, show_id, captured_at, received_at, capture_minute, source, capacity,
        available, sold, unknown, collection_paise, occupancy_percent,
        categories_json, is_final, created_at
      ) VALUES
      (
        1, 1, '2026-10-18T05:45:00.000Z', '2026-10-18T05:45:01.000Z', 'initial',
        'local-chrome-extension', 100, 60, 40, 0, 400000, 40,
        '[{"name":"Reserved","listPricePaise":10500,"netPricePaise":10000,"capacity":100,"available":60,"sold":40,"unknown":0,"collectionPaise":400000}]',
        0, '2026-10-18T05:45:01.000Z'
      ),
      (
        2, 1, '2026-10-18T05:49:15.000Z', '2026-10-18T05:49:16.000Z', 'final',
        'local-chrome-extension', 100, 45, 55, 0, 550000, 55,
        '[{"name":"Reserved","listPricePaise":10500,"netPricePaise":10000,"capacity":100,"available":45,"sold":55,"unknown":0,"collectionPaise":550000}]',
        1, '2026-10-18T05:49:16.000Z'
      ),
      (
        3, 1, '2026-10-18T05:49:30.000Z', '2026-10-18T05:49:31.000Z', 'estimate',
        'local-chrome-extension-ticketnew-summary-estimate-final', 100, 40, 60, 0, 600000, 60,
        '[{"name":"Reserved","listPricePaise":10500,"netPricePaise":10000,"capacity":100,"available":40,"sold":60,"unknown":0,"collectionPaise":600000}]',
        0, '2026-10-18T05:49:31.000Z'
      );
    `);

    const show = JSON.parse(sqlite(
      databasePath,
      "SELECT json_object('theatre',theatre,'tickets',tickets_sold,'gross',gross_rupees,'type',capture_type) FROM report_show_results;"
    ));
    assert.deepEqual(show, { theatre: "Mini Siddartha", tickets: 55, gross: 5500, type: "Final" });

    const comparison = JSON.parse(sqlite(
      databasePath,
      "SELECT json_object('tickets',ticket_difference,'gross',gross_difference_rupees) FROM report_capture_comparison;"
    ));
    assert.deepEqual(comparison, { tickets: 15, gross: 1500 });

    const breakdown = JSON.parse(sqlite(
      databasePath,
      "SELECT json_object('class',ticket_class,'listed',listed_price_rupees,'adjusted',adjusted_price_rupees) FROM report_price_breakdown;"
    ));
    assert.deepEqual(breakdown, { class: "Reserved", listed: 105, adjusted: 100 });

    const indexNames = sqlite(
      databasePath,
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%report%' ORDER BY name;"
    );
    assert.match(indexNames, /shows_completed_report_idx/);
    assert.match(indexNames, /shows_movie_report_idx/);
    assert.match(indexNames, /schedule_events_report_idx/);

    // Give SQLite a representative number of rows before checking planner choices.
    // On a one-row fixture, a full scan is correctly cheaper than any index.
    sqlite(databasePath, `
      WITH RECURSIVE sequence(value) AS (
        VALUES(1)
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 2000
      )
      INSERT INTO shows (
        natural_key, slot_key, venue_code, venue_name, show_date, show_date_code,
        show_time_code, show_time_label, start_at, cutoff_at, capture_at, session_id,
        event_code, movie_title, movie_variant, language, format, seat_layout_url,
        is_current, status, first_seen_at, last_seen_at, created_at, updated_at
      )
      SELECT
        'bulk-show-' || value,
        'bulk-slot-' || value,
        CASE value % 4 WHEN 0 THEN 'SKMD' WHEN 1 THEN 'SCM' WHEN 2 THEN 'RTDM' ELSE 'ASRM' END,
        CASE value % 4 WHEN 0 THEN 'Sri Krishna' WHEN 1 THEN 'Sai Chitra' WHEN 2 THEN 'Ravi' ELSE 'ASR' END,
        date('2026-01-01', '+' || (value % 300) || ' days'),
        replace(date('2026-01-01', '+' || (value % 300) || ' days'), '-', ''),
        printf('%04d', value % 2400),
        '11:00 AM',
        date('2026-01-01', '+' || (value % 300) || ' days') || 'T05:30:00.000Z',
        date('2026-01-01', '+' || (value % 300) || ' days') || 'T05:50:00.000Z',
        date('2026-01-01', '+' || (value % 300) || ' days') || 'T05:45:00.000Z',
        'bulk-session-' || value,
        'ET' || value,
        CASE WHEN value % 20=0 THEN 'Example Movie' ELSE 'Other Movie ' || (value % 20) END,
        CASE WHEN value % 20=0 THEN 'Example Movie' ELSE 'Other Movie ' || (value % 20) END,
        'Telugu', '2D', 'https://example.com/' || value,
        1, 'completed',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      FROM sequence;

      WITH RECURSIVE sequence(value) AS (
        VALUES(1)
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 1000
      )
      INSERT INTO schedule_events (
        venue_code, show_date, event_type, details_json, observed_at
      )
      SELECT
        CASE value % 4 WHEN 0 THEN 'SKMD' WHEN 1 THEN 'SCM' WHEN 2 THEN 'RTDM' ELSE 'ASRM' END,
        date('2026-01-01', '+' || (value % 300) || ' days'),
        CASE value % 3 WHEN 0 THEN 'added' WHEN 1 THEN 'removed' ELSE 'replaced' END,
        '{}',
        date('2026-01-01', '+' || (value % 300) || ' days') || 'T12:00:00.000Z'
      FROM sequence;
    `);
    sqlite(databasePath, "ANALYZE;");

    const completedPlan = sqlite(
      databasePath,
      `EXPLAIN QUERY PLAN
       SELECT * FROM shows
       WHERE is_current=1 AND status='completed'
         AND show_date BETWEEN '2026-10-17' AND '2026-10-18'
       ORDER BY show_date, venue_code, start_at;`
    );
    assert.match(completedPlan, /shows_completed_report_idx/);

    const moviePlan = sqlite(
      databasePath,
      `EXPLAIN QUERY PLAN
       SELECT * FROM shows
       WHERE is_current=1 AND movie_title='Example Movie'
       ORDER BY show_date, venue_code, start_at;`
    );
    assert.match(moviePlan, /shows_movie_report_idx/);

    const schedulePlan = sqlite(
      databasePath,
      `EXPLAIN QUERY PLAN
       SELECT * FROM schedule_events
       WHERE show_date='2026-10-18' AND event_type IN ('removed', 'replaced')
       ORDER BY observed_at DESC;`
    );
    assert.match(schedulePlan, /schedule_events_report_idx/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testIfSqlite("Mini Siddartha notification migration upgrades only the former all-theatre choice", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "collection-notifications-"));
  const databasePath = path.join(directory, "notifications.sqlite");

  try {
    const migrationDirectory = path.join(workerDirectory, "migrations");
    const migrationNames = readdirSync(migrationDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const beforeMiniMigration = migrationNames
      .filter((name) => name < "0017_mini_siddartha_everywhere.sql")
      .map((name) => readFileSync(path.join(migrationDirectory, name), "utf8"))
      .join("\n");
    sqlite(databasePath, beforeMiniMigration);

    sqlite(databasePath, `
      INSERT INTO push_subscriptions (
        endpoint, p256dh, auth, device_name, venues_json, types_json, enabled,
        created_at, updated_at, installation_id
      ) VALUES
        ('https://example.com/all', 'key', 'auth', 'Old all',
         '["SKMD","SCM","RTDM","ASRM"]', '["daily_summary"]', 1,
         '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'all-device'),
        ('https://example.com/subset', 'key', 'auth', 'Custom subset',
         '["SKMD","RTDM"]', '["daily_summary"]', 1,
         '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'subset-device');
    `);

    sqlite(databasePath, readFileSync(
      path.join(migrationDirectory, "0017_mini_siddartha_everywhere.sql"),
      "utf8"
    ));

    const migratedAll = JSON.parse(sqlite(
      databasePath,
      "SELECT venues_json FROM push_subscriptions WHERE installation_id='all-device';"
    ));
    const preservedSubset = JSON.parse(sqlite(
      databasePath,
      "SELECT venues_json FROM push_subscriptions WHERE installation_id='subset-device';"
    ));
    assert.deepEqual(migratedAll, ["SKMD", "SCM", "RTDM", "ASRM", "MSDR"]);
    assert.deepEqual(preservedSubset, ["SKMD", "RTDM"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
