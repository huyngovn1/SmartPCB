'use strict';

const assert = require('node:assert/strict');
const { placeBoard, PlacementError, validatePlacement, wireMetrics } = require('./placer');

function component(id, x, y, width = 2, height = 2, nets = [], extra = {}) {
  return { id, x, y, rotation: 0, locked: false,
    bounds: { left: x - width / 2, bottom: y - height / 2, right: x + width / 2, top: y + height / 2 },
    pads: nets.map((net, index) => ({ id: String(index + 1), x: x + (index ? 0.5 : -0.5), y,
      net, layer: 1, width: 0.5, height: 0.5, shape: 'rect', throughHole: false })), ...extra };
}
function board(components, extra = {}) {
  return { bounds: { left: 0, bottom: 0, right: 40, top: 30 }, layers: [{ id: 1, name: 'Top' }],
    components, tracks: [], vias: [], keepouts: [], cutouts: [],
    rules: { default: { width: 0.25, clearance: 0.2, viaDiameter: 0.6, viaHole: 0.3 }, nets: {} },
    settings: { grid: 0.5, componentGap: 1, edgeMargin: 1, placementIterations: 700, seed: 2026 }, ...extra };
}
let passed = 0;
function test(name, run) {
  run(); passed++;
  process.stdout.write(`PASS ${name}\n`);
}

test('locked locations/rotations stay exact while pad/body translations are consistent', () => {
  const input = board([
    component('J1', 4.125, 4.375, 3, 3, ['A', 'B'], { locked: true, rotation: 90 }),
    component('R1', 32, 23, 2, 2, ['A'], { rotation: 270 }),
    component('R2', 31, 4, 2, 2, ['B'])
  ]);
  const snapshot = JSON.stringify(input), result = placeBoard(input);
  assert.equal(JSON.stringify(input), snapshot, 'input must be immutable');
  assert.deepEqual(result.components[0], input.components[0]);
  assert.ok(result.moves.length > 0);
  for (let i = 0; i < input.components.length; i++) {
    const before = input.components[i], after = result.components[i];
    assert.equal(after.rotation, before.rotation);
    for (let j = 0; j < before.pads.length; j++) {
      assert.ok(Math.abs((after.pads[j].x - before.pads[j].x) - (after.x - before.x)) < 1e-8);
      assert.ok(Math.abs((after.pads[j].y - before.pads[j].y) - (after.y - before.y)) < 1e-8);
    }
  }
  assert.equal(validatePlacement({ ...input, components: result.components }).valid, true);
});

test('net length and placement objective improve for a crossed four-part layout', () => {
  const input = board([
    component('A1', 4, 4, 2, 2, ['A']), component('A2', 35, 25, 2, 2, ['A']),
    component('B1', 4, 25, 2, 2, ['B']), component('B2', 35, 4, 2, 2, ['B'])
  ]);
  const result = placeBoard(input);
  assert.ok(result.stats.wireMetricAfter < result.stats.wireMetricBefore * 0.5,
    `wire metric did not improve sufficiently: ${JSON.stringify(result.stats)}`);
  assert.ok(result.stats.costAfter < result.stats.costBefore);
  assert.equal(validatePlacement({ ...input, components: result.components }).valid, true);
});

test('overlapping initial components are packed with the requested gap', () => {
  const input = board(Array.from({ length: 12 }, (_, i) => component(`R${i + 1}`, 20, 15, 2, 2, [`N${i % 4}`])));
  const result = placeBoard(input);
  assert.equal(result.stats.originalFeasible, false);
  for (let i = 0; i < result.components.length; i++) {
    for (let j = i + 1; j < result.components.length; j++) {
      const a = result.components[i].bounds, b = result.components[j].bounds;
      assert.ok(a.right + 1 <= b.left + 1e-7 || b.right + 1 <= a.left + 1e-7 ||
        a.top + 1 <= b.bottom + 1e-7 || b.top + 1 <= a.bottom + 1e-7);
    }
  }
});

test('concave outlines, cutouts and keepouts are respected simultaneously', () => {
  const input = board(Array.from({ length: 10 }, (_, i) => component(`U${i}`, 20, 20, 2, 2, [`N${i % 3}`])), {
    outline: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 15 }, { x: 20, y: 15 },
      { x: 20, y: 30 }, { x: 0, y: 30 }],
    cutouts: [[{ x: 6, y: 6 }, { x: 12, y: 6 }, { x: 12, y: 12 }, { x: 6, y: 12 }]],
    keepouts: [{ bounds: { left: 15, bottom: 2, right: 20, top: 7 }, layers: [1] }]
  });
  const result = placeBoard(input);
  assert.equal(validatePlacement({ ...input, components: result.components }).valid, true);
  for (const comp of result.components) {
    const b = comp.bounds;
    assert.ok(b.right <= 19 + 1e-7 || b.top <= 14 + 1e-7, 'body crosses the concave notch');
    assert.ok(b.right <= 5 + 1e-7 || b.left >= 13 - 1e-7 || b.top <= 5 + 1e-7 || b.bottom >= 13 - 1e-7,
      'body or edge margin touches cutout');
    assert.ok(b.right <= 14 + 1e-7 || b.left >= 21 - 1e-7 || b.top <= 1 + 1e-7 || b.bottom >= 8 - 1e-7,
      'body violates keepout gap');
  }
});

test('a notch passing between rectangle corners is rejected', () => {
  const input = board([component('U1', 20, 15, 20, 20)], {
    outline: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 22, y: 30 },
      { x: 22, y: 12 }, { x: 18, y: 12 }, { x: 18, y: 30 }, { x: 0, y: 30 }]
  });
  assert.equal(validatePlacement(input).valid, false);
});

test('existing track/via nets freeze every connected component', () => {
  const input = board([
    component('U1', 5, 5, 2, 2, ['ROUTED', 'A']), component('U2', 31, 23, 2, 2, ['ROUTED']),
    component('R1', 32, 5, 2, 2, ['A'])
  ], { tracks: [{ net: 'ROUTED', x1: 4.5, y1: 5, x2: 30.5, y2: 23, width: 0.25, layer: 1 }] });
  const result = placeBoard(input);
  assert.deepEqual(result.components[0], input.components[0]);
  assert.deepEqual(result.components[1], input.components[1]);
  assert.equal(result.stats.routeProtectedCount, 2);
  assert.equal(result.moves.some(move => move.id === 'U1' || move.id === 'U2'), false);
});

test('unidentified existing routing freezes all components conservatively', () => {
  const input = board([component('U1', 5, 5, 2, 2, ['A']), component('U2', 31, 23, 2, 2, ['A'])],
    { vias: [{ x: 12, y: 12, diameter: 0.6, hole: 0.3 }] });
  const result = placeBoard(input);
  assert.deepEqual(result.components, input.components);
  assert.equal(result.stats.unknownRoutingProtectedAll, true);
  assert.equal(result.moves.length, 0);
});

test('obviously insufficient board area fails without mutating the input', () => {
  const input = board([component('U1', 2, 2, 4, 4), component('U2', 2, 2, 4, 4)], {
    bounds: { left: 0, bottom: 0, right: 5, top: 5 },
    settings: { grid: 0.5, componentGap: 0, edgeMargin: 0, placementIterations: 100 }
  });
  const before = JSON.stringify(input);
  assert.throws(() => placeBoard(input), error => error instanceof PlacementError && error.code === 'INSUFFICIENT_AREA');
  assert.equal(JSON.stringify(input), before);
});

test('a component too tall for the permitted margin fails even when area is sufficient', () => {
  const input = board([component('U1', 4, 2.5, 4, 4)], {
    bounds: { left: 0, bottom: 0, right: 9, top: 5 },
    settings: { grid: 0.5, componentGap: 1, edgeMargin: 1, placementIterations: 100 }
  });
  const before = JSON.stringify(input);
  assert.throws(() => placeBoard(input), error => error instanceof PlacementError && error.code === 'NO_FEASIBLE_PLACEMENT');
  assert.equal(JSON.stringify(input), before);
});

test('fixed connector overhang and existing fixed gap violations are preserved as warnings', () => {
  const input = board([component('J1', 0, 5, 4, 4, [], { locked: true }),
    component('H1', 1, 5, 1, 1, [], { locked: true }), component('R1', 3, 5, 2, 2)]);
  const before = JSON.stringify(input);
  const result = placeBoard(input);
  assert.deepEqual(result.components[0], input.components[0]);
  assert.deepEqual(result.components[1], input.components[1]);
  assert.ok(result.stats.existingFixedViolationCount >= 2);
  assert.equal(result.stats.warnings.some(warning => warning.code === 'EXISTING_FIXED_COMPONENT_OUTSIDE_REGION'), true);
  assert.equal(result.stats.warnings.some(warning => warning.code === 'EXISTING_FIXED_COMPONENT_GAP'), true);
  assert.equal(validatePlacement({ ...input, components: result.components }).valid, true);
  const moved = result.components[2].bounds;
  assert.ok(moved.left >= 3 || moved.bottom >= 8 || moved.top <= 2);
  assert.equal(JSON.stringify(input), before);
});

test('same seed/input gives the same complete plan', () => {
  const input = board(Array.from({ length: 8 }, (_, i) => component(`R${i}`, 4 + i * 4, i % 2 ? 24 : 4,
    2, 2, [`N${i % 3}`])));
  assert.deepEqual(placeBoard(input), placeBoard(input));
});

test('capacitor proximity is only inferred from capacitance and shared power net', () => {
  const ic = component('U1', 10, 10, 4, 4, ['3V3', 'GND', 'A', 'B', 'C', 'D', 'E', 'F'], { locked: true });
  const cap = component('C1', 34, 24, 2, 2, ['3V3', 'GND'], { comment: '100nF' });
  const bulk = component('C2', 34, 10, 2, 2, ['3V3', 'GND'], { comment: '100uF' });
  const input = board([ic, cap, bulk]);
  const result = placeBoard(input);
  assert.equal(result.stats.decouplerHeuristicCount, 1);
  const out = result.components[1];
  assert.ok(Math.hypot(out.x - ic.x, out.y - ic.y) < 8);
  assert.ok(wireMetrics({ ...input, components: result.components }).cost <= wireMetrics(input).cost);
});

process.stdout.write(`${passed} placement tests passed.\n`);
