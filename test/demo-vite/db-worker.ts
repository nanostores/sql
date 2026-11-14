import { wasmWorker } from '../../wasm-worker/index.js'

let [vfs, file = ''] = self.name.split(':')

let poolOptions = {
  forceReinitIfPreviouslyFailed: true,
  preserveOnInitFailure: true
}

void wasmWorker(
  async sqlite3 => {
    if (vfs === 'sahpool') {
      let pool = await sqlite3.installOpfsSAHPoolVfs(poolOptions)
      return new pool.OpfsSAHPoolDb(`/${file}`)
    } else {
      let db = new sqlite3.oo1.OpfsDb(file)
      db.exec('PRAGMA locking_mode = EXCLUSIVE')
      return db
    }
  },
  { shared: self.name }
)
