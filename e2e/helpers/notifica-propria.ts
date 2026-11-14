import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clienteDatabaseCi } from './database-ci';

/**
 * UNA NOTIFICA PROPRIA PER OGNI TENTATIVO — perché il test non usa quella del seme.
 *
 * Il 2026-11-13 il test «segna tutte lette» è caduto 3 volte su 3 sulla CI di `main`, con codice
 * identico a quello verde sulla PR, per due motivi che il seme non può evitare:
 *  1. NON È INDIPENDENTE DAGLI ALTRI TEST. Mentre girava, altri spec in parallelo creavano
 *     notifiche per lo stesso genitore (un avviso della sede, tre «nuovi contenuti in galleria»).
 *     «Segna tutte lette» le segnava, ma il poll da 60 s o il `load()` successivo ne riportava di
 *     nuove, e l'attesa «la campanella non ha più il conteggio» (zero non lette nel pannello) non
 *     arrivava entro 5 s: è un'asserzione su ciò che fanno gli ALTRI.
 *  2. NON È RIPETIBILE. Il seme crea UNA notifica non letta: il primo tentativo la segna letta, e i
 *     due retry non trovavano più «Notifiche (N non lette)».
 *
 * Qui ogni tentativo inserisce la SUA notifica non letta, con un titolo unico, e la rimuove alla
 * fine. Si asserisce soltanto su quella: sparisce dal conto di chi è non letto (letta_il valorizzato
 * sul database), senza pretendere zero non lette nel pannello. Le notifiche degli altri test possono
 * esserci, arrivare o essere segnate: non cambiano l'esito. La lettura passa dal database con la
 * chiave di servizio (`clienteDatabaseCi`, solo CI e solo progetto E2E) perché è l'unica verità che
 * non dipende da quanto il poll del pannello sia in ritardo.
 */
export async function conNotificaPropria(
  utenteId: string,
  prova: (db: SupabaseClient, id: string, titolo: string) => Promise<void>,
) {
  const db = clienteDatabaseCi();
  const id = randomUUID();
  const titolo = `Notifica ripetibile ${id.slice(0, 8)}`;
  const { error } = await db.from('notifiche').insert({
    id, utente_id: utenteId, tipo: 'sistema', titolo,
    corpo: 'Notifica creata dal test e rimossa a fine prova.', letta_il: null,
  });
  if (error) throw new Error(`seme della notifica propria: ${error.code ?? ''} ${error.message}`);
  try {
    await prova(db, id, titolo);
  } finally {
    // La pulizia non deve far fallire il test: se non riesce, si dice perché (solo il codice).
    const { error: errorePulizia } = await db.from('notifiche').delete().eq('id', id);
    // Fuori da src/ il logger dell'app non c'è: `console.warn`, col solo codice.
    if (errorePulizia) console.warn(`notifica propria non rimossa: ${errorePulizia.code ?? 'senza codice'}`);
  }
}

export async function segnaTutteLette(page: Page, db: SupabaseClient, id: string, titolo: string) {
  const campanella = page.getByRole('button', { name: /Notifiche \(\d+ non lett/ });
  await expect(campanella).toBeVisible({ timeout: 15_000 });

  await campanella.click();
  await expect(page.getByText(titolo)).toBeVisible();

  // Si aspetta la risposta del PATCH, non una conseguenza visiva: il conteggio nel pannello
  // dipende anche dalle notifiche degli altri test.
  const patch = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes('/api/notifiche'),
  );
  await page.getByRole('button', { name: 'Segna tutte lette' }).click();
  expect((await patch).ok()).toBe(true);

  // La NOSTRA notifica risulta letta sul database.
  await expect
    .poll(
      async () => {
        // Una lettura fallita deve far cadere il test col suo motivo, non farlo attendere 15 s un `null`.
        const { data, error } = await db.from('notifiche').select('letta_il').eq('id', id).single();
        if (error) throw new Error(`lettura della notifica propria: ${error.code ?? 'senza codice'}`);
        return data?.letta_il ?? null;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
}
