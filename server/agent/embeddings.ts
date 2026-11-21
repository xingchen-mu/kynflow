/** An OpenAI-compatible embeddings endpoint; memory search uses it for meaning, keywords stay the fallback. */
export interface EmbeddingConfig {
  model: string;
  /** `https://api.openai.com/v1` when unset; a full `…/embeddings` address is used as is. */
  baseUrl?: string;
  apiKey?: string;
}

export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

const TIMEOUT = 20_000;

function endpoint(baseUrl?: string): string {
  const base = (baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return base.endsWith('/embeddings') ? base : `${base}/embeddings`;
}

/** The embedder settings ask for, or undefined when no model is configured. */
export function createEmbedder(config?: EmbeddingConfig): Embedder | undefined {
  const model = config?.model?.trim();
  if (!model) return undefined;
  const url = endpoint(config?.baseUrl);
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length) return [];
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config?.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) {
        // The body often says what is wrong (unknown model, missing key); keep it short for the log.
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`embeddings ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const data = (await res.json()) as { data?: { embedding?: unknown }[]; embeddings?: unknown };
      const rows = Array.isArray(data.data)
        ? data.data.map((d) => d?.embedding)
        : Array.isArray(data.embeddings)
          ? data.embeddings
          : undefined;
      if (!rows || rows.length !== texts.length) throw new Error('embeddings: unexpected response');
      return rows.map((row) => {
        if (!Array.isArray(row) || !row.length || !row.every((n) => typeof n === 'number' && Number.isFinite(n))) {
          throw new Error('embeddings: unexpected vector');
        }
        return row as number[];
      });
    },
  };
}

/** Cosine similarity; 0 when the vectors have different sizes (a changed model). */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
