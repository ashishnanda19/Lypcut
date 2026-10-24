import { existsSync } from 'node:fs'
import path from 'node:path'
import type { EmbeddingKind, EmbeddingProvider } from './types.js'

/** The few things of transformers.js's feature-extraction pipeline that are used here. */
type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

export interface TransformersOptions {
  model: string
  /** Where the model's files live (downloaded once, by `npm run models:download-embeddings`). */
  dir: string
  /** Allow fetching the model from the internet. Only the download tool does; a running server never reaches out. */
  allowDownload?: boolean
}

/** Where a model's files are expected, so a caller can tell whether it has been downloaded. */
export const modelPath = (dir: string, model: string) => path.join(dir, ...model.split('/'))
export const hasModel = (dir: string, model: string) =>
  existsSync(path.join(modelPath(dir, model), 'config.json'))

const BATCH = 32

/**
 * Multilingual embeddings computed on this machine (multilingual-e5-small by default: Hindi, English and in-between, 384
 * numbers per text, about 120 MB, no per-call cost). It runs in-process through ONNX; the model loads on first use, or
 * earlier if `warm()` is called. e5 wants to be told whether a text is a question or a passage, so those are prefixed.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local'
  readonly model: string
  readonly dimensions = 384
  readonly similarityFloor = 0.8
  private extractor: Promise<Extractor> | null = null
  /** The model is not safe to run twice at once in one process; calls queue up. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: TransformersOptions) {
    this.model = opts.model
  }

  warm(): Promise<unknown> {
    return this.load()
  }

  private load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = path.resolve(this.opts.dir)
      env.allowRemoteModels = !!this.opts.allowDownload
      env.allowLocalModels = true
      const p = await pipeline('feature-extraction', this.opts.model, { dtype: 'q8' })
      return p as unknown as Extractor
    })().catch((e) => {
      // Let the next call try again rather than caching a failure forever.
      this.extractor = null
      throw e
    })
    return this.extractor
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<number[][]> {
    const run = async () => {
      const extractor = await this.load()
      const prefixed = texts.map((t) => `${kind === 'query' ? 'query' : 'passage'}: ${t}`)
      const out: number[][] = []
      for (let i = 0; i < prefixed.length; i += BATCH) {
        const batch = await extractor(prefixed.slice(i, i + BATCH), {
          pooling: 'mean',
          normalize: true,
        })
        out.push(...batch.tolist())
      }
      return out
    }
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => undefined)
    return result
  }
}
