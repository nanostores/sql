import type { Driver } from '../index.js'

/**
 * Web Worker or `MessagePort` with `wasmWorker()` on the other side.
 */
export interface WasmPort {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void
  ): void
  close?(): void
  postMessage(message: unknown): void
  start?(): void
  terminate?(): void
}

export interface WasmDriver extends Required<Driver> {
  /**
   * Export the whole database file. It works in any tab even with
   * `opfs-sahpool` VFS, since the tab with the database makes the file.
   *
   * ```ts
   * const file = await db.driver.export()
   * const url = URL.createObjectURL(new Blob([file]))
   * ```
   *
   * @returns SQLite database file.
   */
  export(): Promise<Uint8Array>
}

/**
 * Driver to SQLite in Web Worker with `wasmWorker()` from
 * `@nanostores/sql/wasm-worker`.
 *
 * ```ts
 * import { openDb } from '@nanostores/sql'
 * import { wasmDriver } from '@nanostores/sql/wasm'
 *
 * export const db = openDb(
 *   wasmDriver(
 *     new Worker(new URL('./db-worker.ts', import.meta.url), {
 *       type: 'module'
 *     })
 *   )
 * )
 * ```
 *
 * `db.close()` terminates the worker.
 *
 * @param port Worker with the database.
 */
export function wasmDriver(port: WasmPort): WasmDriver
