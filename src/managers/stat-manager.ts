import type { StatStore, StatDescriptor, StatScope } from "../db/instance.repo";

export class StatManager {
  private descriptors = new Map<string, StatDescriptor>();
  constructor(private gangStore: StatStore, private playerStore: StatStore) {}

  register(d: StatDescriptor): void { this.descriptors.set(`${d.scope}:${d.id}`, d); }

  private descriptor(scope: StatScope, statId: string): StatDescriptor {
    const d = this.descriptors.get(`${scope}:${statId}`);
    if (!d) throw new Error(`unregistered stat: ${statId}`);
    return d;
  }

  async getForGang<T>(gangId: number, statId: string): Promise<T | null> {
    return this.gangStore.get<T>(this.descriptor("gang", statId), gangId);
  }
  async setForGang<T>(gangId: number, statId: string, value: T): Promise<boolean> {
    return this.gangStore.set<T>(this.descriptor("gang", statId), gangId, value);
  }
  async removeFromGang(gangId: number, statId: string): Promise<boolean> {
    this.descriptor("gang", statId);
    return this.gangStore.remove(statId, gangId);
  }
  async getForPlayer<T>(steam: string, statId: string): Promise<T | null> {
    return this.playerStore.get<T>(this.descriptor("player", statId), steam);
  }
  async setForPlayer<T>(steam: string, statId: string, value: T): Promise<boolean> {
    return this.playerStore.set<T>(this.descriptor("player", statId), steam, value);
  }
  async removeFromPlayer(steam: string, statId: string): Promise<boolean> {
    this.descriptor("player", statId);
    return this.playerStore.remove(statId, steam);
  }
}
