const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const identities = {
  'elven-instrumentation-serverless-plugin': 'elven-observability/elven-instrumentation-serverless-plugin',
};
function assertContext(env, pkg) {
  const repo = identities[pkg.name];
  if (!repo || env.GITHUB_REPOSITORY !== repo) throw new Error('Unexpected publishing repository/package');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Manual main-only release required');
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('GitHub-hosted runner required for provenance');
  if (env.GITHUB_WORKFLOW_REF !== repo + '/.github/workflows/release.yml@refs/heads/main') throw new Error('Unexpected release workflow');
  if (!/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA || '') || env.EXPECTED_SHA !== env.GITHUB_SHA) throw new Error('Exact source SHA confirmation required');
  if (env.CONFIRM !== 'publish ' + pkg.name + '@' + pkg.version || env.EXPECTED_VERSION !== pkg.version || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Exact stable package/version confirmation required');
  if (pkg.repository?.url !== 'git+https://github.com/' + repo + '.git') throw new Error('Provenance repository metadata mismatch');
  if (pkg.publishConfig?.provenance !== true || pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') throw new Error('Mandatory public registry/provenance configuration missing');
  return repo;
}
async function get(url, token) {
  const response = await fetch(url, { headers: token ? { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json' } : {}, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('Release preflight HTTP ' + response.status);
  return response.json();
}
async function verifyRemote(env, pkg) {
  const repo = assertContext(env, pkg);
  const api = 'https://api.github.com/repos/' + repo;
  const repository = await get(api, env.GH_TOKEN);
  if (repository.private !== false || repository.full_name !== repo || repository.default_branch !== 'main') throw new Error('Public matching repository/main required');
  const head = await get(api + '/git/ref/heads/main', env.GH_TOKEN);
  if (head.object.sha !== env.EXPECTED_SHA) throw new Error('main moved: revalidate and confirm its new SHA');
  const runs = await get(api + '/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100', env.GH_TOKEN);
  const run = runs.workflow_runs.find(run => run.head_sha === env.EXPECTED_SHA && run.conclusion === 'success' && run.event === 'push');
  if (!run) throw new Error('Successful main-push CI for this exact SHA required');
  const jobs = await get(api + '/actions/runs/' + run.id + '/jobs?per_page=100', env.GH_TOKEN);
  for (const node of ['22.x', '24.x', '26.x']) {
    if (!jobs.jobs.some(job => job.name === 'test (' + node + ')' && job.conclusion === 'success')) throw new Error('Missing successful Node CI job: ' + node);
  }
  const version = await fetch('https://registry.npmjs.org/' + pkg.name + '/' + pkg.version, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (version.status !== 404) throw new Error(version.ok ? 'Version already published; no replacement allowed' : 'Registry availability UNKNOWN: HTTP ' + version.status);
}
function pack(pkg) {
  const result = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
  if (result.length !== 1) throw new Error('Expected one package archive');
  fs.mkdirSync('release', { recursive: true });
  fs.renameSync(result[0].filename, 'release/package.tgz');
  fs.writeFileSync('release/receipt.json', JSON.stringify({ name: pkg.name, version: pkg.version, sha: process.env.EXPECTED_SHA, sha256: createHash('sha256').update(fs.readFileSync('release/package.tgz')).digest('hex') }, null, 2));
}
function verifyArchive(pkg) {
  const receipt = JSON.parse(fs.readFileSync('release/receipt.json'));
  const hash = createHash('sha256').update(fs.readFileSync('release/package.tgz')).digest('hex');
  if (hash !== receipt.sha256 || receipt.sha !== process.env.EXPECTED_SHA || receipt.name !== pkg.name || receipt.version !== pkg.version) throw new Error('Archive receipt mismatch');
  const packed = JSON.parse(execFileSync('tar', ['-xOf', 'release/package.tgz', 'package/package.json'], { encoding: 'utf8' }));
  assertContext(process.env, packed);
}
if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json')));
  (async () => {
    await verifyRemote(process.env, pkg);
    if (process.argv[2] === 'pack') pack(pkg);
    if (process.argv[2] === 'archive') verifyArchive(pkg);
    console.log('Release preflight passed; no publication performed by this script');
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { assertContext };
