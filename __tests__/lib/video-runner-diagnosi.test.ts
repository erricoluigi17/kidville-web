import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MESSAGGIO_MAX, sanificaMessaggio } from '@/lib/logging/serialize'
import { codaDiagnostica } from '@/lib/media/video/runner/diagnosi'
import { senzaUrl } from '@/lib/media/video/runner/script'

/**
 * LA DIAGNOSI LEGGIBILE — la coda dello stderr, ripulita.
 *
 * Funzioni pure su stringhe, nessun doppio: un test che passa una stringa e ne guarda
 * un'altra non può essere verde «con e senza la correzione» (è la trappola dei mock
 * piatti, già vista in questo repo). Per questo quasi ogni asserzione è un'UGUAGLIANZA
 * sul testo ripulito: una riga persa per sbaglio, o una tenuta per sbaglio, fa rosso.
 *
 * Il caso che ha reso necessario il modulo è il primo blocco: dal 29/09/2026 17 job
 * `BUILD_DOWNLOAD_FAILED`, e nel log nessuno che dicesse perché — il salvataggio teneva
 * l'INIZIO dello stderr (l'output di dnf) e il 404 di curl, in fondo, andava perso.
 *
 * ⚠️ LE FIXTURE DI DATI PERSONALI SONO FINTE, e di proposito: il repository è pubblico.
 * Le coordinate sono inventate (`+11.1111+022.2222`), i valori dei tag finiscono in
 * `…DiProva`, il JWT è fatto di un'intestazione pubblica e di un payload `{"sub":"prova"}`.
 * Il solo testo non inventato è l'inizio di dnf: nomi di repository e dimensioni.
 */

const BUDGET = MESSAGGIO_MAX - 1
const CURL_404 = 'curl: (22) The requested URL returned error: 404'

/** Un JWT finto: intestazione HS256 pubblica, payload `{"sub":"prova"}`, firma `signatura-finta`. */
const JWT_FINTO = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwcm92YSJ9.c2lnbmF0dXJhLWZpbnRh'

/**
 * L'inizio di dnf com'è nelle righe VERE di `app_log` dei job `BUILD_DOWNLOAD_FAILED`.
 * Misurate il 2026-10-02: 20 righe, tutte di 500 caratteri, nessuna con `404` né `curl`,
 * uguali dalla terza riga in poi (le prime due cambiano per la velocità e l'orario che
 * dnf scrive). Qui ne è trascritta una alla lettera, spazi compresi: sono 499 caratteri,
 * perché il logger ha messo `…` al posto del cinquecentesimo.
 */
const DNF_INIZIO_REALE = [
  'Amazon Linux 2023 repository                     84 MB/s |  76 MB     00:00    ',
  'Last metadata expiration check: 0:00:16 ago on Tue Sep 29 16:56:02 2026.',
  'Dependencies resolved.',
  '================================================================================',
  ' Package   Architecture  Version                       Repository          Size',
  '================================================================================',
  'Installing:',
  ' xz        x86_64        5.2.5-9.amzn2023.0.2          amazonlinux   ',
]

/**
 * Il seguito tipico di dnf, RICOSTRUITO: nel log vero non è arrivato mai (è proprio il
 * difetto), quindi non c'è un testo reale da trascrivere. Serve a una cosa sola: che
 * lo stderr sia molto più lungo del budget, come lo era, e che il 404 stia dopo.
 */
const DNF_SEGUITO_RICOSTRUITO = [
  '449 k',
  '',
  'Transaction Summary',
  '================================================================================',
  'Install  1 Package',
  '',
  'Total download size: 449 k',
  'Installed size: 1.2 M',
  'Downloading Packages:',
  'xz-5.2.5-9.amzn2023.0.2.x86_64.rpm              3.1 MB/s | 449 kB     00:00    ',
  '--------------------------------------------------------------------------------',
  'Total                                           2.9 MB/s | 449 kB     00:00     ',
  'Running transaction check',
  'Transaction check succeeded.',
  'Running transaction test',
  'Transaction test succeeded.',
  'Running transaction',
  '  Preparing        :                                                        1/1 ',
  '  Installing       : xz-5.2.5-9.amzn2023.0.2.x86_64                         1/1 ',
  '  Running scriptlet: xz-5.2.5-9.amzn2023.0.2.x86_64                         1/1 ',
  '  Verifying        : xz-5.2.5-9.amzn2023.0.2.x86_64                         1/1 ',
  '',
  'Installed:',
  '  xz-5.2.5-9.amzn2023.0.2.x86_64                                                ',
  '',
  'Complete!',
]

/** Lo stderr dell'apparecchio com'era nei 17 job: tutto dnf, e il motivo vero in fondo. */
const STDERR_17_JOB = `${DNF_INIZIO_REALE.join('\n')}${DNF_SEGUITO_RICOSTRUITO.join('\n')}\n${CURL_404}\n`

/** Come si salvava PRIMA (`erroreDiagnostico` in `esegui.ts`) e come lo riceveva il log. */
function comeSiSalvavaPrima(diagnosi: string): string {
  return sanificaMessaggio(senzaUrl(diagnosi).trim().slice(0, 1000))
}

/** Una metà di coppia surrogata rimasta sola, in qualunque punto: un testo non ben formato. */
function haSurrogatiOrfani(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const unita = s.charCodeAt(i)
    if (unita >= 0xd800 && unita <= 0xdbff) {
      const prossima = s.charCodeAt(i + 1)
      if (prossima >= 0xdc00 && prossima <= 0xdfff) {
        i += 1
        continue
      }
      return true
    }
    if (unita >= 0xdc00 && unita <= 0xdfff) return true
  }
  return false
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1. IL CASO DEI 17 JOB
 * ════════════════════════════════════════════════════════════════════════════ */

describe('diagnosi · il caso dei 17 job BUILD_DOWNLOAD_FAILED', () => {
  it('la fixture riproduce il guasto: il percorso di prima salvava 500 caratteri di dnf e nessun 404', () => {
    const prima = comeSiSalvavaPrima(STDERR_17_JOB)
    // Le stesse misure fatte sulle righe vere: lunghe esattamente 500, senza `404` né `curl`.
    expect(prima.length).toBe(MESSAGGIO_MAX)
    expect(prima.startsWith('Amazon Linux 2023 repository')).toBe(true)
    expect(prima).not.toContain('404')
    expect(prima).not.toContain('curl')
    // …e il motivo era lì, in fondo, a più di mille caratteri dall'inizio.
    expect(STDERR_17_JOB.lastIndexOf(CURL_404)).toBeGreaterThan(1000)
  })

  it('la coda conserva il 404, in fondo, dentro il budget del messaggio', () => {
    const coda = codaDiagnostica(STDERR_17_JOB, BUDGET)

    expect(coda.length).toBeLessThanOrEqual(BUDGET)
    expect(coda.startsWith('…')).toBe(true)
    expect(coda.endsWith(CURL_404)).toBe(true)
    // L'inizio — quello che il vecchio `slice(0, n)` conservava — è ciò che si è tagliato.
    expect(coda).not.toContain('Amazon Linux 2023 repository')
    // E non è solo l'ultima riga: dentro i 499 caratteri c'è anche il contesto di dnf.
    expect(coda).toContain('Complete!')
  })

  it('attraverso il vero `sanificaMessaggio` il 404 arriva intatto in fondo ai 500 caratteri del log', () => {
    // Il budget è `MESSAGGIO_MAX - 1` perché `sanificaMessaggio` taglia l'INIZIO del testo
    // (tiene i primi 500): un risultato più lungo perderebbe la coda proprio lì.
    const nelLog = sanificaMessaggio(codaDiagnostica(STDERR_17_JOB, MESSAGGIO_MAX - 1))

    expect(nelLog.length).toBeLessThanOrEqual(MESSAGGIO_MAX)
    expect(nelLog.endsWith(CURL_404)).toBe(true)
  })

  it('senza taglio il testo di dnf resta intero e leggibile, righe vuote e spazi di coda a parte', () => {
    const intero = codaDiagnostica(STDERR_17_JOB, 100_000)

    // I tre frammenti che il piano cita per questo caso, e la riga che contiene la parola
    // «metadata» (senza i due punti) in una frase: non è un'intestazione di blocco. Che
    // l'intestazione sia SOLTANTO `Metadata:` non lo prova questa riga: lo prova il test
    // «apre un blocco solo una riga che è SOLTANTO `Metadata:`» nella sezione dei metadati.
    expect(intero.startsWith('Amazon Linux 2023 repository')).toBe(true)
    expect(intero).toContain('76 MB')
    expect(intero).toContain('Last metadata expiration check: 0:00:16 ago on Tue Sep 29 16:56:02 2026.')
    expect(intero).toContain('Dependencies resolved.')
    expect(intero.endsWith(CURL_404)).toBe(true)

    expect(intero).not.toContain('…')
    expect(intero).not.toMatch(/\n\n/)
    expect(intero).not.toMatch(/[ \t]+$/m)
    // Stesse righe di prima, meno le vuote: nessuna riga di dnf è sparita per una parola.
    const righeIn = STDERR_17_JOB.split('\n').filter((r) => r.trim() !== '').map((r) => r.trimEnd())
    expect(intero.split('\n')).toEqual(righeIn)
  })

  it('ripulito e tagliato due volte dà lo stesso testo', () => {
    const una = codaDiagnostica(STDERR_17_JOB, BUDGET)
    expect(codaDiagnostica(una, BUDGET)).toBe(una)
  })

  it('i messaggi con cui può fallire la preparazione nuova (curl e sha256sum) passano intatti', () => {
    // Niente da togliere e niente da accorciare: sono già il motivo, in una riga o due.
    for (const messaggio of [
      CURL_404,
      'curl: (22) The requested URL returned error: 403',
      'curl: (28) Operation timed out after 60001 milliseconds with 0 bytes received',
      'curl: (6) Could not resolve host: x.invalid',
      '/tmp/kv-ffmpeg/ffmpeg.gz: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match',
    ]) {
      expect(codaDiagnostica(messaggio, BUDGET)).toBe(messaggio)
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 2. LA CODA E IL TETTO
 * ════════════════════════════════════════════════════════════════════════════ */

describe('diagnosi · le ultime battute, con l’ellissi davanti', () => {
  const CIFRE = '0123456789'.repeat(100) // mille caratteri, una riga sola

  it('tiene le ULTIME max battute e non le prime', () => {
    const r = codaDiagnostica(CIFRE, 10)
    expect(r).toBe(`…${CIFRE.slice(-9)}`)
    expect(r.length).toBe(10)
    expect(r).not.toBe(CIFRE.slice(0, 10))
  })

  it('con il testo che ci sta non aggiunge niente, e l’ellissi compare solo se ha tagliato', () => {
    expect(codaDiagnostica('riga uno\nriga due', 100)).toBe('riga uno\nriga due')
    // Lungo esattamente quanto il tetto: ci sta, nessuna ellissi.
    expect(codaDiagnostica('abcdef', 6)).toBe('abcdef')
    // Un carattere sopra il tetto: taglia, e l’ellissi occupa uno dei posti.
    expect(codaDiagnostica('abcdef', 5)).toBe('…cdef')
  })

  it('il risultato non supera MAI il tetto, per qualunque tetto', () => {
    const intero = codaDiagnostica(STDERR_17_JOB, 100_000)
    const tetti = [2, 3, 5, 50, 100, 499, intero.length - 1, intero.length, intero.length + 1, 100_000]
    for (const tetto of tetti) {
      const r = codaDiagnostica(STDERR_17_JOB, tetto)
      expect(r.length).toBeLessThanOrEqual(tetto)
      if (tetto >= intero.length) {
        expect(r).toBe(intero)
      } else {
        expect(r.startsWith('…')).toBe(true)
        expect(intero.endsWith(r.slice(1))).toBe(true)
        // Taglia solo quanto serve: il risultato riempie il tetto.
        expect(r.length).toBe(tetto)
      }
    }
  })

  it('un tetto che non è un numero positivo dà la stringa vuota, e con 1 non c’è posto per l’ellissi', () => {
    for (const tetto of [0, -1, -100, Number.NaN, -Infinity, 0.5]) {
      expect(codaDiagnostica('abcdef', tetto)).toBe('')
    }
    expect(codaDiagnostica('abcdef', 1)).toBe('f')
    expect(codaDiagnostica('abcdef', 2.9)).toBe('…f')
    expect(codaDiagnostica('abcdef', Infinity)).toBe('abcdef')
    expect(codaDiagnostica('abcdef', '5' as unknown as number)).toBe('')
  })

  it('un ingresso che non è una stringa dà la stringa vuota, senza lanciare', () => {
    for (const strano of [undefined, null, 42, {}, []]) {
      expect(codaDiagnostica(strano as unknown as string, 100)).toBe('')
    }
    expect(codaDiagnostica('', 100)).toBe('')
    expect(codaDiagnostica('   \n\n  \r\n', 100)).toBe('')
  })

  it('un taglio in mezzo a un’emoji non lascia una metà orfana', () => {
    const testo = `${'x'.repeat(10)}${'😀'.repeat(10)}` // 30 unità UTF-16
    for (let tetto = 1; tetto <= 30; tetto += 1) {
      const r = codaDiagnostica(testo, tetto)
      expect(r.length).toBeLessThanOrEqual(tetto)
      expect(haSurrogatiOrfani(r)).toBe(false)
    }
    // Il caso preciso: tetto 6 = ellissi + 5 unità, e la quinta cade a metà di un’emoji.
    expect(codaDiagnostica(testo, 6)).toBe(`…${'😀'.repeat(2)}`)
  })

  it('un ingresso che mette in difficoltà un’espressione regolare si ripulisce in un attimo', () => {
    // Tre megabyte senza un a capo: `a-a-a-…`. Con un `[\w-]*` davanti alla chiave (la
    // forma ingenua di `CHIAVE_SEGRETA`) il costo è QUADRATICO — misurato: 0,8 s a 40.000
    // caratteri, una ventina di secondi alla finestra di 200.000 — mentre con la forma di
    // oggi sono pochi millisecondi. Il tetto di due secondi non misura la velocità:
    // separa i due ordini di grandezza, con un margine che nessun CI carico colma.
    const inizio = performance.now()
    const r = codaDiagnostica('a-'.repeat(1_500_000), BUDGET)
    expect(performance.now() - inizio).toBeLessThan(2000)
    expect(r.length).toBeLessThanOrEqual(BUDGET)
  })

  it('di un testo da qualche megabyte guarda solo la coda: la testa non entra, nemmeno con un tetto enorme', () => {
    const marcatore = 'INIZIO-FUORI-DALLA-FINESTRA'
    const riga = 'riga di dnf che non dice niente'
    const enorme = `${marcatore}\n${`${riga}\n`.repeat(100_000)}` // circa 3,2 MB

    const r = codaDiagnostica(enorme, 100_000_000)
    expect(r).not.toContain(marcatore)
    expect(r.endsWith(riga)).toBe(true)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 3. URL E SEGRETI
 * ════════════════════════════════════════════════════════════════════════════ */

describe('diagnosi · URL, JWT e chiavi non arrivano nei log', () => {
  it('un indirizzo firmato sparisce, e il codice HTTP che lo accompagna resta', () => {
    const grezzo =
      `${CURL_404.replace('404', '403')} for https://x.invalid/storage/v1/object/sign/video/originale.mov?token=${JWT_FINTO}`
    const r = codaDiagnostica(grezzo, 500)

    expect(r).toBe('curl: (22) The requested URL returned error: 403 for [url-firmato]')
    expect(r).not.toContain('x.invalid')
    expect(r).not.toContain('eyJ')
    expect(r).not.toContain('token=')
  })

  const CASI_SEGRETI: Array<[string, string, string]> = [
    ['un JWT fuori da un indirizzo', `Authorization: Bearer ${JWT_FINTO}`, 'Authorization: Bearer [jwt]'],
    ['un JWT troncato a metà (la coda di un log)', 'riga eyJhbGciOiJIUzI1NiIsInR5 fine', 'riga [jwt] fine'],
    ['token= nel testo', 'upload fallito token=abc123XYZ status=403', 'upload fallito token=[segreto] status=403'],
    ['token= dentro una query senza schema', 'GET /o?x=1&token=zzzSEGRETOzzz&y=2 -> 403', 'GET /o?x=1&token=[segreto]&y=2 -> 403'],
    // Il valore non quotato finisce al primo terminatore: ciò che segue resta leggibile.
    // Senza questi due casi si può togliere la virgola o il punto e virgola dalla classe
    // dei caratteri del valore e i test restano verdi, mentre il testo dopo il valore
    // verrebbe redatto insieme al segreto: diagnosi persa.
    ['il valore finisce alla virgola', 'token=abc123,dopo', 'token=[segreto],dopo'],
    ['il valore finisce al punto e virgola', 'signature=abc123;dopo', 'signature=[segreto];dopo'],
    ['token= con un JWT per valore', `riprovo con token=${JWT_FINTO} ora`, 'riprovo con token=[segreto] ora'],
    ['token= fra apici, con gli spazi dentro', 'token="con spazi dentro" fine', 'token=[segreto] fine'],
    ['token= fra apici singoli, con gli spazi dentro', "token='con spazi dentro' fine", 'token=[segreto] fine'],
    ['access_token con i due punti', 'access_token: abc.def-ghi_123', 'access_token: [segreto]'],
    ['X-Amz-Signature', 'X-Amz-Signature=0123abcd4567ef89', 'X-Amz-Signature=[segreto]'],
    ['signature con i due punti', 'Signature: AbCdEf123', 'Signature: [segreto]'],
    ['apikey con i due punti', 'apikey: sb_secret_FINTA0123', 'apikey: [segreto]'],
    ['apikey= con una chiave non JWT', 'apikey=FINTA0123&altro=1', 'apikey=[segreto]&altro=1'],
    ['x-api-key e api_key', 'x-api-key=FINTA1 api_key=FINTA2', 'x-api-key=[segreto] api_key=[segreto]'],
    ['apikey in un JSON', '{"apikey":"FINTA-json","stato":403}', '{"apikey":[segreto],"stato":403}'],
    // La coda di un log può finire dove vuole: un valore fra apici senza l'apice di chiusura
    // arriva a fine riga, e una chiave opaca (non un JWT, che sparisce comunque per `eyJ`)
    // non deve restare in chiaro.
    ['token= fra apici doppi non chiusi (riga troncata)', 'token="sb_secret_FINTA0123', 'token=[segreto]'],
    ['apikey fra apici singoli non chiusi', "apikey: 'sb_secret_FINTA0123", 'apikey: [segreto]'],
    ['JSON troncato dopo la chiave', '{"token":"sb_secret_FINTA0123', '{"token":[segreto]'],
  ]

  it.each(CASI_SEGRETI)('%s', (_nome, ingresso, atteso) => {
    expect(codaDiagnostica(ingresso, 500)).toBe(atteso)
  })

  it('le parole non fanno scattare niente senza un valore: la diagnosi resta diagnosi', () => {
    for (const frase of [
      'Error: invalid token near line 3',
      'sha256sum: WARNING: 1 computed checksum did NOT match',
      'warning: Header V4 RSA/SHA256 Signature, key ID 8483c65d: NOKEY',
      'Unexpected token } in JSON at position 5',
    ]) {
      expect(codaDiagnostica(frase, 500)).toBe(frase)
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 4. I METADATI DEL FILMATO
 * ════════════════════════════════════════════════════════════════════════════ */

describe('diagnosi · i metadati del filmato (GPS, apparecchio, testo libero) non arrivano nei log', () => {
  /**
   * Il banner d'ingresso di ffmpeg con la forma che gli dà un iPhone: blocco `Metadata:`
   * del contenitore, uno per ciascuno stream, `Side data:` che non è un metadato. Dati finti.
   */
  const BANNER_FFMPEG = [
    `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'https://x.invalid/storage/v1/object/sign/video_originals/originale.mov?token=${JWT_FINTO}':`,
    '  Metadata:',
    '    major_brand     : qt  ',
    '    minor_version   : 0',
    '    compatible_brands: qt  ',
    '    creation_time   : 2026-09-30T10:11:12.000000Z',
    '    com.apple.quicktime.location.accuracy.horizontal: 5.000000',
    '    com.apple.quicktime.location.ISO6709: +11.1111+022.2222+033.333/',
    '    com.apple.quicktime.make: MarcaDiProva',
    '    com.apple.quicktime.model: ModelloDiProva',
    '    com.apple.quicktime.software: 18.0',
    '    com.apple.quicktime.creationdate: 2026-09-30T12:11:12+0200',
    '  Duration: 00:00:05.20, start: 0.000000, bitrate: 17081 kb/s',
    '  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 16950 kb/s, 30 fps, 30 tbr, 600 tbn (default)',
    '    Metadata:',
    '      creation_time   : 2026-09-30T10:11:12.000000Z',
    '      handler_name    : Core Media Video',
    '      vendor_id       : [0][0][0][0]',
    '      encoder         : HEVC',
    '    Side data:',
    '      displaymatrix: rotation of -90.00 degrees',
    '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 96 kb/s (default)',
    '    Metadata:',
    '      creation_time   : 2026-09-30T10:11:12.000000Z',
    '      handler_name    : Core Media Audio',
    '      vendor_id       : [0][0][0][0]',
    '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5581a1b2c3d0] stream 0, offset 0x30: partial file',
    'Error while decoding stream #0:0: Invalid data found when processing input',
  ].join('\n')

  it('i blocchi `Metadata:` spariscono interi e il resto del banner resta com’era', () => {
    expect(codaDiagnostica(BANNER_FFMPEG, 100_000)).toBe(
      [
        "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '[url-firmato]",
        '  Duration: 00:00:05.20, start: 0.000000, bitrate: 17081 kb/s',
        '  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 16950 kb/s, 30 fps, 30 tbr, 600 tbn (default)',
        '    Side data:',
        '      displaymatrix: rotation of -90.00 degrees',
        '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 96 kb/s (default)',
        '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5581a1b2c3d0] stream 0, offset 0x30: partial file',
        'Error while decoding stream #0:0: Invalid data found when processing input',
      ].join('\n'),
    )
  })

  it('nel banner non resta nessuno dei campi che dicono dove e con cosa è stato girato', () => {
    const r = codaDiagnostica(BANNER_FFMPEG, 100_000)
    for (const traccia of [
      'Metadata:',
      'ISO6709',
      '+11.1111',
      '022.2222',
      'creation_time',
      'creationdate',
      'com.apple',
      'MarcaDiProva',
      'ModelloDiProva',
      'handler_name',
      'major_brand',
      'x.invalid',
      'eyJ',
    ]) {
      expect(r).not.toContain(traccia)
    }
  })

  it('un blocco che si apre allo stesso livello del testo si chiude alla prima riga che non è più rientrata', () => {
    expect(codaDiagnostica('Metadata:\n  encoder : Lavf\n  altro : 1\nDuration: 1', 500)).toBe('Duration: 1')
    // Una riga vuota in mezzo non chiude il blocco.
    expect(codaDiagnostica('  Metadata:\n    a : 1\n\n    b : 2\n  Duration: 3', 500)).toBe('Duration: 3')
    // Due blocchi di fila allo stesso livello: si chiude il primo e se ne apre un altro.
    expect(codaDiagnostica('  Metadata:\n    a : 1\n  Metadata:\n    b : 2\n  Duration: 3', 500)).toBe('Duration: 3')
  })

  it('apre un blocco solo una riga che è SOLTANTO `Metadata:`', () => {
    // Un'intestazione allargata (una sottostringa, o «a inizio riga» e basta) si porterebbe
    // via la riga d'errore e le righe rientrate che la seguono: la perdita di diagnosi che
    // il modulo esiste per evitare. Qui `Metadata:` ha dopo di sé del testo, quindi non è
    // l'intestazione di un blocco e niente di ciò che la circonda deve sparire.
    //
    // La parola sta in mezzo alla riga: una sottostringa la scambierebbe per l'intestazione.
    const inMezzo = 'Error parsing Metadata: invalid atom\n    dettaglio rientrato\nConversion failed!'
    expect(codaDiagnostica(inMezzo, 500)).toBe(inMezzo)

    // La parola sta a inizio riga ma è seguita da altro testo: un'ancora solo in testa la
    // scambierebbe per l'intestazione, e porterebbe via anche la riga rientrata sotto di lei.
    // (Il primo rientro cade: il risultato è ripulito ai capi, le righe interne restano.)
    expect(codaDiagnostica('  Metadata: valore inatteso\n    riga rientrata\n  Duration: 1', 500)).toBe(
      'Metadata: valore inatteso\n    riga rientrata\n  Duration: 1',
    )
  })

  it('fuori dai blocchi (la coda di uno stderr può cominciare a metà) spariscono le righe dei campi personali', () => {
    const orfane = [
      '    location        : +11.1111+022.2222+033.333/',
      '    location-eng    : +11.1111+022.2222/',
      '    make            : MarcaDiProva',
      '    model           : ModelloDiProva',
      '    software        : SoftwareDiProva',
      '    title           : TitoloDiProva',
      '    comment         : CommentoDiProva',
      '    artist          : ArtistaDiProva',
      'TAG:title=TitoloDiProva',
      '      "location": "+11.1111+022.2222/",',
      '    creation_time   : 2026-09-30T10:11:12.000000Z',
      '    creationdate    : 2026-09-30T12:11:12+0200',
      '    ISO6709         : +11.1111+022.2222+033.333/',
      '    com.apple.quicktime.location.ISO6709: +11.1111+022.2222+033.333/',
      '    com.apple.quicktime.anything: valore',
      // Il nome del tag col prefisso puntato (ffmpeg su Android, ffprobe in formato `flat`):
      // la spec dice «le righe con … `model` …», e lo dice di chi nomina l'apparecchio.
      '    com.android.model: ModelloDiProva',
      'format.tags.location="+11.1111+022.2222/"',
      'TAG:com.android.model=ModelloDiProva',
      'Stream #0:0: Video: h264, 1920x1080',
    ].join('\n')

    expect(codaDiagnostica(orfane, 500)).toBe('Stream #0:0: Video: h264, 1920x1080')
  })

  it('le stesse parole dentro una frase d’errore non fanno sparire la riga', () => {
    // `make`, `model`, `title`, `comment`, `software` stanno in posizione di CHIAVE solo
    // nei metadati; in una frase sono parole qualunque, e perderle sarebbe il difetto
    // opposto: una riga diagnostica tolta per una parola comune.
    for (const frase of [
      'Error: could not make output; software scaling failed',
      'Failed to open the title card: comment not found',
      'Unable to find a suitable output format for the model',
      // Qui la parola è seguita da `:` o da `=`, ma non sta a inizio riga: non è una chiave.
      'Error: invalid value for option title: expected a string',
      "Unrecognized option 'comment=1'",
      'Last metadata expiration check: 0:00:16 ago on Tue Sep 29 16:56:02 2026.',
      // Il prefisso puntato conta solo se il nome del tag sta a inizio riga: qui `x.model`
      // sta dentro una frase. La seconda è una frase d'errore ordinaria, di controllo.
      'TypeError: x.model is undefined',
      'Memory allocation failed',
    ]) {
      expect(codaDiagnostica(frase, 500)).toBe(frase)
    }
  })

  it('un indirizzo con dentro una parola dei metadati non trascina via la riga diagnostica', () => {
    // `senzaUrl` agisce PRIMA delle regole sulle righe: il percorso di un URL contiene
    // qualunque cosa, e il motivo del guasto sta nella riga che lo accompagna.
    const grezzo = `${CURL_404} (https://x.invalid/o/com.apple.quicktime.title/creation_time?token=${JWT_FINTO})`
    expect(codaDiagnostica(grezzo, 500)).toBe(`${CURL_404} ([url-firmato]`)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 5. PROGRESSO, RIGHE VUOTE E FINI RIGA
 * ════════════════════════════════════════════════════════════════════════════ */

describe('diagnosi · il progresso riscrive la stessa riga con `\\r`: si tiene l’ultimo aggiornamento', () => {
  const AGGIORNAMENTI = [
    'frame=   10 fps=0.0 q=0.0 size=       0kB time=00:00:00.30 bitrate=   0.0kbits/s speed=0.5x    ',
    'frame=   58 fps= 50 q=28.0 size=     256kB time=00:00:01.90 bitrate=1103.8kbits/s speed=1.63x    ',
    'frame=  264 fps= 49 q=-1.0 Lsize=    4210kB time=00:00:08.80 bitrate=3919.6kbits/s speed=1.63x    ',
  ]

  it('di cento aggiornamenti resta l’ultimo, e le righe intorno restano', () => {
    const grezzo = `Conversion failed!\n${AGGIORNAMENTI.join('\r')}\nExiting with exit code 1\n`
    expect(codaDiagnostica(grezzo, 1000)).toBe(
      [
        'Conversion failed!',
        'frame=  264 fps= 49 q=-1.0 Lsize=    4210kB time=00:00:08.80 bitrate=3919.6kbits/s speed=1.63x',
        'Exiting with exit code 1',
      ].join('\n'),
    )
  })

  it('un `\\r` in fondo al testo, o dopo l’ultimo aggiornamento, non lascia una riga vuota al suo posto', () => {
    expect(codaDiagnostica('uno\rdue\rtre\r', 100)).toBe('tre')
    expect(codaDiagnostica(`${AGGIORNAMENTI.join('\r')}\r`, 1000)).toBe(
      'frame=  264 fps= 49 q=-1.0 Lsize=    4210kB time=00:00:08.80 bitrate=3919.6kbits/s speed=1.63x',
    )
  })

  it('`\\r\\n` è un fine riga e non un aggiornamento: nessuna riga viene mangiata', () => {
    expect(codaDiagnostica('prima riga\r\nseconda riga\r\nterza riga\r\n', 100)).toBe(
      'prima riga\nseconda riga\nterza riga',
    )
  })

  it('le righe vuote e gli spazi in coda a ogni riga non consumano il budget', () => {
    expect(codaDiagnostica('uno   \n\n\n  due  \n   \n', 100)).toBe('uno\n  due')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 6. IL MODULO È PURO
 * ════════════════════════════════════════════════════════════════════════════ */

describe('diagnosi · il modulo è puro: nessun SDK, nessun console, nessun catch muto', () => {
  const sorgente = readFileSync(
    join(process.cwd(), 'src/lib/media/video/runner/diagnosi.ts'),
    'utf8',
  )
  // Senza i commenti: la testata di quel file nomina proprio ciò che qui si vieta (per
  // dire che non c'è), e un controllo che legge anche i commenti si immunizza da solo.
  const codice = sorgente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const importati = Array.from(codice.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm), (m) => m[1])

  it('importa solo moduli relativi, e fra questi `senzaUrl`: riusa, non ricopia', () => {
    // Il controllo non è cieco: legge davvero l'unico import che il modulo ha.
    expect(importati.length).toBeGreaterThan(0)
    expect(importati).toContain('./script')
    for (const specificatore of importati) {
      expect(specificatore.startsWith('./') || specificatore.startsWith('../')).toBe(true)
    }
    expect(codice).not.toMatch(/@vercel\/sandbox/)
  })

  it('non scrive nei log da sé e non ha né `catch` né `throw`: non può né tacere né rompere il chiamante', () => {
    expect(codice).not.toMatch(/\bconsole\s*\./)
    expect(codice).not.toMatch(/\bcatch\b/)
    expect(codice).not.toMatch(/\bthrow\b/)
    expect(codice).not.toMatch(/\bawait\b/)
  })
})
