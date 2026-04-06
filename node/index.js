import { DatabaseSync } from 'node:sqlite'

function toRows(rows) {
  return rows.map(row => ({ ...row }))
}

export function nodeDriver(filename) {
  let db = new DatabaseSync(filename)
  let subscribers = new Map()
  let nextId = 0

  function notifySubscribers() {
    for (let [, sub] of subscribers) {
      let rows = db.prepare(sub.query).all(...sub.params)
      sub.cb(toRows(rows))
    }
  }

  let driver = {
    subscribe(query, params, cb) {
      let id = nextId++
      subscribers.set(id, { query, params, cb })
      // Emulate async for better compatibility
      void Promise.resolve().then(() => {
        let rows = db.prepare(query).all(...params)
        cb(toRows(rows))
      })
      return () => {
        subscribers.delete(id)
      }
    },

    exec(query, params) {
      return new Promise(resolve => {
        let result = db.prepare(query).run(...params)
        notifySubscribers()
        resolve(result)
      })
    },

    async transaction(callback) {
      db.exec('BEGIN')
      try {
        let result = await callback(driver)
        db.exec('COMMIT')
        notifySubscribers()
        return result
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },

    close() {
      subscribers.clear()
      db.close()
    }
  }
  return driver
}
