import sqlite3InitModule from '@sqlite.org/sqlite-wasm'

const REQUESTS = new Set([
  'sql:begin',
  'sql:close',
  'sql:commit',
  'sql:export',
  'sql:query',
  'sql:rollback',
  'sql:subscribe',
  'sql:unsubscribe'
])

// The browser frees OPFS handles of a closed tab with a delay
const OPEN_RETRY = 5000
const OPEN_RETRY_DELAY = 100
// Safari throws InvalidStateError for a second sync access handle
const LOCKED = /SQLITE_BUSY|NoModificationAllowedError|InvalidStateError/

let loading

function createProcessor(sqlite3, db, timeout, broadcast) {
  // Every page is a client: own page of the worker and pages of other tabs
  let clients = new Map()
  let waiting = []
  let changed = new Set()
  let closed = false
  let lastActivity
  let owner
  let timer
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
    for (let { send, subs } of clients.values()) {
      let rows = []
      for (let [sub, subscription] of subs) {
        if (!subscription.read.some(table => changed.has(table))) continue
        try {
          let result = run(subscription.query, subscription.params)
          let json = JSON.stringify(result)
          if (json !== subscription.json) {
            subscription.json = json
            rows.push([sub, result])
          }
        } catch (e) {
          subs.delete(sub)
          send({ error: String(e), sub, type: 'sql:subscriptionFailed' })
        }
      }
      if (rows.length > 0) send({ rows, type: 'sql:updated' })
    }
    changed.clear()
  }

  function commitChanges() {
    if (changed.size === 0) return
    broadcast?.([...changed])
    updateSubscriptions()
  }

  function runQuery(send, id, query, params) {
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

  function rollback() {
    // SQLite already rolled back the transaction on some errors
    try {
      run('ROLLBACK', [])
    } catch {}
    owner = undefined
    tx = undefined
    changed.clear()
  }

  function drop(client) {
    clients.delete(client)
    waiting = waiting.filter(([from]) => from !== client)
    if (owner === client) rollback()
  }

  function process(client, message) {
    let { send, subs } = clients.get(client)
    lastActivity = Date.now()
    if (message.type === 'sql:query') {
      runQuery(send, message.id, message.query, message.params)
    } else if (message.type === 'sql:begin') {
      let sql = message.immediate ? 'BEGIN IMMEDIATE' : 'BEGIN'
      if (runQuery(send, message.id, sql, [])) {
        owner = client
        tx = message.tx
      }
    } else if (message.type === 'sql:commit') {
      try {
        run('COMMIT', [])
      } catch (e) {
        send({ error: String(e), id: message.id, type: 'sql:failed' })
        return
      }
      owner = undefined
      tx = undefined
      commitChanges()
      send({ id: message.id, rows: [], type: 'sql:done' })
    } else if (message.type === 'sql:rollback') {
      rollback()
      send({ id: message.id, rows: [], type: 'sql:done' })
    } else if (message.type === 'sql:subscribe') {
      try {
        let rows = run(message.query, message.params)
        subs.set(message.sub, {
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
    } else if (message.type === 'sql:export') {
      let rows = sqlite3.capi.sqlite3_js_db_export(db)
      send({ id: message.id, rows, type: 'sql:done' })
    } else {
      closed = true
      clients.clear()
      db.close()
      send({ id: message.id, rows: [], type: 'sql:done' })
    }
  }

  function expire() {
    clients
      .get(owner)
      .expired.set(
        tx,
        `SQLITE_BUSY: transaction was rolled back, because it sent nothing ` +
          `for ${timeout} ms while other queries were waiting`
      )
    rollback()
    flush()
  }

  function flush() {
    // Messages of other tabs after closing will be sent to the next leader
    while (!closed && tx === undefined && waiting.length > 0) {
      process(...waiting.shift())
    }
    clearTimeout(timer)
    if (tx !== undefined && waiting.length > 0) {
      timer = setTimeout(expire, lastActivity + timeout - Date.now())
    }
  }

  return {
    changed(tables) {
      for (let table of tables) changed.add(table)
      updateSubscriptions()
    },

    connect(client, send, lost = []) {
      let expired = new Map()
      for (let lostTx of lost) {
        expired.set(
          lostTx,
          'SQLITE_BUSY: transaction was lost, ' +
            'because the tab with the database was closed'
        )
      }
      clients.set(client, { expired, send, subs: new Map() })
    },

    disconnect(client) {
      drop(client)
      flush()
    },

    receive(client, message) {
      let state = clients.get(client)
      if (closed || !state) return
      if (message.type === 'sql:unsubscribe') {
        state.subs.delete(message.sub)
      } else if (state.expired.has(message.tx)) {
        if (message.type === 'sql:rollback') {
          state.expired.delete(message.tx)
          state.send({ id: message.id, rows: [], type: 'sql:done' })
        } else {
          state.send({
            error: state.expired.get(message.tx),
            id: message.id,
            type: 'sql:failed'
          })
        }
      } else if (tx !== undefined && (client !== owner || message.tx !== tx)) {
        waiting.push([client, message])
      } else {
        process(client, message)
      }
      flush()
    }
  }
}

async function openWithRetry(open, sqlite3) {
  let deadline = Date.now() + OPEN_RETRY
  for (;;) {
    try {
      return await open(sqlite3)
    } catch (e) {
      if (!LOCKED.test(String(e)) || Date.now() > deadline) throw e
      await new Promise(resolve => {
        setTimeout(resolve, OPEN_RETRY_DELAY)
      })
    }
  }
}

export function wasmWorker(open, opts = {}) {
  if (opts.shared && opts.channel) {
    throw new Error('Use only one of shared and channel options')
  }
  let port = opts.port ?? globalThis
  let locks = opts.shared && globalThis.navigator?.locks
  let prefix = `nanostores-sql:${opts.shared}`
  let id = Date.now().toString(36) + Math.random().toString(36).slice(2)
  let controller = new AbortController()
  let signal = controller.signal

  // State of the page’s requests to resend them to another leader
  let pending = new Map()
  let subs = new Map()
  let begun = new Set()

  let role
  let target
  let processor
  let channel
  let control
  let own
  let leader
  let releaseLeader
  let releaseFollower
  let closing
  let followers = new Map()

  let resolveReady, rejectReady
  let ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  function toPage(message) {
    if (message.type === 'sql:subscriptionFailed') {
      subs.delete(message.sub)
    } else if (message.type !== 'sql:updated') {
      let request = pending.get(message.id)
      // Answer of the previous leader after the change
      if (!request) return
      pending.delete(message.id)
      if (request.type === 'sql:begin' && message.type === 'sql:done') {
        begun.add(request.tx)
      } else if (
        request.type === 'sql:rollback' ||
        (request.type === 'sql:commit' && message.type === 'sql:done')
      ) {
        begun.delete(request.tx)
      } else if (request.type === 'sql:close') {
        cleanup()
      }
    }
    port.postMessage(message)
    if (closing && role === 'follower' && pending.size === 0) closeFollower()
  }

  function closeFollower() {
    // Leader waits for the released lock to roll back transaction
    // and forget subscriptions
    cleanup()
    port.postMessage({ id: closing.id, rows: [], type: 'sql:done' })
    closing = undefined
  }

  function connectTo(send) {
    target = send
    for (let message of [...pending.values(), ...subs.values()]) send(message)
  }

  function failWith(error) {
    return message => {
      if (message.type === 'sql:subscribe') {
        toPage({ error, sub: message.sub, type: 'sql:subscriptionFailed' })
      } else if (message.type !== 'sql:unsubscribe') {
        toPage({ error, id: message.id, type: 'sql:failed' })
      }
    }
  }

  function cleanup() {
    controller.abort()
    releaseLeader?.()
    releaseFollower?.()
    channel?.close()
    control?.close()
    own?.close()
    for (let follower of followers.values()) follower.close()
  }

  function accept({ id: client, lost }) {
    if (!followers.has(client)) {
      let follower = new BroadcastChannel(`${prefix}:${client}`)
      followers.set(client, follower)
      processor.connect(
        client,
        message => {
          follower.postMessage(message)
        },
        lost
      )
      follower.addEventListener('message', ({ data }) => {
        processor.receive(client, data)
      })
      // Follower holds the lock until its tab will be closed
      locks
        .request(`${prefix}:${client}`, { signal }, () => {
          follower.close()
          followers.delete(client)
          processor.disconnect(client)
        })
        .catch(() => {})
    }
    followers.get(client).postMessage({ leader: id, type: 'accepted' })
  }

  async function lead() {
    role = 'leader'
    target = undefined
    // Closing follower became the leader before answers to its queries
    if (closing) pending.set(closing.id, closing)
    try {
      loading ??= sqlite3InitModule()
      let sqlite3 = await loading
      let db = await openWithRetry(open, sqlite3)
      processor = createProcessor(
        sqlite3,
        db,
        opts.transactionTimeout ?? 5000,
        opts.channel &&
          (tables => {
            channel.postMessage(tables)
          })
      )
    } catch (e) {
      role = 'failed'
      cleanup()
      rejectReady(e)
      connectTo(failWith(String(e)))
      return
    }
    if (opts.channel) {
      channel = new BroadcastChannel(opts.channel)
      channel.addEventListener('message', ({ data }) => {
        processor.changed(data)
      })
    }
    // Transaction of the previous leader is lost with its connection
    processor.connect(id, toPage, [...begun])
    begun.clear()
    releaseFollower?.()
    own?.close()
    connectTo(message => {
      processor.receive(id, message)
    })
    resolveReady()
    control?.postMessage({ leader: id, type: 'leader' })
    return new Promise(resolve => {
      releaseLeader = resolve
    })
  }

  function follow() {
    role = 'follower'
    // The leader will wait for this lock to know that the tab was closed
    locks
      .request(`${prefix}:${id}`, { signal }, () => {
        own = new BroadcastChannel(`${prefix}:${id}`)
        own.addEventListener('message', ({ data }) => {
          if (data.type !== 'accepted') {
            toPage(data)
          } else if (data.leader !== leader) {
            leader = data.leader
            begun.clear()
            connectTo(message => {
              own.postMessage(message)
            })
            resolveReady()
          }
        })
        control = new BroadcastChannel(prefix)
        control.addEventListener('message', ({ data }) => {
          if (role === 'leader') {
            if (processor && data.type === 'connect') accept(data)
          } else if (data.type === 'leader' && data.leader !== leader) {
            // Previous leader’s tab was closed
            if (leader) {
              leader = undefined
              target = undefined
            }
            control.postMessage({ id, lost: [...begun], type: 'connect' })
          }
        })
        control.postMessage({ id, lost: [], type: 'connect' })
        locks.request(opts.shared, { signal }, lead).catch(() => {})
        return new Promise(resolve => {
          releaseFollower = resolve
        })
      })
      .catch(() => {})
  }

  port.addEventListener('message', ({ data }) => {
    // The page can send own messages of the app through the same port
    if (!REQUESTS.has(data?.type)) return
    if (data.type === 'sql:close' && role === 'follower') {
      // Wait for answers to previous queries like the leader’s queue does
      closing = data
      if (pending.size === 0) closeFollower()
      return
    }
    if (data.type === 'sql:subscribe') {
      subs.set(data.sub, data)
    } else if (data.type === 'sql:unsubscribe') {
      subs.delete(data.sub)
    } else {
      pending.set(data.id, data)
    }
    target?.(data)
  })
  port.start?.()

  if (locks) {
    follow()
  } else {
    void lead()
  }

  return ready
}
