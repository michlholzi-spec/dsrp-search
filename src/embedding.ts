const API_KEY = process.env.TOGETHER_API_KEY ?? '';
const MODEL   = 'nomic-ai/nomic-embed-text-v1.5'; // 768 dims — same as local Ollama model

export async function getEmbedding(text: string): Promise<number[]> {
  if (!API_KEY) throw new Error('TOGETHER_API_KEY is not set');

  const res = await fetch('https://api.together.xyz/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: text }),
  });

  if (!res.ok) throw new Error(`Together AI error: ${res.status} ${await res.text()}`);

  const data = await res.json() as { data: [{ embedding: number[] }] };
  return data.data[0].embedding;
}
