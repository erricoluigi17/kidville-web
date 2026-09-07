// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  inferisciAllergeniDaTesto as inferLib,
  isNegazione as isNegazioneLib,
  ALLERGENI,
} from '@/lib/mensa/allergeni';
import {
  inferisciAllergeniDaTesto as inferScript,
  pianificaRiga,
  isNegazione,
} from '../../scripts/backfill_allergeni.mjs';

describe('backfill allergeni — parità inferenza con la lib runtime', () => {
  // Battery: ogni sinonimo di ogni allergene + valori reali + combinazioni.
  const battery: string[] = [
    ...ALLERGENI.flatMap((a) => a.sinonimi),
    'Glutine',
    'Lattosio',
    'Nessuna allergia nota',
    'lattosio, fragole',
    'noci e mandorle',
    'uova; pesce',
    'burro di arachidi e latte',
    'kiwi',
    '',
  ];

  it('lo script inferisce esattamente come src/lib/mensa/allergeni.ts', () => {
    for (const testo of battery) {
      expect(inferScript(testo).sort()).toEqual(inferLib(testo).sort());
    }
  });
});

describe('backfill allergeni — pianificazione riga', () => {
  it('mappa un allergene noto senza nota storica', () => {
    const p = pianificaRiga({ allergies: 'Glutine', note_mediche: null });
    expect(p.skip).toBe(false);
    expect(p.allergeni).toEqual(['glutine']);
    expect(p.nota).toBeNull();
    expect(p.cambia).toBe(true);
  });

  it('struttura il mappabile e appende il residuo non mappato', () => {
    const p = pianificaRiga({ allergies: 'lattosio, fragole', note_mediche: null });
    expect(p.allergeni).toEqual(['latte']);
    expect(p.nota).toContain('Allergie (testo storico)');
    expect(p.nota).toContain('fragole');
    expect(p.nota).not.toContain('lattosio'); // lattosio è stato strutturato
  });

  it('preserva le note esistenti quando appende il residuo', () => {
    const p = pianificaRiga({ allergies: 'kiwi', note_mediche: 'Terapia X' });
    expect(p.allergeni).toEqual([]);
    expect(p.nota).toBe('Terapia X\nAllergie (testo storico): kiwi');
    expect(p.cambia).toBe(true);
  });

  it('è idempotente: non ri-appende se la nota storica è già presente', () => {
    const p = pianificaRiga({ allergies: 'kiwi', note_mediche: 'Allergie (testo storico): kiwi' });
    expect(p.nota).toBeNull();
    expect(p.cambia).toBe(false);
  });

  it('salta le negazioni ("Nessuna allergia nota")', () => {
    expect(pianificaRiga({ allergies: 'Nessuna allergia nota', note_mediche: null }).skip).toBe(true);
    expect(isNegazione('Nessuna allergia nota')).toBe(true);
    expect(isNegazione('lattosio')).toBe(false);
  });
});

// =============================================================================
// LA NEGAZIONE — stessa regola nello script e a runtime, e non è più a sottostringa.
//
// Lo script cercava `/\bnessun/` DOVUNQUE nella stringa. In produzione c'è un testo
// che parla di un fastidio al lattosio e di cibi che il bambino non mangia, con
// «di nessun tipo» in mezzo: quel criterio lo dichiarava NEGAZIONE e lo saltava —
// cioè saltava proprio un bambino con restrizioni vere. Col criterio a sottostringa
// il contatore delle allergie valeva 26, con quello a vocabolario intero 27, che è
// il numero approvato.
//
// Lo script non è mai stato applicato (0 allergeni strutturati su 646 iscritti):
// nessun dato esistente è stato toccato dal difetto. Resta la regola, che vive in
// due file e deve dire la stessa cosa in tutti e due.
// =============================================================================
describe('backfill allergeni — parità NEGAZIONE con la lib runtime', () => {
  const battery: (string | null | undefined)[] = [
    'Nessuna allergia nota',
    'nessuna',
    'NESSUNA',
    'Nessun allergene segnalata',
    'nessuna intolleranza rilevata',
    'niente',
    'nulla',
    'no',
    'none',
    'N/A',
    'n/a',
    'na',
    'assenti',
    'assente',
    '-',
    '/',
    '//',
    '',
    '   ',
    null,
    undefined,
    'lattosio',
    'fragole',
    'kiwi',
    'nessuna allergia al latte',
    'non mangia crudi di nessun tipo, fastidio al lattosio',
    'Glutine',
    'noci e mandorle',
    // Frasi AFFERMATIVE fatte di sole parole del vocabolario: senza un negatore
    // vero non sono negazioni, e le due copie della regola devono dirlo insieme.
    'allergia presente',
    'allergie presenti',
    'intolleranza rilevata',
    'allergene segnalato',
    'patologie presenti',
  ];

  it('lo script nega esattamente come src/lib/mensa/allergeni.ts', () => {
    for (const testo of battery) {
      expect(isNegazione(testo), `«${testo}»`).toBe(isNegazioneLib(testo));
    }
  });

  it('IL CASO REALE non viene più saltato: la frase con «nessun» in mezzo resta', () => {
    const reale = 'non mangia crudi di nessun tipo, fastidio al lattosio';
    expect(isNegazione(reale)).toBe(false);
    const p = pianificaRiga({ allergies: reale, note_mediche: null });
    expect(p.skip).toBe(false);
    expect(p.allergeni).toEqual(['latte']);
  });

  it('le negazioni scritte per esteso restano saltate', () => {
    for (const testo of ['Nessuna allergia nota', 'N/A', 'nessuna patologia nota', '-']) {
      expect(pianificaRiga({ allergies: testo, note_mediche: null }).skip, testo).toBe(true);
    }
  });

  it('una frase AFFERMATIVA non viene saltata: «allergia presente» è un\'allergia', () => {
    // Senza il negatore obbligatorio lo script saltava la riga, cioè non
    // backfillava un bambino che dichiara di avere un'allergia.
    const p = pianificaRiga({ allergies: 'allergia presente', note_mediche: null });
    expect(p.skip).toBe(false);
  });
});
