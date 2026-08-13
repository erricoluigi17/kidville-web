import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// LA RIGA ARCHIVIATA VISTA DA `/api/admin/students` — la rotta generalista.
//
// Le due rotte dedicate (`archivia`, `riattiva`) hanno i loro file. Questo tiene
// ferme le DUE cose che il modello a due tempi appoggia sulla rotta di sempre, e
// che la revisione del 2026-08-13 ha misurato mancanti.
//
// ─── 1. LA SECONDA PORTA DEL RITORNO (era [GRAVE]) ───────────────────────────
// La tendina «Stato» della scheda offre `<option value="iscritto">` su OGNI
// scheda, archiviati compresi, e la PATCH tiene `stato` in `allowedFields` senza
// toccare né `archiviato_*` né `classe_sezione`. Eseguito davvero contro la
// rotta: `PATCH {stato:'iscritto'}` su una riga archiviata → **200**, e la riga
// risultante era `{stato:'iscritto', archiviato_il:<valorizzato>, section_id:null,
// classe_sezione:null}`. Cioè un bambino ISCRITTO e senza classe: fuori da
// registro, appello, mensa, diario e valutazioni (le query per sezione, che sono
// la maggioranza) e fuori anche dalla linguetta «Non più iscritti», che filtra
// `stato=ritirato`. Restava solo nell'anagrafica piatta. Nessun log, nessun
// avviso, nessun test rosso — ed è il danno esatto che il modello dichiara di
// voler evitare, a un clic dal bottone «Apri scheda» dell'elenco nuovo.
//
// ─── 2. LA PROIEZIONE DA CUI L'ELENCO PRENDE I DATI (era [MINORE]) ───────────
// Togliendo `'archiviato_il'` da `cols` restavano verdi 5441 test: spariva la
// colonna «Archiviato il», spariva l'unico modo di distinguere «archiviato» da
// «`stato` messo a mano dalla tendina», e la vista degradava in silenzio in
// «Data non registrata» — la stessa cella con cui il codice segnala il DB non
// migrato della CI. Due cause diverse rese indistinguibili.
//
// ⚠️ IL TEST DELLA PROIEZIONE È COMPORTAMENTALE, e non poteva essere ovvio: il
// finto client NON emula la proiezione di `select()` (lo dichiara nella sua
// testata), quindi «quel campo non è stato selezionato» non è osservabile dalle
// righe. Si misura invece dal CICLO DI DEGRADO della rotta, che è governato da
// `cols.includes(col)`: si inietta un `42703` che nomina `archiviato_il` sulla
// PRIMA lettura e lo si toglie prima della seconda.
//   · con la colonna in proiezione → la rotta la toglie, RIPETE e risponde 200;
//   · senza                        → `cols.includes` è falso, il ciclo esce e
//                                     la rotta risponde 500.
// 200 contro 500 su un solo bit: è la colonna in `cols`.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const GM_A = '44444444-4444-4444-8444-aaaaaaaaaaaa'
const ARCHIVIATO_IL = '2026-08-01T10:00:00.000Z'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const opzioni = () => ({ scritture: h.scritture as Scrittura[], errori: h.errori })
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, opzioni()),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, opzioni()),
  }
})

import { GET, PATCH } from '@/app/api/admin/students/route'

const get = (qs = '') => new NextRequest(`http://localhost/api/admin/students${qs}`)
const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/students', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  utenti_sezioni: [],
  sections: [{ id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI' }],
  gruppi_mensa: [{ id: GM_A, scuola_id: SEDE_A, nome: 'Turno Alfa' }],
  alunni: [
    {
      // Una riga IDENTICA a quella che `archivia` lascia in tabella: sganciata
      // dalla classe, con la memoria di dov'era. È il punto della sonda — un
      // fixture «quasi archiviato» proverebbe un'altra cosa.
      id: ALU_A,
      nome: 'Alfa',
      cognome: 'AaaSedeA',
      scuola_id: SEDE_A,
      section_id: null,
      classe_sezione: null,
      gruppo_mensa_id: null,
      stato: 'ritirato',
      note_mediche: 'NOTA-MEDICA-A',
      codice_fiscale: 'CODICEFINTO00001',
      archiviato_il: ARCHIVIATO_IL,
      archiviato_da: 'seg-1',
      archiviato_motivo: 'ritiro',
      archiviato_section_id: SEC_A,
      archiviato_classe_sezione: '2 ANNI',
      spazio_liberato_il: null,
    },
  ],
  registro_modifiche: [],
  audit_scritture_docente: [],
})

const riga = () => h.db.alunni.find((a) => a.id === ALU_A)
const scrittureSu = (tabella: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

/** Riporta la riga allo stato «frequenta», per i controlli positivi. */
const rendiIscritto = () => {
  const a = h.db.alunni[0]
  a.stato = 'iscritto'
  a.section_id = SEC_A
  a.classe_sezione = '2 ANNI'
  a.archiviato_il = null
  a.archiviato_section_id = null
  a.archiviato_classe_sezione = null
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('PATCH /api/admin/students — la tendina «Stato» non è una seconda strada di ritorno', () => {
  it('⚠️ 409 su `stato: iscritto` di un ARCHIVIATO, e la riga resta identica campo per campo', async () => {
    const res = await PATCH(patch({ id: ALU_A, stato: 'iscritto' }))

    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('STATO_ALUNNO_ARCHIVIATO')

    // ⚠️ INTATTA campo per campo, non «lo status è giusto»: un 409 che avesse
    // comunque scritto lo stato avrebbe prodotto il bambino iscritto e senza
    // classe — cioè il danno intero, con la risposta giusta.
    const a = riga()
    expect(a?.stato).toBe('ritirato')
    expect(a?.archiviato_il).toBe(ARCHIVIATO_IL)
    expect(a?.archiviato_classe_sezione).toBe('2 ANNI')
    expect(a?.section_id).toBeNull()
    expect(a?.classe_sezione).toBeNull()
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('⚠️ 409 anche su `sospeso`: sta dalla parte «ancora iscritto» del confine, quindi fa lo stesso danno', async () => {
    // `LATO_DEL_CONFINE` mette `sospeso` fra chi frequenta: scriverlo su un
    // archiviato lo toglierebbe dalla linguetta «Non più iscritti» (che filtra
    // `ritirato`) senza rimetterlo in nessun elenco per sezione. Rifiutare solo
    // `iscritto` avrebbe chiuso metà porta.
    const res = await PATCH(patch({ id: ALU_A, stato: 'sospeso' }))

    expect(res.status).toBe(409)
    expect(riga()?.stato).toBe('ritirato')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('il rifiuto non porta fuori nessun dato del minore', async () => {
    const testo = await (await PATCH(patch({ id: ALU_A, stato: 'iscritto' }))).text()
    expect(testo).not.toContain('NOTA-MEDICA-A')
    expect(testo).not.toContain('CODICEFINTO00001')
    expect(testo).not.toContain('AaaSedeA')
  })

  it('CONTROLLO POSITIVO — su un bambino NON archiviato la tendina funziona come sempre', async () => {
    // Senza questo, la guardia potrebbe rifiutare tutto e i test sopra sarebbero
    // verdi lo stesso. Il ritiro a mano dalla tendina resta una cosa legittima:
    // non sgancia nessuno, e `archivia` lo accetta poi senza 409.
    rendiIscritto()

    const res = await PATCH(patch({ id: ALU_A, stato: 'ritirato' }))

    expect(res.status).toBe(200)
    expect(riga()?.stato).toBe('ritirato')
    // …e non ha toccato la classe: è proprio la differenza fra le due strade.
    expect(riga()?.section_id).toBe(SEC_A)
  })

  it('CONTROLLO POSITIVO — su un archiviato si può ancora correggere l\'anagrafica', async () => {
    // La guardia ferma il CAMBIO di stato, non la scheda: un archiviato la cui
    // via è scritta male deve restare correggibile, altrimenti si è chiusa una
    // porta e murata una finestra.
    const res = await PATCH(patch({ id: ALU_A, residence_city: 'Giugliano in Campania' }))

    expect(res.status).toBe(200)
    expect(riga()?.residence_city).toBe('Giugliano in Campania')
    expect(riga()?.stato).toBe('ritirato')
  })

  it('CONTROLLO POSITIVO — salvare la scheda RIMANDANDO lo stesso stato non è un cambio', async () => {
    // La scheda salva il form intero: chi corregge un campo su un archiviato
    // rimanda `stato: 'ritirato'` senza volere niente. Trattarlo come un cambio
    // renderebbe la scheda di un archiviato non salvabile.
    const res = await PATCH(patch({ id: ALU_A, stato: 'ritirato', residence_city: 'Aversa' }))

    expect(res.status).toBe(200)
    expect(riga()?.residence_city).toBe('Aversa')
    expect(riga()?.archiviato_il).toBe(ARCHIVIATO_IL)
  })

  it('DB non migrato (CI): senza la colonna la guardia non scatta e la PATCH resta quella di sempre', async () => {
    // Il DB E2E della CI è un progetto separato e non migrato: là
    // `archiviato_il` non esiste, quindi `prima.archiviato_il` è `undefined` e
    // rifiutare sarebbe rifiutare a vuoto.
    delete h.db.alunni[0].archiviato_il

    const res = await PATCH(patch({ id: ALU_A, stato: 'iscritto' }))

    expect(res.status).toBe(200)
    expect(riga()?.stato).toBe('iscritto')
  })
})

describe('GET /api/admin/students — le colonne dell\'archiviazione sono in proiezione', () => {
  /**
   * Rompe la PRIMA lettura di `alunni` con un `42703` che nomina la colonna, e
   * la lascia guarita per la seconda. Il `push` avviene alla COSTRUZIONE del
   * builder e l'errore si legge all'esecuzione: perciò si toglie al secondo
   * `from('alunni')`, cioè quando il ciclo di degrado sta per ripetere.
   */
  function guastoSullaPrimaLettura(colonna: string): string[] {
    h.errori = { 'alunni:select': { code: '42703', message: `column alunni.${colonna} does not exist` } }
    const tabelle: string[] = []
    const push = tabelle.push.bind(tabelle)
    tabelle.push = (...voci: string[]) => {
      const esito = push(...voci)
      // MUTAZIONE, non riassegnazione: il finto client tiene il RIFERIMENTO
      // all'oggetto `errori` che gli è stato passato, e `h.errori = {}` non lo
      // raggiungerebbe.
      if (tabelle.filter((t) => t === 'alunni').length === 2) delete h.errori['alunni:select']
      return esito
    }
    return tabelle
  }

  it.each(['archiviato_il', 'archiviato_classe_sezione', 'spazio_liberato_il'])(
    '`%s` è in proiezione: la rotta la riconosce, la toglie e RIPETE invece di rispondere 500',
    async (colonna) => {
      const tabelle = guastoSullaPrimaLettura(colonna)
      h.tabelle = tabelle

      const res = await GET(get('?limit=1000'))

      expect(
        res.status,
        `la GET non ha riconosciuto \`${colonna}\` come una colonna PROPRIA: il ciclo di ` +
        'degrado è governato da `cols.includes(col)`, quindi un 500 qui significa che la ' +
        'colonna non è più in proiezione. Senza, l\'elenco dei «non più iscritti» perde la ' +
        'data e non distingue più un archiviato da uno `stato` messo a mano dalla tendina.',
      ).toBe(200)
      // Il controllo positivo della sonda: la seconda lettura è avvenuta davvero.
      expect(tabelle.filter((t) => t === 'alunni')).toHaveLength(2)
    },
  )

  it('CONTROLLO NEGATIVO: su una colonna che NON è in proiezione la stessa sonda dà 500', async () => {
    // Senza questa riga i tre test sopra sarebbero verdi anche se la rotta
    // ignorasse del tutto il `42703`. Qui la colonna è inventata: la rotta non la
    // trova in `cols`, esce dal ciclo e restituisce l'errore — che è esattamente
    // ciò che farebbe con `archiviato_il` se qualcuno la togliesse.
    h.tabelle = guastoSullaPrimaLettura('colonna_che_non_esiste')

    const res = await GET(get('?limit=1000'))

    expect(res.status).toBe(500)
  })

  it('l\'elenco `?stato=ritirato` restituisce le tre colonne alla vista dei «non più iscritti»', async () => {
    const res = await GET(get('?stato=ritirato&limit=1000'))

    expect(res.status).toBe(200)
    const lista = (await res.json()) as Record<string, unknown>[]
    expect(lista.map((a) => a.id)).toEqual([ALU_A])
    expect(lista[0].archiviato_il).toBe(ARCHIVIATO_IL)
    expect(lista[0].archiviato_classe_sezione).toBe('2 ANNI')
  })
})
