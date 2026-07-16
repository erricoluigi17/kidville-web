// =============================================================================
// Province italiane — modulo condiviso di anagrafica.
//
// Sorgente unica di verità per le 107 province / città metropolitane italiane
// attuali (post riordino Sardegna 2016: incluse SU Sud Sardegna, BT
// Barletta-Andria-Trani, MB Monza e della Brianza, FC Forlì-Cesena,
// VB Verbano-Cusio-Ossola, ...).
//
// API minimale, pensata per i consumatori dell'anagrafica (form alunni/genitori,
// import SIDI, validazione zod):
//   - PROVINCE            elenco { sigla, nome }
//   - isSiglaProvincia()  è una sigla ufficiale? (case-insensitive)
//   - normalizzaProvincia() input libero -> sigla ufficiale, oppure null.
//
// Regola d'oro: MAI troncare/indovinare. Se l'input non è riconoscibile con
// certezza si restituisce `null`, così il chiamante può decidere (scartare,
// segnalare) invece di salvare una sigla sbagliata.
// =============================================================================

export interface Provincia {
  /** Sigla ufficiale a 2 lettere maiuscole (es. "NA"). */
  sigla: string;
  /** Nome esteso della provincia / città metropolitana (es. "Napoli"). */
  nome: string;
}

/**
 * Le 107 province / città metropolitane italiane attuali.
 * Ordine alfabetico per nome. `nome` usa la forma d'uso comune (quella che
 * compare nella modulistica), non necessariamente la denominazione ufficiale
 * più lunga: le varianti sono gestite dagli alias in `ALIAS_NOME`.
 */
export const PROVINCE: readonly Provincia[] = [
  { sigla: 'AG', nome: 'Agrigento' },
  { sigla: 'AL', nome: 'Alessandria' },
  { sigla: 'AN', nome: 'Ancona' },
  { sigla: 'AO', nome: 'Aosta' },
  { sigla: 'AR', nome: 'Arezzo' },
  { sigla: 'AP', nome: 'Ascoli Piceno' },
  { sigla: 'AT', nome: 'Asti' },
  { sigla: 'AV', nome: 'Avellino' },
  { sigla: 'BA', nome: 'Bari' },
  { sigla: 'BT', nome: 'Barletta-Andria-Trani' },
  { sigla: 'BL', nome: 'Belluno' },
  { sigla: 'BN', nome: 'Benevento' },
  { sigla: 'BG', nome: 'Bergamo' },
  { sigla: 'BI', nome: 'Biella' },
  { sigla: 'BO', nome: 'Bologna' },
  { sigla: 'BZ', nome: 'Bolzano' },
  { sigla: 'BS', nome: 'Brescia' },
  { sigla: 'BR', nome: 'Brindisi' },
  { sigla: 'CA', nome: 'Cagliari' },
  { sigla: 'CL', nome: 'Caltanissetta' },
  { sigla: 'CB', nome: 'Campobasso' },
  { sigla: 'CE', nome: 'Caserta' },
  { sigla: 'CT', nome: 'Catania' },
  { sigla: 'CZ', nome: 'Catanzaro' },
  { sigla: 'CH', nome: 'Chieti' },
  { sigla: 'CO', nome: 'Como' },
  { sigla: 'CS', nome: 'Cosenza' },
  { sigla: 'CR', nome: 'Cremona' },
  { sigla: 'KR', nome: 'Crotone' },
  { sigla: 'CN', nome: 'Cuneo' },
  { sigla: 'EN', nome: 'Enna' },
  { sigla: 'FM', nome: 'Fermo' },
  { sigla: 'FE', nome: 'Ferrara' },
  { sigla: 'FI', nome: 'Firenze' },
  { sigla: 'FG', nome: 'Foggia' },
  { sigla: 'FC', nome: 'Forlì-Cesena' },
  { sigla: 'FR', nome: 'Frosinone' },
  { sigla: 'GE', nome: 'Genova' },
  { sigla: 'GO', nome: 'Gorizia' },
  { sigla: 'GR', nome: 'Grosseto' },
  { sigla: 'IM', nome: 'Imperia' },
  { sigla: 'IS', nome: 'Isernia' },
  { sigla: 'AQ', nome: "L'Aquila" },
  { sigla: 'SP', nome: 'La Spezia' },
  { sigla: 'LT', nome: 'Latina' },
  { sigla: 'LE', nome: 'Lecce' },
  { sigla: 'LC', nome: 'Lecco' },
  { sigla: 'LI', nome: 'Livorno' },
  { sigla: 'LO', nome: 'Lodi' },
  { sigla: 'LU', nome: 'Lucca' },
  { sigla: 'MC', nome: 'Macerata' },
  { sigla: 'MN', nome: 'Mantova' },
  { sigla: 'MS', nome: 'Massa-Carrara' },
  { sigla: 'MT', nome: 'Matera' },
  { sigla: 'ME', nome: 'Messina' },
  { sigla: 'MI', nome: 'Milano' },
  { sigla: 'MO', nome: 'Modena' },
  { sigla: 'MB', nome: 'Monza e della Brianza' },
  { sigla: 'NA', nome: 'Napoli' },
  { sigla: 'NO', nome: 'Novara' },
  { sigla: 'NU', nome: 'Nuoro' },
  { sigla: 'OR', nome: 'Oristano' },
  { sigla: 'PD', nome: 'Padova' },
  { sigla: 'PA', nome: 'Palermo' },
  { sigla: 'PR', nome: 'Parma' },
  { sigla: 'PV', nome: 'Pavia' },
  { sigla: 'PG', nome: 'Perugia' },
  { sigla: 'PU', nome: 'Pesaro e Urbino' },
  { sigla: 'PE', nome: 'Pescara' },
  { sigla: 'PC', nome: 'Piacenza' },
  { sigla: 'PI', nome: 'Pisa' },
  { sigla: 'PT', nome: 'Pistoia' },
  { sigla: 'PN', nome: 'Pordenone' },
  { sigla: 'PZ', nome: 'Potenza' },
  { sigla: 'PO', nome: 'Prato' },
  { sigla: 'RG', nome: 'Ragusa' },
  { sigla: 'RA', nome: 'Ravenna' },
  { sigla: 'RC', nome: 'Reggio Calabria' },
  { sigla: 'RE', nome: 'Reggio Emilia' },
  { sigla: 'RI', nome: 'Rieti' },
  { sigla: 'RN', nome: 'Rimini' },
  { sigla: 'RM', nome: 'Roma' },
  { sigla: 'RO', nome: 'Rovigo' },
  { sigla: 'SA', nome: 'Salerno' },
  { sigla: 'SS', nome: 'Sassari' },
  { sigla: 'SV', nome: 'Savona' },
  { sigla: 'SI', nome: 'Siena' },
  { sigla: 'SR', nome: 'Siracusa' },
  { sigla: 'SO', nome: 'Sondrio' },
  { sigla: 'SU', nome: 'Sud Sardegna' },
  { sigla: 'TA', nome: 'Taranto' },
  { sigla: 'TE', nome: 'Teramo' },
  { sigla: 'TR', nome: 'Terni' },
  { sigla: 'TO', nome: 'Torino' },
  { sigla: 'TP', nome: 'Trapani' },
  { sigla: 'TN', nome: 'Trento' },
  { sigla: 'TV', nome: 'Treviso' },
  { sigla: 'TS', nome: 'Trieste' },
  { sigla: 'UD', nome: 'Udine' },
  { sigla: 'VA', nome: 'Varese' },
  { sigla: 'VE', nome: 'Venezia' },
  { sigla: 'VB', nome: 'Verbano-Cusio-Ossola' },
  { sigla: 'VC', nome: 'Vercelli' },
  { sigla: 'VR', nome: 'Verona' },
  { sigla: 'VV', nome: 'Vibo Valentia' },
  { sigla: 'VI', nome: 'Vicenza' },
  { sigla: 'VT', nome: 'Viterbo' },
];

/**
 * Chiave di confronto per i nomi: minuscolo, senza accenti/diacritici e senza
 * separatori (spazi, trattini, apostrofi, punti). Così "Forlì-Cesena",
 * "forli cesena", "L'Aquila" e "laquila" collassano tutte alla stessa chiave.
 */
function chiaveNome(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // rimuove i segni diacritici combinanti
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // rimuove tutto ciò che non è lettera/cifra
}

/**
 * Alias di nomi accettati oltre alla forma canonica di `PROVINCE`.
 * Coprono denominazioni ufficiali alternative e abbreviazioni d'uso comune.
 * Non introducono ambiguità: ogni chiave resta associata a una sola sigla.
 */
const ALIAS_NOME: ReadonlyArray<{ nome: string; sigla: string }> = [
  { nome: 'Monza Brianza', sigla: 'MB' },
  { nome: 'Monza', sigla: 'MB' },
  { nome: "Reggio nell'Emilia", sigla: 'RE' },
  { nome: 'Reggio di Calabria', sigla: 'RC' },
  { nome: 'Massa e Carrara', sigla: 'MS' },
  { nome: 'Massa', sigla: 'MS' },
  { nome: "Valle d'Aosta", sigla: 'AO' },
  { nome: 'Verbania', sigla: 'VB' },
  { nome: 'Aquila', sigla: 'AQ' },
  { nome: 'Bozen', sigla: 'BZ' },
];

const SIGLE = new Set(PROVINCE.map((p) => p.sigla));

const NOME_TO_SIGLA: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const p of PROVINCE) m.set(chiaveNome(p.nome), p.sigla);
  for (const a of ALIAS_NOME) m.set(chiaveNome(a.nome), a.sigla);
  return m;
})();

/**
 * True se `input`, ripulito e in maiuscolo, è una sigla di provincia ufficiale.
 * Confronto case-insensitive.
 */
export function isSiglaProvincia(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const t = input.trim();
  if (!/^[a-zA-Z]{2}$/.test(t)) return false;
  return SIGLE.has(t.toUpperCase());
}

/**
 * Normalizza un input libero nella sigla ufficiale della provincia.
 *
 * - trim iniziale;
 * - se è già una sigla valida (2 lettere, case-insensitive) → sigla MAIUSCOLA;
 * - se è un nome per esteso riconoscibile (case/accent-insensitive, con
 *   spazi/trattini/apostrofi normalizzati) → sigla corrispondente;
 * - altrimenti → `null` (MAI un troncamento arbitrario).
 *
 * Input non-stringa (null, undefined, numeri, oggetti) → `null`.
 */
export function normalizzaProvincia(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const t = input.trim();
  if (t === '') return null;

  // 1) Sigla esplicita (2 lettere).
  if (/^[a-zA-Z]{2}$/.test(t)) {
    const up = t.toUpperCase();
    return SIGLE.has(up) ? up : null;
  }

  // 2) Nome per esteso (o alias).
  return NOME_TO_SIGLA.get(chiaveNome(t)) ?? null;
}
