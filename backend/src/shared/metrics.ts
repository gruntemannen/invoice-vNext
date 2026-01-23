type DimensionValues = Record<string, string>;

const NAMESPACE = "InvoiceExtractor";
const BASE_DIMENSIONS = { Service: "invoice-extractor" };

export function emitMetric(
  name: string,
  value: number,
  unit: "Count" | "Milliseconds" | "Bytes",
  dimensions: DimensionValues = {}
) {
  const finalDimensions = { ...BASE_DIMENSIONS, ...dimensions };
  const dimensionKeys = Object.keys(finalDimensions);
  const payload = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [dimensionKeys],
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    [name]: value,
    ...finalDimensions,
  };

  console.log(JSON.stringify(payload));
}
