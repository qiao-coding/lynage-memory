// ---------------------------------------------------------------------------
// Lynage Embedder — text embedding for semantic search (Phase 2)
//
// Pluggable interface: swap implementations without changing search logic.
// Default: Transformers.js (local, free, ~30ms for 384-dim).
// ---------------------------------------------------------------------------

/**
 * Text embedding interface. Named "Embedder" to distinguish from Lynage's
 * existing "model" (LLM) and "store" (DB) concepts. Each implementation
 * wraps a specific embedding engine.
 */
export interface Embedder {
  readonly name: string;
  readonly dimensions: number;

  /**
   * Minimum cosine similarity that counts as a GENUINE semantic match for this
   * embedder. Similarity scales differ per embedder (bge gives unrelated pairs
   * ~0.33, trigram gives unrelated ~0.2), so the retriever uses this to tell
   * "rerank wrongly said nothing relevant" apart from "genuinely nothing
   * relevant" (abstention). If no chunk's similarity reaches this, the search
   * collapses to the single best keyword candidate instead of flooding with noise.
   */
  readonly confidenceThreshold: number;

  /** Embed a single text → vector. For batch processing, use embedBatch. */
  embed(text: string): Promise<Float32Array>;

  /** Embed multiple texts efficiently (single model pass). */
  embedBatch(texts: string[]): Promise<Float32Array[]>;

  /** Cosine similarity ∈ [-1, 1]. 1 = identical, 0 = orthogonal. */
  similarity(a: Float32Array, b: Float32Array): number;
}

// ---------------------------------------------------------------------------
// Cosine similarity (pure function, usable by any implementation)
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("Vector dimension mismatch");
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Transformers.js implementation (HuggingFace transformers v3)
//
// Uses @huggingface/transformers for local inference. Model is downloaded once,
// cached on disk. bge-small-en-v1.5: 384-dim, ~30MB, supports English + code.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

export interface TransformersEmbedderOptions {
  model?: string;
}

export class TransformersEmbedder implements Embedder {
  readonly name = "transformers.js";
  readonly dimensions = 384;
  // bge-small cosine: unrelated pairs ~0.28-0.39, related ~0.5-0.9. 0.42
  // separates "rerank missed a real match" from "genuinely nothing relevant".
  readonly confidenceThreshold = 0.42;

  private _model: string;
  private _pipeline: any = null;
  private _ready: Promise<void> | null = null;

  constructor(options: TransformersEmbedderOptions = {}) {
    this._model = options.model || DEFAULT_MODEL;
  }

  /**
   * Lazy-load the Transformers.js pipeline. First call triggers model download
   * (~30MB, cached locally). Subsequent calls are instant.
   */
  private async _ensureReady(): Promise<void> {
    if (this._pipeline) return;
    if (this._ready) { await this._ready; return; }

    this._ready = (async () => {
      try {
        const { pipeline } = await import("@huggingface/transformers");
        this._pipeline = await pipeline("feature-extraction", this._model, {
          dtype: "fp32",
          device: "cpu",
        });
      } catch (err: any) {
        throw new Error(
          `Failed to load Transformers.js model "${this._model}". ` +
          `Install with: pnpm add @huggingface/transformers\n` +
          `Original error: ${err.message}`,
        );
      }
    })();

    await this._ready;
  }

  // bge-small context = 512 tokens (~2000 chars). Anything longer is truncated
  // by the model anyway, so truncating BEFORE inference avoids tokenizing and
  // running the transformer over thousands of tokens — semantically identical,
  // orders of magnitude faster for long archive messages.
  private static readonly MAX_CHARS = 1800;
  private static truncate(text: string): string {
    return text.length > TransformersEmbedder.MAX_CHARS
      ? text.slice(0, TransformersEmbedder.MAX_CHARS)
      : text;
  }

  async embed(text: string): Promise<Float32Array> {
    await this._ensureReady();
    const result = await this._pipeline(TransformersEmbedder.truncate(text), {
      pooling: "mean",
      normalize: true,
    });
    // result is a Tensor-like object with data and dims
    return new Float32Array(result.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this._ensureReady();
    // TRUE batched inference: the transformers.js pipeline accepts an array
    // input and returns a [batch, dim] tensor in ONE vectorized pass. (The old
    // Promise.all-of-4 approach ran N separate CPU inferences, near-serial.)
    const out: Float32Array[] = [];
    const BATCH = 8;
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH).map(TransformersEmbedder.truncate);
      const result = await this._pipeline(slice, {
        pooling: "mean",
        normalize: true,
      });
      const dim = result.dims[1];
      for (let j = 0; j < slice.length; j++) {
        out.push(new Float32Array(result.data.subarray(j * dim, (j + 1) * dim)));
      }
    }
    return out;
  }

  similarity(a: Float32Array, b: Float32Array): number {
    return cosineSimilarity(a, b);
  }
}

// ---------------------------------------------------------------------------
// No-op embedder (fallback when no embedding model is available)
// ---------------------------------------------------------------------------

export class NoopEmbedder implements Embedder {
  readonly name = "noop";
  readonly dimensions = 0;
  // No semantic signal — never keeps extra candidates on rerank-empty.
  readonly confidenceThreshold = Infinity;

  async embed(_text: string): Promise<Float32Array> { return new Float32Array(0); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> { return texts.map(() => new Float32Array(0)); }
  similarity(_a: Float32Array, _b: Float32Array): number { return 0; }
}

// ---------------------------------------------------------------------------
// Trigram TF-IDF embedder — pure TypeScript, sparse vectors, zero dependencies.
//
// Each unique character trigram in the corpus gets a unique index. Vectors
// are sparse Maps (index → TF*IDF weight). Cosine similarity is computed
// directly from sparse overlap — no hash collisions, no dimension limit.
//
// "deployment platform" vs "deployment strategy":
//   shared trigrams: "dep","epl","plo","loy","oym","yme","men","ent" (8 shared)
//   → cosine ≈ 0.6-0.8 — high enough to bridge the lexical gap.
// ---------------------------------------------------------------------------

export class TrigramEmbedder implements Embedder {
  readonly name = "trigram-tfidf";
  readonly dimensions = 0; // sparse
  // Trigram cosine: related ~0.6-0.8, unrelated ~0.1-0.3. 0.45 is a safe
  // genuine-match floor.
  readonly confidenceThreshold = 0.45;

  private _vocab: Map<string, number> = new Map();  // trigram → index
  private _idf: Float32Array = new Float32Array(0); // per-index IDF weight
  private _fitted = false;

  /** Feed the corpus to build vocabulary + IDF. Call once before embedding. */
  fit(corpus: string[]) {
    this._vocab.clear();
    const df = new Map<string, number>();
    for (const text of corpus) {
      const seen = new Set<string>();
      for (const t of uniqueTrigrams(text)) {
        if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) ?? 0) + 1); }
      }
    }
    // Assign indices
    let idx = 0;
    const N = corpus.length;
    this._idf = new Float32Array(df.size);
    for (const [t, count] of df) {
      this._vocab.set(t, idx);
      this._idf[idx] = Math.log((N + 1) / (count + 1)) + 1;
      idx++;
    }
    this._fitted = true;
  }

  /** Convert text → sparse vector as Map<index, weight>. */
  private _sparseEmbed(text: string): Map<number, number> {
    const vec = new Map<number, number>();
    const tokens = uniqueTrigrams(text);
    for (const t of tokens) {
      const idx = this._vocab.get(t);
      if (idx !== undefined) {
        vec.set(idx, (vec.get(idx) ?? 0) + this._idf[idx]!);
      }
    }
    // L2-normalize
    let norm = 0;
    for (const w of vec.values()) norm += w * w;
    if (norm > 0) {
      const invNorm = 1 / Math.sqrt(norm);
      for (const [k, w] of vec) vec.set(k, w * invNorm);
    }
    return vec;
  }

  async embed(text: string): Promise<Float32Array> {
    // Return sparse vector as flat Float32Array: [idx1, w1, idx2, w2, ...]
    const sparse = this._sparseEmbed(text);
    const arr = new Float32Array(sparse.size * 2);
    let i = 0;
    for (const [idx, w] of sparse) { arr[i++] = idx; arr[i++] = w; }
    return arr;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => {
      const sparse = this._sparseEmbed(t);
      const arr = new Float32Array(sparse.size * 2);
      let i = 0;
      for (const [idx, w] of sparse) { arr[i++] = idx; arr[i++] = w; }
      return arr;
    });
  }

  /** Cosine similarity from sparse Float32Array pairs. */
  similarity(a: Float32Array, b: Float32Array): number {
    // Parse sparse vectors
    const mapA = new Map<number, number>();
    const mapB = new Map<number, number>();
    for (let i = 0; i < a.length; i += 2) mapA.set(a[i]!, a[i+1]!);
    for (let i = 0; i < b.length; i += 2) mapB.set(b[i]!, b[i+1]!);
    // Dot product over intersection
    let dot = 0;
    for (const [idx, wa] of mapA) {
      const wb = mapB.get(idx);
      if (wb !== undefined) dot += wa * wb;
    }
    return dot; // vectors are L2-normalized, so dot = cosine
  }
}

/** Extract unique character trigrams from text. */
function uniqueTrigrams(text: string): string[] {
  const s = text.toLowerCase().replace(/[^a-z0-9一-鿿]/g, " ");
  const seen = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) {
    seen.add(s.slice(i, i + 3));
  }
  return [...seen];
}
