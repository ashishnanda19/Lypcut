import { createDatabase } from '../db/client.js'
import { loadConfigOrExit } from '../lib/bootstrap.js'
import { listDeadLetters, retryDeadLetter } from '../queue/dead-letters.js'
import { createQueues } from '../queue/queues.js'

/**
 * Operator tool.
 *   npm run jobs:dead                 list jobs that used up every try
 *   npm run jobs:dead -- retry <id>   give one a fresh set of tries
 */
const config = loadConfigOrExit()
const database = createDatabase(config)
const queues = createQueues(config)
const [command, id] = process.argv.slice(2)

try {
  if (command === 'retry') {
    if (!id) throw new Error('usage: npm run jobs:dead -- retry <job id>')
    const found = await retryDeadLetter(queues, database, id)
    console.log(found ? `queued again: ${id}` : `no failed job with id ${id}`)
    process.exitCode = found ? 0 : 1
  } else {
    const list = await listDeadLetters(queues, database)
    if (!list.length) console.log('no dead letters')
    for (const d of list)
      console.log(
        `${d.queue}\t${d.type}\t${d.jobId}\ttries=${d.attempts}\t${d.failedAt ?? '-'}\t${d.reason.slice(0, 120)}`,
      )
  }
} finally {
  await queues.close()
  await database.close()
}
