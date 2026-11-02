import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { SchedeGenitoreRisposta } from '@/lib/votazioni/tipi'

/**
 * VOTAZIONI · LE SCHEDE DEL GENITORE (`GET /api/parent/votazioni`).
 *
 * Il database è il finto che APPLICA i filtri: una scheda per ogni figlio invece che per ogni classe, un
 * filtro di sede dimenticato o una votazione scaduta che resta in elenco qui si vedono davvero. Sono finti
 * soltanto il gate (`requireUser`, che consegna l'identità della sessione) e il client service-role. La
 * libreria degli aventi diritto (`figliAttiviConClasse`, `genitoriDelleClassi`, `nomiGenitori`) e l'ammissione
 * sono quelle VERE.
 *
 * Solo dati finti: uuid inventati e cognomi di fantasia.
 */

const h = vi.hoisted(() => ({
  utente: '' as string,
  anonimo: false,
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string }>,
  letture: [] as string[],
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: () => {
    if (h.anonimo) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    return Promise.resolve({ user: { id: h.utente, role: 'genitore', scuola_id: null } })
  },
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db as DBFinto, h.letture, { errori: h.errori }),
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { GET } from '@/app/api/parent/votazioni/route'

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

// ── persone ──────────────────────────────────────────────────────────────────
const ELETTORE = uuid('a0000000', 1) // Rossi Anna: due figli in A1, uno in A2, uno in B1
const COLLEGA = uuid('a0000000', 2) // Bianchi Luca: genitore in A1
const VERDI = uuid('a0000000', 3) // Verdi Marta: genitore in A2
const NERI = uuid('a0000000', 4) // Neri Paolo: genitore in B1
const INATTIVO = uuid('a0000000', 5) // Inattivi Ida: genitore in A1 con account disattivato
const SOLO_A = uuid('a0000000', 6) // Gialli Gina: ha figli solo in A1
const ESTRANEO = uuid('a0000000', 9) // senza figli

// ── sedi e classi ────────────────────────────────────────────────────────────
const A1 = uuid('c1000000', 1)
const A2 = uuid('c2000000', 2)
const A3 = uuid('c3000000', 3) // classe in cui l'elettore non ha figli
const B1 = uuid('c4000000', 4)

// ── votazioni ────────────────────────────────────────────────────────────────
const VOT_A = uuid('d0000000', 1) // sede A: classi A1 e A2 + istituto
const VOT_B = uuid('d0000000', 2) // sede B: classe B1 + istituto
const VOT_SCADUTA = uuid('d0000000', 3) // sede A, scadenza passata
const VOT_CHIUSA = uuid('d0000000', 4) // sede A, chiusa a mano
const VOT_SOLO_CLASSE = uuid('d0000000', 5) // sede A, classe A3 (dove non ha figli)

const AL = (n: number) => uuid('b0000000', n)

const ORA = Date.now()
const fra = (ms: number) => new Date(ORA + ms).toISOString()
const GIORNO = 24 * 60 * 60 * 1000

const utente = (id: string, cognome: string, nome: string, extra: Riga = {}): Riga => ({
  id,
  cognome,
  nome,
  ruolo: 'genitore',
  attivo: true,
  ...extra,
})
const alunno = (id: string, section_id: string, scuola_id: string, extra: Riga = {}): Riga => ({
  id,
  scuola_id,
  section_id,
  stato: 'iscritto',
  archiviato_il: null,
  nome: 'Bimbo',
  cognome: 'Finto',
  classe_sezione: 'CLASSE',
  ...extra,
})
const legame = (alunno_id: string, genitore_id: string): Riga => ({ alunno_id, genitore_id })
const votazione = (id: string, scuola_id: string, extra: Riga = {}): Riga => ({
  id,
  scuola_id,
  titolo: `Elezione ${id.slice(0, 2)}`,
  scadenza: fra(GIORNO),
  chiusa_il: null,
  rappresentante_istituto: false,
  creata_da: uuid('e0000000', 1),
  creata_il: '2026-11-02T08:00:00.000Z',
  aggiornata_da: null,
  aggiornata_il: null,
  ...extra,
})
const classeDi = (votazione_id: string, scuola_id: string, section_id: string): Riga => ({ votazione_id, scuola_id, section_id })
const candidato = (votazione_id: string, scuola_id: string, utente_id: string): Riga => ({ votazione_id, scuola_id, utente_id })
const voto = (votazione_id: string, scuola_id: string, elettore_id: string, candidato_id: string, extra: Riga = {}): Riga => ({
  id: uuid('f0000000', Math.floor(Math.random() * 1e9)),
  votazione_id,
  scuola_id,
  ambito: 'classe',
  section_id: null,
  elettore_id,
  candidato_id,
  votato_il: '2026-11-03T09:00:00.000Z',
  aggiornato_il: null,
  ...extra,
})

function dbBase(): DBFinto {
  return {
    schools: [
      { id: SEDE_A, nome: 'Kidville Alfa' },
      { id: SEDE_B, nome: 'Kidville Beta' },
    ],
    sections: [
      { id: A1, scuola_id: SEDE_A, name: '2 ANNI' },
      { id: A2, scuola_id: SEDE_A, name: '3 ANNI' },
      { id: A3, scuola_id: SEDE_A, name: '4 ANNI' },
      { id: B1, scuola_id: SEDE_B, name: '2 ANNI' },
    ],
    alunni: [
      alunno(AL(1), A1, SEDE_A),
      alunno(AL(2), A1, SEDE_A), // secondo figlio dell'elettore nella STESSA classe
      alunno(AL(3), A2, SEDE_A),
      alunno(AL(4), B1, SEDE_B), // e un figlio in un'altra sede
      alunno(AL(5), A1, SEDE_A), // figlio di Collega, Inattivo e Solo_A
      alunno(AL(6), A2, SEDE_A), // figlio di Verdi
      alunno(AL(7), B1, SEDE_B), // figlio di Neri
    ],
    legame_genitori_alunni: [
      legame(AL(1), ELETTORE),
      legame(AL(2), ELETTORE),
      legame(AL(3), ELETTORE),
      legame(AL(4), ELETTORE),
      legame(AL(5), COLLEGA),
      legame(AL(5), INATTIVO),
      legame(AL(5), SOLO_A),
      legame(AL(6), VERDI),
      legame(AL(7), NERI),
    ],
    student_parents: [],
    parents: [],
    utenti: [
      utente(ELETTORE, 'Rossi', 'Anna'),
      utente(COLLEGA, 'Bianchi', 'Luca'),
      utente(VERDI, 'Verdi', 'Marta'),
      utente(NERI, 'Neri', 'Paolo'),
      utente(INATTIVO, 'Inattivi', 'Ida', { attivo: false }),
      utente(SOLO_A, 'Gialli', 'Gina'),
      utente(ESTRANEO, 'Estranei', 'Elio'),
    ],
    votazioni: [
      votazione(VOT_A, SEDE_A, { rappresentante_istituto: true }),
      votazione(VOT_B, SEDE_B, { rappresentante_istituto: true, scadenza: fra(2 * GIORNO) }),
    ],
    votazioni_classi: [classeDi(VOT_A, SEDE_A, A1), classeDi(VOT_A, SEDE_A, A2), classeDi(VOT_B, SEDE_B, B1)],
    votazioni_candidati: [
      candidato(VOT_A, SEDE_A, COLLEGA),
      candidato(VOT_A, SEDE_A, VERDI),
      candidato(VOT_B, SEDE_B, NERI),
    ],
    votazioni_voti: [],
  }
}

const get = () => GET(new NextRequest('http://localhost/api/parent/votazioni'))
async function leggi(): Promise<{ stato: number; corpo: SchedeGenitoreRisposta & { codice?: string; error?: string } }> {
  const res = await get()
  return { stato: res.status, corpo: await res.json() }
}
const nomi = (c: { nome: string }[]) => c.map((x) => x.nome)

beforeEach(() => {
  h.utente = ELETTORE
  h.anonimo = false
  h.errori = {}
  h.letture = []
  h.logEvento.mockClear()
  h.logErrore.mockClear()
  h.db = dbBase()
})

describe('GET /api/parent/votazioni · le schede', () => {
  it('senza sessione: 401 e il database non si tocca', async () => {
    h.anonimo = true
    const { stato } = await leggi()
    expect(stato).toBe(401)
    expect(h.letture).toEqual([])
  })

  it('REVIEW FOCUS 1 · due figli nella stessa classe: UNA scheda di classe, non due', async () => {
    h.db = dbBase()
    h.db.votazioni = [votazione(VOT_A, SEDE_A)]
    h.db.votazioni_classi = [classeDi(VOT_A, SEDE_A, A1)]
    h.db.votazioni_candidati = []
    const { stato, corpo } = await leggi()
    expect(stato).toBe(200)
    expect(corpo.disponibile).toBe(true)
    const classi = corpo.schede.filter((s) => s.ambito === 'classe')
    expect(classi).toHaveLength(1)
    expect(classi[0].sectionId).toBe(A1)
    expect(corpo.schede).toHaveLength(1)
  })

  it('figli in due classi della stessa votazione: due schede di classe, in ordine di nome della classe', async () => {
    h.db.votazioni = [votazione(VOT_A, SEDE_A)]
    h.db.votazioni_classi = [classeDi(VOT_A, SEDE_A, A2), classeDi(VOT_A, SEDE_A, A1)]
    h.db.votazioni_candidati = []
    const { corpo } = await leggi()
    expect(corpo.schede.map((s) => s.classeNome)).toEqual(['2 ANNI', '3 ANNI'])
    expect(corpo.schede.map((s) => s.sectionId)).toEqual([A1, A2])
  })

  it('i campi della scheda di classe: titolo, scadenza ISO, nomi di classe e sede, candidati, nessuna scelta', async () => {
    // PostgREST rende i timestamptz con `+00:00`: l'API li riporta in ISO UTC con la `Z`.
    const scadenza = new Date(ORA + GIORNO)
    h.db.votazioni = [
      votazione(VOT_A, SEDE_A, { titolo: 'Elezioni di prova', scadenza: scadenza.toISOString().replace('Z', '+00:00') }),
    ]
    h.db.votazioni_classi = [classeDi(VOT_A, SEDE_A, A1)]
    h.db.votazioni_candidati = []
    const { corpo } = await leggi()
    expect(corpo.schede).toEqual([
      {
        votazioneId: VOT_A,
        titolo: 'Elezioni di prova',
        scadenza: scadenza.toISOString(),
        ambito: 'classe',
        sectionId: A1,
        classeNome: '2 ANNI',
        sedeNome: 'Kidville Alfa',
        // Tutti i genitori della classe, lui compreso ("ci si può votare da soli"); l'account disattivato no.
        candidati: [
          { utenteId: COLLEGA, nome: 'Bianchi Luca' },
          { utenteId: SOLO_A, nome: 'Gialli Gina' },
          { utenteId: ELETTORE, nome: 'Rossi Anna' },
        ],
        sceltaAttuale: null,
      },
    ])
  })

  it('la scheda d\'istituto: candidati da `votazioni_candidati` con i nomi, ambito istituto, sectionId e classeNome nulli', async () => {
    const { corpo } = await leggi()
    const istituto = corpo.schede.filter((s) => s.votazioneId === VOT_A && s.ambito === 'istituto')
    expect(istituto).toHaveLength(1)
    expect(istituto[0]).toMatchObject({
      sectionId: null,
      classeNome: null,
      sedeNome: 'Kidville Alfa',
      sceltaAttuale: null,
    })
    expect(nomi(istituto[0].candidati)).toEqual(['Bianchi Luca', 'Verdi Marta'])
  })

  it('l\'ordine: per votazione (scadenza), e dentro la votazione prima le classi e poi l\'istituto', async () => {
    const { corpo } = await leggi()
    expect(corpo.schede.map((s) => `${s.votazioneId === VOT_A ? 'A' : 'B'}:${s.ambito}`)).toEqual([
      'A:classe',
      'A:classe',
      'A:istituto',
      'B:classe',
      'B:istituto',
    ])
  })

  it('REVIEW FOCUS 2 · figli in due sedi con l\'istituto aperto in tutte e due: due schede istituto, ognuna coi candidati della propria sede', async () => {
    const { corpo } = await leggi()
    const istituto = corpo.schede.filter((s) => s.ambito === 'istituto')
    expect(istituto).toHaveLength(2)
    const a = istituto.find((s) => s.votazioneId === VOT_A)
    const b = istituto.find((s) => s.votazioneId === VOT_B)
    expect(a?.sedeNome).toBe('Kidville Alfa')
    expect(b?.sedeNome).toBe('Kidville Beta')
    expect(nomi(a?.candidati ?? [])).toEqual(['Bianchi Luca', 'Verdi Marta'])
    expect(nomi(b?.candidati ?? [])).toEqual(['Neri Paolo'])
    // Nessun candidato della sede A sulla scheda della sede B, e viceversa.
    expect(a?.candidati.some((c) => c.utenteId === NERI)).toBe(false)
    expect(b?.candidati.some((c) => c.utenteId === COLLEGA || c.utenteId === VERDI)).toBe(false)
  })

  it('chi ha figli solo nella sede A non vede nulla della sede B', async () => {
    h.utente = SOLO_A
    const { corpo } = await leggi()
    expect(corpo.schede.every((s) => s.votazioneId === VOT_A)).toBe(true)
    expect(corpo.schede.some((s) => s.sedeNome === 'Kidville Beta')).toBe(false)
    // …e della sede A vede la classe A1 (suo figlio) ma non A2, e l'istituto.
    expect(corpo.schede.map((s) => `${s.ambito}:${s.sectionId}`)).toEqual([`classe:${A1}`, 'istituto:null'])
  })

  it('una votazione di una classe in cui non ha figli non produce nessuna scheda', async () => {
    h.db.votazioni.push(votazione(VOT_SOLO_CLASSE, SEDE_A))
    h.db.votazioni_classi.push(classeDi(VOT_SOLO_CLASSE, SEDE_A, A3))
    const { corpo } = await leggi()
    expect(corpo.schede.some((s) => s.votazioneId === VOT_SOLO_CLASSE)).toBe(false)
  })

  it('REVIEW FOCUS 3 · scaduta o chiusa a mano: la scheda non c\'è', async () => {
    h.db.votazioni.push(
      votazione(VOT_SCADUTA, SEDE_A, { scadenza: fra(-60 * 1000) }),
      votazione(VOT_CHIUSA, SEDE_A, { chiusa_il: fra(-60 * 1000) }),
    )
    h.db.votazioni_classi.push(classeDi(VOT_SCADUTA, SEDE_A, A1), classeDi(VOT_CHIUSA, SEDE_A, A1))
    const { corpo } = await leggi()
    expect(corpo.schede.some((s) => s.votazioneId === VOT_SCADUTA || s.votazioneId === VOT_CHIUSA)).toBe(false)
  })

  it('una votazione senza istituto non produce la scheda d\'istituto', async () => {
    h.db.votazioni = [votazione(VOT_A, SEDE_A, { rappresentante_istituto: false })]
    const { corpo } = await leggi()
    expect(corpo.schede.every((s) => s.ambito === 'classe')).toBe(true)
  })

  it('un istituto senza nessun candidato valido non produce una scheda vuota', async () => {
    h.db.votazioni_candidati = h.db.votazioni_candidati.filter((c) => c.votazione_id !== VOT_A)
    const { corpo } = await leggi()
    expect(corpo.schede.some((s) => s.votazioneId === VOT_A && s.ambito === 'istituto')).toBe(false)
  })

  it('un candidato d\'istituto con l\'account disattivato non compare', async () => {
    h.db.utenti.push(utente(uuid('a0000000', 7), 'Spenti', 'Sara', { attivo: false }))
    h.db.votazioni_candidati.push(candidato(VOT_A, SEDE_A, uuid('a0000000', 7)))
    const { corpo } = await leggi()
    const istituto = corpo.schede.find((s) => s.votazioneId === VOT_A && s.ambito === 'istituto')
    expect(nomi(istituto?.candidati ?? [])).toEqual(['Bianchi Luca', 'Verdi Marta'])
  })

  it('un elettore senza figli non ha schede (e non è un errore)', async () => {
    h.utente = ESTRANEO
    const { stato, corpo } = await leggi()
    expect(stato).toBe(200)
    expect(corpo).toEqual({ disponibile: true, schede: [] })
  })

  it('un figlio ritirato non dà una scheda', async () => {
    for (const a of h.db.alunni) if (a.id === AL(3)) a.stato = 'ritirato'
    const { corpo } = await leggi()
    expect(corpo.schede.some((s) => s.sectionId === A2)).toBe(false)
  })

  it('un figlio archiviato non dà una scheda', async () => {
    for (const a of h.db.alunni) if (a.id === AL(3)) a.archiviato_il = '2026-09-01T00:00:00.000Z'
    const { corpo } = await leggi()
    expect(corpo.schede.some((s) => s.sectionId === A2)).toBe(false)
  })

  it('un genitore con un figlio sospeso per morosità vede la sua scheda', async () => {
    for (const a of h.db.alunni) if (a.id === AL(3)) a.stato = 'sospeso'
    const { corpo } = await leggi()
    expect(corpo.schede.some((s) => s.sectionId === A2)).toBe(true)
  })

  it('un genitore con l\'account disattivato non vede nulla: non è un avente diritto', async () => {
    h.utente = INATTIVO
    const { stato, corpo } = await leggi()
    expect(stato).toBe(200)
    expect(corpo.schede).toEqual([])
  })

  it('la scelta attuale: quella dell\'elettore per quella scheda, e solo sua', async () => {
    h.db.votazioni_voti = [
      voto(VOT_A, SEDE_A, ELETTORE, VERDI, { ambito: 'classe', section_id: A2 }),
      voto(VOT_A, SEDE_A, ELETTORE, COLLEGA, { ambito: 'istituto', section_id: null }),
      // Il voto di un altro elettore sulla classe A1 non è la sua scelta.
      voto(VOT_A, SEDE_A, COLLEGA, SOLO_A, { ambito: 'classe', section_id: A1 }),
    ]
    const { corpo } = await leggi()
    const scelta = (ambito: string, sectionId: string | null, votazioneId = VOT_A) =>
      corpo.schede.find((s) => s.votazioneId === votazioneId && s.ambito === ambito && s.sectionId === sectionId)?.sceltaAttuale
    expect(scelta('classe', A1)).toBeNull()
    expect(scelta('classe', A2)).toBe(VERDI)
    expect(scelta('istituto', null)).toBe(COLLEGA)
    expect(scelta('istituto', null, VOT_B)).toBeNull()
  })
})

describe('GET /api/parent/votazioni · i guasti', () => {
  it('schema assente (tabelle non migrate): 200 { disponibile: false, schede: [] } e un warn', async () => {
    h.errori = { votazioni: { code: 'PGRST205' } }
    const { stato, corpo } = await leggi()
    expect(stato).toBe(200)
    expect(corpo).toEqual({ disponibile: false, schede: [] })
    expect(h.logEvento).toHaveBeenCalledWith(
      'votazioni',
      'warn',
      expect.objectContaining({ esito: 'schema-votazioni-assente' }),
      expect.anything(),
    )
  })

  it.each(['votazioni_classi', 'votazioni_voti', 'votazioni_candidati'])(
    'schema assente anche solo su %s: disponibile false, non un 500',
    async (tabella) => {
      h.errori = { [tabella]: { code: '42P01' } }
      const { stato, corpo } = await leggi()
      expect(stato).toBe(200)
      expect(corpo).toEqual({ disponibile: false, schede: [] })
    },
  )

  it('un altro guasto sulle votazioni: 500 VOTAZIONE_OPERAZIONE_NON_RIUSCITA, mai schede vuote', async () => {
    h.errori = { votazioni: { code: 'XX000' } }
    const { stato, corpo } = await leggi()
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    expect(corpo.schede).toBeUndefined()
  })

  it('la lettura dei figli fallita: 500, non "nessuna votazione"', async () => {
    h.errori = { 'legame_genitori_alunni:select': { code: 'XX000' } }
    const { stato, corpo } = await leggi()
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
  })

  it('la lettura dei genitori fallita (nomi): 500, non una scheda con meno candidati', async () => {
    h.errori = { 'utenti:select': { code: 'XX000' } }
    const { stato, corpo } = await leggi()
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
  })

  it('un guasto di schema su una tabella che NON è delle votazioni non dice "non disponibile"', async () => {
    // `42703` sulle colonne di `utenti` è un guasto, non l'assenza delle tabelle `votazioni*`.
    h.errori = { 'utenti:select': { code: '42703' } }
    const { stato, corpo } = await leggi()
    expect(stato).toBe(500)
    expect(corpo.disponibile).toBeUndefined()
  })
})

describe('GET /api/parent/votazioni · isolamento di sede nelle letture', () => {
  it('ogni lettura sulle tabelle votazioni* filtra la sede: una votazione di una sede senza figli non esce', async () => {
    // L'elettore ha figli solo in A. Una votazione "aperta" di B con la classe A1 nella tabella delle classi
    // (dato incoerente) non deve produrre schede.
    h.utente = SOLO_A
    h.db.votazioni_classi.push(classeDi(VOT_B, SEDE_B, A1))
    const { corpo } = await leggi()
    expect(corpo.schede.some((s) => s.votazioneId === VOT_B)).toBe(false)
  })

  it('una riga di classe della votazione A con la scuola sbagliata non vale', async () => {
    // Riga incoerente: la classe A2 è legata alla votazione A ma con la sede B. Non produce la scheda A2.
    h.db.votazioni_classi = [classeDi(VOT_A, SEDE_A, A1), classeDi(VOT_A, SEDE_B, A2)]
    const { corpo } = await leggi()
    expect(corpo.schede.filter((s) => s.votazioneId === VOT_A && s.ambito === 'classe').map((s) => s.sectionId)).toEqual([A1])
  })
})
