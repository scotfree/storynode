// Connecting the current page to one that already exists, by voice. Pure.
//
// Ask for the title of the page to connect to. If nothing matches, say so and
// ask again; if that misses too, read out the titles it could be and take a
// title or a number. Once found, the app adds the connection: the page found
// becomes a choice here, as if it had been written from here.
//
// connectStep(state, alternatives) returns { state, say, key, brief, outcome,
// id } where outcome is 'continue', 'connect' (with the page's id) or 'cancel'.

import { normalize, numberFrom, titleHits } from './matcher.js';
import { numberWord } from './script.js';

const CANCEL = ['cancel', 'cancel that', 'cancel it', 'never mind', 'nevermind', 'forget it', 'stop'];
const LIST = ['list', 'list them', 'read them', 'read the titles', 'what are they', 'which pages', 'titles'];

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const bareWords = (said) => normalize(said).replace(/^(please |um |uh |ok |okay )+(?=\S)/, '').replace(/ please$/, '');

// candidates: [{ id, title }], the pages this one may connect to.
export const startConnect = (candidates) => ({ candidates, misses: 0, listed: false });

export const CONNECT_ASK = {
    key: 'connect',
    full: 'Connect this page to one that already exists. Say its title, or say list to hear them.',
    brief: 'Connect to?',
};

const listScript = (state) => `${state.candidates.map((c, i) => `${capital(numberWord(i + 1))}: ${c.title}.`).join('\n')}\nSay a title, or its number.`;

// A short line for the screen.
export const connectStatus = (state) => (state.listed ? 'Connecting: say a title or its number.' : 'Connecting: say the title of the page.');

// The page a guess names, or null. A title wins on its exact words, or when it
// has words no other candidate has and clearly beats the rest, like choosing.
export function findPage(said, candidates, { numbers = false } = {}) {
    if (numbers) {
        const n = numberFrom(said);
        if (n !== null && n >= 1 && n <= candidates.length) return candidates[n - 1];
    }
    const exact = candidates.filter(c => normalize(c.title) === normalize(said));
    if (exact.length === 1) return exact[0];
    const scores = titleHits(said, candidates);
    const order = scores.map((_, i) => i)
        .sort((a, b) => scores[b].distinct - scores[a].distinct || scores[b].hits - scores[a].hits);
    const [best, second] = order;
    if (best === undefined || scores[best].distinct === 0) return null;
    const runnerUp = second === undefined ? { distinct: 0, hits: 0 } : scores[second];
    const clear = scores[best].distinct > runnerUp.distinct
        || (scores[best].distinct === runnerUp.distinct && scores[best].hits > runnerUp.hits);
    return clear ? candidates[best] : null;
}

const on = (state, say, { key = null, brief = null } = {}) => ({ state, say, key, brief, outcome: 'continue', id: null });

// What to say on starting (or coming back to it).
export function connectPrompt(state) {
    if (state.candidates.length === 0) {
        return { state, say: "There's no other page this one can connect to yet.", key: null, brief: null, outcome: 'cancel', id: null };
    }
    return state.listed ? on(state, listScript(state)) : on(state, CONNECT_ASK.full, CONNECT_ASK);
}

export function connectStep(state, alternatives) {
    const guesses = (Array.isArray(alternatives) ? alternatives : [alternatives]).map(s => String(s ?? '').trim()).filter(Boolean);
    const heard = guesses[0];
    if (guesses.some(g => CANCEL.includes(bareWords(g)))) {
        return { state, say: 'Okay, nothing connected.', key: null, brief: null, outcome: 'cancel', id: null };
    }
    for (const said of guesses) {
        const page = findPage(said, state.candidates, { numbers: state.listed });
        if (page) return { state, say: `Connected: ${page.title}.`, key: null, brief: null, outcome: 'connect', id: page.id };
    }
    if (guesses.some(g => LIST.includes(bareWords(g)))) return on({ ...state, listed: true }, listScript(state));
    if (!heard) return on(state, state.listed ? 'Say a title, or its number, or say cancel.' : "I didn't hear a title. Say the title of the page to connect to.");

    // Not found: once, try again; twice, read out what there is.
    const misses = state.misses + 1;
    const sorry = `I couldn't find a page called ${heard}.`;
    if (state.listed) return on({ ...state, misses }, `${sorry} Say a title, or its number, or say cancel.`);
    if (misses < 2) return on({ ...state, misses }, `${sorry} Try again.`);
    return on({ ...state, misses, listed: true }, `${sorry} Here are the pages you can connect to.\n${listScript(state)}`);
}
