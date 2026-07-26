import { invoke } from "@tauri-apps/api/core";

export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export async function invokeDesktop<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauriRuntime()) {
    throw new Error("この操作はGoalForgeデスクトップ版で利用できます。");
  }
  return invoke<T>(command, args);
}
