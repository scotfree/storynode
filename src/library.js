// The set of stories you can pick from. Pure.
//
// Built-in stories are the JSON files named in stories/index.json. Stories
// made, opened or changed in this browser are kept in localStorage, keyed by
// id; one with a built-in's id is that story with your additions.

import { idFor } from './story.js';

export const NEW_STORY_LABEL = 'New story';

// A new story is made just like a new node: a title and some text. They
// become its first page, which doubles as the jacket cover.
export function createStory({ title, text }, takenIds = []) {
    const errors = [];
    title = String(title ?? '').trim();
    text = String(text ?? '').trim();
    if (!title) errors.push('The story needs a title.');
    if (!text) errors.push('The story needs an overview.');
    if (errors.length) return { id: null, data: null, errors };
    return {
        id: idFor(title, takenIds),
        data: { title, start: 'start', nodes: [{ id: 'start', title, text }] },
        errors,
    };
}

const titleOf = (data, id) => String(data?.title ?? '').trim() || id;

// The jacket cover: an "overview" if the file has one, else the first page's text.
export function overviewOf(data) {
    if (typeof data?.overview === 'string' && data.overview.trim()) return data.overview.trim();
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const start = nodes.find(n => n?.id === data?.start) ?? nodes.find(n => n && (n.parent == null || n.parent === ''));
    return String(start?.text ?? '').trim();
}

// builtIn: [{ id, data }] in index order. local: { id: data }.
// Returns [{ id, title, data, source }], built-ins first, then yours by title.
// source: 'builtin', 'edited' (a built-in you've added to) or 'local'.
export function listStories(builtIn, local = {}) {
    const mine = local ?? {};
    const list = builtIn.map(({ id, data }) => (Object.hasOwn(mine, id)
        ? { id, title: titleOf(mine[id], id), data: mine[id], source: 'edited' }
        : { id, title: titleOf(data, id), data, source: 'builtin' }));
    const known = new Set(builtIn.map(s => s.id));
    const own = Object.entries(mine).filter(([id]) => !known.has(id))
        .map(([id, data]) => ({ id, title: titleOf(data, id), data, source: 'local' }))
        .sort((a, b) => a.title.localeCompare(b.title));
    return [...list, ...own];
}
