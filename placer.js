'use strict';

// Pure placement planning. Coordinates, widths and distances are millimetres.
// Rectangles are deliberately conservative: courtyard/body bounds are kept at
// their exported rotation, and the PCB itself is never modified by this module.

const EPS = 1e-7;

class PlacementError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PlacementError';
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value)) result[key] = clone(value[key]);
    return result;
  }
  return value;
}

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function expanded(rect, distance) {
  return { left: rect.left - distance, bottom: rect.bottom - distance,
    right: rect.right + distance, top: rect.top + distance };
}
function rectAt(component, x, y) {
  return { left: x + component.rel.left, bottom: y + component.rel.bottom,
    right: x + component.rel.right, top: y + component.rel.top };
}
function rectOverlap(a, b, gap = 0) {
  return a.left < b.right + gap - EPS && a.right > b.left - gap + EPS &&
    a.bottom < b.top + gap - EPS && a.top > b.bottom - gap + EPS;
}
function corners(rect) {
  return [{ x: rect.left, y: rect.bottom }, { x: rect.right, y: rect.bottom },
    { x: rect.right, y: rect.top }, { x: rect.left, y: rect.top }];
}
function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function onSegment(point, a, b) {
  return Math.abs(cross(a, b, point)) <= EPS &&
    point.x >= Math.min(a.x, b.x) - EPS && point.x <= Math.max(a.x, b.x) + EPS &&
    point.y >= Math.min(a.y, b.y) - EPS && point.y <= Math.max(a.y, b.y) + EPS;
}
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (onSegment(point, a, b)) return true;
    if ((a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function properIntersection(a, b, c, d) {
  const c1 = cross(a, b, c), c2 = cross(a, b, d);
  const c3 = cross(c, d, a), c4 = cross(c, d, b);
  return ((c1 > EPS && c2 < -EPS) || (c1 < -EPS && c2 > EPS)) &&
    ((c3 > EPS && c4 < -EPS) || (c3 < -EPS && c4 > EPS));
}
function segmentsIntersect(a, b, c, d) {
  return properIntersection(a, b, c, d) || onSegment(a, c, d) ||
    onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
}
function pointInsideRect(point, rect, strict = false) {
  const tolerance = strict ? -EPS : EPS;
  return point.x >= rect.left - tolerance && point.x <= rect.right + tolerance &&
    point.y >= rect.bottom - tolerance && point.y <= rect.top + tolerance;
}

// Corners alone do not prove containment for a concave board. Reject an outline
// segment passing through the open rectangle, including an inward notch whose
// tip and edges lie between the corners.
function segmentThroughRect(a, b, rect) {
  let tMin = 0, tMax = 1;
  const delta = { x: b.x - a.x, y: b.y - a.y };
  for (const axis of ['x', 'y']) {
    const low = axis === 'x' ? rect.left + EPS : rect.bottom + EPS;
    const high = axis === 'x' ? rect.right - EPS : rect.top - EPS;
    if (Math.abs(delta[axis]) <= EPS) {
      if (a[axis] <= low || a[axis] >= high) return false;
    } else {
      let t1 = (low - a[axis]) / delta[axis];
      let t2 = (high - a[axis]) / delta[axis];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMax - tMin <= EPS) return false;
    }
  }
  return tMax > tMin + EPS;
}
function rectInsidePolygon(rect, polygon) {
  if (!corners(rect).every(point => pointInPolygon(point, polygon))) return false;
  for (let i = 0; i < polygon.length; i++) {
    if (segmentThroughRect(polygon[i], polygon[(i + 1) % polygon.length], rect)) return false;
  }
  return true;
}
function rectHitsPolygon(rect, polygon) {
  const points = corners(rect);
  if (points.some(point => pointInPolygon(point, polygon)) ||
      polygon.some(point => pointInsideRect(point, rect))) return true;
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j < polygon.length; j++) {
      if (segmentsIntersect(points[i], points[(i + 1) % points.length],
        polygon[j], polygon[(j + 1) % polygon.length])) return true;
    }
  }
  return false;
}
function polygonArea(polygon) {
  let total = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length];
    total += p.x * q.y - q.x * p.y;
  }
  return Math.abs(total) / 2;
}
function polygonOf(value) {
  const points = Array.isArray(value) ? value : value && (value.outline || value.points || value.polygon);
  if (Array.isArray(points) && points.length >= 3 &&
      points.every(point => finite(point.x) && finite(point.y))) return points;
  if (value && value.bounds) return corners(value.bounds);
  throw new PlacementError('INVALID_GEOMETRY', 'A PCB outline or cutout polygon is invalid.');
}
function validRect(rect) {
  return rect && ['left', 'bottom', 'right', 'top'].every(key => finite(rect[key])) &&
    rect.right > rect.left && rect.top > rect.bottom;
}
function randomGenerator(seed) {
  let state = 2166136261;
  for (const character of String(seed)) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let next = Math.imul(state ^ state >>> 15, 1 | state);
    next ^= next + Math.imul(next ^ next >>> 7, 61 | next);
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
}

function prepare(board) {
  if (!board || !validRect(board.bounds) || !Array.isArray(board.components)) {
    throw new PlacementError('INVALID_BOARD', 'PCB bounds and a component list are required.');
  }
  const settings = board.settings || {};
  const gap = settings.componentGap === undefined ? 1 : Number(settings.componentGap);
  const margin = settings.edgeMargin === undefined ? 1 : Number(settings.edgeMargin);
  const outlineTolerance = settings.outlineTolerance === undefined ? 0.01 : Number(settings.outlineTolerance);
  const grid = settings.grid === undefined ? 0.25 : Number(settings.grid);
  if (!finite(gap) || gap < 0 || !finite(margin) || margin < 0 || !finite(outlineTolerance) || outlineTolerance < 0 ||
      !finite(grid) || grid <= 0) {
    throw new PlacementError('INVALID_SETTINGS', 'Component gap and edge margin must be nonnegative; grid must be positive.');
  }
  const outline = board.outline && board.outline.length ? polygonOf(board.outline) : corners(board.bounds);
  const cutouts = (board.cutouts || []).map(polygonOf);
  const keepouts = (board.keepouts || []).map((keepout, index) => {
    if (keepout.bounds && !validRect(keepout.bounds)) {
      throw new PlacementError('INVALID_GEOMETRY', `Keepout ${index + 1} has invalid bounds.`);
    }
    return keepout.bounds ? { bounds: keepout.bounds } : { polygon: polygonOf(keepout) };
  });
  const tracks = board.tracks || [], vias = board.vias || [];
  const routes = tracks.concat(vias);
  const hasUnknownRoutes = (board.hasExistingRoutes && routes.length === 0) ||
    routes.some(route => route.net === undefined || route.net === null || route.net === '');
  const routedNets = new Set(routes.map(route => String(route.net)));
  const ids = new Set();
  const components = board.components.map((source, index) => {
    if (!source || source.id === undefined || ids.has(String(source.id)) ||
        !finite(source.x) || !finite(source.y) || !validRect(source.bounds)) {
      throw new PlacementError('INVALID_COMPONENT', `Component ${index + 1} has missing/duplicate ID or invalid position/bounds.`);
    }
    ids.add(String(source.id));
    const pads = (source.pads || []).map(pad => {
      if (!finite(pad.x) || !finite(pad.y)) {
        throw new PlacementError('INVALID_PAD', `Component ${source.id} has an invalid pad position.`);
      }
      return { source: pad, dx: pad.x - source.x, dy: pad.y - source.y,
        net: pad.net === undefined || pad.net === null ? '' : String(pad.net) };
    });
    const routeProtected = !!hasUnknownRoutes || pads.some(pad => pad.net && routedNets.has(pad.net));
    return { source, index, id: String(source.id), x: source.x, y: source.y,
      fixed: !!source.locked || routeProtected, routeProtected, pads,
      rel: { left: source.bounds.left - source.x, bottom: source.bounds.bottom - source.y,
        right: source.bounds.right - source.x, top: source.bounds.top - source.y },
      area: (source.bounds.right - source.bounds.left) * (source.bounds.top - source.bounds.bottom) };
  });
  const nets = new Map();
  for (const component of components) {
    for (const pad of component.pads) {
      if (!pad.net) continue;
      if (!nets.has(pad.net)) nets.set(pad.net, { name: pad.net, pads: [], components: new Map() });
      const net = nets.get(pad.net);
      net.pads.push({ component: component.index, dx: pad.dx, dy: pad.dy });
      if (!net.components.has(component.index)) net.components.set(component.index, []);
      net.components.get(component.index).push(pad);
    }
  }
  const activeNets = [...nets.values()].filter(net => net.components.size > 1);
  for (const net of activeNets) {
    const rule = board.rules && board.rules.nets && board.rules.nets[net.name];
    net.weight = rule && finite(rule.placementWeight) && rule.placementWeight > 0 ? rule.placementWeight :
      1 / Math.sqrt(Math.max(1, net.components.size - 1));
    net.points = [...net.components.entries()].map(([index, pads]) => ({ component: index,
      dx: pads.reduce((sum, pad) => sum + pad.dx, 0) / pads.length,
      dy: pads.reduce((sum, pad) => sum + pad.dy, 0) / pads.length }));
  }
  const context = { board, settings, bounds: board.bounds, outline, cutouts, keepouts,
    components, nets, activeNets, gap, margin, outlineTolerance, effectiveMargin: margin + outlineTolerance,
    grid, hasUnknownRoutes };
  context.diagonal = Math.hypot(board.bounds.right - board.bounds.left, board.bounds.top - board.bounds.bottom);
  context.edges = makeConnectionEdges(context);
  context.crossingPairs = makeCrossingPairs(context.edges);
  context.decouplers = detectDecouplers(context);
  return context;
}

function pointOf(position, endpoint) {
  return { x: position[endpoint.component].x + endpoint.dx,
    y: position[endpoint.component].y + endpoint.dy };
}

// A sparse, fixed minimum spanning tree for each net is a placement objective,
// not an electrical routing instruction. Its endpoints remain actual net pins.
function makeConnectionEdges(context) {
  const positions = context.components.map(component => ({ x: component.x, y: component.y }));
  const edges = [];
  for (const net of context.activeNets) {
    const points = net.points;
    const used = new Array(points.length).fill(false);
    const distances = new Array(points.length).fill(Infinity);
    const parent = new Array(points.length).fill(-1);
    distances[0] = 0;
    for (let count = 0; count < points.length; count++) {
      let next = -1;
      for (let i = 0; i < points.length; i++) {
        if (!used[i] && (next < 0 || distances[i] < distances[next])) next = i;
      }
      used[next] = true;
      if (parent[next] >= 0) edges.push({ a: points[parent[next]], b: points[next], net: net.name, weight: net.weight });
      const a = pointOf(positions, points[next]);
      for (let i = 0; i < points.length; i++) {
        if (used[i]) continue;
        const b = pointOf(positions, points[i]);
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance < distances[i]) { distances[i] = distance; parent[i] = next; }
      }
    }
  }
  return edges;
}
function makeCrossingPairs(edges) {
  const selected = edges.map((edge, index) => ({ edge, index }))
    .sort((a, b) => b.edge.weight - a.edge.weight || a.index - b.index).slice(0, 100);
  const pairs = [];
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const a = selected[i].edge, b = selected[j].edge;
      if (a.net !== b.net && a.a.component !== b.a.component && a.a.component !== b.b.component &&
          a.b.component !== b.a.component && a.b.component !== b.b.component) {
        pairs.push([selected[i].index, selected[j].index]);
      }
    }
  }
  return pairs;
}
function detectDecouplers(context) {
  if (context.settings.decouplingBias === false) return [];
  const ground = name => /^(gnd|agnd|dgnd|pgnd|vss|ground)(?:[_\d].*)?$/i.test(name);
  const supply = name => /^(?:\+?\d+(?:[v.]\d+)?v?|vcc|vdd|avdd|dvdd|pvdd|3v3)(?:[_-].*)?$/i.test(name);
  const pairs = [];
  for (const component of context.components) {
    if (!/^C\d+/i.test(component.id) || component.pads.length !== 2) continue;
    const comment = String(component.source.comment || '');
    const value = comment.match(/(\d+(?:[.,]\d+)?)\s*(pF|nF|uF|µF|μF)/i);
    if (!value) continue;
    const multiplier = /^p/i.test(value[2]) ? 1e-6 : /^n/i.test(value[2]) ? 1e-3 : 1;
    if (Number(value[1].replace(',', '.')) * multiplier > 1) continue;
    const groundPad = component.pads.find(pad => ground(pad.net));
    const powerPad = component.pads.find(pad => supply(pad.net));
    if (!groundPad || !powerPad) continue;
    let best = null, bestDistance = Infinity;
    for (const target of context.components) {
      if (target.index === component.index || target.pads.length < 8) continue;
      for (const pad of target.pads) {
        if (pad.net !== powerPad.net) continue;
        const distance = Math.hypot(component.x + powerPad.dx - target.x - pad.dx,
          component.y + powerPad.dy - target.y - pad.dy);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { a: { component: component.index, dx: powerPad.dx, dy: powerPad.dy },
            b: { component: target.index, dx: pad.dx, dy: pad.dy } };
        }
      }
    }
    if (best) pairs.push(best);
  }
  return pairs;
}

function domainFits(context, rect) {
  const padded = expanded(rect, context.effectiveMargin);
  if (padded.left < context.bounds.left - EPS || padded.right > context.bounds.right + EPS ||
      padded.bottom < context.bounds.bottom - EPS || padded.top > context.bounds.top + EPS ||
      !rectInsidePolygon(padded, context.outline)) return false;
  for (const cutout of context.cutouts) if (rectHitsPolygon(padded, cutout)) return false;
  for (const keepout of context.keepouts) {
    if (keepout.bounds ? rectOverlap(rect, keepout.bounds, context.gap) :
      rectHitsPolygon(expanded(rect, context.gap), keepout.polygon)) return false;
  }
  return true;
}

class SpatialIndex {
  constructor(cell) { this.cell = cell; this.buckets = new Map(); }
  keys(rect) {
    const keys = [];
    for (let x = Math.floor(rect.left / this.cell); x <= Math.floor(rect.right / this.cell); x++) {
      for (let y = Math.floor(rect.bottom / this.cell); y <= Math.floor(rect.top / this.cell); y++) keys.push(`${x},${y}`);
    }
    return keys;
  }
  add(index, rect) {
    for (const key of this.keys(rect)) {
      if (!this.buckets.has(key)) this.buckets.set(key, []);
      this.buckets.get(key).push({ index, rect });
    }
  }
  hits(rect, gap) {
    const found = new Set();
    const candidates = [];
    for (const key of this.keys(expanded(rect, gap))) {
      for (const candidate of this.buckets.get(key) || []) {
        if (!found.has(candidate.index)) { found.add(candidate.index); candidates.push(candidate); }
      }
    }
    return candidates.some(candidate => rectOverlap(rect, candidate.rect, gap));
  }
}

function violation(context, positions) {
  for (const component of context.components) {
    // A connector's locked body may intentionally overhang the board edge.
    // Preserve its exact geometry and report it separately as an existing
    // condition; all movable bodies must satisfy the placement region.
    if (component.fixed) {
      if (Math.abs(positions[component.index].x - component.x) > EPS ||
          Math.abs(positions[component.index].y - component.y) > EPS) {
        return { code: 'FIXED_COMPONENT_MOVED', components: [component.id],
          message: `${component.id} is locked or protected by existing routing and was moved.` };
      }
      continue;
    }
    if (!domainFits(context, rectAt(component, positions[component.index].x, positions[component.index].y))) {
      return { code: 'OUTSIDE_PLACEMENT_REGION', components: [component.id],
        message: `${component.id} crosses a board edge, cutout or placement keepout.` };
    }
  }
  const index = new SpatialIndex(Math.max(2, context.diagonal / Math.max(4, Math.sqrt(positions.length))));
  for (const component of context.components) {
    const rect = rectAt(component, positions[component.index].x, positions[component.index].y);
    if (index.hits(rect, context.gap)) {
      const other = context.components.find(candidate => candidate.index < component.index &&
        !(component.fixed && candidate.fixed) &&
        rectOverlap(rect, rectAt(candidate, positions[candidate.index].x, positions[candidate.index].y), context.gap));
      if (!other) { index.add(component.index, rect); continue; }
      return { code: 'COMPONENT_OVERLAP', components: [other.id, component.id],
        message: `${other.id} and ${component.id} violate the ${context.gap} mm component gap.` };
    }
    index.add(component.index, rect);
  }
  return null;
}

function fixedWarnings(context) {
  const warnings = [], fixed = context.components.filter(component => component.fixed);
  for (let i = 0; i < fixed.length; i++) {
    const rect = rectAt(fixed[i], fixed[i].x, fixed[i].y);
    if (!domainFits(context, rect)) {
      warnings.push({ code: 'EXISTING_FIXED_COMPONENT_OUTSIDE_REGION', components: [fixed[i].id],
        message: `${fixed[i].id} is preserved at its existing locked/routed location; its bounds cross the edge margin, cutout or keepout.` });
    }
    for (let j = 0; j < i; j++) {
      if (rectOverlap(rect, rectAt(fixed[j], fixed[j].x, fixed[j].y), context.gap)) {
        warnings.push({ code: 'EXISTING_FIXED_COMPONENT_GAP', components: [fixed[j].id, fixed[i].id],
          message: `${fixed[j].id} and ${fixed[i].id} retain an existing gap violation because both positions are fixed.` });
      }
    }
  }
  return warnings;
}

function metrics(context, positions) {
  let wireMetric = 0, connectionMetric = 0, crossings = 0, decouplingMetric = 0;
  const bins = new Float64Array(64);
  const cellWidth = (context.bounds.right - context.bounds.left) / 8;
  const cellHeight = (context.bounds.top - context.bounds.bottom) / 8;
  for (const net of context.activeNets) {
    let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
    for (const pad of net.pads) {
      const x = positions[pad.component].x + pad.dx, y = positions[pad.component].y + pad.dy;
      left = Math.min(left, x); right = Math.max(right, x);
      bottom = Math.min(bottom, y); top = Math.max(top, y);
    }
    const span = right - left + top - bottom;
    wireMetric += net.weight * span;
    const minX = clamp(Math.floor((left - context.bounds.left) / cellWidth), 0, 7);
    const maxX = clamp(Math.floor((right - context.bounds.left) / cellWidth), 0, 7);
    const minY = clamp(Math.floor((bottom - context.bounds.bottom) / cellHeight), 0, 7);
    const maxY = clamp(Math.floor((top - context.bounds.bottom) / cellHeight), 0, 7);
    const demand = net.weight * span / Math.max(cellWidth, cellHeight) /
      ((maxX - minX + 1) * (maxY - minY + 1));
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) bins[y * 8 + x] += demand;
  }
  const endpoints = context.edges.map(edge => {
    const a = pointOf(positions, edge.a), b = pointOf(positions, edge.b);
    connectionMetric += edge.weight * Math.hypot(a.x - b.x, a.y - b.y);
    return { a, b };
  });
  for (const [a, b] of context.crossingPairs) {
    if (properIntersection(endpoints[a].a, endpoints[a].b, endpoints[b].a, endpoints[b].b)) crossings++;
  }
  let congestion = 0;
  for (const demand of bins) congestion += demand * demand;
  congestion /= 64;
  for (const pair of context.decouplers) {
    const a = pointOf(positions, pair.a), b = pointOf(positions, pair.b);
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    decouplingMetric += distance + 0.05 * Math.pow(Math.max(0, distance - 5), 2);
  }
  const congestionWeight = finite(context.settings.congestionWeight) ? Math.max(0, context.settings.congestionWeight) : 0.04;
  const crossingWeight = finite(context.settings.crossingWeight) ? Math.max(0, context.settings.crossingWeight) : 0.015;
  const cost = wireMetric + 0.15 * connectionMetric +
    congestionWeight * context.diagonal * congestion +
    crossingWeight * context.diagonal * crossings + 2 * decouplingMetric;
  return { wireMetric, connectionMetric, congestion, crossings, decouplingMetric, cost };
}
function copyPositions(positions) { return positions.map(position => ({ x: position.x, y: position.y })); }
function weightedMedian(values) {
  values.sort((a, b) => a.value - b.value);
  const half = values.reduce((sum, item) => sum + item.weight, 0) / 2;
  let running = 0;
  for (const item of values) { running += item.weight; if (running >= half) return item.value; }
  return values.length ? values[values.length - 1].value : 0;
}
function attraction(context, component, positions, placed) {
  const targets = [];
  const seen = new Set();
  for (const pad of component.pads) {
    const net = context.nets.get(pad.net);
    if (!net || !net.weight || seen.has(pad.net)) continue;
    seen.add(pad.net);
    const neighbours = net.points.filter(point => point.component !== component.index &&
      (!placed || placed.has(point.component)));
    for (const neighbour of neighbours) {
      const target = pointOf(positions, neighbour);
      targets.push({ x: target.x - pad.dx, y: target.y - pad.dy,
        weight: net.weight / Math.max(1, neighbours.length) });
    }
  }
  for (const pair of context.decouplers) {
    const endpoint = pair.a.component === component.index ? pair.a : pair.b.component === component.index ? pair.b : null;
    if (!endpoint) continue;
    const other = endpoint === pair.a ? pair.b : pair.a;
    if (placed && !placed.has(other.component)) continue;
    const target = pointOf(positions, other);
    targets.push({ x: target.x - endpoint.dx, y: target.y - endpoint.dy, weight: 3 });
  }
  const desired = targets.length ? { x: weightedMedian(targets.map(target => ({ value: target.x, weight: target.weight }))),
    y: weightedMedian(targets.map(target => ({ value: target.y, weight: target.weight }))) } :
    { x: component.x, y: component.y };
  return { targets, desired };
}
function snap(value, grid) { return Math.round(value / grid) * grid; }

function pack(context, variant = 0) {
  const positions = context.components.map(component => ({ x: component.x, y: component.y }));
  const placed = new Set();
  const spatial = new SpatialIndex(Math.max(2, context.diagonal / Math.max(4, Math.sqrt(positions.length))));
  for (const component of context.components.filter(component => component.fixed)) {
    const rect = rectAt(component, component.x, component.y);
    spatial.add(component.index, rect); placed.add(component.index);
  }
  const degree = component => component.pads.reduce((total, pad) => {
    const net = context.nets.get(pad.net);
    return total + (net && net.weight ? net.weight : 0);
  }, 0);
  const order = context.components.filter(component => !component.fixed).sort((a, b) => {
    if (variant === 1) return degree(b) * Math.sqrt(b.area) - degree(a) * Math.sqrt(a.area) || a.index - b.index;
    if (variant === 2) return Math.max(b.rel.right - b.rel.left, b.rel.top - b.rel.bottom) -
      Math.max(a.rel.right - a.rel.left, a.rel.top - a.rel.bottom) || b.area - a.area || a.index - b.index;
    return b.area - a.area || degree(b) - degree(a) || a.index - b.index;
  });
  const coarse = Math.max(context.grid, Math.ceil(Math.sqrt(polygonArea(context.outline) / 6000) / context.grid) * context.grid);
  for (const component of order) {
    const { desired, targets } = attraction(context, component, positions, placed);
    const minX = Math.ceil((context.bounds.left + context.effectiveMargin - component.rel.left - EPS) / context.grid) * context.grid;
    const maxX = Math.floor((context.bounds.right - context.effectiveMargin - component.rel.right + EPS) / context.grid) * context.grid;
    const minY = Math.ceil((context.bounds.bottom + context.effectiveMargin - component.rel.bottom - EPS) / context.grid) * context.grid;
    const maxY = Math.floor((context.bounds.top - context.effectiveMargin - component.rel.top + EPS) / context.grid) * context.grid;
    if (minX > maxX + EPS || minY > maxY + EPS) return null;
    let best = null, bestScore = Infinity;
    const consider = (x, y, retainExact = false) => {
      x = retainExact ? x : snap(x, context.grid); y = retainExact ? y : snap(y, context.grid);
      if (x < minX - EPS || x > maxX + EPS || y < minY - EPS || y > maxY + EPS) return;
      let score = 0.005 * (Math.abs(x - component.x) + Math.abs(y - component.y));
      if (!targets.length) score += 0.1 * (Math.abs(x - desired.x) + Math.abs(y - desired.y));
      for (const target of targets) score += target.weight * (Math.abs(x - target.x) + Math.abs(y - target.y));
      if (score > bestScore + EPS) return;
      const rect = rectAt(component, x, y);
      if (!domainFits(context, rect) || spatial.hits(rect, context.gap)) return;
      if (score < bestScore - EPS || !best || x < best.x - EPS || (Math.abs(x - best.x) <= EPS && y < best.y - EPS)) {
        best = { x, y }; bestScore = score;
      }
    };
    consider(component.x, component.y, true);
    consider(clamp(desired.x, minX, maxX), clamp(desired.y, minY, maxY));
    for (const index of placed) {
      const other = context.components[index], rect = rectAt(other, positions[index].x, positions[index].y);
      const xLow = rect.left - context.gap - component.rel.right;
      const xHigh = rect.right + context.gap - component.rel.left;
      const yLow = rect.bottom - context.gap - component.rel.top;
      const yHigh = rect.top + context.gap - component.rel.bottom;
      for (const x of [Math.floor(xLow / context.grid) * context.grid, Math.ceil(xHigh / context.grid) * context.grid]) {
        for (const y of [desired.y, yLow, yHigh]) consider(x, clamp(y, minY, maxY));
      }
      for (const y of [Math.floor(yLow / context.grid) * context.grid, Math.ceil(yHigh / context.grid) * context.grid]) {
        consider(clamp(desired.x, minX, maxX), y);
      }
    }
    for (let x = minX; x <= maxX + EPS; x += coarse) {
      for (let y = minY; y <= maxY + EPS; y += coarse) consider(x, y);
      consider(x, maxY);
    }
    for (let y = minY; y <= maxY + EPS; y += coarse) consider(maxX, y);
    consider(maxX, maxY);
    if (best) {
      const anchor = { ...best };
      for (let x = anchor.x - coarse; x <= anchor.x + coarse + EPS; x += context.grid) {
        for (let y = anchor.y - coarse; y <= anchor.y + coarse + EPS; y += context.grid) consider(x, y);
      }
    } else {
      // Narrow channels can disappear at the coarse search spacing. Search the
      // actual placement grid before reporting a bounded-search failure.
      const sites = (Math.floor((maxX - minX) / context.grid) + 1) *
        (Math.floor((maxY - minY) / context.grid) + 1);
      if (sites <= 200000) {
        for (let x = minX; x <= maxX + EPS; x += context.grid) {
          for (let y = minY; y <= maxY + EPS; y += context.grid) consider(x, y);
        }
      }
    }
    if (!best) return null;
    positions[component.index] = best;
    spatial.add(component.index, rectAt(component, best.x, best.y)); placed.add(component.index);
  }
  return positions;
}

function changedFit(context, positions, changed) {
  for (const index of changed) {
    const component = context.components[index];
    const rect = rectAt(component, positions[index].x, positions[index].y);
    if (!domainFits(context, rect)) return false;
    for (const other of context.components) {
      if (index === other.index) continue;
      if (rectOverlap(rect, rectAt(other, positions[other.index].x, positions[other.index].y), context.gap)) return false;
    }
  }
  return true;
}
function refine(context, initial, iterations, seed) {
  const random = randomGenerator(seed);
  const movable = context.components.filter(component => !component.fixed);
  let positions = copyPositions(initial), currentMetric = metrics(context, positions);
  let best = copyPositions(positions), bestMetric = currentMetric;
  let accepted = 0, feasibleTrials = 0;
  if (!movable.length || !iterations) return { positions: best, metrics: bestMetric, accepted, feasibleTrials };
  for (let iteration = 0; iteration < iterations; iteration++) {
    const fraction = iteration / Math.max(1, iterations - 1);
    const component = movable[Math.floor(random() * movable.length)];
    const index = component.index, old = positions[index];
    const changed = [index], saved = [{ index, position: old }];
    const kind = random();
    if (kind < 0.18 && movable.length > 1) {
      const other = movable[Math.floor(random() * movable.length)];
      if (other.index === index) continue;
      changed.push(other.index); saved.push({ index: other.index, position: positions[other.index] });
      positions[index] = { x: snap(positions[other.index].x, context.grid), y: snap(positions[other.index].y, context.grid) };
      positions[other.index] = { x: snap(old.x, context.grid), y: snap(old.y, context.grid) };
    } else if (kind < 0.55) {
      const { desired } = attraction(context, component, positions);
      const jitter = Math.max(context.grid, context.diagonal * 0.08 * Math.pow(1 - fraction, 2));
      positions[index] = { x: snap(desired.x + (random() - 0.5) * jitter, context.grid),
        y: snap(desired.y + (random() - 0.5) * jitter, context.grid) };
    } else {
      const distance = kind > 0.93 ? context.diagonal * 0.4 :
        Math.max(context.grid, context.diagonal * 0.15 * Math.pow(1 - fraction, 2));
      positions[index] = { x: snap(old.x + (random() - 0.5) * 2 * distance, context.grid),
        y: snap(old.y + (random() - 0.5) * 2 * distance, context.grid) };
    }
    if (!changedFit(context, positions, changed)) {
      for (const entry of saved) positions[entry.index] = entry.position;
      continue;
    }
    feasibleTrials++;
    const nextMetric = metrics(context, positions);
    const temperature = Math.max(0.001, currentMetric.cost * 0.012 * Math.pow(1 - fraction, 3));
    if (nextMetric.cost <= currentMetric.cost || random() < Math.exp((currentMetric.cost - nextMetric.cost) / temperature)) {
      currentMetric = nextMetric; accepted++;
      if (nextMetric.cost < bestMetric.cost - EPS) {
        bestMetric = nextMetric; best = copyPositions(positions);
      }
    } else {
      for (const entry of saved) positions[entry.index] = entry.position;
    }
  }
  return { positions: best, metrics: bestMetric, accepted, feasibleTrials };
}

function placeBoard(board, options = {}) {
  const input = options && Object.keys(options).length ? { ...board, settings: { ...board.settings, ...options } } : board;
  const context = prepare(input);
  const original = context.components.map(component => ({ x: component.x, y: component.y }));
  const before = metrics(context, original), originalViolation = violation(context, original);
  const fixed = context.components.filter(component => component.fixed);
  const warnings = fixedWarnings(context);
  const availableArea = polygonArea(context.outline) - context.cutouts.reduce((sum, cutout) => sum + polygonArea(cutout), 0);
  const componentArea = context.components.reduce((sum, component) => sum + component.area, 0);
  const movableArea = context.components.filter(component => !component.fixed)
    .reduce((sum, component) => sum + component.area, 0);
  if (movableArea > availableArea + EPS) {
    throw new PlacementError('INSUFFICIENT_AREA', 'Movable component body area exceeds the available board area.',
      { componentArea, movableArea, availableArea });
  }
  let initial = originalViolation ? null : copyPositions(original);
  let initialMetric = initial ? before : null;
  const movableCount = context.components.length - fixed.length;
  if (movableCount && context.settings.repack !== false) {
    const attempts = originalViolation ? 3 : 1;
    for (let variant = 0; variant < attempts; variant++) {
      const packed = pack(context, variant);
      if (!packed) continue;
      const packedMetric = metrics(context, packed);
      if (!initial || packedMetric.cost < initialMetric.cost - EPS) {
        initial = packed; initialMetric = packedMetric;
      }
      if (originalViolation) break;
    }
  }
  if (!initial) {
    throw new PlacementError('NO_FEASIBLE_PLACEMENT',
      'No collision-free placement was found within the search budget. Increase the placement region or reduce component gap/edge margin.',
      { originalViolation, componentArea, availableArea });
  }
  const iterations = context.settings.placementIterations === undefined ? 5000 : Number(context.settings.placementIterations);
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 50000) {
    throw new PlacementError('INVALID_SETTINGS', 'placementIterations must be an integer between 0 and 50000.');
  }
  const seed = context.settings.seed === undefined ? 16 : context.settings.seed;
  const optimized = refine(context, initial, iterations, seed);
  const finalViolation = violation(context, optimized.positions);
  if (finalViolation) {
    throw new PlacementError('INTERNAL_PLACEMENT_VALIDATION', 'The placement plan failed its final geometry check.', finalViolation);
  }
  const moves = [], components = context.components.map(component => {
    const source = clone(component.source), position = optimized.positions[component.index];
    const dx = position.x - component.x, dy = position.y - component.y;
    source.x = position.x; source.y = position.y;
    source.bounds = { left: source.bounds.left + dx, bottom: source.bounds.bottom + dy,
      right: source.bounds.right + dx, top: source.bounds.top + dy };
    source.pads = (source.pads || []).map(pad => ({ ...pad, x: pad.x + dx, y: pad.y + dy }));
    if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
      moves.push({ id: source.id, x: source.x, y: source.y, rotation: source.rotation === undefined ? 0 : source.rotation });
    }
    return source;
  });
  return { components, moves, stats: {
    componentCount: components.length, movableCount, lockedCount: fixed.length,
    routeProtectedCount: context.components.filter(component => component.routeProtected).length,
    unknownRoutingProtectedAll: !!context.hasUnknownRoutes, movedCount: moves.length,
    activeNetCount: context.activeNets.length, decouplerHeuristicCount: context.decouplers.length,
    wireMetricBefore: before.wireMetric, wireMetricAfter: optimized.metrics.wireMetric,
    wireMetricUnits: 'weighted HPWL, mm', costBefore: before.cost, costAfter: optimized.metrics.cost,
    congestionBefore: before.congestion, congestionAfter: optimized.metrics.congestion,
    crossingsBefore: before.crossings, crossingsAfter: optimized.metrics.crossings,
    originalFeasible: !originalViolation, iterations, feasibleTrials: optimized.feasibleTrials,
    acceptedTrials: optimized.accepted, seed, rotationPolicy: 'preserve exported component rotations',
    geometryValidated: true, componentGap: context.gap, edgeMargin: context.margin,
    outlineTolerance: context.outlineTolerance, existingFixedViolationCount: warnings.length,
    warnings: warnings.slice(0, 100)
  } };
}

function validatePlacement(board) {
  const context = prepare(board);
  const positions = context.components.map(component => ({ x: component.x, y: component.y }));
  const failure = violation(context, positions);
  return failure ? { valid: false, ...failure } : { valid: true, warnings: fixedWarnings(context) };
}
function wireMetrics(board) {
  const context = prepare(board);
  return metrics(context, context.components.map(component => ({ x: component.x, y: component.y })));
}

module.exports = { placeBoard, optimizePlacement: placeBoard, PlacementError, validatePlacement, wireMetrics };
