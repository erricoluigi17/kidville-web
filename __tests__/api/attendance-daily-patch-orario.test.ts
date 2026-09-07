/**
 * `PATCH /api/attendance/daily` — la RETTIFICA di un orario dell'appello 0-6.
 *
 * ─── PERCHÉ UNA PORTA NUOVA, E NON LA `POST` CHE C'ERA ────────────────────────
 *
 * La `POST` è un **upsert della riga intera**, e porta dentro anche la logica
 * delle notifiche d'assenza. Riusarla per cambiare un'ora vorrebbe dire, in un
 * colpo solo: azzerare l'ALTRO orario (riga 324 della pagina:
 * `orario_uscita = stato === 'uscita_anticipata' ? now : null`), riasserire lo
 * stato, e rientrare nel ramo che revoca le notifiche già mandate ai genitori.
 * Tre effetti collaterali per un'operazione che ne vuole zero.
 *
 * ─── COSA QUESTO FILE SORVEGLIA ──────────────────────────────────────────────
 *
 * 1. **È una patch, non un upsert**: l'oggetto passato a `.update()` contiene solo
 *    il campo toccato. È l'asserzione centrale del file, e va letta al contrario:
 *    `expect('orario_uscita' in aggiornamento).toBe(false)`.
 * 2. **Il formato scritto è l'istante**, calcolato dal SERVER col fuso di Roma. Sul
 *    filo passa `HH:MM` — che è ciò che l'`<input type="time">` produce, ed è
 *    l'unica forma che `@/lib/logging/redact` non lascia passare in chiaro (un ISO
 *    matcha `DATA_ISO` e uscirebbe intero in `app_log`: l'istante d'arrivo di un
 *    minore).
 * 3. **Un orario senza appello non significa niente**: riga assente ⇒ 409, non una
 *    riga creata dal nulla.
 * 4. **La coerenza con lo stato**: un `assente` non ha orari, un `presente` non ha
 *    un'uscita anticipata.
 * 5. **Una lettura fallita non è «non c'è»**: PostgREST non lancia, e senza il
 *    controllo di `{ error }` un guasto uscirebbe dalla porta del 409 — dicendo al
 *    docente che l'appello non è stato fatto quando invece non si è potuto leggere.
 *    È lo stesso rilievo già scritto nella `POST` di questo file.
 * 6. **Chi corregge lascia una traccia.** La primaria scrive in
 *    `audit_scritture_docente` da sempre; lo 0-6 no. Correggere a mano un orario —
 *    e per i giorni passati — è una rettifica del registro: senza audit, «l'orario
 *    dice 09:10 ma mio figlio era arrivato alle 08:30» non ha risposta.
 * 7. **Il diff dell'audit non porta dati sanitari**: la lettura chiede sei colonne,
 *    quindi `giustificazione_testo` e `giustificazione_firma` non possono finirci.
 *    È l'errore che la rotta gemella della primaria ha già pagato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  assertClasseNomeInScope: vi.fn(),
  restringiASedeRichiesta: vi.fn(),
  notificaEvento: vi.fn(),
  logScrittura: vi.fn(),
  /** Cosa ha ricevuto `.update()`, per tabella. */
  aggiornamenti: [] as Array<Record<string, unknown>>,
  /** Le tabelle toccate: serve a provare che dopo un 403 non si scrive. */
  tabelle: [] as string[],
  /** La riga di `presenze` che la lettura deve restituire (null = non registrata). */
  rigaPresenza: null as Record<string, unknown> | null,
  /** Errore iniettato sulla lettura di `presenze`. */
  erroreLettura: null as { code?: string; message?: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: h.assertAlunnoInScope,
  assertClasseNomeInScope: h.assertClasseNomeInScope,
  resolveScuoleAttive: h.resolveScuoleAttive,
}))
vi.mock('@/lib/auth/sede-richiesta', () => ({ restringiASedeRichiesta: h.restringiASedeRichiesta }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento, nomeUtente: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      h.tabelle.push(tabella)
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) qb[m] = () => qb
      qb.maybeSingle = async () =>
        tabella === 'presenze'
          ? { data: h.rigaPresenza, error: h.erroreLettura }
          : { data: null, error: null }
      qb.single = async () => ({
        data: { ...(h.rigaPresenza ?? {}), ...(h.aggiornamenti.at(-1) ?? {}) },
        error: null,
      })
      qb.update = (v: Record<string, unknown>) => {
        if (tabella === 'presenze') h.aggiornamenti.push(v)
        return qb
      }
      qb.upsert = () => qb
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return qb
    },
  })),
}))

import { PATCH } from '@/app/api/attendance/daily/route'

const DOCENTE = 'd0000000-0000-4000-8000-0000000000d1'
const ALUNNO = '11111111-1111-4111-8111-111111111111'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a001'
const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const PRESENZA = 'cccc0000-0000-4000-8000-00000000c001'
const GIORNO = '2026-09-07'

const richiesta = (corpo: unknown): NextRequest =>
  new NextRequest('http://localhost/api/attendance/daily', {
    method: 'PATCH',
    body: JSON.stringify(corpo),
    headers: { 'content-type': 'application/json' },
  })

const riga = (extra: Record<string, unknown> = {}) => ({
  id: PRESENZA,
  alunno_id: ALUNNO,
  data: GIORNO,
  stato: 'presente',
  orario_entrata: '2026-09-07T06:00:00.000Z',
  orario_uscita: null,
  scuola_id: SEDE,
  section_id: SEZIONE,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.aggiornamenti = []
  h.tabelle = []
  h.erroreLettura = null
  h.rigaPresenza = riga()
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.logScrittura.mockResolvedValue(undefined)
})

describe('è una PATCH, non un upsert travestito', () => {
  it('cambiando l\'ingresso, l\'USCITA non viene nemmeno nominata', async () => {
    h.rigaPresenza = riga({ stato: 'uscita_anticipata', orario_uscita: '2026-09-07T11:00:00.000Z' })
    const res = await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))

    expect(res.status).toBe(200)
    expect(h.aggiornamenti).toHaveLength(1)
    const agg = h.aggiornamenti[0]
    expect('orario_uscita' in agg).toBe(false)
    expect('stato' in agg).toBe(false)
  })

  it('e viceversa: cambiando l\'uscita, l\'INGRESSO resta intoccato', async () => {
    h.rigaPresenza = riga({ stato: 'uscita_anticipata', orario_uscita: '2026-09-07T11:00:00.000Z' })
    await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_uscita: '15:30' }))

    expect('orario_entrata' in h.aggiornamenti[0]).toBe(false)
  })

  it('nessuna notifica viene toccata: rettificare un\'ora non è rifare l\'appello', async () => {
    await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })
})

describe('il formato scritto è l\'istante, calcolato a Roma dal server', () => {
  it('08:45 del 7 settembre (ora legale) → 06:45 UTC', async () => {
    await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))
    expect(h.aggiornamenti[0].orario_entrata).toBe('2026-09-07T06:45:00.000Z')
  })

  it('lo stesso 08:45 a gennaio (ora solare) → 07:45 UTC: l\'offset non è cablato', async () => {
    h.rigaPresenza = riga({ data: '2026-01-15' })
    await PATCH(richiesta({ alunno_id: ALUNNO, data: '2026-01-15', orario_entrata: '08:45' }))
    expect(h.aggiornamenti[0].orario_entrata).toBe('2026-01-15T07:45:00.000Z')
  })

  it('la riga porta anche `aggiornato_il`', async () => {
    await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))
    expect(typeof h.aggiornamenti[0].aggiornato_il).toBe('string')
  })
})

describe('cosa la porta rifiuta', () => {
  it('appello non registrato ⇒ 409 con un codice, non una riga creata dal nulla', async () => {
    h.rigaPresenza = null
    const res = await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))

    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('APPELLO_NON_REGISTRATO')
    expect(h.aggiornamenti).toHaveLength(0)
  })

  it('lettura FALLITA ⇒ 500, mai 409: «non c\'è» e «non l\'ho potuto leggere» sono due cose diverse', async () => {
    h.rigaPresenza = null
    h.erroreLettura = { code: '42501', message: 'permission denied' }
    const res = await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))

    expect(res.status).toBe(500)
    expect(h.aggiornamenti).toHaveLength(0)
  })

  it('un ASSENTE non ha orari ⇒ 422', async () => {
    h.rigaPresenza = riga({ stato: 'assente', orario_entrata: null })
    const res = await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))

    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ORARIO_INCOERENTE')
    expect(h.aggiornamenti).toHaveLength(0)
  })

  it('un PRESENTE non ha un\'uscita anticipata ⇒ 422', async () => {
    const res = await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_uscita: '15:30' }))
    expect(res.status).toBe(422)
    expect(h.aggiornamenti).toHaveLength(0)
  })

  it.each(['99:99', '25:00', '8:5', 'boh', ''])('un\'ora malformata ⇒ 400: %p', async (ora) => {
    const res = await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: ora }))
    expect(res.status).toBe(400)
    expect(h.aggiornamenti).toHaveLength(0)
  })

  it('un corpo senza nessuno dei due orari ⇒ 400: non c\'è niente da rettificare', async () => {
    const res = await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO }))
    expect(res.status).toBe(400)
    expect(h.aggiornamenti).toHaveLength(0)
  })

  it('fuori scope: risponde il gate, e `presenze` non viene nemmeno letta', async () => {
    const { NextResponse } = await import('next/server')
    h.assertAlunnoInScope.mockResolvedValue(NextResponse.json({ error: 'no' }, { status: 403 }))
    const res = await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))

    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('presenze')
    expect(h.aggiornamenti).toHaveLength(0)
  })
})

describe('la traccia di chi ha corretto', () => {
  it('scrive in audit_scritture_docente, con attore e sezione', async () => {
    await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))

    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const arg = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(arg.entitaTipo).toBe('presenze')
    expect(arg.azione).toBe('update')
    expect(arg.entitaId).toBe(PRESENZA)
    expect(arg.sectionId).toBe(SEZIONE)
    expect((arg.attore as { id: string }).id).toBe(DOCENTE)
  })

  it('il diff non porta il motivo scritto dal genitore né la sua firma', async () => {
    h.rigaPresenza = riga({
      giustificazione_testo: 'febbre da ieri sera',
      giustificazione_firma: { email: 'x@y.z', ip: '1.2.3.4' },
    })
    await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))

    const arg = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    const diff = JSON.stringify([arg.valorePrima, arg.valoreDopo])
    expect(diff).not.toContain('febbre')
    expect(diff).not.toContain('giustificazione_testo')
    expect(diff).not.toContain('giustificazione_firma')
  })

  it('se non si scrive niente, non si audita niente', async () => {
    h.rigaPresenza = null
    await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))
    expect(h.logScrittura).not.toHaveBeenCalled()
  })
})

describe('la risposta', () => {
  it('porta esattamente le sei colonne dell\'appello, come la POST', async () => {
    const res = await PATCH(richiesta({ alunno_id: ALUNNO, data: GIORNO, orario_entrata: '08:45' }))
    const corpo = await res.json()
    expect(Object.keys(corpo).sort()).toEqual(
      ['alunno_id', 'data', 'id', 'orario_entrata', 'orario_uscita', 'stato'].sort(),
    )
  })
})
