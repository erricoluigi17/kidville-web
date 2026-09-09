'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Btn } from '@/components/ui/Btn';
import { logClient } from '@/lib/logging/client';

/**
 * SBLOCCO DI UN'ORA FUORI TERMINE — il comando che finora non esisteva.
 *
 * ─── LA SCENA ────────────────────────────────────────────────────────────────
 * `admin_settings.timelock_giorni_classe_orale` vale 2 su tutte e quattro le
 * sedi: firmare giovedì la lezione di lunedì è già fuori termine, e
 * `POST /api/primaria/registro` risponde **423** con «Richiedi lo sblocco al
 * dirigente». Ma `POST /api/primaria/sblocca` non aveva nessun chiamante in tutto
 * il repo, e la pagina admin del registro è un re-export di quella docente:
 * quel messaggio arrivava al dirigente indirizzato a sé stesso, senza un comando
 * per dargli seguito.
 *
 * ─── PERCHÉ CHIEDE IL MOTIVO, INVECE DI SBLOCCARE E BASTA ────────────────────
 * `sblocchi_audit.motivazione` è `NOT NULL` perché quella riga è la sola traccia
 * di un'autorizzazione a scrivere in ritardo su un registro di minori. Un motivo
 * precompilato dal client («sblocco dal registro») riempirebbe la colonna e
 * svuoterebbe l'audit: sarebbe una firma che non dice niente, scritta al posto di
 * chi doveva firmarla.
 *
 * ─── IL RUOLO QUI NON È UN PRESIDIO ──────────────────────────────────────────
 * Il gate vero è sul server (`requireStaff(request, ['admin','coordinator'])`) e
 * resta l'unico che conta: qualunque cosa mostri questo componente, la route
 * risponde 403 a chi non è dirigenza. Nascondere il comando serve a NON offrire a
 * una maestra un pulsante che le risponderebbe di no — non a proteggere niente.
 * Perciò il ruolo arriva come prop, dalla pagina che l'ha già risolto: un secondo
 * `fetch('/api/me')` per ognuna delle otto ore della giornata sarebbe otto
 * chiamate per un'informazione che il chiamante ha già in mano.
 *
 * ─── ⚠️ IL CERCHIO SI CHIUDE SOLO CON IL LETTORE PER SLOT ────────────────────
 * Il paragrafo qui sopra dice che questo bottone dà finalmente seguito al
 * messaggio «Richiedi lo sblocco al dirigente». È vero a una condizione, e va
 * detta qui perché è invisibile da questo file: `POST /api/primaria/sblocca`
 * scrive l'autorizzazione in `sblocchi_audit`, e a leggerla è soltanto
 * `POST /api/primaria/registro`. Finché quel lettore la cerca solo per
 * `entita_id`, un'ora MAI firmata resta bloccata anche dopo lo sblocco: questo
 * pannello si chiude senza errori, la griglia si ricarica, e la maestra prende
 * di nuovo 423. Il contratto è collaudato in
 * `__tests__/api/primaria-sblocco-slot-contratto-registro.test.ts`, che finché
 * il lettore per slot manca resta ROSSO apposta. **Non si monta questo bottone
 * in produzione con quel test rosso.**
 */

/** I ruoli che il gate della route accetta. Una regola sola, due strade. */
const RUOLI_DIRIGENZA = new Set(['admin', 'coordinator']);

/**
 * Vero se questo ruolo può autorizzare una scrittura fuori termine.
 *
 * Esportata perché la pagina che monta il bottone deve poter decidere lo stesso —
 * per esempio per scrivere «Richiedi lo sblocco al dirigente» a chi il comando non
 * ce l'ha, e non a chi ce l'ha. Due copie della stessa condizione divergono al
 * primo ritocco: qui ce n'è una.
 */
export function puoSbloccare(ruolo: string | null | undefined): boolean {
  return !!ruolo && RUOLI_DIRIGENZA.has(ruolo);
}

export interface SbloccaOraButtonProps {
  /** La classe della lezione da sbloccare. */
  sectionId: string;
  /** Il giorno della lezione, `YYYY-MM-DD`. */
  data: string;
  /** L'ordine della campanella (1..8), lo stesso numero che il registro firma. */
  oraLezione: number;
  /** Identità applicativa di chi autorizza (query `?userId=` + header `x-user-id`). */
  userId: string;
  /** Il ruolo REALE di chi sta guardando. Senza, il comando non si mostra. */
  ruolo: string | null | undefined;
  /** Chiamata dopo uno sblocco andato a buon fine: la pagina ricarica la griglia. */
  onSbloccato: () => void;
}

export function SbloccaOraButton({
  sectionId,
  data,
  oraLezione,
  userId,
  ruolo,
  onSbloccato,
}: SbloccaOraButtonProps) {
  const [aperto, setAperto] = useState(false);
  const [motivazione, setMotivazione] = useState('');
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);

  // Fail-closed: un ruolo che non conosciamo non è la dirigenza.
  if (!puoSbloccare(ruolo)) return null;

  const campoId = `sblocca-motivo-${sectionId}-${data}-${oraLezione}`;

  const autorizza = async () => {
    // `aria-disabled` invece di `disabled` (vedi la nota in `Btn`): la guardia
    // sta qui, così il fuoco non torna a `<body>` mentre la richiesta è in volo.
    if (inVolo) return;
    const motivo = motivazione.trim();
    if (!motivo) {
      setErrore('Scrivi il motivo dello sblocco: resta agli atti come autorizzazione.');
      return;
    }
    setInVolo(true);
    setErrore('');
    try {
      // Si mandano le COORDINATE DELLO SLOT, non un `entitaId`: un'ora mai
      // firmata non ha una riga di registro, ed è esattamente il caso per cui
      // questo comando esiste.
      const res = await fetch(`/api/primaria/sblocca?userId=${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({
          entitaTipo: 'registro',
          sectionId,
          data,
          oraLezione,
          motivazione: motivo,
        }),
      });
      const corpo = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        // Il MOTIVO non entra nel log: è testo libero scritto su una classe di
        // minori, e `app_log` si interroga in SQL per trenta giorni.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: 'sblocco-ora-non-registrato',
          route: '/teacher/primaria/registro',
          stato: res.status,
        });
        setErrore(corpo.error || 'Sblocco non riuscito. Riprova.');
        return;
      }
      setMotivazione('');
      setAperto(false);
      onSbloccato();
    } catch (err) {
      // Un `catch` che non logga è un bug (AGENTS, regola 6): qui ci cade la rete
      // che manca, cioè proprio il caso in cui nessuno saprebbe mai che il
      // dirigente ha provato a sbloccare e non ci è riuscito.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `sblocco-ora-non-inviato: ${err instanceof Error ? err.name : 'errore'}`,
        route: '/teacher/primaria/registro',
      });
      setErrore('Sblocco non inviato: controlla la connessione e riprova.');
    } finally {
      setInVolo(false);
    }
  };

  if (!aperto) {
    return (
      <Btn
        variant="secondary"
        size="sm"
        onClick={() => {
          setErrore('');
          setAperto(true);
        }}
      >
        <KeyRound size={15} aria-hidden="true" />
        Sblocca l&apos;ora
      </Btn>
    );
  }

  return (
    <div className="rounded-card border border-kidville-line bg-kidville-cream p-3">
      <p className="font-maven text-xs text-kidville-sub">
        Autorizza la firma di quest&apos;ora oltre il termine. Il motivo resta agli atti col tuo nome.
      </p>

      {errore && (
        <p
          role="alert"
          className="mt-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong"
        >
          {errore}
        </p>
      )}

      <label htmlFor={campoId} className="mt-2 block font-maven text-xs text-kidville-sub">
        Motivo dello sblocco
      </label>
      <textarea
        id={campoId}
        value={motivazione}
        onChange={(e) => setMotivazione(e.target.value)}
        rows={2}
        className="font-maven mt-1 w-full rounded-card border border-kidville-line bg-kidville-white px-3 py-2 text-sm text-kidville-ink"
      />

      <div className="mt-2 flex gap-2">
        <Btn variant="primary" size="sm" aria-disabled={inVolo} onClick={autorizza}>
          {inVolo ? 'Autorizzo…' : 'Autorizza'}
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => {
            setAperto(false);
            setErrore('');
          }}
        >
          Annulla
        </Btn>
      </div>
    </div>
  );
}
