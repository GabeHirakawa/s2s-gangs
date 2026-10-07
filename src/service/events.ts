import type {
  BalanceChangedEvent, GangEvent, MemberEvent, MemberLeftEvent, PerkPurchasedEvent, RankChangedEvent,
  ReadyEvent,
} from "../../api";

/** Payload per `@edgegamers/gangs` forward (mirrors `Contract["forwards"]`). */
export interface ForwardPayloads {
  OnReady: ReadyEvent;
  OnGangCreated: GangEvent;
  OnGangDisbanded: GangEvent;
  OnGangRenamed: GangEvent;
  OnMemberJoined: MemberEvent;
  OnMemberLeft: MemberLeftEvent;
  OnMemberRankChanged: RankChangedEvent;
  OnPerkPurchased: PerkPurchasedEvent;
  OnBalanceChanged: BalanceChangedEvent;
}

export type ForwardName = keyof ForwardPayloads;
export type Emit = <K extends ForwardName>(event: K, payload: ForwardPayloads[K]) => void;
