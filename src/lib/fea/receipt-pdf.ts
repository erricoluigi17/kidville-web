/**
 * La ricevuta di firma inattaccabile (FEA in-house, DL-001), sulla carta della scuola.
 *
 * ⚠️ **QUESTO FILE NON DISEGNA PIÙ LA TESTATA (2026-08-16).** Aveva la sua: banda verde
 * `rect(0, 0, 210, 38)` con barretta gialla e il nome della scuola scritto in bianco
 * dentro. Era la terza copia della stessa idea — `prestampati/impaginazione.ts` e
 * `protocolli/documento-pdf.ts` avevano le altre due, con misure già divergenti — e su
 * carta intestata cadeva esattamente sopra il marchio della scuola.
 *
 * La ricevuta **non ha un pulsante** nel prodotto: non è stata chiesta (spec §4.4). La
 * carta le si applica lo stesso, e non è zelo: un generatore che nessuno guarda è quello
 * che diverge per primo, e il giorno in cui qualcuno gli mette davanti un pulsante scopre
 * di avere in mano l'unico PDF dell'app con una banda verde inventata dal codice.
 *
 * ─── DUE FUNZIONI, E QUALE SI CHIAMA ───────────────────────────────────────────
 *
 * `buildReceiptPdf()` impagina il solo CONTENUTO, dentro la finestra che `CARTA` dichiara:
 * sono byte utili a misurare l'impaginazione, **non un documento da consegnare**.
 * `buildReceiptPdfSuCarta()` è ciò che si serve a chi ha firmato — stesso contenuto, con
 * la carta reale sotto. La rotta `fea/receipt:GET` chiama la seconda.
 *
 * ─── COSA SUL FOGLIO NON CI VA PIÙ (2026-08-16) ────────────────────────────────
 *
 * Fino a questa riparazione la ricevuta stampava tre righe che non dovevano uscire
 * dall'app: **l'email del firmatario** («Firmatario: Mario Rossi <…>»), **l'indirizzo IP**
 * e **l'intero User-Agent** — due identificativi personali più l'impronta del dispositivo,
 * su un foglio che si scarica, si allega e si stampa, in un prodotto che tratta famiglie
 * di minori.
 *
 * **Il valore probatorio non ci ha perso niente, ed è il punto.** `computeContentHash()`
 * impasta email e metadati di firma DENTRO l'hash documentale che resta stampato sul
 * foglio: chi contesta la ricevuta la verifica ricalcolando l'hash dalla riga dell'audit
 * immutabile, che è — ed è sempre stata — la fonte. Stampare l'IP accanto all'hash non
 * provava nulla di più: provava solo che chi ha il foglio in mano conosce l'indirizzo da
 * cui un genitore ha firmato. Perciò qui resta il **nome**, e nient'altro di personale.
 *
 * `senzaRecapiti()` è la rete di sicurezza sul nome, e non è zelo: la rotta costruiva
 * `signer` con la sola email e nessun nome, quindi un chiamante che riempia `name` con ciò
 * che ha in mano è lo scenario probabile. La stessa guardia esiste, per lo stesso motivo,
 * in `prestampati/impaginazione.ts` e in `prestampati/modelli/genitore.ts`.
 *
 * ─── E LE DATE SI LEGGONO ──────────────────────────────────────────────────────
 *
 * L'istante della firma usciva in ISO UTC (`2026-08-16T00:41:00.000Z`): è **l'unico dato
 * che questa ricevuta esiste per certificare**, e usciva in formato macchina e in un fuso
 * che non è quello della scuola — d'estate due ore fra ciò che il foglio dice e l'ora in
 * cui si è firmato. Ora passa da `formattaIstante`, ancorata a `Europe/Rome` come tutto il
 * resto del prodotto. Vale anche per la colonna delle firme congiunte, che stampava
 * `slot.firmato_il` grezzo.
 *
 * Testato in `__tests__/lib/fea-receipt-pdf.test.ts`.
 */

import { jsPDF } from 'jspdf'
import { createHash } from 'crypto'
import { applicaCartaIntestata } from '@/lib/carta'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'
import { formattaIstante } from '@/i18n/config'
import type { ReceiptPayload } from './types'

/**
 * Serializzazione canonica (chiavi ordinate ricorsivamente) per un hash stabile,
 * indipendente dall'ordine d'inserimento delle proprietà.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

/**
 * Hash documentale della ricevuta: SHA-256 di (documento canonico + metadati
 * firma canonici). È l'ancora di inattaccabilità, distinto dall'hash OTP: se il
 * documento o i metadati firma cambiano, l'hash cambia.
 */
export function computeContentHash(documentPayload: unknown, signatureMeta: unknown): string {
  const material = `${canonicalJson(documentPayload)}|${canonicalJson(signatureMeta)}`
  const h = createHash('sha256').update(material).digest('hex')
  return `SHA256-${h.toUpperCase()}`
}

const VERDE: [number, number, number] = [0, 106, 95] // #006A5F
const INCHIOSTRO: [number, number, number] = [45, 45, 45] // #2D2D2D
const GRIGIO: [number, number, number] = [100, 100, 100] // #646464

const CENTRO_PAGINA = CARTA.larghezzaPagina / 2
/** Dove comincia il valore di una riga «Etichetta: valore». */
const COLONNA_VALORE = CARTA.margineSx + 42
const LARGHEZZA_VALORE = CARTA.margineDx - COLONNA_VALORE
const CORPO_TESTO = 11
const PASSO_RIGA = 9
const INTERLINEA = 5.5

/** La nota di chiusura: l'aria che la precede, il passo fra le sue righe, il suo corpo. */
const STACCO_NOTA = 6
const PASSO_NOTA = 4
const CORPO_NOTA = 8
const TESTO_NOTA =
  'Ricevuta generata automaticamente. La validità della firma è garantita dall’hash documentale e dall’audit immutabile.'

/** `true` se una riga scritta a `y` con quel corpo ha ancora l'inchiostro dentro la finestra. */
function ciSta(y: number, corpoPt: number): boolean {
  return ingombroTesto(y, corpoPt).fondo <= CARTA.contenutoFine
}

/**
 * Data e ora all'italiana, nel fuso della scuola. Le opzioni sono esplicite e non
 * `dateStyle`: `Intl` senza `day`/`month` a due cifre scrive «16/8/2026», che su un atto
 * si legge come un refuso.
 */
const DATA_ORA: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

/** L'istante di una firma come lo legge chi ha il foglio in mano. Istante assente → «—». */
function istante(iso: string | null | undefined): string {
  return formattaIstante(iso, 'it', DATA_ORA) || '—'
}

/**
 * Il nome del firmatario senza recapiti: mai un'email, mai un indirizzo IP.
 *
 * L'IPv6 si riconosce da quattro gruppi in su e non da tre: `10:24:33` è un orario, e una
 * regola più larga cancellerebbe dal foglio proprio l'istante della firma.
 */
function senzaRecapiti(nome: string): string {
  return nome
    .replace(/<[^<>]*@[^<>]*>/g, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function disegnaNumeriDiPagina(doc: jsPDF): void {
  const pagine = doc.getNumberOfPages()
  if (pagine < 2) return
  for (let p = 1; p <= pagine; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(7)
    doc.setTextColor(...GRIGIO)
    doc.text(`Pagina ${p} di ${pagine}`, CARTA.margineDx, CARTA.rigaServizio, { align: 'right' })
  }
}

/**
 * La ricevuta, SENZA carta: il solo contenuto, dentro la finestra della carta.
 *
 * Non è il file da consegnare — per quello c'è `buildReceiptPdfSuCarta()`. Resta esportata
 * perché è ciò che i test misurano: le quote di impaginazione si leggono su un foglio dove
 * l'unico inchiostro è quello dell'app.
 */
export function buildReceiptPdf(payload: ReceiptPayload): Buffer {
  const { signature: s } = payload
  const contentHash = computeContentHash(payload.documentPayload, {
    method: s.method,
    email: s.email,
    signed_at: s.signed_at,
    hash: s.hash ?? null,
  })

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  let y = CARTA.contenutoInizio

  // La nota di chiusura si misura PRIMA di impaginare il contenuto: serve a sapere, riga
  // per riga, se l'ultima riga del documento può ancora portarsela dietro.
  doc.setFontSize(CORPO_NOTA)
  const nota = doc.splitTextToSize(TESTO_NOTA, CARTA.margineDx - CARTA.margineSx) as string[]
  doc.setFontSize(CORPO_TESTO)

  /** Il fondo dell'inchiostro della nota, se il contenuto avesse finito a `quota`. */
  const fondoNota = (quota: number) =>
    ingombroTesto(quota + STACCO_NOTA + (nota.length - 1) * PASSO_NOTA, CORPO_NOTA).fondo

  /**
   * ⚠️ **UNA PAGINA NON PUÒ PORTARE SOLO LA CHIUSURA** (riparato il 2026-08-16).
   *
   * Con 16, 17, 48 o 49 firme congiunte l'ultimo foglio conteneva le due righe di «Ricevuta
   * generata automaticamente…» e nient'altro: un foglio di carta intestata della scuola —
   * marchio, filigrana, le tre sedi — con sopra una nota di servizio. È lo stesso difetto
   * riparato lo stesso giorno sull'ordine al fornitore e sul documento protocollato, e la
   * regola è la stessa: sull'ULTIMA riga di contenuto il conto non è «ci sta la riga» ma
   * «ci stanno la riga E la sua chiusura».
   */
  const notaCiStaDaSola = fondoNota(CARTA.contenutoInizio + PASSO_RIGA) <= CARTA.contenutoFine

  /**
   * Una pagina nuova quando l'ULTIMA riga del blocco che sta per essere scritto non ci
   * starebbe più. Il primo parametro è lo scostamento fra `y` e la baseline di quella riga:
   * **zero** per un blocco di una riga sola. Il secondo, quando c'è, è l'avanzamento del
   * blocco: si passa **solo sull'ultima riga di contenuto**, e chiede che dopo di lei ci
   * stia anche la nota di chiusura.
   *
   * ⚠️ Prima riceveva l'ALTEZZA del blocco e ne sottraeva `PASSO_RIGA`, che è il conto
   * giusto solo se l'altezza è quella che `line()` calcola. Il ciclo delle firme congiunte
   * passava `7`, e `7 - 9` faceva verificare un punto **2 mm SOPRA** la riga che stava per
   * scrivere: una riga di slot poteva atterrare esattamente su `contenutoFine` e uscirne
   * con le discendenti. Non è teoria — è emerso appena il contenuto si è accorciato di tre
   * righe. Un parametro che vuol dire una cosa sola non ha questo problema.
   */
  const spazioPer = (scostamentoUltimaRiga: number, avanzamentoConNota: number | null = null) => {
    const staLaRiga = ciSta(y + scostamentoUltimaRiga, CORPO_TESTO)
    const staAncheLaNota =
      avanzamentoConNota === null ||
      !notaCiStaDaSola ||
      fondoNota(y + avanzamentoConNota) <= CARTA.contenutoFine
    if (staLaRiga && staAncheLaNota) return
    doc.addPage()
    y = CARTA.contenutoInizio
  }

  // ── Intestazione del documento (il marchio ce l'ha già la carta) ──────────────
  doc.setTextColor(...VERDE)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(payload.schoolName ?? 'Kidville', CENTRO_PAGINA, y, {
    align: 'center',
    maxWidth: CARTA.margineDx - CARTA.margineSx,
  })
  y += 9
  doc.setFontSize(13)
  doc.text(payload.title, CENTRO_PAGINA, y, {
    align: 'center',
    maxWidth: CARTA.margineDx - CARTA.margineSx,
  })
  doc.setDrawColor(...VERDE)
  doc.line(CARTA.margineSx + 18, y + 4, CARTA.margineDx - 18, y + 4)
  y += 16

  // ── Corpo ────────────────────────────────────────────────────────────────────
  doc.setTextColor(...INCHIOSTRO)
  doc.setFontSize(CORPO_TESTO)
  const line = (label: string, value: string, tieneLaNota = false) => {
    const righe = doc.splitTextToSize(value, LARGHEZZA_VALORE) as string[]
    const avanzamento = Math.max(PASSO_RIGA, righe.length * INTERLINEA + 3.5)
    spazioPer((righe.length - 1) * INTERLINEA, tieneLaNota ? avanzamento : null)
    doc.setTextColor(...INCHIOSTRO)
    doc.setFontSize(CORPO_TESTO)
    doc.setFont('helvetica', 'bold')
    doc.text(label, CARTA.margineSx, y)
    doc.setFont('helvetica', 'normal')
    doc.text(righe, COLONNA_VALORE, y)
    y += avanzamento
  }

  // Il NOME e basta. L'email sta nell'hash documentale due righe più giù; IP e User-Agent
  // stanno nell'audit immutabile, che è il posto dove servono e l'unico dove sono
  // consultabili da chi ha titolo. Senza nome resta un trattino: un foglio che non nomina
  // nessuno è meno grave di un foglio che stampa l'indirizzo di chi ha firmato.
  // ── Tabella firmatari (firma congiunta) se più di uno slot ───────────────────
  const slots = payload.slots ?? []
  const PASSO_SLOT = 7
  const conElenco = slots.length > 1

  line('Firmatario:', senzaRecapiti(payload.signer.name ?? '') || '—')
  line('Documento:', `${payload.entitaTipo} · ${payload.entitaId}`)
  line('Metodo:', `${s.method} — ${s.provider}`)
  line('Data/ora firma:', istante(s.signed_at))
  if (s.hash) line('Hash OTP:', s.hash)
  line('Hash documento:', contentHash)
  // Senza l'elenco delle firme congiunte, «Conformità» è l'ULTIMA riga di contenuto: è lei
  // a doversi portare dietro la nota di chiusura.
  line('Conformità:', s.compliance, !conElenco)

  if (conElenco) {
    y += 4
    spazioPer(0)
    doc.setTextColor(...INCHIOSTRO)
    doc.setFontSize(CORPO_TESTO)
    doc.setFont('helvetica', 'bold')
    doc.text('Firme raccolte', CARTA.margineSx, y)
    y += PASSO_SLOT
    doc.setFont('helvetica', 'normal')
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k]
      spazioPer(0, k === slots.length - 1 ? PASSO_SLOT : null)
      doc.setTextColor(...INCHIOSTRO)
      doc.setFontSize(CORPO_TESTO)
      doc.setFont('helvetica', 'normal')
      const stato = slot.stato === 'signed' ? 'FIRMATO' : 'in attesa'
      doc.text(
        `Slot ${slot.slot_index + 1}: ${stato}${slot.firmato_il ? ` — ${istante(slot.firmato_il)}` : ''}`,
        CARTA.margineSx + 4,
        y
      )
      y += PASSO_SLOT
    }
  }

  // ── Nota di chiusura ─────────────────────────────────────────────────────────
  //
  // Stava a y=285, cioè DENTRO il piede a quattro colonne stampato sulla carta: ci
  // sarebbe finita sopra la ragione sociale e i recapiti delle tre sedi. Ora chiude il
  // contenuto, dove le sue due righe hanno lo spazio che serve.
  //
  // Il salto qui sotto resta come RETE: se la nota non ci sta nemmeno dopo che l'ultima
  // riga di contenuto se l'è portata dietro — una nota che un domani diventasse lunga
  // quanto una pagina — si spezza il blocco invece di sfondare il piede della carta.
  y += STACCO_NOTA
  if (!ciSta(y + (nota.length - 1) * PASSO_NOTA, CORPO_NOTA)) {
    doc.addPage()
    y = CARTA.contenutoInizio
  }
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(CORPO_NOTA)
  doc.setTextColor(...GRIGIO)
  doc.text(nota, CARTA.margineSx, y)

  disegnaNumeriDiPagina(doc)

  return Buffer.from(doc.output('arraybuffer'))
}

/**
 * La ricevuta come si consegna: il contenuto sulla carta intestata reale della scuola.
 *
 * È questa che chiama la rotta. Se la carta non si applica la funzione **lancia** invece
 * di restituire il foglio nudo: una ricevuta di firma senza intestazione è un documento
 * che afferma la validità di una firma senza dire di chi è la scuola che la conserva.
 */
export async function buildReceiptPdfSuCarta(payload: ReceiptPayload): Promise<Uint8Array> {
  return await applicaCartaIntestata(new Uint8Array(buildReceiptPdf(payload)))
}
