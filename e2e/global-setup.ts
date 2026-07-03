import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Prima di ogni run: cartella storageState + seed deterministico (idempotente).
export default function globalSetup() {
  mkdirSync(path.join(__dirname, '.auth'), { recursive: true });
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'seed-e2e.mjs')], {
    stdio: 'inherit',
  });
}
