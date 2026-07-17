import { describe, it, expect, vi } from 'vitest'

// M6 — l'alert allergie mensa (allergene del bambino nel menu del giorno) deve
// raggiungere anche il ruolo `segreteria`, che gestisce la mensa. Nel collaudo
// live la notifica andava ad admin/coordinator/cuoca/docenti ma NON a
// `test.segreteria`: il set `ruoliSegreteriaCuoca` ometteva 'segreteria'.
// Qui si prova la composizione dei destinatari (funzione pura data la supabase).

// Le dipendenze pesanti di notify.ts non servono a destinatariAllerta: si stubbano.
vi.mock('@/lib/push/web-push', () => ({ sendPush: vi.fn() }))
vi.mock('@/lib/mensa/allergeni', () => ({ allergeneLabel: (a: string) => a }))
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: vi.fn(async () => true) }))
// La maestra della sezione del bambino: mappata su 'maestra1'.
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: vi.fn(async () => ['maestra1']) }))

import { destinatariAllerta } from '@/lib/mensa/notify'

function fakeSupabase(utenti: Record<string, unknown>[]) {
  return {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: utenti, error: null }),
      }),
    }),
  } as unknown as Parameters<typeof destinatariAllerta>[0]
}

describe('destinatariAllerta — alert allergie mensa (M6)', () => {
  const utenti = [
    { id: 'admin1', ruolo: 'admin' },
    { id: 'coord1', ruolo: 'coordinator' },
    { id: 'segr1', ruolo: 'segreteria' },
    { id: 'cuoca1', ruolo: 'cuoca' },
    { id: 'maestra1', ruolo: 'maestra' }, // docente della sezione del bambino
    { id: 'maestra2', ruolo: 'maestra' }, // docente di altra sezione: NON deve ricevere
    { id: 'genit1', ruolo: 'genitore' },
  ]

  it('include il ruolo segreteria tra i destinatari', async () => {
    const out = await destinatariAllerta(fakeSupabase(utenti), 'sc-1', 'sez-1')
    // La falla M6: prima 'segreteria' era escluso dal set → segr1 mancava.
    expect(out).toContain('segr1')
  })

  it('destinatari finali = admin + coordinator + segreteria + cuoca + maestra di sezione', async () => {
    const out = await destinatariAllerta(fakeSupabase(utenti), 'sc-1', 'sez-1')
    expect(out).toEqual(expect.arrayContaining(['admin1', 'coord1', 'segr1', 'cuoca1', 'maestra1']))
    // il genitore non riceve l'alert; la maestra di ALTRA sezione neppure
    expect(out).not.toContain('genit1')
    expect(out).not.toContain('maestra2')
  })
})
