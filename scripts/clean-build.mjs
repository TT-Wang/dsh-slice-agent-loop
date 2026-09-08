import { rmSync } from 'node:fs'
// lib is entirely generated; clearing it prevents deleted implementations shipping.
rmSync(new URL('../lib/', import.meta.url), { recursive: true, force: true })
