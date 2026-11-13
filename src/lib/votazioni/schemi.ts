import { z } from 'zod'
import { zDataOraLocale, zUuid } from '@/lib/validation/common'
import { istanteDaLocale } from '@/lib/format/confini-giorno'
import { zCorrezione } from '@/lib/anno/correzione'
import { AMBITI, TITOLO_MAX } from './tipi'

/**
 * VOTAZIONI · GLI SCHEMI ZOD DEI CONFINI.
 *
 * Validano soltanto la FORMA. Le regole che hanno bisogno del database (classe della sede, candidato
 * genitore della sede, scadenza nel futuro, classe già in una votazione aperta) le applicano le route.
 *
 * ── LA SCADENZA ──────────────────────────────────────────────────────────────
 *
 * Dal client arriva come `YYYY-MM-DDTHH:MM` (le cifre del campo `datetime-local`, `zDataOraLocale`) e
 * NON come ISO con fuso: un ISO costruito dal browser porta con sé l’orologio e il fuso del tablet. La
 * conversione in istante la fa il server, con `scadenzaInIstante` (Roma: la stessa matematica di
 * `istanteDaLocale`, provata una volta sola).
 *
 * ── L’ELETTORE NON È NEL BODY ────────────────────────────────────────────────
 *
 * `votoSchema` non ha un campo per chi vota, e `z.object` scarta i campi che non conosce: l’elettore è
 * sempre `auth.user.id`, e un client che ne manda un altro non ottiene niente.
 */

/** Toglie i doppioni (in Postgres `uuid` è un tipo: la maiuscola non distingue) e porta in minuscolo. */
function senzaDoppioni(ids: string[]): string[] {
  const visti = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const forma = id.trim().toLowerCase()
    if (visti.has(forma)) continue
    visti.add(forma)
    out.push(forma)
  }
  return out
}

/** Il body di `POST /api/admin/votazioni`. */
export const creaVotazioneSchema = z.object({
  scuolaId: zUuid.optional(),
  // `anni_scolastici.id` dichiarato; assente → l'anno del cookie o l'unico `corrente` della sede.
  annoId: zUuid.optional(),
  titolo: z.string().trim().min(1).max(TITOLO_MAX),
  scadenza: zDataOraLocale,
  // Può essere vuoto: la route risponde 400 VOTAZIONE_SENZA_SCHEDE se non c’è nemmeno l’istituto.
  sectionIds: z.array(zUuid).max(100).transform(senzaDoppioni),
  rappresentanteIstituto: z.boolean(),
  // Deduplicato come le classi: lo stesso candidato due volte sarebbe un 23505 sulla chiave di
  // `votazioni_candidati`, cioè un 500 per un doppio clic.
  candidatiIstituto: z.array(zUuid).max(200).transform(senzaDoppioni).default([]),
  // Su un anno chiuso la segreteria registra una CORREZIONE (PR 4.9): il motivo sta nella riga del gettone, mai in un log.
  correzione: zCorrezione.optional(),
})
export type CreaVotazioneInput = z.infer<typeof creaVotazioneSchema>

/** Il body di `PATCH /api/admin/votazioni/[id]`. */
export const azioneVotazioneSchema = z.discriminatedUnion('azione', [
  // Su un anno chiuso la segreteria registra una CORREZIONE (PR 4.9): il motivo sta nella riga del gettone, mai in un log.
  z.object({ azione: z.literal('chiudi'), correzione: zCorrezione.optional() }),
  z.object({ azione: z.literal('proroga'), scadenza: zDataOraLocale, correzione: zCorrezione.optional() }),
])

/** Il corpo FACOLTATIVO di `DELETE /api/admin/votazioni/[id]`: vuoto, o `{ correzione }` su un anno chiuso. */
export const eliminaVotazioneSchema = z.object({ correzione: zCorrezione.optional() })
export type AzioneVotazioneInput = z.infer<typeof azioneVotazioneSchema>

/**
 * Il body di `POST /api/parent/votazioni/[id]/voto`.
 *
 * `sectionId` c’è se e solo se l’ambito è `classe`. Per l’istituto può essere `null` o mancare del
 * tutto: in uscita è sempre `null`, così la route ha un solo caso da guardare.
 */
export const votoSchema = z
  .object({
    ambito: z.enum(AMBITI),
    sectionId: zUuid.nullable().default(null),
    candidatoId: zUuid,
  })
  .refine((v) => (v.ambito === 'classe') === (v.sectionId !== null), {
    message: 'La classe va indicata se e solo se il voto è di classe',
    path: ['sectionId'],
  })
export type VotoInput = z.infer<typeof votoSchema>

/** La query di `GET /api/admin/votazioni`. */
export const elencoQuerySchema = z.object({ scuolaId: zUuid.optional() })

/** La query di `GET /api/admin/votazioni/genitori`. */
export const genitoriQuerySchema = z.object({
  scuolaId: zUuid.optional(),
  q: z.string().trim().max(60).optional(),
})

/**
 * Da `YYYY-MM-DDTHH:MM` (ora di Roma) all’istante ISO UTC, o `null` se la forma non è quella o la data
 * non esiste. Avvolge `istanteDaLocale`: non ricalcola niente.
 *
 * Nei due giorni di cambio dell’ora l’ora saltata scivola avanti e l’ora doppia prende l’occorrenza più
 * tarda (vedi `istanteDaLocale`): per una SCADENZA è la direzione permissiva, mai una finestra più
 * stretta di quella che la segreteria credeva.
 */
export function scadenzaInIstante(locale: string): string | null {
  return istanteDaLocale(locale)
}
