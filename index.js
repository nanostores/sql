import { atom, onMount } from 'nanostores'

function parseQuery(query, params) {
  if ('toSQL' in query) {
    let q = query.toSQL()
    return [q.sql, q.params]
  }
  let sql = query[0]
  for (let i = 0; i < params.length; i++) {
    sql += '?' + query[i + 1]
  }
  return [sql, params]
}

export function openDb(driver) {
  function createDb(d) {
    let db = {
      opened: true,
      driver,

      store(query, ...params) {
        let [sql, p] = parseQuery(query, params)
        let $store = atom({ isLoading: true })
        if (!db.opened) return $store
        let currentJSON
        onMount($store, () => {
          return d.subscribe(sql, p, rows => {
            let prevJSON = currentJSON
            currentJSON = JSON.stringify(rows)
            if (!$store.value || prevJSON !== currentJSON) {
              $store.set({ isLoading: false, value: rows })
            }
          })
        })
        return $store
      },

      exec(query, ...params) {
        if (!db.opened) return new Promise(() => {})
        let [sql, p] = parseQuery(query, params)
        return d.exec(sql, p)
      },

      transaction(callback) {
        if (!db.opened) return new Promise(() => {})
        return driver.transaction(tx => callback(createDb(tx)))
      },

      close() {
        if (!db.opened) return Promise.resolve()
        db.opened = false
        return driver.close()
      }
    }
    return db
  }

  return createDb(driver)
}

export function toDrizzle(db) {
  return async (sql, params, method) => {
    if (method === 'run') {
      await db.driver.exec(sql, params)
      return { rows: [] }
    }
    return new Promise(resolve => {
      let unsub
      let done = false
      unsub = db.driver.subscribe(sql, params, rows => {
        done = true
        resolve({ rows: rows.map(row => Object.values(row)) })
        if (unsub) unsub()
      })
      if (done) unsub()
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
