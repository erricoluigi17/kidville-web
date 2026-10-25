// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * LOCK · `npm run build` HA LO STESSO HEAP DELLA CI (problema S12 della seconda misura, 20/10).
 *
 * La CI imposta `NODE_OPTIONS: '--max-old-space-size=6144'` (`.github/workflows/ci.yml`) e lì la build
 * passa. In locale `npm run build` partiva con l'heap predefinito e finiva in OOM: chi lavorava da un worktree
 * nuovo scopriva il limite alla fine, dopo minuti di compilazione. Lo script ora porta lo stesso valore.
 * Un `NODE_OPTIONS` già impostato da chi lancia viene DOPO, e per Node vince l'ultimo
 * `--max-old-space-size`: `NODE_OPTIONS=--max-old-space-size=8192 npm run build` resta il modo di chiederne
 * di più.
 */

const RADICE = process.cwd()

describe('lock — la build locale ha lo stesso heap della CI', () => {
  it('`npm run build` passa a Node lo stesso --max-old-space-size del workflow, e lascia vincere chi lancia', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(RADICE, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const ci = fs.readFileSync(path.join(RADICE, '.github', 'workflows', 'ci.yml'), 'utf8')
    const mega = /NODE_OPTIONS:\s*'--max-old-space-size=(\d+)'/.exec(ci)?.[1]
    expect(mega, 'ci.yml non dichiara più NODE_OPTIONS nella forma attesa').toBeTruthy()

    const build = pkg.scripts.build
    const opzione = `--max-old-space-size=${mega}`
    expect(build, 'lo script build non porta l’heap della CI').toContain(opzione)
    expect(build.indexOf('${NODE_OPTIONS:-}')).toBeGreaterThan(build.indexOf(opzione))
    expect(build.trim().endsWith('next build')).toBe(true)
  })
})
