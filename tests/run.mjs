// Unit tests for the pure modules. Run: node tests/run.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadStory, choicesOf, isEnding, parentsOf } from '../src/story.js';
import { match, numberFrom, commandFrom, titleHits, hintPhrases, normalize } from '../src/matcher.js';
import { layoutGraph } from '../src/layout.js';
import { sentences, rankVoices } from '../src/speech.js';
import { pageScript, choicesScript, numberWord } from '../src/script.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${err.message}`);
        failed++;
    }
}

const section = (name) => console.log(`\n${name}`);

// --- story ---
section('story');

const tiny = {
    title: 'Tiny',
    nodes: [
        { id: 'a', title: 'Start', text: 'Begin.' },
        { id: 'b', title: 'Go left', text: 'Left.', parent: 'a' },
        { id: 'c', title: 'Go right', text: 'Right.', parent: 'a' },
        { id: 'd', title: 'Meet in the middle', text: 'Both ways lead here.', parent: ['b', 'c'] },
    ],
};

test('loads, finds the start, and lists choices in story order', () => {
    const { story, errors } = loadStory(tiny);
    assert.deepEqual(errors, []);
    assert.equal(story.start, 'a');
    assert.deepEqual(choicesOf(story, 'a').map(n => n.id), ['b', 'c']);
});

test('a node can have several parents (paths that merge)', () => {
    const { story } = loadStory(tiny);
    assert.deepEqual(choicesOf(story, 'b').map(n => n.id), ['d']);
    assert.deepEqual(choicesOf(story, 'c').map(n => n.id), ['d']);
    assert.equal(isEnding(story, 'd'), true);
    assert.equal(isEnding(story, 'a'), false);
});

test('parentsOf accepts a string, a list, or nothing', () => {
    assert.deepEqual(parentsOf({ parent: 'x' }), ['x']);
    assert.deepEqual(parentsOf({ parent: ['x', 'y'] }), ['x', 'y']);
    assert.deepEqual(parentsOf({}), []);
});

test('reports missing parents, duplicate ids, missing titles and loops', () => {
    const { errors } = loadStory({
        nodes: [
            { id: 'a', title: 'A', parent: 'c' },
            { id: 'b', title: '', parent: 'nowhere' },
            { id: 'a', title: 'Again' },
            { id: 'c', title: 'C', parent: 'a' },
        ],
    });
    const all = errors.join(' | ');
    assert.match(all, /used twice/);
    assert.match(all, /needs a "title"/);
    assert.match(all, /"nowhere" doesn't exist/);
    assert.match(all, /loops back/);
});

test('an explicit start must exist; an empty story is an error', () => {
    assert.match(loadStory({ start: 'zzz', nodes: tiny.nodes }).errors.join(), /"zzz" doesn't exist/);
    assert.match(loadStory({ nodes: [] }).errors.join(), /no nodes/);
});

test('the sample story loads cleanly, with endings and merges', () => {
    const data = JSON.parse(readFileSync(new URL('../stories/lighthouse.json', import.meta.url)));
    const { story, errors } = loadStory(data);
    assert.deepEqual(errors, []);
    assert.equal(choicesOf(story, 'start').length, 3);
    const endings = [...story.byId.keys()].filter(id => isEnding(story, id));
    assert.ok(endings.length >= 4);
    assert.ok([...story.byId.values()].some(n => n.parents.length > 1));
});

// --- matcher ---
section('matcher');

const choices = [
    { id: 'beach', title: 'Walk down to the beach', aliases: ['the shore'] },
    { id: 'forest', title: 'Follow the forest path', aliases: ['the woods'] },
    { id: 'castle', title: 'Climb to the castle' },
];
const pick = (said) => {
    const r = match(Array.isArray(said) ? said : [said], choices);
    return r.kind === 'choice' ? r.id : r.kind === 'command' ? `!${r.name}` : null;
};

test('numbers, in the ways people say them', () => {
    for (const [said, id] of [
        ['two', 'forest'], ['2', 'forest'], ['choice two', 'forest'], ['Choice 3.', 'castle'],
        ['option one', 'beach'], ['number three', 'castle'], ['the second one', 'forest'],
        ['third', 'castle'], ['one', 'beach'], ['two please', 'forest'], ['go with the first', 'beach'],
        ['pick 3', 'castle'], ['take two', 'forest'],
    ]) assert.equal(pick(said), id, said);
});

test('sound-alikes count only right after choice/option/number, at the end', () => {
    assert.equal(pick('choice to'), 'forest');
    assert.equal(pick('option for'), null);  // there is no fourth choice
    assert.equal(pick('choice won'), 'beach');
    assert.equal(pick('choose to go to the beach'), 'beach');  // "to" is not 2 here
    assert.equal(numberFrom('i want to go'), null);
});

test('titles: whole, partial, aliases, small misspellings', () => {
    for (const [said, id] of [
        ['walk down to the beach', 'beach'], ['the beach', 'beach'], ['beach', 'beach'],
        ['the castle', 'castle'], ["let's climb", 'castle'], ['the path', 'forest'],
        ['the forrest', 'forest'], ['into the woods', 'forest'], ['the shore', 'beach'],
        ['I think we should follow the forest path', 'forest'],
    ]) assert.equal(pick(said), id, said);
});

test('unclear or unrelated speech is not guessed', () => {
    assert.equal(pick('banana'), null);
    assert.equal(pick('the beach or the castle'), null);
    assert.equal(pick(''), null);
    assert.equal(pick('choice seven'), null);  // out of range
});

test('commands work at any node', () => {
    for (const [said, name] of [
        ['repeat', 'repeat'], ['say that again', 'repeat'], ['what are my choices', 'choices'],
        ['go back', 'back'], ['start over', 'restart'], ['help', 'help'], ['stop', 'stop'], ['please repeat', 'repeat'],
    ]) assert.equal(pick(said), `!${name}`, said);
    assert.equal(commandFrom('the beach'), null);
});

test('later guesses are tried when the first is unclear', () => {
    assert.equal(pick(['the bitch', 'the beach']), 'beach');
    assert.equal(pick(['too', 'two']), 'forest');
});

test('titleHits counts words unique to a choice', () => {
    const hits = titleHits('the forest path', choices);
    assert.deepEqual(hits[1], { hits: 2, distinct: 2 });
    assert.deepEqual(hits[0], { hits: 0, distinct: 0 });
});

test('hint phrases include titles, aliases, numbers and commands', () => {
    const phrases = hintPhrases(choices);
    for (const p of ['Walk down to the beach', 'the shore', 'choice 3', 'repeat', 'go back']) {
        assert.ok(phrases.includes(p) || phrases.includes(p.replace('go back', 'back')), p);
    }
    assert.equal(normalize("Let's go!  Now."), 'lets go now');
});

// --- layout ---
section('layout');

test('rows follow the longest path, so every edge points down', () => {
    const { story } = loadStory(tiny);
    const layout = layoutGraph(story);
    const row = Object.fromEntries(layout.nodes.map(n => [n.id, n.row]));
    assert.deepEqual(row, { a: 0, b: 1, c: 1, d: 2 });
    for (const e of layout.edges) assert.ok(e.y2 > e.y1);
    assert.equal(layout.edges.length, 4);
});

test('nodes in a row do not overlap and fit inside the drawing', () => {
    const data = JSON.parse(readFileSync(new URL('../stories/lighthouse.json', import.meta.url)));
    const { story } = loadStory(data);
    const layout = layoutGraph(story);
    const rows = Map.groupBy(layout.nodes, n => n.row);
    for (const r of rows.values()) {
        const xs = r.map(n => n.x).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= r[0].w);
    }
    for (const n of layout.nodes) {
        assert.ok(n.x >= 0 && n.x + n.w <= layout.width);
        assert.ok(n.y >= 0 && n.y + n.h <= layout.height);
    }
    assert.equal(layout.nodes.length, story.byId.size);
});

// --- speech helpers and script ---
section('speech and script');

test('sentences split on end punctuation and newlines', () => {
    assert.deepEqual(sentences('One. Two! "Three?" Four…\nFive'), ['One.', 'Two!', '"Three?"', 'Four…', 'Five']);
    assert.deepEqual(sentences(''), []);
});

test('better voices in the right language come first', () => {
    const voices = [
        { name: 'Basic', lang: 'en-US' }, { name: 'Ava (Premium)', lang: 'en-US' },
        { name: 'Google français', lang: 'fr-FR' }, { name: 'Google US English', lang: 'en-US' },
    ];
    assert.deepEqual(rankVoices(voices).map(v => v.name).slice(0, 3), ['Ava (Premium)', 'Google US English', 'Basic']);
});

test('the spoken page and choices', () => {
    assert.equal(pageScript({ title: 'The Cave', text: 'It is dark.' }), 'The Cave.\nIt is dark.');
    assert.equal(choicesScript(choices), 'Choice one: Walk down to the beach.\nChoice two: Follow the forest path.\nChoice three: Climb to the castle.\nWhich will it be?');
    assert.match(choicesScript([]), /The end/);
    assert.match(choicesScript([choices[0]]), /one way on/);
    assert.equal(numberWord(12), '12');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
