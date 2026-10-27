# Nano Stores SQL

<img align="right" width="92" height="92" title="Nano Stores logo"
     src="https://nanostores.github.io/nanostores/logo.svg">

[Nano Stores] wrapper around SQLite or PGLite to generate reactive stores
from SQL queries. This wrapper us useful if you moved logic from UI components
to smart stores.

- Support multiple databases drivers: **official SQLite WASM, SQLocal, Expo,
  PGLite**, or your **custom** driver.
- Can be used in **browser** with OPFS ot with **React Native**.
- Can be used with **Drizzle** to have type-safe query generation
  or with plain SQL strings to be very **small in JS bundle**.

```ts
import { openDb } from '@nanostores/sql'
// Or import { expoDriver } from '@nanostores/sql/expo'
import { sqlocalDriver } from '@nanostores/sql/sqlocal'

const db = openDb(sqlocalDriver('app.sqlite'))

const User = ({ id }) => {
  const $users = db.store<User>
    `SELECT * FROM users WHERE id = ${id}`
  // or const $users = db.store(drizzleDb.select().from(usersTable)
  //   .where(eq(usersTable.id, id)))
  const users = useStore($users)
  if (users.status === 'loading') {
    return <Loader>
  } else {
    return {users.value[0].name}
  }
}
```

[Nano Stores]: https://github.com/nanostores/nanostores
[Size Limit]: https://github.com/ai/size-limit

---

<img src="https://cdn.evilmartians.com/badges/logo-no-label.svg" alt="" width="22" height="16" />  Nano Stores SQL is built by <b><a href="https://evilmartians.com/">Evil Martians</a></b>, an American design and engineering consultancy for <b>developer tools, AI, and cybersecurity startups</b>.

---

## Install

```bash
npm add nanostores @nanostores/sql
```

## Open Database

### SQLocal

[SQLocal](https://github.com/DallasHoff/sqlocal) is our to use SQLite in the browser:

```bash
npm add sqlocal
```

```ts
import { openDb } from '@nanostores/sql'
import { sqlocalDriver } from '@nanostores/sql/sqlocal'

export const db = openDb(sqlocalDriver('app.sqlite'))
```

Add a worker workaround to Vite (see [docs](https://github.com/DallasHoff/sqlocal/blob/main/README.md#cross-origin-isolation)):

```ts
import sqlocal from 'sqlocal/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [sqlocal()]
})
```

The second argument accepts [SQLocal options](https://sqlocal.dev/api/client)
like `readOnly`, `verbose`, `onInit`, or `onConnect`:

```ts
export const db = openDb(
  sqlocalDriver('app.sqlite', {
    onInit: sql => [sql`PRAGMA foreign_keys = ON`]
  })
)
```

### SQLite WASM

Low-level [SQLite WASM](https://sqlite.org/wasm) driver to save space
in JS bundle if you don’t need JS functions in SQL from SQLocal and want
a full control.

```bash
npm add @sqlite.org/sqlite-wasm
```

Run SQLite in a worker (for instance, `db-worker.ts`):

```ts
import { wasmWorker } from '@nanostores/sql/wasm-worker'

wasmWorker(sqlite3 => new sqlite3.oo1.OpfsDb('app.sqlite'), {
  // Update stores in other browser tabs with the same database
  channel: 'app-db'
})
```

Connect to the worker on the page:

```ts
import { openDb } from '@nanostores/sql'
import { wasmDriver } from '@nanostores/sql/wasm'

export const db = openDb(
  wasmDriver(
    new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' })
  )
)
```

The page bundle has only the driver. SQLite and its WebAssembly file
are loaded only by the worker.

`OpfsDb` needs cross-origin isolated page. Send these HTTP headers
in production and set them in the bundler’s dev server:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Use `credentialless` instead of `require-corp` to load images from other
origins without CORS headers.

For browsers without cross-origin isolation (like Safari, which has
no `credentialless`) use [`opfs-sahpool` VFS], which supports only one
tab with the database:

```ts
wasmWorker(async sqlite3 => {
  let pool = await sqlite3.installOpfsSAHPoolVfs()
  return new pool.OpfsSAHPoolDb('/app.sqlite')
})
```

Use `sqlite3.oo1.DB(':memory:')` for in-memory database. To run
the database without worker (for instance, in tests), connect both sides
by `MessageChannel`:

```ts
const { port1, port2 } = new MessageChannel()
wasmWorker(sqlite3 => new sqlite3.oo1.DB(':memory:'), { port: port2 })
export const db = openDb(wasmDriver(port1))
```

`wasmWorker()` returns a promise, which rejects on the opening error
(all queries will fail with it too). The worker and the page can send
own messages through the same worker. The driver ignores them.

[`opfs-sahpool` VFS]: https://sqlite.org/wasm/doc/trunk/persistence.md#vfs-opfs-sahpool

#### Vite

Vite should not pre-bundle SQLite to keep the URL of WebAssembly file
and should build workers as ES modules:

```ts
import { defineConfig } from 'vite'

const headers = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin'
}

export default defineConfig({
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm']
  },
  preview: { headers },
  server: { headers },
  worker: {
    format: 'es'
  }
})
```

#### Other Bundlers

- Keep `new Worker(new URL('./db-worker.ts', import.meta.url))`
  in the source code. Webpack 5, Rspack, and Parcel detect it
  and create a separated worker bundle.
- SQLite loads `sqlite3.wasm` by `new URL('sqlite3.wasm', import.meta.url)`.
  The bundler should copy it as an asset and must not inline SQLite’s JS
  in a way, which breaks this URL.
- Build the worker as ES module.

### Expo

[Expo](https://docs.expo.dev/versions/latest/sdk/sqlite/) for React Native:

```bash
npx expo install expo-sqlite
```

```ts
import { openDb } from '@nanostores/sql'
import { expoDriver } from '@nanostores/sql/expo'

export const db = openDb(expoDriver('app.sqlite'))
```

React Native has no `localStorage`, which `migrateIfNeeded` uses
to keep the schema version. Install the polyfill from `expo-sqlite`
before calling it:

```ts
import 'expo-sqlite/localStorage/install'
```

### Node.js

For CI test you can use `nodeDriver`.

`node:sqlite` has no live queries and we use hacks for that, so it is not very efficient.

```ts
import { openDb } from '@nanostores/sql'
import { nodeDriver } from '@nanostores/sql/node'

export const db = openDb(nodeDriver(':memory:'))
```

### PGLite

[PGLite](https://pglite.dev) to use PostgreSQL rich features in browsers:

```bash
npm add pglite
```

```ts
import { openDb } from '@nanostores/sql'
import { pgliteDriver } from '@nanostores/sql/pglite'

export const db = openDb(pgliteDriver('app.sqlite'))
```

Note, that SQL syntax has small differences between PostgreSQL and SQLite.

Every `?` outside of quotes is treated as a parameter placeholder. Use
the `jsonb_exists()` function family instead of the `?`, `?|` and `?&`
JSONB operators.

### Custom Driver

You can support to any other database, just implement [`Driver`](./index.d.ts) interface.

### In-memory Database

`db.driver.persistent()` tells whether the database keeps data between app restarts (for instance, when the browser
has no OPFS).

```ts
if (!(await db.driver.persistent())) {
  showWarning('Data will be lost after closing the app')
}
```

## Migrations

`migrateIfNeeded` is a low-level helper to update database structure data and block other browser tabs with older JS client from breaking new database by old code.

```ts
import { migrateIfNeeded } from '@nanostores/sql'

const $migrationStatus = migrateIfNeeded(db, 2, async prevVersion => {
  if (prevVersion <= 1) {
    await db.exec`CREATE TABLE users
    (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)`
  }
})

const App = () => {
  let status = useStore($migrationStatus)
  if (status.applying) {
    return <Loader />
  } else if (status.outdated) {
    return <ReloadPageWarning />
  } else if (status.error) {
    return <BrokenDatabaseScreen error={status.error} />
  } else {
    return <AppUI />
  }
}
```

The store queries are paused until the migration is applied. If the migration
throws, the status becomes `{ error }` and the database stays paused.

The version is kept in `localStorage`, so it is shared between browser tabs.
When several tabs open a new version at once, they take a [Web Lock] to apply
the migration only once.

[Web Lock]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API

If you are implementing your own migrations, call `db.close()` in browser tabs with old version of client JS to stop using database (and show warning asking to reload page or reload page automatically).

## Usage with Plain SQL

Use `db.store()` for `SELECT` queries to read data. It created store and update data in the store on database changes:

```ts
const $users = db.store<User>`SELECT * FROM users WHERE name = ${name}`
```

If you need data only once (for instance, in an event handler) and don’t want
a reactive store, use `db.select()`:

```ts
let users = await db.select<User>`SELECT * FROM users WHERE name = ${name}`
```

To change data use `db.exec()`:

```ts
setLoader(true)
await db.exec`DELETE FROM users WHERE id = ${id}`
setLoader(false)
```

Note that `store`, `select`, and `exec` don’t have brackets, since it is
[tag template]. They automatically use parameterized queries for any `${}`
to prevent _SQL injection_:

```ts
let value = "' OR '1'='1"
let $secrets = db.store`SELECT * FROM secrets WHERE data = ${value}`
// The tag template splits this input into:
//   SQL:    "SELECT * FROM secrets WHERE data = ?"
//   Params: ["' OR '1'='1"]
// The database receives them separately — the param is not part of the query.
```

In additional to security, it also helps with performance, since param-less query (with `?`) can be compiled by database and compiled version then can be
used with different params.

[tag template]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals#tagged_templates

## Usage with Drizzle

Install [Drizzle ORM](https://orm.drizzle.team/):

```bash
npm add drizzle-orm
```

Define your schema:

```ts
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const usersTable = sqliteTable('users', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  email: text().notNull()
})
```

Create a Drizzle instance backed by the same driver:

```ts
import { toDrizzle } from '@nanostores/sql'
import { drizzle } from 'drizzle-orm/sqlite-proxy'

export const drizzleDb = drizzle(toDrizzle(db))
```

Pass Drizzle query builders to `db.store()`, `db.select()`, or `db.exec()`:

```ts
const $users = db.store<User>(
  drizzleDb
    .select()
    .from(usersTable)
    .where(like(usersTable.name, `%${name}%`))
)

const users = await db.select(drizzleDb.select().from(usersTable))
```

### Migrations with Drizzle

Install [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview):

```bash
npm add --save-dev drizzle-kit
```

Generate SQL migration files from your schema:

```bash
npx drizzle-kit generate
```

This creates SQL files in `./drizzle` (e.g. `0000_create_users.sql`,
`0001_add_posts.sql`). Import them as raw strings and apply
with `migrateIfNeeded`:

```ts
import { migrateIfNeeded } from '@nanostores/sql'

import migration0000 from './drizzle/0000_create_users.sql?raw'
import migration0001 from './drizzle/0001_add_posts.sql?raw'

const migrations = [migration0000, migration0001]

const $migrationStatus = migrateIfNeeded(
  db,
  migrations.length,
  async prevVersion => {
    for (let i = Math.max(0, prevVersion); i < migrations.length; i++) {
      await db.driver.exec(migrations[i], [])
    }
  }
)
```

When you update your Drizzle schema, run `npx drizzle-kit generate` again,
import the new file, and append it to `migrations`.

## Errors

Failed queries are printed with `console.error()`. Use `db.on('error')`
to send them to your error tracker or to show the user that the database
is broken:

```ts
const unbind = db.on('error', error => {
  reportToSentry(error)
  showBrokenDatabaseScreen()
})
```
