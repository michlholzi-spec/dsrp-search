const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY ?? '';
const OLLAMA_URL       = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const TOGETHER_MODEL   = 'nomic-ai/nomic-embed-text-v1.5';
const OLLAMA_MODEL     = 'nomic-embed-text';

// Uses Together AI in production (TOGETHER_API_KEY set), Ollama locally as fallback
export async function getEmbedding(text: string): Promise<number[]> {
  if (TOGETHER_API_KEY) {
    const res = await fetch('https://api.together.xyz/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOGETHER_API_KEY}`,
      },
      body: JSON.stringify({ model: TOGETHER_MODEL, input: text }),
    });
    if (!res.ok) throw new Error(`Together AI error: ${res.status} ${await res.text()}`);
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
