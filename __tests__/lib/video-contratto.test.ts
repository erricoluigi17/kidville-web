// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
    DIMENSIONE_BLOCCO_TUS_BYTE,
  AZIONI_INTENT_VIDEO,
  CANALI_VIDEO,
  CHIAVI_MESSAGGIO_VIDEO,
  COPERTURA_CODICI_TIPIZZATI,
  CODICE_VIDEO_DI_RIPIEGO,
  CODICI_BORDO_VIDEO,
  CODICI_ESITO_VIDEO,
  CODICI_MOSTRATI_VIDEO,
  MAPPA_MESSAGGIO_VIDEO,
  STATI_JOB_VIDEO,
  avanzamentoDaStatoVideo,
  codiceMessaggioVideo,
  riprovaAutomaticaInCorso,
  schemaAperturaIntentVideo,
  schemaEsitoAperturaIntentVideo,
  schemaStatoJobVideo,
} from '@/lib/media/video/contratto'
import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
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

/** I `code` letterali restituiti dalle RPC video: `'code', 'BAD_INPUT'`. */
function codiciDelleMigrazioni(): string[] {
  const file = readdirSync(MIGRAZIONI).filter((n) => /_video[_.]/.test(n) && n.endsWith('.sql'))
  const trovati = new Set<string>()
  for (const nome of file) {
    const sql = readFileSync(join(MIGRAZIONI, nome), 'utf8')
    for (const m of sql.matchAll(/'code'\s*,\s*'([A-Z][A-Z0-9_]*)'/g)) trovati.add(m[1])
  }
  return [...trovati].sort()
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
    nome: 'supabase/migrations/*_video_*.sql → RPC',
    minimo: 25,
    codici: codiciDelleMigrazioni,
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

describe('contratto video · i codici d’errore sono ESAUSTIVI per costruzione', () => {
  it('la misura vede davvero le quattro fonti (controllo positivo dell’estrattore)', () => {
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
      'runner) e non sono ' +
        'in `CODICI_ESITO_VIDEO`. Il client non saprebbe tradurli e ricadrebbe sulla prosa del ' +
        'server: dichiarali nel contratto e dai a ciascuno una destinazione in ' +
        '`MAPPA_MESSAGGIO_VIDEO`.',
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
    const orfani = [...CODICI_ESITO_VIDEO].filter((codice) => !fonti.includes(codice))
    expect(
      orfani,
      'Questi codici sono dichiarati in `CODICI_ESITO_VIDEO` ma nessuna fonte li produce più. Un ' +
        'elenco più largo della misura non protegge niente: toglili, oppure — se nascono al bordo ' +
        'API e non altrove — spostali in `CODICI_BORDO_VIDEO`, che è l’elenco dichiarato apposta.',
    ).toEqual([])
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
    const dichiarati = new Set<string>([
      ...GUASTI_DI_INFRASTRUTTURA,
      ...Object.keys(CODICI_RUNNER_DEL_FILE),
    ])
    expect(dalRunner.length, 'l’estrattore non vede più i codici del runner').toBeGreaterThanOrEqual(10)
    expect(
      dalRunner.filter((codice) => !dichiarati.has(codice)),
      'Codici del runner senza una decisione «guasto nostro / guasto del file»: aggiungili a ' +
        '`GUASTI_DI_INFRASTRUTTURA` o a `CODICI_RUNNER_DEL_FILE` qui sopra, e dai loro la ' +
        'destinazione giusta in `MAPPA_MESSAGGIO_VIDEO`.',
    ).toEqual([])
    expect([...dichiarati].filter((codice) => !dalRunner.includes(codice))).toEqual([])
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
    // 180 secondi inclusi» è il requisito del piano, non un'approssimazione.
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
