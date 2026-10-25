/**
 * The app version, worked out from the git history
 * ===============================================
 *
 * The version is not stored by hand but derived, so it says the same thing whatever happened to
 * the branch (a commit, an amend, a cherry-pick, a pull):
 * - major: the first number in package.json, never touched here. Raising it is the user's call,
 *   and the `v<major>.0.0` tag of that release is where the counting below starts
 * - minor: the merge commits on this branch since that tag (one per merged pull request)
 * - patch: the plain commits since the newest of those merges, so a merge resets it to 0
 *
 * The `post-commit` hook runs this and folds the change into the commit that caused it; a merge is
 * made on GitHub, where no hook runs, so .github/workflows/version.yml does the same to the merge
 * commit. Running it on its own only prints the version a clean checkout already has.
 *
 * The release workflows take the published version from the release tag, so what is written here
 * is what the app reports in a development or a locally packaged build.
 */
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const lines = (out) => (out ? out.split('\n') : []);

const packagePath = join(root, 'package.json');
const packageText = readFileSync(packagePath, 'utf8');
const current = JSON.parse(packageText).version;
const major = current.split('.')[0];

// Without the release tag there is nothing to count from: leave the version as it is rather than
// guess one (a shallow clone, or a major raised before its release was tagged)
const anchor = `v${major}.0.0`;
try {
  execFileSync('git', ['rev-parse', '--verify', `refs/tags/${anchor}`], {
    cwd: root,
    stdio: 'ignore',
  });
} catch {
  console.log(`[sync-version] no ${anchor} tag to count from, keeping ${current}`);
  process.exit(0);
}

// --first-parent: only this branch's own history, so the commits a merge brought in are not
// counted again as patches after it
const merges = lines(git('rev-list', '--first-parent', '--merges', `${anchor}..HEAD`));
const since = merges[0] ?? anchor;
const patch = lines(git('rev-list', '--first-parent', '--no-merges', `${since}..HEAD`)).length;
const version = `${major}.${merges.length}.${patch}`;

if (version === current) {
  console.log(`[sync-version] ${version}`);
  process.exit(0);
}

const quoted = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const field = new RegExp(`("version":\\s*)"${quoted(current)}"`);
writeFileSync(packagePath, packageText.replace(field, `$1"${version}"`));

// package-lock.json carries the same version twice (the lock itself and the root package); both
// sit above every dependency, so the first two are the ones to change
const lockPath = join(root, 'package-lock.json');
try {
  let left = 2;
  const lockText = readFileSync(lockPath, 'utf8');
  writeFileSync(
    lockPath,
    lockText.replace(new RegExp(field.source, 'g'), (match, prefix) =>
      left-- > 0 ? `${prefix}"${version}"` : match
    )
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

console.log(`[sync-version] ${current} -> ${version}`);
