import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm'

import type { WasmPort } from '../wasm/index.js'

export interface WasmWorkerOptions {
  /**
   * `BroadcastChannel` name to update stores in other browser tabs,
   * which open the same database file.
   */
  channel?: string

  /**
   * Port to listen for `wasmDriver()`. Worker’s global scope by default.
   */
  port?: WasmPort
}

/**
 * Run SQLite in Web Worker for `wasmDriver()` from `@nanostores/sql/wasm`.
 *
 * ```ts
 * import { wasmWorker } from '@nanostores/sql/wasm-worker'
 *
 * wasmWorker(sqlite3 => new sqlite3.oo1.OpfsDb('app.sqlite'), {
 *   channel: 'app-db'
 * })
 * ```
 *
 * Queries fail with the error of `open` if it throws.
 *
 * @param open Callback to open the database.
 * @param opts Options.
 * @returns Promise until the database will be opened.
 */
export function wasmWorker(
  open: (sqlite3: Sqlite3Static) => Database | Promise<Database>,
  opts?: WasmWorkerOptions
): Promise<void>
