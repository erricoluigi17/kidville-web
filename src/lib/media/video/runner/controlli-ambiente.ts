import { ENV_URL_FFPROBE } from './preparazione'

/**
 * I CONTROLLI CHE SI FANNO ALL'IMMAGINE QUANDO SI COSTRUISCE LO SNAPSHOT — gli strumenti e la rete (PR 2, secondario #166).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PERCHÉ ESISTONO
 *
 * `scripts/video-sandbox-ambiente.mjs` costruiva lo snapshot controllando due cose: che i due binari di FFmpeg abbiano le
 * impronte attese e che sappiano fare ciò che serve (l'inventario). Nessuna delle due dice che l'IMMAGINE sotto di loro abbia
 * il resto: gli script del runner (`script.ts`, `preparazione.ts`) danno per scontati una quindicina di comandi di sistema —
 * `awk`, `grep`, `xargs`, `stat -c`, `pkill` — e una rete che arrivi al bucket. Un'immagine a cui ne manca uno costruisce
 * uno snapshot che SEMBRA a posto e fa fallire OGNI conversione, e fallisce nel modo peggiore: il ripiego sulla provvista
 * dal bucket scatta solo con l'uscita 26 (i binari che non tornano), quindi un `grep` che manca non ripiega, non si accorge
 * nessuno e i quattro tentativi di ogni job finiscono tutti `failed`. Il 02/10 era stato misurato che `curl` mancava
 * (`wget`, `xz` e `dnf` pure) ed è per quello che lo snapshot lo installa; di `pkill`, `awk` e `grep` non c'è nessuna misura.
 *
 * Questi controlli si fanno UNA volta, nel Sandbox che costruisce lo snapshot, PRIMA di scattarlo. Se qualcosa non torna lo
 * script si ferma e dice che cosa: costa un minuto di una MicroVM, invece di una giornata di conversioni fallite.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COSA NON PROVANO
 *
 *  · Non provano che una MicroVM NATA dallo snapshot abbia lo stesso ambiente di quella che lo ha costruito, né che
 *    `ffprobe` — che ha il suo client HTTPS dentro il binario statico — riesca a leggere un URL firmato. Lo prova una
 *    conversione vera da uno snapshot nuovo, PRIMA di impostare `VIDEO_SANDBOX_SNAPSHOT_ID` (T16 della PR 2).
 *  · L'esistenza di un comando non è la sua versione: `stat -c` e `xargs -a` sono GNU, e su Ubuntu ci sono; su un'immagine
 *    BusyBox potrebbero esistere e non capire l'opzione. L'immagine è Ubuntu (`vercel/sandbox/node:24`), ed è per quello che
 *    qui si guarda l'esistenza e basta.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COME RESTA ALLINEATO AGLI SCRIPT
 *
 * L'elenco qui sotto è scritto a mano, e un elenco a mano invecchia: il giorno in cui qualcuno aggiunge un `sed` a
 * `script.ts` lo snapshot continuerebbe a passare i controlli. Per questo `__tests__/lib/video-runner-ambiente.test.ts`
 * ricava i comandi dagli script veri, su tutti i loro rami, e cade se ne trova uno che qui non c'è (e se qui ce n'è uno che
 * nessuno script usa più).
 *
 * Il modulo è PURO e leggero apposta — non importa il logger né l'SDK — perché lo carica anche lo script di costruzione, sotto
 * Node senza bundler (`scripts/lib/risolvi-alias.mjs`), che con `ambiente.ts` non riuscirebbe a partire.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/* ────────────────────────────────────────────────────────────────────────────
 * GLI STRUMENTI
 * ──────────────────────────────────────────────────────────────────────────── */

export interface StrumentoDellAmbiente {
  /** Il nome del comando, com'è negli script. */
  nome: string
  /** Il pacchetto Debian/Ubuntu che lo porta: serve al messaggio, per dire che cosa installare. */
  pacchetto: string
}

/**
 * I comandi che gli script del runner chiamano e che NON sono dentro la shell: in ordine alfabetico, ciascuno col pacchetto
 * che lo porta su Ubuntu.
 *
 * Non ci sono `echo`, `printf`, `test`, `trap`, `exit` e `true` (sono interni di `sh`: ci sono sempre), né `ffmpeg` e `ffprobe`
 * (li verificano le impronte e l'inventario), né `id`, `sudo` e `apt-get` (li usa lo script di costruzione e li prova già
 * ogni suo passo).
 *
 * `curl` e `sha256sum` compaiono anche se la costruzione li usa già: a runtime li chiamano la provvista del ripiego e la
 * conversione, e un'immagine nuova che non li avesse è esattamente il caso che questo elenco deve prendere.
 */
export const STRUMENTI_DELL_AMBIENTE: readonly StrumentoDellAmbiente[] = [
  { nome: 'awk', pacchetto: 'mawk o gawk' },
  { nome: 'cat', pacchetto: 'coreutils' },
  { nome: 'chmod', pacchetto: 'coreutils' },
  { nome: 'curl', pacchetto: 'curl' },
  { nome: 'grep', pacchetto: 'grep' },
  { nome: 'gzip', pacchetto: 'gzip' },
  { nome: 'mkdir', pacchetto: 'coreutils' },
  { nome: 'mv', pacchetto: 'coreutils' },
  { nome: 'node', pacchetto: 'nodejs' },
  { nome: 'pkill', pacchetto: 'procps' },
  { nome: 'rm', pacchetto: 'coreutils' },
  { nome: 'sha256sum', pacchetto: 'coreutils' },
  { nome: 'stat', pacchetto: 'coreutils' },
  { nome: 'tail', pacchetto: 'coreutils' },
  { nome: 'tr', pacchetto: 'coreutils' },
  { nome: 'wc', pacchetto: 'coreutils' },
  { nome: 'xargs', pacchetto: 'findutils' },
]

/**
 * La forma di un nome di comando. Il nome entra in una riga di shell: qualunque cosa fuori da lettere, cifre e `._+-` (uno
 * spazio, un `;`, un `$`) vorrebbe dire un comando in più, e questa funzione non deve poterlo scrivere nemmeno per errore.
 */
const FORMA_NOME_STRUMENTO = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/**
 * Il comando che chiede all'immagine «ci sono tutti?». Scrive `MANCA <nome>` per OGNI strumento assente (non si ferma al
 * primo: chi costruisce ne installa tre insieme, non uno per volta) ed esce 1 se ne manca anche uno solo, 0 altrimenti.
 *
 * `command -v` è POSIX e dice «trovato» per ciò che `sh` riesce a eseguire con quel nome: per gli strumenti dell'elenco, che non
 * sono interni alla shell, un file eseguibile nel `PATH`. Il `PATH` è quello con cui girano i comandi del runner, perché si
 * esegue nello stesso modo (`sh -c`, senza `sudo`).
 */
export function scriptControlloStrumenti(strumenti: readonly StrumentoDellAmbiente[] = STRUMENTI_DELL_AMBIENTE): string {
  for (const { nome } of strumenti) {
    if (!FORMA_NOME_STRUMENTO.test(nome)) throw new TypeError(`nome di strumento non valido: ${JSON.stringify(nome)}`)
  }
  return [
    'MANCANO=0',
    `for STRUMENTO in ${strumenti.map((s) => s.nome).join(' ')}; do`,
    '  if ! command -v "$STRUMENTO" > /dev/null 2>&1; then',
    '    echo "MANCA $STRUMENTO"',
    '    MANCANO=1',
    '  fi',
    'done',
    'exit $MANCANO',
  ].join('\n')
}

/**
 * Legge l'uscita di `scriptControlloStrumenti`: i nomi degli strumenti che mancano, senza doppioni, nell'ordine in cui sono
 * stati scritti. Una riga che non ha la forma `MANCA <nome>` non conta: l'uscita di un comando non è un dato di cui fidarsi.
 */
export function strumentiMancanti(stdout: string): string[] {
  const nomi: string[] = []
  for (const riga of (typeof stdout === 'string' ? stdout : '').split('\n')) {
    const trovato = /^MANCA ([A-Za-z0-9][A-Za-z0-9._+-]*)\s*$/.exec(riga)
    if (trovato !== null && !nomi.includes(trovato[1])) nomi.push(trovato[1])
  }
  return nomi
}

/**
 * Il messaggio per chi costruisce lo snapshot: che cosa manca, con il pacchetto che lo porta e dove si aggiunge. Mai un testo
 * che sia dentro uno stdout (`MANCA …` è già stato letto): i nomi vengono dall'elenco, e uno che l'elenco non conosce si dice
 * com'è, senza pacchetto.
 */
export function messaggioStrumentiMancanti(
  mancanti: readonly string[],
  strumenti: readonly StrumentoDellAmbiente[] = STRUMENTI_DELL_AMBIENTE,
): string {
  const elenco = mancanti
    .map((nome) => {
      const noto = strumenti.find((s) => s.nome === nome)
      return noto === undefined ? nome : `${nome} (pacchetto ${noto.pacchetto})`
    })
    .join(', ')
  return (
    `nell'immagine mancano strumenti che gli script del runner chiamano: ${elenco}. ` +
    'Senza, lo snapshot farebbe fallire ogni conversione e il runner non ripiegherebbe: si aggiungono ai pacchetti che ' +
    'lo script installa con apt-get (accanto a curl), e si ricostruisce'
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA RETE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il comando che prova la rete dell'immagine verso il bucket: una richiesta HEAD sull'URL firmato di un oggetto di
 * `video_build`, come quella che l'apparecchio fa sull'originale (`curl -fsSI`, stessi tentativi e stessi tetti).
 *
 * Prova in un colpo solo il DNS (il nome del servizio si risolve), il TLS (i certificati dell'immagine bastano a fidarsi del
 * servizio: senza `ca-certificates` curl esce 60) e l'autorizzazione dell'URL firmato (`-f` fa fallire un 4xx). Una HEAD non
 * scarica il corpo — l'oggetto è un binario da decine di megabyte —, quindi non conta quanto sia grande.
 *
 * ⚠️ L'indirizzo entra dall'AMBIENTE (`KV_URL_FFPROBE`, lo stesso nome della provvista), mai negli argomenti: un URL firmato
 * in una riga di comando si legge con un `ps` dentro la MicroVM e compare nella console di Vercel. L'uscita di `curl` va a
 * `/dev/null` (le intestazioni non servono), e `-sS` lascia a stderr solo l'errore, che di norma non porta l'indirizzo (e lo
 * script di costruzione toglie comunque ogni URL da ciò che stampa).
 *
 * Esce con lo stato di `curl`, tale e quale (`|| exit $?`), perché `spiegaUscitaDellaRete` lo legge: 6 è il DNS, 60 i
 * certificati, 22 un rifiuto del servizio.
 */
export function scriptControlloRete(): string {
  return [
    'set -eu',
    `: "\${${ENV_URL_FFPROBE}:?}"`,
    `curl -fsSI --retry 3 --retry-all-errors --connect-timeout 10 --max-time 30 "$${ENV_URL_FFPROBE}" > /dev/null || exit $?`,
  ].join('\n')
}

/**
 * Che cosa vuol dire, per chi costruisce lo snapshot, l'uscita di `scriptControlloRete`: lo stato di `curl`, in parole. I
 * codici sono quelli documentati di `curl` (6 DNS, 7 connessione, 22 errore HTTP, 28 tempo scaduto, 35/51/58/59/60/77/82/83/
 * 90/91 per TLS e certificati); un numero che non si conosce si dice com'è.
 */
export function spiegaUscitaDellaRete(uscita: number): string {
  switch (uscita) {
    case 6:
      return 'il nome del servizio non si risolve (DNS)'
    case 7:
      return 'il servizio non accetta la connessione (rete assente o bloccata)'
    case 22:
      return "il servizio risponde con un errore HTTP: l'URL firmato è stato rifiutato (scaduto?) o l'oggetto non c'è"
    case 28:
      return 'tempo scaduto: il servizio non risponde'
    case 35:
    case 51:
    case 58:
    case 59:
    case 60:
    case 77:
    case 82:
    case 83:
    case 90:
    case 91:
      return "la connessione sicura (TLS) non si stabilisce: i certificati dell'immagine mancano o non bastano (ca-certificates)"
    case 127:
      return 'curl non si trova'
    default:
      return `curl è uscito con ${uscita}`
  }
}
