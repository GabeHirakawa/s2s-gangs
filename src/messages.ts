/** Self-contained English strings. Kept plain-text here so they are testable off-runtime;
 *  chat color tokens can be layered in later without changing call sites. */
export interface Messages {
  notInGang(): string;
  loading(): string;
  created(name: string, id: number): string;
  alreadyInGang(): string;
  nameTaken(name: string): string;
  invited(target: string, gang: string): string;
  joined(gang: string): string;
  left(name: string): string;
  kicked(name: string): string;
  promoted(name: string, rank: string): string;
  demoted(name: string, rank: string): string;
  renamed(name: string): string;
  memberLine(name: string, rank: string): string;
  noPermission(node: string): string;
  usage(text: string): string;
  disbandWarning(): string;
  disbanded(name: string): string;
  playerNotFound(query: string): string;
  balance(amount: number): string;
  gangBalance(gang: string, amount: number): string;
  deposited(amount: number): string;
  noCredits(): string;
  cannotAfford(missing: number): string;
  credited(name: string, balance: number): string;
  gangChat(gang: string, name: string, message: string): string;
  gangNotice(gang: string, message: string): string;
}

export function makeMessages(tag: string, currency = "credits"): Messages {
  const p = (s: string): string => `${tag} ${s}`;
  return {
    notInGang: () => p("You are not in a gang. Type !gang_create <name> to create one."),
    loading: () => p("Gang data is still loading. Try again in a moment."),
    created: (name, id) => p(`Successfully created the '${name}' (${id}) gang.`),
    alreadyInGang: () => p("You are already in a gang."),
    nameTaken: (name) => p(`A gang named '${name}' already exists.`),
    invited: (target, gang) => p(`You invited ${target} to ${gang}.`),
    joined: (gang) => p(`You joined ${gang}.`),
    left: (name) => p(`${name} left the gang.`),
    kicked: (name) => p(`Kicked ${name} from the gang.`),
    promoted: (name, rank) => p(`Promoted ${name} to ${rank}.`),
    demoted: (name, rank) => p(`Demoted ${name} to ${rank}.`),
    renamed: (name) => p(`Your gang is now called '${name}'.`),
    memberLine: (name, rank) => `  ${name} — ${rank}`,
    noPermission: (node) => p(`You are missing the ${node} permission.`),
    usage: (text) => p(`Usage: ${text}`),
    disbandWarning: () =>
      p("WARNING: This is irreversible. Type !gang_disband confirm to confirm."),
    disbanded: (name) => p(`${name} disbanded the gang.`),
    playerNotFound: (query) => p(`Could not find a player using "${query}".`),
    balance: (amount) => p(`You have ${amount} ${currency}.`),
    gangBalance: (gang, amount) => p(`${gang}'s bank has ${amount} ${currency}.`),
    deposited: (amount) => p(`Deposited ${amount} ${currency} into the gang bank.`),
    noCredits: () => p(`You have no ${currency}.`),
    cannotAfford: (missing) => p(`You are ${missing} ${currency} short.`),
    credited: (name, balance) => p(`${name} now has ${balance} ${currency}.`),
    // Gang chat lines are their own format (no p(tag) prefix) — they are gang-scoped chat, not plugin notices.
    gangChat: (gang, name, message) => `[${gang}] ${name}: ${message}`,
    gangNotice: (gang, message) => `[${gang}] ${message}`,
  };
}
