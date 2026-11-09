// The browser's own speech: speechSynthesis to read aloud, SpeechRecognition
// to hear a choice. No server, no downloads. Chrome and Safari have both;
// Firefox can speak but not listen.

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

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

    return {
        voices: () => synth?.getVoices() ?? [],
        setVoice(v) { voice = v; },
        setRate(r) { rate = r; },

        // Resolves true when done, false if cancelled. Call the first speak()
        // from a tap: Safari only allows speech that a user gesture started.
        speak(text) {
            const mine = ++token;
            synth.cancel();
            const parts = sentences(text);
            if (parts.length === 0) return Promise.resolve(true);
            return new Promise((resolve) => {
                parts.forEach((part, i) => {
                    const u = new SpeechSynthesisUtterance(part);
                    if (voice) {
                        u.voice = voice;
                        u.lang = voice.lang;
                    }
                    u.rate = rate;
                    if (i === parts.length - 1) {
                        u.onend = () => resolve(mine === token);
                        u.onerror = () => resolve(false);
                    }
                    synth.speak(u);
                });
            });
        },

        cancel() {
            token++;
            synth?.cancel();
        },
    };
}

// Listens for one utterance. Resolves { alternatives, error }: the
// recognizer's guesses (best first), or an error such as 'no-speech' or
// 'not-allowed'. abort() ends it early.
export function listenOnce({ lang = 'en-US', phrases = [], maxAlternatives = 5 } = {}) {
    if (!Recognition) {
        return { promise: Promise.resolve({ alternatives: [], error: 'unsupported' }), abort() {} };
    }
    const r = new Recognition();
    r.lang = lang;
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = maxAlternatives;
    if (support().hints && phrases.length) {
        try {
            r.phrases = phrases.map(p => new globalThis.SpeechRecognitionPhrase(p, 5));
        } catch {
            // Hints are a bonus; recognition works without them.
        }
    }
    let alternatives = [];
    let error = null;
    const promise = new Promise((resolve) => {
        r.onresult = (e) => {
            alternatives = Array.from(e.results[0] ?? [], a => a.transcript.trim()).filter(Boolean);
        };
        r.onerror = (e) => { error = e.error; };
        r.onend = () => resolve({ alternatives, error: alternatives.length ? null : (error ?? 'no-speech') });
    });
    try {
        r.start();
    } catch (e) {
        return { promise: Promise.resolve({ alternatives: [], error: e.name || 'start-failed' }), abort() {} };
    }
    return { promise, abort: () => r.abort() };
}
