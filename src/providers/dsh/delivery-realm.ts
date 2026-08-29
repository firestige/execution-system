/**
 * Compatibility export for the DSH bundle. Delivery realm ownership is now the
 * shared multi-Provider foundation; DSH no longer owns a parallel broker seam.
 */
export {
  DeliveryAgentProviderRealmBroker,
  DeliveryAgentProviderRealmError,
  type DeliveryAgentProviderRealmErrorCode,
  type DeliveryAgentProviderRealmSet,
} from "../provider.js";
export type {
  AgentProviderDeliveryRealmLease as DeliveryAgentProviderRealmLease,
  AgentProviderDeliveryRealmRequest as DeliveryAgentProviderRealmRequest,
  AgentProviderRealmFactory as DeliveryAgentProviderRealmFactory,
} from "../provider.js";
