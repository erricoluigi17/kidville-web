'use client';

import { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { User, Clock, CheckCircle, Timer, LogOut, X } from 'lucide-react';
import { OrarioCorreggibile, type CampoOrario } from '@/components/features/presenze/OrarioCorreggibile';
import { orariAmmessi } from '@/lib/presenze/orario-ammesso';

export type AttendanceStato = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';

export interface AttendanceRecord {
    id?: string;
    alunno_id: string;
    data: string;
    stato: AttendanceStato;
    orario_entrata: string | null;
    orario_uscita: string | null;
    /**
     * Il motivo scritto dal GENITORE comunicando l'assenza (`presenze.
     * giustificazione_testo`). Facoltativo: c'è solo se la famiglia l'ha scritto.
     *
     * Sotto quel campo il modulo del genitore dichiara «Il motivo lo leggono le
     * insegnanti della sezione»: fino al terzo collaudo, per NIDO e INFANZIA,
     * non lo leggeva nessuno — il dato veniva raccolto, conservato dodici mesi e
     * non mostrato su nessuna schermata del personale. È un dato di natura
     * sanitaria di un minore (art. 9 GDPR): non si logga MAI, e resta su questa
     * riga e nell'appello della primaria, che sono le due superfici dichiarate.
     */
    giustificazione_testo?: string | null;
}

interface Student {
    id: string;
    firstName: string;
    lastName: string;
}

// Il tipo vive ora accanto al componente che lo usa. Si ri-esporta perché la pagina
// dell'appello 0-6 lo importa da qui: cambiare anche quel percorso sarebbe un secondo
// spostamento dentro un'estrazione che vuole restare uno spostamento solo.
export type { CampoOrario };

interface Props {
    student: Student;
    record?: AttendanceRecord;
    onSetStato: (studentId: string, stato: AttendanceStato) => void;
    onCheckoutClick: (studentId: string) => void;
    isLoading?: boolean;
    /**
     * Rettifica di un ORARIO già registrato. **Opzionale, e non per pigrizia**: due
     * schermate montano questa riga senza (e i loro test lo verificano), quindi
     * senza questa prop la riga resta esattamente quella di prima — l'orario è
     * testo, e non compare nessun comando.
     */
    onSetOrario?: (studentId: string, campo: CampoOrario, ora: string) => void;
    /**
     * Quale dei due orari si sta salvando. Separato da `isLoading` di proposito:
     * `isLoading` sostituisce l'INTERO gruppo di bottoni con uno spinner, e usarlo
     * qui farebbe sparire dagli occhi della maestra proprio l'ora che sta
     * correggendo.
     */
    orarioInCorso?: CampoOrario | null;
}

// Solo i token cromatici del badge "uscita anticipata"; le etichette testuali
// vengono dal namespace i18n (t('uscitaAnt') ecc.), non da qui.
const STATO_CONFIG: Record<AttendanceStato, { color: string; bg: string; border: string }> = {
    presente: {
        color: 'text-white',
        bg: 'bg-kidville-success',
        border: 'border-kidville-success',
    },
    assente: {
        color: 'text-white',
        bg: 'bg-kidville-neutral',
        border: 'border-kidville-neutral',
    },
    ritardo: {
        color: 'text-white',
        bg: 'bg-kidville-warn',
        border: 'border-kidville-warn',
    },
    uscita_anticipata: {
        color: 'text-white',
        bg: 'bg-kidville-info',
        border: 'border-kidville-info',
    },
};

/**
 * I 3 bottoni di stato dell'appello 0-6 restano SEMPRE visibili: il docente può
 * rettificare (es. assente→presente) finché il server accetta la modifica (revoca
 * della notifica entro il buffer di 10'). Il bottone attivo è evidenziato con i token
 * Clay Village e porta aria-pressed="true"; click sull'attivo = no-op (vedi onClick).
 */
// La label di ciascun bottone arriva dal namespace i18n: `key` coincide con la
// chiave di traduzione (t('presente'|'ritardo'|'assente')).
const STATI_BOTTONI: {
    key: Extract<AttendanceStato, 'presente' | 'ritardo' | 'assente'>;
    icon: ReactNode;
    activeCls: string;
    idleCls: string;
}[] = [
    {
        key: 'presente',
        icon: <CheckCircle size={15} />,
        // attivo: bianco su green #006A5F = 6,5:1 · inattivo: green su success-soft #E7F3E8 = 5,7:1
        activeCls: 'bg-kidville-green text-white border-kidville-green',
        idleCls: 'bg-kidville-success-soft text-kidville-green border-kidville-success/30 hover:bg-kidville-green hover:text-white',
    },
    {
        key: 'ritardo',
        icon: <Timer size={15} />,
        // attivo: bianco su warn-strong #A64F09 = 5,6:1 · inattivo: warn-strong su warn-soft #FBEFE2 = 5,0:1
        activeCls: 'bg-kidville-warn-strong text-white border-kidville-warn-strong',
        idleCls: 'bg-kidville-warn-soft text-kidville-warn-strong border-kidville-warn/30 hover:bg-kidville-warn-strong hover:text-white',
    },
    {
        key: 'assente',
        icon: <X size={15} />,
        // attivo: bianco su sub #55615C = 6,5:1 · inattivo: sub su cream #FEF1E4 = 5,8:1
        activeCls: 'bg-kidville-sub text-white border-kidville-sub',
        idleCls: 'bg-kidville-cream text-kidville-sub border-kidville-line hover:bg-kidville-sub hover:text-white',
    },
];

/**
 * L'ora italiana di un orario di presenza.
 *
 * Era la settima copia di questa lettura, e l'unica che dichiarasse il fuso — ma
 * cadeva comunque sul `catch { return isoString }` per le altre due forme che la
 * colonna contiene (`08:45` e l'ISO naïve della primaria), restituendo la stringa
 * grezza. Ora passa dal motore, che le conosce tutte e tre.
 */


export function StudentAttendanceRow({ student, record, onSetStato, onCheckoutClick, isLoading, onSetOrario, orarioInCorso }: Props) {
    const t = useTranslations('teacherPresenze');
    // L'etichetta della giustifica del genitore è GIÀ tradotta (it/en) per
    // l'appello della primaria: si riusa quella invece di scriverne una gemella.
    // Due copie della stessa frase divergono al primo ritocco — è la lezione che
    // questo ciclo ha già pagato quattro volte.
    const tp = useTranslations('teacherPrimaria');
    const motivoGenitore = (record?.giustificazione_testo ?? '').trim();
    const stato = record?.stato ?? null;
    const isPresente = stato === 'presente';
    const isRitardo = stato === 'ritardo';
    const isUscitaAnticipata = stato === 'uscita_anticipata';
    const isAssente = stato === 'assente';

    const nomeAlunno = `${student.firstName} ${student.lastName}`;
    // Quali orari hanno senso, per stato: la tabella di verità sta in
    // `@/lib/presenze/orario-ammesso`, ed è LA STESSA che il server usa per il suo 422.
    // Scritta qui a mano, divergeva: fino al 2026-09-07 l'uscita si mostrava solo a chi
    // era in `uscita_anticipata`, quindi un bambino uscito all'orario normale non aveva
    // nessuna ora d'uscita da registrare.
    const ammessi = orariAmmessi(stato);
    const mostraEntrata = ammessi.entrata;
    const mostraUscita = ammessi.uscita;
    const salva = (campo: CampoOrario) =>
        onSetOrario ? (ora: string) => onSetOrario(student.id, campo, ora) : null;

    // ── Bordo sinistro = UNICO segnale cromatico dello stato della riga ──────────
    // WCAG 2.1 §1.4.11 chiede 3:1 per un segnale di stato non testuale, e i fondi
    // adiacenti qui sono DUE: la card `bg-white` e il `hover:bg-kidville-cream`.
    // I quattro colori di prima venivano dalla palette di default di Tailwind e non
    // reggevano — misurati con la formula WCAG su sRGB linearizzato (bianco / crema):
    //   #22c55e 2,28 / 2,05 · #f59e0b 2,15 / 1,93 · #3b82f6 3,68 / 3,31 · #9ca3af 2,54 / 2,29
    // Tre su quattro sotto soglia su entrambi i fondi. E `#9ca3af` è lo STESSO valore
    // che `TeacherBottomNav.tsx` documenta come già respinto per contrasto: una
    // decisione presa e mai propagata.
    // ATTENZIONE — anche i token «base» suggeriti dal collaudo (success/warn/neutral)
    // sono stati MISURATI e scartati: success #43A047 3,30 / 2,98 · warn #E6720A
    // 3,10 / 2,79 · neutral #8A958F 3,10 / 2,79 — passano appena sul bianco e
    // FALLISCONO sul crema dell'hover. Reggono invece i tre inchiostri che questo
    // stesso file usa GIÀ per i bottoni di stato (`STATI_BOTTONI`), così la riga e il
    // bottone dicono finalmente lo stesso colore (bianco / crema):
    //   · presente          green       #006A5F  6,51 / 5,86
    //   · ritardo           warn-strong #A64F09  5,61 / 5,05
    //   · uscita anticipata info        #2A6FDB  4,78 / 4,30  (tinta del badge omonimo)
    //   · assente           sub         #55615C  6,46 / 5,82
    // È una CLASSE e non più uno `style` inline: le rimappature per-superficie
    // dell'Alto Contrasto agiscono sul NOME della classe e un inline-style resta
    // irraggiungibile.
    const bordoStato = isPresente
        ? 'border-kidville-green'
        : isRitardo
        ? 'border-kidville-warn-strong'
        : isUscitaAnticipata
        ? 'border-kidville-info'
        : isAssente
        ? 'border-kidville-sub'
        : 'border-transparent';

    return (
        <motion.div
            layout
            className={`kv-appello-row bg-white p-4 rounded-2xl shadow-sm flex flex-wrap items-center justify-between gap-y-2 border-l-4 ${bordoStato} transition-colors hover:bg-kidville-cream`}
        >
            {/* Avatar + Info studente */}
            <div className="flex items-center gap-3 min-w-0">
                <div className="bg-kidville-cream w-10 h-10 rounded-full flex items-center justify-center text-kidville-green flex-shrink-0">
                    <User size={20} />
                </div>
                <div className="min-w-0">
                    <h3 className="font-barlow font-semibold text-lg text-kidville-green uppercase tracking-wide truncate">
                        {student.firstName} {student.lastName}
                    </h3>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-kidville-sub font-maven">
                        {mostraEntrata && (
                            <OrarioCorreggibile
                                campo="entrata"
                                valore={record?.orario_entrata ?? null}
                                etichetta={t('ingresso')}
                                icona={<Clock size={11} />}
                                alunno={student.id}
                                nomeAlunno={nomeAlunno}
                                ariaKey="orarioIngressoAria"
                                inCorso={orarioInCorso === 'entrata'}
                                onSalva={salva('entrata')}
                            />
                        )}
                        {mostraUscita && (
                            <OrarioCorreggibile
                                campo="uscita"
                                valore={record?.orario_uscita ?? null}
                                etichetta={t('uscita')}
                                icona={<LogOut size={11} />}
                                alunno={student.id}
                                nomeAlunno={nomeAlunno}
                                ariaKey="orarioUscitaAria"
                                inCorso={orarioInCorso === 'uscita'}
                                onSalva={salva('uscita')}
                            />
                        )}
                    </div>
                    {/* IL MOTIVO COMUNICATO DAL GENITORE — la finalità dichiarata
                        alla famiglia («il motivo lo leggono le insegnanti della
                        sezione») resa vera anche per nido e infanzia. Visibile e
                        non solo in tooltip: l'appello si fa da tablet, dove il
                        `title` non si apre. Troncato a una riga, con il testo
                        intero nel `title` per chi ha un puntatore.
                        Token misurati su bianco: warn-strong su warn-soft = 5,0:1. */}
                    {motivoGenitore && (
                        <p
                            title={motivoGenitore}
                            className="mt-1 font-maven text-xs text-kidville-warn-strong bg-kidville-warn-soft rounded-xl px-2 py-1 truncate"
                        >
                            <span className="font-semibold">{tp('appelloGiustificataDalGenitore')}:</span>{' '}
                            {motivoGenitore}
                        </p>
                    )}
                </div>
            </div>

            {/* Controlli stato — wrap sotto il nome sugli schermi stretti (320px) */}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {isLoading ? (
                    <div className="w-6 h-6 border-2 border-kidville-green border-t-transparent rounded-full animate-spin" />
                ) : (
                    <>
                        {/* 3 bottoni di stato SEMPRE visibili: consentono la rettifica.
                            Attivo → aria-pressed="true" + token pieno; click sull'attivo = no-op. */}
                        {STATI_BOTTONI.map((b) => {
                            const active = stato === b.key;
                            return (
                                <button
                                    key={b.key}
                                    id={`btn-${b.key}-${student.id}`}
                                    aria-pressed={active}
                                    onClick={() => {
                                        if (!active) onSetStato(student.id, b.key);
                                    }}
                                    className={`min-h-11 px-3 font-maven font-medium text-sm rounded-xl border transition-all flex items-center gap-1.5 ${active ? b.activeCls : b.idleCls}`}
                                >
                                    {b.icon} {t(b.key)}
                                </button>
                            );
                        })}

                        {/* Badge informativo per lo stato uscita anticipata (non ha un bottone dedicato). */}
                        {isUscitaAnticipata && (
                            <span
                                className={`min-h-11 px-3 font-maven font-semibold text-sm rounded-xl flex items-center gap-1.5 ${STATO_CONFIG.uscita_anticipata.bg} ${STATO_CONFIG.uscita_anticipata.color}`}
                            >
                                <LogOut size={15} /> {t('uscitaAnt')}
                            </span>
                        )}

                        {/* Bottone Uscita Anticipata — solo per presenti/ritardo (condizioni invariate) */}
                        {(isPresente || isRitardo) && !record?.orario_uscita && (
                            <button
                                id={`btn-uscita-${student.id}`}
                                onClick={() => onSetStato(student.id, 'uscita_anticipata')}
                                className="h-9 px-3 font-maven font-medium text-sm rounded-xl bg-kidville-info-soft text-kidville-info-strong border border-kidville-info/30 hover:bg-kidville-info hover:text-white transition-all flex items-center gap-1.5"
                            >
                                <LogOut size={15} /> {t('uscitaAnt')}
                            </button>
                        )}

                        {/* Bottone checkout delegato — condizioni invariate */}
                        {(isPresente || isRitardo) && !record?.orario_uscita && (
                            <button
                                id={`btn-checkout-${student.id}`}
                                onClick={() => onCheckoutClick(student.id)}
                                className="h-9 px-3 font-maven font-medium text-sm rounded-xl bg-kidville-yellow text-kidville-green-dark border border-kidville-yellow hover:opacity-90 transition-all"
                            >
                                {t('uscita')}
                            </button>
                        )}
                    </>
                )}
            </div>
        </motion.div>
    );
}
