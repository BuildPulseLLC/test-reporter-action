# External voice: no em-dashes

This file is the canonical rule. It is copied verbatim into every repo that owns
a public surface: `agents`, `web-client`, `customer-agents`,
`test-reporter-action`. Change it in one place and port the change to the rest.

## Scope

Everything BuildPulse publishes or sends outside the company:

- Blog posts and the prompts that generate them
- Marketing pages, pricing, comparison, and about copy
- Social captions, video scripts, voiceover, and audio explainers
- Public READMEs and docs
- Review comments and notices we post on customer pull requests
- In-product copy a customer reads
- Outbound email

Out of scope: internal code comments, internal runbooks, log lines, commit
messages, and anything only employees read. Those are not worth the diff noise.

## The rule

Do not use the em-dash (`—`, U+2014) or the horizontal bar (`―`, U+2015).

Do not use an en-dash (U+2013) with a space on either side in their place. That
is the same tell wearing a hat.

Keep the unspaced en-dash in numeric ranges: `20–40%`, a `100–800` person
company. That is correct typography and reads as human.

Never substitute a hyphen with a space on either side. It is a worse em-dash and
it reads as a find-and-replace job rather than a rewrite.

(Those two rules are written out in words on purpose. Written as inline code the
significant spaces get trimmed by a formatter, which silently inverts what the
rule says.)

## How to rewrite, by job

An em-dash does at least five different jobs. Each has its own correct fix.
Pick by what the dash was actually doing, not by what is quickest.

| Job                                  | Use instead                     | Before                                                              | After                                                              |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Abrupt pivot into a punchline        | Full stop, two sentences        | `You didn't fix it — you bribed it.`                                | `You didn't fix it. You bribed it.`                                |
| Introducing an explanation           | Colon                           | `Code blocks don't count — a code-heavy post needs the same prose.` | `Code blocks don't count: a code-heavy post needs the same prose.` |
| Label before a definition, in a list | Colon                           | `**Bugs** — logic errors, nil deref.`                               | `**Bugs**: logic errors, nil deref.`                               |
| Paired aside                         | Parentheses, or commas if short | `environments — fintech, healthtech — where CI gates`               | `environments (fintech, healthtech) where CI gates`                |
| Clause tacked on the end             | Comma, or recast                | `...in AI features — or email support.`                             | `...in AI features, or email support.`                             |

If none of those land cleanly, rewrite the sentence. The dash was often hiding a
sentence that wanted to be two.

## Why

Two reasons, and the second is the one that matters.

The em-dash is the single most recognizable tell of machine-written prose, and
our audience is engineers who spot it instantly. A post that reads as generated
undercuts the argument in it, and a review comment that reads as generated gets
dismissed before the finding is read.

More importantly, the dash is a way to avoid deciding what the relationship
between two clauses actually is. Choosing a colon, a full stop, or parentheses
forces that decision, and the prose gets sharper for it.

## For prompts specifically

A prompt that bans em-dashes while being written in em-dash style will lose to
its own example. Models copy the register of their instructions more reliably
than they follow a rule buried in a bullet list.

So: strip the dashes from the prompt's own prose, then state the rule. Both, not
either.

State the rule as a taxonomy, not a prohibition. Told only "no em-dashes", a
model swaps in a spaced hyphen and you have gained nothing.

## Enforcement

| Surface                      | Guard                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| Blog posts                   | `agents/blog-generator/validate.go` hard reject, fed back into the model's retry loop |
| Social captions              | `agents/social-poster/compose.go` re-asks once, then publishes and warns              |
| Video captions and voiceover | `agents/video-poster/shotlist.go` critique pass checks for it                         |
| Customer PR cap notice       | `customer-agents/review-trigger/capnotice_test.go`                                    |
| Marketing pages              | `web-client/__tests__/marketing/emDashGuard.test.ts`                                  |

Anything not in that table is on the author. The guards exempt this file, since
it necessarily quotes the character it bans, and they exempt fenced code blocks,
because a dash inside sample output belongs to the code and not to our voice.
