import type { ReadableAtom } from 'nanostores'

export interface DrizzleQuery<Result = unknown> extends PromiseLike<Result> {
  toSQL(): { sql: string; params: unknown[] }
}

export interface Database<DBDriver extends Driver = Driver> {
  /**
   * Create a reactive store from a `SELECT` query. The store updates
   * automatically when the database changes.
   *
   * ```ts
   * const $users = db.store<User>`SELECT * FROM users WHERE id = ${id}`
   * ```
   *
   * Also accepts a Drizzle query builder:
   *
   * ```ts
   * const $users = db.store<User>(
   *   drizzleDb.select().from(usersTable)
   * )
   * ```
   *
   * @param query SQL tagged template or Drizzle query.
   * @returns Reactive store with  `{ isLoading, value }`.
   */
  store<Row = unknown>(
    query: TemplateStringsArray,
    ...params: (string | number)[]
  ): ReadableAtom<SqlStoreValue<Row[]>>
  store<Result>(
    query: DrizzleQuery<Result>
  ): ReadableAtom<SqlStoreValue<Result>>

  /**
   * Run a callback inside a database transaction.
   *
   * ```ts
   * await db.transaction(async tx => {
   *   await tx.exec`INSERT INTO users (name) VALUES (${'Alice'})`
   *   await tx.exec`INSERT INTO users (name) VALUES (${'Bob'})`
   * })
   * ```
   *
   * @param callback Function receiving a transactional `Database` instance.
   * @returns Promise resolving to the callback's return value.
   */
  transaction<T>(callback: (tx: Database<DBDriver>) => Promise<T>): Promise<T>

  /**
   * Execute a write query (INSERT, UPDATE, DELETE, etc.).
   *
   * ```ts
   * await db.exec`DELETE FROM users WHERE id = ${id}`
   * ```
   *
   * Also accepts a Drizzle query builder:
   *
   * ```ts
   * await db.exec(drizzleDb.delete(usersTable).where(eq(usersTable.id, id)))
   * ```
   *
   * @param query SQL tagged template or Drizzle query.
   * @returns Promise resolving to the query result.
   */
  exec(
    query: TemplateStringsArray,
    ...params: (string | number)[]
  ): Promise<void>
  exec(query: DrizzleQuery): Promise<void>

  /**
   * Whether the database connection is open.
   */
  opened: boolean

  /**
   * The underlying database driver instance.
   */
  driver: DBDriver

  /**
   * Close the database connection.
   */
  close(): Promise<void>
}

/**
 * Open a database connection with the given driver.
 *
 * ```ts
 * import { openDb } from '@nanostores/sql'
 * import { sqlocalDriver } from '@nanostores/sql/sqlocal'
 *
 * const db = openDb(sqlocalDriver('app.sqlite'))
 * ```
 *
 * @param driver Database driver (SQLocal, Expo, PGLite, or custom).
 * @returns Database instance.
 */
export function openDb<DBDriver extends Driver>(
  driver: DBDriver
): Database<DBDriver>

type Unsubscribe = () => void | Promise<void>

export interface DriverTransaction {
  subscribe(
    query: string,
    params: string[],
    cb: (result: unknown) => void
  ): Unsubscribe

  exec(query: string, params: string[]): Promise<unknown>
}

export interface Driver {
  subscribe(
    query: string,
    params: string[],
    cb: (result: unknown) => void
  ): Unsubscribe

  exec(query: string, params: string[]): Promise<unknown>

  transaction<T>(callback: (tx: DriverTransaction) => Promise<T>): Promise<T>

  close(): void | Promise<void>
}

/**
 * Create a Drizzle-compatible callback from a database instance.
 *
 * ```ts
 * import { toDrizzle } from '@nanostores/sql'
 * import { drizzle } from 'drizzle-orm/sqlite-proxy'
 *
 * export const drizzleDb = drizzle(toDrizzle(db))
 * ```
 *
 * @param db Database instance.
 * @returns Callback for `drizzle()` from `drizzle-orm/sqlite-proxy`.
 */
export function toDrizzle(
  db: Database
): (
  sql: string,
  params: unknown[],
  method: string
) => Promise<{ rows: unknown[][] }>

export type MigrationStatusValue =
  | { applying: true }
  | { outdated: true }
  | { ready: true }

/**
 * Run migrations if the database is behind the target version.
 * Returns a reactive store with the current migration status.
 *
 * ```ts
 * const $status = migrateIfNeeded(db, 2, async prevVersion => {
 *   if (prevVersion <= 1) {
 *     await db.exec`CREATE TABLE users
 *       (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)`
 *   }
 * })
 * ```
 *
 * @param db Database instance.
 * @param version Target schema version number.
 * @param migrate Callback receiving the previous version.
 * @returns Reactive store with `MigrationStatusValue`.
 */
export function migrateIfNeeded(
  db: Database,
  version: number,
  migrate: (prevVersion: number) => Promise<void> | void
): ReadableAtom<MigrationStatusValue>

/**
 * Store value for reactive SQL queries. Always has `isLoading: true`,
 * and may include `value` once initial data arrives.
 */
export type SqlStoreValue<Value = unknown> =
  | { isLoading: true }
  | { isLoading: false; value: Value }
