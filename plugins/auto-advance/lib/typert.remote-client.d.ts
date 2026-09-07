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
  readonly source?: "cloud" | "file" | "file-stale";
  readonly sections: readonly { readonly title: string; readonly items: readonly { readonly text: string; readonly title?: string; readonly done: boolean; readonly status?: string; readonly acceptance?: string; readonly updatedAt?: number | null; readonly blockedReason?: string | null; readonly project?: string; readonly task_id?: string; readonly kind?: string; readonly claimState?: string }[] }[];
  readonly pendingRequests?: readonly { readonly title: string; readonly hasCheckbox: boolean; readonly body: string; readonly type: "need" | "notify"; readonly needHumanId: string }[];
  readonly error?: string;
}
export interface NeedHumanResolution {
  readonly needHumanId: string;
  readonly taskId: string;
  readonly type: "need" | "notify";
  readonly status: string;
}
export interface AsyncWorkSnapshot {
  readonly running: readonly {
    readonly work_id: string;
    readonly task_id: string;
    readonly kind: string;
    readonly desc: string;
    readonly started_at: string;
    readonly timeout_ms: number;
    readonly status: "running";
  }[];
  readonly recent: readonly {
    readonly work_id: string;
    readonly task_id: string;
    readonly kind: string;
    readonly desc: string;
    readonly started_at: string;
    readonly ended_at: string;
    readonly timeout_ms: number;
    readonly status: "completed" | "failed" | "cancelled" | "expired";
    readonly reason: string | null;
  }[];
}
export declare const TYPERT_REMOTE: unknown;
export default TYPERT_REMOTE;
