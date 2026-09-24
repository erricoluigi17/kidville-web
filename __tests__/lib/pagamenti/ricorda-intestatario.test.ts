// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ricordaIntestatarioSullaScheda, ricordaPersonaSullaScheda } from '@/lib/pagamenti/intestatari'

/**
 * ─── «RICORDA CHI HA PAGATO» — la scrittura più delicata di tutto il lotto ───
 *
 * Il lotto emette fatture intestate al genitore RICONOSCIUTO dall'ordinante del
 * bonifico. Dal 2026-09-08, a emissione riuscita, quel nome viene anche scritto
 * sulla scheda del bambino, così la fattura successiva non deve più dedurlo.
 *
 * È una scrittura sull'anagrafica di un minore, decisa da un'euristica: le due
 * condizioni qui sotto non sono prudenza, sono il contratto.
 *
 *  1. NON SOVRASCRIVE MAI una scheda già compilata. E la condizione sta nella
 *     `WHERE` della UPDATE, non in una lettura fatta prima: fra la lettura e la
 *     scrittura una persona può aver compilato quella scheda a mano, e la sua
 *     scelta batte la nostra deduzione — sempre.
 *  2. NON ROMPE NIENTE se fallisce. La fattura è già partita verso lo SdI e non
 *     si può disfare: un errore qui è un `warn`, non un'eccezione.
 *
 * La PERSONA scritta a mano (consegna 2b, D1, `ricordaPersonaSullaScheda`) non ha
 * condizioni sulla scheda: la SOSTITUISCE, perché l'ha chiesto chi ha spuntato
 * «ricorda sulla scheda». La sua lettura fatta PRIMA serve solo al registro delle
 * scritture (il valore sostituito, la sede e la classe del bambino) e al perimetro di
 * sede (il bambino dev'essere in una delle sedi di chi ha accodato, come nella PATCH),
 * mai a decidere «scheda vuota sì o no».
 *
 * Misurato in produzione il 2026-09-08: dei 693 alunni, 516 hanno la colonna
 * `NULL` e NESSUNO ha il letterale jsonb `null` — quindi `.is(…, null)` è la
 * condizione giusta e non ne serve una seconda.
 */

/** Un client finto che REGISTRA la catena: è la catena, la cosa da collaudare. */
function clientFinto(risposta: { data?: unknown[] | null; error?: unknown }) {
  const visto: Record<string, unknown> = {}
  const catena = {
    update: (v: unknown) => { visto.update = v; return catena },
    eq: (col: string, val: unknown) => { visto.eq = [col, val]; return catena },
    is: (col: string, val: unknown) => { visto.is = [col, val]; return catena },
    select: (cols: string) => { visto.select = cols; return Promise.resolve({ data: risposta.data ?? null, error: risposta.error ?? null }) },
  }
  const from = vi.fn((tabella: string) => { visto.from = tabella; return catena })
  return { supabase: { from } as unknown as SupabaseClient, visto, from }
}

describe('ricordaIntestatarioSullaScheda', () => {
  it('scrive sulla scheda VUOTA, e la condizione «vuota» sta nella WHERE', async () => {
    const { supabase, visto } = clientFinto({ data: [{ id: 'al-1' }] })

    const { esito, error } = await ricordaIntestatarioSullaScheda(supabase, 'al-1', 'a-1')

    expect(esito).toBe('salvato')
    expect(error).toBe(null)
    expect(visto.from).toBe('alunni')
    expect(visto.update).toEqual({ intestatario_fatture: { tipo: 'adult', adult_id: 'a-1' } })
    expect(visto.eq).toEqual(['id', 'al-1'])
    // ⚠️ SENZA QUESTA RIGA il caso resterebbe verde su un'implementazione che legge
    // prima e scrive dopo — e che quindi può sovrascrivere una scheda compilata a
    // mano nel frattempo. La condizione DEVE viaggiare con la UPDATE.
    expect(visto.is).toEqual(['intestatario_fatture', null])
  })

  it('scheda già compilata: zero righe toccate ⇒ «gia_impostato», che non è un errore', async () => {
    const { supabase } = clientFinto({ data: [] })
    expect((await ricordaIntestatarioSullaScheda(supabase, 'al-1', 'a-1')).esito).toBe('gia_impostato')
  })

  it('PostgREST non lancia: l’errore si legge dal valore di ritorno', async () => {
    // AGENTS.md, regola 7. Un `try/catch` qui non scatterebbe mai.
    const { supabase } = clientFinto({ data: null, error: { code: '42703', message: 'colonna assente' } })
    const r = await ricordaIntestatarioSullaScheda(supabase, 'al-1', 'a-1')
    expect(r.esito).toBe('non_salvato')
    // ⚠️ L'ERRORE NON SI BUTTA VIA (AGENTS.md, regola 3): `42703` («colonna
    // assente», ambiente non migrato) e `42501` («policy») chiedono due interventi
    // diversi, e un'enumerazione a tre valori li fa uscire tutti e due come
    // «non salvato» — cioè come uno status senza il corpo.
    expect(r.error).toMatchObject({ code: '42703' })
  })

  it('il campo `nome` NON viene scritto: sarebbe una copia destinata a invecchiare', async () => {
    const { supabase, visto } = clientFinto({ data: [{ id: 'al-1' }] })
    await ricordaIntestatarioSullaScheda(supabase, 'al-1', 'a-1')
    expect(Object.keys((visto.update as { intestatario_fatture: object }).intestatario_fatture)).toEqual(['tipo', 'adult_id'])
  })
})

/**
 * ─── LA PERSONA SCRITTA A MANO (consegna 2b, D1) ──────────────────────────────────────
 *
 * Un finto SUO, e non quello di sopra: quello modella solo la catena della UPDATE (il suo
 * `select` è terminale), e questa funzione prima LEGGE. Qui ogni catena si registra, in
 * ordine — tabella, `select` con le colonne o `update` col corpo, `eq`, `is` — perché è
 * l'ORDINE la cosa da collaudare: la lettura serve al registro delle scritture, e fatta
 * dopo la UPDATE vi scriverebbe la persona nuova al posto di quella sostituita.
 */
interface CatenaVista {
  tabella: string
  select?: string
  update?: unknown
  eq?: [string, unknown]
  is?: [string, unknown]
  maybeSingle?: boolean
}

function clientConLettura(risposte: {
  lettura: { data: unknown; error: unknown }
  scrittura?: { data: unknown; error: unknown }
}) {
  const catene: CatenaVista[] = []
  const from = vi.fn((tabella: string) => {
    const vista: CatenaVista = { tabella }
    catene.push(vista)
    const catena = {
      update: (v: unknown) => { vista.update = v; return catena },
      eq: (col: string, val: unknown) => { vista.eq = [col, val]; return catena },
      is: (col: string, val: unknown) => { vista.is = [col, val]; return catena },
      select: (cols: string) => {
        vista.select = cols
        // Dopo una `update` il `select` chiude la catena e risponde la SCRITTURA; senza, la
        // catena continua fino a `maybeSingle()`, che risponde la LETTURA.
        if (vista.update !== undefined) {
          return Promise.resolve(risposte.scrittura ?? { data: [{ id: 'al-1' }], error: null })
        }
        return catena
      },
      maybeSingle: () => { vista.maybeSingle = true; return Promise.resolve(risposte.lettura) },
    }
    return catena
  })
  return { supabase: { from } as unknown as SupabaseClient, catene }
}

const DATI = {
  nome: 'Carlo',
  cognome: 'Perlini',
  cf: 'PRLCRL85M41H501Y',
  indirizzo: 'Via delle Prove 1',
  cap: '80014',
  comune: 'Giugliano in Campania',
}
const SCHEDA_PRIMA = {
  intestatario_fatture: { tipo: 'adult', adult_id: 'a-1' },
  scuola_id: '00000000-0000-4000-8000-000000008001',
  section_id: '00000000-0000-4000-8000-000000003200',
}
/** Le sedi di chi ha accodato: qui c'è quella del bambino. */
const SEDI = [SCHEDA_PRIMA.scuola_id]

describe('ricordaPersonaSullaScheda', () => {
  it('prima LEGGE la scheda, poi la SOSTITUISCE (nessun `is`): torna la riga letta per il registro', async () => {
    const { supabase, catene } = clientConLettura({ lettura: { data: SCHEDA_PRIMA, error: null } })

    const r = await ricordaPersonaSullaScheda(supabase, 'al-1', DATI, SEDI)

    expect(r).toEqual({ esito: 'salvato', error: null, prima: SCHEDA_PRIMA })
    expect(catene).toEqual([
      { tabella: 'alunni', select: 'intestatario_fatture, scuola_id, section_id', eq: ['id', 'al-1'], maybeSingle: true },
      { tabella: 'alunni', update: { intestatario_fatture: { tipo: 'altro', dati: DATI } }, eq: ['id', 'al-1'], select: 'id' },
    ])
    // ⚠️ SENZA QUESTA RIGA una copia della condizione dell'adulto («solo su scheda vuota»)
    // resterebbe verde: ma qui chi ha spuntato «ricorda» ha chiesto di sostituire.
    expect(catene[1].is).toBeUndefined()
  })

  it('lettura in errore ⇒ `non_salvato` con quell’errore, e NESSUNA scrittura', async () => {
    const errore = { code: '42501', message: 'permesso negato' }
    const { supabase, catene } = clientConLettura({ lettura: { data: null, error: errore } })

    const r = await ricordaPersonaSullaScheda(supabase, 'al-1', DATI, SEDI)

    expect(r).toEqual({ esito: 'non_salvato', error: errore })
    expect(catene.some((c) => c.update !== undefined)).toBe(false)
    expect(catene).toHaveLength(1)
  })

  it('lettura senza riga ⇒ `non_salvato` senza errore, e nessuna scrittura', async () => {
    const { supabase, catene } = clientConLettura({ lettura: { data: null, error: null } })

    const r = await ricordaPersonaSullaScheda(supabase, 'al-1', DATI, SEDI)

    expect(r).toEqual({ esito: 'non_salvato', error: null })
    expect(catene).toHaveLength(1)
    expect(catene[0].maybeSingle).toBe(true)
  })

  it('UPDATE in errore ⇒ `non_salvato` con l’errore (PostgREST non lancia)', async () => {
    const errore = { code: '42703', message: 'colonna assente' }
    const { supabase, catene } = clientConLettura({
      lettura: { data: SCHEDA_PRIMA, error: null },
      scrittura: { data: null, error: errore },
    })

    const r = await ricordaPersonaSullaScheda(supabase, 'al-1', DATI, SEDI)

    expect(r).toEqual({ esito: 'non_salvato', error: errore })
    expect(catene).toHaveLength(2)
  })

  it('UPDATE a zero righe ⇒ `non_salvato`, senza errore', async () => {
    const { supabase } = clientConLettura({
      lettura: { data: SCHEDA_PRIMA, error: null },
      scrittura: { data: [], error: null },
    })

    expect(await ricordaPersonaSullaScheda(supabase, 'al-1', DATI, SEDI)).toEqual({ esito: 'non_salvato', error: null })
  })

  /*
   * ⚠️ IL PERIMETRO DI SEDE (correzione del giro 1). La PATCH del browser che questa funzione
   * sostituisce passava da `assertAlunnoInScope`: 403 «alunno fuori dal tuo plesso». Il giro
   * della coda controlla la sede del PAGAMENTO, non quella del bambino, e dopo un trasferimento
   * i pagamenti vecchi restano nella sede di partenza. Senza questo confronto una segreteria
   * riscriverebbe l'intestatario della detrazione di un bambino che ora è di un altro plesso.
   */
  it('bambino FUORI dalle sedi di chi ha accodato ⇒ `fuori_sede`: solo la lettura, NESSUNA scrittura', async () => {
    const { supabase, catene } = clientConLettura({ lettura: { data: SCHEDA_PRIMA, error: null } })

    const r = await ricordaPersonaSullaScheda(supabase, 'al-1', DATI, ['00000000-0000-4000-8000-000000008000'])

    expect(r).toEqual({ esito: 'fuori_sede', error: null })
    expect(catene).toHaveLength(1)
    expect(catene[0].maybeSingle).toBe(true)
    expect(catene.some((c) => c.update !== undefined)).toBe(false)
  })

  it('nessuna sede nota (lettura del ponte fallita, fail-closed) ⇒ `fuori_sede`, nessuna scrittura', async () => {
    const { supabase, catene } = clientConLettura({ lettura: { data: SCHEDA_PRIMA, error: null } })

    expect(await ricordaPersonaSullaScheda(supabase, 'al-1', DATI, [])).toEqual({ esito: 'fuori_sede', error: null })
    expect(catene).toHaveLength(1)
  })

  it('la sede si CONFRONTA, non si paragona come stringa: la propria in maiuscolo resta la propria', async () => {
    const { supabase, catene } = clientConLettura({ lettura: { data: SCHEDA_PRIMA, error: null } })

    const r = await ricordaPersonaSullaScheda(supabase, 'al-1', DATI, [SCHEDA_PRIMA.scuola_id.toUpperCase()])

    expect(r.esito).toBe('salvato')
    expect(catene).toHaveLength(2)
  })
})
