#!/usr/bin/env node
/**
 * Anagrafiche della primaria da Argo — genitori collegati ai figli.
 *
 * ─── COSA FA, E COSA NON FA ─────────────────────────────────────────────────
 * Senza `--apply` NON SCRIVE NIENTE: legge Argo, legge Kidville, incrocia per
 * codice fiscale e deposita i file di consegna in `~/argo-export/consegna-<data>/`.
 * Con `--apply` esegue esattamente le scritture elencate in quei file.
 *
 * ─── LE DUE FONTI, E CHI COMANDA SU COSA ────────────────────────────────────
 *   1. `~/argo-export/01-argo-primaria-2025-26.xls` — l'export di Argo Alunni
 *      (SP29900, a.s. 2025/26, 163 alunni). Dà **anagrafica e genitori**.
 *   2. Kidville in produzione — dà il **perimetro** (chi è iscritto nel 2026/27)
 *      e la **classe**. Argo la classe ce l'ha, ma è dell'anno scorso: in Argo il
 *      2026/2027 è VUOTO, zero classi. Scriverla retrocederebbe i bambini di un
 *      anno, in silenzio. Perciò non si scrive mai.
 *
 * ─── LA CHIAVE ──────────────────────────────────────────────────────────────
 * Solo il **codice fiscale**. Mai il nome, in nessun caso, nemmeno «per i casi
 * facili»: un aggancio sbagliato attribuisce un genitore al figlio di un altro e
 * non produce nessun errore. Il nome serve solo a distinguere, nei file da
 * rivedere, «questo bambino in Argo non c'è» da «c'è, con un CF diverso».
 *
 * ─── SI RIEMPIE, NON SI SOVRASCRIVE ─────────────────────────────────────────
 * Su una riga che esiste già, Argo tocca solo le caselle VUOTE. Un dato inserito
 * dalla segreteria o arrivato dal modulo pubblico è più recente dell'export.
 *
 * ─── I DATI PERSONALI NON PASSANO DALLA CHAT ────────────────────────────────
 * A schermo escono SOLO conteggi. I nomi stanno nei file, che vivono fuori dal
 * repo (`~/argo-export/`, non versionato). Il repo è pubblico.
 *
 * Uso:
 *   node scripts/argo-primaria-2026.mjs             # prova a vuoto
 *   node scripts/argo-primaria-2026.mjs --apply     # scrive in produzione
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

import {
  normalizzaCf, cfUtilizzabile, adultiDaRiga, alunnoDaRiga,
  legamiDaAggiungere, parentelaDaArgo, chiaveNome,
} from './lib/argo.mjs'

const APPLICA = process.argv.includes('--apply')
const LAVORO = join(homedir(), 'argo-export')
const EXPORT = join(LAVORO, '01-argo-primaria-2025-26.xls')
const SEDI = ['Kidville Giugliano', 'Kidville Cesa']

/**
 * La corrispondenza fra i corsi di Argo e le sedi di Kidville, MISURATA il
 * 2026-09-01 dai comuni di residenza — non dedotta dall'ordine alfabetico:
 *   corso A (84 alunni): Giugliano in Campania 68, Napoli 5   → Giugliano
 *   corso B (79 alunni): Cesa 25, Gricignano 18, Sant'Antimo 10, Aversa 10 → Cesa
 * ⚠️ Serve SOLO a etichettare i file di consegna. La sede di un bambino
 * agganciato viene da Kidville, che la conosce già. A KinderTap l'inferenza
 * ovvia («La Favola» → Cesa) era sbagliata: è Aversa.
 */
const CORSO_SEDE = { A: 'Giugliano', B: 'Cesa' }

// ═══════════════════════════════════════════════════════════════════════════
function caricaAmbiente() {
  for (const p of [join(homedir(), 'kindertap-export', '.env.runtime'), join(process.cwd(), '.env.local')]) {
    if (!existsSync(p)) continue
    for (const riga of readFileSync(p, 'utf8').split('\n')) {
      const t = riga.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 0) continue
      const k = t.slice(0, i).trim()
      if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
  }
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('❌ Mancano SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.')
    process.exit(1)
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

/** PostgREST non lancia: ritorna `{ error }`. Un try/catch qui non scatterebbe mai. */
function esigi(etichetta, { data, error }) {
  if (error) {
    console.error(`❌ ${etichetta}: ${error.code ?? ''} ${error.message}`)
    process.exit(1)
  }
  return data
}

const vuoto = (v) => v == null || String(v).trim() === ''

// ═══════════════════════════════════════════════════════════════════════════
const db = caricaAmbiente()

if (!existsSync(EXPORT)) {
  console.error(`❌ Manca l'export di Argo: ${EXPORT}`)
  process.exit(1)
}

// ─── Argo ───────────────────────────────────────────────────────────────────
const wb = XLSX.read(readFileSync(EXPORT), { type: 'buffer' })
const RIGHE = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
  .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim(), v])))

const argoPerCf = new Map()
const argoPerNome = new Map()
let argoSenzaCf = 0
for (const r of RIGHE) {
  const alunno = alunnoDaRiga(r)
  const rec = { ...alunno, adulti: adultiDaRiga(r) }
  const kn = chiaveNome(alunno.cognome, alunno.nome)
  if (!argoPerNome.has(kn)) argoPerNome.set(kn, [])
  argoPerNome.get(kn).push(rec)
  if (!cfUtilizzabile(alunno.cf)) { argoSenzaCf++; continue }
  argoPerCf.set(alunno.cf, rec)
}

// ─── Kidville ───────────────────────────────────────────────────────────────
const scuole = esigi('scuole', await db.from('scuole').select('id,nome'))
const sezioni = esigi('sections', await db.from('sections').select('id,scuola_id,school_type,name'))
const nomeSede = new Map(scuole.map((s) => [s.id, s.nome]))
const nomeSez = new Map(sezioni.map((s) => [s.id, s.name]))
const sezPrimaria = new Set(sezioni.filter((s) => s.school_type === 'primaria').map((s) => s.id))

const tuttiAlunni = esigi('alunni', await db.from('alunni').select(
  'id,scuola_id,section_id,codice_fiscale,nome,cognome,data_nascita,data_iscrizione,birth_city,birth_province,' +
  'codice_belfiore_nascita,residence_city,residence_province,zip_code,residence_address,archiviato_il'))
const ALUNNI = tuttiAlunni.filter((a) => a.archiviato_il == null && sezPrimaria.has(a.section_id)
  && SEDI.includes(nomeSede.get(a.scuola_id)))

const legami = esigi('student_parents', await db.from('student_parents')
  .select('student_id,parent_id,relation_type,is_primary'))
const genitori = esigi('parents', await db.from('parents').select(
  'id,first_name,last_name,fiscal_code,birth_date,birth_city,birth_province,' +
  'residence_address,residence_city,residence_province,zip_code,phone_numbers,emails,auth_user_id'))

const genitorePerId = new Map(genitori.map((p) => [p.id, p]))
const genitorePerCf = new Map()
for (const p of genitori) { const c = normalizzaCf(p.fiscal_code); if (c) genitorePerCf.set(c, p) }
const legamiPerAlunno = new Map()
for (const l of legami) {
  if (!legamiPerAlunno.has(l.student_id)) legamiPerAlunno.set(l.student_id, [])
  legamiPerAlunno.get(l.student_id).push(l)
}

// ═══════════════════════════════════════════════════════════════════════════
// Il piano
// ═══════════════════════════════════════════════════════════════════════════
const piano = {
  genitoriDaCreare: new Map(),   // cf → dati
  legamiDaCreare: [],            // {alunnoId, cf, ruolo, etichetta}
  parenteleDaRiempire: [],       // {alunnoId, parentId, ruolo, etichetta}
  alunniDaCompletare: [],        // {id, patch, etichetta}
  genitoriDaCompletare: [],      // {id, patch, etichetta}
}
const referto = {
  agganciati: 0, senzaRiscontro: [], cfDiscordanti: [],
  parenteleNonRisolte: 0, inArgoNonInKidville: [],
}

for (const a of ALUNNI) {
  const cf = normalizzaCf(a.codice_fiscale)
  const sede = (nomeSede.get(a.scuola_id) ?? '').replace('Kidville ', '')
  const et = `${sede} / ${nomeSez.get(a.section_id) ?? '?'}`
  const arg = argoPerCf.get(cf)

  if (!arg) {
    // Distinguo «assente» da «presente con un altro codice fiscale»: sono due
    // problemi opposti, e confonderli manda la segreteria a cercare la cosa
    // sbagliata. La conferma è la DATA DI NASCITA, non il solo nome.
    const omonimi = argoPerNome.get(chiaveNome(a.cognome, a.nome)) ?? []
    const stessaData = omonimi.filter((o) => o.dataNascita && o.dataNascita === (a.data_nascita ?? null))
    if (omonimi.length) {
      referto.cfDiscordanti.push({
        classe: et, cf_kidville: cf,
        cf_argo: omonimi.map((o) => o.cf).join(' · '),
        stessa_data_di_nascita: stessaData.length > 0 ? 'sì' : 'no',
        classe_argo: omonimi.map((o) => `${o.classeArgo}${o.sezioneArgo}`).join(' · '),
      })
    } else {
      referto.senzaRiscontro.push({ classe: et, cf_kidville: cf })
    }
    continue
  }
  referto.agganciati++

  // ── alunno: solo le caselle vuote ────────────────────────────────────────
  const patch = {}
  if (vuoto(a.data_iscrizione) && arg.dataIscrizione) patch.data_iscrizione = arg.dataIscrizione
  if (vuoto(a.birth_city) && arg.comuneNascita) patch.birth_city = arg.comuneNascita
  if (vuoto(a.birth_province) && arg.provinciaNascita) patch.birth_province = arg.provinciaNascita
  if (vuoto(a.codice_belfiore_nascita) && arg.codiceBelfioreNascita) patch.codice_belfiore_nascita = arg.codiceBelfioreNascita
  if (vuoto(a.residence_city) && arg.comune) patch.residence_city = arg.comune
  if (vuoto(a.residence_province) && arg.provincia) patch.residence_province = arg.provincia
  if (vuoto(a.zip_code) && arg.cap) patch.zip_code = arg.cap
  if (vuoto(a.residence_address) && arg.indirizzo) patch.residence_address = arg.indirizzo
  if (Object.keys(patch).length) piano.alunniDaCompletare.push({ id: a.id, patch, etichetta: et })

  // ── legami ───────────────────────────────────────────────────────────────
  const gia = legamiPerAlunno.get(a.id) ?? []
  const cfGia = new Set(gia.map((l) => normalizzaCf(genitorePerId.get(l.parent_id)?.fiscal_code)).filter(Boolean))

  for (const l of gia) {
    if (l.relation_type) continue
    const ruolo = parentelaDaArgo(genitorePerId.get(l.parent_id)?.fiscal_code, arg.adulti)
    if (ruolo) piano.parenteleDaRiempire.push({ alunnoId: a.id, parentId: l.parent_id, ruolo, etichetta: et })
    else referto.parenteleNonRisolte++
  }

  for (const ad of legamiDaAggiungere(arg.adulti, cfGia)) {
    const esistente = genitorePerCf.get(ad.cf)
    if (esistente) {
      // il genitore c'è già (fratello, o altra sede): si collega, non si duplica
      const p = {}
      if (vuoto(esistente.birth_date) && ad.dataNascita) p.birth_date = ad.dataNascita
      if (vuoto(esistente.residence_address) && ad.indirizzo) p.residence_address = ad.indirizzo
      if (vuoto(esistente.residence_city) && ad.comune) p.residence_city = ad.comune
      if (vuoto(esistente.zip_code) && ad.cap) p.zip_code = ad.cap
      if (!(esistente.emails ?? []).length && ad.email.length) p.emails = ad.email
      if (!(esistente.phone_numbers ?? []).length && ad.telefoni.length) p.phone_numbers = ad.telefoni
      if (Object.keys(p).length) piano.genitoriDaCompletare.push({ id: esistente.id, patch: p, etichetta: et })
    } else if (!piano.genitoriDaCreare.has(ad.cf)) {
      piano.genitoriDaCreare.set(ad.cf, ad)
    }
    piano.legamiDaCreare.push({ alunnoId: a.id, cf: ad.cf, ruolo: ad.ruolo, etichetta: et })
  }
}

// ── chi c'è in Argo e non in Kidville ───────────────────────────────────────
const cfKidville = new Set(ALUNNI.map((a) => normalizzaCf(a.codice_fiscale)))
for (const [cf, r] of argoPerCf) {
  if (cfKidville.has(cf)) continue
  referto.inArgoNonInKidville.push({
    classe_argo: `${r.classeArgo}${r.sezioneArgo}`,
    sede_probabile: CORSO_SEDE[r.sezioneArgo] ?? '?',
    cf,
    adulti_disponibili: r.adulti.length,
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Consegna
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ data LOCALE, non `toISOString()`: alle 00:50 di notte l'UTC è ancora il
// giorno prima, e la cartella di consegna porterebbe una data che non è quella
// in cui l'ha chiesta chi la legge.
const oggi = new Date().toLocaleDateString('sv-SE')
const CARTELLA = join(LAVORO, `consegna-${oggi}`)
mkdirSync(CARTELLA, { recursive: true })

const riassunto = {
  generato: new Date().toISOString(),
  modalita: APPLICA ? 'APPLICA' : 'prova a vuoto',
  argo: { righe: RIGHE.length, con_cf: argoPerCf.size, senza_cf: argoSenzaCf },
  kidville: { alunni_primaria: ALUNNI.length },
  agganciati: referto.agganciati,
  senza_riscontro: referto.senzaRiscontro.length,
  cf_discordanti: referto.cfDiscordanti.length,
  in_argo_non_in_kidville: referto.inArgoNonInKidville.length,
  scritture: {
    genitori_da_creare: piano.genitoriDaCreare.size,
    genitori_da_completare: piano.genitoriDaCompletare.length,
    legami_da_creare: piano.legamiDaCreare.length,
    parentele_da_riempire: piano.parenteleDaRiempire.length,
    parentele_non_risolvibili: referto.parenteleNonRisolte,
    alunni_da_completare: piano.alunniDaCompletare.length,
  },
}

function foglio(nome, righe) {
  if (!righe.length) return null
  const ws = XLSX.utils.json_to_sheet(righe)
  const w = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(w, ws, nome.slice(0, 31))
  return w
}
function salva(nomeFile, nomeFoglio, righe) {
  const w = foglio(nomeFoglio, righe)
  if (!w) return
  writeFileSync(join(CARTELLA, nomeFile), XLSX.write(w, { type: 'buffer', bookType: 'xlsx' }))
}

writeFileSync(join(CARTELLA, '00-riassunto.json'), JSON.stringify(riassunto, null, 2))
salva('01-legami-da-creare.xlsx', 'legami', piano.legamiDaCreare.map((l) => ({
  classe: l.etichetta, cf_genitore: l.cf, parentela: l.ruolo,
  genitore: piano.genitoriDaCreare.has(l.cf) ? 'NUOVO' : 'già in anagrafica',
})))
salva('02-genitori-da-creare.xlsx', 'genitori', [...piano.genitoriDaCreare.values()].map((g) => ({
  cognome: g.cognome, nome: g.nome, cf: g.cf, parentela: g.ruolo,
  data_nascita: g.dataNascita ?? '', comune_nascita: g.comuneNascita,
  indirizzo: g.indirizzo, comune: g.comune, cap: g.cap,
  email: g.email.join(' '), telefoni: g.telefoni.join(' '),
})))
salva('03-cf-discordanti.xlsx', 'cf discordanti', referto.cfDiscordanti)
salva('04-senza-riscontro.xlsx', 'senza riscontro', referto.senzaRiscontro)
salva('05-in-argo-non-in-kidville.xlsx', 'in Argo non in Kidville', referto.inArgoNonInKidville)
salva('06-alunni-da-completare.xlsx', 'alunni', piano.alunniDaCompletare.map((x) => ({
  classe: x.etichetta, campi: Object.keys(x.patch).join(' · '),
})))

// ═══════════════════════════════════════════════════════════════════════════
// A schermo: SOLO conteggi
// ═══════════════════════════════════════════════════════════════════════════
console.log('╔══ ARGO → KIDVILLE · primaria ·', riassunto.modalita)
console.log('║ Argo:', riassunto.argo.righe, 'righe,', riassunto.argo.con_cf, 'con CF utilizzabile')
console.log('║ Kidville primaria:', riassunto.kidville.alunni_primaria, 'alunni')
console.log('║   agganciati per CF :', riassunto.agganciati)
console.log('║   senza riscontro   :', riassunto.senza_riscontro)
console.log('║   CF DISCORDANTI    :', riassunto.cf_discordanti, '← stesso nome in Argo, codice diverso')
console.log('║ in Argo e non in Kidville:', riassunto.in_argo_non_in_kidville)
console.log('╠══ scritture previste')
for (const [k, v] of Object.entries(riassunto.scritture)) console.log('║  ', k.padEnd(28), v)
console.log('╚══ consegna in', CARTELLA)

if (!APPLICA) {
  console.log('\nProva a vuoto: NIENTE è stato scritto. Per applicare: --apply')
  process.exit(0)
}

// ═══════════════════════════════════════════════════════════════════════════
// Scrittura
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n▶ APPLICO in produzione…')
const cfNuovoAId = new Map()

if (piano.genitoriDaCreare.size) {
  const righe = [...piano.genitoriDaCreare.values()].map((g) => ({
    first_name: g.nome, last_name: g.cognome, fiscal_code: g.cf,
    birth_date: g.dataNascita, birth_city: g.comuneNascita || null,
    birth_province: g.provinciaNascita || null,
    residence_address: g.indirizzo || null, residence_city: g.comune || null,
    residence_province: g.provincia || null, zip_code: g.cap || null,
    phone_numbers: g.telefoni.length ? g.telefoni : null,
    emails: g.email.length ? g.email : null,
  }))
  const creati = esigi('inserimento parents', await db.from('parents').insert(righe).select('id,fiscal_code'))
  for (const p of creati) cfNuovoAId.set(normalizzaCf(p.fiscal_code), p.id)
  console.log('  ✓ genitori creati:', creati.length)
}

for (const g of piano.genitoriDaCompletare) {
  esigi('completamento parents', await db.from('parents').update(g.patch).eq('id', g.id).select('id'))
}
if (piano.genitoriDaCompletare.length) console.log('  ✓ genitori completati:', piano.genitoriDaCompletare.length)

if (piano.legamiDaCreare.length) {
  const righe = piano.legamiDaCreare.map((l) => ({
    student_id: l.alunnoId,
    parent_id: cfNuovoAId.get(l.cf) ?? genitorePerCf.get(l.cf)?.id,
    relation_type: l.ruolo === 'tutore' ? 'tutore' : l.ruolo,
    is_primary: false,
  }))
  const orfani = righe.filter((r) => !r.parent_id).length
  if (orfani) { console.error('❌ legami senza parent_id:', orfani, '— mi fermo'); process.exit(1) }
  esigi('inserimento student_parents', await db.from('student_parents').insert(righe).select('student_id'))
  console.log('  ✓ legami creati:', righe.length)
}

for (const p of piano.parenteleDaRiempire) {
  esigi('parentela', await db.from('student_parents').update({ relation_type: p.ruolo })
    .eq('student_id', p.alunnoId).eq('parent_id', p.parentId).select('student_id'))
}
if (piano.parenteleDaRiempire.length) console.log('  ✓ parentele riempite:', piano.parenteleDaRiempire.length)

for (const a of piano.alunniDaCompletare) {
  esigi('completamento alunni', await db.from('alunni').update(a.patch).eq('id', a.id).select('id'))
}
if (piano.alunniDaCompletare.length) console.log('  ✓ alunni completati:', piano.alunniDaCompletare.length)

console.log('\n✓ Fatto. Le verifiche vanno rieseguite: i numeri attesi sono in 00-riassunto.json')
