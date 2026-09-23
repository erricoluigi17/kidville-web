/**
 * Lettura di Aruba dagli SCRIPT (fuori da `src/`), e la guardia che decide se si può chiamare.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Gli script dell'indagine sulla numerazione (`scripts/numerazione-serie.mjs`) e della
 * registrazione delle orfane (`scripts/fatture-orfane.mjs`) parlano con Aruba da un computer,
 * non dall'app. Non passano da nessun cancello: se partono mentre l'app o la sync stanno
 * chiamando Aruba, la raffica si somma, e un `429` costa UN'ORA di silenzio a tutti — anche
 * alla segreteria che sta emettendo (decisione 16). Questo modulo mette in un posto solo:
 *   · la guardia `guardiaArubaPerScript({ sql })`, fail-closed, valutata prima di OGNI
 *     chiamata (D1 §10). L'ordine è fisso: lettura, coda, circuito, cancello, finestra della
 *     sync, attività dell'app negli ultimi 10';
 *   · signin, scorrimento di `findByUsername` col controllo dell'involucro (come
 *     `src/lib/aruba/client.ts:1141-1166` e `:1362-1371`), `getByFilename`, e l'estrazione
 *     dell'XML con `openssl cms -verify -noverify`;
 *   · 5000 ms fra due chiamate e stop al PRIMO 429, con l'orario oltre il quale si può riprovare;
 *   · il rifiuto di una cartella `--out` dentro il repository, che è PUBBLICO;
 *   · i processi figli solo con `execFileSync(cmd, args[])`: mai una shell, mai una stringa.
 *
 * ─── LA REGOLA CHE NON SI DEROGA: SI SBAGLIA DALLA PARTE DEL NON PARTIRE ───────────
 * Ogni lettura che non si capisce BLOCCA: errore della CLI, `42501`, timeout, JSON illeggibile,
 * una riga di troppo o di meno, un campo che non ha la forma attesa. L'unica eccezione è la
 * tabella che NON C'È: prima della PR-A la coda non esiste, e la guardia deve lasciar passare
 * (è il caso di tutto R1). «Non c'è» si riconosce in due modi soltanto: `to_regclass` NULL
 * per ENTRAMBE le tabelle alla prima lettura, oppure `42P01` alla seconda (tabella sparita fra
 * le due letture). Trattare «non so» come «non c'è» sarebbe il modo di far partire uno script
 * a coda attiva — ed è il controllo negativo che il test esegue.
 *
 * ─── IL NUCLEO (PR #160): `fatture_coda_stato` SENZA `aruba_cancello` ─────────────
 * Il nucleo della coda è in produzione dal 23/09/2026 e porta solo `fatture_coda_stato`: il
 * cancello condiviso con la sync arriva col piano completo. Non è uno schema a metà, è uno
 * schema VOLUTO, e prima di questo ramo la guardia lo chiamava `coda-incoerente` e fermava ogni
 * script per sempre. Col nucleo lo script parte SOLO se la coda è sospesa (`sospesa = true`) e
 * nessun lavoratore ha il testimone (`lavoratore_scade_il` nullo o passato): il lavoratore del
 * nucleo è l'unico altro che chiama Aruba, e un giro partito prima della sospensione finisce da
 * solo. Blocca anche la PAUSA del lavoratore (`pausa_fino_a`, 60 minuti dopo un 429): è il
 * circuito del nucleo, e sospendere la coda non la azzera. Ogni errore di questa lettura
 * blocca, `42P01` compreso: l'eccezione «tabella sparita fra le due letture» vale solo per lo
 * schema completo, dove la dichiara D1. Il contrario
 * (`aruba_cancello` senza `fatture_coda_stato`) resta `coda-incoerente`.
 *
 * ─── NIENTE LOG QUI DENTRO ──────────────────────────────────────────────────
 * Il modulo non stampa e non scrive in `app_log` (D1 §11: gli script lasciano traccia in
 * `registro_modifiche`). Restituisce esiti e lancia `FermoAruba`: stampare è dello script, che
 * sa cosa mostrare. I documenti di Aruba escono già RIDOTTI (`riduciDocumento`): `sender` e
 * `receiver` portano nomi e codici fiscali di genitori reali e non arrivano mai al chiamante.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ────────────────────────────────────────────────────────────────────────────
 * Costanti
 * ──────────────────────────────────────────────────────────────────────────── */

/** Produzione: gli script leggono i documenti veri. Nessun upload parte da qui. */
export const BASI_ARUBA = Object.freeze({
  auth: 'https://auth.fatturazioneelettronica.aruba.it',
  ws: 'https://ws.fatturazioneelettronica.aruba.it',
})

/** Una chiamata ogni cinque secondi: 12 ricerche al minuto per IP (SLA §3 di Aruba). */
export const PAUSA_MS = 5000

/** Come `PAGINA_SIZE` di `client.ts`: il tetto misurato il 2026-09-07 sta fra 2000 e 3500. */
export const PAGINA_SIZE = 2000

/** Come `PAGINE_MAX` di `client.ts`: 20 × 2000 = 40.000 documenti per anno. */
export const PAGINE_MAX = 20

/** Il valore che Aruba mette in `errorCode` quando la pagina è buona (misurato il 2026-09-07). */
export const CODICE_INVOLUCRO_OK = '0000'

/** Quanto resta in silenzio Aruba dopo un 429 (decisione 16). */
export const MINUTI_SILENZIO_429 = 60

/** Quanto indietro si guarda l'attività dell'app verso Aruba (D1 §10.3). */
export const MINUTI_ATTIVITA_APP = 10

/**
 * I minuti in cui la sync può essere in corso (D1 §10.2): pg_cron `*\/30`, `maxDuration = 300`
 * (una sync partita a :00 chiama Aruba fino a :05), più 2 minuti di margine prima della partenza.
 * La v5 bloccava solo 58-03 e 28-33, e lasciava passare :04 e :05.
 */
export const MINUTI_FINESTRA_SYNC = Object.freeze([58, 59, 0, 1, 2, 3, 4, 5, 28, 29, 30, 31, 32, 33, 34, 35])

/** I codici che la guardia restituisce, nell'ordine in cui le guardie si valutano. */
export const CODICI_GUARDIA = Object.freeze([
  'lettura-fallita',
  'coda-incoerente',
  'coda-attiva',
  'circuito-aperto',
  'cancello-in-uso',
  'finestra-sync',
  'attivita-app',
])

/** Il nome di un file Aruba (D1 §9.1): si valida PRIMA di metterlo in una richiesta. */
export const RE_NOME_FILE_ARUBA = /^IT[0-9A-Z]{11,16}_[0-9A-Za-z]{5}\.xml(\.p7m)?$/

/** L'unico SQLSTATE che vale «la coda non c'è»: tabella inesistente. */
const SQLSTATE_TABELLA_ASSENTE = '42P01'

/**
 * Prima lettura, SEMPRE (D1 §10.1). Non tocca le tabelle della coda: `to_regclass` dice se
 * esistono senza farle fallire. Nella stessa lettura l'attività dell'app verso Aruba, così la
 * guardia del §10.3 non costa una chiamata in più. Solo numeri, istanti e booleani: nessun
 * testo di `app_log` esce da qui.
 *
 * Il tempo si legge da `visto_l_ultima`, MAI da `creato_il` (correzione del 23/09/2026).
 * `app_log` somma le righe identiche per (fingerprint, giorno): `app_log_registra` fa
 * `ON CONFLICT … SET occorrenze + n, visto_l_ultima = now()` e lascia `creato_il` alla PRIMA
 * occorrenza del giorno. Il battito `aruba:upload` di externalFetch ha un'impronta costante per
 * route, utente, stato e giorno: dal secondo upload in poi `creato_il` resta fermo al mattino e
 * una guardia su `creato_il` non vede l'app che sta parlando con Aruba — cioè fallisce APERTA.
 * L'indice `app_log_evento_idx (evento, visto_l_ultima DESC)` copre proprio questa lettura.
 * La riga di successo dell'emissione ha `operazione = 'emettiFatturaPagamento'` SENZA i due
 * punti: il `like 'emettiFatturaPagamento:%'` da solo non la prende.
 */
const FILTRO_ATTIVITA_APP = `evento = 'fattura' and visto_l_ultima > now() - interval '${MINUTI_ATTIVITA_APP} minutes'
           and (contesto->'campi'->>'operazione' like 'aruba:%'
                or contesto->'campi'->>'operazione' = 'emettiFatturaPagamento'
                or contesto->'campi'->>'operazione' like 'emettiFatturaPagamento:%')`

export const SQL_PRIMA_LETTURA = `select extract(minute from now())::int as minuto, now() as adesso,
       to_regclass('public.fatture_coda_stato') is not null as stato,
       to_regclass('public.aruba_cancello') is not null as cancello,
       (select count(*) from public.app_log
         where ${FILTRO_ATTIVITA_APP}) as attivita_app,
       (select max(visto_l_ultima) from public.app_log
         where ${FILTRO_ATTIVITA_APP}) as ultima_attivita`

/**
 * Seconda lettura, solo se la coda è installata. La CLI legge le tabelle perché `postgres` ha
 * `BYPASSRLS` (C§7.6, C§7.7). `righe` conta le righe del prodotto: deve valere 1.
 */
export const SQL_SECONDA_LETTURA = `select s.sospesa,
       coalesce(c.circuito_fino_a > now(), false) as circuito_aperto, c.circuito_fino_a,
       coalesce(c.prestito_scade_il > now(), false) as cancello_in_uso, c.titolare,
       count(*) over () as righe
from public.fatture_coda_stato s cross join public.aruba_cancello c`

/**
 * Seconda lettura col NUCLEO (PR #160): esiste `fatture_coda_stato`, non `aruba_cancello`.
 * `lavoratore_attivo` è vero finché il testimone del lavoratore non è scaduto; un testimone
 * nullo vale «nessun lavoratore». `righe` deve valere 1, come nello schema completo.
 *
 * `pausa_attiva` è il circuito del nucleo: il lavoratore la chiede al rilascio (`aruba-429` per
 * 60 minuti, `esito-incerto` per 15, `src/lib/fatture-coda/giro.ts`) e la RPC `fatture_coda_prendi`
 * non parte finché non scade. Sospendere la coda NON la azzera: uno script lanciato a coda sospesa
 * dentro la pausa di un 429 prenderebbe un altro 429, e Aruba riaprirebbe l'ora (decisione 16).
 */
export const SQL_LETTURA_NUCLEO = `select s.sospesa,
       coalesce(s.pausa_fino_a > now(), false) as pausa_attiva, s.pausa_fino_a, s.pausa_motivo,
       coalesce(s.lavoratore_scade_il > now(), false) as lavoratore_attivo, s.lavoratore_scade_il,
       count(*) over () as righe
from public.fatture_coda_stato s`

/* ────────────────────────────────────────────────────────────────────────────
 * L'errore che ferma lo script
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Tutto ciò che impedisce di chiamare Aruba, o che Aruba ha rifiutato. Lo script lo stampa ed
 * esce con `uscita` (1 = guardia d'uso, D1 §3.3 e §9). `riprova_dopo` c'è quando si sa.
 */
export class FermoAruba extends Error {
  constructor(codice, messaggio, { riprova_dopo = undefined, uscita = 1 } = {}) {
    super(messaggio)
    this.name = 'FermoAruba'
    this.codice = codice
    this.uscita = uscita
    if (riprova_dopo !== undefined) this.riprova_dopo = riprova_dopo
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Orari (Europe/Rome) e piccoli attrezzi
 * ──────────────────────────────────────────────────────────────────────────── */

const FORMATO_ORA_ROMA = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** Un istante valido, oppure `null`. Accetta `Date`, stringa ISO o millisecondi. */
function istante(valore) {
  if (valore === null || valore === undefined || valore === '') return null
  const d = valore instanceof Date ? new Date(valore.getTime()) : new Date(valore)
  return Number.isFinite(d.getTime()) ? d : null
}

/** «HH:MM» nell'ora di Roma: è l'orologio di chi legge il messaggio. */
export function oraRoma(valore) {
  const d = istante(valore)
  return d ? FORMATO_ORA_ROMA.format(d) : '??:??'
}

const piuMinuti = (d, minuti) => new Date(d.getTime() + minuti * 60_000)

function blocco(codice, messaggio, riprova_dopo) {
  return riprova_dopo ? { ok: false, codice, messaggio, riprova_dopo } : { ok: false, codice, messaggio }
}

/** Il testo di un errore, corto: serve la diagnosi, non un romanzo. */
function descriviErrore(e) {
  const testo = e instanceof Error ? e.message : String(e)
  return testo.replace(/\s+/g, ' ').trim().slice(0, 240)
}

/**
 * Lo SQLSTATE di un errore, se lo dichiara. Prima la proprietà `sqlstate` (quella che mette
 * `sqlDaCliSupabase`), poi le tre forme testuali della CLI e della Management API:
 * `(SQLSTATE 42P01)`, `ERROR:  42P01: …`, `"code":"42P01"`. Mai `err.code` da solo: un
 * `ETIMEDOUT` di Node non è uno SQLSTATE.
 */
export function sqlstateDi(errore) {
  if (!errore) return null
  if (typeof errore.sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(errore.sqlstate)) return errore.sqlstate
  const testo = [errore.message, errore.stderr, errore.stdout]
    .filter((x) => x !== undefined && x !== null)
    .map((x) => String(x))
    .join('\n')
  const forme = [
    /SQLSTATE[\s:=]*([0-9A-Z]{5})\b/,
    /ERROR:\s+([0-9A-Z]{5}):/,
    /"code"\s*:\s*"([0-9A-Z]{5})"/,
  ]
  for (const re of forme) {
    const m = re.exec(testo)
    if (m) return m[1]
  }
  return null
}

/* ────────────────────────────────────────────────────────────────────────────
 * Le guardie pure
 * ──────────────────────────────────────────────────────────────────────────── */

/** Vero nei minuti in cui la sync può essere in corso (D1 §10.2). */
export function minutoInFinestraSync(minuto) {
  return MINUTI_FINESTRA_SYNC.includes(minuto)
}

/** Quanti minuti mancano al primo minuto libero dalla finestra. */
function minutiAllUscitaDallaFinestra(minuto) {
  for (let k = 1; k <= 60; k++) {
    if (!minutoInFinestraSync((minuto + k) % 60)) return k
  }
  return 60
}

/**
 * Il verdetto sullo stato della coda (D1 §10.1), nell'ordine:
 *  1. lettura fallita o coda incoerente → blocco. Unica eccezione: `42P01` alla SECONDA lettura
 *     (la tabella è sparita fra le due letture) vale «non installata», e si prosegue con una nota;
 *  2. non installata → prosegue (è il caso di tutto R1, fino alla PR-A);
 *  2bis. NUCLEO (`installata: 'nucleo'`, solo `fatture_coda_stato`): righe ≠ 1 → blocco;
 *     `sospesa !== true` → `coda-attiva`; pausa del lavoratore non scaduta (`pausa_fino_a`, il
 *     circuito del nucleo) → `circuito-aperto`, con l'orario; lavoratore col testimone non
 *     scaduto → `cancello-in-uso`, con l'orario di scadenza; altrimenti prosegue;
 *  3. righe ≠ 1 → blocco;
 *  4. `sospesa !== true` → blocco;
 *  5. circuito aperto → blocco, con l'orario;
 *  6. cancello in prestito → blocco.
 * I booleani si leggono in forma STRETTA: tutto ciò che non è `false` è un circuito aperto o un
 * cancello occupato, e tutto ciò che non è `true` è una coda non sospesa.
 *
 * @param {{ installata: true | false | 'nucleo' | 'incoerente' | undefined, riga?: object, errore?: unknown }} p
 */
export function verdettoCodaPerScript({ installata, riga, errore } = {}) {
  if (errore) {
    const sqlstate = sqlstateDi(errore)
    if (installata === true && sqlstate === SQLSTATE_TABELLA_ASSENTE) {
      return {
        ok: true,
        nota: 'la coda risultava installata alla prima lettura e la seconda ha trovato una tabella ' +
          `assente (SQLSTATE ${SQLSTATE_TABELLA_ASSENTE}): vale «non installata»`,
      }
    }
    return blocco(
      'lettura-fallita',
      `Lettura dello stato della coda fallita (${sqlstate ? `SQLSTATE ${sqlstate}` : 'senza SQLSTATE'}: ` +
        `${descriviErrore(errore)}). Senza sapere se la coda è attiva lo script non parte.`,
    )
  }
  if (installata === 'incoerente') {
    return blocco(
      'coda-incoerente',
      'Esiste aruba_cancello ma non fatture_coda_stato: lo schema della coda è a metà. Lo script ' +
        'non parte finché non esistono entrambe, solo fatture_coda_stato (il nucleo) o nessuna.',
    )
  }
  if (installata === 'nucleo') return verdettoNucleo(riga)
  if (installata === false) return { ok: true }
  if (installata !== true) {
    return blocco('lettura-fallita', 'Stato della coda non determinato: lo script non parte.')
  }
  if (!riga || typeof riga !== 'object' || Number(riga.righe) !== 1) {
    const righe = riga && typeof riga === 'object' ? Number(riga.righe) : 0
    return blocco(
      'coda-incoerente',
      `Lo stato della coda ha ${Number.isFinite(righe) ? righe : '?'} righe invece di una: ` +
        'lo script non parte.',
    )
  }
  if (riga.sospesa !== true) {
    return blocco(
      'coda-attiva',
      'La coda fatture è attiva: questo script chiama Aruba fuori dal cancello. Un admin sospenda ' +
        'la coda dalla pagina Coda fatture, poi rilancia; a fine lavoro la riprende.',
    )
  }
  if (riga.circuito_aperto !== false) {
    const fino = istante(riga.circuito_fino_a)
    return blocco(
      'circuito-aperto',
      `Aruba è in silenzio fino alle ${fino ? oraRoma(fino) : '(orario non leggibile)'}: ogni ` +
        "tentativo prima di allora riapre l'ora di attesa (decisione 16). Rilancia dopo quell'ora.",
      fino ?? undefined,
    )
  }
  if (riga.cancello_in_uso !== false) {
    const chi = riga.titolare === 'coda' || riga.titolare === 'sync' ? riga.titolare : 'un titolare sconosciuto'
    return blocco('cancello-in-uso', `Il cancello Aruba è in mano a ${chi}: rilancia fra qualche minuto.`)
  }
  return { ok: true }
}

/** I motivi di pausa che il lavoratore del nucleo scrive: solo questi si ripetono nel messaggio. */
const MOTIVI_PAUSA_NUCLEO = {
  'aruba-429': 'Aruba ha risposto 429',
  'esito-incerto': "l'ultimo giro ha avuto un esito incerto",
}

/**
 * Il ramo del NUCLEO: coda sospesa, nessuna pausa del lavoratore in corso e nessun lavoratore col
 * testimone, altrimenti blocco. I booleani in forma STRETTA come sopra: tutto ciò che non è `true`
 * è una coda non sospesa, tutto ciò che non è `false` è una pausa in corso o un lavoratore attivo.
 */
function verdettoNucleo(riga) {
  if (!riga || typeof riga !== 'object' || Number(riga.righe) !== 1) {
    const righe = riga && typeof riga === 'object' ? Number(riga.righe) : 0
    return blocco(
      'coda-incoerente',
      `Lo stato della coda (nucleo) ha ${Number.isFinite(righe) ? righe : '?'} righe invece di una: ` +
        'lo script non parte.',
    )
  }
  if (riga.sospesa !== true) {
    return blocco(
      'coda-attiva',
      'La coda fatture è attiva: il suo lavoratore chiama Aruba e questo script lo farebbe in ' +
        'parallelo. Sospendere la coda da admin (pagina Coda fatture) o con fatture_coda_sospendi, ' +
        'poi rilanciare; a fine lavoro la si riprende.',
    )
  }
  if (riga.pausa_attiva !== false) {
    // Il circuito del nucleo: vale anche a coda sospesa, perché sospendere non azzera la pausa.
    const fino = istante(riga.pausa_fino_a)
    const perche = Object.hasOwn(MOTIVI_PAUSA_NUCLEO, riga.pausa_motivo)
      ? MOTIVI_PAUSA_NUCLEO[riga.pausa_motivo]
      : 'motivo non riconosciuto'
    return blocco(
      'circuito-aperto',
      `La coda è in pausa (${perche}) fino alle ${fino ? oraRoma(fino) : '(orario non leggibile)'}: ` +
        "ogni tentativo prima di allora riapre l'ora di attesa (decisione 16). Rilancia dopo quell'ora.",
      fino ?? undefined,
    )
  }
  if (riga.lavoratore_attivo !== false) {
    const fino = istante(riga.lavoratore_scade_il)
    return blocco(
      'cancello-in-uso',
      'La coda è sospesa ma un giro del lavoratore è ancora in corso (testimone valido fino alle ' +
        `${fino ? oraRoma(fino) : '(orario non leggibile)'}): rilancia dopo quell'ora.`,
      fino ?? undefined,
    )
  }
  return { ok: true }
}

/**
 * L'app ha parlato con Aruba negli ultimi 10'? (D1 §10.3). Blocca anche se la lettura di
 * `app_log` è fallita o non ha dato un numero: «non so» non è «no».
 */
export function verdettoAttivitaApp({ n, ultimo, errore, adesso } = {}) {
  const conteggio = typeof n === 'string' && n.trim() !== '' ? Number(n) : n
  if (errore || typeof conteggio !== 'number' || !Number.isInteger(conteggio) || conteggio < 0) {
    return blocco(
      'attivita-app',
      `Lettura di app_log fallita${errore ? ` (${descriviErrore(errore)})` : ' (conteggio non leggibile)'}: ` +
        "senza sapere se l'app sta parlando con Aruba lo script non parte.",
    )
  }
  if (conteggio === 0) return { ok: true }
  const base = istante(ultimo) ?? istante(adesso)
  if (!base) {
    return blocco(
      'attivita-app',
      `L'app ha parlato con Aruba negli ultimi ${MINUTI_ATTIVITA_APP} minuti: riprova fra ${MINUTI_ATTIVITA_APP} minuti.`,
    )
  }
  const dopo = piuMinuti(base, MINUTI_ATTIVITA_APP)
  return blocco(
    'attivita-app',
    `L'app ha parlato con Aruba alle ${oraRoma(base)}: riprova dopo le ${oraRoma(dopo)}.`,
    dopo,
  )
}

/** Il messaggio al primo 429 (D1 §10.5): l'orario del rifiuto e quello oltre il quale riprovare. */
export function messaggio429(valore) {
  const quando = istante(valore) ?? new Date()
  return `Aruba ha risposto 429 alle ${oraRoma(quando)}. NON riprendere la coda, e non rilanciare ` +
    `script, prima delle ${oraRoma(piuMinuti(quando, MINUTI_SILENZIO_429))}.`
}

/* ────────────────────────────────────────────────────────────────────────────
 * La guardia completa
 * ──────────────────────────────────────────────────────────────────────────── */

/** La prima lettura, controllata campo per campo. `{ errore }` se la forma non è quella attesa. */
function leggiPrimaLettura(righe) {
  if (!Array.isArray(righe) || righe.length !== 1 || !righe[0] || typeof righe[0] !== 'object') {
    return { errore: `la prima lettura ha restituito ${Array.isArray(righe) ? righe.length : 'un valore non tabellare'} righe invece di una` }
  }
  const r = righe[0]
  const minuto = typeof r.minuto === 'string' && r.minuto.trim() !== '' ? Number(r.minuto) : r.minuto
  if (typeof minuto !== 'number' || !Number.isInteger(minuto) || minuto < 0 || minuto > 59) {
    return { errore: 'minuto del DB non leggibile' }
  }
  const adesso = istante(r.adesso)
  if (!adesso) return { errore: 'orologio del DB non leggibile' }
  if (typeof r.stato !== 'boolean' || typeof r.cancello !== 'boolean') {
    return { errore: 'esistenza delle tabelle della coda non leggibile' }
  }
  return {
    minuto,
    adesso,
    stato: r.stato,
    cancello: r.cancello,
    attivita_app: r.attivita_app,
    ultima_attivita: r.ultima_attivita ?? null,
  }
}

/** La seconda lettura ridotta a una riga col suo conteggio. Lancia se non è una tabella. */
function rigaSecondaLettura(righe) {
  if (!Array.isArray(righe)) {
    throw new Error('la seconda lettura non ha restituito una tabella')
  }
  if (righe.length === 0) return { righe: 0 }
  const r = righe[0]
  if (!r || typeof r !== 'object') throw new Error('la seconda lettura ha una riga illeggibile')
  return { ...r, righe: Number(r.righe) }
}

/**
 * La guardia di D1 §10, da valutare prima del signin e prima di OGNI chiamata ad Aruba.
 *
 * @param {{ sql: (testo: string) => Promise<object[]> }} p  `sql` esegue una query e restituisce
 *        le righe; lancia su qualunque errore (la forma di default è `sqlDaCliSupabase()`).
 * @returns {Promise<{ ok: true, adesso: Date, nota?: string } |
 *                   { ok: false, codice: string, messaggio: string, riprova_dopo?: Date }>}
 */
export async function guardiaArubaPerScript({ sql } = {}) {
  if (typeof sql !== 'function') {
    return blocco('lettura-fallita', 'Guardia Aruba senza una funzione sql: lo script non parte.')
  }

  // 1. Lettura.
  let prima
  try {
    prima = leggiPrimaLettura(await sql(SQL_PRIMA_LETTURA))
  } catch (e) {
    return blocco(
      'lettura-fallita',
      `Prima lettura della guardia fallita (${sqlstateDi(e) ? `SQLSTATE ${sqlstateDi(e)}` : 'senza SQLSTATE'}: ` +
        `${descriviErrore(e)}). Lo script non parte.`,
    )
  }
  if (prima.errore) {
    return blocco('lettura-fallita', `Prima lettura della guardia illeggibile: ${prima.errore}. Lo script non parte.`)
  }

  // 2-4. Coda, circuito, cancello.
  let installata
  let riga
  let errore
  if (prima.stato && prima.cancello) {
    installata = true
    try {
      riga = rigaSecondaLettura(await sql(SQL_SECONDA_LETTURA))
    } catch (e) {
      errore = e ?? new Error('errore senza descrizione')
    }
  } else if (prima.stato && !prima.cancello) {
    // Il nucleo (PR #160): la coda c'è, il cancello no. Si legge solo lo stato della coda.
    installata = 'nucleo'
    try {
      riga = rigaSecondaLettura(await sql(SQL_LETTURA_NUCLEO))
    } catch (e) {
      errore = e ?? new Error('errore senza descrizione')
    }
  } else if (!prima.stato && !prima.cancello) {
    installata = false
  } else {
    installata = 'incoerente'
  }
  const coda = verdettoCodaPerScript({ installata, riga, errore })
  if (!coda.ok) return coda

  // 5. Finestra della sync, dall'orologio del DB (quello di pg_cron).
  if (minutoInFinestraSync(prima.minuto)) {
    const inizioMinuto = new Date(prima.adesso.getTime())
    inizioMinuto.setUTCSeconds(0, 0)
    const dopo = piuMinuti(inizioMinuto, minutiAllUscitaDallaFinestra(prima.minuto))
    return blocco(
      'finestra-sync',
      `La sync delle fatture può essere in corso (minuto :${String(prima.minuto).padStart(2, '0')} ` +
        "dell'orologio del DB; finestre :58-:05 e :28-:35). Riprova dopo le " +
        `${oraRoma(dopo)}.`,
      dopo,
    )
  }

  // 6. Attività dell'app verso Aruba negli ultimi 10'.
  const attivita = verdettoAttivitaApp({
    n: prima.attivita_app,
    ultimo: prima.ultima_attivita,
    adesso: prima.adesso,
  })
  if (!attivita.ok) return attivita

  return coda.nota ? { ok: true, adesso: prima.adesso, nota: coda.nota } : { ok: true, adesso: prima.adesso }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Processi figli e DB
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Un processo figlio, SEMPRE con gli argomenti in un array e senza shell. Una stringa unica
 * passerebbe da una shell al primo che attiva l'opzione `shell`, e un nome file con uno spazio
 * diventerebbe due argomenti.
 */
export function eseguiFiglio(cmd, args, opzioni = {}, esegui = execFileSync) {
  if (typeof cmd !== 'string' || cmd.trim() === '' || /\s/.test(cmd)) {
    throw new TypeError('eseguiFiglio: il comando è un nome solo, senza spazi')
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('eseguiFiglio: gli argomenti vanno passati come array di stringhe')
  }
  return esegui(cmd, args, { ...opzioni, shell: false })
}

/** Le righe dall'uscita JSON della CLI: array nudo, oppure `{ rows: [...] }`. Lancia altrimenti. */
export function righeDaJsonCli(testo) {
  let valore
  try {
    valore = JSON.parse(String(testo))
  } catch {
    throw new Error('supabase db query: JSON illeggibile (nessuno SQLSTATE)')
  }
  if (Array.isArray(valore)) return valore
  if (valore && typeof valore === 'object' && Array.isArray(valore.rows)) return valore.rows
  throw new Error('supabase db query: risposta senza righe (nessuno SQLSTATE)')
}

/**
 * La funzione `sql` di default: `supabase db query --linked --agent no -o json <sql>`, dalla
 * radice del repo, con `execFileSync`. Un errore porta `sqlstate` (se la CLI lo dice) e `uscita`.
 */
export function sqlDaCliSupabase({ radice = RADICE_REPO, esegui = execFileSync, timeoutMs = 60_000 } = {}) {
  return async (testo) => {
    let uscita
    try {
      uscita = eseguiFiglio(
        'supabase',
        ['db', 'query', '--linked', '--agent', 'no', '-o', 'json', testo],
        {
          cwd: radice,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        esegui,
      )
    } catch (e) {
      const sqlstate = sqlstateDi(e)
      const dettaglio = String(e?.stderr ?? e?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      const err = new Error(
        `supabase db query: uscita ${e?.status ?? '?'}${e?.signal ? ` (segnale ${e.signal})` : ''}, ` +
          `${sqlstate ? `SQLSTATE ${sqlstate}` : 'senza SQLSTATE'}${dettaglio ? `: ${dettaglio}` : ''}`,
      )
      err.sqlstate = sqlstate
      err.uscita = typeof e?.status === 'number' ? e.status : null
      throw err
    }
    return righeDaJsonCli(uscita)
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * La cartella --out, fuori dal repository
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il percorso reale: i link simbolici risolti sulla parte che esiste (macOS: `/tmp` è
 * `/private/tmp`, e il disco non distingue maiuscole) e la coda che non esiste ancora attaccata.
 */
function percorsoReale(p) {
  const assoluto = resolve(p)
  let testa = assoluto
  const coda = []
  for (;;) {
    try {
      return join(realpathSync.native(testa), ...coda)
    } catch {
      const su = dirname(testa)
      if (su === testa) return assoluto
      coda.unshift(basename(testa))
      testa = su
    }
  }
}

/** La radice del repo: due livelli sopra `scripts/lib/`. */
export const RADICE_REPO = percorsoReale(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))

/**
 * Vero se `percorso` sta FUORI dal repository. Si confrontano percorsi RISOLTI, non
 * sottostringhe: `…/kidville-web-aruba` è fuori, `…/kidville-web/x` è dentro.
 */
export function fuoriDalRepository(percorso, radice = RADICE_REPO) {
  if (typeof percorso !== 'string' || percorso.trim() === '') return false
  const d = percorsoReale(percorso)
  const r = percorsoReale(radice)
  return !(d === r || d.startsWith(`${r}${sep}`))
}

/** Il `--out` di uno script: lancia `FermoAruba` se manca o se sta dentro il repository. */
export function rifiutaOutNelRepository(out, radice = RADICE_REPO) {
  if (typeof out !== 'string' || out.trim() === '') {
    throw new FermoAruba('out-mancante', 'Serve --out <cartella FUORI dal repository>: i file contengono dati di minori.')
  }
  if (!fuoriDalRepository(out, radice)) {
    throw new FermoAruba(
      'out-nel-repo',
      'RIFIUTO: --out è dentro il repository, che è pubblico. Scegli una cartella esterna.',
    )
  }
  return percorsoReale(out)
}

/* ────────────────────────────────────────────────────────────────────────────
 * Credenziali
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `ARUBA_USERNAME` e `ARUBA_PASSWORD` dall'ambiente, oppure da `.env.local`. Non tocca
 * `process.env` e non stampa niente. `null` se ne manca una.
 */
export function leggiCredenzialiAruba({ env = process.env, fileEnvLocale = join(RADICE_REPO, '.env.local') } = {}) {
  const valori = { ARUBA_USERNAME: env.ARUBA_USERNAME, ARUBA_PASSWORD: env.ARUBA_PASSWORD }
  if (!valori.ARUBA_USERNAME || !valori.ARUBA_PASSWORD) {
    let testo = ''
    try {
      testo = readFileSync(fileEnvLocale, 'utf8')
    } catch {
      testo = '' // nessun .env.local: restano solo le variabili d'ambiente
    }
    for (const riga of testo.split('\n')) {
      const m = /^\s*(ARUBA_USERNAME|ARUBA_PASSWORD)\s*=\s*(.*)$/.exec(riga)
      if (m && !valori[m[1]]) valori[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  if (!valori.ARUBA_USERNAME || !valori.ARUBA_PASSWORD) return null
  return { username: valori.ARUBA_USERNAME, password: valori.ARUBA_PASSWORD }
}

/* ────────────────────────────────────────────────────────────────────────────
 * I documenti, ridotti
 * ──────────────────────────────────────────────────────────────────────────── */

const primitivo = (v) => (typeof v === 'string' || typeof v === 'number' ? v : null)

/**
 * Un documento di `findByUsername` ridotto ai soli campi che servono (D1 §3.3): nome file,
 * date, `signed` e `unsignedFile` come booleani, e per ogni fattura annidata numero, stato e
 * data. `sender` e `receiver` NON escono: portano nomi e codici fiscali di persone reali.
 */
export function riduciDocumento(doc) {
  if (!doc || typeof doc !== 'object') return null
  const nome = doc.filename ?? doc.uploadFileName ?? doc.fileName ?? null
  const interne = Array.isArray(doc.invoices) ? doc.invoices : [doc]
  return {
    filename: typeof nome === 'string' ? nome : null,
    creationDate: primitivo(doc.creationDate),
    lastUpdate: primitivo(doc.lastUpdate),
    signed: Boolean(doc.signed),
    unsignedFile: Boolean(doc.unsignedFile),
    fatture: interne
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({ numero: primitivo(f.number), stato: primitivo(f.status), data: primitivo(f.invoiceDate) })),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Il lettore di Aruba
 * ──────────────────────────────────────────────────────────────────────────── */

const attesaVera = (ms) => new Promise((r) => setTimeout(r, ms))

async function testoCorto(res) {
  try {
    return (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300)
  } catch (e) {
    return `(corpo non leggibile: ${descriviErrore(e)})`
  }
}

/**
 * Il lettore: signin, scorrimento, `getByFilename`. Prima di OGNI chiamata aspetta `pausaMs`
 * dalla precedente (non prima della prima) e valuta `guardiaArubaPerScript`. Al primo 429 si
 * ferma per sempre: ogni chiamata successiva lancia lo stesso `FermoAruba` senza toccare la rete.
 *
 * @param {{ sql: Function, credenziali: { username: string, password: string },
 *           pausaMs?: number, attendi?: (ms: number) => Promise<void>, ora?: () => Date,
 *           basi?: { auth: string, ws: string }, timeoutMs?: number }} opzioni
 */
export function creaLettoreAruba({
  sql,
  credenziali,
  pausaMs = PAUSA_MS,
  attendi = attesaVera,
  ora = () => new Date(),
  basi = BASI_ARUBA,
  timeoutMs = 30_000,
} = {}) {
  if (!credenziali || !credenziali.username || !credenziali.password) {
    throw new FermoAruba('credenziali-mancanti', 'Mancano ARUBA_USERNAME / ARUBA_PASSWORD.')
  }
  let token = null
  let fermo = null
  let chiamate = 0
  const note = []

  async function primaDellaChiamata() {
    if (fermo) throw fermo
    if (chiamate > 0) await attendi(pausaMs)
    const g = await guardiaArubaPerScript({ sql })
    if (!g.ok) {
      fermo = new FermoAruba(g.codice, g.messaggio, { riprova_dopo: g.riprova_dopo })
      throw fermo
    }
    if (g.nota) note.push(g.nota)
    chiamate++
  }

  async function chiama(operazione, url, init) {
    await primaDellaChiamata()
    let res
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new FermoAruba('aruba-rete', `${operazione}: richiesta non riuscita (${descriviErrore(e)})`)
    }
    if (res.status === 429) {
      const quando = ora()
      fermo = new FermoAruba('aruba-429', messaggio429(quando), {
        riprova_dopo: piuMinuti(istante(quando) ?? new Date(), MINUTI_SILENZIO_429),
      })
      throw fermo
    }
    if (!res.ok) {
      throw new FermoAruba('aruba-http', `${operazione}: HTTP ${res.status}: ${await testoCorto(res)}`)
    }
    try {
      return await res.json()
    } catch (e) {
      throw new FermoAruba('aruba-risposta-illeggibile', `${operazione}: risposta non JSON (${descriviErrore(e)})`)
    }
  }

  function richiedeToken(operazione) {
    if (!token) throw new FermoAruba('senza-signin', `${operazione}: serve prima il signin`)
    return token
  }

  return {
    /** Le note della guardia (es. tabella sparita fra le due letture), da stampare a fine lavoro. */
    note,

    /** Un solo signin: Aruba ne concede uno al minuto per IP. Il token resta qui dentro. */
    async signin() {
      const corpo = new URLSearchParams({
        grant_type: 'password',
        username: credenziali.username,
        password: credenziali.password,
      }).toString()
      const json = await chiama('aruba:signin', `${basi.auth}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: corpo,
      })
      const t = json && typeof json.access_token === 'string' ? json.access_token : ''
      if (!t) throw new FermoAruba('aruba-signin-senza-token', 'aruba:signin: risposta senza access_token')
      token = t
    },

    /**
     * Tutti i documenti dell'anno, pagina per pagina, col controllo dell'involucro di
     * `client.ts`: `errorCode` diverso da '0000' → fermo; `size` echeggiata diversa da quella
     * chiesta → fermo; alla fine, meno documenti di `totalElements` → fermo. Oltre `PAGINE_MAX`
     * pagine → fermo: a uno script d'indagine un massimo PARZIALE non serve.
     */
    async scorriDocumenti({ anno }) {
      if (!Number.isInteger(anno) || anno < 2000 || anno > 2100) {
        throw new FermoAruba('anno-non-valido', `scorriDocumenti: anno non valido (${anno})`)
      }
      const documenti = []
      let totale = null
      for (let pagina = 1; pagina <= PAGINE_MAX; pagina++) {
        const qs = new URLSearchParams({
          username: credenziali.username,
          page: String(pagina),
          size: String(PAGINA_SIZE),
          startDate: `${anno}-01-01`,
          endDate: `${anno}-12-31`,
        })
        const json = await chiama('aruba:findByUsername', `${basi.ws}/services/invoice/out/findByUsername?${qs}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${richiedeToken('aruba:findByUsername')}` },
        })
        const env = json && typeof json === 'object' ? (json.value ?? json) : {}
        const errorCode = typeof env.errorCode === 'string' ? env.errorCode : null
        if (errorCode !== null && errorCode !== CODICE_INVOLUCRO_OK) {
          throw new FermoAruba(
            'involucro-errore',
            `findByUsername ha risposto 200 con errorCode «${errorCode}» alla pagina ${pagina}: la risposta non contiene l'elenco.`,
          )
        }
        const size = typeof env.size === 'number' && Number.isFinite(env.size) ? env.size : null
        if (size !== null && size !== PAGINA_SIZE) {
          throw new FermoAruba(
            'size-tappata',
            `findByUsername: chiesti ${PAGINA_SIZE} documenti per pagina, l'involucro ne dichiara ${size}.`,
          )
        }
        if (totale === null && typeof env.totalElements === 'number' && Number.isFinite(env.totalElements)) {
          totale = env.totalElements
        }
        const dellaPagina = env.content ?? env.invoices ?? []
        if (!Array.isArray(dellaPagina)) {
          throw new FermoAruba('involucro-senza-elenco', `findByUsername: la pagina ${pagina} non ha un elenco`)
        }
        for (const doc of dellaPagina) {
          const ridotto = riduciDocumento(doc)
          if (ridotto) documenti.push(ridotto)
        }
        if (dellaPagina.length < PAGINA_SIZE || env.last === true) {
          if (totale !== null && documenti.length < totale) {
            throw new FermoAruba(
              'scorrimento-incompleto',
              `findByUsername: l'involucro dichiara ${totale} documenti nel ${anno}, letti ${documenti.length} in ${pagina} pagine.`,
            )
          }
          return { documenti, totale, pagine: pagina }
        }
      }
      throw new FermoAruba(
        'pagine-troncate',
        `findByUsername: superate ${PAGINE_MAX} pagine da ${PAGINA_SIZE} nel ${anno}: la lettura non è completa.`,
      )
    },

    /**
     * Un documento per nome file (`includeFile=true&includePdf=false`). Il contenuto è
     * l'involucro firmato (base64 da `file ?? dataFile ?? fileContent`), restituito come Buffer;
     * delle fatture annidate escono solo numero, stato e data.
     */
    async getByFilename(filename) {
      if (typeof filename !== 'string' || !RE_NOME_FILE_ARUBA.test(filename)) {
        throw new FermoAruba('nome-file-non-valido', 'getByFilename: nome file non nella forma di Aruba')
      }
      const qs = new URLSearchParams({ filename, includeFile: 'true', includePdf: 'false' })
      const json = await chiama('aruba:getByFilename', `${basi.ws}/services/invoice/out/getByFilename?${qs}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${richiedeToken('aruba:getByFilename')}` },
      })
      const env = json && typeof json === 'object' ? (json.value ?? json) : {}
      if (typeof env.errorCode === 'string' && env.errorCode !== CODICE_INVOLUCRO_OK) {
        throw new FermoAruba('involucro-errore', `getByFilename ha risposto 200 con errorCode «${env.errorCode}»`)
      }
      const b64 = env.file ?? env.dataFile ?? env.fileContent ?? null
      if (typeof b64 !== 'string' || b64 === '') {
        throw new FermoAruba(
          'aruba-senza-contenuto',
          `getByFilename: nessun contenuto; chiavi: ${Object.keys(env).sort().join(', ')}`,
        )
      }
      return { contenuto: Buffer.from(b64, 'base64'), fatture: riduciDocumento(env).fatture }
    },
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'XML dall'involucro firmato
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Estrae l'XML dall'involucro PKCS#7 (CAdES) con `openssl cms -verify -noverify`: serve il
 * contenuto, non la prova crittografica. NON si affetta la stringa fra `<?xml` e la chiusura: i
 * blocchi BER a lunghezza indefinita spezzano il testo (vedi `scripts/aruba-campioni.mjs`).
 * Il file temporaneo nasce in una sottocartella 0700 di `cartella`, che deve stare FUORI dal
 * repository (contiene dati di minori), e si cancella subito dopo.
 */
export function estraiXmlDaP7m(contenuto, { cartella, esegui = execFileSync } = {}) {
  if (!Buffer.isBuffer(contenuto) || contenuto.length === 0) {
    throw new FermoAruba('p7m-vuoto', 'estraiXmlDaP7m: contenuto vuoto', { uscita: 1 })
  }
  rifiutaOutNelRepository(cartella)
  const dir = mkdtempSync(join(percorsoReale(cartella), 'p7m-'))
  try {
    const file = join(dir, 'documento.p7m')
    writeFileSync(file, contenuto, { mode: 0o600 })
    let uscita
    try {
      uscita = eseguiFiglio(
        'openssl',
        ['cms', '-verify', '-noverify', '-inform', 'DER', '-in', file],
        { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
        esegui,
      )
    } catch (e) {
      const dettaglio = String(e?.stderr ?? e?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      throw new FermoAruba('p7m-illeggibile', `openssl cms non ha aperto l'involucro: ${dettaglio}`)
    }
    const xml = Buffer.isBuffer(uscita) ? uscita.toString('utf8') : String(uscita ?? '')
    if (!/<([A-Za-z0-9_]+:)?FatturaElettronica[\s>]/.test(xml)) {
      throw new FermoAruba('p7m-senza-fattura', "openssl cms: nell'involucro non c'è una FatturaElettronica")
    }
    return xml
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
