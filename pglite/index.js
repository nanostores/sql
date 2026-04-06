import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'

export function pgliteDriver(uri) {
  let db = new PGlite(uri, { extensions: { live } })

  let driver = {
    subscribe(query, params, cb) {
      let unsubscribed = false
      let unsubscribe = () => {
        unsubscribed = true
      }
      db.live
        .query(query, params, res => {
          if (!unsubscribed) cb(res.rows)
        })
        .then(ret => {
          if (unsubscribed) {
            ret.unsubscribe()
          } else {
            unsubscribe = () => {
              unsubscribed = true
              ret.unsubscribe()
            }
          }
        })
      return () => {
        unsubscribe()
      }
    },

    async exec(query, params) {
      return await db.query(query, params)
    },

    async transaction(callback) {
      return await db.transaction(async tx => {
        return await callback({
          subscribe: driver.subscribe,
          exec(query, params) {
            return tx.query(query, params)
          }
        })
      })
    },

    close() {
      db.close()
    }
  }
  return driver
}
