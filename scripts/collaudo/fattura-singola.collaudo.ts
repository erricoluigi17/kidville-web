// @vitest-environment node
/**
 * COLLAUDO MIRATO SU **UN SOLO** PAGAMENTO — genera in memoria il documento che
 * partirebbe davvero, e lo verifica. Nessuna chiamata ad Aruba, nessuna scrittura.
 *
 * ─── PERCHÉ ESISTE, ACCANTO A `fattura-reale.collaudo.ts` ────────────────────
 * Il collaudo vicino risponde a «quante delle fatture emettibili escono valide»:
 * scorre gli ultimi 120 pagamenti, conta, e sui casi buoni non guarda nel dettaglio.
 * Questo risponde a un'altra domanda, che si fa **una volta sola e appena prima**
 * che una persona prema «Riprova» su una fattura vera: *quel* documento, per *quel*
 * pagamento, com'è fatto esattamente? Serie giusta? Regime giusto? Bollo assente
 * come è stato deciso? Totale al centesimo?
 *
 * Le due domande non si rispondono con lo stesso strumento. Un conteggio che dice
 * «120 su 120 valide» non dice se il documento numero 87 ha il bollo che non doveva
 * avere: lo XSD il bollo lo accetta benissimo. Qui si asserisce **elemento per
 * elemento**, e ogni asserzione porta il proprio messaggio.
 *
 * ─── COSA NON FA, ED È IL PUNTO ──────────────────────────────────────────────
 *  · **Non parla con Aruba.** Non importa niente da `@/lib/aruba/client` — né
 *    direttamente né passando da `@/lib/aruba/emissione`, che quel modulo se lo
 *    porta dietro. Il numero è un SEGNAPOSTO (`1`), non viene chiesto a nessuno.
 *    Aruba limita l'autenticazione a 1/min per IP e le ricerche a 12/min: una
 *    chiamata di troppo da qui brucia la finestra dell'emissione vera.
 *  · **Non ricalcola a modo proprio ciò che l'emissione decide con un modulo.**
 *    Le QUOTE passano da `determinaQuoteFatturazione` e l'intestatario da
 *    `resolveParentRegistry` (`@/lib/pagamenti/intestatari`, lo stesso modulo da cui
 *    `emettiFatturaPagamento` li prende); l'IVA cerca in `aruba_config.iva[]` con lo
 *    stesso confronto per inclusione e passa da `verificaCoerenzaIva`, e da lì
 *    discendono aliquota, imponibile scorporato e bollo. Andare dritti a
 *    `alunni.intestatario_fatture` e all'esente di fabbrica sarebbe stato più
 *    corto e avrebbe collaudato **un altro documento**: con genitori separati
 *    l'emissione manda N fatture a importi ripartiti, e un collaudo che ne
 *    compone una sola resterebbe verde su ciò che non partirà mai.
 *  · **Non scrive sul database.** Solo `SELECT`. La RPC `prossimo_numero_fattura_sezionale`
 *    — che SCRIVE il contatore — non viene chiamata: un collaudo non consuma
 *    progressivi. Nemmeno i guasti scrivono: perturbano copie in memoria.
 *  · **Non scrive dati personali nel repository.** Il referto porta uuid, iniziali,
 *    nomi di tag e esiti. L'XML generato contiene invece l'anagrafica vera di un
 *    genitore e il codice fiscale di una minore: esce **fuori dal repository**, e
 *    se il percorso richiesto cadesse dentro l'albero di lavoro il file NON viene
 *    scritto affatto (vedi `fuoriDalRepository`).
 *
 * ─── COME SI ESEGUE ──────────────────────────────────────────────────────────
 * La `SUPABASE_SERVICE_ROLE_KEY` scritta in `.env.local` **non appartiene a questo
 * progetto** (risponde «Unregistered API key»): si passa davanti al comando,
 * prendendola dalla CLI già autenticata e senza mai stamparla.
 *
 *   KEY=$(supabase projects api-keys --project-ref uimulkjyekgemjakmepp --experimental -o json \
 *         | python3 -c "import json,sys;print([k['api_key'] for k in json.load(sys.stdin) if k['name']=='service_role'][0])")
 *   SUPABASE_SERVICE_ROLE_KEY="$KEY" COLLAUDO_REALE=1 PAGAMENTO_ID=<uuid> \
 *     REFERTO_COLLAUDO=/tmp/referto-singola.txt \
 *     npx vitest run --config vitest.collaudo.config.ts scripts/collaudo/fattura-singola.collaudo.ts
 *
 * ⚠️ **Il file va nominato nel comando.** Senza argomento l'`include` di
 * `vitest.collaudo.config.ts` raccoglie tutta la cartella, e lì dentro vive
 * `numerazione-aruba.collaudo.ts`, che ad Aruba ci parla.
 *
 * ─── E LA PROVA CHE QUESTE ASSERZIONI MORDONO ────────────────────────────────
 * *Un test mai visto fallire non è un test.* Perciò il guasto si può accendere a
 * comando, con `COLLAUDO_GUASTO` (vedi `GUASTI`): `bollo`, `importo`,
 * `cessionario`, `iva`, `quote`, `stato`, `ambiente`, `registro`, `abilitato`.
 * Ogni valore ammesso può soltanto far diventare il collaudo **rosso**, mai
 * verde — è una perturbazione del documento o di una sua premessa, non una
 * scorciatoia sulle verifiche, e tocca sempre una COPIA in memoria.
 *
 * I guasti coprono ogni verifica che dipende dai DATI o dalla CONFIGURAZIONE,
 * comprese le due che non guardano l'XML — «già a registro» e «Aruba abilitata».
 * Non è pignoleria: l'idempotenza è l'unica cosa che sta fra un secondo clic e
 * una seconda fattura allo SDI, e una verifica del genere non la si consegna
 * senza averla vista diventare rossa almeno una volta.
 *
 * Restano fuori, e va detto: la serie e le quattro costanti che scrive il
 * generatore (`IdTrasmittente`, `RegimeFiscale`, `CodiceDestinatario`,
 * `ModalitaPagamento`). Per vederle cadere bisogna perturbare `fatturapa-xml.ts`
 * o cambiare pagamento — cioè uscire da questo file, che non ne ha titolo.
 * L'importo in banca dati, invece, una leva ce l'ha: `TOTALE_ATTESO`.
 *
 * Un valore NON ammesso ferma il collaudo alla prima riga, con l'elenco di quelli
 * buoni. Prima lo accettava in silenzio: `COLLAUDO_GUASTO=xyz` stampava
 * «⚠️ GUASTO SIMULATO ACCESO … il rosso qui sotto è VOLUTO» sopra un referto
 * tutto verde, cioè annunciava un rosso che non c'era — l'esatto contrario del
 * motivo per cui questo meccanismo esiste.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '@supabase/supabase-js'

import { buildFatturaElettronicaXml, verificaCoerenzaIva, type IvaFattura } from '@/lib/aruba/fatturapa-xml'
import { mapStatoAruba } from '@/lib/aruba/stato'
import { cedenteDaConfig, type FiscalAruba } from '@/lib/fatturazione/cedente'
import { validaCessionario, cessionarioCompleto } from '@/lib/fatturazione/cessionario'
import {
    annoScolasticoDiCompetenza,
    formattaNumeroFattura,
    sezionalePerMinore,
    type Sezionale,
} from '@/lib/fatturazione/sezionale'
import { causaleFattura } from '@/lib/pagamenti/causale-fattura'
// Lo STESSO modulo che usa `emettiFatturaPagamento` per decidere a chi e per quanto
// si fattura. Non tira dentro Aruba: `intestatari.ts` importa solo
// `@/lib/anagrafiche/legami`, che a sua volta importa solo il logger.
import { determinaQuoteFatturazione, resolveParentRegistry } from '@/lib/pagamenti/intestatari'
import { bolloDovuto, type FiscaleConfig } from '@/lib/pagamenti/fiscale'
import { meseAnnoDaPeriodo } from '@/lib/pagamenti/periodo'
import { annoFiscale, oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { formatEuro } from '@/lib/format/valuta'
import { isoToIt } from '@/lib/format/data'
import { validaFatturaPA } from '../../__tests__/lib/aruba/valida-xsd'

const ATTIVO = process.env.COLLAUDO_REALE === '1'
/** Il pagamento da collaudare. Solo dall'ambiente: è una scelta del momento, non una configurazione. */
const PAGAMENTO_ID = (process.env.PAGAMENTO_ID ?? '').trim()

/**
 * Il totale che il documento **deve** portare, INCHIODATO e non ricavato dalla riga.
 *
 * ─── PERCHÉ NON SI LEGGE DA `pagamenti.importo` ──────────────────────────────
 * Sarebbe la cosa comoda, e sarebbe una verifica **circolare**: se qualcuno
 * cambiasse l'importo della riga — o se lo sconto «SCONTO FRATELLI», azzerato a
 * mano il 2026-09-03, tornasse a 30 — il collaudo comporrebbe il documento con il
 * nuovo importo, si aspetterebbe il nuovo importo, e resterebbe **verde** su una
 * fattura diversa da quella decisa. Un'asserzione che si adegua a ciò che misura
 * non asserisce niente.
 *
 * Il valore è la decisione del titolare (300 € a sconto azzerato). Per un altro
 * pagamento si passa `TOTALE_ATTESO` accanto a `PAGAMENTO_ID`: si è costretti a
 * DICHIARARE quanto ci si aspetta, che è esattamente il punto.
 *
 * ─── PERCHÉ VIENE NORMALIZZATO, INVECE DI ESSERE CONFRONTATO COM'È ───────────
 * Il valore lo digita una persona, davanti a un comando, una volta sola. `300` e
 * `300,00` sono modi corretti di scrivere trecento euro, e confrontati alla
 * lettera con il `300.00` del tracciato rendevano rosse DUE verifiche sugli
 * importi con «atteso 300, ottenuto 300.00»: un rosso da formato, indistinguibile
 * a colpo d'occhio da un rosso vero, proprio nel referto che si legge un minuto
 * prima di emettere. Una scrittura che non è un numero, invece, non si
 * normalizza: si ferma il collaudo dicendo cosa è arrivato.
 */
function totaleAttesoDichiarato(): string {
    const raw = (process.env.TOTALE_ATTESO ?? '').trim()
    if (!raw) return '300.00'
    const n = Number(raw.replace(',', '.'))
    if (!Number.isFinite(n)) throw new Error(`TOTALE_ATTESO non è un numero: «${raw}»`)
    return n.toFixed(2)
}
const TOTALE_ATTESO = totaleAttesoDichiarato()

/**
 * I guasti che si possono accendere per **vedere il rosso**. Ognuno perturba il
 * documento (o una sua premessa) in un punto solo, e ognuno può soltanto far
 * fallire delle asserzioni: non ne esiste uno che ne faccia passare una che
 * altrimenti fallirebbe. Ognuno tocca una COPIA in memoria: il database non viene
 * mai scritto, nemmeno con la perturbazione accesa.
 */
const GUASTI = {
    /** Accende `bollo_enabled`: compare `<DatiBollo>`, che su questa fattura NON deve esserci. */
    bollo: 'bollo',
    /** Aggiunge un euro all'importo: `<ImportoTotaleDocumento>` non è più quello atteso. */
    importo: 'importo',
    /** Svuota il CAP dell'intestatario: cade `cessionarioCompleto` e cade lo XSD (`pattern` su `CAP`). */
    cessionario: 'cessionario',
    /**
     * Inventa una riga `aruba_config.iva[]` che combacia con la causale, al 22%:
     * il documento esce con aliquota 22 e SENZA `<Natura>` né
     * `<RiferimentoNormativo>` — cioè cadono le due verifiche che, sulla
     * configurazione vera (nessuna riga `iva`), passano per il default del
     * generatore. È la prova che quelle due non stanno guardando una costante.
     */
    iva: 'iva',
    /** Aggiunge una seconda quota fittizia: cade «quota unica», il resto no. */
    quote: 'quote',
    /** Riporta il pagamento a `in_attesa`: cade «pagamento saldato». */
    stato: 'stato',
    /** Sposta la sede su `demo`: cade «ambiente Aruba». */
    ambiente: 'ambiente',
    /**
     * Aggiunge alla COPIA in memoria del registro una riga con `sdi_stato` NULL
     * (trasporto fallito, che per l'idempotenza conta come presente): cade
     * «nessuna fattura già a registro». `fatture_emesse` non viene toccata.
     */
    registro: 'registro',
    /** Spegne `aruba_config.abilitato` sulla copia in memoria: cade «Aruba abilitata sulla sede». */
    abilitato: 'abilitato',
} as const
const GUASTI_AMMESSI = Object.values(GUASTI) as string[]
const GUASTO = (process.env.COLLAUDO_GUASTO ?? '').trim()

/**
 * Legge una credenziale: prima l'ambiente, poi `.env.local`. Non la stampa mai.
 * Stesso aiutante (e stesse ragioni) di `fattura-reale.collaudo.ts`: l'ambiente
 * VINCE, perché la chiave scritta nel file non è di questo progetto.
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

const s = (v: unknown): string => (v == null ? '' : String(v))

/**
 * Il messaggio di errore dello XSD, ripulito dal VALORE del campo.
 *
 * libxml lo cita testualmente: «Element 'CAP': [facet 'pattern'] The value '' is
 * not accepted by the pattern '[0-9][0-9][0-9][0-9][0-9]'». Su `CAP` non c'è
 * nulla da nascondere, ma le stesse righe le producono `CodiceFiscale`, `Nome`,
 * `Cognome` e `Indirizzo`, e lì il valore citato è un **dato personale** — di un
 * genitore o di una minore — dentro un referto che si legge, si incolla in una
 * chat e si conserva. (Non è un'ipotesi di scuola: `CodiceFiscaleType` è
 * `[A-Z0-9]{11,16}` e il generatore non porta il codice in maiuscolo, quindi un
 * `parents.fiscal_code` scritto minuscolo finisce esattamente in questa riga.)
 *
 * Si toglie il valore e si tiene tutto il resto — nome dell'elemento, facet
 * violata, pattern atteso — che è ciò che serve davvero a chi legge. La
 * mascheratura viene PRIMA del taglio a 160: tagliare per primo poteva lasciare
 * un valore lungo mezzo visibile, con l'apice di chiusura oltre il taglio.
 */
function senzaValori(msg?: string): string {
    return (msg ?? '?')
        // Greedy fino all'ULTIMO apice della riga: un valore con un apostrofo dentro
        // (Sant'Anna, dell'Orto) con `[^']*` restava mascherato solo a metà, e la coda
        // trapelava nel referto. Si perde anche il pattern citato dopo: accettabile.
        .replace(/The value '.*'/g, "The value '[omesso]'")
        .replace(/'.*' is not a valid value/g, "'[omesso]' is not a valid value")
        .slice(0, 160)
}

/**
 * `YYYY-MM-DD` → mezzanotte LOCALE di quel giorno. Copia di `giornoDaIsoFiscale`
 * (`src/lib/aruba/emissione.ts`), che lì è privata: `new Date(iso)` la
 * leggerebbe come mezzanotte UTC e a ovest di Greenwich diventerebbe il giorno
 * prima — e qui il mese decide l'anno scolastico, cioè la SERIE.
 */
function giornoDaIsoFiscale(iso: string): Date {
    const [anno, mese, giorno] = iso.split('-').map(Number)
    return new Date(anno, mese - 1, giorno)
}

/**
 * Copia di `progressivoInvioFattura` (`src/lib/aruba/emissione.ts`).
 *
 * È duplicata invece che importata perché importarla vorrebbe dire importare
 * `emissione.ts`, che si porta dietro `@/lib/aruba/client`: questo file deve
 * restare **incapace** di parlare con Aruba, e la prova è che nel suo elenco di
 * import quel modulo non compare. La duplicazione non può falsare nessuna delle
 * verifiche qui sotto: `<ProgressivoInvio>` è un SEGNAPOSTO (il numero è `1`) e
 * nessuna asserzione lo guarda — serve solo a comporre un documento che lo XSD
 * accetti (`String10Type`).
 */
function progressivoInvioSegnaposto(sezionale: Sezionale, numero: number, anno: number): string {
    const lettera = sezionale === 'FPR' ? 'F' : 'A'
    return `${lettera}${String(anno % 100).padStart(2, '0')}${String(numero).padStart(6, '0')}`
}

/**
 * La radice dell'albero di lavoro: serve a tenere l'XML con i dati veri FUORI dal
 * repository. Il confronto è sul CONFINE di cartella (`RADICE_REPO + sep`), non su
 * un prefisso di stringa: senza il separatore un albero fratello — `<repo>-altro/…`,
 * che qui è la norma, visto che si lavora in un worktree accanto — sarebbe stato
 * scambiato per «dentro il repository» e il file non sarebbe stato scritto.
 */
const RADICE_REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const fuoriDalRepository = (percorso: string): boolean => {
    const r = resolve(percorso)
    return r !== RADICE_REPO && !r.startsWith(RADICE_REPO + sep)
}

interface Controllo {
    nome: string
    atteso: string
    ottenuto: string
    ok: boolean
}

describe.skipIf(!ATTIVO || !PAGAMENTO_ID)(
    'collaudo mirato: il documento di UN pagamento, generato e verificato senza inviarlo',
    () => {
        it('compone la fattura che partirebbe e ne verifica ogni elemento che conta', async () => {
            // ── 0. IL GUASTO CHIESTO ESISTE? Prima di tutto, prima ancora delle
            //    credenziali: un `COLLAUDO_GUASTO` con un refuso non perturba niente,
            //    e il referto annuncerebbe «il rosso qui sotto è VOLUTO» sopra un
            //    esito tutto verde — cioè mentirebbe proprio a chi sta controllando
            //    che le asserzioni mordano.
            expect(
                !GUASTO || GUASTI_AMMESSI.includes(GUASTO),
                `COLLAUDO_GUASTO «${GUASTO}» non riconosciuto: valori ammessi ${GUASTI_AMMESSI.join(', ')}`,
            ).toBe(true)

            const url = env('SUPABASE_URL') || env('NEXT_PUBLIC_SUPABASE_URL')
            const key = env('SUPABASE_SERVICE_ROLE_KEY')
            expect(url, 'SUPABASE_URL assente').toBeTruthy()
            expect(key, 'SUPABASE_SERVICE_ROLE_KEY assente').toBeTruthy()
            const db = createClient(url, key, { auth: { persistSession: false } })

            // ── 1. IL PAGAMENTO, con la stessa proiezione di `emettiFatturaPagamento`:
            //    categoria per lo slug, alunno per la serie E per le quote.
            const { data: pag, error: errPag } = await db
                .from('pagamenti')
                .select(
                    'id, descrizione, importo, stato, scadenza, periodo_competenza, scuola_id, fattura_causale, categoria_id, alunno_id, payment_categories:categoria_id ( slug ), alunni:alunno_id ( id, nome, cognome, codice_fiscale, data_nascita, genitori_separati, retta_split_config, intestatario_fatture )',
                )
                .eq('id', PAGAMENTO_ID)
                .single()
            // PostgREST NON LANCIA (AGENTS.md, regola 7): l'errore si controlla, non si aspetta.
            expect(errPag, `lettura pagamento: ${errPag?.message ?? ''}`).toBeNull()
            expect(pag, `pagamento ${PAGAMENTO_ID} non trovato`).toBeTruthy()
            // Copia in memoria: il guasto `stato` riporta il pagamento a «in_attesa»
            // qui e solo qui — la riga in banca dati non viene toccata.
            const p: Record<string, unknown> = {
                ...(pag as unknown as Record<string, unknown>),
                ...(GUASTO === GUASTI.stato ? { stato: 'in_attesa' } : {}),
            }
            const alunno = (Array.isArray(p.alunni) ? p.alunni[0] : p.alunni) as Record<string, unknown> | null
            expect(alunno, 'pagamento senza alunno collegato: non c\'è serie da decidere').toBeTruthy()

            // ── 2. LA CONFIGURAZIONE DELLA SEDE. Lettura diretta invece di
            //    `leggiModuleConfig`: quell'aiutante, quando la SELECT fallisce, scrive
            //    una riga in `app_log` — cioè una SCRITTURA, che un collaudo non deve
            //    fare. Qui l'errore si asserisce, che è più forte del loggarlo.
            const { data: settings, error: errSet } = await db
                .from('admin_settings')
                .select('scuola_id, fiscale_config, aruba_config, fattura_causali_config')
                .eq('scuola_id', s(p.scuola_id))
                .maybeSingle()
            expect(errSet, `lettura admin_settings: ${errSet?.message ?? ''}`).toBeNull()
            expect(settings, `nessuna riga admin_settings per la sede ${s(p.scuola_id)}`).toBeTruthy()
            const cfgSede = settings as unknown as Record<string, unknown>
            // Copia in memoria anche qui: il guasto `ambiente` sposta la sede su
            // `demo` senza toccare `admin_settings`.
            const arubaCfg: Record<string, unknown> = {
                ...((cfgSede.aruba_config ?? {}) as Record<string, unknown>),
                ...(GUASTO === GUASTI.ambiente ? { ambiente: 'demo' } : {}),
                ...(GUASTO === GUASTI.abilitato ? { abilitato: false } : {}),
            }

            // Tutti i guasti toccano copie in memoria: il database non viene mai
            // scritto, nemmeno con la perturbazione accesa.
            const fiscaleCfg = {
                ...((cfgSede.fiscale_config ?? {}) as FiscaleConfig),
                ...(GUASTO === GUASTI.bollo ? { bollo_enabled: true } : {}),
            } as FiscaleConfig

            // ── 3. IL CEDENTE, dalla fonte unica + ripiego, con lo stesso
            //    `cedenteDaConfig` che chiama `emettiFatturaPagamento`.
            const esitoCedente = cedenteDaConfig(fiscaleCfg, arubaCfg.fiscal as FiscalAruba | undefined)
            expect(
                esitoCedente.ok,
                `cedente non emettibile: ${esitoCedente.ok ? '' : esitoCedente.messaggio}`,
            ).toBe(true)
            if (!esitoCedente.ok) return
            const cedente = esitoCedente.cedente

            // ── 4. LA SERIE FISCALE, dall'anno scolastico DI COMPETENZA (non da oggi).
            const dataDocumento = oggiFiscaleISO()
            const anno = annoFiscale()
            const competenza = annoScolasticoDiCompetenza(
                p.periodo_competenza as string | null,
                giornoDaIsoFiscale(dataDocumento),
            )
            const esitoSezionale = sezionalePerMinore({
                codiceFiscale: alunno?.codice_fiscale as string | null,
                dataNascita: alunno?.data_nascita as string | null,
                annoScolastico: competenza.anno,
                annoScolasticoAmbiguo: competenza.ambiguo,
            })
            const sezionale: Sezionale = esitoSezionale.sezionale

            // ── 5. LA CAUSALE: manuale → modello di categoria → «Predefinito» → fabbrica.
            const categoria = (Array.isArray(p.payment_categories) ? p.payment_categories[0] : p.payment_categories) as
                | { slug?: string | null }
                | null
            const { mese, anno: annoCompetenza } = meseAnnoDaPeriodo(p.periodo_competenza as string | null)
            // PostgREST non lancia, di nuovo: senza questo controllo una lettura
            // rifiutata diventava «sede senza nome», e il modello di causale che
            // nomina la sede sarebbe uscito monco senza che nessuno lo dicesse.
            const { data: sede, error: errSede } = await db
                .from('scuole')
                .select('nome')
                .eq('id', s(p.scuola_id))
                .maybeSingle()
            expect(errSede, `lettura scuole: ${errSede?.message ?? ''}`).toBeNull()
            const causale =
                causaleFattura({
                    config: (cfgSede.fattura_causali_config ?? {}) as never,
                    slugCategoria: categoria?.slug,
                    causaleManuale: p.fattura_causale as string | null,
                    dati: {
                        descrizione: p.descrizione as string | null,
                        nome: alunno?.nome as string | undefined,
                        cognome: alunno?.cognome as string | undefined,
                        codiceFiscale: alunno?.codice_fiscale as string | null,
                        sede: s((sede as { nome?: string | null } | null)?.nome),
                        mese,
                        anno: annoCompetenza,
                        importo: formatEuro(p.importo as number),
                        scadenza: isoToIt(s(p.scadenza)),
                    },
                }) || s(p.descrizione)

            // ── 6. LE QUOTE, cioè A CHI e PER QUANTO. Dal modulo dell'emissione, non
            //    da una lettura scritta qui.
            //
            // `emettiFatturaPagamento` non guarda `alunni.intestatario_fatture`: passa
            // da `determinaQuoteFatturazione`, che considera in ordine l'ordine divise,
            // i genitori separati (`pagamenti_quote` → `retta_split_config` → 50/50 sui
            // tutori), l'eccezione per-figlio e infine `parents.intestatario_default`.
            // Con più di una quota emette **N documenti**, con importi ripartiti e la
            // causale suffissata. Un collaudo che leggesse `intestatario_fatture` e
            // componesse un solo documento a `pagamenti.importo` darebbe lo stesso
            // verde su un pagamento con genitori separati — verde su una fattura che
            // non partirà mai. È la trappola del «mock piatto» già pagata in questo
            // repository, e si evita in un modo solo: chiamando la stessa funzione.
            const quote = await determinaQuoteFatturazione(
                db,
                { id: s(p.id), importo: Number(p.importo) },
                {
                    id: s(alunno?.id) || s(p.alunno_id),
                    genitori_separati: alunno?.genitori_separati as boolean | null,
                    retta_split_config: alunno?.retta_split_config as never,
                    intestatario_fatture: alunno?.intestatario_fatture as never,
                },
            )
            expect(
                quote.length,
                'nessun intestatario risolvibile: `intestatario_fatture` e `intestatario_default` assenti',
            ).toBeGreaterThan(0)
            // Il guasto `quote` aggiunge una seconda quota fittizia DOPO la chiamata:
            // perturba solo il conteggio, non chi paga né quanto.
            if (GUASTO === GUASTI.quote) quote.push({ ...quote[0], adultId: 'guasto' })

            // L'intestatario della PRIMA quota, con lo stesso `resolveParentRegistry`
            // dell'emissione: prima `parents.id`, poi il ponte `parents.auth_user_id`.
            const adultId = quote[0]?.adultId ?? ''
            const regBase = await resolveParentRegistry(db, adultId)
            // `resolveParentRegistry` non distingue «non c'è» da «non me l'hanno fatto
            // leggere»: entrambi tornano `null`. Prima di dire «intestatario
            // inesistente» — una diagnosi che manderebbe la Segreteria a compilare
            // un'anagrafica che magari è già completa — si richiede la stessa riga in
            // chiaro e si guarda l'errore. In un collaudo la diagnosi È il prodotto.
            let motivoReg = ''
            if (!regBase) {
                const { error: errReg } = await db.from('parents').select('id').eq('id', adultId).maybeSingle()
                motivoReg = errReg
                    ? `la lettura di parents è FALLITA: ${errReg.message}`
                    : 'nessuna riga in parents con quell\'id, né come parents.id né via auth_user_id'
            }
            expect(regBase, `intestatario ${adultId} non risolvibile — ${motivoReg}`).toBeTruthy()

            // Provincia e numero civico stanno FUORI da `resolveParentRegistry`: nel
            // motore li prende `leggiResidenzaEstesa` con una seconda lettura, ed è
            // quella che si rispecchia qui. Sono facoltativi per il tracciato, ma la
            // lettura può fallire (sul DB E2E non migrato è un `42703`) e allora il
            // documento uscirebbe senza, in silenzio.
            const estesa = await db
                .from('parents')
                .select('residence_province, residence_street_number')
                .eq('id', s(regBase?.id))
                .maybeSingle()
            expect(estesa.error, `lettura residenza estesa: ${estesa.error?.message ?? ''}`).toBeNull()
            const residenza = (estesa.data ?? {}) as {
                residence_province?: string | null
                residence_street_number?: string | null
            }
            const reg = regBase
                ? ({
                      ...regBase,
                      residence_province: residenza.residence_province ?? null,
                      residence_street_number: residenza.residence_street_number ?? null,
                  } as Record<string, unknown>)
                : null

            const cap = GUASTO === GUASTI.cessionario ? '' : s(reg?.zip_code)
            const cess = {
                codice_fiscale: s(reg?.fiscal_code),
                nome: s(reg?.first_name),
                cognome: s(reg?.last_name),
                indirizzo: s(reg?.residence_address),
                cap,
                comune: s(reg?.residence_city),
            }

            // ── 7. L'IVA, POI IL BOLLO. In quest'ordine, perché è l'IVA a decidere se
            //    il bollo esista: `bolloDovuto` si chiama solo sulle esenti.
            //
            // L'emissione cerca in `aruba_config.iva[]` la prima riga la cui `causale`
            // sia CONTENUTA nella causale composta (confronto per inclusione,
            // maiuscole ignorate); nessun riscontro → il default del generatore, cioè
            // 0% / N4 / «Esente Art. 10 DPR 633/72». Leggere quella configurazione è
            // il punto: tre delle verifiche qui sotto (natura, riferimento normativo,
            // bollo) sono valutate su un documento che senza questo blocco ignorerebbe
            // proprio l'input che in produzione le decide — e resterebbero verdi
            // mentre la fattura vera esce al 22% e senza `<Natura>`.
            const importoDocumento = quote[0].importo + (GUASTO === GUASTI.importo ? 1 : 0)
            const righeIvaConfigurate = (Array.isArray(arubaCfg.iva) ? arubaCfg.iva : []) as {
                causale?: string | null
                aliquota?: number | string
                natura?: string | null
                riferimento_normativo?: string | null
            }[]
            // La riga del guasto porta la causale INTERA, non i suoi primi caratteri:
            // il confronto è per inclusione, e una stringa è sempre contenuta in sé
            // stessa. Con `causale.slice(0, 3)` una causale più corta di tre caratteri
            // (o vuota) non avrebbe combaciato, il guasto non avrebbe perturbato
            // niente e il collaudo sarebbe rimasto VERDE con la perturbazione accesa
            // — l'esatto contrario della promessa scritta in testa a questo file.
            // La riga iniettata va IN TESTA, non in coda: `find` prende la prima che
            // combacia, e su una sede con già una riga esente per questa causale il
            // guasto accodato sarebbe stato inerte — collaudo verde sotto il banner
            // «il rosso qui sotto è VOLUTO», cioè il falso rosso annunciato.
            const righeIva =
                GUASTO === GUASTI.iva
                    ? [{ causale, aliquota: 22 }, ...righeIvaConfigurate]
                    : righeIvaConfigurate
            const ivaEntry = righeIva.find(
                (v) => v.causale && causale.toLowerCase().includes(String(v.causale).toLowerCase()),
            )
            // E la cintura, perché «sempre contenuta in sé stessa» non vale per la
            // stringa vuota (`v.causale &&` la scarta) e perché una mancata
            // corrispondenza, senza questa riga, si presenterebbe come un verde.
            if (GUASTO === GUASTI.iva) {
                expect(ivaEntry, 'guasto iva: la riga iniettata non combacia con la causale').toBeTruthy()
                expect(Number(ivaEntry?.aliquota), 'guasto iva: `find` ha preso una riga configurata, non quella iniettata').toBe(22)
            }
            const ivaFattura: IvaFattura | undefined = ivaEntry
                ? {
                      aliquota: Number(ivaEntry.aliquota),
                      natura: ivaEntry.natura || undefined,
                      riferimentoNormativo: ivaEntry.riferimento_normativo || undefined,
                  }
                : undefined
            // LANCIA, e va bene così: `aliquota 0` senza natura e `aliquota > 0` con
            // natura sono due scarti SDI (00401 / 00400) che lo XSD non vede. Il rosso
            // porta il messaggio del generatore, che nomina lo scarto evitato — più
            // utile di un «ok/non ok» scritto qui.
            if (ivaFattura) verificaCoerenzaIva(ivaFattura)
            const aliquota = ivaFattura ? ivaFattura.aliquota : 0
            const esente = aliquota === 0

            // Il bollo, e SOLO da qui. La decisione del titolare è «bollo spento», e in
            // banca dati si legge come `bollo_enabled` assente: il valore non si scrive
            // a mano nel collaudo, si CHIEDE alla stessa funzione che risponde
            // all'emissione — altrimenti si collauderebbe la propria opinione.
            const bolloImporto = esente ? bolloDovuto(importoDocumento, fiscaleCfg) : 0
            // `importoDocumento` è il LORDO incassato: con IVA > 0 va scorporato
            // l'imponibile, così `ImportoTotaleDocumento` (imponibile + imposta) torna
            // pari all'incassato.
            const imponibile =
                aliquota > 0 ? Math.round((importoDocumento / (1 + aliquota / 100)) * 100) / 100 : importoDocumento

            // ── 8. IL DOCUMENTO. Numero SEGNAPOSTO: la RPC che assegna quello vero
            //    SCRIVE il contatore, e un collaudo non consuma progressivi.
            const numeroFattura = formattaNumeroFattura(sezionale, 1, anno)
            const xml = buildFatturaElettronicaXml({
                progressivoInvio: progressivoInvioSegnaposto(sezionale, 1, anno),
                numero: numeroFattura,
                data: dataDocumento,
                cedente,
                cessionario: {
                    codiceFiscale: cess.codice_fiscale,
                    nome: cess.nome,
                    cognome: cess.cognome,
                    sede: {
                        indirizzo: cess.indirizzo,
                        numeroCivico: s(reg?.residence_street_number).trim() || undefined,
                        cap: cess.cap,
                        comune: cess.comune,
                        provincia: s(reg?.residence_province).trim() || undefined,
                        nazione: 'IT',
                    },
                },
                righe: [{ descrizione: causale, prezzoUnitario: imponibile }],
                iva: ivaFattura,
                bollo: bolloImporto > 0 ? { importo: bolloImporto } : undefined,
                pagamento: { dataScadenza: s(p.scadenza).slice(0, 10) || dataDocumento },
            })

            const esitoXsd = await validaFatturaPA(xml)
            const importoInBanca = Number(p.importo).toFixed(2)

            // ── 8-bis. I TRE MOTIVI PER CUI «RIPROVA» NON EMETTEREBBE NIENTE ─────────
            // Un documento perfetto non serve a nulla se il pulsante non parte. Il
            // motore si ferma prima, e in silenzio, per tre ragioni che non stanno
            // nell'XML: il pagamento non saldato (400 `non_saldato`), una riga già a
            // registro per questo pagamento (la quota esce `idempotente` e non parte
            // nulla), la sede non abilitata. Erano stampate come osservazioni: qui
            // sotto diventano asserzioni, perché un verde ambiguo prima di un atto
            // irreversibile è peggio di nessun collaudo.
            //
            // «Già a registro» NON è «già scartata»: una riga di trasporto fallito ha
            // `sdi_stato` NULL, e per l'idempotenza conta come presente. Solo uno
            // scarto vero (`isScarto`) libera la strada a una nuova emissione.
            //
            // ⚠️ QUI SI È PIÙ SEVERI DEL MOTORE, DI PROPOSITO. `emettiFatturaPagamento`
            // (`src/lib/aruba/emissione.ts`, cerca «idempotenza: esiste già una riga
            // non-scartata per questa quota») blocca solo le righe non scartate con
            // `quota_adult_id` uguale alla quota in corso — o NULL, quando la quota è
            // unica; questo collaudo conta bloccante OGNI riga non scartata del
            // pagamento, compresa quella di un altro intestatario. È voluto: un
            // pre-volo preferisce un rosso da spiegare a un verde da rimpiangere.
            // Va detto perché altrove questo file promette di non ricalcolare a modo
            // proprio ciò che l'emissione decide con un modulo: dove diverge, lo dice.
            const registro = await db
                .from('fatture_emesse')
                .select('id, sdi_stato, quota_adult_id')
                .eq('pagamento_id', PAGAMENTO_ID)
            expect(registro.error, `lettura fatture_emesse: ${registro.error?.message ?? ''}`).toBeNull()
            const righeRegistro = (registro.data ?? []) as { sdi_stato: number | null }[]
            // Il guasto `registro` aggiunge due righe alla COPIA in memoria appena
            // letta — `fatture_emesse` resta vuota, nessuna scrittura. Sono due e non
            // una apposta: `sdi_stato: 4` è uno scarto vero e NON conta (la strada
            // resterebbe libera), `sdi_stato: null` è un trasporto fallito e conta.
            // Il referto del guasto legge così «2 righe, di cui 1 bloccanti», che è
            // la distinzione scartata/trasporto resa visibile invece che spiegata.
            if (GUASTO === GUASTI.registro) righeRegistro.push({ sdi_stato: 4 }, { sdi_stato: null })
            const bloccanti = righeRegistro.filter(
                (r) => !(r.sdi_stato != null && mapStatoAruba(r.sdi_stato).isScarto),
            ).length

            // ── 9. LE VERIFICHE, tutte valutate PRIMA di asserire: così il referto le
            //    elenca per intero anche quando la prima è rossa — che è il momento in
            //    cui serve leggerlo.
            const contiene = (frammento: string) => xml.includes(frammento)
            const controlli: Controllo[] = [
                {
                    nome: 'XSD FatturaPA 1.2.3',
                    atteso: 'valido',
                    ottenuto: esitoXsd.valido ? 'valido' : `NON valido — ${senzaValori(esitoXsd.errori[0])}`,
                    ok: esitoXsd.valido,
                },
                {
                    nome: 'serie fiscale (sezionale)',
                    atteso: 'FPR',
                    ottenuto: sezionale,
                    ok: sezionale === 'FPR',
                },
                {
                    nome: 'natura IVA',
                    atteso: '<Natura>N4</Natura>',
                    ottenuto: contiene('<Natura>N4</Natura>') ? 'presente' : 'ASSENTE',
                    ok: contiene('<Natura>N4</Natura>'),
                },
                {
                    nome: 'riferimento normativo',
                    atteso: '<RiferimentoNormativo>Esente Art. 10 DPR 633/72</RiferimentoNormativo>',
                    ottenuto: contiene('<RiferimentoNormativo>Esente Art. 10 DPR 633/72</RiferimentoNormativo>')
                        ? 'presente, lettera per lettera'
                        : 'ASSENTE o diverso',
                    ok: contiene('<RiferimentoNormativo>Esente Art. 10 DPR 633/72</RiferimentoNormativo>'),
                },
                {
                    nome: 'bollo virtuale',
                    atteso: 'NESSUN <DatiBollo> (decisione: bollo spento)',
                    ottenuto: contiene('<DatiBollo>') ? `<DatiBollo> PRESENTE (${bolloImporto} EUR)` : 'assente',
                    ok: !contiene('<DatiBollo>'),
                },
                {
                    nome: 'totale del documento',
                    atteso: `<ImportoTotaleDocumento>${TOTALE_ATTESO}</ImportoTotaleDocumento>`,
                    ottenuto:
                        xml.match(/<ImportoTotaleDocumento>([^<]*)<\/ImportoTotaleDocumento>/)?.[1] ?? 'elemento assente',
                    ok: contiene(`<ImportoTotaleDocumento>${TOTALE_ATTESO}</ImportoTotaleDocumento>`),
                },
                {
                    // La metà non circolare della verifica qui sopra: il documento porta
                    // il totale atteso *e* la riga in banca dati vale ancora quella cifra.
                    // Se lo sconto tornasse, questa riga diventa rossa PRIMA che qualcuno
                    // prema «Riprova» — è tutto ciò per cui questo collaudo esiste.
                    nome: 'importo della riga in banca dati',
                    atteso: `pagamenti.importo = ${TOTALE_ATTESO} (sconto azzerato)`,
                    ottenuto: importoInBanca,
                    ok: importoInBanca === TOTALE_ATTESO,
                },
                {
                    nome: 'IdTrasmittente (Aruba PEC)',
                    atteso: '<IdTrasmittente> con <IdCodice>01879020517</IdCodice>',
                    ottenuto: /<IdTrasmittente>\s*<IdPaese>IT<\/IdPaese>\s*<IdCodice>01879020517<\/IdCodice>/.test(xml)
                        ? 'IT 01879020517'
                        : 'DIVERSO o assente',
                    ok: /<IdTrasmittente>\s*<IdPaese>IT<\/IdPaese>\s*<IdCodice>01879020517<\/IdCodice>/.test(xml),
                },
                {
                    nome: 'regime fiscale del cedente',
                    atteso: '<RegimeFiscale>RF01</RegimeFiscale>',
                    ottenuto: xml.match(/<RegimeFiscale>([^<]*)<\/RegimeFiscale>/)?.[1] ?? 'elemento assente',
                    ok: contiene('<RegimeFiscale>RF01</RegimeFiscale>'),
                },
                {
                    nome: 'codice destinatario',
                    atteso: '<CodiceDestinatario>0000000</CodiceDestinatario>',
                    ottenuto: xml.match(/<CodiceDestinatario>([^<]*)<\/CodiceDestinatario>/)?.[1] ?? 'elemento assente',
                    ok: contiene('<CodiceDestinatario>0000000</CodiceDestinatario>'),
                },
                {
                    nome: 'modalità di pagamento',
                    atteso: '<ModalitaPagamento>MP05</ModalitaPagamento>',
                    ottenuto: xml.match(/<ModalitaPagamento>([^<]*)<\/ModalitaPagamento>/)?.[1] ?? 'elemento assente',
                    ok: contiene('<ModalitaPagamento>MP05</ModalitaPagamento>'),
                },
                {
                    nome: 'intestatario completo',
                    atteso: 'nessun campo mancante o malformato',
                    ottenuto: cessionarioCompleto(cess)
                        ? 'completo'
                        : `INCOMPLETO: ${Object.entries(validaCessionario(cess))
                              .map(([campo, motivo]) => `${campo}=${motivo}`)
                              .join(', ')}`,
                    ok: cessionarioCompleto(cess),
                },
                {
                    // Le etichette delle quote possono contenere il nome di un
                    // genitore: si conta, non si stampa.
                    nome: 'quota unica',
                    atteso: '1 quota (nessun ordine divise, nessuna pagamenti_quote, genitori non separati)',
                    ottenuto: `${quote.length} quote`,
                    ok: quote.length === 1,
                },
                {
                    nome: 'pagamento saldato',
                    atteso: "pagamenti.stato = 'pagato' (altrimenti «Riprova» risponde 400 non_saldato)",
                    ottenuto: s(p.stato) || 'assente',
                    ok: s(p.stato) === 'pagato',
                },
                {
                    nome: 'nessuna fattura già a registro (idempotenza)',
                    atteso: '0 righe fatture_emesse non-scartate per questo pagamento',
                    ottenuto: `${righeRegistro.length} righe, di cui ${bloccanti} bloccanti`,
                    ok: bloccanti === 0,
                },
                {
                    nome: 'Aruba abilitata sulla sede',
                    atteso: 'aruba_config.abilitato = true',
                    ottenuto: String(arubaCfg.abilitato),
                    ok: arubaCfg.abilitato === true,
                },
                {
                    // Un refuso qui non dà errore: `arubaBaseUrls` ricade su DEMO, e la
                    // fattura «emessa» non arriva mai allo SDI.
                    nome: 'ambiente Aruba',
                    atteso: 'production',
                    ottenuto: s(arubaCfg.ambiente) || 'assente',
                    ok: s(arubaCfg.ambiente) === 'production',
                },
            ]

            // ── 10. IL REFERTO, senza dati personali, scritto PRIMA delle asserzioni.
            //     Su file e non su console: vitest intercetta `console.log` e il referto
            //     sparirebbe proprio quando serve leggerlo.
            const passate = controlli.filter((c) => c.ok).length

            // ── CHE COSA DICE LA RIGA DEL DOCUMENTO, senza riportarne il testo ────
            // `<Descrizione>` è l'unico punto in cui la fattura identifica la minore,
            // ed è ciò su cui si aggancia la detrazione del genitore (vedi
            // `emissione.ts`, punto 4). Una causale scritta A MANO sul pagamento
            // **vince su qualunque modello** (`causaleFattura`, `causale-fattura.ts`): se è generica,
            // il modello della categoria — che aggiungerebbe nome e codice fiscale —
            // non viene mai applicato, e non c'è nessun errore a dirlo.
            // Qui non si asserisce niente (è una decisione di contenuto, non un
            // difetto): si MOSTRA, perché chi sta per premere «Riprova» lo veda.
            const dentro = (ago?: string | null) => {
                const a = s(ago).trim()
                return a.length > 1 && causale.toLowerCase().includes(a.toLowerCase())
            }
            const causaleManuale = s(p.fattura_causale).trim() !== ''
            const nominaLaMinore = dentro(alunno?.nome as string) || dentro(alunno?.cognome as string)
            const portaIlCf = dentro(alunno?.codice_fiscale as string)

            // L'XML porta il codice fiscale di una minore e la residenza di un adulto:
            // non entra nel repository, che è PUBBLICO. Se il percorso richiesto cadesse
            // dentro l'albero di lavoro non si scrive affatto — `.gitignore` protegge dal
            // commit, non dallo sguardo di chi apre la cartella. E il rifiuto FINISCE NEL
            // REFERTO: una guardia che salta in silenzio lascia chi la incontra a cercare
            // un file che nessuno ha scritto, senza sapere che è stato deciso così.
            const doveXml = process.env.XML_COLLAUDO || `${tmpdir()}/kidville-fattura-${PAGAMENTO_ID.slice(0, 8)}.xml`
            const fuori = fuoriDalRepository(doveXml)
            let rigaDocumento = fuori
                ? `${doveXml} (contiene DATI PERSONALI VERI: non copiarlo nel repository)`
                : `NON SCRITTO: «${doveXml}» cade dentro l'albero di lavoro, e l'XML porta dati personali veri. Indica un percorso fuori dal repository con XML_COLLAUDO.`
            if (fuori) {
                try {
                    writeFileSync(doveXml, xml, 'utf8')
                } catch (errore) {
                    // Il REFERTO è il prodotto di questo collaudo, e fin qui una
                    // cartella inesistente in `XML_COLLAUDO` lo faceva sparire: la
                    // `ENOENT` saliva da qui e il test moriva tre righe prima che il
                    // referto venisse scritto — diciassette verifiche già calcolate,
                    // nessuna leggibile. L'errore non si inghiotte (AGENTS.md, regola
                    // 6): finisce nella riga «documento completo», che qui è il posto
                    // dove si registra. Il messaggio di Node porta il percorso e basta:
                    // nessun dato personale, nessun contenuto del documento.
                    rigaDocumento = `NON SCRITTO: ${errore instanceof Error ? errore.message : String(errore)}`
                }
            }

            const righe = [
                '',
                '════════ COLLAUDO MIRATO — un pagamento, nessun documento inviato ════════',
                `pagamento ................... ${PAGAMENTO_ID}`,
                `sede ........................ ${s(p.scuola_id)}`,
                `alunna ...................... ${s(alunno?.id)} (${iniz(alunno?.nome as string, alunno?.cognome as string)})`,
                `intestatario ................ ${s(reg?.id)} (${iniz(reg?.first_name as string, reg?.last_name as string)})`,
                '',
                `anno scolastico ............. ${competenza.anno} (fonte: ${competenza.fonte}${competenza.ambiguo ? ', AMBIGUO' : ''})`,
                `serie ....................... ${sezionale} (fonte data: ${esitoSezionale.fonte}${esitoSezionale.discordanza ? ', DISCORDANZA CF/anagrafica' : ''})`,
                `numero (SEGNAPOSTO) ......... ${numeroFattura}`,
                `data documento .............. ${dataDocumento}`,
                `causale ..................... ${causale.length} caratteri · fonte: ${causaleManuale ? 'MANUALE sul pagamento (vince sul modello di categoria)' : `modello della categoria «${s(categoria?.slug) || '—'}»`}`,
                `  → nomina la minore? ....... ${nominaLaMinore ? 'sì' : 'NO'} · porta il suo codice fiscale? ${portaIlCf ? 'sì' : 'NO'}`,
                `    (osservazione, non asserzione: <Descrizione> è l'unico punto in cui il documento identifica la bambina)`,
                `quote ....................... ${quote.length} · genitori_separati=${String(Boolean(alunno?.genitori_separati))}`,
                `totale ATTESO (dichiarato) .. ${TOTALE_ATTESO} EUR · in banca dati: ${importoInBanca} EUR`,
                `righe IVA configurate ....... ${righeIva.length} · corrispondenza con la causale: ${ivaEntry ? `sì (aliquota ${aliquota})` : 'no → default del generatore: 0% / N4 / art. 10'}`,
                `bollo dovuto ................ ${bolloImporto.toFixed(2)} EUR`,
                '',
                `configurazione Aruba ........ abilitato=${String(arubaCfg.abilitato)} · ambiente=${s(arubaCfg.ambiente)}`,
                GUASTO ? `⚠️ GUASTO SIMULATO ACCESO ... «${GUASTO}»: il rosso qui sotto è VOLUTO` : 'guasto simulato ............. nessuno',
                '',
                `esito ....................... ${passate}/${controlli.length} verifiche passate`,
                '',
                ...controlli.map(
                    (c) => `  ${c.ok ? '✓' : '✗'} ${c.nome}\n      atteso ..: ${c.atteso}\n      ottenuto : ${c.ottenuto}`,
                ),
                '',
                `documento completo ......... ${rigaDocumento}`,
                '',
                'Struttura del documento (solo i tag, senza i valori):',
                `  ${[...new Set([...xml.matchAll(/<([A-Za-z]+)>/g)].map((m) => m[1]))].join(' · ')}`,
                '═'.repeat(74),
                '',
            ]
            const dove = process.env.REFERTO_COLLAUDO || new URL('./referto.txt.singola', import.meta.url).pathname
            writeFileSync(dove, righe.join('\n'), 'utf8')

            // ── 11. LE ASSERZIONI. Una per verifica, ognuna con il proprio messaggio.
            for (const c of controlli) {
                expect(c.ok, `${c.nome} — atteso «${c.atteso}», ottenuto «${c.ottenuto}»`).toBe(true)
            }
            expect(passate, 'alcune verifiche del documento non sono passate').toBe(controlli.length)
        }, 120_000)
    },
)
