import { opzioniDerivate } from '@/lib/ui/filtri/motore'
import { opzioniUtili } from '@/lib/ui/opzioni-filtro'
import { prestampato, type FamigliaPrestampato, type SoggettoPrestampato } from '@/lib/prestampati/registro'
import type { CampoFiltro, OpzioneFiltro, Traduttore } from '@/lib/ui/filtri/tipi'

/**
 * I FILTRI DEL CATALOGO DEI PRESTAMPATI — diciassette modelli in una griglia.
 *
 * ─── PERCHÉ UN CATALOGO NON È UN ELENCO, E SI FILTRA DIVERSAMENTE ───────────────
 *
 * Diciassette voci non si scorrono: si riconoscono. Chi sta allo sportello ha già in testa
 * *che cosa* sta cercando — «quello per il dipendente», «quello che consuma un numero» — e le
 * quattro domande che restringono davvero sono le stesse quattro su cui il registro sa già
 * rispondere: di chi parla, da dove nasce, se esce dalla scuola, che firma pretende.
 *
 * ─── LA FAMIGLIA SI CHIEDE AL REGISTRO ──────────────────────────────────────────
 *
 * `GET /api/prestampati` non manda la `famiglia`: manda ciò che il BANCO deve sapere
 * (`generabile`, `motivo`, `modalita`), che il registro non conosce. La famiglia però il
 * registro ce l'ha, e si chiede a lui — `prestampato(slug)?.famiglia` — invece di dedurla dal
 * soggetto o dalla firma. Dedurla sarebbe una seconda definizione accanto a quella del
 * registro, e due definizioni divergono alla prima modifica con il gate verde: è la stessa
 * ragione per cui `FiltriPrestampati` ha guadagnato `famiglia` e `firma` invece di lasciare
 * che se li scrivesse il browser.
 *
 * ─── LE OPZIONI NASCONO DAI DATI ────────────────────────────────────────────────
 *
 * Non da un elenco fisso di tre soggetti e quattro firme: l'elenco che arriva dipende dal
 * BANCO di chi guarda — un'insegnante ne vede pochi, e offrirle «Una persona del personale»
 * su zero righe è una scelta che non può che dare il vuoto. `opzioniUtili` toglie anche il
 * caso da una voce sola, che è un controllo che non può cambiare niente.
 */

/**
 * Ciò che serve per filtrare una voce del catalogo.
 *
 * È un tipo STRUTTURALE e volutamente più povero di `VoceModello` del pannello: qui non
 * servono né `etichetta` né `motivo` né `modalita`, e chiederli renderebbe questo modulo
 * impossibile da provare senza ricostruire una risposta d'API intera.
 */
export interface VoceCatalogo {
  slug: string
  soggetto: SoggettoPrestampato
  /** Il REQUISITO di firma (`FirmaPrestampatoRichiesta`), non il blocco disegnato. */
  firma: string
  protocollo: 'uscita' | 'nessuno'
  generabile: boolean
}

/**
 * Da quale dei due file dei modelli nasce questa voce — o `null` se lo slug non è fra i
 * diciassette.
 *
 * `null` e non un ripiego: un modello che il registro non conosce non ha una famiglia, e
 * attribuirgliene una lo farebbe comparire dentro un filtro che afferma qualcosa di lui che
 * nessuno ha deciso. Restando `null` non passa né «Moduli di famiglia» né «Fogli dello
 * sportello», ma continua a vedersi quando quel filtro è a riposo — che è l'unica cosa vera
 * che si può dire di lui.
 */
export function famigliaDi(voce: { slug: string }): FamigliaPrestampato | null {
  return prestampato(voce.slug)?.famiglia ?? null
}

/**
 * Le chiavi di catalogo dei quattro requisiti di firma.
 *
 * ⚠️ Mappa ESPLICITA, mai `t('filtriPrestampatiFirma' + …)`: una chiave costruita da un dato
 * renderebbe cieco `messaggi-chiavi-orfane` su tutto il namespace `adminModulistica`, che è
 * sotto tutela proprio perché nessuna delle sue chiavi lo è.
 *
 * ⚠️ E le etichette sono CORTE, mentre il pannello mostra la frase intera («Firma la
 * famiglia, con un codice usa e getta»). Non è un secondo glossario: è la stessa cosa detta
 * in due lunghezze diverse, e una pastiglia di filtro larga una riga non si legge.
 */
const CHIAVE_FIRMA: Record<string, string> = {
  legale_rappresentante: 'filtriPrestampatiFirmaLegale',
  otp_genitore: 'filtriPrestampatiFirmaGenitore',
  otp_due_genitori: 'filtriPrestampatiFirmaDueGenitori',
  nessuna: 'filtriPrestampatiFirmaNessuna',
}

/**
 * Le voci del SOGGETTO vengono dal catalogo del PANNELLO e non da uno nuovo.
 *
 * La griglia mostra già «Un bambino» dentro la pastiglia di ogni modello: chiamarlo
 * «Bambino» nel filtro darebbe due nomi per la stessa cosa nella stessa schermata, che è
 * esattamente ciò che il lock del glossario esiste per impedire.
 */
const CHIAVE_SOGGETTO: Record<SoggettoPrestampato, string> = {
  alunno: 'soggettoAlunno',
  sezione: 'soggettoSezione',
  dipendente: 'soggettoDipendente',
}

const CHIAVE_FAMIGLIA: Record<FamigliaPrestampato, string> = {
  genitore: 'filtriPrestampatiFamigliaGenitore',
  segreteria: 'filtriPrestampatiFamigliaSegreteria',
}

const CHIAVE_PROTOCOLLO: Record<string, string> = {
  uscita: 'filtriPrestampatiProtocolloUscita',
  nessuno: 'filtriPrestampatiProtocolloNessuno',
}

/**
 * ⚠️ GENERICO SU `R`, e non fissato a `VoceCatalogo`.
 *
 * Il pannello ha righe più ricche (`VoceModello`, con `etichetta`, `archiviazione`, `motivo`,
 * `modalita`) e la sua `nomeModello` le pretende. Con il parametro fissato a `VoceCatalogo`
 * quella funzione non sarebbe assegnabile — `strictFunctionTypes` rende i parametri
 * controvarianti, ed è giusto: chi riceve solo un `VoceCatalogo` non può passarlo a chi vuole
 * di più. Il vincolo `extends VoceCatalogo` tiene il patto («queste cinque cose devono
 * esserci») e lascia passare tutto il resto.
 */
export function campiCatalogo<R extends VoceCatalogo>(
  t: Traduttore,
  tPannello: Traduttore,
  righe: readonly R[],
  nomeModello: (voce: R) => string,
): CampoFiltro<R>[] {
  const opzioniDi = (
    estrai: (v: R) => string | null | undefined,
    etichettaDi: (valore: string) => string,
  ): readonly OpzioneFiltro[] => opzioniUtili(opzioniDerivate(righe, estrai, { etichettaDi }))

  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('filtriPrestampatiRicerca'),
      segnaposto: t('filtriPrestampatiRicercaSegnaposto'),
      dove: 'client',
      primario: true,
      // Il NOME TRADOTTO, non lo slug: chi cerca digita quello che legge sulla card, e
      // «certificato_servizio» non lo scrive nessuno.
      testiDi: (v) => [nomeModello(v)],
    },
    {
      tipo: 'chip',
      chiave: 'soggetto',
      etichetta: t('filtriPrestampatiSoggetto'),
      dove: 'client',
      primario: true,
      nascondiSeVuoto: true,
      valoreDi: (v) => v.soggetto,
      opzioni: opzioniDi(
        (v) => v.soggetto,
        (valore) =>
          CHIAVE_SOGGETTO[valore as SoggettoPrestampato]
            ? tPannello(CHIAVE_SOGGETTO[valore as SoggettoPrestampato])
            : valore,
      ),
    },
    {
      tipo: 'scelta',
      chiave: 'famiglia',
      etichetta: t('filtriPrestampatiFamiglia'),
      dove: 'client',
      nascondiSeVuoto: true,
      valoreDi: famigliaDi,
      opzioni: opzioniDi(famigliaDi, (valore) =>
        CHIAVE_FAMIGLIA[valore as FamigliaPrestampato]
          ? t(CHIAVE_FAMIGLIA[valore as FamigliaPrestampato])
          : valore,
      ),
    },
    {
      tipo: 'scelta',
      chiave: 'protocollo',
      etichetta: t('filtriPrestampatiProtocollo'),
      dove: 'client',
      nascondiSeVuoto: true,
      valoreDi: (v) => v.protocollo,
      opzioni: opzioniDi(
        (v) => v.protocollo,
        (valore) => (CHIAVE_PROTOCOLLO[valore] ? t(CHIAVE_PROTOCOLLO[valore]) : valore),
      ),
    },
    {
      tipo: 'scelta',
      chiave: 'firma',
      etichetta: t('filtriPrestampatiFirma'),
      dove: 'client',
      nascondiSeVuoto: true,
      valoreDi: (v) => v.firma,
      opzioni: opzioniDi(
        (v) => v.firma,
        // Un requisito che la mappa non conosce si mostra col proprio nome tecnico: brutto e
        // onesto, mai un'etichetta sbagliata su un foglio che qualcuno sta per stampare.
        (valore) => (CHIAVE_FIRMA[valore] ? t(CHIAVE_FIRMA[valore]) : valore),
      ),
    },
    {
      tipo: 'interruttore',
      chiave: 'generabili',
      etichetta: t('filtriPrestampatiGenerabili'),
      dove: 'client',
      primario: true,
      predicato: (v) => v.generabile,
    },
  ]
}
