export const CUSTOM_METRICS_CHANGED_EVENT = "goalforge:custom-metrics-changed";

export function notifyCustomMetricsChanged(questionBankId: string): void {
  window.dispatchEvent(new CustomEvent(CUSTOM_METRICS_CHANGED_EVENT, {
    detail: { questionBankId },
  }));
}

export function subscribeToCustomMetricChanges(
  listener: (questionBankId: string) => void,
): () => void {
  const handler = (event: Event) => {
    const questionBankId = (event as CustomEvent<{ questionBankId?: unknown }>).detail
      ?.questionBankId;
    if (typeof questionBankId === "string") listener(questionBankId);
  };
  window.addEventListener(CUSTOM_METRICS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(CUSTOM_METRICS_CHANGED_EVENT, handler);
}
