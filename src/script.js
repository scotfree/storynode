// What voice mode says. Pure, so the wording is easy to test and tweak.

const NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const numberWord = (n) => NUMBERS[n - 1] ?? String(n);

// The page itself: title, then text.
export function pageScript(node) {
    return `${node.title}.\n${node.text}`;
}

// "Choice one: Walk down to the beach. Choice two: … Which will it be?"
export function choicesScript(choices) {
    if (choices.length === 0) return 'The end. Say start over to begin again.';
    if (choices.length === 1) return `There's one way on. Choice one: ${choices[0].title}. Say choice one, or its name.`;
    const list = choices.map((c, i) => `Choice ${numberWord(i + 1)}: ${c.title}.`).join('\n');
    return `${list}\nWhich will it be?`;
}

export const HELP_SCRIPT = 'Say a choice by its number, like choice one, or by its name. '
    + 'You can also say repeat, choices, go back, or start over. '
    + 'To write a new page that follows this one, say add new node.';

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
