import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { AvvisiPreview } from '@/components/features/parent/home/AvvisiPreview'
import itAvvisi from '../../messages/it/avvisi.json'
import itHome from '../../messages/it/home.json'

// =============================================================================
// L'ANTEPRIMA IN HOME — la stessa frase falsa, sulla schermata più vista.
//
// 🔴 IL DIFETTO MISURATO. `AvvisiPreview` decideva l'etichetta sul solo
// `my_response.risposta`: chi era in lista d'attesa leggeva «Hai aderito» nella
// home del genitore, cioè nel primo posto in cui si arriva e nell'unico che molte
// famiglie guardano. La card della bacheca aveva già smesso di dirlo — qui no, e
// il dato non mancava: `stato_adesione` arriva dalla STESSA `GET /api/avvisi` che
// questa anteprima già chiama. Mancava lo sguardo.
//
// ⚠️ Anteprima in SOLA LETTURA: nessuna azione, nessuna scrittura. Qui si misura
// soltanto che cosa c'è scritto sul badge.
// =============================================================================

afterEach(cleanup)

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const STUDENT_ID = 's-1'

/** Dati inventati: nessun nome reale di bambini o famiglie nei test. */
const avvisoBase = {
  id: 'avv-1',
  author_id: 'aut-1',
  titolo: 'TEST Gita al museo',
  contenuto: 'TEST corpo della comunicazione.',
  tipo: 'adesione',
  target_scope: 'globale',
  target_classes: null,
  scadenza: null,
  scadenza_avviso: '2026-10-01T09:00:00.000Z',
  scadenza_adesione: '2026-09-25T09:00:00.000Z',
  chiedi_numero: true,
  attachment_url: null,
  created_at: '2026-09-01T08:00:00.000Z',
  author: { first_name: 'TEST', last_name: 'Segreteria', role: 'segreteria' },
  stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
  scaduto: false,
  adesioni_chiuse: false,
}

const fetchOriginale = globalThis.fetch

/** Le due `GET` che l'anteprima fa, nell'ordine in cui le fa. */
function rispondiCon(avvisi: Array<Record<string, unknown>>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const corpo = url.startsWith('/api/diary/students')
      ? { id: STUDENT_ID, classe_sezione: '1A' }
      : avvisi
    return { ok: true, status: 200, json: async () => corpo } as unknown as Response
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  globalThis.fetch = fetchOriginale
})

afterEach(() => {
  globalThis.fetch = fetchOriginale
})

const monta = () => render(<AvvisiPreview parentId={PARENT_ID} studentId={STUDENT_ID} />)

describe('AvvisiPreview · in home la coda si chiama col suo nome', () => {
  it('🔴 IN ATTESA: il badge dice «In lista d’attesa», mai «Hai aderito»', async () => {
    rispondiCon([{
      ...avvisoBase,
      my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 2 },
      figli: [{ student_id: STUDENT_ID, nome: 'TEST Marco', stato_adesione: 'in_attesa', numero_partecipanti: 2 }],
    }])
    monta()

    // Si aspetta la PRESENZA dell'etichetta giusta: «non c'è scritto Hai aderito»
    // sarebbe vero anche mentre le due fetch sono ancora in volo.
    expect(await screen.findByText(itAvvisi.badgeInAttesa)).toBeInTheDocument()
    expect(
      screen.queryByText(itHome.avvisiHaiAderito),
      'la home promette ancora un posto a chi è in coda',
    ).not.toBeInTheDocument()
  })

  it('CONTROLLO POSITIVO: ammessa → il badge torna «Hai aderito»', async () => {
    // Senza questo, «non dice Hai aderito» sarebbe verde anche con l'etichetta
    // sparita, o bloccata per sempre su «In lista d’attesa».
    rispondiCon([{
      ...avvisoBase,
      my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 2 },
      figli: [{ student_id: STUDENT_ID, nome: 'TEST Marco', stato_adesione: 'ammessa', numero_partecipanti: 2 }],
    }])
    monta()

    expect(await screen.findByText(itHome.avvisiHaiAderito)).toBeInTheDocument()
    expect(screen.queryByText(itAvvisi.badgeInAttesa)).not.toBeInTheDocument()
  })

  it('🔴 basta UN figlio in coda, con l’aggregato a `null`', async () => {
    // Marco ammesso, Giulia in coda: `risposta` concorda («sì» per entrambi),
    // quindi il server azzera SOLO lo stato — e `null`, letto da solo, vale
    // «ammesso», perché le righe storiche non hanno stato.
    rispondiCon([{
      ...avvisoBase,
      my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: null, numero_partecipanti: 3 },
      figli: [
        { student_id: 's-1', nome: 'TEST Marco', stato_adesione: 'ammessa', numero_partecipanti: 3 },
        { student_id: 's-2', nome: 'TEST Giulia', stato_adesione: 'in_attesa', numero_partecipanti: 3 },
      ],
    }])
    monta()

    expect(await screen.findByText(itAvvisi.badgeInAttesa)).toBeInTheDocument()
    expect(screen.queryByText(itHome.avvisiHaiAderito)).not.toBeInTheDocument()
  })

  it('chi ha declinato e chi non ha ancora risposto restano come prima', async () => {
    rispondiCon([
      {
        ...avvisoBase,
        id: 'avv-no',
        titolo: 'TEST Declinato',
        my_response: { letto_il: 'x', risposta: 'no', risposto_il: 'x', stato_adesione: null, numero_partecipanti: null },
      },
      { ...avvisoBase, id: 'avv-muto', titolo: 'TEST Senza risposta', my_response: null },
    ])
    monta()

    expect(await screen.findByText(itHome.avvisiNonAderisci)).toBeInTheDocument()
    expect(screen.getByText(itHome.avvisiRichiedeAdesione)).toBeInTheDocument()
  })
})
