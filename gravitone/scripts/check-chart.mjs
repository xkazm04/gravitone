#!/usr/bin/env node
// Policy over the deployment shape: what deploy/helm/gravitone may never regress.
//
// THE GAP THIS CLOSES: the sealed image has a proof (.github/workflows/sealed.yml
// boots it with no network and makes it speak); the chart had none. Nothing in
// any gate read deploy/helm/gravitone/, so every rule the chart states in its own
// comments - readiness on /health and liveness on the socket, requests.cpu equal
// to tts.torchThreads, one worker per pod, "these defaults are one box's numbers"
// - was correct by review and would have stayed green while regressing.
//
// EVERY RULE IS ANCHORED TO THE TREE. The values file is read for what it
// declares AND the template for whether it still applies it. Dependency-free
// node:* - no helm binary, no cluster - so it runs beside the unit suite.
//
//   node scripts/check-chart.mjs           # the gate
//   node --test scripts/                   # its must-fail fixtures
//
// CHANGING A POLICY is a deliberate edit to POLICIES below with the reason.
// Loosening values.yaml until the check goes quiet is the failure mode this file
// exists to prevent.
//
// EXIT CODES: 0 clean · 1 any finding · 2 the chart could not be read.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHART_DIR = 'deploy/helm/gravitone';
export const TEMPLATES_DIR = `${CHART_DIR}/templates`;

/**
 * Every file templates/ is known to contain and what it is, compared in BOTH
 * directions by `unreviewed-template`: a file with no entry is unreviewed, an
 * entry naming a file that is gone is stale. The entry is the record that a
 * human said what the document is; it exempts nothing from the other policies,
 * which read every template regardless.
 */
export const REVIEWED_TEMPLATES = new Map([
  ['deployment.yaml', 'the workload: one worker per pod, readiness on /health, liveness on the socket, the secret checksum'],
  ['service.yaml', 'the front door the callers and the scaler poll'],
  ['service-headless.yaml', 'the peers address book /metrics sums the fleet over'],
  ['secret.yaml', 'the root key, rendered only when apiKey.existingSecret is empty'],
  ['pvc.yaml', 'the shared voices store (persistence.enabled)'],
  ['pdb.yaml', 'the last-serving-replica invariant addressed to whoever drains the node'],
  ['hpa.yaml', 'autoscaling.mode=cpu: the everywhere fallback'],
  ['keda-scaledobject.yaml', 'autoscaling.mode=keda: scale on fleet.queued'],
  ['_helpers.tpl', 'names and labels only; renders no object'],
  ['NOTES.txt', 'post-install prose; renders no object'],
]);

// --- reading YAML that is also a Go template ---------------------------------

const scalar = (v) => String(v).replace(/\s+#.*$/, '').trim();

/** The indented body of a top-level `key:` block, or '' when there is none. */
export function blockOf(yaml, key) {
  const lines = String(yaml ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  if (start === -1) return '';
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (!/^\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** The indented body of the first `key:` at ANY depth of `text`, or ''. */
export function nestedBlockOf(text, key) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*${key}:\\s*(#.*)?$`).test(l));
  if (start === -1) return '';
  const indent = lines[start].match(/^\s*/)[0].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (lines[i].match(/^\s*/)[0].length <= indent) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** The literal value of the first `key:` at any depth of `text`, or null. */
export function valueOf(text, key) {
  const m = new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm').exec(String(text ?? ''));
  if (!m) return null;
  const v = scalar(m[1]);
  return v === '' ? '' : v.replace(/^['"]|['"]$/g, '');
}

export const hasKey = (text, key) => new RegExp(`^\\s*${key}:`, 'm').test(String(text ?? ''));

/** What a probe block READS - `http:/health`, `tcp:8080` - or null. */
export function probeEndpoint(text, name) {
  const block = nestedBlockOf(text, name);
  if (!block) return null;
  const p = hasKey(block, 'httpGet') ? valueOf(block, 'path') : null;
  if (p !== null) return `http:${p}`;
  const port = hasKey(block, 'tcpSocket') ? valueOf(block, 'port') : null;
  return port === null ? null : `tcp:${port}`;
}

/** The literal `value:` of a named env entry in a container's `env:` list, or null. */
export function envValue(text, name) {
  const re = new RegExp(`-\\s*name:\\s*${name}\\s*\\n\\s*value:\\s*(.*)`, 'm');
  const m = re.exec(String(text ?? ''));
  return m ? scalar(m[1]).replace(/^['"]|['"]$/g, '') : null;
}

const CREDENTIAL_SHAPES = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'an OpenAI-style key'],
  [/\bAIza[A-Za-z0-9_-]{20,}/, 'a Google API key'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub token'],
];

const finding = (rule, message, fix) => ({ rule, message, fix });

// --- the policies -------------------------------------------------------------
//
// Each entry: one property of the deployed shape that must not regress, with
// the reason a reviewer can disagree with. `chart` is { values, templates } where
// templates is a Map of file name -> text.

export const POLICIES = [
  {
    rule: 'probes-distinct',
    why: 'one process, two answers: a restarter and a router ask different questions, and a chart that points both probes at one endpoint gets one of them wrong',
    check(chart) {
      const d = chart.templates.get('deployment.yaml') ?? '';
      const ready = probeEndpoint(d, 'readinessProbe');
      const live = probeEndpoint(d, 'livenessProbe');
      if (ready === null || live === null) return [finding(this.rule, 'the Deployment does not declare both a readinessProbe and a livenessProbe', 'declare both; readiness on /health, liveness on the socket')];
      if (ready === live) return [finding(this.rule, `readiness and liveness both read ${ready}`, 'point liveness at tcpSocket 8080 and readiness at /health')];
      return [];
    },
  },
  {
    rule: 'readiness-observes-the-pool',
    why: '/health is the only endpoint whose body is derived from LIVE worker threads (service/app.py health()); a readiness probe on anything else admits traffic to a pod with no functioning worker',
    check(chart) {
      const d = chart.templates.get('deployment.yaml') ?? '';
      const ready = probeEndpoint(d, 'readinessProbe');
      return ready === 'http:/health' ? [] : [finding(this.rule, `readiness reads ${ready ?? 'nothing'}, not /health`, 'readinessProbe.httpGet.path: /health')];
    },
  },
  {
    rule: 'requests-match-threads',
    why: 'per-replica CPU pinning: the model runs tts.torchThreads threads and a request that differs either starves the replica or wastes the node (values.yaml says "keep equal" and nothing checked it)',
    check(chart) {
      const threads = Number(valueOf(blockOf(chart.values, 'tts'), 'torchThreads'));
      const requests = nestedBlockOf(blockOf(chart.values, 'resources'), 'requests');
      const cpu = Number(valueOf(requests, 'cpu'));
      if (!Number.isFinite(threads) || !Number.isFinite(cpu)) return [finding(this.rule, 'tts.torchThreads or resources.requests.cpu is not a number', 'set both to the same integer')];
      return cpu === threads ? [] : [finding(this.rule, `resources.requests.cpu is ${cpu} but tts.torchThreads is ${threads}`, 'make them equal (the plan compiler writes both from the certificate)')];
    },
  },
  {
    rule: 'one-worker-per-pod',
    why: 'the model is GIL-bound, so capacity comes from replicas; and fleet.queued only means "queued requests per replica" when each pod is one process (the SO_REUSEPORT caveat in values.yaml)',
    check(chart) {
      const d = chart.templates.get('deployment.yaml') ?? '';
      const w = envValue(d, 'TTS_WORKERS');
      return w === '1' ? [] : [finding(this.rule, `TTS_WORKERS is ${w ?? 'not pinned'} in the Deployment`, 'pin TTS_WORKERS to "1"; scale with replicas')];
    },
  },
  {
    rule: 'certified-or-declared',
    why: 'the shipped defaults are one box\'s numbers; an overlay compiled by service.plan carries a certificate: header, and installing without one must be a stated choice, never a default that happened',
    check(chart) {
      if (blockOf(chart.values, 'certificate')) return [];
      const allow = valueOf(chart.values, 'allowUncertified');
      return allow === 'true' ? [] : [finding(this.rule, 'values carry neither a certificate: header nor allowUncertified: true', 'compile an overlay with `python -m service.plan certification.json --emit helm-values`, or set allowUncertified: true on purpose')];
    },
  },
  {
    rule: 'disruption-budget',
    why: 'a node drain must refuse loudly rather than evict the last serving replica; the drain "succeeding" is the silent outage',
    check(chart) {
      const t = chart.templates.get('pdb.yaml');
      if (!t || !/kind:\s*PodDisruptionBudget/.test(t)) return [finding(this.rule, 'no PodDisruptionBudget template', 'add templates/pdb.yaml with minAvailable 1')];
      const enabled = valueOf(blockOf(chart.values, 'podDisruptionBudget'), 'enabled');
      return enabled === 'true' ? [] : [finding(this.rule, 'podDisruptionBudget.enabled is not true', 'enable it in values.yaml')];
    },
  },
  {
    rule: 'secret-checksum',
    why: 'the root key arrives through envFrom, which never changes the pod template; without a checksum annotation a rotated key rolls nothing and every pod keeps the old one',
    check(chart) {
      const d = chart.templates.get('deployment.yaml') ?? '';
      return /checksum\/secret:/.test(d) ? [] : [finding(this.rule, 'the pod template carries no checksum/secret annotation', 'annotate the pod template with the sha256 of the rendered secret')];
    },
  },
  {
    rule: 'scaler-reads-the-fleet',
    why: 'a ClusterIP hands each poll to one pod, so metrics.queued is a sample; the scaler must read fleet.queued, summed over the headless peers Service',
    check(chart) {
      const k = chart.templates.get('keda-scaledobject.yaml');
      if (!k) return [];
      const out = [];
      if (valueOf(k, 'valueLocation') !== 'fleet.queued') out.push(finding(this.rule, `the scaler reads ${valueOf(k, 'valueLocation') ?? 'nothing'}`, 'valueLocation: "fleet.queued"'));
      const h = chart.templates.get('service-headless.yaml') ?? '';
      if (!/clusterIP:\s*None/.test(h)) out.push(finding(this.rule, 'no headless peers Service for the fleet sum', 'add templates/service-headless.yaml with clusterIP: None'));
      const d = chart.templates.get('deployment.yaml') ?? '';
      if (envValue(d, 'TTS_FLEET_PEERS') === null) out.push(finding(this.rule, 'the Deployment does not hand the pods TTS_FLEET_PEERS', 'set TTS_FLEET_PEERS to the headless Service name'));
      return out;
    },
  },
  {
    rule: 'no-live-credential',
    why: 'the remote is public; a key in values.yaml is a key in the history',
    check(chart) {
      const out = [];
      const v = valueOf(blockOf(chart.values, 'apiKey'), 'value');
      if (v) out.push(finding(this.rule, 'apiKey.value is set in values.yaml', 'leave it empty; pass --set apiKey.value or use existingSecret'));
      for (const [re, what] of CREDENTIAL_SHAPES) if (re.test(chart.values)) out.push(finding(this.rule, `values.yaml contains ${what}`, 'remove it and rotate it'));
      return out;
    },
  },
  {
    rule: 'unreviewed-template',
    why: 'a policy that reads named files lets an unnamed one carry anything; every file under templates/ is read, and every one has a recorded reason to exist',
    check(chart) {
      const out = [];
      for (const name of chart.templates.keys()) if (!REVIEWED_TEMPLATES.has(name)) out.push(finding(this.rule, `templates/${name} is not in REVIEWED_TEMPLATES`, 'review it and add an entry saying what it is'));
      for (const name of REVIEWED_TEMPLATES.keys()) if (!chart.templates.has(name)) out.push(finding(this.rule, `REVIEWED_TEMPLATES names templates/${name}, which is gone`, 'remove the stale entry'));
      return out;
    },
  },
];

export function loadChart(root = APP_ROOT) {
  const dir = path.join(root, TEMPLATES_DIR);
  const valuesPath = path.join(root, CHART_DIR, 'values.yaml');
  if (!fs.existsSync(valuesPath) || !fs.existsSync(dir)) throw new Error(`chart not found under ${path.join(root, CHART_DIR)}`);
  const templates = new Map();
  for (const name of fs.readdirSync(dir).sort()) {
    if (fs.statSync(path.join(dir, name)).isFile()) templates.set(name, fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return { values: fs.readFileSync(valuesPath, 'utf8'), templates };
}

export function runPolicies(chart, policies = POLICIES) {
  return policies.flatMap((p) => p.check(chart));
}

function main() {
  let chart;
  try {
    chart = loadChart();
  } catch (e) {
    console.error(`check-chart: ${e.message}`);
    process.exit(2);
  }
  const findings = runPolicies(chart);
  if (findings.length === 0) {
    console.log(`check-chart: ${POLICIES.length} policies, ${chart.templates.size} templates read, clean`);
    return;
  }
  for (const f of findings) console.error(`  ${f.rule}: ${f.message}\n      fix: ${f.fix}`);
  console.error(`check-chart: ${findings.length} finding(s) across ${new Set(findings.map((f) => f.rule)).size} policy(ies)`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
