// =============================================================================
// Comuni e codici catastali (Belfiore) — lettura del dataset generato.
//
// Sorgente dei dati: `./dati/comuni-belfiore.ts`, generato da
// `scripts/genera-comuni.mjs` e COMMITTATO (attribuzione CC BY-SA 4.0 e data della
// fonte nell'intestazione di quel file: l'elenco è fermo a circa il 2022).
//
// ─── DOVE PUÒ GIRARE QUESTO MODULO: SOLO SUL SERVER ─────────────────────────────
// Il dataset pesa ~294 KB di testo. Il browser non ne ha bisogno e non deve
// riceverlo: per comporre un codice fiscale serve IL CODICE BELFIORE, non la
// tabella — e il Belfiore glielo consegna una tendina, cioè un elenco già ridotto
// alla provincia scelta. Importare questo modulo (o `./dati/**`) da un file
// `'use client'` significherebbe spedire 294 KB a ogni famiglia che apre il form,
// sulla rete mobile, per poi usarne quattro caratteri.
// Il lock che lo impedisce è `__tests__/architecture/dataset-comuni-fuori-dal-bundle.test.ts`.
//
// ─── LA REGOLA D'ORO, EREDITATA DA `src/lib/anagrafiche/province.ts` ────────────
// «MAI troncare/indovinare»: se l'input non è riconoscibile con CERTEZZA si dice
// che non lo è. Qui prende la forma di `risolviComune`, che ha tre esiti e non due:
// `trovato`, `sconosciuto` e — quello che conta — `ambiguo`. «Calliano» esiste ad
// Asti e a Trento, con due Belfiore diversi: sceglierne uno vorrebbe dire scrivere
// nel codice fiscale di un bambino un comune di nascita sbagliato, senza che nessun
// errore si accenda da nessuna parte. Meglio restituire i candidati e far scegliere.
// =============================================================================

import { normalizzaProvincia } from '@/lib/anagrafiche/province';

import { COMUNI_GREZZI } from './dati/comuni-belfiore';

/** Un comune italiano o uno stato estero, come lo conosce la tabella Belfiore. */
export interface Comune {
  /** Codice catastale a 4 caratteri: lettera + tre cifre (es. `H501`). Gli stati esteri iniziano per `Z`. */
  belfiore: string;
  /** Sigla della provincia (es. `NA`). `EE` per gli stati esteri. */
  sigla: string;
  /** Denominazione come compare nel dataset: MAIUSCOLA, accenti resi con l'apostrofo (`AGLIE'`). */
  nome: string;
  /** `false` per le denominazioni soppresse (comuni fusi, rinominati, cessati). */
  attivo: boolean;
}

/** Esito di una risoluzione per nome. Tre casi, perché due mentirebbero. */
export type EsitoComune =
  | { esito: 'trovato'; comune: Comune }
  | { esito: 'ambiguo'; candidati: readonly Comune[] }
  | { esito: 'sconosciuto' };

interface Opzioni {
  /** Includere anche le denominazioni soppresse. Default: `false`. */
  soppressi?: boolean;
}

interface Indice {
  tutti: readonly Comune[];
  perBelfiore: ReadonlyMap<string, Comune[]>;
  perSigla: ReadonlyMap<string, Comune[]>;
  /** Nome ridotto alla chiave «lasca» (vedi `chiaveLasca`) → tutte le righe che la condividono. */
  perNome: ReadonlyMap<string, Comune[]>;
  sigle: readonly string[];
  insiemeSigle: ReadonlySet<string>;
}

/**
 * Chiave LASCA: massimo recupero. Toglie accenti, apostrofi, trattini, spazi e
 * punteggiatura, e alza tutto a maiuscolo. «Sant'Antonio Abate», «SANTANTONIO ABATE»
 * e «sant antonio  abate» collassano sulla stessa chiave; «Agliè» collassa su `AGLIE`,
 * che è dove finisce anche `AGLIE'` del dataset.
 */
function chiaveLasca(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Chiave STRETTA: conserva ciò che la lasca butta via e che a volte DISTINGUE due
 * comuni diversi. Due casi reali, misurati su questo dataset:
 *   · «PATERNO» (PZ) e «PATERNO'» (CT) — l'accento è tutta la differenza;
 *   · «TREVILLE» (AL) e «TRE VILLE» (TN) — lo spazio è tutta la differenza.
 * Sulla chiave lasca sono la stessa cosa; sulla stretta no. Se chi scrive mette
 * l'accento o lo spazio sta già dicendo quale intende, e buttare via quel segno
 * fabbricherebbe un'ambiguità che nei fatti non esiste. Le vocali accentate
 * diventano «vocale + apostrofo» perché è così che il dataset le scrive (`AGLIE'`).
 */
function chiaveStretta(s: string): string {
  return s
    .normalize('NFD')
    .replace(/([A-Za-z])[̀-ͯ]+/g, "$1'")
    .replace(/[‘’ʼ´`]/g, "'")
    .toUpperCase()
    .replace(/[^A-Z0-9']+/g, ' ')
    .trim();
}

let indiceMemorizzato: Indice | null = null;

/**
 * Costruisce l'indice AL PRIMO USO, non all'import.
 *
 * Perché pigro: importare questo modulo non deve costare nulla. Una route che lo
 * importa per un ramo che poi non prende (un `POST` che valida e risponde 400 prima
 * di arrivare al comune) non paga il parsing di 13.656 righe; e in un ambiente
 * serverless, dove il costo si paga a ogni cold start, la differenza si vede nel
 * tempo di risposta. Dopo la prima chiamata l'indice resta in memoria per tutta la
 * vita dell'istanza.
 */
function indice(): Indice {
  if (indiceMemorizzato) return indiceMemorizzato;

  const tutti: Comune[] = [];
  const perBelfiore = new Map<string, Comune[]>();
  const perSigla = new Map<string, Comune[]>();
  const perNome = new Map<string, Comune[]>();
  const malformate: string[] = [];

  for (const riga of COMUNI_GREZZI.split('\n')) {
    if (riga === '') continue;
    const campi = riga.split('|');
    if (campi.length !== 4 || !/^[A-Z][0-9]{3}$/.test(campi[0]) || !/^[A-Z]{2}$/.test(campi[1])) {
      // Le prime dieci bastano a capire cosa è successo; l'elenco intero sarebbe illeggibile.
      if (malformate.length < 10) malformate.push(riga);
      continue;
    }
    const comune: Comune = {
      belfiore: campi[0],
      sigla: campi[1],
      nome: campi[2],
      attivo: campi[3] === '1',
    };
    tutti.push(comune);
    aggiungi(perBelfiore, comune.belfiore, comune);
    aggiungi(perSigla, comune.sigla, comune);
    aggiungi(perNome, chiaveLasca(comune.nome), comune);
  }

  // Un dataset illeggibile non si aggira in silenzio: `comuniDiProvincia` tornerebbe
  // vuoto e `risolviComune` direbbe «sconosciuto» per OGNI comune d'Italia, che è
  // indistinguibile dal funzionamento normale su un input sbagliato. Qui si alza un
  // errore parlante, che la route chiamante logga tramite `withRoute`. Il file è
  // generato e sotto lock: se questo scatta, è un bug, non un dato d'ingresso.
  if (malformate.length > 0 || tutti.length === 0) {
    throw new Error(
      `Dataset comuni-belfiore illeggibile: ${tutti.length} righe valide, prime righe rotte: ` +
        `${JSON.stringify(malformate)}. Rigenerare con: node scripts/genera-comuni.mjs`,
    );
  }

  const sigle = [...perSigla.keys()].sort();
  indiceMemorizzato = {
    tutti,
    perBelfiore,
    perSigla,
    perNome,
    sigle,
    insiemeSigle: new Set(sigle),
  };
  return indiceMemorizzato;
}

function aggiungi(mappa: Map<string, Comune[]>, chiave: string, comune: Comune): void {
  const esistenti = mappa.get(chiave);
  if (esistenti) esistenti.push(comune);
  else mappa.set(chiave, [comune]);
}

/**
 * Porta un input alla sigla del dataset, oppure `null`.
 * Accetta la sigla (anche minuscola, anche con spazi), il nome esteso della provincia
 * (`Napoli`, `Forlì-Cesena`, via `normalizzaProvincia`) e `EE` per l'estero — che
 * `province.ts` non conosce, perché estero provincia non è.
 */
function normalizzaSigla(input: string): string | null {
  const t = input.trim();
  if (t === '') return null;
  if (/^[A-Za-z]{2}$/.test(t)) {
    const maiuscola = t.toUpperCase();
    return indice().insiemeSigle.has(maiuscola) ? maiuscola : null;
  }
  const dalNome = normalizzaProvincia(t);
  return dalNome !== null && indice().insiemeSigle.has(dalNome) ? dalNome : null;
}

function ordinaPerNome(comuni: readonly Comune[]): Comune[] {
  // Confronto sui codepoint e non `localeCompare`: il dataset è ASCII maiuscolo e
  // l'ordine dev'essere lo stesso su ogni macchina e in ogni locale.
  return [...comuni].sort((a, b) =>
    a.nome === b.nome ? a.belfiore.localeCompare(b.belfiore) : a.nome < b.nome ? -1 : 1,
  );
}

/**
 * I comuni di una provincia, in ordine alfabetico. È la funzione che riempie la
 * tendina: di default SOLO gli attivi, perché un genitore non sceglie un comune che
 * non esiste più. I soppressi servono a chi legge un certificato vecchio, e si
 * chiedono esplicitamente con `{ soppressi: true }`.
 *
 * Sigla non riconosciuta → elenco vuoto (non un errore: chiamarla con l'input di un
 * form è normale, e un `throw` costringerebbe ogni chiamante a un try/catch).
 */
export function comuniDiProvincia(sigla: string, opts?: Opzioni): readonly Comune[] {
  if (typeof sigla !== 'string') return [];
  const normalizzata = normalizzaSigla(sigla);
  if (normalizzata === null) return [];
  const righe = indice().perSigla.get(normalizzata) ?? [];
  return ordinaPerNome(opts?.soppressi ? righe : righe.filter((c) => c.attivo));
}

/**
 * Il comune di un codice catastale, o `null`.
 * Quando il codice porta più denominazioni (la attuale e le precedenti) restituisce
 * quella ATTIVA; se sono tutte soppresse, la prima in ordine alfabetico. Sugli stati
 * esteri più denominazioni possono essere attive insieme (Z114 = «GRAN BRETAGNA E
 * IRLANDA DEL NORD» e «REGNO UNITO»): sono sinonimi dello stesso luogo, quindi
 * sceglierne una NON è indovinare — il Belfiore, che è ciò che conta, è lo stesso.
 */
export function comunePerBelfiore(belfiore: string): Comune | null {
  if (typeof belfiore !== 'string') return null;
  const codice = belfiore.trim().toUpperCase();
  if (!/^[A-Z][0-9]{3}$/.test(codice)) return null;
  const righe = indice().perBelfiore.get(codice);
  if (!righe || righe.length === 0) return null;
  const ordinate = ordinaPerNome(righe);
  return ordinate.find((c) => c.attivo) ?? ordinate[0];
}

/** Tutte le sigle presenti nel dataset, ordinate. 107 province + `EE` + le storiche `PL` e `ZA`. */
export function siglePresenti(): readonly string[] {
  return indice().sigle;
}

/**
 * Risolve un nome di comune (e opzionalmente una provincia) in un `Comune`.
 *
 * Come sceglie, in quest'ordine — e ogni passo RESTRINGE, nessuno indovina:
 *  1. candidati per chiave lasca (accenti, apostrofi, spazi e maiuscole non contano);
 *  2. se la provincia è indicata, si tengono solo i candidati di quella provincia;
 *  3. se qualche candidato combacia anche sulla chiave STRETTA, si tengono solo quelli
 *     («Paternò» → CT, e non più anche «Paterno» PZ);
 *  4. se fra i rimasti c'è almeno un attivo, i soppressi escono («Abano Terme» batte
 *     «Abano Bagni»). Un soppresso si trova ancora, ma solo se è l'unica risposta;
 *  5. i candidati si deduplicano per Belfiore: due nomi per lo stesso codice sono lo
 *     stesso luogo, non un'ambiguità.
 * Se resta un solo Belfiore → `trovato`. Se ne restano di più → `ambiguo`, con tutti i
 * candidati, perché la scelta spetta a chi ha il certificato in mano. Se non ne resta
 * nessuno → `sconosciuto`.
 *
 * Sulla provincia: `undefined`, `null` e stringa vuota significano «non indicata», e si
 * cerca in tutta Italia. Una provincia indicata MALE — sigla ignota, o un valore che non
 * è nemmeno una stringa — dà `sconosciuto`: un vincolo che il chiamante ha messo non può
 * sparire in silenzio.
 */
export function risolviComune(nome: string, sigla?: string | null): EsitoComune {
  if (typeof nome !== 'string') return { esito: 'sconosciuto' };
  const richiesto = nome.trim();
  if (richiesto === '') return { esito: 'sconosciuto' };

  let candidati = indice().perNome.get(chiaveLasca(richiesto)) ?? [];
  if (candidati.length === 0) return { esito: 'sconosciuto' };

  // «Provincia non indicata» e «provincia indicata male» sono due cose diverse, e la
  // differenza va tenuta: `undefined`/`null`/stringa vuota vogliono dire «cerca in tutta
  // Italia», mentre QUALUNQUE altro valore è un vincolo che il chiamante crede di aver
  // messo. Se quel valore non è una stringa (un numero, un array, un oggetto: capita
  // quando arriva da JSON non validato) NON si può normalizzare — e proseguire come se
  // la provincia non fosse stata indicata farebbe evaporare il vincolo IN SILENZIO,
  // rispondendo «Roma RM» a chi aveva chiesto Roma in un'altra provincia. È la regola
  // d'oro di questo modulo, in cima al file: mai indovinare, e mai rispondere senza il
  // vincolo che ci è stato dato. Quindi si dice che non si sa — come già fa
  // `comuniDiProvincia`, che sulla stessa sigla mal tipata restituisce un elenco vuoto.
  if (sigla !== undefined && sigla !== null && typeof sigla !== 'string') {
    return { esito: 'sconosciuto' };
  }

  if (typeof sigla === 'string' && sigla.trim() !== '') {
    const provincia = normalizzaSigla(sigla);
    if (provincia === null) return { esito: 'sconosciuto' };
    candidati = candidati.filter((c) => c.sigla === provincia);
    if (candidati.length === 0) return { esito: 'sconosciuto' };
  }

  const stretta = chiaveStretta(richiesto);
  const esatti = candidati.filter((c) => chiaveStretta(c.nome) === stretta);
  if (esatti.length > 0) candidati = esatti;

  const attivi = candidati.filter((c) => c.attivo);
  if (attivi.length > 0) candidati = attivi;

  const perBelfiore = new Map<string, Comune>();
  for (const c of candidati) if (!perBelfiore.has(c.belfiore)) perBelfiore.set(c.belfiore, c);

  const distinti = [...perBelfiore.values()];
  if (distinti.length === 1) return { esito: 'trovato', comune: distinti[0] };
  return { esito: 'ambiguo', candidati: ordinaPerNome(distinti) };
}
