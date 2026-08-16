import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · «non paga la retta» deve valere sulle DUE strade che generano le rette
//
// ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────
// La retta mensile si decide in due posti che devono dire la stessa cosa:
//   · l'ANTEPRIMA, in TypeScript — `GET /api/pagamenti/genera-rette`
//   · la CONFERMA, in SQL — la funzione `genera_rette_mensili`
// La route lo scrive da sé nel commento «LA SEDE DELLE RETTE»: fino al
// 2026-07-31 il GET filtrava per sede e il POST no, e la divergenza è costata
// rette generate per tutti i plessi da un pulsante che ne prometteva uno.
//
// Il 2026-08-16 è arrivata una seconda regola con la stessa forma: un bambino la
// cui retta è a carico di un fratello NON deve ricevere rette. Se il filtro
// vivesse su una strada sola, l'anteprima mostrerebbe alla segreteria un totale
// che la conferma non produce (o peggio, il contrario). Questo lock impedisce
// che una delle due si dimentichi domani.
//
// ─── COSA NON COPRE ────────────────────────────────────────────────────────
// È un lock TESTUALE: vede che entrambe le strade nominano `retta_a_carico_di`,
// non che lo usino bene. La prova che il filtro funziona davvero è nel database
// e sta scritta in coda alla migrazione. Un lock che promettesse di più
// mentirebbe.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const ROUTE = join(ROOT, 'src/app/api/pagamenti/genera-rette/route.ts')
const MIGRAZIONI = join(ROOT, 'supabase/migrations')

describe('la retta a carico di un fratello vale su entrambe le strade', () => {
  it('l\'anteprima TypeScript esclude gli alunni con retta_a_carico_di', () => {
    const src = readFileSync(ROUTE, 'utf8')
    expect(src).toContain('retta_a_carico_di')
    // Non basta selezionarla: la si deve usare per scartare. Si cerca la riga
    // che nomina la colonna E la confronta con null — se un domani il filtro
    // diventasse una query lato database, questa riga cambia e il lock lo dice.
    const righeFiltro = src
      .split('\n')
      .filter((r) => r.includes('retta_a_carico_di') && /==\s*null/.test(r))
    expect(righeFiltro.length).toBeGreaterThan(0)
  })

  it('una migrazione porta lo stesso filtro nella funzione SQL', () => {
    const file = readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql'))
    const conIlFiltro = file.filter((f) =>
      readFileSync(join(MIGRAZIONI, f), 'utf8').includes('retta_a_carico_di IS NULL'),
    )
    expect(conIlFiltro.length).toBeGreaterThan(0)
  })

  it('la colonna è dichiarata in migrazione, non comparsa dal nulla', () => {
    const file = readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql'))
    const dichiarata = file.some((f) =>
      /add column if not exists retta_a_carico_di/i.test(readFileSync(join(MIGRAZIONI, f), 'utf8')),
    )
    expect(dichiarata).toBe(true)
  })

  it('lo ZERO non viene usato come «non paga» da nessuna delle due strade', () => {
    // La formula COALESCE(NULLIF(importo, 0), default, 150) trasforma lo zero
    // nella retta di default della sede: chi scrivesse 0 per dire «gratis»
    // manderebbe 150 € al mese. Il gemello TypeScript fa la stessa cosa con
    // `personalizzato > 0 ? personalizzato : rettaDefault`, e deve continuare a
    // farla — è la ragione per cui serviva una colonna a parte.
    const src = readFileSync(ROUTE, 'utf8')
    expect(src).toMatch(/personalizzato\s*>\s*0\s*\?\s*personalizzato\s*:\s*rettaDefault/)
  })
})
