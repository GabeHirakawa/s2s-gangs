/** A gang-chat message is any say-text beginning with '.'; returns the trimmed remainder, or null. */
export function parseGangChat(text: string): string | null {
  if (!text.startsWith(".")) return null;
  const msg = text.slice(1).trim();
  return msg.length > 0 ? msg : null;
}
