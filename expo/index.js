import { addDatabaseChangeListener, openDatabaseAsync } from 'expo-sqlite'

export function expoDriver(filename) {
  let dbReady = openDatabaseAsync(filename, { enableChangeListener: true })
  let subscribers = new Map()
  let nextId = 0

  async function notifySubscribers() {
    let db = await dbReady
    await Promise.all(
      Array.from(subscribers.values()).map(async sub => {
        let rows = await db.getAllAsync(sub.query, sub.params)
        sub.cb(rows)
      })
    )
  }

  let subscription = addDatabaseChangeListener(() => {
    void notifySubscribers()
  })

  let driver = {
    subscribe(query, params, cb) {
      let id = nextId++
      subscribers.set(id, { query, params, cb })
      void dbReady.then(db => {
        void db.getAllAsync(query, params).then(rows => {
          if (subscribers.has(id)) cb(rows)
        })
      })
      return () => {
        subscribers.delete(id)
      }
    },

    async exec(query, params) {
      let db = await dbReady
      await db.runAsync(query, params)
    },

    async transaction(callback) {
      let db = await dbReady
      await db.withTransactionAsync(async () => {
        await callback({
          subscribe: driver.subscribe,
          async exec(query, params) {
            await db.runAsync(query, params)
          }
        })
      })
    },

    async close() {
      subscription.remove()
      subscribers.clear()
      let db = await dbReady
      await db.closeAsync()
    }
  }
  return driver
}
