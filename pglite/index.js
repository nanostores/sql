import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'

function toPostgres(query) {
  let i = 0
  return query.replace(/\?/g, () => '$' + ++i)
}

export function pgliteDriver(uri) {
  let db = new PGlite(uri, { extensions: { live } })

  let driver = {
    subscribe(query, params, cb) {
      let listener
      let unsubscribed = false
      db.live
        .query(toPostgres(query), params, res => {
          cb(res.rows)
        })
        .then(result => {
          listener = result
          if (unsubscribed) listener.unsubscribe()
        })
      return () => {
        unsubscribed = true
        if (listener) listener.unsubscribe()
      }
    },

    async exec(query, params) {
      return await db.query(toPostgres(query), params)
    },

    async transaction(callback) {
      return db.transaction(tx => {
        return callback({
          subscribe: driver.subscribe,
          exec(query, params) {
            return tx.query(toPostgres(query), params)
          }
        })
      })
    },

    close() {
      db.offNotification()
      return db.close()
    }
  }
  return driver
}
