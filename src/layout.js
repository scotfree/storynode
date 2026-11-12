// Lays the story graph out top to bottom for the map. Pure.
//
// Each node's row is its longest path from a start node, so every edge points
// down. Within a row, nodes sit under the average position of their parents,
// which keeps edges short and mostly uncrossed for story-sized graphs.

export function layoutGraph(story, { nodeWidth = 180, nodeHeight = 48, gapX = 28, gapY = 64, pad = 24 } = {}) {
    const ids = [...story.byId.keys()];

    // Rows: longest path from a root (Kahn's algorithm in topological order).
    const row = new Map(ids.map(id => [id, 0]));
    const indegree = new Map(ids.map(id => [id, story.byId.get(id).parents.filter(p => story.byId.has(p)).length]));
    const queue = ids.filter(id => indegree.get(id) === 0);
    const topo = [];
    while (queue.length) {
        const id = queue.shift();
        topo.push(id);
        for (const child of story.children.get(id) ?? []) {
            row.set(child, Math.max(row.get(child), row.get(id) + 1));
            indegree.set(child, indegree.get(child) - 1);
            if (indegree.get(child) === 0) queue.push(child);
        }
    }

    // Order within rows: story order first, then by the parents' average slot.
    const rows = [];
    for (const id of topo) (rows[row.get(id)] ??= []).push(id);
    const slot = new Map();
    rows.forEach((r, depth) => {
        if (depth > 0) {
            const key = (id) => {
                const ps = story.byId.get(id).parents.filter(p => slot.has(p));
                return ps.length ? ps.reduce((sum, p) => sum + slot.get(p), 0) / ps.length : 0;
            };
            r.sort((a, b) => key(a) - key(b));
        }
        r.forEach((id, i) => slot.set(id, i - (r.length - 1) / 2));
    });

    const widest = Math.max(1, ...rows.map(r => r.length));
    const width = widest * nodeWidth + (widest - 1) * gapX + pad * 2;
    const height = rows.length * nodeHeight + Math.max(0, rows.length - 1) * gapY + pad * 2;

    const nodes = [];
    const at = new Map();
    rows.forEach((r, depth) => {
        r.forEach((id, i) => {
            const rowWidth = r.length * nodeWidth + (r.length - 1) * gapX;
            const x = (width - rowWidth) / 2 + i * (nodeWidth + gapX);
            const y = pad + depth * (nodeHeight + gapY);
            const box = { id, title: story.byId.get(id).title, x, y, w: nodeWidth, h: nodeHeight, row: depth };
            nodes.push(box);
            at.set(id, box);
        });
    });

    const edges = [];
    for (const node of nodes) {
        for (const childId of story.children.get(node.id) ?? []) {
            const child = at.get(childId);
            if (!child) continue;
            edges.push({
                from: node.id,
                to: childId,
                x1: node.x + node.w / 2, y1: node.y + node.h,
                x2: child.x + child.w / 2, y2: child.y,
            });
        }
    }

    return { nodes, edges, width, height };
}

// --- fisheye ---
//
// A Cartesian fisheye spreads the map across a fixed area and magnifies it
// around a focus point, squeezing everything else towards the edges. Each axis
// is distorted on its own, so rows stay straight and columns stay upright.

// One axis: moves v (between lo and hi) away from `focus` by distortion d.
// lo, hi and focus stay where they are; the scale at the focus is d + 1.
export function fisheyeAxis(v, focus, lo, hi, d) {
    if (d <= 0 || v === focus) return v;
    const edge = v > focus ? hi : lo;
    const span = edge - focus;
    if (span === 0) return v;
    const t = (v - focus) / span;           // 0 at the focus, 1 at the edge
    return focus + span * ((d + 1) * t) / (d * t + 1);
}

// Fits `layout` into width × height and distorts it around `focus` (a point in
// layout coordinates). A map that already fits isn't distorted. Otherwise the
// magnification at the focus is set so the box there is about `focusScale`
// times its normal size. Returns boxes and edges in screen pixels, with the
// font size and the number of title letters that fit each box.
export function fisheyeLayout(layout, { width, height, focus, focusScale = 1.1, font = 12.5, letterWidth = 0.62 }) {
    const box0 = layout.nodes[0] ?? { w: 1, h: 1 };
    const axis = (size, space, at) => {
        const scale = Math.min(1, space / size);
        const offset = (space - size * scale) / 2;
        const d = scale >= 1 ? 0 : Math.min(8, Math.max(0, focusScale / scale - 1));
        const lo = offset;
        const hi = offset + size * scale;
        const f = Math.min(hi, Math.max(lo, offset + at * scale));
        return (v) => fisheyeAxis(offset + v * scale, f, lo, hi, d);
    };
    const fx = axis(layout.width, width, focus.x);
    const fy = axis(layout.height, height, focus.y);

    const boxes = new Map();
    for (const n of layout.nodes) {
        const x = fx(n.x);
        const y = fy(n.y);
        const w = fx(n.x + n.w) - x;
        const h = fy(n.y + n.h) - y;
        const size = font * Math.min(h / n.h, (w / n.w) * 1.4);
        boxes.set(n.id, { id: n.id, x, y, w, h, font: size, letters: Math.max(0, Math.floor((w - 10) / (size * letterWidth))) });
    }
    const edges = layout.edges.map(({ from, to }) => {
        const a = boxes.get(from);
        const b = boxes.get(to);
        return { from, to, x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y };
    });
    return { boxes, edges, width, height };
}

// --- zoom ---

// The zoom range for a map in a viewport: down to fitting it whole (never
// above actual size), up to a fixed maximum.
export function zoomRange(layout, viewWidth, viewHeight, max = 2.5) {
    const fit = Math.min(viewWidth / layout.width, viewHeight / layout.height);
    return { min: Math.min(1, fit), max };
}

export const clampZoom = (zoom, { min, max }) => Math.min(max, Math.max(min, zoom));

// Scroll position after zooming from `zoom` to `next` so that the content under
// (x, y), measured from the viewport's top left, stays under it.
export function zoomAround({ zoom, scrollLeft, scrollTop }, next, x, y) {
    return {
        scrollLeft: Math.max(0, ((scrollLeft + x) / zoom) * next - x),
        scrollTop: Math.max(0, ((scrollTop + y) / zoom) * next - y),
    };
}
