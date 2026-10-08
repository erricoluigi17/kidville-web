import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { anonimizzaAlunno, bonificaAuditScritture, bonificaTracceTestualiAlunno } from '@/lib/gdpr/esegui'
import { eNonPiuIscritto } from '@/lib/alunni/stato'
import { RUOLI_ELIMINA_DEFINITIVO } from '@/lib/alunni/archiviazione'
import { contaPerEliminazione, rimuoviFileAlunno, scelteDisponibili } from '@/lib/alunni/elimina-definitivo'
import { leggiRegistroPrimaria } from '@/lib/alunni/registro-primaria'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// ELIMINAZIONE DEFINITIVA — dall'elenco dei «non iscritti» (2026-10-08).
//
// Decisione del titolare: segreteria e Direzione eliminano DAVVERO una scheda
// ritirata o senza sezione — un doppione, un adulto inserito come bambino.
// Con pagamenti la segreteria sceglie: cancellarli (solo se non sono
// contabilità emessa) oppure anonimizzare. Il registro della primaria non si
// tocca mai.
//
// ─── L'ORDINE È LA DIFESA ───────────────────────────────────────────────────
//  1. gate di ruolo e di sede, poi la scheda letta con la sede accanto;
//  2. la MISURA (sole SELECT): da lì le scelte disponibili;
//  3. le TRACCE DI TESTO SENZA FK (`bonificaTracceTestualiAlunno`, la stessa
//     funzione dell'oblio): notifiche che nominano il bambino, testo delle
//     segnalazioni su sue voci di diario, suoi media e suoi thread, sospensioni,
//     audit del diario senza id. Vengono PRIMA dei file perché le segnalazioni
//     sui media si ritrovano solo dall'id del media, e `obliaFotoAlunno` (dentro
//     `rimuoviFileAlunno`) quei media li cancella. Se la pulizia non è completa
//     ci si ferma qui: dopo la cancellazione della scheda nessuno potrebbe più
//     ricondurre quel testo a un bambino, cioè nessuno lo toglierebbe più;
//  4. i FILE, con le funzioni dell'oblio: se uno solo non esce ci si ferma, e
//     il database non è stato toccato;
//  5. il DATABASE, in UNA transazione (`elimina_alunno_definitivo`), che
//     ricontrolla tutto da sé;
//  6. SOLO DOPO un `ok: true`, la bonifica delle vecchie copie nel registro
//     delle scritture e la traccia nuova — uuid e numeri, mai la riga.
// Il 2026-08-12 una cancellazione era stata tolta perché scriveva la traccia
// PRIMA di una DELETE che falliva (lock `registro-modifiche-senza-hard-delete`).
//
// «ANONIMIZZA» non passa dalla funzione SQL: chiama `anonimizzaAlunno`, la
// stessa dell'oblio (che le tracce di testo le tratta già da sé). Ma prima
// RILEGGE il registro della primaria: fra l'anteprima e il clic può essere
// arrivato un voto, e qui non c'è una transazione che lo ricontrolli.
// =============================================================================

const postBodySchema = z.object({
  alunno_id: z.string().uuid(),
  mode: z.enum(['dryrun', 'execute']),
  scelta: z.enum(['elimina', 'elimina_con_pagamenti', 'anonimizza']).optional(),
})

const OP = 'admin/students/elimina:POST'

/**
 * Il rifiuto della funzione SQL → la risposta. Uno `switch` con i corpi
 * LETTERALI, e non una mappa `codice → { status, codice }`: il lock
 * `errori-con-codice` legge il `codice` dentro `NextResponse.json({ … })`, e
 * `codice: rifiuto.codice` sarebbe un valore che non sa leggere — cioè un codice
 * che nessuno controlla.
 */
function rispostaAlRifiutoDelDb(code: string | undefined): NextResponse {
  switch (code) {
    case 'non_trovato':
      return NextResponse.json(
        { error: 'Alunno non trovato', codice: 'ALUNNO_ELIMINAZIONE_NON_TROVATO' },
        { status: 404 },
      )
    case 'frequentante':
    case 'gia_anonimizzato':
      return NextResponse.json(
        { error: 'Si elimina solo un bambino ritirato o senza sezione', codice: 'ALUNNO_ELIMINAZIONE_FREQUENTANTE' },
        { status: 409 },
      )
    case 'registro_primaria':
      return NextResponse.json(
        { error: 'Il registro della primaria va conservato', codice: 'REGISTRO_PRIMARIA_DA_CONSERVARE' },
        { status: 409 },
      )
    case 'ha_pagamenti':
      return NextResponse.json(
        { error: 'Ci sono pagamenti', codice: 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI' },
        { status: 409 },
      )
    case 'pagamenti_non_cancellabili':
      return NextResponse.json(
        { error: 'Pagamenti non cancellabili', codice: 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI' },
        { status: 409 },
      )
    default:
      return NextResponse.json(
        { error: 'Errore interno', codice: 'ALUNNO_ELIMINAZIONE_NON_RIUSCITA' },
        { status: 500 },
      )
  }
}

export const POST = withRoute('admin/students/elimina:POST', async (request: Request) => {
  const auth = await requireStaff(request, [...RUOLI_ELIMINA_DEFINITIVO])
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { alunno_id, mode, scelta } = b.data

  if (mode === 'execute' && !scelta) {
    return NextResponse.json(
      { error: 'Scegli che cosa fare', codice: 'ALUNNO_ELIMINAZIONE_SCELTA_MANCANTE' },
      { status: 400 },
    )
  }

  try {
    const supabase = await createAdminClient()

    const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunno_id)
    if (fuoriScope) return fuoriScope

    // La sede ACCANTO al gate: due reti, non una — a valle c'è una cancellazione
    // che non torna indietro.
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: alunno, error: alunnoErr } = await supabase
      .from('alunni')
      .select('id, stato, section_id, scuola_id, anonimizzato_il, documento_path, codice_fiscale, fiscal_code')
      .eq('id', alunno_id)
      .in('scuola_id', plessi)
      .maybeSingle()
    if (alunnoErr) {
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, alunnoErr)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'ALUNNO_ELIMINAZIONE_NON_RIUSCITA' },
        { status: 500 },
      )
    }
    if (!alunno) {
      logEvento('multi_sede', 'warn', {
        operazione: OP,
        esito: 'alunno-non-piu-in-scope',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
      })
      return NextResponse.json(
        { error: 'Alunno non trovato', codice: 'ALUNNO_ELIMINAZIONE_NON_TROVATO' },
        { status: 404 },
      )
    }

    // Solo dai «non iscritti»: ritirato (elenco chiuso) oppure senza sezione.
    const nonIscritto = eNonPiuIscritto(alunno.stato as string | null) || alunno.section_id == null
    if (alunno.anonimizzato_il != null || !nonIscritto) {
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'eliminazione-rifiutata-frequentante',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        tipo: (alunno.stato as string | null) ?? 'assente',
      })
      return NextResponse.json(
        { error: 'Si elimina solo un bambino ritirato o senza sezione', codice: 'ALUNNO_ELIMINAZIONE_FREQUENTANTE' },
        { status: 409 },
      )
    }

    const misura = await contaPerEliminazione(supabase, alunno_id, OP)
    if (!misura.ok) {
      return NextResponse.json(
        { error: 'Misura non riuscita', codice: 'ALUNNO_ELIMINAZIONE_NON_MISURATA' },
        { status: 500 },
      )
    }
    const { scelte, motivo } = scelteDisponibili(misura.conteggi)

    if (mode === 'dryrun') {
      return NextResponse.json({ dryrun: true, conteggi: misura.conteggi, scelte, motivo })
    }

    const sceltaFatta = scelta!
    if (!scelte[sceltaFatta]) {
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'eliminazione-scelta-non-disponibile',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        tipo: motivo ?? sceltaFatta,
      })
      if (motivo === 'REGISTRO_PRIMARIA_DA_CONSERVARE') {
        return NextResponse.json(
          { error: 'Il registro della primaria va conservato', codice: 'REGISTRO_PRIMARIA_DA_CONSERVARE' },
          { status: 409 },
        )
      }
      return NextResponse.json(
        { error: 'Scelta non disponibile', codice: 'ALUNNO_ELIMINAZIONE_SCELTA_NON_DISPONIBILE' },
        { status: 409 },
      )
    }

    // ─── ANONIMIZZA: la stessa funzione dell'oblio, sul solo bambino ───────
    if (sceltaFatta === 'anonimizza') {
      // Il registro si RILEGGE qui, direttamente, subito prima del gesto: la
      // misura è di un istante fa, e `anonimizzaAlunno` non ha una transazione
      // che lo ricontrolli come fa la funzione SQL. «Non l'ho potuto leggere»
      // ferma quanto «c'è»: l'anonimizzazione non torna indietro.
      const registro = await leggiRegistroPrimaria(supabase, alunno_id)
      if (!registro.ok) {
        logErrore({ operazione: OP, stato: 500, evento: 'elimina_registro_primaria' }, registro.errore)
        return NextResponse.json(
          { error: 'Misura non riuscita', codice: 'ALUNNO_ELIMINAZIONE_NON_MISURATA' },
          { status: 500 },
        )
      }
      if (registro.presente) {
        logEvento('gdpr', 'warn', {
          operazione: OP,
          esito: 'anonimizzazione-rifiutata-registro-primaria',
          entita_tipo: 'alunni',
          entita_id: alunno_id,
        })
        return NextResponse.json(
          { error: 'Il registro della primaria va conservato', codice: 'REGISTRO_PRIMARIA_DA_CONSERVARE' },
          { status: 409 },
        )
      }

      const esito = await anonimizzaAlunno(
        supabase,
        {
          id: alunno_id,
          documento_path: (alunno.documento_path as string | null) ?? null,
          codice_fiscale: (alunno.codice_fiscale as string | null) ?? null,
          fiscal_code: (alunno.fiscal_code as string | null) ?? null,
        },
        new Date().toISOString(),
        OP,
      )
      await logScrittura(supabase, {
        attore: auth.user,
        entitaTipo: 'alunno_anonimizzato',
        entitaId: alunno_id,
        azione: 'update',
        scuolaId: (alunno.scuola_id as string | null) ?? null,
        valoreDopo: { alunno_id, scelta: sceltaFatta, pagamenti: misura.conteggi.pagamenti },
      })
      logEvento('gdpr', 'info', {
        operazione: OP,
        esito: 'alunno-anonimizzato',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
      })
      return NextResponse.json({ ok: true, scelta: sceltaFatta, esito })
    }

    // ─── ELIMINA: prima le tracce di testo, poi i file, poi il database ────
    const tracce = await bonificaTracceTestualiAlunno(supabase, alunno_id, OP)
    if (!tracce.completo) {
      // Ogni ramo che non è riuscito ha già il suo `logErrore` dentro la
      // funzione; questa riga dice CHE COSA ne è seguito: niente file tolti,
      // niente database toccato, la scheda resta e un secondo tentativo riparte.
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'eliminazione-ferma-tracce-incomplete',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        n_notifiche: tracce.notificheRimosse,
        n_segnalazioni: tracce.segnalazioniBonificate,
        n_sospensioni: tracce.sospensioniBonificate,
      })
      return NextResponse.json(
        { error: 'Errore interno', codice: 'ALUNNO_ELIMINAZIONE_NON_RIUSCITA' },
        { status: 500 },
      )
    }

    const file = await rimuoviFileAlunno(
      supabase,
      { id: alunno_id, documento_path: (alunno.documento_path as string | null) ?? null },
      OP,
    )
    if (!file.ok) {
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'eliminazione-ferma-file-restanti',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        n_file: file.numeri.restanti,
      })
      return NextResponse.json(
        { error: 'File restanti', codice: 'ALUNNO_ELIMINAZIONE_FILE_RESTANTI', file: file.numeri },
        { status: 502 },
      )
    }

    const { data: rpc, error: rpcErr } = await supabase.rpc('elimina_alunno_definitivo', {
      p_alunno: alunno_id,
      p_con_pagamenti: sceltaFatta === 'elimina_con_pagamenti',
    })
    if (rpcErr) {
      if ((rpcErr as { code?: string }).code === 'PGRST202') {
        logEvento('gdpr', 'error', {
          operazione: OP,
          esito: 'funzione-eliminazione-assente',
          entita_tipo: 'alunni',
          entita_id: alunno_id,
        })
        return NextResponse.json(
          { error: 'Non disponibile', codice: 'ALUNNO_ELIMINAZIONE_NON_DISPONIBILE' },
          { status: 503 },
        )
      }
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, rpcErr)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'ALUNNO_ELIMINAZIONE_NON_RIUSCITA' },
        { status: 500 },
      )
    }
    const risposta = rpc as { ok?: boolean; code?: string; righe?: Record<string, number> } | null
    if (!risposta?.ok) {
      // Tracce e file sono già usciti, la scheda è intatta: un esito onesto, che
      // va registrato perché un secondo tentativo lo completerà.
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'eliminazione-rifiutata-dal-db',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        tipo: risposta?.code ?? 'risposta-illeggibile',
      })
      return rispostaAlRifiutoDelDb(risposta?.code)
    }

    // ─── SOLO ORA la traccia ────────────────────────────────────────────────
    const numeriTracce = {
      notifiche: tracce.notificheRimosse,
      segnalazioni: tracce.segnalazioniBonificate,
      sospensioni: tracce.sospensioniBonificate,
    }
    await bonificaAuditScritture(supabase, [alunno_id], OP)
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'alunno_eliminato',
      entitaId: alunno_id,
      azione: 'delete',
      scuolaId: (alunno.scuola_id as string | null) ?? null,
      valoreDopo: {
        alunno_id,
        scelta: sceltaFatta,
        righe: risposta.righe ?? {},
        file: file.numeri,
        tracce: numeriTracce,
      },
    })
    // Evento critico → si logga anche il SUCCESSO, con i numeri delle tracce:
    // `gdpr` è persistito, e senza questi conteggi la domanda «le notifiche col
    // suo nome sono state tolte?» non avrebbe una query.
    logEvento('gdpr', 'info', {
      operazione: OP,
      esito: 'alunno-eliminato',
      entita_tipo: 'alunni',
      entita_id: alunno_id,
      n_notifiche: tracce.notificheRimosse,
      n_segnalazioni: tracce.segnalazioniBonificate,
      n_sospensioni: tracce.sospensioniBonificate,
    })
    return NextResponse.json({
      ok: true,
      scelta: sceltaFatta,
      righe: risposta.righe ?? {},
      file: file.numeri,
      tracce: numeriTracce,
    })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Errore interno', codice: 'ALUNNO_ELIMINAZIONE_NON_RIUSCITA' },
      { status: 500 },
    )
  }
})
