// =============================================================================
// LE TRACCE DI UN DOCENTE — la parte che il PANNELLO legge, e SOLO quella.
//
// ⚠️ PERCHÉ QUESTO FILE ESISTE, separato da `tracce-docente.ts`.
// Non è un'organizzazione più bella: è un vincolo del bundler, ed è lo stesso che
// `src/lib/gdpr/cosa-distrugge-voci.ts` ha già pagato il 2026-08-13. Il pannello
// che mostra l'anteprima è un componente client; `tracce-docente.ts` importa
// `logger` → `app-log` → `supabase/server-client`, che nel browser non può
// esistere. Tenendo le due cose insieme, l'intera catena del server finisce nel
// bundle del client e `npm run build` fallisce.
//
// La regola per chi aggiunge roba qui: in questo file entrano solo DATI, TIPI e
// FUNZIONI PURE. Nessun import che tocchi Supabase, il logger o `next/headers`.
//
// `tracce-docente.ts` le RI-ESPORTA tutte, così route, pannello e lock importano
// da un posto solo e non devono sapere che lo split esiste.
// =============================================================================

// =============================================================================
// A CHE COSA SERVE — decidere se un docente si CANCELLA o si ARCHIVIA, e dirlo
// PRIMA di farlo.
//
// ─── IL FATTO DA CUI NASCE ──────────────────────────────────────────────────
//
// `utenti.id` è FK verso `auth.users(id)` con `ON DELETE CASCADE`, e 58 chiavi
// esterne puntano a `utenti(id)`. Una cancellazione vera quindi:
//   • viene RIFIUTATA da Postgres se esiste una riga su una FK `NO ACTION`
//     (diario, presenze, valutazioni, registro, firme, pagamenti…);
//   • RIESCE, dove non ci sono, portandosi via a cascata conversazioni con le
//     famiglie (`chat_threads`, `chat_messages`), avvisi pubblicati e foto di
//     bambini (`galleria_media_v2`).
//
// ⚠️ IL SECONDO CASO È IL PIÙ PERICOLOSO, perché non dà errore. È la ragione per
// cui una voce `cascade` può PESARE quanto una che blocca: `src/lib/gdpr/
// account-oblio.ts:47-59` ha già deciso questo caso per iscritto e in senso
// contrario — non tenta nemmeno la cancellazione quando ci sono thread di chat o
// risposte agli avvisi, perché «una conversazione è di due persone».
//
// ─── PERCHÉ UN REGISTRO DICHIARATIVO E NON UN ELENCO DENTRO LA ROUTE ────────
//
// Perché un elenco dentro una route invecchia in silenzio. Il lock
// `__tests__/architecture/tracce-docente-dichiarate.test.ts` confronta questo
// registro con le FK vere della fotografia delle migrazioni: una chiave esterna
// nuova, o una `ON DELETE` cambiata, rende rosso finché qualcuno non dichiara se
// quella riga pesa. Senza, il giorno in cui nasce una tabella nuova l'anteprima
// direbbe «si cancella» su un docente che non si cancella — oppure, peggio, lo
// cancellerebbe portandosi via una cosa che nessuno aveva censito.
//
// ⚠️ Qui NON si esegue e non si legge niente: questo modulo DICHIARA e DECIDE
// su conteggi già fatti. Le `SELECT` stanno in `tracce-docente.ts`.
// =============================================================================

/**
 * Che cosa fa Postgres alla riga collegata quando l'account sparisce.
 *
 * Ricalca `confdeltype` di `pg_constraint`: `c` → cascade, `n` → set-null,
 * `r`/`a` → blocca (RESTRICT e NO ACTION, per noi, sono la stessa cosa: la
 * DELETE viene rifiutata).
 */
export type AzioneFk = 'cascade' | 'set-null' | 'blocca'

/**
 * Una chiave esterna verso `utenti(id)`, e la risposta alla sola domanda che
 * conta: **questa riga è una traccia del lavoro di quella persona?**
 *
 * `pesa` e le due descrizioni sono in esclusione reciproca, e il lock lo
 * pretende: una voce che pesa porta la `chiave` con cui la si racconta
 * all'operatore, una che non pesa porta il `perche` — perché «non conta» è
 * un'affermazione che va motivata, non un valore di default.
 */
export interface VoceTraccia {
  tabella: string
  colonna: string
  azioneFk: AzioneFk
  pesa: boolean
  /** Chiave del catalogo `adminAltro` (it + en in parità). Se e solo se `pesa`. */
  chiave?: string
  /** Perché NON è una traccia. Se e solo se non `pesa`. */
  perche?: string
}

/**
 * IL REGISTRO — tutte e 58 le FK verso `utenti(id)`, misurate da `pg_constraint`
 * il 2026-09-20 (56) e il 2026-09-25 (+2: i due `eliminato_da` del cestino del
 * registro e del fascicolo). Non dai file di migrazione: ricostruirle dai `.sql`
 * ne trova ~46, e le dieci che mancano sono esattamente quelle che nessuno si
 * ricorda.
 */
export const TRACCE_DOCENTE: VoceTraccia[] = [
  // ───────────────────────────────────────────────────────────────────────────
  // NON PESANO — roba di servizio di cui l'account è l'unico titolare, oppure
  // assegnazioni correnti che la procedura sgancia da sé prima di agire.
  //
  // ⚠️ Le quattro righe qui sotto sono la correzione più importante di questo
  // registro, e l'ha trovata la misura sui dati veri, non il ragionamento:
  // contare `pratiche_personale.utente_id` come traccia rendeva indelebili
  // **67 docenti su 80**, cioè quasi tutti, e per il motivo sbagliato — quella
  // riga è l'ATTO DI NASCITA del loro account, non una cosa che hanno fatto. E
  // la procedura di cancellazione la elimina comunque.
  // ───────────────────────────────────────────────────────────────────────────
  {
    tabella: 'pratiche_personale',
    colonna: 'utente_id',
    azioneFk: 'blocca',
    pesa: false,
    perche:
      "È la pratica da cui è NATO questo account, non una cosa che la persona ha fatto: la porta il 67 docenti su 80. La procedura la cancella prima di toccare l'account.",
  },
  {
    tabella: 'candidature_insegnanti',
    colonna: 'utente_id',
    azioneFk: 'blocca',
    pesa: false,
    perche: "La sua stessa candidatura. Come sopra: è l'origine dell'account, non il suo lavoro.",
  },
  {
    tabella: 'anagrafica_personale',
    colonna: 'utente_id',
    azioneFk: 'cascade',
    pesa: false,
    perche:
      'Il suo fascicolo del personale, 1:1 con l\'account. La procedura lo cancella per primo, file compresi.',
  },
  {
    tabella: 'utenti_sezioni',
    colonna: 'utente_id',
    azioneFk: 'cascade',
    pesa: false,
    perche:
      "Assegnazione corrente alle classi, non una traccia: dice che cosa vede OGGI, non che cosa ha fatto. La procedura la sgancia prima di agire.",
  },
  {
    tabella: 'utenti_sezioni_materie',
    colonna: 'utente_id',
    azioneFk: 'cascade',
    pesa: false,
    perche: 'Assegnazione corrente (contitolarità primaria), come `utenti_sezioni`.',
  },
  {
    tabella: 'utenti_scuole',
    colonna: 'utente_id',
    azioneFk: 'cascade',
    pesa: false,
    perche: 'Ponte multi-plesso: assegnazione corrente, sganciata dalla procedura.',
  },
  {
    tabella: 'orario_settimanale',
    colonna: 'docente_id',
    azioneFk: 'set-null',
    pesa: false,
    perche:
      "Assegnazione corrente all'orario. `SET NULL` non blocca, e la procedura la azzera: un orario che nomina una maestra che non c'è più è sbagliato, e non se ne accorgerebbe nessuno.",
  },
  {
    tabella: 'task_interni',
    colonna: 'assigned_to',
    azioneFk: 'set-null',
    pesa: false,
    perche: 'Assegnazione corrente di un compito interno, azzerata dalla procedura.',
  },
  {
    tabella: 'notifiche',
    colonna: 'utente_id',
    azioneFk: 'cascade',
    pesa: false,
    perche: 'Le campanelle indirizzate a lei. Servizio: nessun altro le perde.',
  },
  {
    tabella: 'push_subscriptions',
    colonna: 'utente_id',
    azioneFk: 'cascade',
    pesa: false,
    perche: 'I suoi dispositivi registrati per le notifiche. Servizio.',
  },
  {
    tabella: 'student_guardians',
    colonna: 'utenti_id',
    azioneFk: 'set-null',
    pesa: false,
    perche:
      "Terza tabella ponte, scritta nel luglio 2026 e MAI LETTA da `src/` (34 righe ferme). Non è la canonica, e `SET NULL` non blocca.",
  },
  {
    // ⚠️ NON è una traccia da insegnante, ma NON è nemmeno innocua: decide un
    // esito a sé. Se questa persona è l'accesso di una famiglia, l'eliminazione
    // non si offre affatto — vedi `decisioneEliminazione`.
    tabella: 'legame_genitori_alunni',
    colonna: 'genitore_id',
    azioneFk: 'blocca',
    pesa: false,
    perche:
      "Il legame con i suoi figli: non è lavoro da insegnante, è la sua vita da genitore. Decide l'esito `profilo-doppio`, non l'archiviazione.",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PESANO PUR ESSENDO `cascade` — la DELETE riesce e distrugge in silenzio.
  // Sono le voci per cui questo registro esiste.
  // ───────────────────────────────────────────────────────────────────────────
  {
    tabella: 'chat_threads',
    colonna: 'teacher_id',
    azioneFk: 'cascade',
    pesa: true,
    chiave: 'tracciaDocenteChatThreadDocente',
  },
  {
    tabella: 'chat_threads',
    colonna: 'parent_id',
    azioneFk: 'cascade',
    pesa: true,
    chiave: 'tracciaDocenteChatThreadGenitore',
  },
  {
    tabella: 'chat_messages',
    colonna: 'sender_id',
    azioneFk: 'cascade',
    pesa: true,
    chiave: 'tracciaDocenteChatMessaggi',
  },
  {
    tabella: 'avvisi',
    colonna: 'author_id',
    azioneFk: 'cascade',
    pesa: true,
    chiave: 'tracciaDocenteAvvisi',
  },
  {
    tabella: 'avvisi_risposte',
    colonna: 'parent_id',
    azioneFk: 'cascade',
    pesa: true,
    chiave: 'tracciaDocenteAvvisiRisposte',
  },
  {
    tabella: 'galleria_media_v2',
    colonna: 'uploaded_by',
    azioneFk: 'cascade',
    pesa: true,
    chiave: 'tracciaDocenteFotoCaricate',
  },
  {
    tabella: 'task_interni',
    colonna: 'author_id',
    azioneFk: 'cascade',
    pesa: true,
    chiave: 'tracciaDocenteTaskCreati',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // IL REGISTRO E LA VALUTAZIONE — `blocca`: la DELETE viene rifiutata.
  // ───────────────────────────────────────────────────────────────────────────
  {
    // ⚠️ PER PRIMA, ed è la traccia più frequente e la meno visibile: ogni route
    // che passa da `logScrittura` ne lascia una. Si accende su 58 docenti su 80.
    tabella: 'audit_scritture_docente',
    colonna: 'attore_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteAuditScritture',
  },
  {
    tabella: 'eventi_diario',
    colonna: 'maestra_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteDiario',
  },
  {
    tabella: 'presenze',
    colonna: 'registrato_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocentePresenzeRegistrate',
  },
  {
    tabella: 'presenze',
    colonna: 'giust_vista_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteGiustificheViste',
  },
  {
    tabella: 'presenze',
    colonna: 'utente_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocentePresenzeProprie',
  },
  {
    tabella: 'valutazioni',
    colonna: 'maestra_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteValutazioni',
  },
  {
    tabella: 'pagelle',
    colonna: 'generata_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocentePagelle',
  },
  {
    tabella: 'scrutini',
    colonna: 'chiuso_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteScrutiniChiusi',
  },
  {
    tabella: 'scrutini',
    colonna: 'pubblicato_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteScrutiniPubblicati',
  },
  {
    tabella: 'scrutinio_giudizi',
    colonna: 'proposto_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteGiudiziProposti',
  },
  {
    tabella: 'allegati_registro',
    colonna: 'caricato_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteAllegatiRegistro',
  },
  {
    // Censita il 2026-09-25 (PR-B dei sei interventi), dalla fotografia rigenerata
    // dopo l'apply di `20260924220000_primaria_modifica_elimina.sql`. È CHI HA
    // MESSO L'ALLEGATO NEL CESTINO (7 giorni, poi la purga notturna). Pesa per la
    // stessa ragione di `galleria_media_v2.eliminato_da`: eliminare un allegato
    // del registro è un atto di lavoro sul registro di una classe, non servizio
    // dell'account. E `SET NULL` qui NON è innocuo: finché la riga sta nel
    // cestino, cancellare l'account toglierebbe la risposta a «chi l'ha tolto?»
    // proprio nella finestra in cui la si può ancora ripristinare.
    tabella: 'allegati_registro',
    colonna: 'eliminato_da',
    azioneFk: 'set-null',
    pesa: true,
    chiave: 'tracciaDocenteAllegatiEliminati',
  },
  {
    tabella: 'registro_modifiche',
    colonna: 'utente_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteRegistroModifiche',
  },
  {
    tabella: 'sblocchi_audit',
    colonna: 'dirigente_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteSblocchi',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // I DOCUMENTI E I FASCICOLI DEI BAMBINI
  // ───────────────────────────────────────────────────────────────────────────
  {
    tabella: 'fascicolo_accessi_audit',
    colonna: 'utente_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteAccessiFascicolo',
  },
  {
    tabella: 'student_documents',
    colonna: 'caricato_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteDocumentiAlunni',
  },
  {
    // Censita il 2026-09-25 insieme ad `allegati_registro.eliminato_da`, con la
    // stessa migrazione e la stessa ragione: è chi ha messo nel cestino un
    // documento del FASCICOLO di un bambino. Un atto sul fascicolo è lavoro, e
    // sui dati più delicati che il registro conservi; `SET NULL` cancellerebbe
    // l'autore dell'eliminazione mentre il documento è ancora ripristinabile.
    tabella: 'student_documents',
    colonna: 'eliminato_da',
    azioneFk: 'set-null',
    pesa: true,
    chiave: 'tracciaDocenteDocumentiEliminati',
  },
  {
    tabella: 'firme_documenti',
    colonna: 'utente_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteFirme',
  },
  {
    tabella: 'galleria_media',
    colonna: 'caricato_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteFotoV1',
  },
  {
    tabella: 'galleria_media_v2',
    colonna: 'eliminato_da',
    azioneFk: 'set-null',
    pesa: true,
    chiave: 'tracciaDocenteFotoEliminate',
  },
  {
    tabella: 'video_intents',
    colonna: 'owner_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteVideoIntenti',
  },
  {
    tabella: 'video_jobs',
    colonna: 'owner_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteVideoLavorazioni',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // SOLDI — qui `SET NULL` non è innocuo: una riga di cassa che perde chi l'ha
  // registrata resta, e smette di poter rispondere alla domanda «chi ha preso
  // quei contanti?».
  // ───────────────────────────────────────────────────────────────────────────
  {
    tabella: 'incassi',
    colonna: 'registrato_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteIncassi',
  },
  {
    tabella: 'pagamenti',
    colonna: 'creato_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocentePagamenti',
  },
  {
    tabella: 'pagamenti_quote',
    colonna: 'adult_id',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteQuote',
  },
  {
    tabella: 'cassa_movimenti',
    colonna: 'registrato_da',
    azioneFk: 'set-null',
    pesa: true,
    chiave: 'tracciaDocenteCassaMovimenti',
  },
  {
    tabella: 'cassa_chiusure',
    colonna: 'eseguita_da',
    azioneFk: 'set-null',
    pesa: true,
    chiave: 'tracciaDocenteCassaChiusure',
  },
  {
    tabella: 'fatture_visibilita_audit',
    colonna: 'verificata_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteFattureAudit',
  },
  {
    tabella: 'fatture_visibilita_revisioni',
    colonna: 'verificata_da',
    azioneFk: 'set-null',
    pesa: true,
    chiave: 'tracciaDocenteFattureRevisioni',
  },
  {
    tabella: 'mensa_prenotazioni',
    colonna: 'prenotato_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteMensa',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // SEGRETERIA — pratiche evase, domande gestite, decisioni prese. Sono lavoro
  // fatto SU qualcun altro, e per questo pesano (a differenza della propria
  // pratica d'origine, qui sopra fra le voci che non pesano).
  // ───────────────────────────────────────────────────────────────────────────
  {
    tabella: 'pratiche_personale',
    colonna: 'evasa_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocentePraticheEvase',
  },
  {
    tabella: 'candidature_insegnanti',
    colonna: 'evasa_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteCandidatureEvase',
  },
  {
    tabella: 'candidature_insegnanti',
    colonna: 'etichetta_aggiornata_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteCandidatureEtichette',
  },
  {
    tabella: 'candidature_sedi',
    colonna: 'evasa_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteCandidatureSedi',
  },
  {
    tabella: 'anagrafica_personale',
    colonna: 'aggiornata_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteAnagraficheAggiornate',
  },
  {
    tabella: 'form_submissions',
    colonna: 'gestita_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteModuliGestiti',
  },
  {
    tabella: 'iscrizioni_decisioni',
    colonna: 'decisa_da',
    azioneFk: 'set-null',
    pesa: true,
    chiave: 'tracciaDocenteIscrizioniDecise',
  },
  {
    tabella: 'iscrizioni_elenco_caricamenti',
    colonna: 'caricato_da',
    azioneFk: 'set-null',
    pesa: true,
    chiave: 'tracciaDocenteIscrizioniCaricamenti',
  },
  {
    tabella: 'eventi_agenda',
    colonna: 'creato_da',
    azioneFk: 'blocca',
    pesa: true,
    chiave: 'tracciaDocenteAgenda',
  },
]

/** Le sole voci che decidono l'esito. Comoda, e usata anche dal lock. */
export const VOCI_CHE_PESANO = TRACCE_DOCENTE.filter((v) => v.pesa)

/**
 * Che cosa RESTA dopo un'archiviazione, e va detto nello stesso riquadro.
 *
 * Stessa ragione di `OBLIO_RESTA`: un elenco di conseguenze senza contrappeso è
 * metà informazione. Chi archivia una maestra si sta chiedendo «perderò il
 * registro delle sue presenze?», e la risposta deve stare lì.
 */
export const ARCHIVIAZIONE_MANTIENE = [
  'archiviazioneMantieneRegistro',
  'archiviazioneMantieneValutazioni',
  'archiviazioneMantieneChat',
  'archiviazioneMantieneAudit',
]

// =============================================================================
// LA DECISIONE
// =============================================================================

/**
 * L'esito di UNA voce, in DUE campi e non in uno.
 *
 * ⚠️ Separarli non è pignoleria: sono due domande diverse con due conseguenze
 * diverse. «C'è almeno una riga?» decide; «quante sono?» si limita a raccontarlo
 * a schermo. Tenerli insieme costringeva a usare `n === null` per due stati che
 * non si somigliano — «la sonda è fallita, non so niente» e «so che la traccia
 * c'è ma non sono riuscito a contarla» — e il secondo diventava così un
 * `non-deciso`, cioè un comando negato su un'informazione che AVEVAMO.
 */
export interface ConteggioVoce {
  tabella: string
  colonna: string
  /** C'è almeno una riga? `null` = la sonda è fallita: su questo non si decide. */
  ce: boolean | null
  /** Quante, quando si è potuto contare. `null` = «non misurato», mai zero. */
  n: number | null
}

export type Decisione = 'cancella' | 'archivia' | 'profilo-doppio' | 'non-deciso'

export interface EsitoTracce {
  /** Un conteggio per ogni voce che pesa. */
  voci: ConteggioVoce[]
  /** Esiste il ponte `parents.auth_user_id`? `null` = non letto. */
  ponteGenitore: boolean | null
}

export interface Verdetto {
  decisione: Decisione
  /** Le voci che hanno pesato, con i loro conteggi: è il «perché» a schermo. */
  motivi: ConteggioVoce[]
}

/**
 * DECIDE, e non esegue niente.
 *
 * ⚠️ L'ORDINE DELLE DOMANDE È LA COSA IMPORTANTE, ed è stato sbagliato una volta
 * prima di essere misurato. Mettendo il ponte genitore PRIMA delle tracce, tutti
 * e 12 i docenti che sono anche genitori diventavano `profilo-doppio` — compresi
 * i nove che insegnano davvero, ai quali veniva così negata anche
 * l'ARCHIVIAZIONE, che su di loro è sicura: archiviare revoca il profilo di
 * `utenti.ruolo`, non l'accesso della persona, e la mamma continua a vedere il
 * diario di suo figlio. Il ponte deve bloccare la sola CANCELLAZIONE.
 *
 * Misurato in produzione il 2026-09-20 su 80 docenti, con quest'ordine:
 * **69 `archivia`, 8 `cancella`, 3 `profilo-doppio`**. Con l'ordine sbagliato:
 * 66 / 2 / 12.
 */
export function decisioneEliminazione(esito: EsitoTracce): Verdetto {
  // 1. Una sola SONDA fallita e si smette. «Non ho potuto leggere» non è «non
  //    c'è», e una decisione presa su una lettura fallita è una decisione
  //    inventata. Si guarda `ce`, non `n`: un conteggio mancato su una traccia
  //    che sappiamo esserci non toglie niente alla decisione, toglie solo il
  //    numero da mostrare.
  const nonLette = esito.voci.filter((v) => v.ce === null)
  if (nonLette.length > 0 || esito.ponteGenitore === null) {
    return { decisione: 'non-deciso', motivi: nonLette }
  }

  // 2. Le tracce vengono PRIMA del ponte: vedi il commento qui sopra.
  const motivi = esito.voci.filter((v) => v.ce === true)
  if (motivi.length > 0) return { decisione: 'archivia', motivi }

  // 3. Nessuna traccia, ma questo account è l'accesso di una famiglia alle
  //    schede dei figli. Non si offre nessuna eliminazione: si rimanda a
  //    «Trasforma in genitore», che è l'operazione che questa persona vuole.
  if (esito.ponteGenitore) return { decisione: 'profilo-doppio', motivi: [] }

  return { decisione: 'cancella', motivi: [] }
}
