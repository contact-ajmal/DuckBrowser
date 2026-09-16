---
title: Authoring pages
description: Write Markdown with live SQL cards and ship it as documentation.
order: 10
---

# Authoring pages

Every `content/*.md` file becomes a page under **Docs**. Standard GitHub-flavoured Markdown works; the special ingredient is that a ```` ```sql ```` fence becomes a **live card** that runs against the mounted datasets when the page is opened.

## Front matter

```yaml {static=true}
---
title: Sales review          # sidebar label
description: One-liner used for the page's <meta name="description">
order: 20                    # sort key in the sidebar (index.md defaults to 0)
---
```

## Live SQL cards

Options go in the fence's info string:

````markdown {static=true}
```sql {title="Revenue by region" chart=bar x=region y=revenue}
SELECT region, SUM(revenue) AS revenue FROM sales GROUP BY 1 ORDER BY 2 DESC;
```
````

| Option    | Values                       | Effect                                                    |
| --------- | ---------------------------- | --------------------------------------------------------- |
| `title`   | text                         | Card heading                                              |
| `chart`   | `bar` `line` `auto` `none`   | Draw a chart above the result table (`auto` picks by shape) |
| `x`, `y`  | column names                 | Chart axes; `y` accepts a comma-separated list             |
| `autorun` | `false`                      | Wait for a manual Run                                     |
| `limit`   | number                       | Rows rendered in the table (default 200)                  |
| `static`  | `true`                       | Render as a plain code block, no execution                |

That fence renders as:

```sql {title="Revenue by region" chart=bar x=region y=revenue}
SELECT region, ROUND(SUM(revenue), 2) AS revenue, COUNT(*) AS orders
FROM sales
GROUP BY region
ORDER BY revenue DESC;
```

### Time series

```sql {title="Monthly revenue trend" chart=line x=month y=revenue}
SELECT strftime(date_trunc('month', order_date), '%Y-%m') AS month,
       ROUND(SUM(revenue)) AS revenue
FROM sales
GROUP BY 1
ORDER BY 1;
```

### Joining across formats

Formats are irrelevant once mounted. Here Parquet order lines join the TSV region lookup, charting two series with comparable scale:

```sql {title="Parquet ⋈ TSV — net revenue vs. regional target" chart=bar x=region_name y="net_revenue,target_revenue"}
SELECT r.region_name,
       ROUND(SUM(o.net_amount))           AS net_revenue,
       r.target_revenue,
       ROUND(100.0 * SUM(o.net_amount) / r.target_revenue, 1) AS pct_of_target
FROM orders o
JOIN regions r ON r.code = o.region_code
GROUP BY r.region_name, r.target_revenue
ORDER BY net_revenue DESC;
```

### Semi-structured JSON

`read_json_auto` infers a `STRUCT` for the nested `props` object, so nested fields are ordinary columns:

```sql {title="Conversion funnel by plan (nested JSON)"}
SELECT props.plan                                          AS plan,
       COUNT(*) FILTER (WHERE event_type = 'page_view')   AS page_views,
       COUNT(*) FILTER (WHERE event_type = 'add_to_cart') AS add_to_cart,
       COUNT(*) FILTER (WHERE event_type = 'purchase')    AS purchases,
       ROUND(100.0 * COUNT(*) FILTER (WHERE event_type = 'purchase')
                   / COUNT(*) FILTER (WHERE event_type = 'page_view'), 2) AS purchase_rate_pct
FROM events
GROUP BY 1
ORDER BY page_views DESC;
```

### Arrow IPC

```sql {title="Sensor health — average temperature per device" chart=bar x=device_id y=avg_temp_c}
SELECT device_id, site,
       ROUND(AVG(temperature_c), 2) AS avg_temp_c,
       ROUND(MIN(battery_v), 3)     AS min_battery_v,
       COUNT(*) FILTER (WHERE status = 'alert') AS alerts
FROM sensors
GROUP BY device_id, site
ORDER BY device_id;
```

### Following the active dataset

A card that queries the `dataset` alias re-runs whenever the active dataset changes:

```sql {title="Five random rows from whatever is active"}
SELECT * FROM dataset USING SAMPLE 5 ROWS;
```

## Views available to a page

| View       | File             | Format    |
| ---------- | ---------------- | --------- |
| `sales`    | `sales.csv`      | CSV       |
| `orders`   | `orders.parquet` | Parquet   |
| `events`   | `events.ndjson`  | NDJSON    |
| `products` | `products.json`  | JSON      |
| `regions`  | `regions.tsv`    | TSV       |
| `sensors`  | `sensors.arrow`  | Arrow IPC |
| `dataset`  | *(alias)*        | whichever dataset is active |

Samples are not loaded automatically: when a card's query refers to one that isn't mounted, the card shows a **Load sample and re-run** button. Files the reader drops in are also queryable by name — but a page can't rely on them existing, so keep documentation queries on bundled views or the `dataset` alias.

## Build

```bash {static=true}
npm run build   # content/ + data/ → dist/
npm run dev     # serve dist/ locally
```

The build reports every page and how many live cards it contains. Cards are only executed when their page is opened, so a large docs site costs nothing until read.
