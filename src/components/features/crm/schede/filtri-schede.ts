import type { BadgeTone } from '@/components/ui/Badge'
import { ESITI_BAMBINO, ORIGINI, type EsitoBambino } from '@/lib/crm/tipi'
import type { CampoFiltro, OpzioneFiltro, Periodo, Traduttore } from '@/lib/ui/filtri/tipi'
import { voci } from './vocabolari'

/**
 * ─── I FILTRI DELL'ELENCO DELLE SCHEDE — TUTTI `dove: 'server'` ────────────────────────────────────
 *
 * Un CRM ha centinaia di famiglie e l'elenco arriva a pagine da 50: un filtro CLIENT qui sarebbe una
 * bugia. Con «Perso» scelto scriverebbe «3 risultati» mentre il server ne ha altre cento che non ha
 * ancora mandato. Per questo ogni campo parte verso `GET /api/admin/crm/schede`, che li conosce tutti
 * (`getQuerySchema`) e li applica PRIMA di impaginare. Il lock `filtri-server-non-mentono` verifica
 * che ogni chiave qui sotto esista davvero nello schema di quella route: un filtro che il server
 * scarta in silenzio è un filtro che a schermo sembra acceso e non filtra niente.
 *
 * Il tipo `CampoFiltro` impedisce l'errore opposto: un campo `dove: 'server'` non può portare un
 * estrattore. Per questo il descrittore vale per qualunque forma di riga (`R` la sceglie chi monta la
 * barra) — i campi server non toccano mai una riga.
 *
 * ── I toni sono quelli del badge ─────────────────────────────────────────────────────────────────
 * «Perso» è rosso nella pastiglia del filtro e rosso nel badge di ogni riga: `TONO_ESITO` è UNO, e lo
 * leggono tutte e due. Due arancioni diversi per la stessa parola nella stessa schermata vorrebbero
 * dire che il colore ha smesso di significare qualcosa.
 *
 * ── Le etichette dei vocabolari arrivano da fuori ────────────────────────────────────────────────
 * Esiti e origini li traduce chi monta la barra (`tc` = `crmShell`), dalle stesse chiavi con cui
 * disegna i badge. Qui si traducono solo le etichette dei CAMPI (`t` = `crmSchede`).
 */

export const TONO_ESITO: Record<EsitoBambino, BadgeTone> = {
  aperto: 'info',
  iscritto: 'success',
  lista_attesa: 'inCorso',
  ci_pensa: 'warn',
  perso: 'error',
}

export function campiSchede<R>(
  t: Traduttore,
  /** `useTranslations('crmShell')`: i vocabolari. */
  tc: Traduttore,
  /** Le persone a cui in questa sede si assegna una visita (già in forma di voce di tendina). */
  persone: readonly OpzioneFiltro[],
  formattaData: (iso: string) => string,
): CampoFiltro<R>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('filtroRicerca'),
      segnaposto: t('filtroRicercaSegnaposto'),
      dove: 'server',
      primario: true,
    },
    {
      tipo: 'chip',
      chiave: 'esito',
      etichetta: t('filtroEsito'),
      dove: 'server',
      primario: true,
      opzioni: voci(tc, 'esiti', ESITI_BAMBINO, TONO_ESITO),
    },
    {
      tipo: 'scelta',
      chiave: 'origine',
      etichetta: t('filtroOrigine'),
      dove: 'server',
      primario: true,
      opzioni: voci(tc, 'origini', ORIGINI),
    },
    {
      tipo: 'scelta',
      chiave: 'persona',
      etichetta: t('filtroPersona'),
      dove: 'server',
      // Senza persone (la lettura è fallita, o la sede non ne ha) la tendina non si disegna: una
      // tendina vuota sembrerebbe un filtro che non trova nessuno.
      nascondiSeVuoto: true,
      opzioni: persone,
    },
    {
      tipo: 'interruttore',
      chiave: 'senzaDomanda',
      etichetta: t('filtroSenzaDomanda'),
      dove: 'server',
    },
    {
      tipo: 'periodo',
      chiave: 'creata',
      etichetta: t('filtroPeriodo'),
      dove: 'server',
      descrivi: (p: Periodo) => [p.da && formattaData(p.da), p.a && formattaData(p.a)].filter(Boolean).join(' → '),
    },
  ]
}
