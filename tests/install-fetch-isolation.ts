const originalFetch = globalThis.fetch.bind(globalThis);

function isLoopback(input: string | URL | Request) {
  const raw = input instanceof Request ? input.url : input;
  const hostname = new URL(raw).hostname;
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  if (!isLoopback(input)) return originalFetch(input, init);
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  if (!headers.has("connection")) headers.set("connection", "close");
  return originalFetch(input, { ...init, headers });
};
