import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * IL SELETTORE DI FOTO E VIDEO — le tre righe di log e il tetto dei 50 (spec video PR 2 §11.1).
 *
 * ─── PERCHÉ QUESTI TEST ESISTONO ─────────────────────────────────────────────
 * Il titolare ha scelto dall'iPhone un video da 73 MB e non è arrivato niente: nessuna miniatura,
 * nessun errore, nessun log. Le tre righe di `selettore-media.ts` servono a distinguere «Aggiungi non
 * premuto», «conversione di WebKit» e «download da iCloud». Un test che le controlla con un mock
 * piatto resterebbe verde anche con il codice sbagliato, quindi OGNI caso qui è stato visto ROSSO
 * rompendo la riga che prova (le mutazioni sono nel rapporto del compito T11b):
 *  · `tardivo` sempre `no` → cade «i file arrivano DOPO la riga di chiusura»;
 *  · timer da 15 s portato a 1,5 s → cade «a 14.999 ms non è ancora partito niente»;
 *  · `ritorno-senza-file` misurato allo scattare del timer invece che al ritorno → cade la fascia;
 *  · il nome del file dentro il messaggio → cade «mai il nome del file».
 *
 * `logClient` è finto, ma NON piatto: i test leggono le righe che arrivano davvero, e la forma di
 * ognuna è confrontata con un'espressione chiusa (`FORMA_MESSAGGIO`) che non ammette testo libero.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

import {
  ATTESA_FILE_DOPO_RITORNO_MS,
  MAX_ELEMENTI_PER_SCELTA,
  TracciaSelettore,
  fasciaAttesa,
  limitaElementi,
  riepilogaFile,
} from '@/lib/gallery/selettore-media'

interface RigaLog {
  livello: string
  evento: string
  messaggio: string
  campi?: Record<string, unknown>
}

const righe = (): RigaLog[] => h.logClient.mock.calls.map((c) => c[0] as RigaLog)
const messaggi = (): string[] => righe().map((r) => r.messaggio)
const soloQuelle = (prefisso: string): RigaLog[] => righe().filter((r) => r.messaggio.startsWith(prefisso))

/** Un file di cui interessa il tipo e il peso, non il contenuto (73 MB in memoria non servono a niente). */
function file(nome: string, tipo: string, byte = 1): File {
  const f = new File(['x'], nome, { type: tipo })
  Object.defineProperty(f, 'size', { value: byte })
  return f
}

/** Il nome di un bambino (immaginario) dentro un nome di file: è ciò che nessun log può contenere. */
const NOME_BAMBINO = 'Pinco Pallino recita di Natale'

/** Tutte e sole le forme di messaggio che il selettore può scrivere: nessun testo libero. */
const FASCIA = '(<1s|1-5s|5-30s|30s-2m|>2m)'
const FORMA_MESSAGGIO = new RegExp(
  '^gallery-selettore-(' +
    'aperto strada=(selettore-file|fotocamera-nativa) ambiente=(app|web)' +
    `|file-ricevuti mime=(image|video|misto) attesa=${FASCIA} tardivo=(si|no)` +
    `|chiuso-senza-file motivo=(cancel|ritorno-senza-file|annullato-fotocamera) attesa=${FASCIA}` +
    ')$',
)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
  h.logClient.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('fasciaAttesa — i confini sono semiaperti', () => {
  it.each([
    [0, '<1s'],
    [999, '<1s'],
    [1_000, '1-5s'],
    [4_999, '1-5s'],
    [5_000, '5-30s'],
    [29_999, '5-30s'],
    [30_000, '30s-2m'],
    [119_999, '30s-2m'],
    [120_000, '>2m'],
    [3_600_000, '>2m'],
  ])('%i ms → %s', (valore, atteso) => {
    expect(fasciaAttesa(valore)).toBe(atteso)
  })

  it('un orologio che torna indietro o un NaN non inventano una fascia alta', () => {
    expect(fasciaAttesa(-5_000)).toBe('<1s')
    expect(fasciaAttesa(Number.NaN)).toBe('<1s')
    expect(fasciaAttesa(Number.POSITIVE_INFINITY)).toBe('<1s')
  })
})

describe('limitaElementi — il tetto dei 50 vale sul totale e tiene i primi', () => {
  const elenco = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

  it('il tetto è 50 (decisione del titolare)', () => {
    expect(MAX_ELEMENTI_PER_SCELTA).toBe(50)
  })

  it('una scelta da 60 su un elenco vuoto tiene i PRIMI 50 e ne scarta 10', () => {
    const { tenuti, scartati } = limitaElementi(elenco(60), 0)
    expect(tenuti).toHaveLength(50)
    expect(tenuti[0]).toBe(1)
    expect(tenuti[49]).toBe(50)
    expect(scartati).toBe(10)
  })

  it('esattamente 50 entrano tutti: nessuno scarto', () => {
    expect(limitaElementi(elenco(50), 0)).toEqual({ tenuti: elenco(50), scartati: 0 })
  })

  it('conta anche ciò che c’era già: scegliere due volte da 30 non aggira il tetto', () => {
    const { tenuti, scartati } = limitaElementi(elenco(30), 30)
    expect(tenuti).toHaveLength(20)
    expect(scartati).toBe(10)
  })

  it('con 49 già scelti ne entra uno solo; con 50 già scelti, nessuno', () => {
    expect(limitaElementi(elenco(3), 49)).toEqual({ tenuti: [1], scartati: 2 })
    expect(limitaElementi(elenco(3), 50)).toEqual({ tenuti: [], scartati: 3 })
  })
})

describe('riepilogaFile — dal tipo MIME dichiarato, mai dal nome', () => {
  it('solo video → `video`, e i byte si sommano', () => {
    const r = riepilogaFile([file('a.mov', 'video/quicktime', 73_000_000), file('b.mp4', 'video/mp4', 1_000)])
    expect(r).toEqual({ n: 2, nVideo: 2, nFoto: 0, byteTotali: 73_001_000, mime: 'video' })
  })

  it('solo foto → `image`', () => {
    expect(riepilogaFile([file('a.jpg', 'image/jpeg', 10), file('b.png', 'image/png', 20)]))
      .toEqual({ n: 2, nVideo: 0, nFoto: 2, byteTotali: 30, mime: 'image' })
  })

  it('foto e video → `misto`', () => {
    const r = riepilogaFile([file('a.jpg', 'image/jpeg'), file('b.mp4', 'video/mp4')])
    expect(r.mime).toBe('misto')
    expect([r.nVideo, r.nFoto, r.n]).toEqual([1, 1, 2])
  })

  it('un tipo ignoto o vuoto conta in `n` ma non fra video e foto, e rende la scelta `misto`', () => {
    const r = riepilogaFile([file('a.jpg', 'image/jpeg'), file('misterioso', '')])
    expect(r).toMatchObject({ n: 2, nVideo: 0, nFoto: 1, mime: 'misto' })
  })

  it('il tipo con parametri o in maiuscolo è comunque un video (`mimeBase`)', () => {
    expect(riepilogaFile([file('a', 'video/mp4;codecs=avc1'), file('b', 'Video/MP4')]).nVideo).toBe(2)
  })

  it('NON guarda il nome: un video che si chiama `.jpg` è un video, una foto che si chiama `.mov` è una foto', () => {
    const r = riepilogaFile([file('IMG_0042.jpg', 'video/quicktime'), file('clip.mov', 'image/jpeg')])
    expect([r.nVideo, r.nFoto]).toEqual([1, 1])
  })
})

describe('riga 1 — selettore aperto', () => {
  it.each([
    ['selettore-file', 'app'],
    ['selettore-file', 'web'],
    ['fotocamera-nativa', 'app'],
  ] as const)('strada=%s ambiente=%s: livello warn, evento js, nessun campo', (strada, ambiente) => {
    new TracciaSelettore().apri(strada, ambiente)
    expect(righe()).toEqual([
      { livello: 'warn', evento: 'js', messaggio: `gallery-selettore-aperto strada=${strada} ambiente=${ambiente}` },
    ])
  })
})

describe('riga 2 — file ricevuti', () => {
  it('un video da 73 MB dopo 7 s: mime=video attesa=5-30s tardivo=no, con i numeri esatti nei campi', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    vi.advanceTimersByTime(7_000)
    t.fileRicevuti([file('clip.mov', 'video/quicktime', 73_000_000)])

    const [riga] = soloQuelle('gallery-selettore-file-ricevuti')
    expect(riga.livello).toBe('warn')
    expect(riga.messaggio).toBe('gallery-selettore-file-ricevuti mime=video attesa=5-30s tardivo=no')
    expect(riga.campi).toEqual({ n: 1, n_video: 1, n_foto: 0, byte_totali: 73_000_000, ms_da_apertura: 7_000 })
  })

  it('senza ritorno della pagina `ms_da_ritorno` NON c’è (la chiave assente è il `null` della spec)', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'web')
    t.fileRicevuti([file('a.jpg', 'image/jpeg', 5)])
    expect(soloQuelle('gallery-selettore-file-ricevuti')[0].campi).not.toHaveProperty('ms_da_ritorno')
  })

  it('foto e video insieme → mime=misto, con i due conteggi', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    t.fileRicevuti([file('a.jpg', 'image/jpeg', 100), file('b.mp4', 'video/mp4', 200), file('c.jpg', 'image/jpeg', 300)])
    const [riga] = soloQuelle('gallery-selettore-file-ricevuti')
    expect(riga.messaggio).toMatch(/mime=misto attesa=<1s tardivo=no$/)
    expect(riga.campi).toMatchObject({ n: 3, n_video: 1, n_foto: 2, byte_totali: 600 })
  })

  it('con il ritorno in primo piano porta `ms_da_ritorno` dal PRIMO ritorno, non dall’ultimo', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    vi.advanceTimersByTime(3_000)
    t.ritorno()
    vi.advanceTimersByTime(2_000)
    t.ritorno() // un secondo ritorno non sposta il riferimento
    vi.advanceTimersByTime(2_000)
    t.fileRicevuti([file('a.mov', 'video/quicktime', 10)])

    const [riga] = soloQuelle('gallery-selettore-file-ricevuti')
    expect(riga.campi).toMatchObject({ ms_da_apertura: 7_000, ms_da_ritorno: 4_000 })
    expect(riga.messaggio).toContain('attesa=5-30s tardivo=no')
  })

  it('iCloud: l’attesa è DENTRO il selettore → attesa alta e ms_da_ritorno piccolo, tardivo=no', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    vi.advanceTimersByTime(45_000) // il selettore scarica da iCloud
    t.ritorno()
    vi.advanceTimersByTime(300) // …e consegna appena la pagina torna
    t.fileRicevuti([file('a.mov', 'video/quicktime', 73_000_000)])

    const [riga] = soloQuelle('gallery-selettore-file-ricevuti')
    expect(riga.messaggio).toBe('gallery-selettore-file-ricevuti mime=video attesa=30s-2m tardivo=no')
    expect(riga.campi).toMatchObject({ ms_da_apertura: 45_300, ms_da_ritorno: 300 })
  })

  it('senza un’apertura nostra (un trascinamento) NON si scrive niente', () => {
    new TracciaSelettore().fileRicevuti([file('a.jpg', 'image/jpeg')])
    expect(righe()).toEqual([])
  })

  it('una scelta vuota non è «ricevuti» e non chiude l’apertura', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    t.fileRicevuti([])
    expect(soloQuelle('gallery-selettore-file-ricevuti')).toEqual([])
    t.cancel() // l'apertura è ancora viva
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toHaveLength(1)
  })

  it('una riga per apertura: i file di una seconda consegna non riscrivono', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    t.fileRicevuti([file('a.jpg', 'image/jpeg')])
    t.fileRicevuti([file('b.jpg', 'image/jpeg')])
    expect(soloQuelle('gallery-selettore-file-ricevuti')).toHaveLength(1)
  })

  it('la fotocamera nativa consegna una foto: stessa riga, mime=image', () => {
    const t = new TracciaSelettore()
    t.apri('fotocamera-nativa', 'app')
    vi.advanceTimersByTime(2_500)
    t.fileRicevuti([file('foto-1.jpg', 'image/jpeg', 350_000)])
    const [riga] = soloQuelle('gallery-selettore-file-ricevuti')
    expect(riga.messaggio).toBe('gallery-selettore-file-ricevuti mime=image attesa=1-5s tardivo=no')
    expect(riga.campi).toMatchObject({ n: 1, n_foto: 1, n_video: 0, byte_totali: 350_000, ms_da_apertura: 2_500 })
  })
})

describe('riga 3 — chiuso senza file, motivo=cancel', () => {
  it('l’evento cancel dell’input: motivo=cancel, la fascia e ms_da_apertura', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    vi.advanceTimersByTime(2_000)
    t.cancel()
    const [riga] = soloQuelle('gallery-selettore-chiuso-senza-file')
    expect(riga.livello).toBe('warn')
    expect(riga.messaggio).toBe('gallery-selettore-chiuso-senza-file motivo=cancel attesa=1-5s')
    expect(riga.campi).toEqual({ ms_da_apertura: 2_000 })
  })

  it('una sola riga di chiusura per apertura, anche se cancel arriva due volte', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    t.cancel()
    t.cancel()
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toHaveLength(1)
  })

  it('cancel senza apertura, o dopo che i file sono arrivati, non scrive niente', () => {
    const t = new TracciaSelettore()
    t.cancel()
    t.apri('selettore-file', 'app')
    t.fileRicevuti([file('a.jpg', 'image/jpeg')])
    t.cancel()
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toEqual([])
  })

  it('cancel dell’input non chiude una sessione della fotocamera (a dirlo è la sua promise)', () => {
    const t = new TracciaSelettore()
    t.apri('fotocamera-nativa', 'app')
    t.cancel()
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toEqual([])
  })
})

describe('riga 3 — chiuso senza file, motivo=ritorno-senza-file (il timer da 15 s)', () => {
  it('la costante è 15 secondi', () => {
    expect(ATTESA_FILE_DOPO_RITORNO_MS).toBe(15_000)
  })

  it('a 14.999 ms dal ritorno non è partito niente; a 15.000 sì, e conta dal RITORNO', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    vi.advanceTimersByTime(2_000)
    t.ritorno()

    vi.advanceTimersByTime(14_999)
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toEqual([])
    vi.advanceTimersByTime(1)

    const [riga] = soloQuelle('gallery-selettore-chiuso-senza-file')
    // 2 s dall'apertura al ritorno: fascia `1-5s`. Se si misurasse allo scattare del timer sarebbero
    // 17 s e la fascia `5-30s`: i 15 secondi sono nostri, non dell'utente.
    expect(riga.messaggio).toBe('gallery-selettore-chiuso-senza-file motivo=ritorno-senza-file attesa=1-5s')
    expect(riga.campi).toEqual({ ms_da_apertura: 2_000 })
  })

  it('i file che arrivano DOPO la riga di chiusura sono `tardivo=si`, con ms_da_ritorno grande', () => {
    // La firma della conversione di WebKit (o del download): il selettore si è chiuso, la pagina è
    // tornata, e il file arriva molto dopo.
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    vi.advanceTimersByTime(4_000)
    t.ritorno()
    vi.advanceTimersByTime(ATTESA_FILE_DOPO_RITORNO_MS) // → ritorno-senza-file
    vi.advanceTimersByTime(40_000) // …e il file arriva a 40 s dalla chiusura
    t.fileRicevuti([file('a.mov', 'video/quicktime', 73_000_000)])

    expect(messaggi()).toEqual([
      'gallery-selettore-aperto strada=selettore-file ambiente=app',
      'gallery-selettore-chiuso-senza-file motivo=ritorno-senza-file attesa=1-5s',
      'gallery-selettore-file-ricevuti mime=video attesa=30s-2m tardivo=si',
    ])
    expect(soloQuelle('gallery-selettore-file-ricevuti')[0].campi).toMatchObject({
      ms_da_apertura: 59_000,
      ms_da_ritorno: 55_000,
    })
  })

  it('i file arrivati PRIMA dei 15 secondi spengono il timer: nessuna riga di chiusura, tardivo=no', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    t.ritorno()
    vi.advanceTimersByTime(6_000)
    t.fileRicevuti([file('a.jpg', 'image/jpeg')])
    vi.advanceTimersByTime(60_000)

    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toEqual([])
    expect(soloQuelle('gallery-selettore-file-ricevuti')[0].messaggio).toContain('tardivo=no')
    expect(soloQuelle('gallery-selettore-file-ricevuti')[0].campi).toMatchObject({ ms_da_ritorno: 6_000 })
  })

  it('cancel che arriva dopo il ritorno ma prima dei 15 s vince, e il timer non scrive una seconda riga', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    t.ritorno()
    vi.advanceTimersByTime(500)
    t.cancel()
    vi.advanceTimersByTime(60_000)

    const chiusure = soloQuelle('gallery-selettore-chiuso-senza-file')
    expect(chiusure).toHaveLength(1)
    expect(chiusure[0].messaggio).toContain('motivo=cancel')
  })

  it('senza il ritorno della pagina e senza cancel non si inventa niente: resta la sola riga iniziale', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    vi.advanceTimersByTime(10 * 60_000)
    expect(messaggi()).toEqual(['gallery-selettore-aperto strada=selettore-file ambiente=app'])
  })

  it('un ritorno senza apertura non arma niente', () => {
    new TracciaSelettore().ritorno()
    vi.advanceTimersByTime(60_000)
    expect(righe()).toEqual([])
  })

  it('un’apertura nuova sostituisce la vecchia e ne spegne il timer', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    t.ritorno()
    expect(vi.getTimerCount(), 'il ritorno ha armato il timer dei 15 s').toBe(1)
    t.apri('selettore-file', 'app') // l'insegnante tocca di nuovo il riquadro
    // Il timer della vecchia apertura sarebbe comunque innocuo (non troverebbe più la sua sessione), ma
    // non deve restare in giro: è un timer vivo per ogni apertura abbandonata.
    expect(vi.getTimerCount(), 'il timer della vecchia apertura è rimasto armato').toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toEqual([])
  })

  it('lo smontaggio del componente (`chiudi`) spegne il timer', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    t.ritorno()
    t.chiudi()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toEqual([])
  })

  it('i file arrivati e il cancel spengono il timer: nessun timer resta armato', () => {
    const consegna = new TracciaSelettore()
    consegna.apri('selettore-file', 'app')
    consegna.ritorno()
    consegna.fileRicevuti([file('a.jpg', 'image/jpeg')])
    expect(vi.getTimerCount()).toBe(0)

    const annulla = new TracciaSelettore()
    annulla.apri('selettore-file', 'app')
    annulla.ritorno()
    annulla.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('con la fotocamera nativa il ritorno NON arma il timer, ma `ms_da_ritorno` si registra', () => {
    const t = new TracciaSelettore()
    t.apri('fotocamera-nativa', 'app')
    vi.advanceTimersByTime(1_000)
    t.ritorno()
    vi.advanceTimersByTime(60_000)
    // A dire che la fotocamera si è chiusa è la sua promise, non il ritorno della pagina.
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toEqual([])

    t.fileRicevuti([file('foto-1.jpg', 'image/jpeg', 10)])
    const [riga] = soloQuelle('gallery-selettore-file-ricevuti')
    expect(riga.messaggio).toContain('tardivo=no')
    expect(riga.campi).toMatchObject({ ms_da_apertura: 61_000, ms_da_ritorno: 60_000 })
  })
})

describe('riga 3 — chiuso senza file, motivo=annullato-fotocamera', () => {
  it('la fotocamera chiusa senza foto: motivo=annullato-fotocamera, fascia e ms_da_apertura', () => {
    const t = new TracciaSelettore()
    t.apri('fotocamera-nativa', 'app')
    vi.advanceTimersByTime(3_500)
    t.annullatoFotocamera()
    const [riga] = soloQuelle('gallery-selettore-chiuso-senza-file')
    expect(riga.livello).toBe('warn')
    expect(riga.messaggio).toBe('gallery-selettore-chiuso-senza-file motivo=annullato-fotocamera attesa=1-5s')
    expect(riga.campi).toEqual({ ms_da_apertura: 3_500 })
  })

  it('non scrive per una sessione del selettore di file, né senza apertura, né due volte', () => {
    const t = new TracciaSelettore()
    t.annullatoFotocamera()
    t.apri('selettore-file', 'app')
    t.annullatoFotocamera()
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toEqual([])

    t.apri('fotocamera-nativa', 'app')
    t.annullatoFotocamera()
    t.annullatoFotocamera()
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toHaveLength(1)
  })
})

describe('MAI il nome del file — e nient’altro che numeri e codici', () => {
  /** Il percorso più lungo che un'apertura possa fare, con file che portano il nome di un bambino. */
  function percorsoCompleto() {
    const t = new TracciaSelettore()
    const nomi = [
      file(`${NOME_BAMBINO}.mov`, 'video/quicktime', 73_000_000),
      file(`${NOME_BAMBINO}.jpg`, 'image/jpeg', 2_000_000),
    ]
    t.apri('selettore-file', 'app')
    vi.advanceTimersByTime(3_000)
    t.ritorno()
    vi.advanceTimersByTime(ATTESA_FILE_DOPO_RITORNO_MS)
    t.fileRicevuti(nomi) // → tardivo=si
    t.apri('fotocamera-nativa', 'app')
    t.annullatoFotocamera()
    t.apri('selettore-file', 'web')
    t.cancel()
  }

  it('nessun messaggio e nessun campo contiene il nome del file, né un pezzo, né l’estensione', () => {
    percorsoCompleto()
    // Il percorso ha scritto davvero le TRE righe: senza questo il test sarebbe verde su un log muto.
    expect(soloQuelle('gallery-selettore-aperto').length).toBeGreaterThanOrEqual(3)
    expect(soloQuelle('gallery-selettore-file-ricevuti')).toHaveLength(1)
    expect(soloQuelle('gallery-selettore-chiuso-senza-file').length).toBeGreaterThanOrEqual(3)

    const tutto = JSON.stringify(h.logClient.mock.calls)
    for (const pezzo of [NOME_BAMBINO, 'Pinco', 'Pallino', 'Natale', '.mov', '.jpg']) {
      expect(tutto, `«${pezzo}» è finito in un log`).not.toContain(pezzo)
    }
  })

  it('i messaggi hanno SOLO le forme dell’elenco chiuso, e i campi sono tutti numeri', () => {
    percorsoCompleto()
    for (const riga of righe()) {
      expect(riga.messaggio, `forma non ammessa: «${riga.messaggio}»`).toMatch(FORMA_MESSAGGIO)
      expect(riga.livello).toBe('warn')
      for (const [chiave, valore] of Object.entries(riga.campi ?? {})) {
        expect(typeof valore, `il campo ${chiave} non è un numero`).toBe('number')
        expect(Number.isInteger(valore), `il campo ${chiave} non è intero`).toBe(true)
      }
    }
  })
})

describe('fail-open — il tracciatore non rompe mai la scelta del file', () => {
  /** Un file ostile: leggerne il tipo lancia (e il messaggio dell'errore nomina il file). */
  function fileOstile(): File {
    const f = new File(['x'], `${NOME_BAMBINO}.mov`, { type: 'video/quicktime' })
    Object.defineProperty(f, 'type', {
      get() {
        throw new TypeError(`non leggibile: ${NOME_BAMBINO}`)
      },
    })
    return f
  }

  it('un File che lancia non fa lanciare `fileRicevuti`, e l’incidente si registra col solo NOME della classe', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    expect(() => t.fileRicevuti([fileOstile()])).not.toThrow()

    const [riga] = soloQuelle('gallery-selettore-traccia-fallita')
    expect(riga).toBeDefined()
    expect(riga.livello).toBe('warn')
    expect(riga.campi).toEqual({ tipo: 'TypeError' })
    expect(JSON.stringify(righe())).not.toContain('Pinco')
  })

  it('…e il timer dei 15 s non scrive «ritorno-senza-file» per file che sono arrivati', () => {
    const t = new TracciaSelettore()
    t.apri('selettore-file', 'app')
    t.ritorno()
    t.fileRicevuti([fileOstile()])
    vi.advanceTimersByTime(60_000)
    expect(soloQuelle('gallery-selettore-chiuso-senza-file')).toEqual([])
  })
})
