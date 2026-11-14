# Search evaluation

## Method and limits

Measured on an Intel Core i7-14650HX (24 logical threads), 16 GB RAM, Windows 11,
Python 3.12.13, CPU only. This was an **active, shared developer workstation** running
browser/E2E checks: wall-clock latency, load time and RSS are indicative, not isolated
performance claims. Query timings exclude model loading and include production retrieval;
headline runs do not cache cross-encoder predictions. Sweep/calibration runs cache predictions
and therefore are **not latency benchmarks**.

- **Mini:** 14 committed technical documents, 88,911 input bytes; 58 answerable questions
  (24 paraphrases, 18 exact, 16 natural) and 8 out-of-scope questions. At 256 tokens: 126 chunks.
  A relevant chunk **overlaps** a labelled quote; it need not contain the entire quote.
  Corpus, questions and labels are self-authored together, not an independent test set.
- **External:** [BEIR SciFact](https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip),
  all 5,183 abstracts, 12,684 chunks, first 50 numerically sorted test queries (IDs 1–219).
  This is a deterministic, non-random **subset**, not a full-test-set result. Relevance is
  document-level: the first 20 retrieved chunks are deduplicated into documents before scoring.
- Metrics are macro-averages over answerable queries. MRR is truncated at 10; nDCG@10 is binary.
  Unjudged passages count as nonrelevant. Out-of-scope questions affect latency/refusal counts,
  not ranking averages. No statistical significance or broad generalization is claimed.
- Settings were explored on mini. Calibration selects thresholds using **mini groups only**;
  SciFact and cross-corpus groups are transfer diagnostics, not threshold-selection data.
  There is no held-out mini split; model pretraining/benchmark contamination was not audited.

Raw runs, package versions, commands, per-query IDs/rankings and source SHA256 snapshots live in
[`eval/results`](../eval/results/). `git_commit` is null because measurements used an uncommitted
working tree; `base_git_commit` is ancestry, **not the exact measured source**. The app-facing
[`report.json`](../backend/passageport/evaluation/report.json) validates against `EvalReport`.

## CPU-light retrieval quality

Models: `BAAI/bge-small-en-v1.5` embeddings + `Xenova/ms-marco-MiniLM-L-6-v2`
cross-encoder through FastEmbed/ONNX. No PyTorch in the default environment.

| Corpus | Run | Recall@1 | Recall@5 | Recall@10 | MRR@10 | nDCG@10 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Mini | Keyword | .6293 | .7414 | .7759 | .6783 | .7017 |
| Mini | Vector | .5603 | .7759 | .8621 | .6521 | .7017 |
| Mini | Hybrid | .5948 | .8448 | .8621 | .6977 | .7383 |
| Mini | Hybrid + rerank | .7155 | .8276 | .9138 | .7710 | .8044 |
| SciFact subset | Keyword | .6000 | .7900 | .8340 | .7009 | .7312 |
| SciFact subset | Vector | .7290 | .8510 | .8860 | .8064 | .8188 |
| SciFact subset | Hybrid | .6690 | .8380 | .9130 | .7872 | .8076 |
| SciFact subset | Hybrid + rerank | .6150 | .8630 | .9260 | .7498 | .7913 |

Reranking improves mini's top result and SciFact's recall@10, **but hurts SciFact's top-rank
metrics**. It is not an unconditional quality upgrade. Search/Lab expose the stage scores and
allow reranking to be disabled. Precision@1/@5 and query-kind breakdowns are in the raw JSON.

A fresh production-parser/chunker/embedding build measured 59.2 chunks/s on mini and 45.2 on
SciFact (embedding-only 61.1 and 47.4 chunks/s). These denominators exclude SQL insertion and
in-memory search-index construction; this is not an end-to-end upload SLA. Later headline
reruns reuse those scratch vectors and explicitly mark the cache reuse.

## Settings and confidence

Mini-only sweep (nDCG@10; reranked depth 20):

| Chunk tokens | Chunks | Keyword | Vector | Hybrid | Hybrid + rerank |
| --- | ---: | ---: | ---: | ---: | ---: |
| 128 | 241 | .6092 | .6522 | .7055 | .7747 |
| 256 | 126 | .7017 | .7017 | .7383 | .8044 |
| 512 | 110 | .6969 | .6837 | .7497 | .7948 |

Keep **256 tokens, no overlap, 30 candidates/retriever, rerank top 20, RRF k=60,
equal lexical/vector weights, BM25 k1=1.2/b=.75, plural-only stemming**. RRF k=1 improved
mini nDCG (.7661 versus .7383), but reduced hybrid recall@5 (.7759 versus .8448).
Vector-favoring weights .7:1 improved nDCG to .7462 but reduced recall@5 to .8103.
Keep the conservative equal-weight default rather than overfit one small corpus.

The previous no-rerank cosine threshold .35 accepted all 8 unrelated mini queries. The selected
**cosine >= .70 OR full keyword coverage** retained 81.03% of mini answerable queries,
accepted 1/8 out-of-scope queries and 7/48 source-removed queries. Source-removed evaluation
filters out the answer document; mutually answering API-version questions are excluded.
On external transfer, that rule retained 94% of SciFact queries; cross-corpus acceptance was
0% (SciFact questions against mini) and 1.52% (mini questions against SciFact).

Keep **rerank logit >= 0** for evidence sufficiency. Mini's tuned -6 threshold retained 86.21%
of answerable queries and rejected 8/8 easy out-of-scope queries, but wrongly accepted 27.08%
of source-removed questions: too permissive for evidence-backed answers. Thresholds are
**model-dependent heuristics**, not probabilities or factual guarantees. Eight easy negatives
are much too few to establish a reliable rejection rate. `calibration.json` records every
query signal and each threshold's per-group rates. Ranking tables are independent of the
sufficiency gate; pre-calibration headline runs record .35 in their effective settings.

Compare uses cosine .8 to align evidence passages; this is a conservative heuristic, not a
measured contradiction detector. Computed sentence/value/polarity differences remain separate
from an optional LLM interpretation, whose citations—not factual truth—are checked.

## Reproduce

From `backend/` (bash; no paid services). Model/dataset downloads are cached; offline evaluation
uses those real weights and transfers **zero model bytes**. Model cache footprint is not a
measured network/archive download size. Remove `HF_HUB_OFFLINE=1` for the first download.

```bash
HF_HUB_OFFLINE=1 .venv/Scripts/python.exe -m passageport.evaluation.run evaluate --datasets mini scifact --max-queries 50 --label 'CPU-light defaults' --out ../eval/results/default.json
# Add --rebuild to measure a fresh parse/chunk/embed build instead of reusing vectors.
HF_HUB_OFFLINE=1 .venv/Scripts/python.exe -m passageport.evaluation.run sweep --datasets mini --chunk-sizes 128 256 512 --out ../eval/results/sweep.json
HF_HUB_OFFLINE=1 .venv/Scripts/python.exe -m passageport.evaluation.run calibrate --max-queries 50 --out ../eval/results/calibration.json
uv venv .venv-heavy
uv pip install --python .venv-heavy/Scripts/python.exe -e '.[baseline,dev]' -c ../eval/upstream-constraints.txt
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 .venv-heavy/Scripts/python.exe -m passageport.evaluation.run baseline --upstream-root ../../upstream-baseline/backend --datasets mini --out ../eval/results/upstream-original.json
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 .venv-heavy/Scripts/python.exe -m passageport.evaluation.run evaluate --datasets mini --embedding sentence-transformers:Alibaba-NLP/gte-multilingual-base --reranker sentence-transformers:Alibaba-NLP/gte-multilingual-reranker-base --label 'Upstream models, improved pipeline' --out ../eval/results/upstream-models.json
.venv/Scripts/python.exe -m passageport.evaluation.run report --inputs ../eval/results/default.json ../eval/results/upstream-original.json ../eval/results/upstream-models.json --out passageport/evaluation/report.json
```

The original upstream checkout is commit `a0d8c06` of `praveenc/simple-knowledge-base`;
keep it separately/read-only. The baseline command calls its **actual** DocumentProcessor,
ModelManager and LanceDBManager: raw-file semchunk(512), unnormalized GTE embeddings,
LanceDB default L2 top-20, then original CrossEncoder.predict. Only its scratch DB location
and logging are changed. The `evaluate --embedding ...` command is explicitly a **model
comparison inside PassagePort**, not the full original pipeline.

The modern heavy stack (torch 2.15.0, transformers 5.22.2, sentence-transformers 6.3.0)
failed real cached-GTE inference in Alibaba remote rotary-position code with
`IndexError: index 6546033672192 is out of bounds for dimension 0 with size 5`.
That failed attempt has no quality/speed claims; see `upstream-modern-failure.json`.
`eval/upstream-constraints.txt` isolates the upstream lockfile-compatible stack from default ONNX.
CLI logs are outside git at `D:/tmp/passageport-eval-*.log` (plus installation/check logs).

## Correctness regressions

Owned tests cover uncached oversized compounds; ASCII/curly/apostrophe-stripped contracted
negations never marked shared; whole-reply-only `INSUFFICIENT_EVIDENCE`; NaN/inf/wrong-count
reranker outputs preserving fused order with a search notice (including the actual ONNX adapter);
and highlight strings findable in original Unicode/identifier/apostrophe source text.
Wrapped PDF prose retains its internal newline and complete sentence, so extractive citations
remain exact substrings rather than ending at a visual line wrap. Search, Ask, Compare, Lab and
the committed evaluation report are exercised through their real Pydantic HTTP response models.
