// Writing a new node by voice. Pure: app.js does the speaking and listening.
//
// A short conversation: ask for the title, read it back, ask for the text a
// bit at a time until "done", read it back, then save. Unlike choosing, what's
// heard is kept word for word, so everything is confirmed before it's saved.
//
//   title → confirm-title → text → confirm-text → (save)
//
// composeStep(state, alternatives) returns { state, say, outcome } where
// outcome is 'continue', 'save' or 'cancel'.

import { normalize } from './matcher.js';

const CONFIRM = {
    keep: ['keep it', 'keep', 'keep that', 'yes', 'yeah', 'yep', 'correct', 'thats right', 'thats it', 'sounds good',
        'good', 'ok', 'okay', 'save', 'save it'],
    again: ['try again', 'again', 'no', 'nope', 'redo', 'redo it', 'change it', 'wrong', 'thats wrong', 'start over'],
    cancel: ['cancel', 'cancel that', 'cancel it', 'never mind', 'nevermind', 'forget it', 'stop'],
};

// While dictating the text. Only as the whole utterance, so "the deed is done" stays text.
const TEXT_COMMANDS = {
    done: ['done', 'im done', 'i am done', 'finished', 'im finished', 'thats all', 'thats it'],
    undo: ['undo', 'undo that', 'scratch that', 'delete that', 'remove that'],
    cancel: CONFIRM.cancel,
};

const CONFIRM_ASK = 'Say keep it, try again, or cancel.';
const TEXT_ASK = "Say it a sentence or two at a time, and say done when you're finished.";

// Phrases to bias the recognizer toward, where there are any to expect.
export function composeHints(state) {
    if (state.stage === 'confirm-title' || state.stage === 'confirm-text') return ['keep it', 'try again', 'cancel'];
    if (state.stage === 'text') return ['done', 'scratch that', 'cancel', ...(state.kind === 'edit' ? ['keep it'] : [])];
    return state.kind === 'edit' ? ['keep it', 'cancel'] : ['cancel'];
}

function commandIn(alternatives, table) {
    for (const said of alternatives) {
        const words = normalize(said).replace(/^(please |um |uh |ok |okay )+(?=\S)/, '').replace(/ please$/, '');
        for (const [name, phrases] of Object.entries(table)) {
            if (phrases.includes(words) || phrases.includes(normalize(said))) return name;
        }
    }
    return null;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const squeeze = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Recognizers mostly give lowercase with no punctuation.
export const tidyTitle = (heard) => capitalize(squeeze(heard).replace(/[.。]+$/, ''));

export function tidyChunk(heard) {
    const s = capitalize(squeeze(heard));
    return !s || /[.!?…"”’')]$/.test(s) ? s : `${s}.`;
}

export const composedText = (state) => state.chunks.join(' ');

// kind: 'node' (a page after the current one), 'story' (a whole new story,
// whose title and overview become its first page) or 'edit' (the same
// questions about an existing page, given as `original`: { title, text };
// "keep it" at either question leaves that part as it is).
export const startCompose = (kind = 'node', original = null) => ({ kind, stage: 'title', title: '', chunks: [], original });

const isEdit = (state) => state.kind === 'edit';
const KEEP_AS_IS = { keep: ['keep it', 'keep', 'keep that', 'same', 'the same', 'no change', 'leave it', 'skip'] };
const EDIT_TEXT_ASK = "Say keep it to leave it as it is, or say the new text a sentence or two at a time, and say done when you're finished.";

const isStory = (state) => state.kind === 'story';
const textAsk = (state) => {
    if (isEdit(state)) return `Now the text. ${EDIT_TEXT_ASK}`;
    return isStory(state)
        ? `Now the overview, like the back of a book jacket. ${TEXT_ASK}`
        : `Now the text. ${TEXT_ASK}`;
};

// What to say on arriving at (or coming back to) a stage.
export function composePrompt(state) {
    switch (state.stage) {
        case 'title':
            if (isEdit(state)) return `Editing this page. Its title is: ${state.original.title}. Say the new title, or say keep it.`;
            return isStory(state) ? "A new story. What's its title?" : "A new page here. What's its title?";
        case 'confirm-title':
            return `The title is: ${state.title}. ${CONFIRM_ASK}`;
        case 'text':
            return state.chunks.length
                ? `So far: ${composedText(state)} Go on, or say done.`
                : textAsk(state);
        default:
            return `Here's the ${isStory(state) ? 'story' : 'page'}. ${state.title}. ${composedText(state)} ${CONFIRM_ASK}`;
    }
}

const label = (state) => (isEdit(state) ? 'Editing' : isStory(state) ? 'New story' : 'New node');

// The same arrival, for someone who has heard the long version before.
export function composeBrief(state) {
    switch (state.stage) {
        case 'title':
            if (isEdit(state)) return `Title: ${state.original.title}. New title?`;
            return isStory(state) ? 'New story. Title?' : 'New page. Title?';
        case 'confirm-title':
            return `${state.title}. Keep?`;
        case 'text':
            if (state.chunks.length) return `So far: ${composedText(state)} Go on?`;
            return isEdit(state) ? 'New text?' : isStory(state) ? 'Overview?' : 'Text?';
        default:
            return `${state.title}. ${composedText(state)} Keep?`;
    }
}

// Names the explanation a prompt carries, so the app can remember it's been
// heard. Both read-backs explain the same three answers.
export function promptKey(state) {
    if (state.stage === 'confirm-title' || state.stage === 'confirm-text') return 'confirm';
    return `${state.kind}-${state.stage}`;
}

// A short line for the screen.
export function composeStatus(state) {
    switch (state.stage) {
        case 'title': return isEdit(state) ? 'Editing: say the new title, or “keep it”.' : `${label(state)}: say its title.`;
        case 'confirm-title': return `Title: “${state.title}”. Keep it, try again, or cancel?`;
        case 'text': return `${label(state)}: say the ${isStory(state) ? 'overview' : 'text'}, then “done”.`;
        default: return 'Keep it, try again, or cancel?';
    }
}

const cancelled = (state) => ({ state, say: isEdit(state) ? 'Okay, nothing changed.' : 'Okay, nothing added.', outcome: 'cancel' });
// A step that carries on. With no words given it's the arrival prompt for the
// new stage, which has a brief form; other lines pass their own { key, brief }
// or none, and a line with no key is always said in full.
const on = (state, say, { key = null, brief = null } = {}) => (say === undefined
    ? { state, say: composePrompt(state), key: promptKey(state), brief: composeBrief(state), outcome: 'continue' }
    : { state, say, key, brief, outcome: 'continue' });

export function composeStep(state, alternatives) {
    const guesses = (Array.isArray(alternatives) ? alternatives : [alternatives]).map(squeeze).filter(Boolean);
    const heard = guesses[0];

    if (state.stage === 'title') {
        if (!heard) return on(state, "I didn't hear a title. What's the title?");
        if (commandIn(guesses, { cancel: CONFIRM.cancel })) return cancelled(state);
        if (isEdit(state) && commandIn(guesses, KEEP_AS_IS)) return on({ ...state, stage: 'text', title: state.original.title });
        return on({ ...state, stage: 'confirm-title', title: tidyTitle(heard) });
    }

    if (state.stage === 'text') {
        if (!heard) return on(state, state.chunks.length ? "I didn't hear anything. Go on, or say done." : `I didn't hear anything. ${TEXT_ASK}`);
        const command = commandIn(guesses, TEXT_COMMANDS);
        if (command === 'cancel') return cancelled(state);
        if (isEdit(state) && state.chunks.length === 0 && commandIn(guesses, KEEP_AS_IS)) {
            return on({ ...state, stage: 'confirm-text', chunks: [state.original.text] });
        }
        if (command === 'undo') {
            if (state.chunks.length === 0) return on(state, "There's nothing to remove yet.");
            return on({ ...state, chunks: state.chunks.slice(0, -1) }, 'Removed the last part. Go on, or say done.', { key: 'more', brief: 'Removed.' });
        }
        if (command === 'done') {
            if (state.chunks.length === 0) return on(state, "There's no text yet. Say some, or say cancel.");
            return on({ ...state, stage: 'confirm-text' });
        }
        return on({ ...state, chunks: [...state.chunks, tidyChunk(heard)] }, 'Got it. Go on, or say done.', { key: 'more', brief: 'Got it.' });
    }

    // The two read-backs.
    const answer = commandIn(guesses, CONFIRM);
    if (answer === 'cancel') return cancelled(state);
    if (state.stage === 'confirm-title') {
        if (answer === 'keep') return on({ ...state, stage: 'text' });
        if (answer === 'again') return on({ ...state, stage: 'title', title: '' }, "Okay. What's the title?", { key: 'retitle', brief: 'Title?' });
        return on(state, heard ? `Sorry, I didn't catch that. ${composePrompt(state)}` : CONFIRM_ASK);
    }
    if (answer === 'keep') return { state, say: isEdit(state) ? 'Saved.' : 'Added.', outcome: 'save' };
    if (answer === 'again') return on({ ...state, stage: 'text', chunks: [] }, `Okay, the text again. ${TEXT_ASK}`, { key: promptKey({ ...state, stage: 'text' }), brief: 'The text again.' });
    return on(state, heard ? `Sorry, I didn't catch that. ${CONFIRM_ASK}` : CONFIRM_ASK);
}
