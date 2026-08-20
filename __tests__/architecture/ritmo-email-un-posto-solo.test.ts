import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK — il passo fra due email vive in un posto solo
//
// Fino al 2026-08-20 la pausa era scritta a mano in QUATTRO punti: 550 ms in
// `import-massivo/route.ts`, in `esegui.ts` e in `inviti.ts`, e 500 ms in
// `news/digest.ts` — con lo stesso commento copiato («~2 al secondo, il limite
// del provider»). Quattro copie della stessa regola divergono al primo ritocco,
// perché chi tocca un file solo non sa che gli altri tre esistono.
//
// E il ritocco è già arrivato: col passaggio a Resend Pro il vincolo è cambiato
// da «100 email al giorno» a «10 richieste al secondo PER TEAM». Per team vuol
// dire che il numero non è più un affare privato di questo giro: se l'import
// spedisce troppo in fretta, il 429 lo prende la candidatura che sta arrivando
// in quel momento — e in `copia-alla-sede.ts` un 429 è una copia persa.
//
// LA PROVA. Nessun file di `src/` che spedisca email può contenere un
// `setTimeout` con un'attesa scritta a mano: si usa `pausaFraEmail()`.
//
// LA PROVA DI SANITÀ, obbligatoria: se nessuno importa il modulo, questo lock
// sta guardando il vuoto e va considerato rotto.
// ─────────────────────────────────────────────────────────────────────────────

const CASA = 'src/lib/email/ritmo.ts'
/** Un'attesa scritta a mano: `setTimeout(r, 550)`, `setTimeout(fn, 500)`. */
const ATTESA_A_MANO = /setTimeout\(\s*[^,]+,\s*\d{2,}\s*\)/

function tsDi(dir: string, out: string[] = []): string[] {
  for (const v of readdirSync(dir)) {
    const p = join(dir, v)
    if (statSync(p).isDirectory()) tsDi(p, out)
    else if (/\.tsx?$/.test(v)) out.push(p)
  }
  return out
}

describe('LOCK — un solo passo fra le email', () => {
  const file = tsDi('src').map((p) => relative(process.cwd(), p))

  it('chi spedisce email non scrive attese a mano', () => {
    const colpevoli = file.filter((p) => {
      if (p === CASA) return false
      const s = readFileSync(p, 'utf8')
      const spedisce = /sendEmailDetailed|invitaGenitore|\bspedisci\(/.test(s)
      return spedisce && ATTESA_A_MANO.test(s)
    })
    expect(
      colpevoli,
      `attesa scritta a mano accanto a un invio in: ${colpevoli.join(', ')} — si usa pausaFraEmail()`,
    ).toEqual([])
  })

  it('PROVA DI SANITÀ: almeno quattro file usano il passo condiviso', () => {
    const utenti = file.filter((p) => /from '@\/lib\/email\/ritmo'/.test(readFileSync(p, 'utf8')))
    expect(utenti.length).toBeGreaterThanOrEqual(4)
  })

  it('la firma cercata riconosce davvero un\'attesa a mano (controllo negativo)', () => {
    expect(ATTESA_A_MANO.test('await new Promise((r) => setTimeout(r, 550))')).toBe(true)
    expect(ATTESA_A_MANO.test('setTimeout(r, 500)')).toBe(true)
    // un timeout di pochi ms (debounce, microtask) non è un ritmo di invio
    expect(ATTESA_A_MANO.test('setTimeout(r, 0)')).toBe(false)
  })
})
