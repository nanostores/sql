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

export function openDb(rootDriver) {
  let cache = new Map()
  let subscriptions = new Set()

  function createDb(driver) {
    let db = {
      opened: true,
      driver,

      store(query, ...rest) {
        let [sql, params, cacheKey] = parseQuery(query, rest)
        if (cache.has(cacheKey)) {
          return cache.get(cacheKey)
        } else {
          let $store = atom({ isLoading: true })
          if (!db.opened) return $store
          let currentJSON
          let subscribed = false
          onMount($store, () => {
            $store.set({ isLoading: true })
            subscribed = true
            let unsubscribe = driver.subscribe(sql, params, rows => {
              if (!subscribed) return
              let prevJSON = currentJSON
              currentJSON = JSON.stringify(rows)
              if (!$store.value || prevJSON !== currentJSON) {
                $store.set({ isLoading: false, value: rows })
              }
            })
            subscriptions.add(unsubscribe)
            return () => {
              cache.delete(cacheKey)
              subscribed = false
              currentJSON = undefined
              subscriptions.add(unsubscribe)
              unsubscribe()
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

      transaction(callback) {
        if (!db.opened) return new Promise(() => {})
        return driver.transaction(tx => callback(createDb(tx)))
      },

      async close() {
        if (!db.opened) return
        for (let unsubscribe of subscriptions) await unsubscribe()
        db.opened = false
        return rootDriver.close()
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
    return new Promise(resolve => {
      let done = false
      let unsubscribe
      unsubscribe = db.driver.subscribe(sql, params, rows => {
        done = true
        resolve({ rows: rows.map(row => Object.values(row)) })
        if (unsubscribe) unsubscribe()
      })
      if (done) unsubscribe()
    })
  }
}

const STORAGE_KEY = 'nanostores-sql:version'

/* node:coverage disable */
export function migrateIfNeeded(db, version, migrate) {
  let $status = atom({ applying: true })

  let prevVersion = parseInt(localStorage.getItem(STORAGE_KEY)) || -1

  if (prevVersion > version) {
    $status.set({ outdated: true })
    db.close()
  } else if (prevVersion === version) {
    $status.set({ ready: true })
  } else {
    void Promise.resolve(migrate(prevVersion)).then(() => {
      localStorage.setItem(STORAGE_KEY, String(version))
      $status.set({ ready: true })
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
/* node:coverage enable */
