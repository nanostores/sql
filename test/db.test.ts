import { eq } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { STORE_UNMOUNT_DELAY } from 'nanostores'
import { deepEqual, equal, match, notEqual } from 'node:assert/strict'
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

    test('store returns reactive atom', async () => {
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
      await setTimeout(50)
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

    test('transaction commits', async () => {
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

      // node.js has limited transaction support
      if (driverName !== 'node') {
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
      }

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

      // node.js has limited transaction support
      if (driverName !== 'node') {
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
      }
    })

    test('prevents SQL injection', async () => {
      db = openDb(setup.create())

      await createTable(db, 'secrets', 'data TEXT')
      await db.exec`INSERT INTO secrets (data) VALUES (${'top-secret'})`

      // Attempt injection via a parameterized value
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

      // Test SQL injection in exec — the injected string is treated as a value, not SQL
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

    test('unsubscribe stops updates', async () => {
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
    })

    test('supports Drizzle in store', async () => {
      db = openDb(setup.create())
      let drizzleDb = drizzle(toDrizzle(db))

      await createTable(db, 'posts', 'title TEXT NOT NULL')
      await db.exec`INSERT INTO posts (title) VALUES (${'hello'})`

      let rows = await new Promise<unknown>(resolve => {
        let $posts = db!.store(
          drizzleDb
            .select()
            .from(postsTable)
            .where(eq(postsTable.title, 'hello'))
        )
        $posts.subscribe(state => {
          if (!state.isLoading) resolve(state.value)
        })
      })

      deepEqual(rows, [{ id: 1, title: 'hello' }])
    })

    test('supports Drizzle in exec', async () => {
      db = openDb(setup.create())
      let drizzleDb = drizzle(toDrizzle(db))

      await createTable(db, 'posts', 'title TEXT NOT NULL')
      await db.exec`INSERT INTO posts (title) VALUES (${'old'})`
      await db.exec(
        drizzleDb
          .update(postsTable)
          .set({ title: 'updated' })
          .where(eq(postsTable.id, 1))
      )

      let rows = await new Promise<unknown>(resolve => {
        let $posts = db!.store`SELECT * FROM posts`
        $posts.subscribe(state => {
          if ('value' in state) resolve(state.value)
        })
      })

      deepEqual(rows, [{ id: 1, title: 'updated' }])
    })

    test('toDrizzle executes queries', async () => {
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

      // Double call do not throw an error
      await db.close()
      db = undefined
    })
  })
}
