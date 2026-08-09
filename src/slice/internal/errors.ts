/**
 * Python-runtime error types with byte-identical message semantics.
 * The golden harness formats errors as `${pyName}: ${message}` (Python's
 * `f"{type(exc).__name__}: {exc}"`), so each error carries its Python class name.
 */

export class ValueError extends Error {
  readonly pyName: string = "ValueError";
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class PyTypeError extends Error {
  readonly pyName = "TypeError";
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
  }
}

/** context.ContextUnfitError — subclasses ValueError in Python too. */
export class ContextUnfitError extends ValueError {
  readonly pyName: string = "ContextUnfitError";
  readonly requiredChars: number;
  readonly capacityChars: number;
  readonly mandatoryItems: readonly string[];

  constructor(requiredChars: number, capacityChars: number, mandatoryItems: readonly string[]) {
    super(
      `mandatory context needs ${requiredChars} chars but capacity is ${capacityChars}; ` +
      `items=${mandatoryItems.join(", ") || "(none)"}`,
    );
    this.name = "ContextUnfitError";
    this.requiredChars = requiredChars;
    this.capacityChars = capacityChars;
    this.mandatoryItems = mandatoryItems;
  }
}
