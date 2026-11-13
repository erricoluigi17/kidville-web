import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { creaBancoPassaggio, una, type BancoPassaggio } from '../helpers/passaggio-banco'

/**
 * COMPITO 4.9.0 · test di fumo dello scheletro della PR 4.9: le due testate di migrazione (M49a, M49b) si applicano in ordine dopo
 * l'ultima della 4.8, il banco parte, e nessuna delle due nomina l'uuid di una sede. Nessuna logica da provare: la riempiono i
 * compiti 4.9.1 e 4.9.2, che portano le loro prove.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
const SUFFISSI_IN_ORDINE = [
  '_anno_stati_automatici.sql', // M49a
  '_anno_passaggio_da_fare.sql', // M49b
]
const ULTIMA_DELLA_48 = '_anno_passaggio_conferma.sql'

let b: BancoPassaggio
beforeAll(async () => {
  b = await creaBancoPassaggio({ fino: 'M49b' })
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})

describe('le due testate della PR 4.9', () => {
  it('hanno le version in ordine a < b, tutte dopo l’ultima migrazione della 4.8', () => {
    const file = readdirSync(CARTELLA)
    const ultima48 = file.filter((f) => f.endsWith(ULTIMA_DELLA_48))
    expect(ultima48, `${ULTIMA_DELLA_48}: file trovati ${ultima48.length}`).toHaveLength(1)
    const version = SUFFISSI_IN_ORDINE.map((s) => {
      const trovati = file.filter((f) => f.endsWith(s))
      expect(trovati, `${s}: file trovati ${trovati.length}`).toHaveLength(1)
      return trovati[0].slice(0, 14)
    })
    expect(version.length).toBe(2)
    for (let i = 0; i < version.length; i++) {
      expect(version[i] > ultima48[0].slice(0, 14), `${version[i]} deve seguire la 4.8`).toBe(true)
      if (i > 0) expect(version[i] > version[i - 1], `${version[i - 1]} < ${version[i]}`).toBe(true)
    }
  })

  it('si applicano nell’ordine a, b e il banco parte', async () => {
    expect(await una<number>(b.db, `SELECT count(*)::int FROM public.anni_sede`)).toBeGreaterThan(0)
  })

  it('non nominano l’uuid di nessuna sede (i file sono pubblici, le sedi vere non si scrivono)', () => {
    const file = readdirSync(CARTELLA)
    const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
    let letti = 0
    for (const s of SUFFISSI_IN_ORDINE) {
      const nome = file.find((f) => f.endsWith(s)) as string
      const testo = readFileSync(join(CARTELLA, nome), 'utf8')
      letti++
      expect(testo.match(UUID), `${nome} contiene un uuid`).toBeNull()
    }
    expect(letti).toBe(2)
  })
})
