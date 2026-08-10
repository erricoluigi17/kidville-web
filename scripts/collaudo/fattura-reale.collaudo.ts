// @vitest-environment node
/**
 * COLLAUDO SU DATI VERI — genera fatture dall'anagrafica di produzione e le valida,
 * senza inviarne nemmeno una.
 *
 * Ambiente `node` e non `jsdom`: l'aiutante che carica gli XSD risolve i percorsi con
 * `fileURLToPath(import.meta.url)`, e sotto jsdom `import.meta.url` non è un URL di file
 * («The URL must be of scheme file»). Stessa scelta di `__tests__/lib/aruba/fatturapa-xsd.test.ts`.
 *
 * ⚠️ NON GIRA IN CI, ED È DELIBERATO. Parte solo con `COLLAUDO_REALE=1` nell'ambiente:
 * legge il database di PRODUZIONE, e un test che tocca la produzione a ogni push è un
 * incidente in attesa di succedere. Si esegue a mano:
 *
 *   COLLAUDO_REALE=1 npx vitest run __tests__/collaudo/
 *
 * PERCHÉ ESISTE. I test unitari usano dati sintetici, e i dati sintetici sono sempre
 * completi — è il loro difetto. Le fatture si scartano per i buchi dell'anagrafica vera:
 * un codice fiscale che non c'è, un CAP mancante, un genitore senza indirizzo, un legame
 * genitore-figlio che non si risolve. Questo collaudo attraversa la catena intera
 * (`pagamenti → alunni → parents → intestatario → sezionale → causale → XML → XSD`) sui
 * dati reali, e stampa quanti documenti sarebbero emettibili e perché gli altri no.
 *
 * COSA NON FA: **non invia niente ad Aruba e non scrive niente sul database.** Solo SELECT
 * e generazione in memoria. L'unica prova che tocca la rete sta in
 * `scripts/aruba-prova-collegamento.mjs`, ed è di sola lettura.
 *
 * NIENTE DATI PERSONALI NELL'OUTPUT. Nomi e codici fiscali dei minori e dei genitori non
 * vengono stampati: escono conteggi, iniziali e motivi. Il repository è pubblico e questa
 * trascrizione circola.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

import { buildFatturaElettronicaXml } from '@/lib/aruba/fatturapa-xml'
import { cedenteDaConfig, componiIndirizzo } from '@/lib/fatturazione/cedente'
import { validaCessionario, cessionarioCompleto } from '@/lib/fatturazione/cessionario'
import { sezionalePerMinore, annoScolasticoDi, formattaNumeroFattura } from '@/lib/fatturazione/sezionale'
import { causaleFattura } from '@/lib/pagamenti/causale-fattura'
import { validaFatturaPA } from '../../__tests__/lib/aruba/valida-xsd'

const ATTIVO = process.env.COLLAUDO_REALE === '1'

/**
 * Legge una credenziale: prima l'ambiente, poi `.env.local`. Non la stampa mai.
 *
 * ⚠️ L'ambiente VINCE, e serve. La `SUPABASE_SERVICE_ROLE_KEY` scritta in `.env.local`
 * **non appartiene a questo progetto**: PostgREST risponde «Unregistered API key»
 * (misurato il 2026-08-07 e ancora vero il 2026-08-10). Quella giusta si legge dalla CLI
 * già autenticata, e si passa davanti al comando senza toccare il file:
 *
 *   KEY=$(supabase projects api-keys --project-ref uimulkjyekgemjakmepp --experimental -o json \
 *         | python3 -c "import json,sys;print([k['api_key'] for k in json.load(sys.stdin) if k['name']=='service_role'][0])")
 *   SUPABASE_SERVICE_ROLE_KEY="$KEY" COLLAUDO_REALE=1 npx vitest run --config vitest.collaudo.config.ts
 *
 * Questa configurazione non inietta valori finti (`vitest.collaudo.config.ts` non ha
 * `env` né `setupFiles`), quindi qui `process.env` contiene solo ciò che si è scelto di
 * mettere: dare a lui la precedenza è sicuro e rende il collaudo pilotabile dall'esterno.
 */
function env(chiave: string): string {
    if (process.env[chiave]) return String(process.env[chiave])
    try {
        const testo = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
        for (const riga of testo.split('\n')) {
            const m = riga.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
            if (m && m[1] === chiave) {
                const valore = m[2].trim().replace(/^["']|["']$/g, '')
                if (valore) return valore
            }
        }
    } catch { /* assente: se manca anche nell'ambiente, il collaudo lo dice e si ferma */ }
    return ''
}

/** Iniziali al posto del nome. Mai il nome, mai il codice fiscale. */
const iniz = (nome?: string | null, cognome?: string | null) =>
    `${(nome ?? '?').trim().charAt(0) || '?'}.${(cognome ?? '?').trim().charAt(0) || '?'}.`

describe.skipIf(!ATTIVO)('collaudo: fatture generate dall\'anagrafica reale, mai inviate', () => {
    it('attraversa la catena vera e dice quanti documenti sarebbero emettibili', async () => {
        const url = env('SUPABASE_URL') || env('NEXT_PUBLIC_SUPABASE_URL')
        const key = env('SUPABASE_SERVICE_ROLE_KEY')
        expect(url, 'SUPABASE_URL assente').toBeTruthy()
        expect(key, 'SUPABASE_SERVICE_ROLE_KEY assente').toBeTruthy()
        const db = createClient(url, key, { auth: { persistSession: false } })

        // 1. La configurazione del cedente, dalla fonte unica.
        const { data: settings, error: errSet } = await db
            .from('admin_settings')
            .select('scuola_id, fiscale_config, aruba_config, fattura_causali_config')
        expect(errSet, `lettura admin_settings: ${errSet?.message}`).toBeNull()

        // PostgREST tipizza le righe come unione con `GenericStringError`: si normalizza
        // qui, una volta, invece di forzare il tipo a ogni singolo accesso più in basso.
        const righeSettings = (settings ?? []) as unknown as Record<string, unknown>[]
        const perSede = new Map<string, Record<string, unknown>>()
        for (const s of righeSettings) perSede.set(String(s.scuola_id), s)

        // 2. I pagamenti che un giorno diventeranno fatture, con la catena anagrafica.
        const { data: pagamenti, error: errPag } = await db
            .from('pagamenti')
            .select(
                'id, scuola_id, descrizione, importo, scadenza, stato, periodo_competenza, categoria_id, ' +
                'alunni:alunno_id ( id, nome, cognome, codice_fiscale, data_nascita )',
            )
            // Dai più recenti: senza ordinamento PostgREST restituisce un ordine
            // qualunque, e un pagamento appena creato per il collaudo non compariva.
            .order('scadenza', { ascending: false })
            .limit(120)
        expect(errPag, `lettura pagamenti: ${errPag?.message}`).toBeNull()

        const esiti: { motivo: string; quanti: number }[] = []
        const conta = (motivo: string) => {
            const e = esiti.find((x) => x.motivo === motivo)
            if (e) e.quanti++
            else esiti.push({ motivo, quanti: 1 })
        }

        let generate = 0
        let valide = 0
        const problemi: string[] = []
        let primoXml = ''

        const righePagamenti = (pagamenti ?? []) as unknown as Record<string, unknown>[]
        for (const p of righePagamenti) {
            const alunno = p.alunni as Record<string, unknown> | null
            if (!alunno) { conta('pagamento senza alunno collegato'); continue }

            const cfg = perSede.get(String(p.scuola_id))
            if (!cfg) { conta('sede senza admin_settings'); continue }

            // --- il cedente
            const esitoCedente = cedenteDaConfig(
                (cfg.fiscale_config ?? {}) as never,
                (cfg.aruba_config as Record<string, unknown> | null)?.fiscal as never,
            )
            if (!esitoCedente.ok) { conta(`cedente incompleto: ${JSON.stringify(esitoCedente.errori ?? {})}`); continue }

            // --- il sezionale, dal codice fiscale del minore
            const dataDoc = new Date()
            let sezionale: string
            try {
                const esito = sezionalePerMinore({
                    codiceFiscale: alunno.codice_fiscale as string | null,
                    dataNascita: alunno.data_nascita as string | null,
                    annoScolastico: annoScolasticoDi(dataDoc),
                })
                sezionale = esito.sezionale
                if (esito.discordanza) conta('⚠️ CF e data di nascita DISCORDANO (si usa l\'anagrafica)')
                else if (esito.fonte === 'data_nascita') conta('sezionale dalla data di nascita (CF assente o illeggibile)')
            } catch (e) {
                conta(`serie non decidibile: ${(e as Error).message.slice(0, 60)}`)
                continue
            }

            // --- l'intestatario, dall'anagrafica
            const { data: legami } = await db
                .from('student_parents')
                .select('parent_id, parents:parent_id ( id, first_name, last_name, fiscal_code, residence_address, residence_street_number, residence_city, zip_code, residence_province )')
                .eq('student_id', String(alunno.id))
                .limit(2)
            const genitore = (legami ?? [])
                .map((l) => (l as Record<string, unknown>).parents as Record<string, unknown> | null)
                .find(Boolean)
            if (!genitore) { conta('nessun genitore collegato in anagrafica'); continue }

            const cess = {
                codice_fiscale: genitore.fiscal_code as string | null,
                nome: genitore.first_name as string | null,
                cognome: genitore.last_name as string | null,
                indirizzo: componiIndirizzo(
                    genitore.residence_address as string | null,
                    genitore.residence_street_number as string | null,
                ),
                cap: genitore.zip_code as string | null,
                comune: genitore.residence_city as string | null,
            }
            if (!cessionarioCompleto(cess)) {
                conta(`intestatario incompleto: ${Object.keys(validaCessionario(cess)).join('+')}`)
                continue
            }

            // --- la causale, dal modello della categoria
            const causale = causaleFattura({
                config: (cfg.fattura_causali_config ?? {}) as never,
                slugCategoria: null,
                dati: {
                    descrizione: p.descrizione as string,
                    nome: alunno.nome as string,
                    cognome: alunno.cognome as string,
                    codiceFiscale: alunno.codice_fiscale as string | null,
                },
            })

            // --- il documento
            const xml = buildFatturaElettronicaXml({
                progressivoInvio: '1',
                numero: formattaNumeroFattura(sezionale as never, 1, dataDoc.getFullYear()),
                data: dataDoc.toISOString().slice(0, 10),
                cedente: esitoCedente.cedente as never,
                cessionario: {
                    codiceFiscale: String(cess.codice_fiscale),
                    nome: String(cess.nome),
                    cognome: String(cess.cognome),
                    sede: {
                        indirizzo: String(cess.indirizzo),
                        cap: String(cess.cap),
                        comune: String(cess.comune),
                        provincia: (genitore.residence_province as string | null) || undefined,
                        nazione: 'IT',
                    },
                } as never,
                righe: [{ descrizione: causale, prezzoUnitario: Number(p.importo) }],
                totale: Number(p.importo),
                // Lo stesso blocco che passa `emettiFatturaPagamento` (riga ~1046): senza,
                // il documento del collaudo esce privo di `<DatiPagamento>` e non somiglia
                // a quello vero — e un collaudo che misura un documento diverso da quello
                // che partirà non misura niente.
                pagamento: { dataScadenza: String(p.scadenza ?? '').slice(0, 10) || dataDoc.toISOString().slice(0, 10) },
            } as never)
            generate++
            if (!primoXml) primoXml = xml

            const esitoXsd = await validaFatturaPA(xml)
            if (esitoXsd.valido) valide++
            else problemi.push(`${iniz(alunno.nome as string, alunno.cognome as string)} → ${esitoXsd.errori?.[0]?.slice(0, 140)}`)
        }

        // ---- il referto, senza dati personali
        const righe = [
            '',
            '════════ COLLAUDO SU ANAGRAFICA REALE — nessun documento inviato ════════',
            `pagamenti esaminati ......... ${righePagamenti.length}`,
            `fatture GENERATE ............ ${generate}`,
            `valide contro XSD 1.2.3 ..... ${valide}`,
            `non valide .................. ${generate - valide}`,
            '',
            'Perché gli altri non sono emettibili:',
            ...esiti.sort((a, b) => b.quanti - a.quanti).map((e) => `  ${String(e.quanti).padStart(3)} × ${e.motivo}`),
        ]
        if (problemi.length) righe.push('', 'Documenti generati ma NON validi:', ...problemi.slice(0, 10).map((p) => `  · ${p}`))
        if (primoXml) {
            righe.push('', 'Struttura del primo documento generato (solo i tag, senza i valori):')
            const tag = [...primoXml.matchAll(/<([A-Za-z]+)>/g)].map((m) => m[1])
            righe.push(`  ${[...new Set(tag)].join(' · ')}`)
        }
        righe.push('═'.repeat(72), '')
        // Su file, non su console: vitest intercetta `console.log` e il referto sparisce
        // proprio quando serve leggerlo. Il percorso si sceglie con REFERTO_COLLAUDO;
        // senza, finisce accanto al collaudo e NON entra nel repo (`.gitignore`).
        const dove = process.env.REFERTO_COLLAUDO || new URL('./referto.txt', import.meta.url).pathname
        writeFileSync(dove, righe.join('\n'), 'utf8')
        // Il documento intero accanto al referto: la famiglia di prova è sintetica, quindi
        // non c'è PII da proteggere, e serve per il confronto tag-per-tag col tracciato vero.
        if (primoXml) writeFileSync(`${dove}.xml`, primoXml, 'utf8')
        console.log(`referto scritto in ${dove}`)

        // Il collaudo non impone quante fatture siano emettibili — l'anagrafica è quella
        // che è, e scoprirlo è il punto. Impone invece che ogni documento GENERATO sia
        // valido: un XML che il nostro stesso schema rifiuta lo rifiuterebbe anche lo SDI.
        expect(generate - valide, 'ci sono documenti generati che NON validano contro l\'XSD').toBe(0)
    }, 120_000)
})
