const encoder = new TextEncoder();

export async function verifyLineSignature(raw: string, signature: string, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(raw)));
    const actual = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0));

    let difference = expected.length ^ actual.length;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= expected[index] ^ (actual[index] ?? 0);
    }
    return difference === 0;
  } catch {
    return false;
  }
}
