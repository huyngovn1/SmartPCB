'use strict';

const assert = require('node:assert/strict');
const { routeBoard, validateRouting } = require('./router');

function fixture(overrides = {}) {
  return { bounds: { left: 0, bottom: 0, right: 10, top: 10 },
    outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    layers: [{ id: 'top', name: 'Top Layer' }], components: [], tracks: [], vias: [], cutouts: [], keepouts: [],
    rules: { default: { width: 0.2, clearance: 0.2, viaDiameter: 0.6, viaHole: 0.3 }, nets: {} },
    settings: { grid: 0.25, maxExpansions: 40000, maxCells: 500000, routingPasses: 1, viaPenalty: 3, bendPenalty: 0.1 }, ...overrides };
}
function pad(id, x, y, net = 'A', layer = 'top', width = 0.6, height = 0.6, shape = 'round', throughHole = false) {
  return { id, x, y, rotation: 0, locked: false, bounds: { left: x - width / 2, bottom: y - height / 2,
    right: x + width / 2, top: y + height / 2 }, pads: [{ id: '1', x, y, net, layer, width, height, shape, throughHole }] };
}
function result(board) {
  const routed = routeBoard(board);
  assert.deepEqual(validateRouting(board, routed), { ok: true, errors: [] });
  return routed;
}
let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write('PASS ' + name + '\n'); }

test('uses preferred width exactly and preserves input', () => {
  const board = fixture({ components: [pad('J1', 1.13, 1.19), pad('J2', 8.87, 7.93)],
    rules: { default: { width: 0.37, minWidth: 0.3, maxWidth: 0.5, clearance: 0.2, viaDiameter: 0.7, viaHole: 0.3 }, nets: {} } });
  const original = JSON.stringify(board), routed = result(board);
  assert.equal(JSON.stringify(board), original);
  assert.equal(routed.unrouted.length, 0); assert.equal(routed.stats.completionPercent, 100);
  assert(routed.tracks.every(t => t.width === 0.37));
  assert.equal(routed.tracks[0].x1, 1.13); assert.equal(routed.tracks.at(-1).x2, 8.87);
});

test('routes around foreign rectangular pad with actual clearance', () => {
  const board = fixture({ components: [pad('A1', 1, 5), pad('A2', 9, 5), pad('B1', 5, 5, 'B', 'top', 1, 6, 'rect')] });
  const routed = result(board);
  assert.equal(routed.unrouted.length, 0);
  assert(routed.tracks.some(t => t.y1 <= 1.7 + 1e-8 || t.y1 >= 8.3 - 1e-8));
  const bad = { tracks: [{ net: 'A', layer: 'top', x1: 1, y1: 5, x2: 9, y2: 5, width: 0.2 }], vias: [] };
  assert.equal(validateRouting(board, bad).ok, false);
});

test('cannot traverse a full-height keepout or claim completion', () => {
  const board = fixture({ components: [pad('A1', 1, 5), pad('A2', 9, 5)],
    keepouts: [{ bounds: { left: 4, bottom: 0, right: 6, top: 10 }, layers: ['top'] }] });
  const routed = result(board);
  assert.equal(routed.tracks.length, 0); assert.equal(routed.unrouted.length, 1);
  assert.equal(routed.stats.totalPairs, 1); assert.equal(routed.stats.routedPairs, 0); assert.equal(routed.stats.completionPercent, 0);
});

test('rejects a channel narrower than width plus twice clearance', () => {
  const board = fixture({ components: [pad('A1', 1, 5), pad('A2', 9, 5),
    pad('B1', 5, 4, 'B', 'top', 10, 1, 'rect'), pad('C1', 5, 6, 'C', 'top', 10, 1, 'rect')],
    rules: { default: { width: 0.2, clearance: 0.2, viaDiameter: 0.6, viaHole: 0.3 },
      nets: { A: { width: 0.8 } } } });
  const routed = result(board); assert.equal(routed.unrouted.length, 1); assert.equal(routed.tracks.length, 0);
});

test('uses bottom and through-vias to bypass a top-only wall', () => {
  const board = fixture({ layers: [{ id: 'top' }, { id: 'bottom' }], components: [pad('A1', 1, 5), pad('A2', 9, 5)],
    keepouts: [{ bounds: { left: 4, bottom: 0, right: 6, top: 10 }, layers: ['top'] }] });
  const routed = result(board);
  assert.equal(routed.unrouted.length, 0); assert(routed.tracks.some(t => t.layer === 'bottom')); assert.equal(routed.vias.length, 2);
  assert(routed.vias.every(v => v.fromLayer === 'top' && v.toLayer === 'bottom'));
});

test('via copper is checked against every spanned signal layer', () => {
  const board = fixture({ layers: [{ id: 'top' }, { id: 'inner' }, { id: 'bottom' }],
    components: [pad('A1', 1, 5), pad('A2', 9, 5, 'A', 'bottom'), pad('B1', 5, 5, 'B', 'inner', 3, 3, 'rect')] });
  assert.equal(validateRouting(board, { tracks: [], vias: [{ net: 'A', x: 5, y: 5, diameter: 0.6, hole: 0.3,
    fromLayer: 'top', toLayer: 'bottom' }] }).ok, false);
  const routed = result(board); assert.equal(routed.unrouted.length, 0);
  assert(routed.vias.every(v => Math.abs(v.x - 5) >= 2 - 1e-8 || Math.abs(v.y - 5) >= 2 - 1e-8));
});

test('per-net signal-layer allowlist and layer-specific preferred widths are respected', () => {
  const board = fixture({ layers: [{ id: 'top' }, { id: 'inner' }, { id: 'bottom' }],
    components: [pad('A1', 1, 5), pad('A2', 9, 5, 'A', 'bottom')],
    rules: { default: { width: 0.2, clearance: 0.2, viaDiameter: 0.6, viaHole: 0.3 },
      nets: { A: { layers: { top: { width: 0.2 }, inner: { allowed: false }, bottom: { width: 0.4, minWidth: 0.3, maxWidth: 0.5 } } } } } });
  const routed = result(board); assert.equal(routed.unrouted.length, 0); assert(routed.vias.length >= 1);
  assert(routed.tracks.every(t => t.layer !== 'inner'));
  assert(routed.tracks.filter(t => t.layer === 'bottom').every(t => t.width === 0.4));
  assert.equal(validateRouting(board, { tracks: [{ net: 'A', layer: 'inner', x1: 2, y1: 2, x2: 8, y2: 2, width: 0.2 }], vias: [] }).ok, false);
});

test('explicit boundary approximation margin is enforced', () => {
  const board = fixture({ components: [pad('A1', 1, 0.35), pad('A2', 9, 0.35)],
    settings: { grid: 0.25, maxExpansions: 40000, maxCells: 500000, routingPasses: 1, routingEdgeMargin: 0.1 } });
  const routed = result(board); assert.equal(routed.unrouted.length, 1);
  assert.equal(validateRouting(board, { tracks: [{ net: 'A', layer: 'top', x1: 1, y1: 0.35, x2: 9, y2: 0.35, width: 0.2 }], vias: [] }).ok, false);
});

test('exported copper approximation tolerance is independently enforced', () => {
  const board = fixture({ components: [pad('A1', 1, 1), pad('A2', 9, 1), pad('B1', 5, 5, 'B', 'top', 1, 1, 'rect')],
    settings: { grid: 0.25, maxExpansions: 40000, maxCells: 500000, routingPasses: 1, geometryTolerance: 0.02 } });
  const tangent = { tracks: [{ net: 'A', layer: 'top', x1: 2, y1: 4.2, x2: 8, y2: 4.2, width: 0.2 }], vias: [] };
  assert.equal(validateRouting(board, tangent).ok, false);
  board.settings.geometryTolerance = 0;
  assert.equal(validateRouting(board, tangent).ok, true);
});

test('a through-hole terminal bridges layers without an invented via', () => {
  const board = fixture({ layers: [{ id: 'top' }, { id: 'bottom' }],
    components: [pad('A1', 1, 5, 'A', 'top', 0.8, 0.8, 'round', true), pad('A2', 9, 5, 'A', 'bottom')] });
  const routed = result(board); assert.equal(routed.unrouted.length, 0); assert.equal(routed.vias.length, 0);
  assert(routed.tracks.every(t => t.layer === 'bottom'));
});

test('unmodeled-plane policy prevents new through-vias but retains existing bridges', () => {
  const board = fixture({ layers: [{ id: 'top' }, { id: 'bottom' }],
    components: [pad('A1', 1, 5), pad('A2', 9, 5, 'A', 'bottom')],
    rules: { default: { width: 0.2, clearance: 0.2, viaDiameter: 0.6, viaHole: 0.3, allowVias: false }, nets: {} } });
  let routed = result(board); assert.equal(routed.unrouted.length, 1); assert.equal(routed.vias.length, 0);
  assert.equal(validateRouting(board, { tracks: [], vias: [{ net: 'A', x: 2, y: 5, diameter: 0.6, hole: 0.3,
    fromLayer: 'top', toLayer: 'bottom' }] }).ok, false);
  board.components[0].pads[0].throughHole = true;
  routed = result(board); assert.equal(routed.unrouted.length, 0); assert.equal(routed.vias.length, 0);
});

test('a protected single-group net still requires manual review', () => {
  const board = fixture({ components: [pad('A1', 5, 5)],
    rules: { default: { width: 0.2, clearance: 0.2, viaDiameter: 0.6, viaHole: 0.3 },
      nets: { A: { unsupportedReason: 'Unsupported native pad stack.' } } } });
  const routed = result(board); assert.equal(routed.unrouted.length, 1); assert.equal(routed.stats.completionPercent, 0);
  assert.equal(routed.stats.totalPairs, 1); assert.equal(routed.stats.manualNetCount, 1);
});

test('does not treat an internal plane as a permitted routing layer', () => {
  const board = fixture({ layers: [{ id: 'top' }, { id: 'power', type: 'internalPlane' }, { id: 'bottom' }],
    components: [pad('A1', 1, 5), pad('A2', 9, 5)] });
  const routed = routeBoard(board);
  assert.equal(routed.stats.aborted, true); assert.match(routed.stats.error, /Plane layers/); assert.equal(routed.tracks.length, 0);
});

test('existing copper joins a net tree and only missing branches are routed', () => {
  const board = fixture({ components: [pad('A1', 1, 5), pad('A2', 5, 5), pad('A3', 9, 5), pad('A4', 5, 9)],
    tracks: [{ net: 'A', layer: 'top', x1: 1, y1: 5, x2: 5, y2: 5, width: 0.2 }] });
  const routed = result(board);
  assert.equal(routed.unrouted.length, 0); assert.equal(routed.stats.totalPairs, 2); assert.equal(routed.stats.routedPairs, 2);
  assert(routed.stats.totalWireLength < 9);
});

test('existing foreign trace remains an obstacle', () => {
  const board = fixture({ components: [pad('A1', 1, 5), pad('A2', 9, 5)],
    tracks: [{ net: 'B', layer: 'top', x1: 5, y1: 0, x2: 5, y2: 10, width: 0.4 }] });
  const routed = result(board); assert.equal(routed.unrouted.length, 1); assert.equal(board.tracks.length, 1);
});

test('does not shortcut a non-grid endpoint lead across foreign copper', () => {
  const board = fixture({ components: [pad('A1', 1.13, 5.13, 'A', 'top', 0.2, 0.2), pad('A2', 9.13, 5.13),
    pad('B1', 1.55, 5.13, 'B', 'top', 0.2, 0.8, 'rect')],
    settings: { grid: 0.5, maxExpansions: 40000, maxCells: 500000, routingPasses: 1, viaPenalty: 3, bendPenalty: 0.1 } });
  const routed = result(board); assert.equal(routed.unrouted.length, 0);
  assert.equal(routed.tracks[0].x1, 1.13); assert.equal(routed.tracks[0].y1, 5.13);
  assert(routed.tracks.some(t => t.y1 !== 5.13 || t.y2 !== 5.13));
});

test('concave outline and board cutouts cannot be crossed', () => {
  const board = fixture({ components: [pad('A1', 1, 5), pad('A2', 9, 5)],
    cutouts: [[{ x: 4, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 8 }, { x: 4, y: 8 }]] });
  const routed = result(board); assert.equal(routed.unrouted.length, 0);
  assert.equal(validateRouting(board, { tracks: [{ net: 'A', layer: 'top', x1: 1, y1: 5, x2: 9, y2: 5, width: 0.2 }], vias: [] }).ok, false);
  const concave = fixture({ components: [pad('A1', 2, 8), pad('A2', 8, 8)], outline: [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 6, y: 10 },
    { x: 6, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }] });
  const routedConcave = result(concave); assert.equal(routedConcave.unrouted.length, 0);
  assert(routedConcave.tracks.some(t => t.y1 <= 3.7 + 1e-8 || t.y2 <= 3.7 + 1e-8));
});

test('rotated rectangular pads are checked as rotated copper', () => {
  const obstacle = pad('B1', 5, 5, 'B', 'top', 6, 1, 'rect'); obstacle.pads[0].rotation = 45;
  const board = fixture({ components: [pad('A1', 1, 5), pad('A2', 9, 5), obstacle] });
  const routed = result(board); assert.equal(routed.unrouted.length, 0);
});

test('reports unsupported constrained nets and grid limit failures honestly', () => {
  const board = fixture({ components: [pad('A1', 1, 5), pad('A2', 9, 5)],
    rules: { default: { width: 0.2, clearance: 0.2, viaDiameter: 0.6, viaHole: 0.3 }, nets: { A: { differentialPair: true } } } });
  const routed = result(board); assert.equal(routed.unrouted.length, 1); assert.match(routed.unrouted[0].reason, /Differential/);
  board.settings.maxCells = 10;
  const aborted = routeBoard(board); assert.equal(aborted.stats.aborted, true); assert.match(aborted.stats.error, /maxCells/);
});

test('repeat calls are deterministic', () => {
  const board = fixture({ components: [pad('A1', 1, 5), pad('A2', 9, 5), pad('B1', 5, 5, 'B', 'top', 1, 6, 'rect')] });
  assert.deepEqual(routeBoard(board), routeBoard(board));
});

process.stdout.write(passed + ' meaningful routing checks passed.\n');

// Optional realistic-density synthetic stress fixture, never an AD PCB claim.
if (process.argv.includes('--benchmark')) {
  const components = [], pinNet = i => i % 8 === 0 ? '3V3' : i % 8 === 1 ? 'GND' : 'GPIO' + i;
  const mcuPads = [];
  for (let i = 0; i < 32; i++) {
    const side = Math.floor(i / 8), j = i % 8;
    const x = side === 1 ? 17.4 : side === 3 ? 10.6 : 11.725 + j * 0.65;
    const y = side === 0 ? 7.6 : side === 2 ? 14.4 : 8.725 + j * 0.65;
    mcuPads.push({ id: String(i + 1), x, y, net: pinNet(i), layer: 1, shape: 'rect',
      width: side % 2 ? 1 : 0.35, height: side % 2 ? 0.35 : 1, throughHole: false });
  }
  components.push({ id: 'U1', x: 14, y: 11, rotation: 0, locked: true,
    bounds: { left: 10.1, bottom: 7.1, right: 17.9, top: 14.9 }, pads: mcuPads });
  const signalNets = Array.from({ length: 32 }, (_, i) => pinNet(i)).filter(n => n.startsWith('GPIO'));
  for (let i = 0; i < 24; i++) {
    const x = [5, 9, 19, 23][i % 4], y = 4 + Math.floor(i / 4) * 3;
    components.push({ id: 'R' + (i + 1), x, y, rotation: 0,
      bounds: { left: x - 1.2, bottom: y - 0.75, right: x + 1.2, top: y + 0.75 },
      pads: [{ id: '1', x: x - 0.8, y, net: signalNets[i], layer: 1, width: 0.8, height: 0.5, shape: 'rect', throughHole: false },
        { id: '2', x: x + 0.8, y, net: i % 2 ? 'GND' : '3V3', layer: 1, width: 0.8, height: 0.5, shape: 'rect', throughHole: false }] });
  }
  for (let i = 0; i < 4; i++) {
    const x = i % 2 ? 26 : 2, y = i < 2 ? 4 : 18;
    components.push({ id: 'J' + (i + 1), x, y, rotation: 0, locked: true,
      bounds: { left: x - 1, bottom: y - 3.2, right: x + 1, top: y + 3.2 },
      pads: ['3V3', 'GND', signalNets[i * 2], signalNets[i * 2 + 1]].map((net, j) => ({ id: String(j + 1),
        x, y: y + (j - 1.5) * 1.6, net, layer: 1, width: 1, height: 1, shape: 'round', throughHole: true })) });
  }
  for (let i = 0; i < 3; i++) {
    const x = 8 + i * 6, y = 20.5;
    components.push({ id: 'U' + (i + 2), x, y, rotation: 0,
      bounds: { left: x - 1.2, bottom: y - 0.8, right: x + 1.2, top: y + 0.8 },
      pads: ['VIN', 'GND', '3V3'].map((net, j) => ({ id: String(j + 1), x: x + (j - 1) * 0.8, y,
        net, layer: 1, width: 0.5, height: 0.6, shape: 'rect', throughHole: false })) });
  }
  for (let i = 0; i < 8; i++) components.push(pad('TP' + (i + 1), 8 + i * 1.6, 1.5,
    i < 4 ? signalNets[20 + i] : i % 2 ? 'GND' : '3V3', 1, 0.7, 0.7));
  const board = fixture({ bounds: { left: 0, bottom: 0, right: 28, top: 22 },
    outline: [{ x: 0, y: 0 }, { x: 28, y: 0 }, { x: 28, y: 22 }, { x: 0, y: 22 }],
    layers: [{ id: 1 }, { id: 2 }, { id: 15 }, { id: 32 }], components,
    rules: { default: { width: 0.18, clearance: 0.15, viaDiameter: 0.6, viaHole: 0.3 },
      nets: { '3V3': { width: 0.55, priority: 30 }, GND: { width: 0.4, priority: 20 }, VIN: { width: 0.65, priority: 40 } } },
    settings: { grid: 0.25, maxExpansions: 2500, maxTotalExpansions: 30000, maxCells: 250000,
      routingPasses: 1, endpointSearchCells: 3, viaPenalty: 4, bendPenalty: 0.08, geometryTolerance: 0.01, routingEdgeMargin: 0.05 } });
  const started = Date.now(), routed = result(board);
  assert.equal(components.length, 40);
  assert(routed.tracks.filter(t => t.net === '3V3').every(t => t.width === 0.55));
  const reasons = {};
  for (const pending of routed.unrouted) reasons[pending.reason] = (reasons[pending.reason] || 0) + 1;
  process.stdout.write('BENCHMARK ' + JSON.stringify({ synthetic: true, components: components.length,
    pads: components.reduce((sum, c) => sum + c.pads.length, 0), signalLayers: board.layers.length,
    milliseconds: Date.now() - started, routedPairs: routed.stats.routedPairs, totalPairs: routed.stats.totalPairs,
    completionPercent: routed.stats.completionPercent, newTracks: routed.tracks.length, newVias: routed.vias.length,
    expansions: routed.stats.expansions, validationErrors: routed.stats.validationErrors, reasons }) + '\n');
}
