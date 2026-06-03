import 'dotenv/config';
import { Pool } from 'pg';
import { getEmbedding } from './embedding.js';

const PG_URI      = process.env.DATABASE_URL ?? 'postgresql://kiagent@localhost/dsrp';
const CONCURRENCY = 5;
const BATCH_SIZE  = 100;

const pg = new Pool({ connectionString: PG_URI });

interface OfferRow {
  id: string;
  search_text: string;
}

interface EmbeddingResult {
  id: string;
  embedding: number[];
}

async function processChunk(rows: OfferRow[]): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const slice      = rows.slice(i, i + CONCURRENCY);
    const embeddings = await Promise.all(slice.map(r => getEmbedding(r.search_text)));
    results.push(...slice.map((r, j) => ({ id: r.id, embedding: embeddings[j] })));
  }
  return results;
}

async function run(): Promise<void> {
  const { rows: [{ count }] } = await pg.query<{ count: string }>(
    'SELECT COUNT(*) FROM offers WHERE embedding IS NULL AND search_text IS NOT NULL',
  );
  const total = parseInt(count);
  const provider = process.env.TOGETHER_API_KEY ? 'Together AI' : 'Ollama';
  console.log(`Generating embeddings for ${total} offers (${provider}: nomic-embed-text)...`);

  let done = 0;

  while (true) {
    const { rows } = await pg.query<OfferRow>(
      `SELECT id, search_text FROM offers
       WHERE embedding IS NULL AND search_text IS NOT NULL
       ORDER BY id LIMIT $1`,
      [BATCH_SIZE],
    );
    if (rows.length === 0) break;

    const results = await processChunk(rows);

    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      for (const { id, embedding } of results) {
        await client.query(
          'UPDATE offers SET embedding = $1 WHERE id = $2',
          [`[${embedding.join(',')}]`, id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    done += results.length;
    process.stdout.write(`\r  ${done}/${total} (${Math.round((done / total) * 100)}%)`);
  }

  console.log('\nEmbeddings fertig. Erstelle HNSW-Index...');
  await pg.query(`
    CREATE INDEX IF NOT EXISTS idx_offers_embedding
    ON offers USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
  `);
  console.log('HNSW-Index erstellt.');

  const { rows: sample } = await pg.query<OfferRow>(
    'SELECT id, search_text FROM offers WHERE embedding IS NOT NULL LIMIT 1',
  );
  if (sample.length > 0) {
    const testEmb = await getEmbedding(sample[0].search_text);
    const { rows: similar } = await pg.query<{ title: string; score: string }>(
      `SELECT title, 1 - (embedding <=> $1) AS score
       FROM offers WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1 LIMIT 5`,
      [`[${testEmb.join(',')}]`],
    );
    console.log('\nTest-Suche:');
    similar.forEach((r: { title: string; score: string }) =>
      console.log(`  ${(parseFloat(r.score) * 100).toFixed(1)}%  ${r.title}`));
  }

  await pg.end();
}

run().catch(err => {
  console.error('\nError:', (err as Error).message);
  process.exit(1);
});
