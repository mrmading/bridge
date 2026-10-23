/** Display string for a price in cents, e.g. 1999 → "$19.99". */
export function formatPrice(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return `$${dollars}.${rest}`;
}
