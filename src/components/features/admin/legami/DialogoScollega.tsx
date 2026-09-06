'use client';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * SCOLLEGARE — la conferma DICE CHE COSA SI PERDE, e chi lo perde.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Non è «togliere una riga da un elenco»: è il gesto che toglie a un adulto la
 * vista su un minore. Da quel momento quell'adulto non vede più il diario, la
 * galleria, i pagamenti e i messaggi di quel bambino — e la conferma lo scrive
 * con i due nomi dentro, perché una segreteria lavora su più schede aperte e
 * «Confermi?» non dice CHI da CHI.
 *
 * Si dice anche il contrappeso, sempre: l'anagrafica dell'adulto resta, e tutto
 * ciò che è già registrato resta. Un elenco di perdite senza ciò che rimane è
 * metà informazione, e su quella metà si decide.
 *
 * ─── IL 409 È UNA PROTEZIONE, NON UN GUASTO ────────────────────────────────
 *
 * `LEGAME_ULTIMO_GENITORE` significa che quello è l'unico adulto collegato: se
 * lo si togliesse, quel bambino non lo vedrebbe più nessun genitore, e l'unico
 * modo di ricollegarlo sarebbe questa stessa schermata. Perciò qui non si
 * dipinge di rosso con l'aria di qualcosa da riprovare: si dipinge come
 * l'avviso che è, con la frase di catalogo che porta già il RIMEDIO (prima si
 * collega l'altro genitore, poi si scollega questo), e il comando «Scollega»
 * SPARISCE — ripremerlo darebbe lo stesso identico rifiuto, ed è il modo di
 * trasformare una protezione in un guasto agli occhi di chi la incontra.
 *
 * ─── IL 500 CHE NON È «NON È SUCCESSO NIENTE» ──────────────────────────────
 *
 * `LEGAME_MEZZO_TOLTO` (nato nella rotta il 2026-09-06) dice che il gesto è
 * riuscito a METÀ: la riga di `legame_genitori_alunni` — quella che le policy
 * RLS di `pagamenti`, `incassi` e `note_disciplinari` interrogano — è già
 * sparita, quella di `student_parents` no. Cioè quell'adulto ha GIÀ perso la
 * vista sui dati di quel minore, mentre l'elenco della famiglia continua a
 * mostrarlo collegato: la schermata e il database dicono due cose diverse, e
 * senza questo riquadro l'unico posto in cui il fatto è scritto è `app_log`.
 *
 * Non si dipinge come gli altri 500 rossi, che significano tutti «niente è
 * cambiato, riprova»: qui qualcosa È cambiato, ed è la metà che toglie un
 * accesso. Il comando RESTA (a differenza della protezione qui sopra) perché
 * ripetere lo scollegamento è esattamente il rimedio — la seconda cancellazione
 * è idempotente e chiude la metà rimasta.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, ShieldCheck, Unlink, Unplug } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { btnClass } from '@/components/ui/Btn';

/** Il codice con cui la rotta dichiara la protezione dell'ultimo adulto. */
export const CODICE_ULTIMO_GENITORE = 'LEGAME_ULTIMO_GENITORE';

/**
 * Il codice con cui la rotta dichiara lo scollegamento riuscito a METÀ.
 *
 * Sta qui accanto all'altro, e non dentro il componente, perché lo legge anche
 * `GestoreLegami`: là serve a far SOPRAVVIVERE l'avviso alla chiusura di questo
 * dialogo — chiuso il modale, di un accesso già tolto non resterebbe traccia a
 * schermo.
 */
export const CODICE_MEZZO_TOLTO = 'LEGAME_MEZZO_TOLTO';

interface Props {
    /** I due nomi del legame. A schermo va il nome, mai l'uuid. */
    nomeAdulto: string;
    nomeBambino: string;
    inCorso: boolean;
    /** L'ultimo rifiuto del server: testo già tradotto e codice, per distinguerlo. */
    errore: { testo: string; codice: string | null } | null;
    onConferma: () => void;
    onChiudi: () => void;
}

export function DialogoScollega({ nomeAdulto, nomeBambino, inCorso, errore, onConferma, onChiudi }: Props) {
    const t = useTranslations('adminStudents');
    const protezione = errore?.codice === CODICE_ULTIMO_GENITORE;
    const mezzoTolto = errore?.codice === CODICE_MEZZO_TOLTO;

    return (
        <Modal
            open
            onClose={onChiudi}
            title={t('legamiScollegaTitolo', { adulto: nomeAdulto, bambino: nomeBambino })}
            // Non si chiude cliccando fuori: è una conferma, e un click distratto
            // sullo sfondo non deve poter essere scambiato per un annullamento.
            closeOnBackdrop={false}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl"
        >
            <div className="mb-3 flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error-strong">
                    <Unlink size={22} strokeWidth={1.9} aria-hidden="true" />
                </div>
                <h2 className="font-barlow text-lg font-bold uppercase leading-tight text-kidville-green">
                    {t('legamiScollegaTitolo', { adulto: nomeAdulto, bambino: nomeBambino })}
                </h2>
            </div>

            {/* CHE COSA SI PERDE, con i due nomi dentro. */}
            <p className="flex items-start gap-2 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {t('legamiScollegaPerdita', { adulto: nomeAdulto, bambino: nomeBambino })}
            </p>

            {/* E che cosa RESTA: senza, la frase qui sopra si legge come «cancella l'adulto». */}
            <p className="mt-2 flex items-start gap-2 font-maven text-[13px] text-kidville-ink">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-kidville-green" aria-hidden="true" />
                {t('legamiScollegaResta')}
            </p>

            {errore !== null &&
                (protezione ? (
                    <div
                        role="alert"
                        data-testid="legami-protezione"
                        className="mt-3 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong"
                    >
                        <p className="font-barlow text-sm font-extrabold uppercase tracking-[0.03em]">
                            {t('legamiProtezioneTitolo')}
                        </p>
                        <p className="mt-1">{errore.testo}</p>
                    </div>
                ) : mezzoTolto ? (
                    /* Lo stato a METÀ ha un riquadro suo perché è l'unico 500 dopo il quale
                       qualcosa È cambiato: l'accesso ai dati del bambino è già tolto. Un
                       rosso identico agli altri lo farebbe leggere come «non è successo
                       niente», che qui è il contrario del vero. */
                    <div
                        role="alert"
                        data-testid="legami-mezzo-tolto"
                        className="mt-3 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong"
                    >
                        <p className="flex items-center gap-2 font-barlow text-sm font-extrabold uppercase tracking-[0.03em]">
                            <Unplug size={16} className="shrink-0" aria-hidden="true" />
                            {t('legamiMezzoToltoTitolo')}
                        </p>
                        <p className="mt-1">{errore.testo}</p>
                    </div>
                ) : (
                    <p role="alert" className="mt-3 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong">
                        {errore.testo}
                    </p>
                ))}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={onChiudi} className={btnClass('ghost', 'sm')}>
                    {protezione ? t('legamiChiudi') : t('legamiAnnulla')}
                </button>
                {/* Sulla protezione il comando non si ripropone: darebbe lo stesso
                    rifiuto, e il rimedio è un'altra cosa (collegare l'altro genitore). */}
                {!protezione && (
                    <button
                        type="button"
                        onClick={onConferma}
                        aria-disabled={inCorso}
                        className={btnClass('danger', 'sm')}
                    >
                        {inCorso ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Unlink size={14} aria-hidden="true" />}
                        {t('legamiScollegaConferma')}
                    </button>
                )}
            </div>
        </Modal>
    );
}
