const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OLLAMA_URL     = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OPENAI_MODEL   = 'text-embedding-3-small'; // 1536 dims
const OLLAMA_MODEL   = 'nomic-embed-text';        // 768 dims (lokal)

// Uses OpenAI in production (OPENAI_API_KEY set), Ollama locally as fallback
export async function getEmbedding(text: string): Promise<number[]> {
  if (OPENAI_API_KEY) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: OPENAI_MODEL, input: text }),
    });
    if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
    const data = await res.json() as { data: [{ embedding: number[] }] };
    return data.data[0].embedding;
  }

  // Fallback: Ollama (lokal)
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  const { embedding } = await res.json() as { embedding: number[] };
  return embedding;
}
