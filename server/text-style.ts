// Deterministic enforcement of Charlie's no-em-dash rule on outbound text.
// The model breaks the rule reliably even with it in the system prompt and
// brain, so we strip in code at the exit points (after the model), making
// model compliance irrelevant. This is the single source of truth; call it at
// every outbound exit (iMessage send path, brain-write request build).
//
// Behavior:
//  - em dash (U+2014) and en dash (U+2013), in runs and with any surrounding
//    spaces/tabs, collapse to a comma + single space.
//  - plain hyphens (U+002D) are untouched, so compounds ("draft-and-ask") and
//    code survive.
//  - a dash adjacent to an existing comma does not produce a double comma.
//  - idempotent: the output contains no em/en dashes, so a second pass is a
//    no-op.
export function stripEmDashes(text: string): string {
  return text
    .replace(/[ \t]*[—–]+[ \t]*/g, ", ")
    .replace(/,[ \t]*(?:,[ \t]*)+/g, ", ");
}
