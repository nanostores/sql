import sqlite3InitModule from '@sqlite.org/sqlite-wasm'

const REQUESTS = new Set([
  'sql:begin',
  'sql:close',
  'sql:commit',
  'sql:query',
  'sql:rollback',
  'sql:subscribe',
  'sql:unsubscribe'
])

let loading

function createProcessor(sqlite3, db, send, broadcast) {
  let subscriptions = new Map()
  let waiting = []
  let changed = new Set()
  let tx

  let read = new Set()
  let written = new Set()
  let altered = new Set()
  // SQLite calls it on preparing SQL with the tables of every statement,
  // including triggers and fast `DELETE` without row-by-row hooks
  sqlite3.capi.sqlite3_set_authorizer(
    db,
    (_, code, first, second) => {
      if (code === sqlite3.capi.SQLITE_READ) {
        read.add(first)
      } else if (
        code === sqlite3.capi.SQLITE_INSERT ||
        code === sqlite3.capi.SQLITE_UPDATE ||
        code === sqlite3.capi.SQLITE_DELETE
      ) {
        written.add(first)
      } else if (code === sqlite3.capi.SQLITE_DROP_TABLE) {
        altered.add(first)
      } else if (code === sqlite3.capi.SQLITE_ALTER_TABLE) {
        altered.add(second)
      }
      return 0
    },
    0
  )

  function run(query, params) {
    read.clear()
    written.clear()
    altered.clear()
    let before = db.changes(true)
    let rows = db.exec({
      bind: params.length > 0 ? params : undefined,
      returnValue: 'resultRows',
      rowMode: 'object',
      sql: query
    })
    if (db.changes(true) !== before) {
      for (let table of written) changed.add(table)
    }
    for (let table of altered) changed.add(table)
    return rows
  }

  function updateSubscriptions() {
    let rows = []
    for (let [sub, subscription] of subscriptions) {
      if (!subscription.read.some(table => changed.has(table))) continue
      try {
        let result = run(subscription.query, subscription.params)
        let json = JSON.stringify(result)
        if (json !== subscription.json) {
          subscription.json = json
          rows.push([sub, result])
        }
      } catch (e) {
        subscriptions.delete(sub)
        send({ error: String(e), sub, type: 'sql:subscriptionFailed' })
      }
    }
    changed.clear()
    if (rows.length > 0) send({ rows, type: 'sql:updated' })
  }

  function commitChanges() {
    if (changed.size === 0) return
    broadcast?.([...changed])
    updateSubscriptions()
  }

  function runQuery(id, query, params) {
    let rows
    try {
      rows = run(query, params)
    } catch (e) {
      send({ error: String(e), id, type: 'sql:failed' })
      return false
    }
    if (tx === undefined) commitChanges()
    send({ id, rows, type: 'sql:done' })
    return true
  }

  function process(message) {
    if (message.type === 'sql:query') {
      runQuery(message.id, message.query, message.params)
    } else if (message.type === 'sql:begin') {
      if (
        runQuery(
          message.id,
          message.immediate ? 'BEGIN IMMEDIATE' : 'BEGIN',
          []
        )
      ) {
        tx = message.tx
      }
    } else if (message.type === 'sql:commit') {
      try {
        run('COMMIT', [])
      } catch (e) {
        send({ error: String(e), id: message.id, type: 'sql:failed' })
        return
      }
      tx = undefined
      commitChanges()
      send({ id: message.id, rows: [], type: 'sql:done' })
    } else if (message.type === 'sql:rollback') {
      // SQLite already rolled back the transaction on some errors
      try {
        run('ROLLBACK', [])
      } catch {}
      tx = undefined
      changed.clear()
      send({ id: message.id, rows: [], type: 'sql:done' })
    } else if (message.type === 'sql:subscribe') {
      try {
        let rows = run(message.query, message.params)
        subscriptions.set(message.sub, {
          json: JSON.stringify(rows),
          params: message.params,
          query: message.query,
          read: [...read]
        })
        send({ rows: [[message.sub, rows]], type: 'sql:updated' })
      } catch (e) {
        send({
          error: String(e),
          sub: message.sub,
          type: 'sql:subscriptionFailed'
        })
      }
    } else if (message.type === 'sql:changed') {
      for (let table of message.tables) changed.add(table)
      updateSubscriptions()
    } else {
      subscriptions.clear()
      db.close()
      send({ id: message.id, rows: [], type: 'sql:done' })
    }
  }

  return message => {
    if (message.type === 'sql:unsubscribe') {
      subscriptions.delete(message.sub)
    } else if (tx !== undefined && message.tx !== tx) {
      waiting.push(message)
    } else {
      process(message)
      while (tx === undefined && waiting.length > 0) {
        process(waiting.shift())
      }
    }
  }
}

export function wasmWorker(open, opts = {}) {
  let port = opts.port ?? globalThis
  let send = message => {
    port.postMessage(message)
  }
  let channel = opts.channel ? new BroadcastChannel(opts.channel) : undefined

  loading ??= sqlite3InitModule()
  let opening = loading.then(async sqlite3 => {
    let receive = createProcessor(
      sqlite3,
      await open(sqlite3),
      send,
      channel &&
        (tables => {
          channel.postMessage(tables)
        })
    )
    channel?.addEventListener('message', ({ data }) => {
      receive({ tables: data, type: 'sql:changed' })
    })
    return receive
  })

  port.addEventListener('message', ({ data }) => {
    // The page can send own messages of the app through the same port
    if (!REQUESTS.has(data?.type)) return
    opening.then(
      receive => {
        receive(data)
        if (data.type === 'sql:close') channel?.close()
      },
      e => {
        if (data.type === 'sql:subscribe') {
          send({
            error: String(e),
            sub: data.sub,
            type: 'sql:subscriptionFailed'
          })
        } else if (data.type !== 'sql:unsubscribe') {
          send({ error: String(e), id: data.id, type: 'sql:failed' })
        }
      }
    )
  })
  port.start?.()

  return opening.then(() => {})
}
