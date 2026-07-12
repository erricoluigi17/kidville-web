// =============================================================================
// Catalogo canonico dei TIPI di notifica (client-safe: nessun import server).
// Single source of truth per: pannello Impostazioni → Notifiche (toggle admin)
// e gate server-side isNotificaAbilitata() (src/lib/notifiche/config.ts).
// Chiave = valore della colonna `notifiche.tipo`. Toggle assente = ATTIVA.
// =============================================================================

export type GruppoNotifica = 'genitore' | 'docente' | 'staff'

export interface TipoNotifica {
  /** Etichetta mostrata nel pannello impostazioni. */
  label: string
  /** Gruppo di destinatari prevalente (solo per l'organizzazione della UI). */
  gruppo: GruppoNotifica
  descrizione?: string
  /** Notifica di sicurezza: disattivarla è sconsigliato (warning in UI). */
  sicurezza?: boolean
}

/** Tipi varianti che condividono il toggle del tipo canonico. */
export const TIPO_ALIAS: Record<string, string> = {
  nota_firma: 'nota',
}

export const TIPI_NOTIFICA: Record<string, TipoNotifica> = {
  // ── Genitore ───────────────────────────────────────────────────────────────
  avviso: {
    label: 'Avvisi e circolari',
    gruppo: 'genitore',
    descrizione: 'Quando la scuola pubblica un avviso destinato alla famiglia',
  },
  consenso_uscita: {
    label: 'Consensi uscite e gite',
    gruppo: 'genitore',
    descrizione: 'Quando viene richiesta l’adesione a un’uscita didattica',
  },
  modulo_da_compilare: {
    label: 'Moduli da compilare',
    gruppo: 'genitore',
    descrizione: 'Quando viene pubblicato un modulo o consenso da firmare',
  },
  modulo_promemoria: {
    label: 'Promemoria moduli non compilati',
    gruppo: 'genitore',
    descrizione: 'Sollecito automatico dopo i giorni impostati in Modulistica',
  },
  chat_genitore: {
    label: 'Chat: nuovo messaggio',
    gruppo: 'genitore',
    descrizione: 'Quando docente o segreteria scrivono in chat al genitore',
  },
  diario: {
    label: 'Diario 0-6 aggiornato',
    gruppo: 'genitore',
    descrizione: 'Pappa, nanna, cambio e note della giornata',
  },
  compiti: {
    label: 'Compiti e lezioni',
    gruppo: 'genitore',
    descrizione: 'Quando il docente registra lezione o compiti assegnati',
  },
  nota: {
    label: 'Note disciplinari',
    gruppo: 'genitore',
    descrizione: 'Quando viene inserita una nota (incluse quelle da firmare)',
  },
  valutazione: {
    label: 'Valutazioni',
    gruppo: 'genitore',
    descrizione: 'Quando il docente inserisce una nuova valutazione',
  },
  pagella: {
    label: 'Pagella pubblicata',
    gruppo: 'genitore',
    descrizione: 'Quando la pagella o i giudizi vengono pubblicati',
  },
  assenza_non_comunicata: {
    label: 'Assenza all’appello',
    gruppo: 'genitore',
    descrizione:
      'Primaria: se il figlio risulta assente senza assenza comunicata. 0-6: a ogni assenza segnata',
    sicurezza: true,
  },
  giustifica_vista: {
    label: 'Giustifica presa in visione',
    gruppo: 'genitore',
    descrizione: 'Quando il docente segna la giustifica come vista',
  },
  agenda_evento: {
    label: 'Eventi in agenda',
    gruppo: 'genitore',
    descrizione: 'Quando viene creato un evento visibile alle famiglie',
  },
  galleria: {
    label: 'Nuove foto in galleria',
    gruppo: 'genitore',
    descrizione: 'Quando vengono pubblicate foto della sezione del figlio',
  },
  locker_richiesta: {
    label: 'Richiesta materiale armadietto',
    gruppo: 'genitore',
    descrizione: 'Quando la scuola chiede di portare materiale (pannolini, cambio…)',
  },
  pagamento: {
    label: 'Solleciti di pagamento',
    gruppo: 'genitore',
    descrizione: 'Solleciti di morosità (livelli 1-3)',
  },
  pagamento_emesso: {
    label: 'Nuova retta o rata emessa',
    gruppo: 'genitore',
    descrizione: 'Quando la segreteria genera un nuovo dovuto',
  },
  pagamento_registrato: {
    label: 'Pagamento registrato',
    gruppo: 'genitore',
    descrizione: 'Quando un pagamento viene registrato e la ricevuta è disponibile',
  },
  sospensione_morosita: {
    label: 'Sospensione per morosità',
    gruppo: 'genitore',
    descrizione: 'Comunicazione formale di sospensione del servizio',
  },
  mensa_ricarica: {
    label: 'Ricarica ticket mensa',
    gruppo: 'genitore',
    descrizione: 'Conferma della ricarica del carnet pasti',
  },
  mensa_saldo_basso: {
    label: 'Saldo mensa in esaurimento',
    gruppo: 'genitore',
    descrizione: 'Quando i ticket mensa residui scendono sotto la soglia',
  },
  merch_arrivato: {
    label: 'Merchandise arrivato',
    gruppo: 'genitore',
    descrizione: 'Quando il materiale ordinato è disponibile per il ritiro',
  },
  merch_consegnato: {
    label: 'Merchandise consegnato',
    gruppo: 'genitore',
    descrizione: 'Conferma di consegna del materiale ordinato',
  },
  iscrizione_esito: {
    label: 'Esito iscrizione',
    gruppo: 'genitore',
    descrizione: 'Quando la domanda di iscrizione viene accolta o respinta',
  },
  credenziali: {
    label: 'PDF credenziali pronto',
    gruppo: 'staff',
    descrizione: 'Quando il PDF delle credenziali rigenerate è pronto per il download',
  },
  panic_alert: {
    label: 'Panic alert',
    gruppo: 'genitore',
    descrizione: 'Tentativo di ritiro non autorizzato: notifica a genitori e staff',
    sicurezza: true,
  },

  // ── Docente ────────────────────────────────────────────────────────────────
  chat_docente: {
    label: 'Chat: nuovo messaggio',
    gruppo: 'docente',
    descrizione: 'Quando un genitore scrive in chat al docente',
  },
  assenza_comunicata: {
    label: 'Assenza comunicata dal genitore',
    gruppo: 'docente',
    descrizione: 'Quando un genitore comunica in anticipo un’assenza',
  },
  giustifica_ricevuta: {
    label: 'Giustifica ricevuta',
    gruppo: 'docente',
    descrizione: 'Quando un genitore giustifica un’assenza o richiede entrata/uscita',
  },
  firma_ricevuta: {
    label: 'Firma del genitore ricevuta',
    gruppo: 'docente',
    descrizione: 'Quando un genitore firma una nota o una pagella',
  },
  avviso_risposta: {
    label: 'Risposte agli avvisi',
    gruppo: 'docente',
    descrizione: 'Prese visione e adesioni dei genitori ai tuoi avvisi',
  },
  task_assegnato: {
    label: 'Incarico assegnato',
    gruppo: 'docente',
    descrizione: 'Quando ti viene assegnato un incarico interno',
  },
  segreteria_scrittura: {
    label: 'Scritture della segreteria',
    gruppo: 'docente',
    descrizione: 'Quando la segreteria aggiorna il registro della tua classe',
  },
  locker_scorte: {
    label: 'Scorte armadietto basse',
    gruppo: 'docente',
    descrizione: 'Quando il materiale della sezione scende sotto la soglia',
  },

  // ── Staff / Segreteria ────────────────────────────────────────────────────
  mensa_allergia: {
    label: 'Allergene nel menu del giorno',
    gruppo: 'staff',
    descrizione: 'Quando il menu contiene un allergene di un alunno presente',
    sicurezza: true,
  },
  allergie_aggiornate: {
    label: 'Allergie aggiornate dal genitore',
    gruppo: 'staff',
    descrizione: 'Quando un genitore modifica le allergie del figlio',
  },
  modulo_compilato: {
    label: 'Modulo compilato ricevuto',
    gruppo: 'staff',
    descrizione: 'Quando un genitore invia un modulo o consenso firmato',
  },
  iscrizione_ricevuta: {
    label: 'Nuova domanda di iscrizione',
    gruppo: 'staff',
    descrizione: 'Quando arriva una pre-iscrizione dal form pubblico',
  },
  onboarding_completato: {
    label: 'Onboarding genitore completato',
    gruppo: 'staff',
    descrizione: 'Quando un genitore completa la registrazione iniziale',
  },
  fattura_scartata: {
    label: 'Fattura scartata (SDI)',
    gruppo: 'staff',
    descrizione: 'Quando lo SDI scarta una fattura elettronica',
  },
  documenti_scadenza: {
    label: 'Documenti in scadenza',
    gruppo: 'staff',
    descrizione: 'Quando un documento di un alunno scade entro 30 giorni',
  },
}

/** Risolve eventuali alias sul tipo canonico del catalogo. */
export function tipoCanonico(tipo: string): string {
  return TIPO_ALIAS[tipo] ?? tipo
}
