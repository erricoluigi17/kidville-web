'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, Receipt, RefreshCw } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { Badge } from '@/components/ui/Badge';

interface RicevutaRiga {
    id: string;
    pagamento_id: string;
    numero: number;
    anno: number;
    importo: number;
    tracciabile: boolean;
    bollo: boolean;
    annullata_il: string | null;
    annullo_motivo: string | null;
    creato_il: string;
    alunni?: { nome?: string; cognome?: string } | null;
}
interface Alunno { id: string; nome?: string; cognome?: string; classe_sezione?: string | null; section_id?: string | null }

interface Props { userId: string; scuolaId: string }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const dataIt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : '—');

/** Vista Fiscale: attestazioni annuali per alunno + registro delle ricevute numerate. */
export function FiscalePanel({ userId, scuolaId }: Props) {
    const annoCorrente = new Date().getFullYear();
    const [anno, setAnno] = useState(annoCorrente);
    const [ricevute, setRicevute] = useState<RicevutaRiga[]>([]);
    const [disponibile, setDisponibile] = useState(true);
    const [loading, setLoading] = useState(true);
    const [alunni, setAlunni] = useState<Alunno[]>([]);
    const [attAlunno, setAttAlunno] = useState('');
    const [attAnno, setAttAnno] = useState(annoCorrente);
    // La comunicazione AdE riguarda tipicamente l'anno d'imposta precedente.
    const [adeAnno, setAdeAnno] = useState(annoCorrente - 1);

    const loadRegistro = useCallback(async () => {
        try {
            const r = await fetch(`/api/pagamenti/ricevute?userId=${userId}&anno=${anno}`, { headers: hdr(userId) });
            const j = await r.json();
            if (j?.success) {
                setRicevute(j.data || []);
                setDisponibile(j.disponibile !== false);
            }
        } finally {
            setLoading(false);
        }
    }, [userId, anno]);

    useEffect(() => { loadRegistro(); }, [loadRegistro]);
    useEffect(() => {
        fetch(`/api/admin/students?stato=iscritto&scuola_id=${scuolaId}&limit=1000`, { headers: hdr(userId) })
            .then((r) => r.json())
            .then((d) => {
                const lista: Alunno[] = Array.isArray(d) ? d : (d.data || []);
                // solo frequentanti: gli iscritti senza sezione non maturano rette
                const frequentanti = lista.filter((a) => a.classe_sezione != null || a.section_id != null);
                setAlunni(frequentanti);
                if (frequentanti[0]) setAttAlunno((cur) => cur || frequentanti[0].id);
            })
            .catch(() => {});
    }, [userId, scuolaId]);

    const anni = [annoCorrente, annoCorrente - 1, annoCorrente - 2];
    const selCls = 'py-2 px-3 border-2 border-kidville-line rounded-full font-maven text-sm text-kidville-green bg-white focus:outline-none focus:border-kidville-green';

    return (
        <div className="space-y-8">
            <div>
                <SectionTitle icon={FileSpreadsheet} title="Attestazioni annuali"
                    sub="PDF per il 730 (totale tracciabile detraibile) — scaricabile anche dal genitore in autonomia." />
                <div className="flex flex-wrap items-center gap-2">
                    <select value={attAlunno} onChange={(e) => setAttAlunno(e.target.value)} className={`${selCls} min-w-[220px]`}>
                        {alunni.map((a) => (
                            <option key={a.id} value={a.id}>{a.nome} {a.cognome}{a.classe_sezione ? ` · ${a.classe_sezione}` : ''}</option>
                        ))}
                    </select>
                    <select value={attAnno} onChange={(e) => setAttAnno(Number(e.target.value))} className={selCls}>
                        {anni.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                    {attAlunno ? (
                        <a href={`/api/pagamenti/attestazione?alunno_id=${attAlunno}&anno=${attAnno}&userId=${userId}`}
                            className="inline-flex items-center gap-1.5 rounded-full bg-kidville-green px-4 py-2 font-maven text-sm font-bold text-white hover:opacity-90">
                            <Download size={14} /> Scarica attestazione
                        </a>
                    ) : (
                        <span className="font-maven text-xs text-kidville-muted">Nessun alunno iscritto.</span>
                    )}
                </div>
            </div>

            <div>
                <SectionTitle icon={FileSpreadsheet} title="Comunicazione spese AdE"
                    sub="XLSX per il commercialista (invio entro il 16 marzo): solo quote tracciabili; opposizioni, contanti e categorie escluse motivati nel secondo foglio." />
                <div className="flex flex-wrap items-center gap-2">
                    <select value={adeAnno} onChange={(e) => setAdeAnno(Number(e.target.value))} className={selCls}>
                        {anni.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                    <a href={`/api/pagamenti/export?tipo=ade&anno=${adeAnno}&userId=${userId}&scuola_id=${scuolaId}`}
                        className="inline-flex items-center gap-1.5 rounded-full border-2 border-kidville-green px-4 py-2 font-maven text-sm font-bold text-kidville-green hover:bg-kidville-green hover:text-white">
                        <Download size={14} /> Esporta comunicazione {adeAnno}
                    </a>
                </div>
            </div>

            <div>
                <SectionTitle icon={Receipt} title="Registro ricevute"
                    sub="Ricevute numerate emesse (incluse le annullate: il numero resta a registro)."
                    action={
                        <span className="flex items-center gap-2">
                            <select value={anno} onChange={(e) => { setAnno(Number(e.target.value)); setLoading(true); }} className={selCls}>
                                {anni.map((a) => <option key={a} value={a}>{a}</option>)}
                            </select>
                            <button onClick={() => { setLoading(true); loadRegistro(); }}
                                className="rounded-full border-2 border-kidville-line p-2 text-kidville-muted hover:text-kidville-green">
                                <RefreshCw size={14} />
                            </button>
                        </span>
                    } />
                {loading ? (
                    <p className="py-6 text-center font-maven text-sm text-kidville-muted">Caricamento…</p>
                ) : !disponibile ? (
                    <p className="py-6 text-center font-maven text-sm text-kidville-muted">
                        Registro non ancora attivo su questo database (migrazione da applicare).
                    </p>
                ) : ricevute.length === 0 ? (
                    <p className="py-6 text-center font-maven text-sm text-kidville-muted">Nessuna ricevuta emessa nel {anno}.</p>
                ) : (
                    <>
                        <div className="hidden lg:block overflow-x-auto">
                            <table className="w-full text-left">
                                <thead>
                                    <tr className="font-maven text-xs uppercase text-kidville-muted">
                                        <th className="py-2 px-2">N.</th>
                                        <th className="py-2 px-2">Data</th>
                                        <th className="py-2 px-2">Alunno</th>
                                        <th className="py-2 px-2 text-right">Importo</th>
                                        <th className="py-2 px-2">Stato</th>
                                        <th className="py-2 px-2"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {ricevute.map((r) => <RigaRegistro key={r.id} r={r} userId={userId} mobile={false} />)}
                                </tbody>
                            </table>
                        </div>
                        <div className="space-y-2 lg:hidden">
                            {ricevute.map((r) => <RigaRegistro key={r.id} r={r} userId={userId} mobile />)}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

function ChipsRicevuta({ r }: { r: RicevutaRiga }) {
    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            {r.annullata_il
                ? <Badge tone="error" title={r.annullo_motivo ?? undefined}>Annullata</Badge>
                : <Badge tone={r.tracciabile ? 'success' : 'warn'}>{r.tracciabile ? 'Tracciabile' : 'Contanti'}</Badge>}
            {r.bollo && <Badge tone="neutral">Bollo</Badge>}
        </span>
    );
}

function RigaRegistro({ r, userId, mobile }: { r: RicevutaRiga; userId: string; mobile: boolean }) {
    const alunno = `${r.alunni?.nome ?? ''} ${r.alunni?.cognome ?? ''}`.trim() || '—';
    const pdf = !r.annullata_il && (
        <a href={`/api/pagamenti/ricevuta?pagamento_id=${r.pagamento_id}&userId=${userId}`}
            className="inline-flex items-center gap-1 rounded-full bg-kidville-green/10 px-2 py-1 text-xs font-bold text-kidville-green hover:bg-kidville-green/20">
            <Download size={12} /> PDF
        </a>
    );
    if (mobile) {
        return (
            <div className="rounded-xl border-2 border-kidville-line bg-kidville-white p-3">
                <div className="flex items-center justify-between gap-2">
                    <p className="font-maven text-sm font-bold text-kidville-green">n. {r.numero}/{r.anno} · {alunno}</p>
                    {pdf}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 font-maven text-xs text-kidville-muted">
                    <span>{dataIt(r.creato_il)} · € {Number(r.importo).toFixed(2)}</span>
                    <ChipsRicevuta r={r} />
                </div>
            </div>
        );
    }
    return (
        <tr className="border-t border-kidville-line font-maven text-sm">
            <td className="py-2 px-2 font-bold text-kidville-green">{r.numero}/{r.anno}</td>
            <td className="py-2 px-2 text-kidville-muted">{dataIt(r.creato_il)}</td>
            <td className="py-2 px-2 text-kidville-ink">{alunno}</td>
            <td className="py-2 px-2 text-right text-kidville-green">€ {Number(r.importo).toFixed(2)}</td>
            <td className="py-2 px-2"><ChipsRicevuta r={r} /></td>
            <td className="py-2 px-2 text-right">{pdf}</td>
        </tr>
    );
}
