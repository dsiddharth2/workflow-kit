import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function findApralabsSource() {
  const fleetLocal = path.join(os.homedir(), '.apra-fleet', 'node_modules', '@apralabs');
  if (
    fs.existsSync(fleetLocal) &&
    fs.existsSync(path.join(fleetLocal, 'apra-fleet-workflow'))
  ) {
    return { scope: fleetLocal };
  }

  // npm global prefix — where `npm install -g @apralabs/apra-fleet` lands.
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    const npmGlobal = path.join(prefix, 'node_modules', '@apralabs');
    if (
      fs.existsSync(npmGlobal) &&
      fs.existsSync(path.join(npmGlobal, 'apra-fleet-workflow'))
    ) {
      return { scope: npmGlobal };
    }

    // Monorepo layout: the workflow package lives inside apra-fleet/packages/.
    const monorepo = path.join(npmGlobal, 'apra-fleet', 'packages');
    if (fs.existsSync(path.join(monorepo, 'apra-fleet-workflow'))) {
      return { monorepo };
    }
  } catch {
    // npm not available or errored — skip this source.
  }

  // Same monorepo check under ~/.apra-fleet.
  const localMonorepo = path.join(fleetLocal, 'apra-fleet', 'packages');
  if (fs.existsSync(path.join(localMonorepo, 'apra-fleet-workflow'))) {
    return { monorepo: localMonorepo };
  }

  return null;
}

export function ensureApralabs() {
  const destDir = path.join(repoRoot, 'node_modules');
  const scopeDest = path.join(destDir, '@apralabs');

  if (fs.existsSync(path.join(scopeDest, 'apra-fleet-workflow'))) {
    return;
  }

  const src = findApralabsSource();
  if (!src) {
    throw new Error(
      'Cannot resolve @apralabs/apra-fleet-workflow. Install Fleet (see README) or run: docker compose run --rm fleet node --test tests/demo.test.mjs',
    );
  }

  fs.mkdirSync(scopeDest, { recursive: true });

  if (src.scope) {
    // Flat layout: symlink the whole @apralabs scope directory.
    let destIsCorrect = false;
    try {
      destIsCorrect = fs.existsSync(scopeDest) && fs.realpathSync(scopeDest) === fs.realpathSync(src.scope);
    } catch {
      destIsCorrect = false;
    }

    if (!destIsCorrect) {
      fs.rmSync(scopeDest, { recursive: true, force: true });
      fs.symlinkSync(src.scope, scopeDest, 'junction');
    }
  } else {
    // Monorepo layout: symlink each package individually.
    const pkgs = fs.readdirSync(src.monorepo).filter(
      (name) => fs.statSync(path.join(src.monorepo, name)).isDirectory(),
    );
    for (const pkg of pkgs) {
      const pkgDest = path.join(scopeDest, pkg);
      const pkgSrc = path.join(src.monorepo, pkg);
      let correct = false;
      try {
        correct = fs.existsSync(pkgDest) && fs.realpathSync(pkgDest) === fs.realpathSync(pkgSrc);
      } catch {
        correct = false;
      }
      if (!correct) {
        fs.rmSync(pkgDest, { recursive: true, force: true });
        fs.symlinkSync(pkgSrc, pkgDest, 'junction');
      }
    }
  }
}
