import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * IL TEST CHE IL 1° SETTEMBRE SAREBBE STATO ROSSO.
 *
 * ─── IL FATTO ───────────────────────────────────────────────────────────────
 * `alunni` tiene la classe in due colonne: `section_id` (uuid, la FK vera) e
 * `classe_sezione` (testo). Il trigger `sync_alunno_section_id` va SOLO testo →
 * uuid e confronta senza spazi né maiuscole — quindi il foglio d'iscrizione può
 * scrivere «4 anni  a» e il bambino finisce lo stesso nella sezione giusta,
 * mentre il TESTO resta diverso da `sections.name`.
 *
 * L'area docente 0-6 cercava i bambini per testo. Misurato in produzione il
 * 2026-09-02, tutte a Kidville Giugliano:
 *
 *   4 ANNI A  17 bambini, ne mostrava  0   (testo «4 anni  a», due spazi)
 *   4 ANNI B  19 bambini, ne mostrava  0
 *   3 ANNI B  14 bambini, ne mostrava  1   (testo «3 ANNI B », spazio finale)
 *   5 ANNI A  11 bambini, ne mostrava  1
 *   5 ANNI B  16 bambini, ne mostrava  4
 *
 * Il gate `assertClasseNomeInScope` risolveva il nome in `sections` e PASSAVA —
 * la sezione esiste davvero — quindi la risposta era **200 con `[]`**: nessun
 * errore, nessun log, schermata bianca. Controprova incrociata: l'appello del
 * 1° e 2 settembre risulta registrato SOLO nelle sezioni col testo coincidente.
 *
 * ─── PERCHÉ QUESTO TEST NON POTEVA ESISTERE PRIMA ───────────────────────────
 * Con un mock piatto — quelli che rispondono sempre la stessa lista — questo
 * caso è VERDE con e senza la correzione: il mock non applica il filtro, quindi
 * i 17 bambini escono comunque. È la ragione per cui il difetto è arrivato in
 * produzione con 13.254 test verdi.
 *
 * Qui si usa `finto-supabase`, che i filtri li applica davvero e LANCIA su un
 * operatore che non sa applicare. Il gate resta quello vero (`scope` non è
 * mockato): la sezione è assegnata al docente in `utenti_sezioni`, come in
 * produzione.
 *
 * ─── IL CASO PARZIALE È QUELLO CHE CONTA ────────────────────────────────────
 * Una classe vuota fa telefonare l'assistenza. Una classe con UN bambino su
 * quattordici sembra vera, e resta rotta per settimane. Per questo si asserisce
 * il numero ESATTO: un test che chiedesse `!== 0` sarebbe stato verde su
 * `3 ANNI B` mentre tredici bambini su quattordici erano invisibili.
 */

const SEDE = 'd53b0fbc-0000-4000-8000-00000000000a'
const SEC_4A = 'c4a00000-0000-4000-8000-00000000004a'
const SEC_3B = 'c3b00000-0000-4000-8000-00000000003b'
const DOCENTE = 'e0e00000-0000-4000-8000-0000000000ed'
const GIORNO = '2026-09-02'

/** Il nome com'è in anagrafica — quello che `/api/educator-sections` restituisce. */
const NOME_4A = '4 ANNI A'
const NOME_3B = '3 ANNI B'
/** Il testo com'è sugli alunni, scritto dal foglio d'iscrizione. */
const TESTO_4A = '4 anni  a'
const TESTO_3B = '3 ANNI B '

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, []),
    createClient: async () => creaFintoSupabase(h.db, []),
  }
})

import { GET as GET_STUDENTS } from '@/app/api/diary/students/route'
import { GET as GET_DAILY } from '@/app/api/attendance/daily/route'
import { GET as GET_MONTHLY } from '@/app/api/attendance/monthly/route'
import { GET as GET_DELEGATES } from '@/app/api/attendance/delegates/route'

/** Un bambino della sezione: `section_id` GIUSTO, testo DIVERGENTE. */
const bimbo = (n: number, sezione: string, testo: string) => ({
  id: `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  nome: `Nome${n}`,
  cognome: `Cognome${String(n).padStart(2, '0')}`,
  section_id: sezione,
  classe_sezione: testo,
  scuola_id: SEDE,
  stato: 'iscritto',
  note_mediche: null,
  consenso_privacy: true,
})

const dbBase = (): DBFinto => {
  // 4 ANNI A: 17 bambini, TUTTI col testo divergente → in produzione ne usciva 0.
  const quattroA = Array.from({ length: 17 }, (_, i) => bimbo(i + 1, SEC_4A, TESTO_4A))
  // 3 ANNI B: 14 bambini, di cui UNO SOLO col testo canonico → ne usciva 1.
  const treB = [
    ...Array.from({ length: 13 }, (_, i) => bimbo(100 + i, SEC_3B, TESTO_3B)),
    bimbo(199, SEC_3B, NOME_3B),
  ]
  const alunni = [...quattroA, ...treB]
  return {
    sections: [
      { id: SEC_4A, scuola_id: SEDE, name: NOME_4A, school_type: 'infanzia' },
      { id: SEC_3B, scuola_id: SEDE, name: NOME_3B, school_type: 'infanzia' },
    ],
    utenti_scuole: [],
    // Il docente è assegnato a ENTRAMBE, per uuid: come in produzione.
    utenti_sezioni: [
      { utente_id: DOCENTE, section_id: SEC_4A },
      { utente_id: DOCENTE, section_id: SEC_3B },
    ],
    alunni,
    legame_genitori_alunni: [],
    student_parents: [],
    parents: [],
    utenti: [],
    // Un appello già registrato per ogni bambino di 4 ANNI A.
    presenze: quattroA.map((a, i) => ({
      id: `p${i}`,
      alunno_id: a.id,
      data: GIORNO,
      stato: 'presente',
      orario_entrata: null,
      orario_uscita: null,
      alunni: { id: a.id, nome: a.nome, cognome: a.cognome, section_id: SEC_4A, classe_sezione: TESTO_4A, scuola_id: SEDE },
    })),
    // Un delegato al ritiro per ogni bambino di 4 ANNI A: qui l'elenco vuoto ha
    // una conseguenza fisica — nessuno autorizzato, il bambino resta a scuola.
    delegates: quattroA.map((a, i) => ({
      id: `d${i}`,
      student_id: a.id,
      first_name: 'Nonna',
      last_name: `Cognome${i}`,
      document_number: `DOC-${i}`,
      alunni: { section_id: SEC_4A, classe_sezione: TESTO_4A, scuola_id: SEDE },
    })),
  }
}

const url = (rotta: string, qs: string) => new NextRequest(`http://localhost/api/${rotta}?${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.requireDocente.mockResolvedValue({
    response: null,
    user: { id: DOCENTE, role: 'educator', scuola_id: SEDE },
  })
})

describe('il testo della classe diverge dal nome della sezione', () => {
  describe('la classe si apriva VUOTA (4 ANNI A: 17 bambini, ne mostrava 0)', () => {
    it("l'elenco della classe li restituisce tutti e 17", async () => {
      const res = await GET_STUDENTS(url('diary/students', `sezione=${encodeURIComponent(NOME_4A)}`) as never)
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveLength(17)
    })

    it("l'appello del giorno li restituisce tutti e 17", async () => {
      const res = await GET_DAILY(url('attendance/daily', `data=${GIORNO}&sezione=${encodeURIComponent(NOME_4A)}`) as never)
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveLength(17)
    })

    it('il prospetto mensile li restituisce tutti e 17', async () => {
      const res = await GET_MONTHLY(url('attendance/monthly', `year=2026&month=9&sezione=${encodeURIComponent(NOME_4A)}`) as never)
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveLength(17)
    })

    it('i delegati al ritiro sono tutti e 17 — qui il vuoto lascia un bambino a scuola', async () => {
      const res = await GET_DELEGATES(url('attendance/delegates', `sezione=${encodeURIComponent(NOME_4A)}`) as never)
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveLength(17)
    })
  })

  describe('la classe si apriva PARZIALE (3 ANNI B: 14 bambini, ne mostrava 1)', () => {
    it('li restituisce tutti e 14, non solo quello col testo giusto', async () => {
      const res = await GET_STUDENTS(url('diary/students', `sezione=${encodeURIComponent(NOME_3B)}`) as never)
      const corpo = await res.json()
      // Il numero ESATTO, non `> 0`: con `!== 0` questo test sarebbe stato verde
      // mentre tredici bambini su quattordici erano invisibili alla maestra.
      expect(corpo).toHaveLength(14)
    })
  })

  describe("la strada nuova e la vecchia danno lo stesso risultato", () => {
    it("`?sectionId=` restituisce quel che restituisce `?sezione=`", async () => {
      const perNome = await (await GET_STUDENTS(url('diary/students', `sezione=${encodeURIComponent(NOME_4A)}`) as never)).json()
      const perUuid = await (await GET_STUDENTS(url('diary/students', `sectionId=${SEC_4A}`) as never)).json()
      expect(perUuid).toHaveLength(17)
      expect(perUuid.map((a: { id: string }) => a.id).sort()).toEqual(perNome.map((a: { id: string }) => a.id).sort())
    })

    it('il TESTO divergente non è più un\'identità accettata: «4 anni  a» non seleziona nessuno', async () => {
      // Il gate risolve il nome in `sections` e non lo trova: 403, non un 200
      // con l'elenco vuoto. È la differenza fra «non sei autorizzato» e «non
      // c'è nessuno», che prima non esisteva.
      const res = await GET_STUDENTS(url('diary/students', `sezione=${encodeURIComponent(TESTO_4A)}`) as never)
      expect(res.status).toBe(403)
    })
  })

  describe('il gate NON si allenta passando all\'uuid', () => {
    it('una sezione dello stesso plesso ma NON assegnata al docente resta 403', async () => {
      // È il rischio proprio di questo intervento: passare a
      // `assertSezioneInScope` senza portarsi dietro la clausola sulle sezioni
      // assegnate allargherebbe i permessi dell'educator a tutto il plesso, e
      // nessun test che conti righe se ne accorgerebbe.
      h.db.utenti_sezioni = [{ utente_id: DOCENTE, section_id: SEC_3B }]
      const res = await GET_STUDENTS(url('diary/students', `sectionId=${SEC_4A}`) as never)
      expect(res.status).toBe(403)
    })

    it('lo stesso vale per la strada vecchia, col nome', async () => {
      h.db.utenti_sezioni = [{ utente_id: DOCENTE, section_id: SEC_3B }]
      const res = await GET_STUDENTS(url('diary/students', `sezione=${encodeURIComponent(NOME_4A)}`) as never)
      expect(res.status).toBe(403)
    })
  })
})
