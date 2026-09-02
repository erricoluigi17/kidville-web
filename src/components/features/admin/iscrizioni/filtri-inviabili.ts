import { opzioniDerivate } from '@/lib/ui/filtri/motore'
import { opzioniUtili } from '@/lib/ui/opzioni-filtro'
import type { CampoFiltro, OpzioneFiltro, Traduttore } from '@/lib/ui/filtri/tipi'

/**
 * I FILTRI DI «MODULI INVIABILI» — i modelli del costruttore, sei in produzione.
 *
 * ─── PERCHÉ I DESCRITTORI SONO UNA FUNZIONE DI `t` ──────────────────────────────
 *
 * Restituiscono stringhe GIÀ RISOLTE, mai chiavi. Il namespace `adminModulistica` è sotto
 * tutela in `__tests__/architecture/messaggi-chiavi-orfane.test.ts` con la motivazione
 * «nessuna chiave costruita da un dato»: se la barra risolvesse `t(campo.chiaveEtichetta)`
 * quella tutela cadrebbe, e con lei l'unico strumento che si accorge di una chiave morta.
 * Qui ogni chiave è scritta per esteso, una riga alla volta.
 *
 * ─── TUTTI I CAMPI SONO `dove: 'client'`, E NON È UNA SEMPLIFICAZIONE ───────────
 *
 * `/api/admin/forms/models` restituisce l'elenco INTERO in una lettura sola, senza
 * paginazione: le righe sono già in memoria, e mandare un criterio verso l'API vorrebbe dire
 * una seconda lettura per scremare quello che il browser ha già davanti. `tsc` lo fa
 * rispettare — un campo `client` senza estrattore non compila.
 */

/** La riga dell'elenco, come la proietta `CAMPI_ELENCO` in `admin/forms/models/route.ts`. */
export interface ModelloInviabile {
  id: string
  title: string
  description?: string | null
  is_active?: boolean | null
  is_enrollment_form?: boolean | null
  published_at?: string | null
  /** Non esce dall'elenco (è la capability che apre `/m/{token}`): resta per chi lo ha. */
  public_token?: string | null
  access_mode?: string | null
  requires_signature?: boolean | null
  /** `null` = modello GLOBALE: vale per tutte le sedi. L'assenza è il dato. */
  scuola_id?: string | null
}

/**
 * Il valore che rappresenta «vale per tutte le sedi» nel filtro di sede.
 *
 * Serve perché `scuola_id` NULL è un'informazione — «globale» — e non l'assenza di
 * un'informazione: senza un valore suo finirebbe fra le righe che il filtro scarta, cioè i
 * modelli che valgono OVUNQUE sparirebbero da ogni scelta di sede. La stringa non è un uuid
 * e non può collidere con uno.
 */
export const SEDE_GLOBALE = 'sede:tutte'

const statoDi = (m: ModelloInviabile): string => (m.published_at ? 'pubblicati' : 'bozze')
const tipoDi = (m: ModelloInviabile): string => (m.is_enrollment_form ? 'iscrizione' : 'generico')
const sedeDi = (m: ModelloInviabile): string => m.scuola_id ?? SEDE_GLOBALE

/**
 * Le sedi che compaiono davvero fra i modelli, con quanti ne porta ciascuna.
 *
 * Nasce dai DATI e non dall'elenco delle sedi attive: un plesso senza nemmeno un modello
 * proprio sarebbe una voce che dà sempre zero righe, e con tre plessi in produzione due su
 * tre lo sono quasi sempre. `opzioniUtili` toglie di mezzo anche il caso da UNA voce sola.
 */
export function opzioniSedeInviabili(
  righe: readonly ModelloInviabile[],
  nomeSede: (id: string) => string | undefined,
  t: Traduttore,
): readonly OpzioneFiltro[] {
  return opzioniUtili(
    opzioniDerivate(righe, sedeDi, {
      etichettaDi: (valore) =>
        valore === SEDE_GLOBALE ? t('filtriInviabiliSedeTutte') : nomeSede(valore) ?? valore,
    }),
  )
}

export function campiInviabili(
  t: Traduttore,
  opzioniSede: readonly OpzioneFiltro[],
): CampoFiltro<ModelloInviabile>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('filtriInviabiliRicerca'),
      segnaposto: t('filtriInviabiliRicercaSegnaposto'),
      dove: 'client',
      primario: true,
      // Titolo E descrizione: il titolo di un modulo del costruttore lo scrive chi lo crea,
      // e non sempre contiene la parola con cui poi lo si cerca.
      testiDi: (m) => [m.title, m.description],
    },
    {
      tipo: 'chip',
      chiave: 'stato',
      etichetta: t('filtriInviabiliPubblicazione'),
      dove: 'client',
      primario: true,
      valoreDi: statoDi,
      // Gli STESSI toni dei due badge nella riga: «Pubblicato» è verde là e verde qui.
      // Risceglierli a occhio darebbe due verdi diversi nella stessa schermata.
      opzioni: [
        { valore: 'pubblicati', etichetta: t('filtriInviabiliPubblicati'), tono: 'success' },
        { valore: 'bozze', etichetta: t('filtriInviabiliBozze'), tono: 'warn' },
      ],
    },
    {
      tipo: 'scelta',
      chiave: 'tipo',
      etichetta: t('filtriInviabiliTipo'),
      dove: 'client',
      primario: true,
      valoreDi: tipoDi,
      opzioni: [
        { valore: 'iscrizione', etichetta: t('filtriInviabiliTipoIscrizione') },
        { valore: 'generico', etichetta: t('filtriInviabiliTipoGenerico') },
      ],
    },
    {
      tipo: 'scelta',
      chiave: 'accesso',
      etichetta: t('filtriInviabiliAccesso'),
      dove: 'client',
      // `access_mode` assente non è né l'uno né l'altro: la riga resta fuori da entrambe le
      // scelte, invece di essere attribuita a quella che «sembra» il default.
      valoreDi: (m) => m.access_mode,
      opzioni: [
        { valore: 'public', etichetta: t('filtriInviabiliAccessoPubblico') },
        { valore: 'authenticated', etichetta: t('filtriInviabiliAccessoAutenticato') },
      ],
    },
    {
      tipo: 'scelta',
      chiave: 'sede',
      etichetta: t('filtriInviabiliSede'),
      dove: 'client',
      nascondiSeVuoto: true,
      valoreDi: sedeDi,
      opzioni: opzioniSede,
    },
    {
      tipo: 'interruttore',
      chiave: 'attivi',
      etichetta: t('filtriInviabiliSoloAttivi'),
      dove: 'client',
      predicato: (m) => m.is_active === true,
    },
    {
      tipo: 'interruttore',
      chiave: 'firma',
      etichetta: t('filtriInviabiliConFirma'),
      dove: 'client',
      // `=== true` e non `!!`: sul DB E2E non migrato la colonna può non arrivare, e
      // `undefined` deve valere «non lo so», cioè «non passa il filtro» — non «sì».
      predicato: (m) => m.requires_signature === true,
    },
  ]
}
