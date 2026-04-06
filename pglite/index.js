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
        .then(async result => {
          listener = result
          if (unsubscribed) await listener.unsubscribe()
        })
      return async () => {
        unsubscribed = true
        if (listener) await listener.unsubscribe()
      }
    },

    async exec(query, params) {
      await db.query(toPostgres(query), params).then(async result => {
        // To be sure that stores was updated after SQL execution
        await new Promise(resolve => {
          setTimeout(resolve, 0)
        })
        return result
      })
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
