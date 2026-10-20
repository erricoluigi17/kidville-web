import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logEvento } from '@/lib/logging/logger';
import { guastoLetturaAccessoria } from '@/lib/db/guasto';
import { rateLimit, clientIp } from '@/lib/security/rate-limit';
import { intestazioniCachePubblica } from '@/lib/security/cache-pubblica';
import {
  ENROLLMENT_DEFAULT_SCHEMA,
  STANDARD_ENROLLMENT_MODEL_ID,
} from '@/lib/forms/enrollment-default-schema';

// =============================================================================
// GET pubblico: lo schema del «Modulo d'iscrizione standard», così il wizard
// `/iscrizione` riflette le modifiche fatte dalla segreteria nel builder.
// Restituisce SOLO lo schema (nessun dato personale).
//
// ─── V5 · QUESTA PORTA LEGGE E BASTA (2026-08-03) ───────────────────────────
//
// Fino a oggi chiamava `ensureStandardEnrollmentModel(supabase)` con un client
// **service-role**: `SELECT` e, se il modello non c'era, `INSERT`. Cioè una
// richiesta anonima e senza credenziali innescava una scrittura. E non aveva
// nessun tetto per IP, mentre le altre porte pubbliche di questo repo ce l'hanno
// (`public/cancellazione-account`, `forms/send-otp`).
//
// «Idempotente» non vuol dire «innocua», ed è la confusione da cui nasce il
// difetto: il danno non è la riga scritta due volte, è il PERIMETRO. Una rotta
// senza autenticazione che può inserire righe è una superficie diversa da una che
// può solo leggere, e va valutata come tale.
//
// Chi crea il modello quando serve davvero: `POST /api/admin/form-models/reset`,
// dietro il gate dello staff. Qui, se il modello non c'è, si risponde con lo
// schema di default — che era già il comportamento del ramo di ripiego, quindi il
// wizard non cambia comportamento in nessun caso.
//
// MISURA che rende la rimozione sicura: in produzione, il 2026-08-03, il modello
// standard ESISTE (`f0000000-…-0001`, attivo, con schema). Quel ramo di creazione
// non è mai servito in produzione: restava solo come superficie di scrittura
// raggiungibile da chiunque.
// =============================================================================

const getQuerySchema = z.object({}); // nessun parametro in ingresso

/**
 * Il tetto: più largo di quello della cancellazione account (5 in 10 minuti),
 * perché questa rotta la chiama il wizard a ogni apertura ed è una LETTURA — ma
 * un tetto c'è, perché apre comunque un client service-role.
 */
const RL_LIMITE = 60;
const RL_FINESTRA_MS = 10 * 60 * 1000;

/**
 * Cinque minuti in CDN (fase 12): una modifica della segreteria nel builder arriva alle famiglie
 * entro pochi minuti. SOLO sullo schema letto davvero: il ripiego sullo schema di default dopo un
 * guasto non si conserva, o resterebbe in cache anche a guasto finito.
 */
const CACHE_SECONDI = 300;
const CACHE_STANTIO = 600;

export const GET = withRoute('iscrizione/model:GET', async (request: Request) => {
  // Prima di tutto il resto: nessun client aperto, nessuna query. Il rifiuto non
  // va loggato a mano — `withRoute` persiste già ogni 429 a livello `warn`.
  const rl = await rateLimit(`iscrizione-model:${clientIp(request)}`, {
    limit: RL_LIMITE,
    windowMs: RL_FINESTRA_MS,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste. Riprova tra qualche minuto.', codice: 'TROPPE_RICHIESTE' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;
  try {
    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .from('form_models')
      .select('schema')
      .eq('id', STANDARD_ENROLLMENT_MODEL_ID)
      .maybeSingle();
    // Stesso ripiego del `catch` qui sotto — il wizard pubblico non si rompe — ma un guasto
    // del database NON è il caso atteso: la famiglia compila lo schema di default invece di
    // quello che la segreteria ha modificato, e in produzione va visto (`error`).
    if (error) {
      guastoLetturaAccessoria('modulistica', 'iscrizione/model:GET', 'fallback-schema-default-guasto-db', error);
    }
    if (error || !data?.schema) {
      return NextResponse.json({ schema: data?.schema ?? ENROLLMENT_DEFAULT_SCHEMA });
    }
    return NextResponse.json(
      { schema: data.schema },
      { headers: intestazioniCachePubblica(request, CACHE_SECONDI, CACHE_STANTIO) },
    );
  } catch (err) {
    // Errore DAVVERO ignorabile (AGENTS regola 6): il wizard riceve comunque uno
    // schema valido — quello di default — e la risposta resta 200. Non è un guasto,
    // ma nemmeno silenzio: `info` perché il degrado va visto, non subìto.
    logEvento('modulistica', 'info', { operazione: 'iscrizione/model:GET', esito: 'fallback_schema_default' }, err);
    return NextResponse.json({ schema: ENROLLMENT_DEFAULT_SCHEMA });
  }
});
