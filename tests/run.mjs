// Unit tests for the pure modules. Run: node tests/run.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadStory, choicesOf, isEnding, parentsOf } from '../src/story.js';
import { match, numberFrom, commandFrom, titleHits, hintPhrases, normalize } from '../src/matcher.js';
import { layoutGraph } from '../src/layout.js';
import { sentences, rankVoices, mergeSegments, listenOnce, createSpeaker } from '../src/speech.js';
import { pageScript, choicesScript, numberWord, retryScript } from '../src/script.js';
import { createLog, matchLines } from '../src/voicelog.js';
import { angleAt, createSweep } from '../src/arc.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
