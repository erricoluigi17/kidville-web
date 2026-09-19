// ============================================================
// Prestampato import anagrafiche (alunno + genitori) — contratto colonne.
// Le intestazioni sono in italiano e mappate ai campi interni dal parser.
// Usato dallo strumento Import (client) e dalla route /api/admin/import/anagrafiche.
//
// La citazione NON è più scritta qui: viene da `@/lib/export/csv`, che è la casa
// unica delle regole del CSV in uscita. La copia privata che stava a riga 41
// citava su `/[",\n;]/` — SENZA `\r`, cioè una cella con un ritorno a capo vecchio
// stile usciva non citata e spezzava la riga. È la stessa lezione già pagata con
// `@/lib/avvisi/classi-sede`: una regola valida per più strade vive in un posto
// solo, o le copie divergono e la prima che diverge è quella che nessuno guarda.
//
// `csvCell` e non `csvCellSicura` di proposito: qui i valori sono NOSTRI —
// intestazioni costanti e una riga d'esempio scritta da noi — e nessuno comincia
// per `=`/`+`/`-`/`@`. È esattamente il caso che la documentazione di `csvCell`
// descrive come suo.
// ============================================================

import { csvCell } from '@/lib/export/csv';

export const TEMPLATE_HEADERS = [
  'Nome alunno',
  'Cognome alunno',
  'Sesso (M/F)',
  'Data nascita (AAAA-MM-GG)',
  'Codice fiscale alunno',
  'Comune nascita',
  'Provincia nascita (sigla)',
  'Indirizzo residenza',
  'Comune residenza',
  'CAP',
  'Classe/Sezione',
  'Genitore1 Nome',
  'Genitore1 Cognome',
  'Genitore1 Codice fiscale',
  'Genitore1 Email',
  'Genitore1 Telefono',
  'Genitore1 Relazione (madre/padre/tutore)',
  'Genitore2 Nome',
  'Genitore2 Cognome',
  'Genitore2 Codice fiscale',
  'Genitore2 Email',
  'Genitore2 Telefono',
  'Genitore2 Relazione (madre/padre/tutore)',
] as const;

// Riga di esempio (guida alla compilazione, va cancellata prima dell'import reale
// oppure lasciata: senza CF valido e con nomi placeholder crea un record demo).
const EXAMPLE_ROW = [
  'Mario', 'Rossi', 'M', '2020-04-15', '', 'Napoli', 'NA', 'Via Roma 1', 'Giugliano in Campania', '80014', '',
  'Anna', 'Bianchi', '', 'anna.bianchi@email.com', '3331234567', 'madre',
  'Luca', 'Rossi', '', 'luca.rossi@email.com', '3339876543', 'padre',
];

/** Genera il CSV prestampato (BOM per gli accenti corretti in Excel). */
export function buildTemplateCsv(): string {
  const header = TEMPLATE_HEADERS.map(csvCell).join(',');
  const example = EXAMPLE_ROW.map(csvCell).join(',');
  return '﻿' + header + '\n' + example + '\n';
}

/** Normalizza una relazione in testo libero a mother/father/delegate. */
export function normalizeRelazione(v: unknown): 'mother' | 'father' | 'delegate' {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.startsWith('madre') || s === 'mother' || s === 'mamma') return 'mother';
  if (s.startsWith('padre') || s === 'father' || s === 'papà' || s === 'papa') return 'father';
  return 'delegate';
}

export interface ParsedGenitore {
  first_name: string;
  last_name: string;
  fiscal_code: string;
  email: string;
  phone: string;
  role: 'mother' | 'father' | 'delegate';
}

export interface ParsedFamily {
  alunno: {
    nome: string;
    cognome: string;
    sesso: string;
    data_nascita: string;
    codice_fiscale: string;
    comune_nascita: string;
    provincia_nascita: string;
    indirizzo_residenza: string;
    comune_residenza: string;
    cap: string;
    classe_sezione: string;
  };
  genitori: ParsedGenitore[];
}

const cell = (row: Record<string, unknown>, key: string) => String(row[key] ?? '').trim();

/**
 * Mappa una riga del foglio (keyed dalle intestazioni italiane) in una famiglia
 * pronta per l'import. Ritorna null per le righe vuote (niente nome/cognome alunno).
 */
export function parseFamilyRow(row: Record<string, unknown>): ParsedFamily | null {
  const nome = cell(row, 'Nome alunno');
  const cognome = cell(row, 'Cognome alunno');
  if (!nome && !cognome) return null;

  const alunno = {
    nome,
    cognome,
    sesso: cell(row, 'Sesso (M/F)').toUpperCase(),
    data_nascita: cell(row, 'Data nascita (AAAA-MM-GG)'),
    codice_fiscale: cell(row, 'Codice fiscale alunno').toUpperCase(),
    comune_nascita: cell(row, 'Comune nascita'),
    provincia_nascita: cell(row, 'Provincia nascita (sigla)').toUpperCase(),
    indirizzo_residenza: cell(row, 'Indirizzo residenza'),
    comune_residenza: cell(row, 'Comune residenza'),
    cap: cell(row, 'CAP'),
    classe_sezione: cell(row, 'Classe/Sezione'),
  };

  const genitori: ParsedGenitore[] = [];
  for (const n of [1, 2]) {
    const fn = cell(row, `Genitore${n} Nome`);
    const ln = cell(row, `Genitore${n} Cognome`);
    if (!fn && !ln) continue;
    genitori.push({
      first_name: fn,
      last_name: ln,
      fiscal_code: cell(row, `Genitore${n} Codice fiscale`).toUpperCase(),
      email: cell(row, `Genitore${n} Email`),
      phone: cell(row, `Genitore${n} Telefono`),
      role: normalizeRelazione(row[`Genitore${n} Relazione (madre/padre/tutore)`]),
    });
  }

  return { alunno, genitori };
}
