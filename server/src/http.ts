export async function fetchJson<T>(
  url: URL,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 12_000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...fetchOptions.headers
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Request failed with ${response.status}: ${body.slice(0, 400)}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
