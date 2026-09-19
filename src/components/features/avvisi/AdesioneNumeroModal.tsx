'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Hourglass, Users } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Stepper } from '@/components/ui/Stepper';
import { intervallo } from '@/lib/avvisi/partecipanti';
import { ETICHETTA_NUMERO_PREDEFINITA } from '@/lib/validation/avvisi';
import { erroreDaRisposta } from '@/lib/ui/esito-fetch';
import { logClient, nomeErrore } from '@/lib/logging/client';
import type { Avviso, FiglioAvviso } from './AvvisoCard';

/**
 * ═══ «QUANTE PERSONE?» — E LA SCRITTURA AVVIENE UNA VOLTA SOLA ══════════════
 *
 * Il genitore tocca «Aderisco» e subito dopo gli si chiede quante persone. 🔴
 * **Senza il numero l'adesione non vale e non viene salvata**: fino alla conferma
 * non parte nessuna `POST`. È una decisione del committente e non un dettaglio di
 * flusso — un'adesione registrata senza numero è una riga che il tetto dei posti
 * conta come UNA persona per convenzione, ed è il modo di riempire un pullman da
 * 50 con 50 famiglie.
 *
 * ── 1. SI MONTA UNA VOLTA SOLA, DALLA PAGINA ────────────────────────────────
 *
 * Non dentro `AvvisoCard`. ⚠️ La ragione scritta qui fino al 2026-09-19 era FALSA
 * («la stessa comunicazione è renderizzata nella lista E nell'anteprima in home»):
 * la home monta `AvvisiPreview`, che è un'altra componente e non monta questa
 * modale. La conclusione regge lo stesso, e la ragione vera è più semplice: la
 * bacheca rende UNA CARD PER AVVISO, quindi una modale per card sono N dialoghi
 * nel DOM, N focus-trap in ascolto sullo stesso `document`, e — alla chiusura — un
 * ripristino del fuoco su un elemento che nel frattempo è scorso via. La pagina ne
 * tiene una e le passa l'avviso su cui si sta lavorando.
 *
 * (È la stessa classe di difetto che questo cantiere ha appena corretto in
 * `route.ts:470-478`: un file che si spiega con un fatto falso è peggio di un file
 * che tace, perché manda a cercare il guasto dove non è.)
 *
 * ── 2. È COSTRUITA SU `@/components/ui/Modal`, E NON A MANO ─────────────────
 *
 * Da lì arrivano focus-trap, Escape, scroll-lock, sfondo `inert`, il tasto
 * Indietro fisico di Android (che altrimenti porterebbe alla dashboard buttando
 * via i numeri già scelti) e le safe-area del notch. Rifarli qui significherebbe
 * rifarli peggio in quindici posti.
 *
 * ── 3. IL CASO A PIÙ FIGLI, E PERCHÉ L'ETICHETTA È DOVE È ───────────────────
 *
 * Con due o più figli c'è UNA RIGA PER FIGLIO, e il `<label>` del campo è il NOME
 * DEL BAMBINO. La domanda scritta dalla segreteria («Quante persone
 * accompagneranno il bambino?») è enunciata una volta sola, sopra, in un `<p id>`
 * puntato da `aria-describedby` di ogni campo. È l'unica disposizione che a uno
 * screen reader dà sia «Giulia» (il nome del controllo: quale dei due campi sto
 * compilando) sia la domanda (la descrizione) senza ripeterla tre volte —
 * mettere la domanda come `<label>` di entrambi renderebbe i due campi
 * indistinguibili all'ascolto, che è il difetto peggiore dei due.
 *
 * Con UN figlio solo la domanda torna a essere il `<label>` del campo: il nome del
 * bambino non distingue niente, e un'etichetta che non distingue è rumore.
 *
 * ── 4. L'INTERRUTTORE «PARTECIPA / NON PARTECIPA» ───────────────────────────
 *
 * Solo da due figli in su, e non è una semplificazione: con un figlio solo «non
 * partecipa» è già un bottone sulla card («Non aderisco»), e offrirlo due volte in
 * due posti che scrivono la stessa cosa è il modo di far sbagliare. Con due figli
 * invece è l'UNICO modo che una famiglia ha di dire «oggi va in gita solo Marco»:
 * senza, o vanno tutti o nessuno.
 *
 * 🔴 E IL SUO NOME È IL NOME DEL BAMBINO, COL TESTO FERMO. Fino al 2026-09-19 le
 * due caselle si chiamavano tutt'e due «Partecipo»: all'ascolto Marco e Giulia
 * erano indistinguibili — la stessa obiezione che il punto 3 qui sopra muove, a
 * ragione, a chi mette la domanda come etichetta di entrambi i campi. E il nome
 * CAMBIAVA con lo stato: deselezionando si sentiva «Non partecipo, casella di
 * controllo, **non** selezionata», cioè due negazioni per un fatto solo. Ora
 * `aria-labelledby` punta al nome del figlio PIÙ il testo visibile, che resta
 * «Partecipo» in entrambi gli stati: lo stato lo dice `checked`, che è il suo
 * mestiere. Il testo visibile resta dentro il nome accessibile (WCAG 2.5.3).
 *
 * ── 5. L'ESITO NON STA DIETRO UNA MODALE CHE SI CHIUDE ──────────────────────
 *
 * Se anche un solo figlio finisce in lista d'attesa la modale NON si chiude:
 * scambia il corpo con un pannello d'esito e un solo bottone. «Lo legge subito a
 * schermo» è una decisione del committente, e su un telefono un messaggio che
 * compare mentre il dialogo si chiude non lo legge nessuno.
 *
 * ── 6. 🔴 NESSUN NUMERO DI POSTI LIBERI, MAI ────────────────────────────────
 *
 * Non in questa modale, non nel pannello d'esito, non nel messaggio d'errore. Al
 * genitore spettano due sole informazioni sulla capienza: che i posti sono
 * esauriti, e che LUI è in lista d'attesa (decisione n. 17). Una famiglia che
 * legge «restano 3 posti» non decide con più calma: corre — ed è la corsa
 * all'ultimo posto che la lista d'attesa esiste per evitare. Il payload del
 * genitore è già potato apposta lato server (`statsPerGenitore`), e questo file
 * non deve riaprire la strada dal lato del testo.
 */

/**
 * Un figlio destinatario dell'avviso, come lo porta il feed — nome E stato della
 * sua riga. È lo stesso tipo che la card dichiara (`FiglioAvviso`), non una copia:
 * due definizioni della stessa forma sono il modo in cui una delle due resta
 * indietro, e in questo repo è già successo due volte su due.
 */
export type FiglioAdesione = FiglioAvviso;

/** Che cosa si sta facendo: la prima adesione, o la correzione di una già data. */
export type ModoAdesione = 'nuova' | 'modifica';

/** Lo stato di una riga del modulo, prima che diventi una `POST`. */
interface RigaFiglio {
    student_id: string;
    nome: string;
    partecipa: boolean;
    numero: number | null;
}

/** L'esito per un figlio, dopo la scrittura. */
interface EsitoFiglio {
    nome: string;
    stato: string | null;
}

interface Props {
    open: boolean;
    /** L'avviso su cui si sta rispondendo. `null` quando la modale è chiusa. */
    avviso: Avviso | null;
    figli: readonly FiglioAdesione[];
    modo: ModoAdesione;
    /** L'identità di sessione per l'header `x-user-id` (modello header-identity). */
    parentId: string | null;
    /** Chiusura: la pagina ricarica il feed, perché qualcosa può essere stato scritto. */
    onChiudi: () => void;
}

/**
 * IL GUSCIO — nessun hook, e il corpo si MONTA all'apertura.
 *
 * ⚠️ La prima stesura riempiva il modulo con un `useEffect` che faceva `setRighe`
 * all'apertura, e la regola `react-hooks/set-state-in-effect` l'ha rifiutata. Il
 * divieto ha ragione due volte: oltre alle catene di render, un effetto che
 * riscrive lo stato «quando cambiano le dipendenze» è a un passo dal cancellare i
 * numeri mentre il genitore li sta scegliendo — basta che una dipendenza cambi
 * identità. Il modo in cui React azzera un modulo è farlo RINASCERE: `key`.
 */
export function AdesioneNumeroModal({ open, avviso, figli, modo, parentId, onChiudi }: Props) {
    if (!open || !avviso) return null;
    return (
        <CorpoAdesione
            key={`${avviso.id}:${modo}`}
            avviso={avviso}
            figli={figli}
            modo={modo}
            parentId={parentId}
            onChiudi={onChiudi}
        />
    );
}

function CorpoAdesione({ avviso, figli, modo, parentId, onChiudi }: Omit<Props, 'open' | 'avviso'> & { avviso: Avviso }) {
    const t = useTranslations('avvisi');
    const idBase = useId();
    const idTitolo = `adesione-titolo-${idBase}`;
    const idDomanda = `adesione-domanda-${idBase}`;

    const piuFigli = figli.length > 1;
    const limiti = intervallo({
        numero_min: avviso.numero_min ?? null,
        numero_max: avviso.numero_max ?? null,
    });
    // La domanda la scrive la segreteria; se l'ha lasciata vuota vale il
    // predefinito — lo STESSO che la rotta archivia al posto del vuoto, non una
    // seconda frase scritta qui.
    const domanda = (avviso.etichetta_numero ?? '').trim() || ETICHETTA_NUMERO_PREDEFINITA;

    // ── SI RIPARTE DAL NUMERO DI CIASCUN FIGLIO, NON DA UN AGGREGATO ────────
    //
    // 🔴 IL DIFETTO CHIUSO QUI, misurato: due figli dichiarati a 2 e a 4. Quando i
    // figli non concordano l'aggregato `my_response.numero_partecipanti` è `null`
    // (ed è giusto che lo sia: quella famiglia non HA un numero), quindi i campi
    // nascevano tutti e due a `limiti.min`, cioè a `["1","1"]`. Il bottone
    // «Modifica il numero» è raggiungibile in quel caso — entrambi i figli hanno
    // risposto «sì» — e chi apriva la modale per correggere UN figlio, confermando,
    // portava 2→1 e 4→1 in silenzio: tre persone liberate da un tetto che nessuno
    // aveva chiesto di liberare.
    //
    // Il ripiego resta a due gradini, dal più specifico al più generico: il numero
    // DI QUESTO figlio, poi l'aggregato (che c'è quando i figli concordano, ed è il
    // caso del figlio unico), poi il primo valore ammesso dall'avviso. Mai zero:
    // «quante persone?» con risposta zero non è un'adesione, è un no — e il no ha
    // già il suo bottone sulla card.
    const numeroGiaDato = avviso.my_response?.numero_partecipanti ?? null;
    const [righe, setRighe] = useState<RigaFiglio[]>(() => {
        const numeroValido = (n: number | null | undefined): n is number =>
            typeof n === 'number' && Number.isFinite(n);
        const aggregato = numeroValido(numeroGiaDato) ? numeroGiaDato : null;
        return figli.map((f) => ({
            student_id: f.student_id,
            nome: f.nome,
            partecipa: true,
            numero: numeroValido(f.numero_partecipanti)
                ? f.numero_partecipanti
                : (aggregato ?? limiti.min),
        }));
    });
    const [invio, setInvio] = useState(false);
    const [errore, setErrore] = useState<string | null>(null);
    const [esiti, setEsiti] = useState<EsitoFiglio[] | null>(null);
    /**
     * I FIGLI CHE SONO PASSATI QUANDO UN ALTRO È STATO RESPINTO.
     *
     * 🔴 Un rifiuto parziale mostrava un messaggio solo — quello del primo figlio
     * respinto — e quel messaggio dice «l'adesione resta com'era», che PER MARCO È
     * FALSO: la sua riga è stata scritta. Non è un doppione (l'upsert regge), è un
     * messaggio che dice meno del vero proprio mentre la famiglia decide se
     * riprovare. `null` = nessun rifiuto parziale in corso.
     */
    const [scrittiNonostante, setScrittiNonostante] = useState<EsitoFiglio[] | null>(null);
    const rifEsito = useRef<HTMLButtonElement>(null);

    // Il pannello d'esito sostituisce il corpo: il fuoco deve seguirlo, altrimenti
    // resta su un bottone che non esiste più (WCAG 2.4.3). Qui l'effetto tocca il
    // DOM, non lo stato: è esattamente ciò per cui gli effetti esistono.
    useEffect(() => {
        if (esiti) rifEsito.current?.focus();
    }, [esiti]);

    const cambiaNumero = useCallback((studentId: string, n: number | null) => {
        setRighe((prec) => prec.map((r) => (r.student_id === studentId ? { ...r, numero: n } : r)));
    }, []);

    const cambiaPartecipa = useCallback((studentId: string, partecipa: boolean) => {
        setRighe((prec) => prec.map((r) => (r.student_id === studentId ? { ...r, partecipa } : r)));
    }, []);

    const totale = righe.reduce((s, r) => s + (r.partecipa && r.numero !== null ? r.numero : 0), 0);

    /**
     * ─── L'UNICA SCRITTURA DI TUTTO IL FLUSSO ────────────────────────────────
     *
     * Una `POST` per figlio, in parallelo. Non una per «Aderisco» e una per la
     * conferma: la prima non esiste. Il figlio che non partecipa manda `no` e
     * nessun numero — è una risposta, non un'assenza di risposta, ed è ciò che
     * libera il posto se ne aveva uno.
     *
     * Gli errori NON chiudono la modale e non azzerano i numeri: su un rifiuto non
     * si butta via niente. `POSTI_ESAURITI`, quando arriva a un genitore, non
     * significa «sei fuori» — la RPC manda in coda chi non ha posto, con un 200 —
     * significa «sei già ammesso e l'aumento non ci sta», e il testo di catalogo
     * (`errorePostiEsauriti`) dice infatti «l'adesione resta com'era».
     */
    const conferma = useCallback(async () => {
        if (invio) return;
        // ── ZERO RIGHE: NON SI CHIUDE FINGENDO DI AVER SCRITTO ──────────────
        //
        // 🔴 Con `figli` vuoto e `studentId` nullo (`page.tsx`) il modulo non ha
        // nessuna riga: `Promise.all([])` risolve subito e la modale si chiudeva
        // con «Conferma» senza mandare niente e senza dirlo — il genitore vedeva la
        // finestra sparire, cioè il gesto di successo, su una scrittura mai
        // avvenuta. È la stessa guardia che il ramo a un tocco ha già
        // (`if (ids.length === 0) return`), più una riga a schermo e una nel log:
        // un fallimento silenzioso è un codice rotto anche quando i test passano.
        if (righe.length === 0) {
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'avviso-adesione-senza-figli: conferma su un modulo a zero righe',
                route: '/parent/avvisi',
            });
            setErrore(t('adesioneErrore'));
            return;
        }
        setInvio(true);
        setErrore(null);
        setScrittiNonostante(null);
        try {
            const risultati = await Promise.all(righe.map(async (r) => {
                const corpoRichiesta = r.partecipa
                    ? { student_id: r.student_id, risposta: 'si', numero_partecipanti: r.numero }
                    : { student_id: r.student_id, risposta: 'no' };
                const res = await fetch(`/api/avvisi/${avviso.id}/risposte`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(parentId ? { 'x-user-id': parentId } : {}),
                    },
                    body: JSON.stringify(corpoRichiesta),
                });
                if (!res.ok) {
                    // Il corpo del rifiuto non si butta via: il codice decide la
                    // frase, e senza di lui il genitore leggerebbe «riprova» su un
                    // termine scaduto o su un aumento che non ci sta.
                    const e = await erroreDaRisposta(res, t('adesioneErrore'));
                    logClient({
                        livello: 'warn',
                        evento: 'fetch',
                        messaggio: `avviso-adesione-respinta: ${e.codice ?? 'senza-codice'}`,
                        route: '/parent/avvisi',
                        stato: e.stato,
                        // Solo struttura: il codice del rifiuto e se il corpo si è
                        // potuto leggere. Nessun nome, nessun numero di persone —
                        // sono dati di famiglie, e la lista bianca di `redact` li
                        // redarrebbe comunque, lasciando una riga che non dice niente.
                        campi: { error_code: e.codice ?? 'senza-codice', corpo_letto: e.corpoLetto },
                    });
                    return { nome: r.nome, stato: null as string | null, errore: e.testo };
                }
                const corpo = (await res.json().catch(() => null)) as { stato?: string | null } | null;
                return { nome: r.nome, stato: corpo?.stato ?? null, errore: null as string | null };
            }));

            const respinta = risultati.find((x) => x.errore !== null);
            if (respinta?.errore) {
                setErrore(respinta.errore);
                // …e si dice ANCHE chi è passato. Con due figli e un solo rifiuto,
                // «l'adesione resta com'era» da solo è falso per l'altro: la sua
                // riga c'è. L'elenco compare solo quando qualcosa è stato davvero
                // scritto, così nel caso normale (un figlio, un rifiuto) il banner
                // resta esattamente quello di prima.
                const passati = risultati.filter((x) => x.errore === null);
                setScrittiNonostante(
                    passati.length > 0 ? passati.map((x) => ({ nome: x.nome, stato: x.stato })) : null,
                );
                return;
            }
            // Almeno un figlio in coda → si RESTA aperti e lo si dice a schermo.
            const inAttesa = risultati.some((x) => x.stato === 'in_attesa');
            if (inAttesa) {
                setEsiti(risultati.map((x) => ({ nome: x.nome, stato: x.stato })));
                return;
            }
            onChiudi();
        } catch (err) {
            // La rete caduta è un fatto diverso dal rifiuto: qui il server non ha
            // risposto affatto e non si sa se la riga è stata scritta. Un `catch`
            // muto renderebbe l'adesione «sparita» senza una traccia da guardare.
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `avviso-adesione-non-inviata: ${nomeErrore(err)}`,
                route: '/parent/avvisi',
            });
            setErrore(t('adesioneErrore'));
        } finally {
            setInvio(false);
        }
    }, [avviso, invio, righe, parentId, t, onChiudi]);

    const titolo = modo === 'modifica' ? t('adesioneModaleTitoloModifica') : t('adesioneModaleTitolo');

    return (
        <Modal
            open
            onClose={onChiudi}
            title={titolo}
            labelledBy={idTitolo}
            safeArea
            className="w-full max-w-md overflow-y-auto rounded-3xl border border-kidville-line bg-kidville-white p-5 shadow-xl"
            style={{ maxHeight: '85vh' }}
        >
            <h2 id={idTitolo} className="font-barlow text-lg font-extrabold uppercase tracking-wide text-kidville-green">
                {esiti ? t('adesioneEsitoAttesaTitolo') : titolo}
            </h2>

            {esiti ? (
                /* ── PANNELLO D'ESITO ───────────────────────────────────────
                   Niente numeri di posti: «sei in lista d'attesa» è tutto ciò che
                   una famiglia deve sapere, e l'unico modo per dirglielo senza
                   raccontarle quanto spazio resta agli altri. */
                <div className="mt-3 flex flex-col gap-3">
                    <div className="flex items-start gap-2 rounded-xl border border-kidville-warn/20 bg-kidville-warn-soft px-3 py-2 font-maven text-sm text-kidville-warn">
                        <Hourglass size={14} strokeWidth={1.8} aria-hidden="true" className="mt-0.5 shrink-0" />
                        <span>{t('adesioneEsitoAttesaCorpo')}</span>
                    </div>
                    {piuFigli && (
                        <ul className="flex flex-col gap-1">
                            {esiti.map((e) => (
                                <li key={e.nome} className="font-maven text-sm text-kidville-sub">
                                    {e.stato === 'in_attesa'
                                        ? t('adesioneEsitoAttesaFiglio', { nome: e.nome })
                                        : t('adesioneEsitoAmmessoFiglio', { nome: e.nome })}
                                </li>
                            ))}
                        </ul>
                    )}
                    <button
                        type="button"
                        ref={rifEsito}
                        onClick={onChiudi}
                        className="rounded-pill bg-kidville-green py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-yellow transition-transform active:scale-[0.98]"
                    >
                        {t('adesioneEsitoChiudi')}
                    </button>
                </div>
            ) : (
                <div className="mt-3 flex flex-col gap-4">
                    {/* La domanda della segreteria. Con più figli è la DESCRIZIONE
                        condivisa dei campi (`aria-describedby`); con un figlio solo
                        è il `<label>` del campo, qui sotto. */}
                    {piuFigli && (
                        <p id={idDomanda} className="font-maven text-sm text-kidville-sub">
                            {domanda}
                        </p>
                    )}

                    {righe.map((r) => {
                        const idCampo = `adesione-numero-${idBase}-${r.student_id}`;
                        const idNome = `adesione-nome-${idBase}-${r.student_id}`;
                        const idPartecipa = `adesione-partecipa-${idBase}-${r.student_id}`;
                        return (
                            <div key={r.student_id} className="flex flex-col gap-2">
                                <label id={idNome} htmlFor={idCampo} className="font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green">
                                    {piuFigli ? r.nome : domanda}
                                </label>
                                {piuFigli && (
                                    /* Checkbox NATIVA, non un `role="switch"` fatto a
                                       mano: stato, barra spaziatrice e fuoco visibile
                                       senza una riga di ARIA.

                                       🔴 IL NOME È «Marco Partecipo», NON «Partecipo».
                                       Con due figli le due caselle si chiamavano
                                       tutt'e due allo stesso modo: all'ascolto non si
                                       distingueva quale bambino si stesse togliendo
                                       dalla gita. `aria-labelledby` punta al nome del
                                       figlio (la `<label>` qui sopra, che è già a
                                       schermo) PIÙ il testo visibile della casella —
                                       così il testo visibile resta dentro il nome
                                       accessibile (WCAG 2.5.3) e il nome distingue.

                                       E il testo NON cambia più con lo stato: era
                                       «Non partecipo» da deselezionata, cioè «Non
                                       partecipo, casella di controllo, non
                                       selezionata». Lo stato lo dice `checked`. */
                                    <label className="inline-flex items-center gap-2 font-maven text-xs text-kidville-sub">
                                        <input
                                            type="checkbox"
                                            checked={r.partecipa}
                                            onChange={(e) => cambiaPartecipa(r.student_id, e.target.checked)}
                                            aria-labelledby={`${idNome} ${idPartecipa}`}
                                            className="h-5 w-5 accent-kidville-green"
                                        />
                                        <span id={idPartecipa}>{t('adesionePartecipa')}</span>
                                    </label>
                                )}
                                <Stepper
                                    id={idCampo}
                                    value={r.numero}
                                    onChange={(n) => cambiaNumero(r.student_id, n)}
                                    min={limiti.min}
                                    max={limiti.max}
                                    disabled={!r.partecipa}
                                    aria-describedby={piuFigli ? idDomanda : undefined}
                                    etichettaDiminuisci={t('partecipantiDiminuisci')}
                                    etichettaAumenta={t('partecipantiAumenta')}
                                />
                            </div>
                        );
                    })}

                    {piuFigli && (
                        <p aria-live="polite" className="font-maven text-sm font-bold text-kidville-green">
                            <Users size={14} strokeWidth={2} aria-hidden="true" className="mr-1 inline align-[-2px]" />
                            {t('adesioneTotalePersone', { count: totale })}
                        </p>
                    )}

                    {/* Il banner resta DENTRO la modale, che non si chiude e non
                        perde i numeri: su un rifiuto non si butta via niente. */}
                    {errore && (
                        /* `div` e non `p`: l'elenco dei figli passati è una `ul`, e
                           una lista dentro un paragrafo non è HTML valido. Resta un
                           solo `role="alert"`, così lo screen reader annuncia il
                           rifiuto E chi è passato in un colpo solo, non in due. */
                        <div role="alert" className="flex flex-col gap-1 rounded-xl border border-kidville-error/20 bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error">
                            <p className="flex items-start gap-2">
                                <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
                                <span>{errore}</span>
                            </p>
                            {scrittiNonostante && (
                                <ul className="flex flex-col gap-0.5 pl-[21px]">
                                    {scrittiNonostante.map((e) => (
                                        <li key={e.nome}>
                                            {e.stato === 'in_attesa'
                                                ? t('adesioneEsitoAttesaFiglio', { nome: e.nome })
                                                : t('adesioneEsitoAmmessoFiglio', { nome: e.nome })}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={conferma}
                            disabled={invio}
                            className="flex-1 rounded-pill bg-kidville-green py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-yellow transition-transform active:scale-[0.98] disabled:opacity-60"
                        >
                            {invio ? t('adesioneInvio') : modo === 'modifica' ? t('adesioneSalva') : t('adesioneConferma')}
                        </button>
                        <button
                            type="button"
                            onClick={onChiudi}
                            disabled={invio}
                            className="flex-1 rounded-pill border border-kidville-line bg-kidville-white py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green transition-transform active:scale-[0.98] disabled:opacity-60"
                        >
                            {t('adesioneAnnulla')}
                        </button>
                    </div>
                </div>
            )}
        </Modal>
    );
}
