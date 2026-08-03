import { describe, it, expect, vi } from 'vitest'
import { promuoviMediaBozza, NEWS_BUCKET_BOZZE } from '@/lib/news/media-bozza'
import { percorsiPubbliciDelPost } from '@/lib/news/permanenza-consenso'
import { NEWS_BUCKET } from '@/lib/news/tipi'

/**
 * IL LEGAME CHE MANCAVA FRA LA PROMOZIONE E L'OBLIO.
 *
 * `promuoviMediaBozza` sposta il file da `news_bozze` (privato) a `news` (pubblico) e
 * RISCRIVE l'indirizzo che finirà nella riga di `news_posts`. Da quel momento la riga
 * è l'unica traccia del file: revoca del consenso, oblio del minore e `DELETE`
 * partono TUTTE da lì e ritrovano gli oggetti con `percorsoPubblicoNews`, che
 * riconosce **solo** il marcatore di `NEWS_BUCKET`.
 *
 * Quindi se la riscrittura nomina il bucket di SOSTA, succede questo:
 *  · il file è fisicamente nel bucket PUBBLICO (la `move()` è riuscita);
 *  · la riga lo nomina con un indirizzo che `percorsoPubblicoNews` scarta;
 *  · `percorsiPubbliciDelPost` torna `[]`, e nessuna delle tre strade trova più niente.
 * La foto di un bambino resta a un indirizzo pubblico, irraggiungibile da revoca e
 * oblio — la stessa classe di V4/W1/X1, rientrata dalla porta della promozione.
 *
 * I test che guardano la sola stringa (`toContain('/public/news/')`) vedono il sintomo.
 * Questi guardano la CONSEGUENZA: la macchina dell'oblio deve ritrovare il file.
 */
describe('promozione → oblio: l’indirizzo riscritto deve restare ritrovabile', () => {
  const PERCORSO = 'uploads/edu-1/1754000000-abc.jpg'
  const firmato = `https://cdn.test/storage/v1/object/sign/${NEWS_BUCKET_BOZZE}/${PERCORSO}?token=x`

  /**
   * Il finto Storage risponde `getPublicUrl` col nome del bucket a cui viene CHIESTO:
   * è il punto del test. Un finto che rispondesse sempre `news` nasconderebbe
   * esattamente il difetto che qui si vuole misurare.
   */
  function clientFinto() {
    return {
      storage: {
        from: (bucket: string) => ({
          move: vi.fn().mockResolvedValue({ error: null }),
          getPublicUrl: (p: string) => ({
            data: { publicUrl: `https://cdn.test/storage/v1/object/public/${bucket}/${p}` },
          }),
        }),
      },
    }
  }

  it('la copertina promossa è ritrovata da percorsiPubbliciDelPost', async () => {
    const r = await promuoviMediaBozza(
      clientFinto() as never,
      { copertinaUrl: firmato, contenutoJson: null },
      'test',
    )

    expect(r.errore).toBe(false)
    expect(r.promossi).toBe(1)
    expect(String(r.copertinaUrl)).toContain(`/public/${NEWS_BUCKET}/`)
    expect(String(r.copertinaUrl)).not.toContain(NEWS_BUCKET_BOZZE)

    // LA PARTE CHE CONTA: l'oblio deve ritrovare il file dalla riga.
    expect(percorsiPubbliciDelPost({ copertina_url: r.copertinaUrl })).toEqual([PERCORSO])
  })

  it('anche un’immagine dentro il rich-text è ritrovata', async () => {
    const r = await promuoviMediaBozza(
      clientFinto() as never,
      {
        copertinaUrl: null,
        contenutoJson: {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: firmato } }],
        },
      },
      'test',
    )

    expect(r.errore).toBe(false)
    expect(percorsiPubbliciDelPost({ contenuto_json: r.contenutoJson })).toEqual([PERCORSO])
  })

  it('copertina e rich-text che citano lo STESSO file: un percorso solo, e ritrovabile', async () => {
    // Il caso che conta per l'oblio: chiedere due volte la stessa `remove()` farebbe
    // contare due volte un file solo, e `percorsiPubbliciDelPost` deduplica apposta.
    const r = await promuoviMediaBozza(
      clientFinto() as never,
      {
        copertinaUrl: firmato,
        contenutoJson: { type: 'doc', content: [{ type: 'image', attrs: { src: firmato } }] },
      },
      'test',
    )

    expect(
      percorsiPubbliciDelPost({ copertina_url: r.copertinaUrl, contenuto_json: r.contenutoJson }),
    ).toEqual([PERCORSO])
  })
})
