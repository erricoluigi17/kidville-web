/**
 * CRM DELLA SEGRETERIA · VOCABOLARI E FORMA DELLE RIGHE.
 *
 * Questo file è la fonte del codice per tutto ciò che il database conosce come
 * `check (<colonna> in (…))` nella migrazione `supabase/migrations/*_crm_segreteria.sql`. Le liste
 * qui sotto e quelle della migrazione devono essere IDENTICHE, valore per valore e nello stesso
 * ordine: lo verifica `__tests__/lib/crm/vocabolari-allineati.test.ts`. Aggiungere un valore in un
 * posto solo fa cadere quel test — ed è voluto: un valore che il database rifiuta (23514) si scopre
 * altrimenti davanti a una famiglia vera.
 *
 * Le righe (`SchedaRow`, …) hanno un campo per colonna della migrazione. Le date sono STRINGHE ISO,
 * come le restituisce PostgREST: nessun `Date` attraversa il confine fra database e codice.
 */

/** Da dove è arrivata la famiglia. */
export const ORIGINI = [
  'telefonata',
  'whatsapp',
  'instagram',
  'facebook',
  'google',
  'sito',
  'passaparola',
  'open_day',
  'ai',
  'altro',
] as const
export type Origine = (typeof ORIGINI)[number]

/** A che punto è un bambino. */
export const ESITI_BAMBINO = ['aperto', 'iscritto', 'lista_attesa', 'ci_pensa', 'perso'] as const
export type EsitoBambino = (typeof ESITI_BAMBINO)[number]

/** Perché una famiglia non si iscrive. */
export const MOTIVI_PERDITA = [
  'prezzo',
  'distanza',
  'orari',
  'altra_scuola',
  'non_risponde',
  'rinviato',
  'altro',
] as const
export type MotivoPerdita = (typeof MOTIVI_PERDITA)[number]

/** Per quale anno scolastico si chiede il posto. */
export const ANNI_INGRESSO = ['in_corso', 'prossimo', 'non_indicato'] as const
export type AnnoIngresso = (typeof ANNI_INGRESSO)[number]

export const STATI_APPUNTAMENTO = ['in_programma', 'svolto', 'non_presentato', 'annullato'] as const
export type StatoAppuntamento = (typeof STATI_APPUNTAMENTO)[number]

/** I richiami della catena dei follow-up (vedi `follow-up.ts`) e il richiamo libero. */
export const TIPI_AZIONE = [
  'follow_up_1',
  'riprova_1',
  'follow_up_2',
  'riprova_2',
  'ultimatum',
  'recupero',
  'richiamare',
] as const
export type TipoAzione = (typeof TIPI_AZIONE)[number]

/** Com'è andato un richiamo. */
export const ESITI_AZIONE = ['ci_pensa', 'non_risponde', 'vuole_iscriversi', 'non_interessato'] as const
export type EsitoAzione = (typeof ESITI_AZIONE)[number]

export const MOTIVI_INDISPONIBILITA = ['ferie', 'malattia', 'chiusura', 'altro'] as const
export type MotivoIndisponibilita = (typeof MOTIVI_INDISPONIBILITA)[number]

/** Da dove è stata creata una scheda o fissata una visita. */
export const VIA = ['segreteria', 'ai'] as const
export type Via = (typeof VIA)[number]

/** Chi ha scritto una riga dello storico. */
export const AUTORE_VIA = ['segreteria', 'sistema', 'ai'] as const
export type AutoreVia = (typeof AUTORE_VIA)[number]

/** Come si è arrivati all'esito di un bambino. */
export const ESITO_ORIGINE = ['automatico', 'manuale'] as const
export type EsitoOrigine = (typeof ESITO_ORIGINE)[number]

/** Perché una domanda collegata a un bambino non è «la sua» domanda andata a buon fine. */
export const NOTE_COLLEGAMENTO = ['domanda_respinta', 'altra_domanda'] as const
export type NotaCollegamento = (typeof NOTE_COLLEGAMENTO)[number]

/** Tutto ciò che finisce nello storico di una scheda. */
export const TIPI_EVENTO = [
  'creata',
  'modificata',
  'telefonata',
  'nota',
  'bambino_aggiunto',
  'bambino_modificato',
  'appuntamento_fissato',
  'appuntamento_spostato',
  'appuntamento_riassegnato',
  'appuntamento_svolto',
  'appuntamento_non_presentato',
  'appuntamento_annullato',
  'esito_cambiato',
  'quota_segnata',
  'domanda_collegata_auto',
  'domanda_collegata_mano',
  'domanda_da_associare',
  'collegamento_tolto',
  'domanda_respinta',
  'altra_domanda',
  'azione_pianificata',
  'azione_fatta',
  'azione_spostata',
  'azione_cancellata',
] as const
export type TipoEvento = (typeof TIPI_EVENTO)[number]

/** Durata di una visita se non se ne sceglie un'altra (anche `crm_appuntamenti.durata_min` e `crm_disponibilita.durata_slot_min`). */
export const DURATA_SLOT_DEFAULT_MIN = 45

/** L'ora, a Roma, in cui scade un richiamo pianificato dal sistema. */
export const ORA_FOLLOW_UP = '10:30'

// ── Le righe, un campo per colonna della migrazione ──────────────────────────

export interface SchedaRow {
  id: string
  scuola_id: string
  genitore_nome: string | null
  telefono1: string | null
  telefono2: string | null
  email1: string | null
  email2: string | null
  telefoni_norm: string[]
  email_norm: string[]
  origine: Origine
  routine: string | null
  paura: string | null
  desiderio: string | null
  domanda_da_associare: string | null
  creato_da: string | null
  creato_via: Via
  creata_il: string
  aggiornata_il: string
  anonimizzata_il: string | null
}

export interface BambinoRow {
  id: string
  scuola_id: string
  scheda_id: string
  nome: string | null
  /** `yyyy-mm-dd` */
  data_nascita: string | null
  anno_ingresso: AnnoIngresso
  esito: EsitoBambino
  motivo_perdita: MotivoPerdita | null
  motivo_nota: string | null
  esito_origine: EsitoOrigine | null
  esito_da: string | null
  esito_il: string | null
  domanda_id: string | null
  domanda_figlio: number | null
  domanda_collegata_il: string | null
  nota_collegamento: NotaCollegamento | null
  da_verificare: boolean
  quota_saldata: boolean
  /** `yyyy-mm-dd` */
  quota_saldata_il: string | null
  quota_segnata_da: string | null
  creata_il: string
  aggiornata_il: string
}

export interface AppuntamentoRow {
  id: string
  scuola_id: string
  scheda_id: string
  inizio: string
  fine: string
  durata_min: number
  assegnata_a: string
  fissato_da: string | null
  fissato_via: Via
  stato: StatoAppuntamento
  svolto_da: string | null
  segnato_da: string | null
  segnato_il: string | null
  creato_il: string
  aggiornato_il: string
}

export interface AzioneRow {
  id: string
  scuola_id: string
  scheda_id: string
  tipo: TipoAzione
  scadenza: string
  responsabile: string
  appuntamento_id: string | null
  esito: EsitoAzione | null
  fatta_da: string | null
  fatta_il: string | null
  cancellata_il: string | null
  cancellata_da: string | null
  creata_il: string
}

export interface EventoRow {
  id: string
  scuola_id: string
  scheda_id: string
  tipo: TipoEvento
  autore: string | null
  autore_via: AutoreVia
  dati: Record<string, unknown>
  testo: string | null
  creato_il: string
}

export interface DisponibilitaRow {
  id: string
  scuola_id: string
  utente_id: string
  /** 1 = lunedì … 7 = domenica (ISO) */
  giorno_settimana: number
  /** `HH:MM:SS`, come lo restituisce Postgres per `time` */
  ora_inizio: string
  ora_fine: string
  durata_slot_min: number
  /** `yyyy-mm-dd` */
  valida_dal: string
  /** `yyyy-mm-dd`; nullo = senza fine */
  valida_al: string | null
  creata_il: string
}

export interface IndisponibilitaRow {
  id: string
  scuola_id: string
  /** nullo = tutta la sede */
  utente_id: string | null
  dal: string
  al: string
  motivo: MotivoIndisponibilita
  creata_da: string | null
  creata_il: string
}
