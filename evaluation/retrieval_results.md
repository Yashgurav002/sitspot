# Retrieval results (benchmark 4)

> **Data is SYNTHETIC.** 60 field notes and 40 questions hand-written by the eval author for five Vasai spot types
> (creek, fort, terrace, lake park, beach; October 2026). Relevance labels were written with the questions, before
> any run, and were not edited after seeing results. Numbers below are from `evaluation/retrieval/run.ts`, run 2026-10-06.

## Primary: raw text (as shipped: apps/api embeds raw text)

| Method | Recall@5 (all 40) | MRR@5 (all 40) | R@5 keyword (14) | R@5 paraphrase (13) | R@5 combo (13) | MRR keyword | MRR paraphrase | MRR combo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| keyword-only (searchNotes, embedding=null) | **0.454** | **0.500** | 0.964 | 0.000 | 0.359 | 1.000 | 0.000 | 0.462 |
| vector-only (cosine) | **0.487** | **0.438** | 0.357 | 0.654 | 0.462 | 0.357 | 0.564 | 0.397 |
| hybrid RRF (searchNotes) | **0.750** | **0.725** | 0.964 | 0.654 | 0.615 | 1.000 | 0.564 | 0.590 |

## Secondary: nomic task prefixes (search_document: / search_query:)

The app does not add nomic's task prefixes today; this row shows what adding them would change.

| Method | Recall@5 (all 40) | MRR@5 (all 40) | R@5 keyword (14) | R@5 paraphrase (13) | R@5 combo (13) | MRR keyword | MRR paraphrase | MRR combo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| keyword-only (searchNotes, embedding=null) | **0.454** | **0.500** | 0.964 | 0.000 | 0.359 | 1.000 | 0.000 | 0.462 |
| vector-only (cosine) | **0.575** | **0.436** | 0.357 | 0.808 | 0.577 | 0.286 | 0.572 | 0.462 |
| hybrid RRF (searchNotes) | **0.787** | **0.711** | 0.964 | 0.808 | 0.577 | 0.964 | 0.572 | 0.577 |

## Method

- Corpus `retrieval/notes.json` (60 notes) loaded into in-memory PGlite via `@sitspot/db` (`migrate`, `insertNote`), one user.
- Embeddings: Ollama `nomic-embed-text` (768-d) at `http://localhost:11434/v1`, via `@sitspot/llm` `createLlm().embed`.
- **Keyword-only** = `searchNotes(db, user, q, null)`: Postgres full-text (`plainto_tsquery('english')` + `ts_rank_cd`), i.e. the
  system's keyword path. This is *not* true BM25 (no IDF/length normalisation; PGlite has no BM25 extension), and
  `plainto_tsquery` ANDs every term, so a note must contain all query stems to match at all.
- **Vector-only** = `order by embedding <=> q limit 5` (cosine distance, same operator as `searchNotes`' vector CTE).
- **Hybrid** = `searchNotes(db, user, q, embedding)`: RRF (k=60) over the top-20 keyword and top-20 vector lists, top 5 returned.
- Recall@5 = |relevant ∩ top5| / |relevant|, averaged over questions. MRR@5 = 1/rank of the first relevant note in the top 5
  (0 if none); `searchNotes` only returns 5 rows, so all methods are cut at 5.
- 40 questions: 14 keyword (share exact terms with the note), 13 paraphrase (written to share no content words), 13 species+condition combos.
  Per-question results: `retrieval/retrieval_raw.csv`.

## Observations (from the 2026-10-06 run; re-check the CSV after a rerun)

- Keyword-only finds exact species names almost perfectly but scores 0 on every paraphrase: `plainto_tsquery` ANDs all terms.
- Vector-only (raw text) is weak on short species-name queries: for "Coppersmith Barbet", "Painted Storks", "Rufous Treepie",
  "Greater Coucal", "Common Hoopoe" it returned the same five notes (n51 n47 n42 n43 n22), none relevant. Rare proper nouns are
  where nomic-embed-text without task prefixes struggles; the prefixes help vector-only recall but not hybrid MRR.
- Hybrid beats both single methods on Recall@5 and MRR@5 overall, i.e. benchmark 4's target ("hybrid beats both") is met on this synthetic set.

## Caveats

- Synthetic, small (60 notes), single author for notes and questions: the author knows the notes' wording, which can
  bias even the "paraphrase" questions. Treat as a sanity check of the pipeline, not a general retrieval benchmark.
- Several questions have more than one acceptable note; labels are the author's judgement. Unlabelled near-misses count as misses.
- Recall@5 with 60 docs is lenient (5 is 8% of the corpus).
