import { cleanStores } from 'nanostores'
import { deepEqual, equal, rejects } from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { MessageChannel, type MessagePort } from 'node:worker_threads'

import { type Database, openDb } from '../index.js'
import { wasmWorker } from '../wasm-worker/index.js'
import { wasmDriver } from '../wasm/index.js'

let ports: MessagePort[] = []
let dbs: Database[] = []

afterEach(async () => {
  await Promise.all(dbs.map(db => db.close()))
  for (let port of ports) port.close()
  ports = []
  dbs = []
})

function setup(
  filename = ':memory:',
  channel?: string
): {
  db: Database<ReturnType<typeof wasmDriver>>
  errors: string[]
  page: MessagePort
  updates: unknown[]
  worker: MessagePort
} {
  let { port1, port2 } = new MessageChannel()
  ports.push(port1, port2)
  void wasmWorker(sqlite3 => new sqlite3.oo1.DB(filename), {
    channel,
    port: port2
  })
  let updates: unknown[] = []
  port1.addEventListener('message', ({ data }) => {
    if (data.type === 'sql:updated') updates.push(data)
  })
  let db = openDb(wasmDriver(port1))
  dbs.push(db)
  let errors: string[] = []
  db.on('error', e => {
    errors.push(e.message.split('\n')[0]!)
  })
  return { db, errors, page: port1, updates, worker: port2 }
}

describe('wasm', () => {
  test('updates only stores with changed results', async () => {
    let { db, updates } = setup()
    await db.exec`CREATE TABLE a (x)`
    await db.exec`CREATE TABLE b (y)`
    let $list = db.store<{ x: number }>`SELECT x FROM a ORDER BY x`
    let $count = db.store<{ total: number }>`SELECT count(*) AS total FROM a`
    let unbindList = $list.listen(() => {})
    let unbindCount = $count.listen(() => {})
    await Promise.all([$list.loading, $count.loading])

    await db.exec`INSERT INTO a (x) VALUES (1)`
    deepEqual($list.get(), { status: 'ready', value: [{ x: 1 }] })
    deepEqual($count.get(), { status: 'ready', value: [{ total: 1 }] })

    updates.length = 0
    await db.exec`INSERT INTO b (y) VALUES (1)`
    await db.exec`UPDATE a SET x = x`
    await db.exec`UPDATE a SET x = 2 WHERE x = 5`
    deepEqual(updates, [])

    await db.exec`DELETE FROM a`
    deepEqual($count.get(), { status: 'ready', value: [{ total: 0 }] })
    equal(updates.length, 1)

    unbindList()
    unbindCount()
    cleanStores($list, $count)
    await db.exec`INSERT INTO a (x) VALUES (1)`
    equal(updates.length, 1)
  })

  test('waits for transaction end', async () => {
    let { db, updates } = setup()
    await db.exec`CREATE TABLE a (x)`
    let $list = db.store<{ x: number }>`SELECT x FROM a`
    let unbind = $list.listen(() => {})
    await $list.loading
    updates.length = 0

    let outside: Promise<unknown> | undefined
    await db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (1)`
      outside = db.select`SELECT count(*) AS total FROM a`
      await tx.exec`INSERT INTO a (x) VALUES (2)`
      equal(updates.length, 0)
    })
    deepEqual(await outside, [{ total: 2 }])
    equal(updates.length, 1)
    unbind()
  })

  test('reports transaction errors', async () => {
    let { db } = setup()
    await db.exec`CREATE TABLE a (x)`
    await rejects(
      db.transaction(async tx => {
        await tx.exec`INSERT INTO a (x) VALUES (1)`
        await tx.exec`ROLLBACK`
        throw new Error('already')
      }),
      /already/
    )

    await db.exec`BEGIN`
    await rejects(
      db.transaction(async () => {}),
      /cannot start a transaction within a transaction/
    )
    await db.exec`ROLLBACK`

    await db.exec`PRAGMA foreign_keys = ON`
    await db.exec`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
    await db.exec`CREATE TABLE child
      (parent REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
    await rejects(
      db.transaction(async tx => {
        await tx.exec`INSERT INTO child (parent) VALUES (1)`
      }),
      /FOREIGN KEY constraint failed/
    )
    deepEqual(await db.select`SELECT * FROM a UNION SELECT * FROM child`, [])
  })

  test('reports store errors', async () => {
    let { db, errors } = setup()
    let $missing = db.store`SELECT * FROM missing`
    let unbindMissing = $missing.listen(() => {})
    await db.exec`CREATE TABLE removed (x)`
    let $removed = db.store`SELECT * FROM removed`
    let unbindRemoved = $removed.listen(() => {})
    await $removed.loading
    await db.exec`DROP TABLE removed`
    await db.exec`CREATE TABLE altered (x)`
    let $altered = db.store`SELECT * FROM altered`
    let unbindAltered = $altered.listen(() => {})
    await $altered.loading
    await db.exec`ALTER TABLE altered RENAME TO renamed`
    deepEqual(
      errors.map(i => i.replace(/.*: /, '')),
      ['missing', 'removed', 'altered']
    )
    unbindMissing()
    unbindRemoved()
    unbindAltered()

    let calls = 0
    let increase = (): void => {
      calls += 1
    }
    db.driver.subscribe('SELECT 1', [], increase, increase)()
    let unsubscribe = db.driver.subscribe(
      'SELECT * FROM missing',
      [],
      increase,
      increase
    )
    unsubscribe()
    unsubscribe()
    await db.select`SELECT 1`
    equal(calls, 0)
  })

  test('updates stores in other tabs', async () => {
    let first = setup('/tabs.sqlite', 'wasm-test')
    let second = setup('/tabs.sqlite', 'wasm-test')
    await first.db.exec`CREATE TABLE a (x)`
    let $list = second.db.store<{ x: number }>`SELECT x FROM a`
    let unbind = $list.listen(() => {})
    await $list.loading

    await first.db.exec`INSERT INTO a (x) VALUES (1)`
    await setTimeout(50)
    equal(second.updates.length, 2)
    unbind()
  })

  test('reports opening errors', async () => {
    let { port1, port2 } = new MessageChannel()
    ports.push(port1, port2)
    let opening = wasmWorker(
      () => {
        throw new Error('test')
      },
      { port: port2 }
    )
    let driver = wasmDriver(port1)
    await rejects(opening, /test/)
    await rejects(driver.select('SELECT 1', []), /test/)
    let error = await new Promise(resolve => {
      driver.subscribe('SELECT 1', [], () => {}, resolve)()
      driver.subscribe('SELECT 1', [], () => {}, resolve)
    })
    equal(String(error), 'Error: Error: test')
  })

  test('ignores app messages', async () => {
    let { db, page, worker } = setup()
    page.postMessage({ type: 'app' })
    worker.postMessage({ type: 'app' })
    page.postMessage(null)
    deepEqual(await db.select`SELECT 1 AS one`, [{ one: 1 }])
  })

  test('detects in-memory database', async () => {
    let { db } = setup()
    equal(await db.driver.persistent(), false)

    let { port1, port2 } = new MessageChannel()
    ports.push(port1, port2)
    void wasmWorker(sqlite3 => new sqlite3.oo1.DB('/file.sqlite'), {
      port: port2
    })
    let file = wasmDriver(port1)
    equal(await file.persistent(), true)
    await file.close()
  })

  test('listens worker scope by default', async () => {
    let { port1, port2 } = new MessageChannel()
    ports.push(port1, port2)
    Object.assign(globalThis, {
      addEventListener: port2.addEventListener.bind(port2),
      postMessage: port2.postMessage.bind(port2)
    })
    void wasmWorker(sqlite3 => new sqlite3.oo1.DB(':memory:'))
    port2.start()
    let db = openDb(wasmDriver(port1))
    deepEqual(await db.select`SELECT 1 AS one`, [{ one: 1 }])
    await db.close()
    Reflect.deleteProperty(globalThis, 'addEventListener')
    Reflect.deleteProperty(globalThis, 'postMessage')
  })

  test('terminates worker on closing', async () => {
    let { port1, port2 } = new MessageChannel()
    ports.push(port1, port2)
    void wasmWorker(sqlite3 => new sqlite3.oo1.DB(':memory:'), { port: port2 })
    let terminated = false
    let driver = wasmDriver({
      addEventListener: port1.addEventListener.bind(port1),
      postMessage: port1.postMessage.bind(port1),
      terminate() {
        terminated = true
      }
    })
    port1.start()
    await driver.close()
    equal(terminated, true)
  })
})
