import { describe, expect, it } from 'vitest'
import { filtroGiornatePending } from '@/lib/notifiche/giornate-pending'
import { creaFintoSupabase, type Riga } from '../fixtures/finto-supabase'

const seleziona = async (giorni: string[], notifiche: Riga[], disponibili?: Parameters<typeof filtroGiornatePending>[1]) => {
  const db = { notifiche }
  const { error } = await creaFintoSupabase(db).from('notifiche').delete()
    .eq('entita_id', 'fonte').in('utente_id', ['genitore']).is('push_inviata_il', null)
    .or(filtroGiornatePending(giorni, disponibili))
  expect(error).toBeNull()
  return db.notifiche.map(n => n.id)
}
const riga = (id: string, extra: Riga = {}): Riga => ({ id, entita_id: 'fonte', utente_id: 'genitore', push_inviata_il: null, giorno_competenza: null, politica_operazione: null, creato_il: '2026-09-09T21:55:00.000Z', invio_programmato_il: '2026-09-09T22:05:00.000Z', ...extra })

describe('giornate pending — OR applicato alle righe, con precedenza dei metadati', () => {
  it('usa la creazione a Roma, non la programmazione oltre mezzanotte, e preserva gli altri perimetri', async () => {
    expect(await seleziona(['2026-09-09'], [
      riga('ieri'), riga('oggi', { creato_il: '2026-09-09T22:00:00.000Z' }),
      riga('altro', { creato_il: '2026-09-08T21:55:00.000Z' }),
      riga('inviata', { push_inviata_il: '2026-09-09T22:06:00Z' }),
      riga('altra-fonte', { entita_id: 'altra' }), riga('altro-genitore', { utente_id: 'altro' }),
    ])).toEqual(['oggi', 'altro', 'inviata', 'altra-fonte', 'altro-genitore'])
  })
  it('il giorno in colonna prevale sulla politica, che prevale sulla creazione legacy', async () => {
    expect(await seleziona(['2026-09-09'], [
      riga('colonna-ieri', { giorno_competenza: '2026-09-09', politica_operazione: { giornoCompetenza: '2026-09-10' }, creato_il: '2026-09-10T10:00:00Z' }),
      riga('colonna-oggi', { giorno_competenza: '2026-09-10', politica_operazione: { giornoCompetenza: '2026-09-09' } }),
      riga('politica-ieri', { politica_operazione: { giornoCompetenza: '2026-09-09' }, creato_il: '2026-09-10T10:00:00Z' }),
      riga('politica-oggi', { politica_operazione: { giornoCompetenza: '2026-09-10' } }),
      riga('politica-incompleta', { politica_operazione: { sopprimiGenitori: true } }),
    ])).toEqual(['colonna-oggi', 'politica-oggi', 'politica-incompleta'])
  })
  it.each([
    ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z', 23],
    ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 25],
  ])('il giorno DST %s include tutti i suoi istanti e termina con estremo esclusivo', async (giorno, inizio, fine, ore) => {
    expect((Date.parse(fine) - Date.parse(inizio)) / 3_600_000).toBe(ore)
    const prima = new Date(Date.parse(inizio) - 1).toISOString()
    const ultima = new Date(Date.parse(fine) - 1).toISOString().replace('.999Z', '.999999Z')
    expect(await seleziona([giorno], [riga('prima', { creato_il: prima }), riga('inizio', { creato_il: inizio }), riga('ultimo-microsecondo', { creato_il: ultima }), riga('successivo', { creato_il: fine })])).toEqual(['prima', 'successivo'])
  })
  it.each([
    { giornoCompetenza: false, politicaOperazione: true },
    { giornoCompetenza: true, politicaOperazione: false },
    { giornoCompetenza: false, politicaOperazione: false },
  ])('schema parziale: il filtro omette esclusivamente le colonne realmente assenti %o', async disponibili => {
    const filtro = filtroGiornatePending(['2026-09-09'], disponibili)
    if (!disponibili.giornoCompetenza) expect(filtro).not.toContain('giorno_competenza')
    if (!disponibili.politicaOperazione) expect(filtro).not.toContain('politica_operazione')
    expect(await seleziona(['2026-09-09'], [riga('ieri'), riga('oggi', { creato_il: '2026-09-10T08:00:00Z' })], disponibili)).toEqual(['oggi'])
  })
  it('non accetta un filtro senza giornate o con date non valide', () => {
    expect(() => filtroGiornatePending([])).toThrow(RangeError)
    expect(() => filtroGiornatePending(['2026-02-30'])).toThrow(RangeError)
  })
})
