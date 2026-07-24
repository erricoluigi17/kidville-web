import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Come nel test auth: MensaCalendar importa (transitivamente) use-parent-identity
// → next/navigation. Il componente non usa quegli hook, il mock rende l'import
// innocuo in jsdom.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/parent/mensa',
}));

import { MensaCalendar } from '@/components/features/parent/mensa/MensaCalendar';
import itMensa from '../../messages/it/mensa.json';
import enMensa from '../../messages/en/mensa.json';

const IT = itMensa as Record<string, unknown>;
const EN = enMensa as Record<string, unknown>;

// Ogni stringa utente estratta dai due sorgenti mensa deve avere la sua chiave nel
// namespace, in ITALIANO (sorgente) e in INGLESE. La lista è il contratto della
// migrazione: se un componente usa t('x') senza la chiave, il mock next-intl
// risolve a "mensa.x" e i render-test qui sotto (e quelli auth) vanno rossi.
const CHIAVI_RICHIESTE = [
  'eyebrow', 'titolo', 'sottotitolo', 'nessunAlunno', 'nessunAlunnoAiuto',
  'caricamento', 'allergiaTitolo', 'allergiaCorpo', 'ticket', 'aggiornaSaldo',
  'cutoffNota', 'sessioneScaduta', 'accediDiNuovo', 'nonCollegato', 'saldoEsaurito',
  'nessunGiorno', 'mensaChiusa', 'menuNonPubblicato', 'prenotato', 'disdici',
  'prenotaPranzo', 'inseritoSegreteria', 'pranzoPrenotato', 'prenotazioneDisdetta',
  'operazioneNonRiuscita', 'errore',
];

describe('i18n — namespace mensa (it/en)', () => {
  it('it ed en espongono lo stesso set di chiavi', () => {
    expect(Object.keys(IT).sort()).toEqual(Object.keys(EN).sort());
  });

  it('espone tutte le chiavi usate dai componenti mensa', () => {
    for (const k of CHIAVI_RICHIESTE) {
      expect(IT, `it/mensa.json manca "${k}"`).toHaveProperty(k);
      expect(EN, `en/mensa.json manca "${k}"`).toHaveProperty(k);
    }
  });

  it('le traduzioni inglesi non sono un copia-incolla di quelle italiane', () => {
    // Un campione di chiavi la cui resa cambia davvero tra le due lingue.
    for (const k of ['titolo', 'prenotaPranzo', 'disdici', 'nessunGiorno']) {
      expect(EN[k]).not.toEqual(IT[k]);
    }
  });
});

// --- Render-test: le stringhe arrivano dal namespace, non da letterali ---------
// Il mock globale di next-intl (test/setup.ts) risolve le chiavi contro
// messages/it/mensa.json. Se il componente usa t('nessunGiorno') ma la chiave
// manca, il mock ritorna "mensa.nessunGiorno" e questi test falliscono: sono la
// prova che il cablaggio i18n del percorso "giorno vuoto" è corretto.
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
});

function menuVuoto() {
  // Senza `ok:true` fetchConCache degrada a cache vuota → menu vuoto (nessun accesso a Dexie).
  return { json: async () => ({ success: true, data: [] }) };
}
function prenOk() {
  return { status: 200, json: async () => ({ success: true, data: { saldo: 5, prenotazioni: [], cutoffOra: null } }) };
}

describe('MensaCalendar — stringhe dal namespace mensa', () => {
  it('stato "settimana vuota" e unità saldo arrivano dal namespace', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/mensa/menu')) return Promise.resolve(menuVuoto());
      if (url.includes('/api/mensa/prenotazioni')) return Promise.resolve(prenOk());
      return Promise.resolve(menuVuoto());
    });

    render(<MensaCalendar userId="P1" studentId="S1" />);

    expect(await screen.findByText(/Nessun giorno mensa in questa settimana/i)).toBeInTheDocument();
    // L'unità del saldo ("ticket") e il valore (5) sono renderizzati.
    expect(screen.getByText('ticket')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});
