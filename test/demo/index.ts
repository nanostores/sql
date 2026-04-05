import { expoDriver } from '../../expo/index.js'
import {
  migrateIfNeeded,
  openDb,
  type Database,
  type Driver
} from '../../index.js'
import { pgliteDriver } from '../../pglite/index.js'
import { sqlocalDriver } from '../../sqlocal/index.js'

let app = document.getElementById('app')!
let path = location.pathname.replace(/\/$/, '')

interface Counter {
  id: number
  value: number
}

let drivers: Record<string, (name: string) => Driver> = {
  sqlocal: sqlocalDriver,
  expo: expoDriver,
  pglite: pgliteDriver
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<HTMLElementTagNameMap[K]>,
  ...children: (string | number | Node)[]
): HTMLElementTagNameMap[K] {
  let element = document.createElement(tag)
  Object.assign(element, attrs)
  for (let child of children) {
    if (typeof child === 'number') {
      element.append(String(child))
    } else {
      element.append(child)
    }
  }
  return element
}

function link(href: string, text: string): HTMLAnchorElement {
  return el('a', { href }, text)
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  return el('button', { onclick: onClick }, text)
}

if (path === '' || path === '/') {
  renderHome()
} else {
  let driverName = path.slice(1)
  if (driverName in drivers) {
    renderCounters(driverName)
  } else {
    app.innerHTML = '<h1>404</h1><p><a href="/">Back to home</a></p>'
  }
}

function renderHome(): void {
  app.appendChild(el('h1', {}, 'Nano Stores SQL Demo'))
  app.appendChild(
    el('nav', {}, ...Object.keys(drivers).map(name => link(`/${name}`, name)))
  )
}

function renderCounters(driverName: string): void {
  app.appendChild(el('h1', {}, driverName))
  app.appendChild(link('/', 'Back'))

  let dbName =
    driverName === 'pglite' ? 'idb://demo-pglite' : `demo-${driverName}.sqlite`
  let db = openDb(drivers[driverName]!(dbName))

  let status = el('p', { className: 'loading' })
  app.appendChild(status)

  let $migration = migrateIfNeeded(db, 1, async prevVersion => {
    if (prevVersion < 1) {
      await db.exec`CREATE TABLE counters
        (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER NOT NULL DEFAULT 0)`
    }
  })

  $migration.subscribe(state => {
    if ('applying' in state) {
      status.textContent = 'Running migrations...'
    } else if ('outdated' in state) {
      status.textContent = 'Page outdated, please reload.'
    } else {
      status.remove()
      renderCounterList(db)
    }
  })
}

function renderCounterList(db: Database): void {
  let list = el('div', { id: 'counter-list' })
  app.appendChild(list)

  app.appendChild(
    button('Add counter', async () => {
      await db.exec`INSERT INTO counters (value) VALUES (0)`
    })
  )

  let $counters = db.store<Counter[]>`SELECT * FROM counters ORDER BY id`
  $counters.subscribe(state => {
    if (!('value' in state)) {
      list.innerHTML = '<p class="loading">Loading…</p>'
      return
    }
    list.innerHTML = ''
    let counters = state.value ?? []
    for (let { id, value } of counters) {
      list.appendChild(
        el(
          'div',
          { className: 'counter' },
          el('span', {}, `#${id}`),
          button('−', async () => {
            await db.exec`UPDATE counters SET value = value - 1 WHERE id = ${id}`
          }),
          el('span', {}, value),
          button('+', async () => {
            await db.exec`UPDATE counters SET value = value + 1 WHERE id = ${id}`
          }),
          button('Delete', async () => {
            await db.exec`DELETE FROM counters WHERE id = ${id}`
          })
        )
      )
    }
  })
}
