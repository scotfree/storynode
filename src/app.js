// StoryNode: one page, three modes that share your place in the story.
//   #map   — the whole story's shape (titles only); click a node to read it
//   #read  — a page of text, with the choices as buttons
//   #voice — a big button: it reads the page and the choices, then listens

import { loadStory, choicesOf, isEnding } from './story.js';
import { layoutGraph } from './layout.js';
import { match, hintPhrases } from './matcher.js';
import { createSpeaker, listenOnce, support, rankVoices } from './speech.js';
import { pageScript, choicesScript, HELP_SCRIPT, retryScript } from './script.js';
import { createLog, formatEntry, matchLines } from './voicelog.js';
import { createSweep } from './arc.js';

const SAMPLE_URL = 'stories/lighthouse.json';
const STORY_KEY = 'storynode_story';   // a story opened from a file
const VOICE_KEY = 'storynode_voice';   // { name, rate, auto }
const MAX_RETRIES = 2;
const HOLD_MIN_MS = 250;       // a shorter press is a tap, not an answer
const ARC_DEGREES = 180;       // how far the arc controls must be dragged

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, text) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
};
const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
};

const speaker = createSpeaker();
const can = support();

let story = null;
let currentId = null;
let history = [];              // ids before the current one, for Back
const visited = new Set();

// --- storage (wrapped: private windows can refuse it) ---

function readJson(key) {
    try {
        return JSON.parse(localStorage.getItem(key));
    } catch {
        return null;
    }
}

function writeJson(key, value) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Not saved; fine for a prototype.
    }
}

// --- story and position ---

function useStory(data) {
    const { story: loaded, errors } = loadStory(data);
    if (errors.length) return errors;
    story = loaded;
    history = [];
    visited.clear();
    goTo(story.start, { remember: false });
    return [];
}

function goTo(id, { remember = true } = {}) {
    if (!story.byId.has(id)) return;
    if (remember && currentId && currentId !== id) history.push(currentId);
    currentId = id;
    visited.add(id);
    render();
}

function goBack() {
    if (history.length === 0) return false;
    currentId = history.pop();
    render();
    return true;
}

function restart() {
    history = [];
    goTo(story.start, { remember: false });
}

const node = () => story.byId.get(currentId);
const choices = () => choicesOf(story, currentId);

// --- modes ---

const MODES = ['map', 'read', 'voice'];

function mode() {
    const m = location.hash.replace('#', '');
    return MODES.includes(m) ? m : 'read';
}

function render() {
    const m = mode();
    for (const name of MODES) $(`${name}-view`).hidden = name !== m;
    for (const a of document.querySelectorAll('.tabs a')) {
        if (a.dataset.mode === m) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    }
    if (!story) return;
    document.title = `${story.title} · StoryNode`;
    if (m === 'map') renderMap();
    if (m === 'read') renderRead();
    if (m === 'voice') renderVoice();
}

// --- map ---

function shorten(title, max = 24) {
    return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function renderMap() {
    $('map-title').textContent = story.title;
    const layout = layoutGraph(story);
    const svg = $('map');
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    svg.setAttribute('width', layout.width);
    svg.setAttribute('height', layout.height);
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(svgEl('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arrow' }));
    defs.append(marker);

    const edges = layout.edges.map(({ x1, y1, x2, y2 }) => {
        const mid = (y1 + y2) / 2;
        return svgEl('path', { class: 'edge', d: `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2 - 2}`, 'marker-end': 'url(#arrow)' });
    });

    const nodes = layout.nodes.map((box) => {
        const classes = ['node'];
        if (box.id === currentId) classes.push('current');
        else if (visited.has(box.id)) classes.push('visited');
        if (isEnding(story, box.id)) classes.push('ending');
        const g = svgEl('g', { class: classes.join(' '), tabindex: 0, role: 'button', 'aria-label': box.title });
        const title = svgEl('title');
        title.textContent = box.title;
        const rect = svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h });
        const text = svgEl('text', { x: box.x + box.w / 2, y: box.y + box.h / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        text.textContent = shorten(box.title);
        g.append(title, rect, text);
        const open = () => {
            goTo(box.id);
            location.hash = '#read';
        };
        g.addEventListener('click', open);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(); });
        return g;
    });

    svg.replaceChildren(defs, ...edges, ...nodes);
    // Keep the current node in view.
    const current = layout.nodes.find(b => b.id === currentId);
    if (current) {
        const scroller = svg.parentElement;
        scroller.scrollLeft = Math.max(0, current.x + current.w / 2 - scroller.clientWidth / 2);
    }
}

// --- read ---

function renderRead() {
    const n = node();
    $('read-title').textContent = n.title;
    $('read-text').replaceChildren(...n.text.split(/\n{2,}/).map(p => el('p', {}, p)));
    const list = choices();
    $('read-choices').replaceChildren(...list.map((c, i) => {
        const li = el('li');
        const b = el('button');
        b.append(el('span', { class: 'num' }, `${i + 1}.`), c.title);
        b.addEventListener('click', () => {
            goTo(c.id);
            window.scrollTo(0, 0);
        });
        li.append(b);
        return li;
    }));
    $('read-end').hidden = list.length > 0;
    $('read-back').disabled = history.length === 0;
}

// --- voice ---
//
// A small loop: read the page, read the choices, wait for an answer, act,
// repeat. `run` is bumped whenever the user interrupts or leaves voice mode,
// so an older loop that's still awaiting speech stops quietly.
//
// Two ways to answer. Hold To Talk: listens while the button is held and
// submits on release. Hands-free: the mic opens after reading and a pause
// ends it, and a tap stops everything. The first press in either mode is a
// tap that starts the reading.
//
// `stage` and the speaker's position say where we are ('page', 'choices' or
// 'answer'), so Stop can be undone by picking up at the same sentence.

const voice = {
    state: 'idle', run: 0, listening: null, retries: 0, started: false, pressedAt: 0,
    handsFree: false, stage: 'page', resume: null,
};
const voiceLog = createLog();

const handsFree = () => voice.handsFree;

function addLog(kind, text) {
    voiceLog.add(kind, text);
    if ($('log-dialog').open) renderLog();
}

function renderLog() {
    const list = $('log-list');
    list.replaceChildren(...voiceLog.entries().map(e => el('li', { class: `log-${e.kind}` }, formatEntry(e))));
    list.scrollTop = list.scrollHeight;
}

function setVoiceState(state, status = '') {
    voice.state = state;
    const talk = $('talk');
    talk.classList.toggle('listening', state === 'listening');
    talk.classList.toggle('reading', state === 'reading');
    talk.classList.toggle('busy', state === 'opening' || state === 'checking');
    const [label, sub] = talkLabel(state);
    talk.textContent = label;
    if (sub) talk.append(el('span', { class: 'talk-sub' }, sub));
    $('voice-status').textContent = status;
    $('repeat-arc').disabled = !voice.started;
    $('restart-arc').disabled = !voice.started;
}

function talkLabel(state) {
    if (state === 'listening') return handsFree() ? ['Listening…', '(tap to stop)'] : ['Listening…'];
    if (state === 'checking') return ['Checking…'];
    if (!handsFree()) return ['Hold To Talk'];
    return [state === 'idle' ? 'START' : 'STOP'];
}

const startHint = () => (handsFree()
    ? 'Tap START, then answer out loud when it asks.'
    : 'Tap once to hear the story, then hold the button to answer.');

const placeNow = () => ({ id: currentId, stage: voice.stage, sentence: speaker.position() });

function renderVoice() {
    const n = node();
    $('voice-title').textContent = n.title;
    const list = choices();
    // The choices are always tappable too: a fallback, and handy on a desk.
    $('voice-choices').replaceChildren(...list.map((c, i) => {
        const li = el('li');
        const b = el('button', {}, `${i + 1}. ${c.title}`);
        b.addEventListener('click', () => {
            stopVoice();
            goTo(c.id);
            voiceLoop(++voice.run);
        });
        li.append(b);
        return li;
    }));
    if (voice.state === 'idle') setVoiceState('idle', voice.started ? '' : startHint());
}

function stopVoice() {
    voice.run++;
    speaker.cancel();
    voice.listening?.abort();
    voice.listening = null;
}

async function say(text, run, from = 0) {
    setVoiceState('reading', voice.state === 'reading' ? $('voice-status').textContent : '');
    const done = await speaker.speak(text, { from });
    return done && run === voice.run;
}

// After speaking: hands-free opens the mic, Hold To Talk waits for a press.
function awaitAnswer(run) {
    if (handsFree()) listen(run);
    else setVoiceState('idle', 'Hold the button to answer.');
}

// Reads the page and the choices, then waits for an answer. `from` picks up
// at a saved place instead of the top.
async function voiceLoop(run, { skipPage = false, from = null } = {}) {
    voice.started = true;
    voice.retries = 0;
    voice.resume = null;
    const stage = from?.stage ?? (skipPage ? 'choices' : 'page');
    if (stage === 'page') {
        voice.stage = 'page';
        setVoiceState('reading', 'Reading…');
        if (!(await say(pageScript(node()), run, from?.sentence ?? 0))) return;
    }
    if (stage === 'page' || stage === 'choices') {
        voice.stage = 'choices';
        setVoiceState('reading', 'Your choices…');
        if (!(await say(choicesScript(choices()), run, stage === 'choices' ? (from?.sentence ?? 0) : 0))) return;
    }
    voice.stage = 'answer';
    awaitAnswer(run);
}

const LISTEN_ERRORS = {
    'not-allowed': 'The microphone is blocked. Allow it for this page, then try again.',
    'service-not-allowed': 'Speech recognition is off. On a Mac or iPhone, check Siri and Dictation settings.',
    'audio-capture': "Couldn't find a microphone.",
    network: "Couldn't reach the speech service. Check your connection.",
    'mic-timeout': "The microphone didn't open. Allow it if asked, then try again.",
    'language-not-supported': "This browser can't recognize English here.",
    'start-failed': "Couldn't start listening. Try again.",
    InvalidStateError: "Couldn't start listening. Try again.",
};

function describeOutcome(result, list) {
    if (result.kind === 'choice') return list[result.index].title;
    if (result.kind === 'command') return `command: ${result.name}`;
    return 'no match';
}

async function listen(run, { hold = false } = {}) {
    if (!can.listen) {
        setVoiceState('idle', "This browser can't listen. Tap a choice below, or try Chrome or Safari.");
        return;
    }
    const list = choices();
    setVoiceState('opening', 'Getting the microphone…');
    addLog('listen', `${hold ? 'hold' : 'hands-free'}, choices: ${list.map((c, i) => `${i + 1}. ${c.title}`).join('; ') || 'none'}`);
    $('voice-heard').textContent = '';

    const session = listenOnce({
        phrases: hintPhrases(list),
        hold,
        hints: can.hints,
        onEvent: (name, detail) => {
            addLog(name === 'error' ? 'error' : 'mic', detail ? `${name}: ${detail}` : name);
            if (name === 'mic-open' && run === voice.run && voice.state === 'opening') {
                setVoiceState('listening', hold ? 'Listening. Let go when you’re done.' : 'Listening…');
            }
        },
        onInterim: (text) => {
            addLog('interim', text);
            if (run === voice.run) $('voice-heard').textContent = text;
        },
    });
    voice.listening = session;
    const { alternatives, segments, error, hintsRejected } = await session.promise;
    if (voice.listening === session) voice.listening = null;
    if (hintsRejected) can.hints = false;
    if (run !== voice.run) return;

    if (segments.length > 1) addLog('guesses', `segments: ${segments.map(s => `[${s.join(' | ')}]`).join(' ')}`);
    addLog('guesses', alternatives.length ? alternatives.join(' | ') : `nothing heard (${error})`);

    if (LISTEN_ERRORS[error]) {
        addLog('error', error);
        setVoiceState('idle', LISTEN_ERRORS[error]);
        return;
    }

    const result = match(alternatives, list);
    matchLines(result).forEach(line => addLog('match', line));
    addLog('result', describeOutcome(result, list));
    $('voice-heard').textContent = alternatives[0]
        ? `“${alternatives[0]}” → ${describeOutcome(result, list)}`
        : 'Nothing heard';

    if (result.kind === 'choice') {
        const picked = $('voice-choices').children[result.index]?.querySelector('button');
        picked?.classList.add('picked');
        goTo(result.id);
        voiceLoop(run);
        return;
    }
    if (result.kind === 'command') {
        await command(result.name, run);
        return;
    }
    // Didn't catch it. Hands-free gives up after a few tries; with a button
    // there's always a next press, so it always says something.
    voice.retries++;
    if (handsFree() && voice.retries > MAX_RETRIES) {
        setVoiceState('idle', 'Tap to try again.');
        return;
    }
    if (!(await say(retryScript(Math.min(voice.retries, MAX_RETRIES), { hold: !handsFree() }), run))) return;
    if (!handsFree()) setVoiceState('idle', 'Hold the button to answer.');
    else if (voice.retries < MAX_RETRIES) listen(run);
    else setVoiceState('idle', 'Tap to try again.');
}

async function command(name, run) {
    switch (name) {
        case 'repeat':
            return voiceLoop(run);
        case 'choices':
            return voiceLoop(run, { skipPage: true });
        case 'back':
            if (!goBack()) {
                if (!(await say("You're at the beginning.", run))) return;
                return awaitAnswer(run);
            }
            return voiceLoop(run);
        case 'restart':
            restart();
            return voiceLoop(run);
        case 'help':
            if (!(await say(HELP_SCRIPT, run))) return;
            return awaitAnswer(run);
        case 'stop':
        default:
            stopVoice();
            setVoiceState('idle', handsFree() ? 'Paused. Tap to carry on.' : 'Paused. Hold the button to answer.');
    }
}

// First start: unlock speech inside the tap, ask for the mic so the prompt
// doesn't land on the first hold, then read.
async function firstStart() {
    voice.started = true;
    stopVoice();
    const run = voice.run;
    speaker.unlock();
    if (can.listen && navigator.mediaDevices?.getUserMedia) {
        setVoiceState('reading', 'Allow the microphone to answer by voice.');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
            addLog('mic', 'permission granted');
        } catch (error) {
            addLog('error', `permission: ${error.name}`);
        }
        if (run !== voice.run) return;
    }
    voiceLoop(run);
}

// Taps: the first start in either mode, and START/STOP in hands-free.
function onTalkTap() {
    if (!voice.started) {
        firstStart();
        return;
    }
    if (!handsFree()) return;
    if (voice.state !== 'idle') {
        const place = placeNow();
        addLog('mic', `stopped at ${place.stage}, sentence ${place.sentence + 1}`);
        stopVoice();
        voice.resume = place;
        setVoiceState('idle', 'Stopped. Tap START to carry on.');
        return;
    }
    stopVoice();
    const run = voice.run;
    const from = voice.resume?.id === currentId ? voice.resume : null;
    voice.resume = null;
    if (from) voiceLoop(run, { from });
    else listen(run);
}

// The dial's position and the words above the button show the mode.
function syncDial() {
    $('mode-knob').style.setProperty('--a', `${dialRest()}deg`);
    $('voice-mode').textContent = handsFree() ? 'Hands Free' : 'Hold to Talk';
}

const dialRest = () => (handsFree() ? 180 : 0);

function toggleHandsFree() {
    const place = placeNow();
    stopVoice();
    voice.handsFree = !voice.handsFree;
    voice.resume = place;
    saveVoiceSettings();
    syncDial();
    addLog('mic', `mode: ${handsFree() ? 'hands free' : 'hold to talk'}`);
    setVoiceState('idle', voice.started ? '' : startHint());
}

function repeatNode() {
    stopVoice();
    voiceLoop(voice.run);
}

function restartStory() {
    stopVoice();
    restart();
    voiceLoop(voice.run);
}

// --- arc controls ---
//
// Repeat, Restart and the mode dial are all confirmed by dragging them half
// way around the big button. Degrees run clockwise from the top.

function polar(degrees, radius) {
    const a = degrees * Math.PI / 180;
    return `${(radius * Math.sin(a)).toFixed(1)} ${(-radius * Math.cos(a)).toFixed(1)}`;
}

function arcPath(radius, from, to) {
    if (from === to) return '';
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const clockwise = to > from ? 1 : 0;
    return `M${polar(from, radius)} A${radius} ${radius} 0 ${large} ${clockwise} ${polar(to, radius)}`;
}

function showArcGuide(radius, rest, direction) {
    const svg = $('arc-guide');
    const size = $('talk-stage').clientWidth;
    svg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`);
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'arc-arrow', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto' });
    marker.append(svgEl('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arc-head' }));
    defs.append(marker);
    // The dial can go either way, so it shows its whole circle.
    const track = direction === 0
        ? svgEl('circle', { class: 'arc-track', r: radius, cx: 0, cy: 0 })
        : svgEl('path', { class: 'arc-track', d: arcPath(radius, rest, rest + direction * ARC_DEGREES), 'marker-end': 'url(#arc-arrow)' });
    svg.replaceChildren(defs, track, svgEl('path', { id: 'arc-fill', class: 'arc-fill' }));
    svg.removeAttribute('hidden');
}

function setUpArcControl({ element, rest, direction, fire, springBack = true }) {
    let tracker = null;
    let radius = 0;
    const setAngle = (degrees) => element.style.setProperty('--a', `${degrees}deg`);

    const release = ({ fired = false } = {}) => {
        tracker = null;
        $('arc-guide').setAttribute('hidden', '');
        if (fired && !springBack) {
            setAngle(rest());           // already there: no animation
            void element.offsetWidth;   // apply it before transitions return
            element.classList.remove('dragging');
        } else {
            element.classList.remove('dragging');
            setAngle(rest());           // animates back along the circle
        }
    };

    element.addEventListener('pointerdown', (e) => {
        const stage = $('talk-stage').getBoundingClientRect();
        const own = element.getBoundingClientRect();
        const cx = stage.left + stage.width / 2;
        const cy = stage.top + stage.height / 2;
        radius = Math.hypot(own.left + own.width / 2 - cx, own.top + own.height / 2 - cy);
        tracker = createSweep({ cx, cy, startX: e.clientX, startY: e.clientY, direction, target: ARC_DEGREES });
        element.setPointerCapture(e.pointerId);
        element.classList.add('dragging');
        showArcGuide(radius, rest(), direction);
    });
    element.addEventListener('pointermove', (e) => {
        if (!tracker) return;
        const { sweep, fired } = tracker.update(e.clientX, e.clientY);
        const angle = rest() + sweep;
        setAngle(angle);
        $('arc-fill').setAttribute('d', arcPath(radius, rest(), angle));
        if (fired) {
            fire();
            release({ fired: true });
        }
    });
    element.addEventListener('pointerup', () => { if (tracker) release(); });
    element.addEventListener('pointercancel', () => { if (tracker) release(); });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    // No way to drag from a keyboard: Enter or space on a focused control acts at once.
    element.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        fire();
    });
}

function setUpArcControls() {
    setUpArcControl({ element: $('restart-arc'), rest: () => 225, direction: 1, fire: restartStory });
    setUpArcControl({ element: $('repeat-arc'), rest: () => 135, direction: -1, fire: repeatNode });
    setUpArcControl({ element: $('mode-knob'), rest: dialRest, direction: 0, fire: toggleHandsFree, springBack: false });
}

const holdsApply = () => voice.started && !handsFree();

// Press: stop any reading and listen until release.
function onTalkDown() {
    if (!holdsApply()) return;
    voice.pressedAt = performance.now();
    stopVoice();
    listen(voice.run, { hold: true });
}

// Release: submit what was heard. A very short press was a mistaken tap.
function onTalkUp() {
    if (!holdsApply() || !voice.listening) return;
    if (performance.now() - voice.pressedAt < HOLD_MIN_MS) {
        stopVoice();
        setVoiceState('idle', 'Hold the button while you talk.');
        return;
    }
    setVoiceState('checking', 'Checking…');
    voice.listening.stop();
}

function onTalkCancel() {
    if (!holdsApply() || !voice.listening) return;
    addLog('mic', 'press cancelled by the system');
    stopVoice();
    setVoiceState('idle', 'That press was interrupted. Hold the button to answer.');
}

function setUpTalkButton() {
    const talk = $('talk');
    talk.addEventListener('click', onTalkTap);
    talk.addEventListener('pointerdown', (e) => {
        talk.setPointerCapture(e.pointerId);    // sliding off the button keeps listening
        onTalkDown();
    });
    talk.addEventListener('pointerup', onTalkUp);
    talk.addEventListener('pointercancel', onTalkCancel);
    talk.addEventListener('contextmenu', (e) => e.preventDefault());
    // The space bar holds too. Enter still clicks.
    talk.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat) onTalkDown(); });
    talk.addEventListener('keyup', (e) => { if (e.code === 'Space') onTalkUp(); });
}

function setUpVoiceLog() {
    const dialog = $('log-dialog');
    $('voice-panel').addEventListener('click', () => {
        renderLog();
        dialog.showModal();
        renderLog();    // scroll to the end now it has a height
    });
    $('log-close').addEventListener('click', () => dialog.close());
    $('log-copy').addEventListener('click', async () => {
        const button = $('log-copy');
        try {
            await navigator.clipboard.writeText(voiceLog.entries().map(formatEntry).join('\n'));
            button.textContent = 'Copied';
        } catch {
            button.textContent = "Couldn't copy";
        }
        setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
}

function saveVoiceSettings() {
    writeJson(VOICE_KEY, { name: $('voice-select').value, rate: Number($('voice-rate').value), auto: voice.handsFree });
}

function setUpVoiceSettings() {
    const saved = readJson(VOICE_KEY) ?? {};
    const select = $('voice-select');
    const fill = () => {
        const voices = rankVoices(speaker.voices());
        if (voices.length === 0) return;
        const chosen = voices.find(v => v.name === saved.name) ?? voices[0];
        select.replaceChildren(...voices.map(v => new Option(`${v.name} (${v.lang})`, v.name, false, v === chosen)));
        speaker.setVoice(chosen);
    };
    fill();
    if (globalThis.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', fill);
    const save = saveVoiceSettings;
    select.addEventListener('change', () => {
        speaker.setVoice(speaker.voices().find(v => v.name === select.value) ?? null);
        save();
    });
    $('voice-rate').value = saved.rate ?? 1;
    speaker.setRate(Number($('voice-rate').value));
    $('voice-rate').addEventListener('input', () => {
        speaker.setRate(Number($('voice-rate').value));
        save();
    });
    voice.handsFree = saved.auto ?? false;
    syncDial();

    $('voice-support').textContent = [
        can.speak ? 'Reading aloud: yes.' : "Reading aloud: this browser can't.",
        can.listen ? 'Listening: yes.' : "Listening: this browser can't (try Chrome or Safari).",
        can.hints ? 'Choice hints: yes.' : 'Choice hints: not in this browser (matching still works).',
    ].join(' ');
}

// --- story dialog ---

function setUpStoryDialog() {
    const dialog = $('story-dialog');
    const showErrors = (errors) => {
        $('story-errors').textContent = errors.join('\n');
        $('story-errors').hidden = errors.length === 0;
    };
    $('story-button').addEventListener('click', () => {
        $('dialog-title').textContent = story?.title ?? 'Story';
        showErrors([]);
        dialog.showModal();
    });
    $('story-close').addEventListener('click', () => dialog.close());
    $('story-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        let data;
        try {
            data = JSON.parse(await file.text());
        } catch (error) {
            showErrors([`That isn't valid JSON: ${error.message}`]);
            return;
        }
        const errors = useStory(data);
        if (errors.length) {
            showErrors(errors);
            return;
        }
        writeJson(STORY_KEY, data);
        dialog.close();
    });
    $('story-sample').addEventListener('click', async () => {
        writeJson(STORY_KEY, null);
        await loadSample();
        dialog.close();
    });
}

async function loadSample() {
    const response = await fetch(SAMPLE_URL);
    return useStory(await response.json());
}

// --- boot ---

async function boot() {
    setUpVoiceSettings();
    setUpStoryDialog();
    setUpTalkButton();
    setUpArcControls();
    setUpVoiceLog();
    $('read-back').addEventListener('click', goBack);
    $('read-restart').addEventListener('click', restart);
    window.addEventListener('hashchange', () => {
        if (mode() !== 'voice') {
            stopVoice();
            setVoiceState('idle');
        }
        render();
    });

    const saved = readJson(STORY_KEY);
    const errors = saved ? useStory(saved) : [];
    if (!saved || errors.length) {
        try {
            await loadSample();
        } catch (error) {
            document.querySelector('main').prepend(el('p', { class: 'errors' }, `Couldn't load the sample story: ${error.message}. Serve this folder over http (see README).`));
        }
    }
    render();
}

boot();
