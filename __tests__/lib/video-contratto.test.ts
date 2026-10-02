// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
    DIMENSIONE_BLOCCO_TUS_BYTE,
  AZIONI_INTENT_VIDEO,
  ATTEMPT_DELLA_PRIMA_PRESA,
  CANALI_VIDEO,
  CHIAVI_MESSAGGIO_VIDEO,
  COPERTURA_CODICI_TIPIZZATI,
  CODICE_VIDEO_DI_RIPIEGO,
  CODICI_BORDO_VIDEO,
  CODICI_ESITO_VIDEO,
  CODICI_MOSTRATI_VIDEO,
  FASI_VOCE_VIDEO,
  INTESTAZIONE_TOKEN_RINNOVO,
  MAPPA_MESSAGGIO_VIDEO,
  MAX_BAMBINI_PER_VIDEO,
  MAX_CLASSI_PER_VIDEO,
  MAX_VOCI_ELENCO_VIDEO,
  PREFISSO_TOKEN_RINNOVO,
  STATI_JOB_VIDEO,
  TRASPORTI_VIDEO,
  avanzamentoDaStatoVideo,
  codiceMessaggioVideo,
  codiceMostrabileDelJob,
  riprovaAutomaticaInCorso,
  schemaAperturaIntentVideo,
  schemaAzioneRiprovaPubblicazioneVideo,
  schemaCaricamentoVideo,
  schemaCoordinatePutVideo,
  schemaCorpoFirmaVideo,
  schemaCorpoRunnerVideo,
  schemaDestinatariVideo,
  schemaEsitoAperturaIntentVideo,
  schemaQueryElencoVideo,
  schemaRispostaAperturaVideo,
  schemaRispostaElencoVideo,
  schemaRispostaFirmaVideo,
  schemaRispostaRinnovoVideo,
  schemaStatoJobVideo,
  schemaTokenRinnovoVideo,
  schemaVoceVideo,
  type StatoJobVideo,
} from '@/lib/media/video/contratto'
import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'
import itServizi from '../../messages/it/teacherServizi.json'
import enServizi from '../../messages/en/teacherServizi.json'
import itComunicazioni from '../../messages/it/adminComunicazioni.json'
import enComunicazioni from '../../messages/en/adminComunicazioni.json'

/**
 * IL CONTRATTO CONDIVISO DELLA PIPELINE VIDEO — e il motivo per cui questo test
 * NON contiene un elenco di codici scritto a mano.
 *
 * Un'unione di stringhe copiata a mano da quattro sorgenti diverse è corretta il
 * giorno in cui la si scrive e sbagliata il giorno dopo: basta che qualcuno
 * aggiunga un `code` a una RPC o un ramo a `verifyVideoOutput` e il client si
 * trova davanti un codice che non sa tradurre — cioè ricade sulla prosa del
 * server, che è il difetto F1 del collaudo del 2026-07-31.
 *
 * Perciò qui i codici si MISURANO sulle fonti (`limiti.ts`, `probe.ts`,
 * `verify.ts`, le migrazioni `*_video_*.sql`) e si confrontano con l'elenco del
 * contratto. Se una fonte cresce, questo test diventa rosso e chiede di
 * dichiarare il codice nuovo e di decidere che cosa la famiglia ne legge: le due
 * cose insieme, che è l'unico modo perché la seconda non si dimentichi.
 */

const RADICE = process.cwd()
const VIDEO = join(RADICE, 'src/lib/media/video')
const MIGRAZIONI = join(RADICE, 'supabase/migrations')

const catIt = itShared as Record<string, string>
const catEn = enShared as Record<string, string>

/**
 * I membri LETTERALI di un'unione di tipo (`export type X = 'A' | 'B'`, anche
 * su più righe): si legge dal `=` fino alla prima riga vuota, che è la forma in
 * cui sono scritte tutte e tre le unioni sorgente. I riferimenti ad altri tipi
 * (`| VideoInputSizeErrorCode`) non sono letterali e vengono ignorati: quella
 * fonte si misura per conto suo.
 */
function membriUnione(sorgente: string, nome: string): string[] {
  const inizio = sorgente.indexOf(`export type ${nome} =`)
  if (inizio === -1) return []
  const resto = sorgente.slice(inizio)
  const fine = resto.indexOf('\n\n')
  const blocco = fine === -1 ? resto : resto.slice(0, fine)
  return [...blocco.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1])
}

/**
 * I membri di un elenco letterale (`export const X = ['A', 'B'] as const`): si legge
 * dal `=` alla parentesi quadra chiusa. Serve per il runner, che dichiara i suoi
 * codici cosi' invece che come unione di tipo — e leggerli dalla FONTE, non da un
 * import, e' il punto: un import seguirebbe una rinomina in silenzio, un testo no.
 */
function membriElencoLetterale(sorgente: string, nome: string): string[] {
  const inizio = sorgente.indexOf(`export const ${nome} = [`)
  if (inizio === -1) return []
  const resto = sorgente.slice(inizio)
  const fine = resto.indexOf('\n]')
  const blocco = fine === -1 ? resto : resto.slice(0, fine)
  return [...blocco.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1])
}

/**
 * IL TESTO DI UNO SCRIPT SQL SENZA I COMMENTI, e se si è letto fino in fondo.
 *
 * Le testate delle migrazioni video nominano i codici dappertutto — nei commenti che spiegano
 * che cosa risponde una RPC, negli esempi, nelle vecchie versioni — e un lock che li contasse
 * come «usati» sarebbe verde o rosso per un motivo che non c'entra col codice che gira. Qui si
 * tolgono i commenti a riga (`--`) e a blocco e si lasciano INTATTE le stringhe, perché un codice vive proprio lì
 * dentro (`'BAD_INPUT'`) e un `--` dentro una stringa non è un commento.
 *
 * `chiuso` dice se la lettura è finita fuori da una stringa e da un commento: se no, qualcosa
 * (un apice dentro un testo fra dollari, per esempio) ha fatto girare il lettore a vuoto, e
 * «zero codici trovati» da lì in poi non vorrebbe dire niente. Il test lo controlla su ogni file.
 */
function sqlSenzaCommenti(sql: string): { testo: string; chiuso: boolean } {
  let testo = ''
  let i = 0
  let stato: 'codice' | 'riga' | 'blocco' | 'stringa' = 'codice'
  while (i < sql.length) {
    const c = sql[i]
    const d = sql[i + 1]
    if (stato === 'codice') {
      if (c === '-' && d === '-') { stato = 'riga'; i += 2; continue }
      if (c === '/' && d === '*') { stato = 'blocco'; i += 2; continue }
      if (c === "'") { stato = 'stringa' }
      testo += c
      i++
      continue
    }
    if (stato === 'riga') {
      if (c === '\n') { stato = 'codice'; testo += '\n' }
      i++
      continue
    }
    if (stato === 'blocco') {
      if (c === '*' && d === '/') { stato = 'codice'; i += 2; continue }
      if (c === '\n') testo += '\n'
      i++
      continue
    }
    // stringa: `''` è un apice dentro la stringa, `'` la chiude.
    if (c === "'" && d === "'") { testo += "''"; i += 2; continue }
    if (c === "'") stato = 'codice'
    testo += c
    i++
  }
  return { testo, chiuso: stato === 'codice' }
}

/** Un codice come lo scrive il contratto: MAIUSCOLO con i trattini bassi, almeno tre caratteri. */
const CODICE_SQL = '([A-Z][A-Z0-9_]{2,})'

/**
 * OGNI CODICE CHE UNO SCRIPT SQL SCRIVE, in tutte le forme in cui una migrazione video li scrive.
 * Fino al 2026-10-02 se ne leggeva UNA (la risposta di una RPC) e ne mancavano due già in
 * produzione: `UPLOAD_ABBANDONATO` e `CONVERSIONE_INCAGLIATA`, che la retention scrive da sola
 * sul job. Le forme sono:
 *
 *  1. `'code', 'X'` — ciò che una RPC risponde (`jsonb_build_object('ok', false, 'code', 'X')`);
 *  2. `error_code = 'X'`, `last_error_code := 'X'`, `error_code IN ('X', 'Y')` — ciò che SQL scrive
 *     (o confronta) sul job; stessa cosa per `pubblicazione_errore`, che è la colonna omologa
 *     dell'intento;
 *  3. `RAISE EXCEPTION 'X'` — un'eccezione il cui messaggio intero è un codice (i messaggi che
 *     sono frasi o nomi di funzione, `'video_job_x: …'`, non sono in maiuscolo e non contano);
 *  4. `v_code := 'X'`, `p_codice DEFAULT 'X'` — una variabile che porta il codice a chi risponde.
 *
 * Ogni forma è una RETE: nessuna migrazione di oggi usa le ultime due, e proprio per questo il
 * test sotto le prova una per una su un frammento — una rete che non si è mai vista prendere
 * niente è una rete che può avere un buco senza saperlo.
 */
function codiciInSql(sql: string): string[] {
  const { testo } = sqlSenzaCommenti(sql)
  const trovati = new Set<string>()
  const singoli: RegExp[] = [
    new RegExp(`'code'\\s*,\\s*'${CODICE_SQL}'`, 'g'),
    new RegExp(`\\b(?:last_)?error_code\\s*(?::?=|<>|!=)\\s*'${CODICE_SQL}'`, 'g'),
    new RegExp(`\\bpubblicazione_errore\\s*(?::?=|<>|!=)\\s*'${CODICE_SQL}'`, 'g'),
    new RegExp(`\\bRAISE\\s+\\w+\\s+'${CODICE_SQL}'`, 'g'),
    new RegExp(
      `\\b[vp]_[a-z_]*(?:code|codice)\\b\\s*(?:text\\s*)?(?::=|=|DEFAULT)\\s*'${CODICE_SQL}'`,
      'g',
    ),
  ]
  for (const re of singoli) for (const m of testo.matchAll(re)) trovati.add(m[1])
  for (const m of testo.matchAll(/\b(?:last_error_code|error_code|pubblicazione_errore)\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi)) {
    for (const voce of m[1].matchAll(new RegExp(`'${CODICE_SQL}'`, 'g'))) trovati.add(voce[1])
  }
  return [...trovati].sort()
}

/** I file SQL «video» di una cartella: gli stessi che il lock ha sempre letto. */
function fileSqlVideo(cartella: string): string[] {
  return readdirSync(cartella).filter((n) => /_video[_.]/.test(n) && n.endsWith('.sql'))
}

/** Ogni codice scritto nelle migrazioni video di una cartella (di norma `supabase/migrations`). */
function codiciDelleMigrazioni(cartella: string = MIGRAZIONI): string[] {
  const trovati = new Set<string>()
  for (const nome of fileSqlVideo(cartella)) {
    for (const codice of codiciInSql(readFileSync(join(cartella, nome), 'utf8'))) trovati.add(codice)
  }
  return [...trovati].sort()
}

/** I codici di una lista che il contratto non dichiara: ciò che il lock chiede di dichiarare. */
function nonDichiarati(codici: readonly string[]): string[] {
  return codici.filter((c) => !(CODICI_ESITO_VIDEO as readonly string[]).includes(c))
}

const FONTI: { nome: string; minimo: number; codici: () => string[] }[] = [
  {
    nome: 'src/lib/media/video/limiti.ts → VideoInputSizeErrorCode',
    minimo: 3,
    codici: () =>
      membriUnione(readFileSync(join(VIDEO, 'limiti.ts'), 'utf8'), 'VideoInputSizeErrorCode'),
  },
  {
    nome: 'src/lib/media/video/probe.ts → VideoProbeErrorCode',
    minimo: 10,
    codici: () => membriUnione(readFileSync(join(VIDEO, 'probe.ts'), 'utf8'), 'VideoProbeErrorCode'),
  },
  {
    nome: 'src/lib/media/video/verify.ts → VideoOutputVerificationErrorCode',
    minimo: 15,
    codici: () =>
      membriUnione(readFileSync(join(VIDEO, 'verify.ts'), 'utf8'), 'VideoOutputVerificationErrorCode'),
  },
  {
    // Dal 2026-10-02 NON solo i `code` delle RPC: anche gli `error_code` che SQL scrive da solo
    // sul job, le RAISE che portano un codice e le variabili che lo portano (vedi `codiciInSql`).
    nome: 'supabase/migrations/*_video_*.sql → ogni codice che SQL scrive',
    minimo: 25,
    codici: () => codiciDelleMigrazioni(),
  },
  {
    // LA QUINTA FONTE. È nata dopo le altre quattro, e per un giorno il lock non l'ha
    // scandita: i dieci codici del runner esistevano, non rendevano rosso niente, e
    // `codiceMessaggioVideo()` ripiegava sulla frase generica. Nessun guasto visibile —
    // che è precisamente il motivo per cui sarebbe potuta restare così a lungo.
    nome: 'src/lib/media/video/runner/codici.ts → CODICI_RUNNER_VIDEO',
    minimo: 10,
    codici: () =>
      membriElencoLetterale(
        readFileSync(join(VIDEO, 'runner', 'codici.ts'), 'utf8'),
        'CODICI_RUNNER_VIDEO',
      ),
  },
]

const daTutteLeFonti = (): string[] =>
  [...new Set(FONTI.flatMap((f) => f.codici()))].sort()

/**
 * I CODICI DICHIARATI PRIMA DELLA LORO FONTE — la PR 2 «server e web» (2026-10-02).
 *
 * Il contratto è il primo compito della PR: dichiara il nome, la frase e il numero HTTP dei
 * codici nuovi prima che esista il codice che li produce. Per qualche giro la regola «nessun
 * codice è inventato» troverebbe quei nomi senza una fonte e sarebbe rossa per il motivo
 * sbagliato. Questa mappa è la DEROGA, e perché non diventi il buco che quella regola esiste per
 * impedire ha quattro vincoli, tutti provati più sotto:
 *
 *  · ogni voce dice CHI produrrà il codice, e dove;
 *  · una voce è un codice che il contratto dichiara davvero (non un nome buttato lì);
 *  · il tetto non sale: si toglie una voce quando la sua fonte esiste, e la mappa deve arrivare
 *    a zero. Un tetto che si alza è una deroga che si allarga;
 *  · NON è una scorciatoia per i codici di SQL: quelli li rimisura `codiciDelleMigrazioni` e,
 *    appena una migrazione li scrive, passano dalla regola normale — con o senza questa voce.
 *
 * Alla chiusura della PR (T16) questa mappa va svuotata e il tetto portato a zero: le tre voci
 * sotto sono quelle che nessuna fonte leggibile produceva ancora al momento di scriverla.
 *
 * ⚠️ T2b (2026-10-02) ha tolto `ORIGINALE_DIVERSO` e `ORIGINALE_SOSTITUITO`: la sua migrazione
 * (`…_video_arrivo_originale.sql`) li scrive come `error_code` del job respinto, quindi ora hanno una
 * fonte leggibile (`codiciDelleMigrazioni`) e passano dalla regola normale. Il tetto è sceso da 3 a 1
 * per questo, non perché qualcuno abbia ceduto: resta una sola voce, quella di T7.
 */
const DICHIARATI_IN_ANTICIPO: Record<string, string> = {
  PUBBLICAZIONE_NON_RIUSCITA:
    'T7 (il pubblicatore, in TypeScript, lo passa a `video_intent_pubblicazione_fallita` dopo 60 minuti)',
}
const TETTO_DICHIARATI_IN_ANTICIPO = 1

describe('contratto video · i codici d’errore sono ESAUSTIVI per costruzione', () => {
  it('la misura vede davvero le fonti (controllo positivo dell’estrattore)', () => {
    // Senza questo, «zero codici trovati» e «zero codici mancanti» avrebbero lo
    // stesso colore: il modo più silenzioso di non controllare niente.
    for (const fonte of FONTI) {
      const codici = fonte.codici()
      expect(codici.length, `${fonte.nome}: l’estrattore non trova più i codici`).toBeGreaterThanOrEqual(
        fonte.minimo,
      )
    }

    // E l'estrattore deve saper leggere una forma, non qualunque cosa.
    const finto = [
      "export type Uno = 'A' | 'B'",
      '',
      'export type Due =',
      '  | Altro',
      "  | 'C'",
      '',
    ].join('\n')
    expect(membriUnione(finto, 'Uno')).toEqual(['A', 'B'])
    expect(membriUnione(finto, 'Due'), 'un riferimento a un tipo non è un codice').toEqual(['C'])
    expect(membriUnione(finto, 'MaiDichiarato')).toEqual([])
  })

  it('ogni codice prodotto da una fonte è DICHIARATO nel contratto', () => {
    const mancanti = daTutteLeFonti().filter(
      (codice) => !(CODICI_ESITO_VIDEO as readonly string[]).includes(codice),
    )
    expect(
      mancanti,
      'Questi codici escono da una fonte della pipeline (limiti/probe/verify, una RPC o il ' +
      'runner, o un `error_code` / una RAISE scritti in SQL) e non sono ' +
        'in `CODICI_ESITO_VIDEO`. Il client non saprebbe tradurli e ricadrebbe sulla prosa del ' +
        'server: dichiarali nel contratto, dai a ciascuno una destinazione in ' +
        '`MAPPA_MESSAGGIO_VIDEO` e un numero HTTP in `STATO_HTTP_VIDEO` ' +
        '(`src/app/api/video-uploads/risposte.ts`), e aggiungili alla tabella `DESTINAZIONI` qui sotto.',
    ).toEqual([])
  })

  it('la copertura delle due fonti TIPIZZATE la verifica il compilatore', () => {
    // `COPERTURA_CODICI_TIPIZZATI` vale `true` solo se l'elenco copre ogni
    // membro di `VideoProbeErrorCode` e `VideoOutputVerificationErrorCode`:
    // se una delle due unioni cresce, il file non compila più. Questa riga
    // esiste perché quella prova sia VISIBILE anche a chi legge i test, e non
    // solo a `tsc --noEmit`.
    expect(COPERTURA_CODICI_TIPIZZATI).toBe(true)
  })

  it('e nessun codice è INVENTATO: ogni voce dell’elenco viene da una fonte', () => {
    const fonti = daTutteLeFonti()
    const orfani = [...CODICI_ESITO_VIDEO].filter(
      (codice) => !fonti.includes(codice) && !(codice in DICHIARATI_IN_ANTICIPO),
    )
    expect(
      orfani,
      'Questi codici sono dichiarati in `CODICI_ESITO_VIDEO` ma nessuna fonte li produce più. Un ' +
        'elenco più largo della misura non protegge niente: toglili, oppure — se nascono al bordo ' +
        'API e non altrove — spostali in `CODICI_BORDO_VIDEO`, che è l’elenco dichiarato apposta. ' +
        'Se sono codici della PR 2 la cui fonte non è ancora stata scritta, la deroga è ' +
        '`DICHIARATI_IN_ANTICIPO` qui sopra — con chi li produrrà e un tetto che non sale.',
    ).toEqual([])
  })

  it('la DEROGA dei codici dichiarati in anticipo non si allarga: nomina chi li produce e non sale', () => {
    const voci = Object.entries(DICHIARATI_IN_ANTICIPO)
    // Ogni voce è un codice che il contratto dichiara davvero…
    for (const [codice, produttore] of voci) {
      expect(
        CODICI_ESITO_VIDEO as readonly string[],
        `${codice} è in deroga ma il contratto non lo dichiara: una deroga per un nome inesistente non copre niente`,
      ).toContain(codice)
      // …e dice chi lo produrrà: una deroga senza un responsabile è un debito senza creditore.
      expect(produttore.trim().length, `${codice}: manca chi lo produrrà`).toBeGreaterThan(20)
    }
    // Il tetto SCENDE e basta, e va a zero quando le fonti esistono (T16). Se scende, si scrive qui
    // accanto perché: era 3 (il trigger d’arrivo di T2b per due codici, il pubblicatore di T7 per
    // uno); T2b ha scritto la sua migrazione e ora ne resta UNA, quella che nessuna fonte leggibile
    // produce ancora (il pubblicatore di T7).
    expect(
      voci.length,
      'la deroga dei codici in anticipo è cresciuta: è il buco che la regola dei codici inventati ' +
        'esiste per chiudere. Il codice nuovo ha una fonte? Allora non serve una voce qui.',
    ).toBeLessThanOrEqual(TETTO_DICHIARATI_IN_ANTICIPO)
  })

  it('i codici del BORDO sono pochi, dichiarati e non si sovrappongono alle fonti', () => {
    // I codici di bordo non esistono in nessuna fonte: nascono nelle route. Se
    // uno di loro comparisse anche in una fonte, ci sarebbero due autorità sullo
    // stesso nome — e il primo a cambiare romperebbe l'altro in silenzio.
    const fonti = daTutteLeFonti()
    const doppi = [...CODICI_BORDO_VIDEO].filter((codice) => fonti.includes(codice))
    expect(doppi, 'un codice di bordo che una fonte produce davvero non è un codice di bordo').toEqual([])
    expect(CODICI_BORDO_VIDEO).toContain('CLIENT_UPDATE_REQUIRED')
  })
})

describe('contratto video · che cosa legge una famiglia, e che cosa resta interno', () => {
  it('ogni codice interno ha una destinazione DICHIARATA, e nessuna è inventata', () => {
    const interni = [...CODICI_ESITO_VIDEO, ...CODICI_BORDO_VIDEO]
    const senzaDestinazione = interni.filter(
      (codice) => !(codice in (MAPPA_MESSAGGIO_VIDEO as Record<string, string>)),
    )
    expect(
      senzaDestinazione,
      'Questi codici non hanno una voce in `MAPPA_MESSAGGIO_VIDEO`: la mappatura fra ciò che ' +
        'produce la pipeline e ciò che legge una famiglia deve essere esplicita, mai implicita.',
    ).toEqual([])

    const destinazioniIgnote = Object.entries(MAPPA_MESSAGGIO_VIDEO as Record<string, string>)
      .filter(([, mostrato]) => !(CODICI_MOSTRATI_VIDEO as readonly string[]).includes(mostrato))
      .map(([codice, mostrato]) => `${codice} → ${mostrato}`)
    expect(destinazioniIgnote, 'destinazione non dichiarata in `CODICI_MOSTRATI_VIDEO`').toEqual([])

    const inPiu = Object.keys(MAPPA_MESSAGGIO_VIDEO as Record<string, string>).filter(
      (codice) => !interni.includes(codice as (typeof interni)[number]),
    )
    expect(inPiu, 'voci della mappa che non corrispondono a nessun codice interno').toEqual([])
  })

  it('il rumore tecnico NON arriva alla famiglia con un messaggio suo', () => {
    // `INTENT_CHANGED_RETRY`, i lease, il fence, i conflitti di scrittura: sono
    // il vocabolario del protocollo di coda, non un'informazione per chi ha
    // caricato un video. Devono cadere tutti sullo stesso «riprova», altrimenti
    // il primo che scrive la schermata li traduce uno per uno e il genitore si
    // ritrova a leggere l'architettura.
    const tecnici = [
      'INTENT_CHANGED_RETRY',
      'FENCE_MISMATCH',
      'LEASE_ACTIVE',
      'LEASE_EXPIRED',
      'LEASE_MISMATCH',
      'OUTPUT_CONFLICT',
      'SOURCE_CONFLICT',
      'ERROR_CONFLICT',
      'UNIQUE_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'REVISION_TAKEN',
      'ORIGINAL_PATH_TAKEN',
      // Il «non ancora» di `video_job_claim` su un job che aspetta il ritentativo: parla un
      // runner, e se mai arrivasse a uno schermo l'unica cosa vera da dire è «riprova».
      'RETRY_NOT_DUE',
    ]
    const mappa = MAPPA_MESSAGGIO_VIDEO as Record<string, string>
    for (const codice of tecnici) {
      expect(mappa[codice], `${codice} è rumore tecnico: va mandato su VIDEO_RIPROVA`).toBe(
        'VIDEO_RIPROVA',
      )
    }
  })

  it('i codici che cambiano ciò che l’utente può FARE hanno un messaggio proprio', () => {
    const mappa = MAPPA_MESSAGGIO_VIDEO as Record<string, string>
    expect(mappa.FILE_TOO_LARGE).toBe('VIDEO_TROPPO_GRANDE')
    expect(mappa.VIDEO_TOO_LONG).toBe('VIDEO_TROPPO_LUNGO')
    expect(mappa.ENCRYPTED_VIDEO).toBe('VIDEO_PROTETTO')
    expect(mappa.UNSUPPORTED_VIDEO_CODEC).toBe('VIDEO_FORMATO_NON_SUPPORTATO')
    expect(mappa.UNSUPPORTED_CONTAINER).toBe('VIDEO_FORMATO_NON_SUPPORTATO')
    expect(mappa.CLIENT_UPDATE_REQUIRED).toBe('VIDEO_APP_DA_AGGIORNARE')
    // La sede ambigua ha già il suo codice in tutta l'app: non se ne inventa un
    // secondo per la pipeline video (`rifiutoSede` → `SEDE_DA_SPECIFICARE`).
    expect(mappa.SCOPE_REQUIRED).toBe('SEDE_DA_SPECIFICARE')
    // Ogni esito di `verifyVideoOutput` è un guasto della conversione: non c'è
    // niente che una famiglia possa fare con `OUTPUT_DURATION_MISMATCH`.
    const daVerify = membriUnione(
      readFileSync(join(VIDEO, 'verify.ts'), 'utf8'),
      'VideoOutputVerificationErrorCode',
    )
    for (const codice of daVerify) {
      expect(mappa[codice], `${codice} è un esito della verifica dell’uscita`).toBe(
        'VIDEO_CONVERSIONE_NON_RIUSCITA',
      )
    }
  })

  it('un codice SCONOSCIUTO non fa sparire il messaggio: cade sul ripiego', () => {
    // Il server può sempre mandare qualcosa che questo contratto non conosce —
    // un errore di PostgREST, una RPC nuova non ancora rilasciata al client.
    // Restituire `undefined` vorrebbe dire schermata muta, che è il silenzio da
    // cui nasce tutta questa storia.
    expect(codiceMessaggioVideo('CODICE_MAI_VISTO')).toBe(CODICE_VIDEO_DI_RIPIEGO)
    expect(codiceMessaggioVideo('PGRST204')).toBe(CODICE_VIDEO_DI_RIPIEGO)
    expect(codiceMessaggioVideo(null)).toBe(CODICE_VIDEO_DI_RIPIEGO)
    expect(codiceMessaggioVideo(undefined)).toBe(CODICE_VIDEO_DI_RIPIEGO)
    expect(codiceMessaggioVideo('')).toBe(CODICE_VIDEO_DI_RIPIEGO)
    // …e un codice conosciuto viene tradotto davvero (senza questa riga, un
    // ripiego che risponde sempre sarebbe verde).
    expect(codiceMessaggioVideo('FILE_TOO_LARGE')).toBe('VIDEO_TROPPO_GRANDE')
    expect(codiceMessaggioVideo('ENCRYPTED_VIDEO')).toBe('VIDEO_PROTETTO')
  })
})

/**
 * I GUASTI NOSTRI, E CHE COSA LEGGE CHI ASPETTA MENTRE SI RITENTA.
 *
 * Dal 29/09/2026 nessun video si convertiva, e a chi caricava il filmato la schermata non
 * diceva niente di vero: «il file sembra rovinato», oppure «riprova» — due frasi che
 * mettevano la colpa sul suo telefono quando il guasto era una release di FFmpeg sparita dal
 * server di un terzo. Qui si tiene ferma la distinzione che manca: i codici in cui il
 * filmato NON c'entra dicono «problema nostro», quelli in cui c'entra restano com'erano.
 */
const GUASTI_DI_INFRASTRUTTURA = [
  'BUILD_DOWNLOAD_FAILED',
  'BUILD_HASH_MISMATCH',
  'BUILD_EXTRACT_FAILED',
  'BUILD_INCOMPLETE',
  'SANDBOX_UNAVAILABLE',
  'SOURCE_DOWNLOAD_FAILED',
  'OUTPUT_UPLOAD_FAILED',
] as const

/** I tre che restano com'erano: il file c'entra, o riprovare non cambierebbe niente. */
const CODICI_RUNNER_DEL_FILE = {
  PROBE_COMMAND_FAILED: 'VIDEO_NON_LEGGIBILE',
  ENCODE_FAILED: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  CONVERSION_TIMEOUT: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
} as const

describe('contratto video · i guasti NOSTRI dicono «problema nostro», non «il file è rovinato»', () => {
  it('i sette codici di infrastruttura del runner portano a VIDEO_GUASTO_NOSTRO', () => {
    const mappa = MAPPA_MESSAGGIO_VIDEO as Record<string, string>
    for (const codice of GUASTI_DI_INFRASTRUTTURA) {
      expect(
        mappa[codice],
        `${codice} è un guasto dell'infrastruttura: il filmato non c'entra, e la frase deve dirlo`,
      ).toBe('VIDEO_GUASTO_NOSTRO')
      // …e `codiceMessaggioVideo` lo traduce davvero (senza questa riga una mappa ignorata
      // dal traduttore sarebbe verde).
      expect(codiceMessaggioVideo(codice)).toBe('VIDEO_GUASTO_NOSTRO')
    }
  })

  it('i tre codici in cui il file c’entra restano quelli di prima', () => {
    const mappa = MAPPA_MESSAGGIO_VIDEO as Record<string, string>
    for (const [codice, atteso] of Object.entries(CODICI_RUNNER_DEL_FILE)) {
      expect(mappa[codice], `${codice} non è un guasto nostro`).toBe(atteso)
    }
  })

  it('OGNI codice del runner è dichiarato «nostro» o «del file»: uno nuovo obbliga a deciderlo', () => {
    // Il lock di esaustività sa già che un codice del runner NON dichiarato rende rosso il
    // contratto. Questo sa l'altra metà: che chi lo dichiara decida anche di CHI è la colpa —
    // altrimenti il nome nuovo finirebbe sulla frase del file per inerzia, che è l'errore
    // da cui nasce questa distinzione.
    const dalRunner = membriElencoLetterale(
      readFileSync(join(VIDEO, 'runner', 'codici.ts'), 'utf8'),
      'CODICI_RUNNER_VIDEO',
    )
    // I codici che il runner può produrre DALLA PR 2, tutti del FILE: lo `sha256` dichiarato che
    // non torna fa uscire lo script con un codice nuovo, mappato su `ORIGINALE_DIVERSO`, classe
    // `file` (T8, §10.4: mai ritentato). Sono OPZIONALI nell'elenco del runner — fino a T8 non ci
    // sono — e se ci sono devono avere la destinazione decisa qui: nessuno dei due casi rende
    // rosso questo test, e nessun compito del runner deve toccare il contratto per entrarci.
    const DEL_FILE_DELLA_PR2: Record<string, string> = { ORIGINALE_DIVERSO: 'VIDEO_ORIGINALE_NON_COINCIDE' }
    const dichiarati = new Set<string>([
      ...GUASTI_DI_INFRASTRUTTURA,
      ...Object.keys(CODICI_RUNNER_DEL_FILE),
      ...Object.keys(DEL_FILE_DELLA_PR2),
    ])
    expect(dalRunner.length, 'l’estrattore non vede più i codici del runner').toBeGreaterThanOrEqual(10)
    expect(
      dalRunner.filter((codice) => !dichiarati.has(codice)),
      'Codici del runner senza una decisione «guasto nostro / guasto del file»: aggiungili a ' +
        '`GUASTI_DI_INFRASTRUTTURA` o a `CODICI_RUNNER_DEL_FILE` qui sopra, e dai loro la ' +
        'destinazione giusta in `MAPPA_MESSAGGIO_VIDEO`.',
    ).toEqual([])
    expect(
      [...dichiarati].filter((codice) => !dalRunner.includes(codice) && !(codice in DEL_FILE_DELLA_PR2)),
    ).toEqual([])
    // Se il runner li produce, la loro frase è quella del file arrivato diverso, non una a caso.
    for (const [codice, atteso] of Object.entries(DEL_FILE_DELLA_PR2)) {
      expect((MAPPA_MESSAGGIO_VIDEO as Record<string, string>)[codice], codice).toBe(atteso)
    }
  })

  it('VIDEO_GUASTO_NOSTRO è un codice mostrabile, con la sua chiave e la sua frase', () => {
    expect(CODICI_MOSTRATI_VIDEO).toContain('VIDEO_GUASTO_NOSTRO')
    expect(CHIAVI_MESSAGGIO_VIDEO.VIDEO_GUASTO_NOSTRO).toBe('erroreVideoGuastoNostro')
    // Il codice interno non si confonde con la frase a schermo: lo schema dello stato lo
    // accetta SOLO perché è fra i mostrabili.
    expect(
      schemaStatoJobVideo.safeParse({
        jobId: '40000000-0000-4000-8000-000000000004',
        intentId: '30000000-0000-4000-8000-000000000003',
        canale: 'gallery',
        stato: 'failed',
        avanzamento: null,
        codice: 'VIDEO_GUASTO_NOSTRO',
        aggiornatoIl: '2026-10-02T10:00:00.000Z',
      }).success,
    ).toBe(true)
  })

  it('RETRY_NOT_DUE è quello della migrazione dei ritentativi, e il lock lo VEDE', () => {
    // La migrazione si chiama `…_video_job_ritentativi.sql` apposta: il lock di esaustività
    // legge solo i file `*_video_*.sql`, e un nome che perdesse quel pezzo lo renderebbe cieco
    // — con tutto verde. Qui si prova che la fonte esiste, che dice proprio questo nome, e che
    // l'estrattore lo trova.
    const migrazione = readdirSync(MIGRAZIONI).find((n) => /_video_job_ritentativi\.sql$/.test(n))
    expect(migrazione, 'la migrazione dei ritentativi non è più fra quelle che il lock legge').toBeTruthy()
    const sql = readFileSync(join(MIGRAZIONI, migrazione as string), 'utf8')
    expect(sql).toMatch(/'code'\s*,\s*'RETRY_NOT_DUE'/)
    expect(codiciDelleMigrazioni()).toContain('RETRY_NOT_DUE')
    expect(CODICI_ESITO_VIDEO as readonly string[]).toContain('RETRY_NOT_DUE')
    expect((MAPPA_MESSAGGIO_VIDEO as Record<string, string>).RETRY_NOT_DUE).toBe('VIDEO_RIPROVA')
  })
})

describe('contratto video · «lo stiamo riprovando» (riprovaAutomatica)', () => {
  const base = {
    jobId: '40000000-0000-4000-8000-000000000004',
    intentId: '30000000-0000-4000-8000-000000000003',
    canale: 'gallery' as const,
    stato: 'queued' as string,
    avanzamento: 25 as number | null,
    codice: null as string | null,
    aggiornatoIl: '2026-10-02T10:00:00.000Z',
  }

  it('manca nel corpo? vale false: un server più vecchio del client non rompe la scheda', () => {
    const esito = schemaStatoJobVideo.safeParse(base)
    expect(esito.success).toBe(true)
    expect(esito.data?.riprovaAutomatica).toBe(false)
  })

  it('un job in coda o in lavorazione può essere in ritentativo', () => {
    for (const stato of ['queued', 'processing']) {
      const esito = schemaStatoJobVideo.safeParse({ ...base, stato, riprovaAutomatica: true })
      expect(esito.success, `${stato}: ${JSON.stringify(esito.error?.issues ?? [])}`).toBe(true)
      expect(esito.data?.riprovaAutomatica).toBe(true)
    }
  })

  it('in ogni altro stato è una bugia, e lo schema la rifiuta', () => {
    // «Lo stiamo riprovando» su un video già pronto, già fallito o ritirato direbbe che
    // qualcosa sta ancora succedendo. Si controllano TUTTI gli altri stati, non uno solo.
    for (const stato of STATI_JOB_VIDEO.filter((s) => s !== 'queued' && s !== 'processing')) {
      const fallito = stato === 'failed' || stato === 'rejected'
      const esito = schemaStatoJobVideo.safeParse({
        ...base,
        stato,
        avanzamento: avanzamentoDaStatoVideo(stato),
        codice: fallito ? 'VIDEO_GUASTO_NOSTRO' : null,
        riprovaAutomatica: true,
      })
      expect(esito.success, `${stato} ha accettato riprovaAutomatica: true`).toBe(false)
    }
  })

  it('un job che si sta ritentando non porta un codice d’errore: non è ancora fallito', () => {
    expect(
      schemaStatoJobVideo.safeParse({
        ...base,
        riprovaAutomatica: true,
        codice: 'VIDEO_GUASTO_NOSTRO',
      }).success,
    ).toBe(false)
  })

  it('il nome interno della causa NON esce: lo schema scarta `last_error_code`', () => {
    // La persona legge «è un problema nostro»; `BUILD_DOWNLOAD_FAILED` resta in `app_log`.
    const esito = schemaStatoJobVideo.safeParse({
      ...base,
      riprovaAutomatica: true,
      last_error_code: 'BUILD_DOWNLOAD_FAILED',
      next_attempt_at: '2026-10-02T10:05:00.000Z',
    })
    expect(esito.success).toBe(true)
    expect(JSON.stringify(esito.data)).not.toContain('BUILD_DOWNLOAD_FAILED')
    expect(Object.keys(esito.data as object)).not.toContain('last_error_code')
  })

  describe('riprovaAutomaticaInCorso(stato, attempt)', () => {
    // La tabella è scritta per ESTESO, non ricavata con la stessa regola del codice: un test
    // che ricalcola la formula è verde anche quando la formula è sbagliata.
    const VERI = new Set([
      'queued:1',
      'queued:2',
      'queued:3',
      'queued:4',
      'processing:2',
      'processing:3',
      'processing:4',
    ])

    it.each(STATI_JOB_VIDEO.flatMap((stato) => [0, 1, 2, 3, 4].map((attempt) => [stato, attempt] as const)))(
      '%s con attempt %i',
      (stato, attempt) => {
        expect(riprovaAutomaticaInCorso(stato, attempt)).toBe(VERI.has(`${stato}:${attempt}`))
      },
    )

    it('un caricamento appena arrivato NON è un ritentativo: `queued` con attempt 0', () => {
      // È l'unico modo in cui `video_job_uploaded` mette un job in coda. Promettere
      // «lo stiamo riprovando» a chi ha appena premuto «carica» sarebbe falso.
      expect(riprovaAutomaticaInCorso('queued', 0)).toBe(false)
      // Il primo giro del runner è `processing` con attempt 1: ancora il primo tentativo.
      expect(riprovaAutomaticaInCorso('processing', 1)).toBe(false)
    })

    it('un attempt assente, non numerico o negativo non promette niente', () => {
      // Una riga letta male vale 0, e 0 non è un ritentativo: nel dubbio non si promette
      // un lavoro che potrebbe non esserci. `Infinity` è non finito, quindi anche lui.
      for (const attempt of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        expect(riprovaAutomaticaInCorso('queued', attempt), `queued con ${String(attempt)}`).toBe(false)
        expect(riprovaAutomaticaInCorso('processing', attempt), `processing con ${String(attempt)}`).toBe(false)
      }
    })
  })
})

describe('contratto video · i messaggi esistono nelle due lingue e parlano alle famiglie', () => {
  it('ogni codice mostrato ha una chiave, e la chiave ha un testo in `it` e in `en`', () => {
    const senzaChiave = [...CODICI_MOSTRATI_VIDEO].filter(
      (codice) => !(CHIAVI_MESSAGGIO_VIDEO as Record<string, string>)[codice]?.trim(),
    )
    expect(senzaChiave, 'codice mostrato senza chiave di catalogo').toEqual([])

    const senzaTesto: string[] = []
    for (const [codice, chiave] of Object.entries(CHIAVI_MESSAGGIO_VIDEO as Record<string, string>)) {
      if (!catIt[chiave]?.trim()) senzaTesto.push(`${codice} → messages/it/shared.json:${chiave}`)
      if (!catEn[chiave]?.trim()) senzaTesto.push(`${codice} → messages/en/shared.json:${chiave}`)
    }
    expect(
      senzaTesto,
      'Codice dichiarato ma senza voce di catalogo: in quella lingua la famiglia leggerebbe la ' +
        'prosa italiana del server, o il nome della chiave.',
    ).toEqual([])
  })

  it('i due tetti citati nei messaggi vengono dalle COSTANTI, non da una memoria', () => {
    // Un messaggio che dice «3 minuti» mentre il tetto è passato a 5 manda la
    // famiglia contro un muro con la sicurezza di chi la sta aiutando. Qui i due
    // numeri si ricavano da `limiti.ts`: se il tetto cambia, questo diventa
    // rosso e il catalogo va riscritto insieme al codice.
    const minuti = String(Math.round(MAX_VIDEO_DURATION_SECONDS / 60))
    const gigabyte = String(Math.round(MAX_VIDEO_INPUT_BYTES / 1_000_000_000))
    const chiavi = CHIAVI_MESSAGGIO_VIDEO as Record<string, string>

    for (const cat of [catIt, catEn]) {
      // «3 minut…» copre l'italiano e l'inglese senza fingere di tradurre.
      expect(cat[chiavi.VIDEO_TROPPO_LUNGO]).toMatch(new RegExp(`\\b${minuti} minut`, 'i'))
      expect(cat[chiavi.VIDEO_TROPPO_GRANDE]).toMatch(new RegExp(`\\b${gigabyte} GB\\b`))
    }
  })

  it('nessun messaggio mostra il vocabolario della pipeline', () => {
    // «OUTPUT_DURATION_MISMATCH» non dice niente a un genitore; «ffmpeg»,
    // «bucket», «lease» nemmeno. Il nome tecnico vive nel log, dove serve.
    const tecnicismi =
      /\b(ffmpeg|ffprobe|bucket|lease|fence|intent|job|payload|rpc|postgrest|codec|uuid|null|token|tus)\b/i
    const guasti: string[] = []
    for (const [codice, chiave] of Object.entries(CHIAVI_MESSAGGIO_VIDEO as Record<string, string>)) {
      for (const [lingua, cat] of [
        ['it', catIt],
        ['en', catEn],
      ] as const) {
        const testo = cat[chiave] ?? ''
        const tecnico = testo.match(tecnicismi)
        if (tecnico) guasti.push(`${lingua}/${chiave} (${codice}) → «${tecnico[0]}»`)
        if (/[A-Z]{3,}_[A-Z]/.test(testo)) guasti.push(`${lingua}/${chiave} (${codice}) → un codice a schermo`)
      }
    }
    expect(guasti, 'Un messaggio per le famiglie non nomina i meccanismi interni.').toEqual([])
  })

  describe('i tre testi del guasto nostro sono quelli decisi dal titolare', () => {
    // Si confrontano con la stringa SCRITTA QUI e non con il catalogo importato: un test che
    // legge il catalogo e lo confronta con sé stesso è verde anche con la frase sbagliata.
    const TESTI = [
      {
        dove: 'shared.erroreVideoGuastoNostro',
        it: catIt.erroreVideoGuastoNostro,
        en: catEn.erroreVideoGuastoNostro,
        attesoIt:
          'Non siamo riusciti a preparare questo video per un problema nostro, non del filmato. Caricalo di nuovo più tardi: se non va ancora, avvisa la segreteria.',
        attesoEn:
          'We could not prepare this video because of a problem on our side, not with the clip. Please upload it again later: if it still does not work, let the office know.',
      },
      {
        dove: 'teacherServizi.galleryVideoRiprovaAutomatica',
        it: itServizi.galleryVideoRiprovaAutomatica,
        en: enServizi.galleryVideoRiprovaAutomatica,
        attesoIt:
          'Il problema è nostro, non del video: lo stiamo riprovando in automatico. Non serve caricarlo di nuovo, e puoi chiudere l’app.',
        attesoEn:
          'The problem is on our side, not with the video: we are retrying automatically. There is no need to upload it again, and you can close the app.',
      },
      {
        dove: 'adminComunicazioni.videoStatoRiprovaAutomatica',
        it: itComunicazioni.videoStatoRiprovaAutomatica,
        en: enComunicazioni.videoStatoRiprovaAutomatica,
        attesoIt: 'Problema nostro, non del video: riproviamo in automatico.',
        attesoEn: 'A problem on our side, not with the video: retrying automatically.',
      },
    ] as const

    it('italiano e inglese, parola per parola', () => {
      for (const t of TESTI) {
        expect(t.it, `${t.dove} (it)`).toBe(t.attesoIt)
        expect(t.en, `${t.dove} (en)`).toBe(t.attesoEn)
      }
    })

    it('apostrofo tipografico in italiano, nessuna contrazione in inglese', () => {
      // `l’app` con U+2019: l'apostrofo dritto è vietato dal lock dei cataloghi, ma qui si
      // prova che il testo nuovo lo rispetta DAVVERO (e non solo che il lock è verde).
      expect(itServizi.galleryVideoRiprovaAutomatica).toContain('l’app')
      for (const t of TESTI) {
        expect(t.it, `${t.dove} (it) ha un apostrofo dritto`).not.toContain("'")
        expect(t.en, `${t.dove} (en) ha una contrazione`).not.toMatch(/\w['’]\w/)
      }
    })

    it('nessuno dei tre nomina i meccanismi interni (anche i due che non stanno in `shared`)', () => {
      const tecnicismi =
        /\b(ffmpeg|ffprobe|bucket|lease|fence|intent|job|payload|rpc|postgrest|codec|uuid|null|token|tus|runner|sandbox|microvm|server)\b/i
      for (const t of TESTI) {
        for (const [lingua, testo] of [['it', t.it], ['en', t.en]] as const) {
          expect(testo.match(tecnicismi), `${t.dove} (${lingua}) nomina un meccanismo interno`).toBeNull()
          expect(/[A-Z]{3,}_[A-Z]/.test(testo), `${t.dove} (${lingua}) mostra un codice`).toBe(false)
        }
      }
    })
  })
})

describe('contratto video · gli schemi zod tengono il bordo', () => {
  const apertura = {
    canale: 'gallery' as const,
    azione: 'publish' as const,
    scuolaId: '10000000-0000-4000-8000-000000000001',
    ambitoGlobale: false,
    targetId: null,
    versioneTargetAttesa: null,
    file: [
      {
        chiaveIdempotenza: 'abc-123',
        nome: 'recita.mov',
        byte: 12_345_678,
        mime: 'video/quicktime',
        durataSecondi: 42.5,
      },
    ],
  }

  it('una richiesta di apertura ben formata passa', () => {
    const esito = schemaAperturaIntentVideo.safeParse(apertura)
    expect(esito.success, JSON.stringify(esito.error?.issues ?? [])).toBe(true)
  })

  it('il MIME col suffisso dei codec è ammesso (`video/mp4;codecs=avc1`)', () => {
    // Lezione pagata il 2026-09-09 sulla galleria: `MediaRecorder` scrive il
    // MIME col suffisso, e un confronto esatto respinge un file valido.
    const esito = schemaAperturaIntentVideo.safeParse({
      ...apertura,
      file: [{ ...apertura.file[0], mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' }],
    })
    expect(esito.success, JSON.stringify(esito.error?.issues ?? [])).toBe(true)
  })

  it('la Galleria accetta UN video per intent, non due', () => {
    // È il vincolo `SINGLE_JOB_CHANNEL` della RPC: qui si respinge prima di
    // aprire l'intent, invece di scoprirlo dopo aver scritto una riga.
    const esito = schemaAperturaIntentVideo.safeParse({
      ...apertura,
      file: [apertura.file[0], { ...apertura.file[0], chiaveIdempotenza: 'abc-456' }],
    })
    expect(esito.success).toBe(false)
  })

  it('due file con la stessa chiave di idempotenza sono rifiutati', () => {
    const esito = schemaAperturaIntentVideo.safeParse({
      ...apertura,
      canale: 'news',
      file: [apertura.file[0], { ...apertura.file[0] }],
    })
    expect(esito.success).toBe(false)
  })

  it('oltre i tetti di `limiti.ts` non si apre nemmeno l’intent', () => {
    for (const file of [
      { ...apertura.file[0], byte: MAX_VIDEO_INPUT_BYTES + 1 },
      { ...apertura.file[0], byte: 0 },
      { ...apertura.file[0], byte: 1.5 },
      { ...apertura.file[0], durataSecondi: MAX_VIDEO_DURATION_SECONDS + 0.5 },
      { ...apertura.file[0], durataSecondi: 0 },
    ]) {
      expect(
        schemaAperturaIntentVideo.safeParse({ ...apertura, file: [file] }).success,
        `accettato: ${JSON.stringify(file)}`,
      ).toBe(false)
    }
    // Il limite è INCLUSIVO da entrambe le parti: «fino a 2.000.000.000 byte e
    // 300 secondi inclusi» (cinque minuti, dal 2026-10-02) è il requisito del piano, non
    // un'approssimazione. I numeri nudi, scritti per esteso, stanno in «i tetti sono quelli
    // decisi dal titolare» più sotto: qui si misura il confine con le costanti.
    expect(
      schemaAperturaIntentVideo.safeParse({
        ...apertura,
        file: [
          {
            ...apertura.file[0],
            byte: MAX_VIDEO_INPUT_BYTES,
            durataSecondi: MAX_VIDEO_DURATION_SECONDS,
          },
        ],
      }).success,
    ).toBe(true)
  })

  it('una scrittura senza sede passa solo se dichiara l’ambito globale, e solo su News', () => {
    // `video_intents_scuola_scope_chk`: `scuola_id` NULL è ammesso soltanto per
    // una News che abbia dichiarato `scope = global`. Una Galleria senza sede
    // finirebbe nel plesso sbagliato in silenzio, ed è il difetto che
    // `resolveScuolaScrittura` esiste per impedire.
    expect(
      schemaAperturaIntentVideo.safeParse({ ...apertura, scuolaId: null }).success,
      'una Galleria senza sede è stata accettata',
    ).toBe(false)
    expect(
      schemaAperturaIntentVideo.safeParse({ ...apertura, canale: 'news', scuolaId: null }).success,
      'una News senza sede e senza ambito globale è stata accettata',
    ).toBe(false)
    expect(
      schemaAperturaIntentVideo.safeParse({
        ...apertura,
        canale: 'news',
        scuolaId: null,
        ambitoGlobale: true,
      }).success,
    ).toBe(true)
    expect(
      schemaAperturaIntentVideo.safeParse({ ...apertura, ambitoGlobale: true }).success,
      'l’ambito globale è stato accettato su una Galleria',
    ).toBe(false)
  })

  it('canale, azione e stato sono elenchi CHIUSI', () => {
    expect(schemaAperturaIntentVideo.safeParse({ ...apertura, canale: 'diario' }).success).toBe(false)
    expect(schemaAperturaIntentVideo.safeParse({ ...apertura, azione: 'cancella' }).success).toBe(false)
    expect([...CANALI_VIDEO]).toEqual(['gallery', 'news'])
    expect([...AZIONI_INTENT_VIDEO]).toEqual([
      'attach_private',
      'submit_proposal',
      'publish',
      'schedule',
    ])
    expect([...STATI_JOB_VIDEO]).toEqual([
      'awaiting_upload',
      'queued',
      'processing',
      'ready',
      'rejected',
      'failed',
      'cancelled',
    ])
  })

  it('l’esito dell’apertura porta coordinate d’upload utilizzabili', () => {
    const esito = {
      intentId: '30000000-0000-4000-8000-000000000003',
      revisione: 1,
      canale: 'gallery' as const,
      scadenzaCaricamentoIl: '2026-09-18T10:00:00.000Z',
      job: [
        {
          jobId: '40000000-0000-4000-8000-000000000004',
          chiaveIdempotenza: 'abc-123',
          caricamento: {
            protocollo: 'tus' as const,
            endpoint: 'https://uimulkjyekgemjakmepp.supabase.co/storage/v1/upload/resumable',
            bucket: 'video_originals' as const,
            percorso: '20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000004.mov',
            contentType: 'video/quicktime',
            dimensioneBloccoByte: 6 * 1024 * 1024,
          },
          // Senza la firma il client ha un indirizzo e nessuna chiave: le coordinate da
          // sole non aprono niente. Dichiarata nel contratto il 2026-09-18, dopo che la
          // route la restituiva gia' e `z.object` la scartava in silenzio.
          firma: 'firma-di-prova-non-e-un-segreto',
        },
      ],
    }
    expect(schemaEsitoAperturaIntentVideo.safeParse(esito).success).toBe(true)

    // Un endpoint in chiaro spedirebbe il video di un bambino su HTTP.
    const inChiaro = structuredClone(esito)
    inChiaro.job[0].caricamento.endpoint = 'http://esempio.invalid/upload'
    expect(schemaEsitoAperturaIntentVideo.safeParse(inChiaro).success).toBe(false)

    // Un percorso che risale fuori dalla cartella dell'utente non è un percorso.
    const risalita = structuredClone(esito)
    risalita.job[0].caricamento.percorso = '../altro-utente/segreto.mov'
    expect(schemaEsitoAperturaIntentVideo.safeParse(risalita).success).toBe(false)

    // Il blocco TUS è UN VALORE SOLO, non un intervallo. Fino al 2026-09-18 lo schema
    // ammetteva 1–64 MiB, e la documentazione di Supabase Storage dice invece «it must be
    // set to 6MB (for now) do not change it»: ogni altro valore è un upload che il servizio
    // rifiuta al primo blocco, DOPO che un genitore ha già iniziato a caricare da un telefono.
    // I due vicini sono la prova che serve: 5 MiB e 8 MiB passavano entrambi, ieri.
    for (const sbagliata of [5 * 1024 * 1024, 8 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024]) {
      const blocco = structuredClone(esito)
      blocco.job[0].caricamento.dimensioneBloccoByte = sbagliata
      expect(
        schemaEsitoAperturaIntentVideo.safeParse(blocco).success,
        `${sbagliata} byte non è la dimensione di blocco che Supabase Storage accetta: ` +
          `l'unica è DIMENSIONE_BLOCCO_TUS_BYTE (${DIMENSIONE_BLOCCO_TUS_BYTE}).`,
      ).toBe(false)
    }
    expect(DIMENSIONE_BLOCCO_TUS_BYTE).toBe(6 * 1024 * 1024)
  })

  it('lo stato letto in polling non mescola «in corso» ed «errore»', () => {
    const base = {
      jobId: '40000000-0000-4000-8000-000000000004',
      intentId: '30000000-0000-4000-8000-000000000003',
      canale: 'gallery' as const,
      stato: 'processing' as const,
      avanzamento: 60,
      codice: null as string | null,
      aggiornatoIl: '2026-09-18T10:00:00.000Z',
    }
    expect(schemaStatoJobVideo.safeParse(base).success).toBe(true)

    // Un job fallito SENZA codice è il silenzio di prima: la schermata non
    // saprebbe che cosa dire e mostrerebbe una rotella per sempre.
    expect(
      schemaStatoJobVideo.safeParse({ ...base, stato: 'failed', avanzamento: null, codice: null })
        .success,
      'un job fallito senza codice è stato accettato',
    ).toBe(false)
    expect(
      schemaStatoJobVideo.safeParse({
        ...base,
        stato: 'failed',
        avanzamento: null,
        codice: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
      }).success,
    ).toBe(true)

    // …e un job in corso con un codice d'errore attaccato è l'incoerenza opposta.
    expect(
      schemaStatoJobVideo.safeParse({ ...base, codice: 'VIDEO_RIPROVA' }).success,
      'un job in lavorazione con un codice d’errore è stato accettato',
    ).toBe(false)

    // Al client arriva SOLO un codice mostrabile: quello interno resta nel log.
    expect(
      schemaStatoJobVideo.safeParse({
        ...base,
        stato: 'failed',
        avanzamento: null,
        codice: 'OUTPUT_DURATION_MISMATCH',
      }).success,
      'un codice interno è uscito verso il client',
    ).toBe(false)
  })

  it('l’avanzamento cresce con lo stato e si spegne quando non significa più niente', () => {
    expect(avanzamentoDaStatoVideo('awaiting_upload')).toBe(0)
    expect(avanzamentoDaStatoVideo('queued')).toBeGreaterThan(0)
    expect(avanzamentoDaStatoVideo('processing')).toBeGreaterThan(
      avanzamentoDaStatoVideo('queued') as number,
    )
    expect(avanzamentoDaStatoVideo('ready')).toBe(100)
    for (const stato of ['rejected', 'failed', 'cancelled'] as const) {
      expect(avanzamentoDaStatoVideo(stato), `${stato}: la barra non dice più niente`).toBeNull()
    }
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════
 * PR 2 «SERVER E WEB» (2026-10-02) — i codici letti da SQL, i codici nuovi, la regola #37,
 * gli schemi del contratto e i testi dei cataloghi.
 * ═══════════════════════════════════════════════════════════════════════════════ */

describe('contratto video · il lock legge OGNI codice che SQL scrive, non solo i `code` delle RPC', () => {
  // Una forma per riga: il nome, un frammento di SQL, i codici che il lettore DEVE trovarci.
  const FORME: Array<[string, string, string[]]> = [
    [
      'la risposta di una RPC (`\'code\', \'X\'`)',
      "RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'CODICE_DI_PROVA');",
      ['CODICE_DI_PROVA'],
    ],
    [
      'un `error_code` scritto sul job',
      "UPDATE public.video_jobs SET status = 'failed', error_code = 'CODICE_DI_PROVA' WHERE id = p_job;",
      ['CODICE_DI_PROVA'],
    ],
    [
      'un `last_error_code` assegnato',
      "UPDATE public.video_jobs SET last_error_code = 'CODICE_DI_PROVA' WHERE id = p_job;",
      ['CODICE_DI_PROVA'],
    ],
    [
      'un confronto su `error_code`',
      "SELECT 1 FROM public.video_jobs AS j WHERE j.error_code <> 'CODICE_DI_PROVA';",
      ['CODICE_DI_PROVA'],
    ],
    [
      'un elenco `error_code IN (…)`',
      "SELECT 1 FROM public.video_jobs AS j WHERE j.error_code IN ('ALTRO_CODICE', 'CODICE_DI_PROVA');",
      ['ALTRO_CODICE', 'CODICE_DI_PROVA'],
    ],
    [
      'la colonna `pubblicazione_errore` dell’intento',
      "UPDATE public.video_intents SET pubblicazione_errore = 'CODICE_DI_PROVA' WHERE id = p_intent;",
      ['CODICE_DI_PROVA'],
    ],
    [
      'un elenco `pubblicazione_errore IN (…)`',
      "SELECT 1 WHERE pubblicazione_errore IN ('CODICE_DI_PROVA', 'ALTRO_CODICE');",
      ['ALTRO_CODICE', 'CODICE_DI_PROVA'],
    ],
    [
      'una RAISE il cui messaggio intero è un codice',
      "RAISE EXCEPTION 'CODICE_DI_PROVA' USING ERRCODE = 'KV001';",
      ['CODICE_DI_PROVA'],
    ],
    [
      'una variabile che porta il codice a chi risponde',
      "v_codice := 'CODICE_DI_PROVA';",
      ['CODICE_DI_PROVA'],
    ],
    [
      'un parametro con un codice predefinito',
      'CREATE FUNCTION f(p_code text DEFAULT \'CODICE_DI_PROVA\') RETURNS void',
      ['CODICE_DI_PROVA'],
    ],
  ]

  it.each(FORME)('trova un codice scritto come %s', (_nome, sql, attesi) => {
    expect(codiciInSql(sql)).toEqual([...attesi].sort())
  })

  it('NON conta come codice ciò che un codice non è: commenti, frasi, nomi di funzione, SQLSTATE', () => {
    const sql = [
      "-- 'code', 'COMMENTATO_A_RIGA'  e  error_code = 'COMMENTATO_ANCORA'",
      "/* RAISE EXCEPTION 'COMMENTATO_A_BLOCCO' */",
      "UPDATE public.video_jobs SET status = 'failed' WHERE kind = 'recita';",
      "PERFORM public._video_job_transition_log('video-job-retry', 'error', p_job_id, NULL, 'BAD_INPUT_NEL_LOG');",
      "RAISE EXCEPTION 'video_intents_job_scope_immutabile: owner, channel e scuola' USING ERRCODE = '23514';",
      "RAISE EXCEPTION 'video_galleria_pubblica: finalize rifiutato' USING ERRCODE = 'KV001';",
      "SELECT 1 WHERE error_code ~ '^[A-Z][A-Z0-9_]{0,79}$' AND error_code = lower_case_code;",
    ].join('\n')
    expect(codiciInSql(sql)).toEqual([])
  })

  it('un `--` dentro una stringa non apre un commento, e un apice raddoppiato non chiude la stringa', () => {
    const sql = [
      "SELECT '-- non è un commento' AS nota, 1 WHERE error_code = 'DOPO_LA_STRINGA';",
      "COMMENT ON FUNCTION f() IS 'e'' dell''infrastruttura';",
      "UPDATE t SET error_code = 'DOPO_L_APICE';",
    ].join('\n')
    expect(codiciInSql(sql)).toEqual(['DOPO_LA_STRINGA', 'DOPO_L_APICE'])
    expect(sqlSenzaCommenti(sql).chiuso).toBe(true)
    // E il lettore sa dire che è rimasto a metà: una stringa mai chiusa non ha letto niente di utile.
    expect(sqlSenzaCommenti("SELECT 'mai chiusa; error_code = 'X'").chiuso).toBe(false)
    expect(sqlSenzaCommenti('/* mai chiuso').chiuso).toBe(false)
  })

  it('ogni migrazione video si legge fino in fondo (nessuna stringa o commento rimasto aperto)', () => {
    // «Zero codici trovati» da un certo punto in poi non vorrebbe dire niente se il lettore si è
    // perso dentro un testo: qui si verifica che finisca fuori da una stringa, su ogni file.
    const file = fileSqlVideo(MIGRAZIONI)
    expect(file.length, 'le migrazioni video non si trovano più').toBeGreaterThanOrEqual(8)
    const aperti = file.filter((nome) => !sqlSenzaCommenti(readFileSync(join(MIGRAZIONI, nome), 'utf8')).chiuso)
    expect(aperti, 'il lettore SQL non è arrivato in fondo a questi file').toEqual([])
  })

  it('i due `error_code` che la retention scrive da sola (`UPLOAD_ABBANDONATO`, `CONVERSIONE_INCAGLIATA`) sono nel file vero e nel contratto', () => {
    // La retention li scrive dal 2026-09-18 e il contratto non li dichiarava: il lock leggeva solo i `code` delle RPC.
    const retention = fileSqlVideo(MIGRAZIONI).find((n) => /_video_retention_riconciliazione\.sql$/.test(n))
    expect(retention, 'la migrazione della retention non è più fra quelle che il lock legge').toBeTruthy()
    const sql = readFileSync(join(MIGRAZIONI, retention as string), 'utf8')
    expect(sql).toMatch(/error_code\s*=\s*'UPLOAD_ABBANDONATO'/)
    expect(sql).toMatch(/error_code\s*=\s*'CONVERSIONE_INCAGLIATA'/)
    expect(codiciInSql(sql)).toEqual(expect.arrayContaining(['UPLOAD_ABBANDONATO', 'CONVERSIONE_INCAGLIATA']))
    expect(CODICI_ESITO_VIDEO as readonly string[]).toEqual(
      expect.arrayContaining(['UPLOAD_ABBANDONATO', 'CONVERSIONE_INCAGLIATA']),
    )
  })

  it('un codice SCONOSCIUTO scritto in una migrazione rende rosso il lock — provato su una COPIA, in ogni forma', () => {
    // La mutazione la fa il test, in una cartella temporanea: toccare `supabase/migrations`
    // mentre altri compiti ci scrivono sarebbe il modo di rompere il lavoro altrui.
    const cartella = mkdtempSync(join(tmpdir(), 'kv-contratto-sql-'))
    try {
      const vera = fileSqlVideo(MIGRAZIONI).find((n) => /_video_retention_riconciliazione\.sql$/.test(n))
      const originale = readFileSync(join(MIGRAZIONI, vera as string), 'utf8')

      // La copia identica non ha niente di indichiarato: il lock è verde sullo stato attuale…
      writeFileSync(join(cartella, '20990101000000_video_copia.sql'), originale)
      expect(nonDichiarati(codiciDelleMigrazioni(cartella)), 'la copia della retention ha già un codice ignoto').toEqual([])

      // …e UNA riga nuova, in ciascuna forma, lo rende rosso nominando proprio quel codice.
      for (const [nome, riga] of [
        ['`code` di una RPC', "SELECT jsonb_build_object('ok', false, 'code', 'CODICE_MAI_DICHIARATO');"],
        ['`error_code` sul job', "UPDATE public.video_jobs SET error_code = 'CODICE_MAI_DICHIARATO';"],
        ['`last_error_code` sul job', "UPDATE public.video_jobs SET last_error_code = 'CODICE_MAI_DICHIARATO';"],
        ['`pubblicazione_errore`', "UPDATE public.video_intents SET pubblicazione_errore = 'CODICE_MAI_DICHIARATO';"],
        ['una RAISE', "DO $$ BEGIN RAISE EXCEPTION 'CODICE_MAI_DICHIARATO'; END $$;"],
        ['una variabile', "DO $$ DECLARE v_code text; BEGIN v_code := 'CODICE_MAI_DICHIARATO'; END $$;"],
      ] as const) {
        writeFileSync(join(cartella, '20990101000000_video_copia.sql'), `${originale}\n${riga}\n`)
        expect(nonDichiarati(codiciDelleMigrazioni(cartella)), `la forma «${nome}» non è stata vista`).toEqual([
          'CODICE_MAI_DICHIARATO',
        ])
      }

      // Ma la stessa riga dentro un COMMENTO non fa rumore: la regola guarda il codice che gira.
      writeFileSync(
        join(cartella, '20990101000000_video_copia.sql'),
        `${originale}\n-- UPDATE public.video_jobs SET error_code = 'CODICE_MAI_DICHIARATO';\n`,
      )
      expect(nonDichiarati(codiciDelleMigrazioni(cartella))).toEqual([])
    } finally {
      rmSync(cartella, { recursive: true, force: true })
    }
  })
})

describe('contratto video · i codici della PR 2 e la loro destinazione', () => {
  // La tabella è scritta per ESTESO e non ricavata con la stessa regola del codice: un test che
  // ricalcola la mappa è verde anche quando la mappa è sbagliata. È la decisione presa il
  // 2026-10-02, riga per riga, e chi la cambia deve cambiare anche questa.
  const DESTINAZIONI: Record<string, string> = {
    // I due `error_code` che SQL scrive da solo.
    UPLOAD_ABBANDONATO: 'VIDEO_NON_TROVATO',
    CONVERSIONE_INCAGLIATA: 'VIDEO_GUASTO_NOSTRO',
    // Il file arrivato.
    ORIGINALE_DIVERSO: 'VIDEO_ORIGINALE_NON_COINCIDE',
    ORIGINALE_SOSTITUITO: 'VIDEO_ORIGINALE_NON_COINCIDE',
    // Il rinnovo e il runner: «non ora» e «non esiste».
    CAPACITA_PIENA: 'VIDEO_RIPROVA',
    GIA_SORVEGLIATO: 'VIDEO_RIPROVA',
    TOKEN_NON_VALIDO: 'VIDEO_NON_TROVATO',
    // I destinatari e la pubblicazione.
    DESTINATARI_MANCANTI: 'VIDEO_DESTINATARI_MANCANTI',
    NESSUN_DESTINATARIO: 'VIDEO_NESSUN_DESTINATARIO',
    PUBBLICAZIONE_NON_RIUSCITA: 'VIDEO_PUBBLICAZIONE_NON_RIUSCITA',
    RIPROVA_NON_POSSIBILE: 'VIDEO_RIPROVA_NON_POSSIBILE',
    // Difetti di chi chiama la RPC: la frase del ripiego, il motivo vero nel log.
    TAG_NON_DELL_INTENTO: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
    BROADCAST_CON_TAG: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
    FILE_URL_NON_VALIDO: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
    FINALIZE_RIFIUTATO: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
    NON_AUTOMATICA: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
    POST_FALLITO: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
    URL_ASSENTE: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  }

  it.each(Object.entries(DESTINAZIONI))('%s → %s', (codice, atteso) => {
    expect(
      (CODICI_ESITO_VIDEO as readonly string[]).filter((c) => c === codice),
      `${codice} deve essere dichiarato UNA volta sola`,
    ).toHaveLength(1)
    expect((MAPPA_MESSAGGIO_VIDEO as Record<string, string>)[codice]).toBe(atteso)
    // …e il traduttore lo segue davvero (una mappa ignorata dal traduttore sarebbe verde).
    expect(codiceMessaggioVideo(codice)).toBe(atteso)
  })

  it('i codici nuovi sono ESATTAMENTE questi: uno in più va deciso qui, uno in meno va spiegato', () => {
    // I 75 codici di prima della PR 2 non si ricontano: si ricontano i NUOVI, cioè tutto ciò che
    // il contratto dichiara e che non nasce da `limiti`, `probe`, `verify`, dal runner o dalle
    // dieci RPC della PR 1. Se T2b/T2c aggiungono un codice a SQL il lock delle fonti lo chiede
    // da solo: questo test lo registra con la sua destinazione.
    const codiciDellaPr1 = new Set<string>([
      ...membriUnione(readFileSync(join(VIDEO, 'limiti.ts'), 'utf8'), 'VideoInputSizeErrorCode'),
      ...membriUnione(readFileSync(join(VIDEO, 'probe.ts'), 'utf8'), 'VideoProbeErrorCode'),
      ...membriUnione(readFileSync(join(VIDEO, 'verify.ts'), 'utf8'), 'VideoOutputVerificationErrorCode'),
      ...membriElencoLetterale(readFileSync(join(VIDEO, 'runner', 'codici.ts'), 'utf8'), 'CODICI_RUNNER_VIDEO'),
    ])
    expect(codiciDellaPr1.size, 'le fonti tipizzate non si leggono più').toBeGreaterThanOrEqual(30)
    // I codici delle RPC di prima della PR 2: quelli scritti nelle migrazioni NON della PR 2.
    const migrazioniPrima = fileSqlVideo(MIGRAZIONI).filter(
      (n) => !/_video_(pubblicazione_automatica|arrivo_originale|conservazione_uscite)\.sql$/.test(n),
    )
    for (const nome of migrazioniPrima) {
      for (const codice of codiciInSql(readFileSync(join(MIGRAZIONI, nome), 'utf8'))) codiciDellaPr1.add(codice)
    }
    for (const codice of CODICI_BORDO_VIDEO) codiciDellaPr1.add(codice)

    const nuovi = [...CODICI_ESITO_VIDEO].filter((c) => !codiciDellaPr1.has(c)).sort()
    expect(nuovi).toEqual(Object.keys(DESTINAZIONI).filter((c) => !codiciDellaPr1.has(c)).sort())
    // I due della retention non sono «della PR 2» ma sono nuovi PER IL CONTRATTO: stanno nella
    // tabella perché il contratto li ha dichiarati adesso, e il lock li ha trovati nel file vero.
    expect(Object.keys(DESTINAZIONI)).toEqual(expect.arrayContaining(['UPLOAD_ABBANDONATO', 'CONVERSIONE_INCAGLIATA']))
  })

  it('nessun codice è dichiarato due volte, in nessuno dei tre elenchi', () => {
    for (const [nome, lista] of [
      ['CODICI_ESITO_VIDEO', CODICI_ESITO_VIDEO],
      ['CODICI_BORDO_VIDEO', CODICI_BORDO_VIDEO],
      ['CODICI_MOSTRATI_VIDEO', CODICI_MOSTRATI_VIDEO],
    ] as const) {
      const visti = new Set<string>()
      const doppi = (lista as readonly string[]).filter((c) => (visti.has(c) ? true : (visti.add(c), false)))
      expect(doppi, `${nome} ha voci ripetute`).toEqual([])
    }
    // Un codice di bordo non è anche interno, e viceversa: due autorità sullo stesso nome.
    const interniEBordo = (CODICI_BORDO_VIDEO as readonly string[]).filter((c) =>
      (CODICI_ESITO_VIDEO as readonly string[]).includes(c),
    )
    expect(interniEBordo).toEqual([])
  })

  it('`VIDEO_APP_DA_AGGIORNARE` esiste già e si RIUSA: nessun codice nuovo ne duplica la frase', () => {
    // Il brief della PR 2 chiedeva di verificare se esisteva; esiste dal 2026-09-18, ed è l'unica
    // destinazione di un solo codice interno: quello del bordo. Un secondo codice per «aggiorna
    // l'app» vorrebbe dire due frasi diverse per lo stesso rifiuto, che è il difetto del 2026-08-01.
    const mappa = MAPPA_MESSAGGIO_VIDEO as Record<string, string>
    const versoDiLui = Object.entries(mappa)
      .filter(([, mostrato]) => mostrato === 'VIDEO_APP_DA_AGGIORNARE')
      .map(([codice]) => codice)
    expect(versoDiLui).toEqual(['CLIENT_UPDATE_REQUIRED'])
    expect(CODICI_MOSTRATI_VIDEO).toContain('VIDEO_APP_DA_AGGIORNARE')
    expect(CHIAVI_MESSAGGIO_VIDEO.VIDEO_APP_DA_AGGIORNARE).toBe('erroreVideoAppDaAggiornare')
  })

  it('le cinque frasi nuove hanno la loro chiave, esistono nelle due lingue e ciascuna ha un codice che ci arriva', () => {
    const NUOVE: Record<string, string> = {
      VIDEO_ORIGINALE_NON_COINCIDE: 'erroreVideoOriginaleNonCoincide',
      VIDEO_DESTINATARI_MANCANTI: 'erroreVideoDestinatariMancanti',
      VIDEO_NESSUN_DESTINATARIO: 'erroreVideoNessunDestinatario',
      VIDEO_PUBBLICAZIONE_NON_RIUSCITA: 'erroreVideoPubblicazioneNonRiuscita',
      VIDEO_RIPROVA_NON_POSSIBILE: 'erroreVideoRiprovaNonPossibile',
    }
    const mappa = MAPPA_MESSAGGIO_VIDEO as Record<string, string>
    for (const [codice, chiave] of Object.entries(NUOVE)) {
      expect(CODICI_MOSTRATI_VIDEO as readonly string[], codice).toContain(codice)
      expect((CHIAVI_MESSAGGIO_VIDEO as Record<string, string>)[codice], codice).toBe(chiave)
      expect(catIt[chiave]?.trim(), `it/${chiave}`).toBeTruthy()
      expect(catEn[chiave]?.trim(), `en/${chiave}`).toBeTruthy()
      // Una frase che nessun codice interno raggiunge è una frase morta in due lingue.
      expect(
        Object.values(mappa).filter((mostrato) => mostrato === codice).length,
        `${codice}: nessun codice interno porta a questa frase`,
      ).toBeGreaterThanOrEqual(1)
    }
  })

  it('ogni codice mostrato arriva al client con la sua chiave: l’elenco unico `CODICI_ERRORE` li innesta da sé', () => {
    // `CODICI_ERRORE` (esito-fetch) è l'elenco che il client legge per tradurre un `codice`: i
    // video lo innestano con `...CHIAVI_MESSAGGIO_VIDEO`. Se una chiave nuova non ci arrivasse,
    // la risposta del server tornerebbe a mostrare la prosa italiana — il difetto F1.
    const elenco = CODICI_ERRORE as Record<string, string>
    for (const codice of CODICI_MOSTRATI_VIDEO) {
      expect(elenco[codice], `${codice} non arriva a CODICI_ERRORE`).toBe(
        (CHIAVI_MESSAGGIO_VIDEO as Record<string, string>)[codice],
      )
    }
  })
})

/**
 * LA REGOLA DEL SECONDARIO #37 — che cosa legge chi ha caricato un video il cui guasto era NOSTRO
 * e ha esaurito i tentativi. La tabella è scritta per ESTESO, riga per riga.
 */
describe('contratto video · il codice da mostrare per un job (`codiceMostrabileDelJob`, #37)', () => {
  // Per ciascun codice tecnico di un job `failed`: che cosa legge con UN SOLO tentativo alle spalle
  // (0 o 1) e che cosa legge dopo un ritentativo (2, 3 o 4).
  const FALLITI: Array<{ codice: string; unTentativo: string; dopoRitentativi: string }> = [
    // I due guasti nostri che la mappa mette ancora sul file: era qui che l'insegnante leggeva una bugia.
    { codice: 'PROBE_COMMAND_FAILED', unTentativo: 'VIDEO_NON_LEGGIBILE', dopoRitentativi: 'VIDEO_GUASTO_NOSTRO' },
    { codice: 'ENCODE_FAILED', unTentativo: 'VIDEO_CONVERSIONE_NON_RIUSCITA', dopoRitentativi: 'VIDEO_GUASTO_NOSTRO' },
    { codice: 'CONVERSION_TIMEOUT', unTentativo: 'VIDEO_CONVERSIONE_NON_RIUSCITA', dopoRitentativi: 'VIDEO_GUASTO_NOSTRO' },
    // Già «nostri» in mappa: non cambiano.
    { codice: 'BUILD_DOWNLOAD_FAILED', unTentativo: 'VIDEO_GUASTO_NOSTRO', dopoRitentativi: 'VIDEO_GUASTO_NOSTRO' },
    { codice: 'SANDBOX_UNAVAILABLE', unTentativo: 'VIDEO_GUASTO_NOSTRO', dopoRitentativi: 'VIDEO_GUASTO_NOSTRO' },
    { codice: 'CONVERSIONE_INCAGLIATA', unTentativo: 'VIDEO_GUASTO_NOSTRO', dopoRitentativi: 'VIDEO_GUASTO_NOSTRO' },
    // La retention: un caricamento mai finito non ha mai avuto un ritentativo (attempt 0).
    { codice: 'UPLOAD_ABBANDONATO', unTentativo: 'VIDEO_NON_TROVATO', dopoRitentativi: 'VIDEO_GUASTO_NOSTRO' },
  ]

  it.each(FALLITI)('failed · $codice: un tentativo → $unTentativo, dopo i ritentativi → $dopoRitentativi', (riga) => {
    for (const attempt of [0, 1]) {
      expect(codiceMostrabileDelJob({ status: 'failed', error_code: riga.codice, attempt }), `attempt ${attempt}`).toBe(
        riga.unTentativo,
      )
    }
    for (const attempt of [2, 3, 4]) {
      expect(codiceMostrabileDelJob({ status: 'failed', error_code: riga.codice, attempt }), `attempt ${attempt}`).toBe(
        riga.dopoRitentativi,
      )
    }
  })

  it('un job `rejected` NON si riscrive mai: il difetto è del file, anche al quarto tentativo', () => {
    const RIFIUTATI: Array<[string, string]> = [
      ['UNSUPPORTED_VIDEO_CODEC', 'VIDEO_FORMATO_NON_SUPPORTATO'],
      ['VIDEO_TOO_LONG', 'VIDEO_TROPPO_LUNGO'],
      ['ORIGINALE_DIVERSO', 'VIDEO_ORIGINALE_NON_COINCIDE'],
      ['ORIGINALE_SOSTITUITO', 'VIDEO_ORIGINALE_NON_COINCIDE'],
      ['OUTPUT_DURATION_MISMATCH', 'VIDEO_CONVERSIONE_NON_RIUSCITA'],
    ]
    for (const [codice, atteso] of RIFIUTATI) {
      for (const attempt of [0, 1, 2, 3, 4]) {
        expect(codiceMostrabileDelJob({ status: 'rejected', error_code: codice, attempt }), `${codice} · attempt ${attempt}`).toBe(
          atteso,
        )
      }
    }
  })

  it('un job che non è finito male non porta un codice, qualunque cosa ci sia scritta sopra', () => {
    for (const status of ['awaiting_upload', 'queued', 'processing', 'ready', 'cancelled']) {
      for (const attempt of [0, 1, 2, 3, 4]) {
        // Anche con un `error_code` rimasto sulla riga (un job rimesso in coda lo conserva).
        expect(codiceMostrabileDelJob({ status, error_code: 'ENCODE_FAILED', attempt }), `${status} · ${attempt}`).toBeNull()
      }
    }
    // E uno stato che non si riconosce vale «niente da mostrare», mai un errore inventato.
    for (const status of ['', 'FAILED', 'weird', 'superseded']) {
      expect(codiceMostrabileDelJob({ status, error_code: 'ENCODE_FAILED', attempt: 3 }), status).toBeNull()
    }
  })

  it('una riga letta male non promette un ritentativo che potrebbe non esserci', () => {
    // `attempt` assente, non numerico, negativo o non finito vale 0: il codice resta quello della mappa.
    for (const attempt of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        codiceMostrabileDelJob({ status: 'failed', error_code: 'PROBE_COMMAND_FAILED', attempt }),
        `attempt ${String(attempt)}`,
      ).toBe('VIDEO_NON_LEGGIBILE')
    }
    expect(codiceMostrabileDelJob({ status: 'failed', error_code: 'PROBE_COMMAND_FAILED' })).toBe('VIDEO_NON_LEGGIBILE')
    // Un codice assente o sconosciuto cade sul ripiego, come ovunque: mai `undefined`, mai muto.
    expect(codiceMostrabileDelJob({ status: 'failed', error_code: null, attempt: 1 })).toBe(CODICE_VIDEO_DI_RIPIEGO)
    expect(codiceMostrabileDelJob({ status: 'rejected', error_code: 'CODICE_MAI_VISTO', attempt: 1 })).toBe(
      CODICE_VIDEO_DI_RIPIEGO,
    )
  })

  it('«in riprova» e «esaurito» usano la STESSA soglia: un job che si ritenta non è un job fallito', () => {
    // Il confine, scritto in numeri nudi E con la costante: la prima presa è attempt 1, e solo da 2 in poi è un ritentativo.
    expect(ATTEMPT_DELLA_PRIMA_PRESA).toBe(1)
    expect(codiceMostrabileDelJob({ status: 'failed', error_code: 'ENCODE_FAILED', attempt: 1 })).toBe(
      'VIDEO_CONVERSIONE_NON_RIUSCITA',
    )
    expect(codiceMostrabileDelJob({ status: 'failed', error_code: 'ENCODE_FAILED', attempt: 2 })).toBe('VIDEO_GUASTO_NOSTRO')

    // Su TUTTA la tabella stato × tentativo: dove `riprovaAutomaticaInCorso` dice «lo stiamo
    // riprovando» il job non è fallito (niente codice), e dove è fallito lo schema dello stato
    // accetta sempre ciò che queste funzioni producono. Tre regole, una sola soglia.
    for (const stato of STATI_JOB_VIDEO as readonly StatoJobVideo[]) {
      for (const attempt of [0, 1, 2, 3, 4]) {
        const riprova = riprovaAutomaticaInCorso(stato, attempt)
        const codice = codiceMostrabileDelJob({ status: stato, error_code: 'ENCODE_FAILED', attempt })
        if (riprova) expect(codice, `${stato} · ${attempt}: si ritenta, quindi non è fallito`).toBeNull()

        const letto = schemaStatoJobVideo.safeParse({
          jobId: '40000000-0000-4000-8000-000000000004',
          intentId: '30000000-0000-4000-8000-000000000003',
          canale: 'gallery',
          stato,
          avanzamento: avanzamentoDaStatoVideo(stato),
          codice,
          riprovaAutomatica: riprova,
          aggiornatoIl: '2026-10-02T10:00:00.000Z',
        })
        expect(letto.success, `${stato} · ${attempt}: ${JSON.stringify(letto.error?.issues ?? [])}`).toBe(true)
      }
    }
  })
})

describe('contratto video · i tetti sono quelli decisi dal titolare (2026-10-02)', () => {
  // Numeri nudi, scritti qui: se qualcuno rimette 180 «per sicurezza» questo è il punto in cui lo
  // si scopre, prima di un'insegnante con un filmato di quattro minuti.
  it('cinque minuti, due gigabyte, e il limite è inclusivo', () => {
    expect(MAX_VIDEO_DURATION_SECONDS).toBe(300)
    expect(MAX_VIDEO_INPUT_BYTES).toBe(2_000_000_000)
    const file = {
      chiaveIdempotenza: 'chiave-di-prova',
      nome: 'recita.mov',
      byte: 12_345_678,
      mime: 'video/quicktime',
    }
    const apertura = {
      canale: 'gallery',
      azione: 'publish',
      scuolaId: '10000000-0000-4000-8000-000000000001',
      ambitoGlobale: false,
      targetId: null,
      versioneTargetAttesa: null,
    }
    // Un filmato di quattro minuti, che sotto i 180 secondi veniva rifiutato, ora passa…
    for (const durataSecondi of [181, 240, 299.5, 300]) {
      expect(
        schemaAperturaIntentVideo.safeParse({ ...apertura, file: [{ ...file, durataSecondi }] }).success,
        `${durataSecondi} s`,
      ).toBe(true)
    }
    // …e un epsilon oltre i cinque minuti no.
    for (const durataSecondi of [300.001, 301, 600]) {
      expect(
        schemaAperturaIntentVideo.safeParse({ ...apertura, file: [{ ...file, durataSecondi }] }).success,
        `${durataSecondi} s`,
      ).toBe(false)
    }
  })

  it('il VBV di `encode.ts` si ricalcola dal tetto, e `validateVideoInputSize` non ha cambiato peso', () => {
    // Il tetto di durata non ha un secondo posto in cui è cablato: lo prova il test di `encode`
    // (maxrate, bufsize e conto scritto nel commento), qui basta che i due limiti siano interi
    // positivi e che il peso sia rimasto quello di prima.
    expect(Number.isInteger(MAX_VIDEO_DURATION_SECONDS) && MAX_VIDEO_DURATION_SECONDS > 0).toBe(true)
    expect(MAX_VIDEO_INPUT_BYTES).toBe(2_000_000_000)
  })

  /**
   * NESSUN TETTO DI DURATA CABLATO A 180 — la guardia che resta dopo la correzione.
   *
   * Portare il tetto da 180 a 300 secondi ha richiesto un giro di `grep`, perché il numero viveva
   * anche altrove: i 180 s e i 180 000 frame di `temporale.ts`, i 180 di `verify.ts`, il conto del
   * VBV nei commenti di `encode.ts`. Un `grep` fatto una volta si dimentica; questo lo rifà a ogni
   * esecuzione, sul CODICE (i commenti sono mascherati: la storia può nominare il vecchio numero,
   * il codice no), nelle cartelle dove un tetto di durata può nascere.
   *
   * L'unica eccezione dichiarata qui è `probe.ts`, che converte i gradi in radianti: 180 lì è π,
   * non una durata. Per un 180 che non è una durata in un altro file (un angolo, una misura) non
   * serve toccare questo test: si scrive sulla STESSA RIGA un commento `kv-180-ok: <perché>`, e il
   * motivo è obbligatorio — un 180 senza motivo non passa.
   */
  const CARTELLE_DEI_TETTI = [
    'src/lib/media',
    'src/lib/gallery',
    'src/components/features/admin/news',
    'src/components/features/gallery',
    'src/app/(dashboard)/teacher/gallery',
    'src/app/api/video-uploads',
    'src/app/api/video',
  ]
  const ECCEZIONI_180: Record<string, string> = {
    'src/lib/media/video/probe.ts': 'gradi → radianti (π / 180): non è una durata',
  }

  /** Il sorgente TypeScript con i commenti sostituiti da spazi, stringhe e ritorni a capo intatti. */
  function senzaCommentiTs(sorgente: string): string {
    let fuori = ''
    let i = 0
    let stato: 'codice' | 'riga' | 'blocco' | 'stringa' = 'codice'
    let apice = ''
    while (i < sorgente.length) {
      const c = sorgente[i]
      const d = sorgente[i + 1]
      if (stato === 'codice') {
        if (c === '/' && d === '/') { stato = 'riga'; fuori += '  '; i += 2; continue }
        if (c === '/' && d === '*') { stato = 'blocco'; fuori += '  '; i += 2; continue }
        if (c === '"' || c === "'" || c === '`') { stato = 'stringa'; apice = c }
        fuori += c
        i++
        continue
      }
      if (stato === 'riga') {
        fuori += c === '\n' ? '\n' : ' '
        if (c === '\n') stato = 'codice'
        i++
        continue
      }
      if (stato === 'blocco') {
        if (c === '*' && d === '/') { stato = 'codice'; fuori += '  '; i += 2; continue }
        fuori += c === '\n' ? '\n' : ' '
        i++
        continue
      }
      if (c === '\\') { fuori += c + (d ?? ''); i += 2; continue }
      if (c === apice) stato = 'codice'
      fuori += c
      i++
    }
    return fuori
  }

  function sorgentiTs(cartella: string): string[] {
    const trovati: string[] = []
    for (const voce of readdirSync(cartella, { withFileTypes: true })) {
      const percorso = join(cartella, voce.name)
      if (voce.isDirectory()) trovati.push(...sorgentiTs(percorso))
      else if (/\.tsx?$/.test(voce.name)) trovati.push(percorso)
    }
    return trovati
  }

  /** Le righe di codice con un `180`, `180_000` o `3 * 60` nudo: «file:riga → riga». */
  function cablatiA180(radice: string, cartelle: string[], eccezioni: Record<string, string>): string[] {
    const trovati: string[] = []
    for (const cartella of cartelle) {
      for (const file of sorgentiTs(join(radice, cartella))) {
        const relativo = file.slice(radice.length + 1).split('\\').join('/')
        if (relativo in eccezioni) continue
        const sorgente = readFileSync(file, 'utf8')
        const originali = sorgente.split('\n')
        senzaCommentiTs(sorgente)
          .split('\n')
          .forEach((riga, indice) => {
            // Il trattino prima del numero lo esclude: `rotate-180` è una classe di Tailwind, non una durata.
            if (!/(?<![\w.-])(?:180(?:_000)?|3\s*\*\s*60)(?!\w)/.test(riga)) return
            // Il commento sulla stessa riga, con il suo motivo, è l'uscita dichiarata (la riga
            // mascherata non lo vede: si legge l'originale).
            if (/kv-180-ok:\s*\S+/.test(originali[indice] ?? '')) return
            trovati.push(`${relativo}:${indice + 1} → ${riga.trim().slice(0, 100)}`)
          })
      }
    }
    return trovati
  }

  it('nessun modulo scrive 180 nel codice: ogni tetto di durata deriva da `MAX_VIDEO_DURATION_SECONDS`', () => {
    expect(
      cablatiA180(RADICE, CARTELLE_DEI_TETTI, ECCEZIONI_180),
      'Un tetto di durata cablato a 180 secondi (o a 180 000 frame) resta indietro rispetto a ' +
        '`limiti.ts`: rifiuterebbe un filmato di quattro minuti che il contratto accetta. Derivalo da ' +
        '`MAX_VIDEO_DURATION_SECONDS`; se il 180 non è una durata (un angolo, una misura), scrivi sulla ' +
        'stessa riga `// kv-180-ok: <perché>` — o, per un intero file, aggiungilo a `ECCEZIONI_180`.',
    ).toEqual([])
    // Ogni eccezione dichiarata nomina un file che esiste: una voce per un file sparito sarebbe un
    // permesso senza destinatario (leggerlo lancia se manca).
    for (const file of Object.keys(ECCEZIONI_180)) {
      expect(readFileSync(join(RADICE, file), 'utf8').length, file).toBeGreaterThan(0)
    }
  })

  it('la guardia VEDE un 180 vero e IGNORA quello dei commenti (prova su una cartella temporanea)', () => {
    const radice = mkdtempSync(join(tmpdir(), 'kv-contratto-180-'))
    try {
      const cartella = join(radice, 'src/lib/media/video')
      mkdirSync(cartella, { recursive: true })
      writeFileSync(
        join(cartella, 'storico.ts'),
        ['// il tetto era 180 secondi', '/* 180_000 frame */', "export const NOTA = 'durata'", 'export const OK = 1800'].join('\n'),
      )
      expect(cablatiA180(radice, ['src/lib/media'], {}), 'un 180 nei commenti ha fatto rumore').toEqual([])

      writeFileSync(join(cartella, 'tetto.ts'), 'export const TETTO_S = 180\nexport const FRAME = 180_000\nexport const T = 3 * 60\n')
      const trovati = cablatiA180(radice, ['src/lib/media'], {})
      expect(trovati.map((r) => r.split(' → ')[0])).toEqual([
        'src/lib/media/video/tetto.ts:1',
        'src/lib/media/video/tetto.ts:2',
        'src/lib/media/video/tetto.ts:3',
      ])
      // Un'eccezione di file dichiarata lo fa tacere…
      expect(cablatiA180(radice, ['src/lib/media'], { 'src/lib/media/video/tetto.ts': 'prova' })).toEqual([])
      // …e così il commento `kv-180-ok: <perché>` sulla stessa riga. Senza il perché non vale.
      writeFileSync(
        join(cartella, 'tetto.ts'),
        [
          'export const ANGOLO = 180 // kv-180-ok: gradi di una rotazione, non una durata',
          'export const SENZA_MOTIVO = 180 // kv-180-ok:',
          'export const FRAME = 180_000',
        ].join('\n'),
      )
      expect(cablatiA180(radice, ['src/lib/media'], {}).map((r) => r.split(' → ')[0])).toEqual([
        'src/lib/media/video/tetto.ts:2',
        'src/lib/media/video/tetto.ts:3',
      ])
    } finally {
      rmSync(radice, { recursive: true, force: true })
    }
  })
})

describe('contratto video · l’apertura con i destinatari e il trasporto', () => {
  const BAMBINO_A = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
  const BAMBINO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const impronta = 'AB'.repeat(32)
  const galleria = {
    canale: 'gallery' as const,
    azione: 'publish' as const,
    scuolaId: '10000000-0000-4000-8000-000000000001',
    ambitoGlobale: false,
    targetId: null,
    versioneTargetAttesa: null,
    file: [
      {
        chiaveIdempotenza: 'chiave-di-prova-1',
        nome: 'recita.mov',
        byte: 12_345_678,
        mime: 'video/quicktime',
        durataSecondi: 42.5,
      },
    ],
  }
  const conDestinatari = { ...galleria, destinatari: { tagAlunni: [BAMBINO_A, BAMBINO_B], broadcast: false, classi: [] } }

  it('senza destinatari né trasporto l’apertura di oggi passa com’era: trasporto `tus`, nessun destinatario', () => {
    const esito = schemaAperturaIntentVideo.safeParse(galleria)
    expect(esito.success, JSON.stringify(esito.error?.issues ?? [])).toBe(true)
    expect(esito.data?.trasporto).toBe('tus')
    // L'ASSENZA dei destinatari è un'informazione (un client vecchio): lo schema non la riempie.
    expect(esito.data?.destinatari).toBeUndefined()
  })

  it('i bambini si normalizzano: minuscoli e senza doppioni; il broadcast e le classi hanno il loro default', () => {
    const esito = schemaAperturaIntentVideo.safeParse({
      ...galleria,
      destinatari: { tagAlunni: [BAMBINO_A, BAMBINO_A.toLowerCase(), BAMBINO_B] },
    })
    expect(esito.success, JSON.stringify(esito.error?.issues ?? [])).toBe(true)
    expect(esito.data?.destinatari).toEqual({
      tagAlunni: [BAMBINO_A.toLowerCase(), BAMBINO_B],
      broadcast: false,
      classi: [],
    })
  })

  it('`{}` è un `destinatari` valido: è la route a dire `DESTINATARI_MANCANTI`, con la sua frase', () => {
    // Se lo schema respingesse i destinatari vuoti, il client riceverebbe un 400 di validazione
    // anonimo al posto del codice che sa tradurre.
    const esito = schemaAperturaIntentVideo.safeParse({ ...galleria, destinatari: {} })
    expect(esito.success, JSON.stringify(esito.error?.issues ?? [])).toBe(true)
    expect(esito.data?.destinatari).toEqual({ tagAlunni: [], broadcast: false, classi: [] })
  })

  it('NON valida le regole dei cancelli: broadcast con bambini passa di qui e lo ferma il cancello della Galleria', () => {
    // La risposta di quel rifiuto deve essere IDENTICA a quella di `POST /api/gallery`: uno schema
    // che lo anticipasse con un 400 di validazione ne cambierebbe il corpo.
    const esito = schemaAperturaIntentVideo.safeParse({
      ...galleria,
      destinatari: { tagAlunni: [BAMBINO_A], broadcast: true, classi: ['A - Primavera'] },
    })
    expect(esito.success, JSON.stringify(esito.error?.issues ?? [])).toBe(true)
  })

  it('i tetti dei destinatari sono quelli dei CHECK del database: 200 bambini, 20 classi', () => {
    expect(MAX_BAMBINI_PER_VIDEO).toBe(200)
    expect(MAX_CLASSI_PER_VIDEO).toBe(20)
    const bambini = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const classi = (n: number) => Array.from({ length: n }, (_, i) => `Classe ${i}`)
    const prova = (destinatari: object) =>
      schemaAperturaIntentVideo.safeParse({ ...galleria, destinatari }).success
    expect(prova({ tagAlunni: bambini(200) })).toBe(true)
    expect(prova({ tagAlunni: bambini(201) })).toBe(false)
    expect(prova({ classi: classi(20) })).toBe(true)
    expect(prova({ classi: classi(21) })).toBe(false)
  })

  it('un identificativo che non è un uuid, o una classe vuota, non entra', () => {
    expect(schemaDestinatariVideo.safeParse({ tagAlunni: ['non-un-uuid'] }).success).toBe(false)
    expect(schemaDestinatariVideo.safeParse({ tagAlunni: [''] }).success).toBe(false)
    expect(schemaDestinatariVideo.safeParse({ classi: [''] }).success).toBe(false)
    expect(schemaDestinatariVideo.safeParse({ broadcast: 'si' }).success).toBe(false)
  })

  it('i destinatari sono della Galleria e di `publish`: una News o un’altra azione li respinge', () => {
    const news = schemaAperturaIntentVideo.safeParse({ ...conDestinatari, canale: 'news' })
    expect(news.success, 'una News con destinatari è stata accettata').toBe(false)
    expect(news.error?.issues.some((i) => i.path.join('.') === 'destinatari')).toBe(true)
    for (const azione of ['attach_private', 'submit_proposal', 'schedule']) {
      const esito = schemaAperturaIntentVideo.safeParse({ ...conDestinatari, azione })
      expect(esito.success, `azione ${azione} con destinatari`).toBe(false)
      expect(esito.error?.issues.some((i) => i.path.join('.') === 'azione')).toBe(true)
    }
  })

  it('il trasporto è un elenco CHIUSO, e `put-nativo` è solo della Galleria', () => {
    expect([...TRASPORTI_VIDEO]).toEqual(['tus', 'put-nativo'])
    expect(schemaAperturaIntentVideo.safeParse({ ...conDestinatari, trasporto: 'put-nativo' }).success).toBe(true)
    expect(schemaAperturaIntentVideo.safeParse({ ...conDestinatari, trasporto: 'ftp' }).success).toBe(false)
    const news = schemaAperturaIntentVideo.safeParse({
      ...galleria,
      canale: 'news',
      azione: 'attach_private',
      trasporto: 'put-nativo',
    })
    expect(news.success, 'una News in trasporto nativo è stata accettata').toBe(false)
    expect(news.error?.issues.some((i) => i.path.join('.') === 'trasporto')).toBe(true)
  })

  it('lo `sha256` si ammette SOLO con `put-nativo`, per file, in esadecimale di 64 caratteri, in minuscolo', () => {
    const conImpronta = (trasporto: string | undefined, sha256: string) => ({
      ...conDestinatari,
      ...(trasporto ? { trasporto } : {}),
      file: [{ ...galleria.file[0], sha256 }],
    })
    // Con il trasporto nativo passa, e si normalizza.
    const nativo = schemaAperturaIntentVideo.safeParse(conImpronta('put-nativo', impronta))
    expect(nativo.success, JSON.stringify(nativo.error?.issues ?? [])).toBe(true)
    expect(nativo.data?.file[0].sha256).toBe(impronta.toLowerCase())
    // Con TUS (esplicito o predefinito) è una promessa che nessuno verifica: respinta, con il suo percorso.
    for (const trasporto of ['tus', undefined]) {
      const tus = schemaAperturaIntentVideo.safeParse(conImpronta(trasporto, impronta))
      expect(tus.success, `sha256 con trasporto ${String(trasporto)}`).toBe(false)
      expect(tus.error?.issues.some((i) => i.path.join('.') === 'file.0.sha256')).toBe(true)
    }
    // E la forma è controllata: 63 o 65 caratteri, o fuori dall'esadecimale, non sono un'impronta.
    for (const sbagliata of [impronta.slice(1), `${impronta}0`, 'g'.repeat(64), '']) {
      expect(
        schemaAperturaIntentVideo.safeParse(conImpronta('put-nativo', sbagliata)).success,
        `«${sbagliata.slice(0, 8)}…» (${sbagliata.length})`,
      ).toBe(false)
    }
  })
})

describe('contratto video · la risposta all’apertura: TUS di oggi, o PUT con il rinnovo', () => {
  const ID_INTENTO = '30000000-0000-4000-8000-000000000003'
  const ID_JOB = '40000000-0000-4000-8000-000000000004'
  const SCADENZA = '2026-10-02T12:00:00.000Z'
  const TOKEN = `${PREFISSO_TOKEN_RINNOVO}${'x'.repeat(43)}`
  const tus = {
    protocollo: 'tus' as const,
    endpoint: 'https://esempio.invalid/storage/v1/upload/resumable/sign',
    bucket: 'video_originals' as const,
    percorso: '20000000-0000-4000-8000-000000000002/abc.mov',
    contentType: 'video/quicktime',
    dimensioneBloccoByte: DIMENSIONE_BLOCCO_TUS_BYTE,
  }
  const put = {
    protocollo: 'put' as const,
    url: 'https://esempio.invalid/storage/v1/object/upload/sign/video_originals/abc.mov?token=prova',
    metodo: 'PUT' as const,
    intestazioni: { 'content-type': 'video/quicktime' },
  }
  const rispostaCon = (job: object) => ({
    intentId: ID_INTENTO,
    revisione: 1,
    canale: 'gallery' as const,
    scadenzaCaricamentoIl: SCADENZA,
    job: [{ jobId: ID_JOB, chiaveIdempotenza: 'chiave-di-prova-1', ...job }],
  })
  const jobTus = { caricamento: tus, firma: 'firma-di-prova-non-e-un-segreto' }
  const jobPut = { caricamento: put, rinnovo: { token: TOKEN, scadeIl: SCADENZA } }

  it('una risposta TUS passa con lo schema di oggi E con quello esteso, e dice la stessa cosa', () => {
    const corpo = rispostaCon(jobTus)
    const vecchio = schemaEsitoAperturaIntentVideo.safeParse(corpo)
    const esteso = schemaRispostaAperturaVideo.safeParse(corpo)
    expect(vecchio.success, JSON.stringify(vecchio.error?.issues ?? [])).toBe(true)
    expect(esteso.success, JSON.stringify(esteso.error?.issues ?? [])).toBe(true)
    expect(esteso.data).toEqual(vecchio.data)
  })

  it('una risposta PUT passa SOLO con lo schema esteso: quello di oggi resta TUS', () => {
    const corpo = rispostaCon(jobPut)
    const esteso = schemaRispostaAperturaVideo.safeParse(corpo)
    expect(esteso.success, JSON.stringify(esteso.error?.issues ?? [])).toBe(true)
    // Il PUT non ha la firma `x-signature`: l'URL è già firmato, e `firma` resta vuota.
    expect(esteso.data?.job[0].firma).toBe('')
    expect(esteso.data?.job[0].rinnovo?.token).toBe(TOKEN)
    expect(schemaEsitoAperturaIntentVideo.safeParse(corpo).success, 'lo schema di oggi ha letto un PUT').toBe(false)
  })

  it('`caricamento` è l’unione discriminata su `protocollo`: ciascun ramo accetta solo i suoi campi', () => {
    expect(schemaCaricamentoVideo.safeParse(tus).success).toBe(true)
    expect(schemaCaricamentoVideo.safeParse(put).success).toBe(true)
    // I campi di un ramo non bastano a un altro.
    expect(schemaCaricamentoVideo.safeParse({ ...tus, protocollo: 'put' }).success).toBe(false)
    expect(schemaCaricamentoVideo.safeParse({ ...put, protocollo: 'tus' }).success).toBe(false)
    expect(schemaCaricamentoVideo.safeParse({ ...put, protocollo: 'ftp' }).success).toBe(false)
  })

  it('l’URL di PUT è https, il metodo è PUT, il content-type c’è: niente di meno viene accettato', () => {
    expect(schemaCoordinatePutVideo.safeParse(put).success).toBe(true)
    expect(schemaCoordinatePutVideo.safeParse({ ...put, url: 'http://esempio.invalid/x' }).success, 'http in chiaro').toBe(false)
    expect(schemaCoordinatePutVideo.safeParse({ ...put, url: 'https://esempio.invalid/con spazio' }).success).toBe(false)
    expect(schemaCoordinatePutVideo.safeParse({ ...put, metodo: 'POST' }).success).toBe(false)
    expect(schemaCoordinatePutVideo.safeParse({ ...put, intestazioni: {} }).success, 'senza content-type').toBe(false)
    expect(
      schemaCoordinatePutVideo.safeParse({ ...put, intestazioni: { 'content-type': 'video/mp4;codecs=avc1.42E01E' } }).success,
      'il MIME col suffisso dei codec resta ammesso',
    ).toBe(true)
  })

  it('un PUT ancora da caricare porta il rinnovo; a caricamento finito il token non c’è più', () => {
    // Senza rinnovo l'app non ha modo di chiedere un URL nuovo quando quello scade.
    expect(schemaRispostaAperturaVideo.safeParse(rispostaCon({ caricamento: put })).success, 'PUT senza rinnovo').toBe(false)
    // Il token si revoca all'arrivo del file: averlo ancora è un difetto del server.
    const arrivato = schemaRispostaAperturaVideo.safeParse(rispostaCon({ ...jobPut, needs_upload: false }))
    expect(arrivato.success, 'token presente a caricamento finito').toBe(false)
    expect(
      schemaRispostaAperturaVideo.safeParse(rispostaCon({ caricamento: put, needs_upload: false })).success,
      'a caricamento finito basta l’URL',
    ).toBe(true)
  })

  it('il TUS non ha un token di rinnovo (la firma si rinnova con `/firma`), e senza firma non carica', () => {
    expect(schemaRispostaAperturaVideo.safeParse(rispostaCon({ ...jobTus, rinnovo: jobPut.rinnovo })).success).toBe(false)
    expect(schemaRispostaAperturaVideo.safeParse(rispostaCon({ caricamento: tus })).success, 'TUS senza firma').toBe(false)
    expect(
      schemaRispostaAperturaVideo.safeParse(rispostaCon({ caricamento: tus, needs_upload: false })).success,
      'TUS già arrivato: la firma non serve',
    ).toBe(true)
  })

  it('il token ha la forma di `token-rinnovo`: `kvr_` e 32 byte in base64url (43 caratteri)', async () => {
    const { randomBytes } = await import('node:crypto')
    expect(PREFISSO_TOKEN_RINNOVO).toBe('kvr_')
    // Un token vero, generato come lo genererà il server, entra: è la prova che il 43 è giusto.
    for (let i = 0; i < 20; i++) {
      const vero = `${PREFISSO_TOKEN_RINNOVO}${randomBytes(32).toString('base64url')}`
      expect(schemaTokenRinnovoVideo.safeParse(vero).success, vero.length === 47 ? 'forma' : `lunghezza ${vero.length}`).toBe(true)
    }
    // Fuori forma: un altro prefisso, troppo corto, troppo lungo, con un carattere che non è base64url.
    for (const sbagliato of [
      `kvx_${'x'.repeat(43)}`,
      `${PREFISSO_TOKEN_RINNOVO}${'x'.repeat(42)}`,
      `${PREFISSO_TOKEN_RINNOVO}${'x'.repeat(44)}`,
      `${PREFISSO_TOKEN_RINNOVO}${'x'.repeat(42)}=`,
      `${PREFISSO_TOKEN_RINNOVO}${'x'.repeat(42)}+`,
      `${PREFISSO_TOKEN_RINNOVO}${'x'.repeat(42)} `,
      '',
    ]) {
      expect(schemaTokenRinnovoVideo.safeParse(sbagliato).success, `«${sbagliato}»`).toBe(false)
    }
  })

  it('il token viaggia nell’intestazione, e il nome è quello della spec', () => {
    expect(INTESTAZIONE_TOKEN_RINNOVO).toBe('x-kidville-rinnovo')
  })
})

describe('contratto video · rinnovo, firma, azione e corpo del runner', () => {
  const SCADENZA = '2026-10-02T12:00:00.000Z'
  const put = {
    protocollo: 'put' as const,
    url: 'https://esempio.invalid/storage/v1/object/upload/sign/video_originals/abc.mov?token=prova',
    metodo: 'PUT' as const,
    intestazioni: { 'content-type': 'video/quicktime' },
  }

  it('il rinnovo risponde in tre stati, e `da-caricare` porta un URL di PUT nuovo', () => {
    for (const corpo of [
      { stato: 'da-caricare', caricamento: put, scadeIl: SCADENZA },
      { stato: 'arrivato' },
      { stato: 'annullato' },
    ]) {
      const esito = schemaRispostaRinnovoVideo.safeParse(corpo)
      expect(esito.success, JSON.stringify(corpo)).toBe(true)
    }
    // Il rinnovo è del PUT: un TUS qui non ha senso. E senza URL «da caricare» non dice niente.
    expect(
      schemaRispostaRinnovoVideo.safeParse({
        stato: 'da-caricare',
        caricamento: { ...put, protocollo: 'tus' },
        scadeIl: SCADENZA,
      }).success,
    ).toBe(false)
    expect(schemaRispostaRinnovoVideo.safeParse({ stato: 'da-caricare', scadeIl: SCADENZA }).success).toBe(false)
    expect(schemaRispostaRinnovoVideo.safeParse({ stato: 'da-caricare', caricamento: put }).success).toBe(false)
    // Uno stato che non esiste non passa — e il 404 uniforme non è uno stato: è una risposta d'errore.
    for (const stato of ['non-trovato', 'scaduto', 'revocato', '']) {
      expect(schemaRispostaRinnovoVideo.safeParse({ stato }).success, stato).toBe(false)
    }
  })

  it('`arrivato` e `annullato` non portano niente di più: non regalano un URL', () => {
    // Dopo l'arrivo un URL di caricamento non si ottiene più: lo schema scarta ciò che non dichiara.
    const esito = schemaRispostaRinnovoVideo.safeParse({ stato: 'arrivato', caricamento: put, scadeIl: SCADENZA })
    expect(esito.success).toBe(true)
    expect(esito.data).toEqual({ stato: 'arrivato' })
  })

  it('la firma: il corpo nomina un job, la risposta porta coordinate TUS e una firma non vuota', () => {
    expect(schemaCorpoFirmaVideo.safeParse({ jobId: '40000000-0000-4000-8000-000000000004' }).success).toBe(true)
    expect(schemaCorpoFirmaVideo.safeParse({ jobId: 'non-un-uuid' }).success).toBe(false)
    expect(schemaCorpoFirmaVideo.safeParse({}).success).toBe(false)
    const risposta = {
      jobId: '40000000-0000-4000-8000-000000000004',
      caricamento: {
        protocollo: 'tus',
        endpoint: 'https://esempio.invalid/storage/v1/upload/resumable/sign',
        bucket: 'video_originals',
        percorso: '20000000-0000-4000-8000-000000000002/abc.mov',
        contentType: 'video/quicktime',
        dimensioneBloccoByte: DIMENSIONE_BLOCCO_TUS_BYTE,
      },
      firma: 'firma-di-prova-non-e-un-segreto',
      scadeIl: SCADENZA,
    }
    expect(schemaRispostaFirmaVideo.safeParse(risposta).success).toBe(true)
    expect(schemaRispostaFirmaVideo.safeParse({ ...risposta, firma: '' }).success, 'senza firma non carica').toBe(false)
    expect(schemaRispostaFirmaVideo.safeParse({ ...risposta, caricamento: put }).success, 'la firma è del TUS').toBe(false)
  })

  it('l’azione «riprova-pubblicazione» è un verbo solo, senza altri campi', () => {
    expect(schemaAzioneRiprovaPubblicazioneVideo.safeParse({ azione: 'riprova-pubblicazione' }).success).toBe(true)
    expect(schemaAzioneRiprovaPubblicazioneVideo.safeParse({ azione: 'pubblica' }).success, '«pubblica» non esiste').toBe(false)
    expect(schemaAzioneRiprovaPubblicazioneVideo.safeParse({}).success).toBe(false)
  })

  it('il corpo del runner: vuoto, o con un `job_id` uuid — e solo quello', () => {
    expect(schemaCorpoRunnerVideo.safeParse({}).success, 'il corpo vuoto è ammesso').toBe(true)
    const job = schemaCorpoRunnerVideo.safeParse({ job_id: '40000000-0000-4000-8000-000000000004' })
    expect(job.success).toBe(true)
    expect(job.data?.job_id).toBe('40000000-0000-4000-8000-000000000004')
    expect(schemaCorpoRunnerVideo.safeParse({ job_id: 'non-un-uuid' }).success).toBe(false)
    expect(schemaCorpoRunnerVideo.safeParse({ jobId: '40000000-0000-4000-8000-000000000004' }).data).toEqual({})
  })
})

describe('contratto video · l’elenco dei video dell’insegnante (`VoceVideo`)', () => {
  const voce = {
    intentId: '30000000-0000-4000-8000-000000000003',
    jobId: '40000000-0000-4000-8000-000000000004',
    fase: 'in-coda',
    codice: null as string | null,
    creatoIl: '2026-10-02T10:00:00.000Z',
    aggiornatoIl: '2026-10-02T10:05:00.000Z',
    trasporto: 'tus',
    byte: 12_345_678 as number | null,
    durataS: 42.5 as number | null,
    nBambini: 3,
    broadcast: false,
    mediaId: null as string | null,
    pubblicazioneAutomatica: true,
    riprovaPossibile: false,
  }
  // Un esempio VALIDO per ciascuna fase: lo schema le conosce tutte, e nessuna resta senza prova.
  const VALIDE: Record<string, Partial<typeof voce>> = {
    'da-caricare': {},
    'in-coda': {},
    'in-conversione': {},
    'in-riprova': {},
    pronto: {},
    pubblicato: { mediaId: '50000000-0000-4000-8000-000000000005' },
    'non-pubblicato': { codice: 'VIDEO_NESSUN_DESTINATARIO' },
    fallito: { codice: 'VIDEO_GUASTO_NOSTRO' },
    annullato: {},
    'da-ricaricare': { pubblicazioneAutomatica: false, byte: null, durataS: null, nBambini: 0 },
  }

  it('le dieci fasi sono quelle della spec, e ciascuna ha una voce valida', () => {
    expect([...FASI_VOCE_VIDEO]).toEqual([
      'da-caricare',
      'in-coda',
      'in-conversione',
      'in-riprova',
      'pronto',
      'pubblicato',
      'non-pubblicato',
      'fallito',
      'annullato',
      'da-ricaricare',
    ])
    expect(Object.keys(VALIDE).sort()).toEqual([...FASI_VOCE_VIDEO].sort())
    for (const [fase, variante] of Object.entries(VALIDE)) {
      const esito = schemaVoceVideo.safeParse({ ...voce, fase, ...variante })
      expect(esito.success, `${fase}: ${JSON.stringify(esito.error?.issues ?? [])}`).toBe(true)
    }
  })

  it('«Riprova» si offre su un non pubblicato, e il codice è quello mostrabile del suo motivo', () => {
    for (const codice of ['VIDEO_NESSUN_DESTINATARIO', 'VIDEO_PUBBLICAZIONE_NON_RIUSCITA']) {
      const esito = schemaVoceVideo.safeParse({ ...voce, fase: 'non-pubblicato', codice, riprovaPossibile: true })
      expect(esito.success, codice).toBe(true)
    }
  })

  it('le bugie a schermo non passano: ognuna è una regola di coerenza', () => {
    const rifiutata = (variante: Partial<typeof voce>) =>
      !schemaVoceVideo.safeParse({ ...voce, ...variante }).success
    // Un video andato male DEVE avere una frase; uno che non è andato male non può averla.
    expect(rifiutata({ fase: 'fallito', codice: null }), 'fallito senza codice').toBe(true)
    expect(rifiutata({ fase: 'non-pubblicato', codice: null }), 'non pubblicato senza codice').toBe(true)
    for (const fase of ['da-caricare', 'in-coda', 'in-conversione', 'in-riprova', 'pronto', 'pubblicato', 'annullato', 'da-ricaricare']) {
      expect(rifiutata({ fase, codice: 'VIDEO_GUASTO_NOSTRO' }), `${fase} con un codice d’errore`).toBe(true)
    }
    // L'elemento di galleria esiste solo per un pubblicato; «Riprova» solo su un non pubblicato.
    expect(rifiutata({ fase: 'fallito', codice: 'VIDEO_GUASTO_NOSTRO', mediaId: '50000000-0000-4000-8000-000000000005' })).toBe(true)
    expect(rifiutata({ fase: 'pubblicato', riprovaPossibile: true })).toBe(true)
    expect(rifiutata({ fase: 'fallito', codice: 'VIDEO_GUASTO_NOSTRO', riprovaPossibile: true })).toBe(true)
    // Il broadcast non ha bambini; un video del flusso vecchio non è una pubblicazione automatica.
    expect(rifiutata({ broadcast: true, nBambini: 3 })).toBe(true)
    expect(schemaVoceVideo.safeParse({ ...voce, broadcast: true, nBambini: 0 }).success).toBe(true)
    expect(rifiutata({ fase: 'da-ricaricare', pubblicazioneAutomatica: true })).toBe(true)
  })

  it('il codice che esce è SOLO uno mostrabile: un codice interno non passa', () => {
    expect(
      schemaVoceVideo.safeParse({ ...voce, fase: 'fallito', codice: 'OUTPUT_DURATION_MISMATCH' }).success,
      'un codice interno è uscito verso il client',
    ).toBe(false)
    expect(schemaVoceVideo.safeParse({ ...voce, fase: 'fallito', codice: 'ORIGINALE_DIVERSO' }).success).toBe(false)
    for (const codice of CODICI_MOSTRATI_VIDEO) {
      expect(schemaVoceVideo.safeParse({ ...voce, fase: 'fallito', codice }).success, codice).toBe(true)
    }
  })

  it('i numeri sono quelli del database: byte e durata dichiarati, al più 200 bambini, trasporto chiuso', () => {
    const rifiutata = (variante: Partial<typeof voce>) =>
      !schemaVoceVideo.safeParse({ ...voce, ...variante }).success
    expect(rifiutata({ nBambini: MAX_BAMBINI_PER_VIDEO + 1 })).toBe(true)
    expect(rifiutata({ nBambini: -1 })).toBe(true)
    expect(rifiutata({ byte: MAX_VIDEO_INPUT_BYTES + 1 })).toBe(true)
    expect(rifiutata({ byte: 0 })).toBe(true)
    expect(rifiutata({ durataS: MAX_VIDEO_DURATION_SECONDS + 0.001 })).toBe(true)
    expect(rifiutata({ durataS: 0 })).toBe(true)
    expect(rifiutata({ trasporto: 'ftp' })).toBe(true)
    expect(rifiutata({ fase: 'in-attesa' })).toBe(true)
    expect(rifiutata({ intentId: 'non-un-uuid' })).toBe(true)
    expect(rifiutata({ aggiornatoIl: 'ieri' })).toBe(true)
    // Un video del flusso vecchio non dichiarava byte né durata: `null` è ammesso.
    expect(schemaVoceVideo.safeParse({ ...voce, byte: null, durataS: null }).success).toBe(true)
  })

  it('l’elenco è al più di 50 voci, e la query chiede il canale (la sede è facoltativa)', () => {
    expect(MAX_VOCI_ELENCO_VIDEO).toBe(50)
    const elenco = (n: number) => ({ voci: Array.from({ length: n }, () => voce) })
    expect(schemaRispostaElencoVideo.safeParse(elenco(0)).success, 'un elenco vuoto è un elenco').toBe(true)
    expect(schemaRispostaElencoVideo.safeParse(elenco(50)).success).toBe(true)
    expect(schemaRispostaElencoVideo.safeParse(elenco(51)).success, 'la 51ª voce è oltre il tetto').toBe(false)
    expect(schemaRispostaElencoVideo.safeParse({}).success).toBe(false)

    expect(schemaQueryElencoVideo.safeParse({ canale: 'gallery' }).success).toBe(true)
    expect(
      schemaQueryElencoVideo.safeParse({ canale: 'gallery', scuolaId: '10000000-0000-4000-8000-000000000001' }).success,
    ).toBe(true)
    expect(schemaQueryElencoVideo.safeParse({}).success, 'senza canale').toBe(false)
    expect(schemaQueryElencoVideo.safeParse({ canale: 'diario' }).success).toBe(false)
    expect(schemaQueryElencoVideo.safeParse({ canale: 'gallery', scuolaId: 'non-un-uuid' }).success).toBe(false)
  })

  it('una voce porta solo numeri, stati e identificativi: nessun nome di bambino o di file', () => {
    // Lo schema scarta ciò che non dichiara: anche se una route ci provasse, `nome` e `percorso`
    // non escono. La prova è sull'oggetto parsato, non sulla fiducia.
    const esito = schemaVoceVideo.safeParse({
      ...voce,
      nome: 'filmato-di-prova.mov',
      percorso: '20000000-0000-4000-8000-000000000002/abc.mov',
      tagAlunni: ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
    })
    expect(esito.success).toBe(true)
    expect(Object.keys(esito.data as object).sort()).toEqual(Object.keys(voce).sort())
  })
})

describe('contratto video · i testi dei cataloghi per la PR 2', () => {
  it('«5 minuti» sta anche nella nota sotto il pulsante delle News, in italiano e in inglese', () => {
    const minuti = String(Math.round(MAX_VIDEO_DURATION_SECONDS / 60))
    expect(itComunicazioni.videoNota).toMatch(new RegExp(`\\b${minuti} minut`, 'i'))
    expect(enComunicazioni.videoNota).toMatch(new RegExp(`\\b${minuti} minut`, 'i'))
    // Il vecchio tetto non resta scritto da nessuna parte nelle frasi dei video.
    for (const testo of [itComunicazioni.videoNota, enComunicazioni.videoNota, catIt.erroreVideoTroppoLungo, catEn.erroreVideoTroppoLungo]) {
      expect(testo, 'un testo parla ancora di tre minuti').not.toMatch(/\b(?:3|tre|three) minut/i)
    }
  })

  it('nessun testo promette «puoi chiudere l’app» prima che il caricamento sia finito (con TUS si ferma)', () => {
    // Con il TUS il caricamento va avanti finché la pagina o l'app è aperta: chiuderla a metà lo
    // ferma, e riprende da solo solo alla riapertura. La promessa è vera DOPO l'arrivo, quando il
    // lavoro è sul server. Questi quattro testi (due per lingua) sono quelli che si leggono anche
    // prima: la promessa c'è solo se dice quando — e la condizione deve stare NELLA STESSA FRASE
    // della promessa: «hanno ancora finito di essere preparati», in un'altra frase del testo, non
    // rende vera una promessa nuda di chiudere (la prima versione di questo controllo si
    // accontentava di quella parola ovunque, e lasciava passare proprio la promessa nuda).
    const FINITO = /\b(?:finito|finita|terminato|completato|finished|completed|done)\b/i
    const CARICAMENTO = /caricament|upload/i
    const PROMESSA = /\bchiuder[ei]\b|\bclose\b/i
    const frasi = (testo: string): string[] => testo.split(/(?<=[.!?])\s+/)
    const testi: Array<[string, string]> = [
      ['it/shared.erroreVideoNonAncoraPronto', catIt.erroreVideoNonAncoraPronto],
      ['en/shared.erroreVideoNonAncoraPronto', catEn.erroreVideoNonAncoraPronto],
      ['it/adminComunicazioni.videoNota', itComunicazioni.videoNota],
      ['en/adminComunicazioni.videoNota', enComunicazioni.videoNota],
    ]
    for (const [dove, testo] of testi) {
      const conPromessa = frasi(testo).filter((frase) => PROMESSA.test(frase))
      expect(conPromessa.length, `${dove} non parla più di chiudere: il controllo non misura niente`).toBeGreaterThan(0)
      for (const frase of conPromessa) {
        expect(
          CARICAMENTO.test(frase) && FINITO.test(frase),
          `${dove}: «${frase}» promette di chiudere senza dire che il caricamento deve essere finito`,
        ).toBe(true)
      }
    }
  })

  it('«I filmati già in attesa ripartono da soli» non c’è più: dopo l’aggiornamento un video scelto prima va caricato di nuovo', () => {
    expect(catIt.erroreVideoAppDaAggiornare).not.toMatch(/ripartono da soli/i)
    expect(catEn.erroreVideoAppDaAggiornare).not.toMatch(/resume by themselves|carries on by itself/i)
    expect(catIt.erroreVideoAppDaAggiornare).toMatch(/caricat[oi] di nuovo/)
    expect(catEn.erroreVideoAppDaAggiornare).toMatch(/uploaded again/)
  })

  it('le frasi nuove non nominano i meccanismi interni e non hanno l’apostrofo dritto', () => {
    const chiavi = [
      'erroreVideoOriginaleNonCoincide',
      'erroreVideoDestinatariMancanti',
      'erroreVideoNessunDestinatario',
      'erroreVideoPubblicazioneNonRiuscita',
      'erroreVideoRiprovaNonPossibile',
    ]
    // Qui NON si cerca «riprova»: in italiano è il verbo del «Riprova» (e va bene); è il lock dei
    // cataloghi a vietarlo nell'inglese, dove sarebbe una parola italiana rimasta.
    const tecnicismi = /\b(ffmpeg|ffprobe|bucket|lease|fence|intent|job|payload|rpc|postgrest|codec|uuid|null|token|tus|runner|sandbox|sha256)\b/i
    for (const chiave of chiavi) {
      expect(catIt[chiave], `it/${chiave}`).toBeTruthy()
      expect(catEn[chiave], `en/${chiave}`).toBeTruthy()
      expect(catIt[chiave], `it/${chiave}`).not.toContain("'")
      expect(catIt[chiave].match(tecnicismi), `it/${chiave}`).toBeNull()
      expect(catEn[chiave].match(tecnicismi), `en/${chiave}`).toBeNull()
      expect(catEn[chiave], `en/${chiave} ha una contrazione`).not.toMatch(/\w['’]\w/)
    }
    // Il «Riprova» di una pubblicazione fallita manda in galleria, non a un pulsante che potrebbe non esserci.
    expect(catIt.erroreVideoPubblicazioneNonRiuscita).toMatch(/galleria/)
    expect(catEn.erroreVideoPubblicazioneNonRiuscita).toMatch(/gallery/)
  })
})

describe('contratto video · il modulo può stare nel bundle del CLIENT', () => {
  /** Gli import a RUNTIME di un modulo: `import type` non arriva nel bundle. */
  function importRuntime(sorgente: string): string[] {
    const senzaTipi = sorgente.replace(/import\s+type\s+[^;]*?from\s*'[^']*'/g, '')
    return [...senzaTipi.matchAll(/from\s*'([^']+)'/g)].map((m) => m[1])
  }

  it('non trascina niente di server (né direttamente, né per transitività)', () => {
    const vietati = /^(node:|fs$|path$|crypto$|child_process$)|@supabase|\/supabase\/|server-only/
    const visti = new Set<string>()
    const daVisitare = ['contratto.ts']
    const trascinati: string[] = []

    while (daVisitare.length > 0) {
      const file = daVisitare.pop() as string
      if (visti.has(file)) continue
      visti.add(file)
      const sorgente = readFileSync(join(VIDEO, file), 'utf8')
      for (const modulo of importRuntime(sorgente)) {
        if (vietati.test(modulo)) trascinati.push(`${file} → ${modulo}`)
        if (modulo.startsWith('./')) daVisitare.push(`${modulo.slice(2)}.ts`)
      }
    }

    expect(
      trascinati,
      'Il contratto lo importa anche il client: un modulo di server nella catena finisce nel ' +
        'bundle del browser, o fa fallire la build.',
    ).toEqual([])
    // Controllo positivo: la scansione ha davvero attraversato qualcosa.
    expect(visti.size, 'la scansione non ha visitato nessun modulo').toBeGreaterThan(1)
    expect(importRuntime("import type { A } from './probe'\nimport { z } from 'zod'")).toEqual(['zod'])
  })

  it('nessun segreto e nessun indirizzo di servizio scritto nel contratto', () => {
    const sorgente = readFileSync(join(VIDEO, 'contratto.ts'), 'utf8')
    expect(/SERVICE_ROLE|eyJ[A-Za-z0-9_-]{20,}|sb_secret/.test(sorgente)).toBe(false)
    // Nessun uuid di sede cablato: si risolve per nome o dall'ambiente.
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(sorgente)).toBe(false)
  })
})
