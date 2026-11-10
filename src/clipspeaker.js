// A speaker that plays audio clips instead of using the browser's voice.
// Same shape as createSpeaker in speech.js (speak, cancel, position, unlock,
// setRate), so app.js can swap one for the other.
//
// Where the clips come from is the `source`'s business: a model running in
// the page today; files made ahead of time or a speech service could be
// others. A source is { clip(sentence, { rate }) → Promise<clip | null>,
// drop() }. null means "no clip for this one", and that sentence is spoken
// by `fallback` (the browser voice) instead, so a source that is still
// loading, or broken, costs nothing but the nicer voice.
//
// Pure: the source, the player and the fallback are passed in.

import { sentences } from './speech.js';

export function createClipSpeaker({ source, player, fallback }) {
    let token = 0;
    let position = 0;
    let rate = 1;

    const stopAll = () => {
        player.stop();
        source.drop();
        fallback.cancel();
    };

    return {
        setRate(r) { rate = r; },

        // Call from a tap: audio, like speech, has to be started by one.
        unlock() { player.unlock(); },

        position: () => position,

        // Resolves true when done, false if cancelled. One sentence at a
        // time; the next one's clip is fetched while this one plays.
        async speak(text, { from = 0 } = {}) {
            const mine = ++token;
            stopAll();
            position = from;
            const parts = sentences(text).slice(from);
            let next = parts.length ? source.clip(parts[0], { rate }) : null;
            for (let i = 0; i < parts.length; i++) {
                const clip = await next;
                if (mine !== token) return false;
                next = i + 1 < parts.length ? source.clip(parts[i + 1], { rate }) : null;
                position = from + i;
                let ok = clip ? await player.play(clip) : false;
                if (mine !== token) return false;
                if (!ok) ok = await fallback.speak(parts[i]);
                if (mine !== token || !ok) return false;
                position = from + i + 1;
            }
            return true;
        },

        cancel() {
            token++;
            stopAll();
        },
    };
}
