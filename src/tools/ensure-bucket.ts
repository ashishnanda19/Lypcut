import { loadConfigOrExit } from '../lib/bootstrap.js'
import { Storage } from '../lib/storage.js'

/** Dev only: creates the bucket if it is missing. Production buckets come from infrastructure. */
const config = loadConfigOrExit()
const storage = new Storage(config)
await storage.ensureBucket()
console.log(`bucket ready: ${config.S3_BUCKET}`)
storage.destroy()
