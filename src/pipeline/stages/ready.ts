import { eq } from 'drizzle-orm'
import { projects } from '../../db/schema/index.js'
import type { Stage } from '../context.js'

/** Stage 8: everything is in place. The project opens in the editor. */
export const ready: Stage = {
  key: 'ready',
  step: 4,
  from: 99,
  to: 100,
  async run(ctx) {
    await ctx.deps.database.db
      .update(projects)
      .set({ status: 'ready', error: null })
      .where(eq(projects.id, ctx.project.id))
    await ctx.report.update(
      { status: 'done', progress: 100, step: 4, detail: 'Ready to edit', stage: null, error: null },
      { force: true },
    )
    return {}
  },
}
