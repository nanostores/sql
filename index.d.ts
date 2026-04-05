import type { ReadableAtom } from 'nanostores'

export interface DrizzleQuery {
  toSQL(): { sql: string; params: unknown[] }
}

export interface Database<DBDriver extends Driver = Driver> {
  store<Value = unknown>(
    query: TemplateStringsArray,
    ...params: (string | number)[]
  ): ReadableAtom<SQliteStoreValue<Value>>
  store<Value = unknown>(
    query: DrizzleQuery
  ): ReadableAtom<SQliteStoreValue<Value>>

  transaction<T>(callback: (tx: Database<DBDriver>) => Promise<T>): Promise<T>

  exec<Value>(
    query: TemplateStringsArray,
    ...params: (string | number)[]
  ): Promise<Value>
  exec<Value>(query: DrizzleQuery): Promise<Value>

  opened: boolean

  driver: DBDriver

  close(): void
}

export function openDb<DBDriver extends Driver>(
  driver: DBDriver
): Database<DBDriver>

type Unsubscribe = () => void

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

  close(): void
}

export type MigrationStatusValue =
  | { applying: true }
  | { outdated: true }
  | { ready: true }

export function migrateIfNeeded(
  db: Database,
  version: number,
  migrate: (prevVersion: number) => Promise<void> | void
): ReadableAtom<MigrationStatusValue>

export type SQliteStoreValue<Value = unknown> =
  | { isLoading: true }
  | { isLoading: true; value: Value }
