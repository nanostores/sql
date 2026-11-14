import { cleanStores } from 'nanostores'
import { deepEqual, equal, rejects, throws } from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { MessageChannel, type MessagePort } from 'node:worker_threads'

import { type Database, openDb, type SqlStore } from '../index.js'
import type { WasmWorkerOptions } from '../wasm-worker/index.js'
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

let lastShared = 0

function sharedName(): string {
  return `shared-test-${++lastShared}`
}

interface Tab {
  db: Database<ReturnType<typeof wasmDriver>>
  errors: string[]
  ready: Promise<void>
}

function tab(
  opts: WasmWorkerOptions,
  open: Parameters<typeof wasmWorker>[0] = sqlite3 =>
    new sqlite3.oo1.DB(':memory:')
): Tab {
  let { port1, port2 } = new MessageChannel()
  ports.push(port1, port2)
  let ready = wasmWorker(open, { ...opts, port: port2 })
  let db = openDb(wasmDriver(port1))
  let errors: string[] = []
  db.on('error', e => {
    errors.push(e.message.split('\n')[0]!)
  })
  return { db, errors, ready }
}

function sharedTab(
  shared: string,
  opts: Omit<WasmWorkerOptions, 'shared'> = {},
  open?: Parameters<typeof wasmWorker>[0]
): Tab {
  let created = tab({ ...opts, shared }, open)
  dbs.push(created.db)
  return created
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await setTimeout(10)
  }
  throw new Error('Timeout')
}

function rows<Value>($store: SqlStore<Value[]>): Value[] {
  let state = $store.get()
  return state.status === 'ready' ? state.value : []
}

function stall(): { release: () => void; stalled: Promise<void> } {
  let release!: () => void
  let stalled = new Promise<void>(resolve => {
    release = resolve
  })
  return { release, stalled }
}

function settled(promise: Promise<unknown>): () => boolean {
  let done = false
  promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    }
  )
  return () => done
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

  test('shares database between tabs', async () => {
    let shared = sharedName()
    let leader = sharedTab(shared)
    let follower = sharedTab(shared)
    // Follower queues queries until the leader will accept it
    let creating = follower.db.exec`CREATE TABLE a (x)`
    await Promise.all([leader.ready, follower.ready, creating])

    let $leader = leader.db.store<{ x: number }>`SELECT x FROM a`
    let $follower = follower.db.store<{ x: number }>`SELECT x FROM a`
    let unbindLeader = $leader.listen(() => {})
    let unbindFollower = $follower.listen(() => {})
    await Promise.all([$leader.loading, $follower.loading])

    await leader.db.exec`INSERT INTO a (x) VALUES (1)`
    await waitFor(() => rows($follower).length === 1)
    await follower.db.exec`INSERT INTO a (x) VALUES (2)`
    await waitFor(() => rows($leader).length === 2)
    deepEqual(await follower.db.select`SELECT x FROM a`, [{ x: 1 }, { x: 2 }])
    equal(await follower.db.driver.persistent(), false)

    unbindLeader()
    unbindFollower()
  })

  test('does not mix clients with the same numbers', async () => {
    let shared = sharedName()
    let first = sharedTab(shared)
    let second = sharedTab(shared)
    await first.db.exec`CREATE TABLE a (x)`
    await second.db.exec`CREATE TABLE b (y)`

    let $a = first.db.store<{ x: number }>`SELECT x FROM a`
    let $b = second.db.store<{ y: number }>`SELECT y FROM b`
    let unbindA = $a.listen(() => {})
    let unbindB = $b.listen(() => {})
    await Promise.all([$a.loading, $b.loading])

    let { release, stalled } = stall()
    let firstTx = first.db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (1)`
      await stalled
      throw new Error('cancel')
    })
    await setTimeout(10)
    let secondTx = second.db.transaction(async tx => {
      await tx.exec`INSERT INTO b (y) VALUES (1)`
    })
    let secondDone = settled(secondTx)
    await setTimeout(20)
    equal(secondDone(), false)

    release()
    await rejects(firstTx, /cancel/)
    await secondTx
    await waitFor(() => rows($b).length === 1)
    deepEqual(rows($a), [])
    deepEqual(await second.db.select`SELECT * FROM a`, [])

    unbindA()
    unbindB()
  })

  test('rolls back transaction of closed follower', async () => {
    let shared = sharedName()
    let leader = sharedTab(shared)
    let follower = tab({ shared })
    await follower.db.exec`CREATE TABLE a (x)`
    let { stalled } = stall()
    void follower.db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (1)`
      await stalled
    })
    await setTimeout(10)
    let waiting = leader.db.select`SELECT count(*) AS total FROM a`
    await follower.db.close()
    deepEqual(await waiting, [{ total: 0 }])
    await leader.db.exec`INSERT INTO a (x) VALUES (2)`
  })

  test('closes follower before connection', async () => {
    let shared = sharedName()
    let leader = sharedTab(shared)
    let follower = tab({ shared })
    let selecting = follower.db.select`SELECT 1 AS one`
    let selected = settled(selecting)
    await follower.db.close()
    equal(selected(), true)
    deepEqual(await selecting, [{ one: 1 }])
    await leader.db.exec`CREATE TABLE a (x)`
    deepEqual(await leader.db.select`SELECT * FROM a`, [])
  })

  test('waits for answers before closing follower', async () => {
    let shared = sharedName()
    let leader = sharedTab(shared)
    let follower = tab({ shared })
    await leader.db.exec`CREATE TABLE a (x)`
    let { release, stalled } = stall()
    let leaderTx = leader.db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (1)`
      await stalled
    })
    await setTimeout(10)
    let writing = follower.db.exec`INSERT INTO a (x) VALUES (2)`
    let written = settled(writing)
    let closed = settled(follower.db.close())
    await setTimeout(20)
    equal(closed(), false)

    release()
    await Promise.all([leaderTx, writing])
    await waitFor(closed)
    equal(written(), true)
    deepEqual(await leader.db.select`SELECT x FROM a`, [{ x: 1 }, { x: 2 }])
  })

  test('closes follower, which became the leader', async () => {
    let shared = sharedName()
    let file = `/${shared}.sqlite`
    let open: Parameters<typeof wasmWorker>[0] = sqlite3 =>
      new sqlite3.oo1.DB(file)
    let leader = tab({ shared, transactionTimeout: 50 }, open)
    let follower = tab({ shared }, open)
    let other = sharedTab(shared, {}, open)
    await leader.db.exec`CREATE TABLE a (x)`
    let { stalled } = stall()
    void leader.db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (1)`
      await stalled
    })
    await setTimeout(10)
    let leaderClosed = leader.db.close()
    let writing = follower.db.exec`INSERT INTO a (x) VALUES (2)`
    let closed = follower.db.close()
    await leaderClosed
    await Promise.all([writing, closed])
    deepEqual(await other.db.select`SELECT x FROM a`, [{ x: 2 }])
  })

  test('rolls back stalled transaction', async () => {
    let shared = sharedName()
    let leader = sharedTab(shared, { transactionTimeout: 50 })
    let follower = sharedTab(shared)
    await leader.db.exec`CREATE TABLE a (x)`

    let statement = stall()
    let statementTx = leader.db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (1)`
      await statement.stalled
      await tx.exec`INSERT INTO a (x) VALUES (2)`
    })
    await setTimeout(10)
    let started = Date.now()
    deepEqual(await follower.db.select`SELECT count(*) AS total FROM a`, [
      { total: 0 }
    ])
    let waited = Date.now() - started
    equal(waited >= 30, true)
    statement.release()
    await rejects(statementTx, /^Error: SQLITE_BUSY: transaction was rolled/)

    let commit = stall()
    let commitTx = leader.db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (3)`
      await commit.stalled
    })
    await setTimeout(10)
    await follower.db.select`SELECT 1`
    commit.release()
    await rejects(commitTx, /^Error: SQLITE_BUSY/)

    await leader.db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (4)`
    })
    deepEqual(await follower.db.select`SELECT x FROM a`, [{ x: 4 }])
  })

  test('rolls back stalled transaction without shared', async () => {
    let { db } = tab({ transactionTimeout: 20 })
    dbs.push(db)
    await db.exec`CREATE TABLE a (x)`
    await rejects(
      db.transaction(async tx => {
        await tx.exec`INSERT INTO a (x) VALUES (1)`
        await db.select`SELECT 1`
        await tx.exec`INSERT INTO a (x) VALUES (2)`
      }),
      /SQLITE_BUSY/
    )
    deepEqual(await db.select`SELECT * FROM a`, [])
  })

  test('does not roll back transaction if nobody waits', async () => {
    let shared = sharedName()
    let leader = sharedTab(shared, { transactionTimeout: 20 })
    sharedTab(shared)
    await leader.db.exec`CREATE TABLE a (x)`
    await leader.db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (1)`
      await setTimeout(50)
      await tx.exec`INSERT INTO a (x) VALUES (2)`
    })
    deepEqual(await leader.db.select`SELECT count(*) AS total FROM a`, [
      { total: 2 }
    ])
  })

  test('moves database to the next tab', async () => {
    let shared = sharedName()
    let file = `/${shared}.sqlite`
    let open: Parameters<typeof wasmWorker>[0] = sqlite3 =>
      new sqlite3.oo1.DB(file)
    let leader = tab({ shared, transactionTimeout: 50 }, open)
    let next = sharedTab(shared, { transactionTimeout: 50 }, open)
    let follower = sharedTab(shared, { transactionTimeout: 50 }, open)
    await follower.db.exec`CREATE TABLE a (x)`

    let $next = next.db.store<{ x: number }>`SELECT x FROM a`
    let $follower = follower.db.store<{ x: number }>`SELECT x FROM a`
    let unbindNext = $next.listen(() => {})
    let unbindFollower = $follower.listen(() => {})
    await Promise.all([$next.loading, $follower.loading])

    let { release, stalled } = stall()
    let lostTx = follower.db.transaction(async tx => {
      await tx.exec`INSERT INTO a (x) VALUES (1)`
      await stalled
      await tx.exec`INSERT INTO a (x) VALUES (2)`
    })
    await setTimeout(10)
    let closing = leader.db.close()
    let waiting = next.db.exec`INSERT INTO a (x) VALUES (3)`
    await closing

    await waiting
    release()
    await rejects(lostTx, /^Error: SQLITE_BUSY: transaction was lost/)
    await follower.db.exec`INSERT INTO a (x) VALUES (4)`
    await waitFor(() => rows($next).length === 2)
    await waitFor(() => rows($follower).length === 2)
    deepEqual(await follower.db.select`SELECT x FROM a`, [{ x: 3 }, { x: 4 }])

    unbindNext()
    unbindFollower()
  })

  test('fails transaction of the next leader', async () => {
    let shared = sharedName()
    let leader = tab({ shared, transactionTimeout: 50 })
    let next = sharedTab(shared)
    await next.db.exec`SELECT 1`
    let { release, stalled } = stall()
    let lostTx = next.db.transaction(async tx => {
      await tx.exec`SELECT 1`
      await stalled
      await tx.exec`SELECT 2`
    })
    await setTimeout(10)
    await leader.db.close()
    await setTimeout(10)
    release()
    await rejects(lostTx, /^Error: SQLITE_BUSY: transaction was lost/)
    deepEqual(await next.db.select`SELECT 1 AS one`, [{ one: 1 }])
  })

  test('retries opening of locked database', async () => {
    let calls = 0
    let { db, ready } = tab({ shared: sharedName() }, sqlite3 => {
      calls += 1
      if (calls === 1) throw new Error('SQLITE_BUSY: locked')
      if (calls === 2) throw new Error('InvalidStateError: locked')
      return new sqlite3.oo1.DB(':memory:')
    })
    dbs.push(db)
    await ready
    equal(calls, 3)
    deepEqual(await db.select`SELECT 1 AS one`, [{ one: 1 }])
  })

  test('stops retrying to open locked database', async () => {
    let now = Date.now
    let calls = 0
    let { ready } = tab({ shared: sharedName() }, () => {
      calls += 1
      if (calls === 2) Date.now = () => now() + 10_000
      throw new Error('NoModificationAllowedError: locked')
    })
    await rejects(ready, /NoModificationAllowedError/)
    Date.now = now
    equal(calls, 2)
  })

  test('gives database to the next tab on opening error', async () => {
    let shared = sharedName()
    let broken = tab({ shared }, () => {
      throw new Error('test')
    })
    let next = sharedTab(shared)
    await rejects(broken.ready, /test/)
    await rejects(broken.db.select`SELECT 1`, /test/)
    await next.ready
    deepEqual(await next.db.select`SELECT 1 AS one`, [{ one: 1 }])
  })

  test('exports database from another tab', async () => {
    let shared = sharedName()
    let leader = sharedTab(shared)
    let follower = sharedTab(shared)
    await leader.db.exec`CREATE TABLE a (x)`
    let file = await follower.db.driver.export()
    equal(file instanceof Uint8Array, true)
    equal(new TextDecoder().decode(file.slice(0, 15)), 'SQLite format 3')
  })

  test('works without Web Locks', async () => {
    let descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')!
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {}
    })
    try {
      let first = sharedTab(sharedName())
      let second = sharedTab(sharedName())
      await first.db.exec`CREATE TABLE a (x)`
      await second.db.exec`CREATE TABLE a (x)`
    } finally {
      Object.defineProperty(globalThis, 'navigator', descriptor)
    }
  })

  test('does not allow shared with channel', () => {
    let { port2 } = new MessageChannel()
    ports.push(port2)
    throws(() => {
      void wasmWorker(sqlite3 => new sqlite3.oo1.DB(':memory:'), {
        channel: 'a',
        port: port2,
        shared: 'a'
      })
    }, /only one/)
  })
})
