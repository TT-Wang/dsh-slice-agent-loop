export declare function wrapUntrusted(content: string, opts?: {
    kind?: string;
    verifyAgainstOpenFiles?: boolean;
}): string;
export declare function redactText(text: string | null | undefined, opts?: {
    codeFile?: boolean;
}): string;
