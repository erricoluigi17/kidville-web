'use client';

import { useState, useEffect, useCallback } from 'react';
import { Tag, Euro, AlertTriangle, Ticket, FileText, Plus, Trash2, Save, Lock } from 'lucide-react';

interface Props { userId: string; scuolaId: string }

interface Categoria { id: string; nome: string; slug?: string; colore?: string; icona?: string; is_sistema: boolean; ordine: number }
interface Settings {
    retta_default_importo: number; retta_giorno_scadenza: number; retta_giorno_visibilita: number;
    retta_auto_enabled: boolean; insoluto_tolleranza_giorni: number;
    ticket_pacchetti: { label: string; pezzi: number; costo: number }[];
    fattura_causale_template: string;
}
interface ArubaCfg {
    username: string; password_ref: string; has_password: boolean; abilitato: boolean; ambiente: string;
    fiscal: { piva?: string; cf?: string; ragione_sociale?: string; sede?: string; regime?: string };
    iva: { causale: string; aliquota: number; natura?: string }[];
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const card = 'bg-white rounded-2xl shadow-sm p-5 mb-5';
const h3 = 'font-barlow font-black text-base text-kidville-green uppercase tracking-wide mb-4 flex items-center gap-2';
const input = 'border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green';
const label = 'font-maven text-xs text-kidville-muted mb-1 block';
const btnPrimary = 'px-4 py-2 rounded-full bg-kidville-green text-white font-maven font-bold text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-1';

export function SettingsPanel({ userId, scuolaId }: Props) {
    return (
        <div>
            <CategorieManager userId={userId} scuolaId={scuolaId} />
            <RettaMorositaSettings userId={userId} scuolaId={scuolaId} />
            <TicketSettings userId={userId} scuolaId={scuolaId} />
            <ArubaSettings userId={userId} scuolaId={scuolaId} />
        </div>
    );
}

function CategorieManager({ userId }: Props) {
    const [cats, setCats] = useState<Categoria[]>([]);
    const [nuovo, setNuovo] = useState('');
    const load = useCallback(() => {
        fetch(`/api/admin/settings/categorie?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setCats(d.data); });
    }, [userId]);
    useEffect(() => { load(); }, [load]);

    const add = async () => {
        if (!nuovo.trim()) return;
        await fetch('/api/admin/settings/categorie', { method: 'POST', headers: hdr(userId), body: JSON.stringify({ nome: nuovo.trim() }) });
        setNuovo(''); load();
    };
    const del = async (id: string) => {
        const res = await fetch(`/api/admin/settings/categorie?userId=${userId}&id=${id}`, { method: 'DELETE', headers: hdr(userId) });
        if (!res.ok) { const j = await res.json(); alert(j.error); } load();
    };

    return (
        <section className={card}>
            <h3 className={h3}><Tag size={16} /> Categorie pagamento</h3>
            <div className="flex flex-wrap gap-2 mb-3">
                {cats.map(c => (
                    <span key={c.id} className="flex items-center gap-1 bg-kidville-cream rounded-full pl-3 pr-2 py-1 font-maven text-sm text-kidville-green">
                        {c.icona} {c.nome}
                        {c.is_sistema ? <Lock size={11} className="text-kidville-muted" /> :
                            <button onClick={() => del(c.id)} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={13} /></button>}
                    </span>
                ))}
            </div>
            <div className="flex gap-2">
                <input value={nuovo} onChange={e => setNuovo(e.target.value)} placeholder="Nuova categoria…" className={`${input} flex-1`} />
                <button onClick={add} className={btnPrimary}><Plus size={14} /> Aggiungi</button>
            </div>
            <p className="font-maven text-[11px] text-kidville-muted mt-2"><Lock size={10} className="inline" /> = categoria di sistema (non eliminabile).</p>
        </section>
    );
}

function RettaMorositaSettings({ userId }: Props) {
    const [s, setS] = useState<Settings | null>(null);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setS(d.data); });
    }, [userId]);
    if (!s) return null;
    const save = async () => {
        setSaving(true);
        await fetch('/api/admin/settings', { method: 'PATCH', headers: hdr(userId), body: JSON.stringify({
            retta_default_importo: s.retta_default_importo, retta_giorno_scadenza: s.retta_giorno_scadenza,
            retta_giorno_visibilita: s.retta_giorno_visibilita,
            retta_auto_enabled: s.retta_auto_enabled, insoluto_tolleranza_giorni: s.insoluto_tolleranza_giorni,
            fattura_causale_template: s.fattura_causale_template,
        }) });
        setSaving(false);
    };
    return (
        <section className={card}>
            <h3 className={h3}><Euro size={16} /> Retta e morosità</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div><label className={label}>Retta default (€)</label>
                    <input type="number" value={s.retta_default_importo || ''} onChange={e => setS({ ...s, retta_default_importo: Number(e.target.value) })} className={`${input} w-full`} /></div>
                <div><label className={label}>Giorno scadenza (1-28)</label>
                    <input type="number" min={1} max={28} value={s.retta_giorno_scadenza} onChange={e => setS({ ...s, retta_giorno_scadenza: Number(e.target.value) })} className={`${input} w-full`} /></div>
                <div><label className={label}>Visibile dal giorno (mese prec.)</label>
                    <input type="number" min={1} max={28} value={s.retta_giorno_visibilita ?? 25} onChange={e => setS({ ...s, retta_giorno_visibilita: Number(e.target.value) })} className={`${input} w-full`} /></div>
                <div><label className={label}><AlertTriangle size={11} className="inline" /> Tolleranza insoluti (gg)</label>
                    <input type="number" value={s.insoluto_tolleranza_giorni} onChange={e => setS({ ...s, insoluto_tolleranza_giorni: Number(e.target.value) })} className={`${input} w-full`} /></div>
            </div>
            <p className="font-maven text-[11px] text-kidville-muted mt-1">La retta mensile compare al genitore dal giorno indicato del mese precedente alla competenza.</p>
            <label className="flex items-center gap-2 cursor-pointer mt-3">
                <input type="checkbox" checked={s.retta_auto_enabled} onChange={e => setS({ ...s, retta_auto_enabled: e.target.checked })} className="w-4 h-4 rounded text-kidville-green" />
                <span className="font-maven text-sm text-kidville-green">Generazione automatica rette mensili</span>
            </label>
            <div className="mt-4">
                <label className={label}>Causale fattura (template)</label>
                <input value={s.fattura_causale_template ?? ''} onChange={e => setS({ ...s, fattura_causale_template: e.target.value })}
                    placeholder="{descrizione} - {alunno}" className={`${input} w-full`} />
                <p className="font-maven text-[11px] text-kidville-muted mt-1">Segnaposto disponibili: {'{descrizione}'}, {'{alunno}'}, {'{periodo}'}. Modificabile al momento dell&apos;emissione.</p>
            </div>
            <div className="mt-4"><button onClick={save} disabled={saving} className={btnPrimary}><Save size={14} /> {saving ? 'Salvataggio…' : 'Salva'}</button></div>
        </section>
    );
}

function TicketSettings({ userId }: Props) {
    const [pacchetti, setPacchetti] = useState<{ label: string; pezzi: number; costo: number }[]>([]);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setPacchetti(d.data.ticket_pacchetti || []); });
    }, [userId]);
    const save = async () => {
        setSaving(true);
        await fetch('/api/admin/settings', { method: 'PATCH', headers: hdr(userId), body: JSON.stringify({ ticket_pacchetti: pacchetti }) });
        setSaving(false);
    };
    const upd = (i: number, k: string, v: string | number) => setPacchetti(pacchetti.map((p, idx) => idx === i ? { ...p, [k]: v } : p));
    return (
        <section className={card}>
            <h3 className={h3}><Ticket size={16} /> Pacchetti ticket mensa</h3>
            <div className="space-y-2 mb-3">
                {pacchetti.map((p, i) => (
                    <div key={i} className="flex gap-2 items-center">
                        <input value={p.label} onChange={e => upd(i, 'label', e.target.value)} placeholder="Nome" className={`${input} flex-1`} />
                        <input type="number" value={p.pezzi || ''} onChange={e => upd(i, 'pezzi', Number(e.target.value))} placeholder="Pezzi" className={`${input} w-24`} />
                        <input type="number" value={p.costo || ''} onChange={e => upd(i, 'costo', Number(e.target.value))} placeholder="€" className={`${input} w-24`} />
                        <button onClick={() => setPacchetti(pacchetti.filter((_, idx) => idx !== i))} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={15} /></button>
                    </div>
                ))}
            </div>
            <div className="flex gap-2">
                <button onClick={() => setPacchetti([...pacchetti, { label: '', pezzi: 10, costo: 50 }])} className="px-3 py-2 rounded-full border-2 border-kidville-line font-maven text-sm text-kidville-muted flex items-center gap-1"><Plus size={14} /> Pacchetto</button>
                <button onClick={save} disabled={saving} className={btnPrimary}><Save size={14} /> {saving ? '…' : 'Salva'}</button>
            </div>
        </section>
    );
}

function ArubaSettings({ userId }: Props) {
    const [cfg, setCfg] = useState<ArubaCfg | null>(null);
    const [saving, setSaving] = useState(false);
    const [pwd, setPwd] = useState('');
    useEffect(() => {
        fetch(`/api/admin/settings/aruba?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setCfg(d.data); });
    }, [userId]);
    if (!cfg) return null;
    const save = async () => {
        setSaving(true);
        const body: Record<string, unknown> = {
            username: cfg.username, fiscal: cfg.fiscal, abilitato: cfg.abilitato, ambiente: cfg.ambiente,
        };
        if (pwd) body.password_ref = pwd;
        const res = await fetch('/api/admin/settings/aruba', { method: 'PATCH', headers: hdr(userId), body: JSON.stringify(body) });
        const j = await res.json(); if (j.success) { setCfg(j.data); setPwd(''); }
        setSaving(false);
    };
    const f = cfg.fiscal || {};
    return (
        <section className={card}>
            <h3 className={h3}><FileText size={16} /> Fatturazione Aruba <span className="text-[10px] bg-kidville-warn-soft text-kidville-warn px-2 py-0.5 rounded-full">Scaffold</span></h3>
            <p className="font-maven text-xs text-kidville-muted mb-3">Predisposizione. La chiamata reale ad Aruba sarà attivata in produzione. Le credenziali non vengono salvate in chiaro (solo riferimento a vault/env).</p>
            <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Username Aruba</label><input value={cfg.username} onChange={e => setCfg({ ...cfg, username: e.target.value })} className={`${input} w-full`} /></div>
                <div><label className={label}>Password (riferimento vault){cfg.has_password && ' ✓ impostata'}</label><input type="password" value={pwd} onChange={e => setPwd(e.target.value)} placeholder={cfg.has_password ? '••••••' : 'es. ARUBA_PWD_REF'} className={`${input} w-full`} /></div>
                <div><label className={label}>Partita IVA</label><input value={f.piva ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, piva: e.target.value } })} className={`${input} w-full`} /></div>
                <div><label className={label}>Codice Fiscale</label><input value={f.cf ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, cf: e.target.value } })} className={`${input} w-full`} /></div>
                <div className="col-span-2"><label className={label}>Ragione sociale</label><input value={f.ragione_sociale ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, ragione_sociale: e.target.value } })} className={`${input} w-full`} /></div>
                <div><label className={label}>Sede legale</label><input value={f.sede ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, sede: e.target.value } })} className={`${input} w-full`} /></div>
                <div><label className={label}>Regime fiscale</label><input value={f.regime ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, regime: e.target.value } })} className={`${input} w-full`} /></div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer mt-3">
                <input type="checkbox" checked={cfg.abilitato} onChange={e => setCfg({ ...cfg, abilitato: e.target.checked })} className="w-4 h-4 rounded text-kidville-green" />
                <span className="font-maven text-sm text-kidville-green">Abilita invio fatture (in produzione)</span>
            </label>
            <div className="mt-4"><button onClick={save} disabled={saving} className={btnPrimary}><Save size={14} /> {saving ? 'Salvataggio…' : 'Salva'}</button></div>
        </section>
    );
}
