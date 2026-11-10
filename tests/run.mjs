// Unit tests for the pure modules. Run: node tests/run.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadStory, choicesOf, isEnding, parentsOf, addNode, editNode, idFor } from '../src/story.js';
import { match, numberFrom, commandFrom, titleHits, hintPhrases, normalize } from '../src/matcher.js';
import { layoutGraph } from '../src/layout.js';
import { sentences, rankVoices, mergeSegments, listenOnce, createSpeaker } from '../src/speech.js';
import { pageScript, choicesScript, numberWord, retryScript, HELP_SCRIPT } from '../src/script.js';
import { createLog, matchLines } from '../src/voicelog.js';
import { angleAt, createSweep } from '../src/arc.js';
import { createClipSpeaker } from '../src/clipspeaker.js';
import { createModelVoice, modelNote, loadProgress, clipStats, timingNote } from '../src/modelvoice.js';
import { createStory, listStories, overviewOf } from '../src/library.js';
import { startCompose, composeStep, composePrompt, composeHints, composedText, tidyTitle, tidyChunk } from '../src/compose.js';

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

async function testAsync(name, fn) {
    try {
        await fn();
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

test('retry wording says hold in Hold To Talk', () => {
    assert.match(retryScript(1, { hold: true }), /Hold the button/);
    assert.match(retryScript(2, { hold: true }), /Hold the button/);
    assert.doesNotMatch(retryScript(1), /Hold/);
});

test('speak only cancels when something is playing', () => {
    globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    let cancels = 0;
    const synth = { speaking: false, pending: false, cancel() { cancels++; }, speak() {} };
    const speaker = createSpeaker({ synth });
    speaker.speak('Hello.');
    assert.equal(cancels, 0);
    synth.speaking = true;
    speaker.speak('Hello again.');
    assert.equal(cancels, 1);
});

test('speak tracks its sentence and can resume from it', () => {
    globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    const queued = [];
    const synth = { speaking: false, pending: false, cancel() {}, speak(u) { queued.push(u); } };
    const speaker = createSpeaker({ synth });
    speaker.speak('One. Two. Three.');
    queued[0].onstart();
    queued[0].onend();
    queued[1].onstart();
    assert.equal(speaker.position(), 1);
    speaker.cancel();
    queued[1].onend();              // a cancelled sentence doesn't count as finished
    assert.equal(speaker.position(), 1);

    queued.length = 0;
    speaker.speak('One. Two. Three.', { from: speaker.position() });
    assert.deepEqual(queued.map(u => u.text), ['Two.', 'Three.']);
    queued[1].onstart();
    assert.equal(speaker.position(), 2);
});

// --- arc controls ---
section('arc');

// A point on a circle around (0, 0), degrees clockwise from the top.
const on = (degrees, radius = 100) => {
    const a = degrees * Math.PI / 180;
    return [radius * Math.sin(a), -radius * Math.cos(a)];
};

function sweepFrom(start, options = {}) {
    const [startX, startY] = on(start);
    return createSweep({ cx: 0, cy: 0, startX, startY, ...options });
}

// Moves through angles in order and returns every update.
const drag = (tracker, angles) => angles.map(a => tracker.update(...on(a)));

test('angles run clockwise from the top', () => {
    assert.equal(Math.round(angleAt(0, -10, 0, 0)), 0);
    assert.equal(Math.round(angleAt(10, 0, 0, 0)), 90);
    assert.equal(Math.round(angleAt(-10, 0, 0, 0)), -90);
});

test('a clockwise drag fires once, at 180 degrees', () => {
    const steps = drag(sweepFrom(225, { direction: 1 }), [260, 300, 340, 380, 404, 406, 440]);
    assert.deepEqual(steps.map(s => s.fired), [false, false, false, false, false, true, false]);
    assert.equal(Math.round(steps[steps.length - 1].sweep), 180);
});

test('a counterclockwise drag sweeps negative', () => {
    const steps = drag(sweepFrom(135, { direction: -1 }), [100, 60, 20, -20, -46]);
    assert.equal(Math.round(steps[4].sweep), -180);
    assert.equal(steps[4].fired, true);
});

test('crossing the +/-180 seam is a small step', () => {
    const [step] = drag(sweepFrom(170, { direction: 1 }), [-170]);
    assert.equal(Math.round(step.sweep), 20);
});

test('dragging the wrong way does not build up', () => {
    const tracker = sweepFrom(225, { direction: 1 });
    drag(tracker, [200, 170, 140]);
    assert.equal(tracker.update(...on(140)).sweep, 0);
    assert.equal(Math.round(tracker.update(...on(170)).sweep), 30);
});

test('moves in the center deadzone are ignored', () => {
    const tracker = sweepFrom(0, { direction: 0 });
    assert.equal(Math.round(tracker.update(...on(30)).sweep), 30);
    assert.equal(Math.round(tracker.update(...on(150, 5)).sweep), 30);
});

test('a jump straight across adds nothing', () => {
    const tracker = sweepFrom(0, { direction: 0 });
    assert.equal(tracker.update(...on(170)).sweep, 0);
});

test('with no set direction, either way fires', () => {
    assert.equal(drag(sweepFrom(0), [60, 120, 181]).at(-1).fired, true);
    assert.equal(drag(sweepFrom(0), [-60, -120, -181]).at(-1).fired, true);
});

// --- the matcher's trace and the log ---
section('voice log');

test('match explains each guess it tried', () => {
    const { trace, kind } = match(['banana', 'the path'], choices);
    assert.equal(kind, 'choice');
    assert.equal(trace.length, 2);
    assert.equal(trace[0].outcome, 'no word unique to one choice');
    assert.equal(trace[1].outcome, 'title of choice 2');
    assert.equal(match(['choice three'], choices).trace[0].outcome, 'number 3');
    assert.equal(match(['go back'], choices).trace[0].outcome, 'command back');
});

test('matchLines reports scores and the outcome', () => {
    const [line] = matchLines(match(['the path'], choices));
    assert.match(line, /“the path”/);
    assert.match(line, /2=1\/1/);
    assert.match(line, /→ title of choice 2/);
});

test('the log drops the oldest entries past its cap', () => {
    const log = createLog({ cap: 2, now: () => 0 });
    log.add('a', '1');
    log.add('b', '2');
    log.add('c', '3');
    assert.deepEqual(log.entries().map(e => e.text), ['2', '3']);
});

// --- listening, against a fake recognizer ---
section('listening');

function fakeRecognizer({ endsOnStop = true } = {}) {
    return class Fake {
        static made = [];
        constructor() { Fake.made.push(this); }
        start() { this.started = true; }
        stop() {
            this.stopped = true;
            if (endsOnStop) this.onend();
        }
        abort() { this.aborted = true; }
        hear(guesses, isFinal = true) {
            const result = Object.assign(guesses.map(transcript => ({ transcript })), { isFinal });
            this.onresult({ results: [result] });
        }
    };
}

function fakeTimers() {
    const pending = new Map();
    let next = 1;
    return {
        set(fn, ms) { pending.set(next, { fn, ms }); return next++; },
        clear(id) { pending.delete(id); },
        has: (ms) => [...pending.values()].some(t => t.ms === ms),
        fire(ms) {
            for (const [id, t] of [...pending]) {
                if (t.ms === ms) {
                    pending.delete(id);
                    t.fn();
                }
            }
        },
    };
}

function listenWith(options = {}, fakeOptions = {}) {
    const Fake = fakeRecognizer(fakeOptions);
    const timers = fakeTimers();
    const session = listenOnce({ RecognitionClass: Fake, timers, hints: false, ...options });
    return { Fake, timers, session, r: () => Fake.made[Fake.made.length - 1] };
}

test('mergeSegments joins best guesses, then adds the last alternatives', () => {
    assert.deepEqual(mergeSegments([]), []);
    assert.deepEqual(mergeSegments([[], []]), []);
    assert.deepEqual(mergeSegments([['beach', 'breach']]), ['beach', 'breach']);
    assert.deepEqual(mergeSegments([['the'], ['beach', 'breach']]), ['the beach', 'beach', 'breach']);
});

await testAsync('stop() returns what was heard', async () => {
    const { session, r } = listenWith({ hold: true });
    r().onaudiostart();
    r().hear(['choice two', 'choice to']);
    session.stop();
    const { alternatives, error } = await session.promise;
    assert.deepEqual(alternatives, ['choice two', 'choice to']);
    assert.equal(error, null);
    assert.equal(r().stopped, true);
});

await testAsync('abort() discards what was heard', async () => {
    const { session, r } = listenWith({ hold: true });
    r().hear(['choice two']);
    session.abort();
    const { alternatives, error } = await session.promise;
    assert.deepEqual(alternatives, []);
    assert.equal(error, 'aborted');
    assert.equal(r().aborted, true);
});

await testAsync('a held press re-arms at a pause and merges the segments', async () => {
    const { Fake, session, r } = listenWith({ hold: true });
    r().onaudiostart();
    r().hear(['the']);
    r().onend();
    assert.equal(Fake.made.length, 2);
    r().hear(['beach', 'breach']);
    session.stop();
    const { alternatives, segments } = await session.promise;
    assert.deepEqual(alternatives, ['the beach', 'beach', 'breach']);
    assert.equal(segments.length, 2);
});

await testAsync('hands-free does not re-arm: a pause ends it', async () => {
    const { Fake, session, r } = listenWith({ hold: false });
    r().onaudiostart();
    r().hear(['two']);
    r().onend();
    const { alternatives } = await session.promise;
    assert.deepEqual(alternatives, ['two']);
    assert.equal(Fake.made.length, 1);
});

await testAsync('interim words count if no final result arrives', async () => {
    const { session, r } = listenWith({ hold: true });
    r().onaudiostart();
    r().hear(['two'], false);
    session.stop();
    assert.deepEqual((await session.promise).alternatives, ['two']);
});

await testAsync('gives up 3 seconds after release if the browser never ends', async () => {
    const { session, r, timers } = listenWith({ hold: true }, { endsOnStop: false });
    r().onaudiostart();
    r().hear(['two'], false);
    session.stop();
    timers.fire(3000);
    assert.deepEqual((await session.promise).alternatives, ['two']);
    assert.equal(r().aborted, true);
});

await testAsync('reports a mic that never opens', async () => {
    const { session, timers } = listenWith({ hold: true });
    timers.fire(2000);
    assert.equal((await session.promise).error, 'mic-timeout');
});

await testAsync('the mic-open timer stops once the mic opens', async () => {
    const { session, r, timers } = listenWith({ hold: true });
    r().onaudiostart();
    assert.equal(timers.has(2000), false);
    session.abort();
    await session.promise;
});

await testAsync('hands-free stops itself after silence if the browser does not', async () => {
    const { session, r, timers } = listenWith({ hold: false });
    r().onaudiostart();
    assert.equal(timers.has(10000), true);
    r().hear(['two']);
    timers.fire(2000);
    assert.equal(r().stopped, true);
    assert.deepEqual((await session.promise).alternatives, ['two']);
});

await testAsync('fatal errors come through and end a hold', async () => {
    const { Fake, session, r } = listenWith({ hold: true });
    r().onerror({ error: 'not-allowed' });
    r().onend();
    assert.equal((await session.promise).error, 'not-allowed');
    assert.equal(Fake.made.length, 1);
});

await testAsync('retries once without hints if they are rejected', async () => {
    const { Fake, session, r } = listenWith({ hold: false, hints: true, phrases: ['x'] });
    r().onerror({ error: 'phrases-not-supported' });
    r().onend();
    assert.equal(Fake.made.length, 2);
    r().onaudiostart();
    r().hear(['two']);
    r().onend();
    const { alternatives, hintsRejected } = await session.promise;
    assert.deepEqual(alternatives, ['two']);
    assert.equal(hintsRejected, true);
});

section('adding a node');

test('adds a node under its parent, as the last choice there', () => {
    const { data, id, errors } = addNode(tiny, { parent: 'a', title: ' Go straight on! ', text: ' Ahead. ' });
    assert.deepEqual(errors, []);
    assert.equal(id, 'go-straight-on');
    assert.deepEqual(data.nodes.at(-1), { id, title: 'Go straight on!', text: 'Ahead.', parent: 'a' });
    assert.equal(tiny.nodes.length, 4);    // the original is untouched
    const { story, errors: loadErrors } = loadStory(data);
    assert.deepEqual(loadErrors, []);
    assert.deepEqual(choicesOf(story, 'a').map(n => n.id), ['b', 'c', id]);
});

test('an ending stops being one when a node is added after it', () => {
    const { data, id } = addNode(tiny, { parent: 'd', title: 'Carry on', text: 'More.' });
    const { story } = loadStory(data);
    assert.equal(isEnding(story, 'd'), false);
    assert.equal(isEnding(story, id), true);
});

test('ids stay unique, and a title with no letters still gets one', () => {
    assert.equal(idFor('Go left', ['go-left']), 'go-left-2');
    assert.equal(idFor('Go left', ['go-left', 'go-left-2']), 'go-left-3');
    assert.equal(idFor('???', []), 'node');
    const { id } = addNode(tiny, { parent: 'a', title: 'A', text: 'x' });
    assert.equal(id, 'a-2');
});

test('refuses a blank title, blank text or an unknown parent', () => {
    assert.equal(addNode(tiny, { parent: 'a', title: ' ', text: 'x' }).errors.length, 1);
    assert.equal(addNode(tiny, { parent: 'a', title: 'x', text: '' }).errors.length, 1);
    const bad = addNode(tiny, { parent: 'nope', title: 'x', text: 'x' });
    assert.equal(bad.errors.length, 1);
    assert.equal(bad.data, tiny);
});

test('"add new node" is a command, however the recognizer spells it', () => {
    for (const said of ['add new node', 'Add new note', 'add a new node please', 'new node']) {
        assert.equal(commandFrom(said), 'add', said);
    }
    const choices = [{ id: 'b', title: 'Go left' }, { id: 'c', title: 'Go right' }];
    assert.deepEqual(match(['add new note'], choices).name, 'add');
    assert.equal(match(['add new node'], []).name, 'add');    // at an ending too
});

test('adding is never read out with the choices, only in help', () => {
    const choices = [{ id: 'b', title: 'Go left' }, { id: 'c', title: 'Go right' }];
    for (const list of [[], choices.slice(0, 1), choices]) {
        assert.doesNotMatch(choicesScript(list), /add|new node/i);
    }
    assert.match(HELP_SCRIPT, /add new node/);
});

section('dictating a node');

// Feeds utterances through the conversation; returns the last step.
function dictate(...utterances) {
    let step = { state: startCompose(), outcome: 'continue' };
    for (const said of utterances) step = composeStep(step.state, [].concat(said));
    return step;
}

test('title, read back, text in parts, read back, save', () => {
    assert.match(composePrompt(startCompose()), /title/i);
    let step = dictate('wait for the tide');
    assert.equal(step.state.stage, 'confirm-title');
    assert.match(step.say, /The title is: Wait for the tide\. Say keep it, try again, or cancel\./);
    step = dictate('wait for the tide', 'keep it', 'you sit and wait', 'The tide turns.');
    assert.equal(step.state.stage, 'text');
    assert.equal(step.say, 'Got it. Go on, or say done.');
    step = composeStep(step.state, ['done']);
    assert.equal(step.state.stage, 'confirm-text');
    assert.match(step.say, /Wait for the tide\. You sit and wait\. The tide turns\. Say keep it/);
    step = composeStep(step.state, ['Yes.']);
    assert.equal(step.outcome, 'save');
    assert.equal(step.state.title, 'Wait for the tide');
    assert.equal(composedText(step.state), 'You sit and wait. The tide turns.');
});

test('tidies what the recognizer gives: capitals and full stops', () => {
    assert.equal(tidyTitle('  the old  well. '), 'The old well');
    assert.equal(tidyChunk('it is dark'), 'It is dark.');
    assert.equal(tidyChunk('Who goes there?'), 'Who goes there?');
});

test('"try again" redoes the title, or the whole text', () => {
    let step = dictate('weight for the tied', 'try again');
    assert.equal(step.state.stage, 'title');
    assert.equal(step.state.title, '');
    step = dictate('a', 'yes', 'wrong words', 'done', 'no');
    assert.equal(step.state.stage, 'text');
    assert.deepEqual(step.state.chunks, []);
});

test('"scratch that" removes the last part only', () => {
    const step = dictate('a', 'keep', 'one', 'too', 'scratch that', 'two');
    assert.equal(composedText(step.state), 'One. Two.');
    assert.match(dictate('a', 'keep', 'undo').say, /nothing to remove/);
});

test('cancel works at every step and saves nothing', () => {
    assert.equal(dictate('cancel').outcome, 'cancel');
    assert.equal(dictate('a', 'never mind').outcome, 'cancel');
    assert.equal(dictate('a', 'keep', 'some text', 'cancel').outcome, 'cancel');
    assert.equal(dictate('a', 'keep', 'some text', 'done', 'cancel please').outcome, 'cancel');
});

test('commands count only as the whole utterance, in any guess', () => {
    const step = dictate('a', 'keep', 'the deed is done', 'no I will not cancel');
    assert.equal(step.outcome, 'continue');
    assert.equal(composedText(step.state), 'The deed is done. No I will not cancel.');
    assert.equal(dictate('a', 'keep', 'x', [['dun', 'done']][0]).state.stage, 'confirm-text');
});

test('"done" with no text, silence and unclear answers ask again', () => {
    assert.match(dictate('a', 'keep', 'done').say, /no text yet/);
    assert.equal(dictate('a', 'keep', 'done').state.stage, 'text');
    assert.match(composeStep(startCompose(), []).say, /didn't hear a title/);
    const unclear = dictate('a', 'purple');
    assert.equal(unclear.state.stage, 'confirm-title');
    assert.match(unclear.say, /didn't catch that.*The title is: A\./);
    assert.equal(dictate('a', 'keep', 'x', 'done', 'purple').outcome, 'continue');
});

test('coming back mid-text recaps what there is', () => {
    const { state } = dictate('a', 'keep', 'one');
    assert.match(composePrompt(state), /So far: One\. Go on, or say done\./);
    assert.ok(composeHints(state).includes('done'));
    assert.ok(composeHints(dictate('a').state).includes('keep it'));
});

test('a dictated node saves like a typed one', () => {
    const { state } = dictate('wait for the tide', 'keep it', 'you sit and wait', 'done', 'keep it');
    const { data, id, errors } = addNode(tiny, { parent: 'a', title: state.title, text: composedText(state) });
    assert.deepEqual(errors, []);
    assert.equal(id, 'wait-for-the-tide');
    assert.equal(data.nodes.at(-1).text, 'You sit and wait.');
});

section('several stories');

test('a new story is a title and an overview, which become its first page', () => {
    const { id, data, errors } = createStory({ title: ' The Old Well ', text: ' Something is down there. ' }, ['lighthouse']);
    assert.deepEqual(errors, []);
    assert.equal(id, 'the-old-well');
    assert.equal(data.title, 'The Old Well');
    assert.equal(overviewOf(data), 'Something is down there.');
    const { story, errors: loadErrors } = loadStory(data);
    assert.deepEqual(loadErrors, []);
    assert.equal(story.byId.get(story.start).title, 'The Old Well');
    // And it grows like any other story.
    const grown = addNode(data, { parent: data.start, title: 'Look down', text: 'Dark.' });
    assert.deepEqual(loadStory(grown.data).errors, []);
});

test('a new story needs both, and gets its own id', () => {
    assert.equal(createStory({ title: '', text: 'x' }).errors.length, 1);
    assert.equal(createStory({ title: 'x', text: ' ' }).errors.length, 1);
    assert.equal(createStory({ title: 'Lighthouse', text: 'x' }, ['lighthouse']).id, 'lighthouse-2');
});

test('lists built-in stories first, with your changes, then your own by title', () => {
    const made = (title) => createStory({ title, text: 'x' }).data;
    const list = listStories([{ id: 'tiny', data: tiny }, { id: 'other', data: made('Other') }],
        { zebra: made('Zebra'), tiny: { ...tiny, title: 'Tiny, extended' }, apple: made('Apple') });
    assert.deepEqual(list.map(s => [s.id, s.title, s.source]), [
        ['tiny', 'Tiny, extended', 'edited'],
        ['other', 'Other', 'builtin'],
        ['apple', 'Apple', 'local'],
        ['zebra', 'Zebra', 'local'],
    ]);
    assert.deepEqual(listStories([{ id: 'tiny', data: tiny }]).map(s => s.source), ['builtin']);
});

test('the overview is its own field if given, else the first page', () => {
    assert.equal(overviewOf(tiny), 'Begin.');
    assert.equal(overviewOf({ ...tiny, overview: 'A very small story.' }), 'A very small story.');
    assert.equal(overviewOf({}), '');
});

test('every story named in stories/index.json loads cleanly', () => {
    const ids = JSON.parse(readFileSync(new URL('../stories/index.json', import.meta.url), 'utf8'));
    assert.ok(ids.length > 0);
    for (const id of ids) {
        const data = JSON.parse(readFileSync(new URL(`../stories/${id}.json`, import.meta.url), 'utf8'));
        assert.deepEqual(loadStory(data).errors, [], id);
        assert.ok(data.title, id);
    }
});

test('"add new story" is a command and dictates like a node', () => {
    assert.equal(commandFrom('add new story'), 'story');
    assert.equal(commandFrom('new story please'), 'story');
    assert.equal(commandFrom('start over'), 'restart');
    assert.match(composePrompt(startCompose('story')), /new story/i);
    let step = { state: startCompose('story') };
    for (const said of ['the old well', 'keep it']) step = composeStep(step.state, [said]);
    assert.match(step.say, /overview/);
    for (const said of ['something is down there', 'done']) step = composeStep(step.state, [said]);
    assert.match(step.say, /Here's the story\. The old well\. Something is down there\./);
    assert.equal(composeStep(step.state, ['keep it']).outcome, 'save');
});

test('a story with only its first page says so instead of "The end"', () => {
    assert.match(choicesScript([], { blank: true }), /no more pages yet/);
    assert.match(choicesScript([]), /The end/);
});

section('model voice');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const LOUD = new Float32Array([0, 0.5, -0.4, 0]);

// A stand-in for the model's worker: records what it's sent, and the test
// answers by hand.
function fakeWorker() {
    const w = { sent: [], terminated: false, postMessage(m) { w.sent.push(m); }, terminate() { w.terminated = true; } };
    w.reply = (data) => w.onmessage({ data });
    w.speaks = () => w.sent.filter(m => m.type === 'speak');
    return w;
}

function modelWith() {
    const workers = [];
    const states = [];
    const model = createModelVoice({
        makeWorker: () => { workers.push(fakeWorker()); return workers.at(-1); },
        onChange: (s) => states.push(s),
    });
    return { model, workers, states, w: () => workers.at(-1) };
}

await testAsync('loads a size, reports progress, then makes clips one at a time', async () => {
    const { model, w, states } = modelWith();
    assert.equal(await model.clip('Too early.'), null);     // not loaded: the browser voice's job
    model.load('small');
    assert.deepEqual(w().sent[0], { type: 'load', dtype: 'q8', device: 'wasm' });
    assert.equal(await model.clip('Still loading.'), null);
    w().reply({ type: 'progress', file: 'model.onnx', loaded: 23 * 1048576, total: 92 * 1048576 });
    assert.equal(loadProgress(model.state().files).fraction, 0.25);
    assert.match(modelNote(model.state()), /23 of 92 MB/);
    w().reply({ type: 'ready', device: 'wasm' });
    assert.equal(states.at(-1).status, 'ready');

    const one = model.clip('One.', { rate: 1.2 });
    const two = model.clip('Two.');
    assert.equal(w().speaks().length, 1);                   // the second waits its turn
    assert.deepEqual(w().speaks()[0], { type: 'speak', id: 1, text: 'One.', voice: 'af_heart', speed: 1.2 });
    w().reply({ type: 'audio', id: 1, samples: LOUD, sampleRate: 24000 });
    assert.deepEqual(await one, { samples: LOUD, sampleRate: 24000 });
    w().reply({ type: 'failed', id: 2, message: 'no' });
    assert.equal(await two, null);
    // Asked again: from the cache, without the worker.
    assert.deepEqual(await model.clip('One.', { rate: 1.2 }), { samples: LOUD, sampleRate: 24000 });
    assert.equal(w().speaks().length, 2);
});

await testAsync('drop() lets go of waiting sentences but keeps the one in progress', async () => {
    const { model, w } = modelWith();
    model.load('large');
    assert.equal(w().sent[0].dtype, 'fp32');
    assert.equal(w().sent[0].device, 'webgpu');
    w().reply({ type: 'ready', device: 'webgpu' });
    const one = model.clip('One.');
    const two = model.clip('Two.');
    model.drop();
    assert.equal(await one, null);
    assert.equal(await two, null);
    w().reply({ type: 'audio', id: 1, samples: LOUD, sampleRate: 24000 });
    assert.deepEqual(await model.clip('One.'), { samples: LOUD, sampleRate: 24000 });   // kept for a Repeat
    assert.equal(w().speaks().length, 1);                   // "Two." was never sent
});

await testAsync('changing size or switching off ends the old worker; errors fall back', async () => {
    const { model, workers, w } = modelWith();
    model.load('small');
    w().reply({ type: 'ready', device: 'wasm' });
    const pending = model.clip('One.');
    model.load('large');
    assert.equal(workers[0].terminated, true);
    assert.equal(await pending, null);
    workers[0].reply?.({ type: 'ready', device: 'wasm' });  // a late word from the old one is ignored
    assert.equal(model.state().status, 'loading');
    w().reply({ type: 'error', message: 'offline' });
    assert.equal(model.state().status, 'failed');
    assert.match(modelNote(model.state()), /Couldn't load the model \(offline\)/);
    assert.equal(await model.clip('One.'), null);
    model.unload();
    assert.equal(model.state().status, 'off');
    assert.equal(modelNote(model.state()), '');
});

await testAsync('times each sentence, and treats silence or not-numbers as a failure', async () => {
    assert.deepEqual(clipStats({ samples: new Float32Array(24000).fill(0.25), sampleRate: 24000 }), { seconds: 1, peak: 0.25, ok: true });
    assert.equal(clipStats({ samples: new Float32Array(100), sampleRate: 24000 }).ok, false);
    assert.equal(clipStats({ samples: new Float32Array([0.5, NaN]), sampleRate: 24000 }).ok, false);
    assert.equal(timingNote(2.3, 6.6), '2.3 s of audio in 6.6 s (2.9× slower than it plays)');
    assert.match(timingNote(3, 1), /faster than it plays/);

    let clock = 0;
    const made = [];
    const workers = [];
    const model = createModelVoice({
        makeWorker: () => { workers.push(fakeWorker()); return workers.at(-1); },
        onClip: (c) => made.push(c),
        now: () => clock,
    });
    model.load('small');
    workers[0].reply({ type: 'ready', device: 'wasm' });
    const good = model.clip('Good.');
    clock = 4000;
    workers[0].reply({ type: 'audio', id: 1, samples: new Float32Array(48000).fill(0.3), sampleRate: 24000 });
    assert.ok(await good);
    assert.equal(made[0].took, 4);
    assert.equal(made[0].seconds, 2);
    assert.equal(made[0].ok, true);
    const silent = model.clip('Silent.');
    workers[0].reply({ type: 'audio', id: 2, samples: new Float32Array(100), sampleRate: 24000 });
    assert.equal(await silent, null);                       // the browser voice reads it instead
    assert.match(made[1].error, /silent/);
});

await testAsync('warm() makes clips ahead, behind real requests, and drop() forgets them', async () => {
    const { model, w } = modelWith();
    model.load('small');
    w().reply({ type: 'ready', device: 'wasm' });
    model.warm(['A.', 'B.', 'C.']);
    assert.equal(w().speaks().length, 1);
    w().reply({ type: 'audio', id: 1, samples: LOUD, sampleRate: 24000 });
    assert.equal(w().speaks().at(-1).text, 'B.');
    model.drop();
    w().reply({ type: 'audio', id: 2, samples: LOUD, sampleRate: 24000 });
    assert.equal(w().speaks().length, 2);                   // "C." was forgotten
    assert.ok(await model.clip('A.'));                      // already made
    assert.ok(await model.clip('B.'));
    assert.equal(w().speaks().length, 2);
});

await testAsync('says when it is waiting for a clip and when one is playing', async () => {
    const states = [];
    let endPlay = null;
    const speaker = createClipSpeaker({
        source: { clip: async (text) => text, drop() {} },
        player: { unlock() {}, play: () => new Promise((resolve) => { endPlay = resolve; }), stop() {} },
        fallback: { speak: async () => true, cancel() {} },
        onState: (s) => states.push(s),
    });
    const done = speaker.speak('One. Two.');
    await tick();
    assert.deepEqual(states, ['waiting', 'playing']);
    endPlay(true);
    await tick();
    endPlay(true);
    await done;
    assert.deepEqual(states, ['waiting', 'playing', 'waiting', 'playing']);
});

// A clip speaker over fakes: clips are just their sentence, and the test says
// when each one finishes playing.
function clipSpeakerWith({ missing = [] } = {}) {
    const log = [];
    let endPlay = null;
    const source = {
        clip: async (text) => { log.push(`clip ${text}`); return missing.includes(text) ? null : text; },
        drop: () => log.push('drop'),
    };
    const player = {
        unlock() {},
        play: (clip) => new Promise((resolve) => { log.push(`play ${clip}`); endPlay = resolve; }),
        stop: () => endPlay?.(false),
    };
    const fallback = { speak: async (text) => { log.push(`browser ${text}`); return true; }, cancel() {} };
    return { speaker: createClipSpeaker({ source, player, fallback }), log, end: (ok = true) => endPlay(ok) };
}

await testAsync('plays a sentence at a time, asking for every clip up front', async () => {
    const { speaker, log, end } = clipSpeakerWith();
    const done = speaker.speak('One. Two. Three.');
    await tick();
    assert.deepEqual(log.filter(l => !l.startsWith('drop')), ['clip One.', 'clip Two.', 'clip Three.', 'play One.']);
    assert.equal(speaker.position(), 0);
    end();
    await tick();
    assert.equal(speaker.position(), 1);
    end();
    await tick();
    end();
    assert.equal(await done, true);
    assert.equal(speaker.position(), 3);
});

await testAsync('a sentence with no clip is read by the browser voice instead', async () => {
    const { speaker, log, end } = clipSpeakerWith({ missing: ['Two.'] });
    const done = speaker.speak('One. Two.');
    await tick();
    end();
    assert.equal(await done, true);
    assert.deepEqual(log.filter(l => /^(play|browser)/.test(l)), ['play One.', 'browser Two.']);
});

await testAsync('a clip that fails to play is read by the browser voice too', async () => {
    const { speaker, log, end } = clipSpeakerWith();
    const done = speaker.speak('One.');
    await tick();
    end(false);
    assert.equal(await done, true);
    assert.deepEqual(log.filter(l => /^(play|browser)/.test(l)), ['play One.', 'browser One.']);
});

await testAsync('cancel stops at once and keeps the place for a resume', async () => {
    const { speaker, log, end } = clipSpeakerWith();
    const done = speaker.speak('One. Two. Three.');
    await tick();
    end();
    await tick();
    assert.equal(speaker.position(), 1);
    speaker.cancel();
    assert.equal(await done, false);
    assert.equal(speaker.position(), 1);
    assert.ok(!log.includes('browser Two.'));
    log.length = 0;
    speaker.speak('One. Two. Three.', { from: speaker.position() });
    await tick();
    assert.ok(log.includes('play Two.'));
});

section('editing a node');

test('changes the title and text, and nothing else', () => {
    const { data, errors } = editNode(tiny, 'b', { title: ' Turn left ', text: ' A new left. ' });
    assert.deepEqual(errors, []);
    assert.deepEqual(data.nodes[1], { id: 'b', title: 'Turn left', text: 'A new left.', parent: 'a' });
    assert.equal(tiny.nodes[1].title, 'Go left');           // the original is untouched
    assert.equal(data.title, 'Tiny');
    const { story } = loadStory(data);
    assert.deepEqual(choicesOf(story, 'a').map(n => n.title), ['Turn left', 'Go right']);
    assert.deepEqual(choicesOf(story, 'b').map(n => n.id), ['d']);
});

test('a story named after its first page is renamed with it', () => {
    const { data: made } = createStory({ title: 'The Old Well', text: 'x' });
    assert.equal(editNode(made, 'start', { title: 'The New Well', text: 'y' }).data.title, 'The New Well');
    assert.equal(editNode(tiny, 'a', { title: 'Beginning', text: 'y' }).data.title, 'Tiny');   // had its own name
});

test('refuses a blank title or text, or a node that is not there', () => {
    assert.equal(editNode(tiny, 'b', { title: '', text: 'x' }).errors.length, 1);
    assert.equal(editNode(tiny, 'b', { title: 'x', text: ' ' }).errors.length, 1);
    const bad = editNode(tiny, 'nope', { title: 'x', text: 'x' });
    assert.equal(bad.errors.length, 1);
    assert.equal(bad.data, tiny);
});

test('"edit this node" is a command, never read with the choices', () => {
    for (const said of ['edit this node', 'Edit this note.', 'edit node please', 'edit']) assert.equal(commandFrom(said), 'edit', said);
    assert.doesNotMatch(choicesScript([{ id: 'b', title: 'Go left' }, { id: 'c', title: 'Go right' }]), /edit/i);
    assert.match(HELP_SCRIPT, /edit this node/);
});

// Feeds utterances through an edit of { Go left / Left. }.
function redo(...utterances) {
    let step = { state: startCompose('edit', { title: 'Go left', text: 'Left.' }), outcome: 'continue' };
    for (const said of utterances) step = composeStep(step.state, [said]);
    return step;
}

test('editing by voice asks the same questions, starting from what is there', () => {
    assert.match(composePrompt(redo().state), /Its title is: Go left\. Say the new title, or say keep it\./);
    let step = redo('turn left', 'keep it');
    assert.equal(step.state.stage, 'text');
    assert.match(step.say, /Say keep it to leave it as it is/);
    step = redo('turn left', 'keep it', 'a new left', 'done');
    assert.match(step.say, /Here's the page\. Turn left\. A new left\. Say keep it/);
    step = composeStep(step.state, ['keep it']);
    assert.equal(step.outcome, 'save');
    assert.equal(step.say, 'Saved.');
    assert.equal(step.state.title, 'Turn left');
    assert.equal(composedText(step.state), 'A new left.');
});

test('"keep it" leaves the title, the text, or both as they were', () => {
    let step = redo('keep it');
    assert.equal(step.state.stage, 'text');
    assert.equal(step.state.title, 'Go left');
    step = redo('turn left', 'yes', 'keep it');
    assert.equal(step.state.stage, 'confirm-text');
    assert.equal(composedText(step.state), 'Left.');
    assert.equal(redo('keep it', 'keep it', 'keep it').outcome, 'save');
    // Once new text has started, "keep it" is just words.
    assert.equal(composedText(redo('keep it', 'new words', 'keep it').state), 'New words. Keep it.');
    // And it means nothing special when making a new node.
    assert.equal(composeStep(startCompose(), ['keep it']).state.title, 'Keep it');
});

test('cancelling an edit changes nothing', () => {
    assert.equal(redo('cancel').outcome, 'cancel');
    assert.equal(redo('cancel').say, 'Okay, nothing changed.');
    assert.equal(redo('keep it', 'cancel').outcome, 'cancel');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
