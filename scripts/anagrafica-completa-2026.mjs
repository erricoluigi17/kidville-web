#!/usr/bin/env node
/**
 * Anagrafica completa A.S. 2026/27 — quadro, codici fiscali, account e inviti.
 *
 * ─── COSA FA, E COSA NON FA ─────────────────────────────────────────────────
 * Senza `--apply` NON SCRIVE NIENTE e NON MANDA NIENTE: legge, incrocia, calcola
 * e deposita i file di consegna in `~/kindertap-export/consegna-<data>/`.
 * È la «prova a vuoto» decisa col titolare il 2026-08-30 (domanda 4).
 *
 * ─── LE TRE FONTI ───────────────────────────────────────────────────────────
 *   1. `iscrizioni_elenco_righe` — gli elenchi Excel per classe già in
 *      produzione. **È la fonte della classe, e il perimetro**: chi non compare
 *      in un elenco non è iscritto per il 2026/27 e non riceve niente.
 *   2. `enrollment_submissions` — le domande dal form pubblico. **Vincono
 *      sempre** sui dati dell'export (decisione del titolare, punto 2).
 *   3. `03-kindertap-archivio-completo.json` — l'export del vecchio registro.
 *      Riempie **solo** le caselle rimaste vuote, e porta i legami di parentela.
 *
 * ─── PERCHÉ NON RISCRIVE IL MATCHER, IL CALCOLO CF, LA TABELLA DEI COMUNI ───
 * Esistono già in `src/`, con i test. Una seconda copia dentro uno script
 * diverge dalla prima al primo caso limite, e diverge in silenzio.
 *
 * ─── I DATI PERSONALI NON PASSANO DALLA CHAT ────────────────────────────────
 * A schermo escono SOLO conteggi e codici. I nomi stanno nei file, che vivono
 * fuori dal repo (`~/kindertap-export/`, non versionato) e da lì vanno nel
 * bucket privato. Il repo è pubblico: un nome di bambino committato non si
 * cancella più.
 *
 * Uso:
 *   node scripts/anagrafica-completa-2026.mjs             # prova a vuoto
 *   node scripts/anagrafica-completa-2026.mjs --apply     # fase F (non ancora autorizzata)
 */

import './lib/risolvi-ts.mjs'

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

const RADICE = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const CARTELLA_LAVORO = join(homedir(), 'kindertap-export')
const EXPORT_JSON = join(CARTELLA_LAVORO, '03-kindertap-archivio-completo.json')

const APPLICA = process.argv.includes('--apply')

/**
 * Le sedi in scope: dal 2026-08-31 tutte e tre.
 *
 * Aversa era rimasta fuori (domanda 6 del 30/08) perché il suo elenco non
 * portava le classi: era un foglio Excel unico chiamato `RETTE`, con le sezioni
 * scritte come righe in mezzo ai nomi, e tutte e 117 le righe erano finite in
 * quella classe inesistente. Non lo era più: la corrispondenza fra i sei blocchi
 * del foglio e le sezioni è stata **misurata** — date di nascita dei bambini e
 * export del vecchio registro, che concordano — l'elenco è stato ricostruito in
 * Forma A e ricaricato, e i 73 alunni che erano senza sezione sono stati
 * riallineati. Vedi `scripts/lib/blocchi-aversa.mjs`.
 */
const SEDI_IN_SCOPE = ['Kidville Giugliano', 'Kidville Cesa', 'Kidville Aversa']
const SEDE_ESCLUSA = null

/**
 * Le parentele che ricevono un ACCOUNT (decisione del titolare, domanda 3).
 * Tutte le altre — nonni, zii, «altro» — diventano deleghe al ritiro.
 * Il caso «legame genitoriale senza parentela specificata» lo tratta `eGenitore`.
 */
const PARENTELE_GENITORE = new Set(['mother', 'father'])

// ═══════════════════════════════════════════════════════════════════════════
// Moduli veri del prodotto — caricati DOPO il risolutore, quindi dinamicamente:
// gli `import` statici vengono risolti tutti prima che una riga di codice giri.
// ═══════════════════════════════════════════════════════════════════════════
const { abbina } = await import('../src/lib/iscrizioni/import/abbinamento.ts')
const { normalizzaNome, similitudine } = await import('../src/lib/iscrizioni/import/normalizza.ts')
const { risolviRetta } = await import('../src/lib/iscrizioni/import/retta.ts')
const { calcolaCodiceFiscale, carattereControllo } = await import('../src/lib/fiscale/calcolo.ts')
const { OMOCODIA_DA_CIFRA, POSIZIONI_NUMERICHE } = await import('../src/lib/fiscale/tabelle.ts')
const { validaCodiceFiscale, normalizzaCodiceFiscale } = await import('../src/lib/fiscale/validazione.ts')
const { verificaCoerenza } = await import('../src/lib/fiscale/coerenza.ts')
const { sessoDaCodiceFiscale } = await import('../src/lib/fiscale/codice-fiscale.ts')
const { risolviComune, comunePerBelfiore } = await import('../src/lib/fiscale/comuni.ts')

// ═══════════════════════════════════════════════════════════════════════════
// 0 · Autotest — il collegamento fra script e moduli veri, provato su un caso
//     da manuale PRIMA di toccare i dati di produzione. Se qui qualcosa non
//     torna, tutto il resto è da buttare, e va scoperto adesso.
//     I dati sono quelli dell'esempio canonico: nessuna persona vera.
// ═══════════════════════════════════════════════════════════════════════════
function autotest() {
    const prove = []
    const ATTESO = 'RSSMRA80A01H501U' // Rossi Mario, 01/01/1980, Roma
    const ANAGRAFICA = { cognome: 'Rossi', nome: 'Mario', dataNascita: '1980-01-01', sesso: 'M', codiceBelfiore: 'H501' }

    const calc = calcolaCodiceFiscale(ANAGRAFICA)
    prove.push(['calcolo del codice', calc.ok === true && calc.codice === ATTESO, JSON.stringify(calc)])
    prove.push(['validità formale', validaCodiceFiscale(ATTESO).valido === true, '—'])

    // Un carattere di controllo storpiato DEVE essere rifiutato: è la prova che
    // il controllo controlla davvero, invece di dire sempre «sì».
    const storpiato = ATTESO.slice(0, 15) + (ATTESO[15] === 'A' ? 'B' : 'A')
    prove.push(['carattere di controllo storpiato → RIFIUTATO', validaCodiceFiscale(storpiato).valido === false, storpiato])

    // Un cognome diverso DEVE risultare incoerente, altrimenti la verifica è cieca.
    const diverso = verificaCoerenza(ATTESO, { ...ANAGRAFICA, cognome: 'Bianchi' })
    prove.push(['cognome diverso → INCOERENTE', diverso.coerente === false && diverso.motivi.includes('cognome'), JSON.stringify(diverso.motivi)])

    prove.push(['anagrafica giusta → coerente', verificaCoerenza(ATTESO, ANAGRAFICA).coerente === true, '—'])

    // Omocodia: l'Agenzia sostituisce la cifra più a destra fra le posizioni
    // numeriche E RICALCOLA il carattere di controllo sui nuovi 15. Sostituire
    // la cifra lasciando il vecchio controllo produce un codice davvero invalido
    // — cioè non prova niente sull'omocodia, prova solo che il checksum funziona.
    const posizione = POSIZIONI_NUMERICHE[POSIZIONI_NUMERICHE.length - 1]
    const primi15 = ATTESO.slice(0, 15).split('')
    primi15[posizione] = OMOCODIA_DA_CIFRA[primi15[posizione]]
    const base15 = primi15.join('')
    const om = base15 + carattereControllo(base15)
    const vOm = validaCodiceFiscale(om)
    const cOm = verificaCoerenza(om, ANAGRAFICA)
    prove.push(['omocodia riconosciuta come tale', vOm.omocodia === true, JSON.stringify(vOm.motivi)])
    prove.push(['omocodia → coerente, non errore', cOm.coerente === true, JSON.stringify(cOm.motivi)])

    // Il dato mancante deve dire QUALE manca, non semplicemente «no».
    const senzaLuogo = verificaCoerenza(ATTESO, { ...ANAGRAFICA, codiceBelfiore: null })
    prove.push(['dato mancante → nonVerificabili lo nomina', senzaLuogo.nonVerificabili.includes('luogo-nascita'), JSON.stringify(senzaLuogo.nonVerificabili)])

    const roma = risolviComune('Roma', 'RM')
    prove.push(['comune → Belfiore', roma.esito === 'trovato' && roma.comune.belfiore === 'H501', JSON.stringify(roma.esito)])
    prove.push(['Belfiore → comune', comunePerBelfiore('H501') !== null, '—'])

    // Uno stato estero: il codice inizia per Z e la provincia è EE.
    const estero = comunePerBelfiore('Z100')
    prove.push(['stati esteri presenti in tabella', estero !== null && estero.sigla === 'EE', JSON.stringify(estero?.sigla ?? '—')])

    for (const [n, f] of [['abbina', abbina], ['normalizzaNome', normalizzaNome], ['risolviRetta', risolviRetta]]) {
        prove.push([`${n} disponibile`, typeof f === 'function', typeof f])
    }

    let ko = 0
    console.log('┌─ Autotest dei moduli riusati')
    for (const [nome, esito, dettaglio] of prove) {
        if (!esito) ko++
        console.log(`│  ${esito ? '✅' : '❌'} ${nome}${esito ? '' : '  → ' + dettaglio}`)
    }
    console.log(`└─ ${ko === 0 ? 'tutto verde' : ko + ' PROVE FALLITE'}\n`)
    return ko === 0
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · Collegamento e lettura
// ═══════════════════════════════════════════════════════════════════════════
function caricaEnv() {
    // `.env.runtime` per primo: la SERVICE_ROLE_KEY di `.env.local` è rifiutata
    // dal progetto con «Unregistered API key» (misurato il 2026-08-30).
    for (const p of [join(CARTELLA_LAVORO, '.env.runtime'), join(RADICE, '.env.local')]) {
        if (!existsSync(p)) continue
        for (const line of readFileSync(p, 'utf8').split('\n')) {
            const t = line.trim()
            if (!t || t.startsWith('#') || !t.includes('=')) continue
            const i = t.indexOf('=')
            const k = t.slice(0, i).trim()
            if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim()
        }
    }
}

/**
 * Ritenta una lettura che è caduta per ragioni di rete.
 * Un giro che dura minuti non deve morire per un pacchetto perso — ma ritenta
 * SOLO le letture: applicare la stessa indulgenza a una scrittura vorrebbe dire
 * rischiare di farla due volte.
 */
async function conRitentativi(cosa, quante = 3) {
    let ultimo
    for (let i = 1; i <= quante; i++) {
        try { return await cosa() } catch (e) {
            ultimo = e
            if (i < quante) await new Promise((r) => setTimeout(r, 500 * i))
        }
    }
    throw ultimo
}

/** Legge una tabella per intero, a pagine: PostgREST ne dà 1000 per volta. */
async function tuttaLaTabella(db, tabella, colonne, affina = (q) => q) {
    const righe = []
    const PASSO = 1000
    for (let da = 0; ; da += PASSO) {
        const { data, error } = await conRitentativi(() =>
            affina(db.from(tabella).select(colonne)).range(da, da + PASSO - 1))
        if (error) throw new Error(`${tabella}: ${error.message}`)
        righe.push(...(data ?? []))
        if (!data || data.length < PASSO) break
    }
    return righe
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · Utilità minute
// ═══════════════════════════════════════════════════════════════════════════
const testo = (v) => (typeof v === 'string' ? v.trim() : '')
const cfNorm = (v) => normalizzaCodiceFiscale(v) || null
const emailValida = (v) => {
    const e = testo(v).toLowerCase()
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null
}
/** `m`/`f` di KinderTap → `M`/`F`. Qualunque altra cosa è «non lo so». */
const sessoNorm = (v) => {
    const s = testo(v).toUpperCase()
    return s === 'M' || s === 'F' ? s : null
}
/** Le date arrivano come `AAAA-MM-GG` o `GG/MM/AAAA`. Esce sempre ISO, o `null`. */
function dataIso(v) {
    const s = testo(v)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    if (m) return `${m[3]}-${m[2]}-${m[1]}`
    const d = s.match(/^(\d{4}-\d{2}-\d{2})T/)
    return d ? d[1] : null
}
/** Il primo valore utile di un campo che a volte è lista e a volte stringa. */
function primo(v) {
    if (Array.isArray(v)) return v.find((x) => testo(x)) ?? null
    return testo(v) || null
}
/** Chiave stabile di una persona, per non contarla due volte. */
const chiavePersona = (nome, cognome, data) =>
    `${normalizzaNome(`${cognome ?? ''} ${nome ?? ''}`)}|${data ?? ''}`

/**
 * Il codice Belfiore del luogo di nascita, da qualunque forma sia disponibile,
 * dichiarando SEMPRE da dove viene e perché eventualmente non c'è.
 * Non indovina: se il comune è ambiguo lo dice, e resta senza codice.
 */
function belfioreDa({ belfioreGiaScritto, cityCode, comune, provincia, nazione }) {
    const g = testo(belfioreGiaScritto).toUpperCase()
    if (/^[A-Z]\d{3}$/.test(g)) return { codice: g, fonte: 'anagrafica' }

    const c = testo(cityCode).toUpperCase()
    if (/^[A-Z]\d{3}$/.test(c) && comunePerBelfiore(c)) return { codice: c, fonte: 'export (cityCode)' }

    const nome = testo(comune)
    if (nome) {
        const r = risolviComune(nome, testo(provincia) || null)
        if (r.esito === 'trovato') return { codice: r.comune.belfiore, fonte: 'calcolato dal comune' }
        if (r.esito === 'ambiguo') {
            return { codice: null, fonte: null, motivo: `comune «${nome}» ambiguo fra ${r.candidati.length} possibilità: serve la provincia` }
        }
        return { codice: null, fonte: null, motivo: `comune «${nome}»${testo(provincia) ? ' (' + testo(provincia) + ')' : ''} non trovato in tabella Belfiore` }
    }

    const naz = testo(nazione)
    if (naz && !/^ital/i.test(naz)) {
        const r = risolviComune(naz, 'EE')
        if (r.esito === 'trovato') return { codice: r.comune.belfiore, fonte: 'stato estero' }
        return { codice: null, fonte: null, motivo: `nato all'estero (${naz}): stato non risolto in codice Z` }
    }
    return { codice: null, fonte: null, motivo: 'manca il comune (o lo stato) di nascita' }
}

/**
 * La verifica del codice fiscale di UNA persona, come la chiede il punto 7.
 *
 * ⚠️ La provenienza del SESSO cambia il valore della verifica, e va detta.
 * Se il sesso lo si legge dal codice stesso, quella componente si verifica da
 * sé — cioè non si verifica affatto — e le altre quattro restano controlli veri.
 */
function verificaPersona({ nome, cognome, cf, dataNascita, sesso, sessoFonte, belfiore, belfioreFonte, belfioreMotivo }) {
    const val = validaCodiceFiscale(cf)
    const dati = { nome, cognome, sesso, dataNascita, codiceBelfiore: belfiore }
    const coe = verificaCoerenza(cf, dati)

    let stato
    if (!testo(cf)) stato = 'NON VERIFICABILE'
    else if (!val.valido) stato = 'DA CONTROLLARE'
    else if (coe.nonVerificabili.length > 0 && !coe.coerente) stato = 'NON VERIFICABILE'
    else if (coe.nonVerificabili.length > 0) stato = 'NON VERIFICABILE'
    else if (coe.coerente) stato = 'VERIFICATO'
    else stato = 'DA CONTROLLARE'

    const mancanti = []
    for (const c of coe.nonVerificabili) {
        if (c === 'luogo-nascita' && belfioreMotivo) mancanti.push(`luogo di nascita — ${belfioreMotivo}`)
        else if (c === 'sesso') mancanti.push('sesso')
        else if (c === 'data-nascita') mancanti.push('data di nascita')
        else mancanti.push(c)
    }

    return {
        stato,
        codiceNelFile: val.normalizzato || testo(cf) || '',
        codiceCalcolato: coe.codiceAtteso ?? '',
        omocodia: val.omocodia,
        validoFormalmente: val.valido,
        motiviFormali: val.motivi,
        campiCheNonTornano: coe.motivi.filter((m) => !m.startsWith('cf-')),
        motiviCodice: coe.motivi.filter((m) => m.startsWith('cf-')),
        datiMancanti: mancanti,
        sessoFonte,
        belfiore,
        belfioreFonte,
    }
}

/**
 * Il sesso che il nome di battesimo suggerisce. **Euristica dichiarata**, mai una
 * prova: serve solo a comporre la lista a parte chiesta dal titolare (domanda 7).
 * Restituisce `null` ogni volta che non è ragionevolmente sicura.
 */
const NOMI_MASCHILI_IN_A = new Set(['ANDREA', 'LUCA', 'MATTIA', 'NICOLA', 'ELIA', 'GIOSUE', 'BATTISTA', 'AMEDEO'])
const NOMI_FEMMINILI_NON_IN_A = new Set(['BEATRICE', 'ALICE', 'IRENE', 'AGNESE', 'ELISABETH', 'NOEMI', 'RACHELE', 'ESTER', 'MARIS', 'CARMEN', 'INES', 'DOLORES', 'ANNAMARIE'])
function sessoSuggeritoDalNome(nome) {
    const n = normalizzaNome(nome).split(/\s+/)[0] ?? ''
    if (n.length < 3) return null
    if (NOMI_MASCHILI_IN_A.has(n)) return 'M'
    if (NOMI_FEMMINILI_NON_IN_A.has(n)) return 'F'
    if (n.endsWith('A')) return 'F'
    if (n.endsWith('O') || n.endsWith('E')) return null // Emanuele/Michele M, ma Adele/Irene F
    return null
}

export { autotest, caricaEnv, tuttaLaTabella, belfioreDa, verificaPersona, sessoSuggeritoDalNome }

// ═══════════════════════════════════════════════════════════════════════════
// 3 · Il giro
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
    if (!autotest()) {
        console.error('❌ Autotest fallito: non tocco i dati di produzione.')
        process.exit(1)
    }
    caricaEnv()
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) { console.error('❌ Mancano SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1) }
    const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

    if (APPLICA) {
        console.error('⛔ `--apply` non è ancora autorizzato: la fase F parte solo dopo')
        console.error('   l\'approvazione della prova a vuoto. Rilancia senza `--apply`.')
        process.exit(2)
    }
    console.log('ℹ️  Prova a vuoto: nessuna scrittura, nessuna email.\n')

    // ─── Fotografia PRIMA, per poter dimostrare che non ho scritto niente ───
    /**
     * ⚠️ Deve ALZARE, non restituire `null`.
     * Un conteggio fallito che diventa `null` rende la controprova finale una
     * bugia: `prima` e `dopo` sarebbero due oggetti di soli `null`, identici fra
     * loro, e il programma stamperebbe «nessuna traccia» **senza aver
     * verificato niente**. Il guardiano che non sa cadere non è un guardiano.
     */
    const conta = async (t) => {
        const { count, error } = await conRitentativi(() => db.from(t).select('*', { count: 'exact', head: true }))
        if (error) throw new Error(`conteggio di ${t} fallito: ${error.message || JSON.stringify(error)}`)
        if (typeof count !== 'number') throw new Error(`conteggio di ${t} non numerico: ${JSON.stringify(count)}`)
        return count
    }
    const prima = {
        alunni: await conta('alunni'), parents: await conta('parents'),
        delegates: await conta('delegates'), inviti: await conta('iscrizioni_inviti_credenziali'),
        student_parents: await conta('student_parents'),
    }
    console.log('Fotografia iniziale:', JSON.stringify(prima))

    // ─── Lettura ────────────────────────────────────────────────────────────
    const scuole = await tuttaLaTabella(db, 'schools', 'id, nome')
    const perNomeSede = new Map(scuole.map((s) => [s.nome, s.id]))
    const nomeSede = new Map(scuole.map((s) => [s.id, s.nome]))
    const idInScope = SEDI_IN_SCOPE.map((n) => perNomeSede.get(n)).filter(Boolean)
    if (idInScope.length !== SEDI_IN_SCOPE.length) {
        console.error('❌ Non ho trovato tutte le sedi in scope:', SEDI_IN_SCOPE); process.exit(1)
    }

    const sezioni = await tuttaLaTabella(db, 'sections', 'id, scuola_id, name')
    const caricamenti = await tuttaLaTabella(db, 'iscrizioni_elenco_caricamenti',
        'id, scuola_id, nome_file, caricato_il, attivo, righe_totali', (q) => q.eq('attivo', true))
    const idCaricamentiInScope = caricamenti.filter((c) => idInScope.includes(c.scuola_id)).map((c) => c.id)
    const righeElenco = await tuttaLaTabella(db, 'iscrizioni_elenco_righe',
        'id, caricamento_id, scuola_id, classe, nome, nome_norm, riga_excel, retta, retta_testo',
        (q) => q.in('caricamento_id', idCaricamentiInScope))

    const alunni = await tuttaLaTabella(db, 'alunni',
        'id, scuola_id, nome, cognome, data_nascita, codice_fiscale, section_id, classe_sezione, gender, birth_city, birth_province, birth_nation, codice_belfiore_nascita, residence_address, residence_city, importo_retta_mensile, stato',
        (q) => q.in('scuola_id', idInScope).is('anonimizzato_il', null))

    const legamiSP = await tuttaLaTabella(db, 'student_parents', 'student_id, parent_id, relation_type, is_primary')

    // ⚠️ Niente `.in('id', [~500 uuid])`: PostgREST lo riceve come querystring e
    // l'URL sfora («fetch failed», senza uno status che lo spieghi). La tabella
    // intera sono 550 righe: si legge tutta e si filtra qui.
    const tuttiIGenitori = await tuttaLaTabella(db, 'parents',
        'id, first_name, last_name, gender, birth_date, fiscal_code, birth_city, birth_province, birth_nation, codice_belfiore_nascita, emails, phone_numbers, auth_user_id, residence_address, residence_city, anonimizzato_il')
    const idAlunniInScope = new Set(alunni.map((a) => a.id))
    const idGenitori = new Set(legamiSP.filter((l) => idAlunniInScope.has(l.student_id)).map((l) => l.parent_id))
    const genitori = tuttiIGenitori.filter((g) => idGenitori.has(g.id) && !g.anonimizzato_il)

    const delegatiEsistenti = await tuttaLaTabella(db, 'delegates', 'id, student_id, first_name, last_name, relation')
    const inviti = await tuttaLaTabella(db, 'iscrizioni_inviti_credenziali', 'email_norm, stato, parent_id, auth_user_id')
    const emailGiaInvitate = new Set(inviti.map((i) => testo(i.email_norm).toLowerCase()).filter(Boolean))

    const domandeGrezze = await tuttaLaTabella(db, 'enrollment_submissions',
        'id, scuola_id, data, status, created_at',
        (q) => q.in('scuola_id', idInScope).in('status', ['approved', 'pending']))

    if (!existsSync(EXPORT_JSON)) { console.error('❌ Export KinderTap non trovato:', EXPORT_JSON); process.exit(1) }
    const kt = JSON.parse(readFileSync(EXPORT_JSON, 'utf8'))

    console.log(`\nLetto — elenco ${righeElenco.length} righe · alunni ${alunni.length} · genitori ${genitori.length}`)
    console.log(`        domande ${domandeGrezze.length} · inviti già spediti ${emailGiaInvitate.size} · export ${kt.alunni.length} bambini / ${Object.keys(kt.adulti).length} adulti`)

    const s = {
        db, prima, scuole, perNomeSede, nomeSede, idInScope, sezioni, caricamenti,
        righeElenco, alunni, legamiSP, genitori, delegatiEsistenti, inviti, emailGiaInvitate,
        domandeGrezze, kt,
    }

    const casi = costruisciCasi(s)
    const persone = raccogliPersone(casi, s)
    verificaTutti(persone)
    decidiAzioni(casi, s)
    await scriviConsegna(casi, persone, s)

    // ─── La controprova: la prova a vuoto non deve aver lasciato traccia ────
    const dopo = {
        alunni: await conta('alunni'), parents: await conta('parents'),
        delegates: await conta('delegates'), inviti: await conta('iscrizioni_inviti_credenziali'),
        student_parents: await conta('student_parents'),
    }
    const uguali = JSON.stringify(prima) === JSON.stringify(dopo)
    console.log(`\n${uguali ? '✅' : '❌'} Controprova «nessuna traccia»: ${uguali ? 'i conteggi sono identici a prima' : 'CONTEGGI CAMBIATI → ' + JSON.stringify(dopo)}`)
    if (!uguali) process.exitCode = 1
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Abbinamento — l'elenco è il perimetro, e ci si arriva col matcher vero
// ═══════════════════════════════════════════════════════════════════════════
function costruisciCasi(s) {
    // Le righe dell'elenco, nella forma che `abbina` si aspetta.
    const righePerSede = new Map()
    const rigaPerId = new Map()
    for (const r of s.righeElenco) {
        const riga = {
            id: r.id, classe: testo(r.classe), nome: testo(r.nome),
            riga: r.riga_excel, retta: r.retta, rettaTesto: r.retta_testo,
        }
        rigaPerId.set(r.id, { ...riga, scuolaId: r.scuola_id })
        const l = righePerSede.get(r.scuola_id) ?? []
        l.push(riga); righePerSede.set(r.scuola_id, l)
    }

    const cerca = (scuolaId, nome, cognome) => abbina(nome, cognome, righePerSede.get(scuolaId) ?? [])

    /** rigaId → chi ci è finito sopra, da ciascuna delle tre fonti. */
    const perRiga = new Map()
    for (const id of rigaPerId.keys()) perRiga.set(id, { alunni: [], domande: [], kt: [] })
    const fuoriElenco = { alunni: [], domande: [], kt: [] }
    const ambigui = []

    const deposita = (fonte, esito, carico, etichetta) => {
        if (esito.tipo === 'unico') { perRiga.get(esito.riga.id)[fonte].push(carico); return }
        if (esito.tipo === 'ambiguo') {
            ambigui.push({ fonte, etichetta, righe: esito.righe.map((r) => `${r.classe} · rigo ${r.riga}`).join(' | ') })
            return
        }
        fuoriElenco[fonte].push({ ...carico, simili: esito.simili.map((r) => `${r.classe} · rigo ${r.riga}`).join(' | ') })
    }

    // (a) l'anagrafica di oggi
    for (const a of s.alunni) {
        deposita('alunni', cerca(a.scuola_id, a.nome, a.cognome), a, `alunno ${a.id}`)
    }

    // (b) le domande dal form — approvate E in attesa (decisione 9)
    const domande = s.domandeGrezze.map(domandaDaRigaLocale)
    for (const d of domande) {
        for (const b of d.bambini) {
            deposita('domande', cerca(d.scuolaId, b.nome, b.cognome), { domanda: d, bambino: b }, `domanda ${d.id}`)
        }
    }

    // (c) l'export KinderTap. La sede la dichiara lui; per i 172 senza classe
    //     non la dichiara, e allora si prova in entrambe le sedi in scope — ma
    //     un bambino che risulta in TUTTE E DUE non si assegna a indovinare.
    const legamiPerAlunno = new Map()
    for (const l of s.kt.legami) {
        const v = legamiPerAlunno.get(l.id_alunno) ?? []
        v.push(l); legamiPerAlunno.set(l.id_alunno, v)
    }
    for (const k of s.kt.alunni) {
        const carico = { kt: k, legami: legamiPerAlunno.get(k.id) ?? [] }
        const sedeDichiarata = testo(k.scuolaIdKidville)
        if (sedeDichiarata && s.idInScope.includes(sedeDichiarata)) {
            deposita('kt', cerca(sedeDichiarata, k.name, k.lastName), carico, `export ${k.id}`)
        } else if (!sedeDichiarata) {
            const trovate = s.idInScope
                .map((sid) => ({ sid, esito: cerca(sid, k.name, k.lastName) }))
                .filter((x) => x.esito.tipo === 'unico')
            if (trovate.length === 1) deposita('kt', trovate[0].esito, carico, `export ${k.id}`)
            else if (trovate.length > 1) {
                ambigui.push({ fonte: 'kt', etichetta: `export ${k.id}`, righe: 'compare in più di una sede: senza classe dichiarata non si assegna' })
            }
        }
        // Sede dichiarata FUORI scope (Aversa, o nessuna): non è affar nostro qui.
    }

    // Un caso per riga di elenco.
    const casi = []
    for (const [id, trovati] of perRiga) {
        const riga = rigaPerId.get(id)
        casi.push({
            riga,
            sede: s.nomeSede.get(riga.scuolaId) ?? '?',
            alunno: trovati.alunni[0] ?? null,
            alunniMultipli: trovati.alunni.length > 1 ? trovati.alunni.length : 0,
            domande: trovati.domande,
            kt: trovati.kt[0] ?? null,
            ktMultipli: trovati.kt.length > 1 ? trovati.kt.length : 0,
            genitori: [], delegati: [], motivi: [], azione: null, retta: null, sezione: null,
        })
    }
    casi.__fuoriElenco = fuoriElenco
    casi.__ambigui = ambigui
    console.log(`\nAbbinamento — ${casi.length} righe di elenco`)
    console.log(`  già in anagrafica: ${casi.filter((c) => c.alunno).length} · con domanda dal form: ${casi.filter((c) => c.domande.length).length} · presenti nell'export: ${casi.filter((c) => c.kt).length}`)
    console.log(`  fuori elenco → anagrafica ${fuoriElenco.alunni.length} · domande ${fuoriElenco.domande.length} · export ${fuoriElenco.kt.length}`)
    console.log(`  abbinamenti ambigui: ${ambigui.length}`)
    return casi
}

/** Come `domandaDaRiga` del prodotto, ma su un oggetto già letto. */
function domandaDaRigaLocale(r) {
    const d = r.data ?? {}
    const bambini = Array.isArray(d.children) ? d.children.map((c) => ({
        nome: testo(c?.nome), cognome: testo(c?.cognome),
        codiceFiscale: cfNorm(c?.codice_fiscale), dataNascita: dataIso(c?.data_nascita),
        sesso: sessoNorm(c?.sesso ?? c?.gender),
        comuneNascita: testo(c?.comune_nascita ?? c?.birth_city),
        provinciaNascita: testo(c?.provincia_nascita ?? c?.birth_province),
        nazioneNascita: testo(c?.nazione_nascita ?? c?.birth_nation),
    })) : []
    const adulti = Array.isArray(d.adults) ? d.adults.map((a) => ({
        nome: testo(a?.first_name), cognome: testo(a?.last_name),
        email: emailValida(a?.email), codiceFiscale: cfNorm(a?.fiscal_code),
        ruolo: testo(a?.ruolo).toLowerCase() || null,
        sesso: sessoNorm(a?.sesso ?? a?.gender), dataNascita: dataIso(a?.birth_date),
        comuneNascita: testo(a?.comune_nascita ?? a?.birth_city),
        provinciaNascita: testo(a?.provincia_nascita ?? a?.birth_province),
        nazioneNascita: testo(a?.nazione_nascita ?? a?.birth_nation),
    })) : []
    return { id: r.id, scuolaId: r.scuola_id, stato: r.status, creataIl: r.created_at, bambini, adulti }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · Le persone: un record per essere umano, con la FONTE di ogni campo
// ═══════════════════════════════════════════════════════════════════════════
function raccogliPersone(casi, s) {
    const persone = []
    const genitoriPerAlunno = new Map()
    for (const l of s.legamiSP) {
        const v = genitoriPerAlunno.get(l.student_id) ?? []
        v.push(l); genitoriPerAlunno.set(l.student_id, v)
    }
    const genitorePerId = new Map(s.genitori.map((g) => [g.id, g]))

    /** Sceglie il primo valore utile e dice da dove viene. */
    const scegli = (candidati) => {
        for (const [valore, fonte] of candidati) if (valore !== null && valore !== undefined && valore !== '') return { valore, fonte }
        return { valore: null, fonte: null }
    }

    for (const c of casi) {
        // ─── Il bambino ──────────────────────────────────────────────────────
        const a = c.alunno
        const dom = c.domande[0]?.bambino ?? null
        const k = c.kt?.kt ?? null
        const ba = k ? (k.birthAddress ?? {}) : {}

        const nome = scegli([[a?.nome, 'anagrafica'], [dom?.nome, 'form'], [k?.name, 'export']])
        const cognome = scegli([[a?.cognome, 'anagrafica'], [dom?.cognome, 'form'], [k?.lastName, 'export']])
        const codice = scegli([[cfNorm(a?.codice_fiscale), 'anagrafica'], [dom?.codiceFiscale, 'form'], [cfNorm(k?.personalId), 'export']])
        const nascita = scegli([[a?.data_nascita, 'anagrafica'], [dom?.dataNascita, 'form'], [dataIso(k?.birthDate), 'export']])
        const ses = scegli([[sessoNorm(a?.gender), 'anagrafica'], [dom?.sesso, 'form'], [sessoNorm(k?.gender), 'export']])
        const belf = belfioreDa({
            belfioreGiaScritto: a?.codice_belfiore_nascita,
            cityCode: ba.cityCode,
            comune: a?.birth_city || dom?.comuneNascita || ba.city,
            provincia: a?.birth_province || dom?.provinciaNascita || ba.stateCode,
            nazione: a?.birth_nation || dom?.nazioneNascita || ba.state,
        })

        const bambino = {
            tipo: 'alunno', caso: c, sede: c.sede, classe: c.riga.classe,
            idEsistente: a?.id ?? null, nuovo: !a,
            nome: nome.valore ?? c.riga.nome, cognome: cognome.valore ?? '',
            fonteNome: nome.fonte, cf: codice.valore, fonteCf: codice.fonte,
            dataNascita: nascita.valore, fonteData: nascita.fonte,
            sesso: ses.valore, fonteSesso: ses.fonte,
            belfiore: belf.codice, fonteBelfiore: belf.fonte, motivoBelfiore: belf.motivo,
        }
        persone.push(bambino)
        c.bambino = bambino

        // ─── Gli adulti ──────────────────────────────────────────────────────
        const perChiave = new Map()
        /**
         * @param parentela `{ valore, dichiarata }` — la differenza CONTA.
         *   *dichiarata* = qualcuno l'ha scritta (il form, l'export, la segreteria).
         *   *dedotta*    = nessuno l'ha scritta, e la si ricava da DOVE sta il legame.
         * Una dichiarata batte sempre una dedotta; fra due dichiarate vince la prima,
         * perché le fonti sono in ordine di autorevolezza (anagrafica → form → export).
         */
        const aggiungi = (dati, parentela, fonte) => {
            const chiave = dati.cf ?? chiavePersona(dati.nome, dati.cognome, dati.dataNascita)
            const gia = perChiave.get(chiave)
            if (gia) {
                for (const campo of ['cf', 'email', 'dataNascita', 'sesso', 'belfiore', 'docNumber', 'telefono', 'idEsistente', 'authUserId']) {
                    if (!gia[campo] && dati[campo]) { gia[campo] = dati[campo]; gia[`fonte_${campo}`] = fonte }
                }
                if (parentela.valore && parentela.dichiarata && !gia.parentelaDichiarata) {
                    gia.parentela = parentela.valore
                    gia.parentelaDichiarata = true
                } else if (parentela.valore && !gia.parentela) {
                    gia.parentela = parentela.valore
                }
                if (!gia.fonti.includes(fonte)) gia.fonti.push(fonte)
                if (dati.email && dati.email !== gia.email && !gia.emailAlternative.includes(dati.email)) gia.emailAlternative.push(dati.email)
                return gia
            }
            const nuovo = {
                ...dati, parentela: parentela.valore, parentelaDichiarata: parentela.dichiarata,
                fonti: [fonte], emailAlternative: [],
            }
            perChiave.set(chiave, nuovo)
            return nuovo
        }

        // (a) i genitori già in anagrafica
        for (const l of genitoriPerAlunno.get(a?.id) ?? []) {
            const g = genitorePerId.get(l.parent_id)
            if (!g) continue
            const bg = belfioreDa({
                belfioreGiaScritto: g.codice_belfiore_nascita,
                comune: g.birth_city, provincia: g.birth_province, nazione: g.birth_nation,
            })
            aggiungi({
                idEsistente: g.id, authUserId: g.auth_user_id,
                nome: testo(g.first_name), cognome: testo(g.last_name),
                cf: cfNorm(g.fiscal_code), email: emailValida(primo(g.emails)),
                dataNascita: g.birth_date ?? null, sesso: sessoNorm(g.gender),
                belfiore: bg.codice, belfioreFonte: bg.fonte, belfioreMotivo: bg.motivo,
                docNumber: null,
            }, parentelaDaLegameAnagrafico(l.relation_type), 'anagrafica')
        }

        // (b) gli adulti della domanda dal form — vincono sui dati dell'export
        for (const d of c.domande) {
            for (const ad of d.domanda.adulti) {
                const bg = belfioreDa({ comune: ad.comuneNascita, provincia: ad.provinciaNascita, nazione: ad.nazioneNascita })
                aggiungi({
                    idEsistente: null, authUserId: null,
                    nome: ad.nome, cognome: ad.cognome, cf: ad.codiceFiscale, email: ad.email,
                    dataNascita: ad.dataNascita, sesso: ad.sesso,
                    belfiore: bg.codice, belfioreFonte: bg.fonte, belfioreMotivo: bg.motivo,
                    docNumber: null,
                }, { valore: normalizzaParentela(ad.ruolo), dichiarata: Boolean(ad.ruolo) }, 'form')
            }
        }

        // (c) i legami dell'export: portano nonni e zii, che in anagrafica non ci sono
        for (const l of c.kt?.legami ?? []) {
            const ad = s.kt.adulti[l.id_adulto]
            if (!ad) continue
            const bga = ad.birthAddress ?? {}
            const bg = belfioreDa({
                cityCode: bga.cityCode, comune: bga.city, provincia: bga.stateCode, nazione: bga.state,
            })
            aggiungi({
                idEsistente: null, authUserId: null,
                nome: testo(ad.name), cognome: testo(ad.lastName),
                cf: cfNorm(ad.personalId), email: emailValida(primo(ad.email)),
                dataNascita: dataIso(ad.birthDate), sesso: sessoNorm(ad.gender),
                belfiore: bg.codice, belfioreFonte: bg.fonte, belfioreMotivo: bg.motivo,
                docNumber: testo(ad.docNumber) || null,
                telefono: primo(ad.phoneNumbers),
            }, { valore: testo(l.parentela) || null, dichiarata: Boolean(testo(l.parentela)) }, 'export')
        }

        // ─── Chi prende l'account, chi la delega (decisione 3) ────────────────
        for (const ad of perChiave.values()) {
            const record = {
                tipo: eGenitore(ad) ? 'genitore' : 'parente',
                parentelaDichiarata: ad.parentelaDichiarata,
                caso: c, sede: c.sede,
                idEsistente: ad.idEsistente, authUserId: ad.authUserId,
                nome: ad.nome, cognome: ad.cognome, cf: ad.cf, email: ad.email,
                emailAlternative: ad.emailAlternative, telefono: ad.telefono ?? null,
                dataNascita: ad.dataNascita, sesso: ad.sesso, fonteSesso: ad.sesso ? (ad.fonti[0] ?? null) : null,
                belfiore: ad.belfiore, fonteBelfiore: ad.belfioreFonte, motivoBelfiore: ad.belfioreMotivo,
                parentela: ad.parentela, fonti: ad.fonti, docNumber: ad.docNumber ?? null,
                nuovo: !ad.idEsistente,
            }
            persone.push(record)
            if (record.tipo === 'genitore') c.genitori.push(record)
            else c.delegati.push(record)
        }
    }

    console.log(`\nPersone — ${persone.length} in tutto`)
    console.log(`  bambini ${persone.filter((p) => p.tipo === 'alunno').length} · genitori ${persone.filter((p) => p.tipo === 'genitore').length} · altri parenti (deleghe) ${persone.filter((p) => p.tipo === 'parente').length}`)
    return persone
}

/**
 * La parentela che un legame di `student_parents` porta con sé.
 *
 * 🔑 **Il campo vuoto NON vuol dire «non è un genitore».** In produzione, al
 * 2026-08-30, **581 legami su 618 hanno `relation_type` NULL**: la tabella si
 * chiama `student_parents` e una riga lì dentro È un legame genitoriale — il
 * campo vuoto dice soltanto che nessuno ha annotato *quale dei due*.
 *
 * Leggerlo come «parentela sconosciuta ⇒ non è un genitore» spingeva 201 bambini
 * in «da rivedere» per «nessuna email», mentre i loro genitori erano lì, in
 * anagrafica, con l'indirizzo giusto. La parentela così ricavata è **dedotta**,
 * non dichiarata, e cede il passo a qualunque fonte che la dichiari davvero.
 */
function parentelaDaLegameAnagrafico(relationType) {
    const dichiarata = normalizzaParentela(relationType)
    if (dichiarata) return { valore: dichiarata, dichiarata: true }
    return { valore: 'genitore-non-specificato', dichiarata: false }
}

/** Chi ha diritto a un account: madre, padre, o un legame genitoriale non specificato. */
function eGenitore(adulto) {
    const p = adulto.parentela ?? ''
    return PARENTELE_GENITORE.has(p) || p === 'genitore-non-specificato'
}

/** Le tante parole per «madre» ridotte alle chiavi di KinderTap. */
function normalizzaParentela(v) {
    const p = testo(v).toLowerCase()
    if (!p) return null
    if (/^(madre|mamma|mother|mum)/.test(p)) return 'mother'
    if (/^(padre|papà|papa|father|dad)/.test(p)) return 'father'
    // «genitore» generico vale come genitore, ma NON si sceglie quale dei due:
    // scriverlo «mother» inventerebbe un dato che nessuno ha dichiarato.
    if (/^(genitore|parent|tutore|tutor)/.test(p)) return 'genitore-non-specificato'
    if (/nonn[ao]|grandmother|grandfather/.test(p)) return p.includes('grandf') || p.includes('nonno') ? 'grandfather' : 'grandmother'
    if (/^(zi[ao]|aunt|uncle)/.test(p)) return p.startsWith('zio') || p === 'uncle' ? 'uncle' : 'aunt'
    return p
}

// ═══════════════════════════════════════════════════════════════════════════
// 6 · Codici fiscali (punto 7)
// ═══════════════════════════════════════════════════════════════════════════
function verificaTutti(persone) {
    let sessoDalCodice = 0
    for (const p of persone) {
        // Il sesso: prima l'anagrafica/form/export (fonti INDIPENDENTI dal codice),
        // e solo in ultima istanza il codice stesso — che allora non verifica sé.
        let sesso = p.sesso
        let fonteSesso = p.fonteSesso ?? (p.sesso ? 'anagrafica/form/export' : null)
        if (!sesso && p.cf) {
            const letto = sessoDaCodiceFiscale(p.cf)
            if (letto) { sesso = letto; fonteSesso = 'DEDOTTO DAL CODICE (non è una verifica)'; sessoDalCodice++ }
        }
        p.sessoUsato = sesso
        p.fonteSessoUsato = fonteSesso

        p.verifica = verificaPersona({
            nome: p.nome, cognome: p.cognome, cf: p.cf,
            dataNascita: p.dataNascita, sesso, sessoFonte: fonteSesso,
            belfiore: p.belfiore, belfioreFonte: p.fonteBelfiore, belfioreMotivo: p.motivoBelfiore,
        })

        // L'euristica chiesta alla domanda 7: solo per i sessi DEDOTTI dal codice.
        p.contraddizioneNome = null
        p.euristicaSiPronuncia = false
        if (fonteSesso?.startsWith('DEDOTTO')) {
            const sugg = sessoSuggeritoDalNome(p.nome)
            p.euristicaSiPronuncia = sugg !== null
            if (sugg && sesso && sugg !== sesso) p.contraddizioneNome = `nome «${p.nome}» suggerisce ${sugg}, il codice dice ${sesso}`
        }
    }
    // 🔑 «Zero contraddizioni» va letto insieme a «su quanti si è pronunciata».
    // Zero su zero non è un esito rassicurante: è un'euristica che non guarda.
    const dedotti = persone.filter((p) => p.fonteSessoUsato?.startsWith('DEDOTTO'))
    const pronunciata = dedotti.filter((p) => p.euristicaSiPronuncia).length
    const per = (st) => persone.filter((p) => p.verifica.stato === st).length
    console.log(`\nCodici fiscali — VERIFICATI ${per('VERIFICATO')} · DA CONTROLLARE ${per('DA CONTROLLARE')} · NON VERIFICABILI ${per('NON VERIFICABILE')}`)
    console.log(`  sesso dedotto dal codice (verifica parziale): ${sessoDalCodice}`)
    console.log(`  euristica sesso/nome: si è pronunciata su ${pronunciata} dei ${dedotti.length} dedotti · contraddizioni trovate: ${persone.filter((p) => p.contraddizioneNome).length}`)
    console.log(`  codici omocodici riconosciuti come corretti: ${persone.filter((p) => p.verifica.omocodia).length}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 7 · La decisione, bambino per bambino
// ═══════════════════════════════════════════════════════════════════════════
function decidiAzioni(casi, s) {
    const sezioniPerSede = new Map()
    for (const se of s.sezioni) {
        const k = se.scuola_id
        const m = sezioniPerSede.get(k) ?? new Map()
        m.set(normalizzaNome(se.name), se); sezioniPerSede.set(k, m)
    }

    // I fratelli servono a `risolviRetta`: si riconoscono dal CF di un genitore.
    const casiPerCfGenitore = new Map()
    for (const c of casi) {
        for (const g of c.genitori) {
            if (!g.cf) continue
            const v = casiPerCfGenitore.get(g.cf) ?? []
            v.push(c); casiPerCfGenitore.set(g.cf, v)
        }
    }

    for (const c of casi) {
        c.motivi = []

        // (1) la sezione deve esistere davvero, col nome esatto
        const sez = sezioniPerSede.get(c.riga.scuolaId)?.get(normalizzaNome(c.riga.classe)) ?? null
        c.sezione = sez
        if (!sez) c.motivi.push(`la classe «${c.riga.classe}» non è fra le sezioni della sede`)

        // (2) la retta, col modulo del prodotto
        const fratelli = new Set()
        for (const g of c.genitori) for (const altro of casiPerCfGenitore.get(g.cf) ?? []) if (altro !== c) fratelli.add(altro.riga)
        const esitoRetta = risolviRetta(c.riga, [...fratelli])
        c.retta = esitoRetta
        if (esitoRetta.tipo === 'da_controllare') c.motivi.push(`retta: ${esitoRetta.motivo}`)

        // (3) i genitori con un'email valida
        c.genitoriInvitabili = c.genitori.filter((g) => g.email)
        c.genitoriGiaInvitati = c.genitoriInvitabili.filter((g) => s.emailGiaInvitate.has(g.email))
        c.genitoriDaInvitare = c.genitoriInvitabili.filter((g) => !s.emailGiaInvitate.has(g.email))
        if (c.genitoriInvitabili.length === 0) {
            c.motivi.push(c.genitori.length === 0
                ? 'nessun genitore trovato in nessuna delle tre fonti'
                : `${c.genitori.length} genitore/i trovati, nessuno con un'email valida`)
        }

        // (4) gli abbinamenti che non stanno in piedi
        if (c.alunniMultipli) c.motivi.push(`${c.alunniMultipli} alunni in anagrafica corrispondono a questo nome`)
        if (c.ktMultipli) c.motivi.push(`${c.ktMultipli} bambini dell'export corrispondono a questo nome`)
        if (c.domande.length > 1) c.motivi.push(`${c.domande.length} domande dal form per lo stesso bambino`)

        // (5) il codice fiscale del bambino: segnalato, MAI bloccante
        if (c.bambino?.verifica?.stato === 'DA CONTROLLARE') {
            c.avvisoCf = `codice fiscale da controllare: ${c.bambino.verifica.campiCheNonTornano.join(', ') || c.bambino.verifica.motiviFormali.join(', ')}`
        }

        c.azione = c.motivi.length > 0 ? 'DA RIVEDERE'
            : c.genitoriDaInvitare.length > 0 ? 'INVIA'
                : 'GIÀ A POSTO'

        // Non tutti i blocchi si somigliano, e il titolare deve poterli separare:
        //  · «manca un dato» → serve andarlo a prendere fuori dal sistema;
        //  · «serve una decisione» → la segreteria la prende e il caso si sblocca;
        //  · «l'abbinamento non regge» → serve un occhio umano su due nomi.
        // Contarli insieme darebbe un solo numero grande e inutile.
        c.blocco = c.motivi.length === 0 ? null
            : c.genitoriInvitabili.length === 0 ? 'manca un dato (nessun genitore raggiungibile)'
                : !c.sezione ? 'manca un dato (classe inesistente)'
                    : (c.alunniMultipli || c.ktMultipli || c.domande.length > 1) ? 'abbinamento da confermare'
                        : 'serve una decisione (retta)'
    }

    const per = (a) => casi.filter((c) => c.azione === a).length
    console.log(`\nDecisione — INVIA ${per('INVIA')} · GIÀ A POSTO ${per('GIÀ A POSTO')} · DA RIVEDERE ${per('DA RIVEDERE')}`)
    console.log(`  email che partirebbero: ${casi.reduce((n, c) => n + (c.azione === 'INVIA' ? c.genitoriDaInvitare.length : 0), 0)}`)
    console.log(`  deleghe al ritiro da creare: ${casi.reduce((n, c) => n + (c.azione !== 'DA RIVEDERE' ? c.delegati.length : 0), 0)}`)
    const blocchi = {}
    for (const c of casi) if (c.blocco) blocchi[c.blocco] = (blocchi[c.blocco] ?? 0) + 1
    for (const [k, v] of Object.entries(blocchi).sort((a, b) => b[1] - a[1])) console.log(`    · ${v} × ${k}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 8 · La consegna — i file escono QUI, fuori dal repo. Il repo è pubblico.
// ═══════════════════════════════════════════════════════════════════════════
async function scriviConsegna(casi, persone, s) {
    // La data del FUSO DELLA SCUOLA, non quella UTC: a mezzanotte e mezza di
    // Giugliano `toISOString()` scrive ancora ieri, e la cartella di consegna
    // porterebbe una data che non corrisponde a nessun giorno di lavoro.
    const oggi = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date())
    const cartella = join(CARTELLA_LAVORO, `consegna-${oggi}`)
    mkdirSync(cartella, { recursive: true })

    const foglio = (righe) => XLSX.utils.json_to_sheet(righe.length ? righe : [{ '(vuoto)': 'nessuna riga' }])
    const libro = (fogli) => {
        const wb = XLSX.utils.book_new()
        for (const [nome, righe] of fogli) XLSX.utils.book_append_sheet(wb, foglio(righe), nome.slice(0, 31))
        return wb
    }

    // ── 01 · il quadro, una riga per bambino ────────────────────────────────
    const quadro = casi.map((c) => ({
        Sede: c.sede, Classe: c.riga.classe, 'Rigo Excel': c.riga.riga,
        Bambino: `${c.bambino.cognome} ${c.bambino.nome}`.trim(),
        'In anagrafica': c.alunno ? 'sì' : 'NO — da creare',
        'Domanda dal form': c.domande.length ? c.domande.map((d) => d.domanda.stato).join(', ') : 'nessuna',
        "Nell'export": c.kt ? 'sì' : 'no',
        'Sezione esiste': c.sezione ? 'sì' : 'NO',
        Retta: c.retta?.tipo === 'importo' ? c.retta.importo
            : c.retta?.tipo === 'a_carico' ? `a carico di ${c.retta.aCaricoDi.nome}` : `⚠ ${c.retta?.motivo ?? ''}`,
        'CF bambino': c.bambino.cf ?? '',
        'Esito CF': c.bambino.verifica.stato,
        Genitori: c.genitori.length,
        'Genitori con email': c.genitoriInvitabili.length,
        'Già invitati': c.genitoriGiaInvitati.length,
        'Email che partirebbero': c.azione === 'INVIA' ? c.genitoriDaInvitare.length : 0,
        'Deleghe al ritiro': c.delegati.length,
        AZIONE: c.azione,
        Motivi: c.motivi.join(' | '),
        Avvisi: c.avvisoCf ?? '',
    }))
    XLSX.writeFile(libro([['Quadro', quadro]]), join(cartella, '01-quadro.xlsx'))

    // ── 02 · da rivedere, un foglio per motivo ──────────────────────────────
    const daRivedere = casi.filter((c) => c.azione === 'DA RIVEDERE')
    const riga = (c, motivo) => ({
        Sede: c.sede, Classe: c.riga.classe, 'Rigo Excel': c.riga.riga,
        Bambino: `${c.bambino.cognome} ${c.bambino.nome}`.trim(),
        'CF bambino': c.bambino.cf ?? '', Motivo: motivo,
        'Genitori trovati': c.genitori.length, 'Con email': c.genitoriInvitabili.length,
    })
    XLSX.writeFile(libro([
        ['Classe inesistente', daRivedere.filter((c) => !c.sezione).map((c) => riga(c, `la classe «${c.riga.classe}» non è fra le sezioni della sede`))],
        ['Senza email', daRivedere.filter((c) => c.genitoriInvitabili.length === 0).map((c) => riga(c, c.genitori.length ? 'genitori trovati, nessuna email valida' : 'nessun genitore in nessuna fonte'))],
        ['Retta da chiarire', daRivedere.filter((c) => c.retta?.tipo === 'da_controllare').map((c) => riga(c, c.retta.motivo))],
        ['Abbinamento ambiguo', daRivedere.filter((c) => c.alunniMultipli || c.ktMultipli || c.domande.length > 1).map((c) => riga(c, c.motivi.filter((m) => m.includes('corrispondono') || m.includes('domande')).join(' | ')))],
        ['Fuori elenco - anagrafica', (casi.__fuoriElenco?.alunni ?? []).map((a) => ({ Sede: s.nomeSede.get(a.scuola_id) ?? '?', Bambino: `${a.cognome ?? ''} ${a.nome ?? ''}`.trim(), 'CF': a.codice_fiscale ?? '', Nota: 'in anagrafica ma in nessun elenco: non risulta iscritto per il 2026/27', 'Forse cercavi': a.simili ?? '' }))],
        ['Fuori elenco - export', (casi.__fuoriElenco?.kt ?? []).map((x) => ({ Bambino: `${x.kt?.lastName ?? ''} ${x.kt?.name ?? ''}`.trim(), 'CF': x.kt?.personalId ?? '', Classe_KinderTap: x.kt?.classe ?? '', Nota: "nell'export ma in nessun elenco: nessun invito", 'Forse cercavi': x.simili ?? '' }))],
        ['Ambigui in abbinamento', (casi.__ambigui ?? []).map((a) => ({ Fonte: a.fonte, Riferimento: a.etichetta, 'Righe candidate': a.righe }))],
    ]), join(cartella, '02-da-rivedere.xlsx'))

    // ── 02bis · la controprova sui bambini «di cui non sappiamo niente» ─────
    // «Non l'ho trovato» e «non esiste» sono due cose diverse, e confonderle qui
    // costerebbe caro: nel primo caso la famiglia esiste e resterebbe fuori per
    // un refuso, nel secondo va davvero chiesta alla segreteria. Per ogni riga
    // rimasta senza NESSUNA fonte si cercano i tre nomi più somiglianti fra tutti
    // i bambini dell'export e di tutta l'anagrafica, SENZA vincolo di sede.
    const orfani = casi.filter((c) => !c.alunno && !c.domande.length && !c.kt)
    const universo = [
        ...s.kt.alunni.map((k) => ({ etichetta: `export · ${testo(k.classe) || 'senza classe'} · ${testo(k.sedeKidville) || 'sede non dichiarata'}`, nome: `${testo(k.lastName)} ${testo(k.name)}` })),
        ...s.alunni.map((a) => ({ etichetta: `anagrafica · ${s.nomeSede.get(a.scuola_id) ?? '?'}`, nome: `${testo(a.cognome)} ${testo(a.nome)}` })),
    ].map((x) => ({ ...x, norm: normalizzaNome(x.nome) }))

    const controprova = orfani.map((c) => {
        const cercato = normalizzaNome(c.riga.nome)
        const migliori = universo
            .map((u) => ({ ...u, punteggio: similitudine(cercato, u.norm) }))
            .sort((a, b) => b.punteggio - a.punteggio)
            .slice(0, 3)
            .filter((m) => m.punteggio > 0.6)

        // ⚠️ La soglia conta più del conteggio. A 0,6 «somigliante» comprende
        // mezza scuola: in un paese i cognomi si ripetono e i fratelli pure, e
        // due bambini diversi arrivano al 70% senza nessuna parentela. Solo dal
        // 90% in su la somiglianza è indizio di refuso; sotto, mandare qualcuno
        // a controllare è farlo lavorare a vuoto e insegnargli a ignorare l'elenco.
        const p = migliori[0]?.punteggio ?? 0
        const verdetto = p >= 0.9
            ? 'PROBABILE REFUSO — quasi certamente è la stessa persona scritta in altro modo: da confermare'
            : p > 0
                ? 'SOMIGLIANZA DEBOLE — con ogni probabilità è un\'altra persona; i candidati sono solo per scrupolo'
                : 'NESSUNA TRACCIA — di questo bambino non esiste nient\'altro: va chiesto alla segreteria'
        return {
            Sede: c.sede, Classe: c.riga.classe, 'Rigo Excel': c.riga.riga,
            'Nome nel foglio': c.riga.nome,
            Verdetto: verdetto,
            'Candidato 1': migliori[0] ? `${migliori[0].nome} (${(migliori[0].punteggio * 100).toFixed(0)}% · ${migliori[0].etichetta})` : '',
            'Candidato 2': migliori[1] ? `${migliori[1].nome} (${(migliori[1].punteggio * 100).toFixed(0)}% · ${migliori[1].etichetta})` : '',
            'Candidato 3': migliori[2] ? `${migliori[2].nome} (${(migliori[2].punteggio * 100).toFixed(0)}% · ${migliori[2].etichetta})` : '',
        }
    })
    const refusi = controprova.filter((r) => r.Verdetto.startsWith('PROBABILE REFUSO')).length
    const deboli = controprova.filter((r) => r.Verdetto.startsWith('SOMIGLIANZA DEBOLE')).length
    console.log(`\nControprova sui ${orfani.length} bambini senza nessuna fonte:`)
    console.log(`  ${refusi} probabili refusi (somiglianza ≥ 90%): vale la pena guardarli`)
    console.log(`  ${deboli} somiglianze deboli (61-89%): quasi certamente altre persone`)
    console.log(`  ${orfani.length - refusi - deboli} senza nessuna traccia da nessuna parte`)
    XLSX.writeFile(libro([['Senza nessuna fonte', controprova]]), join(cartella, '02bis-nessuna-traccia.xlsx'))

    // ── 03 · codici fiscali: i tre elenchi del punto 7 ──────────────────────
    const verificati = persone.filter((p) => p.verifica.stato === 'VERIFICATO')
    const daControllare = persone.filter((p) => p.verifica.stato === 'DA CONTROLLARE')
    const nonVerificabili = persone.filter((p) => p.verifica.stato === 'NON VERIFICABILE')
    const etichettaTipo = (p) => (p.tipo === 'alunno' ? 'alunno' : p.tipo === 'genitore' ? 'genitore' : 'altro parente')

    XLSX.writeFile(libro([
        ['Riepilogo', [
            { Elenco: 'VERIFICATI', Totale: verificati.length, 'di cui alunni': verificati.filter((p) => p.tipo === 'alunno').length, 'di cui genitori': verificati.filter((p) => p.tipo === 'genitore').length },
            { Elenco: 'DA CONTROLLARE', Totale: daControllare.length, 'di cui alunni': daControllare.filter((p) => p.tipo === 'alunno').length, 'di cui genitori': daControllare.filter((p) => p.tipo === 'genitore').length },
            { Elenco: 'NON VERIFICABILI', Totale: nonVerificabili.length, 'di cui alunni': nonVerificabili.filter((p) => p.tipo === 'alunno').length, 'di cui genitori': nonVerificabili.filter((p) => p.tipo === 'genitore').length },
            { Elenco: 'di cui codici OMOCODICI (corretti)', Totale: persone.filter((p) => p.verifica.omocodia).length },
        ]],
        ['DA CONTROLLARE', daControllare.map((p) => ({
            Tipo: etichettaTipo(p), Sede: p.sede, Persona: `${p.cognome} ${p.nome}`.trim(),
            'Codice nel file': p.verifica.codiceNelFile,
            'Codice calcolato': p.verifica.codiceCalcolato,
            'Campo che non torna': p.verifica.campiCheNonTornano.join(', ') || p.verifica.motiviFormali.join(', '),
            'Formalmente valido': p.verifica.validoFormalmente ? 'sì' : 'NO',
            'Data di nascita usata': p.dataNascita ?? '', 'Sesso usato': p.sessoUsato ?? '',
            'Fonte del sesso': p.fonteSessoUsato ?? '', 'Belfiore usato': p.belfiore ?? '',
            'Fonte del luogo': p.fonteBelfiore ?? '',
        }))],
        ['NON VERIFICABILI', nonVerificabili.map((p) => ({
            Tipo: etichettaTipo(p), Sede: p.sede, Persona: `${p.cognome} ${p.nome}`.trim(),
            'Codice nel file': p.verifica.codiceNelFile,
            'Formalmente valido': p.verifica.codiceNelFile ? (p.verifica.validoFormalmente ? 'sì' : 'NO') : '(nessun codice)',
            'DATO CHE MANCA': p.verifica.datiMancanti.join(' · ') || 'codice fiscale assente',
        }))],
        ['Sesso dedotto dal codice', persone.filter((p) => p.fonteSessoUsato?.startsWith('DEDOTTO')).map((p) => ({
            Tipo: etichettaTipo(p), Persona: `${p.cognome} ${p.nome}`.trim(), Sede: p.sede,
            'Sesso dedotto': p.sessoUsato,
            Nota: 'la componente «sesso» è stata letta dal codice stesso: su questa riga NON costituisce verifica',
        }))],
        ['Contraddizioni sesso-nome', persone.filter((p) => p.contraddizioneNome).map((p) => ({
            Tipo: etichettaTipo(p), Persona: `${p.cognome} ${p.nome}`.trim(), Sede: p.sede,
            Rilievo: p.contraddizioneNome,
            Avvertenza: 'EURISTICA, non una prova: dà falsi allarmi su nomi stranieri e su Andrea, Simone, Nicola',
        }))],
    ]), join(cartella, '03-codici-fiscali.xlsx'))

    // ── 04 · differenze fra le fonti ────────────────────────────────────────
    const differenze = []
    for (const c of casi) {
        const a = c.alunno, dom = c.domande[0]?.bambino, k = c.kt?.kt
        const confronta = (campo, vForm, vExport, vDb) => {
            const f = testo(vForm), e = testo(vExport), d = testo(vDb)
            if (f && e && normalizzaNome(f) !== normalizzaNome(e)) {
                differenze.push({ Sede: c.sede, Classe: c.riga.classe, Bambino: `${c.bambino.cognome} ${c.bambino.nome}`.trim(), Campo: campo, 'Nel form (vale questo)': f, "Nell'export": e, 'In anagrafica': d })
            }
        }
        confronta('cognome', dom?.cognome, k?.lastName, a?.cognome)
        confronta('nome', dom?.nome, k?.name, a?.nome)
        confronta('codice fiscale', dom?.codiceFiscale, cfNorm(k?.personalId), cfNorm(a?.codice_fiscale))
        confronta('data di nascita', dom?.dataNascita, dataIso(k?.birthDate), a?.data_nascita)
        if (a && c.retta?.tipo === 'importo' && a.importo_retta_mensile != null && Number(a.importo_retta_mensile) !== c.retta.importo) {
            differenze.push({ Sede: c.sede, Classe: c.riga.classe, Bambino: `${c.bambino.cognome} ${c.bambino.nome}`.trim(), Campo: 'retta', 'Nel form (vale questo)': `elenco Excel: ${c.retta.importo}`, "Nell'export": '', 'In anagrafica': String(a.importo_retta_mensile) })
        }
        if (a && c.sezione && a.section_id && a.section_id !== c.sezione.id) {
            differenze.push({ Sede: c.sede, Classe: c.riga.classe, Bambino: `${c.bambino.cognome} ${c.bambino.nome}`.trim(), Campo: 'classe', 'Nel form (vale questo)': `elenco Excel: ${c.riga.classe}`, "Nell'export": k?.classe ?? '', 'In anagrafica': a.classe_sezione ?? a.section_id })
        }
    }
    XLSX.writeFile(libro([['Differenze', differenze]]), join(cartella, '04-differenze-form-export.xlsx'))

    // ── 05 · backfill proposto ──────────────────────────────────────────────
    const backfill = []
    for (const p of persone) {
        if (!p.idEsistente) continue
        const proposte = []
        if (p.belfiore && p.fonteBelfiore !== 'anagrafica') proposte.push(`codice_belfiore_nascita = ${p.belfiore} (${p.fonteBelfiore})`)
        if (p.sesso && p.fonteSesso && p.fonteSesso !== 'anagrafica') proposte.push(`sesso = ${p.sesso} (${p.fonteSesso})`)
        if (proposte.length) {
            backfill.push({
                Tipo: p.tipo === 'alunno' ? 'alunno' : 'genitore', Sede: p.sede,
                Persona: `${p.cognome} ${p.nome}`.trim(), Id: p.idEsistente,
                'Campi da riempire': proposte.join(' · '),
            })
        }
    }
    XLSX.writeFile(libro([['Backfill proposto', backfill]]), join(cartella, '05-backfill-proposto.xlsx'))

    // ── 06 · la nota per la segreteria di Aversa ────────────────────────────

    // ── 00 · il riassunto ───────────────────────────────────────────────────
    const emailTotali = casi.reduce((n, c) => n + (c.azione === 'INVIA' ? c.genitoriDaInvitare.length : 0), 0)
    const riassunto = {
        generato: new Date().toISOString(),
        perimetro: { sediInScope: SEDI_IN_SCOPE, sedeEsclusa: SEDE_ESCLUSA, righeElenco: casi.length },
        bambini: {
            totali: casi.length,
            giaInAnagrafica: casi.filter((c) => c.alunno).length,
            daCreare: casi.filter((c) => !c.alunno).length,
            conDomandaDalForm: casi.filter((c) => c.domande.length).length,
            soloDallExport: casi.filter((c) => !c.domande.length && c.kt).length,
        },
        azioni: {
            INVIA: casi.filter((c) => c.azione === 'INVIA').length,
            GIA_A_POSTO: casi.filter((c) => c.azione === 'GIÀ A POSTO').length,
            DA_RIVEDERE: casi.filter((c) => c.azione === 'DA RIVEDERE').length,
        },
        perche_da_rivedere: casi.reduce((acc, c) => {
            if (c.blocco) acc[c.blocco] = (acc[c.blocco] ?? 0) + 1
            return acc
        }, {}),
        senza_nessuna_fonte: {
            totale: controprova.length,
            probabili_refusi: controprova.filter((r) => r.Verdetto.startsWith('PROBABILE REFUSO')).length,
            somiglianze_deboli: controprova.filter((r) => r.Verdetto.startsWith('SOMIGLIANZA DEBOLE')).length,
            nessuna_traccia: controprova.filter((r) => r.Verdetto.startsWith('NESSUNA TRACCIA')).length,
        },
        email: { partirebbero: emailTotali, giaSpediteInPassato: s.emailGiaInvitate.size },
        genitori: {
            totali: persone.filter((p) => p.tipo === 'genitore').length,
            conEmail: persone.filter((p) => p.tipo === 'genitore' && p.email).length,
            senzaEmail: persone.filter((p) => p.tipo === 'genitore' && !p.email).length,
        },
        delegheAlRitiro: persone.filter((p) => p.tipo === 'parente').length,
        codiciFiscali: {
            VERIFICATI: verificati.length,
            DA_CONTROLLARE: daControllare.length,
            NON_VERIFICABILI: nonVerificabili.length,
            omocodiciRiconosciuti: persone.filter((p) => p.verifica.omocodia).length,
            sessoDedottoDalCodice: persone.filter((p) => p.fonteSessoUsato?.startsWith('DEDOTTO')).length,
            contraddizioniSessoNome: persone.filter((p) => p.contraddizioneNome).length,
        },
        backfillProposto: backfill.length,
        differenzeFraFonti: differenze.length,
    }
    writeFileSync(join(cartella, '00-riassunto.json'), JSON.stringify(riassunto, null, 2))

    // Il bucket di destinazione accetta SOLO xlsx/xls, ed è giusto che sia così:
    // è un controllo di sicurezza, non un intralcio da allargare per comodità.
    // Quindi riassunto e nota esistono in due forme — leggibile qui, xlsx là.
    const distendi = (obj, prefisso = '') => Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? distendi(v, prefisso ? `${prefisso} · ${k}` : k)
            : [{ Voce: prefisso ? `${prefisso} · ${k}` : k, Valore: Array.isArray(v) ? v.join(', ') : String(v) }])
    XLSX.writeFile(libro([['Riassunto', distendi(riassunto)]]), join(cartella, '00-riassunto.xlsx'))

    const FILE = [
        '00-riassunto.xlsx', '01-quadro.xlsx', '02-da-rivedere.xlsx', '02bis-nessuna-traccia.xlsx',
        '03-codici-fiscali.xlsx', '04-differenze-form-export.xlsx', '05-backfill-proposto.xlsx',
    ]
    console.log(`\n📁 Consegna scritta in ${cartella}`)
    for (const f of FILE) console.log(`   · ${f}`)

    // ── Nel bucket PRIVATO, mai nel repo ────────────────────────────────────
    // Questi file portano nomi di minori. Il repository è pubblico e un nome
    // committato non si cancella più: la copia condivisibile vive qui.
    // `iscrizioni_elenchi` è privato (`public: false`) e l'app non lo enumera
    // mai — vi accede solo per percorso esatto, ricavato da una riga di
    // `iscrizioni_elenco_caricamenti` — quindi un prefisso nuovo non interferisce.
    const BUCKET = 'iscrizioni_elenchi'
    const PREFISSO = `consegna-anagrafica-${oggi}`
    let caricati = 0
    for (const f of FILE) {
        const corpo = readFileSync(join(cartella, f))
        const { error } = await s.db.storage.from(BUCKET).upload(`${PREFISSO}/${f}`, corpo, {
            upsert: true,
            contentType: f.endsWith('.xlsx')
                ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                : f.endsWith('.json') ? 'application/json' : 'text/markdown',
        })
        if (error) console.log(`   ⚠️  ${f} NON caricato: ${error.message}`)
        else caricati++
    }
    console.log(`\n🔒 Bucket privato ${BUCKET}/${PREFISSO}/ — ${caricati}/${FILE.length} file caricati`)

    return riassunto
}

/**
 * ⚰️ `notaAversa()` STAVA QUI, ed è stata tolta il 2026-08-31.
 *
 * Era 83 righe di markdown cablate a mano, con i numeri misurati il 30/08 (117
 * righe, 71 bambini, la classe `RETTE`) e la richiesta alla segreteria di rifare
 * il file. Quel testo diceva anche che nessuno poteva dedurre quale sezione del
 * foglio corrispondesse a quale sezione in anagrafica.
 *
 * Non è più vero niente di tutto ciò: la corrispondenza è stata misurata, il file
 * ricostruito e ricaricato, i 73 alunni riallineati. Un documento che descrive uno
 * stato che non esiste più è peggio di nessun documento — è esattamente la lezione
 * che questo repository ha già pagato due volte, e non si lascia in giro una terza
 * copia che invecchia da sola.
 *
 * Quello che vale la pena ricordare è in `scripts/lib/blocchi-aversa.mjs` e nel
 * commento della migrazione `20260831192032_aversa_due_sezioni_di_due_anni.sql`.
 */


if (import.meta.url === `file://${process.argv[1]}`) {
    await main()
}
