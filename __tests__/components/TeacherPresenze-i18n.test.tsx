import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Il mock globale di next-intl (test/setup.ts) risolve le chiavi contro
// messages/it/teacherPresenze.json. Se un componente usa t('x') ma la chiave
// manca, il mock ritorna "teacherPresenze.x" e i render-test qui sotto vanno
// rossi: sono la prova che il cablaggio i18n del registro presenze è corretto.
vi.mock('@/lib/offline/db', () => ({}));

import { SemaforoAutorizzazione } from '@/components/features/teacher/SemaforoAutorizzazione';
import { CheckoutModal } from '@/components/features/teacher/CheckoutModal';
import { StudentAttendanceRow } from '@/components/features/teacher/StudentAttendanceRow';
import itNs from '../../messages/it/teacherPresenze.json';
import enNs from '../../messages/en/teacherPresenze.json';

const IT = itNs as Record<string, unknown>;
const EN = enNs as Record<string, unknown>;

// Ogni stringa utente estratta dai sorgenti del registro presenze deve avere la
// sua chiave nel namespace, in ITALIANO (sorgente) e in INGLESE. La lista è il
// contratto della migrazione.
const CHIAVI_RICHIESTE = [
  // stati (bottoni / legenda / badge)
  'presente', 'assente', 'ritardo', 'uscita', 'uscitaAnt',
  // riepilogo + chip filtro
  'tutti', 'presenti', 'assenti', 'daRegistrare', 'registrati', 'completo',
  'mancanti', 'sezioneCon',
  // navigatore data + tab
  'giornoPrecedente', 'giornoSuccessivo', 'oggi', 'mese',
  // stati vista Oggi
  'caricamentoAlunni', 'riprova', 'erroreCaricamentoAlunni', 'nessunAlunnoPre',
  'nessunAlunnoAiuto', 'nessunAlunnoFiltro', 'offline', 'aggiornaPresenze',
  'allarmeInviato', 'erroreInvioAllarme', 'erroreReteAllarme',
  // intestazione pagina
  'eyebrowRegistro', 'appello', 'sezioneSelettore', 'nessunaSezioneProfilo',
  // tabella mensile + export PDF
  'esportaPdf', 'generazione', 'erroreCaricamento', 'erroreCaricamentoStudenti',
  'studente', 'oggiConteggio', 'presenze', 'assenze', 'ritardi', 'entrata',
  'abbrevP', 'abbrevA', 'abbrevR', 'abbrevU', 'abbrevOre',
  'pdfTitolo', 'pdfMeta', 'pdfPiePagina', 'pdfPrefissoFile',
  // checkout delegato
  'delegatiAutorizzati', 'nessunDelegato', 'conferma',
  'invioAllarme', 'panicAlert', 'panicDescrizione',
  // riga studente
  'ingresso',
  // semaforo autorizzazione
  'prontoUscita', 'nonPronto', 'autorizzazioneFirmata', 'firmata', 'nonFirmata',
  'quotaSaldata', 'saldata', 'daSaldare',
];

describe('i18n — namespace teacherPresenze (it/en)', () => {
  it('it ed en espongono lo stesso set di chiavi', () => {
    expect(Object.keys(IT).sort()).toEqual(Object.keys(EN).sort());
  });

  it('espone tutte le chiavi usate dai componenti presenze', () => {
    for (const k of CHIAVI_RICHIESTE) {
      expect(IT, `it/teacherPresenze.json manca "${k}"`).toHaveProperty(k);
      expect(EN, `en/teacherPresenze.json manca "${k}"`).toHaveProperty(k);
    }
  });

  it('le traduzioni inglesi non sono un copia-incolla di quelle italiane', () => {
    for (const k of ['appello', 'esportaPdf', 'conferma', 'firmata', 'oggi', 'riprova']) {
      expect(EN[k]).not.toEqual(IT[k]);
    }
  });
});

// --- Render-test: le stringhe arrivano dal namespace, non da letterali --------
describe('Componenti presenze — stringhe dal namespace teacherPresenze', () => {
  it('SemaforoAutorizzazione mostra gli stati firma/quota dal namespace', () => {
    render(<SemaforoAutorizzazione autorizzato quotaOk={false} />);
    expect(screen.getByText('Firmata')).toBeInTheDocument();
    expect(screen.getByText('Da saldare')).toBeInTheDocument();
  });

  it('CheckoutModal mostra delegati e panic alert dal namespace', () => {
    render(
      <CheckoutModal
        studentName="Mario Rossi"
        delegates={[]}
        onClose={() => {}}
        onConfirmCheckout={() => {}}
        onPanicAlert={() => {}}
      />,
    );
    expect(screen.getByText('Delegati Autorizzati')).toBeInTheDocument();
    expect(screen.getByText('Nessun delegato registrato.')).toBeInTheDocument();
    expect(screen.getByText(/Ritiro Non Autorizzato/)).toBeInTheDocument();
  });

  it('StudentAttendanceRow mostra i 3 stati appello dal namespace', () => {
    render(
      <StudentAttendanceRow
        student={{ id: 'S1', firstName: 'Mario', lastName: 'Rossi' }}
        onSetStato={() => {}}
        onCheckoutClick={() => {}}
      />,
    );
    expect(screen.getByText('Presente')).toBeInTheDocument();
    expect(screen.getByText('Ritardo')).toBeInTheDocument();
    expect(screen.getByText('Assente')).toBeInTheDocument();
  });
});
