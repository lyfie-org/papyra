/** POST a "send me a code" request and return where it went; throws with the server's reason. */
export async function requestEmailCode(url: string, body?: unknown): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null) as { sentTo?: string; error?: string } | null;
  if (!res.ok || !data?.sentTo) throw new Error(data?.error ?? 'Couldn’t send a code.');
  return data.sentTo;
}
