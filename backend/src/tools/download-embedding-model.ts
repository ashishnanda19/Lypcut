import { loadConfigOrExit } from '../lib/bootstrap.js'
import { hasModel, TransformersEmbeddingProvider } from '../llm/transformers-embedding.js'

/**
 * Downloads the embedding model (EMBEDDING_MODEL, multilingual-e5-small by default, about 120 MB) into
 * EMBEDDING_MODEL_DIR, unless it is already there. Used by `npm run models:download-embeddings` and by the
 * `embedding-model` service in docker-compose. Nothing else in the server ever fetches a model from the internet.
 */
const config = loadConfigOrExit()

if (hasModel(config.EMBEDDING_MODEL_DIR, config.EMBEDDING_MODEL)) {
  console.log(`embedding model already present: ${config.EMBEDDING_MODEL}`)
  process.exit(0)
}

console.log(`downloading ${config.EMBEDDING_MODEL} into ${config.EMBEDDING_MODEL_DIR}`)
try {
  const provider = new TransformersEmbeddingProvider({
    model: config.EMBEDDING_MODEL,
    dir: config.EMBEDDING_MODEL_DIR,
    allowDownload: true,
  })
  // Loading it downloads it. Embedding one text proves it works.
  const [v] = await provider.embed(['namaste'], 'query')
  if (!v || v.length !== provider.dimensions)
    throw new Error('the model did not produce vectors of the expected size')
  console.log('embedding model ready')
} catch (e) {
  // Not fatal: without the model, search by meaning uses the built-in stand-in and everything else is unaffected.
  console.warn(
    `could not download the embedding model (${e instanceof Error ? e.message : String(e)}).`,
  )
  console.warn(
    'Search will use words and the offline stand-in until it is downloaded: npm run models:download-embeddings',
  )
}
process.exit(0)
