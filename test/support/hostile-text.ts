/**
 * Text an attacker would choose for an event name, a task or a post's title, as
 * [label, text]. Each must come out inert from every renderer.
 */

import { fakeId } from "./ids.ts";

const SOME_ID = fakeId();

export const HOSTILE_TEXT: readonly (readonly [string, string])[] = [
  ["everyone ping", "@everyone free pizza"],
  ["here ping", "@here look"],
  ["role mention", `<@&${SOME_ID}> urgent`],
  ["user mention", `<@${SOME_ID}> urgent`],
  ["channel mention", `<#${SOME_ID}> go here`],
  ["slash command", `</event create:${SOME_ID}> click`],
  ["timestamp", "<t:1700000000:R> deadline"],
  ["custom emoji", `<:logo:${SOME_ID}> news`],
  ["masked link", "[Portal login required](https://evil.example/login)"],
  ["bare link", "https://evil.example/login"],
  ["link hidden from previews", "<https://evil.example/login>"],
  ["invite", "discord.gg/abcdef join"],
  ["bare domain", "evil.example sign in"],
  ["heading", "# System notice"],
  ["small text", "-# fine print"],
  ["quote", "> quoted staff message"],
  ["spoiler", "||hidden||"],
  ["code fence", "```js\nalert(1)\n```"],
  ["bold", "**Official** notice"],
  ["forged line", "Harmless\n# System: everyone must log in"],
  ["carriage return", "Harmless\r\n> forged"],
  ["line separator", "Harmless\u2028# forged"],
  ["bidi override", "abc\u202Egnp.exe"],
  ["bidi isolate", "abc\u2066def\u2069"],
  ["zero width in a link", "https://ev\u200Bil.example"],
  ["tag characters", "abc\u{E0041}\u{E0042}"],
  [
    "fullwidth link",
    "\uFF48\uFF54\uFF54\uFF50\uFF53\uFF1A\uFF0F\uFF0Fevil.example",
  ],
  ["fullwidth at", "\uFF20everyone"],
  ["stacked marks", `Z${"\u0300".repeat(50)}algo`],
];

/** Text that has nothing to show once cleaned. */
export const INVISIBLE_TEXT: readonly (readonly [string, string])[] = [
  ["zero width space", "\u200B\u200B"],
  ["hangul filler", "\u3164"],
  ["blank braille", "\u2800"],
  ["only spaces", "   "],
  ["only newlines", "\n\n"],
  ["only bidi", "\u202E\u202D"],
];

/** Text the database would refuse, or that cannot be stored faithfully. */
export const UNSTORABLE_TEXT: readonly (readonly [string, string])[] = [
  ["NUL", "abc\u0000def"],
  ["lone high surrogate", "abc\ud800def"],
  ["lone low surrogate", "\udc00abc"],
];

/**
 * True if Discord would act on any of this in a message. An escaped character has a
 * backslash before it, which Discord shows as the literal character.
 */
export function hasLiveSyntax(content: string): boolean {
  return [
    /(?<!\\)@(?:everyone|here)/u,
    /(?<!\\)<(?:@&?|#|\/|t:|a?:)/u,
    /(?<!\\)\]\s*(?:\\?\()/u,
    /(?<!\\)https?(?<!\\):(?<!\\)\/\//u,
    /(?<!\\)\*\*.*(?<!\\)\*\*/u,
    /(?<!\\)\|\|/u,
    /(?<!\\)```/u,
    /^\s*(?<!\\)(?:#{1,3}|-#|>{1,3}) /mu,
    /[\u202A-\u202E\u2066-\u2069\u200B\u{E0001}-\u{E007F}]/u,
  ].some((pattern) => pattern.test(content));
}
