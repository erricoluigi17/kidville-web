#!/usr/bin/env node
/**
 * Rimette in classe i bambini di Aversa che il registro ha iscritto senza sezione.
 *
 * ─── IL GUASTO ──────────────────────────────────────────────────────────────
 * `elenco_rette_aversa.xlsx` (26/08) è un foglio solo, chiamato `RETTE`, con i
 * nomi delle sezioni scritti come righe in mezzo ai nomi dei bambini. Il lettore
 * lo legge in Forma A e ha scritto `classe = 'RETTE'` su tutte e 117 le righe.
 * `RETTE` non è una sezione, e il trigger `sync_alunno_section_id` quando non
 * trova corrispondenza LASCIA `section_id` NULL SENZA SOLLEVARE NIENTE.
 * Misurato il 2026-08-31: **73 alunni** iscritti e invisibili a ogni appello,
 * con **87 credenziali già spedite** alle loro famiglie.
 *
 * ─── COSA FA, E COSA NON FA ─────────────────────────────────────────────────
 * Senza `--apply` NON SCRIVE NIENTE: legge, abbina, calcola e deposita
 * l'anteprima in `~/kindertap-export/`. Con `--apply` scrive **una sola colonna**,
 * `alunni.classe_sezione`, una riga alla volta.
 *
 * `section_id` non lo scrive mai nessuno a mano: lo riempie il trigger. E
 * `importo_retta_mensile` non si tocca — le cifre sono già entrate al momento
 * dell'import, e riscriverle cancellerebbe in silenzio una correzione fatta a
 * mano dalla segreteria in questi giorni. Cambiare la classe è una decisione
 * sulla classe, non sui soldi.
 *
 * ─── LA CLASSE VIENE DAL FOGLIO, MAI DALLA DATA DI NASCITA ──────────────────
 * L'abbinamento è `abbina()` di `src/`, il modulo vero: uguaglianza in tre forme
 * (nome normalizzato, stessi token, senza spazi) e nessuna soglia di somiglianza.
 * Le date di nascita hanno provato la mappa dei BLOCCHI (vedi
 * `scripts/lib/blocchi-aversa.mjs`); qui non entrano.
 *
 * ─── LA PRECONDIZIONE È VERIFICATA, NON PROMESSA ────────────────────────────
 * Il 2026-08-31 tutti e 73 gli alunni si abbinavano a una sola riga. Domani
 * potrebbero non farlo più. Se anche uno solo risulta ambiguo o assente, in
 * `--apply` lo script RIFIUTA L'INTERO LOTTO: una misura di ieri non autorizza
 * una scrittura di oggi.
 *
 * ─── I DATI PERSONALI NON PASSANO DALLA CHAT ────────────────────────────────
 * A schermo solo conteggi e uuid. I nomi stanno nell'anteprima, che vive fuori
 * dal repo. Il repo è pubblico.
 *
 * Uso:
 *   node scripts/riallinea-classi-aversa.mjs            # anteprima, nessuna scrittura
 *   node scripts/riallinea-classi-aversa.mjs --apply    # scrive
 */

import './lib/risolvi-ts.mjs'

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

import { SEZIONI, dividiInBlocchi } from './lib/blocchi-aversa.mjs'

const RADICE = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const CARTELLA_LAVORO = join(homedir(), 'kindertap-export')
const APPLICA = process.argv.includes('--apply')
const SEDE = 'Kidville Aversa'
const STATO_ISCRITTO = 'iscritto'

const { abbina } = await import('../src/lib/iscrizioni/import/abbinamento.ts')

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

async function conta(db, tabella, affina = (q) => q) {
    const { count, error } = await affina(db.from(tabella).select('*', { count: 'exact', head: true }))
    if (error) throw new Error(`conteggio ${tabella}: ${error.message}`)
    return count ?? 0
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
    if (scuole?.length !== 1) { console.error(`⛔ «${SEDE}»: trovate ${scuole?.length ?? 0} sedi`); process.exit(1) }
    const scuolaId = scuole[0].id

    // ── le sezioni devono ESISTERE prima di scriverci dentro ────────────────
    const { data: sezioni, error: eSez } = await db.from('sections').select('id, name').eq('scuola_id', scuolaId)
    if (eSez) { console.error('⛔ lettura sections:', eSez.message); process.exit(1) }
    const nomi = new Set((sezioni ?? []).map((s) => s.name))
    const mancanti = SEZIONI.filter((s) => !nomi.has(s))
    if (mancanti.length) {
        console.error(`⛔ sezioni assenti in anagrafica: ${mancanti.join(', ')}`)
        console.error('   Applica prima la migrazione delle sezioni: senza, il trigger lascia section_id NULL')
        console.error('   e questo script rifarebbe il guasto con un altro nome.')
        process.exit(1)
    }

    // ── l'elenco attivo ─────────────────────────────────────────────────────
    const { data: caric, error: eC } = await db.from('iscrizioni_elenco_caricamenti')
        .select('id, nome_file, caricato_il').eq('scuola_id', scuolaId).eq('attivo', true)
    if (eC) { console.error('⛔ lettura caricamenti:', eC.message); process.exit(1) }
    if (caric?.length !== 1) { console.error(`⛔ attesi 1 caricamento attivo, trovati ${caric?.length ?? 0}`); process.exit(1) }

    const { data: righeDb, error: eR } = await db.from('iscrizioni_elenco_righe')
        .select('id, classe, nome, riga_excel, retta, retta_testo')
        .eq('caricamento_id', caric[0].id).order('riga_excel')
    if (eR) { console.error('⛔ lettura righe elenco:', eR.message); process.exit(1) }

    let diviso
    try { diviso = dividiInBlocchi(righeDb ?? []) }
    catch (e) { console.error(`⛔ ${e.message}`); process.exit(1) }

    // Ogni riga porta con sé la sezione del suo blocco: da qui in poi la classe
    // di un bambino è quella della sua riga, e nient'altro.
    const elenco = []
    for (const [sezione, rr] of diviso.perSezione) {
        for (const r of rr) {
            elenco.push({ id: r.id, classe: sezione, nome: r.nome, riga: r.riga_excel,
                          retta: r.retta === null || r.retta === undefined ? null : Number(r.retta),
                          rettaTesto: r.retta_testo ?? null })
        }
    }

    // ── gli alunni della sede ───────────────────────────────────────────────
    const { data: alunni, error: eA } = await db.from('alunni')
        .select('id, nome, cognome, classe_sezione, section_id, data_nascita, importo_retta_mensile')
        .eq('scuola_id', scuolaId).eq('stato', STATO_ISCRITTO)
        .is('archiviato_il', null).is('anonimizzato_il', null)
    if (eA) { console.error('⛔ lettura alunni:', eA.message); process.exit(1) }

    const primaSenzaSezione = (alunni ?? []).filter((a) => a.section_id === null).length

    // ── l'abbinamento, col modulo vero ──────────────────────────────────────
    const daScrivere = []
    const giaAPosto = []
    const problemi = []
    for (const a of alunni ?? []) {
        const e = abbina(a.nome, a.cognome, elenco)
        if (e.tipo === 'unico') {
            const nuova = e.riga.classe
            const voce = { id: a.id, nome: `${a.cognome} ${a.nome}`, attuale: a.classe_sezione ?? '',
                           nuova, riga: e.riga.riga, sezioneGia: a.section_id !== null }
            if (a.classe_sezione === nuova && a.section_id !== null) giaAPosto.push(voce)
            else daScrivere.push(voce)
        } else {
            problemi.push({ id: a.id, nome: `${a.cognome} ${a.nome}`, tipo: e.tipo,
                            candidati: e.tipo === 'ambiguo' ? e.righe.map((r) => `${r.nome} (${r.classe})`)
                                                            : e.simili.map((r) => `${r.nome} (${r.classe})`) })
        }
    }

    // ── l'anteprima, fuori dal repo ─────────────────────────────────────────
    const oggi = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date())
    const cartella = join(CARTELLA_LAVORO, `aversa-classi-${oggi}`)
    mkdirSync(cartella, { recursive: true })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Id alunno', 'Bambino', 'Classe attuale', 'Classe nuova', 'Riga del foglio', 'Aveva già una sezione'],
        ...daScrivere.map((v) => [v.id, v.nome, v.attuale, v.nuova, v.riga, v.sezioneGia ? 'sì' : 'no']),
    ]), 'Da riallineare')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Id alunno', 'Bambino', 'Classe', 'Riga del foglio'],
        ...giaAPosto.map((v) => [v.id, v.nome, v.nuova, v.riga]),
    ]), 'Già a posto')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Id alunno', 'Bambino', 'Problema', 'Candidati'],
        ...problemi.map((v) => [v.id, v.nome, v.tipo, v.candidati.join(' · ')]),
    ]), 'Non abbinati')
    const fileAnteprima = join(cartella, 'anteprima-riallineamento.xlsx')
    writeFileSync(fileAnteprima, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))

    // ── a schermo, solo conteggi ────────────────────────────────────────────
    const perSezione = new Map()
    for (const v of [...daScrivere, ...giaAPosto]) perSezione.set(v.nuova, (perSezione.get(v.nuova) ?? 0) + 1)

    console.log(`\n── ${SEDE} · elenco «${caric[0].nome_file}» (${diviso.via}) ──`)
    console.log(`   righe dell'elenco:        ${elenco.length}`)
    console.log(`   alunni iscritti in sede:  ${alunni?.length ?? 0}`)
    console.log(`   senza sezione ADESSO:     ${primaSenzaSezione}`)
    console.log(`\n   da riallineare: ${daScrivere.length}   già a posto: ${giaAPosto.length}   NON abbinati: ${problemi.length}`)
    console.log('\n   come si distribuiscono:')
    for (const s of SEZIONI) console.log(`      ${s.padEnd(10)} ${String(perSezione.get(s) ?? 0).padStart(3)} bambini`)
    console.log(`\n   anteprima: ${fileAnteprima}`)

    if (problemi.length) {
        console.log(`\n⚠️  ${problemi.length} alunni non si abbinano a una sola riga dell'elenco.`)
        console.log('   Sono nel foglio «Non abbinati» dell\'anteprima, con i nomi più simili.')
    }

    if (!APPLICA) {
        console.log('\n── prova a vuoto: NON è stata scritta nessuna riga ──')
        console.log('   Per scrivere: node scripts/riallinea-classi-aversa.mjs --apply')
        return
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Da qui si scrive.
    // ═══════════════════════════════════════════════════════════════════════
    if (problemi.length) {
        console.error('\n⛔ RIFIUTATO: con anche un solo alunno non abbinato non si scrive niente.')
        console.error('   Una misura di ieri non autorizza una scrittura di oggi: correggi il')
        console.error('   foglio o l\'anagrafica, poi rilancia.')
        process.exit(1)
    }
    if (!daScrivere.length) { console.log('\n── niente da scrivere: sono già tutti a posto ──'); return }

    const inScuola = (q) => q.eq('scuola_id', scuolaId)
    const primaAlunni = await conta(db, 'alunni', inScuola)
    const primaInviti = await conta(db, 'iscrizioni_inviti_credenziali')

    console.log(`\n── scrittura di ${daScrivere.length} righe, una alla volta ──`)
    let fatte = 0
    const falliti = []
    for (const v of daScrivere) {
        // Una sola colonna. `section_id` lo risolve il trigger.
        const { error } = await db.from('alunni')
            .update({ classe_sezione: v.nuova })
            .eq('id', v.id).eq('scuola_id', scuolaId)
        if (error) { falliti.push({ id: v.id, errore: error.message }); continue }
        fatte += 1

        // Audit immutabile (utente_id null = sistema), come
        // `src/lib/pagamenti/sospensione.ts`. Nessun nome: solo uuid e classi.
        const { error: eAud } = await db.from('registro_modifiche').insert({
            azione: 'riallineamento_classi_aversa',
            tabella_interessata: 'alunni',
            record_id: v.id,
            vecchio_valore: { classe_sezione: v.attuale, section_id: null },
            nuovo_valore: { classe_sezione: v.nuova, motivo: 'elenco letto come foglio unico: classe RETTE inesistente' },
            utente_id: null,
        })
        if (eAud) console.error(`   ⚠️ audit non scritto per ${v.id}: ${eAud.message}`)
    }
    if (falliti.length) {
        console.error(`\n⛔ ${falliti.length} scritture fallite:`)
        for (const f of falliti) console.error(`   ${f.id}: ${f.errore}`)
    }

    // ── la controprova: si RILEGGE, non si assume ───────────────────────────
    const { data: dopo, error: eDopo } = await db.from('alunni')
        .select('id, section_id, classe_sezione, importo_retta_mensile')
        .eq('scuola_id', scuolaId).eq('stato', STATO_ISCRITTO)
        .is('archiviato_il', null).is('anonimizzato_il', null)
    if (eDopo) { console.error('⛔ rilettura alunni:', eDopo.message); process.exit(1) }

    const dopoSenzaSezione = (dopo ?? []).filter((a) => a.section_id === null).length
    const retteCambiate = (dopo ?? []).filter((a) => {
        const prima = (alunni ?? []).find((x) => x.id === a.id)
        return prima && String(prima.importo_retta_mensile) !== String(a.importo_retta_mensile)
    }).length
    const dopoAlunni = await conta(db, 'alunni', inScuola)
    const dopoInviti = await conta(db, 'iscrizioni_inviti_credenziali')

    console.log('\n── controprova, riletta dal database ──')
    console.log(`   scritte:                  ${fatte} / ${daScrivere.length}`)
    console.log(`   senza sezione: ${primaSenzaSezione} → ${dopoSenzaSezione}`)
    console.log(`   alunni della sede: ${primaAlunni} → ${dopoAlunni}   (deve essere identico)`)
    console.log(`   inviti credenziali: ${primaInviti} → ${dopoInviti}   (deve essere identico)`)
    console.log(`   rette cambiate: ${retteCambiate}   (deve essere 0)`)

    const ok = dopoSenzaSezione === 0 && primaAlunni === dopoAlunni
        && primaInviti === dopoInviti && retteCambiate === 0 && falliti.length === 0
    console.log(ok ? '\n✓ riallineamento completo.' : '\n⛔ qualcosa non torna: guarda i numeri qui sopra.')
    if (!ok) process.exit(1)
}

await main()
