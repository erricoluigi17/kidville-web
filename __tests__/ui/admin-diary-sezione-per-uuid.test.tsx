import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

/**
 * COCKPIT /admin/diary — LA SEZIONE È UN UUID, E LA SEDE ARRIVA ALL'EDITOR (2026-09-28).
 *
 * Il cockpit sceglieva la sezione per NOME e lo passava così alle rotte: «Girasoli» esiste in più
 * sedi, e la lista mescolava bambini di due plessi — con le routine di una sola (il server le
 * controlla sulla sede di ogni bambino, e rifiutava l'intero lotto), e un «Compilato» che contava
 * entrambe. Ora la sezione viaggia per uuid, e la sede del selettore arriva a routine e contatore.
 */

const stub = vi.hoisted(() => ({ chiamate: [] as string[] }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/diary',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u1', role: 'segreteria', ready: true }),
}));
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

import AdminDiaryPage from '@/app/(dashboard)/admin/diary/page';
import { invalidaDiarioConfigCache } from '@/lib/diary/config-cache';

const GIUGLIANO = 'aaaaaaaa-0000-4000-8000-00000000000a';
const AVERSA = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SEZ_G = '11111111-0000-4000-8000-000000000001';
const SEZ_A = '22222222-0000-4000-8000-000000000002';

const risposta = (corpo: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => corpo });

beforeEach(() => {
  stub.chiamate = [];
  invalidaDiarioConfigCache();
  vi.stubGlobal('fetch', vi.fn((url: unknown) => {
    const u = String(url);
    stub.chiamate.push(u);
    if (u.includes('/api/admin/sections/scoped')) {
      return risposta({
        success: true,
        data: [
          { scuolaId: GIUGLIANO, scuolaNome: 'Giugliano', sezioni: [{ id: SEZ_G, name: 'Girasoli', school_type: 'infanzia' }] },
          { scuolaId: AVERSA, scuolaNome: 'Aversa', sezioni: [{ id: SEZ_A, name: 'Girasoli', school_type: 'infanzia' }] },
        ],
      });
    }
    if (u.includes('/api/diary/config')) return risposta({ routine_attive: null, routine_personalizzate: [] });
    if (u.includes('/api/diary/students')) return risposta([{ id: 'a1', nome: 'Ada', cognome: 'B', note_mediche: null }]);
    return risposta([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const chiamateA = (frammento: string) => stub.chiamate.filter((u) => u.includes(frammento));

describe('/admin/diary — sezioni omonime di sedi diverse', () => {
  it('bambini, voci e «Compilato» si chiedono per UUID della sezione; le routine per la sede scelta', async () => {
    render(<AdminDiaryPage />);
    await waitFor(() => expect(chiamateA('/api/diary/students').some((u) => u.includes(`sectionId=${SEZ_G}`))).toBe(true));
    await waitFor(() => expect(chiamateA('/api/diary/config').some((u) => u.includes(`scuola_id=${GIUGLIANO}`))).toBe(true));
    await waitFor(() => expect(chiamateA('/api/diary/entries').some((u) => u.includes(`sectionId=${SEZ_G}`) && u.includes(`scuola_id=${GIUGLIANO}`))).toBe(true));
    // Nessuna richiesta per NOME della sezione: è il nome che si ripete fra le sedi.
    expect(chiamateA('/api/diary/').filter((u) => u.includes('sezione=Girasoli'))).toEqual([]);
    // E la configurazione non si chiede mai senza sede (sarebbe quella di chi compila).
    expect(chiamateA('/api/diary/config').filter((u) => !u.includes('scuola_id='))).toEqual([]);
  });

  it('cambiata la sede, tutto segue la sezione e la sede nuove', async () => {
    render(<AdminDiaryPage />);
    const sede = await screen.findByDisplayValue('Giugliano');
    fireEvent.change(sede, { target: { value: AVERSA } });
    await waitFor(() => expect(chiamateA('/api/diary/students').some((u) => u.includes(`sectionId=${SEZ_A}`))).toBe(true));
    await waitFor(() => expect(chiamateA('/api/diary/config').some((u) => u.includes(`scuola_id=${AVERSA}`))).toBe(true));
  });
});
