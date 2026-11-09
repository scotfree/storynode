// Tracks a drag around a center point as a signed sweep in degrees. Pure.
// Degrees run clockwise from the top, so clockwise sweeps are positive.

const wrap = (degrees) => (((degrees + 180) % 360) + 360) % 360 - 180;

export function angleAt(x, y, cx, cy) {
    return Math.atan2(x - cx, -(y - cy)) * 180 / Math.PI;
}

// direction: 1 clockwise, -1 counterclockwise, 0 either way.
// update(x, y) returns { sweep, fired }; `fired` is true once, on the move
// that reaches the target. Dragging the wrong way doesn't build up.
//
// deadzone: near the center the angle is mostly jitter, so those moves are
// ignored. maxStep: a jump this large in one move is the pointer cutting
// across, not going around, so it adds nothing.
export function createSweep({ cx, cy, startX, startY, direction = 0, target = 180, deadzone = 24, maxStep = 90 }) {
    const min = direction > 0 ? 0 : -target;
    const max = direction < 0 ? 0 : target;
    let last = angleAt(startX, startY, cx, cy);
    let sweep = 0;
    let hasFired = false;

    return {
        update(x, y) {
            if (Math.hypot(x - cx, y - cy) >= deadzone) {
                const angle = angleAt(x, y, cx, cy);
                const step = wrap(angle - last);
                last = angle;
                if (Math.abs(step) <= maxStep) sweep = Math.min(max, Math.max(min, sweep + step));
            }
            const fired = !hasFired && Math.abs(sweep) >= target;
            if (fired) hasFired = true;
            return { sweep, fired };
        },
    };
}
