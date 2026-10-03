import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * IL CONFINE FRA LA GALLERIA E IL PLUGIN, per il passo «scelta» — `src/lib/gallery/selettore-nativo.ts`
 * (app 1.2, spec «caricamenti nativi» §7.2-§7.3, compito J2).
 *
 * Tre funzioni, e il loro contratto sta in due frasi:
 *  · NESSUNA lancia — un guasto del ponte non deve far cadere la schermata che mostra le anteprime;
 *  · NESSUNA scrive un nome, un percorso, un id di elemento o il messaggio di un errore di sistema: il
 *    rifiuto del ponte esce come CODICE dell'elenco chiuso (`codiceDelPonte`, quello vero) e basta.
 *
 * `@/lib/native/caricamenti-nativi` è finto SOLO nelle chiamate al ponte (`leggiFoto`, `scartaScelti`): tiene
 * VERI `codiceDelPonte` e `ErroreCaricamentiNativi`, che sono ciò che riduce un rifiuto a un codice.
 *
 * Ogni caso è stato visto ROSSO rompendo il codice che prova (le mutazioni sono nel rapporto di J2).
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), leggiFoto: vi.fn(), scartaScelti: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))
vi.mock('@/lib/native/caricamenti-nativi', async (originale) => ({
  ...(await originale<typeof import('@/lib/native/caricamenti-nativi')>()),
  leggiFoto: h.leggiFoto,
  scartaScelti: h.scartaScelti,
}))

import { ErroreCaricamentiNativi } from '@/lib/native/caricamenti-nativi'
import type { ElementoFotoScelta, ElementoVideoScelto } from '@/lib/native/caricamenti-nativi-tipi'
import {
  elementoCaricabileDaVideo,
  leggiFotoComeFile,
  scartaPreparatiNativi,
} from '@/lib/gallery/selettore-nativo'

const NOME_BAMBINO = 'Pinco Pallino recita di Natale'
const SHA = 'b'.repeat(64)

const video = (extra: Partial<ElementoVideoScelto> = {}): ElementoVideoScelto => ({
  id: 'video-1', tipo: 'video', nome: 'filmato.mov', byte: 1234, mime: 'video/quicktime',
  durataSecondi: 12, miniatura: 'data:image/jpeg;base64,/9j/AAAA', sha256: SHA, ...extra,
})
const foto = (extra: Partial<ElementoFotoScelta> = {}): ElementoFotoScelta => ({
  id: 'foto-1', tipo: 'foto', nome: 'IMG_0042.HEIC', larghezza: 1920, altezza: 1080, byte: 3, ...extra,
})

const righe = () => h.logClient.mock.calls.map((c) => c[0] as { livello: string; evento: string; messaggio: string; campi?: Record<string, unknown> })

beforeEach(() => {
  vi.clearAllMocks()
  h.scartaScelti.mockResolvedValue({ eliminati: 1 })
  h.leggiFoto.mockResolvedValue({ base64: 'AQID', mime: 'image/jpeg', byte: 3, larghezza: 1920, altezza: 1080 })
})

describe('elementoCaricabileDaVideo — un video preparato diventa un elemento della schermata', () => {
  it('`file` è `null`, `nativo` è il video com’è, e l’anteprima è la miniatura', () => {
    const v = video()
    const e = elementoCaricabileDaVideo(v)
    expect(e.file).toBeNull()
    expect(e.nativo).toBe(v)
    expect(e.preview).toBe('data:image/jpeg;base64,/9j/AAAA')
  })

  it('senza miniatura l’anteprima è la stringa vuota (mai `null`: `preview` è sempre una stringa)', () => {
    const e = elementoCaricabileDaVideo(video({ miniatura: null }))
    expect(e.preview).toBe('')
    expect(typeof e.preview).toBe('string')
  })
})

describe('scartaPreparatiNativi — cancella dal telefono ciò che nessuno porterà avanti', () => {
  it('chiama il ponte UNA volta con gli id; gli id ripetuti contano una volta', async () => {
    await scartaPreparatiNativi(['a', 'b', 'a', 'c', 'b'])
    expect(h.scartaScelti).toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['a', 'b', 'c'] })
  })

  it('senza id NON chiama il ponte (non c’è niente da fare)', async () => {
    await scartaPreparatiNativi([])
    expect(h.scartaScelti).not.toHaveBeenCalled()
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('un rifiuto del ponte NON lancia: `warn` con il CODICE e il numero di elementi, mai un id', async () => {
    h.scartaScelti.mockRejectedValue(new ErroreCaricamentiNativi('INTERNO'))
    await expect(scartaPreparatiNativi(['video-segreto-1', 'video-segreto-2'])).resolves.toBeUndefined()
    expect(righe()).toEqual([
      { livello: 'warn', evento: 'caricamento-nativo', messaggio: 'selettore-nativo-scarto-fallito: INTERNO', campi: { n: 2 } },
    ])
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('segreto')
  })

  it('un rifiuto che non è del ponte vale `SCONOSCIUTO` (il suo messaggio non esce)', async () => {
    h.scartaScelti.mockRejectedValue(new Error(`/var/mobile/${NOME_BAMBINO}.mov`))
    await scartaPreparatiNativi(['x'])
    expect(righe()[0].messaggio).toBe('selettore-nativo-scarto-fallito: SCONOSCIUTO')
    expect(JSON.stringify(h.logClient.mock.calls)).not.toMatch(/Pinco|mobile/)
  })

  it('un codice che il ponte invia ma che non è dell’elenco chiuso vale `SCONOSCIUTO`', async () => {
    h.scartaScelti.mockRejectedValue(Object.assign(new Error('x'), { code: 'CODICE_INVENTATO_DAL_NATIVO' }))
    await scartaPreparatiNativi(['x'])
    expect(righe()[0].messaggio).toBe('selettore-nativo-scarto-fallito: SCONOSCIUTO')
  })
})

describe('leggiFotoComeFile — una foto preparata diventa un `File` JPEG', () => {
  it('chiama `leggiFoto` con l’id e restituisce un `File` image/jpeg dal nome «<nome senza estensione>.jpg»', async () => {
    const f = await leggiFotoComeFile(foto({ id: 'foto-77', nome: 'IMG_0042.HEIC' }))
    expect(h.leggiFoto).toHaveBeenCalledWith({ id: 'foto-77' })
    expect(f).toBeInstanceOf(File)
    expect(f?.name).toBe('IMG_0042.jpg')
    expect(f?.type).toBe('image/jpeg')
    expect(f?.size).toBe(3)
    expect(h.logClient, 'il successo di una foto non si logga: sono le tre righe del selettore a farlo').not.toHaveBeenCalled()
  })

  it('i byte del file sono quelli del base64 (AQID = 1, 2, 3), non un segnaposto', async () => {
    const f = await leggiFotoComeFile(foto())
    expect(Array.from(new Uint8Array(await (f as File).arrayBuffer()))).toEqual([1, 2, 3])
  })

  it('un base64 più lungo si decodifica intero (nessun taglio)', async () => {
    const originale = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256)
    h.leggiFoto.mockResolvedValue({ base64: btoa(String.fromCharCode(...originale)), mime: 'image/jpeg', byte: 300, larghezza: 10, altezza: 10 })
    const f = await leggiFotoComeFile(foto({ byte: 300 }))
    expect(Array.from(new Uint8Array(await (f as File).arrayBuffer()))).toEqual(Array.from(originale))
  })

  it('un rifiuto del ponte: `null` e `foto-nativa-non-letta: <CODICE>` a livello error, senza id né nome', async () => {
    h.leggiFoto.mockRejectedValue(new ErroreCaricamentiNativi('ELEMENTO_ASSENTE'))
    await expect(leggiFotoComeFile(foto({ nome: `${NOME_BAMBINO}.HEIC`, id: 'foto-segreta' }))).resolves.toBeNull()
    expect(righe()).toEqual([
      { livello: 'error', evento: 'caricamento-nativo', messaggio: 'foto-nativa-non-letta: ELEMENTO_ASSENTE' },
    ])
    expect(JSON.stringify(h.logClient.mock.calls)).not.toMatch(/Pinco|segreta|HEIC/)
  })

  it('un base64 che non si decodifica vale `RISPOSTA_NON_VALIDA` (come una risposta fuori forma), non un’eccezione', async () => {
    h.leggiFoto.mockResolvedValue({ base64: '!!!non-base64!!!', mime: 'image/jpeg', byte: 3, larghezza: 1, altezza: 1 })
    await expect(leggiFotoComeFile(foto())).resolves.toBeNull()
    expect(righe()[0]).toMatchObject({ livello: 'error', messaggio: 'foto-nativa-non-letta: RISPOSTA_NON_VALIDA' })
  })

  it('il nome del file segue `nomeFotoJpeg`: un nome senza estensione o vuoto non produce «.jpg» nudo', async () => {
    expect((await leggiFotoComeFile(foto({ nome: 'senza-estensione' })))?.name).toBe('senza-estensione.jpg')
    expect((await leggiFotoComeFile(foto({ nome: '.HEIC' })))?.name).toBe('foto.jpg')
  })
})
