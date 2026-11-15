# Cache Eviction Policy Study: LRU, LFU, and ARC on Synthetic Workloads

## Abstract

This report describes an internal study carried out by the storage performance group on the Tessera object cache. We compared three eviction policies - least recently used (LRU), least frequently used (LFU), and adaptive replacement cache (ARC) - on synthetic traces, not on production traffic. Across three workloads and three cache sizes, ARC gave the highest or near-highest hit ratio in every configuration, with a mean hit ratio of 71.6 percent at the 4 GB cache size against 65.3 percent for both LRU and LFU. LFU won narrowly on a stable skewed workload but collapsed when the popular keys changed over time. We recommend ARC as the default policy and describe the cost of that choice in memory and processor time.

## Background

Tessera sits in front of a slow blob store and keeps recently fetched objects in memory. When the cache is full, an eviction policy decides which object to discard. LRU discards the object that has gone longest without being read. LFU discards the object with the fewest reads overall. ARC keeps two lists, one for objects seen once recently and one for objects seen at least twice, and continuously shifts the balance between them based on which list would have avoided recent misses.

## Method

All traces were produced by a generator written for this study, using a key universe of 4 million keys and a fixed object size of 4 KB. Each trace contains 12 million requests. The first 2 million requests of every run were treated as warm-up and excluded from the measurements, leaving 10 million measured requests per run.

We used three workloads:

- zipf-steady: keys drawn from a Zipf distribution with exponent 0.9, unchanged for the whole trace.
- scan-heavy: the same Zipf traffic, but 15 percent of requests belong to sequential scans that touch each key once.
- shifting-hotset: Zipf traffic in which the ranking of popular keys is reshuffled every 200,000 requests.

Each workload was replayed against cache sizes of 1 GB, 4 GB, and 8 GB, which correspond to 262,144, 1,048,576, and 2,097,152 cached objects. Every configuration was repeated 5 times with different random seeds, and the standard deviation of the hit ratio stayed below 0.4 percentage points in all cases, so only means are reported. Latency was simulated rather than measured on real hardware: a hit was charged 0.2 ms and a miss was charged 9 ms, the median fetch time we observe from the blob store.

The policy under test is selected with the setting `tessera_evict_policy`, which accepts the values lru, lfu, and arc. The LFU implementation uses plain counters without aging, which matters for the discussion below.

## Results

The table shows hit ratios in percent at the 4 GB cache size.

| Workload | LRU | LFU | ARC |
| --- | --- | --- | --- |
| zipf-steady | 71.4 | 76.8 | 75.9 |
| scan-heavy | 58.2 | 69.5 | 70.1 |
| shifting-hotset | 66.3 | 49.7 | 68.8 |

On zipf-steady, LFU was the best policy by 0.9 percentage points over ARC, and LRU trailed LFU by 5.4 points. On scan-heavy, LRU lost 13.2 points compared with its own zipf-steady result, because each scan flushed a large share of the popular objects; ARC and LFU were far less affected. On shifting-hotset, LFU fell to 49.7 percent, the worst figure in the whole study, while ARC stayed slightly ahead of LRU.

Cache size changed the gaps but not the ordering between LRU and ARC. On zipf-steady at 1 GB, LRU reached 52.6 percent and ARC 58.9 percent, a difference of 6.3 points. At 8 GB the same pair reached 83.0 and 84.2 percent, a difference of only 1.2 points. Bigger caches forgive a weaker policy.

Under the simulated cost model, mean request latency follows directly from the hit ratio. On shifting-hotset at 4 GB, mean latency was 2.95 ms with ARC, 3.17 ms with LRU, and 4.63 ms with LFU. On zipf-steady, LRU averaged 2.72 ms.

The policies also differ in overhead. Per cached entry, our implementations need 16 bytes of bookkeeping for LRU, 24 bytes for LFU, and 32 bytes for ARC, and ARC additionally remembers the keys of recently evicted objects in its ghost lists. Single-core throughput of the cache itself, with no backend involved, was 1.52 million operations per second for LRU, 1.31 million for ARC, and 1.18 million for LFU, whose heap of counters is the slowest structure to maintain.

## Discussion

The LFU collapse on shifting-hotset has a simple explanation. Objects that were popular early in the trace accumulated high read counts and could not be displaced by newly popular objects, so the cache filled with stale favorites. An LFU variant that halves its counters periodically would likely recover much of the loss, but we did not test one.

ARC behaved as its design suggests. Scan traffic entered only the seen-once list and was evicted from there without disturbing objects that had proven their worth, which is why ARC lost just 5.8 points between zipf-steady and scan-heavy. When the hot set moved, the ghost lists detected the misses and shifted capacity back toward recency.

The price of ARC is modest. At the 4 GB size, the extra 16 bytes per entry relative to LRU amount to roughly 16.8 MB, well under half a percent of the cache. The throughput reduction of about 14 percent is irrelevant in practice because a single miss costs as much as thousands of in-memory operations.

We therefore propose changing the default policy from LRU to ARC in Tessera release 3.6, keeping LRU available for deployments that are extremely short on memory.

## Limitations

These results come from synthetic traces and should not be read as predictions for any particular production system. Real traffic has variable object sizes, time-of-day patterns, and correlated reads that our generator does not model. All objects were 4 KB, so the study says nothing about size-aware eviction.

Latency figures are derived from a two-value cost model and ignore queueing, lock contention, and tail effects in the blob store. Only one implementation of each policy was tested, and a tuned LFU with aging or a different adaptive policy might change the ranking. Before the default is switched, we plan to replay a week of anonymized request logs from two internal tenants as a follow-up check.
