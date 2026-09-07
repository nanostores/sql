import type { ClientConfig } from 'sqlocal'

import type { Driver } from '../index.js'

export type SqlocalOptions = Omit<ClientConfig, 'databasePath' | 'reactive'>

export function sqlocalDriver(filename: string, opts?: SqlocalOptions): Driver
