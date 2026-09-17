import { eq } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/sqlite-proxy'

import { migrateIfNeeded, openDb, toDrizzle } from '../index.js'
import { nodeDriver } from '../node/index.js'

let db = openDb(nodeDriver(':memory:'))
let unbind = db.on('error', error => {
  console.error(error.message)
})
let drizzleDb = drizzle(toDrizzle(db))

let postsTable = sqliteTable('posts', {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull()
})

await db.exec(drizzleDb.insert(postsTable).values({ title: 'hello world' }))

let $posts = db.store(
  drizzleDb.select().from(postsTable).where(eq(postsTable.title, 'hello'))
)

$posts.subscribe(state => {
  if (state.status === 'ready') {
    let post = state.value[0]
    if (post) {
      console.log(`${post.id}: ${post.title}`)
    }
  }
})

await $posts.loading

let rows = await db.select<{ id: number; title: string }>`SELECT * FROM posts`
console.log(rows[0]?.title)

let drizzleRows = await db.select(drizzleDb.select().from(postsTable))
console.log(drizzleRows[0]?.title)

await db.exec`INSERT INTO posts (title, rank, published, author)
  VALUES (${'hello'}, ${1}, ${true}, ${null})`

let added = await db.transaction(
  async tx => {
    let last = await tx.select<{
      id: number
    }>`SELECT max("id") AS "id" FROM posts`
    await tx.exec`INSERT INTO posts (title) VALUES (${'next'})`
    return last.length
  },
  { immediate: true }
)
console.log(added)

let $migration = migrateIfNeeded(db, 1, async prevVersion => {
  if (prevVersion < 1) await db.exec`CREATE TABLE users (id INTEGER)`
})
$migration.subscribe(status => {
  if ('error' in status) console.error(status.error.message)
})

let one = await drizzleDb.select().from(postsTable).get()
console.log(one?.title)

db.pause()
db.resume()
unbind()
