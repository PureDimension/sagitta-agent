export interface AutoAdvanceState {
  readonly enabled: boolean;
  readonly mode: "auto" | "chat";
  readonly idleSince: number | null;
  readonly injectedAt: number | null;
  readonly ready: boolean;
  readonly hasPendingWork: boolean;
  readonly stoppedByProtocol: boolean;
}
export interface TaskSnapshot {
  readonly path: string;
  readonly updatedAt: number | null;
  readonly sections: readonly { readonly title: string; readonly items: readonly { readonly text: string; readonly done: boolean }[] }[];
  readonly pendingRequests?: readonly { readonly title: string; readonly hasCheckbox: boolean; readonly body: string }[];
  readonly error?: string;
}
export declare const TYPERT_REMOTE: unknown;
export default TYPERT_REMOTE;
