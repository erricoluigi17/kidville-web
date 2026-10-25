// @vitest-environment node
/**
 * Lock — DAL CODICE DEL REPO NESSUNO FA ESEGUIRE SQL QUALSIASI AL DATABASE.
 *
 * Robustezza, seconda serie, sessione 2 (problema D1 del rapporto del 20/10/2026). Fino a questa
 * sessione `public.exec_sql(sql text)` — SECURITY DEFINER, proprietario `postgres`, definita solo
 * nel baseline — eseguiva qualunque stringa per chi aveva la chiave di servizio: sei route
 * sigillate, cinque script e un file nella radice la chiamavano o la ricreavano. Con lei si
 * potevano anche accendere `registri.manutenzione`, `scatola_nera.manutenzione` e
 * `scatola_nera.senza_storico`, cioè spegnere i registri in sola aggiunta e la scatola nera.
 *
 * Il lock vieta che torni: la chiamata (`rpc('exec_sql')`, `/rpc/exec_sql`, `/pg/query`) o la
 * ricreazione (`CREATE FUNCTION exec_sql`) in `src/`, in `scripts/` e nei file della radice; e,
 * nelle migrazioni dopo il baseline, una funzione SECURITY DEFINER che prenda un argomento `sql`,
 * `query` o `istruzione` di tipo `text`.
 *
 * Il confine, detto: non vede SQL lanciato da fuori del repo (`psql`, l'editor del pannello) né
 * uno script che parli a Postgres con `DATABASE_URL`, che non passa da PostgREST.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RADICE = path.resolve(__dirname, '..', '..')

/** Le forme in cui il codice del repo chiamava, o ricreava, l'esecutore di SQL arbitrario. */
const CHIAMATE_VIETATE: ReadonlyArray<{ nome: string; re: RegExp }> = [
  { nome: "rpc('exec_sql')", re: /\.rpc\s*\(\s*['"`]exec_sql['"`]/ },
  { nome: '/rpc/exec_sql', re: /\/rpc\/exec_sql\b/ },
  { nome: '/pg/query', re: /\/pg\/query\b/ },
  { nome: 'CREATE FUNCTION exec_sql', re: /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?exec_sql\b/i },
]

function chiamateVietate(sorgente: string): string[] {
  return CHIAMATE_VIETATE.filter(({ re }) => re.test(sorgente)).map(({ nome }) => nome)
}

const ESTENSIONI = /\.(?:ts|tsx|js|jsx|mjs|cjs|sh|py)$/

function sorgentiSotto(cartella: string): string[] {
  const trovati: string[] = []
  for (const voce of fs.readdirSync(cartella, { withFileTypes: true })) {
    if (voce.name === 'node_modules' || voce.name.startsWith('.')) continue
    const percorso = path.join(cartella, voce.name)
    if (voce.isDirectory()) trovati.push(...sorgentiSotto(percorso))
    else if (ESTENSIONI.test(voce.name)) trovati.push(percorso)
  }
  return trovati
}

function colpevoli(file: string[]): string[] {
  return file
    .flatMap((f) => chiamateVietate(fs.readFileSync(f, 'utf8')).map((nome) => `${path.relative(RADICE, f)} → ${nome}`))
    .sort()
}

const PERCHE =
  '`exec_sql` non esiste più (robustezza, seconda serie, sessione 2). Una migrazione va in ' +
  '`supabase/migrations/` e la applica l’integrazione al merge; un dato si cambia con una route ' +
  'che dichiara la sua sede, non con SQL qualsiasi.'

describe('niente SQL arbitrario — il rilevatore', () => {
  it('prende le quattro forme', () => {
    expect(chiamateVietate("const { error } = await supabase.rpc('exec_sql', { sql })")).toEqual(["rpc('exec_sql')"])
    expect(chiamateVietate('await admin.rpc( "exec_sql" , { sql: q })')).toEqual(["rpc('exec_sql')"])
    expect(chiamateVietate('fetch(`${URL}/rest/v1/rpc/exec_sql`, { method: "POST" })')).toEqual(['/rpc/exec_sql'])
    expect(chiamateVietate("await fetch(url + '/pg/query', init)")).toEqual(['/pg/query'])
    expect(chiamateVietate('CREATE OR REPLACE FUNCTION public.exec_sql(sql text)')).toEqual(['CREATE FUNCTION exec_sql'])
  })

  it('non prende ciò che non è una chiamata', () => {
    expect(chiamateVietate("supabase.rpc('exec_sql_log', {})")).toEqual([])
    expect(chiamateVietate('// la funzione exec_sql è stata tolta')).toEqual([])
    expect(chiamateVietate("supabase.rpc('prossimo_numero_fattura')")).toEqual([])
  })
})

describe('niente SQL arbitrario — il codice', () => {
  it('in src/ nessuno chiama né ricrea exec_sql', () => {
    const file = sorgentiSotto(path.join(RADICE, 'src'))
    // Anti-cecità: un percorso sbagliato renderebbe verde un lock che non legge niente.
    expect(file.length, 'il lock non legge più src/').toBeGreaterThan(1000)
    expect(colpevoli(file), PERCHE).toEqual([])
  })
})
