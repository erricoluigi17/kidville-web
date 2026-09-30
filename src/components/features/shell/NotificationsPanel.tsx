'use client';

/**
 * Centro notifiche della AppBar genitore/docente: campanella pill (stile
 * AppBar) con badge conteggio non lette + dropdown con le ultime 20 notifiche
 * da GET /api/notifiche, poll 60s (mirror di AdminNotificationsPanel, stile
 * shell). Il click su una notifica la segna letta (PATCH { id }) e apre il suo
 * link (una notifica di chat apre la conversazione, vedi `apri`); "Segna tutte
 * lette" fa il PATCH senza id. Footer: link agli avvisi.
 * Identità: fetch sempre con ?userId= (pattern parent/localStorage); i link di
 * navigazione portano ?userId= solo lato docente (rotte genitore nude).
 *
 * DAL 2026-09-29 QUESTO PANNELLO PORTA ANCHE IL NUMERO DELLA BARRA IN BASSO. La risposta di
 * `/api/notifiche` include `chat_non_letti` (i messaggi di chat non letti), e `load()` lo scrive
 * nello store del contatore (`@/components/features/chat/contatore-non-letti`), da cui le due
 * bottom-nav lo leggono: nessuna richiesta in più, e il badge su «Messaggi»/«Chat» si vede da
 * qualunque schermata. Nell'altro verso, quando una conversazione viene letta questo pannello
 * ricarica — la lettura spegne anche le notifiche di quel thread, e il numero a schermo sarebbe
 * vecchio per un minuto.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import Link from 'next/link';
import { Bell, BellOff } from 'lucide-react';
import { SHADOW_FLOAT } from '@/components/ui/Card';
import { impostaBadgeNonLette } from '@/lib/native/badge';
import { linkEffettivoNotifica } from '@/lib/chat/link-conversazione';
import { apriLinkNotifica } from '@/lib/chat/apertura-thread';
import {
  azzeraChatNonLetti,
  impostaChatNonLettiDalServer,
  sequenzaChatNonLetti,
  useRicaricaSuChatLetta,
} from '@/components/features/chat/contatore-non-letti';

interface Notifica {
  id: string;
  tipo: string | null;
  titolo: string | null;
  corpo: string | null;
  link: string | null;
  /** Cosa nomina la notifica (`chat_thread` per un messaggio): `/api/notifiche` lo restituisce già. */
  entita_tipo: string | null;
  entita_id: string | null;
  letta_il: string | null;
  creato_il: string;
}

function quando(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${intlDateTime(locale, { day: 'numeric', month: 'short' }).format(d)} · ${intlDateTime(locale, { hour: '2-digit', minute: '2-digit' }).format(d)}`;
}

export function NotificationsPanel({ area, userId }: { area: 'teacher' | 'parent'; userId: string | null }) {
  const t = useTranslations('shared');
  const locale = useLocale();
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notifica[]>([]);
  const [nonLette, setNonLette] = useState(0);
  const [ready, setReady] = useState(false);

  const root = area === 'teacher' ? '/teacher' : '/parent';
  const qs = userId ? `?userId=${userId}` : '';

  /**
   * CAMBIA LA PERSONA, IL CONTATORE DELLA CHAT TORNA A «NON LO SO».
   *
   * Il logout a mano ricarica la pagina (`doLogout` → `window.location.href`) e porta via con sé
   * ogni stato di modulo. Ma una sessione SCADUTA porta al login con una navigazione morbida: il
   * contesto JavaScript non muore, e chi entra dopo vedrebbe sulla barra il numero del genitore di
   * prima — finché il server non ne manda uno nuovo, e per sempre se risponde `null`. Un numero
   * solo, ma è il numero di un'altra famiglia.
   *
   * Due momenti, e il primo è quello che conta:
   *  · lo SMONTAGGIO della campanella. `/auth/login` sta fuori da `(dashboard)`: con la sessione
   *    scaduta la barra si smonta, e quella nuova nasce SENZA identità (`useSessionIdentity` parte
   *    da `null`) per poi risolvere la persona nuova. `null → uuid` non è un cambio che si possa
   *    riconoscere, quindi il numero va via quando va via la campanella che lo portava;
   *  · il cambio fra due identità vere sulla STESSA istanza (`A → B`), per completezza.
   * `null → uuid` da solo non azzera: è la risoluzione dell'identità, non una persona nuova.
   *
   * In un layout effect e NON durante il render: l'azzeramento avvisa gli ascoltatori dello store —
   * le barre, cioè ALTRI componenti — e React vieta di aggiornarli mentre si rende questo («Cannot
   * update a component while rendering a different component»). Il layout effect gira prima del
   * disegno: nessun frame col numero vecchio sotto l'identità nuova.
   */
  const identitaPrecedente = useRef(userId);
  useLayoutEffect(() => {
    const prima = identitaPrecedente.current;
    identitaPrecedente.current = userId;
    if (prima && userId && prima !== userId) azzeraChatNonLetti();
  }, [userId]);
  useEffect(() => () => azzeraChatNonLetti(), []);

  // Pattern PagamentiSummary (react-hooks 7): niente setState sincrono
  // pre-await, nessun catch top-level (fetch già .catch(() => null)), try/finally.
  const load = useCallback(async () => {
    // La sequenza del contatore della chat PRIMA della partenza: se una conversazione viene letta
    // mentre questa richiesta è in volo, il numero che torna è vecchio e lo store lo scarta.
    // Senza, un poll in volo rimetterebbe in piedi i messaggi appena letti.
    const sequenzaChat = sequenzaChatNonLetti();
    try {
      const res = await fetch(`/api/notifiche${qs}`, {
        headers: userId ? { 'x-user-id': userId } : undefined,
      }).catch(() => null);
      const j = res?.ok ? await res.json().catch(() => null) : null;
      if (j?.success) {
        setItems((j.data ?? []).slice(0, 20));
        const nl = j.non_lette ?? 0;
        setNonLette(nl);
        // Badge dell'icona app (nativo): riflette le notifiche non lette.
        // No-op su web e gated internamente; best-effort, mai lancia.
        void impostaBadgeNonLette(nl);
        /**
         * I MESSAGGI DI CHAT NON LETTI — il numero per la barra in basso, che la campanella si
         * porta dietro senza una richiesta in più.
         *
         * ⚠️ SOLO SE È UN NUMERO, e MAI `?? 0`. `chat_non_letti` è `number | null` ed è ASSENTE
         * nelle risposte d'errore (contratto dichiarato in `notifiche:GET`); gli stub E2E di
         * questa route non lo mandano affatto (`e2e/fatture-pdf.spec.ts`). Uno zero di ripiego
         * direbbe «hai letto tutto»: la bugia esatta che questo lavoro esiste per togliere di
         * mezzo, e indistinguibile dal caso vero. `null` e assenza lasciano l'ultimo valore noto.
         */
        if (typeof j.chat_non_letti === 'number') {
          impostaChatNonLettiDalServer(j.chat_non_letti, sequenzaChat);
        }
      }
    } finally {
      setReady(true);
    }
  }, [qs, userId]);

  useEffect(() => { load(); }, [load]);

  /**
   * UNA CONVERSAZIONE È STATA LETTA: la campanella scende subito, non al prossimo minuto.
   *
   * Dal passo 1 la lettura spegne anche le NOTIFICHE di quel thread (misurato in produzione: il
   * 73% delle notifiche di chat non lette riguardava conversazioni già lette). Il numero in
   * tabella è già giusto; quello a schermo è dell'ultimo giro, e senza questa ricarica resta
   * gonfio fino a 60 s — cioè il contatore che le maestre avevano imparato a ignorare.
   *
   * Il rimando e il timer stanno in `useRicaricaSuChatLetta`, accanto allo store: nessun orologio
   * nuovo, il ritmo resta quello di `usePollingVisibile`.
   */
  useRicaricaSuChatLetta(load);

  // Poll 60s (niente canali realtime, stesso pattern del centro notifiche admin), fermo a
  // pagina nascosta. Questo pannello è montato dall'AppBar su OGNI pagina genitore e docente:
  // è un minuto di richieste per ogni schermata aperta, anche a schermo spento.
  usePollingVisibile(load, 60_000);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // ?userId= sui link solo lato docente: le rotte genitore sono nude
  // (identità da localStorage, come nelle bottom nav).
  const withUser = (href: string) =>
    area === 'teacher' && userId ? `${href}${href.includes('?') ? '&' : '?'}userId=${userId}` : href;

  const apri = async (n: Notifica) => {
    setOpen(false);
    if (!n.letta_il) {
      await fetch(`/api/notifiche${qs}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
        body: JSON.stringify({ id: n.id }),
      }).catch(() => null);
      void load();
    }
    // Il link passa dalla regola del tocco (`@/lib/chat/apertura-thread`), come sulla push nativa.
    // `linkEffettivoNotifica` ricostruisce `?thread=` per le notifiche di chat nate prima del
    // 2026-09-15, che portano la lista ma nominano la conversazione in `entita_*`; `apriLinkNotifica`
    // apre la conversazione nella pagina chat già montata (lì una push allo stesso percorso non
    // rimonterebbe niente), riscrive il percorso nell'area in cui ci si trova e rifiuta, con un log,
    // un link che non è di questa app.
    const link = linkEffettivoNotifica(n);
    if (link) apriLinkNotifica(withUser(link), (url) => router.push(url));
  };

  const segnaTutte = async () => {
    await fetch(`/api/notifiche${qs}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
      body: JSON.stringify({}),
    }).catch(() => null);
    void load();
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={nonLette > 0 ? t('notificheAria', { count: nonLette }) : t('notifiche')}
        className="relative flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-transform active:scale-95"
      >
        <Bell size={19} />
        {nonLette > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-pill bg-kidville-yellow px-1 font-barlow text-[10px] font-extrabold leading-none text-kidville-green"
            style={{ boxShadow: '0 0 0 2px var(--color-kidville-green)' }}
          >
            {nonLette > 9 ? '9+' : nonLette}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-[60] w-[calc(100vw-32px)] max-w-[340px] rounded-[14px] bg-kidville-white p-1.5"
          style={{ boxShadow: SHADOW_FLOAT }}
        >
          <div className="flex items-center justify-between gap-2 px-2.5 pb-1.5 pt-2">
            <span className="font-barlow text-[13px] font-extrabold uppercase tracking-[0.02em] text-kidville-green">
              {t('notifiche')}
            </span>
            {nonLette > 0 && (
              <button
                type="button"
                onClick={() => { void segnaTutte(); }}
                className="font-maven text-[11.5px] font-semibold text-kidville-green hover:underline"
              >
                {t('segnaTutteLette')}
              </button>
            )}
          </div>

          {!ready ? (
            <div className="px-3 py-4 font-maven text-[12.5px] text-kidville-muted">{t('caricamentoPuntini')}</div>
          ) : items.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-4 font-maven text-[12.5px] text-kidville-muted">
              <BellOff size={15} /> {t('nessunaNotifica')}
            </div>
          ) : (
            <div className="max-h-[380px] overflow-y-auto">
              {items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => { void apri(n); }}
                  className={`flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2.5 text-left ${n.letta_il ? 'hover:bg-kidville-cream' : 'bg-kidville-green-soft/60 hover:bg-kidville-green-soft'}`}
                >
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-pill ${n.letta_il ? 'bg-kidville-line' : 'bg-kidville-yellow ring-2 ring-kidville-green'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-maven text-[13px] font-semibold text-kidville-ink">
                      {n.titolo || t('notificaFallback')}
                    </span>
                    {n.corpo && (
                      <span className="block truncate font-maven text-[11.5px] text-kidville-muted">{n.corpo}</span>
                    )}
                    <span className="block font-maven text-[10.5px] text-kidville-muted">{quando(n.creato_il, locale)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-kidville-line/70 px-2.5 py-2">
            <Link
              href={withUser(`${root}/avvisi`)}
              onClick={() => setOpen(false)}
              className="font-maven text-[12px] font-semibold text-kidville-green hover:underline"
            >
              {t('tuttiGliAvvisi')} →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
