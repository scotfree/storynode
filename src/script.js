// What voice mode says. Pure, so the wording is easy to test and tweak.

const NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const numberWord = (n) => NUMBERS[n - 1] ?? String(n);

// The page itself: just its text. Its title was the choice that led here,
// already heard, and reads oddly as an opening line. The story's first page
// is the exception (`cover`): its title is the story's, and nobody chose it.
export function pageScript(node, { cover = false } = {}) {
    return cover ? `${node.title}.\n${node.text}` : node.text;
}

// "Choice one: Walk down to the beach. Choice two: … Which will it be?"
// `blank`: a new story with only its first page, which isn't an ending.
export function choicesScript(choices, options) {
    return choicesPrompt(choices, options).full;
}

// A prompt comes in two lengths: `full` explains what to say, and `brief` is
// for a listener who has heard that before. `key` names the explanation, so
// the app can remember it's been heard. If a brief prompt gets no usable
// answer, the app falls back to the full one.
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function choicesPrompt(choices, { blank = false } = {}) {
    if (choices.length === 0) {
        return blank
            ? { key: 'blank', full: 'This story has no more pages yet. Say add new node to write the next one.', brief: 'No more pages yet.' }
            : { key: 'ending', full: 'The end. Say start over to begin again.', brief: 'The end.' };
    }
    if (choices.length === 1) {
        return {
            key: 'one-choice',
            full: `There's one way on. Choice one: ${choices[0].title}. Say choice one, or its name.`,
            brief: `One way on: ${choices[0].title}.`,
        };
    }
    return {
        key: 'choices',
        full: `${choices.map((c, i) => `Choice ${numberWord(i + 1)}: ${c.title}.`).join('\n')}\nWhich will it be? Say its number, or its name.`,
        brief: `Choices:\n${choices.map((c, i) => `${capital(numberWord(i + 1))}: ${c.title}.`).join('\n')}`,
    };
}

// Said before the full prompt when a brief one didn't land.
export const fallbackScript = (full, { heardSomething = false } = {}) => (heardSomething ? `Sorry, I didn't catch that.\n${full}` : full);

export const HELP_SCRIPT = 'Say a choice by its number, like choice one, or by its name. '
    + 'You can also say repeat, choices, go back, or start over. '
    + 'To add a new page that follows this one, say add new node, and I\'ll ask for its title and text. '
    + 'To make a page that already exists a choice here, say connect node. '
    + 'To change this page, say edit this node. '
    + 'To begin a whole new story, say add new story.';

export function retryScript(attempt, { hold = false } = {}) {
    if (hold) {
        return attempt <= 1
            ? "Sorry, I didn't catch that. Hold the button and say a number, like choice one, or a choice's name."
            : 'Still not sure. Hold the button and try again.';
    }
    return attempt <= 1
        ? "Sorry, I didn't catch that. Say a number, like choice one, or a choice's name."
        : 'Still not sure. Tap the button when you want to try again.';
}

// Never read out with the choices; it's a link on the page and a thing you can say.
export const ADD_LABEL = 'Add new node';
export const EDIT_LABEL = 'Edit this node';
export const CONNECT_LABEL = 'Connect node';

// --- two voices ---
//
// What's spoken is either the story's own words (titles, page text: what the
// page shows in the typewriter face) or the app talking ("Choice one:", "Say
// keep it…"). A voice that can tell them apart reads each in its own voice.
//
// The scripts above stay plain strings. Which words are the story's is worked
// out afterwards, from the story words in play: a sentence is the story's if
// it is one of them, and a sentence that ends "…: <story words>" is split at
// the colon ("Choice one:" + "Walk down to the beach.").

const bare = (s) => String(s ?? '').trim().replace(/[.!?…:]+$/, '').trim();

// The set to look sentences up in, from titles and texts (each may hold
// several sentences). `split` is the sentence splitter from speech.js.
export function storySentences(texts, split) {
    const found = new Set();
    for (const text of texts) for (const sentence of split(text)) if (bare(sentence)) found.add(bare(sentence));
    return found;
}

// One spoken sentence → [{ text, role }], role 'story' or 'app'.
export function voiceParts(sentence, story) {
    if (story.has(bare(sentence))) return [{ text: sentence, role: 'story' }];
    const colon = sentence.indexOf(': ');
    if (colon > 0 && story.has(bare(sentence.slice(colon + 2)))) {
        return [{ text: sentence.slice(0, colon + 1), role: 'app' }, { text: sentence.slice(colon + 2), role: 'story' }];
    }
    return [{ text: sentence, role: 'app' }];
}
