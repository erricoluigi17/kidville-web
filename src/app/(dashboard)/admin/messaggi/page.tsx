'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { MessageCircle, Users, Send, Loader2, Eye } from 'lucide-react';
import { CockpitPage, CockpitSelect, PageHeader, Tabs } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

interface OversightThread {
  id: string;
  last_message_at: string | null;
  teacher: { id: string; nome: string; ruolo?: string } | null;
  parent: { id: string; nome: string } | null;
  student: { nome: string; classe: string | null } | null;
}
interface Filtri { docenti: { id: string; nome: string }[]; genitori: { id: string; nome: string }[]; classi: string[] }
interface Msg { id: string; sender_id: string; content: string; created_at: string }
interface Contatto { parentUserId: string; parentName: string; studentId: string; studentName: string; classe: string | null }

function fmtWhen(iso: string | null) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function MessaggiInner() {
  const { userId } = useSessionIdentity();
  const [tab, setTab] = useState<'genitori' | 'tutti'>('genitori');

  // ── Tab "Tutti i messaggi" (supervisione, sola lettura) ──
  const [threads, setThreads] = useState<OversightThread[]>([]);
  const [filtri, setFiltri] = useState<Filtri>({ docenti: [], genitori: [], classi: [] });
  const [fTeacher, setFTeacher] = useState('');
  const [fParent, setFParent] = useState('');
  const [fClasse, setFClasse] = useState('');
  const [selThread, setSelThread] = useState<OversightThread | null>(null);
  const [oversightMsgs, setOversightMsgs] = useState<Msg[]>([]);
  // Parte true (niente setState sincrono negli effect); i refetch da filtro non
  // rimostrano lo spinner, come il resto del cockpit.
  const [loadingThreads, setLoadingThreads] = useState(true);

  const fetchThreads = useCallback(() => {
    const params = new URLSearchParams();
    if (fTeacher) params.set('teacher_id', fTeacher);
    if (fParent) params.set('parent_id', fParent);
    if (fClasse) params.set('classe', fClasse);
    fetch(`/api/admin/chat/threads?${params.toString()}`)
      .then(r => r.json())
      .then(j => { if (j.success) { setThreads(j.data); setFiltri(j.filtri); } })
      .catch(() => {})
      .finally(() => setLoadingThreads(false));
  }, [fTeacher, fParent, fClasse]);

  useEffect(() => { if (tab === 'tutti') fetchThreads(); }, [tab, fetchThreads]);

  const openOversight = (t: OversightThread) => {
    setSelThread(t);
    setOversightMsgs([]);
    fetch(`/api/admin/chat/messages?thread_id=${t.id}`)
      .then(r => r.json())
      .then(j => { if (j.success) setOversightMsgs(j.data); })
      .catch(() => {});
  };

  // ── Tab "Con i genitori" (chat segreteria↔genitore) ──
  const [contatti, setContatti] = useState<Contatto[]>([]);
  const [selContatto, setSelContatto] = useState<Contatto | null>(null);
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const [chatMsgs, setChatMsgs] = useState<Msg[]>([]);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingContatti, setLoadingContatti] = useState(true);

  useEffect(() => {
    if (tab !== 'genitori') return;
    fetch('/api/admin/chat/contacts')
      .then(r => r.json())
      .then(j => { if (j.success) setContatti(j.data); })
      .catch(() => {})
      .finally(() => setLoadingContatti(false));
  }, [tab]);

  const loadChatMessages = useCallback((threadId: string, uid: string) => {
    fetch(`/api/chat/messages?threadId=${threadId}&markRead=${uid}`)
      .then(r => r.json())
      .then(j => setChatMsgs(j.messages ?? []))
      .catch(() => {});
  }, []);

  const openContatto = async (c: Contatto) => {
    if (!userId) return;
    setSelContatto(c);
    setChatMsgs([]);
    setChatThreadId(null);
    try {
      const res = await fetch('/api/chat/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id: userId, parent_id: c.parentUserId, student_id: c.studentId }),
      });
      const thread = await res.json();
      if (thread?.id) { setChatThreadId(thread.id); loadChatMessages(thread.id, userId); }
    } catch { /* no-op */ }
  };

  const invia = async () => {
    if (!composer.trim() || !chatThreadId || !userId) return;
    setSending(true);
    try {
      await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: chatThreadId, sender_id: userId, content: composer.trim() }),
      });
      setComposer('');
      loadChatMessages(chatThreadId, userId);
    } finally { setSending(false); }
  };

  const selLabels = useMemo(() => {
    if (!selThread) return { teacher: '', parent: '' };
    return { teacher: selThread.teacher?.id ?? '', parent: selThread.parent?.id ?? '' };
  }, [selThread]);

  return (
    <CockpitPage max={1200}>
      <PageHeader eyebrow="Comunicazione" icon={MessageCircle} title="Messaggi" subtitle="Chat con i genitori e supervisione delle conversazioni genitore↔insegnante." />

      <Tabs
        value={tab}
        onChange={(v) => setTab(v as 'genitori' | 'tutti')}
        options={[
          { id: 'genitori', label: 'Con i genitori', icon: Users },
          { id: 'tutti', label: 'Tutti i messaggi', icon: Eye },
        ]}
      />

      {tab === 'genitori' ? (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          {/* Elenco genitori */}
          <div className="rounded-card bg-kidville-white p-3 shadow-sm max-h-[70vh] overflow-y-auto">
            {loadingContatti ? (
              <p className="font-maven text-sm text-kidville-muted flex items-center gap-2 p-2"><Loader2 size={14} className="animate-spin" /> Caricamento…</p>
            ) : contatti.length === 0 ? (
              <p className="font-maven text-sm text-kidville-muted p-2">Nessun genitore con account trovato.</p>
            ) : contatti.map(c => (
              <button
                key={c.parentUserId}
                onClick={() => openContatto(c)}
                className={`w-full text-left rounded-input px-3 py-2.5 mb-1 transition-colors ${selContatto?.parentUserId === c.parentUserId ? 'bg-kidville-green-soft' : 'hover:bg-kidville-cream'}`}
              >
                <p className="font-maven text-sm font-semibold text-kidville-ink">{c.parentName}</p>
                <p className="font-maven text-xs text-kidville-muted">{c.studentName}{c.classe ? ` · ${c.classe}` : ''}</p>
              </button>
            ))}
          </div>

          {/* Conversazione */}
          <div className="rounded-card bg-kidville-white p-4 shadow-sm flex flex-col max-h-[70vh]">
            {!selContatto ? (
              <p className="font-maven text-sm text-kidville-muted m-auto">Seleziona un genitore per iniziare a scrivere.</p>
            ) : (
              <>
                <div className="border-b border-kidville-line pb-2 mb-3">
                  <p className="font-barlow font-bold text-kidville-green">{selContatto.parentName}</p>
                  <p className="font-maven text-xs text-kidville-muted">{selContatto.studentName}{selContatto.classe ? ` · ${selContatto.classe}` : ''}</p>
                </div>
                <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                  {chatMsgs.length === 0 && <p className="font-maven text-sm text-kidville-muted text-center py-6">Nessun messaggio. Scrivi il primo.</p>}
                  {chatMsgs.map(m => {
                    const mine = m.sender_id === userId;
                    return (
                      <div key={m.id} className={`max-w-[75%] rounded-2xl px-3 py-2 font-maven text-sm ${mine ? 'ml-auto bg-kidville-green text-white' : 'bg-kidville-cream text-kidville-ink'}`}>
                        <p>{m.content}</p>
                        <p className={`text-[10px] mt-1 ${mine ? 'text-white/70' : 'text-kidville-muted'}`}>{fmtWhen(m.created_at)}</p>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    value={composer}
                    onChange={e => setComposer(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') invia(); }}
                    placeholder="Scrivi un messaggio…"
                    className="flex-1 border-2 border-kidville-line rounded-pill px-4 py-2 font-maven text-sm focus:outline-none focus:border-kidville-green"
                  />
                  <button onClick={invia} disabled={sending || !composer.trim() || !chatThreadId} className="flex h-10 w-10 items-center justify-center rounded-full bg-kidville-green text-white disabled:opacity-50">
                    {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Filtri */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <CockpitSelect
              value={fTeacher}
              onChange={setFTeacher}
              options={[{ value: '', label: 'Tutti gli insegnanti' }, ...filtri.docenti.map(d => ({ value: d.id, label: d.nome }))]}
            />
            <CockpitSelect
              value={fParent}
              onChange={setFParent}
              options={[{ value: '', label: 'Tutti i genitori' }, ...filtri.genitori.map(g => ({ value: g.id, label: g.nome }))]}
            />
            <CockpitSelect
              value={fClasse}
              onChange={setFClasse}
              options={[{ value: '', label: 'Tutte le classi' }, ...filtri.classi.map(c => ({ value: c, label: c }))]}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
            {/* Elenco thread */}
            <div className="rounded-card bg-kidville-white p-3 shadow-sm max-h-[70vh] overflow-y-auto">
              {loadingThreads ? (
                <p className="font-maven text-sm text-kidville-muted flex items-center gap-2 p-2"><Loader2 size={14} className="animate-spin" /> Caricamento…</p>
              ) : threads.length === 0 ? (
                <p className="font-maven text-sm text-kidville-muted p-2">Nessuna conversazione trovata.</p>
              ) : threads.map(t => (
                <button
                  key={t.id}
                  onClick={() => openOversight(t)}
                  className={`w-full text-left rounded-input px-3 py-2.5 mb-1 transition-colors ${selThread?.id === t.id ? 'bg-kidville-green-soft' : 'hover:bg-kidville-cream'}`}
                >
                  <p className="font-maven text-sm font-semibold text-kidville-ink">{t.parent?.nome ?? '—'} ↔ {t.teacher?.nome ?? '—'}</p>
                  <p className="font-maven text-xs text-kidville-muted">{t.student?.nome ?? ''}{t.student?.classe ? ` · ${t.student.classe}` : ''} · {fmtWhen(t.last_message_at)}</p>
                </button>
              ))}
            </div>

            {/* Messaggi (sola lettura) */}
            <div className="rounded-card bg-kidville-white p-4 shadow-sm flex flex-col max-h-[70vh]">
              {!selThread ? (
                <p className="font-maven text-sm text-kidville-muted m-auto">Seleziona una conversazione per leggerla.</p>
              ) : (
                <>
                  <div className="border-b border-kidville-line pb-2 mb-3 flex items-center justify-between">
                    <div>
                      <p className="font-barlow font-bold text-kidville-green">{selThread.parent?.nome ?? '—'} ↔ {selThread.teacher?.nome ?? '—'}</p>
                      <p className="font-maven text-xs text-kidville-muted">{selThread.student?.nome ?? ''}{selThread.student?.classe ? ` · ${selThread.student.classe}` : ''}</p>
                    </div>
                    <span className="font-maven text-[11px] text-kidville-muted inline-flex items-center gap-1"><Eye size={12} /> sola lettura</span>
                  </div>
                  <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                    {oversightMsgs.length === 0 && <p className="font-maven text-sm text-kidville-muted text-center py-6">Nessun messaggio in questa conversazione.</p>}
                    {oversightMsgs.map(m => {
                      const fromTeacher = m.sender_id === selLabels.teacher;
                      return (
                        <div key={m.id} className={`max-w-[75%] rounded-2xl px-3 py-2 font-maven text-sm ${fromTeacher ? 'ml-auto bg-kidville-info-soft text-kidville-ink' : 'bg-kidville-cream text-kidville-ink'}`}>
                          <p className="text-[10px] font-bold text-kidville-muted mb-0.5">{fromTeacher ? (selThread.teacher?.nome ?? 'Insegnante') : (selThread.parent?.nome ?? 'Genitore')}</p>
                          <p>{m.content}</p>
                          <p className="text-[10px] mt-1 text-kidville-muted">{fmtWhen(m.created_at)}</p>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </CockpitPage>
  );
}

export default function AdminMessaggiPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <MessaggiInner />
    </Suspense>
  );
}
