// Must-fail fixtures for the chart policy gate. Run with: node --test scripts/
//
// Each case below is a chart that breaks exactly one thing, and proves the policy
// FIRES on it - a policy that cannot fail is a comment with an exit code. The last
// case runs the real chart, so the file that ships is the fixture.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { POLICIES, REVIEWED_TEMPLATES, loadChart, runPolicies } from './check-chart.mjs';

const has = (findings, rule) => findings.some((f) => f.rule === rule);

const DEPLOYMENT = [
  'apiVersion: apps/v1',
  'kind: Deployment',
  'spec:',
  '  template:',
  '    metadata:',
  '      annotations:',
  '        checksum/secret: abc',
  '    spec:',
  '      containers:',
  '        - name: gravitone',
  '          env:',
  '            - name: TTS_WORKERS',
  '              value: "1"',
  '            - name: TTS_FLEET_PEERS',
  '              value: "gravitone-peers.default.svc"',
  '          readinessProbe:',
  '            httpGet:',
  '              path: /health',
  '              port: 8080',
  '          livenessProbe:',
  '            tcpSocket:',
  '              port: 8080',
].join('\n');

const VALUES = [
  'apiKey:',
  '  value: ""',
  '  existingSecret: ""',
  'tts:',
  '  torchThreads: 2',
  'resources:',
  '  requests:',
  '    cpu: "2"',
  '    memory: 3Gi',
  'podDisruptionBudget:',
  '  enabled: true',
  '  minAvailable: 1',
  'allowUncertified: true',
  'autoscaling:',
  '  mode: "off"',
].join('\n');

function good() {
  const templates = new Map();
  for (const name of REVIEWED_TEMPLATES.keys()) templates.set(name, '');
  templates.set('deployment.yaml', DEPLOYMENT);
  templates.set('pdb.yaml', 'kind: PodDisruptionBudget');
  templates.set('service-headless.yaml', 'spec:\n  clusterIP: None');
  templates.set('keda-scaledobject.yaml', '        valueLocation: "fleet.queued"');
  return { values: VALUES, templates };
}

test('the good fixture is clean, so every case below breaks exactly one thing', () => {
  assert.deepEqual(runPolicies(good()), []);
});

test('probes-distinct fires when both probes read one endpoint', () => {
  const c = good();
  c.templates.set('deployment.yaml', DEPLOYMENT.replace('tcpSocket:\n              port: 8080', 'httpGet:\n              path: /health\n              port: 8080'));
  assert.ok(has(runPolicies(c), 'probes-distinct'));
});

test('readiness-observes-the-pool fires when readiness reads the root page', () => {
  const c = good();
  c.templates.set('deployment.yaml', DEPLOYMENT.replace('path: /health', 'path: /'));
  assert.ok(has(runPolicies(c), 'readiness-observes-the-pool'));
});

test('requests-match-threads fires when the request drifts from the thread count', () => {
  const c = good();
  c.values = VALUES.replace('cpu: "2"', 'cpu: "4"');
  assert.ok(has(runPolicies(c), 'requests-match-threads'));
});

test('one-worker-per-pod fires when TTS_WORKERS is raised', () => {
  const c = good();
  c.templates.set('deployment.yaml', DEPLOYMENT.replace('value: "1"', 'value: "4"'));
  assert.ok(has(runPolicies(c), 'one-worker-per-pod'));
});

test('certified-or-declared fires on values with neither a certificate nor the declaration', () => {
  const c = good();
  c.values = VALUES.replace('allowUncertified: true', 'allowUncertified: false');
  assert.ok(has(runPolicies(c), 'certified-or-declared'));
  c.values = VALUES.replace('allowUncertified: true', 'certificate:\n  sha: abc\n  hardware: c8g.2xlarge');
  assert.ok(!has(runPolicies(c), 'certified-or-declared'), 'a certificate header satisfies it');
});

test('disruption-budget fires without the template and when disabled', () => {
  const c = good();
  c.templates.delete('pdb.yaml');
  const f = runPolicies(c);
  assert.ok(has(f, 'disruption-budget'));
  const d = good();
  d.values = VALUES.replace('enabled: true', 'enabled: false');
  assert.ok(has(runPolicies(d), 'disruption-budget'));
});

test('secret-checksum fires when the annotation is dropped', () => {
  const c = good();
  c.templates.set('deployment.yaml', DEPLOYMENT.replace('        checksum/secret: abc\n', ''));
  assert.ok(has(runPolicies(c), 'secret-checksum'));
});

test('scaler-reads-the-fleet fires on the sampled value and on a missing address book', () => {
  const c = good();
  c.templates.set('keda-scaledobject.yaml', '        valueLocation: "metrics.queued"');
  assert.ok(has(runPolicies(c), 'scaler-reads-the-fleet'));
  const d = good();
  d.templates.set('service-headless.yaml', 'spec:\n  type: ClusterIP');
  assert.ok(has(runPolicies(d), 'scaler-reads-the-fleet'));
});

test('no-live-credential fires on a key in values', () => {
  const c = good();
  c.values = VALUES.replace('value: ""', 'value: "sk-abcdefghijklmnopqrstuvwxyz"');
  assert.ok(has(runPolicies(c), 'no-live-credential'));
});

test('unreviewed-template fires in both directions', () => {
  const c = good();
  c.templates.set('worker.yaml', 'kind: Deployment\nhostNetwork: true');
  assert.ok(has(runPolicies(c), 'unreviewed-template'), 'an unlisted file is a finding');
  const d = good();
  d.templates.delete('NOTES.txt');
  assert.ok(has(runPolicies(d), 'unreviewed-template'), 'a stale entry is a finding');
});

test('every policy has a must-fail case above', () => {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  for (const p of POLICIES) assert.ok(src.includes(`'${p.rule}'`), `${p.rule} has no fixture`);
});

test('the shipped chart passes every policy', () => {
  const findings = runPolicies(loadChart());
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
});
