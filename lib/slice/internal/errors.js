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
