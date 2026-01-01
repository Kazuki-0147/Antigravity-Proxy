// Claude tool-result compatibility:
// upstream sometimes requires "a text part exists" to reliably emit thought parts.
// Use a single space to avoid "Continue."-style semantic injection.
export const CLAUDE_TOOL_RESULT_TEXT_PLACEHOLDER = ' ';

function parseBooleanEnv(name, defaultValue) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    const v = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    return defaultValue;
}

export function shouldInjectClaudeToolResultPlaceholder() {
    return parseBooleanEnv('CLAUDE_TOOL_RESULT_PLACEHOLDER', true);
}

// Claude thinking + tool calling:
// when tool schema has no `required`, upstream sometimes outputs only thinking and ends (no tool_call).
// Fix:
// 1) Inject a required placeholder field into schema when required is empty
// 2) Strip the placeholder from tool_call args when returning to client
// 3) Re-inject it when forwarding replayed history back upstream
const CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER = '__ag_required';
const CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER_VALUE = true;

export function needsClaudeToolRequiredArgPlaceholder(schema) {
    if (!schema || typeof schema !== 'object') return false;
    const type = typeof schema.type === 'string' ? schema.type.toUpperCase() : '';
    if (type !== 'OBJECT') return false;
    const required = schema.required;
    return !Array.isArray(required) || required.length === 0;
}

export function injectClaudeToolRequiredArgPlaceholderIntoSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (!needsClaudeToolRequiredArgPlaceholder(schema)) return schema;

    const wantsUpper = typeof schema.type === 'string' && schema.type === schema.type.toUpperCase();
    const placeholderType = wantsUpper ? 'BOOLEAN' : 'boolean';

    const properties = { ...(schema.properties || {}) };
    if (!properties[CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER]) {
        properties[CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER] = {
            type: placeholderType,
            description: 'Internal placeholder required by proxy; must be true.'
        };
    }

    return {
        ...schema,
        type: schema.type || (wantsUpper ? 'OBJECT' : 'object'),
        properties,
        required: [CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER]
    };
}

export function injectClaudeToolRequiredArgPlaceholderIntoArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    if (Object.prototype.hasOwnProperty.call(args, CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER)) return args;
    return { ...args, [CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER]: CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER_VALUE };
}

export function stripClaudeToolRequiredArgPlaceholderFromArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    if (!Object.prototype.hasOwnProperty.call(args, CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER)) return args;
    const { [CLAUDE_TOOL_REQUIRED_ARG_PLACEHOLDER]: _ignored, ...rest } = args;
    return rest;
}
