'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Stepper } from '@/components/ui/Stepper';
import { MIN_PREDEFINITO, MAX_PREDEFINITO, validaConfigurazione } from '@/lib/avvisi/partecipanti';
import { MAX_ETICHETTA_NUMERO, NUMERO_PARTECIPANTI_MIN, NUMERO_PARTECIPANTI_MAX_ASSOLUTO } from '@/lib/validation/avvisi';
import type { Avviso } from './AvvisoCard';

/**
 * ─── «ADESIONE E POSTI»: IL CONTATORE DI PERSONE E IL TETTO ─────────────────
 *
 * Un avviso di adesione può chiedere un NUMERO oltre al sì/no («quante persone
 * accompagneranno il bambino?») e può avere un tetto di posti. Le regole che
 * governano quei campi non vivono qui: stanno in `@/lib/avvisi/partecipanti`
 * (`validaConfigurazione`) e in `@/lib/validation/avvisi`, perché le applicano
 * anche il POST e il PUT. Questo file è il posto in cui si toccano.
 *
 * ── 1. LA BANDIERINA È UNA CHECKBOX NATIVA ──────────────────────────────────
 *
 * Non un `role="switch"` fatto a mano, non il `Toggle` di `cockpit.tsx` (che è un
 * bottone nudo: nessun nome accessibile, nessuno stato dichiarato). La checkbox
 * nativa porta con sé nome, stato, barra spaziatrice e fuoco visibile senza una
 * riga di ARIA — e questo modulo ha un lock axe da far passare.
 *
 * ── 2. I CAMPI DIPENDENTI SI SMONTANO, NON SI NASCONDONO ────────────────────
 *
 * `hidden` lascerebbe i controlli NELL'ALBERO: raggiungibili col Tab, leggibili da
 * uno screen reader e — il giorno in cui qualcuno toccasse il ramo di invio —
 * spedibili. Qui il gruppo esiste solo a bandierina accesa, e `aria-controls` lo
 * dichiara.
 *
 * ── 3. 🔴 SPEGNERE LA BANDIERINA NON CANCELLA NIENTE ────────────────────────
 *
 * I valori restano nello stato del MODULO (`useCampiAdesione`, che il modulo
 * chiama: così sopravvivono anche allo smontaggio di questa sezione quando si
 * torna a «presa visione») e smettono soltanto di finire nel payload, che manda
 * `null`. Si spegne spesso per controllare come verrà senza, e perdere la domanda
 * appena scritta a ogni tocco sarebbe punitivo.
 *
 * ── 4. IL TETTO DI POSTI STA FUORI DAI CAMPI DIPENDENTI ─────────────────────
 *
 * ⚠️ Decisione, non svista: il tetto conta PERSONE, e un'adesione senza contatore
 * vale una persona (`COALESCE(numero_partecipanti, 1)` in `@/lib/avvisi/posti`,
 * gemello della RPC). Chiuderlo dentro la bandierina vorrebbe dire che per limitare
 * i posti di una gita bisogna per forza chiedere quante persone vengono — vincolo
 * che né il database né le rotte impongono.
 *
 * ── 5. IL «NUMERO PREDEFINITO» NON C'È, E LA RAGIONE VA LETTA ───────────────
 *
 * 🔴 Il catalogo porta `formLabelPartecipantiPredefiniti` e
 * `formErrorePredefinitoFuoriIntervallo`, ma **nessuna colonna** le regge: la
 * migrazione del cantiere A2 aggiunge `numero_min`, `numero_max` e `posti_totali`,
 * e né il POST né il PUT accettano un terzo numero. Un contatore a schermo il cui
 * valore non arriva da nessuna parte e non torna indietro è un comando che mente —
 * la forma di difetto che questo repo paga più cara. Perciò non si rende: le due
 * chiavi restano in catalogo per il giorno in cui la colonna esisterà, e quel
 * giorno qui si aggiunge uno `Stepper` e in `PayloadAdesione` un campo.
 *
 * Gli id arrivano dal `useId()` unico del modulo: nessuno qui dentro.
 */

/** La fetta di payload che questa sezione governa. */
export interface PayloadAdesione {
    chiedi_numero: boolean;
    etichetta_numero: string | null;
    numero_min: number | null;
    numero_max: number | null;
    posti_totali: number | null;
}

/** Le colonne del contatore lette da un avviso già archiviato (vedi `AvvisoFormScadenze`). */
type AvvisoArchiviato = Avviso &
    Partial<{
        chiedi_numero: boolean | null;
        etichetta_numero: string | null;
        numero_min: number | null;
        numero_max: number | null;
        posti_totali: number | null;
    }>;

export interface CampiAdesione {
    chiediNumero: boolean;
    setChiediNumero: (acceso: boolean) => void;
    etichetta: string;
    setEtichetta: (testo: string) => void;
    numeroMin: number | null;
    setNumeroMin: (n: number | null) => void;
    numeroMax: number | null;
    setNumeroMax: (n: number | null) => void;
    postiTotali: number | null;
    setPostiTotali: (n: number | null) => void;
    /** Il codice di `validaConfigurazione`: `null` quando non c'è niente da dire. */
    codice: 'ETICHETTA_MANCANTE' | 'NUMERO_INTERVALLO_NON_VALIDO' | null;
    /** Il modulo non è inviabile per colpa di questi campi. */
    bloccante: boolean;
    payload: PayloadAdesione;
    azzera: () => void;
    daRecord: (avviso: Avviso) => void;
}

export function useCampiAdesione(tipo: string): CampiAdesione {
    const [chiediNumero, setChiediNumero] = useState(false);
    const [etichetta, setEtichetta] = useState('');
    const [numeroMin, setNumeroMin] = useState<number | null>(null);
    const [numeroMax, setNumeroMax] = useState<number | null>(null);
    const [postiTotali, setPostiTotali] = useState<number | null>(null);

    const acceso = tipo === 'adesione' && chiediNumero;
    // La stessa funzione che applicano POST e PUT. A contatore spento torna sempre
    // `ok`: i campi restano riempiti ma non sono più una regola da rispettare —
    // rifiutare il salvataggio per un'etichetta rimasta in un campo che non è più a
    // schermo sarebbe un rifiuto che parla di qualcosa che l'operatore non vede.
    const esito = validaConfigurazione({ chiediNumero: acceso, etichetta, min: numeroMin, max: numeroMax });

    return {
        chiediNumero,
        setChiediNumero,
        etichetta,
        setEtichetta,
        numeroMin,
        setNumeroMin,
        numeroMax,
        setNumeroMax,
        postiTotali,
        setPostiTotali,
        codice: esito.ok ? null : esito.codice,
        bloccante: !esito.ok,
        payload: {
            chiedi_numero: acceso,
            etichetta_numero: acceso ? etichetta.trim() || null : null,
            // `null` = «non l'ho indicato»: i predefiniti 1…20 li scrive il server,
            // dove stanno anche i `DEFAULT` della colonna. Deciderli qui vorrebbe
            // dire avere due posti in cui quel numero vive, e vederne cambiare uno.
            numero_min: acceso ? numeroMin : null,
            numero_max: acceso ? numeroMax : null,
            // Il tetto non dipende dalla bandierina (vedi §4) ma resta affare dei soli
            // avvisi di adesione: su una presa visione non c'è niente da contingentare.
            posti_totali: tipo === 'adesione' ? postiTotali : null,
        },
        azzera: () => {
            setChiediNumero(false);
            setEtichetta('');
            setNumeroMin(null);
            setNumeroMax(null);
            setPostiTotali(null);
        },
        daRecord: (record: Avviso) => {
            const r = record as AvvisoArchiviato;
            setChiediNumero(r.chiedi_numero === true);
            setEtichetta(r.etichetta_numero ?? '');
            setNumeroMin(r.numero_min ?? null);
            setNumeroMax(r.numero_max ?? null);
            setPostiTotali(r.posti_totali ?? null);
        },
    };
}

export interface AvvisoFormAdesioneProps {
    /** Il `useId()` unico del modulo. */
    idPrefix: string;
    campi: CampiAdesione;
    /**
     * Vero dopo un invio fermato dalla guardia: gli errori escono anche sui campi
     * che nessuno ha ancora toccato. Premere un bottone spento deve produrre una
     * spiegazione, non silenzio — è l'incidente dei 442 click.
     */
    mostraErrori: boolean;
}

const CLASSI_CAMPO =
    'w-full border-2 border-kidville-line rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white ' +
    'focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all';

const CLASSI_ETICHETTA = 'font-maven font-medium text-xs text-kidville-sub uppercase tracking-wide mb-1.5 block';
const CLASSI_ERRORE = 'flex items-start gap-1.5 font-maven text-xs text-kidville-error mt-1.5';

export function AvvisoFormAdesione({ idPrefix, campi, mostraErrori }: AvvisoFormAdesioneProps) {
    const t = useTranslations('teacherComunicazioni');
    // Stato di INTERAZIONE, non di valore: non finisce in nessun payload e muore con
    // la modale. Serve a non rimproverare un campo prima che lo si sia lasciato.
    const [domandaToccata, setDomandaToccata] = useState(false);

    const idChiedi = `${idPrefix}-chiedi-numero`;
    const idChiediAiuto = `${idPrefix}-chiedi-numero-aiuto`;
    const idDipendenti = `${idPrefix}-numero-campi`;
    const idDomanda = `${idPrefix}-domanda`;
    const idDomandaErrore = `${idPrefix}-domanda-errore`;
    const idNotaMinMax = `${idPrefix}-numero-nota`;
    const idNotaPosti = `${idPrefix}-posti-nota`;

    const domandaMancante = campi.codice === 'ETICHETTA_MANCANTE' && (domandaToccata || mostraErrori);
    // L'intervallo si mostra SUBITO: qui i due numeri ci sono entrambi e si
    // contraddicono — non è un campo «non ancora compilato», è una coppia sbagliata.
    const intervalloNonValido = campi.codice === 'NUMERO_INTERVALLO_NON_VALIDO';

    return (
        <>
            <div className="flex items-start gap-3">
                <input
                    type="checkbox"
                    id={idChiedi}
                    checked={campi.chiediNumero}
                    onChange={(e) => campi.setChiediNumero(e.target.checked)}
                    // ⚠️ `aria-controls` SOLO quando il gruppo esiste davvero: un IDREF
                    // che non risolve non è una relazione dichiarata, è un riferimento
                    // rotto — e gli strumenti che lo verificano lo trattano come tale.
                    aria-controls={campi.chiediNumero ? idDipendenti : undefined}
                    aria-describedby={idChiediAiuto}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-kidville-green"
                />
                <div className="min-w-0">
                    <label htmlFor={idChiedi} className="font-maven font-semibold text-sm text-kidville-green block">
                        {t('formChiediPartecipanti')}
                    </label>
                    <p id={idChiediAiuto} className="font-maven text-xs text-kidville-sub mt-0.5">
                        {t('formChiediPartecipantiAiuto')}
                    </p>
                </div>
            </div>

            {campi.chiediNumero && (
                <div id={idDipendenti} role="group" aria-labelledby={idChiedi} className="space-y-3">
                    <div>
                        <label htmlFor={idDomanda} className={CLASSI_ETICHETTA}>
                            {t('formLabelDomandaPartecipanti')}
                        </label>
                        <input
                            id={idDomanda}
                            value={campi.etichetta}
                            onChange={(e) => campi.setEtichetta(e.target.value)}
                            onBlur={() => setDomandaToccata(true)}
                            // Il tetto è quello della COLONNA (`varchar(120)`): lasciar
                            // digitare oltre vorrebbe dire farsi rifiutare dal server un
                            // testo che il modulo aveva accettato.
                            maxLength={MAX_ETICHETTA_NUMERO}
                            aria-required="true"
                            aria-describedby={idDomandaErrore}
                            placeholder={t('formPlaceholderDomandaPartecipanti')}
                            className={CLASSI_CAMPO}
                        />
                        <p id={idDomandaErrore} className={domandaMancante ? CLASSI_ERRORE : ''}>
                            {domandaMancante && (
                                <>
                                    <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
                                    <span>{t('formErroreDomandaMancante')}</span>
                                </>
                            )}
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-4">
                        <div>
                            <label htmlFor={`${idPrefix}-numero-min`} className={CLASSI_ETICHETTA}>
                                {t('formLabelPartecipantiMin')}
                            </label>
                            <Stepper
                                id={`${idPrefix}-numero-min`}
                                value={campi.numeroMin}
                                onChange={campi.setNumeroMin}
                                min={NUMERO_PARTECIPANTI_MIN}
                                max={NUMERO_PARTECIPANTI_MAX_ASSOLUTO}
                                consentiVuoto
                                // Il segnaposto è il valore che applicherebbe il server:
                                // `null` non è «zero», è «decidi tu», e ciò che si legge
                                // qui è il `DEFAULT` della colonna.
                                segnaposto={String(MIN_PREDEFINITO)}
                                aria-describedby={idNotaMinMax}
                                etichettaDiminuisci={t('formPartecipantiDiminuisci')}
                                etichettaAumenta={t('formPartecipantiAumenta')}
                            />
                        </div>
                        <div>
                            <label htmlFor={`${idPrefix}-numero-max`} className={CLASSI_ETICHETTA}>
                                {t('formLabelPartecipantiMax')}
                            </label>
                            <Stepper
                                id={`${idPrefix}-numero-max`}
                                value={campi.numeroMax}
                                onChange={campi.setNumeroMax}
                                min={NUMERO_PARTECIPANTI_MIN}
                                max={NUMERO_PARTECIPANTI_MAX_ASSOLUTO}
                                consentiVuoto
                                segnaposto={String(MAX_PREDEFINITO)}
                                aria-describedby={idNotaMinMax}
                                etichettaDiminuisci={t('formPartecipantiDiminuisci')}
                                etichettaAumenta={t('formPartecipantiAumenta')}
                            />
                        </div>
                    </div>
                    <p id={idNotaMinMax} className="font-maven text-xs text-kidville-sub">
                        {t('formNotaPartecipantiMinMax')}
                    </p>
                    {intervalloNonValido && (
                        <p className={CLASSI_ERRORE}>
                            <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
                            <span>{t('formErroreMinMaggioreMax')}</span>
                        </p>
                    )}
                </div>
            )}

            <div>
                <label htmlFor={`${idPrefix}-posti`} className={CLASSI_ETICHETTA}>
                    {t('formLabelPostiTotali')}
                </label>
                <Stepper
                    id={`${idPrefix}-posti`}
                    value={campi.postiTotali}
                    onChange={campi.setPostiTotali}
                    // `zPostiTotali` parte da 1: «zero posti» non è un avviso chiuso, è
                    // un avviso che non andava pubblicato. Per chiudere c'è la scadenza,
                    // che lascia leggibile ciò che si è già raccolto.
                    min={1}
                    consentiVuoto
                    aria-describedby={idNotaPosti}
                    etichettaDiminuisci={t('formPostiDiminuisci')}
                    etichettaAumenta={t('formPostiAumenta')}
                />
                <p id={idNotaPosti} className="font-maven text-xs text-kidville-sub mt-1.5">
                    {t('formNotaPostiTotali')}
                </p>
            </div>
        </>
    );
}
