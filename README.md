# Nano Stores SQL

<img align="right" width="92" height="92" title="Nano Stores logo"
     src="https://nanostores.github.io/nanostores/logo.svg">

[Nano Stores] wrapper around SQLite or PGLite to generate reactive stores
from SQL queries. This wrapper us useful if you moved logic from UI components
to smart stores.

- Support multiple databases drivers: **SQLocal, Expo, PGLite**,
  or your **custom** driver.
- Can be used in **browser** with OPFS ot with **React Native**.
- Can be used with **Drizzle** to have type-safe query generation or with plain SQL strings to be very **small in JS bundle**.
- The size is around **1 KB** (minified and brotlied).
  It uses [Size Limit] to control size.

```ts
import { openDb } from '@nanostores/sql'
// Or import { expoDriver } from '@nanostores/sql/expo'
import { sqlocalDriver } from '@nanostores/sql/sqlocal'

const db = openDb(sqlocalDriver('app.sqlite'))

const User = ({ name }) => {
  const $users = db.store<User>(
    `SELECT * FROM users WHERE name LIKE '%${name}%'`
  )
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
