# Larkspur Orders API - Version 2 Specification

The Larkspur Orders API lets merchant systems create, read, and cancel orders on the Larkspur commerce platform. This document specifies version 2 of the API. All requests are sent over HTTPS to the base path /v2, and all request and response bodies are JSON encoded as UTF-8. Larkspur is a fictional platform invented for this specification, and nothing here describes a real service.

## Authentication

Every request must carry an API key in the `X-Larkspur-Key` header. Keys are created in the merchant console and are shown only once, at creation time. A key that is sent in a query string is rejected, because query strings tend to end up in proxy logs.

For browser-facing integrations, a server can exchange its API key for a short-lived session token by calling POST /v2/tokens. A session token is valid for 60 minutes and cannot be renewed; the client must request a new one before the old one expires.

A request with a missing or unknown key receives HTTP 401 with the error code auth_key_invalid. A key that exists but has been disabled by the merchant receives HTTP 403 with the error code auth_key_disabled. Version 2 keys are restricted by scopes, which are described in the next section.

## Key Scopes

Version 2 introduces scopes so that a key can be limited to the operations an integration really needs.

- `orders:read` allows listing and retrieving orders.
- `orders:write` allows creating and cancelling orders.
- `refunds:write` allows creating refunds against paid orders.
- `webhooks:manage` allows registering and deleting webhook endpoints.

A request made with a key that lacks the required scope receives HTTP 403 with the error code scope_insufficient, and the details field of the response names the missing scope. Keys migrated from version 1 are given all four scopes so that existing integrations keep working.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /v2/orders | Create an order |
| GET | /v2/orders | List orders, newest first |
| GET | /v2/orders/{order_id} | Retrieve one order |
| POST | /v2/orders/{order_id}/cancel | Cancel an order |
| POST | /v2/orders/{order_id}/refunds | Refund all or part of an order |

An order object contains the fields order_id, status, currency, line_items, and grand_total. The grand_total field is an integer in minor units, so 1999 means 19.99 in a two-decimal currency. This field was named differently in version 1, and clients that parse the old name will read a missing value.

The status field takes one of the values pending, paid, shipped, or cancelled. An order can be cancelled only while its status is pending or paid. Cancelling a shipped order returns HTTP 409 with the error code order_state_conflict.

The invoice download endpoint that existed in version 1 has been removed; a link to the invoice is now delivered in the invoice.ready webhook event instead. The new refunds endpoint accepts an amount in minor units and a free-text reason of at most 280 characters, and it may be called several times until the refunded sum equals the order total.

## Pagination

List endpoints return results in pages. The page size is controlled by the limit parameter, which defaults to 50 and may not exceed 200.

The position in the list is selected with the starting_after parameter, an opaque cursor taken from the next_cursor field of the previous response. Each response includes has_more, a boolean that tells the client whether another page exists; the total_count field of version 1 is no longer returned.

## Rate Limiting

Each API key may make 250 requests per minute. The limit is counted over a sliding window of 60 seconds and is shared by all endpoints, so a burst of list calls reduces the budget left for order creation.

When the limit is exceeded, the API responds with HTTP 429 and the error code rate_limit_exceeded. The response carries a Retry-After header giving the number of seconds to wait before the next attempt.

Every response includes the headers X-RateLimit-Limit and X-RateLimit-Remaining so that a client can slow down before it is rejected. Order creation has an additional ceiling of 20 requests per second per key, which protects the payment processor from sudden spikes.

## Errors and Idempotency

Errors use ordinary HTTP status codes together with a JSON body. The code field is a stable machine-readable string, the message field is human-readable text that may change without notice, and request_id identifies the call when contacting support.

```
{"error": {"code": "order_not_found", "message": "No such order.", "request_id": "req_8Hq2", "details": {}}}
```

Validation failures return HTTP 400 with the error code invalid_request, and the details object maps each rejected field to a reason.

To make retries safe, POST requests accept an Idempotency-Key header containing a client-generated string of up to 64 characters. The first response for a key is stored for 72 hours and replayed for any repeat of the same request. If a stored key arrives again with a body that differs from the original, the API refuses the call with HTTP 422 and the error code idempotency_key_reused.

## Webhooks

Merchants can register HTTPS endpoints that receive event notifications. Version 2 emits the events order.created, order.paid, order.cancelled, refund.created, and invoice.ready. Each delivery is a POST request whose body contains the event type, a unique event_id, and the full order object.

Deliveries are signed with HMAC-SHA256 using the endpoint secret, and the signature is sent in the `X-Larkspur-Signature` header.

An endpoint must answer with a 2xx status within 10 seconds. A failed delivery is retried up to 8 times with exponential backoff, starting at 30 seconds and doubling after each attempt. An endpoint that fails every delivery for three consecutive days is disabled automatically and the merchant is notified by email.

## Deprecation Policy

Larkspur treats a change as breaking if it removes or renames a field, removes an endpoint, changes an error code, or tightens validation. Breaking changes are released only in a new major version. Adding optional fields, new endpoints, or new event types is not considered breaking, and clients must ignore fields they do not recognize.

A major version remains supported for at least 24 months after its successor is published. The retirement date is announced at least six months ahead, and from that announcement onward every response of the retiring version carries a Sunset header with the planned shutdown date. After shutdown, calls to a retired version return HTTP 410 with the error code version_retired.
