'use client';

import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
import { Search, Filter, AlertTriangle, CheckCircle2, Clock, RefreshCw, Plus, Pencil, Layers, Eye, FileText, Download, X } from 'lucide-react';
import { RegistraIncassoModal, PagamentoRow } from './RegistraIncassoModal';
import { FatturaButton, type EsitoAccodamento } from './FatturaButton';
import { FatturaChip } from './FatturaChip';
import { LinkDocumento, MIME_XLSX } from './LinkDocumento';
import { PagamentoCardMobile, BadgeSede } from './PagamentoCardMobile';
import { PagamentoDrawer } from './PagamentoDrawer';
import { FiltroClassiContabilita } from './FiltroClassiContabilita';
import { classiDaAlunni, filtraPerClassi } from '@/lib/pagamenti/filtro-classi';
import { useSediAttive } from '@/lib/context/sede-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { SospensioneToggle } from './SospensioneToggle';
import { QuickAcquistoModal } from './QuickAcquistoModal';
import { ModificaPagamentoModal } from './ModificaPagamentoModal';
import { RateizzaModal } from './RateizzaModal';
import { STATI_PAGAMENTO as STATI, calcolaTotaliPagamenti } from './stati';
import { AgendaScadenze } from './AgendaScadenze';
import { useAgingLabel, bucketScadenze, isMoroso, residuoEffettivo, type AgingBucketId } from '@/lib/pagamenti/aging';
import { Badge } from '@/components/ui/Badge';
import { StatCard, TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { useRuoloCockpit } from '@/lib/context/admin-identity';
import { eDirezioneCockpit } from '@/lib/auth/ruoli';

// Pelle locale della dashboard contabilità, su token dell'app (allineata a
// `Btn`/cockpit): pillole verde+giallo per le azioni, filtri come la Toolbar.
const BTN_PRIMARY_SM = 'inline-flex items-center gap-1 rounded-pill bg-kidville-green px-3 py-1 font-maven text-xs font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50';
const ICON_BTN = 'text-kidville-muted transition-colors hover:text-kidville-green';
const FILTER_SELECT = 'rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors cursor-pointer hover:border-kidville-green/50 focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';

/** Stato vuoto nello stile app: cerchio crema + emoji + testo (come parent/avvisi). */
function EmptyRiga({ emoji, testo }: { emoji: string; testo: string }) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-pill bg-kidville-cream text-2xl">{emoji}</div>
            <p className="max-w-xs font-maven text-sm text-kidville-muted">{testo}</p>
        </div>
    );
}

/** `scuola_id` null = categoria globale (K2: con più sedi arrivano anche quelle di ogni sede). */
interface Categoria { id: string; nome: string; slug: string; colore?: string; icona?: string; scuola_id?: string | null }
interface Pagamento extends PagamentoRow {
    alunno_id: string;
    scadenza: string;
    obbligatorio: boolean;
    categoria_id?: string | null;
    periodo_competenza?: string | null;
    payment_categories?: { nome?: string; colore?: string; icona?: string } | null;
    /** Sede della voce e suo nome: `GET /api/pagamenti` li manda su OGNI riga (K1). */
    scuola_id?: string | null;
    scuola_nome?: string | null;
    alunni?: {
        nome?: string; cognome?: string;
        classe_sezione?: string | null;
        /** K1: la chiave del filtro classi (`null` = alunno senza sezione). */
        section_id?: string | null;
        sospeso?: boolean | null;
    };
}
interface Alunno {
    id: string; nome?: string; cognome?: string;
    classe_sezione?: string | null; section_id?: string | null;
    /** Sede del bambino (`GET /api/admin/students` la manda sempre). */
    scuola_id?: string | null;
    stato?: string; importo_retta_mensile?: number | null;
}

/** Esito della lettura della configurazione Aruba di UNA sede. */
type EsitoAruba = 'attiva' | 'non-attiva' | 'errore';

/** Esito di una GET del cruscotto: `ok` solo con risposta 2xx E corpo leggibile. */
interface EsitoLettura<T> { ok: boolean; corpo: T | null }

/**
 * GET di un elenco del cruscotto. Ogni guasto è LOGGATO — rete giù, corpo illeggibile e
 * risposta 4xx/5xx — perché un `catch` muto qui è una tabella vuota che sembra «nessun
 * pagamento» o «nessun alunno». Il corpo si restituisce anche sul rifiuto: porta il
 * messaggio del server (`error`). Nel `messaggio` del log solo l'etichetta e la classe
 * d'errore: l'URL porta uuid e filtri.
 */
async function leggiJson<T>(url: string, userId: string, etichetta: string): Promise<EsitoLettura<T>> {
    try {
        const r = await fetch(url, { headers: { 'x-user-id': userId } });
        let leggibile = true;
        const corpo = (await r.json().catch((e: unknown) => {
            leggibile = false;
            logClient({ livello: 'error', evento: 'fetch', messaggio: `${etichetta}-corpo-illeggibile: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: r.status });
            return null;
        })) as T | null;
        if (!r.ok) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `${etichetta}-rifiutato`, route: '/admin/pagamenti', stato: r.status });
        }
        return { ok: r.ok && leggibile, corpo };
    } catch (e) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `${etichetta}-non-caricato: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: 0 });
        return { ok: false, corpo: null };
    }
}

/** Elenco di nomi in una frase («A, B e C»), nella lingua corrente. */
function elencoNomi(nomi: string[], locale: string): string {
    // `Intl.ListFormat` assente (browser molto vecchio): la virgola basta, e non è un guasto.
    if (typeof Intl.ListFormat !== 'function') return nomi.join(', ');
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(nomi);
}

// Mese abbreviato localizzato con iniziale maiuscola. In IT riproduce ESATTAMENTE
// il vecchio array hardcoded (Gen, Feb, … Dic); in EN diventa Jan, Feb, … Dec.
function meseCorto(mese1a12: number, locale: string): string {
    const s = intlDateTime(locale, { month: 'short', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2020, mese1a12 - 1, 15)),
    );
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// I 10 periodi (primo del mese) dell'anno scolastico set(annoInizio) -> giu(annoInizio+1)
function periodiAnno(annoInizio: number, locale: string): { periodo: string; label: string }[] {
    const out: { periodo: string; label: string }[] = [];
    for (let m = 9; m <= 12; m++) out.push({ periodo: `${annoInizio}-${String(m).padStart(2, '0')}-01`, label: `${meseCorto(m, locale)} ${annoInizio}` });
    for (let m = 1; m <= 6; m++) out.push({ periodo: `${annoInizio + 1}-${String(m).padStart(2, '0')}-01`, label: `${meseCorto(m, locale)} ${annoInizio + 1}` });
    return out;
}

/**
 * `scuolaId`: la sede dichiarata, oppure `null` quando le sedi selezionate sono più di una
 * (P1). Con `null` le GET NON portano `scuola_id` — la route restringe già alle sedi attive
 * dell'utente — e mai «undefined»/«null» nell'URL: le route lo validano come uuid (400).
 * Le sedi davvero visibili arrivano da `useSediAttive().effettive` (MAI da `selezionate`,
 * dove vuoto vuol dire «tutte»). Il ricaricamento al cambio di sede lo fa `SedeScopeBoundary`
 * del layout admin, che rimonta il contenuto.
 */
interface Props { userId: string; scuolaId: string | null }

export function PaymentsDashboard({ userId, scuolaId }: Props) {
    const t = useTranslations('adminContabilita');
    const f = useDateFormat();
    const agingLabel = useAgingLabel();
    /**
     * I TOTALI ECONOMICI SONO DELLA DIREZIONE (decisione del titolare, 2026-09-02).
     *
     * ⚠️ E qui va detto cosa questa riga può e cosa non può, perché la differenza è reale.
     * I totali di questa schermata NON arrivano dal server: li somma il browser
     * (`calcolaTotaliPagamenti`) a partire dalle stesse righe che la Segreteria deve
     * legittimamente vedere — deve incassare, sollecitare, fatturare. Quindi nasconderli
     * è mettere in ordine la vista, NON costruire una barriera: chi apre gli strumenti per
     * sviluppatori, o esporta in Excel (`/api/pagamenti/export`, che resta aperto per
     * scelta del titolare), somma le righe da sé.
     *
     * Il pattern «il server omette la chiave» — quello vero, in `cassa/movimenti` — qui
     * non è applicabile senza togliere anche le righe. Dove invece i numeri li calcola il
     * server (la home /admin) l'omissione è reale e si fa là.
     */
    const eDirezione = eDirezioneCockpit(useRuoloCockpit());
    const [pagamenti, setPagamenti] = useState<Pagamento[]>([]);
    const [alunni, setAlunni] = useState<Alunno[]>([]);
    const [categorie, setCategorie] = useState<Categoria[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [fCategoria, setFCategoria] = useState<string>('');
    const [onlyMorosi, setOnlyMorosi] = useState(false);
    const [nuovoAcqId, setNuovoAcqId] = useState('');
    const [selected, setSelected] = useState<Pagamento | null>(null);
    const [editing, setEditing] = useState<Pagamento | null>(null);
    const [rateizza, setRateizza] = useState<{ alunno: Alunno; pagamento: Pagamento } | null>(null);
    const [drawer, setDrawer] = useState<Pagamento | null>(null);
    const [agendaFiltro, setAgendaFiltro] = useState<AgingBucketId | null>(null);
    const [quick, setQuick] = useState<{ alunno: Alunno; categoria: Categoria; scuolaId?: string } | null>(null);
    const [generando, setGenerando] = useState(false);
    /** Configurazione Aruba PER SEDE; `chiave` = le sedi a cui si riferisce (niente esiti stantii). */
    const [aruba, setAruba] = useState<{ chiave: string; esiti: Record<string, EsitoAruba> } | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** La GET degli iscritti è fallita: la vista Rette, i mancanti e l'acquisto non sono affidabili. */
    const [erroreAlunni, setErroreAlunni] = useState(false);
    /** `section_id` scelti nel filtro classi (K6). Si scartano in lettura, mai azzerati. */
    const [classiScelte, setClassiScelte] = useState<string[]>([]);
    /** Sede scelta per «Genera mancanti» e per il nuovo acquisto, quando le sedi sono più d'una. */
    const [sedeGenera, setSedeGenera] = useState('');
    const [sedeAcquistoScelta, setSedeAcquistoScelta] = useState('');

    // ── Le sedi ───────────────────────────────────────────────────────────────────────────
    const { sedi, effettive } = useSediAttive();
    const chiaveSedi = scuolaId ?? effettive.join(',');
    /** Le sedi che questa schermata mostra: quella dichiarata, o le effettive del contesto. */
    const sediVisibili = useMemo(() => (chiaveSedi ? chiaveSedi.split(',') : []), [chiaveSedi]);
    const mostraSede = sediVisibili.length > 1;
    const sedeUnica = sediVisibili.length === 1 ? sediVisibili[0] : null;
    /** `&scuola_id=…` solo con una sede dichiarata: con più sedi si OMETTE. */
    const sedeQs = scuolaId ? `&scuola_id=${encodeURIComponent(scuolaId)}` : '';

    // Anno scolastico corrente (set->ago = anno corrente, gen->giu = anno-1)
    const now = new Date();
    const oggiStr = now.toISOString().slice(0, 10);
    const annoScolasticoCorrente = now.getMonth() + 1 >= 9 ? now.getFullYear() : now.getFullYear() - 1;
    const [annoScolastico, setAnnoScolastico] = useState<number>(annoScolasticoCorrente);
    const periodi = useMemo(() => periodiAnno(annoScolastico, f.locale), [annoScolastico, f.locale]);
    const [mese, setMese] = useState<string>(() => {
        const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        return periodiAnno(annoScolasticoCorrente, f.locale).some((p) => p.periodo === cur) ? cur : `${annoScolasticoCorrente}-09-01`;
    });

    // NB: niente setLoading(true) sincrono qui dentro (react-hooks/set-state-in-effect):
    // al mount loading parte già true; il refresh manuale lo imposta nel suo handler.
    const load = useCallback(async () => {
        try {
            const [pagRes, alRes] = await Promise.all([
                leggiJson<{ success?: boolean; data?: Pagamento[]; error?: string }>(`/api/pagamenti?userId=${userId}${sedeQs}`, userId, 'scadenzario-pagamenti'),
                leggiJson<Alunno[] | { data?: Alunno[] }>(`/api/admin/students?stato=iscritto${sedeQs}&limit=${LIMITE_ELENCO_ALUNNI}`, userId, 'scadenzario-alunni'),
            ]);
            const pag = pagRes.corpo;
            if (pagRes.ok && pag?.success) { setPagamenti(pag.data ?? []); setError(null); }
            else setError(pag?.error || t('dashErrCaricamento'));
            // Gli alunni: un rifiuto NON è «nessun alunno». Si svuota la lista (niente dati di
            // prima spacciati per attuali) e lo si dice a schermo; il guasto l'ha loggato `leggiJson`.
            const al = alRes.corpo;
            const lista: Alunno[] | null = !alRes.ok ? null : Array.isArray(al) ? al : Array.isArray(al?.data) ? al.data : null;
            if (lista === null) {
                if (alRes.ok) logClient({ livello: 'error', evento: 'fetch', messaggio: 'scadenzario-alunni-forma-inattesa', route: '/admin/pagamenti' });
                setAlunni([]);
                setErroreAlunni(true);
            } else {
                setAlunni(lista.filter((a) => a.classe_sezione != null || a.section_id != null));
                setErroreAlunni(false);
            }
        } finally {
            setLoading(false);
        }
    }, [userId, sedeQs, t]);

    // D12: dopo un accodamento il chip deve comparire subito. `load()` sono due GET (tutti i pagamenti
    // della sede e gli iscritti): con `nuova` lo stato è noto per costruzione (la RPC ha appena scritto
    // `in_coda`) e basta la riga; con `gia`, o senza esito, può essere `in_invio` o `errore`, e si
    // rilegge. Fotografia dichiarata: il lavoratore può prenderla un attimo dopo.
    const dopoAccodamento = useCallback((pagamentoId: string, esito?: EsitoAccodamento) => {
        if (esito?.accodata === 'nuova') {
            setPagamenti((prima) => prima.map((x) => (x.id === pagamentoId ? { ...x, coda_stato: 'in_coda' as const } : x)));
            return;
        }
        void load();
    }, [load]);

    useEffect(() => { load(); }, [load]);
    // Categorie: con più sedi (nessuna dichiarata) la GET è multi-sede (K2): globali + quelle
    // di ogni sede attiva. Prima rispondeva 400, e il `.catch` muto lasciava il select vuoto.
    useEffect(() => {
        void leggiJson<{ success?: boolean; data?: Categoria[] }>(`/api/admin/settings/categorie?userId=${userId}${sedeQs}`, userId, 'scadenzario-categorie')
            .then(({ ok, corpo: d }) => {
                if (ok && d?.success && Array.isArray(d.data)) {
                    const lista = d.data;
                    setCategorie(lista);
                    const retta = lista.find((c) => c.slug === 'retta');
                    setFCategoria((cur) => cur || retta?.id || lista[0]?.id || '');
                } else if (ok) {
                    // 2xx ma senza elenco (il rifiuto, il corpo illeggibile e la rete giù li ha
                    // già loggati `leggiJson`): il select vuoto non deve sembrare «nessuna categoria».
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'scadenzario-categorie-forma-inattesa', route: '/admin/pagamenti' });
                }
            });
    }, [userId, sedeQs]);

    // Gating Aruba/SDI visibile (M2.4), PER SEDE: la configurazione è di ogni plesso, e la
    // route vuole UNA sede (`resolveScuolaScrittura`: senza `scuola_id` e con più sedi
    // risponde 400, che il vecchio `.catch` muto trasformava in «tutto a posto»). Una GET per
    // sede visibile; un esito non leggibile è «da verificare», detto a schermo e loggato.
    useEffect(() => {
        if (!chiaveSedi) return;
        let annullato = false;
        const ids = chiaveSedi.split(',');
        void Promise.all(ids.map(async (id): Promise<[string, EsitoAruba]> => {
            try {
                const r = await fetch(`/api/admin/settings/aruba?userId=${userId}&scuola_id=${encodeURIComponent(id)}`, { headers: { 'x-user-id': userId } });
                // Il corpo illeggibile si logga con la sua CAUSA (SyntaxError…): il log dopo
                // direbbe soltanto «non letta» con lo stato.
                const d = (await r.json().catch((e: unknown) => {
                    logClient({ livello: 'error', evento: 'fetch', messaggio: `aruba-config-corpo-illeggibile: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: r.status, campi: { sedi: ids.length } });
                    return null;
                })) as { success?: boolean; data?: { abilitato?: boolean } } | null;
                if (!r.ok || !d?.success) {
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'aruba-config-non-letta', route: '/admin/pagamenti', stato: r.status, campi: { sedi: ids.length } });
                    return [id, 'errore'];
                }
                return [id, d.data?.abilitato ? 'attiva' : 'non-attiva'];
            } catch (e) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `aruba-config-non-letta: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: 0, campi: { sedi: ids.length } });
                return [id, 'errore'];
            }
        })).then((coppie) => {
            if (!annullato) setAruba({ chiave: chiaveSedi, esiti: Object.fromEntries(coppie) });
        });
        return () => { annullato = true; };
    }, [userId, chiaveSedi]);

    // ── Nomi delle sedi: dal contesto, e in ripiego dalle righe (`scuola_nome`, K1) ────────
    const nomiSedi = useMemo(() => {
        const m: Record<string, string> = {};
        for (const p of pagamenti) if (p.scuola_id && p.scuola_nome) m[p.scuola_id] = p.scuola_nome;
        for (const s of sedi) m[s.id] = s.nome;
        return m;
    }, [pagamenti, sedi]);
    /** Il nome della sede, o stringa vuota se ignoto (mai un nome inventato). */
    const nomeSede = useCallback((id: string | null | undefined) => (id ? nomiSedi[id] ?? '' : ''), [nomiSedi]);
    /** Nome da mostrare in una frase o in un'opzione: il ripiego è il testo «Sede non indicata». */
    const nomeSedeTesto = (id: string | null | undefined) => nomeSede(id) || t('sedeBadgeNonIndicata');

    // ── Filtro classi (K6) ────────────────────────────────────────────────────────────────
    // Le classi vengono dalle righe E dagli iscritti: nella vista Rette un bambino senza retta
    // generata («Non generata») ha comunque una classe. La sede si prende dalla RIGA
    // (`p.scuola_id`), non dal join `alunni`, che non la porta: con `scuolaId: ''` le omonime
    // di sedi diverse si fonderebbero in un gruppo solo.
    const classi = useMemo(
        () => classiDaAlunni(
            [
                ...pagamenti.flatMap((p) => (p.alunni
                    ? [{ section_id: p.alunni.section_id ?? null, classe_sezione: p.alunni.classe_sezione ?? null, scuola_id: p.scuola_id ?? null }]
                    : [])),
                ...alunni.map((a) => ({ section_id: a.section_id ?? null, classe_sezione: a.classe_sezione ?? null, scuola_id: a.scuola_id ?? sedeUnica })),
            ],
            nomiSedi,
        ),
        [pagamenti, alunni, nomiSedi, sedeUnica],
    );
    // Gli id scelti che non corrispondono più a una classe in elenco si SCARTANO in lettura
    // (e si deduplicano): la stessa lista va a righe, KPI, agenda, componente ed export.
    const scelteValide = useMemo(
        () => [...new Set(classiScelte)].filter((id) => classi.some((c) => c.id === id)),
        [classiScelte, classi],
    );
    /** Le righe dopo il filtro classi: base di KPI, agenda e tabelle. */
    const pagamentiVisibili = useMemo(
        () => filtraPerClassi(pagamenti, scelteValide, (p) => p.alunni?.section_id ?? null),
        [pagamenti, scelteValide],
    );

    const rettaCat = useMemo(() => categorie.find((c) => c.slug === 'retta'), [categorie]);
    const categoriaSel = useMemo(() => categorie.find((c) => c.id === fCategoria), [categorie, fCategoria]);
    const isRettaView = !!rettaCat && fCategoria === rettaCat.id;
    /** Con più sedi due categorie omonime (es. «Gita» di Aversa e di Cesa) si distinguono dalla sede. */
    const etichettaCategoria = (c: Categoria) =>
        mostraSede && c.scuola_id ? t('dashMsCategoriaDiSede', { categoria: c.nome, nome: nomeSedeTesto(c.scuola_id) }) : c.nome;

    // mappa retta del periodo selezionato: alunno_id -> pagamento
    const rettaByAlunno = useMemo(() => {
        const m = new Map<string, Pagamento>();
        for (const p of pagamenti) {
            if (p.categoria_id === rettaCat?.id && p.periodo_competenza === mese) m.set(p.alunno_id, p);
        }
        return m;
    }, [pagamenti, rettaCat, mese]);

    // mappa alunno per id: usata dalla tabella-categoria (ricerca e label)
    const alunnoById = useMemo(() => new Map(alunni.map((a) => [a.id, a])), [alunni]);

    const alunniFiltrati = useMemo(() => {
        const q = search.trim().toLowerCase();
        return filtraPerClassi(alunni, scelteValide, (a) => a.section_id ?? null).filter((a) => {
            if (q) {
                const nome = `${a.nome ?? ''} ${a.cognome ?? ''} ${a.classe_sezione ?? ''}`.toLowerCase();
                if (!nome.includes(q)) return false;
            }
            if (isRettaView && onlyMorosi) {
                const p = rettaByAlunno.get(a.id);
                if (!p || !isMoroso(p, oggiStr)) return false;
            }
            return true;
        });
    }, [alunni, scelteValide, search, isRettaView, onlyMorosi, rettaByAlunno, oggiStr]);

    // Vista CATEGORIA (non-retta): una riga per pagamento (padre escluso), con
    // ricerca su alunno/sezione, filtro morosi e ordinamento per scadenza.
    const righeCategoria = useMemo(() => {
        if (isRettaView) return [];
        const q = search.trim().toLowerCase();
        return pagamentiVisibili
            .filter((p) => p.categoria_id === fCategoria && p.tipo !== 'padre')
            .filter((p) => {
                if (q) {
                    // nome da p.alunni (stessa fonte del display, copre anche i ritirati);
                    // sezione da alunnoById quando disponibile (solo iscritti)
                    const a = alunnoById.get(p.alunno_id);
                    const nome = `${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''} ${a?.classe_sezione ?? ''}`.toLowerCase();
                    if (!nome.includes(q)) return false;
                }
                if (onlyMorosi && !isMoroso(p, oggiStr)) return false;
                return true;
            })
            .sort((a, b) => (a.scadenza || '').localeCompare(b.scadenza || ''));
    }, [pagamentiVisibili, fCategoria, isRettaView, search, onlyMorosi, oggiStr, alunnoById]);

    const totals = useMemo(() => calcolaTotaliPagamenti(pagamentiVisibili), [pagamentiVisibili]);

    /**
     * KPI per sede: le stesse somme delle card, una riga per sede visibile (nell'ordine del
     * contesto), più «Sede non indicata» se qualche riga non la porta. Solo con più sedi.
     */
    const totaliPerSede = useMemo(() => {
        if (!mostraSede) return [];
        const gruppi = new Map<string, Pagamento[]>(sediVisibili.map((id) => [id, []]));
        for (const p of pagamentiVisibili) {
            const k = p.scuola_id ?? '';
            const g = gruppi.get(k);
            if (g) g.push(p); else gruppi.set(k, [p]);
        }
        return [...gruppi].map(([id, righe]) => ({ id, totali: calcolaTotaliPagamenti(righe) }));
    }, [mostraSede, sediVisibili, pagamentiVisibili]);

    // ── «Genera mancanti» ─────────────────────────────────────────────────────────────────
    // Quanti iscritti non hanno la retta del mese, PER SEDE. Si conta su tutti gli iscritti
    // della sede (non sulla ricerca né sul filtro classi): la generazione è di sede intera,
    // e il numero che si legge deve essere quello che il bottone produce.
    const mancantiPerSede = useMemo(() => {
        const m = new Map<string, number>();
        if (!isRettaView) return m;
        for (const a of alunni) {
            if (rettaByAlunno.has(a.id)) continue;
            const k = a.scuola_id ?? sedeUnica ?? '';
            m.set(k, (m.get(k) ?? 0) + 1);
        }
        return m;
    }, [isRettaView, alunni, rettaByAlunno, sedeUnica]);
    /** Le sedi fra cui scegliere: le visibili che hanno almeno un mancante. */
    const sediConMancanti = sediVisibili.filter((id) => (mancantiPerSede.get(id) ?? 0) > 0);
    const sedeGeneraValida = mostraSede ? (sediConMancanti.includes(sedeGenera) ? sedeGenera : '') : (sedeUnica ?? '');
    const mancantiTotali = mostraSede
        ? sediConMancanti.reduce((n, id) => n + (mancantiPerSede.get(id) ?? 0), 0)
        : [...mancantiPerSede.values()].reduce((n, v) => n + v, 0);
    const mancantiRette = mostraSede && sedeGeneraValida ? (mancantiPerSede.get(sedeGeneraValida) ?? 0) : mancantiTotali;

    // genera la retta del mese selezionato (per chi non ce l'ha ancora), SULLA
    // SEDE SCELTA: senza `scuola_id` il server emetteva su tutti i plessi, e con
    // più sedi visibili la sede la sceglie l'operatore (il bottone è spento finché
    // non l'ha fatto). La risposta si guarda: un rifiuto (sede non dichiarata, sede
    // di collaudo) resterebbe altrimenti invisibile all'operatore.
    const generaMese = async () => {
        if (!sedeGeneraValida) return;
        setGenerando(true);
        try {
            const res = await fetch('/api/pagamenti/genera-rette', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ periodo: mese.slice(0, 7), scuola_id: sedeGeneraValida }),
            });
            const j = await res.json().catch((e: unknown) => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `genera-rette-corpo-illeggibile: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: res.status });
                return null;
            });
            if (!res.ok || !j?.success) setError(messaggioDaCorpo(j, t('dashErrCaricamento')));
            else setError(null);
            await load();
        } catch (e) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `genera-rette-non-partita: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: 0 });
            setError(t('dashErrCaricamento'));
        } finally {
            setGenerando(false);
        }
    };

    // ── Nuovo acquisto: la sede ───────────────────────────────────────────────────────────
    // Una categoria di sede vale solo per quella sede; una globale per tutte le visibili.
    const sediAcquisto = categoriaSel?.scuola_id ? sediVisibili.filter((id) => id === categoriaSel.scuola_id) : sediVisibili;
    const chiedeSedeAcquisto = sediAcquisto.length > 1;
    const sedeAcquisto = chiedeSedeAcquisto
        ? (sediAcquisto.includes(sedeAcquistoScelta) ? sedeAcquistoScelta : '')
        : (sediAcquisto[0] ?? '');
    // Con più sedi l'elenco dei bambini è SEMPRE quello della sede dell'acquisto, anche quando
    // non c'è domanda (categoria di una sede sola): la POST ricava la sede dall'ALUNNO e non
    // guarda la categoria, quindi un bambino di un'altra sede produrrebbe una voce di quella
    // sede con la categoria sbagliata — mentre il modale mostrerebbe la sede della categoria.
    const alunniAcquisto = mostraSede
        ? (sedeAcquisto ? alunniFiltrati.filter((a) => a.scuola_id === sedeAcquisto) : [])
        : alunniFiltrati;
    /** L'acquisto non può partire: con più sedi manca la sede (da scegliere, o nessuna ammessa). */
    const acquistoSenzaSede = mostraSede && !sedeAcquisto;
    const nuovoAcqValido = alunniAcquisto.some((a) => a.id === nuovoAcqId) ? nuovoAcqId : '';

    // ── Modifica di una voce: le categorie della SUA sede ─────────────────────────────────
    // Con più sedi la GET porta le categorie di ogni sede (K2), e il modale le elenca per
    // nome: due «Gita» identiche, e a una voce di Giugliano si potrebbe dare quella di Aversa.
    // Restano le globali, quelle della sede della voce e — sempre — quella che la voce ha
    // già (anche se incoerente: toglierla dal select la cambierebbe in silenzio al salvataggio).
    // Le categorie di sede portano il nome della sede (`etichettaCategoria`, come il filtro).
    const categorieModifica = editing
        ? categorie
            .filter((c) => !c.scuola_id || !editing.scuola_id || c.scuola_id === editing.scuola_id || c.id === editing.categoria_id)
            .map((c) => ({ ...c, nome: etichettaCategoria(c) }))
        : [];

    // Export dello scadenzario: la sede solo se dichiarata, le classi solo se scelte (K2).
    const hrefExport = useMemo(() => {
        const qs = new URLSearchParams({ tipo: 'scadenzario', userId });
        if (scuolaId) qs.set('scuola_id', scuolaId);
        if (scelteValide.length > 0) qs.set('section_ids', scelteValide.join(','));
        return `/api/pagamenti/export?${qs.toString()}`;
    }, [userId, scuolaId, scelteValide]);

    // Vista agenda: pagamenti aperti del bucket selezionato, per scadenza crescente.
    const agendaItems = useMemo(() => {
        if (!agendaFiltro) return [];
        return bucketScadenze(pagamentiVisibili, oggiStr)[agendaFiltro].items
            .slice()
            .sort((a, b) => (a.scadenza || '').localeCompare(b.scadenza || ''));
    }, [agendaFiltro, pagamentiVisibili, oggiStr]);

    // Badge Aruba: le sedi non configurate e quelle non verificate, solo se l'esito è di
    // QUESTE sedi (un esito di prima del cambio sede non si mostra).
    const esitiAruba = aruba && aruba.chiave === chiaveSedi ? aruba.esiti : {};
    const arubaNonAttive = sediVisibili.filter((id) => esitiAruba[id] === 'non-attiva');
    const arubaNonVerificate = sediVisibili.filter((id) => esitiAruba[id] === 'errore');

    // Il banner degli scarti resta su TUTTE le righe: è un allarme, non una vista.
    const fattureScartate = pagamenti.filter((p) => p.fattura_stato === 'scartata').length;
    // Mappa alunno → sospeso (DL-021), derivata dal payload pagamenti.
    const sospesoByAlunno = new Map<string, boolean>();
    for (const p of pagamenti) {
        if (p.alunno_id) sospesoByAlunno.set(p.alunno_id, !!p.alunni?.sospeso);
    }

    return (
        <div>
            {/* Errore di caricamento: i KPI a 0,00 non devono sembrare dati reali */}
            {error && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="flex-1 font-maven text-sm font-bold">{error}</span>
                    <button onClick={() => { setLoading(true); load(); }}
                        className="rounded-pill border border-kidville-error/40 bg-kidville-white px-3 py-1 font-maven text-xs font-bold text-kidville-error transition-colors hover:bg-kidville-error-soft">
                        {t('dashRiprova')}
                    </button>
                </div>
            )}

            {/* Iscritti non caricati: la vista Rette vuota, i mancanti a 0 e l'acquisto senza
                bambini NON devono sembrare «nessun alunno». */}
            {erroreAlunni && (
                <div data-testid="errore-alunni" role="alert" className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="flex-1 font-maven text-sm font-bold">{t('dashMsErrAlunni')}</span>
                    <button onClick={() => { setLoading(true); load(); }}
                        className="rounded-pill border border-kidville-error/40 bg-kidville-white px-3 py-1 font-maven text-xs font-bold text-kidville-error transition-colors hover:bg-kidville-error-soft">
                        {t('dashRiprova')}
                    </button>
                </div>
            )}

            {/* Gating Aruba/SDI (M2.4), PER SEDE: segnale visibile quando la fatturazione non è
                configurata, con il nome delle sedi quando sono più d'una. Il testo è `sub` e non
                `muted`: dice cosa non funziona, e il contrasto conta. */}
            {arubaNonAttive.length > 0 && (
                <div data-testid="aruba-non-attiva" className="mb-4 flex items-center gap-2 flex-wrap">
                    <Badge tone="warn">{t('dashIntegrNonConfig')}</Badge>
                    <span className="font-maven text-xs text-kidville-sub">
                        {mostraSede
                            ? t('dashMsArubaNonAttivaSedi', { elenco: elencoNomi(arubaNonAttive.map(nomeSedeTesto), f.locale), n: arubaNonAttive.length })
                            : t('dashArubaNonAttiva')}
                    </span>
                </div>
            )}
            {/* La configurazione di una sede NON letta (errore, rete giù) non è «tutto a posto»:
                lo si dice, e il guasto è già nel log. */}
            {arubaNonVerificate.length > 0 && (
                <div data-testid="aruba-non-verificata" className="mb-4 flex items-center gap-2 flex-wrap">
                    <Badge tone="warn">{t('dashMsArubaDaVerificare')}</Badge>
                    <span className="font-maven text-xs text-kidville-sub">
                        {mostraSede
                            ? t('dashMsArubaNonVerificataSedi', { elenco: elencoNomi(arubaNonVerificate.map(nomeSedeTesto), f.locale) })
                            : t('dashMsArubaNonVerificata')}
                    </span>
                </div>
            )}

            {/* Banner scarti SDI (DL-020): fatture rifiutate da correggere e reinviare */}
            {fattureScartate > 0 && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="font-maven text-sm font-bold">
                        {fattureScartate} {fattureScartate > 1 ? t('dashFattureScartatePlur') : t('dashFatturaScartataSing')}
                    </span>
                </div>
            )}

            {/* KPI (StatCard cockpit): 1 colonna sotto sm, 2 da sm, 4 da lg
                `data-testid`: le etichette dei KPI NON sono uniche nella schermata —
                «Da fatturare» è anche il badge di stato di una riga della tabella —
                e senza un confine i test finiscono per contare importi che stanno
                altrove, con esiti che cambiano col calendario. Vedi
                `__tests__/components/importi-euro-italiani.test.tsx`. */}
            {eDirezione && (
            <div data-testid="kpi-contabilita" className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard icon={CheckCircle2} label={t('dashIncassato')} value={loading ? '—' : formatEuro(totals.incassato)} tone="success" />
                <StatCard icon={Clock} label={t('dashDaIncassare')} value={loading ? '—' : formatEuro(totals.daIncassare)} tone="warn" />
                <StatCard icon={AlertTriangle} label={t('dashScadutoMorosita')} value={loading ? '—' : formatEuro(totals.scaduto)} tone="error" />
                <StatCard icon={FileText} label={t('dashDaFatturare')} value={loading ? '—' : formatEuro(totals.daFatturare)}
                    sub={!loading && totals.nDaFatturare > 0 ? `${totals.nDaFatturare} ${totals.nDaFatturare === 1 ? t('dashPagamentoSing') : t('dashPagamentiPlur')}` : undefined} tone="info" />
            </div>
            )}

            {/* KPI PER SEDE: con più sedi accorpate il totale da solo non dice a quale
                segreteria tocca cosa. Stesse quattro somme, una riga per sede; stesso
                filtro classi delle card. Anche questi sono totali della Direzione. */}
            {eDirezione && mostraSede && !loading && (
                <div data-testid="kpi-per-sede" className={cx('mb-5', TABLE_WRAP)}>
                    <table className={TABLE}>
                        <caption className="px-3 pt-3 text-left font-barlow text-sm font-extrabold uppercase text-kidville-green">{t('dashMsKpiTitolo')}</caption>
                        <thead>
                            <tr>
                                <th scope="col" className={TH}>{t('dashMsThSede')}</th>
                                <th scope="col" className={cx(TH, 'text-right')}>{t('dashIncassato')}</th>
                                <th scope="col" className={cx(TH, 'text-right')}>{t('dashDaIncassare')}</th>
                                <th scope="col" className={cx(TH, 'text-right')}>{t('dashScadutoMorosita')}</th>
                                <th scope="col" className={cx(TH, 'text-right')}>{t('dashDaFatturare')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {totaliPerSede.map(({ id, totali }) => (
                                <tr key={id || 'sede-non-indicata'} className={TROW}>
                                    <th scope="row" className={cx(TD, 'text-left font-semibold text-kidville-green')}>{nomeSedeTesto(id)}</th>
                                    <td className={cx(TD, 'text-right text-kidville-ink')}>{formatEuro(totali.incassato)}</td>
                                    <td className={cx(TD, 'text-right text-kidville-ink')}>{formatEuro(totali.daIncassare)}</td>
                                    <td className={cx(TD, 'text-right text-kidville-ink')}>{formatEuro(totali.scaduto)}</td>
                                    <td className={cx(TD, 'text-right text-kidville-ink')}>{formatEuro(totali.daFatturare)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Filtro classi (K6): sta SOPRA l'agenda perché vale per KPI, agenda, tabelle
                ed export — anche in vista agenda, dove la barra dei filtri si nasconde. */}
            {!loading && (
                <FiltroClassiContabilita
                    classi={classi}
                    selezionate={scelteValide}
                    onChange={setClassiScelte}
                    mostraSede={mostraSede}
                    className="mb-4"
                />
            )}

            {/* Agenda scadenze / aging: i bucket filtrano la lista sottostante.
                Alla Segreteria restano i CONTEGGI e il clic — è uno strumento di lavoro,
                non un cruscotto — e spariscono i soli importi (`mostraImporti`). */}
            {!loading && <AgendaScadenze pagamenti={pagamentiVisibili} attivo={agendaFiltro} onSelect={setAgendaFiltro} mostraImporti={eDirezione} mostraSede={mostraSede} />}

            {/* Filtri (nascosti in vista agenda: non filtrerebbero la lista del bucket) */}
            {!agendaFiltro && (
            <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="relative flex-1 min-w-[200px]">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" />
                    <input
                        value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('dashCercaAlunno')}
                        className="w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white pl-9 pr-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
                    />
                </div>
                <select value={fCategoria} onChange={(e) => setFCategoria(e.target.value)}
                    className={FILTER_SELECT}>
                    {categorie.map((c) => <option key={c.id} value={c.id}>{etichettaCategoria(c)}</option>)}
                </select>

                {/* Filtro mensilità: solo nella vista Rette */}
                {isRettaView && (
                    <>
                        <select value={annoScolastico} onChange={(e) => { const y = Number(e.target.value); setAnnoScolastico(y); setMese(`${y}-09-01`); }}
                            className={FILTER_SELECT}>
                            {[annoScolasticoCorrente - 1, annoScolasticoCorrente, annoScolasticoCorrente + 1].map((y) => (
                                <option key={y} value={y}>{t('dashAsPrefix')} {y}/{y + 1}</option>
                            ))}
                        </select>
                        <select value={periodi.some((p) => p.periodo === mese) ? mese : periodi[0].periodo}
                            onChange={(e) => setMese(e.target.value)}
                            className={FILTER_SELECT}>
                            {periodi.map((p) => <option key={p.periodo} value={p.periodo}>{p.label}</option>)}
                        </select>
                    </>
                )}
                {/* Filtro Morosi: disponibile in tutte le categorie */}
                <button onClick={() => setOnlyMorosi((v) => !v)}
                    className={cx('inline-flex items-center gap-1 rounded-pill px-3 py-2 font-maven text-sm font-bold transition-colors', onlyMorosi ? 'bg-kidville-error-soft text-kidville-error' : 'border-[1.5px] border-kidville-line bg-kidville-white text-kidville-muted hover:border-kidville-green hover:text-kidville-green')}>
                    <Filter size={14} /> {t('dashMorosi')}
                </button>
                <button onClick={() => { setLoading(true); load(); }} aria-label={t('dashAggiorna')} title={t('dashAggiorna')} className="rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                    <RefreshCw size={14} />
                </button>
                <LinkDocumento href={hrefExport} title={t('dashEsportaXlsx')} aria-label={t('dashEsportaXlsx')}
                    modo="scarica" nomeFile="scadenzario.xlsx" mime={MIME_XLSX} etichetta="export-scadenzario"
                    className="rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                    <Download size={14} />
                </LinkDocumento>
            </div>
            )}

            {/* CTA generazione rette mancanti. Con più sedi la sede si SCEGLIE (il bottone resta
                spento finché non la si sceglie): la generazione è di UNA sede, e il numero
                mostrato diventa quello della sede scelta. */}
            {isRettaView && !loading && mancantiTotali > 0 && (
                <div data-testid="cta-genera-mancanti" className="flex flex-wrap items-center justify-between gap-2 bg-kidville-warn-soft border border-kidville-warn/30 rounded-card px-3 py-2 mb-3">
                    <span data-testid="cta-genera-mancanti-frase" className="font-maven text-xs text-kidville-warn-strong">
                        {t('dashMsAlunniSenzaRetta', { n: mancantiRette, mese: periodi.find((p) => p.periodo === mese)?.label ?? '' })}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                        {mostraSede && (
                            <label className="flex items-center gap-2 font-maven text-xs text-kidville-warn-strong">
                                {t('dashMsGeneraSedeLabel')}
                                <select value={sedeGeneraValida} onChange={(e) => setSedeGenera(e.target.value)} className={FILTER_SELECT}>
                                    <option value="">{t('dashMsScegliSede')}</option>
                                    {sediConMancanti.map((id) => (
                                        <option key={id} value={id}>{t('dashMsGeneraOpzione', { nome: nomeSedeTesto(id), n: mancantiPerSede.get(id) ?? 0 })}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                        <button onClick={generaMese} disabled={generando || !sedeGeneraValida} className={BTN_PRIMARY_SM}>
                            {generando ? t('dashGenerando') : t('dashGeneraMancanti')}
                        </button>
                    </div>
                </div>
            )}

            {/* Corpo */}
            {loading ? (
                <p className="font-maven text-sm text-kidville-muted py-8 text-center">{t('dashCaricamento')}</p>
            ) : agendaFiltro ? (
                /* ---- Vista AGENDA: pagamenti aperti del bucket, per scadenza ---- */
                <>
                <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="font-maven text-xs text-kidville-muted">
                        <span className="font-bold text-kidville-green">{agingLabel(agendaFiltro)}</span> · {agendaItems.length} {agendaItems.length === 1 ? t('dashPagamentoApertiSing') : t('dashPagamentiApertiPlur')}
                    </p>
                    <button onClick={() => setAgendaFiltro(null)}
                        className="inline-flex items-center gap-1 rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-2.5 py-1 font-maven text-xs font-bold text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                        <X size={12} /> {t('dashChiudi')}
                    </button>
                </div>
                {agendaItems.length === 0 ? (
                    <EmptyRiga emoji="🗓️" testo={t('dashVuotoIntervallo')} />
                ) : (
                    <>
                    <div className={cx('hidden lg:block', TABLE_WRAP)}>
                        <table className={TABLE}>
                            <thead>
                                <tr>
                                    <th className={TH}>{t('dashThAlunno')}</th>
                                    {mostraSede && <th className={TH}>{t('dashMsThSede')}</th>}
                                    <th className={TH}>{t('dashThDescrizione')}</th>
                                    <th className={TH}>{t('dashThScadenza')}</th>
                                    <th className={cx(TH, 'text-right')}>{t('dashThResiduo')}</th>
                                    <th className={TH}>{t('dashThStato')}</th>
                                    <th className={TH}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {agendaItems.map((p) => {
                                    const st = STATI[p.stato] ?? STATI.da_pagare;
                                    const residuo = residuoEffettivo(p);
                                    return (
                                        <tr key={p.id} className={TROW}>
                                            <td className={cx(TD, 'font-semibold text-kidville-green')}>{p.alunni?.nome} {p.alunni?.cognome}</td>
                                            {mostraSede && <td className={TD}><BadgeSede nome={p.scuola_nome} /></td>}
                                            <td className={cx(TD, 'text-kidville-ink')}>{p.descrizione}</td>
                                            <td className={cx(TD, 'text-kidville-muted')}>{p.scadenza ? f.dataBreve(p.scadenza) : '—'}</td>
                                            <td className={cx(TD, 'text-right font-bold text-kidville-green')}>{formatEuro(residuo)}</td>
                                            <td className={TD}>
                                                <Badge tone={st.tone}>{st.label}</Badge>
                                            </td>
                                            <td className={cx(TD, 'text-right')}>
                                                <div className="flex items-center justify-end gap-2">
                                                    <button onClick={() => setSelected(p)}
                                                        className={BTN_PRIMARY_SM}>{t('dashIncassa')}</button>
                                                    <button onClick={() => setDrawer(p)} title={t('dashDettagli')} className={ICON_BTN}><Eye size={15} /></button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <div className="space-y-2 lg:hidden">
                        {agendaItems.map((p) => (
                            <PagamentoCardMobile
                                key={p.id}
                                pagamento={p}
                                alunnoLabel={`${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''}`.trim() || '—'}
                                mostraSede={mostraSede}
                                onIncassa={() => setSelected(p)}
                                onApri={() => setDrawer(p)}
                            />
                        ))}
                    </div>
                    </>
                )}
                </>
            ) : isRettaView ? (
                /* ---- Vista RETTE: tabella su desktop, card-list su mobile ---- */
                alunniFiltrati.length === 0 ? (
                // Con la GET degli iscritti fallita l'elenco vuoto NON è «nessun alunno»: lo
                // dice il banner d'errore qui sopra, e qui non si afferma il contrario.
                erroreAlunni ? null : <EmptyRiga emoji="🧒" testo={t('dashVuotoAlunni')} />
                ) : (
                <>
                <div className={cx('hidden lg:block', TABLE_WRAP)}>
                    <table className={TABLE}>
                        <thead>
                            <tr>
                                <th className={TH}>{t('dashThAlunno')}</th>
                                {mostraSede && <th className={TH}>{t('dashMsThSede')}</th>}
                                <th className={TH}>{t('dashThSezione')}</th>
                                <th className={cx(TH, 'text-right')}>{t('dashThImporto')}</th>
                                <th className={cx(TH, 'text-right')}>{t('dashThPagato')}</th>
                                <th className={TH}>{t('dashThStato')}</th>
                                <th className={TH}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {alunniFiltrati.map((a) => {
                                const p = rettaByAlunno.get(a.id);
                                const st = p ? (STATI[p.stato] ?? STATI.da_pagare) : null;
                                const moroso = p ? isMoroso(p, oggiStr) : false;
                                return (
                                    <tr key={a.id} className={cx(TROW, moroso && 'bg-kidville-error-soft/50')}>
                                        <td className={cx(TD, 'font-semibold text-kidville-green')}>
                                            {a.nome} {a.cognome}
                                            {sospesoByAlunno.get(a.id) && (
                                                <Badge tone="error" className="ml-1 align-middle">{t('dashSospeso')}</Badge>
                                            )}
                                        </td>
                                        {mostraSede && <td className={TD}><BadgeSede nome={nomeSede(a.scuola_id)} /></td>}
                                        <td className={cx(TD, 'text-kidville-muted')}>{a.classe_sezione || '—'}</td>
                                        <td className={cx(TD, 'text-right text-kidville-green')}>{p ? formatEuro(p.importo) : '—'}</td>
                                        <td className={cx(TD, 'text-right text-kidville-muted')}>{p ? formatEuro(p.importo_pagato) : '—'}</td>
                                        <td className={TD}>
                                            <span className="inline-flex flex-wrap items-center gap-1">
                                                {st
                                                    ? <Badge tone={st.tone}>{st.label}</Badge>
                                                    : <Badge tone="neutral">{t('dashNonGenerata')}</Badge>}
                                                {p && moroso && Number(p.importo_pagato) > 0 && (
                                                    <Badge tone="warn">{t('dashAcconto')} {formatEuro(p.importo_pagato)}</Badge>
                                                )}
                                                {p && <FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} codaStato={p.coda_stato} />}
                                            </span>
                                        </td>
                                        <td className={cx(TD, 'text-right')}>
                                            <div className="flex items-center justify-end gap-2">
                                                {p && p.stato !== 'pagato' ? (
                                                    <button onClick={() => setSelected(p)}
                                                        className={BTN_PRIMARY_SM}>{t('dashIncassa')}</button>
                                                ) : p ? (
                                                    <FatturaButton pagamentoId={p.id} userId={userId} fatturaStato={p.fattura_stato} codaStato={p.coda_stato ?? null} onEmessa={(e) => dopoAccodamento(p.id, e)} />
                                                ) : null}
                                                {p && (
                                                    <button onClick={() => setDrawer(p)} title={t('dashDettagli')} className={ICON_BTN}><Eye size={15} /></button>
                                                )}
                                                {p && (
                                                    <button onClick={() => setEditing(p)} title={t('dashModifica')} className={ICON_BTN}><Pencil size={15} /></button>
                                                )}
                                                <SospensioneToggle alunnoId={a.id} userId={userId} sospeso={!!sospesoByAlunno.get(a.id)} onChange={load} />
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <div className="space-y-2 lg:hidden">
                    {alunniFiltrati.map((a) => {
                        const p = rettaByAlunno.get(a.id);
                        if (!p) {
                            return (
                                <div key={a.id} className="flex items-center justify-between gap-2 rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3">
                                    <div className="min-w-0">
                                        <p className="font-maven text-sm font-bold text-kidville-green">{a.nome} {a.cognome}</p>
                                        {mostraSede && <BadgeSede nome={nomeSede(a.scuola_id)} className="mt-1" />}
                                    </div>
                                    <Badge tone="neutral">{t('dashNonGenerata')}</Badge>
                                </div>
                            );
                        }
                        return (
                            <PagamentoCardMobile
                                key={a.id}
                                pagamento={p}
                                alunnoLabel={`${a.nome ?? ''} ${a.cognome ?? ''}`.trim()}
                                sezioneLabel={a.classe_sezione}
                                sospeso={!!sospesoByAlunno.get(a.id)}
                                mostraSede={mostraSede}
                                onIncassa={() => setSelected(p)}
                                onApri={() => setDrawer(p)}
                            />
                        );
                    })}
                </div>
                </>
                )
            ) : (
                /* ---- Vista CATEGORIA: tabella 1-riga-per-pagamento (come le rette) ---- */
                <>
                {/* Aggiungi acquisto: la tabella per-pagamento non elenca gli alunni senza acquisti */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                    {/* Con più sedi l'acquisto CHIEDE la sede prima del bambino: l'elenco dei
                        bambini diventa quello della sede scelta, e la sede arriva al modale. */}
                    {chiedeSedeAcquisto && (
                        <label className="flex items-center gap-2 font-maven text-xs text-kidville-sub">
                            {t('dashMsAcquistoSedeLabel')}
                            <select value={sedeAcquisto} onChange={(e) => { setSedeAcquistoScelta(e.target.value); setNuovoAcqId(''); }}
                                className={FILTER_SELECT}>
                                <option value="">{t('dashMsScegliSede')}</option>
                                {sediAcquisto.map((id) => <option key={id} value={id}>{nomeSedeTesto(id)}</option>)}
                            </select>
                        </label>
                    )}
                    <select value={nuovoAcqValido} onChange={(e) => setNuovoAcqId(e.target.value)}
                        disabled={acquistoSenzaSede}
                        aria-label={t('dashSelezionaAlunno')}
                        className={cx(FILTER_SELECT, 'disabled:cursor-not-allowed disabled:opacity-60')}>
                        <option value="">{chiedeSedeAcquisto && !sedeAcquisto ? t('dashMsScegliPrimaSede') : t('dashSelezionaAlunno')}</option>
                        {alunniAcquisto.map((a) => (
                            <option key={a.id} value={a.id}>{a.nome} {a.cognome}{a.classe_sezione ? ` · ${a.classe_sezione}` : ''}</option>
                        ))}
                    </select>
                    <button
                        disabled={!nuovoAcqValido || !categoriaSel || acquistoSenzaSede}
                        onClick={() => {
                            const a = alunnoById.get(nuovoAcqValido);
                            if (a && categoriaSel) {
                                setQuick({ alunno: a, categoria: categoriaSel, scuolaId: sedeAcquisto || undefined });
                                setNuovoAcqId('');
                            }
                        }}
                        className="inline-flex items-center gap-1 rounded-pill bg-kidville-green px-3 py-2 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50">
                        <Plus size={15} /> {t('dashNuovoAcquisto')}
                    </button>
                </div>
                {righeCategoria.length === 0 ? (
                    <EmptyRiga emoji="🧾" testo={t('dashVuotoCategoria')} />
                ) : (
                <>
                <div className={cx('hidden lg:block', TABLE_WRAP)}>
                    <table className={TABLE}>
                        <thead>
                            <tr>
                                <th className={TH}>{t('dashThAlunno')}</th>
                                {mostraSede && <th className={TH}>{t('dashMsThSede')}</th>}
                                <th className={TH}>{t('dashThDescrizione')}</th>
                                <th className={TH}>{t('dashThScadenza')}</th>
                                <th className={cx(TH, 'text-right')}>{t('dashThImporto')}</th>
                                <th className={cx(TH, 'text-right')}>{t('dashAcconto')}</th>
                                <th className={TH}>{t('dashThStato')}</th>
                                <th className={TH}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {righeCategoria.map((p) => {
                                const st = STATI[p.stato] ?? STATI.da_pagare;
                                const moroso = isMoroso(p, oggiStr);
                                const acconto = Number(p.importo_pagato || 0);
                                return (
                                    <tr key={p.id} className={cx(TROW, moroso && 'bg-kidville-error-soft/50')}>
                                        <td className={cx(TD, 'font-semibold text-kidville-green')}>
                                            {p.alunni?.nome} {p.alunni?.cognome}
                                            {sospesoByAlunno.get(p.alunno_id) && (
                                                <Badge tone="error" className="ml-1 align-middle">{t('dashSospeso')}</Badge>
                                            )}
                                        </td>
                                        {mostraSede && <td className={TD}><BadgeSede nome={p.scuola_nome} /></td>}
                                        <td className={cx(TD, 'text-kidville-ink')}>{p.descrizione}</td>
                                        <td className={cx(TD, 'text-kidville-muted')}>{p.scadenza ? f.dataBreve(p.scadenza) : '—'}</td>
                                        <td className={cx(TD, 'text-right text-kidville-green')}>{formatEuro(p.importo)}</td>
                                        <td className={cx(TD, 'text-right text-kidville-muted')}>{acconto > 0 ? formatEuro(acconto) : '—'}</td>
                                        <td className={TD}>
                                            <span className="inline-flex flex-wrap items-center gap-1">
                                                <Badge tone={st.tone}>{st.label}</Badge>
                                                {moroso && acconto > 0 && (
                                                    <Badge tone="warn">{t('dashAcconto')} {formatEuro(acconto)}</Badge>
                                                )}
                                                <FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} codaStato={p.coda_stato} />
                                            </span>
                                        </td>
                                        <td className={cx(TD, 'text-right')}>
                                            <div className="flex items-center justify-end gap-2">
                                                {p.stato !== 'pagato' ? (
                                                    <button onClick={() => setSelected(p)}
                                                        className={BTN_PRIMARY_SM}>{t('dashIncassa')}</button>
                                                ) : (
                                                    <FatturaButton pagamentoId={p.id} userId={userId} fatturaStato={p.fattura_stato} codaStato={p.coda_stato ?? null} onEmessa={(e) => dopoAccodamento(p.id, e)} />
                                                )}
                                                {p.tipo === 'singolo' && p.stato !== 'pagato' && (
                                                    <button onClick={() => { const a = alunnoById.get(p.alunno_id); if (a) setRateizza({ alunno: a, pagamento: p }); }} title={t('dashDividiAcconti')} className={ICON_BTN}><Layers size={15} /></button>
                                                )}
                                                <button onClick={() => setDrawer(p)} title={t('dashDettagli')} className={ICON_BTN}><Eye size={15} /></button>
                                                <button onClick={() => setEditing(p)} title={t('dashModifica')} className={ICON_BTN}><Pencil size={15} /></button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <div className="space-y-2 lg:hidden">
                    {righeCategoria.map((p) => (
                        <PagamentoCardMobile
                            key={p.id}
                            pagamento={p}
                            alunnoLabel={`${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''}`.trim() || '—'}
                            sospeso={!!sospesoByAlunno.get(p.alunno_id)}
                            mostraSede={mostraSede}
                            onIncassa={() => setSelected(p)}
                            onApri={() => setDrawer(p)}
                        />
                    ))}
                </div>
                </>
                )}
                </>
            )}

            {selected && (
                <RegistraIncassoModal
                    pagamento={selected}
                    userId={userId}
                    onClose={() => setSelected(null)}
                    onDone={() => { setSelected(null); load(); }}
                />
            )}

            {quick && (
                <QuickAcquistoModal
                    alunno={quick.alunno}
                    categoria={quick.categoria}
                    userId={userId}
                    scuolaId={quick.scuolaId}
                    sedeNome={mostraSede && quick.scuolaId ? nomeSedeTesto(quick.scuolaId) : undefined}
                    onClose={() => setQuick(null)}
                    onDone={() => { setQuick(null); load(); }}
                />
            )}

            {editing && (
                <ModificaPagamentoModal
                    pagamento={editing}
                    categorie={categorieModifica}
                    userId={userId}
                    onClose={() => setEditing(null)}
                    onDone={() => { setEditing(null); load(); }}
                />
            )}

            {rateizza && (
                <RateizzaModal
                    alunno={rateizza.alunno}
                    userId={userId}
                    scuolaId={rateizza.pagamento.scuola_id ?? scuolaId ?? undefined}
                    categoriaId={rateizza.pagamento.categoria_id}
                    descrizione={rateizza.pagamento.descrizione}
                    importoTotale={Number(rateizza.pagamento.importo)}
                    obbligatorio={rateizza.pagamento.obbligatorio}
                    replacePagamentoId={rateizza.pagamento.id}
                    onClose={() => setRateizza(null)}
                    onDone={() => { setRateizza(null); load(); }}
                />
            )}

            {drawer && (
                <PagamentoDrawer
                    pagamento={drawer}
                    userId={userId}
                    mostraSede={mostraSede}
                    onClose={() => setDrawer(null)}
                    onIncassa={() => { setSelected(drawer); setDrawer(null); }}
                    onModifica={() => { setEditing(drawer); setDrawer(null); }}
                    onRateizza={() => {
                        const a = alunni.find((x) => x.id === drawer.alunno_id);
                        if (a) setRateizza({ alunno: a, pagamento: drawer });
                        setDrawer(null);
                    }}
                    // Il `pagamento` del drawer resta la fotografia presa al clic: il suo chip non si
                    // accende finché non si riapre (dichiarato, D6); la riga della tabella sì.
                    onAccodata={(e) => dopoAccodamento(drawer.id, e)}
                    extra={
                        <SospensioneToggle alunnoId={drawer.alunno_id} userId={userId} sospeso={!!sospesoByAlunno.get(drawer.alunno_id)} onChange={load} />
                    }
                />
            )}
        </div>
    );
}
