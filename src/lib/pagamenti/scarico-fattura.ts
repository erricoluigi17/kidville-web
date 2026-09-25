'use client';

import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { isNativeApp } from '@/lib/push/native-register';
import {
    fileConsegnato,
    scaricaDocumento,
    type DocumentoInput,
    type RisultatoScarico,
} from '@/lib/native/scarica';
import { registraEsitoFattura } from '@/lib/pagamenti/esito-fattura';
import { SUPABASE_URL } from '@/lib/supabase/public-config';

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
 * vecchio ripiego di `scarica()` condivideva proprio questo `url`, e un indirizzo relativo
 * dentro il foglio di sistema non lo apre nessuno (vedi `AvvisoScarico`, difetto 2). Oggi
 * il salvataggio nativo passa da `scaricaDocumento`, che un indirizzo della STESSA
 * origine non lo condivide mai come link — e resta così PERCHÉ è relativo. Solo che
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
 * Il lucchetto, il tetto e ciò che si dice all'utente
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * UN SALVATAGGIO ALLA VOLTA, per tutta la pagina — CON UNA SCADENZA.
 *
 * Su iOS presentare un secondo foglio di condivisione mentre il primo è aperto
 * SOLLEVA, e in una tabella di rette questi comandi sono decine. Il lucchetto è di
 * modulo (una scheda del browser, non un componente) proprio perché il foglio di
 * sistema è uno solo per tutto il dispositivo.
 *
 * CHE COSA FA IL TETTO (`TETTO_SCARICO_MS`), e che cosa NON fa. Il tetto copre la sola
 * LETTURA dalla rete — una richiesta appesa nella WebView non si risolve né si rifiuta,
 * è il caso che in `app_log` si presenta come `stato_http = 0`, «Load failed» — e la
 * interrompe abortendola; poi decide che cosa dire all'utente. NON tocca il foglio di
 * sistema e NON libera il lucchetto prima del tempo:
 *  - strada del browser esterno (binario 1.0): la `fetch` è l'unica cosa in volo, e il
 *    giro si chiude allo scadere del tetto;
 *  - strada nativa (app 1.1): il tetto vale fino a quando il PDF è in mano (`fetch` e
 *    corpo, dentro la sorgente-funzione di `scaricaConTetto`); scrittura in Cache e foglio
 *    «Salva su File» non sono né contati né interrotti. Il lucchetto resta del giro finché
 *    `scaricaDocumento` non ha dato il suo verdetto (`scaricaConTetto` lo aspetta; dopo un
 *    abort del chiamante lo aspetta `sbloccoDifferito`). Così non si aprono mai due fogli
 *    di sistema insieme.
 *
 * ⚠️ Il prezzo, accettato sapendolo: un bridge nativo APPESO (`writeFile` o
 * `Share.share` che non tornano mai) tiene il lucchetto per tutta la vita della scheda,
 * e da lì «Scarica» di ogni riga risponde soltanto «un altro scarico è in corso». Il
 * tetto non può chiuderlo, perché il bridge non ascolta l'abort; e liberare il lucchetto
 * lì vorrebbe dire rischiare il secondo foglio sopra il primo, che su iOS SOLLEVA.
 * Chiudere la pagina e riaprirla lo sblocca.
 *
 * NON è un booleano ma l'IDENTITÀ del giro in volo: quando il rilascio è DIFFERITO
 * (`sbloccoDifferito`, dopo un abort del chiamante) il verdetto arriva quando la
 * funzione è già tornata. Il `Symbol` fa sì che quel rilascio tardivo liberi il
 * lucchetto solo se è ancora di QUESTO giro, e mai quello di un giro successivo. Oggi
 * nessuno lo passa di mano prima (lo libera solo il `finally` di `salvaFattura`), e il
 * controllo è una difesa: resta vera anche il giorno in cui qualcuno aggiungesse un
 * rilascio anticipato.
 */
let giroInVolo: symbol | null = null;

/**
 * Il motivo con cui il lucchetto rifiuta il secondo click. È una COSTANTE e non una
 * stringa scritta due volte perché `avvisoDa()` ci si appoggia per dire all'utente
 * «aspetta» invece di «non è riuscito»: due letterali uguali a occhio sarebbero, il
 * giorno che uno dei due cambia, un avviso che smette di comparire senza che niente
 * diventi rosso.
 */
const MOTIVO_GIA_IN_CORSO = 'gia-in-corso';

/**
 * Oltre questo tempo la lettura del PDF che non è ancora arrivata si interrompe, e
 * all'utente si dice che non è riuscito — che è la verità di ciò che ha in mano. Il
 * tempo si ferma appena i byte sono in mano: la scrittura in Cache e il foglio «Salva su
 * File» NON sono contati, e il foglio non riceve MAI il segnale del tetto — né per
 * chiuderlo né per decidere l'esito di un «Annulla». Il tempo che l'utente passa a
 * scegliere la cartella è suo (vedi `scaricaConTetto`).
 *
 * Trenta secondi, e non cinque: su una rete lenta una fattura di qualche centinaio di
 * kilobyte ci mette parecchio, e un tetto stretto trasformerebbe uno scarico LENTO in
 * uno scarico FALLITO, col file che poi arriva davvero.
 *
 * ⚠️ 60 s → 30 s il 2026-09-10, e non è un ripensamento di gusto: 30 s è `MAI_OLTRE_MS`,
 * il taglio di piattaforma che `__tests__/lib/logging-tetto.test.ts` impone a OGNI scadenza
 * dichiarata in `src/`. Il compromesso è lo stesso già accettato da
 * `src/lib/upload/carica-file.ts`: questo tetto PUÒ chiudere un giro che stava
 * funzionando, e allora l'utente legge un errore e ha un pulsante da premere di nuovo;
 * l'attesa infinita invece non produce niente. Se 30 s fossero troppo pochi lo direbbe
 * il CONTEGGIO: la scadenza lascia in `app_log` il suo `MOTIVO_TETTO` apposta, in UNA
 * riga `error` per strada — `fattura-browser-esterno:tetto-tempo` (binario 1.0) e
 * `fattura-scarico-non-riuscito: tetto-tempo` scritta dall'helper (app 1.1).
 */
const TETTO_SCARICO_MS = 30_000;

/** Il motivo che la scadenza lascia in `app_log`: serve a poterla CONTARE. */
const MOTIVO_TETTO = 'tetto-tempo';

/** Il prefisso dei log di `scaricaDocumento`: `fattura-scarico-riuscito:nativo-file`, … */
const ETICHETTA_LOG = 'fattura';

/**
 * `scaricaDocumento()`, con la sua promessa mantenuta anche il giorno in cui smettesse
 * di mantenerla da sé: NON LANCIA MAI.
 *
 * Il verdetto — successo compreso — lo logga `scaricaDocumento` da sé (§5 di
 * AGENTS.md), con l'etichetta `fattura`: qui NON si rilogga, o ogni gesto avrebbe due
 * righe in `app_log`. L'unica riga di questo modulo è quella del rifiuto inatteso
 * qui sotto, che l'helper non avrebbe mai visto.
 */
async function eseguiScarico(
    documento: DocumentoInput,
    signal?: AbortSignal,
): Promise<RisultatoScarico> {
    try {
        return await scaricaDocumento(signal ? { ...documento, signal } : documento);
    } catch (e) {
        const motivo = nomeErrore(e);
        logClient({ livello: 'error', evento: 'fetch', messaggio: `fattura-salvataggio-nativo:eccezione:${motivo}` });
        return { esito: 'non-riuscito', motivo };
    }
}

/**
 * CIÒ CHE VA DETTO ALL'UTENTE quando il gesto NON gli ha consegnato il file.
 *
 * ⚠️ QUESTA ENUMERAZIONE È NATA SBAGLIATA DUE VOLTE, e le due volte hanno la stessa
 * radice: dedurre dal modulo della GALLERIA quali esiti «vanno bene», invece di
 * guardare che cosa resta in mano a chi ha premuto.
 *
 *  1. Un avviso acceso dal solo `ripiego-appunti`, che su nativo non capitava MAI:
 *     il ramo vero del telefono (plugin Filesystem assente) restava senza una parola.
 *  2. `ripiego-condivisione` mappato a «niente da dire» perché il foglio di sistema
 *     l'utente lo VEDE aprirsi. Lo vede, ed è PEGGIO: il vecchio ripiego condivideva
 *     un indirizzo RELATIVO (`urlFattura`), cioè una stringa che nessuna app sa aprire.
 *
 * ─── LA REGOLA, scritta come si misura ───────────────────────────────────────
 * CONSEGNANO IL FILE, e solo loro, gli esiti di `fileConsegnato()` — l'elenco CHIUSO
 * dell'helper, uno solo per tutta l'app. Ogni altro esito è «non consegnato» e PARLA:
 * un esito NUOVO nasce parlante, non muto.
 *
 * ⚠️ E NON SI «AGGIUSTA» RENDENDO ASSOLUTO L'URL: il perché sta su `urlFattura`, e
 * non è un dettaglio di stile — è la chiave d'accesso di un genitore.
 */
export type AvvisoScarico =
    /** Un altro scarico è in volo: il foglio di sistema è uno solo per dispositivo. */
    | 'in-corso'
    /**
     * QUALCOSA È SUCCESSO E IL FILE NON C'È: si è aperto un foglio (o sono stati
     * riempiti gli appunti) con un indirizzo invece del documento. È il solo avviso
     * che deve CONTRADDIRE quello che l'utente ha appena visto con i suoi occhi.
     */
    | 'non-consegnato'
    /** Non è arrivato niente e non è successo niente: nemmeno il ripiego. */
    | 'non-riuscito';

/**
 * Da un verdetto dell'helper all'avviso, o `null` quando davvero non c'è niente da
 * dire — cioè SOLO quando il file è stato consegnato.
 *
 * Pura di proposito: è la regola che decide se lo schermo parla, e si vuole poter
 * mettere alla prova senza montare un componente.
 */
export function avvisoDa(risultato: RisultatoScarico): AvvisoScarico | null {
    if (fileConsegnato(risultato)) return null;
    if (risultato.esito === 'non-riuscito') {
        return risultato.motivo === MOTIVO_GIA_IN_CORSO ? 'in-corso' : 'non-riuscito';
    }
    // Ramo di CHIUSURA, non un elenco: `ripiego-condivisione`, `ripiego-appunti` e
    // qualunque esito che `scarica.ts` aggiungesse domani.
    return 'non-consegnato';
}

/* ════════════════════════════════════════════════════════════════════════════
 * Il gesto SALVA, separato dall'apertura nel viewer
 * ════════════════════════════════════════════════════════════════════════════ */

export type ModalitaSalvataggioFattura =
    | 'download-web'
    | 'filesystem-nativo'
    | 'browser-esterno';

export interface PresentazioneSalvataggioFattura {
    modalita: ModalitaSalvataggioFattura;
    etichetta: 'Salva' | 'Apri nel browser per salvare';
}

export interface SalvaFatturaInput {
    pagamentoId: string;
    fatturaId: string;
    userId: string;
    numero: number | string;
    anno: number | string;
    titolo?: string;
    /** Lo smontaggio annulla fetch, scritture successive e ogni handoff tardivo. */
    signal?: AbortSignal;
}

export type RisultatoSalvataggioFattura =
    | {
        ok: true;
        modalita: ModalitaSalvataggioFattura;
        avviso: null;
      }
    | {
        ok: false;
        modalita: ModalitaSalvataggioFattura;
        motivo: string;
        riprovabile: true;
        avviso: AvvisoScarico | null;
      };

/**
 * I plugin che servono a consegnare il PDF col foglio «Salva su File»: `Filesystem`
 * (il file in Cache) e `Share` (il foglio col FILE). La fattura è una route della
 * STESSA origine, quindi `FileTransfer` non serve: i byte li legge la `fetch` della
 * WebView, che ha i cookie di sessione.
 *
 * I binari 1.0 non hanno `Filesystem`: lì la strada resta «Apri nel browser per
 * salvare». Si chiede ANCHE `Share` perché senza foglio `scaricaDocumento` non ha dove
 * consegnare il file e risponderebbe «non riuscito» — e il ripiego del browser, che
 * almeno funziona, andrebbe perso. Nessun plugin si chiama senza `isPluginAvailable`.
 */
const PLUGIN_FOGLIO = ['Filesystem', 'Share'] as const;

function foglioNativoDisponibile(): boolean {
    try {
        return PLUGIN_FOGLIO.every((nome) => Capacitor.isPluginAvailable(nome));
    } catch (errore) {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `fattura-filesystem-non-verificato:${nomeErrore(errore)}`,
        });
        return false;
    }
}

/**
 * Decide testo e strada PRIMA del click:
 *  - web → `download-web`: la route in `attachment`, come sempre;
 *  - app nativa con Filesystem e Share (1.1) → `filesystem-nativo`: il PDF nel foglio
 *    di condivisione, via `scaricaDocumento`;
 *  - app nativa senza (binario 1.0) → `browser-esterno`: «Apri nel browser per salvare».
 */
export function presentazioneSalvataggioFattura(): PresentazioneSalvataggioFattura {
    if (!isNativeApp()) return { modalita: 'download-web', etichetta: 'Salva' };
    return foglioNativoDisponibile()
        ? { modalita: 'filesystem-nativo', etichetta: 'Salva' }
        : { modalita: 'browser-esterno', etichetta: 'Apri nel browser per salvare' };
}

function risultatoNegativo(
    modalita: ModalitaSalvataggioFattura,
    motivo: string,
    avviso: AvvisoScarico | null = 'non-riuscito',
): RisultatoSalvataggioFattura {
    return { ok: false, modalita, motivo, riprovabile: true, avviso };
}

function registraAvvio(input: SalvaFatturaInput, esito: 'browser_avviato' | 'salvataggio_avviato'): void {
    void registraEsitoFattura({
        pagamentoId: input.pagamentoId,
        fatturaId: input.fatturaId,
        esito,
    });
}

function urlDownload(input: SalvaFatturaInput): string {
    return urlFattura({
        pagamentoId: input.pagamentoId,
        fatturaId: input.fatturaId,
        userId: input.userId,
        scaricare: true,
    });
}

function urlEndpointEsterno(input: SalvaFatturaInput): string {
    const url = new URL(urlDownload(input), globalThis.location.origin);
    url.searchParams.delete('download');
    url.searchParams.set('esterno', '1');
    return `${url.pathname}${url.search}`;
}

interface RispostaUrlEsterno {
    success: true;
    data: { url: string; scade_il: string };
}

function urlEsternoValido(corpo: unknown, adesso: number): corpo is RispostaUrlEsterno {
    if (!corpo || typeof corpo !== 'object') return false;
    const risposta = corpo as { success?: unknown; data?: unknown };
    if (risposta.success !== true || !risposta.data || typeof risposta.data !== 'object') return false;
    const data = risposta.data as { url?: unknown; scade_il?: unknown };
    if (typeof data.url !== 'string' || typeof data.scade_il !== 'string') return false;
    try {
        const url = new URL(data.url);
        const storage = new URL(SUPABASE_URL);
        const scadeIl = Date.parse(data.scade_il);
        return url.protocol === 'https:'
            && url.origin === storage.origin
            && url.pathname.startsWith('/storage/v1/object/sign/fatture/')
            && Boolean(url.searchParams.get('token'))
            && Number.isFinite(scadeIl)
            && scadeIl > adesso
            && scadeIl <= adesso + 310_000;
    } catch {
        return false;
    }
}

type EsitoFetchEsterno =
    | { tipo: 'corpo'; corpo: unknown; riferimentoTemporale: number }
    | { tipo: 'http'; stato: number }
    | { tipo: 'json-non-valido'; errore: unknown }
    | { tipo: 'errore'; errore: unknown }
    | { tipo: 'annullato' }
    | { tipo: 'timeout' };

async function fetchUrlEsterno(input: SalvaFatturaInput): Promise<EsitoFetchEsterno> {
    if (input.signal?.aborted) return { tipo: 'annullato' };
    const controller = new AbortController();
    let chiudiAttesa: ((esito: EsitoFetchEsterno) => void) | null = null;
    const interruzione = new Promise<EsitoFetchEsterno>((resolve) => { chiudiAttesa = resolve; });
    const annulla = () => {
        controller.abort();
        chiudiAttesa?.({ tipo: 'annullato' });
    };
    input.signal?.addEventListener('abort', annulla, { once: true });
    const timer = setTimeout(() => {
        controller.abort();
        chiudiAttesa?.({ tipo: 'timeout' });
    }, TETTO_SCARICO_MS);
    const richiesta = (async (): Promise<EsitoFetchEsterno> => {
        try {
            const risposta = await fetch(urlEndpointEsterno(input), {
                credentials: 'same-origin',
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!risposta.ok) return { tipo: 'http', stato: risposta.status };
            const dataRisposta = Date.parse(risposta.headers.get('date') ?? '');
            const riferimentoTemporale = Number.isFinite(dataRisposta) ? dataRisposta : Date.now();
            try {
                return { tipo: 'corpo', corpo: await risposta.json(), riferimentoTemporale };
            } catch (errore) {
                return { tipo: 'json-non-valido', errore };
            }
        } catch (errore) {
            return { tipo: 'errore', errore };
        }
    })();
    try {
        return await Promise.race([richiesta, interruzione]);
    } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', annulla);
    }
}

type EsitoScaricoConTetto =
    | { tipo: 'risultato'; risultato: RisultatoScarico }
    | { tipo: 'annullato'; completamento: Promise<void> }
    | { tipo: 'timeout' };

/**
 * `eseguiScarico()` della route `url`, con il tetto di `TETTO_SCARICO_MS` sulla sola
 * LETTURA del PDF, e con l'annullamento del chiamante.
 *
 * ⚠️ IL TETTO E IL FOGLIO SONO DUE SEGNALI DIVERSI, ED È IL PUNTO DI TUTTA LA FUNZIONE.
 * All'helper si passa come `signal` SOLO quello del chiamante: è quello che arriva a
 * `writeFile` e al foglio «Salva su File» (`condividiFileLocale`). Il controller del
 * tetto invece lo vede soltanto la `fetch` fatta qui dentro, nella sorgente-funzione:
 * il timer si cancella appena il Blob è in mano. Se il tetto arrivasse al foglio,
 * `condividiFileLocale` tratterebbe un «Annulla» premuto dopo 30 s come un abort
 * (`if (signal?.aborted) return false`), e l'utente che ha solo annullato leggerebbe
 * «non riuscito», con una riga `tetto-tempo` falsa a livello `error` in `app_log`. Con
 * i segnali separati lo stesso gesto dà lo stesso esito prima e dopo i 30 s.
 *
 * Allo scadere del tetto la `fetch` (o la lettura del corpo) si interrompe con un
 * `AbortError`; la sorgente lo rilancia RINOMINATO in `{ code: MOTIVO_TETTO }`, e l'helper
 * risponde «non riuscito» PRIMA di `writeFile` e del foglio, scrivendo lui la sola riga
 * `error` del guasto (`fattura-scarico-non-riuscito: tetto-tempo`, mai `AbortError`, che
 * qui vorrebbe dire annullamento): `scaduto && !fileConsegnato` → `timeout`. Un file
 * consegnato non diventa mai un `timeout`, nemmeno se il tetto scade nell'istante in
 * cui il corpo finisce di arrivare. Un HTTP non-2xx rilancia `{ httpStatus }`, che
 * l'helper traduce in `http-NNN` (senza URL nei log).
 *
 * Il lucchetto aspetta comunque il verdetto dell'helper: un bridge appeso (`writeFile`,
 * `Share.share` che non torna mai) lascia questo `await` in sospeso — vedi il commento
 * su `giroInVolo`.
 *
 * L'abort del CHIAMANTE (componente smontato, visore chiuso) risponde invece subito
 * `annullato`, con la promessa `completamento` che tiene il lucchetto fino al verdetto;
 * abortisce anche la `fetch` in volo.
 */
async function scaricaConTetto(
    url: string,
    documento: Omit<DocumentoInput, 'sorgente' | 'signal'>,
    signal?: AbortSignal,
): Promise<EsitoScaricoConTetto> {
    if (signal?.aborted) {
        return { tipo: 'annullato', completamento: Promise.resolve() };
    }
    const controller = new AbortController();
    let scaduto = false;
    const timer = setTimeout(() => {
        // Si ferma la lettura che non è arrivata, e si aspetta il verdetto dell'helper.
        scaduto = true;
        controller.abort();
    }, TETTO_SCARICO_MS);
    const sorgente = async (): Promise<Blob> => {
        try {
            const risposta = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
            if (!risposta.ok) {
                // `motivoErrorePlugin` dell'helper legge `httpStatus` → `http-503`. Il
                // messaggio non esce mai nei log (e non contiene l'URL).
                throw Object.assign(new Error('fattura-http'), { httpStatus: risposta.status });
            }
            const blob = await risposta.blob();
            // I byte sono in mano: da qui in poi il tempo è dell'utente.
            clearTimeout(timer);
            return blob;
        } catch (errore) {
            // Rilancia SEMPRE: il verdetto resta dell'helper. Solo il NOME cambia allo
            // scadere del tetto: senza questo l'helper leggerebbe l'`AbortError` della
            // `fetch` interrotta e scriverebbe `fattura-scarico-non-riuscito: AbortError`,
            // che qui si legge come annullamento. Con un `code` stringa, che
            // `motivoErrorePlugin` accetta come token, la riga diventa
            // `fattura-scarico-non-riuscito: tetto-tempo`: UNA sola riga `error`, contabile,
            // per UN guasto (vedi il ramo `timeout` di `salvaFattura`, che non rilogga).
            if (scaduto) throw Object.assign(new Error('fattura-tetto'), { code: MOTIVO_TETTO });
            throw errore;
        }
    };
    let chiudiAttesa: ((esito: EsitoScaricoConTetto) => void) | null = null;
    const interruzione = new Promise<EsitoScaricoConTetto>((resolve) => { chiudiAttesa = resolve; });
    const operazione = eseguiScarico({ ...documento, sorgente }, signal).then<EsitoScaricoConTetto>(
        (risultato) => scaduto && !fileConsegnato(risultato)
            ? { tipo: 'timeout' }
            : { tipo: 'risultato', risultato },
    );
    const completamento = operazione.then(() => undefined);
    const annulla = () => {
        chiudiAttesa?.({ tipo: 'annullato', completamento });
        controller.abort();
    };
    signal?.addEventListener('abort', annulla, { once: true });
    try {
        return await Promise.race([operazione, interruzione]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', annulla);
    }
}

/**
 * Avvia il salvataggio senza confonderlo con l'apertura nel viewer.
 * Non dichiara mai che il file sia stato salvato: la telemetria registra soltanto
 * l'avvio del gesto che il browser o il foglio nativo completeranno fuori dall'app.
 */
export async function salvaFattura(input: SalvaFatturaInput): Promise<RisultatoSalvataggioFattura> {
    const presentazione = presentazioneSalvataggioFattura();
    if (input.signal?.aborted) {
        return risultatoNegativo(presentazione.modalita, 'annullato', null);
    }
    if (giroInVolo) {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'fattura-salvataggio-gia-in-corso' });
        return risultatoNegativo(presentazione.modalita, MOTIVO_GIA_IN_CORSO, 'in-corso');
    }

    const mio = Symbol('salvataggio-fattura');
    giroInVolo = mio;
    let sbloccoDifferito: Promise<void> | null = null;
    try {
        if (presentazione.modalita === 'filesystem-nativo') {
            registraAvvio(input, 'salvataggio_avviato');
            // App 1.1: il PDF in Cache e il foglio di condivisione col FILE («Salva su
            // File», Mail, WhatsApp). La sorgente è la route della STESSA origine in
            // `attachment`, letta da una sorgente-funzione di `scaricaConTetto` con la
            // `fetch` della WebView (i cookie ci sono) e il controllo di `res.ok`: una
            // funzione, non una stringa, perché il tetto deve fermare la lettura senza
            // arrivare al foglio. L'helper non la condivide MAI come link.
            const esito = await scaricaConTetto(urlDownload(input), {
                nomeFile: nomeFileFattura(input.numero, input.anno),
                mime: 'application/pdf',
                etichetta: ETICHETTA_LOG,
                ...(input.titolo ? { titolo: input.titolo } : {}),
            }, input.signal);
            if (esito.tipo === 'timeout') {
                // Qui l'helper ha GIÀ dato il suo verdetto (la lettura interrotta dal
                // tetto, prima di `writeFile` e del foglio): il lucchetto si libera subito.
                // E l'ha GIÀ scritto in `app_log`, a livello `error`, col motivo del tetto
                // (`fattura-scarico-non-riuscito: tetto-tempo`, dalla sorgente-funzione di
                // `scaricaConTetto`): qui NON si rilogga, o una scadenza peserebbe il
                // doppio nel tasso d'errore rispetto a un 503.
                return risultatoNegativo(presentazione.modalita, MOTIVO_TETTO);
            }
            if (esito.tipo === 'annullato') {
                sbloccoDifferito = esito.completamento;
                return risultatoNegativo(presentazione.modalita, 'annullato', null);
            }
            // Il verdetto in `app_log` l'ha già scritto `scaricaDocumento`, successo
            // compreso (`fattura-scarico-riuscito:nativo-file`): qui non si rilogga.
            const risultato = esito.risultato;
            if (risultato.motivo === 'annullato') {
                return risultatoNegativo(presentazione.modalita, 'annullato', null);
            }
            return fileConsegnato(risultato)
                ? { ok: true, modalita: presentazione.modalita, avviso: null }
                : risultatoNegativo(
                    presentazione.modalita,
                    risultato.motivo ?? 'salvataggio-non-riuscito',
                    avvisoDa(risultato),
                );
        }

        if (presentazione.modalita === 'download-web') {
            registraAvvio(input, 'salvataggio_avviato');
            globalThis.location.assign(urlDownload(input));
            return { ok: true, modalita: presentazione.modalita, avviso: null };
        }

        const esitoFetch = await fetchUrlEsterno(input);
        if (esitoFetch.tipo === 'timeout') {
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'fattura-browser-esterno:tetto-tempo' });
            return risultatoNegativo(presentazione.modalita, MOTIVO_TETTO);
        }
        if (esitoFetch.tipo === 'annullato') {
            return risultatoNegativo(presentazione.modalita, 'annullato', null);
        }
        if (esitoFetch.tipo === 'errore') {
            const motivo = nomeErrore(esitoFetch.errore);
            logClient({ livello: 'error', evento: 'fetch', messaggio: `fattura-browser-esterno:${motivo}` });
            return risultatoNegativo(presentazione.modalita, motivo);
        }
        if (esitoFetch.tipo === 'http') {
            const motivo = `http-${esitoFetch.stato}`;
            logClient({ livello: 'error', evento: 'fetch', messaggio: `fattura-browser-esterno:${motivo}` });
            return risultatoNegativo(presentazione.modalita, motivo);
        }
        if (esitoFetch.tipo === 'json-non-valido') {
            const motivo = nomeErrore(esitoFetch.errore);
            logClient({ livello: 'error', evento: 'fetch', messaggio: `fattura-browser-esterno-json:${motivo}` });
            return risultatoNegativo(presentazione.modalita, 'risposta-non-valida');
        }
        if (input.signal?.aborted || giroInVolo !== mio) {
            return risultatoNegativo(presentazione.modalita, 'annullato', null);
        }
        if (!urlEsternoValido(esitoFetch.corpo, esitoFetch.riferimentoTemporale)) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'fattura-browser-esterno:url-non-valido' });
            return risultatoNegativo(presentazione.modalita, 'url-non-valido');
        }

        registraAvvio(input, 'browser_avviato');
        globalThis.location.assign(esitoFetch.corpo.data.url);
        return { ok: true, modalita: presentazione.modalita, avviso: null };
    } catch (errore) {
        const motivo = nomeErrore(errore);
        logClient({ livello: 'error', evento: 'fetch', messaggio: `fattura-salvataggio:${motivo}` });
        return risultatoNegativo(presentazione.modalita, motivo);
    } finally {
        if (sbloccoDifferito) {
            void sbloccoDifferito.then(() => {
                if (giroInVolo === mio) giroInVolo = null;
            });
        } else if (giroInVolo === mio) {
            giroInVolo = null;
        }
    }
}
