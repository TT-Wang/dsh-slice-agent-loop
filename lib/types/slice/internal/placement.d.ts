/**
 * Placement-law resolver registry. Python's ContextBlock.__post_init__ does a lazy
 * `from .regions import region_zone` so the dataclass stays usable without the
 * region registry; regions.py then provides the one resolver. ESM forbids that
 * cycle, so regions.ts registers its resolver here at module load. Before
 * registration the safe Python fallback applies: an unknown item lands in the TAIL
 * (zone 2), which is exactly what region_zone returns for undeclared names.
 */
export declare function registerZoneResolver(fn: (name: string) => number): void;
export declare function zoneOf(name: string): number;
