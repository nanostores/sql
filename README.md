# Nano Stores SQL

<img align="right" width="92" height="92" title="Nano Stores logo"
     src="https://nanostores.github.io/nanostores/logo.svg">

[Nano Stores] wrapper around SQLite or PGLite to generate reactive stores
from SQL queries. This wrapper us useful if you moved logic from UI components
to smart stores.

- Support multiple databases drivers: **SQLocal, Expo, PGLite**,
  or your **custom** driver.
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
  //   .where(eq(usersTable.id, `%${id}%`)))
  const users = useStore($users)
  if (users.isLoading) {
    return <Loader>
  } else {
    return {users.value[0].name}
  }
}
```

[Nano Stores]: https://github.com/nanostores/nanostores
[Size Limit]: https://github.com/ai/size-limit

---

<img src="https://cdn.evilmartians.com/badges/logo-no-label.svg" alt="" width="22" height="16" /> Made at <b><a href="https://evilmartians.com/devtools?utm_source=nanostores-sql&utm_campaign=devtools-button&utm_medium=github">Evil Martians</a></b>, product consulting for <b>developer tools</b>.

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
import { defineConfig } from 'vite'
import sqlocal from 'sqlocal/vite'

export default defineConfig({
  plugins: [sqlocal()]
})
```

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

### Custom Driver

You can support to any other database, just implement [`Driver`](./index.d.ts) interface.

## Migrations

`migrateIfNeeded` is a low-level helper to update database structure data and block other browser tabs with older JS client from breaking new database by old code.

```ts
import { migrateIfNeeded } from '@nanostores/sql'

const $migrationStatus = migrateIfNeeded(db, 2, prevVersion => {
  if (prevVersion <= 1) {
    await db.sql`CREATE TABLE users
    (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)`
  }
})

const App = () => {
  let status = useStore($migrationStatus)
  if (status.applying) {
    return <Loader />
  } else if (status.outdated) {
    return <ReloadPageWarning />
  } else {
    return <AppUI />
  }
}
```

If you are implementing your own migrations, call `db.close()` in browser tabs with old version of client JS to stop using database (and show warning asking to reload page or reload page automatically).

## Usage with Plain SQL

Use `db.store()` for `SELECT` queries to read data. It created store and update data in the store on database changes:

```ts
const $users = db.store<User>`SELECT * FROM users WHERE name = ${name}`
```

To change data use `db.exec()`:

```ts
setLoader(true)
await db.exec`DELETE FROM users WHERE id = ${id}`
setLoader(false)
```

Note that both `store` and `exec` don’t have brackets, since it is
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

Pass Drizzle query builders to `db.store()` or `db.exec()`:

```ts
const $users = db.store<User>(
  drizzleDb
    .select()
    .from(usersTable)
    .where(like(usersTable.name, `%${name}%`))
)
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
