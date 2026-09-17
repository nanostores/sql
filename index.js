import { atom, onMount } from 'nanostores'

function parseQuery(query, params) {
  if ('toSQL' in query) {
    let q = query.toSQL()
    let full = q.sql + JSON.stringify(q.params)
    return [q.sql, q.params, full]
  }
  let sql = query[0]
  let full = query[0]
  for (let i = 0; i < params.length; i++) {
    sql += '?' + query[i + 1]
    full += JSON.stringify(params[i]) + query[i + 1]
  }
  return [sql, params, full]
}

function report(listeners, cause, sql) {
  let error
  if (cause instanceof Error) {
    error = new Error(`${cause.message}\nSQL: ${sql}`, { cause })
  } else {
    error = new Error(`${cause}\nSQL: ${sql}`)
  }
  if (listeners.length === 0) {
    // oxlint-disable-next-line no-console
    console.error(error)
  } else {
    for (let listener of listeners) listener(error)
  }
}

function reportAsync(listeners, promise, sql) {
  promise.catch(error => {
    report(listeners, error, sql)
  })
  return promise
}

export function openDb(rootDriver) {
  let cache = new Map()
  let subscriptions = new Set()
  let mounted = new Set()
  let paused = false
  let listeners = []

  function createTx(rawDriver) {
    let driver = Object.assign(Object.create(rawDriver), {
      exec(query, params) {
        return reportAsync(listeners, rawDriver.exec(query, params), query)
      },
      select(query, params) {
        return reportAsync(listeners, rawDriver.select(query, params), query)
      }
    })
    return {
      driver,
      exec(query, ...rest) {
        let [sql, params] = parseQuery(query, rest)
        return driver.exec(sql, params)
      },
      select(query, ...rest) {
        let [sql, params] = parseQuery(query, rest)
        return driver.select(sql, params)
      }
    }
  }

  let root = createTx(rootDriver)
  let driver = root.driver

  let db = {
    driver,
    opened: true,

    on(event, listener) {
      listeners.push(listener)
      return () => {
        listeners = listeners.filter(i => i !== listener)
      }
    },

    pause() {
      paused = true
      for (let store of mounted) store.stop()
    },

    resume() {
      paused = false
      for (let store of mounted) store.start()
    },

    store(query, ...rest) {
      let [sql, params, cacheKey] = parseQuery(query, rest)
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey)
      } else {
        let $store = atom({ status: 'loading' })
        let resolveLoading
        $store.loading = new Promise(resolve => {
          resolveLoading = resolve
        })
        if (!db.opened) return $store
        let currentJSON
        let subscribed = false
        onMount($store, () => {
          subscribed = true
          let unsubscribe
          let store = {
            start() {
              if (unsubscribe) return
              try {
                unsubscribe = driver.subscribe(
                  sql,
                  params,
                  rows => {
                    if (!subscribed) return
                    resolveLoading()
                    let prevJSON = currentJSON
                    currentJSON = JSON.stringify(rows)
                    if (!$store.value || prevJSON !== currentJSON) {
                      $store.set({ status: 'ready', value: rows })
                    }
                  },
                  e => {
                    report(listeners, e, sql)
                  }
                )
              } catch (e) {
                report(listeners, e, sql)
                return
              }
              subscriptions.add(unsubscribe)
            },
            stop() {
              if (!unsubscribe) return
              subscriptions.delete(unsubscribe)
              unsubscribe()
              unsubscribe = undefined
            }
          }
          mounted.add(store)
          if (!paused) store.start()
          return () => {
            cache.delete(cacheKey)
            subscribed = false
            currentJSON = undefined
            mounted.delete(store)
            store.stop()
          }
        })
        cache.set(cacheKey, $store)
        return $store
      }
    },

    exec(query, ...rest) {
      if (!db.opened) return new Promise(() => {})
      return root.exec(query, ...rest)
    },

    select(query, ...rest) {
      if (!db.opened) return new Promise(() => {})
      return root.select(query, ...rest)
    },

    transaction(callback, opts) {
      if (!db.opened) return new Promise(() => {})
      return driver.transaction(tx => callback(createTx(tx)), opts)
    },

    async close() {
      if (!db.opened) return
      for (let unsubscribe of subscriptions) await unsubscribe()
      db.opened = false
      await rootDriver.close()
    }
  }
  return db
}

export function toDrizzle(db) {
  return async (sql, params, method) => {
    if (method === 'run') {
      await db.driver.exec(sql, params)
      return { rows: [] }
    }
    let rows = await db.driver.select(sql, params)
    rows = rows.map(row => Object.values(row))
    // Drizzle expects a single row (not a list of rows) for `get()`
    return { rows: method === 'get' ? rows[0] : rows }
  }
}

const STORAGE_KEY = 'nanostores-sql:version'

function readVersion() {
  let stored = parseInt(localStorage.getItem(STORAGE_KEY))
  return isNaN(stored) ? -1 : stored
}

export function migrateIfNeeded(db, version, migrate) {
  if (typeof localStorage === 'undefined') {
    throw new Error(
      'migrateIfNeeded() needs localStorage. ' +
        'In Expo import "expo-sqlite/localStorage/install" first.'
    )
  }

  let $status = atom({ applying: true })

  function outdated() {
    $status.set({ outdated: true })
    db.close()
  }

  let prevVersion = readVersion()
  if (prevVersion > version) {
    outdated()
  } else if (prevVersion === version) {
    $status.set({ ready: true })
  } else {
    db.pause()
    let run = async () => {
      // Another tab could apply the migration while we waited for the lock
      let current = readVersion()
      if (current < version) {
        await migrate(current)
        localStorage.setItem(STORAGE_KEY, String(version))
      }
      return current
    }
    let locks = typeof navigator !== 'undefined' && navigator.locks
    let done = locks ? locks.request(STORAGE_KEY, run) : run()
    done.then(
      current => {
        if (current > version) {
          outdated()
        } else {
          $status.set({ ready: true })
          db.resume()
        }
      },
      e => {
        $status.set({ error: e instanceof Error ? e : new Error(String(e)) })
      }
    )
  }

  if (typeof addEventListener === 'function') {
    addEventListener('storage', e => {
      if (e.key === STORAGE_KEY) {
        let newVersion = parseInt(e.newValue) || -1
        if (newVersion > version) outdated()
      }
    })
  }

  return $status
}
