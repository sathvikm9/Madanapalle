# Simple SQL guide

The database keeps normalized operational tables for reliable capture and a
read-only `report_*` layer for people. Use the views for reports; do not edit
the views or the underlying tables in Cloudflare Studio.

All dates use `YYYY-MM-DD`. Money columns ending in `_rupees` are already
converted from paise. Times ending in `_ist` are India time.

## Which view should I use?

| View | One row represents | Best for |
| --- | --- | --- |
| `report_show_results` | One current show | Everyday show, ticket and collection checks |
| `report_price_breakdown` | One ticket class in one show | Class-wise price, seats and gross |
| `report_capture_comparison` | One current show | Initial versus final capture differences |
| `report_theatre_daily` | One theatre on one date | Daily theatre totals |
| `report_movie_daily` | One movie on one date | Day-wise movie collection |
| `report_theatre_totals` | One theatre for all stored dates | Theatre rankings |
| `report_movie_totals` | One movie for its full tracked run | Movie rankings and full-run totals |
| `report_schedule_changes` | One added, removed or changed show | Schedule audit |
| `report_movie_releases` | One tracked movie | Release-date verification |
| `report_best_snapshot` | The result selected for one show | Advanced capture auditing |

## Copy-paste queries

Replace only the two ISO dates in these examples.

### Theatre totals between two dates

```sql
SELECT
  theatre,
  SUM(shows_captured) AS shows,
  SUM(tickets_sold) AS tickets,
  ROUND(SUM(gross_rupees), 2) AS gross_rupees
FROM report_theatre_daily
WHERE show_date BETWEEN '2026-08-21' AND '2026-10-18'
GROUP BY theatre_code, theatre
ORDER BY tickets DESC;
```

### Every show on one date

```sql
SELECT
  theatre,
  show_time,
  movie,
  show_status,
  tickets_sold,
  gross_rupees,
  occupancy_percent,
  capture_type
FROM report_show_results
WHERE show_date='2026-10-18'
ORDER BY theatre, show_time;
```

### Full run for one movie

```sql
SELECT *
FROM report_movie_daily
WHERE movie='The Paradise'
ORDER BY show_date;
```

### Movies ranked by gross

```sql
SELECT *
FROM report_movie_totals
ORDER BY gross_rupees DESC;
```

### Initial versus final capture differences

```sql
SELECT
  show_date,
  theatre,
  show_time,
  movie,
  initial_tickets,
  final_tickets,
  ticket_difference,
  initial_gross_rupees,
  final_gross_rupees,
  gross_difference_rupees
FROM report_capture_comparison
WHERE show_date='2026-10-18'
ORDER BY theatre, show_time;
```

### Price breakdown for one show

```sql
SELECT
  ticket_class,
  listed_price_rupees,
  adjusted_price_rupees,
  tickets_sold,
  gross_rupees
FROM report_price_breakdown
WHERE show_date='2026-10-18'
  AND theatre='Sri Krishna'
  AND show_time='11:00 AM'
ORDER BY listed_price_rupees DESC;
```

### Schedule changes

```sql
SELECT
  theatre,
  previous_time,
  previous_movie,
  change_type,
  new_time,
  new_movie,
  observed_at_ist
FROM report_schedule_changes
WHERE show_date='2026-10-18'
ORDER BY observed_at DESC;
```

## Operational tables

The underlying tables remain intentionally normalized:

- `shows`: discovered schedules and current/replaced sessions
- `snapshots`: immutable seat captures; money is stored safely in paise
- `schedule_events`: schedule audit history
- `collector_runs`: collector diagnostics
- `movie_releases`: release-date metadata
- `notification_*`, `push_*`, `pwa_installations`: notification delivery state

These tables are for the application. The `report_*` views are the supported
human-facing SQL interface.
