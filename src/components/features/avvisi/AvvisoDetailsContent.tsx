'use client';

import { useState, useEffect, useCallback, useId } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Search, Users, ThumbsUp, ThumbsDown, HelpCircle } from 'lucide-react';
import { Avviso } from './AvvisoCard';
import { RiepilogoPosti } from './dettaglio/RiepilogoPosti';
import { ElencoAdesioni, type RigaElenco } from './dettaglio/ElencoAdesioni';
import { EsportaAdesioni } from './dettaglio/EsportaAdesioni';
import { CorreggiNumeroModal, type GestoAdesione, type RigaDaGestire } from './dettaglio/CorreggiNumeroModal';
import { numeriAdesioni } from './dettaglio/numeri-adesioni';
import { ElencoLetture, StatLetture, letture } from './dettaglio/StatoLettura';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { logClient, nomeErrore } from '@/lib/logging/client';

// Monitoraggio di un avviso (stato lettura + adesioni con filtri): contenuto
// condiviso tra il drawer mobile del docente (AvvisoDetailsDrawer) e la pagina
// cockpit /admin/avvisi/[id] (layout 'page': colonna filtri + colonna elenchi).
//
// ⚠️ QUESTO COMPONENTE È MONTATO DUE VOLTE, e la seconda volta è stretta: a tutta
// pagina nel cockpit, e dentro un drawer `max-w-md` (448 px) sul telefono del
// docente. Ogni cosa che si aggiunge qui deve reggere anche là dentro — è la
// ragione per cui il riepilogo dei posti è un riquadro a piena larghezza e non una
// quarta colonna accanto ai tre contatori.
//
// Qui restano: le letture dal server, le linguette, i filtri condivisi dalle due
// viste e l'assemblaggio dei due layout. Tutto il resto vive in `./dettaglio/` —
// lo stato di lettura (`StatoLettura`), i numeri della schermata
// (`numeri-adesioni`), il riepilogo dei posti, l'elenco delle adesioni, i tre
// gesti della segreteria e l'esportazione.
//
// Le due viste sono DUE ARGOMENTI, e stavano in un file solo: presa visione e
// adesioni si somigliano abbastanza da potersi scambiare (due mappe di alunni,
// due conteggi «su N») e abbastanza poco da dover contare su basi diverse. Il
// contatore che diceva «Senza risposta 0» con un bambino a schermo è nato
// esattamente lì in mezzo.

interface Props {
    avviso: Avviso;
    availableClasses?: string[];
    userId?: string | null;
    layout?: 'drawer' | 'page';
    /**
     * 🔴 AFFORDANCE GATE, NON UNA DIFESA.
     *
     * Decide se i comandi di scrittura sulle adesioni (correggi · ammetti · togli ·
     * esporta) ESISTONO nell'albero. La passa `admin/avvisi/[id]/page.tsx`
     * calcolandola dal ruolo di `useSessionIdentity`, che lo legge dal
     * **`localStorage`**: chiunque abbia la console del browser può scriverci
     * `admin` e far comparire i bottoni.
     *
     * La difesa è il SERVER: `PATCH /api/avvisi/[id]/risposte/[rispostaId]` e
     * `GET …/esporta` passano da `requireStaff(['admin','coordinator','segreteria'])`
     * e rispondono **403** a chiunque altro — `requireDocente` no, perché comprende
     * l'`educator` e la decisione del committente è che i docenti restino in SOLA
     * LETTURA sulle adesioni: chi va in gita lo decide la segreteria.
     *
     * Il default è `false`, e il drawer del docente non la passa affatto: così la
     * sola strada per vedere i comandi è che qualcuno ce li metta di proposito.
     */
    permessiScrittura?: boolean;
}

interface RispostaDettaglio {
    id: string;
    parent_id: string;
    student_id: string;
    letto_il: string | null;
    risposta: string | null;
    risposto_il: string | null;
    parent_name: string;
    student_name: string;
    /**
     * I due campi del cantiere delle adesioni. **Facoltativi nel tipo**, e non per
     * pigrizia: su un database non migrato (il DB E2E della CI) le colonne non
     * esistono e la rotta non le può restituire. `undefined` vale «non misurato» e
     * si comporta come l'assenza di adesione — mai come uno zero, che sarebbe
     * l'unico valore capace di far sembrare vuoto un pullman pieno.
     */
    numero_partecipanti?: number | null;
    stato_adesione?: string | null;
}

interface StudentBasic {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione: string;
}

/** I valori del filtro «Risposta». `attesa` = senza risposta; `lista_attesa` = in coda. */
type FiltroRisposta = 'given' | 'si' | 'no' | 'attesa' | 'lista_attesa';

export function AvvisoDetailsContent({
    avviso,
    availableClasses = [],
    userId,
    layout = 'drawer',
    permessiScrittura = false,
}: Props) {
    const t = useTranslations('avvisi');
    const locale = useLocale();
    /**
     * Gli id dei due filtri, per legare `<label>` e `<select>`.
     *
     * ⚠️ Le due etichette c'erano già, ma NON erano associate a niente: un
     * `<label>` senza `for` è un testo qualunque, e axe lo dice senza mezzi termini
     * («Select element must have an accessible name»). Chi usa uno screen reader
     * sentiva «menu a discesa», due volte, senza sapere quale fosse la classe e
     * quale la risposta. `useId` e non una stringa fissa: il componente può essere
     * montato due volte nella stessa pagina e due id uguali romperebbero
     * l'associazione di entrambi.
     */
    const idFiltri = useId();
    const idClasse = `${idFiltri}-classe`;
    const idRisposta = `${idFiltri}-risposta`;
    const [risposte, setRisposte] = useState<RispostaDettaglio[]>([]);
    const [targetStudents, setTargetStudents] = useState<StudentBasic[]>([]);
    const [loading, setLoading] = useState(true);

    // Elenchi separati: letture (Stato Lettura) vs risposte (Adesioni). La
    // sottolinguetta letti/non letti è stato di `ElencoLetture`, dove vive quella
    // vista: qui resterebbe solo da ricordarsi di azzerarla.
    const [mainTab, setMainTab] = useState<'letture' | 'adesioni'>('letture');

    // Filtri
    const [selectedClass, setSelectedClass] = useState<string>('all');
    const [selectedResponse, setSelectedResponse] = useState<FiltroRisposta>('given');
    const [searchQuery, setSearchQuery] = useState('');

    // Il dialogo dei tre gesti: quale riga, e con quale gesto si è aperto.
    const [rigaInModifica, setRigaInModifica] = useState<RigaDaGestire | null>(null);
    const [gesto, setGesto] = useState<GestoAdesione>('numero');

    // Reset stati filtri e viste al cambio avviso
    // (adjust-state-during-render, prior art: AvvisoForm.tsx / TaskForm.tsx)
    const [prevAvviso, setPrevAvviso] = useState<Avviso | null>(null);
    if (avviso !== prevAvviso) {
        setPrevAvviso(avviso);
        setLoading(true);
        setMainTab('letture');
        setSelectedClass('all');
        setSelectedResponse('given');
        setSearchQuery('');
        setRigaInModifica(null);
    }

    const uid = userId ?? getCurrentTeacherId(null);

    /**
     * Rilegge le SOLE risposte.
     *
     * Dopo un'ammissione o una correzione l'elenco degli alunni destinatari non è
     * cambiato di una riga: ricaricare anche quello vorrebbe dire una richiesta per
     * ogni sezione dell'avviso per un dato che si sa già. E il numero che si è
     * appena corretto deve tornare dal SERVER, non dallo stato locale: è l'unico che
     * abbia attraversato il lock su `avvisi`.
     */
    const ricaricaRisposte = useCallback(async () => {
        try {
            const res = await fetch(`/api/avvisi/${avviso.id}/risposte?userId=${uid}`);
            if (!res.ok) {
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'avviso-risposte-ricarica-non-riuscita',
                    route: '/admin/avvisi',
                    stato: res.status,
                });
                return;
            }
            setRisposte(await res.json());
        } catch (e) {
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `avviso-risposte-ricarica-fallita: ${nomeErrore(e)}`,
                route: '/admin/avvisi',
            });
        }
    }, [avviso.id, uid]);

    useEffect(() => {
        if (!avviso) return;

        const loadDetails = async () => {
            try {
                // 1. Carica le risposte/letture reali registrate nel database
                const risposteRes = await fetch(`/api/avvisi/${avviso.id}/risposte?userId=${uid}`);
                let risposteData: RispostaDettaglio[] = [];
                if (risposteRes.ok) {
                    risposteData = await risposteRes.json();
                    setRisposte(risposteData);
                }

                // 2. Determina le sezioni target
                const targetClasses = avviso.target_scope === 'globale'
                    ? availableClasses
                    : (avviso.target_classes || []);

                // 3. Carica tutti gli studenti per le sezioni target
                const studentsPromises = targetClasses.map(async (classe) => {
                    try {
                        const res = await fetch(`/api/diary/students?sezione=${encodeURIComponent(classe)}&userId=${uid}`);
                        if (res.ok) {
                            return (await res.json()) as StudentBasic[];
                        }
                    } catch (e) {
                        // Il NOME DELLA CLASSE non entra nel messaggio. Era il caso peggiore
                        // del lotto: una template string che stampava «Primavera A» nella
                        // console del telefono, cioè un dato scolastico in un canale senza
                        // redazione. Del guasto interessa la classe dell'errore, non quale
                        // sezione l'ha innescato — se falliscono tutte, si vede lo stesso.
                        logClient({ livello: 'error', evento: 'fetch', messaggio: `avviso-studenti-classe-caricamento-fallito: ${nomeErrore(e)}` });
                    }
                    return [];
                });

                const studentsLists = await Promise.all(studentsPromises);
                const mergedStudents = studentsLists.flat();

                // Rimuovi eventuali duplicati per sicurezza.
                //
                // ⚠️ NON È SOLO «PER SICUREZZA»: `numeriAdesioni` (`./dettaglio/numeri-
                // adesioni`) dimostra che `nonIncrociate` non può andare negativo
                // proprio perché qui nessun `id` si ripete. Chi tocca questa riga
                // (per esempio per rimuovere la deduplicazione, o per farla su una
                // chiave diversa da `id`) rompe quella dimostrazione: un alunno
                // duplicato farebbe contare due volte la stessa riga di risposta come
                // «incrociata», e la sottrazione potrebbe uscire negativa.
                const uniqueStudents = mergedStudents.filter((student, index, self) =>
                    self.findIndex(s => s.id === student.id) === index
                );

                setTargetStudents(uniqueStudents);
            } catch (err) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `avviso-dettagli-caricamento-fallito: ${nomeErrore(err)}` });
            } finally {
                setLoading(false);
            }
        };

        loadDetails();
    }, [avviso, availableClasses, uid]);

    /**
     * Apre il dialogo su una riga. `rispostaId` è non nullo per costruzione:
     * `ElencoAdesioni` non rende nessun comando su una riga che non ha una riga di
     * risposta — non c'è niente da correggere né da ammettere, e il server
     * risponderebbe 404 su un id che non esiste.
     */
    const apriGesto = (quale: GestoAdesione, riga: RigaElenco) => {
        if (!riga.rispostaId) return;
        setGesto(quale);
        setRigaInModifica({
            rispostaId: riga.rispostaId,
            alunno: riga.studentName,
            statoAdesione: riga.statoAdesione,
            numeroPartecipanti: riga.numeroPartecipanti,
        });
    };

    const isAdesione = avviso.tipo === 'adesione';
    const isPage = layout === 'page';
    const listMaxH = isPage ? 'max-h-[58vh]' : 'max-h-[300px]';
    const listMaxHAdesioni = isPage ? 'max-h-[58vh]' : 'max-h-[350px]';

    /**
     * Il tetto dei posti, letto in modo difensivo.
     *
     * `posti_totali` NON è (ancora) dichiarato nell'interfaccia `Avviso`, che vive
     * in `AvvisoCard.tsx` — un file di un altro cantiere. La rotta staff lo
     * restituisce (`GET /api/avvisi/[id]` fa `select('*')`), ma su un ambiente non
     * migrato arriva `undefined`: `null` significa «nessun tetto» ed è anche il
     * ripiego giusto per «la colonna non c'è», perché in entrambi i casi non c'è
     * niente da confrontare. Quando il tipo sarà aggiornato, questo cast sparisce.
     */
    const postiTotali = (avviso as { posti_totali?: number | null }).posti_totali ?? null;

    // Sezioni/Classi target per l'avviso corrente
    const targetClasses = avviso.target_scope === 'globale'
        ? availableClasses
        : (avviso.target_classes || []);

    /**
     * Lo STATO LETTURA, che con le adesioni non c'entra: i due elenchi e i tre
     * numeri vivono in `./dettaglio/StatoLettura`, insieme alla loro base
     * (`letto_il`) e alla spiegazione di perché quella base è un'altra.
     */
    const datiLetture = letture(targetStudents, risposte, t('genitoreFallback'), locale);

    const listAdesioni: RigaElenco[] = targetStudents.map(student => {
        const resp = risposte.find(r => r.student_id === student.id);
        return {
            studentId: student.id,
            // Senza una riga di risposta non c'è niente da correggere né da ammettere:
            // i comandi di quella riga non si rendono affatto.
            rispostaId: resp?.id ?? null,
            studentName: `${student.nome} ${student.cognome}`,
            classe: student.classe_sezione,
            parentName: resp?.parent_name || t('genitoreFallback'),
            risposta: resp?.risposta || 'attesa', // 'si' | 'no' | 'attesa' (= SENZA RISPOSTA)
            statoAdesione: resp?.stato_adesione ?? null, // 'ammessa' | 'in_attesa' (= LISTA D'ATTESA)
            numeroPartecipanti: resp?.numero_partecipanti ?? null,
        };
    });

    /**
     * 🔴 TUTTI I NUMERI DI QUESTA SCHERMATA, DA UNA FUNZIONE SOLA.
     *
     * I tre contatori Sì/No/Senza risposta e il riquadro dei posti escono di qui
     * insieme, e non da due conti scritti a venti righe di distanza. Fino al
     * 2026-09-19 «senza risposta» era `Math.max(0, totalTarget − (siCount +
     * noCount))`, con il minuendo preso dagli alunni INCROCIATI e il sottraendo da
     * TUTTE le righe del server: bastava una risposta di un bambino uscito dalle
     * sezioni destinatarie perché la sottrazione attraversasse due basi e dicesse
     * «Senza risposta 0» mentre quel bambino era a schermo. E il `Math.max(0, …)`
     * ingoiava il negativo in silenzio — la forma del `?? 0` che in questo repo ha
     * congelato per sempre lo stato SDI di una fattura.
     *
     * `numeriAdesioni` riceve le due basi ed è il posto in cui la loro differenza
     * ha un nome (`nonIncrociate`): la spiegazione sta nella testata di
     * `./dettaglio/numeri-adesioni`.
     */
    const numeri = numeriAdesioni(listAdesioni, risposte, postiTotali);

    /**
     * Quante righe il CSV conterrebbe: a zero non si chiama il server.
     *
     * Si contano TUTTE le righe di risposta, comprese le sole prese visione: è
     * esattamente ciò che la rotta di esportazione mette nel file. Contare le sole
     * adesioni direbbe «non c'è niente da esportare» davanti a un file che sarebbe
     * uscito con dentro trenta nomi.
     */
    const nRigheEsportabili = risposte.length;

    // Ricerca testuale
    const filterQuery = (name: string) => name.toLowerCase().includes(searchQuery.toLowerCase());

    // Applicazione filtri per Stato Adesione
    const filteredAdesioni = listAdesioni.filter(item => {
        // Filtro Classe
        const matchClass = selectedClass === 'all' || item.classe === selectedClass;
        // Filtro Ricerca
        const matchSearch = filterQuery(item.studentName) || filterQuery(item.parentName);
        // Filtro Risposta. ⚠️ `attesa` e `lista_attesa` sono DUE COSE DIVERSE:
        // la prima è «non ha ancora risposto», la seconda «ha risposto sì ma i
        // posti erano finiti». Unirle farebbe telefonare alle famiglie sbagliate.
        let matchResponse = false;
        if (selectedResponse === 'given') {
            matchResponse = item.risposta === 'si' || item.risposta === 'no';
        } else if (selectedResponse === 'si') {
            matchResponse = item.risposta === 'si';
        } else if (selectedResponse === 'no') {
            matchResponse = item.risposta === 'no';
        } else if (selectedResponse === 'attesa') {
            matchResponse = item.risposta === 'attesa';
        } else if (selectedResponse === 'lista_attesa') {
            matchResponse = item.statoAdesione === 'in_attesa';
        }
        return matchClass && matchSearch && matchResponse;
    });

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
                <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                <p className="font-maven text-xs text-kidville-sub">{t('analisiInCorso')}</p>
            </div>
        );
    }

    const tabsBlock = isAdesione ? (
        <div className="flex border-b border-kidville-line bg-white gap-4">
            <button
                onClick={() => {
                    setMainTab('letture');
                    setSelectedClass('all');
                }}
                className={`py-3 text-xs font-barlow font-bold uppercase tracking-wider border-b-2 transition-all ${
                    mainTab === 'letture'
                        ? 'border-kidville-green text-kidville-green'
                        : 'border-transparent text-kidville-sub hover:text-kidville-green'
                }`}
            >
                {t('tabStatoLettura')}
            </button>
            <button
                onClick={() => {
                    setMainTab('adesioni');
                    setSelectedClass('all');
                    setSelectedResponse('given');
                }}
                className={`py-3 text-xs font-barlow font-bold uppercase tracking-wider border-b-2 transition-all ${
                    mainTab === 'adesioni'
                        ? 'border-kidville-green text-kidville-green'
                        : 'border-transparent text-kidville-sub hover:text-kidville-green'
                }`}
            >
                {t('tabAdesioni')}
            </button>
        </div>
    ) : null;

    const statsBlock = mainTab === 'letture' ? (
        <StatLetture dati={datiLetture} />
    ) : (
        <div className="space-y-3">
            <div className="bg-kidville-info-soft/50 border border-kidville-info/60 p-4 rounded-3xl space-y-3">
                {/* `h2` e non `h4`: il guscio che monta questo blocco porta un `h1`
                    (pagina) o un `h2` (drawer), e saltare da lì a un `h4` è un ordine
                    di intestazioni non valido — axe lo segnala, e chi naviga per
                    intestazioni si trova un buco dove si aspetta una sezione. */}
                <h2 className="font-barlow font-bold text-xs text-kidville-info uppercase tracking-wide flex items-center gap-1.5">
                    <Users size={14} strokeWidth={1.5} aria-hidden="true" /> {t('dettaglioAdesioni')}
                </h2>
                <div className="grid grid-cols-3 gap-2">
                    <div className="bg-white/80 rounded-2xl p-2.5 text-center border border-kidville-info/30">
                        <div className="flex items-center justify-center text-kidville-success gap-1 mb-0.5">
                            <ThumbsUp size={12} strokeWidth={1.5} />
                            <span className="font-maven text-[9px] font-bold uppercase">{t('si')}</span>
                        </div>
                        <span className="font-barlow font-black text-lg text-kidville-success">{numeri.si}</span>
                    </div>
                    <div className="bg-white/80 rounded-2xl p-2.5 text-center border border-kidville-info/30">
                        <div className="flex items-center justify-center text-kidville-sub gap-1 mb-0.5">
                            <ThumbsDown size={12} strokeWidth={1.5} />
                            <span className="font-maven text-[9px] font-bold uppercase">{t('no')}</span>
                        </div>
                        <span className="font-barlow font-black text-lg text-kidville-sub">{numeri.no}</span>
                    </div>
                    {/* «Senza risposta»: chi non ha ancora risposto. NON è la lista
                        d'attesa, che sta nel riquadro dei posti qui sotto. Il numero
                        conta le righe dell'ELENCO, le stesse che il filtro «Senza
                        risposta» restituisce: prima nasceva da una sottrazione fra
                        due basi diverse e poteva dire 0 con un bambino a schermo. */}
                    <div className="bg-white/80 rounded-2xl p-2.5 text-center border border-kidville-info/30">
                        <div className="flex items-center justify-center text-kidville-warn gap-1 mb-0.5">
                            <HelpCircle size={12} strokeWidth={1.5} />
                            <span className="font-maven text-[9px] font-bold uppercase">{t('attesa')}</span>
                        </div>
                        <span className="font-barlow font-black text-lg text-kidville-warn">{numeri.senzaRisposta}</span>
                    </div>
                </div>
            </div>

            {/* A PIENA LARGHEZZA e sotto i tre: a 360 px quattro riquadri di quella
                misura non si leggono più. */}
            <RiepilogoPosti numeri={numeri} postiTotali={postiTotali} />
        </div>
    );

    const filtersBlock = (
        <div className="bg-kidville-cream border border-kidville-line p-4 rounded-3xl space-y-3">
            <div className="flex items-center justify-between">
                <span className="font-barlow font-bold text-xs text-kidville-sub uppercase tracking-wider">{t('filtri')}</span>
                {(selectedClass !== 'all' || selectedResponse !== 'given' || searchQuery) && (
                    <button
                        onClick={() => {
                            setSelectedClass('all');
                            setSelectedResponse('given');
                            setSearchQuery('');
                        }}
                        className="font-maven text-[10px] text-kidville-green hover:underline font-bold"
                    >
                        {t('azzera')}
                    </button>
                )}
            </div>

            {mainTab === 'letture' ? (
                <div className="grid grid-cols-1 gap-2">
                    <div>
                        <label htmlFor={idClasse} className="font-maven font-medium text-[9px] text-kidville-sub uppercase tracking-wide mb-1 block">{t('classe')}</label>
                        <select
                            id={idClasse}
                            value={selectedClass}
                            onChange={e => setSelectedClass(e.target.value)}
                            className="w-full bg-white border border-kidville-line rounded-xl px-3 py-2 font-maven text-xs text-kidville-sub focus:outline-none focus:ring-2 focus:ring-kidville-green/20"
                        >
                            <option value="all">{t('tutteLeClassi')}</option>
                            {targetClasses.map(c => (
                                <option key={c} value={c}>{c}</option>
                            ))}
                        </select>
                    </div>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label htmlFor={idClasse} className="font-maven font-medium text-[9px] text-kidville-sub uppercase tracking-wide mb-1 block">{t('classe')}</label>
                        <select
                            id={idClasse}
                            value={selectedClass}
                            onChange={e => setSelectedClass(e.target.value)}
                            className="w-full bg-white border border-kidville-line rounded-xl px-3 py-2 font-maven text-xs text-kidville-sub focus:outline-none focus:ring-2 focus:ring-kidville-green/20"
                        >
                            <option value="all">{t('tutteLeClassi')}</option>
                            {targetClasses.map(c => (
                                <option key={c} value={c}>{c}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label htmlFor={idRisposta} className="font-maven font-medium text-[9px] text-kidville-sub uppercase tracking-wide mb-1 block">{t('risposta')}</label>
                        <select
                            id={idRisposta}
                            value={selectedResponse}
                            onChange={e => setSelectedResponse(e.target.value as FiltroRisposta)}
                            className="w-full bg-white border border-kidville-line rounded-xl px-3 py-2 font-maven text-xs text-kidville-sub focus:outline-none focus:ring-2 focus:ring-kidville-green/20"
                        >
                            <option value="given">{t('optRisposteDate')}</option>
                            <option value="si">{t('optAderitoSi')}</option>
                            <option value="no">{t('optDeclinatoNo')}</option>
                            {/* Le due «attese», separate e nominate per quello che sono. */}
                            <option value="attesa">{t('optInAttesa')}</option>
                            <option value="lista_attesa">{t('optListaAttesa')}</option>
                        </select>
                    </div>
                </div>
            )}

            {/* Search */}
            <div className="relative">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub" />
                <input
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder={t('cercaPlaceholder')}
                    className="w-full bg-white border border-kidville-line rounded-xl pl-9 pr-3 py-1.5 font-maven text-xs text-kidville-sub focus:outline-none focus:ring-2 focus:ring-kidville-green/20"
                />
            </div>
        </div>
    );

    const listsBlock = (
        <div className="space-y-3">
            {mainTab === 'letture' ? (
                // `key` sull'avviso: la linguetta letti/non letti è stato del
                // componente, e al cambio di avviso si ripristina per rimontaggio
                // invece che con una riga di reset scritta cinquecento righe più su.
                <ElencoLetture
                    key={avviso.id}
                    dati={datiLetture}
                    classe={selectedClass}
                    ricerca={searchQuery}
                    maxH={listMaxH}
                />
            ) : (
                // List rendering for Adesioni
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                        <span className="font-barlow font-bold text-[10px] text-kidville-sub uppercase tracking-wider">
                            {/* ⚠️ Per il gruppo «non ha ancora risposto» si usa `optInAttesa`
                                («Senza risposta»), la stessa parola del filtro e del chip
                                sulla riga. Il catalogo portava anche una voce che univa le
                                due attese dentro una parentesi — esattamente la confusione
                                che questa schermata deve tenere separata: è stata TOLTA da
                                entrambe le lingue, e non solo smessa di usare. Una chiave
                                orfana è una stringa pronta per chi verrà dopo, e il suo
                                nome non si riscrive qui: un lock che legge i sorgenti come
                                TESTO la troverebbe in questo commento e si assolverebbe. */}
                            {selectedResponse === 'given' ? t('titoloRisposteRicevute') :
                             selectedResponse === 'si' ? t('optAderitoSi') :
                             selectedResponse === 'no' ? t('optDeclinatoNo') :
                             selectedResponse === 'lista_attesa' ? t('optListaAttesa') : t('optInAttesa')}
                        </span>
                        <span className="font-maven text-[10px] text-kidville-sub font-medium">{t('totale', { count: filteredAdesioni.length })}</span>
                    </div>

                    {/* L'esportazione è della segreteria: il docente non la vede, e il
                        server risponde comunque 403 a chi non è staff. */}
                    {permessiScrittura && (
                        <div className="px-1 pb-1">
                            <EsportaAdesioni avvisoId={avviso.id} userId={uid} nAdesioni={nRigheEsportabili} />
                        </div>
                    )}

                    <ElencoAdesioni
                        righe={filteredAdesioni}
                        permessiScrittura={permessiScrittura}
                        maxH={listMaxHAdesioni}
                        onCorreggi={(riga) => apriGesto('numero', riga)}
                        onAmmetti={(riga) => apriGesto('ammetti', riga)}
                    />
                </div>
            )}
        </div>
    );

    const modaleGesti = (
        <CorreggiNumeroModal
            open={rigaInModifica !== null}
            avvisoId={avviso.id}
            riga={rigaInModifica}
            gesto={gesto}
            numeroMin={avviso.numero_min ?? null}
            numeroMax={avviso.numero_max ?? null}
            userId={uid}
            onChiudi={() => setRigaInModifica(null)}
            onFatto={ricaricaRisposte}
        />
    );

    if (isPage) {
        return (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
                <div className="space-y-5">
                    {tabsBlock}
                    {statsBlock}
                    {filtersBlock}
                </div>
                <div>{listsBlock}</div>
                {modaleGesti}
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {tabsBlock}
            {statsBlock}
            {filtersBlock}
            {listsBlock}
            {modaleGesti}
        </div>
    );
}
