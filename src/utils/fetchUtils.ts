import { isDefined } from "@fleet-sdk/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function get<T = any>(url: URL, params?: any): Promise<T> {
  if (isDefined(params)) {
    Object.keys(params).map((key) => url.searchParams.append(key, params[key]));
  }

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Request to ${url.origin}${url.pathname} failed with status ${response.status}`);
  }

  return await response.json();
}
