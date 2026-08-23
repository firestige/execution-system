import { providerNotImplemented, type NativeProviderSessionFactory } from "../provider.js";

export function createCopilotProviderShell(): NativeProviderSessionFactory {
  return Object.freeze({
    async open() { throw providerNotImplemented(); },
    async restore() { throw providerNotImplemented(); },
  });
}
