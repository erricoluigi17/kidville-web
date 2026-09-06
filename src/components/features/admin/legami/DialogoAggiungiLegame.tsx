'use client';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * AGGIUNGERE UN LEGAME — si CERCA, non si sfoglia.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Lo stesso dialogo serve i due versi, perché il legame è uno solo: «aggiungi
 * una madre a questo bambino» e «aggiungi un figlio a questa madre» scrivono la
 * stessa riga. Cambia che cosa si cerca (`verso`) e quale capo è già fissato.
 *
 * ─── SOTTO I DUE CARATTERI NON PARTE NIENTE ────────────────────────────────
 *
 * Non è un'ottimizzazione di rete: la ricerca degli adulti, sul server, parte
 * dal LEGAME e legge fino a 3000 righe di perimetro per non far uscire dal
 * proprio plesso l'anagrafica di nessuno. Interrogarla a ogni tasto vorrebbe
 * dire quella lettura per ogni carattere digitato. E un elenco di 747 adulti
 * non si sfoglia: chi cerca sa già chi cerca.
 *
 * ⚠️ La guardia sta PRIMA del `setTimeout`, dentro il timer come in
 * `AdminSearchPanel`: `setState` sincrono nel corpo di un effetto è un ERRORE
 * del gate in questo repo (`react-hooks/set-state-in-effect`).
 *
 * ─── L'ADULTO CHE NON C'È IN ARCHIVIO ──────────────────────────────────────
 *
 * La seconda strada — crearlo — chiede il MINIMO indispensabile e non ribatte
 * qui l'intera anagrafica: quella vive già in `ScrollableAdultForm`, e una
 * seconda copia della stessa lista di campi è una lista che il giorno in cui
 * diverge scarta un dato in silenzio. Il resto si completa dalla scheda
 * dell'adulto, che si apre subito dopo dall'elenco.
 *
 * ⚠️ Con un'email, il server crea anche l'IDENTITÀ DI ACCESSO e **manda le
 * credenziali**: è una email che parte davvero, verso una famiglia vera. Chi
 * preme deve leggerlo prima, non scoprirlo dopo.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Search, UserPlus, UserRoundPlus } from 'lucide-react';
import { logClient } from '@/lib/logging/client';
import { Modal } from '@/components/ui/Modal';
import { btnClass } from '@/components/ui/Btn';
import { cx } from '@/lib/ui/cx';
import {
    MINIMO_RICERCA,
    RUOLI_LEGAME,
    cercaAlunni,
    cercaGenitori,
    scriviLegame,
    type AlunnoTrovato,
    type CorpoLegame,
    type EsitoScrittura,
    type GenitoreTrovato,
    type ModoAggiunta,
    type RuoloLegame,
    type VersoLegame,
} from './legami-api';

/**
 * Millisecondi da lasciar passare PRIMA di interrogare il server. Gli stessi 300 ms della
 * ricerca globale del cockpit (`AdminSearchPanel`), dove il numero è scritto in chiaro.
 *
 * ⚠️ SI CHIAMA `RITARDO…` E NON `ATTESA…`, ed è una decisione, non un sinonimo scelto a caso.
 * `__tests__/lib/logging-tetto.test.ts` tiene l'inventario dei TETTI DI TEMPO — le scadenze che
 * INTERROMPONO una chiamata perché non resti appesa (misura di quel file: contro un bersaglio
 * muto una `fetch` senza tetto dura 150 s) — e li riconosce dal NOME: `TETTO`, `TIMEOUT`,
 * `SCADENZA`, `ATTESA`. Questo numero non interrompe niente: rimanda l'INIZIO di una ricerca, e
 * se scade non annulla nulla, fa partire la fetch. Chiamarlo `ATTESA_RICERCA` — come stava
 * fino al 2026-09-06 — lo faceva entrare in quell'inventario, cioè metteva un debounce nella
 * lista delle chiamate che possono restare appese per sempre: la testata di quel lock esclude
 * esattamente questo caso («le attese che non sono tetti … includerle riempirebbe la lista di
 * rumore, che è il modo in cui un inventario smette di essere letto»).
 *
 * Il nome segue quelli che nel repo dicono già la stessa cosa: `RITARDO_MS` (`CampoNonCoperto`,
 * anti-lampeggio), `PAUSA_FRA_EMAIL_MS`, `PAUSA_FRA_PAGINE_MS`.
 */
const RITARDO_RICERCA_MS = 300;

interface Props {
    verso: VersoLegame;
    /** Il capo FISSO del legame: il bambino se si cercano adulti, l'adulto se si cercano bambini. */
    alunnoId?: string | null;
    parentId?: string | null;
    /** Il nome di chi sta già sulla scheda. A schermo va il nome, mai l'uuid. */
    nomeFisso: string;
    onChiudi: () => void;
    /**
     * Il legame è stato scritto: il chiamante rilegge l'elenco e chiude.
     *
     * ⚠️ IL `modo` NON È DECORAZIONE, ed è la ragione per cui questa firma ha due
     * parametri: la stessa risposta del server si legge in modo diverso secondo
     * la strada presa. Sul ramo «adulto nuovo» la rotta risponde SEMPRE
     * `anagrafica: 'gia-presente'` — `linkOrCreateParent` scrive lui il legame
     * prima che `collegaFamiliare` lo legga — quindi solo chi ha premuto sa se
     * quel «già presente» è un'informazione o un artefatto. La regola sta in
     * `avvisoDaEsito` (`GestoreLegami`), qui si consegna il fatto.
     *
     * `esito: null` = il server ha risposto 200 ma il corpo non si è potuto
     * leggere: non si sa che cosa è successo, e non lo si finge.
     */
    onCollegato: (esito: EsitoScrittura | null, modo: ModoAggiunta) => void;
}

/** Una riga d'elenco, nella forma minima che serve a sceglierla. */
interface Riga {
    id: string;
    nome: string;
    dettaglio: string | null;
    giaCollegato: boolean;
    senzaAccount: boolean;
}

type Stato = 'inattiva' | 'caricamento' | 'pronta' | 'errore';

export function DialogoAggiungiLegame({ verso, alunnoId, parentId, nomeFisso, onChiudi, onCollegato }: Props) {
    const t = useTranslations('adminStudents');
    const radice = `legami-${useId().replace(/[^A-Za-z0-9_-]+/g, '-')}`;

    const [testo, setTesto] = useState('');
    const [righe, setRighe] = useState<Riga[]>([]);
    const [stato, setStato] = useState<Stato>('inattiva');
    const [scelto, setScelto] = useState<string | null>(null);
    const [ruolo, setRuolo] = useState<'' | RuoloLegame>('');
    /** `ricerca` = si sceglie dall'archivio; `nuovo` = si crea un adulto che non c'è. */
    const [modo, setModo] = useState<ModoAggiunta>('ricerca');
    const [nuovo, setNuovo] = useState({ first_name: '', last_name: '', fiscal_code: '', email: '', phone: '' });
    const [erroreRicerca, setErroreRicerca] = useState<string | null>(null);
    const [erroreScrittura, setErroreScrittura] = useState<string | null>(null);
    const [inCorso, setInCorso] = useState(false);

    /**
     * LA GUARDIA DI RIENTRO è un `ref` e non lo stato: due click nello stesso tick
     * leggono entrambi lo stato vecchio e partono entrambi. Sul `collega` di un
     * adulto NUOVO la seconda POST creerebbe una seconda anagrafica.
     */
    const inVoloRef = useRef(false);
    /** L'epoca della ricerca: la risposta VECCHIA non deve vincere sulla nuova. */
    const epocaRef = useRef(0);

    const idCerca = `${radice}-cerca`;
    const idRuolo = `${radice}-ruolo`;
    const idTitolo = `${radice}-titolo`;

    const titolo = verso === 'genitori' ? t('legamiAggiungiFamiliare') : t('legamiAggiungiFiglio');

    useEffect(() => {
        if (modo !== 'ricerca') return;
        let attivo = true;
        const q = testo.trim();
        const mia = epocaRef.current + 1;
        epocaRef.current = mia;
        const timer = setTimeout(() => {
            // Sotto i due caratteri non si interroga il server: si dice perché.
            if (q.length < MINIMO_RICERCA) {
                if (attivo) {
                    setRighe([]);
                    setStato('inattiva');
                    setErroreRicerca(null);
                }
                return;
            }
            if (attivo) setStato('caricamento');
            const promessa =
                verso === 'genitori'
                    ? cercaGenitori(q, alunnoId ?? '', '').then((esito) =>
                          esito.ok
                              ? {
                                    ok: true as const,
                                    righe: esito.dati.map(
                                        (g: GenitoreTrovato): Riga => ({
                                            id: g.id,
                                            nome: [g.last_name, g.first_name].filter(Boolean).join(' ').trim(),
                                            dettaglio: g.fiscal_code ?? null,
                                            giaCollegato: g.gia_collegato === true,
                                            senzaAccount: g.ha_account === false,
                                        }),
                                    ),
                                }
                              : { ok: false as const, testo: esito.testo },
                      )
                    : cercaAlunni(q, parentId ?? '', '').then((esito) =>
                          esito.ok
                              ? {
                                    ok: true as const,
                                    righe: esito.dati.map(
                                        (a: AlunnoTrovato): Riga => ({
                                            id: a.id,
                                            nome: [a.cognome, a.nome].filter(Boolean).join(' ').trim(),
                                            dettaglio: a.classe_sezione ?? null,
                                            giaCollegato: a.gia_collegato === true,
                                            senzaAccount: false,
                                        }),
                                    ),
                                }
                              : { ok: false as const, testo: esito.testo },
                      );
            void promessa.then((esito) => {
                if (!attivo || mia !== epocaRef.current) return;
                if (esito.ok) {
                    setRighe(esito.righe);
                    setErroreRicerca(null);
                    setStato('pronta');
                    return;
                }
                // Una ricerca fallita NON diventa un elenco vuoto: «non l'ho trovato»
                // e «non ho potuto guardare» hanno rimedi opposti, e il secondo
                // manderebbe a creare un doppione di un adulto che c'è già.
                setRighe([]);
                setErroreRicerca(esito.testo);
                setStato('errore');
            });
        }, RITARDO_RICERCA_MS);
        return () => {
            attivo = false;
            clearTimeout(timer);
        };
        // ⚠️ `t` NON sta fra le dipendenze, e qui dentro non si nomina nessuna
        // stringa di catalogo. `useTranslations` non promette la stessa identità a
        // ogni render (nel doppio finto dei test ne restituisce una nuova ogni
        // volta): con `t` in elenco l'effetto ripartirebbe a ogni render, e ogni
        // giro sparerebbe una ricerca. È la stessa trappola documentata in testa a
        // `conta` di `LiberaSpazioDialog`. Il ripiego è `''`, e la frase tradotta
        // si sceglie al momento di rendere, dove non costa niente.
    }, [testo, verso, alunnoId, parentId, modo]);

    const nuovoCompilabile = nuovo.first_name.trim() !== '' && nuovo.last_name.trim() !== '';
    const prontoAScrivere =
        ruolo !== '' && !inCorso && (modo === 'nuovo' ? nuovoCompilabile : scelto !== null);

    /**
     * CHE COSA SI LEGGE QUANDO IL SERVER DICE DI NO — e la sola frase che questa
     * schermata riscrive.
     *
     * Di regola vince la prosa del server, o la frase di catalogo del suo
     * `codice`: le sceglie chi sa che cosa è successo. L'eccezione è UNA, e la
     * dichiara la rotta stessa — `LEGAME_ADULTO_FORSE_CREATO`: il rifiuto arriva
     * DOPO `linkOrCreateParent`, cioè dopo che l'anagrafica dell'adulto può
     * essere nata e, con un'email, le credenziali possono essere già partite
     * verso una famiglia vera (`src/lib/anagrafiche/parents.ts`, punti 2 e 4).
     *
     * ⚠️ FINO AL 2026-09-06 LA RISERVA ERA `modo === 'nuovo' && stato >= 500`, cioè
     * una DEDUZIONE della schermata, e adesso sarebbe FALSA: la rotta risponde 500
     * `LETTURA_FALLITA` anche PRIMA di toccare qualunque cosa (la sede del bambino
     * non letta, `route.ts` → `sede-bambino-non-letta`), e là «niente è stato
     * modificato» è vero e il rimedio è riprovare. Una regola che copre anche quel
     * caso dice all'operatore di NON riprovare quando riprovare è l'unica cosa da
     * fare, e gli lascia un modulo compilato che non spedirà mai. La riserva la
     * porta il `codice`, che è l'unico a sapere quale ramo ha preso la rotta.
     *
     * Perché la frase di questa schermata batte quella di catalogo
     * (`erroreLegameAdultoForseCreato`), che dice la stessa cosa: perché qui il
     * modulo è ancora compilato e «Collega» è a un clic, quindi l'istruzione utile
     * è quella che nomina il gesto disponibile ADESSO — chiudi, riapri la scheda,
     * controlla l'elenco — e non un generico «prima di riprovare».
     */
    const testoDelRifiuto = (esito: { testo: string; codice: string | null; stato: number | null }) => {
        if (esito.codice !== 'LEGAME_ADULTO_FORSE_CREATO') return esito.testo;
        // L'unica traccia di questo caso che qualcuno potrà cercare: nei log del
        // server il guasto c'è, ma non c'è scritto che a schermo l'operatore stava
        // per creare un doppione. Mai il nome, mai l'email: il codice e lo status.
        logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: `legami-collega-nuovo-esito-incerto: ${esito.codice}`,
            route: '/admin/students',
            stato: esito.stato ?? undefined,
        });
        return t('legamiNuovoEsitoIncerto');
    };

    const collega = async () => {
        if (!prontoAScrivere || inVoloRef.current) return;
        // Il capo FISSO deve esserci davvero: senza, il corpo partirebbe con un
        // `alunno_id` (o un `parent_id`) vuoto e il 400 parlerebbe di zod invece
        // che di una scheda aperta su niente.
        if (!(verso === 'genitori' ? alunnoId : parentId)) return;
        inVoloRef.current = true;
        setInCorso(true);
        setErroreScrittura(null);
        try {
            const relazione = ruolo as RuoloLegame;
            let corpo: CorpoLegame;
            if (modo === 'nuovo') {
                // Le chiavi sono quelle di `buildParentRecord`, non quelle delle
                // colonne: `birth_place`/`address` là dentro diventano `birth_city`
                // e `residence_address`. Ribattere la mappa qui creerebbe una
                // seconda lista bianca libera di divergere.
                corpo = {
                    azione: 'collega',
                    alunno_id: alunnoId as string,
                    relation_type: relazione,
                    genitore: {
                        first_name: nuovo.first_name.trim(),
                        last_name: nuovo.last_name.trim(),
                        fiscal_code: nuovo.fiscal_code.trim().toUpperCase(),
                        emails: nuovo.email.trim() ? [nuovo.email.trim()] : [],
                        phones: nuovo.phone.trim() ? [nuovo.phone.trim()] : [],
                    },
                };
            } else {
                corpo = {
                    azione: 'collega',
                    alunno_id: (verso === 'genitori' ? alunnoId : scelto) as string,
                    parent_id: (verso === 'genitori' ? scelto : parentId) as string,
                    relation_type: relazione,
                };
            }
            const esito = await scriviLegame(corpo, t('legamiErroreGenerico'));
            if (!esito.ok) {
                // Il dialogo NON si chiude: chi ha premuto deve leggere il motivo
                // con davanti quello che aveva scelto, non ritrovarsi la scheda
                // com'era e un messaggio che sparisce.
                setErroreScrittura(testoDelRifiuto(esito));
                return;
            }
            // `letto: false` è un 200 di cui non si è potuto leggere il corpo: si
            // consegna `null`, perché un esito inventato qui diventerebbe una frase
            // che afferma un risultato mai verificato.
            onCollegato(esito.letto ? esito.dati : null, modo);
        } finally {
            inVoloRef.current = false;
            setInCorso(false);
        }
    };

    return (
        <Modal
            open
            onClose={onChiudi}
            title={titolo}
            labelledBy={idTitolo}
            // Non si chiude cliccando fuori: da qui si può creare un'anagrafica
            // nuova, e un click distratto sullo sfondo butterebbe via il modulo.
            closeOnBackdrop={false}
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl"
        >
            <div className="mb-4 flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-green-soft text-kidville-green">
                    <UserPlus size={22} strokeWidth={1.9} aria-hidden="true" />
                </div>
                <div className="min-w-0">
                    <h2 id={idTitolo} className="font-barlow text-lg font-bold uppercase text-kidville-green">
                        {titolo}
                    </h2>
                    <p className="font-maven truncate text-sm text-kidville-sub">{nomeFisso}</p>
                </div>
            </div>

            {modo === 'ricerca' ? (
                <>
                    <label htmlFor={idCerca} className="font-maven text-[13px] font-semibold text-kidville-ink">
                        {t('legamiCercaEtichetta')}
                    </label>
                    <div className="relative mt-1">
                        <Search
                            size={16}
                            aria-hidden="true"
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub"
                        />
                        <input
                            id={idCerca}
                            type="search"
                            value={testo}
                            onChange={(e) => {
                                setTesto(e.target.value);
                                // Cambiata la ricerca, la scelta di prima non vale più:
                                // premere «Collega» manderebbe l'uuid di una riga che
                                // non è più a schermo.
                                setScelto(null);
                                setErroreScrittura(null);
                            }}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={t('legamiCercaSegnaposto')}
                            className="w-full rounded-input border-2 border-kidville-line py-2.5 pl-9 pr-3 font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:outline-none focus:ring-2 focus:ring-kidville-green/15"
                        />
                    </div>

                    <div className="mt-3 min-h-[3rem]">
                        {stato === 'inattiva' && (
                            <p className="font-maven text-[13px] text-kidville-sub">{t('legamiCercaMinimo')}</p>
                        )}
                        {stato === 'caricamento' && (
                            <p role="status" className="flex items-center gap-2 font-maven text-[13px] text-kidville-sub">
                                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                                {t('legamiCercaInCorso')}
                            </p>
                        )}
                        {stato === 'errore' && erroreRicerca !== null && (
                            <p role="alert" className="rounded-input bg-kidville-error-soft px-3 py-2 font-maven text-[13px] text-kidville-error-strong">
                                {/* `''` = «è fallita e il server non ha detto perché»: la
                                    frase tradotta si sceglie QUI, non dentro l'effetto. */}
                                {erroreRicerca || t('legamiErroreRicerca')}
                            </p>
                        )}
                        {stato === 'pronta' && righe.length === 0 && (
                            <p className="font-maven text-[13px] text-kidville-sub">{t('legamiCercaNessuno')}</p>
                        )}
                        {stato === 'pronta' && righe.length > 0 && (
                            <ul className="space-y-1.5">
                                {righe.map((riga) =>
                                    riga.giaCollegato ? (
                                        /* Chi è GIÀ collegato si vede e non si ripropone: sceglierlo
                                           sarebbe una POST che risponde `gia-presente`, cioè un
                                           gesto senza effetto che sembra averne uno. */
                                        <li
                                            key={riga.id}
                                            className="flex items-center justify-between gap-2 rounded-input border border-kidville-line bg-kidville-neutral-soft px-3 py-2"
                                        >
                                            <span className="min-w-0">
                                                <span className="block truncate font-barlow text-sm font-bold text-kidville-sub">{riga.nome}</span>
                                                {riga.dettaglio && (
                                                    <span className="block truncate font-maven text-[11px] text-kidville-sub">{riga.dettaglio}</span>
                                                )}
                                            </span>
                                            <span className="shrink-0 rounded-md bg-kidville-success-soft px-2 py-1 font-barlow text-[10px] font-bold uppercase tracking-wider text-kidville-success-strong">
                                                {t('legamiGiaCollegato')}
                                            </span>
                                        </li>
                                    ) : (
                                        <li key={riga.id}>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setScelto(riga.id);
                                                    setErroreScrittura(null);
                                                }}
                                                aria-pressed={scelto === riga.id}
                                                className={cx(
                                                    'flex w-full items-center justify-between gap-2 rounded-input border px-3 py-2 text-left transition-colors',
                                                    scelto === riga.id
                                                        ? 'border-kidville-green bg-kidville-green-soft'
                                                        : 'border-kidville-line bg-kidville-white hover:bg-kidville-cream',
                                                )}
                                            >
                                                <span className="min-w-0">
                                                    <span className="block truncate font-barlow text-sm font-bold text-kidville-ink">{riga.nome}</span>
                                                    {riga.dettaglio && (
                                                        <span className="block truncate font-maven text-[11px] text-kidville-sub">{riga.dettaglio}</span>
                                                    )}
                                                </span>
                                                {riga.senzaAccount && (
                                                    <span className="shrink-0 rounded-md bg-kidville-warn-soft px-2 py-1 font-barlow text-[10px] font-bold uppercase tracking-wider text-kidville-warn-strong">
                                                        {t('legamiSenzaAccountBadge')}
                                                    </span>
                                                )}
                                            </button>
                                        </li>
                                    ),
                                )}
                            </ul>
                        )}
                    </div>

                    {/* La seconda strada, e solo nel verso in cui esiste: un BAMBINO
                        non si crea da qui — la sua anagrafica ha una sede, una classe
                        e dei consensi, e nasce dalla sua scheda. */}
                    {verso === 'genitori' && (
                        <button
                            type="button"
                            onClick={() => {
                                setModo('nuovo');
                                setScelto(null);
                                setErroreScrittura(null);
                            }}
                            className="mt-3 flex items-center gap-2 font-maven text-[13px] font-semibold text-kidville-green underline underline-offset-2"
                        >
                            <UserRoundPlus size={15} aria-hidden="true" />
                            {t('legamiNuovoApri')}
                        </button>
                    )}
                </>
            ) : (
                <>
                    <h3 className="font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green">
                        {t('legamiNuovoTitolo')}
                    </h3>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                        <div>
                            <label htmlFor={`${radice}-nome`} className="font-maven text-xs text-kidville-sub">{t('legamiNuovoNome')}</label>
                            <input
                                id={`${radice}-nome`}
                                type="text"
                                value={nuovo.first_name}
                                onChange={(e) => setNuovo((p) => ({ ...p, first_name: e.target.value }))}
                                className="mt-1 w-full rounded-input border-2 border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none"
                            />
                        </div>
                        <div>
                            <label htmlFor={`${radice}-cognome`} className="font-maven text-xs text-kidville-sub">{t('legamiNuovoCognome')}</label>
                            <input
                                id={`${radice}-cognome`}
                                type="text"
                                value={nuovo.last_name}
                                onChange={(e) => setNuovo((p) => ({ ...p, last_name: e.target.value }))}
                                className="mt-1 w-full rounded-input border-2 border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none"
                            />
                        </div>
                        <div className="col-span-2">
                            <label htmlFor={`${radice}-cf`} className="font-maven text-xs text-kidville-sub">{t('legamiNuovoCf')}</label>
                            <input
                                id={`${radice}-cf`}
                                type="text"
                                value={nuovo.fiscal_code}
                                onChange={(e) => setNuovo((p) => ({ ...p, fiscal_code: e.target.value }))}
                                autoCapitalize="characters"
                                spellCheck={false}
                                className="mt-1 w-full rounded-input border-2 border-kidville-line px-3 py-2 font-maven text-sm uppercase text-kidville-ink focus:border-kidville-green focus:outline-none"
                            />
                            <p className="mt-1 font-maven text-[11px] text-kidville-sub">{t('legamiNuovoCfNota')}</p>
                        </div>
                        <div>
                            <label htmlFor={`${radice}-email`} className="font-maven text-xs text-kidville-sub">{t('legamiNuovoEmail')}</label>
                            <input
                                id={`${radice}-email`}
                                type="email"
                                value={nuovo.email}
                                onChange={(e) => setNuovo((p) => ({ ...p, email: e.target.value }))}
                                className="mt-1 w-full rounded-input border-2 border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none"
                            />
                        </div>
                        <div>
                            <label htmlFor={`${radice}-telefono`} className="font-maven text-xs text-kidville-sub">{t('legamiNuovoTelefono')}</label>
                            <input
                                id={`${radice}-telefono`}
                                type="tel"
                                value={nuovo.phone}
                                onChange={(e) => setNuovo((p) => ({ ...p, phone: e.target.value }))}
                                className="mt-1 w-full rounded-input border-2 border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none"
                            />
                        </div>
                    </div>
                    {/* Un'email qui fa PARTIRE un'email vera con le credenziali. Si dice prima. */}
                    <p className="mt-2 rounded-input bg-kidville-info-soft px-3 py-2 font-maven text-[12px] text-kidville-info-strong">
                        {t('legamiNuovoCredenziali')}
                    </p>
                    <button
                        type="button"
                        onClick={() => {
                            setModo('ricerca');
                            setErroreScrittura(null);
                        }}
                        className="mt-3 font-maven text-[13px] font-semibold text-kidville-green underline underline-offset-2"
                    >
                        {t('legamiNuovoTorna')}
                    </button>
                </>
            )}

            {/* Il RUOLO vale per tutte e due le strade: è la colonna `relation_type`
                del legame, non un attributo della persona. Nessun valore di partenza:
                un «delegato» di default diventerebbe il ruolo di chi non guarda. */}
            <div className="mt-4">
                <label htmlFor={idRuolo} className="font-maven text-[13px] font-semibold text-kidville-ink">
                    {t('legamiRuoloEtichetta')}
                </label>
                <select
                    id={idRuolo}
                    value={ruolo}
                    onChange={(e) => setRuolo(e.target.value as '' | RuoloLegame)}
                    className="mt-1 w-full rounded-input border-2 border-kidville-line bg-kidville-white px-3 py-2.5 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none"
                >
                    <option value="">{t('legamiRuoloScegli')}</option>
                    {RUOLI_LEGAME.map((r) => (
                        <option key={r} value={r}>
                            {r === 'mother' ? t('ruoloMadre') : r === 'father' ? t('ruoloPadre') : t('ruoloDelegato')}
                        </option>
                    ))}
                </select>
            </div>

            {erroreScrittura !== null && (
                <p role="alert" className="mt-3 rounded-input bg-kidville-error-soft px-3 py-2 font-maven text-[13px] text-kidville-error-strong">
                    {erroreScrittura}
                </p>
            )}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={onChiudi} className={btnClass('ghost', 'sm')}>
                    {t('legamiAnnulla')}
                </button>
                <button
                    type="button"
                    onClick={() => void collega()}
                    // `aria-disabled`, non `disabled`: marcarlo spegne il fuoco, che in
                    // Chrome torna su `<body>`. Il doppio invio lo ferma `inVoloRef`.
                    aria-disabled={!prontoAScrivere}
                    className={btnClass('primary', 'sm')}
                >
                    {inCorso ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <UserPlus size={14} aria-hidden="true" />}
                    {t('legamiCollega')}
                </button>
            </div>
        </Modal>
    );
}
