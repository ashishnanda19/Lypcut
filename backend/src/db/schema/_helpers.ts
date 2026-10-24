import { sql } from 'drizzle-orm'
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core'
import { uuidv7 } from '../../lib/ids.js'

/** UUID v7 primary key, generated in the app so ids sort by creation time. */
export const pk = () => uuid().primaryKey().$defaultFn(uuidv7)

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() })

export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

/** A generated column's SQL, written with raw column names (it cannot reference its own table object). */
export const rawSql = (text: string) => sql.raw(text)
