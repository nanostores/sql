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
- The size is around **1 KB** (minified and brotlied).
  It uses [Size Limit] to control size.

```ts
import { openDb } from '@nanostores/sql'
// Or import { expoDriver } from '@nanostores/sql/expo'
import { sqlocalDriver } from '@nanostores/sql/sqlocal'

const db = openDb(sqlocalDriver('app.sqlite'))

const User = ({ name }) => {
  const $users = db.store<User>
    `SELECT * FROM users WHERE name LIKE '%${name}%'`
  // or const $users = db.store(drizzleDb.select().from(usersTable)
  //   .where(like(usersTable.name, `%${name}%`)))
  const users = useStore($users)
  if (users.isLoading) {
    return <Loader>
  } else {
    return users.list.map(user => <User>{user.name}</User>)
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

You can support to any other database, just implement [`Driver` interface](./index.d.ts).

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
const $users = db.store<User>`SELECT * FROM users WHERE name LIKE '%${name}%'`
```

TO change data use `db.exec()`:

```ts
setLoader(true)
await db.exec`DELETE FROM users WHERE id = ${id}`
setLoader(false)
```

## Usage with Drizzle
