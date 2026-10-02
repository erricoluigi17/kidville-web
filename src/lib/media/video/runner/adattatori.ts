import { Sandbox } from '@vercel/sandbox'
import type { SupabaseClient } from '@supabase/supabase-js'

import { logEvento } from '@/lib/logging/logger'

import {
  ENV_SNAPSHOT_SANDBOX,
  apriLaMicroVm,
  leggiSnapshotConfigurato,
  type OrigineMicroVm,
} from './ambiente'
import type {
  ArchivioVideo,
  CodaVideo,
  ComandoSandbox,
  EsitoBattito,
  EsitoComando,
  EsitoConteggi,
  EsitoRpcVideo,
  JobVideo,
  MacchinaSandbox,
  SessioneSandbox,
} from './porte'

/**
 * GLI ADATTATORI — l'unico posto del runner che tocca qualcosa di vero.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠️ QUESTO FILE NON È COLLAUDATO, E VA DETTO QUI INVECE CHE SCOPERTO POI.
 *
 * Non esiste un Vercel Sandbox in locale, non esiste uno Storage di collaudo, e
 * l'E2E in questo repository è vietato in locale perché `.env.local` punta al
 * database di PRODUZIONE. Tutto ciò che sta sotto — le firme dell'SDK, la forma
 * delle risposte delle RPC, il verbo HTTP dell'upload firmato — è **letto dalla
 * documentazione e dai tipi, non misurato**.
 *
 * Perciò questo file contiene il meno possibile: nessuna decisione, nessun ramo che
 * scelga, nessun calcolo. Traduce e basta. Tutto ciò che decide sta in `esegui.ts`,
 * `battito.ts`, `preparazione.ts` e `script.ts`, che girano senza rete e hanno i
 * loro collaudi. Quando M12 aprirà un Sandbox vero, ciò che può essere sbagliato è
 * qui dentro, e si vede in un colpo d'occhio.
 *
 * Dalla PR 2 anche la scelta di COME aprire la MicroVM (riaggancio, snapshot, ripiego sul
 * runtime della PR 1) è fuori da qui: sta in `apriLaMicroVm` (`./ambiente.ts`), che non
 * importa l'SDK e si prova con uno finto che lancia dove si vuole. A `macchinaVercel` restano
 * due righe di cablaggio, che `video-runner-ambiente.test.ts` prova con l'SDK sostituito da
 * un doppio; le FIRME dell'SDK vero le controlla `tsc`, che compila questo file contro i suoi tipi.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/* ────────────────────────────────────────────────────────────────────────────
 * LA CODA — le RPC
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ POSTGREST NON LANCIA: RITORNA `{ error }` (AGENTS, regola 7). Un `try/catch`
 * attorno a una `rpc()` non scatta mai, e il valore di ritorno va guardato sempre —
 * è la ragione per cui ogni funzione qui sotto passa da `esitoRpc`, `esitoSemplice` o
 * `esitoConteggi`, che condividono questo pezzo.
 *
 * Restituisce il corpo della risposta se è un OGGETTO, o `null` — con la riga che lo dice — se la
 * chiamata non è riuscita (trasporto, funzione che non c'è) o la risposta non si legge.
 */
function corpoDellaRisposta(
  operazione: string,
  risposta: { data: unknown; error: unknown },
): Record<string, unknown> | null {
  if (risposta.error) {
    logEvento(
      'rpc',
      'error',
      { operazione: `video-runner:${operazione}`, esito: 'rpc-non-riuscita' },
      risposta.error,
    )
    return null
  }
  const corpo = risposta.data
  if (corpo === null || typeof corpo !== 'object') {
    logEvento('rpc', 'error', {
      operazione: `video-runner:${operazione}`,
      esito: 'rpc-risposta-illeggibile',
    })
    return null
  }
  return corpo as Record<string, unknown>
}

/** Le RPC che portano un JOB: `{"ok":true,"job":…}` o `{"ok":false,"code":…}`. */
function esitoRpc(operazione: string, risposta: { data: unknown; error: unknown }): EsitoRpcVideo {
  const letto = corpoDellaRisposta(operazione, risposta)
  if (letto === null) return { ok: false, code: 'RPC_ERROR' }
  if (letto.ok === true && letto.job !== null && typeof letto.job === 'object') {
    return { ok: true, job: letto.job as JobVideo }
  }
  return { ok: false, code: typeof letto.code === 'string' ? letto.code : 'RPC_ERROR' }
}

/**
 * Le RPC di coordinamento che NON portano un job: `{"ok":true,…}` o `{"ok":false,"code":…}`.
 *
 * ⚠️ NON si fanno passare da `esitoRpc`, ed è il motivo per cui questa funzione esiste: `esitoRpc` vuole
 * un `job` dentro il corpo, e senza lo legge come «RPC_ERROR» anche una risposta riuscita. Per la
 * sorveglianza sarebbe un disastro silenzioso — ogni invocazione crederebbe di non aver ottenuto la
 * sorveglianza che il database le ha appena dato.
 */
function esitoSemplice(
  operazione: string,
  risposta: { data: unknown; error: unknown },
): EsitoBattito {
  const corpo = corpoDellaRisposta(operazione, risposta)
  if (corpo === null) return { ok: false, code: 'RPC_ERROR' }
  if (corpo.ok === true) return { ok: true }
  return { ok: false, code: typeof corpo.code === 'string' ? corpo.code : 'RPC_ERROR' }
}

/**
 * Le RPC che rispondono con dei CONTEGGI (`candidati`, `calciati`, `arrivati`…): dalla risposta
 * passano SOLO i valori numerici. Il resto — una stringa `motivo`, una riga che un domani una RPC
 * decidesse di restituire — non entra nel runner, e quindi non può finire in un log o in un
 * messaggio (le righe di `video_jobs` e `video_intents` portano ormai `tag_alunni`, l'hash del
 * token di rinnovo e lo `sha256`: secondario #37).
 */
function esitoConteggi(
  operazione: string,
  risposta: { data: unknown; error: unknown },
): EsitoConteggi {
  const corpo = corpoDellaRisposta(operazione, risposta)
  if (corpo === null) return { ok: false, code: 'RPC_ERROR' }
  if (corpo.ok !== true) {
    return { ok: false, code: typeof corpo.code === 'string' ? corpo.code : 'RPC_ERROR' }
  }
  const conteggi: Record<string, number> = {}
  for (const [chiave, valore] of Object.entries(corpo)) {
    if (typeof valore === 'number' && Number.isFinite(valore)) conteggi[chiave] = valore
  }
  return { ok: true, conteggi }
}

export function codaSupabase(supabase: SupabaseClient): CodaVideo {
  return {
    async miei(leaseOwner) {
      const { data, error } = await supabase
        .from('video_jobs')
        .select(
          'id, owner_id, scuola_id, channel, intent_id, status, original_bucket, original_path, ' +
            'source_size, source_mime, attempt, fence_epoch',
        )
        .eq('status', 'processing')
        .eq('lease_owner', leaseOwner)
        .order('created_at', { ascending: true })
        .limit(5)
      if (error) return { ok: false, motivo: error.code ?? 'SELECT_ERROR' }
      return { ok: true, jobs: (data ?? []) as unknown as JobVideo[] }
    },

    async prossimo(leaseOwner, leaseSeconds, tetto) {
      return esitoRpc(
        'prossimo',
        await supabase.rpc('video_job_prossimo', {
          p_lease_owner: leaseOwner,
          p_lease_seconds: leaseSeconds,
          p_tetto: tetto,
        }),
      )
    },

    async prendi(jobId, leaseOwner, leaseSeconds, tetto) {
      return esitoRpc(
        'prendi',
        await supabase.rpc('video_job_prendi', {
          p_job_id: jobId,
          p_lease_owner: leaseOwner,
          p_lease_seconds: leaseSeconds,
          p_tetto: tetto,
        }),
      )
    },

    async sorveglianzaPrendi(jobId, invocazione, secondi) {
      return esitoSemplice(
        'sorveglianza-prendi',
        await supabase.rpc('video_job_sorveglianza_prendi', {
          p_job_id: jobId,
          p_invocazione: invocazione,
          p_secondi: secondi,
        }),
      )
    },

    async sorveglianzaRilascia(jobId, invocazione) {
      return esitoSemplice(
        'sorveglianza-rilascia',
        await supabase.rpc('video_job_sorveglianza_rilascia', {
          p_job_id: jobId,
          p_invocazione: invocazione,
        }),
      )
    },

    async arriviRecupera(limite) {
      return esitoConteggi(
        'arrivi-recupera',
        await supabase.rpc('video_arrivi_recupera', { p_limite: limite }),
      )
    },

    async ventaglio(tetto, escludi) {
      return esitoConteggi(
        'ventaglio',
        await supabase.rpc('video_runner_ventaglio', { p_tetto: tetto, p_escludi: escludi }),
      )
    },

    async battito(jobId, fenceEpoch, leaseOwner) {
      return esitoRpc(
        'heartbeat',
        await supabase.rpc('video_job_heartbeat', {
          p_job_id: jobId,
          p_fence_epoch: fenceEpoch,
          p_lease_owner: leaseOwner,
        }),
      )
    },

    async pronto(p) {
      return esitoRpc(
        'ready',
        await supabase.rpc('video_job_ready', {
          p_job_id: p.jobId,
          p_fence_epoch: p.fenceEpoch,
          p_lease_owner: p.leaseOwner,
          p_output_path: p.percorsoUscita,
          p_output_size: p.byteUscita,
          p_probe_json: p.probe,
        }),
      )
    },

    async fallito(p) {
      return esitoRpc(
        'fail',
        await supabase.rpc('video_job_fail', {
          p_job_id: p.jobId,
          p_fence_epoch: p.fenceEpoch,
          p_lease_owner: p.leaseOwner,
          p_error_code: p.codice,
          p_rejected: p.rifiutato,
        }),
      )
    },

    async diagnosi(p) {
      // Come la sorveglianza, la RPC risponde `{ok:true}` SENZA un job: passata da `esitoRpc` ogni
      // scrittura riuscita si leggerebbe «RPC_ERROR». `esitoSemplice` esiste per questo.
      return esitoSemplice(
        'diagnosi',
        await supabase.rpc('video_job_diagnosi', {
          p_job_id: p.jobId,
          p_fence_epoch: p.fenceEpoch,
          p_lease_owner: p.leaseOwner,
          p_diagnosi: p.diagnosi,
        }),
      )
    },

    async riprova(p) {
      // ⚠️ Se la migrazione `…_video_job_ritentativi.sql` non fosse applicata, PostgREST
      // risponde «funzione non trovata»: `esitoRpc` lo traduce in `RPC_ERROR`, che è
      // ESATTAMENTE il codice con cui il runner sa di dover ripiegare su `video_job_fail`
      // (vedi `riprova` in `esegui.ts`). Un verdetto del database ha invece un codice suo.
      return esitoRpc(
        'retry',
        await supabase.rpc('video_job_retry', {
          p_job_id: p.jobId,
          p_fence_epoch: p.fenceEpoch,
          p_lease_owner: p.leaseOwner,
          p_error_code: p.codice,
          p_tentativi_massimi: p.tentativiMassimi,
          p_attesa_secondi: p.attesaSecondi,
        }),
      )
    },
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'ARCHIVIO — lo Storage
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * I due fatti di un errore dello Storage da cui il runner decide se riprovare: lo stato HTTP
 * (`StorageApiError.status`) e il codice dello Storage (`StorageApiError.code`, es.
 * `NoSuchKey`). Si leggono col controllo del tipo e senza fidarsi della classe: un errore di
 * rete è uno `StorageUnknownError` che né l'uno né l'altro li ha, e allora restano assenti.
 * Nessuna decisione qui — chi sceglie la classe del guasto è `./ritentativi.ts`.
 */
function dettagliStorage(error: unknown): { stato?: number; codiceStorage?: string } {
  const letto = (error ?? {}) as { status?: unknown; code?: unknown }
  return {
    ...(typeof letto.status === 'number' && Number.isInteger(letto.status) ? { stato: letto.status } : {}),
    ...(typeof letto.code === 'string' && letto.code !== '' ? { codiceStorage: letto.code } : {}),
  }
}

export function archivioSupabase(supabase: SupabaseClient): ArchivioVideo {
  return {
    async urlLettura(bucket, percorso, secondi) {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(percorso, secondi)
      if (error || !data?.signedUrl) {
        logEvento(
          'storage',
          'error',
          { operazione: 'video-runner:firma-lettura', esito: 'firma-non-rilasciata', bucket },
          error,
        )
        return { ok: false, motivo: error?.message ?? 'firma-assente', ...dettagliStorage(error) }
      }
      return { ok: true, url: data.signedUrl }
    },

    async urlScrittura(bucket, percorso) {
      const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(percorso)
      if (error || !data?.signedUrl) {
        logEvento(
          'storage',
          'error',
          { operazione: 'video-runner:firma-scrittura', esito: 'firma-non-rilasciata', bucket },
          error,
        )
        return { ok: false, motivo: error?.message ?? 'firma-assente', ...dettagliStorage(error) }
      }
      // `signedUrl` porta già `?token=…`: dentro la MicroVM basta un `PUT` con `-T`.
      // Non si usa `uploadToSignedUrl` perché il file vive nella MicroVM, non qui —
      // farlo passare da questo processo vorrebbe dire due gigabyte in una lambda.
      return { ok: true, url: assoluto(supabase, data.signedUrl) }
    },
  }
}

/**
 * `createSignedUploadUrl` può restituire un percorso relativo alla base dello
 * Storage; `createSignedUrl` restituisce già l'assoluto. `curl` dentro la MicroVM
 * ha bisogno dell'assoluto in entrambi i casi.
 */
function assoluto(supabase: SupabaseClient, url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  const base = supabase.storage.from('').getPublicUrl('').data.publicUrl
  return new URL(url.replace(/^\/+/, ''), base).toString()
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA MICROVM
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * La MicroVM di Vercel. Qui si CABLANO due righe e basta: la scelta (riaggancio, snapshot, ripiego)
 * sta in `apriLaMicroVm` (`./ambiente.ts`), che non importa l'SDK e si prova con un SDK finto.
 *
 * ⚠️ La variabile `VIDEO_SANDBOX_SNAPSHOT_ID` si legge QUI e a ogni apertura, non una volta al caricamento
 * del modulo: lo snapshot si ricostruisce (scade, o si rifà con un FFmpeg nuovo) e il valore su Vercel
 * cambia senza che l'istanza calda venga rimpiazzata; il costo di leggerla è una lookup su `process.env`.
 *
 * Il ripiego — il percorso della PR 1, `runtime: 'node22'` — resta ESATTAMENTE com'era, per costruzione:
 * lo prova `video-runner-ambiente.test.ts` parametro per parametro. Il rischio che quel percorso lascia
 * aperto è dichiarato (spec §10.2): se Vercel togliesse il runtime `node22` E lo snapshot mancasse, ogni
 * apertura fallirebbe con `SANDBOX_UNAVAILABLE` e i ritentativi non basterebbero. Il battito lo mostra.
 */
export function macchinaVercel(): MacchinaSandbox {
  return {
    async apri({ nome, regione, vcpus, tettoMs }) {
      const aperta = await apriLaMicroVm<Sandbox>(
        {
          // Il riaggancio è il cuore della durevolezza: la MicroVM che sta convertendo ha questo nome, e
          // `Sandbox.get` la ritrova da un processo che non è quello che l'ha creata.
          riaggancia: (nomeSandbox) => Sandbox.get({ name: nomeSandbox, resume: true }),
          crea: (parametri) => Sandbox.create(parametri),
        },
        { nome, regione, vcpus, tettoMs },
        leggiSnapshotConfigurato(process.env[ENV_SNAPSHOT_SANDBOX]),
      )
      return sessione(aperta.sandbox, aperta.nuova, aperta.origine)
    },
  }
}

function sessione(sandbox: Sandbox, nuova: boolean, origine: OrigineMicroVm | undefined): SessioneSandbox {
  return {
    nuova,
    ...(origine === undefined ? {} : { origine }),
    async esegui(comando: ComandoSandbox): Promise<EsitoComando> {
      const finito = await sandbox.runCommand({
        cmd: comando.cmd,
        args: comando.args,
        env: comando.env,
        timeoutMs: comando.tettoMs,
      })
      return {
        exitCode: finito.exitCode,
        stdout: await finito.stdout(),
        stderr: await finito.stderr(),
      }
    },
    async avvia(comando: ComandoSandbox): Promise<void> {
      await sandbox.runCommand({
        cmd: comando.cmd,
        args: comando.args,
        env: comando.env,
        timeoutMs: comando.tettoMs,
        detached: true,
      })
    },
    async ferma(): Promise<void> {
      await sandbox.stop()
    },
  }
}
