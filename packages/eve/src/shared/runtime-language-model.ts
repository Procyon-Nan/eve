import type { LanguageModel } from "ai";

/** Structural runtime check shared by authored-model and host-runtime validation. */
export function isRuntimeLanguageModel(value: unknown): value is LanguageModel {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const model = value as {
    readonly specificationVersion?: unknown;
    readonly provider?: unknown;
    readonly modelId?: unknown;
    readonly doGenerate?: unknown;
    readonly doStream?: unknown;
  };

  return (
    (model.specificationVersion === "v2" ||
      model.specificationVersion === "v3" ||
      model.specificationVersion === "v4") &&
    typeof model.provider === "string" &&
    typeof model.modelId === "string" &&
    typeof model.doGenerate === "function" &&
    typeof model.doStream === "function"
  );
}
