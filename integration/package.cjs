'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const serviceDir = path.join(__dirname, 'fixture');
let attemptedNetworkCalls = 0;
for (const protocol of ['node:http', 'node:https']) {
  const transport = require(protocol);
  for (const method of ['request', 'get']) {
    transport[method] = () => {
      attemptedNetworkCalls++;
      throw new Error('Network disabled in local packaging qualification');
    };
  }
}
const timeout = setTimeout(() => process.exit(2), 45000);
timeout.unref();

async function main() {
  if (!process.env.ELVEN_SERVERLESS_MODULE) throw new Error('Explicit isolated Serverless module required');
  const Serverless = require(process.env.ELVEN_SERVERLESS_MODULE);
  const configuration = JSON.parse(fs.readFileSync(path.join(serviceDir, 'serverless.json'), 'utf8'));
  configuration.plugins = [root];
  const instance = new Serverless({
    serviceDir, configurationFilename: 'serverless.json', configuration,
    commands: ['package'], options: { stage: 'qa', region: 'us-east-1' },
  });
  await instance.init();
  await instance.run();
  const template = JSON.parse(fs.readFileSync(path.join(serviceDir, '.serverless/cloudformation-template-update-stack.json'), 'utf8'));
  const resources = Object.values(template.Resources).filter(item => item.Type === 'AWS::Lambda::Function');
  assert.equal(resources.length, 4);
  const byName = new Map(resources.map(item => [item.Properties.FunctionName, item.Properties]));
  const api = byName.get('elven-local-packaging-qa-api');
  const worker = byName.get('elven-local-packaging-qa-worker');
  for (const item of [api, worker]) {
    assert.equal(item.Layers.length, 2);
    assert.equal(item.Environment.Variables.AWS_LAMBDA_EXEC_WRAPPER, '/opt/otel-handler');
    assert.equal(item.Environment.Variables.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://collector-b.example.test');
    assert.equal(item.Environment.Variables.BUSINESS_SETTING, 'preserved');
  }
  assert.match(api.Layers[0], /:opentelemetry-nodejs-/);
  assert.match(worker.Layers[0], /:opentelemetry-python-/);
  assert.deepEqual(worker.Architectures, ['arm64']);
  for (const name of ['disabled', 'owned']) {
    const item = byName.get(`elven-local-packaging-qa-${name}`);
    assert.equal(item.Layers, undefined);
    assert.equal(item.Environment.Variables.AWS_LAMBDA_EXEC_WRAPPER, undefined);
  }
  const owned = byName.get('elven-local-packaging-qa-owned');
  assert.equal(owned.Environment.Variables.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://collector-a.example.test');
  assert.equal(owned.Environment.Variables.OTEL_EXPORTER_OTLP_HEADERS, 'X-Test=synthetic-owner-marker');
  assert.equal(owned.Environment.Variables.API_TOKEN, undefined);
  assert.equal(attemptedNetworkCalls, 0);
  console.log('Four local functions packaged; two instrumented, two preserved; no network requests or AWS deployment');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => clearTimeout(timeout));
