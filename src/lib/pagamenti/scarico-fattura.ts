'use client';

import { useCallback, useEffect, useState } from 'react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { isNativeApp } from '@/lib/push/native-register';
import { scarica, type RisultatoScarico } from '@/lib/native/scarica';

/**
 * LE DUE PELLI DELLA FATTURA, UN MOTORE SOLO.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * IL DIFETTO CHE QUESTO MODULO VIENE A CHIUDERE
 *
 * Il link «Fattura» esisteva in DUE copie — la card del genitore
 * (`StoricoPagamenti`) e la riga della segreteria (`FatturaButton`) — e tutte e
 * due cominciavano con lo stesso ramo:
 *
 *     if (!fatture || fatture.length <= 1) return <a href={…}>Fattura</a>
 *
 * `fatture` è `null` FINCHÉ LA RISPOSTA NON ARRIVA. Quel ramo quindi non
 * distingueva «una sola fattura» da «non so ancora niente»: rendeva il pulsante
 * PRIMA di sapere se il PDF esistesse davvero. Chi lo premeva nel frattempo — o
 * chi lo premeva su un pagamento le cui fatture non hanno un PDF nel bucket —
 * arrivava a una route che non aveva niente da consegnare. Un pulsante al buio.
 *
 * ─── LA REGOLA NUOVA, TRE FASI ───────────────────────────────────────────────
 *  1. IN CARICAMENTO → non si rende NIENTE, e non si riserva spazio: niente
 *     scheletro, niente riquadro vuoto. L'unica transizione ammessa è
 *     «niente → pulsante», che è una COMPARSA e non un lampeggio.
 *  2. NESSUNA FATTURA CON `pdf_disponibile` VERO → non si rende NIENTE, stabile:
 *     nessun pulsante spento, nessun testo d'attesa. È una decisione esplicita
 *     del titolare, non una dimenticanza: un comando disabilitato su una card di
 *     pagamento fa chiamare la segreteria, il vuoto no.
 *  3. ALMENO UNA → si rendono le affordance, e SOLO per le righe che il server
 *     ha verificato sul bucket.
 *
 * Chi rende un'affordance in fase 1 o 2 sta riaprendo il difetto: le tre fasi
 * escono da `useFattureScaricabili`, non si ricostruiscono a mano.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * LO SCARICO, E PERCHÉ NON BASTA UN `<a download>`
 *
 * Sul WEB basta la route: `/api/pagamenti/fattura` è STESSA ORIGINE, quindi il
 * suo `Content-Disposition: attachment` (con `download=1`) scarica da solo, e
 * l'attributo `download` di un'ancora non serve nemmeno. Nella WEBVIEW Capacitor
 * no: `a.click()` non scarica e NON LANCIA, e `window.open(url, '_blank')` non
 * apre e ritorna `null` — è tutto misurato e scritto in `@/lib/native/scarica`,
 * che è il modulo che questo riusa invece di riscriverne una seconda copia.
 * Per lo stesso motivo qui NON si mette mai `target="_blank"`.
 */

/* ════════════════════════════════════════════════════════════════════════════
 * L'elenco: il contratto della route, e le tre fasi
 * ════════════════════════════════════════════════════════════════════════════ */

/** Una riga di `GET /api/pagamenti/fattura/list`. */
export interface FatturaScaricabile {
    id: string;
    /** Numero sezionale. Solo cifre: entra nel NOME del file. */
    numero: number | string;
    /** Anno del sezionale. Come sopra. */
    anno: number | string;
    /** L'etichetta della quota, quando il pagamento è fatturato a più intestatari. */
    quota_label: string | null;
    intestatario: string;
    /** VERIFICATO DAL SERVER SUL BUCKET: è la sola condizione che accende un comando. */
    pdf_disponibile: boolean;
    /**
     * Prosa composta dal server sullo stato SDI. Non si rende: il testo delle
     * schermate di famiglia è italiano per costruzione e viene dal catalogo
     * (T10-F1). Sta qui per dichiarare il contratto, non per finire a schermo.
     */
    sdi_stato_label?: string | null;
    /**
     * IL PERCHÉ DI UNO SCARTO, NELLE PAROLE DI ARUBA/SDI — e la sola voce di
     * questo contratto che si rende a schermo in UNA pelle sola.
     *
     * Si mostra alla SEGRETERIA, dove è l'unica informazione con cui si corregge e
     * si ritrasmette un documento fiscale. Non si mostra MAI al GENITORE: è prosa
     * tecnica del provider, e le schermate di famiglia prendono le loro frasi dal
     * catalogo i18n (T10-F1) — la stessa ragione per cui `sdi_stato_label` qui
     * sopra non si rende affatto.
     *
     * ⚠️ È OPZIONALE PERCHÉ IL SERVER LO OMETTE DAVVERO: `fattura/list` lo mette
     * nel corpo solo per i ruoli di contabilità (`RUOLI_MOTIVO_SCARTO`, in
     * `src/app/api/pagamenti/fattura/list/route.ts`). Sulla risposta che riceve
     * una famiglia la chiave non c'è proprio — e non è una difesa in più della UI:
     * è che una risposta HTTP si ispeziona, quindi ciò che viaggia è consegnato.
     */
    sdi_scarto_motivo?: string | null;
}

/**
 * UNA FATTURA RESPINTA, ridotta a ciò che serve per dirlo a schermo.
 *
 * Tipo suo e non `FatturaScaricabile` perché le due cose non coincidono, ed è
 * misurato: in produzione la riga a `sdi_stato = 2` (errore di upload) porta un
 * motivo e NON ha nessun PDF. Chiamare «scaricabile» una fattura che non esiste
 * come file sarebbe un nome che mente, e il giorno dopo qualcuno ci appenderebbe
 * un pulsante «Scarica».
 */
export interface ScartoFattura {
    /** Quale quota: serve come chiave di lista, non si mostra. */
    id: string;
    /** Il numero sezionale: è come la fattura si nomina al telefono col commercialista. */
    numero: number | string;
    /** La prosa del provider, già ripulita dagli spazi. Mai vuota: le vuote non entrano. */
    motivo: string;
}

export interface ElencoFatture {
    /** `true` finché la risposta non è arrivata. In questa fase non si rende NIENTE. */
    caricamento: boolean;
    /** SOLO le righe con `pdf_disponibile` vero. Vuoto = non si rende NIENTE. */
    scaricabili: FatturaScaricabile[];
    /**
     * Le quote che lo SDI ha respinto, col loro motivo.
     *
     * ⚠️ NON È UN SOTTOINSIEME DI `scaricabili`, e non deve diventarlo: la riga
     * misurata in produzione con l'errore di upload un PDF non ce l'ha, ed è
     * proprio quella su cui oggi la segreteria non vede niente. Legare il motivo
     * alla presenza del file lo nasconderebbe nel caso in cui serve di più.
     *
     * Per il GENITORE resta vuoto sempre, e non per una scelta di questo modulo:
     * il server non gli manda il campo da cui si ricava.
     */
    scarti: ScartoFattura[];
}

const IN_CARICAMENTO: ElencoFatture = { caricamento: true, scaricabili: [], scarti: [] };

/**
 * Le righe respinte, dal corpo della risposta.
 *
 * Un motivo fatto di soli spazi vale «nessun motivo»: un riquadro che annuncia una
 * spiegazione e poi non la dà è peggio di nessun riquadro — manda a cercare al
 * telefono qualcosa che a schermo non c'è.
 */
function scartiDa(righe: FatturaScaricabile[]): ScartoFattura[] {
    return righe.flatMap((f) => {
        const motivo = typeof f?.sdi_scarto_motivo === 'string' ? f.sdi_scarto_motivo.trim() : '';
        return motivo ? [{ id: f.id, numero: f.numero, motivo }] : [];
    });
}

interface StatoElenco extends ElencoFatture {
    /**
     * A QUALE pagamento si riferisce ciò che c'è in `scaricabili`.
     *
     * Non è una decorazione: senza, un cambio di `pagamentoId` sullo stesso
     * componente montato lascerebbe a schermo i comandi della fattura PRECEDENTE
     * finché la nuova risposta non arriva — cioè un link giusto sotto il
     * pagamento sbagliato. Si confronta a render invece di azzerare lo stato
     * dentro l'effetto, che è la forma che `react-hooks` (giustamente) segnala.
     */
    chiave: string;
}

function chiaveDi(pagamentoId: string, userId: string): string {
    return `${pagamentoId}|${userId}`;
}

/**
 * Le fatture di un pagamento che si possono davvero scaricare.
 *
 * Interroga `/api/pagamenti/fattura/list` e FILTRA su `pdf_disponibile`: quel
 * campo il server lo verifica sul bucket, ed è l'unico modo che il browser ha di
 * sapere se dietro il comando c'è un file. Né una risposta d'errore né una fetch
 * caduta sono un elenco vuoto silenzioso: TUTTI E DUE i rami lasciano una riga in
 * `app_log` (regola 6 di AGENTS.md) — quello della risposta col codice HTTP
 * dentro al MESSAGGIO, per la ragione scritta sul posto — e a schermo non compare
 * niente, che è la fase 2.
 */
export function useFattureScaricabili(pagamentoId: string, userId: string): ElencoFatture {
    const [stato, setStato] = useState<StatoElenco>({ ...IN_CARICAMENTO, chiave: '' });

    useEffect(() => {
        let attivo = true;
        const chiave = chiaveDi(pagamentoId, userId);

        const leggi = async () => {
            try {
                const res = await fetch(
                    `/api/pagamenti/fattura/list?pagamento_id=${encodeURIComponent(pagamentoId)}&userId=${encodeURIComponent(userId)}`,
                    { headers: { 'x-user-id': userId } },
                );
                if (!res.ok) {
                    // IL CODICE VA NEL MESSAGGIO, NON NEL CAMPO `stato`, ED È UNA SCELTA.
                    // Dichiarare `stato` significa consegnare il livello a `livelloFetch`
                    // (`client.ts`), che per ogni 4xx fuori da {408,409,413,429} risponde
                    // `null`, cioè NON SPEDIRE: un 403 o un 404 di questa route non
                    // produrrebbe nessuna riga. E dall'altro lato non ne produce comunque —
                    // `with-route.ts` manda 401/403/404 a `info`, «mai in tabella». Delle
                    // due l'una: o il codice sta qui dentro, o di questo guasto non resta
                    // traccia da nessuna parte mentre al genitore i comandi della fattura
                    // spariscono in silenzio. Non è il rumore che quella politica tiene
                    // fuori (una sessione scaduta su una fetch qualunque): è UNA route
                    // nostra, chiamata sul pagamento che l'utente sta già guardando.
                    // Sul 5xx questa riga si affianca a quella del patch di `fetch`, che
                    // quel livello lo spedisce da sé: due righe, e dicono cose diverse —
                    // il patch dice «la richiesta è andata male», questa dice «al genitore
                    // i comandi della fattura sono spariti dallo schermo».
                    logClient({
                        livello: 'warn',
                        evento: 'fetch',
                        messaggio: `fattura-elenco-non-letto: http-${res.status}`,
                    });
                    if (attivo) setStato({ caricamento: false, scaricabili: [], scarti: [], chiave });
                    return;
                }
                const corpo = (await res.json()) as { success?: boolean; data?: unknown } | null;
                const righe = corpo?.success && Array.isArray(corpo.data)
                    ? (corpo.data as FatturaScaricabile[])
                    : [];
                if (attivo) {
                    setStato({
                        caricamento: false,
                        // `=== true` e non un valore vero qualunque: `pdf_disponibile`
                        // assente su una risposta più vecchia deve valere «non lo so»,
                        // cioè nessun comando — mai «probabilmente sì».
                        scaricabili: righe.filter((f) => f?.pdf_disponibile === true),
                        // NON filtrato su `pdf_disponibile`: una fattura respinta il
                        // file può non averlo affatto, ed è il caso in cui il motivo
                        // serve di più. Vedi `ElencoFatture.scarti`.
                        scarti: scartiDa(righe),
                        chiave,
                    });
                }
            } catch (e) {
                // Solo il `name` dell'errore: il `message` di una fetch fallita si porta
                // dietro l'URL, e in quell'URL c'è l'identificativo di una famiglia.
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: `fattura-elenco-non-letto: ${nomeErrore(e)}`,
                });
                if (attivo) setStato({ caricamento: false, scaricabili: [], scarti: [], chiave });
            }
        };

        void leggi();
        return () => { attivo = false; };
    }, [pagamentoId, userId]);

    // Finché lo stato parla di un ALTRO pagamento, siamo in fase 1 per questo.
    return stato.chiave === chiaveDi(pagamentoId, userId)
        ? { caricamento: stato.caricamento, scaricabili: stato.scaricabili, scarti: stato.scarti }
        : IN_CARICAMENTO;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Il nome del file, e l'indirizzo
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Solo cifre, e `0` quando non ne resta nessuna — la STESSA regola della route
 * (`cifre()` in `api/pagamenti/fattura/route.ts`), di proposito: quel nome lo
 * scrive anche il `Content-Disposition`, e due regole diverse darebbero allo
 * stesso documento due nomi diversi a seconda che lo salvi il browser o la
 * WebView. `fattura--2026.pdf` sembra un file rotto, `fattura-0-2026.pdf` si legge.
 */
function soloCifre(valore: number | string | null | undefined): string {
    return String(valore ?? '').replace(/\D+/g, '') || '0';
}

/**
 * Il nome che il PDF avrà sul dispositivo: `fattura-1948-2026.pdf`.
 *
 * SOLO CIFRE, ed è la regola che conta più di tutte in questa funzione. Su nativo
 * questo nome finisce nel FOGLIO DI CONDIVISIONE del telefono — WhatsApp, Mail,
 * «Salva su File» — cioè è la stringa che altre persone vedranno per prime. Un
 * nome di bambino, un cognome di famiglia o un'etichetta di quota lì dentro
 * sarebbero un dato personale spedito fuori dall'app dal nome di un file, e
 * `intestatario` e `quota_label` sono esattamente questo: perciò non entrano.
 * (Vale anche in senso tecnico: una barra dentro un'etichetta, su nativo, non è
 * un nome ma un PERCORSO.)
 */
export function nomeFileFattura(numero: number | string, anno: number | string): string {
    return `fattura-${soloCifre(numero)}-${soloCifre(anno)}.pdf`;
}

export interface CoordinateFattura {
    pagamentoId: string;
    /** Quale delle quote. Si passa sempre quando lo si conosce: l'elenco lo dà. */
    fatturaId?: string | null;
    userId: string;
    /**
     * `true` → `download=1`, cioè `Content-Disposition: attachment`. Assente →
     * `inline`: il PDF si apre, non si salva.
     */
    scaricare?: boolean;
}

/**
 * L'indirizzo della fattura sulla route: RELATIVO, e stessa origine — quindi niente
 * `target="_blank"` (nella WebView `window.open` non apre e non lo dice).
 *
 * ⚠️ NON RENDERLO ASSOLUTO, e la tentazione è concreta perché ha un movente vero: il
 * ripiego di `scarica()` condivide proprio questo `url`, e un indirizzo relativo dentro
 * il foglio di sistema non lo apre nessuno (vedi `AvvisoScarico`, difetto 2). Solo che
 * qui dentro c'è `userId` IN CHIARO, e il ramo legacy che lo accetta è vivo PER
 * DIFETTO: `src/lib/auth/require-staff.ts` lo spegne solo se `ALLOW_HEADER_IDENTITY`
 * vale esattamente la stringa `'false'` — variabile che nel repo è descritta come un
 * traguardo di rollout, non come uno stato acquisito. Finché è così, quel `?userId=`
 * non identifica soltanto: AUTENTICA chi non ha nessuna sessione. Un
 * documento fiscale spedito su WhatsApp con dentro la chiave d'accesso del genitore è
 * molto peggio di un link che non si apre. La strada giusta è AVVISARE che il file non
 * è arrivato; condividere questo indirizzo non lo è.
 */
export function urlFattura({ pagamentoId, fatturaId, userId, scaricare }: CoordinateFattura): string {
    const q = new URLSearchParams({ pagamento_id: pagamentoId, userId });
    if (fatturaId) q.set('fattura_id', fatturaId);
    if (scaricare) q.set('download', '1');
    return `/api/pagamenti/fattura?${q.toString()}`;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Aprire o scaricare
 * ════════════════════════════════════════════════════════════════════════════ */

export interface BersaglioFattura {
    url: string;
    nomeFile: string;
    /** Titolo del foglio di sistema. MAI un nome di persona: lo legge chi riceve. */
    titolo?: string;
}

/**
 * UNO SCARICO ALLA VOLTA, per tutta la pagina — CON UNA SCADENZA.
 *
 * Su iOS presentare un secondo foglio di condivisione mentre il primo è aperto
 * SOLLEVA, e in una tabella di rette questi comandi sono decine. Il lucchetto è di
 * modulo (una scheda del browser, non un componente) proprio perché il foglio di
 * sistema è uno solo per tutto il dispositivo.
 *
 * ⚠️ MA UN LUCCHETTO SENZA SCADENZA È UN LUCCHETTO CHE SI INCASTRA, e la chiave qui
 * la tiene una `fetch` che non è nostra: `scarica()` non ha timeout, e una richiesta
 * appesa nella WebView non si risolve né si rifiuta — è il caso che in `app_log` si
 * presenta come `stato_http = 0`, «Load failed», e che su una rete mobile che sparisce
 * a metà non è affatto raro. Con un booleano nudo quel giro non finirebbe MAI: da lì
 * in avanti «Apri» e «Scarica» di OGNI riga della pagina risponderebbero soltanto «un
 * altro scarico è in corso», per tutta la vita della scheda. Cioè un pulsante che non
 * fa niente e dà pure la colpa a un altro. Il tetto qui sotto chiude quel giro.
 *
 * NON è un booleano ma l'IDENTITÀ del giro in volo, e serve proprio al tetto: quando
 * la scadenza libera il lucchetto, il giro vecchio è ancora vivo e può arrivare a
 * verdetto DOPO che un altro l'ha preso. Con un `true/false` quel verdetto tardivo
 * aprirebbe il lucchetto di qualcun altro — due fogli di sistema insieme, che è
 * esattamente ciò che questo lucchetto esiste per impedire.
 */
let giroInVolo: symbol | null = null;

/**
 * Il motivo con cui il guard qui sopra rifiuta il secondo click. È una COSTANTE e
 * non una stringa scritta due volte perché `avvisoDa()` ci si appoggia per dire
 * all'utente «aspetta» invece di «non è riuscito»: due letterali uguali a occhio
 * sarebbero, il giorno che uno dei due cambia, un avviso che smette di comparire
 * senza che niente diventi rosso.
 */
const MOTIVO_GIA_IN_CORSO = 'gia-in-corso';

/**
 * Oltre questo tempo il giro si dichiara chiuso: il lucchetto si libera e all'utente
 * si dice che non è riuscito — che è la verità di ciò che ha in mano.
 *
 * Trenta secondi, e non cinque: su una rete lenta una fattura di qualche centinaio di
 * kilobyte ci mette parecchio, e un tetto stretto trasformerebbe uno scarico LENTO in
 * uno scarico FALLITO, col file che poi arriva davvero.
 *
 * ⚠️ 60 s → 30 s il 2026-09-10, e non è un ripensamento di gusto: 30 s è `MAI_OLTRE_MS`,
 * il taglio di piattaforma che `__tests__/lib/logging-tetto.test.ts` impone a OGNI scadenza
 * dichiarata in `src/`, e il minuto della prima stesura lo sforava. Vale per tutti per la
 * ragione scritta lì: «un tetto di mezz'ora è funzionalmente nessun tetto». Il compromesso
 * è lo stesso già accettato — sapendolo — da `src/lib/upload/carica-file.ts`: questo tetto
 * PUÒ chiudere un giro che stava funzionando, e allora l'utente legge un errore e ha un
 * pulsante da premere di nuovo; l'attesa infinita invece non produce niente. E qui il
 * paragone è in discesa e su un file piccolo, non in salita su 4 MB. Se 30 s fossero
 * troppo pochi lo direbbe il CONTEGGIO, non un'opinione: la scadenza lascia in `app_log`
 * il suo `MOTIVO_TETTO` proprio per poter essere contata.
 */
const TETTO_SCARICO_MS = 30_000;

/** Il motivo che la scadenza lascia in `app_log`: serve a poterla CONTARE. */
const MOTIVO_TETTO = 'tetto-tempo';

/**
 * Apre o scarica UNA fattura, e l'esito finisce SEMPRE in `app_log` — successo
 * compreso.
 *
 * Il successo si logga per la ragione scritta in AGENTS.md §5: senza la sua riga,
 * «nessun log» non distingue «va tutto bene» da «il pulsante non ha mai fatto
 * partire niente», ed è precisamente l'ambiguità in cui uno «Scarica» rotto vive
 * per mesi. `scarica()` NON LANCIA MAI: qui non c'è un ramo d'errore da inventare,
 * c'è un verdetto da registrare.
 *
 * NON chiama `preventDefault()`: il gesto del browser lo decide il chiamante, che
 * è l'unico a sapere se siamo su nativo PRIMA di diventare asincrono.
 */
export async function apriOScaricaFattura(bersaglio: BersaglioFattura): Promise<RisultatoScarico> {
    if (giroInVolo) {
        // NON un `return` nudo, e per DUE ragioni. In tabella: «il comando è
        // incagliato» e «nessuno l'ha premuto» sarebbero lo stesso silenzio. A
        // schermo: il motivo torna a chi chiama, `avvisoDa()` lo riconosce e
        // l'utente legge «aspetta» — senza, il secondo click sarebbe di nuovo un
        // pulsante premuto che non fa niente e non lo dice.
        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'fattura-scarico-gia-in-corso' });
        return { esito: 'non-riuscito', motivo: MOTIVO_GIA_IN_CORSO };
    }
    const mio = Symbol('scarico-fattura');
    giroInVolo = mio;
    // Solo il PROPRIO giro si libera: se il tetto ha già passato il lucchetto a un
    // altro, questo non glielo toglie di mano.
    const libera = () => { if (giroInVolo === mio) giroInVolo = null; };

    return new Promise<RisultatoScarico>((risolvi) => {
        // Chi ha già risposto a chi ha premuto. Una risposta sola: il tetto e il
        // verdetto vero corrono insieme, e il secondo che arriva tace a schermo.
        let risposto = false;

        const scadenza = setTimeout(() => {
            if (risposto) return;
            risposto = true;
            libera();
            const scaduto: RisultatoScarico = { esito: 'non-riuscito', motivo: MOTIVO_TETTO };
            registraEsitoScarico(scaduto);
            risolvi(scaduto);
        }, TETTO_SCARICO_MS);

        void eseguiScarico(bersaglio).then((risultato) => {
            clearTimeout(scadenza);
            libera();
            if (risposto) {
                // IL VERDETTO È ARRIVATO DOPO IL TETTO. A schermo ha già parlato la
                // scadenza, e sovrascrivere quel messaggio adesso — un minuto dopo, su
                // una riga che l'utente ha smesso di guardare — direbbe una cosa giusta
                // nel momento sbagliato. Resta però da lasciarne traccia: senza questa
                // riga «la fetch è morta» e «ci ha messo settanta secondi» sarebbero lo
                // stesso silenzio, ed è l'unica misura da cui si capisce se il tetto è
                // tarato bene o se sta tagliando scarichi che sarebbero riusciti.
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: `fattura-scarico-tardivo:${risultato.esito}`,
                });
                return;
            }
            risposto = true;
            registraEsitoScarico(risultato);
            risolvi(risultato);
        });
    });
}

/**
 * `scarica()`, con la sua promessa mantenuta anche il giorno in cui smettesse di
 * mantenerla da sé: NON LANCIA MAI.
 *
 * Non è un dubbio sulla parola di `@/lib/native/scarica` (che dichiara di non
 * lanciare, e non lancia): è ciò che rende mantenibile la promessa di QUESTA
 * funzione senza un `.catch` a ogni chiamata. Un rifiuto inatteso resterebbe
 * altrimenti una unhandled rejection — l'unico esito che non lascerebbe traccia da
 * nessuna parte — e per giunta lascerebbe il lucchetto chiuso fino al tetto.
 */
async function eseguiScarico(bersaglio: BersaglioFattura): Promise<RisultatoScarico> {
    try {
        return await scarica(bersaglio);
    } catch (e) {
        return { esito: 'non-riuscito', motivo: nomeErrore(e) };
    }
}

/**
 * L'esito in `app_log`. Il motivo è già un token (`nomeErrore`, `http-<n>`, o una
 * causa nostra): mai un URL, mai un nome di file.
 *
 * I DUE RIPIEGHI RESTANO DUE TOKEN DIVERSI, e la ragione NON è quella che stava
 * scritta qui («col foglio l'utente vede qualcosa succedere, con gli appunti no»):
 * per la fattura non vede niente di utile né nell'uno né nell'altro, perché quel che
 * si condivide è un indirizzo relativo — è il difetto 2 raccontato su `AvvisoScarico`,
 * e a schermo i due casi oggi dicono la stessa frase. Restano distinti QUI perché
 * questa tabella serve a sapere per quale STRADA ci si è arrivati: `condividiLink` che
 * apre il foglio è un dispositivo che ha una Web Share API e un plugin registrato,
 * `appunti` è un browser che non ce l'ha. Sommarli renderebbe impossibile capire quale
 * dei due mondi sta perdendo le fatture.
 *
 * Detto con precisione: `ripiego-appunti` da QUI non arriva oggi, perché
 * `useScaricoFattura` chiama `scarica()` solo su nativo e lì gli appunti non sono una
 * strada. Il token resta distinto perché a distinguerlo è `scarica.ts`, non questo
 * modulo, e perché il giorno in cui una pelle chiamasse da web sarebbe già contato
 * invece di essere sommato all'altro.
 */
function registraEsitoScarico(risultato: RisultatoScarico): void {
    const coda = risultato.motivo ? `: ${risultato.motivo}` : '';
    if (risultato.esito === 'nativo-file' || risultato.esito === 'web-blob') {
        // `warn` per un successo non è un refuso: `/api/logs` accetta SOLO
        // `warn|error`, quindi un `info` non sarebbe spedibile — e non spedirlo
        // vuol dire non averlo. `controlloTassoErrore` guarda solo gli `error`,
        // quindi questo battito non fa dire «degradato» a un'app sana.
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `fattura-scarico-riuscito:${risultato.esito}` });
        return;
    }
    if (risultato.esito === 'ripiego-condivisione' || risultato.esito === 'ripiego-appunti') {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `fattura-scarico-${risultato.esito}${coda}` });
        return;
    }
    logClient({ livello: 'error', evento: 'fetch', messaggio: `fattura-scarico-non-riuscito${coda}` });
}

/**
 * CIÒ CHE VA DETTO ALL'UTENTE quando il gesto NON gli ha consegnato il file.
 *
 * ⚠️ QUESTA ENUMERAZIONE È NATA SBAGLIATA DUE VOLTE, e le due volte hanno la stessa
 * radice: dedurre da `@/lib/native/scarica` — cioè dal modulo della GALLERIA — quali
 * esiti «vanno bene», invece di guardare che cosa resta in mano a chi ha premuto.
 *
 *  1. Prima qui c'era un booleano solo, `ripiegoMuto`, acceso dall'esito
 *     `ripiego-appunti`. Sembrava giusto — `scarica.ts` dichiara che il ramo appunti
 *     è muto e che chi chiama DEVE avvisare — ed era un avviso CHE NON POTEVA
 *     COMPARIRE MAI: `apri()` passa da `scarica()` soltanto quando `isNativeApp()`, e
 *     su nativo `condividiLink` ritorna `foglio` o `non-riuscita`, mai `appunti`
 *     (`src/lib/native/share.ts`). Il ramo che sul telefono capita DAVVERO — plugin
 *     Filesystem non registrato (`scarica.ts`, il riquadro sul `cap sync`), e poi
 *     anche il foglio che non si apre — restava senza una parola.
 *  2. Poi `ripiego-condivisione` è rimasto mappato a «niente da dire», con la
 *     motivazione che il foglio di sistema l'utente lo VEDE aprirsi. Lo vede, ed è
 *     PEGGIO: quel foglio, QUI, non consegna niente. Il ripiego di `scarica()`
 *     condivide `input.url`, e il nostro url è RELATIVO (`/api/pagamenti/fattura?…`,
 *     vedi `urlFattura`). Nella galleria il ripiego funziona perché lì l'indirizzo è
 *     un link firmato ASSOLUTO di Supabase; qui il foglio consegna a WhatsApp o a
 *     Mail una stringa che nessuna app al mondo sa aprire. L'utente vede il gesto
 *     riuscire, si manda «la fattura», e non ha né il documento né un errore: è il
 *     pulsante al buio sopravvissuto DENTRO la propria correzione, per la seconda
 *     volta e nello stesso file.
 *
 * ─── LA REGOLA, scritta come si misura ───────────────────────────────────────
 * CONSEGNANO IL FILE, e solo loro: `nativo-file` e `web-blob`. Ogni altro esito è
 * «non consegnato» e PARLA. Non si aggiunge un terzo esito a quei due senza avere il
 * file in mano alla fine — ed è per questo che `avvisoDa()` qui sotto elenca per nome
 * i due che tacciono e manda tutto il resto al ramo di chiusura, invece del
 * contrario: così un esito NUOVO in `EsitoScarico` nasce parlante, non muto.
 *
 * ⚠️ E NON SI «AGGIUSTA» RENDENDO ASSOLUTO L'URL: il perché sta su `urlFattura`, e
 * non è un dettaglio di stile — è la chiave d'accesso di un genitore.
 */
export type AvvisoScarico =
    /** Un altro scarico è in volo: il foglio di sistema è uno solo per dispositivo. */
    | 'in-corso'
    /**
     * QUALCOSA È SUCCESSO E IL FILE NON C'È. Il foglio di condivisione si è aperto
     * (`ripiego-condivisione`), oppure il link è finito negli appunti
     * (`ripiego-appunti`) — e in tutti e due i casi ciò che è stato consegnato è un
     * indirizzo relativo, cioè niente. È il solo avviso che deve CONTRADDIRE quello
     * che l'utente ha appena visto con i suoi occhi: senza, resta convinto di avere
     * la fattura, e se ne accorge il giorno che gli serve.
     *
     * I due ripieghi finiscono nello stesso avviso perché all'utente dicono la stessa
     * identica cosa. In `app_log` restano DUE token distinti (`registraEsitoScarico`):
     * lì servono a sapere per quale strada ci si è arrivati, e quella distinzione la
     * fa `scarica.ts`, non lo schermo.
     */
    | 'non-consegnato'
    /** Non è arrivato niente e non è successo niente: nemmeno il ripiego. */
    | 'non-riuscito';

/**
 * Da un verdetto di `scarica()` all'avviso, o `null` quando davvero non c'è niente da
 * dire — cioè SOLO quando il file è stato consegnato.
 *
 * Pura di proposito: è la regola che decide se lo schermo parla, e si vuole poter
 * mettere alla prova senza montare un componente.
 */
export function avvisoDa(risultato: RisultatoScarico): AvvisoScarico | null {
    // I DUE CHE CONSEGNANO, per nome. Sono l'eccezione, non la regola: tutto ciò che
    // non è in questa riga è un gesto che non ha dato il file a nessuno.
    if (risultato.esito === 'nativo-file' || risultato.esito === 'web-blob') return null;
    if (risultato.esito === 'non-riuscito') {
        return risultato.motivo === MOTIVO_GIA_IN_CORSO ? 'in-corso' : 'non-riuscito';
    }
    // Ramo di CHIUSURA, non un elenco: `ripiego-condivisione`, `ripiego-appunti` e
    // qualunque esito che `scarica.ts` aggiungesse domani. Un esito nuovo qui dentro
    // nasce «non consegnato» e va dimostrato consegnante, non il contrario.
    return 'non-consegnato';
}

export interface GestoreScaricoFattura {
    /**
     * Da mettere sull'`onClick` di OGNI ancora, «Apri» e «Scarica».
     *
     * Sul web non fa niente e lascia lavorare l'ancora: la route è stessa origine
     * e il suo `Content-Disposition` fa già il mestiere. Su nativo ferma il gesto
     * del browser (che nella WebView non farebbe NULLA, in silenzio) e passa da
     * `@/lib/native/scarica`.
     */
    apri: (evento: { preventDefault: () => void }, bersaglio: BersaglioFattura) => void;
    /**
     * Che cosa mostrare a schermo, o `null` per «niente». Chi rende questo gestore
     * DEVE renderlo: è la parte che trasforma un pulsante muto in un pulsante che
     * risponde, e sul web resta `null` per costruzione (lì scarica il browser).
     */
    avviso: AvvisoScarico | null;
}

/**
 * Il gesto «apri o scarica una fattura», scritto UNA VOLTA per le due pelli.
 */
export function useScaricoFattura(): GestoreScaricoFattura {
    const [avviso, setAvviso] = useState<AvvisoScarico | null>(null);

    const apri = useCallback((evento: { preventDefault: () => void }, bersaglio: BersaglioFattura) => {
        setAvviso(null);
        // La domanda si fa PRIMA di diventare asincroni: `preventDefault()` dopo un
        // `await` non ferma più niente, il browser è già andato per la sua strada.
        if (!isNativeApp()) return;
        evento.preventDefault();
        void apriOScaricaFattura(bersaglio).then((risultato) => {
            setAvviso(avvisoDa(risultato));
        });
    }, []);

    return { apri, avviso };
}
