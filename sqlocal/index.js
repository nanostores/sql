import { SQLocal } from 'sqlocal'

export function sqlocalDriver(filename, opts) {
  let db = new SQLocal({ ...opts, databasePath: filename, reactive: true })

  let driver = {
    subscribe(query, params, cb, onError) {
      let reactive = db.reactiveQuery(sql => sql(query, ...params))
      let { unsubscribe } = reactive.subscribe(results => {
        cb(results)
      }, onError)
      return () => {
        unsubscribe()
      }
    },

    async exec(query, params) {
      await db.sql(query, ...params)
    },

    select(query, params) {
      return db.sql(query, ...params)
    },

    // SQLocal has exclusive access to the file from a single worker,
    // so `immediate` option is not needed
    async transaction(callback) {
      return db.transaction(async tx => {
        return callback({
          subscribe: driver.subscribe,
          async exec(query, params) {
            await tx.sql(query, ...params)
          },
          select(query, params) {
            return tx.sql(query, ...params)
          }
        })
      })
    },

    async persistent() {
      // In-memory and temporary databases have no file
      let [main] = await db.sql('PRAGMA database_list')
      return !!main?.file
    },

    close() {
      return db.destroy()
    }
  }
  return driver
}
