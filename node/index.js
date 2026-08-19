import { DatabaseSync } from 'node:sqlite'

function toRows(rows) {
  return rows.map(row => ({ ...row }))
}

export function nodeDriver(filename) {
  let db = new DatabaseSync(filename)
  let subscribers = new Map()
  let nextId = 0

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
        notifySubscribers()
        resolve(result)
      })
    },

    select(query, params) {
      return new Promise(resolve => {
        resolve(toRows(db.prepare(query).all(...params)))
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
          select: driver.select
        }
        result = await callback(tx)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      notifySubscribers()
      return result
    },

    close() {
      subscribers.clear()
      db.close()
    }
  }
  return driver
}
