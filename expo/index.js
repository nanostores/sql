import { addDatabaseChangeListener, openDatabaseAsync } from 'expo-sqlite'

export function expoDriver(filename) {
  let dbReady = openDatabaseAsync(filename, { enableChangeListener: true })
  let subscribers = new Map()
  let nextId = 0

  async function notifySubscribers() {
    let db = await dbReady
    await Promise.all(
      Array.from(subscribers.values()).map(async sub => {
        try {
          sub.cb(await db.getAllAsync(sub.query, sub.params))
        } catch (e) {
          sub.onError(e)
        }
      })
    )
  }

  let subscription = addDatabaseChangeListener(() => {
    void notifySubscribers()
  })

  let driver = {
    subscribe(query, params, cb, onError) {
      let id = nextId++
      subscribers.set(id, { cb, onError, params, query })
      void dbReady
        .then(async db => {
          let rows = await db.getAllAsync(query, params)
          if (subscribers.has(id)) cb(rows)
        })
        .catch(e => {
          if (subscribers.has(id)) onError(e)
        })
      return () => {
        subscribers.delete(id)
      }
    },

    async exec(query, params) {
      let db = await dbReady
      await db.runAsync(query, params)
    },

    async select(query, params) {
      let db = await dbReady
      return db.getAllAsync(query, params)
    },

    async transaction(callback, opts = {}) {
      let db = await dbReady
      let result
      let run = tx => {
        return callback({
          subscribe: driver.subscribe,
          async exec(query, params) {
            await tx.runAsync(query, params)
          },
          select(query, params) {
            return tx.getAllAsync(query, params)
          }
        })
      }
      if (opts.immediate) {
        await db.withExclusiveTransactionAsync(async tx => {
          result = await run(tx)
        })
      } else {
        await db.withTransactionAsync(async () => {
          result = await run(db)
        })
      }
      return result
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
