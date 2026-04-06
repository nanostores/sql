import { SQLocal } from 'sqlocal'

export function sqlocalDriver(filename) {
  let db = new SQLocal({ databasePath: filename, reactive: true })

  let driver = {
    subscribe(query, params, cb) {
      let reactive = db.reactiveQuery(sql => sql(query, ...params))
      let { unsubscribe } = reactive.subscribe(results => {
        cb(results)
      })
      return () => {
        unsubscribe()
      }
    },

    async exec(query, params) {
      await db.sql(query, ...params)
    },

    async transaction(callback) {
      return db.transaction(async tx => {
        return callback({
          subscribe: driver.subscribe,
          async exec(query, params) {
            await tx.sql(query, ...params)
          }
        })
      })
    },

    close() {
      return db.destroy()
    }
  }
  return driver
}
