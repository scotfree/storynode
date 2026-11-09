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
