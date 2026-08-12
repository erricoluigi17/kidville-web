'use client';

/**
 * «NON PIÙ ISCRITTI» — la linguetta di /admin/students che elenca i bambini
 * archiviati, dice da quale classe sono usciti, e li riporta dentro.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PERCHÉ UNA LINGUETTA E NON UNA PAGINA NUOVA
 *
 * È la stessa anagrafica. Una rotta separata avrebbe duplicato i filtri, lo
 * scope di sede e i conteggi — cioè tre posti in cui la stessa regola può
 * divergere — e avrebbe chiesto una GET nuova per una domanda a cui
 * `GET /api/admin/students?stato=ritirato` risponde già: quel parametro è
 * dichiarato nello schema zod della rotta E applicato (`if (stato) query =
 * query.eq('stato', stato)`), verificato prima di scrivere questo file.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'ELENCO SI CARICA QUI, NON QUANDO SI APRE LA LINGUETTA
 *
 * Il CONTEGGIO va sulla pillola della tab, quindi va saputo anche prima che
 * qualcuno guardi: una linguetta che si carica solo quando la apri non può dire
 * a nessuno che c'è da aprirla. Stessa forma di `CodiciFiscaliDaVerificare`:
 * l'hook sta qui, lo invoca `page.tsx`, e una fetch sola serve il numero e la
 * tabella.
 *
 * ⚠️ E IL CONTEGGIO È QUELLO DELLE RIGHE ARRIVATE, non `X-Total-Count`. Sembra
 * il contrario di quello che si vuole, e non lo è: il totale del server non è
 * ristretto dai filtri di questa schermata e, quando l'elenco è più lungo della
 * pagina, un badge che promette 40 righe accanto a una tabella che ne mostra 25
 * dice una cosa falsa sul dato che l'utente ha davanti. Il totale non si butta
 * via — è quello che accende l'avviso `arcParziale`, che è il posto giusto per
 * dire «ce ne sono di più».
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NIENTE CODICE FISCALE E NIENTE ALLERGIE A SCHERMO — E COSA VIAGGIA LO STESSO
 *
 * Questa vista RENDE cognome, nome, data di nascita, la classe di provenienza,
 * la data di archiviazione e — quando le sedi attive sono più d'una — il plesso.
 * Nient'altro: è un elenco per RICONOSCERE una persona e scegliere un comando, e
 * il resto sta dietro la scheda, che il gate di sede ce l'ha già.
 * `AlunnoArchiviato` non dichiara `codice_fiscale` né `note_mediche`, e
 * `AlunniArchiviatiView.test.tsx` monta una riga che li porta e pretende che non
 * compaiano nell'HTML reso, attributi compresi.
 *
 * ⚠️ MA IL CORPO DELLA RISPOSTA LI PORTA, e va detto invece di lasciar credere il
 * contrario. Fino al 2026-08-13 qui c'era scritto che «vale qui come per
 * `admin/students:GET`, la cui proiezione è stata ridotta»: è una mezza verità
 * che si legge come una piena. Misurato sul sorgente della rotta:
 * `codice_fiscale` è ancora in proiezione — DICHIARATAMENTE, per la ricerca e
 * l'export CSV di `/admin/students`, che sono due funzioni vere della stessa
 * schermata — e la GET aggiunge `ha_note_mediche`, cioè un segnale su un dato
 * dell'art. 9. Siccome questa fetch parte a OGNI apertura di `/admin/students`,
 * anche senza aprire la linguetta, i codici fiscali dei minori archiviati
 * arrivano nel browser per una vista che non li usa.
 *
 * Non si è ridotta la proiezione con un parametro apposta, e la ragione è che il
 * rimedio sarebbe peggio del male: una GET che consegna colonne diverse a
 * seconda di chi la chiama è una seconda regola di proiezione libera di divergere
 * dalla prima, e il filtro «stato=ritirato» è usato anche dall'elenco principale,
 * dove la ricerca e l'export quel campo lo vogliono. Quello che si può
 * promettere è ciò che è scritto sopra e provato dal test: che di qui non esca a
 * schermo. Chi un giorno introdurrà una proiezione per vista cominci da qui.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE COLONNE DELL'ARCHIVIAZIONE POSSONO NON ESSERCI, ED È NORMALE
 *
 * `archiviato_il`, `archiviato_classe_sezione` e `spazio_liberato_il` arrivano
 * dalla migrazione `20260812194517`. Il DB E2E della CI è un progetto SEPARATO e
 * NON migrato: là la GET degrada da sé (ciclo `42703`, toglie la colonna e
 * ripete) e quei campi semplicemente non arrivano. Perciò ogni cella li tratta
 * come opzionali e mostra un'assenza dichiarata («Nessuna classe», «Data non
 * registrata») invece di una stringa vuota — che a schermo è indistinguibile da
 * un dato mancante in archivio.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * «LIBERA SPAZIO» APRE IL SUO RIQUADRO, E QUESTA RIGA È NATA CORREGGENDO UNA BUGIA
 *
 * Fino al 2026-08-13 qui c'era scritto che la conferma per esteso «vive sulla
 * scheda del bambino» e che il comando «ci porta». **Era falso**: sulla scheda non
 * c'era niente, `grep -rn "libera-spazio" src/` non trovava una sola `fetch`, e il
 * bottone faceva `router.push` verso un vicolo cieco — mentre la riga stampata in
 * cima alla linguetta (`arcSpiegazione`) prometteva all'operatore che «con «Libera
 * spazio» se ne vanno foto, video e messaggi». Un commento che promette un
 * presidio inesistente è peggio del silenzio: chi legge ci costruisce sopra una
 * decisione, e un test aveva perfino certificato il vicolo cieco come corretto.
 *
 * Adesso il comando apre `LiberaSpazioDialog`, che è la conferma in due passi
 * (`{ alunno_id, mode: 'dryrun' | 'execute', confirm }`): prima si CONTA che cosa
 * sparirà, poi si DIGITA il nominativo (`SPAZIO_CONFERMA_NON_VALIDA`,
 * `src/lib/ui/esito-fetch.ts`). Sta ACCANTO A QUESTO ELENCO e non altrove perché
 * è dove il modello dice che l'operazione comincia: «libera spazio, solo da
 * quell'elenco». Il dialogo è un file suo — due passi e un conteggio non stanno in
 * una riga di tabella — e ce n'è UNO, non una copia per punto d'ingresso.
 *
 * ⚠️ E NON c'è più nessun `onLiberaSpazio` da passare dall'esterno. Era il punto
 * di estensione che ha prodotto il difetto: un `prop` opzionale che nessuno
 * passava e un ripiego che sembrava un comportamento. Un'operazione irreversibile
 * ha un gesto solo, scritto qui.
 *
 * Il filtro di RUOLO sul bottone è una CORTESIA — il gate vero è sul server, che
 * è l'unico che non si può aggirare dalla console del browser. Serve a non
 * offrire a una segretaria un comando che riceverà 403; e siccome `ruolo` arriva
 * da una fetch (`AdminIdentityProvider`), finché non è risolto vale la stringa
 * vuota e il comando NON compare: si sbaglia verso il nascondere, mai verso
 * l'offrire.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Archive, AlertTriangle, CheckCircle2, Eraser, Info, RotateCcw, Search, Undo2 } from 'lucide-react';
import { SectionTitle, TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit';
import { btnClass } from '@/components/ui/Btn';
import { LiberaSpazioDialog } from '@/components/features/admin/LiberaSpazioDialog';
import { HEADER_TOTALE, LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { RUOLI_LIBERA_SPAZIO } from '@/lib/alunni/archiviazione';
import { STATO_RITIRATO } from '@/lib/alunni/stato';
import { useSediAttive } from '@/lib/context/sede-context';
import { useDateFormat } from '@/lib/i18n/date';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import { cx } from '@/lib/ui/cx';

/**
 * I ruoli a cui l'interfaccia offre «Libera spazio». Il gate vero è sul server.
 *
 * ⚠️ L'ELENCO NON È SCRITTO QUI. Fino al 2026-08-13 questa riga ribatteva a mano
 * `['admin', 'coordinator']` e si dichiarava «cortesia, il gate vero è sul
 * server» — mentre il gate «vero» era l'unica cosa che nessun test misurava. Due
 * copie della stessa regola divergono in silenzio e in tutte e due le direzioni:
 * un comando offerto a chi prenderà 403, o un comando nascosto a chi ne ha
 * diritto. Nessuno dei due casi produce un errore che qualcuno vada a leggere.
 * La fonte è `@/lib/alunni/archiviazione`, la stessa che la rotta passa a
 * `requireStaff`.
 */
const RUOLI_DISTRUZIONE = new Set<string>(RUOLI_LIBERA_SPAZIO);

/**
 * La riga come la restituisce `admin/students:GET` — proiezione minima, più le
 * tre colonne dell'archiviazione, tutte OPZIONALI (vedi la testata).
 */
export interface AlunnoArchiviato {
    id: string;
    nome?: string | null;
    cognome?: string | null;
    data_nascita?: string | null;
    scuola_id?: string | null;
    stato?: string | null;
    archiviato_il?: string | null;
    archiviato_classe_sezione?: string | null;
    spazio_liberato_il?: string | null;
}

export interface EsitoAlunniArchiviati {
    fase: 'caricamento' | 'pronto' | 'errore';
    righe: AlunnoArchiviato[];
    /** Quanti ne ha contati il server (`X-Total-Count`): può superare `righe.length`. */
    totale: number;
    /** Una RILETTURA è in corso sopra un elenco già a schermo. */
    ricaricando: boolean;
    /** Una rilettura è FALLITA, sopra un elenco che era già stato letto. */
    riletturaFallita: boolean;
    errore: string | null;
    ricarica: () => void;
}

/** `true` quando il corpo ha la forma di una riga di questo elenco. */
function sembraUnaRiga(v: unknown): v is AlunnoArchiviato {
    return v !== null && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';
}

/**
 * L'ELENCO, una volta sola per pagina.
 *
 * ⚠️ NIENTE blocco `catch`, e il `try { … } finally { … }` RESTA: è la forma che
 * `react-hooks/set-state-in-effect` (qui è un ERRORE del gate) riconosce. Il ramo
 * d'errore vive su `.catch()` della promise e ritorna `null`; il motivo non si
 * perde, si logga. Stesso vincolo, misurato, di `useCodiciFiscaliDaVerificare` e
 * di `caricaElenco` in `/admin/students`.
 */
export function useAlunniArchiviati(): EsitoAlunniArchiviati {
    const { reFetchKey } = useSediAttive();
    const [fase, setFase] = useState<'caricamento' | 'pronto' | 'errore'>('caricamento');
    const [righe, setRighe] = useState<AlunnoArchiviato[]>([]);
    const [totale, setTotale] = useState(0);
    const [errore, setErrore] = useState<string | null>(null);
    const [ricaricando, setRicaricando] = useState(false);
    const [riletturaFallita, setRiletturaFallita] = useState(false);
    const [epoca, setEpoca] = useState(0);

    /** «A schermo c'è già un elenco letto per intero»: ref, non stato, per non rilanciare `carica`. */
    const giaCaricato = useRef(false);
    /** L'epoca della richiesta in corso: la risposta VECCHIA non deve vincere sulla nuova. */
    const ultimaRichiesta = useRef(0);

    const carica = useCallback(async () => {
        const mia = ultimaRichiesta.current + 1;
        ultimaRichiesta.current = mia;
        let motivo = '';
        // Il default è `errore`, non `pronto`: qualunque strada esca da qui senza
        // aver letto un elenco è un GUASTO. Un default ottimista trasformerebbe un
        // ramo dimenticato in «non c'è nessun bambino archiviato».
        let prossima: 'pronto' | 'errore' = 'errore';
        try {
            const res = await fetch(
                `/api/admin/students?stato=${encodeURIComponent(STATO_RITIRATO)}&limit=${LIMITE_ELENCO_ALUNNI}`,
                { headers: { 'x-sedi': reFetchKey } },
            ).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });
            if (mia !== ultimaRichiesta.current) return;

            if (res === null) {
                // La fetch non è mai arrivata: rete giù, DNS, CORS. È il caso che
                // nessun log del server vedrà mai.
                setErrore(null);
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: `alunni-archiviati-non-caricati: ${motivo}`,
                    route: '/admin/students',
                });
                return;
            }
            if (!res.ok) {
                const detto = await messaggioErrore(res, '');
                if (mia !== ultimaRichiesta.current) return;
                setErrore(detto);
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: 'alunni-archiviati-non-caricati',
                    route: '/admin/students', stato: res.status,
                });
                return;
            }
            const corpo: unknown = await res.json().catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });
            if (mia !== ultimaRichiesta.current) return;
            if (!Array.isArray(corpo)) {
                // 200 con un corpo che non è un elenco: è un GUASTO, non «non c'è
                // nessuno». Trattarlo come elenco vuoto direbbe «tutto a posto».
                setErrore(null);
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: `alunni-archiviati-corpo-inatteso: ${motivo || 'forma'}`,
                    route: '/admin/students', stato: res.status,
                });
                return;
            }
            const valide = (corpo as unknown[]).filter(sembraUnaRiga);
            // Righe SCARTATE = guasto, non «una in meno»: un rename di `id` nella
            // rotta le porterebbe a zero, e il pannello mostrerebbe il cartello
            // «Nessun bambino archiviato» — una buona notizia falsa.
            if (valide.length < (corpo as unknown[]).length) {
                setErrore(null);
                logClient({
                    livello: 'error', evento: 'fetch',
                    // I conteggi nel messaggio, non in campi propri: `EventoClient` ha
                    // uno schema chiuso, e sono numeri (nessun dato personale).
                    messaggio: `alunni-archiviati-righe-illeggibili: ${(corpo as unknown[]).length - valide.length} scartate su ${(corpo as unknown[]).length}`,
                    route: '/admin/students', stato: res.status,
                });
                return;
            }
            // `res.headers` con l'optional chaining: nei test la risposta è un
            // oggetto finto che spesso non ce l'ha, e un TypeError qui
            // trasformerebbe un elenco arrivato in un guasto.
            const dichiarato = Number(res.headers?.get?.(HEADER_TOTALE) ?? NaN);
            setRighe(valide);
            setTotale(Number.isFinite(dichiarato) ? dichiarato : valide.length);
            setErrore(null);
            setRiletturaFallita(false);
            giaCaricato.current = true;
            prossima = 'pronto';
        } finally {
            if (mia === ultimaRichiesta.current) {
                // Un guasto SOPRA un elenco già letto non cancella l'elenco: si dice
                // in una fascia d'allarme e i dati restano.
                const sopraUnElenco = prossima === 'errore' && giaCaricato.current;
                setFase(sopraUnElenco ? 'pronto' : prossima);
                setRiletturaFallita(sopraUnElenco);
                setRicaricando(false);
            }
        }
    }, [reFetchKey]);

    useEffect(() => {
        void carica();
    }, [carica, epoca]);

    /** Rileggere non è ricominciare: lo spinner a tutta pagina resta al PRIMO caricamento. */
    const ricarica = useCallback(() => {
        setErrore(null);
        setRicaricando(true);
        setFase((f) => (f === 'pronto' ? f : 'caricamento'));
        setEpoca((e) => e + 1);
    }, []);

    return { fase, righe, totale, ricaricando, riletturaFallita, errore, ricarica };
}

export interface AlunniArchiviatiViewProps {
    esito: EsitoAlunniArchiviati;
    /** Il ruolo di chi guarda: decide se «Libera spazio» compare. Cortesia, non gate. */
    ruolo?: string | null;
    /** Passa avanti l'identità nell'URL della scheda, come fa il resto del cockpit. */
    userId?: string | null;
}

export function AlunniArchiviatiView({ esito, ruolo, userId }: AlunniArchiviatiViewProps) {
    const t = useTranslations('adminStudents');
    const router = useRouter();
    const { sedi } = useSediAttive();
    const { dataBreve } = useDateFormat();

    const [cerca, setCerca] = useState('');
    /**
     * Il bambino su cui è aperto il riquadro di «Libera spazio». `null` = chiuso.
     *
     * È la RIGA e non il solo id: il dialogo mostra il nominativo mentre il suo
     * dry-run è ancora in volo, e con il solo id l'intestazione resterebbe vuota
     * proprio nell'istante in cui l'operatore vuole sapere su chi sta decidendo.
     */
    const [daLiberare, setDaLiberare] = useState<AlunnoArchiviato | null>(null);
    /** L'esito dell'ultima riattivazione: `null` = non è ancora stato fatto niente. */
    const [messaggio, setMessaggio] = useState<{ tipo: 'ok' | 'errore'; testo: string } | null>(null);
    /** Su quale riga è in volo la riattivazione: serve solo all'etichetta del comando. */
    const [inVolo, setInVolo] = useState<string | null>(null);
    /**
     * LA GUARDIA DI RIENTRO, e perché è un `ref` e non lo stato: due click nello
     * STESSO tick leggono tutti e due lo stato vecchio e partono tutte e due. Il
     * ref cambia valore subito, nello stesso giro di eventi.
     */
    const inVoloRef = useRef<string | null>(null);
    /** Dove torna il fuoco quando il comando sparisce da sotto le dita. */
    const messaggioRef = useRef<HTMLParagraphElement>(null);

    const nominativo = useCallback(
        (r: AlunnoArchiviato) =>
            [r.cognome, r.nome].filter((v) => typeof v === 'string' && v !== '').join(' ') || t('arcSenzaNome'),
        [t],
    );

    // La colonna «Sede» compare solo quando le sedi attive sono più d'una: con un
    // plesso solo ripeterebbe la stessa parola su ogni riga.
    const mostraSede = sedi.length > 1;
    const nomeSede = useCallback(
        (id: string | null | undefined) =>
            (typeof id === 'string' ? sedi.find((s) => s.id === id)?.nome : undefined) ?? t('arcSedeSconosciuta'),
        [sedi, t],
    );

    const visibili = useMemo(() => {
        const testo = cerca.trim().toLowerCase();
        const filtrate =
            testo === ''
                ? [...esito.righe]
                : esito.righe.filter((r) =>
                      [r.cognome, r.nome].some((c) => typeof c === 'string' && c.toLowerCase().includes(testo)),
                  );
        return filtrate.sort((a, b) => {
            const cognomi = (a.cognome ?? '').localeCompare(b.cognome ?? '', 'it');
            if (cognomi !== 0) return cognomi;
            const nomi = (a.nome ?? '').localeCompare(b.nome ?? '', 'it');
            return nomi !== 0 ? nomi : a.id.localeCompare(b.id);
        });
    }, [esito.righe, cerca]);

    const apriScheda = useCallback(
        (r: AlunnoArchiviato) => {
            const qs = new URLSearchParams({ kind: 'child' });
            if (userId) qs.set('userId', userId);
            router.push(`/admin/students/${r.id}?${qs.toString()}`);
        },
        [router, userId],
    );

    const riattiva = useCallback(
        async (r: AlunnoArchiviato) => {
            // ⚠️ PRIMA di qualunque altra cosa: un secondo click mentre la POST è in
            // volo non deve produrre una seconda POST.
            if (inVoloRef.current !== null) return;
            inVoloRef.current = r.id;
            setInVolo(r.id);
            setMessaggio(null);
            let motivo = '';
            try {
                const res = await fetch('/api/admin/students/riattiva', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ alunno_id: r.id }),
                }).catch((e: unknown) => {
                    motivo = nomeErrore(e);
                    return null;
                });

                if (res === null) {
                    setMessaggio({ tipo: 'errore', testo: t('arcErroreRiattivazione') });
                    logClient({
                        livello: 'error', evento: 'fetch',
                        messaggio: `alunno-non-riattivato: ${motivo}`,
                        route: '/admin/students',
                    });
                    return;
                }
                if (!res.ok) {
                    setMessaggio({ tipo: 'errore', testo: await messaggioErrore(res, t('arcErroreRiattivazione')) });
                    logClient({
                        livello: 'error', evento: 'fetch',
                        messaggio: 'alunno-non-riattivato',
                        route: '/admin/students', stato: res.status,
                    });
                    return;
                }
                // ⚠️ IL MOTIVO NON SI BUTTA VIA. Era `.catch(() => null)` nudo — un
                // `catch` muto in un file NUOVO, cioè AGENTS.md regola 6 — e
                // l'effetto era concreto: un 200 con un corpo non parsabile faceva
                // cadere le tre frasi sull'ultimo ramo e diceva «assegna una classe»
                // a un bambino di cui non si sapeva niente, senza una riga di log. La
                // disciplina giusta era già a duecento righe di distanza, dentro
                // `useAlunniArchiviati` (`alunni-archiviati-corpo-inatteso`).
                let motivoCorpo = '';
                const corpo = (await res.json().catch((e: unknown) => {
                    motivoCorpo = nomeErrore(e);
                    return null;
                })) as
                    | { esito_classe?: string; classe_sezione?: string | null; classe_mancante?: string | null; gruppo_mensa_da_riassegnare?: boolean; spazio_gia_liberato?: boolean }
                    | null;
                const nome = nominativo(r);
                if (corpo === null) {
                    // Il ritorno è RIUSCITO (il server ha risposto 200): dirlo è
                    // giusto. Ciò che non si sa è la sorte della CLASSE, e su quella
                    // si tace invece di inventare un gesto da fare.
                    logClient({
                        livello: 'error', evento: 'fetch',
                        messaggio: `alunno-riattivato-corpo-inatteso: ${motivoCorpo || 'forma'}`,
                        route: '/admin/students', stato: res.status,
                    });
                }
                /**
                 * QUATTRO ESITI, non tre, e ognuno porta a un gesto diverso: nessuno,
                 * «assegna una classe», «assegnane una nuova perché quella di prima
                 * non c'è più».
                 *
                 * ⚠️ Si legge `esito_classe` e non più `classe_ripristinata`, che era
                 * un booleano che MENTIVA sul caso più comune: sul ritiro fatto a mano
                 * dalla tendina — dove la classe non è mai stata tolta — la rotta
                 * rispondeva `false` con `classe_sezione: '2 ANNI'`, e qui si cadeva
                 * sull'ultimo ramo dicendo «Assegna una classe dalla sua scheda» a un
                 * bambino che era in «2 ANNI». `conservata` è quel caso, e non chiede
                 * niente a nessuno.
                 */
                const esitoClasse = typeof corpo?.esito_classe === 'string' ? corpo.esito_classe : null;
                const testo =
                    (esitoClasse === 'ripristinata' || esitoClasse === 'conservata') && typeof corpo?.classe_sezione === 'string'
                        ? t('arcEsitoRientrato', { nome, classe: corpo.classe_sezione })
                        : esitoClasse === 'sparita' && typeof corpo?.classe_mancante === 'string' && corpo.classe_mancante !== ''
                          ? t('arcEsitoRientratoSenzaClasse', { nome, classe: corpo.classe_mancante })
                          : esitoClasse === 'assente'
                            ? t('arcEsitoRientratoNessunaClasse', { nome })
                            // Corpo assente o `esito_classe` sconosciuto: si annuncia il
                            // ritorno e basta. Mandare a «assegnare una classe» chi
                            // magari ce l'ha è il difetto che questo ramo esiste per
                            // non ripetere.
                            : t('arcEsitoRientratoSemplice', { nome });
                // Le due code sono ADDITIVE e indipendenti: il gruppo mensa non torna
                // mai (`archivia` lo azzera e nessuna colonna lo ricorda), e foto e
                // messaggi non tornano se «libera spazio» è già passato. Chi ha la
                // famiglia davanti deve poter dire tutte e due le cose.
                const code = [
                    corpo?.gruppo_mensa_da_riassegnare === true ? t('arcEsitoMensaDaRiassegnare') : '',
                    corpo?.spazio_gia_liberato === true ? t('arcEsitoSpazioGiaLiberato') : '',
                ].filter((c) => c !== '');
                setMessaggio({ tipo: 'ok', testo: [testo, ...code].join(' ') });
                // La riga esce da questo elenco: l'unica cosa che resta vera su quel
                // bambino, qui, è l'esito qui sopra.
                esito.ricarica();
            } finally {
                inVoloRef.current = null;
                setInVolo(null);
            }
        },
        [esito, nominativo, t],
    );

    /**
     * IL FUOCO NON CADE SUL VUOTO. Appena la riattivazione riesce, la riga sparisce
     * e con lei il bottone che era stato premuto: chi naviga da tastiera si
     * ritroverebbe con `document.activeElement` su `<body>`, cioè all'inizio della
     * pagina e senza sapere com'è andata. Il fuoco va sull'esito.
     */
    useEffect(() => {
        if (messaggio !== null) messaggioRef.current?.focus();
    }, [messaggio]);

    /* ── Caricamento ────────────────────────────────────────────────────────── */
    if (esito.fase === 'caricamento') {
        return (
            <div role="status" className="flex min-h-[40vh] flex-1 flex-col items-center justify-center gap-4">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-kidville-green/30 border-t-kidville-green" />
                <p className="font-maven text-kidville-sub">{t('arcCaricamento')}</p>
            </div>
        );
    }

    /* ── L'elenco non è arrivato ────────────────────────────────────────────── */
    if (esito.fase === 'errore') {
        return (
            <div role="alert" className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error-strong">
                    <AlertTriangle size={34} strokeWidth={1.8} />
                </div>
                <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('arcErroreTitolo')}</h2>
                <p className="font-maven mt-1 max-w-md text-sm text-kidville-sub">{esito.errore || t('arcErroreTesto')}</p>
                <button type="button" onClick={esito.ricarica} className={btnClass('primary', 'sm', 'mt-4')}>
                    <RotateCcw size={15} strokeWidth={2} /> {t('arcRiprova')}
                </button>
            </div>
        );
    }

    const parziale = esito.totale > esito.righe.length;
    const puoLiberare = RUOLI_DISTRUZIONE.has(ruolo ?? '');

    return (
        <div className="flex flex-col">
            <div className="mb-4 rounded-card bg-kidville-white p-4 shadow-sm">
                <SectionTitle icon={Archive} title={t('arcTitolo')} sub={t('arcSottotitolo')} />

                {/* COSA RESTA E COSA SE NE VA, prima di ogni comando: un elenco di
                    distruzioni senza il suo contrappeso è metà informazione. */}
                <p className="mb-3 font-maven text-[13px] text-kidville-sub">{t('arcSpiegazione')}</p>

                {/* L'automa della retention è un FATTO, non un difetto, e va detto a
                    chi archivia: entro 24 ore il motivo dell'assenza scritto dalle
                    famiglie sparisce. È già promesso nell'informativa privacy. */}
                <p className="mb-3 flex items-start gap-2 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                    <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {t('arcAvvisoMotivoAssenza')}
                </p>

                {esito.riletturaFallita && (
                    <div
                        role="alert"
                        className="mb-3 flex flex-wrap items-center gap-2 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong"
                    >
                        <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
                        <span className="flex-1">{esito.errore || t('arcRiletturaFallita')}</span>
                        <button type="button" onClick={esito.ricarica} className={btnClass('ghost', 'sm')}>
                            <RotateCcw size={14} strokeWidth={2} /> {t('arcRiprova')}
                        </button>
                    </div>
                )}

                {esito.ricaricando && (
                    <p aria-live="polite" className="mb-3 flex items-center gap-2 font-maven text-[13px] text-kidville-sub">
                        <RotateCcw size={14} className="animate-spin" aria-hidden="true" />
                        {t('arcRicaricando')}
                    </p>
                )}

                {/* Un elenco troncato presentato come completo è una bugia
                    silenziosa: il server dichiara il totale, e qui si dice. */}
                {parziale && (
                    <p
                        role="status"
                        className="mb-3 flex items-start gap-2 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong"
                    >
                        <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                        {t('arcParziale')}
                    </p>
                )}

                <label className="relative block w-full">
                    <span className="sr-only">{t('arcCercaEtichetta')}</span>
                    <Search
                        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub"
                        size={18}
                        aria-hidden="true"
                    />
                    <input
                        type="search"
                        value={cerca}
                        onChange={(e) => setCerca(e.target.value)}
                        placeholder={t('arcCerca')}
                        className="w-full rounded-input border-2 border-kidville-line py-2.5 pl-10 pr-4 font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:outline-none focus:ring-2 focus:ring-kidville-green/15"
                    />
                </label>
            </div>

            {/* L'ESITO DELL'ULTIMA RIATTIVAZIONE, sopra la tabella e con il fuoco
                sopra: è l'unica cosa vera rimasta a schermo su un bambino che è
                appena uscito dall'elenco. */}
            {messaggio !== null && (
                <p
                    ref={messaggioRef}
                    role={messaggio.tipo === 'ok' ? 'status' : 'alert'}
                    // `tabIndex={-1}`: non entra nella tabulazione, ma può RICEVERE il
                    // fuoco. È il punto stabile su cui atterrare quando la riga sparisce.
                    tabIndex={-1}
                    className={cx(
                        'mb-4 rounded-input px-3 py-2.5 font-maven text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-kidville-green',
                        messaggio.tipo === 'ok'
                            ? 'bg-kidville-success-soft text-kidville-success-strong'
                            : 'bg-kidville-error-soft text-kidville-error-strong',
                    )}
                >
                    {messaggio.testo}
                </p>
            )}

            {esito.righe.length === 0 ? (
                <div className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-success-soft text-kidville-success-strong">
                        <CheckCircle2 size={34} strokeWidth={1.8} />
                    </div>
                    <h3 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('arcVuotoTitolo')}</h3>
                    <p className="font-maven mt-1 max-w-md text-sm text-kidville-sub">{t('arcVuotoTesto')}</p>
                </div>
            ) : visibili.length === 0 ? (
                /* La ricerca non trova niente ≠ non c'è nessun archiviato. */
                <div className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <h3 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('arcFiltriVuotoTitolo')}</h3>
                    <p className="font-maven mt-1 max-w-md text-sm text-kidville-sub">{t('arcFiltriVuotoTesto')}</p>
                </div>
            ) : (
                <div className="rounded-card bg-kidville-white p-4 shadow-sm">
                    <p aria-live="polite" className="mb-3 font-maven text-[13px] text-kidville-sub">
                        {t('arcConteggio', { n: visibili.length })}
                    </p>
                    <div className={TABLE_WRAP}>
                        <table className={TABLE}>
                            <caption className="sr-only">{t('arcTabellaDidascalia')}</caption>
                            <thead>
                                <tr>
                                    <th scope="col" className={TH}>{t('arcColPersona')}</th>
                                    <th scope="col" className={TH}>{t('arcColNascita')}</th>
                                    {mostraSede && <th scope="col" className={TH}>{t('arcColSede')}</th>}
                                    <th scope="col" className={TH}>{t('arcColEraIn')}</th>
                                    <th scope="col" className={TH}>{t('arcColArchiviatoIl')}</th>
                                    <th scope="col" className={TH}>{t('arcColComandi')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibili.map((r) => {
                                    const eraIn = typeof r.archiviato_classe_sezione === 'string' && r.archiviato_classe_sezione !== ''
                                        ? r.archiviato_classe_sezione
                                        : null;
                                    const quando = typeof r.archiviato_il === 'string' ? dataBreve(r.archiviato_il) : '';
                                    const nascita = typeof r.data_nascita === 'string' ? dataBreve(r.data_nascita) : '';
                                    return (
                                        <tr key={r.id} className={TROW}>
                                            <td className={cx(TD, 'font-maven text-sm font-semibold text-kidville-ink')}>
                                                {nominativo(r)}
                                                {/* Il badge dice un fatto IRREVERSIBILE, e va detto in
                                                    parole oltre che col colore: foto, video e messaggi
                                                    di questo bambino non ci sono più. */}
                                                {r.spazio_liberato_il != null && (
                                                    <span className="ml-2 inline-flex items-center gap-1 rounded-pill bg-kidville-neutral-soft px-2 py-0.5 font-barlow text-[11px] font-extrabold uppercase tracking-[0.03em] text-kidville-sub">
                                                        <Eraser size={12} strokeWidth={2.2} aria-hidden="true" />
                                                        {t('arcBadgeSpazioLiberato')}
                                                    </span>
                                                )}
                                            </td>
                                            <td className={cx(TD, 'font-maven text-sm text-kidville-sub')}>
                                                {nascita || t('arcSenzaData')}
                                            </td>
                                            {mostraSede && (
                                                <td className={cx(TD, 'font-maven text-sm text-kidville-sub')}>
                                                    {nomeSede(r.scuola_id)}
                                                </td>
                                            )}
                                            <td className={cx(TD, 'font-maven text-sm text-kidville-ink')}>
                                                {eraIn ?? <span className="text-kidville-sub">{t('arcSenzaClasse')}</span>}
                                            </td>
                                            <td className={cx(TD, 'font-maven text-sm text-kidville-sub')}>
                                                {quando || t('arcSenzaData')}
                                            </td>
                                            <td className={TD}>
                                                <div className="flex flex-wrap gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => void riattiva(r)}
                                                        // `aria-disabled`, NON `disabled`: marcarlo spegne
                                                        // il fuoco, che in Chrome torna su `<body>`. Il
                                                        // doppio invio lo ferma `inVoloRef`, che è sincrona.
                                                        aria-disabled={inVolo !== null}
                                                        className={btnClass('primary', 'sm')}
                                                    >
                                                        <Undo2 size={14} strokeWidth={2} aria-hidden="true" />
                                                        {inVolo === r.id ? t('arcAzioneRiattivaInCorso') : t('arcAzioneRiattiva')}
                                                    </button>
                                                    {puoLiberare && (
                                                        <button
                                                            type="button"
                                                            onClick={() => setDaLiberare(r)}
                                                            className={btnClass('ghost', 'sm')}
                                                        >
                                                            <Eraser size={14} strokeWidth={2} aria-hidden="true" />
                                                            {t('arcAzioneLiberaSpazio')}
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => apriScheda(r)}
                                                        className={btnClass('ghost', 'sm')}
                                                    >
                                                        {t('arcAzioneApriScheda')}
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* IL RIQUADRO DI «LIBERA SPAZIO», montato UNA volta per la vista e non
                una per riga: un dialogo per riga vorrebbe dire N conteggi in volo e
                N stati da tenere allineati. Il bambino su cui è aperto è `daLiberare`.

                `onLiberato` rilegge l'elenco perché la riga NON esce di qui — resta
                fra i «non più iscritti» — ma cambia: prende il badge «Spazio
                liberato», che è l'unica cosa a schermo che dica che foto, video e
                messaggi non ci sono più. */}
            <LiberaSpazioDialog
                alunno={daLiberare}
                onChiudi={() => setDaLiberare(null)}
                onLiberato={esito.ricarica}
            />
        </div>
    );
}
