export type Item = { name: string; cents: number; qty: number };

/** Sum of price × quantity, in cents. */
export function cartTotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.cents * i.qty, 0);
}

/** SAVE10 takes 10% off; any other code leaves the total unchanged. */
export function applyDiscount(totalCents: number, code: string): number {
  if (code === "SAVE10") return Math.round(totalCents * 0.1);
  return totalCents;
}
