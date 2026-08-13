// L'ALLEGATO CHE ARRIVA DA UNA PORTA APERTA — tetto, tipi, e un rifiuto comprensibile.
//
// PERCHÉ ESISTE QUESTO FILE (collaudo del 2026-08-02, sicurezza F1).
//
// `POST /api/iscrizione/upload` accettava caricamenti ANONIMI nel bucket che custodisce i
// documenti d'iscrizione dei minori (`form_attachments`), **senza tetto per IP e senza
// allowlist di tipo o estensione** — mentre le tre rotte sorelle dello stesso wizard
// pubblico ce l'avevano tutte. Misurato sul server di produzione, da anonimo:
//
//   for i in {1..10}; do curl -X POST …/api/iscrizione/upload; done → dieci 500, mai un 429
//   la stessa prova su …/api/iscrizione                             → 400 ×4, poi 429
//
// La forma del difetto è quella che questo repo si è già scritto tre volte: **una regola
// giusta applicata a una lista chiusa** («iscrizione», «iscrizione/sedi»,
// «public/forms/[token]/*») invece che a tutti gli handler pubblici. `iscrizione/upload`
// era rimasta fuori dall'elenco, e nessun lock la vedeva.
//
// PERCHÉ NON UN GATE DI SESSIONE. Da quella porta arrivano circa nove domande l'ora da
// famiglie vere, e chi compila il modulo non ha (ancora) un account: chiederglielo
// significherebbe chiudere le iscrizioni. Il perimetro di una porta che deve restare aperta
// è il tetto per IP + la lista dei tipi + il limite di dimensione.
//
// PERCHÉ IN UN MODULO E NON DENTRO LA ROUTE. Perché la stessa regola vale per due strade
// (`iscrizione/upload` e `public/forms/[token]/upload` scrivono nello STESSO bucket), e in
// questo repo una regola valida per due strade che vive in due posti diverge alla prima
// modifica: è successo su `gallery` (50 MB nel bucket, 200 MB nella route, per mesi) ed è
// la lezione scritta in `@/lib/allegati/mime`.

import { NextResponse } from 'next/server'
import { logEvento } from '@/lib/logging/logger'

/**
 * Il tetto di caricamenti per indirizzo IP delle DUE PORTE DELLE FAMIGLIE, e la sua
 * finestra: `iscrizione/upload` e `public/forms/[token]/upload`, che scrivono nello
 * stesso bucket (`form_attachments`) e servono lo stesso wizard.
 *
 * IL NUMERO NON È A OCCHIO. Al 2026-08-02 il bucket conteneva 961 file per 227 domande
 * d'iscrizione: 4,2 allegati per domanda. Gli INVII sono già limitati a 5 ogni 10 minuti
 * per IP (`iscrizione:POST`), quindi venti caricamenti coprono cinque domande complete
 * dallo stesso indirizzo, e la famiglia che ha quattro documenti e sbaglia il primo
 * tentativo non viene respinta.
 *
 * ⚠️ IL CONTO ESATTO SAREBBE 21 (4,2 × 5), E QUESTO NUMERO È 20. Sta scritto invece di
 * essere arrotondato via: l'aritmetica del 02/08 ragionava su 4 allegati a domanda, la
 * misura ne dava 4,2, e la differenza è uno slot. Non si alza qui, e non per pigrizia:
 * per sapere se quel singolo slot morde davvero servirebbe contare i 429 che questa
 * porta ha servito, che è una misura che nessuno ha fatto. Alzare un tetto «per
 * sicurezza» su una porta ANONIMA che scrive nello Storage dei documenti dei minori è
 * la decisione che va presa guardando un numero, non stimandolo.
 *
 * ⚠️ ED È PASSATO DA 20 A 30 E POI DI NUOVO A 20, il 12 e il 13/08/2026. Il 12 il
 * fabbisogno del MODULO DEL PERSONALE (due facce per persona) è cresciuto, e la
 * risposta è stata alzare questa costante — che però è condivisa: le due porte delle
 * famiglie si sono ritrovate il tetto allentato del 50% per un bisogno che non era il
 * loro, su endpoint anonimi che scrivono nel bucket dei minori. Il commento di allora
 * descriveva già il rimedio giusto senza applicarlo («chi dovesse alzarlo ancora … dia
 * alla porta del personale un contatore suo con la sua misura accanto»). È ciò che il
 * 13/08 è stato fatto: vedi `TETTO_UPLOAD_PERSONALE` qui sotto.
 *
 * ⚠️ Il contatore degrada a in-memoria e PER ISTANZA (vedi `@/lib/security/rate-limit`):
 * in quel caso il tetto effettivo è N × 20. Alza il costo di un abuso, non lo azzera. È
 * comunque la differenza fra «dieci richieste su dieci arrivano all'handler» e «venti».
 */
export const TETTO_UPLOAD_PUBBLICO = 20
export const FINESTRA_UPLOAD_PUBBLICO_MS = 10 * 60 * 1000

/**
 * IL TETTO DELLA PORTA DEL PERSONALE — `iscrizione/personale/upload`, e solo quella.
 *
 * ── PERCHÉ UN CONTATORE SUO, invece di alzare quello condiviso ───────────────
 * I contatori erano GIÀ separati (chiavi diverse per rotta): a essere condiviso era
 * solo il NUMERO. Quindi alzarlo per il personale non dava al personale niente che un
 * numero suo non desse, e regalava alle due porte delle famiglie un allentamento che
 * nessuna misura chiedeva. Il costo di tenerli separati è che due numeri per la stessa
 * regola divergono — ma qui la regola NON è la stessa: sono due bucket diversi, due
 * popolazioni diverse e due aritmetiche diverse, e chiamarle «la stessa regola» era
 * l'errore. Il lock `__tests__/architecture/upload-pubblico-con-tetto.test.ts` continua
 * a pretendere che nessuna rotta si scriva un numero DENTRO: il tetto arriva da qui.
 *
 * ── L'ARITMETICA (rimisurata il 2026-08-12) ──────────────────────────────────
 * Dal 12/08/2026 il documento d'identità si consegna **fronte E retro**: ogni persona
 * costa DUE caricamenti, non uno. E il modo previsto di usare quel modulo — dichiarato
 * in `personale-template.ts` e ribadito nel tetto di `iscrizione/personale:POST` — è «la
 * Segreteria manda il link alle maestre in servizio», cioè più dipendenti che compilano
 * lo stesso pomeriggio dal wifi della sede, **dietro un solo NAT**. La sede più grande,
 * Giugliano, ha **13 account di personale** (misura dell'11/08/2026):
 *
 *     13 dipendenti × 2 facce = 26 caricamenti nella stessa finestra
 *
 * Con venti, dal 21° in poi arrivava un 429 «Troppe richieste» indistinguibile da un
 * servizio rotto — cioè lo stesso difetto che il tetto degli INVII aveva già pagato
 * («con tre l'ora, dalla quarta in poi prendevano un 429… e riprovando restavano
 * ferme»), ripetuto sul tetto accanto perché nessuno aveva rifatto il conto dopo aver
 * raddoppiato i file per persona.
 *
 * ── PERCHÉ TRENTA, cioè 26 più quattro ───────────────────────────────────────
 * Il margine è **quattro slot: due scatti rifatti per l'intera sede**. Trenta non è più
 * «il massimo che il lock ammette» — quel tetto valeva per la costante condivisa, e
 * questa non lo è: qui il limite superiore ha una ragione sua, ed è che una porta
 * ANONIMA che scrive nello Storage non può concedere ordini di grandezza. Chi dovrà
 * alzarlo rifaccia il conto delle persone in servizio (la misura sta in `utenti`), non
 * aggiunga un margine al margine.
 *
 * ⚠️ Stesso avvertimento del suo gemello: il contatore degrada a in-memoria e PER
 * ISTANZA, quindi in quel caso il tetto effettivo è N × 30.
 */
export const TETTO_UPLOAD_PERSONALE = 30

/**
 * I tipi che si possono allegare a una domanda d'iscrizione o a un modulo pubblico.
 *
 * È la lista già in vigore su `public/forms/[token]/upload` — la rotta gemella sullo stesso
 * bucket — ed è confermata dai file VERI: al 2026-08-02 i 961 allegati di produzione sono
 * `image/jpeg` (680), `application/pdf` (220), `image/png` (60), `image/heic` (1). Nessun
 * caricamento reale viene respinto da questa lista.
 *
 * Niente Word: il modulo pubblico chiede documenti d'identità e certificati, cioè scansioni
 * e fotografie. Un `.docx` da una porta anonima è un file che nessuno ha chiesto.
 */
export const MIME_ALLEGATO_PUBBLICO = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const

/**
 * Le estensioni ammesse, e non sono un doppione dei MIME: il tipo lo DICHIARA il client
 * (`file.type` è una stringa che arriva dal browser, non una misura), mentre l'estensione è
 * il nome con cui il file resterà nel bucket. Servono tutte e due, e devono concordare.
 */
export const ESTENSIONI_ALLEGATO_PUBBLICO = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic'] as const

/**
 * Il tipo da dichiarare allo Storage quando il browser non ne dichiara nessuno (succede con
 * `.heic` su Chrome, ed è il caso di una foto scattata col telefono).
 *
 * Senza questa mappa il file finirebbe nel bucket come `application/octet-stream`: oggi
 * passerebbe — il bucket non filtra niente — ma il giorno in cui `form_attachments`
 * dichiarerà i suoi tipi ammessi verrebbe respinto DOPO il caricamento, con un 500 opaco.
 */
const MIME_PER_ESTENSIONE: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
}

/**
 * L'ESTENSIONE DEL FILE ARCHIVIATO, decisa dal TIPO e non dal nome.
 *
 * ⚠️ Il tipo del `Record` è ancorato a `MIME_ALLEGATO_PUBBLICO`: se un domani quella lista
 * guadagnasse un sesto tipo, questo file non compilerebbe più. È voluto — un `?? 'bin'`
 * silenzioso avrebbe archiviato un file valido con un'estensione che nessun visualizzatore
 * riconosce, e il difetto si sarebbe visto solo aprendo la scheda di una persona.
 *
 * `image/jpeg` → `jpg` (e non `jpeg`): un tipo, un'estensione canonica. Il bucket non deve
 * contenere lo stesso formato scritto in due modi.
 *
 * NON è l'inverso di `MIME_PER_ESTENSIONE`, e la differenza è la ragione per cui sono due
 * mappe: là `jpg` e `jpeg` portano entrambe a `image/jpeg` (si accetta come si trova ciò che
 * l'utente ha già sul telefono), qui `image/jpeg` produce solo `jpg` (si scrive in un modo
 * solo). Una mappa sola, invertita al volo, avrebbe dovuto scegliere — e avrebbe scelto male
 * da una delle due parti.
 */
const ESTENSIONE_PER_MIME: Record<(typeof MIME_ALLEGATO_PUBBLICO)[number], string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
}

/**
 * L'estensione con cui un allegato pubblico resta nel bucket, dato il tipo che
 * `verificaAllegatoPubblico` ha già normalizzato e ammesso.
 *
 * ⚠️ RITORNA `undefined` PER UN TIPO SCONOSCIUTO, e il tipo opzionale è la parte utile: è ciò
 * che COSTRINGE il chiamante a scrivere il ramo di rifiuto invece di comporre un percorso con
 * un `undefined` dentro. Il cast interno vale solo per la lettura della mappa — è l'unico posto
 * in cui è onesto, perché la firma dice già che la chiave può non esserci.
 *
 * Il chiamante non deve mai ripiegare su un'estensione inventata: quel percorso viene poi
 * riletto dai gate di forma (`@/lib/personale/percorso-documento`), che ammettono solo
 * `ESTENSIONI_ALLEGATO_PUBBLICO`. Un'estensione fuori elenco significa un file caricato per
 * davvero e un modulo che rifiuta il percorso del proprio allegato.
 */
export function estensioneArchiviata(contentType: string): string | undefined {
  return ESTENSIONE_PER_MIME[contentType as (typeof MIME_ALLEGATO_PUBBLICO)[number]]
}

/** L'estensione in minuscolo, senza il punto (`''` se il nome non ne ha). */
export function estensioneDi(nomeFile: string): string {
  const pezzi = nomeFile.split('.')
  return pezzi.length > 1 ? (pezzi.pop() ?? '').toLowerCase() : ''
}

/**
 * Il tipo dichiarato senza i parametri (`image/jpeg; charset=binary`), in minuscolo.
 *
 * `application/octet-stream` vale come NON DICHIARATO, e non è una scorciatoia: quando il
 * browser non conosce il tipo di un file (Chrome con gli `.heic`, cioè le foto scattate
 * dall'iPhone di un genitore) il `File` arriva con `type` vuoto, e la codifica multipart lo
 * spedisce proprio come `application/octet-stream`. Trattarlo come un tipo vero
 * significherebbe respingere una fotografia valida per il nome del suo tipo — e in cambio
 * non si difenderebbe niente: chi vuole aggirare la lista dichiara `application/pdf`, che
 * costa uguale. A decidere resta l'estensione, e allo Storage va comunque il tipo giusto.
 */
export function normalizzaTipoDichiarato(tipo: string | null | undefined): string {
  const pulito = (tipo ?? '').split(';')[0].trim().toLowerCase()
  return pulito === 'application/octet-stream' ? '' : pulito
}

export type EsitoAllegatoPubblico =
  /** Ammesso: `contentType` è il tipo da passare allo Storage, mai `octet-stream`. */
  | { ok: true; contentType: string }
  /** Rifiutato: la risposta è pronta, col codice che il client sa tradurre. */
  | { ok: false; risposta: NextResponse }

/**
 * Verifica tipo ed estensione di un allegato PRIMA che tocchi lo Storage.
 *
 * Il tipo mancante non è un rifiuto (Chrome non lo dichiara sugli `.heic`): in quel caso
 * decide l'estensione, che deve essere in elenco. Il tipo dichiarato, quando c'è, deve
 * essere ammesso E concordare con l'estensione — altrimenti basterebbe rinominare.
 *
 * Il rifiuto lascia una riga `warn` (è un uso sbagliato, non un guasto) col solo tipo e la
 * dimensione. IL NOME DEL FILE NON SI LOGGA MAI: «certificato-<cognome>.pdf» dice di quale
 * bambino si tratta, e finirebbe in un canale che si legge tutti i giorni.
 */
export function verificaAllegatoPubblico(
  file: File,
  ctx: { operazione: string; bucket: string },
): EsitoAllegatoPubblico {
  const dichiarato = normalizzaTipoDichiarato(file.type)
  const ext = estensioneDi(file.name)

  const estensioneOk = (ESTENSIONI_ALLEGATO_PUBBLICO as readonly string[]).includes(ext)
  const tipoOk = !dichiarato || (MIME_ALLEGATO_PUBBLICO as readonly string[]).includes(dichiarato)
  const concordano = !dichiarato || MIME_PER_ESTENSIONE[ext] === dichiarato

  if (!estensioneOk || !tipoOk || !concordano) {
    logEvento('storage', 'warn', {
      operazione: ctx.operazione,
      esito: 'mime-non-ammesso',
      bucket: ctx.bucket,
      mime: dichiarato || '(non dichiarato)',
      byte: file.size,
    })
    return {
      ok: false,
      risposta: NextResponse.json(
        {
          error: 'Questo tipo di file non si può allegare: sono ammessi PDF e immagini (JPG, PNG, WEBP, HEIC)',
          codice: 'ALLEGATO_PDF_O_IMMAGINE',
        },
        { status: 415 },
      ),
    }
  }

  return { ok: true, contentType: dichiarato || MIME_PER_ESTENSIONE[ext] }
}

/**
 * 429 — il tetto per IP è stato raggiunto.
 *
 * `Retry-After` in secondi, come le rotte sorelle: un client che non sa quando riprovare
 * riprova subito, e un tetto contro cui si sbatte in continuazione è indistinguibile da un
 * servizio rotto.
 */
export function rispostaTroppiCaricamenti(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    {
      error: 'Troppi caricamenti. Riprova tra qualche minuto.',
      codice: 'TROPPE_RICHIESTE',
    },
    { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
  )
}
