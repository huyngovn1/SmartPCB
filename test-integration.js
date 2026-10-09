'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { solve, normalizeBoard, flattenOutline, createImportPlan, validateNativePlan } = require('./smartpcb');
const { validatePlacement } = require('./placer');
const { validateRouting } = require('./router');

const exampleFile = path.join(__dirname, 'fixtures', 'sample-board.json');
const example = JSON.parse(fs.readFileSync(exampleFile, 'utf8'));
const scratch = fs.mkdtempSync(path.join(__dirname, 'fixtures', 'integration-'));
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function close(actual, expected, epsilon = 1e-7) { assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`); }
function cli(inputFile, directory, configFile) {
  return spawnSync(process.execPath, [path.join(__dirname, 'smartpcb.js'), inputFile, directory,
    ...(configFile ? [configFile] : [])], { encoding: 'utf8', timeout: 30000 });
}
function fixtureFile(name, value) {
  const target = path.join(scratch, name);
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}
function terminal(directory) { return fs.readFileSync(path.join(directory, 'done.txt'), 'utf8').split(/\r?\n/)[0]; }
function smallBoard(overrides = {}) {
  return {
    schemaVersion: 3, netNames: ['A'],
    outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    layers: [{ id: 1, name: 'Top Layer' }, { id: 32, name: 'Bottom Layer' }],
    components: [{ id: 'U1', index: 0, x: 2, y: 5, rotation: 0, locked: true,
      bounds: { left: 1.5, bottom: 4.5, right: 2.5, top: 5.5 },
      pads: [{ id: '1', x: 2, y: 5, width: 0.8, height: 0.8, shape: 'round', net: 'A', layer: 1 }] },
    { id: 'U2', index: 1, x: 8, y: 5, rotation: 0, locked: true,
      bounds: { left: 7.5, bottom: 4.5, right: 8.5, top: 5.5 },
      pads: [{ id: '1', x: 8, y: 5, width: 0.8, height: 0.8, shape: 'round', net: 'A', layer: 1 }] }],
    tracks: [], vias: [], cutouts: [], keepouts: [],
    rules: { default: { width: 0.2, clearance: 0.2, viaDiameter: 0.6, viaHole: 0.3 }, nets: {} },
    settings: { grid: 0.25, placementIterations: 0, routingPasses: 1, maxCells: 100000, mode: 'route-only' },
    ...overrides
  };
}
const failures = [];
let passed = 0;
function test(name, run) {
  try { run(); passed++; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failures.push({ name, message: error.stack || String(error) }); process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}

test('full pipeline moves invalid initial placement and routes a wide supply with locked anchors', () => {
  const before = JSON.stringify(example), result = solve(example);
  assert.equal(JSON.stringify(example), before);
  assert.ok(result.placement.moves.length > 0);
  assert.equal(result.placement.stats.originalFeasible, false);
  assert.equal(validatePlacement({ ...result.board, components: result.placement.components }).valid, true);
  assert.deepEqual(validateRouting({ ...result.board, components: result.placement.components }, result.routing), { ok: true, errors: [] });
  for (const anchor of ['J1', 'J2']) {
    const original = example.components.find(c => c.id === anchor);
    const placed = result.placement.components.find(c => c.id === anchor);
    close(placed.x, original.x); close(placed.y, original.y); close(placed.rotation, original.rotation);
  }
  assert.ok(result.routing.tracks.some(t => t.net === '3V3'), 'wide supply must have actual generated copper');
  assert.ok(result.routing.tracks.filter(t => t.net === '3V3').every(t => t.width === 0.6));
  assert.ok(result.routing.tracks.filter(t => t.net === 'SIG').every(t => t.width === 0.2));
  assert.equal(result.routing.stats.completionPercent, 100);
  for (const c of result.placement.components) {
    const old = example.components.find(candidate => candidate.id === c.id);
    close(c.rotation, old.rotation);
    for (let i = 0; i < c.pads.length; i++) {
      close(c.pads[i].x - old.pads[i].x, c.x - old.x);
      close(c.pads[i].y - old.pads[i].y, c.y - old.y);
      assert.equal(c.pads[i].net, old.pads[i].net);
    }
  }
});

test('TSV contains exact source component/native net identity and plan counts', () => {
  const result = solve(example);
  const rows = createImportPlan(result.board, result.placement, result.routing).trim().split(/\r?\n/).map(row => row.split('\t'));
  assert.deepEqual(rows[0], ['SMARTPCB', '3', String(result.placement.moves.length), String(result.routing.tracks.length), String(result.routing.vias.length)]);
  const componentRows = rows.filter(row => row[0] === 'COMP');
  for (const row of componentRows) {
    const original = result.board.components.find(c => c.index === Number(row[1]));
    const placed = result.placement.components.find(c => c.id === original.id);
    close(Number(row[2]), original.x); close(Number(row[3]), original.y); close(Number(row[4]), original.rotation);
    close(Number(row[5]), placed.x); close(Number(row[6]), placed.y); close(Number(row[7]), placed.rotation);
  }
  const trackRows = rows.filter(row => row[0] === 'TRACK');
  assert.equal(trackRows.length, result.routing.tracks.length);
  for (let i = 0; i < trackRows.length; i++) {
    const row = trackRows[i], track = result.routing.tracks[i];
    assert.equal(result.board.netNames[Number(row[1])], track.net);
    assert.equal(Number(row[2]), track.layer); close(Number(row[3]), track.width);
    close(Number(row[4]), track.x1); close(Number(row[5]), track.y1);
    close(Number(row[6]), track.x2); close(Number(row[7]), track.y2);
  }
  const viaRows = rows.filter(row => row[0] === 'VIA');
  for (const row of viaRows) { assert.equal(Number(row[6]), 1); assert.equal(Number(row[7]), 32); }
  const end = rows.at(-1);
  assert.equal(end[0], 'END'); assert.equal(Number(end[1]), result.routing.stats.routedPairs);
  assert.equal(Number(end[2]), result.routing.stats.totalPairs);
  assert.equal(Number(end[3]), result.routing.stats.completionPercent);
});

test('native arc flattening preserves forward and reverse contour order within sagitta', () => {
  const forward = [
    { kind: 0, x: 2, y: 0 },
    { kind: 1, x: 12, y: 0, cx: 12, cy: 2, radius: 2, angle1: 270, angle2: 0 },
    { kind: 0, x: 14, y: 2 }, { kind: 0, x: 14, y: 10 }, { kind: 0, x: 0, y: 10 },
    { kind: 1, x: 0, y: 2, cx: 2, cy: 2, radius: 2, angle1: 180, angle2: 270 }
  ];
  const reverse = [
    { kind: 'arc', x: 2, y: 0, cx: 2, cy: 2, radius: 2, angle1: 180, angle2: 270 },
    { kind: 'line', x: 0, y: 2 }, { kind: 'line', x: 0, y: 10 },
    { kind: 'line', x: 14, y: 10 },
    { kind: 'arc', x: 14, y: 2, cx: 12, cy: 2, radius: 2, angle1: 270, angle2: 0 },
    { kind: 'line', x: 12, y: 0 }
  ];
  const a = flattenOutline(forward), b = flattenOutline(reverse);
  assert.equal(a.length, b.length); assert.ok(a.length > 10);
  assert.deepEqual(a[0], { x: 2, y: 0 }); assert.deepEqual(b[0], { x: 2, y: 0 });
  for (let i = 0; i < a.length; i++) {
    const matching = b[(b.length - i) % b.length]; close(a[i].x, matching.x); close(a[i].y, matching.y);
  }
  const arcStart = a.findIndex(p => p.x === 12 && p.y === 0);
  const arcEnd = a.findIndex(p => p.x === 14 && p.y === 2);
  assert.ok(arcStart < arcEnd);
  for (let i = arcStart; i < arcEnd; i++) {
    const midpoint = { x: (a[i].x + a[i + 1].x) / 2, y: (a[i].y + a[i + 1].y) / 2 };
    assert.ok(2 - Math.hypot(midpoint.x - 12, midpoint.y - 2) <= 0.005 + 1e-8);
    assert.ok(a[i + 1].x >= a[i].x - 1e-8 && a[i + 1].y >= a[i].y - 1e-8);
  }
  const bad = copy(forward); bad[1].angle1 = 0; bad[1].angle2 = 90;
  assert.throws(() => flattenOutline(bad), /endpoints/);
});

test('sensitive and protected nets generate no unsupported copper or movement', () => {
  const input = smallBoard({ protectedNets: ['A'], settings: { ...smallBoard().settings, mode: 'place-and-route' } });
  for (const component of input.components) component.locked = false;
  const result = solve(input);
  assert.equal(result.placement.moves.length, 0); assert.equal(result.routing.tracks.length, 0);
  assert.equal(result.routing.unrouted.length, 1); assert.match(result.routing.unrouted[0].reason, /unsupported|protected|manual/i);
  for (const flag of ['differentialPair', 'highSpeed', 'lengthMatched']) {
    const limited = smallBoard(); limited.rules.nets.A = { [flag]: true };
    const skip = solve(limited); assert.equal(skip.routing.tracks.length, 0);
    assert.equal(skip.routing.unrouted.length, 1); assert.notEqual(skip.routing.unrouted[0].reason, '');
  }
  const manual = solve(smallBoard(), { manualNets: ['A'] });
  assert.equal(manual.routing.tracks.length, 0); assert.match(manual.routing.unrouted[0].reason, /manual/i);
});

test('invalid native positions, rotation and duplicate native indices are rejected', () => {
  for (const [field, value] of [['x', null], ['y', '5'], ['rotation', '90'], ['index', -1]]) {
    const input = smallBoard(); input.components[0][field] = value;
    assert.throws(() => solve(input), undefined, `${field} must be rejected`);
  }
  const duplicate = smallBoard(); duplicate.components[1].index = 0;
  assert.throws(() => solve(duplicate), /index|indices/i);
  const outOfRange = smallBoard(); outOfRange.components[0].x = 2540;
  assert.throws(() => solve(outOfRange), /coordinate range/i);
});

test('native plan validation catches moves inconsistent with component geometry', () => {
  const result = solve(smallBoard());
  const corrupt = copy(result.placement);
  corrupt.moves = [{ id: 'U1', x: 4, y: 5, rotation: 0 }];
  assert.throws(() => validateNativePlan(result.board, corrupt, result.routing), /move|locked|consisten|match/i);
});

test('native plan validation catches pad geometry inconsistent with component translation', () => {
  const result = solve(smallBoard());
  const corrupt = copy(result.placement);
  corrupt.components[0].pads[0].x += 0.1;
  assert.throws(() => validateNativePlan(result.board, corrupt, result.routing), /pad|translat|geometry|match/i);
});

test('native plan validation rejects omitted components', () => {
  const result = solve(smallBoard());
  const corrupt = copy(result.placement);
  corrupt.components.pop();
  assert.throws(() => validateNativePlan(result.board, corrupt, result.routing), /component|count|missing/i);
});

test('malformed manual net config is rejected', () => {
  assert.throws(() => solve(smallBoard(), { manualNets: 'A' }), /manualNets|array|config/i);
});

test('an unsupported operation mode is rejected instead of moving and routing', () => {
  const input = smallBoard(); input.settings.mode = 'typo-mode';
  assert.throws(() => solve(input), /mode/i);
});

test('successful CLI writes all deliverables before its OK sentinel', () => {
  const directory = path.join(scratch, 'success'), result = cli(exampleFile, directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(terminal(directory), 'OK');
  for (const filename of ['result.json', 'report.html', 'plan.svg', 'import.tsv']) {
    assert.ok(fs.statSync(path.join(directory, filename)).size > 0, filename);
  }
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
  const tsv = fs.readFileSync(path.join(directory, 'import.tsv'), 'ascii').split(/\r?\n/)[0].split('\t');
  assert.equal(Number(tsv[2]), saved.placement.moves.length);
  assert.equal(Number(tsv[3]), saved.routing.tracks.length);
  assert.equal(Number(tsv[4]), saved.routing.vias.length);
});

test('malformed config overrides a stale success with ERROR sentinel', () => {
  const directory = path.join(scratch, 'malformed-config');
  assert.equal(cli(exampleFile, directory).status, 0);
  const config = fixtureFile('malformed-config.json', '{"settings":');
  const result = cli(exampleFile, directory, config);
  assert.equal(result.status, 1);
  assert.equal(terminal(directory), 'ERROR');
  assert.ok(fs.statSync(path.join(directory, 'error.txt')).size > 0);
});

test('missing input file produces ERROR sentinel and a missing argument returns usage', () => {
  const directory = path.join(scratch, 'missing-input');
  const result = cli(path.join(scratch, 'does-not-exist.json'), directory);
  assert.equal(result.status, 1); assert.equal(terminal(directory), 'ERROR');
  const usage = spawnSync(process.execPath, [path.join(__dirname, 'smartpcb.js')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(usage.status, 2); assert.match(usage.stderr, /Usage:/);
});

test('BOM input/config are accepted while missing config is an explicit error', () => {
  const input = fixtureFile('bom-input.json', '\uFEFF' + JSON.stringify(smallBoard()));
  const config = fixtureFile('bom-config.json', '\uFEFF' + JSON.stringify({ manualNets: ['A'] }));
  const success = path.join(scratch, 'bom-success'), good = cli(input, success, config);
  assert.equal(good.status, 0, good.stderr); assert.equal(terminal(success), 'OK');
  const missing = path.join(scratch, 'missing-config');
  const bad = cli(input, missing, path.join(scratch, 'missing-config.json'));
  assert.equal(bad.status, 1); assert.equal(terminal(missing), 'ERROR');
});

process.stdout.write(`${passed} integration tests passed; ${failures.length} failed. Scratch: ${scratch}\n`);
if (failures.length) {
  for (const failure of failures) process.stderr.write(`\n${failure.name}\n${failure.message}\n`);
  process.exitCode = 1;
}
