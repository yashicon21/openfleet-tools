/** Fetch the greeting from the api service: `GET /greeting` → `{ message }`. */
export async function fetchGreeting(baseUrl, fetchImpl = fetch) {
  const res = await fetchImpl(`${baseUrl}/greeting`);
  if (!res.ok) throw new Error(`api responded ${res.status}`);
  return res.json();
}

export function renderGreeting(greeting) {
  return `<h1>${greeting.message}</h1>`;
}
