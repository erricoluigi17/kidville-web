'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { IdCard, ShieldCheck, FileText, LifeBuoy, Loader2, AlertTriangle, Trash2, RotateCcw } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { doLogout } from '@/lib/auth/logout';

// Pagina «Profilo e deleghe» (attiva il placeholder della BottomNav). Contiene i
// link legali e la CANCELLAZIONE ACCOUNT self-service (App Store 5.1.1(v) + GDPR):
// il genitore invia una richiesta (doppia conferma digitando ELIMINA), la Direzione
// la evade. La richiesta è REVOCABILE finché è "in lavorazione".
const CONFERMA = 'ELIMINA';

interface RichiestaStato {
  id: string;
  stato: string;
  creata_il: string;
  evasa_il: string | null;
}

function Inner() {
  const { userId } = useSessionIdentity();
  const [richiesta, setRichiesta] = useState<RichiestaStato | null>(null);
  const [loading, setLoading] = useState(true);
  const [conferma, setConferma] = useState('');
  const [busy, setBusy] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  const hdr = (uid: string) => ({ 'Content-Type': 'application/json', 'x-user-id': uid });

  const carica = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetch('/api/parent/account/richiesta-cancellazione', { headers: { 'x-user-id': userId } });
      const j = await res.json();
      setRichiesta(j?.richiesta ?? null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { carica(); }, [carica]);

  const invia = async () => {
    if (!userId) return;
    setErrore(null);
    setBusy(true);
    try {
      const res = await fetch('/api/parent/account/richiesta-cancellazione', {
        method: 'POST', headers: hdr(userId), body: JSON.stringify({ conferma }),
      });
      const j = await res.json();
      if (!res.ok) { setErrore(j.error || 'Operazione non riuscita.'); return; }
      setConferma('');
      await carica();
    } catch {
      setErrore('Errore di rete. Riprova.');
    } finally {
      setBusy(false);
    }
  };

  const revoca = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      const res = await fetch('/api/parent/account/richiesta-cancellazione', { method: 'DELETE', headers: hdr(userId) });
      if (res.ok) await carica();
    } finally {
      setBusy(false);
    }
  };

  const pending = richiesta?.stato === 'pending';

  return (
    <div className="mx-auto max-w-xl px-4 py-6 pb-28 space-y-5">
      <header className="text-center">
        <IdCard className="mx-auto mb-2 text-kidville-green" size={34} />
        <h1 className="font-barlow text-2xl font-black uppercase tracking-wide text-kidville-green">Profilo e deleghe</h1>
        <p className="mt-1 font-maven text-sm text-kidville-muted">Gestisci l’account, la privacy e la cancellazione dei dati.</p>
      </header>

      {/* Link legali / assistenza */}
      <section className="rounded-card border border-kidville-line bg-white p-2">
        <Link href="/privacy" className="flex items-center gap-3 rounded-xl px-3 py-3 active:bg-kidville-cream" target="_blank" rel="noopener noreferrer">
          <ShieldCheck size={20} className="text-kidville-green" />
          <span className="font-barlow text-sm font-extrabold uppercase text-kidville-green">Informativa sulla privacy</span>
        </Link>
        <Link href="/termini" className="flex items-center gap-3 rounded-xl px-3 py-3 border-t border-kidville-line active:bg-kidville-cream" target="_blank" rel="noopener noreferrer">
          <FileText size={20} className="text-kidville-green" />
          <span className="font-barlow text-sm font-extrabold uppercase text-kidville-green">Termini di servizio</span>
        </Link>
        <Link href="/assistenza" className="flex items-center gap-3 rounded-xl px-3 py-3 border-t border-kidville-line active:bg-kidville-cream" target="_blank" rel="noopener noreferrer">
          <LifeBuoy size={20} className="text-kidville-green" />
          <span className="font-barlow text-sm font-extrabold uppercase text-kidville-green">Assistenza</span>
        </Link>
      </section>

      {/* Cancellazione account */}
      <section className="rounded-card border-t-4 border-kidville-error bg-white p-5 shadow-sm">
        <h2 className="flex items-center gap-2 font-barlow text-lg font-black uppercase tracking-wide text-kidville-error">
          <AlertTriangle size={18} /> Elimina account
        </h2>

        {loading ? (
          <div className="mt-3 flex items-center gap-2 font-maven text-sm text-kidville-muted"><Loader2 className="animate-spin" size={14} /> Caricamento…</div>
        ) : pending ? (
          <div className="mt-3 space-y-3">
            <div className="rounded-xl bg-kidville-warn-soft p-3.5 font-maven text-[13px] text-kidville-ink/80">
              La tua richiesta di cancellazione è <strong>in lavorazione</strong>. La Direzione la evaderà a breve
              (entro 30 giorni). Puoi ancora <strong>annullarla</strong> se hai cambiato idea.
            </div>
            <button
              onClick={revoca}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-pill border border-kidville-line px-4 py-2.5 font-barlow text-sm font-extrabold uppercase text-kidville-green active:bg-kidville-cream disabled:opacity-50"
            >
              {busy ? <Loader2 className="animate-spin" size={15} /> : <RotateCcw size={15} />} Annulla la richiesta
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="font-maven text-[13px] leading-relaxed text-kidville-ink/80">
              La richiesta viene inviata alla Direzione, che <strong>anonimizza in modo irreversibile</strong> i tuoi dati
              personali (nome, contatti, documenti) e sgancia l’accesso. I dati dei figli ancora iscritti restano gestiti
              dalla scuola; i documenti fiscali sono conservati per obbligo di legge.
            </p>
            <label className="block font-maven text-xs font-semibold text-kidville-muted">
              Per confermare, digita <span className="font-mono text-kidville-error">{CONFERMA}</span>
            </label>
            <input
              value={conferma}
              onChange={(e) => setConferma(e.target.value)}
              placeholder={CONFERMA}
              className="w-full rounded-xl border-2 border-kidville-line px-3 py-2.5 font-maven text-sm outline-none focus:border-kidville-error"
            />
            {errore && <p className="font-maven text-xs text-kidville-error">{errore}</p>}
            <button
              onClick={invia}
              disabled={busy || conferma.trim().toUpperCase() !== CONFERMA}
              className="flex w-full items-center justify-center gap-2 rounded-pill bg-kidville-error px-5 py-2.5 font-barlow text-sm font-black uppercase tracking-wider text-kidville-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />} Richiedi la cancellazione
            </button>
          </div>
        )}
      </section>

      <button
        onClick={() => doLogout()}
        className="w-full rounded-pill px-4 py-2.5 font-barlow text-sm font-extrabold uppercase text-kidville-muted active:bg-kidville-cream"
      >
        Esci dall’account
      </button>
    </div>
  );
}

export default function ParentProfiloPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <Inner />
    </Suspense>
  );
}
