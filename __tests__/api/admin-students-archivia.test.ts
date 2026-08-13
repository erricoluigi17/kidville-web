import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// `POST /api/admin/students/archivia` — il primo tempo del modello a due tempi.
//
// ─── COSA QUESTO FILE ESISTE PER TENERE FERMO ────────────────────────────────
//
//  1. LO SGANCIAMENTO, che è la LEVA. `from('alunni')` compare 181 volte in 117
//     file e solo 12 filtrano `.eq('stato','iscritto')`: se `section_id` non
//     va a NULL il bambino resta in registro, appello e mensa con lo stato che
//     dice «ritirato», e nessuno se ne accorge. Il test guarda la RIGA nel finto
//     database, non la risposta.
//
//  2. `section_id` AZZERATO ESPLICITAMENTE. Il trigger `sync_alunno_section_id`
//     agisce solo quando `classe_sezione IS NOT NULL` (baseline, riga 881):
//     azzerare il nome NON azzera l'id. Il finto client non esegue trigger,
//     quindi qui si misura ciò che la ROUTE scrive — che è esattamente il punto.
//
//  3. LA MEMORIA DEL RITORNO. Senza `archiviato_section_id` e
//     `archiviato_classe_sezione` la riattivazione diventa un indovinello, e
//     «un bambino nella sezione sbagliata è invisibile a chi lo cerca in quella
//     giusta».
//
//  4. NIENTE `registro_modifiche`. È il difetto che ha lasciato in produzione
//     tre copie integrali dell'anagrafica di un minore: la DELETE ci riversava
//     dentro un `select *` PRIMA di sapere se la cancellazione sarebbe riuscita.
//     Qui l'audit passa da `logScrittura`, e il test lo pretende in entrambe le
//     direzioni: la riga d'audit c'è, quella in `registro_modifiche` no.
//
//  5. IL DEGRADO NON SI FA. Su un DB senza le sei colonne (è lo stato del DB
//     E2E della CI) la route RIFIUTA con 503 invece di scrivere metà UPDATE.
//     Un'archiviazione a metà è irreversibile; un 503 si ripete domani.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const SEC_B = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const GM_A = '44444444-4444-4444-8444-aaaaaaaaaaaa'

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

import { POST } from '@/app/api/admin/students/archivia/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/students/archivia', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  utenti_sezioni: [],
  sections: [
    { id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI' },
    { id: SEC_B, scuola_id: SEDE_B, name: '2 ANNI' },
  ],
  alunni: [
    {
      id: ALU_A, nome: 'Alfa', cognome: 'AaaSedeA', scuola_id: SEDE_A,
      section_id: SEC_A, classe_sezione: '2 ANNI', gruppo_mensa_id: GM_A,
      stato: 'iscritto', note_mediche: 'NOTA-MEDICA-A', codice_fiscale: 'CODICEFINTO00001',
      archiviato_il: null, archiviato_da: null, archiviato_motivo: null,
      archiviato_section_id: null, archiviato_classe_sezione: null, spazio_liberato_il: null,
    },
    {
      id: ALU_B, nome: 'Beta', cognome: 'CccSedeB', scuola_id: SEDE_B,
      section_id: SEC_B, classe_sezione: '2 ANNI', gruppo_mensa_id: null,
      stato: 'iscritto', note_mediche: 'NOTA-MEDICA-B', codice_fiscale: 'CODICEFINTO00002',
      archiviato_il: null, archiviato_da: null, archiviato_motivo: null,
      archiviato_section_id: null, archiviato_classe_sezione: null, spazio_liberato_il: null,
    },
  ],
  registro_modifiche: [],
  audit_scritture_docente: [],
})

/**
 * Rompe la lettura di `alunni` SOLO dalla SECONDA in poi.
 *
 * ─── PERCHÉ SERVE, invece di `{ 'alunni:select': … }` ───────────────────────
 * In questo handler le letture di `alunni` sono DUE, e il finto client indirizza
 * gli errori per tabella+operazione, non per query:
 *   1. quella del GATE (`assertAlunnoInScope`) chiede `id, section_id, scuola_id`
 *      — tre colonne del baseline, che su un DB non migrato ci sono e la lettura
 *      riesce;
 *   2. quella della ROUTE chiede anche `archiviato_il`, e su quel DB è l'UNICA a
 *      rispondere `42703`.
 * Iniettare sulla tabella romperebbe pure la prima: la route risponderebbe 500
 * «Verifica di scope non riuscita» e il test proverebbe il ramo del gate credendo
 * di provare quello della colonna assente. La differenza non è accademica — sono
 * due rimedi diversi (riprova / applica la migrazione) e due messaggi diversi
 * davanti a chi lavora in segreteria.
 *
 * `Object.keys` sul bersaglio vuoto resta vuoto, quindi `validaChiaviErrori` del
 * finto client non ha niente da validare e non lancia.
 */
function rompiLaSecondaLettura(errore: { code: string; message?: string }) {
  let viste = 0
  return new Proxy({} as Record<string, { code: string; message?: string }>, {
    get: (_bersaglio, chiave) => {
      if (chiave !== 'alunni:select') return undefined
      viste++
      return viste >= 2 ? errore : undefined
    },
  })
}

/**
 * SPOSTA L'ALUNNO DI PLESSO fra la LETTURA della route e il suo UPDATE.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * L'UPDATE porta `.in('scuola_id', plessi)` e la route lo dichiara difesa
 * INDIPENDENTE dal gate: «il gate impedisce di NOMINARE la riga altrui, il filtro
 * impedisce che una corsa fra il gate e la lettura ne faccia rientrare una».
 * Era una dichiarazione **scoperta**: misurato il 2026-08-13, togliendo quel
 * `.in(...)` dall'UPDATE i 15 test di questo file restavano tutti verdi. Un
 * presidio che nessun test difende è una promessa, non un presidio — e questo
 * riguarda la sede, cioè la cosa che con tre plessi in produzione non si può
 * sbagliare.
 *
 * Il filtro sulla LETTURA non basta a provarlo: nel finto database le due query
 * vedono la stessa riga nello stesso istante, quindi qualunque caso costruito con
 * la sola lettura si ferma prima di arrivare all'UPDATE. Serve la CORSA vera, e il
 * solo punto in cui il finto client la lascia inscenare è l'accumulatore dei
 * `from(...)`: la 3ª volta che si nomina `alunni` è l'UPDATE (1ª = il gate,
 * 2ª = la lettura della route), e lì la riga è già passata all'altro plesso.
 */
function spostaDiPlessoPrimaDellUpdate(alunnoId: string, nuovaSede: string): string[] {
  const tabelle: string[] = []
  const push = tabelle.push.bind(tabelle)
  tabelle.push = (...voci: string[]) => {
    const esito = push(...voci)
    if (tabelle.filter((t) => t === 'alunni').length === 3) {
      const a = h.db.alunni.find((r) => r.id === alunnoId)
      if (a) a.scuola_id = nuovaSede
    }
    return esito
  }
  return tabelle
}

/** La riga come sta ADESSO nel finto database (non la copia della risposta). */
const riga = (id: string) => h.db.alunni.find((a) => a.id === id)
const scrittureSu = (tabella: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  // Segreteria di SEDE_A: archiviare è un atto di segreteria, non di dirigenza.
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('POST /api/admin/students/archivia — isolamento di sede', () => {
  it('403 sull\'alunno di un\'altra sede: la riga resta INTATTA e non c\'è nessuna scrittura', async () => {
    const res = await POST(post({ alunno_id: ALU_B }))
    const testo = await res.text()

    expect(res.status).toBe(403)
    // Nessun dato del minore esce dal diniego.
    expect(testo).not.toContain('NOTA-MEDICA-B')
    expect(testo).not.toContain('CODICEFINTO00002')

    // ⚠️ INTATTA vuol dire campo per campo: un 403 che avesse comunque sganciato
    // il bambino dalla sua sezione lo avrebbe fatto sparire dagli elenchi
    // dell'altra sede — cioè il danno peggiore, con la risposta giusta.
    const b = riga(ALU_B)
    expect(b?.stato).toBe('iscritto')
    expect(b?.section_id).toBe(SEC_B)
    expect(b?.classe_sezione).toBe('2 ANNI')
    expect(b?.archiviato_il).toBeNull()
    expect(scrittureSu('alunni')).toHaveLength(0)
    expect(h.db.audit_scritture_docente).toHaveLength(0)
  })

  it('403 anche quando l\'alunno non esiste in nessuna sede: nessuna scrittura', async () => {
    // Il gate risponde 404 su un id inesistente: qui conta che NON si scriva.
    const res = await POST(post({ alunno_id: '99999999-9999-4999-8999-999999999999' }))
    expect([403, 404]).toContain(res.status)
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('⚠️ il filtro di sede sull\'UPDATE è una difesa SUA: se l\'alunno cambia plesso dopo il gate, non si scrive', async () => {
    // La corsa che il commento della route descrive, inscenata: gate superato,
    // lettura riuscita, e nell'istante prima dell'UPDATE la riga passa a SEDE_B.
    // Con `.in('scuola_id', plessi)` l'UPDATE non trova niente e la route risponde
    // 404 senza aver toccato la riga; senza quel filtro archivierebbe il bambino
    // di un altro plesso — sganciandolo dalla sua sezione — con il gate verde.
    h.tabelle = spostaDiPlessoPrimaDellUpdate(ALU_A, SEDE_B)

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('ALUNNO_NON_APRIBILE')
    const a = riga(ALU_A)
    expect(a?.stato, 'la riga di un altro plesso è stata archiviata lo stesso').toBe('iscritto')
    expect(a?.section_id).toBe(SEC_A)
    expect(a?.classe_sezione).toBe('2 ANNI')
    expect(a?.archiviato_il).toBeNull()
    // L'UPDATE è stato EMESSO — ed è il punto: ha attraversato il filtro di sede
    // e non ha colpito nessuna riga. `colpite` vuoto è la prova che il filtro c'è;
    // «nessuna scrittura emessa» proverebbe soltanto che la route si è fermata prima.
    expect(scrittureSu('alunni')).toHaveLength(1)
    expect(scrittureSu('alunni')[0].colpite, 'l\'UPDATE ha colpito una riga di un altro plesso').toHaveLength(0)
    expect(h.db.audit_scritture_docente).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: senza la corsa, la stessa sonda lascia archiviare', async () => {
    // Senza questa riga il test qui sopra sarebbe verde anche con una sonda che
    // rompe la route in un modo qualunque: la 3ª `from('alunni')` deve esserci —
    // cioè l'UPDATE deve essere davvero eseguito — e con la sede INVARIATA deve
    // andare a buon fine.
    const tabelle = spostaDiPlessoPrimaDellUpdate(ALU_A, SEDE_A)
    h.tabelle = tabelle

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(200)
    expect(tabelle.filter((t) => t === 'alunni')).toHaveLength(3)
    expect(riga(ALU_A)?.section_id).toBeNull()
  })
})

describe('POST /api/admin/students/archivia — il percorso felice', () => {
  it('200: sgancia dalla classe E ricorda da dove veniva, in UN SOLO update', async () => {
    const res = await POST(post({ alunno_id: ALU_A, motivo: 'trasferimento' }))
    expect(res.status).toBe(200)

    const a = riga(ALU_A)
    // ⟵ LA LEVA: senza queste due righe a NULL il bambino resta in ogni elenco
    //    per sezione, che è la maggioranza delle query dell'app.
    expect(a?.section_id).toBeNull()
    expect(a?.classe_sezione).toBeNull()
    // Il gruppo mensa è un'assegnazione operativa: un archiviato che resta in
    // una lista di cucina è un pasto contato.
    expect(a?.gruppo_mensa_id).toBeNull()
    // ⟵ LA MEMORIA DEL RITORNO.
    expect(a?.archiviato_section_id).toBe(SEC_A)
    expect(a?.archiviato_classe_sezione).toBe('2 ANNI')
    expect(a?.archiviato_motivo).toBe('trasferimento')
    expect(a?.archiviato_da).toBe('seg-1')
    expect(typeof a?.archiviato_il).toBe('string')
    expect(a?.stato).toBe('ritirato')

    // ⚠️ L'ANAGRAFICA NON SI TOCCA: è tutto il modello. Registri e pagamenti
    // devono restare leggibili per dieci anni, e il nome del bambino esiste in
    // un posto solo.
    expect(a?.nome).toBe('Alfa')
    expect(a?.cognome).toBe('AaaSedeA')
    expect(a?.codice_fiscale).toBe('CODICEFINTO00001')

    // UN SOLO update: due scritture separate lascerebbero una finestra in cui il
    // bambino è fuori dalla sua sezione e nessuna riga dice quale fosse.
    const scritte = scrittureSu('alunni')
    expect(scritte).toHaveLength(1)
    expect(scritte[0].operazione).toBe('update')
  })

  it('`section_id` è azzerato ESPLICITAMENTE nel payload, non lasciato al trigger', async () => {
    // Il trigger `sync_alunno_section_id` agisce solo se `classe_sezione` è NON
    // nulla: azzerare il nome non azzera l'id. Se un giorno qualcuno togliesse
    // `section_id: null` dall'UPDATE fidandosi del trigger, in produzione il
    // bambino resterebbe agganciato alla sezione — e qui il finto client, che i
    // trigger non li esegue, non lo mostrerebbe. Perciò si guarda il PAYLOAD.
    await POST(post({ alunno_id: ALU_A }))
    const payload = scrittureSu('alunni')[0].valori[0]
    expect(Object.prototype.hasOwnProperty.call(payload, 'section_id')).toBe(true)
    expect(payload.section_id).toBeNull()
  })

  it('senza `motivo` si archivia lo stesso, e il motivo resta null (mai testo libero)', async () => {
    const res = await POST(post({ alunno_id: ALU_A }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A)?.archiviato_motivo).toBeNull()
  })

  it('un motivo fuori dall\'insieme chiuso è 400, e non scrive niente', async () => {
    const res = await POST(post({ alunno_id: ALU_A, motivo: 'trasferito' }))
    expect(res.status).toBe(400)
    expect(riga(ALU_A)?.section_id).toBe(SEC_A)
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('la risposta dice da quale classe è uscito: la scheda la mostra come «Era in»', async () => {
    const res = await POST(post({ alunno_id: ALU_A }))
    const corpo = (await res.json()) as { era_in: string | null }
    expect(corpo.era_in).toBe('2 ANNI')
  })
})

describe('POST /api/admin/students/archivia — l\'audit', () => {
  it('scrive in `audit_scritture_docente` e MAI in `registro_modifiche`', async () => {
    await POST(post({ alunno_id: ALU_A, motivo: 'ritiro' }))

    const audit = h.db.audit_scritture_docente
    expect(audit).toHaveLength(1)
    expect(audit[0].entita_tipo).toBe('alunni')
    expect(audit[0].entita_id).toBe(ALU_A)
    expect(audit[0].azione).toBe('update')
    // La sede è quella dell'ALUNNO, non quella dell'operatore: su una traccia di
    // chi-ha-toccato-cosa non è un dettaglio.
    expect(audit[0].scuola_id).toBe(SEDE_A)

    // ⟵ Il difetto che questo modello NON riapre.
    expect(h.db.registro_modifiche).toHaveLength(0)
    expect(scrittureSu('registro_modifiche')).toHaveLength(0)
  })

  it('nell\'audit non finisce nessun `select *`: solo i campi dell\'operazione', async () => {
    await POST(post({ alunno_id: ALU_A }))
    const serializzato = JSON.stringify(h.db.audit_scritture_docente)
    expect(serializzato).not.toContain('NOTA-MEDICA-A')
    expect(serializzato).not.toContain('CODICEFINTO00001')
    expect(serializzato).not.toContain('AaaSedeA')
  })
})

describe('POST /api/admin/students/archivia — i rifiuti', () => {
  it('409 se è GIÀ archiviato, e la riga non cambia', async () => {
    h.db.alunni[0].archiviato_il = '2026-08-01T10:00:00.000Z'
    h.db.alunni[0].stato = 'ritirato'
    h.db.alunni[0].section_id = null
    h.db.alunni[0].classe_sezione = null

    const res = await POST(post({ alunno_id: ALU_A }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_GIA_ARCHIVIATO')
    expect(riga(ALU_A)?.archiviato_il).toBe('2026-08-01T10:00:00.000Z')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('⚠️ il RITIRO A MANO dalla tendina NON è un 409: è proprio il caso da archiviare', async () => {
    // `stato = 'ritirato'` con `archiviato_il` NULL è il bambino messo a
    // «Ritirato» dalla `<select>` della scheda: `section_id` è ancora
    // valorizzato, quindi lui compare ancora in registro, appello e mensa.
    // Guardare lo STATO invece di `archiviato_il` lo lascerebbe bloccato lì per
    // sempre — con il gate verde.
    h.db.alunni[0].stato = 'ritirato'

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(200)
    expect(riga(ALU_A)?.section_id).toBeNull()
    expect(riga(ALU_A)?.archiviato_section_id).toBe(SEC_A)
  })
})

describe('POST /api/admin/students/archivia — DB non migrato (CI)', () => {
  it('503 su PGRST204 in scrittura: NIENTE viene scritto, nemmeno lo sganciamento', async () => {
    // ⚠️ È il test che vieta il degrado. Il ciclo «togli la colonna e riprova»
    // del resto del repo, qui, eseguirebbe `section_id: null` e NON la memoria:
    // il bambino uscirebbe dalla sua sezione e nessuna riga direbbe quale fosse.
    h.errori = { 'alunni:update': { code: 'PGRST204', message: "Could not find the 'archiviato_il' column of 'alunni' in the schema cache" } }

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ARCHIVIO_NON_DISPONIBILE')
    const a = riga(ALU_A)
    expect(a?.section_id).toBe(SEC_A)
    expect(a?.classe_sezione).toBe('2 ANNI')
    expect(a?.stato).toBe('iscritto')
    expect(h.db.audit_scritture_docente).toHaveLength(0)
  })

  it('503 su 42703 in lettura: la colonna non esiste, e non si prova nemmeno a scrivere', async () => {
    h.errori = rompiLaSecondaLettura({ code: '42703', message: 'column alunni.archiviato_il does not exist' })

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ARCHIVIO_NON_DISPONIBILE')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: la sonda rompe la SECONDA lettura e non la prima', async () => {
    // Senza questa prova, un `rompiLaSecondaLettura` che rompesse ANCHE la prima
    // renderebbe verde il test qui sopra per il motivo sbagliato — il 5xx
    // arriverebbe dal gate (`scope-alunno-non-risolto`, «Verifica di scope non
    // riuscita») e il ramo della colonna assente non verrebbe mai eseguito.
    const errori = rompiLaSecondaLettura({ code: '42703', message: 'boom' })
    expect(errori['alunni:select']).toBeUndefined()
    expect(errori['alunni:select']).toEqual({ code: '42703', message: 'boom' })
  })

  it('un errore che NON è di colonna resta un 500, non diventa un 503 qualunque', async () => {
    // Senza questo caso il ramo qui sopra sarebbe verde anche su una route che
    // risponde 503 a QUALUNQUE errore: è ciò che rende quel 503 una prova.
    h.errori = { 'alunni:update': { code: '23503', message: 'violates foreign key constraint' } }

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ARCHIVIAZIONE_NON_RIUSCITA')
    expect(riga(ALU_A)?.section_id).toBe(SEC_A)
  })
})
