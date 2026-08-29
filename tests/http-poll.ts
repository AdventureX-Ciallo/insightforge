export async function fetchForPoll(input: string | URL | Request, init?: RequestInit, fetcher: typeof fetch = fetch) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetcher(input, init);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolveRetry) => setTimeout(resolveRetry, 10));
    }
  }
  throw lastError;
}
