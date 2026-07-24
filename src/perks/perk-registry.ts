import type { Perk } from "./perk";

export class PerkRegistry {
  private perks = new Map<string, Perk>();
  register(p: Perk): void { this.perks.set(p.id, p); }
  get(id: string): Perk | undefined { return this.perks.get(id); }
  all(): Perk[] { return [...this.perks.values()]; }
  list(): { id: string; name: string; description: string }[] {
    return this.all().map((p) => ({ id: p.id, name: p.name, description: p.description }));
  }
}
