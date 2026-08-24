function invalid() {
  throw new TypeError("WSR_COMMAND_INVALID");
}

function split(value) {
  if (typeof value !== "string" || value.includes("\0")) invalid();
  const normalized = value.startsWith(" ") ? value.slice(1) : value;
  const lineEnd = normalized.indexOf("\n");
  const line = (lineEnd === -1 ? normalized : normalized.slice(0, lineEnd)).trimEnd();
  const remainder = lineEnd === -1 ? undefined : normalized.slice(lineEnd + 1);
  return { line, remainder };
}

export function parseWsrCommand(value) {
  const { line, remainder } = split(value);
  if (line === "list") {
    if (remainder !== undefined) invalid();
    return Object.freeze({ operation: "list" });
  }
  if (line === "recover") return Object.freeze({ operation: "recover" });
  if (line.startsWith("recover ")) {
    const deliveryId = line.slice(8);
    if (deliveryId.length === 0 || deliveryId.includes(" ") || remainder !== undefined) invalid();
    return Object.freeze({ operation: "recover", deliveryId });
  }
  if (line === "status") return Object.freeze({ operation: "status" });
  if (line.startsWith("status ")) {
    const deliveryId = line.slice(7);
    if (deliveryId.length === 0 || deliveryId.includes(" ") || remainder !== undefined) invalid();
    return Object.freeze({ operation: "status", deliveryId });
  }
  if (line === "action finish") return Object.freeze({ operation: "action-finish", ...(remainder === undefined ? {} : { remainder }) });
  if (line.startsWith("abandon ")) {
    const deliveryId = line.slice(8);
    if (deliveryId.length === 0 || deliveryId.includes(" ") || remainder !== undefined) invalid();
    return Object.freeze({ operation: "abandon", deliveryId });
  }
  if (line.startsWith("create ")) {
    const selector = line.slice(7);
    if (selector.length === 0 || selector.includes(" ") || selector.startsWith("-") || selector.includes("--intent")) invalid();
    return Object.freeze({ operation: "create", selector, directive: `/wsr create ${selector}`, ...(remainder === undefined ? {} : { remainder }) });
  }
  return invalid();
}
