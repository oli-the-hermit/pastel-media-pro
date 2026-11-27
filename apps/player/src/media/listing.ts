/**
 * What every list of the library shares: how a name is compared, filed under its letter and searched. Plain
 * functions, used by Music (music.ts) and Streaming (streaming.ts).
 */

/** Lower case, without accents or punctuation: "Pokémon" is found by "pokemon", "AC/DC" by "acdc" or "ac dc". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
/** A–Z as people file names: "The Quiet Hours" under Q; nameless ones last. */
const filed = (s: string) => fold(s).replace(/^(?:the|a|an|el|la|los|las|le|les) (?=\S)/, '');

/** Compares two items by name, as people file them. */
export function byName<T>(name: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const [x, y] = [filed(name(a)), filed(name(b))];
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    return collator.compare(x, y);
  };
}

/** The latest first by `value`; the ones that share it (or have none) by name. */
export function latestFirst<T>(value: (x: T) => number, name: (x: T) => string): (a: T, b: T) => number {
  const az = byName(name);
  return (a, b) => value(b) - value(a) || az(a, b);
}

/** Every word typed is in the text, each at the start of a word: "pol ni" finds "Polar Nights". Nothing typed: null. */
export function matcher(query: string): ((text: string) => boolean) | null {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  return (text) => {
    const t = ` ${fold(text)}`;
    return words.every((w) => t.includes(` ${w}`));
  };
}

/** A few of a search's finds for its list of suggestions: the names that start with what was typed first. */
export function firstFew<T>(items: T[], query: string, name: (x: T) => string, few: number): T[] {
  const q = fold(query);
  const starts = (x: T) => (fold(name(x)).startsWith(q) ? 0 : 1);
  const az = byName(name);
  return [...items].sort((a, b) => starts(a) - starts(b) || az(a, b)).slice(0, few);
}
