export function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value : {};
}
