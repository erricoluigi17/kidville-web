'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { DateTimeField } from '@/components/ui/DateTimeField';
import { dataCivile } from '@/i18n/config';
import { fineGiornoCivile, oraCivile } from '@/lib/format/confini-giorno';
import { risolviScadenze } from '@/lib/avvisi/scadenze';
import type { Avviso } from './AvvisoCard';

/**
 * ─── LE DUE SCADENZE DI UN AVVISO, NEL MODULO DELLA SEGRETERIA ───────────────
 *
 * Fino al 2026-09-19 il modulo aveva UNA casella data (`<input type="date">`), e
 * la sua etichetta cambiava a runtime fra «Scadenza avviso» e «Scadenza adesione»
 * a seconda del tipo: due significati diversi nello stesso campo, mai visibili
 * insieme, e nessuna ora su una scadenza che decide chi entra in gita. Con due
 * colonne distinte (`scadenza_avviso`, `scadenza_adesione`, DDL del cantiere A2)
 * i campi diventano due e devono **coesistere**: è la sola condizione in cui ci si
 * accorge a occhio che le adesioni si chiudono DOPO che l'avviso è sparito dalla
 * bacheca — cioè l'errore che questo blocco esiste per fermare.
 *
 * ── PERCHÉ LA SCADENZA AVVISO STA FUORI E QUELLA D'ADESIONE DENTRO ──────────
 *
 * La prima vale per OGNI avviso (è `NOT NULL` in colonna), la seconda solo per
 * quelli di tipo `adesione`. Perciò la prima è sempre a schermo e la seconda è la
 * prima riga della sezione «Adesione e posti», che si monta e si smonta col tipo.
 * Fra le due c'è solo la regione viva del messaggio incrociato, che è esattamente
 * il posto in cui quel messaggio serve. Il resto della sezione arriva come
 * `children`: è `AvvisoFormAdesione`, e nasce e muore con la stessa condizione.
 *
 * ── LO STATO VIVE NEL PADRE, ANCHE SE IL CODICE STA QUI ─────────────────────
 *
 * `useScadenze()` è un hook che il MODULO chiama: i due istanti stanno nel suo
 * stato e sopravvivono allo smontaggio di questa sezione (tornare a «presa
 * visione» e poi indietro non deve cancellare niente). Qui sta il codice, non la
 * memoria — e ci sta perché la forma di quei due valori, la loro conversione e la
 * loro coerenza sono una cosa sola con i campi che li mostrano.
 *
 * Gli id arrivano dal `useId()` UNICO del modulo (`idPrefix`): l'invariante «due
 * istanze montate insieme non si rubano gli id» è provata da un lock
 * (`AvvisoForm-campi-a11y`) e resta vera solo con una sorgente di id per modulo.
 */

/** La fetta di payload che questi due campi governano. Cifre LOCALI, mai ISO. */
export interface PayloadScadenze {
    scadenza_avviso: string | null;
    scadenza_adesione: string | null;
}

/** Quale delle due scadenze obbligatorie non c'è. `null` = ci sono tutte. */
export type MotivoScadenza = 'SCADENZA_AVVISO' | 'SCADENZA_ADESIONE' | null;

/**
 * Dall'istante ISO alle cifre locali `YYYY-MM-DDTHH:MM` che il server sa leggere.
 *
 * ⚠️ Il payload non porta un ISO, e non è una preferenza: un ISO composto dal
 * client porta con sé l'orologio e il fuso del TABLET su cui si sta scrivendo. Le
 * cifre che la persona ha letto sul quadrante le àncora il server, unico posto in
 * cui l'offset di Roma è quello vero (`istanteDaLocale`). `dataCivile` e
 * `oraCivile` sono i gemelli di ritorno di quella funzione: qui non si fa
 * matematica di fuso, la si chiama.
 */
function cifreLocali(istante: string): string {
    if (!istante) return '';
    const d = new Date(istante);
    if (Number.isNaN(d.getTime())) return '';
    const ora = oraCivile(istante);
    if (!ora) return '';
    return `${dataCivile(d)}T${ora}`;
}

/**
 * Dal valore in colonna all'istante da mostrare nel campo, in MODIFICA.
 *
 * ⚠️ Una `YYYY-MM-DD` nuda — la vecchia colonna `scadenza`, che le righe storiche
 * hanno ancora — vale fino a SERA: `new Date('2026-09-19')` è mezzanotte UTC, cioè
 * le 02:00 italiane, e riaprire un avviso così mostrerebbe «02:00». Poi si salva
 * senza toccare il campo e la scadenza si accorcia di ventidue ore. È lo stesso
 * scarto per cui esistono `dataCivile()` e `confini-giorno.ts`.
 */
function istanteDaColonna(valore: string | null | undefined): string {
    if (!valore) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(valore)) return fineGiornoCivile(valore) ?? '';
    return valore;
}

/**
 * Le colonne del cantiere A2 lette da un avviso già archiviato.
 *
 * ⚠️ DEBITO DICHIARATO: `Avviso` (`AvvisoCard.tsx`) descrive ancora la riga di
 * PRIMA della migrazione — ha `scadenza`, non le due nuove — e quel file è in mano
 * a un altro intervento. La rotta quelle colonne le restituisce già
 * (`AVVISO_COLS_SCADENZE`), quindi arrivano fin qui davvero; sono `Partial` perché
 * su un DB non migrato (la CI E2E) mancano tutte e il modulo deve aprirsi lo stesso.
 */
type AvvisoArchiviato = Avviso & Partial<{ scadenza_avviso: string | null; scadenza_adesione: string | null }>;

/** I due istanti, come li tiene il modulo. */
export interface Scadenze {
    /** Istante ISO, `''` finché manca la data o l'ora. */
    avviso: string;
    adesione: string;
    setAvviso: (iso: string) => void;
    setAdesione: (iso: string) => void;
    /** Le due scadenze si contraddicono: l'adesione è STRETTAMENTE dopo l'avviso. */
    incoerenti: boolean;
    /** Il modulo non è inviabile: manca un obbligo o i due istanti si contraddicono. */
    bloccante: boolean;
    manca: MotivoScadenza;
    payload: PayloadScadenze;
    azzera: () => void;
    daRecord: (avviso: Avviso) => void;
}

export function useScadenze(tipo: string): Scadenze {
    // Lo stato tiene l'ISTANTE, che è ciò che `DateTimeField` scambia con noi; le
    // cifre locali si ricavano al momento di spedire. Il verso opposto metterebbe
    // la conversione del fuso in due posti.
    const [avviso, setAvviso] = useState('');
    const [adesione, setAdesione] = useState('');

    const avvisoLocale = cifreLocali(avviso);
    const adesioneLocale = cifreLocali(adesione);

    // 🔴 LA SECONDA SCADENZA COM'È NEL CORPO CHE PARTE, calcolata UNA volta e usata
    // sia per giudicarla sia per spedirla. Fuori dagli avvisi di adesione è `''`
    // anche se lo stato tiene ancora un istante: tornare a «presa visione» non
    // cancella ciò che si era scritto, lo esclude dal payload. Due espressioni
    // separate — una nel controllo, una nel payload — è esattamente ciò che le ha
    // fatte divergere la prima volta (vedi il riquadro qui sotto).
    const adesioneDaInviare = tipo === 'adesione' ? adesioneLocale : '';

    // ⚠️ Il confronto scatta SOLO a istanti completi: a metà digitazione uno dei due
    // non esiste ancora, e «le scadenze non sono coerenti» detto di un campo che si
    // sta ancora scrivendo è un rimprovero a chi sta facendo la cosa giusta.
    //
    // ⚠️ `vietaPassato: false`, e non è una dimenticanza: lo stesso modulo serve la
    // MODIFICA, dove una scadenza nel passato non è un errore ma il gesto con cui la
    // segreteria chiude subito un avviso (la gita è annullata). Il divieto sul POST
    // resta nella rotta, che sa se sta inserendo o aggiornando; qui no.
    //
    // `risolviScadenze` è il gemello del controllo che POST e PUT applicano: qui
    // serve a non far partire una richiesta che verrebbe rifiutata, là a rifiutarla
    // comunque. L'uguaglianza è ammessa — «le adesioni si chiudono quando l'avviso
    // sparisce» è la configurazione che si ottiene copiando la stessa data.
    //
    // 🔴 …E SI GIUDICA CIÒ CHE PARTE, cioè `adesioneDaInviare` e non lo stato: fuori
    // dagli avvisi di adesione la seconda scadenza non viaggia (il payload manda
    // `null`), quindi giudicarla bloccherebbe un corpo che il server ACCETTEREBBE —
    // POST e PUT passano `tipo` a questa stessa `risolviScadenze`, che su
    // `presa_visione` con adesione nulla torna `ok`. E lo farebbe su un campo
    // SMONTATO: il messaggio incrociato resta a schermo parlando di un campo che non
    // esiste più nella pagina, la riga «cosa manca» è vuota (nessuno dei sei motivi
    // parla di coerenza) e l'unica via d'uscita è indovinare — tornare ad
    // «Adesione», correggere, tornare indietro. È l'incidente dei 442 click su un
    // bottone morto nella sua forma nuova, ed è misurato:
    // `AvvisoForm-scadenze-adesione` («tornando a «presa visione» …»).
    const esito =
        avvisoLocale && adesioneDaInviare
            ? risolviScadenze({
                  tipo,
                  scadenzaAvvisoLocale: avvisoLocale,
                  scadenzaAdesioneLocale: adesioneDaInviare,
                  vietaPassato: false,
                  adessoISO: new Date().toISOString(),
              })
            : null;
    const incoerenti = esito !== null && !esito.ok;

    // 🔴 …E ANCHE QUI SI GIUDICA CIÒ CHE PARTE, non lo stato grezzo. Sono le STESSE
    // due espressioni che finiscono nel payload qui sotto: l'asse del *tipo* lo
    // chiude `adesioneDaInviare`, l'asse della CONVERSIONE lo chiudono
    // `avvisoLocale`/`adesioneDaInviare` al posto di `avviso`/`adesione`.
    //
    // La differenza si vede su un solo valore: quello che `istanteDaColonna` inoltra
    // VERBATIM perché non è né vuoto né una `YYYY-MM-DD` (in MODIFICA, da un record
    // il cui `scadenza_avviso` non è leggibile). Lo stato è pieno, `cifreLocali()`
    // torna `''`: giudicando lo stato la riga «cosa manca» restava vuota, il bottone
    // ACCESO, e partiva un corpo con `scadenza_avviso: null` che il server rifiuta
    // con 400 `SCADENZA_AVVISO_MANCANTE`. Su ogni altro valore le due forme sono
    // identiche; su quello, questa blocca e NOMINA il campo invece di far partire
    // una richiesta già persa.
    const manca: MotivoScadenza = !avvisoLocale
        ? 'SCADENZA_AVVISO'
        : tipo === 'adesione' && !adesioneDaInviare
          ? 'SCADENZA_ADESIONE'
          : null;

    return {
        avviso,
        adesione,
        setAvviso,
        setAdesione,
        incoerenti,
        bloccante: manca !== null || incoerenti,
        manca,
        payload: {
            scadenza_avviso: avvisoLocale || null,
            // 🔴 La STESSA variabile che il controllo qui sopra giudica: fuori dagli
            // avvisi di adesione è `''` e parte `null` anche se lo stato tiene ancora
            // un istante. Scritta due volte, questa regola è già divergita una volta
            // dal suo controllo, con l'effetto descritto nel riquadro di `esito`.
            scadenza_adesione: adesioneDaInviare || null,
        },
        azzera: () => {
            setAvviso('');
            setAdesione('');
        },
        daRecord: (record: Avviso) => {
            const r = record as AvvisoArchiviato;
            setAvviso(istanteDaColonna(r.scadenza_avviso ?? r.scadenza));
            setAdesione(istanteDaColonna(r.scadenza_adesione));
        },
    };
}

/** Le stringhe e gli id di UNA delle due scadenze. Nessun testo è scritto qui dentro. */
interface CampoScadenzaProps {
    idGruppo: string;
    idData: string;
    idOra: string;
    idAiuto: string;
    idMancante: string;
    /** L'id del messaggio incrociato, condiviso dai due campi. */
    idErroreIncrociato: string;
    etichettaGruppo: string;
    /**
     * «Data» e «Ora» arrivano dal chiamante con la CHIAVE SCRITTA PER ESTESO
     * (`formScadenzaAvvisoData`, `formScadenzaAdesioneOra`, …): le due coppie dicono
     * oggi la stessa parola, e usarne una sola renderebbe le altre due chiavi morte
     * in due lingue senza che nessuno se ne accorga.
     */
    etichettaData: string;
    etichettaOra: string;
    aiuto: string;
    value: string;
    onChange: (iso: string) => void;
}

const CLASSI_CAMPO =
    'w-full border-2 border-kidville-line rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white ' +
    'focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all';

/**
 * ⚠️ `mancaData`/`mancaOra` è l'UNICO stato che vive dentro questi componenti, e
 * non è un valore: non finisce in nessun payload e muore con la modale. È lo stato
 * di INTERAZIONE «questo campo è stato lasciato vuoto», e il padre non potrebbe
 * dedurlo — `DateTimeField` gli consegna `''` sia quando manca la data sia quando
 * manca l'ora, perché senza entrambe non c'è istante. Chi deve distinguere i due
 * casi deve guardare i due controlli, e li guarda qui.
 *
 * Compare al BLUR e non alla battuta: «indica la data» scritto mentre la si sta
 * digitando è un rimprovero a chi sta già facendo la cosa giusta.
 */
function CampoScadenza({
    idGruppo,
    idData,
    idOra,
    idAiuto,
    idMancante,
    idErroreIncrociato,
    etichettaGruppo,
    etichettaData,
    etichettaOra,
    aiuto,
    value,
    onChange,
}: CampoScadenzaProps) {
    const t = useTranslations('teacherComunicazioni');
    const [mancaData, setMancaData] = useState(false);
    const [mancaOra, setMancaOra] = useState(false);

    // `onBlur` in React è `focusout`: RISALE dai due controlli a questo contenitore,
    // e `e.target` è il campo che ha davvero perso il fuoco. Nessun ref e nessuna
    // query sul DOM: quegli id li abbiamo scritti noi due righe più su.
    const alBlur = (e: React.FocusEvent<HTMLDivElement>) => {
        const campo = e.target as HTMLInputElement;
        const vuoto = (campo.value ?? '').trim() === '';
        if (campo.id === idData) setMancaData(vuoto);
        else if (campo.id === idOra) setMancaOra(vuoto);
    };

    // Si torna a scrivere: il rimprovero sparisce subito e il blur lo rifarà se
    // serve. Un messaggio che resta mentre si corregge è indistinguibile da un
    // messaggio che non si aggiorna più.
    const cambia = (iso: string) => {
        setMancaData(false);
        setMancaOra(false);
        onChange(iso);
    };

    const mancanze = [mancaData ? t('formScadenzaDataMancante') : '', mancaOra ? t('formScadenzaOraMancante') : '']
        .filter(Boolean)
        .join(' ');

    return (
        <div onBlur={alBlur}>
            {/* Intestazione del GRUPPO: i controlli sono due, e un `<label>` per due
                campi non ne etichetta nessuno. Le `<label>` vere — «Data» e «Ora» —
                le rende `DateTimeField` sui singoli controlli. */}
            <span id={idGruppo} className="font-maven font-medium text-xs text-kidville-sub uppercase tracking-wide mb-1.5 block">
                {etichettaGruppo}
            </span>
            <DateTimeField
                value={value}
                onChange={cambia}
                idData={idData}
                idOra={idOra}
                labelledBy={idGruppo}
                // I tre bersagli su ENTRAMBI i controlli: l'aiuto, ciò che manca a
                // questo campo, e il messaggio che riguarda i due insieme.
                aria-describedby={`${idAiuto} ${idMancante} ${idErroreIncrociato}`}
                required
                etichettaData={etichettaData}
                etichettaOra={etichettaOra}
                className={CLASSI_CAMPO}
            />
            <p className="font-maven text-xs text-kidville-sub mt-1.5" id={idAiuto}>
                {aiuto}
            </p>
            {/* Nasce VUOTO e resta nell'albero: è il bersaglio di `aria-describedby`,
                e un id che compare e scompare è un riferimento rotto per metà vita. */}
            <p id={idMancante} className={mancanze ? 'flex items-center gap-1.5 font-maven text-xs text-kidville-error mt-1' : ''}>
                {mancanze && <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />}
                {mancanze}
            </p>
        </div>
    );
}

export interface AvvisoFormScadenzeProps {
    /** Il `useId()` unico del modulo: qui dentro non se ne chiama un altro. */
    idPrefix: string;
    tipo: 'presa_visione' | 'adesione';
    scadenze: Scadenze;
    /** Il resto della sezione «Adesione e posti». Monta e smonta con essa. */
    children?: ReactNode;
}

export function AvvisoFormScadenze({ idPrefix, tipo, scadenze, children }: AvvisoFormScadenzeProps) {
    const t = useTranslations('teacherComunicazioni');
    const idErrore = `${idPrefix}-scad-errore`;
    const idSezione = `${idPrefix}-adesione-sezione`;

    return (
        <>
            <CampoScadenza
                idGruppo={`${idPrefix}-scad-avviso`}
                idData={`${idPrefix}-scad-avviso-data`}
                idOra={`${idPrefix}-scad-avviso-ora`}
                idAiuto={`${idPrefix}-scad-avviso-aiuto`}
                idMancante={`${idPrefix}-scad-avviso-manca`}
                idErroreIncrociato={idErrore}
                etichettaGruppo={t('formScadenzaAvviso')}
                etichettaData={t('formScadenzaAvvisoData')}
                etichettaOra={t('formScadenzaAvvisoOra')}
                aiuto={t('formScadenzaAvvisoAiuto')}
                value={scadenze.avviso}
                onChange={scadenze.setAvviso}
            />

            {/* ── IL MESSAGGIO INCROCIATO, FRA I DUE CAMPI ────────────────────
                `aria-live="polite"` e NON `role="alert"`: l'alert di questa modale è
                già uno — il riquadro in testa, che porta il rifiuto del server — e
                due regioni assertive nella stessa finestra si accavallano
                nell'annuncio, col risultato che se ne sente una sola e non si sa
                quale. La regione nasce vuota e vive quanto il modulo: uno screen
                reader annuncia i CAMBIAMENTI di una regione che era già lì. Icona +
                testo, perché il colore da solo non basta (WCAG 1.4.1). */}
            <div aria-live="polite">
                <p
                    id={idErrore}
                    className={
                        scadenze.incoerenti
                            ? 'flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-4 py-2.5 font-maven text-xs text-kidville-error'
                            : ''
                    }
                >
                    {scadenze.incoerenti && (
                        <>
                            <AlertTriangle size={14} strokeWidth={1.8} aria-hidden="true" className="mt-0.5 shrink-0" />
                            <span>{t('formErroreAdesioneOltreAvviso')}</span>
                        </>
                    )}
                </p>
            </div>

            {tipo === 'adesione' && (
                // Un `role="group"` e non un `<section>`: una landmark dentro un
                // dialogo aggiunge un punto di navigazione che non è una regione
                // della pagina, mentre questi sono campi da leggere insieme.
                <div role="group" aria-labelledby={idSezione} className="space-y-4 rounded-2xl border border-kidville-line bg-kidville-cream p-3">
                    <h3 id={idSezione} className="font-barlow font-black text-xs text-kidville-green uppercase tracking-wide">
                        {t('formAdesioneSezione')}
                    </h3>
                    <CampoScadenza
                        idGruppo={`${idPrefix}-scad-adesione`}
                        idData={`${idPrefix}-scad-adesione-data`}
                        idOra={`${idPrefix}-scad-adesione-ora`}
                        idAiuto={`${idPrefix}-scad-adesione-aiuto`}
                        idMancante={`${idPrefix}-scad-adesione-manca`}
                        idErroreIncrociato={idErrore}
                        etichettaGruppo={t('formScadenzaAdesione')}
                        etichettaData={t('formScadenzaAdesioneData')}
                        etichettaOra={t('formScadenzaAdesioneOra')}
                        aiuto={t('formScadenzaAdesioneAiuto')}
                        value={scadenze.adesione}
                        onChange={scadenze.setAdesione}
                    />
                    {children}
                </div>
            )}
        </>
    );
}
