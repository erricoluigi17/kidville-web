import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatMessageDate } from '@/components/features/chat/ChatMessageArea';

// I separatori di giorno della chat mostravano «Oggi»/«Ieri» come stringhe fisse.
// Ora le etichette arrivano da `common.oggi`/`common.ieri` (parità it/en) e vengono
// INIETTATE nella funzione di formato, così in inglese diventano «Today»/«Yesterday».
// Il resto della data (giorno + mese) resta localizzato tramite il `locale`.
describe('formatMessageDate — separatori Oggi/Ieri localizzati', () => {
  const labels = { oggi: 'OGGI_X', ieri: 'IERI_Y' };

  // L'orologio finto non deve sopravvivere al caso che lo accende: gli altri due
  // casi di questo file misurano «oggi» e «ieri» contro l'ora VERA, ed è giusto così.
  afterEach(() => { vi.useRealTimers(); });

  it('usa la label "oggi" iniettata per la data odierna', () => {
    const oggi = new Date();
    expect(formatMessageDate(oggi.toISOString(), 'it', labels)).toBe('OGGI_X');
  });

  it('usa la label "ieri" iniettata per la data di ieri', () => {
    const ieri = new Date(Date.now() - 86_400_000);
    expect(formatMessageDate(ieri.toISOString(), 'it', labels)).toBe('IERI_Y');
  });

  it('per una data più vecchia localizza giorno + mese (non usa le label)', () => {
    // Istante ASSOLUTO, non mezzanotte locale: dal 2026-08-01 la formattazione è
    // ancorata a Europe/Rome (il fuso della scuola), quindi una data costruita
    // con componenti locali renderebbe un giorno diverso a seconda della
    // macchina che esegue i test — che è il difetto per cui il fuso è stato
    // dichiarato. Mezzogiorno UTC = 13:00/14:00 a Roma, lo stesso 5 novembre.
    //
    // ⚠️ E L'OROLOGIO VA CONGELATO, perché «più vecchia» è una parola relativa.
    // `formatMessageDate` decide fra la data estesa e le etichette Oggi/Ieri
    // confrontando con `new Date()`: senza questa riga, il 5 novembre 2026 questo
    // test si aspetterebbe «5 novembre» e riceverebbe «OGGI_X», e il 6 «IERI_Y».
    // Due giorni di rosso senza che nessuno abbia cambiato una riga di codice —
    // ed è già successo in questo repo l'11 agosto 2026, sul banco dell'agenda.
    // L'orologio si porta DOPO la data di prova, altrimenti «più vecchia» sarebbe
    // falso e il test proverebbe un'altra cosa da quella che il suo nome dichiara.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-03-01T12:00:00Z'));
    const vecchia = new Date('2026-11-05T12:00:00Z');
    expect(formatMessageDate(vecchia.toISOString(), 'it', labels)).toBe('5 novembre');
    expect(formatMessageDate(vecchia.toISOString(), 'en', labels)).toContain('November');
  });
});
