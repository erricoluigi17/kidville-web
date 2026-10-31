// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { approvata, senzaCommenti } from '../../architecture/soglia-fotografia'

/**
 * LOCK · LA MIGRAZIONE DELLA QUOTA D'ISCRIZIONE E DELLE SETTIMANE DI DISPONIBILITÀ.
 *
 * Specifica: `docs/superpowers/specs/2026-10-31-crm-quota-e-disponibilita-design.md`.
 * Questo file guarda il TESTO della migrazione; il suo comportamento su un Postgres vero lo prova
 * `migrazione-quota-settimane-sql.test.ts`. Qui stanno le regole che un'altra mano potrebbe
 * rompere senza che un test di comportamento se ne accorga: chi può eseguire le funzioni, quale riga
 * si blocca per prima, che il `DROP TABLE` venga dopo la copia dei dati, che i report non contino due
 * volte i contanti.
 *
 * ⚠️ Due cautele contro il verde falso (tutte e due già pagate in questo repo):
 *  · si legge lo SQL SENZA COMMENTI, ma `senzaCommenti` lascia intatti i commenti dentro un corpo
 *    `$$ … $$`: i corpi delle funzioni li ripuliamo qui, altrimenti un commento che nomina `for update`
 *    farebbe passare un lock che sta cercando la riga vera;
 *  · ogni regola sulle funzioni parte da un controllo che la funzione esista, così che «nessuna
 *    funzione trovata» non sia mai un verde.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
/** La migrazione del CRM: quella nuova deve esserle posteriore. */
const MIGRAZIONE_CRM = '20261030230225'

const FILE = readdirSync(CARTELLA).filter((f) => /^\d{14}_crm_quota_e_settimane\.sql$/.test(f))
const GREZZO = FILE.length === 1 ? readFileSync(join(CARTELLA, FILE[0]), 'utf8') : ''
/** Lo SQL senza commenti e in minuscolo: le regole sotto cercano parole, non maiuscole. */
const SQL = senzaCommenti(GREZZO).toLowerCase()

const CINQUE_FUNZIONI = [
    'crm_quota_passa',
    'crm_quota_segna',
    'crm_quota_togli',
    'crm_aggancia_alunno',
    'crm_salva_settimana',
] as const
const QUATTRO_CHE_BLOCCANO_IL_BAMBINO = ['crm_quota_segna', 'crm_quota_togli', 'crm_quota_passa', 'crm_aggancia_alunno'] as const
const TRE_REPORT = ['report_cassa_aggregato', 'report_cassa_dettaglio', 'conteggio_cassa_provenienza'] as const

/** Una frase SQL → una regex che ignora gli spazi e gli a capo (`numeric(10,2)` e `numeric (10, 2)` sono uguali). */
function frase(testo: string): RegExp {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const corpo = testo
        .trim()
        .split(/\s+/)
        .map(esc)
        .join('\\s+')
        .replace(/\\\(/g, '\\s*\\(\\s*')
        .replace(/\\\)/g, '\\s*\\)')
        .replace(/,/g, '\\s*,\\s*')
    return new RegExp(corpo, 'i')
}

/** Il corpo `$$ … $$` della funzione, senza i commenti `--` che contiene. `null` se la funzione non c'è. */
function corpoDi(nome: string): string | null {
    const testa = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${nome}\\s*\\(`, 'i').exec(SQL)
    if (!testa) return null
    const tag = /\bas\s+(\$[a-z_]*\$)/.exec(SQL.slice(testa.index))
    if (!tag) return null
    const inizio = testa.index + tag.index + tag[0].length
    const fine = SQL.indexOf(tag[1], inizio)
    if (fine < 0) return null
    return SQL.slice(inizio, fine).replace(/--[^\n]*/g, '')
}

/** L'intestazione della funzione: da `create or replace function` fino al `as $$`. */
function testataDi(nome: string): string {
    const testa = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${nome}\\s*\\(`, 'i').exec(SQL)
    if (!testa) return ''
    const resto = SQL.slice(testa.index)
    const fine = resto.search(/\bas\s+\$[a-z_]*\$/)
    return fine < 0 ? '' : resto.slice(0, fine)
}

/**
 * Da dove comincia una lettura di `cassa_movimenti` fino a dove finisce il suo blocco: la prima `)` che
 * chiude la parentesi in cui sta (il CTE), un `;`, o un `union` allo stesso livello.
 */
function finoAFineLettura(corpo: string, da: number): string {
    let livello = 0
    for (let i = da; i < corpo.length; i++) {
        const c = corpo[i]
        if (c === '(') livello++
        else if (c === ')') {
            livello--
            if (livello < 0) return corpo.slice(da, i)
        } else if (c === ';') return corpo.slice(da, i)
        else if (livello === 0 && /^union\b/.test(corpo.slice(i)) && /\W/.test(corpo[i - 1] ?? ' ')) return corpo.slice(da, i)
    }
    return corpo.slice(da)
}

describe('migrazione della quota e delle settimane · il file', () => {
    it('esiste un solo file *_crm_quota_e_settimane.sql, posteriore al CRM', () => {
        expect(FILE).toHaveLength(1)
        expect(FILE[0].slice(0, 14) > MIGRAZIONE_CRM).toBe(true)
        expect(SQL.length).toBeGreaterThan(2000)
    })

    it('il nome ha l’istante vero in UTC, non un orario tondo', () => {
        // Un orario tondo (…0000) è il segno di una version inventata: ricorda `versione_migrazione_nel_futuro`.
        expect(FILE[0].slice(8, 14)).not.toBe('000000')
        expect(FILE[0].slice(10, 14)).not.toBe('0000')
    })
})

describe('migrazione della quota e delle settimane · crm_bambini', () => {
    const colonne: Array<[string, string]> = [
        ['quota_importo', 'add column if not exists quota_importo numeric(10,2) check (quota_importo > 0)'],
        ['quota_metodo', "add column if not exists quota_metodo text check (quota_metodo in ('contanti','carta','bonifico'))"],
        ['quota_anno', 'add column if not exists quota_anno smallint check (quota_anno between 2000 and 2100)'],
        [
            'quota_stato',
            "add column if not exists quota_stato text check (quota_stato in ('senza_importo','in_attesa','in_contabilita','bloccata'))",
        ],
        [
            'quota_blocco_motivo',
            "add column if not exists quota_blocco_motivo text check (quota_blocco_motivo in ('gia_pagata','supera_residuo','piu_voci','entrata_stornata'))",
        ],
        [
            'quota_cassa_movimento_id',
            'add column if not exists quota_cassa_movimento_id uuid references public.cassa_movimenti(id) on delete set null',
        ],
        [
            'quota_pagamento_id',
            'add column if not exists quota_pagamento_id uuid references public.pagamenti(id) on delete set null',
        ],
        ['alunno_id', 'add column if not exists alunno_id uuid references public.alunni(id) on delete set null'],
        ['alunno_collegato_il', 'add column if not exists alunno_collegato_il timestamptz'],
    ]

    it('aggiunge a crm_bambini tutte le colonne della quota e dell’alunno, con i loro vincoli', () => {
        expect(SQL).toMatch(frase('alter table public.crm_bambini'))
        for (const [nome, riga] of colonne) {
            expect(SQL, `manca la colonna ${nome}: ${riga}`).toMatch(frase(riga))
        }
    })

    it('un alunno si collega a UN solo bambino del CRM (vincolo con nome), e la quota è coerente col suo stato', () => {
        expect(SQL).toMatch(frase('constraint crm_bambini_alunno_unico unique (alunno_id)'))
        expect(SQL).toMatch(
            frase(
                "constraint crm_bambini_quota_completa check (quota_stato is null or quota_stato = 'senza_importo' or (quota_importo is not null and quota_metodo is not null and quota_anno is not null and quota_saldata_il is not null))",
            ),
        )
        expect(SQL).toMatch(
            frase(
                "constraint crm_bambini_quota_blocco check ((quota_stato is not distinct from 'bloccata') = (quota_blocco_motivo is not null))",
            ),
        )
    })

    it('la vecchia spunta resta nel database ma dismessa: nessuna colonna tolta', () => {
        expect(SQL).not.toMatch(/drop\s+column/)
        expect(SQL).toMatch(frase("update public.crm_bambini set quota_stato = 'senza_importo' where quota_saldata and quota_stato is null"))
        expect(SQL).toMatch(/comment\s+on\s+column\s+public\.crm_bambini\.quota_saldata\s+is\s+'dismessa dal 31\/10\/2026/)
    })
})

describe('migrazione della quota e delle settimane · le settimane', () => {
    it('la proprietà di una settimana è unica con i NULL non distinti (nullo = la sede)', () => {
        expect(SQL).toMatch(/unique\s+nulls\s+not\s+distinct\s*\(\s*scuola_id,\s*utente_id,\s*settimana\s*\)/)
        expect(SQL).toMatch(/constraint\s+crm_settimane_proprietario\s+unique\s+nulls\s+not\s+distinct/)
    })

    it('la settimana comincia di lunedì, e le fasce stanno nella sede della loro settimana (chiave composta)', () => {
        expect(SQL).toMatch(frase('check (extract(isodow from settimana) = 1)'))
        expect(SQL).toMatch(frase('unique (id, scuola_id)'))
        expect(SQL).toMatch(
            frase('foreign key (settimana_id, scuola_id) references public.crm_settimane (id, scuola_id) on delete cascade'),
        )
    })

    it('le due tabelle nuove hanno la RLS accesa e nessuna policy (le legge solo il service-role)', () => {
        expect(SQL).toMatch(frase('alter table public.crm_settimane enable row level security'))
        expect(SQL).toMatch(frase('alter table public.crm_fasce enable row level security'))
        expect(SQL).not.toMatch(/create\s+policy/)
    })

    it('ogni chiave esterna nuova ha il suo indice', () => {
        const indici = [
            'on public.crm_bambini (quota_cassa_movimento_id)',
            'on public.crm_bambini (quota_pagamento_id)',
            'on public.crm_settimane (utente_id)',
            'on public.crm_settimane (aggiornata_da)',
            'on public.crm_fasce (settimana_id, scuola_id)',
            // `crm_fasce.scuola_id` punta a `schools`: l'indice sopra ha `settimana_id` in testa e non lo copre.
            'on public.crm_fasce (scuola_id)',
        ]
        for (const i of indici) {
            expect(SQL, `manca l’indice ${i}`).toMatch(new RegExp(`create\\s+index\\s+(?:if\\s+not\\s+exists\\s+)?\\w+\\s+${frase(i).source}`))
        }
        // L'elenco delle quote ancora da portare in contabilità: parziale, per sede e stato.
        expect(SQL).toMatch(
            frase(
                "on public.crm_bambini (scuola_id, quota_stato) where quota_stato in ('senza_importo','in_attesa','bloccata')",
            ),
        )
    })
})

describe('migrazione della quota e delle settimane · la conversione e il DROP TABLE', () => {
    it('il DROP TABLE di crm_disponibilita è approvato, è l’unico, e viene DOPO la copia dei dati', () => {
        expect(approvata(GREZZO)).toBe(true)
        // Il commento sta DIRETTAMENTE sopra l'istruzione che approva, non in un angolo del file.
        expect(GREZZO).toMatch(/--\s*distruttiva approvata:[^\n]+\n\s*drop\s+table\s+public\.crm_disponibilita\s*;/i)
        expect([...SQL.matchAll(/drop\s+table\b/g)]).toHaveLength(1)
        const copia = SQL.indexOf('insert into public.crm_fasce')
        const toglie = SQL.indexOf('drop table public.crm_disponibilita')
        expect(copia).toBeGreaterThan(-1)
        expect(toglie).toBeGreaterThan(-1)
        expect(copia).toBeLessThan(toglie)
        // Anche le testate vengono create prima di togliere la tabella.
        expect(SQL.indexOf('insert into public.crm_settimane')).toBeLessThan(toglie)
    })

    it('copia solo le fasce ancora valide, una settimana per proprietario, nella settimana in corso', () => {
        expect(SQL).toMatch(/valida_al\s+is\s+null\s+or\s+\w*\.?valida_al\s*>=\s*current_date/)
        expect(SQL).toMatch(/date_trunc\(\s*'week'\s*,\s*current_date\s*\)::date/)
    })
})

describe('migrazione della quota e delle settimane · le cinque funzioni', () => {
    it('sanity: tutte e cinque le funzioni esistono, con un corpo vero', () => {
        for (const nome of CINQUE_FUNZIONI) {
            const corpo = corpoDi(nome)
            expect(corpo, `manca la funzione ${nome}`).not.toBeNull()
            expect((corpo ?? '').length, nome).toBeGreaterThan(300)
        }
    })

    it('sono tutte plpgsql, SECURITY INVOKER e con il search_path fissato', () => {
        for (const nome of CINQUE_FUNZIONI) {
            const testata = testataDi(nome)
            expect(testata, nome).toMatch(/language\s+plpgsql/)
            expect(testata, nome).toMatch(/security\s+invoker/)
            expect(testata, nome).toMatch(/set\s+search_path\s*=\s*public\s*,\s*pg_temp/)
            expect(testata, nome).toMatch(/returns\s+jsonb/)
        }
    })

    it('le cinque funzioni sono solo del service_role, e ciascuna ha il suo COMMENT', () => {
        for (const nome of CINQUE_FUNZIONI) {
            expect(SQL, `${nome}: REVOKE`).toMatch(
                new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${nome}\\s*\\([^)]*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`),
            )
            expect(SQL, `${nome}: GRANT`).toMatch(
                new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${nome}\\s*\\([^)]*\\)\\s+to\\s+service_role\\s*;`),
            )
            expect(SQL, `${nome}: COMMENT`).toMatch(new RegExp(`comment\\s+on\\s+function\\s+public\\.${nome}\\s*\\(`))
        }
        // Nessun GRANT a ruoli pubblici, da nessuna parte.
        expect(SQL).not.toMatch(/grant\s+[^;]*\bto\s+(public|anon|authenticated)\b/)
    })

    it('crm_quota_segna, crm_quota_togli, crm_quota_passa e crm_aggancia_alunno bloccano il bambino PRIMA di ogni scrittura', () => {
        for (const nome of QUATTRO_CHE_BLOCCANO_IL_BAMBINO) {
            const corpo = corpoDi(nome) ?? ''
            const blocco = /select[^;]*?from\s+public\.crm_bambini\b[^;]*?\bfor\s+update\b/.exec(corpo)
            expect(blocco, `${nome}: manca il SELECT … FROM crm_bambini … FOR UPDATE`).not.toBeNull()
            // Due richieste in volo sullo stesso bambino (il doppio clic) si mettono in fila: la riga si blocca
            // prima di leggere lo stato e prima di scrivere qualunque cosa.
            const fineBlocco = (blocco?.index ?? 0) + (blocco?.[0].length ?? 0)
            for (const scrittura of ['insert into', 'update public.', 'delete from', 'public.registra_incasso_voce(', 'public.crm_quota_passa(']) {
                const dove = corpo.indexOf(scrittura)
                if (dove >= 0) expect(dove, `${nome}: «${scrittura}» prima del blocco della riga`).toBeGreaterThan(fineBlocco - 1)
            }
        }
    })

    it('crm_salva_settimana è una sola scrittura: la testata si prende con ON CONFLICT sul vincolo, poi le fasce si sostituiscono', () => {
        const corpo = corpoDi('crm_salva_settimana') ?? ''
        expect(corpo).toMatch(/on\s+conflict\s+on\s+constraint\s+crm_settimane_proprietario\s+do\s+update/)
        const testata = corpo.indexOf('on conflict')
        const cancella = corpo.indexOf('delete from public.crm_fasce')
        const inserisce = corpo.indexOf('insert into public.crm_fasce')
        expect(testata).toBeGreaterThan(-1)
        expect(cancella).toBeGreaterThan(testata)
        expect(inserisce).toBeGreaterThan(cancella)
        expect(corpo).toMatch(/jsonb_to_recordset\(\s*p_fasce\s*\)/)
        expect(corpo).toMatch(/europe\/rome/)
    })

    it('il passaggio in contabilità usa il percorso della contabilità: carta diventa pos, la competenza è il 1° settembre', () => {
        const corpo = corpoDi('crm_quota_passa') ?? ''
        expect(corpo).toMatch(/when\s+'carta'\s+then\s+'pos'/)
        expect(corpo).toMatch(/make_date\([^)]*,\s*9\s*,\s*1\s*\)/)
        // Stesso percorso di `POST /api/pagamenti/incassi`: mai un INSERT scritto a parte sugli incassi.
        expect(corpo).toMatch(/public\.registra_incasso_voce\(/)
        expect(corpo).not.toMatch(/insert\s+into\s+public\.incassi\b/)
    })

    it('la categoria della quota è quella di sistema, globale, con slug iscrizione (mai un uuid scritto a mano)', () => {
        for (const nome of ['crm_quota_passa', 'crm_quota_segna'] as const) {
            const corpo = corpoDi(nome) ?? ''
            expect(corpo, nome).toMatch(/slug\s*=\s*'iscrizione'/)
            expect(corpo, nome).toMatch(/is_sistema/)
            expect(corpo, nome).toMatch(/scuola_id\s+is\s+null/)
        }
        expect(SQL).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
    })

    it('lo storno della quota è quello della cassa: contro-movimento, stornato_il, motivo e riga in registro_modifiche', () => {
        for (const nome of ['crm_quota_segna', 'crm_quota_togli'] as const) {
            const corpo = corpoDi(nome) ?? ''
            expect(corpo, nome).toMatch(/storno_di/)
            expect(corpo, nome).toMatch(/stornato_il\s*=\s*now\(\)/)
            expect(corpo, nome).toMatch(/storno_motivo/)
            expect(corpo, nome).toMatch(/insert\s+into\s+public\.registro_modifiche/)
            expect(corpo, nome).toMatch(/'storno_cassa_movimento'/)
        }
        expect(corpoDi('crm_quota_segna')).toContain("quota d''iscrizione corretta dal crm")
        expect(corpoDi('crm_quota_togli')).toContain("quota d''iscrizione tolta dal crm")
    })

    it('la funzione dell’aggancio intercetta la 23505 della sola crm_bambini_alunno_unico', () => {
        const corpo = corpoDi('crm_aggancia_alunno') ?? ''
        expect(corpo).toMatch(/exception\s+when\s+unique_violation/)
        expect(corpo).toMatch(/crm_bambini_alunno_unico/)
        expect(corpo).toMatch(/'alunno_gia_collegato'/)
    })
})

describe('migrazione della quota e delle settimane · lo storico del CRM', () => {
    it('i cinque tipi nuovi sono in coda al vincolo di crm_eventi.tipo, nell’ordine del vocabolario', () => {
        const m = /add\s+constraint\s+crm_eventi_tipo_check\s+check\s*\(\s*tipo\s+in\s*\(([^)]*)\)\s*\)/.exec(SQL)
        expect(m).not.toBeNull()
        const valori = [...(m?.[1] ?? '').matchAll(/'([^']*)'/g)].map((v) => v[1])
        expect(valori.slice(-5)).toEqual(['quota_in_contabilita', 'quota_corretta', 'quota_tolta', 'alunno_collegato', 'alunno_scollegato'])
        // Il vincolo vecchio si toglie e si rimette in un solo ALTER: nessun istante senza vincolo.
        expect(SQL).toMatch(/drop\s+constraint\s+crm_eventi_tipo_check\s*,\s*add\s+constraint\s+crm_eventi_tipo_check/)
    })

    it('in dati degli eventi finiscono solo uuid, importi, metodo, giorno e anno: mai nome né descrizione', () => {
        for (const nome of CINQUE_FUNZIONI) {
            const corpo = corpoDi(nome) ?? ''
            expect(corpo.length, `${nome}: senza corpo il controllo sarebbe verde sul vuoto`).toBeGreaterThan(300)
            // Le chiavi di `jsonb_build_object` che finiscono in crm_eventi.dati non nominano testo libero.
            for (const proibita of ["'nome'", "'descrizione'", "'testo'", "'note'", "'genitore_nome'"]) {
                expect(corpo, `${nome}: ${proibita} in un oggetto jsonb`).not.toContain(`${proibita},`)
            }
        }
    })
})

describe('migrazione della quota e delle settimane · i report non contano due volte i contanti', () => {
    it('le tre funzioni dei report escludono i movimenti assorbiti da un incasso, a OGNI lettura di cassa_movimenti', () => {
        for (const nome of TRE_REPORT) {
            const corpo = corpoDi(nome)
            expect(corpo, `manca la funzione ${nome}`).not.toBeNull()
            const testo = corpo ?? ''
            const nominate = [...testo.matchAll(/cassa_movimenti/g)].length
            const letture = [...testo.matchAll(/\b(?:from|join)\s+public\.cassa_movimenti\s+(?:as\s+)?([a-z_][a-z0-9_]*)\b/g)]
            // Ogni volta che la tabella è nominata, è una lettura con un alias: nessuna lettura sfugge al controllo.
            expect(letture.length, `${nome}: legge cassa_movimenti`).toBeGreaterThan(0)
            expect(letture.length, `${nome}: una lettura di cassa_movimenti senza alias o in altra forma`).toBe(nominate)
            for (const lettura of letture) {
                const alias = lettura[1]
                const blocco = finoAFineLettura(testo, lettura.index ?? 0)
                expect(blocco, `${nome}: la lettura con alias «${alias}» non esclude ${alias}.incasso_id`).toMatch(
                    new RegExp(`\\b${alias}\\.incasso_id\\s+is\\s+null\\b`),
                )
            }
        }
    })

    it('firma e permessi delle tre funzioni restano quelli di prima', () => {
        const firme: Record<(typeof TRE_REPORT)[number], string> = {
            report_cassa_aggregato: 'uuid[], date, date, uuid',
            report_cassa_dettaglio: 'uuid[], text, date, date, uuid, boolean, text, integer, integer',
            conteggio_cassa_provenienza: 'uuid[], date, date',
        }
        for (const nome of TRE_REPORT) {
            expect(SQL, `${nome}: REVOKE`).toMatch(
                new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${nome}\\s*\\(\\s*${firme[nome].replace(/[[\]]/g, '\\$&').replace(/,\s*/g, '\\s*,\\s*')}\\s*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated`),
            )
            expect(SQL, `${nome}: GRANT`).toMatch(
                new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${nome}\\s*\\(\\s*${firme[nome].replace(/[[\]]/g, '\\$&').replace(/,\s*/g, '\\s*,\\s*')}\\s*\\)\\s+to\\s+service_role`),
            )
            expect(testataDi(nome), nome).toMatch(/security\s+invoker/)
            expect(testataDi(nome), nome).toMatch(/stable/)
        }
    })

    it('la migrazione chiude con il ricaricamento dello schema di PostgREST', () => {
        expect(SQL.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
    })
})
