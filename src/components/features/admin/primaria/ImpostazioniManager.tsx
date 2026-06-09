'use client';

import { useCallback, useEffect, useState } from 'react';
import { Save } from 'lucide-react';

// Vincoli temporali e buffer notifiche della didattica primaria.
// La matrice funzioni per grado si gestisce da Impostazioni → Funzioni & moduli.
export function ImpostazioniManager({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const [classeOrale, setClasseOrale] = useState(2);
  const [scrittoPratico, setScrittoPratico] = useState(15);
  const [buffer, setBuffer] = useState(10);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/primaria/impostazioni?scuolaId=${scuolaId}`);
    const d = await r.json();
    if (d.success) {
      setClasseOrale(d.data.timelock_giorni_classe_orale ?? 2);
      setScrittoPratico(d.data.timelock_giorni_scritto_pratico ?? 15);
      setBuffer(d.data.notif_buffer_valutazioni_min ?? 10);
    }
  }, [scuolaId]);

  useEffect(() => { load(); }, [load]);

  const salva = async () => {
    setMsg('');
    const r = await fetch(`/api/admin/primaria/impostazioni?userId=${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        scuolaId,
        timelock_giorni_classe_orale: classeOrale,
        timelock_giorni_scritto_pratico: scrittoPratico,
        notif_buffer_valutazioni_min: buffer,
      }),
    });
    const d = await r.json();
    setMsg(r.ok ? 'Salvato ✓' : d.error || 'Errore');
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className="font-barlow text-base font-bold text-gray-800 mb-2">Vincoli temporali e notifiche</h3>
        <p className="font-maven text-xs text-gray-400 mb-3">
          Finestre di modifica del registro e buffer di invio notifiche valutazioni. L&apos;attivazione dei moduli per grado si gestisce da Impostazioni → Funzioni &amp; moduli.
        </p>
        <div className="flex flex-wrap gap-4">
          <label className="font-maven text-sm text-gray-600">
            Registro/orali (giorni)
            <input type="number" value={classeOrale} onChange={(e) => setClasseOrale(Number(e.target.value))} className="ml-2 w-16 rounded-pill border border-gray-200 px-2 py-1" />
          </label>
          <label className="font-maven text-sm text-gray-600">
            Scritti/pratici (giorni)
            <input type="number" value={scrittoPratico} onChange={(e) => setScrittoPratico(Number(e.target.value))} className="ml-2 w-16 rounded-pill border border-gray-200 px-2 py-1" />
          </label>
          <label className="font-maven text-sm text-gray-600">
            Buffer notifiche (min)
            <input type="number" value={buffer} onChange={(e) => setBuffer(Number(e.target.value))} className="ml-2 w-16 rounded-pill border border-gray-200 px-2 py-1" />
          </label>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button onClick={salva} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow">
          <Save size={15} /> Salva impostazioni
        </button>
        {msg && <span className={`font-maven text-sm ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</span>}
      </div>
    </div>
  );
}
