'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

interface ScalaItem { id: string; etichetta: string; ordine: number }
interface TemplateItem { id: string; scuola_id: string | null; dimensione: string; valore: string; frammento: string }

export function GiudiziManager({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const [scala, setScala] = useState<ScalaItem[]>([]);
  const [template, setTemplate] = useState<TemplateItem[]>([]);
  const [nuova, setNuova] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/primaria/giudizi?scuolaId=${scuolaId}`);
    const d = await r.json();
    if (d.success) { setScala(d.data.scala); setTemplate(d.data.template); }
  }, [scuolaId]);

  useEffect(() => { load(); }, [load]);

  const addScala = async () => {
    if (!nuova) return;
    await fetch(`/api/admin/primaria/giudizi?action=scala&userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scuolaId, etichetta: nuova, ordine: scala.length + 1 }),
    });
    setNuova('');
    load();
  };

  const removeScala = async (id: string) => {
    await fetch(`/api/admin/primaria/giudizi?tipo=scala&id=${id}&userId=${userId}`, { method: 'DELETE', headers: { 'x-user-id': userId } });
    load();
  };

  const saveFrammento = async (t: TemplateItem, frammento: string) => {
    await fetch(`/api/admin/primaria/giudizi?action=template&userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scuolaId, dimensione: t.dimensione, valore: t.valore, frammento }),
    });
    load();
  };

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section>
        <h3 className="font-barlow text-base font-bold text-gray-800 mb-2">Scala giudizi sintetici</h3>
        <p className="font-maven text-xs text-gray-400 mb-3">Usata in itinere e a scrutinio. Pre-impostata con i 6 giudizi ufficiali (Allegato A).</p>
        <ul className="divide-y divide-gray-100 mb-3">
          {scala.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <span className="font-maven text-sm text-gray-700">{s.ordine}. {s.etichetta}</span>
              <button onClick={() => removeScala(s.id)} className="text-gray-400 hover:text-kidville-error"><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input value={nuova} onChange={(e) => setNuova(e.target.value)} placeholder="Nuovo giudizio" className="font-maven flex-1 rounded-pill border border-gray-200 px-3 py-1.5 text-sm" />
          <button onClick={addScala} className="font-maven inline-flex items-center gap-1 rounded-pill bg-kidville-green px-3 py-1.5 text-sm text-kidville-yellow"><Plus size={14} /></button>
        </div>
      </section>

      <section>
        <h3 className="font-barlow text-base font-bold text-gray-800 mb-2">Template giudizio descrittivo</h3>
        <p className="font-maven text-xs text-gray-400 mb-3">Frammenti componibili per dimensione/valore. Modificandoli sovrascrivi il default per la tua scuola.</p>
        <div className="space-y-1.5">
          {template.map((t) => (
            <div key={t.id} className="flex items-center gap-2">
              <span className="font-maven text-[11px] text-gray-400 w-28 shrink-0">{t.dimensione}={t.valore}</span>
              <input
                defaultValue={t.frammento}
                onBlur={(e) => { if (e.target.value !== t.frammento) saveFrammento(t, e.target.value); }}
                className="font-maven flex-1 rounded border border-gray-200 px-2 py-1 text-xs"
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
