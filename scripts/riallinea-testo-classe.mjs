#!/usr/bin/env node
/**
 * Rimette il NOME della sezione dentro il testo che la schermata della maestra
 * legge — su TUTTE le sedi, non su una sola.
 *
 * ─── IL GUASTO ──────────────────────────────────────────────────────────────
 * `alunni` tiene la classe in due colonne: `section_id` (uuid, la FK vera) e
 * `classe_sezione` (testo). L'area docente 0-6 cerca i bambini per TESTO
 * (`.eq('classe_sezione', sections.name)`), la primaria per uuid. Il trigger
 * `sync_alunno_section_id` va solo testo → uuid, confrontando senza spazi né
 * maiuscole: quindi il testo può divergere dal nome della sezione MENTRE
 * `section_id` resta giusto. Quando succede, la route risponde `200` con `[]`:
 * nessun errore, nessun log, schermata bianca.
 *
 * Misurato in produzione il 2026-09-02, tutte a Kidville Giugliano:
 *   3 ANNI B ← «3 ANNI B » (spazio finale)   ·  4 ANNI A ← «4 anni  a» (2 spazi)
 *   4 ANNI B ← «4 anni b»  ·  5 ANNI A ← «5 anni a»  ·  5 ANNI B ← «5 anni b»
 * 71 bambini iscritti, di cui tre classi mostrate PARZIALI (1 su 14, 1 su 12,
 * 4 su 16): una classe vuota fa telefonare, una classe quasi vuota sembra vera.
 *
 * ─── COSA FA, E COSA NON FA ─────────────────────────────────────────────────
 * Senza `--apply` NON SCRIVE NIENTE. Con `--apply` scrive **una sola colonna**,
 * `alunni.classe_sezione`, una riga alla volta, e solo dove:
 *
 *   · `section_id` è GIÀ valorizzato → il nome si copia dalla sezione in cui il
 *     bambino È già. Non si sposta nessuno: si riscrive il testo partendo
 *     dall'uuid, mai il contrario.
 *   · la forma normalizzata coincide → si toccano solo spazi e maiuscole. Un
 *     testo davvero diverso (`RETTE`) NON viene toccato: quello si decide a
 *     mano, non si normalizza in silenzio. Finisce fra i «lasciati stare».
 *   · `stato = 'iscritto'` → gli archiviati hanno la loro colonna
 *     (`alunni.archiviato_classe_sezione`) ed è per progetto una fotografia.
 *
 * `section_id` non lo scrive mai: lo ricalcola il trigger, e con la forma
 * normalizzata invariata ritrova la STESSA riga.
 *
 * ─── LA PRECONDIZIONE È VERIFICATA ADESSO, NON PROMESSA ─────────────────────
 * Il trigger risolve con `LIMIT 1` e senza `ORDER BY`. Se due sezioni della
 * stessa sede collassassero sulla stessa forma normalizzata, riscrivere il testo
 * potrebbe SPOSTARE un bambino invece di rinominarglielo — un guasto peggiore di
 * quello che si sta correggendo. Il 2026-09-02 le collisioni erano zero; questo
 * script le riconta **al momento della scrittura** e con anche una sola rifiuta
 * l'intero lotto. Una misura di ieri non autorizza una scrittura di oggi.
 *
 * ─── I DATI PERSONALI NON PASSANO DALLA CHAT ────────────────────────────────
 * A schermo solo conteggi, nomi di classe e uuid. Mai nome, cognome o codice
 * fiscale: il repo è pubblico e sono dati di minori.
 *
 * Uso:
 *   node scripts/riallinea-testo-classe.mjs            # anteprima, nessuna scrittura
 *   node scripts/riallinea-testo-classe.mjs --apply    # scrive
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const RADICE = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const CARTELLA_LAVORO = join(homedir(), 'kindertap-export')
const APPLICA = process.argv.includes('--apply')
const STATO_ISCRITTO = 'iscritto'

/**
 * La formula del trigger, alla lettera: via TUTTI gli spazi (non un `trim`, che
 * lascerebbe quelli interni — ed è proprio il doppio spazio di «4 anni  a» il
 * caso vero) e minuscolo. Niente altro: il punto di `4 ANNI M.ROSARIA` resta, e
 * la barra di `NIDO 2026/2027` resta.
 *
 * Gemella di `normalizzaNomeSezione` in `src/lib/alunni/sezione.ts`. Qui è
 * ricopiata di proposito: questo script non deve caricare il transpilatore di
 * TypeScript per tre righe, e il lock `formula-sezione-un-posto-solo.test.ts`
 * sorveglia `src/`, non `scripts/`. Se la formula del trigger cambiasse,
 * cambiano entrambe — ed è il motivo per cui il testo del trigger sta scritto
 * qui sopra.
 */
function normalizza(nome) {
    return String(nome ?? '').replace(/ /g, '').toLowerCase()
}

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

async function main() {
    caricaEnv()
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) { console.error('⛔ mancano URL o SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
    const db = createClient(url, key, { auth: { persistSession: false } })

    // ── anagrafica: sedi e sezioni ──────────────────────────────────────────
    const { data: scuole, error: eS } = await db.from('scuole').select('id, nome')
    if (eS) { console.error('⛔ lettura scuole:', eS.message); process.exit(1) }
    const nomeSede = new Map((scuole ?? []).map((s) => [s.id, s.nome]))

    const { data: sezioni, error: eSez } = await db.from('sections').select('id, name, scuola_id')
    if (eSez) { console.error('⛔ lettura sections:', eSez.message); process.exit(1) }
    const sezionePerId = new Map((sezioni ?? []).map((s) => [s.id, s]))

    // ── PRECONDIZIONE BLOCCANTE: nessuna collisione sulla forma normalizzata ─
    const perForma = new Map()
    for (const s of sezioni ?? []) {
        const chiave = `${s.scuola_id}|${normalizza(s.name)}`
        if (!perForma.has(chiave)) perForma.set(chiave, [])
        perForma.get(chiave).push(s.name)
    }
    const collisioni = [...perForma.entries()].filter(([, nomi]) => nomi.length > 1)

    // ── gli alunni con un testo che non combacia col nome della sezione ─────
    // Non si filtra in SQL su `col1 <> col2` (PostgREST non lo sa fare): si
    // legge e si confronta qui. Sono poche centinaia di righe per sede.
    const { data: alunni, error: eA } = await db.from('alunni')
        .select('id, scuola_id, section_id, classe_sezione, stato')
        .eq('stato', STATO_ISCRITTO)
        .not('section_id', 'is', null)
    if (eA) { console.error('⛔ lettura alunni:', eA.message); process.exit(1) }

    const daScrivere = []
    const lasciatiStare = []
    const incoerenti = []
    for (const a of alunni ?? []) {
        const sez = sezionePerId.get(a.section_id)
        if (!sez) { incoerenti.push({ id: a.id, perche: 'section_id non risolve a nessuna sezione' }); continue }
        // Il `section_id` punta a una sezione di un'ALTRA sede: qui non si
        // ripara, si dichiara. Riscrivere il testo lo renderebbe soltanto meno
        // visibile.
        if (sez.scuola_id !== a.scuola_id) {
            incoerenti.push({ id: a.id, perche: 'sezione di un\'altra sede' }); continue
        }
        if (a.classe_sezione === sez.name) continue
        const voce = {
            id: a.id, scuolaId: a.scuola_id, sezione: sez.name,
            attuale: a.classe_sezione, nuova: sez.name,
        }
        if (normalizza(a.classe_sezione) === normalizza(sez.name)) daScrivere.push(voce)
        else lasciatiStare.push(voce)
    }

    // ── anteprima, sempre ───────────────────────────────────────────────────
    console.log('\n═══ testo della classe vs nome della sezione ═══')
    console.log(`   alunni iscritti con section_id:  ${alunni?.length ?? 0}`)
    console.log(`   testo già allineato:             ${(alunni?.length ?? 0) - daScrivere.length - lasciatiStare.length - incoerenti.length}`)
    console.log(`   da riallineare (solo spazi/maiuscole): ${daScrivere.length}`)
    console.log(`   lasciati stare (testo davvero diverso): ${lasciatiStare.length}`)
    console.log(`   incoerenti (sede/sezione):       ${incoerenti.length}`)

    if (daScrivere.length) {
        console.log('\n   da riallineare, per sezione:')
        const perSezione = new Map()
        for (const v of daScrivere) {
            const k = `${nomeSede.get(v.scuolaId) ?? v.scuolaId} · «${v.attuale}» → «${v.nuova}»`
            perSezione.set(k, (perSezione.get(k) ?? 0) + 1)
        }
        for (const [k, n] of [...perSezione].sort()) console.log(`      ${String(n).padStart(3)}  ${k}`)
    }

    if (lasciatiStare.length) {
        console.log('\n⚠️  testo che NON si normalizza da sé — decisione umana, non si tocca:')
        const perSezione = new Map()
        for (const v of lasciatiStare) {
            const k = `${nomeSede.get(v.scuolaId) ?? v.scuolaId} · «${v.attuale}» (sezione: «${v.nuova}»)`
            perSezione.set(k, (perSezione.get(k) ?? 0) + 1)
        }
        for (const [k, n] of [...perSezione].sort()) console.log(`      ${String(n).padStart(3)}  ${k}`)
    }

    if (incoerenti.length) {
        console.log('\n⚠️  righe incoerenti (solo uuid):')
        for (const v of incoerenti) console.log(`      ${v.id}  ${v.perche}`)
    }

    if (collisioni.length) {
        console.log('\n⛔ COLLISIONI sulla forma normalizzata:')
        for (const [chiave, nomi] of collisioni) {
            console.log(`      ${nomeSede.get(chiave.split('|')[0]) ?? chiave}: ${nomi.join(' | ')}`)
        }
    }

    if (!APPLICA) {
        console.log('\n── prova a vuoto: NON è stata scritta nessuna riga ──')
        console.log('   Per scrivere: node scripts/riallinea-testo-classe.mjs --apply')
        return
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Da qui si scrive.
    // ═══════════════════════════════════════════════════════════════════════
    if (collisioni.length) {
        console.error('\n⛔ RIFIUTATO: due sezioni della stessa sede collassano sulla stessa forma')
        console.error('   normalizzata. Il trigger sceglierebbe con LIMIT 1 senza ORDER BY, quindi')
        console.error('   riscrivere il testo potrebbe SPOSTARE un bambino invece di rinominarglielo.')
        console.error('   Rinomina una delle due sezioni, poi rilancia.')
        process.exit(1)
    }
    if (incoerenti.length) {
        console.error('\n⛔ RIFIUTATO: ci sono righe con section_id incoerente. Vanno risolte prima:')
        console.error('   riscriverci sopra il testo le renderebbe soltanto meno visibili.')
        process.exit(1)
    }
    if (!daScrivere.length) { console.log('\n── niente da scrivere: sono già tutti allineati ──'); return }

    // La fotografia PRIMA, per sezione: è il metro del «nessuno si è mosso».
    const primaPerSezione = new Map()
    for (const a of alunni ?? []) primaPerSezione.set(a.section_id, (primaPerSezione.get(a.section_id) ?? 0) + 1)

    console.log(`\n── scrittura di ${daScrivere.length} righe, una alla volta ──`)
    let fatte = 0
    const falliti = []
    for (const v of daScrivere) {
        // Una sola colonna. `section_id` lo ricalcola il trigger.
        const { error } = await db.from('alunni')
            .update({ classe_sezione: v.nuova })
            .eq('id', v.id).eq('scuola_id', v.scuolaId)
        if (error) { falliti.push({ id: v.id, errore: error.message }); continue }
        fatte += 1

        // Audit immutabile (utente_id null = sistema). Nessun nome: uuid e classi.
        const { error: eAud } = await db.from('registro_modifiche').insert({
            azione: 'riallineamento_testo_classe',
            tabella_interessata: 'alunni',
            record_id: v.id,
            vecchio_valore: { classe_sezione: v.attuale },
            nuovo_valore: {
                classe_sezione: v.nuova,
                motivo: 'testo divergente dal nome della sezione: la schermata docente 0-6 cerca per nome',
            },
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
        .select('id, scuola_id, section_id, classe_sezione')
        .eq('stato', STATO_ISCRITTO)
    if (eDopo) { console.error('⛔ rilettura alunni:', eDopo.message); process.exit(1) }

    const orfaniDopo = (dopo ?? []).filter((a) => a.section_id === null).length
    const divergentiDopo = (dopo ?? []).filter((a) => {
        const sez = a.section_id ? sezionePerId.get(a.section_id) : null
        return sez && a.classe_sezione !== sez.name
    }).length
    const dopoPerSezione = new Map()
    for (const a of dopo ?? []) {
        if (!a.section_id) continue
        dopoPerSezione.set(a.section_id, (dopoPerSezione.get(a.section_id) ?? 0) + 1)
    }
    const spostati = [...primaPerSezione.entries()]
        .filter(([sid, n]) => (dopoPerSezione.get(sid) ?? 0) !== n)
        .map(([sid, n]) => `${sezionePerId.get(sid)?.name ?? sid}: ${n} → ${dopoPerSezione.get(sid) ?? 0}`)

    console.log('\n═══ controprova ═══')
    console.log(`   scritte:                          ${fatte} / ${daScrivere.length}`)
    console.log(`   testo ancora divergente:          ${divergentiDopo}   (atteso: ${lasciatiStare.length})`)
    console.log(`   iscritti senza sezione:           ${orfaniDopo}`)
    console.log(`   sezioni con conteggio cambiato:   ${spostati.length}   (atteso: 0)`)
    if (spostati.length) {
        console.error('\n⛔ QUALCUNO SI È MOSSO DI CLASSE. Non doveva succedere:')
        for (const s of spostati) console.error(`      ${s}`)
        process.exit(1)
    }
    console.log('\n── fatto ──')
}

main().catch((e) => { console.error('⛔', e); process.exit(1) })
