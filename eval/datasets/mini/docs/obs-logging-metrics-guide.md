# Observability Guide: Logging, Metrics, and Traces for Storefront Services

## Introduction

This guide describes the conventions that every storefront service follows when it emits logs, metrics, and traces. Shared conventions let an engineer who has never seen a service read its dashboards and search its logs without first learning a private vocabulary. The examples use the checkout, cart, and inventory services, but the rules apply to all of them. Where a rule has a number in it, the number is enforced by the collection pipeline and is not a suggestion.

## Structured Logging Fields

Services write one JSON object per line to standard output. Free-form text lines are dropped by the collector. Every log line must contain the following fields.

- `ts`: the event time in RFC 3339 format with millisecond precision, always in UTC.
- `level`: one of the five levels described in the next section.
- `svc`: the service name, in lowercase with hyphens.
- `msg`: a short constant sentence. Variable data belongs in other fields, not in the message text.
- `trace_id` and `span_id`: copied from the active trace context, so that a log line can be joined to its trace.
- `tenant_ref`: the opaque identifier of the merchant on whose behalf the work is done, or the literal string none.

A single log line may not exceed 8 KB after encoding; longer lines are truncated and marked with the field truncated set to true. Personal data such as email addresses, postal addresses, and card numbers must never be logged. Identify a shopper by the internal shopper identifier only.

```
{"ts":"2031-05-02T09:14:07.512Z","level":"warn","svc":"cart-api","msg":"coupon lookup slow","trace_id":"7c1e","span_id":"a9","tenant_ref":"m_4410","elapsed_ms":640}
```

## Log Levels

Five levels are available: debug, info, warn, error, and fatal. Choosing the right one matters because alerts and retention depend on it.

Use debug for detail that is only useful while developing. Debug lines are discarded in production unless the flag `log_debug_tenants` lists the tenant in question, and even then they are kept for only 3 days. Use info for normal business events, such as an order being placed. Use warn when something unusual happened but the request still succeeded, for instance after a retry. Use error when a request failed because of a fault on our side. Use fatal only when the process is about to exit.

A request rejected because the caller sent bad input is not an error from the point of view of the service; log it at info. Info and warn lines are retained for 30 days, and error and fatal lines for 180 days.

## Metric Naming

Metric names are written in lowercase with underscores and have three parts: the owning service or domain, what is measured, and the unit. Base units are mandatory, so durations are in seconds and sizes in bytes, never in milliseconds or megabytes. Counters end in the suffix total.

| Metric | Type | Meaning |
| --- | --- | --- |
| `checkout_request_duration_seconds` | Histogram | Time to serve one checkout request |
| `cart_items_added_total` | Counter | Items added to carts since process start |
| `inventory_sync_lag_seconds` | Gauge | Age of the newest stock update applied |
| `checkout_payment_failures_total` | Counter | Payment attempts that ended in failure |

Do not put the environment, region, or instance into the metric name; those are labels added by the collector. Do not encode a label value into the name either: one counter with a label for the payment method is correct, and a separate counter per payment method is not.

## Histograms Versus Summaries

Latency must be recorded with histograms, not summaries. A summary computes percentiles inside each process, and percentiles from different instances cannot be combined into a meaningful fleet-wide figure. A histogram counts observations in fixed buckets; bucket counts from all instances can be added together, and the percentile is estimated afterwards from the total.

The cost of a histogram is one time series per bucket, so buckets should be chosen with care. The standard latency layout has 11 buckets with upper bounds from 0.005 seconds to 10 seconds, each roughly double the one before. A service whose objective sits between two bucket bounds should add one bound exactly at the objective, because estimates are most accurate at bucket edges.

## Alert Thresholds

Alerts come in two severities. A page wakes the on-call engineer; a ticket is handled during working hours. An alert should page only if a customer is being hurt now and a person can do something about it.

The default paging rules for a request-serving service are these. Page when the 99th percentile of request duration stays above 1.2 seconds for 5 minutes. Page when the ratio of failed requests to all requests stays above 2 percent for 10 minutes. Open a ticket when the inventory sync lag exceeds 300 seconds for 15 minutes, since stale stock counts cause overselling but not an outage.

## Trace Sampling

Recording every trace would cost more than the insight is worth, so traces are sampled. The decision is made in two stages.

At the edge, head sampling keeps 5 percent of requests at random, and the decision travels with the request so that all services agree. In the collector, tail sampling then rescues interesting traces that the random choice would have dropped: any trace that contains an error is kept, and so is any trace whose total duration is above 800 ms. Sampled traces are stored for 7 days.

## Cardinality Limits

Each unique combination of label values creates a separate time series, and the number of series is what drives the cost and speed of the metrics store. A single metric may have at most 12 labels and at most 2,000 active series per service. When a metric goes over the series limit, the collector drops new series for that metric and increments the counter `obs_series_dropped_total`, which has its own ticket alert.

Labels must come from small, fixed sets: a status class, a payment method, a route template. Never use a shopper identifier, an order identifier, a full URL path, or an error message as a label value. If you need to look at one particular order, that is a job for logs and traces, not for metrics. The setting `obs_max_label_values`, which defaults to 150, caps the number of distinct values that any one label may take before the collector replaces further values with the word other.
