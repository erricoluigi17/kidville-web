// =============================================================================
// PRIMARIA — Calcolo del monte ore di assenza
// =============================================================================
// Somma le ore perse sommando: assenze intere (durata della giornata), ritardi
// (entrata − inizio) e uscite anticipate/permessi (fine − uscita).
// Funzione pura e testabile: durata giornata e orari in ingresso, ore in uscita.
// =============================================================================

export type StatoPresenza = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';

export interface PresenzaInput {
  stato: StatoPresenza;
  orario_entrata?: string | null; // timestamp ISO (per i ritardi)
  orario_uscita?: string | null;  // timestamp ISO (per le uscite anticipate)
}

export interface GiornataScolastica {
  inizio: string; // 'HH:MM'
  fine: string;   // 'HH:MM'
}

export interface RiepilogoOre {
  oreAssenza: number;   // da assenze intere
  oreRitardo: number;   // da ritardi
  orePermesso: number;  // da uscite anticipate
  oreTotali: number;
}

// Giornata di default (modello 27h/5gg ≈ 5h/giorno).
export const GIORNATA_DEFAULT: GiornataScolastica = { inizio: '08:30', fine: '13:30' };

// Minuti da mezzanotte per una stringa 'HH:MM' (o 'HH:MM:SS').
function minutiDaOrario(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

// Minuti da mezzanotte (ora locale) per un timestamp ISO.
function minutiDaTimestamp(ts: string): number | null {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Calcola il riepilogo delle ore di assenza per un insieme di presenze, data la
// durata della giornata scolastica.
export function calcolaOreAssenza(
  presenze: PresenzaInput[],
  giornata: GiornataScolastica = GIORNATA_DEFAULT,
): RiepilogoOre {
  const inizio = minutiDaOrario(giornata.inizio);
  const fine = minutiDaOrario(giornata.fine);
  const durataGiorno = Math.max(0, fine - inizio);

  let minAssenza = 0;
  let minRitardo = 0;
  let minPermesso = 0;

  for (const p of presenze) {
    if (p.stato === 'assente') {
      minAssenza += durataGiorno;
    } else if (p.stato === 'ritardo' && p.orario_entrata) {
      const entrata = minutiDaTimestamp(p.orario_entrata);
      if (entrata != null) minRitardo += clamp(entrata - inizio, 0, durataGiorno);
    } else if (p.stato === 'uscita_anticipata' && p.orario_uscita) {
      const uscita = minutiDaTimestamp(p.orario_uscita);
      if (uscita != null) minPermesso += clamp(fine - uscita, 0, durataGiorno);
    }
  }

  const oreAssenza = round2(minAssenza / 60);
  const oreRitardo = round2(minRitardo / 60);
  const orePermesso = round2(minPermesso / 60);
  return {
    oreAssenza,
    oreRitardo,
    orePermesso,
    oreTotali: round2(oreAssenza + oreRitardo + orePermesso),
  };
}

// Deduce la giornata scolastica da una lista di campanelle di tipo 'lezione'
// (ora_inizio/ora_fine in formato 'HH:MM:SS'). Fallback alla giornata di default.
export function giornataDaCampanelle(
  campanelle: { ora_inizio: string; ora_fine: string; tipo?: string }[],
): GiornataScolastica {
  const lezioni = campanelle.filter((c) => !c.tipo || c.tipo === 'lezione');
  if (lezioni.length === 0) return GIORNATA_DEFAULT;
  const inizio = lezioni.reduce((min, c) => (minutiDaOrario(c.ora_inizio) < minutiDaOrario(min) ? c.ora_inizio : min), lezioni[0].ora_inizio);
  const fine = lezioni.reduce((max, c) => (minutiDaOrario(c.ora_fine) > minutiDaOrario(max) ? c.ora_fine : max), lezioni[0].ora_fine);
  return { inizio: inizio.slice(0, 5), fine: fine.slice(0, 5) };
}
