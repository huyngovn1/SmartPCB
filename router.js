'use strict';

/*
 * SmartPCB deterministic routing kernel, millimetres throughout.
 * Public API: routeBoard(board), validateRouting(board, result).
 * Returned tracks/vias are NEW copper only; input copper is retained and fixed.
 * Signal layers are an explicit allowlist, 1..8 layers. Vias are through-hole
 * only and are tested against all supplied signal layers. Plane geometry,
 * differential pairs, impedance and timing are deliberately not inferred.
 * This is a conservative grid router plus geometric clearance validation,
 * not an implementation of the Altium rule system or a manufacturing DRC.
 */

const EPS = 1e-8;
const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DEFAULTS = { width: 0.25, clearance: 0.2, viaDiameter: 0.6, viaHole: 0.3 };

function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
function point(x, y) { return { x, y }; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function squared(a, b) { return (a.x - b.x) ** 2 + (a.y - b.y) ** 2; }
function cross(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function pointSegmentDistance(p, a, b) {
  const len = squared(a, b);
  if (len < EPS * EPS) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len));
  return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
}
function onSegment(p, a, b) {
  return Math.abs(cross(a, b, p)) < EPS && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
}
function segmentsIntersect(a, b, c, d) {
  const c1 = cross(a, b, c), c2 = cross(a, b, d), c3 = cross(c, d, a), c4 = cross(c, d, b);
  if (((c1 > EPS && c2 < -EPS) || (c1 < -EPS && c2 > EPS)) &&
      ((c3 > EPS && c4 < -EPS) || (c3 < -EPS && c4 > EPS))) return true;
  return (Math.abs(c1) <= EPS && onSegment(c, a, b)) || (Math.abs(c2) <= EPS && onSegment(d, a, b)) ||
    (Math.abs(c3) <= EPS && onSegment(a, c, d)) || (Math.abs(c4) <= EPS && onSegment(b, c, d));
}
function segmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
function insidePolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (onSegment(p, a, b)) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function segmentPolygonDistance(a, b, polygon) {
  if (insidePolygon(a, polygon) || insidePolygon(b, polygon)) return 0;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) best = Math.min(best,
    segmentDistance(a, b, polygon[i], polygon[(i + 1) % polygon.length]));
  return best;
}
function edgeDistance(a, b, polygon) {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) best = Math.min(best,
    segmentDistance(a, b, polygon[i], polygon[(i + 1) % polygon.length]));
  return best;
}
function rectangle(b) {
  return [point(b.left, b.bottom), point(b.right, b.bottom), point(b.right, b.top), point(b.left, b.top)];
}
function polygonBounds(poly) {
  return { left: Math.min(...poly.map(p => p.x)), right: Math.max(...poly.map(p => p.x)),
    bottom: Math.min(...poly.map(p => p.y)), top: Math.max(...poly.map(p => p.y)) };
}
function expandedBounds(a, b, radius) {
  return { left: Math.min(a.x, b.x) - radius, bottom: Math.min(a.y, b.y) - radius,
    right: Math.max(a.x, b.x) + radius, top: Math.max(a.y, b.y) + radius };
}
function rotatePoint(p, center, degrees) {
  const ang = degrees * Math.PI / 180, c = Math.cos(ang), s = Math.sin(ang);
  return { x: center.x + p.x * c - p.y * s, y: center.y + p.x * s + p.y * c };
}
function padPrimitive(pad, layers, componentId) {
  const center = point(pad.x, pad.y), rotation = pad.rotation || 0;
  const common = { kind: 'pad', net: pad.net || '', id: componentId + ':' + pad.id, pad,
    layers: pad.throughHole ? layers.map((_, i) => i) : [layers.findIndex(l => String(l.id) === String(pad.layer))] };
  if (pad.shape === 'rect' || pad.shape === 'roundrect') {
    // A rounded rectangle is exactly a smaller rectangle plus a radius disk.
    // At the maximum radius its core degenerates to a segment or a point;
    // segment/polygon distance still handles those without inventing copper.
    const radius = pad.shape === 'roundrect' ? pad.cornerRadius : 0;
    const w = pad.width / 2 - radius, h = pad.height / 2 - radius;
    common.polygon = [point(-w, -h), point(w, -h), point(w, h), point(-w, h)].map(p => rotatePoint(p, center, rotation));
    common.radius = radius;
    const bounds = polygonBounds(common.polygon);
    common.bounds = { left: bounds.left - radius, bottom: bounds.bottom - radius,
      right: bounds.right + radius, top: bounds.top + radius };
  } else {
    // "round" with unequal dimensions is an oval/capsule; never assume an ellipse.
    const radius = Math.min(pad.width, pad.height) / 2;
    const half = Math.abs(pad.width - pad.height) / 2;
    const x = pad.width >= pad.height ? half : 0, y = pad.height > pad.width ? half : 0;
    common.a = rotatePoint(point(-x, -y), center, rotation);
    common.b = rotatePoint(point(x, y), center, rotation);
    common.radius = radius;
    common.bounds = expandedBounds(common.a, common.b, radius);
  }
  return common;
}
function trackPrimitive(t, layerIndex) {
  const a = point(t.x1, t.y1), b = point(t.x2, t.y2);
  return { kind: 'track', net: t.net || '', a, b, radius: t.width / 2,
    layers: [layerIndex], bounds: expandedBounds(a, b, t.width / 2), track: t };
}
function viaPrimitive(v, layers) {
  const a = point(v.x, v.y);
  // The exchange format only supports through-vias, never a silently inferred blind span.
  return { kind: 'via', net: v.net || '', a, b: a, radius: v.diameter / 2,
    layers: layers.map((_, i) => i), bounds: expandedBounds(a, a, v.diameter / 2), via: v };
}
function rawDistance(a, b, object) {
  return object.polygon ? Math.max(0, segmentPolygonDistance(a, b, object.polygon) - (object.radius || 0)) :
    Math.max(0, segmentDistance(a, b, object.a, object.b) - object.radius);
}
function primitiveDistance(a, b) {
  if (a.polygon && b.polygon) {
    if (insidePolygon(a.polygon[0], b.polygon) || insidePolygon(b.polygon[0], a.polygon)) return 0;
    let best = Infinity;
    for (let i = 0; i < a.polygon.length; i++) best = Math.min(best,
      segmentPolygonDistance(a.polygon[i], a.polygon[(i + 1) % a.polygon.length], b.polygon));
    return Math.max(0, best - (a.radius || 0) - (b.radius || 0));
  }
  if (a.polygon) return Math.max(0, segmentPolygonDistance(b.a, b.b, a.polygon) - b.radius - (a.radius || 0));
  if (b.polygon) return Math.max(0, segmentPolygonDistance(a.a, a.b, b.polygon) - a.radius - (b.radius || 0));
  return Math.max(0, segmentDistance(a.a, a.b, b.a, b.b) - a.radius - b.radius);
}
function boundsOverlap(a, b, amount = 0) {
  return a.left <= b.right + amount && a.right >= b.left - amount && a.bottom <= b.top + amount && a.top >= b.bottom - amount;
}
function sameLayer(a, b) { return a.layers.some(l => b.layers.includes(l)); }
function layerRule(context, rule, layer) {
  return { ...rule, ...((rule.layers || {})[String(context.layers[layer].id)] || {}) };
}

class SpatialIndex {
  constructor(size, layerCount) { this.size = size; this.maps = Array.from({ length: layerCount }, () => new Map()); }
  add(object) {
    const x0 = Math.floor(object.bounds.left / this.size), x1 = Math.floor(object.bounds.right / this.size);
    const y0 = Math.floor(object.bounds.bottom / this.size), y1 = Math.floor(object.bounds.top / this.size);
    for (const layer of object.layers) for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = x + ',' + y, bucket = this.maps[layer].get(key) || [];
      bucket.push(object); this.maps[layer].set(key, bucket);
    }
  }
  query(bounds, layer) {
    const objects = new Set(), map = this.maps[layer];
    for (let x = Math.floor(bounds.left / this.size); x <= Math.floor(bounds.right / this.size); x++)
      for (let y = Math.floor(bounds.bottom / this.size); y <= Math.floor(bounds.top / this.size); y++)
        for (const object of map.get(x + ',' + y) || []) objects.add(object);
    return objects;
  }
}

class MinHeap {
  constructor() { this.items = []; this.sequence = 0; }
  less(a, b) { return a.f < b.f - EPS || (Math.abs(a.f - b.f) <= EPS && (a.h < b.h - EPS ||
    (Math.abs(a.h - b.h) <= EPS && a.sequence < b.sequence))); }
  push(item) {
    item.sequence = this.sequence++;
    const arr = this.items; arr.push(item); let i = arr.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(arr[i], arr[p])) break;
      [arr[i], arr[p]] = [arr[p], arr[i]]; i = p; }
  }
  pop() {
    const arr = this.items, first = arr[0], last = arr.pop();
    if (arr.length) { arr[0] = last; let i = 0;
      while (true) { const left = i * 2 + 1, right = left + 1; let best = i;
        if (left < arr.length && this.less(arr[left], arr[best])) best = left;
        if (right < arr.length && this.less(arr[right], arr[best])) best = right;
        if (best === i) break; [arr[i], arr[best]] = [arr[best], arr[i]]; i = best; }
    }
    return first;
  }
  get length() { return this.items.length; }
}
class UnionFind {
  constructor(n) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.parent[Math.max(a, b)] = Math.min(a, b); }
}

function normalize(board) {
  if (!board || !board.bounds) throw new Error('Missing board bounds.');
  const bounds = board.bounds;
  if (!['left', 'bottom', 'right', 'top'].every(k => finite(bounds[k])) || bounds.right <= bounds.left || bounds.top <= bounds.bottom)
    throw new Error('Board bounds must be a positive finite rectangle in mm.');
  const layers = board.layers || [];
  if (!layers.length || layers.length > 8 || new Set(layers.map(l => String(l.id))).size !== layers.length)
    throw new Error('Supply 1..8 unique, explicitly allowed signal layers.');
  if (layers.some(l => /plane/i.test(l.type || '') || l.isPlane)) throw new Error('Plane layers cannot be routed as signal layers.');
  const settings = { grid: 0.25, viaPenalty: 8, bendPenalty: 0.1, congestionPenalty: 0.05, geometryTolerance: 0,
    maxExpansions: 150000, maxTotalExpansions: 500000, maxCells: 2000000,
    routingPasses: 2, endpointSearchCells: 3, ...(board.settings || {}) };
  for (const name of ['grid', 'maxExpansions', 'maxTotalExpansions', 'maxCells', 'routingPasses', 'endpointSearchCells'])
    if (!finite(settings[name]) || settings[name] <= 0) throw new Error('Invalid setting: ' + name);
  if (!finite(settings.viaPenalty) || settings.viaPenalty < 0 || !finite(settings.bendPenalty) || settings.bendPenalty < 0)
    throw new Error('Routing penalties must be nonnegative.');
  if (!finite(settings.congestionPenalty) || settings.congestionPenalty < 0) throw new Error('Invalid congestionPenalty.');
  if (!finite(settings.geometryTolerance) || settings.geometryTolerance < 0) throw new Error('Invalid geometryTolerance.');
  settings.edgeMargin = settings.routingEdgeMargin == null ? (settings.outlineTolerance || 0) : settings.routingEdgeMargin;
  if (!finite(settings.edgeMargin) || settings.edgeMargin < 0) throw new Error('Invalid routingEdgeMargin.');
  settings.routingPasses = Math.min(4, Math.floor(settings.routingPasses));
  settings.endpointSearchCells = Math.min(8, Math.floor(settings.endpointSearchCells));
  const defaultRule = { ...DEFAULTS, ...((board.rules || {}).default || {}) }, netRules = (board.rules || {}).nets || {};
  const ruleFor = net => ({ ...defaultRule, ...(netRules[net] || {}) });
  const rulesToValidate = [defaultRule, ...Object.keys(netRules).map(ruleFor)];
  const allRules = rulesToValidate.flatMap(rule => [rule, ...layers.map(layer => ({ ...rule, ...((rule.layers || {})[String(layer.id)] || {}) }))]);
  for (const rule of allRules) {
    if (!finite(rule.width) || rule.width <= 0 || !finite(rule.clearance) || rule.clearance < 0 ||
        !finite(rule.viaDiameter) || !finite(rule.viaHole) || rule.viaHole <= 0 || rule.viaDiameter <= rule.viaHole)
      throw new Error('Invalid width, clearance or through-via dimensions.');
    if (finite(rule.minWidth) && rule.width < rule.minWidth - EPS) throw new Error('Preferred width is below minWidth.');
    if (finite(rule.maxWidth) && rule.width > rule.maxWidth + EPS) throw new Error('Preferred width is above maxWidth.');
  }
  function checkPolygon(poly, label) {
    if (Array.isArray(poly) && poly.length > 1 && finite(poly[0].x) && finite(poly[0].y) &&
        distance(poly[0], poly[poly.length - 1]) < EPS) poly = poly.slice(0, -1);
    if (!Array.isArray(poly) || poly.length < 3 || poly.some(p => !finite(p.x) || !finite(p.y))) throw new Error(label + ' is invalid.');
    let area = 0;
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; area += a.x * b.y - b.x * a.y;
      for (let j = i + 2; j < poly.length; j++) { if (i === 0 && j === poly.length - 1) continue;
        if (segmentsIntersect(a, b, poly[j], poly[(j + 1) % poly.length])) throw new Error(label + ' is self-intersecting.'); }
    }
    if (Math.abs(area) < EPS) throw new Error(label + ' has zero area.');
    return poly;
  }
  const outline = checkPolygon(board.outline && board.outline.length ? board.outline : rectangle(bounds), 'Outline');
  const cutouts = (board.cutouts || []).map((c, i) => checkPolygon(Array.isArray(c) ? c : c.outline || c.points, 'Cutout ' + i));
  const objects = [], padsByNet = new Map();
  for (const component of board.components || []) for (const pad of component.pads || []) {
    if (![pad.x, pad.y, pad.width, pad.height].every(finite) || pad.width <= 0 || pad.height <= 0 ||
      !['rect', 'round', 'roundrect'].includes(pad.shape) || (pad.rotation != null && !finite(pad.rotation)) ||
      (pad.shape === 'roundrect' && (!finite(pad.cornerRadius) || pad.cornerRadius < 0 ||
        pad.cornerRadius > Math.min(pad.width, pad.height) / 2)))
      throw new Error('Unsupported or invalid pad geometry: ' + component.id + ':' + pad.id);
    if (!pad.throughHole && !layers.some(l => String(l.id) === String(pad.layer)))
      throw new Error('Pad layer is outside the signal-layer allowlist: ' + component.id + ':' + pad.id);
    const object = padPrimitive(pad, layers, component.id); objects.push(object);
    if (object.net) { const netPads = padsByNet.get(object.net) || []; netPads.push(object); padsByNet.set(object.net, netPads); }
  }
  for (const t of board.tracks || []) {
    const layer = layers.findIndex(l => String(l.id) === String(t.layer));
    if (layer < 0 || ![t.x1, t.y1, t.x2, t.y2, t.width].every(finite) || t.width <= 0)
      throw new Error('Unsupported existing track geometry/layer.');
    objects.push(trackPrimitive(t, layer));
  }
  for (const v of board.vias || []) {
    if (![v.x, v.y, v.diameter, v.hole].every(finite) || v.hole <= 0 || v.diameter <= v.hole)
      throw new Error('Unsupported existing via geometry.');
    const first = String(layers[0].id), last = String(layers[layers.length - 1].id);
    if (v.fromLayer != null && v.toLayer != null &&
        !((String(v.fromLayer) === first && String(v.toLayer) === last) || (String(v.fromLayer) === last && String(v.toLayer) === first)))
      throw new Error('Blind/buried via input is unsupported; only through-vias can be exchanged.');
    objects.push(viaPrimitive(v, layers));
  }
  for (const k of board.keepouts || []) {
    const poly = k.outline || k.points || (k.bounds && rectangle(k.bounds));
    checkPolygon(poly, 'Keepout');
    const active = k.layers && k.layers.length ? k.layers.map(id => layers.findIndex(l => String(l.id) === String(id))) : layers.map((_, i) => i);
    if (active.some(i => i < 0)) throw new Error('Keepout references an unavailable signal layer.');
    objects.push({ kind: 'keepout', net: null, layers: active, polygon: poly, bounds: polygonBounds(poly) });
  }
  const nx = Math.floor((bounds.right - bounds.left) / settings.grid + EPS) + 1;
  const ny = Math.floor((bounds.top - bounds.bottom) / settings.grid + EPS) + 1;
  if (nx * ny * layers.length > settings.maxCells) throw new Error('Grid exceeds maxCells; use a coarser grid or increase the explicit limit.');
  const maxClearance = Math.max(...allRules.map(r => r.clearance));
  return { board, bounds, layers, outline, cutouts, settings, defaultRule, ruleFor, objects, padsByNet, nx, ny, maxClearance };
}

function checker(context, objects) {
  const index = new SpatialIndex(Math.max(2, context.settings.grid * 8), context.layers.length);
  const bridgedNets = new Set();
  function add(object) { index.add(object); if (object.kind === 'via' || (object.kind === 'pad' && object.pad.throughHole)) bridgedNets.add(object.net); }
  for (const object of objects) add(object);
  function inside(a, b, radius, clearance) {
    if (!insidePolygon(a, context.outline) || !insidePolygon(b, context.outline)) return false;
    // Strict edge distance also prevents concave-outline excursions between endpoints.
    if (edgeDistance(a, b, context.outline) < radius + clearance + context.settings.edgeMargin - EPS) return false;
    const middle = point((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (!insidePolygon(middle, context.outline)) return false;
    for (const polygon of context.cutouts) if (segmentPolygonDistance(a, b, polygon) < radius + clearance + context.settings.edgeMargin - EPS ||
      insidePolygon(a, polygon) || insidePolygon(b, polygon)) return false;
    return true;
  }
  function segment(a, b, layer, net, radius, rule) {
    if (!inside(a, b, radius, rule.clearance)) return false;
    for (const obstacle of index.query(expandedBounds(a, b, radius + context.maxClearance + context.settings.geometryTolerance), layer)) {
      if (obstacle.net && obstacle.net === net) continue;
      const clearance = obstacle.kind === 'keepout' ? rule.clearance :
        Math.max(rule.clearance, layerRule(context, context.ruleFor(obstacle.net || ''), layer).clearance);
      if (rawDistance(a, b, obstacle) < radius + clearance + context.settings.geometryTolerance - EPS) return false;
      // Zero-clearance rules still forbid physical overlap; mere tangency is permitted.
      if (radius + clearance <= EPS && rawDistance(a, b, obstacle) <= EPS) return false;
    }
    return true;
  }
  function via(p, net, rule) {
    return context.layers.every((_, layer) => segment(p, p, layer, net, rule.viaDiameter / 2, layerRule(context, rule, layer)));
  }
  function bridge(p, net) {
    return [...index.query(expandedBounds(p, p, 0), 0)].some(o => o.net === net &&
      (o.kind === 'via' || (o.kind === 'pad' && o.pad.throughHole)) && rawDistance(p, p, o) <= EPS);
  }
  function congestion(p, layer, net, radius, rule) {
    const reach = Math.max(context.settings.grid * 3, 0.5); let cost = 0;
    for (const object of index.query(expandedBounds(p, p, radius + context.maxClearance + context.settings.geometryTolerance + reach), layer)) {
      if (object.net && object.net === net) continue;
      const space = rawDistance(p, p, object) - radius - context.settings.geometryTolerance - Math.max(rule.clearance,
        layerRule(context, context.ruleFor(object.net || ''), layer).clearance);
      if (space < reach) cost += Math.max(0, 1 - space / reach);
    }
    return Math.min(5, cost);
  }
  return { index, segment, via, bridge, add, congestion, hasBridge: net => bridgedNets.has(net) };
}

function connectionNodes(object) {
  if (object.kind === 'pad') return [{ x: object.pad.x, y: object.pad.y, layers: object.layers, id: object.id }];
  if (object.kind === 'via') return [{ x: object.a.x, y: object.a.y, layers: object.layers, id: 'via' }];
  if (object.kind === 'track') {
    const count = Math.min(16, Math.max(1, Math.ceil(distance(object.a, object.b) / 2))), nodes = [];
    for (let i = 0; i <= count; i++) nodes.push({ x: object.a.x + (object.b.x - object.a.x) * i / count,
      y: object.a.y + (object.b.y - object.a.y) * i / count, layers: object.layers, id: 'track' });
    return nodes;
  }
  return [];
}
function connectedGroups(context, net, objects) {
  const copper = objects.filter(o => o.net === net && o.kind !== 'keepout'), uf = new UnionFind(copper.length);
  for (let i = 0; i < copper.length; i++) for (let j = i + 1; j < copper.length; j++) {
    const a = copper[i], b = copper[j];
    if (boundsOverlap(a.bounds, b.bounds, EPS) && sameLayer(a, b) && primitiveDistance(a, b) <= EPS) uf.union(i, j);
  }
  const groups = new Map();
  copper.forEach((o, i) => { const root = uf.find(i), group = groups.get(root) || { objects: [], pads: [], nodes: [] };
    group.objects.push(o); if (o.kind === 'pad') group.pads.push(o); group.nodes.push(...connectionNodes(o)); groups.set(root, group); });
  return [...groups.values()].filter(g => g.pads.length).map(g => {
    const unique = new Map();
    for (const node of g.nodes) { const key = node.x.toFixed(8) + ',' + node.y.toFixed(8) + ':' + node.layers.join(',');
      if (!unique.has(key)) unique.set(key, node); }
    g.nodes = [...unique.values()]; return g;
  }).sort((a, b) => a.pads[0].id.localeCompare(b.pads[0].id));
}
function nodePairDistance(a, b, penalty) {
  let best = Infinity;
  for (const p of a.nodes) for (const q of b.nodes) best = Math.min(best,
    distance(p, q) + (p.layers.some(l => q.layers.includes(l)) ? 0 : penalty));
  return best;
}

function routeGroups(context, check, net, rule, fromGroup, toGroup, counters) {
  const grid = context.settings.grid, nx = context.nx, ny = context.ny, planeSize = nx * ny;
  const cell = (x, y, layer) => (layer * ny + y) * nx + x;
  const coords = id => { const layer = Math.floor(id / planeSize), rest = id % planeSize;
    const ix = rest % nx, iy = Math.floor(rest / nx);
    return { x: context.bounds.left + ix * grid, y: context.bounds.bottom + iy * grid, ix, iy, layer }; };
  const validity = new Map(), congestion = new Map();
  function validCell(id) {
    if (!validity.has(id)) { const p = coords(id), lr = layerRule(context, rule, p.layer);
      validity.set(id, lr.allowed !== false && check.segment(p, p, p.layer, net, lr.width / 2, lr)); }
    return validity.get(id);
  }
  function cellCongestion(id) {
    if (!congestion.has(id)) { const p = coords(id), lr = layerRule(context, rule, p.layer);
      congestion.set(id, context.settings.congestionPenalty ? check.congestion(p, p.layer, net, lr.width / 2, lr) : 0); }
    return congestion.get(id);
  }
  // All exact endpoints use collision-checked leads; there is no snap-and-shortcut fallback.
  function attach(nodes) {
    const mapping = new Map(), radius = context.settings.endpointSearchCells;
    for (const node of nodes) {
      const ix = Math.round((node.x - context.bounds.left) / grid), iy = Math.round((node.y - context.bounds.bottom) / grid);
      for (const layer of node.layers) for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
        const x = ix + dx, y = iy + dy;
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const id = cell(x, y, layer), p = coords(id);
        const lr = layerRule(context, rule, layer);
        if (!validCell(id) || !check.segment(node, p, layer, net, lr.width / 2, lr)) continue;
        const lead = distance(node, p), previous = mapping.get(id);
        if (!previous || lead < previous.lead - EPS || (Math.abs(lead - previous.lead) <= EPS && node.id < previous.node.id))
          mapping.set(id, { node, lead });
      }
    }
    return mapping;
  }
  // A collision-free straight route is the exact geometric shortest solution for this pair.
  const directPairs = [];
  for (const a of fromGroup.nodes) for (const b of toGroup.nodes) for (const layer of a.layers.filter(l => b.layers.includes(l)))
    directPairs.push({ a, b, layer, length: distance(a, b) });
  directPairs.sort((a, b) => a.length - b.length || a.layer - b.layer || a.a.id.localeCompare(b.a.id) || a.b.id.localeCompare(b.b.id));
  for (const candidate of directPairs) {
    const lr = layerRule(context, rule, candidate.layer);
    if (lr.allowed === false || !check.segment(candidate.a, candidate.b, candidate.layer, net, lr.width / 2, lr)) continue;
    return { tracks: distance(candidate.a, candidate.b) <= EPS ? [] : [{ net, layer: context.layers[candidate.layer].id,
      x1: candidate.a.x, y1: candidate.a.y, x2: candidate.b.x, y2: candidate.b.y, width: lr.width }], vias: [],
      from: candidate.a, to: candidate.b };
  }
  const expansionLimit = Math.min(context.settings.maxExpansions, context.settings.maxTotalExpansions - counters.expansions);
  if (expansionLimit <= 0) return { error: 'Routing pass reached maxTotalExpansions; unresolved connection retained.' };
  const starts = attach(fromGroup.nodes), targets = attach(toGroup.nodes);
  if (!starts.size || !targets.size) return { error: 'No clearance-safe grid attachment for exact pad/trace endpoint.' };
  const targetPoints = [...targets.keys()].map(coords), hCache = new Map();
  function heuristic(id) {
    if (hCache.has(id)) return hCache.get(id);
    const p = coords(id); let best = Infinity;
    for (const q of targetPoints) best = Math.min(best, distance(p, q) +
      (p.layer === q.layer || check.hasBridge(net) ? 0 : context.settings.viaPenalty));
    hCache.set(id, best); return best;
  }
  const heap = new MinHeap(), scores = new Map(), records = new Map();
  for (const [id, lead] of starts) {
    const key = id * 9 + 8, h = heuristic(id);
    scores.set(key, lead.lead); records.set(key, { id, parent: null, source: lead.node });
    heap.push({ key, id, dir: 8, g: lead.lead, h, f: lead.lead + h });
  }
  let expansions = 0, end = null, bestGoal = Infinity, selectedTarget = null;
  function offer(current, id, dir, cost, transition) {
    const key = id * 9 + dir, g = current.g + cost;
    if (scores.has(key) && scores.get(key) <= g + EPS) return;
    const h = heuristic(id); scores.set(key, g); records.set(key, { id, parent: current.key, transition });
    heap.push({ key, id, dir, g, h, f: g + h });
  }
  while (heap.length && expansions < expansionLimit) {
    const current = heap.pop();
    if (current.g > scores.get(current.key) + EPS) continue;
    if (current.f >= bestGoal - EPS) break;
    expansions++;
    const p = coords(current.id);
    const target = targets.get(current.id);
    if (target && current.g + target.lead < bestGoal) { bestGoal = current.g + target.lead; end = current.key; selectedTarget = target.node; }
    for (let dir = 0; dir < 8; dir++) {
      const [dx, dy] = DIRECTIONS[dir], x = p.ix + dx, y = p.iy + dy;
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
      const id = cell(x, y, p.layer);
      if (!validCell(id)) continue;
      if (dx && dy && (!validCell(cell(p.ix + dx, p.iy, p.layer)) || !validCell(cell(p.ix, p.iy + dy, p.layer)))) continue;
      const q = coords(id);
      const lr = layerRule(context, rule, p.layer);
      if (!check.segment(p, q, p.layer, net, lr.width / 2, lr)) continue;
      const bend = current.dir !== 8 && current.dir !== dir ? context.settings.bendPenalty : 0;
      offer(current, id, dir, grid * (dx && dy ? Math.SQRT2 : 1) *
        (1 + context.settings.congestionPenalty * cellCongestion(id)) + bend, 'track');
    }
    if (context.layers.length > 1) {
      const throughCopper = check.bridge(p, net);
      if (throughCopper || (rule.allowVias !== false && check.via(p, net, rule))) for (let layer = 0; layer < context.layers.length; layer++) if (layer !== p.layer) {
        const id = cell(p.ix, p.iy, layer);
        if (validCell(id)) offer(current, id, 8, throughCopper ? 0 : context.settings.viaPenalty, throughCopper ? 'bridge' : 'via');
      }
    }
  }
  counters.expansions += expansions;
  if (end == null) return { error: expansions >= expansionLimit ?
    (counters.expansions >= context.settings.maxTotalExpansions ? 'Routing pass reached maxTotalExpansions; unresolved connection retained.' :
      'Search reached maxExpansions; no route accepted.') : 'No clearance-safe path on the allowed grid/layers.' };
  const path = []; let key = end, source;
  while (key != null) { const record = records.get(key); path.push({ ...coords(record.id), transition: record.transition });
    if (record.source) source = record.source; key = record.parent; }
  path.reverse();
  const tracks = [], vias = [], seenVias = new Set();
  function addTrack(a, b, layer) {
    if (distance(a, b) <= EPS) return;
    const id = context.layers[layer].id, lr = layerRule(context, rule, layer), prev = tracks[tracks.length - 1];
    // Merge only forward, collinear segments, preserving exact endpoints and layer changes.
    if (prev && String(prev.layer) === String(id) && Math.hypot(prev.x2 - a.x, prev.y2 - a.y) < EPS &&
        Math.abs(cross(point(prev.x1, prev.y1), a, b)) < EPS &&
        (a.x - prev.x1) * (b.x - a.x) + (a.y - prev.y1) * (b.y - a.y) >= -EPS) {
      prev.x2 = b.x; prev.y2 = b.y;
    } else tracks.push({ net, layer: id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: lr.width });
  }
  addTrack(source, path[0], path[0].layer);
  for (let i = 1; i < path.length; i++) {
    const previous = path[i - 1], next = path[i];
    if (previous.layer === next.layer) addTrack(previous, next, next.layer);
    else if (next.transition === 'via') {
      const viaKey = next.x.toFixed(8) + ',' + next.y.toFixed(8);
      if (!seenVias.has(viaKey)) { seenVias.add(viaKey); vias.push({ net, x: next.x, y: next.y,
        diameter: rule.viaDiameter, hole: rule.viaHole, fromLayer: context.layers[0].id, toLayer: context.layers[context.layers.length - 1].id }); }
    }
  }
  addTrack(path[path.length - 1], selectedTarget, path[path.length - 1].layer);
  // Validate merged tracks and every new via independently of A* discretization.
  if (tracks.some(t => { const layer = context.layers.findIndex(l => String(l.id) === String(t.layer));
    return !check.segment(point(t.x1, t.y1), point(t.x2, t.y2), layer, net, t.width / 2, layerRule(context, rule, layer));
  }) || vias.some(v => !check.via(v, net, rule)))
    return { error: 'Geometric validation rejected this grid path; no copper accepted.' };
  return { tracks, vias, from: source, to: selectedTarget };
}

function unsupportedReason(rule) {
  return rule.unsupportedReason || (rule.differentialPair ? 'Differential-pair routing is unsupported.' : '') ||
    (rule.highSpeed ? 'High-speed/timing constrained net must be routed separately.' : '') ||
    (rule.lengthMatched ? 'Length matching is unsupported.' : '');
}
function netOrder(context, pass) {
  const order = [...context.padsByNet.keys()];
  const score = net => {
    const rule = context.ruleFor(net), pads = context.padsByNet.get(net), bbox = polygonBounds(pads.map(o => point(o.pad.x, o.pad.y)));
    const area = Math.max(1, (bbox.right - bbox.left) * (bbox.top - bbox.bottom));
    return { priority: finite(rule.priority) ? rule.priority : (/^(GND|AGND|DGND|VCC|VDD|VBAT|\+?\d+V\d*|\+?\d+\.\d+V)$/i.test(net) ? 10 : 0),
      congestion: pads.length / area, count: pads.length };
  };
  const values = new Map(order.map(n => [n, score(n)]));
  return order.sort((a, b) => { const x = values.get(a), y = values.get(b);
    return y.priority - x.priority || (pass % 2 ? x.congestion - y.congestion : y.congestion - x.congestion) ||
      y.count - x.count || (pass >= 2 ? b.localeCompare(a) : a.localeCompare(b)); });
}
function routePass(context, pass) {
  const objects = context.objects.slice(), check = checker(context, objects), tracks = [], vias = [], unrouted = [];
  const stats = { totalPairs: 0, routedPairs: 0, expansions: 0, pass: pass + 1, netOrder: netOrder(context, pass), manualNets: [] };
  for (const net of stats.netOrder) {
    const rule = context.ruleFor(net); let groups = connectedGroups(context, net, objects);
    const initialPairs = Math.max(0, groups.length - 1);
    const unsupported = unsupportedReason(rule);
    if (unsupported) {
      stats.totalPairs += Math.max(1, initialPairs);
      stats.manualNets.push({ net, reason: unsupported, disconnectedGroups: groups.length,
        padCount: context.padsByNet.get(net).length });
      for (let i = 1; i < groups.length; i++) unrouted.push({ net, from: groups[0].pads[0].id, to: groups[i].pads[0].id, reason: unsupported });
      if (groups.length <= 1) unrouted.push({ net, from: groups[0] ? groups[0].pads[0].id : '', to: '',
        reason: unsupported + ' Existing connectivity was not certified; manual review required.' });
      continue;
    }
    stats.totalPairs += initialPairs;
    let failed = new Set(), lastReason = 'No routable connection between disconnected copper groups.';
    while (groups.length > 1) {
      const candidates = [];
      for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++)
        if (!failed.has(i + ':' + j)) candidates.push({ i, j, cost: nodePairDistance(groups[i], groups[j], context.settings.viaPenalty) });
      candidates.sort((a, b) => a.cost - b.cost || a.i - b.i || a.j - b.j);
      if (!candidates.length) break;
      const { i, j } = candidates[0], result = routeGroups(context, check, net, rule, groups[i], groups[j], stats);
      if (result.error) { failed.add(i + ':' + j); lastReason = result.error; continue; }
      tracks.push(...result.tracks); vias.push(...result.vias);
      const newObjects = result.tracks.map(t => trackPrimitive(t, context.layers.findIndex(l => String(l.id) === String(t.layer))))
        .concat(result.vias.map(v => viaPrimitive(v, context.layers)));
      for (const object of newObjects) { objects.push(object); check.add(object); }
      const previousCount = groups.length;
      // Crossing same-net copper may join more than the requested two groups.
      // Rebuild electrical topology from actual copper before reporting completion.
      groups = connectedGroups(context, net, objects);
      stats.routedPairs += previousCount - groups.length;
      failed = new Set();
    }
    for (let i = 1; i < groups.length; i++) unrouted.push({ net, from: groups[0].pads[0].id, to: groups[i].pads[0].id, reason: lastReason });
  }
  stats.completionPercent = stats.totalPairs ? Math.round(10000 * stats.routedPairs / stats.totalPairs) / 100 : 100;
  stats.manualNetCount = stats.manualNets.length;
  stats.completionScope = stats.manualNets.length ?
    'Required disconnected-group joins, plus one review item for each already connected unsupported net.' :
    'Required disconnected-group joins in the supported exported copper model.';
  stats.totalWireLength = tracks.reduce((sum, t) => sum + Math.hypot(t.x2 - t.x1, t.y2 - t.y1), 0);
  stats.viaCount = vias.length; stats.trackCount = tracks.length;
  return { tracks, vias, unrouted, stats };
}

function validateRouting(board, result) {
  let context;
  try { context = normalize(board); } catch (error) { return { ok: false, errors: [error.message] }; }
  const errors = [], generated = [];
  for (let i = 0; i < (result.tracks || []).length; i++) {
    const t = result.tracks[i], layer = context.layers.findIndex(l => String(l.id) === String(t.layer)), rule = context.ruleFor(t.net);
    if (layer < 0 || ![t.x1, t.y1, t.x2, t.y2, t.width].every(finite) || t.width <= 0) { errors.push('Invalid generated track ' + i); continue; }
    const lr = layerRule(context, rule, layer);
    if (lr.allowed === false) errors.push('Generated track ' + i + ' uses a layer forbidden for this net.');
    if (Math.abs(t.width - lr.width) > EPS) errors.push('Generated track ' + i + ' does not use the explicit preferred width.');
    generated.push({ ...trackPrimitive(t, layer), generatedId: 'track ' + i });
  }
  for (let i = 0; i < (result.vias || []).length; i++) {
    const v = result.vias[i], rule = context.ruleFor(v.net);
    if (rule.allowVias === false) errors.push('Generated via ' + i + ' is forbidden by the net through-via policy.');
    if (![v.x, v.y, v.diameter, v.hole].every(finite) || v.diameter <= v.hole || v.hole <= 0 ||
        String(v.fromLayer) !== String(context.layers[0].id) || String(v.toLayer) !== String(context.layers[context.layers.length - 1].id)) {
      errors.push('Invalid generated through-via ' + i); continue;
    }
    if (Math.abs(v.diameter - rule.viaDiameter) > EPS || Math.abs(v.hole - rule.viaHole) > EPS)
      errors.push('Generated via ' + i + ' differs from its explicit net rule.');
    generated.push({ ...viaPrimitive(v, context.layers), generatedId: 'via ' + i });
  }
  const check = checker(context, context.objects.concat(generated));
  for (const object of generated) {
    const rule = context.ruleFor(object.net);
    if (unsupportedReason(rule)) { errors.push(object.generatedId + ' belongs to an unsupported constrained net.'); continue; }
    for (const layer of object.layers) if (!check.segment(object.a, object.b, layer, object.net, object.radius, layerRule(context, rule, layer))) {
      errors.push(object.generatedId + ' violates geometry/clearance on layer ' + context.layers[layer].id); break;
    }
  }
  return { ok: errors.length === 0, errors };
}

function routeBoard(board) {
  let context;
  try { context = normalize(board); } catch (error) {
    const nets = new Map();
    for (const c of board && board.components || []) for (const p of c.pads || []) if (p.net) {
      const ids = nets.get(p.net) || []; ids.push(c.id + ':' + p.id); nets.set(p.net, ids); }
    const unrouted = [];
    for (const [net, ids] of nets) for (let i = 1; i < ids.length; i++) unrouted.push({ net, from: ids[0], to: ids[i], reason: error.message });
    return { tracks: [], vias: [], unrouted, stats: { totalPairs: unrouted.length, routedPairs: 0,
      completionPercent: unrouted.length ? 0 : null, totalWireLength: 0, viaCount: 0, trackCount: 0,
      expansions: 0, validationErrors: [error.message], error: error.message, aborted: true } };
  }
  let best = null;
  for (let pass = 0; pass < context.settings.routingPasses; pass++) {
    const candidate = routePass(context, pass), validation = validateRouting(board, candidate);
    candidate.stats.validationErrors = validation.errors;
    candidate.stats.grid = context.settings.grid;
    candidate.stats.gridCells = context.nx * context.ny * context.layers.length;
    candidate.stats.signalLayers = context.layers.map(l => l.id);
    candidate.stats.throughViasOnly = true;
    if (!validation.ok) {
      // Reject the entire candidate rather than misreporting its connected nets.
      candidate.stats.error = 'Independent geometric validation failed.'; continue;
    }
    if (!best || candidate.stats.routedPairs > best.stats.routedPairs ||
        (candidate.stats.routedPairs === best.stats.routedPairs &&
        candidate.stats.totalWireLength + candidate.stats.viaCount * context.settings.viaPenalty <
        best.stats.totalWireLength + best.stats.viaCount * context.settings.viaPenalty - EPS)) best = candidate;
  }
  if (!best) {
    const unrouted = [];
    for (const net of context.padsByNet.keys()) { const groups = connectedGroups(context, net, context.objects);
      for (let i = 1; i < groups.length; i++) unrouted.push({ net, from: groups[0].pads[0].id,
        to: groups[i].pads[0].id, reason: 'Independent geometric validation rejected every routing pass.' }); }
    return { tracks: [], vias: [], unrouted, stats: { totalPairs: unrouted.length, routedPairs: 0,
      completionPercent: unrouted.length ? 0 : 100, totalWireLength: 0, viaCount: 0, trackCount: 0,
      expansions: 0, error: 'Independent geometric validation rejected every routing pass.', validationErrors: [], aborted: true } };
  }
  best.stats.passesTried = context.settings.routingPasses;
  best.stats.limitations = ['Conservative grid routing; finer grids can change routability.',
    'Only explicitly exported signal layers and through-hole vias are supported.',
    'Geometric validation is not a replacement for Altium DRC or electrical/high-speed review.'];
  return best;
}

module.exports = { routeBoard, validateRouting };
