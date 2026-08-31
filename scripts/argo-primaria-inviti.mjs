#!/usr/bin/env node
/**
 * Credenziali ai genitori aggiunti da Argo.
 *
 * ─── PERCHÉ È UNO SCRIPT A PARTE ────────────────────────────────────────────
 * `argo-primaria-2026.mjs` scrive righe: si sbaglia, si corregge. Questo manda
 * email a famiglie vere, e un'email non si richiama. Tenerli separati significa
 * che non esiste nessuna combinazione di flag che spedisca per sbaglio mentre si
 * riconcilia.
 *
 * ─── NON RISCRIVE L'INVITO: USA QUELLO DEL PRODOTTO ─────────────────────────
 * Chiama `invitaGenitore` di `src/lib/iscrizioni/import/inviti.ts`, che fa in
 * ordine quattro cose — e la terza è quella che a mano si dimentica:
 *   1. `ensureParentIdentity` — account, riga `utenti`, ponte `parents.auth_user_id`
 *   2. `sincronizzaLegamiRuntime` — le righe `legame_genitori_alunni` LETTE DALLE
 *      POLICY RLS di pagamenti, mensa e chat. Senza, il genitore entra e non vede
 *      suo figlio: dargli un account così è peggio che non darglielo.
 *   3. il posto nel registro `iscrizioni_inviti_credenziali`, preso PRIMA di
 *      spedire (`ON CONFLICT DO NOTHING RETURNING`): se lo script si rilancia,
 *      la seconda volta non parte niente.
 *   4. l'invio, con la password temporanea.
 *
 * ⚠️ L'occasione dell'email resta `iscrizione-approvata`, fissata dentro
 * `spedisci`. Per questi genitori sarebbe più esatta `inserimento-anagrafica`,
 * ma è una sola didascalia e cambiarla davvero vuol dire salvarla nel registro —
 * altrimenti la RIPRESA di domani manderebbe comunque la vecchia. Migrazione, non
 * ritocco: non si infila dentro un invio.
 *
 * ─── CHI RICEVE ─────────────────────────────────────────────────────────────
 * Solo i codici fiscali elencati in `02-genitori-da-creare.xlsx` della consegna
 * indicata: l'elenco è quello già guardato, non una query rifatta adesso che
 * potrebbe pescare qualcun altro.
 *
 * Uso:
 *   node scripts/argo-primaria-inviti.mjs <cartella-consegna>            # elenco, NIENTE parte
 *   node scripts/argo-primaria-inviti.mjs <cartella-consegna> --apply    # spedisce
 */

import './lib/risolvi-ts.mjs'

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { normalizzaCf } from './lib/argo.mjs'

const APPLICA = process.argv.includes('--apply')
// ⚠️ `slice(2)`: argv[0] è il binario di node e argv[1] è questo script — entrambi
// percorsi assoluti, quindi un `find` ingenuo prenderebbe `/…/bin/node`.
const CARTELLA = process.argv.slice(2).find((a) => !a.startsWith('--'))
  ?? join(homedir(), 'argo-export', 'consegna-' + new Date().toLocaleDateString('sv-SE'))

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
const db = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

const { invitaGenitore, emailSpediteOggi } = await import('../src/lib/iscrizioni/import/inviti.ts')

function esigi(etichetta, { data, error }) {
  if (error) { console.error(`❌ ${etichetta}: ${error.code ?? ''} ${error.message}`); process.exit(1) }
  return data
}

// ─── chi ────────────────────────────────────────────────────────────────────
const elenco = join(CARTELLA, '02-genitori-da-creare.xlsx')
if (!existsSync(elenco)) { console.error(`❌ Manca ${elenco}`); process.exit(1) }
const wb = XLSX.read(readFileSync(elenco), { type: 'buffer' })
const CF_ATTESI = new Set(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
  .map((r) => normalizzaCf(r.cf)).filter(Boolean))

const genitori = esigi('parents', await db.from('parents')
  .select('id,first_name,fiscal_code,emails,auth_user_id')
  .in('fiscal_code', [...CF_ATTESI]))

const legami = esigi('student_parents', await db.from('student_parents')
  .select('parent_id,student_id').in('parent_id', genitori.map((g) => g.id)))
const alunni = esigi('alunni', await db.from('alunni')
  .select('id,scuola_id').in('id', [...new Set(legami.map((l) => l.student_id))]))
const sedeDiAlunno = new Map(alunni.map((a) => [a.id, a.scuola_id]))
const scuole = esigi('scuole', await db.from('scuole').select('id,nome'))
const nomeSede = new Map(scuole.map((s) => [s.id, s.nome]))

const daInvitare = []
const scartati = []
for (const g of genitori) {
  const figli = legami.filter((l) => l.parent_id === g.id)
  const scuolaId = figli.map((l) => sedeDiAlunno.get(l.student_id)).find(Boolean)
  const email = (g.emails ?? []).find((e) => typeof e === 'string' && e.includes('@'))
  if (!scuolaId) { scartati.push({ cf: g.fiscal_code, motivo: 'nessuna sede risolvibile dai figli' }); continue }
  if (!email) { scartati.push({ cf: g.fiscal_code, motivo: 'senza email' }); continue }
  daInvitare.push({ parentId: g.id, nome: g.first_name ?? null, scuolaId, submissionId: null,
    _sede: nomeSede.get(scuolaId), _giaAccount: g.auth_user_id != null })
}

const perSede = {}
for (const d of daInvitare) perSede[d._sede] = (perSede[d._sede] ?? 0) + 1

console.log('╔══ CREDENZIALI ai genitori aggiunti da Argo ·', APPLICA ? 'INVIO' : 'solo elenco')
console.log('║ elenco letto da       :', elenco)
console.log('║ codici fiscali attesi :', CF_ATTESI.size)
console.log('║ anagrafiche trovate   :', genitori.length)
console.log('║ DESTINATARI           :', daInvitare.length)
console.log('║   per sede            :', JSON.stringify(perSede))
console.log('║   già con un account  :', daInvitare.filter((d) => d._giaAccount).length)
console.log('║ scartati              :', scartati.length, scartati.length ? JSON.stringify(scartati.map((s) => s.motivo)) : '')
console.log('║ email di credenziali già uscite oggi:', await emailSpediteOggi(db))
console.log('╚══')

if (!APPLICA) {
  console.log('\nNIENTE è stato spedito. Per inviare: --apply')
  process.exit(0)
}

console.log('\n▶ INVIO…')
const esiti = {}
for (const g of daInvitare) {
  const e = await invitaGenitore(db, {
    parentId: g.parentId, nome: g.nome, scuolaId: g.scuolaId, submissionId: g.submissionId,
  }, 'registra')
  esiti[e.tipo] = (esiti[e.tipo] ?? 0) + 1
  if (e.tipo === 'fallita') console.log('   ✗', e.motivo)
}
console.log('\nesiti:', JSON.stringify(esiti, null, 1))
console.log('(«gia_invitata» = il registro aveva già quel posto: nessuna seconda password spedita)')
