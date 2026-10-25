import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import { eseguiQualita } from '@/lib/health/controlli'

/**
 * `sezione-testo-allineato` OLTRE `max_rows` (robustezza 2, sessione 11).
 *
 * Il controllo legge gli iscritti di TUTTE le sedi (è una sonda di qualità, senza filtro di sede).
 * Oltre 1000 PostgREST ne consegnava i primi 1000, e il controllo diceva «allineati» senza aver
 * guardato gli altri: un verde falso, la forma di silenzio che questo endpoint esiste per togliere.
 * Il finto con `maxRighe: 1000` fa ciò che fa PostgREST.
 */

const uuid = (prefisso: string, i: number) => `${prefisso}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`

function db(divergentiInCoda: number): DBFinto {
  const n = 1200
  return {
    sections: [{ id: 's1', name: 'Sezione A' }],
    alunni: Array.from({ length: n }, (_, i) => ({
      id: uuid('a', i),
      section_id: 's1',
      // Le divergenze stanno IN CODA, oltre il millesimo: una lettura troncata non le vede.
      classe_sezione: i >= n - divergentiInCoda ? 'Sezione B' : 'Sezione A',
      stato: 'iscritto',
    })),
  }
}

describe('controllo `sezione-testo-allineato` — oltre le 1000 righe', () => {
  it('vede le divergenze oltre il millesimo iscritto', async () => {
    const salute = await eseguiQualita(creaFintoSupabase(db(5), [], { maxRighe: 1000 }))
    const c = salute.controlli.find((x) => x.nome === 'sezione-testo-allineato')
    expect(c?.esito).toBe('degradato')
    expect(c?.dettaglio).toBe('5 alunni col testo classe divergente')
  })

  it('senza divergenze conta TUTTI gli iscritti, non i primi 1000', async () => {
    const salute = await eseguiQualita(creaFintoSupabase(db(0), [], { maxRighe: 1000 }))
    // Per nome e non per posizione: un controllo aggiunto a `eseguiQualita` non deve spostare la prova.
    const c = salute.controlli.find((x) => x.nome === 'sezione-testo-allineato')
    expect(c).toMatchObject({ esito: 'ok', dettaglio: '1200 iscritti allineati' })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * Le strade che il finto non sa imitare: un blocco SUCCESSIVO che cade, il tetto, l'ordine di
 * ogni blocco. Qui la sorgente è una tabella finta che risponde a `range` come PostgREST (mai
 * più di 1000 righe per richiesta) e registra le colonne di `order` di ogni blocco.
 * ════════════════════════════════════════════════════════════════════════════ */

type RigaFinta = Record<string, unknown>
type Risposta = { data: RigaFinta[] | null; error: { code: string; message: string } | null }
/** `blocco` conta da 0: 0 = le prime 1000 righe, 1 = le seconde, e così via. */
type Sorgente = (blocco: number, da: number, a: number) => Risposta

/** Una tabella che serve le sue righe a fette di `range`, come farebbe PostgREST. */
const daRighe =
  (righe: RigaFinta[]): Sorgente =>
  (_blocco, da, a) => ({ data: righe.slice(da, a + 1), error: null })

/** Come `base`, ma il blocco `quale` risponde `{ error }` (PostgREST non lancia: ritorna l'errore). */
const conGuastoAlBlocco =
  (base: Sorgente, quale: number): Sorgente =>
  (blocco, da, a) =>
    blocco === quale
      ? { data: null, error: { code: '57014', message: 'canceling statement: valore segreto 12345' } }
      : base(blocco, da, a)

/** Un client che sa solo ciò che il controllo usa: `from().select().eq().order().range()`. */
function clientConSorgenti(sorgenti: Record<string, Sorgente>, ordini: Record<string, string[][]>): SupabaseClient {
  const from = (tabella: string) => {
    const colonne: string[] = []
    const q = {
      select: () => q,
      eq: () => q,
      order: (colonna: string) => {
        colonne.push(colonna)
        return q
      },
      range: (da: number, a: number) => {
        ;(ordini[tabella] ??= []).push([...colonne])
        return Promise.resolve(sorgenti[tabella](Math.floor(da / 1000), da, a))
      },
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

const sezioniN = (n: number): RigaFinta[] =>
  Array.from({ length: n }, (_, i) => ({ id: uuid('5', i), name: `Sezione ${i}` }))

/** `n` iscritti tutti allineati alla sezione `indiceSezione`, tranne quelli di `divergenti`. */
const iscrittiN = (n: number, indiceSezione = 0, divergenti: ReadonlySet<number> = new Set()): RigaFinta[] =>
  Array.from({ length: n }, (_, i) => ({
    section_id: uuid('5', indiceSezione),
    classe_sezione: divergenti.has(i) ? 'Sezione storta' : `Sezione ${indiceSezione}`,
  }))

async function controllo(client: SupabaseClient) {
  const salute = await eseguiQualita(client)
  const c = salute.controlli.find((x) => x.nome === 'sezione-testo-allineato')
  return { c, salute }
}

describe('controllo `sezione-testo-allineato` — blocchi che cadono, tetto, ordine', () => {
  it('un blocco SUCCESSIVO degli iscritti caduto è degradato col solo codice, mai «ok» per lettura parziale', async () => {
    const ordini: Record<string, string[][]> = {}
    const { c, salute } = await controllo(
      clientConSorgenti(
        {
          sections: daRighe(sezioniN(3)),
          // 2500 iscritti = tre blocchi; il secondo cade. Il primo (1000 allineati) NON basta per dire «ok».
          alunni: conGuastoAlBlocco(daRighe(iscrittiN(2500)), 1),
        },
        ordini,
      ),
    )
    expect(c?.esito).toBe('degradato')
    expect(c?.dettaglio).toBe('alunni:57014')
    // Dal guasto esce il codice e basta: né il messaggio del database, né numeri di righe lette.
    expect(JSON.stringify(salute)).not.toContain('segreto')
    expect(JSON.stringify(salute)).not.toContain('12345')
  })

  it('un blocco SUCCESSIVO delle sezioni caduto è degradato col solo codice, e gli iscritti non vengono nemmeno letti', async () => {
    const ordini: Record<string, string[][]> = {}
    const { c } = await controllo(
      clientConSorgenti(
        {
          sections: conGuastoAlBlocco(daRighe(sezioniN(1200)), 1),
          alunni: daRighe(iscrittiN(10)),
        },
        ordini,
      ),
    )
    expect(c).toMatchObject({ esito: 'degradato', dettaglio: 'sections:57014' })
    expect(ordini.alunni).toBeUndefined()
  })

  it('oltre il tetto di `leggiABlocchi` gli iscritti sono degradato `alunni:tetto`, non un verde sulle prime 50.000 righe', async () => {
    const ordini: Record<string, string[][]> = {}
    const pieno = iscrittiN(1000)
    const { c } = await controllo(
      clientConSorgenti(
        {
          sections: daRighe(sezioniN(3)),
          // Una tabella che non finisce mai: ogni blocco è pieno, anche la riga di prova del tetto.
          alunni: () => ({ data: pieno, error: null }),
        },
        ordini,
      ),
    )
    expect(c).toMatchObject({ esito: 'degradato', dettaglio: 'alunni:tetto' })
  })

  it('oltre il tetto di `leggiABlocchi` le sezioni sono degradato `sections:tetto`', async () => {
    const ordini: Record<string, string[][]> = {}
    const piene = Array.from({ length: 1000 }, (_, i) => ({ id: uuid('5', i), name: `Sezione ${i}` }))
    const { c } = await controllo(
      clientConSorgenti(
        { sections: () => ({ data: piene, error: null }), alunni: daRighe(iscrittiN(10)) },
        ordini,
      ),
    )
    expect(c).toMatchObject({ esito: 'degradato', dettaglio: 'sections:tetto' })
    expect(ordini.alunni).toBeUndefined()
  })

  it('la mappa delle sezioni non si ferma al millesimo: un iscritto in una sezione oltre le 1000 è confrontato', async () => {
    const ordini: Record<string, string[][]> = {}
    const { c } = await controllo(
      clientConSorgenti(
        {
          // 1200 sezioni: una mappa troncata a 1000 non conoscerebbe la sezione 1150, e l'iscritto
          // storto passerebbe per «orfano di nome» (nome === undefined) senza essere contato.
          sections: daRighe(sezioniN(1200)),
          alunni: daRighe([...iscrittiN(3, 0), ...iscrittiN(1, 1150, new Set([0]))]),
        },
        ordini,
      ),
    )
    expect(c).toMatchObject({ esito: 'degradato', dettaglio: '1 alunni col testo classe divergente' })
  })

  it('ogni blocco, di sezioni e di iscritti, è ordinato per `id` (la chiave unica), e il conteggio è su TUTTE le righe', async () => {
    const ordini: Record<string, string[][]> = {}
    const { c } = await controllo(
      clientConSorgenti({ sections: daRighe(sezioniN(1200)), alunni: daRighe(iscrittiN(2500)) }, ordini),
    )
    expect(c).toMatchObject({ esito: 'ok', dettaglio: '2500 iscritti allineati' })
    // 1200 sezioni = 2 blocchi, 2500 iscritti = 3 blocchi: ognuno con `order('id')` e nient'altro.
    expect(ordini.sections).toEqual([['id'], ['id']])
    expect(ordini.alunni).toEqual([['id'], ['id'], ['id']])
  })
})
