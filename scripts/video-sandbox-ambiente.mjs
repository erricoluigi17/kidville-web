#!/usr/bin/env node
// =============================================================================
// L'AMBIENTE PRONTO DEL RUNNER VIDEO — costruisce lo SNAPSHOT del Sandbox
//
// Dalla PR 2 il runner che converte i video può partire da uno snapshot invece che da una
// MicroVM vuota: un'immagine `node:24` (Ubuntu) con `curl` e con i due binari di FFmpeg già in
// `/opt/kv-ffmpeg`. Una conversione che nasce da lì verifica i binari con `sha256sum` e parte,
// senza scaricare ~134 MB dal bucket a ogni video. Perché, e come ripiega se lo snapshot non c'è:
// `src/lib/media/video/runner/ambiente.ts` (testata) e la spec
// `docs/superpowers/specs/2026-10-02-video-pr2-pubblicazione-server-design.md` (§10.1).
//
// Questo script è l'UNICO modo di fabbricarlo. Lo esegue chi rilascia (T16 della PR 2), non l'app:
// crea un Sandbox VERO su Vercel, quindi costa (pochi minuti di una MicroVM) e produce una risorsa
// che resta (snapshot senza scadenza). Per vedere che cosa farebbe senza spendere niente: `--a-secco`.
//
// ─── COME SI USA ─────────────────────────────────────────────────────────────
//
// La chiave di servizio di Supabase NON sta in `.env.local` (quella non è del progetto) e non si passa
// mai da riga di comando: si legge da STDIN, dentro il JSON che la CLI già autenticata stampa — come in
// `scripts/ffmpeg-nel-bucket.mjs`. Serve solo a firmare due URL di lettura sul bucket privato
// `video_build`, validi pochi minuti.
//
//   supabase projects api-keys --project-ref uimulkjyekgemjakmepp -o json \
//     | node scripts/video-sandbox-ambiente.mjs
//
//   … --a-secco              non apre nessun Sandbox e non tocca la rete: stampa il piano
//   … --regione dub1         la regione (predefinita dub1, dove sta lo Storage)
//   … --vcpus 4              i core della MicroVM che costruisce lo snapshot (predefiniti 4)
//
// Le credenziali VERCEL sono quelle della CLI già autenticata, come nelle prove F1/F2 della PR 1: il
// token sta in `auth.json` della CLI (o in `VERCEL_TOKEN`), il progetto e il team in
// `.vercel/project.json`. Se il token è scaduto lo script lo dice e si rinnova con `vercel whoami`.
//
// ─── COSA FA, IN ORDINE ──────────────────────────────────────────────────────
//
//   1. crea un Sandbox da `vercel/sandbox/node:24` nella regione scelta;
//   2. installa `curl` e `ca-certificates` con `apt-get`, UNA volta, adesso: a runtime nessun comando
//      installa niente (la MicroVM nata dallo snapshot ha già `curl`, e le serve per il ripiego);
//   3. controlla l'IMMAGINE (secondario #166): che ci siano gli STRUMENTI che gli script del runner danno per
//      scontati — `awk`, `grep`, `xargs`, `stat`, `pkill`… — e che la RETE arrivi al bucket (una HEAD
//      sull'URL firmato di un oggetto di `video_build`: DNS, TLS, autorizzazione). Elenco e comandi stanno in
//      `src/lib/media/video/runner/controlli-ambiente.ts`. Un'immagine a cui ne manca uno costruirebbe uno
//      snapshot che sembra a posto e fa fallire OGNI conversione senza ripiegare (il ripiego scatta solo con
//      l'uscita 26): qui lo script si ferma, PRIMA di scaricare 134 MB, e dice che cosa manca. I due URL firmati
//      (validi 10 minuti) nascono qui, DOPO `apt-get` e subito prima della rete e della provvista (secondario #179);
//   4. prepara `/opt/kv-ffmpeg` (con `sudo`, una volta) e lo affida all'utente dei comandi;
//   5. fa la provvista dei binari dal bucket con lo STESSO script del runtime — `scriptPreparazioneBuild`,
//      importato da `src/`, non copiato qui — dentro `/opt/kv-ffmpeg`: scarica, verifica le impronte dei due
//      `.gz`, decomprime, verifica le impronte dei due binari, e solo allora li rende eseguibili;
//   6. chiede ai binari l'inventario (filtri, decoder, encoder) e rifiuta lo snapshot se manca qualcosa
//      (`mancanzeDellaBuild`): le impronte dicono che i binari sono quelli attesi, non che sappiano fare
//      ciò che serve;
//   7. esegue la verifica che il runner rifà a OGNI avvio (`scriptVerificaBinari`): se non passa qui, non
//      passerebbe mai laggiù;
//   8. chiama `snapshot({ expiration: 0 })` (senza scadenza: l'identificativo non deve scadere sotto i piedi
//      del runner) e stampa l'id, le impronte e la regione.
//
// Se uno qualunque dei passi fallisce, il Sandbox si FERMA (non si lascia una MicroVM accesa a `GB × ore`) e
// lo script esce 1 senza aver creato nessuno snapshot.
//
// Che cosa NON prova: che una MicroVM nata dallo snapshot si comporti come questa (la rete di `ffprobe`, che ha
// il suo client HTTPS dentro il binario, è l'esempio) — lo prova una conversione vera dallo snapshot nuovo,
// PRIMA di impostare la variabile (T16 della PR 2).
//
// ─── COSA SI FA CON L'ESITO ──────────────────────────────────────────────────
//
// Lo script stampa `VIDEO_SANDBOX_SNAPSHOT_ID=<id>`: è il valore della variabile d'ambiente da impostare su
// Vercel (Production e Preview) PRIMA del merge — vedi `docs/env.md`. Uno snapshot nuovo non toglie il vecchio:
// quando la variabile punta al nuovo e il runner l'ha usato, il vecchio si può cancellare.
//
// ─── COSA NON STAMPA MAI ─────────────────────────────────────────────────────
//
// Né la chiave di servizio, né il token Vercel, né un URL (firmato o no), né un `token=…`. NIENTE esce da qui
// se non passa da `scrivi` / `scriviErrore`, che tolgono ogni segreto noto e ogni forma di segreto: un lock
// (`__tests__/lib/video-runner-ambiente.test.ts`) legge questo file e prova che non esiste un altro modo di
// scrivere, ed esegue lo script `--a-secco` con una chiave finta per vedere che non esca.
//
// Il repository è PUBBLICO: nessun segreto qui dentro, solo il riferimento del progetto Supabase (un
// identificatore, non una credenziale).
// =============================================================================

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { register } from 'node:module'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── Il codice di `src/` che si CONDIVIDE, non si copia ──────────────────────
//
// `scriptPreparazioneBuild` e `scriptVerificaBinari` sono funzioni TypeScript del runner: lo script le
// importa con l'hook di risoluzione che gli script di questo repo usano per leggere `src/` (stesso meccanismo
// di `scripts/anteprima-email.mjs`; richiede una Node che toglie i tipi da sola, 22.18 o superiore). Copiare qui
// gli script di shell vorrebbe dire due testi destinati a divergere il giorno in cui qualcuno ne ritocca uno solo:
// uno snapshot costruito con le verifiche di ieri e un runner che ne fa di oggi.
//
// ⚠️ L'hook si registra SOLO quando il file è lanciato da `node`. Importato da un test (che costruisce con un Sandbox
// finto: vedi `costruisci`) ci pensa già il bundler del test a risolvere `src/`, e un secondo risolutore dentro il
// processo del test non serve a niente. Lo stesso controllo decide, in fondo al file, se far partire `main`.
function eseguitoDaRigaDiComando() {
  const lanciato = process.argv[1]
  if (typeof lanciato !== 'string' || !existsSync(lanciato)) return false
  return realpathSync(lanciato) === realpathSync(fileURLToPath(import.meta.url))
}
const daRigaDiComando = eseguitoDaRigaDiComando()
if (daRigaDiComando) register('./lib/risolvi-alias.mjs', import.meta.url)

const { BUCKET_BUILD_VIDEO, CARTELLA_BINARI_NELLO_SNAPSHOT, FFMPEG_SHA256, FFPROBE_SHA256, PERCORSO_FFMPEG_GZ, PERCORSO_FFPROBE_GZ } =
  await import('../src/lib/media/video/build.ts')
const {
  ENV_URL_FFMPEG,
  ENV_URL_FFPROBE,
  comandoInventarioBuild,
  inventarioDellaBuild,
  mancanzeDellaBuild,
  scriptPreparazioneBuild,
} = await import('../src/lib/media/video/runner/preparazione.ts')
const { scriptVerificaBinari } = await import('../src/lib/media/video/runner/script.ts')
const {
  STRUMENTI_DELL_AMBIENTE,
  messaggioStrumentiMancanti,
  scriptControlloRete,
  scriptControlloStrumenti,
  spiegaUscitaDellaRete,
  strumentiMancanti,
} = await import('../src/lib/media/video/runner/controlli-ambiente.ts')

/* ────────────────────────────────────────────────────────────────────────────
 * Le costanti dello script
 * ──────────────────────────────────────────────────────────────────────────── */

const RIFERIMENTO_PROGETTO_SUPABASE = 'uimulkjyekgemjakmepp'
const URL_PROGETTO_SUPABASE = `https://${RIFERIMENTO_PROGETTO_SUPABASE}.supabase.co`

/** L'immagine da cui si parte: Ubuntu con Node 24, quella che il runner userà sotto lo snapshot. */
const IMMAGINE_DEL_SANDBOX = 'vercel/sandbox/node:24'
const REGIONE_PREDEFINITA = 'dub1'
const VCPUS_PREDEFINITI = 4

/** Quanto dura la MicroVM che costruisce lo snapshot: mezz'ora, molto più del necessario (la provvista è ~10 s). */
const TETTO_SANDBOX_MS = 30 * 60 * 1000
/** Gli indirizzi firmati servono UNA volta, subito: dieci minuti. */
const SECONDI_FIRMA = 10 * 60

/** I tetti dei singoli comandi. Corti: se un passo si pianta, lo script lo dice invece di aspettare mezz'ora. */
const TETTO_APT_MS = 5 * 60 * 1000
const TETTO_PROVVISTA_MS = 3 * 60 * 1000
const TETTO_BREVE_MS = 60 * 1000
/**
 * La prova della rete fa fino a quattro tentativi di `curl` (`--max-time 30` ciascuno, più le attese di 1, 2 e 4 s fra
 * l'uno e l'altro): nel caso peggiore ~127 s. Il tetto sta sopra, perché si legga l'uscita di `curl` (28, tempo scaduto)
 * e non un 137 del Sandbox che uccide il comando (secondario #178; prima era 90 s).
 */
const TETTO_RETE_MS = 150 * 1000

const USO = `Uso:
  <JSON di \`supabase projects api-keys --project-ref ${RIFERIMENTO_PROGETTO_SUPABASE} -o json\`> \\
    | node scripts/video-sandbox-ambiente.mjs [--a-secco] [--regione dub1] [--vcpus 4]`

/** Errore di utilizzo: esce 2. */
export class ErroreUso extends Error {}
/** Un controllo che non torna: esce 1, e il messaggio è già scritto per essere letto. */
export class ErroreKO extends Error {}

/* ────────────────────────────────────────────────────────────────────────────
 * L'USCITA: l'unico posto da cui qualcosa esce, e l'unico che toglie i segreti
 * ──────────────────────────────────────────────────────────────────────────── */

/** Ogni valore che è un segreto e che lo script ha mai avuto in mano: la chiave, il token, gli URL. */
const segreti = new Set()

/** Registra un segreto: da quel momento nessuna riga che lo contiene esce com'è. */
function ricorda(segreto) {
  if (typeof segreto === 'string' && segreto.length >= 8) segreti.add(segreto)
  return segreto
}

/**
 * Toglie da un testo tutto ciò che non deve mai arrivare a un terminale: i segreti registrati, ogni JWT, ogni
 * chiave `sb_…`, ogni `token=…`, ogni URL.
 */
function senzaSegreti(testo) {
  let pulito = String(testo ?? '')
  for (const segreto of segreti) pulito = pulito.split(segreto).join('[segreto]')
  return pulito
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    .replace(/\bsb_(?:secret|publishable)_[\w-]+/g, '[chiave]')
    .replace(/\b(?:token|signature|apikey|api_key)=[^&\s"']+/gi, '[credenziale]')
    .replace(/https?:\/\/\S+/gi, '[url]')
}

/** L'UNICA scrittura su stdout. */
function scrivi(riga = '') {
  process.stdout.write(`${senzaSegreti(riga)}\n`)
}

/** L'UNICA scrittura su stderr. */
function scriviErrore(riga = '') {
  process.stderr.write(`${senzaSegreti(riga)}\n`)
}

/** Come si descrive un errore dell'SDK senza dire più del dovuto: stato e messaggio ripulito. */
function descriviErrore(errore) {
  if (!errore) return 'errore sconosciuto'
  const stato = errore?.response?.status ?? errore?.status ?? errore?.statusCode
  return senzaSegreti(`${stato ? `HTTP ${stato}: ` : ''}${errore?.message ?? errore?.name ?? errore}`)
}

const sha256 = (testo) => createHash('sha256').update(testo).digest('hex')

/* ────────────────────────────────────────────────────────────────────────────
 * Funzioni pure: argomenti, piano, scelta della chiave
 * ──────────────────────────────────────────────────────────────────────────── */

export function leggiArgomenti(argv) {
  const opzioni = { aSecco: false, regione: REGIONE_PREDEFINITA, vcpus: VCPUS_PREDEFINITI }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--a-secco') opzioni.aSecco = true
    else if (arg === '--regione') {
      const valore = argv[(i += 1)]
      if (!valore || !/^[a-z]{3}[0-9]$/.test(valore)) throw new ErroreUso('--regione vuole una regione Vercel (es. dub1)')
      opzioni.regione = valore
    } else if (arg === '--vcpus') {
      const valore = Number(argv[(i += 1)])
      if (!Number.isSafeInteger(valore) || valore < 1 || valore > 8) throw new ErroreUso('--vcpus vuole un intero da 1 a 8')
      opzioni.vcpus = valore
    } else throw new ErroreUso(`argomento non previsto: ${arg}`)
  }
  return opzioni
}

/**
 * Gli script di shell che lo snapshot esegue, TUTTI presi dalle funzioni di `src/` che il runner usa a runtime (la
 * provvista, l'inventario, la verifica) o che `src/` dichiara accanto a loro (i controlli degli strumenti e della rete).
 * Una funzione sola, usata sia dal piano a secco sia dalla costruzione vera: ciò che `--a-secco` mostra è ciò che
 * la costruzione esegue, e non esiste un secondo posto in cui lo script di provvista sia scritto.
 */
export function piano(cartella = CARTELLA_BINARI_NELLO_SNAPSHOT) {
  return {
    cartella,
    provvista: scriptPreparazioneBuild(cartella),
    inventario: comandoInventarioBuild(cartella),
    verifica: scriptVerificaBinari(cartella),
    controlloStrumenti: scriptControlloStrumenti(),
    controlloRete: scriptControlloRete(),
  }
}

/**
 * La chiave di servizio dentro il JSON di `supabase projects api-keys -o json`: per nome (`service_role`),
 * altrimenti per tipo (`secret`). Mai stampata. Restituisce anche COME l'ha trovata (nome o tipo), che è l'unica
 * cosa che si può dire senza dire la chiave.
 */
function sceltaDellaChiave(testoJson) {
  let voci
  try {
    voci = JSON.parse(testoJson)
  } catch {
    throw new ErroreKO('stdin non è JSON: serve l’uscita di `supabase projects api-keys --project-ref … -o json`')
  }
  if (!Array.isArray(voci)) throw new ErroreKO('stdin è JSON ma non è un elenco di chiavi')

  const candidate = voci.filter(
    (voce) => voce && typeof voce === 'object' && typeof voce.api_key === 'string' && voce.api_key !== '',
  )
  const perNome = candidate.find((voce) => voce.name === 'service_role' || voce.id === 'service_role')
  const scelta = perNome ?? candidate.find((voce) => voce.type === 'secret')
  if (!scelta) {
    // Solo nomi e tipi, mai i valori.
    const viste = voci.map((voce) => `${voce?.name ?? '?'}/${voce?.type ?? '?'}`).join(', ')
    throw new ErroreKO(`nessuna chiave di servizio (nome service_role o tipo secret) fra: ${viste || 'nessuna voce'}`)
  }
  // Una chiave `secret` si stampa mascherata senza `--reveal`: la si riconosce dai caratteri.
  if (!/^[A-Za-z0-9._-]+$/.test(scelta.api_key)) {
    throw new ErroreKO('la chiave di servizio sembra mascherata: rilancia `supabase projects api-keys` con --reveal')
  }
  return { chiave: scelta.api_key, trovataPer: perNome ? 'nome' : 'tipo' }
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'I/O: stdin, credenziali Vercel
 * ──────────────────────────────────────────────────────────────────────────── */

async function leggiStdin() {
  const pezzi = []
  for await (const pezzo of process.stdin) pezzi.push(pezzo)
  return Buffer.concat(pezzi).toString('utf8')
}

/**
 * Le credenziali del Sandbox: il token della CLI Vercel già autenticata (o `VERCEL_TOKEN`) e il progetto di
 * `.vercel/project.json`. Come le prove F1/F2 della PR 1. Il token si registra fra i segreti SUBITO.
 */
function leggiCredenzialiVercel() {
  let token = process.env.VERCEL_TOKEN
  if (!token) {
    const cartellaDati =
      platform() === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'))
    const file = join(cartellaDati, 'com.vercel.cli', 'auth.json')
    if (!existsSync(file)) {
      throw new ErroreKO('nessun token Vercel: né VERCEL_TOKEN né l’`auth.json` della CLI (esegui `vercel login`)')
    }
    let auth
    try {
      auth = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new ErroreKO('l’`auth.json` della CLI Vercel non si legge (esegui `vercel login`)')
    }
    token = auth?.token
    const scadenza = Number(auth?.expiresAt)
    if (Number.isFinite(scadenza) && scadenza > 0 && scadenza * (scadenza < 1e12 ? 1000 : 1) < Date.now()) {
      throw new ErroreKO('il token della CLI Vercel è scaduto: esegui `vercel whoami` per rinnovarlo')
    }
  }
  if (typeof token !== 'string' || token === '') throw new ErroreKO('il token Vercel non c’è: esegui `vercel login`')
  ricorda(token)

  const fileProgetto = resolve(import.meta.dirname, '..', '.vercel', 'project.json')
  if (!existsSync(fileProgetto)) throw new ErroreKO('manca `.vercel/project.json`: esegui `vercel link` dalla radice del repo')
  let progetto
  try {
    progetto = JSON.parse(readFileSync(fileProgetto, 'utf8'))
  } catch {
    throw new ErroreKO('`.vercel/project.json` non si legge')
  }
  if (typeof progetto?.projectId !== 'string' || typeof progetto?.orgId !== 'string') {
    throw new ErroreKO('`.vercel/project.json` non porta `projectId` e `orgId`')
  }
  return { token, projectId: progetto.projectId, teamId: progetto.orgId }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Il Sandbox
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Esegue un comando nel Sandbox e lo racconta: titolo, esito, e — se è fallito — la coda dello stderr ripulita.
 * Restituisce l'esito completo. Il comando NON si stampa (potrebbe portare un valore), solo il suo titolo.
 */
async function eseguiPasso(sandbox, titolo, comando) {
  const finito = await sandbox.runCommand(comando)
  const stdout = await finito.stdout()
  const stderr = await finito.stderr()
  if (finito.exitCode === 0) {
    scrivi(`OK  ${titolo}`)
  } else {
    scrivi(`KO  ${titolo}: uscita ${finito.exitCode}`)
    const coda = senzaSegreti(stderr).trim().split('\n').slice(-6).join('\n')
    if (coda) scriviErrore(coda)
  }
  return { exitCode: finito.exitCode, stdout, stderr }
}

function richiedi(esito, spiegazione) {
  if (esito.exitCode !== 0) throw new ErroreKO(spiegazione)
  return esito
}

/** Firma un oggetto del bucket privato `video_build` per pochi minuti, e ne registra l'URL fra i segreti. */
async function firma(supabase, percorso) {
  const { data, error } = await supabase.storage.from(BUCKET_BUILD_VIDEO).createSignedUrl(percorso, SECONDI_FIRMA)
  if (error || !data?.signedUrl) throw new ErroreKO(`firma di ${percorso.split('/').pop()} fallita (${descriviErrore(error)})`)
  ricorda(data.signedUrl)
  // Anche la parte che segue il `?`: è quella che autorizza, e un registro che conoscesse solo l'URL intero la
  // lascerebbe uscire spezzata.
  const dopoIlPunto = data.signedUrl.split('?')[1]
  if (dopoIlPunto) ricorda(dopoIlPunto)
  return data.signedUrl
}

/**
 * Le dipendenze VERE della costruzione: le credenziali Vercel, la chiave di servizio letta da stdin e i due SDK. Sono
 * l'unica parte che tocca il mondo (file della CLI, stdin, rete): `costruisci` le riceve, ed è per questo che un test la
 * esegue con un Sandbox finto — senza spendere una MicroVM — e vede che cosa fa quando all'immagine manca qualcosa.
 */
async function dipendenzeVere() {
  const credenziali = leggiCredenzialiVercel()
  const { chiave } = sceltaDellaChiave(await leggiStdin())
  ricorda(chiave)

  const { createClient } = await import('@supabase/supabase-js')
  const { Sandbox } = await import('@vercel/sandbox')

  const supabase = createClient(URL_PROGETTO_SUPABASE, chiave, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return { credenziali, supabase, Sandbox }
}

/**
 * La costruzione. `dipendenze` è `{ credenziali, supabase, Sandbox }`: nello script vero le dà `dipendenzeVere`, in un
 * test sono doppi (un `Sandbox.create` che restituisce una MicroVM finta, un client Supabase che firma indirizzi inventati).
 */
export async function costruisci(opzioni, pianoDaEseguire, dipendenze) {
  const { cartella, provvista, inventario, verifica, controlloStrumenti, controlloRete } = pianoDaEseguire
  const { credenziali, supabase, Sandbox } = dipendenze

  scrivi(`crea il Sandbox da ${IMMAGINE_DEL_SANDBOX} in ${opzioni.regione} (${opzioni.vcpus} vCPU)…`)
  const sandbox = await Sandbox.create({
    image: IMMAGINE_DEL_SANDBOX,
    name: `kv-ambiente-video-${Date.now()}`,
    region: opzioni.regione,
    resources: { vcpus: opzioni.vcpus },
    timeout: TETTO_SANDBOX_MS,
    persistent: false,
    ...credenziali,
  })

  let snapshotCreato = false
  try {
    // 1. Il sistema operativo: si scrive che cosa è, perché la spec lo dà per Ubuntu 26.04 e un'immagine diversa
    //    cambierebbe ciò che i binari statici trovano.
    const sistema = await eseguiPasso(sandbox, 'sistema operativo', {
      cmd: 'sh',
      args: ['-c', '. /etc/os-release && echo "$PRETTY_NAME $(uname -m)"'],
      timeoutMs: TETTO_BREVE_MS,
    })
    if (sistema.exitCode === 0) scrivi(`    ${sistema.stdout.trim()}`)

    // 2. `curl` e i certificati, con apt, UNA volta.
    richiedi(
      await eseguiPasso(sandbox, 'apt-get update', {
        cmd: 'apt-get',
        args: ['update'],
        sudo: true,
        env: { DEBIAN_FRONTEND: 'noninteractive' },
        timeoutMs: TETTO_APT_MS,
      }),
      'apt-get update non è riuscito: senza i pacchetti non c’è snapshot',
    )
    richiedi(
      await eseguiPasso(sandbox, 'apt-get install curl ca-certificates', {
        cmd: 'apt-get',
        args: ['install', '-y', '--no-install-recommends', 'curl', 'ca-certificates'],
        sudo: true,
        env: { DEBIAN_FRONTEND: 'noninteractive' },
        timeoutMs: TETTO_APT_MS,
      }),
      'l’installazione di curl non è riuscita: senza curl il ripiego del runner non può scaricare',
    )
    const versione = richiedi(
      await eseguiPasso(sandbox, 'curl --version', { cmd: 'curl', args: ['--version'], timeoutMs: TETTO_BREVE_MS }),
      'curl non risponde dopo l’installazione',
    )
    scrivi(`    ${versione.stdout.split('\n')[0]}`)

    // 3. L'IMMAGINE, prima di spenderci sopra una provvista da 134 MB (secondario #166): gli strumenti che gli script del
    //    runner danno per scontati, e la rete verso il bucket. Un'immagine a cui ne manca uno costruirebbe uno snapshot che
    //    sembra a posto e fa fallire ogni conversione senza ripiegare (il ripiego scatta solo con l'uscita 26): si ferma qui,
    //    senza snapshot, e dice che cosa manca. Fail-closed: un controllo che esce ≠ 0 senza dire quale strumento manca
    //    non passa lo stesso.
    const strumenti = await eseguiPasso(sandbox, 'strumenti che gli script del runner chiamano', {
      cmd: 'sh',
      args: ['-c', controlloStrumenti],
      timeoutMs: TETTO_BREVE_MS,
    })
    const mancanti = strumentiMancanti(strumenti.stdout)
    if (strumenti.exitCode !== 0 || mancanti.length > 0) {
      throw new ErroreKO(
        mancanti.length > 0
          ? messaggioStrumentiMancanti(mancanti)
          : `il controllo degli strumenti non è riuscito (uscita ${strumenti.exitCode}): non si sa se l’immagine li ha`,
      )
    }
    scrivi(`    ${STRUMENTI_DELL_AMBIENTE.length} strumenti presenti`)

    // Gli indirizzi firmati valgono dieci minuti: si firmano QUI, dopo `apt-get` (due tetti da 5 minuti) e subito prima
    // della rete e della provvista che li usano (secondario #179). Firmati all'inizio, nel caso peggiore arrivavano scaduti.
    const urlFfmpeg = await firma(supabase, PERCORSO_FFMPEG_GZ)
    const urlFfprobe = await firma(supabase, PERCORSO_FFPROBE_GZ)

    // L'URL firmato entra nell'AMBIENTE del comando, mai negli argomenti; e non si stampa: `eseguiPasso` dice il titolo e,
    // se fallisce, la coda dello stderr, che passa da `senzaSegreti`.
    const reteDelBucket = await eseguiPasso(sandbox, 'rete verso il bucket (DNS, TLS, URL firmato)', {
      cmd: 'sh',
      args: ['-c', controlloRete],
      env: { [ENV_URL_FFPROBE]: urlFfprobe },
      timeoutMs: TETTO_RETE_MS,
    })
    if (reteDelBucket.exitCode !== 0) {
      throw new ErroreKO(
        `la rete dell’immagine verso il bucket non funziona: ${spiegaUscitaDellaRete(reteDelBucket.exitCode)}`,
      )
    }
    scrivi('    il bucket risponde: DNS, TLS e URL firmato')

    // 4. La cartella dei binari, affidata all'utente che esegue i comandi (non a root): a runtime nessun comando
    //    ha bisogno di privilegi, e la verifica dei binari legge come lo stesso utente.
    const uid = richiedi(
      await eseguiPasso(sandbox, 'utente dei comandi (uid)', { cmd: 'id', args: ['-u'], timeoutMs: TETTO_BREVE_MS }),
      'non si legge l’uid dell’utente',
    ).stdout.trim()
    const gid = richiedi(
      await eseguiPasso(sandbox, 'utente dei comandi (gid)', { cmd: 'id', args: ['-g'], timeoutMs: TETTO_BREVE_MS }),
      'non si legge il gid dell’utente',
    ).stdout.trim()
    if (!/^[0-9]+$/.test(uid) || !/^[0-9]+$/.test(gid)) throw new ErroreKO('uid o gid dell’utente non sono numeri')
    richiedi(
      await eseguiPasso(sandbox, `prepara ${cartella}`, {
        cmd: 'sh',
        args: ['-c', `mkdir -p ${cartella} && chown ${uid}:${gid} ${cartella}`],
        sudo: true,
        timeoutMs: TETTO_BREVE_MS,
      }),
      `non si prepara ${cartella}`,
    )

    // 5. La provvista dei binari: lo script del RUNTIME, tale e quale, in `/opt/kv-ffmpeg`. Gli URL firmati entrano
    //    nell'ambiente del comando e in nessun altro posto.
    richiedi(
      await eseguiPasso(sandbox, 'provvista dei binari dal bucket (doppia impronta)', {
        cmd: 'sh',
        args: ['-c', provvista],
        env: { [ENV_URL_FFMPEG]: urlFfmpeg, [ENV_URL_FFPROBE]: urlFfprobe },
        timeoutMs: TETTO_PROVVISTA_MS,
      }),
      'la provvista dei binari non è riuscita (le impronte non tornano, o il bucket non risponde)',
    )

    // 6. L'inventario: i binari sanno fare ciò che il filtergraph di produzione nomina?
    const letto = richiedi(
      await eseguiPasso(sandbox, 'inventario dei binari (filtri, decoder, encoder)', {
        cmd: 'sh',
        args: ['-c', inventario],
        timeoutMs: TETTO_BREVE_MS,
      }),
      'i binari non rispondono all’inventario',
    )
    const mancanze = mancanzeDellaBuild(inventarioDellaBuild(letto.stdout))
    if (mancanze.length > 0) throw new ErroreKO(`la build non ha tutto ciò che serve: mancano ${mancanze.join(', ')}`)
    scrivi('    inventario completo: nessuna mancanza')

    // 7. La verifica che il runner rifà a ogni avvio.
    richiedi(
      await eseguiPasso(sandbox, 'verifica dei binari (quella che il runner fa a ogni avvio)', {
        cmd: 'sh',
        args: ['-c', verifica],
        timeoutMs: TETTO_BREVE_MS,
      }),
      'la verifica dei binari non passa: il runner li scarterebbe a ogni avvio',
    )

    // 8. Le impronte, lette dal disco: se non sono quelle di `build.ts` la verifica sopra non sarebbe passata,
    //    ma si stampano comunque — è ciò che si mette nel rapporto del rilascio.
    const impronte = richiedi(
      await eseguiPasso(sandbox, 'impronte dei binari nello snapshot', {
        cmd: 'sha256sum',
        args: [`${cartella}/ffmpeg`, `${cartella}/ffprobe`],
        timeoutMs: TETTO_BREVE_MS,
      }),
      'sha256sum non risponde',
    )
    const lette = new Map(
      impronte.stdout
        .trim()
        .split('\n')
        .map((riga) => riga.trim().split(/\s+/))
        .map(([hash, percorso]) => [percorso, hash]),
    )
    if (lette.get(`${cartella}/ffmpeg`) !== FFMPEG_SHA256 || lette.get(`${cartella}/ffprobe`) !== FFPROBE_SHA256) {
      throw new ErroreKO('le impronte lette dal disco non sono quelle di build.ts')
    }
    scrivi(`    ffmpeg   ${lette.get(`${cartella}/ffmpeg`)}`)
    scrivi(`    ffprobe  ${lette.get(`${cartella}/ffprobe`)}`)

    // 9. Lo snapshot. Fermare il Sandbox è parte dell'operazione: la MicroVM si spegne per scattarlo.
    scrivi('crea lo snapshot (senza scadenza)…')
    const snapshot = await sandbox.snapshot({ expiration: 0 })
    snapshotCreato = true

    const regioni = Array.isArray(snapshot.regions) ? snapshot.regions : []
    scrivi('')
    scrivi(`snapshot creato: ${snapshot.snapshotId}`)
    scrivi(`  stato     ${snapshot.status}`)
    scrivi(`  regioni   ${regioni.join(', ') || 'non dichiarate'}`)
    scrivi(`  byte      ${snapshot.sizeBytes ?? 'non dichiarati'}`)
    scrivi(`  scadenza  ${snapshot.expiresAt ? snapshot.expiresAt.toISOString() : 'nessuna'}`)
    if (regioni.length > 0 && !regioni.includes(opzioni.regione)) {
      throw new ErroreKO(`lo snapshot non è in ${opzioni.regione} (è in ${regioni.join(', ')}): il runner ripiegherebbe`)
    }
    scrivi('')
    scrivi('Da impostare su Vercel (Production e Preview), PRIMA del merge:')
    scrivi(`VIDEO_SANDBOX_SNAPSHOT_ID=${snapshot.snapshotId}`)
    return 0
  } finally {
    // Se lo snapshot non c'è, la MicroVM è ancora accesa: si ferma, senza che un errore qui copra quello vero.
    if (!snapshotCreato) {
      try {
        await sandbox.stop()
      } catch (errore) {
        scriviErrore(`attenzione: il Sandbox di costruzione non si è fermato (${descriviErrore(errore)})`)
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * --a-secco: il piano, senza rete e senza credenziali
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Stampa che cosa si farebbe, con le impronte (SHA-256) degli script di shell che si eseguirebbero: sono le stesse
 * funzioni di `src/` che il runner usa, e chi le confronta con quelle che calcola a parte vede che non c'è una
 * seconda copia. Se stdin porta il JSON delle chiavi, ne verifica la forma e dice COME ha trovato la chiave
 * (per nome o per tipo) — mai la chiave.
 */
async function pianoASecco(opzioni, pianoDaEseguire) {
  scrivi('a secco: niente rete, niente credenziali, nessun Sandbox')
  scrivi(`immagine: ${IMMAGINE_DEL_SANDBOX}`)
  scrivi(`regione: ${opzioni.regione}`)
  scrivi(`vcpus: ${opzioni.vcpus}`)
  scrivi(`cartella-binari: ${pianoDaEseguire.cartella}`)
  scrivi(`bucket: ${BUCKET_BUILD_VIDEO}`)
  scrivi(`script-provvista-sha256: ${sha256(pianoDaEseguire.provvista)}`)
  scrivi(`script-inventario-sha256: ${sha256(pianoDaEseguire.inventario)}`)
  scrivi(`script-verifica-sha256: ${sha256(pianoDaEseguire.verifica)}`)
  scrivi(`script-controllo-strumenti-sha256: ${sha256(pianoDaEseguire.controlloStrumenti)}`)
  scrivi(`script-controllo-rete-sha256: ${sha256(pianoDaEseguire.controlloRete)}`)
  scrivi(`strumenti-richiesti: ${STRUMENTI_DELL_AMBIENTE.map((strumento) => strumento.nome).join(' ')}`)

  if (process.stdin.isTTY) {
    scrivi('chiave-di-servizio: stdin è un terminale, non letto')
  } else {
    const { chiave, trovataPer } = sceltaDellaChiave(await leggiStdin())
    ricorda(chiave)
    scrivi(`chiave-di-servizio: trovata per ${trovataPer}, mai stampata`)
  }
  return 0
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'INGRESSO
 * ──────────────────────────────────────────────────────────────────────────── */

export async function main(argv, creaDipendenze = dipendenzeVere) {
  const opzioni = leggiArgomenti(argv)
  const pianoDaEseguire = piano()

  if (opzioni.aSecco) return pianoASecco(opzioni, pianoDaEseguire)

  if (process.stdin.isTTY) {
    throw new ErroreUso('manca il JSON delle chiavi: va in pipe, dall’uscita di `supabase projects api-keys`')
  }
  return costruisci(opzioni, pianoDaEseguire, await creaDipendenze())
}

// Parte solo se il file è lanciato da `node` (vedi `eseguitoDaRigaDiComando`): importato da un test non fa niente.
if (daRigaDiComando) {
  main(process.argv.slice(2)).then(
    (codice) => {
      process.exitCode = codice
    },
    (errore) => {
      if (errore instanceof ErroreUso) {
        scriviErrore(`${errore.message}\n\n${USO}`)
        process.exitCode = 2
      } else if (errore instanceof ErroreKO) {
        scriviErrore(`KO  ${errore.message}`)
        process.exitCode = 1
      } else {
        scriviErrore(`KO  errore imprevisto: ${descriviErrore(errore)}`)
        process.exitCode = 1
      }
    },
  )
}
