// The story graph. Pure: no DOM, so it's tested in Node.
//
// A story is a list of nodes. Each node has a title, a text, and its parent
// (the node it's reached from). The choices at a node are the nodes whose
// parent is that node, offered by their titles. A node with no parent is the
// start. `parent` may also be a list, so two paths can lead to the same node
// (a DAG, not just a tree).
//
//   { "title": "…", "start": "id", "nodes": [
//       { "id": "beach", "title": "Walk down to the beach", "text": "…",
//         "parent": "start", "aliases": ["beach", "the shore"] } ] }
//
// `aliases` are optional extra ways to say a choice out loud.

export function parentsOf(node) {
    if (node.parent == null || node.parent === '') return [];
    return Array.isArray(node.parent) ? node.parent : [node.parent];
}

// Checks a story and returns { story, errors }. `story` has the extra lookups
// the app uses: byId and children (id -> ordered child ids).
export function loadStory(data) {
    const errors = [];
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    if (nodes.length === 0) errors.push('The story has no nodes.');

    const byId = new Map();
    for (const [i, node] of nodes.entries()) {
        const where = `Node ${i + 1}${node?.id ? ` (${node.id})` : ''}`;
        if (!node || typeof node.id !== 'string' || !node.id) {
            errors.push(`${where}: needs an "id".`);
            continue;
        }
        if (byId.has(node.id)) {
            errors.push(`${where}: the id is used twice.`);
            continue;  // keep the first
        }
        if (typeof node.title !== 'string' || !node.title.trim()) errors.push(`${where}: needs a "title".`);
        byId.set(node.id, {
            id: node.id,
            title: String(node.title ?? '').trim(),
            text: String(node.text ?? '').trim(),
            parents: parentsOf(node),
            aliases: Array.isArray(node.aliases) ? node.aliases.map(String) : [],
        });
    }

    const children = new Map([...byId.keys()].map(id => [id, []]));
    for (const node of byId.values()) {
        for (const parent of node.parents) {
            if (!byId.has(parent)) errors.push(`${node.id}: parent "${parent}" doesn't exist.`);
            else children.get(parent).push(node.id);
        }
    }

    const roots = [...byId.values()].filter(n => n.parents.length === 0).map(n => n.id);
    const start = data?.start ?? roots[0];
    if (!byId.has(start)) errors.push(data?.start ? `The start node "${data.start}" doesn't exist.` : 'No start node: every node has a parent.');
    if (hasCycle(byId, children)) errors.push('The story loops back on itself; it must only go forward.');

    return {
        errors,
        story: {
            title: String(data?.title ?? 'Untitled story'),
            start,
            byId,
            children,
            roots,
        },
    };
}

function hasCycle(byId, children) {
    const state = new Map();  // id -> 1 visiting, 2 done
    const visit = (id) => {
        if (state.get(id) === 1) return true;
        if (state.get(id) === 2) return false;
        state.set(id, 1);
        for (const child of children.get(id) ?? []) if (visit(child)) return true;
        state.set(id, 2);
        return false;
    };
    return [...byId.keys()].some(visit);
}

// The choices at a node: its children, in story order.
export function choicesOf(story, id) {
    return (story.children.get(id) ?? []).map(childId => story.byId.get(childId));
}

export const isEnding = (story, id) => (story.children.get(id) ?? []).length === 0;
