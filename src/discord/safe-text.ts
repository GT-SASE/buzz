/**
 * The render boundary: the only way text reaches a Discord message.
 *
 * Store text raw and escape it here when it is rendered, whichever path renders
 * it. `SafeText` and `PlainText` are exported as types only, are nominal through
 * a private field, and cannot be built outside this module, so a plain string
 * from user data does not type-check where a message needs text.
 *
 * Member nicknames, global names and usernames are never rendered, because any
 * member controls them. Refer to a person with `userMention` and a role with
 * `roleMention`. Role and channel names go through `escapeUserText` like any other
 * text.
 */

import { isSnowflake } from "../lib/snowflake.ts";

const MINT = Symbol("SafeText");

/**
 * Discord's documented limits. All are measured with `textLength`.
 */
export const DISCORD_LIMITS = {
  content: 2000,
  threadName: 100,
  mentionedUsers: 100,
  mentionedRoles: 100,
  buttonLabel: 80,
  customId: 100,
  selectOptionLabel: 100,
  selectOptionValue: 100,
  selectPlaceholder: 150,
  selectOptions: 25,
  autocompleteChoiceName: 100,
  autocompleteChoiceValue: 100,
  autocompleteChoices: 25,
  commandOptions: 25,
  modalTitle: 45,
  textInputLabel: 45,
  actionRows: 5,
  buttonsPerRow: 5,
} as const;

/** Thrown for text that cannot be rendered. Never repeats the text. */
export class SafeTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeTextError";
  }
}

/**
 * The one measure of text length: UTF-16 code units. An astral character counts
 * as 2 here and as 1 in Postgres's `char_length`, so text that passes this also
 * passes a database rule with the same number.
 */
export function textLength(text: string): number {
  return text.length;
}

export function isWithinLimit(text: string, limit: number): boolean {
  return textLength(text) <= limit;
}

class SafeText {
  readonly #value: string;

  constructor(key: symbol, value: string) {
    if (key !== MINT || new.target !== SafeText) {
      throw new SafeTextError("SafeText can only be made by its own module");
    }
    this.#value = value;
    Object.freeze(this);
  }

  static read(text: unknown): string {
    if (typeof text !== "object" || text === null || !(#value in text)) {
      throw new SafeTextError("Refused text that is not SafeText");
    }
    return text.#value;
  }
}

class PlainText {
  readonly #value: string;

  constructor(key: symbol, value: string) {
    if (key !== MINT || new.target !== PlainText) {
      throw new SafeTextError("PlainText can only be made by its own module");
    }
    this.#value = value;
    Object.freeze(this);
  }

  static read(text: unknown): string {
    if (typeof text !== "object" || text === null || !(#value in text)) {
      throw new SafeTextError("Refused text that is not PlainText");
    }
    return text.#value;
  }
}

for (const type of [SafeText, PlainText]) {
  Object.freeze(type.prototype);
  Object.freeze(type);
}

/** Text that is safe to place in a message's `content`. */
export type { SafeText };
/** Text for places Discord shows literally: thread names, labels and titles. */
export type { PlainText };

export function safeTextValue(text: SafeText): string {
  return SafeText.read(text);
}

export function plainTextValue(text: PlainText): string {
  return PlainText.read(text);
}

const WHITESPACE = /[\s\u0085]+/gu;

// Control, format (zero-width, bidi, tags), lone surrogate, private use and
// unassigned characters, every default-ignorable code point (such as the combining
// grapheme joiner and the variation selectors), the object replacement character, the
// null notehead, and the blank letters used for invisible names. The zero-width joiner
// and VS16 are among them, but emoji need them, so STRAY_JOINER deals with those.
const INVISIBLE =
  /[[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}\u{FFFC}\u{1D159}]--[\u{200D}]--[\u{FE0F}]]/gv;

// The joiner and VS16 are kept only inside an emoji sequence.
const STRAY_JOINER =
  /(?<!\p{Extended_Pictographic}(?:\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])?)\u{200D}|\u{200D}(?!\p{Extended_Pictographic})|(?<!\p{Emoji})\u{FE0F}/gu;

// Stacks of combining marks draw over other lines. Eight is more than real text uses.
const EXCESS_MARKS = /(\p{M}{8})\p{M}+/gu;

const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** One line with nothing invisible. Empty if nothing visible remains. */
function clean(raw: string): string {
  const text = raw
    .replace(WHITESPACE, " ")
    .replace(INVISIBLE, "")
    .replace(STRAY_JOINER, "")
    .normalize("NFC") // Unicode normalization: one form for each accented letter.
    .replace(EXCESS_MARKS, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
  return VISIBLE.test(text) ? text : "";
}

// Every character with a meaning in Discord's markdown or mention syntax. Masked
// links, mentions, commands, timestamps and custom emoji all need one of `[`, `<`
// or `:`. A full stop counts only where it could form a domain or a numbered list.
const SYNTAX =
  /[\\*_~`|<>[\]()#@:/+-]|(?<=[0-9]\u{FE0F}?)\.|\.(?=\p{M}*[\p{L}\p{N}])/gu;

function escapeSyntax(text: string): string {
  return text.replace(SYNTAX, String.raw`\$&`);
}

/**
 * Renders untrusted text inert on one line. Throws if nothing visible remains or
 * if it is over `maxLength` once cleaned. Escaping can then make it longer, so
 * pass long text to `chunkMessages` or use `truncateUserText`.
 */
export function escapeUserText(
  raw: string,
  maxLength: number = DISCORD_LIMITS.content,
): SafeText {
  const cleaned = clean(raw);
  if (cleaned === "") {
    throw new SafeTextError("Text has no visible characters");
  }
  if (!isWithinLimit(cleaned, maxLength)) {
    throw new SafeTextError(
      `Text is ${String(textLength(cleaned))} long, the limit is ${String(maxLength)}`,
    );
  }
  return new SafeText(MINT, escapeSyntax(cleaned));
}

// An invite, or the join in the middle of a masked link. Checked after cleaning, so a
// zero-width character cannot break up a match. A plain URL does not count: escaping
// leaves it as text that nothing can click.
const INVITE_OR_MASKED_LINK =
  /\bdiscord(?:app)?\.(?:gg|com\/invite)|\bdsc\.gg\b|\]\(/iu;

/**
 * Whether text holds a server invite or the shape of a masked link, which are the forms
 * that disguise where they go or bring people somewhere new with the bot's authority.
 * Escaping leaves these inert too, but a place that pings people can refuse them outright.
 */
export function containsInviteOrMaskedLink(raw: string): boolean {
  return INVITE_OR_MASKED_LINK.test(clean(raw));
}

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/**
 * A grapheme has no length limit: a run of Hangul jamo or a chain of joined emoji is
 * one grapheme however long it is. When one is too long to show whole, this keeps as
 * many code points as fit. It holds no syntax, because every such character is in an
 * escape, and an escape stays whole, so one that does not fit gives nothing.
 */
function cutOversizedGrapheme(atom: string, maxLength: number): string {
  if (atom.startsWith("\\")) {
    return "";
  }
  let cut = "";
  for (const codePoint of atom) {
    if (!isWithinLimit(cut + codePoint, maxLength)) {
      break;
    }
    cut += codePoint;
  }
  const trimmed = cut.replace(/\u{200D}$/u, "");
  return VISIBLE.test(trimmed) ? trimmed : "";
}

/**
 * Like `escapeUserText`, but cuts long text so the rendered result fits. The cut falls
 * between graphemes, and inside one only when nothing visible fits before it. Throws
 * if the result would still show nothing.
 */
export function truncateUserText(raw: string, maxLength: number): SafeText {
  const cleaned = clean(raw);
  if (cleaned === "") {
    throw new SafeTextError("Text has no visible characters");
  }
  const whole = escapeSyntax(cleaned);
  if (isWithinLimit(whole, maxLength)) {
    return new SafeText(MINT, whole);
  }
  const ellipsis = "…";
  const pieces = atoms(whole);
  let rendered = "";
  let firstUnfit = "";
  for (const atom of pieces) {
    const next = rendered + atom;
    if (!isWithinLimit(next + ellipsis, maxLength)) {
      firstUnfit = atom;
      break;
    }
    rendered = next;
  }
  // What fits can be only stray marks and spaces, which show nothing by themselves.
  if (!VISIBLE.test(rendered)) {
    rendered += cutOversizedGrapheme(
      firstUnfit,
      maxLength - textLength(rendered) - textLength(ellipsis),
    );
  }
  if (!VISIBLE.test(rendered)) {
    throw new SafeTextError("The limit leaves no room for any text");
  }
  return new SafeText(MINT, rendered + ellipsis);
}

/**
 * Text written in the source, with `SafeText` values placed inside it:
 * safe`Due soon: ${escapeUserText(task.title)}`. A plain string is refused.
 */
export function safe(
  literals: TemplateStringsArray,
  ...values: readonly SafeText[]
): SafeText {
  // Catches a plain call by mistake. It is not proof of a real template, since a
  // frozen array with `raw` would pass, so review must refuse calling this directly.
  if (!Object.isFrozen(literals) || !Array.isArray(literals.raw)) {
    throw new SafeTextError("safe must be used as a template tag");
  }
  let text = literals[0] ?? "";
  values.forEach((value, index) => {
    text += SafeText.read(value) + (literals[index + 1] ?? "");
  });
  return new SafeText(MINT, text);
}

/** Written in the source, shown literally: plain`Mark done`. Takes no values. */
export function plain(literals: TemplateStringsArray): PlainText {
  if (!Object.isFrozen(literals) || !Array.isArray(literals.raw)) {
    throw new SafeTextError("plain must be used as a template tag");
  }
  return new PlainText(MINT, literals[0] ?? "");
}

function idMention(prefix: string, id: string): SafeText {
  if (!isSnowflake(id)) {
    throw new SafeTextError("A mention needs a Discord ID");
  }
  return new SafeText(MINT, `<${prefix}${id}>`);
}

/**
 * Shows a person. This alone pings nobody: the message's `mentionUserIds` decides
 * who is notified.
 */
export function userMention(userId: string): SafeText {
  return idMention("@", userId);
}

/**
 * Shows a role. This alone pings nobody: the message's `mentionRoleIds` decides which
 * roles are notified. Role IDs must come from the signed guild's config row.
 */
export function roleMention(roleId: string): SafeText {
  return idMention("@&", roleId);
}

export function channelMention(channelId: string): SafeText {
  return idMention("#", channelId);
}

/** Discord's timestamp styles: short and long time, date, date and time, and relative. */
export type TimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

const TIMESTAMP_STYLES: ReadonlySet<string> = new Set([
  "t",
  "T",
  "d",
  "D",
  "f",
  "F",
  "R",
]);

/**
 * An instant that each reader sees in their own time zone, such as `<t:1793745000:t>`.
 * Built only from a number, so no stored or typed text can become one: escaping turns
 * the `<` and `:` of user text into literals.
 */
export function discordTimestamp(
  epochMs: number,
  style: TimestampStyle,
): SafeText {
  const seconds = Math.floor(epochMs / 1000);
  if (!Number.isSafeInteger(seconds) || !TIMESTAMP_STYLES.has(style)) {
    throw new SafeTextError("A timestamp needs a real instant and style");
  }
  return new SafeText(MINT, `<t:${String(seconds)}:${style}>`);
}

const JUMP_LINK = /^https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/[0-9]+$/;

/** Accepts only a link to a message, as made by `messageUrl` in the client. */
export function jumpLink(url: string): SafeText {
  if (!JUMP_LINK.test(url)) {
    throw new SafeTextError("Not a link to a Discord message");
  }
  return new SafeText(MINT, url);
}

const NOT_ALLOWED_IN_LABEL =
  /(?!\u{200D}|\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])[^\p{L}\p{M}\p{N}\p{Extended_Pictographic} \-',&!?()]/gu;
const LABEL_NEEDS = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/**
 * For text Discord shows literally, where a backslash would be visible. Rather
 * than escaping, this keeps only letters, marks, numbers, emoji, spaces and a few
 * harmless marks. That leaves no mention, link or domain, since `@`, `<`, `:`, `/`
 * and `.` are all removed. Throws if nothing usable remains or it is too long.
 */
export function plainLabel(
  raw: string,
  maxLength: number = DISCORD_LIMITS.threadName,
): PlainText {
  const label = clean(raw)
    .replace(NOT_ALLOWED_IN_LABEL, " ")
    .replace(/(^| )[\p{M}\u{FE0F}\u{200D}]+/gu, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!LABEL_NEEDS.test(label)) {
    throw new SafeTextError("Label has no usable characters");
  }
  if (!isWithinLimit(label, maxLength)) {
    throw new SafeTextError(
      `Label is ${String(textLength(label))} long, the limit is ${String(maxLength)}`,
    );
  }
  return new PlainText(MINT, label);
}

export interface ChunkLine {
  readonly text: SafeText;
  /** Who this line may ping. Only those whose mention lands in a chunk count. */
  readonly mentionUserIds: readonly string[];
}

export interface Chunk {
  readonly content: SafeText;
  readonly mentionUserIds: readonly string[];
}

export interface ChunkLimits {
  readonly maxLength?: number;
  readonly maxMentions?: number;
}

// A mention, a timestamp, a link or an escaped character must stay whole.
const ATOM = /<[@#][0-9]+>|<t:-?[0-9]+:[tTdDfFR]>|https:\/\/[^\s<]+|\\[\s\S]/gu;
const USER_MENTION = /^<@([0-9]+)>$/;

/** Splits text into pieces that must not be divided. */
function atoms(text: string): string[] {
  const result: string[] = [];
  const addGraphemes = (part: string) => {
    for (const { segment } of graphemes.segment(part)) {
      result.push(segment);
    }
  };
  let end = 0;
  for (const match of text.matchAll(ATOM)) {
    addGraphemes(text.slice(end, match.index));
    result.push(match[0]);
    end = match.index + match[0].length;
  }
  addGraphemes(text.slice(end));
  return result;
}

function usersShownIn(
  pieces: readonly string[],
  allowed: ReadonlySet<string>,
): Set<string> {
  const users = new Set<string>();
  for (const piece of pieces) {
    const id = USER_MENTION.exec(piece)?.[1];
    if (id !== undefined && allowed.has(id)) {
      users.add(id);
    }
  }
  return users;
}

interface Limits {
  readonly maxLength: number;
  readonly maxMentions: number;
}

function toChunk(text: string, users: ReadonlySet<string>): Chunk[] {
  const trimmed = text.trim();
  return trimmed === ""
    ? []
    : [
        {
          content: new SafeText(MINT, trimmed),
          mentionUserIds: [...users],
        },
      ];
}

// The start of a chunk is the start of a line, where these have a meaning that
// they do not have in the middle of the line they were split from.
const LINE_START = /^(#{1,3}|-#|[-*+]|>{1,3}|\d+\.)(?= )/;

function neutraliseLineStart(text: string): string {
  return text.replace(LINE_START, (marker: string) =>
    // A backslash before a digit is shown literally, so a list number escapes its
    // full stop instead.
    marker.endsWith(".") ? `${marker.slice(0, -1)}\\.` : `\\${marker}`,
  );
}

/** Splits one line, at the last space in each chunk where there is one. */
function splitLine(
  pieces: readonly string[],
  allowed: ReadonlySet<string>,
  { maxLength, maxMentions }: Limits,
): Chunk[] {
  const chunks: Chunk[] = [];
  let current: string[] = [];
  // A continuation keeps a character spare for neutraliseLineStart.
  const fits = (parts: readonly string[]) =>
    isWithinLimit(parts.join(""), maxLength - (chunks.length > 0 ? 1 : 0)) &&
    usersShownIn(parts, allowed).size <= maxMentions;
  const emit = (parts: readonly string[]) => {
    const text = parts.join("").trim();
    chunks.push(
      ...toChunk(
        chunks.length > 0 ? neutraliseLineStart(text) : text,
        usersShownIn(parts, allowed),
      ),
    );
  };

  for (const piece of pieces) {
    if (!isWithinLimit(piece, maxLength)) {
      throw new SafeTextError("One character is longer than the limit");
    }
    current.push(piece);
    if (fits(current)) {
      continue;
    }
    const held = current.slice(0, -1);
    // A space early in the chunk would leave a short message, and each message counts
    // against a run's cap, so only one in the second half is worth splitting at.
    const space = held.lastIndexOf(" ");
    const keep =
      space > 0 &&
      textLength(held.slice(0, space).join("")) * 2 >= textLength(held.join(""))
        ? space + 1
        : held.length;
    emit(held.slice(0, keep));
    current = [...held.slice(keep), piece];
    if (!fits(current)) {
      emit(current.slice(0, -1));
      current = [piece];
    }
  }
  emit(current);
  return chunks;
}

/**
 * Packs lines into as many messages as they need, within the length and mention
 * limits. A line stays whole when it fits in one message, and otherwise is split
 * at a space in the second half of a message where there is one, never inside a
 * mention, a link, an escape or a character. A user is listed only on the chunk that shows their mention, and a
 * user named but not shown is pinged by no chunk.
 */
export function chunkMessages(
  lines: readonly ChunkLine[],
  limits: ChunkLimits = {},
): Chunk[] {
  const resolved: Limits = {
    maxLength: limits.maxLength ?? DISCORD_LIMITS.content,
    maxMentions: limits.maxMentions ?? DISCORD_LIMITS.mentionedUsers,
  };
  const fits = (text: string, users: ReadonlySet<string>) =>
    isWithinLimit(text, resolved.maxLength) &&
    users.size <= resolved.maxMentions;

  const chunks: Chunk[] = [];
  let text = "";
  let users = new Set<string>();
  const flush = () => {
    chunks.push(...toChunk(text, users));
    text = "";
    users = new Set();
  };

  for (const line of lines) {
    const whole = SafeText.read(line.text);
    const allowed = new Set(line.mentionUserIds);
    const pieces = atoms(whole);
    const lineUsers = usersShownIn(pieces, allowed);

    if (!fits(whole, lineUsers)) {
      flush();
      chunks.push(...splitLine(pieces, allowed, resolved));
      continue;
    }
    const joined = text === "" ? whole : `${text}\n${whole}`;
    const joinedUsers = new Set([...users, ...lineUsers]);
    if (fits(joined, joinedUsers)) {
      text = joined;
      users = joinedUsers;
    } else {
      flush();
      text = whole;
      users = lineUsers;
    }
  }
  flush();
  return chunks;
}
