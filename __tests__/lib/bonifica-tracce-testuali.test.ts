import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// LE TRACCE DI TESTO SENZA FK — una procedura, due canali (2026-10-09).
//
// `bonificaTracceTestualiAlunno` è stata estratta da `anonimizzaAlunno` perché anche
// l'eliminazione definitiva di una scheda non iscritta la deve usare: la funzione SQL
// cancella la riga `alunni` e ciò che è in CASCADE, ma notifiche, segnalazioni di
// moderazione e audit del diario senza id non hanno FK verso il bambino e resterebbero.
//
// Questo file prova la funzione DA SOLA, col finto client che applica davvero i filtri e
// le scritture: le asserzioni sono sulle righe rimaste nel finto DB, non sul solo conteggio.
// Che `anonimizzaAlunno` la chiami senza cambiare il proprio comportamento lo provano i test
// dell'oblio, rimasti invariati (`gdpr-oblio-notifiche`, `gdpr-esegui`, `gdpr-oblio-completo`…).
// =============================================================================

const spie = vi.hoisted(() => ({ logErrore: vi.fn(), logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: spie.logErrore, logEvento: spie.logEvento }
})

import { bonificaTracceTestualiAlunno } from '@/lib/gdpr/esegui'

const NOSTRO = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ALTRO = 'bbbbbbbb-0000-4000-8000-00000000000b'

function db(): DBFinto {
  return {
    presenze: [
      { id: 'pr-1', alunno_id: NOSTRO },
      { id: 'pr-9', alunno_id: ALTRO },
    ],
    notifiche: [
      { id: 'n-alunno', entita_id: NOSTRO, utente_id: 'u-1' },
      { id: 'n-presenza', entita_id: 'pr-1', utente_id: 'u-1' },
      { id: 'n-altro-alunno', entita_id: ALTRO, utente_id: 'u-2' },
      { id: 'n-altra-presenza', entita_id: 'pr-9', utente_id: 'u-2' },
    ],
    eventi_diario: [
      { id: 'd-1', alunno_id: NOSTRO },
      { id: 'd-9', alunno_id: ALTRO },
    ],
    galleria_media_v2: [
      { id: 'm-1', tag_students: [NOSTRO], cestinato_il: null },
      { id: 'm-9', tag_students: [ALTRO], cestinato_il: null },
    ],
    chat_threads: [
      { id: 't-1', student_id: NOSTRO },
      { id: 't-9', student_id: ALTRO },
    ],
    segnalazioni: [
      { id: 's-diario', tipo_oggetto: 'voce_diario', oggetto_id: 'd-1', thread_id: null, motivo: 'TESTO DI PROVA', note_gestione: 'NOTA DI PROVA' },
      { id: 's-media', tipo_oggetto: 'media_galleria', oggetto_id: 'm-1', thread_id: null, motivo: 'TESTO DI PROVA', note_gestione: 'NOTA DI PROVA' },
      { id: 's-chat', tipo_oggetto: 'messaggio_chat', oggetto_id: 'msg-1', thread_id: 't-1', motivo: 'TESTO DI PROVA', note_gestione: 'NOTA DI PROVA' },
      { id: 's-diario-altro', tipo_oggetto: 'voce_diario', oggetto_id: 'd-9', thread_id: null, motivo: 'TESTO ALTRUI', note_gestione: 'NOTA ALTRUI' },
      { id: 's-chat-altro', tipo_oggetto: 'messaggio_chat', oggetto_id: 'msg-9', thread_id: 't-9', motivo: 'TESTO ALTRUI', note_gestione: 'NOTA ALTRUI' },
    ],
    conversazioni_sospensioni: [
      { id: 'so-1', thread_id: 't-1', motivo: 'TESTO DI PROVA' },
      { id: 'so-9', thread_id: 't-9', motivo: 'TESTO ALTRUI' },
    ],
    audit_scritture_docente: [
      { id: 'a-1', entita_tipo: 'diario', entita_id: null, valore_prima: [{ id: 'd-x', alunno_id: NOSTRO, nota_bambino: 'NOTA DI PROVA' }], valore_dopo: null },
      { id: 'a-9', entita_tipo: 'diario', entita_id: null, valore_prima: [{ id: 'd-y', alunno_id: ALTRO, nota_bambino: 'NOTA ALTRUI' }], valore_dopo: null },
    ],
  }
}

const riga = (d: DBFinto, tabella: string, id: string) => d[tabella].find((r) => r.id === id)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('bonificaTracceTestualiAlunno — le notifiche', () => {
  it('rimuove la notifica che punta al bambino E quella che punta a una sua presenza; quelle di un altro restano', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d), NOSTRO, 'test')

    const rimaste = d.notifiche.map((n) => n.id).sort()
    // `assenza_non_comunicata`/`mensa_saldo_basso` puntano all'ALUNNO, `assenza_comunicata`/
    // `giustifica_ricevuta` alla PRESENZA: due spazi-id nella stessa colonna, servono entrambi.
    expect(rimaste, 'una notifica che nomina il bambino è rimasta in campanella').toEqual(['n-altra-presenza', 'n-altro-alunno'])
    expect(r.notificheRimosse).toBe(2)
    expect(r.completo).toBe(true)
  })
})

describe('bonificaTracceTestualiAlunno — segnalazioni, sospensioni, audit', () => {
  it('azzera motivo e note della segnalazione su una SUA voce di diario; quella su un altro bambino resta', async () => {
    const d = db()
    await bonificaTracceTestualiAlunno(creaFintoSupabase(d), NOSTRO, 'test')

    expect(riga(d, 'segnalazioni', 's-diario')).toMatchObject({ motivo: null, note_gestione: null })
    expect(riga(d, 'segnalazioni', 's-diario-altro')).toMatchObject({ motivo: 'TESTO ALTRUI', note_gestione: 'NOTA ALTRUI' })
  })

  it('arriva anche alle segnalazioni sui suoi media e sui suoi thread, alle sospensioni e all’audit del diario senza id', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d), NOSTRO, 'test')

    expect(riga(d, 'segnalazioni', 's-media')).toMatchObject({ motivo: null, note_gestione: null })
    expect(riga(d, 'segnalazioni', 's-chat')).toMatchObject({ motivo: null, note_gestione: null })
    expect(riga(d, 'segnalazioni', 's-chat-altro')).toMatchObject({ motivo: 'TESTO ALTRUI' })
    expect(riga(d, 'conversazioni_sospensioni', 'so-1')!.motivo).toBeNull()
    expect(riga(d, 'conversazioni_sospensioni', 'so-9')!.motivo).toBe('TESTO ALTRUI')
    expect(riga(d, 'audit_scritture_docente', 'a-1')!.valore_prima).toBeNull()
    expect(riga(d, 'audit_scritture_docente', 'a-9')!.valore_prima).not.toBeNull()

    expect(r).toMatchObject({
      segnalazioniBonificate: 3,
      sospensioniBonificate: 1,
      completo: true,
      threadIds: ['t-1'],
      threadLetti: true,
      auditDiarioCompleto: true,
    })
  })
})

describe('bonificaTracceTestualiAlunno — un passo a metà deve essere VISIBILE', () => {
  it('lettura delle voci di diario rifiutata (42501) → `completo: false`, logga, e gli altri passi vanno avanti', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(
      creaFintoSupabase(d, [], { errori: { 'eventi_diario:select': { code: '42501', message: 'permission denied' } } }),
      NOSTRO,
      'test',
    )

    expect(r.completo, '«non ho potuto guardare» dichiarato come «non c’era niente»').toBe(false)
    // La segnalazione sulla voce di diario non si è potuta raggiungere…
    expect(riga(d, 'segnalazioni', 's-diario')).toMatchObject({ motivo: 'TESTO DI PROVA' })
    // …ma best-effort come il resto del file: le altre tracce escono lo stesso.
    expect(d.notifiche.map((n) => n.id).sort()).toEqual(['n-altra-presenza', 'n-altro-alunno'])
    expect(riga(d, 'segnalazioni', 's-media')).toMatchObject({ motivo: null })
    const eventi = spie.logErrore.mock.calls.map((c) => (c[0] as { evento?: string }).evento)
    expect(eventi).toContain('oblio_segnalazioni_diario_select')
  })

  it('lettura dei thread rifiutata → `threadLetti: false` e `completo: false`', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(
      creaFintoSupabase(d, [], { errori: { 'chat_threads:select': { code: '42501' } } }),
      NOSTRO,
      'test',
    )
    expect(r).toMatchObject({ threadLetti: false, completo: false, threadIds: [] })
    expect(riga(d, 'conversazioni_sospensioni', 'so-1')!.motivo).toBe('TESTO DI PROVA')
  })

  it('cancellazione delle notifiche rifiutata → `completo: false` (non «zero notifiche da togliere»)', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(
      creaFintoSupabase(d, [], { errori: { 'notifiche:delete': { code: '42501' } } }),
      NOSTRO,
      'test',
    )
    expect(r.notificheRimosse).toBe(0)
    expect(r.completo).toBe(false)
    expect(d.notifiche).toHaveLength(4)
  })

  it('schema assente (DB E2E non migrato, 42P01) NON è un passo fallito: degrada come il resto del file', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(
      creaFintoSupabase(d, [], { errori: { segnalazioni: { code: '42P01' }, conversazioni_sospensioni: { code: '42P01' } } }),
      NOSTRO,
      'test',
    )
    expect(r.completo).toBe(true)
    expect(spie.logErrore).not.toHaveBeenCalled()
  })
})
