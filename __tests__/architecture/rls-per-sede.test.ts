import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · la RLS deve rispondere «su quale sede», non solo «che ruolo hai».
 *
 * Perché esiste. Fino al 2026-07-31 il modello di autorizzazione per sede viveva
 * INTERAMENTE nello strato applicativo (`resolveScuoleAttive`, `utenti_scuole`,
 * `requireStaff`). La RLS era rimasta all'era mono-sede, e nessun test la guardava:
 * `grep -rln 'pg_policies' __tests__/` dava zero file. Sotto ci stavano 33 policy
 * `SELECT TO authenticated USING (true)` — fra cui la tracciabilità delle FIRME
 * ELETTRONICHE con valore legale, l'elenco dei minori con fascicolo PEI/PDP/104 e il
 * registro immutabile delle scritture dei docenti — e cinque policy dello staff che
 * confrontavano il ruolo e mai la sede.
 *
 * È il difetto di questa famiglia: **non rompe niente e non avvisa nessuno,
 * restituisce solo più righe del dovuto.** Nessun errore, nessun log, nessun test
 * rosso. Un lock è l'unico modo per accorgersene il giorno in cui ricompare.
 *
 * Come funziona. Il test gira OFFLINE (in CI non c'è il database di produzione):
 * legge la fotografia versionata `__tests__/fixtures/pg-policies-snapshot.json`.
 * La fotografia si rigenera con `scripts/rls-fotografia.mjs` — le istruzioni sono
 * nell'intestazione dello script e nei messaggi d'errore qui sotto. Porta un
 * `sha256` del contenuto: non si può ammorbidire il file a mano per far tacere il
 * lock senza che il lock se ne accorga.
 *
 * Contiene SOLO le policy che valgono per un ruolo diverso da `service_role`: il
 * service-role ha BYPASSRLS e le sue policy sono `USING (true)` per costruzione,
 * quindi sarebbero 74 eccezioni permanenti — cioè il rumore in cui una policy vera
 * passerebbe inosservata.
 */

type Policy = {
    tabella: string
    policy: string
    cmd: string
    permissive: string
    ruoli: string[]
    using_expr: string
    check_expr: string
}

type Fotografia = {
    generato_il: string
    sha256: string
    policy_solo_service_role: number
    policies: Policy[]
    tabelle_con_scuola_id: string[]
    tabelle_rls_attiva: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWLIST — un'eccezione si dichiara QUI, con la ragione scritta accanto.
//
// Chiave: `<tabella> · <nome policy>`. Esenta da «predicato nudo» e da «vincolo di
// sede», MAI dal divieto di `auth.role()`.
//
// Il criterio, e vale la pena scriverlo perché è l'unica cosa che tiene onesta
// questa lista: può stare qui SOLO configurazione — orari, menù, materie, causali,
// modelli. Se la tabella contiene un dato riferibile a un minore, una firma, un
// accesso o il grafo di chi-può-vedere-cosa, la risposta non è l'allowlist: è il
// deny. Le route usano il client service-role e scavalcano la RLS, quindi negare
// non toglie niente all'applicazione.
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWLIST: Record<string, string> = {
    'campanelle · read campanelle':
        'configurazione didattica: orari di campanella per sezione, nessun dato personale',
    'giudizi_sintetici_scala · read giudizi_sintetici_scala':
        'configurazione didattica: scala dei giudizi sintetici (Ottimo/Distinto/…), nessun dato personale',
    'giudizio_template · read giudizio_template':
        'configurazione didattica: modelli di giudizio, nessun dato personale',
    'materie · read materie':
        'configurazione didattica: elenco delle materie, nessun dato personale',
    'materie_preset · read materie_preset':
        'tabella di dominio: preset ministeriali delle materie, uguale per tutte le sedi',
    'mensa_menu_override · read mensa override':
        'configurazione mensa: menù del giorno, nessun dato personale',
    'mensa_menu_rotazione · read mensa rotazione':
        'configurazione mensa: rotazione settimanale dei menù, nessun dato personale',
    'obiettivi_apprendimento · read obiettivi_apprendimento':
        'configurazione didattica: obiettivi curricolari, nessun dato personale',
    // `orario_settimanale` e `sezione_materia_obiettivo` erano qui fino al 2026-08-01, con
    // la motivazione «configurazione didattica, nessun dato personale». Era vero sul dato e
    // falso sull'effetto: quelle due tabelle portano `section_id`, e con tre plessi la
    // sezione È la sede. Un genitore di Aversa leggeva l'organizzazione didattica di
    // Giugliano — e la leggeva da fuori l'app, con la sola chiave pubblica del browser.
    // Chiuse dalla migrazione `20260801081633_policy_orario_per_sede.sql`: ora il genitore
    // vede la sola sezione dove ha un figlio. **Le voci non si rimettono**: il lock
    // «l'ALLOWLIST non contiene voci morte» diventa rosso, ed è quello che deve fare.
    'scrutinio_periodi · read scrutinio_periodi':
        'configurazione didattica: date e stato dei periodi di scrutinio, nessun dato personale',
    'tempo_scuola · read tempo_scuola':
        'configurazione didattica: tempo scuola per sezione, nessun dato personale',
    'payment_categories · read categories':
        'configurazione contabile: nome e tipo delle causali; il nome di una causale non è un dato di un minore',
    'news_categorie · auth read news_categorie':
        'configurazione editoriale: categorie di news attive, nessun dato personale',
    'form_models · fm_select_active_authenticated':
        'modello di modulo attivo (titolo, descrizione, schema): nessun dato di famiglie. Il vincolo di sede su form_models appartiene alla famiglia «scuola_id NULL = globale», non a questo lock',
}

const FOTOGRAFIA = join(process.cwd(), '__tests__', 'fixtures', 'pg-policies-snapshot.json')
const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

const COME_RIGENERARE =
    'Rigenera la fotografia: `node scripts/rls-fotografia.mjs --sql` → esegui la query sul DB ' +
    'di produzione (sola lettura) → `node scripts/rls-fotografia.mjs < risposta.json`.'

const foto: Fotografia = JSON.parse(readFileSync(FOTOGRAFIA, 'utf8'))

/** Le espressioni di una policy, concatenate: USING + WITH CHECK. */
function espressioni(p: Policy): string {
    return `${p.using_expr} ${p.check_expr}`
}

/** La policy nomina la sede? */
function vincolaLaSede(p: Policy): boolean {
    return /\bscuola_id\b/.test(espressioni(p))
}

/**
 * La policy autorizza in base al solo RUOLO?
 *
 * Forma: `EXISTS (SELECT 1 FROM utenti u WHERE u.id = auth.uid() AND u.role IN
 * ('admin','coordinator'))`. Sembra un ancoraggio all'identità perché contiene
 * `auth.uid()`, ma quell'uid serve solo a leggere il ruolo di chi chiama: NON tocca
 * mai la riga a cui si sta accedendo. È letteralmente «che ruolo hai», mai «su quale
 * sede» — la forma di `staff full pagamenti`, che era FOR ALL su tutte le sedi.
 *
 * Il discriminante è la sede: se il predicato interroga `utenti` per il ruolo e non
 * nomina mai `scuola_id`, non isola niente.
 */
function soloControlloDiRuolo(p: Policy): boolean {
    const e = espressioni(p)
    return /\butenti\b/.test(e) && /\b(ruolo|role)\b/.test(e) && !/\bscuola_id\b/.test(e)
}

/**
 * La policy deduce il permesso dall'appartenenza a una sede, senza mai guardare il ruolo?
 *
 * Forma: `scuola_id IN (SELECT scuola_id FROM utenti WHERE id = auth.uid())`. Era
 * corretta quando `utenti` conteneva solo il personale. Da quando
 * `ensureParentIdentity` crea un record `utenti` anche per ogni genitore, quel
 * predicato ha cambiato significato senza che una riga di SQL cambiasse: dice
 * «chiunque della sede», genitori compresi. È il difetto delle policy di `presenze`,
 * e nel 2026-07 lo avevano anche tre policy che nel NOME dicono «Maestre».
 */
function sedeSenzaRuolo(p: Policy): boolean {
    const e = espressioni(p)
    return /\butenti\b/.test(e) && /\bscuola_id\b/.test(e) && !/\b(ruolo|role)\b/.test(e)
}

/**
 * La policy si àncora all'identità di chi chiama SULLA RIGA? `auth.uid()` confrontato
 * con una colonna (`maestra_id`, `utente_id`, `user_id`, `creato_da`) e
 * `current_parent_student_ids()` (SECURITY DEFINER: ritorna i SOLI figli del
 * chiamante) sono gli ancoraggi ammessi.
 *
 * `is_staff_or_admin()` NON lo è: risponde «sei del personale?», che è una domanda
 * sul ruolo. E nemmeno la ricerca del proprio ruolo in `utenti` — vedi sopra.
 */
function vincolaLIdentita(p: Policy): boolean {
    if (soloControlloDiRuolo(p)) return false
    return /auth\.uid\(\)|current_parent_student_ids/.test(espressioni(p))
}

function chiave(p: Policy): string {
    return `${p.tabella} · ${p.policy}`
}

function motivoInAllowlist(p: Policy): string | undefined {
    return ALLOWLIST[chiave(p)]
}

describe('lock architettura · RLS per sede (fotografia di pg_policies)', () => {
    it('la fotografia non è stata addomesticata a mano (sha256)', () => {
        // Stesse chiavi, stesso ordine di `normalizza()` in scripts/rls-fotografia.mjs:
        // l'impronta copre il contenuto, non i metadati (`generato_il`, `sha256`).
        const contenuto = {
            policy_solo_service_role: foto.policy_solo_service_role,
            policies: foto.policies,
            tabelle_con_scuola_id: foto.tabelle_con_scuola_id,
            tabelle_rls_attiva: foto.tabelle_rls_attiva,
        }
        const atteso = createHash('sha256').update(JSON.stringify(contenuto)).digest('hex')
        expect(
            foto.sha256,
            `Il contenuto della fotografia non corrisponde al suo sha256: qualcuno l'ha ` +
            `modificata a mano invece di rigenerarla. ${COME_RIGENERARE}`,
        ).toBe(atteso)
    })

    it('la fotografia è piena e plausibile (se cade, il lock si sta autoingannando)', () => {
        // Soglia tarata sul valore reale: 44 policy non-service_role dopo la pulizia
        // del 2026-07-31 (erano 81). Serve solo a far cadere il lock se la query
        // tornasse vuota o dimezzata — un lock che gira su una fotografia vuota passa
        // sempre, ed è il modo più silenzioso di non controllare niente.
        expect(foto.policies.length).toBeGreaterThan(30)
        expect(foto.tabelle_con_scuola_id.length).toBeGreaterThan(50)
        expect(foto.tabelle_rls_attiva.length).toBeGreaterThan(100)
        // Tabelle che DEVONO esserci: se sparissero dalla query, il lock passerebbe a vuoto.
        for (const t of ['pagamenti', 'presenze', 'form_models', 'registro_orario']) {
            expect(foto.tabelle_con_scuola_id).toContain(t)
        }
        expect(foto.policies.every((p) => !(p.ruoli.length === 1 && p.ruoli[0] === 'service_role'))).toBe(true)
    })

    it('nessuna policy usa `auth.role()` come predicato (nessuna eccezione ammessa)', () => {
        // `auth.role() = 'authenticated'` non è una restrizione: è il nome del ruolo
        // che la policy sta già filtrando. Era il predicato che lasciava a QUALUNQUE
        // utente loggato — genitore compreso, con la sola chiave anon del browser —
        // scrivere il registro, riscrivere le note disciplinari e inserire firme
        // docente a nome altrui (droppate il 2026-07-31).
        const colpevoli = foto.policies.filter((p) => /auth\.role\(\)/.test(espressioni(p))).map(chiave)
        expect(colpevoli, 'Policy con `auth.role()`: è uno scaffolding di Supabase Studio, non un permesso.').toEqual([])
    })

    it('nessuna policy permissiva ha `true` come predicato, salvo eccezioni dichiarate', () => {
        const colpevoli = foto.policies
            .filter((p) => p.permissive === 'PERMISSIVE')
            .filter((p) => p.using_expr === 'true' || p.check_expr === 'true')
            .filter((p) => !motivoInAllowlist(p))
            .map(chiave)
        expect(
            colpevoli,
            `Policy con predicato \`true\` per un ruolo non-service_role. Su una tabella con ` +
            `dati di minori, firme o audit questo È l'assenza di isolamento. Droppa la policy ` +
            `(le route usano il service-role: il deny non rompe nulla) oppure — se è ` +
            `configurazione — dichiarala nell'ALLOWLIST di questo file CON LA RAGIONE. ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('nessuna policy autorizza in base al solo ruolo, senza mai confrontare la sede', () => {
        // `certificati_medici` e `notifiche` non hanno nemmeno la colonna scuola_id:
        // qui non c'è un vincolo da aggiungere, c'è una policy da togliere.
        const colpevoli = foto.policies
            .filter(soloControlloDiRuolo)
            .filter((p) => !motivoInAllowlist(p))
            .map((p) => `${chiave(p)} [${p.cmd}]`)
        expect(
            colpevoli,
            `Policy che interrogano utenti.ruolo e non nominano mai la sede. L'uid serve solo ` +
            `a leggere il ruolo di chi chiama: la riga a cui si accede non viene mai guardata. ` +
            `Aggiungi il confronto di sede, oppure droppa la policy. ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('nessuna policy tratta «appartenere alla sede» come «essere del personale»', () => {
        const colpevoli = foto.policies
            .filter(sedeSenzaRuolo)
            .filter((p) => !motivoInAllowlist(p))
            .map((p) => `${chiave(p)} [${p.cmd}]`)
        expect(
            colpevoli,
            `Policy che confrontano \`utenti.scuola_id\` senza filtrare il ruolo. Tutti i ` +
            `genitori hanno un record in \`utenti\` con \`scuola_id\` valorizzato: quel ` +
            `predicato non seleziona il personale, seleziona chiunque. Aggiungi ` +
            `\`u.ruolo <> 'genitore'\` (e per il docente l'intersezione con utenti_sezioni). ` +
            `${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('ogni policy su tabella con scuola_id vincola la sede o l\'identità di chi chiama', () => {
        const conSede = new Set(foto.tabelle_con_scuola_id)
        const colpevoli = foto.policies
            .filter((p) => conSede.has(p.tabella))
            .filter((p) => !vincolaLaSede(p) && !vincolaLIdentita(p))
            .filter((p) => !motivoInAllowlist(p))
            .map((p) => `${chiave(p)} [${p.cmd}]`)
        expect(
            colpevoli,
            `Policy su una tabella che HA scuola_id, che però non nomina mai la sede né ` +
            `l'identità del chiamante: risponde a «che ruolo hai» quando la domanda è «su ` +
            `quale sede». Aggiungi il vincolo ` +
            `(scuola_id = u.scuola_id OR scuola_id IN (SELECT scuola_id FROM utenti_scuole …)), ` +
            `oppure droppala. ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('ogni policy di SCRITTURA vincola la sede o l\'identità di chi scrive', () => {
        const scrittura = new Set(['INSERT', 'UPDATE', 'DELETE', 'ALL'])
        const colpevoli = foto.policies
            .filter((p) => scrittura.has(p.cmd))
            .filter((p) => !vincolaLaSede(p) && !vincolaLIdentita(p))
            .filter((p) => !motivoInAllowlist(p))
            .map((p) => `${chiave(p)} [${p.cmd}]`)
        expect(
            colpevoli,
            `Policy di scrittura che autorizza in base al solo RUOLO. È la forma di ` +
            `«staff full pagamenti»: FOR ALL, nessun confronto di sede — il coordinatore di un ` +
            `plesso poteva cancellare i pagamenti degli altri. ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('nessuna migrazione più recente della fotografia tocca le policy senza rigenerarla', () => {
        const dataFoto = foto.generato_il.replace(/-/g, '') // YYYYMMDD
        const inSospeso = readdirSync(MIGRAZIONI)
            .filter((f) => f.endsWith('.sql'))
            .filter((f) => /^\d{8}/.test(f) && f.slice(0, 8) > dataFoto)
            .filter((f) => /\b(CREATE|DROP|ALTER)\s+POLICY\b/i.test(readFileSync(join(MIGRAZIONI, f), 'utf8')))
        expect(
            inSospeso,
            `Queste migrazioni cambiano le policy ma sono posteriori alla fotografia ` +
            `(${foto.generato_il}): il lock starebbe controllando uno stato che non esiste più. ` +
            `${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('l\'ALLOWLIST non contiene voci morte (una policy droppata non lascia un\'esenzione dietro)', () => {
        const presenti = new Set(foto.policies.map(chiave))
        const morte = Object.keys(ALLOWLIST).filter((k) => !presenti.has(k))
        expect(morte, 'Voci di ALLOWLIST che non corrispondono a nessuna policy: rimuovile.').toEqual([])
    })

    it('ogni voce dell\'ALLOWLIST ha una ragione scritta, non un segnaposto', () => {
        for (const [k, motivo] of Object.entries(ALLOWLIST)) {
            expect(motivo.length, `L'eccezione «${k}» non ha una ragione scritta.`).toBeGreaterThan(30)
        }
    })
})
