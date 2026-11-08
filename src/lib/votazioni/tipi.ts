/**
 * VOTAZIONI DEI RAPPRESENTANTI · I CONTRATTI.
 *
 * Questo file è il CONTRATTO fra le route (`src/app/api/{admin,parent}/votazioni/`) e le schermate
 * (`src/components/features/votazioni/`): chi scrive una delle due parti si fida dei nomi e delle forme
 * che stanno qui, e non guarda l’altra. Si può AGGIUNGERE; non si rinomina e non si cambia la forma di
 * ciò che c’è senza rifare entrambe le parti.
 *
 * ── CHE COSA È UNA «VOTAZIONE» ───────────────────────────────────────────────
 *
 * Una tornata: un titolo, una scadenza sola, una sede, una o più CLASSI (`votazioni_classi`) e,
 * facoltativamente, l’istituto (`rappresentante_istituto`, con i suoi `votazioni_candidati`). Ogni classe
 * e l’istituto sono una SCHEDA. Il genitore vota una volta per scheda (può cambiare fino alla scadenza,
 * vale l’ultimo): `votazioni_voti` ha una riga per (votazione, ambito, classe, elettore).
 *
 * ── GLI ISTANTI ──────────────────────────────────────────────────────────────
 *
 * `scadenza`, `chiusaIl`, `creataIl`, `votatoIl` (e le loro gemelle snake_case di `RigaVotazione`) sono
 * ISTANTI ISO UTC (`2026-11-20T17:00:00.000Z`). Sul filo dal client verso il server la scadenza viaggia
 * invece come `YYYY-MM-DDTHH:MM` locale (vedi `schemi.ts`), e la converte il server.
 *
 * ── GLI ID ───────────────────────────────────────────────────────────────────
 *
 * `sectionId` è `sections.id`, mai il nome della classe: da quando le sedi sono tre, «2 ANNI» esiste in
 * più plessi. `utenteId`, `elettoreId`, `candidatoId` sono `utenti.id` (l’identità del login).
 */

/** Gli ambiti di un voto. Allineati al `CHECK` di `votazioni_voti.ambito`: li tiene d’accordo un test. */
export const AMBITI = ['classe', 'istituto'] as const
export type Ambito = (typeof AMBITI)[number]

/** `aperta` si ricava da `chiusa_il` e dalla scadenza (`statoVotazione`): non è una colonna. */
export type StatoVotazione = 'aperta' | 'chiusa'

/** Il tetto del titolo: lo stesso del `CHECK` su `votazioni.titolo`. */
export const TITOLO_MAX = 120
/** Il titolo proposto: l'anno viene dal calendario della sede (`annoDelGiorno(oggi, cal).etichettaBreve`), mai scritto qui. */
export function titoloPredefinito(etichettaBreve: string): string {
  return `Elezione dei rappresentanti dei genitori a.s. ${etichettaBreve}`
}

/** Riga DB di `votazioni`. */
export interface RigaVotazione {
  id: string
  scuola_id: string
  titolo: string
  scadenza: string
  chiusa_il: string | null
  rappresentante_istituto: boolean
  creata_da: string
  creata_il: string
  aggiornata_da: string | null
  aggiornata_il: string | null
}

/** Un genitore con un account dell’app. `nome` è «Cognome Nome». */
export interface GenitoreScheda {
  utenteId: string
  nome: string
}

export interface ClasseVotazione {
  sectionId: string
  nome: string
  grado: string | null
}

export interface RiepilogoVotazione {
  id: string
  scuolaId: string
  titolo: string
  scadenza: string
  chiusaIl: string | null
  stato: StatoVotazione
  rappresentanteIstituto: boolean
  classi: ClasseVotazione[]
  /** Gli elettori distinti, contati su tutte le schede. */
  votanti: number
  creataIl: string
}

export interface CandidatoConVoti {
  utenteId: string
  nome: string
  voti: number
}

/** Una riga di «chi ha votato chi». */
export interface RigaChiHaVotato {
  elettoreId: string
  elettoreNome: string
  candidatoId: string
  candidatoNome: string
  votatoIl: string
  aggiornatoIl: string | null
}

/**
 * Il risultato di UNA scheda.
 *  · `nome`: il nome della classe, oppure quello della sede per l’istituto;
 *  · `candidati`: per la classe, chi ha preso almeno un voto; per l’istituto, TUTTI i candidati anche a 0.
 *    In ordine di voti decrescenti e poi di nome;
 *  · `eletti`: 1 elemento = eletto, più di 1 = parità (decide la segreteria), 0 = nessun voto;
 *  · `voti`: ordinati per `elettoreNome`;
 *  · `aventiDiritto` può essere 0 (classe senza genitori con account): l’affluenza allora è 0/0, senza
 *    divisione per zero (`affluenza` in `conteggio.ts`).
 */
export interface RisultatoScheda {
  ambito: Ambito
  sectionId: string | null
  nome: string
  aventiDiritto: number
  votanti: number
  candidati: CandidatoConVoti[]
  eletti: string[]
  voti: RigaChiHaVotato[]
}

export interface DettaglioVotazione extends RiepilogoVotazione {
  candidatiIstituto: GenitoreScheda[]
  schede: RisultatoScheda[]
}

// ── Risposte delle API (staff) ───────────────────────────────────────────────

/** `disponibile: false` = lo schema delle votazioni non c’è su questo ambiente (200, non un errore). */
export interface ElencoVotazioniRisposta {
  disponibile: boolean
  votazioni: RiepilogoVotazione[]
}
export interface DettaglioVotazioneRisposta {
  votazione: DettaglioVotazione
}
export interface GenitoriSedeRisposta {
  genitori: GenitoreScheda[]
}
export interface CreaVotazioneRisposta {
  id: string
}

// ── Risposte delle API (genitore) ────────────────────────────────────────────

/** Una scheda da compilare, vista dal genitore. `sceltaAttuale` è il `candidatoId` già votato, o null. */
export interface SchedaGenitore {
  votazioneId: string
  titolo: string
  scadenza: string
  ambito: Ambito
  sectionId: string | null
  classeNome: string | null
  sedeNome: string
  candidati: GenitoreScheda[]
  sceltaAttuale: string | null
}
export interface SchedeGenitoreRisposta {
  disponibile: boolean
  schede: SchedaGenitore[]
}
export interface VotoRisposta {
  ok: true
  sceltaAttuale: string
  cambiato: boolean
}
