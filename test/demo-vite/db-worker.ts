import { wasmWorker } from '../../wasm-worker/index.js'

void wasmWorker(sqlite3 => new sqlite3.oo1.OpfsDb(self.name), {
  channel: self.name
})
