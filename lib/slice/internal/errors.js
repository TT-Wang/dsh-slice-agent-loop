/**
 * Python-runtime error types with byte-identical message semantics.
 * The golden harness formats errors as `${pyName}: ${message}` (Python's
 * `f"{type(exc).__name__}: {exc}"`), so each error carries its Python class name.
 */
export class ValueError extends Error {
    pyName = "ValueError";
    constructor(message) {
        super(message);
        this.name = "ValueError";
    }
}
export class PyTypeError extends Error {
    pyName = "TypeError";
    constructor(message) {
        super(message);
        this.name = "TypeError";
    }
}
/** context.ContextUnfitError — subclasses ValueError in Python too. */
export class ContextUnfitError extends ValueError {
    pyName = "ContextUnfitError";
    requiredChars;
    capacityChars;
    mandatoryItems;
    constructor(requiredChars, capacityChars, mandatoryItems) {
        super(`mandatory context needs ${requiredChars} chars but capacity is ${capacityChars}; ` +
            `items=${mandatoryItems.join(", ") || "(none)"}`);
        this.name = "ContextUnfitError";
        this.requiredChars = requiredChars;
        this.capacityChars = capacityChars;
        this.mandatoryItems = mandatoryItems;
    }
}
