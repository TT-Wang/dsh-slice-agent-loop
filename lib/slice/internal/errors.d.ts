/**
 * Python-runtime error types with byte-identical message semantics.
 * The golden harness formats errors as `${pyName}: ${message}` (Python's
 * `f"{type(exc).__name__}: {exc}"`), so each error carries its Python class name.
 */
export declare class ValueError extends Error {
    readonly pyName: string;
    constructor(message: string);
}
export declare class PyTypeError extends Error {
    readonly pyName = "TypeError";
    constructor(message: string);
}
/** context.ContextUnfitError — subclasses ValueError in Python too. */
export declare class ContextUnfitError extends ValueError {
    readonly pyName: string;
    readonly requiredChars: number;
    readonly capacityChars: number;
    readonly mandatoryItems: readonly string[];
    constructor(requiredChars: number, capacityChars: number, mandatoryItems: readonly string[]);
}
