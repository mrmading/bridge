// shopdata: the eval's self-made connector — warehouse stock for tinyshop SKUs.
import { serve } from "../_runtime/mcp.ts";

const STOCK: Record<string, number> = { "TEA-01": 37, "CUP-02": 4, "MUG-03": 0 };

serve({
  name: "shopdata",
  tools: [
    {
      name: "stock_level",
      description: "Units in stock in the tinyshop warehouse for one SKU, e.g. TEA-01.",
      inputSchema: { type: "object", properties: { sku: { type: "string", description: "The SKU, e.g. TEA-01" } }, required: ["sku"] },
      run: (a: any) => {
        const sku = String(a.sku || "").toUpperCase();
        return sku in STOCK ? `SKU ${sku}: ${STOCK[sku]} units in stock` : `Unknown SKU ${sku}`;
      },
    },
  ],
});
