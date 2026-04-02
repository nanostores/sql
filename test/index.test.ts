import { equal } from 'node:assert/strict'
import { test } from 'node:test'

import { openDb } from '../index.js'

test('has function', () => {
  equal(typeof openDb, 'function')
})
