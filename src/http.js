const DEFAULT_TIMEOUT_MS = 10_000;

function formatBodyPreview(text) {
  return JSON.stringify(text.replace(/\s+/g, " ").trim().slice(0, 200));
}

export async function postJson(
  url,
  body,
  { label = url, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let responseText;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    responseText = await response.text();
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`[http] ${label}: request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`[http] ${label}: network request failed: ${error.message}`);
  }

  const bodyPreview = formatBodyPreview(responseText);

  if (!response.ok) {
    throw new Error(
      `[http] ${label}: HTTP ${response.status}; body: ${bodyPreview}`,
    );
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(
      `[http] ${label}: HTTP ${response.status} returned non-JSON body: ${bodyPreview}`,
    );
  }
}
