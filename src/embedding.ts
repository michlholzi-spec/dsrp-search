const HF_API_KEY   = process.env.HF_API_KEY ?? '';
const OLLAMA_URL   = process.env.OLLAMA_URL ?? 'http://localhost:11434';
// nomic-embed-text via HF Inference API — 768 dims, same model as local Ollama
const HF_MODEL_URL = 'https://api-inference.huggingface.co/pipeline/feature-extraction/nomic-ai/nomic-embed-text-v1';
const OLLAMA_MODEL = 'nomic-embed-text';

// Uses Hugging Face in production (HF_API_KEY set), Ollama locally as fallback
export async function getEmbedding(text: string): Promise<number[]> {
  if (HF_API_KEY) {
    const res = await fetch(HF_MODEL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HF_API_KEY}`,
      },
      body: JSON.stringify({ inputs: text }),
    });
    if (!res.ok) throw new Error(`HuggingFace error: ${res.status} ${await res.text()}`);
    const data = await res.json() as number[];
    return data;
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
