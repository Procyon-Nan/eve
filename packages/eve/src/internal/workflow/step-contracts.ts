import contracts from "./step-contracts.json" with { type: "json" };

export { contracts as eveStepContracts };

/** Only reviewed eve steps opt into a release-independent durable identity. */
export function resolveEveStepContract(
  filename: string,
  moduleSpecifier: string | undefined,
  functionName: string,
): string | undefined {
  if (moduleSpecifier !== "eve") return undefined;
  const sourcePath = filename.replaceAll("\\", "/").replace(/\.[cm]?[jt]s$/, "");
  return contracts.find(
    (contract) =>
      contract.functionName === functionName &&
      (sourcePath === `src/${contract.source}` || sourcePath.endsWith(`/src/${contract.source}`)),
  )?.id;
}
