import { RESOLVED_SYSTEM_PROMPT } from '../src/system-prompt.js'
import { writeFileSync } from 'node:fs'
writeFileSync('/tmp/resolved-ts.txt', RESOLVED_SYSTEM_PROMPT)
