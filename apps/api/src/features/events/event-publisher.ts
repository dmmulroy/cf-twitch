/** Stable application-facing event publication service tag. */
export { EventPublisher, type IEventPublisher } from "./event-bus-service.ts";

/** HTTP client Layer is exported from this module once the Event Bus API client is constructed. */
export { eventPublisherLayer } from "./event-bus-client.ts";
