import type { CanaleVideo } from '../contratto'

/**
 * LE PORTE DEL RUNNER — tutto ciò che il runner non sa fare da sé.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ INIETTATE, e non importate direttamente.
 *
 * Questo modulo orchestra tre cose che in locale non esistono: una MicroVM di
 * Vercel, lo Storage di Supabase e cinque RPC su un database che punta alla
 * produzione. Se il runner le importasse, l'unico posto in cui si potrebbe
 * collaudare sarebbe la produzione — cioè, in pratica, da nessuna parte: l'E2E qui
 * è vietato in locale perché `.env.local` punta al database vero, e un Sandbox non
 * si apre per far girare un test.
 *
 * Con le porte, la LOGICA di orchestrazione (chi vince, che cosa si ferma, in che
 * ordine, con quale codice d'errore) si prova con dei doppi e senza rete. Resta da
 * provare in un Sandbox vero soltanto l'ADATTAMENTO — che `sh` interpreti gli
 * script come crediamo e che le firme dell'SDK siano quelle che pensiamo — ed è una
 * superficie piccola, tutta in `adattatori.ts`, invece di essere sparsa ovunque.
 *
 * ⚠️ È anche il punto in cui un collaudo può mentire a sé stesso: un doppio piatto
 * è verde con e senza la correzione. Ogni doppio di questi test conta qualcosa
 * (quante volte, in che ordine, con quale argomento) e i numeri attesi si ricavano
 * dalla logica, non si copiano dall'implementazione.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ────────────────────────────────────────────────────────────────────────────
 * IL JOB, come lo restituiscono le RPC
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * La riga di `video_jobs` che le RPC incapsulano in `{"ok":true,"job":…}`.
 *
 * Solo i campi che il runner usa davvero. Non è pigrizia: dichiarare qui l'intera
 * tabella vorrebbe dire tenerne allineate due copie, e la copia che conta è quella
 * in `20260916190000_video_jobs.sql`.
 */
export interface JobVideo {
  id: string
  owner_id: string
  scuola_id: string | null
  channel: CanaleVideo
  intent_id: string
  status: string
  original_bucket: string
  original_path: string
  source_size: number | null
  source_mime: string | null
  attempt: number
  fence_epoch: number
}

/** La forma di risposta comune a tutte le RPC di `*_video_*.sql`. */
export type EsitoRpcVideo =
  | { ok: true; job: JobVideo }
  | { ok: false; code: string }

/**
 * Quel poco che serve al battito: se il database ha detto di sì, e se no perché.
 *
 * Più stretto di `EsitoRpcVideo` di proposito. La sorveglianza non ha niente da
 * fare con la riga del job, e chiederla costringerebbe ogni doppio a fabbricarne
 * una — cioè a scrivere venti campi irrilevanti per provare un contatore.
 */
export type EsitoBattito = { ok: true } | { ok: false; code: string }

/* ────────────────────────────────────────────────────────────────────────────
 * LA CODA — le RPC di coordinamento
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Le cinque RPC che il runner chiama, e nessun'altra.
 *
 * `video_job_uploaded` e `video_job_cancel` non sono qui: la prima appartiene al
 * bordo dell'upload, la seconda alla persona che cambia idea. Un worker che
 * potesse chiamarle avrebbe più potere di quanto il suo mestiere richieda.
 */
export interface CodaVideo {
  /**
   * I job ancora `processing` con la lease di QUESTO worker: una `SELECT`, non una RPC.
   *
   * È il pezzo che rende durevole il disegno. Una conversione può durare più di
   * un'invocazione; quando il tetto dell'invocazione scade, il job resta
   * `processing` con la lease viva, e `video_job_next` — che pesca solo i `queued` e
   * i `processing` con lease SCADUTA — non lo restituirebbe mai. Senza questa
   * lettura, il lavoro andrebbe avanti nella MicroVM fino in fondo e nessuno
   * scriverebbe mai l'esito: alla scadenza della lease il job verrebbe ripreso da
   * capo, con un fence nuovo, e la conversione appena finita buttata via.
   */
  miei(leaseOwner: string): Promise<{ ok: true; jobs: JobVideo[] } | { ok: false; motivo: string }>
  /** `video_job_next(p_lease_owner, p_lease_seconds)`. */
  prossimo(leaseOwner: string, leaseSeconds: number): Promise<EsitoRpcVideo>
  /**
   * `video_job_claim(p_job_id, p_lease_owner, p_lease_seconds)`, usata solo per RIPRENDERE.
   *
   * Con lo stesso `lease_owner` e la lease ancora viva la RPC è idempotente: non
   * incrementa `attempt` né `fence_epoch` e restituisce la fotografia della prima
   * acquisizione. È esattamente ciò che serve — stesso fence ⇒ stesso nome di
   * Sandbox ⇒ `Sandbox.get` riaggancia la MicroVM che sta già convertendo.
   */
  riprendi(jobId: string, leaseOwner: string, leaseSeconds: number): Promise<EsitoRpcVideo>
  /** `video_job_heartbeat(p_job_id, p_fence_epoch, p_lease_owner)`. */
  battito(jobId: string, fenceEpoch: number, leaseOwner: string): Promise<EsitoRpcVideo>
  /** `video_job_ready(p_job_id, p_fence_epoch, p_lease_owner, p_output_path, p_output_size, p_probe_json)`. */
  pronto(p: {
    jobId: string
    fenceEpoch: number
    leaseOwner: string
    percorsoUscita: string
    byteUscita: number
    probe: unknown
  }): Promise<EsitoRpcVideo>
  /** `video_job_fail(p_job_id, p_fence_epoch, p_lease_owner, p_error_code, p_rejected)`. */
  fallito(p: {
    jobId: string
    fenceEpoch: number
    leaseOwner: string
    codice: string
    rifiutato: boolean
  }): Promise<EsitoRpcVideo>
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'ARCHIVIO — lo Storage privato
 * ──────────────────────────────────────────────────────────────────────────── */

export type EsitoArchivio =
  | { ok: true; url: string }
  | { ok: false; motivo: string }

/**
 * Lo Storage, visto dal runner: due indirizzi firmati, e nient'altro.
 *
 * ⚠️ NON si legge né si scrive il file DA QUI. Un originale arriva a 2 GB e
 * un'uscita pure: farli passare per la lambda vorrebbe dire tenerli in memoria, e
 * comunque non ci starebbero nei 300 secondi di una singola invocazione. Il file va
 * da Supabase alla MicroVM e ritorno, direttamente; questa porta consegna solo i
 * due indirizzi con cui farlo.
 *
 * ⚠️ E QUEGLI INDIRIZZI SONO SEGRETI. Un URL firmato porta dentro un JWT che
 * autorizza a leggere o a scrivere l'oggetto: non finisce in un log, non finisce in
 * un messaggio d'errore, e non finisce negli argomenti di un comando — dove
 * resterebbe visibile a un `ps` dentro la MicroVM e a chiunque legga il comando
 * dalla console di Vercel. Si passano per variabile d'ambiente del comando, ed è il
 * motivo per cui gli script del runner si scrivono con `"$KV_…"` invece che con
 * l'URL interpolato.
 */
export interface ArchivioVideo {
  /** Indirizzo firmato in LETTURA dell'originale, valido `secondi`. */
  urlLettura(bucket: string, percorso: string, secondi: number): Promise<EsitoArchivio>
  /** Indirizzo firmato in SCRITTURA per l'uscita di questo tentativo. */
  urlScrittura(bucket: string, percorso: string): Promise<EsitoArchivio>
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL SANDBOX
 * ──────────────────────────────────────────────────────────────────────────── */

export interface EsitoComando {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Un lavoro staccato che vive dentro la MicroVM anche se questo processo muore.
 *
 * ⚠️ NON è l'oggetto `Command` dell'SDK, ed è una scelta. L'handle di un comando
 * avviato vive nella memoria dell'invocazione che l'ha avviato: un'invocazione
 * successiva — quella che riaggancia il Sandbox per nome dopo che la prima è finita
 * per esaurimento del proprio tetto — non ce l'ha più. Se la sorveglianza
 * dipendesse da quell'handle, riprendere sarebbe impossibile e ogni conversione
 * più lunga di un'invocazione andrebbe rifatta da capo.
 *
 * Perciò «ha finito?» è una domanda che si fa al FILESYSTEM della MicroVM: lo
 * script di conversione scrive un marcatore come ultima cosa che fa, e chiunque
 * abbia il Sandbox in mano — questa invocazione o quella fra due minuti — lo legge
 * allo stesso modo.
 */
export interface ComandoInCorso {
  /** `null` finché gira, l'esito quando ha finito. Una andata e ritorno, non un'attesa. */
  esito(): Promise<EsitoComando | null>
  /** Lo ferma. Chiamata quando il job non è più nostro o il tetto di tempo è scaduto. */
  termina(): Promise<void>
}

/**
 * La MicroVM. `apri` riaggancia quella che esiste già con quel nome, o ne crea una.
 *
 * Il riaggancio è ciò che rende durevole questo disegno senza un orchestratore
 * esterno: una conversione di dieci minuti sopravvive alla fine dell'invocazione
 * che l'ha avviata, e un'altra invocazione la ritrova per nome. Il nome porta
 * dentro il `fence_epoch` proprio perché quel «ritrovare» non diventi «rubare»
 * (vedi `nomeSandboxVideo`).
 */
export interface MacchinaSandbox {
  apri(p: {
    nome: string
    regione: string
    vcpus: number
    tettoMs: number
  }): Promise<SessioneSandbox>
}

/**
 * Un comando dentro la MicroVM: eseguibile e argomenti, MAI una riga di shell.
 *
 * ⚠️ È il motivo per cui questa forma esiste. Gli argomenti di `buildVideoEncodeArgs`
 * contengono già apici singoli — il filtergraph della Galleria scrive
 * `overlay=x='(main_w-overlay_w)/2'` — e un video caricato da un genitore non ha mai
 * un nome che finisce in una riga di comando, ma il principio vale lo stesso:
 * appiattire un array in una stringa significa inventarsi un quoting, e un quoting
 * inventato è una falla che si manifesta sul caso strano, cioè in produzione.
 * Qui l'array arriva a `execve` così com'è.
 *
 * Per gli script si usa `conShell()`, che è l'unico posto in cui una stringa diventa
 * un comando — e lo fa con `sh -c`, non con un'interpolazione.
 */
export interface ComandoSandbox {
  cmd: string
  args: string[]
  /**
   * ⚠️ È QUI CHE PASSANO GLI URL FIRMATI, e non fra gli `args`. Un URL firmato porta
   * un JWT: fra gli argomenti sarebbe leggibile con un `ps` dentro la MicroVM e
   * comparirebbe nella console di Vercel accanto al comando.
   */
  env?: Record<string, string>
  tettoMs: number
}

/** L'unico punto in cui una stringa diventa un comando. `sh -c`, mai interpolazione. */
export function conShell(script: string): { cmd: string; args: string[] } {
  return { cmd: 'sh', args: ['-c', script] }
}

export interface SessioneSandbox {
  /** Esegue e aspetta. Per i passi brevi: apparecchio, lettura del marcatore. */
  esegui(comando: ComandoSandbox): Promise<EsitoComando>
  /**
   * Stacca il comando e ritorna subito. Non restituisce niente da sorvegliare: chi
   * sorveglia guarda il marcatore (vedi `ComandoInCorso`), perché è l'unica cosa
   * che sopravvive alla fine di questa invocazione.
   */
  avvia(comando: ComandoSandbox): Promise<void>
  /** Spegne la MicroVM. Va chiamata comunque vada, altrimenti si paga a vuoto. */
  ferma(): Promise<void>
  /** Vero se la MicroVM è stata appena creata; falso se è stata riagganciata per nome. */
  readonly nuova: boolean
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'OROLOGIO
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il tempo, iniettato. Non è pedanteria: senza, l'unico modo di provare che il
 * battito rispetta il suo periodo sarebbe far aspettare il collaudo per davvero —
 * cinque minuti per una asserzione, con l'esito che dipende da quanto è carica la
 * macchina. Con l'orologio finto, gli stessi cinque minuti sono un numero.
 */
export interface Orologio {
  adesso(): number
  pausa(ms: number): Promise<void>
}
