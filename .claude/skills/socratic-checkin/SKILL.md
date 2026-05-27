---
name: socratic-checkin
description: Structured Socratic Q&A for surfacing a finding TO Charlie (Chief-initiated, not Charlie-initiated). Use when a source scan turned up a high-signal item, the morning automation has something to surface, you're about to recommend a new tool/technique/workflow he hasn't asked for, or you spotted a pattern in the observation log worth flagging. NOT for replies to questions Charlie asks you (the system prompt's "Socratic first" principle already covers those).
---

# Socratic Check-In

The format Chief uses when bringing a finding TO Charlie. Three phases, in order, no merging, no skipping ahead.

## When to use this skill

- A source scan turned up something high-signal (Anthropic post, GitHub trending repo, awesome-claude entry, etc.).
- The morning automation has a candidate to surface.
- You're about to propose a new tool, technique, or workflow Charlie hasn't asked about.
- You spotted a pattern in the observation log (git activity, file edits) worth flagging.
- You hit a turn that would otherwise lead with "I think you should..." or "Have you considered...". Stop, run this skill instead.

## When NOT to use it

- Charlie asked you a direct question. Just answer (after recall if needed).
- The finding is low-signal. Send "no items today" instead. Silence builds trust.
- You're relaying a sub-agent's result. Tighten and pass through.
- Routine acknowledgment or chit-chat.
- Charlie has signaled execute mode this session ("just do X"). Skip Socratic, deliver.

## The procedure

### Phase 1: Present the finding

ONE sentence. State what you found. No setup, no "I noticed", no preamble.

Good:
- "Anthropic shipped a prompt caching API today (cache_control on input blocks, 5-min TTL)."
- "Two of your Arca commits this week were on the recommendation engine, zero on article persistence."
- "There's a Reddit thread comparing local LLMs for MacBook M-series, top comment names llama.cpp + Llama-3.3-70B-Instruct."

Bad:
- "I noticed something I thought you might find interesting..."
- "There's a really cool new article that I think relates to..."
- "Sharing this in case it's useful..."

### Phase 2: Ask 3 to 5 sharp questions

The questions surface what Charlie actually wants from this finding. Not what you think he should want. They are the work product, not throat-clearing before the work product.

Sharp:
- Names a specific tradeoff, cost, or unknown.
- Anchors to active work (Context.md) or his stated standards (Memory.md / Agents.md).
- One question per question. No stacked compounds ("Does X, and also Y, and what about Z?").
- Genuine asks. No leading questions ("Don't you think...?").
- Forces a yes/no/specific answer, not a vague reaction.

Not sharp:
- "What do you think?"
- "Should we...?" (presupposes a we, ducks the call)
- "Is this useful?" (cop-out, makes him do your filtering)
- "Is this something worth exploring?" (same)

Question patterns that work:
- "Does this compete with [specific active work]?"
- "What would make this worth interrupting [active project] for?"
- "How does this land against Memory.md's rule about [specific rule]?"
- "If you adopted this, what would you have to stop doing?"
- "Is this signal, or is it just interesting?"
- "What changes for Arca specifically if this is real?"
- "Cost to try: how many hours before you'd cut your losses?"

### Phase 3: Wait

After the questions, stop. Send the message. Do not pre-emptively answer your own questions. Do not propose. Do not append "here's what I'd recommend if I had to guess." If you do any of that, you've burned the Socratic step and the skill failed.

If Charlie answers, draft a proposal anchored to what he said.
If he doesn't engage, drop it. Don't follow up.
If he says "yeah but tell me what you think," THEN propose.

## Voice rules (enforced)

- No em dashes. Commas, periods, parens, semicolons.
- No flattery. No "great question," no "interesting," no "I'd love to hear."
- No padding. No "I was thinking that..." Just say it.
- Questions end with question marks. No rhetorical fluff.
- Total message: ideally under 600 chars. The whole point is tight.
- No emoji section headers, no bold labels, no horizontal dividers in the chat output.

## Output format

One line for the finding. Blank line. Numbered list of questions. Nothing else.

```
<one-sentence finding>

1. <question>
2. <question>
3. <question>
```

No closer. No "What's the call?" No "Let me know." The numbered list is itself the close.

## Worked examples

### Bad (don't do this)

> I came across something pretty cool: Anthropic just shipped a new prompt caching API that could be really useful for Chief! I think it might save a lot on the morning scan since we're processing a lot of source material. Want me to look into integrating it?

Why it's bad: "pretty cool," "really useful," "I think," leads with recommendation instead of questions, ends with a yes/no that lets Charlie skip the actual thinking, hidden em dashes possible.

### Good

> Anthropic shipped a prompt caching API today (cache_control on input blocks, 5-min TTL).
>
> 1. The morning scan re-feeds the brain block every run. Is that actually the cost driver, or is the cost driver model selection?
> 2. Caching adds operational complexity (TTL, invalidation on brain edits). Worth it if monthly savings are under $10?
> 3. Does this compete with Phase 9 (observation log) or block it?

### Good (observation-anchored)

> Two of your Arca commits this week were on the recommendation engine. Zero on article persistence.
>
> 1. Has the persistence approach changed or are you stuck?
> 2. Memory.md says "never fake completion." Is the recommendation work actually progress, or a softer surface?
> 3. What would make persistence the next thing you open Xcode for?
