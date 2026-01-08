import { OFFICIAL_SYSTEM_PROMPT } from '../../config.js';

function normalizeSystemParts(input) {
    if (!input) return [];

    // String -> one text part
    if (typeof input === 'string') {
        const text = input.trim();
        return text ? [{ text }] : [];
    }

    // { role, parts } or { parts }
    if (typeof input === 'object' && !Array.isArray(input)) {
        if (Array.isArray(input.parts)) {
            return input.parts
                .filter((p) => p && typeof p === 'object')
                .map((p) => {
                    if (typeof p.text === 'string') {
                        const text = p.text.trim();
                        return text ? { text } : null;
                    }
                    // Preserve non-text parts if present (rare for systemInstruction)
                    if (p.inlineData) return { inlineData: p.inlineData };
                    return null;
                })
                .filter(Boolean);
        }
        return [];
    }

    // Array of parts
    if (Array.isArray(input)) {
        return input
            .filter((p) => p && typeof p === 'object')
            .map((p) => {
                if (typeof p.text === 'string') {
                    const text = p.text.trim();
                    return text ? { text } : null;
                }
                if (p.inlineData) return { inlineData: p.inlineData };
                return null;
            })
            .filter(Boolean);
    }

    return [];
}

/**
 * Build upstream-compatible systemInstruction, always prepending the official prompt.
 *
 * @param {string|object|Array|null} userSystemInstruction - user-provided system instruction (string or {parts} or parts[])
 * @returns {{role:'user', parts:Array}|null}
 */
export function buildUpstreamSystemInstruction(userSystemInstruction) {
    const official = String(OFFICIAL_SYSTEM_PROMPT || '').trim();
    const userParts = normalizeSystemParts(userSystemInstruction);

    const parts = [];
    if (official) parts.push({ text: official });
    if (userParts.length > 0) parts.push(...userParts);

    if (parts.length === 0) return null;
    return { role: 'user', parts };
}

