#!/usr/bin/env node
/**
 * Ricostruisce l'elenco classi di Kidville Aversa nella forma che il lettore
 * capisce — un foglio per sezione — a partire dalle righe già in produzione.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * `elenco_rette_aversa.xlsx` (26/08) è UN FOGLIO SOLO, chiamato `RETTE`, con i
 * nomi delle sezioni scritti come righe in mezzo ai nomi dei bambini. Il lettore
 * lo legge in Forma A — dove il nome del foglio È la classe — e ha scritto
 * `classe = 'RETTE'` su tutte e 117 le righe. `RETTE` non è una sezione, e il
 * trigger `sync_alunno_section_id` quando non trova corrispondenza lascia
 * `section_id` NULL SENZA SOLLEVARE NIENTE: 73 bambini iscritti e invisibili a
 * ogni appello, con 87 credenziali già spedite alle loro famiglie.
 *
 * ─── DA DOVE PRENDE I DATI, E PERCHÉ NON DAL FILE ───────────────────────────
 * Da `iscrizioni_elenco_righe`, non dal .xlsx originale. Quelle righe sono già
 * passate da `normalizzaNome` ed è contro di loro che `abbina()` fa oggi centro
 * su tutti e 73 gli alunni creati. Ripartire da lì rende questa una pura
 * RI-FORMA: nessuna riga viene reinterpretata.
 *
 * ─── I CONFINI DEI BLOCCHI NON SONO CABLATI ─────────────────────────────────
 * Si ricavano dalle righe di intestazione sopravvissute in tabella, riconosciute
 * dal fatto che nella colonna della retta c'è la parola «RETTA». Il nome del
 * primo blocco è l'unico dato che la tabella non ha — la riga 1 del foglio è
 * stata consumata come intestazione — ed è stato LETTO dal file originale nel
 * bucket: dice «MERAVIGLIE».
 *
 * ─── CHE OGNI BLOCCO SIA LA FASCIA D'ETÀ CHE DICE, È MISURATO DUE VOLTE ─────
 *   1. sulle date di nascita dei bambini di ciascun blocco (2026/27);
 *   2. sull'export del vecchio registro (2025/26): la stessa sede aveva SEI
 *      sezioni e ognuna teneva l'anno di nascita PRECEDENTE. Il nome resta
 *      attaccato alla fascia d'età, non alla coorte.
 * Nessuna riga di questo script deduce la classe dalla data di nascita: la
 * classe viene dal foglio, sempre. Le date sono state la prova, non il criterio.
 *
 * ─── I DATI PERSONALI NON PASSANO DALLA CHAT ────────────────────────────────
 * A schermo solo conteggi. I nomi stanno nei file, che vivono fuori dal repo
 * (`~/kindertap-export/`). Il repo è pubblico.
 *
 * ─── PERCHÉ PUÒ ANCHE CARICARLO ────────────────────────────────────────────
 * Con `--carica` ripete i passi 5→8 di `POST /api/admin/iscrizioni/elenco`
 * usando LE STESSE due funzioni della route — `leggiElenco` e
 * `anomalieClassiSenzaSezione` — e la stessa disfatta a metà strada. Non c'è una
 * seconda copia della regola: c'è un secondo modo di invocarla, per una sede che
 * non può aspettare che qualcuno apra il pannello. `caricato_da` resta NULL, che
 * è come il resto del codice scrive «l'ha fatto il sistema».
 *
 * Uso:
 *   node scripts/ricostruisci-elenco-aversa.mjs             # costruisce e collauda
 *   node scripts/ricostruisci-elenco-aversa.mjs --carica    # ...e lo carica in produzione
 */

import './lib/risolvi-ts.mjs'

import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

const RADICE = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const CARTELLA_LAVORO = join(homedir(), 'kindertap-export')

const { normalizzaNome, senzaSpazi, tokenNome, stessiToken, similitudine } =
    await import('../src/lib/iscrizioni/import/normalizza.ts')
const { leggiElenco } = await import('../src/lib/iscrizioni/import/elenco.ts')
const { anomalieClassiSenzaSezione } = await import('../src/lib/iscrizioni/import/sezioni.ts')

import { SEZIONI, PRIMO_BLOCCO, dividiInBlocchi } from './lib/blocchi-aversa.mjs'

const SEDE = 'Kidville Aversa'
const CARICA = process.argv.includes('--carica')
const BUCKET = 'iscrizioni_elenchi'
const NOME_FILE = 'elenco-classi-aversa-2026-27.xlsx'
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


/**
 * Le rette che nel foglio non sono cifre. Decisione del titolare del
 * 2026-08-31: si usa il TOTALE di bonus e contante.
 *
 * ⚠️ 300 alla riga 86 è molto sopra la retta prevalente della sua sezione (170).
 * Va guardato prima che diventi una fattura: qui si applica ciò che è stato
 * deciso, non si convalida la cifra.
 */
const RETTE_DECISE = new Map([[80, 210], [86, 300]])

/**
 * Sopra questa somiglianza una grafia diversa si considera la stessa persona e
 * il foglio si allinea alla domanda (il form vince sempre). Sotto, la riga
 * resta com'è e finisce nella lista da approvare: un refuso lo corregge una
 * persona, non una soglia. Decisione del titolare del 2026-08-31.
 */
const SOGLIA = 0.9

function caricaEnv() {
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

const testo = (v) => (typeof v === 'string' ? v.trim() : '')

/** Le stesse tre forme di `abbina()`: nome uguale, token uguali, spazi altrove. */
function stessaPersona(a, b) {
    const na = normalizzaNome(a)
    const nb = normalizzaNome(b)
    if (!na || !nb) return false
    if (na === nb) return true
    if (stessiToken(tokenNome(a), tokenNome(b))) return true
    return senzaSpazi(a) === senzaSpazi(b)
}

async function main() {
    caricaEnv()
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) { console.error('⛔ mancano URL o SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
    const db = createClient(url, key, { auth: { persistSession: false } })

    // ── la sede, per nome: mai un uuid cablato ──────────────────────────────
    const { data: scuole, error: eS } = await db.from('scuole').select('id, nome').eq('nome', SEDE)
    if (eS) { console.error('⛔ lettura scuole:', eS.message); process.exit(1) }
    if (!scuole?.length) { console.error(`⛔ «${SEDE}» non esiste`); process.exit(1) }
    const scuolaId = scuole[0].id

    // ── le sezioni vere, per il collaudo finale ─────────────────────────────
    const { data: sezioni, error: eSez } = await db.from('sections').select('name').eq('scuola_id', scuolaId)
    if (eSez) { console.error('⛔ lettura sections:', eSez.message); process.exit(1) }
    const nomiSezioni = (sezioni ?? []).map((s) => s.name)

    // ── l'elenco attivo ─────────────────────────────────────────────────────
    const { data: caric, error: eC } = await db.from('iscrizioni_elenco_caricamenti')
        .select('id, nome_file, righe_totali, caricato_il').eq('scuola_id', scuolaId).eq('attivo', true)
    if (eC) { console.error('⛔ lettura caricamenti:', eC.message); process.exit(1) }
    if (caric?.length !== 1) { console.error(`⛔ attesi 1 caricamento attivo, trovati ${caric?.length ?? 0}`); process.exit(1) }
    const caricamento = caric[0]

    const { data: righe, error: eR } = await db.from('iscrizioni_elenco_righe')
        .select('nome, riga_excel, retta, retta_testo').eq('caricamento_id', caricamento.id).order('riga_excel')
    if (eR) { console.error('⛔ lettura righe:', eR.message); process.exit(1) }

    // ── le domande, per correggere le grafie ────────────────────────────────
    const { data: dom, error: eD } = await db.from('enrollment_submissions')
        .select('data, status').eq('scuola_id', scuolaId).in('status', ['approved', 'pending'])
    if (eD) { console.error('⛔ lettura domande:', eD.message); process.exit(1) }
    const bambiniDomanda = []
    for (const d of dom ?? []) {
        for (const c of Array.isArray(d.data?.children) ? d.data.children : []) {
            const nome = `${testo(c.cognome)} ${testo(c.nome)}`.trim()
            if (nome) bambiniDomanda.push({ nome, stato: d.status })
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // I blocchi, ricavati dalle righe di intestazione e non da un intervallo
    // scritto a mano: se il foglio cambia, cambia da solo anche questo.
    // ═══════════════════════════════════════════════════════════════════════
    let diviso
    try {
        diviso = dividiInBlocchi(righe ?? [])
    } catch (e) {
        console.error(`⛔ ${e.message}`)
        process.exit(1)
    }
    const { perSezione, intestazioni: intestazioniViste } = diviso
    const attesi = SEZIONI

    // ═══════════════════════════════════════════════════════════════════════
    // Le grafie. Il foglio si allinea alla domanda solo sopra la soglia.
    // ═══════════════════════════════════════════════════════════════════════
    const tutteLeRighe = [...perSezione.values()].flat()
    const domandeSenzaRiga = bambiniDomanda.filter(
        (b) => !tutteLeRighe.some((r) => stessaPersona(r.nome, b.nome)))
    const righeSenzaDomanda = tutteLeRighe.filter(
        (r) => !bambiniDomanda.some((b) => stessaPersona(r.nome, b.nome)))

    /**
     * L'accostamento si fa a coppie, non a scansione.
     *
     * ⚠️ La prima versione girava sulle righe del foglio e per ognuna cercava la
     * domanda più simile. Sbagliato, e in modo che sembrava funzionare: una riga
     * del foglio SENZA domanda è il caso NORMALE — sono le famiglie che il
     * modulo pubblico non l'hanno mai compilato, e ad Aversa sono la maggioranza.
     * Trattandole tutte come possibili refusi, una riga qualunque si prendeva la
     * domanda che apparteneva a un'altra riga, e i veri refusi restavano fuori:
     * 4 riconosciuti invece di quelli che sono.
     *
     * Il segnale vero sta dalla parte opposta: una DOMANDA senza riga è un
     * bambino che il prodotto sta già bloccando con «non compare nell'elenco
     * delle classi». Quelle sono le uniche da spiegare.
     *
     * Si calcolano tutte le coppie (domanda bloccata × riga senza domanda), si
     * ordinano per somiglianza decrescente e si prende la coppia migliore finché
     * entrambi i lati sono liberi. Il risultato non dipende dall'ordine di
     * lettura — cosa che la scansione non garantiva.
     */
    const coppie = []
    for (const b of domandeSenzaRiga) {
        for (const r of righeSenzaDomanda) {
            coppie.push({ b, r, p: similitudine(r.nome, b.nome) })
        }
    }
    coppie.sort((x, y) => y.p - x.p || x.r.riga_excel - y.r.riga_excel)

    const sezioneDi = new Map()
    for (const [sez, rr] of perSezione) for (const r of rr) sezioneDi.set(r, sez)

    const applicate = []
    const daApprovare = []
    const gia = new Set()
    const righeUsate = new Set()
    for (const { b, r, p } of coppie) {
        if (gia.has(b.nome) || righeUsate.has(r)) continue
        if (p <= 0.6) continue // sotto qui non è più un accostamento: è rumore
        gia.add(b.nome)
        righeUsate.add(r)
        const voce = {
            sezione: sezioneDi.get(r) ?? '',
            rigaTabella: r.riga_excel,
            nelFoglio: r.nome,
            nellaDomanda: b.nome,
            statoDomanda: b.stato,
            somiglianza: Math.round(p * 1000) / 1000,
        }
        if (p > SOGLIA) {
            r.nomeCorretto = b.nome
            applicate.push(voce)
        } else {
            daApprovare.push(voce)
        }
    }
    applicate.sort((a, c) => c.somiglianza - a.somiglianza)
    daApprovare.sort((a, c) => c.somiglianza - a.somiglianza)

    // Una correzione non deve creare due righe uguali nello stesso foglio:
    // sarebbe un `nome-ripetuto`, e bloccherebbe l'iscrizione di entrambi.
    const doppioni = []
    for (const [sez, rr] of perSezione) {
        const visti = new Map()
        for (const r of rr) {
            const k = normalizzaNome(r.nomeCorretto ?? r.nome)
            if (visti.has(k)) doppioni.push({ sezione: sez, righe: [visti.get(k), r.riga_excel] })
            visti.set(k, r.riga_excel)
        }
    }
    if (doppioni.length) {
        console.error(`⛔ ${doppioni.length} nomi ripetuti dopo la correzione: ${JSON.stringify(doppioni)}`)
        process.exit(1)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Il foglio nuovo: Forma A, un foglio per sezione.
    // È anche la forma che `GET /elenco/export` ricostruisce da sé, quindi il
    // giro «scarica → correggi → ricarica» della segreteria si conserva.
    // ═══════════════════════════════════════════════════════════════════════
    const wb = XLSX.utils.book_new()
    let scritte = 0
    for (const sezione of attesi) {
        const aoa = [['Alunno', 'Retta']]
        for (const r of perSezione.get(sezione)) {
            const decisa = RETTE_DECISE.get(r.riga_excel)
            const retta = decisa ?? (r.retta !== null && r.retta !== undefined ? Number(r.retta) : null)
            aoa.push([r.nomeCorretto ?? r.nome, retta ?? (testo(r.retta_testo) || null)])
            scritte += 1
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sezione)
    }
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    // ═══════════════════════════════════════════════════════════════════════
    // Il collaudo, PRIMA di consegnare: il file passa dal lettore vero e deve
    // uscirne pulito. Se qui è rosso, il file non si carica.
    // ═══════════════════════════════════════════════════════════════════════
    const letto = leggiElenco(buffer)
    const senzaSezione = anomalieClassiSenzaSezione(letto.perClasse, nomiSezioni)
    const BLOCCANTI = new Set(['nome-mancante', 'retta-mancante', 'retta-non-numerica', 'nome-ripetuto', 'colonna-senza-classe'])
    const bloccanti = letto.anomalie.filter((a) => BLOCCANTI.has(a.genere))

    /**
     * L'unica anomalia bloccante ammessa, e ammessa a voce alta.
     *
     * Nel foglio di partenza c'è una retta che non è scritta: la cella è vuota.
     * Il titolare ha deciso di NON inventarla (2026-08-31), quindi resta vuota e
     * quel bambino resta fermo finché la segreteria non manda la cifra. Il
     * collaudo la conta e la nomina invece di allargare la soglia: una prova che
     * ammette «qualche» anomalia senza dire quale non sta più provando niente.
     */
    const RETTE_VUOTE_AMMESSE = 1
    const retteMancanti = bloccanti.filter((a) => a.genere === 'retta-mancante')
    const altreBloccanti = bloccanti.filter((a) => a.genere !== 'retta-mancante')

    const prove = [
        ['sei classi', letto.perClasse.length === 6, `${letto.perClasse.length}`],
        ['nessuna classe «RETTE»', !letto.perClasse.some((c) => /^rette$/i.test(c.classe)), ''],
        ['tutte le righe conservate', letto.righe.length === scritte, `${letto.righe.length} vs ${scritte}`],
        ['ogni classe ha la sua sezione', senzaSezione.length === 0, JSON.stringify(senzaSezione.map((a) => a.dettaglio))],
        ['nessuna anomalia bloccante oltre alle rette vuote', altreBloccanti.length === 0, JSON.stringify(altreBloccanti.map((a) => a.genere))],
        [`rette vuote: esattamente ${RETTE_VUOTE_AMMESSE} (decisa, non trovata)`, retteMancanti.length === RETTE_VUOTE_AMMESSE, `${retteMancanti.length}`],
        ['stesse persone di prima', letto.righe.length === tutteLeRighe.length, `${letto.righe.length} vs ${tutteLeRighe.length}`],
    ]
    console.log('\n── collaudo del file, passato dal lettore vero ──')
    let rotto = false
    for (const [nome, ok, det] of prove) {
        console.log(`   ${ok ? '✓' : '✗'} ${nome}${ok || !det ? '' : `  → ${det}`}`)
        if (!ok) rotto = true
    }
    if (rotto) { console.error('\n⛔ il file non è buono: non si carica.'); process.exit(1) }

    // ═══════════════════════════════════════════════════════════════════════
    // La consegna, fuori dal repo.
    // ═══════════════════════════════════════════════════════════════════════
    const oggi = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date())
    const cartella = join(CARTELLA_LAVORO, `aversa-classi-${oggi}`)
    mkdirSync(cartella, { recursive: true })

    const fileElenco = join(cartella, 'elenco-classi-aversa-2026-27.xlsx')
    writeFileSync(fileElenco, buffer)

    const wbCorr = XLSX.utils.book_new()
    const intest = ['Sezione', 'Riga in tabella', 'Nel foglio', 'Nella domanda', 'Stato domanda', 'Somiglianza']
    const inRighe = (v) => [intest, ...v.map((x) => [x.sezione, x.rigaTabella, x.nelFoglio, x.nellaDomanda, x.statoDomanda, x.somiglianza])]
    XLSX.utils.book_append_sheet(wbCorr, XLSX.utils.aoa_to_sheet(inRighe(applicate)), 'Applicate sopra 0,9')
    XLSX.utils.book_append_sheet(wbCorr, XLSX.utils.aoa_to_sheet(inRighe(daApprovare)), 'Da approvare')
    XLSX.utils.book_append_sheet(wbCorr, XLSX.utils.aoa_to_sheet([
        ['Nella domanda', 'Stato', 'Nota'],
        ...domandeSenzaRiga.filter((b) => !gia.has(b.nome))
            .map((b) => [b.nome, b.stato, 'nessuna riga del foglio le somiglia abbastanza']),
    ]), 'Domande senza riga')
    writeFileSync(join(cartella, 'correzioni-nomi.xlsx'), XLSX.write(wbCorr, { type: 'buffer', bookType: 'xlsx' }))

    // ── a schermo, solo conteggi ────────────────────────────────────────────
    console.log('\n── il foglio ricostruito ──')
    console.log(`   partenza: «${caricamento.nome_file}», ${caricamento.righe_totali} righe, caricato il ${String(caricamento.caricato_il).slice(0, 10)}`)
    console.log(`   intestazioni di sezione trovate in tabella: ${intestazioniViste.length} (+ «${PRIMO_BLOCCO}» dalla riga 1 del file)`)
    console.log(`   bambini scritti: ${scritte}\n`)
    for (const sezione of attesi) {
        const rr = perSezione.get(sezione)
        const conRetta = rr.filter((r) => RETTE_DECISE.has(r.riga_excel) || r.retta !== null).length
        const rimandi = rr.filter((r) => /\bvedi\b/i.test(testo(r.retta_testo))).length
        console.log(`   ${sezione.padEnd(10)} ${String(rr.length).padStart(3)} bambini · ${conRetta} con cifra · ${rimandi} «vedi fratello»`)
    }
    console.log('\n── le grafie ──')
    console.log(`   corrette d'ufficio (sopra ${SOGLIA}): ${applicate.length}`)
    console.log(`   da approvare (sotto soglia):        ${daApprovare.length}`)
    console.log(`   domande senza nessuna riga simile:  ${domandeSenzaRiga.filter((b) => !gia.has(b.nome)).length}`)
    console.log('\n── consegna ──')
    console.log(`   ${fileElenco}`)
    console.log(`   ${join(cartella, 'correzioni-nomi.xlsx')}`)

    if (!CARICA) {
        console.log('\n   Si carica da Segreteria → Modulistica → Elenco classi, sede Aversa,')
        console.log('   oppure da qui con --carica.')
        return
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Il caricamento: gli stessi passi della route, con la stessa disfatta.
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n── caricamento in produzione ──')

    // Il percorso lo decide il server, mai il nome del file: un nome scelto
    // altrove permetterebbe di sovrascrivere l'elenco di un'altra sede.
    const path = `${scuolaId}/${randomUUID()}.xlsx`
    const { error: eUp } = await db.storage.from(BUCKET).upload(path, buffer, { contentType: MIME, upsert: false })
    if (eUp) { console.error('⛔ upload nel bucket:', eUp.message); process.exit(1) }
    console.log(`   ✓ file nel bucket: ${path}`)

    const ritira = async () => {
        const { error } = await db.storage.from(BUCKET).remove([path])
        if (error) console.error(`   ⚠️ file NON ritirato dal bucket (${path}): ${error.message}`)
    }

    // Un solo elenco vivo per sede: l'indice parziale rifiuterebbe il secondo, e
    // due elenchi attivi vorrebbero dire che il giro sceglie da solo quale vale.
    const { error: eSpegni } = await db.from('iscrizioni_elenco_caricamenti')
        .update({ attivo: false }).eq('scuola_id', scuolaId).eq('attivo', true)
    if (eSpegni) { await ritira(); console.error('⛔ elenco precedente non spento:', eSpegni.message); process.exit(1) }
    console.log('   ✓ elenco precedente spento')

    const anomalie = [...letto.anomalie, ...senzaSezione]
    const { data: nuovo, error: eIns } = await db.from('iscrizioni_elenco_caricamenti')
        .insert({ scuola_id: scuolaId, storage_path: path, nome_file: NOME_FILE,
                  righe_totali: letto.righe.length, anomalie, caricato_da: null, attivo: true })
        .select('id').single()
    if (eIns || !nuovo) { await ritira(); console.error('⛔ caricamento non registrato:', eIns?.message ?? 'nessuna riga'); process.exit(1) }
    const nuovoId = nuovo.id
    console.log(`   ✓ caricamento registrato: ${nuovoId}`)

    const BLOCCO = 200
    const righeDb = letto.righe.map((r) => ({
        caricamento_id: nuovoId, scuola_id: scuolaId, classe: r.classe, nome: r.nome,
        nome_norm: r.nomeNorm, riga_excel: r.rigaExcel, retta: r.retta, retta_testo: r.rettaTesto,
    }))
    for (let i = 0; i < righeDb.length; i += BLOCCO) {
        const { error } = await db.from('iscrizioni_elenco_righe').insert(righeDb.slice(i, i + BLOCCO))
        if (error) {
            // Un elenco caricato per tre quarti è peggio di nessun elenco.
            await db.from('iscrizioni_elenco_caricamenti').delete().eq('id', nuovoId)
            await ritira()
            console.error('⛔ righe non scritte:', error.message)
            process.exit(1)
        }
    }
    console.log(`   ✓ ${righeDb.length} righe scritte`)

    // ── la controprova: si rilegge dal database, non si assume ──────────────
    const { data: verifica, error: eV } = await db.from('iscrizioni_elenco_righe')
        .select('classe').eq('caricamento_id', nuovoId)
    if (eV) { console.error('⛔ rilettura righe:', eV.message); process.exit(1) }
    const perClasseDb = new Map()
    for (const r of verifica ?? []) perClasseDb.set(r.classe, (perClasseDb.get(r.classe) ?? 0) + 1)

    const { data: attivi, error: eA } = await db.from('iscrizioni_elenco_caricamenti')
        .select('id').eq('scuola_id', scuolaId).eq('attivo', true)
    if (eA) { console.error('⛔ rilettura caricamenti:', eA.message); process.exit(1) }

    console.log('\n── controprova, riletta dal database ──')
    console.log(`   elenchi attivi per la sede: ${attivi?.length ?? 0}   (deve essere 1)`)
    console.log(`   righe scritte:              ${verifica?.length ?? 0}   (deve essere ${scritte})`)
    console.log(`   righe in classe «RETTE»:    ${perClasseDb.get('RETTE') ?? 0}   (deve essere 0)`)
    for (const s of attesi) console.log(`      ${s.padEnd(10)} ${String(perClasseDb.get(s) ?? 0).padStart(3)}`)

    const ok = attivi?.length === 1 && verifica?.length === scritte && !perClasseDb.get('RETTE')
        && attesi.every((s) => perClasseDb.get(s) === perSezione.get(s).length)
    console.log(ok ? '\n✓ elenco caricato e verificato.' : '\n⛔ qualcosa non torna: guarda i numeri qui sopra.')
    if (!ok) process.exit(1)
}

await main()
