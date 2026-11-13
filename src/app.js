// StoryNode: one page, three modes that share your place in the story.
//   #map   — the whole story's shape (titles only); click a node to read it
//   #read  — a page of text, with the choices as buttons
//   #voice — a big button: it reads the page and the choices, then listens

import { loadStory, choicesOf, isEnding, addNode, editNode, connectNode, connectable, idFor } from './story.js';
import { layoutGraph, forceLayout, fisheyeLayout, zoomRange, clampZoom, zoomAround } from './layout.js';
import { match, hintPhrases } from './matcher.js';
import { createSpeaker, listenOnce, support, rankVoices, sentences } from './speech.js';
import { pageScript, choicesPrompt, fallbackScript, storySentences, voiceParts, HELP_SCRIPT, retryScript, ADD_LABEL, EDIT_LABEL, CONNECT_LABEL } from './script.js';
import { createLog, formatEntry, matchLines } from './voicelog.js';
import { createSweep } from './arc.js';
import { startConnect, connectStep, connectPrompt, connectStatus } from './connect.js';
import { createClipSpeaker } from './clipspeaker.js';
import { createModelVoice, modelNote, loadProgress, timingNote, MODEL_SIZES, MODEL_VOICES } from './modelvoice.js';
import { createPlayer } from './player.js';
import { createCloudVoice, cloudNote, CLOUD, CLOUD_VOICES } from './cloudvoice.js';
import { createStory, listStories, overviewOf, NEW_STORY_LABEL } from './library.js';
import { startCompose, composeStep, composePrompt, composeBrief, promptKey, composeStatus, composeHints, composedText } from './compose.js';

const STORIES_URL = 'stories/';         // index.json there names the built-in stories
const LIBRARY_KEY = 'storynode_library';   // { stories: { id: data }, current: id }
const OLD_STORY_KEY = 'storynode_story';   // from before there were several
const NEW_STORY = '+new';              // the dropdown's last option
const CLOUD_KEY = 'storynode_cloud';   // { key, characters }: the listener's own API key, and how much it's been used
const HEARD_KEY = 'storynode_heard';   // the prompts whose full explanation has been read out
const HELP_AFTER_MS = 15000;   // Hold To Talk: a brief prompt, then this long with no press, gets the full one
const VOICE_KEY = 'storynode_voice';   // { name, rate, auto }
const MAX_RETRIES = 2;
const HOLD_MIN_MS = 250;       // a shorter press is a tap, not an answer
const ARC_DEGREES = 180;       // how far the arc controls must be dragged
const DIAL_ARROW_DEGREES = 128; // the dial's arrows stop short of the label they point at

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

// Two ways to read aloud, with the same controls: the browser's own voice, and
// a model that runs in the page and plays clips (falling back to the browser
// voice for anything it can't do yet). `speaker` is whichever is switched on.
const browserSpeaker = createSpeaker();
const modelVoice = createModelVoice({
    makeWorker: () => new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module' }),
    onChange: (state) => showModelState(state),
    // Every sentence the model makes goes in the voice log, with how long it took.
    onClip: ({ text, seconds, took, peak, ok, error }) => addLog(ok ? 'model' : 'error',
        ok ? `${timingNote(seconds, took)}, peak ${peak.toFixed(2)}: “${text}”` : `model: ${error} after ${took.toFixed(1)} s: “${text}”`),
});
// Every clip's fate goes in the voice log, so silence can be traced.
const player = createPlayer({
    onEvent: (name, detail) => addLog(name === 'played' ? 'mic' : 'error', `audio ${name}: ${detail}`),
});
const modelSpeaker = createClipSpeaker({
    source: modelVoice,
    player,
    fallback: browserSpeaker,
    onState: (state) => showMakingVoice(state === 'waiting'),
});
// And a speech service, with the listener's own key. Same clip speaker, other source.
const cloudVoice = createCloudVoice({
    characters: readJson(CLOUD_KEY)?.characters ?? 0,
    onChange: (state) => showCloudState(state),
    onClip: ({ text, seconds, took, ok, error }) => addLog(ok ? 'cloud' : 'error',
        ok ? `${seconds.toFixed(1)} s of audio in ${took.toFixed(1)} s: “${text}”` : `cloud: ${error}: “${text}”`),
});
const cloudSpeaker = createClipSpeaker({
    source: cloudVoice,
    player,
    fallback: browserSpeaker,
    onState: (state) => showMakingVoice(state === 'waiting'),
});
let speaker = browserSpeaker;
const can = support();

let story = null;
let storyData = null;          // the story as JSON, so nodes can be added and saved
let storyId = null;
let builtIn = [];              // [{ id, data }] from stories/
let local = {};                // id -> data: stories made, opened or added to here
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
    storyData = data;
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

// --- the library: several stories, one open at a time ---

const stories = () => listStories(builtIn, local);

function saveLibrary() {
    writeJson(LIBRARY_KEY, { stories: local, current: storyId });
}

function openStory(id) {
    const entry = stories().find(s => s.id === id);
    if (!entry) return [`There's no story "${id}".`];
    const errors = useStory(entry.data);
    if (errors.length) return errors;
    storyId = id;
    saveLibrary();
    renderPicker();
    return [];
}

function renderPicker() {
    const options = stories().map(s => new Option(s.title, s.id, false, s.id === storyId));
    $('story-select').replaceChildren(...options, el('hr'), new Option(`＋ ${NEW_STORY_LABEL}…`, NEW_STORY));
    $('story-select').value = storyId ?? '';
}

// Picking a story from the dropdown is a tap, so voice mode can start reading it.
function pickStory(id) {
    stopVoice();
    voice.compose = null;
    voice.connect = null;
    const errors = openStory(id);
    if (errors.length) {
        renderPicker();
        return errors;
    }
    window.scrollTo(0, 0);
    if (mode() === 'voice' && voice.started) voiceLoop(voice.run);
    else setVoiceState('idle', voice.started ? '' : startHint());
    return [];
}

// A new story from a title and an overview; opens it.
function addStory({ title, text }) {
    const { id, data, errors } = createStory({ title, text }, stories().map(s => s.id));
    if (errors.length) return errors;
    local[id] = data;
    return openStory(id);
}

const node = () => story.byId.get(currentId);
// A story with only its first page: nothing to choose yet, but not an ending.
const isBlank = () => story.byId.size === 1;
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
//
// Three ways to look at it. Normal: the map in rows at its own size,
// scrolled, and pinched (or ctrl-scrolled) to zoom. Physics: the same, but
// laid out by springs, so branches spread across the page. Fisheye: the rows
// fitted into the frame, magnified around a point that follows a finger or
// the mouse. The nodes are
// built once per render and then only moved, so a gesture never replaces the
// element under a finger.

const MAP_KEY = 'storynode_map';    // { look, zoom }
const MAP_HINTS = {
    normal: 'Pinch or ctrl-scroll to zoom. Tap a node to edit it, or to read from there.',
    fisheye: 'Drag across the map, or move the mouse, to look closer. Tap a node to edit it.',
    physics: 'Laid out by springs. Pinch or ctrl-scroll to zoom. Tap a node to edit it.',
};
const MAP_LOOKS = Object.keys(MAP_HINTS);

// Normal and Physics both scroll and zoom; only their layouts differ.
const zoomable = () => map.look !== 'fisheye';

// The spring layout takes a moment on a big story, so it's kept until the
// story changes (every edit makes a new story object).
let physicsCache = { story: null, layout: null };
function mapLayout() {
    if (map.look !== 'physics') return layoutGraph(story);
    if (physicsCache.story !== story) physicsCache = { story, layout: forceLayout(story) };
    return physicsCache.layout;
}

const map = {
    look: 'normal', zoom: 1, layout: null, parts: null,
    focus: null, focusNode: null, suppressClickUntil: 0, frame: 0,
};

// Typewriter letters are wide: 22 of them fill a map node.
function shorten(title, max = 22) {
    if (max < 2) return '';
    return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

const mapScroller = () => $('map-scroll');

// The room the map has: the scroller's width, and the window below its top.
function mapRoom() {
    const scroller = mapScroller();
    return {
        width: Math.max(200, scroller.clientWidth),
        height: Math.max(320, Math.round(window.innerHeight - scroller.getBoundingClientRect().top - 16)),
    };
}

function renderMap() {
    const layout = mapLayout();
    map.layout = layout;
    const svg = $('map-svg');    // not "map": the #map hash would scroll the page to it
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(svgEl('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arrow' }));
    defs.append(marker);

    const edges = layout.edges.map(edge => ({ edge, path: svgEl('path', { class: 'edge', 'marker-end': 'url(#arrow)' }) }));
    const nodes = new Map(layout.nodes.map((box) => {
        const classes = ['node'];
        if (box.id === currentId) classes.push('current');
        else if (visited.has(box.id)) classes.push('visited');
        if (isEnding(story, box.id)) classes.push('ending');
        const g = svgEl('g', { class: classes.join(' '), tabindex: 0, role: 'button', 'aria-label': box.title });
        const title = svgEl('title');
        title.textContent = box.title;
        const rect = svgEl('rect');
        const text = svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        // A ring marks where the story starts (green) and where it ends (blue).
        const ringKind = box.id === story.start ? 'start' : isEnding(story, box.id) ? 'end' : null;
        const ring = ringKind ? svgEl('rect', { class: `ring ${ringKind}` }) : null;
        g.append(title, ...(ring ? [ring] : []), rect, text);
        // Opens the node's edit form, which also offers to read from there.
        const open = () => openAddDialog('edit', box.id);
        g.addEventListener('click', open);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(); });
        // Moving through the nodes by keyboard moves the fisheye with them.
        g.addEventListener('focus', () => {
            if (map.look !== 'fisheye') return;
            map.focus = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
            placeMap();
        });
        return [box.id, { g, rect, text, ring, box }];
    }));
    map.parts = { edges, nodes };
    svg.replaceChildren(defs, ...edges.map(e => e.path), ...[...nodes.values()].map(n => n.g));

    // The fisheye starts on the current node, and stays where it's been moved
    // until the reader goes somewhere else.
    if (map.focusNode !== currentId || !map.focus) {
        const current = layout.nodes.find(b => b.id === currentId) ?? layout.nodes[0];
        map.focus = current ? { x: current.x + current.w / 2, y: current.y + current.h / 2 } : { x: 0, y: 0 };
        map.focusNode = currentId;
    }
    placeMap({ centre: true });
}

const edgePath = ({ x1, y1, x2, y2, straight }) => {
    if (straight) return `M${x1} ${y1} L${x2} ${y2}`;
    const mid = (y1 + y2) / 2;
    return `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2 - 2}`;
};

// Puts every node and edge where the current look says.
function placeMap({ centre = false } = {}) {
    const { layout, parts } = map;
    if (!layout || !parts) return;
    const svg = $('map-svg');
    const scroller = mapScroller();
    scroller.classList.toggle('fisheye', map.look === 'fisheye');
    $('map-hint').textContent = MAP_HINTS[map.look];

    if (map.look === 'fisheye') {
        scroller.style.maxHeight = '';
        const { width, height } = mapRoom();
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', width);
        svg.setAttribute('height', height);
        const placed = fisheyeLayout(layout, { width, height, focus: map.focus });
        for (const { g, rect, text, ring, box } of parts.nodes.values()) {
            const p = placed.boxes.get(box.id);
            setAttrs(rect, { x: p.x, y: p.y, width: p.w, height: p.h });
            if (ring) placeRing(ring, p, Math.max(1.5, 5 * p.h / box.h));
            setAttrs(text, { x: p.x + p.w / 2, y: p.y + p.h / 2 });
            text.style.fontSize = `${p.font}px`;
            text.style.visibility = p.font < 6 ? 'hidden' : '';
            text.textContent = shorten(box.title, p.letters);
            rect.style.rx = `${Math.min(10, p.h / 4)}px`;
            g.classList.toggle('tiny', p.font < 6);
        }
        for (const { edge, path } of parts.edges) {
            const e = placed.edges.find(x => x.from === edge.from && x.to === edge.to);
            path.setAttribute('d', edgePath(e));
        }
        return;
    }

    // Normal and Physics: the layout's own coordinates, drawn at the zoom.
    for (const { g, rect, text, ring, box } of parts.nodes.values()) {
        setAttrs(rect, { x: box.x, y: box.y, width: box.w, height: box.h });
        if (ring) placeRing(ring, box, 5);
        setAttrs(text, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
        text.style.fontSize = '';
        text.style.visibility = '';
        text.textContent = shorten(box.title);
        rect.style.rx = '';
        g.classList.remove('tiny');
    }
    for (const { edge, path } of parts.edges) path.setAttribute('d', edgePath(edge));
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    const room = mapRoom();
    // The map scrolls inside its frame, which ends at the bottom of the
    // window, so the controls above it stay in reach.
    scroller.style.maxHeight = `${room.height}px`;
    map.zoom = clampZoom(map.zoom, zoomRange(layout, room.width, room.height));
    sizeMap();
    if (centre) {
        // Keep the current node in view.
        const current = layout.nodes.find(b => b.id === currentId);
        if (current) {
            scroller.scrollLeft = Math.max(0, (current.x + current.w / 2) * map.zoom - scroller.clientWidth / 2);
            scroller.scrollTop = Math.max(0, (current.y + current.h / 2) * map.zoom - scroller.clientHeight / 2);
        }
    }
}

// A rounded ring just outside a node's box, `gap` away from it.
function placeRing(ring, { x, y, w, h }, gap) {
    setAttrs(ring, { x: x - gap, y: y - gap, width: w + gap * 2, height: h + gap * 2 });
    ring.style.rx = `${Math.round(h / 2 + gap)}px`;
    ring.style.strokeWidth = `${Math.max(1, Math.min(2.5, gap / 2))}px`;
}

function setAttrs(node, attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, Math.round(v * 10) / 10);
}

function sizeMap() {
    const svg = $('map-svg');
    svg.setAttribute('width', Math.round(map.layout.width * map.zoom));
    svg.setAttribute('height', Math.round(map.layout.height * map.zoom));
}

// Zooms the normal map to `next`, keeping the point at (x, y) in the
// scroller's viewport where it is.
function zoomMapTo(next, x, y) {
    const scroller = mapScroller();
    const room = mapRoom();
    const range = zoomRange(map.layout, room.width, room.height);
    const zoom = clampZoom(next, range);
    if (zoom === map.zoom) return;
    const scroll = zoomAround({ zoom: map.zoom, scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop }, zoom, x, y);
    map.zoom = zoom;
    sizeMap();
    scroller.scrollLeft = scroll.scrollLeft;
    scroller.scrollTop = scroll.scrollTop;
}

function saveMapSettings() {
    writeJson(MAP_KEY, { look: map.look, zoom: map.zoom });
}

function setUpMap() {
    const saved = readJson(MAP_KEY) ?? {};
    map.look = MAP_LOOKS.includes(saved.look) ? saved.look : 'normal';
    map.zoom = Number(saved.zoom) > 0 ? Number(saved.zoom) : 1;
    document.querySelector(`#map-look input[value="${map.look}"]`).checked = true;
    $('map-look').addEventListener('change', (e) => {
        map.look = e.target.value;
        saveMapSettings();
        renderMap();     // Physics has its own layout
    });

    const scroller = mapScroller();
    const svg = $('map-svg');
    const local = (clientX, clientY) => {
        const r = scroller.getBoundingClientRect();
        return { x: clientX - r.left - scroller.clientLeft, y: clientY - r.top - scroller.clientTop };
    };
    const quietClicks = (ms = 400) => { map.suppressClickUntil = performance.now() + ms; };
    // A pinch or a drag ends with the finger lifted over some node: not a tap.
    svg.addEventListener('click', (e) => {
        if (performance.now() < map.suppressClickUntil) {
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);

    // Pinch, on touch screens. One finger is left to the browser to scroll.
    let pinch = null;
    const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const middle = (t) => local((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
    scroller.addEventListener('touchstart', (e) => {
        if (!zoomable() || e.touches.length !== 2) return;
        pinch = { distance: spread(e.touches), zoom: map.zoom };
        quietClicks();
    }, { passive: true });
    scroller.addEventListener('touchmove', (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        const at = middle(e.touches);
        zoomMapTo(pinch.zoom * spread(e.touches) / pinch.distance, at.x, at.y);
        quietClicks();
    }, { passive: false });
    const endPinch = (e) => {
        if (!pinch || e.touches.length >= 2) return;
        pinch = null;
        quietClicks();
        saveMapSettings();
    };
    scroller.addEventListener('touchend', endPinch);
    scroller.addEventListener('touchcancel', endPinch);

    // Safari's own pinch: stop it zooming the page, and use it on a Mac trackpad.
    let gesture = null;
    scroller.addEventListener('gesturestart', (e) => {
        e.preventDefault();
        if (zoomable() && !pinch) gesture = { zoom: map.zoom };
    });
    scroller.addEventListener('gesturechange', (e) => {
        e.preventDefault();
        if (!gesture || pinch) return;
        const at = local(e.clientX, e.clientY);
        zoomMapTo(gesture.zoom * e.scale, at.x, at.y);
    });
    scroller.addEventListener('gestureend', (e) => {
        e.preventDefault();
        if (gesture) saveMapSettings();
        gesture = null;
    });

    // Trackpad pinch in other browsers, and ctrl + mouse wheel.
    let wheelSave = 0;
    scroller.addEventListener('wheel', (e) => {
        if (!zoomable() || !e.ctrlKey) return;
        e.preventDefault();
        const at = local(e.clientX, e.clientY);
        zoomMapTo(map.zoom * Math.exp(-e.deltaY * 0.01), at.x, at.y);
        clearTimeout(wheelSave);
        wheelSave = setTimeout(saveMapSettings, 300);
    }, { passive: false });

    // Fisheye: the focus follows the mouse, or a finger dragged across the map.
    let drag = null;
    const moveFocus = (clientX, clientY) => {
        const placed = { width: Number(svg.getAttribute('width')), height: Number(svg.getAttribute('height')) };
        const at = local(clientX, clientY);
        // The focus is a fixed point of the fisheye, so screen to layout is
        // just the fit: undo the scale and the centring offset.
        const along = (v, size, space) => {
            const scale = Math.min(1, space / size);
            return (v - (space - size * scale) / 2) / scale;
        };
        map.focus = {
            x: Math.min(map.layout.width, Math.max(0, along(at.x, map.layout.width, placed.width))),
            y: Math.min(map.layout.height, Math.max(0, along(at.y, map.layout.height, placed.height))),
        };
        if (map.frame) return;
        map.frame = requestAnimationFrame(() => {
            map.frame = 0;
            placeMap();
        });
    };
    svg.addEventListener('pointerdown', (e) => {
        if (map.look !== 'fisheye' || e.pointerType === 'mouse') return;
        drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    svg.addEventListener('pointermove', (e) => {
        if (map.look !== 'fisheye') return;
        if (e.pointerType === 'mouse') {
            moveFocus(e.clientX, e.clientY);
            return;
        }
        if (!drag) return;
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = true;
        if (drag.moved) moveFocus(e.clientX, e.clientY);
    });
    const endDrag = () => {
        if (drag?.moved) quietClicks(300);
        drag = null;
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => { if (mode() === 'map') placeMap(); });
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
    $('read-end').textContent = isBlank() ? 'No more pages yet. Add the first one below.' : 'The end.';
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
    compose: null,     // { parent, state } while a new node is being dictated
    fallback: null,    // the full prompt, while a brief one is waiting for an answer
    connect: null,     // { from, state } while a page to connect to is being asked for
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
    syncWakeLock();
}

// --- keeping the screen on ---
//
// A phone that dims and locks mid-page stops the reading. While a story is
// going in voice mode the page asks the browser to keep the screen awake,
// unless that's switched off. The browser drops the lock whenever the page
// is hidden, so it is asked for again each time the page comes back.

let wakeLock = null;
let wakeLockAsking = false;
let wakeLockRefused = false;    // don't ask again until the page comes back into view

const wantsAwake = () => $('keep-awake').checked && mode() === 'voice' && voice.started
    && document.visibilityState === 'visible';

async function syncWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (!wantsAwake()) {
        const held = wakeLock;
        wakeLock = null;
        held?.release().catch(() => {});
        return;
    }
    if (wakeLock || wakeLockAsking || wakeLockRefused) return;
    wakeLockAsking = true;
    try {
        const lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
        wakeLock = lock;
        addLog('mic', 'screen: staying awake');
    } catch (error) {
        // Refused, for instance in Low Power Mode. Nothing else to try.
        wakeLockRefused = true;
        addLog('error', `screen: can't keep awake (${error.name})`);
    }
    wakeLockAsking = false;
    if (!wantsAwake()) syncWakeLock();     // things changed while asking
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

// The story's own words that could be spoken right now: this page, its
// choices, and anything being dictated. A voice with two parts reads these
// in the story voice and everything else in the app's.
function storyWordsNow() {
    const n = node();
    const words = [n.title, n.text, ...choices().map(c => c.title)];
    const composing = voice.compose?.state;
    if (composing) words.push(composing.title, ...composing.chunks, composing.original?.title, composing.original?.text);
    if (voice.connect) words.push(...voice.connect.state.candidates.map(c => c.title));
    return storySentences(words.filter(Boolean), sentences);
}

async function say(text, run, from = 0) {
    setVoiceState('reading', voice.state === 'reading' ? $('voice-status').textContent : '');
    const story = storyWordsNow();
    const done = await speaker.speak(text, { from, partsOf: (sentence) => voiceParts(sentence, story) });
    return done && run === voice.run;
}

// While the model is still making a sentence the page is silent, so say why.
const MAKING = 'Making the voice…';
let statusBeforeMaking = '';

function showMakingVoice(making) {
    const status = $('voice-status');
    if (making && voice.state === 'reading') {
        if (status.textContent !== MAKING) statusBeforeMaking = status.textContent;
        status.textContent = MAKING;
    } else if (!making && status.textContent === MAKING) {
        status.textContent = statusBeforeMaking;
    }
}

// The model is slow, so while the listener decides, it gets a start on what
// each choice would read first: all the titles, then the opening sentences.
function warmChoices() {
    if (speaker !== modelSpeaker || voice.compose || voice.connect) return;
    const openings = choices().map(c => sentences(pageScript(c)).slice(0, 3));
    const rate = Number($('voice-rate').value);
    for (let i = 0; i < 3; i++) modelVoice.warm(openings.map(o => o[i]).filter(Boolean), { rate });
}

// --- prompts that get shorter ---
//
// The first time a prompt is read it explains what can be said. That's
// remembered (in localStorage), and from then on the same prompt is a few
// words: "Choices:", "Keep?". If the brief one gets no usable answer, the
// full one is read after all. Saying "help" starts the explanations over.

const heardPrompts = new Set(readJson(HEARD_KEY) ?? []);

// Says a prompt ({ key, full, brief }) in the length this listener needs.
async function sayPrompt(prompt, run, from = 0) {
    const brief = Boolean(prompt.key && prompt.brief && heardPrompts.has(prompt.key));
    voice.fallback = brief ? prompt.full : null;
    if (!(await say(brief ? prompt.brief : prompt.full, run, from))) return false;
    if (prompt.key && !brief) {
        heardPrompts.add(prompt.key);
        writeJson(HEARD_KEY, [...heardPrompts]);
    }
    return true;
}

function forgetHeardPrompts() {
    heardPrompts.clear();
    writeJson(HEARD_KEY, null);
}

// After speaking: hands-free opens the mic, Hold To Talk waits for a press.
function awaitAnswer(run) {
    warmChoices();
    const doing = voice.compose ? `${composeStatus(voice.compose.state)} ` : voice.connect ? `${connectStatus(voice.connect.state)} ` : '';
    const idle = () => setVoiceState('idle', `${doing}Hold the button to answer.`);
    if (handsFree()) {
        listen(run);
        return;
    }
    idle();
    // Nothing to time out on without an open mic, so a brief prompt that
    // nobody answers gets its full version after a while, once.
    if (!voice.fallback) return;
    setTimeout(async () => {
        if (run !== voice.run || voice.state !== 'idle' || !voice.fallback) return;
        const full = voice.fallback;
        voice.fallback = null;
        if (await say(full, run)) idle();
    }, HELP_AFTER_MS);
}

// Reads the page and the choices, then waits for an answer. `from` picks up
// at a saved place instead of the top.
async function voiceLoop(run, { skipPage = false, from = null } = {}) {
    voice.started = true;
    voice.retries = 0;
    voice.resume = null;
    voice.compose = null;      // back in the story
    voice.connect = null;
    const stage = from?.stage ?? (skipPage ? 'choices' : 'page');
    if (stage === 'page') {
        voice.stage = 'page';
        setVoiceState('reading', 'Reading…');
        if (!(await say(pageScript(node(), { cover: currentId === story.start }), run, from?.sentence ?? 0))) return;
    }
    if (stage === 'page' || stage === 'choices') {
        voice.stage = 'choices';
        setVoiceState('reading', 'Your choices…');
        if (!(await sayPrompt(choicesPrompt(choices(), { blank: isBlank() }), run, stage === 'choices' ? (from?.sentence ?? 0) : 0))) return;
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

// Opens the mic once and returns the recognizer's guesses, best first ([] if
// nothing was heard). Returns null if this run was interrupted or the mic
// failed; the status already says why.
async function hear(run, { hold, phrases, label }) {
    if (!can.listen) {
        setVoiceState('idle', "This browser can't listen. Tap a choice below, or try Chrome or Safari.");
        return null;
    }
    setVoiceState('opening', 'Getting the microphone…');
    addLog('listen', `${hold ? 'hold' : 'hands-free'}, ${label}`);
    $('voice-heard').textContent = '';

    const session = listenOnce({
        phrases,
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
    if (run !== voice.run) return null;

    if (segments.length > 1) addLog('guesses', `segments: ${segments.map(s => `[${s.join(' | ')}]`).join(' ')}`);
    addLog('guesses', alternatives.length ? alternatives.join(' | ') : `nothing heard (${error})`);

    if (LISTEN_ERRORS[error]) {
        addLog('error', error);
        setVoiceState('idle', LISTEN_ERRORS[error]);
        return null;
    }
    return alternatives;
}

async function listen(run, { hold = false } = {}) {
    if (voice.compose) return composeListen(run, { hold });
    if (voice.connect) return connectListen(run, { hold });
    const list = choices();
    const alternatives = await hear(run, {
        hold,
        phrases: hintPhrases(list),
        label: `choices: ${list.map((c, i) => `${i + 1}. ${c.title}`).join('; ') || 'none'}`,
    });
    if (!alternatives) return;

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
    // A brief prompt that didn't land is followed by its full version;
    // after that it's the usual reminders.
    const full = voice.fallback;
    voice.fallback = null;
    const line = full
        ? fallbackScript(full, { heardSomething: alternatives.length > 0 })
        : retryScript(Math.min(voice.retries, MAX_RETRIES), { hold: !handsFree() });
    if (!(await say(line, run))) return;
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
        case 'add':
            return startComposing(run, 'node');
        case 'story':
            return startComposing(run, 'story');
        case 'edit':
            return startComposing(run, 'edit');
        case 'connect':
            return startConnecting(run);
        case 'help':
            forgetHeardPrompts();   // asking for help brings the full prompts back
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
    browserSpeaker.unlock();
    player.unlock();
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
    if (voice.compose) {
        voice.retries = 0;
        composeSay({ say: composePrompt(voice.compose.state) }, run);
        return;
    }
    if (voice.connect) {
        voice.retries = 0;
        connectSay({ ...connectPrompt(voice.connect.state), key: null }, run);
        return;
    }
    const from = voice.resume?.id === currentId ? voice.resume : null;
    voice.resume = null;
    if (from) voiceLoop(run, { from });
    else listen(run);
}

// The dial's position and the words above the button show the mode.
const modeName = (free) => (free ? 'Hands Free' : 'Hold to Talk');

function syncDial() {
    $('mode-knob').style.setProperty('--a', `${dialRest()}deg`);
    $('mode-knob').textContent = modeName(handsFree());
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
    // The dial can go either way: two arrows, both ending just short of the
    // far side, where the other mode's name is waiting.
    const sweeps = direction === 0 ? [DIAL_ARROW_DEGREES, -DIAL_ARROW_DEGREES] : [direction * ARC_DEGREES];
    const tracks = sweeps.map(sweep => svgEl('path', { class: 'arc-track', d: arcPath(radius, rest, rest + sweep), 'marker-end': 'url(#arc-arrow)' }));
    svg.replaceChildren(defs, ...tracks, svgEl('path', { id: 'arc-fill', class: 'arc-fill' }));
    svg.removeAttribute('hidden');
}

function setUpArcControl({ element, rest, direction, fire, springBack = true, onGrab = () => {}, onLetGo = () => {} }) {
    let tracker = null;
    let radius = 0;
    const setAngle = (degrees) => element.style.setProperty('--a', `${degrees}deg`);

    const release = ({ fired = false } = {}) => {
        tracker = null;
        $('arc-guide').setAttribute('hidden', '');
        onLetGo();
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
        onGrab();
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
    // Held, the dial shows where it can go: the other mode, at the far side.
    const target = $('mode-target');
    setUpArcControl({
        element: $('mode-knob'),
        rest: dialRest,
        direction: 0,
        fire: toggleHandsFree,
        springBack: false,
        onGrab: () => {
            target.textContent = modeName(!handsFree());
            target.style.setProperty('--a', `${dialRest() + 180}deg`);
            target.hidden = false;
        },
        onLetGo: () => { target.hidden = true; },
    });
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
    writeJson(VOICE_KEY, {
        name: $('voice-select').value,
        rate: Number($('voice-rate').value),
        auto: voice.handsFree,
        engine: engine(),
        modelVoice: $('model-voice-select').value,
        cloudVoice: $('cloud-voice-select').value,
        cloudAppVoice: $('cloud-app-voice-select').value,
        awake: $('keep-awake').checked,
    });
}

function showCloudState(state) {
    $('cloud-note').textContent = cloudNote(state);
    writeJson(CLOUD_KEY, { key: $('cloud-key').value.trim(), characters: state.characters });
    syncVoiceTest();
}

// The clip source that's switched on, if any, and whether it can be tried.
const clipSource = () => ({ cloud: cloudVoice, small: modelVoice, large: modelVoice }[engine()] ?? null);

function syncVoiceTest() {
    const ready = clipSource()?.state().status === 'ready';
    $('voice-test').hidden = !ready;
    if (!ready) $('model-test-note').textContent = '';
}

// 'browser', or a model size: 'small' or 'large'.
const engine = () => document.querySelector('#voice-engine input:checked')?.value ?? 'browser';

let shownModelStatus = 'off';

function showModelState(state) {
    const on = state.status !== 'off';
    $('model-status').hidden = !on;
    if (!on) {
        shownModelStatus = 'off';
        syncVoiceTest();
        return;
    }
    const bar = $('model-progress');
    bar.hidden = state.status !== 'loading';
    syncVoiceTest();
    const { total, fraction } = loadProgress(state.files);
    // No number yet, or downloaded and starting up: the bar just shows it's busy.
    if (total === 0 || fraction >= 1) bar.removeAttribute('value');
    else bar.value = fraction;
    $('model-note').textContent = modelNote(state);
    if (state.status === shownModelStatus) return;
    shownModelStatus = state.status;
    if (state.status === 'failed') addLog('error', `model: ${state.error}`);
    if (state.status === 'ready') addLog('mic', `model ready: ${state.size}, ${state.device}`);
}

// Makes one sentence with the model or the cloud voice and plays it, saying
// how each step went.
let testCount = 0;

async function testModelVoice() {
    const note = (text) => { $('model-test-note').textContent = text; };
    const source = clipSource();
    const name = engine() === 'cloud' ? 'cloud voice' : 'model voice';
    stopVoice();
    setVoiceState('idle', voice.started ? '' : startHint());
    player.unlock();            // this tap allows audio
    if (source?.state().status !== 'ready') {
        note("It isn't ready yet.");
        return;
    }
    note('Making a test sentence…');
    const startedAt = performance.now();
    const clip = await source.clip(`This is test ${++testCount} of the ${name}.`, { rate: Number($('voice-rate').value) });
    const took = (performance.now() - startedAt) / 1000;
    if (!clip) {
        note(`It couldn't make audio (${took.toFixed(1)} s). The voice log says why.`);
        return;
    }
    const made = `Made ${timingNote(clip.samples.length / clip.sampleRate, took)}.`;
    note(`${made} Playing it…`);
    const played = await player.play(clip);
    note(played
        ? `${made} Played it. If you heard nothing, check the volume, and on an iPhone the silent switch.`
        : `${made} But it couldn't be played: audio here is “${player.state()}”.`);
}

// Switches between the browser voice and a model. The model starts loading
// (or comes out of the browser's cache) as soon as it's picked.
function useEngine(name) {
    const model = Object.hasOwn(MODEL_SIZES, name);
    const cloud = name === 'cloud';
    speaker = model ? modelSpeaker : cloud ? cloudSpeaker : browserSpeaker;
    if (model) modelVoice.load(name);
    else modelVoice.unload();
    $('browser-voice-row').hidden = model || cloud;
    $('model-voice-row').hidden = !model;
    $('cloud-voice-row').hidden = !cloud;
    $('cloud-app-voice-row').hidden = !cloud;
    $('cloud-status').hidden = !cloud;
    syncVoiceTest();
}

function setUpVoiceSettings() {
    const saved = readJson(VOICE_KEY) ?? {};
    const select = $('voice-select');
    const fill = () => {
        const voices = rankVoices(browserSpeaker.voices());
        if (voices.length === 0) return;
        const chosen = voices.find(v => v.name === saved.name) ?? voices[0];
        select.replaceChildren(...voices.map(v => new Option(`${v.name} (${v.lang})`, v.name, false, v === chosen)));
        browserSpeaker.setVoice(chosen);
    };
    fill();
    if (globalThis.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', fill);
    const save = saveVoiceSettings;
    select.addEventListener('change', () => {
        browserSpeaker.setVoice(browserSpeaker.voices().find(v => v.name === select.value) ?? null);
        save();
    });

    const modelSelect = $('model-voice-select');
    modelSelect.replaceChildren(...MODEL_VOICES.map(v => new Option(v.name, v.id, false, v.id === saved.modelVoice)));
    modelVoice.setVoice(modelSelect.value);
    modelSelect.addEventListener('change', () => {
        modelVoice.setVoice(modelSelect.value);
        save();
    });

    // Two cloud voices: one for the story's words, one for the app's.
    const cloudSelects = { story: $('cloud-voice-select'), app: $('cloud-app-voice-select') };
    const savedCloud = { story: saved.cloudVoice ?? CLOUD.voices.story, app: saved.cloudAppVoice ?? CLOUD.voices.app };
    const setCloudVoices = () => cloudVoice.setVoices({ story: cloudSelects.story.value, app: cloudSelects.app.value });
    for (const [part, picker] of Object.entries(cloudSelects)) {
        picker.replaceChildren(...CLOUD_VOICES.map(v => new Option(v.name, v.id, false, v.id === savedCloud[part])));
        picker.addEventListener('change', () => {
            setCloudVoices();
            save();
        });
    }
    setCloudVoices();
    $('cloud-key').value = readJson(CLOUD_KEY)?.key ?? '';
    cloudVoice.setKey($('cloud-key').value);
    $('cloud-key').addEventListener('input', () => cloudVoice.setKey($('cloud-key').value));

    const setRate = () => {
        const rate = Number($('voice-rate').value);
        browserSpeaker.setRate(rate);
        modelSpeaker.setRate(rate);
        cloudSpeaker.setRate(rate);
    };
    $('voice-rate').value = saved.rate ?? 1;
    setRate();
    $('voice-rate').addEventListener('input', () => {
        setRate();
        save();
    });
    voice.handsFree = saved.auto ?? false;
    syncDial();

    const startWith = Object.hasOwn(MODEL_SIZES, saved.engine) || saved.engine === 'cloud' ? saved.engine : 'browser';
    document.querySelector(`#voice-engine input[value="${startWith}"]`).checked = true;
    useEngine(startWith);
    $('voice-engine').addEventListener('change', () => {
        // Stops any reading, and keeps the place so START can pick it up.
        const place = placeNow();
        stopVoice();
        // Waiting for an answer? Then START reads the choices again, to hear the new voice.
        voice.resume = place.stage === 'answer' ? { ...place, stage: 'choices', sentence: 0 } : place;
        player.unlock();        // the tap on the switch is what allows audio
        useEngine(engine());
        save();
        addLog('mic', `voice: ${engine()}`);
        setVoiceState('idle', voice.started ? '' : startHint());
    });

    $('model-test').addEventListener('click', testModelVoice);

    const awake = $('keep-awake');
    awake.checked = saved.awake ?? true;
    if (!('wakeLock' in navigator)) {
        awake.checked = false;
        awake.disabled = true;
        awake.parentElement.title = "This browser can't keep the screen awake.";
    }
    awake.addEventListener('change', () => {
        save();
        syncWakeLock();
    });
    document.addEventListener('visibilitychange', () => {
        wakeLockRefused = false;
        syncWakeLock();
    });

    $('voice-support').textContent = [
        can.speak ? 'Reading aloud: yes.' : "Reading aloud: this browser can't.",
        can.listen ? 'Listening: yes.' : "Listening: this browser can't (try Chrome or Safari).",
        can.hints ? 'Choice hints: yes.' : 'Choice hints: not in this browser (matching still works).',
    ].join(' ');
}

// --- adding a node or a story ---
//
// Anyone can add a page after the one they're on: a title, some text, and it
// becomes a new choice there. A new story is made the same way; its title
// and overview become its first page. Both are saved in this browser.
// Typed into a form (the link under the choices, the dropdown's last option),
// or dictated in voice mode ("add new node", "add new story"), where every
// part is read back before it's kept.

function saveNode({ parent, title, text }) {
    const { data, id, errors } = addNode(storyData, { parent, title, text });
    const problems = errors.length ? errors : loadStory(data).errors;
    if (problems.length) return { id: null, errors: problems };
    storyData = data;
    story = loadStory(data).story;
    local[storyId] = data;
    saveLibrary();
    render();
    return { id, errors: [] };
}

// Changes an existing node's title and text.
function saveEdit({ id, title, text }) {
    const { data, errors } = editNode(storyData, id, { title, text });
    const problems = errors.length ? errors : loadStory(data).errors;
    if (problems.length) return problems;
    storyData = data;
    story = loadStory(data).story;
    local[storyId] = data;
    saveLibrary();
    renderPicker();     // the story is renamed with its first page
    render();
    return [];
}

let adding = 'node';    // what the form is for: 'node', 'story' or 'edit'
let editingId = null;   // the node being edited
let addingParent = null; // the node a new one goes after

// One form for all three. Editing is the same form with the node's own words
// in it; from the map it can be any node, and offers to read from there.
function openAddDialog(kind = 'node', id = currentId) {
    if (!story && kind !== 'story') return;
    stopVoice();
    voice.compose = null;
    voice.connect = null;
    setVoiceState('idle', voice.started ? '' : startHint());
    adding = kind;
    editingId = kind === 'edit' ? id : null;
    addingParent = kind === 'node' ? id : null;
    $('edit-links').hidden = kind !== 'edit';
    $('add-form').reset();
    $('add-heading').textContent = { story: NEW_STORY_LABEL, edit: EDIT_LABEL }[kind] ?? ADD_LABEL;
    $('add-text-label').textContent = kind === 'story' ? 'Overview' : 'Text';
    $('add-read').hidden = !(kind === 'edit' && mode() === 'map');
    if (kind === 'story') {
        $('add-hint').textContent = 'A title and a short overview, like the back of a book jacket. They become the story’s first page.';
    } else if (kind === 'edit') {
        const editing = story.byId.get(id);
        $('add-title').value = editing.title;
        $('add-text').value = editing.text;
        $('add-hint').textContent = id === story.start
            ? 'The story’s first page. Its choices stay as they are.'
            : 'Its place in the story and its choices stay as they are.';
    } else {
        $('add-hint').replaceChildren('A new choice after ', el('strong', {}, story.byId.get(id).title), '.');
    }
    $('add-errors').hidden = true;
    $('add-dialog').showModal();
    $('add-title').focus();
}

function submitAdd(e) {
    e.preventDefault();
    const fields = { title: $('add-title').value, text: $('add-text').value };
    let errors;
    let id = null;
    if (adding === 'story') errors = addStory(fields);
    else if (adding === 'edit') errors = saveEdit({ id: editingId, ...fields });
    else ({ id, errors } = saveNode({ parent: addingParent, ...fields }));
    if (errors.length) {
        $('add-errors').textContent = errors.join('\n');
        $('add-errors').hidden = false;
        return;
    }
    $('add-dialog').close();
    if (id) goTo(id);
    window.scrollTo(0, 0);
    // The submit is a tap, so voice mode can read the new page straight away.
    if (mode() === 'voice' && voice.started) voiceLoop(voice.run);
}

// From the edit form: add a node after the one being edited, or connect it
// to another. Changes made in the form are saved first, so they aren't lost.
function growFromEdited(open) {
    const id = editingId;
    const editing = story.byId.get(id);
    const fields = { title: $('add-title').value, text: $('add-text').value };
    if (fields.title.trim() !== editing.title || fields.text.trim() !== editing.text) {
        const errors = saveEdit({ id, ...fields });
        if (errors.length) {
            $('add-errors').textContent = errors.join('\n');
            $('add-errors').hidden = false;
            return;
        }
    }
    $('add-dialog').close();
    open(id);
}

// From the map's edit form: go and read that node instead.
function readFromEdited() {
    $('add-dialog').close();
    goTo(editingId);
    location.hash = '#read';
}

// By voice. `voice.compose` outlives a run, so a press or STOP in the middle
// carries on at the same question; going anywhere else in the story drops it.

function startComposing(run, kind) {
    const original = kind === 'edit' ? { title: node().title, text: node().text } : null;
    voice.compose = { parent: currentId, state: startCompose(kind, original) };
    voice.retries = 0;
    addLog('compose', { story: 'new story', edit: `editing ${currentId}` }[kind] ?? `new node after ${currentId}`);
    const { state } = voice.compose;
    return composeSay({ say: composePrompt(state), key: promptKey(state), brief: composeBrief(state) }, run);
}

// Says a line of the dictation ({ say, key, brief } from compose.js), brief
// if its explanation has been heard before, then waits for the answer.
async function composeSay({ say: full, key = null, brief = null }, run) {
    setVoiceState('reading', composeStatus(voice.compose.state));
    if (!(await sayPrompt({ key, full, brief }, run))) return;
    awaitAnswer(run);
}

const composeName = (state) => (state.kind === 'edit' ? 'edit' : `new ${state.kind}`);

async function composeListen(run, { hold = false } = {}) {
    const composing = voice.compose;
    const alternatives = await hear(run, {
        hold,
        phrases: composeHints(composing.state),
        label: `${composeName(composing.state)}: ${composing.state.stage}`,
    });
    if (!alternatives || voice.compose !== composing) return;

    const step = composeStep(composing.state, alternatives);
    const { state, say: line, outcome } = step;
    addLog('result', `${composeName(composing.state)}: ${composing.state.stage} → ${outcome === 'continue' ? state.stage : outcome}`);
    $('voice-heard').textContent = alternatives[0] ? `“${alternatives[0]}”` : 'Nothing heard';

    if (outcome !== 'continue') {
        let closing = line;
        if (outcome === 'save') {
            const fields = { title: state.title, text: composedText(state) };
            let errors;
            if (state.kind === 'story') errors = addStory(fields);
            else if (state.kind === 'edit') errors = saveEdit({ id: composing.parent, ...fields });
            else errors = saveNode({ parent: composing.parent, ...fields }).errors;
            if (errors.length) closing = `Sorry, that couldn't be saved. ${errors[0]}`;
        }
        voice.compose = null;
        if (!(await say(closing, run))) return;
        return voiceLoop(run, { skipPage: true });
    }

    // Hands-free stops asking after a few silences; START picks it up again.
    voice.retries = alternatives.length ? 0 : voice.retries + 1;
    if (handsFree() && voice.retries > MAX_RETRIES) {
        setVoiceState('idle', `Tap START to carry on with the ${composeName(composing.state)}.`);
        return;
    }
    composing.state = state;
    return composeSay(step, run);
}

// --- connecting to a node that already exists ---
//
// Like adding a node, but the new choice leads to a page the story already
// has. Picked from a list (the link under the choices), or named out loud in
// voice mode ("connect node").

function saveConnection(from, to) {
    const { data, errors } = connectNode(storyData, from, to);
    if (errors.length) return errors;
    storyData = data;
    story = loadStory(data).story;
    local[storyId] = data;
    saveLibrary();
    render();
    return [];
}

function openConnectDialog(from = currentId) {
    if (!story) return;
    stopVoice();
    voice.compose = null;
    voice.connect = null;
    setVoiceState('idle', voice.started ? '' : startHint());
    const pages = connectable(story, from);
    const list = $('connect-list');
    const fill = () => {
        const wanted = $('connect-filter').value.trim().toLowerCase();
        list.replaceChildren(...pages.filter(p => p.title.toLowerCase().includes(wanted)).map((page) => {
            const li = el('li');
            const b = el('button', { type: 'button' }, page.title);
            b.addEventListener('click', () => {
                const errors = saveConnection(from, page.id);
                if (errors.length) {
                    $('connect-errors').textContent = errors.join('\n');
                    $('connect-errors').hidden = false;
                    return;
                }
                $('connect-dialog').close();
                // The pick is a tap, so voice mode can read the choices with the new one in.
                if (mode() === 'voice' && voice.started) voiceLoop(voice.run, { skipPage: true });
            });
            li.append(b);
            return li;
        }));
    };
    $('connect-heading').textContent = CONNECT_LABEL;
    $('connect-hint').replaceChildren(...(pages.length
        ? ['Pick a page to add as a choice after ', el('strong', {}, story.byId.get(from).title), '.']
        : ["There's no other page this one can connect to yet. Pages that lead here can't be choices, or the story would loop."]));
    $('connect-filter').value = '';
    $('connect-filter').hidden = pages.length < 8;
    $('connect-filter').oninput = fill;
    $('connect-errors').hidden = true;
    fill();
    $('connect-dialog').showModal();
}

// By voice. Like dictation, `voice.connect` outlives a run, so a press or
// STOP in the middle carries on; going anywhere else in the story drops it.

function startConnecting(run) {
    voice.connect = { from: currentId, state: startConnect(connectable(story, currentId).map(({ id, title }) => ({ id, title }))) };
    voice.retries = 0;
    addLog('compose', `connecting from ${currentId}`);
    return connectSay(connectPrompt(voice.connect.state), run);
}

// Says a line of it ({ say, key, brief, outcome } from connect.js) and waits
// for the answer, or finishes: back to this page's choices either way.
async function connectSay({ say: full, key = null, brief = null, outcome = 'continue', id = null }, run) {
    const connecting = voice.connect;
    let line = full;
    if (outcome === 'connect') {
        const errors = saveConnection(connecting.from, id);
        if (errors.length) line = `Sorry, that couldn't be connected. ${errors[0]}`;
    }
    setVoiceState('reading', connectStatus(connecting.state));
    if (outcome !== 'continue') {
        // Still set while speaking, so the title is read in the story voice.
        const said = await say(line, run);
        if (voice.connect === connecting) voice.connect = null;
        if (said) voiceLoop(run, { skipPage: true });
        return;
    }
    if (!(await sayPrompt({ key, full: line, brief }, run))) return;
    awaitAnswer(run);
}

async function connectListen(run, { hold = false } = {}) {
    const connecting = voice.connect;
    const { candidates } = connecting.state;
    const alternatives = await hear(run, {
        hold,
        phrases: [...candidates.map(c => c.title), 'list', 'cancel'],
        label: `connect: ${candidates.length} pages`,
    });
    if (!alternatives || voice.connect !== connecting) return;

    const step = connectStep(connecting.state, alternatives);
    addLog('result', `connect: ${step.outcome}${step.id ? ` ${step.id}` : ''}`);
    $('voice-heard').textContent = alternatives[0] ? `“${alternatives[0]}”` : 'Nothing heard';

    // Hands-free stops asking after a few silences; START picks it up again.
    voice.retries = alternatives.length ? 0 : voice.retries + 1;
    if (step.outcome === 'continue' && handsFree() && voice.retries > MAX_RETRIES) {
        setVoiceState('idle', 'Tap START to carry on connecting.');
        return;
    }
    connecting.state = step.state;
    return connectSay(step, run);
}

function setUpAddDialog() {
    for (const id of ['read-connect', 'voice-connect']) {
        $(id).textContent = CONNECT_LABEL;
        $(id).addEventListener('click', () => openConnectDialog());
    }
    $('edit-add').textContent = ADD_LABEL;
    $('edit-add').addEventListener('click', () => growFromEdited(id => openAddDialog('node', id)));
    $('edit-connect').textContent = CONNECT_LABEL;
    $('edit-connect').addEventListener('click', () => growFromEdited(id => openConnectDialog(id)));
    $('connect-cancel').addEventListener('click', () => $('connect-dialog').close());
    for (const id of ['read-add', 'voice-add']) {
        $(id).textContent = ADD_LABEL;
        $(id).addEventListener('click', () => openAddDialog('node'));
    }
    for (const id of ['read-edit', 'voice-edit']) {
        $(id).textContent = EDIT_LABEL;
        $(id).addEventListener('click', () => openAddDialog('edit'));
    }
    $('add-read').addEventListener('click', readFromEdited);
    $('add-cancel').addEventListener('click', () => $('add-dialog').close());
    $('add-form').addEventListener('submit', submitAdd);
    $('story-select').addEventListener('change', (e) => {
        const picked = e.target.value;
        if (picked !== NEW_STORY) {
            pickStory(picked);
            return;
        }
        e.target.value = storyId ?? '';    // stays on the open story unless one is made
        openAddDialog('story');
    });
}

// --- story dialog: about the open story, files in and out ---

const SOURCE_NOTES = {
    builtin: 'Comes with StoryNode.',
    edited: 'Comes with StoryNode, with pages added in this browser.',
    local: 'Kept in this browser only. Download it to keep a copy.',
};

function setUpStoryDialog() {
    const dialog = $('story-dialog');
    const showErrors = (errors) => {
        $('story-errors').textContent = errors.join('\n');
        $('story-errors').hidden = errors.length === 0;
    };
    const current = () => stories().find(s => s.id === storyId);
    const fill = () => {
        const entry = current();
        $('dialog-title').textContent = story?.title ?? 'Story';
        $('story-overview').textContent = overviewOf(storyData);
        $('story-source').textContent = SOURCE_NOTES[entry?.source] ?? '';
        const remove = $('story-remove');
        remove.hidden = !entry || entry.source === 'builtin';
        remove.textContent = entry?.source === 'edited' ? 'Remove my additions' : 'Delete this story';
        $('story-download').disabled = !storyData;
        showErrors([]);
    };
    $('story-button').addEventListener('click', () => {
        fill();
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
        const { errors } = loadStory(data);
        if (errors.length) {
            showErrors(errors);
            return;
        }
        const id = idFor(data.title || file.name.replace(/\.json$/i, ''), stories().map(s => s.id));
        local[id] = data;
        pickStory(id);
        dialog.close();
    });
    $('story-download').addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(storyData, null, 4)], { type: 'application/json' }));
        const link = el('a', { href: url, download: `${storyId}.json` });
        link.click();
        URL.revokeObjectURL(url);
    });
    $('story-remove').addEventListener('click', () => {
        const entry = current();
        if (!entry || entry.source === 'builtin') return;
        const ask = entry.source === 'edited'
            ? `Remove the pages added to “${entry.title}” in this browser?`
            : `Delete “${entry.title}”? It's only kept in this browser.`;
        if (!confirm(ask)) return;
        delete local[entry.id];
        const next = entry.source === 'edited' ? entry.id : stories()[0]?.id;
        if (next) pickStory(next);
        else saveLibrary();
        dialog.close();
    });
}

// The stories that come with the app. A file that fails to load or check is
// skipped, so one bad story doesn't hide the rest.
async function loadBuiltIn() {
    const ids = await (await fetch(`${STORIES_URL}index.json`)).json();
    const loaded = await Promise.all(ids.map(async (id) => {
        try {
            const data = await (await fetch(`${STORIES_URL}${id}.json`)).json();
            return loadStory(data).errors.length ? null : { id, data };
        } catch {
            return null;
        }
    }));
    return loaded.filter(Boolean);
}

// What this browser has kept. A story saved before there were several was
// either the sample with pages added or a file someone opened.
function loadLocal() {
    const saved = readJson(LIBRARY_KEY);
    const kept = saved?.stories && typeof saved.stories === 'object' ? saved.stories : {};
    const old = readJson(OLD_STORY_KEY);
    if (old && !saved) {
        const same = builtIn.find(s => s.data.title === old.title);
        kept[same?.id ?? idFor(old.title, builtIn.map(s => s.id))] = old;
    }
    return { kept, current: saved?.current ?? Object.keys(kept)[0] };
}

// --- boot ---

async function boot() {
    setUpVoiceSettings();
    setUpStoryDialog();
    setUpAddDialog();
    setUpMap();
    setUpTalkButton();
    setUpArcControls();
    setUpVoiceLog();
    $('read-back').addEventListener('click', goBack);
    $('read-restart').addEventListener('click', restart);
    window.addEventListener('hashchange', () => {
        if (mode() !== 'voice') {
            stopVoice();
            voice.compose = null;
            voice.connect = null;
            setVoiceState('idle');
        }
        render();
    });

    try {
        builtIn = await loadBuiltIn();
    } catch (error) {
        document.querySelector('main').prepend(el('p', { class: 'errors' }, `Couldn't load the stories: ${error.message}. Serve this folder over http (see README).`));
    }
    const { kept, current } = loadLocal();
    local = kept;
    // The one you were in, else the first that opens.
    for (const id of [current, ...stories().map(s => s.id)]) {
        if (id && openStory(id).length === 0) break;
    }
    if (storyId) writeJson(OLD_STORY_KEY, null);
    renderPicker();
    render();
}

boot();
