import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARTELLA_BUILD, scriptPreparazioneBuild, USCITE_PREPARAZIONE } from '@/lib/media/video/runner/preparazione'

const cartelle: string[] = []
afterEach(() => { for (const dir of cartelle.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function ambiente(installabile = true) {
  const dir = mkdtempSync(join(tmpdir(), 'kv-build-shell-'))
  cartelle.push(dir)
  const comando = (nome: string, corpo: string) => {
    const file = join(dir, nome)
    writeFileSync(file, `#!/bin/sh\n${corpo}\n`)
    chmodSync(file, 0o755)
  }
  for (const nome of ['mkdir', 'rm']) symlinkSync(`/bin/${nome}`, join(dir, nome))
  comando('curl', `echo download >> '${dir}/eventi'`)
  comando('sha256sum', `echo verifica >> '${dir}/eventi'`)
  comando('tar', `command -v xz >/dev/null || exit 99
echo estrazione >> '${dir}/eventi'
/bin/mkdir -p "$4/$(/usr/bin/dirname "$5")" "$4/$(/usr/bin/dirname "$6")"
/usr/bin/touch "$4/$5" "$4/$6"
/bin/chmod +x "$4/$5" "$4/$6"`)
  comando('sudo', `test "$*" = '-n dnf -y install xz' || exit 97
echo dipendenza >> '${dir}/eventi'
${installabile ? `echo '#!/bin/sh' > '${dir}/xz'\n/bin/chmod +x '${dir}/xz'` : 'exit 1'}`)
  return {
    dir,
    esegui: () => execFileSync('/bin/sh', ['-c', scriptPreparazioneBuild().replaceAll(CARTELLA_BUILD, join(dir, 'build'))], { env: { PATH: dir, NODE_ENV: 'test' }, stdio: 'pipe' }),
    eventi: () => readFileSync(join(dir, 'eventi'), 'utf8').trim().split('\n'),
    comando,
  }
}

describe('runner · preparazione su runtime senza xz', () => {
  it('installa la dipendenza assente prima di verificare ed estrarre la build', () => {
    const qa = ambiente()
    qa.esegui()
    expect(qa.eventi()).toEqual(['dipendenza', 'download', 'verifica', 'estrazione'])
    expect(existsSync(join(qa.dir, 'xz'))).toBe(true)
  })

  it('non installa nulla quando xz è già disponibile', () => {
    const qa = ambiente()
    qa.comando('xz', 'exit 0')
    qa.esegui()
    expect(qa.eventi()).toEqual(['download', 'verifica', 'estrazione'])
  })

  it('si ferma con errore di preparazione se la dipendenza non si installa', () => {
    const qa = ambiente(false)
    try {
      qa.esegui()
      expect.fail('La preparazione deve fallire')
    } catch (error) {
      expect(error).toHaveProperty('status', USCITE_PREPARAZIONE.estrazione)
    }
    expect(qa.eventi()).toEqual(['dipendenza'])
  })
})
