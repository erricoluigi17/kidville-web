import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { formatMessageDate } from '@/components/features/chat/ChatMessageArea';

// I separatori di giorno della chat mostravano «Oggi»/«Ieri» come stringhe fisse.
// Ora le etichette arrivano da `common.oggi`/`common.ieri` (parità it/en) e vengono
// INIETTATE nella funzione di formato, così in inglese diventano «Today»/«Yesterday».
// Il resto della data (giorno + mese) resta localizzato tramite il `locale`.
describe('formatMessageDate — separatori Oggi/Ieri localizzati', () => {
  const labels = { oggi: 'OGGI_X', ieri: 'IERI_Y' };

  // L'orologio finto non deve sopravvivere al caso che lo accende.
  afterEach(() => { vi.useRealTimers(); });

  // «Oggi» e «ieri» si misurano contro un `adesso` FISSO, passato come quarto argomento.
  // Fino al 24/09 questi due casi usavano l'orologio vero e «ieri = adesso − 24 ore»: era
  // proprio il difetto (D11), e il caso lo riproduceva invece di smentirlo.
  it('usa la label "oggi" iniettata per la data odierna', () => {
    const adesso = new Date('2026-09-24T08:00:00Z');
    expect(formatMessageDate('2026-09-24T07:00:00Z', 'it', labels, adesso)).toBe('OGGI_X');
  });

  it('usa la label "ieri" iniettata per la data di ieri', () => {
    const adesso = new Date('2026-09-24T08:00:00Z');
    expect(formatMessageDate('2026-09-23T07:00:00Z', 'it', labels, adesso)).toBe('IERI_Y');
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

/** Copiata da `__tests__/lib/i18n-quando-relativo.test.ts`: `process.env.TZ = undefined` scriverebbe «undefined». */
function ripristinaTZ(tz: string | undefined) {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
}

/** Gli stessi quattro fusi di `i18n-quando-relativo.test.ts`, con l'offset di settembre atteso. */
const FUSI: Array<[string, number]> = [
  ['Europe/Rome', -120],
  ['UTC', 0],
  ['Pacific/Kiritimati', -840],
  ['America/Los_Angeles', 420],
];

// D11 (consegna 2b): «Oggi»/«Ieri» si decidono sulle DATE CIVILI di Roma, come la chiave del
// gruppo (`groupByDate`) e la data estesa, qualunque sia il fuso del dispositivo. Col vecchio
// `toDateString()` ogni fuso di prova aveva almeno un caso sbagliato, Roma compresa (il 29/03
// dura 23 ore, e «ieri = adesso − 24 ore» cade due giorni prima).
describe.each(FUSI)('formatMessageDate con il processo nel fuso %s', (fuso, offsetAtteso) => {
  const labels = { oggi: 'OGGI_X', ieri: 'IERI_Y' };
  const tzOriginale = process.env.TZ;

  beforeAll(() => { process.env.TZ = fuso; });
  afterAll(() => { ripristinaTZ(tzOriginale); });

  it(`il fuso di prova è davvero applicato (offset di settembre ${offsetAtteso})`, () => {
    // getTimezoneOffset() è MINUTI DIETRO UTC: Roma d'estate (+2) è -120.
    expect(new Date('2026-09-14T12:00:00').getTimezoneOffset()).toBe(offsetAtteso);
  });

  it('a · 00:30 di Roma del 24/09, letto alle 10:00 dello stesso giorno → oggi', () => {
    expect(formatMessageDate('2026-09-23T22:30:00Z', 'it', labels, new Date('2026-09-24T08:00:00Z'))).toBe('OGGI_X');
  });

  it('b · 00:30 di Roma del 23/09, stesso adesso → ieri', () => {
    expect(formatMessageDate('2026-09-22T22:30:00Z', 'it', labels, new Date('2026-09-24T08:00:00Z'))).toBe('IERI_Y');
  });

  it('c · il 29/03 dura 23 ore: le 12:00 del 29 lette alle 00:30 del 30 → ieri', () => {
    expect(formatMessageDate('2026-03-29T10:00:00Z', 'it', labels, new Date('2026-03-29T22:30:00Z'))).toBe('IERI_Y');
  });

  it('d · il 28/03, stesso adesso, è due giorni prima → data estesa', () => {
    expect(formatMessageDate('2026-03-28T10:00:00Z', 'it', labels, new Date('2026-03-29T22:30:00Z'))).toBe('28 marzo');
  });

  it('e · il 25/10 dura 25 ore: le 11:00 del 25 lette alle 00:30 del 26 → ieri', () => {
    expect(formatMessageDate('2026-10-25T10:00:00Z', 'it', labels, new Date('2026-10-25T23:30:00Z'))).toBe('IERI_Y');
  });

  it('f · istante illeggibile → stringa vuota, mai un’eccezione', () => {
    expect(formatMessageDate('non-una-data', 'it', labels, new Date('2026-09-24T08:00:00Z'))).toBe('');
  });
});
