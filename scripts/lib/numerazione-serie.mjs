/**
 * Funzioni PURE dell'indagine sulla numerazione delle serie fiscali (D1 §3.3-§4).
 *
 * ─── PERCHÉ UN FILE A PARTE ─────────────────────────────────────────────────
 * `scripts/numerazione-serie.mjs` legge DB, Aruba, git e gh: tutto ciò che si può
 * sbagliare senza toccare la rete sta qui, e qui si prova. Il modulo non importa
 * nulla — né gli altri moduli di `scripts/lib/`, né `src/` — e non lancia processi:
 * restituisce dati, testi e ARRAY di argomenti che lo script esegue.
 *
 * ─── COSA C'È ───────────────────────────────────────────────────────────────
 *   · il parser delle etichette («Asilo 2327/2026», «FPR 1946/26»), copia di
 *     `numeroSezionaleDaEtichetta` di `src/lib/aruba/client.ts` con test di parità:
 *     `client.ts` si porta dietro logger e `next`, e uno script non li carica;
 *   · classifica, buchi, allocazioni, attribuzione dei salti (J0-J4), doppioni;
 *   · l'obiettivo del contatore coi suoi rifiuti e l'istruzione a
 *     confronto-e-scambio di D1 §4.3; il prospetto per il commercialista;
 *   · la P7: `argomentiGit`, `deployAttivoAl`, `verdettoP7`, e `provaP7`, che ne
 *     compone i passi con un git INIETTATO (lo script gli passa `execFileSync`).
 *
 * ─── LA P7 CONFRONTA CON `rif`, MAI CON `HEAD` (D1 §0.2 a) ──────────────────
 * Sul branch della correzione i percorsi della numerazione li modifica la PR-D1
 * stessa (`emissione.ts`, `fattura/route.ts`): un confronto con `HEAD` direbbe
 * «codice diverso» anche se in produzione girava esattamente `rif`. Il riferimento
 * è il deploy di produzione attivo al momento dell'indagine, antenato di `HEAD`.
 * E la prova vale solo col CONTROLLO POSITIVO a 1: un `git diff` che risponde 0 su
 * qualunque coppia (per esempio con i percorsi uniti in una stringa sola, che git
 * legge come UN percorso inesistente) è una prova cieca, non una prova.
 *
 * Nessun dato personale entra o esce di qui: numeri, serie, nomi file, sha e istanti.
 */

/** Le due serie fiscali (`src/lib/fatturazione/sezionale.ts`). */
export const SERIE = Object.freeze(['Asilo', 'FPR'])

/**
 * I percorsi della numerazione (array P di D1 §2.6). Restano un ARRAY fino a git:
 * uniti in una stringa diventerebbero un percorso solo, inesistente, e ogni diff
 * risponderebbe 0.
 */
export const PERCORSI_NUMERAZIONE = Object.freeze([
  'src/lib/aruba',
  'src/lib/fatturazione',
  'src/app/api/pagamenti/fattura',
  'src/lib/pagamenti/lotto-fatture.ts',
  'src/lib/pagamenti/fatturazione-riga.ts',
  'supabase/migrations/20260809235620_fatture_numerazione_sezionale.sql',
])

/* ────────────────────────────────────────────────────────────────────────────
 * Parser delle etichette
 * ──────────────────────────────────────────────────────────────────────────── */

/** Stessa regex di `FORMA_NUMERO_SEZIONALE` in `client.ts`. La parità la prova il test. */
const FORMA_NUMERO_SEZIONALE = /^([A-Za-z]+) (\d{1,9}) ?\/ ?(\d{2}|\d{4})$/

/** Quanto di un'etichetta illeggibile si porta nel prospetto: la forma, non il contenuto. */
const FORMA_MAX = 40

/** @param {unknown} etichetta */
function normalizza(etichetta) {
  return String(etichetta).replace(/\s+/g, ' ').trim()
}

/**
 * Copia di `numeroSezionaleDaEtichetta` (client.ts): il progressivo, se e solo se
 * l'etichetta è di QUESTA serie e di QUEST'ANNO; altrimenti `null`, mai zero.
 *
 * @param {unknown} etichetta
 * @param {string} sezionale
 * @param {number} anno
 * @returns {number | null}
 */
export function numeroSezionaleDaEtichetta(etichetta, sezionale, anno) {
  if (etichetta == null) return null
  const pezzi = FORMA_NUMERO_SEZIONALE.exec(normalizza(etichetta))
  if (!pezzi) return null
  if (pezzi[1].toUpperCase() !== String(sezionale).toUpperCase()) return null
  const annoScritto = pezzi[3]
  const annoAtteso = annoScritto.length === 2 ? String(anno % 100).padStart(2, '0') : String(anno)
  if (annoScritto !== annoAtteso) return null
  const numero = Number(pezzi[2])
  return Number.isInteger(numero) && numero > 0 ? numero : null
}

/**
 * La FORMA di un'etichetta illeggibile: cifre → 9, lettere → X. Serve a capire che
 * cosa il parser non riconosce senza stampare il contenuto.
 *
 * @param {unknown} etichetta
 * @returns {string}
 */
export function formaEtichetta(etichetta) {
  if (etichetta == null) return '(vuota)'
  return normalizza(etichetta).replace(/\d/g, '9').replace(/[A-Za-zÀ-ÿ]/g, 'X').slice(0, FORMA_MAX)
}

/**
 * Legge un'etichetta per QUALUNQUE serie nota e anno.
 *   · `{ tipo: 'serie', serie, numero, anno }` — serie nota, numero valido;
 *   · `{ tipo: 'altra-serie', forma }` — forma giusta, lettere non di una serie nostra;
 *   · `{ tipo: 'illeggibile', forma }` — il parser non la riconosce.
 *
 * @param {unknown} etichetta
 * @returns {{ tipo: 'serie', serie: string, numero: number, anno: number }
 *   | { tipo: 'altra-serie' | 'illeggibile', forma: string }}
 */
export function leggiEtichetta(etichetta) {
  const pezzi = etichetta == null ? null : FORMA_NUMERO_SEZIONALE.exec(normalizza(etichetta))
  if (!pezzi) return { tipo: 'illeggibile', forma: formaEtichetta(etichetta) }
  const serie = SERIE.find((s) => s.toUpperCase() === pezzi[1].toUpperCase())
  if (!serie) return { tipo: 'altra-serie', forma: formaEtichetta(etichetta) }
  const annoScritto = Number(pezzi[3])
  const anno = pezzi[3].length === 2 ? 2000 + annoScritto : annoScritto
  const numero = numeroSezionaleDaEtichetta(etichetta, serie, anno)
  if (numero === null) return { tipo: 'illeggibile', forma: formaEtichetta(etichetta) }
  return { tipo: 'serie', serie, numero, anno }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Classificazione, intervalli, buchi, doppioni
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {{ filename: string, creato: string, etichetta: unknown }} DocumentoAruba
 * @typedef {{ aruba_filename: string | null }} RigaConFile
 * @typedef {{ fattura_aruba_id: string | null }} Orfana
 * @typedef {{ filename: string, creato: string, serie: string, numero: number,
 *   origine: 'app' | 'orfana' | 'fuori-app', fonte: 'registro' | 'giornale' | null }} DocumentoClassificato
 */

/** @param {string | null | undefined} f */
function haFile(f) {
  return typeof f === 'string' && f.trim() !== ''
}

/**
 * Classifica i documenti di Aruba di un anno (D1 §3.3):
 *   · `app`: il nome file è a registro (`fonte: 'registro'`) o nel giornale della
 *     coda (`fonte: 'giornale'`, solo se la tabella esiste: `giornale` null = assente);
 *   · `orfana`: il nome file è il `fattura_aruba_id` di un'orfana;
 *   · `fuori-app`: tutto il resto.
 * Le etichette di un altro anno, di un'altra serie o illeggibili non si classificano:
 * si contano, e delle illeggibili si tiene la sola forma. Un filename ripetuto
 * (sovrapposizione fra pagine) conta una volta.
 *
 * @param {{ documenti: DocumentoAruba[], registro: RigaConFile[], giornale: RigaConFile[] | null,
 *   orfane: Orfana[], anno: number }} dati
 */
export function classifica({ documenti, registro, giornale, orfane, anno }) {
  const aRegistro = new Set(registro.map((r) => r.aruba_filename).filter(haFile))
  const nelGiornale = new Set((giornale ?? []).map((r) => r.aruba_filename).filter(haFile))
  const diOrfane = new Set(orfane.map((o) => o.fattura_aruba_id).filter(haFile))

  /** @type {DocumentoClassificato[]} */
  const classificati = []
  /** @type {Map<string, number>} */
  const formeIllegibili = new Map()
  let illeggibili = 0
  let altraSerie = 0
  let altroAnno = 0
  const visti = new Set()

  for (const d of documenti) {
    if (visti.has(d.filename)) continue
    visti.add(d.filename)
    const letta = leggiEtichetta(d.etichetta)
    if (letta.tipo === 'illeggibile') {
      illeggibili++
      formeIllegibili.set(letta.forma, (formeIllegibili.get(letta.forma) ?? 0) + 1)
      continue
    }
    if (letta.tipo === 'altra-serie') {
      altraSerie++
      continue
    }
    if (letta.anno !== anno) {
      altroAnno++
      continue
    }
    /** @type {DocumentoClassificato['origine']} */
    let origine = 'fuori-app'
    /** @type {DocumentoClassificato['fonte']} */
    let fonte = null
    if (aRegistro.has(d.filename)) {
      origine = 'app'
      fonte = 'registro'
    } else if (nelGiornale.has(d.filename)) {
      origine = 'app'
      fonte = 'giornale'
    } else if (diOrfane.has(d.filename)) {
      origine = 'orfana'
    }
    classificati.push({ filename: d.filename, creato: d.creato, serie: letta.serie, numero: letta.numero, origine, fonte })
  }

  return {
    classificati,
    illeggibili,
    formeIllegibili: [...formeIllegibili.entries()].map(([forma, casi]) => ({ forma, casi })),
    altraSerie,
    altroAnno,
  }
}

/**
 * Comprime un insieme di numeri in intervalli contigui ordinati.
 *
 * @param {Iterable<number>} numeri
 * @returns {{ da: number, a: number }[]}
 */
export function intervalli(numeri) {
  const ordinati = [...new Set(numeri)].filter((n) => Number.isInteger(n)).sort((x, y) => x - y)
  /** @type {{ da: number, a: number }[]} */
  const out = []
  for (const n of ordinati) {
    const ultimo = out[out.length - 1]
    if (ultimo && n === ultimo.a + 1) ultimo.a = n
    else out.push({ da: n, a: n })
  }
  return out
}

/**
 * I numeri MAI usati fra il minimo e il massimo dei numeri usati, in intervalli.
 * Con `da` si parte da lì invece che dal minimo (per esempio da 1 a inizio anno).
 *
 * @param {Iterable<number>} numeri
 * @param {{ da?: number }} [opzioni]
 * @returns {{ da: number, a: number }[]}
 */
export function buchi(numeri, opzioni = {}) {
  const pieni = intervalli(numeri)
  if (pieni.length === 0) return []
  /** @type {{ da: number, a: number }[]} */
  const out = []
  let cursore = opzioni.da ?? pieni[0].da
  for (const p of pieni) {
    if (p.da > cursore) out.push({ da: cursore, a: p.da - 1 })
    cursore = Math.max(cursore, p.a + 1)
  }
  return out
}

/**
 * Doppioni su Aruba (H3): la stessa (serie, numero) su due documenti DIVERSI.
 * Lo stesso filename visto due volte non è un doppione.
 *
 * @param {{ filename: string, serie: string, numero: number }[]} documenti
 * @returns {{ serie: string, numero: number, filenames: string[] }[]}
 */
export function doppioni(documenti) {
  /** @type {Map<string, Set<string>>} */
  const perChiave = new Map()
  for (const d of documenti) {
    const chiave = `${d.serie}\u0000${d.numero}`
    const insieme = perChiave.get(chiave) ?? new Set()
    insieme.add(d.filename)
    perChiave.set(chiave, insieme)
  }
  /** @type {{ serie: string, numero: number, filenames: string[] }[]} */
  const out = []
  for (const [chiave, files] of perChiave) {
    if (files.size < 2) continue
    const [serie, numero] = chiave.split('\u0000')
    out.push({ serie, numero: Number(numero), filenames: [...files].sort() })
  }
  return out.sort((x, y) => x.serie.localeCompare(y.serie) || x.numero - y.numero)
}

/* ────────────────────────────────────────────────────────────────────────────
 * Allocazioni e attribuzione dei salti
 * ──────────────────────────────────────────────────────────────────────────── */

/** @param {string} iso */
function ms(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) throw new Error(`istante non leggibile: «${String(iso).slice(0, 40)}»`)
  return t
}

/**
 * Le allocazioni dell'app in ordine di tempo, ognuna col contatore che aveva prima.
 * Il contatore della serie sale SOLO con la RPC dell'app (`GREATEST(contatore,
 * pavimento) + 1`): prima di un'allocazione vale il massimo dei numeri che l'app aveva
 * già dato nella stessa serie (0 a inizio anno). Le orfane sono allocazioni dell'app:
 * vanno passate anche loro.
 *
 * @param {{ serie: string, numero: number, istante: string }[]} voci
 * @returns {{ serie: string, numero: number, istante: string, contatore_prima: number }[]}
 */
export function allocazioniConContatore(voci) {
  const ordinate = [...voci].sort((x, y) => ms(x.istante) - ms(y.istante) || x.numero - y.numero)
  /** @type {Map<string, number>} */
  const massimo = new Map()
  return ordinate.map((v) => {
    const prima = massimo.get(v.serie) ?? 0
    massimo.set(v.serie, Math.max(prima, v.numero))
    return { ...v, contatore_prima: prima }
  })
}

/**
 * Attribuzione dei salti (D1 §3.3 uscita 4). Per ogni allocazione con
 * `numero > contatore_prima + 1` la RPC ha preso il pavimento da Aruba: deve esistere
 * un documento FUORI APP numerato `numero − 1`, della stessa serie, creato PRIMA.
 * Esito «SPIEGATO da <serie> <n>/<anno>» oppure «SALTO NON SPIEGATO».
 *
 * @param {{ allocazioni: { serie: string, numero: number, istante: string, contatore_prima: number }[],
 *   fuoriApp: { filename: string, creato: string, serie: string, numero: number }[], anno: number }} dati
 */
export function attribuisciSalti({ allocazioni, fuoriApp, anno }) {
  return allocazioni
    .filter((a) => a.numero > a.contatore_prima + 1)
    .map((a) => {
      const quando = ms(a.istante)
      const doc = fuoriApp.find(
        (d) => d.serie === a.serie && d.numero === a.numero - 1 && ms(d.creato) < quando,
      )
      const spiegato = Boolean(doc)
      return {
        serie: a.serie,
        contatore_prima: a.contatore_prima,
        numero: a.numero,
        istante: a.istante,
        spiegato,
        spiegatoDa: doc ? { filename: doc.filename, numero: doc.numero, creato: doc.creato } : null,
        esito: doc ? `SPIEGATO da ${a.serie} ${doc.numero}/${anno}` : 'SALTO NON SPIEGATO',
      }
    })
}

/* ────────────────────────────────────────────────────────────────────────────
 * Contatore: obiettivo e istruzione a confronto-e-scambio (D1 §4)
 * ──────────────────────────────────────────────────────────────────────────── */

/** @param {unknown} n */
function interoNonNegativo(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

/**
 * L'obiettivo del contatore di una serie (D1 §4.1-§4.2): il massimo fra Aruba (di
 * qualunque origine), il registro e il giornale della coda se esiste
 * (`massimoGiornale: null` = tabella assente; se esiste conta ogni stato, anche
 * `bruciata`). Codici di rifiuto:
 *   · `dati-mancanti` — un massimo o il contatore non è un intero ≥ 0 (fail-closed);
 *   · `salti-non-spiegati`, `doppioni` — l'indagine non è chiusa;
 *   · `sotto-aruba`, `sotto-il-registro`, `sotto-il-giornale` — `--a` scende sotto un
 *     numero già consumato;
 *   · `diverso-dall-obiettivo` — `--a` non è l'obiettivo.
 * `scrivere` è vero solo senza rifiuti e con `contatore ≠ obiettivo`.
 *
 * @param {{ massimoAruba: number, massimoRegistro: number, massimoGiornale: number | null,
 *   contatore: number, richiesto?: number | null, saltiNonSpiegati?: number, doppioni?: number }} dati
 * @returns {{ obiettivo: number | null, rifiuti: string[], scrivere: boolean, scende: boolean }}
 */
export function obiettivoContatore({
  massimoAruba,
  massimoRegistro,
  massimoGiornale,
  contatore,
  richiesto = null,
  saltiNonSpiegati = 0,
  doppioni: quantiDoppioni = 0,
}) {
  const giornaleOk = massimoGiornale === null || interoNonNegativo(massimoGiornale)
  if (!interoNonNegativo(massimoAruba) || !interoNonNegativo(massimoRegistro) || !giornaleOk || !interoNonNegativo(contatore)) {
    return { obiettivo: null, rifiuti: ['dati-mancanti'], scrivere: false, scende: false }
  }
  const obiettivo = Math.max(massimoAruba, massimoRegistro, massimoGiornale ?? 0)
  /** @type {string[]} */
  const rifiuti = []
  if (saltiNonSpiegati > 0) rifiuti.push('salti-non-spiegati')
  if (quantiDoppioni > 0) rifiuti.push('doppioni')
  if (richiesto !== null) {
    if (!interoNonNegativo(richiesto)) rifiuti.push('dati-mancanti')
    else {
      if (richiesto < massimoAruba) rifiuti.push('sotto-aruba')
      if (richiesto < massimoRegistro) rifiuti.push('sotto-il-registro')
      if (massimoGiornale !== null && richiesto < massimoGiornale) rifiuti.push('sotto-il-giornale')
      if (richiesto !== obiettivo) rifiuti.push('diverso-dall-obiettivo')
    }
  }
  return {
    obiettivo,
    rifiuti,
    scrivere: rifiuti.length === 0 && contatore !== obiettivo,
    scende: obiettivo < contatore,
  }
}

/**
 * L'istruzione di D1 §4.3, a confronto-e-scambio: l'UPDATE vale solo se il contatore
 * è ancora quello LETTO (`ultimo_numero = <letto>`) e se nessuna riga del registro — né
 * del giornale, quando la tabella esiste — sta sopra l'obiettivo. 0 righe aggiornate =
 * qualcuno ha allocato nel frattempo: si rilancia. L'audit ha `utente_id` NULL (sistema).
 * Ogni valore è validato: la serie da lista bianca, i numeri interi.
 *
 * @param {{ serie: string, anno: number, letto: number, obiettivo: number, massimoAruba: number,
 *   massimoRegistro: number, massimoGiornale: number | null, giornaleEsiste: boolean }} dati
 * @returns {string}
 */
export function componiAllineamento({ serie, anno, letto, obiettivo, massimoAruba, massimoRegistro, massimoGiornale, giornaleEsiste }) {
  if (!SERIE.includes(serie)) throw new Error(`serie non ammessa: «${String(serie).slice(0, 20)}»`)
  if (!Number.isInteger(anno) || anno < 2000 || anno > 2999) throw new Error('anno non valido')
  for (const [nome, v] of /** @type {[string, unknown][]} */ ([
    ['letto', letto],
    ['obiettivo', obiettivo],
    ['massimoAruba', massimoAruba],
    ['massimoRegistro', massimoRegistro],
  ])) {
    if (!interoNonNegativo(v)) throw new Error(`${nome} non è un intero ≥ 0`)
  }
  if (typeof giornaleEsiste !== 'boolean') throw new Error('giornaleEsiste deve essere un booleano')
  if (giornaleEsiste ? !interoNonNegativo(massimoGiornale) : massimoGiornale !== null) {
    throw new Error('massimoGiornale incoerente con giornaleEsiste')
  }
  const g = giornaleEsiste ? String(massimoGiornale) : 'null'
  const clausolaGiornale = giornaleEsiste
    ? `
     AND NOT EXISTS (SELECT 1 FROM public.fatture_coda_invii i
                      WHERE i.sezionale = '${serie}' AND i.anno = ${anno} AND i.numero > ${obiettivo})`
    : ''
  return `WITH upd AS (
  UPDATE public.fatture_numerazione_sezionale
     SET ultimo_numero = ${obiettivo}, aggiornato_il = now()
   WHERE sezionale = '${serie}' AND anno = ${anno} AND ultimo_numero = ${letto}
     AND NOT EXISTS (SELECT 1 FROM public.fatture_emesse f
                      WHERE f.sezionale = '${serie}' AND f.anno = ${anno} AND f.numero > ${obiettivo})${clausolaGiornale}
  RETURNING ultimo_numero
), audit AS (
  INSERT INTO public.registro_modifiche (utente_id, azione, tabella_interessata, record_id, vecchio_valore, nuovo_valore)
  SELECT NULL, 'allineamento_contatore_fatture', 'fatture_numerazione_sezionale', NULL,
         jsonb_build_object('sezionale','${serie}','anno',${anno},'ultimo_numero',${letto}),
         jsonb_build_object('sezionale','${serie}','anno',${anno},'ultimo_numero',${obiettivo},
                            'massimo_aruba',${massimoAruba},'massimo_registro',${massimoRegistro},'massimo_giornale',${g},
                            'strumento','scripts/numerazione-serie.mjs')
  FROM upd RETURNING id
)
SELECT (SELECT count(*) FROM upd) AS aggiornate, (SELECT id FROM audit) AS audit_id;`
}

/**
 * Controlla che un'istruzione di allineamento sia davvero a confronto-e-scambio.
 * Restituisce i pezzi MANCANTI (vuoto = ok): lo script lo esegue prima di stampare
 * «SCRIVO:», e il test lo usa per il controllo negativo.
 *
 * @param {string} sql
 * @param {{ serie: string, anno: number, letto: number, obiettivo: number, giornaleEsiste: boolean }} atteso
 * @returns {string[]}
 */
export function verificaConfrontoEScambio(sql, { serie, anno, letto, obiettivo, giornaleEsiste }) {
  const testo = sql.replace(/\s+/g, ' ')
  /** @type {string[]} */
  const mancanti = []
  if (!testo.includes(`WHERE sezionale = '${serie}' AND anno = ${anno} AND ultimo_numero = ${letto}`)) mancanti.push('confronto-letto')
  if (!testo.includes(`SET ultimo_numero = ${obiettivo},`)) mancanti.push('obiettivo')
  if (!testo.includes(`f.sezionale = '${serie}' AND f.anno = ${anno} AND f.numero > ${obiettivo}`)) mancanti.push('registro-sopra')
  const haGiornale = testo.includes(`i.sezionale = '${serie}' AND i.anno = ${anno} AND i.numero > ${obiettivo}`)
  if (giornaleEsiste && !haGiornale) mancanti.push('giornale-sopra')
  if (!giornaleEsiste && testo.includes('fatture_coda_invii')) mancanti.push('giornale-inesistente')
  if (!/INSERT INTO public\.registro_modifiche/.test(testo) || !/FROM upd RETURNING id/.test(testo)) mancanti.push('audit')
  return mancanti
}

/* ────────────────────────────────────────────────────────────────────────────
 * Prospetto per il commercialista (D1 §3.6): solo numeri e date
 * ──────────────────────────────────────────────────────────────────────────── */

/** @param {{ da: number, a: number }} i */
function intervallo(i) {
  return i.da === i.a ? String(i.da) : `${i.da}-${i.a}`
}

/**
 * Per serie: intervalli dell'app (orfane comprese), numeri fuori app con la data,
 * numeri mai usati con l'istante del salto che li ha scavalcati. Niente nomi, niente
 * importi, niente file: è il testo che va in `<out>/prospetto-numerazione-<anno>.txt`.
 *
 * @param {{ anno: number, classificati: { serie: string, numero: number, creato: string,
 *   origine: 'app' | 'orfana' | 'fuori-app' }[],
 *   salti: { serie: string, contatore_prima: number, numero: number, istante: string }[] }} dati
 * @returns {string}
 */
export function prospetto({ anno, classificati, salti }) {
  const righe = [`Prospetto della numerazione ${anno} (solo numeri e date)`]
  for (const serie of SERIE) {
    const della = classificati.filter((d) => d.serie === serie)
    const app = della.filter((d) => d.origine !== 'fuori-app').map((d) => d.numero)
    const fuori = della.filter((d) => d.origine === 'fuori-app').sort((x, y) => x.numero - y.numero)
    const vuoti = buchi(della.map((d) => d.numero), { da: 1 })
    righe.push('', `Serie ${serie}`)
    righe.push(`  numeri emessi dall'app: ${intervalli(app).map(intervallo).join(', ') || 'nessuno'}`)
    righe.push('  numeri emessi fuori dall\'app:')
    if (fuori.length === 0) righe.push('    nessuno')
    for (const d of fuori) righe.push(`    ${d.numero} del ${d.creato.slice(0, 10)}`)
    righe.push('  numeri mai usati:')
    if (vuoti.length === 0) righe.push('    nessuno')
    for (const b of vuoti) {
      const salto = salti.find((s) => s.serie === serie && s.contatore_prima < b.da && b.a < s.numero)
      righe.push(`    ${intervallo(b)}${salto ? ` (salto del ${salto.istante})` : ''}`)
    }
  }
  return `${righe.join('\n')}\n`
}

/* ────────────────────────────────────────────────────────────────────────────
 * P7: codice e deploy attivi a ogni salto, contro `rif`
 * ──────────────────────────────────────────────────────────────────────────── */

const SHA = /^[0-9a-f]{7,40}$/i

/** @param {unknown} ref */
function eHead(ref) {
  return typeof ref === 'string' && /^(HEAD|@)/i.test(ref.trim())
}

/**
 * @param {unknown} ref
 * @param {string} nome
 */
function sha(ref, nome) {
  if (eHead(ref)) throw new Error(`${nome}: HEAD non è ammesso, il riferimento è rif (D1 §0.2 a)`)
  if (typeof ref !== 'string' || !SHA.test(ref)) throw new Error(`${nome}: non è uno sha`)
  return ref
}

/** @param {unknown} percorsi */
function percorsiValidi(percorsi) {
  if (!Array.isArray(percorsi) || percorsi.length === 0) throw new Error('percorsi: serve un array non vuoto')
  for (const p of percorsi) {
    if (typeof p !== 'string' || p === '' || p.startsWith('-')) throw new Error('percorsi: voce non valida')
  }
  return /** @type {string[]} */ (percorsi)
}

/**
 * Gli argomenti di git per la P7, SEMPRE come array (mai una stringa da dare a una
 * shell). I riferimenti sono sha; `HEAD` compare solo in `antenato`, come secondo
 * termine di `merge-base --is-ancestor`, e mai in un confronto.
 *
 *   · `esiste`            → cat-file -e <rif>^{commit}
 *   · `antenato`          → merge-base --is-ancestor <rif> HEAD
 *   · `ultimoCommit`      → log -1 --format=%h %cI <rif> -- …P
 *   · `diff`              → diff --quiet <da> <rif> -- …P
 *   · `controlloPositivo` → diff --quiet <ultimoCommit>~1 <rif> -- …P
 *
 * @param {'esiste' | 'antenato' | 'ultimoCommit' | 'diff' | 'controlloPositivo'} tipo
 * @param {{ rif: string, da?: string, ultimoCommit?: string, percorsi?: readonly string[] }} opzioni
 * @returns {string[]}
 */
export function argomentiGit(tipo, { rif, da, ultimoCommit, percorsi = PERCORSI_NUMERAZIONE }) {
  const r = sha(rif, 'rif')
  switch (tipo) {
    case 'esiste':
      return ['cat-file', '-e', `${r}^{commit}`]
    case 'antenato':
      return ['merge-base', '--is-ancestor', r, 'HEAD']
    case 'ultimoCommit':
      return ['log', '-1', '--format=%h %cI', r, '--', ...percorsiValidi(percorsi)]
    case 'diff':
      return ['diff', '--quiet', sha(da, 'da'), r, '--', ...percorsiValidi(percorsi)]
    case 'controlloPositivo':
      return ['diff', '--quiet', `${sha(ultimoCommit, 'ultimoCommit')}~1`, r, '--', ...percorsiValidi(percorsi)]
    default:
      throw new Error(`argomentiGit: tipo sconosciuto «${String(tipo)}»`)
  }
}

/**
 * Lo sha del deploy di produzione attivo a un istante: l'ultimo `success` non
 * posteriore. Le voci con `istante` nullo (nessuno status `success`) o con un
 * `ambiente` diverso da production (maiuscole comprese: GitHub scrive sia
 * «production» sia «Production») non contano. `null` se nessun deploy lo precede.
 *
 * @param {{ sha: string, istante: string | null, ambiente?: string }[]} deploys
 * @param {string} istante
 * @returns {string | null}
 */
export function deployAttivoAl(deploys, istante) {
  const t = ms(istante)
  let migliore = null
  let tMigliore = -Infinity
  for (const d of deploys) {
    if (d.istante == null) continue
    if (d.ambiente !== undefined && !/^production$/i.test(d.ambiente)) continue
    const td = ms(d.istante)
    if (td <= t && td > tMigliore) {
      migliore = d.sha
      tMigliore = td
    }
  }
  return migliore
}

/**
 * Il verdetto della P7 (D1 §3.3-§3.4). Vero solo se:
 *   · `rif` è uno sha e NON è `HEAD` (§0.2 a) — altrimenti falso, `confronto-con-head`;
 *   · `rif` è antenato di `HEAD` (`antenato === 0`) — altrimenti USCITA 1 (guardia d'uso);
 *   · `git log -1 rif -- P` non è vuoto;
 *   · il controllo positivo vale ESATTAMENTE 1: con 0 la prova è cieca, e un valore
 *     assente vale come prova cieca (il controllo è obbligatorio);
 *   · per ogni salto il deploy attivo è noto e il suo `git diff --quiet <deploy> rif -- P`
 *     vale 0 (`diff` è una mappa sha → codice d'uscita; un codice assente è falso).
 * Uscite: 0 vero, 1 `rif` non antenato, 2 falso.
 *
 * @param {{ salti: { istante: string }[], deploys: { sha: string, istante: string | null, ambiente?: string }[],
 *   rif: string, antenato: number, diff: Record<string, number>, controlloPositivo: number | null | undefined,
 *   ultimoCommit: string | null | undefined }} dati
 */
export function verdettoP7({ salti, deploys, rif, antenato, diff, controlloPositivo, ultimoCommit }) {
  /** @type {string[]} */
  const motivi = []
  /** @type {{ istante: string, deploy: string | null, diff: number | null }[]} */
  const perSalto = []

  if (eHead(rif)) {
    return { vero: false, uscita: 2, motivi: ['confronto-con-head'], perSalto }
  }
  if (typeof rif !== 'string' || !SHA.test(rif)) {
    return { vero: false, uscita: 2, motivi: ['rif-non-valido'], perSalto }
  }
  if (antenato !== 0) {
    return { vero: false, uscita: 1, motivi: ['rif-non-antenato'], perSalto }
  }
  if (typeof ultimoCommit !== 'string' || ultimoCommit.trim() === '') motivi.push('ultimo-commit-vuoto')
  if (controlloPositivo !== 1) motivi.push('prova-cieca')
  if (salti.length === 0) motivi.push('nessun-salto')

  for (const s of salti) {
    const deploy = deployAttivoAl(deploys, s.istante)
    const codice = deploy !== null && Object.prototype.hasOwnProperty.call(diff, deploy) ? diff[deploy] : null
    perSalto.push({ istante: s.istante, deploy, diff: codice })
    if (deploy === null) motivi.push('deploy-sconosciuto')
    else if (codice === null) motivi.push('diff-mancante')
    else if (codice !== 0) motivi.push('diff-diverso')
  }

  const unici = [...new Set(motivi)]
  return { vero: unici.length === 0, uscita: unici.length === 0 ? 0 : 2, motivi: unici, perSalto }
}

/**
 * I passi 2-5 della P7 automatica (D1 §3.3), con git INIETTATO: `git(args)` riceve
 * l'array di `argomentiGit` e restituisce `{ codice, stdout }` (lo script lo fa con
 * `execFileSync('git', args)`, mai con una shell). Il modulo resta puro: nessun
 * processo parte da qui.
 *   2. `rif = deployAttivoAl(deploys, adesso)`; `rif` deve esistere ed essere antenato di HEAD;
 *   3. `git log -1 rif -- P` → `ultimoCommit`, non vuoto;
 *   4. per ogni salto, diff fra il deploy attivo allora e `rif`;
 *   5. controllo positivo `<ultimoCommit>~1` contro `rif`, atteso 1.
 *
 * @param {{ git: (args: string[]) => { codice: number, stdout?: string },
 *   deploys: { sha: string, istante: string | null, ambiente?: string }[],
 *   salti: { istante: string }[], adesso: string, percorsi?: readonly string[] }} dati
 */
export function provaP7({ git, deploys, salti, adesso, percorsi = PERCORSI_NUMERAZIONE }) {
  const rif = deployAttivoAl(deploys, adesso)
  if (rif === null) {
    return { vero: false, uscita: 1, motivi: ['rif-sconosciuto'], perSalto: [], rif: null, ultimoCommit: null }
  }
  if (git(argomentiGit('esiste', { rif })).codice !== 0) {
    return { vero: false, uscita: 1, motivi: ['rif-assente'], perSalto: [], rif, ultimoCommit: null }
  }
  const antenato = git(argomentiGit('antenato', { rif })).codice
  if (antenato !== 0) {
    return { ...verdettoP7({ salti, deploys, rif, antenato, diff: {}, controlloPositivo: null, ultimoCommit: null }), rif, ultimoCommit: null }
  }
  const ultimo = String(git(argomentiGit('ultimoCommit', { rif, percorsi })).stdout ?? '').trim()
  const shaUltimo = ultimo.split(' ')[0]
  const controlloPositivo = SHA.test(shaUltimo)
    ? git(argomentiGit('controlloPositivo', { rif, ultimoCommit: shaUltimo, percorsi })).codice
    : null
  /** @type {Record<string, number>} */
  const diff = {}
  for (const s of salti) {
    const deploy = deployAttivoAl(deploys, s.istante)
    if (deploy !== null && !(deploy in diff)) diff[deploy] = git(argomentiGit('diff', { rif, da: deploy, percorsi })).codice
  }
  return { ...verdettoP7({ salti, deploys, rif, antenato, diff, controlloPositivo, ultimoCommit: ultimo }), rif, ultimoCommit: ultimo }
}
