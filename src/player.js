// Plays audio clips ({ samples: Float32Array, sampleRate }) one at a time.
// The browser side of clipspeaker.js.
//
// Clips go through an ordinary <audio> element as WAV files, not through Web
// Audio. On Apple devices Web Audio is the "ambient" kind of sound: the
// iPhone's silent switch mutes it, and after the microphone has been used it
// can be routed somewhere quiet, while the browser's own voice carries on.
// An <audio> element is media playback, like a video, so it is heard
// wherever the browser voice is.
//
// One element is reused for every clip: Safari lets a page play an element
// it was allowed to play once, from a tap, which is what unlock() does.

const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
const SLACK_MS = 3000;      // a clip that hasn't ended this long after it should have is stuck

// 16-bit mono WAV bytes for some samples (-1 to 1). Pure.
export function wavBytes(samples, sampleRate) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);       // the format block's size
    view.setUint16(20, 1, true);        // plain PCM
    view.setUint16(22, 1, true);        // one channel
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
    return bytes;
}

// A tenth of a second of silence, for unlocking.
const silence = () => new Blob([wavBytes(new Float32Array(2400), 24000)], { type: 'audio/wav' });

// onEvent(name, detail) reports what happened to each clip, for the voice log:
// 'played', 'blocked' (the browser refused to play), 'failed', 'stuck'.
export function createPlayer({
    makeAudio = () => new Audio(),
    makeUrl = (blob) => URL.createObjectURL(blob),
    dropUrl = (url) => URL.revokeObjectURL(url),
    onEvent = () => {},
    timers = realTimers,
    now = () => Date.now(),
} = {}) {
    let element = null;
    let unlocked = false;
    let playing = null;

    const audio = () => {
        if (!element) {
            element = makeAudio();
            element.preload = 'auto';
            element.setAttribute?.('playsinline', '');
        }
        return element;
    };

    return {
        // Call from a tap: Safari only lets an element play that a tap started.
        unlock() {
            try {
                const el = audio();
                const url = makeUrl(silence());
                el.src = url;
                const done = () => dropUrl(url);
                Promise.resolve(el.play()).then(() => { unlocked = true; done(); }, done);
            } catch {
                // No audio here; play() will say so.
            }
        },

        // Resolves true when the clip has played, false if stopped or it
        // couldn't play (the caller then reads that sentence another way).
        play({ samples, sampleRate }) {
            return new Promise((resolve) => {
                let el;
                let url;
                try {
                    el = audio();
                    url = makeUrl(new Blob([wavBytes(samples, sampleRate)], { type: 'audio/wav' }));
                } catch (error) {
                    onEvent('failed', error?.name ?? 'no audio');
                    resolve(false);
                    return;
                }
                const seconds = samples.length / sampleRate;
                const started = now();
                const mine = { done: false };
                const finish = (ok, event, detail) => {
                    if (mine.done) return;
                    mine.done = true;
                    timers.clear(mine.timer);
                    el.onended = null;
                    el.onerror = null;
                    if (playing === mine) playing = null;
                    dropUrl(url);
                    if (event) onEvent(event, detail);
                    resolve(ok);
                };
                mine.finish = finish;
                playing = mine;
                el.onended = () => finish(true, 'played', `${seconds.toFixed(1)} s clip, ended after ${((now() - started) / 1000).toFixed(1)} s`);
                el.onerror = () => finish(false, 'failed', `the browser couldn't play the clip (${el.error?.code ?? 'unknown'})`);
                // If it never ends, give up so the sentence is read another way.
                mine.timer = timers.set(() => finish(false, 'stuck', `${seconds.toFixed(1)} s clip still playing after ${((now() - started) / 1000).toFixed(1)} s`), seconds * 1000 + SLACK_MS);
                el.src = url;
                Promise.resolve(el.play()).catch((error) => finish(false, 'blocked', `${error?.name ?? 'refused'}: tap the button to allow sound`));
            });
        },

        // 'running' once a tap has allowed sound; 'locked' before.
        state: () => (unlocked ? 'running' : 'locked'),

        stop() {
            const mine = playing;
            if (!mine) return;
            try {
                element.pause();
            } catch {
                // Already over.
            }
            mine.finish(false);
        },
    };
}
