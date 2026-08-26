import { DatabaseSync } from 'node:sqlite'

function toRows(rows) {
  return rows.map(row => ({ ...row }))
}

export function nodeDriver(filename) {
  let db = new DatabaseSync(filename)
  let subscribers = new Map()
  let nextId = 0

  let changesQuery = db.prepare(
    `SELECT total_changes() AS "rows",` +
      ` (SELECT "schema_version" FROM pragma_schema_version()) AS "schema"`
  )
  let last = changesQuery.get()

  function hasChanges() {
    let current = changesQuery.get()
    if (current.rows === last.rows && current.schema === last.schema) {
      return false
    }
    last = current
    return true
  }

  function runSubscriber(sub) {
    try {
      sub.cb(toRows(db.prepare(sub.query).all(...sub.params)))
    } catch (e) {
      sub.onError(e)
    }
  }

  function notifySubscribers() {
    for (let [, sub] of subscribers) runSubscriber(sub)
  }

  let driver = {
    subscribe(query, params, cb, onError) {
      let id = nextId++
      subscribers.set(id, { cb, onError, params, query })
      // Emulate async for better compatibility
      void Promise.resolve().then(() => {
        let sub = subscribers.get(id)
        if (sub) runSubscriber(sub)
      })
      return () => {
        subscribers.delete(id)
      }
    },

    exec(query, params) {
      return new Promise(resolve => {
        let result = db.prepare(query).run(...params)
        if (hasChanges()) notifySubscribers()
        resolve(result)
      })
    },

    select(query, params) {
      return new Promise(resolve => {
        // `select()` is also the only way to read `RETURNING` of a write
        let rows = toRows(db.prepare(query).all(...params))
        if (hasChanges()) notifySubscribers()
        resolve(rows)
      })
    },

    async transaction(callback, opts = {}) {
      db.exec(opts.immediate ? 'BEGIN IMMEDIATE' : 'BEGIN')
      let result
      try {
        let tx = {
          subscribe: driver.subscribe,
          exec(query, params) {
            return new Promise(resolve => {
              resolve(db.prepare(query).run(...params))
            })
          },
          select(query, params) {
            return new Promise(resolve => {
              resolve(toRows(db.prepare(query).all(...params)))
            })
          }
        }
        result = await callback(tx)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        hasChanges()
        throw e
      }
      if (hasChanges()) notifySubscribers()
      return result
    },

    close() {
      subscribers.clear()
      db.close()
    }
  }
  return driver
}
