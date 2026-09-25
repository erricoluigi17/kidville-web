import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('rifiuta il seed di produzione prima di qualunque chiamata di rete', () => {
  const guardiaRete = 'globalThis.fetch=()=>{process.stderr.write("RETE_VIETATA");process.exit(87)}'
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(guardiaRete)}`,
    resolve('scripts/seed-e2e.mjs'),
  ], {
    encoding: 'utf8', timeout: 10_000,
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: 'https://uimulkjyekgemjakmepp.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'chiave-finta-del-test-senza-accesso',
      KV_E2E_PASSWORD: 'password-finta-del-test-senza-accesso',
    },
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Il seed E2E richiede il database CI isolato')
  expect(result.stderr).not.toContain('RETE_VIETATA')
})
