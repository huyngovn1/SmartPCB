'use strict';

const fs = require('fs');
const path = require('path');
const { placeBoard, PlacementError } = require('./placer');
const { routeBoard, validateRouting } = require('./router');

const VERSION = '3.0';
const DEFAULT_SETTINGS = {
  grid: 0.15, componentGap: 0.5, edgeMargin: 0.5, routingEdgeMargin: 0.15,
  outlineTolerance: 0.01, geometryTolerance: 0.01, placementIterations: 8000, seed: 16,
  viaPenalty: 8, bendPenalty: 0.08, routingPasses: 2,
  maxExpansions: 80000, maxCells: 2000000, endpointSearchCells: 4,
  anchorConnectors: true, mode: 'place-and-route'
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function number(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid number: ' + label);
  return v;
}
function angularDistance(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

// Preserve the native outline order. AD arc angles describe a CCW arc; a
// contour can traverse that arc in either direction. Verify both endpoints.
function flattenOutline(segments, tolerance = 0.005) {
  if (!Array.isArray(segments) || segments.length < 3) throw new Error('Missing board outline.');
  const result = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i], next = segments[(i + 1) % segments.length];
    const start = { x: number(seg.x, 'outline x'), y: number(seg.y, 'outline y') };
    result.push(start);
    if (seg.kind === 'line' || seg.kind === 0) continue;
    if (seg.kind !== 'arc' && seg.kind !== 1) throw new Error('Unsupported outline segment.');
    const cx = number(seg.cx, 'arc cx'), cy = number(seg.cy, 'arc cy');
    const radius = number(seg.radius, 'arc radius');
    if (radius <= 0) throw new Error('Invalid outline arc radius.');
    const a1 = number(seg.angle1, 'arc angle1') * Math.PI / 180;
    const a2 = number(seg.angle2, 'arc angle2') * Math.PI / 180;
    const actualStart = Math.atan2(start.y - cy, start.x - cx);
    const actualEnd = Math.atan2(next.y - cy, next.x - cx);
    const angleTolerance = Math.max(0.0001, tolerance * 4 / radius);
    let delta = ((a2 - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    let base = a1;
    if (angularDistance(actualStart, a1) <= angleTolerance &&
        angularDistance(actualEnd, a2) <= angleTolerance) {
      base = actualStart;
    } else if (angularDistance(actualStart, a2) <= angleTolerance &&
               angularDistance(actualEnd, a1) <= angleTolerance) {
      base = actualStart; delta = -delta;
    } else {
      throw new Error('Outline arc endpoints do not match the exported angle fields.');
    }
    if (Math.abs(Math.hypot(start.x - cx, start.y - cy) - radius) > tolerance * 4 ||
        Math.abs(Math.hypot(next.x - cx, next.y - cy) - radius) > tolerance * 4)
      throw new Error('Outline arc radius does not match its vertices.');
    const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / radius)));
    const count = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(1e-5, maxStep)));
    if (count > 10000) throw new Error('Outline arc subdivision limit.');
    for (let j = 1; j < count; j++) {
      const a = base + delta * j / count;
      result.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    }
  }
  return result;
}

function normalizeBoard(input, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config must be a JSON object.');
  if (config.manualNets !== undefined && (!Array.isArray(config.manualNets) || config.manualNets.some(n => typeof n !== 'string' || !n)))
    throw new Error('config.manualNets must be an array of net names.');
  const board = clone(input);
  if (board.schemaVersion && board.schemaVersion !== 3) throw new Error('Unsupported exchange schema.');
  board.settings = { ...DEFAULT_SETTINGS, ...(config.settings || {}), ...(board.settings || {}) };
  if (!['place-and-route', 'route-only'].includes(board.settings.mode)) throw new Error('Unsupported settings.mode.');
  if (board.outlineSegments) board.outline = flattenOutline(board.outlineSegments, 0.005);
  if (!board.outline || board.outline.length < 3) throw new Error('A real board outline is required.');
  board.bounds = {
    left: Math.min(...board.outline.map(p => p.x)), bottom: Math.min(...board.outline.map(p => p.y)),
    right: Math.max(...board.outline.map(p => p.x)), top: Math.max(...board.outline.map(p => p.y))
  };
  if (!Array.isArray(board.components) || board.components.length > 2048) throw new Error('Component count limit: 2048.');
  const ids = new Set();
  const indices = new Set();
  for (let i = 0; i < board.components.length; i++) {
    const c = board.components[i];
    if (!c.id || ids.has(c.id)) throw new Error('Missing or duplicate component designator.');
    ids.add(c.id);
    c.index = c.index === undefined ? i : c.index;
    if (!Number.isInteger(c.index) || c.index < 0 || indices.has(c.index)) throw new Error('Invalid or duplicate native component index.');
    indices.add(c.index);
    number(c.x, c.id + ' x'); number(c.y, c.id + ' y');
    c.rotation = c.rotation === undefined ? 0 : number(c.rotation, c.id + ' rotation');
    c.pads = c.pads || [];
    if (board.settings.anchorConnectors && /^(?:J|P|CN|H|MH|TP)\d/i.test(c.id)) {
      c.locked = true; c.lockReason = 'Connector, mounting hole or test point anchor';
    }
  }
  const netNames = board.netNames || Object.keys((board.rules || {}).nets || {});
  if (netNames.length > 8192 || new Set(netNames).size !== netNames.length) throw new Error('Invalid net index table.');
  board.netNames = netNames;
  board.tracks = board.tracks || []; board.vias = board.vias || [];
  board.keepouts = board.keepouts || []; board.cutouts = board.cutouts || [];
  const protectedNets = new Set(board.protectedNets || []);
  board.rules = board.rules || { default: {}, nets: {} };
  board.rules.nets = board.rules.nets || {};
  for (const net of protectedNets) board.rules.nets[net] = {
    ...(board.rules.nets[net] || {}),
    unsupportedReason: (board.rules.nets[net] || {}).unsupportedReason || 'Existing copper or pad geometry requires manual routing'
  };
  for (const c of board.components) {
    if (c.pads.some(p => protectedNets.has(p.net))) { c.locked = true; c.lockReason = 'Unsupported existing copper on incident net'; }
  }
  if (config.manualNets) {
    board.rules = board.rules || { default: {}, nets: {} }; board.rules.nets = board.rules.nets || {};
    for (const net of config.manualNets) board.rules.nets[net] = {
      ...(board.rules.nets[net] || {}), unsupportedReason: 'Net reserved for manual/critical routing in config.json'
    };
  }
  for (const [net, priority] of Object.entries(config.routingPriorities || {})) {
    if (!Number.isFinite(priority)) throw new Error('Invalid routing priority: ' + net);
    board.rules.nets[net] = { ...(board.rules.nets[net] || {}), priority };
  }
  return board;
}

function validateNativePlan(original, placed, routed) {
  const before = new Map(original.components.map(c => [c.id, c]));
  if (!Array.isArray(placed.components) || placed.components.length !== before.size) throw new Error('Plan component count does not match source.');
  const seen = new Set(), after = new Map();
  const routedNets = new Set([...(original.tracks || []), ...(original.vias || [])].map(t => t.net).filter(Boolean));
  const unknownCopper = [...(original.tracks || []), ...(original.vias || [])].some(t => !t.net);
  const epsilon = 1e-7;
  for (const c of placed.components) {
    const old = before.get(c.id);
    if (!old || seen.has(c.id)) throw new Error('Plan contains an unknown or duplicate component.');
    seen.add(c.id); after.set(c.id, c);
    if (c.index !== old.index) throw new Error('Plan changed native component identity.');
    const fixed = old.locked || unknownCopper || old.pads.some(p => routedNets.has(p.net));
    if (fixed && (c.x !== old.x || c.y !== old.y || c.rotation !== old.rotation))
      throw new Error('Plan moved a locked component: ' + c.id);
    if (Math.abs(c.rotation - old.rotation) > 1e-8) throw new Error('Native adapter does not support planned rotations.');
    // AD16 coordinates: 0..99999 mil; preserve the footprint anchor too.
    number(c.x, 'planned x'); number(c.y, 'planned y'); number(c.rotation, 'planned rotation');
    if (c.x < 0 || c.y < 0 || c.x > 2539.9746 || c.y > 2539.9746)
      throw new Error('Planned component anchor outside Altium coordinate range.');
    const dx = c.x - old.x, dy = c.y - old.y;
    for (const key of ['left', 'right', 'bottom', 'top']) {
      const translated = number(old.bounds[key], 'source component bounds') + (key === 'left' || key === 'right' ? dx : dy);
      if (Math.abs(number(c.bounds[key], 'planned component bounds') - translated) > epsilon)
        throw new Error('Plan component bounds do not match native translation: ' + c.id);
    }
    if (!Array.isArray(c.pads) || c.pads.length !== old.pads.length) throw new Error('Plan pad count does not match native footprint.');
    for (let j = 0; j < c.pads.length; j++) {
      const p = c.pads[j], source = old.pads[j];
      for (const key of ['id', 'net', 'layer', 'width', 'height', 'shape', 'cornerRadius', 'rotation', 'throughHole'])
        if (p[key] !== source[key]) throw new Error('Plan pad identity or geometry changed: ' + c.id);
      if (Math.abs(number(p.x, 'planned pad x') - number(source.x, 'source pad x') - dx) > epsilon ||
          Math.abs(number(p.y, 'planned pad y') - number(source.y, 'source pad y') - dy) > epsilon)
        throw new Error('Plan pad position does not match native component translation: ' + c.id);
    }
  }
  if (!Array.isArray(placed.moves)) throw new Error('Plan moves must be an array.');
  const moved = new Set();
  for (const m of placed.moves) {
    const canonical = after.get(m.id);
    if (!canonical || moved.has(m.id)) throw new Error('Plan contains an unknown or duplicate move.');
    moved.add(m.id);
    for (const key of ['x', 'y', 'rotation'])
      if (Math.abs(number(m[key], 'move ' + key) - canonical[key]) > epsilon)
        throw new Error('Plan move does not match canonical component geometry.');
    const old = before.get(m.id);
    if (old.locked) throw new Error('Plan contains a move for a locked component.');
  }
  for (const c of placed.components) {
    const old = before.get(c.id);
    if ((Math.abs(c.x - old.x) > epsilon || Math.abs(c.y - old.y) > epsilon) && !moved.has(c.id))
      throw new Error('Plan is missing a native component move.');
  }
  const routingBoard = { ...original, components: placed.components };
  const validation = validateRouting(routingBoard, routed);
  if (!validation.ok) throw new Error('Routing validation failed: ' + validation.errors.join('; '));
}

function createImportPlan(original, placed, routed) {
  const nets = new Map(original.netNames.map((n, i) => [n, i]));
  const rows = ['SMARTPCB\t3\t' + placed.moves.length + '\t' + routed.tracks.length + '\t' + routed.vias.length];
  const f = v => number(v, 'import coordinate').toFixed(8);
  const byId = new Map(original.components.map(c => [c.id, c]));
  for (const m of placed.moves) {
    const old = byId.get(m.id);
    rows.push(['COMP', old.index, f(old.x), f(old.y), f(old.rotation), f(m.x), f(m.y), f(m.rotation)].join('\t'));
  }
  for (const t of routed.tracks) {
    if (!nets.has(t.net)) throw new Error('New track net missing from native net table.');
    rows.push(['TRACK', nets.get(t.net), t.layer, f(t.width), f(t.x1), f(t.y1), f(t.x2), f(t.y2)].join('\t'));
  }
  const throughLow = original.throughViaLow === undefined ? Math.min(...original.layers.map(l => Number(l.id))) : original.throughViaLow;
  const throughHigh = original.throughViaHigh === undefined ? Math.max(...original.layers.map(l => Number(l.id))) : original.throughViaHigh;
  for (const v of routed.vias) {
    if (!nets.has(v.net)) throw new Error('New via net missing from native net table.');
    rows.push(['VIA', nets.get(v.net), f(v.x), f(v.y), f(v.diameter), f(v.hole), throughLow, throughHigh].join('\t'));
  }
  rows.push(['END', routed.stats.routedPairs, routed.stats.totalPairs, routed.stats.completionPercent].join('\t'));
  return rows.join('\r\n') + '\r\n';
}

function esc(v) { return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function svgBoard(board, extraTracks = [], extraVias = []) {
  const b = board.bounds, pad = 3, w = b.right - b.left, h = b.top - b.bottom;
  const x = v => (v - b.left + pad).toFixed(3), y = v => (b.top - v + pad).toFixed(3);
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w + pad * 2} ${h + pad * 2}" role="img" aria-label="PCB plan">`;
  out += '<rect width="100%" height="100%" fill="#101a22"/>';
  out += `<polygon points="${board.outline.map(p => x(p.x) + ',' + y(p.y)).join(' ')}" fill="#182d33" stroke="#6aa5a0" stroke-width="0.2"/>`;
  for (const cutout of board.cutouts) {
    const points = Array.isArray(cutout) ? cutout : cutout.outline || cutout.points;
    out += `<polygon points="${points.map(p => x(p.x) + ',' + y(p.y)).join(' ')}" fill="#101a22" stroke="#6aa5a0" stroke-width="0.2"/>`;
  }
  for (const ko of board.keepouts) if (ko.bounds) out += `<rect x="${x(ko.bounds.left)}" y="${y(ko.bounds.top)}" width="${ko.bounds.right - ko.bounds.left}" height="${ko.bounds.top - ko.bounds.bottom}" fill="#973f5955" stroke="#cb7796" stroke-width="0.08"/>`;
  for (const t of [...board.tracks, ...extraTracks]) {
    const color = String(t.layer) === String(board.layers[0].id) ? '#fc776b' : '#63a3ff';
    out += `<line data-layer="${esc(t.layer)}" x1="${x(t.x1)}" y1="${y(t.y1)}" x2="${x(t.x2)}" y2="${y(t.y2)}" stroke="${color}" stroke-width="${t.width}" stroke-linecap="round"><title>${esc(t.net)} / ${t.width} mm</title></line>`;
  }
  for (const c of board.components) {
    const r = c.bounds;
    out += `<rect x="${x(r.left)}" y="${y(r.top)}" width="${r.right - r.left}" height="${r.top - r.bottom}" fill="none" stroke="${c.locked ? '#efc878' : '#cbd9de'}" stroke-width="0.1"/>`;
    out += `<text x="${x((r.left + r.right) / 2)}" y="${y(r.top) - 0.25}" text-anchor="middle" fill="#d9e7ee" font-size="0.9">${esc(c.id)}</text>`;
    for (const p of c.pads) out += `<rect ${p.throughHole ? '' : 'data-layer="' + esc(p.layer) + '"'} x="${x(p.x - p.width / 2)}" y="${y(p.y + p.height / 2)}" width="${p.width}" height="${p.height}" rx="${p.shape === 'round' ? Math.min(p.width, p.height) / 2 : p.shape === 'roundrect' ? p.cornerRadius : 0}" transform="rotate(${-(p.rotation || 0)} ${x(p.x)} ${y(p.y)})" fill="#debd66"><title>${esc(c.id + '-' + p.id + ' ' + p.net)}</title></rect>`;
  }
  for (const v of [...board.vias, ...extraVias]) out += `<circle cx="${x(v.x)}" cy="${y(v.y)}" r="${v.diameter / 2}" fill="#78daca"/><circle cx="${x(v.x)}" cy="${y(v.y)}" r="${v.hole / 2}" fill="#101a22"/>`;
  return out + '</svg>';
}

function reportHTML(board, result) {
  const rows = result.routing.unrouted.map(r => `<tr><td>${esc(r.net)}</td><td>${esc(r.from || '')}</td><td>${esc(r.to || '')}</td><td>${esc(r.reason)}</td></tr>`).join('');
  const rs = result.routing.stats, ps = result.placement.stats;
  const sourcePath = board.sourcePath || board.sourceFile || '';
  const metric = `Di chuyển ${ps.movedCount || 0} linh kiện · xử lý ${rs.routedPairs}/${rs.totalPairs} hạng mục kết nối/kiểm tra · thêm ${result.routing.vias.length} via · đường mới ${Number(rs.totalWireLength || 0).toFixed(2)} mm.`;
  const scope = rs.manualNetCount ? `Có ${rs.manualNetCount} net cần xử lý riêng. Tổng hạng mục gồm nối các nhóm đồng rời nhau và kiểm tra net chưa hỗ trợ; đây không phải phần trăm hoàn tất PCB của Altium.` : 'Số kết nối đếm các lần nối nhóm đồng rời nhau trong mô hình hỗ trợ; đây không phải phần trăm hoàn tất PCB của Altium.';
  const options = board.layers.map(l => `<option value="${esc(l.id)}">${esc(l.name || l.id)}</option>`).join('');
  const existing = ps.existingFixedViolationCount ? `<p>Có ${ps.existingFixedViolationCount} trường hợp vị trí cố định đang vượt vùng đặt hoặc thiếu khoảng cách. Tool giữ các vị trí đó; chi tiết ở chỉ số bố trí.</p>` : '';
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SmartPCB ${VERSION}</title><style>
body{font:16px system-ui;background:#101820;color:#d9e7ee;margin:30px;max-width:1300px}h1{font-size:28px}p{line-height:1.6}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:20px}.cards svg{width:100%;max-height:650px}
table{border-collapse:collapse;width:100%}td,th{padding:9px;text-align:left;border-bottom:1px solid #3b4c58}
.metric{font-weight:600;color:#8bd6c7}.note{color:#adbdc7}select{font:inherit;padding:6px;background:#182d33;color:#d9e7ee;border:1px solid #6aa5a0}pre{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:750px){.cards{grid-template-columns:1fr}body{margin:15px}}
</style></head><body>
<h1>SmartPCB ${VERSION} — phương án tự động</h1>
<p class="metric">${metric}</p><p class="note">${scope}</p>
<p class="note">Báo cáo là phương án hình học. Cần kiểm tra DRC và yêu cầu điện, timing, trở kháng trong Altium. ${sourcePath ? 'Nguồn: ' + esc(sourcePath) : ''}</p>
${existing}
<label>Xem đồng trên lớp: <select id="layer"><option value="">Tất cả lớp tín hiệu</option>${options}</select></label>
<div class="cards"><div><h2>Trước</h2>${svgBoard(board)}</div><div><h2>Sau</h2>${svgBoard({ ...board, components: result.placement.components }, result.routing.tracks, result.routing.vias)}</div></div>
<h2>Kết nối còn lại (${result.routing.unrouted.length})</h2>
<table><thead><tr><th>Net</th><th>Từ</th><th>Đến</th><th>Lý do</th></tr></thead><tbody>${rows || '<tr><td colspan="4">Không còn nhóm kết nối trong mô hình hỗ trợ.</td></tr>'}</tbody></table>
<details><summary>Chỉ số bố trí</summary><pre>${esc(JSON.stringify(ps, null, 2))}</pre></details>
<details><summary>Chỉ số đi dây</summary><pre>${esc(JSON.stringify(rs, null, 2))}</pre></details>
<script>document.getElementById('layer').addEventListener('change',function(){const value=this.value;document.querySelectorAll('[data-layer]').forEach(e=>e.style.display=!value||e.getAttribute('data-layer')===value?'':'none')});</script>
</body></html>`;
}

function solve(input, config = {}) {
  const board = normalizeBoard(input, config);
  let placement;
  if (board.settings.mode === 'route-only') {
    placement = { components: clone(board.components), moves: [], stats: { movedCount: 0, mode: 'route-only' } };
  } else {
    try { placement = placeBoard(board); }
    catch (error) {
      // Keep an already feasible placement and refine it if full repacking fails.
      if (!(error instanceof PlacementError) || error.code === 'INVALID_INPUT') throw error;
      placement = placeBoard({ ...board, settings: { ...board.settings, repack: false } });
      placement.stats.repackFallback = error.message;
    }
  }
  const placedBoard = { ...board, components: placement.components };
  const routing = routeBoard(placedBoard);
  if (routing.stats.error) throw new Error(routing.stats.error);
  validateNativePlan(board, placement, routing);
  return { version: VERSION, board, placement, routing };
}

function runCLI(inputFile, outputDirectory, configFile) {
  const output = path.resolve(outputDirectory || path.dirname(inputFile));
  fs.mkdirSync(output, { recursive: true });
  // A reused directory must never expose a stale successful completion.
  fs.rmSync(path.join(output, 'done.txt'), { force: true });
  const complete = content => {
    // Publish atomically: a polling AD script must not observe an empty file
    // between create/open and write, or a half-written completion line.
    const temporary = path.join(output, '.completion.tmp');
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, path.join(output, 'done.txt'));
  };
  try {
    const config = configFile ? JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) : {};
    const input = JSON.parse(fs.readFileSync(inputFile, 'utf8').replace(/^\uFEFF/, ''));
    const result = solve(input, config);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ...result, board: undefined }, null, 2));
    fs.writeFileSync(path.join(output, 'report.html'), reportHTML(result.board, result));
    fs.writeFileSync(path.join(output, 'plan.svg'), svgBoard({ ...result.board, components: result.placement.components }, result.routing.tracks, result.routing.vias));
    fs.writeFileSync(path.join(output, 'import.tsv'), createImportPlan(result.board, result.placement, result.routing), 'ascii');
    // Sentinel is last; AD must never import a partly written plan.
    complete('OK\n' + result.routing.stats.completionPercent + '\n' + result.routing.unrouted.length + '\n');
    return result;
  } catch (error) {
    fs.writeFileSync(path.join(output, 'error.txt'), String(error.stack || error));
    complete('ERROR\n' + error.message.replace(/[\r\n]+/g, ' ') + '\n');
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) {
  const [, , input, output, config] = process.argv;
  if (!input) { process.stderr.write('Usage: node smartpcb.js input.json [output-directory] [config.json]\n'); process.exitCode = 2; }
  else runCLI(path.resolve(input), output, config);
}
module.exports = { solve, normalizeBoard, flattenOutline, createImportPlan, validateNativePlan, runCLI, svgBoard };
