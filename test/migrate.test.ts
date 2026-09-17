import { deepEqual, equal, throws } from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'

import {
  migrateIfNeeded,
  openDb,
  type Database,
  type MigrationStatusValue
} from '../index.js'
import { nodeDriver } from '../node/index.js'

const STORAGE_KEY = 'nanostores-sql:version'

let storage: Record<string, string> = {}
let storageListeners: ((e: StorageEvent) => void)[] = []
let originalAddEventListener = globalThis.addEventListener
let originalLocalStorage = globalThis.localStorage
let originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value,
    writable: true
  })
}

beforeEach(() => {
  storage = {}
  storageListeners = []

  globalThis.localStorage = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value
    }
  } as Storage

  globalThis.addEventListener = ((event: string, handler: () => void) => {
    if (event === 'storage') {
      storageListeners.push(handler)
    }
  }) as typeof globalThis.addEventListener
})

afterEach(() => {
  globalThis.addEventListener = originalAddEventListener
  globalThis.localStorage = originalLocalStorage
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator)
  }
})

function fireStorageEvent(key: string, newValue: string | null): void {
  let event = { key, newValue } as StorageEvent
  for (let listener of storageListeners) {
    listener(event)
  }
}

let db: Database | undefined

afterEach(async () => {
  await db?.close()
  db = undefined
})

test('runs migration on first load', async () => {
  db = openDb(nodeDriver(':memory:'))
  let migrated = false

  let $status = migrateIfNeeded(db, 1, async prevVersion => {
    equal(prevVersion, -1)
    await db!.driver.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
      []
    )
    migrated = true
  })

  deepEqual($status.value, { applying: true })
  await setTimeout(50)
  deepEqual($status.value, { ready: true })
  equal(migrated, true)
  equal(storage[STORAGE_KEY], '1')
})

test('skips migration when version matches', async () => {
  storage[STORAGE_KEY] = '2'
  db = openDb(nodeDriver(':memory:'))
  let migrated = false

  let $status = migrateIfNeeded(db, 2, () => {
    migrated = true
  })

  deepEqual($status.value, { ready: true })
  await setTimeout(50)
  equal(migrated, false)
})

test('sets outdated and closes db when stored version is newer', () => {
  storage[STORAGE_KEY] = '5'
  db = openDb(nodeDriver(':memory:'))

  let $status = migrateIfNeeded(db, 2, () => {})

  deepEqual($status.value, { outdated: true })
  equal(db.opened, false)
})

test('passes previous version to migration callback', async () => {
  storage[STORAGE_KEY] = '1'
  db = openDb(nodeDriver(':memory:'))
  let receivedVersion: number | undefined

  let $status = migrateIfNeeded(db, 3, prevVersion => {
    receivedVersion = prevVersion
  })

  await setTimeout(50)
  deepEqual($status.value, { ready: true })
  equal(receivedVersion, 1)
  equal(storage[STORAGE_KEY], '3')
})

test('reacts to storage event from another tab', () => {
  storage[STORAGE_KEY] = '1'
  db = openDb(nodeDriver(':memory:'))

  let values: MigrationStatusValue[] = []
  let $status = migrateIfNeeded(db, 1, () => {})
  $status.subscribe(state => {
    values.push(state)
  })

  deepEqual($status.value, { ready: true })

  fireStorageEvent(STORAGE_KEY, '2')
  deepEqual($status.value, { outdated: true })
  equal(db.opened, false)
  db = undefined
})

test('ignores storage events for other keys', () => {
  storage[STORAGE_KEY] = '1'
  db = openDb(nodeDriver(':memory:'))

  let $status = migrateIfNeeded(db, 1, async () => {})
  deepEqual($status.value, { ready: true })

  fireStorageEvent('other-key', '99')
  deepEqual($status.value, { ready: true })
  equal(db.opened, true)
})

test('ignores storage event with same or lower version', () => {
  storage[STORAGE_KEY] = '2'
  db = openDb(nodeDriver(':memory:'))

  let $status = migrateIfNeeded(db, 2, () => {})
  deepEqual($status.value, { ready: true })

  fireStorageEvent(STORAGE_KEY, '1')
  deepEqual($status.value, { ready: true })
  equal(db.opened, true)
})

test('runs incremental migrations', async () => {
  storage[STORAGE_KEY] = '1'
  db = openDb(nodeDriver(':memory:'))
  let steps: number[] = []

  let $status = migrateIfNeeded(db, 3, prevVersion => {
    if (prevVersion < 1) steps.push(1)
    if (prevVersion < 2) steps.push(2)
    if (prevVersion < 3) steps.push(3)
  })

  await setTimeout(50)
  deepEqual($status.value, { ready: true })
  deepEqual(steps, [2, 3])
  equal(storage[STORAGE_KEY], '3')
})

test('reports failed migration', async () => {
  db = openDb(nodeDriver(':memory:'))

  let values: MigrationStatusValue[] = []
  let $status = migrateIfNeeded(db, 1, async () => {
    await db!.exec`CREATE TABLE users (id INTEGER PRIMARY KEY`
  })
  $status.subscribe(state => {
    values.push(state)
  })

  let $users = db.store`SELECT * FROM users`
  $users.subscribe(() => {})

  await setTimeout(50)
  equal(values.length, 2)
  equal('error' in values[1]! && values[1].error instanceof Error, true)
  equal(storage[STORAGE_KEY], undefined)
  // The database stays paused, since its schema is broken
  deepEqual($users.value, { status: 'loading' })
})

test('wraps non-Error migration failures', async () => {
  db = openDb(nodeDriver(':memory:'))
  let $status = migrateIfNeeded(db, 1, () => {
    // oxlint-disable-next-line only-throw-error
    throw 'boom'
  })
  await setTimeout(50)
  let status = $status.get()
  equal('error' in status && status.error.message, 'boom')
})

test('supports version 0', async () => {
  storage[STORAGE_KEY] = '0'
  db = openDb(nodeDriver(':memory:'))
  let migrated = false

  let $status = migrateIfNeeded(db, 0, () => {
    migrated = true
  })

  deepEqual($status.value, { ready: true })
  await setTimeout(50)
  equal(migrated, false)
})

test('applies migration only once between tabs', async () => {
  let queue: Promise<unknown> = Promise.resolve()
  let locked = 0
  setNavigator({
    locks: {
      request(name: string, cb: () => Promise<unknown>) {
        equal(name, STORAGE_KEY)
        locked += 1
        // Web Locks run callbacks one after another
        let result = queue.then(cb)
        queue = result.catch(() => {})
        return result
      }
    }
  })

  db = openDb(nodeDriver(':memory:'))
  let other = openDb(nodeDriver(':memory:'))
  let versions: number[] = []
  let migrate = (prevVersion: number): void => {
    versions.push(prevVersion)
  }

  let $status = migrateIfNeeded(db, 2, migrate)
  let $otherStatus = migrateIfNeeded(other, 2, migrate)
  deepEqual($status.value, { applying: true })
  deepEqual($otherStatus.value, { applying: true })

  await setTimeout(50)
  equal(locked, 2)
  deepEqual(versions, [-1])
  deepEqual($status.value, { ready: true })
  deepEqual($otherStatus.value, { ready: true })
  equal(storage[STORAGE_KEY], '2')

  // A tab with older version, which got the lock after the newer tab
  let old = openDb(nodeDriver(':memory:'))
  storage[STORAGE_KEY] = '1'
  let $oldStatus = migrateIfNeeded(old, 1, () => {})
  deepEqual($oldStatus.value, { ready: true })
  storage[STORAGE_KEY] = '0'
  let $upgrading = migrateIfNeeded(old, 1, () => {
    storage[STORAGE_KEY] = '2'
  })
  await setTimeout(50)
  deepEqual($upgrading.value, { ready: true })

  storage[STORAGE_KEY] = '0'
  let stale = openDb(nodeDriver(':memory:'))
  let $stale = migrateIfNeeded(stale, 1, () => {})
  // Another tab moved the database further while we waited for the lock
  storage[STORAGE_KEY] = '3'
  await setTimeout(50)
  deepEqual($stale.value, { outdated: true })
  equal(stale.opened, false)

  await other.close()
  await old.close()
})

test('throws without localStorage', () => {
  db = openDb(nodeDriver(':memory:'))
  // @ts-expect-error React Native has no localStorage
  delete globalThis.localStorage
  throws(() => {
    migrateIfNeeded(db!, 1, () => {})
  }, /expo-sqlite\/localStorage\/install/)
})

test('works without storage events', async () => {
  // @ts-expect-error React Native has no addEventListener
  delete globalThis.addEventListener
  db = openDb(nodeDriver(':memory:'))
  let $status = migrateIfNeeded(db, 1, () => {})
  await setTimeout(50)
  deepEqual($status.value, { ready: true })
  equal(storage[STORAGE_KEY], '1')
})
