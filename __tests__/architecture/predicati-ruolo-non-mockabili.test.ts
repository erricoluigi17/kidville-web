import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * I PREDICATI SUI RUOLI STANNO IN UN POSTO SOLO, E QUEL POSTO NESSUNO LO MOCKA.
 *
 * ─── IL DIFETTO CHE QUESTO LOCK IMPEDISCE ──────────────────────────────────────
 *
 * Non è «qualcuno cambia un predicato»: è «qualcuno li rimette dentro
 * `require-staff.ts` perché sono cinque funzioncine», oppure «qualcuno se ne
 * ridichiara una copia in una route per non litigare coi mock». Sono e restano due
 * gesti ragionevoli visti da vicino, ed è per questo che serve un test.
 *
 * ─── PERCHÉ È UN PROBLEMA, CONTATO ─────────────────────────────────────────────
 *
 * **296 file** di test sostituiscono `@/lib/auth/require-staff` PER INTERO con una
 * factory `vi.mock`: è l'unico modo che hanno di iniettare un'identità, perché
 * `requireUser` fa I/O. Finché i predicati puri vivevano dentro quel modulo, quei
 * 296 file sostituivano anche la regola di autorizzazione. Misurato: importare
 * `eFamiglia` da `@/lib/auth/require-staff` dentro `require-parent.ts` faceva
 * diventare rossi **46 test su 7 file**, 40 con lo stesso errore —
 *   `No "eFamiglia" export is defined on the "@/lib/auth/require-staff" mock`
 * — e quattro di quei file non parlavano affatto di autorizzazione. Il rimedio è
 * `src/lib/auth/predicati-ruolo.ts`: nessun I/O, quindi nessun motivo di mockarlo.
 *
 * ─── LA PROVA DI SANITÀ, ESEGUITA E NON PROMESSA ───────────────────────────────
 *
 * Un lock che non si è mai visto fallire non è un lock. Cinque rotture provate a
 * mano il 2026-09-01, ognuna col suo esito OSSERVATO — non previsto:
 *
 *  1. `function eFamiglia(…)` ri-dichiarata in `require-parent.ts` (la copia appena
 *     rimossa) → ROSSO, con l'elenco esatto:
 *     `["src/lib/auth/require-parent.ts → eFamiglia"]`.
 *  2. `import { NextResponse } from 'next/server'` in `predicati-ruolo.ts` →
 *     ROSSO: `expected [ 'next/server' ] to deeply equal []`.
 *  3. `import { requireUser } from './require-staff'` in `predicati-ruolo.ts` →
 *     ROSSO su DUE asserzioni (l'I/O e il ciclo), come deve.
 *  4. la riga `export { agisceComeGenitore, eFamiglia, haRuolo, … }` tolta da
 *     `require-staff.ts` → ROSSO: «haRuolo deve restare raggiungibile da
 *     '@/lib/auth/require-staff'». È il contratto che tiene in piedi i 296 mock e
 *     i 37 import di tipo: non poteva restare affidato alla buona memoria.
 *  5. `vi.mock('@/lib/auth/predicati-ruolo', …)` aggiunto a un file di test →
 *     ROSSO: «nessun test mocka il modulo dei predicati».
 *
 * Ripristinate le righe, il file torna verde (7 su 7) ogni volta. Chi tocca questo
 * lock rifaccia le prove: sono due minuti, e sono la differenza fra un guardiano e
 * un commento lungo.
 */

/** I cinque predicati e i tre tipi che devono avere una sola casa. */
const PREDICATI = ['ruoliDi', 'haRuolo', 'haUnRuolo', 'agisceComeGenitore', 'eFamiglia'] as const
const TIPI = ['AppUser', 'AppRole', 'StaffRole'] as const

const SORGENTE = join('src', 'lib', 'auth', 'predicati-ruolo.ts')
const RIESPORTA = join('src', 'lib', 'auth', 'require-staff.ts')
/** Il primo call site che l'estrazione ha liberato: se torna a duplicare, si vede. */
const CALL_SITE = join('src', 'lib', 'auth', 'require-parent.ts')

/**
 * Ciò che un modulo importabile da una route, da un `'use client'` e da un test
 * NON mockato non può toccare. `next/` e `@supabase/` sono la richiesta esplicita;
 * il logger e i client stanno qui perché un predicato che scrive un log ha smesso
 * di essere puro, e chi lo importa senza mock si ritroverebbe l'I/O in un test.
 */
const IMPORT_VIETATI = [
  'next/',
  'next-intl',
  '@supabase/',
  '@/lib/supabase/',
  '@/lib/logging/',
  'server-only',
  'node:',
  'fs',
  'crypto',
  './require-staff',
  '@/lib/auth/require-staff',
]

const ESTENSIONI = ['.ts', '.tsx']

function fileSotto(dir: string): string[] {
  let out: string[] = []
  for (const voce of readdirSync(dir)) {
    if (voce === 'node_modules' || voce.startsWith('.')) continue
    const p = join(dir, voce)
    if (statSync(p).isDirectory()) out = out.concat(fileSotto(p))
    else if (ESTENSIONI.some((e) => voce.endsWith(e))) out.push(p)
  }
  return out
}

/** Il solo CODICE: la prosa deve poter nominare i predicati senza far scattare il lock. */
function codiceDi(percorso: string): string {
  return readFileSync(percorso, 'utf8')
    .split('\n')
    .filter((r) => !/^\s*(\*|\/\/|\/\*)/.test(r))
    .join('\n')
}

/** Gli specificatori importati a RUNTIME: `import type` è cancellato dal compilatore. */
function importRuntime(codice: string): string[] {
  const out: string[] = []
  // `import … from '…'` — escluso `import type …` (che non esiste a runtime).
  for (const m of codice.matchAll(/^\s*import\s+(?!type\s)([\s\S]*?)from\s+['"]([^'"]+)['"]/gm)) {
    // `import { type X, type Y }` è anch'esso interamente cancellato: conta solo se
    // c'è almeno un binding senza `type`.
    const bindings = m[1]
    const soloTipi =
      /^\s*\{[\s\S]*\}\s*$/.test(bindings) &&
      bindings
        .replace(/[{}]/g, '')
        .split(',')
        .filter((b) => b.trim().length > 0)
        .every((b) => /^\s*type\s/.test(b))
    if (!soloTipi) out.push(m[2])
  }
  for (const m of codice.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of codice.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  return out
}

describe('i predicati sui ruoli hanno una casa sola, e nessuno la mocka', () => {
  const sorgenti = fileSotto('src')
  const test = fileSotto('__tests__')

  it('trova i file da controllare (prova di sanità dell’inventario)', () => {
    // Senza questa asserzione, un `readdirSync` che restituisse una lista vuota
    // renderebbe VERDE tutto il resto: il lock guarderebbe il nulla e direbbe che
    // va tutto bene. È la lezione già scritta in `ritmo-email-un-posto-solo.test.ts`.
    expect(sorgenti.length).toBeGreaterThan(300)
    expect(test.length).toBeGreaterThan(500)
    expect(sorgenti).toContain(SORGENTE)
    expect(sorgenti).toContain(RIESPORTA)
    expect(sorgenti).toContain(CALL_SITE)
  })

  it('la scena esiste ancora: centinaia di test mockano `require-staff` per intero', () => {
    // Il numero non è decorazione: è la MISURA che giustifica l'estrazione. Se un
    // giorno scendesse a zero, questo lock avrebbe perso il suo motivo — e allora
    // andrebbe riletto, non cancellato in silenzio.
    // `codiceDi` e non `readFileSync`: la testata di questo file NOMINA il gesto
    // vietato per spiegarlo, e un lock che conta la propria prosa conta se stesso.
    // Al primo giro è successo davvero — vedi la nota qui sotto, nell'asserzione
    // gemella — ed è il rovescio esatto del difetto già pagato in questo repo, dove
    // un lock si era IMMUNIZZATO col proprio commento.
    const mockano = test.filter((f) => codiceDi(f).includes("vi.mock('@/lib/auth/require-staff'"))
    expect(mockano.length).toBeGreaterThan(200)
  })

  it('i cinque predicati sono dichiarati in `predicati-ruolo.ts` e in nessun altro file di `src/`', () => {
    const colpevoli: string[] = []
    for (const f of sorgenti) {
      if (f === SORGENTE) continue
      const codice = codiceDi(f)
      for (const nome of PREDICATI) {
        // `export function eFamiglia(`, `const eFamiglia = `, `let eFamiglia`…
        // Una RI-ESPORTAZIONE (`export { eFamiglia } from './predicati-ruolo'`) non
        // dichiara niente e non deve far scattare il lock: è il contratto che tiene
        // in piedi i 296 mock.
        if (new RegExp(`\\b(?:function|const|let|var)\\s+${nome}\\b`).test(codice)) {
          colpevoli.push(`${f} → ${nome}`)
        }
      }
    }
    expect(colpevoli, 'una regola scritta due volte è una regola che prima o poi diverge').toEqual([])
  })

  it('il modulo puro non importa niente di server, di rete o di I/O', () => {
    // `codiceDi`: la testata di `predicati-ruolo.ts` parla per esteso di ciò che NON
    // deve importare, e un lock che legge la prosa accusa chi la scrive.
    const importati = importRuntime(codiceDi(SORGENTE))
    const vietati = importati.filter((spec) =>
      IMPORT_VIETATI.some((v) => spec === v || spec.startsWith(v)),
    )
    expect(
      vietati,
      'deve restare importabile da una route, da un `use client` e da un test NON mockato',
    ).toEqual([])
  })

  it('e in particolare non risale a `require-staff`: sarebbe un ciclo, e riporterebbe l’I/O', () => {
    expect(importRuntime(codiceDi(SORGENTE)).filter((s) => s.includes('require-staff'))).toEqual([])
  })

  it('nessun test mocka il modulo dei predicati', () => {
    // È la proprietà, detta nella forma in cui si può misurare. Il giorno in cui
    // qualcuno lo mocka, i predicati tornano a essere sostituibili per sbaglio e
    // tutta l'estrazione non serve più a niente.
    //
    // ⚠️ SI GUARDA IL CODICE, NON LA PROSA — e non è una precauzione teorica: alla
    // prima esecuzione questo test è fallito accusando SE STESSO, perché la testata
    // qui sopra cita per esteso il gesto che vieta. Il rimedio giusto NON era
    // escludersi dall'elenco (sarebbe l'immunizzazione già pagata altrove in questo
    // repo): è distinguere una riga di commento da una riga di codice, che è la
    // stessa distinzione fatta per `src/`.
    const colpevoli = test.filter((f) => /vi\.mock\(\s*['"]@\/lib\/auth\/predicati-ruolo['"]/.test(codiceDi(f)))
    expect(colpevoli).toEqual([])
  })

  it('`require-staff.ts` continua a ri-esportare i cinque predicati e i tre tipi', () => {
    // La retro-compatibilità è il patto che ha reso l'estrazione indolore: 37 file
    // importano `type AppUser`/`AppRole` da `require-staff`, e 296 lo mockano. Se
    // la ri-esportazione sparisse, non si romperebbe un test: se ne romperebbero
    // centinaia, tutti con un errore che non nomina questo file.
    // (La verifica FUNZIONALE — che siano davvero le funzioni giuste — sta in
    // `__tests__/lib/auth/ruolo-attivo.test.ts`, che li importa da lì e li usa.)
    const codice = codiceDi(RIESPORTA)
    for (const nome of PREDICATI) {
      expect(codice, `${nome} deve restare raggiungibile da '@/lib/auth/require-staff'`).toMatch(
        new RegExp(`export\\s*\\{[^}]*\\b${nome}\\b[^}]*\\}\\s*from\\s*['"]\\./predicati-ruolo['"]`),
      )
    }
    for (const nome of TIPI) {
      expect(codice, `il tipo ${nome} deve restare raggiungibile da '@/lib/auth/require-staff'`).toMatch(
        new RegExp(`export\\s+type\\s*\\{[^}]*\\b${nome}\\b[^}]*\\}\\s*from\\s*['"]\\./predicati-ruolo['"]`),
      )
    }
  })
})
