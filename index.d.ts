import type { ReadonlyAtom } from 'nanostores'

export interface Database {
  store<Value = unknown>(
    query: TemplateStringsArray,
    ...params: string
  ): ReadonlyAtom<SQliteStoreValue<Value>>

  transaction<T>(callback: (tx: Database) => Promise<T>): Promise<T>

  exec<Value>(query: TemplateStringsArray, ...params: string): Promise<Value>

  opened: boolean

  close(): void
}

export function openDb(driver: Driver): Database

type Unsubscribe = () => void

export interface Driver {
  subscribe(
    query: string,
    params: string[],
    cb: (result: unknown) => void
  ): Unsubscribe

  exec(query: string, params: string[]): Promise<unknown>

  transaction<T>(callback: (tx: Database) => Promise<T>): Promise<T>

  close(): void
}

export type SQliteStoreValue<Value = unknown> =
  | { isLoading: true }
  | { isLoading: true; value: Value }
