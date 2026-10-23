# tinyshop

A tiny command-line tool that totals shopping carts for small online shops.

## Features

- **Cart totals** — sums item price × quantity, in cents, so there are no rounding errors.
- **Discount codes** — `SAVE10` takes 10% off the total; unknown codes are ignored.
- **Regional tax** — adds VAT by region (TH 7%, ES 21%, US 0% at checkout).
- **CSV export** — writes the cart to a CSV file for the shop's accounting.

## Develop

```sh
bun test
```

Prices are integers in cents everywhere; `formatPrice` turns them into display strings.
