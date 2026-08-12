import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// `POST /api/admin/students/riattiva` — il ritorno, che è metà del modello.
//
// ─── LA COSA CHE QUESTO FILE ESISTE PER TENERE FERMA ─────────────────────────
//
// LA CLASSE NON SI RIPRISTINA ALLA CIECA. `archiviato_classe_sezione` è un NOME,
// e può essere STANTIO: la classe può essere stata rinominata o cancellata, o il
// bambino è cresciuto di un anno mentre era fuori. E dal 2026-07-29 il nome non è
// nemmeno una chiave — «2 ANNI» esiste ad Aversa e a Cesa.
//
// Il trigger `sync_alunno_section_id` NON protegge da questo: se il nome nella
// sede non c'è, non produce nessun errore — lascia `section_id` a NULL, e il
// bambino risulta iscritto e invisibile a ogni elenco per sezione. Il difetto
// arriverebbe in produzione con il gate verde, e se ne accorgerebbe una maestra
// che non trova un bambino in registro.
//
// I tre esiti che questo file separa:
//   · la classe c'è          → si riscrive il NOME e il trigger risolve l'id;
//   · la classe non c'è più  → 200 con `classe_ripristinata: false` e il nome
//                              di quella sparita, perché la scheda lo dica;
//   · la verifica non riesce → 5xx, e NON si riattiva. «Non ho potuto
//                              verificare» non è «non c'è»: trattarlo come un no
//                              toglierebbe la classe a un bambino che ce l'aveva.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const SEC_B = '33333333-3333-4333-8333-bbbbbbbbbbbb'

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

import { POST } from '@/app/api/admin/students/riattiva/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/students/riattiva', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Un alunno GIÀ archiviato: sganciato dalla classe, con la memoria di dov'era. */
const archiviato = (id: string, sede: string, sezione: string, classe: string | null) => ({
  id,
  nome: id === ALU_A ? 'Alfa' : 'Beta',
  cognome: id === ALU_A ? 'AaaSedeA' : 'CccSedeB',
  scuola_id: sede,
  section_id: null,
  classe_sezione: null,
  gruppo_mensa_id: null,
  stato: 'ritirato',
  note_mediche: id === ALU_A ? 'NOTA-MEDICA-A' : 'NOTA-MEDICA-B',
  codice_fiscale: id === ALU_A ? 'CODICEFINTO00001' : 'CODICEFINTO00002',
  archiviato_il: '2026-08-01T10:00:00.000Z',
  archiviato_da: 'seg-1',
  archiviato_motivo: 'ritiro',
  archiviato_section_id: sezione,
  archiviato_classe_sezione: classe,
  spazio_liberato_il: null,
})

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  utenti_sezioni: [],
  sections: [
    { id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI' },
    { id: 'sec-a-3', scuola_id: SEDE_A, name: '3 ANNI' },
    { id: SEC_B, scuola_id: SEDE_B, name: '2 ANNI' },
  ],
  alunni: [
    archiviato(ALU_A, SEDE_A, SEC_A, '2 ANNI'),
    archiviato(ALU_B, SEDE_B, SEC_B, '2 ANNI'),
  ],
  registro_modifiche: [],
  audit_scritture_docente: [],
})

const riga = (id: string) => h.db.alunni.find((a) => a.id === id)
const scrittureSu = (tabella: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('POST /api/admin/students/riattiva — isolamento di sede', () => {
  it('403 sull\'alunno di un\'altra sede: la riga resta INTATTA e non c\'è nessuna scrittura', async () => {
    const res = await POST(post({ alunno_id: ALU_B }))
    const testo = await res.text()

    expect(res.status).toBe(403)
    expect(testo).not.toContain('NOTA-MEDICA-B')
    expect(testo).not.toContain('CODICEFINTO00002')

    const b = riga(ALU_B)
    expect(b?.stato).toBe('ritirato')
    expect(b?.archiviato_il).toBe('2026-08-01T10:00:00.000Z')
    expect(b?.archiviato_classe_sezione).toBe('2 ANNI')
    expect(scrittureSu('alunni')).toHaveLength(0)
    expect(h.db.audit_scritture_docente).toHaveLength(0)
  })
})

describe('POST /api/admin/students/riattiva — la classe ESISTE ancora', () => {
  it('200: torna iscritto, la classe si riscrive e i tracciamenti si azzerano', async () => {
    const res = await POST(post({ alunno_id: ALU_A }))
    expect(res.status).toBe(200)

    const a = riga(ALU_A)
    expect(a?.stato).toBe('iscritto')
    expect(a?.classe_sezione).toBe('2 ANNI')
    expect(a?.archiviato_il).toBeNull()
    expect(a?.archiviato_da).toBeNull()
    expect(a?.archiviato_motivo).toBeNull()
    expect(a?.archiviato_section_id).toBeNull()
    expect(a?.archiviato_classe_sezione).toBeNull()

    const corpo = (await res.json()) as { esito_classe: string; classe_sezione: string | null; classe_mancante: string | null }
    expect(corpo.esito_classe).toBe('ripristinata')
    expect(corpo.classe_sezione).toBe('2 ANNI')
    expect(corpo.classe_mancante).toBeNull()
  })

  it('⚠️ `section_id` NON viene scritto a mano: lo risolve il trigger, dentro la sede', async () => {
    // Scriverlo qui vorrebbe dire ricalcolare la stessa regola in un secondo
    // posto — e `archiviato_section_id` è un uuid che può puntare a una sezione
    // di un'altra sede o cancellata. Il trigger risolve il NOME dentro
    // `scuola_id` dell'alunno: è quella la garanzia.
    await POST(post({ alunno_id: ALU_A }))
    const payload = scrittureSu('alunni')[0].valori[0]
    expect(Object.prototype.hasOwnProperty.call(payload, 'section_id')).toBe(false)
    expect(payload.classe_sezione).toBe('2 ANNI')
  })

  it('`gruppo_mensa_id` NON si ripristina: indovinarlo lo rimetterebbe in una lista di cucina', async () => {
    await POST(post({ alunno_id: ALU_A }))
    const payload = scrittureSu('alunni')[0].valori[0]
    expect(Object.prototype.hasOwnProperty.call(payload, 'gruppo_mensa_id')).toBe(false)
    expect(riga(ALU_A)?.gruppo_mensa_id).toBeNull()
  })

  it('la classe indicata dall\'operatore VINCE su quella ricordata', async () => {
    const res = await POST(post({ alunno_id: ALU_A, classe_sezione: '3 ANNI' }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A)?.classe_sezione).toBe('3 ANNI')
    expect(((await res.json()) as { classe_sezione: string }).classe_sezione).toBe('3 ANNI')
  })

  it('400 se la classe CHIESTA non esiste nella sede: chi ha nominato una classe deve saperlo', async () => {
    const res = await POST(post({ alunno_id: ALU_A, classe_sezione: '5 ANNI' }))
    expect(res.status).toBe(400)
    // E soprattutto: non si riattiva a metà.
    expect(riga(ALU_A)?.stato).toBe('ritirato')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('⚠️ la classe di UN\'ALTRA SEDE non vale: il nome non è una chiave dal 2026-07-29', async () => {
    // «2 ANNI» esiste in SEDE_A e in SEDE_B. Qui la sezione omonima c'è nella
    // sede giusta, quindi passa; il caso opposto è il 400 qui sopra. Questo test
    // fissa che la verifica avviene DENTRO la sede dell'alunno e non sul nome
    // globale: se guardasse il nome globale, «5 ANNI» creato in SEDE_B
    // passerebbe anche per un bambino di SEDE_A.
    h.db.sections.push({ id: 'sec-b-5', scuola_id: SEDE_B, name: '5 ANNI' })
    const res = await POST(post({ alunno_id: ALU_A, classe_sezione: '5 ANNI' }))
    expect(res.status).toBe(400)
    expect(riga(ALU_A)?.stato).toBe('ritirato')
  })
})

describe('POST /api/admin/students/riattiva — la classe è SPARITA', () => {
  it('200 senza classe, e la risposta la NOMINA: mai una sezione indovinata', async () => {
    // La classe ricordata è stata cancellata mentre il bambino era fuori.
    h.db.sections = h.db.sections.filter((s) => s.id !== SEC_A)

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { esito_classe: string; classe_mancante: string | null; classe_sezione: string | null }
    expect(corpo.esito_classe).toBe('sparita')
    expect(corpo.classe_mancante).toBe('2 ANNI')
    expect(corpo.classe_sezione).toBeNull()

    const a = riga(ALU_A)
    // È tornato fra gli iscritti…
    expect(a?.stato).toBe('iscritto')
    expect(a?.archiviato_il).toBeNull()
    // …e NON è stato agganciato a niente: né il nome né l'id.
    expect(a?.classe_sezione).toBeNull()
    expect(a?.section_id).toBeNull()
    const payload = scrittureSu('alunni')[0].valori[0]
    expect(Object.prototype.hasOwnProperty.call(payload, 'classe_sezione')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(payload, 'section_id')).toBe(false)
  })

  it('⚠️ RITIRO A MANO dalla tendina: la classe ce l\'ha ADDOSSO, e la risposta non dice «senza classe»', async () => {
    // `stato = 'ritirato'` messo dalla `<select>` della scheda: non è mai passato
    // dall'archiviazione, quindi NIENTE memoria **e niente sganciamento** — la
    // sezione e il nome della classe sono ancora sulla riga. È il caso che la
    // testata della rotta chiama «precisamente il caso in cui il ritorno serve».
    //
    // ⚠️ Questo test PRIMA non montava il suo stesso caso: la fixture
    // `archiviato()` nasce con `section_id: null, classe_sezione: null`, e il test
    // azzerava soltanto i tre `archiviato_*` — cioè misurava un archiviato senza
    // memoria, non un ritiro a mano. Rimesse le due colonne, la risposta di allora
    // (`classe_ripristinata: false`) mandava la scheda sul ramo «Assegna una
    // classe dalla sua scheda» per un bambino che era in «2 ANNI», e `app_log`
    // registrava `riattivato-senza-classe`. Un test che non monta il suo caso è
    // una riga verde che non guarda niente.
    const a = h.db.alunni[0]
    a.archiviato_il = null
    a.archiviato_classe_sezione = null
    a.archiviato_section_id = null
    a.section_id = SEC_A
    a.classe_sezione = '2 ANNI'

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { esito_classe: string; classe_sezione: string | null; classe_mancante: string | null }
    expect(corpo.esito_classe).toBe('conservata')
    expect(corpo.classe_sezione).toBe('2 ANNI')
    expect(corpo.classe_mancante).toBeNull()
    expect(riga(ALU_A)?.stato).toBe('iscritto')
    // E la classe NON viene riscritta: non c'era niente da ripristinare, e un
    // UPDATE su `classe_sezione` farebbe ripartire il trigger per nulla.
    const payload = scrittureSu('alunni')[0].valori[0]
    expect(Object.prototype.hasOwnProperty.call(payload, 'classe_sezione')).toBe(false)
    expect(riga(ALU_A)?.section_id).toBe(SEC_A)
  })

  it('200 senza classe quando non c\'è NÉ memoria NÉ classe addosso: quello sì va assegnato a mano', async () => {
    // Il controllo negativo del test qui sopra: se `esito_classe` fosse sempre
    // `conservata` quel test sarebbe verde per sbaglio. Qui la riga non ha
    // proprio nessuna classe, e la risposta lo dice.
    const a = h.db.alunni[0]
    a.archiviato_il = null
    a.archiviato_classe_sezione = null
    a.archiviato_section_id = null

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { esito_classe: string; classe_sezione: string | null; classe_mancante: string | null }
    expect(corpo.esito_classe).toBe('assente')
    expect(corpo.classe_sezione).toBeNull()
    expect(corpo.classe_mancante).toBeNull()
    expect(riga(ALU_A)?.stato).toBe('iscritto')
  })

  it('il gruppo mensa si dichiara: azzerato da `archivia`, NON toccato dal ritiro a mano', async () => {
    // La terza cosa che non torna indietro, e l'unica che fino al 2026-08-13 non
    // era detta né prima né dopo. Si deriva da `archiviato_il`, che è l'unico
    // fatto che distingue «è passato dall'archiviazione» da «è stato messo a
    // ritirato dalla tendina».
    const archiviatoVero = (await (await POST(post({ alunno_id: ALU_A }))).json()) as { gruppo_mensa_da_riassegnare: boolean }
    expect(archiviatoVero.gruppo_mensa_da_riassegnare).toBe(true)

    h.db = dbBase()
    h.scritture = []
    h.db.alunni[0].archiviato_il = null
    const ritiroAMano = (await (await POST(post({ alunno_id: ALU_A }))).json()) as { gruppo_mensa_da_riassegnare: boolean }
    expect(ritiroAMano.gruppo_mensa_da_riassegnare).toBe(false)
  })

  it('⚠️ se la VERIFICA della classe non riesce si NEGA: «non ho potuto» non è «non c\'è»', async () => {
    // Con un guasto su `sections`, trattare il fallimento come «la classe non
    // esiste più» toglierebbe la classe a un bambino che ce l'aveva, in
    // silenzio, e se ne accorgerebbe solo chi lo cerca in sezione.
    h.errori = { sections: { code: '08006', message: 'connection failure' } }

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(500)
    expect(riga(ALU_A)?.stato).toBe('ritirato')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })
})

describe('POST /api/admin/students/riattiva — i rifiuti', () => {
  it('409 se è già fra gli ISCRITTI, e non si scrive niente', async () => {
    h.db.alunni[0].stato = 'iscritto'

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_NON_ARCHIVIATO')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('⚠️ un SOSPESO è un bambino che frequenta: il ritorno lo rifiuta con 409', async () => {
    // `alunni.stato = 'sospeso'` sta dalla parte «ancora iscritto» del confine
    // (`LATO_DEL_CONFINE`, `@/lib/alunni/stato`) — ed è una cosa diversa dalla
    // colonna booleana `alunni.sospeso`, che riguarda la morosità. Riattivarlo
    // significherebbe cambiargli lo stato senza che nessuno l'abbia chiesto.
    h.db.alunni[0].stato = 'sospeso'

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(409)
    expect(riga(ALU_A)?.stato).toBe('sospeso')
  })
})

describe('POST /api/admin/students/riattiva — «libera spazio» è già passato', () => {
  it('la riattivazione RIESCE, ma la risposta dichiara che foto e messaggi non tornano', async () => {
    h.db.alunni[0].spazio_liberato_il = '2026-08-05T09:00:00.000Z'

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(200)
    expect(((await res.json()) as { spazio_gia_liberato: boolean }).spazio_gia_liberato).toBe(true)
    expect(riga(ALU_A)?.stato).toBe('iscritto')
    // La colonna NON si azzera: è un fatto storico, non un tracciamento.
    expect(riga(ALU_A)?.spazio_liberato_il).toBe('2026-08-05T09:00:00.000Z')
  })
})

describe('POST /api/admin/students/riattiva — audit e DB non migrato', () => {
  it('scrive in `audit_scritture_docente` e MAI in `registro_modifiche`', async () => {
    await POST(post({ alunno_id: ALU_A }))

    const audit = h.db.audit_scritture_docente
    expect(audit).toHaveLength(1)
    expect(audit[0].entita_tipo).toBe('alunni')
    expect(audit[0].entita_id).toBe(ALU_A)
    expect(audit[0].scuola_id).toBe(SEDE_A)
    expect(h.db.registro_modifiche).toHaveLength(0)

    const serializzato = JSON.stringify(audit)
    expect(serializzato).not.toContain('NOTA-MEDICA-A')
    expect(serializzato).not.toContain('CODICEFINTO00001')
  })

  it('503 su PGRST204 in scrittura: nessuna riattivazione a metà', async () => {
    h.errori = { 'alunni:update': { code: 'PGRST204', message: "Could not find the 'archiviato_il' column of 'alunni' in the schema cache" } }

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ARCHIVIO_NON_DISPONIBILE')
    expect(riga(ALU_A)?.stato).toBe('ritirato')
    expect(h.db.audit_scritture_docente).toHaveLength(0)
  })

  it('un errore che NON è di colonna resta un 500, non diventa un 503 qualunque', async () => {
    h.errori = { 'alunni:update': { code: '23503', message: 'violates foreign key constraint' } }

    const res = await POST(post({ alunno_id: ALU_A }))

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('RIATTIVAZIONE_NON_RIUSCITA')
    expect(riga(ALU_A)?.stato).toBe('ritirato')
  })
})
