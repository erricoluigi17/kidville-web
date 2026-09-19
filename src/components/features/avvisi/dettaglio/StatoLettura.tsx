'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, Eye } from 'lucide-react';
import { formattaIstante } from '@/i18n/config';

/**
 * ─── LO «STATO LETTURA»: CHI HA APERTO L'AVVISO, E CHI NO ───────────────────
 *
 * La metà di questa schermata che con le adesioni non c'entra niente. Stava
 * dentro `AvvisoDetailsContent` insieme ai posti, ai tre contatori e ai tre
 * gesti della segreteria, e la convivenza non era neutra: erano due argomenti
 * nello stesso file, con due mappe di alunni che si somigliavano abbastanza da
 * potersi scambiare. Qui è un argomento solo — presa visione, nient'altro.
 *
 * ⚠️ È UN'ALTRA COSA DALLE ADESIONI, ANCHE QUANDO SEMBRA LA STESSA. Un genitore
 * può aver LETTO senza aver risposto, e può aver risposto senza che la riga porti
 * un `letto_il`. Contare le une per le altre produce numeri plausibili e falsi:
 * per questo la base qui è `letto_il`, e solo quella.
 *
 * ── I CONTI SI FANNO SUGLI ALUNNI DESTINATARI ───────────────────────────────
 *
 * Il totale è l'elenco degli alunni delle sezioni destinatarie, non il numero di
 * righe che il server ha restituito: «quanti devono ancora leggere» ha senso solo
 * contro chi l'avviso doveva raggiungere. (È la differenza con il riquadro dei
 * posti, che conta invece TUTTE le righe del server perché quella è la base con
 * cui il database applica il tetto: due domande diverse, due basi diverse, ed è
 * scritto in entrambi i posti proprio perché confonderle è già costato.)
 */

/** Un alunno destinatario: ciò che serve per incrociarlo e per mostrarlo. */
export interface AlunnoDestinatario {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione: string;
}

/** Ciò che serve di una riga di risposta per sapere CHI ha letto e QUANDO. */
export interface RigaLetta {
    student_id: string;
    letto_il: string | null;
    parent_name: string;
}

export interface RigaLettura {
    studentId: string;
    studentName: string;
    classe: string;
    parentName: string;
    /** Già formattato: la data si compone dove si conosce la lingua. */
    lettoIl: string;
}

export interface RigaNonLettura {
    studentId: string;
    studentName: string;
    classe: string;
}

export interface Letture {
    /** Gli alunni destinatari: il denominatore di ogni percentuale qui dentro. */
    totale: number;
    quantiLetti: number;
    quantiNonLetti: number;
    percentuale: number;
    letti: RigaLettura[];
    nonLetti: RigaNonLettura[];
}

/**
 * I due elenchi e i tre numeri dello stato di lettura.
 *
 * `etichettaGenitore` e `locale` arrivano da fuori invece di essere risolti qui:
 * questa è una funzione pura, la si può chiamare in una prova senza montare
 * niente, e la lingua resta una decisione di chi mostra.
 */
export function letture(
    alunni: readonly AlunnoDestinatario[],
    righe: readonly RigaLetta[],
    etichettaGenitore: string,
    locale: string,
): Letture {
    const lette = new Map(righe.filter((r) => r.letto_il).map((r) => [r.student_id, r]));
    const letti: RigaLettura[] = [];
    const nonLetti: RigaNonLettura[] = [];

    for (const alunno of alunni) {
        const nome = `${alunno.nome} ${alunno.cognome}`;
        const riga = lette.get(alunno.id);
        if (riga) {
            letti.push({
                studentId: alunno.id,
                studentName: nome,
                classe: alunno.classe_sezione,
                parentName: riga.parent_name || etichettaGenitore,
                lettoIl: riga.letto_il
                    ? formattaIstante(new Date(riga.letto_il), locale, {
                        day: 'numeric', month: 'numeric', year: 'numeric',
                        hour: 'numeric', minute: 'numeric', second: 'numeric',
                    })
                    : '-',
            });
        } else {
            nonLetti.push({ studentId: alunno.id, studentName: nome, classe: alunno.classe_sezione });
        }
    }

    const totale = alunni.length;
    return {
        totale,
        quantiLetti: letti.length,
        // Nessuna sottrazione: i due elenchi nascono dalla stessa passata e si
        // contano da soli. Una differenza fra due conteggi fatti su basi diverse è
        // il difetto che questa schermata ha già pagato sul contatore «senza
        // risposta», e non ha nessun bisogno di rinascere qui.
        quantiNonLetti: nonLetti.length,
        percentuale: totale > 0 ? Math.round((letti.length / totale) * 100) : 0,
        letti,
        nonLetti,
    };
}

/** I due riquadri in cima: quanti hanno letto, quanti no. */
export function StatLetture({ dati }: { dati: Letture }) {
    const t = useTranslations('avvisi');
    return (
        <div className="grid grid-cols-2 gap-3">
            <div className="bg-gradient-to-br from-kidville-info-soft to-kidville-info-soft border border-kidville-info/60 p-4 rounded-3xl">
                <div className="flex items-center gap-2 text-kidville-info mb-1">
                    <Eye size={16} strokeWidth={1.5} />
                    <span className="font-maven text-[10px] font-bold uppercase tracking-wider">{t('statLetti')}</span>
                </div>
                <div className="flex items-baseline gap-1.5">
                    <span className="font-barlow font-black text-2xl text-kidville-info-strong">{dati.quantiLetti}</span>
                    <span className="font-maven text-xs text-kidville-info/60">
                        {t('statSuTotale', { total: dati.totale, pct: dati.percentuale })}
                    </span>
                </div>
            </div>

            <div className="bg-gradient-to-br from-kidville-cream to-kidville-cream-dark/30 border border-kidville-line p-4 rounded-3xl">
                <div className="flex items-center gap-2 text-kidville-sub mb-1">
                    <AlertCircle size={16} strokeWidth={1.5} />
                    <span className="font-maven text-[10px] font-bold uppercase tracking-wider">{t('statNonLetti')}</span>
                </div>
                <div className="flex items-baseline gap-1.5">
                    <span className="font-barlow font-black text-2xl text-kidville-ink">{dati.quantiNonLetti}</span>
                    <span className="font-maven text-xs text-kidville-sub">{t('statFamiglie')}</span>
                </div>
            </div>
        </div>
    );
}

interface PropsElenco {
    dati: Letture;
    /** Il filtro «Classe» della colonna accanto: `all` = tutte. */
    classe: string;
    /** La ricerca testuale, già così com'è scritta nel campo. */
    ricerca: string;
    /** Altezza massima: cambia fra il drawer del docente e il cockpit. */
    maxH: string;
}

/**
 * I due elenchi con le loro linguette.
 *
 * La linguetta scelta (letti / non letti) è stato di QUESTO componente e non del
 * guscio: al cambio di avviso chi monta passa una `key`, e il ripristino avviene
 * per rimontaggio invece che con una riga di `reset` lontana da qui — una riga
 * che si dimentica, ed è il modo in cui una vista resta su un filtro di un altro
 * avviso.
 */
export function ElencoLetture({ dati, classe, ricerca, maxH }: PropsElenco) {
    const t = useTranslations('avvisi');
    const [sottoLinguetta, setSottoLinguetta] = useState<'letti' | 'non_letti'>('letti');

    const cerca = (nome: string) => nome.toLowerCase().includes(ricerca.toLowerCase());
    const diClasse = (c: string) => classe === 'all' || c === classe;

    // Chi ha letto si cerca anche per NOME DEL GENITORE: nell'elenco dei letti
    // quel nome è a schermo, e chi lo legge si aspetta di poterlo cercare. Fra i
    // non letti il genitore non c'è (non c'è nessuna riga sua), quindi cercarlo
    // sarebbe cercare un dato che nessuno vede.
    const letti = dati.letti.filter((r) => diClasse(r.classe) && (cerca(r.studentName) || cerca(r.parentName)));
    const nonLetti = dati.nonLetti.filter((r) => diClasse(r.classe) && cerca(r.studentName));

    return (
        <div className="space-y-3">
            {/* Sub tabs Letti / Non letti */}
            <div className="flex bg-kidville-neutral-soft rounded-2xl p-1 gap-1">
                <button
                    onClick={() => setSottoLinguetta('letti')}
                    className={`flex-1 py-2 font-maven text-xs font-semibold rounded-xl transition-all ${
                        sottoLinguetta === 'letti' ? 'bg-white text-kidville-green shadow-sm' : 'text-kidville-sub hover:text-kidville-ink'
                    }`}
                >
                    {t('subTabLetti', { count: letti.length })}
                </button>
                <button
                    onClick={() => setSottoLinguetta('non_letti')}
                    className={`flex-1 py-2 font-maven text-xs font-semibold rounded-xl transition-all ${
                        sottoLinguetta === 'non_letti' ? 'bg-white text-kidville-green shadow-sm' : 'text-kidville-sub hover:text-kidville-ink'
                    }`}
                >
                    {t('subTabNonLetti', { count: nonLetti.length })}
                </button>
            </div>

            <div className={`space-y-2 ${maxH} overflow-y-auto pr-1`}>
                {sottoLinguetta === 'letti' ? (
                    letti.length === 0 ? (
                        <p className="font-maven text-xs text-kidville-sub text-center py-6">{t('nessunaLettura')}</p>
                    ) : (
                        letti.map(item => (
                            <div key={item.studentId} className="flex items-center justify-between p-3 bg-white border border-kidville-line rounded-2xl shadow-sm hover:border-kidville-green/50 transition-colors">
                                <div className="min-w-0">
                                    <p className="font-barlow font-bold text-xs text-kidville-green uppercase truncate">{item.studentName}</p>
                                    <p className="font-maven text-[10px] text-kidville-sub mt-0.5 truncate">
                                        {t('genitoreClasse', { genitore: item.parentName, classe: item.classe })}
                                    </p>
                                </div>
                                <span className="font-maven text-[9px] text-kidville-sub bg-kidville-cream border border-kidville-line rounded-lg px-2 py-1 flex-shrink-0 text-right">
                                    {item.lettoIl.split(',')[0]}
                                </span>
                            </div>
                        ))
                    )
                ) : (
                    nonLetti.length === 0 ? (
                        <p className="font-maven text-xs text-kidville-sub text-center py-6">{t('tutteHannoLetto')}</p>
                    ) : (
                        nonLetti.map(item => (
                            <div key={item.studentId} className="flex items-center justify-between p-3 bg-white border border-kidville-line rounded-2xl shadow-sm hover:border-kidville-green/50 transition-colors">
                                <div>
                                    <p className="font-barlow font-bold text-xs text-kidville-green uppercase">{item.studentName}</p>
                                    <p className="font-maven text-[10px] text-kidville-sub mt-0.5">{t('soloClasse', { classe: item.classe })}</p>
                                </div>
                                <span className="flex items-center gap-1 font-maven text-[9px] font-bold text-kidville-warn bg-kidville-warn-soft border border-kidville-warn/30 rounded-lg px-2 py-1">
                                    <AlertCircle size={10} /> {t('badgeDaLeggere')}
                                </span>
                            </div>
                        ))
                    )
                )}
            </div>
        </div>
    );
}
