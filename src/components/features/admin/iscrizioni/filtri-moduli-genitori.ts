import { dataCivile } from '@/i18n/config'
import { opzioniDerivate } from '@/lib/ui/filtri/motore'
import { opzioniUtili } from '@/lib/ui/opzioni-filtro'
import type { CampoFiltro, OpzioneFiltro, Periodo, Traduttore } from '@/lib/ui/filtri/tipi'

/**
 * I FILTRI DEI «MODULI PER I GENITORI ISCRITTI» — la linguetta che oggi ha ZERO righe.
 *
 * ─── PERCHÉ UNA BARRA SU UNA TABELLA VUOTA È UN PROBLEMA, E COME SI EVITA ───────
 *
 * `forms_templates` in produzione non ha nemmeno una riga. Una barra filtri disegnata sopra
 * il nulla, con «0 risultati su 0» e la frase «Nessun risultato con questi filtri», manda a
 * cercare un filtro da togliere che non esiste — ed è il caso NORMALE qui, non il limite.
 * La distinzione la fa `decidiStatoElenco`: `totale === 0` è `vuoto` («non è ancora stato
 * creato nessun modulo»), `totale > 0 && mostrati === 0` è `senzaRisultati`. Il pannello non
 * disegna nemmeno la barra finché la tabella è vuota.
 */

/** La riga di `forms_templates` come la legge questa schermata. */
export interface ModuloGenitori {
  id: string
  title: string
  description: string
  form_type: string
  target_scope: 'class' | 'external'
  target_classes: string[]
  expiration_date: string | null
  created_at: string
  /**
   * Modulo «essenziale» (salute/sicurezza): firmabile anche da un genitore sospeso per
   * morosità. ⚠️ Opzionale perché sul DB E2E della CI, non migrato, la colonna può non
   * esserci: `undefined` deve valere «non lo so», mai «sì».
   */
  sempre_firmabile?: boolean | null
}

/** I tre stati della scadenza, che sono TRE e non due. */
export type StatoScadenza = 'attivi' | 'scaduti' | 'senza'

/**
 * In che stato è la scadenza di un modulo.
 *
 * «Senza scadenza» è un valore suo e non un sinonimo di «ancora valido»: un modulo che non
 * scade mai è una decisione di chi l'ha creato, e confonderlo con uno che scade domani
 * toglie proprio la domanda che si fa a fine anno — «quali non hanno una scadenza?».
 *
 * Il confronto è lo STESSO della pastiglia rossa nella riga (`new Date(exp) < new Date()`):
 * due modi di decidere «scaduto» nella stessa schermata darebbero un modulo col badge rosso
 * che il filtro «Scaduti» non trova.
 */
export function scadenzaDi(m: ModuloGenitori, adesso: number = Date.now()): StatoScadenza {
  if (!m.expiration_date) return 'senza'
  const quando = new Date(m.expiration_date).getTime()
  // Una data illeggibile non è «scaduta»: non si sa. Vale come «senza scadenza», che è
  // l'unico dei tre che non afferma niente sul tempo.
  if (Number.isNaN(quando)) return 'senza'
  return quando < adesso ? 'scaduti' : 'attivi'
}

/**
 * Le classi fra cui scegliere: quelle NOMINATE dai moduli, unite alle sezioni della sede.
 *
 * L'unione serve in tutti e due i versi. Solo le sezioni: un modulo destinato a una classe
 * che nel frattempo è stata rinominata non sarebbe più raggiungibile da nessun filtro — e
 * `avvisi.target_classes` ha già prodotto sezioni orfane in questo repo. Solo i moduli:
 * mancherebbero le sezioni nuove, cioè quelle su cui non è ancora stato creato niente, che
 * sono esattamente quelle che si va a cercare.
 */
export function opzioniClasseModuli(
  moduli: readonly ModuloGenitori[],
  sezioni: readonly { name: string }[],
): readonly OpzioneFiltro[] {
  const daiModuli = opzioniDerivate(moduli, (m) => m.target_classes)
  const noti = new Set(daiModuli.map((o) => o.valore))
  const soloSezioni = sezioni
    .map((s) => s.name)
    .filter((nome) => nome !== '' && !noti.has(nome))
    // Le sezioni senza nemmeno un modulo non portano righe: il conteggio è zero, e dirlo è
    // più onesto che tacerlo — «PRIMAVERA B (0)» risponde già alla domanda.
    .map((nome): OpzioneFiltro => ({ valore: nome, etichetta: nome, conteggio: 0 }))
  return opzioniUtili(
    [...daiModuli, ...soloSezioni].sort((a, b) => a.etichetta.localeCompare(b.etichetta, 'it')),
  )
}

export function campiModuliGenitori(
  t: Traduttore,
  opzioni: { classe: readonly OpzioneFiltro[] },
  formattaData: (iso: string) => string,
): CampoFiltro<ModuloGenitori>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('filtriModuliRicerca'),
      segnaposto: t('filtriModuliRicercaSegnaposto'),
      dove: 'client',
      primario: true,
      testiDi: (m) => [m.title, m.description],
    },
    {
      tipo: 'chip',
      chiave: 'tipo',
      etichetta: t('filtriModuliTipo'),
      dove: 'client',
      primario: true,
      valoreDi: (m) => m.form_type,
      // Le tre voci dell'ENUM del database, con le etichette che la schermata già usa nella
      // pastiglia verde di ogni riga: due nomi per lo stesso tipo, nella stessa schermata,
      // è il difetto che il lock del glossario sorveglia.
      opzioni: [
        { valore: 'sondaggio', etichetta: t('modFormTypeSondaggio') },
        { valore: 'gradimento', etichetta: t('modFormTypeGradimento') },
        { valore: 'autorizzazione', etichetta: t('modFormTypeAutorizzazione') },
      ],
    },
    {
      tipo: 'scelta',
      chiave: 'scadenza',
      etichetta: t('filtriModuliScadenza'),
      dove: 'client',
      primario: true,
      valoreDi: (m) => scadenzaDi(m),
      opzioni: [
        { valore: 'attivi', etichetta: t('filtriModuliScadenzaAttivi'), tono: 'success' },
        { valore: 'scaduti', etichetta: t('filtriModuliScadenzaScaduti'), tono: 'error' },
        { valore: 'senza', etichetta: t('filtriModuliScadenzaSenza'), tono: 'neutral' },
      ],
    },
    {
      tipo: 'multi',
      chiave: 'classe',
      etichetta: t('filtriModuliClasse'),
      dove: 'client',
      nascondiSeVuoto: true,
      // Un modulo vale per PIÙ classi: `multi`, con l'OR dentro il campo. Basta che una
      // delle classi del modulo sia fra quelle scelte.
      valoriDi: (m) => m.target_classes,
      opzioni: opzioni.classe,
    },
    {
      tipo: 'interruttore',
      chiave: 'essenziali',
      etichetta: t('filtriModuliSoloEssenziali'),
      dove: 'client',
      predicato: (m) => m.sempre_firmabile === true,
    },
    {
      tipo: 'periodo',
      chiave: 'creato',
      etichetta: t('filtriModuliPeriodo'),
      dove: 'client',
      // ⚠️ Il GIORNO CIVILE ITALIANO, non `created_at.slice(0, 10)`: fra mezzanotte e le due
      // il giorno UTC e quello di Roma sono due giorni diversi, ed è una misura già pagata in
      // questo repo (un incasso vero sparito da un KPI perché il conto era in UTC).
      dataDi: (m) => (m.created_at ? dataCivile(new Date(m.created_at)) : null),
      descrivi: (p: Periodo) =>
        [p.da && formattaData(p.da), p.a && formattaData(p.a)].filter(Boolean).join(' → '),
    },
  ]
}
