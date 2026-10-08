// Benchmark 4 (spec §19): keyword-only vs vector-only vs hybrid (searchNotes, RRF) on a SYNTHETIC corpus.
// pnpm --filter @sitspot/evaluation retrieval   (needs Ollama with nomic-embed-text)
import { readFileSync, writeFileSync } from 'node:fs';
import { createDb, ensureUser, insertNote, migrate, searchNotes, type Db } from '@sitspot/db';
import { createLlm, OLLAMA_BASE_URL } from '@sitspot/llm';

type Note = { id: string; date: string; spot: string; body: string };
type Q = { id: string; type: string; q: string; relevant: string[] };
const here = (p: string) => new URL(p, import.meta.url);
const notes: Note[] = JSON.parse(readFileSync(here('./notes.json'), 'utf8')).notes;
const qs: Q[] = JSON.parse(readFileSync(here('./questions.json'), 'utf8')).questions;
const K = 5;

const embedder = createLlm({ baseUrl: OLLAMA_BASE_URL, model: 'nomic-embed-text', timeoutMs: 120_000 });

/** Vector-only, same cosine operator and user filter as searchNotes' vec CTE. */
async function vectorOnly(db: Db, userId: string, e: number[]) {
  return db.query<{ id: string }>(
    `select id from field_notes where user_id = $1 and embedding is not null order by embedding <=> $2::text::vector limit ${K}`,
    [userId, `[${e.join(',')}]`],
  );
}

const variants = [
  { name: 'raw text (as shipped: apps/api embeds raw text)', doc: '', query: '' },
  { name: 'nomic task prefixes (search_document: / search_query:)', doc: 'search_document: ', query: 'search_query: ' },
];

const rows: string[] = ['variant,method,qid,type,relevant,top5,recall_at_5,reciprocal_rank'];
const summary: { variant: string; method: string; type: string; recall: number; mrr: number; n: number }[] = [];

for (const v of variants) {
  const db = await createDb({ memory: true });
  await migrate(db);
  const user = await ensureUser(db, 'eval@sitspot.local');
  const docE = await embedder.embed(notes.map((n) => v.doc + n.body));
  const qE = await embedder.embed(qs.map((q) => v.query + q.q));
  const dbToCorpus = new Map<string, string>();
  for (const [i, n] of notes.entries()) {
    const row = await insertNote(db, { user_id: user.id, date: n.date, body: n.body, facts: { synthetic: true, spot: n.spot }, model: 'synthetic', embedding: docE[i] });
    dbToCorpus.set(row.id, n.id);
  }
  const methods: Record<string, (q: Q, i: number) => Promise<{ id: string }[]>> = {
    'keyword-only (searchNotes, embedding=null)': (q) => searchNotes(db, user.id, q.q, null),
    'vector-only (cosine)': (_q, i) => vectorOnly(db, user.id, qE[i]!),
    'hybrid RRF (searchNotes)': (q, i) => searchNotes(db, user.id, q.q, qE[i]!),
  };
  for (const [method, run] of Object.entries(methods)) {
    const per: { type: string; recall: number; rr: number }[] = [];
    for (const [i, q] of qs.entries()) {
      const top = (await run(q, i)).slice(0, K).map((r) => dbToCorpus.get(r.id)!);
      const recall = q.relevant.filter((r) => top.includes(r)).length / q.relevant.length;
      const first = top.findIndex((t) => q.relevant.includes(t));
      const rr = first === -1 ? 0 : 1 / (first + 1);
      per.push({ type: q.type, recall, rr });
      rows.push([JSON.stringify(v.name), JSON.stringify(method), q.id, q.type, q.relevant.join(' '), top.join(' '), recall.toFixed(3), rr.toFixed(3)].join(','));
    }
    for (const type of ['all', 'keyword', 'paraphrase', 'combo']) {
      const s = per.filter((p) => type === 'all' || p.type === type);
      const mean = (f: (p: (typeof s)[number]) => number) => s.reduce((a, p) => a + f(p), 0) / s.length;
      summary.push({ variant: v.name, method, type, recall: mean((p) => p.recall), mrr: mean((p) => p.rr), n: s.length });
    }
  }
  await db.close();
}

writeFileSync(here('./retrieval_raw.csv'), rows.join('\n') + '\n');

const f = (x: number) => x.toFixed(3);
const table = (variant: string) => {
  const ms = [...new Set(summary.filter((s) => s.variant === variant).map((s) => s.method))];
  const get = (m: string, t: string) => summary.find((s) => s.variant === variant && s.method === m && s.type === t)!;
  return [
    '| Method | Recall@5 (all 40) | MRR@5 (all 40) | R@5 keyword (14) | R@5 paraphrase (13) | R@5 combo (13) | MRR keyword | MRR paraphrase | MRR combo |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...ms.map((m) => `| ${m} | **${f(get(m, 'all').recall)}** | **${f(get(m, 'all').mrr)}** | ${f(get(m, 'keyword').recall)} | ${f(get(m, 'paraphrase').recall)} | ${f(get(m, 'combo').recall)} | ${f(get(m, 'keyword').mrr)} | ${f(get(m, 'paraphrase').mrr)} | ${f(get(m, 'combo').mrr)} |`),
  ].join('\n');
};

const md = `# Retrieval results (benchmark 4)

> **Data is SYNTHETIC.** 60 field notes and 40 questions hand-written by the eval author for five Vasai spot types
> (creek, fort, terrace, lake park, beach; October 2026). Relevance labels were written with the questions, before
> any run, and were not edited after seeing results. Numbers below are from \`evaluation/retrieval/run.ts\`, run ${new Date().toISOString().slice(0, 10)}.

## Primary: ${variants[0]!.name}

${table(variants[0]!.name)}

## Secondary: ${variants[1]!.name}

The app does not add nomic's task prefixes today; this row shows what adding them would change.

${table(variants[1]!.name)}

## Method

- Corpus \`retrieval/notes.json\` (60 notes) loaded into in-memory PGlite via \`@sitspot/db\` (\`migrate\`, \`insertNote\`), one user.
- Embeddings: Ollama \`nomic-embed-text\` (768-d) at \`http://localhost:11434/v1\`, via \`@sitspot/llm\` \`createLlm().embed\`.
- **Keyword-only** = \`searchNotes(db, user, q, null)\`: Postgres full-text (\`plainto_tsquery('english')\` + \`ts_rank_cd\`), i.e. the
  system's keyword path. This is *not* true BM25 (no IDF/length normalisation; PGlite has no BM25 extension), and
  \`plainto_tsquery\` ANDs every term, so a note must contain all query stems to match at all.
- **Vector-only** = \`order by embedding <=> q limit 5\` (cosine distance, same operator as \`searchNotes\`' vector CTE).
- **Hybrid** = \`searchNotes(db, user, q, embedding)\`: RRF (k=60) over the top-20 keyword and top-20 vector lists, top 5 returned.
- Recall@5 = |relevant ∩ top5| / |relevant|, averaged over questions. MRR@5 = 1/rank of the first relevant note in the top 5
  (0 if none); \`searchNotes\` only returns 5 rows, so all methods are cut at 5.
- 40 questions: 14 keyword (share exact terms with the note), 13 paraphrase (written to share no content words), 13 species+condition combos.
  Per-question results: \`retrieval/retrieval_raw.csv\`.

## Observations (from the 2026-10-06 run; re-check the CSV after a rerun)

- Keyword-only finds exact species names almost perfectly but scores 0 on every paraphrase: \`plainto_tsquery\` ANDs all terms.
- Vector-only (raw text) is weak on short species-name queries: for "Coppersmith Barbet", "Painted Storks", "Rufous Treepie",
  "Greater Coucal", "Common Hoopoe" it returned the same five notes (n51 n47 n42 n43 n22), none relevant. Rare proper nouns are
  where nomic-embed-text without task prefixes struggles; the prefixes help vector-only recall but not hybrid MRR.
- Hybrid beats both single methods on Recall@5 and MRR@5 overall, i.e. benchmark 4's target ("hybrid beats both") is met on this synthetic set.

## Caveats

- Synthetic, small (60 notes), single author for notes and questions: the author knows the notes' wording, which can
  bias even the "paraphrase" questions. Treat as a sanity check of the pipeline, not a general retrieval benchmark.
- Several questions have more than one acceptable note; labels are the author's judgement. Unlabelled near-misses count as misses.
- Recall@5 with 60 docs is lenient (5 is 8% of the corpus).
`;
writeFileSync(here('../retrieval_results.md'), md);
console.log(summary.filter((s) => s.type === 'all').map((s) => `${s.variant} | ${s.method}: R@5 ${f(s.recall)} MRR ${f(s.mrr)}`).join('\n'));
