import { describe, it, expect } from 'vitest'
import type { AppUser } from '@/lib/auth/require-staff'
import { verificaTargetAvvisoDocente } from '@/lib/avvisi/target-gate'
import { verificaVisibilitaDocente } from '@/lib/avvisi/gate-docente'
import { creaFintoSupabase, type Riga } from '../fixtures/finto-supabase'

// =============================================================================
// Giro di correzione 1 (4.3.6) — il controllo che DECIDE l'invio di un avviso (`target-gate`) conta solo i nomi delle
// sezioni dell'anno attivo. Il nome di una classe si ripete ogni anno: un docente assegnato soltanto a «Girasoli»
// dell'anno scorso (sola lettura) non deve poter scrivere agli avvisi di «Girasoli» di quest'anno.
// QUI il modulo dei docenti è quello VERO (non un mock del suo helper): ciò che varia è la risposta della funzione SQL.
// =============================================================================

const SEDE = '22222222-2222-4222-8222-222222222222'
const SEZ_VECCHIA = '55555555-5555-4555-8555-555555555551'
const SEZ_ATTUALE_ALTRA = '55555555-5555-4555-8555-555555555552'
const SEZ_ATTUALE_GIRASOLI = '55555555-5555-4555-8555-555555555553'
const educator: AppUser = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', role: 'educator', scuola_id: SEDE }

const sections: Riga[] = [
  { id: SEZ_VECCHIA, name: 'Girasoli', scuola_id: SEDE },
  { id: SEZ_ATTUALE_ALTRA, name: 'Tulipani', scuola_id: SEDE },
  { id: SEZ_ATTUALE_GIRASOLI, name: 'Girasoli', scuola_id: SEDE },
]

/** Il docente è assegnato a «Girasoli» dell'anno passato (sola lettura) e a «Tulipani» di quest'anno. */
const sb = () =>
  creaFintoSupabase({ sections }, [], {
    rpc: {
      sezioni_visibili_docente: () => ({
        data: [
          { section_id: SEZ_VECCHIA, sola_lettura: true },
          { section_id: SEZ_ATTUALE_ALTRA, sola_lettura: false },
        ],
        error: null,
      }),
    },
  }) as never

describe('invio degli avvisi: solo l’anno attivo (e la lettura resta sulle visibili)', () => {
  it('target: un nome di classe che esiste solo nell’anno passato del docente NON autorizza', async () => {
    const res = await verificaTargetAvvisoDocente(sb(), educator, { scope: 'classe', classi: ['Girasoli'] })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('target: la classe dell’anno attivo è ammessa', async () => {
    expect(await verificaTargetAvvisoDocente(sb(), educator, { scope: 'classe', classi: ['Tulipani'] })).toBeNull()
  })

  it('target: i nomi restano quelli dell’anno attivo anche con più classi (una sola ammessa, l’altra no)', async () => {
    const res = await verificaTargetAvvisoDocente(sb(), educator, { scope: 'classe', classi: ['Tulipani', 'Girasoli'] })
    expect(res!.status).toBe(403)
  })

  it('LETTURA invariata: il gate di visibilità di un avviso (GET) vede anche le classi dell’anno passato', async () => {
    const res = await verificaVisibilitaDocente(
      sb(), educator,
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', scope: 'classe', target_classes: ['Girasoli'], scuola_id: SEDE } as never,
      'avvisi/test',
    )
    expect(res).toBeNull()
  })
})
