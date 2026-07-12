'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut } from 'lucide-react';
import { doLogout } from '@/lib/auth/logout';
import { ContrastMenuButton } from '@/components/ui/ContrastMenuButton';

// Menu utente della TopBar cockpit (Direzione/Segreteria): rende cliccabile il
// blocco avatar+ruolo e apre un piccolo dropdown con "Esci". Prima non esisteva
// alcun logout in tutta l'app. A11y: button con aria-haspopup/expanded, role
// menu/menuitem, chiusura su Escape e click-fuori.

export function UserMenu({ ruoloLabel }: { ruoloLabel: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onLogout = async () => {
    setBusy(true);
    await doLogout();
  };

  return (
    <div ref={ref} className="relative pl-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu account"
        className="flex items-center gap-2.5 rounded-full p-0.5 pr-1.5 transition-colors hover:bg-kidville-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-kidville-yellow"
      >
        <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-kidville-yellow font-barlow text-[15px] font-extrabold uppercase text-kidville-green">
          {ruoloLabel[0] ?? 'S'}
        </span>
        <span className="leading-[1.15] text-left">
          <span className="block font-barlow text-sm font-extrabold uppercase text-kidville-white">{ruoloLabel}</span>
          <span className="block font-maven text-[11px] text-kidville-yellow">Kidville</span>
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2.4}
          className={`text-kidville-white/70 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-52 overflow-hidden rounded-2xl border border-kidville-line bg-kidville-white py-1 shadow-2xl"
        >
          <ContrastMenuButton
            iconSize={17}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 font-maven text-sm font-semibold text-kidville-ink transition-colors hover:bg-kidville-green-soft"
          />
          <button
            type="button"
            role="menuitem"
            onClick={onLogout}
            disabled={busy}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 font-maven text-sm font-semibold text-kidville-error transition-colors hover:bg-kidville-error-soft disabled:opacity-60"
          >
            <LogOut size={17} strokeWidth={2.2} />
            {busy ? 'Uscita…' : 'Esci'}
          </button>
        </div>
      )}
    </div>
  );
}
