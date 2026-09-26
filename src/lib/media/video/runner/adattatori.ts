import { Sandbox } from '@vercel/sandbox'
import type { SupabaseClient } from '@supabase/supabase-js'

import { logEvento } from '@/lib/logging/logger'

import type {
  ArchivioVideo,
  CodaVideo,
  ComandoSandbox,
  EsitoComando,
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
 * ═════════════════════════════════════════════════════════════════════════════
 */

/* ────────────────────────────────────────────────────────────────────────────
 * LA CODA — le RPC
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ POSTGREST NON LANCIA: RITORNA `{ error }` (AGENTS, regola 7). Un `try/catch`
 * attorno a una `rpc()` non scatta mai, e il valore di ritorno va guardato sempre —
 * è la ragione per cui ogni funzione qui sotto passa da `esitoRpc`.
 */
function esitoRpc(operazione: string, risposta: { data: unknown; error: unknown }): EsitoRpcVideo {
  if (risposta.error) {
    logEvento(
      'rpc',
      'error',
      { operazione: `video-runner:${operazione}`, esito: 'rpc-non-riuscita' },
      risposta.error,
    )
    return { ok: false, code: 'RPC_ERROR' }
  }
  const corpo = risposta.data
  if (corpo === null || typeof corpo !== 'object') {
    logEvento('rpc', 'error', {
      operazione: `video-runner:${operazione}`,
      esito: 'rpc-risposta-illeggibile',
    })
    return { ok: false, code: 'RPC_ERROR' }
  }
  const letto = corpo as { ok?: unknown; code?: unknown; job?: unknown }
  if (letto.ok === true && letto.job !== null && typeof letto.job === 'object') {
    return { ok: true, job: letto.job as JobVideo }
  }
  return { ok: false, code: typeof letto.code === 'string' ? letto.code : 'RPC_ERROR' }
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

    async prossimo(leaseOwner, leaseSeconds) {
      return esitoRpc(
        'next',
        await supabase.rpc('video_job_next', {
          p_lease_owner: leaseOwner,
          p_lease_seconds: leaseSeconds,
        }),
      )
    },

    async riprendi(jobId, leaseOwner, leaseSeconds) {
      return esitoRpc(
        'claim',
        await supabase.rpc('video_job_claim', {
          p_job_id: jobId,
          p_lease_owner: leaseOwner,
          p_lease_seconds: leaseSeconds,
        }),
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
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'ARCHIVIO — lo Storage
 * ──────────────────────────────────────────────────────────────────────────── */

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
        return { ok: false, motivo: error?.message ?? 'firma-assente' }
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
        return { ok: false, motivo: error?.message ?? 'firma-assente' }
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

export function macchinaVercel(): MacchinaSandbox {
  return {
    async apri({ nome, regione, vcpus, tettoMs }) {
      // Prima si prova a RIAGGANCIARE. È il cuore della durevolezza: la MicroVM che
      // sta convertendo ha questo nome, e `Sandbox.get` la ritrova da un processo
      // che non è quello che l'ha creata.
      try {
        const esistente = await Sandbox.get({ name: nome, resume: true })
        return sessione(esistente, false)
      } catch (err) {
        // Non è un guasto: il caso normale è «non c'è ancora». Si logga a `info`
        // perché senza questa riga «creata» e «riagganciata» sarebbero
        // indistinguibili — cioè non si potrebbe misurare se la ripresa funziona.
        logEvento(
          'cron',
          'info',
          { operazione: 'video-runner:sandbox', esito: 'riaggancio-non-riuscito' },
          err,
        )
      }

      const creata = await Sandbox.create({
        runtime: 'node22',
        name: nome,
        region: regione,
        resources: { vcpus },
        timeout: tettoMs,
        persistent: false,
      })
      return sessione(creata, true)
    },
  }
}

function sessione(sandbox: Sandbox, nuova: boolean): SessioneSandbox {
  return {
    nuova,
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
