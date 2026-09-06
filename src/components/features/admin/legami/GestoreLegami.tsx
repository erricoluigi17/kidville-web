'use client';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * I COMANDI DEL LEGAME FAMILIARE — aggiungi · cambia ruolo · scollega.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── PERCHÉ UN COMPONENTE SOLO PER DUE SCHEDE ──────────────────────────────
 *
 * Perché il legame è UNO. «Aggiungi una madre a questo bambino» e «aggiungi un
 * figlio a questa madre» scrivono la stessa riga di `student_parents` e la stessa
 * di `legame_genitori_alunni`: cambia solo quale dei due capi è già fissato dalla
 * scheda che si sta guardando. Scriverne due copie avrebbe voluto dire due
 * conferme diverse per lo stesso gesto — e quella che si aggiorna è sempre una
 * sola delle due.
 *
 * ─── L'ELENCO SI RILEGGE DOPO OGNI SCRITTURA ───────────────────────────────
 *
 * `onRicarica` non è una cortesia visiva: un elenco vecchio a schermo è un elenco
 * di uuid che sul server non descrivono più niente, e il gesto successivo prende
 * un 404 `LEGAME_NON_TROVATO` — cioè un errore che parla di un guasto quando il
 * guasto era solo che la schermata non si era aggiornata.
 *
 * ─── IL RUOLO CHE IN ARCHIVIO NON C'È ──────────────────────────────────────
 *
 * `student_parents.relation_type` in produzione contiene anche 579 `null` (più
 * dieci `madre` e un `padre`, residui di un import). Una tendina con tre sole
 * voci mostrerebbe «Madre» su tutte quelle righe — cioè affermerebbe un ruolo che
 * l'archivio non ha mai scritto. Perciò la tendina ha una voce in più, non
 * scegliibile, che dice il vero: non indicato.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, UserPlus } from 'lucide-react';
import { logClient } from '@/lib/logging/client';
import { btnClass } from '@/components/ui/Btn';
import { DialogoAggiungiLegame } from './DialogoAggiungiLegame';
import { CODICE_MEZZO_TOLTO, CODICE_ULTIMO_GENITORE, DialogoScollega } from './DialogoScollega';
import {
    RUOLI_LEGAME,
    eRuoloCanonico,
    scriviLegame,
    type CorpoLegame,
    type EsitoScrittura,
    type ModoAggiunta,
    type RuoloLegame,
    type VersoLegame,
} from './legami-api';

/** Una riga già collegata, nella forma minima che serve per comandarla. */
export interface VoceLegame {
    /** L'ALTRO capo: `parents.id` sulla scheda del bambino, `alunni.id` su quella dell'adulto. */
    id: string;
    nome: string;
    dettaglio?: string | null;
    /** `student_parents.relation_type` così com'è in archivio: può essere `null` o fuori vocabolario. */
    ruolo?: string | null;
}

interface Props {
    verso: VersoLegame;
    /** Il capo FISSO del legame. Uno dei due, secondo il verso. */
    alunnoId?: string | null;
    parentId?: string | null;
    /** Il nome di chi è già sulla scheda: serve alle conferme, dove un uuid non dice niente. */
    nomeFisso: string;
    collegati: VoceLegame[];
    /** Rilegge l'elenco dal server. Chiamata dopo OGNI scrittura riuscita. */
    onRicarica: () => void | Promise<void>;
}

/** L'esito dell'ultima operazione, per la riga di stato sotto l'elenco. */
type Avviso = { tono: 'ok' | 'attenzione' | 'guasto'; testo: string } | null;

export function GestoreLegami({ verso, alunnoId, parentId, nomeFisso, collegati, onRicarica }: Props) {
    const t = useTranslations('adminStudents');
    const [aggiungiAperto, setAggiungiAperto] = useState(false);
    /** La riga su cui si sta decidendo lo scollegamento. `null` = nessun dialogo. */
    const [daScollegare, setDaScollegare] = useState<VoceLegame | null>(null);
    const [erroreScollega, setErroreScollega] = useState<{ testo: string; codice: string | null } | null>(null);
    const [inCorso, setInCorso] = useState<string | null>(null);
    const [avviso, setAvviso] = useState<Avviso>(null);

    /** Guardia di rientro sincrona: due click nello stesso tick partono entrambi. */
    const inVoloRef = useRef(false);

    /** Gli uuid del legame, montati secondo il verso: il resto del componente non ci pensa più. */
    const capi = (altro: string) => ({
        alunno_id: (verso === 'genitori' ? alunnoId : altro) as string,
        parent_id: (verso === 'genitori' ? altro : parentId) as string,
    });

    /** `true` se il capo fisso c'è davvero: senza, questo blocco non si rende affatto. */
    const capiPresenti = verso === 'genitori' ? Boolean(alunnoId) : Boolean(parentId);

    /**
     * IL CAPO FISSO MANCANTE SI LOGGA, E POI IL BLOCCO SPARISCE (vedi il `return null`).
     *
     * Nei due punti di montaggio di oggi non succede — la scheda del bambino passa
     * sempre `student.id` e quella dell'adulto `parent.id` — ma fino al secondo giro
     * di questo lavoro il pulsante veniva reso lo stesso, solo `aria-disabled`: al
     * clic accendeva uno stato, non apriva niente e non diceva niente. Silenzio
     * totale, cioè la forma di guasto che AGENTS.md chiama «un codice che fallisce
     * in silenzio». Un terzo chiamante che sbagliasse la prop lo scoprirebbe in
     * produzione, e non ci sarebbe una riga da nessuna parte a dirglielo.
     *
     * Nel messaggio va il VERSO, mai un uuid della famiglia: qui l'uuid mancante è
     * proprio ciò che non c'è.
     */
    useEffect(() => {
        if (capiPresenti) return;
        logClient({
            livello: 'error',
            evento: 'react',
            messaggio: `legami-capo-mancante: ${verso}`,
            route: '/admin/students',
        });
    }, [capiPresenti, verso]);

    /**
     * L'esito di una `collega` non è solo «fatto»: la riga runtime può non essere
     * nata, il legame può esserci già, e i casi hanno rimedi diversi.
     *  · `runtime: non-scritto`   → la riga NON è stata scritta e nessuno se ne
     *    accorgerebbe: il genitore vedrebbe il figlio in anagrafica e non i suoi
     *    pagamenti. È il più grave, quindi si guarda per primo — anche quando
     *    l'anagrafica c'era già.
     *  · `anagrafica: gia-presente` → fra la ricerca e la POST qualcun altro ha
     *    scritto lo stesso legame (due segreterie sulla stessa famiglia, o due
     *    schede aperte). Il server non riscrive niente e risponde così: dire
     *    «Collegamento salvato» annuncerebbe un effetto che non c'è stato. Il
     *    `runtime !== 'creato'` è la riserva che conta: se l'anagrafica c'era ma la
     *    riga runtime è nata ADESSO, qualcosa è successo davvero.
     *  · `runtime: senza-account` → l'adulto non ha ancora un accesso: il legame
     *    c'è, e la riga nasce da sé quando la Segreteria invia le credenziali. Non
     *    è un guasto (64 anagrafiche su 747 stanno così).
     *
     * ⚠️ `anagrafica` NON DISTINGUE NIENTE SUL RAMO «CREA UN ADULTO NUOVO», e la
     * riserva è MISURATA, non dedotta. Là la rotta risponde **sempre**
     * `anagrafica: 'gia-presente'`: `linkOrCreateParent` fa l'upsert su
     * `student_parents` (`src/lib/anagrafiche/parents.ts`, punto 3) *prima* che
     * `collegaFamiliare` legga la stessa riga, e trovandola non la conta come
     * creata. La risposta vera di quel ramo è `gia-presente/gia-presente` con
     * un'email (l'identità nasce lì e con lei la riga runtime) e
     * `gia-presente/senza-account` senza — le fissa entrambe
     * `__tests__/api/legami-familiari-ui-contratto-creazione.test.ts`, contro la
     * rotta e con `linkOrCreateParent` VERO.
     *
     * ─── L'UUID DICE QUELLO CHE `anagrafica` NON PUÒ DIRE ───────────────────
     *
     * Fino al terzo giro la riserva era `modo === 'ricerca'`, e lasciava aperto il
     * caso opposto: sul ramo «adulto nuovo», col codice fiscale di un adulto GIÀ
     * collegato a quel bambino, `linkOrCreateParent` deduplica, l'upsert non
     * scrive una riga, e la schermata annunciava «Collegamento salvato» per un
     * gesto senza effetto. La rotta però dice anche CHI (`parentId`), e chi era
     * già collegato lo sa questa schermata: `collegati` è l'elenco che sta
     * rendendo, letto PRIMA della POST — `onRicarica()` parte dopo. Il confronto
     * fra i due chiude il caso senza toccare la rotta, che non è di questo lavoro.
     *
     * L'ordine dei rami, e perché nessuno è ridondante:
     *  1. `non-scritto` — il più grave, si guarda per primo.
     *  2. era già nell'elenco E la riga runtime è NATA ADESSO: il legame c'era, ma
     *     l'accesso no. Con un'email `linkOrCreateParent` crea l'identità e
     *     SPEDISCE le credenziali (`createdAuth` → `sendEmailDetailed`): dire
     *     «non è stato aggiunto niente di nuovo» negherebbe una email partita
     *     davvero verso una famiglia vera. Vale solo per `modo === 'nuovo'`,
     *     perché sul ramo della ricerca nessuna credenziale parte.
     *  3. c'era già: o perché l'uuid tornato indietro è uno dell'elenco, o perché
     *     — sulla sola ricerca — l'ha detto il server (due segreterie sulla stessa
     *     famiglia fra la ricerca e la POST: lì l'elenco a schermo non lo sa).
     *  4. `senza-account`: il legame c'è, l'adulto non ha ancora un accesso. Non è
     *     un guasto (64 anagrafiche su 747 stanno così) e l'unica cosa da fare è
     *     mandargli le credenziali.
     */
    const avvisoDaEsito = (esito: EsitoScrittura, modo: ModoAggiunta): Avviso => {
        // L'elenco è quello di PRIMA della scrittura: `onCollegato` chiama questa
        // funzione e solo dopo `onRicarica()`.
        //
        // ⚠️ IL CONFRONTO VALE SOLO SULLA SCHEDA DEL BAMBINO, e il `verso` non è di
        // troppo: `collegati[].id` è l'ALTRO capo del legame — `parents.id` qui,
        // `alunni.id` sulla scheda dell'adulto. Là un `parentId` non può stare in
        // quell'elenco per costruzione, quindi il confronto uscirebbe sempre
        // `false`: vero per caso, cioè il tipo di correttezza che smette di essere
        // vera senza che nessun test se ne accorga. Il ramo «adulto nuovo» —
        // l'unico in cui `anagrafica` non distingue niente — da quella scheda non
        // esiste (un bambino non si crea da lì: ha sede, classe e consensi).
        const eraNellElenco =
            verso === 'genitori' &&
            typeof esito.parentId === 'string' &&
            collegati.some((v) => v.id === esito.parentId);

        if (esito.runtime === 'non-scritto') return { tono: 'attenzione', testo: t('legamiRuntimeNonScritto') };
        if (eraNellElenco && modo === 'nuovo' && esito.runtime === 'creato')
            return { tono: 'attenzione', testo: t('legamiNuovoAccessoCreato') };
        if ((eraNellElenco || (modo === 'ricerca' && esito.anagrafica === 'gia-presente')) && esito.runtime !== 'creato')
            return { tono: 'attenzione', testo: t('legamiGiaPresente') };
        if (esito.runtime === 'senza-account') return { tono: 'attenzione', testo: t('legamiSenzaAccount') };
        return { tono: 'ok', testo: t('legamiCollegato') };
    };

    /**
     * Il 200 di cui non si è potuto leggere il corpo (rilievo 3): la scrittura
     * quasi certamente c'è stata, ma NON si sa che cosa è successo — e quello che
     * si perde è proprio `runtime: 'non-scritto'`. Si dice, invece di affermare un
     * esito riuscito che nessuno ha verificato; l'elenco si rilegge lo stesso.
     */
    const avvisoNonLetto = (): Avviso => ({ tono: 'attenzione', testo: t('legamiEsitoNonLetto') });

    // ⚠️ DOPO GLI HOOK, non prima: `useState`/`useRef`/`useEffect` qui sopra devono
    // girare a ogni render, altrimenti l'ordine dei hook cambia col valore di una
    // prop. Da qui in giù `capiPresenti` è sempre vero, e le funzioni non ripetono
    // la guardia: una guardia irraggiungibile sembra proteggere e non protegge.
    if (!capiPresenti) return null;

    const esegui = async (corpo: CorpoLegame, chiave: string, alRiuscito: (esito: EsitoScrittura) => Avviso) => {
        if (inVoloRef.current) return false;
        inVoloRef.current = true;
        setInCorso(chiave);
        try {
            const esito = await scriviLegame(corpo, t('legamiErroreGenerico'));
            if (!esito.ok) {
                setAvviso({ tono: 'guasto', testo: esito.testo });
                return false;
            }
            setAvviso(esito.letto ? alRiuscito(esito.dati) : avvisoNonLetto());
            // L'elenco si rilegge SEMPRE, anche quando il server dice «era già così»:
            // è l'unico modo perché il gesto successivo parta da ciò che c'è davvero.
            await onRicarica();
            return true;
        } finally {
            inVoloRef.current = false;
            setInCorso(null);
        }
    };

    const cambiaRuolo = async (voce: VoceLegame, nuovo: RuoloLegame) => {
        await esegui(
            { azione: 'cambia-ruolo', ...capi(voce.id), relation_type: nuovo },
            `ruolo-${voce.id}`,
            () => ({ tono: 'ok', testo: t('legamiRuoloSalvato') }),
        );
    };

    const confermaScollegamento = async () => {
        const voce = daScollegare;
        if (!voce || inVoloRef.current) return;
        inVoloRef.current = true;
        setInCorso(`scollega-${voce.id}`);
        setErroreScollega(null);
        try {
            const esito = await scriviLegame({ azione: 'scollega', ...capi(voce.id) }, t('legamiErroreGenerico'));
            if (!esito.ok) {
                // Il dialogo RESTA APERTO: sul 409 dell'ultimo genitore il rimedio è
                // scritto lì dentro, e chiuderlo lo farebbe leggere a nessuno.
                setErroreScollega({ testo: esito.testo, codice: esito.codice });
                if (esito.codice === CODICE_MEZZO_TOLTO) {
                    // ⚠️ QUESTO RIFIUTO HA CAMBIATO QUALCOSA, ed è l'unico. La riga di
                    // `legame_genitori_alunni` è già andata: quell'adulto non vede più
                    // pagamenti, incassi e note del bambino, mentre l'elenco qui sopra —
                    // che legge `student_parents` — continua a mostrarlo collegato. Il
                    // riquadro dentro il dialogo lo dice, ma il dialogo si chiude con
                    // «Annulla»: senza questa riga, chiuso il modale, di un accesso
                    // appena tolto non resterebbe traccia da nessuna parte a schermo.
                    // `attenzione` e non `guasto` perché il rimedio è ripetere lo stesso
                    // gesto, non chiamare qualcuno.
                    setAvviso({ tono: 'attenzione', testo: esito.testo });
                    // …e l'elenco si rilegge lo stesso: lo stato sul server è cambiato, e
                    // ripartire da quello vecchio è ciò che manda il gesto dopo su un 404.
                    await onRicarica();
                    return;
                }
                if (esito.codice !== CODICE_ULTIMO_GENITORE) setAvviso(null);
                return;
            }
            setDaScollegare(null);
            setAvviso(esito.letto ? { tono: 'ok', testo: t('legamiScollegato') } : avvisoNonLetto());
            await onRicarica();
        } finally {
            inVoloRef.current = false;
            setInCorso(null);
        }
    };

    const etichettaRuolo = (r: RuoloLegame) =>
        r === 'mother' ? t('ruoloMadre') : r === 'father' ? t('ruoloPadre') : t('ruoloDelegato');

    return (
        <div data-testid="gestore-legami" className="mt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">
                    {t('legamiTitolo')}
                </h4>
                <button
                    type="button"
                    onClick={() => setAggiungiAperto(true)}
                    className={btnClass('ghost', 'sm')}
                >
                    <UserPlus size={14} aria-hidden="true" />
                    {verso === 'genitori' ? t('legamiAggiungiFamiliare') : t('legamiAggiungiFiglio')}
                </button>
            </div>

            {collegati.length > 0 && (
                <ul className="mt-2 space-y-2">
                    {collegati.map((voce) => {
                        const ruoloInArchivio = eRuoloCanonico(voce.ruolo) ? voce.ruolo : '';
                        const staLavorando = inCorso === `ruolo-${voce.id}` || inCorso === `scollega-${voce.id}`;
                        return (
                            <li
                                key={voce.id}
                                data-testid={`legame-${voce.id}`}
                                className="flex flex-wrap items-center gap-2 rounded-input border border-kidville-line bg-kidville-white px-3 py-2"
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate font-barlow text-sm font-bold text-kidville-ink">{voce.nome}</span>
                                    {voce.dettaglio && (
                                        <span className="block truncate font-maven text-[11px] text-kidville-sub">{voce.dettaglio}</span>
                                    )}
                                </span>
                                <select
                                    // `aria-label` e non un `<label htmlFor>`: queste righe
                                    // vivono dentro schede che montano decine di campi con
                                    // id propri, e un id per riga è un id in più da rendere
                                    // unico a ogni punto di montaggio.
                                    aria-label={t('legamiRuoloDi', { nome: voce.nome })}
                                    value={ruoloInArchivio}
                                    onChange={(e) => void cambiaRuolo(voce, e.target.value as RuoloLegame)}
                                    className="rounded-input border-2 border-kidville-line bg-kidville-white px-2 py-1.5 font-maven text-xs text-kidville-ink focus:border-kidville-green focus:outline-none"
                                >
                                    {ruoloInArchivio === '' && (
                                        // Non scegliibile: dice che cosa c'è in archivio, non
                                        // propone di riscriverci sopra un vuoto.
                                        <option value="" disabled>
                                            {t('legamiRuoloNonIndicato')}
                                        </option>
                                    )}
                                    {RUOLI_LEGAME.map((r) => (
                                        <option key={r} value={r}>
                                            {etichettaRuolo(r)}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setErroreScollega(null);
                                        setDaScollegare(voce);
                                    }}
                                    aria-disabled={staLavorando}
                                    className={btnClass('danger', 'sm')}
                                >
                                    {staLavorando ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
                                    {t('legamiScollega')}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            {avviso !== null && (
                <p
                    // Il guasto si ANNUNCIA (`alert`), l'esito riuscito si legge (`status`):
                    // due ruoli diversi perché sono due fatti diversi.
                    role={avviso.tono === 'guasto' ? 'alert' : 'status'}
                    className={
                        avviso.tono === 'guasto'
                            ? 'mt-2 rounded-input bg-kidville-error-soft px-3 py-2 font-maven text-[12px] text-kidville-error-strong'
                            : avviso.tono === 'attenzione'
                              ? 'mt-2 rounded-input bg-kidville-warn-soft px-3 py-2 font-maven text-[12px] text-kidville-warn-strong'
                              : 'mt-2 rounded-input bg-kidville-success-soft px-3 py-2 font-maven text-[12px] text-kidville-success-strong'
                    }
                >
                    {avviso.testo}
                </p>
            )}

            {aggiungiAperto && (
                <DialogoAggiungiLegame
                    verso={verso}
                    alunnoId={alunnoId}
                    parentId={parentId}
                    nomeFisso={nomeFisso}
                    onChiudi={() => setAggiungiAperto(false)}
                    onCollegato={(esito, modo) => {
                        setAggiungiAperto(false);
                        setAvviso(esito === null ? avvisoNonLetto() : avvisoDaEsito(esito, modo));
                        void onRicarica();
                    }}
                />
            )}

            {daScollegare !== null && (
                <DialogoScollega
                    // I due nomi si montano secondo il verso: sulla scheda del bambino
                    // la riga è l'ADULTO, su quella dell'adulto è il BAMBINO.
                    nomeAdulto={verso === 'genitori' ? daScollegare.nome : nomeFisso}
                    nomeBambino={verso === 'genitori' ? nomeFisso : daScollegare.nome}
                    inCorso={inCorso === `scollega-${daScollegare.id}`}
                    errore={erroreScollega}
                    onConferma={() => void confermaScollegamento()}
                    onChiudi={() => {
                        setDaScollegare(null);
                        setErroreScollega(null);
                    }}
                />
            )}
        </div>
    );
}
