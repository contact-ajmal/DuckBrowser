---
title: SQL cookbook
description: Reusable DuckDB patterns for profiling, reshaping and exporting local data.
order: 20
---

# SQL cookbook

Short, forkable recipes. Each one runs against the bundled datasets; hit **Edit / Fork SQL** on any of them to open it on the Query page and point it at your own file.

## Profiling

`SUMMARIZE` is the fastest way to understand a table you have never seen:

```sql {title="Profile the active dataset" autorun=false}
SUMMARIZE SELECT * FROM dataset;
```

Null density per column, without knowing the column names in advance:

```sql {title="Null share per column" chart=bar x=column_name y=null_pct}
SELECT column_name,
       ROUND(100.0 * (count - (count * (100 - null_percentage) / 100)) / count, 2) AS null_pct
FROM (SUMMARIZE SELECT * FROM orders)
ORDER BY null_pct DESC, column_name;
```

## Time series

Bucket timestamps with `date_trunc` (or `time_bucket` for arbitrary widths) and fill gaps with `generate_series`:

```sql {title="Weekly order lines — gaps filled with zero" chart=line x=week y=lines}
WITH weeks AS (
  SELECT unnest(generate_series(DATE '2024-01-01', DATE '2024-12-23', INTERVAL 7 DAY))::DATE AS week
),
actual AS (
  SELECT date_trunc('week', placed_at)::DATE AS week, COUNT(*) AS lines
  FROM orders
  WHERE placed_at >= '2024-01-01'
  GROUP BY 1
)
SELECT strftime(w.week, '%Y-%m-%d') AS week, COALESCE(a.lines, 0) AS lines
FROM weeks w
LEFT JOIN actual a USING (week)
ORDER BY w.week;
```

## Window functions

Running totals and ranks are one clause away:

```sql {title="Cumulative net revenue by month (2024)" chart=line x=month y=cumulative}
WITH monthly AS (
  SELECT date_trunc('month', placed_at) AS month_start, SUM(net_amount) AS monthly
  FROM orders
  WHERE placed_at >= '2024-01-01'
  GROUP BY 1
)
SELECT strftime(month_start, '%Y-%m')                         AS month,
       ROUND(monthly)                                         AS monthly,
       ROUND(SUM(monthly) OVER (ORDER BY month_start))        AS cumulative
FROM monthly
ORDER BY month_start;
```

```sql {title="Top 3 SKUs per category by margin"}
SELECT category, sku, margin, rnk
FROM (
  SELECT category, sku,
         ROUND(SUM(margin)) AS margin,
         RANK() OVER (PARTITION BY category ORDER BY SUM(margin) DESC) AS rnk
  FROM orders
  GROUP BY category, sku
)
WHERE rnk <= 3
ORDER BY category, rnk;
```

## Pivoting

DuckDB has a native `PIVOT`:

```sql {title="Payment method × region (order lines)"}
PIVOT (SELECT region_code, payment_method FROM orders)
ON payment_method
USING COUNT(*)
GROUP BY region_code
ORDER BY region_code;
```

## Reading files with options

The auto-detectors are good, but you can always be explicit. These read the *raw files* rather than the mounted views:

```sql {title="CSV with explicit types" autorun=false}
-- `types` overrides the sniffer for just the columns you name.
SELECT order_id, order_date, revenue, typeof(revenue) AS revenue_type
FROM read_csv('sales.csv',
              header = true,
              types = {'order_date': 'DATE', 'revenue': 'DECIMAL(10,2)'},
              ignore_errors = true)
LIMIT 5;
```

```sql {title="Parquet metadata — row groups and compression" autorun=false}
SELECT row_group_id, row_group_num_rows, path_in_schema, type, compression, total_compressed_size
FROM parquet_metadata('orders.parquet')
LIMIT 20;
```

```sql {title="JSON with a fixed schema" autorun=false}
SELECT event_type, props.plan AS plan, duration_ms
FROM read_json('events.ndjson',
               format = 'newline_delimited',
               columns = {'event_type': 'VARCHAR', 'duration_ms': 'INTEGER', 'props': 'STRUCT(plan VARCHAR)'})
LIMIT 5;
```

## Sampling large files

When the safety badge turns yellow or red, sample first:

```sql {title="1% Bernoulli sample" autorun=false}
SELECT * FROM dataset USING SAMPLE 1 PERCENT (bernoulli);
```

## Exporting

The **CSV** / **Parquet** buttons on every card — and the CSV / Parquet / JSON downloads on the Query page — run `COPY (…) TO` inside DuckDB and download the bytes, so they always contain the full result. The same works by hand:

```sql {static=true}
COPY (SELECT * FROM orders WHERE region_code = 'EU') TO 'eu_orders.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
```
