#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata delle FUNZIONI SQL CHE SCRIVONO IL REGISTRO DELL'ANNO:
 *   __tests__/fixtures/funzioni-scrivono-registro.json
 *
 * Una funzione `public`/`scatola_nera` "scrive il registro" se il suo corpo contiene `update`,
 * `delete from` o `insert into` seguito da una delle tabelle di `public.anno_tabelle` (con confini
 * di parola: `presenze` non pesca `presenze_giustificazioni`). Il lock del Compito 3.9 confronta
 * questo elenco con le migrazioni e con la guardia dell'anno: gira OFFLINE (vitest, in CI, senza il
 * database di produzione), quindi la sua unica sorgente di verita' e' QUESTO file. Perche' non possa
 * essere addomesticato a mano porta un `sha256` del contenuto normalizzato
 * (`__tests__/architecture/funzioni-registro-fotografia.test.ts`). Stessa forma di
 * `scripts/tabelle-anno-fotografia.mjs`.
 *
 * ─── COSA ESCE DALLA FOTOGRAFIA ────────────────────────────────────────────────
 * Le funzioni di TRIGGER dell'anno stesso: `anno_*`, `frequenze_*`, `alunni_specchio_frequenza` e le due
 * `*_tocca_frequenze` (`pagamenti_tocca_frequenze`, `moduli_richiesti_tocca_frequenze`). Sono la GUARDIA
 * e lo specchio, non chi viene guardato: scrivono `frequenze` per ricalcolare `moduli_completi` e
 * `quota_saldata` (colonne esenti). Includerle farebbe controllare alla guardia se stessa.
 *
 * ─── LA CLASSE E' UN GIUDIZIO, NON STA NEL CATALOGO ───────────────────────────
 * `CLASSI` (qui sotto) e' scritta a mano: `funzione -> { classe, motivo }`, motivo di una riga.
 * Il generatore FALLISCE se una funzione del catalogo non ha classe, o se `CLASSI` nomina una funzione
 * che il catalogo non ha piu': cosi' una funzione nuova non entra senza che qualcuno la giudichi.
 * Nella fotografia finiscono solo nomi: mai sorgenti. Il `motivo` resta qui, nel generatore.
 *
 *   corrente          la funzione passa dalla guardia come ogni scrittura: su un anno protetto serve un
 *                     gettone, altrimenti 409. Comprende le scritture con una data passata dal chiamante e
 *                     i ricalcoli fatti nella stessa transazione di una scrittura guardata, perche' il
 *                     gettone vale per tutta la transazione (Ruling P15).
 *   esente-colonne    scrive solo colonne che sono esenti oggi o che M3 rendera' esenti; il motivo nomina
 *                     quelle colonne
 *   oblio             cancella/anonimizza: retention, GDPR, eliminazione
 *   macchina-a-stati  pipeline video e simili: stato, non contenuto
 *   dichiara          INSERT su una tabella di modo `dichiarato` (l'anno lo dichiara chi scrive)
 *   passaggio         accende l'interruttore `anno_passaggio.in_corso` per la durata della sua transazione: la
 *                     guardia la lascia passare con un gettone di codice `passaggio` (PR 4.9, `20261112181554`).
 *                     Solo `passaggio_conferma` e `passaggio_annulla`; il lock lo verifica sull'ultima definizione.
 *
 * ─── LIMITI DELLA QUERY (falsi negativi possibili) ─────────────────────────────
 * E' una scansione di testo del corpo: non vede SQL dinamico (`execute '…'`), scritture indirette
 * (`PERFORM f()`), tabelle di schema diverso da `public`, i commenti a blocchi (slash-asterisco: non vengono tolti, possono
 * dare falsi positivi), un `--` dentro una stringa (taglierebbe il resto della riga), le funzioni
 * `BEGIN ATOMIC` (hanno `prosrc` vuoto), `TRUNCATE` e `MERGE`.
 *
 * ─── COME SI RIGENERA ──────────────────────────────────────────────────────────
 * 1. Esegui sul DB di produzione la query che stampa `node scripts/funzioni-registro-fotografia.mjs --sql`
 *    (strumento MCP `execute_sql`, oppure `psql "$DATABASE_URL" -Atc "<query>"`).
 *    E' una query di SOLA LETTURA sul catalogo (`pg_proc`): restituisce nomi di funzioni e di tabelle.
 *    Il sorgente delle funzioni viene LETTO dal database ma non esce dalla query.
 * 2. Salva la risposta JSON in un file (va bene sia l'array che restituisce l'MCP, sia l'oggetto nudo).
 * 3. `node scripts/funzioni-registro-fotografia.mjs < risposta.json`
 * 4. `npx vitest run __tests__/architecture/funzioni-registro-fotografia.test.ts`
 *
 * VA RIGENERATA DOPO OGNI MIGRAZIONE CHE CREI, RINOMINI O RISCRIVA UNA FUNZIONE CHE SCRIVE IL REGISTRO.
 *
 * NON si connette da solo al database: `.env.local` punta alla PRODUZIONE e uno script
 * che si collega da se' e' uno script che prima o poi ci scrive. Qui entra solo testo.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Confini di parola: dopo il nome della tabella non deve seguire [a-z0-9_] (`presenze` vs
// `presenze_giustificazioni`). I commenti `--` sono tolti prima del confronto.
const SQL = `WITH t AS (SELECT tabella FROM public.anno_tabelle),
f AS (
  SELECT p.proname, regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') AS s
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'scatola_nera') AND p.prokind = 'f'
    AND p.proname NOT LIKE 'anno\\_%' AND p.proname NOT LIKE 'frequenze\\_%'
    AND p.proname <> 'alunni_specchio_frequenza' AND p.proname NOT IN ('pagamenti_tocca_frequenze', 'moduli_richiesti_tocca_frequenze')
),
m AS (
  SELECT DISTINCT f.proname, t.tabella
  FROM f JOIN t ON f.s ~* ('\\m(update|delete\\s+from|insert\\s+into)\\s+(only\\s+)?("?public"?\\.)?"?' || t.tabella || '"?(?![a-z0-9_])')
)
SELECT json_build_object(
  'registro', (SELECT coalesce(json_agg(tabella ORDER BY tabella COLLATE "C"), '[]'::json) FROM t),
  'funzioni', (
    SELECT coalesce(json_agg(json_build_object('funzione', proname, 'tabelle', tabelle) ORDER BY proname COLLATE "C"), '[]'::json)
    FROM (SELECT proname, array_agg(tabella ORDER BY tabella COLLATE "C") AS tabelle FROM m GROUP BY proname) x
  )
) AS fotografia;`

if (process.argv.includes('--sql')) {
    process.stdout.write(SQL + '\n')
    process.exit(0)
}

/** Giudizio a mano: funzione -> { classe, motivo }. Vedi l'intestazione. */
const C = (classe, motivo) => ({ classe, motivo })
const VIDEO = C('macchina-a-stati', 'pipeline video: stato del lavoro, non contenuto del registro')
const VIDEO_OBLIO = C('oblio', 'retention/minimizzazione video: toglie file e tag degli alunni')
export const CLASSI = {
    // ── video ──
    _video_originale_applica: VIDEO,
    video_galleria_flusso_vecchio_revoca: VIDEO,
    video_galleria_intent_apri: VIDEO,
    video_galleria_intent_apri_storico: C('corrente', 'scrive video_intents (modo data) con giorno_competenza passato dal chiamante'),
    video_galleria_pubblica: VIDEO,
    video_intent_add_job: VIDEO,
    video_intent_confirm: VIDEO,
    video_intent_esito_segna: VIDEO,
    video_intent_finalize: VIDEO,
    video_intent_oblio_alunno: C('oblio', 'toglie il tag di un alunno dagli intenti video e scade i job'),
    video_intent_open: C('corrente', 'apre un intento e un job nuovi, di oggi'),
    video_intent_pubblicazione_fallita: VIDEO,
    video_intent_pubblicazione_riprova: VIDEO,
    video_intent_revoke: VIDEO,
    video_intent_scadi_non_pubblicato: VIDEO,
    video_intent_supersede: VIDEO,
    video_intenti_minimizza: VIDEO_OBLIO,
    video_job_cancel: VIDEO,
    video_job_claim: VIDEO,
    video_job_diagnosi: VIDEO,
    video_job_fail: VIDEO,
    video_job_heartbeat: VIDEO,
    video_job_ready: VIDEO,
    video_job_retry: VIDEO,
    video_job_sorveglianza_prendi: VIDEO,
    video_job_sorveglianza_rilascia: VIDEO,
    video_job_uploaded: VIDEO,
    video_retention_originale_rimosso: VIDEO_OBLIO,
    video_retention_scadenze: VIDEO_OBLIO,
    video_retention_uscita_rimossa: VIDEO_OBLIO,
    video_rinnovo_usa: VIDEO,
    // ── cassa (pagamenti e quote) ──
    aggiorna_quote_pagamento: C('corrente', 'scrive pagamenti.tipo, che non e\' esente, e rifa le quote: su un anno chiuso serve un gettone'),
    crea_quote_da_config: C('corrente', 'crea le quote di una voce appena creata'),
    elimina_voce_ricarica_ticket: C('corrente', 'toglie una voce di ricarica ticket appena fatta'),
    genera_rette_mensili: C('dichiara', 'crea voci di pagamenti: l\'anno lo dichiara la scadenza/competenza della voce'),
    genera_servizi_mensili: C('dichiara', 'crea voci di pagamenti per i servizi del mese'),
    genera_solleciti: C('esente-colonne', 'scrive solo stato, aggiornato_il e ultimo_sollecito_il di pagamenti, tutte esenti'),
    registra_incasso_voce: C('corrente', 'scrive sconto e sconto_motivo, non esenti: un abbuono su un anno chiuso e\' una correzione; senza abbuono cambia solo aggiornato_il, esente'),
    registra_transazione_contabile: C('dichiara', 'inserisce voci di pagamenti con scadenza/competenza dichiarate'),
    ricalcola_stato_padre: C('esente-colonne', 'scrive importo_pagato, stato, aggiornato_il di pagamenti: tutte esenti'),
    ricalcola_stato_pagamento: C('esente-colonne', 'scrive importo_pagato, data_incasso, stato, aggiornato_il di pagamenti: tutte esenti'),
    ricarica_ticket_mensa: C('dichiara', 'inserisce una voce di pagamenti per la ricarica dei ticket'),
    ricarica_ticket_mensa_storico: C('dichiara', 'inserisce in pagamenti (tabella dichiarato) con la scadenza passata dal chiamante'),
    crm_quota_passa: C('dichiara', 'inserisce la voce di pagamenti della quota di iscrizione'),
    crm_quota_segna: C('corrente', 'aggiorna lo stato della quota di una scheda CRM viva'),
    crm_quota_togli: C('corrente', 'azzera la quota di una scheda CRM viva'),
    crm_aggancia_alunno: C('corrente', 'collega una scheda CRM viva a un alunno'),
    crm_ai_bambini: C('dichiara', 'accesso AI (#315): inserisce i bambini di una scheda CRM con l\'anno dichiarato (corrente o prossimo della sede)'),
    // ── iscrizioni ──
    iscrizioni_annulla: C('corrente', 'riporta una domanda a pending: domande di oggi'),
    iscrizioni_chiudi: C('corrente', 'chiude (approva) una domanda in lavorazione'),
    iscrizioni_rinvia: C('corrente', 'riporta una domanda a pending'),
    iscrizioni_sanitari_tick: C('oblio', 'job notturno: toglie i dati sanitari dalle domande oltre il termine'),
    // ── registro e scuola ──
    avviso_adesione_gestisci: C('corrente', 'gestisce una risposta ad un avviso vivo (posti, coda)'),
    avviso_adesione_registra: C('corrente', 'registra la risposta di un genitore ad un avviso vivo'),
    gallery_publish_photo: C('corrente', 'pubblica una foto nuova, di oggi'),
    gallery_publish_photo_storico: C('corrente', 'scrive galleria_media_v2 (modo data) con giorno_competenza passato dal chiamante'),
    note_modifica: C('corrente', 'modifica note disciplinari e le loro ricezioni'),
    primaria_ricalcola_periodi: C('corrente', 'ricalcola periodo_id nella stessa transazione della scrittura guardata sui periodi'),
    frequenza_segue_classe_alunno: C('corrente', 'PR 4.3-B: aggiorna section_id della frequenza dell\'anno attivo quando alunni cambia sezione (fail-open, solo service_role)'),
    propaga_rinomina_sezione: C('esente-colonne', 'trigger: riscrive target_classes e classe_sezione (testi derivati dal nome) -- non ancora in anno_colonne_esenti'),
    riaccredita_ticket_e_disdici: C('corrente', 'disdice una prenotazione mensa'),
    salva_comportamento_scrutinio: C('corrente', 'salva il giudizio di comportamento di uno scrutinio aperto'),
    salva_giudizi_scrutinio: C('corrente', 'salva i giudizi di uno scrutinio aperto'),
    scala_ticket_e_prenota: C('corrente', 'crea una prenotazione mensa'),
    storici_versione_aggregato: C('esente-colonne', 'trigger: incrementa solo storico_versione, contatore tecnico che M3 rendera\' esente sulle tabelle che tocca'),
    // ── passaggio d'anno (PR 4.8 e 4.9; classificate il 14/11/2026, la fotografia non era stata rigenerata dopo #307) ──
    passaggio_conferma: C('passaggio', 'accende anno_passaggio.in_corso: chiude le frequenze del vecchio anno, sistema le classi e scrive utenti_sezioni'),
    passaggio_annulla: C('passaggio', 'accende anno_passaggio.in_corso: riporta le frequenze com\'erano e toglie le assegnazioni scritte dalla conferma'),
    passaggio_conferma_tardiva: C('corrente', 'riapre o inserisce la frequenza dell\'anno nuovo di un bambino confermato tardi: passa dalla guardia'),
    passaggio_ricopia_schede: C('corrente', 'job del giorno d\'inizio: chiude la frequenza nuova di chi è stato archiviato dopo la conferma (anno nuovo corrente), passa dalla guardia'),
    // ── oblio ──
    elimina_alunno_definitivo: C('oblio', 'cancella l\'alunno e il suo registro (diario, pagamenti, moduli, fascicolo)'),
    presenze_giustificazioni_retention_tick: C('oblio', 'job notturno: toglie giustificazione_testo e note_appello dalle presenze'),
}

/** Estrae l'oggetto fotografia da qualunque involucro l'MCP/psql gli metta intorno. */
function estrai(grezzo) {
    let v = JSON.parse(grezzo)
    if (Array.isArray(v)) v = v[0]
    if (v && typeof v === 'object' && v.fotografia) v = v.fotografia
    if (!v || !Array.isArray(v.funzioni)) {
        throw new Error('JSON non riconosciuto: manca `funzioni`. Rilancia la query di --sql.')
    }
    return v
}

const confronta = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Normalizzazione: ordine "C" per nome, tabelle ordinate, classe presa da CLASSI. */
export function normalizza(f) {
    const registro = new Set((f.registro ?? []).map(String))
    if (registro.size === 0) throw new Error('Manca `registro` nella risposta: rilancia la query di --sql.')
    const CLASSI_VALIDE = ['corrente', 'esente-colonne', 'oblio', 'macchina-a-stati', 'dichiara', 'passaggio']
    for (const [nome, { classe }] of Object.entries(CLASSI)) {
        if (!CLASSI_VALIDE.includes(classe)) {
            throw new Error(`Classe «${classe}» non valida per ${nome}: ammesse ${CLASSI_VALIDE.join(', ')}.`)
        }
    }
    for (const x of f.funzioni) {
        for (const t of x.tabelle) {
            if (!registro.has(String(t))) {
                throw new Error(`La tabella «${t}» della funzione ${x.funzione} non sta nel registro (anno_tabelle).`)
            }
        }
    }
    const nomi = f.funzioni.map((x) => String(x.funzione))
    const senzaClasse = nomi.filter((n) => !Object.hasOwn(CLASSI, n))
    if (senzaClasse.length > 0) {
        throw new Error(`Funzioni senza classe in CLASSI: ${senzaClasse.join(', ')}. Giudicale e aggiungile.`)
    }
    const presenti = new Set(nomi)
    const orfane = Object.keys(CLASSI).filter((n) => !presenti.has(n))
    if (orfane.length > 0) {
        throw new Error(`CLASSI nomina funzioni che il catalogo non ha piu': ${orfane.join(', ')}. Toglile.`)
    }
    const funzioni = f.funzioni
        .map((x) => ({
            funzione: String(x.funzione),
            tabelle: [...x.tabelle].map(String).sort(confronta),
            classe: CLASSI[x.funzione].classe,
        }))
        .sort((a, b) => confronta(a.funzione, b.funzione))
    return { funzioni }
}

/** Impronta del solo contenuto: `generato_il`, `generato_alle` e `sha256` restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

// Eseguito come script (non importato dai test): legge stdin e scrive la fixture.
import { fileURLToPath } from 'node:url'
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const ADESSO = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    const normalizzata = normalizza(estrai(readFileSync(0, 'utf8')))
    const uscita = {
        _come_si_rigenera:
            'node scripts/funzioni-registro-fotografia.mjs --sql | (esegui su prod) ; node scripts/funzioni-registro-fotografia.mjs < risposta.json',
        generato_il: ADESSO.slice(0, 10),
        generato_alle: ADESSO,
        sha256: impronta(normalizzata),
        ...normalizzata,
    }
    const dest = join(process.cwd(), '__tests__', 'fixtures', 'funzioni-scrivono-registro.json')
    writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
    const perClasse = normalizzata.funzioni.reduce((acc, f) => ({ ...acc, [f.classe]: (acc[f.classe] ?? 0) + 1 }), {})
    process.stdout.write(
        `fotografia scritta: ${dest}\n` +
        `  funzioni: ${normalizzata.funzioni.length}` +
        ` · ${Object.entries(perClasse).map(([k, v]) => `${k}: ${v}`).join(' · ')}` +
        ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
    )
}
