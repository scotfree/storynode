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

// onState('waiting' | 'playing') says whether it's quiet because a clip is
// still being made, or because one is playing.
export function createClipSpeaker({ source, player, fallback, onState = () => {} }) {
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
        // time. Every clip is asked for up front, so a source that makes
        // them slowly works through the rest while the first ones play.
        async speak(text, { from = 0 } = {}) {
            const mine = ++token;
            stopAll();
            position = from;
            const parts = sentences(text).slice(from);
            const clips = parts.map(part => source.clip(part, { rate }));
            for (let i = 0; i < parts.length; i++) {
                onState('waiting');
                const clip = await clips[i];
                if (mine !== token) return false;
                position = from + i;
                onState('playing');
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
