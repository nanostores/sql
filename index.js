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

function printError(error) {
  // oxlint-disable-next-line no-console
  console.error(error)
}

function toError(error, sql) {
  if (error instanceof Error) {
    return new Error(`${error.message}\nSQL: ${sql}`, { cause: error })
  } else {
    return new Error(`${error}\nSQL: ${sql}`)
  }
}

export function openDb(rootDriver) {
  let cache = new Map()
  let subscriptions = new Set()
  let mounted = new Set()
  let paused = false
  let listeners = []

  function report(error) {
    if (listeners.length === 0) {
      printError(error)
    } else {
      for (let listener of listeners) listener(error)
    }
  }

  function reportError(promise, sql) {
    promise.catch(error => {
      report(toError(error, sql))
    })
    return promise
  }

  function createDb(rawDriver) {
    let driver = Object.assign(Object.create(rawDriver), {
      exec(query, params) {
        return reportError(rawDriver.exec(query, params), query)
      },
      select(query, params) {
        return reportError(rawDriver.select(query, params), query)
      }
    })
    let db = {
      opened: true,
      driver,

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
          let $store = atom({ isLoading: true })
          let resolveLoading
          $store.loading = new Promise(resolve => {
            resolveLoading = resolve
          })
          if (!db.opened) return $store
          let currentJSON
          let subscribed = false
          function fail(error) {
            report(toError(error, sql))
          }
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
                        $store.set({ isLoading: false, value: rows })
                      }
                    },
                    fail
                  )
                } catch (e) {
                  fail(e)
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
        let [sql, params] = parseQuery(query, rest)
        return driver.exec(sql, params)
      },

      select(query, ...rest) {
        if (!db.opened) return new Promise(() => {})
        let [sql, params] = parseQuery(query, rest)
        return driver.select(sql, params)
      },

      transaction(callback, opts) {
        if (!db.opened) return new Promise(() => {})
        return driver.transaction(tx => callback(createDb(tx)), opts)
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

  return createDb(rootDriver)
}

export function toDrizzle(db) {
  return async (sql, params, method) => {
    if (method === 'run') {
      await db.driver.exec(sql, params)
      return { rows: [] }
    }
    let rows = await db.driver.select(sql, params)
    return { rows: rows.map(row => Object.values(row)) }
  }
}

const STORAGE_KEY = 'nanostores-sql:version'

export function migrateIfNeeded(db, version, migrate) {
  let $status = atom({ applying: true })

  let prevVersion = parseInt(localStorage.getItem(STORAGE_KEY)) || -1

  if (prevVersion > version) {
    $status.set({ outdated: true })
    db.close()
  } else if (prevVersion === version) {
    $status.set({ ready: true })
  } else {
    db.pause()
    void Promise.resolve(migrate(prevVersion)).then(() => {
      localStorage.setItem(STORAGE_KEY, String(version))
      $status.set({ ready: true })
      db.resume()
    })
  }

  addEventListener('storage', e => {
    if (e.key === STORAGE_KEY) {
      let newVersion = parseInt(e.newValue) || -1
      if (newVersion > version) {
        $status.set({ outdated: true })
        db.close()
      }
    }
  })

  return $status
}
