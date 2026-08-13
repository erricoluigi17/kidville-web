'use client';

/**
 * «LIBERA SPAZIO» — la conferma in due passi del secondo tempo del modello.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PERCHÉ QUESTO FILE È NATO DOPO GLI ALTRI, E CHE COSA CHIUDE
 *
 * La rotta `POST /api/admin/students/libera-spazio`, il suo motore, il suo
 * dry-run e i suoi test esistevano dal 2026-08-12. **Non li chiamava nessuno.**
 * `grep -rn "libera-spazio" src/` non trovava una sola `fetch`: il bottone
 * «Libera spazio» dell'elenco «non più iscritti» portava alla scheda del
 * bambino, dove non c'era niente, e la testata del componente affermava che «quella
 * schermata vive sulla scheda del bambino» — una promessa a vuoto. Peggio: la riga
 * stampata in cima alla linguetta diceva all'operatore che «con «Libera spazio» se
 * ne vanno foto, video e messaggi», cioè vendeva una capacità che il prodotto non
 * aveva; e un test certificava il vicolo cieco come comportamento corretto.
 *
 * Questo file è quella schermata. Non sta sulla scheda dell'alunno ma **accanto
 * all'elenco**, che è dove il modello del titolare dice che l'operazione comincia:
 * «LIBERA SPAZIO, solo da quell'elenco».
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DUE PASSI, PERCHÉ NON ESISTE UN ANNULLA
 *
 *  1. si CONTA (`mode: 'dryrun'`): sole SELECT, nessuna scrittura. È l'unico
 *     momento in cui l'operatore sa che cosa sta per sparire, e per questo un
 *     conteggio non arrivato NON diventa uno zero — diventa un rifiuto a
 *     procedere. Un conteggio inventato è una conferma inventata.
 *  2. si DIGITA il nominativo e si esegue (`mode: 'execute'`). Non un secondo
 *     click: un click si dà anche per sbaglio.
 *
 * ⚠️ IL CONFRONTO DEL NOMINATIVO NON SI RIFÀ QUI. Lo fa `confermaValida`
 * (`@/lib/gdpr/anonimizza`), sul server, che è l'unico lato che non si aggira
 * dalla console del browser. Ricopiarlo nel client sarebbe una seconda copia
 * della stessa regola — libera di divergere — e la divergenza avrebbe la forma
 * peggiore: un bottone che si accende su un nome che il server poi rifiuta,
 * oppure che resta spento su uno che avrebbe accettato. Qui si guarda soltanto
 * che il campo non sia VUOTO (che non è la regola: è «non hai ancora scritto
 * niente») e per il resto si mostra il verdetto del server,
 * `SPAZIO_CONFERMA_NON_VALIDA`, già tradotto nel catalogo.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'ESITO PARZIALE NON È UN SUCCESSO, E SI DEVE VEDERE
 *
 * `parziale: true` vuol dire che un file non è uscito dall'archivio o che un
 * messaggio non è stato cancellato: il timestamp NON viene scritto, la riga resta
 * in elenco e l'operazione si ripete. Presentarlo come «fatto» toglierebbe dagli
 * occhi di tutti un bambino le cui foto sono ancora là dentro — ed è la ragione
 * per cui il motore quel timestamp non lo scrive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Eraser, Info, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { btnClass } from '@/components/ui/Btn';
import { useDateFormat } from '@/lib/i18n/date';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import { cx } from '@/lib/ui/cx';
import type { ContiSpazio, EsitoSpazio } from '@/lib/alunni/libera-spazio';

/**
 * I due contratti arrivano dal MOTORE, con `import type`.
 *
 * Non è un vezzo: `ContiSpazio` ed `EsitoSpazio` sono ciò che la rotta serializza,
 * e riscriverli qui a mano ne farebbe una seconda copia — che il giorno in cui il
 * motore aggiunge un conteggio resterebbe indietro **in silenzio**, perché in
 * TypeScript un campo mancante in un tipo di risposta non è un errore: è un campo
 * che il pannello smette di mostrare. `import type` viene cancellato in
 * compilazione, quindi del modulo server (Supabase, `@/lib/gdpr/esegui`) non
 * finisce una riga nel bundle del browser.
 */
export interface RispostaDryRun extends ContiSpazio {
    dryrun: true;
    spazio_liberato_il: string | null;
    nominativo_conferma: string;
    non_tocca: { tabelle: string[]; bucket: string[] };
}

type RispostaEsecuzione = EsitoSpazio & { ok: true };

/** Il minimo che serve per nominare un bambino e chiamare la rotta. */
export interface AlunnoDaLiberare {
    id: string;
    nome?: string | null;
    cognome?: string | null;
}

export interface LiberaSpazioDialogProps {
    /** Il bambino su cui si sta decidendo. `null` = il dialogo è chiuso. */
    alunno: AlunnoDaLiberare | null;
    onChiudi: () => void;
    /** Lo spazio è stato liberato davvero: l'elenco va riletto (cambia il badge). */
    onLiberato: () => void;
}

/** Le fasi del dialogo. `conteggio` è quella d'ingresso: si conta prima di offrire. */
type Fase = 'conteggio' | 'pronto' | 'conteggio-fallito' | 'esecuzione' | 'fatto';

export function LiberaSpazioDialog({ alunno, onChiudi, onLiberato }: LiberaSpazioDialogProps) {
    const t = useTranslations('adminStudents');
    const { dataBreve } = useDateFormat();

    const [fase, setFase] = useState<Fase>('conteggio');
    const [conti, setConti] = useState<RispostaDryRun | null>(null);
    const [esito, setEsito] = useState<RispostaEsecuzione | null>(null);
    /**
     * L'errore, in TRE valori e non due, perché tre sono i casi veri:
     *  · `null`  → non è andato storto niente;
     *  · `''`    → è andato storto, e il server non ha detto perché (rete giù,
     *              corpo illeggibile): il ripiego tradotto si sceglie a render;
     *  · testo   → il motivo del server, già tradotto dal catalogo dei codici.
     *
     * ⚠️ Qui dentro non finisce MAI una frase di catalogo. Non è una preferenza:
     * è il vincolo che tiene questo componente fuori da un ciclo infinito — vedi
     * la testata di `conta`.
     */
    const [errore, setErrore] = useState<string | null>(null);
    const [digitato, setDigitato] = useState('');

    /**
     * LA GUARDIA DI RIENTRO, e perché è un `ref` e non lo stato: due click nello
     * STESSO tick leggono tutti e due lo stato vecchio e partono tutti e due. Su
     * un'operazione senza annulla, la seconda POST arriverebbe su un archivio già
     * svuotato e scriverebbe una seconda riga di registro per un lavoro mai fatto.
     */
    const inVoloRef = useRef(false);
    /** L'epoca della richiesta in corso: la risposta VECCHIA non vince sulla nuova. */
    const ultimaRichiesta = useRef(0);
    /** Dove va il fuoco quando il dialogo cambia stato sotto le dita. */
    const esitoRef = useRef<HTMLDivElement>(null);

    const alunnoId = alunno?.id ?? null;

    /**
     * ⚠️ IL RIQUADRO SI AZZERA QUANDO CAMBIA BAMBINO, E LO FA IN FASE DI RENDER.
     *
     * Il dialogo è montato UNA volta per la vista: aprirlo su un altro nome non lo
     * rimonta, quindi senza questo blocco il conteggio del bambino PRECEDENTE
     * resterebbe a schermo mentre il nuovo è ancora in volo — il numero sbagliato
     * sopra la conferma di un'operazione che non ha un annulla. E il nominativo da
     * digitare verrebbe da `conti.nominativo_conferma`, cioè dall'altro bambino.
     *
     * ⚠️ NON in un `useEffect`, e non è una preferenza di stile: `setState` diretto
     * nel corpo di un effetto è un ERRORE del gate in questo repo
     * (`react-hooks/set-state-in-effect`) e produce un render in più con i dati
     * vecchi già dipinti. Questa è la forma che React documenta per «azzerare lo
     * stato quando cambia una prop»: si confronta col valore precedente durante il
     * render, si aggiorna, e React ricomincia il render PRIMA di toccare il DOM —
     * quindi il conteggio vecchio non arriva mai sullo schermo.
     *
     * ⚠️ E NON è affidato a una `key` sul punto di montaggio, che pure funzionava:
     * una regola che vive fuori dal componente è una regola che il prossimo punto
     * di montaggio può dimenticare, in silenzio e senza rendere rosso niente
     * (misurato: togliendo la `key`, tutti i test del pannello restavano verdi).
     * Qui la proprietà è del componente, e ha un test suo.
     */
    const [alunnoMostrato, setAlunnoMostrato] = useState(alunnoId);
    if (alunnoId !== alunnoMostrato) {
        setAlunnoMostrato(alunnoId);
        setFase('conteggio');
        setConti(null);
        setEsito(null);
        setErrore(null);
        setDigitato('');
    }

    /**
     * IL CONTEGGIO, all'apertura.
     *
     * ⚠️ NIENTE blocco `catch`, e il `try { … } finally { … }` RESTA: è la forma
     * che `react-hooks/set-state-in-effect` (un ERRORE del gate, non un warning)
     * riconosce. Il ramo d'errore vive su `.catch()` della promise e ritorna
     * `null`; il motivo non si perde, si logga. Stesso vincolo, misurato, di
     * `useAlunniArchiviati` qui accanto.
     *
     * ⚠️ E `t` NON STA FRA LE DIPENDENZE, per una ragione misurata e non estetica.
     * `useTranslations` non promette di restituire la stessa funzione a ogni
     * render — nel doppio finto dei test ne restituisce una nuova ogni volta. Con
     * `t` fra le dipendenze, `conta` cambierebbe identità a ogni render, l'effetto
     * che la invoca ripartirebbe, il `setFase` finale farebbe rendere di nuovo, e
     * il pannello girerebbe all'infinito **sparando una POST di dry-run per giro**.
     * Perciò qui dentro non si nomina nessuna stringa di catalogo: gli errori si
     * conservano come motivo del server (o stringa vuota) e il ripiego tradotto si
     * sceglie al momento di rendere, dove costa nulla.
     */
    const conta = useCallback(async () => {
        if (!alunnoId) return;
        const mia = ultimaRichiesta.current + 1;
        ultimaRichiesta.current = mia;
        let motivo = '';
        // Il default è il RIFIUTO, non «pronto»: qualunque strada esca da qui
        // senza aver letto un conteggio deve fermare l'operatore. Un default
        // ottimista trasformerebbe un ramo dimenticato in «non c'è niente da
        // togliere», che è la bugia peggiore davanti a un pulsante senza annulla.
        let prossima: Fase = 'conteggio-fallito';
        try {
            const res = await fetch('/api/admin/students/libera-spazio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunno_id: alunnoId, mode: 'dryrun' }),
            }).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });
            if (mia !== ultimaRichiesta.current) return;

            if (res === null) {
                // La fetch non è mai arrivata: rete giù, DNS, CORS. È il caso che
                // nessun log del server vedrà mai.
                setErrore('');
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: `libera-spazio-conteggio-non-arrivato: ${motivo}`,
                    route: '/admin/students',
                });
                return;
            }
            if (!res.ok) {
                // `''` come ripiego: la frase di catalogo si sceglie a render, e il
                // 503 `ARCHIVIO_NON_DISPONIBILE` del DB non migrato arriva qui col
                // suo testo — «applica la migrazione», non «riprova fra un minuto».
                setErrore(await messaggioErrore(res, ''));
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: 'libera-spazio-conteggio-rifiutato',
                    route: '/admin/students', stato: res.status,
                });
                return;
            }
            const corpo = (await res.json().catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            })) as RispostaDryRun | null;
            if (mia !== ultimaRichiesta.current) return;
            // Il nominativo da digitare è la CHIAVE della conferma: senza, il
            // riquadro chiederebbe di ricopiare una stringa che non mostra.
            if (corpo === null || typeof corpo.nominativo_conferma !== 'string') {
                setErrore('');
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: `libera-spazio-conteggio-illeggibile: ${motivo || 'forma'}`,
                    route: '/admin/students', stato: res.status,
                });
                return;
            }
            setConti(corpo);
            setErrore(null);
            prossima = 'pronto';
        } finally {
            if (mia === ultimaRichiesta.current) setFase(prossima);
        }
    }, [alunnoId]);

    useEffect(() => {
        if (!alunnoId) return;
        void conta();
    }, [alunnoId, conta]);

    /**
     * IL FUOCO NON CADE SUL VUOTO. A operazione finita il campo e il comando
     * spariscono: chi naviga da tastiera si ritroverebbe con `activeElement` su
     * `<body>`, cioè fuori dal dialogo e senza sapere com'è andata.
     */
    useEffect(() => {
        if (fase === 'fatto' || fase === 'conteggio-fallito') esitoRef.current?.focus();
    }, [fase]);

    const esegui = useCallback(async () => {
        if (!alunnoId || inVoloRef.current) return;
        inVoloRef.current = true;
        setFase('esecuzione');
        setErrore(null);
        let motivo = '';
        try {
            const res = await fetch('/api/admin/students/libera-spazio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunno_id: alunnoId, mode: 'execute', confirm: digitato }),
            }).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });

            if (res === null) {
                setErrore('');
                setFase('pronto');
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: `libera-spazio-non-eseguito: ${motivo}`,
                    route: '/admin/students',
                });
                return;
            }
            if (!res.ok) {
                // Il verdetto sul nominativo è del server: qui si mostra, tradotto
                // dal catalogo (`SPAZIO_CONFERMA_NON_VALIDA`), e si resta sul passo
                // della conferma con quello che l'operatore aveva già scritto.
                setErrore(await messaggioErrore(res, ''));
                setFase('pronto');
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: 'libera-spazio-rifiutato',
                    route: '/admin/students', stato: res.status,
                });
                return;
            }
            const corpo = (await res.json().catch(() => null)) as RispostaEsecuzione | null;
            // Un 200 con un corpo illeggibile NON è un fallimento dell'operazione:
            // il lavoro sul server è già stato fatto. Si dichiara riuscito senza
            // conteggi (l'elenco li rimostrerà col badge) invece di far ripremere
            // un pulsante che ripeterebbe una distruzione già avvenuta.
            setEsito(corpo);
            setFase('fatto');
            onLiberato();
        } finally {
            inVoloRef.current = false;
        }
        // `t` NON sta fra le dipendenze — e qui dentro non si nomina nessuna
        // stringa di catalogo, per la stessa ragione scritta sopra `conta`:
        // `useTranslations` non promette la stessa identità a ogni render.
    }, [alunnoId, digitato, onLiberato]);

    if (!alunno) return null;

    const nominativo =
        conti?.nominativo_conferma ??
        [alunno.cognome, alunno.nome].filter((v) => typeof v === 'string' && v !== '').join(' ').toUpperCase();

    /** Le voci del «se ne vanno», con il loro conteggio. Le righe a zero non si mostrano. */
    const viaVia: string[] = conti
        ? [
              conti.foto_sole_sue > 0 ? t('spzViaFoto', { n: conti.foto_sole_sue }) : null,
              conti.video_soli_suoi > 0 ? t('spzViaVideo', { n: conti.video_soli_suoi }) : null,
              conti.media_di_gruppo > 0 ? t('spzViaGruppo', { n: conti.media_di_gruppo }) : null,
              conti.messaggi > 0 ? t('spzViaMessaggi', { n: conti.messaggi }) : null,
              conti.allegati > 0 ? t('spzViaAllegati', { n: conti.allegati }) : null,
              conti.articoli_pubblici > 0 ? t('spzViaArticoli', { n: conti.articoli_pubblici }) : null,
          ].filter((v): v is string => v !== null)
        : [];

    return (
        <Modal
            open
            onClose={onChiudi}
            title={t('spzTitolo')}
            labelledBy="libera-spazio-titolo"
            // Non si chiude cliccando fuori: da qui parte l'unica operazione senza
            // annulla del modello, e un click distratto sullo sfondo non deve
            // buttare via un nominativo appena digitato.
            closeOnBackdrop={false}
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl"
        >
            <div className="mb-4 flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error-strong">
                    <Eraser size={22} strokeWidth={1.9} aria-hidden="true" />
                </div>
                <div className="min-w-0">
                    <h2 id="libera-spazio-titolo" className="font-barlow text-lg font-bold uppercase text-kidville-green">
                        {t('spzTitolo')}
                    </h2>
                    <p className="font-maven truncate text-sm text-kidville-sub">{nominativo}</p>
                </div>
            </div>

            {/* ── Il conteggio è in volo ─────────────────────────────────────── */}
            {fase === 'conteggio' && (
                <p role="status" className="flex items-center gap-2 py-6 font-maven text-sm text-kidville-sub">
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                    {t('spzConteggioInCorso')}
                </p>
            )}

            {/* ── Il conteggio NON è arrivato: non si offre niente ────────────── */}
            {fase === 'conteggio-fallito' && (
                <>
                    <div
                        ref={esitoRef}
                        role="alert"
                        tabIndex={-1}
                        className="rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong outline-none focus-visible:ring-2 focus-visible:ring-kidville-green"
                    >
                        {errore || t('spzErroreConteggio')}
                    </div>
                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                        <button type="button" onClick={onChiudi} className={btnClass('ghost', 'sm')}>
                            {t('spzChiudi')}
                        </button>
                        <button type="button" onClick={() => void conta()} className={btnClass('primary', 'sm')}>
                            <RotateCcw size={14} strokeWidth={2} aria-hidden="true" /> {t('spzRiprova')}
                        </button>
                    </div>
                </>
            )}

            {/* ── Il riquadro di decisione ────────────────────────────────────── */}
            {(fase === 'pronto' || fase === 'esecuzione') && conti && (
                <>
                    {conti.spazio_liberato_il != null && (
                        <p className="mb-3 flex items-start gap-2 rounded-input bg-kidville-neutral-soft px-3 py-2.5 font-maven text-[13px] text-kidville-sub">
                            <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                            {t('spzGiaLiberatoIl', { data: dataBreve(conti.spazio_liberato_il) })}
                        </p>
                    )}

                    <h3 className="font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-error-strong">
                        {t('spzViaTitolo')}
                    </h3>
                    {viaVia.length === 0 ? (
                        <p className="mt-1 font-maven text-[13px] text-kidville-sub">{t('spzNienteDaTogliere')}</p>
                    ) : (
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 font-maven text-[13px] text-kidville-ink">
                            {viaVia.map((voce) => (
                                <li key={voce}>{voce}</li>
                            ))}
                        </ul>
                    )}

                    {/* Il contrappeso, sempre: un elenco di distruzioni senza ciò che
                        resta è metà informazione, e su questa metà si decide. */}
                    <h3 className="mt-4 flex items-center gap-1.5 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green">
                        <ShieldCheck size={15} strokeWidth={2.2} aria-hidden="true" />
                        {t('spzRestaTitolo')}
                    </h3>
                    <p className="mt-1 font-maven text-[13px] text-kidville-ink">{t('spzRestaTesto')}</p>
                    {conti.thread > 0 && (
                        <p className="mt-1 font-maven text-[13px] text-kidville-sub">{t('spzThreadRestano')}</p>
                    )}
                    {/* ⚠️ I MEDIA CHE NON SI RIESCE A TOGLIERE, detti PRIMA e non
                        taciuti. `sorteDellaFoto` li chiama `trattenuta`: il bambino
                        è l'unico taggato, ma l'indirizzo del file non è
                        riconoscibile in questo archivio, quindi l'esecuzione non
                        toglie né il file né la riga — cancellare la riga lascerebbe
                        «un file invisibile e non cancellato».
                        Sommarli alle foto «sole sue» prometterebbe una distruzione
                        che non avviene; tacerli sarebbe peggio: quei file rendono
                        l'esito PARZIALE per sempre, e l'operatore leggerebbe
                        «riprova» all'infinito senza sapere che riprovare non serve.
                        È lo stesso difetto del 503 mancante — un'istruzione che non
                        funzionerà mai — spostato dentro il riquadro. */}
                    {conti.media_non_rimovibili > 0 && (
                        <p className="mt-2 flex items-start gap-2 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                            {t('spzNonRimovibili', { n: conti.media_non_rimovibili })}
                        </p>
                    )}

                    <p className="mt-4 flex items-start gap-2 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                        {t('spzAvvisoIrreversibile')}
                    </p>

                    <label className="mt-4 block">
                        <span className="font-maven text-[13px] font-semibold text-kidville-ink">
                            {t('spzConfermaEtichetta', { nominativo })}
                        </span>
                        <input
                            type="text"
                            value={digitato}
                            onChange={(e) => setDigitato(e.target.value)}
                            autoComplete="off"
                            // `autoCapitalize`/`spellCheck` spenti: su iOS la tastiera
                            // maiuscolerebbe da sola e il correttore proporrebbe un
                            // altro cognome — su un campo che si deve ricopiare esatto.
                            autoCapitalize="off"
                            spellCheck={false}
                            className="mt-1 w-full rounded-input border-2 border-kidville-line px-3 py-2.5 font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:outline-none focus:ring-2 focus:ring-kidville-green/15"
                        />
                    </label>

                    {errore !== null && (
                        <p role="alert" className="mt-2 rounded-input bg-kidville-error-soft px-3 py-2 font-maven text-[13px] text-kidville-error-strong">
                            {errore || t('spzErrore')}
                        </p>
                    )}

                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                        <button
                            type="button"
                            onClick={onChiudi}
                            aria-disabled={fase === 'esecuzione'}
                            className={btnClass('ghost', 'sm')}
                        >
                            {t('spzAnnulla')}
                        </button>
                        <button
                            type="button"
                            onClick={() => void esegui()}
                            // `aria-disabled`, NON `disabled`: marcarlo spegne il fuoco,
                            // che in Chrome torna su `<body>`. Il doppio invio lo ferma
                            // `inVoloRef`, che è sincrona. E il campo vuoto NON è la
                            // regola del nominativo: è «non hai ancora scritto niente».
                            aria-disabled={fase === 'esecuzione' || digitato.trim() === ''}
                            className={btnClass('danger', 'sm')}
                        >
                            <Eraser size={14} strokeWidth={2} aria-hidden="true" />
                            {fase === 'esecuzione' ? t('spzEseguiInCorso') : t('spzEsegui')}
                        </button>
                    </div>
                </>
            )}

            {/* ── È stato fatto ──────────────────────────────────────────────── */}
            {fase === 'fatto' && (
                <>
                    <div
                        ref={esitoRef}
                        // `parziale` è un ALLARME, non un esito: `role="alert"` lo
                        // annuncia da solo, mentre il successo pieno è uno `status`.
                        role={esito?.parziale === true ? 'alert' : 'status'}
                        tabIndex={-1}
                        className={cx(
                            'rounded-input px-3 py-2.5 font-maven text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-kidville-green',
                            esito?.parziale === true
                                ? 'bg-kidville-warn-soft text-kidville-warn-strong'
                                : 'bg-kidville-success-soft text-kidville-success-strong',
                        )}
                    >
                        <p className="flex items-center gap-2 font-barlow font-extrabold uppercase tracking-[0.03em]">
                            {esito?.parziale === true ? (
                                <AlertTriangle size={16} aria-hidden="true" />
                            ) : (
                                <CheckCircle2 size={16} aria-hidden="true" />
                            )}
                            {esito?.parziale === true ? t('spzParzialeTitolo') : t('spzFattoTitolo')}
                        </p>
                        {esito !== null && (
                            <ul className="mt-1 list-disc space-y-0.5 pl-5">
                                <li>{t('spzFattoFoto', { n: esito.foto_rimosse })}</li>
                                <li>{t('spzFattoMessaggi', { n: esito.messaggi_cancellati })}</li>
                                {esito.articoli_ritirati > 0 && <li>{t('spzFattoArticoli', { n: esito.articoli_ritirati })}</li>}
                                {esito.n_file_non_rimossi > 0 && <li>{t('spzParzialeFile', { n: esito.n_file_non_rimossi })}</li>}
                                {esito.messaggi_trattenuti > 0 && (
                                    <li>{t('spzParzialeMessaggi', { n: esito.messaggi_trattenuti })}</li>
                                )}
                                {/* Il terzo motivo per cui un esito è parziale, e il
                                    solo che non parla di una cosa rimasta dentro: un
                                    ARCHIVIO che non si è potuto leggere. Senza questa
                                    riga si leggerebbe come le altre due — «qualcosa
                                    non è uscito» — mentre qui non si sa nemmeno se ci
                                    fosse qualcosa, ed è la differenza fra riprovare e
                                    chiamare qualcuno che guardi i permessi. */}
                                {esito.letture_fallite > 0 && (
                                    <li>{t('spzParzialeLetture', { n: esito.letture_fallite })}</li>
                                )}
                            </ul>
                        )}
                        {esito?.parziale === true && <p className="mt-1">{t('spzParzialeTesto')}</p>}
                    </div>
                    <div className="mt-4 flex justify-end">
                        <button type="button" onClick={onChiudi} className={btnClass('primary', 'sm')}>
                            {t('spzChiudi')}
                        </button>
                    </div>
                </>
            )}
        </Modal>
    );
}
