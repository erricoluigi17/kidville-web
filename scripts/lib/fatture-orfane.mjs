/**
 * Funzioni PURE della registrazione delle fatture ORFANE (D1 §9).
 *
 * Un'orfana è una fattura PARTITA verso Aruba (upload riuscito, nome file sul
 * pagamento) e mai scritta in `fatture_emesse`: l'INSERT a registro è fallito dopo
 * l'upload. Il documento esiste allo SdI, il registro no. `scripts/fatture-orfane.mjs`
 * le trova, rilegge da Aruba l'XML che era partito e scrive la riga mancante, UNA
 * istruzione atomica per voce, mostrata prima di eseguirla.
 *
 * ─── PERCHÉ UN FILE A PARTE ─────────────────────────────────────────────────
 * Lo script legge DB e Aruba e scrive righe WORM, che non si correggono più: tutto ciò
 * che si può sbagliare senza rete sta qui, e qui si prova. Il modulo non lancia
 * processi e non legge la rete; da `src/` non importa niente: il predicato «partita
 * non registrata» (TS e gemello SQL) glielo PASSA lo script, che lo carica da
 * `@/lib/pagamenti/fattura-partita-non-registrata` con `risolvi-ts.mjs`. Così il testo
 * del predicato ha una fonte sola e qui non ne esiste una copia.
 *
 * ─── COSA C'È ───────────────────────────────────────────────────────────────
 *   · `estraiCampiXml`: i campi del documento, sul tracciato di
 *     `src/lib/aruba/fatturapa-xml.ts` (buildFatturaElettronicaXml), entità decodificate;
 *     più di un corpo, DOCTYPE, CDATA o un campo ripetuto → rifiuto;
 *   · `datiDaLog`, `accoppiaOrfane`: la scoperta, con la parità SQL/TS per voce;
 *   · `risolviIntestatario`: i casi (i)-(iv) di D1 §9.2;
 *   · `componiInsert`: l'istruzione di D1 §9.3, con le validazioni e il tag dollaro;
 *   · `SQL_VINCOLO_PER_SEDE` e `verdettoVincolo`: senza la migrazione non si scrive;
 *   · le maschere per la stampa («SCRIVO i/N:»): mai CF, nomi, causale o XML in chiaro;
 *   · `fuoriDalRepository`, la stessa di `aruba-lettura.mjs`.
 */

import { createHash, randomBytes } from 'node:crypto'
import { fuoriDalRepository, RE_NOME_FILE_ARUBA } from './aruba-lettura.mjs'

export { fuoriDalRepository, RE_NOME_FILE_ARUBA }

/* ────────────────────────────────────────────────────────────────────────────
 * Costanti
 * ──────────────────────────────────────────────────────────────────────────── */

/** Le due serie fiscali (`src/lib/fatturazione/sezionale.ts`). */
export const SERIE = Object.freeze(['Asilo', 'FPR'])

/** Il vincolo della baseline che la migrazione di D1 toglie. Finché c'è, niente scritture. */
export const VINCOLO_NUMERO_PER_SEDE = 'fatture_emesse_scuola_id_anno_numero_key'

/** I vincoli unici di `fatture_emesse` che un 23505 può nominare (`vincolo-registro.ts`). */
export const VINCOLI_REGISTRO = Object.freeze([
  'fatture_emesse_pagamento_quota_uidx',
  'fatture_emesse_sezionale_anno_numero_uidx',
  VINCOLO_NUMERO_PER_SEDE,
])

/** Gli esiti di `app_log` che dichiarano un documento partito e non registrato (D1 §9.1 punto 2). */
export const ESITI_LOG_REGISTRO = Object.freeze([
  'registro-doppione-rifiutato',
  'registro-non-scritto',
  'registro-numero-serie-duplicato',
  'registro-vincolo-per-sede',
  'registro-vincolo-ignoto',
])

/** Le sedi fittizie della CI: mai nella scoperta. */
export const PREFISSO_SEDE_DI_PROVA = 'e2e00000-'

/** Il numero di fattura nei messaggi di log: «Asilo 2524/2026», «FPR 2525/26». */
export const RE_NUMERO_NEL_LOG = /((?:Asilo|FPR) [0-9]+\/[0-9]+)/

/** Il nome file dentro un testo (la forma ancorata è `RE_NOME_FILE_ARUBA`). */
const RE_NOME_FILE_NEL_TESTO = /IT[0-9A-Z]{11,16}_[0-9A-Za-z]{5}\.xml(?:\.p7m)?/g

/** Cedente atteso (controllo b di D1 §9.1). */
export const PARTITA_IVA_CEDENTE = '03394870616'

/** Il motivo che lo script stampa quando il vincolo per sede è ancora nel database. */
export const MOTIVO_MIGRAZIONE_NON_APPLICATA = 'migrazione non applicata'

/** I testi «DA DECIDERE» della scoperta: una voce che ne porta uno non si scrive. */
export const DA_DECIDERE = Object.freeze({
  predicatiDiscordi: 'DA DECIDERE: i due predicati non concordano',
  laRegistraLaCoda: 'DA DECIDERE: la registra la coda',
  piuLog: 'DA DECIDERE: più log di registro per lo stesso pagamento',
  righeARegistro: 'DA DECIDERE: il pagamento ha già righe a registro, non è un\'orfana pura',
  fileNonValido: 'DA DECIDERE: nome file del pagamento assente o non valido',
  sedeDelLog: 'DA DECIDERE: la sede del log non è quella del pagamento',
})

/* ────────────────────────────────────────────────────────────────────────────
 * Numero di fattura
 * ──────────────────────────────────────────────────────────────────────────── */

const RE_NUMERO_FATTURA = /^(Asilo|FPR) ([1-9][0-9]{0,8})\/([0-9]{2}|[0-9]{4})$/

/**
 * Legge «Asilo 2524/2026» o «FPR 2525/26» (la forma di `formattaNumeroFattura`, che per
 * la FPR scrive l'anno a due cifre). `null` se la forma non è questa.
 *
 * @param {unknown} testo
 * @returns {{ sezionale: string, numero: number, anno: number, testo: string } | null}
 */
export function leggiNumeroFattura(testo) {
  if (typeof testo !== 'string') return null
  const pezzi = RE_NUMERO_FATTURA.exec(testo.trim())
  if (!pezzi) return null
  const anno = pezzi[3].length === 2 ? 2000 + Number(pezzi[3]) : Number(pezzi[3])
  return { sezionale: pezzi[1], numero: Number(pezzi[2]), anno, testo: testo.trim() }
}

/* ────────────────────────────────────────────────────────────────────────────
 * estraiCampiXml
 * ──────────────────────────────────────────────────────────────────────────── */

/** Le sole entità dell'XML: nessun DTD, quindi nessun'altra è definita. */
const ENTITA = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })

class XmlRifiutato extends Error {}

/** Il testo di un elemento foglia, con le entità decodificate. Lancia su tutto ciò che non conosce. */
function decodifica(grezzo) {
  if (grezzo.includes('<')) throw new XmlRifiutato('un campo atteso come testo contiene elementi')
  return grezzo.replace(/&([^;&\s]*);?/g, (intero, nome) => {
    if (!intero.endsWith(';')) throw new XmlRifiutato('carattere & non seguito da un\'entità valida')
    if (Object.hasOwn(ENTITA, nome)) return ENTITA[nome]
    const num = /^#x([0-9A-Fa-f]{1,6})$/.exec(nome) ?? /^#([0-9]{1,7})$/.exec(nome)
    if (num) {
      const codice = parseInt(num[1], nome[1] === 'x' ? 16 : 10)
      if (codice === 0 || codice > 0x10ffff || (codice >= 0xd800 && codice <= 0xdfff)) {
        throw new XmlRifiutato(`riferimento a carattere non valido (&${nome};)`)
      }
      return String.fromCodePoint(codice)
    }
    throw new XmlRifiutato(`entità sconosciuta (&${nome};)`)
  })
}

/** Nome di elemento con un prefisso facoltativo: il tracciato prefissa solo la radice. */
function nomeElemento(tag) {
  return `(?:[A-Za-z_][\\w.-]*:)?${tag}`
}

/** Il contenuto di ogni `<tag>…</tag>` dentro `testo` (niente elementi omonimi annidati nel tracciato). */
function contenuti(testo, tag) {
  const re = new RegExp(`<${nomeElemento(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${nomeElemento(tag)}\\s*>`, 'g')
  return [...testo.matchAll(re)].map((m) => m[1])
}

/** Un solo elemento `tag` dentro `testo`: ripetuto → rifiuto; assente → rifiuto o `null`. */
function unico(testo, tag, { obbligatorio = true } = {}) {
  const trovati = contenuti(testo, tag)
  if (trovati.length > 1) throw new XmlRifiutato(`campo ripetuto: ${tag}`)
  if (trovati.length === 0) {
    if (obbligatorio) throw new XmlRifiutato(`campo mancante: ${tag}`)
    return null
  }
  return trovati[0]
}

/** Il testo di una foglia unica, decodificato e senza spazi ai bordi. */
function foglia(testo, tag, opzioni) {
  const grezzo = unico(testo, tag, opzioni)
  return grezzo === null ? null : decodifica(grezzo).trim()
}

/**
 * I campi del documento che servono alla riga a registro e ai controlli di D1 §9.1
 * punto 4, sul tracciato di `buildFatturaElettronicaXml`:
 *   ProgressivoInvio · TipoDocumento · Data · Numero · ImportoTotaleDocumento ·
 *   ImportoPagamento · BolloVirtuale · CedentePrestatore/IdCodice ·
 *   CessionarioCommittente (CodiceFiscale, Nome, Cognome) · DettaglioLinee/Descrizione.
 *
 * Rifiuta (mai un campo «indovinato»): più di un `FatturaElettronicaBody` (un lotto
 * non è una fattura dell'app), DOCTYPE o ENTITY, CDATA, un campo ripetuto nel suo
 * blocco, più righe di dettaglio o di pagamento, un'entità sconosciuta.
 *
 * @param {unknown} xml
 * @returns {{ ok: true, campi: {
 *     progressivoInvio: string, tipoDocumento: string, data: string, numero: string,
 *     importoTotaleDocumento: string, importoPagamento: string | null, bolloVirtuale: boolean,
 *     cedenteIdCodice: string, cessionario: { codiceFiscale: string, nome: string, cognome: string },
 *     descrizione: string } }
 *   | { ok: false, motivo: string }}
 */
export function estraiCampiXml(xml) {
  try {
    if (typeof xml !== 'string' || xml.trim() === '') throw new XmlRifiutato('XML vuoto')
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new XmlRifiutato('DOCTYPE o ENTITY non ammessi')
    if (xml.includes('<![CDATA[')) throw new XmlRifiutato('CDATA non ammesso')
    const corpiAperti = xml.match(new RegExp(`<${nomeElemento('FatturaElettronicaBody')}[\\s>]`, 'g')) ?? []
    if (corpiAperti.length > 1) throw new XmlRifiutato(`più di un FatturaElettronicaBody (${corpiAperti.length})`)

    const testata = unico(xml, 'FatturaElettronicaHeader')
    const corpo = unico(xml, 'FatturaElettronicaBody')

    const trasmissione = unico(testata, 'DatiTrasmissione')
    const cedente = unico(unico(testata, 'CedentePrestatore'), 'DatiAnagrafici')
    const cessionario = unico(unico(testata, 'CessionarioCommittente'), 'DatiAnagrafici')
    const anagraficaCessionario = unico(cessionario, 'Anagrafica')

    const documento = unico(unico(corpo, 'DatiGenerali'), 'DatiGeneraliDocumento')
    const bollo = unico(documento, 'DatiBollo', { obbligatorio: false })
    const linee = contenuti(unico(corpo, 'DatiBeniServizi'), 'DettaglioLinee')
    if (linee.length !== 1) throw new XmlRifiutato(`righe di dettaglio: ${linee.length}, attesa 1`)

    const pagamento = unico(corpo, 'DatiPagamento', { obbligatorio: false })
    let importoPagamento = null
    if (pagamento !== null) {
      const dettagli = contenuti(pagamento, 'DettaglioPagamento')
      if (dettagli.length !== 1) throw new XmlRifiutato(`righe di pagamento: ${dettagli.length}, attesa 1`)
      importoPagamento = foglia(dettagli[0], 'ImportoPagamento')
    }

    return {
      ok: true,
      campi: {
        progressivoInvio: foglia(trasmissione, 'ProgressivoInvio'),
        tipoDocumento: foglia(documento, 'TipoDocumento'),
        data: foglia(documento, 'Data'),
        numero: foglia(documento, 'Numero'),
        importoTotaleDocumento: foglia(documento, 'ImportoTotaleDocumento'),
        importoPagamento,
        bolloVirtuale: bollo !== null && foglia(bollo, 'BolloVirtuale') === 'SI',
        cedenteIdCodice: foglia(unico(cedente, 'IdFiscaleIVA'), 'IdCodice'),
        cessionario: {
          codiceFiscale: foglia(cessionario, 'CodiceFiscale'),
          nome: foglia(anagraficaCessionario, 'Nome'),
          cognome: foglia(anagraficaCessionario, 'Cognome'),
        },
        descrizione: foglia(linee[0], 'Descrizione'),
      },
    }
  } catch (e) {
    if (e instanceof XmlRifiutato) return { ok: false, motivo: e.message }
    throw e
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Scoperta: log e accoppiamento
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Da una riga di `app_log` (colonne `id, messaggio, utente_id, scuola_id, contesto`) i
 * dati che servono all'accoppiamento. Il nome file e il numero stanno nel MESSAGGIO
 * (il sezionale non è in lista bianca, quindi nei `campi` arriverebbe redatto); il
 * vincolo sta in `contesto.causa.messaggio`, il testo del 23505.
 *
 * @param {{ id?: string, messaggio?: string | null, utente_id?: string | null,
 *   scuola_id?: string | null, contesto?: any }} riga
 * @returns {{ app_log_id: string | null, esito: string | null, file: string | null,
 *   fileAmbiguo: boolean, numero: ReturnType<typeof leggiNumeroFattura>,
 *   vincolo: string | null, utente_id: string | null, scuola_id: string | null }}
 */
export function datiDaLog(riga) {
  const contesto = riga?.contesto && typeof riga.contesto === 'object' ? riga.contesto : {}
  const campi = contesto.campi && typeof contesto.campi === 'object' ? contesto.campi : {}
  const testi = [riga?.messaggio, campi.msg].filter((t) => typeof t === 'string')
  const tutti = testi.join('\n')

  const file = [...new Set(tutti.match(RE_NOME_FILE_NEL_TESTO) ?? [])]
  const numeroTesto = RE_NUMERO_NEL_LOG.exec(tutti)?.[1] ?? null

  const causa = typeof contesto.causa?.messaggio === 'string' ? contesto.causa.messaggio : ''
  const nominato = /"([a-z0-9_]+)"/.exec(causa)?.[1] ?? null
  const vincolo = nominato && VINCOLI_REGISTRO.includes(nominato) ? nominato : null

  return {
    app_log_id: typeof riga?.id === 'string' ? riga.id : null,
    esito: typeof campi.esito === 'string' ? campi.esito : null,
    file: file.length === 1 ? file[0] : null,
    fileAmbiguo: file.length > 1,
    numero: numeroTesto ? leggiNumeroFattura(numeroTesto) : null,
    vincolo,
    utente_id: typeof riga?.utente_id === 'string' ? riga.utente_id : null,
    scuola_id: typeof riga?.scuola_id === 'string' ? riga.scuola_id : null,
  }
}

/**
 * Accoppia i pagamenti della scoperta ai log e decide, voce per voce, se si può
 * scrivere (`pronta`) o no (`da_decidere`, coi motivi). D1 §9.1 punto 2.
 *
 * La PARITÀ è per voce: ogni pagamento restituito dal predicato SQL si ricontrolla col
 * predicato TS sulle SUE righe (tutte, in qualunque stato SdI). Se non concordano la
 * voce è «DA DECIDERE», e lo script esce con 2. Il verso opposto si prova sui pagamenti
 * che i log nominano e che l'SQL non ha restituito (`pagamentiDeiLog`): se il TS li dà
 * veri, i due predicati non concordano neanche lì.
 *
 * @param {{
 *   candidatiSql: Array<{ id: string, scuola_id: string, fattura_stato: string,
 *     fattura_aruba_id: string | null, fattura_emessa_il?: string | null }>,
 *   pagamentiDeiLog?: Array<{ id: string, scuola_id: string, fattura_stato: string,
 *     fattura_aruba_id: string | null, fattura_emessa_il?: string | null }>,
 *   righe: Array<{ pagamento_id: string, sdi_stato: number | null, aruba_filename: string | null }>,
 *   log: Array<Parameters<typeof datiDaLog>[0]>,
 *   pagamentiConInvio: string[] | null,
 *   predicato: (pag: any, righe: readonly any[]) => boolean,
 * }} ingresso  `pagamentiConInvio` è `null` quando `fatture_coda_invii` non esiste;
 *   `predicato` è `fatturaPartitaNonRegistrata` del modulo TS.
 */
export function accoppiaOrfane({ candidatiSql, pagamentiDeiLog = [], righe, log, pagamentiConInvio, predicato }) {
  if (typeof predicato !== 'function') throw new TypeError('accoppiaOrfane: serve il predicato TS del modulo')
  if (!Array.isArray(candidatiSql) || !Array.isArray(righe) || !Array.isArray(log)) {
    throw new TypeError('accoppiaOrfane: candidatiSql, righe e log devono essere array')
  }

  const righePer = new Map()
  for (const r of righe) {
    if (!righePer.has(r.pagamento_id)) righePer.set(r.pagamento_id, [])
    righePer.get(r.pagamento_id).push(r)
  }
  const conInvio = pagamentiConInvio == null ? null : new Set(pagamentiConInvio)

  const datiLog = log
    .map(datiDaLog)
    .filter((d) => d.esito === null || ESITI_LOG_REGISTRO.includes(d.esito))
  const logPerFile = new Map()
  for (const d of datiLog) {
    if (!d.file) continue
    if (!logPerFile.has(d.file)) logPerFile.set(d.file, [])
    logPerFile.get(d.file).push(d)
  }

  const diProva = (p) => typeof p.scuola_id === 'string' && p.scuola_id.startsWith(PREFISSO_SEDE_DI_PROVA)
  const idSql = new Set(candidatiSql.map((p) => p.id))
  const avvisi = []
  let esclusi = 0
  const voci = []
  const fileUsati = new Set()

  for (const pag of candidatiSql) {
    if (diProva(pag)) {
      esclusi += 1
      continue
    }
    const sue = righePer.get(pag.id) ?? []
    const motivi = []
    const avvisiVoce = []

    if (predicato(pag, sue) !== true) motivi.push(DA_DECIDERE.predicatiDiscordi)
    if (sue.length > 0) motivi.push(DA_DECIDERE.righeARegistro)
    if (conInvio && conInvio.has(pag.id)) motivi.push(DA_DECIDERE.laRegistraLaCoda)

    const file = pag.fattura_aruba_id
    const fileValido = typeof file === 'string' && RE_NOME_FILE_ARUBA.test(file)
    if (!fileValido) motivi.push(DA_DECIDERE.fileNonValido)

    let datoLog = null
    const suoiLog = fileValido ? (logPerFile.get(file) ?? []) : []
    if (fileValido) fileUsati.add(file)
    if (suoiLog.length > 1) motivi.push(DA_DECIDERE.piuLog)
    else if (suoiLog.length === 0) avvisiVoce.push('nessun log di registro con questo nome file')
    else {
      datoLog = suoiLog[0]
      if (datoLog.scuola_id && datoLog.scuola_id !== pag.scuola_id) motivi.push(DA_DECIDERE.sedeDelLog)
      if (!datoLog.numero) avvisiVoce.push('il log non riporta un numero di fattura leggibile')
    }

    voci.push({
      pagamento_id: pag.id,
      scuola_id: pag.scuola_id,
      file: fileValido ? file : null,
      fattura_emessa_il: pag.fattura_emessa_il ?? null,
      stato: motivi.length > 0 ? 'da_decidere' : 'pronta',
      motivi,
      avvisi: avvisiVoce,
      log: datoLog,
    })
  }

  // Il verso opposto della parità: un pagamento nominato da un log, fuori dall'SQL, che
  // il TS dà «partito e non registrato».
  for (const pag of pagamentiDeiLog) {
    if (idSql.has(pag.id) || diProva(pag)) continue
    if (predicato(pag, righePer.get(pag.id) ?? []) === true) {
      voci.push({
        pagamento_id: pag.id,
        scuola_id: pag.scuola_id,
        file: typeof pag.fattura_aruba_id === 'string' ? pag.fattura_aruba_id : null,
        fattura_emessa_il: pag.fattura_emessa_il ?? null,
        stato: 'da_decidere',
        motivi: [DA_DECIDERE.predicatiDiscordi],
        avvisi: [],
        log: null,
      })
      if (typeof pag.fattura_aruba_id === 'string') fileUsati.add(pag.fattura_aruba_id)
    }
  }

  const logSenzaOrfana = datiLog
    .filter((d) => !d.file || !fileUsati.has(d.file))
    .map((d) => ({ app_log_id: d.app_log_id, file: d.file, esito: d.esito }))
  if (logSenzaOrfana.length > 0) avvisi.push(`${logSenzaOrfana.length} log di registro senza un'orfana`)

  voci.sort((a, b) => String(a.fattura_emessa_il ?? '').localeCompare(String(b.fattura_emessa_il ?? '')))
  const daDecidere = voci.filter((v) => v.stato === 'da_decidere').length
  return { voci, logSenzaOrfana, esclusi, avvisi, daDecidere }
}

/* ────────────────────────────────────────────────────────────────────────────
 * risolviIntestatario
 * ──────────────────────────────────────────────────────────────────────────── */

function cfNormalizzato(cf) {
  return typeof cf === 'string' ? cf.replace(/\s+/g, '').toUpperCase() : ''
}

/**
 * `quota_adult_id` e `parent_registry_id` della riga (D1 §9.2), dal codice fiscale
 * dell'XML INVIATO (decisione 24: l'intestatario è quello del documento, non quello di
 * oggi in anagrafica):
 *   (i)   un adulto del bambino la cui riga `parents` ha quel CF → i suoi due id;
 *   (ii)  altrimenti un solo `parents` con quel CF → il suo id in entrambe le colonne
 *         (`resolveParentRegistry` accetta `parents.id` come adulto);
 *   (iii) altrimenti, intestatario `altro` sulla scheda → NULL e NULL, come l'app;
 *   (iv)  altrimenti → DA DECIDERE. Anche due adulti o due `parents` col CF lo sono.
 *
 * @param {{ codiceFiscale: string,
 *   adulti?: Array<{ adult_id: string, parent_id: string, codice_fiscale: string | null }>,
 *   genitori?: Array<{ id: string, codice_fiscale: string | null }>,
 *   origine?: string | null }} ingresso
 * @returns {{ esito: 'risolto', caso: 'i' | 'ii' | 'iii', quota_adult_id: string | null,
 *   parent_registry_id: string | null } | { esito: 'da_decidere', caso: 'iv', motivo: string }}
 */
export function risolviIntestatario({ codiceFiscale, adulti = [], genitori = [], origine = null }) {
  const cf = cfNormalizzato(codiceFiscale)
  if (cf === '') return { esito: 'da_decidere', caso: 'iv', motivo: 'DA DECIDERE: codice fiscale assente nell\'XML' }

  const adultiCf = adulti.filter((a) => cfNormalizzato(a.codice_fiscale) === cf)
  const coppie = new Set(adultiCf.map((a) => `${a.adult_id}|${a.parent_id}`))
  if (coppie.size > 1) {
    return { esito: 'da_decidere', caso: 'iv', motivo: 'DA DECIDERE: più adulti del bambino con lo stesso codice fiscale' }
  }
  if (coppie.size === 1) {
    return { esito: 'risolto', caso: 'i', quota_adult_id: adultiCf[0].adult_id, parent_registry_id: adultiCf[0].parent_id }
  }

  const genitoriCf = [...new Set(genitori.filter((g) => cfNormalizzato(g.codice_fiscale) === cf).map((g) => g.id))]
  if (genitoriCf.length === 1) {
    return { esito: 'risolto', caso: 'ii', quota_adult_id: genitoriCf[0], parent_registry_id: genitoriCf[0] }
  }
  if (genitoriCf.length > 1) {
    return { esito: 'da_decidere', caso: 'iv', motivo: 'DA DECIDERE: più anagrafiche con lo stesso codice fiscale' }
  }

  if (origine === 'altro') return { esito: 'risolto', caso: 'iii', quota_adult_id: null, parent_registry_id: null }
  return { esito: 'da_decidere', caso: 'iv', motivo: 'DA DECIDERE: intestatario non riconducibile all\'anagrafica' }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Il vincolo per sede: senza la migrazione non si scrive
 * ──────────────────────────────────────────────────────────────────────────── */

/** Quante volte il vincolo per sede è ancora in `pg_constraint` (atteso 0). */
export const SQL_VINCOLO_PER_SEDE =
  `select count(*)::int as n from pg_constraint ` +
  `where conrelid = 'public.fatture_emesse'::regclass and conname = '${VINCOLO_NUMERO_PER_SEDE}'`

/**
 * Il verdetto sulla lettura di `SQL_VINCOLO_PER_SEDE`. Fail-closed: una lettura che non
 * ha la forma attesa non autorizza a scrivere.
 *
 * @param {unknown} righe
 * @returns {{ ok: true } | { ok: false, motivo: string, messaggio: string }}
 */
export function verdettoVincolo(righe) {
  const n = Array.isArray(righe) && righe.length === 1 ? righe[0]?.n : undefined
  if (n === 0) return { ok: true }
  if (Number.isInteger(n) && n > 0) {
    return {
      ok: false,
      motivo: MOTIVO_MIGRAZIONE_NON_APPLICATA,
      messaggio:
        `${MOTIVO_MIGRAZIONE_NON_APPLICATA}: il vincolo ${VINCOLO_NUMERO_PER_SEDE} è ancora nel database. ` +
        'Nessuna scrittura: le orfane si registrano solo dopo il merge della PR-D1.',
    }
  }
  return { ok: false, motivo: 'lettura-non-valida', messaggio: 'lettura del vincolo per sede non valida: nessuna scrittura' }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Maschere per la stampa
 * ──────────────────────────────────────────────────────────────────────────── */

/** Il codice fiscale come `ABC…(16)`: le prime tre lettere e la lunghezza. */
export function mascheraCf(cf) {
  const v = typeof cf === 'string' ? cf.trim() : ''
  if (v === '') return '(assente)'
  return `${v.slice(0, 3)}…(${v.length})`
}

function confrontabile(v) {
  return typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleUpperCase('it') : ''
}

/**
 * Un nome o un cognome solo come lunghezza, e se coincide con l'anagrafica.
 *
 * @param {unknown} valore
 * @param {unknown} [anagrafica] il valore in anagrafica, se lo script lo ha letto
 */
export function mascheraNome(valore, anagrafica) {
  const v = typeof valore === 'string' ? valore.trim() : ''
  if (v === '') return 'assente'
  const coincide = typeof anagrafica !== 'string' ? 'non verificato' : confrontabile(v) === confrontabile(anagrafica) ? 'sì' : 'no'
  return `presente, ${[...v].length} caratteri; coincide con l'anagrafica: ${coincide}`
}

/** Un testo lungo (XML, causale) come `<N byte, sha256 …>`. */
export function mascheraTesto(testo) {
  const v = typeof testo === 'string' ? testo : ''
  const impronta = createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 16)
  return `<${Buffer.byteLength(v, 'utf8')} byte, sha256 ${impronta}…>`
}

/**
 * Tutti i dati personali di una voce, mascherati per la stampa.
 *
 * @param {{ intestatario: { nome: string, cognome: string, codice_fiscale: string },
 *   causale: string, xml: string }} voce
 * @param {{ nome?: string, cognome?: string } | null} [anagrafica]
 */
export function maschera(voce, anagrafica = null) {
  return {
    codice_fiscale: mascheraCf(voce?.intestatario?.codice_fiscale),
    nome: mascheraNome(voce?.intestatario?.nome, anagrafica?.nome),
    cognome: mascheraNome(voce?.intestatario?.cognome, anagrafica?.cognome),
    causale: mascheraTesto(voce?.causale),
    xml: mascheraTesto(voce?.xml),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * componiInsert (D1 §9.3)
 * ──────────────────────────────────────────────────────────────────────────── */

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RE_IMPORTO = /^\d+\.\d{2}$/
const RE_ISTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/
const RE_CF = /^[A-Z0-9]{11,16}$/
const RE_PROGRESSIVO = /^[AF]\d{8}$/
const TENTATIVI_TAG = 8

/** Una voce che non passa le validazioni: nessuna istruzione viene composta. */
export class VoceNonValida extends Error {
  /** @param {string} campo @param {string} messaggio */
  constructor(campo, messaggio) {
    super(`voce non valida (${campo}): ${messaggio}`)
    this.name = 'VoceNonValida'
    this.campo = campo
  }
}

function tagCasuale() {
  return `t${randomBytes(6).toString('hex')}`
}

function richiedi(condizione, campo, messaggio) {
  if (!condizione) throw new VoceNonValida(campo, messaggio)
}

function uuidONull(valore, campo) {
  if (valore === null || valore === undefined) return null
  richiedi(typeof valore === 'string' && RE_UUID.test(valore), campo, 'atteso un uuid o null')
  return valore.toLowerCase()
}

function testoLibero(valore, campo) {
  richiedi(typeof valore === 'string' && valore.trim() !== '', campo, 'testo vuoto')
  richiedi(!valore.includes('\u0000'), campo, 'contiene il carattere NUL')
  return valore
}

/**
 * L'istruzione UNA, atomica e idempotente che registra un'orfana (D1 §9.3): una CTE
 * che controlla le precondizioni, inserisce la riga e scrive l'audit. Se una
 * precondizione manca non inserisce niente e restituisce `registrate = 0`.
 *
 * Precondizioni (tutte nella CTE `pre`, rilette nel momento della scrittura):
 *   · il pagamento soddisfa il predicato «partita non registrata» (passato dal modulo
 *     TS, fonte unica: qui non se ne scrive una copia) e ha QUEL nome file;
 *   · nessuna riga del pagamento a registro, in qualunque stato (solo orfane «pure»);
 *   · nessuna riga con la stessa (serie, anno, numero);
 *   · il vincolo per sede non c'è più (senza la migrazione, 0 righe e non un 23505);
 *   · solo se la tabella esiste (`giornaleEsiste`): nessun invio della coda per il
 *     pagamento. Senza la tabella la clausola non si scrive, perché fallirebbe (42P01).
 *
 * Le colonne sono quelle di D1 §9.2: `creato_da` NULL = «sistema» (C0.4); nell'audit
 * `utente_id` NULL e chi aveva emesso va in `emessa_da`, dal log. `modalita_emissione`
 * è `ordinaria`: la riga passa anche il trigger della visibilità di una sede attiva.
 * Nessun UPDATE di `pagamenti`: `fattura_stato` lo porta avanti la sync.
 *
 * I testi liberi (causale, nome, cognome, XML) vanno fra dollari con un tag CASUALE,
 * controllato contro ciascun testo: se un testo contiene `$` + tag (anche senza il `$`
 * finale, che può arrivare dal delimitatore di chiusura) la stringa si chiuderebbe a metà. Ritorna anche `sqlMascherato`, la stessa istruzione con i dati
 * personali mascherati, per la stampa «SCRIVO i/N:».
 *
 * @param {{
 *   pagamento_id: string, scuola_id: string, file: string, sezionale: string, anno: number,
 *   numero: number, progressivo_invio: string, causale: string, importo: string,
 *   intestatario: { nome: string, cognome: string, codice_fiscale: string }, xml: string,
 *   istante: string, quota_adult_id?: string | null, parent_registry_id?: string | null,
 *   bollo_virtuale: boolean, app_log_id?: string | null, emessa_da?: string | null,
 *   vincolo?: string | null,
 * }} voce
 * @param {{ predicatoSql: string, giornaleEsiste: boolean, anagrafica?: { nome?: string, cognome?: string } | null,
 *   generaTag?: () => string }} opzioni
 * @returns {{ sql: string, sqlMascherato: string, tag: string }}
 */
export function componiInsert(voce, { predicatoSql, giornaleEsiste, anagrafica = null, generaTag = tagCasuale } = {}) {
  richiedi(typeof predicatoSql === 'string' && /\bp\.fattura_stato\b/.test(predicatoSql), 'predicatoSql',
    'serve PREDICATO_SQL_PARTITA_NON_REGISTRATA del modulo TS')
  richiedi(typeof giornaleEsiste === 'boolean', 'giornaleEsiste', 'va detto se fatture_coda_invii esiste')
  richiedi(voce && typeof voce === 'object', 'voce', 'assente')

  const pagamento = uuidONull(voce.pagamento_id, 'pagamento_id')
  const scuola = uuidONull(voce.scuola_id, 'scuola_id')
  richiedi(pagamento !== null, 'pagamento_id', 'obbligatorio')
  richiedi(scuola !== null, 'scuola_id', 'obbligatorio')
  const quota = uuidONull(voce.quota_adult_id, 'quota_adult_id')
  const registry = uuidONull(voce.parent_registry_id, 'parent_registry_id')
  const appLog = uuidONull(voce.app_log_id, 'app_log_id')
  const emessaDa = uuidONull(voce.emessa_da, 'emessa_da')

  richiedi(SERIE.includes(voce.sezionale), 'sezionale', 'attesa Asilo o FPR')
  richiedi(Number.isSafeInteger(voce.anno) && voce.anno >= 2000 && voce.anno <= 2099, 'anno', 'atteso un intero di quattro cifre')
  richiedi(Number.isSafeInteger(voce.numero) && voce.numero > 0 && voce.numero < 1e9, 'numero', 'atteso un intero positivo')
  richiedi(typeof voce.importo === 'string' && RE_IMPORTO.test(voce.importo), 'importo', 'atteso ^\\d+\\.\\d{2}$')
  richiedi(typeof voce.istante === 'string' && RE_ISTANTE.test(voce.istante) && !Number.isNaN(Date.parse(voce.istante)),
    'istante', 'atteso un istante ISO con fuso')
  richiedi(typeof voce.file === 'string' && RE_NOME_FILE_ARUBA.test(voce.file), 'file', 'nome file Aruba non valido')
  richiedi(typeof voce.progressivo_invio === 'string' && RE_PROGRESSIVO.test(voce.progressivo_invio),
    'progressivo_invio', 'atteso ^[AF]\\d{8}$')
  richiedi(typeof voce.bollo_virtuale === 'boolean', 'bollo_virtuale', 'atteso un booleano')
  richiedi(voce.vincolo == null || VINCOLI_REGISTRO.includes(voce.vincolo), 'vincolo', 'vincolo sconosciuto')

  const intestatario = voce.intestatario ?? {}
  richiedi(typeof intestatario.codice_fiscale === 'string' && RE_CF.test(intestatario.codice_fiscale),
    'codice_fiscale', 'atteso ^[A-Z0-9]{11,16}$')
  const testi = {
    causale: testoLibero(voce.causale, 'causale'),
    nome: testoLibero(intestatario.nome, 'nome'),
    cognome: testoLibero(intestatario.cognome, 'cognome'),
    xml: testoLibero(voce.xml, 'xml'),
  }

  let tag = null
  for (let i = 0; i < TENTATIVI_TAG && tag === null; i += 1) {
    const candidato = generaTag()
    richiedi(typeof candidato === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidato), 'tag', 'tag dollaro non valido')
    // Si scarta se un testo contiene `$` + candidato, non solo il delimitatore completo:
    // un testo che FINISCE con `$candidato`, più il `$` di chiusura, forma `$candidato$`
    // e chiude la stringa in anticipo, troncandola senza errore.
    const prefisso = `$${candidato}`
    if (!Object.values(testi).some((t) => t.includes(prefisso))) tag = candidato
  }
  richiedi(tag !== null, 'tag', `nessun tag libero in ${TENTATIVI_TAG} tentativi: un testo contiene i delimitatori`)

  const d = `$${tag}$`
  const lit = (v) => (v === null ? 'NULL' : `'${v}'`)
  const mascherati = maschera({ intestatario, causale: testi.causale, xml: testi.xml }, anagrafica)

  const componi = (t) => {
    const clausolaGiornale = giornaleEsiste
      ? `\n    AND NOT EXISTS (SELECT 1 FROM public.fatture_coda_invii i WHERE i.pagamento_id = p.id)`
      : ''
    return (
      `WITH pre AS (\n` +
      `  SELECT p.id FROM public.pagamenti p\n` +
      `  WHERE p.id = '${pagamento}'::uuid AND p.fattura_aruba_id = '${voce.file}'\n` +
      `    AND (${predicatoSql})\n` +
      `    AND NOT EXISTS (SELECT 1 FROM public.fatture_emesse f WHERE f.pagamento_id = p.id)\n` +
      `    AND NOT EXISTS (SELECT 1 FROM public.fatture_emesse f WHERE f.sezionale = '${voce.sezionale}' AND f.anno = ${voce.anno} AND f.numero = ${voce.numero})\n` +
      `    AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.fatture_emesse'::regclass AND c.conname = '${VINCOLO_NUMERO_PER_SEDE}')` +
      clausolaGiornale +
      `\n), ins AS (\n` +
      `  INSERT INTO public.fatture_emesse (pagamento_id, scuola_id, numero, sezionale, anno, progressivo_invio, causale, importo,\n` +
      `    intestatario, xml_inviato, aruba_filename, sdi_stato, sdi_stato_label, inviata_il, creato_da, creato_il,\n` +
      `    quota_adult_id, quota_label, parent_registry_id, modalita_emissione, bollo_virtuale)\n` +
      `  SELECT '${pagamento}'::uuid, '${scuola}'::uuid, ${voce.numero}, '${voce.sezionale}', ${voce.anno}, '${voce.progressivo_invio}', ${d}${t.causale}${d}, ${voce.importo},\n` +
      `    jsonb_build_object('nome', ${d}${t.nome}${d}, 'cognome', ${d}${t.cognome}${d}, 'codice_fiscale', '${t.codice_fiscale}'),\n` +
      `    ${d}${t.xml}${d}, '${voce.file}', 1, 'Presa in carico', '${voce.istante}'::timestamptz, NULL, '${voce.istante}'::timestamptz,\n` +
      `    ${quota === null ? 'NULL' : `'${quota}'::uuid`}, NULL, ${registry === null ? 'NULL' : `'${registry}'::uuid`}, 'ordinaria', ${voce.bollo_virtuale}\n` +
      `  FROM pre\n` +
      `  RETURNING id, pagamento_id, sezionale, anno, numero\n` +
      `), audit AS (\n` +
      `  INSERT INTO public.registro_modifiche (utente_id, azione, tabella_interessata, record_id, vecchio_valore, nuovo_valore)\n` +
      `  SELECT NULL, 'registrazione_fattura_orfana', 'fatture_emesse', ins.id,\n` +
      `    jsonb_build_object('pagamento_id', ins.pagamento_id, 'riga_a_registro', false),\n` +
      `    jsonb_build_object('pagamento_id', ins.pagamento_id, 'sezionale', ins.sezionale, 'anno', ins.anno, 'numero', ins.numero,\n` +
      `      'aruba_filename', '${voce.file}', 'app_log_id', ${lit(appLog)}::text, 'emessa_da', ${lit(emessaDa)}::text,\n` +
      `      'causa', ${lit(voce.vincolo ?? null)}::text, 'strumento', 'scripts/fatture-orfane.mjs')\n` +
      `  FROM ins RETURNING id\n` +
      `)\n` +
      `SELECT (SELECT count(*) FROM ins)::int AS registrate, (SELECT count(*) FROM audit)::int AS audit,\n` +
      `  (SELECT id FROM ins) AS fattura_id, (SELECT id FROM audit) AS audit_id;\n`
    )
  }

  const sql = componi({ ...testi, codice_fiscale: intestatario.codice_fiscale })
  const sqlMascherato = componi({
    causale: mascherati.causale,
    nome: mascherati.nome,
    cognome: mascherati.cognome,
    xml: mascherati.xml,
    codice_fiscale: mascherati.codice_fiscale,
  })
  return { sql, sqlMascherato, tag }
}
