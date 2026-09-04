/**
 * La causale della FATTURA ELETTRONICA: quale testo finisce nel campo 2.1.1.11
 * (`<Causale>`) e nella descrizione della riga del documento.
 *
 * ─── PERCHÉ ESISTE ────────────────────────────────────────────────────────────
 * `admin_settings.fattura_causale_template` — un campo unico, per tutta la scuola —
 * esisteva nell'interfaccia, veniva letto dalla `select` dell'emissione e poi
 * **buttato via**: la causale si componeva da `pagamenti.fattura_causale` o dalla
 * descrizione, e chi compilava quel campo non otteneva niente. Aveva perfino come
 * valore di fabbrica `{descrizione} - {alunno}`, dove `{alunno}` non è mai stato un
 * segnaposto riconosciuto: sarebbe uscito a stampa così com'era scritto.
 *
 * Quel campo è stato TOLTO nello stesso lavoro che ha introdotto questo modulo — dal
 * pannello Impostazioni, da `ALLOWED_FIELDS` di `admin/settings` e dal default della
 * GET. Lasciarlo a schermo mentre qui nasceva la configurazione buona avrebbe soltanto
 * spostato il difetto di una schermata: due posti che dicono la stessa cosa, uno solo
 * dei quali viene emesso. La colonna resta in tabella (non si droppa una colonna di un
 * database con dati veri per una pulizia) ma non è più né letta né scrivibile.
 *
 * Qui la configurazione è la stessa del bonifico — un modello **per tipologia di
 * pagamento** (slug di categoria) più un «Predefinito» — e usa lo stesso motore
 * (`renderCausale`), lo stesso catalogo di segnaposto e la stessa regola di
 * risoluzione (`modelloCausale`). Cambia solo dove si salva
 * (`admin_settings.fattura_causali_config`), il modello di fabbrica e il limite di
 * lunghezza, che il bonifico non ha.
 *
 * ─── FUNZIONI PURE ────────────────────────────────────────────────────────────
 * Nessun I/O, nessun log: la lettura della configurazione e l'osservabilità sono di
 * chi chiama (`@/lib/aruba/emissione`), che è anche l'unico a sapere di quale
 * pagamento si tratta. Il codice fiscale del minore attraversa questo modulo e non
 * deve mai finire in un log.
 */

import { causalePerTracciato } from '@/lib/aruba/fatturapa-xml'
import {
    renderCausale,
    risolviModelloCausale,
    type ConfigCausali,
    type DatiCausale,
    type OrigineModelloCausale,
} from './causale'

/** La colonna JSONB di `admin_settings` che tiene i modelli di causale delle fatture. */
export const CHIAVE_CONFIG_CAUSALI_FATTURA = 'fattura_causali_config'

/**
 * Modello di fabbrica, ricalcato su come la segreteria scrive OGGI le causali a mano.
 *
 * I separatori sono « - » perché è il confine che `renderCausale` usa per **omettere**
 * un segmento i cui segnaposto sono tutti vuoti: senza codice fiscale la causale finisce
 * con il nome, non con un «CF:» penzolante — che su una fattura elettronica resterebbe
 * lì per sempre.
 */
export const DEFAULT_CAUSALE_FATTURA_TEMPLATE =
    '{descrizione} - a favore {minore} {nome_completo} - CF: {codice_fiscale}'

/**
 * Il campo 2.1.1.11 «Causale» di FatturaPA (FPR12) si ferma a **200 caratteri**.
 * Non è una convenzione interna: è il `maxLength` dello schema, e il costruttore XML
 * di questo repo scrive un solo elemento `<Causale>` e lo tronca a questa lunghezza come
 * ultima difesa: senza il troncamento, un modello che rende più di 200 caratteri
 * produrrebbe un documento che non supera il controllo formale dello SDI.
 *
 * Il pannello mostra il conteggio mentre si scrive, ma è un conteggio sui DATI
 * D'ESEMPIO: non è una garanzia che la causale vera ci stia. Una descrizione più lunga
 * dell'esempio, o il suffisso « - quota <genitore>» delle quote dei genitori separati
 * (`@/lib/aruba/emissione`), possono farla sforare lo stesso — e allora il testo viene
 * tagliato su un documento fiscale, con un `causale-troncata` nei log a dirlo.
 *
 * ⚠️ I 200 caratteri si contano sulla stringa NORMALIZZATA (`causalePerTracciato`), mai
 * su quella scritta a schermo: vedi `lunghezzaCausaleFatturaPA` qui sotto.
 */
export const LIMITE_CAUSALE_FATTURAPA = 200

export interface IngressoCausaleFattura {
    /** I modelli per categoria: `admin_settings.fattura_causali_config` così com'è. */
    config?: ConfigCausali
    /** Lo slug della categoria del pagamento (`payment_categories.slug`). */
    slugCategoria?: string | null
    /**
     * La causale scritta A MANO sul singolo pagamento (`pagamenti.fattura_causale`):
     * **vince su qualunque modello**. Chi l'ha digitata sta correggendo quel documento,
     * non configurando una regola.
     *
     * ⚠️ Attenzione a cosa si passa qui: l'emissione **riscrive** `fattura_causale` con
     * la causale composta (righe 451 e 471 di `@/lib/aruba/emissione`). Dalla seconda
     * emissione in poi quel campo non è più «ciò che ha scritto un umano», è l'eco
     * della prima composizione — e passarlo qui congelerebbe la causale, rendendo
     * invisibile ogni modifica successiva al modello.
     */
    causaleManuale?: string | null
    /** I dati del pagamento e del minore che riempiono i segnaposto. */
    dati: DatiCausale
}

/**
 * La causale della fattura di un pagamento: **causale manuale → modello della
 * categoria → «Predefinito» → modello di fabbrica**, resa coi dati passati.
 *
 * Anche la causale manuale passa dal motore: su un testo senza segnaposto il risultato
 * è il testo stesso (l'operazione è idempotente), e se qualcuno ci ha scritto `{nome}`
 * viene risolto invece di finire a stampa fra parentesi graffe.
 */
export function causaleFattura(ingresso: IngressoCausaleFattura): string {
    return causaleFatturaConOrigine(ingresso).causale
}

/**
 * Da dove viene la causale che si sta per emettere: `manuale` (una correzione scritta
 * a mano su QUESTO pagamento), `categoria`, `predefinito` o `fabbrica`.
 *
 * Non è un dettaglio da schermata: fino al 2026-09-04 il modale «Emetti» precompilava
 * la casella con la descrizione del pagamento e la spediva come correzione manuale, e
 * chi premeva il pulsante annullava il modello configurato **senza vederlo**. Dire da
 * quale riga viene il testo è ciò che rende quell'errore impossibile da ripetere in
 * silenzio.
 */
export type OrigineCausaleFattura = 'manuale' | OrigineModelloCausale

export function causaleFatturaConOrigine({
    config,
    slugCategoria,
    causaleManuale,
    dati,
}: IngressoCausaleFattura): { causale: string; origine: OrigineCausaleFattura } {
    const manuale = typeof causaleManuale === 'string' && causaleManuale.trim() !== ''
        ? causaleManuale
        : undefined
    if (manuale) return { causale: renderCausale(manuale, dati), origine: 'manuale' }
    const { modello, origine } = risolviModelloCausale(config, slugCategoria, DEFAULT_CAUSALE_FATTURA_TEMPLATE)
    return { causale: renderCausale(modello, dati), origine }
}

/**
 * Quanti caratteri occupa DAVVERO questa causale nel campo 2.1.1.11.
 *
 * Non è `causale.length`, ed è la correzione di un difetto misurato il 2026-08-10: il
 * generatore XML scrive `testoLatin(causale, 200)`, che prima **translittera** e poi
 * tronca, e la translitterazione allunga (`€`→`EUR`, `…`→`...`, `™`→`(TM)`) o accorcia
 * (caratteri fuori dal tracciato, spazi doppi). Contando la stringa d'ingresso, una
 * causale di 200 caratteri che contiene un `€` — cioè il chip `{importo}`, il cui
 * esempio è proprio «€ 150,00» — passava per «sta dentro» e usciva a stampa mozzata a
 * `EUR 150,` invece di `EUR 150,00`, senza nemmeno un `causale-troncata` nei log,
 * perché anche quel gate misurava la stringa sbagliata.
 *
 * La riduzione vive in `@/lib/aruba/fatturapa-xml` (`causalePerTracciato`), accanto
 * alla tabella di translitterazione che la determina: un posto solo per una regola che
 * vale per due strade, la schermata e l'emissione.
 */
export function lunghezzaCausaleFatturaPA(causale: string): number {
    return causalePerTracciato(typeof causale === 'string' ? causale : '').length
}

/**
 * La causale RESA sta dentro il campo 2.1.1.11?
 *
 * Volutamente non tronca: troncare una causale è una decisione sul contenuto di un
 * documento fiscale e non può essere presa da una funzione di formattazione. Chi emette
 * decide se accorciare, se rifiutare o se spezzare — e lo logga.
 */
export function eccedeLimiteFatturaPA(causale: string): boolean {
    return lunghezzaCausaleFatturaPA(causale) > LIMITE_CAUSALE_FATTURAPA
}

/**
 * Il vincolo del campo 2.1.1.11, **misura e limite insieme**, per chi deve mostrarlo a
 * schermo (`CausaliFatturaPanel`).
 *
 * Stanno in una sola costante di proposito: il difetto del 2026-08-10 è nato perché il
 * pannello aveva ricevuto il numero (`200`) senza la misura, e ha contato ciò che
 * aveva sottomano. Un limite senza la funzione che dice «quanto è lungo davvero» è la
 * metà sbagliata della regola, e questa forma rende impossibile prendersi solo quella.
 */
export const VINCOLO_CAUSALE_FATTURAPA = {
    limiteCaratteri: LIMITE_CAUSALE_FATTURAPA,
    perTracciato: causalePerTracciato,
} as const
