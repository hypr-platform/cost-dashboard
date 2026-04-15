type RequestOptions = RequestInit & {
  timeoutMs?: number;
  errorMessage?: string;
};

export async function fetchJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { errorMessage = "Falha ao carregar dados do backend.", ...requestInit } = options;
  const response = await fetch(url, requestInit);
  if (!response.ok) {
    throw new Error(errorMessage);
  }
  return (await response.json()) as T;
}

export async function fetchJsonWithTimeout<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs = 15000, errorMessage, ...requestInit } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchJson<T>(url, {
      ...requestInit,
      signal: controller.signal,
      errorMessage: errorMessage ?? "Falha ao carregar dados do backend.",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Timeout ao carregar dados. Tente novamente.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
