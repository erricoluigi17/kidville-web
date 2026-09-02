/**
 * Lettura dell'export «Esportazione personalizzabile» di Argo Alunni Web.
 *
 * ─── PERCHÉ STA QUI E NON DENTRO LO SCRIPT ──────────────────────────────────
 * Queste sono le uniche regole del lavoro che possono sbagliare in SILENZIO:
 * decidono quale adulto è una persona nuova e quale è la stessa persona scritta
 * due volte. Uno script non si può interrogare; una funzione pura sì, e infatti
 * `__tests__/lib/argo-primaria.test.ts` la interroga.
 *
 * ─── LA REGOLA CHE VALE TUTTO IL FILE ───────────────────────────────────────
 * Argo ha TRE posti adulto per bambino: `_PA` (padre), `_MA` (madre) e `_GEN`
 * («genitore», di fatto il referente). Il terzo NON è un terzo adulto.
 *
 * Misurato sull'export del 2026-09-01, 163 alunni della primaria SP29900:
 *
 *   CF_GEN valorizzati            81
 *   …identici a CF_PA             74
 *   …identici a CF_MA              7
 *   …persone nuove                 0      ← zero, su ottantuno
 *
 * Trattare `_GEN` come un adulto a sé avrebbe creato **81 genitori doppioni** in
 * produzione, ognuno collegato al proprio figlio: un duplicato non dà errore, dà
 * due righe. Perciò il terzo posto entra SOLO se il suo codice fiscale non
 * compare già fra padre e madre — e se un giorno entrasse davvero, lo farebbe
 * come `tutore`, che non è un genitore e non riceve credenziali.
 *
 * ⚠️ La percentuale di oggi (81 su 81 duplicati) NON è una garanzia sul domani:
 * la regola è scritta sul confronto dei codici fiscali, non sulla statistica.
 * Se la statistica cambia, la regola regge lo stesso.
 */

/** Le intestazioni dell'export, per suffisso di ruolo. */
export const SUFFISSO = { father: '_PA', mother: '_MA', tutore: '_GEN' }

/**
 * Codice fiscale confrontabile: maiuscolo, senza spazi interni.
 * È l'UNICA chiave ammessa per agganciare una persona — mai il nome.
 */
export function normalizzaCf(v) {
  return String(v ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

/** Un CF è utilizzabile come chiave solo se ha la forma dei 16 caratteri. */
const FORMA_CF = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/
export function cfUtilizzabile(v) {
  const c = normalizzaCf(v)
  return c.length === 16 && FORMA_CF.test(c)
}

/**
 * `gg/mm/aaaa` → `aaaa-mm-gg`. Torna `null` su qualunque altra forma.
 * Misurato: nell'export tutte le date valorizzate sono in questa forma, al 100%.
 * Non «tenta di indovinare» un altro formato: una data sbagliata su un'anagrafica
 * è peggio di una data assente.
 */
export function dataIsoDaItaliana(v) {
  const s = String(v ?? '').trim()
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  if (!m) return null
  const [, gg, mm, aaaa] = m
  const g = Number(gg), me = Number(mm)
  if (me < 1 || me > 12 || g < 1 || g > 31) return null
  return `${aaaa}-${mm}-${gg}`
}

/** Valore di cella ripulito; stringa vuota se assente. */
const campo = (riga, nome) => String(riga?.[nome] ?? '').trim()

/**
 * Gli adulti di una riga, già deduplicati e con la parentela dichiarata.
 *
 * Torna al massimo tre elementi, in ordine `father` → `mother` → `tutore`, e
 * scarta chi non ha un codice fiscale utilizzabile: senza chiave non si scrive.
 */
export function adultiDaRiga(riga) {
  const visti = new Set()
  const adulti = []
  for (const [ruolo, su] of Object.entries(SUFFISSO)) {
    const cf = normalizzaCf(campo(riga, `CF${su}`))
    if (!cfUtilizzabile(cf)) continue
    if (visti.has(cf)) continue          // ← la regola che vale tutto il file
    visti.add(cf)
    adulti.push({
      ruolo,
      cf,
      cognome: campo(riga, `COGNOME${su}`),
      nome: campo(riga, `NOME${su}`),
      dataNascita: dataIsoDaItaliana(campo(riga, `DATA${su}`)),
      comuneNascita: campo(riga, `COMUNA${su}`),
      provinciaNascita: campo(riga, `PRNA${su}`),
      indirizzo: campo(riga, `INDRES${su}`),
      comune: campo(riga, `COMURES${su}`),
      provincia: campo(riga, `PRRES${su}`),
      cap: campo(riga, `CAPRES${su}`),
      telefoni: [campo(riga, `CELL${su}`), campo(riga, `TELEFONO${su}`)].filter(Boolean),
      email: [campo(riga, `EMAIL${su}`)].filter((e) => e.includes('@')),
    })
  }
  return adulti
}

/** L'alunno di una riga, nei soli campi che Kidville sa ospitare. */
export function alunnoDaRiga(riga) {
  return {
    cf: normalizzaCf(campo(riga, 'COD_FISC')),
    cognome: campo(riga, 'COGNOME'),
    nome: campo(riga, 'NOME'),
    dataNascita: dataIsoDaItaliana(campo(riga, 'DATAN')),
    sesso: campo(riga, 'SESSO'),
    comuneNascita: campo(riga, 'COM_NASC'),
    provinciaNascita: campo(riga, 'PR_NA'),
    codiceBelfioreNascita: campo(riga, 'CODCOM_NASC'),
    cittadinanza: campo(riga, 'CITTAD'),
    indirizzo: campo(riga, 'IND_RES'),
    comune: campo(riga, 'COM_RES'),
    provincia: campo(riga, 'PR_RES'),
    cap: campo(riga, 'CAP_RES'),
    dataIscrizione: dataIsoDaItaliana(campo(riga, 'DATA_ISCR')),
    // ⚠️ classe e sezione si LEGGONO ma non si scrivono mai in Kidville:
    // sono dell'a.s. 2025/26, e in Argo il 2026/27 è vuoto. Servono solo a
    // dire da quale classe viene una riga nei file di consegna.
    classeArgo: campo(riga, 'CL'),
    sezioneArgo: campo(riga, 'SEZ'),
  }
}

/**
 * I legami da aggiungere: gli adulti di Argo che non sono già collegati.
 * `cfGiaCollegati` è l'insieme dei CF (normalizzati) dei genitori già legati
 * a quel bambino in Kidville.
 */
export function legamiDaAggiungere(adultiArgo, cfGiaCollegati) {
  const gia = new Set([...cfGiaCollegati].map(normalizzaCf))
  return adultiArgo.filter((a) => !gia.has(a.cf))
}

/**
 * La parentela di un genitore già collegato, letta da Argo.
 * Torna `null` quando Argo non conosce quella persona: allora il campo resta
 * `NULL`, e il conteggio di quanti sono rimasti tali si dichiara. Indovinare
 * «madre» perché le madri sono più numerose sarebbe un dato inventato.
 */
export function parentelaDaArgo(cfGenitore, adultiArgo) {
  const cf = normalizzaCf(cfGenitore)
  const trovato = adultiArgo.find((a) => a.cf === cf)
  if (!trovato) return null
  return trovato.ruolo === 'tutore' ? null : trovato.ruolo
}

/**
 * Chiave di CONFRONTO per nome — usata **solo nei file da rivedere**, mai per
 * scrivere. Serve a distinguere «questo bambino in Argo non c'è» da «c'è, ma
 * con un codice fiscale diverso»: sono due problemi opposti e vanno separati.
 */
export function chiaveNome(cognome, nome) {
  const p = (v) => String(v ?? '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z]/g, '')
  return `${p(cognome)}|${p(nome)}`
}
