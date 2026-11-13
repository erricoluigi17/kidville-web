import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BAMBINI, UTENTE, creaBancoPassaggio, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'

/**
 * COMPITO 4.8.10 · il passaggio dall'inizio alla fine, su un banco solo (PGlite), in una transazione che finisce in ROLLBACK.
 * Anteprima → decisioni della segreteria → conferma → invarianti → annulla → anteprima di nuovo → riconferma.
 * Il giorno del passaggio viene dal database (`b.oggi`), mai da un calendario scritto qui: il test non scade.
 */
let b: BancoPassaggio
beforeAll(async () => {
  b = await creaBancoPassaggio()
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})

const anteprima = async () =>
  (await una<{ passaggio_id: string }>(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.da, b.a, UTENTE])).passaggio_id
const correggi = (p: string, alunno: string, esito: string, sezione: string | null = null) =>
  b.db.query(`SELECT public.passaggio_riga_correggi($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid)`, [p, alunno, esito, sezione, UTENTE])
const conferma = (p: string) =>
  una<{ gia_confermato: boolean; conteggi: Record<string, number> }>(b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])
const annulla = (p: string) =>
  una<{ gia_annullato?: boolean }>(b.db, `SELECT public.passaggio_annulla($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])
const stato = async (id: string) => await una<string>(b.db, `SELECT stato FROM public.anni_sede WHERE id = $1`, [id])
const invarianti = async () =>
  (await b.db.query<{ invariante: number | string; tabella: string | null }>(`SELECT invariante, tabella FROM public.anno_invarianti() WHERE righe > 0 ORDER BY 1, 2`)).rows
const fotografia = async () =>
  JSON.stringify([
    (await b.db.query(`SELECT id, stato, section_id, data_uscita FROM public.frequenze ORDER BY id`)).rows,
    (await b.db.query(`SELECT id, stato, section_id, (archiviato_il IS NULL) AS vivo FROM public.alunni ORDER BY id`)).rows,
    (await b.db.query(`SELECT id, stato, domande_aperte FROM public.anni_sede ORDER BY id`)).rows,
  ])

describe('il passaggio, dall’inizio alla fine', () => {
  it('anteprima, decisioni, conferma, annullamento, anteprima nuova e riconferma', async () => {
    await inRollback(b.db, async () => {
      const prima = await fotografia()
      const invariantiPrima = await invarianti()

      const p = await anteprima()
      await correggi(p, BAMBINI.ritiratoTendina, 'continua')
      await correggi(p, BAMBINI.cambiaGradoSenzaSezione, 'esce')

      const r = await conferma(p)
      expect(r.gia_confermato).toBe(false)
      expect(await stato(b.da)).toBe('in_chiusura')
      expect(await stato(b.a)).toBe('corrente')
      expect(await invarianti(), 'dopo la conferma nessuna invariante in più').toEqual(invariantiPrima)
      expect((await conferma(p)).gia_confermato, 'rifare la conferma non fa nulla').toBe(true)

      const a1 = await annulla(p)
      expect(a1.gia_annullato ?? false).toBe(false)
      expect(await fotografia(), 'annullato = come prima').toBe(prima)
      expect((await annulla(p)).gia_annullato).toBe(true)

      const p2 = await anteprima()
      expect(p2, 'dopo l’annullamento nasce un passaggio nuovo').not.toBe(p)
      await correggi(p2, BAMBINI.ritiratoTendina, 'continua')
      await correggi(p2, BAMBINI.cambiaGradoSenzaSezione, 'esce')
      expect((await conferma(p2)).conteggi).toEqual(r.conteggi)
      expect(await invarianti()).toEqual(invariantiPrima)
    })
  })
})
