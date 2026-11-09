// The browser's own speech: speechSynthesis to read aloud, SpeechRecognition
// to hear a choice. No server, no downloads. Chrome and Safari have both;
// Firefox can speak but not listen.

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

const CANCEL_GAP_MS = 60;        // pause between cancel() and the next speech
const MIC_OPEN_MS = 2000;        // give up if the mic hasn't opened by then
const RELEASE_MS = 3000;         // give up waiting for a result after stop()
const FIRST_SILENCE_MS = 10000;  // hands-free: nothing said at all
const AFTER_SPEECH_MS = 2000;    // hands-free: quiet after speech, browser hasn't ended
const MAX_SESSIONS = 12;         // a hold can't loop forever on sessions that end at once

const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

export function support() {
    return {
        speak: 'speechSynthesis' in globalThis,
        listen: Boolean(Recognition),
        // Newer Chrome: bias recognition toward the phrases we expect.
        hints: Boolean(Recognition && globalThis.SpeechRecognitionPhrase && 'phrases' in Recognition.prototype),
    };
}

// Splits text into sentences. Chrome stops long utterances after ~15 s, so
// we speak one sentence at a time. Pure, for tests.
export function sentences(text) {
    return String(text ?? '')
        .split(/(?<=[.!?…]["”’)]?)\s+|\n+/)
        .map(s => s.trim())
        .filter(Boolean);
}

// Prefer the better voices a device has (Apple's Enhanced/Premium, Google,
// Microsoft "Natural"), in the page's language.
export function rankVoices(voices, lang = 'en') {
    const score = (v) => (v.lang?.toLowerCase().startsWith(lang) ? 100 : 0)
        + (/premium/i.test(v.name) ? 30 : 0)
        + (/enhanced|natural|neural/i.test(v.name) ? 20 : 0)
        + (/google/i.test(v.name) ? 10 : 0)
        + (v.localService ? 1 : 0);
    return [...voices].sort((a, b) => score(b) - score(a));
}

export function createSpeaker({ synth = globalThis.speechSynthesis } = {}) {
    let voice = null;
    let rate = 1;
    let token = 0;
    let cancelledAt = 0;
    let position = 0;

    const isBusy = () => Boolean(synth?.speaking || synth?.pending);
    const cancelNow = () => {
        // Safari can lose onend for an utterance queued right after cancel(),
        // so only cancel when something is playing, and leave a short gap.
        if (!isBusy()) return;
        synth.cancel();
        cancelledAt = Date.now();
    };

    return {
        voices: () => synth?.getVoices() ?? [],
        setVoice(v) { voice = v; },
        setRate(r) { rate = r; },

        // Call from a tap, before any await: Safari only allows speech that a
        // user gesture started, and this counts as the start.
        unlock() {
            synth?.speak(new SpeechSynthesisUtterance(' '));
        },

        // The sentence being spoken, or the next one if between sentences.
        // speak(text, { from: position() }) picks up from there.
        position: () => position,

        // Resolves true when done, false if cancelled. The first speak() must
        // come from a tap unless unlock() already did.
        speak(text, { from = 0 } = {}) {
            const mine = ++token;
            cancelNow();
            position = from;
            const parts = sentences(text).slice(from);
            if (parts.length === 0) return Promise.resolve(true);
            return new Promise((resolve) => {
                const queue = () => {
                    if (mine !== token) {
                        resolve(false);
                        return;
                    }
                    parts.forEach((part, i) => {
                        const u = new SpeechSynthesisUtterance(part);
                        if (voice) {
                            u.voice = voice;
                            u.lang = voice.lang;
                        }
                        u.rate = rate;
                        const isLast = i === parts.length - 1;
                        // `token` changes on cancel, so a cancelled sentence
                        // doesn't count as finished.
                        u.onstart = () => {
                            if (mine === token) position = from + i;
                        };
                        u.onend = () => {
                            if (mine === token) position = from + i + 1;
                            if (isLast) resolve(mine === token);
                        };
                        if (isLast) u.onerror = () => resolve(false);
                        synth.speak(u);
                    });
                };
                const wait = cancelledAt + CANCEL_GAP_MS - Date.now();
                // Queue synchronously when we can, to stay inside a tap.
                if (wait > 0) setTimeout(queue, wait);
                else queue();
            });
        },

        cancel() {
            token++;
            cancelNow();
        },
    };
}

// Turns what a held press heard into ranked guesses for match(). Each segment
// is one stretch of speech: its alternatives, best first. Several segments
// mean the recognizer split at a pause, so the top guess joins them.
export function mergeSegments(segments) {
    const filled = segments.filter(s => s.length > 0);
    if (filled.length === 0) return [];
    const last = filled[filled.length - 1];
    if (filled.length === 1) return [...new Set(last)];
    return [...new Set([filled.map(s => s[0]).join(' '), ...last])];
}

const alternativesOf = (result) => Array.from(result, a => a.transcript.trim()).filter(Boolean);

// Listens for one answer. `hold: true` keeps listening until stop(), starting
// a fresh session whenever the browser ends one at a pause. Otherwise a pause
// ends it. Non-continuous sessions on purpose: `continuous` is the mode iOS
// Safari is reported to stall in.
//
// Returns { promise, stop, abort }. stop() finishes and keeps what was heard;
// abort() discards it. The promise resolves { alternatives, segments, error,
// hintsRejected }. onEvent(name, detail) reports each step, for the voice log.
export function listenOnce({
    lang = 'en-US',
    phrases = [],
    maxAlternatives = 5,
    hold = false,
    hints = support().hints,
    onEvent = () => {},
    onInterim = () => {},
    RecognitionClass = Recognition,
    timers = realTimers,
} = {}) {
    if (!RecognitionClass) {
        return {
            promise: Promise.resolve({ alternatives: [], segments: [], error: 'unsupported', hintsRejected: false }),
            stop() {},
            abort() {},
        };
    }

    const segments = [];
    const timerIds = {};
    let useHints = hints && phrases.length > 0;
    let hintsRejected = false;
    let session = null;
    let sessionCount = 0;
    let micOpened = false;
    let released = false;
    let finished = false;
    let lastError = null;
    let resolveDone;
    const promise = new Promise((resolve) => { resolveDone = resolve; });

    const stopTimer = (name) => {
        if (timerIds[name] === undefined) return;
        timers.clear(timerIds[name]);
        delete timerIds[name];
    };
    const startTimer = (name, ms, fn) => {
        stopTimer(name);
        timerIds[name] = timers.set(fn, ms);
    };

    // Keeps what the current session heard, once. A session that never got a
    // final result still counts for its last interim words.
    const bankSession = () => {
        if (!session || session.banked) return;
        session.banked = true;
        if (session.finals.length) segments.push(...session.finals);
        else if (session.interim) segments.push([session.interim]);
    };

    const liveText = () => [
        ...segments.map(s => s[0]),
        ...(session.banked ? [] : [...session.finals.map(s => s[0]), session.interim]),
    ].filter(Boolean).join(' ');

    const finish = (error) => {
        if (finished) return;
        finished = true;
        bankSession();
        Object.keys(timerIds).forEach(stopTimer);
        const alternatives = mergeSegments(segments);
        resolveDone({
            alternatives,
            segments,
            error: alternatives.length ? null : (error ?? lastError ?? 'no-speech'),
            hintsRejected,
        });
    };

    const abortSession = () => {
        try {
            session?.r.abort();
        } catch {
            // Already over.
        }
    };

    function stop() {
        if (finished || released) return;
        released = true;
        stopTimer('open');
        stopTimer('silence');
        onEvent('stop');
        startTimer('release', RELEASE_MS, () => {
            onEvent('timeout', 'no result after release');
            abortSession();
            finish();
        });
        try {
            session.r.stop();
        } catch {
            finish();
        }
    }

    const stopOnSilence = () => {
        onEvent('timeout', 'silence');
        stop();
    };

    function onSessionEnd(ended) {
        if (ended.error === 'phrases-not-supported' && useHints && !released) {
            useHints = false;
            hintsRejected = true;
            lastError = null;
            onEvent('retry', 'without phrase hints');
            openSession();
            return;
        }
        bankSession();
        const canContinue = hold && !released && sessionCount < MAX_SESSIONS
            && (!ended.error || ended.error === 'no-speech');
        if (canContinue) {
            onEvent('rearm', 'still held');
            openSession();
            return;
        }
        finish(ended.error);
    }

    function openSession() {
        const r = new RecognitionClass();
        const mine = { r, finals: [], interim: '', banked: false, error: null };
        session = mine;
        sessionCount++;
        const stale = () => finished || session !== mine;

        r.lang = lang;
        r.continuous = false;
        r.interimResults = true;
        r.maxAlternatives = maxAlternatives;
        if (useHints) {
            try {
                r.phrases = phrases.map(p => new globalThis.SpeechRecognitionPhrase(p, 5));
            } catch {
                // Hints are a bonus; recognition works without them.
            }
        }

        r.onaudiostart = () => {
            if (stale()) return;
            micOpened = true;
            stopTimer('open');
            onEvent('mic-open');
            if (!hold && !released) startTimer('silence', FIRST_SILENCE_MS, stopOnSilence);
        };
        r.onspeechstart = () => { if (!stale()) onEvent('speech'); };
        r.onresult = (e) => {
            if (stale()) return;
            const results = Array.from(e.results);
            mine.finals = results.filter(x => x.isFinal).map(alternativesOf).filter(s => s.length);
            mine.interim = results.filter(x => !x.isFinal).map(x => x[0].transcript.trim()).join(' ').trim();
            onInterim(liveText());
            if (!hold && !released) startTimer('silence', AFTER_SPEECH_MS, stopOnSilence);
        };
        r.onerror = (e) => {
            if (stale()) return;
            mine.error = e.error;
            lastError = e.error;
            onEvent('error', e.error);
        };
        r.onend = () => {
            if (stale()) return;
            onEvent('session-end');
            onSessionEnd(mine);
        };

        if (!micOpened) {
            startTimer('open', MIC_OPEN_MS, () => {
                onEvent('timeout', 'mic never opened');
                abortSession();
                finish('mic-timeout');
            });
        }
        onEvent('session-start', `#${sessionCount}`);
        try {
            r.start();
        } catch (e) {
            finish(e.name || 'start-failed');
        }
    }

    openSession();

    return {
        promise,
        stop,
        abort() {
            if (finished) return;
            abortSession();
            session.banked = true;
            segments.length = 0;
            finish('aborted');
        },
    };
}
