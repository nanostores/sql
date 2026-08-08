import { eq } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { type ReadableAtom, STORE_UNMOUNT_DELAY } from 'nanostores'
import { deepEqual, equal, match, notEqual } from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'

import {
  openDb,
  toDrizzle,
  type Database,
  type Driver,
  type SqlStoreValue
} from '../index.js'
import { nodeDriver } from '../node/index.js'
import { pgliteDriver } from '../pglite/index.js'

function loadValue<Value>(
  store: ReadableAtom<SqlStoreValue<Value>>
): Promise<Value> {
  return new Promise<Value>(resolve => {
    let done = false
    let unsubscribe: () => void
    unsubscribe = store.subscribe(state => {
      if (!state.isLoading) {
        resolve(state.value)
        done = true
        if (unsubscribe) unsubscribe()
      }
    })
    if (done) unsubscribe()
  })
}

let postsTable = sqliteTable('posts', {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull()
})

interface Item {
  id: number
  title: string
}

interface Log {
  id: number
  msg: string
}

interface DriverSetup {
  create: () => Driver
  autoincrement: string
}

const DRIVERS: Record<string, DriverSetup> = {
  node: {
    create: () => nodeDriver(':memory:'),
    autoincrement: 'INTEGER PRIMARY KEY AUTOINCREMENT'
  },
  pglite: {
    create: () => pgliteDriver('memory://'),
    autoincrement: 'SERIAL PRIMARY KEY'
  }
}

for (let [driverName, setup] of Object.entries(DRIVERS)) {
  function createTable(
    db: Database,
    table: string,
    cols: string
  ): Promise<unknown> {
    let sql = `CREATE TABLE ${table} (id ${setup.autoincrement}, ${cols})`
    return db.driver.exec(sql, [])
  }

  describe(driverName, () => {
    let db: Database | undefined

    afterEach(async () => {
      await db?.close()
    })

    test('returns reactive atom', async () => {
      db = openDb(setup.create())
      await createTable(db, 'items', 'title TEXT')
      await db.exec`INSERT INTO items (title) VALUES (${'first'})`

      let values: SqlStoreValue<Item[]>[] = []
      let $items = db.store<Item>`SELECT * FROM items ORDER BY id`
      $items.subscribe(state => {
        values.push(state)
      })
      deepEqual(values, [{ isLoading: true }])

      await setTimeout(50)
      deepEqual(values, [
        { isLoading: true },
        { isLoading: false, value: [{ id: 1, title: 'first' }] }
      ])

      await db.exec`INSERT INTO items (title) VALUES (${'second'})`
      deepEqual(values, [
        { isLoading: true },
        { isLoading: false, value: [{ id: 1, title: 'first' }] },
        {
          isLoading: false,
          value: [
            { id: 1, title: 'first' },
            { id: 2, title: 'second' }
          ]
        }
      ])

      let $other = db.store<Item>`SELECT * FROM items ORDER BY id`
      equal($other, $items)
    })

    test('selects rows without store', async () => {
      db = openDb(setup.create())
      await createTable(db, 'items', 'title TEXT')
      await db.exec`INSERT INTO items (title) VALUES (${'first'})`

      let items = await db.select<Item>`SELECT * FROM items ORDER BY id`
      deepEqual(items, [{ id: 1, title: 'first' }])

      let injection = "' OR '1'='1"
      let none = await db.select`SELECT * FROM items WHERE title = ${injection}`
      deepEqual(none, [])

      await db.exec`INSERT INTO items (title) VALUES (${'second'})`
      let updated = await db.select<Item>`SELECT * FROM items ORDER BY id`
      deepEqual(updated, [
        { id: 1, title: 'first' },
        { id: 2, title: 'second' }
      ])
    })

    test('selects inside transaction', async () => {
      db = openDb(setup.create())
      await createTable(db, 'items', 'title TEXT')

      let inside = await db.transaction(async tx => {
        await tx.exec`INSERT INTO items (title) VALUES (${'first'})`
        return tx.select<Item>`SELECT * FROM items ORDER BY id`
      })
      deepEqual(inside, [{ id: 1, title: 'first' }])
    })

    test('reads and writes in immediate transaction', async () => {
      db = openDb(setup.create())
      await createTable(db, 'items', 'title TEXT')
      await db.exec`INSERT INTO items (title) VALUES (${'first'})`

      let last = await db.transaction(
        async tx => {
          let rows = await tx.select<{
            last: number
          }>`SELECT max(id) AS last FROM items`
          await tx.exec`INSERT INTO items (title) VALUES (${'second'})`
          return rows[0]!.last
        },
        { immediate: true }
      )
      equal(last, 1)

      let items = await db.select<Item>`SELECT * FROM items ORDER BY id`
      deepEqual(items, [
        { id: 1, title: 'first' },
        { id: 2, title: 'second' }
      ])
    })

    test('selects with Drizzle', async () => {
      db = openDb(setup.create())
      await createTable(db, 'posts', 'title TEXT NOT NULL')
      let drizzleDb = drizzle(toDrizzle(db))

      await db.exec(
        drizzleDb.insert(postsTable).values({ id: 1, title: 'hello' })
      )
      let posts = await db.select(drizzleDb.select().from(postsTable))
      deepEqual(posts, [{ id: 1, title: 'hello' }])
    })

    test('commits transactions', async () => {
      db = openDb(setup.create())
      await createTable(db, 'logs', 'msg TEXT')

      let values: SqlStoreValue<Log[]>[] = []
      let $logs = db.store<Log>`SELECT * FROM logs ORDER BY id`
      $logs.subscribe(value => {
        values.push(value)
      })
      await setTimeout(10)

      await db.transaction(async tx => {
        await tx.exec`INSERT INTO logs (msg) VALUES (${'one'})`
        await tx.exec`INSERT INTO logs (msg) VALUES (${'two'})`
      })
      await setTimeout(50)

      deepEqual(values, [
        { isLoading: true },
        {
          isLoading: false,
          value: []
        },
        {
          isLoading: false,
          value: [
            { id: 1, msg: 'one' },
            { id: 2, msg: 'two' }
          ]
        }
      ])

      let error: Error | undefined
      try {
        await db.transaction(async tx => {
          await tx.exec`INSERT INTO logs (msg) VALUES (${'three'})`
          await tx.exec`INSERT INTO logs (wrongNameColumn) VALUES (1)`
        })
      } catch (e) {
        if (e instanceof Error) error = e
      }
      match(error!.message, /wrongNameColumn/i)
      await setTimeout(50)

      deepEqual(values, [
        { isLoading: true },
        {
          isLoading: false,
          value: []
        },
        {
          isLoading: false,
          value: [
            { id: 1, msg: 'one' },
            { id: 2, msg: 'two' }
          ]
        }
      ])
    })

    test('prevents SQL injection', async () => {
      db = openDb(setup.create())

      await createTable(db, 'secrets', 'data TEXT')
      await db.exec`INSERT INTO secrets (data) VALUES (${'top-secret'})`

      let injection = "' OR '1'='1"
      let injected: SqlStoreValue<unknown[]>[] = []
      let $secrets = db.store`SELECT * FROM secrets WHERE data = ${injection}`
      $secrets.subscribe(state => {
        injected.push(state)
      })

      deepEqual(injected, [{ isLoading: true }])
      await setTimeout(50)

      // Should return no rows, not all rows
      deepEqual(injected, [
        { isLoading: true },
        { isLoading: false, value: [] }
      ])

      let execInjection = "'); DROP TABLE secrets; --"
      await db.exec`INSERT INTO secrets (data) VALUES (${execInjection})`

      let all: SqlStoreValue<unknown[]>[] = []
      let $allSecrets = db.store`SELECT * FROM secrets ORDER BY id`
      $allSecrets.subscribe(state => {
        all.push(state)
      })

      await setTimeout(50)
      deepEqual(all, [
        { isLoading: true },
        {
          isLoading: false,
          value: [
            { id: 1, data: 'top-secret' },
            { id: 2, data: execInjection }
          ]
        }
      ])
    })

    test('unsubscribes', async () => {
      db = openDb(setup.create())

      await createTable(db, 'items', 'title TEXT')
      await db.exec`INSERT INTO items (title) VALUES (${'first'})`

      let values: SqlStoreValue<Item[]>[] = []
      let $items = db.store<Item>`SELECT * FROM items ORDER BY id`
      let unbind = $items.subscribe(state => {
        values.push(state)
      })

      await setTimeout(50)
      unbind()
      await setTimeout(STORE_UNMOUNT_DELAY)
      await db.exec`INSERT INTO items (title) VALUES (${'second'})`
      await setTimeout(50)
      deepEqual(values, [
        { isLoading: true },
        { isLoading: false, value: [{ id: 1, title: 'first' }] }
      ])
      deepEqual($items.value, {
        isLoading: false,
        value: [{ id: 1, title: 'first' }]
      })

      let $other = db.store<Item>`SELECT * FROM items ORDER BY id`
      notEqual($other, $items)

      let newSubscription: SqlStoreValue<Item[]>[] = []
      $items.subscribe(state => {
        newSubscription.push(state)
      })
      await setTimeout(10)
      // Re-subscribing keeps the last value instead of flashing isLoading,
      // then updates once the fresh query resolves
      deepEqual(newSubscription, [
        { isLoading: false, value: [{ id: 1, title: 'first' }] },
        {
          isLoading: false,
          value: [
            { id: 1, title: 'first' },
            { id: 2, title: 'second' }
          ]
        }
      ])

      await db.exec`DELETE FROM items WHERE id = ${2}`
      deepEqual(newSubscription, [
        { isLoading: false, value: [{ id: 1, title: 'first' }] },
        {
          isLoading: false,
          value: [
            { id: 1, title: 'first' },
            { id: 2, title: 'second' }
          ]
        },
        {
          isLoading: false,
          value: [{ id: 1, title: 'first' }]
        }
      ])
    })

    test('resolves loading promise on first value', async () => {
      db = openDb(setup.create())
      await createTable(db, 'items', 'title TEXT')
      await db.exec`INSERT INTO items (title) VALUES (${'first'})`

      let $items = db.store<Item>`SELECT * FROM items ORDER BY id`
      let unbind = $items.subscribe(() => {})
      await $items.loading
      deepEqual($items.value, {
        isLoading: false,
        value: [{ id: 1, title: 'first' }]
      })
      unbind()
    })

    test('pauses and resumes queries', async () => {
      db = openDb(setup.create())
      await createTable(db, 'items', 'title TEXT')
      await db.exec`INSERT INTO items (title) VALUES (${'first'})`

      db.pause()
      let values: SqlStoreValue<Item[]>[] = []
      let $items = db.store<Item>`SELECT * FROM items ORDER BY id`
      $items.subscribe(state => {
        values.push(state)
      })

      await setTimeout(50)
      deepEqual(values, [{ isLoading: true }])

      db.resume()
      await setTimeout(50)
      deepEqual(values, [
        { isLoading: true },
        { isLoading: false, value: [{ id: 1, title: 'first' }] }
      ])
    })

    test('drops deferred query when unmounted before resume', async () => {
      db = openDb(setup.create())
      await createTable(db, 'items', 'title TEXT')
      await db.exec`INSERT INTO items (title) VALUES (${'first'})`

      db.pause()
      let values: SqlStoreValue<Item[]>[] = []
      let $items = db.store<Item>`SELECT * FROM items ORDER BY id`
      let unbind = $items.subscribe(state => {
        values.push(state)
      })

      await setTimeout(10)
      unbind()
      await setTimeout(STORE_UNMOUNT_DELAY)

      db.resume()
      await setTimeout(50)
      deepEqual(values, [{ isLoading: true }])
    })

    test('supports Drizzle', async () => {
      db = openDb(setup.create())
      await createTable(db, 'posts', 'title TEXT NOT NULL')
      let drizzleDb = drizzle(toDrizzle(db))

      await db.exec(
        drizzleDb.insert(postsTable).values({ id: 1, title: 'old' })
      )
      await db.exec(
        drizzleDb
          .update(postsTable)
          .set({ title: 'updated' })
          .where(eq(postsTable.id, 1))
      )

      let rows = await loadValue(db.store(drizzleDb.select().from(postsTable)))
      deepEqual(rows, [{ id: 1, title: 'updated' }])
    })

    test('generates compatible Drizzle database', async () => {
      db = openDb(setup.create())
      let proxy = toDrizzle(db)

      await createTable(db, 'posts', 'title TEXT NOT NULL')

      // Test 'run' path
      await proxy('INSERT INTO posts (title) VALUES (?)', ['via proxy'], 'run')

      // Test 'all' path
      let result = await proxy('SELECT * FROM posts', [], 'all')
      equal(result.rows.length, 1)
      deepEqual(result.rows[0], [1, 'via proxy'])

      // Let async cleanup complete
      await setTimeout(50)
    })

    test('closes database', async () => {
      db = openDb(setup.create())
      equal(db.opened, true)
      await db.close()
      equal(db.opened, false)

      // store returns an atom stuck in loading state with no further updates
      let $store = db.store`SELECT 1`
      let storeValues: SqlStoreValue<unknown[]>[] = []
      $store.subscribe(v => storeValues.push(v))
      await setTimeout(50)
      deepEqual(storeValues, [{ isLoading: true }])

      // select returns a promise that never resolves
      let selectResolved = false
      db.select`SELECT 1`
        .then(() => {
          selectResolved = true
        })
        .catch(() => {
          selectResolved = true
        })

      // exec returns a promise that never resolves
      let execResolved = false
      db.exec`INSERT INTO items (title) VALUES (${'test'})`
        .then(() => {
          execResolved = true
        })
        .catch(() => {
          execResolved = true
        })
      await setTimeout(50)
      equal(execResolved, false)
      equal(selectResolved, false)

      // Double call do not throw an error
      await db.close()
      db = undefined
    })
  })
}

describe('node', () => {
  test('takes write lock on immediate transaction start', async () => {
    let dir = await mkdtemp(join(tmpdir(), 'nanostores-sql-'))
    let writer = openDb(nodeDriver(join(dir, 'test.db')))
    let other = openDb(nodeDriver(join(dir, 'test.db')))
    await writer.driver.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)', [])

    async function writeFromOtherConnection(id: number): Promise<string> {
      try {
        await other.exec`INSERT INTO items (id) VALUES (${id})`
        return 'written'
      } catch (e) {
        return (e as Error).message
      }
    }

    // `BEGIN` does not lock anything until the first query
    let deferred = await writer.transaction(() => {
      return writeFromOtherConnection(1)
    })
    equal(deferred, 'written')

    // `BEGIN IMMEDIATE` locks the database right away
    let immediate = await writer.transaction(
      () => writeFromOtherConnection(2),
      { immediate: true }
    )
    match(immediate, /locked/)

    await writer.close()
    await other.close()
    await rm(dir, { force: true, recursive: true })
  })
})
