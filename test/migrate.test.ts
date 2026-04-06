import { deepEqual, equal } from 'node:assert/strict'
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
      storageListeners.push(handler as (e: StorageEvent) => void)
    }
  }) as typeof globalThis.addEventListener
})

afterEach(() => {
  globalThis.addEventListener = originalAddEventListener
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
