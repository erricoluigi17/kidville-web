/**
 * La decisione: questa domanda si può mandare avanti, oppure no.
 *
 * ─── È QUI CHE IL PROGRAMMA SI FERMA ────────────────────────────────────────
 * Tutto il resto del lavoro (leggere il file, prendere il lotto, scrivere
 * l'anagrafica, spedire) è meccanica. La sola parte che decide è questa, e la
 * regola che la governa è una sola: **nel dubbio non si procede.**
 *
 * Un bambino messo nella classe sbagliata non produce nessun errore, nessun log
 * rosso, nessuna riga in `app_log`. Se ne accorge la maestra a settembre, o il
 * genitore quando riceve una retta che non è la sua. Per questo ogni incertezza
 * — un omonimo, un nome che non torna, una retta che non si deduce — diventa
 * `da_controllare` con una frase che una persona può leggere e risolvere in
 * trenta secondi, invece di una scelta automatica che nessuno rivedrà mai.
 *
 * Questo modulo è PURO: non tocca il database, non manda niente. Riceve la
 * domanda, l'elenco della sede e le famiglie già ricostruite, e restituisce una
 * decisione. È ciò che permette alla prova a vuoto di dire davvero «ecco cosa
 * avrei fatto», senza fare nulla.
 */
import { abbina, type RigaElenco } from './abbinamento'
import { normalizzaNome } from './normalizza'
import { risolviRetta } from './retta'

export interface BambinoDomanda {
  nome: string
  cognome: string
  codiceFiscale: string | null
  dataNascita: string | null
}

export interface AdultoDomanda {
  nome: string
  cognome: string
  email: string | null
  codiceFiscale: string | null
  ruolo: string | null
}

export interface Domanda {
  id: string
  scuolaId: string | null
  creataIl: string
  bambini: BambinoDomanda[]
  adulti: AdultoDomanda[]
}

export interface AssegnazioneBambino {
  indice: number
  nome: string
  cognome: string
  classe: string
  /** La retta da scrivere. Zero SOLO quando `aCaricoDi` è valorizzato. */
  retta: number
  /** Il nome del fratello che paga per tutti, quando è il suo caso. */
  aCaricoDi: string | null
}

export type Decisione =
  | { tipo: 'invia'; assegnazioni: AssegnazioneBambino[]; referente: AdultoDomanda }
  | { tipo: 'da_controllare'; motivo: string }
  | { tipo: 'duplicata'; di: string; motivo: string }

/**
 * Le righe dell'elenco che appartengono ai fratelli di un bambino.
 * La famiglia si riconosce dal CODICE FISCALE DEL GENITORE — mai dal cognome:
 * misurato sul vero, una famiglia ha due cognomi diversi sotto lo stesso
 * genitore, e due fratelli stanno in domande separate.
 */
export type RigheDeiFratelli = (bambino: BambinoDomanda) => RigaElenco[]

/** Il referente è il primo adulto con un'email: è a lui che arriva l'accesso. */
export function referenteDi(domanda: Domanda): AdultoDomanda | null {
  return domanda.adulti.find((a) => (a.email ?? '').includes('@')) ?? null
}

/**
 * Quanto una domanda «sta in piedi», per scegliere fra due doppioni.
 *
 * Non è un giudizio sulla famiglia: è un conteggio di quanto il modulo è stato
 * compilato per intero. Serve solo quando lo stesso bambino risulta iscritto due
 * volte — succede, ed è successo 8 volte su 393 domande — e bisogna dire quale
 * delle due vale. A parità di completezza vince la PIÙ RECENTE: se un genitore
 * ha rifatto il modulo, è perché voleva correggere qualcosa.
 */
export function completezza(domanda: Domanda): number {
  let punti = 0
  for (const b of domanda.bambini) {
    if ((b.codiceFiscale ?? '').length === 16) punti += 2
    if (b.dataNascita) punti += 1
  }
  for (const a of domanda.adulti) {
    if ((a.email ?? '').includes('@')) punti += 2
    if ((a.codiceFiscale ?? '').length === 16) punti += 1
    if (a.nome && a.cognome) punti += 1
  }
  return punti
}

/**
 * Fra due domande per lo stesso bambino, quale vale.
 * Restituisce `true` se `a` è da preferire a `b`.
 */
export function preferibile(a: Domanda, b: Domanda): boolean {
  const ca = completezza(a)
  const cb = completezza(b)
  if (ca !== cb) return ca > cb
  return a.creataIl >= b.creataIl
}

/**
 * Una decisione presa da una PERSONA su un bambino che il programma non sapeva
 * risolvere da solo.
 *
 * ─── PERCHÉ ESISTE, E PERCHÉ NON È UN'ECCEZIONE NEL CODICE ──────────────────
 * Alcuni casi non hanno una risposta dentro i dati, e non l'avranno mai: due
 * bambini omonimi in due sezioni, un fratellino che nell'elenco non c'è ancora,
 * un nome che nel foglio è scritto in un altro modo. La risposta ce l'ha la
 * segreteria, ed è giusto che ce l'abbia lei.
 *
 * La regola resta intatta: **il programma continua a non indovinare**. Cambia
 * che ora esiste il posto in cui una persona scrive la risposta, e resta scritto
 * chi l'ha data e quando. Un `if` nel codice per il caso «Palma» sarebbe la
 * stessa decisione presa peggio: invisibile, senza data e senza nome.
 */
export interface DecisioneSegreteria {
  /** La classe decisa. Se assente, si continua a cercarla nell'elenco. */
  classe?: string | null
  /** La retta decisa. Se assente, si continua a leggerla dall'elenco. */
  retta?: number | null
  /** Il nome del fratello che paga per lui, se è il suo caso. */
  aCaricoDi?: string | null
  /** Perché: la legge chi rilegge fra sei mesi. */
  nota?: string | null
}

/** Le decisioni, per nome normalizzato del bambino dentro quella domanda. */
export type DecisioniDellaDomanda = Map<string, DecisioneSegreteria>

export function decidi(
  domanda: Domanda,
  elenco: readonly RigaElenco[],
  righeDeiFratelli: RigheDeiFratelli,
  duplicatoDi?: { id: string; motivo: string },
  decisioni?: DecisioniDellaDomanda,
): Decisione {
  if (duplicatoDi) {
    return { tipo: 'duplicata', di: duplicatoDi.id, motivo: duplicatoDi.motivo }
  }

  if (domanda.bambini.length === 0) {
    return { tipo: 'da_controllare', motivo: 'La domanda non contiene nessun bambino.' }
  }

  const referente = referenteDi(domanda)
  if (!referente) {
    return {
      tipo: 'da_controllare',
      motivo:
        'Nessuno degli adulti della domanda ha un indirizzo email: non c\'è dove mandare le credenziali.',
    }
  }

  const assegnazioni: AssegnazioneBambino[] = []

  // Le chiavi delle decisioni si normalizzano QUI, non si pretende che arrivino
  // già pulite: chi le scrive è una persona che copia un nome da un foglio, e
  // uno spazio di troppo non deve far ricadere un caso già risolto fra i «da
  // controllare» — che è precisamente il difetto che le decisioni chiudono.
  const decise = new Map<string, DecisioneSegreteria>()
  if (decisioni) for (const [k, v] of decisioni) decise.set(normalizzaNome(k), v)

  for (let i = 0; i < domanda.bambini.length; i++) {
    const b = domanda.bambini[i]
    const chi = `${b.cognome} ${b.nome}`.trim()
    const decisa = decise.get(normalizzaNome(chi))

    // Una decisione COMPLETA (classe + come si paga) chiude il caso senza
    // nemmeno guardare l'elenco: è il posto in cui una persona ha già risposto
    // alla domanda che il programma non sapeva risolvere.
    if (decisa?.classe && (decisa.retta != null || decisa.aCaricoDi)) {
      assegnazioni.push({
        indice: i,
        nome: b.nome,
        cognome: b.cognome,
        classe: decisa.classe,
        retta: decisa.aCaricoDi ? 0 : Number(decisa.retta),
        aCaricoDi: decisa.aCaricoDi ?? null,
      })
      continue
    }

    const esito = abbina(b.nome, b.cognome, elenco)

    // Una decisione sulla SOLA classe (il caso degli omonimi: l'elenco ha la
    // retta, ma non sa dire quale delle due righe sia la sua) lascia che la
    // retta continui a venire dal foglio — purché le righe candidate concordino.
    if (decisa?.classe && decisa.retta == null && !decisa.aCaricoDi) {
      const candidate = esito.tipo === 'unico' ? [esito.riga] : esito.tipo === 'ambiguo' ? esito.righe : []
      const suaClasse = candidate.filter((r) => normalizzaNome(r.classe) === normalizzaNome(decisa.classe as string))
      if (suaClasse.length === 1) {
        const rettaDecisa = risolviRetta(suaClasse[0], righeDeiFratelli(b))
        if (rettaDecisa.tipo === 'da_controllare') {
          return { tipo: 'da_controllare', motivo: `${chi} (${decisa.classe}): ${rettaDecisa.motivo}` }
        }
        assegnazioni.push({
          indice: i,
          nome: b.nome,
          cognome: b.cognome,
          classe: suaClasse[0].classe,
          retta: rettaDecisa.tipo === 'importo' ? rettaDecisa.importo : 0,
          aCaricoDi: rettaDecisa.tipo === 'a_carico' ? rettaDecisa.aCaricoDi.nome : null,
        })
        continue
      }
      return {
        tipo: 'da_controllare',
        motivo: `Per ${chi} è stata indicata la classe ${decisa.classe}, ma nell'elenco non c'è esattamente una riga sua in quella classe (ne risultano ${suaClasse.length}). La decisione va rivista, oppure va corretto il foglio.`,
      }
    }

    if (esito.tipo === 'ambiguo') {
      const dove = esito.righe.map((r) => `${r.classe} (riga ${r.riga})`).join(', ')
      return {
        tipo: 'da_controllare',
        motivo: `Nell'elenco ci sono ${esito.righe.length} righe che corrispondono a ${chi}: ${dove}. Non è possibile sapere quale sia la sua senza guardarle.`,
      }
    }

    if (esito.tipo === 'assente') {
      const simili = esito.simili.map((r) => `${r.nome} (${r.classe})`).join(', ')
      return {
        tipo: 'da_controllare',
        motivo: simili
          ? `${chi} non compare nell'elenco delle classi. I nomi più somiglianti sono: ${simili}. Se è solo un errore di scrittura basta correggere il foglio.`
          : `${chi} non compare nell'elenco delle classi, e non c'è nessun nome somigliante.`,
      }
    }

    const riga = esito.riga
    const retta = risolviRetta(riga, righeDeiFratelli(b))

    if (retta.tipo === 'da_controllare') {
      return { tipo: 'da_controllare', motivo: `${chi} (${riga.classe}): ${retta.motivo}` }
    }

    assegnazioni.push({
      indice: i,
      nome: b.nome,
      cognome: b.cognome,
      classe: riga.classe,
      retta: retta.tipo === 'importo' ? retta.importo : 0,
      aCaricoDi: retta.tipo === 'a_carico' ? retta.aCaricoDi.nome : null,
    })
  }

  return { tipo: 'invia', assegnazioni, referente }
}
