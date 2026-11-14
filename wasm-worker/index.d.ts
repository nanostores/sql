import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm'

import type { WasmPort } from '../wasm/index.js'

export interface WasmWorkerOptions {
  /**
   * `BroadcastChannel` name to update stores in other browser tabs,
   * which open the same database file.
   *
   * Use `shared` instead to have one connection for all tabs.
   */
  channel?: string

  /**
   * Port to listen for `wasmDriver()`. Worker’s global scope by default.
   */
  port?: WasmPort

  /**
   * Web Lock name to share one database connection between browser tabs.
   *
   * Worker with the lock opens the database. Workers of other tabs send
   * queries to it. When the tab with the database is closed, the next
   * worker takes the lock and opens the database.
   *
   * App can request the same lock to wait until no tab uses the database.
   */
  shared?: string

  /**
   * Milliseconds after the last statement of transaction to roll it back
   * if other queries are waiting for it. Next statements of rolled back
   * transaction fail with `SQLITE_BUSY` error.
   *
   * Default is `5000`.
   */
  transactionTimeout?: number
}

/**
 * Run SQLite in Web Worker for `wasmDriver()` from `@nanostores/sql/wasm`.
 *
 * ```ts
 * import { wasmWorker } from '@nanostores/sql/wasm-worker'
 *
 * wasmWorker(sqlite3 => new sqlite3.oo1.OpfsDb('app.sqlite'), {
 *   shared: 'app-db'
 * })
 * ```
 *
 * Queries fail with the error of `open` if it throws.
 *
 * @param open Callback to open the database.
 * @param opts Options.
 * @returns Promise until the worker will be connected to opened database.
 */
export function wasmWorker(
  open: (sqlite3: Sqlite3Static) => Database | Promise<Database>,
  opts?: WasmWorkerOptions
): Promise<void>
