# Postmortem: Quillfeather Checkout Outage Caused by Database Pool Exhaustion

## Summary

On Tuesday the Quillfeather payment gateway rejected a large share of checkout requests for 47 minutes, from 14:12 to 14:59 UTC. At the worst point, 38 percent of checkout attempts failed with HTTP 503. No payments were charged twice and no data was lost, but an estimated 6,400 shoppers saw an error page and had to try again. The cause was a configuration change shipped in release 4.17.2 that reduced the size of the database connection pool to a tenth of its intended value. This document follows our blameless format: it describes what the system and the process allowed to happen, not who made a mistake. Quillfeather is an internal service name, and all times are in UTC.

## Impact

The gateway normally handles about 900 checkout requests per second in the early afternoon. During the incident, requests that could not obtain a database connection waited in a queue and then failed. Median response time for successful requests rose from 180 ms to 4.2 seconds. The support desk received 212 tickets in the hour after the outage began, compared with a usual figure of about 15. Merchants who use the hosted payment page were affected equally in all regions, because the faulty value was applied to every gateway instance.

## Timeline

- 13:40 - Release 4.17.2 is approved. It contains a cleanup of the gateway configuration file in which several keys were renamed.
- 13:58 - Rollout starts. Instances are replaced in batches of 20 percent.
- 14:12 - The last batch finishes. Traffic climbs toward the afternoon peak, and the first requests begin to fail with the internal error PG-POOL-TIMEOUT.
- 14:19 - The dashboard for database connections shows every instance pinned at 8 open connections. Nobody is looking at it.
- 14:31 - A support agent escalates a cluster of merchant complaints to the on-call engineer. This is the first time an engineer learns of the problem, 19 minutes after it began.
- 14:36 - The on-call engineer declares an incident and suspects the database, because query latency looks high from the gateway side.
- 14:44 - The database administrator confirms the database is healthy and nearly idle. Attention shifts to the gateway.
- 14:49 - A second engineer compares the running configuration with the previous release and spots the pool size.
- 14:52 - Rollback to release 4.17.1 begins.
- 14:59 - All instances run the old release. Error rate returns to normal and the incident is closed.

## Root Cause

The gateway reads its pool size from the key `pool_max_connections`. Before the release the value was 80. During the configuration cleanup, the value was retyped by hand in a new file and became 8. With 8 connections per instance and an average query time of 11 ms, one instance can serve roughly 700 queries per second, far less than the 2,500 it needs at peak, since each checkout issues several queries.

Requests that could not get a connection waited for the period set by `pool_acquire_timeout_ms`, which is 3000, and then failed. The waiting requests held worker threads, which is why even requests that did get a connection became slow. The gateway converted each pool timeout into an HTTP 503 response for the shopper.

The change passed code review because the diff showed the whole file as deleted and re-added, so the altered number did not stand out among 140 other lines.

## Contributing Factors

Several conditions turned a one-character typing slip into a customer-facing outage.

- The staging environment receives about 2 percent of production load, so a pool of 8 connections was never exhausted there and all pre-release checks passed.
- The rollout finished at 14:12, before the daily peak. The first batches looked healthy only because traffic was still low when they were observed.
- Configuration values have no schema or range validation. The gateway accepts any positive integer for the pool size.
- The rollout tool waits 3 minutes between batches, which is too short for a capacity problem to show up at low traffic.
- The first responder followed the symptom toward the database, which cost 8 minutes, because the gateway reports pool wait time as part of query latency.

## Detection Gap

Our paging alert for the gateway fires only when the share of 5xx responses stays above 50 percent for 10 minutes. The failure rate peaked at 38 percent, so the alert never fired, and the incident was detected by people instead of by monitoring. A warning-level alert at 5 percent did fire at 14:16, but warnings go to a chat channel that nobody is required to watch.

There was also no alert on pool saturation. The metric for connections in use existed and was graphed, but it had no threshold. Had we paged on pool usage above 90 percent for 2 minutes, the on-call engineer would have been notified by about 14:15 with a message pointing directly at the cause.

## What Went Well

Once the wrong value was found, recovery was quick: the rollback took 7 minutes from start to finish. The idempotency checks in the payment flow worked as designed, so shoppers who retried were not charged twice. The support desk escalated quickly and with useful detail.

## Action Items

| Item | Owner | Due |
| --- | --- | --- |
| Lower the paging threshold for gateway 5xx responses to 5 percent over 3 minutes | On-call lead | 1 week |
| Add a paging alert for connection pool usage above 90 percent | Observability engineer | 1 week |
| Validate configuration against a schema with minimum and maximum values at startup | Gateway team lead | 3 weeks |
| Make the review tool show renamed configuration files as moves, not as delete plus add | Developer tooling owner | 4 weeks |
| Extend the pause between rollout batches to 15 minutes during peak hours | Release manager | 2 weeks |
| Report pool wait time as a separate metric from query latency | Gateway team lead | 3 weeks |
| Run a monthly load test in staging at 100 percent of production peak | Performance engineer | 6 weeks |

The incident review board will check progress on these items at its next two meetings. Any item that slips past its due date must be re-justified there by its owner.
