export interface InvitationData {
  InvitedSteams: string; InviterSteams: string; RequestedSteams: string; Dates: string; MaxAmo: number;
}
export interface PendingInvitationData { InvitingGangs: string; }

const split = (s: string): string[] => s.split(",").filter((x) => x.length > 0);
const join = (xs: (string | number)[]): string => xs.join(",");

export const emptyInvitation = (maxAmo = 5): InvitationData => ({
  InvitedSteams: "", InviterSteams: "", RequestedSteams: "", Dates: "", MaxAmo: maxAmo,
});

export const invitedList = (d: InvitationData): string[] => split(d.InvitedSteams);

export function addInvitation(d: InvitationData, inviter: string, invited: string, nowSec: number): InvitationData {
  return {
    ...d,
    InvitedSteams: join([...split(d.InvitedSteams), invited]),
    InviterSteams: join([...split(d.InviterSteams), inviter]),
    Dates: join([...split(d.Dates), nowSec]),
  };
}

export function removeInvitation(d: InvitationData, invited: string): InvitationData {
  const invitedS = split(d.InvitedSteams), inviterS = split(d.InviterSteams), dates = split(d.Dates);
  const i = invitedS.indexOf(invited);
  if (i === -1) return d;
  invitedS.splice(i, 1); inviterS.splice(i, 1); dates.splice(i, 1);
  return { ...d, InvitedSteams: join(invitedS), InviterSteams: join(inviterS), Dates: join(dates) };
}

export const pendingList = (p: PendingInvitationData): number[] =>
  split(p.InvitingGangs).map((x) => parseInt(x, 10));

export const addPending = (p: PendingInvitationData, gangId: number): PendingInvitationData => ({
  InvitingGangs: join([...pendingList(p), gangId]),
});

export const removePending = (p: PendingInvitationData, gangId: number): PendingInvitationData => ({
  InvitingGangs: join(pendingList(p).filter((g) => g !== gangId)),
});
