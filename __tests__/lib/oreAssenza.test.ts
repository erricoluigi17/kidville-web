import { describe, it, expect } from 'vitest';
import {
  calcolaOreAssenza,
  calcolaOreAssenzaPerMateria,
  eStatoNonInClasse,
  giornataDaCampanelle,
  GIORNATA_DEFAULT,
  type CampanellaSlot,
  type MateriaInfo,
  type SlotOrario,
} from '@/lib/primaria/oreAssenza';

/**
 * Un orario del 2026-06-08 **ancorato a Roma**, non al fuso del runner.
 *
 * ⚠️ QUESTO HELPER FACEVA `new Date(2026, 5, 8, h, m).toISOString()`, cioè
 * costruiva l'ora LOCALE DEL PROCESSO. E `minutiDaTimestamp`, dentro
 * `oreAssenza.ts`, la rileggeva con `getHours()` — di nuovo l'ora locale del
 * processo. **Il test usava l'assunzione sbagliata su tutti e due i lati**, quindi
 * passava in qualunque fuso: non poteva distinguere il codice corretto da quello
 * sbagliato, che è l'unica cosa che un test deve saper fare.
 *
 * La prova che era così: appena la lettura è passata a `@/lib/presenze/orario`
 * (che legge a `Europe/Rome`, come fa lo schermo), questo file è diventato ROSSO
 * con `TZ=UTC` e verde con `TZ=Europe/Rome` — 4 casi su 8. L'`+02:00` esplicito lo
 * riporta a dire la stessa cosa nei due fusi.
 *
 * Giugno è CEST, quindi `+02:00`. Gli attesi qui sotto non cambiano di un decimale:
 * non si è indebolito il test, gli si è tolta l'ambiguità.
 */
function ts(hhmm: string): string {
  return `2026-06-08T${hhmm}:00+02:00`;
}

describe('calcolaOreAssenza', () => {
  it('conta la giornata intera per le assenze (default 08:30-13:30 = 5h)', () => {
    const r = calcolaOreAssenza([{ stato: 'assente' }]);
    expect(r.oreAssenza).toBe(5);
    expect(r.oreTotali).toBe(5);
  });

  it('conta le ore di ritardo come entrata − inizio', () => {
    const r = calcolaOreAssenza([{ stato: 'ritardo', orario_entrata: ts('09:30') }]);
    expect(r.oreRitardo).toBe(1); // 09:30 − 08:30
    expect(r.oreTotali).toBe(1);
  });

  it('conta le ore di permesso come fine − uscita', () => {
    const r = calcolaOreAssenza([{ stato: 'uscita_anticipata', orario_uscita: ts('12:30') }]);
    expect(r.orePermesso).toBe(1); // 13:30 − 12:30
    expect(r.oreTotali).toBe(1);
  });

  it('non conta nulla per i presenti e somma le categorie', () => {
    const r = calcolaOreAssenza([
      { stato: 'presente' },
      { stato: 'assente' },
      { stato: 'ritardo', orario_entrata: ts('09:00') }, // 0.5h
      { stato: 'uscita_anticipata', orario_uscita: ts('13:00') }, // 0.5h
    ]);
    expect(r.oreAssenza).toBe(5);
    expect(r.oreRitardo).toBe(0.5);
    expect(r.orePermesso).toBe(0.5);
    expect(r.oreTotali).toBe(6);
  });

  it('clampa i valori fuori giornata a [0, durata]', () => {
    // Entrata prima dell'inizio → 0; uscita prima dell'inizio → durata intera.
    const r = calcolaOreAssenza([
      { stato: 'ritardo', orario_entrata: ts('08:00') },
      { stato: 'uscita_anticipata', orario_uscita: ts('08:00') },
    ]);
    expect(r.oreRitardo).toBe(0);
    expect(r.orePermesso).toBe(5);
  });

  it('rispetta una giornata personalizzata', () => {
    const r = calcolaOreAssenza([{ stato: 'assente' }], { inizio: '08:00', fine: '16:00' });
    expect(r.oreAssenza).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 (26/09) — ritardo / uscita anticipata GIUSTIFICATI (es. terapia).
//
// Decisione del titolare: le ore giustificate NON contano nel monte ore, ma lo
// stato resta `ritardo` / `uscita_anticipata` (l'alunno risulta comunque non
// presente in classe). Ogni caso qui sotto mette la riga giustificata ACCANTO a
// una gemella non giustificata: se l'esclusione sparisse, il totale
// raddoppierebbe; se l'esclusione diventasse «tutto il giorno», la gemella
// sparirebbe anche lei. Le due direzioni di rottura sono entrambe rosse.
// ─────────────────────────────────────────────────────────────────────────────
describe('calcolaOreAssenza — ore giustificate (A2)', () => {
  it('ritardo giustificato → 0 ore', () => {
    const r = calcolaOreAssenza([
      { stato: 'ritardo', orario_entrata: ts('10:30'), assenza_oraria_giustificata: true },
    ]);
    expect(r.oreRitardo).toBe(0);
    expect(r.oreTotali).toBe(0);
  });

  it('ritardo NON giustificato → ore come oggi (flag false e flag assente)', () => {
    const r = calcolaOreAssenza([
      { stato: 'ritardo', orario_entrata: ts('09:30'), assenza_oraria_giustificata: false },
      { stato: 'ritardo', orario_entrata: ts('09:30') }, // colonna assente = false
    ]);
    expect(r.oreRitardo).toBe(2); // 2 × (09:30 − 08:30)
    expect(r.oreTotali).toBe(2);
  });

  it('uscita anticipata giustificata → 0 ore', () => {
    const r = calcolaOreAssenza([
      { stato: 'uscita_anticipata', orario_uscita: ts('11:30'), assenza_oraria_giustificata: true },
    ]);
    expect(r.orePermesso).toBe(0);
    expect(r.oreTotali).toBe(0);
  });

  it('esclude SOLO la riga giustificata: la gemella non giustificata conta ancora', () => {
    const r = calcolaOreAssenza([
      { stato: 'ritardo', orario_entrata: ts('10:30'), assenza_oraria_giustificata: true },
      { stato: 'ritardo', orario_entrata: ts('09:30'), assenza_oraria_giustificata: false },
      { stato: 'uscita_anticipata', orario_uscita: ts('11:30'), assenza_oraria_giustificata: true },
      { stato: 'uscita_anticipata', orario_uscita: ts('12:30') },
      { stato: 'assente' },
    ]);
    expect(r.oreRitardo).toBe(1);
    expect(r.orePermesso).toBe(1);
    expect(r.oreAssenza).toBe(5);
    expect(r.oreTotali).toBe(7);
  });

  it('un flag incoerente su un\'assenza INTERA non la azzera (il DB lo spegne; qui si conta)', () => {
    const r = calcolaOreAssenza([{ stato: 'assente', assenza_oraria_giustificata: true }]);
    expect(r.oreAssenza).toBe(5);
    expect(r.oreTotali).toBe(5);
  });
});

describe('calcolaOreAssenzaPerMateria — ore giustificate (A2)', () => {
  // Lunedì 2026-06-08: tre ore di lezione, una materia per ora.
  const campanelle: CampanellaSlot[] = [
    { id: 'c1', giorno_settimana: 1, ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
    { id: 'c2', giorno_settimana: 1, ordine: 2, ora_inizio: '09:30:00', ora_fine: '10:30:00', tipo: 'lezione' },
    { id: 'c3', giorno_settimana: 1, ordine: 3, ora_inizio: '10:30:00', ora_fine: '11:30:00', tipo: 'lezione' },
  ];
  const orario: SlotOrario[] = [
    { campanella_id: 'c1', giorno_settimana: 1, materia_id: 'ita' },
    { campanella_id: 'c2', giorno_settimana: 1, materia_id: 'mat' },
    { campanella_id: 'c3', giorno_settimana: 1, materia_id: 'sto' },
  ];
  const materie: MateriaInfo[] = [
    { id: 'ita', nome: 'Italiano' },
    { id: 'mat', nome: 'Matematica' },
    { id: 'sto', nome: 'Storia' },
  ];
  const DATA = '2026-06-08';

  it('ritardo NON giustificato → minuti per materia come oggi', () => {
    const r = calcolaOreAssenzaPerMateria(
      [{ data: DATA, stato: 'ritardo', orario_entrata: ts('10:00') }],
      campanelle, orario, materie,
    );
    expect(r.perMateria.ita.minutiMancati).toBe(60);
    expect(r.perMateria.mat.minutiMancati).toBe(30);
    expect(r.totaleMinuti).toBe(90);
  });

  it('ritardo giustificato → nessuna materia perde minuti', () => {
    const r = calcolaOreAssenzaPerMateria(
      [{ data: DATA, stato: 'ritardo', orario_entrata: ts('10:00'), assenza_oraria_giustificata: true }],
      campanelle, orario, materie,
    );
    expect(r.perMateria).toEqual({});
    expect(r.totaleMinuti).toBe(0);
  });

  it('uscita anticipata giustificata → 0; la gemella non giustificata conta', () => {
    const r = calcolaOreAssenzaPerMateria(
      [
        { data: DATA, stato: 'uscita_anticipata', orario_uscita: ts('09:00'), assenza_oraria_giustificata: true },
        { data: DATA, stato: 'uscita_anticipata', orario_uscita: ts('11:00') },
      ],
      campanelle, orario, materie,
    );
    // Solo la seconda: 11:00 → 11:30 di Storia.
    expect(r.perMateria).toEqual({ sto: { nome: 'Storia', minutiMancati: 30, oreMancate: 0.5 } });
    expect(r.totaleMinuti).toBe(30);
  });
});

describe('giornataDaCampanelle', () => {
  it('deduce inizio/fine da min/max delle lezioni', () => {
    const g = giornataDaCampanelle([
      { ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
      { ora_inizio: '09:30:00', ora_fine: '10:30:00', tipo: 'lezione' },
      { ora_inizio: '12:00:00', ora_fine: '13:00:00', tipo: 'mensa' },
    ]);
    expect(g).toEqual({ inizio: '08:30', fine: '10:30' });
  });

  it('usa il default senza campanelle', () => {
    expect(giornataDaCampanelle([])).toEqual(GIORNATA_DEFAULT);
  });
});

describe('eStatoNonInClasse — gli stati di cui il genitore vede la nota', () => {
  it('assente, ritardo, uscita_anticipata sì; presente, null e valori ignoti no', () => {
    expect(eStatoNonInClasse('assente')).toBe(true);
    expect(eStatoNonInClasse('ritardo')).toBe(true);
    expect(eStatoNonInClasse('uscita_anticipata')).toBe(true);
    expect(eStatoNonInClasse('presente')).toBe(false);
    expect(eStatoNonInClasse(null)).toBe(false);
    expect(eStatoNonInClasse(undefined)).toBe(false);
    expect(eStatoNonInClasse('')).toBe(false);
    expect(eStatoNonInClasse('qualcosa')).toBe(false);
  });
});
