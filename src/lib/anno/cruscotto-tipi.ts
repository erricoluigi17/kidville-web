/**
 * IL CRUSCOTTO DELL'ANNO PROSSIMO — i tipi del JSON (PR 4.7, compito 4.7.0).
 *
 * Il contratto fra la funzione SQL `anno_cruscotto` (compito 4.7.1), la route `GET /api/admin/anni/[annoSedeId]/cruscotto`
 * (4.7.6) e la pagina «Anno prossimo» (4.7.3): i tre compiti si parlano SOLO attraverso questo file, che dopo lo scheletro non si
 * tocca. Modulo PURO: nessun import, lo leggono route e client.
 *
 * Tutti numeri e nomi di sezione (il nome di una sezione non è un dato personale). Nessun nome di bambino, nessun codice fiscale.
 * Le frequenze considerate sono sempre quelle VIVE (`in_attesa`, `iscritto`) dell'anno nuovo. Gli importi sono in euro, con due
 * decimali, già numeri (la funzione SQL li arrotonda).
 */

export type StatoAnnoSede = 'in_preparazione' | 'iscrizioni_aperte' | 'corrente' | 'in_chiusura' | 'chiuso'

export interface CruscottoSezione {
  /** `null` = le frequenze vive dell'anno senza sezione. */
  section_id: string | null
  nome: string | null
  fascia: string | null
  iscritti: number
}

export interface CruscottoFascia {
  /** Una fascia vera, oppure `senza_sezione` / `senza_fascia` (le frequenze che non l'hanno). Come `anno_conta_posti`. */
  fascia: string
  iscritti: number
  /** `null` = nessun posto dichiarato per quella fascia. */
  posti: number | null
  /** Vero se gli iscritti superano i posti: un avviso, mai un blocco. */
  oltre: boolean
}

export interface CruscottoQuota {
  /** Vive con la voce `pagato`. */
  saldate: number
  /** Vive con una voce collegata non ancora saldata (da pagare, parziale, scaduta, tornata indietro). */
  da_pagare: number
  /** Vive senza voce collegata (mai generata, eliminata, oppure con più voci da sistemare a mano). */
  assenti: number
  /** Fra le assenti: quelle per cui il listino non ha una riga con importo (la quota non si può generare). Mai in euro. */
  senza_listino: number
  euro_incassati: number
  euro_da_incassare: number
  /** STIMA dal listino per le assenti con una riga di listino: dichiarata tale in pagina, mai sommata ad altro. */
  euro_assenti_stimati: number
  /** Frequenze RITIRATE dell'anno nuovo che hanno ancora una voce collegata: la famiglia la vede, la segreteria no. */
  ritirati_con_voce: number
  /** Quanto è stato incassato su quelle voci. */
  euro_ritirati_incassati: number
}

export interface CruscottoIncrocio {
  /** Hanno consegnato i moduli ma la quota non è saldata. */
  moduli_senza_quota: number
  /** Hanno saldato la quota ma mancano moduli. */
  quota_senza_moduli: number
  entrambi: number
  nessuno_dei_due: number
  /** La somma delle quattro caselle: tutte le frequenze vive dell'anno nuovo. */
  totale: number
  /** Vive senza voce collegata per cui `anno_quota_voce` direbbe «più voci»: da sistemare in contabilità. Non è una casella. */
  piu_voci: number
}

export interface CruscottoConfrontoAnno {
  domande: number
  conferme: number
}

export interface CruscottoConfronto {
  /** Vero se le conferme dell'anno prima non hanno una data vera (tutte `recupero`) e sono ricostruite da altre date. */
  ricostruito: boolean
  /** `AAAA-MM-GG`: lo stesso giorno, un anno prima. */
  giorno_anno_prima: string
  anno_prima_etichetta: string
  questo_anno: CruscottoConfrontoAnno
  anno_prima: CruscottoConfrontoAnno
}

export interface CruscottoAnno {
  anno: { inizio: string; fine: string; stato: StatoAnnoSede }
  sezioni: CruscottoSezione[]
  fasce: CruscottoFascia[]
  risposte: {
    confermati: number
    no: number
    non_risposto: number
    /** Le frequenze vive dell'anno attivo della sede: i bambini che devono rispondere. */
    di_partenza: number
  }
  /** Le nuove iscrizioni: vive dell'anno nuovo con `tipo = 'nuova'` oppure di chi non frequenta nell'anno attivo. */
  nuove: { totale: number }
  quota: CruscottoQuota
  incrocio: CruscottoIncrocio
  /** `null` se la sede non ha un anno precedente. */
  confronto: CruscottoConfronto | null
}
