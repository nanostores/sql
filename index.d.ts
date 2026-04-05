import type { ReadonlyAtom } from 'nanostores'

export interface DrizzleQuery {
  toSQL(): { sql: string; params: unknown[] }
}

export interface Database<Driver = unknown> {
  store<Value = unknown>(
    query: TemplateStringsArray,
    ...params: string
  ): ReadonlyAtom<SQliteStoreValue<Value>>
  store<Value = unknown>(query: DrizzleQuery): ReadonlyAtom<SQliteStoreValue<Value>>

  transaction<T>(callback: (tx: Database<Driver>) => Promise<T>): Promise<T>

  exec<Value>(query: TemplateStringsArray, ...params: string): Promise<Value>
  exec<Value>(query: DrizzleQuery): Promise<Value>

  opened: boolean

  driver: Driver

  close(): void
}

export function openDb<SelectedDriver extends Driver>(
  driver: SelectedDriver
): Database<SelectedDriver>

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

export type SQliteStoreValue<Value = unknown> =
  | { isLoading: true }
  | { isLoading: true; value: Value }
