import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { consegnaVideoInBozzaNews, percorsoAllegatoVideoNews } from '@/lib/news/video-allegato'
import { NEWS_BUCKET_BOZZE, promuoviMediaBozza } from '@/lib/news/media-bozza'
import { mediaEstranei, percorsiPubbliciDelPost } from '@/lib/news/permanenza-consenso'
import { contieneFoto } from '@/lib/news/foto-nel-post'
import { NEWS_BUCKET } from '@/lib/news/tipi'

// =============================================================================
// IL CRITERIO D'ACCETTAZIONE DI V09, SCRITTO COME TEST.
//
// «Il video deve passare da `promuoviMediaBozza` SENZA UNA RIGA NUOVA in
// `media-bozza.ts`.»
//
// Non è un vezzo di stile: `media-bozza.ts` è il punto in cui un file smette di
// essere privato e diventa leggibile da chiunque, senza login. È la superficie di
// privacy più delicata del repository. La decisione del piano — copiare l'uscita
// del video nel bucket delle bozze AL MOMENTO DEL `ready` — costa una copia in
// più e in cambio lascia quel percorso esattamente com'era: se il video arriva
// nell'area di sosta con la stessa forma di una foto, la promozione non ha
// bisogno di sapere che è un video.
//
// Questo file misura le due metà della frase:
//  1. il video ATTRAVERSA davvero la promozione, e resta ritrovabile dall'oblio;
//  2. `media-bozza.ts` NON contiene nessun ramo che parli di video.
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111'
const ALTRO_DOCENTE = '99999999-9999-4999-8999-999999999999'
const JOB = '22222222-2222-4222-8222-222222222222'

/**
 * Lo Storage finto risponde col nome del bucket a cui viene CHIESTO — la stessa
 * scelta di `media-bozza-promozione-oblio.test.ts`: un finto che rispondesse
 * sempre `news` nasconderebbe proprio il difetto che qui si misura.
 */
function storageFinto() {
  return {
    storage: {
      from: (bucket: string) => ({
        list: async (_cartella: string, opts?: { search?: string }) => ({
          data: [{ name: opts?.search, metadata: { mimetype: 'video/mp4' } }],
          error: null,
        }),
        copy: async (_da: string, a: string) => ({ data: { path: a }, error: null }),
        move: vi.fn().mockResolvedValue({ error: null }),
        createSignedUrl: async (percorso: string) => ({
          data: {
            signedUrl: `https://cdn.test/storage/v1/object/sign/${bucket}/${percorso}?token=x`,
          },
          error: null,
        }),
        getPublicUrl: (p: string) => ({
          data: { publicUrl: `https://cdn.test/storage/v1/object/public/${bucket}/${p}` },
        }),
      }),
    },
  }
}

describe('un video consegnato al `ready` è un allegato di bozza come tutti gli altri', () => {
  it('attraversa `promuoviMediaBozza` e resta ritrovabile dall’oblio', async () => {
    const supabase = storageFinto()

    // 1. Il runner ha finito: l'uscita viene consegnata nell'area di sosta.
    const consegna = await consegnaVideoInBozzaNews(
      supabase as never,
      {
        id: JOB,
        ownerId: OWNER,
        bucketUscita: 'video_processing',
        percorsoUscita: `esiti/${JOB}/1/uscita.mp4`,
      },
      'test',
    )
    expect(consegna.ok).toBe(true)
    if (!consegna.ok) return

    // 2. L'editor infila l'anteprima firmata nel rich-text della bozza.
    const contenutoJson = {
      type: 'doc',
      content: [{ type: 'video', attrs: { src: consegna.url } }],
    }

    // 3. Il post nasce: il controllo «non stai adottando il file di un altro»
    //    riconosce il video come roba di chi lo ha caricato…
    expect(mediaEstranei({ contenuto_json: contenutoJson }, [], OWNER)).toEqual([])
    // …e lo rifiuta a chiunque altro, esattamente come farebbe con una foto.
    expect(mediaEstranei({ contenuto_json: contenutoJson }, [], ALTRO_DOCENTE)).toEqual([
      consegna.percorso,
    ])

    // 4. Passato il gate del consenso, la promozione: quella che esiste già.
    const promozione = await promuoviMediaBozza(
      supabase as never,
      { copertinaUrl: null, contenutoJson },
      'test',
    )
    expect(promozione.errore).toBe(false)
    expect(promozione.promossi).toBe(1)
    expect(promozione.promossiPercorsi).toEqual([consegna.percorso])

    // 5. LA PARTE CHE CONTA: dalla riga salvata, revoca del consenso, oblio del
    //    minore e `DELETE` devono ritrovare il file nel bucket pubblico.
    expect(percorsiPubbliciDelPost({ contenuto_json: promozione.contenutoJson })).toEqual([
      `uploads/${OWNER}/${JOB}.mp4`,
    ])
    expect(JSON.stringify(promozione.contenutoJson)).toContain(`/public/${NEWS_BUCKET}/`)
    expect(JSON.stringify(promozione.contenutoJson)).not.toContain(NEWS_BUCKET_BOZZE)
  })

  it('anche come copertina del post', async () => {
    const supabase = storageFinto()
    const consegna = await consegnaVideoInBozzaNews(
      supabase as never,
      {
        id: JOB,
        ownerId: OWNER,
        bucketUscita: 'video_processing',
        percorsoUscita: `esiti/${JOB}/1/uscita.mp4`,
      },
      'test',
    )
    expect(consegna.ok).toBe(true)
    if (!consegna.ok) return

    const promozione = await promuoviMediaBozza(
      supabase as never,
      { copertinaUrl: consegna.url, contenutoJson: null },
      'test',
    )
    expect(percorsiPubbliciDelPost({ copertina_url: promozione.copertinaUrl })).toEqual([
      percorsoAllegatoVideoNews(OWNER, JOB),
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA MISURA CHE NON DECIDE NIENTE: il consenso fotografico e il video
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ QUESTA NON È UNA DECISIONE, È UNA MISURA — e va portata a chi decide.
 *
 * Il piano dice «consenso foto attuale invariato, **video esenti**». Misurato sul
 * codice il 2026-09-18, il comportamento di oggi NON è uno solo: dipende da DOVE
 * sta il video, e la differenza non l'ha scelta nessuno.
 *
 *  · nel rich-text (nodo `video`) → `contieneFoto` è falso → il gate non scatta,
 *    cioè il video è esente come il piano vuole;
 *  · in COPERTINA → `contieneFoto` guarda solo se `copertina_url` è una stringa
 *    non vuota, quindi è vero per QUALUNQUE media → il gate scatta, e senza
 *    `bambini_ritratti` la pubblicazione viene rifiutata.
 *
 * `contieneFoto` è del 2026-08 e non poteva sapere che sarebbero esistiti i
 * video. Questo test non cambia il comportamento e non lo approva: lo INCHIODA,
 * così la scelta — esentare anche la copertina, o estendere la dichiarazione ai
 * video — si prende guardando un numero invece che una memoria. Chi la prende
 * cambi questo test, e scriva accanto perché.
 */
describe('misura · dove sta il video decide se il gate del consenso scatta', () => {
  const firmato = `https://cdn.test/storage/v1/object/sign/${NEWS_BUCKET_BOZZE}/uploads/${OWNER}/${JOB}.mp4?token=x`

  it('nel rich-text il video NON fa scattare la dichiarazione dei ritratti', () => {
    expect(
      contieneFoto(null, { type: 'doc', content: [{ type: 'video', attrs: { src: firmato } }] }),
    ).toBe(false)
  })

  it('in COPERTINA lo fa scattare — e il piano dice «video esenti»', () => {
    expect(contieneFoto(firmato, null)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL LOCK: la promozione resta CIECA al tipo di media
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Si scandisce il CODICE, non il testo: i commenti di `media-bozza.ts` parlano —
 * giustamente — di ciò che quel file protegge, e un lock che leggesse anche
 * quelli accuserebbe la spiegazione di essere il difetto. È il rovescio della
 * trappola già pagata qui dentro (un lock immunizzato dal proprio commento): la
 * regola è la stessa, si guarda ciò che ESEGUE.
 */
function soloCodice(sorgente: string): string {
  return sorgente
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((r) => !/^\s*(\/\/|\*)/.test(r))
    .join('\n')
}

const PAROLE_DEL_VIDEO = ['video', 'mp4', 'codec', 'job', 'transcod', 'conversione']

describe('lock · `media-bozza.ts` non sa che esistono i video, e deve restare così', () => {
  const file = join(process.cwd(), 'src', 'lib', 'news', 'media-bozza.ts')
  const codice = soloCodice(readFileSync(file, 'utf8'))

  it('lo scanner vede davvero il codice (asserzione di autoinganno)', () => {
    // Senza questa, uno stripper troppo goloso svuoterebbe il file e il lock
    // passerebbe su niente — verde, e cieco.
    expect(codice).toContain('export async function promuoviMediaBozza')
    expect(codice).toContain('destinationBucket: NEWS_BUCKET')
    expect(codice.length).toBeGreaterThan(2000)
  })

  it('nessun ramo del codice nomina il video', () => {
    const trovate = PAROLE_DEL_VIDEO.filter((p) => new RegExp(p, 'i').test(codice))
    expect(trovate).toEqual([])
  })

  it('la promozione tratta OGNI media allo stesso modo: una sola `move()`, nessun ramo sul tipo', () => {
    // Se un giorno servisse un `if (è un video)` qui dentro, la decisione del
    // piano V09 sarebbe saltata e questo lock è il posto in cui accorgersene.
    const move = codice.match(/\.move\(/g) ?? []
    expect(move).toHaveLength(2) // promozione e ritorno in sosta: una per verso.
  })
})
