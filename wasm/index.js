const ANSWERS = new Set([
  'sql:done',
  'sql:failed',
  'sql:subscriptionFailed',
  'sql:updated'
])

export function wasmDriver(port) {
  let requests = new Map()
  let subscriptions = new Map()
  let lastId = 0

  function request(message) {
    return new Promise((resolve, reject) => {
      requests.set(message.id, { reject, resolve })
      port.postMessage(message)
    })
  }

  function query(sql, params, tx) {
    return request({ id: ++lastId, params, query: sql, tx, type: 'sql:query' })
  }

  port.addEventListener('message', ({ data }) => {
    // The worker can send own messages of the app through the same port
    if (!ANSWERS.has(data?.type)) return
    if (data.type === 'sql:updated') {
      for (let [sub, rows] of data.rows) subscriptions.get(sub)?.cb(rows)
    } else if (data.type === 'sql:subscriptionFailed') {
      let subscription = subscriptions.get(data.sub)
      subscriptions.delete(data.sub)
      subscription?.onError(new Error(data.error))
    } else {
      let current = requests.get(data.id)
      requests.delete(data.id)
      if (data.type === 'sql:done') {
        current.resolve(data.rows)
      } else {
        current.reject(new Error(data.error))
      }
    }
  })
  port.start?.()

  let driver = {
    async close() {
      subscriptions.clear()
      await request({ id: ++lastId, type: 'sql:close' })
      if (port.terminate) {
        port.terminate()
      } else {
        port.close?.()
      }
    },

    exec: query,

    async persistent() {
      // In-memory and temporary databases have no file
      let [main] = await query('PRAGMA database_list', [])
      return !!main?.file
    },

    select: query,

    subscribe(sql, params, cb, onError) {
      let sub = ++lastId
      subscriptions.set(sub, { cb, onError })
      port.postMessage({ params, query: sql, sub, type: 'sql:subscribe' })
      return () => {
        if (subscriptions.delete(sub)) {
          port.postMessage({ sub, type: 'sql:unsubscribe' })
        }
      }
    },

    async transaction(callback, opts = {}) {
      let tx = ++lastId
      await request({
        id: tx,
        immediate: !!opts.immediate,
        tx,
        type: 'sql:begin'
      })
      let result
      try {
        result = await callback({
          exec: (sql, params) => query(sql, params, tx),
          select: (sql, params) => query(sql, params, tx),
          subscribe: driver.subscribe
        })
        await request({ id: ++lastId, tx, type: 'sql:commit' })
      } catch (e) {
        await request({ id: ++lastId, tx, type: 'sql:rollback' })
        throw e
      }
      return result
    }
  }
  return driver
}
