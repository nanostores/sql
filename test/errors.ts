import { eq } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/sqlite-proxy'

import { openDb, toDrizzle } from '../index.js'
import { nodeDriver } from '../node/index.js'

let db = openDb(nodeDriver(':memory:'))
let drizzleDb = drizzle(toDrizzle(db))

let postsTable = sqliteTable('posts', {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull()
})

await db.exec(drizzleDb.insert(postsTable).values({ title: 'hello world' }))

let $posts = db.store(
  drizzleDb.select().from(postsTable).where(eq(postsTable.title, 'hello'))
)

$posts.subscribe(value => {
  // THROWS isLoading: true
  console.log(value.value.length)
  if (!value.isLoading) {
    let post = value.value[0]
    if (post) {
      // THROWS 'name' does not exist on type '{ id: number; title: string; }'
      console.log(`${post.id}: ${post.name}`)
    }
  }
})
