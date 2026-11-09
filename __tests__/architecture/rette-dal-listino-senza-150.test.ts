import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · PR 4.6 · le rette e i servizi vengono dal LISTINO e dalle FREQUENZE dell'anno, mai da un numero scritto nel codice.
 *
 * ─── PERCHÉ ──────────────────────────────────────────────────────────────────────────────────────
 * Fino alla 4.6 la retta di un bambino era «la sua, altrimenti il default di sede, altrimenti 150»: un 150 scritto nel corpo
 * della funzione SQL e uno gemello in TypeScript. Per un anno in preparazione, con il suo listino, era un numero inventato che
 * finiva sulle fatture. E «iscritto» si leggeva da `alunni.stato`, cioè da OGGI: i bambini dell'anno prossimo non c'erano.
 *
 * ─── COME SI GUARDA ──────────────────────────────────────────────────────────────────────────────
 * Le funzioni si ridefiniscono a ogni migrazione, e ciò che vale è l'ULTIMA definizione per nome di file (= `version`). Un lock che
 * leggesse la prima (o tutte) si arrabbierebbe con la storia: la definizione di luglio ha il 150 per sempre, ed è giusto. Per
 * questo il lock dichiara quanti file ha guardato e quale ha scelto: se domani nessuna migrazione definisse più la funzione, il lock
 * non resterebbe verde su zero file.
 *
 * ─── COSA NON COPRE ──────────────────────────────────────────────────────────────────────────────
 * È testuale: vede che il numero non c'è, non che l'importo giusto arrivi. Quello lo provano i test su PGlite
 * (`__tests__/db/anno-rette-listino.test.ts`). La strada storica della route (database senza schema dell'anno) conserva il suo
 * ripiego di sempre di proposito: qui si sorveglia la strada NUOVA.
 */

const ROOT = process.cwd()
const MIGRAZIONI = join(ROOT, 'supabase/migrations')

/** Le funzioni che la 4.6 ha tolto dal cablaggio. */
const FUNZIONI = ['genera_rette_mensili', 'genera_rette_anno', 'rette_da_generare', 'servizi_da_generare', 'genera_servizi_anno'] as const

const senzaCommenti = (sql: string) => sql.replace(/--.*$/gm, '')

/** Ogni `CREATE [OR REPLACE] FUNCTION public.<nome>(` di un file, fino alla definizione successiva (o alla fine). */
function definizioni(sql: string, nome: string): string[] {
  const pezzi = sql.split(/(?=CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.)/i)
  return pezzi.filter((p) => new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${nome}\\s*\\(`, 'i').test(p))
}

function ultimaVersione(nome: string): { file: string; guardati: number; testi: string[] } {
  const file = readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()
  const conDefinizione = file.filter((f) => definizioni(readFileSync(join(MIGRAZIONI, f), 'utf8'), nome).length > 0)
  expect(conDefinizione.length, `nessuna migrazione definisce ${nome}: il lock non guarderebbe niente`).toBeGreaterThan(0)
  const ultimo = conDefinizione[conDefinizione.length - 1]
  return { file: ultimo, guardati: conDefinizione.length, testi: definizioni(readFileSync(join(MIGRAZIONI, ultimo), 'utf8'), nome).map(senzaCommenti) }
}

describe('le funzioni SQL delle rette: l’ultima definizione non ha numeri cablati', () => {
  for (const nome of FUNZIONI) {
    it(`${nome}: né 150, né il default di sede, né «iscritto» di oggi`, () => {
      const { file, guardati, testi } = ultimaVersione(nome)
      expect(testi.length, `${nome} in ${file}`).toBeGreaterThan(0)
      for (const testo of testi) {
        const dove = `${nome} (ultima di ${guardati} migrazioni: ${file})`
        expect(testo, `${dove}: un 150 scritto nel corpo`).not.toMatch(/\b150\b/)
        expect(testo, `${dove}: legge ancora il default di sede`).not.toMatch(/retta_default_importo/)
        expect(testo, `${dove}: «iscritto» si legge da alunni.stato, cioè da oggi`).not.toMatch(/\bal\.stato\s*=\s*'iscritto'|\ba\.stato\s*=\s*'iscritto'/)
      }
    })
  }

  it('il lock sa leggere: trova la definizione di rette_da_generare e vede il listino', () => {
    const { testi } = ultimaVersione('rette_da_generare')
    expect(testi.join('\n')).toMatch(/listino_voci/)
  })
})

describe('il TypeScript della strada nuova non ha un importo di ripiego', () => {
  const sorgente = (percorso: string) => senzaCommenti(readFileSync(join(ROOT, percorso), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('rette-anno.ts non ripiega su 150 né sul default di sede', () => {
    const src = sorgente('src/lib/pagamenti/rette-anno.ts')
    expect(src).not.toMatch(/\?\?\s*150\b|\|\|\s*150\b/)
    expect(src).not.toMatch(/retta_default_importo/)
  })

  it('l’anteprima dal listino (anteprimaDalListino) non ripiega su 150', () => {
    const intero = readFileSync(join(ROOT, 'src/app/api/pagamenti/genera-rette/route.ts'), 'utf8')
    const da = intero.indexOf('async function anteprimaDalListino')
    const a = intero.indexOf('// GET /api/pagamenti/genera-rette')
    expect(da, 'anteprimaDalListino non trovata: il lock non guarderebbe niente').toBeGreaterThan(-1)
    expect(a).toBeGreaterThan(da)
    const corpo = intero.slice(da, a).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(corpo).not.toMatch(/\b150\b/)
    expect(corpo).not.toMatch(/retta_default_importo/)
  })

  it('il pannello Genera rette non mostra un 150 inventato', () => {
    const src = sorgente('src/components/features/admin/pagamenti/GeneratoreRette.tsx')
    expect(src).not.toMatch(/\?\?\s*150\b/)
  })

  it('Impostazioni non scrive più retta_default_importo: la retta si decide nel listino dell’anno', () => {
    const route = readFileSync(join(ROOT, 'src/app/api/admin/settings/route.ts'), 'utf8')
    const lista = /const ALLOWED_FIELDS = \[([\s\S]*?)\]/.exec(route)
    expect(lista, 'ALLOWED_FIELDS non trovata').not.toBeNull()
    expect((lista as RegExpExecArray)[1]).not.toMatch(/retta_default_importo/)
    const pannello = sorgente('src/components/features/admin/settings/SettingsPanel.tsx')
    expect(pannello).not.toMatch(/JSON\.stringify\(\{[^}]*retta_default_importo/)
  })
})
