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

// =============================================================================
// Calcolo ore di assenza PER MATERIA
// =============================================================================

export interface CampanellaSlot {
  id: string;
  giorno_settimana: number; // 1=lun, 5=ven
  ordine: number;
  ora_inizio: string; // 'HH:MM:SS'
  ora_fine: string;
  tipo: string;
}

export interface SlotOrario {
  campanella_id: string;
  giorno_settimana: number;
  materia_id: string | null;
}

export interface MateriaInfo {
  id: string;
  nome: string;
}

export interface PresenzaConData extends PresenzaInput {
  data: string; // 'YYYY-MM-DD'
}

export interface RiepilogoPerMateria {
  perMateria: Record<string, { nome: string; minutiMancati: number; oreMancate: number }>;
  totaleMinuti: number;
}

// Restituisce il giorno della settimana (1=lunedì…6=sabato) da una data 'YYYY-MM-DD'.
function giornoSettimana(data: string): number {
  const d = new Date(data + 'T12:00:00');
  const js = d.getDay(); // 0=dom
  return js === 0 ? 7 : js;
}

// Calcola i minuti mancati per ogni materia in base alle presenze e all'orario.
export function calcolaOreAssenzaPerMateria(
  presenze: PresenzaConData[],
  campanelle: CampanellaSlot[],
  orario: SlotOrario[],
  materie: MateriaInfo[],
): RiepilogoPerMateria {
  const materieMap = new Map(materie.map((m) => [m.id, m.nome]));
  const campanelleMap = new Map(campanelle.map((c) => [c.id, c]));

  // orario indicizzato per (giorno, campanella_id) → materia_id
  const orarioIdx = new Map<string, string | null>();
  for (const slot of orario) {
    orarioIdx.set(`${slot.giorno_settimana}:${slot.campanella_id}`, slot.materia_id);
  }

  const risultato: Record<string, { nome: string; minutiMancati: number; oreMancate: number }> = {};

  const aggiungi = (materiaId: string, minuti: number) => {
    const nome = materieMap.get(materiaId) ?? materiaId;
    if (!risultato[materiaId]) risultato[materiaId] = { nome, minutiMancati: 0, oreMancate: 0 };
    risultato[materiaId].minutiMancati += minuti;
    risultato[materiaId].oreMancate = round2(risultato[materiaId].minutiMancati / 60);
  };

  for (const p of presenze) {
    const giorno = giornoSettimana(p.data);
    // Campanelle di tipo 'lezione' per quel giorno
    const slotsDelGiorno = campanelle.filter(
      (c) => c.giorno_settimana === giorno && c.tipo === 'lezione',
    );

    if (p.stato === 'assente') {
      // Tutti gli slot del giorno contano
      for (const slot of slotsDelGiorno) {
        const mId = orarioIdx.get(`${giorno}:${slot.id}`);
        if (!mId) continue;
        const durata = minutiDaOrario(slot.ora_fine) - minutiDaOrario(slot.ora_inizio);
        aggiungi(mId, Math.max(0, durata));
      }
    } else if (p.stato === 'ritardo' && p.orario_entrata) {
      const entrata = minutiDaTimestamp(p.orario_entrata);
      if (entrata == null) continue;
      for (const slot of slotsDelGiorno) {
        const slotFine = minutiDaOrario(slot.ora_fine);
        if (slotFine <= entrata) {
          // Slot completamente perso
          const mId = orarioIdx.get(`${giorno}:${slot.id}`);
          if (!mId) continue;
          const durata = minutiDaOrario(slot.ora_fine) - minutiDaOrario(slot.ora_inizio);
          aggiungi(mId, Math.max(0, durata));
        } else {
          const slotInizio = minutiDaOrario(slot.ora_inizio);
          if (slotInizio < entrata) {
            // Slot parzialmente perso (solo la parte prima dell'entrata)
            const mId = orarioIdx.get(`${giorno}:${slot.id}`);
            if (!mId) continue;
            aggiungi(mId, entrata - slotInizio);
          }
        }
      }
    } else if (p.stato === 'uscita_anticipata' && p.orario_uscita) {
      const uscita = minutiDaTimestamp(p.orario_uscita);
      if (uscita == null) continue;
      for (const slot of slotsDelGiorno) {
        const slotInizio = minutiDaOrario(slot.ora_inizio);
        if (slotInizio >= uscita) {
          // Slot completamente perso
          const mId = orarioIdx.get(`${giorno}:${slot.id}`);
          if (!mId) continue;
          const durata = minutiDaOrario(slot.ora_fine) - minutiDaOrario(slot.ora_inizio);
          aggiungi(mId, Math.max(0, durata));
        } else {
          const slotFine = minutiDaOrario(slot.ora_fine);
          if (slotFine > uscita) {
            // Slot parzialmente perso (solo la parte dopo l'uscita)
            const mId = orarioIdx.get(`${giorno}:${slot.id}`);
            if (!mId) continue;
            aggiungi(mId, slotFine - uscita);
          }
        }
      }
    }
  }

  const totaleMinuti = Object.values(risultato).reduce((s, r) => s + r.minutiMancati, 0);
  return { perMateria: risultato, totaleMinuti };
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
