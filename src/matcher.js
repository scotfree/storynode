// Turns what the speech recognizer heard into a choice or a command. Pure.
//
// The recognizer gives a few guesses (alternatives) per utterance; we try
// each in order. A guess can pick a choice by number ("two", "choice two",
// "the second one") or by its title or an alias ("the beach", "go to the
// forest"), or be one of the commands that work everywhere ("repeat",
// "go back", "start over"). Anything unclear returns { kind: 'none' } so the
// app can ask again, rather than guessing.

export const COMMANDS = {
    repeat: ['repeat', 'repeat that', 'again', 'say that again', 'say it again', 'what', 'pardon', 'come again'],
    choices: ['choices', 'options', 'what are my choices', 'what are the choices', 'what are my options', 'list', 'list the choices', 'read the choices'],
    back: ['back', 'go back', 'previous', 'undo'],
    restart: ['restart', 'start over', 'start again', 'begin again', 'from the beginning', 'go to the beginning'],
    help: ['help', 'what can i say', 'what do i say'],
    stop: ['stop', 'pause', 'quiet', 'be quiet', 'stop listening', 'goodbye'],
};

const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
};

// Words recognizers commonly hear instead of a number. Only trusted as the
// last word, right after "choice", "option" or "number" ("choice to" is 2,
// but "choose to go…" is not).
const SOUNDALIKES = { won: 1, to: 2, too: 2, for: 4, fore: 4, ate: 8, tree: 3, free: 3 };
const SOUNDALIKE_LEADS = ['choice', 'option', 'number'];

const LEAD_INS = ['choice', 'option', 'number', 'pick', 'choose', 'select', 'go with', 'take'];
const FILLER = new Set(['the', 'please', 'um', 'uh', 'number', 'one']);

// Words that don't tell choices apart.
const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'go', 'goes', 'going', 'into', 'in', 'on', 'of', 'and', 'or',
    'lets', 'let', 'us', 'i', 'id', 'ill', 'want', 'wanna', 'like', 'would', 'please', 'we', 'will', 'should',
    'take', 'try', 'um', 'uh', 'okay', 'ok', 'yes', 'yeah', 'one', 'that', 'this', 'there', 'at', 'with', 'up', 'down']);

export function normalize(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const contentWords = (text) => normalize(text).split(' ').filter(w => w && !STOPWORDS.has(w));

const toNumber = (w) => (/^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w] ?? null);

function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return row[b.length];
}

// Same word, allowing a slip on longer words ("castel", "forrest") and plurals.
function wordsMatch(heard, wanted) {
    if (heard === wanted) return true;
    if (heard.replace(/s$/, '') === wanted.replace(/s$/, '')) return true;
    return wanted.length >= 5 && editDistance(heard, wanted) <= 1;
}

// "two", "choice two", "option 2", "the second one", "choice to" -> 2, else null.
export function numberFrom(text) {
    const words = normalize(text).split(' ').filter(Boolean);

    // After a lead-in: "choice two", "go with the third".
    for (let i = 0; i < words.length; i++) {
        const pair = `${words[i]} ${words[i + 1]}`;
        const lead = LEAD_INS.includes(pair) ? pair : LEAD_INS.includes(words[i]) ? words[i] : null;
        if (!lead) continue;
        let j = i + lead.split(' ').length;
        if (words[j] === 'the' || words[j] === 'number') j++;
        const next = words[j];
        if (next === undefined) continue;
        const n = toNumber(next);
        if (n) return n;
        if (SOUNDALIKE_LEADS.includes(lead) && j === words.length - 1 && SOUNDALIKES[next]) return SOUNDALIKES[next];
    }

    // Or just a number: "two", "the second one", "three please", "one".
    if (words.length === 1 && words[0] === 'one') return 1;
    const numbers = words.filter(w => w !== 'one' && toNumber(w));
    const others = words.filter(w => !toNumber(w) && !FILLER.has(w));
    if (numbers.length === 1 && others.length === 0) return toNumber(numbers[0]);
    return null;
}

export function commandFrom(text) {
    const said = normalize(text).replace(/^(please |um |uh |ok |okay )+/, '').replace(/( please)$/, '');
    for (const [name, phrases] of Object.entries(COMMANDS)) {
        if (phrases.includes(said)) return name;
    }
    return null;
}

const phraseWords = (choice) => new Set([choice.title, ...(choice.aliases ?? [])].flatMap(contentWords));

// How an utterance lines up with each choice's title and aliases:
// `hits` = the choice's words that were said, `distinct` = those of them no
// other choice has. "the path" picks "Follow the forest path" because "path"
// is only in that one.
export function titleHits(text, choices) {
    const heard = contentWords(text);
    const words = choices.map(phraseWords);
    return words.map((own, i) => {
        const others = new Set(words.filter((_, j) => j !== i).flatMap(w => [...w]));
        let hits = 0;
        let distinct = 0;
        for (const w of own) {
            if (!heard.some(h => wordsMatch(h, w))) continue;
            hits++;
            if (![...others].some(o => wordsMatch(o, w))) distinct++;
        }
        return { hits, distinct };
    });
}

// alternatives: the recognizer's guesses, best first. choices: [{ id, title, aliases }].
// Returns { kind: 'choice', index, id, via } | { kind: 'command', name } | { kind: 'none' }.
export function match(alternatives, choices) {
    const guesses = (Array.isArray(alternatives) ? alternatives : [alternatives]).filter(Boolean);
    for (const said of guesses) {
        const n = numberFrom(said);
        if (n !== null && n >= 1 && n <= choices.length) {
            return { kind: 'choice', index: n - 1, id: choices[n - 1].id, via: 'number', heard: said };
        }
        const command = commandFrom(said);
        if (command) return { kind: 'command', name: command, heard: said };

        // A title wins if it has a word only it has, and clearly beats the rest.
        const scores = titleHits(said, choices);
        const order = scores.map((_, i) => i)
            .sort((a, b) => scores[b].distinct - scores[a].distinct || scores[b].hits - scores[a].hits);
        const [best, second] = order;
        if (best === undefined || scores[best].distinct === 0) continue;
        const runnerUp = second === undefined ? { distinct: 0, hits: 0 } : scores[second];
        const clear = scores[best].distinct > runnerUp.distinct
            || (scores[best].distinct === runnerUp.distinct && scores[best].hits > runnerUp.hits);
        if (clear) return { kind: 'choice', index: best, id: choices[best].id, via: 'title', heard: said };
    }
    return { kind: 'none', heard: guesses[0] ?? '' };
}

// Phrases to bias the recognizer toward at a node: the choices, a few number
// forms, and the commands.
export function hintPhrases(choices) {
    const phrases = [];
    choices.forEach((c, i) => {
        phrases.push(c.title, ...(c.aliases ?? []), `choice ${i + 1}`);
    });
    for (const list of Object.values(COMMANDS)) phrases.push(list[0]);
    return [...new Set(phrases.map(p => p.trim()).filter(Boolean))];
}
